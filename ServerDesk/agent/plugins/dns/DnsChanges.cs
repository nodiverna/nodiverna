using System.Globalization;
using System.Net;
using System.Text.Json.Nodes;

namespace ServerDesk.Plugin.Dns;

// The changes of DNS plugin 1.0.0 (docs/dns-server.md, "Change the DNS
// server"). One operation per change, each parsed and validated again here
// with the bounds of lib/dns-changes.ts, then run against the local DNS server
// (IDnsServer; WmiDnsServer below talks to the local WMI providers only). A
// record edit is delete + add; when the add fails, the old record comes back.
// After a successful change the plugin reads again: a record change and a
// transfer return the zone's records, every other change returns the server.

/// <summary>A value of the request that is not valid: PLUGIN_DNS_INVALID_CHANGE {field}.</summary>
internal sealed class InvalidChangeException(string field) : Exception("The field " + field + " is not valid.")
{
    internal string Field { get; } = field;
}
/// <summary>A refusal with its plugin code, for example PLUGIN_DNS_OBJECT_MISSING {object}.</summary>
internal sealed class ChangeRefusedException(string code, params (string Name, string Value)[] args) : Exception(code)
{
    internal string Code { get; } = code;
    internal Dictionary<string, string> Args { get; } = args.ToDictionary(pair => pair.Name, pair => pair.Value, StringComparer.Ordinal);
}

/// <summary>Typed reads of the request parameters; every read validates and throws InvalidChangeException with the field name.</summary>
internal sealed class ChangeInput(JsonObject values)
{
    internal JsonObject Values { get; } = values;
    internal bool Has(string name) => Values.ContainsKey(name);
    internal string Text(string name, int max)
    {
        if (Values[name] is not JsonValue item || !item.TryGetValue<string>(out var text) || text is null || text.Length > max || text.Any(char.IsControl)) throw new InvalidChangeException(name);
        return text;
    }
    internal long Integer(string name, long min, long max)
    {
        if (Values[name] is not JsonValue item || !item.TryGetValue<long>(out long number) || number < min || number > max) throw new InvalidChangeException(name);
        return number;
    }
    internal long? NullableInteger(string name, long min, long max) => Values[name] is null ? null : Integer(name, min, max);
    internal bool Flag(string name)
    {
        if (Values[name] is not JsonValue item || !item.TryGetValue<bool>(out bool value)) throw new InvalidChangeException(name);
        return value;
    }
    internal string Choice(string name, params string[] allowed) { string value = Text(name, 32); if (!allowed.Contains(value, StringComparer.Ordinal)) throw new InvalidChangeException(name); return value; }
    internal string? NullableChoice(string name, params string[] allowed) => Values[name] is null ? null : Choice(name, allowed);
    internal JsonArray Array(string name, int min, int max)
    {
        if (Values[name] is not JsonArray list || list.Count < min || list.Count > max) throw new InvalidChangeException(name);
        return list;
    }
    internal List<string> Strings(string name, int min, int max, int length) => Array(name, min, max).Select(item => item is JsonValue value && value.TryGetValue<string>(out var text) && text is not null && text.Length <= length && !text.Any(char.IsControl) ? text : throw new InvalidChangeException(name)).ToList();
    /// <summary>A list of server addresses: IPv4 or IPv6, canonical, none twice.</summary>
    internal string[] Addresses(string name, int min, int max)
    {
        var list = Strings(name, min, max, 45).Select(text => DnsSnapshot.Address(text) ?? throw new InvalidChangeException(name)).ToArray();
        if (list.Distinct(StringComparer.Ordinal).Count() != list.Length) throw new InvalidChangeException(name);
        return list;
    }
    internal ChangeInput Child(string name) => Values[name] is JsonObject child ? new ChangeInput(child) : throw new InvalidChangeException(name);
    /// <summary>Only these keys may appear (the strict schemas of the portal).</summary>
    internal void Only(params string[] keys) { foreach (var pair in Values) if (!keys.Contains(pair.Key, StringComparer.Ordinal)) throw new InvalidChangeException(pair.Key); }
}

/// <summary>A record as the portal names it: the relative name ('@' for the zone itself), the type and the typed data.</summary>
internal sealed record RecordValue(string Name, string Type, JsonObject Data)
{
    /// <summary>The identity of the record: name, type and data with sorted keys, as the portal compares it.</summary>
    internal string Key => Name + "|" + Type + "|" + DnsChanges.Canonical(Data);
}
internal sealed record ZoneSettings(string? Dynamic = null, (string Mode, string[] Servers)? Transfers = null, (string Mode, string[] Servers)? Notify = null, (bool Enabled, long NoRefresh, long Refresh)? Aging = null, string[]? Masters = null, long? ForwarderTimeout = null);

/// <summary>The local DNS server as the changes need it; WmiDnsServer is the real one, the self-test has an in-memory fake.</summary>
internal interface IDnsServer
{
    DnsService.Status Service();
    bool IsDomainController();
    IReadOnlyList<RawZone> Zones();
    IReadOnlyList<RawRecord> Records(string zone);
    void CreateZone(string name, string kind, bool ad, string? scope, string? fileName, string[] masters);
    void SetZone(string zone, ZoneSettings settings);
    void SetStorage(string zone, string kind, bool ad, string? scope, string? fileName, string[] masters);
    void DeleteZone(string zone);
    void TransferZone(string zone);
    void AddRecord(string zone, RecordValue record, long? ttl, bool age);
    void DeleteRecord(string zone, RawRecord record);
    void SetForwarders(string[] servers, long timeout, bool useRootHints);
    void SetScavenging(bool enabled, long intervalHours, (bool Enabled, long NoRefresh, long Refresh) aging, bool applyToAdZones);
    void ScavengeNow();
    void ClearCache();
}

internal static class DnsChanges
{
    internal static readonly string[] Operations =
    [
        "dns-zone-create", "dns-zone-edit", "dns-zone-delete", "dns-zone-transfer",
        "dns-record-add", "dns-record-edit", "dns-record-delete",
        "dns-conditional-create", "dns-conditional-edit", "dns-conditional-delete",
        "dns-forwarders-set", "dns-scavenging-set", "dns-scavenge-now", "dns-cache-clear",
    ];
    /// <summary>The changes that return the records of their zone after the change; every other change returns the server.</summary>
    internal static readonly string[] ZoneDataOperations = ["dns-record-add", "dns-record-edit", "dns-record-delete", "dns-zone-transfer"];
    internal static readonly string[] RecordTypes = ["A", "AAAA", "CNAME", "MX", "PTR", "TXT", "SRV", "NS"];
    private const long TtlMax = 2_147_483_647, HoursMin = 1, HoursMax = 8760, TimeoutMin = 1, TimeoutMax = 15;

    // ---- Names ----------------------------------------------------------------------------------------
    /// <summary>Labels of 1 to 63 letters, digits, hyphens and underscores, at most 253 characters; a trailing dot is removed.</summary>
    internal static bool NameValid(string? value)
    {
        string name = (value ?? "").Trim().TrimEnd('.');
        return name.Length is > 0 and <= 253 && name.Split('.').All(label => label.Length is > 0 and <= 63 && label.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'));
    }
    /// <summary>A record name inside its zone: '@' (or empty), or a relative name that may start with '*.'.</summary>
    internal static bool RecordNameValid(string? value, string zone)
    {
        string name = (value ?? "").Trim().TrimEnd('.');
        if (name is "" or "@") return true;
        string rest = name == "*" ? "" : name.StartsWith("*.", StringComparison.Ordinal) ? name[2..] : name;
        return (rest.Length == 0 || NameValid(rest)) && name.Length + 1 + zone.Length <= 253;
    }
    internal static string RecordName(string value) { string name = DnsText.Name(value); return name.Length == 0 ? "@" : name; }
    /// <summary>A host name that ends in a domain: valid, with at least two labels. SRV also takes '.'.</summary>
    internal static bool Fqdn(string? value, bool allowRoot = false) => allowRoot && (value ?? "").Trim() == "." || NameValid(value) && DnsText.Name(value).Contains('.');

    /// <summary>
    /// The reverse lookup zone of a network ID: IPv4 with 1 to 3 octets, or an IPv6 prefix whose length is a multiple
    /// of 4 from 4 to 124 with zero host bits; null otherwise. The portal computes the same (dnsReverseZoneName in lib/dns-changes.ts).
    /// </summary>
    internal static string? ReverseZoneName(string? networkId)
    {
        string value = (networkId ?? "").Trim();
        var octets = value.Split('.');
        if (value.Length > 0 && octets.Length <= 3 && octets.All(octet => octet.Length is > 0 and <= 3 && octet.All(char.IsAsciiDigit)))
        {
            if (octets.Any(octet => int.Parse(octet, CultureInfo.InvariantCulture) > 255 || octet.Length > 1 && octet[0] == '0')) return null;
            return string.Join('.', octets.Reverse()) + ".in-addr.arpa";
        }
        int slash = value.IndexOf('/');
        if (slash < 1 || !int.TryParse(value[(slash + 1)..], NumberStyles.None, CultureInfo.InvariantCulture, out int bits) || value.Length - slash - 1 > 3) return null;
        string text = value[..slash];
        if (!text.Contains(':') || !text.All(c => char.IsAsciiHexDigit(c) || c is ':' or '.') || !IPAddress.TryParse(text, out var address) || address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetworkV6) return null;
        if (bits < 4 || bits > 124 || bits % 4 != 0) return null;
        var hex = Convert.ToHexString(address.GetAddressBytes()).ToLowerInvariant();
        if (hex[(bits / 4)..].Any(c => c != '0')) return null;
        return string.Join('.', hex[..(bits / 4)].Reverse()) + ".ip6.arpa";
    }

    /// <summary>
    /// The NetworkId of a reverse zone name as the Add*ReverseLookupZone methods
    /// of root\Microsoft\Windows\DNS take it: 30.20.10.in-addr.arpa gives
    /// 10.20.30.0/24, 1.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa gives 2001:db8:1::/48.
    /// Null for every other name (a forward zone, a classless or a /32 reverse zone).
    /// </summary>
    internal static string? ReverseNetworkId(string zone)
    {
        string name = DnsText.Name(zone);
        if (name.EndsWith(".in-addr.arpa", StringComparison.Ordinal))
        {
            var octets = name[..^".in-addr.arpa".Length].Split('.');
            if (octets.Length is < 1 or > 3 || octets.Any(octet => octet.Length is 0 or > 3 || !octet.All(char.IsAsciiDigit) || int.Parse(octet, CultureInfo.InvariantCulture) > 255 || octet.Length > 1 && octet[0] == '0')) return null;
            var parts = octets.Reverse().Concat(Enumerable.Repeat("0", 4 - octets.Length));
            return string.Join('.', parts) + "/" + (octets.Length * 8).ToString(CultureInfo.InvariantCulture);
        }
        if (name.EndsWith(".ip6.arpa", StringComparison.Ordinal))
        {
            var nibbles = name[..^".ip6.arpa".Length].Split('.');
            if (nibbles.Length is < 1 or > 31 || nibbles.Any(nibble => nibble.Length != 1 || !char.IsAsciiHexDigit(nibble[0]))) return null;
            string hex = string.Concat(nibbles.Reverse()).PadRight(32, '0');
            return new IPAddress(Convert.FromHexString(hex)).ToString().ToLowerInvariant() + "/" + (nibbles.Length * 4).ToString(CultureInfo.InvariantCulture);
        }
        return null;
    }

    // ---- Record data ----------------------------------------------------------------------------------
    /// <summary>The JSON of a value with sorted keys, so two equal records compare equal.</summary>
    internal static string Canonical(JsonNode? value) => value switch
    {
        JsonObject item => "{" + string.Join(",", item.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => JsonValue.Create(pair.Key).ToJsonString() + ":" + Canonical(pair.Value))) + "}",
        JsonArray list => "[" + string.Join(",", list.Select(Canonical)) + "]",
        null => "null",
        _ => value.ToJsonString(),
    };
    /// <summary>The typed data of a record type from the request, validated and normalized; SOA and other types are refused.</summary>
    internal static JsonObject RecordData(string type, ChangeInput d, string zoneLookup)
    {
        string Host(string field, bool allowRoot = false) { string value = d.Text(field, 255); if (!Fqdn(value, allowRoot)) throw new InvalidChangeException(field); return value.Trim() == "." ? "." : DnsText.Name(value); }
        long Short(string field) => d.Integer(field, 0, 65535);
        switch (type)
        {
            case "A": { d.Only("address"); var address = DnsSnapshot.Address(d.Text("address", 45)); if (address is null || address.Contains(':')) throw new InvalidChangeException("address"); return new JsonObject { ["address"] = address }; }
            case "AAAA": { d.Only("address"); var address = DnsSnapshot.Address(d.Text("address", 45)); if (address is null || !address.Contains(':')) throw new InvalidChangeException("address"); return new JsonObject { ["address"] = address }; }
            case "CNAME": d.Only("target"); return new JsonObject { ["target"] = Host("target") };
            case "PTR": d.Only("host"); if (zoneLookup != "reverse") throw new InvalidChangeException("type"); return new JsonObject { ["host"] = Host("host") };
            case "NS": d.Only("nameServer"); return new JsonObject { ["nameServer"] = Host("nameServer") };
            case "MX": d.Only("preference", "exchange"); return new JsonObject { ["preference"] = Short("preference"), ["exchange"] = Host("exchange") };
            case "TXT": d.Only("strings"); return new JsonObject { ["strings"] = new JsonArray(d.Strings("strings", 1, 16, 255).Select(item => (JsonNode)JsonValue.Create(item)!).ToArray()) };
            case "SRV": d.Only("priority", "weight", "port", "target"); return new JsonObject { ["priority"] = Short("priority"), ["weight"] = Short("weight"), ["port"] = Short("port"), ["target"] = Host("target", true) };
            default: throw new InvalidChangeException("type");
        }
    }
    /// <summary>A record named by the portal (edit, delete): its name, a managed type (never SOA) and its data.</summary>
    internal static RecordValue Identity(ChangeInput r, string zone, string lookup)
    {
        r.Only("name", "type", "data");
        string name = r.Text("name", 255), type = r.Text("type", 16);
        if (!RecordNameValid(name, zone)) throw new InvalidChangeException("record");
        if (!RecordTypes.Contains(type, StringComparer.Ordinal)) throw new InvalidChangeException("record");
        return new RecordValue(RecordName(name), type, RecordData(type, r.Child("data"), type == "PTR" ? "reverse" : lookup));
    }
    /// <summary>The DNS text of a record for CreateInstanceFromTextRepresentation: owner, class, TTL (left out for the zone default), type and data.</summary>
    internal static string TextRepresentation(string zone, RecordValue record, long? ttl)
    {
        string owner = (record.Name == "@" ? zone : record.Name + "." + zone) + ".";
        string Host(string field) { string value = record.Data[field]!.GetValue<string>(); return value == "." ? "." : value + "."; }
        string data = record.Type switch
        {
            "A" or "AAAA" => record.Data["address"]!.GetValue<string>(),
            "CNAME" => Host("target"), "PTR" => Host("host"), "NS" => Host("nameServer"),
            "MX" => record.Data["preference"]!.ToJsonString() + " " + Host("exchange"),
            "TXT" => DnsText.TxtText(record.Data["strings"]!.AsArray().Select(item => item!.GetValue<string>())),
            "SRV" => record.Data["priority"]!.ToJsonString() + " " + record.Data["weight"]!.ToJsonString() + " " + record.Data["port"]!.ToJsonString() + " " + Host("target"),
            _ => throw new InvalidChangeException("type"),
        };
        return owner + " IN " + (ttl is long seconds ? seconds.ToString(CultureInfo.InvariantCulture) + " " : "") + record.Type + " " + data;
    }
    /// <summary>The portal's form of a record of the server.</summary>
    internal static RecordValue Value(RawRecord raw, string zone) => new(DnsSnapshot.Relative(raw.Owner, zone), raw.Type, DnsSnapshot.Data(raw.Type, raw.Values));

    // ---- Parsing ----------------------------------------------------------------------------------------
    private static string ZoneName(ChangeInput p, string field = "zone") { string value = p.Text(field, 255); if (!NameValid(value) && !value.EndsWith(".arpa", StringComparison.OrdinalIgnoreCase)) throw new InvalidChangeException(field); return DnsText.Name(value); }
    private static (bool Enabled, long NoRefresh, long Refresh) AgingOf(ChangeInput a) { a.Only("enabled", "noRefreshHours", "refreshHours"); return (a.Flag("enabled"), a.Integer("noRefreshHours", HoursMin, HoursMax), a.Integer("refreshHours", HoursMin, HoursMax)); }
    private static string? ScopeOf(ChangeInput p, bool ad, bool required)
    {
        string? scope = p.Has("replicationScope") ? p.NullableChoice("replicationScope", "forest", "domain", "legacy") : null;
        if (ad && scope is null && required) throw new InvalidChangeException("replicationScope");
        if (!ad && scope is not null) throw new InvalidChangeException("replicationScope");
        return scope;
    }

    /// <summary>The parameters of one change, parsed and validated: the strict keys, the bounds and the names. The lookup of the zone is needed for PTR only; the portal checks it against the read.</summary>
    internal static void Validate(string operation, JsonObject parameters) => Parse(operation, new ChangeInput(parameters), _ => "forward");

    internal sealed record Parsed(string Operation, Func<IDnsServer, string?> Apply);
    /// <summary>Parses one change into its action on a server. The action answers the zone to read again, or null for the server.</summary>
    internal static Parsed Parse(string operation, ChangeInput p, Func<string, string> lookupOf)
    {
        switch (operation)
        {
            case "dns-zone-create":
                {
                    p.Only("kind", "lookup", "name", "networkId", "storage", "replicationScope", "fileName", "masters", "dynamicUpdate");
                    string kind = p.Choice("kind", "primary", "secondary", "stub"), lookup = p.Choice("lookup", "forward", "reverse");
                    string name = lookup == "reverse" ? ReverseZoneName(p.Text("networkId", 64)) ?? throw new InvalidChangeException("networkId") : ZoneName(p, "name");
                    if (lookup == "reverse" && p.Has("name") && DnsText.Name(p.Text("name", 255)) != name) throw new InvalidChangeException("name");
                    bool ad = p.Choice("storage", "ad", "file") == "ad";
                    if (ad && kind == "secondary") throw new InvalidChangeException("storage");
                    string? scope = ScopeOf(p, ad, true);
                    string? file = p.Values["fileName"] is null ? null : p.Text("fileName", 255);
                    if (ad && file is not null || file is not null && (file.Length == 0 || file.Contains('\\') || file.Contains('/') || file.Contains("..", StringComparison.Ordinal))) throw new InvalidChangeException("fileName");
                    var masters = p.Addresses("masters", 0, 16);
                    if (kind == "primary" ? masters.Length > 0 : masters.Length == 0) throw new InvalidChangeException("masters");
                    string dynamic = p.Choice("dynamicUpdate", "none", "nonsecureAndSecure", "secure");
                    if (dynamic == "secure" && (!ad || kind != "primary") || kind != "primary" && dynamic != "none") throw new InvalidChangeException("dynamicUpdate");
                    return new(operation, server =>
                    {
                        if (ad && !server.IsDomainController()) throw new ChangeRefusedException("PLUGIN_DNS_NOT_DOMAIN_CONTROLLER");
                        if (server.Zones().Any(zone => DnsText.Name(zone.Name) == name)) throw new ChangeRefusedException("PLUGIN_DNS_OBJECT_EXISTS", ("object", name));
                        try { server.CreateZone(name, kind, ad, scope, ad ? null : file ?? name + ".dns", masters); }
                        catch (WmiException)
                        {
                            // WMI can report a failure after the DNS server created the zone: one read decides, and its own failure keeps the original error.
                            bool created;
                            try { created = server.Zones().Any(zone => DnsText.Name(zone.Name) == name && DnsSnapshot.Kind(zone.ZoneType) == kind); }
                            catch (WmiException) { created = false; }
                            if (!created) throw;
                        }
                        if (kind == "primary" && dynamic != "none") server.SetZone(name, new ZoneSettings(Dynamic: dynamic));
                        return null;
                    });
                }
            case "dns-zone-edit":
                {
                    p.Only("zone", "dynamicUpdate", "transfers", "notify", "aging", "masters", "storage", "replicationScope");
                    string zone = ZoneName(p);
                    string? dynamic = p.Has("dynamicUpdate") ? p.Choice("dynamicUpdate", "none", "nonsecureAndSecure", "secure") : null;
                    (string, string[])? Block(string name, params string[] modes)
                    {
                        if (!p.Has(name)) return null;
                        var b = p.Child(name); b.Only("mode", "servers");
                        string mode = b.Choice("mode", modes); var servers = b.Addresses("servers", mode == "list" ? 1 : 0, mode == "list" ? 16 : 0);
                        return (mode, servers);
                    }
                    var transfers = Block("transfers", "none", "any", "nameServers", "list"); var notify = Block("notify", "off", "nameServers", "list");
                    (bool, long, long)? aging = p.Has("aging") ? AgingOf(p.Child("aging")) : null;
                    string[]? masters = p.Has("masters") ? p.Addresses("masters", 1, 16) : null;
                    string? storage = p.Has("storage") ? p.Choice("storage", "ad", "file") : null;
                    string? scope = p.Has("replicationScope") ? p.Choice("replicationScope", "forest", "domain", "legacy") : null;
                    if (storage == "file" && scope is not null) throw new InvalidChangeException("replicationScope");
                    if (dynamic is null && transfers is null && notify is null && aging is null && masters is null && storage is null && scope is null) throw new InvalidChangeException("zone");
                    return new(operation, server =>
                    {
                        var current = server.Zones().FirstOrDefault(item => DnsText.Name(item.Name) == zone && item.ZoneType != 4) ?? throw new ChangeRefusedException("PLUGIN_DNS_OBJECT_MISSING", ("object", zone));
                        string kind = DnsSnapshot.Kind(current.ZoneType);
                        if (dynamic is not null && kind != "primary" || aging is not null && kind != "primary" || masters is not null && kind == "primary" || (transfers is not null || notify is not null) && kind == "stub") throw new InvalidChangeException("zone");
                        bool ad = storage is null ? current.DsIntegrated : storage == "ad";
                        if (dynamic == "secure" && !ad) throw new InvalidChangeException("dynamicUpdate");
                        if (storage is not null || scope is not null)
                        {
                            if (ad && !server.IsDomainController()) throw new ChangeRefusedException("PLUGIN_DNS_NOT_DOMAIN_CONTROLLER");
                            if (ad && kind == "secondary") throw new InvalidChangeException("storage");
                            if (ad && scope is null && !current.DsIntegrated) throw new InvalidChangeException("replicationScope");
                            server.SetStorage(zone, kind, ad, scope, ad ? null : current.DataFile ?? zone + ".dns", masters ?? current.Masters);
                        }
                        server.SetZone(zone, new ZoneSettings(dynamic, transfers, notify, aging, masters));
                        return null;
                    });
                }
            case "dns-zone-delete": case "dns-zone-transfer":
                {
                    p.Only("zone"); string zone = ZoneName(p);
                    return new(operation, server =>
                    {
                        var current = server.Zones().FirstOrDefault(item => DnsText.Name(item.Name) == zone && item.ZoneType != 4) ?? throw new ChangeRefusedException("PLUGIN_DNS_OBJECT_MISSING", ("object", zone));
                        if (operation == "dns-zone-delete") { server.DeleteZone(zone); return null; }
                        if (current.ZoneType is not (2 or 3)) throw new InvalidChangeException("zone");
                        server.TransferZone(zone); return zone;
                    });
                }
            case "dns-record-add":
                {
                    p.Only("zone", "name", "type", "ttlSeconds", "ageRecord", "data");
                    string zone = ZoneName(p), name = p.Text("name", 255), type = p.Text("type", 16);
                    if (!RecordNameValid(name, zone)) throw new InvalidChangeException("name");
                    if (!RecordTypes.Contains(type, StringComparer.Ordinal)) throw new InvalidChangeException("type");
                    long? ttl = p.NullableInteger("ttlSeconds", 0, TtlMax); bool age = p.Flag("ageRecord");
                    var record = new RecordValue(RecordName(name), type, RecordData(type, p.Child("data"), type == "PTR" ? lookupOf(zone) : "forward"));
                    return new(operation, server =>
                    {
                        var records = PrimaryRecords(server, zone);
                        if (records.Any(item => Value(item, zone).Key == record.Key)) throw new ChangeRefusedException("PLUGIN_DNS_OBJECT_EXISTS", ("object", record.Name + " " + record.Type));
                        server.AddRecord(zone, record, ttl, age);
                        return zone;
                    });
                }
            case "dns-record-edit":
                {
                    p.Only("zone", "record", "ttlSeconds", "ageRecord", "data");
                    string zone = ZoneName(p);
                    var old = Identity(p.Child("record"), zone, "reverse");
                    var data = p.Has("data") ? RecordData(old.Type, p.Child("data"), "reverse") : null;
                    bool ttlGiven = p.Has("ttlSeconds"); long? ttl = ttlGiven ? p.NullableInteger("ttlSeconds", 0, TtlMax) : null;
                    bool? age = p.Has("ageRecord") ? p.Flag("ageRecord") : null;
                    if (data is null && !ttlGiven && age is null) throw new InvalidChangeException("record");
                    return new(operation, server =>
                    {
                        var current = PrimaryRecords(server, zone).FirstOrDefault(item => Value(item, zone).Key == old.Key) ?? throw new ChangeRefusedException("PLUGIN_DNS_OBJECT_MISSING", ("object", old.Name + " " + old.Type));
                        EditRecord(server, zone, current, old with { Data = data ?? old.Data }, ttlGiven ? ttl : current.Ttl, age ?? current.Timestamp > 0);
                        return zone;
                    });
                }
            case "dns-record-delete":
                {
                    p.Only("zone", "records");
                    string zone = ZoneName(p);
                    var list = p.Array("records", 1, 100).Select(item => item is JsonObject value ? Identity(new ChangeInput(value), zone, "reverse") : throw new InvalidChangeException("records")).ToList();
                    if (list.Select(item => item.Key).Distinct(StringComparer.Ordinal).Count() != list.Count) throw new InvalidChangeException("records");
                    return new(operation, server =>
                    {
                        var records = PrimaryRecords(server, zone);
                        var found = list.Select(item => records.FirstOrDefault(raw => Value(raw, zone).Key == item.Key) ?? throw new ChangeRefusedException("PLUGIN_DNS_OBJECT_MISSING", ("object", item.Name + " " + item.Type))).ToList();
                        // A zone keeps at least one name server at its apex.
                        var apexNs = records.Where(raw => raw.Type == "NS" && DnsSnapshot.Relative(raw.Owner, zone) == "@").ToList();
                        if (apexNs.Count > 0 && apexNs.All(raw => found.Contains(raw))) throw new InvalidChangeException("records");
                        foreach (var raw in found) server.DeleteRecord(zone, raw);
                        return zone;
                    });
                }
            case "dns-conditional-create": case "dns-conditional-edit":
                {
                    bool create = operation == "dns-conditional-create";
                    p.Only("name", "masters", "storage", "replicationScope", "timeoutSeconds");
                    string name = ZoneName(p, "name");
                    string[]? masters = create || p.Has("masters") ? p.Addresses("masters", 1, 16) : null;
                    string? storage = create || p.Has("storage") ? p.Choice("storage", "ad", "file") : null;
                    string? scope = storage is null ? p.Has("replicationScope") ? p.NullableChoice("replicationScope", "forest", "domain", "legacy") : null : ScopeOf(p, storage == "ad", create);
                    long? timeout = create ? p.Has("timeoutSeconds") ? p.Integer("timeoutSeconds", TimeoutMin, TimeoutMax) : 5 : p.Has("timeoutSeconds") ? p.Integer("timeoutSeconds", TimeoutMin, TimeoutMax) : null;
                    if (!create && masters is null && storage is null && scope is null && timeout is null) throw new InvalidChangeException("name");
                    return new(operation, server =>
                    {
                        var current = server.Zones().FirstOrDefault(item => DnsText.Name(item.Name) == name);
                        bool ad = storage is null ? current?.DsIntegrated ?? false : storage == "ad";
                        if ((storage is not null || scope is not null) && ad && !server.IsDomainController()) throw new ChangeRefusedException("PLUGIN_DNS_NOT_DOMAIN_CONTROLLER");
                        if (create)
                        {
                            if (current is not null) throw new ChangeRefusedException("PLUGIN_DNS_OBJECT_EXISTS", ("object", name));
                            server.CreateZone(name, "forwarder", ad, scope, null, masters!);
                            server.SetZone(name, new ZoneSettings(ForwarderTimeout: timeout));
                            return null;
                        }
                        if (current is null || current.ZoneType != 4) throw new ChangeRefusedException("PLUGIN_DNS_OBJECT_MISSING", ("object", name));
                        if (storage is not null || scope is not null) server.SetStorage(name, "forwarder", ad, scope, null, masters ?? current.Masters);
                        server.SetZone(name, new ZoneSettings(Masters: masters, ForwarderTimeout: timeout));
                        return null;
                    });
                }
            case "dns-conditional-delete":
                {
                    p.Only("name"); string name = ZoneName(p, "name");
                    return new(operation, server =>
                    {
                        if (server.Zones().FirstOrDefault(item => DnsText.Name(item.Name) == name) is not { ZoneType: 4 }) throw new ChangeRefusedException("PLUGIN_DNS_OBJECT_MISSING", ("object", name));
                        server.DeleteZone(name); return null;
                    });
                }
            case "dns-forwarders-set":
                {
                    p.Only("servers", "timeoutSeconds", "useRootHints");
                    var servers = p.Addresses("servers", 0, 16); long timeout = p.Integer("timeoutSeconds", TimeoutMin, TimeoutMax); bool rootHints = p.Flag("useRootHints");
                    return new(operation, server => { server.SetForwarders(servers, timeout, rootHints); return null; });
                }
            case "dns-scavenging-set":
                {
                    p.Only("enabled", "intervalHours", "defaultAging", "applyToAdZones");
                    bool enabled = p.Flag("enabled"); long interval = p.Integer("intervalHours", HoursMin, HoursMax); var aging = AgingOf(p.Child("defaultAging")); bool apply = p.Flag("applyToAdZones");
                    return new(operation, server => { server.SetScavenging(enabled, interval, aging, apply); return null; });
                }
            case "dns-scavenge-now": p.Only(); return new(operation, server => { server.ScavengeNow(); return null; });
            case "dns-cache-clear": p.Only(); return new(operation, server => { server.ClearCache(); return null; });
            default: throw new InvalidChangeException("operation");
        }
    }

    /// <summary>The records of a primary zone; a missing zone or another kind is refused.</summary>
    private static IReadOnlyList<RawRecord> PrimaryRecords(IDnsServer server, string zone)
    {
        var current = server.Zones().FirstOrDefault(item => DnsText.Name(item.Name) == zone) ?? throw new ChangeRefusedException("PLUGIN_DNS_OBJECT_MISSING", ("object", zone));
        if (current.ZoneType != 1) throw new InvalidChangeException("zone");
        return server.Records(zone);
    }
    /// <summary>A record edit: delete + add; when the add fails, the old record is added back and the failure goes on.</summary>
    internal static void EditRecord(IDnsServer server, string zone, RawRecord current, RecordValue next, long? ttl, bool age)
    {
        var old = Value(current, zone);
        server.DeleteRecord(zone, current);
        try { server.AddRecord(zone, next, ttl, age); }
        catch
        {
            server.AddRecord(zone, old, current.Ttl, current.Timestamp > 0);
            throw;
        }
    }

    // ---- Running a change -----------------------------------------------------------------------------
    // DNS server error numbers (winerror.h): an existing or a missing object, and a server without AD.
    private static readonly long[] ExistsCodes = [9609, 9711, 9718];
    private static readonly long[] MissingCodes = [9601, 9701, 9714];
    private static readonly long[] NoDirectoryCodes = [9717, 9901, 9902];
    /// <summary>A real answer of the DNS server: access denied, or an exists, missing or no-directory code. Another provider gives the same answer, so no second call runs.</summary>
    internal static bool IsDnsAnswer(WmiException e) => e.AccessDenied || ExistsCodes.Contains(e.Code) || MissingCodes.Contains(e.Code) || NoDirectoryCodes.Contains(e.Code);

    /// <summary>
    /// A failed change: access denied, exists, missing and no directory as in
    /// 1.0.3; every other failure gives PLUGIN_DNS_CHANGE_FAILED_DETAIL when WMI
    /// gave a description, else PLUGIN_DNS_CHANGE_FAILED, both with the details
    /// of the failed call and every call tried (at most 8 args).
    /// </summary>
    internal static Program.Outcome Refused(WmiException e, string objectName)
    {
        if (e.AccessDenied) return new(false, "PLUGIN_DNS_ACCESS_DENIED", new Dictionary<string, string>(), null);
        if (ExistsCodes.Contains(e.Code)) return new(false, "PLUGIN_DNS_OBJECT_EXISTS", new Dictionary<string, string> { ["object"] = objectName }, null);
        if (MissingCodes.Contains(e.Code) || e.NotFound) return new(false, "PLUGIN_DNS_OBJECT_MISSING", new Dictionary<string, string> { ["object"] = objectName }, null);
        if (NoDirectoryCodes.Contains(e.Code)) return new(false, "PLUGIN_DNS_NOT_DOMAIN_CONTROLLER", new Dictionary<string, string>(), null);
        string detail = Clean(e.Description, 300);
        if (detail.Length > 0 && detail[^1] is not ('.' or '!' or '?')) detail = (detail.Length < 300 ? detail : detail[..299].TrimEnd()) + ".";
        var args = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["error"] = e.Code.ToString(CultureInfo.InvariantCulture),
            ["call"] = Clean(e.Call, 200),
            ["hresult"] = e.HResultText,
            ["provider"] = Clean(e.ProviderName, 100) is { Length: > 0 } provider ? provider : "-",
            ["operation"] = Clean(e.Operation, 100) is { Length: > 0 } operation ? operation : "-",
            ["detail"] = detail.Length > 0 ? detail : "-",
            ["attempts"] = Clean(string.Join("; ", e.Tried.Select(item => item.Call + " " + item.HResultText + (item.ProviderCode is long code ? " " + code.ToString(CultureInfo.InvariantCulture) : ""))), 1000),
        };
        if (Clean(e.Signature, 1000) is { Length: > 0 } signature) args["signature"] = signature;
        return new(false, detail.Length > 0 ? "PLUGIN_DNS_CHANGE_FAILED_DETAIL" : "PLUGIN_DNS_CHANGE_FAILED", args, null);
    }
    /// <summary>A text for a result arg: control characters as spaces, runs of spaces as one, trimmed, then cut to max characters and trimmed again; empty for null.</summary>
    internal static string Clean(string? value, int max)
    {
        var text = new System.Text.StringBuilder();
        foreach (char c in value ?? "")
        {
            char next = char.IsControl(c) ? ' ' : c;
            if (next == ' ' && (text.Length == 0 || text[^1] == ' ')) continue;
            text.Append(next);
        }
        string result = text.ToString().Trim();
        return result.Length <= max ? result : result[..max].TrimEnd();
    }

    // ---- Two providers ------------------------------------------------------------------------------
    /// <summary>The root\Microsoft\Windows\DNS class whose static methods create a zone of this kind; null for every other kind (a conditional forwarder has none).</summary>
    internal static string? CimZoneClass(string kind) => kind switch { "primary" => "PS_DnsServerPrimaryZone", "secondary" => "PS_DnsServerSecondaryZone", "stub" => "PS_DnsServerStubZone", _ => null };
    /// <summary>
    /// The order of a zone create (WmiDnsServer.CreateZone). A kind without a
    /// CimZoneClass (a conditional forwarder) takes only the legacy call. Else
    /// the modern call of root\Microsoft\Windows\DNS runs first. A real DNS
    /// answer (IsDnsAnswer) is thrown as it is. Else, when the zone now exists,
    /// the modern failure is thrown (the zone read of the dns-zone-create change
    /// then decides). Else the legacy call runs once; when it fails too, Chosen
    /// picks the exception, which carries both attempts in order.
    /// </summary>
    internal static void ModernFirst(string kind, Action modern, Action legacy, Func<bool> exists)
    {
        if (CimZoneClass(kind) is null) { legacy(); return; }
        WmiException first;
        try { modern(); return; }
        catch (WmiException e) when (!IsDnsAnswer(e)) { first = e; }
        bool present;
        try { present = exists(); }
        catch (WmiException) { present = false; }
        if (present) throw first;
        WmiException? second = null;
        try { legacy(); }
        catch (WmiException e) { second = e; }
        if (second is not null) throw Chosen(first, second);
    }
    /// <summary>
    /// The order of a zone delete whose zone MicrosoftDNS_Zone lists
    /// (WmiDnsServer.DeleteZone): the legacy call first; after a generic
    /// 0x80041001 that is no DNS answer, the modern call runs once. When it fails
    /// too, Chosen picks the exception, which carries both attempts in order.
    /// </summary>
    internal static void LegacyFirst(Action legacy, Action modern)
    {
        WmiException first;
        try { legacy(); return; }
        catch (WmiException e) when (e.HResult32 == unchecked((int)0x80041001) && !IsDnsAnswer(e)) { first = e; }
        WmiException? second = null;
        try { modern(); }
        catch (WmiException e) { second = e; }
        if (second is not null) throw Chosen(first, second);
    }
    /// <summary>The exception of calls that all failed, in the order tried: the first with a provider code, else the first with a description, else the first one; it carries every attempt.</summary>
    internal static WmiException Chosen(params WmiException[] tried)
    {
        var chosen = tried.FirstOrDefault(item => item.ProviderCode is not null) ?? tried.FirstOrDefault(item => !string.IsNullOrWhiteSpace(item.Description)) ?? tried[0];
        chosen.Attempts = tried;
        return chosen;
    }

    /// <summary>
    /// One change: the parameters, the service, the change, then the read: the
    /// zone's records after a record change or a transfer, the server after any
    /// other change. A failed read after a change answers PLUGIN_DNS_CHANGED_NOT_READ.
    /// </summary>
    internal static Program.Outcome Run(string operation, JsonObject parameters, Func<Program.Outcome> readServer, Func<string, Program.Outcome> readZone, IDnsServer? server = null)
    {
        var none = new Dictionary<string, string>();
        var target = server ?? new WmiDnsServer();
        Parsed parsed;
        try { parsed = Parse(operation, new ChangeInput(parameters), zone => target.Zones().FirstOrDefault(item => DnsText.Name(item.Name) == zone) is { Reverse: true } ? "reverse" : "forward"); }
        catch (InvalidChangeException e) { return new(false, "PLUGIN_DNS_INVALID_CHANGE", new Dictionary<string, string> { ["field"] = e.Field }, null); }
        catch (WmiException e) when (e.AccessDenied) { return new(false, "PLUGIN_DNS_ACCESS_DENIED", none, null); }
        var service = target.Service();
        if (service == DnsService.Status.Missing) return new(false, "PLUGIN_DNS_NOT_INSTALLED", none, null);
        if (service != DnsService.Status.Running) return new(false, "PLUGIN_DNS_SERVICE_STOPPED", none, null);
        string? zoneRead;
        try { zoneRead = parsed.Apply(target); }
        catch (InvalidChangeException e) { return new(false, "PLUGIN_DNS_INVALID_CHANGE", new Dictionary<string, string> { ["field"] = e.Field }, null); }
        catch (ChangeRefusedException e) { return new(false, e.Code, e.Args, null); }
        catch (WmiException e) { return Refused(e, ObjectOf(parameters)); }
        Program.Outcome after;
        try { after = ZoneDataOperations.Contains(operation, StringComparer.Ordinal) && zoneRead is not null ? readZone(zoneRead) : readServer(); }
        catch (Exception e) when (e is WmiException or InvalidOperationException) { after = new(false, "PLUGIN_DNS_READ_FAILED", none, null); }
        return after.Data is JsonObject data && after.Ok ? new(true, "PLUGIN_DNS_CHANGED", none, data) : new(true, "PLUGIN_DNS_CHANGED_NOT_READ", none, null);
    }
    private static string ObjectOf(JsonObject parameters) => (parameters["zone"] ?? parameters["name"]) is JsonValue value && value.TryGetValue<string>(out var text) && text is not null ? text[..Math.Min(text.Length, 255)] : "DNS";
}

/// <summary>The local DNS server through WMI (DnsApi.cs). Every query names its values through Wql.Quote.</summary>
internal sealed class WmiDnsServer : IDnsServer
{
    private WmiConnection? dns;
    private WmiConnection Dns => dns ??= WmiConnection.Open(WmiConnection.Dns);
    private static readonly string[] ZoneTypes = ["primary", "secondary", "stub", "forwarder"];

    public DnsService.Status Service() => DnsService.State();
    public bool IsDomainController() { var list = Dns.Query("SELECT DsAvailable FROM MicrosoftDNS_Server"); try { return list.Any(item => item.Flag("DsAvailable")); } finally { foreach (var item in list) item.Dispose(); } }

    private static T Using<T>(List<WmiObject> list, Func<List<WmiObject>, T> read) { try { return read(list); } finally { foreach (var item in list) item.Dispose(); } }
    /// <summary>
    /// The zones of root\Microsoft\Windows\DNS: every DnsServerZone instance
    /// (with its subclass properties: SELECT *) through DnsSnapshot.ModernZone.
    /// Empty when the namespace is missing or the query fails.
    /// </summary>
    private static List<RawZone> ModernZones()
    {
        try
        {
            using var cim = WmiConnection.Open(WmiConnection.DnsCim);
            return Using(cim.Query("SELECT * FROM DnsServerZone"), list => list.Select(item => DnsSnapshot.ModernZone(item.Get)).OfType<RawZone>().ToList());
        }
        catch (WmiException) { return []; }
    }
    public IReadOnlyList<RawZone> Zones() => Zones(countRecords: false);
    /// <summary>The zones of MicrosoftDNS_Zone and the zones that only DnsServerZone lists (DnsSnapshot.MergeZones); only the first have record counts.</summary>
    internal IReadOnlyList<RawZone> Zones(bool countRecords)
    {
        var modern = ModernZones(); long budget = 200_000;
        var legacy = Using(Dns.Query("SELECT * FROM MicrosoftDNS_Zone"), list => list.Select(item =>
        {
            string name = DnsText.Name(item.Text("Name")); int type = (int)(item.Number("ZoneType") ?? 0);
            long? count = null;
            if (countRecords && type == 1 && !item.Flag("AutoCreated") && budget > 0) { count = CountRecords(name); budget -= count ?? budget; }
            return new RawZone(name, type, item.Flag("Reverse"), item.Flag("DsIntegrated"), null, null, item.Text("DataFile"), (int)(item.Number("AllowUpdate") ?? 0), (int)(item.Number("SecureSecondaries") ?? 3),
                item.List("SecondaryServers"), (int)(item.Number("Notify") ?? 0), item.List("NotifyServers"), item.List("MasterServers"), item.Flag("Aging"), item.Number("NoRefreshInterval") ?? 0, item.Number("RefreshInterval") ?? 0,
                item.Number("ForwarderTimeout"), item.Flag("Paused"), item.Flag("AutoCreated"), null, count);
        }).ToList());
        return DnsSnapshot.MergeZones(legacy, modern);
    }
    private long? CountRecords(string zone) { try { return Using(Dns.Query("SELECT OwnerName FROM MicrosoftDNS_ResourceRecord WHERE ContainerName=" + Wql.Quote(zone)), list => (long)list.Count); } catch (WmiException) { return null; } }

    /// <summary>The server read: settings, forwarders, scavenging and zones.</summary>
    internal RawServer ReadServer(string fallbackName, string? domain)
    {
        var server = Using(Dns.Query("SELECT * FROM MicrosoftDNS_Server"), list =>
        {
            var item = list.FirstOrDefault() ?? throw new InvalidOperationException("No MicrosoftDNS_Server instance.");
            long version = item.Number("Version") ?? 0;
            string? text = version > 0 ? (version & 0xFF).ToString(CultureInfo.InvariantCulture) + "." + (version >> 8 & 0xFF).ToString(CultureInfo.InvariantCulture) + "." + (version >> 16 & 0xFFFF).ToString(CultureInfo.InvariantCulture) : null;
            var listen = item.List("ListenAddresses"); if (listen.Length == 0) listen = item.List("ServerAddresses");
            return (Name: item.Text("Name") ?? fallbackName, Version: text, Dc: item.Flag("DsAvailable"), Listen: listen, Forwarders: item.List("Forwarders"), Timeout: item.Number("ForwardingTimeout") ?? 3, Slave: item.Flag("IsSlave"),
                Interval: item.Number("ScavengingInterval") ?? 0, Aging: item.Flag("DefaultAgingState"), NoRefresh: item.Number("DefaultNoRefreshInterval") ?? 168, Refresh: item.Number("DefaultRefreshInterval") ?? 168);
        });
        return new RawServer(server.Name, domain, server.Version, server.Dc, server.Listen, server.Forwarders, server.Timeout, !server.Slave, server.Interval, LastScavenge(), server.Aging, server.NoRefresh, server.Refresh, Zones(countRecords: true));
    }
    /// <summary>The last scavenging run from DnsServerScavenging (a DMTF time), or null.</summary>
    private static string? LastScavenge()
    {
        try
        {
            using var cim = WmiConnection.Open(WmiConnection.DnsCim);
            return Using(cim.Query("SELECT LastScavengeTime FROM DnsServerScavenging"), list =>
            {
                string? value = list.FirstOrDefault()?.Text("LastScavengeTime");
                return value is { Length: >= 14 } && DateTime.TryParseExact(value[..14], "yyyyMMddHHmmss", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var time) && time.Year > 1601 ? DnsSnapshot.Iso(time) : null;
            });
        }
        catch (WmiException) { return null; }
    }

    public IReadOnlyList<RawRecord> Records(string zone) => Using(Dns.Query("SELECT * FROM MicrosoftDNS_ResourceRecord WHERE ContainerName=" + Wql.Quote(zone)), list => list.Select(item =>
    {
        string type = DnsSnapshot.Type(item.Text("__CLASS") ?? "");
        string[] names = type switch
        {
            "A" => ["IPAddress"], "AAAA" => ["IPv6Address"], "CNAME" => ["PrimaryName"], "PTR" => ["PTRDomainName"], "NS" => ["NSHost"], "MX" => ["Preference", "MailExchange"], "TXT" => ["DescriptiveText"],
            "SRV" => ["Priority", "Weight", "Port", "DomainName"], "SOA" => ["PrimaryServer", "ResponsibleParty", "SerialNumber", "RefreshInterval", "RetryDelay", "ExpireLimit", "MinimumTTL"], _ => [],
        };
        var values = names.ToDictionary(name => name, name => item.Get(name), StringComparer.Ordinal);
        values["__RELPATH"] = item.Text("__RELPATH");
        return new RawRecord(item.Text("OwnerName") ?? zone, type, item.Number("TTL") ?? 0, item.Number("Timestamp") ?? 0, item.Text("TextRepresentation") ?? "", values);
    }).ToList());

    private string? LegacyZonePath(string zone) => Using(Dns.Query("SELECT Name FROM MicrosoftDNS_Zone WHERE Name=" + Wql.Quote(zone)), list => list.FirstOrDefault()?.Text("__RELPATH"));
    private string ZonePath(string zone) => LegacyZonePath(zone) ?? throw new WmiException("Zone " + zone, unchecked((int)0x80041002));
    private string ServerPath() => Using(Dns.Query("SELECT Name FROM MicrosoftDNS_Server"), list => list.FirstOrDefault()?.Text("__RELPATH")) ?? throw new WmiException("Server", unchecked((int)0x80041002));
    private static uint TypeNumber(string kind) => (uint)Array.IndexOf(ZoneTypes, kind);

    /// <summary>
    /// A new zone. Primary, secondary and stub zones are created through the
    /// modern provider root\Microsoft\Windows\DNS first (CreateZoneCim), with
    /// MicrosoftDNS_Zone.CreateZone of root\MicrosoftDNS as the fallback; the
    /// order and the error choice are DnsChanges.ModernFirst. A conditional
    /// forwarder (no CimZoneClass) only takes the legacy call.
    /// </summary>
    public void CreateZone(string name, string kind, bool ad, string? scope, string? fileName, string[] masters)
    {
        void Legacy()
        {
            Dns.Call("MicrosoftDNS_Zone", "MicrosoftDNS_Zone", "CreateZone", new Dictionary<string, object?> { ["ZoneName"] = name, ["ZoneType"] = TypeNumber(kind), ["DsIntegrated"] = ad, ["DataFileName"] = fileName, ["IpAddr"] = masters.Length > 0 ? masters : null });
            if (ad && scope is not null && scope != "domain") SetScope(name, scope);
        }
        DnsChanges.ModernFirst(kind, () => CreateZoneCim(DnsChanges.CimZoneClass(kind)!, kind, name, ad, scope, fileName, masters), Legacy, () => ZoneExists(name));
    }
    /// <summary>Whether a zone of this name exists in MicrosoftDNS_Zone or in DnsServerZone; a lookup that fails counts as no zone.</summary>
    private bool ZoneExists(string zone)
    {
        try { if (Using(Dns.Query("SELECT Name FROM MicrosoftDNS_Zone WHERE Name=" + Wql.Quote(zone)), list => list.Count > 0)) return true; }
        catch (WmiException) { }
        try
        {
            using var cim = WmiConnection.Open(WmiConnection.DnsCim);
            return Using(cim.Query("SELECT ZoneName FROM DnsServerZone WHERE ZoneName=" + Wql.Quote(zone)), list => list.Count > 0);
        }
        catch (WmiException) { return false; }
    }
    /// <summary>
    /// The zone through the provider of the DnsServer PowerShell module
    /// (DnsServerPSProvider in root\Microsoft\Windows\DNS; Microsoft Learn,
    /// "PS_DnsServerPrimaryZone class", "PS_DnsServerSecondaryZone class",
    /// "PS_DnsServerStubZone class"): the static method of the class behind
    /// Add-DnsServerPrimaryZone, Add-DnsServerSecondaryZone or
    /// Add-DnsServerStubZone. A file-backed zone takes AddByFile…LookupZone (a
    /// secondary zone AddBy…LookupZone) with ZoneFile, an AD zone
    /// AddByAD…LookupZone with ReplicationScope. A forward zone gives Name, a
    /// reverse zone with a network of whole octets or nibbles its NetworkID
    /// (ReverseNetworkId, ReverseLookupZone methods); secondary and stub zones
    /// add MasterServers. Every value is a typed method parameter; a nonzero
    /// ReturnValue fails.
    /// </summary>
    private static void CreateZoneCim(string className, string kind, string name, bool ad, string? scope, string? fileName, string[] masters)
    {
        string? network = DnsChanges.ReverseNetworkId(name);
        string method = (ad ? "AddByAD" : kind == "secondary" ? "AddBy" : "AddByFile") + (network is null ? "ForwardLookupZone" : "ReverseLookupZone");
        // The primary zone methods spell the parameter NetworkID, the secondary and stub zone methods NetworkId.
        var values = network is null ? new Dictionary<string, object?> { ["Name"] = name } : new Dictionary<string, object?> { [kind == "primary" ? "NetworkID" : "NetworkId"] = network };
        if (ad) values["ReplicationScope"] = scope switch { "forest" => "Forest", "legacy" => "Legacy", _ => "Domain" };
        else if (fileName is not null) values["ZoneFile"] = fileName;
        if (masters.Length > 0) values["MasterServers"] = masters;
        using var cim = WmiConnection.Open(WmiConnection.DnsCim);
        cim.Call(className, className, method, values, checkReturn: true);
    }
    /// <summary>The replication scope through DnsServerZone of root\Microsoft\Windows\DNS: root\MicrosoftDNS has no setting for it.</summary>
    private static void SetScope(string zone, string scope)
    {
        using var cim = WmiConnection.Open(WmiConnection.DnsCim);
        var list = cim.Query("SELECT * FROM DnsServerZone WHERE ZoneName=" + Wql.Quote(zone));
        try
        {
            var item = list.FirstOrDefault() ?? throw new WmiException("DnsServerZone " + zone, unchecked((int)0x80041002));
            item.Put("ReplicationScope", scope switch { "forest" => "Forest", "legacy" => "Legacy", _ => "Domain" });
            cim.Update(item);
        }
        finally { foreach (var item in list) item.Dispose(); }
    }
    public void SetStorage(string zone, string kind, bool ad, string? scope, string? fileName, string[] masters)
    {
        var current = Zones().First(item => DnsText.Name(item.Name) == zone);
        if (current.DsIntegrated != ad) Dns.Call(ZonePath(zone), "MicrosoftDNS_Zone", "ChangeZoneType", new Dictionary<string, object?> { ["ZoneType"] = TypeNumber(kind), ["DsIntegrated"] = ad, ["DataFileName"] = fileName, ["IpAddr"] = masters.Length > 0 ? masters : null });
        if (ad && scope is not null) SetScope(zone, scope);
    }
    public void SetZone(string zone, ZoneSettings settings)
    {
        var list = Dns.Query("SELECT * FROM MicrosoftDNS_Zone WHERE Name=" + Wql.Quote(zone));
        try
        {
            var item = list.FirstOrDefault() ?? throw new WmiException("Zone " + zone, unchecked((int)0x80041002));
            bool changed = false;
            if (settings.Dynamic is string dynamic) { item.Put("AllowUpdate", dynamic switch { "nonsecureAndSecure" => 1, "secure" => 2, _ => 0 }); changed = true; }
            if (settings.Aging is var (enabled, noRefresh, refresh)) { item.Put("Aging", enabled); item.Put("NoRefreshInterval", (int)noRefresh); item.Put("RefreshInterval", (int)refresh); changed = true; }
            if (settings.Masters is string[] masters) { item.Put("MasterServers", masters); changed = true; }
            if (settings.ForwarderTimeout is long timeout) { item.Put("ForwarderTimeout", (int)timeout); changed = true; }
            if (changed) Dns.Update(item);
            if (settings.Transfers is not null || settings.Notify is not null)
            {
                var transfers = settings.Transfers ?? (DnsSnapshot.Transfers((int)(item.Number("SecureSecondaries") ?? 3)), item.List("SecondaryServers"));
                var notify = settings.Notify ?? (DnsSnapshot.NotifyMode((int)(item.Number("Notify") ?? 0)), item.List("NotifyServers"));
                Dns.Call(item.Text("__RELPATH")!, "MicrosoftDNS_Zone", "ResetSecondaries", new Dictionary<string, object?>
                {
                    ["SecondaryServers"] = transfers.Servers, ["SecureSecondaries"] = transfers.Mode switch { "any" => 0, "nameServers" => 1, "list" => 2, _ => 3 },
                    ["NotifyServers"] = notify.Servers, ["Notify"] = notify.Mode switch { "nameServers" => 1, "list" => 2, _ => 0 },
                });
            }
        }
        finally { foreach (var item in list) item.Dispose(); }
    }
    /// <summary>
    /// A zone delete. A zone that MicrosoftDNS_Zone lists is deleted with its
    /// DeleteInstance as before; after a generic 0x80041001 the modern delete runs
    /// once (DnsChanges.LegacyFirst). A zone that only DnsServerZone lists goes
    /// straight to the modern delete.
    /// </summary>
    public void DeleteZone(string zone)
    {
        if (LegacyZonePath(zone) is not { } path) { DeleteZoneCim(zone); return; }
        DnsChanges.LegacyFirst(() => Dns.Delete(path), () => DeleteZoneCim(zone));
    }
    /// <summary>
    /// The zone delete of the DnsServer PowerShell module: the static method
    /// Remove of PS_DnsServerZone in root\Microsoft\Windows\DNS (Microsoft Learn,
    /// "Remove method of the PS_DnsServerZone class", the call behind
    /// Remove-DnsServerZone) with Name and Force as typed parameters. The
    /// provider documents no DeleteInstance for DnsServerZone.
    /// </summary>
    private static void DeleteZoneCim(string zone)
    {
        using var cim = WmiConnection.Open(WmiConnection.DnsCim);
        cim.Call("PS_DnsServerZone", "PS_DnsServerZone", "Remove", new Dictionary<string, object?> { ["Name"] = zone, ["Force"] = true }, checkReturn: true);
    }
    public void TransferZone(string zone) => Dns.Call(ZonePath(zone), "MicrosoftDNS_Zone", "ForceRefresh");
    public void AddRecord(string zone, RecordValue record, long? ttl, bool age)
    {
        Dns.Call("MicrosoftDNS_ResourceRecord", "MicrosoftDNS_ResourceRecord", "CreateInstanceFromTextRepresentation", new Dictionary<string, object?> { ["DnsServerName"] = ".", ["ContainerName"] = zone, ["TextRepresentation"] = DnsChanges.TextRepresentation(zone, record, ttl) });
        // An aged record gets a timestamp: AgeAllRecords on its node (only this node, not the subtree).
        if (age) Dns.Call(ZonePath(zone), "MicrosoftDNS_Zone", "AgeAllRecords", new Dictionary<string, object?> { ["NodeName"] = record.Name == "@" ? zone : record.Name + "." + zone, ["ApplyToSubtree"] = false });
    }
    public void DeleteRecord(string zone, RawRecord record)
    {
        string? path = record.Values.TryGetValue("__RELPATH", out var value) ? value as string : null;
        Dns.Delete(path ?? throw new WmiException("Record " + record.Owner, unchecked((int)0x80041002)));
    }
    private void UpdateServer(Action<WmiObject> change)
    {
        var list = Dns.Query("SELECT * FROM MicrosoftDNS_Server");
        try { var item = list.FirstOrDefault() ?? throw new WmiException("Server", unchecked((int)0x80041002)); change(item); Dns.Update(item); }
        finally { foreach (var item in list) item.Dispose(); }
    }
    public void SetForwarders(string[] servers, long timeout, bool useRootHints) => UpdateServer(item => { item.Put("Forwarders", servers); item.Put("ForwardingTimeout", (int)timeout); item.Put("IsSlave", !useRootHints); });
    public void SetScavenging(bool enabled, long intervalHours, (bool Enabled, long NoRefresh, long Refresh) aging, bool applyToAdZones)
    {
        UpdateServer(item => { item.Put("ScavengingInterval", enabled ? (int)intervalHours : 0); item.Put("DefaultAgingState", aging.Enabled); item.Put("DefaultNoRefreshInterval", (int)aging.NoRefresh); item.Put("DefaultRefreshInterval", (int)aging.Refresh); });
        if (!applyToAdZones) return;
        foreach (var zone in Zones().Where(zone => zone.DsIntegrated && zone.ZoneType == 1 && !zone.AutoCreated)) SetZone(zone.Name, new ZoneSettings(Aging: aging));
    }
    public void ScavengeNow() => Dns.Call(ServerPath(), "MicrosoftDNS_Server", "StartScavenging");
    public void ClearCache()
    {
        string path = Using(Dns.Query("SELECT * FROM MicrosoftDNS_Cache"), list => list.FirstOrDefault()?.Text("__RELPATH")) ?? throw new WmiException("Cache", unchecked((int)0x80041002));
        Dns.Call(path, "MicrosoftDNS_Cache", "ClearCache");
    }
}
