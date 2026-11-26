using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// --defender-self-test: simulated WMI answers for every mode, severity, status
// and productState code, the resource prefix and count, the limits of 100
// detections, 200 exclusions and 4 products with the totals, and the cases that
// give null or "not available" (no Security Center, no Defender, denied access,
// a failing detection or exclusion read).
internal static class NativeDefenderTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Defender regression: " + message); }
    internal static int RunSelfTest() { try { Run(); Console.WriteLine("Defender self-test passed."); return 0; } catch (Exception error) { Console.Error.WriteLine(error); return 1; } }

    private sealed class FakeProvider : IDefenderProvider
    {
        internal DefenderStatusRow Row = new(true, true, "Normal", true, DateTimeOffset.Parse("2026-11-01T10:00:00Z"), DateTimeOffset.Parse("2026-10-20T03:00:00Z"), DateTimeOffset.Parse("2026-11-04T06:00:00Z"), "1.421.1234.0", "4.18.24090.11");
        internal Exception? StatusFailure, DetectionFailure, ThreatFailure, ExclusionFailure;
        internal List<DefenderDetectionRow> DetectionRows = [];
        internal List<DefenderThreatRow> ThreatRows = [];
        internal DefenderExclusionRows ExclusionRows = new([@"C:\Temp\x"], [".log"], ["sqlservr.exe"]);
        internal List<AntivirusProductRow>? Products = [];
        public DefenderStatusRow Status() => StatusFailure is null ? Row : throw StatusFailure;
        public IReadOnlyList<DefenderDetectionRow> Detections() => DetectionFailure is null ? DetectionRows : throw DetectionFailure;
        public IReadOnlyList<DefenderThreatRow> Threats() => ThreatFailure is null ? ThreatRows : throw ThreatFailure;
        public DefenderExclusionRows Exclusions() => ExclusionFailure is null ? ExclusionRows : throw ExclusionFailure;
        public IReadOnlyList<AntivirusProductRow>? AntivirusProducts() => Products;
    }
    private static JsonObject Collect(FakeProvider provider) => new NativeDefender(provider, () => DateTimeOffset.Parse("2026-11-04T12:00:00Z")).Collect();

    private static void Run()
    {
        // ---- Mappings ----
        Check(NativeDefender.Mode("Normal") == "normal" && NativeDefender.Mode("PASSIVE MODE") == "passive" && NativeDefender.Mode("sxs passive mode") == "sxs-passive" && NativeDefender.Mode("EDR Block Mode") == "edr-block" && NativeDefender.Mode("Not running") == "not-running" && NativeDefender.Mode("Passive") == "unknown" && NativeDefender.Mode(null) == "unknown", "running modes, case-insensitive.");
        Check(Enumerable.Range(0, 7).Select(i => NativeDefender.Severity((uint)i)).SequenceEqual(new[] { "unknown", "low", "moderate", "unknown", "high", "severe", "unknown" }) && NativeDefender.Severity(null) == "unknown", "severity codes.");
        Check(new uint[] { 0, 1, 2, 3, 4, 5, 6, 7, 102, 103, 104, 105, 106, 107 }.Select(i => NativeDefender.Status(i)).SequenceEqual(new[] { "unknown", "detected", "cleaned", "quarantined", "removed", "allowed", "blocked", "unknown", "failed", "failed", "failed", "abandoned", "unknown", "failed" }) && NativeDefender.Status(null) == "unknown", "threat status codes.");
        Check(NativeDefender.ProductEnabled(0x1000) && NativeDefender.ProductEnabled(266240) && !NativeDefender.ProductEnabled(262144) && !NativeDefender.ProductEnabled(393472) && NativeDefender.ProductEnabled(397312) && !NativeDefender.ProductEnabled(null), "productState bits 12–15.");
        Check(NativeDefender.StripResource(@"file:_C:\Users\anna\Downloads\eicar.txt") == @"C:\Users\anna\Downloads\eicar.txt" && NativeDefender.StripResource(@"containerfile:_C:\a.zip") == @"C:\a.zip" && NativeDefender.StripResource(@"C:\plain") == @"C:\plain", "the type prefix is stripped once.");
        Check(NativeDefender.Time(DateTimeOffset.UnixEpoch) is null && NativeDefender.Time(DateTimeOffset.MinValue) is null && NativeDefender.Time(null) is null && NativeDefender.Time(DateTimeOffset.Parse("1601-01-01T00:00:00Z")) is null && NativeDefender.Time(DateTimeOffset.Parse("2026-11-01T10:00:00Z")) == "2026-11-01T10:00:00.0000000+00:00", "epoch and zero times are null.");

        // ---- A full read ----
        var provider = new FakeProvider();
        provider.DetectionRows = [
            new("{A}", "2147519003", 3, [@"file:_C:\Users\anna\Downloads\eicar.txt", @"file:_C:\Users\anna\Downloads\eicar2.txt"], DateTimeOffset.Parse("2026-11-03T09:00:00Z"), @"CONTOSO\anna"),
            new("{B}", "2147700000", 1, [@"file:_C:\Temp\tool.exe"], DateTimeOffset.Parse("2026-11-04T08:00:00Z"), null),
            new("{C}", "999", 104, [], DateTimeOffset.Parse("2026-11-02T08:00:00Z"), ""),
            new("{B}", "2147700000", 1, [], DateTimeOffset.Parse("2026-11-04T08:00:00Z"), null)];
        provider.ThreatRows = [new("2147519003", "Virus:DOS/EICAR_Test_File", 5, false), new("2147700000", "HackTool:Win32/Example", 4, true)];
        provider.Products = [new("Windows Defender", "windowsdefender://", 397568), new("Contoso Endpoint", @"C:\Program Files\Contoso\av.exe", 266240), new("Old AV", @"C:\old.exe", 262144)];
        var root = Collect(provider);
        var defender = root["defender"]!.AsObject();
        Check(defender["available"]!.GetValue<bool>() && defender["reason"] is null && defender["mode"]!.GetValue<string>() == "normal" && defender["tamperProtected"]!.GetValue<bool>(), "available, normal mode, tamper protection.");
        Check(defender["quickScanAt"]!.GetValue<string>() == "2026-11-01T10:00:00.0000000+00:00" && defender["fullScanAt"]!.GetValue<string>() == "2026-10-20T03:00:00.0000000+00:00" && defender["signatureVersion"]!.GetValue<string>() == "1.421.1234.0" && defender["productVersion"]!.GetValue<string>() == "4.18.24090.11", "scan times and versions.");
        var detections = defender["detections"]!.AsArray();
        Check(detections.Count == 3 && defender["detectionCount"]!.GetValue<int>() == 3 && !defender["truncated"]!.GetValue<bool>(), "duplicate detection IDs count once.");
        Check(detections[0]!["id"]!.GetValue<string>() == "{B}" && detections[1]!["id"]!.GetValue<string>() == "{A}" && detections[2]!["id"]!.GetValue<string>() == "{C}", "newest first.");
        Check(detections[1]!["name"]!.GetValue<string>() == "Virus:DOS/EICAR_Test_File" && detections[1]!["severity"]!.GetValue<string>() == "severe" && detections[1]!["status"]!.GetValue<string>() == "quarantined" && !detections[1]!["active"]!.GetValue<bool>(), "the threat row gives name, severity and IsActive.");
        Check(detections[1]!["path"]!.GetValue<string>() == @"C:\Users\anna\Downloads\eicar.txt" && detections[1]!["resourceCount"]!.GetValue<int>() == 2 && detections[1]!["user"]!.GetValue<string>() == @"CONTOSO\anna" && detections[1]!["at"]!.GetValue<string>() == "2026-11-03T09:00:00.0000000+00:00", "path without prefix, resource count, user and time.");
        Check(detections[2]!["name"] is null && detections[2]!["severity"]!.GetValue<string>() == "unknown" && detections[2]!["status"]!.GetValue<string>() == "failed" && detections[2]!["active"]!.GetValue<bool>() && detections[2]!["path"] is null && detections[2]!["resourceCount"]!.GetValue<int>() == 0 && detections[2]!["user"] is null, "without a threat row the status decides; no resource gives no path.");
        Check(defender["activeCount"]!.GetValue<int>() == 2 && defender["highestActiveSeverity"]!.GetValue<string>() == "high", "active count and highest active severity.");
        var other = defender["otherAntivirus"]!.AsArray();
        Check(other.Count == 2 && other[0]!["name"]!.GetValue<string>() == "Contoso Endpoint" && other[0]!["enabled"]!.GetValue<bool>() && !other[1]!["enabled"]!.GetValue<bool>(), "Defender itself is left out of the other antivirus products.");
        var exclusions = defender["exclusions"]!.AsObject();
        Check(exclusions["paths"]![0]!.GetValue<string>() == @"C:\Temp\x" && exclusions["extensions"]![0]!.GetValue<string>() == ".log" && exclusions["processes"]![0]!.GetValue<string>() == "sqlservr.exe" && root["_collectionWarnings"] is null, "exclusions, no warning.");

        // ---- Limits ----
        provider.DetectionRows = Enumerable.Range(0, 130).Select(i => new DefenderDetectionRow("{D" + i + "}", "1", i < 110 ? 1u : 2u, [], DateTimeOffset.Parse("2026-01-01T00:00:00Z").AddHours(i), null)).ToList();
        provider.ThreatRows = [];
        provider.ExclusionRows = new(Enumerable.Range(0, 250).Select(i => @"C:\Path" + i).ToList(), Enumerable.Range(0, 201).Select(i => "." + i).ToList(), [new string('p', 900)]);
        provider.Products = Enumerable.Range(0, 6).Select(i => new AntivirusProductRow("AV " + i, null, 266240)).ToList();
        defender = Collect(provider)["defender"]!.AsObject();
        detections = defender["detections"]!.AsArray();
        Check(detections.Count == 100 && defender["detectionCount"]!.GetValue<int>() == 130 && defender["truncated"]!.GetValue<bool>() && detections[0]!["id"]!.GetValue<string>() == "{D129}", "the newest 100 of 130 detections, truncated.");
        Check(defender["activeCount"]!.GetValue<int>() == 110 && detections.Count(row => row!["active"]!.GetValue<bool>()) == 80 && defender["highestActiveSeverity"]!.GetValue<string>() == "unknown", "the active count also counts active detections outside the list.");
        exclusions = defender["exclusions"]!.AsObject();
        Check(exclusions["paths"]!.AsArray().Count == 200 && exclusions["extensions"]!.AsArray().Count == 200 && exclusions["processes"]![0]!.GetValue<string>().Length == 500, "at most 200 exclusions of at most 500 characters.");
        Check(defender["otherAntivirus"]!.AsArray().Count == 4, "at most 4 other products.");

        // ---- Null and unavailable cases ----
        provider = new FakeProvider { Products = null };
        defender = Collect(provider)["defender"]!.AsObject();
        Check(defender.ContainsKey("otherAntivirus") && defender["otherAntivirus"] is null && defender["highestActiveSeverity"] is null && defender["activeCount"]!.GetValue<int>() == 0, "no Security Center (Windows Server) gives null, not an empty list.");
        provider = new FakeProvider { Row = new(false, false, "Passive Mode", null, null, DateTimeOffset.UnixEpoch, null, null, null) };
        defender = Collect(provider)["defender"]!.AsObject();
        Check(defender["mode"]!.GetValue<string>() == "passive" && defender["tamperProtected"] is null && defender["quickScanAt"] is null && defender["fullScanAt"] is null && defender["signatureAt"] is null && defender["signatureVersion"] is null, "a passive Defender without scans and tamper value.");
        provider = new FakeProvider { DetectionFailure = new InvalidOperationException("broken"), ExclusionFailure = new InvalidOperationException("broken") };
        root = Collect(provider); defender = root["defender"]!.AsObject();
        Check(defender["available"]!.GetValue<bool>() && defender["detections"]!.AsArray().Count == 0 && defender["detectionCount"]!.GetValue<int>() == 0 && defender.ContainsKey("exclusions") && defender["exclusions"] is null && root["_collectionWarnings"]!.AsArray().Count == 2, "a failed detection or exclusion read keeps the status, with warnings.");
        provider = new FakeProvider { DetectionRows = [new("{E}", "7", 1, [@"file:_C:\x.exe"], DateTimeOffset.Parse("2026-11-04T08:00:00Z"), null)], ThreatFailure = new InvalidOperationException("broken") };
        root = Collect(provider); detections = root["defender"]!["detections"]!.AsArray();
        Check(detections.Count == 1 && detections[0]!["name"] is null && detections[0]!["severity"]!.GetValue<string>() == "unknown" && detections[0]!["active"]!.GetValue<bool>() && root["_collectionWarnings"]!.AsArray().Count == 1, "a failed threat read keeps the detections without names.");
        provider = new FakeProvider { ExclusionRows = new(["N/A:Must be an administrator to view exclusions"], [], []) };
        Check(Collect(provider)["defender"]!["exclusions"] is null, "the administrator placeholder is no exclusion.");
        foreach (var (failure, reason) in new (Exception, string)[] { (new DefenderUnavailableException("missing"), "not-installed"), (new UnauthorizedAccessException("denied"), "access-denied"), (new InvalidOperationException("broken"), "error") })
        {
            defender = Collect(new FakeProvider { StatusFailure = failure })["defender"]!.AsObject();
            Check(!defender["available"]!.GetValue<bool>() && defender["reason"]!.GetValue<string>() == reason && defender["collectedAt"]!.GetValue<string>() == "2026-11-04T12:00:00.0000000+00:00" && defender.Count == 3, "status failure: " + reason + " with only available, reason and collectedAt.");
        }
    }
}
