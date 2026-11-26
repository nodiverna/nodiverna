import {adAuditActions} from '../../audit-actions';
import {jobDisplayInput} from '../../job-input';
import {z} from 'zod';
import {HttpError,guid,now} from '../context';
import {principal,requireDevice,type DeviceRow} from '../identity/access';
import {featureDeviceGuard} from '../identity/feature-authorization';
import {mfaSessionHash} from '../identity/mfa';
import {sealAgentSecrets} from '../agent/agent-crypto';
import {MAX_QUEUED_JOBS,queueFullError} from '../devices/jobs/queue';
import {commitAll,db,jsonText,sql,type Sql} from '../db';
import {AD_ACCOUNT_MAX,AD_DIRECTORY_SID,AD_PASSWORD_MAX,AD_PENDING_LIFETIME_MS,AD_SESSION_LIFETIME_MS,AD_SIGN_IN,AD_SIGN_IN_ATTEMPTS,AD_SIGN_IN_WINDOW_MS,AD_USER_SID,adActAs,adIdentityReady,adSessionExpiry,adSessionFor,deviceDirectory,directoryLabel,entraAdIdentity,
 parseAdAccount,pluginManagePermission,pluginOperationNeedsAccount,type AdActAs,type AdDirectory,type AdDirectoryKind,type AdSessionSummary,type AdSignInStatus,type EntraOnPremises} from '../../plugin-ad';
import {PLUGIN_JOB,pluginOperations} from '../../plugin-catalog';
import type {Permission} from '../identity/access';
import type {ServerSnapshot,Viewer} from '../../types';

// AD sign-ins for plugin changes (docs/plugin-ad-sign-in.md) on PostgreSQL:
// POST /api/plugin-ad sign-in queues one ad-sign-in job with the password
// sealed to the device key and one pending row; the agent's result turns the
// row active (or deletes it). Change jobs carry the session as actAs, and the
// claim delivers them only while that session is alive. A row belongs to one
// portal (MFA) session and one directory SID: ending the portal session
// deletes it through the foreign key. No password is ever written here.

const onlineWindowMs=120_000;
/** The audit actions (English, like every audit action). */
export {adAuditActions};

type SessionRow={id:string;principal:string;session_hash:string;state:'pending'|'active';source:'password'|'entra';job_id:string|null;server_id:string|null;directory_kind:AdDirectoryKind;directory_name:string;directory_sid:string;
 user_sid:string|null;account:string|null;upn:string|null;created_at:number;verified_at:number|null;expires_at:number|null};
/** One active sign-in as GET /api/plugin-ad lists it. */
export type AdSessionView=AdSessionSummary;
const view=(row:SessionRow):AdSessionView=>({id:row.id,directory:{kind:row.directory_kind,name:row.directory_name,sid:row.directory_sid},account:row.account??'',upn:row.upn,source:row.source,verifiedAt:Number(row.verified_at),expiresAt:Number(row.expires_at)});
const parsedSnapshot=(device:DeviceRow):ServerSnapshot|null=>{try{return device.snapshot?JSON.parse(device.snapshot):null;}catch{return null;}};
/** The SQL condition "the MFA session of this row is alive". */
const mfaLive=(alias:Sql,time:number)=>sql`EXISTS (SELECT 1 FROM mfa_sessions live_mfa WHERE live_mfa.token_hash=${alias}.session_hash AND live_mfa.idle_expires_at>${time} AND live_mfa.expires_at>${time})`;

/** The hash of the request's live MFA session, or null without one. */
async function liveSessionHash(request:Request,v:Viewer):Promise<string|null>{
 try{return await mfaSessionHash(request,v);}
 catch(error){if(error instanceof HttpError&&(error.code==='MFA_LOGIN_REQUIRED'||error.code==='MFA_STEP_UP_REQUIRED'))return null;throw error;}
}
/** Pending rows wait at most 2 minutes; expired active rows go too. */
const purge=(time:number)=>commitAll([sql`DELETE FROM plugin_ad_sessions WHERE (state='pending' AND created_at<=${time-AD_PENDING_LIFETIME_MS}) OR (state='active' AND expires_at<=${time})`]);

/** The rate-limit bucket of a portal principal in local_auth_attempts. */
export const adAttemptBucket=(key:string)=>'plugin-ad:'+key;
/** Counts one failed sign-in of this principal (window 15 minutes). */
export const adFailureStatement=(key:string,time:number,guard:Sql=sql`TRUE`)=>sql`INSERT INTO local_auth_attempts (bucket,attempts,window_at,blocked_until) SELECT ${adAttemptBucket(key)},1,${time}::bigint,0 WHERE ${guard}
 ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN local_auth_attempts.window_at<=${time-AD_SIGN_IN_WINDOW_MS} THEN 1 ELSE local_auth_attempts.attempts+1 END,window_at=CASE WHEN local_auth_attempts.window_at<=${time-AD_SIGN_IN_WINDOW_MS} THEN ${time}::bigint ELSE local_auth_attempts.window_at END`;
/** The first key of the transaction-scoped advisory lock of a principal's sign-ins (the second is hashtext of its bucket). */
export const adSignInLockClass=1886151012;
/** The SQL condition "this principal has fewer than AD_SIGN_IN_ATTEMPTS failed sign-ins in the window". */
const failuresBelowLimit=(key:string,time:number)=>sql`NOT EXISTS (SELECT 1 FROM local_auth_attempts WHERE bucket=${adAttemptBucket(key)} AND window_at>${time-AD_SIGN_IN_WINDOW_MS} AND attempts>=${AD_SIGN_IN_ATTEMPTS})`;
/** The SQL condition "a sign-in of this principal is in flight": a pending row within its lifetime whose job is still pending or running. */
const signInInFlight=(key:string,time:number)=>sql`EXISTS (SELECT 1 FROM plugin_ad_sessions flight JOIN jobs flight_job ON flight_job.id=flight.job_id WHERE flight.principal=${key} AND flight.state='pending' AND flight.created_at>${time-AD_PENDING_LIFETIME_MS} AND flight_job.state IN ('pending','running'))`;
/** The rate limit (only failed sign-ins count) and the one sign-in in flight, as errors in that order; null when a sign-in may start. */
async function signInLimit(key:string,time:number):Promise<HttpError|null>{
 const state=await db().one<{allowed:boolean;running:boolean}>(sql`SELECT ${failuresBelowLimit(key,time)} AS allowed,${signInInFlight(key,time)} AS running`);
 if(!state?.allowed)return new HttpError('apiError.pluginAd.tooManyAttempts');
 if(state.running)return new HttpError('apiError.pluginAd.signInRunning');
 return null;
}

/**
 * sign-in: the checks in their order, each without a write, then one
 * transaction with the ad-sign-in job (password sealed to the device key) and
 * the pending row. Answers {jobId}. The transaction first takes the
 * principal's advisory lock, and the job INSERT checks the rate limit and the
 * sign-in in flight again, so of two parallel requests only one queues a job.
 */
export async function signInAd(request:Request,v:Viewer,input:{serverId:unknown;plugin:unknown;account:unknown;password:unknown}):Promise<{jobId:string}>{
 const permission=pluginManagePermission(input.plugin) as Permission|null;
 if(!permission||typeof input.plugin!=='string')throw new HttpError('apiError.plugin.operationUnknown');
 const plugin=input.plugin;
 if(!guid(input.serverId))throw new HttpError('apiError.device.invalid');
 const device=await requireDevice(v,input.serverId,permission),label={name:device.name};
 if(!device.last_seen||now()-device.last_seen>onlineWindowMs)throw new HttpError('apiError.agent.notConnected',label);
 const snapshot=parsedSnapshot(device);
 if(snapshot?.protocolVersion!==3||!adIdentityReady(snapshot))throw new HttpError('apiError.pluginAd.agentTooOld',label);
 const directory=deviceDirectory(snapshot);
 if(!directory)throw new HttpError('apiError.pluginAd.noDirectory',label);
 const sessionHash=await mfaSessionHash(request,v),key=principal(v),time=now();
 await purge(time);
 const limited=await signInLimit(key,time);if(limited)throw limited;
 const parsed=parseAdAccount(input.account,directory,snapshot.hostname);
 if(!parsed.ok)throw parsed.code==='tooLong'?new HttpError('apiError.pluginAd.accountTooLong',{max:String(AD_ACCOUNT_MAX)}):parsed.code==='localOnDomain'?new HttpError('apiError.pluginAd.localOnDomain'):directory.kind==='local'?new HttpError('apiError.pluginAd.accountInvalidLocal',label):new HttpError('apiError.pluginAd.accountInvalid');
 if(typeof input.password!=='string'||input.password.length<1||input.password.length>AD_PASSWORD_MAX)throw new HttpError('apiError.pluginAd.passwordRequired');
 const waiting=Number((await db().one<{n:number}>(sql`SELECT count(*) AS n FROM jobs WHERE server_id=${device.id} AND state IN ('pending','running')`))?.n??0);
 if(waiting>=MAX_QUEUED_JOBS)throw queueFullError();
 // The password leaves this process only inside the box for this device's key.
 const sealed=await sealAgentSecrets({password:input.password},snapshot.publicKey);
 const jobId=crypto.randomUUID(),rowId=crypto.randomUUID();
 const parameters=JSON.stringify({plugin,account:parsed.account,secretParameters:sealed});
 const results=await commitAll([
  sql`SELECT pg_advisory_xact_lock(${adSignInLockClass}::integer,hashtext(${adAttemptBucket(key)}))`,
  sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal) SELECT ${jobId},${device.id},${AD_SIGN_IN},${`${plugin}/${parsed.account}`},${parameters},${jobDisplayInput(AD_SIGN_IN,parameters)},${time},${v.id},${v.label.trim().toLowerCase()},${key}
   WHERE ${featureDeviceGuard(v,device.id,[permission])} AND (SELECT count(*) FROM jobs WHERE server_id=${device.id} AND state IN ('pending','running'))<${MAX_QUEUED_JOBS}
   AND EXISTS (SELECT 1 FROM mfa_sessions WHERE token_hash=${sessionHash} AND idle_expires_at>${time} AND expires_at>${time})
   AND ${failuresBelowLimit(key,time)} AND NOT ${signInInFlight(key,time)}`,
  sql`INSERT INTO plugin_ad_sessions (id,principal,session_hash,state,source,job_id,server_id,directory_kind,directory_name,directory_sid,created_at)
   SELECT ${rowId},${key},${sessionHash},'pending','password',${jobId},${device.id},${directory.kind},${directoryLabel(directory)},${directory.sid},${time} WHERE EXISTS (SELECT 1 FROM jobs WHERE id=${jobId})`,
 ]);
 if(!results[1].rowCount||!results[2].rowCount)throw await signInLimit(key,time)??new HttpError('apiError.console.queueChanged');
 return {jobId};
}

/** The state of one own sign-in job for the dialog's poll. */
export type {AdSignInStatus};
export async function adSignInStatus(request:Request,v:Viewer,jobId:unknown):Promise<AdSignInStatus>{
 if(!guid(jobId))throw new HttpError('apiError.generic.notFound');
 const time=now();await purge(time);
 const job=await db().one<{state:string;result:string|null;result_code:string|null;result_args:string|null}>(sql`SELECT state,result,result_code,result_args FROM jobs WHERE id=${jobId} AND action=${AD_SIGN_IN} AND actor_principal=${principal(v)}`);
 if(!job)throw new HttpError('apiError.generic.notFound');
 const row=await db().one<SessionRow>(sql`SELECT * FROM plugin_ad_sessions WHERE job_id=${jobId} AND principal=${principal(v)}`);
 if(row?.state==='active')return {state:'active',session:view(row)};
 if(row?.state==='pending'&&(job.state==='pending'||job.state==='running'))return {state:'pending'};
 if(job.state==='failed'||job.state==='cancelled'||job.state==='expired'){
  let args:Record<string,string>|undefined;try{args=job.result_args?JSON.parse(job.result_args):undefined;}catch{args=undefined;}
  const code=job.result_code??(job.result?.startsWith('serverMessage.')?job.result:undefined);
  return {state:'failed',...(code?{code}:{}),...(args?{args}:{})};
 }
 // The row is gone (its portal session ended, or it waited too long) while the job still runs or has run.
 return {state:'failed',code:'serverMessage.job.adSignInEnded'};
}

/** The active sign-ins of the request's portal session only. */
export async function listAdSessions(request:Request,v:Viewer):Promise<AdSessionView[]>{
 const hash=await liveSessionHash(request,v);if(!hash)return [];
 const time=now();await purge(time);
 const rows=await db().query<SessionRow>(sql`SELECT * FROM plugin_ad_sessions WHERE session_hash=${hash} AND principal=${principal(v)} AND state='active' AND expires_at>${time} ORDER BY verified_at,id`);
 return rows.map(view);
}

/** sign-out: deletes one own sign-in of this portal session, with its portal audit row. */
export async function signOutAd(request:Request,v:Viewer,id:unknown){
 if(!guid(id))throw new HttpError('apiError.generic.notFound');
 const hash=await mfaSessionHash(request,v),time=now();
 const [result]=await commitAll([sql`WITH gone AS (DELETE FROM plugin_ad_sessions WHERE id=${id} AND session_hash=${hash} AND principal=${principal(v)} AND state='active' RETURNING directory_name,account)
  INSERT INTO audit (at,actor,action,target) SELECT ${time},${v.label},${adAuditActions.signOut},gone.directory_name || ' / ' || COALESCE(gone.account,'') FROM gone RETURNING target`]);
 if(!result.rowCount)throw new HttpError('apiError.generic.notFound');
 return {ok:true};
}

/**
 * The AD session of every target device of a plugin change: every
 * device reports PLUGIN_AD_IDENTITY (else agentTooOld with its name), then
 * each needs an active, unexpired session of this portal session for its
 * directory SID, else 403 PLUGIN_AD_SIGN_IN_REQUIRED naming the first device
 * without one. Answers the actAs per device ID. Writes nothing.
 */
export async function requireAdSessions(request:Request,v:Viewer,devices:readonly {device:Pick<DeviceRow,'id'|'name'>;snapshot:ServerSnapshot}[]):Promise<Map<string,AdActAs>>{
 for(const {device,snapshot} of devices)if(!adIdentityReady(snapshot))throw new HttpError('apiError.pluginAd.agentTooOld',{name:device.name});
 const hash=await mfaSessionHash(request,v),time=now();
 const rows=await db().query<SessionRow&{mfa_live:boolean}>(sql`SELECT p.*,${mfaLive(sql`p`,time)} AS mfa_live FROM plugin_ad_sessions p WHERE p.session_hash=${hash} AND p.principal=${principal(v)} AND p.state='active'`);
 const sessions=rows.map(row=>({...row,directorySid:row.directory_sid,expiresAt:row.expires_at===null?null:Number(row.expires_at),mfaLive:!!row.mfa_live}));
 const found=new Map<string,AdActAs>();
 for(const {device,snapshot} of devices){
  const directory=deviceDirectory(snapshot);
  if(!directory)throw new HttpError('apiError.pluginAd.noDirectory',{name:device.name});
  const session=adSessionFor(sessions,directory,time);
  if(!session||!session.user_sid||!session.account)throw new HttpError('apiError.pluginAd.signInRequired',{domain:directory.kind==='local'?device.name:directoryLabel(directory),serverId:device.id});
  found.set(device.id,adActAs({id:session.id,userSid:session.user_sid,account:session.account,upn:session.upn,directoryKind:session.directory_kind}));
 }
 return found;
}

/**
 * The claim guard of a plugin change: its actAs names an active,
 * unexpired session with the same user SID whose MFA session is alive and
 * that belongs to the portal user who queued the job (`actor`, the claim's
 * actor expression jobs.actor_principal). A plugin job that needs no account passes.
 */
export function adClaimGuard(time:number,actor:Sql):Sql{
 const operation=jsonText(sql`jobs.parameters`,'operation'),sessionId=jsonText(sql`jobs.parameters`,'actAs','sessionId'),userSid=jsonText(sql`jobs.parameters`,'actAs','userSid');
 return sql`(jobs.action<>${PLUGIN_JOB} OR NOT (${operation} IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(accountOperations)}::jsonb))) OR EXISTS (SELECT 1 FROM plugin_ad_sessions claim_ad WHERE claim_ad.id=${sessionId} AND claim_ad.user_sid=${userSid} AND claim_ad.principal=${actor} AND claim_ad.state='active' AND claim_ad.expires_at>${time} AND ${mfaLive(sql`claim_ad`,time)}))`;
}
/** Every plugin operation that needs the AD sign-in. */
const accountOperations=Object.keys(pluginOperations).filter(pluginOperationNeedsAccount);
/** Whether a pending plugin job may still be delivered: no account needed, or its AD session is alive and belongs to `actor` (the job's actor principal as SQL; null without an actor). */
export async function adClaimable(action:string,parameters:Record<string,unknown>,actor:Sql|null,time:number):Promise<boolean>{
 if(action!==PLUGIN_JOB||!pluginOperationNeedsAccount(parameters.operation))return true;
 const actAs=parameters.actAs as Partial<AdActAs>|undefined;
 if(!actor||!actAs||typeof actAs.sessionId!=='string'||typeof actAs.userSid!=='string')return false;
 return !!await db().one(sql`SELECT 1 AS live FROM plugin_ad_sessions claim_ad WHERE claim_ad.id=${actAs.sessionId} AND claim_ad.user_sid=${actAs.userSid} AND claim_ad.principal=${actor} AND claim_ad.state='active' AND claim_ad.expires_at>${time} AND ${mfaLive(sql`claim_ad`,time)}`);
}

// ---- The result of an ad-sign-in job ----------------------------------------------------------

const signInData=z.object({
 userSid:z.string().regex(AD_USER_SID),account:z.string().min(1).max(256).regex(/^[^\u0000-\u001f]+$/),upn:z.string().min(1).max(256).regex(/^[^\u0000-\u001f]+$/).nullable(),
 directory:z.object({kind:z.enum(['domain','local']),name:z.string().min(1).max(256),netbiosName:z.string().min(1).max(256),sid:z.string().regex(AD_DIRECTORY_SID)}).strict(),
}).strict();
type AgentResult={id:string;ok:boolean;message:string;code?:string;args?:Record<string,string>;data?:unknown};
/**
 * The result of an ad-sign-in job, in one transaction with the job
 * result. ok with valid data from the device's own directory turns the
 * pending row active (an older active row of the same portal session and
 * directory goes) and writes "AD sign-in". Anything else deletes the row,
 * fails the job and writes "AD sign-in failed"; a wrong password also counts
 * against the rate limit. A row that is no longer pending gets nothing.
 */
export async function ingestAdSignIn(device:{id:string;name:string},snapshot:ServerSnapshot,result:AgentResult,time:number,active:Sql){
 const job=await db().one<{actor_email:string|null;actor_principal:string|null;target:string;parameters:string}>(sql`SELECT actor_email,actor_principal,target,parameters FROM jobs WHERE id=${result.id} AND server_id=${device.id} AND state='running'`);
 if(!job)return;
 const row=await db().one<SessionRow>(sql`SELECT * FROM plugin_ad_sessions WHERE job_id=${result.id} AND state='pending' AND created_at>${time-AD_PENDING_LIFETIME_MS} AND ${mfaLive(sql`plugin_ad_sessions`,time)}`);
 const running=sql`EXISTS (SELECT 1 FROM jobs WHERE id=${result.id} AND server_id=${device.id} AND state='running') AND ${active}`;
 const typed=job.target.includes('/')?job.target.slice(job.target.indexOf('/')+1):job.target;
 const reported=deviceDirectory(snapshot);
 const data=result.ok?signInData.safeParse(result.data):null;
 const verified=!!(row&&data?.success&&reported&&data.data.directory.sid.toUpperCase()===reported.sid.toUpperCase()&&row.directory_sid.toUpperCase()===reported.sid.toUpperCase()&&data.data.directory.kind===row.directory_kind);
 const finish=(state:'succeeded'|'failed',message:string,code:string|null,args:Record<string,string>|null)=>sql`UPDATE jobs SET state=${state},result=${message},result_code=${code},result_args=${code&&args?JSON.stringify(args):null},parameters='{}',last_progress=${time} WHERE id=${result.id} AND server_id=${device.id} AND state='running' AND ${active}`;
 const actor=job.actor_email??'System';
 if(verified&&row&&data?.success){
  const identity=data.data;
  await commitAll([
   sql`DELETE FROM plugin_ad_sessions WHERE session_hash=${row.session_hash} AND directory_sid=${row.directory_sid} AND state='active' AND id<>${row.id} AND ${running}`,
   sql`UPDATE plugin_ad_sessions SET state='active',user_sid=${identity.userSid},account=${identity.account},upn=${identity.upn},verified_at=${time},server_id=${device.id},
    expires_at=LEAST(${time+AD_SESSION_LIFETIME_MS}::bigint,(SELECT expires_at FROM mfa_sessions WHERE token_hash=${row.session_hash})) WHERE id=${row.id} AND state='pending' AND ${running}`,
   sql`INSERT INTO audit (at,actor,action,target,server_id,scope) SELECT ${time},${actor},${adAuditActions.signIn},${`${device.name} / ${identity.account}`},${device.id},'device' WHERE ${running}`,
   finish('succeeded',result.message,result.code??null,result.args??null),
  ]);
  return;
 }
 // A wrong password counts for the portal principal, also when the row is gone.
 const key=row?.principal??job.actor_principal;
 const counted=!result.ok&&result.code==='AGENT_AD_SIGN_IN_FAILED'&&key?[adFailureStatement(key,time,running)]:[];
 const [message,code,args]:[string,string|null,Record<string,string>|null]=result.ok?[row?'serverMessage.job.adSignInMismatch':'serverMessage.job.adSignInEnded',null,null]:[result.message,result.code??null,result.args??null];
 await commitAll([
  ...(row?[sql`DELETE FROM plugin_ad_sessions WHERE id=${row.id} AND ${running}`]:[]),
  ...counted,
  sql`INSERT INTO audit (at,actor,action,target,server_id,scope) SELECT ${time},${actor},${adAuditActions.failed},${`${device.name} / ${row?.account??typed}`},${device.id},'device' WHERE ${running}`,
  finish('failed',message,code,args),
 ]);
}

// ---- Entra ID ---------------------------------------------------------------------------------

/**
 * The AD session of a hybrid Entra user: built and tested now, wired
 * by the Entra sign-in. Creates an active row with source entra
 * for the directory of the user's on-premises SID, replacing an older active
 * row of the same portal session and directory. Null without the SID or the
 * domain; then the user signs in with the password dialog as before.
 */
export async function openDirectoryAdSession(input:{sessionHash:string;principal:string;mfaExpiresAt:number}&EntraOnPremises):Promise<AdSessionView|null>{
 const identity=entraAdIdentity(input);if(!identity)return null;
 const time=now(),id=crypto.randomUUID(),directory:AdDirectory=identity.directory;
 const live=sql`EXISTS (SELECT 1 FROM mfa_sessions WHERE token_hash=${input.sessionHash} AND principal=${input.principal} AND idle_expires_at>${time} AND expires_at>${time})`;
 const results=await commitAll([
  sql`DELETE FROM plugin_ad_sessions WHERE session_hash=${input.sessionHash} AND directory_sid=${directory.sid} AND state='active' AND ${live}`,
  sql`INSERT INTO plugin_ad_sessions (id,principal,session_hash,state,source,directory_kind,directory_name,directory_sid,user_sid,account,upn,created_at,verified_at,expires_at)
   SELECT ${id},${input.principal},${input.sessionHash},'active','entra',${directory.kind},${directory.name},${directory.sid},${identity.userSid},${identity.account},${identity.upn},${time},${time},${adSessionExpiry(time,input.mfaExpiresAt)} WHERE ${live}`,
 ]);
 if(!results[1].rowCount)return null;
 return {id,directory:{kind:directory.kind,name:directory.name,sid:directory.sid},account:identity.account,upn:identity.upn,source:'entra',verifiedAt:time,expiresAt:adSessionExpiry(time,input.mfaExpiresAt)};
}
