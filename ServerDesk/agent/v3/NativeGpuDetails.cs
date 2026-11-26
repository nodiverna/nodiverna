using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace ServerDesk.Agent;

[StructLayout(LayoutKind.Sequential)] internal readonly record struct GpuPciAddress(uint Bus, uint Device, uint Function)
{
    internal bool IsValid => Bus <= 255 && Device <= 31 && Function <= 7;
    // D3DKMT supplies BDF, not a PCI domain. Do not invent a domain here.
    internal string BusId => $"{Bus:x2}:{Device:x2}.{Function:x1}";
}
internal sealed record GpuHardware(uint DeviceId, uint SubsystemId, uint Revision, ulong DedicatedBytes, ulong SharedBytes, ulong? DriverVersion = null, uint? DriverModel = null, GpuPciAddress? Address = null);
internal interface INvidiaGpuSensors : IDisposable { JsonObject? Read(GpuAdapter adapter); }

// Extra diagnostics stay separate from the five-field historical GPU contract.
// This provider shares the existing single GPU worker and its deferred shutdown.
internal sealed class NativeGpuDetails : IDisposable
{
    private readonly GpuMemoryCounters memory = new();
    private readonly INvidiaGpuSensors sensors;
    internal NativeGpuDetails(INvidiaGpuSensors? sensors = null) => this.sensors = sensors ?? new NvidiaGpuSensors();
    internal JsonArray Collect(IReadOnlyList<GpuAdapter> adapters, JsonArray gpus, DateTimeOffset at)
    {
        var dedicated = memory.ReadDedicated(); var shared = memory.ReadShared();
        return Build(adapters, gpus, at, dedicated, shared, sensors.Read, GpuDriverUpdate.AmdSoftwareVersion);
    }
    internal const double MaximumInteger = 9007199254740991;
    private static readonly Dictionary<string, (double Min, double Max, bool Integer)> Numbers = new(StringComparer.Ordinal)
    {
        ["vendorId"] = (0,65535,true), ["deviceId"] = (0,65535,true), ["subsystemId"] = (0,uint.MaxValue,true), ["revision"] = (0,uint.MaxValue,true),
        ["dedicatedMemoryBytes"] = (0,MaximumInteger,true), ["sharedMemoryBytes"] = (0,MaximumInteger,true), ["dedicatedMemoryUsedBytes"] = (0,MaximumInteger,true), ["sharedMemoryUsedBytes"] = (0,MaximumInteger,true),
        ["temperatureCelsius"] = (-50,200,false), ["coreClockMhz"] = (0,100000,false), ["memoryClockMhz"] = (0,100000,false),
        ["powerWatts"] = (0,10000,false), ["powerLimitWatts"] = (0,10000,false), ["fanPercent"] = (0,200,false),
        ["pcieGeneration"] = (1,16,true), ["pcieMaxGeneration"] = (1,16,true), ["pcieLinkWidth"] = (1,128,true), ["pcieMaxLinkWidth"] = (1,128,true), ["memoryBusWidthBits"] = (1,65536,true), ["cudaCores"] = (1,10000000,true)
    };
    private static readonly string[] Strings = ["driverVersion","vendorDriverVersion","driverModel","vbiosVersion","pciBusId"];
    internal static void Number(JsonObject row, string key, double? value)
    {
        if (!Numbers.TryGetValue(key, out var bounds)) return;
        row[key] = value is double number && double.IsFinite(number) && number >= bounds.Min && number <= bounds.Max && (!bounds.Integer || number == Math.Truncate(number)) ? JsonValue.Create(number) : null;
    }
    internal static void Text(JsonObject row, string key, string? value)
    {
        if (!Strings.Contains(key, StringComparer.Ordinal)) return;
        int maximum = key == "pciBusId" ? 32 : 128;
        row[key] = !string.IsNullOrWhiteSpace(value) && value.Length <= maximum && !value.Any(char.IsControl) ? value : null;
    }
    internal static string? Version(ulong? value) => value is ulong version && version != 0 ? $"{version >> 48}.{(version >> 32) & 65535}.{(version >> 16) & 65535}.{version & 65535}" : null;
    internal static string? Model(uint? model) => model switch
    {
        1000 => "WDDM 1.0", 1102 => "WDDM 1.1 prerelease", 1105 => "WDDM 1.1",
        1200 => "WDDM 1.2", 1300 => "WDDM 1.3", 2000 => "WDDM 2.0", 2100 => "WDDM 2.1", 2200 => "WDDM 2.2", 2300 => "WDDM 2.3", 2400 => "WDDM 2.4", 2500 => "WDDM 2.5", 2600 => "WDDM 2.6", 2700 => "WDDM 2.7", 2800 => "WDDM 2.8", 2900 => "WDDM 2.9", 3000 => "WDDM 3.0", 3100 => "WDDM 3.1", 3200 => "WDDM 3.2", _ => null
    };
    private static readonly Regex MemoryInstance = new(@"^luid_0x([0-9a-f]{8})_0x([0-9a-f]{8})_phys_(\d{1,2})(?:#\d{1,5})?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));
    internal static bool ParseMemory(string instance, out uint high, out uint low, out uint physical)
    {
        high = low = physical = 0; if (instance.Length > 128) return false;
        var match = MemoryInstance.Match(instance);
        return match.Success && uint.TryParse(match.Groups[1].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out high) && uint.TryParse(match.Groups[2].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out low) && uint.TryParse(match.Groups[3].Value, out physical) && physical < 16;
    }
    private static double? Memory(IReadOnlyList<GpuCounter>? counters, GpuAdapter adapter, uint physical)
    {
        var matching = counters?.Take(32768).Where(counter => ParseMemory(counter.Instance, out uint high, out uint low, out uint node) && high == adapter.High && low == adapter.Low && node == physical).ToArray();
        // The adapter counter is already a total. Never sum duplicate totals.
        return matching is { Length: 1 } && matching[0].Status is 0 or 1 ? matching[0].Value : null;
    }
    internal static JsonArray Build(IReadOnlyList<GpuAdapter> adapters, JsonArray gpus, DateTimeOffset at, IReadOnlyList<GpuCounter>? dedicated, IReadOnlyList<GpuCounter>? shared, Func<GpuAdapter, JsonObject?>? readSensors = null, Func<uint, string?>? readAmdVersion = null)
    {
        var output = new JsonArray(); var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var gpu in gpus.Take(16))
        {
            string? id = gpu?["id"]?.GetValue<string>(); if (string.IsNullOrWhiteSpace(id) || id.Length > 128 || !seen.Add(id)) continue;
            var matches = adapters.Take(64).Where(adapter => id.StartsWith(adapter.Luid + "_phys_", StringComparison.Ordinal)).ToArray(); if (matches.Length != 1) continue;
            var adapter = matches[0]; if (!uint.TryParse(id[(adapter.Luid.Length + 6)..], out uint physical) || physical >= 16) continue;
            foreach (var counter in (dedicated?.Take(32768) ?? []).Concat(shared?.Take(32768) ?? []))
                if (ParseMemory(counter.Instance,out uint high,out uint low,out uint observed) && high == adapter.High && low == adapter.Low)
                    adapter = adapter with { PhysicalCount = Math.Max(adapter.PhysicalCount,observed + 1) };
            var row = new JsonObject { ["id"] = id, ["collectedAt"] = at.ToUniversalTime().ToString("O"), ["sensorProvider"] = "windows" };
            foreach (var key in Numbers.Keys.Concat(Strings)) row[key] = null;
            Number(row,"dedicatedMemoryUsedBytes",Memory(dedicated,adapter,physical)); Number(row,"sharedMemoryUsedBytes",Memory(shared,adapter,physical));
            // A logical linked adapter's descriptor totals/address cannot be
            // attributed reliably to one node. Per-physical PDH memory can.
            bool single = adapter.PhysicalCountConfirmed && adapter.PhysicalCount == 1 && physical == 0 && gpus.Count(g => g?["id"]?.GetValue<string>()?.StartsWith(adapter.Luid + "_phys_", StringComparison.Ordinal) == true) == 1;
            if (single && adapter.Hardware is { } hardware)
            {
                Number(row,"vendorId",adapter.VendorId); Number(row,"deviceId",hardware.DeviceId); Number(row,"subsystemId",hardware.SubsystemId); Number(row,"revision",hardware.Revision);
                Number(row,"dedicatedMemoryBytes",hardware.DedicatedBytes <= MaximumInteger ? hardware.DedicatedBytes : null); Number(row,"sharedMemoryBytes",hardware.SharedBytes <= MaximumInteger ? hardware.SharedBytes : null);
                Text(row,"driverVersion",Version(hardware.DriverVersion)); Text(row,"driverModel",Model(hardware.DriverModel)); Text(row,"pciBusId",hardware.Address?.BusId);
                // AMD: the AMD Software (Adrenalin) version from the display class key of this device (agent 4.13.0).
                if (adapter.VendorId == 0x1002 && readAmdVersion is not null) { string? amd = null; try { amd = readAmdVersion(hardware.DeviceId); } catch (Exception) { } Text(row,"vendorDriverVersion",amd); }
                bool uniqueAddress = hardware.Address is { } address && adapters.Count(a => a.Hardware?.Address == address) == 1;
                if (adapter.VendorId == 0x10de && uniqueAddress && readSensors is not null)
                {
                    JsonObject? values = null; try { values = readSensors(adapter); } catch (Exception) { }
                    if (values is not null)
                    {
                        row["sensorProvider"] = "nvidia-nvml";
                        foreach (var pair in values)
                        {
                            if (Numbers.ContainsKey(pair.Key)) { double? value = null; try { value = pair.Value?.GetValue<double>(); } catch (Exception) { } Number(row,pair.Key,value); }
                            else if (Strings.Contains(pair.Key,StringComparer.Ordinal))
                            {
                                string? value = null; try { value = pair.Value?.GetValue<string>(); } catch (Exception) { }
                                if (pair.Key == "driverModel" && value == "WDDM" && row["driverModel"] is not null) continue;
                                Text(row,pair.Key,value);
                            }
                        }
                    }
                }
            }
            output.Add(row);
        }
        return output;
    }
    public void Dispose() { memory.Dispose(); sensors.Dispose(); }
}

internal sealed class GpuMemoryCounters : IDisposable
{
    private readonly MemoryQuery dedicated = new(@"\GPU Adapter Memory(*)\Dedicated Usage");
    private readonly MemoryQuery shared = new(@"\GPU Adapter Memory(*)\Shared Usage");
    internal IReadOnlyList<GpuCounter>? ReadDedicated() => dedicated.Read();
    internal IReadOnlyList<GpuCounter>? ReadShared() => shared.Read();
    public void Dispose() { dedicated.Dispose(); shared.Dispose(); }
    private sealed class MemoryQuery(string path) : IDisposable
    {
        private QueryHandle? query; private IntPtr counter; private DateTimeOffset retry;
        internal IReadOnlyList<GpuCounter>? Read()
        {
            if (!OperatingSystem.IsWindows() || DateTimeOffset.UtcNow < retry) return null;
            try
            {
                if (query is null)
                {
                    if (Open(null,UIntPtr.Zero,out var handle) != 0) return null; query = new(handle);
                    if (Add(query,path,UIntPtr.Zero,out counter) != 0) throw new InvalidOperationException("GPU memory counter unavailable.");
                }
                if (Collect(query) != 0) throw new InvalidOperationException("GPU memory sample unavailable.");
                for (int attempt = 0; attempt < 3; attempt++)
                {
                    uint bytes = 0, count; if (Array(counter,0x400 | 0x1000,ref bytes,out count,IntPtr.Zero) != 0x800007d2 || bytes == 0 || bytes > WindowsGpuInventorySource.MaximumCounterBytes) return null;
                    IntPtr buffer = Marshal.AllocHGlobal((int)bytes);
                    try { uint capacity = bytes, status = Array(counter,0x400 | 0x1000,ref bytes,out count,buffer); if (status == 0x800007d2) continue; return status == 0 ? WindowsGpuInventorySource.ReadArray(buffer,capacity,count,large:true) : null; }
                    finally { Marshal.FreeHGlobal(buffer); }
                }
                return null;
            }
            catch (Exception) { query?.Dispose(); query = null; counter = IntPtr.Zero; retry = DateTimeOffset.UtcNow.AddMinutes(1); return null; }
        }
        public void Dispose() { query?.Dispose(); query = null; }
    }
    private sealed class QueryHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        internal QueryHandle(IntPtr value) : base(true) => SetHandle(value);
        protected override bool ReleaseHandle() => GpuMemoryCounters.Close(handle) == 0;
    }
    [DllImport("pdh.dll",CharSet=CharSet.Unicode,EntryPoint="PdhOpenQueryW")] private static extern uint Open(string? source,UIntPtr data,out IntPtr query);
    [DllImport("pdh.dll",CharSet=CharSet.Unicode,EntryPoint="PdhAddEnglishCounterW")] private static extern uint Add(QueryHandle query,string path,UIntPtr data,out IntPtr counter);
    [DllImport("pdh.dll",EntryPoint="PdhCollectQueryData")] private static extern uint Collect(QueryHandle query);
    [DllImport("pdh.dll",CharSet=CharSet.Unicode,EntryPoint="PdhGetFormattedCounterArrayW")] private static extern uint Array(IntPtr counter,uint format,ref uint bytes,out uint count,IntPtr buffer);
    [DllImport("pdh.dll",EntryPoint="PdhCloseQuery")] private static extern uint Close(IntPtr query);
}
