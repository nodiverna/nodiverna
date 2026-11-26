import {featureWriteGuard} from '../identity/feature-authorization';
import type {Viewer} from '../../types';
import {createHash} from 'node:crypto';
import {HttpError,now} from '../context';
import {bucket,CHUNK_SIZE,MAX_TRANSFER,securityFile} from '../agent/agent-protocol';
import {devicePermissionGuard,type Permission} from '../identity/access';
import {privilegedFilePath} from './file-access';
import {db,sql,type Sql} from '../db';
export type Transfer={id:string;server_id:string;principal:string;direction:'upload'|'download';path:string;size:number|null;sha256:string|null;state:string;overwrite:number;expires_at:number;message:string|null};
export function transferAuthorizationGuard(t:Pick<Transfer,'id'|'server_id'|'principal'|'direction'|'path'>,time=now(),v?:Viewer){
 const permissions:Permission[]=[t.direction==='upload'?'files.write':'files.read'];if(privilegedFilePath(t.path))permissions.push('manage');if(securityFile(t.path))permissions.push('security.events');
 const rights=permissions.map(permission=>devicePermissionGuard(sql`authorization_transfer.server_id`,sql`authorization_transfer.principal`,permission));
 const guard=sql`EXISTS (SELECT 1 FROM transfers authorization_transfer WHERE authorization_transfer.id=${t.id} AND authorization_transfer.server_id=${t.server_id} AND authorization_transfer.principal=${t.principal} AND authorization_transfer.direction=${t.direction} AND authorization_transfer.path=${t.path} AND authorization_transfer.expires_at>${time} AND authorization_transfer.state NOT IN ('cancelled','failed','expired') AND ${sql.join(rights.map(right=>sql`(${right})`),sql` AND `)})`;return v?featureWriteGuard(v,guard):guard;
}
export async function assertTransferAuthorized(t:Pick<Transfer,'id'|'server_id'|'principal'|'direction'|'path'>,v?:Viewer){const guard=transferAuthorizationGuard(t,now(),v);if(!await db().one(sql`SELECT 1 WHERE ${guard}`))throw new HttpError('apiError.transfer.rightRevoked');}
export async function getAuthorizedChunk(t:Transfer,n:number,v?:Viewer){const object=await getChunk(t.id,n);try{await assertTransferAuthorized(t,v);}catch(error){await object?.body.cancel().catch(()=>{});throw error;}return object;}
export async function getTransfer(id:string){const t=await db().one<Transfer>(sql`SELECT * FROM transfers WHERE id=${id}`);if(!t)throw new HttpError('apiError.transfer.notFound');if(t.expires_at<now()||['cancelled','failed','expired'].includes(t.state))throw new HttpError('apiError.transfer.expired');return t;}
// The maintenance (runtime/maintenance.mjs) deletes every object under `transfers/<id>/`; keep that prefix in sync.
export const chunkKey=(id:string,chunk:number,digest:string)=>'transfers/'+id+'/'+chunk+'/'+digest;
export async function getChunk(id:string,chunk:number){const r=await db().one<{sha256:string}>(sql`SELECT sha256 FROM transfer_chunks WHERE transfer_id=${id} AND chunk=${chunk}`);return r?bucket().get(chunkKey(id,chunk,r.sha256)):null;}
export function chunkNumber(q:URLSearchParams){const n=Number(q.get('chunk'));if(!q.has('chunk')||!Number.isSafeInteger(n)||n<0||n>=MAX_TRANSFER/CHUNK_SIZE)throw new HttpError('apiError.transfer.invalidBlock');return n;}
export async function putChunk(request:Request,t:Transfer,n:number,v?:Viewer){if(t.size===null)throw new HttpError('apiError.transfer.sizeMissing');const expected=Math.min(CHUNK_SIZE,t.size-n*CHUNK_SIZE);if(expected<=0)throw new HttpError('apiError.transfer.blockOutside');if(Number(request.headers.get('content-length')??0)>CHUNK_SIZE)throw new HttpError('apiError.transfer.blockTooLarge');
 const reader=request.body?.getReader(),bytes=new Uint8Array(expected);let offset=0;if(reader)try{while(true){const r=await reader.read();if(r.done)break;if(offset+r.value.length>expected){await reader.cancel();throw new HttpError('apiError.transfer.blockTooLarge');}bytes.set(r.value,offset);offset+=r.value.length;}}finally{reader.releaseLock();}if(offset!==expected)throw new HttpError('apiError.transfer.blockWrongSize');
 const sha=createHash('sha256').update(bytes).digest('hex'),prior=await db().one<{sha256:string}>(sql`SELECT sha256 FROM transfer_chunks WHERE transfer_id=${t.id} AND chunk=${n}`);if(prior&&prior.sha256!==sha)throw new HttpError('apiError.transfer.blockDifferent');
 // Immutable keys prevent two concurrent, conflicting block writes from
 // replacing an object whose hash has already been accepted in the database.
 const key=chunkKey(t.id,n,sha);await bucket().put(key,bytes,{customMetadata:{sha256:sha}});const authorization=transferAuthorizationGuard(t,now(),v);await db().exec(sql`INSERT INTO transfer_chunks (id,transfer_id,chunk,size,sha256) SELECT ${t.id+':'+n},${t.id},${n},${bytes.length},${sha} WHERE EXISTS (SELECT 1 FROM transfers WHERE id=${t.id} AND state IN ('uploading','pending','active') AND expires_at>${now()}) AND ${authorization} ON CONFLICT DO NOTHING`);const accepted=await db().one<{sha256:string}>(sql`SELECT sha256 FROM transfer_chunks WHERE transfer_id=${t.id} AND chunk=${n}`);const state=await db().one<{state:string}>(sql`SELECT state FROM transfers WHERE id=${t.id} AND ${authorization}`);if(accepted?.sha256!==sha||!state||['cancelled','expired','failed'].includes(state.state)){await bucket().delete(key);throw new HttpError('apiError.transfer.blockConcurrent');}await db().exec(sql`UPDATE transfers SET updated_at=${now()} WHERE id=${t.id} AND ${authorization}`);}
export async function verifyTransfer(t:Transfer){if(t.size===null||!t.sha256)throw new HttpError('apiError.transfer.metadataMissing');const rows=await db().query<{chunk:number;size:number;sha256:string}>(sql`SELECT chunk,size,sha256 FROM transfer_chunks WHERE transfer_id=${t.id} ORDER BY chunk`).then(results=>({results}));if(rows.results.length!==Math.ceil(t.size/CHUNK_SIZE))throw new HttpError('apiError.transfer.blocksMissing');const hash=createHash('sha256');let size=0;for(let n=0;n<rows.results.length;n++){const r=rows.results[n];if(r.chunk!==n)throw new HttpError('apiError.transfer.blocksIncomplete');const object=await getChunk(t.id,n);if(!object)throw new HttpError('apiError.transfer.blockMissingInStorage');const bytes=new Uint8Array(await object.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==r.sha256)throw new HttpError('apiError.transfer.blockDamaged');size+=bytes.length;hash.update(bytes);}if(size!==t.size||hash.digest('hex')!==t.sha256)throw new HttpError('apiError.transfer.hashOrSizeMismatch');}
export async function clearTransfer(id:string){let cursor:string|undefined;do{const objects=await bucket().list({prefix:'transfers/'+id+'/',limit:1000,...(cursor?{cursor}:{})});for(let i=0;i<objects.objects.length;i+=100)await bucket().delete(objects.objects.slice(i,i+100).map(r=>r.key));cursor=objects.truncated?objects.cursor:undefined;}while(cursor);await db().exec(sql`DELETE FROM transfer_chunks WHERE transfer_id=${id}`);}
export async function sweepTransfers(serverId:string){const rows=await db().query<{id:string}>(sql`SELECT id FROM transfers WHERE server_id=${serverId} AND (expires_at<${now()} OR state IN ('cancelled','failed')) AND (state<>'expired' OR updated_at<${now()-86400000}) ORDER BY updated_at LIMIT 3`).then(results=>({results}));for(const row of rows.results){await clearTransfer(row.id);await db().exec(sql`UPDATE transfers SET state='expired',updated_at=${now()},message=COALESCE(message,'Zwischenspeicher abgelaufen') WHERE id=${row.id}`);}}

// ---- Transfer records for the transfer routes ---------------------------------
export type TransferProgress={transferredBytes:number;chunks:number};
/** Bytes and chunks stored for one transfer. */
export async function transferProgress(id:string):Promise<TransferProgress>{
 const row=await db().one<TransferProgress>(sql`SELECT COALESCE(SUM(size),0)::bigint AS "transferredBytes",COUNT(chunk) AS chunks FROM transfer_chunks WHERE transfer_id=${id}`);
 return {transferredBytes:row?.transferredBytes??0,chunks:row?.chunks??0};
}
/** The 30 newest transfers of a principal on one device, with their progress. */
export async function listTransfers(serverId:string,principalKey:string){
 return db().query<Transfer&TransferProgress>(sql`SELECT t.*,COALESCE(SUM(c.size),0)::bigint AS "transferredBytes",COUNT(c.chunk) AS chunks FROM transfers t LEFT JOIN transfer_chunks c ON c.transfer_id=t.id WHERE t.server_id=${serverId} AND t.principal=${principalKey} GROUP BY t.id ORDER BY t.created_at DESC LIMIT 30`);
}
const openTransfers=(serverId:string,time:number)=>sql`(SELECT count(*) FROM transfers WHERE server_id=${serverId} AND state IN ('pending','uploading','ready','active') AND expires_at>${time})`;
/** Open, unexpired transfers of a device. */
export async function openTransferCount(serverId:string,time:number){return Number((await db().one<{n:number}>(sql`SELECT ${openTransfers(serverId,time)} AS n`))?.n??0);}
export type NewTransfer={id:string;serverId:string;principal:string;direction:'upload'|'download';path:string;size:number|null;sha256:string|null;overwrite:boolean;time:number};
/**
 * Creates a transfer when the authorization still holds, the device has fewer
 * than three open transfers and no maintenance lease or running agent update.
 */
export async function createTransfer(t:NewTransfer,authorization:Sql):Promise<boolean>{
 return !!await db().one(sql`INSERT INTO transfers (id,server_id,principal,direction,path,size,sha256,state,overwrite,created_at,updated_at,expires_at) SELECT ${t.id},${t.serverId},${t.principal},${t.direction},${t.path},${t.size},${t.sha256},${t.direction==='upload'?'uploading':'pending'},${t.overwrite?1:0},${t.time},${t.time},${t.time+86400000} WHERE ${authorization} AND ${openTransfers(t.serverId,t.time)}<3 AND NOT EXISTS (SELECT 1 FROM device_leases l WHERE l.server_id=${t.serverId} AND l.expires_at>${t.time} AND (l.owner_kind NOT IN ('terminal','job') OR (l.owner_kind='job' AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=l.owner_id AND j.server_id=l.server_id AND j.action='agent-update')))) AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.server_id=${t.serverId} AND j.action='agent-update' AND j.state='running') RETURNING id`);
}
/** Moves a finished upload to ready; false when the transfer or the authorization changed. */
export async function markUploadReady(t:Transfer,time:number,authorization:Sql){return (await db().exec(sql`UPDATE transfers SET state='ready',updated_at=${time} WHERE id=${t.id} AND state='uploading' AND ${authorization}`)).rowCount>0;}
/** Takes a ready upload back to uploading (maintenance began meanwhile). */
export async function reopenUpload(id:string){await db().exec(sql`UPDATE transfers SET state='uploading' WHERE id=${id} AND state='ready'`);}
export async function cancelTransfer(id:string,time:number,authorization:Sql){return (await db().exec(sql`UPDATE transfers SET state='cancelled',updated_at=${time} WHERE id=${id} AND ${authorization}`)).rowCount>0;}
/** The agent reports the source metadata of a download and starts it. */
export async function startDownload(t:Transfer,size:number,sha256:string){
 const time=now();
 return !!await db().one(sql`UPDATE transfers SET size=${size},sha256=${sha256},state='active',updated_at=${time} WHERE id=${t.id} AND state IN ('pending','active') AND expires_at>${time} AND (size IS NULL OR (size=${size} AND sha256=${sha256})) AND ${transferAuthorizationGuard(t)} RETURNING id`);
}
/** The agent confirms a transfer with the size and hash it checked. */
export async function completeTransfer(t:Transfer,size:number,sha256:string){
 const time=now();
 return !!await db().one(sql`UPDATE transfers SET state='completed',updated_at=${time} WHERE id=${t.id} AND state IN ('ready','active') AND expires_at>${time} AND size=${size} AND sha256=${sha256} AND ${transferAuthorizationGuard(t)} RETURNING id`);
}
