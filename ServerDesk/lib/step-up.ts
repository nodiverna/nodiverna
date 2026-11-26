// Which actions need a fresh MFA step-up proof (managementToken, 5 minutes,
// one use) on top of the live MFA login session. The rule and the table of
// every action are in docs/portal-sessions.md ("Which actions ask for MFA
// again"): an action with real impact on devices or security that asked before
// keeps asking; organizing, notification and other changes that cannot run
// code, open access or weaken security do not; a target-dependent action asks
// only in its risky case (the predicates below); everything else relies on the
// live MFA login session. No action asks that did not ask before.
//
// The rules of the actions that keep asking:
// 1. identity and rights: accounts, user groups, roles, role assignments,
//    direct group grants, customer technicians;
//    moving devices to another customer (move-customer: it changes which
//    technicians see the devices and ends their direct assignments);
// 2. own sign-in factors: password, authenticator apps, passkeys, recovery codes;
// 3. access credentials: reset links, customer installers, personal registrations (enroll);
// 4. irreversible removal: removing devices from the portal, deleting a
//    device group that still has a device or a devicegroup role assignment,
//    and deleting a customer (it can end the customer boundary);
// 5. unrestricted execution: the SYSTEM terminal and assistant PowerShell scripts;
// 6. instance-wide security settings: the automatic logout, the MFA after it,
//    the sign-in with Microsoft Entra ID, saving an assistant provider key
//    (it decides which provider account receives device data), and a
//    maintenance or customer save that shortens an audit or job retention
//    (a shorter retention deletes audit evidence), and the setting "Multiple
//    customers" (it switches on the customer boundary for every account).
// Branding images (/api/branding PUT and DELETE, docs/branding.md) and the
// background choice and color scheme (POST /api/branding/manage) need no
// proof: an image, a background or a color scheme cannot run code, open
// access or weaken security; the live MFA login session and the Owner right
// are enough. PUT /api/account/preferences (the console background of the
// own account), PUT /api/account/pinned-devices (the pinned devices of the
// own account) and PUT /api/account/dashboard (the Dashboard layout of the own
// account) need none either: a personal display setting. PUT
// /api/dashboard/default (the default Dashboard layout, docs/dashboard.md)
// needs none: a tile order cannot run code, open access or weaken security;
// the live MFA login session and the Owner right are enough.
// Distributing signed agent and plugin releases is routine: the agent
// verifies every release against the publisher key, and the write needs the
// live MFA session, the right and a confirmation.
//
// Widening rule: moving devices into a group is routine unless it
// widens access. A change widens access when a device it adds to the target
// group gets a new devicegroup role assignment: a role_assignments row with
// scope_type='devicegroup' on an ancestor of the target group (the group itself
// included) that is not an ancestor of the device's current group. For an
// ungrouped device every such row is new. Every principal type and role counts,
// the actor's own included; global and device-scoped assignments do not, a move
// does not change them. Removing devices from a group never widens access.
//
// Shared by server routes and client components: this module imports nothing,
// so it never pulls lib/server/context.ts or the database into a bundle or a test.

/** /api/access actions that always need a fresh proof. delete-group asks only in its risky case (deviceGroupDeleteNeedsStepUp). */
export const accessStepUpActions:ReadonlySet<string>=new Set(['set-grant','delete-grant']);
/** /api/access actions that only organize devices and rely on the login session. */
export const accessRoutineActions:ReadonlySet<string>=new Set(['create-group','update-group','assign-device','set-device-memberships','update-device-memberships']);
/** /api/access membership actions that need a fresh proof only when they widen access (rule above). */
export const accessWideningStepUpActions:ReadonlySet<string>=new Set(['assign-device','set-device-memberships','update-device-memberships']);
/** /api/console actions that remove devices from the portal; each needs a fresh proof. */
export const deviceRemovalActions:ReadonlySet<string>=new Set(['remove-server','remove-servers']);
/** /api/console actions that move devices to another customer (rule 1: they change who sees the devices); each needs a fresh proof. */
export const deviceCustomerMoveActions:ReadonlySet<string>=new Set(['move-customer']);
/** /api/console actions that need a fresh proof: a personal registration (access credentials), device removal and the move to another customer. */
export const consoleStepUpActions:ReadonlySet<string>=new Set(['enroll',...deviceRemovalActions,...deviceCustomerMoveActions]);
/** /api/terminal actions that need a fresh proof: opening an interactive SYSTEM shell (unrestricted execution). */
export const terminalStepUpActions:ReadonlySet<string>=new Set(['open']);
/**
 * Rule 6, instance-wide security settings: every /api/session-settings action
 * needs a fresh proof. set-idle-timeout is the automatic logout, set-idle-mfa
 * decides whether a remembered browser resumes after it without MFA, and set
 * changes both with one proof (the one Save of Settings › Sessions).
 */
export const sessionSettingsStepUpActions:ReadonlySet<string>=new Set(['set','set-idle-timeout','set-idle-mfa']);
/**
 * Rule 6, instance-wide settings that decide which provider account receives
 * device data and pays for it: saving the organization key or a customer key
 * of the device assistant. Removing a key only stops the assistant, and
 * testing a key and the personal key of each user rely on the login session.
 */
export const assistantSettingsStepUpActions:ReadonlySet<string>=new Set(['set-organization-key','set-customer-key']);
/**
 * Rule 6, instance-wide security settings: the sign-in with Microsoft Entra ID
 * (/api/entra/settings) decides who signs in, which roles the Entra groups
 * give, which built-in account is the emergency access and whether built-in
 * accounts may sign in at all. test checks the saved connection and relies on
 * the login session.
 */
export const entraSettingsStepUpActions:ReadonlySet<string>=new Set(['save','set-enabled','add-mapping','remove-mapping','set-emergency-account','set-entra-only']);
/**
 * /api/customers actions that always need a fresh proof: the technicians
 * (rights of other users, rule 1) and the installers (access credentials,
 * rule 3), the delete of a customer (delete, rule 4) and the setting "Multiple
 * customers" (set-multiple-customers, rule 6).
 * update asks only when it shortens the customer's audit retention
 * (customerUpdateNeedsStepUp); create and set-status open no access and run no
 * code, so they rely on the login session.
 */
export const customerStepUpActions:ReadonlySet<string>=new Set(['set-technicians','create-installer','revoke-installer','set-multiple-customers','delete']);
/** /api/customers actions that need a fresh proof only in their risky case. */
export const customerConditionalStepUpActions:ReadonlySet<string>=new Set(['update']);
/** /api/customers actions that never need a fresh proof. */
export const customerRoutineActions:ReadonlySet<string>=new Set(['create','set-status']);

/**
 * Rule 5, unrestricted execution: an /api/assistant run of a PowerShell script
 * runs any code as SYSTEM, like opening the terminal, and needs a fresh proof.
 * A run of an allow-listed portal action, a question and a follow-up rely on
 * the login session (with requireMfa for changing actions, as in the console).
 */
export const assistantStepUpCommands:ReadonlySet<string>=new Set(['powershell']);

const listed=(actions:ReadonlySet<string>,action:unknown)=>typeof action==='string'&&actions.has(action);
/** Whether an /api/assistant request needs a fresh step-up proof: a run whose command is a PowerShell script. */
export function assistantActionNeedsStepUp(action:unknown,command:unknown):boolean{
 return action==='run'&&!!command&&typeof command==='object'&&listed(assistantStepUpCommands,(command as {type?:unknown}).type);
}
/** Whether an /api/access action always needs a fresh step-up proof. delete-group: deviceGroupDeleteNeedsStepUp. */
export function accessActionNeedsStepUp(action:unknown):boolean{return listed(accessStepUpActions,action);}
/** Whether an /api/access action needs a fresh step-up proof when it widens access (rule above). */
export function accessActionNeedsStepUpWhenWidening(action:unknown):boolean{return listed(accessWideningStepUpActions,action);}
/** Whether an /api/console action removes devices and therefore needs a fresh step-up proof. */
export function isDeviceRemovalAction(action:unknown):boolean{return listed(deviceRemovalActions,action);}
/** Whether an /api/console action needs a fresh step-up proof. */
export function consoleActionNeedsStepUp(action:unknown):boolean{return listed(consoleStepUpActions,action);}
/** Whether an /api/terminal action needs a fresh step-up proof. Resuming your own live shell through open does not. */
export function terminalActionNeedsStepUp(action:unknown):boolean{return listed(terminalStepUpActions,action);}
/** Whether an /api/session-settings action needs a fresh step-up proof (rule 6). */
export function sessionSettingsActionNeedsStepUp(action:unknown):boolean{return listed(sessionSettingsStepUpActions,action);}
/** Whether an /api/entra/settings action needs a fresh step-up proof (rule 6). */
export function entraSettingsActionNeedsStepUp(action:unknown):boolean{return listed(entraSettingsStepUpActions,action);}
/** Whether an /api/assistant/settings action needs a fresh step-up proof (rule 6): saving an organization or customer key. */
export function assistantSettingsActionNeedsStepUp(action:unknown):boolean{return listed(assistantSettingsStepUpActions,action);}
/** Whether an /api/customers action always needs a fresh step-up proof. update: customerUpdateNeedsStepUp. */
export function customerActionNeedsStepUp(action:unknown):boolean{return listed(customerStepUpActions,action);}

/**
 * Rule 4: deleting a device group needs a fresh proof only while the group has
 * a device membership (devices of every customer count) or a devicegroup role
 * assignment on it. An empty group carries no access.
 */
export function deviceGroupDeleteNeedsStepUp({hasMembers,hasAssignments}:{hasMembers:boolean;hasAssignments:boolean}):boolean{
 return hasMembers||hasAssignments;
}
/**
 * Whether a retention of `after` days is shorter than the `before` days that
 * applied until now. null is no limit: no limit before is longer than any
 * number, and no limit after is never shorter.
 */
export function retentionGetsShorter(before:number|null,after:number|null):boolean{
 return after!==null&&(before===null||after<before);
}
/** The audit and job retention of /api/maintenance set, in days; null is no limit. */
export type MaintenanceRetention={auditDays:number|null;jobDays:number|null};
/**
 * Rule 6: /api/maintenance set needs a fresh proof only when the audit or the
 * job retention gets shorter than the value that applied before (stored,
 * environment or default value). Run time and time zone delete nothing. run
 * applies the saved retention and never asks.
 */
export function maintenanceSetNeedsStepUp(before:MaintenanceRetention,after:MaintenanceRetention):boolean{
 return retentionGetsShorter(before.auditDays,after.auditDays)||retentionGetsShorter(before.jobDays,after.jobDays);
}
/**
 * Rule 6: /api/customers update needs a fresh proof only when the customer's
 * audit retention gets shorter than the one that applied before. Both values
 * are the effective days (the customer's own value, else the instance audit
 * retention); null is no limit. Name, contacts and maintenance window are harmless.
 */
export function customerUpdateNeedsStepUp(beforeDays:number|null,afterDays:number|null):boolean{
 return retentionGetsShorter(beforeDays,afterDays);
}
