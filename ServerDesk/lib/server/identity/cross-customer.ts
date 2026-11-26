import {HttpError,now} from '../context';
import {defaultLocale} from '../../i18n/locale';
import {translate} from '../../i18n/translate';
import {crossCustomerPermission,globalPermissionGuard,hasGlobalPermission,principal,type SqlGuard} from './access';
import type {Viewer} from '../../types';
import {db,sql,type Step} from '../db';

// Cross-customer actions (docs/customers.md "Actions for
// multiple customers"). It decides from servers.customer_id whether the target
// devices of a request belong to two or more customers and writes one customer
// entry per customer. Only then it asks the gate authorizeCrossCustomerAction.
// Single-customer actions never reach the gate.

/** HttpError text for code CROSS_CUSTOMER_FORBIDDEN: the viewer lacks portal.msp.crossCustomer. */
export const crossCustomerRightMessage=translate(defaultLocale,'apiError.crossCustomer.right');
/** HttpError 400 for a runbook schedule over devices of several customers; the UI shows the same key. */
export const crossCustomerScheduleMessage=translate(defaultLocale,'apiError.crossCustomer.schedule');

/**
 * Gate for an action whose target devices belong to two or more customers.
 * Throws HttpError 403 CROSS_CUSTOMER_FORBIDDEN without the global right
 * portal.msp.crossCustomer (Owners hold it through '*'). Otherwise returns a
 * guard that holds while the viewer still holds the right; put it into the
 * writing statement, so a right revoked between this check and the commit
 * writes nothing.
 */
export async function authorizeCrossCustomerAction(viewer:Viewer):Promise<SqlGuard>{
 if(!await hasGlobalPermission(viewer,crossCustomerPermission))throw new HttpError('apiError.crossCustomer.right');
 return globalPermissionGuard(sql`${principal(viewer)}`,crossCustomerPermission);
}

/** A customer touched by an action and its target devices. */
export type TargetCustomer={id:string;serverIds:string[]};
/** The customers of an action's targets and, for two or more, the gate's guard. */
export type CustomerScope={customers:TargetCustomer[];total:number;crossCustomer:boolean;guard:SqlGuard};
const neutral:SqlGuard=sql`TRUE`;

/** The customers of the given devices, sorted by id, with their devices. Unknown ids belong to no customer. */
export async function targetCustomers(serverIds:string[]):Promise<TargetCustomer[]>{
 const rows=(await db().query<{id:string;customer_id:string}>(sql`SELECT device.id,device.customer_id FROM servers device WHERE device.id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify([...new Set(serverIds)])}::jsonb)) ORDER BY device.customer_id,device.id`));
 const customers=new Map<string,string[]>();
 for(const row of rows)customers.set(row.customer_id,[...(customers.get(row.customer_id)??[]),row.id]);
 return [...customers].map(([id,devices])=>({id,serverIds:devices}));
}
/**
 * Runs after the per-device checks of an action. With targets of fewer than two
 * customers it returns a neutral guard and never calls the gate. Otherwise it
 * calls authorizeCrossCustomerAction (403 CROSS_CUSTOMER_FORBIDDEN) and
 * returns its guard for the writing statement.
 */
export async function authorizeTargetCustomers(v:Viewer,serverIds:string[]):Promise<CustomerScope>{
 const customers=await targetCustomers(serverIds),total=new Set(serverIds).size;
 if(customers.length<2)return {customers,total,crossCustomer:false,guard:neutral};
 return {customers,total,crossCustomer:true,guard:await authorizeCrossCustomerAction(v)};
}
/**
 * After a commit that wrote nothing: runs the gate again for a cross-customer
 * action, so a right revoked meanwhile answers with the gate's
 * 403 instead of the action's general 404 or 409.
 */
export async function recheckCrossCustomer(v:Viewer,scope:CustomerScope){if(scope.crossCustomer)await authorizeCrossCustomerAction(v);}
/**
 * One customer entry per customer of a cross-customer action, for the action's
 * own batch: a portal row (Owner-only portal log) with the customer set and the
 * target "{target} · {k} von {N} Geräten". `condition` ties the rows to the
 * action's own write, e.g. EXISTS of the new run. Single-customer actions get none.
 */
/**
 * The stored target of a customer entry, "{target} · {k} von {N} Geräten". Stored rows keep this German text; the
 * audit log shows the count in the viewer's language (ui/devices/history/audit-display.ts auditTargetView).
 */
export const crossCustomerAuditTarget=(target:string,shown:number,total:number)=>`${target} · ${shown} von ${total} Geräten`;
export function customerEntries(scope:CustomerScope,entry:{actor:string;action:string;target:string;condition:SqlGuard}):Step[]{
 if(!scope.crossCustomer)return [];
 const at=now();
 return scope.customers.map(customer=>sql`INSERT INTO audit(at,actor,action,target,server_id,scope,customer_id) SELECT ${at},${entry.actor},${entry.action},${crossCustomerAuditTarget(entry.target,customer.serverIds.length,scope.total)},NULL,'portal',${customer.id} WHERE ${entry.condition}`);
}
/** Live SQL: the devices of the JSON array bound to its one placeholder belong to at most one customer. */
export const singleCustomerTargets=(targets:string|string[])=>sql`(SELECT count(DISTINCT single_customer.customer_id) FROM servers single_customer WHERE single_customer.id IN (SELECT jsonb_array_elements_text(${typeof targets==='string'?targets:JSON.stringify(targets)}::jsonb)))<2`;
