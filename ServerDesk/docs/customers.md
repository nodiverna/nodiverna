# Customers

A customer is the tenant level above devices and device groups. The table `customers` stores the name, the status (`active` or `disabled`) and three optional contact fields (contact person, email, phone). Names are unique, and the comparison ignores upper and lower case. A name cannot be empty. Each device (`servers.customer_id`) and each device group (`device_groups.customer_id`) belongs to exactly one customer. Devices hold the customer themselves, because they can also exist without a group.

The group must only match the customer of the device. Jobs, metrics, sessions and other data with `server_id` inherit the customer through their device. Global Owners see and manage customers in **Settings → Customers**. Refer to [Manage customers](#manage-customers).

During the installation, the migration `0029_customers.sql` creates the first customer with the stored name `Standardkunde` and the fixed ID `00000000-0000-4000-8000-000000000100`. This customer owns devices and groups that somebody creates without `customer_id`, and all rows of existing databases. In the code, the ID comes only from `defaultCustomerId` in `lib/server/identity/customers.ts`. This file also contains the read functions `listCustomers`, `customerById`, `deviceCustomerId` and `groupCustomerId`. A new subgroup gets the customer of its parent group. A device that registers directly into a group gets the customer of this group ([Registration in the console](#registration-in-the-console)).

The database enforces the customer boundary itself with triggers, also for direct SQL access. It rejects these changes:

- A `customer_id` that does not exist (`customer-missing`).
- A subgroup with a customer that is different from the customer of its parent group (`customer-mismatch`). This applies when somebody creates the subgroup or changes `parent_id` or `customer_id`.
- A group membership between a device and a group of different customers (`customer-mismatch`).
- A change of `customer_id` on a device or a group that would create a membership or a parent-child relation across customers (`customer-mismatch`).
- The deletion of a customer that still owns devices, device groups, active runbooks, active automation templates or roles (`customer-in-use`). Refer to [Delete a customer](#delete-a-customer).
- The deletion of the first customer (`customer-default-protected`).
- A new customer with the ID of a deleted customer (`customer-id-removed`).

A change of the customer ID is not possible for the first customer. It is also not possible while a device, a group, a catalog entry, a role or an audit row has the customer. The API reports `customer-mismatch` with status 409 and this message: `The device and the device group belong to different customers. Select a group of the same customer.`

## Multiple customers

A new portal works like a tool for one organization. It has only the default customer, and the setting **Multiple customers** is off. While it is off, the console shows no customer list, customer folders, customer view, customer column or customer fields. It also shows no hints and locks for actions across customers. The page **Settings → Customers** shows only the card **Organization** with the switch **Multiple customers**.

Only a global Owner changes the setting, in **Settings → Customers**. Each change asks for an MFA confirmation first. The change, the new revision, the use of the confirmation and one entry in the portal log are one batch. The portal log stores the audit actions `customers.multiple.enable` and `customers.multiple.disable` with an empty target. After you turn on the setting, the page shows the customer table and the action **Create customer**. The console shows the other customer functions when the second customer exists.

You can turn off the setting only while no customer other than the default customer exists. Deactivated customers also count. To turn it off, delete the other customers first (refer to [Delete a customer](#delete-a-customer)). While other customers exist, the switch shows the number of these customers as the reason.

Existing installations keep their behavior. If a customer other than the default customer exists when the migration runs, the setting starts as on. Otherwise it starts as off.

The action is `POST /api/customers` with `{action:'set-multiple-customers', enabled, revision, managementToken}`. `GET /api/customers` and each answer of a `POST` contain `multipleCustomers: {enabled, otherCustomers, revision}`. `otherCustomers` is the number of customers other than the default customer. The API reports these errors:

- 403 `apiError.customer.ownerOnly` for an account that is not a global Owner.
- 400 `apiError.request.invalid` when `enabled` is not a boolean.
- 409 `apiError.customer.multipleCustomersChanged` when `revision` is not the stored revision.
- 409 `MULTIPLE_CUSTOMERS_IN_USE` (`Multiple customers stays on while other customers exist. Delete the other customers, and turn it off again.`) for a switch-off while other customers exist.
- 409 `MULTIPLE_CUSTOMERS_OFF` (`Multiple customers is turned off. Turn it on under Settings → Customers, then create the customer.`) for the action `create` while the setting is off.

If you send the value that is stored, the portal writes nothing and returns the state. While the setting is off, the other write actions for the default customer continue to operate. Examples are `update`, `set-technicians` and `create-installer`.

### Storage of the setting

The table `customer_settings` has one row (`id = 1`). It stores `multiple_customers`, `revision`, `updated_at` and `updated_by`. The functions `multipleCustomersSetting` and `setMultipleCustomers` in `lib/server/identity/multiple-customers.ts` hold all SQL of the setting. Triggers keep the rule "off means only the default customer", also for direct SQL access:

- An insert into `customers` with an ID other than the default customer fails with `multiple-customers-off` while the setting is off. The trigger reads the setting row with `FOR SHARE`.
- A change of the setting from on to off fails with `multiple-customers-in-use` while another customer exists.
- A delete of the setting row fails with `customer-settings-protected`.

The application checks the two first rules before the commit, and the triggers give the same error codes in a race. Thus a concurrent switch-off and customer create cannot both commit. The customer separation (`customerSeparationSql`) does not change. While the setting is off, it is always false.

## Manage customers

The page **Settings → Customers** and `GET /api/customers` are only for global Owners (`'*'`), because the contact data can be personal data. They show all customers with these data:

- The contact.
- The number of devices (without revoked devices) and the number of groups.
- The assigned users and user groups.
- The audit retention and the maintenance window.

`GET` also returns `installers` (without key and hash) and `deviceGroups` (`{id, name, customerId}`) for the installers. Refer to [Installer for each customer](#installer-for-each-customer).

While the setting **Multiple customers** is on, the page shows the customers in a table below the card **Organization**. The header has the action **Create customer**. While the portal has only the default customer, the side panel of **Create customer** shows a warning above the fields: `After you create this customer, each account sees only the customers assigned to it. Owners still see all customers.` Each row has a menu **Actions for {name}** with these entries:

- **Manage customer…** opens a side panel with the name, the contact, the audit retention and the maintenance window. A click on the row opens the same panel.
- **Technician access…** opens a side panel with one list of users and user groups. A search field filters both.
- **Installers** opens **Devices** › **Add device** › **Several devices** with this customer.
- **Deactivate customer…** asks for a confirmation first. For a deactivated customer, the entry is **Activate customer**.
- **Delete customer…** is the last entry. It opens a side panel in which you type the customer name. Refer to [Delete a customer](#delete-a-customer).

An entry that you cannot use stays in the menu and shows the reason. Examples are the first customer and a change that is in progress. The side panels check the input before they send it.

**Technician access…** asks for an MFA confirmation before it saves. An edit asks for it only when the audit retention of the customer gets shorter. If you cancel it, the panel keeps your input. To create, activate or deactivate a customer, you need no new MFA confirmation.

The functions `createCustomer`, `updateCustomer`, `setCustomerStatus` and `setCustomerTechnicians` in `lib/server/identity/customer-admin.ts` create, edit, disable and enable a customer. They need a global Owner and the live MFA login session. `setCustomerTechnicians` also needs an MFA confirmation (`managementToken`). `updateCustomer` needs it only when the audit retention of the customer gets shorter than the retention that applied before. That retention is the value of the customer, else the audit retention of the instance. Refer to [portal-sessions.md](portal-sessions.md#which-actions-ask-for-mfa-again).

Each change is one batch. The batch contains the change, an entry in the portal log and, with a confirmation, the use of the confirmation. The portal log stores the audit actions `Kunde angelegt`, `Kunde geändert` (with `old → new` for a new name), `Kunde deaktiviert` and `Kunde aktiviert`. A shared guard binds the batch to the Owner permission, the confirmation or the live sessions, and the customer `revision` from the read. If one of these values changes in the meantime, the portal writes nothing. The result is 409 for a changed customer, 404 for a missing customer, and a new MFA prompt or a new sign-in in other cases.

An edit without a confirmation that used the audit retention of the instance also fails with 409 when that value changes before the commit.

Each change increases `revision` by 1. If you set the status that the customer already has, the portal writes nothing.

### Input rules

The portal trims all texts. Control characters (U+0000–U+001F, U+007F) are not permitted. A violation gives 400 with a message about the field.

| Field | Rule |
|---|---|
| `name` | 1–80 characters, unique without regard to upper and lower case (otherwise 409) |
| `contactName` | 0–120 characters |
| `contactEmail` | empty, or a maximum of 254 characters in the form `name@domain.tld` |
| `contactPhone` | empty, or 3–40 characters from `0-9 + ( ) / - .` and spaces, with a minimum of 3 digits |
| `auditRetentionDays` | `null` (default of the instance) or an integer from 1 to 3650 |
| `maintenanceWindow` | `null` or an object with exactly `days`, `start`, `durationMinutes` and `timeZone` |

The maintenance window repeats each week. `days` are ISO weekdays from 1 (Monday) to 7 (Sunday), with a minimum of one day and no duplicates. `start` is `HH:MM` in steps of 15 minutes. `durationMinutes` is 15–720 in steps of 15, and the window can continue past midnight. `timeZone` is an IANA time zone with 1–64 characters that the runtime knows. The portal stores its canonical spelling.

### Storage

Migration `0031_customer_settings.sql` adds these columns to `customers`:

- `audit_retention_days`: NULL for the default, otherwise 1–3650
- `maintenance_days`: bit mask 1–127, bit 0 = Monday … bit 6 = Sunday
- `maintenance_start`: minutes from midnight, 0–1425, a multiple of 15
- `maintenance_duration`: minutes, 15–720, a multiple of 15
- `maintenance_time_zone`: 1–64 characters
- `revision`: counter for the optimistic lock, starts at 0

The four `maintenance_*` columns are either all NULL (no maintenance window) or all set. A trigger rejects other values with `customer-settings-invalid`. `listCustomers` and `customerById` return the fields as `auditRetentionDays`, `maintenanceWindow`, `revision`, `deviceCount` and `groupCount`. They also return `runbookCount` and `templateCount` (entries with `archived=0`) and `roleCount`. `lib/server/identity/customers.ts` never writes.

- The daily maintenance of the portal applies the audit retention of a customer to the device logs and customer entries of this customer. This also applies when the customer is disabled. The customer value has priority over the instance retention. Without its own value, the customer uses the instance retention of the page **Settings → Data retention**. Without a setting, it is 30 days. Refer to [Audit for each customer](#audit-for-each-customer).
- At the moment, the maintenance window is only information for the technicians. It does not control jobs, updates or restarts yet.

### Disabled customers

To stop a customer and keep its data, disable it (`status='disabled'`). To remove a customer that holds no data, delete it ([Delete a customer](#delete-a-customer)).

A disabled customer keeps its devices, groups, memberships and data, and everything continues to operate. But it accepts no new devices and groups. A trigger rejects an `INSERT` into `servers` or `device_groups` with a disabled customer. It also rejects an `UPDATE` that changes `customer_id` to this customer (`customer-disabled`).

The API reports this with 409 and this message: `The customer is deactivated and takes no new devices or groups. Activate it under Settings → Customers.` After you enable the customer, it accepts new devices and groups again.

You can rename and edit the first customer, but you cannot disable it. The reason is that registrations without a group in a portal with one customer and root groups go to this customer. The API reports 409, and a trigger also rejects `status='disabled'` with `customer-default-protected`.

### Delete a customer

Only a global Owner can delete a customer. Use **Delete customer…** in the row menu, or **Delete customer** at the end of the side panel **Manage customer…**. A side panel opens. It tells you what goes with the customer and what stays. Type the customer name, then select **Delete customer**. The portal asks for an MFA confirmation before it sends the request.

You cannot delete the first customer. A customer that still has data stays too. The menu entry shows the reason with the counts, for example `Kunde B still has 3 devices and 1 device group. Remove or delete them first.` These counts keep a customer:

- Devices with `revoked=0`. Removed devices stay as tombstones and do not count.
- Device groups.
- Runbooks and automation templates with `archived=0`. Deleted entries stay archived and do not count.
- Roles of the customer.

The delete removes the configuration that only this customer has:

- Its installers. A registration with the key of such an installer then fails as for an unknown installer.
- Its technician access (`customer_assignments`).
- Its AI assistant key.
- Its customer notification rules, customer alert rules and ESU dates.
- Its contact data, audit retention and maintenance window, which are columns of `customers`.

The history stays with the customer ID: the audit rows, the notification events, the removed devices and the archived runbooks and templates. The table `removed_customers` keeps the ID, the last name and the time of the delete (`removed_at`). Thus the portal log still names the customer, for example `Kunde B (deleted)`. A deleted ID never names a new customer.

The delete, the use of the MFA confirmation and one entry in the portal log are one batch. The portal log stores the audit action `customer.delete` with the customer name as target and without a customer. Thus the entry follows the instance retention.

**End of the customer boundary:** When you delete the last customer other than the default customer, the [customer boundary](#rule) ends. Then every account sees the devices of the default customer that its roles allow. The side panel shows a warning about this. This change gives access to accounts. Thus the same batch voids the open invitation and password links of these accounts and ends their MFA grants. Each such account gets one entry `Konto-Links wegen Kundenzuweisung verfallen` in the portal log.

These accounts are the active accounts that are not global Owners and have no assignment to the default customer. An assignment through an enabled user group also counts. A delete that keeps another customer changes no account. After the last delete, you can turn off the setting **Multiple customers** again.

The action is `POST /api/customers` with `{action:'delete', id, revision, managementToken}`. The answer is the state of the page, as for the other actions. The API reports these errors, in this order:

- 403 `apiError.customer.ownerOnly` for an account that is not a global Owner.
- 403 `MFA_STEP_UP_REQUIRED` without a valid MFA confirmation. Nothing changes.
- 404 `apiError.customer.gone` for an unknown ID, and 409 `apiError.customer.concurrent` for a changed `revision`.
- 409 `CUSTOMER_DEFAULT_PROTECTED` (`apiError.customer.defaultDeleteProtected`) for the first customer.
- 409 `CUSTOMER_IN_USE` (`apiError.customer.inUse`) while the customer still has data.

The function is `deleteCustomer` in `lib/server/identity/customer-admin.ts`. Triggers on `customers` hold the rules also for direct SQL access:

- `customers_delete_guard` raises `customer-default-protected` for the first customer. It raises `customer-in-use` while a device with `revoked=0` or a device group has the customer.
- `customers_delete_catalog_guard` raises `customer-in-use` while a runbook or template with `archived=0`, or a role, has the customer.
- `customers_delete_tombstone` writes the row of `removed_customers`. That table rejects changes and deletes (`removed-customer-immutable`).
- `customers_insert_removed_id` and `customers_update_id_removed` reject a removed ID (`customer-id-removed`).
- The existing triggers and the foreign key of `assistant_keys` remove the configuration.

If somebody adds data to the customer between the check and the commit, the trigger refuses the delete with the same 409. A delete and a registration, a root group, a runbook or a role for the same customer cannot both commit.

### Rule for the customer code

The customer code always sets `customer_id` on devices and groups explicitly. It never uses the column default, which points to the first customer. The customer management does not move groups to a different customer, and it moves devices only through [Move devices to another customer](#move-devices-to-another-customer). A new customer gets groups only through the field **Customer** when somebody creates a root group. It gets devices through a registration with this customer or into one of its groups, and through its installers. Refer to [Customer boundary](#customer-boundary).

### Registration in the console

A registration in the console (`POST /api/console` with `action:'enroll'`) takes an optional `customerId` next to `groupId`. The device gets `customerId`, else the customer of the group. An ID that is not a GUID gives 400 `The customer is not valid.`, and an unknown customer gives 404 `CUSTOMER_MISSING`.

When the portal has more than one customer, a registration needs a customer or a group of that customer. Without both, the API gives 400 `ENROLL_CUSTOMER_REQUIRED`. A customer and a group of a different customer give 409 `CUSTOMER_MISMATCH`. A disabled customer, directly or through its group, gives 409 `CUSTOMER_DISABLED`.

The route checks these rules before it reads the MFA confirmation. The insert itself also contains the rule (`NOT (customerSeparationSql)` without a chosen customer). Thus a second customer that somebody creates between the check and the commit creates no device, and the MFA confirmation stays unused.

On the page **Add device** (**Devices** › **Add device**, tab **One device**), the field **Customer** then comes before the field **Device group**, and it is necessary. The group list shows only the groups of this customer. A link with a customer or a group (`#devices/add/customer/<id>`, `#devices/add/group/<id>`) selects them in the form. In a portal with one customer, the form has no customer field, and registrations without a group still go to the first customer. Installers are not affected, because each installer has its customer.

## Move devices to another customer

You can move enrolled devices from one customer to another customer. The agent keeps its token, its key and its mode. Thus the device stays online, and you do not install the agent again.

### Who can move devices

The move needs the permissions **Change Windows configuration** (`manage`) and **Manage device groups and permissions** (`groups.manage`) in two places:

- On each device, through a device, group or global assignment inside your customer boundary.
- On the target. With a target group, you need both permissions on that group. Without a group (**Ungrouped**), you need both permissions in a global assignment, and you must see the target customer.

An Owner can always move devices. You do not have to be an Owner. When the selection has devices of two or more customers, the move also needs the permission **Start actions for several customers** ([Actions for multiple customers](#actions-for-multiple-customers)).

### Procedure

1. Select **Move to another customer…** in the row menu, in the selection bar or in **More actions** on the device page.
2. Select the target customer.
3. Select the target group, or **Ungrouped**.
4. Read what stays and what ends.
5. Select **Move to** with the customer name.
6. Confirm your identity with MFA.

The entry shows only when the portal has more than one customer and you see another customer. It does not show for a removed device.

### What ends

The same batch ends everything that belongs to the old customer:

- The memberships in the groups of the old customer. With them end the inherited permissions, tags, alert rules, notification rules and automation assignments of the group and the customer.
- The role assignments on the device itself (`role_assignments` with `scope_type='device'`).
- The automation assignments on the device itself (`automation_scope_assignments` with `scope_type='device'`).
- The Desired State assignments. They get `enabled=0` and `interval_seconds=0`.
- Waiting jobs (`state='pending'`). They become `cancelled` with the result `serverMessage.device.movedCustomer`.
- Open terminal and Remote Desktop sessions, with their frames and receipts.
- File transfers that are not complete. After the commit, the portal deletes their stored data.
- AD sign-ins on the device (`plugin_ad_sessions`).
- The device in runbook schedules, with its sealed secrets. A schedule without targets is disabled.
- Waiting runbook entries (`queued`). A run whose last open entry ends gets its final state.

The rules of the target group and the target customer then apply.

### What stays

- Running jobs and all finished jobs with their outputs. A running job finishes on the device.
- Metrics, inventory, plugin data and alarms. An open alarm stays open.
- The tags, alert rule overrides and OS support dates of the device itself.
- Drift policies, baselines and reports.
- The earlier audit rows. They keep their old customer and its retention.
- Pinned devices. A technician who loses the access does not see the pin, but the pin stays stored.
- The agent channel and the token nonces.

The technicians of the new customer can see the earlier history of the device.

### Audit of a move

The move writes two rows with the audit action `device.customer.move` for each device:

- A portal row in the old customer, without a device. The target is `{name} / {id} → {target customer}`.
- A device row in the new customer, after the customer change. The target is `{name} / {id} ← {old customer}`.

Thus the audit of each customer holds one row for each device, with the retention of that customer. A refused move writes no row.

### API and errors

The action is `POST /api/console` with `{action:'move-customer', ids, customerId, groupId, confirm:true, managementToken}`. `ids` holds 1 to 100 device IDs, and duplicates are merged. `groupId` is a group ID or `null` for **Ungrouped**. The answer is `{ok:true, ids, customerId, groupId}`.

The route checks the input before MFA and before it reads the MFA confirmation:

- 400 `apiError.devices.selectRange` for invalid or too many device IDs.
- 400 `apiError.devices.moveConfirm` without `confirm:true`.
- 400 `apiError.customer.invalid` for a customer ID that is not a GUID.
- 400 `apiError.devices.moveGroupInvalid` for a group ID that is not a GUID or `null`.

Then the route asks for the MFA confirmation (403 `MFA_STEP_UP_REQUIRED`). These answers change nothing:

- 404 `apiError.devices.moveNotFound` for an unknown, removed or invisible device.
- 404 `apiError.customer.unavailable` for an unknown customer or a customer that you do not see. 409 `apiError.customer.disabled` for a disabled customer.
- 404 `apiError.group.notFound` for an unknown group. 400 `apiError.devices.moveGroupInvalid` for a group of another customer.
- 400 `apiError.devices.moveSameCustomer` for a device that already belongs to the target customer.
- 403 `apiError.devices.moveForbidden` without the permissions. 403 `apiError.crossCustomer.right` for devices of several customers without that permission.
- 409 `apiError.devices.moveChanged` when the devices, the target or your permissions change before the commit. 403 `apiError.mfa.proofExpired` when the MFA confirmation expires.

### Storage of a move

The function is `moveDevicesToCustomer` in `lib/server/devices/device-customer-move.ts`. The move, the audit rows and the use of the MFA confirmation are one batch, and its first statement is the admission. It checks live the MFA confirmation, the session, the permissions on the devices and on the target, the customer boundary and the cross-customer permission. It also checks that no device, target customer or target group changed since the read. Only then it sets a receipt for the transaction (`set_config`). Every later statement runs only with this receipt.

The memberships and the device assignments go before the customer change. Thus the triggers `servers_update_customer` and `servers_update_customer_catalog` accept the change. A disabled target customer gives 409 `CUSTOMER_DISABLED` from `servers_update_customer_disabled`.

## Customer boundary

When the portal has more than one customer, technicians see only the customers that an Owner assigns to them. Below this boundary, the existing RBAC applies without changes. This includes global roles and roles on device groups and devices (refer to [`local-identity-rbac.md`](local-identity-rbac.md)). Thus, for a technician, a global role applies only in the customers of this technician.

### Rule

An account P sees the customer K only if one of these conditions applies:

1. The portal has only the default customer: no row in `customers` has a different ID.
2. P is an active account and a global Owner. P has a role with `*` in the global scope, directly or through an enabled user group. Owners see all customers, also without an assignment.
3. P is an active account, and an assignment gives K to P. The assignment is direct or through an enabled user group with P as a member.

The status of the customer has no effect: technicians continue to see a disabled customer. `customerAccessGuard(customer, principal)` in `lib/server/identity/access.ts` evaluates the rule live in SQL. It does this for the read, for the pre-check and in the write commit. If somebody removes an assignment between the check and the commit, the portal writes nothing.

The boundary starts when an Owner creates the second customer. This is possible only while the setting **Multiple customers** is on ([Multiple customers](#multiple-customers)). It ends when an Owner deletes the last customer other than the default customer ([Delete a customer](#delete-a-customer)). One SQL fragment, `customerSeparationSql` in `runtime/customer-separation.mjs`, holds this condition for all places that use it. Note this before you create the second customer. After that, technicians without an assignment see no devices, groups, jobs and transfers until an Owner assigns them to a customer.

From the same moment, the device overview can show the column **Customer** before **Group** and a customer line on the tiles. They show only when the devices of the view belong to two or more customers. Thus the customer view and the group view never show them, because their devices belong to one customer. **All devices** shows them only when you see devices of two or more customers.

The column **Group** and the group line on the tiles show only when a device of the view is in a group. Without a grouped device, every row would show **Ungrouped**, so the column, its entry in the column menu and the group line do not show. Your column choice stays, and the column comes back when a device of the view joins a group. While the column does not show, a sort by **Group** sorts by the device name. The CSV export always has the column **Group**.

The CSV export always has the column **Customer**. The search also finds devices by the customer name. For this, `GET /api/console` returns `multipleCustomers` and, for each device, `customerName` and `customerDisabled`. The name comes only from devices that the viewer already sees. A disabled customer shows the note **Deactivated**.

The boundary is above all scopes. A role assignment directly on a device or a device group of a different customer also applies only when the technician sees this customer. Outside the boundary, the pre-checks reply with 404 and the existing messages (`The device was not found.`, `The group was not found. Reload the page.`). Thus the target seems not to exist. If the visibility stops only in the commit, the existing 403 and 409 messages of the path apply.

### Assign access

Owners assign users and user groups on the page **Settings → Customers** with the menu entry **Technician access…**. The column **Technician access** shows the number of assignments for each customer. The function is `setCustomerTechnicians` in `lib/server/identity/customer-admin.ts`. The request is `POST /api/customers` with `{action:'set-technicians', id, revision, userIds, groupIds, managementToken}`.

A request that only removes runs in the core instead. Such a request adds nothing and removes a minimum of one user or group. The function is `removeCustomerTechnicians` in `lib/server/identity/customer-technicians.ts`, and it never adds an assignment. These rules apply to the two paths:

- Only global Owners can do it, with an MFA confirmation and the correct `revision`.
- `userIds` and `groupIds` are lists of existing users and user groups, with a maximum of 1000 entries each. Otherwise the result is 400 `Select existing users and user groups, at most 1000 of each.`
- The portal writes one batch. The batch contains the changed rows, `revision+1` of the customer, the use of the confirmation and an entry in the portal log. The audit action is `Techniker geändert`, with the target `{name} (+{added} / −{removed})`. The same state writes nothing.
- Removed users and the members of removed user groups lose their sessions, MFA proofs and waiting jobs immediately. This is the same as for the removal of a role assignment.

The open invitation and password links of an account become invalid in the same commit when the account gets a customer assignment. This occurs in these cases:

- The account or one of its user groups gets a customer.
- The account becomes a member of a user group with a customer assignment, or such a user group is enabled.

The portal records the audit action `Konto-Links wegen Kundenzuweisung verfallen` for each account. After that, somebody must issue a new link.

The path that only removes reads the assignments again itself. If the request adds something, this path writes nothing and answers 409.

If the request would then add something after all, the core path replies with 409 `The customer changed in the meantime. …` and writes nothing. It never adds anything. You can assign the default customer and disabled customers like all other customers.

A user group that has an assignment to a customer gives this customer to each member. Thus only global Owners can add members or enable a disabled group. The message is `Only an Owner can activate a user group that is assigned to a customer or add members to it.` The portal checks this live in the commit. With `portal.userGroups.manage`, you can still disable the group, because this only removes access.

When the portal has more than one customer, to remove members, the actor must also see each customer of the group. Global Owners see all customers. If not, the result is 403 `This user group is assigned to a customer that you cannot see. Only an Owner or someone who sees all customers of the group can remove members.` The portal checks this before and in the commit.

Only an Owner can create, change, delete and assign roles with `*` or with the permission **Start actions for several customers**. This applies from the first start and does not depend on the number of customers. Refer to [Owner rule for privileged roles](#owner-rule-for-privileged-roles). Thus a user with only `portal.roleAssignments.manage` cannot assign the Owner role to their own account. `portal.roleAssignments.manage` is thus not equal to an Owner, because it assigns only customer roles and library roles without these permissions.

The same applies to accounts. For an account with such a role, only an Owner can send an invitation link or a password link. Only an Owner can edit, lock or unlock this account. The message is `Only an Owner manages accounts with an Owner role or the permission “Start actions for several customers”.`

This rule applies when the portal has more than one customer. Then only an Owner or a user who sees all customers of an account with a customer assignment can manage it. The message is `This account is assigned to a customer that you cannot see. Only an Owner or someone who sees all customers of the account can manage it.`

### Where the boundary applies

| Path | Location |
|---|---|
| `devicePermissionGuard`, `anyDevicePermissionGuard`, `groupPermissionGuard` | Boundary on `servers.customer_id` or `device_groups.customer_id` of the target, for each scope |
| `permissionsFor`, `effectivePermissions`, `groupPermissions` | `[]` outside the boundary. `effectivePermissions` returns the same result as `permissionsFor` for many devices in one query |
| `allowedDeviceIds`, `allowedGroupIds` | Through the guards |
| `requireDevice`, `requireGroup` | 404 `The device was not found.` or `The group was not found. Reload the page.` |
| `GET /api/console`: `servers`, `jobs` (also runbook steps), `deviceAudit`, `deviceGroups`, `permissionDevices` | `allowedDeviceIds`, `deviceAuditGuard`, `deviceGroupCatalog`, `devicePermissionTargets` |
| `cancel-job`, `job` in `/api/console` | `requireDevice` (404), in the commit `devicePermissionGuard` |
| Agent claim (`/api/agent/channel`) | `requireDevice` and `devicePermissionGuard`. The portal cancels a waiting job without visibility |
| `deviceAuditGuard` | `devicePermissionGuard` for `view` and `security.events` one time for each device of the query, not for each audit row, still live in the query |
| `POST /api/transfers` `create` | `requireDevice` (404) |
| Transfer status, blocks, `finish` | `requireDevice` (404) and `transferAuthorizationGuard` |
| `listRunbooks` | `allowedDeviceIds` for runs and schedules, `catalogVisibleGuard` for runbooks and versions |
| `cancel`, `cancel-schedule` in `/api/runbooks`, `remove-assignment`, `run` in `/api/automation` | 404 as for an unknown ID, if no target is visible |
| `create-group` in `/api/access` | Visibility of the target customer before the commit (404) and `customerAccessGuard` in the commit |
| `update-group`, `set-grant`, `delete-grant` | `requireGroup` (404), in the commit `groupPermissionGuard` |
| `delete-group` (`deleteDeviceGroup`) | 404 `The device group was not found. Reload the page.`, in the commit `customerAccessGuard` |
| `set-device-memberships`, `update-device-memberships`, `assign-device` | Groups through `requireGroup` (404, also the previous group of a moved device), devices in the commit through `featureTargetsGuard` (403) |
| `add-assignment` with the scope `devicegroup` or `device` | `customerAccessGuard` in the commit (403) |
| `delete-assignment` in `/api/rbac` | 404 as for an unknown ID, if the assignment scope is a device or group of a customer that the viewer does not see. In the commit `assignmentScopeGuard` (409 if the visibility stops only in the commit) |
| `deviceGroupCatalog`, `devicePermissionTargets`, `rbacData` | Lists only with visible customers, also for `portal.roleAssignments.manage`. `rbacData` also removes the role assignments on devices and groups of customers that the viewer does not see. Global assignments stay in the list. |
| `customers` in `GET /api/access` and `GET /api/console` | `visibleCustomers`: active customers that the viewer sees |
| `add-member` and the activation of a user group with a customer assignment | Only global Owners, checked in the commit (403) |
| `remove-member` in `/api/rbac` | The actor must see each customer of the user group, before and in the commit (403) |
| Account actions `reset-link`, `update-user`, `disable-user` | `targetDominanceGuard`, before and in the commit (403) |
| Drift policy for a group (`applyGroupDriftPolicy`) | 404 `The device group was not found. Reload the page.` outside the boundary |
| `move-customer` in `/api/console` | 404 for a device or a group outside the boundary, and 404 `CUSTOMER_MISSING` for a target customer outside the boundary. In the commit `featureTargetsGuard` for the devices and `customerAccessGuard` for the target customer. Refer to [Move devices to another customer](#move-devices-to-another-customer) |
| `enroll` in `/api/console` | Only Owners. With more than one customer, a customer or a group is necessary (400 `ENROLL_CUSTOMER_REQUIRED`). A customer and a group of different customers give 409, and a disabled customer gives 409. Refer to [Registration in the console](#registration-in-the-console) |
| `set-customer-key`, `remove-customer-key`, `test-customer-key` in `/api/assistant/settings` | Only global Owners (403). 404 `The customer does not exist or is not assigned to you. Reload the page.` outside the boundary. In the commit `customerAccessGuard`. `set-customer-key` also needs a second customer in the commit (409) |

Global permissions without a target (`globalPermissionGuard`, `hasGlobalPermission`, `globalPermissions`) and the Owner check (`can`/`canSql` from `lib/server/identity/policy/can.ts`) stay unchanged. Group subtrees always belong to one customer. Thus, for group actions, the check of the group customer is sufficient. The portal does not check the customers of the recipients of a grant (`set-grant`, `add-assignment`). Their permissions apply only in their customers anyway. The portal log stays Owner-only.

Runbooks, templates and roles belong to the MSP library or to one customer. Refer to [Catalogs: MSP library and customer entries](#catalogs-msp-library-and-customer-entries). Desired State configurations stay instance-wide.

### Root groups with a customer

When you create a group without a parent group and see more than one customer, select its customer in the field **Customer**. The field shows the default customer first if it is in the list. Otherwise it shows the first entry. For this, `POST /api/access` `create-group` accepts an optional `customerId`:

- Missing or `null`: root group with the default customer, as before.
- Not a GUID: 400 `The customer is not valid.`
- Unknown or not visible: 404 `The customer does not exist or is not assigned to you. Reload the page.`
- Disabled: 409 with the message for disabled customers.
- With `parentId` and a customer that is different from the parent group: 400 `A subgroup always belongs to the customer of its parent group.`

As before, a subgroup inherits the customer of its parent group. A device goes to a different customer when it registers into one of the groups of this customer or through an installer of this customer. Refer to [Installer for each customer](#installer-for-each-customer). With more than one customer, a root group without `customerId` gives 404 for a technician who does not see the default customer.

### Storage of the assignments

Migration `0032_customer_assignments.sql` creates the table `customer_assignments`. It has the columns `customer_id`, `principal_type` (`user` or `group`), `principal_id`, `created_at` and `created_by`. The primary key is `(customer_id, principal_type, principal_id)`, and an index is on `(principal_type, principal_id)`. Triggers reject an unknown customer (`customer-missing`) and an unknown user or user group (`customer-assignment-subject-missing`). When somebody deletes a customer, a user or a user group, a trigger deletes its assignments. `lib/server/identity/customers.ts` reads them with `visibleCustomers(viewer)` and `listCustomerTechnicians()`.

The same migration also closes a gap in the group memberships. A trigger rejects a new or changed group membership if its device or group does not exist (`device-group-member-missing`). The group paths of the access management report this with 409 and this message: `The device or the device group no longer exists. Reload the page.` Existing memberships stay unchanged.

## AI assistant key for each customer

When the portal has more than one customer, an owner can set one API key of the AI assistant for each customer. Questions about the devices of this customer use this key first. Then the costs go to the provider account of the customer. Refer to [ai-assistant.md](ai-assistant.md#set-a-customer-key).

- Only global Owners read, set, test and remove customer keys, on the page **Settings** › **AI assistant**. Customer technicians cannot set them.
- The portal checks the customer boundary before and in the commit.
- A deactivated customer can get, keep and lose a key.
- Each change writes one portal audit entry with the customer in `customer_id`. Thus, the entry also shows in the audit of the customer.
- A customer key goes with its customer.

## Logo for each customer

While **Multiple customers** is on, an Owner can upload a logo for each customer other than the default customer, on the page **Settings** › **Branding**. The top bar shows it while the console shows that customer, and for the accounts that see only that customer. Refer to [branding.md](branding.md).

## Installer for each customer

An installer is a PowerShell script with a secret key that you can use many times. Each Windows device that runs it as administrator registers itself with the customer of the installer. If the installer has a device group, the device also goes into this group. A later assignment is not necessary.

### Procedure

A global Owner creates the installer, and the script registers each device:

1. Open **Devices** › **Add device** › **Several devices**. For one customer, select **Installers** in the customer folder menu or in **More actions** of the customer view. The link **Installers** in the row of the customer on **Settings** › **Customers** opens the same tab. With more than one customer, select the customer in the field **Customer**. The table lists the installers of the customer with group, mode, expiry date, number of devices and status. The status values are `Active`, `Expired`, `Revoked`, `Used up` and `Group deleted`.
2. Select **Create installer**. Enter a name. Select a device group or **Ungrouped**. Select the agent mode (**Read-only** or **Management**). Select the term (1, 7, 30, 90 or 365 days). Optionally, set a maximum number of devices (1–10000).
3. Select **Create installer** and confirm with MFA. The browser downloads `Install-ServerDesk-{customer}-{installer}.ps1`. You can download this file only one time.
4. On the device, start the file in a PowerShell as administrator. The script then does these steps:
   - It checks the administrator permissions and 64 bit.
   - It stops if the device is already registered (`%ProgramData%\ServerDesk\config.bin`).
   - With the local Caddy CA, it checks the portal certificate. It shows the fingerprint and asks before it imports the root certificate. For unattended installations, start it with `-TrustPortalCertificate`. Refer to [HTTPS with the local Caddy CA](self-hosting.md#https-with-the-local-caddy-ca).
   - It downloads the public signed release (`/Agent-v3-release.json`) and verifies the signature against the embedded publisher.
   - It downloads the EXE with its signed checksum.
   - Only then, it sends the key and the computer name to `POST /api/agent/enroll`. The computer name becomes the device name. When you rename the computer later, the device name follows it (refer to [Device name](device-workspace.md#device-name)).
   - With the response, it installs the agent through `ServerDesk.Agent.exe --install`.
   - Thus an error with the release does not use a device or a place in the maximum number.
5. To stop an installer immediately, open the row menu of the installer and select **Revoke installer…**. Confirm the action and the MFA prompt. Devices that are already registered stay with the customer and continue to operate.

You cannot download an installer again, and you cannot edit or extend it. Instead, create a new installer and revoke the old one.

A person with the file can register devices with this customer until the installer expires. The key can become visible outside the portal, for example in a forwarded email or on a file share. It can also appear in the PowerShell log (Script Block Logging, event 4104) if this log is enabled on the device. Thus set a maximum number of devices that matches the rollout. Select a short term. Revoke the installer when the rollout is complete.

Without a maximum number, a leaked key can create any number of devices until the expiry.

### Security properties

- **Customer only from the installer row.** The registration creates the device with `INSERT … SELECT … customer_id FROM customer_installers`. The customer and the group come from the stored row, never from the request and never from the column default. The request can contain exactly `installerKey` and `name`. Each other key (for example `customerId`, `groupId`, `mode`) gives 400. A trigger makes the customer, the group, the key hash, the mode, the term and the maximum number of an installer immutable (`customer-installer-immutable`).

  When somebody creates an installer, its group must belong to the customer (`customer-installer-group-mismatch`). If the group is missing later or belongs to a different customer now, the installer registers no device. It does not change to no group or to a different customer. The membership triggers from 0029 and 0032 also apply. No code changes `servers.customer_id` after the creation.
- **Key only as a hash.** The key has 256 bits (64 hex characters). The portal stores only `SHA-256("ServerDesk customer installer v1\n" + key)`. The prefix separates it from device tokens, so a device token never counts as an installer key. The key and the hash are in no API response except the script file. They are also in no audit entry and in no log line.
- **One-time download.** The file comes only as the response to the creation, with `Cache-Control: no-store`. If you lose it, create a new installer.
- **Term and maximum number.** Each installer expires after a maximum of 365 days. With a maximum number, there are never more devices, also with simultaneous registrations. The count and the creation run in one transaction. A CHECK on `enrollments <= max_devices` also makes sure of this.
- **Revoke at any time.** To revoke only removes access. A revocation is permanent (`customer-installer-revoked`).
- **No replacement of an existing registration.** The script checks `config.bin` before it sends a request. It writes the key nowhere on the disk. The native installation gets only the known fields `{id, token, origin, jobSigningKey, mode}`.
- **Origin binding without redirects.** The script sends the key only in the body to the embedded `https:` origin, without redirects. It accepts only a response with exactly this `origin`.
- **Rate limit for each process.** The limit is 60 registrations per minute for each client (`X-ServerDesk-Client-IP` from a trusted source, otherwise one shared pool). The limit for the whole process is 600 per minute. It protects against load, not against guessing, because nobody can guess 256-bit keys. After a restart, the count starts again, and multiple instances count separately.

  Each request counts, also a request without a valid key. A person who sends many requests with wrong keys can fill the shared window of 600 per minute. Then real registrations get 429 until the next window. In this case, the script stops, and you can start it again.

### Installer for the first customer

An Owner can also create an installer for the default customer while it is the only customer. The registration through an existing valid installer always works.

### Endpoint `POST /api/agent/enroll`

The endpoint has no session and no origin check. The body has a maximum of 4096 bytes:

```json
{"installerKey": "<64 Hex-Zeichen>", "name": "<Computername>"}
```

The endpoint trims `name`, and `name` must match `^[a-zA-Z0-9._ -]{1,64}$`. Success is 200 with `Cache-Control: no-store`:

```json
{"id": "…", "token": "…", "origin": "https://…",
 "jobSigningKey": "…", "mode": "ReadOnly", "customerName": "…"}
```

One transaction creates these items:

- The device.
- The membership of the device, if the installer has a group.
- The counter `enrollments` with `last_used_at`.
- A row in the device audit: the audit action `Agent über Installer registriert` with the actor `Installer „{name}“`.

The token in the response is a registration with a time limit. If the agent does not report for the first time within 24 hours after this call, the registration expires. After that, the portal rejects the token with 403 `DEVICE_REGISTRATION_EXPIRED`, and the device list shows `Registration expired`. A new run of the installer registers a new device. After the first Heartbeat, the agent changes to rotating tokens that are bound to its device key. Then the time limit has no effect on the agent.

| Status | Code | Meaning |
|---|---|---|
| 400 | – | The body is not an object with exactly `installerKey` and `name`, has a wrong type, is too large or has an invalid device name |
| 403 | `INSTALLER_INVALID` | No installer with this key, without more information |
| 403 | `INSTALLER_REVOKED` | Revoked |
| 403 | `INSTALLER_EXPIRED` | Expired |
| 409 | `INSTALLER_EXHAUSTED` | Maximum number reached |
| 409 | `CUSTOMER_DISABLED` | Customer disabled |
| 409 | `INSTALLER_GROUP_MISSING` | Group deleted or no longer part of the customer |
| 429 | – | Rate limit, without database access |
| 503 | – | `SITE_ORIGIN` is not a pure `https:` origin, or `AGENT_JOB_SIGNING_KEY` is missing or invalid. The endpoint checks this before each write |

The endpoint gives reasons only for a valid key, in the order of the table. A trigger error like `customer-disabled` or `customer-mismatch` becomes 409 and never creates a device.

### Orphaned devices

The script registers only when the release signature and the EXE checksum are correct. The native installation can still fail after the registration, for example on a Windows version without support. Then a device that never reports stays with the correct customer. It counts against the maximum number of the installer, and you can remove it like each device. A new run on the same device registers one more device if the script has not written a `config.bin`.

### Storage of the installers

Migration `0033_customer_installers.sql` creates `customer_installers` with these columns: `id`, `customer_id`, `group_id`, `name`, `key_hash` (unique), `mode`, `expires_at`, `max_devices`, `enrollments`, `created_at`, `created_by`, `last_used_at`, `revoked_at` and `revoked_by`, with an index on `customer_id`. A new installer needs an active customer (`customer-missing`, `customer-disabled`). When somebody deletes a customer or changes its ID, a trigger deletes its installers.

The creation (`createCustomerInstaller`), the read, the revocation and the registration are in `lib/server/agent/customer-installers.ts`.

## Catalogs: MSP library and customer entries

Runbooks, automation templates and roles belong to the **MSP library** or to exactly one customer. Library entries have `customer_id IS NULL`, and all customers can use them. Customer entries have a `customer_id`. The rules are in `lib/server/catalog-ownership.ts`.

### Visibility

A library entry is visible to all accounts that see the catalog today. A customer entry is visible only to accounts that see its customer. This is the rule from [Customer boundary](#customer-boundary) (`catalogVisibleGuard`). The status of the customer has no effect: the entries of a disabled customer stay visible and usable. For all other accounts, a customer entry seems not to exist.

Lists do not contain the entry, and actions with its ID reply as for an unknown ID. The messages are `The runbook was not found.`, `The runbook version was not found.`, `This template no longer exists. Reload the page.` and `The role was not found. Reload the page.` For this, `GET /api/runbooks`, `GET /api/automation` and `GET /api/rbac` return the field `catalog`. It contains `separated`, `libraryWritable` and the active visible customers. Each entry has `customerId` and `customerName`.

### Write permission

While the portal has only the default customer, nothing changes. The catalogs are "separated" when a second customer exists (`customerSeparationSql`). Before the separation, all new entries without `customerId` are library entries, and the existing permissions of each catalog apply. The user interface shows no field and no label for the owner. After the separation, the entries from the time before it stay library entries, also the built-in roles.

After the separation, these rules apply:

- **Library entries.** Only global Owners can create, change, version or delete them, in addition to the existing permissions. This rule also applies to entries that a technician created before the separation. Otherwise the result is 403 `Only an Owner can change the MSP library. Select a customer.`
- **Customer entries.** Users maintain them if they have the existing catalog permissions and see the customer. Examples of these permissions are `runbooks.manage` on a device or `portal.roles.manage`. A disabled customer accepts no new entries (409).

The two conditions are a SQL guard (`catalogWriteGuard`) in the write statement. If the account loses the Owner role or the customer assignment between the pre-check and the commit, the portal writes nothing. The maintenance of customer entries is current work within one customer.

The owner of an entry never changes. A new version or a change with a different `customerId` gives 400 `You cannot change later whether an entry belongs to the MSP library or to a customer.` You cannot move or copy entries between the library and customers.

### Binding to the customer

- **Runbooks** of a customer run only on devices of this customer. The portal checks this before the commit (400) and binds it in the commit of the start and the schedule. Library runbooks run on all devices where the account has the permissions.
- **Templates** of a customer: you can assign them only to the groups and devices of this customer. A runbook template of the library uses only library runbooks. A customer template can also use the runbooks of its customer.
- **Drift templates** contain data of their reference device. After the separation, they always belong to the customer of this device, also when an Owner creates them. A different `customerId` gives 400.
- **Roles** of a customer contain only device permissions, no `*` and no `portal.*`. They apply only on device groups and devices of their customer, never globally. The compatibility role from the device group permissions (`set-grant`) belongs to the customer of its group.

The permission evaluation and the automation resolution stay unchanged. The database prevents assignments across customers on each write path, also when a target moves through SQL.

### Existence oracle

`cancelRun`, `cancelSchedule`, `removeAutomationScope` and `startAutomationRun` reply to the ID of a different customer in the same way as to an unknown ID. They do not write and do not create an audit entry. If a technician sees only some of the devices of a run or a schedule, the cancellation replies with 403. The removal of an unknown automation assignment now gives 404 `The assignment no longer exists. Reload the page.` instead of a silent success.

### Storage of the catalogs

Migration `0034_catalog_customers.sql` adds `customer_id` (NULL = library) with an index to `runbooks`, `automation_templates` and `rbac_roles`. It creates no rows. These are the triggers and error codes:

| Code | When |
| --- | --- |
| `customer-missing`, `customer-disabled` | A new entry with an unknown or a disabled customer. An existing role that `set-grant` updates through an upsert does not count as new. |
| `customer-catalog-immutable` | The `customer_id` of an entry changes, also from or to NULL. |
| `customer-role-permissions` | A customer role with `*` or `portal.*`. |
| `customer-role-scope` | A customer role with a global assignment, or with an assignment on a missing target or on a target of a different customer. |
| `customer-catalog-mismatch` | A runbook template with the runbook of a different customer, or a customer template on a missing target or on a target of a different customer (also through an upsert). |
| `customer-mismatch` | A device or a group changes the customer while a customer role or a customer template of a different customer is directly attached to it. |
| `customer-in-use` | Somebody deletes a customer or gives it a new ID while it owns runbooks, templates or roles. |

If a race lets one of these codes reach the commit, the routes translate it into 400, 404 or 409 with the applicable message. They never translate it into 503.

**Desired State configurations** (`desired_configs`) stay instance-wide. Thus they are in effect library entries, also for technicians. For this reason, a customer template for Desired State refers to a shared configuration.

## Actions for multiple customers

An action is for multiple customers (cross-customer) if its target devices belong to two or more customers, by `servers.customer_id`. The catalog has no effect: a library runbook on the devices of one customer is never an action for multiple customers.

### The permission

- The portal permission `portal.msp.crossCustomer` has the label **Start actions for several customers**. It applies only in the global scope.
- Owners always have it through `*`. Other accounts get it through a role that only an Owner can create and assign. Refer to [Owner rule for privileged roles](#owner-rule-for-privileged-roles). The built-in role **User Access Administrator** does not contain it.
- Customer roles cannot contain it (trigger `customer-role-permissions`).
- It does not extend the visibility of customers. A user with this permission still reaches only the devices of the assigned customers. Outside the boundary, each action replies with `The device was not found.` as before, also before the gate.

### Gate

After the checks for each device, `lib/server/identity/cross-customer.ts` finds the customers of the targets. With one customer, nothing changes. With two or more customers, it calls the gate `authorizeCrossCustomerAction` in the same file:

1. Without the permission, the result is 403 `CROSS_CUSTOMER_FORBIDDEN` with this message: `The selection contains devices of several customers. You need the permission “Start actions for several customers” for this. Select devices of one customer or ask an Owner for the permission.`
2. Otherwise, the result is a guard from the live permission check. The guard is in the write statement. If the commit writes nothing, the gate runs again. Then a permission that somebody removed in the meantime gives the 403 of the gate.

If the gate does not succeed, the portal creates no run, no job, no assignment and no audit row.

### In the user interface

The buttons **Preview** and **Start** for runbooks, **Check updates** for agent updates and the Defender actions of the report **Inventory → Defender** can become unavailable. This occurs for a selection of devices of two or more customers if the gate would reject the action. The user interface checks the permission, as the server does. Without the permission, the tooltip shows `The selection contains devices of several customers. You need the permission “Start actions for several customers” for this.`

For a selection from one customer, nothing is locked.

### Affected paths

| Path | Behavior |
| --- | --- |
| Start a runbook (`/api/runbooks`, `run`) | Gate, guard in the new run, customer entries in the same batch |
| Runbook preview (`dryrun`) | Gate without a write. On success, the warning `This run affects devices of {customers} customers. …` |
| Agent update (`/api/releases`, `deploy`) | Gate after the checks for each device, guard in each job, customer entries in the same batch |
| Desired State assignment (`/api/desired-state`, `assign`) | Gate after the checks for each device, guard in the insert, customer entries in the same batch |
| Defender actions of the report **Inventory → Defender** (`/api/console`, `defender-jobs`) | Gate after the checks for each device, guard in each job, customer entries in the same transaction |

The bulk offboarding (`remove-servers`) is an exception. Like a revocation, a removal is always possible. It is also Owner-only.

### Schedules only for one customer

A runbook schedule applies to the devices of one customer. `schedule` rejects targets of multiple customers with 400, also for Owners. The message is `A schedule applies only to devices of one customer. Create a separate schedule for each customer.` A schedule thus stays inside the boundary and the technicians of one customer. An active schedule for multiple customers from older data or direct SQL starts no run at the tick. The portal disables it and records the audit action `Runbook-Zeitplan über mehrere Kunden deaktiviert` in the device logs.

### Customer entries in the portal log

Each action for multiple customers writes exactly one customer entry for each affected customer in the same batch. It does this only when the action itself writes:

| Action | Stored `action` | Stored `target` |
| --- | --- | --- |
| Start a runbook | `Runbook kundenübergreifend gestartet` | `{runbook} / v{version} / {run ID} · {k} von {N} Geräten` |
| Agent update | `Agent-Update kundenübergreifend geplant` | `{version} · {k} von {N} Geräten` |
| Desired State assignment | `Desired State kundenübergreifend zugewiesen` | `{version ID} / v{version} · {k} von {N} Geräten` |
| Defender action | `Defender-Aktion kundenübergreifend gestartet` | `{operation} · {k} von {N} Geräten` |

`k` is the number of devices of this customer, and `N` is the number of all target devices. A customer entry is a portal row (`scope='portal'`, without `server_id`) with `customer_id`. It appears in the Owner-only portal log with `Customer: {customerName}` in the column **Device / area**. Technicians do not see it. The device rows of the action stay as before and contain the customer of their device.

## Owner rule for privileged roles

A role is privileged if its permissions contain `*` or `portal.msp.crossCustomer`. These rules in `lib/server/identity/rbac.ts` apply from the first start and do not depend on the number of customers. The portal checks them live before and in the commit:

| Action | Rule |
| --- | --- |
| `create-role` with privileged permissions | Only Owners |
| `update-role`, if the old or the new permissions are privileged | Only Owners |
| `delete-role` of a privileged role | Only Owners |
| `add-assignment` of a privileged role, to each subject and in each scope, also the built-in Owner role | Only Owners |
| `add-member` to a user group with an assignment of a privileged role, and the activation of such a group | Only Owners |
| Account actions in `app/api/auth/route.ts` (`reset-link`, `update-user`, `disable-user` to lock and unlock) for an account with a privileged role. The role can be direct or through any user group (also a disabled group), in each scope (`targetDominanceGuard` in `lib/server/identity/access.ts`) | Only Owners, otherwise 403 `Only an Owner manages accounts with an Owner role or the permission “Start actions for several customers”.` |

Otherwise the result is 403 with one of these messages:

- For roles: `Only an Owner can create, change, delete or assign roles with all permissions (*) or the permission “Start actions for several customers”.`
- For user groups: `Only an Owner can activate a user group with an Owner role or the permission “Start actions for several customers”, or add members to it.`

The rule for user groups with a customer assignment applies first and keeps its text. If a role becomes privileged between the check and the commit, the comparison `permissions=?` prevents the assignment.

The removal stays unchanged. You can remove an assignment (with the rule for the last Owner), remove members and disable a group. For non-Owners, the permissions UI locks privileged roles with `Only an Owner can change and assign this role.` It does not offer them in the assignment. The permissions UI shows the permission **Start actions for several customers** only after the separation. It locks this permission for non-Owners with `Only an Owner can grant this permission.`

The open invitation and password links of an account become invalid in the same commit when it gets a privileged role. This occurs through a direct assignment, through the addition to a group with such a role or the activation of this group. It also occurs when a role becomes privileged. After that, somebody must issue a new link.

## Audit for each customer

Migration `0035_audit_customers.sql` adds `customer_id` (TEXT, NULL) and the index `idx_audit_customer_at` on `(customer_id, at)` to `audit`. `scope` and its CHECK stay. The migration does not rebuild the table and creates no rows.

- **Backfill:** Existing rows with `server_id` get the customer of their device. If the device is missing, and for all other rows, the value stays NULL.
- **Device rows:** After the insert of a row with `server_id` and without `customer_id`, a trigger sets the customer of the device. Thus `log()` and all direct inserts store the customer, but they do not have to know it. If the device is missing, the value stays NULL, and the insert does not fail.
- **Customer entries** set `customer_id` explicitly. An unknown customer fails with `customer-missing`, and a device of a different customer fails with `customer-mismatch`. Disabled customers are permitted. These audit actions contain the customer: `Kunde angelegt`, `Kunde geändert`, `Kunde deaktiviert`/`Kunde aktiviert`, `Techniker geändert`, `Installer erzeugt`, `Installer widerrufen` and `Gerät aus Portal entfernt`. Thus they follow the retention of this customer.
- **Immutable:** A customer that is set never changes, also not to NULL (`audit-customer-immutable`).
- Nobody can give a customer with audit rows a new ID (`customer-in-use`). A delete of the customer keeps its rows and their `customer_id`.
- `auditSelect` returns `customerId` and `customerName`, also for disabled customers. For a deleted customer, `customerName` is the last name from `removed_customers`, and `customerRemoved` is true. The portal log then shows the area as `{name} (deleted)`. The portal log stays Owner-only.

**Retention:** In one instance pass, the maintenance deletes the rows without a customer and the rows of customers without their own retention. This pass uses the instance retention of the page **Data retention**. It also deletes the old rows of deleted customers, with one segment for each row of `removed_customers`. Each customer with its own retention gets a separate pass with its days. Each of these customers also gets a separate row `Audit retention applied` with its `customer_id`. For more information, refer to the maintenance section in [`self-hosting.md`](self-hosting.md#maintenance).

## Where the code is

The customer functions are normal parts of the product. A portal with one customer uses the same code. These files hold them:

- `lib/server/identity/customers.ts`: the storage and the read functions.
- `lib/server/identity/customer-admin.ts`: create, edit, disable, enable and delete a customer, and the technicians.
- `lib/server/identity/multiple-customers.ts`: the setting **Multiple customers**.
- `lib/server/identity/customer-technicians.ts`: a request that only removes technicians.
- `lib/server/agent/customer-installers.ts`: the installers and the registration through an installer.
- `lib/server/identity/cross-customer.ts`: actions for multiple customers and their gate.
- `runtime/customer-separation.mjs`: the condition that switches on the boundary.
- `app/api/customers/route.ts` and `ui/settings/customers-panel.tsx`: the route and the page. `ui/settings/customer-drawers.tsx` holds the side panels, and the delete panel is the kit part `ui/kit/name-confirm-drawer.tsx`.
- `drizzle/0041_customer_delete.sql`: the table `removed_customers` and the triggers of the delete.

In the device tree of the console, the model appears only from two visible customers. Then **All devices** contains one folder for each visible customer with its root groups and its devices without a group. The tree sorts the folders by name and shows them collapsed at the start. The counter of a folder shows all devices of the customer in the tree.

A customer without groups and devices also gets a folder. It shows the count 0 and does not open. Groups and devices without a visible customer stay directly below **All devices**, as before.

When a customer folder has a group and a device without a group, these devices are in the node **Ungrouped**, after the groups. The node opens `#devices/customer/<id>/ungrouped`. In a tree with folders, **All devices** has no node **Ungrouped**. A drop on the node of a customer accepts only devices of this customer.

A click on a customer folder opens the customer view. The view shows the device table of **All devices**, but only with the devices of this customer. The header shows the customer name, the number of devices, the devices online and the devices with issues. The view has the tabs **Devices**, **Monitoring**, **Inventory** and **History**, the same tabs as **All devices** and a group.

**Monitoring → Alert rules** shows the alert rules of the customer. They apply to all groups and devices of the customer. Refer to [Alert rules](alert-rules.md#inheritance). When the portal has more than one customer, **Monitoring** also has **Notification rules**. A customer has no tab **Configuration**.

The caret and the arrow keys open and close the folder.

For Owners, the header shows **Add device**. It opens `#devices/add/customer/<id>`, and the form **Add device** starts with this customer. A customer without devices shows **This customer has no devices yet** with the same action. The folder menu also has **Add device**.

The customer view has its own route, `#devices/customer/<id>`. Its tabs and views add their name to the route, for example `#devices/customer/<id>/history` or `#devices/customer/<id>/monitoring/notification-rules`. While the portal has only the default customer, the route of **Notification rules** opens the tab **Devices**. The route `#devices/customer/<id>/ungrouped` shows the devices of the customer that are in no group. Links, reload and the back and forward buttons of the browser work.

If the viewer cannot see the customer, the console opens **All devices** instead. This also occurs when an Owner disables the customer, when the assignment is removed or when fewer than two customers stay visible. With sample devices, there is no customer view.

The menu of a customer folder (**…**, right click or Shift+F10) and the menu **More actions** of the customer view have the same actions. **Create group for this customer** creates a root group for this customer. This action needs the right to create root groups.

**Manage customer…** and **Technician access…** open the matching side panel over **Devices**. The address, the tree selection and the view stay. After a save, the tree and the header show the new data at once. **Installers** opens **Devices** › **Add device** › **Several devices** with this customer (`#devices/add/installer/customer/<id>`), and the device tree stays visible. Only Owners can use these three actions, and the server checks every right again.

With one customer (a portal with one customer, or a technician with one customer) and with sample devices, the tree stays flat. The assignment comes from `customerId` on devices, groups (`deviceGroupCatalog`) and permission targets (`devicePermissionTargets`). `ui/devices/fleet/customer-folders.ts` makes the division.
