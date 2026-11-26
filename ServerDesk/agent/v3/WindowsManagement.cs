using System.Globalization;
using System.Management;

namespace ServerDesk.Agent;

// Local WMI access only. Copy and dispose COM-backed rows before exposing a
// result to another collector. Provider timeouts are supplemented by the
// collector's single-flight deadline: an unresponsive provider never blocks a
// heartbeat or creates a new abandoned query on every refresh.
internal static class WindowsManagement
{
    internal static List<Dictionary<string, object?>> Query(string ns, string wql, int max = 1000, TimeSpan? timeout = null)
    {
        var options = new System.Management.EnumerationOptions { ReturnImmediately = true, Rewindable = false, BlockSize = 32, Timeout = timeout ?? TimeSpan.FromSeconds(3) };
        using var searcher = new ManagementObjectSearcher(new ManagementScope(ns, new ConnectionOptions { EnablePrivileges = true, Timeout = timeout ?? TimeSpan.FromSeconds(3) }), new ObjectQuery(wql), options);
        using var rows = searcher.Get();
        var result = new List<Dictionary<string, object?>>();
        foreach (ManagementObject row in rows)
        {
            using (row) { if (result.Count >= Math.Clamp(max, 1, 20000)) break; result.Add(Copy(row)); }
        }
        return result;
    }

    internal static Dictionary<string, object?> Invoke(string ns, string path, string method, Dictionary<string, object?>? parameters = null, TimeSpan? timeout = null)
    {
        var scope = new ManagementScope(ns, new ConnectionOptions { EnablePrivileges = true, Timeout = timeout ?? TimeSpan.FromSeconds(10) });
        var targetPath = new ManagementPath(path);
        var getOptions = new ObjectGetOptions { Timeout = timeout ?? TimeSpan.FromSeconds(10) };
        using ManagementObject target = targetPath.IsClass ? new ManagementClass(scope, targetPath, getOptions) : new ManagementObject(scope, targetPath, getOptions);
        using var input = target.GetMethodParameters(method);
        if (parameters is not null) foreach (var pair in parameters) input[pair.Key] = pair.Value;
        using var output = target.InvokeMethod(method, input, new InvokeMethodOptions { Timeout = timeout ?? TimeSpan.FromSeconds(10) });
        return output is null ? new(StringComparer.OrdinalIgnoreCase) : Copy(output);
    }

    internal static Dictionary<string, object?> Copy(ManagementBaseObject value)
    {
        var result = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
        foreach (PropertyData property in value.Properties) result[property.Name] = CopyValue(property.Value);
        try { result["__PATH"] = value["__PATH"]; } catch (ManagementException) { }
        return result;
    }

    private static object? CopyValue(object? value) => value switch
    {
        ManagementBaseObject embedded => Copy(embedded),
        Array array => array.Cast<object?>().Select(CopyValue).ToArray(),
        _ => value
    };
    internal static string Text(Dictionary<string, object?> row, string name, int maximum = 500) => Limit(row.TryGetValue(name, out var value) ? Convert.ToString(value, CultureInfo.InvariantCulture) : null, maximum);
    internal static double Number(Dictionary<string, object?> row, string name, double fallback = 0)
    {
        try { return row.TryGetValue(name, out var value) && value is not null ? Finite(Convert.ToDouble(value, CultureInfo.InvariantCulture), fallback) : fallback; } catch { return fallback; }
    }
    internal static bool Boolean(Dictionary<string, object?> row, string name)
    {
        try { return Convert.ToBoolean(row.GetValueOrDefault(name), CultureInfo.InvariantCulture); } catch { return false; }
    }
    internal static string Date(Dictionary<string, object?> row, string name)
    {
        var text = Text(row, name);
        if (text.Length == 0) return "";
        try { return ManagementDateTimeConverter.ToDateTime(text).ToUniversalTime().ToString("O", CultureInfo.InvariantCulture); } catch { }
        return DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date) ? date.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture) : "";
    }
    internal static string[] Strings(Dictionary<string, object?> row, string name, int max = 20) => row.GetValueOrDefault(name) is System.Collections.IEnumerable values && row.GetValueOrDefault(name) is not string ? values.Cast<object?>().Take(max).Select(v => Limit(Convert.ToString(v, CultureInfo.InvariantCulture))).ToArray() : [];
    internal static string Limit(string? text, int max = 500) => text is null ? "" : text[..Math.Min(text.Length, max)];
    internal static double Finite(double value, double fallback = 0) => double.IsFinite(value) ? value : fallback;
}
