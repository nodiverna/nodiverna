using System.Text.Json.Nodes;
using System.Threading.Channels;
using ServerDesk.Plugins;

namespace ServerDesk.Plugin.Dns;

// --self-test of the DNS plugin, portable: the parameters of every operation
// (good and bad), the names and the reverse zone names (the same vectors as
// dnsReverseZoneName in lib/dns-changes.ts; tests/lib/dns-changes.mjs reads them),
// the WQL escaping, the record data per type with SOA read only, the 2 MiB cut,
// the delete + add rollback of a record edit on an in-memory server, the
// protocol (an unknown operation exits with 3), which read follows each
// change, and the contract with the portal: a realistic server read, a zone
// read with records of every type and an empty zone run through the protocol
// and the agent's upload envelope and must equal the JSON documents below,
// which tests/agent/dns-plugin-contract.mjs checks against lib/dns.ts. Only the
// Windows Server acceptance run proves the WMI calls. The zone-create failures
// of 1.0.3 (a generic WMI failure after which the zone exists, the provider
// code of the WMI error object) run on the in-memory server, and so do the
// cases of 1.0.4 (f)-(n): the order of the modern and the legacy provider, the
// result args of a failed change and the zone list merged from both providers.
internal static class DnsSelfTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }

    internal static async Task<int> RunAsync()
    {
        try
        {
            Names(); Parameters(); Mapping(); Cut(); Rollback(); ZoneCreateFailures(); ZoneProviders(); ReadAfterChange(); await ProtocolAsync(); await ContractAsync();
            Console.WriteLine("DNS plugin self-test passed.");
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine("DNS plugin self-test failed: " + e.Message); return 1; }
    }

    // The reverse zone names, the same vectors as tests/lib/dns-changes.mjs reads from this list: input, then the zone or null.
    internal static readonly (string Input, string? Zone)[] ReverseVectors =
    [
        ("10", "10.in-addr.arpa"),
        ("10.20", "20.10.in-addr.arpa"),
        ("10.20.30", "30.20.10.in-addr.arpa"),
        ("192.168.0", "0.168.192.in-addr.arpa"),
        ("10.20.30.40", null),
        ("10.256", null),
        ("10.020", null),
        ("", null),
        ("2001:db8:1::/48", "1.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa"),
        ("2001:db8::/32", "8.b.d.0.1.0.0.2.ip6.arpa"),
        ("fd00::/8", "d.f.ip6.arpa"),
        ("2001:db8:1::/50", null),
        ("2001:db8:1::/0", null),
        ("2001:db8:1::/128", null),
        ("2001:db8:1::1/48", null),
        ("2001:db8:1::", null),
    ];

    private static void Names()
    {
        foreach (var (input, zone) in ReverseVectors) Check(DnsChanges.ReverseZoneName(input) == zone, "The reverse zone of " + input + " is " + (DnsChanges.ReverseZoneName(input) ?? "null") + ".");
        // The NetworkId of the modern reverse-zone create (1.0.4) for each reverse zone of the vectors, and null for other names.
        var networks = new Dictionary<string, string> { ["10"] = "10.0.0.0/8", ["10.20"] = "10.20.0.0/16", ["10.20.30"] = "10.20.30.0/24", ["192.168.0"] = "192.168.0.0/24", ["2001:db8:1::/48"] = "2001:db8:1::/48", ["2001:db8::/32"] = "2001:db8::/32", ["fd00::/8"] = "fd00::/8" };
        foreach (var (input, zone) in ReverseVectors.Where(vector => vector.Zone is not null)) Check(DnsChanges.ReverseNetworkId(zone!) == networks[input], "The network ID of " + zone + " is " + (DnsChanges.ReverseNetworkId(zone!) ?? "null") + ".");
        Check(DnsChanges.ReverseNetworkId("lab.example") is null && DnsChanges.ReverseNetworkId("0-25.2.0.192.in-addr.arpa") is null && DnsChanges.ReverseNetworkId("4.3.2.1.in-addr.arpa") is null && DnsChanges.ReverseNetworkId("2.0.192.in-addr.arpa.") == "192.0.2.0/24", "A name without a network ID gave one.");
        Check(DnsChanges.NameValid("corp.example") && DnsChanges.NameValid("corp.example.") && DnsChanges.NameValid("_msdcs.corp.example") && !DnsChanges.NameValid("bad name.example") && !DnsChanges.NameValid(new string('a', 64) + ".example") && !DnsChanges.NameValid("a..b") && !DnsChanges.NameValid(""), "Names validate wrongly.");
        Check(DnsChanges.RecordNameValid("@", "corp.example") && DnsChanges.RecordNameValid("", "corp.example") && DnsChanges.RecordNameValid("*.lab", "corp.example") && DnsChanges.RecordNameValid("_ldap._tcp", "corp.example") && !DnsChanges.RecordNameValid("a b", "corp.example") && !DnsChanges.RecordNameValid("x.*", "corp.example"), "Record names validate wrongly.");
        Check(DnsChanges.Fqdn("mail.corp.example") && !DnsChanges.Fqdn("mail") && DnsChanges.Fqdn(".", allowRoot: true) && !DnsChanges.Fqdn("."), "Host names validate wrongly.");
        Check(Wql.Quote("corp.example") == "'corp.example'" && Wql.Quote("a'b") == @"'a\'b'" && Wql.Quote(@"a\b") == @"'a\\b'", "WQL values are not escaped.");
        bool refused = false; try { Wql.Quote("a\nb"); } catch (ArgumentException) { refused = true; }
        Check(refused, "A WQL value with a control character was accepted.");
        Check(DnsText.TxtStrings("\"v=spf1 mx -all\" \"second \\\"q\\\"\"").SequenceEqual(["v=spf1 mx -all", "second \"q\""]) && DnsText.TxtStrings("plain").SequenceEqual(["plain"]), "TXT strings parse wrongly.");
        Check(DnsText.TxtText(["a", "b\"c"]) == "\"a\" \"b\\\"c\"", "TXT text quotes wrongly.");
    }

    private static JsonObject Json(string text) => (JsonObject)JsonNode.Parse(text)!;
    private static string? FieldOf(string operation, string parameters) { try { DnsChanges.Validate(operation, Json(parameters)); return null; } catch (InvalidChangeException e) { return e.Field; } }
    private static void Parameters()
    {
        // One good input per operation.
        var good = new Dictionary<string, string>
        {
            ["dns-zone-create"] = """{"kind":"primary","lookup":"forward","name":"lab.corp.example","storage":"ad","replicationScope":"domain","fileName":null,"masters":[],"dynamicUpdate":"secure"}""",
            ["dns-zone-edit"] = """{"zone":"corp.example","transfers":{"mode":"list","servers":["10.0.0.2"]},"aging":{"enabled":true,"noRefreshHours":168,"refreshHours":168}}""",
            ["dns-zone-delete"] = """{"zone":"corp.example"}""",
            ["dns-zone-transfer"] = """{"zone":"partner.example"}""",
            ["dns-record-add"] = """{"zone":"corp.example","name":"www","type":"A","ttlSeconds":3600,"ageRecord":false,"data":{"address":"10.0.0.10"}}""",
            ["dns-record-edit"] = """{"zone":"corp.example","record":{"name":"www","type":"A","data":{"address":"10.0.0.10"}},"data":{"address":"10.0.0.11"}}""",
            ["dns-record-delete"] = """{"zone":"corp.example","records":[{"name":"www","type":"A","data":{"address":"10.0.0.10"}}]}""",
            ["dns-conditional-create"] = """{"name":"branch.example","masters":["10.40.0.10"],"storage":"ad","replicationScope":"forest","timeoutSeconds":5}""",
            ["dns-conditional-edit"] = """{"name":"branch.example","timeoutSeconds":7}""",
            ["dns-conditional-delete"] = """{"name":"branch.example"}""",
            ["dns-forwarders-set"] = """{"servers":["9.9.9.9","2620:fe::fe"],"timeoutSeconds":3,"useRootHints":true}""",
            ["dns-scavenging-set"] = """{"enabled":true,"intervalHours":168,"defaultAging":{"enabled":true,"noRefreshHours":168,"refreshHours":168},"applyToAdZones":false}""",
            ["dns-scavenge-now"] = "{}",
            ["dns-cache-clear"] = "{}",
        };
        Check(good.Keys.OrderBy(key => key).SequenceEqual(DnsChanges.Operations.OrderBy(key => key)), "Not every operation has a parameter sample.");
        foreach (var (operation, parameters) in good) Check(FieldOf(operation, parameters) is null, "A good " + operation + " was refused: " + FieldOf(operation, parameters) + ".");
        // Records of every managed type.
        foreach (var data in new[] { """{"type":"AAAA","data":{"address":"2001:db8::10"}}""", """{"type":"CNAME","data":{"target":"web.corp.example"}}""", """{"type":"MX","data":{"preference":10,"exchange":"mail.corp.example"}}""",
            """{"type":"TXT","data":{"strings":["a","b"]}}""", """{"type":"SRV","data":{"priority":0,"weight":100,"port":389,"target":"dc.corp.example"}}""", """{"type":"NS","data":{"nameServer":"ns.corp.example"}}""" })
            Check(FieldOf("dns-record-add", """{"zone":"corp.example","name":"x","ttlSeconds":null,"ageRecord":true,""" + data[1..]) is null, "A good record was refused: " + data);
        // Bad inputs: unknown keys, bounds, names, addresses, SOA and the storage rules.
        var bad = new (string Operation, string Parameters, string Field)[]
        {
            ("dns-zone-delete", """{"zone":"corp.example","extra":1}""", "extra"),
            ("dns-zone-create", """{"kind":"primary","lookup":"forward","name":"bad name","storage":"file","replicationScope":null,"fileName":null,"masters":[],"dynamicUpdate":"none"}""", "name"),
            ("dns-zone-create", """{"kind":"secondary","lookup":"forward","name":"a.example","storage":"ad","replicationScope":"domain","fileName":null,"masters":["10.0.0.1"],"dynamicUpdate":"none"}""", "storage"),
            ("dns-zone-create", """{"kind":"secondary","lookup":"forward","name":"a.example","storage":"file","replicationScope":null,"fileName":null,"masters":[],"dynamicUpdate":"none"}""", "masters"),
            ("dns-zone-create", """{"kind":"primary","lookup":"forward","name":"a.example","storage":"file","replicationScope":null,"fileName":null,"masters":[],"dynamicUpdate":"secure"}""", "dynamicUpdate"),
            ("dns-zone-create", """{"kind":"primary","lookup":"forward","name":"a.example","storage":"ad","replicationScope":null,"fileName":null,"masters":[],"dynamicUpdate":"none"}""", "replicationScope"),
            ("dns-zone-create", """{"kind":"primary","lookup":"reverse","networkId":"10.20.30.40","storage":"file","replicationScope":null,"fileName":null,"masters":[],"dynamicUpdate":"none"}""", "networkId"),
            ("dns-zone-create", """{"kind":"primary","lookup":"forward","name":"a.example","storage":"file","replicationScope":null,"fileName":"..\\x.dns","masters":[],"dynamicUpdate":"none"}""", "fileName"),
            ("dns-zone-edit", """{"zone":"corp.example"}""", "zone"),
            ("dns-zone-edit", """{"zone":"corp.example","aging":{"enabled":true,"noRefreshHours":0,"refreshHours":168}}""", "noRefreshHours"),
            ("dns-zone-edit", """{"zone":"corp.example","transfers":{"mode":"list","servers":[]}}""", "servers"),
            ("dns-record-add", """{"zone":"corp.example","name":"www","type":"SOA","ttlSeconds":null,"ageRecord":false,"data":{}}""", "type"),
            ("dns-record-add", """{"zone":"corp.example","name":"www","type":"A","ttlSeconds":null,"ageRecord":false,"data":{"address":"2001:db8::1"}}""", "address"),
            ("dns-record-add", """{"zone":"corp.example","name":"www","type":"MX","ttlSeconds":null,"ageRecord":false,"data":{"preference":70000,"exchange":"mail.corp.example"}}""", "preference"),
            ("dns-record-add", """{"zone":"corp.example","name":"www","type":"CNAME","ttlSeconds":null,"ageRecord":false,"data":{"target":"web"}}""", "target"),
            ("dns-record-add", """{"zone":"corp.example","name":"www","type":"PTR","ttlSeconds":null,"ageRecord":false,"data":{"host":"web.corp.example"}}""", "type"),
            ("dns-record-add", """{"zone":"corp.example","name":"www","type":"A","ttlSeconds":-1,"ageRecord":false,"data":{"address":"10.0.0.1"}}""", "ttlSeconds"),
            ("dns-record-add", """{"zone":"corp.example","name":"www","type":"TXT","ttlSeconds":null,"ageRecord":false,"data":{"strings":[]}}""", "strings"),
            ("dns-record-edit", """{"zone":"corp.example","record":{"name":"@","type":"SOA","data":{}},"ttlSeconds":60}""", "record"),
            ("dns-record-edit", """{"zone":"corp.example","record":{"name":"www","type":"A","data":{"address":"10.0.0.10"}}}""", "record"),
            ("dns-record-delete", """{"zone":"corp.example","records":[]}""", "records"),
            ("dns-conditional-create", """{"name":"branch.example","masters":["10.40.0.10","10.40.0.10"],"storage":"file","replicationScope":null,"timeoutSeconds":5}""", "masters"),
            ("dns-conditional-create", """{"name":"branch.example","masters":["10.40.0.10"],"storage":"file","replicationScope":null,"timeoutSeconds":16}""", "timeoutSeconds"),
            ("dns-forwarders-set", """{"servers":["not-an-ip"],"timeoutSeconds":3,"useRootHints":true}""", "servers"),
            ("dns-scavenging-set", """{"enabled":true,"intervalHours":9000,"defaultAging":{"enabled":true,"noRefreshHours":168,"refreshHours":168},"applyToAdZones":false}""", "intervalHours"),
            ("dns-cache-clear", """{"x":1}""", "x"),
        };
        foreach (var (operation, parameters, field) in bad) Check(FieldOf(operation, parameters) == field, "A bad " + operation + " gave " + (FieldOf(operation, parameters) ?? "no error") + ", not " + field + ": " + parameters);
    }

    private static void Mapping()
    {
        var v = (params (string Key, object? Value)[] pairs) => (IReadOnlyDictionary<string, object?>)pairs.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        Check(DnsSnapshot.Data("A", v(("IPAddress", "10.0.0.10"))).ToJsonString() == """{"address":"10.0.0.10"}""", "A data map wrongly.");
        Check(DnsSnapshot.Data("AAAA", v(("IPv6Address", "2001:0DB8:0000::0010"))).ToJsonString() == """{"address":"2001:db8::10"}""", "AAAA data are not canonical.");
        Check(DnsSnapshot.Data("CNAME", v(("PrimaryName", "Web.Corp.Example."))).ToJsonString() == """{"target":"web.corp.example"}""", "CNAME data map wrongly.");
        Check(DnsSnapshot.Data("MX", v(("Preference", 10), ("MailExchange", "mail.corp.example."))).ToJsonString() == """{"preference":10,"exchange":"mail.corp.example"}""", "MX data map wrongly.");
        Check(DnsSnapshot.Data("SRV", v(("Priority", 0), ("Weight", 100), ("Port", 389), ("DomainName", "dc.corp.example."))).ToJsonString() == """{"priority":0,"weight":100,"port":389,"target":"dc.corp.example"}""", "SRV data map wrongly.");
        Check(DnsSnapshot.Data("TXT", v(("DescriptiveText", "\"a\" \"b\""))).ToJsonString() == """{"strings":["a","b"]}""", "TXT data map wrongly.");
        Check(DnsSnapshot.Data("SOA", v(("PrimaryServer", "dc.corp.example."), ("ResponsibleParty", "hostmaster.corp.example."), ("SerialNumber", 7), ("RefreshInterval", 900), ("RetryDelay", 600), ("ExpireLimit", 86400), ("MinimumTTL", 3600)))["serial"]!.GetValue<long>() == 7, "SOA data map wrongly.");
        Check(DnsSnapshot.Data("CAA", v()).Count == 0 && DnsSnapshot.Type("MicrosoftDNS_AAAAType") == "AAAA" && DnsSnapshot.Type("MicrosoftDNS_SOAType") == "SOA", "Other types map wrongly.");
        Check(DnsSnapshot.Relative("www.corp.example.", "corp.example") == "www" && DnsSnapshot.Relative("corp.example", "corp.example") == "@" && DnsSnapshot.Timestamp(0) is null && DnsSnapshot.Timestamp(3_700_000) is not null, "Record names or timestamps map wrongly.");
        Check(DnsChanges.TextRepresentation("corp.example", new RecordValue("@", "MX", Json("""{"preference":10,"exchange":"mail.corp.example"}""")), null) == "corp.example. IN MX 10 mail.corp.example."
            && DnsChanges.TextRepresentation("corp.example", new RecordValue("www", "A", Json("""{"address":"10.0.0.1"}""")), 600) == "www.corp.example. IN 600 A 10.0.0.1", "The record text is wrong.");
        var zone = DnsSnapshot.Zone(new RawZone("Corp.Example", 1, false, true, "Forest", null, null, 2, 1, [], 1, [], [], true, 168, 168, null, false, false, null, 12))!;
        Check(zone["name"]!.GetValue<string>() == "corp.example" && zone["replicationScope"]!.GetValue<string>() == "forest" && zone["dynamicUpdate"]!.GetValue<string>() == "secure" && zone["transfers"]!["mode"]!.GetValue<string>() == "nameServers" && zone["fileName"] is null, "A zone maps wrongly.");
        Check(DnsSnapshot.Zone(new RawZone(".", 0, false, false, null, null, null, 0, 3, [], 0, [], [], false, 0, 0, null, false, true, null, null)) is null, "The cache zone was listed.");
    }

    private static RawRecord Raw(string owner, string type, params (string Key, object? Value)[] values) => new(owner, type, 3600, 0, type + " text", values.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal));
    private static void Cut()
    {
        var records = Enumerable.Range(0, 30_000).Select(i => Raw("host" + i + ".corp.example", "A", ("IPAddress", "10.0." + i / 250 + "." + i % 250))).ToList();
        var zone = DnsSnapshot.Records("corp.example", records, DateTimeOffset.UtcNow);
        Check(DnsSnapshot.Size(zone) <= DnsSnapshot.MaximumBytes && zone["truncated"]!.GetValue<bool>() && zone["total"]!.GetValue<int>() == 30_000 && zone["records"]!.AsArray().Count < 30_000, "The zone records were not cut to 2 MiB.");
        var small = DnsSnapshot.FitRecords(DnsSnapshot.Records("corp.example", records.Take(100).ToList(), DateTimeOffset.UtcNow), 4000);
        Check(DnsSnapshot.Size(small) <= 4000 && small["truncated"]!.GetValue<bool>(), "A small cap did not cut the records.");
        var zones = Enumerable.Range(0, 2500).Select(i => new RawZone("zone" + i + ".example", 1, false, true, "Domain", null, null, 2, 3, [], 0, [], [], false, 168, 168, null, false, false, null, 10)).ToList();
        var server = DnsSnapshot.Server(new RawServer("dc.corp.example", "corp.example", "10.0.20348", true, ["10.0.0.1"], [], 3, true, 0, null, false, 168, 168, zones), DateTimeOffset.UtcNow);
        Check(server["zones"]!.AsArray().Count == DnsSnapshot.MaximumZones && server["truncated"]!["zones"]!.GetValue<bool>(), "More than 2000 zones were not cut.");
        var fitted = DnsSnapshot.FitServer(server, 20_000);
        Check(DnsSnapshot.Size(fitted) <= 20_000 && fitted["truncated"]!["zones"]!.GetValue<bool>(), "The server read was not cut by its zones.");
    }

    /// <summary>An in-memory DNS server for the change tests.</summary>
    private sealed class MemoryDns : IDnsServer
    {
        internal List<RawZone> ZoneList { get; } = [new("corp.example", 1, false, true, "Domain", null, null, 2, 3, [], 0, [], [], true, 168, 168, null, false, false, null, null), new("partner.example", 2, false, false, null, null, "partner.example.dns", 0, 3, [], 0, [], ["192.0.2.53"], false, 0, 0, null, false, false, null, null)];
        internal List<RawRecord> RecordList { get; } = [Raw("corp.example", "NS", ("NSHost", "dc.corp.example.")), Raw("www.corp.example", "A", ("IPAddress", "10.0.0.10"))];
        internal List<string> Calls { get; } = [];
        internal Func<RecordValue, bool>? FailAdd { get; set; }
        /// <summary>The failure of CreateZone, thrown after the zone was added when AddZoneAnyway is set.</summary>
        internal WmiException? FailCreate { get; set; }
        internal bool AddZoneAnyway { get; set; }
        /// <summary>Plugin 1.0.4: CreateZone runs DnsChanges.ModernFirst with a modern and a legacy call that fail with these exceptions (null: the call succeeds).</summary>
        internal bool TwoProviders { get; set; }
        internal WmiException? ModernFailure { get; set; }
        internal WmiException? LegacyFailure { get; set; }
        public DnsService.Status Service() => DnsService.Status.Running;
        public bool IsDomainController() => true;
        public IReadOnlyList<RawZone> Zones() => ZoneList;
        public IReadOnlyList<RawRecord> Records(string zone) => RecordList.ToList();
        public void CreateZone(string name, string kind, bool ad, string? scope, string? fileName, string[] masters)
        {
            void Add() => ZoneList.Add(new(name, kind switch { "primary" => 1, "secondary" => 2, "stub" => 3, _ => 4 }, false, ad, scope, null, fileName, 0, 3, [], 0, [], masters, false, 0, 0, null, false, false, null, null));
            if (TwoProviders)
            {
                DnsChanges.ModernFirst(kind, () => { Calls.Add("modern " + name); if (ModernFailure is not null) throw ModernFailure; Add(); }, () => { Calls.Add("legacy " + name); if (LegacyFailure is not null) throw LegacyFailure; Add(); }, () => ZoneList.Any(zone => zone.Name == name));
                return;
            }
            Calls.Add("create " + name);
            if (FailCreate is not null && !AddZoneAnyway) throw FailCreate;
            Add();
            if (FailCreate is not null) throw FailCreate;
        }
        public void SetZone(string zone, ZoneSettings settings) => Calls.Add("set " + zone);
        public void SetStorage(string zone, string kind, bool ad, string? scope, string? fileName, string[] masters) => Calls.Add("storage " + zone);
        public void DeleteZone(string zone) { Calls.Add("delete " + zone); ZoneList.RemoveAll(item => item.Name == zone); }
        public void TransferZone(string zone) => Calls.Add("transfer " + zone);
        public void AddRecord(string zone, RecordValue record, long? ttl, bool age)
        {
            Calls.Add("add " + record.Key);
            if (FailAdd?.Invoke(record) == true) throw new WmiException("CreateInstanceFromTextRepresentation", unchecked((int)0x80070000 | 9711));
            var values = record.Type == "A" ? new[] { ("IPAddress", (object?)record.Data["address"]!.GetValue<string>()) } : [];
            RecordList.Add(new RawRecord(record.Name == "@" ? zone : record.Name + "." + zone, record.Type, ttl ?? 3600, age ? 1 : 0, "", values.ToDictionary(pair => pair.Item1, pair => pair.Item2, StringComparer.Ordinal)));
        }
        public void DeleteRecord(string zone, RawRecord record) { Calls.Add("remove " + DnsChanges.Value(record, zone).Key); RecordList.Remove(record); }
        public void SetForwarders(string[] servers, long timeout, bool useRootHints) => Calls.Add("forwarders");
        public void SetScavenging(bool enabled, long intervalHours, (bool Enabled, long NoRefresh, long Refresh) aging, bool applyToAdZones) => Calls.Add("scavenging");
        public void ScavengeNow() => Calls.Add("scavenge");
        public void ClearCache() => Calls.Add("cache");
    }

    private static Program.Outcome Server() => new(true, "PLUGIN_DNS_READ_COMPLETED", new Dictionary<string, string>(), new JsonObject { ["kind"] = "server" });
    private static Program.Outcome Zone(string zone) => new(true, "PLUGIN_DNS_ZONE_READ_COMPLETED", new Dictionary<string, string>(), new JsonObject { ["kind"] = "zone", ["zone"] = zone });

    private static void Rollback()
    {
        var memory = new MemoryDns { FailAdd = record => record.Data["address"]!.GetValue<string>() == "10.0.0.11" };
        var outcome = DnsChanges.Run("dns-record-edit", Json("""{"zone":"corp.example","record":{"name":"www","type":"A","data":{"address":"10.0.0.10"}},"data":{"address":"10.0.0.11"}}"""), Server, Zone, memory);
        Check(!outcome.Ok && outcome.Code == "PLUGIN_DNS_OBJECT_EXISTS", "A failed add of an edit did not report its code: " + outcome.Code);
        Check(memory.RecordList.Count(item => item.Type == "A") == 1 && memory.RecordList.Any(item => item.Values.TryGetValue("IPAddress", out var value) && value as string == "10.0.0.10"), "The old record did not come back after a failed edit.");
        Check(memory.Calls.SequenceEqual(["remove www|A|{\"address\":\"10.0.0.10\"}", "add www|A|{\"address\":\"10.0.0.11\"}", "add www|A|{\"address\":\"10.0.0.10\"}"]), "The edit did not run delete, add and the restore: " + string.Join("; ", memory.Calls));
        var ok = new MemoryDns();
        var edited = DnsChanges.Run("dns-record-edit", Json("""{"zone":"corp.example","record":{"name":"www","type":"A","data":{"address":"10.0.0.10"}},"data":{"address":"10.0.0.11"}}"""), Server, Zone, ok);
        Check(edited.Ok && edited.Code == "PLUGIN_DNS_CHANGED" && ok.RecordList.Any(item => item.Values.TryGetValue("IPAddress", out var value) && value as string == "10.0.0.11") && !ok.RecordList.Any(item => item.Values.TryGetValue("IPAddress", out var value) && value as string == "10.0.0.10"), "A record edit did not replace the record.");
        // The plugin's own final checks: a missing record, a duplicate, the last apex NS, a secondary zone.
        Check(DnsChanges.Run("dns-record-delete", Json("""{"zone":"corp.example","records":[{"name":"ftp","type":"A","data":{"address":"10.0.0.99"}}]}"""), Server, Zone, new MemoryDns()).Code == "PLUGIN_DNS_OBJECT_MISSING", "A missing record was not refused.");
        Check(DnsChanges.Run("dns-record-add", Json("""{"zone":"corp.example","name":"www","type":"A","ttlSeconds":null,"ageRecord":false,"data":{"address":"10.0.0.10"}}"""), Server, Zone, new MemoryDns()).Code == "PLUGIN_DNS_OBJECT_EXISTS", "A duplicate record was not refused.");
        Check(DnsChanges.Run("dns-record-delete", Json("""{"zone":"corp.example","records":[{"name":"@","type":"NS","data":{"nameServer":"dc.corp.example"}}]}"""), Server, Zone, new MemoryDns()).Code == "PLUGIN_DNS_INVALID_CHANGE", "The last apex NS was deleted.");
        Check(DnsChanges.Run("dns-record-add", Json("""{"zone":"partner.example","name":"x","type":"A","ttlSeconds":null,"ageRecord":false,"data":{"address":"10.0.0.1"}}"""), Server, Zone, new MemoryDns()).Code == "PLUGIN_DNS_INVALID_CHANGE", "A record went into a secondary zone.");
        Check(DnsChanges.Run("dns-zone-create", Json("""{"kind":"primary","lookup":"forward","name":"corp.example","storage":"ad","replicationScope":"domain","fileName":null,"masters":[],"dynamicUpdate":"secure"}"""), Server, Zone, new MemoryDns()).Code == "PLUGIN_DNS_OBJECT_EXISTS", "An existing zone was created again.");
        Check(DnsChanges.Refused(new WmiException("x", unchecked((int)0x80070005)), "z").Code == "PLUGIN_DNS_ACCESS_DENIED" && DnsChanges.Refused(new WmiException("x", unchecked((int)0x80070000 | 9601)), "z").Code == "PLUGIN_DNS_OBJECT_MISSING"
            && DnsChanges.Refused(new WmiException("x", unchecked((int)0x80070000 | 9717)), "z").Code == "PLUGIN_DNS_NOT_DOMAIN_CONTROLLER" && DnsChanges.Refused(new WmiException("x", unchecked((int)0x80041001)), "z").Code == "PLUGIN_DNS_CHANGE_FAILED", "WMI errors map wrongly.");
    }

    /// <summary>
    /// A failed zone create (plugin 1.0.3): a generic WMI failure after which the
    /// zone exists counts as done, and the error number is the provider code of
    /// the WMI error object when there is one, else the HRESULT as before.
    /// </summary>
    private static void ZoneCreateFailures()
    {
        const int generic = unchecked((int)0x80041001);
        static JsonObject Primary(string dynamic) => Json("""{"kind":"primary","lookup":"forward","name":"lab.example","storage":"file","replicationScope":null,"fileName":"lab.example.dns","masters":[],"dynamicUpdate":"__"}""".Replace("__", dynamic, StringComparison.Ordinal));
        var anyway = new MemoryDns { FailCreate = new WmiException("ExecMethod CreateZone", generic), AddZoneAnyway = true };
        var created = DnsChanges.Run("dns-zone-create", Primary("nonsecureAndSecure"), Server, Zone, anyway);
        Check(created.Ok && created.Code == "PLUGIN_DNS_CHANGED" && created.Data?["kind"]?.GetValue<string>() == "server" && anyway.Calls.SequenceEqual(["create lab.example", "set lab.example"]), "(a) A zone created despite 0x80041001 did not count as done with its dynamic update: " + created.Code + " " + string.Join("; ", anyway.Calls));
        var exists = new MemoryDns { FailCreate = new WmiException("ExecMethod CreateZone", generic, 9609) };
        var refused = DnsChanges.Run("dns-zone-create", Primary("none"), Server, Zone, exists);
        Check(!refused.Ok && refused.Code == "PLUGIN_DNS_OBJECT_EXISTS" && refused.Args.GetValueOrDefault("object") == "lab.example", "(b) Provider code 9609 did not give PLUGIN_DNS_OBJECT_EXISTS {object}: " + refused.Code);
        var other = DnsChanges.Run("dns-zone-create", Primary("none"), Server, Zone, new MemoryDns { FailCreate = new WmiException("ExecMethod CreateZone", generic, 9999) });
        Check(!other.Ok && other.Code == "PLUGIN_DNS_CHANGE_FAILED" && other.Args.GetValueOrDefault("error") == "9999", "(c) Provider code 9999 did not give PLUGIN_DNS_CHANGE_FAILED {error:9999}: " + other.Code + " " + other.Args.GetValueOrDefault("error"));
        var bare = DnsChanges.Run("dns-zone-create", Primary("none"), Server, Zone, new MemoryDns { FailCreate = new WmiException("ExecMethod CreateZone", generic) });
        Check(!bare.Ok && bare.Code == "PLUGIN_DNS_CHANGE_FAILED" && bare.Args.GetValueOrDefault("error") == "2147749889", "(d) A generic failure without a provider code did not keep error 2147749889: " + bare.Args.GetValueOrDefault("error"));
        var wrapped = new WmiException("PutInstance", generic, unchecked((uint)0x800725C9));
        Check(wrapped.Code == 9673 && new WmiException("x", generic, 9609).Code == 9609 && new WmiException("x", unchecked((int)0x800725C9)).Code == 9673 && new WmiException("x", generic).Code == 2147749889L
            && new WmiException("x", generic, 5).AccessDenied && !new WmiException("x", generic, 9609).AccessDenied && wrapped.Message.Contains("0x80041001", StringComparison.Ordinal) && wrapped.Message.Contains("2147952073", StringComparison.Ordinal),
            "(e) WmiException.Code does not unwrap a FACILITY_WIN32 provider code: " + wrapped.Code + " " + wrapped.Message);
        Check(DnsChanges.Refused(new WmiException("x", generic, 9601), "z").Code == "PLUGIN_DNS_OBJECT_MISSING" && DnsChanges.Refused(new WmiException("x", generic, 9717), "z").Code == "PLUGIN_DNS_NOT_DOMAIN_CONTROLLER" && DnsChanges.Refused(new WmiException("x", generic, 5), "z").Code == "PLUGIN_DNS_ACCESS_DENIED", "Provider codes map wrongly.");
    }

    /// <summary>
    /// Plugin 1.0.4: the order of the two providers (DnsChanges.ModernFirst and
    /// LegacyFirst), the result args of a failed change (Refused) and the zone
    /// list that adds the zones only root\Microsoft\Windows\DNS reports
    /// (DnsSnapshot.ModernZone, MergeZones).
    /// </summary>
    private static void ZoneProviders()
    {
        const int generic = unchecked((int)0x80041001), notFound = unchecked((int)0x80041002);
        static JsonObject Primary() => Json("""{"kind":"primary","lookup":"forward","name":"lab.example","storage":"file","replicationScope":null,"fileName":"lab.example.dns","masters":[],"dynamicUpdate":"none"}""");
        var calls = new List<string>();
        Action Call(string name, WmiException? failure = null) => () => { calls.Add(name); if (failure is not null) throw failure; };
        WmiException? Thrown(Action action) { try { action(); return null; } catch (WmiException e) { return e; } }

        // (f) The modern call succeeds: the legacy call does not run.
        calls.Clear();
        Check(Thrown(() => DnsChanges.ModernFirst("primary", Call("modern"), Call("legacy"), () => false)) is null && calls.SequenceEqual(["modern"]), "(f) A successful modern create still ran the legacy call: " + string.Join("; ", calls));
        var f = new MemoryDns { TwoProviders = true };
        var created = DnsChanges.Run("dns-zone-create", Primary(), Server, Zone, f);
        Check(created.Ok && created.Code == "PLUGIN_DNS_CHANGED" && f.Calls.SequenceEqual(["modern lab.example"]), "(f) The modern create did not answer PLUGIN_DNS_CHANGED alone: " + created.Code + " " + string.Join("; ", f.Calls));

        // (g) A wrong modern name (GetMethod 0x80041002, no provider code), zone absent: the legacy call runs once and succeeds.
        calls.Clear();
        var lookup = new WmiException("PS_DnsServerPrimaryZone GetMethod AddByFileForwardLookupZone", notFound, signature: "methods AddByADForwardLookupZone") { SchemaStep = true };
        Check(Thrown(() => DnsChanges.ModernFirst("primary", Call("modern", lookup), Call("legacy"), () => false)) is null && calls.SequenceEqual(["modern", "legacy"]), "(g) A failed modern lookup did not run the legacy call once: " + string.Join("; ", calls));
        Check(!lookup.NotFound && DnsChanges.Refused(lookup, "lab.example").Code == "PLUGIN_DNS_CHANGE_FAILED" && DnsChanges.Refused(lookup, "lab.example").Args.GetValueOrDefault("signature") == "methods AddByADForwardLookupZone", "(g) A failed lookup step reads as a missing DNS object or loses its signature.");

        // (h) Both fail with 0x80041001, only the modern one has a description: the modern exception with both attempts.
        calls.Clear();
        var modern = new WmiException("PS_DnsServerPrimaryZone ExecMethod AddByFileForwardLookupZone", generic, description: "The zone file could not be written");
        var legacy = new WmiException("MicrosoftDNS_Zone ExecMethod CreateZone", generic);
        var both = Thrown(() => DnsChanges.ModernFirst("primary", Call("modern", modern), Call("legacy", legacy), () => false));
        var bothResult = both is null ? null : DnsChanges.Refused(both, "lab.example");
        Check(ReferenceEquals(both, modern) && calls.SequenceEqual(["modern", "legacy"]) && bothResult?.Code == "PLUGIN_DNS_CHANGE_FAILED_DETAIL"
            && bothResult.Args.GetValueOrDefault("attempts") == "PS_DnsServerPrimaryZone ExecMethod AddByFileForwardLookupZone 0x80041001; MicrosoftDNS_Zone ExecMethod CreateZone 0x80041001",
            "(h) Two generic failures did not give the modern exception with both attempts: " + bothResult?.Args.GetValueOrDefault("attempts"));
        var coded = new WmiException("MicrosoftDNS_Zone ExecMethod CreateZone", generic, 9999);
        var plain = new WmiException("m", generic);
        Check(ReferenceEquals(DnsChanges.Chosen(new WmiException("m", generic, description: "text"), coded), coded) && ReferenceEquals(DnsChanges.Chosen(plain, new WmiException("l", generic)), plain), "(h) The exception with a provider code, else the first one, is not chosen.");

        // (i) The modern call answers 9609 (the zone exists): the legacy call does not run, Run gives PLUGIN_DNS_OBJECT_EXISTS.
        var i = new MemoryDns { TwoProviders = true, ModernFailure = new WmiException("PS_DnsServerPrimaryZone ExecMethod AddByFileForwardLookupZone", generic, 9609) };
        var exists = DnsChanges.Run("dns-zone-create", Primary(), Server, Zone, i);
        Check(!exists.Ok && exists.Code == "PLUGIN_DNS_OBJECT_EXISTS" && exists.Args.GetValueOrDefault("object") == "lab.example" && i.Calls.SequenceEqual(["modern lab.example"]), "(i) Provider code 9609 of the modern call did not give PLUGIN_DNS_OBJECT_EXISTS without the legacy call: " + exists.Code + " " + string.Join("; ", i.Calls));

        // (j) A conditional forwarder takes only the legacy call.
        calls.Clear();
        Check(Thrown(() => DnsChanges.ModernFirst("forwarder", Call("modern"), Call("legacy"), () => false)) is null && calls.SequenceEqual(["legacy"]) && DnsChanges.CimZoneClass("forwarder") is null, "(j) A conditional forwarder reached the modern provider: " + string.Join("; ", calls));
        var j = new MemoryDns { TwoProviders = true };
        DnsChanges.Run("dns-conditional-create", Json("""{"name":"branch.example","masters":["10.40.0.10"],"storage":"file","replicationScope":null,"timeoutSeconds":5}"""), Server, Zone, j);
        Check(j.Calls.FirstOrDefault() == "legacy branch.example" && !j.Calls.Any(call => call.StartsWith("modern", StringComparison.Ordinal)), "(j) dns-conditional-create called the modern provider: " + string.Join("; ", j.Calls));

        // (k) The modern call fails generically and the zone exists: the legacy call does not run, the modern failure is thrown.
        calls.Clear();
        var generic1 = new WmiException("PS_DnsServerPrimaryZone ExecMethod AddByFileForwardLookupZone", generic);
        Check(ReferenceEquals(Thrown(() => DnsChanges.ModernFirst("primary", Call("modern", generic1), Call("legacy"), () => true)), generic1) && calls.SequenceEqual(["modern"]), "(k) The legacy call ran although the zone existed: " + string.Join("; ", calls));

        // (l) Refused with a description: the detail code, the args of a failed change, at most 8, cleaned and cut to 300 with a final period.
        var text = "Zone\tfile  " + new string('x', 400);
        var detailed = new WmiException("PS_DnsServerPrimaryZone ExecMethod AddByFileForwardLookupZone", generic, 9999, text, "DnsServerPSProvider", "ExecMethod", "AddByFileForwardLookupZone(Name, ZoneFile)");
        var l = DnsChanges.Refused(detailed, "lab.example");
        string detail = l.Args.GetValueOrDefault("detail") ?? "";
        Check(l.Code == "PLUGIN_DNS_CHANGE_FAILED_DETAIL" && l.Args.Count <= 8 && l.Args.Keys.SequenceEqual(["error", "call", "hresult", "provider", "operation", "detail", "attempts", "signature"])
            && l.Args["error"] == "9999" && l.Args["hresult"] == "0x80041001" && l.Args["provider"] == "DnsServerPSProvider" && l.Args["operation"] == "ExecMethod"
            && detail.Length <= 300 && detail.StartsWith("Zone file x", StringComparison.Ordinal) && !detail.Any(char.IsControl) && detail.EndsWith('.') && l.Args["attempts"] == "PS_DnsServerPrimaryZone ExecMethod AddByFileForwardLookupZone 0x80041001 9999"
            && l.Args.Values.All(value => value.Length <= 1000) && Program.Message(l.Code, l.Args).Contains("Windows reports: Zone file x", StringComparison.Ordinal),
            "(l) A failure with a description gave the wrong result: " + l.Code + " " + string.Join(" | ", l.Args.Select(pair => pair.Key + "=" + pair.Value[..Math.Min(pair.Value.Length, 40)])));
        Check(DnsChanges.Refused(new WmiException("c", generic, description: "Done!"), "z").Args["detail"] == "Done!" && DnsChanges.Refused(new WmiException("c", generic, description: "Fehler"), "z").Args["detail"] == "Fehler.", "(l) The final period is added only when the text has no end mark.");

        // (m) Refused without a description: PLUGIN_DNS_CHANGE_FAILED with error, provider - and detail -.
        var m = DnsChanges.Refused(new WmiException("MicrosoftDNS_Zone ExecMethod CreateZone", generic), "lab.example");
        Check(m.Code == "PLUGIN_DNS_CHANGE_FAILED" && m.Args["error"] == "2147749889" && m.Args["provider"] == "-" && m.Args["operation"] == "-" && m.Args["detail"] == "-" && !m.Args.ContainsKey("signature") && m.Args.Count == 7
            && Program.Message(m.Code, m.Args) == "The DNS server refused the change (error 2147749889). Check the values and try again.", "(m) A failure without a description gave the wrong result: " + m.Code);

        // (n) The zone list adds the zones that only DnsServerZone reports; a name in both keeps the MicrosoftDNS_Zone row.
        IReadOnlyDictionary<string, object?> Row(params (string Key, object? Value)[] values) => values.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.OrdinalIgnoreCase);
        var rows = new[]
        {
            Row(("ZoneName", "lab.example"), ("ZoneType", "Primary"), ("ZoneFile", "lab.example.dns"), ("IsDsIntegrated", false), ("IsReverseLookupZone", false), ("DynamicUpdate", "None"), ("SecureSecondaries", "NoTransfer"), ("Notify", "NotifyServers"), ("NotifyServers", new[] { "192.0.2.2" })),
            Row(("ZoneName", "2.0.192.in-addr.arpa"), ("ZoneType", 1), ("ZoneFile", "2.0.192.in-addr.arpa.dns"), ("IsReverseLookupZone", true), ("DynamicUpdate", 1), ("IsAutoCreated", false)),
            Row(("ZoneName", "corp.example"), ("ZoneType", "Primary"), ("IsDsIntegrated", true), ("ReplicationScope", "Forest"), ("DirectoryPartitionName", "ForestDnsZones.corp.example")),
            Row(("ZoneName", "."), ("ZoneType", "Cache")),
        }.Select(row => DnsSnapshot.ModernZone(name => row.GetValueOrDefault(name))).OfType<RawZone>().ToList();
        var onlyModern = DnsSnapshot.MergeZones([], rows.Take(2).ToList());
        var fileZone = onlyModern.FirstOrDefault(zone => zone.Name == "lab.example"); var reverse = onlyModern.FirstOrDefault(zone => zone.Name == "2.0.192.in-addr.arpa");
        var fileZoneJson = fileZone is null ? null : DnsSnapshot.Zone(fileZone); var reverseJson = reverse is null ? null : DnsSnapshot.Zone(reverse);
        Check(onlyModern.Count == 2 && fileZoneJson?["kind"]?.GetValue<string>() == "primary" && fileZoneJson["storage"]?.GetValue<string>() == "file" && fileZoneJson["fileName"]?.GetValue<string>() == "lab.example.dns" && fileZoneJson["lookup"]?.GetValue<string>() == "forward"
            && fileZoneJson["transfers"]!["mode"]!.GetValue<string>() == "none" && fileZoneJson["notify"]!["mode"]!.GetValue<string>() == "list" && fileZone!.RecordCount is null && !fileZone.Aging
            && reverseJson?["kind"]?.GetValue<string>() == "primary" && reverse!.Reverse && reverseJson["lookup"]?.GetValue<string>() == "reverse" && reverseJson["dynamicUpdate"]?.GetValue<string>() == "nonsecureAndSecure",
            "(n) The zones of DnsServerZone map wrongly: " + string.Join("; ", onlyModern.Select(zone => zone.Name + " " + zone.ZoneType)));
        var legacyRow = new RawZone("corp.example", 1, false, true, null, null, null, 2, 1, [], 1, [], [], true, 168, 168, null, false, false, null, 42);
        var merged = DnsSnapshot.MergeZones([legacyRow], rows);
        var corp = merged.Single(zone => zone.Name == "corp.example");
        Check(rows.Count == 3 && merged.Count == 3 && corp.RecordCount == 42 && corp.Aging && corp.Scope == "Forest" && corp.Partition == "ForestDnsZones.corp.example" && merged[0].Name == "corp.example",
            "(n) A zone in both lists did not keep the MicrosoftDNS_Zone row with the scope of DnsServerZone: " + string.Join("; ", merged.Select(zone => zone.Name)));
        var n = new MemoryDns(); n.ZoneList.Clear(); n.ZoneList.AddRange(onlyModern);
        var again = DnsChanges.Run("dns-zone-create", Primary(), Server, Zone, n);
        Check(!again.Ok && again.Code == "PLUGIN_DNS_OBJECT_EXISTS" && again.Args.GetValueOrDefault("object") == "lab.example" && n.Calls.Count == 0, "(n) A second create of lab.example did not answer PLUGIN_DNS_OBJECT_EXISTS: " + again.Code);

        // The delete order: legacy first, the modern call only after a generic failure that is no DNS answer.
        calls.Clear();
        Check(Thrown(() => DnsChanges.LegacyFirst(Call("legacy", generic1), Call("modern"))) is null && calls.SequenceEqual(["legacy", "modern"]), "A generic legacy delete failure did not run the modern delete.");
        calls.Clear();
        var missing = new WmiException("DeleteInstance", generic, 9601);
        Check(ReferenceEquals(Thrown(() => DnsChanges.LegacyFirst(Call("legacy", missing), Call("modern"))), missing) && calls.SequenceEqual(["legacy"]), "A DNS answer of the legacy delete ran the modern delete.");
    }

    /// <summary>A record change and a transfer read their zone again; every other change reads the server.</summary>
    private static void ReadAfterChange()
    {
        var samples = new (string Operation, string Parameters, string Kind)[]
        {
            ("dns-record-add", """{"zone":"corp.example","name":"ftp","type":"A","ttlSeconds":null,"ageRecord":true,"data":{"address":"10.0.0.20"}}""", "zone"),
            ("dns-record-delete", """{"zone":"corp.example","records":[{"name":"www","type":"A","data":{"address":"10.0.0.10"}}]}""", "zone"),
            ("dns-zone-transfer", """{"zone":"partner.example"}""", "zone"),
            ("dns-zone-create", """{"kind":"primary","lookup":"reverse","networkId":"10.99.0","storage":"file","replicationScope":null,"fileName":null,"masters":[],"dynamicUpdate":"none"}""", "server"),
            ("dns-zone-delete", """{"zone":"corp.example"}""", "server"),
            ("dns-conditional-create", """{"name":"branch.example","masters":["10.40.0.10"],"storage":"ad","replicationScope":"forest","timeoutSeconds":5}""", "server"),
            ("dns-forwarders-set", """{"servers":[],"timeoutSeconds":3,"useRootHints":true}""", "server"),
            ("dns-scavenging-set", """{"enabled":false,"intervalHours":168,"defaultAging":{"enabled":false,"noRefreshHours":168,"refreshHours":168},"applyToAdZones":true}""", "server"),
            ("dns-scavenge-now", "{}", "server"),
            ("dns-cache-clear", "{}", "server"),
        };
        foreach (var (operation, parameters, kind) in samples)
        {
            var memory = new MemoryDns();
            var outcome = DnsChanges.Run(operation, Json(parameters), Server, Zone, memory);
            Check(outcome.Ok && outcome.Code == "PLUGIN_DNS_CHANGED" && outcome.Data?["kind"]?.GetValue<string>() == kind, operation + " did not answer the " + kind + " read: " + outcome.Code);
        }
        var notRead = DnsChanges.Run("dns-cache-clear", new JsonObject(), () => new(false, "PLUGIN_DNS_READ_FAILED", new Dictionary<string, string> { ["error"] = "5" }, null), Zone, new MemoryDns());
        Check(notRead.Ok && notRead.Code == "PLUGIN_DNS_CHANGED_NOT_READ" && notRead.Data is null, "A failed read after a change did not answer CHANGED_NOT_READ.");
        var reverse = new MemoryDns();
        DnsChanges.Run("dns-zone-create", Json("""{"kind":"primary","lookup":"reverse","networkId":"10.99.0","name":"0.99.10.in-addr.arpa","storage":"file","replicationScope":null,"fileName":null,"masters":[],"dynamicUpdate":"none"}"""), Server, Zone, reverse);
        Check(reverse.Calls.Contains("create 0.99.10.in-addr.arpa"), "The reverse zone name was not computed from the network ID.");
    }

    private sealed class Pipe : Stream
    {
        private readonly Channel<byte[]> queue = Channel.CreateUnbounded<byte[]>(); private byte[] current = []; private int offset;
        public override bool CanRead => true; public override bool CanWrite => true; public override bool CanSeek => false;
        public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long o, SeekOrigin s) => throw new NotSupportedException(); public override void SetLength(long v) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int start, int count) => queue.Writer.TryWrite(buffer.AsSpan(start, count).ToArray());
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken token = default) { queue.Writer.TryWrite(buffer.ToArray()); return ValueTask.CompletedTask; }
        public override int Read(byte[] buffer, int start, int count) => ReadAsync(buffer.AsMemory(start, count)).AsTask().GetAwaiter().GetResult();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default)
        {
            while (offset >= current.Length) { if (!await queue.Reader.WaitToReadAsync(token)) return 0; if (queue.Reader.TryRead(out var next)) { current = next; offset = 0; } }
            int take = Math.Min(buffer.Length, current.Length - offset); current.AsMemory(offset, take).CopyTo(buffer); offset += take; return take;
        }
        internal void Complete() => queue.Writer.TryComplete();
    }

    private static async Task ProtocolAsync()
    {
        var calls = new List<string>();
        Program.Outcome Fake(string operation, JsonObject parameters) { calls.Add(operation); return operation == "dns-read" ? new(true, "PLUGIN_DNS_READ_COMPLETED", new Dictionary<string, string> { ["zones"] = "5" }, new JsonObject { ["kind"] = "server" }) : new(true, "PLUGIN_DNS_CHANGED", new Dictionary<string, string>(), null); }
        async Task<(int Code, List<JsonObject> Lines)> Session(params JsonObject[] broker)
        {
            var input = new Pipe(); var output = new Pipe();
            foreach (var line in broker) await PluginProtocol.WriteLineAsync(input, line, PluginProtocol.MaximumBrokerLine, CancellationToken.None);
            input.Complete();
            int code = await Program.HostAsync(input, output, Fake, CancellationToken.None); output.Complete();
            var reader = new PluginLineReader(output); var lines = new List<JsonObject>();
            while (await reader.ReadLineAsync(PluginProtocol.MaximumPluginLine, CancellationToken.None) is byte[] bytes) lines.Add((JsonObject)JsonNode.Parse(bytes)!);
            return (code, lines);
        }
        string id = Guid.NewGuid().ToString();
        var (code, lines) = await Session(PluginProtocol.BrokerHello("4.20.0"), PluginProtocol.Request(id, "dns-read", new JsonObject()));
        Check(code == 0 && lines.Count == 2, "A full session did not answer hello and result.");
        var hello = PluginProtocol.ReadPluginHello(lines[0]);
        Check(hello.Name == "dns" && hello.Version == Program.Version && hello.Capabilities.SequenceEqual(Program.Capabilities), "The plugin hello is wrong.");
        var result = PluginProtocol.ReadResult(lines[1], id);
        Check(result.Ok && result.Code == "PLUGIN_DNS_READ_COMPLETED" && result.Message == "The DNS server was read. Zones: 5." && result.Data?["kind"]?.GetValue<string>() == "server", "The plugin result is wrong.");
        var unknown = await Session(PluginProtocol.BrokerHello("4.20.0"), PluginProtocol.Request(id, "dns-write", new JsonObject()));
        Check(unknown.Code == 3 && unknown.Lines.Count == 1, "An unknown operation got a result.");
        calls.Clear();
        var change = await Session(PluginProtocol.BrokerHello("4.20.0"), PluginProtocol.Request(id, "dns-cache-clear", new JsonObject()));
        Check(change.Code == 0 && calls.SequenceEqual(["dns-cache-clear"]) && PluginProtocol.ReadResult(change.Lines[1], id).Code == "PLUGIN_DNS_CHANGED", "A change operation was not dispatched.");
        Check(Program.Capabilities.Length == 16 && Program.Capabilities.Distinct().Count() == 16 && Program.Capabilities.All(PluginProtocol.IsCapability), "The plugin does not report 16 capabilities.");
        Check(Program.Messages.Keys.All(PluginProtocol.IsCode) && Program.Messages.Count == 14, "The plugin codes are not 14 valid codes.");
    }

    // ---- The contract with the portal (1.0.1) -----------------------------------------------------
    // A domain controller as WMI reports it: AD-integrated forward zones, a file-backed primary with
    // its own transfer and notify lists, IPv4 and IPv6 reverse zones, a secondary, a stub, a
    // conditional forwarder, the zones Windows creates itself and the cache zone, which the read drops.
    private static readonly DateTimeOffset ContractTime = new(2026, 11, 10, 9, 0, 0, TimeSpan.Zero);
    private static RawZone ContractZone(string name, int type, bool reverse = false, bool ad = true, string? scope = "Domain", string? file = null, int update = 2, int secure = 1, string[]? secondaries = null, int notify = 1, string[]? notifyServers = null, string[]? masters = null, bool aging = false, long? timeout = null, bool auto = false, long? records = null)
        => new(name, type, reverse, ad, ad ? scope : null, null, ad ? null : file, update, secure, secondaries ?? [], notify, notifyServers ?? [], masters ?? [], aging, aging ? 168 : 0, aging ? 168 : 0, timeout, false, auto, null, records);
    internal static RawServer ContractServerRaw() => new("DC01.corp.example", "corp.example", "10.0.20348", true, ["10.0.0.10", "fe80::1%3", "2001:DB8::10"], ["192.0.2.53", "2001:db8::53"], 3, true, 168, "2026-11-09T03:00:00Z", true, 168, 168,
    [
        ContractZone("corp.example", 1, aging: true, records: 42),
        ContractZone("_msdcs.corp.example", 1, scope: "Forest", records: 18),
        ContractZone("TrustAnchors", 1, scope: "Forest", update: 0, secure: 3, notify: 0, records: 1),
        ContractZone("branch.example", 1, ad: false, file: "branch.example.dns", update: 0, secure: 2, secondaries: ["10.0.1.10"], notify: 2, notifyServers: ["10.0.1.10"], records: 7),
        ContractZone("1.0.10.in-addr.arpa", 1, reverse: true, records: 12),
        ContractZone("8.b.d.0.1.0.0.2.ip6.arpa", 1, reverse: true, scope: "Forest", records: 3),
        ContractZone("partner.example", 2, ad: false, file: "partner.example.dns", update: 0, secure: 3, notify: 0, masters: ["192.0.2.10"]),
        ContractZone("stub.example", 3, scope: "Legacy", update: 0, secure: 3, notify: 0, masters: ["192.0.2.20"]),
        ContractZone("contoso.example", 4, ad: false, update: 0, secure: 3, notify: 0, masters: ["192.0.2.30", "192.0.2.31"], timeout: 5),
        ContractZone("0.in-addr.arpa", 1, reverse: true, ad: false, update: 0, secure: 3, notify: 0, auto: true),
        ContractZone("127.in-addr.arpa", 1, reverse: true, ad: false, update: 0, secure: 3, notify: 0, auto: true),
        ContractZone("255.in-addr.arpa", 1, reverse: true, ad: false, update: 0, secure: 3, notify: 0, auto: true),
        ContractZone(".", 0, ad: false, update: 0, secure: 3, notify: 0, auto: true),
    ]);
    // The records of corp.example as MicrosoftDNS_ResourceRecord reports them: the per-type values by WMI property name, int for the UI2 and UI4 properties, and __RELPATH.
    private static RawRecord ContractRecord(string owner, string type, long ttl, long timestamp, string text, params (string Key, object? Value)[] values)
    {
        var map = values.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal); map["__RELPATH"] = "MicrosoftDNS_" + type + "Type.ContainerName=\"corp.example\"";
        return new(owner, type, ttl, timestamp, text, map);
    }
    internal static IReadOnlyList<RawRecord> ContractRecordsRaw() =>
    [
        ContractRecord("www.corp.example", "CNAME", 3600, 0, "www.corp.example IN CNAME web01.corp.example.", ("PrimaryName", "web01.corp.example.")),
        ContractRecord("corp.example", "SOA", 3600, 0, "corp.example IN SOA dc01.corp.example. hostmaster.corp.example. 2026111001 900 600 86400 3600",
            ("PrimaryServer", "dc01.corp.example."), ("ResponsibleParty", "hostmaster.corp.example."), ("SerialNumber", 2026111001), ("RefreshInterval", 900), ("RetryDelay", 600), ("ExpireLimit", 86400), ("MinimumTTL", 3600)),
        ContractRecord("corp.example", "NS", 3600, 0, "corp.example IN NS dc01.corp.example.", ("NSHost", "dc01.corp.example.")),
        ContractRecord("corp.example", "NS", 3600, 0, "corp.example IN NS dc02.corp.example.", ("NSHost", "dc02.corp.example.")),
        ContractRecord("corp.example", "A", 600, 3_710_000, "corp.example IN A 10.0.0.10", ("IPAddress", "10.0.0.10")),
        ContractRecord("corp.example", "MX", 3600, 0, "corp.example IN MX 10 mail.corp.example.", ("Preference", 10), ("MailExchange", "mail.corp.example.")),
        ContractRecord("corp.example", "TXT", 3600, 0, "corp.example IN TXT \"v=spf1 mx -all\" \"verification=4f1c\"", ("DescriptiveText", "\"v=spf1 mx -all\" \"verification=4f1c\"")),
        ContractRecord("DC01.corp.example", "A", 1200, 3_710_123, "dc01.corp.example IN A 10.0.0.10", ("IPAddress", "10.0.0.10")),
        ContractRecord("dc01.corp.example", "AAAA", 1200, 0, "dc01.corp.example IN AAAA 2001:db8::10", ("IPv6Address", "2001:0DB8:0000:0000:0000:0000:0000:0010")),
        ContractRecord("_ldap._tcp.corp.example", "SRV", 600, 3_710_123, "_ldap._tcp.corp.example IN SRV 0 100 389 dc01.corp.example.", ("Priority", 0), ("Weight", 100), ("Port", 389), ("DomainName", "dc01.corp.example.")),
        ContractRecord("_kerberos._udp.corp.example", "SRV", 600, 3_710_123, "_kerberos._udp.corp.example IN SRV 0 100 88 dc01.corp.example.", ("Priority", 0), ("Weight", 100), ("Port", 88), ("DomainName", "dc01.corp.example.")),
        ContractRecord("printer.corp.example", "PTR", 3600, 0, "printer.corp.example IN PTR printer01.corp.example.", ("PTRDomainName", "printer01.corp.example.")),
        ContractRecord("legacy.corp.example", "HINFO", 3600, 0, "legacy.corp.example IN HINFO \"x86\" \"Windows\""),
        ContractRecord("mail.corp.example", "A", 3600, 0, "mail.corp.example IN A 10.0.0.25", ("IPAddress", "10.0.0.25")),
    ];

    /// <summary>
    /// The three reads through the plugin's protocol session, the agent's ReadResult and the
    /// shared upload envelope (agent 4.21.2), compared with the contract JSON. Before 4.21.2 the
    /// envelope threw "The node already has a parent" on the data of ReadResult.
    /// </summary>
    private static async Task ContractAsync()
    {
        Program.Outcome Read(string operation, JsonObject parameters) => operation == "dns-read" ? Program.ServerRead(ContractServerRaw(), ContractTime)
            : PluginProtocol.Text(parameters, "zone") == "corp.example" ? Program.ZoneRecordsRead("corp.example", ContractRecordsRaw(), ContractTime) : Program.ZoneRecordsRead(PluginProtocol.Text(parameters, "zone"), [], ContractTime);
        async Task<JsonObject> Upload(string operation, JsonObject parameters, string expected, string name)
        {
            var input = new Pipe(); var output = new Pipe(); string id = Guid.NewGuid().ToString(), job = Guid.NewGuid().ToString();
            await PluginProtocol.WriteLineAsync(input, PluginProtocol.BrokerHello("4.21.2"), PluginProtocol.MaximumBrokerLine, CancellationToken.None);
            await PluginProtocol.WriteLineAsync(input, PluginProtocol.Request(id, operation, parameters), PluginProtocol.MaximumBrokerLine, CancellationToken.None);
            input.Complete();
            Check(await Program.HostAsync(input, output, Read, CancellationToken.None) == 0, "The " + name + " session did not end with 0.");
            output.Complete();
            var reader = new PluginLineReader(output);
            PluginProtocol.ReadPluginHello(PluginProtocol.Parse((await reader.ReadLineAsync(PluginProtocol.MaximumPluginLine, CancellationToken.None))!, "hello"));
            var result = PluginProtocol.ReadResult(PluginProtocol.Parse((await reader.ReadLineAsync(PluginProtocol.MaximumPluginLine, CancellationToken.None))!, "result"), id);
            Check(result.Ok && result.Data is not null && result.Data.Parent is null, "The " + name + " result has no data or data with a parent.");
            var envelope = PluginProtocol.UploadMessage(new PluginUpload(Program.Name, operation, job, DnsSnapshot.Iso(ContractTime), result.Data!));
            var sent = JsonNode.Parse(envelope.ToJsonString())!.AsObject();
            Check(sent["kind"]?.GetValue<string>() == "plugin-data-upload" && sent["jobId"]?.GetValue<string>() == job && sent["plugin"]?.GetValue<string>() == "dns" && sent["operation"]?.GetValue<string>() == operation, "The " + name + " envelope is wrong.");
            string actual = sent["data"]!.ToJsonString();
            Check(actual == JsonNode.Parse(expected)!.ToJsonString(), "The " + name + " data differ from dns-contract:" + name + ": " + actual);
            return result.Data!;
        }
        var server = await Upload("dns-read", new JsonObject(), ContractServer, "server");
        Check(server["zones"]!.AsArray().Count == 12 && server["zones"]!.AsArray().All(zone => zone!["name"]!.GetValue<string>() is not ("" or ".")), "The server read did not keep 12 zones without the cache zone.");
        var records = await Upload("dns-zone-read", new JsonObject { ["zone"] = "corp.example" }, ContractRecords, "records");
        Check(records["records"]!.AsArray().Select(record => record!["type"]!.GetValue<string>()).Distinct().Count() == 10, "The zone read did not keep records of 10 types.");
        var empty = await Upload("dns-zone-read", new JsonObject { ["zone"] = "partner.example" }, ContractEmpty, "empty");
        Check(empty["total"]!.GetValue<int>() == 0, "The empty zone read is not empty.");
    }

    // The JSON documents of the contract; tests/agent/dns-plugin-contract.mjs reads them between the markers and parses them with lib/dns.ts.
    // dns-contract:server:start
    private const string ContractServer = """
        {
          "kind": "server",
          "collectedAt": "2026-11-10T09:00:00Z",
          "service": "running",
          "server": {
            "name": "DC01.corp.example",
            "domain": "corp.example",
            "version": "10.0.20348",
            "isDomainController": true,
            "listenAddresses": [
              "10.0.0.10",
              "2001:db8::10"
            ]
          },
          "forwarders": {
            "servers": [
              "192.0.2.53",
              "2001:db8::53"
            ],
            "timeoutSeconds": 3,
            "useRootHints": true
          },
          "scavenging": {
            "enabled": true,
            "intervalHours": 168,
            "lastRunAt": "2026-11-09T03:00:00Z",
            "defaultAging": {
              "enabled": true,
              "noRefreshHours": 168,
              "refreshHours": 168
            }
          },
          "zones": [
            {
              "name": "0.in-addr.arpa",
              "kind": "primary",
              "lookup": "reverse",
              "storage": "file",
              "replicationScope": null,
              "partition": null,
              "fileName": null,
              "dynamicUpdate": "none",
              "transfers": {
                "mode": "none",
                "servers": []
              },
              "notify": {
                "mode": "off",
                "servers": []
              },
              "masters": [],
              "aging": {
                "enabled": false,
                "noRefreshHours": 0,
                "refreshHours": 0
              },
              "forwarderTimeoutSeconds": null,
              "paused": false,
              "autoCreated": true,
              "serial": null,
              "recordCount": null
            },
            {
              "name": "1.0.10.in-addr.arpa",
              "kind": "primary",
              "lookup": "reverse",
              "storage": "ad",
              "replicationScope": "domain",
              "partition": null,
              "fileName": null,
              "dynamicUpdate": "secure",
              "transfers": {
                "mode": "nameServers",
                "servers": []
              },
              "notify": {
                "mode": "nameServers",
                "servers": []
              },
              "masters": [],
              "aging": {
                "enabled": false,
                "noRefreshHours": 0,
                "refreshHours": 0
              },
              "forwarderTimeoutSeconds": null,
              "paused": false,
              "autoCreated": false,
              "serial": null,
              "recordCount": 12
            },
            {
              "name": "127.in-addr.arpa",
              "kind": "primary",
              "lookup": "reverse",
              "storage": "file",
              "replicationScope": null,
              "partition": null,
              "fileName": null,
              "dynamicUpdate": "none",
              "transfers": {
                "mode": "none",
                "servers": []
              },
              "notify": {
                "mode": "off",
                "servers": []
              },
              "masters": [],
              "aging": {
                "enabled": false,
                "noRefreshHours": 0,
                "refreshHours": 0
              },
              "forwarderTimeoutSeconds": null,
              "paused": false,
              "autoCreated": true,
              "serial": null,
              "recordCount": null
            },
            {
              "name": "255.in-addr.arpa",
              "kind": "primary",
              "lookup": "reverse",
              "storage": "file",
              "replicationScope": null,
              "partition": null,
              "fileName": null,
              "dynamicUpdate": "none",
              "transfers": {
                "mode": "none",
                "servers": []
              },
              "notify": {
                "mode": "off",
                "servers": []
              },
              "masters": [],
              "aging": {
                "enabled": false,
                "noRefreshHours": 0,
                "refreshHours": 0
              },
              "forwarderTimeoutSeconds": null,
              "paused": false,
              "autoCreated": true,
              "serial": null,
              "recordCount": null
            },
            {
              "name": "8.b.d.0.1.0.0.2.ip6.arpa",
              "kind": "primary",
              "lookup": "reverse",
              "storage": "ad",
              "replicationScope": "forest",
              "partition": null,
              "fileName": null,
              "dynamicUpdate": "secure",
              "transfers": {
                "mode": "nameServers",
                "servers": []
              },
              "notify": {
                "mode": "nameServers",
                "servers": []
              },
              "masters": [],
              "aging": {
                "enabled": false,
                "noRefreshHours": 0,
                "refreshHours": 0
              },
              "forwarderTimeoutSeconds": null,
              "paused": false,
              "autoCreated": false,
              "serial": null,
              "recordCount": 3
            },
            {
              "name": "_msdcs.corp.example",
              "kind": "primary",
              "lookup": "forward",
              "storage": "ad",
              "replicationScope": "forest",
              "partition": null,
              "fileName": null,
              "dynamicUpdate": "secure",
              "transfers": {
                "mode": "nameServers",
                "servers": []
              },
              "notify": {
                "mode": "nameServers",
                "servers": []
              },
              "masters": [],
              "aging": {
                "enabled": false,
                "noRefreshHours": 0,
                "refreshHours": 0
              },
              "forwarderTimeoutSeconds": null,
              "paused": false,
              "autoCreated": false,
              "serial": null,
              "recordCount": 18
            },
            {
              "name": "branch.example",
              "kind": "primary",
              "lookup": "forward",
              "storage": "file",
              "replicationScope": null,
              "partition": null,
              "fileName": "branch.example.dns",
              "dynamicUpdate": "none",
              "transfers": {
                "mode": "list",
                "servers": [
                  "10.0.1.10"
                ]
              },
              "notify": {
                "mode": "list",
                "servers": [
                  "10.0.1.10"
                ]
              },
              "masters": [],
              "aging": {
                "enabled": false,
                "noRefreshHours": 0,
                "refreshHours": 0
              },
              "forwarderTimeoutSeconds": null,
              "paused": false,
              "autoCreated": false,
              "serial": null,
              "recordCount": 7
            },
            {
              "name": "contoso.example",
              "kind": "forwarder",
              "lookup": "forward",
              "storage": "file",
              "replicationScope": null,
              "partition": null,
              "fileName": null,
              "dynamicUpdate": "none",
              "transfers": {
                "mode": "none",
                "servers": []
              },
              "notify": {
                "mode": "off",
                "servers": []
              },
              "masters": [
                "192.0.2.30",
                "192.0.2.31"
              ],
              "aging": null,
              "forwarderTimeoutSeconds": 5,
              "paused": false,
              "autoCreated": false,
              "serial": null,
              "recordCount": null
            },
            {
              "name": "corp.example",
              "kind": "primary",
              "lookup": "forward",
              "storage": "ad",
              "replicationScope": "domain",
              "partition": null,
              "fileName": null,
              "dynamicUpdate": "secure",
              "transfers": {
                "mode": "nameServers",
                "servers": []
              },
              "notify": {
                "mode": "nameServers",
                "servers": []
              },
              "masters": [],
              "aging": {
                "enabled": true,
                "noRefreshHours": 168,
                "refreshHours": 168
              },
              "forwarderTimeoutSeconds": null,
              "paused": false,
              "autoCreated": false,
              "serial": null,
              "recordCount": 42
            },
            {
              "name": "partner.example",
              "kind": "secondary",
              "lookup": "forward",
              "storage": "file",
              "replicationScope": null,
              "partition": null,
              "fileName": "partner.example.dns",
              "dynamicUpdate": "none",
              "transfers": {
                "mode": "none",
                "servers": []
              },
              "notify": {
                "mode": "off",
                "servers": []
              },
              "masters": [
                "192.0.2.10"
              ],
              "aging": null,
              "forwarderTimeoutSeconds": null,
              "paused": false,
              "autoCreated": false,
              "serial": null,
              "recordCount": null
            },
            {
              "name": "stub.example",
              "kind": "stub",
              "lookup": "forward",
              "storage": "ad",
              "replicationScope": "legacy",
              "partition": null,
              "fileName": null,
              "dynamicUpdate": "none",
              "transfers": {
                "mode": "none",
                "servers": []
              },
              "notify": {
                "mode": "off",
                "servers": []
              },
              "masters": [
                "192.0.2.20"
              ],
              "aging": null,
              "forwarderTimeoutSeconds": null,
              "paused": false,
              "autoCreated": false,
              "serial": null,
              "recordCount": null
            },
            {
              "name": "trustanchors",
              "kind": "primary",
              "lookup": "forward",
              "storage": "ad",
              "replicationScope": "forest",
              "partition": null,
              "fileName": null,
              "dynamicUpdate": "none",
              "transfers": {
                "mode": "none",
                "servers": []
              },
              "notify": {
                "mode": "off",
                "servers": []
              },
              "masters": [],
              "aging": {
                "enabled": false,
                "noRefreshHours": 0,
                "refreshHours": 0
              },
              "forwarderTimeoutSeconds": null,
              "paused": false,
              "autoCreated": false,
              "serial": null,
              "recordCount": 1
            }
          ],
          "truncated": {
            "zones": false
          }
        }
        """;
    // dns-contract:server:end
    // dns-contract:records:start
    private const string ContractRecords = """
        {
          "kind": "zone",
          "zone": "corp.example",
          "collectedAt": "2026-11-10T09:00:00Z",
          "records": [
            {
              "name": "@",
              "type": "A",
              "ttlSeconds": 600,
              "timestamp": "2024-03-27T08:00:00Z",
              "data": {
                "address": "10.0.0.10"
              },
              "text": "corp.example IN A 10.0.0.10"
            },
            {
              "name": "@",
              "type": "MX",
              "ttlSeconds": 3600,
              "timestamp": null,
              "data": {
                "preference": 10,
                "exchange": "mail.corp.example"
              },
              "text": "corp.example IN MX 10 mail.corp.example."
            },
            {
              "name": "@",
              "type": "NS",
              "ttlSeconds": 3600,
              "timestamp": null,
              "data": {
                "nameServer": "dc01.corp.example"
              },
              "text": "corp.example IN NS dc01.corp.example."
            },
            {
              "name": "@",
              "type": "NS",
              "ttlSeconds": 3600,
              "timestamp": null,
              "data": {
                "nameServer": "dc02.corp.example"
              },
              "text": "corp.example IN NS dc02.corp.example."
            },
            {
              "name": "@",
              "type": "SOA",
              "ttlSeconds": 3600,
              "timestamp": null,
              "data": {
                "primaryServer": "dc01.corp.example",
                "responsiblePerson": "hostmaster.corp.example",
                "serial": 2026111001,
                "refreshSeconds": 900,
                "retrySeconds": 600,
                "expireSeconds": 86400,
                "minimumTtlSeconds": 3600
              },
              "text": "corp.example IN SOA dc01.corp.example. hostmaster.corp.example. 2026111001 900 600 86400 3600"
            },
            {
              "name": "@",
              "type": "TXT",
              "ttlSeconds": 3600,
              "timestamp": null,
              "data": {
                "strings": [
                  "v=spf1 mx -all",
                  "verification=4f1c"
                ]
              },
              "text": "corp.example IN TXT \"v=spf1 mx -all\" \"verification=4f1c\""
            },
            {
              "name": "_kerberos._udp",
              "type": "SRV",
              "ttlSeconds": 600,
              "timestamp": "2024-04-01T11:00:00Z",
              "data": {
                "priority": 0,
                "weight": 100,
                "port": 88,
                "target": "dc01.corp.example"
              },
              "text": "_kerberos._udp.corp.example IN SRV 0 100 88 dc01.corp.example."
            },
            {
              "name": "_ldap._tcp",
              "type": "SRV",
              "ttlSeconds": 600,
              "timestamp": "2024-04-01T11:00:00Z",
              "data": {
                "priority": 0,
                "weight": 100,
                "port": 389,
                "target": "dc01.corp.example"
              },
              "text": "_ldap._tcp.corp.example IN SRV 0 100 389 dc01.corp.example."
            },
            {
              "name": "dc01",
              "type": "A",
              "ttlSeconds": 1200,
              "timestamp": "2024-04-01T11:00:00Z",
              "data": {
                "address": "10.0.0.10"
              },
              "text": "dc01.corp.example IN A 10.0.0.10"
            },
            {
              "name": "dc01",
              "type": "AAAA",
              "ttlSeconds": 1200,
              "timestamp": null,
              "data": {
                "address": "2001:db8::10"
              },
              "text": "dc01.corp.example IN AAAA 2001:db8::10"
            },
            {
              "name": "legacy",
              "type": "HINFO",
              "ttlSeconds": 3600,
              "timestamp": null,
              "data": {},
              "text": "legacy.corp.example IN HINFO \"x86\" \"Windows\""
            },
            {
              "name": "mail",
              "type": "A",
              "ttlSeconds": 3600,
              "timestamp": null,
              "data": {
                "address": "10.0.0.25"
              },
              "text": "mail.corp.example IN A 10.0.0.25"
            },
            {
              "name": "printer",
              "type": "PTR",
              "ttlSeconds": 3600,
              "timestamp": null,
              "data": {
                "host": "printer01.corp.example"
              },
              "text": "printer.corp.example IN PTR printer01.corp.example."
            },
            {
              "name": "www",
              "type": "CNAME",
              "ttlSeconds": 3600,
              "timestamp": null,
              "data": {
                "target": "web01.corp.example"
              },
              "text": "www.corp.example IN CNAME web01.corp.example."
            }
          ],
          "total": 14,
          "truncated": false
        }
        """;
    // dns-contract:records:end
    // dns-contract:empty:start
    private const string ContractEmpty = """
        {
          "kind": "zone",
          "zone": "partner.example",
          "collectedAt": "2026-11-10T09:00:00Z",
          "records": [],
          "total": 0,
          "truncated": false
        }
        """;
    // dns-contract:empty:end
}
