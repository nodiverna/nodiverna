using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.Management;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace ServerDesk.Agent;

// Reliability and program crashes of the last 30 days (docs/v3-health-signals.md):
// program crashes (Application Error 1000) and hangs (Application Hang 1002) from
// the Application log, failed installations from Win32_ReliabilityRecords, and
// the stability index from Win32_ReliabilityStabilityMetrics. Windows Server
// collects no reliability data by default (WMIEnable = 0); then the stability is
// "not available" with its reason, never an estimate, and only the event log
// entries are reported. Only file names of programs and modules leave the device.
internal sealed record ProgramEvent(DateTimeOffset At, string Kind, string Program, string? Version, string? Module, string? ModuleVersion);
internal sealed record StabilityValue(DateTimeOffset At, double Index);

/// <summary>The reliability provider cannot answer: not-supported, access-denied or error.</summary>
internal sealed class ReliabilityUnavailableException(string reason) : Exception("Reliability data is not available: " + reason) { internal string Reason { get; } = reason; }

internal interface IReliabilitySource
{
    /// <summary>Application Error 1000 and Application Hang 1002 since <paramref name="since"/>.</summary>
    IReadOnlyList<ProgramEvent> ApplicationEvents(DateTimeOffset since);
    /// <summary>False when HKLM\SOFTWARE\Microsoft\Reliability Analysis\WMI WMIEnable is 0.</summary>
    bool CollectionEnabled();
    /// <summary>The stability values since <paramref name="since"/>; throws ReliabilityUnavailableException.</summary>
    IReadOnlyList<StabilityValue> Stability(DateTimeOffset since);
    /// <summary>Failed installations (MsiInstaller 11708, WindowsUpdateClient 20) since <paramref name="since"/>; throws ReliabilityUnavailableException.</summary>
    IReadOnlyList<ProgramEvent> InstallFailures(DateTimeOffset since);
}

internal sealed class NativeReliability(IReliabilitySource? source = null, Func<DateTimeOffset>? clock = null)
{
    internal const int IntervalSeconds = 900;
    internal const int DeadlineSeconds = 25;
    internal const int WindowDays = 30;
    internal const int MaximumEvents = 100;
    private readonly IReliabilitySource reliability = source ?? new WindowsReliabilitySource();
    private readonly Func<DateTimeOffset> now = clock ?? (() => DateTimeOffset.UtcNow);

    internal JsonObject Collect()
    {
        var at = now(); var since = at.AddDays(-WindowDays);
        var events = new List<ProgramEvent>();
        var warnings = new JsonArray();
        try { events.AddRange(reliability.ApplicationEvents(since)); }
        catch (Exception error) when (error is not OutOfMemoryException) { warnings.Add("The Application event log could not be read (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
        JsonObject stability;
        try
        {
            var values = reliability.CollectionEnabled() ? reliability.Stability(since) : [];
            var daily = values.Where(value => value.At >= since && value.At <= at.AddMinutes(5) && double.IsFinite(value.Index))
                .GroupBy(value => value.At.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture))
                .Select(group => (Day: group.Key, Value: group.OrderBy(value => value.At).Last()))
                .OrderBy(day => day.Day, StringComparer.Ordinal).TakeLast(WindowDays).ToList();
            if (daily.Count == 0) stability = new JsonObject { ["available"] = false, ["reason"] = "collection-disabled" };
            else
            {
                stability = new JsonObject
                {
                    ["available"] = true, ["current"] = Index(daily[^1].Value.Index),
                    ["days"] = new JsonArray(daily.Select(day => (JsonNode)new JsonObject { ["day"] = day.Day, ["index"] = Index(day.Value.Index) }).ToArray())
                };
                // Failed installations come from the same provider; without it they are absent.
                try { events.AddRange(reliability.InstallFailures(since)); }
                catch (Exception error) when (error is not OutOfMemoryException) { warnings.Add("The failed installations could not be read (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
            }
        }
        catch (ReliabilityUnavailableException error) { stability = new JsonObject { ["available"] = false, ["reason"] = error.Reason }; }
        catch (Exception error) when (error is not OutOfMemoryException) { stability = new JsonObject { ["available"] = false, ["reason"] = "error" }; }
        var recent = events.Where(item => item.At >= since && item.At <= at.AddMinutes(5)).OrderByDescending(item => item.At).ThenBy(item => item.Program, StringComparer.OrdinalIgnoreCase).ToList();
        var result = new JsonObject
        {
            ["reliability"] = new JsonObject
            {
                ["collectedAt"] = at.ToString("O", CultureInfo.InvariantCulture), ["windowDays"] = WindowDays, ["stability"] = stability,
                ["events"] = new JsonArray(recent.Take(MaximumEvents).Select(Event).ToArray()), ["truncated"] = recent.Count > MaximumEvents
            }
        };
        if (warnings.Count > 0) result["_collectionWarnings"] = warnings;
        return result;
    }

    /// <summary>The index with one decimal, 1.0 to 10.0.</summary>
    internal static double Index(double value) => Math.Round(Math.Clamp(value, 1, 10), 1, MidpointRounding.AwayFromZero);

    private static JsonNode Event(ProgramEvent item) => new JsonObject
    {
        ["at"] = item.At.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture), ["kind"] = item.Kind, ["program"] = item.Program,
        ["version"] = item.Version, ["module"] = item.Module, ["moduleVersion"] = item.ModuleVersion
    };

    /// <summary>The plain file name of a program or module (no folder), at most 256 characters; null when empty.</summary>
    internal static string? FileName(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        string trimmed = value.Trim().Trim('"');
        int separator = Math.Max(trimmed.LastIndexOf('\\'), trimmed.LastIndexOf('/'));
        string name = (separator >= 0 ? trimmed[(separator + 1)..] : trimmed).Trim();
        return name.Length == 0 ? null : name.Length <= 256 ? name : name[..256];
    }
    /// <summary>A short text value (version, product name), at most 256 characters; null when empty. A product name keeps no folder.</summary>
    internal static string? Short(string? value, bool product = false)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        string text = value.Trim();
        if (product && text.Contains('\\')) text = text[(text.LastIndexOf('\\') + 1)..].Trim();
        return text.Length == 0 ? null : text.Length <= 256 ? text : text[..256];
    }
    /// <summary>Application Error 1000: program, version, module, module version from the event data.</summary>
    internal static ProgramEvent? Crash(DateTimeOffset at, IReadOnlyList<string> data)
    {
        string? program = FileName(data.ElementAtOrDefault(0));
        return program is null ? null : new ProgramEvent(at, "crash", program, Short(data.ElementAtOrDefault(1)), FileName(data.ElementAtOrDefault(3)), Short(data.ElementAtOrDefault(4)));
    }
    /// <summary>Application Hang 1002: program and version from the event data.</summary>
    internal static ProgramEvent? Hang(DateTimeOffset at, IReadOnlyList<string> data)
    {
        string? program = FileName(data.ElementAtOrDefault(0));
        return program is null ? null : new ProgramEvent(at, "hang", program, Short(data.ElementAtOrDefault(1)), null, null);
    }
}

internal sealed class WindowsReliabilitySource : IReliabilitySource
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(15);

    public IReadOnlyList<ProgramEvent> ApplicationEvents(DateTimeOffset since)
    {
        var result = new List<ProgramEvent>();
        if (!OperatingSystem.IsWindows()) return result;
        long age = Math.Max(0, (long)(DateTimeOffset.UtcNow - since).TotalMilliseconds);
        string query = "*[System[((Provider[@Name='Application Error'] and EventID=1000) or (Provider[@Name='Application Hang'] and EventID=1002)) and TimeCreated[timediff(@SystemTime) <= " + age.ToString(CultureInfo.InvariantCulture) + "]]]";
        using var reader = new EventLogReader(new EventLogQuery("Application", PathType.LogName, query) { ReverseDirection = true });
        for (int read = 0; read < 2000; read++)
        {
            using var record = reader.ReadEvent();
            if (record is null) break;
            if (record.TimeCreated is not DateTime created) continue;
            var at = new DateTimeOffset(created.ToUniversalTime(), TimeSpan.Zero);
            var data = record.Properties.Take(8).Select(property => Convert.ToString(property.Value, CultureInfo.InvariantCulture) ?? "").ToList();
            var item = record.Id == 1000 ? NativeReliability.Crash(at, data) : NativeReliability.Hang(at, data);
            if (item is not null) result.Add(item);
        }
        return result;
    }

    public bool CollectionEnabled()
    {
        if (!OperatingSystem.IsWindows()) return false;
        using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Reliability Analysis\WMI");
        return key?.GetValue("WMIEnable") is not int value || value != 0;
    }

    public IReadOnlyList<StabilityValue> Stability(DateTimeOffset since) => Guard(() =>
    {
        string from = ManagementDateTimeConverter.ToDmtfDateTime(since.UtcDateTime);
        return WindowsManagement.Query(@"root\cimv2", "SELECT SystemStabilityIndex,TimeGenerated FROM Win32_ReliabilityStabilityMetrics WHERE TimeGenerated >= '" + from + "'", 2000, Timeout)
            .Select(row => (At: Time(row, "TimeGenerated"), Index: WindowsManagement.Number(row, "SystemStabilityIndex", double.NaN))).Where(row => row.At is not null)
            .Select(row => new StabilityValue(row.At!.Value, row.Index)).ToList();
    });

    public IReadOnlyList<ProgramEvent> InstallFailures(DateTimeOffset since) => Guard(() =>
    {
        string from = ManagementDateTimeConverter.ToDmtfDateTime(since.UtcDateTime);
        return WindowsManagement.Query(@"root\cimv2", "SELECT SourceName,EventIdentifier,ProductName,TimeGenerated FROM Win32_ReliabilityRecords WHERE TimeGenerated >= '" + from + "' AND ((SourceName='MsiInstaller' AND EventIdentifier=11708) OR (SourceName='Microsoft-Windows-WindowsUpdateClient' AND EventIdentifier=20))", 500, Timeout)
            .Select(row => (At: Time(row, "TimeGenerated"), Product: NativeReliability.Short(WindowsManagement.Text(row, "ProductName", 1000), product: true))).Where(row => row.At is not null && row.Product is not null)
            .Select(row => new ProgramEvent(row.At!.Value, "install-failure", row.Product!, null, null, null)).ToList();
    });

    private static DateTimeOffset? Time(Dictionary<string, object?> row, string name)
    {
        string text = WindowsManagement.Date(row, name);
        return DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var value) ? value.ToUniversalTime() : null;
    }

    private static T Guard<T>(Func<T> read)
    {
        try { return read(); }
        catch (ManagementException error) when (error.ErrorCode is ManagementStatus.InvalidNamespace or ManagementStatus.InvalidClass or ManagementStatus.NotFound or ManagementStatus.NotSupported) { throw new ReliabilityUnavailableException("not-supported"); }
        catch (ManagementException error) when (error.ErrorCode == ManagementStatus.AccessDenied) { throw new ReliabilityUnavailableException("access-denied"); }
        catch (UnauthorizedAccessException) { throw new ReliabilityUnavailableException("access-denied"); }
        catch (Exception error) when (error is ManagementException or System.Runtime.InteropServices.COMException) { throw new ReliabilityUnavailableException("error"); }
    }
}
