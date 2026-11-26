using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace ServerDesk.Agent;

internal static class ProcessLifetime
{
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { public long PerProcessUser, PerJobUser; public uint Flags; public UIntPtr Minimum, Maximum; public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct Limits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct Startup { public uint Size; public string? Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags; public ushort ShowWindow, ReservedBytes; public IntPtr ReservedPointer, Input, Output, Error; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr Process, Thread; public uint Id, ThreadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObjectW(IntPtr security, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessW(string exe, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo info);
    private static IntPtr serviceJob;
    internal static void AttachService(bool allowUpdaterBreakaway = true)
    {
        if (serviceJob != IntPtr.Zero) return;
        IntPtr handle = CreateJobObjectW(IntPtr.Zero, null); if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        var limits = new Limits { Basic = new BasicLimits { Flags = 0x2000u | (allowUpdaterBreakaway ? 0x800u : 0u) } }; // KILL_ON_JOB_CLOSE, BREAKAWAY_OK for the separate updater only.
        if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf<Limits>()) || !AssignProcessToJobObject(handle, GetCurrentProcess())) { int error = Marshal.GetLastWin32Error(); CloseHandle(handle); throw new System.ComponentModel.Win32Exception(error, "Cannot establish process-tree lifetime protection"); }
        // Retained until process exit. Closing explicitly would kill this process too.
        // Every ordinary PowerShell child inherits atomically, including before its first instruction.
        serviceJob = handle;
    }
    internal static int LaunchUpdater(string exe, string plan, string root)
    {
        if (exe.Contains('"') || plan.Contains('"')) throw new InvalidDataException("Invalid updater path");
        var start = new Startup { Size = (uint)Marshal.SizeOf<Startup>() }; var command = new StringBuilder("\"" + exe + "\" --update \"" + plan + "\"");
        if (!CreateProcessW(exe, command, IntPtr.Zero, IntPtr.Zero, false, 0x01000000 | 0x08000000, IntPtr.Zero, root, ref start, out var info)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Cannot launch the independent updater");
        CloseHandle(info.Thread); CloseHandle(info.Process); return checked((int)info.Id);
    }
    // The portal uninstall: the staged copy outside the agent root runs
    // --uninstall --detached <jobId>. It breaks away from the broker's job object,
    // so it survives the stop of both services it removes.
    internal static int LaunchUninstaller(string exe, string jobId, string folder)
    {
        string command = PortalUninstall.Command(exe, jobId);
        if (folder.Contains('"') || !Path.IsPathFullyQualified(folder) || !Path.GetFullPath(Path.GetDirectoryName(exe)!).Equals(Path.GetFullPath(folder).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Invalid uninstaller folder");
        var start = new Startup { Size = (uint)Marshal.SizeOf<Startup>() };
        if (!CreateProcessW(exe, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false, 0x01000000 | 0x08000000, IntPtr.Zero, folder, ref start, out var info)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Cannot launch the detached uninstaller");
        CloseHandle(info.Thread); CloseHandle(info.Process); return checked((int)info.Id);
    }
    internal static IDisposable Contain(Process process)
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) { int error = Marshal.GetLastWin32Error(); try { if (!process.HasExited) process.Kill(true); } catch { } throw new System.ComponentModel.Win32Exception(error); }
        var limits = new Limits { Basic = new BasicLimits { Flags = 0x2000 } };
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<Limits>()) || !AssignProcessToJobObject(job, process.Handle))
        {
            int error = Marshal.GetLastWin32Error(); CloseHandle(job);
            try { if (!process.HasExited) process.Kill(true); } catch { }
            throw new System.ComponentModel.Win32Exception(error, "Cannot contain the DSC process tree");
        }
        return new ChildJob(job);
    }
    private sealed class ChildJob(IntPtr handle) : IDisposable
    {
        private IntPtr job = handle;
        public void Dispose() { IntPtr closing = Interlocked.Exchange(ref job, IntPtr.Zero); if (closing != IntPtr.Zero) CloseHandle(closing); }
    }
}
