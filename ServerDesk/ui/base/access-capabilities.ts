import type {DeviceGroup,Viewer} from '@/lib/types';
import type {SettingsSection} from '@/lib/console-route';

type AccessViewer=Pick<Viewer,'permissions'|'canManageDeviceGroups'>;
// The global Owner: the server adds '*' to the viewer's permissions (lib/server/identity/local-auth.ts
// userViewer). The client uses it only to shape the interface; the server decides.
// A viewer without permissions has no rights.
export function isOwner(viewer:AccessViewer){return viewer.permissions?.includes('*')===true;}
const has=(viewer:AccessViewer,right:string)=>isOwner(viewer)||viewer.permissions?.includes(right)===true;
export function canManageAccounts(viewer:AccessViewer){return has(viewer,'portal.users.manage');}
export function canManageRbac(viewer:AccessViewer){return ['portal.users.manage','portal.userGroups.manage','portal.roles.manage','portal.roleAssignments.manage'].some(right=>has(viewer,right));}
export function canManageRoleAssignments(viewer:AccessViewer){return has(viewer,'portal.roleAssignments.manage');}
export function canManageUserGroups(viewer:AccessViewer){return has(viewer,'portal.userGroups.manage')||canManageRoleAssignments(viewer);}
export function canManageRoles(viewer:AccessViewer){return has(viewer,'portal.roles.manage')||canManageRoleAssignments(viewer);}
export function canViewPortalAudit(viewer:AccessViewer){return isOwner(viewer);}
export function canManageDeviceGroups(viewer:AccessViewer){return viewer.canManageDeviceGroups??has(viewer,'groups.manage');}
// Settings that apply to the whole instance (usage data, retention, the vulnerability check), so only global Owners ('*') see them.
export function canManageInstanceSettings(viewer:AccessViewer){return isOwner(viewer);}
// Customers carry contact data and span the instance, so only global Owners ('*') see them.
export function canManageCustomers(viewer:AccessViewer){return isOwner(viewer);}
// Notification channels and their delivery log need the portal right (docs/notifications.md); Owners hold it through '*'.
export function canManageNotifications(viewer:AccessViewer){return has(viewer,'portal.notifications.manage');}
// Sign-in with Microsoft Entra ID decides who signs in and which roles Entra groups give: the instance settings rule too.
// The automatic logout (Sessions), the data retention, the vulnerability check (an outbound connection) and the AI assistant keys apply to the whole instance: the instance settings rule.
export function canOpenAccessSection(viewer:AccessViewer,section:SettingsSection){return section==='notification-channels'?canManageNotifications(viewer):section==='accounts'?canManageAccounts(viewer):section==='user-groups'?canManageUserGroups(viewer):section==='roles'?canManageRoles(viewer):section==='customers'?canManageCustomers(viewer):section==='vulnerabilities'||section==='assistant'||section==='entra'||section==='usage-data'||section==='branding'||section==='sessions'||section==='retention'?canManageInstanceSettings(viewer):canViewPortalAudit(viewer);}
// Device groups: the root group right (create top-level groups, delete groups) and the right to manage one group.
export const hasRootGroupRight=(viewer:Pick<Viewer,'permissions'>)=>isOwner(viewer)||viewer.permissions?.includes('groups.manage')===true;
export const canManageGroup=(viewer:AccessViewer,group:Pick<DeviceGroup,'permissions'>|undefined)=>!!group&&canManageDeviceGroups(viewer)&&(hasRootGroupRight(viewer)||group.permissions.includes('groups.manage'));
