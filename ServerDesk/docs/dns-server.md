# DNS server

The DNS plugin shows the DNS server of a Windows server in the portal. You can also change the DNS server from the portal: zones, records, conditional forwarders, forwarders, aging and scavenging, and the cache. For the plugin itself, refer to [Agent plugins](agent-plugins.md).

## Open the view

1. Install the DNS extension on the device. Refer to [Install and remove](agent-plugins.md#install-and-remove).
2. Open the device on its area **Extensions**.
3. In the row **DNS extension** of **Installed**, select **Open DNS**.

The link is `#device/<id>/extensions/dns`. **Open DNS** selects the tab **DNS server** of **Extensions**. Select the tab **Overview** to go back.

When you open a zone, the link is `#device/<id>/extensions/dns/<zone>`. A reload opens this zone again when the zone list has loaded. If the zone is not in the list, the view shows the zone list and the address bar keeps the link. The command palette has the item **New DNS zone** for a device whose plugin can create zones. It opens the view with the form **New zone**.

You need the right `dns.read` (**View DNS**) on the device. Without it, the view shows "No access to the DNS server".

## What the view shows

The head shows the line "{server} · Read {time}". **Read again** starts the job **Read DNS server** at once. The menu **More DNS actions** has **Clear cache** and **Scavenge stale records now**. When you cannot change the DNS server, one notice tells you why and that you can still read it.

Five values show at the top:

- **Zones**: the number of zones, with the forward and reverse lookup zones.
- **Stored in AD**: the zones that Active Directory stores, of all zones.
- **Records**: the records in the primary zones.
- **Forwarders**: the number of forwarders, and whether the server uses the root hints when they fail.
- **Scavenging**: on or off, with the interval.

The card **Server** shows the name, the version, whether the server is a domain controller and the addresses that it listens on.

The tabs below show the details:

| Tab | Content |
| --- | --- |
| **Zones** | Zone, type, storage, dynamic updates, records and aging. You can search and filter by forward and reverse lookup. Zones that Windows created have the tag "Created by Windows". |
| **Conditional forwarders** | DNS domain, primary servers, storage and timeout |
| **Forwarders** | The forwarders in query order, the timeout and the root hints |
| **Aging and scavenging** | Automatic scavenging, its interval and last run, and the default aging of new zones |

The storage column shows **AD · Forest**, **AD · Domain**, **AD · All domain controllers**, **AD · {partition}** for a custom directory partition, or **File**.

When the DNS Server service is stopped, the view shows a warning with **Open Services**. Clients then get no answers from this server.

### Zone page

Select a zone to open its page. **All zones** goes back to the list. The card **Zone settings** shows the type, the storage and replication, the file, dynamic updates, zone transfers, notify, the primary servers and aging.

The server read does not contain the records. Select **Read records** to start the job **Read DNS zone** for this zone. Only one of these jobs can be open for each zone. The records table then shows name, type, data, TTL and timestamp, with 100 records on each page. A static record shows "Static" as its timestamp. The toolbar has the search and the filter **Type**.

## Change the DNS server

Each change is a job **Extension job** with the operation as its target. The plugin makes the change on the local DNS server and then reads it again. The job dock shows the progress. While change jobs of the device are open, the head shows, for example, "2 changes running". When the last one ends, the view loads the new data in place.

### The changes

| Place | Changes |
| --- | --- |
| Zones | **New zone**: a primary, secondary or stub zone, for forward or reverse lookup. The row menu has **Open zone**, **Edit zone settings**, **Transfer from primary** (secondary and stub zones) and **Delete zone**. |
| Zone page | **Edit zone settings**, **Add record**. The row menu has **Edit record** and **Delete record**. Only records that you can change have a checkbox: the SOA record and other types have none. The selection bar below the table shows "{count} selected", **Delete records** and **Clear selection**. You can delete at most 100 at one time. |
| Conditional forwarders | **New conditional forwarder**, **Edit conditional forwarder**, **Delete conditional forwarder** |
| Forwarders | **Edit forwarders**: the servers in query order, the timeout and the root hints |
| Aging and scavenging | **Edit scavenging**, **Scavenge now** |
| Head menu | **Clear cache**, **Scavenge stale records now** |

A record can have the type A, AAAA, CNAME, MX, PTR, TXT, SRV or NS. For a reverse lookup zone, type the network ID, for example `10.20.30`. The form shows the zone name `30.20.10.in-addr.arpa` while you type. An IPv6 network ID, for example `2001:db8:1::/48`, gives a zone under `ip6.arpa`.

A create or an edit opens a drawer with a form. The form marks a value that does not fit this server under its field. Examples are a duplicate record or a CNAME on a name with other records. An unchanged edit says "No changes". The SOA record and records of other types, for example CAA, are read-only. Records of a secondary or stub zone come from its primary servers, so you cannot change them.

Every change asks for a confirmation with the device, the change, the object and the AD account. Deletes of zones, records and conditional forwarders use the danger button. **Scavenge now** is blocked while scavenging is off.

### Gates

A change needs all of these:

- the right `dns.manage` (**Manage DNS**) on the device;
- the device is online and has the DNS plugin with this operation;
- an MFA session, as for the other changing jobs;
- agent 4.21.2 or later and a sign-in with your AD account for the domain of the device, see below;
- Management mode, and no maintenance;
- a read of the DNS server in the portal, with the service running;
- room in the job queue of the device (20 jobs).

The controls stay visible when a gate does not hold, and they show the first reason. When the DNS Server service is stopped, the reason is "The DNS Server service is stopped. Start the service in Management → Services.". Sample devices show "Not available for sample devices.". The server checks each gate again and writes nothing when one does not hold. Each job gets one row in the device audit with the English job label and the AD account, for example "Add DNS record".

### Replication through Active Directory

A zone or a conditional forwarder that Active Directory stores replicates to the other DNS servers of its replication scope. The confirmation of such a change says to which servers it replicates:

| Replication scope | The change goes to |
| --- | --- |
| Forest | All DNS servers in the forest |
| Domain | All DNS servers in the domain |
| All domain controllers | All domain controllers in the domain |
| Custom | All DNS servers in the directory partition |

The portal does not queue a job on the other servers. Their views show the change after their next read. A change to a file zone, to the forwarders, to scavenging or to the cache applies only to the device. The confirmation says so.

Only a domain controller can store a zone in Active Directory. A secondary zone cannot be stored there. The delete of a zone in Active Directory deletes it from Active Directory, as the DNS Manager does.

### AD account

A change runs with your AD account, not as the SYSTEM account of the agent. The DNS server checks your rights, and the Windows Security log names you. For the design, refer to [AD sign-in for plugin changes](plugin-ad-sign-in.md).

- The first change on a server opens the dialog "Sign in to {domain}" before the confirmation.
- The head of the view shows the account and the end of the sign-in.
- The confirmation shows the line **AD account**.

The account needs rights on the DNS server: add it to the group **DnsAdmins** of the domain. Without these rights, a change fails with "The server refused this change for CORP\anna…". The reads do not need the sign-in, because they run as SYSTEM.

## Fleet card

The report **Inventory → Extensions** of **All devices**, a group or a customer shows the card **DNS zones**. It has one row for each zone of each DNS server with the plugin. It shows server, zone, type, storage, dynamic updates, records and the time of the read. The zones that Windows created do not show. Select a row to open the DNS view of that device.

The card shows only the devices where you have `dns.read`. Without this right on any device, the card does not show. The role filter and the search of the tab also filter the card, by device name or zone name.

## Alert rule

The rule **DNS service stopped** opens an issue when the last read of the plugin reports the DNS Server service as stopped. It uses only reads of the last 60 minutes. The issue links to the DNS view. For the rules, refer to [Alert rules](alert-rules.md#the-rules-and-their-defaults).

## Data sources

The plugin reads and changes the local DNS server through the DNS WMI providers. It uses no network connection, no LDAP and no PowerShell.

| Data | WMI |
| --- | --- |
| Server, forwarders and scavenging | `root\MicrosoftDNS`: `MicrosoftDNS_Server` |
| Zones and conditional forwarders | `root\MicrosoftDNS`: `MicrosoftDNS_Zone`, and the zones that only `root\Microsoft\Windows\DNS`: `DnsServerZone` lists |
| Replication scope and directory partition | `root\Microsoft\Windows\DNS`: `DnsServerZone` |
| Records | `root\MicrosoftDNS`: `MicrosoftDNS_ResourceRecord` and the classes of each type, for example `MicrosoftDNS_AType` |
| Cache | `root\MicrosoftDNS`: `MicrosoftDNS_Cache` |
| New zone | `root\Microsoft\Windows\DNS`: the static methods `AddByFileForwardLookupZone`, `AddByADForwardLookupZone` and the `ReverseLookupZone` methods of `PS_DnsServerPrimaryZone`, `PS_DnsServerSecondaryZone` and `PS_DnsServerStubZone` |
| New zone, fallback | `root\MicrosoftDNS`: `MicrosoftDNS_Zone.CreateZone` |
| New conditional forwarder | `root\MicrosoftDNS`: `MicrosoftDNS_Zone.CreateZone` |
| Delete a zone that only `DnsServerZone` lists | `root\Microsoft\Windows\DNS`: the static method `Remove` of `PS_DnsServerZone` |

The DNS plugin 1.0.4 creates a primary, secondary or stub zone with the modern classes first. These are the classes of `Add-DnsServerPrimaryZone`, `Add-DnsServerSecondaryZone` and `Add-DnsServerStubZone`. The plugin gives the name or the network ID, the zone file or the replication scope, and the primary servers as method parameters.

When the modern call fails, the plugin tries `MicrosoftDNS_Zone.CreateZone` one time as the fallback. It does not try the fallback when the DNS server refused the change, or when the zone exists. A conditional forwarder uses only `MicrosoftDNS_Zone.CreateZone`.

On some servers, `MicrosoftDNS_Zone` does not list all zones. The zone list then also shows the zones that only `DnsServerZone` lists. To delete such a zone, the plugin calls `PS_DnsServerZone.Remove`. It also calls it when the delete through `MicrosoftDNS_Zone` fails with `0x80041001`.

When a zone create fails, the plugin reads the zones again. If the zone exists with the requested type, the change is complete.

The service state comes from the service `DNS`. A record edit deletes the old record and adds the new one in one job. When the add fails, the plugin adds the old record again.

## Reads

The broker reads the DNS server every 15 minutes under the signed plugin policy. For the details, refer to [Signed collection](agent-plugins.md#signed-collection). This read contains the server, the zones and their record counts, but no records. The records of a zone come only from **Read records**. Both reads run as SYSTEM, also in ReadOnly mode.

When a read fails, the toast shows the message of the portal for that failure, or "The DNS server could not be read. Try again.". It never shows an error text of Windows or of the agent.

The DNS plugin 1.0.1 needs agent 4.21.2 or later. With an older agent, the read data did not reach the portal.

After a record change or **Transfer from primary**, the plugin sends the records of that zone. After every other change, it sends the server read. The record counts in the zone list update at the next server read.

The portal keeps the newest server read of each device and the newest records of each zone. When a zone is gone from a complete server read, the portal deletes its records. The removal of the plugin or of the device deletes all DNS data.

## Limits

- The data of one read have at most 2 MiB. When a zone has more records, the plugin cuts them. The zone page then shows "Showing {shown} of {total} records."
- When the server read is too large, the plugin cuts zones. The portal then keeps the records of all zones.
- The plugin counts the records of the primary zones up to 200,000 records. After this, the zone list shows no count for the next zones.
- The plugin does not create the PTR record together with an A or AAAA record, as the DNS Manager can.
- DNSSEC, trust anchors, DNS policies, response rate limiting, root hints, interfaces, logging and the global query block list cannot be changed.
- You cannot pause a zone or change its type. Zones in a custom directory partition show and can be changed, but you cannot create them.
- The rule **DNS service stopped** is the only DNS alert. Failed zone transfers give no alert.

## Sample devices

In demo mode, SRV-DC01 has the DNS plugin 1.0.1. Its sample data have the zones `corp.example`, `_msdcs.corp.example`, `20.10.in-addr.arpa` and `partner.example`, and the conditional forwarder `branch.example`. The zone `corp.example` and the reverse zone have sample records. Every change is blocked with "Not available for sample devices.".

## Codes

| Code | Meaning |
| --- | --- |
| `PLUGIN_DNS_READ_COMPLETED` | The server read is complete. The job result has the number of zones. |
| `PLUGIN_DNS_ZONE_READ_COMPLETED` | The zone read is complete. The job result has the zone and the number of records. |
| `PLUGIN_DNS_SERVICE_STOPPED` | The DNS Server service is stopped. A read sends the server facts without zones. The message tells the user to start the service in **Management → Services**. |
| `PLUGIN_DNS_NOT_INSTALLED` | The DNS Server role is not installed on the device. The message tells the user to install the role in **Management → Roles & features**, or to remove the plugin. |
| `PLUGIN_DNS_READ_FAILED` | WMI gave an error. The job result has the error number of the DNS server when WMI gives one, else the WMI error number. |
| `PLUGIN_DNS_ACCESS_DENIED` | WMI refused the access. The message tells the user to check the members of the group DnsAdmins on the server. In a change with an AD account, the agent shows `AGENT_PLUGIN_ACCOUNT_DENIED`. |
| `PLUGIN_DNS_CHANGED` | The change is complete. The plugin sends the new read. |
| `PLUGIN_DNS_CHANGED_NOT_READ` | The change is complete, but the read after it failed. The message tells the user to select **Read again** to see the change. |
| `PLUGIN_DNS_INVALID_CHANGE` | The plugin did not make the change because a value is not valid. The job result names the field. |
| `PLUGIN_DNS_OBJECT_EXISTS` | The object exists on the server already. The message tells the user to select **Read again** to see the current state. |
| `PLUGIN_DNS_OBJECT_MISSING` | The object does not exist on the server. The message tells the user to select **Read again** to see the current state. |
| `PLUGIN_DNS_NOT_DOMAIN_CONTROLLER` | The server is not a domain controller, so it cannot store zones in Active Directory. The message tells the user to store the zone in a file on the server. |
| `PLUGIN_DNS_CHANGE_FAILED` | The DNS server refused the change. The job result has the error number of the DNS server when WMI gives one, else the WMI error number. |
| `PLUGIN_DNS_CHANGE_FAILED_DETAIL` | The DNS server refused the change, and Windows gave an error text. The message shows the error number and the text of Windows. |

A failed change has these values in the job result: `error`, `call` (the failed WMI step), `hresult`, `provider`, `operation`, `detail` (the text of Windows) and `attempts` (each WMI call that the plugin tried). When the plugin used a wrong class, method or parameter name, `signature` names the methods or parameters of the class. A missing `provider`, `operation` or `detail` is `-`.

For the codes of the broker, for example `AGENT_PLUGIN_TIMEOUT`, refer to [Crash behaviour](agent-plugins.md#crash-behaviour).

## Checks

`node tests/ui/devices/dns-view.mjs`, `node tests/lib/dns-changes.mjs`, `node tests/api/dns-manage.mjs`, `node tests/lib/dns-data.mjs` and `node tests/lib/dns-alerts.mjs`. On Windows, `ServerDesk.Plugin.Dns.exe --self-test`.
