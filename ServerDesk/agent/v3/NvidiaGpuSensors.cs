using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ServerDesk.Agent;

internal interface INvmlLibrary : IDisposable { T? Function<T>(string name) where T : Delegate; }
internal readonly record struct NvmlDevice(IntPtr Handle, NvidiaGpuSensors.PciInfo Pci);

// No commands, downloads, or vendor package dependency: optional, read-only
// exports from the driver's trusted DLL. A missing export affects one field.
// A driver update replaces nvml.dll while the worker runs: the DXCore driver
// version of an adapter that differs from the one seen at initialization makes
// Read shut NVML down, free the library and load it again, so
// vendorDriverVersion never stays at the old driver (agent 4.17.2).
internal sealed class NvidiaGpuSensors : INvidiaGpuSensors
{
    private INvmlLibrary? library;
    private readonly Func<INvmlLibrary> load;
    private readonly bool injected;
    private bool initialized, disposed;
    private DateTimeOffset retryAt;
    // The DXCore driver version of each adapter (by PCI address) since the last NVML initialization.
    private readonly Dictionary<string, ulong?> driverVersions = new(StringComparer.Ordinal);
    // An injected library is never freed on a failed or repeated initialization.
    internal NvidiaGpuSensors(INvmlLibrary? library = null) { this.library = library; injected = library is not null; load = () => new NvmlDriverLibrary(); }
    // Tests inject a factory: each load after a failure or a driver change gets a new library, and the old one is freed.
    internal NvidiaGpuSensors(Func<INvmlLibrary> load) { this.load = load; }
    private T? Function<T>(string name) where T : Delegate => library?.Function<T>(name);
    private bool Initialize()
    {
        if (disposed || DateTimeOffset.UtcNow < retryAt) return false;
        if (initialized) return true;
        try
        {
            library ??= load();
            var init = Function<InitializeFunction>("nvmlInit_v2") ?? Function<InitializeFunction>("nvmlInit");
            initialized = init is not null && init() == 0;
        }
        catch (Exception) { initialized = false; }
        if (!initialized) { retryAt = DateTimeOffset.UtcNow.AddMinutes(1); if (!injected) { library?.Dispose(); library = null; } }
        else driverVersions.Clear();
        return initialized;
    }
    private static string? AdapterKey(GpuAdapter adapter) => adapter.VendorId == 0x10de && adapter.Hardware?.Address is { IsValid: true } address ? address.BusId : null;
    // A changed DXCore driver version of an adapter seen since the initialization means a new driver: NVML of the old one is shut down and freed.
    private void ReloadOnDriverChange(GpuAdapter adapter)
    {
        if (!initialized || AdapterKey(adapter) is not { } key || !driverVersions.TryGetValue(key, out var known) || known == adapter.Hardware!.DriverVersion) return;
        try { _ = Function<InitializeFunction>("nvmlShutdown")?.Invoke(); }
        catch (Exception) { }
        initialized = false; driverVersions.Clear();
        if (!injected) { library?.Dispose(); library = null; }
    }
    private void Remember(GpuAdapter adapter) { if (AdapterKey(adapter) is { } key) driverVersions.TryAdd(key, adapter.Hardware!.DriverVersion); }
    private IReadOnlyList<NvmlDevice> Devices()
    {
        var count = Function<CountFunction>("nvmlDeviceGetCount_v2"); var get = Function<IndexFunction>("nvmlDeviceGetHandleByIndex_v2"); var pci = Function<PciFunction>("nvmlDeviceGetPciInfo_v3");
        if (count is null || get is null || pci is null || count(out uint length) != 0 || length > 64) return [];
        var result = new List<NvmlDevice>();
        for (uint i = 0; i < length; i++)
            try
            {
                // A partial list cannot establish that a BDF is unique. A lost
                // or unreadable adapter makes vendor attribution unavailable.
                if (get(i,out var device) != 0 || device == IntPtr.Zero || pci(device,out var address) != 0 || !ValidPci(address)) return [];
                result.Add(new(device,address));
            }
            catch (Exception) { return []; }
        return result;
    }
    internal static bool ValidPci(PciInfo pci)
    {
        if (pci.Bus > 255 || pci.Device > 31 || string.IsNullOrEmpty(pci.BusId) || pci.BusId.Length > 31) return false;
        var match = Regex.Match(pci.BusId,@"^([0-9a-f]{4,8}):([0-9a-f]{2}):([0-9a-f]{2})\.([0-7])$",RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,TimeSpan.FromMilliseconds(50));
        return match.Success && uint.Parse(match.Groups[1].Value,NumberStyles.HexNumber,CultureInfo.InvariantCulture) == pci.Domain && uint.Parse(match.Groups[2].Value,NumberStyles.HexNumber,CultureInfo.InvariantCulture) == pci.Bus && uint.Parse(match.Groups[3].Value,NumberStyles.HexNumber,CultureInfo.InvariantCulture) == pci.Device;
    }
    internal static IntPtr Match(GpuAdapter adapter, IReadOnlyList<NvmlDevice> devices)
    {
        if (adapter.VendorId != 0x10de || !adapter.PhysicalCountConfirmed || adapter.PhysicalCount != 1 || adapter.Hardware is not { Address: { } address } hardware || !address.IsValid) return IntPtr.Zero;
        // D3DKMT has no domain field. A non-zero or ambiguous domain cannot be
        // attributed from that BDF. Also verify exact PCI device/subsystem IDs.
        var candidates = devices.Where(item => ValidPci(item.Pci) && item.Pci.Bus == address.Bus && item.Pci.Device == address.Device && item.Pci.BusId.EndsWith("." + address.Function.ToString(CultureInfo.InvariantCulture),StringComparison.Ordinal)).ToArray();
        if (candidates.Length != 1 || candidates[0].Pci.Domain != 0 || (candidates[0].Pci.PciDeviceId & 65535) != adapter.VendorId || (candidates[0].Pci.PciDeviceId >> 16) != hardware.DeviceId || candidates[0].Pci.PciSubsystemId != hardware.SubsystemId) return IntPtr.Zero;
        return candidates[0].Handle;
    }
    public JsonObject? Read(GpuAdapter adapter)
    {
        if (disposed) return null;
        ReloadOnDriverChange(adapter);
        if (!Initialize()) return null;
        Remember(adapter);
        IReadOnlyList<NvmlDevice> devices; try { devices = Devices(); } catch (Exception) { return null; }
        var device = Match(adapter,devices); if (device == IntPtr.Zero) return null;
        var row = new JsonObject();
        NativeGpuDetails.Text(row,"pciBusId",devices.Single(item => item.Handle == device).Pci.BusId);
        NativeGpuDetails.Text(row,"vendorDriverVersion",String("nvmlSystemGetDriverVersion"));
        NativeGpuDetails.Text(row,"vbiosVersion",String("nvmlDeviceGetVbiosVersion",device));
        NativeGpuDetails.Text(row,"driverModel",DriverModel(device));
        NativeGpuDetails.Number(row,"temperatureCelsius",Kind("nvmlDeviceGetTemperature",device,0));
        NativeGpuDetails.Number(row,"coreClockMhz",Kind("nvmlDeviceGetClockInfo",device,0));
        NativeGpuDetails.Number(row,"memoryClockMhz",Kind("nvmlDeviceGetClockInfo",device,2));
        NativeGpuDetails.Number(row,"powerWatts",UInt("nvmlDeviceGetPowerUsage",device) / 1000d);
        NativeGpuDetails.Number(row,"powerLimitWatts",UInt("nvmlDeviceGetPowerManagementLimit",device) / 1000d);
        foreach (var pair in new Dictionary<string,string> { ["fanPercent"]="nvmlDeviceGetFanSpeed",["pcieGeneration"]="nvmlDeviceGetCurrPcieLinkGeneration",["pcieMaxGeneration"]="nvmlDeviceGetMaxPcieLinkGeneration",["pcieLinkWidth"]="nvmlDeviceGetCurrPcieLinkWidth",["pcieMaxLinkWidth"]="nvmlDeviceGetMaxPcieLinkWidth",["memoryBusWidthBits"]="nvmlDeviceGetMemoryBusWidth",["cudaCores"]="nvmlDeviceGetNumGpuCores" })
            NativeGpuDetails.Number(row,pair.Key,UInt(pair.Value,device));
        return row;
    }
    private uint? UInt(string name,IntPtr device) { try { var get = Function<UIntFunction>(name); return get is not null && get(device,out uint value) == 0 ? value : null; } catch (Exception) { return null; } }
    private uint? Kind(string name,IntPtr device,uint kind) { try { var get = Function<KindFunction>(name); return get is not null && get(device,kind,out uint value) == 0 ? value : null; } catch (Exception) { return null; } }
    private string? String(string name,IntPtr device = default)
    {
        var bytes = new byte[128];
        try
        {
            int status;
            if (device == IntPtr.Zero) { var get = Function<SystemStringFunction>(name); if (get is null) return null; status = get(bytes,(uint)bytes.Length); }
            else { var get = Function<DeviceStringFunction>(name); if (get is null) return null; status = get(device,bytes,(uint)bytes.Length); }
            int length = System.Array.IndexOf(bytes,(byte)0); return status == 0 && length > 0 ? System.Text.Encoding.ASCII.GetString(bytes,0,length) : null;
        }
        catch (Exception) { return null; }
    }
    private string? DriverModel(IntPtr device)
    {
        try { var get = Function<ModelFunction>("nvmlDeviceGetDriverModel_v2") ?? Function<ModelFunction>("nvmlDeviceGetDriverModel"); return get is not null && get(device,out uint current,out _) == 0 ? current switch { 0=>"WDDM",1=>"TCC",2=>"MCDM",_=>null } : null; }
        catch (Exception) { return null; }
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true;
        try { if (initialized) _ = Function<InitializeFunction>("nvmlShutdown")?.Invoke(); }
        catch (Exception) { }
        finally { initialized = false; library?.Dispose(); library = null; }
    }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Ansi)] internal struct PciInfo
    {
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=16)] public string LegacyBusId;
        public uint Domain,Bus,Device,PciDeviceId,PciSubsystemId;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string BusId;
    }
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate int InitializeFunction();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate int CountFunction(out uint count);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate int IndexFunction(uint index,out IntPtr device);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate int PciFunction(IntPtr device,out PciInfo info);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate int UIntFunction(IntPtr device,out uint value);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate int KindFunction(IntPtr device,uint kind,out uint value);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate int SystemStringFunction([Out]byte[] value,uint length);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate int DeviceStringFunction(IntPtr device,[Out]byte[] value,uint length);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate int ModelFunction(IntPtr device,out uint current,out uint pending);
}

internal sealed class NvmlDriverLibrary : INvmlLibrary
{
    private IntPtr module;
    internal NvmlDriverLibrary()
    {
        if (!OperatingSystem.IsWindows()) return;
        foreach (string path in Candidates(Environment.SystemDirectory,Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles)))
            if (File.Exists(path)) { module = LoadLibraryEx(path,IntPtr.Zero,0x100 | 0x800); if (module != IntPtr.Zero) break; }
    }
    internal static IReadOnlyList<string> Candidates(string system,string programs)
    {
        var paths = new List<string>();
        if (Path.IsPathFullyQualified(system)) paths.Add(Path.Combine(system,"nvml.dll"));
        if (Path.IsPathFullyQualified(programs)) paths.Add(Path.Combine(programs,"NVIDIA Corporation","NVSMI","nvml.dll"));
        return paths;
    }
    public T? Function<T>(string name) where T : Delegate => module != IntPtr.Zero && NativeLibrary.TryGetExport(module,name,out var address) ? Marshal.GetDelegateForFunctionPointer<T>(address) : null;
    public void Dispose() { if (module != IntPtr.Zero) { _ = FreeLibrary(module); module = IntPtr.Zero; } }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,EntryPoint="LoadLibraryExW",SetLastError=true)] private static extern IntPtr LoadLibraryEx(string path,IntPtr file,uint flags);
    [DllImport("kernel32.dll")] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool FreeLibrary(IntPtr module);
}
