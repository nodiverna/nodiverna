using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// --reliability-self-test: simulated Application events 1000/1002, failed
// installations and stability values; WMIEnable = 0 and empty metrics give
// "collection-disabled" without values while crashes still appear; a missing
// class and denied access.
internal static class NativeReliabilityTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Reliability regression: " + message); }
    internal static int RunSelfTest() { try { Run(); Console.WriteLine("Reliability self-test passed."); return 0; } catch (Exception error) { Console.Error.WriteLine(error); return 1; } }

    private sealed class FakeSource : IReliabilitySource
    {
        internal List<ProgramEvent> Events = [];
        internal bool Enabled = true;
        internal List<StabilityValue> Values = [];
        internal List<ProgramEvent> Installs = [];
        internal Exception? StabilityFailure;
        internal bool InstallsRead;
        public IReadOnlyList<ProgramEvent> ApplicationEvents(DateTimeOffset since) => Events;
        public bool CollectionEnabled() => Enabled;
        public IReadOnlyList<StabilityValue> Stability(DateTimeOffset since) => StabilityFailure is null ? Values : throw StabilityFailure;
        public IReadOnlyList<ProgramEvent> InstallFailures(DateTimeOffset since) { InstallsRead = true; return Installs; }
    }

    private static void Run()
    {
        var at = DateTimeOffset.Parse("2026-10-20T12:00:00Z");
        var crash = NativeReliability.Crash(at.AddHours(-1), [@"C:\Program Files\Microsoft Office\root\Office16\OUTLOOK.EXE", "16.0.17928.20114", "6700a1b2", @"C:\Windows\System32\ntdll.dll", "10.0.22621.4111", "x", "c0000005"]);
        Check(crash is { Kind: "crash", Program: "OUTLOOK.EXE", Version: "16.0.17928.20114", Module: "ntdll.dll", ModuleVersion: "10.0.22621.4111" }, "event 1000: program, version, module and module version, paths reduced to file names.");
        var hang = NativeReliability.Hang(at.AddHours(-2), ["Teams.exe", "1.6.0", "1234", "", "", @"C:\Users\alice\AppData\Local\Teams\Teams.exe"]);
        Check(hang is { Kind: "hang", Program: "Teams.exe", Version: "1.6.0", Module: null, ModuleVersion: null }, "event 1002: program and version, no module.");
        Check(NativeReliability.Crash(at, ["", "1"]) is null && NativeReliability.Crash(at, []) is null, "an event without a program is skipped.");
        Check(NativeReliability.Short(@"Update for C:\Temp\Tool", product: true) == "Tool" && NativeReliability.Index(4.94) == 4.9 && NativeReliability.Index(12) == 10 && NativeReliability.Index(0.3) == 1, "product names keep no folder; the index has one decimal between 1 and 10.");

        // ---- Stability available ----
        var source = new FakeSource();
        source.Events.AddRange([crash!, hang!, new ProgramEvent(at.AddDays(-31), "crash", "old.exe", null, null, null)]);
        for (int day = 9; day >= 0; day--) { source.Values.Add(new StabilityValue(at.AddDays(-day).AddHours(-3), 8 - day * 0.1)); source.Values.Add(new StabilityValue(at.AddDays(-day).AddHours(-1), 7.04 - day * 0.1)); }
        source.Installs.Add(new ProgramEvent(at.AddDays(-3), "install-failure", "Contoso Agent", null, null, null));
        var reliability = new NativeReliability(source, () => at).Collect()["reliability"]!.AsObject();
        var stability = reliability["stability"]!.AsObject();
        Check(stability["available"]!.GetValue<bool>() && stability["current"]!.GetValue<double>() == 7.0, "the current index is the newest value with one decimal.");
        var days = stability["days"]!.AsArray();
        Check(days.Count == 10 && days[^1]!["day"]!.GetValue<string>() == "2026-10-20" && days[^1]!["index"]!.GetValue<double>() == 7.0 && days[0]!["index"]!.GetValue<double>() == 6.1, "one value per day, the last of the day, oldest first.");
        var events = reliability["events"]!.AsArray();
        Check(events.Count == 3 && events.All(e => e!["program"]!.GetValue<string>() != "old.exe"), "events older than 30 days are dropped.");
        Check(events[0]!["program"]!.GetValue<string>() == "OUTLOOK.EXE" && events.Any(e => e!["kind"]!.GetValue<string>() == "install-failure" && e["program"]!.GetValue<string>() == "Contoso Agent"), "newest first, failed installations from the records.");
        Check(!reliability["truncated"]!.GetValue<bool>() && reliability["windowDays"]!.GetValue<int>() == 30, "window and completeness.");
        string json = reliability.ToJsonString();
        Check(!json.Contains("Program Files") && !json.Contains("alice") && !json.Contains(@"\\"), "no folder of a program or module leaves the device.");

        // ---- 150 events → 100 ----
        var many = new FakeSource { Values = source.Values };
        many.Events.AddRange(Enumerable.Range(0, 150).Select(i => new ProgramEvent(at.AddMinutes(-i), "crash", "app" + i + ".exe", null, null, null)));
        var limited = new NativeReliability(many, () => at).Collect()["reliability"]!;
        Check(limited["events"]!.AsArray().Count == 100 && limited["truncated"]!.GetValue<bool>() && limited["events"]![0]!["program"]!.GetValue<string>() == "app0.exe", "150 events: the newest 100 and truncated.");

        // ---- Not available ----
        var server = new FakeSource { Enabled = false, Values = source.Values, Installs = source.Installs };
        server.Events.Add(crash!);
        var off = new NativeReliability(server, () => at).Collect()["reliability"]!;
        Check(off["stability"]!.ToJsonString() == "{\"available\":false,\"reason\":\"collection-disabled\"}", "WMIEnable = 0: collection-disabled without values.");
        Check(off["events"]!.AsArray().Count == 1 && !server.InstallsRead, "crashes still appear; failed installations are absent.");
        var empty = new FakeSource();
        empty.Events.Add(crash!);
        Check(new NativeReliability(empty, () => at).Collect()["reliability"]!["stability"]!["reason"]!.GetValue<string>() == "collection-disabled", "no rows: collection-disabled.");
        Check(new NativeReliability(new FakeSource { StabilityFailure = new ReliabilityUnavailableException("not-supported") }, () => at).Collect()["reliability"]!["stability"]!["reason"]!.GetValue<string>() == "not-supported", "class missing: not-supported.");
        Check(new NativeReliability(new FakeSource { StabilityFailure = new ReliabilityUnavailableException("access-denied") }, () => at).Collect()["reliability"]!["stability"]!["reason"]!.GetValue<string>() == "access-denied", "access denied.");
        Check(new NativeReliability(new FakeSource { StabilityFailure = new InvalidOperationException("boom") }, () => at).Collect()["reliability"]!["stability"]!["reason"]!.GetValue<string>() == "error", "any other failure: error, no estimate.");
    }
}
