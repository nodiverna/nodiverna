using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class NativeGpuDetailsTests
{
    private static void Check(bool value,string message) { if (!value) throw new InvalidOperationException("GPU details regression: " + message); }
    private static double? Number(JsonNode? row,string field) => row?[field]?.GetValue<double>();
    internal static int RunSelfTest() { try { RunSelfTests(); return 0; } catch (Exception error) { Console.Error.WriteLine(error); return 1; } }
    internal static void RunSelfTests()
    {
        Abi();
        var at = DateTimeOffset.Parse("2026-10-12T00:00:00Z");
        var hardware = new GpuHardware(0x2204,0x147d10de,0xa1,24UL * 1024 * 1024 * 1024,16UL * 1024 * 1024 * 1024,0x00200000000f17d0,3200,new(1,0,0));
        var adapter = new GpuAdapter(0,0x150ce,"NVIDIA RTX 3090",0x10de,Hardware:hardware,PhysicalCountConfirmed:true);
        var gpus = NativeGpuInventory.Build([adapter],null,at);
        var dedicated = new GpuCounter[] { new("luid_0x00000000_0x0001636B_phys_0",0,999999),new("luid_0x00000000_0x000150CE_phys_0",0,0) };
        var shared = new GpuCounter[] { new("luid_0x00000000_0x000150ce_phys_0",1,4194304) };
        var rows = NativeGpuDetails.Build([adapter],gpus,at,dedicated,shared);
        Check(rows.Count == 1 && rows[0]!["id"]!.GetValue<string>() == gpus[0]!["id"]!.GetValue<string>() && rows[0]!["collectedAt"]!.GetValue<string>() == at.ToString("O"),"details preserve the exact historical GPU identity and pre-sensor collection timestamp.");
        Check(Number(rows[0],"vendorId") == 0x10de && Number(rows[0],"deviceId") == 0x2204 && Number(rows[0],"dedicatedMemoryBytes") == 24UL*1024*1024*1024 && Number(rows[0],"sharedMemoryBytes") == 16UL*1024*1024*1024,"DXGI identifiers and byte counts retain native units.");
        Check(Number(rows[0],"dedicatedMemoryUsedBytes") == 0 && Number(rows[0],"sharedMemoryUsedBytes") == 4194304,"PDH adapter memory maps full LUID/phys and retains an actual idle zero.");
        Check(rows[0]!["driverVersion"]!.GetValue<string>() == "32.0.15.6096" && rows[0]!["driverModel"]!.GetValue<string>() == "WDDM 3.2" && rows[0]!["pciBusId"]!.GetValue<string>() == "01:00.0","driver WORD ordering, known WDDM SDK values and domain-free trusted BDF are decoded exactly.");
        Check(rows[0]!["temperatureCelsius"] is null && rows[0]!["sensorProvider"]!.GetValue<string>() == "windows","missing NVIDIA provider retains Windows metadata without fabricated sensors.");
        int unknownSensorCalls = 0;
        var unknownCount = adapter with { PhysicalCountConfirmed=false };
        var unknown = NativeGpuDetails.Build([unknownCount],gpus,at,null,null,_=>{unknownSensorCalls++;return new JsonObject();})[0]!;
        Check(unknown["dedicatedMemoryBytes"] is null && unknown["sharedMemoryBytes"] is null && unknown["pciBusId"] is null && unknown["temperatureCelsius"] is null && unknownSensorCalls == 0,"fallback phys0 with no counters is not a confirmed single node and receives no logical totals or PCI board sensors.");
        Check(!NativeGpuInventory.EffectiveNodes([unknownCount],[new("pid_1_luid_0x00000000_0x000150ce_phys_1_eng_0_engtype_3D",0,1)])[0].PhysicalCountConfirmed,"observed PDH nodes cannot upgrade unknown hardware cardinality into a confirmed single node.");
        Check(WindowsGpuInventorySource.ConfirmedCount(0) is null && WindowsGpuInventorySource.ConfirmedCount(17) is null && WindowsGpuInventorySource.ConfirmedCount(1) == 1,"invalid native counts cannot be clamped into a claimed single node.");
        Check(gpus[0]!.AsObject().Select(pair=>pair.Key).Order().SequenceEqual(new[]{"id","name","vendor","utilization","collectedAt"}.Order()),"GPU history keeps exactly its five original fields.");
        foreach (var absent in new IReadOnlyList<GpuCounter>?[] { null,[],[dedicated[1],dedicated[1]],[new(dedicated[1].Instance,2,42)],[new(dedicated[1].Instance,0,-1)],[new(dedicated[1].Instance,0,double.NaN)],[new(dedicated[1].Instance,0,double.PositiveInfinity)],[new(dedicated[1].Instance,0,9007199254740992)],[new(dedicated[1].Instance,0,1.5)] })
            Check(NativeGpuDetails.Build([adapter],gpus,at,absent,shared)[0]!["dedicatedMemoryUsedBytes"] is null,"missing/invalid/duplicate/noninteger/unsafe memory totals remain unknown rather than summed or rounded.");
        var splitAdapter = adapter with { PhysicalCount=2 };
        var splitGpus = NativeGpuInventory.Build([splitAdapter],null,at);
        int calls = 0;
        var split = NativeGpuDetails.Build([splitAdapter],splitGpus,at,dedicated,[new("luid_0x00000000_0x000150ce_phys_1",0,123)],_=>{calls++;return new JsonObject();});
        Check(split.Count == 2 && calls == 0 && split.All(row=>row!["dedicatedMemoryBytes"] is null && row["pciBusId"] is null && row["temperatureCelsius"] is null) && Number(split[1],"sharedMemoryUsedBytes") == 123,"linked nodes keep real per-node memory but never duplicate logical totals or PCI board sensors.");
        var observed = NativeGpuInventory.EffectiveNodes([adapter],[new("pid_1_luid_0x00000000_0x000150ce_phys_1_eng_0_engtype_3D",0,1)]);
        Check(observed[0].PhysicalCount == 2,"a real engine marker detects linked physical nodes even when old DXCore reports only one.");
        var truncated = new JsonArray(gpus[0]!.DeepClone());
        Check(NativeGpuDetails.Build(observed,truncated,at,null,null,_=>{calls++;return new JsonObject();})[0]!["dedicatedMemoryBytes"] is null && calls == 0,"a global sixteen-GPU truncation cannot make an observed linked adapter look single-physical.");
        foreach (var marker in new GpuCounter[]{new("pid_1_luid_0x00000000_0x000150ce_phys_1_eng_0_engtype_3D",2,99),new("pid_1_luid_0x00000000_0x000150ce_phys_1_eng_0_engtype_3D",0,double.NaN)})
            Check(NativeGpuDetails.Build(NativeGpuInventory.EffectiveNodes([adapter],[marker]),truncated,at,null,null,_=>{calls++;return new JsonObject();})[0]!["pciBusId"] is null && calls == 0,"warming/invalid engine values still prove linked node presence and fence PCI sensors.");
        foreach (uint status in new uint[]{0,2})
            Check(NativeGpuDetails.Build([adapter],truncated,at,[new("luid_0x00000000_0x000150ce_phys_1",status,double.NaN)],null,_=>{calls++;return new JsonObject();})[0]!["dedicatedMemoryBytes"] is null && calls == 0,"memory-counter physical identities also fence totals/NVML independently of their measurement validity.");
        var duplicateAddress = adapter with { Low=9 };
        rows = NativeGpuDetails.Build([adapter,duplicateAddress],gpus,at,null,null,_=>{calls++;return new JsonObject();});
        Check(calls == 0 && rows[0]!["sensorProvider"]!.GetValue<string>() == "windows","duplicate Windows PCI addresses cannot steal NVIDIA sensor values.");
        rows = NativeGpuDetails.Build([adapter],gpus,at,dedicated,shared,_=>throw new InvalidOperationException("unavailable optional driver"));
        Check(Number(rows[0],"deviceId") == 0x2204 && Number(rows[0],"sharedMemoryUsedBytes") == 4194304,"vendor driver failures cannot discard independent Windows metadata/memory.");
        rows = NativeGpuDetails.Build([adapter],gpus,at,null,null,_=>new JsonObject { ["id"]="wrong",["collectedAt"]="wrong",["temperatureCelsius"]=double.NaN,["fanPercent"]=201,["cudaCores"]=0,["unknown"]=1 });
        Check(rows[0]!["id"]!.GetValue<string>() == gpus[0]!["id"]!.GetValue<string>() && rows[0]!["collectedAt"]!.GetValue<string>() == at.ToString("O") && rows[0]!["temperatureCelsius"] is null && rows[0]!["fanPercent"] is null && rows[0]!["cudaCores"] is null && !rows[0]!.AsObject().ContainsKey("unknown"),"optional sensor data cannot alter identity/time or leak nonfinite/out-of-range/unknown fields.");
        Check(NativeGpuDetails.Build([adapter],[],at,null,null).Count == 0,"details never invent a GPU outside the core inventory.");
        Check(NativeGpuDetails.Version(0) is null && NativeGpuDetails.Model(9999) is null && NativeGpuDetails.Model(1105) == "WDDM 1.1","unknown driver metadata is not heuristically converted into version claims.");
        foreach (var malformed in new[]{"pid_1_luid_0x00000000_0x000150ce_phys_0","luid_0x000150ce_phys_0","luid_0x00000000_0x000150ce_phys_16",new string('x',1000)}) Check(!NativeGpuDetails.ParseMemory(malformed,out _,out _,out _),"GPU memory instances use the exact bounded adapter grammar.");
        Check(NativeGpuDetails.ParseMemory("luid_0x00000001_0x000150CE_phys_1",out uint high,out uint low,out uint node) && high == 1 && low == 0x150ce && node == 1,"GPU memory includes both LUID halves and the actual node.");
        var late = at; var source = new DetailsSource(adapter,()=>late=late.AddMinutes(3));
        using (var inventory = new NativeGpuInventory(source,()=>late))
        {
            var snapshot = inventory.Collect();
            Check(snapshot["gpus"]![0]!["collectedAt"]!.GetValue<string>() == at.ToString("O") && snapshot["gpuDetails"]![0]!["collectedAt"]!.GetValue<string>() == at.ToString("O"),"a slow optional sensor keeps both core and details timestamps at the conservative original sample time.");
            source.Fail = true; Check(inventory.Collect()["gpus"]!.AsArray().Count == 1,"a failing details provider never removes the core utilization snapshot.");
        }
        Nvml(adapter,gpus,at);
        NvmlDriverChange(adapter,gpus,at);
        DeferredShutdownAsync(adapter).GetAwaiter().GetResult();
        Console.WriteLine("PASS GPU details: independent SDK PCI/PDH ABI, trusted loader paths, exact PCI/LUID/node joins, unchanged core schema, safe field units/bounds, optional NVML failure isolation, NVML reload after a driver change and linked-node conservatism.");
    }
    private static void Abi()
    {
        Check(Marshal.SizeOf<NvidiaGpuSensors.PciInfo>() == 68,"NVML PCI v3 SDK structure is 68 bytes (legacy16 + five UINTs + bus32).");
        foreach (var pair in new Dictionary<string,int>{{"LegacyBusId",0},{"Domain",16},{"Bus",20},{"Device",24},{"PciDeviceId",28},{"PciSubsystemId",32},{"BusId",36}}) Check(Marshal.OffsetOf<NvidiaGpuSensors.PciInfo>(pair.Key).ToInt32() == pair.Value,"NVML PCI v3 SDK offset: " + pair.Key);
        Check(Marshal.SizeOf<GpuPciAddress>() == 12 && WindowsGpuInventorySource.AdapterAddressQuery == 6,"D3DKMT_ADAPTERADDRESS uses three UINTs and SDK query type6.");
        IntPtr data = Marshal.AllocHGlobal(256);
        try
        {
            Marshal.Copy(new byte[256],0,data,256); Marshal.Copy(Encoding.ASCII.GetBytes("0000:01:00.0\0"),0,data,13); Marshal.WriteInt32(data,16,0); Marshal.WriteInt32(data,20,1); Marshal.WriteInt32(data,24,0); Marshal.WriteInt32(data,28,unchecked((int)0x220410de)); Marshal.WriteInt32(data,32,0x147d10de); var bus=Encoding.ASCII.GetBytes("00000000:01:00.0\0"); Marshal.Copy(bus,0,IntPtr.Add(data,36),bus.Length);
            var pci=Marshal.PtrToStructure<NvidiaGpuSensors.PciInfo>(data); Check(pci.Domain == 0 && pci.Bus == 1 && pci.PciDeviceId == 0x220410de && pci.PciSubsystemId == 0x147d10de && pci.BusId == "00000000:01:00.0","PCI info bytes authored at SDK offsets decode independently of managed declarations.");
            Marshal.WriteInt32(data,0,23); Marshal.WriteInt32(data,4,17); Marshal.WriteInt32(data,8,3); var address=Marshal.PtrToStructure<GpuPciAddress>(data); Check(address.Bus == 23 && address.Device == 17 && address.Function == 3 && address.BusId == "17:11.3","D3DKMT BDF fixture uses explicit SDK byte offsets.");
            Marshal.Copy(new byte[256],0,data,256); Marshal.WriteIntPtr(data,0,IntPtr.Add(data,24)); Marshal.WriteInt32(data,8,0); Marshal.WriteInt64(data,16,5_000_000_001); var text=Encoding.Unicode.GetBytes("luid_0x00000000_0x000150ce_phys_0\0"); Marshal.Copy(text,0,IntPtr.Add(data,24),text.Length);
            Check(WindowsGpuInventorySource.ReadArray(data,256,1,large:true)[0].Value == 5_000_000_001,"PDH LARGE union is signed64 bytes, not a double or truncated UINT.");
        }
        finally { Marshal.FreeHGlobal(data); }
        var paths=NvmlDriverLibrary.Candidates("C:\\Windows\\System32","C:\\Program Files"); Check(paths.Count == 2 && paths[0] == "C:\\Windows\\System32\\nvml.dll" && paths[1] == "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvml.dll" && paths.All(Path.IsPathFullyQualified),"NVML loader has only absolute trusted OS/vendor candidates, never PATH/CWD/application directory.");
        Check(NvmlDriverLibrary.Candidates("","").Count == 0 && NvmlDriverLibrary.Candidates("relative","C:relative").Count == 0 && NvmlDriverLibrary.Candidates("C:\\Windows\\System32","").Count == 1,"missing/relative OS paths cannot introduce a DLL lookup in the current directory.");
    }
    private static NvidiaGpuSensors.PciInfo Pci(uint bus=1,uint function=0,uint domain=0,uint deviceId=0x220410de,uint subsystem=0x147d10de) => new(){LegacyBusId=$"{domain:x4}:{bus:x2}:00.{function}",Domain=domain,Bus=bus,Device=0,PciDeviceId=deviceId,PciSubsystemId=subsystem,BusId=$"{domain:x8}:{bus:x2}:00.{function}"};
    private static void Nvml(GpuAdapter adapter,JsonArray gpus,DateTimeOffset at)
    {
        var correct=new NvmlDevice(new IntPtr(1),Pci()); var other=new NvmlDevice(new IntPtr(2),Pci(bus:2));
        Check(NvidiaGpuSensors.Match(adapter,[other,correct]) == correct.Handle,"NVML index order does not associate a different GPU's sensors.");
        foreach (var devices in new IReadOnlyList<NvmlDevice>[] { [],[other],[correct,correct],[new(new IntPtr(1),Pci(domain:1))],[new(new IntPtr(1),Pci(function:1))],[new(new IntPtr(1),Pci(deviceId:0x278210de))],[new(new IntPtr(1),Pci(subsystem:1))],[correct,new(new IntPtr(2),Pci(domain:1))] }) Check(NvidiaGpuSensors.Match(adapter,devices) == IntPtr.Zero,"unknown/mismatched/ambiguous domain/function/vendor/device/subsystem cannot map sensors by name or array order.");
        Check(NvidiaGpuSensors.Match(adapter with { PhysicalCount=2 },[correct]) == IntPtr.Zero,"one PCI sensor set cannot be repeated across linked physical nodes.");
        Check(NvidiaGpuSensors.Match(adapter with { PhysicalCountConfirmed=false },[correct]) == IntPtr.Zero,"an unconfirmed fallback node never receives vendor sensors even with an exact PCI candidate.");
        var library=new FakeLibrary(); int init=0,shutdown=0;
        library.Exports["nvmlInit_v2"]=new NvidiaGpuSensors.InitializeFunction(()=>{init++;return 0;});
        library.Exports["nvmlShutdown"]=new NvidiaGpuSensors.InitializeFunction(()=>{shutdown++;return 0;});
        library.Exports["nvmlDeviceGetCount_v2"]=new NvidiaGpuSensors.CountFunction((out uint count)=>{count=2;return 0;});
        library.Exports["nvmlDeviceGetHandleByIndex_v2"]=new NvidiaGpuSensors.IndexFunction((uint index,out IntPtr device)=>{device=index==0?other.Handle:correct.Handle;return 0;});
        library.Exports["nvmlDeviceGetPciInfo_v3"]=new NvidiaGpuSensors.PciFunction((IntPtr device,out NvidiaGpuSensors.PciInfo pci)=>{pci=device==correct.Handle?correct.Pci:other.Pci;return 0;});
        library.Exports["nvmlDeviceGetTemperature"]=new NvidiaGpuSensors.KindFunction((IntPtr device,uint kind,out uint value)=>{value=0;return 0;});
        library.Exports["nvmlDeviceGetClockInfo"]=new NvidiaGpuSensors.KindFunction((IntPtr device,uint kind,out uint value)=>{value=kind==0?210u:810u;return 0;});
        library.Exports["nvmlDeviceGetPowerUsage"]=new NvidiaGpuSensors.UIntFunction((IntPtr device,out uint value)=>{value=164123;return 0;});
        library.Exports["nvmlDeviceGetPowerManagementLimit"]=new NvidiaGpuSensors.UIntFunction((IntPtr device,out uint value)=>{value=999999;return 3;});
        library.Exports["nvmlDeviceGetFanSpeed"]=new NvidiaGpuSensors.UIntFunction((IntPtr device,out uint value)=>{value=150;return 0;});
        library.Exports["nvmlDeviceGetMemoryBusWidth"]=new NvidiaGpuSensors.UIntFunction((IntPtr device,out uint value)=>{value=384;return 0;});
        library.Exports["nvmlDeviceGetNumGpuCores"]=new NvidiaGpuSensors.UIntFunction((IntPtr device,out uint value)=>{value=10496;return 0;});
        library.Exports["nvmlDeviceGetDriverModel"]=new NvidiaGpuSensors.ModelFunction((IntPtr device,out uint current,out uint pending)=>{current=0;pending=0;return 0;});
        using (var sensors=new NvidiaGpuSensors(library))
        {
            var rows=NativeGpuDetails.Build([adapter],gpus,at,null,null,sensors.Read); var row=rows[0]!;
            Check(Number(row,"temperatureCelsius") == 0 && Number(row,"coreClockMhz") == 210 && Number(row,"memoryClockMhz") == 810 && Number(row,"powerWatts") == 164.123 && Number(row,"fanPercent") == 150 && Number(row,"memoryBusWidthBits") == 384 && Number(row,"cudaCores") == 10496,"NVML sensor/clock/milliwatt/fan/core outputs retain actual units, exact device and valid zero.");
            Check(row["powerLimitWatts"] is null && row["vbiosVersion"] is null && row["sensorProvider"]!.GetValue<string>() == "nvidia-nvml" && row["driverModel"]!.GetValue<string>() == "WDDM 3.2","one unsupported status or missing export leaves only its field unknown and keeps the fuller Windows driver model.");
            library.Exports["nvmlDeviceGetTemperature"]=new NvidiaGpuSensors.KindFunction((IntPtr device,uint kind,out uint value)=>throw new InvalidOperationException("optional sensor unavailable"));
            row=NativeGpuDetails.Build([adapter],gpus,at,null,null,sensors.Read)[0]!;Check(row["temperatureCelsius"] is null && Number(row,"powerWatts") == 164.123 && init == 1,"one failing optional sensor does not suppress unrelated readings or repeatedly initialize the driver.");
            library.Exports["nvmlDeviceGetPciInfo_v3"]=new NvidiaGpuSensors.PciFunction((IntPtr device,out NvidiaGpuSensors.PciInfo pci)=>{pci=correct.Pci;return device == other.Handle ? 3 : 0;});
            row=NativeGpuDetails.Build([adapter],gpus,at,null,null,sensors.Read)[0]!;Check(row["sensorProvider"]!.GetValue<string>() == "windows" && row["powerWatts"] is null && Number(row,"deviceId") == 0x2204,"unreadable PCI information prevents partial enumeration from claiming a unique vendor sensor match while Windows facts survive.");
            library.Exports["nvmlDeviceGetHandleByIndex_v2"]=new NvidiaGpuSensors.IndexFunction((uint index,out IntPtr device)=>{device=correct.Handle;return index == 0 ? 3 : 0;});
            Check(sensors.Read(adapter) is null,"an unreadable NVML handle also makes device attribution unavailable, without skipping the unknown adapter.");
            sensors.Dispose();
        }
        Check(shutdown == 1 && library.Disposals == 1,"one initialized NVML reference is shut down and released exactly once.");
        using var missing=new NvidiaGpuSensors(new FakeLibrary());Check(missing.Read(adapter) is null,"missing NVML initialization/export remains optional.");
    }
    // One NVML library of a driver: init status, shutdown count and the version it reports.
    private static FakeLibrary DriverLibrary(string version,int initStatus,Action onInit,Action onShutdown)
    {
        var correct=new NvmlDevice(new IntPtr(1),Pci()); var library=new FakeLibrary();
        library.Exports["nvmlInit_v2"]=new NvidiaGpuSensors.InitializeFunction(()=>{onInit();return initStatus;});
        library.Exports["nvmlShutdown"]=new NvidiaGpuSensors.InitializeFunction(()=>{onShutdown();return 0;});
        library.Exports["nvmlDeviceGetCount_v2"]=new NvidiaGpuSensors.CountFunction((out uint count)=>{count=1;return 0;});
        library.Exports["nvmlDeviceGetHandleByIndex_v2"]=new NvidiaGpuSensors.IndexFunction((uint index,out IntPtr device)=>{device=correct.Handle;return 0;});
        library.Exports["nvmlDeviceGetPciInfo_v3"]=new NvidiaGpuSensors.PciFunction((IntPtr device,out NvidiaGpuSensors.PciInfo pci)=>{pci=correct.Pci;return 0;});
        library.Exports["nvmlSystemGetDriverVersion"]=new NvidiaGpuSensors.SystemStringFunction((byte[] value,uint length)=>{var bytes=Encoding.ASCII.GetBytes(version+"\0");System.Array.Copy(bytes,value,bytes.Length);return 0;});
        return library;
    }
    // A new DXCore driver version reloads NVML, so vendorDriverVersion follows a driver update without a worker restart.
    private static void NvmlDriverChange(GpuAdapter adapter,JsonArray gpus,DateTimeOffset at)
    {
        string? Vendor(JsonNode? row) => row?["vendorDriverVersion"]?.GetValue<string>();
        GpuAdapter WithDriver(ulong version) => adapter with { Hardware=adapter.Hardware! with { DriverVersion=version } };
        var updated=WithDriver(0x00200010000f0842); var failing=WithDriver(0x00200010000f0843);
        var libraries=new List<FakeLibrary>(); int inits=0,shutdowns=0;
        var drivers=new Queue<(string Version,int Status)>([("581.57",0),("621.14",0),("621.15",1),("621.15",0)]);
        FakeLibrary Load() { var (version,status)=drivers.Dequeue(); var library=DriverLibrary(version,status,()=>inits++,()=>shutdowns++); libraries.Add(library); return library; }
        using (var sensors=new NvidiaGpuSensors(Load))
        {
            Check(Vendor(NativeGpuDetails.Build([adapter],gpus,at,null,null,sensors.Read)[0]) == "581.57" && libraries.Count == 1 && inits == 1,"the first read loads NVML once.");
            Check(Vendor(NativeGpuDetails.Build([adapter],gpus,at,null,null,sensors.Read)[0]) == "581.57" && libraries.Count == 1 && inits == 1 && shutdowns == 0,"the same DXCore driver version keeps the loaded NVML without a new initialization.");
            Check(Vendor(NativeGpuDetails.Build([updated],gpus,at,null,null,sensors.Read)[0]) == "621.14" && shutdowns == 1 && libraries[0].Disposals == 1 && libraries.Count == 2 && inits == 2,"a changed DXCore driver version shuts NVML down, frees the old library and reports the version of the new driver.");
            Check(Vendor(NativeGpuDetails.Build([updated],gpus,at,null,null,sensors.Read)[0]) == "621.14" && libraries.Count == 2 && shutdowns == 1,"after the reload the new driver version is the known one.");
            var row=NativeGpuDetails.Build([failing],gpus,at,null,null,sensors.Read)[0]!;
            Check(Vendor(row) is null && row["sensorProvider"]!.GetValue<string>() == "windows" && shutdowns == 2 && libraries[1].Disposals == 1 && libraries[2].Disposals == 1 && libraries.Count == 3,"a failed re-initialization frees the library and leaves the row without vendorDriverVersion.");
            Check(Vendor(NativeGpuDetails.Build([failing],gpus,at,null,null,sensors.Read)[0]) is null && libraries.Count == 3,"the failed re-initialization waits for the 1-minute retry.");
        }
        Check(libraries[2].Disposals == 1 && libraries.All(library => library.Disposals <= 1),"each loaded library is freed once.");
        // An injected library is never freed by the reload, only by Dispose.
        int injectedInits=0,injectedShutdowns=0; var single=DriverLibrary("581.57",0,()=>injectedInits++,()=>injectedShutdowns++);
        using (var sensors=new NvidiaGpuSensors(single))
        {
            _ = sensors.Read(adapter); _ = sensors.Read(updated);
            Check(injectedInits == 2 && injectedShutdowns == 1 && single.Disposals == 0,"an injected library is shut down and initialized again but not freed on a driver change.");
        }
        Check(single.Disposals == 1 && injectedShutdowns == 2,"Dispose still shuts down and frees the injected library once.");
    }
    private sealed class FakeLibrary : INvmlLibrary
    {
        internal Dictionary<string,Delegate> Exports=[];internal int Disposals;internal Action? OnDispose;
        public T? Function<T>(string name) where T:Delegate => Exports.GetValueOrDefault(name) as T;
        public void Dispose() { Disposals++; OnDispose?.Invoke(); }
    }
    private static async Task DeferredShutdownAsync(GpuAdapter adapter)
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var finished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var library = new FakeLibrary { OnDispose=()=>finished.TrySetResult() };
        library.Exports["nvmlInit_v2"] = new NvidiaGpuSensors.InitializeFunction(()=>0);
        int shutdowns = 0;
        library.Exports["nvmlShutdown"] = new NvidiaGpuSensors.InitializeFunction(()=>{Interlocked.Increment(ref shutdowns);entered.TrySetResult();release.Task.GetAwaiter().GetResult();return 0;});
        var sensors = new NvidiaGpuSensors(library); _ = sensors.Read(adapter); // Initialize, even though other optional exports are absent.
        var inventory = new NativeGpuInventory(new ShutdownSource(sensors));
        try
        {
            await Task.Run(()=>inventory.DisposeWhenComplete(Task.CompletedTask)).WaitAsync(TimeSpan.FromSeconds(1));
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await Task.Run(()=>inventory.DisposeWhenComplete(null)).WaitAsync(TimeSpan.FromSeconds(1));
            Check(!finished.Task.IsCompleted && shutdowns == 1,"a blocked nvmlShutdown never stalls service stop or queues a second shutdown, even with a completed collector.");
        }
        finally { release.TrySetResult(); }
        await finished.Task.WaitAsync(TimeSpan.FromSeconds(5)); Check(library.Disposals == 1,"deferred NVML cleanup releases its driver library once after shutdown completes.");
    }
    private sealed class ShutdownSource(NvidiaGpuSensors sensors) : IGpuInventorySource
    {
        public IReadOnlyList<GpuAdapter> Adapters()=>[];
        public IReadOnlyList<GpuCounter>? Sample(DateTimeOffset at)=>null;
        public void Dispose()=>sensors.Dispose();
    }
    private sealed class DetailsSource(GpuAdapter hardware,Action sample) : IGpuInventorySource
    {
        internal bool Fail;
        public IReadOnlyList<GpuAdapter> Adapters()=>[hardware];
        public IReadOnlyList<GpuCounter>? Sample(DateTimeOffset at)=>null;
        public JsonArray? Details(IReadOnlyList<GpuAdapter> adapters,JsonArray gpus,DateTimeOffset at) { sample(); return Fail ? throw new InvalidOperationException("optional provider failed") : NativeGpuDetails.Build(adapters,gpus,at,null,null); }
        public void Dispose() { }
    }
}
