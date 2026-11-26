# ServerDesk v3: runbooks and optional drift monitoring

In the console, each runbook has one menu **Actions for {name}** with **Prepare run…**, **New version…** and **Delete runbook…**. Select **Preview** first. Then **Start runbook** opens a confirmation with the runbook, the version and the devices. Its confirm button is also **Start runbook**. With **Save as schedule** on, both buttons say **Save schedule**.

Runbooks have immutable versions with typed parameters and up to 30 steps. The fixed diagnostic actions `refresh`, `scan-updates` and `test-connection` can run on ReadOnly devices. Custom PowerShell scripts run as SYSTEM. They need locally enabled Management, the explicit device right `runbooks.execute`, MFA and a confirmed run. A step that you declare as diagnostics cannot contain a custom script.

ServerDesk sends normal parameters as JSON, without command-line interpolation. When you create a run or a schedule, ServerDesk seals the secret parameters for each selected agent. It uses the registered RSA key of that agent. For these parameters, the database contains only encrypted envelopes that are bound to a device.

The script gets the parameters through a file that local DPAPI protects. The agent masks known secret values before it returns the output. This masking cannot reliably find derived values or credentials that the script contains as fixed text. Put credentials into secret parameters.

Each step has exactly one job that ServerDesk keeps permanently. Its results stay connected to the run, the device and the step through `runbook_step_results`, also after ServerDesk deletes the job parameters. The detailed run query (`GET /api/runbooks?serverId=…&runId=…`) returns output only for devices on which the user has `runbooks.read` at that time. The normal overview contains only summaries.

The results and the full output of custom PowerShell steps also need the explicitly assigned right `runbooks.outputs`. Migrated viewers do not get this right automatically. In the catalog, only the creator or an administrator can see script source code and parameter default values.

The agent channel drives the scheduler, so an open browser is not necessary. Schedules keep fixed device IDs, a checked version, parameters, the initiator and the run that the initiator approved with MFA at creation. New group members do not become targets automatically. Before each run, ServerDesk checks the approval, the current device permissions and the MFA setup of the initiator. If somebody withdraws the rights, ServerDesk disables the schedule.

Daily schedules use an IANA time zone. At the change to summer time, ServerDesk skips times that do not exist. At the change to winter time, a scheduled time runs only one time for each local calendar day.

Each due time has a unique key and makes a maximum of one run. Offline catch-up runs start only in the configured window. When catch-up is disabled, the agent poll has a tolerance of 30 seconds. Catch-up runs do not make a backlog without a limit. A manual run has a job window of 24 hours.

In each campaign, a maximum of 1–10 devices run at the same time, and each device runs one job. Before each step, ServerDesk checks the requirements for the operating system, the domain membership and a pending reboot against the current inventory. A campaign with stop on error ends the steps that did not start yet. ServerDesk does not revert changes that started. It never automatically repeats cancelled or expired jobs with an unknown result.

Drift monitoring is disabled for each device by default. An enabled policy sets paths, recursion, exclusions, selected registry values and configuration categories. The available categories are services, roles, network configuration, firewall, local groups and scheduled tasks. By default, the agent monitors registry and configuration values only as a hash. It compares each configuration object separately with a stable identity, so that you can see, for example, which service changed.

The optional `includeValues` for each registry key and `includeConfigValues` for the configuration send bounded values for before and after diffs. This intentional release and the collection of text files also need `drift.contents`. The group action copies the policy only to the current members, after a check of each device. Devices that you add later do not inherit the policy automatically.

File watchers give indications of changes, and bounded full periodic scans make sure that the coverage is complete. These conditions make a report incomplete: files that the agent cannot read, exceeded resource limits and an overflow of the watcher buffer. An incomplete report does not claim deletions and must not replace a baseline.

An exclusion pattern contains a maximum of 16 `*`, with a maximum of 120 characters between two `*`. Each part with `?` has a maximum of 32 characters. This also applies at the start, at the end and to a pattern without `*`. `*` and `?` are the only wildcards.

The check of a report against the policy has a fixed work budget. If a report exceeds this budget, the portal rejects it with HTTP 413. An example is many nested paths together with many exclusions full of wildcards.

The portal accepts a maximum of one new drift report for each device every 30 seconds. It rejects a faster report with HTTP 429, and the agent sends it again later. This limit does not apply when the agent sends a scan again that the portal saved already (same scan ID). The portal answers immediately with the saved result.

You explicitly approve a baseline from a complete current report. The baseline is bound to the device and to the policy version. A changed policy needs a new baseline. Reports compare hashes and metadata. ServerDesk shows the same content at a different path as a possible rename only if the match is unique. This does not tell who made a change.

The agent collects text content only for paths and file types that you explicitly released, and only for small UTF-8 files. To read text diffs, you need the separate right `drift.contents`. The agent does not send its configuration under `C:\ProgramData\ServerDesk` as plain text.

The resource limits are a maximum of 20 paths, 20 registry keys and 5,000 inventory entries. For each report, a single text has a maximum of 16 KiB and all text a maximum of 256 KiB. The saved inventory JSON has a maximum of 800,000 bytes for each report. When the native agent exceeds a resource limit, it stops and marks the scan as incomplete. You can configure the report retention and the interval. The agent calculates a hash of large or binary files only if they are in the configured hash limit.

At output limits, ServerDesk explicitly marks text diffs and change lists as shortened. The history keeps a maximum of 200 reports and 50 baselines for each device. The configured report retention of a maximum of 90 days also applies. Offline or late scans show as out of date. If you acknowledge a difference, the baseline does not change. Automatic repair is not enabled.

`pnpm pipeline verify` runs the current automation, Desired State, drift and runbook regression tests, and the database and HTTP checks. The native agent self-tests also check Desired State and drift with isolated sample data. The native watcher, PowerShell, resource and reboot behavior also need a check on the supported Windows target systems.
