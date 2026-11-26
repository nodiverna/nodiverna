# Own login and RBAC

ServerDesk authenticates portal users with its own unique user ID, a password and MFA. The portal needs no external identity provider. Optionally, people of one Microsoft Entra ID tenant sign in with their work account, refer to [entra-id.md](entra-id.md). The device APIs use only ServerDesk sessions. An agent token does not replace a user login.

## Accounts

Each account has an immutable internal identifier. The TOTP encryption, the recovery codes, the passkeys, the runbook owners and the job history refer to it. The display name, the contact address and the selected username are separate from the identifier. New accounts get a random internal ID.

There is no default password, no public self-registration and no automatic admission of unknown users. The portal never takes an identity from request headers of an upstream gateway.

## User management

In **Settings → Accounts**, administrators with the necessary right create an account and a personal invitation link for one use. A link is valid for 24 hours. Then the user sets the password and MFA, with a passkey or an authenticator app. An account without a role assignment has no device permissions. The administrator can assign user groups and roles already to invited accounts.

To give an account a role, use **Assign role** in the menu of the account, or in the message after you create the account. This opens the role assignment of **All devices** with the account filled in. Select the role and click **Assign role**.

Password links for activated accounts are valid for one hour. A new invitation or a new reset link makes older links invalid.

Open invitation links and password links also become invalid when the account gets a privileged role (`*` or `portal.msp.crossCustomer`) or a customer. This occurs in these cases:

- A direct assignment gives the role.
- The account becomes a member of a user group with such a role, or such a user group is enabled.
- An assigned role becomes privileged.
- The account gets a customer directly or through one of its user groups. This includes a disabled group.
- The account becomes a member of a user group with a customer assignment, or such a user group is enabled.

This does not change the sessions and the account version. After that, an administrator must issue a new link.

The portal shows the links only one time. Give them to the user through a suitable personal channel. The application sends no automatic e-mail.

The secret token is in the URL fragment. The page removes it from the address bar before other requests and redeems it only in the POST body. The database contains only its SHA-256 digest. The same transaction as the password change checks the expiry, the purpose, the account version and the use for one time.

A change of rights becomes effective only together with its audit entry. When open links expire because the rights of an account become larger, the portal records the audit action `Konto-Links wegen Rechteanstieg verfallen` for each account. When they expire because of a customer assignment, the portal records `Konto-Links wegen Kundenzuweisung verfallen`. If one change causes the two reasons, the account gets only the entry `Konto-Links wegen Rechteanstieg verfallen`.

A password change needs the current password and a new MFA confirmation. A locked account, a password change and a reset have these effects:

- They revoke all password sessions and MFA sessions, the browser trust and open confirmations.
- They close remote connections.
- They cancel the jobs that still wait.

Actions that already started on Windows can continue. MFA secrets and passkeys stay after a password change. A minimum of one active direct global Owner must stay. The portal checks this when it writes.

### Locked by Microsoft sign-in only

**Microsoft sign-in only** in the Entra ID settings locks all built-in accounts except the emergency access, refer to [entra-id.md](entra-id.md#microsoft-sign-in-only). The accounts, their role assignments and their audit history stay. While the setting is on, no one can create or unlock a built-in account. When an Owner allows built-in accounts again, the locked accounts stay locked until an Owner unlocks them.

## Roles and scopes

The permissions are the sum of direct user assignments and the memberships in enabled user groups. An assignment applies globally, to a device group or to one device. Global assignments apply to all devices. Device groups give their assignments to their current members. An old global user role does not limit the new rights.

There are no deny rules and no integration with PIM. Entra groups can give roles through group mappings, refer to [entra-id.md](entra-id.md#group-mappings).

| Role | Purpose |
| --- | --- |
| Owner | All rights in the assigned scope. Only a global Owner is also a portal administrator. |
| Reader | Read devices, monitoring and diagnostic functions that explicitly only read. |
| Operator | Operate devices. No implicit management of portal users. |
| Device Administrator | Manage devices, including the device actions that are defined for this. |
| User Access Administrator | Global management of users, groups, roles and assignments. No implicit device access. Can give wide access through assignments, so it must be trustworthy. |
| Portal Operator | Uses the runbook and desired-state catalogs. Alone, it gives no device access. |

When the portal has more than one customer, the customer boundary is above all scopes. Each device and each device group belongs to one customer. For an account, roles apply only to devices and groups of the customers that the account can see. Global Owners see all customers. All other accounts see only the customers that are assigned to them or to their user group.

This applies to global roles and also to roles directly on a device group or a device. A different customer stays invisible.

With more than one customer, the actor must see each customer of a user group to remove a member from it. If not, the result is 403 `This user group is assigned to a customer that you cannot see. Only an Owner or someone who sees all customers of the group can remove members.` For more information, refer to [`customers.md`](customers.md#customer-boundary).

The device right `terminal` (**Open SYSTEM terminal**) also allows the PowerShell scripts that the AI assistant proposes. A script runs as SYSTEM, the same as a terminal command. For this reason, it needs the same checks as the opening of a terminal: Management mode, a fresh step-up proof and a confirmation. Without `terminal`, the assistant proposes no script and the portal runs none. For the details, refer to [AI assistant](ai-assistant.md#commands).

Microsoft Defender has two device rights. `defender.read` (**View Microsoft Defender**) shows the Defender detections and exclusions, which contain file paths and user names. `defender.control` (**Control Microsoft Defender**) allows the Defender actions: quick scan, full scan, signature update and the clean of all active detections. These actions need only this right, not `manage`. Both rights are allowed in customer roles.

| Built-in role | Defender rights |
| --- | --- |
| Owner | Both, through `*` |
| Reader | `defender.read` |
| Operator | `defender.read` and `defender.control` |
| Device Administrator | `defender.read` and `defender.control` |
| User Access Administrator | None |
| Portal Operator | None |

The migration `0014_defender_rights.sql` adds these rights to the built-in roles of an existing database. It changes no custom role and no customer role.

Agent extensions have five device rights. They show in the role editor in the category **Extensions**. All five are allowed in customer roles.

| Right | Use |
| --- | --- |
| `plugins.manage` (**Manage extensions**) | Install, repair, remove and roll out agent extensions |
| `dhcp.read` (**View DHCP**) | The DHCP view of a device and the fleet card **DHCP scope usage** |
| `dhcp.manage` (**Manage DHCP**) | The changes of the DHCP plugin: scopes, reservations, leases, options, policies and failover. A failover change also needs the right on the partner device. |
| `dns.read` (**View DNS**) | The DNS view of a device, the record reads of a zone and the fleet card **DNS zones** |
| `dns.manage` (**Manage DNS**) | The changes of the DNS plugin: zones, records, conditional forwarders, forwarders, aging and scavenging, and the cache |

| Built-in role | Server role rights |
| --- | --- |
| Owner | All five, through `*` |
| Reader | `dhcp.read` and `dns.read` |
| Operator | All five |
| Device Administrator | All five |
| User Access Administrator | None |
| Portal Operator | None |

The migration `0019_agent_plugins.sql` adds these rights to the built-in roles of an existing database one time. It changes no custom role and no customer role. For the plugins, refer to [Agent plugins](agent-plugins.md).

Custom roles select specific permissions. Portal management rights need the global scope. The portal does not take assignments only from a viewer that it loaded before.

The SQL statements that write or release jobs check these items again: active accounts, group membership, the current role definition and the device scope. Sensitive IAM changes need a new MFA confirmation for one use. The portal consumes this confirmation atomically with the change. The table in [portal-sessions.md](portal-sessions.md#which-actions-ask-for-mfa-again) shows which actions ask for it.

Group managers cannot give new rights through groups that are already assigned. Memberships, deactivation and deletion of such groups also need the right to assign roles. Changes to the rights of roles that are already assigned also need this right.

Some account actions change an existing account. These actions are invitation links and password links, edits of the display name and the e-mail, and lock and unlock. They check before the action and live in the commit if the actor controls the target account (`targetDominanceGuard`). The actor always needs `portal.users.manage`. The other rights depend on the target:

- The account has no role assignment: no other right.
- The account has role assignments, but no privileged role: also `portal.roleAssignments.manage`. If not, the result is 403 `This account has role assignments. To manage it, you also need the permission “Manage role assignments”.`
- The account has a privileged role (`*` or `portal.msp.crossCustomer`): also `portal.roleAssignments.manage`. The actor must also be a global Owner. This applies with one customer and with several customers. If not, the result is 403 `Only an Owner manages accounts with an Owner role or the permission “Start actions for several customers”.`

When the portal has more than one customer, a further condition applies to each of these cases: the actor must see each customer of the account. Global Owners see all customers. If not, the result is 403 `This account is assigned to a customer that you cannot see. Only an Owner or someone who sees all customers of the account can manage it.` This message comes after the message for privileged roles and before the message for role assignments.

A customer of the account is each customer that is assigned to the account directly or to one of its user groups. This also includes a disabled group. The status of the customer is not important.

Each assignment in each scope counts as a role of the account. This includes direct assignments and assignments through any user group, also a disabled group. The account status is not important. For a lock, the rule for the last active direct global Owner (`lastOwnerGuard`) also applies. Thus the management of users, groups or role definitions alone cannot give a user more rights or control of a more powerful account.

When the portal has more than one customer, each custom role belongs to the MSP library or to one customer. The roles of a customer contain only device rights. They apply only to device groups and devices of this customer. Only accounts that can see the customer can see these roles. The built-in roles and all roles from the time with one customer are in the library. From then on, only Owners can change them.

For more information, refer to [`customers.md`](customers.md#catalogs-msp-library-and-customer-entries).

The portal right `portal.msp.crossCustomer` (**Start actions for several customers**) permits some actions for devices of multiple customers in one step. These actions are runbooks, agent updates, Desired State assignments, extension rollouts and DHCP and DNS changes. Owners have this right through `*`. The built-in role User Access Administrator does not contain it. The right does not make the customer view larger.

Only an Owner can create, change, delete or assign roles with `*` or with this right. This rule applies from the first start and does not depend on the number of customers. It also applies to the built-in Owner role. Only an Owner can add members to a user group with such a role or enable such a group. `portal.roleAssignments.manage` is not sufficient for this. For more information, refer to [`customers.md`](customers.md#owner-rule-for-privileged-roles).

On the server, only `lib/server/identity/policy/can.ts` decides if an account is the Owner of the instance. It uses `can()` and `requireCan()` for the check before the action, and `canSql()` and `viewerCanSql()` in the statement that writes. The check is live and not a snapshot from the start of the request. It reads the current global Owner assignment, direct or through an enabled user group.

For each request, `can()` queries the database for the same viewer one time or less. Checks after a rejected commit query again with `{fresh:true}`. A lint rule (`no-restricted-syntax` in `eslint.config.mjs`) applies to `lib/`, `app/api/` and route handlers. It prevents new comparisons with `role==='admin'`, calls of `hasGlobalPermission(…,'*')` and imports of `globalOwnerGuard`.

### Inherited assignments

The page **Permissions** (under **Configuration** of **All devices**, a group or a device) has two cards. The search is above the cards. **Add assignment** is a button in the head of the page. It opens a form at the side.

The **Direct** card shows the assignments of this device, group or **All devices**. It has no scope column, because the scope is always the open one. **Remove assignment** is in the menu of the row. It opens a confirmation with the user or group, the role and the scope.

The **Inherited** card follows. It shows only rows that you cannot change here. The menu of the row has **Open origin**.

If the **Direct** card is empty, it tells why. The text is different when inherited assignments exist, when nothing applies, and when the search finds nothing.

On a device or a device group, **Permissions** shows the direct assignments first. Below them, the read-only section **Inherited** shows each assignment that applies there through inheritance. Each row shows the user or user group, the role and the origin. The origin is **All devices** or a parent group. Its link opens the permissions of that origin. You can change or remove an inherited assignment only at its origin.

The console reads the section from `GET /api/rbac?scopeType=device&scopeId=<id>` or `scopeType=devicegroup`. The response then has the field `inherited`. Without the two parameters, or with `scopeType=global`, the response does not change. The server uses the same scope rules as the access check in `lib/server/identity/access.ts`.

The list starts with the nearest origin and ends with **All devices**. For a device, the first origin is its group, then each parent group. For a group, the first origin is its parent group. The assignments on the object itself are direct, not inherited. The list contains only assignments that the viewer also sees in the assignment list, inside the customer boundary. The section also shows disabled user groups and accounts that are not active, with a mark, because they give no rights.

Each entry in `inherited` has the field `effective`. The server calculates it with the same rules as the access check. An entry is effective if the role gives one or more device rights and an active account gets the role from the assignment. That account must also be inside the customer boundary of the device or group.

If `effective` is `false`, the field `reason` gives the first cause that applies:

| `reason` | Cause |
|---|---|
| `role` | The role has no device rights. |
| `user-inactive` | The account is not active. |
| `group-disabled` | The user group is disabled. |
| `group-empty` | The user group has no active members. |
| `user-customer` | The account is not assigned to the customer. |
| `group-customer` | No active member of the user group is assigned to the customer. |

While the portal has only the default customer, the two customer reasons do not occur.

The section shows an entry that is not effective with muted text and a short reason. For an account that is not active and for a disabled user group, the mark shows the reason.

The lists `assignments` and `inherited` contain only the global assignments and the assignments on devices and groups of the customers that you see. An Owner and an account that sees all customers get all assignments.

### Rights on the server

A portal right such as **Manage DHCP** or **Manage DNS** decides who can start a change in the portal. From agent 4.19.0, a change through a plugin also runs with the AD account of the technician. The server then checks the AD rights of that account, for example the membership in **DHCP Administrators** or **DnsAdmins**. Both must allow the change. For the details, refer to [AD sign-in for plugin changes](plugin-ad-sign-in.md).

The AD sign-in belongs to the portal session. It ends when the portal session ends, and after 8 hours at the latest.

## Password and session protection

Passwords have 15–128 Unicode characters. The portal does not trim them, and their limit is 1,024 UTF-8 bytes. The portal rejects frequent obvious passwords locally. This list is not a full database of compromised passwords.

Native scrypt uses `N=16384,r=8,p=5`, a random salt of 32 bytes and a key of 32 bytes. An external pepper protects the derived value with HMAC-SHA-256. The cost parameters have a fixed limit. Changed hash records cannot make them larger. Unknown, locked and incorrect accounts get the same error message and do the same limited verification step.

The server limits the attempts for accounts and for the IP that the trusted ingress supplies. The limits are 10 attempts for each account and 40 attempts for each IP in ten minutes. The server does not use untrusted Forwarded headers to bypass this limit. Browser requests that write need the exact configured origin, and their body size has a limit.

At first, a password login is valid for only ten minutes, to complete MFA. MFA rotates the primary session token and binds it to exactly this MFA session. The absolute password session ends 24 hours after the password login or earlier. An MFA renewal does not make this limit later.

One hour without real user activity ends the MFA session. Background polling does not make the idle deadline later. The optional browser trust stays limited to its original 24 hours. It does not replace the password.

Primary tokens are random values of 256 bits. The database stores only digests. Cookies use `__Host-`, Secure, HttpOnly and SameSite=Strict. The tokens travel only in these cookies. No JSON reply returns them, and headers never authenticate a session (refer to [portal-sessions.md](portal-sessions.md)). The portal does not store tokens in Local Storage.

## Audit log

Only an Owner sees **Settings → Audit log**. It shows the newest 100 entries of the portal: the time, the account, the action and the target. When the portal has customer entries, it also shows the area, **Portal** or the customer.

The action shows a label in your language and below it the action code, for example `auth.entra.login.refused`. An action that the portal does not know shows its code. A text that the portal cannot assign shows **Unlisted action**. The details of the row show the stored text. The target shows the name of an account instead of its internal ID.

Use the search and **Action type** to find entries. **Export as CSV** exports the rows that you see, on all pages. The table shows 25 rows on each page. When the newest 100 entries are loaded, select **Load older entries** below the table. The portal then adds the next 100 entries. A refresh shows the newest 100 entries again.

Select a row to see its details: the time, the account, the area, the action, the action code and the target. A target with more values shows them under **Details**. **Stored target** shows the target as the portal saved it.

## Independent operation

The identity and RBAC layer runs inside the portal. The portal uses Next.js and Node.js. The data layer runs the permission checks in the same PostgreSQL transaction as the change. The ingress removes identity headers that come from outside.

A single installation uses a PostgreSQL container and local file storage. Multiple Azure replicas use the same image with Azure Database for PostgreSQL and Azure Blob Storage. The pipeline records the migrations with checksums and runs them explicitly before the rollout.

The first global Owner comes only from the administrative CLI command `bootstrap-owner` on an empty installation. The invitation token from this command is valid one time and for 24 hours. There is no public bootstrap endpoint. Other users get an invitation in the portal.

For a later data import, keep the original `PASSWORD_PEPPER` and `SESSION_SECRET` values. Without `PASSWORD_PEPPER`, the password records do not work. To change `SESSION_SECRET` and keep the encrypted MFA data, refer to [`self-hosting.md`](self-hosting.md#change-the-session-secret). A download of the repository does not contain this data and these secrets.

Passkeys are bound to the original RP ID. After a domain change, use TOTP or recovery codes and register the passkeys again.

For the configuration, the pipeline commands, offline signatures, backups and the requirements for a company installation, refer to [self-hosting.md](self-hosting.md).
