import {guid} from '../context';
import {defaultLocale} from '../../i18n/locale';
import {translate} from '../../i18n/translate';
import {customerAccessGuard,principal} from './access';
import {canSql} from './policy/can';
import {defaultCustomerId} from '../../default-customer';
import type {Viewer} from '../../types';
import {db,sql} from '../db';

// Customer model (docs/customers.md). Nothing here writes: customer
// administration is in lib/server/identity/customer-admin.ts (createCustomer,
// updateCustomer, setCustomerStatus, setCustomerTechnicians, deleteCustomer), removing
// technicians in lib/server/identity/customer-technicians.ts and the installers
// in lib/server/agent/customer-installers.ts.
export {defaultCustomerId};
/** Weekly window: ISO weekdays 1 (Monday) to 7 (Sunday) ascending, start as HH:MM, duration in minutes, IANA time zone. */
export type MaintenanceWindow={days:number[];start:string;durationMinutes:number;timeZone:string};
export type Customer={id:string;name:string;status:'active'|'disabled';contactName:string;contactEmail:string;contactPhone:string;createdAt:number;updatedAt:number;
 /** null: the instance retention of the maintenance page. */
 auditRetentionDays:number|null;maintenanceWindow:MaintenanceWindow|null;revision:number;
 /** Devices with revoked=0. */
 deviceCount:number;groupCount:number;
 /** Runbooks and automation templates with archived=0, and the roles of the customer: with the devices and groups the data that keeps a delete refused (deleteCustomer). */
 runbookCount:number;templateCount:number;roleCount:number};
// Texts of the customer route.
export const customerOwnerOnlyMessage=translate(defaultLocale,'apiError.customer.ownerOnly');
export const customerUnknownActionMessage=translate(defaultLocale,'apiError.customer.unknownAction');
/** 400: userIds/groupIds are not lists of existing users and user groups, or longer than 1000. */
export const customerTechniciansMessage=translate(defaultLocale,'apiError.customer.technicians');
/** 404: the customer does not exist (any more). The text lives in the error catalog (CUSTOMER_MISSING). */
export {customerMissingMessage} from '../../errors/codes';
/** 409: the customer revision changed since the page read it. */
export const customerConcurrentMessage=translate(defaultLocale,'apiError.customer.concurrent');
/** A customer outside the viewer's boundary answers like a missing one (device groups, catalogs). The text lives in the error catalog (default of CUSTOMER_MISSING). */
export {customerUnavailableMessage} from '../../errors/codes';

type Row=Omit<Customer,'maintenanceWindow'>&{maintenanceDays:number|null;maintenanceStart:number|null;maintenanceDuration:number|null;maintenanceTimeZone:string|null};
const columns=sql`customer.id,customer.name,customer.status,customer.contact_name AS "contactName",customer.contact_email AS "contactEmail",customer.contact_phone AS "contactPhone",customer.created_at AS "createdAt",customer.updated_at AS "updatedAt",
 customer.audit_retention_days AS "auditRetentionDays",customer.maintenance_days AS "maintenanceDays",customer.maintenance_start AS "maintenanceStart",customer.maintenance_duration AS "maintenanceDuration",customer.maintenance_time_zone AS "maintenanceTimeZone",customer.revision,
 (SELECT count(*) FROM servers device WHERE device.customer_id=customer.id AND device.revoked=0) AS "deviceCount",
 (SELECT count(*) FROM device_groups grp WHERE grp.customer_id=customer.id) AS "groupCount",
 (SELECT count(*) FROM runbooks runbook WHERE runbook.customer_id=customer.id AND runbook.archived=0) AS "runbookCount",
 (SELECT count(*) FROM automation_templates template WHERE template.customer_id=customer.id AND template.archived=0) AS "templateCount",
 (SELECT count(*) FROM rbac_roles customer_role WHERE customer_role.customer_id=customer.id) AS "roleCount"`;

const twoDigits=(value:number)=>String(value).padStart(2,'0');
/** Bit 0 = Monday … bit 6 = Sunday, as stored in customers.maintenance_days. */
export function maintenanceDaysFromMask(mask:number):number[]{return [1,2,3,4,5,6,7].filter(day=>(mask&(1<<(day-1)))!==0);}
export function maintenanceDaysMask(days:readonly number[]):number{return days.reduce((mask,day)=>mask|(1<<(day-1)),0);}
/** Minutes after midnight as HH:MM. */
export function maintenanceStartText(minutes:number):string{return `${twoDigits(Math.floor(minutes/60))}:${twoDigits(minutes%60)}`;}

function customerFromRow({maintenanceDays,maintenanceStart,maintenanceDuration,maintenanceTimeZone,...row}:Row):Customer{
 const complete=maintenanceDays!==null&&maintenanceStart!==null&&maintenanceDuration!==null&&maintenanceTimeZone!==null;
 return {...row,auditRetentionDays:row.auditRetentionDays===null?null:Number(row.auditRetentionDays),revision:Number(row.revision),deviceCount:Number(row.deviceCount),groupCount:Number(row.groupCount),runbookCount:Number(row.runbookCount),templateCount:Number(row.templateCount),roleCount:Number(row.roleCount),
  maintenanceWindow:complete?{days:maintenanceDaysFromMask(Number(maintenanceDays)),start:maintenanceStartText(Number(maintenanceStart)),durationMinutes:Number(maintenanceDuration),timeZone:maintenanceTimeZone}:null};
}

export async function listCustomers():Promise<Customer[]>{
 return (await db().query<Row>(sql`SELECT ${columns} FROM customers customer ORDER BY lower(customer.name),customer.id`)).map(customerFromRow);
}
export async function customerById(id:unknown):Promise<Customer|null>{
 if(!guid(id))return null;
 const row=await db().one<Row>(sql`SELECT ${columns} FROM customers customer WHERE customer.id=${id}`);
 return row?customerFromRow(row):null;
}
export async function deviceCustomerId(serverId:unknown):Promise<string|null>{
 if(typeof serverId!=='string')return null;
 return await db().one<{"customer_id":string}>(sql`SELECT customer_id FROM servers WHERE id=${serverId}`).then(row=>row===null?null:row.customer_id)??null;
}
export async function groupCustomerId(groupId:unknown):Promise<string|null>{
 if(typeof groupId!=='string')return null;
 return await db().one<{"customer_id":string}>(sql`SELECT customer_id FROM device_groups WHERE id=${groupId}`).then(row=>row===null?null:row.customer_id)??null;
}

/** The active customers the viewer sees under the customer boundary (lib/server/identity/access.ts customerAccessGuard), ordered like listCustomers. */
export async function visibleCustomers(viewer:Viewer):Promise<{id:string;name:string}[]>{
 const boundary=customerAccessGuard(sql`customer.id`,sql`${principal(viewer)}`);
 return (await db().query<{id:string;name:string}>(sql`SELECT customer.id,customer.name FROM customers customer WHERE customer.status='active' AND ${boundary} ORDER BY lower(customer.name),customer.id`)).map(row=>({id:row.id,name:row.name}));
}

export type CustomerTechnicianUser={id:string;label:string;email:string;status:string;
 /** Active global Owner: sees every customer without an assignment. */
 owner:boolean};
export type CustomerTechnicianGroup={id:string;name:string;enabled:boolean};
export type CustomerAssignment={customerId:string;subjectType:'user'|'group';subjectId:string};
/** Every user and user group that can be assigned (limits as in the RBAC data), and all stored assignments. */
export async function listCustomerTechnicians():Promise<{users:CustomerTechnicianUser[];groups:CustomerTechnicianGroup[];assignments:CustomerAssignment[]}>{
 const d=db(),owner=canSql(sql`technician.auth_principal`,'instance.owner');
 const [users,groups,assignments]=await Promise.all([
  d.query<{id:string;displayName:string;username:string;email:string;status:string;owner:number}>(sql`SELECT technician.id,technician.display_name AS "displayName",technician.username,technician.email,technician.status,(${owner}) AS owner FROM local_users technician ORDER BY technician.username LIMIT 2000`).then(results=>({results})),
  d.query<{id:string;name:string;enabled:number}>(sql`SELECT id,name,enabled FROM user_groups ORDER BY name LIMIT 1000`).then(results=>({results})),
  d.query<CustomerAssignment>(sql`SELECT customer_id AS "customerId",principal_type AS "subjectType",principal_id AS "subjectId" FROM customer_assignments ORDER BY customer_id,principal_type,principal_id`).then(results=>({results})),
 ]);
 return {
  users:users.results.map(user=>({id:user.id,label:user.displayName||user.username,email:user.email,status:user.status,owner:!!user.owner})),
  groups:groups.results.map(group=>({id:group.id,name:group.name,enabled:!!group.enabled})),
  assignments:assignments.results.map(row=>({customerId:row.customerId,subjectType:row.subjectType,subjectId:row.subjectId})),
 };
}
