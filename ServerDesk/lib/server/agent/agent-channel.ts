import {z} from 'zod';
import {body,failure,HttpError,now,config,guid} from '../context';
import {dispatchSigner,DISPATCH_LIFETIME_SECONDS,signingKeyFailure} from './agent-dispatch';
import {agentFromBearer,assertAgentActive,snapshot,releaseLease,securityFile,lease} from './agent-protocol';
import {resolvePrincipal,requireDevice,devicePermissionGuard} from '../identity/access';
import {jobRequirements} from '../../jobs/requirements';
import {jobConcurrency,MAX_REPORTED_RUNNING_JOBS,MAX_RUNNING_JOBS} from '../devices/jobs/concurrency';
import {requireFileAccess} from '../devices/file-access';
import {tickAutomation} from '../automation/runbooks';
import {ingestDrift} from '../automation/drift';
import {verifyTransfer,sweepTransfers,transferAuthorizationGuard,type Transfer} from '../devices/transfers';
import {sweepTerminalSessions} from '../devices/terminal-lifecycle';
import {sweepRdp} from '../devices/rdp';
import {terminalReport,exchangeTerminals} from '../devices/terminal-channel';
import {advanceDesiredState,checkPendingDesiredJob,desiredJobClaimGuard} from '../automation/desired-state';
import {desiredResultActions,desiredResultStatement} from '../automation/desired-state-result';
import {getAutomationDriftPolicy,reconcileDeviceAutomation} from '../automation/automation-device';
import {PENDING_JOB_LIFETIME_MS} from '../../job-expiry';
import {AGENT_ARG_NAME_PATTERN,AGENT_CODE_PATTERN,AGENT_MAX_ARGS,AGENT_MAX_ARG_LENGTH} from '../../agent-messages';
import {commitAll,db,jsonPath,jsonText,sql,type Sql} from '../db';
import {takeChannelSlot} from './agent-admission';
import {canSql,can} from '../identity/policy/can';
import {completeAgentUninstall,uninstallFailureAudit} from '../devices/device-lifecycle';
import {AGENT_UNINSTALL_KIND,AGENT_UNINSTALL_STARTED,UNINSTALL_UNSUPPORTED_RESULT} from '../../offboarding';
import {pluginCollectionPolicy,PLUGIN_INSTALL,PLUGIN_REMOVE} from '../../plugin-catalog';
import {installedPluginEntry,MAX_SNAPSHOT_PLUGINS} from '../extensions/plugin-results';
import {AD_SIGN_IN} from '../../plugin-ad';
import {adClaimable,adClaimGuard,ingestAdSignIn} from '../extensions/plugin-ad-sessions';

// The agent command channel (app/api/agent/channel): results, progress,
// transfers, terminal reports of older agents and the claim of the next job.
// The route only delegates here.

// Columns this route reads from the rows it selects or claims.
type PendingJobRow={id:string;server_id:string;action:string;actor_principal:string|null;parameters:string};
type ClaimedJobRow={id:string;action:string;target:string;parameters:string;createdAt:number};
type RunningJobRow={id?:string;concurrency:string|null;concurrency_group:string|null};
type OfferedTransferRow=Pick<Transfer,'id'|'direction'|'path'|'size'|'sha256'|'state'|'overwrite'>;
// The portal principal of a job's actor, stored at queue time (principal(v),
// lib/server/identity/access.ts): every claim guard (permissions, instance.owner, the AD
// session) uses this one column. A job without it is never claimed.
const jobActor=sql`jobs.actor_principal`;

// Agent 4.21.0+ runs several jobs at once (lib/server/devices/jobs/concurrency.ts,
// docs/native-agent-v4.md "Parallel jobs"). Older agents get one job at a time.
export const PARALLEL_JOBS_CAPABILITY='parallel-jobs';

// Agent 4.8.0+: a message code with up to eight string arguments next to the
// English message (lib/agent-messages.ts). Older agents send neither.
const agentArgs=z.record(z.string().regex(AGENT_ARG_NAME_PATTERN),z.string().max(AGENT_MAX_ARG_LENGTH)).refine(args=>Object.keys(args).length<=AGENT_MAX_ARGS);
// Exported for the schema tests (tests/lib/zod4-schemas.mjs).
export const agentChannelBody=z.object({
 serverId:z.guid(),runningJobs:z.array(z.guid()).max(MAX_REPORTED_RUNNING_JOBS).default([]),
 results:z.array(z.object({id:z.guid(),ok:z.boolean(),message:z.string().max(4000),code:z.string().regex(AGENT_CODE_PATTERN).optional(),args:agentArgs.optional(),data:z.unknown().optional()}).refine(result=>result.args===undefined||result.code!==undefined)).max(10).default([]),
 terminal:terminalReport.nullable().optional(),
 terminals:z.array(terminalReport).max(8).refine(reports=>new Set(reports.map(report=>report.id)).size===reports.length).optional(),
 transfers:z.array(z.object({id:z.guid(),state:z.enum(['active','completed','failed']),size:z.number().int().min(0).nullable().optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),message:z.string().max(1500).nullable().optional()})).max(10).default([]),
 drift:z.unknown().optional()
});
// A pending agent-uninstall job that cannot be claimed: cancelled with its
// reason and one device audit row. The device stays registered.
async function cancelUninstall(jobId:string,serverId:string,reason:string,at:number){
 await commitAll([
  ...await uninstallFailureAudit(jobId,serverId,reason,at,'pending'),
  sql`UPDATE jobs SET state='cancelled',parameters='{}',result=${reason},result_code=NULL WHERE id=${jobId} AND server_id=${serverId} AND state='pending'`
 ]);
}
// An agent with an armed uninstall names its job in this header on every channel post.
const UNINSTALL_JOB_HEADER='X-ServerDesk-Uninstall-Job';
// Covers the agent's 10-minute delivery timeout and keeps the lookup to recent jobs.
export const UNINSTALL_CONFIRMATION_WINDOW_MS=15*60*1000;
/**
 * The generic 403 of a failed device authentication, or the proof that the
 * portal revoked this device through its uninstall: 403 AGENT_UNINSTALL_CONFIRMED
 * when the device ID header names a revoked device whose agent-uninstall job
 * from the job header succeeded with AGENT_UNINSTALL_STARTED in the last 15
 * minutes. The job ID is the secret here: the revocation overwrote the token,
 * and a proxy or a caller without the job ID gets the unchanged answer. Headers
 * only, one primary-key lookup, no write.
 */
async function uninstallConfirmation(request:Request,error:unknown):Promise<never>{
 const deviceId=request.headers.get('X-ServerDesk-Device-Id'),jobId=request.headers.get(UNINSTALL_JOB_HEADER);
 if(error instanceof HttpError&&error.messageKey==='apiError.agent.notApproved'&&guid(deviceId)&&guid(jobId)){
  const confirmed=await db().one(sql`SELECT 1 AS confirmed FROM jobs j JOIN servers s ON s.id=j.server_id WHERE j.id=${jobId} AND j.server_id=${deviceId} AND s.revoked=1 AND j.action=${AGENT_UNINSTALL_KIND} AND j.state='succeeded' AND j.result_code=${AGENT_UNINSTALL_STARTED} AND j.last_progress>=${now()-UNINSTALL_CONFIRMATION_WINDOW_MS}`);
  if(confirmed)throw new HttpError('apiError.agent.uninstallConfirmed');
 }
 throw error;
}
/**
 * The concurrency part of the atomic claim UPDATE (docs/native-agent-v4.md
 * "Parallel jobs"), by the class the job runs with. A running job without a
 * class (claimed before 0029) counts as sole.
 * - sole (also every job of an agent without parallel-jobs): no job runs and
 *   no other owner holds the device lease, as before.
 * - exclusive: the cap, no exclusive or sole job runs, the group is free, and
 *   no other owner holds the device lease.
 * - parallel: the cap, no sole job runs, the group is free, and a live device
 *   lease belongs only to a running exclusive job or to a terminal.
 */
function concurrencyGuard(serverId:string,jobId:string,time:number,mode:'parallel'|'exclusive'|'sole',group:string|null):Sql{
 const runs=(where:Sql)=>sql`EXISTS (SELECT 1 FROM jobs active WHERE active.server_id=${serverId} AND active.state='running' AND ${where})`;
 const ownLease=sql`NOT EXISTS (SELECT 1 FROM device_leases WHERE server_id=${serverId} AND expires_at>${time} AND owner_id<>${jobId})`;
 if(mode==='sole')return sql`NOT ${runs(sql`TRUE`)} AND ${ownLease}`;
 const cap=sql`(SELECT count(*) FROM jobs active WHERE active.server_id=${serverId} AND active.state='running')<${MAX_RUNNING_JOBS}`;
 const groupFree=group===null?sql`TRUE`:sql`NOT ${runs(sql`active.concurrency_group=${group}`)}`;
 if(mode==='exclusive')return sql`${cap} AND NOT ${runs(sql`(active.concurrency IS NULL OR active.concurrency IN ('exclusive','sole'))`)} AND ${groupFree} AND ${ownLease}`;
 return sql`${cap} AND NOT ${runs(sql`(active.concurrency IS NULL OR active.concurrency='sole')`)} AND ${groupFree} AND NOT EXISTS (SELECT 1 FROM device_leases l WHERE l.server_id=${serverId} AND l.expires_at>${time} AND l.owner_kind<>'terminal' AND NOT EXISTS (SELECT 1 FROM jobs owner WHERE owner.id=l.owner_id AND owner.server_id=${serverId} AND owner.state='running' AND owner.concurrency='exclusive'))`;
}
/**
 * The stored snapshot edit of a succeeded plugin-install or plugin-remove result (lib/server/extensions/plugin-results.ts), in SQL
 * on the snapshot stored at commit time, so other keys a parallel heartbeat wrote stay. guard: the job is still
 * running and the device active. A removal drops the entry of params.name. An install writes the entry of
 * installedPluginEntry in place of any entry of that name, sorted by name (ordinal); it writes nothing without a
 * valid entry or when the list already holds MAX_SNAPSHOT_PLUGINS other plugins. A snapshot that is null or no
 * JSON object, or whose plugins is no array, stays as it is; a snapshot without plugins gets the key only from an install.
 */
function pluginResultSnapshot(serverId:string,action:string,params:unknown,guard:Sql):Sql[]{
 const name=(params as {name?:unknown}|null)?.name;
 if(typeof name!=='string'||(action!==PLUGIN_REMOVE&&action!==PLUGIN_INSTALL))return [];
 const doc=sql`(CASE WHEN snapshot IS JSON OBJECT THEN snapshot::jsonb END)`;
 const list=sql`(CASE WHEN jsonb_typeof(${doc}->'plugins')='array' THEN ${doc}->'plugins' ELSE '[]'::jsonb END)`;
 const others=sql`(SELECT entry,position FROM jsonb_array_elements(${list}) WITH ORDINALITY AS item(entry,position) WHERE (entry->>'name') IS DISTINCT FROM ${name}::text)`;
 if(action===PLUGIN_REMOVE)return [sql`UPDATE servers SET snapshot=jsonb_set(${doc},'{plugins}',(SELECT coalesce(jsonb_agg(kept.entry ORDER BY kept.position),'[]'::jsonb) FROM ${others} kept))::text WHERE id=${serverId} AND jsonb_typeof(${doc}->'plugins')='array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(${list}) AS item(entry) WHERE (entry->>'name')=${name}::text) AND ${guard}`];
 const entry=installedPluginEntry(params);if(!entry)return [];
 return [sql`UPDATE servers SET snapshot=jsonb_set(${doc},'{plugins}',(SELECT jsonb_agg(merged.entry ORDER BY (merged.entry->>'name') COLLATE "C") FROM (SELECT kept.entry FROM ${others} kept UNION ALL SELECT ${JSON.stringify(entry)}::jsonb) AS merged(entry)))::text WHERE id=${serverId} AND ${doc} IS NOT NULL AND (${doc}->'plugins' IS NULL OR jsonb_typeof(${doc}->'plugins')='array') AND (SELECT count(*) FROM ${others} kept)<${MAX_SNAPSHOT_PLUGINS} AND ${guard}`];
}
export async function agentChannel(request:Request){try{
 // Authenticate from the headers before buffering up to 2 MB of body.
 const d=await agentFromBearer(request,{allowTokenRetry:true}).catch(error=>uninstallConfirmation(request,error));
 const parsed=agentChannelBody.safeParse(await body(request,2097152));if(!parsed.success)throw new HttpError('apiError.agent.invalidChannel');
 const p=parsed.data;if(p.serverId!==d.id)throw new HttpError('apiError.agent.notApproved');
 const s=snapshot(d),time=now();if(s?.protocolVersion!==3)throw new HttpError('apiError.agent.v3Required');
 const multi=s.agentCapabilities?.includes('terminal-multi')===true,live=s.agentCapabilities?.includes('terminal-live')===true;
 // Split agents execute only portal-signed work. Fail before any claim when
 // the signing key is absent, instead of claiming jobs the broker must refuse.
 let signer;try{signer=dispatchSigner(config('AGENT_JOB_SIGNING_KEY'));}catch(error){throw signingKeyFailure(error);}
 if(s.agentCapabilities?.includes('signed-dispatch')&&!signer)throw new HttpError('apiError.signing.keyMissing');
 if(p.terminal&&p.terminals!==undefined)throw new HttpError('apiError.agent.terminalReportDuplicate');
 // A freshly updated agent may advertise its new heartbeat just after its first
 // channel poll. Accept its first single report without losing that report's ACK.
 const reports=p.terminals??(p.terminal?[p.terminal]:[]);
 if(live&&reports.length)throw new HttpError('apiError.agent.terminalReportChannel');
 const active=sql`EXISTS (SELECT 1 FROM servers WHERE id=${d.id} AND revoked=0)`;
 const rate=await takeChannelSlot(d.id,d.id,time,time-150);if(!rate){await assertAgentActive(d);throw new HttpError('apiError.agent.channelTooFrequent');}
 await sweepTransfers(d.id);await sweepTerminalSessions(d.id,time);await sweepRdp(d.id,time);

 // uninstalled: an agent-uninstall success revoked this device in this request.
 // unconfirmed: a start result that revoked nothing (the job is not a running
 // agent-uninstall job of this device, or the revocation did not happen).
 let uninstalled=false,unconfirmed=false;
 for(const r of p.results){
  const starts=r.ok&&r.code===AGENT_UNINSTALL_STARTED;
  const j=await db().one<{action:string;parameters:string}>(sql`SELECT action,parameters FROM jobs WHERE id=${r.id} AND server_id=${d.id} AND state='running' AND ${active}`);if(!j){if(starts)unconfirmed=true;continue;}
  if(j.action===AGENT_UNINSTALL_KIND){
   // Only AGENT_UNINSTALL_STARTED revokes the device (completeAgentUninstall).
   // Any other result, also ok:true with another code, fails the job and keeps the device.
   if(starts){if(await completeAgentUninstall({serverId:d.id,jobId:r.id,message:r.message,args:r.args,at:time}))uninstalled=true;else unconfirmed=true;}
   else await commitAll([
    ...await uninstallFailureAudit(r.id,d.id,r.message,time,'running'),
    sql`UPDATE jobs SET state='failed',result=${r.message},result_code=${r.code??null},result_args=${r.code&&r.args?JSON.stringify(r.args):null},parameters='{}',last_progress=${time} WHERE id=${r.id} AND server_id=${d.id} AND state='running' AND ${active}`
   ]);
   await releaseLease(r.id);continue;
  }
  // A start result for a running job of another kind is stored as today, but it revoked nothing.
  if(starts)unconfirmed=true;
  // An AD sign-in turns its pending row active, or deletes it, in the transaction of its result (docs/plugin-ad-sign-in.md).
  if(j.action===AD_SIGN_IN){await ingestAdSignIn(d,s,r,time,active);await releaseLease(r.id);continue;}
  const params=JSON.parse(j.parameters);let data=r.data;
  if(data!==undefined){
   if(new TextEncoder().encode(JSON.stringify(data)).length>262144)throw new HttpError('apiError.agent.diagnosticsTooLarge');
   // The scope keeps the output as private as the job after its parameters are wiped.
   const required=jobRequirements(j.action,params);
   if(data&&typeof data==='object'&&!Array.isArray(data))data={...data,scope:{security:required.securityEvents,management:required.privilegedPath,runbookCustom:j.action==='runbook-step'&&params.kind==='powershell'}};
  }
  // Output, the Desired-State assignment status and the job state commit together.
  // Both guarded writes before the job update still see the job as running.
  await commitAll([
   ...(data!==undefined?[sql`INSERT INTO job_outputs (job_id,server_id,data,created_at) SELECT ${r.id},${d.id},${JSON.stringify(data)},${time} WHERE EXISTS (SELECT 1 FROM jobs WHERE id=${r.id} AND server_id=${d.id} AND state='running') AND ${active} ON CONFLICT(job_id) DO NOTHING`]:[]),
   ...(desiredResultActions.has(j.action)?[desiredResultStatement({jobId:r.id,serverId:d.id,ok:r.ok,data,time})]:[]),
   // A removed plugin leaves no data: deleted with the success, while the job is still running.
   ...(j.action===PLUGIN_REMOVE&&r.ok&&typeof params.name==='string'?[sql`DELETE FROM device_plugin_data WHERE server_id=${d.id} AND plugin=${params.name} AND EXISTS (SELECT 1 FROM jobs WHERE id=${r.id} AND server_id=${d.id} AND state='running') AND ${active}`]:[]),
   // A succeeded install or removal is in the stored snapshot at once; the heartbeat keeps it (lib/server/agent/heartbeat.ts).
   ...(r.ok?pluginResultSnapshot(d.id,j.action,params,sql`EXISTS (SELECT 1 FROM jobs WHERE id=${r.id} AND server_id=${d.id} AND state='running') AND ${active}`):[]),
   sql`UPDATE jobs SET state=${r.ok?'succeeded':'failed'},result=${r.message},result_code=${r.code??null},result_args=${r.code&&r.args?JSON.stringify(r.args):null},parameters='{}',last_progress=${time} WHERE id=${r.id} AND server_id=${d.id} AND state='running' AND ${active}`
  ]);await releaseLease(r.id);
 }
 // The agent starts its detached uninstaller once this answer arrives. The
 // device is revoked now, so the answer carries no work and skips the 403 of
 // assertAgentActive; every later request with this token is refused.
 if(uninstalled)return Response.json({ok:true,jobs:[],signedJobs:[],transfers:[],signedTransfers:[],intervalMs:5000},{headers:{'Cache-Control':'no-store'}});
 // A plain 200 for a start result always means "revoked in this request": agents
 // (also 4.9.0 and 4.10.0) start their uninstaller on it. A start that revoked
 // nothing gets 409 before any lease, claim, transfer or terminal exchange. The
 // other results of this request are already stored.
 if(unconfirmed)throw new HttpError('apiError.agent.uninstallNotConfirmed');
 for(const id of p.runningJobs){
  await db().exec(sql`UPDATE jobs SET last_progress=${time} WHERE id=${id} AND server_id=${d.id} AND state='running' AND ${active}`);
  await db().exec(sql`UPDATE device_leases SET expires_at=${time+120000} WHERE server_id=${d.id} AND owner_id=${id} AND ${active}`);
 }

 // Live agents keep their terminal transport independent of inventory, jobs,
 // runbook scheduling and file transfers. Updater admission still uses the
 // authoritative database state, never a stale native report.
 const terminalCommands=live?[]:await exchangeTerminals(d,s,reports,time);
 const activeTerminal=live?!!await db().one(sql`SELECT id FROM terminal_sessions WHERE server_id=${d.id} AND state IN ('opening','open') LIMIT 1`):terminalCommands.some(command=>['opening','open'].includes(command.state));
 const activeRdp=!!await db().one(sql`SELECT id FROM rdp_sessions WHERE server_id=${d.id} AND state IN ('opening','open') LIMIT 1`);

 const transfers=await db().query<Transfer>(sql`SELECT * FROM transfers WHERE server_id=${d.id} AND state IN ('pending','ready','active') ORDER BY created_at LIMIT 3`).then(results=>({results}));
 const activeTransfers=[];
 for(const transfer of transfers.results){
  let valid=transfer.expires_at>time;
  try{
   const v=await resolvePrincipal(transfer.principal);if(!v)valid=false;else await requireFileAccess(v,d.id,transfer.path,transfer.direction==='upload'?'files.write':'files.read');
   if(securityFile(transfer.path)&&v)await requireDevice(v,d.id,'security.events');if(transfer.direction==='upload'&&!d.management)valid=false;
  }catch{valid=false;}
  if(!valid){await db().exec(sql`UPDATE transfers SET state='cancelled',message='serverMessage.transfer.revoked' WHERE id=${transfer.id}`);continue;}
  const report=p.transfers.find(item=>item.id===transfer.id);
  if(report){
   if(report.state==='completed'){if(report.size!==transfer.size||report.sha256!==transfer.sha256)throw new HttpError('apiError.agent.fileCheckMismatch');if(transfer.direction==='download')await verifyTransfer(transfer);}
   const authorization=transferAuthorizationGuard(transfer,time);const changed=await db().exec(sql`UPDATE transfers SET state=${report.state},updated_at=${time},message=${report.message??null} WHERE id=${transfer.id} AND state IN ('pending','ready','active') AND ${active} AND ${authorization}`);if(!changed.rowCount)continue;transfer.state=report.state;
  }
  if(['pending','ready','active'].includes(transfer.state))activeTransfers.push({id:transfer.id,direction:transfer.direction,path:transfer.path,size:transfer.size,sha256:transfer.sha256,chunkSize:262144,state:transfer.state,overwrite:!!transfer.overwrite});
 }
 await assertAgentActive(d);
 if(p.drift!==undefined)await ingestDrift(d.id,p.drift);await reconcileDeviceAutomation(d.id);await tickAutomation(d.id,s);await advanceDesiredState(d.id);
 await commitAll([
  sql`UPDATE jobs SET state='expired',parameters='{}',result='serverMessage.job.resultUnknownInterrupted' WHERE server_id=${d.id} AND state='running' AND (COALESCE(last_progress,claimed_at,created_at)<${time-900000} OR claimed_at<${time-7200000})`,
  sql`DELETE FROM terminal_frames WHERE session_id IN (SELECT id FROM terminal_sessions WHERE state IN ('closed','error') AND last_activity<${time-600000})`
 ]);

 const claimed=[];const claimGuards=new Map<string,ReturnType<typeof devicePermissionGuard>>();
 // A parallel-jobs agent may get a job while others run, by the class of each
 // job (lib/server/devices/jobs/concurrency.ts). running holds the device's running jobs as
 // the claim found them plus every claim of this poll; the claim UPDATE
 // guards again atomically. A row without a class (claimed before 0029) is sole.
 // A job the agent still runs but the portal no longer counts as running (for
 // example expired after 2 hours) is unknown here, so it counts as sole too.
 const parallelAgent=s.agentCapabilities?.includes(PARALLEL_JOBS_CAPABILITY)===true;
 const running=parallelAgent?await db().query<RunningJobRow>(sql`SELECT id,concurrency,concurrency_group FROM jobs WHERE server_id=${d.id} AND state='running'`):[];
 if(parallelAgent)for(const id of p.runningJobs)if(!running.some(job=>job.id===id))running.push({id,concurrency:null,concurrency_group:null});
 const soleRunning=()=>running.some(job=>job.concurrency===null||job.concurrency==='sole');
 const changeRunning=()=>running.some(job=>job.concurrency!=='parallel');
 const groupBusy=(group:string|null)=>group!==null&&running.some(job=>job.concurrency_group===group);
 const idle=parallelAgent?running.length<MAX_RUNNING_JOBS&&!soleRunning():!p.runningJobs.length;
 if(idle&&!activeTransfers.length&&(multi||!activeTerminal)){
  // Pending jobs past the heartbeat's expiry bound are never delivered, even if
  // the device polls the channel before its next heartbeat expires them.
  const candidates=await db().query<PendingJobRow>(sql`SELECT * FROM jobs WHERE server_id=${d.id} AND state='pending' AND not_before<=${time} AND GREATEST(created_at,not_before)>=${time-PENDING_JOB_LIFETIME_MS} ORDER BY created_at,id LIMIT 20`).then(results=>({results}));
  // An exclusive job that cannot be claimed holds every later exclusive and
  // sole job of this poll, so changes keep their queue order. Parallel jobs
  // behind it are still claimed.
  let held=false;
  for(const job of candidates.results){
   if(parallelAgent&&(running.length>=MAX_RUNNING_JOBS||soleRunning()))break;
   const parameters=JSON.parse(job.parameters),required=jobRequirements(job.action,parameters),updating=job.action==='agent-update',uninstalling=job.action===AGENT_UNINSTALL_KIND;
   const {mode,group}=jobConcurrency(job.action,parameters);
   // Agent update and uninstall need the device for themselves: no terminal, RDP session, transfer or other lease.
   const maintenance=updating||uninstalling;
   if(maintenance&&(activeTerminal||activeRdp))continue;
   if(parallelAgent){
    // A sole job waits until no job runs and no earlier exclusive job is held
    // in this poll, and no later job overtakes it: a held exclusive job also
    // stops the loop at a sole job instead of skipping it.
    if(mode==='sole'&&(running.length||held))break;
    if(mode!=='parallel'&&held)continue;
    if(mode==='exclusive'&&(changeRunning()||groupBusy(group))){held=true;continue;}
    if(mode==='parallel'&&groupBusy(group))continue;
   }
   const capable=required.capabilities.every(capability=>s.agentCapabilities?.includes(capability));
   // An agent that no longer lists the uninstall (for example after a downgrade) cannot run it.
   if(uninstalling&&!capable){await cancelUninstall(job.id,d.id,UNINSTALL_UNSUPPORTED_RESULT,time);continue;}
   let valid=capable&&(!required.managementMode||d.management===1&&s.mode==='Management');
   try{
    if((job.action==='desired-state-test'||job.action==='desired-state-apply')&&!await checkPendingDesiredJob(job))throw new HttpError('apiError.agent.desiredAssignmentInvalid');
    const v=job.actor_principal?await resolvePrincipal(job.actor_principal):null;if(!v)valid=false;else{for(const right of required.permissions)await requireDevice(v,d.id,right);if(uninstalling&&!await can(v,'instance.owner',{fresh:true}))valid=false;}
   }catch{valid=false;}
   if(!valid){const reason='serverMessage.job.permissionOrCapabilityMissing';if(uninstalling)await cancelUninstall(job.id,d.id,reason,time);else await db().exec(sql`UPDATE jobs SET state='cancelled',parameters='{}',result=${reason} WHERE id=${job.id} AND state='pending'`);continue;}
   // A plugin change runs as its AD account: only while that sign-in and its portal session are alive.
   if(!await adClaimable(job.action,parameters,job.actor_principal===null?null:sql`${job.actor_principal}`,time)){await db().exec(sql`UPDATE jobs SET state='cancelled',parameters='{}',result='serverMessage.job.adSignInEnded' WHERE id=${job.id} AND state='pending'`);continue;}
   const guards=required.permissions.map(permission=>devicePermissionGuard(sql`jobs.server_id`,jobActor,permission));
   // The uninstall revokes the device in the end, so it keeps the removal right: instance.owner as well.
   if(uninstalling)guards.push(canSql(jobActor,'instance.owner'));
   const scope=job.action==='runbook-step'?await (await import('../automation/automation-runbooks')).scopedRunbookClaimGuard(job.id,d.id,parameters.runId):job.action==='desired-state-test'||job.action==='desired-state-apply'?await desiredJobClaimGuard(job.id,d.id):sql`TRUE`;
   const releaseId=jsonText(sql`jobs.parameters`,'releaseId');
   const authorization=sql`${sql.join([...guards,sql`TRUE`].map(guard=>sql`(${guard})`),sql` AND `)} AND (jobs.action<>'agent-update' OR (jsonb_typeof(${jsonPath(sql`jobs.parameters`,'releaseId')})='string' AND NOT EXISTS (SELECT 1 FROM agent_release_states WHERE release_id=${releaseId}))) AND (${scope}) AND (${adClaimGuard(time,jobActor)})`;
   claimGuards.set(job.id,authorization);
   // A parallel job takes no device lease; exclusive and sole jobs, and every job of an older agent, take it as before.
   const leased=!parallelAgent||mode!=='parallel';
   if(leased)try{await lease(d.id,'job',job.id,time+120000,{ignoreTerminal:multi&&!maintenance});}catch(error){if(error instanceof HttpError&&error.status===409){if(!parallelAgent||mode==='sole')break;held=true;continue;}throw error;}
   // Update admission holds its exclusive lease before atomically rechecking
   // terminals and every active transfer state, including unfinished uploads.
   // Terminal/transfer creation uses the same lease guard to close the race.
   const row=await db().one<ClaimedJobRow>(sql`UPDATE jobs SET state='running',claimed_at=${time},last_progress=${time},concurrency=${mode},concurrency_group=${group} WHERE id=${job.id} AND state='pending' AND ${active} AND ${concurrencyGuard(d.id,job.id,time,parallelAgent?mode:'sole',group)} AND ${authorization} AND (${!maintenance} OR (NOT EXISTS (SELECT 1 FROM terminal_sessions WHERE server_id=${d.id} AND state IN ('opening','open')) AND NOT EXISTS (SELECT 1 FROM rdp_sessions WHERE server_id=${d.id} AND state IN ('opening','open')) AND NOT EXISTS (SELECT 1 FROM transfers WHERE server_id=${d.id} AND state IN ('pending','uploading','ready','active') AND expires_at>${time}))) RETURNING id,action,target,parameters,created_at AS "createdAt"`);
   if(row){claimed.push({...row,parameters:JSON.parse(row.parameters)});running.push({concurrency:mode,concurrency_group:group});}else if(leased)await releaseLease(job.id);
   // An older agent gets at most one job per poll, as before.
   if(!parallelAgent){if(row||!maintenance)break;continue;}
   // Nothing is claimed next to a sole job, nor past one that must wait.
   if(mode==='sole')break;
   if(!row&&mode==='exclusive')held=true;
  }
 }
 const busy=!!p.runningJobs.length||!!claimed.length||!!await db().one(sql`SELECT id FROM jobs WHERE server_id=${d.id} AND state='running' LIMIT 1`);
 // Older native agents fail, rather than queue, a transfer offered while busy.
 // Continue already-active transfers but hold new plans until jobs are idle.
 const transferCandidates=activeTransfers.filter(transfer=>transfer.state==='active'||(!busy&&(multi||!activeTerminal)));
 const authorizedClaims=[];
 for(const candidate of claimed){const guard=claimGuards.get(candidate.id)!;
  const current=await db().one<ClaimedJobRow>(sql`SELECT id,action,target,parameters,created_at AS "createdAt" FROM jobs WHERE id=${candidate.id} AND state='running' AND ${guard}`);
  if(current)authorizedClaims.push({...current,parameters:JSON.parse(current.parameters)});
  else{const reason='serverMessage.job.permissionRevokedBeforeDelivery';await commitAll([...(candidate.action===AGENT_UNINSTALL_KIND?await uninstallFailureAudit(candidate.id,d.id,reason,time,'running'):[]),sql`UPDATE jobs SET state='cancelled',parameters='{}',result=${reason} WHERE id=${candidate.id} AND state='running'`]);await releaseLease(candidate.id);}
 }
 const driftPolicy=await getAutomationDriftPolicy(d.id);
 // Metadata can authorize remote SYSTEM file access. Resolve it again from
 // current RBAC after all automation/crypto work rather than dispatching a
 // transfer captured before group membership or roles were withdrawn.
 const offeredTransfers=[];for(const candidate of transferCandidates){const captured=transfers.results.find(transfer=>transfer.id===candidate.id)!,authorization=transferAuthorizationGuard(captured);const current=await db().one<OfferedTransferRow>(sql`SELECT id,direction,path,size,sha256,state,overwrite FROM transfers WHERE id=${candidate.id} AND state IN ('pending','ready','active') AND ${authorization}`);if(current)offeredTransfers.push({...current,chunkSize:262144,overwrite:!!current.overwrite});}
 // Signed last, from the same values sent in clear for older agents. The
 // broker uses only these envelopes and binds each to this device ID.
 const signedAt=now(),signed=signer?{signedJobs:authorizedClaims.map(job=>signer.sign(d.id,'job',{job},DISPATCH_LIFETIME_SECONDS,signedAt)),signedTransfers:offeredTransfers.map(transfer=>signer.sign(d.id,'transfer',{transfer},DISPATCH_LIFETIME_SECONDS,signedAt)),signedDriftPolicy:signer.sign(d.id,'drift-policy',{policy:driftPolicy??null},DISPATCH_LIFETIME_SECONDS,signedAt),signedPluginPolicy:signer.sign(d.id,'plugin-policy',{policy:pluginCollectionPolicy(s)},DISPATCH_LIFETIME_SECONDS,signedAt)}:{};
 const response={ok:true,jobs:authorizedClaims,...signed,...(!live?(multi?{terminals:terminalCommands}:{terminal:terminalCommands[0]??null}):{}),transfers:offeredTransfers,driftPolicy,intervalMs:!live&&activeTerminal?250:s.agentCapabilities?.includes('list-files')?1500:5000};
 // Recheck immediately before dispatch: a channel admitted before offboarding
 // must not return a queued command, transfer plan or policy afterwards.
 await assertAgentActive(d);
 return Response.json(response,{headers:{'Cache-Control':'no-store'}});
}catch(error){return failure(error);}}
