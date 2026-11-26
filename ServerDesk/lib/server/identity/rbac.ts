import {guid,HttpError,now} from '../context';
import {defaultLocale} from '../../i18n/locale';
import {translate} from '../../i18n/translate';
import {auditAfterChange,auditEachTarget,auditEvent} from '../audit';
import {allPermissions,allPortalPermissions,assignmentScopeGuard,cancelPendingForPrincipal,crossCustomerPermission,customerAccessGuard,effectiveSubjectGuard,globalPermissionGuard,groupCustomersSeenGuard,hasGlobalPermission,lastOwnerGuard,parsedPermissions,permissionDefinitions,permissionElements,portalPermissionDefinitions,principal,privilegedRoleSql,privilegedWriteGuard,revokePrincipalProofs,boundaryEndSql,roleGrantsDeviceRight,rolePermissions,type SqlGuard} from './access';
import {canSql} from './policy/can';
import type {InheritedReason} from './inherited-reason';
import type {Viewer} from '../../types';
import {mfaSessionFence,readMfaManagementProof,requireLiveSessions} from './mfa';
import {deviceGroupConflict,deviceGroupHasAssignmentsSql,deviceGroupHasMembersSql} from '../devices/device-groups';
import {deviceGroupDeleteNeedsStepUp} from '../../step-up';
import {dbTriggerCode,isUniqueViolation,type DbTriggerCode} from '../errors/db-codes';
import {catalogCommit,catalogFailure,catalogOwner,catalogOwnership,catalogVisibleGuard,catalogWriteFailure,catalogWriteGuard,requireCatalogWrite,requireSameCatalogOwner} from '../catalog-ownership';
import {commitAll,db,dbNow,sql,type Database,type Sql,type Step} from '../db';
import {emergencyFixedSql} from './entra/emergency';

/** The live proof, its MFA session and the request's primary session as one guard, and the proof row to consume. */
export type ManagementAuthorization={guard:SqlGuard;tokenHash:string;key:string;sessionHash:string};
export async function prepareManagementAuthorization(request:Request,v:Viewer,value:unknown):Promise<ManagementAuthorization>{
 const proof=await readMfaManagementProof(request,v,value),{primaryGuard}=await import('./local-auth'),primary=await primaryGuard(request,v);
 return {tokenHash:proof.tokenHash,key:proof.key,sessionHash:proof.sessionHash,guard:sql`(${proof.guard}) AND (${primary}) AND EXISTS (SELECT 1 FROM mfa_management_proofs live_proof JOIN mfa_sessions live_session ON live_session.token_hash=live_proof.session_hash AND live_session.principal=live_proof.principal WHERE live_proof.token_hash=${proof.tokenHash} AND live_proof.principal=${proof.key} AND live_proof.session_hash=${proof.sessionHash} AND live_proof.expires_at>${dbNow} AND live_session.idle_expires_at>${dbNow} AND live_session.expires_at>${dbNow})`};
}
// Follow-up statements run in the same transaction after the change and before
// the proof is consumed. If one fails, the change rolls back and the proof stays.
// An audit row with auditAfterChange (lib/server/audit.ts) goes first among them, so it
// directly follows the change it records.
export async function commitManagementChange(statement:Sql,proof:ManagementAuthorization,follow:Step[]=[]){
 const results=await commitAll([statement,...follow,sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash}`]);
 if(!results.at(-1)?.rowCount)throw new HttpError('apiError.rbac.proofExpired');
 return results[0].rows[0]??null;
}
// Routine changes (lib/step-up.ts) commit like commitManagementChange, without a
// proof: the statement carries the request's mfaSessionFence (lib/server/identity/mfa.ts), so a
// logout, password reset or idle expiry before the transaction leaves no change
// and, with auditAfterChange, no audit row. No proof row is read or deleted.
export async function commitSessionChange(statement:Sql,follow:Step[]=[]){
 const results=await commitAll([statement,...follow]);
 return results[0].rows[0]??null;
}
// Role and catalog triggers of 0034 as the catalogs answer them, then the device group hierarchy.
const roleCatalogTriggers:readonly DbTriggerCode[]=['customer-role-permissions','customer-role-scope','customer-catalog-mismatch','customer-catalog-immutable'];
export function rbacFailure(e:unknown){const trigger=dbTriggerCode(e);if(e instanceof Error&&trigger&&roleCatalogTriggers.includes(trigger))return catalogFailure(e);const hierarchy=deviceGroupConflict(e);if(hierarchy)return hierarchy;if(isUniqueViolation(e))return new HttpError('apiError.rbac.nameOrAssignmentTaken');return e;}

export const builtinRoleIds={owner:'builtin-owner',reader:'builtin-reader',operator:'builtin-operator',deviceAdministrator:'builtin-device-administrator',userAccessAdministrator:'builtin-user-access-administrator',portalOperator:'builtin-portal-operator'} as const;
type UserRow={id:string;username:string;email:string;display_name:string;auth_principal:string;status:string;password_set?:number;mfa_enabled?:number;identity_source:'local'|'entra'};
type RoleRow={id:string;name:string;description:string;permissions:string;builtin:number;customer_id:string|null};
type AssignmentRow={id:string;principal_type:'user'|'group';principal_id:string;role_id:string;scope_type:'global'|'devicegroup'|'device';scope_id:string;source:'manual'|'entra'};

// The six built-in roles. Their permission lists come from the code constants, so
// they are seeded at runtime and not by a migration. A function, so loading this
// module never reads the permission constants of lib/server/identity/access.ts.
export const builtinRoles=()=>[
 {id:builtinRoleIds.owner,name:'Owner',description:'Vollständiger Portal- und Gerätezugriff im zugewiesenen Geltungsbereich.',permissions:['*']},
 {id:builtinRoleIds.reader,name:'Reader',description:'Monitoring, Diagnosen und ausdrücklich lesende Gerätefunktionen.',permissions:rolePermissions.viewer},
 {id:builtinRoleIds.operator,name:'Operator',description:'Geräte bedienen; keine Berechtigungsverwaltung für Gerätegruppen.',permissions:rolePermissions.operator},
 {id:builtinRoleIds.deviceAdministrator,name:'Device Administrator',description:'Alle Gerätefunktionen einschließlich Gerätegruppenverwaltung.',permissions:allPermissions},
 {id:builtinRoleIds.userAccessAdministrator,name:'User Access Administrator',description:'Verwaltet Konten, Benutzergruppen, Rollen und Rollenzuweisungen. Keine impliziten Geräteberechtigungen.',permissions:allPortalPermissions.filter(right=>right!=='portal.operator'&&right!==crossCustomerPermission&&right!=='portal.notifications.manage')},
 {id:builtinRoleIds.portalOperator,name:'Portal Operator',description:'Kompatibilität für bisherige Operatoren; gewährt keine Geräteberechtigung.',permissions:['portal.operator']}
];
// One seed per database pool. All inserts commit in one transaction and an existing
// role is never changed (ON CONFLICT DO NOTHING), so repeated and concurrent calls,
// also from several processes, leave exactly the six roles. A custom role that
// already holds a built-in name keeps it; that built-in role is then left out. A
// failed seed is retried by the next call.
const builtinSeeds=new WeakMap<Database,Promise<void>>();
export function ensureBuiltinRoles():Promise<void>{
 const d=db();let seed=builtinSeeds.get(d);
 if(!seed){
  const at=now();
  seed=commitAll(builtinRoles().map(role=>sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${role.id},${role.name},${role.description},${JSON.stringify(role.permissions)},1,${at}) ON CONFLICT DO NOTHING`)).then(()=>undefined,e=>{builtinSeeds.delete(d);throw e;});
  builtinSeeds.set(d,seed);
 }
 return seed;
}

const names=(value:unknown,key:'apiError.rbac.groupName'|'apiError.rbac.roleName',max=80)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\u0000-\u001f\u007f]/.test(value))throw new HttpError(key,{max});return value.trim();};
const descriptions=(value:unknown)=>{if(value===undefined)return '';if(typeof value!=='string'||value.length>1000)throw new HttpError('apiError.rbac.description');return value.trim();};
const rights=(value:unknown)=>{if(!Array.isArray(value)||!value.length||value.length>100||value.some(right=>typeof right!=='string'||![...allPermissions,...allPortalPermissions].includes(right as typeof allPermissions[number])))throw new HttpError('apiError.rbac.permissions');return [...new Set(value as string[])].sort();};
const id=(value:unknown)=>{if(!guid(value))throw new HttpError('apiError.rbac.invalidId');return value;};
const actor=(v:Viewer)=>sql`${principal(v)}`;
function actorGuard(v:Viewer,permission:string,proof:ManagementAuthorization):SqlGuard{return sql`(${globalPermissionGuard(actor(v),permission)}) AND (${proof.guard})`;}
async function need(v:Viewer,permission:string,proof:ManagementAuthorization){if(!await hasGlobalPermission(v,permission))throw new HttpError('apiError.rbac.portalPermissionMissing',{permission});return actorGuard(v,permission,proof);}
function protectAssignedGroup(v:Viewer,guard:SqlGuard,groupId:string):SqlGuard{return sql`(${guard}) AND (NOT EXISTS (SELECT 1 FROM role_assignments assigned_group WHERE assigned_group.principal_type='group' AND assigned_group.principal_id=${groupId}) OR ${globalPermissionGuard(actor(v),'portal.roleAssignments.manage')})`;}
// A user group assigned to a customer (customer boundary) gives its members that
// customer. Adding members or enabling it is therefore a customer assignment and
// needs a live global Owner, like customers.setTechnicians. Disabling only takes
// access away and stays as it is; removing members has its own rule below.
export const customerGroupOwnerOnlyMessage=translate(defaultLocale,'apiError.rbac.customerGroupOwnerOnly');
function protectCustomerGroup(v:Viewer,guard:SqlGuard,groupId:string):SqlGuard{return sql`(${guard}) AND (NOT EXISTS (SELECT 1 FROM customer_assignments customer_group WHERE customer_group.principal_type='group' AND customer_group.principal_id=${groupId}) OR ${canSql(actor(v),'instance.owner')})`;}
const permitted=async(check:SqlGuard)=>!!await db().one(sql`SELECT 1 AS permitted WHERE ${check}`);
async function customerGroupAllowed(v:Viewer,groupId:string){return permitted(protectCustomerGroup(v,noGuard,groupId));}
// Removing a member needs, once a second customer exists, that the actor sees every
// customer of the group (groupCustomersSeenGuard, lib/server/identity/access.ts), before and in
// the committing statement. Checked before the assigned-group rule.
export const customerGroupBoundaryMessage=translate(defaultLocale,'apiError.rbac.customerGroupBoundary');
async function groupCustomersSeen(v:Viewer,groupId:string){return permitted(groupCustomersSeenGuard(v,groupId));}
// A privileged role holds '*' or the cross-customer right. Independent of
// the number of customers, only a live global Owner creates,
// changes, deletes or assigns one, and only an Owner adds members to or enables a
// user group that holds one. Removing stays as it is.
export const privilegedRoleOwnerOnlyMessage=translate(defaultLocale,'apiError.rbac.privilegedRoleOwnerOnly');
export const privilegedGroupOwnerOnlyMessage=translate(defaultLocale,'apiError.rbac.privilegedGroupOwnerOnly');
export const privilegedPermissions=(permissions:unknown)=>Array.isArray(permissions)&&permissions.some(right=>right==='*'||right===crossCustomerPermission);
// privilegedRoleSql and privilegedWriteGuard (the Owner rule) live in lib/server/identity/access.ts,
// shared with the account actions in app/api/auth/route.ts.
const withGuard=(guard:SqlGuard,extra:SqlGuard):SqlGuard=>sql`(${guard}) AND (${extra})`;
async function privilegedWriteAllowed(v:Viewer){return permitted(privilegedWriteGuard(v));}
async function requirePrivilegedRoleWrite(v:Viewer){if(!await privilegedWriteAllowed(v))throw new HttpError('apiError.rbac.privilegedRoleOwnerOnly');}
function protectPrivilegedGroup(v:Viewer,guard:SqlGuard,groupId:string):SqlGuard{return sql`(${guard}) AND (NOT EXISTS (SELECT 1 FROM role_assignments privileged_group JOIN rbac_roles privileged_role ON privileged_role.id=privileged_group.role_id WHERE privileged_group.principal_type='group' AND privileged_group.principal_id=${groupId} AND ${privilegedRoleSql(sql`privileged_role`)}) OR ${privilegedWriteGuard(v)})`;}
async function privilegedGroupAllowed(v:Viewer,groupId:string){return permitted(protectPrivilegedGroup(v,noGuard,groupId));}
// An open invitation or reset link was issued while the account was not
// privileged, possibly by a weaker administrator. When the account becomes
// privileged, its open links die in the batch of the change (commitManagementChange
// follow-up). Each raise is judged on the state after the change, so a refused
// change voids nothing. Sessions and auth_version stay as they are.
type PrivilegeRaise={kind:'assignment';assignmentId:string}|{kind:'member';groupId:string;userId:string}|{kind:'group';groupId:string}|{kind:'role';roleId:string;before:string;after:string};
// The customer version (docs/customers.md): an account that gains a customer
// assignment loses its open links the same way, whoever issued them and in every
// mode. Judged on the state after the change, like a raise; only the existence of
// customer_assignments rows counts, no boundary check.
// - customer-subjects: the added [type,id] subjects of one customer, while their row exists.
// - customer-member: the membership exists and the group has a customer (enabled or not).
// - customer-group: the group is enabled now and has a customer: all its members.
// - boundary-end: deleting customerId removes the last customer other than the
//   default customer, so the boundary ends and every account sees the default
//   customer (customerSeparationSql). Its statements run in the delete's
//   transaction right before the delete, so they judge the state after it: no
//   customer other than the default customer and customerId exists. The accounts
//   are the active non-Owner accounts without an assignment to the default
//   customer, directly or through an enabled user group (boundaryEndSql).
export type CustomerGain={kind:'customer-subjects';customerId:string;subjects:['user'|'group',string][]}|{kind:'customer-member';groupId:string;userId:string}|{kind:'customer-group';groupId:string}|{kind:'boundary-end';customerId:string};
type AccountGain=PrivilegeRaise|CustomerGain;
const noGuard:SqlGuard=sql`TRUE`;
const raiseHolders=(filter:Sql)=>sql`SELECT raise_holder.principal_id FROM role_assignments raise_holder WHERE raise_holder.principal_type='user' AND ${filter} UNION SELECT raise_member.user_id FROM role_assignments raise_holder JOIN user_group_members raise_member ON raise_member.group_id=raise_holder.principal_id WHERE raise_holder.principal_type='group' AND ${filter}`;
const raisedGroup=(groupId:string)=>sql`EXISTS (SELECT 1 FROM role_assignments raise_group JOIN rbac_roles raise_group_role ON raise_group_role.id=raise_group.role_id WHERE raise_group.principal_type='group' AND raise_group.principal_id=${groupId} AND ${privilegedRoleSql(sql`raise_group_role`)})`;
const customerGroup=(groupId:string)=>sql`EXISTS (SELECT 1 FROM customer_assignments gain_group_customer WHERE gain_group_customer.principal_type='group' AND gain_group_customer.principal_id=${groupId})`;
// The added subjects of one type from the JSON array of [type,id] pairs.
const addedSubjects=(type:'user'|'group',subjects:string)=>sql`SELECT gain_subject.value->>1 FROM jsonb_array_elements(${subjects}::jsonb) gain_subject WHERE gain_subject.value->>0=${type}`;
function accountGain(gain:AccountGain):{users:Sql;raised:SqlGuard}{
 // The new assignment (fresh id) holds a privileged role: its user, or every member of its group.
 if(gain.kind==='assignment')return {users:raiseHolders(sql`raise_holder.id=${gain.assignmentId}`),raised:sql`EXISTS (SELECT 1 FROM role_assignments raise_assignment JOIN rbac_roles raise_role ON raise_role.id=raise_assignment.role_id WHERE raise_assignment.id=${gain.assignmentId} AND ${privilegedRoleSql(sql`raise_role`)})`};
 // The membership exists and the group holds a privileged role (enabled or not).
 if(gain.kind==='member')return {users:sql`SELECT user_id FROM user_group_members WHERE group_id=${gain.groupId} AND user_id=${gain.userId}`,raised:raisedGroup(gain.groupId)};
 // The group is enabled now and holds a privileged role: all its members.
 if(gain.kind==='group')return {users:sql`SELECT user_id FROM user_group_members WHERE group_id=${gain.groupId}`,raised:sql`EXISTS (SELECT 1 FROM user_groups WHERE id=${gain.groupId} AND enabled=1) AND ${raisedGroup(gain.groupId)}`};
 // The added users, and the current members of the added groups (enabled or not), each while its row for the customer exists.
 if(gain.kind==='customer-subjects'){const subjects=JSON.stringify(gain.subjects);return {users:sql`SELECT gain_user.principal_id FROM customer_assignments gain_user WHERE gain_user.customer_id=${gain.customerId} AND gain_user.principal_type='user' AND gain_user.principal_id IN (${addedSubjects('user',subjects)}) UNION SELECT gain_member.user_id FROM customer_assignments gain_group JOIN user_group_members gain_member ON gain_member.group_id=gain_group.principal_id WHERE gain_group.customer_id=${gain.customerId} AND gain_group.principal_type='group' AND gain_group.principal_id IN (${addedSubjects('group',subjects)})`,raised:noGuard};}
 // The membership exists and the group has a customer (enabled or not).
 if(gain.kind==='customer-member')return {users:sql`SELECT user_id FROM user_group_members WHERE group_id=${gain.groupId} AND user_id=${gain.userId}`,raised:customerGroup(gain.groupId)};
 // The boundary ends with the delete of customerId: every account that did not see the default customer.
 if(gain.kind==='boundary-end'){const {users,ends}=boundaryEndSql(gain.customerId);return {users,raised:ends};}
 // The group is enabled now and has a customer: all its members.
 if(gain.kind==='customer-group')return {users:sql`SELECT user_id FROM user_group_members WHERE group_id=${gain.groupId}`,raised:sql`EXISTS (SELECT 1 FROM user_groups WHERE id=${gain.groupId} AND enabled=1) AND ${customerGroup(gain.groupId)}`};
 // The role now holds exactly the new permissions, they are privileged and the stored ones were not: every holder.
 return {users:raiseHolders(sql`raise_holder.role_id=${gain.roleId}`),raised:sql`EXISTS (SELECT 1 FROM rbac_roles raise_role WHERE raise_role.id=${gain.roleId} AND raise_role.permissions=${gain.after} AND ${privilegedRoleSql(sql`raise_role`)}) AND NOT EXISTS (SELECT 1 FROM (SELECT ${gain.before}::text AS permissions) stored_role WHERE ${privilegedRoleSql(sql`stored_role`)})`};
}
// `extra`: a guard of the change itself that the statement also carries, for a
// transaction whose change can be refused (customerGainStatements).
function voidOpenTokens(gain:AccountGain,at:number,extra:SqlGuard=noGuard):Sql{
 const {users,raised}=accountGain(gain);
 return sql`UPDATE local_account_tokens SET used_at=${at} WHERE used_at IS NULL AND user_id IN (${users}) AND ${raised} AND (${extra})`;
}
// The account rows of a gain: one per account whose open links this
// transaction voids, from the same predicate as voidOpenTokens and right before it.
// When a raise and a customer gain hit the same account in one transaction, the
// raise runs first and leaves no open link, so the account gets only the raise row.
function voidedLinksAudit(v:Viewer,gain:AccountGain,extra:SqlGuard=noGuard):Step{
 const {users,raised}=accountGain(gain),action=gain.kind.startsWith('customer-')||gain.kind==='boundary-end'?'Konto-Links wegen Kundenzuweisung verfallen':'Konto-Links wegen Rechteanstieg verfallen';
 return auditEachTarget({actor:v.label,action,targets:sql`SELECT DISTINCT user_id AS target FROM local_account_tokens WHERE used_at IS NULL AND user_id IN (${users}) AND ${raised} AND (${extra})`});
}
// A rise in privileges ends the MFA grants of the accounts that gain
// (docs/portal-sessions.md): their next sign-in asks for MFA again.
function endGrants(gain:AccountGain,extra:SqlGuard=noGuard):Sql{
 const {users,raised}=accountGain(gain);
 return sql`DELETE FROM mfa_grants WHERE user_id IN (${users}) AND ${raised} AND (${extra})`;
}
/**
 * The follow-up statements of a customer gain, for manageRbac and for
 * lib/server/identity/customer-admin.ts: the per-account audit row, the
 * voiding, then the end of the MFA grants of the gaining accounts. All carry
 * `guard`, so a refused change in the same transaction voids and ends nothing.
 */
export function customerGainStatements(v:Viewer,gain:CustomerGain,at:number,guard:SqlGuard=noGuard):Step[]{return [voidedLinksAudit(v,gain,guard),voidOpenTokens(gain,at,guard),endGrants(gain,guard)];}
// The audit row of a manageRbac change. It is the first follow-up statement, so
// it directly follows the effect and exists exactly when the effect changed a row.
const changeAudit=(v:Viewer,action:string,target:string)=>auditEvent({actor:v.label,action,target,guard:auditAfterChange});
async function requireUser(userId:string,includeDisabled=false){const row=await db().one<{id:string;auth_principal:string;status:string}>(sql`SELECT id,auth_principal,status FROM local_users WHERE id=${userId} AND (${includeDisabled} OR status<>'disabled')`);if(!row)throw new HttpError('apiError.rbac.userMissingOrDisabled');return row;}
async function requireUserGroup(groupId:string){const row=await db().one<{id:string;name:string;description:string;enabled:number}>(sql`SELECT id,name,description,enabled FROM user_groups WHERE id=${groupId}`);if(!row)throw new HttpError('apiError.rbac.userGroupNotFound');return row;}
// A role of a customer the viewer does not see answers like an unknown one.
async function requireRole(v:Viewer,roleId:unknown){if(typeof roleId!=='string'||roleId.length>120)throw new HttpError('apiError.rbac.invalidRole');const row=await db().one<RoleRow>(sql`SELECT id,name,description,permissions,builtin,customer_id FROM rbac_roles WHERE id=${roleId} AND ${catalogVisibleGuard(sql`customer_id`,actor(v))}`);if(!row)throw new HttpError('apiError.rbac.roleNotFound');return row;}
// Customer roles hold device rights only and apply only within their customer.
const customerRoleRights=(customerId:string|null,permissions:string[])=>{if(customerId!==null&&permissions.some(right=>right==='*'||right.startsWith('portal.')))throw new HttpError('apiError.customer.rolePermissions');};
export async function affectedAssignmentUsers(type:'user'|'group',subjectId:string){return type==='user'?(await db().query<{auth_principal:string}>(sql`SELECT auth_principal FROM local_users WHERE id=${subjectId}`)):(await db().query<{auth_principal:string}>(sql`SELECT u.auth_principal FROM local_users u JOIN user_group_members m ON m.user_id=u.id WHERE m.group_id=${subjectId}`));}
async function affectedRoleUsers(roleId:string){return (await db().query<{auth_principal:string}>(sql`SELECT DISTINCT u.auth_principal FROM local_users u JOIN role_assignments a ON (a.principal_type='user' AND a.principal_id=u.id) OR (a.principal_type='group' AND EXISTS (SELECT 1 FROM user_group_members m WHERE m.user_id=u.id AND m.group_id=a.principal_id)) WHERE a.role_id=${roleId}`));}
export async function invalidateRbacUsers(users:{auth_principal:string}[],serverId?:string){for(const key of new Set(users.map(user=>user.auth_principal))){await cancelPendingForPrincipal(key,serverId);await revokePrincipalProofs(key);}}
export async function affectedDeviceGroupUsers(groupId:string){return (await db().query<{auth_principal:string}>(sql`SELECT DISTINCT u.auth_principal FROM local_users u JOIN role_assignments a ON (a.principal_type='user' AND a.principal_id=u.id) OR (a.principal_type='group' AND EXISTS (SELECT 1 FROM user_group_members m WHERE m.user_id=u.id AND m.group_id=a.principal_id)) WHERE a.scope_type='devicegroup' AND EXISTS (SELECT 1 FROM device_group_ancestors ancestors WHERE ancestors.group_id=${groupId} AND ancestors.ancestor_id=a.scope_id)`));}

// Deleting a device group (/api/access delete-group). A group with a device
// membership or a devicegroup role assignment needs a fresh step-up proof
// (deviceGroupDeleteNeedsStepUp in lib/step-up.ts), read only after every check
// and consumed in the deleting batch. An empty group deletes behind the live
// session fence, and the committing guard holds only while the group is still
// empty: a device or an assignment that arrives before the commit stops the
// delete, and the reply asks for the proof (403 MFA_STEP_UP_REQUIRED).
export function deleteDeviceGroupRequest(request:Request,v:Viewer,value:unknown,confirm:unknown,managementToken:unknown){
 return removeDeviceGroup(v,value,confirm,async risky=>risky?await prepareManagementAuthorization(request,v,managementToken):{request,fence:await mfaSessionFence(request,v)});
}
/** The delete with a proof the caller already holds, consumed in the batch whatever the group holds. */
export function deleteDeviceGroup(v:Viewer,value:unknown,confirm:unknown,proof:ManagementAuthorization){
 return removeDeviceGroup(v,value,confirm,async()=>proof);
}
type GroupDeleteAdmission=ManagementAuthorization|{request:Request;fence:SqlGuard};
async function removeDeviceGroup(v:Viewer,value:unknown,confirm:unknown,admit:(risky:boolean)=>Promise<GroupDeleteAdmission>){
 const groupId=id(value);if(confirm!==true)throw new HttpError('apiError.rbac.confirmGroupDelete');
 if(!await hasGlobalPermission(v,'groups.manage'))throw new HttpError('apiError.rbac.groupDeleteGlobalRight');
 // A group outside the viewer's customers answers as if it did not exist.
 const d=db(),group=await d.one<{id:string;name:string}>(sql`SELECT id,name FROM device_groups WHERE id=${groupId} AND ${customerAccessGuard(sql`device_groups.customer_id`,actor(v))}`);
 if(!group)throw new HttpError('apiError.group.deviceGroupNotFound');
 if(await d.one(sql`SELECT id FROM device_groups WHERE parent_id=${groupId} LIMIT 1`))throw new HttpError('apiError.group.hasChildren');
 // Entra group mappings on this group (lib/server/identity/entra/settings.ts) go first: the delete never removes an assignment of the Entra role sync.
 const mapped=sql`EXISTS (SELECT 1 FROM entra_group_roles WHERE scope_type='devicegroup' AND scope_id=${groupId})`;
 if(await d.one(sql`SELECT 1 AS mapped WHERE ${mapped}`))throw new HttpError('apiError.rbac.assignmentFromEntra');
 const assigned=sql`EXISTS (SELECT 1 FROM role_assignments WHERE scope_type='devicegroup' AND scope_id=${groupId})`;
 const hasAssignments=!!await d.one(sql`SELECT 1 AS assigned WHERE ${assigned}`);
 if(hasAssignments&&!await hasGlobalPermission(v,'portal.roleAssignments.manage'))throw new HttpError('apiError.rbac.assignedGroupsNeedAssignRight');
 const members=deviceGroupHasMembersSql(sql`${groupId}`),risky=sql`(${members}) OR (${deviceGroupHasAssignmentsSql(sql`${groupId}`)})`;
 const gate=await admit(deviceGroupDeleteNeedsStepUp({hasMembers:!!await d.one(sql`SELECT 1 AS member WHERE ${members}`),hasAssignments}));
 const proof='tokenHash' in gate?gate:null,session='fence' in gate?gate:null;
 const admitted=proof?proof.guard:sql`(${session!.fence}) AND NOT (${risky})`;
 const guard=sql`EXISTS (SELECT 1 FROM device_groups boundary_group WHERE boundary_group.id=${groupId} AND ${customerAccessGuard(sql`boundary_group.customer_id`,actor(v))}) AND NOT EXISTS (SELECT 1 FROM device_groups WHERE parent_id=${groupId}) AND NOT ${mapped} AND (${globalPermissionGuard(actor(v),'groups.manage')}) AND (${admitted}) AND (NOT (${assigned}) OR (${globalPermissionGuard(actor(v),'portal.roleAssignments.manage')}))`;
 const at=now(),receipt=group.name+' / '+groupId+' / '+crypto.randomUUID();
 // at= keeps the lookup on idx_audit_at: each admitted statement runs inside the
 // write transaction and must not scan the audit table.
 const admission=sql`EXISTS (SELECT 1 FROM audit WHERE at=${at} AND actor=${v.label} AND action='Gerätegruppe gelöscht' AND target=${receipt})`;
 const affectedUsers=sql`SELECT u.id,u.auth_principal FROM local_users u WHERE EXISTS (SELECT 1 FROM role_assignments a WHERE a.scope_type='devicegroup' AND EXISTS (SELECT 1 FROM device_group_ancestors ancestor WHERE ancestor.group_id=${groupId} AND ancestor.ancestor_id=a.scope_id) AND ((a.principal_type='user' AND a.principal_id=u.id) OR (a.principal_type='group' AND EXISTS (SELECT 1 FROM user_group_members m WHERE m.user_id=u.id AND m.group_id=a.principal_id))))`;
 const affected=(column:'id'|'auth_principal')=>sql`IN (SELECT ${sql.ident(column)} FROM (${affectedUsers}) affected_user)`;
 const revocations=[
  sql`UPDATE jobs SET state='cancelled',parameters='{}',result='serverMessage.job.permissionChanged' WHERE actor_principal ${affected('auth_principal')} AND state='pending' AND ${admission}`,
  ...['mfa_authenticator_challenges','mfa_management_proofs','mfa_proofs','mfa_sessions','mfa_grants','passkey_challenges'].map(table=>sql`DELETE FROM ${sql.ident(table)} WHERE principal ${affected('auth_principal')} AND ${admission}`),
  sql`DELETE FROM local_auth_sessions WHERE user_id ${affected('id')} AND ${admission}`,
  sql`UPDATE terminal_sessions SET state='closed',error='serverMessage.access.userRightsChanged' WHERE principal ${affected('auth_principal')} AND state IN ('opening','open') AND ${admission}`,
  sql`UPDATE rdp_sessions SET state='closed',key_envelope=NULL,error='serverMessage.access.userRightsChanged' WHERE principal ${affected('auth_principal')} AND state IN ('opening','open') AND ${admission}`,
  sql`UPDATE transfers SET state='cancelled',updated_at=${at},message='serverMessage.access.userRightsChanged' WHERE principal ${affected('auth_principal')} AND state NOT IN ('completed','cancelled','failed','expired') AND ${admission}`,
  sql`UPDATE runbook_runs SET cancel_requested=1 WHERE actor ${affected('auth_principal')} AND state IN ('queued','running') AND ${admission}`,
  ...['rdp_frames','rdp_receipts'].map(table=>sql`DELETE FROM ${sql.ident(table)} WHERE session_id IN (SELECT id FROM rdp_sessions WHERE principal ${affected('auth_principal')}) AND ${admission}`)
 ];
 // A fresh, guarded audit row admits the complete transaction. Subsequent
 // cleanup uses its unguessable receipt, even if the proof expires mid-batch.
 // Consume the actor's proof before revoking affected principals: the actor may
 // themselves hold a group assignment. Keep scopes until all sessions, pending
 // jobs and proofs are revoked, so every subquery sees the same affected users.
 // Any cleanup failure rolls back the audit, proof and complete group deletion.
 const results=await commitAll([
  ...auditEvent({actor:v.label,action:'Gerätegruppe gelöscht',target:receipt,guard,at}),
  ...(proof?[sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash} AND ${admission}`]:[]),
  ...revocations,
  sql`DELETE FROM device_group_members WHERE group_id=${groupId} AND ${admission}`,
  sql`DELETE FROM role_assignments WHERE scope_type='devicegroup' AND scope_id=${groupId} AND ${admission}`,
  // set-grant writes one compatibility role per user and group with the id
  // 'compat-grant:<userId>:<groupId>'. Remove the roles of this group that no
  // assignment uses any more. The id is compared literally (no LIKE): a
  // non-empty user part without ':' and the exact ':<groupId>' suffix, so the
  // roles of another group never match.
  sql`DELETE FROM rbac_roles WHERE builtin=0 AND substr(id,1,13)='compat-grant:' AND length(id)>14+length(${groupId}::text) AND right(id,1+length(${groupId}::text))=':'||${groupId}::text AND strpos(substr(id,14,length(id)-14-length(${groupId}::text)),':')=0 AND NOT EXISTS (SELECT 1 FROM role_assignments WHERE role_assignments.role_id=rbac_roles.id) AND ${admission}`,
  sql`DELETE FROM device_groups WHERE id=${groupId} AND ${admission} RETURNING id`
 ]);
 if(!results[0].rowCount){
  if(proof){
   if(!await d.one(sql`SELECT 1 AS current WHERE ${proof.guard}`))throw new HttpError('apiError.rbac.proofExpired');
  }else{
   // The session's own reply first; then a group that got a device or an
   // assignment since the read asks for the proof.
   await requireLiveSessions(session!.request,v);
   if(await d.one(sql`SELECT 1 AS risky WHERE ${risky}`))throw new HttpError('apiError.mfa.stepUpRequired');
  }
  throw new HttpError('apiError.rbac.groupRightsChanged');
 }
 if(proof&&!results[1].rowCount)throw new HttpError('apiError.rbac.proofExpired');
 if(!results.at(-1)?.rowCount)throw new HttpError('apiError.rbac.permissionOrGroupChanged');
 return {ok:true,id:groupId};
}

export type RbacScope={type:'global'|'devicegroup'|'device';id:string};
export type {InheritedReason};
export type InheritedAssignment={assignmentId:string;originType:'global'|'devicegroup';originId:string;effective:boolean;reason?:InheritedReason};
/** Scope of GET /api/rbac?scopeType=&scopeId=; null without both parameters. */
export function rbacScope(params:URLSearchParams):RbacScope|null{
 const type=params.get('scopeType'),id=params.get('scopeId');
 return type!==null&&id!==null&&(type==='global'||type==='devicegroup'||type==='device')?{type,id}:null;
}
// The scope chain of lib/server/identity/access.ts, read live: a device inherits from global '*'
// and from every ancestor (depth >= 0) of its one group (device_group_members ->
// device_group_ancestors), like permissionsFor/devicePermissionGuard. A group
// inherits from global '*' and its ancestors with depth >= 1, like
// groupPermissions/groupPermissionGuard; its own assignments are direct. Device
// assignments are never inherited. The target must pass the same filter as the
// deviceGroups/devices lists (customerAccessGuard, revoked=0), the role the same
// catalogVisibleGuard as the assignments list; otherwise the list is empty.
// rank orders the origins nearest first; 'Alle Geräte' is always last.
// effective follows the real permission check: the role gives a device
// right (roleGrantsDeviceRight) and an active subject passes the customer boundary
// for the target's customer (effectiveSubjectGuard). Otherwise reason says why,
// first match in the order of inheritedReason.
async function inheritedAssignments(v:Viewer,scope:RbacScope,order:Map<string,number>):Promise<InheritedAssignment[]>{
 if(scope.type==='global'||!guid(scope.id))return [];
 const furthest=1000000,target=scope.type==='device'
  ?{source:sql`SELECT target_device.id,target_device.customer_id FROM servers target_device WHERE target_device.id=${scope.id} AND target_device.revoked=0 AND ${customerAccessGuard(sql`target_device.customer_id`,actor(v))}`,
    origins:sql`SELECT 'devicegroup',inherited_ancestor.ancestor_id,inherited_ancestor.depth FROM inherited_target JOIN device_group_members inherited_member ON inherited_member.server_id=inherited_target.id JOIN device_group_ancestors inherited_ancestor ON inherited_ancestor.group_id=inherited_member.group_id`}
  :{source:sql`SELECT target_group.id,target_group.customer_id FROM device_groups target_group WHERE target_group.id=${scope.id} AND ${customerAccessGuard(sql`target_group.customer_id`,actor(v))}`,
    origins:sql`SELECT 'devicegroup',inherited_ancestor.ancestor_id,inherited_ancestor.depth FROM inherited_target JOIN device_group_ancestors inherited_ancestor ON inherited_ancestor.group_id=inherited_target.id WHERE inherited_ancestor.depth>=1`};
 const effective=effectiveSubjectGuard(sql`a`,sql`inherited_target.customer_id`),active=effectiveSubjectGuard(sql`a`);
 const rows=await db().query<{id:string;scope_type:'global'|'devicegroup';scope_id:string;principal_type:'user'|'group';rank:number;permissions:string;subject_effective:boolean;subject_active:boolean;group_enabled:boolean}>(sql`WITH inherited_target(id,customer_id) AS (${target.source}),
 inherited_origin(scope_type,scope_id,rank) AS (${target.origins} UNION ALL SELECT 'global','*',${furthest}::bigint FROM inherited_target)
 SELECT a.id,a.scope_type,a.scope_id,a.principal_type,inherited_origin.rank,r.permissions,${effective} AS subject_effective,${active} AS subject_active,EXISTS (SELECT 1 FROM user_groups inherited_group WHERE inherited_group.id=a.principal_id AND inherited_group.enabled=1) AS group_enabled
 FROM role_assignments a JOIN inherited_origin ON inherited_origin.scope_type=a.scope_type AND inherited_origin.scope_id=a.scope_id CROSS JOIN inherited_target JOIN rbac_roles r ON r.id=a.role_id WHERE ${catalogVisibleGuard(sql`r.customer_id`,actor(v))}`);
 // Within one origin the order of the assignments list (created_at DESC); only entries that list also returns.
 return rows.filter(row=>order.has(row.id)).sort((a,b)=>Number(a.rank)-Number(b.rank)||order.get(a.id)!-order.get(b.id)!).map(row=>{
  const reason=inheritedReason(row);
  return {assignmentId:row.id,originType:row.scope_type,originId:row.scope_id,...(reason?{effective:false,reason}:{effective:true})};
 });
}
// The first reason that applies, or null if the entry gives rights.
function inheritedReason(row:{principal_type:'user'|'group';permissions:string;subject_effective:boolean;subject_active:boolean;group_enabled:boolean}):InheritedReason|null{
 if(!roleGrantsDeviceRight(row.permissions))return 'role';
 if(row.subject_effective)return null;
 if(row.principal_type==='user')return row.subject_active?'user-customer':'user-inactive';
 if(!row.group_enabled)return 'group-disabled';
 return row.subject_active?'group-customer':'group-empty';
}

export async function rbacData(v:Viewer,scope?:RbacScope|null){
 const flags=await Promise.all(['portal.roleAssignments.manage','portal.users.manage','portal.userGroups.manage','portal.roles.manage'].map(right=>hasGlobalPermission(v,right)));
 if(!flags.some(Boolean))throw new HttpError('apiError.rbac.accessPortalRightMissing');const d=db();
 const [users,userGroups,members,roles,assignments,deviceGroups,devices]=await Promise.all([
  d.query<UserRow>(sql`SELECT id,username,email,display_name,status,auth_principal,identity_source,password_hash IS NOT NULL AS password_set,EXISTS (SELECT 1 FROM mfa_accounts m WHERE m.principal=local_users.auth_principal) AS mfa_enabled FROM local_users ORDER BY username LIMIT 2000`),
  d.query<{id:string;name:string;description:string;enabled:number}>(sql`SELECT id,name,description,enabled FROM user_groups ORDER BY name LIMIT 1000`),
  d.query<{group_id:string;user_id:string}>(sql`SELECT group_id,user_id FROM user_group_members`),
  // Roles of customers the viewer does not see, and their assignments, are left out.
  d.query<RoleRow&{customer_name:string|null}>(sql`SELECT r.id,r.name,r.description,r.permissions,r.builtin,r.customer_id,c.name AS customer_name FROM rbac_roles r LEFT JOIN customers c ON c.id=r.customer_id WHERE ${catalogVisibleGuard(sql`r.customer_id`,actor(v))} ORDER BY r.builtin DESC,r.name LIMIT 1000`),
  // Assignments on groups and devices of customers the viewer does not see are left out too.
  d.query<AssignmentRow>(sql`SELECT a.id,a.principal_type,a.principal_id,a.role_id,a.scope_type,a.scope_id,a.source FROM role_assignments a WHERE EXISTS (SELECT 1 FROM rbac_roles r WHERE r.id=a.role_id AND ${catalogVisibleGuard(sql`r.customer_id`,actor(v))}) AND ${assignmentScopeGuard(sql`a`,actor(v))} ORDER BY a.created_at DESC LIMIT 5000`),
  // Scope targets only from the viewer's customers, also for assignment administrators.
  d.query(sql`SELECT id,name,parent_id AS "parentId",(SELECT max(depth) FROM device_group_ancestors WHERE group_id=device_groups.id) AS depth,customer_id AS "customerId" FROM device_groups WHERE ${customerAccessGuard(sql`device_groups.customer_id`,actor(v))} ORDER BY name`),d.query(sql`SELECT id,name,customer_id AS "customerId" FROM servers WHERE revoked=0 AND ${customerAccessGuard(sql`servers.customer_id`,actor(v))} ORDER BY name`)
 ]),catalog=await catalogOwnership(v),privilegedWritable=await privilegedWriteAllowed(v);
 const inherited=scope&&scope.type!=='global'?{inherited:await inheritedAssignments(v,scope,new Map(assignments.map((assignment,index)=>[assignment.id,index])))}:{};
 return {...inherited,catalog,privilegedWritable,users:users.map(user=>({id:user.id,username:user.username,email:user.email,displayName:user.display_name,status:user.status,passwordSet:!!user.password_set,mfaEnabled:!!user.mfa_enabled,identitySource:user.identity_source})),userGroups:userGroups.map(group=>({id:group.id,name:group.name,description:group.description,enabled:!!group.enabled,userIds:members.filter(member=>member.group_id===group.id).map(member=>member.user_id)})),roles:roles.map(role=>({id:role.id,name:role.name,description:role.description,permissions:parsedPermissions(role.permissions),builtIn:!!role.builtin,customerId:role.customer_id,customerName:role.customer_id===null?null:role.customer_name})),assignments:assignments.map(assignment=>({id:assignment.id,subjectType:assignment.principal_type,subjectId:assignment.principal_id,roleId:assignment.role_id,scopeType:assignment.scope_type,scopeId:assignment.scope_id,source:assignment.source})),deviceGroups,devices,permissions:[...permissionDefinitions,...portalPermissionDefinitions],canManage:true,canManageAssignments:flags[0],canManageUsers:flags[1],canManageUserGroups:flags[2],canManageRoles:flags[3]};
}

export async function manageRbac(v:Viewer,p:Record<string,unknown>,proof:ManagementAuthorization){
 const d=db(),at=now(),commit=(statement:Sql,follow:Step[]=[])=>commitManagementChange(statement,proof,follow);
 if(p.action==='create-group'){
  const guard=await need(v,'portal.userGroups.manage',proof),name=names(p.name,'apiError.rbac.groupName'),description=descriptions(p.description),groupId=crypto.randomUUID();
  const changed=await commit(sql`INSERT INTO user_groups(id,name,description,enabled,created_at) SELECT ${groupId},${name},${description},1,${at} WHERE ${guard} AND (SELECT count(*) FROM user_groups)<1000 RETURNING id`,changeAudit(v,'Benutzergruppe erstellt',name));if(!changed)throw new HttpError('apiError.rbac.groupLimit');return {ok:true,id:groupId};
 }
 if(p.action==='update-group'){
  let guard=await need(v,'portal.userGroups.manage',proof);const group=await requireUserGroup(id(p.id)),name=names(p.name,'apiError.rbac.groupName'),description=descriptions(p.description);if(typeof p.enabled!=='boolean')throw new HttpError('apiError.rbac.groupStatus');if(!!group.enabled!==p.enabled)guard=protectAssignedGroup(v,guard,group.id);
  const enabling=!group.enabled&&p.enabled;if(enabling){if(!await customerGroupAllowed(v,group.id))throw new HttpError('apiError.rbac.customerGroupOwnerOnly');if(!await privilegedGroupAllowed(v,group.id))throw new HttpError('apiError.rbac.privilegedGroupOwnerOnly');guard=protectPrivilegedGroup(v,protectCustomerGroup(v,guard,group.id),group.id);}
  const affected=await affectedAssignmentUsers('group',group.id),changed=await commit(sql`UPDATE user_groups SET name=${name},description=${description},enabled=${p.enabled?1:0} WHERE id=${group.id} AND enabled=${group.enabled} AND ${guard} RETURNING id`,[...changeAudit(v,'Benutzergruppe geändert',name),...(enabling?[voidedLinksAudit(v,{kind:'group',groupId:group.id}),voidOpenTokens({kind:'group',groupId:group.id},at),...customerGainStatements(v,{kind:'customer-group',groupId:group.id},at)]:[])]);if(!changed&&enabling&&!await customerGroupAllowed(v,group.id))throw new HttpError('apiError.rbac.customerGroupOwnerOnly');if(!changed&&enabling&&!await privilegedGroupAllowed(v,group.id))throw new HttpError('apiError.rbac.privilegedGroupOwnerOnly');if(!changed)throw new HttpError('apiError.rbac.groupStatusChanged');if(!!group.enabled!==p.enabled)await invalidateRbacUsers(affected);return {ok:true};
 }
 if(p.action==='add-member'||p.action==='remove-member'){
  const base=await need(v,'portal.userGroups.manage',proof),group=await requireUserGroup(id(p.groupId)),user=await requireUser(id(p.userId),p.action==='remove-member'),adding=p.action==='add-member';
  if(adding&&!await customerGroupAllowed(v,group.id))throw new HttpError('apiError.rbac.customerGroupOwnerOnly');
  if(adding&&!await privilegedGroupAllowed(v,group.id))throw new HttpError('apiError.rbac.privilegedGroupOwnerOnly');
  if(!adding&&!await groupCustomersSeen(v,group.id))throw new HttpError('apiError.rbac.customerGroupBoundary');
  const guard=adding?protectPrivilegedGroup(v,protectCustomerGroup(v,protectAssignedGroup(v,base,group.id),group.id),group.id):withGuard(protectAssignedGroup(v,base,group.id),groupCustomersSeenGuard(v,group.id));let changed;
  if(p.action==='add-member')changed=await commit(sql`INSERT INTO user_group_members(group_id,user_id) SELECT ${group.id},${user.id} WHERE ${guard} AND EXISTS (SELECT 1 FROM user_groups WHERE id=${group.id}) AND EXISTS (SELECT 1 FROM local_users WHERE id=${user.id} AND status<>'disabled') ON CONFLICT(group_id,user_id) DO NOTHING RETURNING user_id`,[...changeAudit(v,'Benutzergruppenmitglied hinzugefügt',user.id+' / '+group.name),voidedLinksAudit(v,{kind:'member',groupId:group.id,userId:user.id}),voidOpenTokens({kind:'member',groupId:group.id,userId:user.id},at),...customerGainStatements(v,{kind:'customer-member',groupId:group.id,userId:user.id},at)]);
  else changed=await commit(sql`DELETE FROM user_group_members WHERE group_id=${group.id} AND user_id=${user.id} AND ${guard} RETURNING user_id`,changeAudit(v,'Benutzergruppenmitglied entfernt',user.id+' / '+group.name));
  if(!changed){if(adding&&!await customerGroupAllowed(v,group.id))throw new HttpError('apiError.rbac.customerGroupOwnerOnly');if(adding&&!await privilegedGroupAllowed(v,group.id))throw new HttpError('apiError.rbac.privilegedGroupOwnerOnly');if(!adding&&!await groupCustomersSeen(v,group.id))throw new HttpError('apiError.rbac.customerGroupBoundary');if(!await permitted(protectAssignedGroup(v,globalPermissionGuard(actor(v),'portal.userGroups.manage'),group.id)))throw new HttpError('apiError.rbac.membersNeedAssignRight');return {ok:true};}
  await invalidateRbacUsers([user]);return {ok:true};
 }
 if(p.action==='delete-group'){
  const base=await need(v,'portal.userGroups.manage',proof),group=await requireUserGroup(id(p.id)),guard=protectAssignedGroup(v,base,group.id),affected=await affectedAssignmentUsers('group',group.id);
  // Its assignments and members go in the same batch, once the group is gone.
  // Group IDs are never reused and both are only added while the group exists,
  // so a batch whose delete was refused finds the group and removes nothing.
  const gone=sql`NOT EXISTS (SELECT 1 FROM user_groups WHERE id=${group.id})`;
  const changed=await commit(sql`DELETE FROM user_groups WHERE id=${group.id} AND ${guard} RETURNING id`,[...changeAudit(v,'Benutzergruppe gelöscht',group.name),sql`DELETE FROM role_assignments WHERE principal_type='group' AND principal_id=${group.id} AND ${gone}`,sql`DELETE FROM user_group_members WHERE group_id=${group.id} AND ${gone}`]);if(!changed)throw new HttpError('apiError.rbac.userGroupRightRevoked');
  await invalidateRbacUsers(affected);return {ok:true};
 }
 if(p.action==='create-role'){
  // Decided on the raw request, so a non-Owner also gets the Owner rule for '*' (custom roles reject it afterwards).
  let guard=await need(v,'portal.roles.manage',proof);const privileged=privilegedPermissions(p.permissions);
  if(privileged){await requirePrivilegedRoleWrite(v);guard=withGuard(guard,privilegedWriteGuard(v));}
  const name=names(p.name,'apiError.rbac.roleName',100),description=descriptions(p.description),permissions=rights(p.permissions),roleId=crypto.randomUUID();
  const customerId=await catalogOwner(v,p.customerId);customerRoleRights(customerId,permissions);const owner=catalogWriteGuard(v,customerId);
  const changed=await catalogCommit(()=>commit(sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at,customer_id) SELECT ${roleId},${name},${description},${JSON.stringify(permissions)},0,${at},${customerId} WHERE ${guard} AND ${owner} AND (SELECT count(*) FROM rbac_roles)<1000 RETURNING id`,changeAudit(v,'Benutzerdefinierte Rolle erstellt',name)));if(!changed&&privileged&&!await privilegedWriteAllowed(v))throw new HttpError('apiError.rbac.privilegedRoleOwnerOnly');if(!changed)throw await catalogWriteFailure(v,customerId)??new HttpError('apiError.rbac.roleLimit');return {ok:true,id:roleId};
 }
 if(p.action==='update-role'){
  let guard=await need(v,'portal.roles.manage',proof);const role=await requireRole(v,p.id);if(role.builtin)throw new HttpError('apiError.rbac.builtInImmutable');
  // Old and requested permissions; the old ones are pinned by permissions=? below, so the rule covers both sides.
  const privileged=privilegedPermissions(parsedPermissions(role.permissions))||privilegedPermissions(p.permissions);if(privileged){await requirePrivilegedRoleWrite(v);guard=withGuard(guard,privilegedWriteGuard(v));}
  const name=names(p.name,'apiError.rbac.roleName',100),description=descriptions(p.description),permissions=rights(p.permissions),json=JSON.stringify(permissions);
  requireSameCatalogOwner(p.customerId,role.customer_id);await requireCatalogWrite(v,role.customer_id);customerRoleRights(role.customer_id,permissions);guard=withGuard(guard,catalogWriteGuard(v,role.customer_id));
  if(json!==role.permissions)guard=sql`(${guard}) AND (NOT EXISTS (SELECT 1 FROM role_assignments assigned_role WHERE assigned_role.role_id=${role.id}) OR ${globalPermissionGuard(actor(v),'portal.roleAssignments.manage')})`;
  const changed=await catalogCommit(()=>commit(sql`UPDATE rbac_roles SET name=${name},description=${description},permissions=${json} WHERE id=${role.id} AND builtin=0 AND permissions=${role.permissions} AND ${guard} RETURNING id`,[...changeAudit(v,'Benutzerdefinierte Rolle geändert',name),voidedLinksAudit(v,{kind:'role',roleId:role.id,before:role.permissions,after:json}),voidOpenTokens({kind:'role',roleId:role.id,before:role.permissions,after:json},at)]));if(!changed&&privileged&&!await privilegedWriteAllowed(v))throw new HttpError('apiError.rbac.privilegedRoleOwnerOnly');if(!changed)throw await catalogWriteFailure(v,role.customer_id)??new HttpError('apiError.rbac.roleChanged');if(json!==role.permissions)await invalidateRbacUsers(await affectedRoleUsers(role.id));return {ok:true};
 }
 if(p.action==='delete-role'){
  let guard=await need(v,'portal.roles.manage',proof);const role=await requireRole(v,p.id);if(role.builtin)throw new HttpError('apiError.rbac.builtInUndeletable');
  // A privileged role is deleted by an Owner only; the live rule is bound to the
  // stored permissions, so a role made privileged meanwhile is not deleted.
  const privileged=privilegedPermissions(parsedPermissions(role.permissions)),privilegedGuard=privilegedWriteGuard(v);if(privileged)await requirePrivilegedRoleWrite(v);
  guard=withGuard(guard,sql`(NOT ${privilegedRoleSql(sql`rbac_roles`)} OR ${privilegedGuard})`);
  await requireCatalogWrite(v,role.customer_id);const owner=catalogWriteGuard(v,role.customer_id);
  const changed=await commit(sql`DELETE FROM rbac_roles WHERE id=${role.id} AND builtin=0 AND ${guard} AND ${owner} AND NOT EXISTS (SELECT 1 FROM role_assignments WHERE role_id=${role.id}) AND NOT EXISTS (SELECT 1 FROM entra_group_roles WHERE role_id=${role.id}) RETURNING id`,changeAudit(v,'Benutzerdefinierte Rolle gelöscht',role.name));if(!changed&&privileged&&!await privilegedWriteAllowed(v))throw new HttpError('apiError.rbac.privilegedRoleOwnerOnly');if(!changed)throw await catalogWriteFailure(v,role.customer_id)??new HttpError('apiError.rbac.roleInUse');return {ok:true};
 }
 if(p.action==='add-assignment'){
  let guard=await need(v,'portal.roleAssignments.manage',proof);const type=p.subjectType;if(type!=='user'&&type!=='group')throw new HttpError('apiError.rbac.selectSubject');const subjectId=id(p.subjectId),role=await requireRole(v,p.roleId),scope=p.scopeType;
  // Any subject and scope, also the built-in Owner role. permissions=? below
  // keeps a role that becomes privileged before the commit from being assigned.
  const privileged=privilegedPermissions(parsedPermissions(role.permissions));if(privileged){await requirePrivilegedRoleWrite(v);guard=withGuard(guard,privilegedWriteGuard(v));}
  if(scope!=='global'&&scope!=='devicegroup'&&scope!=='device')throw new HttpError('apiError.rbac.selectScope');const scopeId=scope==='global'?'*':id(p.scopeId);if(scope==='global'&&p.scopeId!=='*')throw new HttpError('apiError.rbac.globalScopeWildcard');
  if(type==='user')await requireUser(subjectId);else await requireUserGroup(subjectId);
  // A customer role applies only to groups and devices of its customer, never globally; 0034 enforces the same at the commit.
  if(role.customer_id!==null&&(scope==='global'||await d.one<{customer_id:string}>(sql`SELECT customer_id FROM ${sql.ident(scope==='devicegroup'?'device_groups':'servers')} WHERE id=${scopeId}`).then(row=>row===null?null:row.customer_id)!==role.customer_id))throw new HttpError('apiError.customer.roleScope');
  let scopeGuard=sql`TRUE`;
  if(scope!=='global'){if(parsedPermissions(role.permissions).some(right=>right.startsWith('portal.')))throw new HttpError('apiError.rbac.portalRolesGlobal');scopeGuard=scope==='devicegroup'?sql`EXISTS (SELECT 1 FROM device_groups WHERE id=${scopeId} AND ${customerAccessGuard(sql`device_groups.customer_id`,actor(v))})`:sql`EXISTS (SELECT 1 FROM servers WHERE id=${scopeId} AND revoked=0 AND ${customerAccessGuard(sql`servers.customer_id`,actor(v))})`;}
  const subjectGuard=type==='user'?sql`EXISTS (SELECT 1 FROM local_users WHERE id=${subjectId} AND status<>'disabled')`:sql`EXISTS (SELECT 1 FROM user_groups WHERE id=${subjectId})`;
  const assignmentId=crypto.randomUUID(),changed=await catalogCommit(()=>commit(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) SELECT ${assignmentId},${type},${subjectId},${role.id},${scope},${scopeId},${at},${principal(v)} WHERE ${guard} AND ${subjectGuard} AND ${scopeGuard} AND EXISTS (SELECT 1 FROM rbac_roles WHERE id=${role.id} AND permissions=${role.permissions}) AND NOT EXISTS (SELECT 1 FROM role_assignments WHERE principal_type=${type} AND principal_id=${subjectId} AND role_id=${role.id} AND scope_type=${scope} AND scope_id=${scopeId}) AND (SELECT count(*) FROM role_assignments)<5000 RETURNING id`,[...changeAudit(v,'Rollenzuweisung erstellt',type+':'+subjectId+' / '+role.name+' / '+scope+':'+scopeId),voidedLinksAudit(v,{kind:'assignment',assignmentId}),voidOpenTokens({kind:'assignment',assignmentId},at)]));
  if(!changed&&privileged&&!await privilegedWriteAllowed(v))throw new HttpError('apiError.rbac.privilegedRoleOwnerOnly');
  if(!changed){const existing=await d.one<{id:string}>(sql`SELECT id FROM role_assignments WHERE principal_type=${type} AND principal_id=${subjectId} AND role_id=${role.id} AND scope_type=${scope} AND scope_id=${scopeId}`);if(existing&&await hasGlobalPermission(v,'portal.roleAssignments.manage')&&await d.one(sql`SELECT 1 AS visible WHERE ${scopeGuard}`))return {ok:true,id:existing.id};throw new HttpError('apiError.rbac.assignmentChanged');}
  await invalidateRbacUsers(await affectedAssignmentUsers(type,subjectId));return {ok:true,id:assignmentId};
 }
 if(p.action==='delete-assignment'){
  // An assignment on a group or device of a customer the actor does not see
  // (assignmentScopeGuard, docs/customers.md) answers as an unknown ID; the commit
  // checks the same boundary again, so a visibility lost meanwhile gives the 409.
  const guard=await need(v,'portal.roleAssignments.manage',proof),assignment=await d.one<AssignmentRow>(sql`SELECT a.id,a.principal_type,a.principal_id,a.role_id,a.scope_type,a.scope_id,a.source FROM role_assignments a WHERE a.id=${id(p.id)} AND ${assignmentScopeGuard(sql`a`,actor(v))}`);if(!assignment)throw new HttpError('apiError.rbac.assignmentNotFound');
  // Only the Entra role sync (lib/server/identity/entra/role-sync.ts) removes an assignment of an Entra group mapping.
  if(assignment.source==='entra')throw new HttpError('apiError.rbac.assignmentFromEntra');
  const owner=lastOwnerGuard(null,assignment.id),affected=await affectedAssignmentUsers(assignment.principal_type,assignment.principal_id),scope=assignmentScopeGuard(sql`role_assignments`,actor(v));
  // The emergency access keeps its direct, global Owner assignment while
  // Microsoft sign-in only is on (docs/entra-id.md), before and in the delete.
  const emergencyOwner=sql`(role_assignments.principal_type='user' AND role_assignments.role_id='builtin-owner' AND role_assignments.scope_type='global' AND role_assignments.scope_id='*' AND ${emergencyFixedSql(sql`role_assignments.principal_id`)})`;
  const refuseEmergency=async()=>{if(await d.one(sql`SELECT 1 AS fixed FROM role_assignments WHERE id=${assignment.id} AND ${emergencyOwner}`))throw new HttpError('apiError.rbac.emergencyOwner');};
  await refuseEmergency();
  const changed=await commit(sql`DELETE FROM role_assignments WHERE id=${assignment.id} AND source='manual' AND ${guard} AND ${scope} AND NOT ${emergencyOwner} AND (NOT (principal_type='user' AND scope_type='global' AND scope_id='*' AND EXISTS (SELECT 1 FROM rbac_roles held_role WHERE held_role.id=role_id AND EXISTS (SELECT 1 FROM ${permissionElements(sql`held_role`)} held_right WHERE held_right.value='*'))) OR ${owner}) RETURNING id`,changeAudit(v,'Rollenzuweisung entfernt',assignment.id));
  if(!changed){await refuseEmergency();throw new HttpError('apiError.rbac.lastOwner');}await invalidateRbacUsers(affected);return {ok:true};
 }
 throw new HttpError('apiError.rbac.unknownAction');
}
