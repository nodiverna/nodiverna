# Device groups

A root group can contain up to four levels of subgroups. A device belongs to
exactly one device group or to no group. Through its group, it also belongs to
all parent groups, and their rights and templates continue to apply. The device
tree shows direct members in their folder. In the scope of a group, it counts
each device only one time.

Groups and devices each belong to one customer. You can link them only in this
customer. Refer to [Customers](customers.md).

The device tree shows the hierarchy, also empty groups. Right-click
a group or select `…` to open its management. The actions for the selection also
show above the device list. The search shows the parent groups as context.

You can search the device list by name or host name. Direct members and devices
from subgroups have separate filters and show their full group path. The check
boxes change direct memberships. When you assign a device to a group, ServerDesk
moves it from its previous group to the new group. This occurs in the same path
and in a different branch. For this move, you need management rights for the two
groups.

Before you save, the list marks the moves that you prepared.
**Save assignment** confirms all changes together with
MFA. The list shows 50 devices on each page and keeps changes from all pages.

Migration `0024` removes duplicate parent and child assignments. After it,
migration `0027_single_device_group.sql` reduces each multiple assignment to
one group. The deepest group stays. For groups at the same depth, the group
name decides, and then the group ID. A unique index on
`device_group_members(server_id)` prevents new multiple assignments, also for
direct API or database access.

An assignment can still collide, for example when somebody moved the device at
the same time. Then the API returns status 409 with
`A device can belong to only one device group, …`. In this case, load the view again and move the device
again.

Since migration `0038_device_group_paths.sql`, the table `device_group_paths`
keeps the ancestry of each group. ServerDesk does not calculate it again for
each query. Triggers update the table when somebody creates, moves or deletes a
group. `device_group_ancestors` stays as a view on this table. Permission
checks and hierarchy rules continue to read through it and work as before.

The page of a group shows the group name and, when the group has one, its
description on a separate line. The device counts are on the line below it.
**All devices**, **Ungrouped** and a customer show only the device counts.

The page has five tabs: **Devices**, **Monitoring**, **Inventory**, **History** and
**Configuration**. A row of smaller tabs below them shows the views of the open
tab, for example **By device** and **By alarm**, or the reports of **Inventory**.
Each tab and view has its own route, so reload and the back button open it again.
Above the device list, the search, the status buttons and **Filters** are in one
row. **Filters** contains the device type, the state and the tag.

**Monitoring** of a group has **By device**, **By alarm**, **Alert rules** and **Notification rules**.
**Configuration** of a group has **Tags**,
**Permissions** (with the right to manage role assignments) and **General** (when you
can manage the group). The tree entries **Permissions** and **Rename** open these pages.

The page header shows **Add device** for Owners. It opens the add-device page with
the group. If you can manage the group, **Move devices here…** is next to it. It
opens a list of devices: select the devices, then select **Move**. The
devices leave their current group.

The tree menu of a group has the same entry. In the device list, **Move to group…**
moves the selected devices.

The page **General** of a group has two cards and the danger zone. In the
card **General**, change the name and the description, then select **Save**.
**Save** is a normal button, because **Add device** is the main action of
the page. **Save** is not available until you change something.

**Discard** shows only when you changed something. If you clear the name and
select **Save**, the name field shows **Enter a name**. The card **Subgroups** shows
the number of subgroups and **Create subgroup**. **Delete group** stays at the
end.

A device group can have tags. The page **Configuration → Tags** of the group shows them. A group
tag with inheritance also applies to all subgroups and devices of the group.
The nearest tag with the same name wins. Refer to
[Device descriptions and tags](device-tags.md).

A role assignment for a device group also applies to its subgroups. The rights
of many assignments combine. Automation templates can have their own
assignments on groups or devices. The automation area shows their priority and
conflicts.

When a group has no devices, the list shows **This group has no devices yet**.
Owners get **Add device**, other group managers **Move devices here…**.

In the tree, the node **Ungrouped** holds the devices without a group. It shows only below
a parent that has at least one group and one device without a group: **All devices**, or a
customer folder. The node comes after the groups and shows the number of its devices. It
starts open with up to 10 devices.

Select the node to see these devices (`#devices/ungrouped` or `#devices/customer/<id>/ungrouped`).
Drop devices on it to remove them from all groups. This needs the same right as a drop on **All devices**.

Delete groups with subgroups from the bottom to the top. The devices stay
registered and have no group after the deletion. You can also delete the
historical import group of older installations with the usual rules.

For API clients, `assign-device` stays an explicit replacement of the
membership. New clients use `/api/access` with `update-device-memberships`,
`groupId`, `addIds` and `removeIds`. `addIds` moves the devices into `groupId`.
A confirmed batch can change up to 1000 devices. ServerDesk checks all
permissions and existing memberships again in the same database commit. If the
selection is out of date, ServerDesk saves no part of it.

New installations start without a default device group. Existing installations
keep their groups and assignments. Devices without a direct group assignment
are under **All devices** in the tree.

**Permissions** in the tree manages the role assignments for
exactly this group or device. **All devices → Permissions** is the global
scope, also for roles that apply to the full portal. Role definitions, user
groups, accounts and the audit log are under **Settings**.

In an empty group, **Add device** opens the agent setup. The link keeps the target group, and you confirm
it explicitly during the registration. The API creates the device and the
assignment in one atomic step. If somebody deleted the group or the group is not
permitted, the API returns an error. It does not silently register the device without a group.
