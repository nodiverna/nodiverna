# GPU telemetry

Agent 4.6.5 adds the optional `snapshot.gpus` to protocol version 3. The portal stores these readings with the existing CPU and RAM samples after the additive migration `0025_gpu_history`. Older agents and historical samples stay compatible. This change does not include the GPU usage of each process.

## Hardware and sampling

The collector enumerates the DXGI adapters. It recognizes NVIDIA (`0x10de`) and AMD (`0x1002`) adapters. It also recognizes Intel (`0x8086`) adapters if their model contains the word Arc. Other Intel graphics are not included.

The collector also ignores these adapters:

- DXGI software adapters and remote adapters.
- Kernel software adapters, indirect-display adapters, paravirtual adapters and test adapters.

The kernel check is important for a virtual display, for example Parsec. Such a display can inherit the name and the vendor of the physical GPU, but it keeps a separate adapter LUID.

Each reading uses the complete adapter LUID and the index of the physical node. The DXCore count of physical nodes is optional. On older systems, matching counter instances can show more physical nodes. The IDs stay the same during the lifetime of the adapter. They can change after a reboot or a driver update. The collector does not merge identical model names, so two real GPUs of the same model stay separate.

One persistent native PDH query uses the English path `GPU Engine(*)\Utilization Percentage`. It uses this path also on Windows installations in other languages. The query needs the WDDM 2.x GPU performance counters. It does not include compute or TCC telemetry from the vendor.

A rate needs two samples. The collector adds the valid readings of all processes on the same engine. It counts duplicate instances of a process and engine one time. The busiest engine gives the total of the physical GPU. The collector limits the result to 0–100 percent.

A missing provider, a warm-up sample or invalid counters give `null`, never a false zero. This follows the [Windows Task Manager aggregation model](https://devblogs.microsoft.com/directx/gpus-in-the-task-manager/).

The collection runs every 30 seconds in its own existing slot of the telemetry scheduler. Its deadline is six seconds. The heartbeat does not wait for the GPU provider. Only one GPU worker can run at a time. At shutdown, the agent releases the PDH query after that worker is complete.

Counter allocations and item counts have limits. The collector copies native strings before it releases the buffer. For more information, refer to the Microsoft documentation for [PDH counter arrays](https://learn.microsoft.com/en-us/windows/win32/api/pdh/nf-pdh-pdhgetformattedcounterarrayw) and [DXGI adapter descriptions](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/ns-dxgi-dxgi_adapter_desc1).

## Snapshot and overview

`gpus` contains a maximum of 16 entries. Each entry has `id`, `name`, `vendor`, `utilization` and an ISO timestamp `collectedAt`. The heartbeat schema rejects some values before it changes stored data. These values are duplicate IDs, malformed timestamps, unsupported vendors, numbers that are not finite and values outside 0–100.

The device overview shows one GPU card with the model name for each supported adapter. A single GPU is in the existing metric row with CPU and RAM. Multiple GPUs get their own group. The card shows a number only when the device is connected and the sample is not older than two minutes.

For offline, maintenance, revoked, future-dated and unavailable readings, the card shows an em dash. Zero percent is a valid reading. Hosts without GPU telemetry or without supported adapters have no GPU card. The CPU and RAM cards and their process navigation do not change.

## Utilization history

Each accepted heartbeat stores its optional GPU array in the same guarded transaction as the CPU and RAM sample. Migration `0025_gpu_history` adds a nullable JSON column to `samples`. It keeps all existing rows. The migration does not fill in old GPU values from the current snapshot. The collection starts when the upgraded portal gets its next heartbeat with GPU data. No other agent update is necessary.

The history API keeps the existing scoped permission to view the device, the retention of 24 hours and the limit of 3,000 rows. It keeps the GPU identifiers, the models, zero and `null` utilization and the original collection timestamp. Malformed stored GPU JSON does not prevent access to the valid CPU and RAM history.

The overview chart adds a separate color, legend entry and tooltip value for each GPU identity. The chart checks the age of historical values against the sample time of the heartbeat, not against the time when you view the page. Missing, unavailable, future-dated or too old readings stay gaps. The chart does not show them as zero, and it does not connect lines across gaps.

Historical GPU readings stay visible when the device is offline. The chart does not invent past values from the latest inventory. It does not merge different adapters because they have the same model name.

## GPU diagnosis in 4.6.6

The diagnosis menu of the device contains a GPU page when the current snapshot includes recognized NVIDIA, AMD or Intel Arc hardware. The GPU card in the overview opens this page and selects that exact GPU. You can select each adapter independently. The permission to view the device is sufficient, because the page only reads existing telemetry.

While a device is offline, the page keeps the static inventory and the actual utilization history. Current sensor values need these conditions:

- The device is online and not revoked.
- The collection timestamp is not older than two minutes.

Zero stays a valid reading. For old agents, the page shows the utilization and the history with an update hint, not invented hardware values.

Agent 4.6.6 adds the optional `snapshot.gpuDetails`, separate from the core `gpus` array. It contains a maximum of 16 bounded, strict entries with an exact GPU ID and a collection timestamp. The heartbeat schema rejects some values before the heartbeat changes data. These values are duplicate IDs or IDs without a GPU, numbers that are not finite and fields out of range.

The portal stores the full snapshot normally. The history still stores only the original compact utilization entries. This release has no new migration and no sensor history.

| Data | Source and availability |
| --- | --- |
| Model, PCI device/subsystem/revision, dedicated/shared memory capacity | Native DXGI hardware descriptor |
| Windows driver version, WDDM version | Supported DXCore properties; unknown if unavailable |
| PCI bus/device/function | Kernel `D3DKMT_ADAPTERADDRESS` for that exact adapter LUID |
| Dedicated/shared memory currently used | Language-neutral native PDH GPU Adapter Memory counters, exact LUID and physical node |
| NVIDIA driver/VBIOS, temperature, graphics/memory clock, power/limit, fan target, current/max PCIe generation/width, bus width, CUDA cores | Optional exports from the installed NVIDIA NVML driver; independently nullable per sensor |

The agent loads the NVML library only from absolute driver locations in System32 or Program Files. It uses a restricted lookup for DLL dependencies. The agent installs no drivers, downloads no vendor SDK and starts no vendor command.

The optional provider starts only when it is necessary. The agent disposes it with the existing GPU worker after the collection is complete. Missing libraries or exports, unsupported sensors and failed calls affect only their own fields. The existing collector deadline of six seconds and the scheduler with a single worker continue to keep the heartbeat responsive.

The GPU mapping never uses model names or the order of the device enumeration. NVIDIA sensors need a confirmed single physical Windows adapter. They also need an exact match of the PCI bus, device and function, the vendor and device, and the subsystem. The agent rejects NVML domains other than zero, because the Windows adapter address has no PCI domain.

Linked physical nodes do not each get the total capacities and the address of the logical adapter. They also do not get NVIDIA sensors. Exact PDH memory readings for each node are still permitted. The detection of physical nodes includes counter instances after the 16 GPUs that the portal shows.

The fan percentage is the fan speed that the driver wants, with the label **Fan (target)**. It is not a measured RPM. The clock values are the values that the driver reports. The UI applies no DDR multiplier and calculates no bandwidth. The current PCIe speed can correctly be lower than the maximum supported speed when the GPU is idle. Binary memory sizes use GiB.

From agent 4.13.0, `vendorDriverVersion` of an AMD adapter is the AMD Software (Adrenalin) version, for example `25.10.1`. The agent reads the registry value `RadeonSoftwareVersion` of the display class key whose `MatchingDeviceId` contains `VEN_1002&DEV_<device ID>`. A missing, ambiguous or malformed value stays `null`. The agent does not guess a value. For NVIDIA, `vendorDriverVersion` is the NVML driver version. [GPU driver updates](gpu-driver-updates.md) use both values.

Unsupported vendor sensors of AMD and Intel stay unknown. This release does not claim NVIDIA fields for those devices. For more information, refer to the [NVIDIA NVML API reference](https://docs.nvidia.com/deploy/nvml-api/index.html), [DXCore adapter properties](https://learn.microsoft.com/en-us/windows/win32/api/dxcore_interface/ne-dxcore_interface-dxcoreadapterproperty) and [kernel adapter address](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/d3dkmthk/ns-d3dkmthk-_d3dkmt_adapteraddress).

## Validation and release

The standard `node scripts/pipeline.mjs agent` pipeline does these steps:

- It builds the self-contained agent.
- It checks the native installation, the features and the health behavior.
- It runs the self-tests for the GPU utilization and the GPU details.
- It signs the immutable release artifacts.

The GPU tests cover independent native ABI fixtures, the complete LUID mapping and the engine aggregation. They also cover multiple GPUs, linked nodes, unsupported or virtual hardware, provider failures, the warm-up and the disposal.

`ServerDesk.Agent.exe --gpu-telemetry-sample` takes two real GPU samples, with the available details of hardware, driver and sensors. It does not read registration credentials, connect to the portal, install an agent or change a service. To verify the actual hardware readings, run it on Windows 11 or Windows Server with supported graphics drivers. Servers without a display stay supported.

`node scripts/pipeline.mjs verify` covers these items: the actual heartbeat route, the storage of GPU snapshots and samples, and the history authorization. It also covers the rejection of invalid payloads, the additive migration, the rendered overview and the production build. The NAS deployment pipeline applies migration `0025_gpu_history` with `--migrate`. It does this after a consistent backup of the existing database. Agent 4.6.5 is sufficient, because the portal change does not change the installed agent.

We tested the release on a German Windows 11 PC with an NVIDIA GeForce RTX 3090 and a Parsec virtual display. It returned exactly one physical GPU with a real utilization value. Its complete native payload passed the portal schema. We checked AMD, Intel Arc, multiple GPUs and linked nodes with native fixtures, because that hardware was not available for a live test. The browser checks covered filled cards, an idle GPU, an unavailable rate, an offline device and a device without GPUs.

The regression suite of 4.6.6 covers these items:

- The strict admission of details and the storage of the snapshot without changes to the utilization samples.
- The exact GPU selection and navigation, and the read-only permission.
- Old and offline values.
- Native NVML and PDH ABI fixtures, and provider failures.
- Conservative identity checks for multiple nodes and PCI.

We recorded the live sensor validation for the available NVIDIA host with Windows 11. AMD, Intel Arc and linked hardware have only fixture tests and no live verification.

We did a read-only test of the final 4.6.6 release on the same RTX 3090. It matched the actual PCI device, subsystem and BDF. It returned these values:

- The Windows and NVIDIA driver versions and the VBIOS.
- The use of dedicated and shared memory.
- The temperature, the graphics and memory clocks, the power and its limit, and the fan target.
- The current and the maximum PCIe connection.
- The 384-bit memory bus and 10,496 CUDA cores.

The Parsec alias was not included. This GPU payload passed the full portal telemetry schema with a synthetic protocol envelope. The test did not change an installed service or an agent registration.
