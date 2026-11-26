using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using ServerDesk.Plugins;

namespace ServerDesk.Plugin.Dhcp;

// --self-test of the DHCP plugin, portable: the x64 struct layout of the DHCP
// API, the mapping from the API values to the snapshot, the order of the cut
// and the 2 MiB cap with a large synthetic server, the protocol framing and the
// dispatch, and the changes of 1.1.0 (DhcpChangeTests below): the parameters of
// every operation, the option values per type, the scope-apply merge on an
// in-memory server and the secret. Only the Windows Server acceptance run
// proves the real API calls.
internal static class DhcpSelfTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }

    internal static async Task<int> RunAsync()
    {
        try
        {
            Layout(); Mapping(); Cut(); await ProtocolAsync(); DhcpChangeTests.Run();
            Console.WriteLine("DHCP plugin self-test passed.");
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine("DHCP plugin self-test failed: " + e.Message); return 1; }
    }

    private static void Layout()
    {
        Check(IntPtr.Size == 8, "The DHCP plugin is x64 only.");
        foreach (var (name, (actual, expected)) in DhcpApi.Layout().Concat(DhcpWriter.Layout())) Check(actual == expected, name + " is " + actual + " bytes or offset, not " + expected + ".");
    }

    private static uint Ip(string text) => text.Split('.').Select(uint.Parse).Aggregate(0u, (value, part) => value << 8 | part);
    private static RawScopeV4 Scope(string subnet, int state = 0, int range = 5, uint? lease = 691200, uint inUse = 62, uint free = 38, int reservations = 0, string name = "Office") =>
        new(Ip(subnet), Ip("255.255.255.0"), name, "Comment", state, range, Ip(subnet) + 10, Ip(subnet) + 109, lease, inUse, free, [(Ip(subnet) + 50, Ip(subnet) + 59)],
            Enumerable.Range(0, reservations).Select(i => new RawReservationV4(Ip(subnet) + 20 + (uint)(i % 30), [0x00, 0x15, 0x5d, 0x01, 0x02, (byte)i], 1)).ToList(), [new RawOption(3, "Router", [subnet[..^1] + "1"])], []);
    private static RawDhcp Server(IReadOnlyList<RawScopeV4> scopes, IReadOnlyList<RawClientV4>? clients = null, long? total = null) =>
        new("dc01.corp.example", "corp.example", "authorized", scopes, [(scopes[0].Subnet, "Campus")], [new RawOption(6, "DNS Servers", ["10.10.0.10", "10.10.0.11"])], [], [], [], [], clients ?? [], [], total ?? clients?.Count ?? 0);

    private static void Mapping()
    {
        Check(DhcpSnapshot.ScopeState(0) == "active" && DhcpSnapshot.ScopeState(2) == "active" && DhcpSnapshot.ScopeState(1) == "inactive" && DhcpSnapshot.ScopeState(3) == "inactive", "Scope states map wrongly.");
        Check(DhcpSnapshot.ScopeType(5) == "dhcp" && DhcpSnapshot.ScopeType(6) == "both" && DhcpSnapshot.ScopeType(7) == "bootp" && DhcpSnapshot.ScopeType(0) == "dhcp", "Scope types map wrongly.");
        Check(DhcpSnapshot.LeaseDuration(0xFFFFFFFF) is null && DhcpSnapshot.LeaseDuration(null) is null && DhcpSnapshot.LeaseDuration(691200) == 691200, "An unlimited lease duration is not null.");
        Check(DhcpSnapshot.Percent(0, 0) == 0 && DhcpSnapshot.Percent(62, 100) == 62 && DhcpSnapshot.Percent(1, 3) == 33.3, "The usage percent is wrong.");
        Check(DhcpSnapshot.Ipv4(Ip("10.10.0.0")) == "10.10.0.0" && DhcpSnapshot.Ipv6(DhcpSnapshot.Ipv6Bytes(0x20010db800010000, 0)) == "2001:db8:1::", "Addresses format wrongly.");
        Check(DhcpSnapshot.ClientId([0x00, 0x00, 0x0a, 0x0a, 0x01, 0x00, 0x15, 0x5d, 0x0a, 0x0b, 0x0c], Ip("10.10.0.0")) == "00-15-5d-0a-0b-0c" && DhcpSnapshot.ClientId([0x00, 0x15, 0x5d, 0x0a, 0x0b, 0x0c], Ip("10.10.0.0")) == "00-15-5d-0a-0b-0c", "Client IDs format wrongly.");
        Check(DhcpSnapshot.Expiry(0) is null && DhcpSnapshot.Expiry(long.MaxValue) is null && DhcpSnapshot.Expiry(new DateTime(2026, 11, 4, 12, 0, 0, DateTimeKind.Utc).ToFileTimeUtc()) == "2026-11-04T12:00:00Z", "Lease expiries map wrongly.");
        var now = new DateTimeOffset(2026, 11, 4, 12, 0, 0, TimeSpan.Zero);
        var clients = new List<RawClientV4>
        {
            new(Ip("10.10.0.11"), Ip("10.10.0.0"), [0x00, 0x15, 0x5d, 0x01, 0x02, 0x03], "pc-1", null, now.AddDays(3).UtcDateTime.ToFileTimeUtc(), 1),
            new(Ip("10.10.0.12"), Ip("10.10.0.0"), [0x00, 0x15, 0x5d, 0x01, 0x02, 0x04], null, null, now.AddDays(-1).UtcDateTime.ToFileTimeUtc(), 1),
            new(Ip("10.10.0.20"), Ip("10.10.0.0"), [0x00, 0x15, 0x5d, 0x01, 0x02, 0x00], "printer", "Floor 2", 0, 1),
        };
        var built = DhcpSnapshot.Build(Server([Scope("10.10.0.0", reservations: 1), Scope("10.30.0.0", state: 1, lease: 0xFFFFFFFF, inUse: 0, free: 0, name: "Lab")], clients), now);
        var first = built["ipv4"]!["scopes"]![0]!; var lab = built["ipv4"]!["scopes"]![1]!;
        Check(built["service"]!.GetValue<string>() == "running" && built["schema"]!.GetValue<int>() == 1 && built["server"]!["authorization"]!.GetValue<string>() == "authorized", "The server facts are wrong.");
        Check(first["usage"]!["percent"]!.GetValue<double>() == 62 && first["usage"]!["total"]!.GetValue<uint>() == 100 && first["usage"]!["reserved"]!.GetValue<uint>() == 1 && first["superscope"]!.GetValue<string>() == "Campus" && first["leaseDurationSeconds"]!.GetValue<uint>() == 691200, "The first scope maps wrongly.");
        Check(lab["state"]!.GetValue<string>() == "inactive" && lab["leaseDurationSeconds"] is null && lab["usage"]!["percent"]!.GetValue<double>() == 0 && lab["superscope"] is null, "The inactive scope with an unlimited lease maps wrongly.");
        Check(first["reservations"]![0]!["name"]!.GetValue<string>() == "printer" && first["reservations"]![0]!["description"]!.GetValue<string>() == "Floor 2", "A reservation did not take the name of its client record.");
        var leases = built["leases"]!["items"]!.AsArray();
        Check(leases[0]!["state"]!.GetValue<string>() == "reserved" && leases[0]!["expiresAt"] is null && leases[1]!["name"]!.GetValue<string>() == "pc-1" && leases[2]!["state"]!.GetValue<string>() == "expired", "The leases are not in expiry order or map their state wrongly.");
        var policy = DhcpSnapshot.Policy(new RawPolicy("Phones", Ip("10.10.0.0"), 1, true, "IP phones", [new RawCondition(0, 0, 0, 0, 2, [0x00, 0x15, 0x5d]), new RawCondition(0, 1, 60, 0, 0, Encoding.ASCII.GetBytes("MSFT 5.0"))], 1, [(Ip("10.10.0.200"), Ip("10.10.0.220"))]), "10.10.0.0");
        Check(policy["condition"]!.GetValue<string>() == "and" && policy["criteria"]![0]!["type"]!.GetValue<string>() == "mac" && policy["criteria"]![0]!["values"]![0]!.GetValue<string>() == "00-15-5D*" && policy["criteria"]![1]!["values"]![0]!.GetValue<string>() == "MSFT 5.0", "A policy maps wrongly.");
        var stopped = DhcpSnapshot.Stopped("dc01", null, "unknown");
        Check(stopped["service"]!.GetValue<string>() == "stopped" && stopped["ipv4"]!["scopes"]!.AsArray().Count == 0 && stopped["leases"]!["total"]!.GetValue<int>() == 0, "A stopped service is not an empty snapshot.");
    }

    private static void Cut()
    {
        var now = new DateTimeOffset(2026, 11, 4, 12, 0, 0, TimeSpan.Zero);
        var clients = Enumerable.Range(0, 12_000).Select(i => new RawClientV4((uint)(0x0A0A0000 + i), 0x0A0A0000, [0x00, 0x15, 0x5d, (byte)(i >> 16), (byte)(i >> 8), (byte)i], "client-" + i + "-" + new string('n', 120), "comment", now.AddMinutes(i).UtcDateTime.ToFileTimeUtc(), 1)).ToList();
        var built = DhcpSnapshot.Build(Server([Scope("10.10.0.0", reservations: 10)], clients), now);
        Check(built["leases"]!["items"]!.AsArray().Count == DhcpSnapshot.MaximumLeases && built["leases"]!["truncated"]!.GetValue<bool>() && built["leases"]!["total"]!.GetValue<uint>() == 12_000, "The lease list is not cut at 10,000.");
        Check(built["leases"]!["items"]![0]!["name"]!.GetValue<string>().StartsWith("client-11999-", StringComparison.Ordinal), "The latest expiry is not first.");
        var fitted = DhcpSnapshot.Fit(built);
        int size = DhcpSnapshot.Size(fitted), kept = fitted["leases"]!["items"]!.AsArray().Count;
        Check(size <= DhcpSnapshot.MaximumBytes && kept < DhcpSnapshot.MaximumLeases && kept > 1000 && fitted["truncated"]!["leases"]!.GetValue<bool>() && !fitted["truncated"]!["reservations"]!.GetValue<bool>(), "The leases were not cut first to fit 2 MiB.");
        Check(fitted["leases"]!["items"]![kept - 1]!["name"]!.GetValue<string>().StartsWith("client-" + (11999 - kept + 1) + "-", StringComparison.Ordinal), "The cut did not keep the newest expiries.");
        // A server whose reservations alone exceed 2 MiB: no lease stays, then the reservations are cut.
        var scopes = Enumerable.Range(0, 200).Select(i => Scope("10." + (i / 250) + "." + (i % 250) + ".0", reservations: 2000)).ToList();
        var huge = DhcpSnapshot.Fit(DhcpSnapshot.Build(Server(scopes, clients.Take(100).ToList()), now));
        Check(DhcpSnapshot.Size(huge) <= DhcpSnapshot.MaximumBytes && huge["leases"]!["items"]!.AsArray().Count == 0 && huge["truncated"]!["reservations"]!.GetValue<bool>() && huge["ipv4"]!["scopes"]![0]!["reservations"]!.AsArray().Count > 0, "The reservations were not cut after the leases.");
    }

    // An in-memory stream pair for the protocol test.
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
        Program.Outcome Fake(string operation, JsonObject parameters) { calls.Add(operation); return operation == "dhcp-read" ? new(true, "PLUGIN_DHCP_READ_COMPLETED", new Dictionary<string, string> { ["scopes"] = "3", ["leases"] = "20" }, DhcpSnapshot.Stopped("dc01", null, "unknown")) : new(true, "PLUGIN_DHCP_CHANGED", new Dictionary<string, string>(), null); }
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
        var (code, lines) = await Session(PluginProtocol.BrokerHello("4.16.0"), PluginProtocol.Request(id, "dhcp-read", new JsonObject()));
        Check(code == 0 && lines.Count == 2, "A full session did not answer hello and result.");
        var hello = PluginProtocol.ReadPluginHello(lines[0]);
        Check(hello.Name == "dhcp" && hello.Version == Program.Version && hello.Capabilities.SequenceEqual(Program.Capabilities), "The plugin hello is wrong.");
        var result = PluginProtocol.ReadResult(lines[1], id);
        Check(result.Ok && result.Code == "PLUGIN_DHCP_READ_COMPLETED" && result.Message == "The DHCP server was read: 3 scopes, 20 leases." && result.Data?["schema"]?.GetValue<int>() == 1, "The plugin result is wrong.");
        var handshake = await Session(PluginProtocol.BrokerHello("4.16.0"));
        Check(handshake.Code == 0 && handshake.Lines.Count == 1, "The install handshake did not end with exit code 0 after the hello.");
        var wrongProtocol = await Session(new JsonObject { ["type"] = "hello", ["protocol"] = 2, ["agentVersion"] = "4.16.0" });
        Check(wrongProtocol.Code == 3 && wrongProtocol.Lines.Count == 0, "A broker of another protocol got an answer.");
        var unknown = await Session(PluginProtocol.BrokerHello("4.16.0"), PluginProtocol.Request(id, "dhcp-write", new JsonObject()));
        Check(unknown.Code == 3 && unknown.Lines.Count == 1, "An unknown operation got a result.");
        // Every capability dispatches: a change reaches the change path with its parameters.
        calls.Clear();
        var change = await Session(PluginProtocol.BrokerHello("4.16.0"), PluginProtocol.Request(id, "dhcp-scope-delete", new JsonObject { ["family"] = "ipv4", ["scopeId"] = "10.40.0.0" }));
        Check(change.Code == 0 && calls.SequenceEqual(["dhcp-scope-delete"]) && PluginProtocol.ReadResult(change.Lines[1], id).Code == "PLUGIN_DHCP_CHANGED", "A change operation was not dispatched.");
        Check(Program.Capabilities.Length == 26 && Program.Capabilities.Distinct().Count() == 26 && Program.Capabilities.All(PluginProtocol.IsCapability), "The plugin does not report 26 capabilities.");
        Check(Program.Messages.Keys.All(PluginProtocol.IsCode), "A plugin code is not a PLUGIN_ code.");
    }
}

// The changes of DHCP plugin 1.1.0, without a DHCP server.
internal static class DhcpChangeTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    private static JsonObject Json(string text) => (JsonObject)JsonNode.Parse(text)!;
    private static string? Refused(string operation, JsonObject parameters) { try { DhcpChanges.Validate(operation, parameters); return null; } catch (InvalidChangeException e) { return e.Field; } }

    internal static void Run() { Parameters(); Options(); Apply(); Secret(); }

    // One good parameter set per operation, then a broken one with the field it names.
    private static readonly (string Operation, string Good, string Bad, string Field)[] Samples =
    [
        ("dhcp-scope-create", """{"family":"ipv4","name":"Lab","description":"","startRange":"10.40.0.10","endRange":"10.40.0.200","subnetMask":"255.255.255.0","leaseDurationSeconds":86400,"type":"dhcp","activate":true}""", """{"family":"ipv4","name":"Lab","description":"","startRange":"10.40.0.10","endRange":"10.41.0.200","subnetMask":"255.255.255.0","leaseDurationSeconds":86400,"type":"dhcp","activate":true}""", "endRange"),
        ("dhcp-scope-create", """{"family":"ipv6","prefix":"2001:db8:1::","name":"Lab6","description":"","preference":0,"activate":false}""", """{"family":"ipv6","prefix":"2001:db8:1::5","name":"Lab6","description":"","preference":0,"activate":false}""", "prefix"),
        ("dhcp-scope-edit", """{"family":"ipv4","scopeId":"10.10.0.0","name":"Office","description":"x","startRange":"10.10.0.10","endRange":"10.10.0.220","leaseDurationSeconds":null,"type":"both"}""", """{"family":"ipv4","scopeId":"10.10.0.0","name":"Office","description":"x","startRange":"10.10.0.10","endRange":"10.10.0.220","leaseDurationSeconds":30,"type":"both"}""", "leaseDurationSeconds"),
        ("dhcp-scope-activate", """{"family":"ipv4","scopeId":"10.30.0.0"}""", """{"family":"ipv4","scopeId":"10.30.0.300"}""", "scopeId"),
        ("dhcp-scope-deactivate", """{"family":"ipv6","prefix":"2001:db8:10::"}""", """{"family":"ipv6","prefix":"2001:db8:10::","extra":1}""", "extra"),
        ("dhcp-scope-delete", """{"family":"ipv4","scopeId":"10.30.0.0"}""", """{"family":"ipv5","scopeId":"10.30.0.0"}""", "family"),
        ("dhcp-superscope-create", """{"name":"Campus 2","scopeIds":["10.30.0.0"]}""", """{"name":"Campus 2","scopeIds":[]}""", "scopeIds"),
        ("dhcp-superscope-edit", """{"name":"Campus","newName":"Main","scopeIds":["10.10.0.0","10.20.0.0"]}""", """{"name":"Campus","newName":" ","scopeIds":["10.10.0.0"]}""", "newName"),
        ("dhcp-superscope-activate", """{"name":"Campus"}""", """{"name":""}""", "name"),
        ("dhcp-superscope-deactivate", """{"name":"Campus"}""", """{}""", "name"),
        ("dhcp-superscope-delete", """{"name":"Campus"}""", """{"name":"Cam\u0001pus"}""", "name"),
        ("dhcp-exclusion-add", """{"family":"ipv4","scopeId":"10.10.0.0","start":"10.10.0.30","end":"10.10.0.39"}""", """{"family":"ipv4","scopeId":"10.10.0.0","start":"10.10.0.39","end":"10.10.0.30"}""", "end"),
        ("dhcp-exclusion-remove", """{"family":"ipv6","prefix":"2001:db8:10::","start":"2001:db8:10::10","end":"2001:db8:10::20"}""", """{"family":"ipv6","prefix":"2001:db8:10::","start":"2001:db8:10::10","end":"2001:db8:10::1"}""", "end"),
        ("dhcp-reservation-add", """{"family":"ipv4","scopeId":"10.10.0.0","address":"10.10.0.50","clientId":"00-15-5D-01-02-03","name":"pc","description":"","type":"dhcp"}""", """{"family":"ipv4","scopeId":"10.10.0.0","address":"10.10.0.50","clientId":"00-15-5D-01-02-0","name":"pc","description":"","type":"dhcp"}""", "clientId"),
        ("dhcp-reservation-add", """{"family":"ipv6","prefix":"2001:db8:10::","address":"2001:db8:10::50","duid":"00-01-00-01-2A-3B-4C-5D","iaid":7}""", """{"family":"ipv6","prefix":"2001:db8:10::","address":"2001:db8:10::50","duid":"zz","iaid":7}""", "duid"),
        ("dhcp-reservation-edit", """{"family":"ipv4","scopeId":"10.10.0.0","address":"10.10.0.20","newAddress":"10.10.0.22","clientId":"001b a94c 2210","name":"printer","description":"","type":"both"}""", """{"family":"ipv4","scopeId":"10.10.0.0","address":"10.10.0.20","clientId":"00-1b-a9-4c-22-10","name":"","description":"","type":"both"}""", "name"),
        ("dhcp-reservation-remove", """{"family":"ipv4","scopeId":"10.10.0.0","address":"10.10.0.20"}""", """{"family":"ipv4","scopeId":"10.10.0.0","address":"010.10.0.20"}""", "address"),
        ("dhcp-lease-delete", """{"family":"ipv4","scopeId":"10.20.0.0","addresses":["10.20.0.15","10.20.0.16"]}""", """{"family":"ipv4","scopeId":"10.20.0.0","addresses":["10.20.0.15","10.20.0.15"]}""", "addresses"),
        ("dhcp-option-set", """{"family":"ipv4","level":"scope","scopeId":"10.10.0.0","code":6,"vendorClass":null,"userClass":null,"values":["10.10.1.4","10.10.1.5"]}""", """{"family":"ipv6","level":"policy","policy":"P","code":6,"vendorClass":null,"userClass":null,"values":["x"]}""", "level"),
        ("dhcp-option-remove", """{"family":"ipv4","level":"policy","scopeId":null,"policy":"Printers","code":3,"vendorClass":null,"userClass":null}""", """{"family":"ipv4","level":"server","code":70000,"vendorClass":null,"userClass":null}""", "code"),
        ("dhcp-policy-create", """{"scopeId":"10.10.0.0","name":"Phones","description":"","enabled":true,"order":2,"condition":"or","criteria":[{"type":"mac","operator":"equals","values":["00-15-5D*"]}],"ranges":[{"start":"10.10.0.180","end":"10.10.0.199"}],"leaseDurationSeconds":null}""", """{"scopeId":null,"name":"Phones","description":"","enabled":true,"order":2,"condition":"or","criteria":[{"type":"mac","operator":"equals","values":["00-15-5D*"]}],"ranges":[{"start":"10.10.0.180","end":"10.10.0.199"}],"leaseDurationSeconds":null}""", "ranges"),
        ("dhcp-policy-edit", """{"scopeId":null,"name":"Printers","newName":"Printer","description":"","enabled":false,"order":1,"condition":"and","criteria":[{"type":"vendorClass","operator":"equals","values":["HP Printer"]}],"ranges":[],"leaseDurationSeconds":3600}""", """{"scopeId":null,"name":"Printers","description":"","enabled":false,"order":1,"condition":"and","criteria":[],"ranges":[],"leaseDurationSeconds":3600}""", "criteria"),
        ("dhcp-policy-delete", """{"scopeId":"10.10.0.0","name":"IP phones"}""", """{"name":"IP phones"}""", "scopeId"),
        ("dhcp-failover-create", """{"name":"DC01-DC03","partner":"SRV-DC03.corp.example","serverType":"primary","mode":"loadBalance","loadBalancePercent":60,"serverRole":"active","reservePercent":5,"mcltSeconds":3600,"autoStateTransition":false,"stateSwitchIntervalSeconds":null,"messageAuthentication":false,"scopeIds":["10.30.0.0"],"serverAddress":"10.10.1.4","partnerAddress":"10.10.1.6"}""", """{"name":"DC01-DC03","partner":"SRV-DC03.corp.example","serverType":"primary","mode":"loadBalance","loadBalancePercent":160,"serverRole":"active","reservePercent":5,"mcltSeconds":3600,"autoStateTransition":false,"stateSwitchIntervalSeconds":null,"messageAuthentication":false,"scopeIds":["10.30.0.0"],"serverAddress":"10.10.1.4","partnerAddress":"10.10.1.6"}""", "loadBalancePercent"),
        ("dhcp-failover-edit", """{"name":"DC01-DC02","loadBalancePercent":70,"addScopeIds":["10.30.0.0"],"removeScopeIds":[]}""", """{"name":"DC01-DC02","mcltSeconds":10}""", "mcltSeconds"),
        ("dhcp-failover-remove", """{"name":"DC01-DC02","deletePartnerScopes":true}""", """{"name":"DC01-DC02","deletePartnerScopes":"yes"}""", "deletePartnerScopes"),
        ("dhcp-scope-apply", """{"scopeId":"10.30.0.0","part":1,"parts":1,"settings":{"name":"Lab","description":"","startRange":"10.30.0.10","endRange":"10.30.0.59","subnetMask":"255.255.255.0","leaseDurationSeconds":null,"type":"both","state":"active","exclusions":[],"options":[{"code":3,"vendorClass":null,"userClass":null,"values":["10.30.0.1"]}],"policies":[]},"reservations":[],"keep":[]}""", """{"scopeId":"10.30.0.0","part":2,"parts":1,"reservations":[]}""", "part"),
    ];

    private static void Parameters()
    {
        foreach (string operation in DhcpChanges.Operations) Check(Samples.Any(sample => sample.Operation == operation), operation + " has no parameter sample.");
        foreach (var (operation, good, bad, field) in Samples)
        {
            Check(Refused(operation, Json(good)) is null, operation + " refused good parameters: " + Refused(operation, Json(good)));
            Check(Refused(operation, Json(bad)) == field, operation + " did not refuse " + field + " (got " + Refused(operation, Json(bad)) + ").");
        }
        Check(Refused("dhcp-unknown", new JsonObject()) == "operation", "An unknown operation passed the validation.");
        Check(DhcpChanges.ParseIpv4("10.0.0.1") == 0x0A000001 && DhcpChanges.ParseIpv4("10.0.0.256") is null && DhcpChanges.ParseIpv4("010.0.0.1") is null, "IPv4 parsing is wrong.");
        Check(DhcpChanges.HexBytes("00-15-5d:01.02 03", 85) is { Length: 6 } && DhcpChanges.HexBytes("0", 85) is null, "Client ID parsing is wrong.");
        Check(DhcpWriter.V6(DhcpChanges.ParseIpv6("2001:db8:1::5")!) is { HighOrderBits: 0x20010db800010000, LowOrderBits: 5 }, "The IPv6 address struct is wrong.");
    }

    private static void Options()
    {
        string Type(int type, params string[] values) { try { var list = DhcpChanges.OptionValues(type, true, values); return string.Join(",", list.Select(item => item.Type + ":" + (item.Text ?? (item.Bytes is null ? item.Number.ToString(System.Globalization.CultureInfo.InvariantCulture) : Convert.ToHexString(item.Bytes))))); } catch (InvalidChangeException) { return "refused"; } }
        Check(Type(0, "255") == "0:255" && Type(0, "256") == "refused", "Byte values convert wrongly.");
        Check(Type(1, "65535") == "1:65535" && Type(1, "-1") == "refused", "Word values convert wrongly.");
        Check(Type(2, "4294967295") == "2:4294967295" && Type(2, "4294967296") == "refused", "DWORD values convert wrongly.");
        Check(Type(3, "18446744073709551615") == "3:18446744073709551615" && Type(3, "1e3") == "refused", "DWORD-DWORD values convert wrongly.");
        Check(Type(4, "10.10.1.4", "10.10.1.5") == "4:168427780,4:168427781" && Type(4, "10.10.1") == "refused", "IPv4 address values convert wrongly.");
        Check(Type(5, "corp.example") == "5:corp.example" && Type(5, "") == "refused", "String values convert wrongly.");
        Check(Type(6, "01-02-ff") == "6:0102FF" && Type(7, "0a0b") == "7:0A0B" && Type(6, "xyz") == "refused", "Binary values convert wrongly.");
        Check(Type(8, "2001:db8::10") == "8:2001:db8::10" && Type(8, "10.0.0.1") == "refused", "IPv6 address values convert wrongly.");
        bool single; try { DhcpChanges.OptionValues(2, false, ["1", "2"]); single = false; } catch (InvalidChangeException e) { single = e.Field == "values"; }
        Check(single, "A single-valued option took two values.");
        var conditions = DhcpChanges.Conditions("mac", "equals", ["00-15-5D*", "*0102", "AABBCC"]);
        Check(conditions.Select(item => item.Operator).SequenceEqual([2, 4, 0]) && conditions[0].Value.SequenceEqual(new byte[] { 0x00, 0x15, 0x5d }) && DhcpChanges.Conditions("vendorClass", "notEquals", ["MSFT 5.0"])[0] is { Type: 1, OptionId: 60, Operator: 1 }, "Policy conditions convert wrongly.");
    }

    /// <summary>A DHCP server in memory: enough of IDhcpWriter for scope-apply and the secret path.</summary>
    private sealed class MemoryWriter : IDhcpWriter
    {
        internal readonly Dictionary<uint, ScopeModel> Scopes = [];
        internal readonly List<string> Log = [];
        internal string? Secret;
        public DhcpService.Status Service() => DhcpService.Status.Running;
        public void CreateScope(uint start, uint end, uint mask, string name, string description, long? leaseSeconds, string type, bool activate) { Log.Add("create"); Scopes[start & mask] = new ScopeModel(start & mask, mask, name, description, activate, start, end, type, [], [], [], []); }
        public void EditScope(uint scope, uint start, uint end, string name, string description, long? leaseSeconds, string type) { Log.Add("edit"); Scopes[scope] = Scopes[scope] with { Name = name, Description = description, Start = start, End = end, Type = type }; }
        public void ScopeState(uint scope, bool active) { Log.Add("state"); Scopes[scope] = Scopes[scope] with { Active = active }; }
        public void DeleteScope(uint scope) => Scopes.Remove(scope);
        public bool InFailover(uint scope) => false;
        public void CreateScopeV6(byte[] prefix, string name, string description, ushort preference, bool activate) { }
        public void EditScopeV6(byte[] prefix, string name, string description, ushort preference) { }
        public void ScopeStateV6(byte[] prefix, bool active) { }
        public void DeleteScopeV6(byte[] prefix) { }
        public void SetSuperscope(string name, string? newName, IReadOnlyList<uint> scopes, bool create) { }
        public IReadOnlyList<uint> SuperscopeMembers(string name) => [];
        public void DeleteSuperscope(string name) { }
        public void Exclusion(uint scope, uint start, uint end, bool add) { var list = Scopes[scope].Exclusions; if (add) list.Add((start, end)); else list.Remove((start, end)); }
        public void ExclusionV6(byte[] prefix, byte[] start, byte[] end, bool add) { }
        public void AddReservation(uint scope, uint address, byte[] clientId, string type, string name, string description) { Log.Add("add " + DhcpSnapshot.Ipv4(address)); Scopes[scope].Reservations.Add(new ApplyReservation(address, clientId, type, name, description)); }
        public void EditReservation(uint scope, uint address, uint newAddress, byte[] clientId, string type, string name, string description) { Log.Add("update " + DhcpSnapshot.Ipv4(address)); var list = Scopes[scope].Reservations; list.RemoveAll(item => item.Address == address); list.Add(new ApplyReservation(newAddress, clientId, type, name, description)); }
        public void RemoveReservation(uint scope, uint address) { Log.Add("remove " + DhcpSnapshot.Ipv4(address)); Scopes[scope].Reservations.RemoveAll(item => item.Address == address); }
        public void AddReservationV6(byte[] prefix, byte[] address, byte[] duid, uint iaid) { }
        public void EditReservationV6(byte[] prefix, byte[] address, byte[] newAddress, byte[] duid, uint iaid) { }
        public void RemoveReservationV6(byte[] prefix, byte[] address) { }
        public void DeleteLease(uint address) { }
        public void DeleteLeaseV6(byte[] address) { }
        public (int Type, bool MultiValued) OptionType(string family, int code, string? vendor) => (4, true);
        public void SetOption(OptionTarget target, int code, string? vendor, string? user, IReadOnlyList<OptionElement> values) { if (target.Scope is uint scope && target.Level == "scope" && !Scopes[scope].Options.Contains((code, vendor, user))) Scopes[scope].Options.Add((code, vendor, user)); }
        public void RemoveOption(OptionTarget target, int code, string? vendor, string? user) { if (target.Scope is uint scope) Scopes[scope].Options.Remove((code, vendor, user)); }
        public void SetPolicy(PolicyData policy, bool create, string? newName) { if (create && policy.Scope is uint scope) Scopes[scope].Policies.Add(policy.Name); }
        public void DeletePolicy(uint? scope, string name) { if (scope is uint value) Scopes[value].Policies.Remove(name); }
        public void CreateFailover(FailoverData relationship, string? secret) { Secret = secret; Log.Add("failover"); throw new DhcpApiException("DhcpV4FailoverCreateRelationship", 20117, relationship.Name); }
        public void EditFailover(string name, byte? loadBalancePercent, byte? reservePercent, uint? mclt, uint? safePeriod, bool? authentication, string? secret, IReadOnlyList<uint> add, IReadOnlyList<uint> remove, bool deleteRemoved) => Secret = secret;
        public void RemoveFailover(string name, bool deleteScopes) { }
        public ScopeModel? ReadScope(uint scope) => Scopes.TryGetValue(scope, out var model) ? model : null;
    }

    private static Program.Outcome Read() => new(true, "PLUGIN_DHCP_READ_COMPLETED", new Dictionary<string, string>(), new JsonObject { ["schema"] = 1 });
    private static string Reservation(int host, string client) => "{\"address\":\"10.30.0." + host + "\",\"clientId\":\"" + client + "\",\"name\":\"r" + host + "\",\"description\":\"\",\"type\":\"dhcp\"}";
    private static uint Ip(string text) => DhcpChanges.ParseIpv4(text)!.Value;

    private static void Apply()
    {
        var server = new MemoryWriter();
        string settings = """{"name":"Lab","description":"copy","startRange":"10.30.0.10","endRange":"10.30.0.59","subnetMask":"255.255.255.0","leaseDurationSeconds":null,"type":"both","state":"active","exclusions":[{"start":"10.30.0.50","end":"10.30.0.59"}],"options":[{"code":3,"vendorClass":null,"userClass":null,"values":["10.30.0.1"]}],"policies":[{"name":"Phones","order":1,"enabled":true,"condition":"or","criteria":[{"type":"mac","operator":"equals","values":["00-15-5D*"]}],"ranges":[],"leaseDurationSeconds":null,"description":"","options":[]}]}""";
        string firstPart = "{\"scopeId\":\"10.30.0.0\",\"part\":1,\"parts\":2,\"settings\":" + settings + ",\"reservations\":[" + Reservation(20, "00-15-5D-00-00-20") + "," + Reservation(21, "00-15-5D-00-00-21") + "]}";
        // Part 1 of 2: the scope is missing, so it is created with its settings; two reservations are upserted.
        var first = DhcpChanges.Run("dhcp-scope-apply", Json(firstPart), Read, server);
        Check(first.Ok && first.Code == "PLUGIN_DHCP_CHANGED" && first.Data is not null && server.Log[0] == "create", "Part 1 did not create the missing scope.");
        var model = server.Scopes[Ip("10.30.0.0")];
        Check(model.Active && model.Type == "both" && model.Exclusions.Count == 1 && model.Options.SequenceEqual([(3, (string?)null, (string?)null)]) && model.Policies.SequenceEqual(["Phones"]) && model.Reservations.Count == 2, "Part 1 did not set the settings and the reservations.");
        // The partner has drifted: an extra option, another exclusion and policy, a changed reservation and two foreign ones.
        model.Options.Add((6, null, null)); model.Exclusions.Clear(); model.Exclusions.Add((Ip("10.30.0.40"), Ip("10.30.0.45"))); model.Policies.Add("Old");
        model.Reservations.RemoveAll(item => item.Address == Ip("10.30.0.21")); model.Reservations.Add(new ApplyReservation(Ip("10.30.0.21"), [0xaa, 0xbb], "dhcp", "r21", ""));
        model.Reservations.Add(new ApplyReservation(Ip("10.30.0.30"), [0x01, 0x02], "dhcp", "foreign", ""));
        model.Reservations.Add(new ApplyReservation(Ip("10.30.0.31"), [0x00, 0x15, 0x5d, 0x00, 0x00, 0x22], "dhcp", "moved", ""));
        server.Log.Clear();
        var again = DhcpChanges.Run("dhcp-scope-apply", Json(firstPart), Read, server);
        model = server.Scopes[Ip("10.30.0.0")];
        Check(again.Ok && server.Log[0] == "edit" && model.Options.SequenceEqual([(3, (string?)null, (string?)null)]) && model.Exclusions.Count == 1 && model.Exclusions[0].Start == Ip("10.30.0.50") && model.Policies.SequenceEqual(["Phones"]), "Part 1 did not replace the options, exclusions and policies.");
        Check(server.Log.Contains("update 10.30.0.21") && !server.Log.Contains("update 10.30.0.20"), "The upsert did not update only the changed reservation.");
        // Part 2 of 2: one more reservation (its client sat at another address), and keep removes the rest.
        server.Log.Clear();
        var last = DhcpChanges.Run("dhcp-scope-apply", Json("{\"scopeId\":\"10.30.0.0\",\"part\":2,\"parts\":2,\"reservations\":[" + Reservation(22, "00-15-5D-00-00-22") + "],\"keep\":[\"10.30.0.20\",\"10.30.0.21\",\"10.30.0.22\"]}"), Read, server);
        var addresses = server.Scopes[Ip("10.30.0.0")].Reservations.Select(item => DhcpSnapshot.Ipv4(item.Address)).Order().ToList();
        Check(last.Ok && addresses.SequenceEqual(["10.30.0.20", "10.30.0.21", "10.30.0.22"]) && server.Log.IndexOf("remove 10.30.0.31") < server.Log.IndexOf("add 10.30.0.22") && server.Log.Contains("remove 10.30.0.30"), "The last part did not move the client and remove the reservations outside keep.");
        var invalid = DhcpChanges.Run("dhcp-scope-apply", Json("{\"scopeId\":\"10.30.0.0\",\"part\":3,\"parts\":2,\"reservations\":[]}"), Read, server);
        Check(!invalid.Ok && invalid.Code == "PLUGIN_DHCP_INVALID_CHANGE" && invalid.Args["field"] == "part", "Invalid apply parameters reached the server.");
    }

    private static void Secret()
    {
        const string secret = "failover-secret-123";
        string create = """{"name":"DC01-DC03","partner":"SRV-DC03.corp.example","serverType":"primary","mode":"hotStandby","loadBalancePercent":50,"serverRole":"standby","reservePercent":10,"mcltSeconds":3600,"autoStateTransition":true,"stateSwitchIntervalSeconds":600,"messageAuthentication":true,"scopeIds":["10.30.0.0"],"serverAddress":"10.10.1.4","partnerAddress":"10.10.1.6"}""";
        var server = new MemoryWriter();
        var missing = DhcpChanges.Run("dhcp-failover-create", Json(create), Read, server);
        Check(!missing.Ok && missing.Code == "PLUGIN_DHCP_SECRET_MISSING" && server.Secret is null, "Authentication without a secret did not answer PLUGIN_DHCP_SECRET_MISSING.");
        var withSecret = Json(create); withSecret["secrets"] = new JsonObject { ["secret"] = secret };
        var refused = DhcpChanges.Run("dhcp-failover-create", withSecret, Read, server);
        string answer = refused.Code + " " + string.Join(" ", refused.Args.Select(pair => pair.Key + "=" + pair.Value)) + " " + Program.Message(refused.Code, refused.Args);
        Check(server.Secret == secret && !refused.Ok && refused.Code == "PLUGIN_DHCP_OBJECT_EXISTS" && refused.Args["object"] == "DC01-DC03" && !answer.Contains(secret, StringComparison.Ordinal), "The secret did not reach the call, or it appears in the result.");
        // Hot standby: the active server is the primary in Windows terms, the percentage is the reserve.
        var roles = DhcpWriter.FailoverRoles(new FailoverData("x", "y", true, true, 50, false, 10, 3600, 0, 1, 2, [1]));
        var share = DhcpWriter.FailoverRoles(new FailoverData("x", "y", false, false, 30, true, 5, 3600, 0, 1, 2, [1]));
        Check(roles == (false, (byte)10) && share == (false, (byte)70), "The failover roles or percentages are wrong.");
    }
}
