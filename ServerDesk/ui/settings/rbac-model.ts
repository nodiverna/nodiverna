// The access management model of Settings › Accounts, User groups and Roles and of the Permissions view on a scope or
// a device: the types of GET /api/rbac, the built-in role descriptions and the pure label helpers. No React, no
// request: the pages (settings-accounts.tsx, settings-user-groups.tsx, settings-roles.tsx), the assignments view
// (ui/devices/configuration/permissions-tab.tsx) and the shared hook (ui/settings/rbac-data.ts) import it, and tests run it directly.
import type {StatusKind} from '@/ui/kit/kit';
import type {InheritedReason} from '@/lib/server/identity/inherited-reason';
import type {AccessPermission} from '@/ui/settings/access-model';
import type {CatalogOwnership} from '@/ui/base/catalog-owner';
import {privilegedRole} from '@/ui/base/cross-customer';
import {rbacAccountName} from '@/ui/settings/rbac-account-text';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';

/** identitySource 'entra': an account from Microsoft Entra ID; name, email and password come from Entra (docs/entra-id.md). */
export type RbacUser={id:string;username:string;email:string|null;displayName:string;status:'active'|'invited'|'disabled';mfaEnabled?:boolean;passwordSet?:boolean;identitySource?:'local'|'entra'};
export type RbacGroup={id:string;name:string;description:string;enabled:boolean;userIds:string[]};
export type RbacRole={id:string;name:string;description:string;permissions:string[];builtIn:boolean;customerId?:string|null;customerName?:string|null};
/** source 'entra': written by the Entra role sync from a group mapping; only a mapping change removes it. */
export type RbacAssignment={id:string;subjectType:'user'|'group';subjectId:string;roleId:string;scopeType:'global'|'devicegroup'|'device';scopeId:string;source?:'manual'|'entra'};
/**
 * An assignment that applies here through All devices or a parent group, nearest origin first (lib/server/identity/rbac.ts); only with
 * a device or group scope. effective=false: the entry gives nobody rights here, and reason says why.
 */
export type RbacInherited={assignmentId:string;originType:'global'|'devicegroup';originId:string;effective?:boolean;reason?:InheritedReason};
export type RbacData={inherited?:RbacInherited[];users:RbacUser[];userGroups:RbacGroup[];roles:RbacRole[];assignments:RbacAssignment[];deviceGroups:{id:string;name:string;customerId?:string}[];devices:{id:string;name:string;customerId?:string}[];permissions:AccessPermission[];canManage:boolean;canManageUsers:boolean;canManageAssignments:boolean;canManageUserGroups:boolean;canManageRoles:boolean;catalog?:CatalogOwnership;privilegedWritable?:boolean};
/** The reply of a change: create-user also returns the new account and its one-time link (lib/server/identity/account-admin.ts). */
export type RbacReply={ok:boolean;id?:string;user?:{id:string};invitationUrl?:string;expiresAt?:number};
export type PermissionScope={type:'global'|'group'|'device';id?:string};
export type IdentitySection='accounts'|'usergroups'|'roles';
/** Origin of an inherited assignment, as the console's inventoryAction('permissions',target) takes it. */
export type PermissionOrigin={type:'global';name:string}|{type:'group';id:string;name:string};
/** "Assign role" from Accounts: the All devices assignment drawer opens with this account chosen. */
export type PermissionPrefill={subjectType:'user';subjectId:string};

// The six built-in roles of lib/server/identity/rbac.ts (builtinRoleIds). Their seeded descriptions are German rows; the pages show the
// catalog text instead. Custom roles show their own text. Exported for tests/lib/i18n-server.mjs, which checks that it covers
// exactly builtinRoleIds.
export const builtInRoleDescriptions:Readonly<Record<string,MessageKey>>={'builtin-owner':'rbac.builtInRole.owner','builtin-reader':'rbac.builtInRole.reader','builtin-operator':'rbac.builtInRole.operator','builtin-device-administrator':'rbac.builtInRole.deviceAdministrator','builtin-user-access-administrator':'rbac.builtInRole.userAccessAdministrator','builtin-portal-operator':'rbac.builtInRole.portalOperator'};
/** The description of a role in the locale: the catalog text of a built-in role, else the stored text. */
export function roleDescription(role:Pick<RbacRole,'id'|'builtIn'|'description'>,t:(key:MessageKey)=>string):string{return role.builtIn&&Object.hasOwn(builtInRoleDescriptions,role.id)?t(builtInRoleDescriptions[role.id]):role.description;}

/** The scope of the API: All devices is global '*', a group is devicegroup; null without a concrete group or device. */
export const wireScope=(scope:PermissionScope|undefined):{type:RbacAssignment['scopeType'];id:string}|null=>scope?.type==='global'?{type:'global',id:'*'}:scope?.id?.trim()&&['group','device'].includes(scope.type)?{type:scope.type==='group'?'devicegroup':'device',id:scope.id}:null;
/** GET /api/rbac; a device or group scope also asks for the assignments inherited there. */
export const rbacEndpoint=(scope:ReturnType<typeof wireScope>):string=>scope&&scope.type!=='global'?`/api/rbac?${new URLSearchParams({scopeType:scope.type,scopeId:scope.id})}`:'/api/rbac';

/** The user name rule of create-user (lib/server/identity/account-admin.ts): 3 to 64 characters, letters, digits and . _ @ + -. */
export const validUsername=(value:string):boolean=>/^[a-z0-9][a-z0-9._@+-]{2,63}$/.test(value.trim().toLowerCase());

/** The status of an account in the locale. */
export const statusLabel=(status:RbacUser['status'],locale:Locale=defaultLocale)=>status==='active'?translate(locale,'management.active'):status==='invited'?translate(locale,'rbac.status.invited'):translate(locale,'fleet.disabled');
/** The pill of an account status: Active success, Activation pending waiting, Deactivated neutral. */
export const statusKind=(status:RbacUser['status']):StatusKind=>status==='active'?'success':status==='invited'?'waiting':'neutral';
export const scopeLabel=(assignment:Pick<RbacAssignment,'scopeType'|'scopeId'>,data:Pick<RbacData,'deviceGroups'|'devices'>,locale:Locale=defaultLocale)=>assignment.scopeType==='global'?translate(locale,'tree.allDevices'):assignment.scopeType==='devicegroup'?translate(locale,'rbac.scope.group',{value:data.deviceGroups.find(group=>group.id===assignment.scopeId)?.name??translate(locale,'rbac.scope.gone')}):translate(locale,'rbac.scope.device',{value:data.devices.find(device=>device.id===assignment.scopeId)?.name??translate(locale,'rbac.scope.gone')});
/** The second line of a subject: disabled or not yet activated subjects grant no rights (lib/server/identity/access.ts subjects()). */
export const subjectKind=(assignment:Pick<RbacAssignment,'subjectType'|'subjectId'>,data:Pick<RbacData,'users'|'userGroups'>,locale:Locale=defaultLocale)=>{if(assignment.subjectType==='group')return data.userGroups.find(group=>group.id===assignment.subjectId)?.enabled===false?translate(locale,'rbac.subject.groupDisabled'):translate(locale,'rbac.userGroup');const user=data.users.find(entry=>entry.id===assignment.subjectId);return user&&user.status!=='active'?translate(locale,'rbac.subject.userStatus',{statusLabel:statusLabel(user.status,locale)}):translate(locale,'rbac.account');};
export const subjectLabel=(assignment:Pick<RbacAssignment,'subjectType'|'subjectId'>,data:Pick<RbacData,'users'|'userGroups'>,locale:Locale=defaultLocale)=>{if(assignment.subjectType==='group')return data.userGroups.find(group=>group.id===assignment.subjectId)?.name??translate(locale,'rbac.subject.groupGone');const user=data.users.find(entry=>entry.id===assignment.subjectId);return user?rbacAccountName(user):translate(locale,'rbac.subject.accountGone');};
export const roleName=(assignment:Pick<RbacAssignment,'roleId'>,data:Pick<RbacData,'roles'>,locale:Locale=defaultLocale)=>data.roles.find(role=>role.id===assignment.roleId)?.name??translate(locale,'rbac.roleGone');

/** A user group with role assignments: changing its members, activation or existence also needs the assignment right. */
export const groupHasAssignments=(group:Pick<RbacGroup,'id'>,data:Pick<RbacData,'assignments'>)=>data.assignments.some(assignment=>assignment.subjectType==='group'&&assignment.subjectId===group.id);
/** Whether the viewer may change the access of a group (today's canEditSelectedGroupAccess rule). */
export const canChangeGroupAccess=(group:Pick<RbacGroup,'id'>,data:Pick<RbacData,'assignments'|'canManageUserGroups'|'canManageAssignments'>)=>data.canManageUserGroups&&(!groupHasAssignments(group,data)||data.canManageAssignments);
export const roleAssigned=(role:Pick<RbacRole,'id'>,data:Pick<RbacData,'assignments'>)=>data.assignments.some(assignment=>assignment.roleId===role.id);
/** A custom role the viewer's catalog may change: a customer role, or a library role while the library is writable. */
export const roleWritable=(role:Pick<RbacRole,'builtIn'|'customerId'>,data:Pick<RbacData,'catalog'>)=>!role.builtIn&&(!!role.customerId||data.catalog?.libraryWritable!==false);
/** Roles with '*' or the cross-customer right are changed and assigned by Owners only (privilegedWritable false). */
export const rolePrivilegedLocked=(role:Pick<RbacRole,'permissions'>,data:Pick<RbacData,'privilegedWritable'>)=>data.privilegedWritable===false&&privilegedRole(role.permissions);
