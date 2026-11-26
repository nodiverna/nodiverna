import {requireIdentity,sameOrigin,body,failure,HttpError,now,guid,log,hash} from '../context';
import {requireDevice,principal,devicePermissionGuard,mfaAnchorSql} from '../identity/access';
import {can,canSql} from '../identity/policy/can';
import {primaryMfaSessionGuard,featureWriteGuard} from '../identity/feature-authorization';
import {requireMfa,mfaSessionHash} from '../identity/mfa';
import {prepareManagementAuthorization} from '../identity/rbac';
import {terminalActionNeedsStepUp} from '../../step-up';
import {modern,lease,releaseLease,pendingWork,pendingTransfers,snapshot} from '../agent/agent-protocol';
import {MAX_TERMINALS,TERMINAL_PRESENCE_GRACE_MS,TERMINAL_ABSOLUTE_LIFETIME_MS,terminalIsActive,touchTerminalPresence,sweepTerminalSessions,terminalWriteGuard,terminalAccessGuard,type TerminalSession} from './terminal-lifecycle';
import {commitAll,db,sql} from '../db';
import {accountNamesOf} from '../identity/account-names';

// The browser side of SYSTEM terminals (app/api/terminal): listing, opening,
// input, resize, presence and closing. The route only delegates here.

type Viewer=Awaited<ReturnType<typeof requireIdentity>>;
const headers={'Cache-Control':'no-store'};
const activeStates=sql`state IN ('opening','open')`;
async function session(id:unknown,v:Viewer,allowAdminClose=false){
 if(!guid(id))throw new HttpError('apiError.terminal.invalidSession');
 const s=await db().one<TerminalSession>(sql`SELECT * FROM terminal_sessions WHERE id=${id}`);
 if(!s||s.principal!==principal(v)&&!(allowAdminClose&&await can(v,'instance.owner')))throw new HttpError('apiError.terminal.sessionNotFound');
 await requireDevice(v,s.server_id,'terminal');return s;
}
function presence(s:TerminalSession){return {id:s.id,state:s.state,expiresAt:s.expires_at,lastActivity:s.last_activity,presenceExpiresAt:Math.min(s.expires_at,s.last_activity+TERMINAL_PRESENCE_GRACE_MS),presenceGraceMs:TERMINAL_PRESENCE_GRACE_MS};}
async function ownLive(serverId:string,v:Viewer){const time=now();return db().one<TerminalSession>(sql`SELECT * FROM terminal_sessions WHERE server_id=${serverId} AND principal=${principal(v)} AND ${activeStates} AND expires_at>${time} AND last_activity>=${time-TERMINAL_PRESENCE_GRACE_MS} ORDER BY created_at DESC LIMIT 1`);}
async function resumed(s:TerminalSession,multiuser:boolean,v:Viewer){
 await touchTerminalPresence(s.id,now(),v);const current=await db().one<TerminalSession>(sql`SELECT * FROM terminal_sessions WHERE id=${s.id}`);
 if(!current||!terminalIsActive(current))throw new HttpError('apiError.terminal.sessionEnded');
 return Response.json({...presence(current),ack:current.input_ack,inputSeq:current.input_seq,resumed:true,multiuser,maxSessions:multiuser?MAX_TERMINALS:1},{headers});
}
const exclusiveLease=(serverId:string,time:number)=>sql`SELECT l.owner_id FROM device_leases l LEFT JOIN jobs j ON j.id=l.owner_id AND j.server_id=l.server_id WHERE l.server_id=${serverId} AND l.expires_at>${time} AND l.owner_kind<>'terminal' AND (l.owner_kind<>'job' OR j.action='agent-update' OR j.id IS NULL)`;
async function maintenance(serverId:string,time:number){
 return (await db().one(sql`SELECT id FROM jobs WHERE server_id=${serverId} AND action='agent-update' AND state='running' LIMIT 1`))??(await db().one(sql`${exclusiveLease(serverId,time)} LIMIT 1`));
}

export async function terminalGet(request:Request){try{
 const v=await requireIdentity(),q=new URL(request.url).searchParams,id=q.get('id');await requireMfa(request,v);
 if(!id){
  const serverId=q.get('serverId')??'',d=await requireDevice(v,serverId,'terminal');await sweepTerminalSessions(serverId);
  const [own,active]=await Promise.all([
   db().query(sql`SELECT id,state,created_at AS "createdAt",expires_at AS "expiresAt",input_seq AS "inputSeq",input_ack AS ack,error FROM terminal_sessions WHERE server_id=${serverId} AND principal=${principal(v)} ORDER BY created_at DESC LIMIT 5`).then(results=>({results})),
   db().query<Pick<TerminalSession,'id'|'principal'|'state'|'created_at'|'last_activity'|'expires_at'>>(sql`SELECT id,principal,state,created_at,last_activity,expires_at FROM terminal_sessions WHERE server_id=${serverId} AND ${activeStates} ORDER BY created_at LIMIT ${MAX_TERMINALS}`).then(results=>({results})),
  ]);
  const instanceOwner=await can(v,'instance.owner'),owners=await accountNamesOf(active.results.map(s=>s.principal)),activeSessions=active.results.map(s=>({id:s.id,state:s.state,owner:owners.get(s.principal)??null,createdAt:s.created_at,lastActivity:s.last_activity,expiresAt:s.expires_at,isOwn:s.principal===principal(v),canClose:s.principal===principal(v)||instanceOwner}));
  const multiuser=!!snapshot(d)?.agentCapabilities?.includes('terminal-multi');
  return Response.json({sessions:own.results,activeSessions,presenceGraceMs:TERMINAL_PRESENCE_GRACE_MS,maxSessions:multiuser?MAX_TERMINALS:1,multiuser},{headers});
 }
 const previous=await session(id,v),after=Number(q.get('after')??0);if(!Number.isSafeInteger(after)||after<0)throw new HttpError('apiError.terminal.invalidCursor');
 await touchTerminalPresence(id,now(),v);await sweepTerminalSessions(previous.server_id);
 const s=await db().one<TerminalSession>(sql`SELECT * FROM terminal_sessions WHERE id=${id}`);if(!s)throw new HttpError('apiError.terminal.sessionNotFound');
 const outputGuard=featureWriteGuard(v,terminalAccessGuard('t'));
 const [r,first]=await Promise.all([
  db().query<{seq:number;data:string}>(sql`SELECT f.seq,f.data FROM terminal_frames f JOIN terminal_sessions t ON t.id=f.session_id WHERE f.session_id=${id} AND f.direction='out' AND f.seq>${after} AND ${outputGuard} ORDER BY f.seq LIMIT 64`).then(results=>({results})),
  db().one<{seq:number|null}>(sql`SELECT MIN(seq) AS seq FROM terminal_frames WHERE session_id=${id} AND direction='out'`),
 ]);
 return Response.json({...presence(s),ack:s.input_ack,inputSeq:s.input_seq,cursor:r.results.at(-1)?.seq??after,frames:r.results,error:s.error,truncated:first?.seq!=null&&first.seq>after+1},{headers});
 }catch(e){return failure(e);}}

export async function terminalPost(request:Request){try{
 sameOrigin(request);const p=await body(request,65536),v=await requireIdentity(),time=now();
 // Closing the caller's own shell needs no fresh MFA proof. Navigation cleanup
 // must still work after proof expiry; ownership and device rights remain.
 if(p.action!=='close')await requireMfa(request,v);
 if(p.action==='open'){
  const d=await requireDevice(v,p.serverId,'terminal'),snap=modern(d,'terminal'),multiuser=!!snap.agentCapabilities?.includes('terminal-multi');
  if(!d.management||snap.mode!=='Management')throw new HttpError('apiError.terminal.managementRequired');
  if(p.confirm!==true)throw new HttpError('apiError.terminal.confirmSystem');
  await sweepTerminalSessions(d.id,time);
  const proof=await mfaSessionHash(request,v);
  const own=await ownLive(d.id,v);if(own)return resumed(own,multiuser,v);
  if(multiuser){if(await maintenance(d.id,time))throw new HttpError('apiError.terminal.finishMaintenance');}
  else if(await pendingWork(d.id)||await pendingTransfers(d.id))throw new HttpError('apiError.terminal.finishJobs');
  // A new SYSTEM shell is unrestricted execution and needs a fresh step-up proof
  // (lib/step-up.ts). Resuming the caller's own live shell above needs none.
  // The proof is part of the insert's admission and consumed in its batch.
  const stepUp=terminalActionNeedsStepUp(p.action)?await prepareManagementAuthorization(request,v,p.managementToken):null,stepUpGuard=stepUp?stepUp.guard:sql`TRUE`;
  const id=crypto.randomUUID(),cols=Math.round(Math.min(300,Math.max(20,Number(p.cols)||100))),rows=Math.round(Math.min(100,Math.max(5,Number(p.rows)||30))),expires=time+TERMINAL_ABSOLUTE_LIFETIME_MS;
  if(!multiuser)await lease(d.id,'terminal',id,expires);
  try{
   // Guard the insertion itself, not a separate count: simultaneous requests
   // cannot exceed four sessions or open a second shell for one principal.
   const admission=featureWriteGuard(v,devicePermissionGuard(sql`caller.server_id`,sql`caller.principal`,'terminal')),primary=primaryMfaSessionGuard(sql`caller.principal`,sql`guard_session.token_hash`,time);
   const me=principal(v),opening=sql`INSERT INTO terminal_sessions (id,server_id,principal,mfa_hash,state,cols,rows,created_at,last_activity,expires_at) SELECT ${id},${d.id},${me},${proof},'opening',${cols},${rows},${time},${time},${expires} FROM (SELECT ${d.id}::text AS server_id,${me}::text AS principal) caller WHERE ${admission} AND EXISTS (SELECT 1 FROM mfa_sessions guard_session WHERE ${mfaAnchorSql(sql`guard_session.principal`)} AND guard_session.token_hash=${proof} AND guard_session.principal=caller.principal AND guard_session.idle_expires_at>${time} AND guard_session.expires_at>${time} AND (${primary})) AND EXISTS (SELECT 1 FROM servers WHERE id=${d.id} AND revoked=0) AND NOT EXISTS (SELECT 1 FROM terminal_sessions WHERE server_id=${d.id} AND principal=${me} AND ${activeStates} AND expires_at>${time}) AND (SELECT COUNT(*) FROM terminal_sessions WHERE server_id=${d.id} AND ${activeStates} AND expires_at>${time})<${multiuser?MAX_TERMINALS:1} AND NOT EXISTS (SELECT 1 FROM jobs WHERE server_id=${d.id} AND action='agent-update' AND state='running') AND NOT EXISTS (${exclusiveLease(d.id,time)}) AND (${stepUpGuard})`;
   // The proof row is deleted only when the session row was created; a refused
   // insert (session limit, maintenance, rights) leaves it for a retry.
   const results=stepUp?await commitAll([
    sql`SELECT 1 AS confirmed WHERE ${stepUp.guard}`,
    opening,
    sql`DELETE FROM mfa_management_proofs WHERE token_hash=${stepUp.tokenHash} AND principal=${stepUp.key} AND session_hash=${stepUp.sessionHash} AND EXISTS (SELECT 1 FROM terminal_sessions WHERE id=${id})`,
   ]):null,inserted=results?results[1]:await db().exec(opening);
   if(!inserted.rowCount){if(!multiuser)await releaseLease(id);if(results&&!results[0].rows.length)throw new HttpError('apiError.mfa.proofExpired');await requireDevice(v,d.id,'terminal');const concurrent=await ownLive(d.id,v);if(concurrent)return resumed(concurrent,multiuser,v);throw new HttpError(multiuser?'apiError.terminal.limitMultiuser':'apiError.terminal.agentBusy');}
   if(!multiuser&&(await pendingWork(d.id)||await pendingTransfers(d.id))){await db().exec(sql`UPDATE terminal_sessions SET state='closed',error='serverMessage.terminal.deviceHasJob' WHERE id=${id}`);await releaseLease(id);throw new HttpError('apiError.terminal.deviceHasJob');}
  }catch(e){if(!multiuser)await releaseLease(id);throw e;}
  await log(v.label,'SYSTEM-Terminal geöffnet',id,d.id);
  return Response.json({id,state:'opening',expiresAt:expires,lastActivity:time,presenceExpiresAt:time+TERMINAL_PRESENCE_GRACE_MS,presenceGraceMs:TERMINAL_PRESENCE_GRACE_MS,ack:0,inputSeq:0,resumed:false,multiuser,maxSessions:multiuser?MAX_TERMINALS:1},{headers});
 }
 const s=await session(p.id,v,p.action==='close');
 if(p.action!=='close')await sweepTerminalSessions(s.server_id,time);
 if(p.action==='close'){
  if(s.principal!==principal(v))await requireMfa(request,v);
  if(s.principal!==principal(v)&&p.confirm!==true)throw new HttpError('apiError.terminal.confirmCloseForeign');
  const owner=canSql(sql`closing_actor.principal`,'instance.owner'),device=featureWriteGuard(v,devicePermissionGuard(sql`terminal_sessions.server_id`,sql`closing_actor.principal`,'terminal'));
  const closed=await db().exec(sql`UPDATE terminal_sessions SET state='closed',last_activity=${time},error=CASE WHEN principal<>${principal(v)} THEN 'Durch Administrator geschlossen' ELSE error END WHERE id=${s.id} AND EXISTS (SELECT 1 FROM (SELECT ${principal(v)}::text AS principal) closing_actor WHERE (terminal_sessions.principal=closing_actor.principal OR (${owner})) AND (${device}))`);
  if(!closed.rowCount)throw new HttpError('apiError.terminal.rightChanged');
  await releaseLease(s.id);await log(v.label,s.principal===principal(v)?'Terminal geschlossen':'Fremdes Terminal als Administrator geschlossen',s.id,s.server_id);return Response.json({ok:true},{headers});
 }
 if(p.action==='heartbeat'){
  await touchTerminalPresence(s.id,time,v);await sweepTerminalSessions(s.server_id,time);const current=await db().one<TerminalSession>(sql`SELECT * FROM terminal_sessions WHERE id=${s.id}`);
  if(!current||!terminalIsActive(current,time))throw new HttpError('apiError.terminal.sessionEnded');return Response.json({ok:true,...presence(current)},{headers});
 }
 if(!terminalIsActive(s,time))throw new HttpError('apiError.terminal.sessionEnded');
 if(!['input','resize'].includes(p.action)||!Number.isSafeInteger(p.seq)||p.seq<1)throw new HttpError('apiError.terminal.invalidInput');
 const data=p.action==='input'?{kind:'input',data:typeof p.data==='string'?p.data:''}:{kind:'resize',cols:Math.round(Math.min(300,Math.max(20,Number(p.cols)||100))),rows:Math.round(Math.min(100,Math.max(5,Number(p.rows)||30)))};
 if('data'in data&&new TextEncoder().encode(data.data).length>32768)throw new HttpError('apiError.terminal.inputTooLarge');
 const serialized=JSON.stringify(data),digest=await hash(serialized),admittedAt=now(),cutoff=admittedAt-TERMINAL_PRESENCE_GRACE_MS;
 // Every admission guard participates in one database transaction. A concurrent
 // close cannot enqueue an orphaned input, and duplicate requests cannot
 // advance the sequence or fail with a unique-index error.
 const writeGuard=featureWriteGuard(v,terminalWriteGuard('terminal_sessions',admittedAt)),receiptGuard=featureWriteGuard(v,terminalWriteGuard('s',admittedAt));
 const accepted=await commitAll([
  sql`INSERT INTO terminal_frames (id,session_id,direction,seq,data,created_at) SELECT ${s.id+':in:'+p.seq},id,'in',${p.seq},${serialized},${admittedAt} FROM terminal_sessions WHERE id=${s.id} AND state IN ('opening','open') AND expires_at>${admittedAt} AND last_activity>=${cutoff} AND ${writeGuard} AND input_seq=${p.seq-1} AND input_seq-input_ack<128 AND NOT EXISTS (SELECT 1 FROM terminal_frames r WHERE r.session_id=terminal_sessions.id AND r.direction='in-receipt' AND r.seq=${p.seq} AND r.data<>${digest}) ON CONFLICT(session_id,direction,seq) DO NOTHING`,
  sql`UPDATE terminal_sessions SET input_seq=${p.seq},last_activity=${admittedAt} WHERE id=${s.id} AND state IN ('opening','open') AND expires_at>${admittedAt} AND last_activity>=${cutoff} AND ${writeGuard} AND input_seq=${p.seq-1} AND input_seq-input_ack<128 AND EXISTS (SELECT 1 FROM terminal_frames f WHERE f.session_id=terminal_sessions.id AND f.direction='in' AND f.seq=${p.seq} AND f.data=${serialized}) AND NOT EXISTS (SELECT 1 FROM terminal_frames r WHERE r.session_id=terminal_sessions.id AND r.direction='in-receipt' AND r.seq=${p.seq} AND r.data<>${digest})`,
  // Only hashes survive agent ACK deletion of input frames. Receipts are
  // neither terminal input nor output, and retain at most the latest 256.
  sql`INSERT INTO terminal_frames (id,session_id,direction,seq,data,created_at) SELECT ${s.id+':in-receipt:'+p.seq},s.id,'in-receipt',${p.seq},${digest},${admittedAt} FROM terminal_sessions s WHERE s.id=${s.id} AND s.state IN ('opening','open') AND s.expires_at>${admittedAt} AND s.last_activity>=${cutoff} AND ${receiptGuard} AND s.input_seq>=${p.seq} AND EXISTS (SELECT 1 FROM terminal_frames f WHERE f.session_id=s.id AND f.direction='in' AND f.seq=${p.seq} AND f.data=${serialized}) ON CONFLICT(session_id,direction,seq) DO NOTHING`,
  sql`DELETE FROM terminal_frames WHERE session_id=${s.id} AND direction='in-receipt' AND seq<=(SELECT input_seq-256 FROM terminal_sessions WHERE id=${s.id})`,
  sql`SELECT s.state,s.expires_at,s.last_activity,s.input_seq,s.input_ack,(SELECT f.data FROM terminal_frames f WHERE f.session_id=s.id AND f.direction='in' AND f.seq=${p.seq}) AS frame_data,(SELECT r.data FROM terminal_frames r WHERE r.session_id=s.id AND r.direction='in-receipt' AND r.seq=${p.seq}) AS receipt FROM terminal_sessions s WHERE s.id=${s.id}`,
 ]);
 const current=accepted.at(-1)?.rows[0] as (Pick<TerminalSession,'state'|'expires_at'|'last_activity'|'input_seq'|'input_ack'>&{frame_data:string|null;receipt:string|null})|undefined;
 if(!current||!terminalIsActive(current,admittedAt))throw new HttpError('apiError.terminal.sessionEnded');
 if(current.receipt===digest&&current.input_seq>=p.seq)return Response.json({ok:true,seq:p.seq,ack:current.input_ack},{headers});
 // The four sequence conflicts share the catalog text; the comment names each reason.
 // The sequence number is already taken by different input.
 if(current.receipt!==null&&current.receipt!==digest||current.frame_data!==null&&current.frame_data!==serialized)throw new HttpError('apiError.terminal.sequenceConflict');
 // Already acknowledged; the original content can no longer be compared.
 if(p.seq<=current.input_ack)throw new HttpError('apiError.terminal.sequenceConflict');
 // Not the next sequence number.
 if(p.seq!==current.input_seq+1)throw new HttpError('apiError.terminal.sequenceConflict');
 if(current.input_seq-current.input_ack>=128)throw new HttpError('apiError.terminal.inputPending');
 // The input could not be admitted safely.
 throw new HttpError('apiError.terminal.sequenceConflict');
 }catch(e){return failure(e);}}
