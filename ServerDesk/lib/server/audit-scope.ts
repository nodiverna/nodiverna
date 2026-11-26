import {devicePermissionGuard,principal,type SqlGuard} from './identity/access';
import {canSql} from './identity/policy/can';
import {featureWriteGuard} from './identity/feature-authorization';
import type {Viewer} from '../types';
import {sql} from './db';
import {accountMatchSql,accountNameSql} from './identity/account-names';

// Apply live RBAC and session checks in the data query. Target text never
// grants access to a device's audit history.
// The rights subquery does not refer to the audit row, so the database checks them once
// per given device and query, not once per audit row; still live.
export function deviceAuditGuard(viewer:Viewer,serverIds:string[]):SqlGuard{
 const view=devicePermissionGuard(sql`audit_target.value`,sql`audit_actor.principal`,'view');
 const security=devicePermissionGuard(sql`audit_target.value`,sql`audit_actor.principal`,'security.events');
 return featureWriteGuard(viewer,sql`a.scope='device' AND a.server_id IN (SELECT audit_target.value FROM jsonb_array_elements_text(${JSON.stringify(serverIds)}::jsonb) audit_target CROSS JOIN (SELECT ${principal(viewer)}::text AS principal) audit_actor WHERE (${view}) AND (${security}))`);
}
export function portalAuditGuard(viewer:Viewer):SqlGuard{
 const owner=canSql(sql`audit_actor.principal`,'instance.owner');
 return featureWriteGuard(viewer,sql`a.scope='portal' AND a.server_id IS NULL AND EXISTS (SELECT 1 FROM (SELECT ${principal(viewer)}::text AS principal) audit_actor WHERE ${owner})`);
}
// Every row names its customer, if any (device rows by trigger, customer
// entries explicitly); the name also for a disabled customer, and the last name
// of a deleted customer from its tombstone (removed_customers), then with
// customerRemoved true.
export const auditSelect=sql`SELECT a.id,a.at,coalesce(${accountNameSql(sql`actor_user`,sql`a.actor`)},'') AS actor,a.action,a.target,a.server_id AS "serverId",a.scope,a.customer_id AS "customerId",coalesce(audit_customer.name,audit_removed_customer.name) AS "customerName",(audit_customer.id IS NULL AND audit_removed_customer.id IS NOT NULL) AS "customerRemoved" FROM audit a LEFT JOIN local_users actor_user ON ${accountMatchSql(sql`actor_user`,sql`a.actor`)} LEFT JOIN customers audit_customer ON audit_customer.id=a.customer_id LEFT JOIN removed_customers audit_removed_customer ON audit_removed_customer.id=a.customer_id`;
