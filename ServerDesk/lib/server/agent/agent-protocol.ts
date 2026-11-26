import {env} from 'cloudflare:workers';
import {body,HttpError,now,guid} from '../context';
import type {ServerSnapshot} from '../../types';
import {deviceBearer,deviceFromBearer,deviceTokenRejected,deviceTokenSql} from './device-tokens';
import {db,sql} from '../db';
export const CHUNK_SIZE=262144, MAX_TRANSFER=256*1024*1024;
export function bucket():R2Bucket {const b=(env as unknown as {BUCKET?:R2Bucket}).BUCKET;if(!b)throw new HttpError('apiError.files.storageUnavailable');return b;}
export type AgentDevice={id:string;last_seen:number|null;management:number;snapshot:string|null;name:string;agent_public_key:string|null};
export async function agent(request:Request,id:string,options:{allowTokenRetry?:boolean}={}):Promise<AgentDevice>{
 if(!guid(id))throw new HttpError('apiError.device.invalid');
 const tokenHash=await deviceBearer(request),auth=deviceTokenSql(tokenHash);
 const row=await db().one<AgentDevice>(sql`SELECT id,last_seen,management,snapshot,name,agent_public_key FROM servers WHERE id=${id} AND ${auth}`);if(!row)return deviceTokenRejected(id,options.allowTokenRetry===true,tokenHash);return row;
}
// Agent routes with large bodies authenticate from the headers first. The
// caller reads the body afterwards and must reject a body `serverId` that
// differs from the returned device with a generic 403.
export async function agentFromBearer(request:Request,options:{allowTokenRetry?:boolean}={}):Promise<AgentDevice>{
 return (await deviceFromBearer<AgentDevice>(request,'id,last_seen,management,snapshot,name,agent_public_key',{allowTokenRetry:options.allowTokenRetry})).device;
}
// Credential expiry gates new requests. An already admitted request can finish
// while its bearer rotates, provided that the device and its pinned identity
// are still active. Rechecking the bearer after claiming a job could strand a
// running job without ever dispatching it to the agent.
export async function assertAgentActive(admitted:AgentDevice):Promise<AgentDevice>{
 const current=await db().one<AgentDevice>(sql`SELECT id,last_seen,management,snapshot,name,agent_public_key FROM servers WHERE id=${admitted.id} AND revoked=0 AND agent_public_key IS NOT DISTINCT FROM ${admitted.agent_public_key}`);
 if(!current)throw new HttpError('apiError.agent.notApproved');
 return current;
}
export function snapshot(s:{snapshot:string|null}):ServerSnapshot|null{return s.snapshot?JSON.parse(s.snapshot):null;}
export function modern(s:AgentDevice,cap?:string){const p=snapshot(s);if(!p||!s.last_seen||now()-s.last_seen>120000)throw new HttpError('apiError.device.offline');if(p.protocolVersion!==3||cap&&!p.agentCapabilities?.includes(cap))throw new HttpError('apiError.agent.v3FunctionRequired');return p;}
export async function lease(serverId:string,kind:string,id:string,expires:number,options:{ignoreTerminal?:boolean}={}){const row=await db().one<{owner_id:string}>(sql`INSERT INTO device_leases (server_id,owner_kind,owner_id,expires_at) SELECT ${serverId},${kind},${id},${expires} WHERE EXISTS (SELECT 1 FROM servers WHERE id=${serverId} AND revoked=0) ON CONFLICT(server_id) DO UPDATE SET owner_kind=excluded.owner_kind,owner_id=excluded.owner_id,expires_at=excluded.expires_at WHERE (device_leases.expires_at < ${now()} OR (${options.ignoreTerminal?1:0}=1 AND device_leases.owner_kind='terminal')) AND EXISTS (SELECT 1 FROM servers WHERE id=${serverId} AND revoked=0) RETURNING owner_id`);if(!row||row.owner_id!==id)throw new HttpError('apiError.device.removedOrBusy');}
export async function releaseLease(id:string){await db().exec(sql`DELETE FROM device_leases WHERE owner_id = ${id}`);}
export async function pendingWork(serverId:string){return db().one(sql`SELECT id FROM jobs WHERE server_id = ${serverId} AND state IN ('pending','running') LIMIT 1`);}
export async function pendingTransfers(serverId:string){return db().one(sql`SELECT id FROM transfers WHERE server_id=${serverId} AND state IN ('pending','ready','active') AND expires_at>${now()} LIMIT 1`);}
export async function busyLease(serverId:string){return db().one(sql`SELECT server_id FROM device_leases WHERE server_id=${serverId} AND expires_at>${now()}`);}
// Queuing normal work and parallel terminals must not be rejected by another
// user's shell or ordinary job. Only an agent update (or another maintenance
// owner) holds an exclusive device lease. Exclusive and sole jobs hold the
// device lease while they run; parallel jobs hold none and may run next to
// each other and next to one exclusive job (lib/server/devices/jobs/concurrency.ts).
// Agents without parallel-jobs still run one job at a time.
export async function maintenanceBusy(serverId:string){return db().one(sql`SELECT l.server_id FROM device_leases l WHERE l.server_id=${serverId} AND l.expires_at>${now()} AND (l.owner_kind NOT IN ('terminal','job') OR (l.owner_kind='job' AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=l.owner_id AND j.server_id=l.server_id AND j.action='agent-update'))) LIMIT 1`);}
export function windowsPath(value:unknown):string{if(typeof value!=='string'||value.length<3||value.length>240||! /^[A-Za-z]:\\/.test(value)||/[\x00-\x1f*?<>"|]/.test(value)||value.slice(2).includes(':')||value.split(/[\\/]/).some(p=>p==='..'||p.endsWith('.')||p.endsWith(' ')))throw new HttpError('apiError.files.absolutePath');if(/\\(?:ServerDesk|ServerDeskAgent)(?:\\|$)/i.test(value))throw new HttpError('apiError.files.agentDataProtected');return value.replaceAll('/','\\');}
export async function json(request:Request,max=1048576){return body(request,max);}

export function securityFile(path:string){return /\\(?:Security\.evtx|security-(?:events|support)-[^\\]+)$/i.test(path);}
