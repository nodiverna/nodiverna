# Extensions

The portal detects which Windows server runs which server role and which known server product. Examples are AD DS, DHCP, DNS, IIS, SQL Server and Veeam. For some of these roles, an extension of the agent lets you manage the role in the portal. At this time, the DHCP extension and the DNS extension are available.

The portal UI calls an agent plugin an extension. The technical terms stay: the plugin protocol, the `plugins\` folder of the agent, the job kinds `plugin-install`, `plugin-remove` and `plugin-job`, the right `plugins.manage` and `/api/plugins`. Refer to [Agent plugins](agent-plugins.md).

The detection uses only data that the agent already sends. You do not need a new agent version. Only the extensions need agent 4.16.0 or later.

There are three places in the portal:

| Place | Link | Content |
|---|---|---|
| Device area **Extensions** | `#device/<id>/extensions` | What the portal detected on this device, which extensions it offers and which are installed |
| Scope tab **Inventory → Extensions** | `#devices/inventory/extensions` | All detections and extensions of the devices in the scope, with the rollout |
| Settings page **Extensions** | `#settings/extensions` | The imported extension releases and their rollout |

## Source data

The portal uses two sources:

- The roles and features of the device (`snapshot.features`). The agent sends the ServerManager name (`UniqueName`) of each role, role service and feature. The **Roles & features** area shows the same data. See [Roles and features](roles-features.md).
- The software inventory of the device (table `device_software`). The portal compares the normalized program name with the software catalog below.

`GET /api/console` reads the software matches of all visible devices in one statement. Each device with a match gets the field `serverSoftware`. The device right `view` is sufficient. The customer boundary applies as for all device data.

## Detection catalog

The portal keeps one detection catalog in `lib/extensions.ts`. It has 22 entries: the 16 roles of the [role catalog](#role-catalog), then the 6 products of the [software catalog](#software-catalog). Each entry has these fields:

| Field | Value |
|---|---|
| `id` | The detection id, for example `dhcp` or `sql-server`. A plugin manifest names it as `target`. |
| `kind` | `role` or `feature`: the portal compares `names` with the installed roles and features. `software`: the portal compares the software inventory with `pattern`. |
| `devices` | `server`: the entry counts only on a Windows Server. `any`: the entry counts on each device with a snapshot. All entries are `server` at this time. |
| `names` | Only for `role` and `feature`: the ServerManager names. |
| `prefixes`, `pattern` | Only for `software`: the prefixes for the database filter and the exact pattern. |
| `label`, `icon` | The message key of the name and the icon. |

The portal shows the detected entries in catalog order. In the device area, roles come first, then features, then products. In each kind, the entries with an extension come first.

## Extension catalog

An extension is an agent plugin. The extension catalog in `lib/extensions.ts` links each extension to the detection id that it extends (its target):

| Extension | Target |
|---|---|
| `dhcp` | `dhcp` (DHCP Server) |
| `dns` | `dns` (DNS Server) |

Each target must be an id of the detection catalog. A detected entry without an extension shows **No extension yet**. `tests/lib/extensions.mjs` checks the two catalogs.

## Windows Server only

All entries of the detection catalog have `devices` `server`. Thus the portal shows roles and products only for a device that reports a Windows Server operating system. A Windows 11 device with Veeam Agent or SQL Server Express does not get the area **Extensions**. Windows clients send other feature names, and the portal does not examine them.

`FileAndStorage-Services` and `Storage-Services` are installed on each Windows Server by default. These two names never make an entry.

## Role catalog

A role shows when at least one of its names is installed. The comparison ignores upper and lower case. The portal shows the roles in this order:

| Role | ServerManager names | Extension |
|---|---|---|
| Active Directory Domain Services | `AD-Domain-Services` | none |
| DHCP Server | `DHCP` | `dhcp` |
| DNS Server | `DNS` | `dns` |
| File Server | `FS-FileServer` | none |
| DFS Namespaces and Replication | `FS-DFS-Namespace`, `FS-DFS-Replication` | none |
| Print and Document Services | `Print-Services` | none |
| Web Server (IIS) | `Web-Server` | none |
| Hyper-V | `Hyper-V` | none |
| Remote Desktop Services | `Remote-Desktop-Services`, `RDS-RD-Server`, `RDS-Connection-Broker`, `RDS-Gateway`, `RDS-Licensing`, `RDS-Web-Access` | none |
| Windows Server Update Services | `UpdateServices` | none |
| Active Directory Certificate Services | `AD-Certificate` | none |
| Active Directory Federation Services | `ADFS-Federation` | none |
| Network Policy and Access Services | `NPAS` | none |
| Remote Access | `RemoteAccess` | none |
| Windows Deployment Services | `WDS` | none |
| Failover Clustering | `Failover-Clustering` | none |

A role has no version of its own. The version column shows the operating system, for example "Part of Windows Server 2022".

## Software catalog

The portal compares the normalized program name (lower case, without architecture markers and without a version at the end). The pattern must match the full product entry. Consoles, setup programs, shared files and language packs do not match.

| Product | Pattern on the normalized name |
|---|---|
| Microsoft SQL Server | `microsoft sql server 2022`, `sql server 2019 database engine services` and the same for 2008 to 2025 |
| Microsoft Exchange Server | `microsoft exchange server 2010`, 2013, 2016, 2019 or `subscription edition`, followed by other words, but not a language pack |
| Microsoft SharePoint Server | `microsoft sharepoint server 2013`, 2016, 2019 or `subscription edition`, followed by other words, but not a language pack |
| Veeam Backup & Replication | `veeam backup & replication` exactly |
| Veeam Agent for Microsoft Windows | `veeam agent for microsoft windows` exactly |
| Microsoft Entra Connect | `microsoft entra connect`, `microsoft entra connect sync` or `microsoft azure ad connect` |

The exact expressions are in `lib/extensions.ts`. Each product has prefixes for the database filter (`LIKE 'prefix%'`). The prefixes must cover each name that the pattern matches. `tests/lib/extensions.mjs` checks this.

A device shows one entry for each product. The version is the highest version of the matched programs. Programs without a version do not count for the version. The detail line shows up to five matched program names.

## Device area

The device page shows the area **Extensions** only when the portal detects a role or a product. Its link is `#device/<id>/extensions`. The area is before **Monitoring** and has the key `9`. The keys `1` to `8` of the other areas do not change. A link to the area of a device without a detection opens the **Overview**.

The area has the subareas **Overview**, **DHCP server** and **DNS server**. **DHCP server** and **DNS server** show only on a device with that role. Their links are `#device/<id>/extensions/dhcp` and `#device/<id>/extensions/dns`. A zone of the DNS server has the link `#device/<id>/extensions/dns/<zone>`. A link to a subarea without its role opens the **Overview**.

The **Overview** shows the counts of its three sections at the top, for example "1 available · 1 installed · 2 without extension". It shows a section only when the section has entries. In each section, roles come first, then features, then products.

1. **Available for this device**: one card for each extension that the portal offers for a detected role. The card shows what the extension does and its release, for example "Release 1.1.0". Select **Install extension** to install it.
2. **Installed**: a table of the extensions that the device has, also while an install runs. It shows the extension, its version and its state.
3. **Detected, no extension yet**: a table of the other detected roles and products. It shows the name, the kind, the version and the source names.

A card or a menu entry that you cannot use stays visible and tells you why. The reasons come in this order:

1. The extension installs now or waits for the agent.
2. No release of the extension is imported.
3. Sample devices, the right **Manage extensions**, an offline device, an old agent, and another extension job.

Each row of the two tables has one menu **Actions for {name}**. The menu of an installed extension shows the entries in this order:

1. **Open DHCP** or **Open DNS**, when that extension is installed.
2. **Repair extension**, when the extension is damaged.
3. **Open in Roles & features** for a role, or **Open in Software** for a product.
4. **Remove extension**, when the extension is installed. It is the last entry, after a separator.

A row of **Detected, no extension yet** has only the third entry. A click on a row opens the DHCP or DNS server when that extension is installed. Otherwise it opens **Management → Roles & features** for a role and **Software → Programs** for a product.

When you install an extension, its card moves to **Installed**. The row shows **Installing…**, then **Installed · {version}** or, until the agent reports the extension, **Installed · waiting for the agent**. When an extension job ends, the console loads the data again on each page. For the install, repair and removal, refer to [Install and remove](agent-plugins.md#install-and-remove). When you cannot manage extensions on the device, one notice tells you why. When the device is offline, the area shows the last known data.

## Scope tab

**All devices**, a group, a customer and both **Ungrouped** scopes have the report **Extensions** in the tab **Inventory**. The link is `#devices/inventory/extensions`, or for example `#devices/group/<id>/inventory/extensions`.

At the top, the tab shows one card for each extension that a device in the scope detects. The cards are in the order of the extension catalog. Each card shows:

- The release, for example "Release 1.1.0", or "No release imported".
- A bar with the coverage, for example "Installed on 2 of 3 devices". The count is the devices that detect the role.
- **Offered**: the devices that can install the extension. **Update available**: the devices with an older version. **Damaged**: the devices with a damaged extension, only when there are some.
- **Roll out**: it opens the rollout of the release for the devices in the scope. Refer to [Rollout with pilot devices](agent-plugins.md#rollout-with-pilot-devices).

Below the cards, the table shows one row for each device and detected role or product. To filter the table, use the controls above it:

1. Type a device name in the search field.
2. Select a state: **All**, **Installed**, **Offered** or **No extension**. Each state shows its count.
3. Select a detected role or product in the list. **Everything detected** shows all of them.

The filters work together. The column **Extension** shows the state of the extension, or **Extension available**, **Extension available later** or **No extension yet**. The menu of a row has **Open {device}**, **Install extension** when the extension is available, and **Open DHCP** or **Open DNS** when that extension is installed. A click on a row opens the device on **Extensions**, or its DHCP or DNS server when that extension is installed.

When no device in the scope has a detection, the tab shows "Nothing detected" and **Show devices**. When the filters hide all rows, **Reset filters** clears the search, the state and the detection.

Below the table, the cards **DHCP scope usage** and **DNS zones** show the data of their extensions. Each card shows only when its role is in the scope and you may read its data. A filter on another detection hides the card. Refer to [Fleet card](dhcp-server.md#fleet-card) and [Fleet card](dns-server.md#fleet-card).

## Settings page

The page **Settings → Extensions** (`#settings/extensions`) is for Owners. It is in the group **Agents**, after **Agent releases**. It shows the table **Extension releases** with the columns **Extension**, **Version**, **Minimum agent**, **Installed on**, **Imported** and **Roll out**.

The release source on **Settings → Agent releases** imports the extension releases. Thus the page has no own import. When no release is imported, **Open Agent releases** opens that page. **Roll out** opens the rollout of a release. Refer to [Rollout with pilot devices](agent-plugins.md#rollout-with-pilot-devices).

## States

Each entry shows the state of its extension. The portal takes the state from the extensions that the agent reports, from the jobs and from the imported releases.

| State | Meaning | Action |
| --- | --- | --- |
| **Installed · {version}** | The agent reports the extension as ready. | **Open DHCP** or **Open DNS** and **Remove extension** in the row menu |
| **Installing…** or **Repairing…** | An install job of the extension is pending or running. | None until the job ends |
| **Installed · waiting for the agent** | The install job succeeded, but the agent did not report the extension yet. The row shows the reason below the state. | None until the agent reports the extension |
| **Extension damaged** | The agent reports the extension, but a check failed. The tooltip shows the reason. | **Repair extension** in the row menu |
| **Extension available** | The portal has an active release of the extension, but the device does not have it. | **Install extension** |
| **Extension available later** | The role has an extension, but no release of it is imported. | None |
| **No extension yet** | No extension is planned at this time. | None |

## Rights

The rights **Manage extensions** (`plugins.manage`), **View DHCP**, **Manage DHCP**, **View DNS** and **Manage DNS** are in the category **Extensions** of the role editor. Refer to [Own login and RBAC](local-identity-rbac.md).

## Checks

`node tests/lib/extensions.mjs`, `node tests/lib/server-role-software.mjs`, `node tests/ui/devices/extensions-view.mjs`, `node tests/ui/devices/device-extensions-panel.mjs`, `node tests/ui/settings/extension-releases-view.mjs`, `node tests/ui/devices/extension-copy.mjs`, `node tests/ui/devices/dhcp-view.mjs` and `node tests/ui/devices/dns-view.mjs`.
