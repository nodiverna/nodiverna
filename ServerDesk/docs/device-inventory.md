# Device tree, groups and permissions

`GET /api/console` returns the authoritative group catalog for the device tree in `deviceGroups`. ServerDesk does not make the groups from the devices that are visible at that time. Thus empty groups stay visible to users with the necessary rights. An entry contains `id`, `name`, `description`, `parentId`, `depth`, `deviceCount` and the effective device permissions in `permissions`.

The catalog contains the groups with inherited `view` or `groups.manage` and their ancestors. A direct device permission adds the full group path of this device. Such a path does not give a group permission. A node that only shows context can have `permissions: []`. Other empty sibling groups stay hidden.

`deviceCount` counts the different visible, active devices, including the subgroups. In one group tree, a device with multiple assignments counts only one time. The request with `jobsOnly=1` does not load the group catalog again.

Global administrators for role assignments (`portal.roleAssignments.manage`) also get `permissionDevices`. This list contains only the names and IDs of active devices with their group paths. For these administrators, `deviceGroups` contains all group names and the full hierarchy, also empty groups. These target metadata are the same as the previous selection catalog from `/api/rbac`. They do not give monitoring permission. ServerDesk continues to filter `servers`, measured values, jobs and logs by the rights that the user really has.

In the full group catalog, `permissions` still contains the effective group rights of the user. `deviceCount` still counts the devices that the user can monitor. Without the global right for role assignments, the response does not contain `permissionDevices`. The SQL of the metadata queries checks the right again.

**All devices** is a virtual root node. Roles for the full portal continue to use `scopeType: "global"`, `scopeId: "*"`. Roles for a group use `devicegroup`, and roles for a single device use `device`. Portal management rights are permitted only in the global scope. A scoped Owner assignment does not make an account a global portal administrator.

These items protect role assignments: the global right `portal.roleAssignments.manage`, the current session and a one-time MFA confirmation. A minimum of one active, direct, global Owner must stay.

## Group changes and registration

`POST /api/access` supports `create-group`, `update-group`, `delete-group` and the existing actions for device assignments. `update-group` expects `id`, `name` and `description`. The action changes only the name and the description. It does not move a group. A delegated group manager needs `groups.manage` for the group. The write operation also checks this right and the current MFA and password session.

Creating, renaming and device assignments are routine changes and need no new MFA confirmation (`managementToken`). ServerDesk ignores a token that the request contains.

There is an exception: `assign-device`, `set-device-memberships` and `update-device-memberships` need a new `managementToken` when they widen access. This occurs when the change adds a device to a group and the device gets a new role assignment of type `devicegroup`. That assignment is on the target group or on a parent group. It is an assignment that the device does not reach already through its current group.

For a device without a group, each such assignment counts, for all users, user groups and roles. Global assignments and device assignments do not count. Without a valid proof, the route returns `403 MFA_STEP_UP_REQUIRED` and changes nothing. The proof is a part of the audit admission, and the same batch consumes it.

ServerDesk checks the rule again at the commit. If such an assignment appears before the batch, ServerDesk writes nothing. A removal from a group never widens access.

A deletion needs a new one-time confirmation only when the group has a device or a role assignment of type `devicegroup`. Devices of every customer count. An empty group deletes without it. The commit checks again that the group is still empty; else it deletes nothing and returns `403 MFA_STEP_UP_REQUIRED`. `GET /api/access` shows `stepUpOnDelete` for each group.

A deletion continues to need global group rights and, if applicable, role assignment rights. You cannot delete groups that have subgroups.

`POST /api/console`, `action: "enroll"`, accepts an optional `groupId`. Without `groupId` or with `null`, the new device stays without a group. A different value must identify a valid group that exists. ServerDesk creates the device identity and the direct membership in one shared transaction.

These events before the commit prevent the registration: somebody deleted the group, withdrew the global Owner rights or revoked the password or MFA session. ServerDesk never silently changes to **All devices** or to a default group. If the membership write fails, ServerDesk reverts the device creation. The registration still needs global Owner rights and an MFA sign-in.

A personal registration is an access credential, and it also needs a new `managementToken`. The route first checks the name, mode, agent version, format, signing key and group, and then the proof. Without a valid proof, it returns `403 MFA_STEP_UP_REQUIRED` and creates nothing. The proof is a part of the admission of the device entry, and the same batch consumes it.

A device belongs to exactly one device group (since `0027_single_device_group.sql`, refer to [Device groups](device-groups.md)). The device inherits the rights of the parent groups.

## New installations

A newly migrated database has no device group before and after the Owner bootstrap. Each group, also an empty group, stays until an administrator removes it with the protected delete action.

`tests/integration/selfhost-device-inventory.mjs` runs the real console and access routes, RBAC predicates and transactions on an isolated PostgreSQL test database. The tests cover these items:

- the first setup and the preservation of existing data
- empty scoped groups, ancestors and groups outside the scope
- visible device counts and exact registration targets
- revocations during a request and atomic errors
- the management of historical import groups
