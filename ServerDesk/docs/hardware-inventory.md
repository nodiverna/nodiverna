# Hardware inventory

Agent 4.6.7 adds `snapshot.hardware` to the existing v3 heartbeat. The field is optional. Older agents and devices without complete Windows providers stay compatible. The existing CPU and RAM measurements, drive usage and GPU data do not change. This addition needs no database migration.

The **Hardware** tab shows processors, memory modules and slots, physical disks, system, BIOS, mainboard and network adapters. The GPU view continues to use the separate `gpus` and `gpuDetails` fields and their existing sensor providers.

## Collection and error limits

The existing inventory scheduler collects `NativeHardwareInventory` every 900 seconds, and the heartbeats use the result again until the next collection. An explicit inventory refresh can request an earlier collection. The collector runs on its own worker. It stays single-flight when a Windows provider stops responding, and it has a scheduler deadline of 25 seconds. Each WMI query also has a timeout of two seconds. A provider that waits does not block the heartbeats or the other inventory collectors.

`collectedAt` is the time before the queries start, not the later time when they return. The agent discards the cache after two collection intervals plus 15 seconds. `complete:false` and bounded `errors` identify categories that failed or that the agent shortened. Healthy categories stay in the result, and the agent omits a failed category. Unknown single values stay `null`. Diagnostics contain only the error class and known Windows or WMI codes, not arbitrary provider messages.

All operations read local Windows data. The collector installs no driver and opens no remote connection. It does not change the hardware configuration and does not run a management action. Agents in `ReadOnly` mode also report these data.

## Contract and limits

The TS contract is in `lib/types.ts`, and the admission check is in `lib/server/devices/hardware-inventory.ts`. Hardware identifiers have a limit of 128 characters, and other texts have a limit of 256 characters. The agent calculates a hash of long native identifiers before it gives them to the heartbeat. The agent omits duplicate identifiers and records a collection error.

| Category | Fields | Maximum number |
| --- | --- | --- |
| `cpus` | Identifier, name, manufacturer, physical cores, logical processors, maximum clock speed, socket | 64 |
| `memoryModules` | Identifier, slot, bank, capacity, reported and configured speed, form factor, memory type, manufacturer, part number, serial number | 512 |
| `memoryArray` | Number of slots. A verified maximum capacity is not available at this time | one object |
| `disks` | Identifier, model, serial number, capacity, bus, media type, provider state, firmware | 128 |
| `system` | Manufacturer, model, system type, valid system UUID | one object |
| `bios` | Manufacturer, name, version, release date, serial number | one object |
| `baseboard` | Manufacturer, product, version, serial number of the hosting mainboard | one object |
| `networkAdapters` | Identifier, name, manufacturer, MAC address, speed, physical adapter status | 128 |

Byte values are positive, safe JSON integers. CPU clock speeds and RAM speeds keep the MHz values that Windows reports. The agent converts the network adapter speed from bit/s to Mbit/s. The agent uses firmware placeholders such as "To be filled by O.E.M." as unknown values.

The RAM slots come from `Win32_PhysicalMemoryArray` for system memory, and the agent adds the slots of all arrays. `maxCapacityBytes` stays `null`. The reason is that the public Windows documentation gives different units for `MaxCapacity` and `MaxCapacityEx`. The agent does not report the RAM that is installed now as the maximum supported capacity.

Physical disks come from the Windows storage provider `MSFT_PhysicalDisk`. `healthStatus` is the state that this provider reports explicitly (`healthy`, `warning`, `unhealthy`, `unknown`). It is not a SMART test and not a prediction of the service life. If the provider is not available, `Win32_DiskDrive` supplies a basic inventory with unknown media type and state. The agent does not change "SCSI" or `Status=OK` into "NVMe", "SSD" or "healthy". Drive letters and their usage stay separate from the disks.

In **Hardware › Disks**, the column **Reported state** shows this state. A healthy disk shows **OK**.

The agent excludes software and VPN adapters that Windows enumerates explicitly through `ROOT` or `SWD` from the hardware inventory. This also applies when Windows sets their `PhysicalAdapter` property to `true`. The existing network diagnostics and IP configuration continue to show them. Without a reliable provider, the agent does not invent BIOS, CPU or RAM temperatures, fans or SMART wear values.

## Checks

`tests/api/hardware-inventory.mjs` checks the real heartbeat on a PostgreSQL test database. It covers old agents, ReadOnly, null values, size and identity limits, saved partial data and the atomic rejection after a device revocation. `NativeHardwareInventoryTests` checks the Windows transformation with isolated providers. It covers units, errors, VPN filters, cache, deadline and queries that stop responding.

`ServerDesk.Agent.exe --hardware-self-test` runs only the isolated tests. `ServerDesk.Agent.exe --hardware-probe` reads the local Windows inventory one time and writes JSON to stdout. This probe does not register a device, and it does not install or start a service. The JSON can contain hardware serial numbers and the system UUID. Keep it in local diagnostic artifacts, not in the release files.

The agent release pipeline checks the published EXE by default. Some development computers have application control. On these computers, `SERVERDESK_AGENT_SMOKE_MODE=managed` can run the version tests and self-tests through the published assembly and the installed .NET SDK. This mode does not change a Windows policy. It does not confirm that the packaged EXE can start on this computer. Before a production agent rollout, always start the EXE and the service directly on an approved Windows test system.

## Sources

- [Windows: Win32_Processor](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-processor) and [Win32_PhysicalMemory](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-physicalmemory) document the processor and RAM properties and their Windows units.
- [Windows: Win32_PhysicalMemoryArray](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-physicalmemoryarray) documents the number of physical slots and the maximum values for each version.
- [Windows: MSFT_PhysicalDisk](https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-physicaldisk) and [MSFT_StorageFaultDomain](https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-storagefaultdomain) document the storage provider, the bus, media and state values, and the model and serial numbers.
- [DMTF: SMBIOS 3.8](https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_3.8.0.pdf) defines the additional memory types, including DDR5/LPDDR5.
