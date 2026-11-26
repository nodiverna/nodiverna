# Disk management

In the device area **Management → Disks**, **Query inventory** gets the current Windows storage inventory. It uses a read-only agent job. The inventory shows physical and basic disks, partitions, file systems, drive letters, free areas and state. It also shows the resize limits that Windows reports. After a change, the same job supplies a new inventory.

The drive table has the column **Reported state** with the disk state that Windows reports. A healthy disk shows **OK**.

Supported actions for data drives:

- Initialize an empty RAW disk as GPT or MBR. MBR has a limit of 2 TiB.
- Set a disk online or offline and change its write protection.
- Create a simple NTFS or ReFS volume with a specified size or with the maximum size.
- Make a data volume larger or smaller within the Windows limits of a new query.
- Assign, change or remove a drive letter from D to Z.
- Quick-format a data volume or delete a data partition.

A resize shows **Current** and **New total size**, and the minimum and the maximum. The editor uses whole MiB and gives GiB or MiB as the input unit. It rounds the lower limit up to whole MiB and the upper limit down. It suggests a whole GiB size within the limits as the target. If the free growth is less than one GiB, it uses MiB.

**Use maximum** uses the largest permitted MiB size. Protected Windows volumes always get a target size that is really larger. The portal dialog checks the size and the unit again before the confirmation.

ReFS creation depends on the Windows edition. Windows reports file systems that it does not support, or changes that it cannot do, as job errors. This function does not include dynamic volumes, RAID, Storage Spaces and cluster management.

## Permissions and protection

The inventory needs the device right `diagnose`. Each change needs `manage`, a valid portal MFA session and locally enabled `Management`. ServerDesk classifies all write definitions as disruptive actions. The portal dialog confirms the specified target state. To format or delete, you must also type the disk or partition number. The confirmation is also a part of the parameters that the agent verifies.

The agent protects Windows, boot, system, EFI, reserved, recovery, hidden and read-only partitions. The agent finds the current partition of these items with `Get-Volume -FilePath` and `Get-Partition -Volume`: the Windows system files, its own configuration and binaries and the active page files. If the agent cannot find all of these partitions, it makes no change.

The agent protects all of a disk that has critical system, agent, page file or recovery partitions. The agent also protects a normal MSR on a GPT data disk that is not critical. This does not lock the adjacent data partitions. The agent also protects cluster and Storage Spaces disks.

A narrow exception lets you **enlarge the existing Windows NTFS volume**, for example after you enlarge the system disk of a VM. For this action, the agent checks the current boot partition, the file system, the unchanged target identifier and the maximum size that Windows permits now. The volume must really become larger. Shrink, format, delete, letter changes and status changes of the system disk stay locked. EFI, MSR and recovery partitions do not get this exception. The action does not start a reboot.

The check occurs on the device, and disabled portal buttons do not replace it. Each job binds the disk to its number, its stable `UniqueId` and its expected size. Partitions also bind number, offset and size. Immediately before the change, the agent reads these values again from the storage module. The agent does not change a disk that somebody replaced or changed in the meantime under the same number. It also checks free drive letters and possible volume sizes again.

A newly attached RAW disk can have no partition yet. The storage module sometimes reports this state as `CmdletizationQuery_NotFound_DiskNumber` instead of an empty list. The agent handles only this `ObjectNotFound` case as empty, and only for RAW or for a newly checked GPT or MBR disk with `AllocatedSize = 0`. Access errors, provider errors and other query errors continue to block all changes. In this case, the inventory view shows the disk as protected. The system, agent, page file and cluster checks also apply to empty RAW disks.

The existing TLS connection and the encrypted agent channel carry the jobs and the results. DPAPI protects the native intermediate format and the local agent configuration. Storage cmdlets get specified native objects or numbers. The agent does not interpret parameters as PowerShell code and does not put them into shell commands.

If the partition creation is successful and the format after it fails, the job reports the partial change. The agent does not delete the partition automatically and does not repeat the job. Before you try again, query the inventory again.

## Verification

`node tests/lib/storage-validation.mjs` checks the strict parameter schemas on the server. `node tests/ui/devices/storage-size.mjs` checks the values in whole MiB, the reported resize error and the change between GiB and MiB. `dotnet run --project agent/v3/ServerDesk.Agent.csproj -c Release -- --self-test` contains the native diagnostics, storage and management parameter checks with sample data. These tests do not make real changes to disks.

After these tests, check the real Windows execution on a test VM with a separate disk that you can discard. This implementation uses the Windows storage module of Windows Server 2022/2025 and Windows 11.

References: [Get-Volume](https://learn.microsoft.com/en-us/powershell/module/storage/get-volume?view=windowsserver2025-ps), [Get-Partition](https://learn.microsoft.com/en-us/powershell/module/storage/get-partition?view=windowsserver2025-ps), [New-Partition](https://learn.microsoft.com/en-us/powershell/module/storage/new-partition?view=windowsserver2022-ps), [Format-Volume](https://learn.microsoft.com/en-us/powershell/module/storage/format-volume?view=windowsserver2022-ps).
