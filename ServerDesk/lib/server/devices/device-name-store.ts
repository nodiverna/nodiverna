// Server side of the manual device rename (lib/device-name.ts): the change of
// POST /api/device-name. app/api/device-name/route.ts is a thin adapter; GET
// /api/console reads name, name_source and the previous names with the devices
// (consoleDevices in lib/server/console-data.ts). The heartbeat renames a device with
// name_source 'hostname' on its own (lib/server/agent/heartbeat.ts).
import {guid,HttpError,now} from '../context';
import {devicePermissionGuard,principal,requireDevice} from '../identity/access';
import {auditAfterChange,auditEvent} from '../audit';
import {featureWriteGuard} from '../identity/feature-authorization';
import {commitSessionChange} from '../identity/rbac';
import {mfaSessionFence,requireLiveSessions} from '../identity/mfa';
import {isDeviceNameSource,previousNameLimit,reportedHostname,validDeviceName,type DeviceNameSource} from '../../device-name';
import type {Viewer} from '../../types';
import {db,sql,type Step} from '../db';

const changed=()=>new HttpError('apiError.deviceName.changed');
// The right that edits the device description too: Manage device groups and permissions.
const right='groups.manage';

function parsedSnapshot(text:string|null):unknown{
 if(!text)return null;
 try{return JSON.parse(text);}catch{return null;}
}

/**
 * POST /api/device-name {serverId, source, name?, expected}: source 'custom'
 * stores the trimmed name and keeps it against later heartbeats; source
 * 'hostname' follows the computer name again and takes the computer name of
 * the stored snapshot at once when it passes the name rule (else the next
 * heartbeat renames). `expected` is the name the client showed; the committing
 * statement holds only while name and name_source still equal what this
 * request read. Routine change (lib/step-up.ts): no step-up proof, the
 * statement carries the right, the write guard and the live session fence.
 * One device audit row commits with a change ('device.name.set' for a custom
 * name, 'device.name.hostname' for the switch); a changed name also becomes a
 * previous name. A request that changes nothing writes nothing.
 */
export async function setDeviceName(request:Request,v:Viewer,p:Record<string,unknown>):Promise<{ok:true;name:string;nameSource:DeviceNameSource}>{
 if(!guid(p.serverId))throw new HttpError('apiError.device.invalid');
 const serverId=p.serverId.toLowerCase(),source=p.source;
 if((source!=='custom'&&source!=='hostname')||typeof p.expected!=='string')throw new HttpError('apiError.request.invalid');
 const custom=source==='custom'?validDeviceName(p.name):null;
 if(source==='custom'&&custom===null)throw new HttpError('apiError.deviceName.invalid');
 const expected=p.expected;
 await requireDevice(v,serverId,right);
 const current=await db().one<{name:string;name_source:string;snapshot:string|null}>(sql`SELECT name,name_source,snapshot FROM servers WHERE id=${serverId} AND revoked=0`);
 if(!current)throw new HttpError('apiError.device.notFound');
 if(current.name!==expected)throw changed();
 const stored=isDeviceNameSource(current.name_source)?current.name_source:'hostname';
 const name=custom??reportedHostname(parsedSnapshot(current.snapshot))??current.name;
 if(name===current.name&&source===stored)return {ok:true,name,nameSource:stored};
 const fence=await mfaSessionFence(request,v),time=now();
 const guard=sql`(${featureWriteGuard(v,devicePermissionGuard(sql`${serverId}`,sql`${principal(v)}`,right))}) AND (${fence})`;
 const statement=sql`UPDATE servers SET name=${name},name_source=${source} WHERE id=${serverId} AND revoked=0 AND name=${expected} AND name_source=${current.name_source} AND ${guard} RETURNING name,name_source`;
 const audit=auditEvent({actor:v.label,action:source==='custom'?'device.name.set':'device.name.hostname',target:JSON.stringify({old:expected,new:name}),serverIds:[serverId],guard:auditAfterChange,at:time});
 // Each step runs only after the previous one wrote a row, so all of them
 // follow the committed rename (lib/server/db.ts, AfterChange).
 const previous:Step[]=name===expected?[]:[
  {afterChange:sql`INSERT INTO device_previous_names (server_id,name,name_key,replaced_at) VALUES (${serverId},${expected},lower(${expected}::text),${time}::bigint) ON CONFLICT (server_id,name_key) DO UPDATE SET name=EXCLUDED.name,replaced_at=EXCLUDED.replaced_at`},
  {afterChange:sql`DELETE FROM device_previous_names WHERE server_id=${serverId} AND (name_key=lower(${name}::text) OR name_key NOT IN (SELECT name_key FROM device_previous_names WHERE server_id=${serverId} AND name_key<>lower(${name}::text) ORDER BY replaced_at DESC,name_key LIMIT ${previousNameLimit}))`}
 ];
 const row=await commitSessionChange(statement,[...audit,...previous]);
 if(!row){
  // Refused in the transaction: a lost right or device answers like the
  // pre-check, an ended session with its own 401; otherwise the name changed.
  await requireDevice(v,serverId,right);await requireLiveSessions(request,v);
  throw changed();
 }
 return {ok:true,name:String(row.name),nameSource:isDeviceNameSource(row.name_source)?row.name_source:source};
}
