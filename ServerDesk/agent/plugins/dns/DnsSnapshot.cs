using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Plugin.Dns;

// The JSON of the two reads (docs/dns-server.md, lib/dns.ts): dns-read gives
// the server (kind server) with its forwarders, scavenging and zones;
// dns-zone-read gives the records of one zone (kind zone). Zone names are
// lower case without the trailing dot; record names are relative, '@' for the
// zone itself; record data are typed per type, and every other type has {}.
// Both reads fit into 2 MiB: the server cuts its zones last (truncated.zones),
// a zone cuts its records (truncated, with the full total).

/// <summary>One zone as WMI reports it.</summary>
internal sealed record RawZone(string Name, int ZoneType, bool Reverse, bool DsIntegrated, string? Scope, string? Partition, string? DataFile, int AllowUpdate, int SecureSecondaries, string[] SecondaryServers,
    int Notify, string[] NotifyServers, string[] Masters, bool Aging, long NoRefresh, long Refresh, long? ForwarderTimeout, bool Paused, bool AutoCreated, long? Serial, long? RecordCount);
/// <summary>The server settings and its zones as WMI reports them.</summary>
internal sealed record RawServer(string Name, string? Domain, string? Version, bool IsDomainController, string[] ListenAddresses, string[] Forwarders, long ForwarderTimeout, bool UseRootHints,
    long ScavengingInterval, string? LastScavenge, bool DefaultAging, long DefaultNoRefresh, long DefaultRefresh, IReadOnlyList<RawZone> Zones);
/// <summary>One resource record: its owner (a full name), type, TTL, aging timestamp (hours since 1601, 0 for static), text and the typed values by WMI property name.</summary>
internal sealed record RawRecord(string Owner, string Type, long Ttl, long Timestamp, string Text, IReadOnlyDictionary<string, object?> Values);

internal static class DnsSnapshot
{
    internal const int MaximumBytes = 2_097_152;
    internal const int MaximumZones = 2000, MaximumAddresses = 16, MaximumListen = 64;

    internal static string Iso(DateTimeOffset time) => time.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
    /// <summary>An aging timestamp (hours since 1601-01-01 UTC) as ISO time, or null for a static record.</summary>
    internal static string? Timestamp(long hours) => hours <= 0 ? null : Iso(new DateTimeOffset(1601, 1, 1, 0, 0, 0, TimeSpan.Zero).AddHours(hours));
    /// <summary>A server address in its canonical text (IPv6 compressed, lower case), or null.</summary>
    internal static string? Address(string? value) => IPAddress.TryParse((value ?? "").Trim(), out var address) && (address.AddressFamily is System.Net.Sockets.AddressFamily.InterNetwork or System.Net.Sockets.AddressFamily.InterNetworkV6) && (value ?? "").Trim().All(c => char.IsAsciiHexDigit(c) || c is '.' or ':') ? address.ToString().ToLowerInvariant() : null;
    private static JsonArray Addresses(IEnumerable<string> values, int max) => new(values.Select(Address).Where(item => item is not null).Distinct().Take(max).Select(item => (JsonNode)JsonValue.Create(item)!).ToArray());
    private static JsonObject Aging(bool enabled, long noRefresh, long refresh) => new() { ["enabled"] = enabled, ["noRefreshHours"] = Math.Clamp(noRefresh, 0, 87600), ["refreshHours"] = Math.Clamp(refresh, 0, 87600) };

    internal static string Kind(int zoneType) => zoneType switch { 1 => "primary", 2 => "secondary", 3 => "stub", 4 => "forwarder", _ => "" };
    internal static string Dynamic(int allowUpdate) => allowUpdate switch { 1 => "nonsecureAndSecure", 2 => "secure", _ => "none" };
    internal static string Transfers(int secureSecondaries) => secureSecondaries switch { 0 => "any", 1 => "nameServers", 2 => "list", _ => "none" };
    internal static string NotifyMode(int notify) => notify switch { 1 => "nameServers", 2 => "list", _ => "off" };
    internal static string? Scope(string? scope) => scope?.ToLowerInvariant() switch { "forest" => "forest", "domain" => "domain", "legacy" => "legacy", "custom" => "custom", _ => null };

    /// <summary>The number of an enum value of root\Microsoft\Windows\DNS: the index of its name (any case) in names, or the number itself; -1 when neither.</summary>
    private static int EnumNumber(object? value, params string[] names) => value is string text
        ? Array.FindIndex(names, name => string.Equals(name, text.Trim(), StringComparison.OrdinalIgnoreCase))
        : WmiValue.Number(value) is long number && number is >= 0 and <= int.MaxValue ? (int)number : -1;

    /// <summary>
    /// One DnsServerZone instance of root\Microsoft\Windows\DNS (any subclass:
    /// primary, secondary, stub, conditional forwarder) as a RawZone with the
    /// numbers of MicrosoftDNS_Zone; get reads one property (null when the class
    /// has none). The enums come as names or as numbers. Aging values, serial and
    /// record count are 0 or null. Null for a zone without a name.
    /// </summary>
    internal static RawZone? ModernZone(Func<string, object?> get)
    {
        string name = DnsText.Name(WmiValue.Text(get("ZoneName")));
        if (name.Length == 0) return null;
        int type = Math.Max(0, EnumNumber(get("ZoneType"), "Cache", "Primary", "Secondary", "Stub", "Forwarder"));
        int update = Math.Max(0, EnumNumber(get("DynamicUpdate"), "None", "NonsecureAndSecure", "Secure"));
        int secure = EnumNumber(get("SecureSecondaries"), "TransferAnyServer", "TransferToZoneNameServer", "TransferToSecureServers", "NoTransfer");
        int notify = Math.Max(0, EnumNumber(get("Notify"), "NoNotify", "Notify", "NotifyServers"));
        return new RawZone(name, type, WmiValue.Flag(get("IsReverseLookupZone")), WmiValue.Flag(get("IsDsIntegrated")), WmiValue.Text(get("ReplicationScope")), WmiValue.Text(get("DirectoryPartitionName")), WmiValue.Text(get("ZoneFile")),
            update, secure < 0 ? 3 : secure, WmiValue.List(get("SecondaryServers")), notify, WmiValue.List(get("NotifyServers")), WmiValue.List(get("MasterServers")), false, 0, 0,
            WmiValue.Number(get("ForwarderTimeout")), WmiValue.Flag(get("IsPaused")), WmiValue.Flag(get("IsAutoCreated")), null, null);
    }

    /// <summary>
    /// The zone list of a read and of the changes: every MicrosoftDNS_Zone row,
    /// with the replication scope and partition of the DnsServerZone row of the
    /// same name, then every DnsServerZone row whose name MicrosoftDNS_Zone does
    /// not list. A name in both keeps the MicrosoftDNS_Zone row.
    /// </summary>
    internal static List<RawZone> MergeZones(IReadOnlyList<RawZone> legacy, IReadOnlyList<RawZone> modern)
    {
        var byName = modern.GroupBy(zone => DnsText.Name(zone.Name)).ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        var list = legacy.Select(zone => byName.TryGetValue(DnsText.Name(zone.Name), out var cim) ? zone with { Scope = cim.Scope, Partition = cim.Partition } : zone).ToList();
        var known = new HashSet<string>(list.Select(zone => DnsText.Name(zone.Name)), StringComparer.Ordinal);
        foreach (var zone in modern) if (known.Add(DnsText.Name(zone.Name))) list.Add(zone);
        return list;
    }

    /// <summary>One zone of the server read; null for the cache and root hints zones.</summary>
    internal static JsonObject? Zone(RawZone zone)
    {
        string kind = Kind(zone.ZoneType), name = DnsText.Name(zone.Name);
        if (kind.Length == 0 || name.Length == 0 || name.Length > 255) return null;
        bool ad = zone.DsIntegrated, primary = kind == "primary";
        return new JsonObject
        {
            ["name"] = name, ["kind"] = kind, ["lookup"] = zone.Reverse || name.EndsWith(".in-addr.arpa", StringComparison.Ordinal) || name.EndsWith(".ip6.arpa", StringComparison.Ordinal) ? "reverse" : "forward",
            ["storage"] = ad ? "ad" : "file", ["replicationScope"] = ad ? Scope(zone.Scope) : null, ["partition"] = ad && Scope(zone.Scope) == "custom" ? zone.Partition : null,
            ["fileName"] = ad ? null : zone.DataFile, ["dynamicUpdate"] = kind is "primary" ? Dynamic(zone.AllowUpdate) : "none",
            ["transfers"] = new JsonObject { ["mode"] = Transfers(zone.SecureSecondaries), ["servers"] = Addresses(zone.SecondaryServers, MaximumAddresses) },
            ["notify"] = new JsonObject { ["mode"] = NotifyMode(zone.Notify), ["servers"] = Addresses(zone.NotifyServers, MaximumAddresses) },
            ["masters"] = Addresses(zone.Masters, MaximumAddresses), ["aging"] = primary ? Aging(zone.Aging, zone.NoRefresh, zone.Refresh) : null,
            ["forwarderTimeoutSeconds"] = kind == "forwarder" ? zone.ForwarderTimeout is long timeout ? Math.Clamp(timeout, 0, 3600) : null : null,
            ["paused"] = zone.Paused, ["autoCreated"] = zone.AutoCreated, ["serial"] = zone.Serial is long serial && serial is >= 0 and <= uint.MaxValue ? serial : null, ["recordCount"] = zone.RecordCount,
        };
    }

    /// <summary>dns-read: the server, its forwarders and scavenging, and its zones (the 2000 first, in name order).</summary>
    internal static JsonObject Server(RawServer raw, DateTimeOffset now)
    {
        var zones = raw.Zones.Select(Zone).Where(zone => zone is not null).Cast<JsonObject>().OrderBy(zone => zone["name"]!.GetValue<string>(), StringComparer.Ordinal).ToList();
        bool enabled = raw.ScavengingInterval > 0;
        return new JsonObject
        {
            ["kind"] = "server", ["collectedAt"] = Iso(now), ["service"] = "running",
            ["server"] = new JsonObject { ["name"] = raw.Name, ["domain"] = raw.Domain, ["version"] = raw.Version, ["isDomainController"] = raw.IsDomainController, ["listenAddresses"] = Addresses(raw.ListenAddresses, MaximumListen) },
            ["forwarders"] = new JsonObject { ["servers"] = Addresses(raw.Forwarders, MaximumAddresses), ["timeoutSeconds"] = Math.Clamp(raw.ForwarderTimeout, 0, 3600), ["useRootHints"] = raw.UseRootHints },
            ["scavenging"] = new JsonObject { ["enabled"] = enabled, ["intervalHours"] = Math.Clamp(raw.ScavengingInterval, 0, 87600), ["lastRunAt"] = raw.LastScavenge, ["defaultAging"] = Aging(raw.DefaultAging, raw.DefaultNoRefresh, raw.DefaultRefresh) },
            ["zones"] = new JsonArray(zones.Take(MaximumZones).ToArray<JsonNode>()),
            ["truncated"] = new JsonObject { ["zones"] = zones.Count > MaximumZones },
        };
    }
    /// <summary>A stopped service: the server facts and empty lists.</summary>
    internal static JsonObject Stopped(string name, string? domain, DateTimeOffset now) => new()
    {
        ["kind"] = "server", ["collectedAt"] = Iso(now), ["service"] = "stopped",
        ["server"] = new JsonObject { ["name"] = name, ["domain"] = domain, ["version"] = null, ["isDomainController"] = false, ["listenAddresses"] = new JsonArray() },
        ["forwarders"] = new JsonObject { ["servers"] = new JsonArray(), ["timeoutSeconds"] = 0, ["useRootHints"] = true },
        ["scavenging"] = new JsonObject { ["enabled"] = false, ["intervalHours"] = 0, ["lastRunAt"] = null, ["defaultAging"] = Aging(false, 0, 0) },
        ["zones"] = new JsonArray(), ["truncated"] = new JsonObject { ["zones"] = false },
    };

    // ---- Records ----------------------------------------------------------------------------------
    /// <summary>The record name relative to its zone: '@' for the zone itself.</summary>
    internal static string Relative(string owner, string zone)
    {
        string name = DnsText.Name(owner);
        if (name == zone || name.Length == 0) return "@";
        return name.EndsWith("." + zone, StringComparison.Ordinal) ? name[..^(zone.Length + 1)] : name;
    }
    private static string Str(IReadOnlyDictionary<string, object?> values, string key) => values.TryGetValue(key, out var value) && value is not null ? Convert.ToString(value, CultureInfo.InvariantCulture) ?? "" : "";
    private static long Num(IReadOnlyDictionary<string, object?> values, string key) => values.TryGetValue(key, out var value) ? value switch { int number => (uint)number, long number => number, string text when long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out long parsed) => parsed, _ => 0 } : 0;
    /// <summary>The typed data of a record (lib/dns.ts dnsRecordDataSchemas); {} for a type the portal shows only as text.</summary>
    internal static JsonObject Data(string type, IReadOnlyDictionary<string, object?> v) => type switch
    {
        "A" => new JsonObject { ["address"] = Address(Str(v, "IPAddress")) ?? Str(v, "IPAddress") },
        "AAAA" => new JsonObject { ["address"] = Address(Str(v, "IPv6Address")) ?? Str(v, "IPv6Address") },
        "CNAME" => new JsonObject { ["target"] = DnsText.Name(Str(v, "PrimaryName")) },
        "PTR" => new JsonObject { ["host"] = DnsText.Name(Str(v, "PTRDomainName")) },
        "NS" => new JsonObject { ["nameServer"] = DnsText.Name(Str(v, "NSHost")) },
        "MX" => new JsonObject { ["preference"] = Math.Clamp(Num(v, "Preference"), 0, 65535), ["exchange"] = DnsText.Name(Str(v, "MailExchange")) },
        "TXT" => new JsonObject { ["strings"] = new JsonArray(DnsText.TxtStrings(Str(v, "DescriptiveText")).Take(16).Select(item => (JsonNode)JsonValue.Create(item.Length > 255 ? item[..255] : item)!).DefaultIfEmpty(JsonValue.Create("")!).ToArray()) },
        "SRV" => new JsonObject { ["priority"] = Math.Clamp(Num(v, "Priority"), 0, 65535), ["weight"] = Math.Clamp(Num(v, "Weight"), 0, 65535), ["port"] = Math.Clamp(Num(v, "Port"), 0, 65535), ["target"] = Str(v, "DomainName").Trim() == "." ? "." : DnsText.Name(Str(v, "DomainName")) },
        "SOA" => new JsonObject
        {
            ["primaryServer"] = DnsText.Name(Str(v, "PrimaryServer")), ["responsiblePerson"] = DnsText.Name(Str(v, "ResponsibleParty")), ["serial"] = Math.Clamp(Num(v, "SerialNumber"), 0, uint.MaxValue),
            ["refreshSeconds"] = Math.Clamp(Num(v, "RefreshInterval"), 0, uint.MaxValue), ["retrySeconds"] = Math.Clamp(Num(v, "RetryDelay"), 0, uint.MaxValue), ["expireSeconds"] = Math.Clamp(Num(v, "ExpireLimit"), 0, uint.MaxValue), ["minimumTtlSeconds"] = Math.Clamp(Num(v, "MinimumTTL"), 0, uint.MaxValue),
        },
        _ => new JsonObject(),
    };
    /// <summary>The record type of a WMI class name: MicrosoftDNS_AType gives A.</summary>
    internal static string Type(string className) => className.StartsWith("MicrosoftDNS_", StringComparison.Ordinal) && className.EndsWith("Type", StringComparison.Ordinal) ? className["MicrosoftDNS_".Length..^"Type".Length].ToUpperInvariant() : className.ToUpperInvariant();
    internal static JsonObject Record(RawRecord raw, string zone) => new()
    {
        ["name"] = Relative(raw.Owner, zone), ["type"] = raw.Type, ["ttlSeconds"] = Math.Clamp(raw.Ttl, 0, int.MaxValue), ["timestamp"] = Timestamp(raw.Timestamp),
        ["data"] = Data(raw.Type, raw.Values), ["text"] = raw.Text.Length > 4096 ? raw.Text[..4096] : raw.Text,
    };
    /// <summary>dns-zone-read: every record of the zone in name and type order, cut to 2 MiB.</summary>
    internal static JsonObject Records(string zone, IReadOnlyList<RawRecord> records, DateTimeOffset now)
    {
        var list = records.Where(record => record.Type.Length is > 0 and <= 16 && record.Type.All(char.IsAsciiLetterOrDigit)).Select(record => Record(record, zone))
            .OrderBy(item => item["name"]!.GetValue<string>() == "@" ? "" : item["name"]!.GetValue<string>(), StringComparer.Ordinal).ThenBy(item => item["type"]!.GetValue<string>(), StringComparer.Ordinal).ToList();
        var result = new JsonObject { ["kind"] = "zone", ["zone"] = zone, ["collectedAt"] = Iso(now), ["records"] = new JsonArray(list.ToArray<JsonNode>()), ["total"] = list.Count, ["truncated"] = false };
        return FitRecords(result);
    }

    // ---- The 2 MiB cut ------------------------------------------------------------------------------
    internal static int Size(JsonObject value) => Encoding.UTF8.GetByteCount(value.ToJsonString());
    /// <summary>The largest count in [0, count] whose list fits, by halving.</summary>
    private static int Keep(JsonObject value, int count, Action<int> apply, int maximum)
    {
        int low = 0, high = count;
        while (low < high) { int middle = (low + high + 1) / 2; apply(middle); if (Size(value) <= maximum) low = middle; else high = middle - 1; }
        apply(low); return low;
    }
    /// <summary>The server read in 2 MiB: the zones are cut last, truncated.zones says so.</summary>
    internal static JsonObject FitServer(JsonObject server, int maximum = MaximumBytes)
    {
        if (Size(server) <= maximum) return server;
        var zones = server["zones"]!.AsArray().Select(item => item!.DeepClone()).ToList();
        int kept = Keep(server, zones.Count, keep => server["zones"] = new JsonArray(zones.Take(keep).Select(item => item!.DeepClone()).ToArray()), maximum);
        if (kept < zones.Count) server["truncated"]!["zones"] = true;
        return server;
    }
    /// <summary>The records in 2 MiB: truncated with the full total.</summary>
    internal static JsonObject FitRecords(JsonObject records, int maximum = MaximumBytes)
    {
        if (Size(records) <= maximum) return records;
        var list = records["records"]!.AsArray().Select(item => item!.DeepClone()).ToList();
        int kept = Keep(records, list.Count, keep => records["records"] = new JsonArray(list.Take(keep).Select(item => item!.DeepClone()).ToArray()), maximum);
        if (kept < list.Count) records["truncated"] = true;
        return records;
    }
}
