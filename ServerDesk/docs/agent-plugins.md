# Agent plugins

An agent plugin is a separate EXE that adds one server role function to the agent. The SYSTEM broker of agent 4.16.0 and later installs, checks and runs it. The plugins are the DHCP plugin and the DNS plugin. For their views in the portal, refer to [DHCP server](dhcp-server.md) and [DNS server](dns-server.md).

The UI calls a plugin an extension: the device area, the scope tab and the settings page are named **Extensions**. Refer to [Extensions](extensions.md). This page keeps the technical terms of the plugin protocol.

A plugin is not part of the agent ZIP. It has its own version, its own signed manifest and its own GitHub release. An agent update does not change the installed plugins.

## Format and manifest

A plugin release has four files:

| File | Content |
| --- | --- |
| `ServerDesk-Plugin-<name>-<version>-win-x64.exe` | The plugin, a self-contained .NET 10 x64 single-file EXE of at most 100 MiB |
| `ServerDesk-Plugin-<name>-<version>-manifest.json` | The manifest, at most 8192 bytes |
| `ServerDesk-Plugin-<name>-<version>-manifest.sig` | The ECDSA P-256 signature (DER, SHA-256) over the exact manifest bytes |
| `ServerDesk-Plugin-<name>-<version>-release.json` | The record with the manifest, the signature, the SHA-256 and the size of the EXE |

The publisher key is the same key that signs the agent releases (`agent/v3/release-public.pem`). The manifest has these fields:

| Field | Value |
| --- | --- |
| `kind` | Always `plugin`. An agent manifest is never valid as a plugin manifest. |
| `name` | The plugin name, `^[a-z][a-z0-9-]{1,31}$`, for example `dhcp` |
| `target` | Optional. The detection id that the plugin extends, from the [detection catalog](extensions.md#detection-catalog), for example `dhcp` |
| `role` | Required, because the deployed agents refuse a manifest without it. With `target`, `role` has the same value. Without `target` (a manifest from before `target`), `role` is the detection id. |
| `version`, `minAgentVersion` | `X.Y.Z`. The broker refuses a plugin for a newer agent. |
| `protocolVersion` | Always `1` |
| `os`, `arch` | 1 to 4 operating systems, and `x64` |
| `capabilities` | 1 to 32 operations, for example `dhcp-read` |
| `exe` | `path` (`/downloads/ServerDesk-Plugin-<name>-<version>-win-x64.exe`), `sha256`, `size` and optional `parts` of at most 20 MiB |
| `changelog`, `createdAt` | As in an agent release |

The portal refuses a manifest with an unknown `target`, with a `role` that is not equal to `target`, or with another key. The portal reads the target of a release as `target`, or as `role` when `target` is absent. Stored manifests and their signatures do not change.

The plugin project names the target in `<PluginTarget>`. A project with only `<PluginRole>` still builds, and `<PluginRole>` then gives the target. The signing script writes `target` and an equal `role` into the manifest.

The DHCP plugin 1.0.0 has `name` `dhcp`, `role` `dhcp`, `minAgentVersion` `4.16.0` and `capabilities` `["dhcp-read"]`.

The DNS plugin 1.0.5 has `name` `dns`, `role` `dns`, `minAgentVersion` `4.21.2` and 16 `capabilities`: the reads `dns-read` and `dns-zone-read`, and the 14 changes of [DNS server](dns-server.md#the-changes).

## CI and signing

The workflow `.github/workflows/plugin-release.yml` builds one plugin. Start it by hand on `main` for a release or on `dev` for a dev build, and select the plugin. It has the same hardening as the agent release workflow. The environment `agent-signing` must allow the branches `main` and `dev`.

1. **plan** reads `<Version>` from the plugin project and checks the changelog. It stops when the tag `plugin-<name>-v<version>` exists.
2. **build** runs `node scripts/build-plugin.mjs --plugin <name>` on Windows, without a secret.
3. **build** also runs `--version` and `--self-test` on the published EXE.
4. **sign** signs the manifest in the environment `agent-signing` with Node built-ins only.
5. **release** verifies the files against the pinned key and publishes them with `--latest=false`. It also compares its own `notes.md` with the notes of the checkout (`--check-notes`).

`notes.md` has no signature. Thus `scripts/plugin-release.mjs verify` without `--check-notes` does not compare `notes.md`.

The agent release workflow, the agent ZIP and the agent updater do not change. The agent ZIP contains only `ServerDesk.Agent.exe`.

**Dev builds:** Start the workflow on the branch `dev` to publish a test build:

- The version is `<Version>-dev.<sha7>`, with the first 7 characters of the commit. The EXE, its `--version` and its hello give the full version.
- The tag is `plugin-<name>-vX.Y.Z-dev.<sha7>`. The release is a pre-release that is not marked as latest.
- A dev build needs no changelog file. When `changelogs/X.Y.Z.json` is valid, the signing script uses it. Else the changelog has one line with the commit.
- The minimum agent version stays `X.Y.Z`. An agent `X.Y.Z-dev.<sha7>` meets the minimum `X.Y.Z`.
- When the tag `plugin-<name>-vX.Y.Z` exists, the plan stops. Increase `<Version>` first.

## Import

The portal imports plugin releases with the agent releases. A check reads the GitHub releases with a tag `plugin-<name>-vX.Y.Z`. It takes the three highest versions of each plugin name. For the schedule and the rate limit of GitHub, refer to [Agent releases from GitHub](self-hosting.md#agent-releases-from-github).

The portal verifies the signature, the manifest, the size and the SHA-256 of the EXE before it stores the release. It keeps the EXE as chunks in the object storage, like an agent release. The page **Settings → Agent releases** shows the import in the table **Imports** with the tag **Extension**. The audit gets the entry **Extension release imported from GitHub**.

A release without its four files fails with the reason "The extension release is missing files. It needs the EXE, the record, the manifest and the signature." The other reasons are the same as for an agent release. A path that an agent release or another plugin release already uses with other bytes is a `pathConflict`.

For an installation without access to GitHub, copy the four files into one folder. Then run `node scripts/selfhost.mjs import-release <dir>`. The command finds the plugin record and does the same checks. The audit gets the entry **Extension release imported from a folder**.

An import never installs or updates a plugin on a device.

The portal imports a dev build (tag `plugin-<name>-vX.Y.Z-dev.<sha7>`) only while an Owner turned on **Import dev builds**, refer to [Agent releases from GitHub](self-hosting.md#agent-releases-from-github). Then it takes the three newest dev builds of each plugin name. **Settings → Extensions** shows a dev build with the tag **Dev build**.

An install or a repair never uses a dev build. A rollout of a dev build needs the setting. It uses the same rules as a release: the device must have a lower version or another dev build of the same version.

## Rights

| Right | Use |
| --- | --- |
| `plugins.manage` (**Manage extensions**) | Install, repair, remove and roll out plugins on a device |
| `dhcp.read` (**View DHCP**) | The DHCP view of a device, **Read again** and the fleet card **DHCP scope usage** |
| `dhcp.manage` (**Manage DHCP**) | The changes of DHCP plugin 1.1.0. Refer to [Change the DHCP server](dhcp-server.md#change-the-dhcp-server). |
| `dns.read` (**View DNS**) | The DNS view of a device, **Read again**, **Read records** and the fleet card **DNS zones** |
| `dns.manage` (**Manage DNS**) | The changes of the DNS plugin. Refer to [Change the DNS server](dns-server.md#change-the-dns-server). |

For the built-in roles, refer to [Local identity and RBAC](local-identity-rbac.md#roles-and-scopes).

## Install and remove

The device area **Extensions** shows the state of the plugin of each role. For the states, refer to [States](extensions.md#states).

1. Open the device on its area **Extensions**.
2. On the card **DHCP extension** in **Available for this device**, select **Install extension**.
3. Read the device and the extension in the confirmation, then select **Install extension**. The install needs this confirmation and an MFA session.
4. Follow the job **Install extension** in the job dock. The card moves to **Installed**, and the row shows **Installing…** and no install action.
5. When the job succeeds, the portal writes the installed plugin into the device data. The row shows **Installed** with the version and **Open DHCP** or **Open DNS**. When the portal cannot write the plugin, the row shows **Installed · waiting for the agent** until the agent reports the plugin. This usually takes less than a minute.

The row menu of the scope tab **Inventory → Extensions** also has **Install extension** for each device.

When a plugin job of a device ends, the console loads its data again at once. This occurs on each page of the console. While a row waits for the agent, the console loads the data every 10 seconds. When the agent does not report the plugin within 16 minutes of its last heartbeat after the job, the row shows its reported status again.

The portal takes the newest active release whose minimum agent version the device has. It refuses the install when the plugin is already installed. A damaged plugin shows **Repair extension** instead, which installs the same release again.

To remove the plugin, open the menu of the row and select **Remove extension**. The removal also needs a confirmation and an MFA session. Each confirmation names the plugin and its version, and tells you what the plugin reads or what the removal deletes. When the job succeeds, the portal removes the plugin from the device data and deletes the data of that plugin on the device. The row moves back to **Available for this device** when a release of the plugin is available. The DHCP server itself does not change.

The agent can send a heartbeat that it collected before the job ended. Thus, for 90 seconds after an install or a removal succeeds, heartbeats do not undo the result. A heartbeat that does not show a removed plugin always applies. A heartbeat that shows an installed plugin as damaged always applies.

The buttons are blocked with a reason in this order: sample devices, the missing right, an offline device, an agent without `plugin-host` or below the minimum version, and an open plugin job.

## Rollout with pilot devices

The table **Extension releases** on the page **Settings → Extensions** (`#settings/extensions`) shows each imported plugin release. It shows the version, the minimum agent, the number of devices and the import time. Each card of the scope tab **Inventory → Extensions** has the same **Roll out** for the devices of the scope.

1. Select **Roll out** in the row of the new version.
2. Select the pilot devices. Only devices with an older version of the plugin show.
3. Select **Roll out to {count} devices**. You can select up to 20 devices.
4. Read the devices in the confirmation, then select **Roll out**. The rollout needs this confirmation and an MFA session.

The portal checks each device before it writes anything. The device must be online, report `plugin-host` and have the plugin at a lower version. The agent version must be at least the minimum version of the release.

The portal then writes one install job for each device in one transaction. The audit gets the entry **Extension rollout planned**. Devices of more than one customer need the same confirmation as other actions across customers.

## Folder and permissions

The broker keeps each plugin in `%ProgramData%\ServerDesk\plugins\<name>\`. The folder contains `ServerDesk.Plugin.<Name>.exe`, `manifest.json` with the exact signed bytes, and `manifest.sig`.

The folder `plugins\` has a protected DACL without inheritance. Only SYSTEM and Administrators have full control, and Administrators is the owner. From agent 4.19.0, Authenticated Users also get read and execute, inherited to the plugin folders. A plugin change can then start the EXE with the token of the signed-in account. At start-up, the broker adds this entry one time to an install from 4.16, 4.17 or 4.18. The worker account cannot write to the folder.

Before each start and each report, the broker checks the DACL of `plugins\` and of the plugin folder. It refuses with `AGENT_PLUGIN_FOLDER_UNSAFE` in these cases:

- An entry gives write, append, delete, `WRITE_DAC` or `WRITE_OWNER` to another account.
- The owner is not SYSTEM or Administrators.

An agent update and its rollback do not change `plugins\`. `--install` as a repair keeps the installed plugins. `--uninstall` and the portal uninstall remove `plugins\` and the firewall rules of the plugins.

## Verification before each start

The broker opens the EXE so that no other process can write it. It keeps the file open until the process runs. Then it checks these items:

- The manifest signature against the publisher key in the agent.
- `kind`, the name of the folder, `protocolVersion` and `minAgentVersion`.
- The size and the SHA-256 of the EXE against the manifest.

A failure starts no process. The job fails with `AGENT_PLUGIN_SIGNATURE_INVALID`, `AGENT_PLUGIN_HASH_MISMATCH` or `AGENT_PLUGIN_AGENT_TOO_OLD`.

## Start on demand

The broker starts a plugin only for one request. The plugin never stays resident. The process runs as a child of the broker with these limits:

- A Windows job object that ends the process when the broker closes it. It allows one process and 512 MiB of memory.
- The plugin folder as the working directory, and a minimal environment.
- The fixed argument `--plugin-host` and no other input on the command line.
- Pipes for stdin, stdout and stderr. The broker log gets at most 64 KiB of stderr.

Only one process of each plugin runs at a time. A second request waits up to 30 seconds and then fails with `AGENT_PLUGIN_BUSY`.

## Protocol

The broker and the plugin send UTF-8 JSON, one object on each line, over stdin and stdout. A line from the broker has at most 64 KiB. A line from the plugin has at most 2.5 MiB. The code is in `agent/plugins/shared/PluginProtocol.cs`.

1. Broker: `{"type":"hello","protocol":1,"agentVersion":"4.16.0"}`
2. Plugin: `{"type":"hello","protocol":1,"name":"dhcp","version":"1.0.0","capabilities":["dhcp-read"]}`
3. Broker: `{"type":"request","id":"<guid>","operation":"dhcp-read","parameters":{}}`
4. Plugin: `{"type":"result","id":"<same>","ok":true,"code":"PLUGIN_…","args":{},"message":"…","data":{…}}`

The hello of the plugin must agree with the manifest. If not, the result is `AGENT_PLUGIN_HANDSHAKE_FAILED`. The broker sends only an operation from a signed job or from the signed plugin policy. The operation must be in the `capabilities` of the manifest. If not, the result is `AGENT_PLUGIN_OPERATION_UNKNOWN`, and no process starts.

After the request, the broker closes stdin. The plugin sends its result and exits with code 0.

## Crash behaviour

The hello has a timeout of 10 seconds and the result a timeout of 120 seconds. After a timeout, the job object ends the process, and the result is `AGENT_PLUGIN_TIMEOUT`.

These events give `AGENT_PLUGIN_CRASHED` with the exit code, or `AGENT_PLUGIN_OUTPUT_INVALID`:

- The output ends before the result.
- The process exits with an error code or an exception.
- A line is too long or is not valid JSON.
- The result has a different `id`.

In each case, the broker continues to run and answers `status`. The next request starts a new process.

## Network block

The broker makes two Windows Firewall rules for the plugin EXE: `ServerDesk Plugin <name> (block outbound)` and `ServerDesk Plugin <name> (block inbound)`. They apply to all protocols and all profiles. Each start makes a missing rule again. The removal of the plugin and the uninstall of the agent remove the rules.

The install also starts the new EXE one time from the staging folder for the hello. Before this start, the broker points both rules to the staged EXE. After the swap, the rules point to the installed EXE. When the install fails, the rules point back to the kept plugin, or the broker removes them when no plugin stays.

The DHCP plugin opens no socket. It calls the DHCP API only for the local server. The DNS plugin also opens no socket. It uses only the local WMI namespaces of the DNS server.

## Plugin jobs that change a server

A plugin operation other than a read changes the server. The portal and the broker treat it like every other changing job:

- The job needs the right of the operation, an MFA session, a confirmation and Management mode on the device.
- The broker runs it only in Management mode (`PluginHost.ReadOperation` allows only `dhcp-read`, `dns-read` and `dns-zone-read` in ReadOnly mode).
- The signed plugin policy never contains it, so the broker never runs it periodically.
- `POST /api/plugins` with `action:'job'` accepts only reads. The DHCP changes go to `POST /api/dhcp`, and the DNS changes go to `POST /api/dns`. Only `dns-zone-read` takes parameters there: `{zone}`, a zone of the last DNS read.

From agent 4.17.0 (capability `plugin-secrets`), a plugin job can carry sealed secrets in `secretParameters`. The portal seals them with the public key of each device. The broker opens them and gives them to the plugin as `parameters.secrets`. It masks them in the job result, the message and the logged plugin errors. A box that does not open fails the job with `AGENT_PLUGIN_SECRET_INVALID`.

From agent 4.19.0 (capability `plugin-ad-identity`), a change runs with the AD account of the technician, not as SYSTEM. For the design, refer to [AD sign-in for plugin changes](plugin-ad-sign-in.md).

- The signed job carries `actAs` next to `plugin` and `operation`: `sessionId`, `userSid`, `logonName`, `account` and `kind`. The plugin never sees it.
- A change without `actAs` fails with `AGENT_PLUGIN_ACCOUNT_REQUIRED` before the start. A read ignores `actAs`.
- The broker gets an S4U token of the account from lsass. A failed logon gives `AGENT_PLUGIN_ACCOUNT_UNAVAILABLE`, or `AGENT_AD_DOMAIN_UNREACHABLE` without a domain controller. A token of another user gives `AGENT_PLUGIN_ACCOUNT_MISMATCH`.
- The broker starts the plugin with `CreateProcessAsUserW` and this token. The job object, the pipes, the environment and the firewall rules stay the same.
- A plugin code `PLUGIN_<NAME>_ACCESS_DENIED` in a run with an account becomes `AGENT_PLUGIN_ACCOUNT_DENIED` with the account.

The broker uploads the data of a job with the job id. The shared builder `PluginProtocol.UploadMessage` makes the upload. Since agent 4.21.2, `ReadResult` gives the data as a copy without a parent. Older agents failed here with "The node already has a parent".

A plugin job always ends with a code. A failed upload gives `AGENT_PLUGIN_UPLOAD_FAILED`. Any other failure without a code gives `AGENT_PLUGIN_FAILED`. The exception text goes only to the agent log.

The agent reports the capabilities `plugin-host` and `plugin-ad-identity`, not the job kinds. `plugin-host` runs `plugin-install`, `plugin-remove` and `plugin-job`. `plugin-ad-identity` runs `ad-sign-in`. The claim and the heartbeat use this mapping from `lib/jobs/requirements.ts`. The heartbeat cancels a pending job only when the agent cannot run its kind.

After a change, the DHCP plugin reads the server again. The broker uploads this read with the job id, as for a read job. The portal stores it as the one DHCP read of the device. After a DNS change, the DNS plugin sends the server read or, after a record change or a zone transfer, the records of that zone. An upload without a job id must be a read.

## Report

The broker reports the verified plugins in its `status` answer. The worker puts them into the heartbeat snapshot as `plugins`, at most 16 entries. Each entry has `name`, `role`, `version`, `capabilities`, `state` (`ready` or `damaged`), `networkBlocked` and an optional `error` code.

The portal accepts an entry with `role`, with `target` or with both. When both are present, `target` wins. An entry without `role` and `target` is refused. The portal stores the entry with `target` and without `role`, so a damaged plugin with the role `unknown` gets the target `unknown`.

A snapshot that the portal stored before this change still has `role`. The portal reads it as the target. The broker keeps the result for at most 15 minutes and checks again after an install or a removal.

Since agent 4.21.1, a plugin that runs right now keeps its last entry in the report. This applies to a read, an install and a removal, also when an install or a removal of another plugin starts a new check. The broker does not keep the entry of a removed plugin. When the broker cannot check a new plugin because it runs, the broker does not keep that report. The next heartbeat then shows the new plugin.

## Signed collection

Each answer of the agent channel contains `signedPluginPolicy`. The portal signs it with the job key (`AGENT_JOB_SIGNING_KEY`), with the kind `plugin-policy` and a lifetime of 15 minutes. The policy contains the DHCP read every 15 minutes, only when the last snapshot reports the plugin `dhcp` as `ready` with `dhcp-read`. In the same way, it contains the DNS read `dns-read` for the plugin `dns`. Without a ready plugin, the list is empty. The policy never contains `dns-zone-read`.

The broker runs each entry of a valid policy on its interval. It keeps only read operations, for example `dhcp-read`, because a periodic run does not check the agent mode. The first run is 60 seconds after the first valid policy or after an install. The broker skips a run during an agent update, an uninstall, a plugin install or a plugin removal. An unsigned, expired or foreign policy stops all collection.

The broker gives the result to the worker with the relay kind `plugin-data-upload`, at most 2 MiB. The worker sends it to `POST /api/agent/plugin-data` with the device credentials and a timeout of 15 seconds.

The portal accepts the data only in these conditions:

- The bearer device is the device of the body, and it reports the plugin as `ready`.
- The body has at most 2.5 MiB. The portal reads the size before it reads the JSON.
- A periodic upload of a plugin comes at most once in 60 seconds. If not, the answer is 429. Only the periodic read of the plugin, `dhcp-read` or `dns-read`, can come without a job.
- A job upload names a running plugin job of the device with the same operation. The portal stores the data of a change job as the read of the device.
- The data agree with the snapshot schema of the plugin, and the collection time is newer than the stored one.
- DNS records of a zone come only with a running job of that device and zone: `dns-zone-read`, a record change or a zone transfer.

The portal keeps only the newest data of each device and plugin, and for DNS the newest records of each zone.

## Checks

`node tests/lib/plugin-release-verify.mjs`, `node tests/repo/plugin-release-ci.mjs`, `node tests/lib/plugin-release-import.mjs`, `node tests/api/plugins.mjs`, `node tests/lib/plugin-policy.mjs`, `node tests/lib/plugin-data.mjs`, `node tests/api/dhcp-manage.mjs`, `node tests/api/dns-manage.mjs`, `node tests/lib/dns-data.mjs` and `node tests/lib/agent-plugins-migration.mjs`. On Windows, `ServerDesk.Agent.exe --plugin-self-test`, `ServerDesk.Plugin.Dhcp.exe --self-test` and `ServerDesk.Plugin.Dns.exe --self-test`.
