using System.Globalization;
using System.Management;
using System.Text.Json.Nodes;
using static ServerDesk.Agent.WindowsManagement;

namespace ServerDesk.Agent;

// The Windows activation state (docs/v3-health-signals.md, "Windows license in 4.22.0"):
// the Windows row of root\cimv2 SoftwareLicensingProduct with an installed product key.
// The collector reads only the license status, the license channel and the two end
// times. It never selects a product key or a part of one and calls no method of a
// licensing class. The snapshot key is "windowsLicense".
internal sealed record WindowsLicenseRow(string? Description, string? LicenseFamily, string? ProductKeyChannel, uint? LicenseStatus, uint? GracePeriodRemaining, DateTimeOffset? EvaluationEndDate);

/// <summary>Windows refused the full query because it does not know a property (older Windows).</summary>
internal sealed class WindowsLicensePropertyException(string message, Exception? inner = null) : Exception(message, inner);

internal interface IWindowsLicenseProvider
{
    /// <summary>
    /// The Windows rows with an installed product key. full: with ProductKeyChannel and EvaluationEndDate.
    /// Throws WindowsLicensePropertyException when Windows does not know a property of the full query.
    /// </summary>
    IReadOnlyList<WindowsLicenseRow> Rows(bool full);
}

internal sealed class NativeWindowsLicense(IWindowsLicenseProvider? provider = null, Func<DateTimeOffset>? clock = null)
{
    internal const int IntervalSeconds = 3600;
    internal const int DeadlineSeconds = 30;
    /// <summary>The application ID of Windows in the Software Licensing service.</summary>
    internal const string WindowsApplicationId = "55c92734-d682-4d71-983e-d6ec3f16059f";
    private readonly IWindowsLicenseProvider source = provider ?? new WmiWindowsLicenseProvider();
    private readonly Func<DateTimeOffset> now = clock ?? (() => DateTimeOffset.UtcNow);

    internal JsonObject Collect()
    {
        var at = now(); string collectedAt = at.ToString("O", CultureInfo.InvariantCulture);
        JsonObject Unavailable(string reason) => new() { ["windowsLicense"] = new JsonObject { ["available"] = false, ["reason"] = reason, ["collectedAt"] = collectedAt } };
        IReadOnlyList<WindowsLicenseRow> rows;
        try
        {
            // Older Windows does not know ProductKeyChannel or EvaluationEndDate; they are null then.
            try { rows = source.Rows(full: true); }
            catch (WindowsLicensePropertyException) { rows = source.Rows(full: false); }
        }
        catch (UnauthorizedAccessException) { return Unavailable("access-denied"); }
        catch (ManagementException error) when (error.ErrorCode == ManagementStatus.AccessDenied) { return Unavailable("access-denied"); }
        catch (Exception error) when (error is not OutOfMemoryException) { return Unavailable("error"); }
        if (rows.Count == 0) return Unavailable("not-found");
        // A device can have more than one Windows row with a key; the activated one tells the state.
        var row = rows.FirstOrDefault(item => item.LicenseStatus == 1) ?? rows[0];
        return new JsonObject
        {
            ["windowsLicense"] = new JsonObject
            {
                ["available"] = true, ["collectedAt"] = collectedAt, ["status"] = Status(row.LicenseStatus),
                ["channel"] = Channel(row.Description, row.LicenseFamily, row.ProductKeyChannel),
                ["expiresAt"] = ExpiresAt(at, row.GracePeriodRemaining), ["evaluationEndsAt"] = EvaluationEndsAt(row.EvaluationEndDate)
            }
        };
    }

    /// <summary>SoftwareLicensingProduct.LicenseStatus → status.</summary>
    internal static string Status(uint? value) => value switch
    {
        0 => "unlicensed", 1 => "licensed", 2 => "initial-grace", 3 => "additional-grace", 4 => "non-genuine-grace", 5 => "notification", 6 => "extended-grace", _ => "unknown"
    };

    /// <summary>The license channel; the first rule that matches wins, every match ignores case.</summary>
    internal static string Channel(string? description, string? licenseFamily, string? productKeyChannel)
    {
        string text = description ?? "", family = (licenseFamily ?? "").Trim(), channel = (productKeyChannel ?? "").Trim();
        bool Has(string part) => text.Contains(part, StringComparison.OrdinalIgnoreCase);
        bool Is(string value) => string.Equals(channel, value, StringComparison.OrdinalIgnoreCase);
        if (Has("TIMEBASED_EVAL") || family.EndsWith("Eval", StringComparison.OrdinalIgnoreCase)) return "evaluation";
        if (channel.StartsWith("OEM", StringComparison.OrdinalIgnoreCase) || Has("OEM_")) return "oem";
        if (Is("Volume:GVLK") || Has("VOLUME_KMSCLIENT")) return "volume-kms";
        if (Is("Volume:MAK") || Has("VOLUME_MAK")) return "volume-mak";
        if (Is("Retail") || Has("RETAIL")) return "retail";
        return "unknown";
    }

    /// <summary>The collection time in whole minutes plus the remaining minutes, or null without remaining minutes.</summary>
    internal static string? ExpiresAt(DateTimeOffset at, uint? minutes)
    {
        if (minutes is not uint remaining || remaining == 0) return null;
        var utc = at.ToUniversalTime();
        var minute = new DateTimeOffset(utc.Year, utc.Month, utc.Day, utc.Hour, utc.Minute, 0, TimeSpan.Zero);
        return minute.AddMinutes(remaining).ToString("O", CultureInfo.InvariantCulture);
    }

    /// <summary>EvaluationEndDate when it is a real date; Windows reports 1601-01-01 (the FILETIME zero) for no date.</summary>
    internal static string? EvaluationEndsAt(DateTimeOffset? value) => value is DateTimeOffset date && date.UtcDateTime.Year > 1601 ? date.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture) : null;
}

// Read-only WQL queries of root\cimv2 SoftwareLicensingProduct. The select lists name no key property.
internal sealed class WmiWindowsLicenseProvider : IWindowsLicenseProvider
{
    private const string Filter = " FROM SoftwareLicensingProduct WHERE ApplicationID = '" + NativeWindowsLicense.WindowsApplicationId + "' AND PartialProductKey IS NOT NULL";
    internal const string FullQuery = "SELECT Description, LicenseFamily, ProductKeyChannel, LicenseStatus, GracePeriodRemaining, EvaluationEndDate" + Filter;
    internal const string ShortQuery = "SELECT Description, LicenseFamily, LicenseStatus, GracePeriodRemaining" + Filter;
    // The licensing provider is slow; the collector deadline (30 s) stays above this timeout.
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(25);

    public IReadOnlyList<WindowsLicenseRow> Rows(bool full)
    {
        List<Dictionary<string, object?>> rows;
        try { rows = Query(@"root\cimv2", full ? FullQuery : ShortQuery, 32, Timeout); }
        catch (ManagementException error) when (full && error.ErrorCode is ManagementStatus.InvalidQuery or ManagementStatus.InvalidProperty)
        {
            throw new WindowsLicensePropertyException("Windows does not know a property of the license query.", error);
        }
        return rows.Select(row => new WindowsLicenseRow(Value(row, "Description"), Value(row, "LicenseFamily"), full ? Value(row, "ProductKeyChannel") : null,
            Unsigned(row, "LicenseStatus"), Unsigned(row, "GracePeriodRemaining"), full ? Moment(row, "EvaluationEndDate") : null)).ToList();
    }

    private static string? Value(Dictionary<string, object?> row, string name) => row.TryGetValue(name, out var value) && value is not null && Convert.ToString(value, CultureInfo.InvariantCulture) is { Length: > 0 } text ? text : null;
    private static uint? Unsigned(Dictionary<string, object?> row, string name)
    {
        try { return row.TryGetValue(name, out var value) && value is not null ? Convert.ToUInt32(value, CultureInfo.InvariantCulture) : null; } catch (Exception error) when (error is FormatException or InvalidCastException or OverflowException) { return null; }
    }
    private static DateTimeOffset? Moment(Dictionary<string, object?> row, string name)
    {
        if (Value(row, name) is not string text) return null;
        try { return new DateTimeOffset(ManagementDateTimeConverter.ToDateTime(text).ToUniversalTime(), TimeSpan.Zero); }
        catch (Exception error) when (error is ArgumentException or ArgumentOutOfRangeException or FormatException) { return null; }
    }
}
