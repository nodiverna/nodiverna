import {pinnedDeviceLimit,type Viewer} from '../types';
import {HttpError,now} from './context';
import {db,sql,type Sql} from './db';
import {customerAccessGuard,devicePermissionGuard,principal,requireDevice} from './identity/access';

// The devices an account pinned to the top of its navigator and command
// palette (docs/device-workspace.md, "Pinned devices"). All SQL of
// account_pinned_devices is here. An account reads and writes only its own
// rows (viewer.userId). A pin of a device the viewer can no longer see stays
// stored but is not listed and does not count against the limit; it shows
// again when the access returns. A pin is a personal display setting: no audit
// row and no MFA step-up (lib/step-up.ts).

const ownId=(viewer:Viewer)=>{if(!viewer.userId)throw new HttpError('apiError.auth.loginRequired');return viewer.userId;};

/** The pins of the account whose device the viewer may see now. */
const visiblePin=(viewer:Viewer):Sql=>sql`EXISTS (SELECT 1 FROM servers pinned_device WHERE pinned_device.id=pin.device_id AND pinned_device.revoked=0 AND ${customerAccessGuard(sql`pinned_device.customer_id`,sql`${principal(viewer)}`)}) AND ${devicePermissionGuard(sql`pin.device_id`,sql`${principal(viewer)}`,'view')}`;

/** The ids of the viewer's visible pins, oldest first (then by device id). */
export async function pinnedDeviceIds(viewer:Viewer):Promise<string[]>{
 if(!viewer.userId)return [];
 const rows=await db().query<{device_id:string}>(sql`SELECT pin.device_id FROM account_pinned_devices pin WHERE pin.user_id=${viewer.userId} AND ${visiblePin(viewer)} ORDER BY pin.created_at,pin.device_id`);
 return rows.map(row=>row.device_id);
}

/** Reads the body of PUT /api/account/pinned-devices: exactly {deviceId:string,pinned:boolean}, else apiError.request.invalid. */
export function devicePinInput(input:Record<string,unknown>):{deviceId:string;pinned:boolean}{
 const keys=Object.keys(input).sort();
 if(keys.length!==2||keys[0]!=='deviceId'||keys[1]!=='pinned'||typeof input.deviceId!=='string'||typeof input.pinned!=='boolean')throw new HttpError('apiError.request.invalid');
 return {deviceId:input.deviceId,pinned:input.pinned};
}

/**
 * Pins or unpins one device the viewer may see (requireDevice: an invalid id
 * gives apiError.device.invalid, a device out of reach its not-found error).
 * The insert checks the limit in the same statement; a repeated pin or an
 * unpin of a device that is not pinned changes nothing. Answers the visible pins.
 */
export async function setDevicePin(viewer:Viewer,deviceId:string,pinned:boolean):Promise<string[]>{
 const userId=ownId(viewer);
 await requireDevice(viewer,deviceId,'view');
 if(!pinned){
  await db().exec(sql`DELETE FROM account_pinned_devices WHERE user_id=${userId} AND device_id=${deviceId}`);
  return pinnedDeviceIds(viewer);
 }
 const inserted=await db().exec(sql`INSERT INTO account_pinned_devices(user_id,device_id,created_at)
  SELECT ${userId},${deviceId},${now()}::bigint
  WHERE (SELECT count(*) FROM account_pinned_devices pin WHERE pin.user_id=${userId} AND pin.device_id<>${deviceId} AND ${visiblePin(viewer)})<${pinnedDeviceLimit}
  ON CONFLICT (user_id,device_id) DO NOTHING`);
 if(inserted.rowCount===0){
  const existing=await db().one(sql`SELECT 1 FROM account_pinned_devices WHERE user_id=${userId} AND device_id=${deviceId}`);
  if(!existing)throw new HttpError('apiError.account.pinLimit',{max:pinnedDeviceLimit});
 }
 return pinnedDeviceIds(viewer);
}
