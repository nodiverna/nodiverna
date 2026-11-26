using System.Globalization;
using System.Management;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static ServerDesk.Agent.WindowsManagement;

namespace ServerDesk.Agent;

// The Microsoft Defender state (docs/v3-health-signals.md, "Defender in 4.14.0"):
// status, scans and signatures from MSFT_MpComputerStatus, the detections from
// MSFT_MpThreatDetection joined with MSFT_MpThreat, the exclusions from
// MSFT_MpPreference and the third-party antivirus products from
// root\SecurityCenter2 AntiVirusProduct. The collector only reads: it starts no
// scan, changes no preference and removes no threat. The snapshot key is
// "defender"; security.defender (Security collector) stays for older portals.
internal sealed record DefenderStatusRow(bool AntivirusEnabled, bool RealTimeProtection, string? RunningMode, bool? TamperProtected, DateTimeOffset? QuickScanEnd, DateTimeOffset? FullScanEnd, DateTimeOffset? SignatureUpdated, string? SignatureVersion, string? ProductVersion);
internal sealed record DefenderDetectionRow(string Id, string ThreatId, uint? StatusId, IReadOnlyList<string> Resources, DateTimeOffset? At, string? User);
internal sealed record DefenderThreatRow(string ThreatId, string? Name, uint? SeverityId, bool? IsActive);
internal sealed record DefenderExclusionRows(IReadOnlyList<string> Paths, IReadOnlyList<string> Extensions, IReadOnlyList<string> Processes);
internal sealed record AntivirusProductRow(string Name, string? SignedProductExe, uint? ProductState);

/// <summary>The Defender namespace or MSFT_MpComputerStatus does not exist.</summary>
internal sealed class DefenderUnavailableException(string message) : Exception(message);

internal interface IDefenderProvider
{
    /// <summary>The one MSFT_MpComputerStatus row. Throws DefenderUnavailableException when the namespace, the class or the row is missing.</summary>
    DefenderStatusRow Status();
    IReadOnlyList<DefenderDetectionRow> Detections();
    IReadOnlyList<DefenderThreatRow> Threats();
    DefenderExclusionRows Exclusions();
    /// <summary>The products of root\SecurityCenter2, or null when the namespace does not exist (Windows Server).</summary>
    IReadOnlyList<AntivirusProductRow>? AntivirusProducts();
}

internal sealed class NativeDefender(IDefenderProvider? provider = null, Func<DateTimeOffset>? clock = null)
{
    internal const int IntervalSeconds = 300;
    internal const int DeadlineSeconds = 20;
    internal const int MaximumDetections = 100;
    internal const int MaximumExclusions = 200;
    internal const int MaximumAntivirus = 4;
    internal const int MaximumText = 500;
    internal const int MaximumVersion = 64;
    internal const int MaximumProductName = 256;
    private readonly IDefenderProvider source = provider ?? new WmiDefenderProvider();
    private readonly Func<DateTimeOffset> now = clock ?? (() => DateTimeOffset.UtcNow);

    internal JsonObject Collect()
    {
        var at = now(); string collectedAt = at.ToString("O", CultureInfo.InvariantCulture);
        JsonObject Unavailable(string reason) => new() { ["defender"] = new JsonObject { ["available"] = false, ["reason"] = reason, ["collectedAt"] = collectedAt } };
        DefenderStatusRow status;
        try { status = source.Status(); }
        catch (DefenderUnavailableException) { return Unavailable("not-installed"); }
        catch (UnauthorizedAccessException) { return Unavailable("access-denied"); }
        catch (ManagementException error) when (error.ErrorCode is ManagementStatus.InvalidNamespace or ManagementStatus.InvalidClass or ManagementStatus.NotFound) { return Unavailable("not-installed"); }
        catch (ManagementException error) when (error.ErrorCode == ManagementStatus.AccessDenied) { return Unavailable("access-denied"); }
        catch (Exception error) when (error is not OutOfMemoryException) { return Unavailable("error"); }

        var warnings = new JsonArray();
        // A failed detection or exclusion read never fails the status read.
        IReadOnlyList<DefenderDetectionRow> detections = [];
        IReadOnlyList<DefenderThreatRow> threats = [];
        try { detections = source.Detections(); }
        catch (Exception error) when (error is not OutOfMemoryException) { warnings.Add("The Defender detections could not be read (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
        if (detections.Count > 0)
        {
            try { threats = source.Threats(); }
            catch (Exception error) when (error is not OutOfMemoryException) { warnings.Add("The Defender threat names could not be read (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
        }
        JsonObject? exclusions = null;
        try { exclusions = ExclusionsJson(source.Exclusions()); }
        catch (Exception error) when (error is not OutOfMemoryException) { warnings.Add("The Defender exclusions could not be read (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
        JsonArray? other = null;
        try { other = OtherAntivirus(source.AntivirusProducts()); }
        catch (Exception error) when (error is not OutOfMemoryException) { warnings.Add("The Security Center antivirus products could not be read (" + NativeInventoryDiagnostics.Describe(error) + ")."); }

        var list = DetectionList(detections, threats);
        var defender = new JsonObject
        {
            ["available"] = true, ["collectedAt"] = collectedAt, ["mode"] = Mode(status.RunningMode),
            ["antivirusEnabled"] = status.AntivirusEnabled, ["realTimeProtection"] = status.RealTimeProtection, ["tamperProtected"] = status.TamperProtected,
            ["quickScanAt"] = Time(status.QuickScanEnd), ["fullScanAt"] = Time(status.FullScanEnd), ["signatureAt"] = Time(status.SignatureUpdated),
            ["signatureVersion"] = Short(status.SignatureVersion, MaximumVersion), ["productVersion"] = Short(status.ProductVersion, MaximumVersion),
            ["otherAntivirus"] = other,
            ["detectionCount"] = list.Count, ["activeCount"] = list.Active, ["highestActiveSeverity"] = list.HighestActiveSeverity, ["truncated"] = list.Count > list.Items.Count,
            ["detections"] = new JsonArray(list.Items.Select(item => (JsonNode)item).ToArray()),
            ["exclusions"] = exclusions
        };
        var result = new JsonObject { ["defender"] = defender };
        if (warnings.Count > 0) result["_collectionWarnings"] = warnings;
        return result;
    }

    /// <summary>AMRunningMode → mode; the match ignores case.</summary>
    internal static string Mode(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        "normal" => "normal", "passive mode" => "passive", "sxs passive mode" => "sxs-passive", "edr block mode" => "edr-block", "not running" => "not-running", _ => "unknown"
    };
    /// <summary>MSFT_MpThreat.SeverityID → severity.</summary>
    internal static string Severity(uint? id) => id switch { 1 => "low", 2 => "moderate", 4 => "high", 5 => "severe", _ => "unknown" };
    /// <summary>MSFT_MpThreatDetection.ThreatStatusID → status.</summary>
    internal static string Status(uint? id) => id switch
    {
        1 => "detected", 2 => "cleaned", 3 => "quarantined", 4 => "removed", 5 => "allowed", 6 => "blocked",
        102 or 103 or 104 or 107 => "failed", 105 => "abandoned", _ => "unknown"
    };
    /// <summary>Without a threat row, a detection is active while Defender has not resolved it.</summary>
    internal static bool ActiveByStatus(string status) => status is "detected" or "failed" or "abandoned";
    private static readonly string[] SeverityOrder = ["unknown", "low", "moderate", "high", "severe"];
    internal static int SeverityRank(string severity) => Array.IndexOf(SeverityOrder, severity);
    /// <summary>The SecurityCenter2 productState: bits 12–15 equal to 1 mean the product is on.</summary>
    internal static bool ProductEnabled(uint? state) => state is uint value && ((value >> 12) & 0xF) == 1;
    private static readonly Regex ResourcePrefix = new("^[A-Za-z]+:_", RegexOptions.CultureInvariant);
    /// <summary>A resource without its type prefix ("file:_C:\x" → "C:\x").</summary>
    internal static string StripResource(string resource) => ResourcePrefix.Replace(resource, "", 1);
    /// <summary>A time before 1980 (the epoch, the FILETIME zero or DateTime.MinValue) is no time.</summary>
    internal static string? Time(DateTimeOffset? value) => value is DateTimeOffset time && time.UtcDateTime.Year >= 1980 ? time.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture) : null;
    private static string? Short(string? text, int maximum) => string.IsNullOrWhiteSpace(text) ? null : Limit(text.Trim(), maximum);

    internal sealed record DetectionSummary(List<JsonObject> Items, int Count, int Active, string? HighestActiveSeverity);
    /// <summary>The newest 100 detections by time, the total, the active count over all detections and the highest active severity.</summary>
    internal static DetectionSummary DetectionList(IReadOnlyList<DefenderDetectionRow> detections, IReadOnlyList<DefenderThreatRow> threats)
    {
        var byThreat = new Dictionary<string, DefenderThreatRow>(StringComparer.Ordinal);
        foreach (var threat in threats) byThreat.TryAdd(threat.ThreatId, threat);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var rows = new List<(DefenderDetectionRow Row, string Severity, string Status, bool Active, string? Name)>();
        foreach (var detection in detections)
        {
            if (detection.Id.Length == 0 || !seen.Add(detection.Id)) continue;
            byThreat.TryGetValue(detection.ThreatId, out var threat);
            string status = Status(detection.StatusId), severity = Severity(threat?.SeverityId);
            bool active = threat?.IsActive ?? ActiveByStatus(status);
            rows.Add((detection, severity, status, active, threat?.Name));
        }
        int activeCount = rows.Count(row => row.Active);
        string? highest = rows.Where(row => row.Active).Select(row => row.Severity).OrderByDescending(SeverityRank).FirstOrDefault();
        var items = rows.OrderByDescending(row => row.Row.At ?? DateTimeOffset.MinValue).ThenBy(row => row.Row.Id, StringComparer.Ordinal).Take(MaximumDetections).Select(row =>
        {
            var resources = row.Row.Resources.Where(resource => !string.IsNullOrWhiteSpace(resource)).ToList();
            return new JsonObject
            {
                ["id"] = Limit(row.Row.Id, MaximumText), ["threatId"] = Limit(row.Row.ThreatId, MaximumText), ["name"] = Short(row.Name, MaximumText),
                ["severity"] = row.Severity, ["status"] = row.Status, ["active"] = row.Active,
                ["path"] = resources.Count > 0 ? Short(StripResource(resources[0]), MaximumText) : null, ["resourceCount"] = resources.Count,
                ["at"] = Time(row.Row.At), ["user"] = Short(row.Row.User, MaximumText)
            };
        }).ToList();
        return new DetectionSummary(items, rows.Count, activeCount, highest);
    }

    /// <summary>The three exclusion lists, each with at most 200 entries of at most 500 characters.</summary>
    internal static JsonObject? ExclusionsJson(DefenderExclusionRows rows)
    {
        static JsonArray List(IReadOnlyList<string> values) => new(values.Where(value => !string.IsNullOrWhiteSpace(value)).Select(value => Limit(value.Trim(), MaximumText)).Distinct(StringComparer.OrdinalIgnoreCase).Take(MaximumExclusions).Select(value => (JsonNode)JsonValue.Create(value)!).ToArray());
        // Without administrator rights Defender answers with a placeholder instead of the lists: that is no exclusion.
        if (rows.Paths.Concat(rows.Extensions).Concat(rows.Processes).Any(value => value.StartsWith("N/A:", StringComparison.OrdinalIgnoreCase))) throw new UnauthorizedAccessException("The exclusions need administrator rights.");
        return new JsonObject { ["paths"] = List(rows.Paths), ["extensions"] = List(rows.Extensions), ["processes"] = List(rows.Processes) };
    }

    /// <summary>The third-party antivirus products (Defender itself is left out), at most 4; null without SecurityCenter2.</summary>
    internal static JsonArray? OtherAntivirus(IReadOnlyList<AntivirusProductRow>? products) => products is null ? null : new JsonArray(products
        .Where(product => !(product.SignedProductExe ?? "").TrimStart().StartsWith("windowsdefender://", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(product.Name))
        .Take(MaximumAntivirus).Select(product => (JsonNode)new JsonObject { ["name"] = Limit(product.Name.Trim(), MaximumProductName), ["enabled"] = ProductEnabled(product.ProductState) }).ToArray());
}

// Read-only WMI queries of the five Defender and Security Center classes.
internal sealed class WmiDefenderProvider : IDefenderProvider
{
    private const string DefenderNamespace = @"root\Microsoft\Windows\Defender";
    private const string SecurityCenterNamespace = @"root\SecurityCenter2";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    public DefenderStatusRow Status()
    {
        Dictionary<string, object?>? row;
        // SELECT *: IsTamperProtected and AMRunningMode are missing on older Defender platforms, and naming a missing property fails the whole query.
        try { row = Query(DefenderNamespace, "SELECT * FROM MSFT_MpComputerStatus", 1, Timeout).FirstOrDefault(); }
        catch (ManagementException error) when (error.ErrorCode is ManagementStatus.InvalidNamespace or ManagementStatus.InvalidClass or ManagementStatus.NotFound) { throw new DefenderUnavailableException("Microsoft Defender is not installed."); }
        if (row is null) throw new DefenderUnavailableException("Microsoft Defender reports no status.");
        return new DefenderStatusRow(Flag(row, "AntivirusEnabled") ?? false, Flag(row, "RealTimeProtectionEnabled") ?? false, Value(row, "AMRunningMode"), Flag(row, "IsTamperProtected"),
            Moment(row, "QuickScanEndTime"), Moment(row, "FullScanEndTime"), Moment(row, "AntivirusSignatureLastUpdated"), Value(row, "AntivirusSignatureVersion"), Value(row, "AMProductVersion"));
    }

    public IReadOnlyList<DefenderDetectionRow> Detections() => Query(DefenderNamespace, "SELECT DetectionID,ThreatID,ThreatStatusID,Resources,InitialDetectionTime,DomainUser FROM MSFT_MpThreatDetection", 5000, Timeout)
        .Select(row => new DefenderDetectionRow(Value(row, "DetectionID") ?? "", Value(row, "ThreatID") ?? "", Unsigned(row, "ThreatStatusID"), Strings(row, "Resources", 1000), Moment(row, "InitialDetectionTime"), Value(row, "DomainUser"))).ToList();

    public IReadOnlyList<DefenderThreatRow> Threats() => Query(DefenderNamespace, "SELECT ThreatID,ThreatName,SeverityID,IsActive FROM MSFT_MpThreat", 5000, Timeout)
        .Select(row => new DefenderThreatRow(Value(row, "ThreatID") ?? "", Value(row, "ThreatName"), Unsigned(row, "SeverityID"), Flag(row, "IsActive"))).ToList();

    public DefenderExclusionRows Exclusions()
    {
        var row = Query(DefenderNamespace, "SELECT ExclusionPath,ExclusionExtension,ExclusionProcess FROM MSFT_MpPreference", 1, Timeout).FirstOrDefault() ?? throw new InvalidDataException("Microsoft Defender reports no preferences.");
        return new DefenderExclusionRows(Strings(row, "ExclusionPath", 1000), Strings(row, "ExclusionExtension", 1000), Strings(row, "ExclusionProcess", 1000));
    }

    public IReadOnlyList<AntivirusProductRow>? AntivirusProducts()
    {
        try
        {
            return Query(SecurityCenterNamespace, "SELECT displayName,pathToSignedProductExe,productState FROM AntiVirusProduct", 32, Timeout)
                .Select(row => new AntivirusProductRow(Value(row, "displayName") ?? "", Value(row, "pathToSignedProductExe"), Unsigned(row, "productState"))).ToList();
        }
        // Windows Server has no Security Center.
        catch (ManagementException error) when (error.ErrorCode is ManagementStatus.InvalidNamespace or ManagementStatus.InvalidClass or ManagementStatus.NotFound) { return null; }
    }

    private static string? Value(Dictionary<string, object?> row, string name) => row.TryGetValue(name, out var value) && value is not null && Convert.ToString(value, CultureInfo.InvariantCulture) is { Length: > 0 } text ? text : null;
    private static bool? Flag(Dictionary<string, object?> row, string name)
    {
        try { return row.TryGetValue(name, out var value) && value is not null ? Convert.ToBoolean(value, CultureInfo.InvariantCulture) : null; } catch (Exception error) when (error is FormatException or InvalidCastException) { return null; }
    }
    private static uint? Unsigned(Dictionary<string, object?> row, string name)
    {
        try { return row.TryGetValue(name, out var value) && value is not null ? Convert.ToUInt32(value, CultureInfo.InvariantCulture) : null; } catch (Exception error) when (error is FormatException or InvalidCastException or OverflowException) { return null; }
    }
    private static DateTimeOffset? Moment(Dictionary<string, object?> row, string name)
    {
        if (Value(row, name) is not string text) return null;
        try { return new DateTimeOffset(ManagementDateTimeConverter.ToDateTime(text).ToUniversalTime(), TimeSpan.Zero); }
        catch (Exception error) when (error is ArgumentException or ArgumentOutOfRangeException or FormatException) { }
        return DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed) ? parsed.ToUniversalTime() : null;
    }
}
