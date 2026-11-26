// The rules of "Move to another customer…" (docs/customers.md "Move devices to another customer"): when the entry
// shows, why it is blocked, which customers and groups the drawer offers, the request and the success text. Pure, so
// the fleet row menu, the selection bar, the device header menu and the drawer share one source and a test reads it
// without a DOM. The server checks every rule again (lib/server/devices/device-customer-move.ts).
import type {DeviceGroup,Viewer} from '@/lib/types';
import type {Locale} from '@/lib/i18n/locale';
import type {Translate} from '@/ui/base/locale';
import {isOwner} from '@/ui/base/access-capabilities';
import {permitted,type Device} from '@/ui/base/api';
import {groupTree} from '@/ui/devices/fleet/groups';

/** A customer the viewer sees (ConsoleData.customers). */
export type MoveCustomer={id:string;name:string};
/** The rights a move needs on every device and on the target. */
export const customerMoveRights=['manage','groups.manage'] as const;
/** At most this many devices per move (the server answers apiError.devices.selectRange above it). */
export const customerMoveMax=100;
type MoveDevice=Pick<Device,'id'|'name'|'customerId'|'revoked'|'permissions'>;

/** The customers the devices can move to: every visible customer except a customer of a device, sorted by name. */
export function customerMoveTargets(devices:readonly Pick<Device,'customerId'>[],customers:readonly MoveCustomer[],locale:Locale):MoveCustomer[]{
 const sources=new Set(devices.map(device=>device.customerId));
 return customers.filter(customer=>!sources.has(customer.id)).sort((a,b)=>a.name.localeCompare(b.name,locale,{numeric:true}));
}
/**
 * Whether the entry shows: only with several customers, for devices that are not removed, and while another visible
 * customer exists. Otherwise the viewer can never move them, so the entry is hidden (not blocked).
 */
export function customerMoveShown({multipleCustomers,customers,devices}:{multipleCustomers:boolean;customers:readonly MoveCustomer[];devices:readonly MoveDevice[]}):boolean{
 return multipleCustomers&&devices.length>0&&devices.every(device=>device.revoked===0)&&customerMoveTargets(devices,customers,'en').length>0;
}
/** Whether the viewer holds both move rights on the device (permitted: Owner, or the device's own permissions). */
export const canMoveDeviceToCustomer=(device:MoveDevice,viewer:Viewer)=>customerMoveRights.every(right=>permitted(device as Device,viewer,right));
/**
 * Why the shown entry cannot act, or undefined: sample devices, a save in progress, a device without both rights
 * (bulk: the selection text), more than 100 devices.
 */
export function customerMoveBlocked({devices,viewer,demo,saving,bulk=false}:{devices:readonly MoveDevice[];viewer:Viewer;demo:boolean;saving:boolean;bulk?:boolean},t:Translate):string|undefined{
 if(demo)return t('kit.unavailable.demo');
 if(saving)return t('fleet.menu.saving');
 if(devices.some(device=>!canMoveDeviceToCustomer(device,viewer)))return t(bulk?'devices.customerMove.noRightBulk':'devices.customerMove.noRight');
 if(devices.length>customerMoveMax)return t('fleet.bulk.max');
 return undefined;
}
/** The groups of the target customer in tree order where the viewer holds both rights (every group for an Owner). */
export function customerMoveGroups(groups:readonly DeviceGroup[],customerId:string,viewer:Viewer){
 const owner=isOwner(viewer);
 return groupTree(groups.filter(group=>group.customerId===customerId)).filter(node=>owner||customerMoveRights.every(right=>node.group.permissions.includes(right)));
}
/** Whether "Ungrouped" is a target: both rights in a global assignment (viewer.permissions), or an Owner. */
export const customerMoveUngrouped=(viewer:Viewer)=>isOwner(viewer)||customerMoveRights.every(right=>viewer.permissions?.includes(right)===true);
/** The request of the drawer (POST /api/console); useStepUp adds the managementToken. */
export function customerMovePayload(ids:readonly string[],customerId:string,groupId:string|null){
 return {action:'move-customer' as const,ids:[...ids],customerId,groupId,confirm:true as const};
}
/** The success toast: the device name for one device, the count for several. */
export function customerMoveDone(devices:readonly Pick<Device,'name'>[],customer:string,t:Translate):string{
 return devices.length===1?t('devices.customerMove.doneOne',{name:devices[0].name,customer}):t('devices.customerMove.doneMany',{count:devices.length,customer});
}
/**
 * What the console hands the fleet and the device page for the entry: the visible customers, whether the portal has
 * several customers, and the opener of the drawer, which resolves true after a move and false when it closes without one.
 */
export type CustomerMoveEntry={customers:readonly MoveCustomer[];multipleCustomers:boolean;onMove:(ids:string[])=>Promise<boolean>};
