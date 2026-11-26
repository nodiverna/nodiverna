// Server side of the device description (lib/device-description.ts): the change
// of POST /api/device-description. app/api/device-description/route.ts is a
// thin adapter; GET /api/console reads the column with the devices
// (consoleDevices in lib/server/console-data.ts). Only the portal writes the column:
// heartbeat and enrollment never name it, and deviceRevocation clears it.
import {guid,HttpError,now} from '../context';
import {devicePermissionGuard,principal,requireDevice} from '../identity/access';
import {auditAfterChange,auditEvent} from '../audit';
import {featureWriteGuard} from '../identity/feature-authorization';
import {commitSessionChange} from '../identity/rbac';
import {mfaSessionFence,requireLiveSessions} from '../identity/mfa';
import {validateDeviceDescription} from '../../device-description';
import type {Viewer} from '../../types';
import {db,sql} from '../db';

const invalid=()=>new HttpError('apiError.description.invalid');
const changed=()=>new HttpError('apiError.description.changed');
// The right that organizes devices today (group moves, group edits): Manage device groups and permissions.
const right='groups.manage';

/**
 * POST /api/device-description {serverId, description, expected}: stores the
 * normalized description. `expected` is the text the client showed; the
 * committing statement holds only while the column still equals it. Routine
 * change (lib/step-up.ts): no step-up proof, the statement carries the right,
 * the write guard and the live session fence. One device audit row commits
 * with the change; saving the stored text again writes nothing.
 */
export async function setDeviceDescription(request:Request,v:Viewer,p:Record<string,unknown>):Promise<{ok:true;description:string}>{
 if(!guid(p.serverId))throw new HttpError('apiError.device.invalid');
 const serverId=p.serverId.toLowerCase(),result=validateDeviceDescription(p.description);
 if(!result.ok||typeof p.expected!=='string')throw invalid();
 const expected=p.expected;
 await requireDevice(v,serverId,right);
 const current=await db().one<{description:string}>(sql`SELECT description FROM servers WHERE id=${serverId} AND revoked=0`);
 if(!current)throw new HttpError('apiError.device.notFound');
 if(current.description!==expected)throw changed();
 if(result.text===current.description)return {ok:true,description:current.description};
 const fence=await mfaSessionFence(request,v),time=now();
 const guard=sql`(${featureWriteGuard(v,devicePermissionGuard(sql`${serverId}`,sql`${principal(v)}`,right))}) AND (${fence})`;
 const statement=sql`UPDATE servers SET description=${result.text} WHERE id=${serverId} AND revoked=0 AND description=${expected} AND ${guard} RETURNING description`;
 const audit=auditEvent({actor:v.label,action:'device.description.set',target:JSON.stringify({old:expected,new:result.text}),serverIds:[serverId],guard:auditAfterChange,at:time});
 const row=await commitSessionChange(statement,audit);
 if(!row){
  // Refused in the transaction: a lost right or device answers like the
  // pre-check, an ended session with its own 401; otherwise the text changed.
  await requireDevice(v,serverId,right);await requireLiveSessions(request,v);
  throw changed();
 }
 return {ok:true,description:String(row.description)};
}
