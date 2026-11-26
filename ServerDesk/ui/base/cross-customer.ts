import {crossCustomerPermission,crossCustomerPermissionLabelKey} from '@/lib/cross-customer-right';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';

// Cross-customer actions in the UI (docs/customers.md). Pure helpers:
// the server decides with its gate; these only explain a lock before a request.
// Devices without customerId (e.g. demo data) count for no customer.
// The right comes from lib/cross-customer-right.ts, like on the server.
export {crossCustomerPermission as crossCustomerRight};
/** The catalog key of the right's name. The role editor also uses this key for the right: it is the labelKey of the right in lib/server/identity/access.ts. */
export const crossCustomerRightKey:MessageKey=crossCustomerPermissionLabelKey;
/** Tooltips of the role editor when the viewer is no Owner. */
export const privilegedRightLockReason:MessageKey='crossCustomer.privilegedRight';
export const privilegedRoleLockReason:MessageKey='crossCustomer.privilegedRole';

type CustomerDevice={id:string;customerId?:string|null};
type PermissionViewer={permissions?:string[]};

/** Number of distinct customers among the chosen devices. */
export function targetCustomerCount(devices:readonly CustomerDevice[],ids:readonly string[]):number{
 const chosen=new Set(ids);
 return new Set(devices.filter(device=>chosen.has(device.id)&&device.customerId).map(device=>device.customerId)).size;
}
/** The viewer holds the right (Owners through '*', which the API already expands). */
export function canStartCrossCustomer(viewer:PermissionViewer):boolean{
 return !!viewer.permissions?.some(right=>right===crossCustomerPermission||right==='*');
}
/** Hint in the confirmation of an action over n customers. */
export function crossCustomerHint(customers:number,locale:Locale=defaultLocale):string|null{
 return customers<2?null:translate(locale,'crossCustomer.hint',{customers});
}
/** Why a cross-customer action is locked for this viewer, or null: the right, as the server gate checks it. */
export function crossCustomerLockReason(viewer:PermissionViewer,customers:number,locale:Locale=defaultLocale):string|null{
 if(customers<2)return null;
 return canStartCrossCustomer(viewer)?null:translate(locale,'crossCustomer.lockRight',{right:translate(locale,crossCustomerRightKey)});
}
/** Schedules serve one customer, also for Owners. */
export function scheduleCustomerLockReason(customers:number,locale:Locale=defaultLocale):string|null{
 return customers<2?null:translate(locale,'apiError.crossCustomer.schedule');
}
/** A role with '*' or the cross-customer right: only Owners change and assign it. */
export function privilegedRole(permissions:readonly string[]):boolean{
 return permissions.some(right=>right==='*'||right===crossCustomerPermission);
}
