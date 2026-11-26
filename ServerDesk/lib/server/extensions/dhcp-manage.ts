import {dhcpCrossCustomerAuditAction,dhcpReplicateAuditAction} from '../../audit-actions';
import {jobDisplayInput} from '../../job-input';
import {HttpError,guid,now} from '../context';
import {allowedDeviceIds,principal,requireDevice,type DeviceRow} from '../identity/access';
import {featureTargetsGuard} from '../identity/feature-authorization';
import {authorizeTargetCustomers,customerEntries,recheckCrossCustomer} from '../identity/cross-customer';
import {requireMfa} from '../identity/mfa';
import {maintenanceBusy} from '../agent/agent-protocol';
import {sealAgentSecrets} from '../agent/agent-crypto';
import {MAX_QUEUED_JOBS,queueFullError} from '../devices/jobs/queue';
import {db,runSteps,sql,type Step} from '../db';
import {pluginReady,PLUGIN_HOST,PLUGIN_JOB} from '../../plugin-catalog';
import {DHCP_PLUGIN,DHCP_READ,type DhcpSnapshot} from '../../dhcp';
import {dhcpChangeObject,dhcpChangeSchemas,dhcpDeviceAddress,dhcpMirror,dhcpPartnerDevice,dhcpPartnerParameters,dhcpScopeApplyParts,dhcpSecretValid,isDhcpChangeOperation,normalizeDhcpChange,validateDhcpChange,
 PLUGIN_SECRETS,type DhcpChangeOperation,type DhcpFieldError,type DhcpPartnerCandidate} from '../../dhcp-changes';
import {translate} from '../../i18n/translate';
import {pluginJobLabelKey} from '../../job-display';
import type {ApiErrorKey} from '../../errors/api-error-keys';
import {requireAdSessions} from './plugin-ad-sessions';
import type {AdActAs} from '../../plugin-ad';
import type {ServerSnapshot,Viewer} from '../../types';

// DHCP changes through the DHCP plugin (docs/dhcp-server.md, "Change the DHCP
// server") for POST /api/dhcp. Every change is a plugin-job with the operation
// as its target, gated like every other changing job: the right dhcp.manage,
// online, a plugin host whose DHCP plugin reports the operation, MFA, no
// maintenance, Management mode and a confirmation; then the stored read, its
// running service and the validation (lib/dhcp-changes.ts). Every target device
// also needs the AD sign-in of this portal session for its directory
// (lib/server/extensions/plugin-ad-sessions.ts): each job carries it as actAs, and the agent runs
// the change with that account (docs/plugin-ad-sign-in.md). A scope-level
// change on a failover scope is mirrored to the partner when the partner is a
// device in this portal; the partner passes the same device checks. All jobs of
// one request, their audit rows and the customer entries commit in one
// transaction or not at all. Nothing here changes a device directly.

/** The audit action of a replicate request. */
export {dhcpReplicateAuditAction};
/** The English job label of an operation: the audit action. */
export const dhcpAuditAction=(operation:DhcpChangeOperation)=>translate('en',pluginJobLabelKey(PLUGIN_JOB,operation)!);
const onlineWindowMs=120_000;

/** A change refused by its values: 400 apiError.dhcp.changeInvalid with the field errors in the answer. */
export class DhcpChangeInvalid extends HttpError{
 readonly errors:DhcpFieldError[];
 constructor(errors:DhcpFieldError[]){super('apiError.dhcp.changeInvalid',{fields:[...new Set(errors.map(error=>error.field))].join(', ')});this.errors=errors;}
}

type StoredData={snapshot:DhcpSnapshot;collectedAt:number;service:'running'|'stopped'};
/** The stored read of a device with its service state (the service column, else the read itself). */
async function storedDhcp(serverId:string):Promise<StoredData|null>{
 const row=await db().one<{data:string;collected_at:number;service:string|null}>(sql`SELECT data,collected_at,service FROM device_plugin_data WHERE server_id=${serverId} AND plugin=${DHCP_PLUGIN} AND operation=${DHCP_READ}`);
 if(!row)return null;
 const snapshot=JSON.parse(row.data) as DhcpSnapshot;
 return {snapshot,collectedAt:Number(row.collected_at),service:row.service==='running'||row.service==='stopped'?row.service:snapshot.service};
}
const parsedSnapshot=(device:DeviceRow):ServerSnapshot|null=>{try{return device.snapshot?JSON.parse(device.snapshot):null;}catch{return null;}};

type Checked={device:DeviceRow;snapshot:ServerSnapshot;data:StoredData;actAs:AdActAs};
type CheckErrors={right?:ApiErrorKey;offline:ApiErrorKey;agent:ApiErrorKey;plugin:ApiErrorKey;readOnly:ApiErrorKey;noData:ApiErrorKey;stopped:ApiErrorKey};
const localErrors:CheckErrors={offline:'apiError.agent.notConnected',agent:'apiError.agent.v3FunctionRequired',plugin:'apiError.dhcp.pluginTooOld',readOnly:'apiError.agent.readOnlyEnableManagement',noData:'apiError.dhcp.noData',stopped:'apiError.dhcp.serviceStopped'};
const partnerErrors:CheckErrors={right:'apiError.dhcp.partnerRight',offline:'apiError.dhcp.partnerOffline',agent:'apiError.dhcp.partnerPlugin',plugin:'apiError.dhcp.partnerPlugin',readOnly:'apiError.dhcp.partnerReadOnly',noData:'apiError.dhcp.partnerPlugin',stopped:'apiError.dhcp.partnerServiceStopped'};

/** The device checks of a change: the right, online, a plugin host and the plugin operation; with the partner errors for a failover partner. */
async function deviceChecks(v:Viewer,serverId:string,operation:DhcpChangeOperation,errors:CheckErrors,name?:string){
 let device:DeviceRow;
 try{device=await requireDevice(v,serverId,'dhcp.manage');}
 catch(error){if(errors.right)throw new HttpError(errors.right,{name:name??serverId});throw error;}
 const label={name:device.name};
 if(!device.last_seen||now()-device.last_seen>onlineWindowMs)throw new HttpError(errors.offline,label);
 const snapshot=parsedSnapshot(device);
 if(snapshot?.protocolVersion!==3||!snapshot.agentCapabilities?.includes(PLUGIN_HOST))throw new HttpError(errors.agent,label);
 if(!pluginReady(snapshot,DHCP_PLUGIN,operation))throw new HttpError(errors.plugin,label);
 return {device,snapshot};
}
async function dataChecks(device:DeviceRow,errors:CheckErrors):Promise<StoredData>{
 const data=await storedDhcp(device.id);
 if(!data)throw new HttpError(errors.noData,{name:device.name});
 if(data.service!=='running')throw new HttpError(errors.stopped,{name:device.name});
 return data;
}
/** The AD sign-in of this portal session for the device's directory, as actAs. */
const adSession=async(request:Request,v:Viewer,device:DeviceRow,snapshot:ServerSnapshot)=>(await requireAdSessions(request,v,[{device,snapshot}])).get(device.id)!;
/** A failover partner: the device checks, maintenance, Management mode, its AD sign-in and its running DHCP service, with the partner errors. */
async function partnerChecks(request:Request,v:Viewer,partner:DhcpPartnerCandidate,operation:DhcpChangeOperation):Promise<Checked>{
 const {device,snapshot}=await deviceChecks(v,partner.id,operation,partnerErrors,partner.name);
 if(await maintenanceBusy(device.id))throw new HttpError('apiError.agent.maintenanceRetry');
 if(!device.management||snapshot.mode!=='Management')throw new HttpError(partnerErrors.readOnly,{name:device.name});
 const actAs=await adSession(request,v,device,snapshot);
 return {device,snapshot,data:await dataChecks(device,partnerErrors),actAs};
}

/**
 * The partner candidates: the devices with a stored DHCP read inside
 * the viewer's customer boundary, without the local device, with the DHCP
 * server name of their read and their reported addresses.
 */
export async function dhcpPartnerCandidates(v:Viewer,except:string):Promise<DhcpPartnerCandidate[]>{
 const visible=await allowedDeviceIds(v);if(!visible.length)return [];
 const rows=await db().query<{id:string;name:string;snapshot:string|null;server_name:string|null}>(sql`SELECT s.id,s.name,s.snapshot,d.data::jsonb->'server'->>'name' AS server_name FROM device_plugin_data d JOIN servers s ON s.id=d.server_id
  WHERE d.plugin=${DHCP_PLUGIN} AND d.operation=${DHCP_READ} AND s.revoked=0 AND s.id<>${except} AND s.id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(visible)}::jsonb))`);
 return rows.map(row=>{let snapshot:ServerSnapshot|null=null;try{snapshot=row.snapshot?JSON.parse(row.snapshot):null;}catch{}return {id:String(row.id),name:String(row.name),serverName:row.server_name,addresses:(snapshot?.networks??[]).flatMap(item=>item.addresses??[])};});
}

type StagedJob={id:string;serverId:string;deviceName:string;operation:DhcpChangeOperation;parameters:Record<string,unknown>;secret?:Record<string,unknown>;auditAction:string;object:string;actAs:AdActAs};
/**
 * One transaction: every job with dhcp.manage on all target devices,
 * the cross-customer guard and the queue limit in its insert, one device audit
 * row per job and the customer entries. When one insert does not hold, the
 * transaction rolls back: nothing is written and the answer is queueChanged.
 * created_at rises by 1 ms per job, so the agent runs them in this order.
 */
async function writeJobs(v:Viewer,jobs:StagedJob[]):Promise<{jobs:{id:string;serverId:string}[]}>{
 const serverIds=[...new Set(jobs.map(job=>job.serverId))];
 // Cross-customer: the gate after the per-device checks, its guard in every insert.
 const customers=await authorizeTargetCustomers(v,serverIds);
 const time=now(),ids=JSON.stringify(jobs.map(job=>job.id));
 const authorization=sql`(${featureTargetsGuard(v,serverIds,['dhcp.manage'])}) AND (${customers.guard})`;
 const all=sql`(SELECT count(*) FROM jobs WHERE id IN (SELECT value FROM jsonb_array_elements_text(${ids}::jsonb)))=${jobs.length}`;
 const steps:Step[]=[
  ...jobs.map((job,index)=>{
   const parameters=JSON.stringify({plugin:DHCP_PLUGIN,operation:job.operation,parameters:job.parameters,...(job.secret?{secretParameters:job.secret}:{}),actAs:job.actAs});
   return sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal) SELECT ${job.id},${job.serverId},${PLUGIN_JOB},${job.operation},${parameters},${jobDisplayInput(PLUGIN_JOB,parameters)},${time+index},${v.id},${v.label.trim().toLowerCase()},${principal(v)}
    WHERE ${authorization} AND (SELECT count(*) FROM jobs WHERE server_id=${job.serverId} AND state IN ('pending','running'))<${MAX_QUEUED_JOBS}`;
  }),
  ...jobs.map(job=>sql`INSERT INTO audit (at,actor,action,target,server_id,scope) SELECT ${time},${v.label},${job.auditAction},${`${job.deviceName} / ${job.object} (AD: ${job.actAs.account})`},${job.serverId},'device' WHERE EXISTS (SELECT 1 FROM jobs WHERE id=${job.id})`),
  ...customerEntries(customers,{actor:v.label,action:dhcpCrossCustomerAuditAction,target:jobs[0].object,condition:all}),
 ];
 class NotWritten extends Error {}
 let written=false;
 try{
  await db().transaction(async tx=>{
   const results=await runSteps(tx,steps);
   written=results.slice(0,jobs.length).every(result=>result.rowCount>0);
   if(!written)throw new NotWritten();
  });
 }catch(error){if(!(error instanceof NotWritten))throw error;}
 if(!written){await recheckCrossCustomer(v,customers);throw new HttpError('apiError.console.queueChanged');}
 return {jobs:jobs.map(job=>({id:job.id,serverId:job.serverId}))};
}

async function waiting(serverId:string){return Number((await db().one<{n:number}>(sql`SELECT count(*) AS n FROM jobs WHERE server_id=${serverId} AND state IN ('pending','running')`))?.n??0);}
/** Room for the new jobs in the queue of every target device. */
async function queueRoom(jobs:StagedJob[]){
 const counts=new Map<string,number>();for(const job of jobs)counts.set(job.serverId,(counts.get(job.serverId)??0)+1);
 for(const [serverId,count] of counts)if(await waiting(serverId)+count>MAX_QUEUED_JOBS)throw queueFullError();
}
const stage=({device,actAs}:Checked,operation:DhcpChangeOperation,parameters:Record<string,unknown>,auditAction=dhcpAuditAction(operation)):StagedJob=>({id:crypto.randomUUID(),serverId:device.id,deviceName:device.name,operation,parameters,auditAction,object:dhcpChangeObject(operation,parameters),actAs});

/** The sealed shared secret for one device, after the plugin-secrets check. */
async function sealedSecret(secret:string,checked:{device:DeviceRow;snapshot:ServerSnapshot}){
 if(!checked.snapshot.agentCapabilities?.includes(PLUGIN_SECRETS))throw new HttpError('apiError.dhcp.secretAgent',{name:checked.device.name});
 return sealAgentSecrets({secret},checked.snapshot.publicKey);
}

/** The checks of the local device in their order: device, MFA, maintenance, Management mode, the AD sign-in, confirmation, stored read and running service. */
async function localChecks(request:Request,v:Viewer,input:{serverId:unknown;confirm:unknown},operation:DhcpChangeOperation):Promise<Checked>{
 if(!guid(input.serverId))throw new HttpError('apiError.device.invalid');
 const {device,snapshot}=await deviceChecks(v,input.serverId,operation,localErrors);
 await requireMfa(request,v);
 if(await maintenanceBusy(device.id))throw new HttpError('apiError.agent.maintenanceRetry');
 if(!device.management||snapshot.mode!=='Management')throw new HttpError(localErrors.readOnly);
 const actAs=await adSession(request,v,device,snapshot);
 if(input.confirm!==true)throw new HttpError('apiError.console.confirmServerChange');
 return {device,snapshot,data:await dataChecks(device,localErrors),actAs};
}

/**
 * change: one DHCP change on one device, mirrored to a matched failover
 * partner when the scope is in a relationship, and the failover
 * pairing of create, edit and remove. Answers {jobs:[{id,serverId}]}.
 */
export async function queueDhcpChange(request:Request,v:Viewer,input:{serverId:unknown;operation:unknown;parameters:unknown;confirm:unknown;secret?:unknown}){
 const operation=input.operation;
 if(!isDhcpChangeOperation(operation)||operation==='dhcp-scope-apply')throw new HttpError('apiError.plugin.operationUnknown');
 const local=await localChecks(request,v,input,operation);
 const {snapshot:agent,data}=local,device=local.device;
 // The schema and the validation against the stored read.
 const validation=validateDhcpChange(operation,input.parameters,data.snapshot);
 if(!validation.ok)throw new DhcpChangeInvalid(validation.errors);
 let parameters=normalizeDhcpChange(operation,dhcpChangeSchemas[operation].parse(input.parameters) as Record<string,unknown>);
 // The secret: required for a new authenticated relationship or turning authentication on; never in parameters.
 const relation=typeof parameters.name==='string'?data.snapshot.ipv4.failover.find(item=>item.name===parameters.name)??null:null;
 const needsSecret=parameters.messageAuthentication===true&&(operation==='dhcp-failover-create'||operation==='dhcp-failover-edit'&&!relation?.messageAuthentication);
 const secret=input.secret===undefined||input.secret===null||input.secret===''?null:input.secret;
 // A secret goes only with authentication on; a new authenticated relationship needs one.
 if(secret!==null&&parameters.messageAuthentication!==true)throw new DhcpChangeInvalid([{field:'secret',code:'invalid'}]);
 if(needsSecret&&secret===null)throw new DhcpChangeInvalid([{field:'secret',code:'secret'}]);
 if(secret!==null&&!dhcpSecretValid(secret))throw new DhcpChangeInvalid([{field:'secret',code:'secret'}]);
 // Only the portal sets the partner side of an edit.
 if(operation==='dhcp-failover-edit'){const {deleteRemovedScopes,...rest}=parameters;void deleteRemovedScopes;parameters=rest;}
 const jobs:StagedJob[]=[];
 const failover=operation==='dhcp-failover-create'||operation==='dhcp-failover-edit'||operation==='dhcp-failover-remove';
 if(!failover){
  // A scope-level change of a failover scope also goes to a matched partner; without one it stays local.
  jobs.push(stage(local,operation,parameters));
  const mirror=dhcpMirror(operation,parameters,data.snapshot);
  if(mirror){
   const partner=dhcpPartnerDevice(mirror.partner,await dhcpPartnerCandidates(v,device.id));
   if(partner){const checked=await partnerChecks(request,v,partner,operation);jobs.push(stage(checked,operation,dhcpPartnerParameters(operation,parameters,data.snapshot.server.name)));}
  }
 }else{
  // A read without every reservation would make the partner lose reservations: copying scopes needs the whole read.
  if((operation==='dhcp-failover-create'||(parameters.addScopeIds as string[]|undefined)?.length)&&data.snapshot.truncated.reservations)throw new HttpError('apiError.dhcp.reservationsTruncated',{name:device.name});
  const partnerName=operation==='dhcp-failover-create'?String(parameters.partner):relation?.partner??'';
  const partner=dhcpPartnerDevice(partnerName,await dhcpPartnerCandidates(v,device.id));
  if(!partner&&operation!=='dhcp-failover-remove')throw new HttpError('apiError.dhcp.partnerMissing',{partner:partnerName});
  let checked:Checked|null=null;
  if(partner){
   checked=await partnerChecks(request,v,partner,operation);
   if(((parameters.addScopeIds as string[]|undefined)?.length||operation==='dhcp-failover-create')&&!pluginReady(checked.snapshot,DHCP_PLUGIN,'dhcp-scope-apply'))throw new HttpError('apiError.dhcp.partnerPlugin',{name:checked.device.name});
  }
  if(operation==='dhcp-failover-create'){
   const serverAddress=dhcpDeviceAddress(agent),partnerAddress=dhcpDeviceAddress(checked!.snapshot);
   if(!serverAddress||!partnerAddress)throw new DhcpChangeInvalid([{field:'partner',code:'ipv4'}]);
   // The partner as its DHCP server names itself, and the endpoints the two services use.
   parameters={...parameters,serverType:'primary',partner:partner!.serverName??partner!.name,serverAddress,partnerAddress};
  }
  if(operation==='dhcp-failover-remove')parameters={...parameters,deletePartnerScopes:false};
  const sealed=secret!==null?await sealedSecret(secret as string,local):undefined;
  jobs.push({...stage(local,operation,parameters),secret:sealed});
  if(checked){
   // The partner gets the scopes first (dhcp-scope-apply parts), then its side of the relationship.
   const copied=operation==='dhcp-failover-create'?parameters.scopeIds as string[]:operation==='dhcp-failover-edit'?(parameters.addScopeIds as string[]|undefined)??[]:[];
   for(const scopeId of copied){
    const scope=data.snapshot.ipv4.scopes.find(item=>item.id===scopeId)!;
    const parts=dhcpScopeApplyParts(scope);
    if(!parts)throw new DhcpChangeInvalid([{field:'scopeIds',code:'tooLarge'}]);
    for(const part of parts)jobs.push(stage(checked,'dhcp-scope-apply',part as Record<string,unknown>));
   }
   const partnerSecret=secret!==null?await sealedSecret(secret as string,checked):undefined;
   jobs.push({...stage(checked,operation,dhcpPartnerParameters(operation,parameters,data.snapshot.server.name)),secret:partnerSecret});
  }
 }
 // Room in every queue before any write.
 await queueRoom(jobs);
 return writeJobs(v,jobs);
}

/**
 * replicate: the settings of the relationship's scopes (or one) from
 * the latest stored read of this device to the matched partner, as
 * dhcp-scope-apply parts. More parts than free queue slots on the partner
 * answer apiError.dhcp.replicateTooLarge.
 */
export async function queueDhcpReplicate(request:Request,v:Viewer,input:{serverId:unknown;relationship:unknown;scopeId?:unknown;confirm:unknown}){
 const local=await localChecks(request,v,input,'dhcp-scope-apply');
 const {data}=local;
 if(data.snapshot.truncated.reservations)throw new HttpError('apiError.dhcp.reservationsTruncated',{name:local.device.name});
 const relation=data.snapshot.ipv4.failover.find(item=>item.name===input.relationship);
 if(!relation)throw new DhcpChangeInvalid([{field:'relationship',code:'missing'}]);
 if(input.scopeId!==undefined&&input.scopeId!==null&&!relation.scopeIds.includes(String(input.scopeId)))throw new DhcpChangeInvalid([{field:'scopeId',code:'missing'}]);
 const partner=dhcpPartnerDevice(relation.partner,await dhcpPartnerCandidates(v,local.device.id));
 if(!partner)throw new HttpError('apiError.dhcp.partnerMissing',{partner:relation.partner});
 const checked=await partnerChecks(request,v,partner,'dhcp-scope-apply');
 const scopeIds=input.scopeId!==undefined&&input.scopeId!==null?[String(input.scopeId)]:relation.scopeIds;
 const jobs:StagedJob[]=[];
 for(const scopeId of scopeIds){
  const scope=data.snapshot.ipv4.scopes.find(item=>item.id===scopeId);if(!scope)continue;
  const parts=dhcpScopeApplyParts(scope);
  if(!parts)throw new DhcpChangeInvalid([{field:'scopeId',code:'tooLarge'}]);
  for(const part of parts)jobs.push(stage(checked,'dhcp-scope-apply',part as Record<string,unknown>,dhcpReplicateAuditAction));
 }
 if(!jobs.length)throw new DhcpChangeInvalid([{field:'scopeId',code:'missing'}]);
 const free=Math.max(0,MAX_QUEUED_JOBS-await waiting(checked.device.id));
 if(jobs.length>free)throw new HttpError('apiError.dhcp.replicateTooLarge',{name:checked.device.name,free});
 return writeJobs(v,jobs);
}
