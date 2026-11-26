// Settings → Microsoft Entra ID (docs/entra-id.md): the app registration of one
// tenant, the switch for sign-in with Microsoft, the group mappings, the
// emergency access account and Microsoft sign-in only. Owners only. save,
// set-enabled, add-mapping, remove-mapping, set-emergency-account and
// set-entra-only need a fresh step-up proof (lib/step-up.ts, rule 6); test
// relies on the login session. Every
// action writes one portal audit row that names no secret. The reply never
// carries the secret, the private key or a ciphertext.
import {config,guid,HttpError,now} from '../../context';
import {auditAfterChange,auditEvent} from '../../audit';
import {can,viewerCanSql} from '../policy/can';
import {cancelPendingForPrincipal,parsedPermissions,type SqlGuard} from '../access';
import {primaryGuard,revocationStatementsFor} from '../local-auth';
import {decryptSecret,encryptSecret} from '../mfa';
import type {Viewer} from '../../../types';
import {commitAll,db,sql,type Step} from '../../db';
import {apiScopeName,applicationIdUriOf,checkCertificate,EntraFailure,graphPermissions,isGuid,testConnection,type ClientCredential,type ConnectionResult} from './oidc';
import {roleSyncStatement,syncedUserIds} from './role-sync';
import {directoryCheckView,type DirectoryCheckRow,type DirectoryCheckView,type KeptOwner} from './directory-check-state';
import {emergencyQualifiesSql} from './emergency';
import {accountMatchSql,accountNameSql} from '../account-names';
import {processScheduler,tickMs} from '../../../../runtime/maintenance-scheduler.mjs';

export const entraSecretContext='entra:client-secret',entraPrivateKeyContext='entra:private-key';
export const maximumGroupMappings=500;
export type CredentialKind='secret'|'certificate';
export type EntraSettingsRow={enabled:number;tenant_id:string|null;client_id:string|null;credential_kind:CredentialKind;secret_enc:string|null;certificate_pem:string|null;private_key_enc:string|null;certificate_thumbprint:string|null;certificate_expires_at:number|null;revision:number;tested_revision:number|null;tested_at:number|null;test_result:ConnectionResult|null;entra_only:number;emergency_user_id:string|null;entra_only_at:number|null;entra_only_by:string|null};
export type EntraMapping={id:string;groupObjectId:string;groupName:string;roleId:string;roleName:string;scopeType:'global'|'devicegroup';scopeId:string;scopeName:string|null};
export type EntraSettingsView={
 tenantId:string;clientId:string;credentialKind:CredentialKind;secretSaved:boolean;privateKeySaved:boolean;
 certificate:{thumbprint:string;expiresAt:number|null}|null;enabled:boolean;configured:boolean;redirectUri:string;revision:number;
 /** The application ID URI of the portal API (api://<saved client ID>, null without one) and its delegated scope (Expose an API). */
 applicationIdUri:string|null;apiScope:typeof apiScopeName;
 lastTest:{at:number;result:ConnectionResult;current:boolean}|null;
 mappings:EntraMapping[];accounts:number;lastSignInAt:number|null;
 roles:{id:string;name:string;portal:boolean}[];deviceGroups:{id:string;name:string}[];
 /** The account check through Microsoft Graph (lib/server/identity/entra/directory-check.ts) and the permissions it needs. */
 directoryCheck:DirectoryCheckView;graphPermissions:string[];
 /**
  * Microsoft sign-in only. by: the name of the account that last switched it
  * (accountName in lib/account-display.ts), null when none can be resolved;
  * never the stored label. lockedAccounts: while on, the locked built-in
  * accounts other than the emergency access; while off, the built-in accounts
  * the switch would lock (active or invited, other than the chosen emergency access).
  */
 entraOnly:{enabled:boolean;since:number|null;by:string|null;lockedAccounts:number};
 /** The emergency access: the chosen account, the accounts that qualify, the last emergency sign-in and the open alarms. */
 emergency:{account:{id:string;username:string;displayName:string;authenticator:boolean;passkeys:number}|null;candidates:{id:string;username:string;displayName:string}[];lastSignInAt:number|null;openAlarms:number};
 /** The checks of the switch to Microsoft sign-in only; the mail channel only warns. */
 switchChecks:{signIn:boolean;emergency:boolean;viewerEntraOwner:boolean;mailChannel:boolean};
};

/** The redirect URI of the app registration: SITE_ORIGIN + /api/auth/entra/callback. */
export const entraRedirectUri=()=>config('SITE_ORIGIN')+'/api/auth/entra/callback';
export async function entraSettingsRow():Promise<EntraSettingsRow|null>{
 return db().one<EntraSettingsRow>(sql`SELECT enabled,tenant_id,client_id,credential_kind,secret_enc,certificate_pem,private_key_enc,certificate_thumbprint,certificate_expires_at,revision,tested_revision,tested_at,test_result,entra_only,emergency_user_id,entra_only_at,entra_only_by FROM entra_settings WHERE id=1`);
}
/** Whether tenant, client and the credential of the chosen kind are saved. */
export const settingsComplete=(row:EntraSettingsRow|null):row is EntraSettingsRow&{tenant_id:string;client_id:string}=>!!row&&!!row.tenant_id&&!!row.client_id&&(row.credential_kind==='secret'?!!row.secret_enc:!!row.certificate_pem&&!!row.private_key_enc&&!!row.certificate_thumbprint);
/** The decrypted credential of a complete row. */
export async function savedCredential(row:EntraSettingsRow):Promise<ClientCredential>{
 return row.credential_kind==='secret'
  ?{kind:'secret',secret:await decryptSecret(row.secret_enc!,entraSecretContext)}
  :{kind:'certificate',privateKeyPem:await decryptSecret(row.private_key_enc!,entraPrivateKeyContext),thumbprint:row.certificate_thumbprint!};
}

// The re-check after a refused commit asks the database again (fresh): a demoted Owner gets 403, not a conflict.
async function requireOwner(viewer:Viewer,fresh=false){if(!await can(viewer,'instance.owner',{fresh}))throw new HttpError('apiError.settings.ownerOnly');}
const unchangedGuard=(row:EntraSettingsRow|null):SqlGuard=>row===null?sql`NOT EXISTS (SELECT 1 FROM entra_settings WHERE id=1)`:sql`EXISTS (SELECT 1 FROM entra_settings WHERE id=1 AND revision=${row.revision} AND enabled=${row.enabled})`;
const proofConsumed=(proof:{tokenHash:string;key:string;sessionHash:string})=>sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash}`;
const entraUsers=sql`SELECT id,auth_principal,auth_email FROM local_users WHERE identity_source='entra'`;
// lib/server/identity/rbac.ts reaches lib/server/identity/mfa.ts, which this module also imports, so it is loaded lazily.
async function stepUp(request:Request,viewer:Viewer,managementToken:unknown){const {prepareManagementAuthorization}=await import('../rbac');return prepareManagementAuthorization(request,viewer,managementToken);}
// Rights follow the assignments at once. Pending jobs of an account whose roles
// changed were admitted with the former rights, so they are cancelled, as after
// a manual assignment change; the sessions stay.
async function cancelPending(userIds:string[]){
 for(const row of await db().query<{auth_principal:string}>(sql`SELECT auth_principal FROM local_users WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(userIds)}::jsonb))`))await cancelPendingForPrincipal(row.auth_principal);
}

/** GET /api/entra/settings. Owners only. */
export async function entraSettingsView(viewer:Viewer):Promise<EntraSettingsView>{
 await requireOwner(viewer);
 const d=db();
 const [row,mappings,accounts,roles,groups,check,candidates,alarms,mail,viewerEntra]=await Promise.all([
  entraSettingsRow(),
  d.query<{id:string;group_object_id:string;group_name:string;role_id:string;role_name:string;scope_type:'global'|'devicegroup';scope_id:string;scope_name:string|null}>(sql`SELECT m.id,m.group_object_id,m.group_name,m.role_id,r.name AS role_name,m.scope_type,m.scope_id,g.name AS scope_name FROM entra_group_roles m JOIN rbac_roles r ON r.id=m.role_id LEFT JOIN device_groups g ON m.scope_type='devicegroup' AND g.id=m.scope_id ORDER BY m.created_at,m.id`),
  d.one<{count:number;last:number|null}>(sql`SELECT count(*)::int AS count,max(last_login_at) AS last FROM local_users WHERE identity_source='entra'`),
  d.query<{id:string;name:string;permissions:string}>(sql`SELECT id,name,permissions FROM rbac_roles WHERE customer_id IS NULL ORDER BY builtin DESC,name`),
  d.query<{id:string;name:string}>(sql`SELECT id,name FROM device_groups ORDER BY name`),
  d.one<DirectoryCheckRow>(sql`SELECT last_started_at,last_finished_at,last_result,last_ok_at,checked_count,locked_count,group_change_count,remaining_count FROM entra_directory_check WHERE id=1`),
  d.query<{id:string;username:string;display_name:string}>(sql`SELECT id,username,display_name FROM local_users candidate WHERE ${emergencyQualifiesSql(sql`candidate.id`)} ORDER BY username`),
  d.one<{open:number}>(sql`SELECT count(*)::int AS open FROM security_alarms WHERE acknowledged_at IS NULL`),
  d.one(sql`SELECT 1 AS found FROM notification_channels WHERE type='smtp' AND enabled=1 LIMIT 1`),
  d.one(sql`SELECT 1 AS found FROM local_users WHERE id=${viewer.userId??""} AND identity_source='entra' AND status='active'`),
 ]);
 const entraOnly=row?.entra_only===1,emergencyId=row?.emergency_user_id??null;
 const [account,lastAlarm,locked,switchedBy,keptOwners]=await Promise.all([
  emergencyId?d.one<{id:string;username:string;display_name:string;authenticators:number;passkeys:number}>(sql`SELECT u.id,u.username,u.display_name,(SELECT count(*)::int FROM mfa_authenticators WHERE principal=u.auth_principal) AS authenticators,(SELECT count(*)::int FROM passkey_credentials WHERE principal=u.auth_principal) AS passkeys FROM local_users u WHERE u.id=${emergencyId}`):null,
  emergencyId?d.one<{at:number|null}>(sql`SELECT max(occurred_at) AS at FROM security_alarms WHERE user_id=${emergencyId}`):null,
  d.one<{count:number}>(entraOnly
   ?sql`SELECT count(*)::int AS count FROM local_users WHERE identity_source='local' AND status='disabled' AND id IS DISTINCT FROM ${emergencyId}`
   :sql`SELECT count(*)::int AS count FROM local_users WHERE identity_source='local' AND status IN ('active','invited') AND id IS DISTINCT FROM ${emergencyId}`),
  // entra_only_by keeps the stored label; the view shows the account's name (lib/server/identity/account-names.ts).
  row?.entra_only_by?d.one<{name:string|null}>(sql`SELECT ${accountNameSql(sql`u`,sql`stored.actor`)} AS name FROM (SELECT ${row.entra_only_by}::text AS actor) stored LEFT JOIN local_users u ON ${accountMatchSql(sql`u`,sql`stored.actor`)} LIMIT 1`):null,
  // The last Owners the account check keeps active (docs/entra-id.md, "The last Owner"); a name equal to the object ID is not shown.
  row?.enabled===1&&row.tenant_id?d.query<KeptOwner>(sql`SELECT kept.id,kept.name,kept.since FROM (SELECT u.id,coalesce(nullif(${accountNameSql(sql`u`,sql`u.id`)},u.entra_object_id),'') AS name,u.entra_kept_owner_since AS since FROM local_users u
   WHERE u.entra_kept_owner_since IS NOT NULL AND u.identity_source='entra' AND u.status='active' AND u.entra_tenant_id=${row.tenant_id}) kept ORDER BY lower(kept.name),kept.id`):[],
 ]);
 const signIn=row?.enabled===1&&row.test_result==='ok'&&row.tested_revision!==null&&Number(row.tested_revision)===Number(row.revision);
 const nextTickAt=(processScheduler() as {nextTickAt:number|null}|null)?.nextTickAt??now()+tickMs;
 return {
  tenantId:row?.tenant_id??'',clientId:row?.client_id??'',credentialKind:row?.credential_kind??'secret',
  secretSaved:!!row?.secret_enc,privateKeySaved:!!row?.private_key_enc,
  certificate:row?.certificate_thumbprint?{thumbprint:row.certificate_thumbprint,expiresAt:row.certificate_expires_at===null?null:Number(row.certificate_expires_at)}:null,
  enabled:row?.enabled===1,configured:settingsComplete(row),redirectUri:entraRedirectUri(),revision:Number(row?.revision??0),
  applicationIdUri:row?.client_id?applicationIdUriOf(row.client_id):null,apiScope:apiScopeName,
  lastTest:row?.tested_at&&row.test_result?{at:Number(row.tested_at),result:row.test_result,current:row.tested_revision!==null&&Number(row.tested_revision)===Number(row.revision)}:null,
  mappings:mappings.map(m=>({id:m.id,groupObjectId:m.group_object_id,groupName:m.group_name,roleId:m.role_id,roleName:m.role_name,scopeType:m.scope_type,scopeId:m.scope_id,scopeName:m.scope_name})),
  accounts:Number(accounts?.count??0),lastSignInAt:accounts?.last===null||accounts?.last===undefined?null:Number(accounts.last),
  roles:roles.map(role=>({id:role.id,name:role.name,portal:parsedPermissions(role.permissions).some(right=>right.startsWith('portal.'))})),
  deviceGroups:groups,
  directoryCheck:directoryCheckView(check,row?.enabled===1,nextTickAt,keptOwners),graphPermissions:[...graphPermissions],
  entraOnly:{enabled:entraOnly,since:row?.entra_only_at===null||row?.entra_only_at===undefined?null:Number(row.entra_only_at),by:switchedBy?.name||null,lockedAccounts:Number(locked?.count??0)},
  emergency:{
   account:account?{id:account.id,username:account.username,displayName:account.display_name,authenticator:Number(account.authenticators)>0,passkeys:Number(account.passkeys)}:null,
   candidates:candidates.map(candidate=>({id:candidate.id,username:candidate.username,displayName:candidate.display_name})),
   lastSignInAt:lastAlarm?.at===null||lastAlarm?.at===undefined?null:Number(lastAlarm.at),openAlarms:Number(alarms?.open??0),
  },
  switchChecks:{signIn,emergency:!!emergencyId&&candidates.some(candidate=>candidate.id===emergencyId),viewerEntraOwner:!!viewerEntra,mailChannel:!!mail},
 };
}

const entraError=(code:string)=>new HttpError(`apiError.entra.${code}` as 'apiError.entra.certificateInvalid');
const printable=/^[\x20-\x7e]{1,512}$/;
const textField=(value:unknown)=>typeof value==='string'?value:value===undefined||value===null?'':null;
function guidField(value:unknown,key:'tenantIdFormat'|'clientIdFormat'|'groupIdFormat'){
 const text=typeof value==='string'?value.trim().toLowerCase():'';
 if(!isGuid(text))throw entraError(key);
 return text;
}

/**
 * save: tenant ID, client ID, credential kind and the credential. An empty
 * secret or key field keeps the saved value. A change of tenant, client or
 * credential increments revision; while sign-in is on it also turns sign-in off
 * (a new test must pass first) and ends every session of every Entra account in
 * the same transaction. An unchanged save changes nothing and writes no row.
 */
export async function saveEntraSettings(request:Request,viewer:Viewer,p:Record<string,unknown>):Promise<EntraSettingsView&{disabled:boolean}>{
 const tenantId=guidField(p.tenantId,'tenantIdFormat'),clientId=guidField(p.clientId,'clientIdFormat');
 const kind=p.credentialKind;if(kind!=='secret'&&kind!=='certificate')throw new HttpError('apiError.request.invalid');
 const secret=textField(p.secret),certificatePem=textField(p.certificatePem),privateKeyPem=textField(p.privateKeyPem);
 if(secret===null)throw entraError('secretFormat');if(certificatePem===null||privateKeyPem===null)throw entraError('certificateInvalid');
 if(kind==='secret'&&secret&&!printable.test(secret))throw entraError('secretFormat');
 await requireOwner(viewer);
 const row=await entraSettingsRow(),time=now();
 if(p.revision!==undefined&&Number(p.revision)!==Number(row?.revision??0))throw entraError('settingsChanged');
 let secretEnc=row?.secret_enc??null,certificate={pem:row?.certificate_pem??null,keyEnc:row?.private_key_enc??null,thumbprint:row?.certificate_thumbprint??null,expiresAt:row?.certificate_expires_at??null},credentialChanged=false;
 if(kind==='secret'&&secret){
  credentialChanged=!row?.secret_enc||await decryptSecret(row.secret_enc,entraSecretContext).catch(()=>null)!==secret;
  if(credentialChanged)secretEnc=await encryptSecret(secret,entraSecretContext);
 }
 if(kind==='certificate'&&(certificatePem.trim()||privateKeyPem.trim())){
  const pem=certificatePem.trim()||row?.certificate_pem||'',key=privateKeyPem.trim()||(row?.private_key_enc?await decryptSecret(row.private_key_enc,entraPrivateKeyContext):'');
  let checked;
  try{checked=checkCertificate(pem,key,time);}catch(error){if(error instanceof EntraFailure)throw entraError(error.code);throw error;}
  credentialChanged=checked.thumbprint!==row?.certificate_thumbprint||!!privateKeyPem.trim();
  if(credentialChanged)certificate={pem:checked.certificatePem,keyEnc:await encryptSecret(checked.privateKeyPem,entraPrivateKeyContext),thumbprint:checked.thumbprint,expiresAt:checked.expiresAt};
 }
 const changed=tenantId!==(row?.tenant_id??'')||clientId!==(row?.client_id??'')||kind!==(row?.credential_kind??'secret')||credentialChanged;
 if(!changed)return {...await entraSettingsView(viewer),disabled:false};
 const proof=await stepUp(request,viewer,p.managementToken);
 const revision=Number(row?.revision??0)+1,disabling=row?.enabled===1;
 const guard:SqlGuard=sql`(${proof.guard}) AND (${viewerCanSql(viewer,'instance.owner')}) AND (${unchangedGuard(row)})`;
 const target=`tenant=${tenantId} client=${clientId} credential=${kind}${kind==='certificate'&&certificate.thumbprint?` thumbprint=${certificate.thumbprint}`:''} revision=${revision}`;
 // Every statement before the upsert sees the state the guard was read from.
 const statements:Step[]=[
  sql`SELECT 1 AS confirmed WHERE ${proof.guard}`,
  ...auditEvent({actor:viewer.label,action:'auth.entra.settings.update',target,guard}),
  ...(disabling?auditEvent({actor:viewer.label,action:'auth.entra.disable',target:`revision=${revision} reason=settingsChanged`,guard}):[]),
 ];
 const upsert=statements.length;
 statements.push(
  sql`INSERT INTO entra_settings(id,enabled,tenant_id,client_id,credential_kind,secret_enc,certificate_pem,private_key_enc,certificate_thumbprint,certificate_expires_at,revision,updated_at,updated_by)
   SELECT 1,0,${tenantId}::text,${clientId}::text,${kind}::text,${secretEnc}::text,${certificate.pem}::text,${certificate.keyEnc}::text,${certificate.thumbprint}::text,${certificate.expiresAt}::bigint,${revision}::bigint,${time}::bigint,${viewer.label}::text WHERE ${guard}
   ON CONFLICT(id) DO UPDATE SET enabled=0,tenant_id=excluded.tenant_id,client_id=excluded.client_id,credential_kind=excluded.credential_kind,secret_enc=excluded.secret_enc,certificate_pem=excluded.certificate_pem,private_key_enc=excluded.private_key_enc,certificate_thumbprint=excluded.certificate_thumbprint,certificate_expires_at=excluded.certificate_expires_at,revision=excluded.revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
  // Consumed exactly when the upsert right before it wrote the settings.
  {afterChange:proofConsumed(proof)},
  // The revocation runs after the upsert, keyed on the revision this save wrote: the
  // sessions it ends may include the request's own (an Entra Owner), which the guard reads.
  ...(disabling?revocationStatementsFor(entraUsers,sql`EXISTS (SELECT 1 FROM entra_settings WHERE id=1 AND revision=${revision} AND updated_at=${time})`):[]),
 );
 const results=await commitAll(statements);
 if(!results[0].rows.length)throw new HttpError('apiError.mfa.proofExpired');
 if(!results[upsert].rowCount){await requireOwner(viewer,true);throw entraError('settingsChanged');}
 return {...await entraSettingsView(viewer),disabled:disabling};
}

/**
 * test: discovery, keys, a client-credentials token and two Microsoft Graph
 * reads (the permissions of the account check), server-side to
 * login.microsoftonline.com and graph.microsoft.com only. Stores and returns
 * one result code for the revision it tested; the stored result never carries
 * Microsoft's text.
 */
export async function testEntraSettings(request:Request,viewer:Viewer):Promise<EntraSettingsView&{result:ConnectionResult}>{
 await requireOwner(viewer);
 const row=await entraSettingsRow();
 if(!settingsComplete(row))throw entraError('notSetUp');
 const credential=await savedCredential(row),time=now();
 const result=await testConnection(row.tenant_id,row.client_id,credential,time);
 const primary=await primaryGuard(request,viewer);
 const results=await commitAll([
  sql`UPDATE entra_settings SET tested_revision=revision,tested_at=${time},test_result=${result} WHERE id=1 AND revision=${row.revision} AND tenant_id=${row.tenant_id} AND client_id=${row.client_id} AND (${viewerCanSql(viewer,'instance.owner')}) AND (${primary})`,
  ...auditEvent({actor:viewer.label,action:'auth.entra.settings.test',target:`result=${result} revision=${row.revision}`,guard:auditAfterChange}),
 ]);
 if(!results[0].rowCount){await requireOwner(viewer,true);throw entraError('settingsChanged');}
 return {...await entraSettingsView(viewer),result};
}

/**
 * set-enabled: on needs a passed test of the current revision
 * (apiError.entra.testFirst) and makes the account check due at the next tick
 * (entra_directory_check.last_started_at=NULL); off ends every session of every
 * Entra account in the same transaction. The unchanged value changes nothing.
 */
export async function setEntraEnabled(request:Request,viewer:Viewer,p:Record<string,unknown>):Promise<EntraSettingsView>{
 if(typeof p.enabled!=='boolean')throw new HttpError('apiError.request.invalid');
 const enabled=p.enabled;
 await requireOwner(viewer);
 const row=await entraSettingsRow();
 if((row?.enabled===1)===enabled)return entraSettingsView(viewer);
 if(enabled&&(!settingsComplete(row)||row.test_result!=='ok'||row.tested_revision===null||Number(row.tested_revision)!==Number(row.revision)))throw entraError('testFirst');
 const proof=await stepUp(request,viewer,p.managementToken),time=now();
 const guard:SqlGuard=sql`(${proof.guard}) AND (${viewerCanSql(viewer,'instance.owner')}) AND (${unchangedGuard(row)})`;
 const statements:Step[]=[
  sql`SELECT 1 AS confirmed WHERE ${proof.guard}`,
  ...auditEvent({actor:viewer.label,action:enabled?'auth.entra.enable':'auth.entra.disable',target:`revision=${row?.revision??0}`,guard:enabled?sql`(${guard}) AND EXISTS (SELECT 1 FROM entra_settings WHERE id=1 AND test_result='ok' AND tested_revision=revision)`:guard}),
 ];
 const update=statements.length;
 statements.push(
  sql`UPDATE entra_settings SET enabled=${enabled?1:0},updated_at=${time},updated_by=${viewer.label} WHERE id=1 AND ${guard}${enabled?sql` AND test_result='ok' AND tested_revision=revision`:sql``}`,
  {afterChange:proofConsumed(proof)},
  // On: the first account check runs at the next scheduler tick.
  ...(enabled?[sql`UPDATE entra_directory_check SET last_started_at=NULL WHERE id=1 AND EXISTS (SELECT 1 FROM entra_settings WHERE id=1 AND enabled=1 AND updated_at=${time} AND updated_by=${viewer.label})`]:[]),
  // Off ends every Entra session after the switch moved, so the request's own
  // session (an Entra Owner) still counts for the guard of the update above.
  ...(enabled?[]:revocationStatementsFor(entraUsers,sql`EXISTS (SELECT 1 FROM entra_settings WHERE id=1 AND enabled=0 AND updated_at=${time} AND updated_by=${viewer.label})`)),
 );
 const results=await commitAll(statements);
 if(!results[0].rows.length)throw new HttpError('apiError.mfa.proofExpired');
 if(!results[update].rowCount){await requireOwner(viewer,true);throw entraError(enabled?'testFirst':'settingsChanged');}
 return entraSettingsView(viewer);
}

/**
 * add-mapping: an Entra group (object ID, optional name) to a role of the
 * instance catalog, for all devices or one device group. A role with a portal
 * right applies only to all devices (canAssignRole in ui/devices/configuration/permissions-tab.tsx). The
 * role sync of every Entra account runs in the same transaction.
 */
export async function addEntraMapping(request:Request,viewer:Viewer,p:Record<string,unknown>):Promise<EntraSettingsView>{
 const groupObjectId=guidField(p.groupObjectId,'groupIdFormat');
 const groupName=typeof p.groupName==='string'?p.groupName.trim():p.groupName===undefined||p.groupName===null?'':null;
 if(groupName===null||groupName.length>120||/[\u0000-\u001f\u007f]/.test(groupName))throw entraError('groupNameFormat');
 if(typeof p.roleId!=='string'||p.roleId.length>120)throw entraError('roleNotAllowed');
 const scopeType=p.scopeType;if(scopeType!=='global'&&scopeType!=='devicegroup')throw entraError('scopeInvalid');
 const scopeId=scopeType==='global'?'*':typeof p.scopeId==='string'&&guid(p.scopeId)?p.scopeId:null;
 if(scopeId===null)throw entraError('scopeInvalid');
 await requireOwner(viewer);
 const d=db(),role=await d.one<{id:string;permissions:string}>(sql`SELECT id,permissions FROM rbac_roles WHERE id=${p.roleId} AND customer_id IS NULL`);
 if(!role||(scopeType!=='global'&&parsedPermissions(role.permissions).some(right=>right.startsWith('portal.'))))throw entraError('roleNotAllowed');
 const scopeGuard=scopeType==='global'?sql`TRUE`:sql`EXISTS (SELECT 1 FROM device_groups WHERE id=${scopeId})`;
 if(!await d.one(sql`SELECT 1 AS found WHERE ${scopeGuard}`))throw entraError('scopeInvalid');
 const identical=sql`EXISTS (SELECT 1 FROM entra_group_roles WHERE group_object_id=${groupObjectId} AND role_id=${role.id} AND scope_type=${scopeType} AND scope_id=${scopeId})`;
 const room=sql`(SELECT count(*) FROM entra_group_roles)<${maximumGroupMappings}`;
 if(await d.one(sql`SELECT 1 AS found WHERE ${identical}`))throw entraError('mappingExists');
 if(!await d.one(sql`SELECT 1 AS found WHERE ${room}`))throw entraError('mappingLimit');
 const proof=await stepUp(request,viewer,p.managementToken),time=now(),id=crypto.randomUUID();
 const guard:SqlGuard=sql`(${proof.guard}) AND (${viewerCanSql(viewer,'instance.owner')})`;
 const marker=sql`EXISTS (SELECT 1 FROM entra_group_roles WHERE id=${id})`;
 const results=await commitAll([
  sql`SELECT 1 AS confirmed WHERE ${proof.guard}`,
  sql`INSERT INTO entra_group_roles(id,group_object_id,group_name,role_id,scope_type,scope_id,created_at,created_by) SELECT ${id},${groupObjectId},${groupName},${role.id},${scopeType},${scopeId},${time},${viewer.label} WHERE ${guard} AND ${scopeGuard} AND ${room} AND NOT ${identical} AND EXISTS (SELECT 1 FROM rbac_roles WHERE id=${role.id} AND customer_id IS NULL AND permissions=${role.permissions})`,
  ...auditEvent({actor:viewer.label,action:'auth.entra.mapping.add',target:`group=${groupObjectId} role=${role.id} scope=${scopeType==='global'?'global':`devicegroup:${scopeId}`}`,guard:auditAfterChange}),
  roleSyncStatement({actor:viewer.label,at:time,guard:marker}),
  sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash} AND ${marker}`,
 ]);
 if(!results[0].rows.length)throw new HttpError('apiError.mfa.proofExpired');
 if(!results[1].rowCount){
  await requireOwner(viewer,true);
  if(await d.one(sql`SELECT 1 AS found WHERE ${identical}`))throw entraError('mappingExists');
  if(!await d.one(sql`SELECT 1 AS found WHERE ${room}`))throw entraError('mappingLimit');
  throw entraError('settingsChanged');
 }
 await cancelPending(syncedUserIds(results[3].rows));
 return entraSettingsView(viewer);
}

/** remove-mapping: removes one mapping; the role sync of every Entra account runs in the same transaction. */
export async function removeEntraMapping(request:Request,viewer:Viewer,p:Record<string,unknown>):Promise<EntraSettingsView>{
 if(!guid(p.id))throw entraError('mappingNotFound');
 await requireOwner(viewer);
 const mapping=await db().one<{id:string;group_object_id:string;role_id:string;scope_type:string;scope_id:string}>(sql`SELECT id,group_object_id,role_id,scope_type,scope_id FROM entra_group_roles WHERE id=${p.id}`);
 if(!mapping)throw entraError('mappingNotFound');
 const proof=await stepUp(request,viewer,p.managementToken),time=now();
 const guard:SqlGuard=sql`(${proof.guard}) AND (${viewerCanSql(viewer,'instance.owner')})`;
 const target=`group=${mapping.group_object_id} role=${mapping.role_id} scope=${mapping.scope_type==='global'?'global':`devicegroup:${mapping.scope_id}`} mapping=${mapping.id}`;
 // The audit row of this transaction marks the delete; "row absent" alone would not.
 const marker=sql`EXISTS (SELECT 1 FROM audit WHERE at=${time} AND action='auth.entra.mapping.remove' AND target=${target})`;
 const results=await commitAll([
  sql`SELECT 1 AS confirmed WHERE ${proof.guard}`,
  sql`DELETE FROM entra_group_roles WHERE id=${mapping.id} AND ${guard}`,
  ...auditEvent({actor:viewer.label,action:'auth.entra.mapping.remove',target,guard:auditAfterChange,at:time}),
  roleSyncStatement({actor:viewer.label,at:time,guard:marker}),
  sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash} AND ${marker}`,
 ]);
 if(!results[0].rows.length)throw new HttpError('apiError.mfa.proofExpired');
 if(!results[1].rowCount){await requireOwner(viewer,true);throw entraError('mappingNotFound');}
 await cancelPending(syncedUserIds(results[3].rows));
 return entraSettingsView(viewer);
}

/**
 * set-emergency-account: chooses the built-in Owner that stays usable while
 * Microsoft sign-in only is on (emergencyQualifiesSql). Only while the switch
 * is off (emergencyFixed) and the settings row exists (notSetUp). The update
 * checks the qualification again in SQL, so an account that lost it meanwhile
 * is refused (emergencyInvalid). The account already chosen changes nothing.
 */
export async function setEmergencyAccount(request:Request,viewer:Viewer,p:Record<string,unknown>):Promise<EntraSettingsView>{
 if(!guid(p.userId))throw entraError('emergencyInvalid');
 const userId=p.userId as string;
 await requireOwner(viewer);
 const row=await entraSettingsRow();
 if(!row)throw entraError('notSetUp');
 if(row.entra_only===1)throw entraError('emergencyFixed');
 if(p.revision!==undefined&&Number(p.revision)!==Number(row.revision))throw entraError('settingsChanged');
 if(row.emergency_user_id===userId)return entraSettingsView(viewer);
 const qualifies=emergencyQualifiesSql(sql`${userId}`);
 if(!await db().one(sql`SELECT 1 AS found WHERE ${qualifies}`))throw entraError('emergencyInvalid');
 const proof=await stepUp(request,viewer,p.managementToken),time=now();
 const guard:SqlGuard=sql`(${proof.guard}) AND (${viewerCanSql(viewer,'instance.owner')})`;
 const results=await commitAll([
  sql`SELECT 1 AS confirmed WHERE ${proof.guard}`,
  sql`UPDATE entra_settings SET emergency_user_id=${userId},updated_at=${time},updated_by=${viewer.label} WHERE id=1 AND entra_only=0 AND revision=${row.revision} AND emergency_user_id IS NOT DISTINCT FROM ${row.emergency_user_id}::text AND ${qualifies} AND ${guard}`,
  ...auditEvent({actor:viewer.label,action:'auth.entra.emergency.set',target:`user=${userId}`,guard:auditAfterChange}),
  {afterChange:proofConsumed(proof)},
 ]);
 if(!results[0].rows.length)throw new HttpError('apiError.mfa.proofExpired');
 if(!results[1].rowCount){
  await requireOwner(viewer,true);
  const current=await entraSettingsRow();
  if(!current)throw entraError('notSetUp');
  if(current.entra_only===1)throw entraError('emergencyFixed');
  if(!await db().one(sql`SELECT 1 AS found WHERE ${qualifies}`))throw entraError('emergencyInvalid');
  throw entraError('settingsChanged');
 }
 return entraSettingsView(viewer);
}

// The built-in accounts the switch locks: every local account but the emergency
// access that is active or invited, read inside the transaction.
const lockedByTheSwitch=sql`SELECT id,auth_principal FROM local_users WHERE identity_source='local' AND status IN ('active','invited') AND id IS DISTINCT FROM (SELECT emergency_user_id FROM entra_settings WHERE id=1)`;

/**
 * set-entra-only: on locks every built-in account but the emergency access in
 * the same transaction (status disabled, auth_version+1, open links used,
 * sessions ended) and ends the sessions of the emergency access too. The
 * update commits only while sign-in with Microsoft is on with a passed test of
 * the current revision, the emergency access still qualifies, the viewer is an
 * Entra account and a global Owner (its step-up proof is a fresh Microsoft
 * sign-in, lib/server/identity/entra/confirm.ts), and revision and switch are unchanged since
 * the read. Off keeps the emergency access and the locked accounts. No row of
 * local_users, role_assignments or audit is deleted. The unchanged value
 * changes nothing.
 */
export async function setEntraOnly(request:Request,viewer:Viewer,p:Record<string,unknown>):Promise<EntraSettingsView&{locked?:number}>{
 if(typeof p.enabled!=='boolean')throw new HttpError('apiError.request.invalid');
 const enabled=p.enabled;
 await requireOwner(viewer);
 const row=await entraSettingsRow();
 if((row?.entra_only===1)===enabled)return entraSettingsView(viewer);
 // On: checked in this order before the commit; the update checks them again.
 if(!row||enabled&&!(row.enabled===1&&row.test_result==='ok'&&row.tested_revision!==null&&Number(row.tested_revision)===Number(row.revision)))throw entraError('testFirst');
 if(p.revision!==undefined&&Number(p.revision)!==Number(row.revision))throw entraError('settingsChanged');
 const qualifies=emergencyQualifiesSql(sql`${row.emergency_user_id}::text`);
 const viewerEntra=sql`EXISTS (SELECT 1 FROM local_users switch_viewer WHERE switch_viewer.id=${viewer.userId??""} AND switch_viewer.identity_source='entra' AND switch_viewer.status='active')`;
 if(enabled){
  if(!row.emergency_user_id)throw entraError('emergencyMissing');
  if(!await db().one(sql`SELECT 1 AS found WHERE ${qualifies}`))throw entraError('emergencyInvalid');
  if(!await db().one(sql`SELECT 1 AS found WHERE ${viewerEntra}`))throw entraError('ownerSignInRequired');
 }
 const proof=await stepUp(request,viewer,p.managementToken),time=now();
 const guard:SqlGuard=sql`(${proof.guard}) AND (${viewerCanSql(viewer,'instance.owner')})`;
 // The settings row as this request wrote it: the marker of every follow-up statement.
 const marker=sql`EXISTS (SELECT 1 FROM entra_settings WHERE id=1 AND entra_only=${enabled?1:0} AND entra_only_at=${time} AND entra_only_by=${viewer.label})`;
 if(!enabled){
  const results=await commitAll([
   sql`SELECT 1 AS confirmed WHERE ${proof.guard}`,
   sql`UPDATE entra_settings SET entra_only=0,entra_only_at=${time},entra_only_by=${viewer.label},updated_at=${time},updated_by=${viewer.label} WHERE id=1 AND entra_only=1 AND revision=${row.revision} AND ${guard}`,
   ...auditEvent({actor:viewer.label,action:'auth.entra.only.off',target:`emergency=${row.emergency_user_id??''} revision=${row.revision}`,guard:auditAfterChange}),
   {afterChange:proofConsumed(proof)},
  ]);
  if(!results[0].rows.length)throw new HttpError('apiError.mfa.proofExpired');
  if(!results[1].rowCount){await requireOwner(viewer,true);throw entraError('settingsChanged');}
  return entraSettingsView(viewer);
 }
 const emergencyId=row.emergency_user_id!;
 const statements:Step[]=[
  sql`SELECT 1 AS confirmed WHERE ${proof.guard}`,
  sql`UPDATE entra_settings SET entra_only=1,entra_only_at=${time},entra_only_by=${viewer.label},updated_at=${time},updated_by=${viewer.label} WHERE id=1 AND entra_only=0 AND revision=${row.revision} AND enabled=1 AND test_result='ok' AND tested_revision=revision AND emergency_user_id=${emergencyId} AND ${qualifies} AND ${viewerEntra} AND ${guard}`,
  {afterChange:proofConsumed(proof)},
  // One row for the switch with the number of accounts it locks, then one per locked account (actor = viewer).
  sql`INSERT INTO audit(at,actor,action,target,server_id,scope,customer_id) SELECT ${time}::bigint,${viewer.label}::text,'auth.entra.only.on','emergency='||${emergencyId}::text||' locked='||(SELECT count(*) FROM (${lockedByTheSwitch}) counted)::text||' revision='||${row.revision}::text,NULL,'portal',NULL WHERE ${marker}`,
  sql`INSERT INTO audit(at,actor,action,target,server_id,scope,customer_id) SELECT ${time}::bigint,${viewer.label}::text,'auth.user.disable',locked_user.id,NULL,'portal',NULL FROM (${lockedByTheSwitch}) locked_user WHERE ${marker} ORDER BY locked_user.id`,
  sql`UPDATE local_account_tokens SET used_at=${time} WHERE used_at IS NULL AND user_id IN (SELECT id FROM (${lockedByTheSwitch}) locked_user) AND ${marker}`,
  // Sessions, proofs, remembered browsers and pending work of the locked accounts and of the emergency access.
  ...revocationStatementsFor(sql`${lockedByTheSwitch} UNION SELECT id,auth_principal FROM local_users WHERE id=${emergencyId}`,marker),
 ];
 const lock=statements.length;
 statements.push(sql`UPDATE local_users SET status='disabled',auth_version=auth_version+1,updated_at=${time} WHERE id IN (SELECT id FROM (${lockedByTheSwitch}) locked_user) AND ${marker}`);
 const results=await commitAll(statements);
 if(!results[0].rows.length)throw new HttpError('apiError.mfa.proofExpired');
 if(!results[1].rowCount){await requireOwner(viewer,true);throw entraError('settingsChanged');}
 return {...await entraSettingsView(viewer),locked:results[lock].rowCount};
}
