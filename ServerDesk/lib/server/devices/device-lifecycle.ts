import {jobDisplayInput} from '../../job-input';
import {guid,HttpError,now} from '../context';
import {principal,requireDevice} from '../identity/access';
import {requireCan,viewerCanSql} from '../identity/policy/can';
import {clearTransfer} from './transfers';
import {auditEvent} from '../audit';
import type {Viewer} from '../../types';
import type {ManagementAuthorization} from '../identity/rbac';
import {featureDeviceGuard} from '../identity/feature-authorization';
import {MAX_QUEUED_JOBS} from './jobs/queue';
import {PENDING_JOB_LIFETIME_MS} from '../../job-expiry';
import {parseAgentArgs} from '../../agent-messages';
import {AGENT_UNINSTALL_KIND,AGENT_UNINSTALL_STARTED,canUninstall,offboardingState,type OffboardingEntry} from '../../offboarding';
import {commitAll,db,sql,type Sql,type Step} from '../db';
import {messageFields,storedMessageText} from '../../server-messages';
import {translate} from '../../i18n/translate';

// Offboarding is a portal operation. A revoked ID remains as a small tombstone
// so an old installer or an in-flight agent request can never register it again.
// Local Windows actions that were already dispatched cannot be undone here.
// Removal is irreversible, so it needs a fresh step-up proof (lib/step-up.ts),
// which the removing batch consumes.
export type RemovalAction='remove-servers'|'remove-server';
/**
 * The syntactic check of a removal request: 1–100 device GUIDs (or one GUID)
 * and an explicit confirm. The console
 * route runs it before it reads the step-up proof, so a request that can never
 * succeed gets its 400 without asking for MFA; removeDevice(s) run it again.
 * Returns the device IDs as given.
 */
export function validateDeviceRemoval(action:RemovalAction,input:{id?:unknown;ids?:unknown;confirm?:unknown;uninstall?:unknown}):string[]{
 if(action!=='remove-servers'&&!guid(input.id))throw new HttpError('apiError.device.invalid');
 const value=action==='remove-servers'?input.ids:[input.id];
 if(!Array.isArray(value)||!value.length||value.length>100||value.some(id=>!guid(id)))throw new HttpError('apiError.devices.selectRange');
 if(input.confirm!==true)throw new HttpError('apiError.devices.confirmRemoval');
 // Optional: true asks each agent to uninstall itself first (requestAgentUninstall).
 if(input.uninstall!==undefined&&typeof input.uninstall!=='boolean')throw new HttpError('apiError.devices.uninstallFlag');
 return value as string[];
}

export async function removeDevice(actor:Viewer,id:unknown,confirm:unknown,proof:ManagementAuthorization){
 validateDeviceRemoval('remove-server',{id,confirm});
 const result=await removeDevices(actor,[id],confirm,proof);
 return {ok:true,id,status:result.removedCount?'removed':'unchanged',cleanupPending:result.cleanupPending,message:result.message};
}

export async function removeDevices(actor:Viewer,value:unknown,confirm:unknown,proof:ManagementAuthorization){
 await requireCan(actor,'instance.owner','apiError.devices.removeAdminOnly');
 const ids=[...new Set(validateDeviceRemoval('remove-servers',{ids:value,confirm}))],scope=JSON.stringify(ids),d=db();
 const devices=(await d.query<{id:string;name:string;revoked:number;customer_id:string|null}>(sql`SELECT id,name,revoked,customer_id FROM servers WHERE id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb))`));
 if(devices.length!==ids.length)throw new HttpError('apiError.devices.removeNotFound');
 for(const device of devices)if(!device.revoked)await requireDevice(actor,device.id,'manage');
 const at=now(),marker='revoked:'+crypto.randomUUID(),admin=viewerCanSql(actor,'instance.owner');
 // One set-based admission checks every captured target before revoking any.
 // Rechecking only individual targets could otherwise partially remove a list.
 const expected=JSON.stringify(devices.map(device=>({id:device.id,revoked:device.revoked})));
 const fence=sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${expected}::jsonb) expected LEFT JOIN servers live ON live.id=expected.value->>'id' WHERE live.id IS NULL OR live.revoked<>(expected.value->>'revoked')::bigint)`;
 // The proof is part of the admission: without a live proof no device is
 // revoked, and the transaction consumes it right after the admitting update.
 const revocation=deviceRevocation(ids,marker,at,sql`${fence} AND ${admin} AND (${proof.guard})`),guard=revocation.guard;
 const results=await commitAll([
  sql`SELECT 1 AS confirmed WHERE ${proof.guard}`,
  revocation.revoke,
  sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash} AND ${guard}`,
  ...revocation.cleanup,
  // The fence admits the transaction only while every device still has the
  // revoked state read above, so the devices read as not revoked are exactly the new ones.
  ...revocation.audit(actor.label,devices.filter(device=>!device.revoked)),
  sql`SELECT 1 AS approved WHERE ${guard}`
 ]);
 if(!results[0]?.rows.length)throw new HttpError('apiError.mfa.proofExpired');
 if(!results.at(-1)?.rows.length)throw new HttpError('apiError.devices.removeApprovalChanged');
 await sweepRemovedTransfers(3,ids);
 const pending=await d.one<{n:number}>(sql`SELECT count(*) AS n FROM transfers WHERE server_id IN (SELECT jsonb_array_elements_text(${scope}::jsonb)) AND state<>'expired'`);
 const removedCount=devices.filter(device=>!device.revoked).length;
 return {ok:true,ids,removedCount,unchangedCount:ids.length-removedCount,cleanupPending:!!pending?.n,...messageFields('serverMessage.devices.removedNotice')};
}

/**
 * The statements that revoke devices and remove everything that belongs to
 * them. removeDevices and the uninstall success (completeAgentUninstall) share
 * them, so both paths revoke the same way. `admission` decides whether the
 * revoking update runs; every later statement runs only when that update wrote
 * the unique marker, which is the transaction's admission receipt (also on
 * retries). After admission no concurrent write can change RBAC inside the
 * transaction; finishing cleanup must also survive a session expiring between statements.
 */
function deviceRevocation(ids:string[],marker:string,at:number,admission:Sql){
 const scope=JSON.stringify(ids);
 const targets=(list:string=scope)=>sql`IN (SELECT jsonb_array_elements_text(${list}::jsonb))`;
 const guard=sql`(SELECT count(*) FROM servers WHERE id ${targets()} AND revoked=1 AND token_hash=${marker})=${ids.length}`;
 const reason='serverMessage.device.removed';
 return {guard,
  // The description can hold personal data (a contact name), so it goes with the device.
  revoke:sql`UPDATE servers SET revoked=1,token_hash=${marker},previous_token_hash=NULL,previous_token_expires_at=NULL,token_expires_at=NULL,snapshot=NULL,last_seen=NULL,management=0,agent_public_key=NULL,description='' WHERE id ${targets()} AND ${admission}`,
  cleanup:[
   // A retry also purges data left by a request admitted before offboarding.
   sql`UPDATE servers SET snapshot=NULL,last_seen=NULL,management=0,agent_public_key=NULL,description='' WHERE id ${targets()} AND ${guard}`,
   // Only pending and running jobs: a succeeded agent-uninstall job keeps its state.
   sql`UPDATE jobs SET state=CASE WHEN state='running' THEN 'expired' ELSE 'cancelled' END,parameters='{}',result=CASE WHEN state='running' THEN 'serverMessage.device.removedResultUnknown' ELSE ${reason} END WHERE server_id ${targets()} AND state IN ('pending','running') AND ${guard}`,
   sql`UPDATE terminal_sessions SET state='closed',last_activity=${at},expires_at=${at},error=${reason} WHERE server_id ${targets()} AND ${guard}`,
   sql`DELETE FROM terminal_frames WHERE session_id IN (SELECT id FROM terminal_sessions WHERE server_id ${targets()}) AND ${guard}`,
   sql`UPDATE rdp_sessions SET state='closed',key_envelope=NULL,last_presence=${at},expires_at=${at},error=${reason} WHERE server_id ${targets()} AND ${guard}`,
   sql`DELETE FROM rdp_frames WHERE session_id IN (SELECT id FROM rdp_sessions WHERE server_id ${targets()}) AND ${guard}`,
   sql`DELETE FROM rdp_receipts WHERE session_id IN (SELECT id FROM rdp_sessions WHERE server_id ${targets()}) AND ${guard}`,
   // Cancelled transfers form a durable cleanup queue until the object storage deletion succeeds.
   sql`UPDATE transfers SET state='cancelled',updated_at=${at},expires_at=${at},message=${reason} WHERE server_id ${targets()} AND state<>'expired' AND ${guard}`,
   sql`DELETE FROM device_leases WHERE server_id ${targets()} AND ${guard}`,
   sql`DELETE FROM device_token_nonces WHERE server_id ${targets()} AND ${guard}`,
   sql`DELETE FROM agent_channels WHERE server_id ${targets(JSON.stringify(ids.flatMap(id=>[id,'terminal:'+id,'drift:'+id])))} AND ${guard}`,
   sql`DELETE FROM device_group_members WHERE server_id ${targets()} AND ${guard}`,
   sql`DELETE FROM role_assignments WHERE scope_type='device' AND scope_id ${targets()} AND ${guard}`,
   sql`DELETE FROM samples WHERE server_id ${targets()} AND ${guard}`,
   sql`DELETE FROM drift_baselines WHERE server_id ${targets()} AND ${guard}`,
   sql`DELETE FROM drift_reports WHERE server_id ${targets()} AND ${guard}`,
   sql`DELETE FROM drift_policies WHERE server_id ${targets()} AND ${guard}`,
   sql`UPDATE desired_assignments SET enabled=0,interval_seconds=0 WHERE server_id ${targets()} AND ${guard}`,
   // Other devices in the same schedule or campaign continue normally.
   sql`UPDATE runbook_schedules SET targets=(SELECT COALESCE(jsonb_agg(remaining.value),'[]'::jsonb)::text FROM jsonb_array_elements_text(runbook_schedules.targets::jsonb) remaining WHERE remaining.value NOT ${targets()}),sealed_secrets=(SELECT COALESCE(jsonb_object_agg(sealed.key,sealed.value),'{}'::jsonb)::text FROM jsonb_each(runbook_schedules.sealed_secrets::jsonb) sealed WHERE sealed.key NOT ${targets()}),enabled=CASE WHEN (SELECT count(*) FROM jsonb_array_elements_text(runbook_schedules.targets::jsonb) remaining WHERE remaining.value NOT ${targets()})=0 THEN 0 ELSE enabled END WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(runbook_schedules.targets::jsonb) target WHERE target.value ${targets()}) AND ${guard}`,
   sql`UPDATE runbook_run_devices SET state=CASE WHEN state='running' AND EXISTS (SELECT 1 FROM jobs WHERE id=job_id AND state='expired') THEN 'unknown' ELSE 'cancelled' END,finished_at=${at},sealed_secrets='{}',result=${'serverMessage.device.removedActionRunning'},result_code=NULL,result_args=NULL WHERE server_id ${targets()} AND state IN ('queued','running') AND ${guard}`,
   sql`UPDATE runbook_run_devices SET sealed_secrets='{}' WHERE server_id ${targets()} AND ${guard}`,
   sql`UPDATE runbook_step_results SET state=coalesce((SELECT state FROM jobs WHERE id=job_id), 'cancelled'),completed_at=${at},result=${reason} WHERE server_id ${targets()} AND state IN ('pending','running') AND ${guard}`,
   sql`UPDATE runbook_runs SET state=CASE WHEN EXISTS (SELECT 1 FROM runbook_run_devices x WHERE x.run_id=runbook_runs.id AND x.state='unknown') THEN 'unknown' WHEN EXISTS (SELECT 1 FROM runbook_run_devices x WHERE x.run_id=runbook_runs.id AND x.state='failed') THEN 'failed' WHEN EXISTS (SELECT 1 FROM runbook_run_devices x WHERE x.run_id=runbook_runs.id AND x.state='cancelled') THEN 'cancelled' ELSE 'succeeded' END,finished_at=${at} WHERE state IN ('queued','running') AND id IN (SELECT run_id FROM runbook_run_devices WHERE server_id ${targets()}) AND NOT EXISTS (SELECT 1 FROM runbook_run_devices x WHERE x.run_id=runbook_runs.id AND x.state IN ('queued','running')) AND ${guard}`
  ],
  // One portal row per newly removed device, with the device's customer.
  audit:(actorLabel:string,removed:{id:string;name:string;customer_id:string|null}[])=>removed.flatMap(device=>auditEvent({actor:actorLabel,action:'Gerät aus Portal entfernt',target:device.name+' / '+device.id,customerId:device.customer_id,guard,at}))
 };
}

// Offboarding with uninstall. The removal actions with uninstall:true queue one
// agent-uninstall job per capable device instead of revoking it. The device is
// revoked only when its agent reports AGENT_UNINSTALL_STARTED
// (completeAgentUninstall). Until then it stays registered, also when the job
// fails, is cancelled or is never claimed.
export type UninstallGroups={queued:string[];unsupported:string[];alreadyPending:string[];queueFull:string[];unchanged:string[]};
// An open uninstall job: running, or pending and still deliverable. A pending
// job past its lifetime is never delivered, so it does not block a new request.
const openUninstall=(server:Sql,at:number)=>sql`EXISTS (SELECT 1 FROM jobs open_uninstall WHERE open_uninstall.server_id=${server} AND open_uninstall.action=${AGENT_UNINSTALL_KIND} AND (open_uninstall.state='running' OR open_uninstall.state='pending' AND GREATEST(open_uninstall.created_at,open_uninstall.not_before)>=${at-PENDING_JOB_LIFETIME_MS}))`;
/**
 * Queues the agent uninstall for 1–100 devices. Same rights as removeDevices
 * (instance.owner, manage per device, a live step-up proof). Every job, its
 * audit row and the proof consumption commit in one batch. No device is revoked.
 */
export async function requestAgentUninstall(actor:Viewer,value:unknown,confirm:unknown,proof:ManagementAuthorization){
 await requireCan(actor,'instance.owner','apiError.devices.removeAdminOnly');
 const ids=[...new Set(validateDeviceRemoval('remove-servers',{ids:value,confirm}))],scope=JSON.stringify(ids),d=db(),at=now();
 const inScope=sql`IN (SELECT jsonb_array_elements_text(${scope}::jsonb))`;
 const devices=await d.query<{id:string;name:string;revoked:number;customer_id:string|null;snapshot:string|null}>(sql`SELECT id,name,revoked,customer_id,snapshot FROM servers WHERE id ${inScope}`);
 if(devices.length!==ids.length)throw new HttpError('apiError.devices.uninstallNotFound');
 for(const device of devices)if(!device.revoked)await requireDevice(actor,device.id,'manage');
 const open=new Set((await d.query<{id:string}>(sql`SELECT id FROM servers WHERE id ${inScope} AND ${openUninstall(sql`servers.id`,at)}`)).map(row=>row.id));
 const waiting=new Map((await d.query<{server_id:string;n:number}>(sql`SELECT server_id,count(*) AS n FROM jobs WHERE server_id ${inScope} AND state IN ('pending','running') GROUP BY server_id`)).map(row=>[row.server_id,Number(row.n)]));
 const groups:UninstallGroups={queued:[],unsupported:[],alreadyPending:[],queueFull:[],unchanged:[]},byId=new Map(devices.map(device=>[device.id,device]));
 const planned:{id:string;jobId:string;device:typeof devices[number]}[]=[];
 for(const id of ids){
  const device=byId.get(id)!;let snapshot=null;try{snapshot=device.snapshot?JSON.parse(device.snapshot):null;}catch{}
  if(device.revoked)groups.unchanged.push(id);
  else if(!canUninstall(snapshot))groups.unsupported.push(id);
  else if(open.has(id))groups.alreadyPending.push(id);
  else if((waiting.get(id)??0)>=MAX_QUEUED_JOBS)groups.queueFull.push(id);
  else planned.push({id,jobId:crypto.randomUUID(),device});
 }
 const admin=viewerCanSql(actor,'instance.owner'),admitted=sql`(${proof.guard}) AND ${admin}`,actorEmail=actor.label.trim().toLowerCase(),actorPrincipal=principal(actor);
 const results=await commitAll([
  sql`SELECT 1 AS confirmed WHERE ${proof.guard}`,
  ...planned.flatMap(({id,jobId,device})=>[
   // A stale pending uninstall job of an offline device ends here, as the heartbeat would end it.
   sql`UPDATE jobs SET state='expired',parameters='{}',result='serverMessage.job.pendingExpired' WHERE server_id=${id} AND action=${AGENT_UNINSTALL_KIND} AND state='pending' AND GREATEST(created_at,not_before)<${at-PENDING_JOB_LIFETIME_MS} AND ${admitted}`,
   sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal) SELECT ${jobId},${id},${AGENT_UNINSTALL_KIND},'','{}',${jobDisplayInput(AGENT_UNINSTALL_KIND,{})},${at},${actor.id},${actorEmail},${actorPrincipal} WHERE ${admitted} AND ${featureDeviceGuard(actor,id,['manage'])} AND EXISTS (SELECT 1 FROM servers WHERE id=${id} AND revoked=0) AND NOT ${openUninstall(sql`${id}::text`,at)} AND (SELECT count(*) FROM jobs WHERE server_id=${id} AND state IN ('pending','running'))<${MAX_QUEUED_JOBS}`,
   ...auditEvent({actor:actor.label,action:'Agent-Deinstallation angefordert',target:device.name+' / '+id,serverIds:id,customerId:device.customer_id,guard:sql`EXISTS (SELECT 1 FROM jobs WHERE id=${jobId})`,at})
  ]),
  sql`SELECT 1 AS approved WHERE ${admin}`,
  sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash} AND ${admitted}`
 ]);
 if(!results[0]?.rows.length)throw new HttpError('apiError.mfa.proofExpired');
 if(!results.at(-2)?.rows.length)throw new HttpError('apiError.devices.uninstallApprovalChanged');
 // A device whose insert lost a race since the pre-read gets the group it has now.
 const created=new Set((await d.query<{server_id:string}>(sql`SELECT server_id FROM jobs WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(planned.map(entry=>entry.jobId))}::jsonb))`)).map(row=>row.server_id));
 for(const {id} of planned){
  if(created.has(id)){groups.queued.push(id);continue;}
  const live=await d.one<{revoked:number;open:boolean}>(sql`SELECT revoked,${openUninstall(sql`servers.id`,at)} AS open FROM servers WHERE id=${id}`);
  (live?.revoked?groups.unchanged:live?.open?groups.alreadyPending:groups.queueFull).push(id);
 }
 const order=(list:string[])=>ids.filter(id=>list.includes(id));
 return {ok:true,ids,uninstall:{queued:order(groups.queued),unsupported:order(groups.unsupported),alreadyPending:order(groups.alreadyPending),queueFull:order(groups.queueFull),unchanged:order(groups.unchanged)}};
}

/**
 * The device audit row of a failed or cancelled agent-uninstall job, with the
 * job's actor and the reason in the target. Its guard reads the job in
 * `fromState`, so the row must precede the statement that moves the job out of
 * that state in the same batch: it is written exactly when that statement changes the job.
 */
/** The portal log keeps its German texts (audit entries are out of the catalog), so a stored serverMessage key is written as its German text. */
const auditReason=(reason:string)=>storedMessageText(reason,(key,params)=>translate('de',key,params));
export async function uninstallFailureAudit(jobId:string,serverId:string,reason:string,at:number,fromState:'pending'|'running'):Promise<Step[]>{
 const row=await db().one<{name:string;customer_id:string|null;actor:string}>(sql`SELECT s.name,s.customer_id,COALESCE(j.actor_email,j.actor) AS actor FROM jobs j JOIN servers s ON s.id=j.server_id WHERE j.id=${jobId} AND j.server_id=${serverId} AND j.action=${AGENT_UNINSTALL_KIND}`);
 if(!row)return [];
 return auditEvent({actor:row.actor,action:'Agent-Deinstallation fehlgeschlagen',target:row.name+' / '+serverId+' / '+auditReason(reason).slice(0,500),serverIds:serverId,customerId:row.customer_id,guard:sql`EXISTS (SELECT 1 FROM jobs WHERE id=${jobId} AND server_id=${serverId} AND action=${AGENT_UNINSTALL_KIND} AND state=${fromState})`,at});
}

/**
 * The agent reported AGENT_UNINSTALL_STARTED for a running agent-uninstall job.
 * In one batch: the job succeeds, one "started" audit row, then the device is
 * revoked with the statements of removeDevices. The step-up proof of
 * removeDevices is replaced by the condition that this job is still running for
 * this device and the device is not revoked: the proof was consumed at queue
 * time, the claim rechecked the actor, and the agent is already uninstalling.
 * True when the device was revoked.
 */
export async function completeAgentUninstall({serverId,jobId,message,args,at}:{serverId:string;jobId:string;message:string;args?:Record<string,string>;at:number}):Promise<boolean>{
 const d=db();
 const row=await d.one<{name:string;customer_id:string|null;actor:string}>(sql`SELECT s.name,s.customer_id,COALESCE(j.actor_email,j.actor) AS actor FROM jobs j JOIN servers s ON s.id=j.server_id WHERE j.id=${jobId} AND j.server_id=${serverId} AND j.action=${AGENT_UNINSTALL_KIND} AND j.state='running' AND s.revoked=0`);
 if(!row)return false;
 const marker='revoked:'+crypto.randomUUID();
 const started=sql`EXISTS (SELECT 1 FROM jobs WHERE id=${jobId} AND server_id=${serverId} AND action=${AGENT_UNINSTALL_KIND} AND state='succeeded' AND result_code=${AGENT_UNINSTALL_STARTED}) AND EXISTS (SELECT 1 FROM servers WHERE id=${serverId} AND revoked=0)`;
 const revocation=deviceRevocation([serverId],marker,at,sql`revoked=0 AND ${started}`);
 const results=await commitAll([
  sql`UPDATE jobs SET state='succeeded',result=${message},result_code=${AGENT_UNINSTALL_STARTED},result_args=${args&&Object.keys(args).length?JSON.stringify(args):null},parameters='{}',last_progress=${at} WHERE id=${jobId} AND server_id=${serverId} AND action=${AGENT_UNINSTALL_KIND} AND state='running' AND EXISTS (SELECT 1 FROM servers WHERE id=${serverId} AND revoked=0)`,
  ...auditEvent({actor:row.actor,action:'Agent-Deinstallation gestartet',target:row.name+' / '+serverId,serverIds:serverId,customerId:row.customer_id,guard:started,at}),
  revocation.revoke,
  ...revocation.cleanup,
  ...revocation.audit(row.actor,[{id:serverId,name:row.name,customer_id:row.customer_id}]),
  sql`SELECT 1 AS revoked WHERE ${revocation.guard}`
 ]);
 const revoked=!!results.at(-1)?.rows.length;
 if(revoked)await sweepRemovedTransfers(3,serverId);
 return revoked;
}

/**
 * The offboarding state of 1–100 devices (lib/offboarding.ts): one entry per ID,
 * from the device row and its latest agent-uninstall job. Owners only.
 */
export async function offboardingStatus(actor:Viewer,value:unknown):Promise<OffboardingEntry[]>{
 await requireCan(actor,'instance.owner','apiError.devices.offboardingAdminOnly');
 if(!Array.isArray(value)||!value.length||value.length>100||value.some(id=>!guid(id)))throw new HttpError('apiError.devices.selectRange');
 const ids=[...new Set(value as string[])],scope=JSON.stringify(ids),d=db(),at=now();
 const inScope=sql`IN (SELECT jsonb_array_elements_text(${scope}::jsonb))`;
 const devices=await d.query<{id:string;name:string;revoked:number;snapshot:string|null}>(sql`SELECT id,name,revoked,snapshot FROM servers WHERE id ${inScope}`);
 if(devices.length!==ids.length)throw new HttpError('apiError.devices.offboardingNotFound');
 for(const device of devices)if(!device.revoked)await requireDevice(actor,device.id,'view');
 const jobs=await d.query<{id:string;server_id:string;state:string;created_at:number;not_before:number;claimed_at:number|null;result:string|null;result_code:string|null;result_args:string|null}>(sql`SELECT DISTINCT ON (server_id) id,server_id,state,created_at,not_before,claimed_at,result,result_code,result_args FROM jobs WHERE server_id ${inScope} AND action=${AGENT_UNINSTALL_KIND} ORDER BY server_id,created_at DESC,id DESC`);
 const byDevice=new Map(devices.map(device=>[device.id,device])),latest=new Map(jobs.map(job=>[job.server_id,job]));
 return ids.map(id=>{
  const device=byDevice.get(id)!,job=latest.get(id)??null;let snapshot=null;try{snapshot=device.snapshot?JSON.parse(device.snapshot):null;}catch{}
  const facts=job?{state:job.state,createdAt:Number(job.created_at),notBefore:Number(job.not_before),claimedAt:job.claimed_at==null?null:Number(job.claimed_at),result:job.result}:null;
  const {state,reason}=offboardingState({revoked:!!device.revoked,capable:canUninstall(snapshot),job:facts,now:at});
  return {id,name:device.name,state,...(reason?{reason}:{}),...(reason==='agent'?{code:job?.result_code??null,args:parseAgentArgs(job?.result_args),result:job?.result??null}:{}),...(job?{jobId:job.id}:{})};
 });
}

export async function sweepRemovedTransfers(limit=3,serverId?:string|string[]){
 const d=db(),scope=serverId?JSON.stringify(Array.isArray(serverId)?serverId:[serverId]):null,rows=await d.query<{id:string}>(sql`SELECT t.id FROM transfers t JOIN servers s ON s.id=t.server_id WHERE s.revoked=1 AND t.state<>'expired'${scope?sql` AND t.server_id IN (SELECT jsonb_array_elements_text(${scope}::jsonb))`:sql``} ORDER BY t.updated_at LIMIT ${limit}`);
 for(const row of rows){
  try{await clearTransfer(row.id);await d.exec(sql`UPDATE transfers SET state='expired',updated_at=${now()} WHERE id=${row.id} AND server_id IN (SELECT id FROM servers WHERE revoked=1)`);}
  catch{console.error('Offboarding-Dateibereinigung wird beim nächsten Portalabruf erneut versucht.');}
 }
}
