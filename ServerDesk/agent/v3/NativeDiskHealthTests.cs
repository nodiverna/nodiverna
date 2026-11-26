using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// --disk-health-self-test: simulated MSFT_PhysicalDisk rows with full, partial
// and missing reliability counters, health and operational status, drive
// letters, disk events with and without a disk number, and batteries with and
// without a cycle count, a design capacity of 0, no battery and no namespace.
internal static class NativeDiskHealthTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Disk health regression: " + message); }
    internal static int RunSelfTest() { try { Run(); Console.WriteLine("Disk health self-test passed."); return 0; } catch (Exception error) { Console.Error.WriteLine(error); return 1; } }

    private sealed class FakeSource : IDiskHealthSource
    {
        internal List<Dictionary<string, object?>> Disks = [];
        internal Dictionary<string, Dictionary<string, object?>?> Counters = [];
        internal List<Dictionary<string, object?>> PartitionRows = [];
        internal List<DiskEventRecord> Events = [];
        internal Func<int> Count = () => 0;
        internal Func<(IReadOnlyList<Dictionary<string, object?>>, IReadOnlyList<Dictionary<string, object?>>, IReadOnlyList<Dictionary<string, object?>>?)> Battery = () => ([], [], null);
        public IReadOnlyList<Dictionary<string, object?>> PhysicalDisks() => Disks;
        public Dictionary<string, object?>? ReliabilityCounter(Dictionary<string, object?> disk) { string id = (string)disk["DeviceId"]!; return Counters.TryGetValue(id, out var value) ? value : throw new InvalidOperationException("No counter object."); }
        public IReadOnlyList<Dictionary<string, object?>> Partitions() => PartitionRows;
        public IReadOnlyList<DiskEventRecord> DiskEvents(DateTimeOffset since) => Events;
        public int BatteryCount() => Count();
        public (IReadOnlyList<Dictionary<string, object?>> Static, IReadOnlyList<Dictionary<string, object?>> Full, IReadOnlyList<Dictionary<string, object?>>? Cycles) Batteries() => Battery();
    }
    private static Dictionary<string, object?> Row(params (string Name, object? Value)[] values) => values.ToDictionary(v => v.Name, v => v.Value, StringComparer.OrdinalIgnoreCase);

    private static void Run()
    {
        var at = DateTimeOffset.Parse("2026-10-20T12:00:00Z");
        var source = new FakeSource();
        source.Disks.AddRange([
            Row(("DeviceId", "0"), ("Model", "Samsung SSD 980 PRO 1TB"), ("SerialNumber", "S5GXNX0T123456"), ("BusType", (ushort)17), ("MediaType", (ushort)4), ("HealthStatus", (ushort)0), ("OperationalStatus", new ushort[] { 2 })),
            Row(("DeviceId", "1"), ("Model", "WDC WD40EFRX"), ("BusType", (ushort)11), ("MediaType", (ushort)3), ("HealthStatus", (ushort)1), ("OperationalStatus", new ushort[] { 3, 5 })),
            Row(("DeviceId", "2"), ("Model", ""), ("FriendlyName", "SanDisk USB"), ("BusType", (ushort)7), ("MediaType", (ushort)0), ("HealthStatus", (ushort)5), ("OperationalStatus", new ushort[] { 2 })),
            Row(("DeviceId", "3"), ("Model", "Virtual Disk"), ("BusType", (ushort)14), ("MediaType", (ushort)0), ("HealthStatus", (ushort)2), ("OperationalStatus", new ushort[] { 6, 13, 999 })),
        ]);
        source.Counters["0"] = Row(("Wear", (byte)86), ("Temperature", (ushort)41), ("TemperatureMax", (ushort)70), ("ReadErrorsUncorrected", 0UL), ("PowerOnHours", 12345U));
        source.Counters["1"] = Row(("Wear", null), ("Temperature", (ushort)38), ("TemperatureMax", null), ("ReadErrorsUncorrected", 4UL), ("PowerOnHours", null));
        source.Counters["3"] = null;
        source.PartitionRows.AddRange([Row(("DiskNumber", 0u), ("DriveLetter", 'C')), Row(("DiskNumber", 0u), ("DriveLetter", '\0')), Row(("DiskNumber", 1u), ("DriveLetter", 'd')), Row(("DiskNumber", 1u), ("DriveLetter", 'E'))]);
        source.Events.AddRange([
            new(at.AddDays(-1), "disk", 7, [@"\Device\Harddisk1\DR1"]),
            new(at.AddDays(-2), "disk", 153, [@"\Device\Harddisk1\DR1", "0x123"]),
            new(at.AddDays(-3), "ntfs", 55, ["E:", @"\Device\HarddiskVolume5"]),
            new(at.AddDays(-4), "disk", 51, ["unknown device"]),
            new(at.AddDays(-5), "disk", 11, [@"\Device\Harddisk0\DR0"]),
            new(at.AddDays(-40), "disk", 7, [@"\Device\Harddisk0\DR0"]),
        ]);
        var collected = new NativeDiskHealth(source, () => at).Collect();
        var health = collected["diskHealth"]!.AsObject();
        var disks = health["disks"]!.AsArray().Select(disk => disk!.AsObject()).ToList();
        Check(disks.Count == 4, "four disks.");
        var ssd = disks[0];
        Check(ssd["number"]!.GetValue<int>() == 0 && ssd["model"]!.GetValue<string>() == "Samsung SSD 980 PRO 1TB" && ssd["busType"]!.GetValue<string>() == "NVMe" && ssd["mediaType"]!.GetValue<string>() == "ssd" && ssd["health"]!.GetValue<string>() == "healthy", "disk identity, bus, media and health.");
        Check(ssd["countersAvailable"]!.GetValue<bool>() && ssd["wearPercent"]!.GetValue<long>() == 86 && ssd["temperatureC"]!.GetValue<long>() == 41 && ssd["temperatureMaxC"]!.GetValue<long>() == 70 && ssd["readErrorsUncorrected"]!.GetValue<long>() == 0 && ssd["powerOnHours"]!.GetValue<long>() == 12345, "full counters.");
        Check(ssd["driveLetters"]!.AsArray().Select(l => l!.GetValue<string>()).SequenceEqual(new[] { "C:" }) && disks[1]["driveLetters"]!.AsArray().Select(l => l!.GetValue<string>()).SequenceEqual(new[] { "D:", "E:" }), "drive letters from the partitions.");
        var hdd = disks[1];
        Check(hdd["health"]!.GetValue<string>() == "warning" && hdd["operationalStatus"]!.AsArray().Select(s => s!.GetValue<string>()).SequenceEqual(new[] { "degraded", "predictive-failure" }), "health warning and operational status mapping.");
        Check(hdd["countersAvailable"]!.GetValue<bool>() && hdd["wearPercent"] is null && hdd["temperatureMaxC"] is null && hdd["powerOnHours"] is null && hdd["temperatureC"]!.GetValue<long>() == 38, "partial counters: a missing value is null, never 0.");
        var usb = disks[2];
        Check(usb["model"]!.GetValue<string>() == "SanDisk USB" && usb["health"]!.GetValue<string>() == "unknown" && !usb["countersAvailable"]!.GetValue<bool>() && usb["wearPercent"] is null && usb["temperatureC"] is null && usb["readErrorsUncorrected"] is null, "missing counter object (USB): all counters null.");
        Check(disks[3]["health"]!.GetValue<string>() == "unhealthy" && disks[3]["operationalStatus"]!.AsArray().Select(s => s!.GetValue<string>()).SequenceEqual(new[] { "failed", "lost-communication", "unknown" }) && !disks[3]["countersAvailable"]!.GetValue<bool>(), "unhealthy, failed, lost communication and unknown codes.");
        Check(!collected.ToJsonString().Contains("S5GXNX0T123456"), "no serial number leaves the device.");
        var events = health["events"]!.AsObject();
        var items = events["items"]!.AsArray();
        Check(items.Count == 4 && items[0]!["eventId"]!.GetValue<int>() == 7 && items[0]!["disk"]!.GetValue<int>() == 1 && items[0]!["source"]!.GetValue<string>() == "disk", "disk events 7, 153, 55 and 51 within 30 days; other IDs and older events are skipped.");
        Check(items[2]!["source"]!.GetValue<string>() == "ntfs" && items[2]!["volume"]!.GetValue<string>() == "E:" && items[2]!["disk"]!.GetValue<int>() == 1, "NTFS 55 names the volume; its drive letter gives the disk.");
        Check(items[3]!["disk"] is null, "an event without a disk number has disk null.");
        var counts = events["counts"]!.AsObject();
        Check(counts["1"]!.GetValue<int>() == 3 && counts["unknown"]!.GetValue<int>() == 1 && counts.Count == 2 && !events["truncated"]!.GetValue<bool>(), "counts per disk and unknown.");
        var flood = new FakeSource();
        flood.Events.AddRange(Enumerable.Range(0, 80).Select(i => new DiskEventRecord(at.AddMinutes(-i), "disk", 153, [@"\Device\Harddisk2\DR2"])));
        var floodEvents = new NativeDiskHealth(flood, () => at).Collect()["diskHealth"]!["events"]!;
        Check(floodEvents["items"]!.AsArray().Count == 50 && floodEvents["counts"]!["2"]!.GetValue<int>() == 80 && floodEvents["truncated"]!.GetValue<bool>(), "the newest 50 events; counts cover all events.");

        // ---- Battery ----
        var noBattery = collected["battery"]!.AsObject();
        Check(!noBattery["present"]!.GetValue<bool>() && noBattery["reason"]!.GetValue<string>() == "no-battery" && noBattery["batteries"]!.AsArray().Count == 0, "no Win32_Battery: present false, no-battery.");
        var laptop = new FakeSource { Count = () => 2 };
        laptop.Battery = () => (
            [Row(("InstanceName", "ACPI\\PNP0C0A\\1_0"), ("DesignedCapacity", 57000u), ("DeviceName", "DELL 7FHHV")), Row(("InstanceName", "ACPI\\PNP0C0A\\2_0"), ("DesignedCapacity", 0u), ("DeviceName", null))],
            [Row(("InstanceName", "ACPI\\PNP0C0A\\1_0"), ("FullChargedCapacity", 30780u)), Row(("InstanceName", "ACPI\\PNP0C0A\\2_0"), ("FullChargedCapacity", 1000u))],
            [Row(("InstanceName", "ACPI\\PNP0C0A\\1_0"), ("CycleCount", 412u))]);
        var battery = new NativeDiskHealth(laptop, () => at).Collect()["battery"]!.AsObject();
        var batteries = battery["batteries"]!.AsArray();
        Check(battery["present"]!.GetValue<bool>() && battery["reason"] is null && batteries.Count == 2, "two batteries.");
        Check(batteries[0]!["id"]!.GetValue<int>() == 0 && batteries[0]!["name"]!.GetValue<string>() == "DELL 7FHHV" && batteries[0]!["designCapacityMWh"]!.GetValue<long>() == 57000 && batteries[0]!["fullChargeCapacityMWh"]!.GetValue<long>() == 30780 && batteries[0]!["healthPercent"]!.GetValue<int>() == 54 && batteries[0]!["cycleCount"]!.GetValue<long>() == 412, "health percent and cycle count.");
        Check(batteries[1]!["healthPercent"] is null && batteries[1]!["cycleCount"] is null && batteries[1]!["name"] is null, "design capacity 0: health null; no cycle count.");
        var noCycles = new FakeSource { Count = () => 1, Battery = () => ([Row(("InstanceName", "B"), ("DesignedCapacity", 50000u))], [Row(("InstanceName", "B"), ("FullChargedCapacity", 52000u))], null) };
        var plain = new NativeDiskHealth(noCycles, () => at).Collect()["battery"]!["batteries"]![0]!;
        Check(plain["cycleCount"] is null && plain["healthPercent"]!.GetValue<int>() == 104, "without BatteryCycleCount the cycle count is null; above 100 % is kept.");
        var missing = new FakeSource { Count = () => 1, Battery = () => throw new BatteryUnavailableException("not-supported") };
        var unsupported = new NativeDiskHealth(missing, () => at).Collect()["battery"]!;
        Check(unsupported["present"]!.GetValue<bool>() && unsupported["reason"]!.GetValue<string>() == "not-supported" && unsupported["batteries"]!.AsArray().Count == 0, "root\\wmi missing: not-supported.");
        var noClass = new FakeSource { Count = () => throw new BatteryUnavailableException("not-supported") };
        Check(new NativeDiskHealth(noClass, () => at).Collect()["battery"]!["reason"]!.GetValue<string>() == "not-supported", "Win32_Battery missing: not-supported.");
    }
}
