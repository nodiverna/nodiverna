import {guid,HttpError} from '../context';
import {defaultLocale} from '../../i18n/locale';
import {translate,type MessageKey} from '../../i18n/translate';
import type {Viewer} from '../../types';
import {crossCustomerPermission,crossCustomerPermissionLabelKey} from '../../cross-customer-right';
import {customerSeparationSql,separationDefaultCustomerId} from '../../../runtime/customer-separation.mjs';
import {commitAll,db,dbNow,sql,type Sql} from '../db';

// Each right is {id,labelKey}: the name is a catalog key (permission.<id>), so the
// client shows it in the console language. The order of the ids is stored JSON (see below).
export const permissionDefinitions=[
 {id:'view',labelKey:'permission.view'}, {id:'diagnose',labelKey:'permission.diagnose'},
 {id:'security.events',labelKey:'permission.security.events'}, {id:'files.read',labelKey:'permission.files.read'},
 {id:'files.write',labelKey:'permission.files.write'}, {id:'terminal',labelKey:'permission.terminal'}, {id:'rdp',labelKey:'permission.rdp'},
 {id:'runbooks',labelKey:'permission.runbooks'}, {id:'runbooks.read',labelKey:'permission.runbooks.read'},
 {id:'runbooks.execute',labelKey:'permission.runbooks.execute'}, {id:'runbooks.outputs',labelKey:'permission.runbooks.outputs'}, {id:'runbooks.manage',labelKey:'permission.runbooks.manage'},
 {id:'manage',labelKey:'permission.manage'}, {id:'update',labelKey:'permission.update'},
 {id:'drift.read',labelKey:'permission.drift.read'}, {id:'drift.contents',labelKey:'permission.drift.contents'}, {id:'drift.manage',labelKey:'permission.drift.manage'},
 {id:'desired.read',labelKey:'permission.desired.read'},
 {id:'desired.manage',labelKey:'permission.desired.manage'},
 {id:'desired.apply',labelKey:'permission.desired.apply'},
 {id:'groups.manage',labelKey:'permission.groups.manage'},
 {id:'alerts.manage',labelKey:'permission.alerts.manage'},
 // Microsoft Defender (docs/local-identity-rbac.md): detections and exclusions hold paths and user names; control is used from Defender slice 2.
 // After the rights before them, so that a fresh seed and drizzle/0014_defender_rights.sql give the same stored JSON.
 {id:'defender.read',labelKey:'permission.defender.read'}, {id:'defender.control',labelKey:'permission.defender.control'},
 // Agent plugins and server roles (docs/agent-plugins.md, docs/local-identity-rbac.md). Last in the list, so that a
 // fresh seed and the migration drizzle/0019_agent_plugins.sql give the same stored JSON. dhcp.manage, dns.read and
 // dns.manage gate nothing yet; later plugin releases use them.
 {id:'plugins.manage',labelKey:'permission.plugins.manage'}, {id:'dhcp.read',labelKey:'permission.dhcp.read'}, {id:'dhcp.manage',labelKey:'permission.dhcp.manage'},
 {id:'dns.read',labelKey:'permission.dns.read'}, {id:'dns.manage',labelKey:'permission.dns.manage'}
] as const satisfies readonly {id:string;labelKey:MessageKey}[];
export const portalPermissionDefinitions=[
 {id:'portal.roleAssignments.manage',labelKey:'permission.portal.roleAssignments.manage'},
 {id:'portal.users.manage',labelKey:'permission.portal.users.manage'},
 {id:'portal.userGroups.manage',labelKey:'permission.portal.userGroups.manage'},
 {id:'portal.roles.manage',labelKey:'permission.portal.roles.manage'},
 {id:'portal.operator',labelKey:'permission.portal.operator'},
 // Notification channels and the delivery log (docs/notifications.md). Global only;
 // Owners hold it through '*', the built-in roles Reader and Operator do not.
 {id:'portal.notifications.manage',labelKey:'permission.portal.notifications.manage'},
 // Start an action on devices of two or more customers (docs/customers.md).
 // Owners hold it through '*'; only an Owner grants it (lib/server/identity/rbac.ts).
 {id:crossCustomerPermission,labelKey:crossCustomerPermissionLabelKey}
] as const satisfies readonly {id:string;labelKey:MessageKey}[];
/** The right for cross-customer actions. Global only, like every portal right. Defined in lib/cross-customer-right.ts for the UI as well. */
export {crossCustomerPermission};
export type Permission=typeof permissionDefinitions[number]['id'];
export type PortalPermission=typeof portalPermissionDefinitions[number]['id'];
export const allPermissions=permissionDefinitions.map(p=>p.id);
export const allPortalPermissions=portalPermissionDefinitions.map(p=>p.id);
const readPermissions:Permission[]=['view','diagnose','security.events','files.read','runbooks.read','runbooks.outputs','drift.read','drift.contents','desired.read','defender.read','dhcp.read','dns.read'];
// Ceilings of the per-group grant editor (set-grant, app/api/access/route.ts) and
// the rights of the built-in roles Reader and Operator (lib/server/identity/rbac.ts). Live
// authorization is additive RBAC, with no account role acting as a ceiling.
export type GrantRole='viewer'|'operator'|'admin';
export const rolePermissions:Record<GrantRole,Permission[]>={viewer:readPermissions,operator:allPermissions.filter(p=>p!=='groups.manage'),admin:allPermissions};
export const principal=(v:Viewer)=>v.principal??'private:'+v.label.trim().toLowerCase();
/**
 * A condition of the committing statement: an Sql fragment with its own bind
 * parameters. Expressions passed to the guard producers are fragments too, for
 * example sql`servers.id` for a column or sql`${id}` for a value.
 */
export type SqlGuard=Sql;
const denied=sql`FALSE`;
/**
 * The MFA anchor of a principal: its mfa_accounts row, or for an account from
 * Microsoft Entra ID (docs/entra-id.md) the account itself. An Entra account has
 * no mfa_accounts row; its MFA ran at Entra, and its MFA session exists only
 * bound to the primary session of that sign-in (lib/server/identity/entra/sign-in.ts).
 */
export function mfaAnchorSql(principalExpression:Sql):SqlGuard{
 return sql`(EXISTS (SELECT 1 FROM mfa_accounts mfa_anchor WHERE mfa_anchor.principal=${principalExpression}) OR EXISTS (SELECT 1 FROM local_users entra_anchor WHERE entra_anchor.auth_principal=${principalExpression} AND entra_anchor.identity_source='entra'))`;
}
/**
 * The MFA enrollment of a principal at time `at` (app time, a value or a column):
 * its mfa_accounts row created at or before `at`, or an active account from
 * Microsoft Entra ID created at or before `at`, whose MFA runs at Entra. Runbook
 * approvals (lib/server/automation/automation-runbooks.ts, lib/server/automation/automation-scopes.ts) use it, so a
 * new enrollment or a new Entra account never validates an older approval.
 */
export function mfaEnrollmentSql(principalExpression:Sql,at:Sql|number):SqlGuard{
 return sql`(EXISTS (SELECT 1 FROM mfa_accounts mfa_enrollment WHERE mfa_enrollment.principal=${principalExpression} AND mfa_enrollment.created_at<=${at}) OR EXISTS (SELECT 1 FROM local_users entra_enrollment WHERE entra_enrollment.auth_principal=${principalExpression} AND entra_enrollment.identity_source='entra' AND entra_enrollment.status='active' AND entra_enrollment.created_at<=${at}))`;
}
// A request admitted before logout/reset must not commit after its password or
// MFA session is revoked. Scheduled automation has a version-only stamp. A viewer
// without a stamp fails closed, for example when a spread or serialization
// accidentally dropped the internal stamp.
export function viewerWriteGuard(v:Viewer):SqlGuard{
 const authorization=v.authorization;if(!authorization)return denied;
 if(!Number.isSafeInteger(authorization.authVersion)||authorization.authVersion<1)return denied;
 const primary=authorization.sessionHash===undefined?sql``:sql` AND EXISTS (SELECT 1 FROM local_auth_sessions write_primary JOIN mfa_sessions write_mfa ON write_mfa.token_hash=write_primary.mfa_hash AND write_mfa.principal=write_user.auth_principal WHERE write_primary.token_hash=${authorization.sessionHash} AND write_primary.user_id=write_user.id AND write_primary.auth_version=write_user.auth_version AND write_primary.expires_at>${dbNow} AND write_mfa.idle_expires_at>${dbNow} AND write_mfa.expires_at>${dbNow} AND ${mfaAnchorSql(sql`write_mfa.principal`)})`;
 return sql`EXISTS (SELECT 1 FROM local_users write_user WHERE write_user.auth_principal=${principal(v)} AND write_user.status='active' AND write_user.auth_version=${authorization.authVersion}${primary})`;
}

/** The stored permissions of a role row as JSON array elements; anything but a JSON array grants nothing. */
export const permissionElements=(role:Sql)=>sql`jsonb_array_elements_text(CASE WHEN ${role}.permissions IS JSON ARRAY THEN ${role}.permissions::jsonb ELSE '[]'::jsonb END)`;
const subjects=(assignment:Sql,user:Sql)=>sql`((${assignment}.principal_type='user' AND ${assignment}.principal_id=${user}.id) OR (${assignment}.principal_type='group' AND EXISTS (SELECT 1 FROM user_group_members rbac_member JOIN user_groups rbac_group ON rbac_group.id=rbac_member.group_id WHERE rbac_member.user_id=${user}.id AND rbac_member.group_id=${assignment}.principal_id AND rbac_group.enabled=1)))`;
const roleAllows=(role:Sql,permissions:string[])=>sql`EXISTS (SELECT 1 FROM ${permissionElements(role)} rbac_right WHERE rbac_right.value='*' OR rbac_right.value IN (SELECT jsonb_array_elements_text(${JSON.stringify(permissions)}::jsonb)))`;
const permissionAliases=(permission:string)=>permission==='runbooks.read'||permission==='runbooks.execute'?[permission,'runbooks']:[permission];
export function activePrincipalGuard(principalExpression:Sql):SqlGuard{return sql`EXISTS (SELECT 1 FROM local_users rbac_user WHERE rbac_user.auth_principal=${principalExpression} AND rbac_user.status='active')`;}
// Customer boundary (docs/customers.md). While only the default customer exists,
// every principal sees every customer. While a second customer exists
// (customerSeparationSql; it ends when the last other customer is deleted) only
// an active global Owner, or an active user assigned to the customer directly or
// through an enabled user group, sees it. The customer status plays no role.
// `user` is an active local_users row of the surrounding query.
const singleCustomer=sql`NOT (${customerSeparationSql})`;
const globalOwnerSubject=(user:Sql)=>sql`EXISTS (SELECT 1 FROM role_assignments boundary_owner JOIN rbac_roles boundary_role ON boundary_role.id=boundary_owner.role_id WHERE boundary_owner.scope_type='global' AND boundary_owner.scope_id='*' AND ${subjects(sql`boundary_owner`,user)} AND EXISTS (SELECT 1 FROM ${permissionElements(sql`boundary_role`)} boundary_right WHERE boundary_right.value='*'))`;
const assignedSubject=(customer:Sql,user:Sql)=>sql`EXISTS (SELECT 1 FROM customer_assignments boundary_assignment WHERE boundary_assignment.customer_id=${customer} AND ${subjects(sql`boundary_assignment`,user)})`;
const customerBoundary=(customer:Sql,user:Sql)=>sql`(${singleCustomer} OR ${globalOwnerSubject(user)} OR ${assignedSubject(customer,user)})`;
/**
 * The end of the boundary by the delete of a customer (CustomerGain 'boundary-end' in
 * lib/server/identity/rbac.ts), judged in the delete's transaction before the delete.
 * users: the ids of the active accounts that do not see the default customer while
 * the boundary holds (no global Owner, and no assignment to it, directly or through an
 * enabled user group); exactly these accounts gain it. ends: no customer other than
 * the default customer and the deleted one exists, so customerSeparationSql is false
 * after the delete.
 */
export const boundaryEndSql=(deletedCustomerId:string)=>({
 users:sql`SELECT boundary_user.id FROM local_users boundary_user WHERE boundary_user.status='active' AND NOT ${globalOwnerSubject(sql`boundary_user`)} AND NOT ${assignedSubject(sql`${separationDefaultCustomerId}`,sql`boundary_user`)}`,
 ends:sql`NOT EXISTS (SELECT 1 FROM customers boundary_other WHERE boundary_other.id<>${separationDefaultCustomerId} AND boundary_other.id<>${deletedCustomerId})`,
});
/** True while the principal may see the customer (rule above), evaluated live. */
export function customerAccessGuard(customerExpression:Sql,principalExpression:Sql):SqlGuard{return sql`(${singleCustomer} OR EXISTS (SELECT 1 FROM local_users boundary_user WHERE (${globalOwnerSubject(sql`boundary_user`)} OR ${assignedSubject(customerExpression,sql`boundary_user`)}) AND boundary_user.auth_principal=${principalExpression} AND boundary_user.status='active'))`;}
/**
 * True while the scope of the role assignment row `assignment` lies in a customer
 * the principal sees (customerAccessGuard): always for a global assignment, for a
 * group or device scope through the customer of that row (revoked or not). A
 * missing scope row passes nothing.
 */
export function assignmentScopeGuard(assignment:Sql,principalExpression:Sql):SqlGuard{
 const group=customerAccessGuard(sql`scope_group.customer_id`,principalExpression),device=customerAccessGuard(sql`scope_device.customer_id`,principalExpression);
 return sql`(${assignment}.scope_type='global' OR (${assignment}.scope_type='devicegroup' AND EXISTS (SELECT 1 FROM device_groups scope_group WHERE scope_group.id=${assignment}.scope_id AND ${group})) OR (${assignment}.scope_type='device' AND EXISTS (SELECT 1 FROM servers scope_device WHERE scope_device.id=${assignment}.scope_id AND ${device})))`;
}
/**
 * True while an active local_users row is a subject of the role assignment row
 * `assignment`: the user itself, or a member of the enabled user group, as in every
 * permission check. With a customer expression, the same row must also pass the
 * customer boundary for that customer, like permissionsFor/groupPermissions do for
 * the target's customer.
 */
export function effectiveSubjectGuard(assignment:Sql,customerExpression?:Sql):SqlGuard{return sql`EXISTS (SELECT 1 FROM local_users effective_user WHERE effective_user.status='active' AND ${subjects(assignment,sql`effective_user`)}${customerExpression===undefined?sql``:sql` AND ${customerBoundary(customerExpression,sql`effective_user`)}`})`;}
// `customer`: the target's customer expression; target-less (global) checks pass none.
function permissionGuard(principalExpression:Sql,permission:string,scope:Sql,customer?:Sql):SqlGuard{return sql`EXISTS (SELECT 1 FROM local_users rbac_user JOIN role_assignments rbac_assignment ON ${subjects(sql`rbac_assignment`,sql`rbac_user`)} JOIN rbac_roles rbac_role ON rbac_role.id=rbac_assignment.role_id WHERE rbac_user.auth_principal=${principalExpression} AND rbac_user.status='active' AND (${scope}) AND ${roleAllows(sql`rbac_role`,permissionAliases(permission))}${customer===undefined?sql``:sql` AND ${customerBoundary(customer,sql`rbac_user`)}`})`;}
// Expressions come only from internal SQL. Active accounts, group membership,
// role permissions and inherited scope are evaluated in the committing query.
export function globalPermissionGuard(principalExpression:Sql,permission:string):SqlGuard{return permissionGuard(principalExpression,permission,sql`rbac_assignment.scope_type='global' AND rbac_assignment.scope_id='*'`);}
/**
 * A global-scope right inside one customer: a global assignment of the right whose
 * subject also passes the customer boundary for that customer (customerAccessGuard
 * rule), evaluated live. Group and device assignments do not count. Moving devices
 * to another customer without a group ("Ungrouped") uses it for the target customer.
 */
export function customerPermissionGuard(customerExpression:Sql,principalExpression:Sql,permission:Permission):SqlGuard{return permissionGuard(principalExpression,permission,sql`rbac_assignment.scope_type='global' AND rbac_assignment.scope_id='*'`,customerExpression);}
// The group must exist for every scope and lie within the principal's customers
// (group subtrees never cross customers).
export function groupPermissionGuard(groupExpression:Sql,principalExpression:Sql,permission:Permission='groups.manage'):SqlGuard{return permissionGuard(principalExpression,permission,sql`((rbac_assignment.scope_type='global' AND rbac_assignment.scope_id='*') OR (rbac_assignment.scope_type='devicegroup' AND EXISTS (SELECT 1 FROM device_group_ancestors rbac_ancestor WHERE rbac_ancestor.group_id=${groupExpression} AND rbac_ancestor.ancestor_id=rbac_assignment.scope_id))) AND EXISTS (SELECT 1 FROM device_groups rbac_scope WHERE rbac_scope.id=${groupExpression} AND ${customerBoundary(sql`rbac_scope.customer_id`,sql`rbac_user`)})`);}
// The rights are evaluated inside the device row, so the customer boundary can
// refer to its customer.
/** includeRevoked: the right as granted, also on a revoked device (only to answer that device's state without revealing it to others). */
export function devicePermissionGuard(serverExpression:Sql,principalExpression:Sql,permission:Permission,{includeRevoked=false}:{includeRevoked?:boolean}={}):SqlGuard{
 const guard=permissionGuard(principalExpression,permission,sql`(rbac_assignment.scope_type='global' AND rbac_assignment.scope_id='*') OR (rbac_assignment.scope_type='device' AND rbac_assignment.scope_id=${serverExpression}) OR (rbac_assignment.scope_type='devicegroup' AND EXISTS (SELECT 1 FROM device_group_members rbac_device_group JOIN device_group_ancestors rbac_ancestor ON rbac_ancestor.group_id=rbac_device_group.group_id WHERE rbac_device_group.server_id=${serverExpression} AND rbac_ancestor.ancestor_id=rbac_assignment.scope_id))`,sql`rbac_device.customer_id`);
 return sql`EXISTS (SELECT 1 FROM servers rbac_device WHERE rbac_device.id=${serverExpression} AND ${includeRevoked?sql`TRUE`:sql`rbac_device.revoked=0`} AND (${guard}))`;
}
export function anyDevicePermissionGuard(principalExpression:Sql,permission:Permission):SqlGuard{const guard=devicePermissionGuard(sql`rbac_any_device.id`,principalExpression,permission);return sql`EXISTS (SELECT 1 FROM servers rbac_any_device WHERE ${guard})`;}
/**
 * The single SQL definition of the instance Owner. Outside this file only
 * lib/server/identity/policy/can.ts imports it (canSql, viewerCanSql); everything else asks the
 * policy module. Lint (no-restricted-syntax) refuses other imports.
 */
export function globalOwnerGuard(principalExpression:Sql):SqlGuard{return globalPermissionGuard(principalExpression,'*');}
// Keep one active direct global Owner as the administrative recovery path.
// Group-derived ownership does not qualify because membership can remove it.
export function remainingOwnerGuard(excludeUserId:string|null=null,excludeAssignmentId:string|null=null):SqlGuard{return sql`EXISTS (SELECT 1 FROM role_assignments remaining_assignment JOIN local_users remaining_user ON remaining_user.id=remaining_assignment.principal_id JOIN rbac_roles remaining_role ON remaining_role.id=remaining_assignment.role_id WHERE remaining_assignment.principal_type='user' AND remaining_assignment.scope_type='global' AND remaining_assignment.scope_id='*' AND remaining_user.status='active' AND (${excludeUserId??''}='' OR remaining_user.id<>${excludeUserId??''}) AND (${excludeAssignmentId??''}='' OR remaining_assignment.id<>${excludeAssignmentId??''}) AND EXISTS (SELECT 1 FROM ${permissionElements(sql`remaining_role`)} remaining_right WHERE remaining_right.value='*'))`;}
export const lastOwnerGuard=remainingOwnerGuard;
// Privileged roles (docs/customers.md): a role is privileged while its current permissions
// contain '*' or the cross-customer right. From the first start and
// independent of the number of customers, only a live global Owner handles privileged
// roles and accounts. lib/server/identity/rbac.ts and the account actions share both.
export const privilegedRoleSql=(role:Sql)=>sql`EXISTS (SELECT 1 FROM ${permissionElements(role)} privileged_right WHERE privileged_right.value IN ('*',${crossCustomerPermission}))`;
/** Live Owner rule for the committing statement: the actor is a live global Owner (globalOwnerGuard). */
export function privilegedWriteGuard(v:Viewer):SqlGuard{return sql`(${globalOwnerGuard(sql`${principal(v)}`)})`;}
export const targetOwnerOnlyMessage=translate(defaultLocale,'apiError.access.targetOwnerOnly');
export const targetAssignmentsRequiredMessage=translate(defaultLocale,'apiError.access.targetAssignmentsRequired');
export const targetCustomerBoundaryMessage=translate(defaultLocale,'apiError.access.targetCustomerBoundary');
// A role of the target: any assignment in any scope, directly or through any of
// its user groups, enabled or disabled.
const targetRoleSql=(targetUserId:string,privileged:boolean)=>sql`EXISTS (SELECT 1 FROM role_assignments target_assignment JOIN rbac_roles target_role ON target_role.id=target_assignment.role_id WHERE ((target_assignment.principal_type='user' AND target_assignment.principal_id=${targetUserId}) OR (target_assignment.principal_type='group' AND EXISTS (SELECT 1 FROM user_group_members target_member WHERE target_member.group_id=target_assignment.principal_id AND target_member.user_id=${targetUserId})))${privileged?sql` AND ${privilegedRoleSql(sql`target_role`)}`:sql``})`;
// A customer of the target: any customer assignment of the target directly or of
// any of its user groups, enabled or disabled, whatever the target's or the
// customer's status. The actor must see each of them (customerAccessGuard, live:
// always while only the default customer exists, always for a live global Owner).
function targetCustomersSeenGuard(actor:Viewer,targetUserId:string):SqlGuard{
 const seen=customerAccessGuard(sql`target_customer.customer_id`,sql`${principal(actor)}`);
 return sql`NOT EXISTS (SELECT 1 FROM customer_assignments target_customer WHERE ((target_customer.principal_type='user' AND target_customer.principal_id=${targetUserId}) OR (target_customer.principal_type='group' AND EXISTS (SELECT 1 FROM user_group_members target_customer_member WHERE target_customer_member.group_id=target_customer.principal_id AND target_customer_member.user_id=${targetUserId}))) AND NOT ${seen})`;
}
/**
 * True while the actor sees every customer of the user group: each customer with a
 * customer_assignments row for the group, whatever the group's enabled state or
 * the customer's status (customerAccessGuard, live: always while only the
 * default customer exists, always for a live global Owner). A group without customer passes.
 */
export function groupCustomersSeenGuard(actor:Viewer,groupId:string):SqlGuard{
 const seen=customerAccessGuard(sql`group_customer.customer_id`,sql`${principal(actor)}`);
 return sql`NOT EXISTS (SELECT 1 FROM customer_assignments group_customer WHERE group_customer.principal_type='group' AND group_customer.principal_id=${groupId} AND NOT ${seen})`;
}
/**
 * Account actions (link, edit, lock, unlock) only on dominated accounts, evaluated
 * live: the actor holds global portal.users.manage and the target has no role, or
 * the actor also holds global portal.roleAssignments.manage and the target holds
 * no privileged role or is a live global Owner (privilegedWriteGuard). In every
 * case the actor also sees every customer of the target
 * (targetCustomersSeenGuard). Self-contained.
 */
export function targetDominanceGuard(actor:Viewer,targetUserId:string):SqlGuard{
 const key=sql`${principal(actor)}`,users=globalPermissionGuard(key,'portal.users.manage'),assignments=globalPermissionGuard(key,'portal.roleAssignments.manage'),owner=privilegedWriteGuard(actor),customers=targetCustomersSeenGuard(actor,targetUserId);
 return sql`((${users}) AND (NOT ${targetRoleSql(targetUserId,false)} OR ((${assignments}) AND (NOT ${targetRoleSql(targetUserId,true)} OR ${owner}))) AND ${customers})`;
}
/** True while the guard holds now: SELECT 1 WHERE guard. */
export async function guardPasses(guard:SqlGuard):Promise<boolean>{return !!await db().one(sql`SELECT 1 AS allowed WHERE ${guard}`);}
/**
 * Pre-check (and re-check after a refused commit) for targetDominanceGuard: 403
 * with the matching message, in this order: privileged target, unseen customer of
 * the target, missing portal.roleAssignments.manage. An actor without
 * portal.users.manage is left to the caller's own right check, which refuses as before.
 */
export async function requireTargetDominance(actor:Viewer,targetUserId:string,guard=targetDominanceGuard(actor,targetUserId)){
 if(await guardPasses(guard))return;
 if(!await guardPasses(globalPermissionGuard(sql`${principal(actor)}`,'portal.users.manage')))return;
 if(await guardPasses(targetRoleSql(targetUserId,true)))throw new HttpError('apiError.access.targetOwnerOnly');
 throw new HttpError(await guardPasses(targetCustomersSeenGuard(actor,targetUserId))?'apiError.access.targetAssignmentsRequired':'apiError.access.targetCustomerBoundary');
}
export const parsedPermissions=(json:string):string[]=>{try{const parsed:unknown=JSON.parse(json);return Array.isArray(parsed)?parsed.filter((p):p is string=>typeof p==='string'):[];}catch{return [];}};
function expandedPermissions(rows:{permissions:string}[],definitions:readonly string[]):string[]{const rights=new Set(rows.flatMap(row=>parsedPermissions(row.permissions)));if(rights.has('*'))return [...definitions];if(rights.has('runbooks')){rights.add('runbooks.read');rights.add('runbooks.execute');}return definitions.filter(right=>rights.has(right));}
/** True while a role with these stored permissions (JSON) gives at least one device right, by the expansion that permissionsFor uses. */
export const roleGrantsDeviceRight=(permissions:string)=>expandedPermissions([{permissions}],allPermissions).length>0;
/**
 * The names of the roles assigned to an active account, directly or through an enabled user group it is a
 * member of (the subjects rule), at any scope: distinct and sorted by name. One indexed query; the account
 * menu and My account show them (Viewer.roles).
 */
export async function viewerRoleNames(userId:string):Promise<string[]>{
 const rows=await db().query<{name:string}>(sql`SELECT DISTINCT rbac_role.name FROM local_users rbac_user JOIN role_assignments rbac_assignment ON ${subjects(sql`rbac_assignment`,sql`rbac_user`)} JOIN rbac_roles rbac_role ON rbac_role.id=rbac_assignment.role_id WHERE rbac_user.id=${userId} AND rbac_user.status='active' ORDER BY rbac_role.name`);
 return rows.map(row=>row.name);
}
async function assignedPermissions(key:string,scope:Sql){return db().query<{permissions:string}>(sql`SELECT rbac_role.permissions FROM local_users rbac_user JOIN role_assignments rbac_assignment ON ${subjects(sql`rbac_assignment`,sql`rbac_user`)} JOIN rbac_roles rbac_role ON rbac_role.id=rbac_assignment.role_id WHERE rbac_user.auth_principal=${key} AND rbac_user.status='active' AND (${scope})`);}
// Reads for one target: outside the boundary there are no rights at all, also
// none from roles assigned directly on the target. A missing target has no customer.
const targetBoundary=(table:'servers'|'device_groups',id:string)=>sql`(${singleCustomer} OR EXISTS (SELECT 1 FROM ${sql.ident(table)} boundary_target WHERE boundary_target.id=${id} AND ${customerBoundary(sql`boundary_target.customer_id`,sql`rbac_user`)}))`;
export async function globalPermissions(v:Viewer):Promise<string[]>{return expandedPermissions(await assignedPermissions(principal(v),sql`rbac_assignment.scope_type='global' AND rbac_assignment.scope_id='*'`),[...allPermissions,...allPortalPermissions]);}
export async function hasGlobalPermission(v:Viewer,permission:string){return guardPasses(globalPermissionGuard(sql`${principal(v)}`,permission));}
export type DeviceRow={id:string;name:string;created_at:number;last_seen:number|null;management:number;snapshot:string|null;revoked:number;agent_public_key:string|null};
export async function resolvePrincipal(key:string):Promise<Viewer|null>{
 const row=await db().one<{id:string;auth_email:string;auth_principal:string;username:string;display_name:string;auth_version:number}>(sql`SELECT id,auth_email,auth_principal,username,display_name,auth_version FROM local_users WHERE auth_principal=${key} AND status='active'`);
 if(!row)return null;const viewer:Viewer={id:row.id,userId:row.id,label:row.auth_email,principal:row.auth_principal,username:row.username,displayName:row.display_name};Object.defineProperty(viewer,'authorization',{value:{authVersion:row.auth_version},enumerable:false});return viewer;
}
export type GroupRow={id:string;name:string;description:string;created_at:number;parent_id:string|null};
export async function groupPermissions(v:Viewer,groupId:string):Promise<Permission[]>{return expandedPermissions(await assignedPermissions(principal(v),sql`((rbac_assignment.scope_type='global' AND rbac_assignment.scope_id='*') OR (rbac_assignment.scope_type='devicegroup' AND EXISTS (SELECT 1 FROM device_group_ancestors rbac_ancestor WHERE rbac_ancestor.group_id=${groupId} AND rbac_ancestor.ancestor_id=rbac_assignment.scope_id))) AND ${targetBoundary('device_groups',groupId)}`),allPermissions) as Permission[];}
export async function allowedGroupIds(v:Viewer,permission:Permission='view'):Promise<string[]>{return (await db().query<{id:string}>(sql`SELECT id FROM device_groups WHERE ${groupPermissionGuard(sql`device_groups.id`,sql`${principal(v)}`,permission)}`)).map(row=>row.id);}
export async function requireGroup(v:Viewer,groupId:string,permission:Permission='groups.manage'){
 if(!guid(groupId))throw new HttpError('apiError.group.invalidGroup');
 // Outside the customer boundary the group answers as if it did not exist.
 const group=await db().one<GroupRow>(sql`SELECT id,name,description,created_at,parent_id FROM device_groups WHERE id=${groupId} AND ${customerAccessGuard(sql`device_groups.customer_id`,sql`${principal(v)}`)}`);if(!group)throw new HttpError('apiError.group.notFound');const permissions=await groupPermissions(v,groupId);if(!permissions.includes(permission))throw new HttpError('apiError.access.groupPermissionMissing',{permission});return {...group,permissions,authorization:groupPermissionGuard(sql`${groupId}`,sql`${principal(v)}`,permission)};
}
export async function permissionsFor(v:Viewer,id:string):Promise<Permission[]>{return expandedPermissions(await assignedPermissions(principal(v),sql`((rbac_assignment.scope_type='global' AND rbac_assignment.scope_id='*') OR (rbac_assignment.scope_type='device' AND rbac_assignment.scope_id=${id}) OR (rbac_assignment.scope_type='devicegroup' AND EXISTS (SELECT 1 FROM device_group_members rbac_device_group JOIN device_group_ancestors rbac_ancestor ON rbac_ancestor.group_id=rbac_device_group.group_id WHERE rbac_device_group.server_id=${id} AND rbac_ancestor.ancestor_id=rbac_assignment.scope_id))) AND ${targetBoundary('servers',id)}`),allPermissions) as Permission[];}
/**
 * permissionsFor for many devices at once: one statement, the ids as one
 * JSON parameter. Every distinct input id gets a key, unknown and revoked ids too,
 * and its value equals permissionsFor(v,id) at the same moment. The three scope
 * branches are a UNION ALL so each assignment meets only its own targets; the
 * customer boundary is checked per matched row like targetBoundary('servers').
 */
export async function effectivePermissions(v:Viewer,deviceIds:string[]):Promise<Map<string,Permission[]>>{
 const ids=[...new Set(deviceIds)],rowsById=new Map<string,{permissions:string}[]>(ids.map(id=>[id,[]]));
 if(!ids.length)return new Map();
 const rows=await db().query<{id:string;permissions:string}>(sql`WITH rbac_target(id) AS (SELECT DISTINCT value FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)),
 rbac_grant AS (SELECT rbac_user.id AS user_id,rbac_assignment.scope_type,rbac_assignment.scope_id,rbac_role.permissions FROM local_users rbac_user JOIN role_assignments rbac_assignment ON ${subjects(sql`rbac_assignment`,sql`rbac_user`)} JOIN rbac_roles rbac_role ON rbac_role.id=rbac_assignment.role_id WHERE rbac_user.auth_principal=${principal(v)} AND rbac_user.status='active'),
 rbac_match(target_id,user_id,permissions) AS (
  SELECT rbac_target.id,rbac_grant.user_id,rbac_grant.permissions FROM rbac_target JOIN rbac_grant ON rbac_grant.scope_type='global' AND rbac_grant.scope_id='*'
  UNION ALL SELECT rbac_target.id,rbac_grant.user_id,rbac_grant.permissions FROM rbac_target JOIN rbac_grant ON rbac_grant.scope_type='device' AND rbac_grant.scope_id=rbac_target.id
  UNION ALL SELECT rbac_target.id,rbac_grant.user_id,rbac_grant.permissions FROM rbac_target JOIN device_group_members rbac_device_group ON rbac_device_group.server_id=rbac_target.id JOIN device_group_ancestors rbac_ancestor ON rbac_ancestor.group_id=rbac_device_group.group_id JOIN rbac_grant ON rbac_grant.scope_type='devicegroup' AND rbac_grant.scope_id=rbac_ancestor.ancestor_id)
 SELECT DISTINCT rbac_match.target_id AS id,rbac_match.permissions FROM rbac_match JOIN local_users rbac_user ON rbac_user.id=rbac_match.user_id
 WHERE (${singleCustomer} OR EXISTS (SELECT 1 FROM servers boundary_target WHERE boundary_target.id=rbac_match.target_id AND ${customerBoundary(sql`boundary_target.customer_id`,sql`rbac_user`)}))`);
 for(const row of rows)rowsById.get(String(row.id))?.push(row);
 return new Map(ids.map(id=>[id,expandedPermissions(rowsById.get(id)??[],allPermissions) as Permission[]]));
}
export async function allowedDeviceIds(v:Viewer,permission:Permission='view'):Promise<string[]>{return (await db().query<{id:string}>(sql`SELECT id FROM servers WHERE ${devicePermissionGuard(sql`servers.id`,sql`${principal(v)}`,permission)}`)).map(row=>row.id);}
export async function requireDevice(v:Viewer,id:string,permission:Permission='view'):Promise<DeviceRow>{
 if(!guid(id))throw new HttpError('apiError.device.invalid');
 // Outside the customer boundary the device answers as if it did not exist.
 const device=await db().one<DeviceRow>(sql`SELECT id,name,created_at,last_seen,management,snapshot,revoked,agent_public_key FROM servers WHERE id=${id} AND revoked=0 AND ${customerAccessGuard(sql`servers.customer_id`,sql`${principal(v)}`)}`);if(!device)throw new HttpError('apiError.device.notFound');if(!await guardPasses(devicePermissionGuard(sql`${id}`,sql`${principal(v)}`,permission)))throw new HttpError('apiError.access.devicePermissionMissing',{permission});return device;
}
export async function revokePrincipalProofs(key:string){await commitAll([
 ...(['mfa_authenticator_challenges','mfa_management_proofs','mfa_proofs','mfa_sessions','mfa_grants','passkey_challenges'] as const).map(table=>sql`DELETE FROM ${sql.ident(table)} WHERE principal=${key}`),
 sql`DELETE FROM local_auth_sessions WHERE user_id IN (SELECT id FROM local_users WHERE auth_principal=${key})`,
 sql`UPDATE terminal_sessions SET state='closed',error='serverMessage.access.userRightsChanged' WHERE principal=${key} AND state IN ('opening','open')`,
 sql`UPDATE rdp_sessions SET state='closed',key_envelope=NULL,error='serverMessage.access.userRightsChanged' WHERE principal=${key} AND state IN ('opening','open')`,
 sql`UPDATE transfers SET state='cancelled',updated_at=${Date.now()},message='serverMessage.access.userRightsChanged' WHERE principal=${key} AND state NOT IN ('completed','cancelled','failed','expired')`,
 sql`UPDATE runbook_runs SET cancel_requested=1 WHERE actor=${key} AND state IN ('queued','running')`,
 ...(['rdp_frames','rdp_receipts'] as const).map(table=>sql`DELETE FROM ${sql.ident(table)} WHERE session_id IN (SELECT id FROM rdp_sessions WHERE principal=${key})`)
]);}
export async function cancelPendingForPrincipal(key:string,serverId?:string){await db().exec(sql`UPDATE jobs SET state='cancelled',parameters='{}',result='serverMessage.job.permissionChanged' WHERE actor_principal=${key} AND state='pending'${serverId?sql` AND server_id=${serverId}`:sql``}`);}
