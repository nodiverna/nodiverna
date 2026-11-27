# DHCP server

The DHCP plugin shows the DHCP server of a Windows server in the portal. From plugin 1.1.0, you can also change the DHCP server from the portal. For the plugin itself, refer to [Agent plugins](agent-plugins.md).

## Open the view

1. Install the DHCP extension on the device. Refer to [Install and remove](agent-plugins.md#install-and-remove).
2. Open the device on its area **Extensions**.
3. In the row **DHCP extension** of **Installed**, select **Open DHCP**.

The command palette also has the item **DHCP server** for a device with the extension. The link is `#device/<id>/extensions/dhcp`. **Open DHCP** selects the tab **DHCP server** of **Extensions**. Select the tab **Overview** to go back.

The health line on the device **Overview** links the DHCP issues with **Open DHCP server** to the DHCP server of the area **Extensions**. It shows this link only on a device with the DHCP role.

You need the right `dhcp.read` (**View DHCP**) on the device. Without it, the view shows "You cannot view this DHCP server".

## What the view shows

The head shows the server name, the time of the last read and the plugin version. **Read again** starts a new read at once. The button shows its progress until the job ends, and then the view loads the new data. When you cannot change the DHCP server, one notice tells you why and that you can still read it.

Four values show at the top:

- **IPv4 scopes**: the number of scopes and the number of active scopes.
- **Addresses in use**: the addresses in use of all active IPv4 scopes, as a percentage of all their addresses.
- **Leases**: the number of leases, with "truncated" when the plugin cut the list.
- **Fullest scope**: the scope with the highest usage. Select it to open the scope.

The card **Server** shows the service state, the AD authorization, the domain, the number of failover relationships and the time of the data.

The tabs below show the details:

| Tab | Content |
| --- | --- |
| **Scopes** | IPv4 and IPv6 scopes with range or prefix, state, superscope, usage, lease duration or lifetimes, and failover. Select a scope to see its exclusions, reservations, options, policies (IPv4 only) and leases. |
| **Leases** | Address, name, client ID, scope, state and expiry. The toolbar has the search and the filters for scope and state. The table foot shows the count, for example "12 of 40 leases". |
| **Reservations** | Address, name, client ID or DUID, scope, type and description |
| **Options** | The server options of IPv4 and IPv6 with code, name, values, vendor class and user class |
| **Policies** | Server and scope policies with order, state, conditions and address ranges |
| **Failover** | Relationship, partner server, mode, state, MCLT and scopes |

When the DHCP Server service is stopped, the view shows a warning with **Open Services**. Clients then get no addresses from this server.

## Change the DHCP server

From plugin 1.1.0, you can change the DHCP server from the view, as in the DHCP console on the server. Each change is a job **Extension job** with the operation as its target. The plugin makes the change on the local DHCP server and then reads the server again. The job dock shows the progress. While change jobs of the device are open, the head shows, for example, "2 changes running". When the last one ends, the view loads the new data in place.

### The changes

| Section | Changes |
| --- | --- |
| Scopes | **New scope** (IPv4 or IPv6), **Edit scope**, **Activate scope**, **Deactivate scope**, **Delete scope**. **Superscope actions**: **Create superscope**, **Edit superscope**, **Activate superscope**, **Deactivate superscope**, **Delete superscope**. |
| Scope drawer | **Edit scope**, **Add exclusion**, **Add reservation**, **Set option**, **New policy**, and for a failover scope **Replicate scope**. Each row has a menu with **Edit** and **Remove**. |
| Leases | Select leases with their checkboxes, or all shown leases with the head checkbox. The selection bar below the table shows "{count} selected", **Delete leases** and **Clear selection**. Delete takes the leases of one scope, at most 100. A row menu has **Add reservation** (filled in from the lease) and **Delete lease**. |
| Reservations | **Add reservation**, **Edit reservation**, **Remove reservation**. |
| Options | **Set option** for the IPv4 and the IPv6 server options, **Edit option**, **Remove option**. |
| Policies | **New policy**, **Edit policy**, **Turn on policy**, **Turn off policy**, **Set option** for the policy, **Delete policy**. |
| Failover | **New failover relationship**, **Edit relationship**, **Replicate relationship**, **Remove relationship**. |

A create or an edit opens a drawer with a form. The form marks a value that does not fit this server under its field, for example a range that overlaps a scope. An unchanged edit says "No changes". Every change asks for a confirmation that names the device, the change, the object and the failover partner. Deletes and removals use the danger button.

### Gates

A change needs all of these:

- the right `dhcp.manage` (**Manage DHCP**) on the device;
- the device is online and has DHCP plugin 1.1.0 or later;
- an MFA session, as for the other changing jobs;
- agent 4.19.0 or later and a sign-in with your AD account for the domain of the device, see below;
- Management mode, and no agent update in progress;
- a read of the DHCP server in the portal, with the service running;
- room in the job queue of each device (20 jobs).

The controls stay visible when a gate does not hold, and they show the first reason. When the DHCP Server service is stopped, the reason is "The DHCP Server service is stopped. Start the service in Management → Services.". Sample devices show "Not available for sample devices.". The server checks each gate again and writes nothing when one does not hold. Each job gets one row in the device audit with the English job label, for example "Create DHCP scope".

### AD account

A change runs with your AD account, not as the SYSTEM account of the agent. The DHCP server checks your rights, and the Windows Security log names you. For the design, refer to [AD sign-in for plugin changes](plugin-ad-sign-in.md).

- The first change on a server opens the dialog "Sign in to {domain}" before the confirmation. Type `DOMAIN\name` or `name@domain` and the password. On a workgroup server, type a local account of that server.
- The sign-in works on every server of that domain until you sign out of the portal, for at most 8 hours. A failover partner in another domain needs its own sign-in.
- The head of the view shows the account and the end of the sign-in. Its menu has **Sign out of {domain}**.
- The confirmation shows the line **AD account**.

The account needs rights on the DHCP server: add it to the local group **DHCP Administrators** of each server, or to the domain group of that name on a domain controller. Without these rights, a change fails with "The server refused this change for CORP\anna…". A read does not need the sign-in, because it still runs as SYSTEM.

### Failover partners

The plugin has no network access. So the portal sends the partner side of a failover change as a second job to the partner device. The portal finds the partner among your devices with a DHCP read:

- the DHCP server name of the read is the partner name of the relationship;
- or the device name is the first label of the partner name;
- or the partner is an IPv4 address of the device.

When no device or more than one device matches, the portal has no partner. A partner must pass the same gates as the device. A partner that belongs to another customer needs the cross-customer gate.

A change of a scope in a failover relationship goes to the partner as well: a scope edit, activate or deactivate, an exclusion, a reservation, a scope option and a scope policy with its options. The confirmation says so. Lease deletes, server options, server policies, superscopes and IPv6 changes stay on the device. You cannot delete a scope in a relationship. Remove it from the relationship first.

Without a partner in the portal, a scope change runs only on the device. The confirmation then warns that the partner keeps the old setting.

### Failover relationships

**New failover relationship** needs a partner device in the portal. The portal queues the relationship on the device, then copies each scope to the partner, then creates the relationship on the partner. The partner gets the other share of a load balance, the other role of a hot standby and the device as its partner. 

**Edit relationship** changes both servers. A scope that you remove from a relationship stays on the device and is deleted on the partner, as in the DHCP console. **Remove relationship** removes it on both servers and deletes its scopes on the partner. Without a partner in the portal, only the device removes the relationship.

A shared secret for message authentication needs agent 4.17.0 or later on both devices (capability `plugin-secrets`). The portal seals the secret for each device. It is never in the job parameters, the audit or a job result. Turn authentication off without a secret.

The two jobs of a pair are not one transaction. One side can fail while the other succeeds. Both jobs show in the job dock. **Replicate** repairs the scope settings.

### Replicate

**Replicate relationship** and **Replicate scope** copy the scope settings from the last read of the device to the partner. The confirmation shows the time of this read. The copy replaces the range, the exclusions, the scope options and the scope policies on the partner, and it makes the reservations the same. A large scope goes as several jobs of at most 48 KiB each. When the partner has fewer free job slots than these jobs need, the portal refuses the request.

### Limits

- The AD authorization stays read-only. Authorize or deauthorize the server in the DHCP console.
- IPv6 scope lifetimes and IPv6 reservation names cannot be set.
- A failover relationship needs both servers as devices in this portal with the DHCP plugin 1.1.0.
- When the plugin cut reservations from the last read to stay below 2 MiB, the portal refuses **New failover relationship**, added scopes and **Replicate**. A copy from that read would delete the missing reservations on the partner. Set up or replicate the relationship with the DHCP console on the server.
- The portal checks each change against the last read. The plugin checks the change again on the server and answers, for example, `PLUGIN_DHCP_OBJECT_EXISTS` when the server changed in the meantime.
- Option definitions, vendor and user classes and reservation options cannot be changed.

## Fleet card

The report **Inventory → Extensions** of **All devices**, a group or a customer shows the card **DHCP scope usage**. It has one row for each scope of each DHCP server with the plugin. The rows are sorted by usage, the fullest scope first. Select a server name to open its DHCP view.

The card shows only the devices where you have `dhcp.read`. Without this right on any device, the card does not show. The role filter and the search of the tab also filter the card.

## Data sources

The plugin reads the local DHCP server through the DHCP Server Management API (`dhcpsapi.dll`). It uses no network connection, no LDAP and no PowerShell.

| Data | API |
| --- | --- |
| Scopes, exclusions and reservations | `DhcpEnumSubnets`, `DhcpGetSubnetInfo`, `DhcpEnumSubnetElementsV5` and the IPv6 calls |
| Leases | `DhcpEnumSubnetClientsV5` and `DhcpEnumSubnetClientsV6` |
| Usage | `DhcpGetMibInfoV5` and `DhcpGetMibInfoV6` |
| Superscopes | `DhcpGetSuperScopeInfoV4` |
| Options | `DhcpEnumOptionValuesV5`, `DhcpEnumOptionValuesV6` and `DhcpEnumOptionsV5` |
| Policies | `DhcpV4EnumPolicies` |
| Failover | `DhcpV4FailoverEnumRelationship` |
| AD authorization | `DhcpServerQueryAttribute` |
| Option definitions (1.1.0) | `DhcpEnumOptionsV5` and `DhcpEnumOptionsV6` |
| Policy options (1.1.0) | `DhcpV4GetAllOptionValues` |

The changes of plugin 1.1.0 use the matching write calls, for example `DhcpCreateSubnet`, `DhcpAddSubnetElementV5`, `DhcpSetOptionValueV5`, `DhcpV4CreatePolicy` and `DhcpV4FailoverCreateRelationship`. A change of several steps undoes the earlier steps when a later step fails, where the API allows it.

The portal keeps only the newest read of each server. The removal of the plugin or of the device deletes it.

## The 15-minute cycle

The broker reads the DHCP server every 15 minutes under the signed plugin policy. For the details, refer to [Signed collection](agent-plugins.md#signed-collection). The first read is about 60 seconds after the install. **Read again** and **Read now** start the job **Read DHCP server** in addition. Only one of these jobs can be open for each device.

## Limits of plugin 1.0.0

The IPv6 scope API (`DhcpGetSubnetInfoV6`) does not return the preferred and valid lifetimes of a scope. The IPv6 reservation API does not return a name. So plugin 1.0.0 sends no IPv6 lifetimes and no IPv6 reservation names. The column "Valid lifetime" and the scope drawer show "—" for them. To see these values, use `Get-DhcpServerv6Scope` on the server.

## Truncation

The data of one read have at most 2 MiB. When the data are larger, the plugin first removes leases and keeps the leases with the newest expiry. Then it removes reservations. The view then shows a notice, for example "This list shows {count} of {total} leases. To find the others, use the DHCP console on the server."

The schema also has fixed limits, for example 500 IPv4 scopes, 10000 leases and 2000 reservations in a scope. The portal refuses data above these limits.

## Codes

| Code | Meaning |
| --- | --- |
| `PLUGIN_DHCP_READ_COMPLETED` | The read is complete. The job result has the number of scopes and leases. |
| `PLUGIN_DHCP_SERVICE_STOPPED` | The DHCP Server service is stopped. The plugin sends the server facts without scopes. The message tells the user to start the service in **Management → Services**. |
| `PLUGIN_DHCP_NOT_INSTALLED` | The DHCP Server role is not installed on the device. The message tells the user to install the role in **Management → Roles & features**, or to remove the plugin. |
| `PLUGIN_DHCP_ACCESS_DENIED` | The DHCP API refused the access. The message tells the user to check the members of the groups DHCP Administrators and DHCP Users on the server. |
| `PLUGIN_DHCP_READ_FAILED` | The DHCP API gave another error. The job result has the error number. |
| `PLUGIN_DHCP_CHANGED` | The change is complete. The plugin sends the new read. |
| `PLUGIN_DHCP_CHANGED_NOT_READ` | The change is complete, but the read after it failed. The message tells the user to select **Read again** to see the change. |
| `PLUGIN_DHCP_INVALID_CHANGE` | The plugin did not make the change because a value is not valid. The job result names the field. |
| `PLUGIN_DHCP_OBJECT_EXISTS` | The object exists on the server already. The message tells the user to select **Read again** to see the current state. |
| `PLUGIN_DHCP_OBJECT_MISSING` | The object does not exist on the server. The message tells the user to select **Read again** to see the current state. |
| `PLUGIN_DHCP_IN_FAILOVER` | The scope is part of a failover relationship. The message tells the user to remove the scope from the relationship on the **Failover** tab, and to try again. |
| `PLUGIN_DHCP_SECRET_MISSING` | The shared secret did not get to the plugin. The message tells the user to update the agent on the device to 4.17.0 or later. |
| `PLUGIN_DHCP_CHANGE_FAILED` | The DHCP server refused the change. The job result has the error number. |

For the codes of the broker, for example `AGENT_PLUGIN_TIMEOUT`, refer to [Crash behaviour](agent-plugins.md#crash-behaviour).

## Checks

`node tests/ui/devices/dhcp-view.mjs`, `node tests/lib/plugin-data.mjs`, `node tests/ui/devices/extensions-view.mjs`, `node tests/lib/dhcp-changes.mjs`, `node tests/api/dhcp-manage.mjs` and `node tests/lib/dhcp-alerts.mjs`. On Windows, `ServerDesk.Plugin.Dhcp.exe --self-test`.
