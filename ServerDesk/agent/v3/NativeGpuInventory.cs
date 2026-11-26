using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace ServerDesk.Agent;

internal readonly record struct GpuAdapter(uint High, uint Low, string Name, uint VendorId, uint Flags = 0, uint PhysicalCount = 1, GpuHardware? Hardware = null, bool PhysicalCountConfirmed = false)
{
    internal string Luid => $"luid_0x{High:x8}_0x{Low:x8}";
}
internal readonly record struct GpuCounter(string Instance, uint Status, double Value);
internal readonly record struct GpuEngine(uint High, uint Low, uint Physical, uint Engine, uint Process);
internal interface IGpuInventorySource : IDisposable
{
    IReadOnlyList<GpuAdapter> Adapters();
    IReadOnlyList<GpuCounter>? Sample(DateTimeOffset at);
    JsonArray? Details(IReadOnlyList<GpuAdapter> adapters, JsonArray gpus, DateTimeOffset at) => null;
}

// Runs exclusively in its TelemetryCollectorSlot worker, never on the heartbeat
// thread. One persistent PDH query supplies real two-sample rates. DXGI metadata
// and complete LUIDs prevent a virtual adapter or array order from stealing a
// physical GPU's readings. Linked physical nodes keep separate phys identities.
internal sealed class NativeGpuInventory : IDisposable
{
    private readonly IGpuInventorySource source;
    private readonly Func<DateTimeOffset> clock;
    private int cleanupQueued, disposed;
    internal NativeGpuInventory(IGpuInventorySource? source = null, Func<DateTimeOffset>? clock = null) { this.source = source ?? new WindowsGpuInventorySource(); this.clock = clock ?? (() => DateTimeOffset.UtcNow); }
    internal JsonObject Collect()
    {
        IReadOnlyList<GpuAdapter> adapters;
        try { adapters = source.Adapters(); }
        catch (Exception) { return new JsonObject(); } // Optional provider unavailable, not a fabricated absence.
        if (adapters.Count == 0) return new JsonObject { ["gpus"] = new JsonArray(), ["gpuDetails"] = new JsonArray() };
        var sampleAt = clock();
        IReadOnlyList<GpuCounter>? counters;
        try { counters = source.Sample(sampleAt); } catch (Exception) { counters = null; }
        var gpus = Build(adapters, counters, sampleAt);
        var snapshot = new JsonObject { ["gpus"] = gpus };
        try { var details = source.Details(EffectiveNodes(adapters,counters), gpus, sampleAt); if (details is not null) snapshot["gpuDetails"] = details; } catch (Exception) { }
        return snapshot;
    }
    private static readonly Regex InstancePattern = new(@"^pid_(\d{1,10})_luid_0x([0-9a-f]{8})_0x([0-9a-f]{8})_phys_(\d{1,2})_eng_(\d{1,5})_engtype_[a-z0-9_ -]{1,80}(?:#\d{1,5})?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));
    private static readonly Regex ArcPattern = new(@"\bArc\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));
    internal static string? Vendor(GpuAdapter adapter)
    {
        if ((adapter.Flags & 3) != 0 || string.IsNullOrWhiteSpace(adapter.Name) || adapter.High == 0 && adapter.Low == 0) return null;
        return adapter.VendorId switch { 0x10de => "nvidia", 0x1002 => "amd", 0x8086 when ArcPattern.IsMatch(adapter.Name) => "intel", _ => null };
    }
    internal static bool ParseInstance(string instance, out GpuEngine engine)
    {
        engine = default; if (instance.Length > 256) return false;
        var match = InstancePattern.Match(instance); if (!match.Success) return false;
        if (!uint.TryParse(match.Groups[1].Value, out uint pid) || !uint.TryParse(match.Groups[2].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out uint high) || !uint.TryParse(match.Groups[3].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out uint low) || !uint.TryParse(match.Groups[4].Value, out uint physical) || physical >= 16 || !uint.TryParse(match.Groups[5].Value, out uint index)) return false;
        engine = new(high, low, physical, index, pid); return true;
    }
    internal static JsonArray Build(IReadOnlyList<GpuAdapter> adapters, IReadOnlyList<GpuCounter>? counters, DateTimeOffset at)
    {
        // A duplicate PDH instance must not double-count one process/engine.
        // Independent processes on one engine add; independent engines do not.
        var rates = new Dictionary<GpuEngine, double>();
        foreach (var counter in counters?.Take(32768) ?? [])
            if (counter.Status is 0 or 1 && double.IsFinite(counter.Value) && counter.Value >= 0 && ParseInstance(counter.Instance, out var engine))
                rates[engine] = Math.Max(rates.GetValueOrDefault(engine), counter.Value);
        var output = new JsonArray(); var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var adapter in adapters.Take(64))
        {
            string? vendor = Vendor(adapter); if (vendor is null) continue;
            uint count = Math.Clamp(adapter.PhysicalCount, 1, 16);
            // Older DXCore implementations lack PhysicalAdapterCount. A valid
            // matching PDH instance can still establish an additional node.
            var observed = rates.Keys.Where(e => e.High == adapter.High && e.Low == adapter.Low).Select(e => e.Physical).DefaultIfEmpty(0u).Max();
            count = Math.Max(count, observed + 1);
            for (uint physical = 0; physical < count && output.Count < 16; physical++)
            {
                string id = adapter.Luid + "_phys_" + physical.ToString(CultureInfo.InvariantCulture); if (!ids.Add(id)) continue;
                var engines = rates.Where(pair => pair.Key.High == adapter.High && pair.Key.Low == adapter.Low && pair.Key.Physical == physical).GroupBy(pair => pair.Key.Engine).Select(group => group.Sum(pair => Math.Min(pair.Value, 100))).ToArray();
                double? utilization = engines.Length == 0 ? null : Math.Round(Math.Clamp(engines.Max(), 0, 100), 2);
                string name = adapter.Name.Trim(); if (name.Length > 256) name = name[..256];
                output.Add(new JsonObject { ["id"] = id, ["name"] = name, ["vendor"] = vendor, ["utilization"] = utilization, ["collectedAt"] = at.ToUniversalTime().ToString("O") });
            }
        }
        return output;
    }
    internal static IReadOnlyList<GpuAdapter> EffectiveNodes(IReadOnlyList<GpuAdapter> adapters, IReadOnlyList<GpuCounter>? counters)
    {
        var nodes = new Dictionary<(uint,uint),uint>();
        foreach (var counter in counters?.Take(32768) ?? [])
            // An existing physical instance is evidence even while its rate
            // warms up or is unavailable. Rate validity is checked separately.
            if (ParseInstance(counter.Instance,out var engine))
                nodes[(engine.High,engine.Low)] = Math.Max(nodes.GetValueOrDefault((engine.High,engine.Low)),engine.Physical + 1);
        return adapters.Select(adapter => adapter with { PhysicalCount = Math.Max(Math.Clamp(adapter.PhysicalCount,1,16),nodes.GetValueOrDefault((adapter.High,adapter.Low))) }).ToArray();
    }
    public void Dispose() { if (Volatile.Read(ref cleanupQueued) == 0) DisposeCore(); }
    private void DisposeCore() { if (Interlocked.Exchange(ref disposed,1) == 0) source.Dispose(); }
    internal void DisposeWhenComplete(Task? pending)
    {
        if (Interlocked.Exchange(ref cleanupQueued,1) != 0) return;
        // NVML shutdown is itself a native driver call. Even a completed-worker
        // race must never run it synchronously on the service stop thread.
        _ = (pending ?? Task.CompletedTask).ContinueWith(_ => Task.Factory.StartNew(DisposeCore,CancellationToken.None,TaskCreationOptions.LongRunning,TaskScheduler.Default),CancellationToken.None,TaskContinuationOptions.None,TaskScheduler.Default).Unwrap();
    }
}

internal sealed class WindowsGpuInventorySource : IGpuInventorySource
{
    private const uint Format = 0x200 | 0x1000 | 0x8000; // DOUBLE | NOSCALE | NOCAP100
    private const uint MoreData = 0x800007d2;
    private SafeGpuPdhQuery? query;
    private IntPtr counter;
    private DateTimeOffset previous, retryAt;
    private bool disposed;
    private readonly NativeGpuDetails details = new();
    internal const int MaximumCounterBytes = 8 * 1024 * 1024;
    internal const int MaximumCounters = 32768;
    internal const uint AdapterTypeQuery = 15; // Windows SDK KMTQAITYPE_ADAPTERTYPE (14 is reserved).

    public IReadOnlyList<GpuAdapter> Adapters()
    {
        if (!OperatingSystem.IsWindows() || disposed) return [];
        var factoryId = new Guid("770aae78-f26f-4dba-a829-253c83d1b387"); IntPtr factory = IntPtr.Zero, core = IntPtr.Zero;
        try
        {
            Marshal.ThrowExceptionForHR(CreateDXGIFactory1(ref factoryId, out factory));
            try { var coreId = new Guid("78ee5945-c36e-4b13-a669-005dd11c0f06"); if (DXCoreCreateAdapterFactory(ref coreId, out core) < 0) { Release(core); core = IntPtr.Zero; } } catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException) { }
            var list = new List<GpuAdapter>(); var enumerate = Method<EnumAdapter>(factory, 12);
            for (uint index = 0; index < 64; index++)
            {
                IntPtr adapter = IntPtr.Zero;
                try
                {
                    int hr = enumerate(factory, index, out adapter); if (unchecked((uint)hr) == 0x887a0002) break; Marshal.ThrowExceptionForHR(hr);
                    Marshal.ThrowExceptionForHR(Method<GetDescription>(adapter, 10)(adapter, out var description));
                    var item = new GpuAdapter(description.Luid.High, description.Luid.Low, description.Description ?? "", description.Vendor, description.Flags);
                    if (NativeGpuInventory.Vendor(item) is not null && PhysicalHardware(description.Luid))
                    {
                        var count = PhysicalCount(core, description.Luid);
                        // DXGI memory totals and PCI sensors represent the logical
                        // adapter; never repeat them as per-node linked GPU facts.
                        var hardware = new GpuHardware(description.Device, description.SubSystem, description.Revision, description.DedicatedVideo.ToUInt64(), description.SharedSystem.ToUInt64(), CoreVersion(core, description.Luid), CoreModel(core, description.Luid), PciAddress(description.Luid));
                        list.Add(item with { PhysicalCount = count ?? 1, PhysicalCountConfirmed = count.HasValue, Hardware = hardware });
                    }
                }
                finally { Release(adapter); }
            }
            return list;
        }
        finally { Release(core); Release(factory); }
    }
    private static uint? PhysicalCount(IntPtr factory, AdapterLuid luid)
    {
        if (factory == IntPtr.Zero) return null; IntPtr adapter = IntPtr.Zero;
        try
        {
            var adapterId = new Guid("f0db4c7f-fe5a-42a2-bd62-f2a6cf6fc83e");
            if (Method<CoreAdapterByLuid>(factory, 4)(factory, ref luid, ref adapterId, out adapter) < 0 || adapter == IntPtr.Zero || !Method<CorePropertySupported>(adapter, 5)(adapter, 15)) return null;
            return Method<CoreGetCount>(adapter, 6)(adapter, 15, (UIntPtr)4, out uint count) >= 0 ? ConfirmedCount(count) : null;
        }
        catch (Exception) { return null; } finally { Release(adapter); }
    }
    internal static uint? ConfirmedCount(uint count) => count is >= 1 and <= 16 ? count : null;
    private static ulong? CoreVersion(IntPtr factory, AdapterLuid luid)
    {
        if (factory == IntPtr.Zero) return null; IntPtr adapter = IntPtr.Zero;
        try { var id = new Guid("f0db4c7f-fe5a-42a2-bd62-f2a6cf6fc83e"); return Method<CoreAdapterByLuid>(factory, 4)(factory, ref luid, ref id, out adapter) >= 0 && adapter != IntPtr.Zero && Method<CorePropertySupported>(adapter, 5)(adapter, 1) && Method<CoreGetVersion>(adapter, 6)(adapter, 1, (UIntPtr)8, out ulong version) >= 0 ? version : null; }
        catch (Exception) { return null; } finally { Release(adapter); }
    }
    private static uint? CoreModel(IntPtr factory, AdapterLuid luid)
    {
        if (factory == IntPtr.Zero) return null; IntPtr adapter = IntPtr.Zero;
        try { var id = new Guid("f0db4c7f-fe5a-42a2-bd62-f2a6cf6fc83e"); return Method<CoreAdapterByLuid>(factory, 4)(factory, ref luid, ref id, out adapter) >= 0 && adapter != IntPtr.Zero && Method<CorePropertySupported>(adapter, 5)(adapter, 4) && Method<CoreGetCount>(adapter, 6)(adapter, 4, (UIntPtr)4, out uint model) >= 0 ? model : null; }
        catch (Exception) { return null; } finally { Release(adapter); }
    }
    internal const uint AdapterAddressQuery = 6;
    private static GpuPciAddress? PciAddress(AdapterLuid luid)
    {
        var opened = new KernelOpenAdapter { Luid = luid }; if (D3DKMTOpenAdapterFromLuid(ref opened) < 0) return null;
        IntPtr data = Marshal.AllocHGlobal(12);
        try { Marshal.Copy(new byte[12], 0, data, 12); var query = new KernelQueryAdapter { Adapter = opened.Adapter, Type = AdapterAddressQuery, Data = data, Bytes = 12 }; if (D3DKMTQueryAdapterInfo(ref query) < 0) return null; var address = Marshal.PtrToStructure<GpuPciAddress>(data); return address.IsValid ? address : null; }
        catch (Exception) { return null; } finally { Marshal.FreeHGlobal(data); var close = new KernelCloseAdapter { Adapter = opened.Adapter }; _ = D3DKMTCloseAdapter(ref close); }
    }
    // An indirect display can inherit its rendering GPU's DXGI description and
    // vendor while remaining a separate virtual LUID (for example Parsec).
    // Confirm the kernel adapter type instead of trusting its display name.
    internal static bool IsPhysicalType(uint flags) => (flags & 1) != 0 && (flags & (4 | 64 | 128 | 16384)) == 0; // render, not software/indirect/paravirtual/test
    private static bool PhysicalHardware(AdapterLuid luid)
    {
        var opened = new KernelOpenAdapter { Luid = luid };
        if (D3DKMTOpenAdapterFromLuid(ref opened) < 0) return false;
        IntPtr data = Marshal.AllocHGlobal(4);
        try
        {
            Marshal.WriteInt32(data, 0); var query = new KernelQueryAdapter { Adapter = opened.Adapter, Type = AdapterTypeQuery, Data = data, Bytes = 4 };
            return D3DKMTQueryAdapterInfo(ref query) >= 0 && IsPhysicalType(unchecked((uint)Marshal.ReadInt32(data)));
        }
        finally { Marshal.FreeHGlobal(data); var close = new KernelCloseAdapter { Adapter = opened.Adapter }; _ = D3DKMTCloseAdapter(ref close); }
    }
    public IReadOnlyList<GpuCounter>? Sample(DateTimeOffset at)
    {
        if (!OperatingSystem.IsWindows() || disposed || at < retryAt) return null;
        try
        {
            if (previous != default && (at <= previous || at - previous > TimeSpan.FromSeconds(120))) Reset();
            if (query is null)
            {
                uint status = PdhOpenQuery(null, UIntPtr.Zero, out var handle); if (status != 0) throw new Win32Exception(unchecked((int)status));
                query = new(handle); status = PdhAddEnglishCounter(query, @"\GPU Engine(*)\Utilization Percentage", UIntPtr.Zero, out counter); if (status != 0) throw new Win32Exception(unchecked((int)status));
            }
            uint collected = PdhCollectQueryData(query); if (collected != 0) throw new Win32Exception(unchecked((int)collected));
            bool warmed = previous != default; previous = at; if (!warmed) return null;
            // Re-query from zero on every retry: hotplug can grow the wildcard
            // array between sizing and copying. Bound both allocation and work.
            for (int attempt = 0; attempt < 3; attempt++)
            {
                uint bytes = 0; uint status = PdhGetFormattedCounterArray(counter, Format, ref bytes, out uint count, IntPtr.Zero);
                if (status != MoreData || bytes == 0) return null;
                if (bytes > MaximumCounterBytes) return null;
                IntPtr buffer = Marshal.AllocHGlobal(checked((int)bytes));
                try
                {
                    uint capacity = bytes; status = PdhGetFormattedCounterArray(counter, Format, ref bytes, out count, buffer);
                    if (status == MoreData) continue;
                    if (status != 0) return null;
                    return ReadArray(buffer, capacity, count);
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            return null;
        }
        catch (Exception) { Reset(); retryAt = at.AddMinutes(1); return null; }
    }
    internal static IReadOnlyList<GpuCounter> ReadArray(IntPtr buffer, uint bytes, uint count, bool large = false)
    {
        int stride = Marshal.SizeOf<CounterItem>(); long start = buffer.ToInt64(), end = checked(start + bytes);
        if (buffer == IntPtr.Zero || bytes > MaximumCounterBytes || count > MaximumCounters || count * (long)stride > bytes) throw new InvalidDataException("GPU counter array exceeds its allocation.");
        var values = new List<GpuCounter>((int)count);
        for (int index = 0; index < count; index++)
        {
            var item = Marshal.PtrToStructure<CounterItem>(IntPtr.Add(buffer, index * stride)); long name = item.Name.ToInt64();
            if (name < start + count * stride || name > end - 2 || (name - start) % 2 != 0) throw new InvalidDataException("GPU counter name lies outside its allocation.");
            int length = 0, maximum = (int)Math.Min(256, (end - name) / 2); while (length < maximum && Marshal.ReadInt16(item.Name, length * 2) != 0) length++;
            if (length == maximum) continue;
            values.Add(new(Marshal.PtrToStringUni(item.Name, length) ?? "", item.Value.Status, large ? item.Value.Int64Value : item.Value.DoubleValue));
        }
        return values;
    }
    private void Reset() { query?.Dispose(); query = null; counter = IntPtr.Zero; previous = default; }
    public JsonArray? Details(IReadOnlyList<GpuAdapter> adapters, JsonArray gpus, DateTimeOffset at) => details.Collect(adapters, gpus, at);
    public void Dispose() { disposed = true; Reset(); details.Dispose(); }
    private static T Method<T>(IntPtr value, int slot) where T : Delegate => Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(value), slot * IntPtr.Size));
    private static void Release(IntPtr value) { if (value != IntPtr.Zero) Marshal.Release(value); }
    private sealed class SafeGpuPdhQuery : SafeHandleZeroOrMinusOneIsInvalid
    {
        internal SafeGpuPdhQuery(IntPtr value) : base(true) => SetHandle(value);
        protected override bool ReleaseHandle() => PdhCloseQuery(handle) == 0;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct AdapterLuid { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct AdapterDescription
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint Vendor, Device, SubSystem, Revision; public UIntPtr DedicatedVideo, DedicatedSystem, SharedSystem; public AdapterLuid Luid; public uint Flags;
    }
    [StructLayout(LayoutKind.Explicit, Size = 16)] internal struct CounterValue { [FieldOffset(0)] public uint Status; [FieldOffset(8)] public double DoubleValue; [FieldOffset(8)] public long Int64Value; }
    [StructLayout(LayoutKind.Sequential)] internal struct CounterItem { public IntPtr Name; public CounterValue Value; }
    [StructLayout(LayoutKind.Sequential)] internal struct KernelOpenAdapter { public AdapterLuid Luid; public uint Adapter; }
    [StructLayout(LayoutKind.Sequential)] internal struct KernelQueryAdapter { public uint Adapter, Type; public IntPtr Data; public uint Bytes; }
    [StructLayout(LayoutKind.Sequential)] internal struct KernelCloseAdapter { public uint Adapter; }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int EnumAdapter(IntPtr self, uint index, out IntPtr adapter);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int GetDescription(IntPtr self, out AdapterDescription description);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CoreAdapterByLuid(IntPtr self, ref AdapterLuid luid, ref Guid id, out IntPtr adapter);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool CorePropertySupported(IntPtr self, uint property);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CoreGetCount(IntPtr self, uint property, UIntPtr size, out uint count);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CoreGetVersion(IntPtr self, uint property, UIntPtr size, out ulong version);
    [DllImport("dxgi.dll")] private static extern int CreateDXGIFactory1(ref Guid id, out IntPtr factory);
    [DllImport("dxcore.dll")] private static extern int DXCoreCreateAdapterFactory(ref Guid id, out IntPtr factory);
    [DllImport("gdi32.dll")] private static extern int D3DKMTOpenAdapterFromLuid(ref KernelOpenAdapter adapter);
    [DllImport("gdi32.dll")] private static extern int D3DKMTQueryAdapterInfo(ref KernelQueryAdapter query);
    [DllImport("gdi32.dll")] private static extern int D3DKMTCloseAdapter(ref KernelCloseAdapter adapter);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode, EntryPoint = "PdhOpenQueryW")] private static extern uint PdhOpenQuery(string? source, UIntPtr data, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode, EntryPoint = "PdhAddEnglishCounterW")] private static extern uint PdhAddEnglishCounter(SafeGpuPdhQuery query, string path, UIntPtr data, out IntPtr counter);
    [DllImport("pdh.dll")] private static extern uint PdhCollectQueryData(SafeGpuPdhQuery query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode, EntryPoint = "PdhGetFormattedCounterArrayW")] private static extern uint PdhGetFormattedCounterArray(IntPtr counter, uint format, ref uint bytes, out uint count, IntPtr buffer);
    [DllImport("pdh.dll")] private static extern uint PdhCloseQuery(IntPtr query);
}
