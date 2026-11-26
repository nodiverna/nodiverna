# Health signals contract (protocol 3)

Agent 4.10.0 adds four health signals to the heartbeat snapshot of protocol version 3. The protocol version stays `3`. All new fields are optional, so agents of version 4.9.x continue to report without change. The portal rejects a heartbeat with an unknown key inside one of these objects. The portal side is in [device-health-signals.md](device-health-signals.md).

## Snapshot fields

| Field | Content | Limits |
|---|---|---|
| `osInfo` | The values that decide the lifecycle of Windows | strings at most 100 characters |
| `crashes` | The crashes of the last 30 days, newest first | at most 50 entries |
| `crashInventory` | The state of the crash collection | object |
| `bitlocker` | The BitLocker state of every volume | at most 64 volumes |
| `softwareChecksum` | The SHA-256 of the software list, or `null` before the first collection | 64 lower-case hex digits |

### osInfo

`osInfo` is `{editionId, installationType, displayVersion, ubr, productName, currentBuild}`. The agent reads the values `EditionID`, `InstallationType`, `DisplayVersion`, `UBR`, `ProductName` and `CurrentBuild` of `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`. When `DisplayVersion` is missing, the agent uses `ReleaseId`. `ubr` is a whole number or `null`. A missing string is `null`.

### crashes and crashInventory

Each entry of `crashes` has these fields:

| Field | Values |
|---|---|
| `id` | A stable hash of the kind and the time, hex |
| `kind` | `bugcheck`, `unexpected-shutdown` or `hardware-error` |
| `at` | The crash time as an ISO date |
| `stopCode` | The stop code as an unsigned 32-bit number, or `null` |
| `parameters` | Four hex strings such as `0x00000000c0000005`, or `null` |
| `driver` | `{name, version, manufacturer}` or `null` |
| `source` | `event`, `minidump` or `event+minidump` |
| `dumpFile` | The file name of the minidump without a path, or `null` |
| `dumpStatus` | `parsed`, `unreadable`, `too-large` or `none` |
| `detail` | The WHEA error source and type, or `null` |

Every string has at most 256 characters. Events within 10 minutes of each other are one crash. A bugcheck code makes the kind `bugcheck`. Else a WHEA error makes it `hardware-error`. Else the kind is `unexpected-shutdown`. `at` is the shutdown time of event 6008 when it is known, else the earliest event time of the crash.

The agent parses at most 20 minidumps for each run and caches each result by name, size and write time. It skips files larger than 32 MiB (`too-large`). A damaged or manipulated file gives `unreadable`, and the event data stays. The dump bytes, the memory contents and all paths stay on the device.

From agent 4.13.1, the agent opens each dump without following junctions or symbolic links. Before it reads a byte, it checks the type and the size of the opened file. A link, a folder, a device or an offline file gives `unreadable`. The agent does not look up a driver whose name is a reserved device name, for example `CON`, `NUL` or `COM1`. It also does not look up a name that ends with a space or a dot. The crash then shows the driver name without a version and a manufacturer.

`crashInventory` is `{collectedAt, windowDays, complete, truncated, error?}`. `windowDays` is always 30. `truncated` is `true` when the agent dropped older entries because of the limit of 50. `error` tells which source failed when `complete` is `false`.

### bitlocker

`bitlocker` is `{available, reason?, collectedAt, volumes}`. When the namespace or the class is missing, the agent sends `available: false` with the reason `not-supported` and no volumes. This occurs on Home editions and on servers without the BitLocker feature. The other reasons are `access-denied` and `error`.

Each volume is `{drive, volumeType, conversion, percent, protection, method, protectors, suspendedSince}`:

- `drive` is a drive letter such as `C:`, or `null`.
- `volumeType` is `os`, `fixed` or `removable`.
- `conversion` is `decrypted`, `encrypted`, `encrypting`, `decrypting`, `paused-encrypting`, `paused-decrypting` or `unknown`.
- `percent` is the encryption percentage from 0 to 100, or `null`.
- `protection` is `on`, `off`, `suspended` or `unknown`. `suspended` means that the volume is encrypted, or is being encrypted, while its protection is off.
- `method` is `none`, `aes-128-diffuser`, `aes-256-diffuser`, `aes-128`, `aes-256`, `hardware`, `xts-aes-128`, `xts-aes-256` or `unknown`.
- `protectors` is a list of unique kinds: `tpm`, `tpm-pin`, `tpm-startup-key`, `tpm-pin-startup-key`, `external-key`, `numerical-password`, `passphrase`, `public-key`, `tpm-certificate`, `ad-account` or `unknown`.
- `suspendedSince` is the time when the agent first saw the suspension, or `null`.

The agent calls only `GetConversionStatus`, `GetProtectionStatus`, `GetEncryptionMethod`, `GetKeyProtectors` and `GetKeyProtectorType`. It uses the protector IDs only to call `GetKeyProtectorType` and sends no IDs. It never calls a method that returns or stores a secret.

## Software list

The agent reads the uninstall keys of the 64-bit view (`x64`, or `arm64` on ARM64) and of the 32-bit view (`x86`). It also reads the user hives that Windows already loaded under `HKEY_USERS\S-1-5-21-*`. User entries have `scope: user` and `architecture: null`. The agent skips entries without a display name, system components, entries with a parent key and updates.

Each item is `{key, name, version, publisher, installDate, architecture, scope}`. `key` is the name of the uninstall subkey. `installDate` is `YYYY-MM-DD` or `null`. Strings have at most 256 characters. The agent never reads path values. It replaces a user folder `X:\Users\<name>` in a string with `X:\Users\…`.

The list has at most 2000 items, sorted by scope, architecture and key. The agent also keeps the body below 900,000 bytes. `count` is the number of entries that the agent found, and `truncated` is `true` when it sent fewer.

The checksum is the SHA-256, in lower-case hex, of the UTF-8 bytes of a canonical JSON array. Each element is `[scope, architecture, key, name, version, publisher, installDate]`. The elements are sorted by code unit by the first three values. The JSON escapes only quotes, backslashes and control characters, like `JSON.stringify`. `lib/software-inventory.ts` and `NativeSoftwareInventory.cs` compute the same value.

### POST /api/agent/software

The worker sends `{serverId, checksum, count, truncated, items}` with the device bearer. It sends the list only in these cases:

1. The checksum differs from the last checksum that the portal acknowledged.
2. The heartbeat answer contains `softwareResync: true`.

A heartbeat answer without `softwareResync` acknowledges the checksum of its snapshot. The agent sends at most one list in 60 seconds. After a failure, it waits longer each time, at most 30 minutes.

The portal authenticates the bearer before it reads the body. The body has a limit of 1 MiB. The portal checks the list strictly and computes the checksum again. A different checksum gives 400 `SOFTWARE_REPORT_INVALID`. A second list of the same device within 60 seconds gives 429.

### softwareResync

The heartbeat answer is `{ok, intervalSeconds}`. It also contains `softwareResync: true` when `softwareChecksum` is set and differs from the stored state, or when the portal has no state. Otherwise the field is absent.

## Health signals in 4.11.0

Agent 4.11.0 adds five health signals. The protocol version stays `3`. All new fields are optional, so agents of version 4.10.x and older continue to report without change. The objects are strict, as in 4.10.0. An unknown key such as `privateKey` or `rawData` rejects the heartbeat.

| Field | Content | Limits |
|---|---|---|
| `driverHealth` | Device Manager errors and a summary of the driver list | 100 problem devices, 20 unsigned drivers |
| `reliability` | The stability index and the program events of the last 30 days | 30 days, 100 events |
| `diskHealth` | The state of each physical disk and the disk errors of the last 30 days | 64 disks, 50 events |
| `battery` | The capacity of each battery | 4 batteries |
| `certificates` | The certificates of the machine stores `My`, `WebHosting` and `Remote Desktop` | 100 certificates |
| `autostartChecksum` | The SHA-256 of the autostart list, or `null` before the first collection | 64 lower-case hex digits |

Every string has at most 256 characters, unless this section gives a different limit. Dates are ISO dates.

### driverHealth

`driverHealth` is `{collectedAt, checksum, count, truncated, unsignedCount, unsigned, problems, problemsTruncated}`. `checksum`, `count` and `truncated` describe the driver list. `unsigned` holds at most 20 unsigned drivers as `{key, deviceName, infName, file, provider, version}`. `unsignedCount` is the number of all unsigned drivers.

Each entry of `problems` is `{key, name, class, code, manufacturer}`. The agent reads the devices with a Device Manager error code other than 0. `code` is the Device Manager error code. `key` is the first 16 hex digits of the SHA-256 of the device ID. The device ID itself never leaves the device. `problemsTruncated` is `true` when the agent found more than 100 problem devices.

Since 4.11.1, the agent reads the drivers without WMI. CfgMgr32 gives the present devices with their instance ID, problem code, name, class, INF file, version, date and provider. The file of a driver comes from the `ImagePath` of the driver service in the registry. `key` is the same as in 4.11.0.

`signed` and `signer` come from an offline catalog check of `%SystemRoot%\INF\<infName>`. This check uses no network access and no revocation checks. `valid` gives `true` with the common name of the signer. `invalid` and `unsigned` give `false`. The broker process keeps the results in a cache.

Each run spends at most 20 seconds on INF files that are not in the cache. An INF file that the agent did not check yet has `signed: null` and `signer: null`. The next run checks these files first, so the list is complete after some runs.

### reliability

`reliability` is `{collectedAt, windowDays, stability, events, truncated}`. `windowDays` is always 30.

`stability` is `{available: true, current, days}` or `{available: false, reason}`. `current` is the stability index from 1.0 to 10.0 with one decimal. `days` holds the last value of each day as `{day, index}`, at most 30. The agent reads `Win32_ReliabilityStabilityMetrics`. It never estimates a value. The reasons are:

- `collection-disabled`: Windows collects no reliability data. This is the default on Windows Server (`WMIEnable` = 0).
- `not-supported`: the class is missing.
- `access-denied` and `error`: the agent cannot read the data.

Each entry of `events` is `{at, kind, program, version, module, moduleVersion}`. Application Error 1000 gives the kind `crash`, and Application Hang 1002 gives `hang`. The records of `MsiInstaller` 11708 and `Microsoft-Windows-WindowsUpdateClient` 20 in `Win32_ReliabilityRecords` give `install-failure`. `program` and `module` are file names without a path. The list is newest first, and `truncated` is `true` when the agent dropped events. Without the reliability provider, the crashes and hangs still come from the Application log.

### diskHealth

`diskHealth` is `{collectedAt, disks, events}`. Each disk is `{id, number, model, busType, mediaType, health, operationalStatus, driveLetters, countersAvailable, wearPercent, temperatureC, temperatureMaxC, readErrorsUncorrected, powerOnHours}`:

- `mediaType` is `ssd`, `hdd`, `scm` or `unspecified`.
- `health` is `healthy`, `warning`, `unhealthy` or `unknown`.
- `operationalStatus` is a list of values such as `ok`, `degraded`, `predictive-failure`, `failed`, `lost-communication` or `unknown`.
- `driveLetters` holds the drive letters of the partitions of the disk, such as `C:`.
- The counters come from `MSFT_StorageReliabilityCounter`. A counter that the disk does not report is `null`, never 0. `countersAvailable` is `false` when the disk has no counter object.

The agent sends no serial numbers.

`events` is `{windowDays, items, counts, truncated}`. Each item is `{at, source, eventId, disk, volume}`. The agent reads the System log entries `disk` 7, 51 and 153 and `Ntfs` 55. `disk` is the number from `\Device\HarddiskN` or `null`. `counts` gives the number of events of each disk in the window, with the key `unknown` for events without a disk number. `items` holds the newest 50 events.

### battery

`battery` is `{collectedAt, present, reason?, batteries}`. Each battery is `{id, name, designCapacityMWh, fullChargeCapacityMWh, healthPercent, cycleCount}`. The agent joins `BatteryStaticData`, `BatteryFullChargedCapacity` and `BatteryCycleCount` of `root\wmi` by instance name. `healthPercent` is the full charge capacity divided by the design capacity, from 0 to 150. A design capacity of 0 gives `healthPercent: null`.

Without a `Win32_Battery` instance, the agent sends `present: false` with the reason `no-battery`. When the battery exists but the `root\wmi` classes are missing, the agent sends `present: true` with the reason `not-supported` and no batteries.

### certificates

`certificates` is `{collectedAt, items, truncated}`. Each item is `{thumbprint, stores, subject, sans, issuer, notBefore, notAfter, hasPrivateKey, selfSigned, bindings}`:

- `thumbprint` is the SHA-1 thumbprint in upper-case hex. A certificate in two stores is one item with two `stores`.
- `sans` holds at most 10 DNS and IP entries.
- `bindings` holds `{type: "https", endpoint}` from the http.sys registry keys `SslBindingInfo` and `SslSniBindingInfo`. It holds `{type: "rdp", endpoint: "RDP-Tcp"}` from `Win32_TSGeneralSetting`.

The agent opens the stores read-only and reads only whether a private key exists. It never reads a private key and never sends certificate data. The list holds at most 100 certificates, the first to expire first, and at most 64 KiB.

## Microsoft Defender in 4.14.0

The broker collector "Defender" runs every 300 seconds with a deadline of 20 seconds. It is a fixed read without arguments. The agent sends the capability `defender-status`. The snapshot key is `defender`. The key `security.defender` does not change.

When the namespace `root\Microsoft\Windows\Defender` or the class `MSFT_MpComputerStatus` is missing, `defender` is `{available: false, reason: "not-installed", collectedAt}`. Denied access gives the reason `access-denied`, and other failures give `error`. Then the object has no other fields.

Else `defender` is `{available: true, collectedAt, mode, antivirusEnabled, realTimeProtection, tamperProtected, quickScanAt, fullScanAt, signatureAt, signatureVersion, productVersion, otherAntivirus, detectionCount, activeCount, highestActiveSeverity, truncated, detections, exclusions}`:

- `mode` comes from `AMRunningMode`: `normal`, `passive`, `sxs-passive`, `edr-block`, `not-running` or `unknown`.
- `tamperProtected` is `true`, `false` or `null`. The times are ISO times or `null`. A missing or zero time gives `null`.
- `signatureVersion` and `productVersion` have at most 64 characters, or are `null`.
- `otherAntivirus` holds at most 4 products `{name, enabled}` from `root\SecurityCenter2` `AntiVirusProduct`, without Defender itself. `enabled` is true when bits 12 to 15 of `productState` are 1. Windows Server has no Security Center, so the value is `null`.
- `detections` holds the newest 100 detections from `MSFT_MpThreatDetection` and `MSFT_MpThreat`. Each is `{id, threatId, name, severity, status, active, path, resourceCount, at, user}`.
- `severity` is `low`, `moderate`, `high`, `severe` or `unknown`. `status` is `detected`, `cleaned`, `quarantined`, `removed`, `allowed`, `blocked`, `failed`, `abandoned` or `unknown`.
- `active` is `IsActive` of the threat. Without a threat row, the statuses `detected`, `failed` and `abandoned` are active.
- `path` is the first resource without its type prefix, such as `file:_`. `resourceCount` is the number of resources.
- `detectionCount` is the total, `activeCount` counts all active detections and `truncated` is `detectionCount > 100`. `highestActiveSeverity` is the highest severity of an active detection, or `null`.
- `exclusions` is `{paths, extensions, processes}` from `MSFT_MpPreference`, with at most 200 entries of each. When the agent cannot read them, the value is `null`.

A failed read of the detections or the exclusions does not fail the status. The detections are then empty and the agent adds a collection warning. Text has at most 500 characters. The portal rejects the Heartbeat when a key is unknown or the counts do not agree with the list.

The collector only reads. It calls no WMI method, starts no PowerShell and changes no preference.

## Collector errors in 4.11.1

Agent 4.11.1 adds the optional top-level field `collectorErrors`. It holds one entry for each collector whose most recent run failed, and at most 30 entries. Each entry is a strict object `{collector, code, since, lastAt, failures, elapsedMs}`:

| Key | Content |
|---|---|
| `collector` | The ID of the collector: the name in lower case, with `-` for each space. Examples: `drivers`, `software-inventory`, `disk-and-battery-health`, `bitlocker`, `performance-counters`. The pattern is `^[a-z][a-z0-9-]{0,47}$`. |
| `code` | `timeout`, `access-denied`, `not-supported`, `broker-unavailable` or `error` |
| `since` | The ISO time of the first failure in the current series |
| `lastAt` | The ISO time of the most recent failure |
| `failures` | The number of failures in the series, from 1 to 1,000,000 |
| `elapsedMs` | The time of the failed attempt in milliseconds, from 0 to 3,600,000, or `null` |

The codes have these causes:

- `timeout`: a WMI timeout or a canceled WMI call, a `TimeoutException`, or a collector that has no result after its deadline.
- `access-denied`: the agent has no access, for example `UnauthorizedAccessException` or Windows error 5.
- `not-supported`: Windows does not provide the data, for example an unknown WMI class or namespace, or a missing DLL.
- `broker-unavailable`: the worker cannot reach the SYSTEM broker through its pipe.
- `error`: all other failures.

A failure in the broker keeps the code of the broker. A successful run removes the entry. The strings in `collectionErrors` do not change, so older portals and the rule **Inventory incomplete** continue to work. An entry with an unknown key or code rejects the heartbeat, as for the other strict fields. A snapshot without `collectorErrors` stays valid.

After a failed driver read, the worker keeps the last successful `driverHealth` with its old `collectedAt`. The old driver list stays available for the upload. This continues until the next successful read. The other collectors drop their old values after two intervals and 15 seconds, as before. The device page shows only the `drivers` entry.

## Driver and autostart lists

The driver list and the autostart list travel like the software list. The snapshot carries only the checksum. The worker sends the full list only when the checksum differs from the last acknowledged checksum, or when the heartbeat answer asks for it. It sends at most one list of each kind in 60 seconds and waits longer after each failure.

Each list has at most 2000 items and 900,000 bytes. `count` is the number of entries that the agent found, and `truncated` is `true` when it sent fewer. The checksum is the SHA-256 of the canonical JSON of the items, sorted by `key` or `id`. `lib/driver-inventory.ts` and `lib/autostart-inventory.ts` compute the same value as the agent.

### POST /api/agent/drivers

The body is `{serverId, checksum, count, truncated, items}`. Each item is `{key, deviceName, deviceClass, infName, file, service, provider, version, date, signed, signer}`. `file` is the file name of the driver service, such as `vjoy.sys`. `date` is `YYYY-MM-DD` or `null`.

The portal authenticates the bearer before it reads the body. The body has a limit of 1 MiB. The portal checks the list strictly and computes the checksum again. A different checksum gives 400 `DRIVER_REPORT_INVALID`. A second list of the same device within 60 seconds gives 429. The portal replaces the stored list in one transaction, and an identical checksum only updates the report time.

### POST /api/agent/autostart

The body has the same envelope. Each item is `{id, category, scope, location, name, command, target, signature, signer, publisher, microsoft, userPath}`:

- `category` is `run`, `run-once`, `startup-folder`, `winlogon`, `service` or `task`. `scope` is `machine` or `user`.
- `id` is the SHA-256 of `[category, scope, location, name, command]`. A changed command gives a new entry.
- The agent masks passwords, tokens and URL user information in `command` before it computes the ID. It masks credential arguments such as `-password`, `--api-key`, `--client-secret` and `--access-token`. It also masks the string of `ConvertTo-SecureString`, the value after `Bearer`, `Password=` and `Pwd=` in connection strings and the password in `://user:pass@`. A value can be in quotes, also in quotes with a backslash (`\"…\"`). A quote inside a value without quotes, as in `O'Brien1`, does not end the value.
- The agent replaces a user folder `X:\Users\<name>` with `X:\Users\…`, also with `/`, with mixed `\` and `/`, and for `X:\Documents and Settings\<name>`. It sends no SID and no user name. The server rejects a report with a user folder that is not replaced.
- `signature` is `valid`, `invalid`, `unsigned` or `unknown`. The agent checks the embedded signature and the system catalogs locally, without revocation checks.

The portal checks the list like the driver list. A different checksum gives 400 `AUTOSTART_REPORT_INVALID`. The first list of a device is the baseline. Later lists add unknown entries as new and delete missing entries. A truncated list deletes nothing.

### driverResync and autostartResync

The heartbeat answer contains `driverResync: true` when `driverHealth.checksum` differs from the stored state, or when the portal has no state. It contains `autostartResync: true` under the same conditions for `autostartChecksum`. Otherwise the fields are absent. The fields are only hints. When the portal cannot check the state, it omits the field, and the next heartbeat asks again.
