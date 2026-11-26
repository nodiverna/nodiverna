import {body,config,failure,guid,hash,HttpError,now,random} from '../context';
import {principal,type SqlGuard} from '../identity/access';
import {can,canSql,requireCan} from '../identity/policy/can';
import {commitWithAudit} from '../security-commit';
import {dispatchSigner,signingKeyFailure,type DispatchSigner} from './agent-dispatch';
import {INSTALLER_REGISTRATION_LIFETIME,secureSiteOrigin} from './device-tokens';
import {createReportLimiter,reportClientKey} from '../csp-reports';
import {customerInstallerV3} from '../../../agent/package-v3';
import {portalRootCertificate} from './portal-certificate';
import type {ManagementAuthorization} from '../identity/rbac';
import {admit,bind,consumeProof,customerMessages,hasControlCharacter,holds,invalid} from '../identity/customer-admin';
import {customerById} from '../identity/customers';
import type {ApiErrorKey} from '../../errors/api-error-keys';
import type {Viewer} from '../../types';
import {apiErrorBody} from '../errors/failure';
import {dbFailure,type DbFailureOverrides} from '../errors/db-codes';
import {commitAll,db,sql,type StepResult} from '../db';
import {deviceNamePattern} from '../../device-name';

// Installer per customer (docs/customers.md, "Installers for each customer"):
// creating, listing, revoking and enrolling through an existing installer.
//
// Security rules of this module:
// - The installer key is random() (256 bit). Only installerKeyHash(key) is
//   stored; key and hash never appear in an API answer except the one-time
//   script, in an audit row or in a log line.
// - An enrolled device takes customer_id and group from the stored installer
//   row inside the INSERT itself. Nothing in the request can name them.
// - Every path that cannot prove the customer creates no device (fail closed).

export type InstallerMode='ReadOnly'|'Management';
export type InstallerStatus='active'|'expired'|'revoked'|'exhausted'|'group-missing';
export type CustomerInstaller={id:string;customerId:string;name:string;groupId:string|null;groupName:string|null;mode:InstallerMode;
 createdAt:number;expiresAt:number;maxDevices:number|null;enrollments:number;lastUsedAt:number|null;revokedAt:number|null;status:InstallerStatus};
export type InstallerDeviceGroup={id:string;name:string;customerId:string};

/** The stored form of an installer key. The prefix separates it from device tokens, which use hash(token). */
export function installerKeyHash(key:string):Promise<string>{return hash('ServerDesk customer installer v1\n'+key);}

/**
 * Origin and job-signing key that every agent pins. Throws 503 with the
 * existing texts when SITE_ORIGIN is not a bare https: origin or
 * AGENT_JOB_SIGNING_KEY is missing or unusable.
 */
export function installerPrerequisites():{origin:string;signer:DispatchSigner}{
 const origin=secureSiteOrigin();
 let signer:DispatchSigner|null;
 try{signer=dispatchSigner(config('AGENT_JOB_SIGNING_KEY'));}catch(error){throw signingKeyFailure(error);}
 if(!signer)throw new HttpError('apiError.signing.keyMissing');
 return {origin,signer};
}

// ---- Reading -------------------------------------------------------------------
type InstallerRow=Omit<CustomerInstaller,'status'>;
/** First matching state in the order revoked, expired, exhausted, group-missing, active. */
export function installerStatus(installer:Pick<CustomerInstaller,'revokedAt'|'expiresAt'|'maxDevices'|'enrollments'|'groupId'|'groupName'>,time:number):InstallerStatus{
 if(installer.revokedAt!==null)return 'revoked';
 if(installer.expiresAt<=time)return 'expired';
 if(installer.maxDevices!==null&&installer.enrollments>=installer.maxDevices)return 'exhausted';
 if(installer.groupId!==null&&installer.groupName===null)return 'group-missing';
 return 'active';
}
const nullableNumber=(value:unknown)=>value===null||value===undefined?null:Number(value);
/** Every installer, newest first, at most 1000. Neither key nor hash is read. A group of another customer counts as missing. */
export async function listCustomerInstallers(time=now()):Promise<CustomerInstaller[]>{
 const rows=(await db().query<InstallerRow>(sql`SELECT installer.id,installer.customer_id AS "customerId",installer.name,installer.group_id AS "groupId",installer_group.name AS "groupName",installer.mode,
  installer.created_at AS "createdAt",installer.expires_at AS "expiresAt",installer.max_devices AS "maxDevices",installer.enrollments,installer.last_used_at AS "lastUsedAt",installer.revoked_at AS "revokedAt"
  FROM customer_installers installer LEFT JOIN device_groups installer_group ON installer_group.id=installer.group_id AND installer_group.customer_id=installer.customer_id
  ORDER BY installer.created_at DESC,installer.id LIMIT 1000`));
 return rows.map(row=>{
  const installer={id:row.id,customerId:row.customerId,name:row.name,groupId:row.groupId??null,groupName:row.groupName??null,mode:row.mode,
   createdAt:Number(row.createdAt),expiresAt:Number(row.expiresAt),maxDevices:nullableNumber(row.maxDevices),enrollments:Number(row.enrollments),lastUsedAt:nullableNumber(row.lastUsedAt),revokedAt:nullableNumber(row.revokedAt)};
  return {...installer,status:installerStatus(installer,time)};
 });
}
/** Every device group with its customer, for the group choice of a new installer. */
export async function listInstallerDeviceGroups():Promise<InstallerDeviceGroup[]>{
 return (await db().query<InstallerDeviceGroup>(sql`SELECT id,name,customer_id AS "customerId" FROM device_groups ORDER BY lower(name),id LIMIT 2000`)).map(row=>({id:row.id,name:row.name,customerId:row.customerId}));
}

// ---- Creating --------------------------------------------------------------------
// Creating an installer: global Owners only, with a management MFA proof. The
// key leaves createCustomerInstaller exactly once; only its hash is stored.
/** Raw request values for a new installer (docs/customers.md, "Installers for each customer"). */
export type CustomerInstallerInput={customerId:unknown;name:unknown;groupId:unknown;mode:unknown;validDays:unknown;maxDevices:unknown};
/** A new installer. `key` is the secret; it exists only in this answer and in the downloaded script. */
export type CreatedCustomerInstaller={id:string;key:string;name:string;customerName:string;mode:InstallerMode};
// The message keys of the input errors; the code and the status come from the key.
export const installerInputMessages={
 customer:'apiError.customer.invalid',
 name:'apiError.installer.name',
 controlCharacters:customerMessages.controlCharacters,
 group:'apiError.customer.installerGroupMismatch',
 mode:'apiError.console.agentMode',
 validDays:'apiError.installer.validDays',
 maxDevices:'apiError.installer.maxDevices',
} as const satisfies Record<string,ApiErrorKey>;
// The customer is deactivated (CUSTOMER_DISABLED), in the pre-check, the diagnosis and the trigger answer.
const customerDisabledKey='apiError.customer.disabled' satisfies ApiErrorKey;
const day=86_400_000;
type InstallerSettings={customerId:string;name:string;groupId:string|null;mode:InstallerMode;validDays:number;maxDevices:number|null};

const wholeNumber=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max;

/** Validates the raw input in the documented order. Throws HttpError 400 with the message key of the first broken rule. */
export function installerSettings(input:CustomerInstallerInput):InstallerSettings{
 const source=(input??{}) as Partial<CustomerInstallerInput>;
 if(!guid(source.customerId))throw invalid(installerInputMessages.customer);
 if(source.name!==undefined&&source.name!==null&&typeof source.name!=='string')throw invalid(installerInputMessages.name);
 const name=typeof source.name==='string'?source.name.trim():'';
 if(hasControlCharacter(name))throw invalid(installerInputMessages.controlCharacters);
 const length=[...name].length;
 if(length<1||length>80)throw invalid(installerInputMessages.name);
 const groupId=source.groupId??null;
 if(groupId!==null&&!guid(groupId))throw invalid(installerInputMessages.group);
 if(source.mode!=='ReadOnly'&&source.mode!=='Management')throw invalid(installerInputMessages.mode);
 if(!wholeNumber(source.validDays,1,365))throw invalid(installerInputMessages.validDays);
 const maxDevices=source.maxDevices??null;
 if(maxDevices!==null&&!wholeNumber(maxDevices,1,10000))throw invalid(installerInputMessages.maxDevices);
 return {customerId:source.customerId.toLowerCase(),name,groupId:groupId===null?null:(groupId as string).toLowerCase(),mode:source.mode,validDays:source.validDays,maxDevices};
}

const customerActiveGuard=(customerId:string):SqlGuard=>(sql`EXISTS (SELECT 1 FROM customers installer_customer WHERE installer_customer.id=${customerId} AND installer_customer.status='active')`);
const groupOfCustomerGuard=(groupId:string,customerId:string):SqlGuard=>(sql`EXISTS (SELECT 1 FROM device_groups installer_group WHERE installer_group.id=${groupId} AND installer_group.customer_id=${customerId})`);
const combine=(...parts:SqlGuard[]):SqlGuard=>sql.join(parts.map(part=>sql`(${part})`),sql` AND `);
const groupMismatch=()=>invalid(installerInputMessages.group);

// Trigger errors of the batch as UI messages; the batch rolled back.
async function commitInstaller(...args:Parameters<typeof commitWithAudit>){
 try{return await commitWithAudit(...args);}
 catch(error){
  // The keys are the ones diagnose() uses: customerDisabledKey,
  // installerInputMessages.group and customerMessages.missing. Only Owners get
  // here and they see every customer, so customer-missing keeps the precise key
  // instead of the boundary-neutral registry default.
  const conflict=dbFailure(error,{'customer-disabled':{key:customerDisabledKey},'customer-installer-group-mismatch':{key:installerInputMessages.group},'customer-missing':{key:customerMessages.missing}},['customer-disabled','customer-installer-group-mismatch','customer-missing']);
  if(conflict)throw new HttpError(conflict.key);
  throw error;
 }
}

// Nothing was written: Owner → customer missing → customer disabled → group
// no longer of this customer → proof.
async function diagnoseCreate(viewer:Viewer,settings:InstallerSettings):Promise<never>{
 if(!await can(viewer,'instance.owner',{fresh:true}))throw new HttpError(customerMessages.ownerOnly);
 const customer=await customerById(settings.customerId);
 if(!customer)throw new HttpError(customerMessages.missing);
 if(customer.status!=='active')throw new HttpError(customerDisabledKey);
 if(settings.groupId!==null&&!await holds(groupOfCustomerGuard(settings.groupId,settings.customerId)))throw groupMismatch();
 throw new HttpError(customerMessages.proofUsed);
}

const isoDay=(time:number)=>new Date(time).toISOString().slice(0,10);

export async function createCustomerInstaller(viewer:Viewer,input:CustomerInstallerInput,authorization:ManagementAuthorization):Promise<CreatedCustomerInstaller>{
 await admit(viewer);
 const settings=installerSettings(input);
 const customer=await customerById(settings.customerId);
 if(!customer)throw new HttpError(customerMessages.missing);
 if(customer.status!=='active')throw new HttpError(customerDisabledKey);
 if(settings.groupId!==null&&!await holds(groupOfCustomerGuard(settings.groupId,customer.id)))throw groupMismatch();
 const id=crypto.randomUUID(),key=random(),keyHash=await installerKeyHash(key),at=now(),expiresAt=at+settings.validDays*day;
 // One guard for the row and its audit entry: Owner, proof, the
 // customer still active and, with a group, the group still of this customer.
 const guard=combine(bind(viewer,authorization),customerActiveGuard(customer.id),...(settings.groupId!==null?[groupOfCustomerGuard(settings.groupId,customer.id)]:[]));
 // customer_id is always set explicitly, never left to a column default.
 const {results}=await commitInstaller([
  sql`INSERT INTO customer_installers(id,customer_id,group_id,name,key_hash,mode,expires_at,max_devices,enrollments,created_at,created_by) SELECT ${id},${customer.id},${settings.groupId},${settings.name},${keyHash},${settings.mode},${expiresAt},${settings.maxDevices},0,${at},${principal(viewer)} WHERE ${guard}`,
  consumeProof(authorization),
 ],{audit:{actor:viewer.label,action:'Installer erzeugt',target:`${customer.name}: ${settings.name} (${settings.mode}, gültig bis ${isoDay(expiresAt)})`,customerId:customer.id},guard,at:0});
 if(!results[0].rowCount)await diagnoseCreate(viewer,settings);
 return {id,key,name:settings.name,customerName:customer.name,mode:settings.mode};
}

// ---- Revoking -------------------------------------------------------------------
type RevokeRow={id:string;name:string;revokedAt:number|null;customerId:string;customerName:string|null};
const readForRevoke=(id:string)=>db().one<RevokeRow>(sql`SELECT installer.id,installer.name,installer.revoked_at AS "revokedAt",installer.customer_id AS "customerId",customer.name AS "customerName" FROM customer_installers installer LEFT JOIN customers customer ON customer.id=installer.customer_id WHERE installer.id=${id}`);

/**
 * Revokes an installer: from now on it enrolls no device. Devices it enrolled
 * stay. Global Owners only, with a management MFA proof. An installer that is already revoked is a success without
 * a write, without audit, and the proof stays usable.
 */
export async function revokeCustomerInstaller(viewer:Viewer,id:unknown,authorization:ManagementAuthorization):Promise<void>{
 await requireCan(viewer,'instance.owner','apiError.customer.ownerOnly');
 if(!guid(id))throw new HttpError('apiError.installer.gone');
 const current=await readForRevoke(id);
 if(!current)throw new HttpError('apiError.installer.gone');
 if(current.revokedAt!==null)return;
 const owner=canSql(sql`${principal(viewer)}`,'instance.owner');
 // The guard covers the Owner right, the live proof and "still not revoked", so
 // the audit row (evaluated first) exists exactly when the update happens.
 const guard:SqlGuard=sql`(${owner}) AND (${authorization.guard}) AND EXISTS (SELECT 1 FROM customer_installers revoked_installer WHERE revoked_installer.id=${current.id} AND revoked_installer.revoked_at IS NULL)`;
 const {results}=await commitWithAudit([
  sql`UPDATE customer_installers SET revoked_at=${now()},revoked_by=${principal(viewer)} WHERE id=${current.id} AND revoked_at IS NULL AND ${guard}`,
  consumeProof(authorization),
 ],{audit:{actor:viewer.label,action:'Installer widerrufen',target:`${current.customerName??''}: ${current.name}`,customerId:current.customerId},guard,at:0});
 if(results[0].rowCount)return;
 // Nothing was written: name the first reason that still applies.
 if(!await can(viewer,'instance.owner',{fresh:true}))throw new HttpError('apiError.customer.ownerOnly');
 const after=await readForRevoke(current.id);
 if(!after)throw new HttpError('apiError.installer.gone');
 // Revoked in the meantime by someone else: the wanted state holds.
 if(after.revokedAt!==null)return;
 throw new HttpError('apiError.mfa.confirmationUsed');
}

// ---- The script --------------------------------------------------------------------
const filePart=(value:string)=>value.replace(/[^A-Za-z0-9-]/gu,'_').slice(0,40);
/**
 * The one-time download of a new installer: the PowerShell script with origin
 * and key embedded. Nothing else ever returns the key.
 */
export function customerInstallerDownload(installer:{key:string;name:string;customerName:string},origin:string):Response{
 // The portal's own root certificate, if any, lets the script offer its import (lib/server/agent/portal-certificate.ts).
 const script=customerInstallerV3({origin,installerKey:installer.key},portalRootCertificate()?.der);
 return new Response('﻿'+script,{headers:{'Cache-Control':'no-store','Content-Type':'application/octet-stream','X-Content-Type-Options':'nosniff',
  'Content-Disposition':`attachment; filename="Install-ServerDesk-${filePart(installer.customerName)}-${filePart(installer.name)}.ps1"`}});
}

// ---- Enrollment without a session (POST /api/agent/enroll) --------------------------
export const ENROLL_RATE_LIMIT=60,ENROLL_GLOBAL_RATE_LIMIT=600;
/** Per-process fixed windows of one minute: per client (reportClientKey) and for the whole process. */
export function createEnrollmentLimiter({limit=ENROLL_RATE_LIMIT,globalLimit=ENROLL_GLOBAL_RATE_LIMIT,now:clock}:{limit?:number;globalLimit?:number;now?:()=>number}={}){
 return createReportLimiter({limit,globalLimit,...(clock?{now:clock}:{})});
}
const enrollmentLimiter=createEnrollmentLimiter();
const enrollHeaders={'Cache-Control':'no-store'};
const keyPattern=/^[a-f0-9]{64}$/;
type EnrollRequest={installerKey:string;name:string};

async function enrollRequest(request:Request):Promise<EnrollRequest>{
 let payload:Record<string,unknown>;
 try{payload=await body(request,4096) as Record<string,unknown>;}catch{throw new HttpError('apiError.installer.invalidRequest');}
 // Exactly these two keys: a customer, group, device id, token or mode in the
 // request is refused, never ignored.
 const keys=Object.keys(payload).sort();
 if(keys.length!==2||keys[0]!=='installerKey'||keys[1]!=='name'||typeof payload.installerKey!=='string'||typeof payload.name!=='string'||!keyPattern.test(payload.installerKey))throw new HttpError('apiError.installer.invalidRequest');
 const name=payload.name.trim();
 if(!deviceNamePattern.test(name))throw new HttpError('apiError.installer.deviceName');
 return {installerKey:payload.installerKey,name};
}

type InstallerState={revokedAt:number|null;expiresAt:number;maxDevices:number|null;enrollments:number;groupId:string|null;customerActive:number;groupPresent:number};
// No device was created: the first reason that applies. Without a matching key
// there is no hint at all.
async function refusal(keyHash:string,time:number):Promise<never>{
 const state=await db().one<InstallerState>(sql`SELECT installer.revoked_at AS "revokedAt",installer.expires_at AS "expiresAt",installer.max_devices AS "maxDevices",installer.enrollments,installer.group_id AS "groupId",
  EXISTS (SELECT 1 FROM customers installer_customer WHERE installer_customer.id=installer.customer_id AND installer_customer.status='active') AS "customerActive",
  EXISTS (SELECT 1 FROM device_groups installer_group WHERE installer_group.id=installer.group_id AND installer_group.customer_id=installer.customer_id) AS "groupPresent"
  FROM customer_installers installer WHERE installer.key_hash=${keyHash}`);
 if(!state)throw new HttpError('apiError.installer.invalid');
 if(state.revokedAt!==null)throw new HttpError('apiError.installer.revoked');
 if(Number(state.expiresAt)<=time)throw new HttpError('apiError.installer.expired');
 if(state.maxDevices!==null&&Number(state.enrollments)>=Number(state.maxDevices))throw new HttpError('apiError.installer.exhausted');
 if(!Number(state.customerActive))throw new HttpError('apiError.installer.customerDisabled');
 if(state.groupId!==null&&!Number(state.groupPresent))throw new HttpError('apiError.installer.groupMissing');
 // The state changed back after the batch. Nothing was created; the caller retries.
 throw new Error('Installer state changed during enrollment.');
}
// Constraint errors of the batch; it rolled back, so no device exists.
// A group that left the customer or disappeared means the installer's group is gone.
const enrollmentOverrides:DbFailureOverrides={
 'customer-disabled':{key:'apiError.installer.customerDisabled'},
 'customer-mismatch':{key:'apiError.installer.groupMissing'},
 'device-group-member-missing':{key:'apiError.installer.groupMissing'},
};
// CHECK customer_installers_enrollments: a concurrent enrollment used the last device.
function enrollmentFailure(error:unknown):unknown{
 if(!(error instanceof Error))return error;
 const conflict=dbFailure(error,enrollmentOverrides,['customer-disabled','customer-mismatch','device-group-member-missing','CHECK customer_installers_enrollments']);
 return conflict?new HttpError(conflict.key):error;
}

/**
 * Registers one device with the customer of the installer whose key the body
 * names. No session and no Origin check: the key is the credential. The rate
 * limit runs before any database access; `allow` exists for tests.
 */
export async function enrollWithInstaller(request:Request,allow:(key:string)=>boolean=enrollmentLimiter):Promise<Response>{
 // A refused request writes no log line, so a flood cannot fill the log.
 if(!allow(reportClientKey(request.headers)))return Response.json(apiErrorBody('apiError.installer.rateLimited'),{status:429,headers:enrollHeaders});
 try{
  const {installerKey,name}=await enrollRequest(request);
  const {origin,signer}=installerPrerequisites();
  const keyHash=await installerKeyHash(installerKey),id=crypto.randomUUID(),token=random(),time=now(),d=db();
  // One transaction. It first locks the installer row (parallel enrollments
  // queue instead of retrying). Statement 1 creates the device only for a usable
  // installer (its registration expires after 24 hours unless an agent connects
  // first) and copies customer_id from that row; 2–4 apply only when the device exists.
  // The name is the computer name ($env:COMPUTERNAME), so it follows later
  // renames of the computer (name_source 'hostname', lib/device-name.ts).
  let results:StepResult[];
  try{
   [,...results]=await commitAll([
    sql`SELECT id FROM customer_installers WHERE key_hash=${keyHash} FOR UPDATE`,
    sql`INSERT INTO servers (id,name,name_source,token_hash,created_at,token_expires_at,customer_id) SELECT ${id},${name},'hostname',${await hash(token)},${time},${time+INSTALLER_REGISTRATION_LIFETIME},installer.customer_id FROM customer_installers installer
     WHERE installer.key_hash=${keyHash} AND installer.revoked_at IS NULL AND installer.expires_at>${time}
     AND (installer.max_devices IS NULL OR installer.enrollments<installer.max_devices)
     AND EXISTS (SELECT 1 FROM customers installer_customer WHERE installer_customer.id=installer.customer_id AND installer_customer.status='active')
     AND (installer.group_id IS NULL OR EXISTS (SELECT 1 FROM device_groups installer_group WHERE installer_group.id=installer.group_id AND installer_group.customer_id=installer.customer_id))`,
    sql`INSERT INTO device_group_members(server_id,group_id) SELECT device.id,installer.group_id FROM servers device JOIN customer_installers installer ON installer.key_hash=${keyHash} AND installer.customer_id=device.customer_id WHERE device.id=${id} AND installer.group_id IS NOT NULL`,
    sql`UPDATE customer_installers SET enrollments=enrollments+1,last_used_at=${time} WHERE key_hash=${keyHash} AND EXISTS (SELECT 1 FROM servers device WHERE device.id=${id} AND device.customer_id=customer_installers.customer_id)`,
    sql`INSERT INTO audit (at,actor,action,target,server_id,scope) SELECT ${time},'Installer „'||installer.name||'“','Agent über Installer registriert',device.name,device.id,'device' FROM servers device JOIN customer_installers installer ON installer.key_hash=${keyHash} AND installer.customer_id=device.customer_id WHERE device.id=${id}`,
   ]);
  }catch(error){throw enrollmentFailure(error);}
  if(!results[0].rowCount)await refusal(keyHash,time);
  const created=await d.one<{mode:InstallerMode;customerName:string}>(sql`SELECT installer.mode,customer.name AS "customerName" FROM servers device JOIN customers customer ON customer.id=device.customer_id JOIN customer_installers installer ON installer.key_hash=${keyHash} AND installer.customer_id=device.customer_id WHERE device.id=${id}`);
  if(!created)throw new Error('Enrolled device not found.');
  return Response.json({id,token,origin,jobSigningKey:signer.publicKey,mode:created.mode,customerName:created.customerName},{headers:enrollHeaders});
 }catch(error){return failure(error);}
}
