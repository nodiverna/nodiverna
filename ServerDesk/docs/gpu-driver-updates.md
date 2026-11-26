# GPU driver updates

Hardware → GPU shows the installed graphics driver of a device and the newest driver that NVIDIA or AMD offers for the graphics card. If the installed driver is older, you can start the update from the same card. The agent downloads the vendor package, checks its signature and installs it silently. You do not need remote desktop or a manual download.

This function needs agent 4.13.0 or later. Agents of version 4.11.x and older continue to report without change. The **Update driver** button tells you to update the agent.

## The Graphics driver card

The card is directly below the name of the selected graphics card. It shows these items:

- The installed version, as the large number.
- **Latest from NVIDIA** or **Latest from AMD**, with the version and the release date.
- The status: **Up to date**, **Update available**, **Status unknown** or **Not supported**.
- **Checked** with the time of the last lookup, and **Check again**.
- **Update driver**.

The **Drivers** card with the Windows driver version stays below.

After a successful update, the card shows the new version as the installed version at once. Until the device reports the new version, the card shows a note:

- "NVIDIA driver 621.14 is installed. The new version shows here once the device reports it."
- If the device reports an older version, a second line shows it, for example "The device still reports 581.57."

When the device reports the new version, the note goes away. You do not have to load the page again.

If a device has more than one graphics card of one vendor, one vendor package updates all of them. The card tells you this. A device with an NVIDIA and an AMD card has one card state for each vendor. Select the graphics card of the vendor to see its state.

The command palette has the entry **Update graphics driver** for the open device. It opens Hardware → GPU.

## Status rules

The portal compares the installed version with the newest version of the vendor. It compares the numbers segment by segment, so `581.9` is older than `581.57` and `25.9.1` is older than `25.10.1`.

| Condition | Status | Reason |
|---|---|---|
| The agent did not report an installed version | **Status unknown** | `installed-unknown` |
| The vendor lookup failed | **Status unknown** | `lookup-failed` |
| The vendor offers no driver for the model | **Not supported** | `unsupported-model` |
| The vendor offers no driver for the Windows version | **Not supported** | `unsupported-os` |
| The installed version is older than the newest version | **Update available** | none |
| The installed version is the same or newer | **Up to date** | none |

If a device has more than one graphics card of one vendor, the oldest installed version decides.

### Recent install

A successful update counts as installed before the device reports the new version. A recent install is the newest `install-gpu-driver` job of the device for the vendor with these properties:

- The job succeeded with `AGENT_GPU_DRIVER_INSTALLED` or `AGENT_GPU_DRIVER_INSTALLED_REBOOT`.
- The job result names a valid version.
- The job ended in the last 24 hours.

If the device reports no version or an older version than the recent install, the version of the recent install is the installed version. The status uses this version. When the device reports the same or a newer version, the portal uses the reported version again.

You can install an older driver manually within the 24 hours. Then the card shows the version of the recent install until the 24 hours end.

The installed version comes from the agent:

- NVIDIA: the portal calculates a version from the Windows driver version. It uses the last five digits of the last two fields, so `32.0.15.8157` becomes `581.57`. The NVIDIA driver also reports its version through NVML. If both versions are known, the newer one is the installed version, else the one that is known. After a driver update, NVML of an older agent can report the old version until the agent restarts.
- AMD: the AMD Software (Adrenalin) version, for example `25.10.1`. Agent 4.13.0 reads it from the registry value `RadeonSoftwareVersion` of the display adapter. The portal never calculates an AMD version from the Windows driver version.

## Vendor coverage

| Vendor | Cards | Driver | Windows |
|---|---|---|---|
| NVIDIA | GeForce | Game Ready driver, WHQL | Windows 10 and Windows 11 x64 |
| NVIDIA | NVIDIA RTX and Quadro | RTX Enterprise driver, WHQL | Windows 10, Windows 11 and Windows Server x64 |
| AMD | Radeon RX 5000 series and newer | AMD Software: Adrenalin Edition, WHQL, the release that AMD marks as Recommended | Windows 10 and Windows 11 x64 |

The portal does not support other models, for example NVIDIA data center cards, Radeon PRO and older Radeon cards. These cards show **Not supported**. AMD on Windows Server also shows **Not supported**. Intel graphics cards get no card.

NVIDIA finds the card by its product name in the NVIDIA product list. The NVIDIA lookup service does not mark the branch of an RTX Enterprise driver. The portal uses the newest certified RTX Enterprise driver that NVIDIA lists for the card. It does not use a release that NVIDIA names "New Feature Branch". It does not use beta, Studio or feature preview drivers.

AMD finds the card by its name in the driver index `https://www.amd.com/en/support/download/drivers.html`. The index has one driver page for each Radeon RX card. The portal reads the Windows 11 section of this page, or else the Windows 10 section. It takes the release that AMD marks as **WHQL (Recommended)**. It does not use an **Optional** release.

AMD has different installers for different card families, for example one for RX 5000 and RX 6000 and one for RX 7000 and RX 9000. Thus, the portal reads the page of each card model. If the index has no page for the card name, the card shows **Not supported**.

The portal gets the size of a package with a request for its first byte. The answer names the full size. The AMD download host compresses its answer to a HEAD request, so the length of that answer is not the size of the package.

## Lookup and cache

The portal looks up the newest driver, not the device. One cache serves all devices, and an endpoint change needs no agent release.

- The portal keeps a result for 6 hours for each vendor, model and Windows family. It keeps a failed lookup for 15 minutes.
- **Check again** skips the cache. You can do this once every 5 minutes for each device. A second check within 5 minutes shows the cached result and a note.
- Each portal process makes at most 30 forced lookups for each vendor in 5 minutes, for all devices together. A lookup that needs no request to the vendor does not count. If the limit is reached, **Check again** shows the cached result, or does a normal lookup if there is no cached result. The card then shows the note "Many driver checks ran in the last few minutes, so the last result is shown. Try again in a few minutes."
- A graphics card name of more than 96 characters (without the trademark signs) shows **Not supported**. The portal sends no request for it.
- Each request has a time limit of 15 seconds and reads at most 2 MiB.
- The cache is in memory. Each portal process keeps its own cache. A restart clears it.

## Rights and conditions

To see the status, you need the device right `view` (**View devices and monitoring**). To start an update, all of these conditions must be true:

- You have the device right `manage` (**Change Windows configuration**).
- The device is online and the agent has version 4.13.0 or later.
- The agent runs in Management mode.
- You confirm the update, and you confirm your identity with MFA.
- No other driver update waits or runs on the device. This applies to both vendors. The server checks it again when it writes the job, so two requests at the same time write only one job.
- The status is **Update available**.

On sample devices, the card shows fixed sample data, and the update stays blocked.

The device assistant can also propose the update, and the same checks apply when you run it. Refer to [AI assistant](ai-assistant.md).

Before the portal queues the job, it does the lookup again on the server. The job stores the vendor, the version, the download URL and the size. The URL and the size always come from this lookup, never from the browser. The portal refuses the job in these cases. For an unsupported model or Windows version, the refusal has the same text as the card.

| Code | Cause |
|---|---|
| `GPU_DRIVER_NO_GPU` | The device has no graphics card of the vendor. |
| `GPU_DRIVER_UNSUPPORTED_OS` | The vendor offers no driver for the Windows version of the device. |
| `GPU_DRIVER_UNSUPPORTED_MODEL` | The vendor offers no driver for the graphics card. |
| `GPU_DRIVER_LOOKUP_FAILED` | The lookup failed. |
| `GPU_DRIVER_NO_UPDATE` | The status is not **Update available**. |
| `GPU_DRIVER_VERSION_CHANGED` | The vendor offers a different version now. The card loads again. |
| `GPU_DRIVER_ALREADY_INSTALLED` | A recent install has the same or a newer version, and the device has not reported it yet. The card loads again. |
| `GPU_DRIVER_JOB_ACTIVE` | Another driver update waits or runs on the device. The portal checks this before the lookup. The card loads again. |

## Hosts

The portal needs outbound HTTPS to these hosts for the lookup:

| Vendor | Lookup | Size check |
|---|---|---|
| NVIDIA | `www.nvidia.com`, `gfwsl.geforce.com` | `us.download.nvidia.com`, `international.download.nvidia.com` |
| AMD | `www.amd.com` | `drivers.amd.com` |

The devices need outbound HTTPS to the download hosts only: `us.download.nvidia.com`, `international.download.nvidia.com` and `drivers.amd.com`.

The portal and the agent accept a download URL only on these conditions. It uses HTTPS and has no user information and no port. It names one of these download hosts. The agent has its own copy of this list. A redirect to another host stops the request. Without the lookup hosts, the card shows that the latest version could not be checked.

## Download and signature

The worker of the agent downloads the package from the vendor host. It sends no device token to the vendor. It checks the host again, also for each redirect. The declared and the received length must be equal to the size of the job. The package can be at most 3 GiB. The download has a time limit of 30 minutes.

The broker copies the download into its own staging folder. Only SYSTEM and Administrators have access to this folder. The broker calculates the SHA-256 of the package while it copies. The job result contains this hash.

Then the broker checks each Authenticode signature of the staged file with `WinVerifyTrust`, on the open file handle. A file can have more than one signature: the primary signature and nested signatures. The broker checks all of them, each with revocation checks for the full chain. It reads the signer certificate from the same check that verified the signature.

The broker accepts the file if one signature agrees with all of these rules:

- The signature is valid.
- The subject organization of the signer certificate is one of these values:
  - NVIDIA: `NVIDIA Corporation`
  - AMD: `Advanced Micro Devices, Inc.` or `Advanced Micro Devices Inc.`
- The digest algorithm is SHA-256, SHA-384 or SHA-512.

A signature that is not valid, comes from another signer or uses SHA-1 does not count. All signatures of a file sign the same file digest, so a nested signature of the vendor is sufficient. If no signature agrees with the rules, the job fails with `AGENT_GPU_DRIVER_SIGNATURE`. The package never runs. The vendors publish no hash, so TLS to the fixed hosts and the pinned signer give the integrity.

## Install

The broker starts the verified file directly, without `cmd.exe` and without PowerShell. The arguments are fixed:

- NVIDIA: `-s -noreboot`
- AMD: `-INSTALL`

No value from the portal goes into the arguments. The installation has a time limit of 30 minutes. After that, the agent stops the installer and all its child processes.

**Warning:** During the installation, the screen goes dark for a few seconds. Remote desktop sessions can disconnect. The job continues, and you can connect again. The NVIDIA package can also install the NVIDIA App.

The agent deletes the staged file and the downloaded part after each result. This includes a cancellation. If the agent restarts during the job, it deletes these files at the next start and reports `AGENT_JOB_INTERRUPTED`. After the installation, the agent asks for a new inventory, so the card shows the new version. Agent 4.17.2 and later also load the NVIDIA library (NVML) again when Windows reports a new driver version for the card. Thus NVML reports the new version without a restart of the agent.

## Restart

The agent never restarts the device. These results tell you that a restart is necessary:

- The installer ends with exit code 3010 or 1641.
- The installer ends with exit code 0, and Windows reports a pending restart.

Then the job result is `AGENT_GPU_DRIVER_INSTALLED_REBOOT`, and the card shows **Restart the device to finish the driver update.** Restart the device at a time that suits its users.

## Job results

| Code | Meaning |
|---|---|
| `AGENT_GPU_DRIVER_INSTALLED` | The driver is installed. |
| `AGENT_GPU_DRIVER_INSTALLED_REBOOT` | The driver is installed. A restart is necessary. |
| `AGENT_GPU_DRIVER_SIGNATURE` | The package has no valid signature of the vendor. It did not run. |
| `AGENT_GPU_DRIVER_DOWNLOAD_FAILED` | The device could not download the package from the named host. |
| `AGENT_GPU_DRIVER_DISK_SPACE` | The system drive has less free space than three times the package size. |
| `AGENT_GPU_DRIVER_INSTALL_FAILED` | The installer ended with another exit code. |
| `AGENT_GPU_DRIVER_TIMEOUT` | The installation did not end within 30 minutes. |
| `AGENT_GPU_DRIVER_NO_GPU` | The agent found no graphics card of the vendor. |
| `AGENT_GPU_DRIVER_INVALID` | The job parameters are not valid. |
| `AGENT_BUSY` | Another job runs on the device. |

## Items to validate on hardware

These items need a check on real devices with the current vendor installers:

- The silent switches `-s -noreboot` and `-INSTALL`.
- The exit codes for a necessary restart. The agent uses 3010 and 1641 for both vendors.
- The signatures of the current NVIDIA and AMD installers (`signtool verify /pa /all /v`). Record the number of signatures, the signer and the digest algorithm of each.

Record the results of these checks in this section.

## Tests

- `tests/lib/gpu-driver-installed.mjs`, `tests/lib/gpu-driver-catalog.mjs`, `tests/api/gpu-driver-route.mjs` and `tests/ui/devices/gpu-driver-view.mjs` check the portal.
- `tests/agent/agent-gpu-driver-source.mjs` checks the agent sources.
- The agent self-test is `--gpu-driver-self-test`.
