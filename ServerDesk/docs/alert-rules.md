# Alert rules

Alert rules make the issues that the portal shows on a device. Examples are high
CPU usage, low free disk space or a pending restart. The server examines the
rules each time that the portal loads the device data. The device list and the
health line on the **Overview** of the device page use this result.

The server also keeps alarms from the same rules. An alarm has a start, an end,
a peak value and a level. Refer to [Alarms](#alarms).

## The rules and their defaults

There are 41 fixed rules of three kinds:

- A threshold rule has a warning step and a critical step. You can leave one of
  the two steps empty, then that step does not apply.
- A yes-or-no rule has one level: **Info**, **Warning** or
  **Critical**.
- A limit rule has one threshold and one level. The rule table shows the
  threshold in one cell below **Warning** and **Critical**. The edit drawer
  shows one field **Threshold** and the level.

A rule can be off by default. Then it makes no issues until you turn it on.

| Rule | Condition | Warning | Critical | Range |
|---|---|---|---|---|
| CPU usage | usage at or above the threshold | 80 % | 90 % | 1 to 100 % |
| RAM usage | usage at or above the threshold | 80 % | 90 % | 1 to 100 % |
| Free disk space | free space of a volume below the threshold | 15 % | 5 % | 1 to 99 % |
| Disk latency | latency at or above the threshold | 50 ms | 100 ms | 1 to 60000 ms |
| Pagefile usage | usage at or above the threshold | 80 % | 90 % | 1 to 100 % |
| Processor queue | queue above the threshold for each processor | 2 | not used | 1 to 100 |
| Restart pending | Windows reports a pending restart | level warning | | |
| Firewall profile off | a firewall profile is off | level warning | | |
| Defender off | antivirus or real-time protection is off; a passive Defender next to another antivirus does not count | level warning | | |
| Defender signature age | signatures older than the threshold | 7 days | not used | 1 to 365 days |
| Updates available | Windows Update reports updates | level warning | | |
| Inventory incomplete | the agent could not collect part of the inventory | level info | | |
| Recent crash | the newest crash is at most this number of days old | 30 days | 7 days | 1 to 30 days |
| Support end | the security support of the operating system ends in this number of days or fewer (0: it has ended) | 180 days | 0 days | 0 to 1825 days |
| OS support unknown | the agent reports `osInfo` and the lifecycle catalog has no entry for it | level info | | |
| Evaluation edition | Windows runs as an evaluation edition, and the evaluation ends in this number of days or fewer (0 or less: it has ended) | 180 days | 14 days | 0 to 365 days |
| Windows not activated | Windows reports that it is not activated: unlicensed, a grace period, notification mode or not genuine | level warning | | |
| System drive not encrypted | BitLocker is available and the system drive is not encrypted | level warning | | |
| BitLocker protection suspended | BitLocker protection is suspended on a volume (one issue for each volume) | level warning | | |
| No recovery password | an encrypted system or fixed volume has no recovery password (one issue for each volume) | level info | | |
| Device Manager error | a device in Device Manager reports an error (one issue for each device) | level warning | | |
| Unsigned driver | the device has an unsigned driver (one issue for each device) | level info | | |
| Stability index low | the stability index of Windows is below the threshold | 5 | not used | 1 to 10 |
| Program crashes repeatedly | one program crashed this number of times or more in 7 days (one issue for each program) | 3 | not used | 1 to 100 |
| Disk error state | a disk reports the health warning or unhealthy, or the status predictive failure or failed (one issue for each disk) | level critical | | |
| SSD wear | the wear of a disk is at or above the threshold (one issue for each disk) | 80 % | 95 % | 1 to 100 % |
| Disk errors in the event log | the System log has disk errors of the last 30 days (one issue for each disk) | level warning | | |
| Battery capacity | a battery has less than this part of its design capacity (limit rule, one issue for each battery) | 60 %, level info | | 1 to 99 % |
| Certificate expires | a certificate with a private key expires in this number of days or fewer (0 or less: it has expired) | 30 days | 7 days | 0 to 365 days |
| Certificate without private key expires | the same for certificates without a private key; off by default | 30 days | 7 days | 0 to 365 days |
| New autostart entry | the device has a new autostart entry that nobody confirmed (one issue for each device) | level info | | |
| New suspicious autostart entry | the same for an unsigned entry or an entry from a user folder (one issue for each device) | level warning | | |
| Defender threat detected | Defender reports an active detection | level critical | | |
| Defender scan age | the newer of the last quick and full scan is older than the threshold | 7 days | not used | 1 to 365 days |
| DHCP scope almost full | an active IPv4 DHCP scope uses at least this part of its addresses (one issue for each scope) | 90 % | not used | 1 to 100 % |
| DHCP service stopped | the DHCP plugin reports the DHCP Server service as stopped | level critical | | |
| DNS service stopped | the DNS plugin reports the DNS Server service as stopped | level critical | | |
| Agent stopped or start type changed | the agent was stopped, ended or hung, or a service does not start automatically (agent 4.18.0) | level warning | | |
| Agent removed outside the portal | the agent was uninstalled on the device, or its service was deleted (agent 4.18.0) | level critical | | |
| Agent protection changed | a service DACL, a service SID, the service recovery or a folder ACL differed from the installation (agent 4.18.0) | level critical | | |
| Device offline | the device sent no Heartbeat for this number of minutes or more | not used | 15 minutes | 3 to 10080 minutes |

CPU, RAM, disk latency, pagefile and processor queue are live values. These
rules apply only while the device is online. The other rules also apply to the
last inventory of an offline device.

For a threshold rule, the warning threshold must come before the critical
threshold. Thus for most rules, the warning value must be lower. For free disk
space, recent crash, support end, evaluation edition, stability index and the
certificate rules, the warning value must be higher. All thresholds are whole numbers. A limit
rule needs its threshold and its level, and it has no critical step.

The rule **Device offline** applies only while the device is offline. It does
not apply before the first Heartbeat or while an agent update runs. The issue
goes away when the device is online again.

The rules from **Recent crash** to **OS support unknown** and the three
BitLocker rules use the health signals of agent 4.10.0. The twelve rules from **Device Manager error** to
**New suspicious autostart entry** use the health signals of agent 4.11.0
([device-health-signals.md](device-health-signals.md)). They make no issue
while a device does not report the field, for example with an older agent. A
device without BitLocker shows **Not available** and no
warning. A signal that the device reports as not available also makes no
issue.

The rules **Defender threat detected** and **Defender scan age** use the
Microsoft Defender state of agent 4.14.0. They make no issue for older agents.
The issue of **Defender threat detected** holds only the number of active
detections and the highest severity. It holds no name, path or user.

**Defender scan age** applies only when Defender runs in normal mode. A passive
Defender does not run its own scans. When the device never reported a scan,
the rule fires at its highest set level without a reading. Then its alarm stays
open until the device reports a scan.

From agent 4.14.0, **Defender off** reads the new Defender state. It does not
fire when Defender runs in passive mode, in side-by-side passive mode or in
EDR block mode. It also does not fire when another enabled antivirus protects
the device. For older agents, the rule reads `security.defender` as before.
**Defender signature age** reads the new signature time when the agent sends
it. From the tab **Monitoring** (**By device** and **By alarm**), the four Defender rules open the
device area **Management → Defender**.

The rules **Evaluation edition** and **Windows not activated** use the license
state of agent 4.22.0 ([device-health-signals.md](device-health-signals.md#windows-activation)).
They make no issue for older agents or while the agent cannot read the
license state. Both rules open the **Overview** of the device.

**Evaluation edition** applies when the agent reports the evaluation channel or
the edition ID ends with `Eval`. The rule counts the days until the evaluation
ends. When Windows reports no end, the rule fires at the warning step. When the
rule has no warning step, it makes no issue. An evaluation in notification mode
or without a license and without an end has ended. Then the rule fires at the
critical step.

**Windows not activated** fires when Windows is not activated. The status
**Unknown** makes no issue. An evaluation that is not activated gets both
issues: one says when the evaluation ends, the other says that Windows is not
activated.

The rules **DHCP scope almost full** and **DHCP service stopped** use the
data of the DHCP plugin ([dhcp-server.md](dhcp-server.md)). They read only data
of at most 60 minutes, which is four collection cycles. Older or missing data
make no issue. So a removed or broken plugin closes these alarms. An inactive
scope and a scope without addresses make no issue. The issue holds the scope id
and the numbers, but not the scope name, because issues also reach viewers
without `dhcp.read`.

Both DHCP rules open the DHCP view of the area **Extensions**. The view **By device** of the tab **Monitoring** and
the health line of the device **Overview** (**Open DHCP server**) link there. The portal checks them
again after each stored upload of the plugin.

The rule **DNS service stopped** uses the server read of the DNS plugin
([dns-server.md](dns-server.md)) in the same way. It reads only data of at most
60 minutes, and older or missing data make no issue. The issue has no
parameters. It opens the DNS view of the area **Extensions**, but only on a device
with the DNS Server role. The portal checks it again after each stored server
read.

### Agent tamper protection

The three agent rules use the integrity events of agent 4.18.0 and the snapshot `agentIntegrity`. Refer to [Tamper protection in 4.18.0](native-agent-v4.md#tamper-protection-in-4180). They make no issue for older agents. All three rules open the **Overview** of the device. The portal checks them again after each stored event.

An event keeps its issue for 24 hours after it reached the portal. Some causes keep the issue longer:

- **Agent stopped or start type changed** fires for a stop, an end, a hang, a watchdog restart or a broker that does not answer. A stop and a broker outage keep the issue while no Heartbeat came after the event. A start type of manual, disabled or unknown keeps an issue for each service while the agent reports it.
- **Agent removed outside the portal** fires for a local uninstall with the Windows user, or for a deleted service. It stays while no Heartbeat came after the event.
- **Agent protection changed** fires for each changed target, one issue for each service or folder. A difference that the agent could not restore stays while the agent reports it.

The update guard prevents false alarms. While an agent update of the device runs, and in 30 minutes after its claim, the portal stores stop events as planned. Planned events make no issue and no audit row. The agent itself sends no stop event during an update, a restart of Windows or an uninstall from the portal.

Each new event that is not planned writes one audit row of the device with the actor `Agent` and the action `agent.integrity.<kind>`. The portal keeps the events for 90 days.

The rule **Certificate without private key expires** is off by default. Thus,
expired intermediate or third-party certificates make no issues. Turn it on
like any other rule.

## Inheritance

Open **Monitoring → Alert rules** of **All devices**, of a customer or of
a device group, or **Monitoring → Alert rules** of a device. The table shows the value that applies at this
level and the origin of the value.

The closest value wins, in this order: default, All devices, customer, parent
groups from the top, the group, the device. A change replaces the full settings
of the rule at its level. The change applies to all lower levels that do not
have their own value. When you move a device to a different group, the values
of the new group apply at once.

A customer is a level between **All devices** and its groups. The rules of a
customer apply to all groups and devices of this customer. A group or device of
the customer can change a value again. The origin of a value from a customer is
**Customer: name**. **Open origin** opens the alert rules of the customer, when
the console shows the customer view. Else the origin is plain text.

The rules of a customer apply also when the portal has only one customer.

The **Status** column shows a pill: **On** or **Off**. The default origin and **On** are muted, so changed values and higher origins stand out. The table shows the name of each rule. The description of the rule is in the edit drawer.

On a narrow screen, each rule is a card, and the description is one of its facts. Below 1440 pixels, the column **Level** is only in the cards and in the drawer, and below 1280 pixels the column **Alarm** as well.

A changed rule has the tag **Changed** and shows the inherited value
below it. Select **Reset to inherited value**
to remove the change at this level. A disabled rule makes no issues on the
devices that inherit it.

## Rights

To change alert rules, you need the device right `alerts.manage` at that level.
A right on a group also applies to its subgroups. The built-in roles Operator,
Device Administrator and Owner include the right. Reader does not include it.
All users who can see a device or group can read its rules.

Rules for All devices apply to all customers. Thus only a user who sees all
customers can change them. While the portal has only the default customer, this
is every user with the right. Refer to [Customers](customers.md).

The rules of a customer also apply to devices without a group. Thus, to change
them, you need the right `alerts.manage` for all devices, and you must see the
customer. A right on some groups of the customer is not sufficient. This is the
same rule as for notification rules of a customer. All users who see the
customer can read its rules.

Each change writes one audit entry with the old and the new value and their
origins. The entry of a customer change has the customer. The portal writes
the change and its audit entry together, or neither of them.

## Alarms

The server opens an alarm when a rule fires on a device. It closes the alarm
when the rule stops firing. Notification rules send alarm changes by email,
Teams or webhook. Refer to [Notifications](notifications.md).

Each rule and issue key has its own alarm, for example one alarm for each
volume. An alarm has one of these states:

- **Pending**: the rule fires, but its minimum duration is not over. A pending
  alarm is not shown. If the rule stops firing first, the server deletes it.
- **Open**: the rule fired for the minimum duration or longer.
- **Closed**: the alarm ended. It shows the reason.

An alarm closes for one of these reasons:

- **Recovered**: the value is better than the threshold by the
  recovery margin, or a yes-or-no condition is false again.
- **Rule turned off**: a user turned off the rule.
- **No data**: the device is offline and the rule uses a live
  value, or the device has no inventory.

The alarm keeps the worst value since its start as the peak, and the highest
level with its threshold. While the rule fires, the level of the alarm is the
level that fires now. While an agent update runs, alarms do not open or close.

### Minimum duration and recovery margin

Ten threshold rules have two more settings: CPU, RAM, free disk space, disk
latency, pagefile, processor queue, Defender signature age, stability index,
program crashes and SSD wear. The settings are:

- **Minimum duration**: how long the rule must fire before the
  alarm opens. Use 0 to open the alarm at once. The maximum is 1440 minutes.
- **Recovery margin**: how much better than the threshold the
  value must be before the alarm closes. The margin is in the unit of the rule.

The margin applies to the opening threshold. This is the warning threshold, or
the critical threshold when the rule has no warning step. The margin must be
smaller than this threshold. For free disk space, the threshold and the margin
together must not be more than 100 %.

| Rule | Minimum duration | Recovery margin |
|---|---|---|
| CPU usage | 5 minutes | 5 % |
| RAM usage | 5 minutes | 5 % |
| Pagefile usage | 5 minutes | 5 % |
| Disk latency | 5 minutes | 10 ms |
| Processor queue | 5 minutes | 0 |
| Free disk space | 0 minutes | 2 % |
| Defender signature age | 0 minutes | 0 days |
| Stability index low | 0 minutes | 0 |
| Program crashes repeatedly | 0 minutes | 0 |
| SSD wear | 0 minutes | 0 % |

Example: the CPU warning threshold is 90 % and the margin is 5 %. The values 91,
88, 92, 86 and 91 % keep one alarm open. The alarm closes when the value is
below 85 %. A new value above 90 % then opens a new alarm.

The issues in the health line on the **Overview** do not use these settings. They
show the current state at once. The column **Alarm** of the rule table shows the
two values. The other rules have no minimum duration and no margin.

### Device offline and the periodic check

The portal examines all devices once a minute, also when no data comes in. A
device that stops sending gets its **Device offline** alarm about one minute
after the threshold. At the same time, its alarms with live values close with
the reason no data. Pending alarms open when their minimum duration is over.

Each Heartbeat also updates the alarms of its device at once. With more than one
portal instance, only one instance runs the check in each minute. The setting
`MAINTENANCE_SCHEDULER=off` stops this check together with the maintenance
schedule. Refer to [Self-hosting](self-hosting.md#maintenance).

### Acknowledge and mute

In the row menu of an open alarm, you can do these actions:

- **Acknowledge**: show that someone works on the alarm.
- **Mute**: silence the alarm for 1 hour, 4 hours, 1 day or 7
  days. The alarm stays open. The mute ends when the time is over or the alarm
  closes.
- **Unmute**: end the mute now.

When the level of an alarm goes up, for example from warning to critical, the
acknowledgement is removed. The alarm then needs attention again.

These actions need the device right `alerts.manage`. Its name is
**Manage alert rules and alarms**. Each action
writes one audit entry on the device. The portal writes the change and its audit
entry together, or neither of them.

### The view By alarm

All devices, groups and customers have the view **By alarm** in the tab **Monitoring**. It shows the
open alarms of the devices that you can see. The most severe
alarms come first, then the oldest. You can filter by level, customer and group.
A group filter also includes the devices of its subgroups. You can export the
visible rows as a CSV file.

The tab **Monitoring** shows the number of open alarms of the view. Acknowledged and
muted alarms are part of this number. The number is red when one open alarm is
critical. It is amber when one open alarm is a warning and no alarm is critical.
Without an open alarm, the tab shows no number. The level filter shows the
number of alarms for each level.

Select a column head to sort by **Level**, **Device**, **Alarm** or **Since**.
Select the device name or the row to open the device. The column **Peak** shows
the worst value since the start. When a certificate or the OS support is past
its date, the peak shows the days as overdue, for example **20 days overdue**.
The CSV file uses the same text. A rule without a value shows a dash.

The **Customer** column and the customer filter show only when the devices in
the view belong to two or more customers. When the view has no open alarm,
**Open alert rules** opens **Monitoring → Alert rules**. An **Ungrouped** view has no
alert rules, so it shows **Show devices**. When the filters hide all alarms,
**Reset filters** shows all alarms again.

### Alarm history of a device

On a device, open **Monitoring**. The tab **Alarms** opens first. The table
shows the open alarms first, then the closed alarms, the newest first. Each row
shows the start, the end, the duration, the peak and the close reason.

### Retention

The maintenance deletes closed alarms after 90 days. Set a different value with
`--alert-days` or `ALERT_RETENTION_DAYS`, from 1 to 3650 days. Open and pending
alarms always stay. Refer to [Self-hosting](self-hosting.md#maintenance).

## Health and the Monitoring tab

The console calculates a health state and a score for each device. Both come
from the open alarms of the device. The calculation runs in the browser with
the alarms that you can see, so the customer boundary applies.

### States and score

A device has one of these states:

- **Good**: no open alarm at the level warning or critical.
- **Warning**: at least one open warning alarm and no critical alarm.
- **Critical**: at least one open critical alarm.
- **No data**: the device did not send a Heartbeat yet and has no alarms.

The score starts at 100. Each open alarm subtracts the weight of its current
level. The score does not go below 0. A device with no data has no score.

| Level | Weight |
|---|---|
| Critical | 40 |
| Warning | 15 |
| Info | 5 |

For example, one critical alarm and one warning alarm give 100 − 40 − 15 = 45.
Each alarm counts one time, so two volumes with low free space count two
times. Acknowledged and muted alarms also count, because they are still open.
Pending and closed alarms do not count.

The state follows the most severe level, not the score. Thus three warning
alarms (55) give **Warning**, and one critical alarm (60) gives **Critical**.
Info alarms lower the score, but the state stays **Good**.

### The Health column

The device table has the column **Health**. It shows the state in a pill, for
example **Critical**. When the device has issues, the number of issues for each
level follows the pill. A device with no data shows **No data**. A device
without an inventory and without alarms also shows **No data**.

The device cards and the view **By device** of the tab **Monitoring** show the same pill. The score shows only in the
health line on the **Overview** of the device, for example **Critical · 34/100**.

The column is always visible. It is not in the column menu.

Sort by the column to show the critical devices first, then the warnings, then
the good devices. In a state, the lowest score comes first, then the name.
Devices with no data stay at the end in both directions.

Select **Filters** above the device list. The list **State** has three entries
for the health states.
A device with no data matches none of them.

### The tab Monitoring

All devices, groups, customers and both **Ungrouped** scopes have the tab **Monitoring**. The tab
shows the number of open alarms in the color of the most severe level. It shows what the portal watches,
which alarms are open and who gets a message. It has these views:

- **By device** (`#devices/monitoring`) shows each device with an open warning or critical alarm.
- **By alarm** (`#devices/monitoring/list`) shows each open alarm with its device, level and start.
- **Alert rules** (`#devices/monitoring/alert-rules`) shows the rules that apply here. A customer shows the rules
  of **All devices**.
- **Notification rules** (`#devices/monitoring/notification-rules`) shows who gets a message and through which
  channel. Refer to [Notifications](notifications.md#notification-rules).

Both **Ungrouped** scopes have only **By device** and **By alarm**. A customer has **Notification rules** only
when the portal has more than one customer.

Select a view in the row below the tabs. The route keeps the view, so reload and the back button of the browser
open it again. The older links `…/alarms`, `…/alarms/list` and `…/configuration` still open: refer to
[Old links](device-workspace.md#old-links).

The view **By device** starts with two summary tiles above the table:

- **Alert rules on** shows the number of rules that are on here. Below it, you see how many rules have a
  change on this level.
- **Notification rules** shows the number of rules that can send a message, and their channels. A rule that is
  off, or a rule of a channel that is off, does not count. When no rule can send, the tile shows
  **Nobody gets notified.** in amber.

Select a tile to open its view. The tiles do not show when the portal cannot load the rules. A device shows the
same tiles in **Monitoring → Alarms**.

### Alarms by device

The view **By device** shows each device with an open warning or critical alarm. Devices with only
info alarms are not in the list. Use the level filter to show only critical or
only warning devices.

Critical devices come first, then warning devices. In each level, the device
whose oldest alarm at that level started first comes first. A lower score and
then the name break a tie. The column **Open for** shows the time
since that oldest alarm.

The column **Reasons** shows the open alarms of the device, the most severe
first. Each reason shows its full title. The first three reasons show at once.
With more reasons, the cell ends with **Show 2 more**, for example. Select it to
show all reasons of that row. The button then shows **Show fewer**, and the
device does not open.

Select a reason to open the device area of that
alarm. For example, a disk alarm opens **Management** and then
**Disks**. Select the device name or the row to open the area of
the first reason.

Select a column head to sort by **Health**, **Device** or **Open for**. The
**Customer** column shows only when the devices in the view belong to two or
more customers. When no device has a warning or critical alarm, the view shows
**No device has a warning or critical alarm** and **Show devices** opens the
**Devices** tab. When the level filter hides all devices, **Show all** shows
them again.

### Start page

You can make the tab **Monitoring** of **All devices** your start page. It opens with the view **By device**.
Open **My account** › **Preferences** and select **Alarms** under **Start page**. The command palette
has the same choices. The browser keeps the choice. Without a choice, the start page is the Dashboard, refer to
[dashboard.md](dashboard.md#start-page).

The console uses the start page only when you open it without a link to a page. A link to a page always opens
that page. A browser that kept the older choice **Problems** opens **Monitoring** too.
