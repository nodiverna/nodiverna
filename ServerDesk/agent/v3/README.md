# ServerDesk native agent 4.21.4

ServerDesk supplies the agent as one self-contained x64 `ServerDesk.Agent.exe`, built with .NET 10. It supports Windows Server 2022/2025, including Server Core, and Windows 11 Pro/Enterprise. You do not have to install .NET or PowerShell 7 separately. The bundled .NET, PowerShell and WebRTC dependencies are a large part of the download. The pilot must still measure the CPU, memory and network use on Windows.

The source directory and the protocol keep `v3` names for compatibility with the existing portal. `Program.Version` and the executable version are `4.21.4`. The wire protocol is version 3. The agent pins the portal publisher. It supports HTTPS origins with custom ports, including private NAS addresses.

The agent uses device access tokens that expire, with RSA renewal. It also has SCM identity and permission repair, and bounded transfer and update reads. The hardware inventory includes CPUs, memory modules, physical disks, network adapters, system, BIOS and mainboard. Supported GPUs also report their utilization and the available hardware details.

Since 4.10.0, the agent also reports health signals: crashes with the probable driver, the values that decide the support status of Windows, the installed programs and the BitLocker state of every volume. For the details, refer to [Health signals in 4.10.0](../../docs/native-agent-v4.md#health-signals-in-4100).

Since 4.11.0, the agent also reports drivers and devices with an error in Device Manager. It reports the stability index and program crashes, disk and battery health, the machine certificates and the programs that start automatically. For the details, refer to [Health signals in 4.11.0](../../docs/native-agent-v4.md#health-signals-in-4110).

Since 4.14.0, the agent also reports the Microsoft Defender state: mode, scans, signatures, detections, exclusions and other antivirus products. It only reads. For the details, refer to [Microsoft Defender in 4.14.0](../../docs/native-agent-v4.md#microsoft-defender-in-4140).

Since 4.15.0, the agent also runs Microsoft Defender actions from the portal: a quick scan, a full scan, a signature update and the clean of all active detections. Each action is a typed WMI call and runs only in Management mode. For the details, refer to [Microsoft Defender actions in 4.15.0](../../docs/native-agent-v4.md#microsoft-defender-actions-in-4150).

Since 4.12.0, the agent also accepts release manifests that name each file by a path below `/downloads/`, without a portal address. One publisher signature is then valid on every portal. The agent reports this with the capability `release-paths`. For the details, refer to [Origin-independent release manifests in 4.12.0](../../docs/native-agent-v4.md#origin-independent-release-manifests-in-4120).

Since 4.16.0, the SYSTEM broker can run agent plugins. A plugin is a separate EXE with its own signed manifest, for example the read-only DHCP plugin. The broker keeps each plugin in the protected folder `%ProgramData%\ServerDesk\plugins`. It checks the signature, the hash and the folder permissions before every start. It starts a plugin only for one request, without network access of its own.

The agent reports this with the capability `plugin-host`. For the details, refer to [Plugins in 4.16.0](../../docs/native-agent-v4.md#plugins-in-4160) and [agent plugins](../../docs/agent-plugins.md).

Since 4.18.0, the agent hardens itself against tampering. Windows restarts a crashed or killed service after 5, 30 and 60 seconds. The broker checks the service permissions, the service SIDs, the recovery and the agent folders, restores them and reports each change. The broker and the worker watch each other.

The portal shows the alarms **Agent stopped or start type changed**, **Agent removed outside the portal** and **Agent protection changed**. The agent reports this with the capability `agent-integrity`. For the details, refer to [Tamper protection in 4.18.0](../../docs/native-agent-v4.md#tamper-protection-in-4180). To remove a broken agent without the EXE, refer to [Remove the agent by hand](../../docs/native-agent-v4.md#remove-the-agent-by-hand).

Since 4.17.0, the agent runs a PowerShell script that a user started from the device assistant. The job kind is `assistant-powershell`. It runs only in Management mode and keeps at most 32 KiB of output. The agent reports this with the capability `assistant-powershell`. For the details, refer to [Assistant scripts in 4.17.0](../../docs/native-agent-v4.md#assistant-scripts-in-4170).

Since 4.17.0, a plugin job can also carry sealed secrets, for example a DHCP failover secret. The broker opens them with the device key and gives them to the plugin. It masks them in the result, the message and the logged plugin errors. The agent reports this with the capability `plugin-secrets`. For the details, refer to [Plugin secrets in 4.17.0](../../docs/native-agent-v4.md#plugin-secrets-in-4170).

Since 4.19.0, plugin changes run with the AD account of the technician, not as SYSTEM. The new job `ad-sign-in` checks the account and its password one time. The agent never stores the password. A change then starts the plugin with an S4U token of the account. The agent reports this with the capability `plugin-ad-identity`. For the details, refer to [AD sign-in for plugin changes in 4.19.0](../../docs/native-agent-v4.md#ad-sign-in-for-plugin-changes-in-4190).

Since 4.20.0, the broker also runs the reads of the DNS plugin: `dns-read` reads the DNS server every 15 minutes, `dns-zone-read` reads the records of one zone on request. Both run in ReadOnly mode, as SYSTEM. DNS changes run with the AD account, like DHCP changes. For the details, refer to [DNS plugin reads in 4.20.0](../../docs/native-agent-v4.md#dns-plugin-reads-in-4200) and [DNS server](../../docs/dns-server.md).

Since 4.21.0, jobs that change nothing on the device run next to each other and next to one changing job. For example, an inventory refresh runs during an update installation. Changing jobs still run one at a time. An agent update, an uninstall, a plugin installation and a restart need the device alone. The agent reports this with the capability `parallel-jobs`. For the details, refer to [Parallel jobs in 4.21.0](../../docs/native-agent-v4.md#parallel-jobs-in-4210).

Since 4.21.2, the data of plugin reads reach the portal again, and a failed plugin job always has a code. For the details, refer to [Fixes in 4.21.2](../../docs/native-agent-v4.md#fixes-in-4212).

Since 4.21.3, an update without a severity in Windows Update no longer makes the update inventory unreadable, so the device no longer shows "Inventory incomplete". For the details, refer to [Fixes in 4.21.3](../../docs/native-agent-v4.md#fixes-in-4213).

Since 4.21.4, the agent classifies a runbook diagnosis by the same rule as the portal. A diagnosis with invalid operation parameters counts as a change and no longer runs next to another change. For the details, refer to [Fixes in 4.21.4](../../docs/native-agent-v4.md#fixes-in-4214).

Since 4.7.0, the EXE runs as two services. A SYSTEM broker without network access does only the work that the portal signed. An unprivileged worker does all the portal traffic.

For more information, read these documents:

- [broker and worker](../../docs/agent-broker-worker.md) for the two services
- [the native agent guide](../../docs/native-agent-v4.md) for architecture and Windows acceptance
- [hardware inventory](../../docs/hardware-inventory.md) for collection details
- [the health signals contract](../../docs/v3-health-signals.md) for crashes, OS lifecycle values, software and BitLocker
- [self-hosting](../../docs/self-hosting.md) for offline release signing

## Installation and local controls

Download the native EXE and the registration JSON of the device under **Agents → Add device**. Run the downloaded EXE from an elevated administrator terminal, outside `%ProgramData%\ServerDesk`:

```powershell
& .\ServerDesk.Agent.exe --install --config .\ServerDesk-Registration.json
```

The registration contains credentials. Keep it private, and delete the downloaded JSON after a successful installation. The installer uses the registration as input, but the agent does not need it at runtime.

The installer validates the registration. It verifies its own EXE against the release envelope of the portal and the embedded publisher public key. Then it creates the `ServerDeskAgent` broker service as LocalSystem. It also creates the `ServerDeskWorker` service under its virtual account `NT SERVICE\ServerDeskWorker`.

The registration must contain the `jobSigningKey` of the portal. Set `AGENT_JOB_SIGNING_KEY` on the portal before you download the registration. The installation is successful only when the new version reports a new heartbeat that the portal accepts. If the installation fails, the installer restores the previous installation and configuration where possible.

**Customer installer.** Under **Settings → Customers → Installer**, an Owner downloads `Install-ServerDesk-{Customer}-{Installer}.ps1`. Run it on the device in an elevated administrator PowerShell, without `--config` and without a registration file: `& .\Install-ServerDesk-{Customer}-{Installer}.ps1`. The script first downloads the signed release and the EXE. It verifies the signature and the hash in the same way as the bootstrap script. Only after this check, it registers the device with that customer through `POST /api/agent/enroll` and installs the agent.

The script stops when `%ProgramData%\ServerDesk\config.bin` already exists. Thus it never replaces an existing registration. The script contains a secret installer key. Refer to [Installer for each customer](../../docs/customers.md#installer-for-each-customer).

For an existing 4.7 installation, use the new downloaded EXE without a new registration. **You cannot convert 4.6.x and older installations.** Run `--uninstall`. Then install with a new registration.

To repair or install a 4.7 installation again, use this command:

```powershell
& .\ServerDesk.Agent.exe --install
```

This command keeps the existing device ID, bearer token, RSA key and local mode from the machine-DPAPI configuration. It does not create an additional device in the portal. A new registration cannot silently replace an existing device identity or portal origin. Before the installation, complete each pending update or recovery. Close all active jobs, terminals, RDP sessions and transfers.

The only local modes are `ReadOnly` and `Management`. An elevated administrator can change them without a bootstrap script:

```powershell
& "$env:ProgramData\ServerDesk\current\ServerDesk.Agent.exe" --set-mode Management
& "$env:ProgramData\ServerDesk\current\ServerDesk.Agent.exe" --set-mode ReadOnly
```

You can also give an explicit `--mode ReadOnly` or `--mode Management` to `--install`. A portal flag cannot enable Management. Device-group permissions and MFA are additional portal requirements. A mode change is possible only when no management work runs, and the running service reads the new mode. A change to ReadOnly closes privileged terminal and RDP access.

To remove the agent fully from the local device, run a downloaded EXE outside the installed directory:

```powershell
& .\ServerDesk.Agent.exe --uninstall
```

This command removes the service, the recovery task, the local credentials and the agent files. Also remove or offboard the device in the portal to revoke its remote registration.

**Uninstall from the portal.** When you remove a device in the portal, you can also let the agent uninstall itself. Set **Uninstall the agent on the device** in the removal dialog. The agent checks the same conditions as `--uninstall`: administrator rights, the installed service, no local maintenance, no pending update, no other job, no terminal or RDP session and no file transfer. Then it copies its EXE to `%SystemRoot%\Temp\ServerDesk-Uninstall-<jobId>\` and reports that the uninstall started. The broker refuses a staging folder that already exists.

The portal revokes the device only after this report. If a condition is false, the device stays registered and the portal shows the reason. The copy starts only when the portal confirms the revocation: through its answer to the start report, or through a refusal that names the uninstall job. Right before the start, the broker checks the SHA-256 of the copy again. Without the confirmation, the agent stays installed.

The copy removes the agent. The portal does not see errors after this start. They are in `%SystemRoot%\Temp\ServerDesk-Uninstall-<jobId>\uninstall.log`.

To remove the parts that stay, run the downloaded `ServerDesk.Agent.exe --uninstall` as administrator outside `%ProgramData%\ServerDesk`. A device that does not connect keeps its agent until you run this command on it. For the details, refer to [Portal uninstall in 4.9.0](../../docs/native-agent-v4.md#portal-uninstall-in-490).

## Native operation and reboot recovery

Telemetry, drift, diagnostics, file operations and all 28 built-in management actions are C# code. They use Windows APIs, local WMI providers, COM and .NET file and network APIs. The agent installs no `ServerDesk-*.ps1` runtime script, no telemetry subprocess and no management script package.

The service has a delayed automatic start and native Service Control Manager recovery. Every 30 seconds, it sends telemetry, independently of the heavy inventory collectors. The agent can send native CPU, RAM and uptime data while the Windows providers initialize after a reboot. The inventory collectors start with two seconds between them, and a maximum of two responsive providers collect at the same time. Each collector has one active collection, a deadline and a cache. A stalled provider does not start repeated collection workers and does not block the heartbeat.

The agent reports missing, stale and incomplete inventories explicitly. CPU/RAM, process activity, local drive space, SCM service states and persistent PDH performance counters keep the 30-second interval. Network configuration, pagefile configuration and security inventory refresh every five minutes. System and hotfix, feature, local account, firewall and scheduled-task inventories refresh every 15 minutes. Events refresh every minute and use a bounded cache of formatted descriptions again. An explicit refresh and completed management actions request a new staggered inventory, including the cached service configuration.

The agent queries the image path of a process one time for each exact PID and start identity. It does not enumerate the process modules repeatedly. Provider work runs at below-normal thread priority. The CPU use of external Windows providers still depends on the host.

Drift firewall inventory makes five bounded provider queries and joins their associations in memory. It does not make two queries for each rule. Full drift scans have a minimum of 60 seconds between them, and the agent combines file changes. A failed upload sends the same bounded report again with exponential backoff and does not start a new scan immediately. The agent still calculates a hash of the file contents on each admitted scan. It does not use hash shortcuts that use only metadata.

The agent writes an unchanged installation state a maximum of one time in ten seconds. It publishes each work transition immediately. It keeps an unchanged protected configuration in a cache for a maximum of 15 seconds. A file change makes this cache invalid immediately, and privileged admission checks do not use the cache. An authenticated Remote Desktop channel that is paused and fully idle polls one time each minute.

These changes remove known sources of background work that is not necessary. Portable tests verify scheduling, cache invalidation, native layouts and protocol guards. They do not measure the CPU use of Windows providers. After the installation, compare the CPU of the host and of the agent and WMI processes. Do this over a minimum of two 15-minute inventory cycles, with the same workload and drift policy. User scripts, DSC checks, Windows Update searches and active transfers can still use resources while they run.

The native management functions include these items:

- Windows services and startup
- Server roles and role services, and optional client features
- IPv4/DNS, domain membership and computer names
- Pagefile, local users and groups
- Delayed restart and shutdown
- Configured Windows Update/WSUS
- Local firewall rules and scheduled tasks

Server roles use the ServerManager Deployment Provider with real hierarchy and dependency descriptors. Windows 11 features use the inbox DISM API. Updates do not change the configured update source and do not reboot automatically. The safeguards for domain controllers, the last enabled local administrator, the protected agent service and the recovery task stay in effect.

The storage functions use the Windows Storage Management provider. They inspect and initialize disks, set the online and read-only state and manage basic volumes. They also resize partitions, assign drive letters, format volumes and delete partitions. The agent examines the current Windows size limits again and protects system, agent and pagefile partitions. You can only enlarge the existing Windows NTFS boot partition, and only within the Windows limits that the agent reads at that time.

The file browser and the transfers enforce canonical paths of opened handles, protected agent data, and reparse-point and hardlink boundaries. Transfers have a limit of 256 MiB. They verify SHA-256 before an atomic upload commit. ReadOnly permits browsing and downloads. Changes need Management and portal file-write rights. Job claims, transfer resumes and result acknowledgements stay durable, so the agent does not automatically repeat an interrupted change.

## Direct browser RDP

**The split 4.7 agent does not supply this function.** This section describes 4.3–4.6.

Agent 4.3.3 advertises `rdp-webrtc` together with the existing `rdp-browser` capability. The default browser connection uses one reliable, ordered WebRTC data channel directly to the agent. The existing Windows RDP listener, NLA/CredSSP, the loopback-only proxy and the listener certificate pin stay in use. Local and permitted domain accounts still get their own Windows logon. This release changes the transport. It does not change native console capture or H.264 video encoding.

The portal supplies authorization and encrypted, immutable SDP offer/answer negotiation. Screen and input bytes move through SCTP/DTLS and never enter the frame mailboxes of the database. Each new session uses an RSA-OAEP key envelope and a random AES-256-GCM key. These keys authenticate the session descriptions and the DTLS fingerprint. The agent needs current local Management, RDP/NLA and no pending update. It renews an absolute authorization lease of a maximum of 15 seconds through normal five-second control requests.

Negotiation uses 250 ms control polling. Expiry, lost renewal, local ReadOnly, withdrawn access or channel failure close the tunnel. They also release its update activity lease. Incoming direct commands and reports contain no mailbox frames.

The data path keeps binary messages at a maximum of 16 KiB, with bounded input queues and SCTP backpressure. On overflow, it closes the connection and does not drop RDP bytes. The agent uses SIPSorcery 10.0.17, bundled in the EXE. You do not need a separate WebRTC installation, gateway VM, container or external relay that you supply manually.

The fixed public STUN endpoint `stun:stun.cloudflare.com:3478` discovers addresses, but both peers need a direct UDP route. ServerDesk supplies no TURN relay, so restrictive NAT or firewalls can prevent the connection. The browser reports this failure. The user can then explicitly select the older portal compatibility transport. There is no automatic database fallback.

During an authorized session, agent 4.3.3 automatically permits incoming UDP on the one bound WebRTC socket for the installed agent EXE. It removes the exception that it owns when the peer closes. At startup, it removes rules that it strictly owns and that a dead process left. It keeps existing or domain-managed firewall rules. This lets the browser start authenticated ICE checks, also when multicast DNS cannot resolve the host candidate of the browser. It does not open the Windows RDP listener and does not supply a NAT relay.

Terminal RTC errors stay in a bounded diagnostic outbox, also when the portal closes at the same time. The browser diagnostics record the DTLS and SCTP states before cleanup.

The full protocol and the pilot checklist are in [rdp-contract.md](../../docs/rdp-contract.md). The initial browser desktop is 1280×720. An optional detail profile has a maximum of 1920×1080. Real Windows and browser interoperability, input latency, throughput and rendered FPS need a pilot on the deployed network. Fixtures on the build host cannot prove these results.

## User PowerShell, terminals and DSC

The EXE contains PowerShell SDK **7.6.6** for runbooks that users write and for interactive terminals. Runbook source and parameters move through a private pipe to a child instance of the same EXE. The runbook host writes no executable PS1 and no plaintext parameter file. Each terminal uses a different instance of the EXE under ConPTY with a persistent PowerShell session. The availability of custom modules still depends on the modules on the Windows host. ServerDesk does not promise compatibility with modules that work only in Windows PowerShell 5.1.

The service and the shells run as SYSTEM. Arbitrary user scripts, terminals and DSC need local Management, the related portal rights and MFA. Terminal sessions have independent leases, sequence acknowledgements and output buffers. When one user closes a session, the sessions of other users stay open. A lost live-channel connection, withdrawn permissions, local ReadOnly or a service shutdown close the affected privileged sessions.

Windows process jobs with kill-on-close own the user script and terminal processes. The agent does not replay uncertain input and interrupted changes.

Desired State is a genuine local DSC integration without Azure:

- The agent sends an uploaded MOF in memory to the Windows DSC LCM WMI provider for test or apply.
- A legacy PowerShell DSC `Configuration` from a user needs the **Windows PowerShell 5.1 compiler already supplied by Windows**. The compiler gets the source through standard input, and the agent does not install a PS1 helper. The agent protects the temporary compiled MOF under agent data and removes it after use. This is the explicit exception to the embedded PowerShell 7 host, because that host cannot compile Windows DSC 1.1 configurations.
- DSC 3 JSON needs the optional **DSC 3.2+ version 3** executable and resources under Program Files. An administrator must install them, because ServerDesk does not include them. Missing or incompatible engines fail explicitly. The configuration source moves through standard input. Optional scalar parameters use a temporary protected work directory.

Both test and apply can run resource code, so they need Management. Apply is explicit. It does not force a concurrent LCM configuration to stop. It rejects an LCM that has automatic restart or automatic correction in its configuration. Portal assignments pin immutable configuration versions. For the Windows pilot and the resource prerequisites, refer to the native guide.

Drift is optional. Native file watchers start debounced scans. Periodic rescans recover missed events or a watcher overflow. Hashes are the default, and text contents need explicit policy options. The limits are 5,000 entries, approximately 780 KB metadata, 256 KiB total optional text and 16 KiB for each text value.

Native configuration inventories cover services, firewall, adapters, local groups, tasks and installed roles. The agent marks incomplete scans as incomplete. HKCU is the hive of SYSTEM. A file event does not identify its author.

## Single-file packaging and updates

ServerDesk distributes one EXE. Changeable runtime data still stays under `%ProgramData%\ServerDesk`: DPAPI configuration, logs, caches, claims and protected update journals. .NET can extract bundled native libraries into `%ProgramData%\ServerDesk\runtime`. The service sets this extraction directory explicitly, and the installer gives access to it only to SYSTEM and Administrators. These extracted libraries are not separate deployment files.

Releases use the embedded ECDSA P-256 publisher public key. ServerDesk never ships the private signing key. Signed manifests pin the version, the layout, the EXE hash and size, and the ZIP and part hashes. Large downloads use immutable parts of a maximum of 20 MiB, and the portal builds the native EXE download from them again. The update ZIP contains exactly `ServerDesk.Agent.exe`.

**An installed 3.x updater expects its old script package layout. Migrate 3.x one time on the local device with the current EXE and `--install`. An update through the portal alone cannot replace that older updater.** Later native releases can use the portal updater. Before an update, all jobs, transfers, terminals and RDP sessions must finish. The protected journal and the `ServerDesk Update Recovery` task make recovery and rollback possible after an interruption. A successful update needs a new heartbeat that the portal accepts, not only a running process.

## Build and verification

To build, sign and package from the repository, use the .NET 10 SDK:

Before you publish a new artifact, add `agent/v3/changelogs/<version>.json` with
the exact version and the `features` and `fixes` arrays. A minimum of one array
must contain an entry. Each category has a maximum of 10 entries with a maximum
of 200 characters each. The pipeline needs these notes and includes them in the
manifest that the publisher signs. The release catalog and the device update
actions show the same changelog.

Then run `node scripts/agent-changelog-history.mjs` in `ServerDesk`. The script
writes `lib/agent-changelog-history.json`, the changelog list of the portal. The
tests fail while this file is not current. The GitHub release notes show the
changes of the signed manifest first. Then they show the changes of all earlier
versions of the same major version, newest first. The update actions of the
portal show the changes of all versions after the installed agent.

When you sign an unchanged historical artifact again, it keeps its existing notes.

```json
{"version":"4.7.0","features":["Describe the new capability."],"fixes":["Describe the corrected behavior."]}
```

```sh
SERVERDESK_DOTNET=/path/to/dotnet node scripts/build-agent-v3.mjs
node scripts/sign-agent-release.mjs
node scripts/package-agent-v3.mjs
```

`build-agent-v3.mjs` fails if the publish step leaves external runtime dependencies. It creates ignored local artifact metadata and verifies the single-EXE ZIP layout. Offline signing needs a `SERVERDESK_RELEASE_KEY_FILE` that you supply explicitly. The portal receives a public signature that is bound to the origin. The publisher public key stays pinned.

Signed artifacts that active releases or update jobs refer to must stay available. The published release catalog sets which artifacts are available.

The agent includes third-party license notices in its executable. SIPSorcery 10.0.17 has BSD clauses and an explicit geographic restriction on use and distribution. `THIRD-PARTY-NOTICES.txt` contains its full terms, and you must keep them. Do not call that license unrestricted BSD.

To run the native tests without a service installation, use these commands:

```sh
dotnet build agent/v3/ServerDesk.Agent.csproj -c Release
dotnet run --project agent/v3/ServerDesk.Agent.csproj -c Release --no-build -- --self-test
dotnet run --project agent/v3/ServerDesk.Agent.csproj -c Release --no-build -- --powershell-self-test
```

The first tests cover protocol, signed package layout, installation input, durable results, crypto, terminal lifecycle, telemetry single-flight behavior and typed native-operation safeguards. The second test runs the script, output, parameter, failure and exit-status checks of the embedded engine. These targeted checks are also available: `--broker-self-test` (pipe framing, signed envelopes including a Node-signed vector, terminal leases, relay and worker configuration), `--features-self-test`, `--health-self-test`, `--gpu-self-test`, `--gpu-details-self-test`, `--hardware-self-test`, `--crash-self-test`, `--software-self-test` and `--bitlocker-self-test`. The rules of the GPU driver job of 4.13.0 have their own check, `--gpu-driver-self-test`.

Linux checks cannot run Windows services, WMI, COM, ConPTY or DPAPI. A sandbox that blocks network-interface change notifications can also stop the WebRTC dependency from creating peers. Crypto and transport fixtures that pass do not prove a browser-to-agent WebRTC connection, a Windows account logon or a rendered frame rate. Use the real Windows pilot checklists in [native-agent-v4.md](../../docs/native-agent-v4.md) and [rdp-contract.md](../../docs/rdp-contract.md).
