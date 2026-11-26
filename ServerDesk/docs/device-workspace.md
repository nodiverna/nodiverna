# Device areas

The device navigation divides inventory, troubleshooting, changes and interactive work. The top bar contains nine areas, and ten on a device with a server role. The tools in these areas keep their own permissions and confirmations.

| Area | Content |
| --- | --- |
| **Overview** | Health line with the most urgent issue and its link, current values, utilization history, protection, drives and system facts |
| **Hardware** | CPU, RAM modules and slots, GPU, physical disks, drives, network adapters, system, mainboard and BIOS |
| **Software** | Programs, drivers, certificates and autostart entries. These lists are read-only. |
| **Diagnostics** | Processes, signed-in sessions, events and connections |
| **Management** | Services, Windows Update, volume actions, network configuration with firewall rules, accounts, Windows roles, scheduled tasks, Defender and system settings |
| **Remote access** | File browser, terminal and Remote Desktop |
| **Automation** | Runbooks, desired configuration and configuration drift |
| **History** | Device jobs and permitted device access |
| **Extensions** | The detected Windows roles and server products with the agent extensions that the portal offers or that are installed, and the DHCP and DNS servers. This area shows only when the portal detects a server role or product. |
| **Monitoring** | Open and closed alarms, the alert rules of the device and the notification rules that reach it |
| **Configuration** | Permissions of the device. This area shows only with the right **Manage role assignments**. |

The keys 1 to 9 open the first nine areas in this sequence. **Monitoring** and **Configuration** have no key. On a device without **Extensions**, the key 9 does nothing. The keys also work while the assistant panel is open, but not while you type in it.

**Remote Desktop** stays in **Remote access** while it is paused. Its tab shows the tag **Paused**.

**Hardware** shows the information from the last reported inventory. Volume actions stay under **Management**, because they can change the state. The physical disk view and the existing drive letters are separate data sources. ServerDesk does not connect them by their sequence. The reported disk health is a provider state and not a long-term SMART test.

The previous deep links `files`, `terminal`, `rdp`, `runbooks`, `desired` and `drift` stay valid and open the applicable subarea. The new main links `remote` and `automation` open files and runbooks. Breadcrumbs show the main areas and subareas. The CPU, RAM and GPU cards in the overview open the applicable hardware area. Internally, GPU cards select the exact adapter ID, but the link contains only their position.

The terminal does not start a session when you open it. It starts or resumes your PowerShell session only after you select **Connect**. If a step-up confirmation is necessary, the dialog opens after **Connect**.

If you cannot use an area or a subarea, it shows the reason. The reason is a sample device, a missing right, the agent version, **Management** mode that is off, or an offline device.

A button that you cannot use stays visible. When you move the pointer to it or go to it with the keyboard, it shows the reason. A screen reader also reads this reason. If a subarea of **Management** blocks all of its changes, one notice shows the reason and tells you what you can still do. An example is "Not available for sample devices. You can still read the network settings."

A menu entry that you cannot use also stays visible. The arrow keys move to it, and the screen reader reads its name and its reason. The reason shows below the name. If you select the entry, nothing happens and the menu stays open.

**Management → Accounts** shows the number of local users, the deactivated users, the members of the local Administrators group and the local groups at the top. Select **Deactivated** to see only the deactivated users. Each user has one menu **Actions for {name}** with **Change user…**, **Reset password…** and **Delete user…**.

**Create user** is above the list. **Add member** and **Remove member** are on the card of the local groups. Each action opens a form and then a confirmation. Delete goes directly to the confirmation.

**Management → Roles & features** has the tabs **Roles** and **Features**. Each tab shows the installed roles or features first and the catalog below them. A row tells how many role services or subfeatures are installed, for example "0 of 2 role services installed". **Install** and **Remove** open a form and then a confirmation.

**Management → System** is one page. It shows the restart state, the last start and the page file use at the top. Below them are the sections **Page file**, **Restart and shut down**, **Scheduled maintenance** and **Computer & domain**.

**Management → Network** shows the network adapters and the network diagnostics. The last card is **Firewall rules**. You can search the rules, enable or disable a rule, and select **Create rule**.

**Management → Scheduled tasks** shows the scheduled tasks of Windows with a search. You can enable or disable a task after a confirmation. The task **Scheduled power** of ServerDesk has **Open scheduling** instead. It opens **Management → System** and moves to **Scheduled maintenance**.

**Automation → Runbooks** has the tabs **Runbooks**, **Runs** and **Schedules**. A tab shows its count only after the data loads. Each runbook has one menu **Actions for {name}** with **Prepare run…**, **New version…** and **Delete runbook…**. Select a row to prepare a run. **Create runbook** is above the tabs.

**Automation → Desired State** shows the assignment of the device with its compliance state. **Check** and **Apply** open a confirmation with approval switches. The confirm button stays blocked until you turn on the necessary switches.

**Automation → Configuration drift** shows the current state and the number of changes since the baseline at the top. Select a change to see its diff. **Accept as baseline** shows the reason when you cannot use it, for example an incomplete scan.

If you cannot use an automation subarea, it shows one reason. A sample device shows "Not available for sample devices." A missing right shows a sentence about the right. The subarea sends no request then.

**History** has the tabs **Jobs** and **Device access**. Each tab shows its count. Each table has its search in the bar above it. If the search finds nothing, select **Clear search** or **Reset filters**.

**History → Jobs** shows one row for each job: the state, the job, the account and the time. Below the name of the job, a second line shows its object, for example the service, the DHCP scope or the path. Above more than one device, the table also shows the device. The search finds the job, the object, the account, the state and the device.

Each row has the menu **Actions for {job}** with **Show details**. A waiting job also has **Cancel job**. The table shows 25 rows on each page.

**History → Device access** shows the time, the account, the action and the target. Above more than one device, it also shows the device. The action shows a label in your language and below it the action code, for example `tag.set`. The target shows a readable value, for example a device name instead of a device ID.

Use **Action type** to show only one type of action. **Export as CSV** exports the rows that you see. The table shows the newest 200 entries.

Select a row in **History → Device access** to open its details. The details show the time, the account, the device, the action, the action code and the target. A target with more values shows them under **Details**. **Stored target** shows the target as the portal saved it.

**Extensions** has the tabs **Overview**, **DHCP server** and **DNS server**. **DHCP server** and **DNS server** show only when the device has that role. **Open DHCP** and **Open DNS** on the overview select the applicable tab. **Open in Software** opens **Software**. Refer to [Extensions](extensions.md).

**Monitoring** has the tabs **Alarms**, **Alert rules** and **Notification rules**. The tab of the area shows the number of open alarms in the color of the most severe level.

**Monitoring → Alarms** starts with two summary tiles: the alert rules that are on, and the notification rules that can send. Below them, the table shows the open alarms first, then the closed alarms.

**Monitoring → Alert rules** shows one table of the rules. **Default** and **On** are muted, so the changed values and the higher origins stand out. The rule description is in the edit drawer.

**Monitoring → Notification rules** shows the rules that reach the device. You cannot change them on the device. Refer to [Notifications](notifications.md#notification-rules).

**Configuration** shows **Permissions**: the **Direct** card first and the **Inherited** card below it. You see **Configuration** only with the right **Manage role assignments**.

Each area with subareas shows them as a row of tabs below the area tabs. If an area has only one subarea, it shows no row. If the row is too narrow, the last subareas move into **More**. When the active subarea is in **More**, **More** shows its name. Each subarea tab is a link, so you can open it in a new browser tab.

## Job details

Select a job in **History → Jobs** or in the job bar to open its details. The top of the details shows the state and the message of the agent. Below it, you see the device, the account, the start time, the end time and the duration.

**Input** shows what the job got, for example the service name or the DHCP scope. A script from the assistant shows the full script and its timeout. The portal never keeps a password or another secret. Jobs from before this version show that their input was not kept.

**Output** shows the result of the agent. It opens by itself when the job failed. A script shows its output, its error output and its exit code. The portal shows the first 64 KiB of an output.

**Open {area}** opens the area of the device that the job changed, for example **DHCP server** for a DHCP scope. A script from the assistant opens the assistant.

## Windows Update

The head of **Management › Windows Update** shows one status sentence. It tells you that a search or an installation runs, or the time of the last search. After a new search, it tells you that the list arrives with the next agent report. Before the first search, it says that no search is complete yet.

The tiles **Available**, **Critical & important** and **Restart reported** show only after a search. Before a search, the empty table offers **Search for updates**. **Install all available** is a secondary button. Until a search lists updates, it tells you: "Search for updates first."

Select updates with their checkboxes, or the shown updates with the head checkbox. You can select up to 50 updates at once. After that, the other checkboxes tell you the limit. The selection bar below the table installs the selected updates. A notice shows only while a job runs, or when the last job failed or was cancelled.

## Links

The link of a device starts with `#device/<id>`. It also contains the area and the subarea, for example `#device/<id>/diagnostics/events`, `#device/<id>/management/updates`, `#device/<id>/hardware/cpu` and `#device/<id>/hardware/gpu/2`.

| Area | Links |
| --- | --- |
| **Software** | `#device/<id>/software` (**Programs**), `#device/<id>/software/drivers`, `#device/<id>/software/certificates` and `#device/<id>/software/autostart` |
| **Management** | `#device/<id>/management` (**Services**) to `#device/<id>/management/system`, with `#device/<id>/management/tasks` for **Scheduled tasks** |
| **Remote access** | `#device/<id>/remote`, `#device/<id>/remote/terminal` and `#device/<id>/remote/rdp` |
| **Automation** | `#device/<id>/automation`, `#device/<id>/automation/desired` and `#device/<id>/automation/drift` |
| **History** | `#device/<id>/history` and `#device/<id>/history/access` |
| **Extensions** | `#device/<id>/extensions`, `#device/<id>/extensions/dhcp` and `#device/<id>/extensions/dns` |
| **Monitoring** | `#device/<id>/monitoring` (**Alarms**), `#device/<id>/monitoring/alert-rules` and `#device/<id>/monitoring/notification-rules` |
| **Configuration** | `#device/<id>/configuration/permissions` |

A reload, a copied link and the back and forward buttons open exactly this subarea or view. A link to **Configuration** without the right opens **Monitoring → Alert rules**. A link to **DHCP server** or **DNS server** on a device without that role opens the **Extensions** overview. In these cases, ServerDesk corrects the address bar without an additional history entry.

The link identifies a graphics card by its position in the selection list, not by the adapter ID. The positions are 2 to 16, and the first card has no number. If there are fewer graphics cards, the first card opens. If a device has no supported graphics card, `#device/<id>/hardware/gpu` shows **Components** with a note that tells you why. The address bar keeps the link, so the same link opens the graphics card when a later report contains one.

The link does not contain default subareas, for example processes, services or components. An unknown subarea opens the default of the area. ServerDesk corrects the address bar without an additional history entry. A new device or a different main area always starts at the default. The link does not contain the drive focus, the process filter and the event filter. A link does not bypass a device permission.

### Old links

Old links still open. For example, `#devices/<id>/overview`, `#devices/<id>/terminal` and `#devices/<id>/management/drivers` open the same page as `#device/<id>`, `#device/<id>/remote/terminal` and `#device/<id>/software/drivers`. The old links `#device/<id>/management/software`, `…/drivers`, `…/certificates` and `…/autostart` open the applicable tab of **Software**. ServerDesk writes the new link in the address bar without an additional history entry, so the back button does not go to the old link. Old links of the pages also open: for example, `#agents/installation` opens `#devices/add`, and `#administration/audit` opens `#settings/audit`.

The alarms and the rules moved to **Monitoring**. These old links open the new place:

| Old link | Opens |
| --- | --- |
| `#device/<id>/history/alarms` | `#device/<id>/monitoring` |
| `#device/<id>/configuration` and `#device/<id>/configuration/alert-rules` | `#device/<id>/monitoring/alert-rules` |
| `#devices/<id>/alerts` | `#device/<id>/monitoring/alert-rules` |
| `#devices/<id>/permissions` | `#device/<id>/configuration/permissions` |
| `#devices/<id>/history` | `#device/<id>/history` (**Jobs**) |
| `<scope>/alarms` | `<scope>/monitoring` (**By device**) |
| `<scope>/alarms/list` | `<scope>/monitoring/list` (**By alarm**) |
| `<scope>/configuration` | `<scope>/monitoring/alert-rules` on **All devices** and a group, `<scope>/monitoring/notification-rules` on a customer, the tab **Devices** on **Ungrouped** |
| `<scope>/configuration/notification-rules` | `<scope>/monitoring/notification-rules` |

`<scope>` is `#devices`, `#devices/group/<id>`, `#devices/customer/<id>`, `#devices/ungrouped` or `#devices/customer/<id>/ungrouped`. The older links `#devices/alerts`, `#devices/notifications` and `#devices/problems` open **Alert rules**, **Notification rules** and **By device**. ServerDesk writes the new link in the address bar without an additional history entry.

The assistant has no link of its own. The old link `#device/<id>/assistant` opens the device with the assistant panel open. ServerDesk writes `#device/<id>` in the address bar.

The CPU and RAM history uses the existing measurement points and time filters. Static hardware data needs agent 4.6.7. Older agents continue to supply the existing basic information. The RAM that Windows can use and a fully reported DIMM capacity are separate values. The inventory summary that you can copy contains no hardware serial numbers.

The **Overview** shows at most four current values: CPU, RAM, the first graphics card and the fullest drive. The uptime is a fact on the **System** card. The utilization chart can also show the other graphics cards.

All sizes and transfer rates use IEC units (KiB, MiB, GiB and TiB, factor 1024). One formatter makes them, so a value looks the same in all areas.

## Page header

The page header has three lines. The first line is the breadcrumb with the group path, for example **All devices › Berlin › Web**. The second line shows the device name, the connection state and the mode. The third line shows the operating system, the build and the IP address. If the device has a description and tags, they follow in the same line.

The header icon is the device type tile (refer to [Device type](#device-type)). The header has no red button. **Previous device**, **Next device**, **Pin device**, **Refresh inventory**, **Ask assistant** and **Move to group…** are next to the name. **Ask assistant** has the accent color, so it is the most visible action in the header. The **More actions** menu (the three dots) contains these entries:

- **Rename device**
- **Add description…** or **Edit description…**
- **Add tags…**
- **Restart…** and **Shut down…**
- **Remove device**. The removal still asks for a confirmation.

On a screen that is 760 pixels wide or less, the header is compact. The name line also shows **Refresh inventory**, **Ask assistant** and **More actions**. **Ask assistant** keeps its accent color and its label. On a screen that is 520 pixels wide or less, it shows only its icon.

In the compact header, **More actions** also contains **Pin device** or **Unpin device** as the first entry, and **Previous device**, **Next device** and **Move to group…**. The mode shows only as an icon. The tag row shows two tags and a **+N** button that shows the other tags.

If the device is offline, did not report yet or updates its agent, one notice at the top of each area tells you. **Configuration**, **Monitoring → Alert rules** and **Monitoring → Notification rules** do not show this notice.

## Restart and shut down

You can restart or shut down a Windows device from three places. Each place opens the same panel and the same confirmation.

- **More actions** › **Restart…** or **Shut down…** in the device header
- **Restart…** in the row menu of a device in a device list
- **Restart** or **Shut down** on **Management → System**

To restart a device:

1. Select **Restart…**. The panel **Prepare restart** opens.
2. Type the lead time in seconds (60 to 3600) and a reason.
3. Select **Review change**. The confirmation **Restart server?** opens.
4. Select **Restart**. A message and the job dock show the job.

**Shut down…** works the same way. Its confirmation **Shut down server?** has a red **Shut down** button. A blocked entry shows the reason, for example an offline device, a missing right or **ReadOnly** mode.

## Ask assistant

**Ask assistant** in the device header opens the assistant in a panel on the right side. The panel does not block the page. You can still select areas and tabs, and the panel stays open with its conversation. To close the panel, select the close button or press Esc in the panel.

A source of an answer opens its area behind the panel. When you open a different device, the panel closes. **Earlier conversations** can open the conversation of a different device, and that device then opens with the panel. Refer to [AI assistant](ai-assistant.md).

## Device name

The device name follows the computer name that the agent reports in each heartbeat. When you rename the computer in Windows and restart it, the portal shows the new name after the next heartbeat. A name that you choose in the portal (a custom name) stays.

ServerDesk records each rename:

- The access history of the device gets one row. An automatic rename has the actor **System** and the action `device.name.hostname`. A rename in the portal has your name and the action `device.name.set` or `device.name.hostname`. The target shows the old and the new name.
- The old name becomes a previous name. ServerDesk keeps the 5 newest previous names of each device.
- The fleet search and the command palette (Ctrl+K or ⌘K) find the device by a previous name.
- The **Hostname** fact on **Overview** shows **Previously** with the newest previous name.

Rows that ServerDesk wrote before the rename keep the old name. This applies to the access history, the jobs and the notifications.

To change the name, select **More actions** › **Rename device**. You need the right **Manage device groups and permissions** on the device.

1. Select **Use the computer name** or **Use a custom name**.
2. For a custom name, type 1 to 64 letters, digits, periods, spaces, underscores or hyphens.
3. Select **Rename device**.

When you select **Use the computer name**, the portal shows the reported computer name at once. If the agent did not report a computer name yet, the next heartbeat sets it. A difference only in upper and lower case does not change the name.

The source of the name depends on how the device was added:

- An installer of a customer sends the computer name. The name follows the computer name.
- With **Add device**, you type the name. If it is the computer name, the name follows the computer name. Any other name stays as a custom name. The first heartbeat makes this decision.
- For devices that existed before this feature, the update makes the decision once. A name that is equal to the reported computer name follows the computer name. A name of 1 to 15 letters, digits or hyphens also follows it, because it can be a Windows computer name. Each other name stays as a custom name.

## Description and tags

The page header shows the device description in the line below the device name, after the operating system and the address. Point to the text to see the full text. If the text is too long for the line or has line breaks, an arrow follows it. Select the text to expand it. The **Overview** area has no description card.

After the description, the same line shows up to three direct and inherited tags and a **+N** button for the other tags. Each direct tag has a remove button. To add or change the description, select **More actions** › **Add description…** or **Edit description…**. To add a tag, select **More actions** › **Add tags…**. The editor opens in the header line, and Esc or **Cancel** closes it.

The device has no **Tags** tab. The tags of a group are on the page **Configuration → Tags** of the group. Refer to [Device descriptions and tags](device-tags.md).

## Device overview and group actions

Column headers sort their visible values, and a second click changes the direction. Missing inventories and old CPU and RAM live values stay at the end in the two directions. The **Free** column sorts the free capacities that it shows. ServerDesk sorts agent versions and device names in natural numeric order. Items with equal values keep their sequence after a reload. `aria-sort` and labeled native buttons make the state accessible with a keyboard and a screen reader.

In the group menu, rename and delete open the bound form directly. **Manage device members** opens the device assignment. Subgroups, global delete rights, role assignments, MFA and the existing backend limits continue to apply. After a successful deletion, the view leaves the active group filter only if you deleted that group. If you selected a different target in the meantime, it stays selected.

## Device type

Each device shows an icon for its type. The icon is in the navigator tree, the device list, the device cards, the device header and the command palette. Point to the icon to see the type. The **Overview** area shows the type in the **Device type** fact.

The agent reports no chassis type. ServerDesk uses the data that the agent already sends, and the first rule that matches sets the type:

1. A device that did not report yet: **Device type not reported yet**.
2. Domain role 4 or 5 (`Win32_ComputerSystem.DomainRole`): **Domain controller**.
3. Domain role 2 or 3: **Server**.
4. No domain role, and a server installation type or a server operating system: **Server**.
5. A battery is present: **Laptop**.
6. All other devices: **Workstation**.

A desktop computer with a USB UPS can show as **Laptop**, because Windows can list a UPS as a battery. An older agent without battery data shows **Workstation**.

## Manufacturer

The **Overview** area, **Hardware → System** and the optional **Manufacturer** column of the device list show the manufacturer that the device reports. A known manufacturer shows its logo and its name. The logo is small and in the text color. A manufacturer without a logo shows a neutral icon and its name. BIOS placeholders such as `To be filled by O.E.M.` show as not reported.

The **Manufacturer** column is off by default. Turn it on in the column menu of the device list. The column sorts by the manufacturer name, and devices without a manufacturer stay at the end. The device search finds the manufacturer and the model. The CSV export has the columns **Device type**, **Manufacturer** and **Model**.

The logos come from Simple Icons. Refer to [Manufacturer logos](manufacturer-logos.md) for the source, the license and the trademark notice.

## Pinned devices

You can pin devices that you open frequently. Pinned devices show in the node **Pinned** at the top of the navigator tree, sorted by name. In the command palette (Ctrl+K or ⌘K), they show first in the group **Pinned**. Your pins are stored on the server for your account, so they follow you to each browser.

To pin a device, use one of these actions. Each action has the name **Pin device**, or **Unpin device** for a pinned device:

- The first entry of the menu of a device in the navigator tree
- The entry after **Open** in the row menu of the device list
- The pin button next to the device name in the device header. On a screen that is 760 pixels wide or less, the first entry of **More actions**
- The command palette on the device page

The change shows at once, and a message confirms it. If the change fails, the previous state comes back and a message tells you what to do. You can pin up to 20 devices.

The tree filter also applies to the **Pinned** node. When you open a pinned device, its row under **Pinned** shows in the accent color, and its row in the group stays selected. Sample devices have no pins. A pin of a device that you cannot see anymore stays stored but does not show. It shows again when you get the access again. A pin has no audit entry and no MFA confirmation, because it is a personal display setting.

## Density

**My account** › **Preferences** › **Density** changes the space of the console. **Comfortable** is the default. **Compact** makes table rows, table heads, navigator lines and the space below the page header smaller, so more rows show at once.

The density applies at once in this browser. The browser keeps it in a cookie, also after you sign out. The command palette has the action **Use compact density** or **Use comfortable density**. On a window that is 900 pixels wide or less, and on a touch screen, the console always uses the comfortable size. Thus, controls stay easy to touch.
