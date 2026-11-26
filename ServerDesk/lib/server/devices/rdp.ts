import {z} from 'zod';
import {hash,HttpError,now} from '../context';
import type {ApiErrorKey} from '../../errors/api-error-keys';
import {principal,requireDevice,devicePermissionGuard,mfaAnchorSql} from '../identity/access';
import {can,canSql} from '../identity/policy/can';
import {primaryMfaSessionGuard,featureWriteGuard} from '../identity/feature-authorization';
import {mfaSessionHash} from '../identity/mfa';
import {modern,snapshot,type AgentDevice} from '../agent/agent-protocol';
import type {Viewer} from '../../types';
import {REMOTE_DESKTOP_AVAILABLE} from '../../rdp-feature';
import {serverMessage,type ServerMessageKey} from '../../server-messages';

/** Why browser RDP is unavailable, as a display text for the client; null when it is available. */
const availabilityReason=(key:ServerMessageKey|null)=>key?serverMessage(key):null;
import {commitAll,db,jsonArrayText,jsonPath,jsonText,sql,type Sql,type Step} from '../db';
import {accountNamesOf} from '../identity/account-names';

export const RDP_MAX_SESSIONS=2,RDP_PRESENCE_MS=45_000,RDP_LIFETIME_MS=7_200_000,RDP_FRAME_TTL_MS=45_000,RDP_CREDIT=64,RDP_BATCH=16;
export const RDP_RTC_LEASE_MS=15_000;
export const rdpId=z.guid().refine(value=>value===value.toLowerCase(),'Canonical session UUID required');
const sequence=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// Standard, canonical base64; 16-byte GCM tag plus at most 16 KiB plaintext.
const encoded=z.string().max(21_868).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).refine(value=>{try{const bytes=atob(value);return bytes.length>=17&&bytes.length<=16_400&&btoa(bytes)===value;}catch{return false;}});
export const rdpFrame=z.object({seq:sequence.refine(value=>value>0),data:encoded}).strict();
export const rdpBrowserExchange=z.object({action:z.literal('exchange'),id:rdpId,ack:sequence,frames:z.array(rdpFrame).max(RDP_BATCH).refine(frames=>new Set(frames.map(frame=>frame.seq)).size===frames.length),receive:z.boolean().optional()}).strict();
export const rdpBrowserReceive=z.object({action:z.literal('receive'),id:rdpId,ack:sequence,inputAck:sequence.optional(),waitMs:z.number().int().min(0).max(600).optional()}).strict();
// Canonical ciphertext only. SDP stays encrypted between browser and device.
export const rdpRtcDescription=z.string().max(65_536).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).refine(value=>{try{const bytes=atob(value);return bytes.length>=17&&bytes.length<=49_152&&btoa(bytes)===value;}catch{return false;}});
export const rdpBrowserSignal=z.object({action:z.literal('signal'),id:rdpId}).strict();
export const rdpReport=z.object({id:rdpId,state:z.enum(['opening','open','closed','error']),inputAck:sequence,output:z.array(rdpFrame).max(RDP_BATCH).refine(frames=>new Set(frames.map(frame=>frame.seq)).size===frames.length).default([]),error:z.string().max(500).optional(),transport:z.literal('webrtc').optional(),answer:rdpRtcDescription.optional()}).strict().superRefine((report,ctx)=>{
 if(report.transport==='webrtc'&&(report.inputAck!==0||report.output.length))ctx.addIssue({code:z.ZodIssueCode.custom,message:'WebRTC reports contain no mailbox payloads'});
 if(report.answer&&report.transport!=='webrtc')ctx.addIssue({code:z.ZodIssueCode.custom,message:'WebRTC answer requires direct transport'});
});
export type RdpFrame=z.infer<typeof rdpFrame>;
export type RdpReport=z.infer<typeof rdpReport>;
export type RdpSession={id:string;server_id:string;principal:string;mfa_hash:string;state:string;transport:'mailbox'|'webrtc';key_envelope:string|null;key_hash:string;input_seq:number;input_ack:number;output_seq:number;output_ack:number;created_at:number;last_presence:number;expires_at:number;error:string|null};
const activeOf=(alias?:string):Sql=>alias?sql`${sql.ident(alias)}.state IN ('opening','open')`:sql`state IN ('opening','open')`,active=activeOf();

// All writes and dispatch reads use the live database authorization, not a
// Viewer or proof deadline captured before concurrent revocation/offboarding.
export function rdpWriteGuard(alias:string,time=now()){
 const a=sql.ident(alias),authorization=devicePermissionGuard(sql`${a}.server_id`,sql`${a}.principal`,'rdp'),primary=primaryMfaSessionGuard(sql`${a}.principal`,sql`${a}.mfa_hash`,time);
 return sql`${activeOf(alias)} AND ${REMOTE_DESKTOP_AVAILABLE?sql`TRUE`:sql`FALSE`} AND ${a}.expires_at>${time} AND ${a}.last_presence>=${time}::bigint-CASE WHEN ${a}.transport='webrtc' THEN ${RDP_RTC_LEASE_MS}::bigint ELSE ${RDP_PRESENCE_MS}::bigint END
 AND EXISTS (SELECT 1 FROM servers d WHERE d.id=${a}.server_id AND d.revoked=0 AND d.management=1 AND d.last_seen>${time-120_000} AND ${jsonText(sql`d.snapshot`,'mode')}='Management' AND ${jsonText(sql`d.snapshot`,'protocolVersion')}='3' AND EXISTS (SELECT 1 FROM ${jsonArrayText(jsonPath(sql`d.snapshot`,'agentCapabilities'))} AS capability(value) WHERE capability.value=CASE WHEN ${a}.transport='webrtc' THEN 'rdp-webrtc' ELSE 'rdp-browser' END))
 AND EXISTS (SELECT 1 FROM mfa_sessions m WHERE ${mfaAnchorSql(sql`m.principal`)} AND m.token_hash=${a}.mfa_hash AND m.principal=${a}.principal AND m.idle_expires_at>${time} AND m.expires_at>${time})
 AND (${authorization}) AND (${primary})
 AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.server_id=${a}.server_id AND j.action='agent-update' AND j.state='running')
 AND NOT EXISTS (SELECT 1 FROM device_leases l LEFT JOIN jobs j ON j.id=l.owner_id AND j.server_id=l.server_id WHERE l.server_id=${a}.server_id AND l.expires_at>${time} AND l.owner_kind<>'terminal' AND (l.owner_kind<>'job' OR j.action='agent-update' OR j.id IS NULL))
 AND NOT EXISTS (SELECT 1 FROM rdp_frames f WHERE f.session_id=${a}.id AND f.created_at<${time-RDP_FRAME_TTL_MS})`;
}
function live(id:string,time=now(),v?:Viewer) {const current=rdpWriteGuard('r',time),guard=v?featureWriteGuard(v,current):current;return sql`EXISTS (SELECT 1 FROM rdp_sessions r WHERE r.id=${id} AND ${guard})`;}
export async function closeRdp(id:string,error:string|null=null){await commitAll([
 sql`UPDATE rdp_sessions SET state=CASE WHEN state='error' THEN state ELSE 'closed' END,key_envelope=NULL,error=coalesce(${error},error) WHERE id=${id}`,
 sql`DELETE FROM rdp_frames WHERE session_id=${id}`,sql`DELETE FROM rdp_receipts WHERE session_id=${id}`
]);}
// Browser-initiated close rechecks both exact device rights and ownership in
// the transaction. A captured former Owner cannot close another user's session.
export async function closeAuthorizedRdp(v:Viewer,id:string,error:string|null=null){
 const owner=canSql(sql`closing_actor.principal`,'instance.owner'),device=devicePermissionGuard(sql`closing_session.server_id`,sql`closing_actor.principal`,'rdp');
 const authorization=featureWriteGuard(v,sql`EXISTS (SELECT 1 FROM rdp_sessions closing_session CROSS JOIN (SELECT ${principal(v)}::text AS principal) closing_actor WHERE closing_session.id=${id} AND (closing_session.principal=closing_actor.principal OR (${owner})) AND (${device}))`);
 const result=await commitAll([
  sql`UPDATE rdp_sessions SET state=CASE WHEN state='error' THEN state ELSE 'closed' END,key_envelope=NULL,error=coalesce(${error},error) WHERE id=${id} AND ${authorization}`,
  sql`DELETE FROM rdp_frames WHERE session_id=${id} AND ${authorization}`,
  sql`DELETE FROM rdp_receipts WHERE session_id=${id} AND ${authorization}`
 ]);
 if(!result[0].rowCount)throw new HttpError('apiError.rdp.rightChanged');
}
export async function sweepRdp(serverId?:string,time=now()){
 const guard=rdpWriteGuard('rdp_sessions',time),scope=serverId?sql` AND server_id=${serverId}`:sql``;
 await commitAll([
 sql`UPDATE rdp_sessions SET state='closed',key_envelope=NULL,error=coalesce(error,${REMOTE_DESKTOP_AVAILABLE?'serverMessage.rdp.expired':'serverMessage.rdp.paused'}) WHERE ${active}${scope} AND (NOT (${guard}) OR EXISTS (SELECT 1 FROM rdp_frames f WHERE f.session_id=rdp_sessions.id AND f.created_at<${time-RDP_FRAME_TTL_MS}))`,
 sql`DELETE FROM rdp_frames WHERE session_id IN (SELECT id FROM rdp_sessions WHERE state IN ('closed','error')${scope})`,
 sql`DELETE FROM rdp_receipts WHERE session_id IN (SELECT id FROM rdp_sessions WHERE state IN ('closed','error')${scope})`,
 sql`UPDATE rdp_sessions SET key_envelope=NULL WHERE state IN ('closed','error')${scope}`,
 // History consists only of nonsecret metadata. No screenshot or recording.
 sql`DELETE FROM rdp_sessions WHERE state IN ('closed','error') AND expires_at<${time-86_400_000}${scope}`
 ]);
}
export async function ownedRdp(id:string,v:Viewer,adminClose=false){
 const row=await db().one<RdpSession>(sql`SELECT * FROM rdp_sessions WHERE id=${id}`);
 if(!row||row.principal!==principal(v)&&!(adminClose&&await can(v,'instance.owner')))throw new HttpError('apiError.rdp.sessionNotFound');
 await requireDevice(v,row.server_id,'rdp');return row;
}
/** One session for the browser. owner: the account's name (lib/server/identity/account-names.ts), null when none can be resolved; never the principal. */
function metadata(s:RdpSession,v:Viewer,instanceOwner:boolean,owners:Map<string,string|null>){return {id:s.id,state:s.state,transport:s.transport,createdAt:s.created_at,expiresAt:s.expires_at,lastActivity:s.last_presence,owner:owners.get(s.principal)??null,isOwn:s.principal===principal(v),canClose:s.principal===principal(v)||instanceOwner,error:s.error};}
export async function rdpMetadata(serverId:string,v:Viewer){
 const d=await requireDevice(v,serverId,'rdp');await sweepRdp(serverId);const s=snapshot(d),time=now();
 const instanceOwner=await can(v,'instance.owner'),rows=await db().query<RdpSession>(sql`SELECT * FROM rdp_sessions WHERE server_id=${d.id} AND (principal=${principal(v)} OR ${active}) ORDER BY created_at DESC LIMIT 12`).then(results=>({results})),owners=await accountNamesOf(rows.results.map(r=>r.principal));
 const online=!!d.last_seen&&d.last_seen>time-120_000,capable=s?.agentCapabilities.includes('rdp-browser')===true,management=d.management===1&&s?.mode==='Management',rdp=s?.rdp;
 return {hostname:s?.hostname??null,publicKey:s?.publicKey??null,sessions:rows.results.filter(r=>r.principal===principal(v)).slice(0,5).map(r=>metadata(r,v,instanceOwner,owners)),activeSessions:rows.results.filter(r=>['opening','open'].includes(r.state)).map(r=>metadata(r,v,instanceOwner,owners)),availability:{available:REMOTE_DESKTOP_AVAILABLE,featureStatus:REMOTE_DESKTOP_AVAILABLE?'available':'paused',online,capable,webrtcCapable:s?.agentCapabilities.includes('rdp-webrtc')===true,management,enabled:rdp?.enabled??s?.security?.rdpEnabled??false,nla:rdp?.nla??null,port:rdp?.port??null,policyBlocked:rdp?.policyBlocked??false,reason:availabilityReason(!REMOTE_DESKTOP_AVAILABLE?'serverMessage.rdp.paused':!online?'serverMessage.rdp.offline':!capable?'serverMessage.rdp.agentRequired':!management?'serverMessage.rdp.managementRequired':rdp?.policyBlocked?'serverMessage.rdp.policyBlocked':rdp?.nla===false?'serverMessage.rdp.nlaRequired':!(rdp?.enabled??s?.security?.rdpEnabled)?'serverMessage.rdp.disabledOnWindows':null)},maxSessions:RDP_MAX_SESSIONS};
}
export async function openRdp(request:Request,v:Viewer,id:string,serverId:string,keyEnvelope:string,rtc?:{transport:'webrtc';offer:string}){
 const d=await requireDevice(v,serverId,'rdp');
 if(!REMOTE_DESKTOP_AVAILABLE)throw new HttpError('apiError.rdp.paused');
 const transport=rtc?'webrtc':'mailbox',s=modern(d,rtc?'rdp-webrtc':'rdp-browser');
 if(!d.management||s.mode!=='Management')throw new HttpError('apiError.rdp.managementRequired');
 if(s.rdp?.nla===false)throw new HttpError('apiError.rdp.nlaRequired');
 if(s.rdp?.policyBlocked||!(s.rdp?.enabled??s.security?.rdpEnabled))throw new HttpError(s.rdp?.policyBlocked?'apiError.rdp.policyBlocked':'apiError.rdp.disabledOnWindows');
 if(!s.publicKey||s.publicKey.kty!=='RSA'||!/^[A-Za-z0-9_-]{342}$/.test(s.publicKey.n)||s.publicKey.e!=='AQAB')throw new HttpError('apiError.rdp.deviceKeyMissing');
 const proof=await mfaSessionHash(request,v),keyHash=await hash(keyEnvelope),time=now();await sweepRdp(d.id,time);
 const previous=await db().one<RdpSession>(sql`SELECT * FROM rdp_sessions WHERE id=${id}`);
 if(previous){if(previous.server_id!==d.id||previous.principal!==principal(v)||previous.key_hash!==keyHash||previous.mfa_hash!==proof||previous.transport!==transport)throw new HttpError('apiError.rdp.sessionIdUsedNewKey');if(!['opening','open'].includes(previous.state))throw new HttpError('apiError.rdp.sessionEndedStartNew');if(rtc){const current=await requireLiveSession(await db().one<LiveRtcSession>(rtcRead(id,now(),v))??undefined);if(current.offer!==rtc.offer)return fatal(id,'apiError.rdp.offerReplayed');return rtcBrowserReply(current);}return {id,state:previous.state,expiresAt:previous.expires_at,presenceGraceMs:RDP_PRESENCE_MS};}
 // Insert candidate then enforce the same live guard inside a transaction. The
 // EXISTS proof and group grant cannot be revoked between check and admission.
 const guard=featureWriteGuard(v,rdpWriteGuard('r',time)),admission=featureWriteGuard(v,sql`TRUE`),expires=time+RDP_LIFETIME_MS;
 const insert=sql`INSERT INTO rdp_sessions (id,server_id,principal,mfa_hash,state,transport,key_envelope,key_hash,created_at,last_presence,expires_at) SELECT ${id},${d.id},${principal(v)},${proof},'opening',${transport},${keyEnvelope},${keyHash},${time},${time},${expires} WHERE ${admission} AND NOT EXISTS (SELECT 1 FROM rdp_sessions WHERE server_id=${d.id} AND principal=${principal(v)} AND ${active}) AND (SELECT count(*) FROM rdp_sessions WHERE server_id=${d.id} AND ${active})<${RDP_MAX_SESSIONS} AND EXISTS (SELECT 1 FROM servers WHERE id=${d.id} AND revoked=0) ON CONFLICT(id) DO NOTHING`;
 const results=await commitAll([insert,...(rtc?[sql`INSERT INTO rdp_rtc_sessions (session_id,offer) SELECT r.id,${rtc.offer} FROM rdp_sessions r WHERE r.id=${id} AND r.server_id=${d.id} AND r.principal=${principal(v)} AND r.key_hash=${keyHash} AND r.mfa_hash=${proof} AND r.transport='webrtc' AND ${guard} ON CONFLICT(session_id) DO NOTHING`]:[]),sql`UPDATE rdp_sessions SET state='closed',key_envelope=NULL,error='serverMessage.rdp.stateChanged' WHERE id=${id} AND ${active} AND NOT EXISTS (SELECT 1 FROM rdp_sessions r WHERE r.id=${id} AND ${guard})`,rtc?rtcRead(id,time,v):sql`SELECT * FROM rdp_sessions WHERE id=${id}`]);
 const inserted=results.at(-1)?.rows[0] as LiveRtcSession|undefined;
 if(!inserted)throw new HttpError('apiError.rdp.sessionLimit');
 if(inserted.server_id!==d.id||inserted.principal!==principal(v)||inserted.key_hash!==keyHash||inserted.mfa_hash!==proof||inserted.transport!==transport)throw new HttpError('apiError.rdp.sessionIdUsed');
 if(!['opening','open'].includes(inserted.state))throw new HttpError('apiError.rdp.stateChanged');
 if(rtc){if(inserted.offer!==rtc.offer)return fatal(id,'apiError.rdp.offerReplayed');return rtcBrowserReply(await requireLiveSession(inserted));}
 return {id,state:inserted.state,expiresAt:inserted.expires_at,presenceGraceMs:RDP_PRESENCE_MS};
}

/** Closes the session with the key as its stored error (lib/server-messages.ts resolves it) and throws it. */
async function fatal(id:string,key:ApiErrorKey):Promise<never>{await closeRdp(id,key);throw new HttpError(key);}
// The stored reason stays in the session's error field of the poll answers; the 410 itself carries one generic key.
function endedRdp(){return new HttpError('apiError.rdp.sessionEnded');}
type LiveRdpSession=RdpSession&{is_live:number;frames_json?:string};
type LiveRtcSession=LiveRdpSession&{offer:string|null;answer:string|null;lease_expires_at:number|null};
function rtcRead(id:string,time=now(),v?:Viewer){
 const current=rdpWriteGuard('r',time),guard=v?featureWriteGuard(v,current):current;
 // The guarded join is the sole source of descriptions and lease deadlines.
 // Captured ownership/device checks alone cannot release negotiation secrets.
 return sql`WITH candidate AS (SELECT * FROM rdp_sessions WHERE id=${id}),authorized AS (
  SELECT r.*,t.offer,t.answer,LEAST(${time+RDP_RTC_LEASE_MS},r.expires_at,r.last_presence+${RDP_RTC_LEASE_MS},m.idle_expires_at,m.expires_at) AS lease_expires_at
  FROM candidate r JOIN rdp_rtc_sessions t ON t.session_id=r.id JOIN mfa_sessions m ON m.token_hash=r.mfa_hash AND m.principal=r.principal
  WHERE r.transport='webrtc' AND ${guard})
 SELECT c.*,CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS is_live,a.offer,a.answer,a.lease_expires_at
 FROM candidate c LEFT JOIN authorized a ON a.id=c.id`;
}
function rtcLease(session:LiveRtcSession){const deadline=session.lease_expires_at??0;return {leaseMs:Math.max(0,Math.min(RDP_RTC_LEASE_MS,deadline-now())),leaseExpiresAt:new Date(deadline).toISOString()};}
function rtcBrowserReply(session:LiveRtcSession){return {id:session.id,state:session.state,transport:'webrtc',...(session.answer?{answer:session.answer}:{}),error:session.error,expiresAt:new Date(session.expires_at).toISOString(),...rtcLease(session),intervalMs:session.state==='open'?5000:250};}
export async function browserRdpSignal(v:Viewer,id:string){
 const session=await ownedRdp(id,v);if(session.transport!=='webrtc')throw new HttpError('apiError.rdp.notWebRtc');
 const time=now(),guard=live(id,time,v),result=await commitAll([
  sql`UPDATE rdp_sessions SET last_presence=GREATEST(last_presence,${time}) WHERE id=${id} AND transport='webrtc' AND ${guard}`,
  rtcRead(id,time,v)
 ]);
 return rtcBrowserReply(await requireLiveSession(result[1].rows[0] as LiveRtcSession|undefined));
}
function liveSessionRead(id:string,time=now(),v?:Viewer){
 const current=rdpWriteGuard('r',time),guard=v?featureWriteGuard(v,current):current;
 return sql`SELECT r.*,CASE WHEN ${guard} THEN 1 ELSE 0 END AS is_live FROM rdp_sessions r WHERE r.id=${id}`;
}
async function requireLiveSession<T extends LiveRdpSession>(session:T|undefined):Promise<T>{
 if(!session)throw endedRdp();
 if(session.is_live!==1){await closeRdp(session.id,session.error||'serverMessage.rdp.expired');throw endedRdp();}
 return session;
}
function dispatchRead(id:string,direction:'in'|'out',time=now(),v?:Viewer){
 const current=rdpWriteGuard('r',time),guard=v?featureWriteGuard(v,current):current,ackColumn=sql.ident(direction==='in'?'input_ack':'output_ack');
 // One guarded statement returns session state and its bounded ordered stream.
 // Unauthorized/expired rows never evaluate a payload-bearing result branch.
 return sql`WITH candidate AS (SELECT * FROM rdp_sessions WHERE id=${id}),authorized AS (SELECT * FROM candidate r WHERE ${guard})
  SELECT c.*,CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS is_live,
   CASE WHEN a.id IS NULL THEN '[]' ELSE (SELECT coalesce(jsonb_agg(jsonb_build_object('seq',seq,'data',data) ORDER BY seq),'[]'::jsonb)::text FROM
    (SELECT seq,data FROM rdp_frames WHERE session_id=a.id AND direction=${direction} AND seq>a.${ackColumn} ORDER BY seq LIMIT ${RDP_BATCH}) frame_page) END AS frames_json
  FROM candidate c LEFT JOIN authorized a ON a.id=c.id`;
}
function browserReply(session:RdpSession,frames:RdpFrame[]=[]){return {id:session.id,state:session.state,inputAck:session.input_ack,inputStored:session.input_seq,outputAck:session.output_ack,frames,error:session.error,intervalMs:frames.length?20:50};}
// Receipt hashes retain replay proof after payload deletion, bounded per stream.
async function exchangeDirection(s:RdpSession,direction:'in'|'out',ack:number,frames:RdpFrame[],state?:RdpReport['state'],error?:string,signal?:AbortSignal,dispatch?:'in'|'out',v?:Viewer){
 checkAbort(signal);
 const isIn=direction==='in',seqColumn=isIn?'input_seq':'output_seq',seqCol=sql.ident(seqColumn),ackCol=sql.ident(isIn?'output_ack':'input_ack'),ackDirection=isIn?'out':'in',sentAckColumn=isIn?'input_ack':'output_ack',sentAckCol=sql.ident(sentAckColumn);
 const indices=JSON.stringify(frames.map(frame=>frame.seq));
 const known=sql`SELECT seq,digest FROM rdp_receipts WHERE session_id=${s.id} AND direction=${direction} AND seq IN (SELECT idx.value::bigint FROM jsonb_array_elements_text(${indices}::jsonb) AS idx(value))`;
 const [frameHashes,reads]=await Promise.all([
  Promise.all(frames.map(async frame=>({frame,digest:await hash(frame.data)}))),
  commitAll([liveSessionRead(s.id,now(),v),...(frames.length?[known]:[])])
 ]);
 checkAbort(signal);
 let current:LiveRdpSession=await requireLiveSession(reads[0].rows[0] as LiveRdpSession|undefined);
 if(ack>current[isIn?'output_seq':'input_seq'])return fatal(s.id,'apiError.rdp.invalidAck');
 const time=now(),guard=live(s.id,time,v),writes:Step[]=[];
 // Older retried polls may ACK behind a newer request; monotonic max is safe.
 writes.push(sql`UPDATE rdp_sessions SET ${ackCol}=GREATEST(${ackCol},${ack})${isIn?sql`,last_presence=GREATEST(last_presence,${time})`:sql``}${!isIn&&state?sql`,state=${state},key_envelope=CASE WHEN ${state}<>'opening' THEN NULL ELSE key_envelope END,error=${error??null}`:sql``} WHERE id=${s.id} AND ${guard}`);
 writes.push(sql`DELETE FROM rdp_frames WHERE session_id=${s.id} AND direction=${ackDirection} AND seq<=(SELECT ${ackCol} FROM rdp_sessions WHERE id=${s.id}) AND ${guard}`);
 const receipts=(reads[1]?.rows??[]) as {seq:number;digest:string}[];
 const seen=new Map(receipts.map(receipt=>[receipt.seq,receipt.digest]));
 let next=current[seqColumn];const fresh:{seq:number;data:string;digest:string}[]=[];
 for(const {frame,digest} of frameHashes){
  if(frame.seq<=next){if(seen.get(frame.seq)!==digest)return fatal(s.id,'apiError.rdp.sequenceReplayed');continue;}
  if(frame.seq!==next+1)return fatal(s.id,'apiError.rdp.sequenceGap');
  if(frame.seq-current[sentAckColumn]>RDP_CREDIT)throw new HttpError('apiError.rdp.bufferFullFrames');
  fresh.push({seq:frame.seq,data:frame.data,digest});next=frame.seq;
 }
 if(fresh.length){
  const payload=JSON.stringify(fresh),first=fresh[0].seq,last=fresh[fresh.length-1].seq;
  // Three set-based writes replace three statements per frame. The D1 batch
  // commits one contiguous suffix atomically; a concurrent identical delivery
  // may have already committed its prefix, which must retain matching receipts.
  // Every statement still reads the full live authorization and credit limit.
  const items=sql`jsonb_to_recordset(${payload}::jsonb) AS item(seq bigint,data text,digest text)`,own=sql`(SELECT ${seqCol} FROM rdp_sessions WHERE id=${s.id})`;
  const fence=sql`${own}>=${first-1} AND (SELECT ${last}::bigint-${sentAckCol} FROM rdp_sessions WHERE id=${s.id})<=${RDP_CREDIT}
   AND NOT EXISTS (SELECT 1 FROM ${items} LEFT JOIN rdp_receipts receipt ON receipt.session_id=${s.id} AND receipt.direction=${direction} AND receipt.seq=item.seq
    WHERE item.seq<=${own} AND (receipt.digest IS NULL OR receipt.digest<>item.digest))`;
  writes.push(sql`INSERT INTO rdp_frames (session_id,direction,seq,data,created_at)
   SELECT ${s.id},${direction},item.seq,item.data,${time} FROM ${items}
   WHERE ${guard} AND ${fence} AND item.seq>${own}
   ON CONFLICT(session_id,direction,seq) DO NOTHING`);
  writes.push(sql`INSERT INTO rdp_receipts (session_id,direction,seq,digest)
   SELECT ${s.id},${direction},item.seq,item.digest FROM ${items}
   JOIN rdp_frames frame ON frame.session_id=${s.id} AND frame.direction=${direction} AND frame.seq=item.seq AND frame.data=item.data
   WHERE ${guard} AND ${fence} AND item.seq>${own}
   ON CONFLICT(session_id,direction,seq) DO NOTHING`);
  writes.push(sql`UPDATE rdp_sessions SET ${seqCol}=GREATEST(${seqCol},${last}) WHERE id=${s.id} AND ${guard} AND ${fence}
   AND NOT EXISTS (SELECT 1 FROM ${items}
    LEFT JOIN rdp_frames frame ON frame.session_id=${s.id} AND frame.direction=${direction} AND frame.seq=item.seq AND frame.data=item.data
    LEFT JOIN rdp_receipts receipt ON receipt.session_id=${s.id} AND receipt.direction=${direction} AND receipt.seq=item.seq AND receipt.digest=item.digest
    WHERE item.seq>rdp_sessions.${seqCol} AND (frame.seq IS NULL OR receipt.seq IS NULL))`);
 }
 writes.push(sql`DELETE FROM rdp_receipts WHERE session_id=${s.id} AND direction=${direction} AND seq<=(SELECT ${seqCol}-128 FROM rdp_sessions WHERE id=${s.id})`);
 checkAbort(signal);const committedBatch=await commitAll([...writes,dispatch?dispatchRead(s.id,dispatch,now(),v):liveSessionRead(s.id,now(),v),...(frames.length?[known]:[])]);
 current=await requireLiveSession(committedBatch[writes.length].rows[0] as LiveRdpSession|undefined);
 // A concurrent delivery can win a sequence; it is valid only if its bytes
 // agree. Never acknowledge conflicting bytes or an uncommitted partial batch.
 const accepted=(committedBatch[writes.length+1]?.rows??[]) as {seq:number;digest:string}[],committed=new Map(accepted.map(receipt=>[receipt.seq,receipt.digest]));
 for(const {frame,digest} of frameHashes){if(current[seqColumn]<frame.seq)throw new HttpError('apiError.rdp.bufferFullResend');if(committed.get(frame.seq)!==digest)return fatal(s.id,'apiError.rdp.concurrentData');}
 return current;
}
export async function browserRdpExchange(v:Viewer,id:string,ack:number,frames:RdpFrame[],receive=true){
 const s=await ownedRdp(id,v);if(s.transport==='webrtc')throw new HttpError('apiError.rdp.webRtcNoDatabase');
 const current=await exchangeDirection(s,'in',ack,frames,undefined,undefined,undefined,receive?'out':undefined,v);
 return browserReply(current,receive?JSON.parse(current.frames_json||'[]'):[]);
}
function checkAbort(signal?:AbortSignal){if(signal?.aborted)throw new DOMException('RDP-Anfrage abgebrochen.','AbortError');}
async function pauseReceive(ms:number,signal?:AbortSignal){
 checkAbort(signal);if(ms<=0)return;
 await new Promise<void>((resolve,reject)=>{
  const finish=()=>{signal?.removeEventListener('abort',abort);resolve();},timer=setTimeout(finish,ms);
  const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new DOMException('RDP-Anfrage abgebrochen.','AbortError'));};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });
}
export async function browserRdpReceive(v:Viewer,id:string,ack:number,waitMs=600,signal?:AbortSignal,inputAck?:number){
 checkAbort(signal);const s=await ownedRdp(id,v);checkAbort(signal);if(s.transport==='webrtc')throw new HttpError('apiError.rdp.webRtcNoDatabase');
 if(!['opening','open'].includes(s.state)){await closeRdp(id);throw endedRdp();}
 // The owned snapshot's output sequence cannot decrease during a live session.
 // Validate its ACK, then update ACK/presence and read the first payload in one
 // guarded transaction. No sender receipts/sequence work is needed to receive.
 if(ack>s.output_seq)return fatal(id,'apiError.rdp.invalidAck');
 const time=now(),guard=live(id,time,v),initial=await commitAll([
  sql`UPDATE rdp_sessions SET output_ack=GREATEST(output_ack,${ack}),last_presence=GREATEST(last_presence,${time}) WHERE id=${id} AND output_seq>=${ack} AND ${guard}`,
  sql`DELETE FROM rdp_frames WHERE session_id=${id} AND direction='out' AND seq<=(SELECT output_ack FROM rdp_sessions WHERE id=${id}) AND ${guard}`,
  dispatchRead(id,'out',time,v)
 ]);
 let dispatched=await requireLiveSession(initial[2].rows[0] as LiveRdpSession|undefined),started=time;
 const knownInputAck=inputAck??dispatched.input_ack,deadline=now()+Math.min(600,Math.max(0,waitMs));
 for(let read=0;read<24;read++){
  checkAbort(signal);
  const frames=JSON.parse(dispatched.frames_json||'[]') as RdpFrame[],reply=browserReply(dispatched,frames);
  if(frames.length||dispatched.input_ack>knownInputAck||now()>=deadline||read===23)return reply;
  await pauseReceive(Math.min(deadline-now(),Math.max(0,30-(now()-started))),signal);
  checkAbort(signal);started=now();dispatched=await requireLiveSession(await db().one<LiveRdpSession>(dispatchRead(id,'out',started,v))??undefined);
 }
 throw new HttpError('apiError.rdp.receiverUnavailable');
}
const closed=(id:string,ack=0)=>({id,state:'closed',input:[],outputAck:ack});
async function agentRtcCommand(session:RdpSession,report?:RdpReport){
 if(report&&report.transport!=='webrtc')return fatal(session.id,'apiError.rdp.channelMismatch');
 let current=await requireLiveSession(await db().one<LiveRtcSession>(rtcRead(session.id))??undefined);
 if(report){
  if(report.answer&&current.answer&&report.answer!==current.answer)return fatal(session.id,'apiError.rdp.answerReplayed');
  if(report.state==='open'&&!report.answer&&!current.answer)return fatal(session.id,'apiError.rdp.answerMissing');
  const time=now(),guard=live(session.id,time),writes:Step[]=[];
  if(report.answer)writes.push(sql`UPDATE rdp_rtc_sessions SET answer=coalesce(answer,${report.answer}) WHERE session_id=${session.id} AND (answer IS NULL OR answer=${report.answer}) AND ${guard}`);
  // Once open, a delayed opening report must not regress the session state.
  writes.push(sql`UPDATE rdp_sessions SET state=CASE WHEN state='open' AND ${report.state}='opening' THEN state ELSE ${report.state} END,key_envelope=CASE WHEN EXISTS (SELECT 1 FROM rdp_rtc_sessions WHERE session_id=rdp_sessions.id AND answer IS NOT NULL) THEN NULL ELSE key_envelope END,error=${report.error??null} WHERE id=${session.id} AND transport='webrtc' AND ${guard}${report.state==='open'?sql` AND EXISTS (SELECT 1 FROM rdp_rtc_sessions WHERE session_id=rdp_sessions.id AND answer IS NOT NULL)`:sql``}`);
  const result=await commitAll([...writes,rtcRead(session.id,time)]);
  current=await requireLiveSession(result.at(-1)?.rows[0] as LiveRtcSession|undefined);
  if(report.answer&&current.answer!==report.answer)return fatal(session.id,'apiError.rdp.concurrentAnswer');
 }
 return {id:current.id,state:current.state,transport:'webrtc',...(current.state==='opening'?{offer:current.offer,...(current.key_envelope?{keyEnvelope:current.key_envelope}:{})}:{}),expiresAt:new Date(current.expires_at).toISOString(),...rtcLease(current),input:[],outputAck:0,outputStored:0};
}
// Every command the agent receives names its session and state; the rest is per transport.
type AgentRdpCommand={id:string;state:string;transport?:string;input:unknown[];[field:string]:unknown};
export async function agentRdpExchange(d:AgentDevice,reports:RdpReport[]){
 if(!REMOTE_DESKTOP_AVAILABLE)await sweepRdp(d.id);
 const rows=await db().query<RdpSession>(sql`SELECT * FROM rdp_sessions WHERE server_id=${d.id} AND ${active} ORDER BY created_at LIMIT ${RDP_MAX_SESSIONS}`).then(results=>({results})),commands:AgentRdpCommand[]=[];
 for(const session of rows.results){
  const report=reports.find(r=>r.id===session.id);
  if(report?.state==='closed'||report?.state==='error'){
   if(session.transport==='webrtc'){
    // A browser close can win after the active list was read. Do not replace
    // an earlier terminal diagnostic; the bounded late-error path below fills
    // an empty diagnostic only, without restoring any session material.
    await db().exec(sql`UPDATE rdp_sessions SET state='closed',key_envelope=NULL,error=coalesce(error,${report.transport==='webrtc'?report.error??null:null}) WHERE id=${session.id} AND server_id=${d.id} AND transport='webrtc' AND ${active}`);
   }else await closeRdp(session.id,report.error??'serverMessage.rdp.windowsClosed');
   commands.push(closed(session.id,session.output_seq));continue;
  }
  if(session.transport==='webrtc'){
   try{commands.push(await agentRtcCommand(session,report));}catch(error){if(!(error instanceof HttpError)||error.status!==410)throw error;await closeRdp(session.id);commands.push(closed(session.id));}continue;
  }
  if(report?.transport==='webrtc')return fatal(session.id,'apiError.rdp.reportMismatch');
  // Public report errors are bounded generic diagnostics only; credentials and
  // decrypted protocol contents must never be reported by the agent.
  let current:LiveRdpSession|undefined;
  if(report){try{current=await exchangeDirection(session,'out',report.inputAck,report.output,report.state,report.error,undefined,'in');}catch(error){
   // A browser close or concurrent authorization cleanup may finish this
   // session after the active list was read. Close only its tunnel; another
   // user's healthy session must still receive its authoritative command.
   if(!(error instanceof HttpError)||error.status!==410)throw error;
   await closeRdp(session.id);commands.push(closed(session.id,session.output_seq));continue;
  }}
  current??=await db().one<LiveRdpSession>(dispatchRead(session.id,'in'))??undefined;
  if(!current||current.is_live!==1){await closeRdp(session.id,current?.error||'serverMessage.rdp.sessionOrApprovalEnded');commands.push(closed(session.id,session.output_seq));continue;}
  commands.push({id:current.id,state:current.state,...(current.state==='opening'&&current.key_envelope?{keyEnvelope:current.key_envelope}:{}),expiresAt:new Date(current.expires_at).toISOString(),input:JSON.parse(current.frames_json||'[]'),outputAck:current.output_ack,outputStored:current.output_seq});
 }
 const failures=reports.filter(report=>report.transport==='webrtc'&&report.state==='error'&&report.inputAck===0&&report.output.length===0&&report.error?.trim());
 if(failures.length){const since=now()-60_000;await commitAll(failures.map(report=>sql`UPDATE rdp_sessions SET error=${report.error!} WHERE id=${report.id} AND server_id=${d.id} AND transport='webrtc' AND state IN ('closed','error') AND error IS NULL AND last_presence>=${since}`));}
 for(const report of reports)if(!commands.some(r=>r.id===report.id))commands.push(closed(report.id));
 const mailbox=commands.some(r=>['opening','open'].includes(r.state)&&r.transport!=='webrtc'),rtcOpening=commands.some(r=>r.state==='opening'&&r.transport==='webrtc'),rtcActive=commands.some(r=>r.state==='open'&&r.transport==='webrtc');
 return {sessions:commands,available:REMOTE_DESKTOP_AVAILABLE,intervalMs:!REMOTE_DESKTOP_AVAILABLE?60_000:mailbox?(commands.some(r=>r.input.length)||reports.some(r=>r.output.length)?20:50):rtcOpening?250:rtcActive?5000:1000};
}
