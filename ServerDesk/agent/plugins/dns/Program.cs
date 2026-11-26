using System.Globalization;
using System.Text.Json.Nodes;
using ServerDesk.Plugins;

namespace ServerDesk.Plugin.Dns;

// The DNS plugin of the ServerDesk agent (docs/dns-server.md). The SYSTEM
// broker starts it with the fixed argument --plugin-host for one request and
// talks to it over stdin and stdout (agent/plugins/shared/PluginProtocol.cs).
// dns-read reads the DNS server and its zones, dns-zone-read the records of one
// zone; every other capability is one change (DnsChanges.cs), after which the
// plugin reads again. It opens no network connection: it talks only to the
// local WMI namespaces of the DNS server.
internal static class Program
{
    // BaseVersion is the csproj <Version>; a dev build adds -dev.<sha7> (agent/BuildVersion.targets).
    internal const string Name = "dns", BaseVersion = "1.0.5", Version = BaseVersion + BuildVersion.DevSuffix;
    internal static readonly string[] Capabilities = ["dns-read", "dns-zone-read", .. DnsChanges.Operations];

    /// <summary>The English texts of the plugin codes; agent/v3/AgentMessages.cs registers the same texts for the portal catalogs.</summary>
    internal static readonly IReadOnlyDictionary<string, string> Messages = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["PLUGIN_DNS_READ_COMPLETED"] = "The DNS server was read. Zones: {zones}.",
        ["PLUGIN_DNS_ZONE_READ_COMPLETED"] = "Zone {zone} was read. Records: {records}.",
        ["PLUGIN_DNS_SERVICE_STOPPED"] = "The DNS Server service is stopped. Start the service in Management → Services.",
        ["PLUGIN_DNS_NOT_INSTALLED"] = "The DNS Server role is not installed on this device. Install the role in Management → Roles & features, or remove the DNS plugin in the Extensions area.",
        ["PLUGIN_DNS_READ_FAILED"] = "The DNS server could not be read (error {error}). Try again.",
        ["PLUGIN_DNS_ACCESS_DENIED"] = "The DNS server refused access to the DNS plugin. On the server, check the members of the group DnsAdmins.",
        ["PLUGIN_DNS_CHANGED"] = "The DNS server was changed.",
        ["PLUGIN_DNS_CHANGED_NOT_READ"] = "The DNS server was changed, but the plugin could not read it afterwards. Select “Read again” to see the change.",
        ["PLUGIN_DNS_INVALID_CHANGE"] = "The DNS plugin did not make the change because the value of {field} is not valid. Correct the value and try again.",
        ["PLUGIN_DNS_OBJECT_EXISTS"] = "{object} already exists on the DNS server. Select “Read again” to see the current state.",
        ["PLUGIN_DNS_OBJECT_MISSING"] = "{object} does not exist on the DNS server. Select “Read again” to see the current state.",
        ["PLUGIN_DNS_NOT_DOMAIN_CONTROLLER"] = "This server is not a domain controller, so it cannot store zones in Active Directory. Store the zone in a file on this server instead.",
        ["PLUGIN_DNS_CHANGE_FAILED"] = "The DNS server refused the change (error {error}). Check the values and try again.",
        ["PLUGIN_DNS_CHANGE_FAILED_DETAIL"] = "The DNS server refused the change (error {error}). Windows reports: {detail} Check the values and try again.",
    };

    internal sealed record Outcome(bool Ok, string Code, IReadOnlyDictionary<string, string> Args, JsonObject? Data);
    internal static string Message(string code, IReadOnlyDictionary<string, string> args) => args.Aggregate(Messages[code], (text, pair) => text.Replace("{" + pair.Key + "}", pair.Value, StringComparison.Ordinal));

    internal static async Task<int> Main(string[] args)
    {
        if (args is ["--version"]) { Console.WriteLine(Version); return 0; }
        if (args is ["--self-test"]) return await DnsSelfTests.RunAsync();
        if (args is [PluginProtocol.Argument]) return await HostAsync(Console.OpenStandardInput(), Console.OpenStandardOutput(), Run, CancellationToken.None);
        Console.Error.WriteLine("The ServerDesk DNS plugin runs only under the ServerDesk agent.");
        return 2;
    }

    /// <summary>The operation of one request: a read, or one change followed by a read.</summary>
    internal static Outcome Run(string operation, JsonObject parameters) => operation switch
    {
        "dns-read" => Read(),
        "dns-zone-read" => ZoneRead(parameters),
        _ => DnsChanges.Run(operation, parameters, Read, ReadZone),
    };

    /// <summary>
    /// One protocol session: the broker hello, the plugin hello, at most one
    /// request, one result. An end of stream after the hello is the install
    /// handshake and exits with 0. A broken frame or an operation outside the
    /// capabilities exits with 3 without a result.
    /// </summary>
    internal static async Task<int> HostAsync(Stream input, Stream output, Func<string, JsonObject, Outcome> run, CancellationToken token)
    {
        var reader = new PluginLineReader(input);
        try
        {
            var hello = await reader.ReadLineAsync(PluginProtocol.MaximumBrokerLine, token);
            if (hello is null || PluginProtocol.Integer(PluginProtocol.Parse(hello, "hello"), "protocol") != PluginProtocol.Version) return 3;
            await PluginProtocol.WriteLineAsync(output, PluginProtocol.PluginHello(Name, Version, Capabilities), PluginProtocol.MaximumPluginLine, token);
            var line = await reader.ReadLineAsync(PluginProtocol.MaximumBrokerLine, token);
            if (line is null) return 0;
            var request = PluginProtocol.Parse(line, "request");
            string id = PluginProtocol.Text(request, "id");
            string operation = PluginProtocol.Text(request, "operation");
            if (!Guid.TryParse(id, out _) || !Capabilities.Contains(operation, StringComparer.Ordinal)) return 3;
            var outcome = run(operation, request["parameters"] as JsonObject ?? new JsonObject());
            await PluginProtocol.WriteLineAsync(output, PluginProtocol.Result(id, outcome.Ok, outcome.Code, outcome.Args, Message(outcome.Code, outcome.Args), outcome.Data), PluginProtocol.MaximumPluginLine, token);
            return 0;
        }
        catch (ProtocolException) { return 3; }
    }

    private static readonly Dictionary<string, string> None = new();
    private static (string Server, string? Domain) Host()
    {
        var properties = System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties();
        string? domain = string.IsNullOrEmpty(properties.DomainName) ? null : properties.DomainName.ToLowerInvariant();
        return (domain is null ? properties.HostName : properties.HostName + "." + domain, domain);
    }
    private static Outcome Failed(WmiException e) => e.AccessDenied ? new(false, "PLUGIN_DNS_ACCESS_DENIED", None, null) : new(false, "PLUGIN_DNS_READ_FAILED", new Dictionary<string, string> { ["error"] = e.Code.ToString(CultureInfo.InvariantCulture) }, null);

    /// <summary>dns-read: the role and the service first, then the server and its zones, cut to 2 MiB.</summary>
    internal static Outcome Read()
    {
        var service = DnsService.State();
        if (service == DnsService.Status.Missing) return new(false, "PLUGIN_DNS_NOT_INSTALLED", None, null);
        var (server, domain) = Host();
        if (service != DnsService.Status.Running) return new(true, "PLUGIN_DNS_SERVICE_STOPPED", None, DnsSnapshot.Stopped(server, domain, DateTimeOffset.UtcNow));
        try
        {
            return ServerRead(new WmiDnsServer().ReadServer(server, domain), DateTimeOffset.UtcNow);
        }
        catch (WmiException e)
        {
            // The service may stop during the read.
            if (DnsService.State() != DnsService.Status.Running) return new(true, "PLUGIN_DNS_SERVICE_STOPPED", None, DnsSnapshot.Stopped(server, domain, DateTimeOffset.UtcNow));
            return Failed(e);
        }
        catch (InvalidOperationException) { return new(false, "PLUGIN_DNS_READ_FAILED", new Dictionary<string, string> { ["error"] = "0" }, null); }
    }

    /// <summary>The outcome of a server read from the raw WMI values: the server cut to 2 MiB and its zone count. The self-test runs the same path.</summary>
    internal static Outcome ServerRead(RawServer raw, DateTimeOffset now)
    {
        var snapshot = DnsSnapshot.FitServer(DnsSnapshot.Server(raw, now));
        var args = new Dictionary<string, string> { ["zones"] = snapshot["zones"]!.AsArray().Count.ToString(CultureInfo.InvariantCulture) };
        return new(true, "PLUGIN_DNS_READ_COMPLETED", args, snapshot);
    }
    /// <summary>The outcome of a zone read from the raw WMI records. The self-test runs the same path.</summary>
    internal static Outcome ZoneRecordsRead(string zone, IReadOnlyList<RawRecord> records, DateTimeOffset now)
    {
        var data = DnsSnapshot.Records(zone, records, now);
        var args = new Dictionary<string, string> { ["zone"] = zone, ["records"] = data["total"]!.ToJsonString() };
        return new(true, "PLUGIN_DNS_ZONE_READ_COMPLETED", args, data);
    }

    /// <summary>dns-zone-read {zone}: the records of one zone of this server, cut to 2 MiB.</summary>
    internal static Outcome ZoneRead(JsonObject parameters)
    {
        string zone;
        try { var input = new ChangeInput(parameters); input.Only("zone"); zone = DnsText.Name(input.Text("zone", 255)); if (zone.Length == 0) throw new InvalidChangeException("zone"); }
        catch (InvalidChangeException e) { return new(false, "PLUGIN_DNS_INVALID_CHANGE", new Dictionary<string, string> { ["field"] = e.Field }, null); }
        var service = DnsService.State();
        if (service == DnsService.Status.Missing) return new(false, "PLUGIN_DNS_NOT_INSTALLED", None, null);
        if (service != DnsService.Status.Running) return new(false, "PLUGIN_DNS_SERVICE_STOPPED", None, null);
        try { return ReadZone(zone); }
        catch (WmiException e) { return Failed(e); }
    }
    /// <summary>The records of one zone; the zone must exist on this server.</summary>
    internal static Outcome ReadZone(string zone)
    {
        var server = new WmiDnsServer();
        if (!server.Zones().Any(item => DnsText.Name(item.Name) == zone)) return new(false, "PLUGIN_DNS_OBJECT_MISSING", new Dictionary<string, string> { ["object"] = zone }, null);
        return ZoneRecordsRead(zone, server.Records(zone), DateTimeOffset.UtcNow);
    }
}
