using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace ServerDesk.Agent;

// The installed programs (docs/v3-health-signals.md) from the uninstall keys:
// the 64-bit and 32-bit views of HKLM and the hives of signed-in users that are
// already loaded under HKEY_USERS. Only the display values below are read; path
// values never enter the result, and a user folder in a reported string is
// shortened to X:\Users\…. The list is sent only when its checksum changes
// (SoftwareUploadPolicy); every heartbeat carries the checksum.
internal sealed record SoftwareKey(string Name, IReadOnlyDictionary<string, object?> Values);
internal sealed record SoftwareHive(string Scope, string? Architecture, string Owner, IReadOnlyList<SoftwareKey> Keys);

internal interface ISoftwareRegistryReader { IEnumerable<SoftwareHive> Read(); }

internal sealed partial class NativeSoftwareInventory(ISoftwareRegistryReader? reader = null)
{
    internal const int IntervalSeconds = 900;
    internal const int DeadlineSeconds = 20;
    internal const int MaximumItems = 2000;
    // The portal accepts at most 1 MiB per report; the list stays below this budget.
    internal const int MaximumBytes = 900_000;
    internal static readonly string[] ValueNames = ["DisplayName", "DisplayVersion", "Publisher", "InstallDate", "SystemComponent", "ParentKeyName", "ReleaseType"];
    private static readonly HashSet<string> UpdateTypes = new(["Update", "Hotfix", "Security Update"], StringComparer.OrdinalIgnoreCase);
    private readonly ISoftwareRegistryReader registry = reader ?? new WindowsSoftwareRegistry();

    /// <summary>The collector result: the checksum for the heartbeat and the list for the upload (never part of the snapshot).</summary>
    internal JsonObject Collect()
    {
        var (items, count, truncated) = Inventory();
        string checksum = Checksum(items);
        return new JsonObject
        {
            ["softwareChecksum"] = checksum,
            [NativeTelemetryCollector.SoftwareInventoryKey] = new JsonObject { ["checksum"] = checksum, ["count"] = count, ["truncated"] = truncated, ["items"] = new JsonArray(items.Select(Item).ToArray()) }
        };
    }

    internal (List<SoftwareEntry> Items, int Count, bool Truncated) Inventory()
    {
        var entries = new List<SoftwareEntry>(); var users = new HashSet<string>(StringComparer.Ordinal);
        foreach (var hive in registry.Read().OrderBy(h => h.Scope, StringComparer.Ordinal).ThenBy(h => h.Owner, StringComparer.Ordinal))
            foreach (var key in hive.Keys)
            {
                var entry = Entry(hive, key);
                if (entry is null) continue;
                // A program installed for several users is one entry; no SID or user name is sent.
                if (entry.Scope == "user" && !users.Add(entry.Key)) continue;
                entries.Add(entry);
            }
        entries.Sort(Compare);
        var items = entries.Take(MaximumItems).ToList();
        int bytes = 2;
        for (int i = 0; i < items.Count; i++)
        {
            bytes += Encoding.UTF8.GetByteCount(Item(items[i]).ToJsonString()) + 1;
            if (bytes > MaximumBytes) { items.RemoveRange(i, items.Count - i); break; }
        }
        return (items, entries.Count, entries.Count > items.Count);
    }

    internal static SoftwareEntry? Entry(SoftwareHive hive, SoftwareKey key)
    {
        string? Value(string name) => key.Values.TryGetValue(name, out var value) && value is not null ? Convert.ToString(value, CultureInfo.InvariantCulture)?.Trim() : null;
        string? name = Value("DisplayName");
        if (string.IsNullOrWhiteSpace(name) || Value("SystemComponent") == "1" || !string.IsNullOrWhiteSpace(Value("ParentKeyName")) || Value("ReleaseType") is string release && UpdateTypes.Contains(release)) return null;
        string? Clean(string? value) { if (string.IsNullOrWhiteSpace(value)) return null; string text = Scrub(value.Trim()); return text.Length <= 256 ? text : text[..256]; }
        string subkey = Clean(key.Name) ?? "";
        if (subkey.Length == 0) return null;
        return new SoftwareEntry(subkey, Clean(name)!, Clean(Value("DisplayVersion")), Clean(Value("Publisher")), InstallDate(Value("InstallDate")), hive.Scope == "user" ? null : hive.Architecture, hive.Scope == "user" ? "user" : "machine");
    }

    /// <summary>YYYY-MM-DD from a valid InstallDate (yyyyMMdd or yyyy-MM-dd), else null.</summary>
    internal static string? InstallDate(string? value)
    {
        if (value is null) return null;
        return DateTime.TryParseExact(value.Trim(), ["yyyyMMdd", "yyyy-MM-dd"], CultureInfo.InvariantCulture, DateTimeStyles.None, out var date) && date.Year >= 1980 && date.Year <= 2100 ? date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null;
    }

    /// <summary>Replaces the user name in X:\Users\name with "…".</summary>
    internal static string Scrub(string value) => UserFolder().Replace(value, match =>
    {
        string sep = match.Groups["sep"].Value;
        string root = match.Groups["root"].Value.Equals("Users", StringComparison.OrdinalIgnoreCase) ? "Users" : "Documents and Settings";
        return match.Groups["drive"].Value + ":" + sep + root + match.Groups["sep2"].Value + "…";
    });

    internal static int Compare(SoftwareEntry a, SoftwareEntry b)
    {
        int order = string.CompareOrdinal(a.Scope, b.Scope);
        if (order == 0) order = string.CompareOrdinal(a.Architecture ?? "", b.Architecture ?? "");
        return order != 0 ? order : string.CompareOrdinal(a.Key, b.Key);
    }

    private static JsonNode Item(SoftwareEntry entry) => new JsonObject { ["key"] = entry.Key, ["name"] = entry.Name, ["version"] = entry.Version, ["publisher"] = entry.Publisher, ["installDate"] = entry.InstallDate, ["architecture"] = entry.Architecture, ["scope"] = entry.Scope };

    /// <summary>
    /// SHA-256 (lower-case hex) over the canonical JSON that lib/software-inventory.ts
    /// builds with JSON.stringify: an array of [scope,architecture,key,name,version,
    /// publisher,installDate] arrays, sorted ordinally by the first three values.
    /// </summary>
    internal static string Checksum(IEnumerable<SoftwareEntry> items)
    {
        var sorted = items.ToList(); sorted.Sort(Compare);
        var json = new StringBuilder("[");
        for (int i = 0; i < sorted.Count; i++)
        {
            var item = sorted[i];
            if (i > 0) json.Append(',');
            json.Append('[');
            string?[] values = [item.Scope, item.Architecture, item.Key, item.Name, item.Version, item.Publisher, item.InstallDate];
            for (int j = 0; j < values.Length; j++) { if (j > 0) json.Append(','); AppendJson(json, values[j]); }
            json.Append(']');
        }
        json.Append(']');
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json.ToString()))).ToLowerInvariant();
    }

    // The escaping of JSON.stringify: quote, backslash and control characters; lone surrogates as \uXXXX; everything else literal.
    internal static void AppendJson(StringBuilder json, string? value)
    {
        if (value is null) { json.Append("null"); return; }
        json.Append('"');
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            switch (c)
            {
                case '"': json.Append("\\\""); break;
                case '\\': json.Append("\\\\"); break;
                case '\b': json.Append("\\b"); break;
                case '\f': json.Append("\\f"); break;
                case '\n': json.Append("\\n"); break;
                case '\r': json.Append("\\r"); break;
                case '\t': json.Append("\\t"); break;
                default:
                    if (c < 0x20) json.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1])) { json.Append(c).Append(value[i + 1]); i++; }
                    else if (char.IsSurrogate(c)) json.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else json.Append(c);
                    break;
            }
        }
        json.Append('"');
    }

    // X:\Users\name or X:\Documents and Settings\name, with \ or / each (C:/Users/alice/..., C:\Users/alice\...).
    [GeneratedRegex(@"(?<drive>[A-Za-z]):(?<sep>[\\/])(?<root>Users|Documents and Settings)(?<sep2>[\\/])[^\\/""\r\n]+", RegexOptions.IgnoreCase)] private static partial Regex UserFolder();
}

internal sealed record SoftwareEntry(string Key, string Name, string? Version, string? Publisher, string? InstallDate, string? Architecture, string Scope);

// Reads only NativeSoftwareInventory.ValueNames of every uninstall subkey. User
// hives are those of signed-in users that Windows already loaded; the agent
// never loads a hive.
internal sealed partial class WindowsSoftwareRegistry : ISoftwareRegistryReader
{
    private const string Uninstall = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    private const int MaximumKeys = 10_000;

    public IEnumerable<SoftwareHive> Read()
    {
        if (!OperatingSystem.IsWindows()) yield break;
        string native = RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "arm64" : "x64";
        yield return Hive(RegistryHive.LocalMachine, RegistryView.Registry64, "machine", native, "machine");
        yield return Hive(RegistryHive.LocalMachine, RegistryView.Registry32, "machine", "x86", "machine");
        string[] sids;
        try { sids = Registry.Users.GetSubKeyNames(); } catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException) { sids = []; }
        foreach (string sid in sids.Where(name => UserSid().IsMatch(name)).Order(StringComparer.Ordinal).Take(200))
        {
            var keys = new List<SoftwareKey>();
            try { using var key = Registry.Users.OpenSubKey(sid + @"\" + Uninstall); if (key is not null) keys = Keys(key); }
            catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException) { }
            yield return new SoftwareHive("user", null, sid, keys);
        }
    }

    private static SoftwareHive Hive(RegistryHive hive, RegistryView view, string scope, string architecture, string owner)
    {
        using var root = RegistryKey.OpenBaseKey(hive, view);
        using var key = root.OpenSubKey(Uninstall);
        return new SoftwareHive(scope, architecture, owner + ":" + architecture, key is null ? [] : Keys(key));
    }

    private static List<SoftwareKey> Keys(RegistryKey uninstall)
    {
        var result = new List<SoftwareKey>();
        foreach (string name in uninstall.GetSubKeyNames().Take(MaximumKeys))
        {
            try
            {
                using var key = uninstall.OpenSubKey(name);
                if (key is null) continue;
                var values = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
                foreach (string value in NativeSoftwareInventory.ValueNames) values[value] = key.GetValue(value, null, RegistryValueOptions.None);
                result.Add(new SoftwareKey(name, values));
            }
            catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException) { }
        }
        return result;
    }

    [GeneratedRegex(@"^S-1-5-21-[0-9-]+$")] private static partial Regex UserSid();
}

// When the worker posts the list to POST /api/agent/software: the checksum
// differs from the one the portal acknowledged, or the heartbeat answer asks
// with softwareResync. At most one upload per 60 s; failures back off.
internal sealed class SoftwareUploadPolicy
{
    internal static readonly TimeSpan MinimumSpacing = TimeSpan.FromSeconds(60);
    internal static readonly TimeSpan MaximumBackoff = TimeSpan.FromMinutes(30);
    private string? acknowledged;
    private bool resync;
    private DateTimeOffset nextAttempt = DateTimeOffset.MinValue;
    private int failures;
    internal string? Acknowledged => acknowledged;

    /// <summary>The heartbeat answer for a snapshot with this checksum: softwareResync, or none (the portal holds this checksum).</summary>
    internal void Heartbeat(string? checksum, bool resyncRequested)
    {
        if (resyncRequested) resync = true;
        else if (checksum is not null) { acknowledged = checksum; resync = false; }
    }
    internal bool ShouldUpload(string? checksum, DateTimeOffset now) => checksum is not null && (resync || checksum != acknowledged) && now >= nextAttempt;
    internal void Succeeded(string checksum, DateTimeOffset now) { acknowledged = checksum; resync = false; failures = 0; nextAttempt = now + MinimumSpacing; }
    internal void Failed(DateTimeOffset now)
    {
        failures = Math.Min(failures + 1, 16);
        var wait = TimeSpan.FromTicks(Math.Min(MaximumBackoff.Ticks, MinimumSpacing.Ticks * (1L << Math.Min(failures - 1, 10))));
        nextAttempt = now + wait;
    }
}
