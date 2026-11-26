# Device health signals

Agent 4.10.0 reports four health signals: crashes, the support status of the operating system, the installed programs and the BitLocker state. The portal shows each signal on the device page, as alert rules and as analysis tabs. The reports are in the tab **Inventory** of **All devices**, of each group and of each customer. The agent contract is in [v3-health-signals.md](v3-health-signals.md).

Agent 4.11.0 adds five more signals: drivers and Device Manager errors, reliability, disk and battery health, certificates and autostart entries. Refer to [Health signals of agent 4.11.0](#health-signals-of-agent-4110).

Agent 4.14.0 adds the state of Microsoft Defender. Refer to [Microsoft Defender](#microsoft-defender).

Devices with an older agent show a note to update the agent. They do not get issues for the new rules.

## Crashes

The agent reports blue screens, unexpected shutdowns and uncorrected hardware errors (WHEA) of the last 30 days. Corrected hardware errors are no crash. For a blue screen, the agent reads the stop code and, when possible, the driver that caused it. This information comes from the minidump in `%SystemRoot%\Minidump`. The dump itself never leaves the device.

- The area **Events** of the device shows the list **Crashes**. It shows the time, type, stop code, driver and source. Each blue screen has a link to the Microsoft documentation of its stop code.
- The rule **Recent crash** makes one issue for the newest crash. It is critical for a crash in the last 7 days and a warning for a crash in the last 30 days.
- When the same driver caused two or more crashes in the warning period, the issue tells you. An example is "3 crashes caused by vjoy.sys in 14 days".
- In the device list, **Filters** has the state **Crashes in the last 30 days**.

## Operating system support

The portal compares the Windows version of each device with a lifecycle catalog. The catalog is the data file `lib/os-lifecycle.json` with the Microsoft dates and a source link for each entry. It covers Windows 10, Windows 11, the LTSC editions and Windows Server 2016 to 2025. A test fails when the catalog is older than 183 days, so keep it current.

The status is one of these:

- **Supported until** a date: more security support remains than the warning period of the rule **Support end**.
- **Support ends in** a number of days: the support ends within the warning period. The default is 180 days.
- **No support since** a date: the support ended.
- **Unknown**: the catalog has no entry for this version, or the agent does not report it yet.

Microsoft does not report Extended Security Updates (ESU). If you bought ESU, set the ESU date on a customer, on a group or on a device. Select **Set ESU date** next to the fact **OS support** on the device overview, or open the report **Inventory → OS support** of a group or a customer. The device uses its own date, else the date of the closest group, else the date of its customer. The support end is the later of the catalog date and the ESU date.

To change an ESU date, you need the right `alerts.manage` on the group or device. The ESU date of a customer needs the right `alerts.manage` for all devices, and you must see the customer. Each change writes one entry to the audit log. The rule **OS support unknown** makes an info issue only when the agent reports the version and the catalog has no entry for it.

## Software inventory

The agent reports the installed programs from the uninstall keys of the registry. It reads the 64-bit and 32-bit keys and the keys of the users who are signed in. It reports name, version, publisher, installation date, architecture and scope. It never reports paths or user names. The agent sends the list only when it changes.

- The device area **Software → Programs** has the tabs **Installed**, **Change history** and, when the vulnerability check is on, **Vulnerabilities**. **Installed** shows the installed programs with a search field, 50 programs on each page. **Change history** shows installed, updated and removed programs.
- If the list does not load, the area shows an error with **Try again**. **Try again** sends the same request again.
- The tab **Software** groups the programs of the devices that you see by product and version. Search for a product and a version, for example `chrome 1`, to find old versions. Select a row to see the devices. The export gives the rows that you see as a CSV file.
- The first list of a device is the baseline and makes no changes in the history.

The vulnerability check compares the installed programs with known vulnerabilities from the NVD ([software-vulnerabilities.md](software-vulnerabilities.md)). An owner can turn it on.

The daily maintenance of the portal deletes changes that are older than 365 days. **Run now** on the page **Data retention** and the maintenance command do this too. `SOFTWARE_CHANGE_RETENTION_DAYS` sets the period for all runs. `--software-days` sets the period for one run of the maintenance command ([self-hosting.md](self-hosting.md#maintenance)).

## BitLocker

The agent reports the BitLocker state of every volume: encryption, protection, method and the kinds of key protectors. It never reads recovery passwords or other secrets.

- The area **Disks** shows the column **BitLocker** for each drive.
- The card **Protection & maintenance** shows the state of the system drive.
- The tab **Encryption** lists the devices with their system drive, protection, method, protectors and recovery password.
- Devices without BitLocker, for example Windows Home, show **Not available** and no warning.

The rules are **System drive not encrypted** (warning), **BitLocker protection suspended** (warning, for each volume) and **No recovery password** (info, for each volume). The agent cannot read a recovery password that is stored in Active Directory or Entra ID. Thus, the last rule looks only for a recovery password protector on the volume.

## Health signals of agent 4.11.0

The agent collects these signals every 15 minutes and after an explicit refresh. The contract is in [v3-health-signals.md](v3-health-signals.md#health-signals-in-4110). A device with an older agent shows a note to update the agent to 4.11.0 or later.

## Drivers

The agent reports the devices with an error in Device Manager and the installed drivers. A device ID never leaves the device.

- The device area **Software → Drivers** shows the card **Problem devices** with the error code and its meaning. Below it, the card **Installed drivers** shows the drivers with file, version, date, provider and signature.
- Use **Show** to see only unsigned drivers or drivers older than 3, 5 or 10 years. A driver without a date is never old.
- When a crash names a driver file such as `vjoy.sys`, the crash issue has the link **Show in driver inventory**. The link marks all rows with this file, scrolls to the first row and moves the focus to it.
- The tab **Drivers** groups the drivers of the devices that you see by driver, version and provider. Select a row to see the devices.
- Agent 4.11.1 and later report a failed driver read. If the portal has no stored list, the area shows **The driver list is not available**. It also shows the reason and the time of the first failure.
- If the portal has a stored list, a warning above the table tells you that the list is out of date. It shows the time of the stored list and the reason. The table, the search and the filter stay available. After the next successful read, the warning disappears.
- An agent 4.11.0 or later can have no driver list yet. Then the area tells you to update the agent to 4.11.1 or later if this does not change.

The rules are **Device Manager error** (warning) and **Unsigned driver** (info), each with one issue for each device.

## Reliability

Windows keeps a stability index from 1 to 10 for each day. Windows Server does not collect it by default. Then the portal shows **Not available** with the reason, and never an estimate. The agent also reads program crashes and hangs from the Application log, so they show on all devices.

- The area **Events** of the device shows the card **Reliability**. It shows the current stability index, a chart of the last 30 days and the program crashes for each program. Expand a program to see its events.
- The tab **Reliability** shows the programs that crashed on the devices that you see, with crashes, hangs and devices. The head line counts the devices with a stability index below 5 and the devices without stability data.

The rules are **Stability index low** (warning below 5) and **Program crashes repeatedly** (warning at 3 crashes of one program in 7 days). Hangs and failed installations do not count as crashes.

## Disk and battery health

The agent reports the health, the operational status, the wear, the temperature and the power-on hours of each physical disk. It counts the disk errors of the System log of the last 30 days. Many USB and virtual disks report no counters. Then the portal shows **Not available** and no warning.

- The area **Disks** shows the card **Disk health**. The drive table gets the column **Reported state**.
- The column **Reported state** shows the state that the disk reports. A healthy disk shows **OK**. The other values stay as before.
- In the card **Disk health**, an error count above 0 shows as a warning pill with the number. A count of 0 shows as plain text. A missing count shows a dash.
- **Hardware** › **Components** shows the battery as one element. If the device reports a battery, the card **Battery** below the component cards shows each battery. It shows the health compared to the design capacity, the capacity and the charge cycles. Otherwise a **Battery** card in the component grid shows the state: **No battery**, **Not available** (Windows did not supply data) or **Not reported** (the agent is older than 4.11.0).
- The device list has the columns **Disk health**, **SSD wear** and **Battery**. Its states in **Filters** find a failed disk, SSD wear of 80 % or more, disk errors in 30 days and a battery below 60 %.

The rules are **Disk error state** (critical), **SSD wear** (warning at 80 %, critical at 95 %), **Disk errors in the event log** (warning) and **Battery capacity** (info below 60 %).

## Certificates

The agent reads the machine stores `My`, `WebHosting` and `Remote Desktop`. It finds the HTTPS bindings of http.sys and the certificate of Remote Desktop. Private keys and certificate files never leave the device. The agent reads only whether a private key exists.

- The device area **Software → Certificates** shows the number of expired certificates, of certificates that expire within 30 days and of valid certificates at the top. The card **Machine certificates** lists the certificates, the first to expire first. It shows the store, the expiry, the private key and the binding.
- The tab **Certificates** shows the certificates that expire in 30 days, the expired certificates or all certificates. By default, it shows only certificates with a private key. When this default view is empty, it shows **No certificate expires in the next 30 days** and **Show all certificates**. This sets the filter to all certificates and turns off **Only with private key**.

The rule **Certificate expires** applies to certificates with a private key. It is a warning at 30 days and critical at 7 days or after the expiry. The same rule for certificates without a private key is off by default.

## Autostart

The agent reports the programs that start automatically: Run and RunOnce keys, Startup folders, Winlogon, services and scheduled tasks. It skips services and tasks from Microsoft. It hides passwords and tokens in command lines and removes user names.

The first list of a device is the baseline. Later entries are new until a user confirms them. An entry is suspicious when it is unsigned, has an invalid signature or starts from a user folder or a temp folder. A changed command line makes a new entry.

- The device area **Software → Autostart** has the filter **All**, **New** and **Suspicious** above the list. Each entry of the filter shows its number. Select an entry to filter the list.
- The table has the columns **Entry**, **Type**, **Program**, **Signature** and **Status**. **Program** shows the target, or the command when there is no target. A long path breaks only after `\`, `/` or a space, so a file name such as `ServerDesk.Agent.exe` stays on one line.
- Select a row to open the details. The details show the type, the location, the full command, the target and the signature. They also show the status with the user who confirmed the entry, and when the entry was first seen.
- Select entries and click **Confirm as known**, or click **Confirm all as known**.
- The tab **Autostart** groups the entries of the devices that you see. Entries on few devices come first, because they are the most unusual.

The rules are **New autostart entry** (info) and **New suspicious autostart entry** (warning), each with one issue for each device. A confirmed entry makes no issue.

## Confirmation of autostart entries

To confirm autostart entries, you need the device right `manage`. Each confirmation writes one entry to the audit log with the names of the entries. When the list changed after you loaded it, the portal refuses **Confirm all as known** and asks you to load the list again. Sample devices in demo mode cannot confirm entries.

## Microsoft Defender

Agent 4.14.0 reads the state of Microsoft Defender every 5 minutes. The collector only reads. Since agent 4.15.0, you can also start Defender actions from the portal. The fields are in [v3-health-signals.md](v3-health-signals.md#microsoft-defender-in-4140).

- **Data.** The agent sends the mode (active, passive, EDR block mode or not running) and the state of antivirus, real-time and tamper protection. It also sends the last quick and full scan, the signatures and the product version. The agent also sends the newest 100 detections, the exclusions and the other antivirus products of Windows Security Center.
- **Passive Defender.** When another antivirus protects the device, Defender often runs in passive mode or turns off. The portal shows the name of the other product. This state is not a warning.
- **Right.** Detections and exclusions contain file paths and user names. They need the device right `defender.read` (**View Microsoft Defender**). Without it, the portal sends only the summary: mode, flags, times, versions and counts. The Defender actions need the device right `defender.control` (**Control Microsoft Defender**).
- **Device area.** **Management → Defender** shows the state at a glance, the status, the scans, the detections and the exclusions. The exclusions are read-only, because attackers use exclusions to hide malware. Change them through Group Policy, Intune or on the device.
- **Panel parts.** The head shows the time of the last report. When you cannot start actions, one notice tells you why and that you can still read the report. The cards **Status** and **Scans** show their values as label and value pairs. The table **Detections** sorts by **Threat**, **Severity** and **Detected**. Active detections show in bold.
- **Report.** The report **Inventory → Defender** shows the Defender state of every device. Filter by devices with detections, a scan that is too old, Defender off, passive Defender or no report. **Scan too old** and **Off** use the alert rules of each device. Only the most urgent filter with devices shows its color: **With detections**, then **Off**, then **Scan too old**.
- **Sort.** To sort the report, select the column head **Device**, **Status**, **Active detections**, **Last scan** or **Signatures**. **Status** sorts the most urgent state first. A scan that runs counts as the newest scan.

### Defender actions

Agent 4.15.0 runs four actions as signed jobs. Each job shows in the job dock, and the Defender area then shows the new state.

| Action | What Defender does |
| --- | --- |
| **Run quick scan** | Checks the places where malware usually hides. This usually takes a few minutes. |
| **Run full scan** | Checks every file on all fixed drives. This can take several hours. |
| **Update signatures** | Downloads the newest signatures from the update source that is set on the device. |
| **Clean all active detections** | Removes all active detections or moves them to quarantine, as its settings say. |

- **Where.** In **Management → Defender**, **Run quick scan** is a secondary button in the card **Scans**. **Run full scan** is in the menu **More scan actions**. **Update signatures** is in the card **Status**, and **Clean all active detections** is in the card **Detections**.
- **Conditions.** Each action needs the device right `defender.control`, a fresh MFA session and an agent in Management mode. The device must be online, and you confirm each action. The portal writes a device audit row for each job.
- **Blocked actions.** When an action cannot run, the button stays visible and tells you why. Examples are a missing right, ReadOnly mode, an offline device or an agent before 4.15.0. Other examples are a Defender that does not run, a scan that runs, or no active detection to clean.
- **Scans.** A scan job ends when the scan has started, after a maximum of 60 seconds. The agent then runs other jobs, also while the scan continues. The card **Scans** shows "Quick scan running since {time}" until the scan ends. You cannot start a second scan while one runs.
- **Clean all active detections.** Defender has no action for one detection. This action acts on all active detections of the device at once. The portal cannot restore quarantined files, and it does not change exclusions or allowed threats.
- **Refresh.** When a Defender job ends, the area refreshes every 10 seconds for 2 minutes. Then the new scan time, the signature version or the detection list shows without a reload.

In the report **Defender**, select devices to start one action on many devices at once. The bar shows **Run quick scan**, **Run full scan**, **Update signatures** and **Clean all active detections**. The confirmation names the devices that can run the action. It also tells you how many selected devices it skips, and why. A maximum of 100 devices is possible in one action. Devices of two or more customers make the action a cross-customer action ([customers.md](customers.md#actions-for-multiple-customers)).

The server checks each device again. If one device cannot run the action, the portal creates no job and names that device. Remove the device from the selection, then try again.

The rules are **Defender threat detected** (critical), **Defender scan age** (warning after 7 days) and the changed **Defender off** ([alert-rules.md](alert-rules.md)). The issues hold only the number of detections, the severity and the scan time. Thus they show no path or user to users without `defender.read`.

## The analysis tabs

All devices, a group, a customer and both **Ungrouped** scopes show the reports in the tab **Inventory**: **Software**, **Extensions**, **Drivers**, **Certificates**, **Autostart**, **OS support**, **Encryption**, **Defender** and **Reliability**. Select a report in the row below the tabs. **Software** opens first (`#devices/inventory`), the others have their own route, for example `#devices/inventory/defender`.

The reports **Software**, **OS support**, **Encryption**, **Drivers**, **Reliability**, **Certificates** and **Autostart** use the same layout. A line below the tabs tells what the tab shows. Then come the notices, the search and the filters, and the table.

On a phone or a narrow window, each row shows as a card.

Select a column head to sort the table. Select the same head again to change the direction. Names, dates, counts and states sort. Free text and lists do not sort. These columns sort:

| Tab | Columns that sort | Sort when you open the tab |
|---|---|---|
| **Software** | Product, Version, Vulnerabilities, Publisher, Devices | Devices, most first |
| **OS support** | Product and version, Security updates until, Status, Devices | Status, worst first |
| **Encryption** | Device, System drive | The order of the devices |
| **Drivers** | Driver, Version, Provider, Date, Devices | Devices, most first |
| **Reliability** | Program, Crashes, Hangs, Devices, Last | Crashes, most first |
| **Certificates** | Device, Subject, Expires, Days left | Expires, soonest first |
| **Autostart** | Entry, Type, Devices, New | Devices, fewest first |

The foot of each table shows how many rows you see of all rows, for example **12 of 40 drivers**. The catalog date of **OS support** shows below the description of the tab. The two stability counts of **Reliability** also show there.

A missing value shows a dash. A status shows as a pill that is only as wide as its text.

When a tab has no rows, the table shows the cause and one action:

- No data from the devices: **Show devices** opens the **Devices** tab. There you can see if the agents run.
- A search without a match: **Clear search** removes the search text.
- A filter without a match: **Show all** sets the filter back to all. On **Certificates**, **Show all certificates** also shows the certificates without a private key. On **Autostart**, **Reset filters** removes the search text and the filter.

While a tab loads for the first time, it shows placeholder rows. If the load takes long, the tab tells you and shows **Try again**. If the load fails, an error message shows **Try again**. It sends the same request again.

## Rights and the customer boundary

All users who can see a device also see all its health signals: from the crashes and the software to the certificates and the autostart entries. This needs the device right `view`, the same right as the hardware inventory. Only the Defender detections and exclusions also need `defender.read`.

The tabs count only the devices that you see. A technician of one customer never sees the data of another customer. A group or customer outside your boundary answers as if it does not exist.
