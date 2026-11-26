using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// --software-self-test: the uninstall keys through an injected registry reader,
// the skipped entries, the scrubbing of user folders, the 2000-item limit, the
// checksum (same value as lib/software-inventory.ts) and the upload decision.
internal static class NativeSoftwareInventoryTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Software inventory regression: " + message); }
    internal static int RunSelfTest() { try { Run(); Console.WriteLine("Software inventory self-test passed."); return 0; } catch (Exception error) { Console.Error.WriteLine(error); return 1; } }

    private sealed class FakeRegistry(params SoftwareHive[] hives) : ISoftwareRegistryReader { public IEnumerable<SoftwareHive> Read() => hives; }
    private static SoftwareKey Key(string name, params (string Name, object? Value)[] values) => new(name, values.ToDictionary(v => v.Name, v => v.Value, StringComparer.OrdinalIgnoreCase));

    private static void Run()
    {
        var machine64 = new SoftwareHive("machine", "x64", "machine:x64",
        [
            Key("{CHROME}", ("DisplayName", "Google Chrome"), ("DisplayVersion", "120.0.6099.130"), ("Publisher", "Google LLC"), ("InstallDate", "20260115"),
                ("InstallLocation", @"C:\Program Files\Google\Chrome"), ("UninstallString", @"C:\Users\alice\AppData\setup.exe --uninstall"), ("DisplayIcon", @"C:\Users\alice\icon.ico")),
            Key("NoName", ("DisplayVersion", "1.0")),
            Key("Blank", ("DisplayName", "   ")),
            Key("Component", ("DisplayName", "Hidden runtime"), ("SystemComponent", 1)),
            Key("Child", ("DisplayName", "Patch for Office"), ("ParentKeyName", "Office16")),
            Key("KB5000001", ("DisplayName", "Security Update for Windows"), ("ReleaseType", "Security Update")),
            Key("Hotfix", ("DisplayName", "Hotfix 1"), ("ReleaseType", "hotfix")),
            Key("Update", ("DisplayName", "Update 1"), ("ReleaseType", "Update")),
            Key("Sparse", ("DisplayName", "Sparse tool")),
            Key("BadDate", ("DisplayName", "Bad date"), ("InstallDate", "20261345")),
            Key("Scrub", ("DisplayName", @"Profile tool for C:\Users\alice\Tools"), ("Publisher", @"d:\users\Bob Smith\vendor")),
        ]);
        var machine32 = new SoftwareHive("machine", "x86", "machine:x86", [Key("7-Zip", ("DisplayName", "7-Zip 23.01"), ("DisplayVersion", "23.01"), ("Publisher", "Igor Pavlov"))]);
        var alice = new SoftwareHive("user", null, "S-1-5-21-1-1001", [Key("Spotify", ("DisplayName", "Spotify"), ("DisplayVersion", "1.2.3")), Key("Teams", ("DisplayName", "Microsoft Teams"))]);
        var bob = new SoftwareHive("user", null, "S-1-5-21-1-1002", [Key("Spotify", ("DisplayName", "Spotify"), ("DisplayVersion", "1.2.4")), Key("Zoom", ("DisplayName", "Zoom"))]);
        var inventory = new NativeSoftwareInventory(new FakeRegistry(bob, machine32, machine64, alice));
        var (items, count, truncated) = inventory.Inventory();
        var byKey = items.GroupBy(i => i.Scope + "|" + i.Key).ToDictionary(g => g.Key, g => g.Single());
        Check(count == items.Count && !truncated, "a small list is complete.");
        Check(items.Select(i => i.Key).SequenceEqual(new[] { "BadDate", "Scrub", "Sparse", "{CHROME}", "7-Zip", "Spotify", "Teams", "Zoom" }), "entries are sorted ordinally by scope, architecture and key; skipped entries are gone: " + string.Join(",", items.Select(i => i.Key)));
        var chrome = byKey["machine|{CHROME}"];
        Check(chrome is { Name: "Google Chrome", Version: "120.0.6099.130", Publisher: "Google LLC", InstallDate: "2026-01-15", Architecture: "x64", Scope: "machine" }, "64-bit entry with all values.");
        Check(byKey["machine|7-Zip"].Architecture == "x86", "the 32-bit view reports x86.");
        Check(byKey["machine|Sparse"] is { Version: null, Publisher: null, InstallDate: null }, "missing version, publisher and date are null.");
        Check(byKey["machine|BadDate"].InstallDate is null && NativeSoftwareInventory.InstallDate("2026-02-30") is null && NativeSoftwareInventory.InstallDate("20260228") == "2026-02-28", "an invalid InstallDate gives null.");
        Check(byKey["machine|Scrub"].Name == @"Profile tool for C:\Users\…" + @"\Tools" && byKey["machine|Scrub"].Publisher == @"d:\Users\…\vendor", "user folders are shortened.");
        Check(byKey["user|Spotify"] is { Version: "1.2.3", Architecture: null, Scope: "user" } && items.Count(i => i.Key == "Spotify") == 1, "user entries are one per key across users (the first SID in order wins).");
        string json = inventory.Collect().ToJsonString();
        foreach (string forbidden in new[] { "Program Files", "setup.exe", "icon.ico", "alice", "S-1-5-21", "InstallLocation", "UninstallString", "DisplayIcon" })
            Check(!json.Contains(forbidden, StringComparison.OrdinalIgnoreCase), "the result contains no path value, user name or SID: " + forbidden);

        // ---- Limit ----
        var many = new SoftwareHive("machine", "x64", "machine:x64", Enumerable.Range(0, 2500).Select(i => Key("App" + i.ToString("D4"), ("DisplayName", "Application " + i), ("DisplayVersion", "1.0." + i))).ToList());
        (items, count, truncated) = new NativeSoftwareInventory(new FakeRegistry(many)).Inventory();
        Check(items.Count == 2000 && count == 2500 && truncated && items[0].Key == "App0000" && items[^1].Key == "App1999", "2500 items: the first 2000 in order, count 2500, truncated.");
        var collected = new NativeSoftwareInventory(new FakeRegistry(many)).Collect();
        var list = collected[NativeTelemetryCollector.SoftwareInventoryKey]!.AsObject();
        Check(list["count"]!.GetValue<int>() == 2500 && list["truncated"]!.GetValue<bool>() && list["items"]!.AsArray().Count == 2000 && collected["softwareChecksum"]!.GetValue<string>() == list["checksum"]!.GetValue<string>(), "the collector carries the checksum and the list.");
        var large = new SoftwareHive("machine", "x64", "machine:x64", Enumerable.Range(0, 2000).Select(i => Key("Big" + i.ToString("D4"), ("DisplayName", new string('n', 256)), ("DisplayVersion", new string('v', 256)), ("Publisher", new string('p', 256)))).ToList());
        (items, count, truncated) = new NativeSoftwareInventory(new FakeRegistry(large)).Inventory();
        Check(items.Count < 2000 && count == 2000 && truncated, "a list above the byte budget of a report is cut and marked truncated.");

        // ---- Checksum ----
        // Same items and value as tests/support/software-checksum-fixture.mjs (lib/software-inventory.ts).
        var fixture = new List<SoftwareEntry>
        {
            new("{8A69D345-D564-463C-AFF1-A69D9E530F96}", "Google Chrome", "120.0.6099.130", "Google LLC", "2026-01-15", "x64", "machine"),
            new("7-Zip", "7-Zip 23.01 (x64)", "23.01", "Igor Pavlov", null, "x86", "machine"),
            new("Spotify", "Spotify", "1.2.3", "Spotify AB", null, null, "user"),
            new("Tool\tKey", "Tool \"Quoted\" \\ Back", null, "Müller GmbH ✓ 😀", null, "x64", "machine"),
            new("arm", "<Arm> & 'tool' +1", "v2", null, "2025-12-31", "arm64", "machine"),
        };
        const string expected = "85b4fb63c2997665678542a00ca35b168d02a73e8c50be3b83ba1b016b2e342e";
        Check(NativeSoftwareInventory.Checksum(fixture) == expected, "the checksum equals the portal's value for the shared fixture.");
        Check(NativeSoftwareInventory.Checksum(Enumerable.Reverse(fixture)) == expected, "the checksum does not depend on the input order.");
        var changed = fixture.ToList(); changed[0] = changed[0] with { Version = "121.0.0.1" };
        Check(NativeSoftwareInventory.Checksum(changed) != expected, "a version change changes the checksum.");

        // ---- Upload decision ----
        var policy = new SoftwareUploadPolicy(); var now = DateTimeOffset.Parse("2026-10-20T12:00:00Z");
        Check(!policy.ShouldUpload(null, now), "nothing to send before the first collection.");
        Check(policy.ShouldUpload("aaa", now), "a checksum the portal never acknowledged is sent.");
        policy.Succeeded("aaa", now);
        Check(!policy.ShouldUpload("aaa", now.AddMinutes(5)), "unchanged: no upload.");
        Check(!policy.ShouldUpload("bbb", now.AddSeconds(30)) && policy.ShouldUpload("bbb", now.AddSeconds(61)), "changed: upload, at most once per 60 s.");
        policy.Heartbeat("aaa", true);
        Check(policy.ShouldUpload("aaa", now.AddMinutes(2)), "softwareResync: upload the same list again.");
        policy.Heartbeat("aaa", false);
        Check(!policy.ShouldUpload("aaa", now.AddMinutes(2)), "a heartbeat answer without softwareResync acknowledges its checksum.");
        policy.Failed(now.AddMinutes(3));
        Check(!policy.ShouldUpload("ccc", now.AddMinutes(3).AddSeconds(59)) && policy.ShouldUpload("ccc", now.AddMinutes(4)), "after a failure the next try waits at least 60 s.");
        policy.Failed(now.AddMinutes(4));
        Check(!policy.ShouldUpload("ccc", now.AddMinutes(5)) && policy.ShouldUpload("ccc", now.AddMinutes(6)), "failures back off.");
        for (int i = 0; i < 20; i++) policy.Failed(now);
        Check(policy.ShouldUpload("ccc", now.Add(SoftwareUploadPolicy.MaximumBackoff)), "the backoff stops at 30 minutes.");
    }
}
