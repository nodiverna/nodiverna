using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class NativeGpuInventoryTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("GPU telemetry regression: " + message); }
    private static string Instance(uint low, uint pid, uint engine, uint physical = 0, uint high = 0) => $"pid_{pid}_luid_0x{high:x8}_0x{low:x8}_phys_{physical}_eng_{engine}_engtype_3D";
    private static double? Utilization(JsonArray rows, int index) => rows[index]!["utilization"]?.GetValue<double>();
    internal static int RunSelfTest() { try { RunAsync().GetAwaiter().GetResult(); return 0; } catch (Exception error) { Console.Error.WriteLine(error); return 1; } }
    internal static async Task RunAsync()
    {
        Abi();
        var at = DateTimeOffset.Parse("2026-10-11T18:00:00Z");
        GpuAdapter[] adapters = [new(0, 0x150ce, "NVIDIA GeForce RTX 3090", 0x10de), new(0, 0x200, "AMD Radeon RX", 0x1002), new(0, 0x300, "Intel(R) Arc(TM) A770", 0x8086)];
        GpuCounter[] counters = [new(Instance(0x150ce, 11, 0), 0, 30), new(Instance(0x150ce, 22, 0), 1, 45), new(Instance(0x150ce, 11, 1), 0, 50), new(Instance(0x200, 11, 0), 0, 17), new(Instance(0x300, 11, 0), 0, 0), new(Instance(0x1636b, 11, 0), 0, 100)];
        var rows = NativeGpuInventory.Build(adapters, counters, at);
        Check(rows.Count == 3 && Utilization(rows, 0) == 75 && Utilization(rows, 1) == 17 && Utilization(rows, 2) == 0, "sum processes within each engine, then select its GPU's highest engine; valid idle zero remains real.");
        Check(rows[0]!["id"]!.GetValue<string>() == "luid_0x00000000_0x000150ce_phys_0" && rows[0]!["collectedAt"]!.GetValue<string>() == at.ToString("O"), "wire identity and timestamp must preserve actual LUID and sample time.");
        Check(NativeGpuInventory.Build(adapters, counters.Reverse().ToArray(), at).ToJsonString() == rows.ToJsonString(), "counter enumeration order cannot change adapter mapping.");
        Check(Utilization(NativeGpuInventory.Build(adapters, counters.Concat([counters[0]]).ToArray(), at), 0) == 75, "duplicate process/engine counters must not count twice.");
        Check(Utilization(NativeGpuInventory.Build(adapters, [new(Instance(0x150ce, 1, 0), 0, 85), new(Instance(0x150ce, 2, 0), 0, 85)], at), 0) == 100, "summed process rates must be bounded to 100 percent.");
        foreach (var absent in new IReadOnlyList<GpuCounter>?[] { null, [], [new(Instance(0x150ce, 1, 0), 2, 99)], [new(Instance(0x150ce, 1, 0), 0, double.NaN)], [new(Instance(0x150ce, 1, 0), 0, double.PositiveInfinity)], [new(Instance(0x150ce, 1, 0), 0, -1)] })
            Check(Utilization(NativeGpuInventory.Build(adapters, absent, at), 0) is null, "missing/warming/invalid counter data must never invent zero.");
        var split = NativeGpuInventory.Build([adapters[0] with { PhysicalCount = 2 }, adapters[0] with { High = 1 }], [new(Instance(0x150ce, 1, 0), 0, 10), new(Instance(0x150ce, 1, 0, 1), 0, 80), new(Instance(0x150ce, 1, 0, 0, 1), 0, 25)], at);
        Check(split.Count == 3 && Utilization(split, 0) == 10 && Utilization(split, 1) == 80 && Utilization(split, 2) == 25, "linked physical indices and equal low parts in distinct full LUIDs stay separate.");
        Check(NativeGpuInventory.Build([adapters[0]], [new(Instance(0x150ce, 1, 0, 1), 0, 80)], at).Count == 2, "a real matching counter identifies linked nodes when older DXCore lacks their count.");
        GpuAdapter[] filtered = [new(0, 1, "Microsoft Basic Render Driver", 0x1414, 2), new(0, 2, "Parsec Virtual Display Adapter", 0), new(0, 3, "Software NVIDIA", 0x10de, 2), new(0, 4, "Remote AMD", 0x1002, 1), new(0, 5, "Intel UHD Graphics", 0x8086), new(0, 6, "Intel Iris Xe", 0x8086), new(0, 7, "Intel Arcane unrelated", 0x8086), new(0, 0, "Missing LUID NVIDIA", 0x10de), new(0, 8, " ", 0x1002)];
        Check(NativeGpuInventory.Build(filtered, [], at).Count == 0, "exclude software, remote, virtual, unknown vendors, Intel UHD/Iris and non-Arc names.");
        Check(WindowsGpuInventorySource.IsPhysicalType(3) && WindowsGpuInventorySource.IsPhysicalType(1 | 16) && WindowsGpuInventorySource.IsPhysicalType(1 | 32), "kernel render-capable discrete/integrated hardware remains eligible.");
        foreach (uint flags in new uint[] { 0, 2, 1 | 4, 1 | 64, 1 | 128, 1 | 16384 }) Check(!WindowsGpuInventorySource.IsPhysicalType(flags), "virtual/indirect/software/test adapters cannot impersonate their rendering GPU's DXGI vendor.");
        var bounded = NativeGpuInventory.Build(Enumerable.Range(1, 50).Select(i => new GpuAdapter(0, (uint)i, new string('x', 300), 0x10de)).ToArray(), [], at);
        Check(bounded.Count == 16 && bounded.All(g => g!["name"]!.GetValue<string>().Length == 256 && g["id"]!.GetValue<string>().Length <= 128), "GPU count, names and IDs must fit portal bounds.");
        Check(NativeGpuInventory.Build([adapters[0], adapters[0]], [], at).Count == 1, "duplicate adapter IDs are not emitted.");
        foreach (string malformed in new[] { "_Total", "pid_1_luid_0x150ce_0x00000000_phys_0_eng_0_engtype_3D", Instance(1, 1, 1, 16), Instance(1, 1, 1).Replace("pid_1", "pid_4294967296"), new string('x', 10000) })
            Check(!NativeGpuInventory.ParseInstance(malformed, out _), "invalid/unbounded instance grammar is rejected.");
        Check(NativeGpuInventory.ParseInstance(Instance(0x150ce, 1, 9) + "#1", out var parsed) && parsed.Low == 0x150ce && parsed.Engine == 9, "PDH duplicate suffix does not change the engine key.");
        var fake = new FakeSource { Hardware = adapters, Counters = null };
        using (var inventory = new NativeGpuInventory(fake, () => at))
        {
            Check(inventory.Collect()["gpus"]![0]!["utilization"] is null, "first provider warmup exposes supported hardware with unavailable rates.");
            fake.Counters = counters; Check(inventory.Collect()["gpus"]!.AsArray().Count == 3, "later rate data is independent of warmup.");
            fake.SampleError = true; Check(inventory.Collect()["gpus"]![0]!["utilization"] is null, "driver sampling failure retains hardware without forged rates.");
            fake.SampleError = false; fake.Hardware = [adapters[1]]; Check(inventory.Collect()["gpus"]!.AsArray().Count == 1, "hot-unplug replaces the adapter inventory instead of retaining removed hardware.");
            fake.AdapterError = true; Check(!inventory.Collect().ContainsKey("gpus"), "unavailable adapter provider omits unknown inventory rather than reporting absence.");
        }
        Check(fake.Disposals == 1, "provider resources are released exactly once.");
        var late = at;
        using (var inventory = new NativeGpuInventory(new FakeSource { Hardware = adapters, Counters = counters, OnSample = () => late = late.AddMinutes(3) }, () => late))
            Check(inventory.Collect()["gpus"]![0]!["collectedAt"]!.GetValue<string>() == at.ToString("O"), "a driver returning late cannot mark the old sample as freshly captured at its return time.");
        var headless = new FakeSource();
        using (var inventory = new NativeGpuInventory(headless, () => at))
            Check(inventory.Collect()["gpus"]!.AsArray().Count == 0 && headless.Samples == 0, "no supported hardware requires no PDH query on headless servers.");
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var unblock = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stalled = new FakeSource { Hardware = adapters, OnSample = () => { entered.TrySetResult(); unblock.Task.GetAwaiter().GetResult(); } };
        var hungInventory = new NativeGpuInventory(stalled, () => at); var slot = new TelemetryCollectorSlot("GPU", TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(6), hungInventory.Collect);
        slot.StartIfDue(at); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        for (int i = 1; i < 50; i++) slot.StartIfDue(at.AddSeconds(i * 30));
        Check(stalled.Samples == 1 && slot.Read(at.AddSeconds(7)).Value is null, "a stuck GPU driver remains single-flight and never blocks heartbeat snapshot reads.");
        hungInventory.DisposeWhenComplete(slot.CurrentTask); Check(stalled.Disposals == 0, "shutdown must not close a PDH query while its worker is using it.");
        unblock.TrySetResult(); await slot.CurrentTask!; for (int i = 0; i < 100 && stalled.Disposals == 0; i++) await Task.Delay(1);
        Check(stalled.Disposals == 1, "deferred query disposal runs after the native worker returns.");
        Check(slot.Read(at.AddSeconds(8)).Value?["gpus"]?.AsArray().Count == 3 && slot.Read(at.AddSeconds(84)).Value is null, "GPU slot publishes recovered data but removes stale inventories.");
        Console.WriteLine("PASS native GPU telemetry: SDK ABI, full LUID/physical/engine mapping, process sums/busiest engine, hardware filters, bounds, null/warmup, hotplug and nonblocking deadline/disposal.");
    }
    private static void Abi()
    {
        Check(WindowsGpuInventorySource.AdapterTypeQuery == 15, "Windows SDK KMTQAITYPE_ADAPTERTYPE is 15; reserved value 14 cannot query a four-byte adapter type.");
        Check(IntPtr.Size == 8 && Marshal.SizeOf<WindowsGpuInventorySource.AdapterDescription>() == 312, "DXGI_ADAPTER_DESC1 must use the 312-byte Windows x64 SDK layout.");
        var offsets = new Dictionary<string, int> { ["Vendor"] = 256, ["Device"] = 260, ["SubSystem"] = 264, ["Revision"] = 268, ["DedicatedVideo"] = 272, ["DedicatedSystem"] = 280, ["SharedSystem"] = 288, ["Luid"] = 296, ["Flags"] = 304 };
        foreach (var pair in offsets) Check(Marshal.OffsetOf<WindowsGpuInventorySource.AdapterDescription>(pair.Key).ToInt32() == pair.Value, "DXGI " + pair.Key + " offset differs from the native SDK.");
        Check(Marshal.SizeOf<WindowsGpuInventorySource.CounterItem>() == 24 && Marshal.OffsetOf<WindowsGpuInventorySource.CounterItem>("Value").ToInt32() == 8 && Marshal.SizeOf<WindowsGpuInventorySource.CounterValue>() == 16 && Marshal.OffsetOf<WindowsGpuInventorySource.CounterValue>("DoubleValue").ToInt32() == 8, "PDH item stride and status/double union offsets must match Windows x64.");
        Check(Marshal.SizeOf<WindowsGpuInventorySource.KernelOpenAdapter>() == 12 && Marshal.OffsetOf<WindowsGpuInventorySource.KernelOpenAdapter>("Adapter").ToInt32() == 8 && Marshal.SizeOf<WindowsGpuInventorySource.KernelQueryAdapter>() == 24 && Marshal.OffsetOf<WindowsGpuInventorySource.KernelQueryAdapter>("Data").ToInt32() == 8 && Marshal.OffsetOf<WindowsGpuInventorySource.KernelQueryAdapter>("Bytes").ToInt32() == 16 && Marshal.SizeOf<WindowsGpuInventorySource.KernelCloseAdapter>() == 4, "D3DKMT handles are 32-bit and their x64 query structure keeps its SDK pointer alignment.");
        IntPtr desc = Marshal.AllocHGlobal(312), buffer = Marshal.AllocHGlobal(1024);
        try
        {
            Marshal.Copy(new byte[312], 0, desc, 312); byte[] name = Encoding.Unicode.GetBytes("NVIDIA ABI\0"); Marshal.Copy(name, 0, desc, name.Length);
            Marshal.WriteInt32(desc, 256, 0x10de); Marshal.WriteInt64(desc, 272, 987654321); Marshal.WriteInt32(desc, 296, 0x150ce); Marshal.WriteInt32(desc, 300, 9);
            var actual = Marshal.PtrToStructure<WindowsGpuInventorySource.AdapterDescription>(desc);
            Check(actual.Description == "NVIDIA ABI" && actual.Vendor == 0x10de && actual.DedicatedVideo.ToUInt64() == 987654321 && actual.Luid.Low == 0x150ce && actual.Luid.High == 9, "read fixture bytes authored at SDK offsets, independently of managed structure declarations.");
            Marshal.Copy(new byte[1024], 0, buffer, 1024); string first = Instance(0x150ce, 11, 0), second = Instance(0x200, 22, 1); int firstName = 48, secondName = firstName + (first.Length + 1) * 2;
            Marshal.WriteIntPtr(buffer, 0, IntPtr.Add(buffer, firstName)); Marshal.WriteInt32(buffer, 8, 0); Marshal.WriteInt64(buffer, 16, BitConverter.DoubleToInt64Bits(17.25));
            Marshal.WriteIntPtr(buffer, 24, IntPtr.Add(buffer, secondName)); Marshal.WriteInt32(buffer, 32, 1); Marshal.WriteInt64(buffer, 40, BitConverter.DoubleToInt64Bits(42));
            foreach (var pair in new[] { (first, firstName), (second, secondName) }) { byte[] text = Encoding.Unicode.GetBytes(pair.Item1 + '\0'); Marshal.Copy(text, 0, IntPtr.Add(buffer, pair.Item2), text.Length); }
            var values = WindowsGpuInventorySource.ReadArray(buffer, 1024, 2); Check(values.Count == 2 && values[0] == new GpuCounter(first, 0, 17.25) && values[1] == new GpuCounter(second, 1, 42), "PDH second array record, name pointers and union values must preserve their actual native bytes.");
            foreach (Action invalid in new Action[] { () => WindowsGpuInventorySource.ReadArray(buffer, 23, 1), () => WindowsGpuInventorySource.ReadArray(buffer, 1024, 32769), () => { Marshal.WriteIntPtr(buffer, 0, IntPtr.Add(buffer, 1024)); WindowsGpuInventorySource.ReadArray(buffer, 1024, 1); } })
            { bool rejected = false; try { invalid(); } catch (InvalidDataException) { rejected = true; } Check(rejected, "malformed native arrays cannot access names outside their bounded allocation."); }
        }
        finally { Marshal.FreeHGlobal(desc); Marshal.FreeHGlobal(buffer); }
    }
    internal static async Task<int> SampleAsync()
    {
        if (!OperatingSystem.IsWindows()) { Console.Error.WriteLine("GPU native sample requires Windows."); return 1; }
        var inventory = new NativeGpuInventory(); var slot = new TelemetryCollectorSlot("GPU", TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(6), inventory.Collect);
        try
        {
            slot.StartIfDue(DateTimeOffset.UtcNow); await slot.CurrentTask!.WaitAsync(TimeSpan.FromSeconds(8)); _ = slot.Read(DateTimeOffset.UtcNow);
            await Task.Delay(1000); slot.RequestRefresh(); slot.StartIfDue(DateTimeOffset.UtcNow); await slot.CurrentTask!.WaitAsync(TimeSpan.FromSeconds(8));
            var snapshot = slot.Read(DateTimeOffset.UtcNow).Value ?? throw new InvalidOperationException("GPU inventory unavailable."); Console.WriteLine(snapshot.ToJsonString()); return 0;
        }
        catch (Exception error) { Console.Error.WriteLine("GPU native sample failed: " + NativeInventoryDiagnostics.Describe(error)); return 1; }
        finally { inventory.DisposeWhenComplete(slot.CurrentTask); }
    }
    private sealed class FakeSource : IGpuInventorySource
    {
        internal IReadOnlyList<GpuAdapter> Hardware = []; internal IReadOnlyList<GpuCounter>? Counters; internal bool AdapterError, SampleError; internal Action? OnSample; internal int Samples, Disposals;
        public IReadOnlyList<GpuAdapter> Adapters() => AdapterError ? throw new InvalidOperationException("provider unavailable") : Hardware;
        public IReadOnlyList<GpuCounter>? Sample(DateTimeOffset at) { Interlocked.Increment(ref Samples); OnSample?.Invoke(); return SampleError ? throw new InvalidOperationException("driver unavailable") : Counters; }
        public void Dispose() => Interlocked.Increment(ref Disposals);
    }
}
