using System.Text.Json.Nodes;
using System.Globalization;

namespace ServerDesk.Agent;

internal static class NativeHardwareInventoryTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Hardware inventory regression: " + message); }
    private static Dictionary<string, object?> Row(params (string Key, object? Value)[] values) => values.ToDictionary(value => value.Key, value => value.Value);
    private static double? Number(JsonNode? row, string name) => double.TryParse(row?[name]?.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : null;
    internal static async Task<int> RunSelfTestAsync() { try { await RunAsync(); return 0; } catch (Exception error) { Console.Error.WriteLine(error); return 1; } }
    internal static int Sample()
    {
        if (!OperatingSystem.IsWindows()) { Console.Error.WriteLine("Hardware inventory requires Windows."); return 1; }
        try { Console.WriteLine(new NativeHardwareInventory().Collect().ToJsonString()); return 0; }
        catch (Exception error) { Console.Error.WriteLine(NativeInventoryDiagnostics.Describe(error)); return 1; }
    }

    internal static async Task RunAsync()
    {
        var at = DateTimeOffset.Parse("2026-10-12T10:00:00Z");
        var provider = new FakeProvider();
        var inventory = new NativeHardwareInventory(provider.Query, () => at);
        var result = inventory.Collect()["hardware"]!.AsObject();
        Check(result["complete"]!.GetValue<bool>() && result["errors"] is null && result["collectedAt"]!.GetValue<string>() == at.ToString("O") && Number(result, "intervalSeconds") == 900, "static collection has its real start time and explicit 15-minute cadence.");
        Check(provider.Calls == 9 && provider.Timeouts.All(timeout => timeout == TimeSpan.FromSeconds(2)), "all Windows queries have independent two-second timeouts.");
        var cpu = result["cpus"]![0]!;
        Check(cpu["name"]!.GetValue<string>() == "Test CPU" && Number(cpu, "cores") == 8 && Number(cpu, "threads") == 16 && Number(cpu, "maxClockMhz") == 4800, "CPU model, real physical/logical counts and MHz are separate from sampled load.");
        var memory = result["memoryModules"]![0]!;
        Check(Number(memory, "capacityBytes") == 17179869184 && Number(memory, "configuredClockMhz") == 4800 && Number(memory, "speedMhz") == 5600 && memory["memoryType"]!.GetValue<string>() == "DDR5" && memory["formFactor"]!.GetValue<string>() == "DIMM", "RAM bytes, supported/configured speed, SMBIOS type and form factor keep their units.");
        Check(Number(result["memoryArray"], "slots") == 4 && result["memoryArray"]!["maxCapacityBytes"] is null, "real slot count is summed independently of installed modules; unverified maximum remains null.");
        var disk = result["disks"]![0]!;
        Check(Number(disk, "sizeBytes") == 2000398934016 && disk["busType"]!.GetValue<string>() == "NVMe" && disk["mediaType"]!.GetValue<string>() == "SSD" && disk["healthStatus"]!.GetValue<string>() == "healthy", "Storage WMI's NVMe, media and explicit zero health enum are decoded.");
        Check(result["system"]!["uuid"]!.GetValue<string>() == "12345678-1234-1234-1234-123456789012" && Number(result["networkAdapters"]![0], "speedMbps") == 2500, "system identity and adapter bits/s are normalized without misreporting Mbps.");
        Check(result["baseboard"]!["product"]!.GetValue<string>() == "Test Board" && result["baseboard"]!["manufacturer"]!.GetValue<string>() == "Board Vendor", "mainboard identity is read from the hosting board without guessing the computer model.");
        provider.Rows["Win32_NetworkAdapter"].AddRange([Row(("DeviceID", "root-vpn"), ("PNPDeviceID", @"ROOT\VPN\1"), ("PhysicalAdapter", true)), Row(("DeviceID", "swd-vpn"), ("PNPDeviceID", @"swd\WINTUN\1"), ("PhysicalAdapter", true)), Row(("DeviceID", "bluetooth"), ("PNPDeviceID", @"BTH\MS_BTHPAN\1"), ("PhysicalAdapter", true))]);
        var adapterRows = inventory.Collect()["hardware"]!["networkAdapters"]!.AsArray();
        Check(adapterRows.Count == 2 && adapterRows[1]!["id"]!.GetValue<string>().Contains(@"BTH\MS_BTHPAN"), "explicit ROOT/SWD software VPNs are excluded even with physical=true, while bus-enumerated Bluetooth remains.");

        var sparse = new FakeProvider();
        sparse.Rows["Win32_Processor"] = [Row(("DeviceID", "cpu0"), ("NumberOfCores", 0), ("NumberOfLogicalProcessors", -1), ("MaxClockSpeed", double.NaN))];
        sparse.Rows["Win32_PhysicalMemory"] = [Row(("Tag", "slot0"), ("Capacity", ulong.MaxValue), ("Speed", 0), ("ConfiguredClockSpeed", "bad"), ("SMBIOSMemoryType", 0), ("FormFactor", 0), ("Manufacturer", "To be filled by O.E.M."), ("SerialNumber", "Unknown"))];
        sparse.Rows["MSFT_PhysicalDisk"] = [Row(("DeviceId", "0"), ("BusType", 0), ("MediaType", 0))];
        sparse.Rows["Win32_NetworkAdapter"] = [Row(("DeviceID", "0"), ("Speed", ulong.MaxValue))];
        sparse.Rows["Win32_ComputerSystemProduct"] = [Row(("UUID", "00000000-0000-0000-0000-000000000000"))];
        result = new NativeHardwareInventory(sparse.Query, () => at).Collect()["hardware"]!.AsObject();
        Check(result["complete"]!.GetValue<bool>() && result["cpus"]![0]!["cores"] is null && result["cpus"]![0]!["threads"] is null && result["cpus"]![0]!["maxClockMhz"] is null, "unknown zero, negative and nonfinite firmware values do not invent CPU hardware.");
        foreach (var field in new[] { "capacityBytes", "speedMhz", "configuredClockMhz", "memoryType", "formFactor", "manufacturer", "serialNumber" }) Check(result["memoryModules"]![0]![field] is null, "unknown RAM field remains null: " + field);
        foreach (var field in new[] { "sizeBytes", "busType", "mediaType", "healthStatus", "firmwareVersion" }) Check(result["disks"]![0]![field] is null, "missing disk field never becomes measured zero/healthy: " + field);
        Check(result["system"]!["uuid"] is null && result["networkAdapters"]![0]!["speedMbps"] is null && result["networkAdapters"]![0]!["physicalAdapter"] is null, "placeholder UUID, unbounded speed and missing physical flag stay unavailable.");
        sparse.Rows["MSFT_PhysicalDisk"] = [Row(("DeviceId", "0"), ("HealthStatus", 5)), Row(("DeviceId", "1"), ("HealthStatus", 1)), Row(("DeviceId", "2"), ("HealthStatus", 2)), Row(("DeviceId", "3"), ("HealthStatus", 99))];
        result = new NativeHardwareInventory(sparse.Query, () => at).Collect()["hardware"]!.AsObject();
        Check(result["disks"]![0]!["healthStatus"]!.GetValue<string>() == "unknown" && result["disks"]![1]!["healthStatus"]!.GetValue<string>() == "warning" && result["disks"]![2]!["healthStatus"]!.GetValue<string>() == "unhealthy" && result["disks"]![3]!["healthStatus"] is null, "Storage health enums retain unknown/warning/unhealthy and reject unmapped codes.");

        var partial = new FakeProvider { FailClass = "Win32_PhysicalMemory" };
        result = new NativeHardwareInventory(partial.Query, () => at).Collect()["hardware"]!.AsObject();
        Check(!result["complete"]!.GetValue<bool>() && !result.ContainsKey("memoryModules") && result["cpus"]!.AsArray().Count == 1 && result["disks"]!.AsArray().Count == 1 && result["bios"] is not null, "failure in one WMI category preserves every healthy independent category.");
        Check(!result.ToJsonString().Contains("private-provider-message"), "provider exception content cannot leak to hardware/heartbeat diagnostics.");
        partial.FailClass = "MSFT_PhysicalDisk";
        result = new NativeHardwareInventory(partial.Query, () => at).Collect()["hardware"]!.AsObject();
        Check(!result["complete"]!.GetValue<bool>() && result["disks"]![0]!["model"]!.GetValue<string>() == "Fallback Disk" && result["disks"]![0]!["healthStatus"] is null && result["disks"]![0]!["mediaType"] is null && result["disks"]![0]!["busType"]!.GetValue<string>() == "SCSI", "fallback never treats Win32 Status=OK as storage health nor guesses NVMe/SSD behind SCSI.");
        partial.FailClass = "Win32_ComputerSystemProduct";
        result = new NativeHardwareInventory(partial.Query, () => at).Collect()["hardware"]!.AsObject();
        Check(result["system"]!["model"]!.GetValue<string>() == "Test Model" && result["system"]!["uuid"] is null && !result["complete"]!.GetValue<bool>(), "product UUID failure cannot erase readable system metadata.");
        partial.FailClass = "Win32_BaseBoard";
        result = new NativeHardwareInventory(partial.Query, () => at).Collect()["hardware"]!.AsObject();
        Check(!result.ContainsKey("baseboard") && result["bios"] is not null && !result["complete"]!.GetValue<bool>(), "mainboard provider failure preserves BIOS while recording incomplete hardware.");

        var bounded = new FakeProvider();
        bounded.Rows["Win32_Processor"] = Enumerable.Range(0, 65).Select(index => Row(("DeviceID", "CPU" + index), ("Name", new string('x', 300)))).ToList();
        bounded.Rows["Win32_PhysicalMemory"] = [Row(("Tag", new string('a', 300) + "1")), Row(("Tag", new string('a', 300) + "2"))];
        result = new NativeHardwareInventory(bounded.Query, () => at).Collect()["hardware"]!.AsObject();
        Check(result["cpus"]!.AsArray().Count == 64 && result["cpus"]![0]!["name"]!.GetValue<string>().Length == 256 && !result["complete"]!.GetValue<bool>(), "inventory caps produce explicit incomplete state instead of an oversized heartbeat.");
        Check(result["memoryModules"]![0]!["id"]!.GetValue<string>() != result["memoryModules"]![1]!["id"]!.GetValue<string>() && result["memoryModules"]![0]!["id"]!.GetValue<string>().Length <= 128, "long identities hash the original value rather than collapsing at the display-text boundary.");
        bounded.Rows["Win32_Processor"] = [Row(("DeviceID", "CPU0")), Row(("DeviceID", "CPU0"))];
        result = new NativeHardwareInventory(bounded.Query, () => at).Collect()["hardware"]!.AsObject();
        Check(result["cpus"]!.AsArray().Count == 1 && !result["complete"]!.GetValue<bool>(), "duplicate physical identities cannot become duplicate UI devices.");
        var lateAt = at; var late = new FakeProvider { BeforeQuery = () => lateAt = at.AddMinutes(3) };
        Check(new NativeHardwareInventory(late.Query, () => lateAt).Collect()["hardware"]!["collectedAt"]!.GetValue<string>() == at.ToString("O"), "late provider response does not fabricate a new capture timestamp.");

        int calls = 0; var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var hung = new TelemetryCollectorSlot("Hardware", TimeSpan.FromSeconds(NativeHardwareInventory.IntervalSeconds), TimeSpan.FromSeconds(NativeHardwareInventory.DeadlineSeconds), () => { Interlocked.Increment(ref calls); entered.SetResult(); release.Task.GetAwaiter().GetResult(); return inventory.Collect(); });
        hung.StartIfDue(at); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        for (int index = 1; index < 20; index++) { hung.RequestRefresh(); hung.StartIfDue(at.AddSeconds(index * 900)); }
        Check(calls == 1 && hung.Read(at.AddSeconds(26)).Value is null && hung.Read(at.AddSeconds(26)).Error is not null, "hung WMI remains one dedicated worker and a nonblocking heartbeat read, even with manual refresh requests.");
        release.SetResult(); await hung.CurrentTask!;
        Check(hung.Read(at.AddSeconds(27)).Value?["hardware"] is not null && hung.Read(at.AddSeconds(1850)).Value is null, "recovered physical inventory is published and expired instead of labeled fresh indefinitely.");
        int cachedCalls = 0;
        var cached = new TelemetryCollectorSlot("Hardware", TimeSpan.FromSeconds(NativeHardwareInventory.IntervalSeconds), TimeSpan.FromSeconds(NativeHardwareInventory.DeadlineSeconds), () => { cachedCalls++; return inventory.Collect(); });
        cached.StartIfDue(at); await cached.CurrentTask!; _ = cached.Read(at);
        for (int index = 1; index < 30; index++) cached.StartIfDue(at.AddSeconds(index * 30));
        Check(cachedCalls == 1, "29 normal 30-second heartbeats reuse static hardware rather than requerying WMI.");
        Console.WriteLine("PASS native hardware inventory: CPU/RAM/storage/BIOS/NIC units, nullable unknowns, partial failures, bounded IDs, single-flight timeouts and 15-minute cache.");
    }

    private sealed class FakeProvider
    {
        internal string? FailClass;
        internal Action? BeforeQuery;
        internal int Calls;
        internal readonly List<TimeSpan> Timeouts = [];
        internal readonly Dictionary<string, List<Dictionary<string, object?>>> Rows = new()
        {
            ["Win32_Processor"] = [Row(("DeviceID", "CPU0"), ("Name", " Test CPU "), ("Manufacturer", "Test Vendor"), ("NumberOfCores", 8), ("NumberOfLogicalProcessors", 16), ("MaxClockSpeed", 4800), ("SocketDesignation", "SOCKET 0"))],
            ["Win32_PhysicalMemory"] = [Row(("Tag", "Physical Memory 0"), ("DeviceLocator", "DIMM A1"), ("BankLabel", "BANK 0"), ("Capacity", 17179869184UL), ("Speed", 5600), ("ConfiguredClockSpeed", 4800), ("FormFactor", 8), ("SMBIOSMemoryType", 34))],
            ["Win32_PhysicalMemoryArray"] = [Row(("MemoryDevices", 2)), Row(("MemoryDevices", 2))],
            ["MSFT_PhysicalDisk"] = [Row(("DeviceId", "0"), ("UniqueId", "disk0"), ("Model", "Test NVMe"), ("Size", 2000398934016UL), ("BusType", 17), ("MediaType", 4), ("HealthStatus", 0), ("FirmwareVersion", "1.2.3"))],
            ["Win32_DiskDrive"] = [Row(("DeviceID", @"\\.\PHYSICALDRIVE0"), ("Model", "Fallback Disk"), ("Size", 1000000000UL), ("InterfaceType", "SCSI"), ("Status", "OK"))],
            ["Win32_ComputerSystem"] = [Row(("Manufacturer", "Test Manufacturer"), ("Model", "Test Model"), ("SystemType", "x64-based PC"))],
            ["Win32_ComputerSystemProduct"] = [Row(("UUID", "12345678-1234-1234-1234-123456789012"))],
            ["Win32_BIOS"] = [Row(("Manufacturer", "Test BIOS"), ("Name", "UEFI"), ("SMBIOSBIOSVersion", "2.3.4"))],
            ["Win32_BaseBoard"] = [Row(("Manufacturer", "Board Vendor"), ("Product", "Test Board"), ("Version", "1.2.3"))],
            ["Win32_NetworkAdapter"] = [Row(("DeviceID", "1"), ("PNPDeviceID", @"PCI\VEN_ABCD&DEV_1234\1"), ("Name", "Test Ethernet"), ("Speed", 2500000000UL), ("PhysicalAdapter", true))]
        };
        internal List<Dictionary<string, object?>> Query(string ns, string wql, int maximum, TimeSpan timeout)
        {
            Calls++; Timeouts.Add(timeout); BeforeQuery?.Invoke(); string name = wql.Split(" FROM ", StringSplitOptions.None)[1].Split(' ')[0];
            Check(ns == (name == "MSFT_PhysicalDisk" ? @"root\Microsoft\Windows\Storage" : @"root\cimv2") && wql.StartsWith("SELECT ") && maximum <= 513, "providers use bounded read-only WQL in the correct namespace.");
            if (name == FailClass) throw new InvalidOperationException("private-provider-message");
            return Rows[name].Take(maximum).ToList();
        }
    }
}
