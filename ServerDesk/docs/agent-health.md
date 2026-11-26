# Agent: reboot status and inventory errors

The fix needs agent 4.6.4. A portal update alone does not change the reports of an agent that is installed already. Older agents stay compatible with the portal.

## A missing schedule is not an inventory error

For a folder or a task that does not exist, the Windows Task Scheduler returns `0x80070002` or `0x80070003`. .NET can change these codes into `FileNotFoundException` or `DirectoryNotFoundException`. The old agent caught only `COMException`. Thus a device without a scheduled ServerDesk system action always reported an incomplete inventory.

The lookup now handles the two HRESULTs as "no schedule", also in their translated exception form. Access errors, connection errors and tasks that are foreign or changed stay real errors. The ownership check and the execution of scheduled system actions do not change.

## Show reboot and file cleanup separately

`PendingFileRenameOperations` contains pairs of source and target. An empty target is a deletion for the next start. The old agent used each entry that was not empty as a reboot request. Some programs add such cleanup entries again. Thus repeated reboots do not always remove this indication.

The agent continues to report Windows servicing, Windows Update and file replacements as `rebootPending`. Valid deletion entries alone show separately as a neutral file cleanup. Incomplete pairs, relative paths and unknown formats stay visible as pending file operations, because this is the safe result. The agent does not delete or change registry entries.

The snapshot can also contain `rebootReasons` with bounded cause codes. It can contain `pendingFileOperationsCount` with the number of deletion entries. The portal checks that the causes agree with each other and shows confirmed reboot causes in the device status. Desired State uses the same native status check.

## Check on 11 October 2026

On the Windows 11 PC of the check, `ServerDeskAgent` ran as `LocalSystem`. `GetFolder("\\ServerDesk")` really returned `FileNotFoundException` with `0x80070002`. The CBS and Windows Update reboot markers were not present. Two deletion entries for `gamingservicesproxy_13.dll.0` and `WRP7A7F.tmp` were present. The last system start was on the same day at 13:24.

The Windows x64 build completed without warnings and errors. The portable health self-tests ran with the real compiled agent assembly in an isolated .NET 10 SDK container on the NAS. Telemetry, UI state and DeviceOverview tests also check these items: the portal admission, neutral cleanup states, confirmed reboots and older agent snapshots.

At first, the Windows application control on the host blocked the normal build apphost and the load of the DLL (`FileLoadException`, `0x800711C7`). The single-EXE agent 4.6.4 from the normal publish step after that could run under the same active policy. The release pipeline passed these checks with the final artifact: the Windows version check, the installer security tests, the feature and DISM tests and the health self-tests. Nobody changed the protection policy. The live check of the Task Scheduler with the new EXE still needs an administrative PowerShell.

These diagnostic commands only read the status. Run the Windows live probe on a host with an application policy that permits the agent. For the Task Scheduler, an administrative PowerShell is necessary:

```powershell
.\ServerDesk.Agent.exe --health-self-test
.\ServerDesk.Agent.exe --native-health-probe
```

The file operations follow the [Windows MoveFileEx documentation](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw). The [.NET documentation](https://learn.microsoft.com/en-us/dotnet/api/system.io.filenotfoundexception) describes the HRESULT of `FileNotFoundException`.
