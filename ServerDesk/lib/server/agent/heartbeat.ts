import {commitAll,db,jsonPath,runSteps,sql,type Sql,type Tx} from '../db';
import {deviceTokenSql} from './device-tokens';
import {PENDING_JOB_LIFETIME_MS} from '../../job-expiry';
import {previousNameLimit,validDeviceName} from '../../device-name';
import {jobKindsOfCapabilities} from '../../jobs/requirements';
import {PLUGIN_INSTALL,PLUGIN_REMOVE,type PluginReport} from '../../plugin-catalog';
import {heldPluginResults,reconcilePluginReports,type PluginJobRecord} from '../extensions/plugin-results';

/** hostname is the snapshot's computer name; without it recordHeartbeat reads it from the snapshot text. */
export type Heartbeat={serverId:string;tokenHash:string;time:number;publicKey:string;snapshot:string;hostname?:unknown;management:boolean;capabilities:string[];runningJobs:string[]};
export type HeartbeatSample={serverId:string;tokenHash:string;time:number;publicKey:string;cpu:number|null;memory:number|null;gpus:string|null};
/**
 * Stores the core state of one heartbeat in one transaction. Every statement is
 * admitted by the same condition: active token, matching or not yet pinned key,
 * and a last_seen at least 10 s old. The server update runs last, so all
 * statements of the winning request still see the old last_seen, while a
 * parallel request that commits afterwards sees the new one and writes nothing
 * at all. Returns whether the server row was updated. The history sample is not
 * part of it (recordHeartbeatSample).
 *
 * The device name follows the reported computer name (lib/device-name.ts):
 * hostnameRename renames a device with name_source 'hostname' and resolves a
 * 'pending' one, in the same batch and under the same guard.
 *
 * The stored snapshot keeps a succeeded plugin install or removal for PLUGIN_RESULT_HOLD_MS
 * (heldPluginSnapshot): read in the same transaction before the batch, so a job result that commits
 * in parallel makes this transaction run again with it.
 */
export async function recordHeartbeat(h:Heartbeat):Promise<boolean>{
 return db().transaction(async tx=>{
  const results=await runSteps(tx,heartbeatStatements(h,await heldPluginSnapshot(tx,h)));
  return results[results.length-1].rowCount>0;
 });
}
function heartbeatStatements(h:Heartbeat,snapshot:string):Sql[]{
 const auth=deviceTokenSql(h.tokenHash,h.time),admittedBefore=h.time-10000,interval=sql`(last_seen IS NULL OR last_seen<=${admittedBefore})`;
 const guard=sql`EXISTS (SELECT 1 FROM servers WHERE id=${h.serverId} AND ${auth} AND (agent_public_key IS NULL OR agent_public_key=${h.publicKey}) AND ${interval})`;
 const statements:Sql[]=[];
 for(const id of h.runningJobs)statements.push(sql`UPDATE jobs SET last_progress = ${h.time} WHERE id = ${id} AND server_id = ${h.serverId} AND state = 'running' AND claimed_at > ${h.time-7200000} AND ${guard}`);
 statements.push(
  sql`UPDATE jobs SET state = 'expired',parameters = '{}',result = 'serverMessage.job.pendingExpired' WHERE server_id = ${h.serverId} AND state = 'pending' AND GREATEST(created_at,not_before) < ${h.time-PENDING_JOB_LIFETIME_MS} AND ${guard}`,
  sql`UPDATE jobs SET state = 'expired',parameters = '{}',result = 'serverMessage.job.resultUnknownInterrupted' WHERE server_id = ${h.serverId} AND state = 'running' AND (COALESCE(last_progress,claimed_at,created_at) < ${h.time-900000} OR claimed_at < ${h.time-7200000}) AND ${guard}`,
  // A pending job the agent cannot run: its kind is not among the kinds of the reported capabilities (plugin-host runs plugin-job, plugin-install and plugin-remove; plugin-ad-identity runs ad-sign-in).
  sql`UPDATE jobs SET state = 'cancelled',parameters = '{}',result = 'serverMessage.job.unsupported' WHERE server_id = ${h.serverId} AND state = 'pending' AND action NOT IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(jobKindsOfCapabilities(h.capabilities))}::jsonb)) AND ${guard}`,
  ...hostnameRename(h,guard),
  sql`UPDATE servers SET last_seen = ${h.time},snapshot = ${snapshot},management = ${h.management?1:0},agent_public_key = COALESCE(agent_public_key,${h.publicKey}) WHERE id = ${h.serverId} AND ${auth} AND (agent_public_key IS NULL OR agent_public_key = ${h.publicKey}) AND ${interval}`
 );
 return statements;
}
/**
 * The snapshot text to store: the incoming one, with the plugin results of the device's succeeded
 * plugin-install and plugin-remove jobs of the last PLUGIN_RESULT_HOLD_MS applied (reconcilePluginReports in
 * lib/server/extensions/plugin-results.ts): a removed plugin the report still lists is dropped, an installed plugin the report
 * does not list yet keeps its stored entry at the job's version. Without such a job, or when nothing changes,
 * the incoming text unchanged.
 */
async function heldPluginSnapshot(tx:Tx,h:Heartbeat):Promise<string>{
 // The newest plugin-install or plugin-remove job per plugin name (the first word of the target).
 const plugin=sql`split_part(btrim(target),' ',1)`;
 const rows=await tx.query<{action:string;state:string;target:string;createdAt:number|string;endedAt:number|string}>(sql`SELECT DISTINCT ON (${plugin}) action,state,target,created_at AS "createdAt",COALESCE(last_progress,claimed_at,created_at) AS "endedAt" FROM jobs WHERE server_id = ${h.serverId} AND action IN (${PLUGIN_INSTALL},${PLUGIN_REMOVE}) ORDER BY ${plugin},created_at DESC`);
 const jobs:PluginJobRecord[]=rows.map(row=>({action:row.action,state:row.state,target:row.target,createdAt:Number(row.createdAt),endedAt:Number(row.endedAt)}));
 const held=heldPluginResults(jobs,h.time);if(!held.size)return h.snapshot;
 let incoming:unknown;try{incoming=JSON.parse(h.snapshot);}catch{return h.snapshot;}
 if(!incoming||typeof incoming!=='object'||Array.isArray(incoming))return h.snapshot;
 const reported=(incoming as {plugins?:unknown}).plugins;
 if(reported!==undefined&&!Array.isArray(reported))return h.snapshot;
 // The stored list is read only for an install to keep.
 let stored:PluginReport[]|undefined;
 if([...held.values()].some(result=>result.kind==='install')){
  const row=await tx.one<{plugins:string|null}>(sql`SELECT (${jsonPath(sql`snapshot`,'plugins')})::text AS plugins FROM servers WHERE id = ${h.serverId}`);
  let parsed:unknown=null;try{parsed=row?.plugins?JSON.parse(row.plugins):null;}catch{parsed=null;}
  if(Array.isArray(parsed))stored=parsed.filter((entry):entry is PluginReport=>!!entry&&typeof entry==='object'&&typeof entry.name==='string'&&typeof entry.version==='string');
 }
 const plugins=reconcilePluginReports(reported as PluginReport[]|undefined,stored,jobs,h.time);
 return plugins===reported?h.snapshot:JSON.stringify({...incoming,plugins});
}
function snapshotHostname(snapshot:string):unknown{
 try{return (JSON.parse(snapshot) as {hostname?:unknown}|null)?.hostname;}catch{return undefined;}
}
/**
 * The statements that make the device name follow the computer name of the
 * snapshot, each admitted by the heartbeat's guard and run before the final
 * server update. For name_source 'hostname' and a reported name that passes
 * the name rule and differs from the stored name in more than case, in this
 * order while the old name is still stored: one device audit row ('System',
 * 'device.name.hostname', target {"old","new"}), the old name as a previous
 * name, the previous name equal to the new name removed, at most
 * previousNameLimit kept, then the new name. Afterwards a 'pending' device
 * (personal registration) resolves without a rename and without an audit row:
 * 'hostname' when its name equals the reported one in any case, else 'custom'.
 */
function hostnameRename(h:Heartbeat,guard:Sql):Sql[]{
 const {serverId,time}=h,hostname=validDeviceName('hostname' in h?h.hostname:snapshotHostname(h.snapshot));
 const resolve=sql`UPDATE servers SET name_source = CASE WHEN lower(name) = lower(${hostname??''}::text) THEN 'hostname' ELSE 'custom' END WHERE id = ${serverId} AND name_source = 'pending' AND ${guard}`;
 if(hostname===null)return [resolve];
 // True while the device follows the computer name and the stored name differs from the reported one.
 const due=sql`name_source = 'hostname' AND lower(name) <> lower(${hostname}::text)`,renames=sql`EXISTS (SELECT 1 FROM servers WHERE id = ${serverId} AND ${due})`;
 return [
  sql`INSERT INTO audit (at,actor,action,target,server_id,scope) SELECT ${time}::bigint,'System','device.name.hostname','{"old":' || to_json(name)::text || ',"new":' || ${JSON.stringify(hostname)}::text || '}',id,'device' FROM servers WHERE id = ${serverId} AND ${due} AND ${guard}`,
  sql`INSERT INTO device_previous_names (server_id,name,name_key,replaced_at) SELECT id,name,lower(name),${time}::bigint FROM servers WHERE id = ${serverId} AND ${due} AND ${guard} ON CONFLICT (server_id,name_key) DO UPDATE SET name = EXCLUDED.name,replaced_at = EXCLUDED.replaced_at`,
  sql`DELETE FROM device_previous_names WHERE server_id = ${serverId} AND name_key = lower(${hostname}::text) AND ${renames} AND ${guard}`,
  sql`DELETE FROM device_previous_names WHERE server_id = ${serverId} AND name_key NOT IN (SELECT name_key FROM device_previous_names WHERE server_id = ${serverId} ORDER BY replaced_at DESC,name_key LIMIT ${previousNameLimit}) AND ${renames} AND ${guard}`,
  sql`UPDATE servers SET name = ${hostname}::text WHERE id = ${serverId} AND ${due} AND ${guard}`,
  resolve
 ];
}
/**
 * Writes the history sample of a stored heartbeat and prunes samples older than
 * 24 hours, in its own transaction after the core commit, so a failure here
 * never undoes the device state. Both statements are admitted by the same token
 * and key condition plus last_seen = the request time: only the request that
 * won the core update writes a sample, and a parallel or rejected one writes
 * none. samples.cpu and samples.memory are integer percent columns, while the
 * agent sends fractions (6.42): they are rounded here, the snapshot keeps the
 * exact values.
 */
export async function recordHeartbeatSample(h:HeartbeatSample):Promise<boolean>{
 const guard=sql`EXISTS (SELECT 1 FROM servers WHERE id=${h.serverId} AND ${deviceTokenSql(h.tokenHash,h.time)} AND agent_public_key=${h.publicKey} AND last_seen=${h.time})`;
 const cpu=h.cpu===null?null:Math.round(h.cpu),memory=h.memory===null?null:Math.round(h.memory);
 const results=await commitAll([
  sql`INSERT INTO samples (server_id,at,cpu,memory,gpus) SELECT ${h.serverId},${h.time},${cpu},${memory},${h.gpus} WHERE ${guard}`,
  sql`DELETE FROM samples WHERE server_id = ${h.serverId} AND at < ${h.time-86400000} AND ${guard}`
 ]);
 return results[0].rowCount>0;
}
/** The pinned key of a device whose token is still active, or null when the token is not. */
export async function activeDeviceKey(serverId:string,tokenHash:string,time:number){
 return db().one<{agent_public_key:string|null}>(sql`SELECT agent_public_key FROM servers WHERE id=${serverId} AND ${deviceTokenSql(tokenHash,time)}`);
}
