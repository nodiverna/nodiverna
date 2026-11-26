using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// --windows-license-self-test: simulated SoftwareLicensingProduct answers for every
// LicenseStatus value, every channel rule, expiresAt from the remaining minutes,
// EvaluationEndDate 1601 as no date, the query without ProductKeyChannel and
// EvaluationEndDate on older Windows, the preference of the licensed row, and the
// not-found, access-denied and error results.
internal static class NativeWindowsLicenseTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Windows license regression: " + message); }
    internal static int RunSelfTest() { try { Run(); Console.WriteLine("Windows license self-test passed."); return 0; } catch (Exception error) { Console.Error.WriteLine(error); return 1; } }

    private sealed class FakeProvider : IWindowsLicenseProvider
    {
        internal List<WindowsLicenseRow> FullRows = [], ShortRows = [];
        internal bool RefuseFull;
        internal Exception? Failure;
        internal List<bool> Calls = [];
        public IReadOnlyList<WindowsLicenseRow> Rows(bool full)
        {
            Calls.Add(full);
            if (Failure is not null) throw Failure;
            if (full && RefuseFull) throw new WindowsLicensePropertyException("unknown property");
            return full ? FullRows : ShortRows;
        }
    }
    private static readonly DateTimeOffset Clock = DateTimeOffset.Parse("2026-11-26T10:15:42Z");
    private static JsonObject Collect(FakeProvider provider) => new NativeWindowsLicense(provider, () => Clock).Collect()["windowsLicense"]!.AsObject();
    private static WindowsLicenseRow Row(uint? status, string? description = "Windows(R) Operating System, RETAIL channel", string? family = "ServerStandard", string? channel = "Retail", uint? minutes = 0, DateTimeOffset? end = null) => new(description, family, channel, status, minutes, end);

    private static void Run()
    {
        // ---- Every LicenseStatus value ----
        Check(new uint?[] { 0, 1, 2, 3, 4, 5, 6, 7, null }.Select(NativeWindowsLicense.Status).SequenceEqual(new[] { "unlicensed", "licensed", "initial-grace", "additional-grace", "non-genuine-grace", "notification", "extended-grace", "unknown", "unknown" }), "LicenseStatus 0–6, any other value and null.");
        foreach (var (value, expected) in new (uint, string)[] { (0, "unlicensed"), (1, "licensed"), (2, "initial-grace"), (3, "additional-grace"), (4, "non-genuine-grace"), (5, "notification"), (6, "extended-grace"), (9, "unknown") })
            Check(Collect(new FakeProvider { FullRows = [Row(value)] })["status"]!.GetValue<string>() == expected, "collected status " + expected + ".");

        // ---- Every channel rule, the first match wins ----
        Check(NativeWindowsLicense.Channel("Windows(R) Operating System, TIMEBASED_EVAL channel", "ServerStandardEval", "Retail") == "evaluation", "TIMEBASED_EVAL wins over Retail.");
        Check(NativeWindowsLicense.Channel("Windows(R) Operating System, RETAIL channel", "ServerDatacenterEVAL", "Retail") == "evaluation", "a LicenseFamily ending with Eval, case-insensitive.");
        Check(NativeWindowsLicense.Channel("Windows(R), Professional edition", "Professional", "OEM:DM") == "oem" && NativeWindowsLicense.Channel("Windows(R) Operating System, OEM_DM channel", "Professional", null) == "oem", "OEM by channel and by description.");
        Check(NativeWindowsLicense.Channel("Windows(R) Operating System, VOLUME_KMSCLIENT channel", "ServerStandard", "Volume:GVLK") == "volume-kms" && NativeWindowsLicense.Channel("Windows(R) Operating System, VOLUME_KMSCLIENT channel", "ServerStandard", null) == "volume-kms", "KMS client by channel and by description.");
        Check(NativeWindowsLicense.Channel("Windows(R) Operating System", "Enterprise", "Volume:MAK") == "volume-mak" && NativeWindowsLicense.Channel("Windows(R) Operating System, VOLUME_MAK channel", "Enterprise", null) == "volume-mak", "MAK by channel and by description.");
        Check(NativeWindowsLicense.Channel("Windows(R) Operating System", "Professional", "Retail") == "retail" && NativeWindowsLicense.Channel("Windows(R) Operating System, RETAIL channel", "Professional", null) == "retail", "retail by channel and by description.");
        Check(NativeWindowsLicense.Channel("Windows(R) Operating System", "Professional", "Volume:CSVLK") == "unknown" && NativeWindowsLicense.Channel(null, null, null) == "unknown", "nothing known is unknown.");

        // ---- expiresAt from the remaining minutes, the evaluation end ----
        var evaluation = Collect(new FakeProvider { FullRows = [Row(1, "Windows(R) Operating System, TIMEBASED_EVAL channel", "ServerStandardEval", "Retail", 47 * 1440, DateTimeOffset.Parse("2027-01-12T00:00:00Z"))] });
        Check(evaluation["available"]!.GetValue<bool>() && evaluation["channel"]!.GetValue<string>() == "evaluation" && evaluation["status"]!.GetValue<string>() == "licensed", "a licensed evaluation.");
        Check(evaluation["expiresAt"]!.GetValue<string>() == "2027-01-12T10:15:00.0000000+00:00", "expiresAt = the collection time in whole minutes + 47 days.");
        Check(evaluation["evaluationEndsAt"]!.GetValue<string>() == "2027-01-12T00:00:00.0000000+00:00" && evaluation["collectedAt"]!.GetValue<string>() == "2026-11-26T10:15:42.0000000+00:00" && evaluation.Count == 6, "evaluationEndsAt, collectedAt and the six keys.");
        Check(NativeWindowsLicense.ExpiresAt(Clock, 1) == "2026-11-26T10:16:00.0000000+00:00" && NativeWindowsLicense.ExpiresAt(Clock, 0) is null && NativeWindowsLicense.ExpiresAt(Clock, null) is null, "one minute; 0 and null give no time.");
        var retail = Collect(new FakeProvider { FullRows = [Row(1, end: DateTimeOffset.Parse("1601-01-01T00:00:00Z"))] });
        Check(retail.ContainsKey("expiresAt") && retail["expiresAt"] is null && retail.ContainsKey("evaluationEndsAt") && retail["evaluationEndsAt"] is null && retail["channel"]!.GetValue<string>() == "retail", "EvaluationEndDate 1601 and no remaining minutes are null.");
        Check(NativeWindowsLicense.EvaluationEndsAt(null) is null && NativeWindowsLicense.EvaluationEndsAt(DateTimeOffset.Parse("1602-03-01T00:00:00Z")) == "1602-03-01T00:00:00.0000000+00:00", "no date is null, a date after 1601 is kept.");

        // ---- The query without ProductKeyChannel and EvaluationEndDate ----
        var old = new FakeProvider { RefuseFull = true, ShortRows = [Row(2, "Windows(R) Operating System, VOLUME_MAK channel", "Enterprise", null, 4320)] };
        var fallback = Collect(old);
        Check(old.Calls.SequenceEqual(new[] { true, false }), "a refused full query is repeated without the two properties.");
        Check(fallback["available"]!.GetValue<bool>() && fallback["status"]!.GetValue<string>() == "initial-grace" && fallback["channel"]!.GetValue<string>() == "volume-mak" && fallback["evaluationEndsAt"] is null && fallback["expiresAt"]!.GetValue<string>() == "2026-11-29T10:15:00.0000000+00:00", "the short query gives status, channel by description and the grace end.");
        var current = new FakeProvider { FullRows = [Row(1)] };
        Collect(current);
        Check(current.Calls.SequenceEqual(new[] { true }), "a current Windows needs one query.");

        // ---- The licensed row wins ----
        var rows = Collect(new FakeProvider { FullRows = [Row(0, "Windows(R) Operating System, OEM_DM channel", "Professional", "OEM:DM"), Row(1, "Windows(R) Operating System, VOLUME_KMSCLIENT channel", "Professional", "Volume:GVLK", 250000), Row(5)] });
        Check(rows["status"]!.GetValue<string>() == "licensed" && rows["channel"]!.GetValue<string>() == "volume-kms", "the first row with LicenseStatus 1.");
        var unlicensed = Collect(new FakeProvider { FullRows = [Row(5, "Windows(R) Operating System, RETAIL channel"), Row(0, "Windows(R) Operating System, OEM_DM channel", "Professional", "OEM:DM")] });
        Check(unlicensed["status"]!.GetValue<string>() == "notification" && unlicensed["channel"]!.GetValue<string>() == "retail", "without a licensed row, the first row.");

        // ---- not-found, access-denied, error ----
        foreach (var (provider, reason) in new (FakeProvider, string)[] { (new FakeProvider(), "not-found"), (new FakeProvider { Failure = new UnauthorizedAccessException("denied") }, "access-denied"), (new FakeProvider { Failure = new InvalidOperationException("broken") }, "error"), (new FakeProvider { RefuseFull = true }, "not-found") })
        {
            var result = Collect(provider);
            Check(!result["available"]!.GetValue<bool>() && result["reason"]!.GetValue<string>() == reason && result["collectedAt"]!.GetValue<string>() == "2026-11-26T10:15:42.0000000+00:00" && result.Count == 3, reason + " with only available, reason and collectedAt.");
        }
    }
}
