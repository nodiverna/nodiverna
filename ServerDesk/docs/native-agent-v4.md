# ServerDesk native agent 4.22.0

## Delivery and compatibility

The agent is a self-contained .NET 10 application. It comes as one x64 `ServerDesk.Agent.exe` of approximately 58 MiB. Supported hosts are Windows Server 2022, Windows Server 2025 and Windows 11 Pro/Enterprise. For the server editions, Server Core is also supported. You do not have to install .NET or PowerShell 7 separately. The download size is known, but nobody has measured the Windows resource consumption yet.

Agent version 4.7.0 uses portal protocol version 3. The existing `agent/v3`, manifest URLs and build-script names stay compatible with device identities and portal records. A release ZIP contains one EXE. The signed manifest also identifies the hash and size of this EXE. Artifacts that active releases or update jobs refer to stay available. When you retire an unused release, the portal keeps its signed historical metadata and its completed job records.

## Windows license in 4.22.0

Agent 4.22.0 reports the Windows activation state in the new snapshot key `windowsLicense`. The broker reads it once an hour as the fixed, argument-free collector "Windows license", with a deadline of 30 seconds. A manual inventory refresh also reads it.

- **Data.** The agent sends the license status, the license channel, the end of an evaluation or a grace period and the evaluation end date. The fields are in [Windows license in 4.22.0](v3-health-signals.md#windows-license-in-4220).
- **No product key.** The collector reads `SoftwareLicensingProduct` only for the Windows application ID. It selects no product key and no part of one, and it calls no method of a licensing class.
- **Older Windows.** When Windows does not know `ProductKeyChannel` or `EvaluationEndDate`, the agent reads again without them.
- **Portal.** The device overview shows the fact **Windows activation**. The rules **Evaluation edition** and **Windows not activated** make issues and alarms. For the details, refer to [Windows activation](device-health-signals.md#windows-activation).
- **Self-test.** `ServerDesk.Agent.exe --windows-license-self-test` checks every status, every channel rule, the end times, the second query and the failure results.

## Fixes in 4.21.5

- **Cause.** On some Windows servers, for example Windows Server 2025, the device page showed "Roles and features could not be read (TimeoutException)". The worker gave the broker read of the role list 45 seconds. The ServerManager enumeration can take up to 2 minutes. So a slow but working enumeration failed in every inventory cycle, and its late result was lost.
- **Time budget.** "Roles and features" now has a deadline of 150 seconds (`NativeFeatures.InventoryDeadlineSeconds`). The worker's broker call waits 165 seconds. The deadline covers the 120-second enumeration (`NativeFeatures.ServerEnumerationSeconds`), four provider probes of 5 seconds and 10 seconds of margin. A run past 150 seconds still shows "the Windows provider does not answer in time".
- **Joined broker reads.** The broker reads each privileged inventory in one run at a time. A request that arrives while the same read runs now waits for that run and gets its result or its failure. Agents up to 4.21.4 failed such a request after 30 seconds with "The privileged inventory is still running.". A failure is not kept: the next request reads again.
- **Shared enumeration.** The telemetry and the drift inventory share one role enumeration. A list call that starts while an enumeration runs gets its result and does not start a second enumeration. A role installation or removal still excludes every list.
- **Timing log line.** The broker writes "Broker telemetry Roles and features: read in <ms> ms (<count> components)." for the first successful role read after its start and for every read of 20 seconds or more.
- **Customer move.** Moving a device to another customer does not cause the error. The move sends no job and no inventory refresh to the agent.

`ServerDesk.Agent.exe --features-self-test` checks the time budget, the shared enumeration and the timing line. `--broker-self-test` checks the joined broker reads, and `--failure-paths-self-test` checks the device page lines of a slow read and of a real failure.

## Fixes in 4.21.4

- **Runbook diagnosis class.** The agent now classifies a runbook diagnosis by the same rule as the portal. A diagnosis without script runs as a parallel job only when its operation parameters are valid for its operation. For example, `test-connection` needs a valid host and an integral port from 1 to 65535. Agents up to 4.21.3 did not check the operation parameters. They ran a diagnosis with invalid parameters as a parallel job, but the portal claimed it as an exclusive job.
- **Self-test.** `ServerDesk.Agent.exe --jobs-self-test` checks the agent with the same cases as the portal tests. The portal rule does not change.

## Fixes in 4.21.3

- **Update inventory.** Windows Update gives no severity (`MsrcSeverity`) for some pending updates, for example the Defender security intelligence updates. Agents up to 4.21.2 wrote `null` for it into `updates.json` and then rejected the whole file when they read it. Every heartbeat then reported the collection error "The last update inventory could not be read." without an `updates` block, so the device showed "Inventory incomplete".
- **Empty text for missing fields.** `NormalizeUpdates` now reads a missing or `null` `title`, `kb` or `severity` as `""`, and the update search writes `""` instead of `null`. An `updates.json` of an older agent works again after the agent update, with no new update search. The portal shows such an update with the priority "Not specified". A field with another type, for example a number, still rejects the file as corrupt.

`ServerDesk.Agent.exe --self-test` reads an inventory with a `null` severity, a missing severity and a `null` KB, and checks that a numeric field is still rejected.

## Fixes in 4.21.2

Agent 4.21.2 is the minimum agent version of the DNS plugin 1.0.1.

- **Plugin reads.** Agents 4.16.0 to 4.21.1 could not upload the data of a plugin read. The upload failed with "The node already has a parent". This stopped the DNS and DHCP reads from the portal and the periodic reads. `PluginProtocol.ReadResult` now gives the data as a copy without a parent. The shared builder `PluginProtocol.UploadMessage` makes the upload message.
- **Job messages.** A plugin job always ends with a code. A failed upload gives `AGENT_PLUGIN_UPLOAD_FAILED`. Any other failure without a code gives `AGENT_PLUGIN_FAILED`. The exception text goes only to the agent log.

`ServerDesk.Agent.exe --plugin-self-test` checks the upload with the real builder, a read job with and without `actAs`, a periodic read and both codes. `ServerDesk.Plugin.Dns.exe --self-test` sends a realistic server read, a zone read and an empty zone through the protocol and the builder.

## Plugin report in 4.21.1

Agent 4.21.1 keeps the last entry of a plugin in the status report while the plugin runs. This applies to a read, an install and a removal. After a plugin install or removal, the report thus keeps all installed plugins. A new plugin shows in the next heartbeat. For the details, refer to [Report](agent-plugins.md#report).

## Parallel jobs in 4.21.0

Agent 4.21.0 runs some jobs at the same time on one device. It reports the capability `parallel-jobs`. For example, a Defender quick scan runs during an update search, and an inventory refresh runs during an update installation.

Each job kind has one concurrency class. The portal states it in `lib/server/devices/jobs/concurrency.ts`, the agent in `agent/v3/JobConcurrency.cs`. A source test compares the two tables.

- **parallel.** The job changes nothing on the device. It runs next to other parallel jobs and next to one exclusive job. It never runs next to a sole job.
- **exclusive.** The job changes the device. At most one exclusive job runs on a device. Parallel jobs can run next to it.
- **sole.** The job needs the device alone. The portal claims it only when no other job runs. While it runs, the portal claims no job.
- **Group.** Some kinds have a group. At most one job of a group runs on a device, whatever its class. For example, the group `windows-update` stops an update search during an update installation.
- **Cap.** At most 4 jobs run on one device at the same time.

### Claim

The portal claims jobs in queue order. One channel poll can claim more than one job, up to the cap.

- A sole job that cannot start, because a job runs or an earlier change waits, stops the claim of this poll. No later job overtakes it, so an agent update is not starved by reads.
- An exclusive job that cannot start holds all later exclusive and sole jobs of this poll. So changes keep their queue order. Later parallel jobs can still start.
- A parallel job that cannot start, for example because its group is busy, stays pending. Later jobs can start.

The claim `UPDATE` checks the class atomically, next to the rights and the scope. Exclusive and sole jobs take the device lease as before. Parallel jobs take no device lease. The claim stores the class in `jobs.concurrency` and the group in `jobs.concurrency_group`. A running job without a class was claimed before the migration `0029_parallel_jobs.sql`. The portal counts it as sole.

The agent reports its running jobs in each poll. If the portal does not know a reported job as running, for example because it expired, the portal also counts that job as sole.

The JobRunner of the agent checks the same rules again before a job starts. A job that breaks them ends with `AGENT_BUSY`, or with the busy code of the agent update or uninstall. The queue rules stay: at most 20 waiting jobs, one GPU driver job and the Defender rules.

### Older agents

An agent without `parallel-jobs` gets one job at a time, as before. The portal claims no job while the agent reports a running job or while a job of the device runs. One poll claims at most one job.

### Classes

| Kind | Class | Group | Reason |
|---|---|---|---|
| `refresh` | parallel | `inventory` | Only requests a telemetry collection. |
| `scan-updates` | parallel | `windows-update` | Searches only. Not during an update installation. |
| `test-connection` | parallel | none | Network read. |
| `start-service`, `stop-service`, `restart-service`, `set-service-startup` | exclusive | none | Changes services. |
| `install-feature`, `remove-feature` | exclusive | none | Installs or removes roles. |
| `set-network`, `set-dns`, `set-rdp`, `set-pagefile`, `set-task` | exclusive | none | Changes the configuration. |
| `join-domain`, `leave-domain`, `rename-computer` | exclusive | none | Changes the identity. |
| `create-local-user`, `set-local-user`, `reset-local-password`, `delete-local-user`, `local-group-add`, `local-group-remove` | exclusive | none | Changes accounts. |
| `set-firewall-rule`, `add-firewall-rule` | exclusive | none | Changes the firewall. |
| `schedule-power`, `cancel-power-schedule` | exclusive | none | Writes a scheduled task. |
| `restart-computer`, `shutdown-computer` | sole | none | Ends all running jobs. |
| `install-updates` | exclusive | `windows-update` | Installs updates. |
| `install-gpu-driver` | exclusive | none | Installs a driver. |
| `defender-quick-scan`, `defender-full-scan` | parallel | `defender` | Changes no configuration. |
| `defender-update-signatures` | exclusive | `defender` | Installs signature content. |
| `defender-clean-detections` | exclusive | `defender` | Removes files. |
| `list-files` | parallel | none | File read. |
| `create-directory`, `rename-file`, `delete-file` | exclusive | none | File change. |
| `storage-inspect` | parallel | `storage` | Disk read. Not during a disk change. |
| `storage-initialize`, `storage-set-disk`, `storage-new-volume`, `storage-resize`, `storage-drive-letter`, `storage-format`, `storage-delete-partition` | exclusive | `storage` | Disk change. |
| `desired-state-test`, `desired-state-apply` | exclusive | none | DSC runs one operation at a time. |
| `list-processes`, `list-sessions`, `list-connections`, `network-diagnostics`, `query-events`, `export-events`, `support-bundle` | parallel | none | Diagnostic reads. |
| `kill-process`, `message-session`, `disconnect-session`, `logoff-session` | exclusive | none | Acts on processes and sessions. |
| `runbook-step`, fixed diagnosis without script, with valid operation parameters | parallel | the group of its operation | Same work as the console job. |
| `runbook-step`, script or invalid operation parameters | exclusive | none | Script, or not a valid fixed diagnosis. |
| `assistant-powershell` | exclusive | none | Script as SYSTEM. |
| `plugin-job`, read (`dhcp-read`, `dns-read`, `dns-zone-read`) | parallel | `plugin:<plugin>` | Read. |
| `plugin-job`, change | exclusive | `plugin:<plugin>` | Change. |
| `plugin-job`, unknown operation or other plugin | sole | none | Fail-safe. |
| `ad-sign-in` | parallel | none | Checks an account. |
| `plugin-install`, `plugin-remove` | sole | none | Replaces SYSTEM code of the plugin jobs. |
| `agent-update`, `agent-uninstall` | sole | none | Needs the device alone. The terminal, RDP and transfer rules stay. |
| Any other kind | sole | none | Fail-safe. |

`ServerDesk.Agent.exe --jobs-self-test` checks the class of each row and the start rules of the JobRunner. `--self-test` runs the same checks.

## DNS plugin reads in 4.20.0

Agent 4.20.0 is the minimum agent version of the DNS plugin 1.0.0. For the plugin, refer to [DNS server](dns-server.md).

- **Reads.** `PluginHost.ReadOperation` is true for `dhcp-read`, `dns-read` and `dns-zone-read`. These three operations run also in ReadOnly mode, as SYSTEM and without `actAs`.
- **Policy.** The signed plugin policy can contain `dns-read` every 15 minutes. The broker keeps it and still drops every change operation, for example `dns-record-add`.
- **Changes.** A DNS change is a plugin job with `actAs`, as a DHCP change. It needs Management mode.
- **Refusal.** The code `PLUGIN_DNS_ACCESS_DENIED` in a run with an account becomes `AGENT_PLUGIN_ACCOUNT_DENIED`. Its text names the groups DnsAdmins and DHCP Administrators.

`ServerDesk.Agent.exe --plugin-self-test` checks the three reads in ReadOnly mode, the policy and the rewrite of `PLUGIN_DNS_ACCESS_DENIED`.

## AD sign-in for plugin changes in 4.19.0

Agent 4.19.0 runs plugin changes with the AD account of the technician. It reports the capability `plugin-ad-identity`. For the design, refer to [AD sign-in for plugin changes](plugin-ad-sign-in.md).

- **Directory.** The security telemetry adds `security.directory` with `kind` (`domain` or `local`), `name`, `netbiosName` and `sid`. The broker reads it through `LsaQueryInformationPolicy`, without network. An older agent leaves it out.
- **Job `ad-sign-in`.** The broker opens the sealed password and calls `LogonUserW` with a network logon. It answers the user SID, `DOMAIN\name`, the UPN and the directory. The job also runs in ReadOnly mode, because it changes nothing. The password never goes to the result or the log.
- **Changes.** A plugin change carries `actAs`. The broker starts the plugin with an S4U token of that account. For the codes, refer to [agent plugins](agent-plugins.md#plugin-jobs-that-change-a-server).
- **Folder.** `plugins\` gives Authenticated Users read and execute. The broker adds this entry one time to an install from 4.16, 4.17 or 4.18.

## Tamper protection in 4.18.0

A Protected Process Light is not possible for the agent. It needs a driver that Microsoft signs and a membership in the Microsoft Virus Initiative. Agent 4.18.0 therefore hardens the services, checks them and reports each change to the portal. The portal shows these reports as alarms. Refer to [Alert rules](alert-rules.md#agent-tamper-protection).

### Recovery

Both services, `ServerDeskAgent` and `ServerDeskWorker`, have these failure actions:

- Restart after 5 seconds, then after 30 seconds, then after 60 seconds.
- Reset the failure count after one day (86400 seconds).
- Also restart when the service stops with an error code.

The installer sets the failure actions and reads them back. If they differ, the installation rolls back, like a wrong service DACL. The broker also applies them at each start, so a portal update brings them to older installations. The setup handle has the right `SERVICE_START`, because Windows requires it for a restart action. To see the values, run `sc.exe qfailure ServerDeskAgent` and `sc.exe qfailure ServerDeskWorker`.

### Integrity check

The broker checks what the installer set:

- At each start, before it repairs the policy.
- Every 5 minutes.
- In 10 seconds or less after a change to the registry key of a service.

The check reads the start type of both services. It compares the service DACL and owner, the service SID type and the failure actions with the installer policy. It also checks the agent folder `%ProgramData%\ServerDesk` and its `current` folder, and the folders `plugins` and `updates` when they exist. A safe folder has the owner SYSTEM or Administrators, a protected DACL, and no write access for another account. The check does not read the files in the folders.

When a protection differs, the broker reports the change and restores the installer state with the installer functions. Then it checks again and reports whether the repair was successful. A start type is reported, but the broker never changes it back. To set the services to **Disabled** is the documented way to remove the agent by hand.

The broker keeps a baseline file with its version and a hash of the policy. At start, it reports a difference only when a baseline of the same version exists. Thus, the first start of a new version and the first start after `--install` repair silently. Updates do not cause a protection alarm.

### Events

The agent reports these events to `POST /api/agent/integrity`:

| Event | Meaning |
|---|---|
| `service-stopped` | Somebody stopped a service. |
| `service-ended` | A service ended without a stop request, for example after a crash or a killed process. |
| `service-hung` | The watchdog ended a worker that did not respond. |
| `service-restarted` | The watchdog started a stopped worker. |
| `broker-unresponsive` | The broker did not answer the worker for 3 minutes. |
| `start-type-changed` | A service does not start automatically. |
| `agent-removed` | A local `--uninstall`, or a deleted service. |
| `protection-changed` | A service DACL, a service SID, the failure actions or a folder ACL differed. |

The broker keeps pending events in `%ProgramData%\ServerDesk\integrity-events.json`, at most 50. The worker sends them to the portal in 15 seconds when the portal is available. The portal confirms the event IDs, and the broker then deletes these events. The heartbeat also sends the snapshot `agentIntegrity` with both start types and the differences that the repair could not remove. The agent reports this with the capability `agent-integrity`.

When somebody stops the worker, the worker sends one last event in a maximum of 5 seconds. It sends `agent-removed` when a service is marked for deletion, else `service-stopped`. A stopped broker reports `service-stopped` at its next start. A broker that ended without a stop reports `service-ended` at its next start, but not after a restart of Windows. A local `--uninstall` sends `agent-removed` with the Windows user before it removes the agent. It continues if the portal is not available, and it shows whether it informed the portal.

### Watchdog

The broker and the worker watch each other:

- The broker starts a worker that is stopped in two checks of 15 seconds. It does this only when the start type is automatic.
- The broker ends a worker that made no request for 3 minutes. The failure actions then restart it.
- The worker reports a broker that does not answer for 3 minutes, once for each outage.

The worker cannot start or end the broker, because it has no right to do so. The failure actions restart a broker that ended. For the details, refer to [Agent broker and worker](agent-broker-worker.md#watchdog).

### Planned contexts

These contexts create no stop event, and the watchdog does nothing while they last:

- A shutdown or restart of Windows.
- An agent update.
- A local installation or uninstall.
- An uninstall from the portal.

The portal also stores stop events as planned during an agent update of the device. This also applies in 30 minutes after the claim of the update. Planned events make no alarm and no audit row.

### Limits

- An administrator can always stop, disable and remove the agent. The service DACL keeps full control for SYSTEM and Administrators, and no entry denies Administrators.
- There is no kernel driver, no protected process and no password for a stop or an uninstall.
- The worker reports a broker that hangs, but it cannot restart it.
- An uninstall from the portal and an update to a fixed version stay the first way out of a bad agent build.

## Remove the agent by hand

Use this procedure only when the agent does not work and `ServerDesk.Agent.exe --uninstall` fails. You must be a local administrator. Do the steps in this sequence:

1. Set both services to Disabled, so that the failure actions and the watchdog do not restart them:

   ```powershell
   sc.exe config ServerDeskWorker start= disabled
   sc.exe config ServerDeskAgent start= disabled
   ```

2. End the processes `ServerDesk.Agent.exe`, for example with `taskkill /F /IM ServerDesk.Agent.exe`.
3. Delete the worker service first, then the broker service:

   ```powershell
   sc.exe delete ServerDeskWorker
   sc.exe delete ServerDeskAgent
   ```

4. Delete the scheduled task "ServerDesk Update Recovery": `schtasks /Delete /TN "ServerDesk Update Recovery" /F`.
5. Remove the folder `%ProgramData%\ServerDesk` and all folders `%SystemRoot%\Temp\ServerDesk-Uninstall-*`.
6. Remove the firewall rules "ServerDesk Plugin *" and "ServerDesk RTC *".
7. Remove the registry keys `HKLM\SYSTEM\CurrentControlSet\Services\ServerDeskAgent` and `HKLM\SYSTEM\CurrentControlSet\Services\ServerDeskWorker` if they still exist.
8. Optional: remove the orphaned worker SID from the groups "Performance Monitor Users" and "Event Log Readers".
9. Remove the device in the portal.

The agent writes no other registry keys. Its only registry values are in the two service keys, for example `Environment`.

In Safe Mode, the services do not start. Thus, start Windows in Safe Mode and do steps 3 to 9.

This removal causes alarms in the portal when the agent can still send them. Step 1 causes **Agent stopped or start type changed**. A deleted service that is still running causes **Agent removed outside the portal**. Then remove the device in the portal.

To remove a bad agent build, first use the uninstall from the portal or an update to a fixed version. Use the removal by hand only when these do not work.

## Fixes in 4.17.2

The agent reads the NVIDIA driver version through NVML. Before, it loaded the NVML library once at the start of the worker, so after a driver update NVML could report the old version. Now the agent compares the Windows driver version of each NVIDIA card with the version at the last start of NVML. If the version changed, the agent stops NVML, frees the library and loads it again. If the new start fails, the agent tries again after 1 minute, and the inventory has no NVML version until then. For the portal rules, refer to [GPU driver updates](gpu-driver-updates.md#status-rules).

## Fixes in 4.17.1

The broker checks each Authenticode signature of a GPU driver package: the primary signature and each nested signature. It reads the signer certificate from the same `WinVerifyTrust` call that verified the signature. The package must have one valid signature of the pinned vendor organization with a SHA-256, SHA-384 or SHA-512 digest. A signature with SHA-1 does not count. For the rules, refer to [GPU driver updates](gpu-driver-updates.md#download-and-signature).

The worker removes a stale GPU driver download before it starts a new one. A read of the stale download at the same time now gets the error "Unknown GPU driver download.", not an internal error.

## Assistant scripts in 4.17.0

Agent 4.17.0 runs a PowerShell script that a user started from the device assistant. It reports the capability `assistant-powershell`. The portal sends this job kind only to an agent that reports the capability. An older agent never gets the job.

- **Job.** The job kind is `assistant-powershell` with the parameters `script` (1 to 8,000 characters) and `timeoutSeconds` (10 to 600, 120 by default). The agent refuses other parameters, control characters other than newline, carriage return and tab, and a time limit outside the range.
- **Mode.** The job runs only in Management mode. In ReadOnly mode, it fails with `AGENT_ASSISTANT_MANAGEMENT_REQUIRED`.
- **Run.** The broker runs the script as SYSTEM in the embedded script host of the runbooks, without parameters. At the time limit, the broker stops the host and its child processes.
- **Result.** The result has `output` (at most 32 KiB), `stderr` (at most 8 KiB), `exitCode` and `truncated`. Exit code 0 gives `AGENT_ASSISTANT_SCRIPT_COMPLETED`. Another exit code gives `AGENT_ASSISTANT_SCRIPT_FAILED` with the error text.
- **Refresh.** After a successful script, the broker requests an inventory refresh, as after a runbook step.

The portal side, the rights and the audit are in [AI assistant](ai-assistant.md).

## Plugin secrets in 4.17.0

Agent 4.17.0 also adds the capability `plugin-secrets`. A `plugin-job` can carry sealed secrets in `secretParameters`, for example the shared secret of a DHCP failover relationship. The portal seals them with the public key of each device, as for a Runbook step.

- The broker opens the sealed box with the device key. It gives the values to the plugin as `parameters.secrets`.
- The broker masks the values in the job result, in the message and in the plugin errors that it writes to the log.
- If the box does not open, the job fails with `AGENT_PLUGIN_SECRET_INVALID` before the plugin starts.

The rest of the plugin host does not change. DHCP plugin 1.1.0 also runs on agent 4.16.0. Only a new shared secret needs 4.17.0. For the details, refer to [agent plugins](agent-plugins.md).

## Plugins in 4.16.0

Agent 4.16.0 adds a plugin host to the SYSTEM broker and reports the capability `plugin-host`. A plugin is a separate signed EXE, for example the read-only DHCP plugin. It is not part of the agent ZIP.

- **Jobs.** The new actions `plugin-install`, `plugin-remove` and `plugin-job` run in ReadOnly and Management mode. A `plugin-job` other than `dhcp-read` needs Management mode.
- **Folder.** The broker keeps the plugins in `%ProgramData%\ServerDesk\plugins\<name>\` with a protected DACL for SYSTEM and Administrators.
- **Start.** Before each start, the broker checks the signature, the hash and the folder permissions. The plugin runs in a job object, without network access.
- **Report.** The heartbeat snapshot gets the key `plugins` with at most 16 entries.
- **Collection.** The broker reads a plugin on its own only under the signed `plugin-policy` of the channel. The relay kind `plugin-data-upload` sends the result to `/api/agent/plugin-data`.

An agent update keeps the plugins. `--uninstall` removes them and their firewall rules. The self-test `--plugin-self-test` checks the verification, the protocol, the job object and the policy. For the details, refer to [Agent plugins](agent-plugins.md).

## Microsoft Defender actions in 4.15.0

Agent 4.15.0 runs four Microsoft Defender actions as signed jobs. Each action is one static WMI method in the namespace `root\Microsoft\Windows\Defender`. These are the methods of the PowerShell commands `Start-MpScan`, `Update-MpSignature` and `Remove-MpThreat`. The agent starts no command interpreter, no `MpCmdRun` and no other process.

| Job kind | WMI class and method | Parameters | Wait |
|---|---|---|---|
| `defender-quick-scan` | `MSFT_MpScan.Start` | `ScanType` 1 | 60 seconds |
| `defender-full-scan` | `MSFT_MpScan.Start` | `ScanType` 2 | 60 seconds |
| `defender-update-signatures` | `MSFT_MpSignature.Update` | none (the update source of the device) | 15 minutes |
| `defender-clean-detections` | `MSFT_MpThreat.Remove` | none | 10 minutes |

`MSFT_MpThreat.Remove` has no parameter for one threat. It acts on all active threats. For this reason, the portal calls the action "Clean all active detections". The agent does not change preferences, exclusions, allowed threats or the quarantine.

- **Capabilities.** The agent reports each job kind as a capability. The jobs run only in Management mode. In ReadOnly mode, they fail with `AGENT_READONLY`.
- **Scans.** A scan can take hours, and only one Defender job runs at a time. So the scan job waits a maximum of 60 seconds. If the scan is still running, the job ends with "started". The broker keeps the WMI call in a scan slot until Defender returns.
- **Scan slot.** A device has a maximum of one scan that the portal started. A second scan job fails with `AGENT_DEFENDER_SCAN_RUNNING`. When the call ends, the slot is free and the broker requests an inventory refresh. The broker releases a slot after 24 hours.
- **Snapshot key.** While the slot is busy, the Heartbeat has the top-level key `defenderScan` with `kind` (`quick` or `full`) and `startedAt`. The worker gets it from the broker status. The strict key `defender` does not change, so older portals ignore the new key.
- **Signatures.** After the update, the agent reads `AntivirusSignatureVersion` from `MSFT_MpComputerStatus` and sends it in the result.
- **Clean.** The agent counts the active threats (`MSFT_MpThreat.IsActive`) before and after the call. With no active threat, it does not call `Remove`. When threats are still active after the call, the job fails and gives both counts.
- **Refresh.** After each Defender job, also after a failed job, the broker requests an inventory refresh. The collector "Defender" then reads the new state at once.

A missing Defender namespace or class, or the mode "Not running", gives `AGENT_DEFENDER_UNAVAILABLE`. A result code other than 0 gives `AGENT_DEFENDER_ACTION_FAILED` with the code. The self-test `--defender-control-self-test` checks the scan slot, the clean outcomes, the signature version and the timeouts with a simulated provider.

## Microsoft Defender in 4.14.0

Agent 4.14.0 reports the state of Microsoft Defender in the new snapshot key `defender`. The broker reads it every 5 minutes as the fixed, argument-free collector "Defender" with a deadline of 20 seconds. The agent has the capability `defender-status`. The key `security.defender` does not change, so older portals keep their data.

- **Status.** From `MSFT_MpComputerStatus`: the mode (`AMRunningMode`), antivirus, real-time and tamper protection, the last quick and full scan, the signature time and version, and the product version.
- **Detections.** From `MSFT_MpThreatDetection` and `MSFT_MpThreat`: the newest 100 detections with name, severity, status, the first file path, the number of files, the time and the user. The agent also sends the total, the number of active detections and the highest active severity.
- **Exclusions.** From `MSFT_MpPreference`: the excluded paths, file extensions and processes, at most 200 of each.
- **Other antivirus.** From `root\SecurityCenter2` `AntiVirusProduct`: at most 4 third-party products with name and state. Windows Server has no Security Center, so the agent sends `null`.

The collector only reads. It starts no scan, updates no signatures, removes no threat and changes no preference. The self-test `--defender-self-test` checks the mappings and the limits. For the fields, refer to [Microsoft Defender](v3-health-signals.md#microsoft-defender-in-4140).

## Fixes in 4.13.2

When the broker is not available, the terminal, relay and channel loops of the worker wait 2, 4, 8, 16 and then 30 seconds. They log at most one line per 30 seconds, as after a portal failure. After a broker restart, a call on an idle connection opens a new connection once and sends the request again in the same timeout. A request that changes the device is sent again only when it did not reach the broker.

## GPU driver updates in 4.13.0

Agent 4.13.0 installs NVIDIA and AMD graphics driver updates that you start in Hardware → GPU. It has the capability `install-gpu-driver`, which runs only in Management mode. The worker downloads the vendor package from a fixed vendor host through the new relay kind `gpu-driver-open`. The broker checks the signature of the vendor and starts the installer with fixed silent arguments. The agent never restarts the device.

The agent also reports the AMD Software version as `vendorDriverVersion` of AMD adapters. The details are in [gpu-driver-updates.md](gpu-driver-updates.md). The new self-test is `--gpu-driver-self-test`.

## Origin-independent release manifests in 4.12.0

A signed release manifest names each file with its SHA-256 and size. Since 4.12.0, the manifest can name a file in two forms:

- **Path form.** Each file entry has `path`, for example `/downloads/ServerDesk-Agent-4.12.0-win-x64.exe.part1`. The manifest contains no portal address. One publisher signature is then valid on every installation.
- **Absolute form.** Each file entry has `url` with a full HTTPS address on one portal origin. Agents before 4.12.0 know only this form.

All file entries of one manifest use the same form: the manifest itself, each item of `parts`, `exe` and each item of `exe.parts`. A manifest with entries of both forms is not valid. An entry with both `path` and `url` is not valid. Each validator applies these rules: the portal, the agent, the PowerShell installer and the release scripts.

A valid path starts with `/downloads/` and names one file directly below it. The file name starts with a letter or a digit and has a maximum of 200 characters. It contains only letters, digits, `.`, `_` and `-`, and no `..`. The check is case-sensitive.

The agent verifies the signature over the received bytes first. Then it resolves each path against its registered portal origin, with scheme, host and port. For the absolute form, the agent keeps the same-origin check of older versions. The agent reports the capability `release-paths` in its heartbeat.

The portal accepts only the path form, so each release has one envelope:

- The portal has no built-in release. It imports the path-form releases of the CI from GitHub or from a folder and gives their files to the agents under `/downloads/`. For the checks, the rate limit of GitHub and the offline import, refer to [Agent releases from GitHub](self-hosting.md#agent-releases-from-github).
- Each release keeps the exact bytes that its publisher signed. The portal does not convert or sign a manifest.
- `GET /Agent-v3-release.json` gives the envelope of the newest imported release, with or without the query `form=path`. The native installer and the PowerShell installers use it.
- A rollout gives this envelope only to a device that reports `release-paths`. The portal refuses the rollout to an agent before 4.12.0. Install the current agent on such a device one time locally.

`scripts/sign-agent-release.mjs` and the CI workflow sign the path form. `scripts/agent-release.mjs verify` refuses a record in the absolute form. It also checks that each part is the matching 20 MiB slice of the ZIP or the EXE. `verify` does not compare the unsigned `notes.md`. With `--check-notes`, it also compares `notes.md` with the notes that the checkout generates. The release workflow uses `--check-notes`.

## Fixes in 4.11.1

Agent 4.11.1 reads the drivers without WMI, through CfgMgr32 and the registry. An offline catalog check of the INF file gives the signature. Each run spends at most 20 seconds on INF files that are not in the cache. The collector deadline is 45 seconds, and the broker call of the worker waits 60 seconds. On a Windows host, `--drivers-probe` shows the time of two driver reads.

When a collector fails, the snapshot field `collectorErrors` contains a code for it. The worker keeps the last driver list. Log lines name the collector, the exception type, the code and the elapsed time. After a proxy or portal failure, the channel and terminal loops wait 2, 4, 8, 16 and then 30 seconds. The contract is in [v3-health-signals.md](v3-health-signals.md#collector-errors-in-4111). The new self-test is `--failure-paths-self-test`.

## Health signals in 4.11.0

Agent 4.11.0 reports five more health signals. The wire protocol stays version 3, and all new fields are optional. Agents of version 4.10.x and older continue to report without change. The contract is in [v3-health-signals.md](v3-health-signals.md#health-signals-in-4110). The portal side is in [device-health-signals.md](device-health-signals.md).

The SYSTEM broker collects the signals as fixed reads without arguments: `Drivers`, `Reliability`, `Disk and battery health`, `Certificates` and `Autostart`. Each read has its own deadline and never blocks the 30-second heartbeat. A failure becomes one line in `collectionErrors`. The agent runs each read every 900 seconds. An explicit refresh also starts them.

- **Drivers.** The agent reads `Win32_PnPEntity` for devices with an error code, `Win32_PnPSignedDriver` for the drivers and `Win32_SystemDriver` for the file of a driver service. A device ID never leaves the device. The agent sends a hash of it. The worker sends the full list to `POST /api/agent/drivers` only when its checksum changes or when the portal asks with `driverResync`.
- **Reliability.** The agent reads Application Error 1000 and Application Hang 1002 from the Application log. It reads `Win32_ReliabilityRecords` for failed installations and `Win32_ReliabilityStabilityMetrics` for the stability index. Windows Server collects no reliability data by default. Then the agent reports the reason and no value.
- **Disk and battery health.** The agent reads `MSFT_PhysicalDisk` and the reliability counters of each disk. It reads disk errors of the last 30 days from the System log and the battery capacity from `root\wmi`. A counter that a disk does not report stays empty. The agent sends no serial numbers.
- **Certificates.** The agent opens the stores `My`, `WebHosting` and `Remote Desktop` of the local computer read-only. It reads the http.sys bindings from the registry and the certificate of the RDP listener. It reads only whether a private key exists. Private keys and certificate files never leave the device.
- **Autostart.** The agent reads the Run and RunOnce keys, the Startup folders and Winlogon `Shell` and `Userinit`. It adds services with the start mode Auto and enabled scheduled tasks that are not from Microsoft. It masks passwords and tokens in command lines and removes user names and SIDs. It checks signatures locally, without revocation checks. The worker sends the list to `POST /api/agent/autostart` only when its checksum changes or when the portal asks with `autostartResync`. The drift category `autostart` uses the same reader.

The new self-tests are `--drivers-self-test`, `--reliability-self-test`, `--disk-health-self-test`, `--certificates-self-test` and `--autostart-self-test`. On a Windows host, `--health-signals-probe` shows the result of the five reads.

## Health signals in 4.10.0

Agent 4.10.0 reports four health signals. The wire protocol stays version 3, and all new fields are optional. Agents of version 4.9.x continue to report without change. The contract is in [v3-health-signals.md](v3-health-signals.md). The portal side is in [device-health-signals.md](device-health-signals.md).

The SYSTEM broker collects three signals as fixed reads without arguments: `Crashes`, `BitLocker` and `Software inventory`. Each read has its own deadline and never blocks the 30-second heartbeat. A failure becomes one line in `collectionErrors`. The agent reads crashes and software every 900 seconds and BitLocker every 300 seconds. An explicit refresh also starts them.

- **Crashes.** The agent reads the System and Application event logs of the last 30 days: bugchecks (1001), Kernel-Power 41, EventLog 6008 and WHEA errors. Events within 10 minutes are one crash. The agent also parses the minidumps in `%SystemRoot%\Minidump` for the stop code and the probable driver. From 4.13.1, it opens each dump without following links or junctions, checks the opened file and does not look up reserved device names. Dumps, memory and paths never leave the device.
- **Operating system.** The snapshot field `osInfo` contains `EditionID`, `InstallationType`, `DisplayVersion`, `UBR`, `ProductName` and `CurrentBuild` of the registry key `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`.
- **Software.** The agent reads the uninstall keys of the 64-bit and 32-bit views and of the loaded user hives. Every heartbeat contains the checksum `softwareChecksum`. The worker sends the list to `POST /api/agent/software` only when the checksum changes or when the portal asks with `softwareResync`.
- **BitLocker.** The agent reads `Win32_EncryptableVolume` and calls only the methods that read the status. It never reads a recovery password and sends no protector IDs. The broker keeps the start of a suspension in `bitlocker-state.json`.

The new self-tests are `--crash-self-test`, `--software-self-test` and `--bitlocker-self-test`.

## Portal uninstall in 4.9.0

An Owner can let the agent uninstall itself when the device leaves the portal. In the removal dialog, set **Uninstall the agent on the device**. The portal then sends a signed `agent-uninstall` job and does not revoke the device yet. The job needs the Owner right, the device right `manage`, MFA and a new step-up proof. The agent runs the job in ReadOnly and in Management mode.

The agent first checks the conditions of a local `--uninstall`, in this sequence:

1. The broker runs with administrator rights.
2. The broker runs as the installed service from `%ProgramData%\ServerDesk\current`.
3. No local installation or maintenance runs.
4. No agent update is pending.
5. No other job runs.
6. No terminal or Remote Desktop session is open.
7. No file transfer runs.

If a condition is false, the agent reports the failure with its message code. The device stays registered, and the offboarding panel shows the reason. You can try again, or remove the device without the uninstall.

When all conditions are true, the broker creates the folder `%SystemRoot%\Temp\ServerDesk-Uninstall-<jobId>\` and copies its EXE into it. If a file or folder with this name already exists, the broker refuses it, does not change it and reports `AGENT_UNINSTALL_STAGE_FAILED`. Only SYSTEM and Administrators have access to the new folder. The broker compares the length and the SHA-256 of the copy with the running EXE. Then it reports that the uninstall started (`AGENT_UNINSTALL_STARTED`). From this point, the broker starts no new job, terminal or transfer.

The portal revokes the device only when it receives this result. It uses the same cleanup as a removal without the uninstall. The broker starts the copy with `--uninstall --detached <jobId>` only when the portal confirms the revocation. The portal confirms it in one of two ways:

- It accepts the request that carries the start result. If the portal did not revoke the device, it answers with `409` and `AGENT_UNINSTALL_NOT_CONFIRMED`.
- It refuses a later request of the device with `403` and `AGENT_UNINSTALL_CONFIRMED`. Each channel request names the uninstall job in the header `X-ServerDesk-Uninstall-Job`, and only this job ID gets the code.

A `401` or a `403` without this code, for example from a proxy, is not a confirmation. Right before the start, the broker calculates the SHA-256 of the copy again. It keeps the copy locked against changes until the start. If the copy changed, the broker does not start it. Agent 4.10.1 and later apply these checks.

Without the confirmation, the agent stays installed. This also applies after 10 minutes without an answer, after a `409` and after a restart of the broker. The broker then deletes the copy.

When the broker deletes a staging folder, it never follows a junction or symbolic link. At start, it deletes the staging folders of uninstalls that did not start. It does not delete a folder that is a link. When the broker runs as a service, it also keeps a folder that SYSTEM or Administrators do not own.

The detached process removes the services, the recovery task, the credentials and all files under `%ProgramData%\ServerDesk`. The portal does not see errors after this start. The process writes its output and each error to `%SystemRoot%\Temp\ServerDesk-Uninstall-<jobId>\uninstall.log`. After a successful uninstall, Windows deletes the copy and its folder at the next restart.

To remove the parts that stay after a failure, download the current `ServerDesk.Agent.exe`. Run it as administrator outside `%ProgramData%\ServerDesk`:

```powershell
& .\ServerDesk.Agent.exe --uninstall
```

## Job result messages in 4.8.0

Each job result in the channel `results` has the fields `id`, `ok`, `message`, `code`, `args` and `data`. For each message that the agent writes itself, success or failure, `code` is a stable name such as `AGENT_FEATURE_NOT_FOUND`. `args` is an object with a maximum of 8 string values, for example a host, a port or the Windows status code. `message` is the English text: the template of the code with the values of `args`. The file `agent/v3/AgentMessages.cs` is the only list of codes and English templates.

The portal keeps `code` and `args` in the columns `result_code` and `result_args`. It shows the catalog text `agentMessage.<code>` in the language of the user. A raw Windows, WMI or IO error text has no code. The portal shows such a text as the agent sent it. Agents before 4.8.0 send no code. For these agents, and for a code that the portal does not know, the portal shows `message`.

All other agent output is English: inventory warnings, storage protection reasons, diagnostics placeholders and log lines.

## Broker and worker in 4.7.0

The EXE now runs as two services:

- `ServerDeskAgent` (LocalSystem) is a broker without network access. It executes jobs, terminals, file operations, drift scans, privileged telemetry and updates. It accepts only work with the ECDSA P-256 signature of the portal (`AGENT_JOB_SIGNING_KEY`). The signature binds the work to the device ID and to a short lifetime.
- `ServerDeskWorker` runs as the restricted virtual account `NT SERVICE\ServerDeskWorker`. It does all communication with the portal through the local pipe `ServerDesk.Broker`.

The RSA device key stays in the broker. The split agent does not supply Remote Desktop. You must uninstall 4.6.x installations and install them again with a new registration. For details, remaining gaps and the Windows checklist, refer to [agent-broker-worker.md](agent-broker-worker.md).

## Hardware inventory in 4.6.7

The optional `snapshot.hardware` contains CPU models, memory modules and slots, physical disks and hardware network adapters. It also contains the system, the BIOS and the mainboard. The collection runs separately from the heartbeat. It has a 15-minute cache, limited provider queries and errors for a partial inventory.

The Hardware area of the device shows these facts together with GPU details and the CPU/RAM utilization history. Measurements that are not available stay unknown. `--hardware-self-test` tests the provider and cache fixtures, and `--hardware-probe` reads the local inventory without a change to the installed service. Refer to [hardware-inventory.md](hardware-inventory.md).

## GPU diagnosis in 4.6.6

An optional `snapshot.gpuDetails` adds physical GPU hardware, Windows driver metadata and dedicated/shared memory usage. It does not change the protocol or the GPU history records. The portal shows a GPU page below the Hardware area of the device, and the GPU card of the overview opens it directly. Available NVIDIA driver sensors add data to the Windows inventory, and unsupported fields stay unknown.

Existing 4.6.5 agents keep their utilization/history display, and you can update them through the portal to get the new details. This release needs no database migration. For provider availability, exact identity matching and validation, refer to [v3-gpu-telemetry.md](v3-gpu-telemetry.md).

## GPU telemetry in 4.6.5

Recognized physical NVIDIA, AMD and Intel Arc adapters report their utilization through native Windows GPU Engine performance counters. The device overview shows each GPU separately. Readings that are not available or too old stay unknown. Hosts without supported hardware get no GPU cards. The Windows release pipeline runs `--gpu-self-test`, and `--gpu-telemetry-sample` is a read-only hardware probe. For sampling, filters for virtual adapters, compatibility and validation, refer to [v3-gpu-telemetry.md](v3-gpu-telemetry.md).

## Reboot status and scheduled tasks in 4.6.4

Required reboots and pending file removals have separate inventory fields. Confirmed markers of Windows servicing, updates and file replacement still require a reboot. Operations with an incorrect format stay conservative.

If ServerDesk folders or tasks are missing in Task Scheduler, no system action is scheduled. Other scheduler failures stay inventory errors. In addition to the existing version, installer and feature checks, the Windows release build runs `--health-self-test`. For the root causes, compatibility and targeted validation, refer to [agent-health.md](agent-health.md).

## DISM display labels in 4.6.3

DISM can return a display label that is null, empty or only whitespace. In this case, version 4.6.3 uses the technical feature name. The feature identifier and the installed state do not change. The targeted tests cover these fallback cases. The native probe reports the inventory and the counts of incorrect names and labels.

## Windows 11 feature inventory fix in 4.6.2

The DISM API returns packed native structures. With the default CLR alignment, the x64 feature array had a 16-byte stride instead of 12. The agent then read the display-name pointer at byte 16 instead of 12. On Windows 11, this caused an unhandled `AccessViolationException` and repeated service recovery. Windows Server uses the separate ServerManager provider and thus did not use that path. Now both DISM structures use the native packing, and the agent copies the metadata to managed strings before it releases the native buffer.

The agent build runs `--features-self-test`. This test covers SDK offsets, a second packed array element, UTF-16 labels, cancellation, cleanup after errors and the cache lifetime.

Run `ServerDesk.Agent.exe --native-features-probe` from an elevated Windows terminal. It does two new read-only DISM inventories. It does not load registration credentials, connect to the portal, install a service or change features. Existing installations can run the current verified EXE with `--install` without a new registration file. The installer keeps the device identity and requires an accepted heartbeat.

## Self-hosting changes in 4.6.1

The self-hosted release trusts the publisher that this repository pins. It accepts HTTPS origins with custom ports, for example a private NAS IP. The release manifests have an offline signature for the exact portal origin. The container gets only the public signature. Refer to [self-hosting.md](self-hosting.md).

## Security changes in 4.6.0

The agent keeps the existing SYSTEM execution context and management features. A dedicated account without administrator rights would need a separate privileged broker with its own authorization. A new local administrator account would keep the power to take control of the host. It would also change the script/HKCU context. Thus the installer and the service startup create and verify an unrestricted SID for each service and trusted SCM owner/access rights.

Normal users keep monitoring rights. The installation requires a successful native readback. The startup writes a repair warning to the log but does not stop an agent that otherwise works. A Windows pilot must verify the real SCM behavior.

Device access tokens change to a 15-minute expiry:

- The agent renews the token five minutes early. It signs a challenge with the existing pinned RSA device key. The previous bearer token stays valid for a maximum of two minutes after the renewal.
- These parts cover parallel requests, installer repairs, restarts, long offline time and lost responses: a separate machine-DPAPI state file, a shared renewal coordinator, a cross-process lock and a retry only for the initial authentication.
- The initial migration waits until the health check and the rollback of an installation or update are complete.
- Agents older than 4.6.0 continue to send heartbeats with their token that does not expire. When the key is pinned, only the heartbeat accepts that token. Thus these agents lose the command channel, release downloads and the other agent routes.
- The heartbeat accepts the old token for a maximum of 30 days after the first heartbeat with the pinned key. After that time, the heartbeat also rejects the token, and the agent shows as offline.
- Install such an agent again locally with the current EXE and its existing `config.bin`. The installer then renews the token with the device key and continues. A new registration is not necessary.

The durable RSA key stays the renewal identity that you can revoke. The shared hosting service credential does not change.

Transfers limit downloaded chunks to the exact expected size. The existing HTTP deadline includes the reads of the response body. The bodies of update packages also obey their existing five-minute HTTP deadline. This release removes no management action of the operating system.

## Native maintenance actions in 4.5.1

The portal can schedule one shutdown or restart for an absolute UTC timestamp, a maximum of 30 days in the future. The Agent uses Task Scheduler COM and the fixed System32 shutdown executable to register a SYSTEM task in `\ServerDesk\Scheduled Power`. The Agent explicitly owns this task. The task stays when the browser closes and across earlier host restarts. If the host is offline at the scheduled time, the task does not run later. A cancellation verifies the exact schedule ID and the owned task definition.

The schedule state is part of the existing cached configuration inventory. A successful change updates the small heartbeat cache of this inventory immediately. These actions do not add PowerShell or a background timer.

`install-updates` keeps the existing payload with the selected IDs and adds `{all:true}` as an alternative. You cannot use both in one request. The portal and the dispatch check the new `install-all-updates` capability before they send that payload. Thus older Agents stay compatible with the selection of single updates. The Agent searches the configured Windows Update/WSUS source again. It uses the full catalog of available software updates, not only the limited inventory on the display.

If a selected update requires user interaction, the preflight refuses the installation before it accepts licenses or downloads updates. Install that update locally, or select other updates explicitly. The license acceptance gets an explicit review. The Agent installs exclusive updates separately. A required reboot stops more batches, and the Agent reports it, so that you can plan a separate restart and a new search. This release adds no automatic restart.

The Windows pilot must still validate these items at runtime: the real COM registration, execution and cancellation, the WSUS policy and the update installation. Linux self-tests examine validation, XML schema and ownership, update batches and compatibility. They do not change a host.

## Reboot/offline defect and collection design

The former service waited until a PowerShell telemetry child process supplied a complete inventory. After a reboot, a slow or blocked Windows provider could exceed the watchdog time of this child. The watchdog then restarted the child again and again, and the service sent no usable heartbeat. Thus a visible service process did not prove that the agent communicated with the portal.

Version 4 collects telemetry in C#:

- Native CPU/RAM/uptime collection and the heartbeat do not wait for all inventories. After a boot, the first snapshot can contain real available values and explicit notices for initialization or missing inventories.
- Each inventory collector has a maximum of one active collection, a deadline and cached results. The collector reports a timeout. It does not start one more abandoned query at each interval.
- The normal telemetry interval is 30 seconds. Version 4.4.0 starts the inventories two seconds apart, with a maximum of two responsive provider calls at the same time.
- Native SCM, drive APIs and persistent PDH counters replace the repeated WMI queries for services, disks and performance.
- The cache time is five minutes for the network/pagefile/security configuration and 15 minutes for the static system/feature/account/firewall/task inventories. For event messages, it is one minute.
- Process paths, event descriptions and the service startup configuration use limited caches. An explicit refresh makes the related caches invalid, and the agent still starts the collections at different times.
- The collection and the management/terminal channels stay independent.

The installer configures delayed automatic service startup and Service Control Manager recovery. The service and an update are successful only after a new heartbeat that the portal accepts. A running PID, a cached health record or a partly collected inventory alone does not satisfy that check. Network errors, hosting-token errors and errors for a revoked device stay real connectivity/admission failures. The agent records them separately.

## Native implementation

| Area | Implementation |
| --- | --- |
| Installation/service recovery | Service Control Manager API, local registry and protected directories |
| Telemetry/process inventory | Win32, .NET, local WMI and Windows Event Log APIs |
| GPU utilization and diagnosis | DXGI/DXCore hardware and driver inventory, kernel adapter identity, language-neutral PDH utilization/memory counters, optional trusted NVIDIA NVML driver sensors |
| Services/startup | Service Control Manager API |
| Server roles and role services | Native ServerManager Deployment Provider; real names, descriptors, dependencies and hierarchy |
| Windows 11 optional features | Inbox DISM API from trusted Windows directories |
| IPv4 and DNS | Typed local Windows network/WMI interfaces; static IPv4 validation and an attempt to roll back |
| Domain membership/computer name | NetJoinDomain, NetUnjoinDomain, NetRenameMachineInDomain and Windows naming APIs |
| Pagefile | Local WMI, new validation of the drive and its free space |
| Local accounts/groups | NetAPI with SID identity and protection of the last enabled local administrator |
| Delayed restart/shutdown | Windows shutdown API and explicit shutdown privilege |
| Windows Update | Windows Update Agent COM, with the existing Windows Update/WSUS configuration |
| Firewall/tasks | Windows firewall and Task Scheduler COM/provider interfaces |
| Disks/partitions/volumes | Windows Storage Management provider, new limits and checks for protected partitions |
| Processes/sessions/events/network diagnosis | Native process, WTS, IP Helper, Event Log and .NET network APIs |
| File browser/transfers | .NET/Win32 handles, checks of canonical paths, SHA-256, durable resumes and atomic commit |
| Drift | Native file watchers, limited directory/registry scans and Windows inventories for each item |
| Browser Remote Desktop | Native RDCleanPath/NLA/TLS loopback proxy, pinning of the listener certificate, encrypted and limited portal transport |

The built-in action router accepts only known actions and validated typed parameters. It does not put user input into PowerShell or into a command interpreter. The agent checks the local DPAPI configuration when it admits a change. Domain controllers, protected agent components and the last enabled local administrator keep their safeguards for each operation.

Version 4.4.0 also has these changes:

- A full drift scan starts a minimum of 60 seconds after the previous one.
- The agent reads the associations of the firewall filters in five batched queries.
- After an upload error, the agent sends one kept report again. It does not calculate the hashes again immediately.
- Unchanged reads of the protected mode use a cache with file stamps and a 15-second fallback. The admission of privileged actions does not use a cache.
- The durable installation state records each transition and renews itself after ten seconds.
- The paused idle RDP channel now polls one time each minute. This does not change the feature pause of the portal.
- A cancellation token for the service lifetime stops all independent loops at shutdown or after a failure.

A full code review and portable regression tests are the basis for this optimization. CPU peaks in a host graph alone do not show that this process causes the usage. To measure the real Windows CPU/RAM/provider savings, keep the application workload and the drift settings the same. Measure over a minimum of two 15-minute inventory cycles. The review found no periodic PowerShell telemetry. PowerShell stays only for explicit user scripts/terminals and for the compilation of compatible legacy DSC.

## Installation, migration and removal

For a new device, download its registration JSON and the current native EXE in **Devices** › **Add device** › **One device**. In an elevated terminal, run:

```powershell
& .\ServerDesk.Agent.exe --install --config .\ServerDesk-Registration.json
```

The JSON contains the device bearer token and the hosting service token. Keep it private. The installer validates an HTTPS portal origin, the exact device identity and the `ReadOnly`/`Management` mode.

It verifies the downloaded executable with the release manifest and the publisher key in the EXE. It creates the SYSTEM broker and the unprivileged worker service. Then it requires a new accepted heartbeat in a maximum of three minutes. After a successful installation, delete the downloaded registration JSON.

For an existing installed agent, run the **newly downloaded EXE outside the installed directory**:

```powershell
& .\ServerDesk.Agent.exe --install
```

The installer reads `%ProgramData%\ServerDesk\config.bin`. It keeps the device ID, the bearer token, the RSA encryption key and the mode. It stays compatible with the machine-DPAPI data of native 3.x installations. It rejects a replacement with a different registration identity or origin.

If a replacement fails, the installer restores the previous installation and the protected configuration, where they exist. If an existing configuration has no service or no current executable, the installer does not use it silently again. It treats the installation as inconsistent.

An installed 3.x updater validates the required PS1 files of the old package. It cannot use the new layout with one EXE. **Migration from 3.x to 4.0.0 therefore requires one local `--install` run.** This is also the recovery procedure when the old agent is offline and cannot get a portal job. Later native releases can update through the portal. Before the replacement, close terminals, transfers and jobs, and complete pending recoveries.

If necessary, select the local mode explicitly:

```powershell
& .\ServerDesk.Agent.exe --install --mode Management
& "$env:ProgramData\ServerDesk\current\ServerDesk.Agent.exe" --set-mode ReadOnly
```

The agent accepts only `ReadOnly` and `Management`. Administrator/operator rights in the portal do not override a local ReadOnly setting. To change the local mode, you must be an elevated administrator, and no work must run. The running service monitors the protected mode. When you remove Management, privileged sessions cannot continue.

For a complete local removal, run the downloaded executable outside `%ProgramData%\ServerDesk`:

```powershell
& .\ServerDesk.Agent.exe --uninstall
```

This removes the service/recovery task, the credentials and the local files. From 4.18.0, it first informs the portal, which shows the alarm **Agent removed outside the portal**. Also offboard or remove the device in the portal.

A revocation in the portal immediately rejects the next authenticated agent requests. The removal in the portal can also uninstall the agent of a device that connects and is idle. Refer to [Portal uninstall in 4.9.0](#portal-uninstall-in-490). The portal cannot delete a Windows service on a device that does not connect.

## PowerShell and Desired State boundaries

User runbooks and interactive terminals use the embedded **PowerShell SDK 7.6.6**. The native service starts child instances of its own EXE. It sends scripts and parameters through private pipes and keeps their process trees in Windows jobs. There is no separately installed `pwsh.exe` and no ServerDesk PS1 helper.

Terminals use ConPTY and keep their own working directory, variables and input/output acknowledgements. Terminal leases, permissions and buffers are separate for each user and session. When the agent closes an abandoned session, it does not use the terminal slot of a different user.

Shells and user code run as SYSTEM. Custom PowerShell, terminal access and DSC test/apply require local Management, authorization in the portal and MFA. The modules and resources of a script must still be on the Windows host. A PowerShell 7 terminal is not necessarily compatible with each Windows PowerShell 5.1 module.

Desired State uses the real local DSC resource engines, not a different configuration language:

| Input | Runtime and prerequisites |
| --- | --- |
| Compiled MOF | Windows DSC 1.1 LCM through local WMI; the MOF bytes go through memory |
| User PowerShell `Configuration` | Inbox Windows PowerShell 5.1 compiles the approved source that it gets through standard input; then the local WMI LCM gets the MOF |
| DSC 3 JSON | Optional DSC 3.2+ that an administrator installed, in major version 3, and its resources below Program Files; the configuration comes through standard input |

The Windows PowerShell 5.1 compiler is the explicit exception for legacy DSC. PowerShell 7 cannot compile the Windows DSC 1.1 `Configuration` syntax. ServerDesk supplies no PS1 compiler helper. But the compiled MOF files stay for a short time in a protected work directory, and the agent deletes them after use.

If you upload a compiled MOF, this compilation step does not occur. The agent does not contain DSC 3, and engines that are missing or not compatible cause an explicit error. The optional scalar parameters of DSC 3 use a temporary protected directory.

The two DSC paths do not require Azure, Entra ID or an Azure Machine Configuration service. The Windows LCM and its resources, or the optional DSC 3 engine, stay prerequisites of the operating system and the resources. You must start Apply explicitly. These controls apply:

- ServerDesk rejects settings for automatic LCM restart or correction.
- It does not stop an LCM execution that is in progress for a different reason.
- After a cancellation, it reports uncertain or partial changes. It does not try them again automatically.

Uploaded user/resource code is privileged code and can do more actions itself. These controls are not a sandbox for configuration code of any type.

## Browser Remote Desktop

Version 4.2.0 has these changes:

- Portal storage and endpoint consumption have separate acknowledgements.
- The agent can upload four batches of 16 frames into its existing window of 64 frames. It does not wait until the browser consumes each batch. It keeps the immutable ciphertext until the browser confirms the delivery.
- The agent does not upload stored ciphertext again.
- The browser gets frames through an independent, limited server long-poll, and input goes to the portal immediately.
- The database carries the opaque payloads. Thus this is an optimized HTTPS transport, not a WebSocket relay with its own infrastructure.
- The exchanges no longer remove historical data. Writes and dispatch still enforce live authorization, expiry and the TTL of queued frames. After a failure, the portal closes and deletes the related data.
- The browser starts at 1280×720 with an optional detail profile.

This release adds no infrastructure and no public RDP port.

Version 4.1.3 isolates network inventory failures for each adapter. It checks the IPv4/IPv6 support before it queries properties that are specific to a protocol. Healthy adapters stay visible. If the agent cannot read the IPv4 configuration, the management controls do not show it, and incomplete network drift cannot set a baseline. The agent finds the ServerManager metadata through the known Windows registration and the documented provider namespace. One scope must contain the deployment class and the request class.

Only missing metadata can select the alternative registration. Access-denied errors and operational errors stay failures. Collection errors keep safe native codes and the provider context. Detailed messages stay in local logs without secret data. Portable regression tests cover these cases. The affected Windows host still needs a check after the update.

Version 4.1.2 collects small TLS reads into encrypted frames of a maximum of 16 KiB. The maximum collection interval is 4 ms. The agent keeps one pending TLS read across partial flushes. Before it clears its buffers, it waits for the cancellation. Active exchanges have a minimum interval of 20 ms between the starts of two requests. The HTTP round-trip time counts as part of that interval, and the agent sends waiting output immediately.

The browser staging has a limit in bytes and collects small SDK writes into batches. The first CleanPath request stays separate. The portal commits a maximum of 16 contiguous frames with three guarded bulk writes, not with three writes for each frame. The existing frame credits, encryption, certificate validation and live authorization checks stay in effect. Nobody has measured the real Windows sign-in throughput and frame rate yet.

Version 4.1.1 corrects the startup admission. The agent waits for the first acknowledged capability heartbeat before it polls the RDP channel. The browser transport now accepts the Blob messages from the pinned IronRDP WASM engine. It converts them in send order in the existing limited queue of encrypted frames. It keeps concrete transport and native errors through SDK failures. Local HTTP diagnostics include the route, the status and a limited structured error, but no tokens, private keys or raw response pages.

Version 4.1.0 adds real browser RDP with IronRDP:

- The native channel connects only to the loopback RDP listener of this machine. It validates the real certificate of the listener and requires NLA.
- It sends opaque AES-256-GCM frames through the authenticated outgoing portal connection.
- The NLA client of the browser handles the Windows credentials. They are never parameters of the portal API.
- Local Management, the separate `rdp` device right and a live MFA session are mandatory.
- The admission of the updater and the installer uses the same lease as the full cleanup of the RDP session.
- When the transport closes, the Windows account stays signed in.

For limits, the boundaries of domain authentication, retention and the required Windows pilot, refer to [rdp-contract.md](rdp-contract.md).

## Local data and release trust

The single-file distribution describes the deployment artifact. It does not promise that the service never writes data. `%ProgramData%\ServerDesk` contains the machine-DPAPI configuration, logs, cached inventories, protected claims, transfer state and update journals. The installer applies ACLs only for SYSTEM and Administrators and rejects unsafe reparse paths. The file browser blocks access to the agent data.

The single-file host of .NET can extract bundled native libraries. The service sets `DOTNET_BUNDLE_EXTRACT_BASE_DIR` to `%ProgramData%\ServerDesk\runtime`, which has the same protected ACL. These libraries come from the verified EXE. Users do not distribute more DLL or script files. Temporary update and DSC work also uses protected agent directories.

The embedded ECDSA P-256 publisher key is the trust anchor of the releases. The private signing key stays outside the package. Signed manifests bind the version, the layout with one EXE, the EXE hash/size, the full ZIP hash/size and each immutable download part. Chunks have a maximum size of 20 MiB, and the portal builds the EXE download again from them. If a hash, a signature or the layout does not agree, the procedure stops before the installation. Native update campaigns keep the durable journal against replay, the recovery task, the success after a health check and the rollback path.

## Validation completed and Windows pilot

Native builds and isolated tests cover these items:

- Compilation and the single-file publish layout.
- Crypto and the rejection of publishers.
- Validation of installation input and the native input/ReadOnly boundaries.
- Leases for telemetry collection, durable claims and acknowledgements.
- Isolation of the terminal protocol and supported layouts of API structures.
- Embedded PowerShell execution and output handling.

The Node pipeline checks the business rules of the portal, the UI contracts, the data layer and storage adapters and a real HTTP sign-in flow. These checks do not prove the behavior of Windows providers or the performance of the service.

Native regression commands from a .NET 10 build host:

```sh
dotnet build agent/v3/ServerDesk.Agent.csproj -c Release
dotnet run --project agent/v3/ServerDesk.Agent.csproj -c Release --no-build -- --self-test
dotnet run --project agent/v3/ServerDesk.Agent.csproj -c Release --no-build -- --powershell-self-test
```

Targeted native checks are `--broker-self-test`, `--features-self-test`, `--health-self-test`, `--gpu-self-test`, `--gpu-details-self-test` and `--hardware-self-test`. Do the acceptance tests with the real installed EXE and the portal. Use disposable hosts with Server 2022, Server 2025/Server Core and Windows 11 Pro/Enterprise:

1. **Identity-preserving migration:** Record the device ID in the portal. Install the downloaded v4 EXE with `--install`. Verify the version and the mode. Make sure that one existing device connects again.

   Make sure that the native service identity and the delayed automatic startup are correct. Use `Get-CimInstance Win32_Service -Filter "Name='ServerDeskAgent'"`. Read `%ProgramData%\ServerDesk\agent-v3.log` and the new health record. Do not show `config.bin` or tokens.
2. **Reboot/reconnection:** Restart a pilot VM through the portal. Make sure that it recovers without a local service restart. Make sure that a new heartbeat is accepted. Make sure that the inventories fill independently.

   Do this test again while Windows providers are slow or not available. A missing inventory must be visible. Successful communication must not show as a complete inventory.
3. **Local/portal permissions:** Make sure that ReadOnly permits monitoring and approved reads. Make sure that ReadOnly rejects each change, user runbook, terminal and DSC test/apply. Enable Management locally. Test device-group scopes with an authorized and an unauthorized account. Remove a permission or the mode while a session or transfer is active.
4. **Built-in management:** Test these items:
   - A disposable service.
   - A client feature or a server role with role services and management tools.
   - The static/DHCP/DNS settings of a secondary network adapter.
   - A disposable local user and group.
   - A pagefile on a test volume.
   - A local firewall rule and a scheduled task.
   - A configured WSUS/update scan.

   Examine the real state of the operating system and the rollback/error messages. To test domain join, leave and rename, use an isolated test domain and a separate reboot. Make sure that features, updates and DSC cause no automatic reboot.
5. **Storage/files:** Attach a blank disk. Examine and initialize it, and create a volume. Change the volume size in the native limits. Change the drive letter. Format and delete only disposable storage.

   Verify the protection of the system, the agent and the pagefile. Test file browse, rename, mkdir and delete. Test empty transfers and transfers with many chunks. Test hash failures and the rejection of junctions, symlinks and hardlinks. Test an interrupted commit and the resume.
6. **Troubleshooting/terminal:** Query filtered events, processes, WTS sessions and connections. Test the permitted actions on disposable processes and sessions. Open terminals as two users. Verify independent variables and directories, Unicode, `Read-Host`, Ctrl+C, resize and close.

   Close one tab. Connect again after an outage. Make sure that abandoned shells and their child processes stop. Make sure that the other sessions stay usable.
7. **Runbooks/DSC/drift:** Run a user script with output, parameters, masked secrets and a timeout. Make sure that no source PS1 file stays on the host. Test and apply one compiled MOF and one user Configuration. If DSC 3 is installed, also test one DSC 3 JSON version. Missing engines, a busy LCM and resource errors must fail explicitly.

   Enable a small drift policy. Examine changes to files, directories, the registry and the configuration. Also examine excluded paths, locked files and optional contents. Examine the recovery after an overflow and incomplete limits.
8. **Service/update faults and measurements:** Stop the process of the pilot service. Verify the SCM recovery. When a newer signed native pilot release exists, do these tests:
   - The portal update.
   - An incorrect signature, hash or layout.
   - Low disk space.
   - An interruption between the directory moves.
   - Recovery after a reboot.
   - Rollback after a failed health check.

   Measure CPU/RAM/network with drift off and on, repeated inventory and terminal/file activity at the same time. Promote the release only after the Windows results agree with the operational requirements.

The build-host tests do not claim a result from a real Windows VM action, an installed service migration or a Windows fault injection.
