using System.Diagnostics;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// --drivers-self-test: simulated CfgMgr32 device rows, service image paths and
// INF signature checks: problem devices without their device ID, the
// service → file join, missing values and FILETIME dates, the 2000-item and
// byte limits, the signature cache and its time budget, the timing line, the
// checksum (same value as tests/support/driver-checksum-fixture.mjs) and the
// upload decision.
internal static class NativeDriverInventoryTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Driver inventory regression: " + message); }
    internal static int RunSelfTest() { try { Run(); Console.WriteLine("Driver inventory self-test passed."); return 0; } catch (Exception error) { Console.Error.WriteLine(error); return 1; } }

    private sealed class FakeSource(List<DriverDevice> devices, Dictionary<string, string> images, Dictionary<string, (long Size, DateTime LastWriteUtc)> infs, Func<string, (string, string?)>? signature = null, Action? onCheck = null) : IDriverSource
    {
        internal int Checks;
        internal readonly List<string> Checked = [];
        internal List<DriverDevice> Rows = devices;
        internal Dictionary<string, (long Size, DateTime LastWriteUtc)> Infs = infs;
        public IReadOnlyList<DriverDevice> Devices() => Rows;
        public string? ServiceImagePath(string service) => images.GetValueOrDefault(service);
        public (long Size, DateTime LastWriteUtc)? InfFile(string infName) => Infs.TryGetValue(infName, out var file) ? file : null;
        public (string Signature, string? Signer) InfSignature(string infName) { Checks++; Checked.Add(infName); onCheck?.Invoke(); return signature?.Invoke(infName) ?? ("unknown", null); }
    }

    private static long FileTime(int year, int month, int day) => new DateTime(year, month, day, 0, 0, 0, DateTimeKind.Utc).ToFileTimeUtc();

    private static void Run()
    {
        const string joystick = @"HID\VID_1234&PID_BEAD\7&2A1B3C4D&0&0000", gpu = @"PCI\VEN_10DE&DEV_2204&SUBSYS_00000000&REV_A1\4&1234", missing = @"ROOT\UNKNOWN\0000", disabled = @"USB\VID_0BDA&PID_8153\000001", bridge = @"ACPI\PNP0A03\0", software = @"SWD\NO_DRIVER\1";
        var stamp = new DateTime(2026, 10, 1, 8, 0, 0, DateTimeKind.Utc);
        var devices = new List<DriverDevice>
        {
            new(joystick, 0, "vJoy Device", "HIDClass", "Shaul Eizikovich", "vjoy", "oem42.inf", "2.1.9.1", FileTime(2019, 11, 20), "Shaul Eizikovich"),
            new(gpu, 43, "NVIDIA GeForce RTX 3090", "Display", "NVIDIA", "nvlddmkm", "oem12.inf", "31.0.15.3623", FileTime(2023, 6, 12), "NVIDIA"),
            new(missing, 28, null, null, null, null, null, null, null, null),
            new(disabled, 22, "Realtek USB GbE", "Net", "Realtek", "rtux64w10", "rtux64w10.inf", "10.50.0.0", FileTime(1979, 12, 31), "Realtek"),
            new(bridge, 0, null, null, null, null, null, "10.0.1", long.MaxValue, null),
            new(software, 0, "Software device", "SoftwareDevice", null, null, null, null, null, null),
        };
        var images = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["vjoy"] = @"\SystemRoot\System32\drivers\vjoy.sys", ["nvlddmkm"] = @"C:\Windows\System32\DriverStore\FileRepository\nv_dispi.inf_amd64\nvlddmkm.sys" };
        var infs = new Dictionary<string, (long, DateTime)>(StringComparer.OrdinalIgnoreCase) { ["oem42.inf"] = (4096, stamp), ["oem12.inf"] = (8192, stamp) };
        var source = new FakeSource(devices, images, infs, inf => inf == "oem12.inf" ? ("valid", "Microsoft Windows Hardware Compatibility Publisher") : ("unsigned", null));
        var at = DateTimeOffset.Parse("2026-10-20T12:00:00Z");
        var inventory = new NativeDriverInventory(source, () => at);
        var collected = inventory.Collect();
        var health = collected["driverHealth"]!.AsObject();
        var problems = health["problems"]!.AsArray();
        Check(problems.Count == 3 && problems.Select(p => p!["code"]!.GetValue<int>()).Order().SequenceEqual(new[] { 22, 28, 43 }), "three problem devices with codes 22, 28 and 43.");
        Check(problems.Any(p => p!["name"]!.GetValue<string>() == "Unknown device" && p["class"] is null && p["manufacturer"] is null), "a problem without a name is an unknown device; missing class and manufacturer are null.");
        Check(problems.Any(p => p!["name"]!.GetValue<string>() == "Realtek USB GbE" && p["class"]!.GetValue<string>() == "Net"), "the problem class stays as Device Manager reports it.");
        Check(problems.All(p => p!["key"]!.GetValue<string>().Length == 16 && p["key"]!.GetValue<string>().All(Uri.IsHexDigit)), "problem keys are 16 hex characters.");
        Check(problems.Any(p => p!["key"]!.GetValue<string>() == NativeDriverInventory.DeviceKey(gpu)) && NativeDriverInventory.DeviceKey(gpu) == NativeDriverInventory.DeviceKey(gpu.ToLowerInvariant()), "the key is the hash of the device instance ID, case-insensitive.");
        Check(!health["problemsTruncated"]!.GetValue<bool>(), "few problems are complete.");
        var list = collected[NativeDriverInventory.InventoryKey]!.AsObject();
        var items = list["items"]!.AsArray().Select(item => item!.AsObject()).ToList();
        Check(items.Count == 4 && list["count"]!.GetValue<int>() == 4 && !list["truncated"]!.GetValue<bool>(), "devices without INF name and version are skipped.");
        Check(items.Select(item => item["key"]!.GetValue<string>()).Order(StringComparer.Ordinal).SequenceEqual(new[] { joystick, gpu, disabled, bridge }.Select(NativeDriverInventory.DeviceKey).Order(StringComparer.Ordinal)), "the driver keys are DeviceKey of the instance ID, as in 4.11.0.");
        var vjoy = items.Single(item => item["infName"]?.GetValue<string>() == "oem42.inf");
        Check(vjoy["file"]!.GetValue<string>() == "vjoy.sys" && vjoy["service"]!.GetValue<string>() == "vjoy" && vjoy["date"]!.GetValue<string>() == "2019-11-20" && vjoy["signed"]!.GetValue<bool>() == false && vjoy["signer"] is null, "service → file join, FILETIME date and unsigned.");
        Check(vjoy["deviceClass"]!.GetValue<string>() == "HIDCLASS" && vjoy["provider"]!.GetValue<string>() == "Shaul Eizikovich" && vjoy["version"]!.GetValue<string>() == "2.1.9.1", "the driver class is upper case; provider and version.");
        var nvidia = items.Single(item => item["infName"]?.GetValue<string>() == "oem12.inf");
        Check(nvidia["file"]!.GetValue<string>() == "nvlddmkm.sys" && nvidia["signed"]!.GetValue<bool>() && nvidia["signer"]!.GetValue<string>() == "Microsoft Windows Hardware Compatibility Publisher" && nvidia["date"]!.GetValue<string>() == "2023-06-12", "the file is the plain name of the image path; a valid signature names its signer.");
        var realtek = items.Single(item => item["infName"]?.GetValue<string>() == "rtux64w10.inf");
        Check(realtek["deviceClass"]!.GetValue<string>() == "NET" && realtek["file"] is null && realtek["date"] is null && realtek["signed"] is null && realtek["signer"] is null, "a service without ImagePath, a date before 1980 and a missing INF file are null.");
        var sparse = items.Single(item => item["infName"] is null);
        Check(sparse["deviceName"]!.GetValue<string>() == "Unknown device" && sparse["date"] is null && sparse["signed"] is null && sparse["file"] is null && sparse["service"] is null && sparse["deviceClass"] is null, "missing values and an invalid FILETIME are null.");
        Check(health["unsignedCount"]!.GetValue<int>() == 1 && health["unsigned"]!.AsArray().Single()!["file"]!.GetValue<string>() == "vjoy.sys", "the unsigned summary.");
        Check(health["checksum"]!.GetValue<string>() == list["checksum"]!.GetValue<string>() && health["collectedAt"]!.GetValue<string>() == at.ToString("O"), "the snapshot and the list share the checksum; collectedAt is the collection time.");
        Check(source.Checks == 2 && inventory.LastRun is { Drivers: 4, Devices: 6, Pending: 0 }, "two INF files checked, none left over.");
        string json = collected.ToJsonString();
        foreach (string forbidden in new[] { joystick, gpu, missing, disabled, bridge, "VID_1234", "PNPDeviceID", "DeviceID\"", "\"id\"" })
            Check(!json.Contains(forbidden.Replace(@"\", @"\\"), StringComparison.OrdinalIgnoreCase) && !json.Contains(forbidden, StringComparison.OrdinalIgnoreCase), "no device ID leaves the device: " + forbidden);
        Check(NativeDriverInventory.FileName(@"""C:\Program Files\x\drv.sys""") == "drv.sys" && NativeDriverInventory.FileName("") is null && NativeDriverInventory.FileName(@"C:\") is null, "file names from image paths.");
        Check(NativeDriverInventory.DriverDate(FileTime(2100, 12, 31)) == "2100-12-31" && NativeDriverInventory.DriverDate(FileTime(2101, 1, 1)) is null && NativeDriverInventory.DriverDate(FileTime(1980, 1, 1)) == "1980-01-01" && NativeDriverInventory.DriverDate(0) is null && NativeDriverInventory.DriverDate(-5) is null && NativeDriverInventory.DriverDate(null) is null, "FILETIME dates between 1980 and 2100 only.");
        Check(NativeDriverInventory.IsInfName("oem42.inf") && !NativeDriverInventory.IsInfName(@"..\oem42.inf") && !NativeDriverInventory.IsInfName("C:oem.inf") && !NativeDriverInventory.IsInfName("driver.sys") && !NativeDriverInventory.IsInfName(null), "only plain INF names are read from the INF folder.");

        Signatures(stamp);
        Budget(stamp);
        Timing(stamp);

        // ---- 300 devices in under 2 seconds (no INF budget limit) ----
        var many = Enumerable.Range(0, 300).Select(i => new DriverDevice(@"PCI\VEN_8086&DEV_" + i.ToString("X4") + @"\3&11583659&0&" + i, i % 50 == 0 ? 10 : 0, "Device " + i, "System", "Intel", "svc" + (i % 40), "oem" + (i % 120) + ".inf", "10.1." + i, FileTime(2024, 1, 1), "Intel")).ToList();
        var manyInfs = Enumerable.Range(0, 120).ToDictionary(i => "oem" + i + ".inf", _ => (2048L, stamp), StringComparer.OrdinalIgnoreCase);
        var manyImages = Enumerable.Range(0, 40).ToDictionary(i => "svc" + i, i => @"\SystemRoot\System32\drivers\svc" + i + ".sys", StringComparer.OrdinalIgnoreCase);
        var fast = new NativeDriverInventory(new FakeSource(many, manyImages, manyInfs, _ => ("valid", "Microsoft Windows")), () => at, signatureBudget: TimeSpan.FromDays(1));
        var watch = Stopwatch.StartNew();
        var fastResult = fast.Collect();
        Check(watch.Elapsed < TimeSpan.FromSeconds(2) && fastResult[NativeDriverInventory.InventoryKey]!["count"]!.GetValue<int>() == 300 && fastResult["driverHealth"]!["problems"]!.AsArray().Count == 6, "300 devices collect in under 2 s: " + watch.ElapsedMilliseconds + " ms.");

        // ---- Budgets ----
        Check(NativeDriverInventory.DeadlineSeconds == 45 && NativeDriverInventory.SignatureBudgetSeconds == 20 && NativeDriverInventory.BrokerCallSeconds == 60 && NativeDriverInventory.SignatureBudgetSeconds < NativeDriverInventory.DeadlineSeconds, "the driver budgets: 20 s signatures, 45 s deadline, 60 s broker call.");

        // ---- Limits ----
        var limited2500 = Enumerable.Range(0, 2500).Select(i => new DriverDevice(@"ROOT\DEV\" + i, 0, "Device " + i, null, null, null, "oem" + i + ".inf", "1.0." + i, null, null)).ToList();
        var (limited, count, truncated) = NativeDriverInventory.Inventory(limited2500);
        Check(limited.Count == 2000 && count == 2500 && truncated, "2500 drivers: 2000 items, count 2500, truncated.");
        Check(limited.Select(item => item.Key).SequenceEqual(limited.Select(item => item.Key).Order(StringComparer.Ordinal)), "the list is sorted by key.");
        string longInf = new('i', 256);
        var large = Enumerable.Range(0, 2000).Select(i => new DriverDevice(@"ROOT\BIG\" + i, 0, new string('n', 256), new string('c', 256), null, null, longInf, new string('v', 256), null, new string('p', 256))).ToList();
        (limited, count, truncated) = NativeDriverInventory.Inventory(large, null, new Dictionary<string, (bool?, string?)>(StringComparer.OrdinalIgnoreCase) { [longInf] = (true, new string('s', 256)) });
        Check(limited.Count < 2000 && count == 2000 && truncated, "a list above the byte budget is cut and marked truncated.");
        var problemRows = Enumerable.Range(0, 150).Select(i => new DriverDevice(@"ROOT\BROKEN\" + i, 10, "Broken " + i.ToString("D3"), null, null, null, null, null, null, null)).ToList();
        var problemHealth = new NativeDriverInventory(new FakeSource(problemRows, [], []), () => at).Collect()["driverHealth"]!;
        Check(problemHealth["problems"]!.AsArray().Count == 100 && problemHealth["problemsTruncated"]!.GetValue<bool>(), "150 problem devices: 100 and problemsTruncated.");

        // ---- Checksum ----
        // Same items and value as tests/support/driver-checksum-fixture.mjs (lib/driver-inventory.ts).
        var fixture = new List<DriverEntry>
        {
            new("0f1e2d3c4b5a6978", "vJoy Device", "HIDClass", "oem42.inf", "vjoy.sys", "vjoy", "Shaul Eizikovich", "2.1.9.1", "2019-11-20", false, null),
            new("00a1b2c3d4e5f607", "Intel(R) Ethernet Connection \"I219-LM\"", "Net", "oem7.inf", "e1d68x64.sys", "e1dexpress", "Intel", "12.19.2.45", "2023-04-12", true, "Microsoft Windows Hardware Compatibility Publisher"),
            new("ffeeddccbbaa9988", "Gerät \\ Müller ✓ 😀", null, null, null, null, null, "1.0", null, null, null),
        };
        const string expected = "70bbda527642a6f653812e744083182efce18b931ea6d076cd4d8aa61f85081e";
        Check(NativeDriverInventory.Checksum(fixture) == expected, "the checksum equals the portal's value for the shared fixture: " + NativeDriverInventory.Checksum(fixture));
        Check(NativeDriverInventory.Checksum(Enumerable.Reverse(fixture)) == expected, "the checksum does not depend on the input order.");
        Check(NativeDriverInventory.Checksum([fixture[0] with { Signed = true }, fixture[1], fixture[2]]) != expected, "a signature change changes the checksum.");

        // ---- Upload decision (the shared SoftwareUploadPolicy) ----
        var policy = new SoftwareUploadPolicy();
        Check(!policy.ShouldUpload(null, at) && policy.ShouldUpload("aaa", at), "nothing before the first collection; a new checksum is sent.");
        policy.Succeeded("aaa", at);
        Check(!policy.ShouldUpload("aaa", at.AddMinutes(5)), "unchanged: no upload.");
        Check(!policy.ShouldUpload("bbb", at.AddSeconds(30)) && policy.ShouldUpload("bbb", at.AddSeconds(61)), "changed: upload, at most once per 60 s.");
        policy.Heartbeat("aaa", true);
        Check(policy.ShouldUpload("aaa", at.AddMinutes(2)), "driverResync: upload the same list again.");
    }

    // valid / invalid / unsigned / unknown, the cache by (name, size, mtime) and the missing file.
    private static void Signatures(DateTime stamp)
    {
        var results = new Dictionary<string, (string, string?)> { ["valid.inf"] = ("valid", "Microsoft Windows"), ["invalid.inf"] = ("invalid", "Tampered Corp"), ["unsigned.inf"] = ("unsigned", null), ["unknown.inf"] = ("unknown", null) };
        var devices = results.Keys.Concat(["gone.inf"]).Select((inf, i) => new DriverDevice(@"ROOT\SIGNED\" + i, 0, "Device " + i, "System", null, null, inf, "1.0", null, null)).ToList();
        var infs = results.Keys.ToDictionary(inf => inf, _ => (1024L, stamp), StringComparer.OrdinalIgnoreCase);
        var source = new FakeSource(devices, [], infs, inf => results[inf]);
        var inventory = new NativeDriverInventory(source);
        Dictionary<string, (bool? Signed, string? Signer)> Read() => inventory.Collect()[NativeDriverInventory.InventoryKey]!["items"]!.AsArray().ToDictionary(item => item!["infName"]!.GetValue<string>(), item => (item!["signed"]?.GetValue<bool>(), item["signer"]?.GetValue<string>()));
        var first = Read();
        Check(first["valid.inf"] == (true, "Microsoft Windows") && first["invalid.inf"] == (false, null) && first["unsigned.inf"] == (false, null) && first["unknown.inf"] == (null, null) && first["gone.inf"] == (null, null), "valid → true with the signer, invalid and unsigned → false without a signer, unknown and a missing INF → null.");
        Check(source.Checks == 4 && !source.Checked.Contains("gone.inf"), "a missing INF file is not checked.");
        var second = Read();
        Check(source.Checks == 5 && source.Checked[^1] == "unknown.inf" && second.SequenceEqual(first), "a second run makes no new checks for unchanged INF files (unknown is checked again).");
        source.Infs["valid.inf"] = (1024L, stamp.AddMinutes(1));
        Read();
        Check(source.Checks == 7 && source.Checked.Contains("valid.inf") && source.Checked.Count(name => name == "valid.inf") == 2, "a changed last write time checks the INF again.");
        source.Infs["invalid.inf"] = (2048L, stamp);
        Read();
        Check(source.Checked.Count(name => name == "invalid.inf") == 2, "a changed size checks the INF again.");
        Check(inventory.CachedSignatures <= NativeDriverInventory.SignatureCacheSize && NativeDriverInventory.SignatureCacheSize == 4000, "the cache holds at most 4000 entries.");
        Check(NativeDriverInventory.SignatureValue("valid", "  ") == (true, null) && NativeDriverInventory.SignatureValue("something", "x") == (null, null), "signature mapping edge cases.");
    }

    // A check that takes 1 s with a 3 s budget: the rest stays null and is checked first in the next run.
    private static void Budget(DateTime stamp)
    {
        long clock = 0;
        var names = Enumerable.Range(0, 10).Select(i => "inf" + i.ToString("D2") + ".inf").ToList();
        var devices = names.Select((inf, i) => new DriverDevice(@"ROOT\BUDGET\" + i, 0, "Device " + i, "System", null, null, inf, "1.0", null, null)).ToList();
        var infs = names.ToDictionary(inf => inf, _ => (512L, stamp), StringComparer.OrdinalIgnoreCase);
        var source = new FakeSource(devices, [], infs, _ => ("valid", "Microsoft Windows"), () => clock += 1000);
        var inventory = new NativeDriverInventory(source, milliseconds: () => clock, signatureBudget: TimeSpan.FromSeconds(3));
        var items = inventory.Collect()[NativeDriverInventory.InventoryKey]!["items"]!.AsArray();
        int signedCount = items.Count(item => item!["signed"]?.GetValue<bool>() == true);
        Check(source.Checks == 3 && signedCount == 3 && items.Count(item => item!["signed"] is null) == 7 && inventory.LastRun is { Pending: 7, SignaturesMs: <= 3000 }, "three checks fit the 3 s budget; seven INF files stay null.");
        // A new INF that sorts first waits behind the files left over by the last run.
        source.Rows = [.. devices, new DriverDevice(@"ROOT\BUDGET\new", 0, "New device", "System", null, null, "aaa.inf", "1.0", null, null)];
        source.Infs["aaa.inf"] = (512L, stamp);
        inventory.Collect();
        Check(source.Checked.Skip(3).SequenceEqual(new[] { "inf03.inf", "inf04.inf", "inf05.inf" }) && inventory.LastRun!.Pending == 5, "the files left over are checked first in the next run.");
        for (int run = 0; run < 3; run++) inventory.Collect();
        Check(inventory.LastRun!.Pending == 0 && source.Checks == 11, "the list completes over several runs.");
    }

    // The broker's timing line: the first run after the start and every slow run.
    private static void Timing(DateTime stamp)
    {
        long clock = 0;
        var devices = new List<DriverDevice> { new(@"ROOT\TIMING\0", 0, "Device", "System", null, "svc", "slow.inf", "1.0", null, null) };
        var source = new FakeSource(devices, new() { ["svc"] = "svc.sys" }, new(StringComparer.OrdinalIgnoreCase) { ["slow.inf"] = (100L, stamp) }, _ => ("valid", "Microsoft Windows"), () => clock += 6000);
        var inventory = new NativeDriverInventory(source, milliseconds: () => clock, signatureBudget: TimeSpan.FromSeconds(20));
        Check(inventory.TimingLogLine() is null, "no timing line before the first run.");
        inventory.Collect();
        string? line = inventory.TimingLogLine();
        Check(line == "Broker telemetry Drivers: 1 drivers, 1 devices in 6000 ms (devices 0 ms, services 0 ms, signatures 6000 ms, 0 INF files not checked yet).", "the timing line names drivers, devices and the parts: " + line);
        inventory.Collect();
        Check(inventory.TimingLogLine() is null, "a fast run (all cached) after the first logs nothing.");
        source.Infs["slow.inf"] = (101L, stamp);
        inventory.Collect();
        Check(inventory.TimingLogLine() is string slow && slow.Contains("in 6000 ms"), "a run above 5 s logs again.");
    }
}
