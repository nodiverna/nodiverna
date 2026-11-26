// The pure rules of the customers page (Settings › Customers, ui/settings/customers-panel.tsx) and of the customer
// drawers (ui/settings/customer-drawers.tsx): the column texts, the blocked reasons of the row menu, the manage form
// with its validation and request body, and the technician choice. No React, so tests import it directly.
import {defaultCustomerId} from '@/lib/default-customer';
import {customerActionNeedsStepUp,customerUpdateNeedsStepUp} from '@/lib/step-up';
import type {Customer,MaintenanceWindow} from '@/lib/server/identity/customers';
import type {MultipleCustomersView} from '@/lib/server/identity/multiple-customers';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';

/** A portal account as offered in the technician access drawer; `owner` = global Owner, who sees every customer anyway. */
export type CustomerTechnicianUser={id:string;label:string;email:string;status:string;owner:boolean};
export type CustomerTechnicianGroup={id:string;name:string;enabled:boolean};
export type CustomerAssignment={customerId:string;subjectType:'user'|'group';subjectId:string};
/** What GET /api/customers answers (app/api/customers/route.ts) for the customers page; multipleCustomers is the setting "Multiple customers". */
export type CustomersView={customers:Customer[];technicians?:{users:CustomerTechnicianUser[];groups:CustomerTechnicianGroup[]};assignments?:CustomerAssignment[];multipleCustomers?:MultipleCustomersView};
export type {MultipleCustomersView};

export const dayLabels:readonly MessageKey[]=['customers.day.mon','customers.day.tue','customers.day.wed','customers.day.thu','customers.day.fri','customers.day.sat','customers.day.sun'];
export const maintenanceDurations:readonly number[]=[30,60,120,180,240,360,480,720];
const pad=(value:number)=>String(value).padStart(2,'0');
const clock=(minutes:number)=>`${pad(Math.floor(minutes/60)%24)}:${pad(minutes%60)}`;

export function durationLabel(minutes:number,locale:Locale=defaultLocale){return minutes<60?translate(locale,'customers.duration.minutes',{minutes}):minutes%60===0?translate(locale,'customers.duration.hours',{hours:minutes/60}):translate(locale,'customers.duration.hoursMinutes',{hours:Math.floor(minutes/60),minutes:minutes%60});}
export function maintenanceDaysText(days:readonly number[],locale:Locale=defaultLocale){
 const sorted=[...days].sort((a,b)=>a-b);
 if(sorted.length===7)return translate(locale,'customers.days.daily');
 if(sorted.join()==='1,2,3,4,5')return translate(locale,'customers.days.weekdays');
 return sorted.map(day=>translate(locale,dayLabels[day-1])).join(', ');
}
/** Days, start and end time and time zone, or none. The window may reach past midnight. */
export function maintenanceWindowText(window:MaintenanceWindow|null,locale:Locale=defaultLocale){
 if(!window)return translate(locale,'customers.window.none');
 const [hours,minutes]=window.start.split(':').map(Number),start=hours*60+minutes;
 return translate(locale,'customers.window.text',{days:maintenanceDaysText(window.days,locale),start:window.start,end:clock((start+window.durationMinutes)%1440),zone:window.timeZone});
}
/** Column text: none, users, groups or both, comma-separated. */
export function technicianText(userCount:number,groupCount:number,locale:Locale=defaultLocale){
 const parts=[...(userCount?[translate(locale,'customers.users',{count:userCount})]:[]),...(groupCount?[translate(locale,'customers.groups',{count:groupCount})]:[])];
 return parts.length?parts.join(', '):translate(locale,'fleet.issues.none');
}
export function retentionText(days:number|null,locale:Locale=defaultLocale){return days===null?translate(locale,'customers.standard'):translate(locale,'customers.days',{count:days});}

/** The ids of the users or groups assigned to a customer, in the order of the answer. */
export function assignedIds(assignments:readonly CustomerAssignment[]|undefined,customerId:string,type:'user'|'group'):string[]{
 return (assignments??[]).filter(entry=>entry.customerId===customerId&&entry.subjectType===type).map(entry=>entry.subjectId);
}
/** The create drawer warns while the portal has only the default customer: the new customer switches the customer boundary on. */
export function firstCustomerNotice(view:Pick<CustomersView,'customers'>|null):boolean{
 return !!view&&view.customers.every(customer=>customer.id===defaultCustomerId);
}
/** Whether the page shows the customers (table, Create customer, row menus): only while "Multiple customers" is on. */
export const multipleCustomersOn=(view:Pick<CustomersView,'multipleCustomers'>|null)=>view?.multipleCustomers?.enabled===true;
/**
 * Why the switch "Multiple customers" cannot be turned off: while it is on and other customers exist, the plural
 * reason with their count. undefined = the switch can change (off, or on with only the default customer).
 */
export function multipleCustomersBlock(setting:MultipleCustomersView|undefined,locale:Locale=defaultLocale):string|undefined{
 return setting?.enabled&&setting.otherCustomers>0?translate(locale,'customers.multiple.offBlocked',{count:setting.otherCustomers}):undefined;
}
/** The blocked reasons of the row menu entries of one customer. undefined = available. */
export type CustomerRowBlocks={manage?:string;access?:string;status?:string};
/**
 * The reasons, never hidden: Deactivate of the first customer with customers.defaultProtected (it wins); every write
 * entry with kit.busy while a customer request runs.
 */
export function customerRowBlocks(customer:Pick<Customer,'id'|'status'>,busy:boolean,locale:Locale=defaultLocale):CustomerRowBlocks{
 const busyReason=busy?translate(locale,'kit.busy'):undefined;
 const first=customer.id===defaultCustomerId&&customer.status==='active';
 return {
  manage:busyReason,
  access:busyReason,
  status:first?translate(locale,'customers.defaultProtected'):busyReason,
 };
}

/** The counts that keep a customer from being deleted, in the order of the reason. */
const deleteItems=[['deviceCount','customers.delete.items.devices'],['groupCount','customers.delete.items.groups'],['runbookCount','customers.delete.items.runbooks'],
 ['templateCount','customers.delete.items.templates'],['roleCount','customers.delete.items.roles']] as const satisfies readonly (readonly [keyof Customer,MessageKey])[];
export type CustomerDeleteCounts=Pick<Customer,'id'|'name'|'deviceCount'|'groupCount'|'runbookCount'|'templateCount'|'roleCount'>;
/**
 * Why "Delete customer…" cannot run, never hidden (the row menu and the DangerZone of the manage drawer). In this order:
 * the first customer; the data it still holds, its non-zero counts joined as a list in the console language; a running
 * customer request. undefined = the customer can be deleted. The server checks the same (deleteCustomer).
 */
export function customerDeleteBlock(customer:CustomerDeleteCounts,busy:boolean,locale:Locale=defaultLocale):string|undefined{
 if(customer.id===defaultCustomerId)return translate(locale,'customers.delete.defaultBlocked');
 // Counts the answer may lack (an older list) count as 0; the server refuses the delete anyway.
 const items=deleteItems.filter(([field])=>Number(customer[field]??0)>0).map(([field,key])=>translate(locale,key,{count:Number(customer[field])}));
 if(items.length)return translate(locale,'customers.delete.blocked',{name:customer.name,items:new Intl.ListFormat(locale,{type:'conjunction'}).format(items)});
 return busy?translate(locale,'kit.busy'):undefined;
}
/** The default customer's name from the list, for the notice of the last delete. */
export const defaultCustomerName=(view:Pick<CustomersView,'customers'>|null)=>view?.customers.find(customer=>customer.id===defaultCustomerId)?.name??'';

// ---- Manage form ----
export type CustomerForm={name:string;contactName:string;contactEmail:string;contactPhone:string;ownRetention:boolean;retentionDays:string;windowOn:boolean;days:number[];start:string;duration:number;timeZone:string};
export type CustomerFormField='name'|'retentionDays'|'days';
export function browserTimeZone(){try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}}
let zoneCache:string[]|null=null;
/** The time zones of the browser, with the current one first when the browser does not know it. */
export function customerTimeZones(current:string){
 if(!zoneCache){try{zoneCache=typeof Intl.supportedValuesOf==='function'?Intl.supportedValuesOf('timeZone'):[];}catch{zoneCache=[];}}
 return zoneCache.includes(current)?zoneCache:[current,...zoneCache];
}
/** The duration choices, with a stored value outside the list kept in order. */
export const durationChoices=(current:number)=>maintenanceDurations.includes(current)?[...maintenanceDurations]:[...maintenanceDurations,current].sort((a,b)=>a-b);
/** The form of a customer, or the empty form of a new one (Mon–Fri 22:00 for 4 hours in the browser's zone). */
export function customerFormOf(customer:Customer|null):CustomerForm{
 const window=customer?.maintenanceWindow??null;
 return {name:customer?.name??'',contactName:customer?.contactName??'',contactEmail:customer?.contactEmail??'',contactPhone:customer?.contactPhone??'',
  ownRetention:customer?.auditRetentionDays!=null,retentionDays:String(customer?.auditRetentionDays??30),
  windowOn:!!window,days:window?.days??[1,2,3,4,5],start:window?.start??'22:00',duration:window?.durationMinutes??240,timeZone:window?.timeZone??browserTimeZone()};
}
/**
 * The request body for create and update, without action, id and revision. An unusable number stays as typed, so
 * the server answers with its retention message instead of using the default (the form validates before).
 */
export function customerPayload(form:CustomerForm):Record<string,unknown>{
 const days=form.retentionDays.trim(),retention=Number(days);
 return {name:form.name,contactName:form.contactName,contactEmail:form.contactEmail,contactPhone:form.contactPhone,
  auditRetentionDays:form.ownRetention?(days!==''&&Number.isFinite(retention)?retention:form.retentionDays):null,
  maintenanceWindow:form.windowOn?{days:[...form.days].sort((a,b)=>a-b),start:form.start,durationMinutes:form.duration,timeZone:form.timeZone}:null};
}
/** Whether two forms send the same body. */
export const sameCustomerForm=(a:CustomerForm,b:CustomerForm)=>JSON.stringify(customerPayload(a))===JSON.stringify(customerPayload(b));
/** The field errors of a form: an empty name, a retention outside 1–3650 whole days, a window without a day. */
export function customerFormErrors(form:CustomerForm):Partial<Record<CustomerFormField,MessageKey>>{
 const errors:Partial<Record<CustomerFormField,MessageKey>>={};
 if(!form.name.trim())errors.name='customers.error.name';
 const days=form.retentionDays.trim();
 if(form.ownRetention&&!(/^\d+$/.test(days)&&Number(days)>=1&&Number(days)<=3650))errors.retentionDays='customers.error.retention';
 if(form.windowOn&&!form.days.length)errors.days='customers.error.days';
 return errors;
}
/** The form with a weekday turned on or off; the days stay sorted. */
export const toggleCustomerDay=(form:CustomerForm,day:number):CustomerForm=>({...form,days:form.days.includes(day)?form.days.filter(entry=>entry!==day):[...form.days,day].sort((a,b)=>a-b)});

// ---- Technician access ----
export const sameSelection=(a:readonly string[],b:readonly string[])=>a.length===b.length&&[...a].sort().join()===[...b].sort().join();
/** Whether one of the values contains the search, compared in the console language. */
export const technicianMatches=(query:string,locale:Locale,...values:string[])=>{const needle=query.trim().toLocaleLowerCase(locale);return !needle||values.some(value=>value.toLocaleLowerCase(locale).includes(needle));};
/** The hint of a user row: the email, then "Owner" and "Deactivated" when they apply. */
export function technicianUserHint(user:CustomerTechnicianUser,locale:Locale=defaultLocale):string{
 return [user.email,...(user.owner?[translate(locale,'customers.technicians.owner')]:[]),...(user.status==='disabled'?[translate(locale,'fleet.disabled')]:[])].filter(Boolean).join(' · ');
}
/** The hint of a user group row: "User group", then "Deactivated" when it is disabled. */
export function technicianGroupHint(group:CustomerTechnicianGroup,locale:Locale=defaultLocale):string{
 return [translate(locale,'customers.technicians.group'),...(group.enabled?[]:[translate(locale,'fleet.disabled')])].join(' · ');
}

/**
 * Whether a customer request opens the MFA dialog before it is sent. The technicians always; an edit when its own
 * audit retention gets shorter than the loaded one (customerUpdateNeedsStepUp). When either side is "use the instance
 * retention", the client does not know that value: the edit goes out at once and a 403 opens the dialog.
 */
export function customerBodyNeedsStepUp(body:Record<string,unknown>,customers:readonly Pick<Customer,'id'|'auditRetentionDays'>[]|undefined):boolean{
 if(customerActionNeedsStepUp(body.action))return true;
 if(body.action!=='update')return false;
 const before=customers?.find(customer=>customer.id===body.id)?.auditRetentionDays??null,after=body.auditRetentionDays;
 return before!==null&&typeof after==='number'&&customerUpdateNeedsStepUp(before,after);
}
