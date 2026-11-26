using System.ComponentModel;
using System.Diagnostics.Eventing.Reader;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;
using static ServerDesk.Agent.WindowsManagement;

namespace ServerDesk.Agent;

internal static class NativeDriveInventory
{
    internal static JsonObject Collect()
    {
        var rows = new JsonArray(); var warnings = new JsonArray();
        foreach (var drive in DriveInfo.GetDrives().Take(100))
        {
            if (drive.DriveType != DriveType.Fixed) continue;
            try
            {
                if (!drive.IsReady) continue;
                rows.Add(new JsonObject { ["name"] = Limit(drive.Name.TrimEnd('\\')), ["label"] = Limit(drive.VolumeLabel), ["totalGb"] = Math.Round(Math.Max(0, drive.TotalSize) / 1073741824d, 2), ["freeGb"] = Math.Round(Math.Max(0, drive.TotalFreeSpace) / 1073741824d, 2) });
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                if (warnings.Count < 8) warnings.Add("Drive " + Limit(drive.Name) + " is not available at the moment.");
            }
        }
        return new JsonObject { ["disks"] = rows, ["_collectionWarnings"] = warnings };
    }
}

internal sealed class NativeServiceInventory
{
    private readonly NativeServiceStartModeCache startModes = new(1000);
    private int refreshRequested;
    internal void RequestRefresh() => Interlocked.Exchange(ref refreshRequested, 1);
    internal JsonObject Collect()
    {
        if (Interlocked.Exchange(ref refreshRequested, 0) != 0) startModes.Invalidate();
        var now = DateTimeOffset.UtcNow;
        IntPtr manager = OpenSCManager(null, null, 0x0001 | 0x0004);
        if (manager == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        const int bufferBytes = 256 * 1024;
        IntPtr buffer = Marshal.AllocHGlobal(bufferBytes);
        try
        {
            uint resume = 0; var rows = new JsonArray(); int size = Marshal.SizeOf<ServiceEntry>();
            using var serviceKeys = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services");
            for (int page = 0; page < 32 && rows.Count < 1000; page++)
            {
                uint previousResume = resume;
                bool complete = EnumServicesStatusEx(manager, 0, 0x0030, 3, buffer, bufferBytes, out _, out uint count, ref resume, null);
                int error = complete ? 0 : Marshal.GetLastWin32Error();
                if (!complete && error != 234) throw new Win32Exception(error);
                if (count > bufferBytes / size) throw new InvalidDataException("Invalid SCM enumeration length.");
                for (int i = 0; i < count && rows.Count < 1000; i++)
                {
                    var entry = Marshal.PtrToStructure<ServiceEntry>(IntPtr.Add(buffer, i * size));
                    string name = Marshal.PtrToStringUni(entry.Name) ?? "";
                    uint? start = startModes.Read(name, now, () =>
                    {
                        using var key = serviceKeys?.OpenSubKey(name);
                        return key?.GetValue("Start") is int number ? unchecked((uint)number) : null;
                    });
                    rows.Add(new JsonObject { ["name"] = Limit(name), ["displayName"] = Limit(Marshal.PtrToStringUni(entry.DisplayName)), ["status"] = State(entry.Status.CurrentState), ["startMode"] = StartMode(start) });
                }
                if (complete) break;
                if (count == 0 || resume == previousResume) throw new InvalidDataException("SCM enumeration made no progress.");
            }
            return new JsonObject { ["services"] = rows };
        }
        finally { Marshal.FreeHGlobal(buffer); CloseServiceHandle(manager); }
    }

    internal static string State(uint value) => value switch { 1 => "Stopped", 2 => "Start Pending", 3 => "Stop Pending", 4 => "Running", 5 => "Continue Pending", 6 => "Pause Pending", 7 => "Paused", _ => "Unknown" };
    internal static string StartMode(uint? value) => value switch { 0 => "Boot", 1 => "System", 2 => "Auto", 3 => "Manual", 4 => "Disabled", _ => "Unknown" };
    internal static int EntrySize => Marshal.SizeOf<ServiceEntry>();
    [StructLayout(LayoutKind.Sequential)] private struct ServiceStatus { public uint ServiceType, CurrentState, ControlsAccepted, Win32ExitCode, ServiceSpecificExitCode, CheckPoint, WaitHint, ProcessId, ServiceFlags; }
    [StructLayout(LayoutKind.Sequential)] private struct ServiceEntry { public IntPtr Name, DisplayName; public ServiceStatus Status; }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "OpenSCManagerW")] private static extern IntPtr OpenSCManager(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "EnumServicesStatusExW")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool EnumServicesStatusEx(IntPtr manager, int infoLevel, uint serviceType, uint serviceState, IntPtr buffer, int bufferSize, out uint needed, out uint count, ref uint resume, string? group);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseServiceHandle(IntPtr handle);
}

internal sealed class NativeServiceStartModeCache(int capacity)
{
    private readonly Dictionary<string, (uint? Mode, DateTimeOffset Until)> values = new(StringComparer.OrdinalIgnoreCase);
    private readonly Queue<string> order = new();
    internal int Count => values.Count;
    internal void Invalidate() { values.Clear(); order.Clear(); }
    internal uint? Read(string name, DateTimeOffset now, Func<uint?> read)
    {
        if (values.TryGetValue(name, out var cached) && now < cached.Until) return cached.Mode;
        uint? mode = read();
        if (capacity <= 0) return mode;
        if (!values.ContainsKey(name))
        {
            while (values.Count >= capacity) values.Remove(order.Dequeue());
            order.Enqueue(name);
        }
        values[name] = (mode, now.AddSeconds(mode is null ? 30 : NativeTelemetryCollector.ConfigurationSeconds));
        return mode;
    }
}

// Cached event rendering avoids repeatedly loading provider message DLLs for
// the same 60 records. The timestamp/provider/id distinguish a reused record
// number after a channel is cleared; the bounded cache holds copied JSON only.
internal sealed class NativeEventInventory
{
    private readonly BoundedEventDescriptionCache descriptions = new(128);
    internal JsonObject Collect()
    {
        var records = new List<JsonObject>();
        foreach (string channel in new[] { "System", "Application" })
        {
            var query = new EventLogQuery(channel, PathType.LogName, "*[System[(Level=1 or Level=2 or Level=3)]]") { ReverseDirection = true };
            using var reader = new EventLogReader(query);
            for (int index = 0; index < 30; index++)
            {
                using var record = reader.ReadEvent(TimeSpan.FromMilliseconds(200));
                if (record is null) break;
                string key = channel + "|" + record.RecordId + "|" + record.TimeCreated?.ToUniversalTime().Ticks + "|" + record.ProviderName + "|" + record.Id;
                string message = descriptions.GetOrAdd(key, () =>
                {
                    try { return Limit(record.FormatDescription(), 3500); } catch { return "Description not available on this system."; }
                });
                records.Add(new JsonObject { ["id"] = record.Id, ["level"] = record.Level switch { 1 => "Critical", 2 => "Error", 3 => "Warning", _ => "Information" }, ["source"] = Limit(record.ProviderName), ["message"] = message, ["at"] = record.TimeCreated?.ToUniversalTime().ToString("O") ?? "" });
            }
        }
        return new JsonObject { ["events"] = new JsonArray(records.OrderByDescending(x => x["at"]!.GetValue<string>(), StringComparer.Ordinal).Take(30).Cast<JsonNode>().ToArray()) };
    }
}

internal sealed class BoundedEventDescriptionCache(int capacity)
{
    private readonly Dictionary<string, string> descriptions = new(StringComparer.Ordinal);
    private readonly Queue<string> order = new();
    internal int Count => descriptions.Count;
    internal string GetOrAdd(string key, Func<string> render)
    {
        if (descriptions.TryGetValue(key, out var cached)) return cached;
        string description = render();
        if (capacity <= 0) return description;
        while (descriptions.Count >= capacity) descriptions.Remove(order.Dequeue());
        descriptions.Add(key, description); order.Enqueue(key);
        return description;
    }
}

// One persistent local PDH query replaces four repeated WMI perf-provider
// enumerations. English counter registration works on localized Windows.
// Unavailable counters remain null; rate counters need two real samples.
internal sealed class NativePerformanceInventory : IDisposable
{
    // Default presentation scales can turn bytes into MB or seconds into ms;
    // the wire contract requires the unscaled counter's real base units.
    private const uint CounterFormat = 0x00000200 | 0x00001000 | 0x00008000; // DOUBLE | NOSCALE | NOCAP100
    private static readonly (string Field, string Path, double Scale)[] CounterPaths =
    [
        ("diskReadBytesSec", @"\PhysicalDisk(_Total)\Disk Read Bytes/sec", 1),
        ("diskWriteBytesSec", @"\PhysicalDisk(_Total)\Disk Write Bytes/sec", 1),
        ("diskLatencyMs", @"\PhysicalDisk(_Total)\Avg. Disk sec/Transfer", 1000),
        ("processorQueue", @"\System\Processor Queue Length", 1),
        ("pagefilePercent", @"\Paging File(_Total)\% Usage", 1)
    ];
    private readonly object gate = new();
    private readonly Dictionary<string, IntPtr> counters = new(StringComparer.Ordinal);
    private SafePdhQuery? query;
    private DateTimeOffset retryAt;
    private bool disposed;
    private long previousNetworkBytes;
    private DateTimeOffset previousNetworkAt;

    internal JsonObject Collect()
    {
        lock (gate)
        {
            var result = Empty(); var now = DateTimeOffset.UtcNow;
            if (disposed) return new JsonObject { ["performance"] = result };
            if (OperatingSystem.IsWindows())
            {
                try
                {
                    EnsureCounters(now);
                    if (query is not null && PdhCollectQueryData(query) == 0)
                        foreach (var counter in CounterPaths)
                            if (counters.TryGetValue(counter.Field, out var handle) && PdhGetFormattedCounterValue(handle, CounterFormat, out _, out var value) == 0)
                                result[counter.Field] = ValidMetric(value.Status, value.DoubleValue, counter.Scale, counter.Field == "pagefilePercent");
                }
                catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException or Win32Exception)
                {
                    query?.Dispose(); query = null; counters.Clear(); retryAt = now.AddMinutes(5);
                }
            }
            try
            {
                long bytes = NetworkInterface.GetAllNetworkInterfaces().Where(n => n.NetworkInterfaceType != NetworkInterfaceType.Loopback).Sum(n => { var stats = n.GetIPStatistics(); return checked(stats.BytesReceived + stats.BytesSent); });
                result["networkBytesSec"] = Rate(previousNetworkBytes, previousNetworkAt, bytes, now);
                previousNetworkBytes = bytes; previousNetworkAt = now;
            }
            catch { previousNetworkAt = default; }
            return new JsonObject { ["performance"] = result };
        }
    }

    private void EnsureCounters(DateTimeOffset now)
    {
        if (now < retryAt || counters.Count == CounterPaths.Length) return;
        retryAt = now.AddMinutes(5);
        if (query is null)
        {
            uint status = PdhOpenQuery(null, UIntPtr.Zero, out var handle);
            if (status != 0) throw new Win32Exception(unchecked((int)status));
            query = new(handle);
        }
        foreach (var counter in CounterPaths)
            if (!counters.ContainsKey(counter.Field) && PdhAddEnglishCounter(query, counter.Path, UIntPtr.Zero, out var handle) == 0) counters.Add(counter.Field, handle);
    }

    internal static JsonObject Empty() => new() { ["diskReadBytesSec"] = null, ["diskWriteBytesSec"] = null, ["networkBytesSec"] = null, ["diskLatencyMs"] = null, ["processorQueue"] = null, ["pagefilePercent"] = null };
    internal static double? ValidMetric(uint status, double value, double scale = 1, bool percentage = false)
    {
        double scaled = value * scale;
        if (status is not (0 or 1) || !double.IsFinite(scaled) || scaled < 0) return null;
        return Math.Round(percentage ? Math.Clamp(scaled, 0, 100) : scaled, 2);
    }
    internal static double? Rate(long previous, DateTimeOffset previousAt, long current, DateTimeOffset at)
    {
        double elapsed = (at - previousAt).TotalSeconds;
        return previousAt != default && elapsed > 0 && elapsed <= 120 && current >= previous ? Math.Round((current - (double)previous) / elapsed, 2) : null;
    }
    internal static int FormattedValueSize => Marshal.SizeOf<FormattedValue>();
    public void Dispose() { lock (gate) { disposed = true; query?.Dispose(); query = null; counters.Clear(); } }
    private sealed class SafePdhQuery : SafeHandleZeroOrMinusOneIsInvalid
    {
        internal SafePdhQuery(IntPtr value) : base(true) => SetHandle(value);
        protected override bool ReleaseHandle() => PdhCloseQuery(handle) == 0;
    }
    [StructLayout(LayoutKind.Explicit, Size = 16)] private struct FormattedValue { [FieldOffset(0)] public uint Status; [FieldOffset(8)] public double DoubleValue; }
    [DllImport("pdh.dll", CharSet = CharSet.Unicode, EntryPoint = "PdhOpenQueryW")] private static extern uint PdhOpenQuery(string? dataSource, UIntPtr userData, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode, EntryPoint = "PdhAddEnglishCounterW")] private static extern uint PdhAddEnglishCounter(SafePdhQuery query, string path, UIntPtr userData, out IntPtr counter);
    [DllImport("pdh.dll")] private static extern uint PdhCollectQueryData(SafePdhQuery query);
    [DllImport("pdh.dll")] private static extern uint PdhGetFormattedCounterValue(IntPtr counter, uint format, out uint type, out FormattedValue value);
    [DllImport("pdh.dll")] private static extern uint PdhCloseQuery(IntPtr query);
}
