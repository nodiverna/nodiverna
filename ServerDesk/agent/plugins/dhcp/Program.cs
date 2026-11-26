using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using ServerDesk.Plugins;

namespace ServerDesk.Plugin.Dhcp;

// The DHCP plugin of the ServerDesk agent (docs/dhcp-server.md). The SYSTEM
// broker starts it with the fixed argument --plugin-host for one request and
// talks to it over stdin and stdout (agent/plugins/shared/PluginProtocol.cs).
// dhcp-read reads the DHCP server; since 1.1.0 every other capability is one
// change (DhcpChanges.cs), after which the plugin reads the server again. It
// opens no network connection: every DHCP API call names the local server.
internal static class Program
{
    // BaseVersion is the csproj <Version>; a dev build adds -dev.<sha7> (agent/BuildVersion.targets).
    internal const string Name = "dhcp", BaseVersion = "1.1.1", Version = BaseVersion + BuildVersion.DevSuffix;
    internal static readonly string[] Capabilities = ["dhcp-read", .. DhcpChanges.Operations];

    /// <summary>The English texts of the plugin codes; agent/v3/AgentMessages.cs registers the same texts for the portal catalogs.</summary>
    internal static readonly IReadOnlyDictionary<string, string> Messages = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["PLUGIN_DHCP_READ_COMPLETED"] = "The DHCP server was read: {scopes} scopes, {leases} leases.",
        ["PLUGIN_DHCP_SERVICE_STOPPED"] = "The DHCP Server service is stopped. Start it under Management → Services.",
        ["PLUGIN_DHCP_ACCESS_DENIED"] = "The DHCP server refused access to the plugin. Check the DHCP Administrators and DHCP Users groups.",
        ["PLUGIN_DHCP_NOT_INSTALLED"] = "The DHCP Server role is not installed on this device.",
        ["PLUGIN_DHCP_READ_FAILED"] = "The DHCP server could not be read (error {error}). Try again.",
        ["PLUGIN_DHCP_CHANGED"] = "The DHCP server was changed.",
        ["PLUGIN_DHCP_CHANGED_NOT_READ"] = "The DHCP server was changed. The plugin could not read it again. The portal shows the change after the next read.",
        ["PLUGIN_DHCP_INVALID_CHANGE"] = "The plugin refused the change because {field} is not valid.",
        ["PLUGIN_DHCP_OBJECT_EXISTS"] = "{object} already exists on the DHCP server. Read the server again.",
        ["PLUGIN_DHCP_OBJECT_MISSING"] = "{object} does not exist on the DHCP server. Read the server again.",
        ["PLUGIN_DHCP_IN_FAILOVER"] = "Scope {scope} is in a failover relationship. Remove it from the relationship first.",
        ["PLUGIN_DHCP_SECRET_MISSING"] = "The shared secret did not reach the plugin. Update the agent to 4.17.0 or later and try again.",
        ["PLUGIN_DHCP_CHANGE_FAILED"] = "The DHCP server refused the change (error {error}). Check the values and try again.",
    };

    internal sealed record Outcome(bool Ok, string Code, IReadOnlyDictionary<string, string> Args, JsonObject? Data);
    internal static string Message(string code, IReadOnlyDictionary<string, string> args) => args.Aggregate(Messages[code], (text, pair) => text.Replace("{" + pair.Key + "}", pair.Value, StringComparison.Ordinal));

    internal static async Task<int> Main(string[] args)
    {
        if (args is ["--version"]) { Console.WriteLine(Version); return 0; }
        if (args is ["--self-test"]) return await DhcpSelfTests.RunAsync();
        if (args is [PluginProtocol.Argument]) return await HostAsync(Console.OpenStandardInput(), Console.OpenStandardOutput(), Run, CancellationToken.None);
        Console.Error.WriteLine("The ServerDesk DHCP plugin runs only under the ServerDesk agent.");
        return 2;
    }

    /// <summary>The operation of one request: the read, or one change followed by a read.</summary>
    internal static Outcome Run(string operation, JsonObject parameters) => operation == "dhcp-read" ? Read() : DhcpChanges.Run(operation, parameters, Read);

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

    /// <summary>dhcp-read: the role and the service first, then the whole server, cut to 2 MiB.</summary>
    internal static Outcome Read()
    {
        var service = DhcpService.State();
        if (service == DhcpService.Status.Missing || !NativeLibrary.TryLoad("dhcpsapi.dll", out var library)) return new Outcome(false, "PLUGIN_DHCP_NOT_INSTALLED", None, null);
        NativeLibrary.Free(library);
        var properties = System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties();
        string? domain = string.IsNullOrEmpty(properties.DomainName) ? null : properties.DomainName;
        string server = domain is null ? properties.HostName : properties.HostName + "." + domain;
        if (service != DhcpService.Status.Running) return new Outcome(true, "PLUGIN_DHCP_SERVICE_STOPPED", None, DhcpSnapshot.Stopped(server, domain, "unknown"));
        try
        {
            var snapshot = DhcpSnapshot.Fit(DhcpSnapshot.Build(DhcpApi.Read(), DateTimeOffset.UtcNow));
            int scopes = snapshot["ipv4"]!["scopes"]!.AsArray().Count + snapshot["ipv6"]!["scopes"]!.AsArray().Count;
            var args = new Dictionary<string, string> { ["scopes"] = scopes.ToString(System.Globalization.CultureInfo.InvariantCulture), ["leases"] = snapshot["leases"]!["total"]!.ToJsonString() };
            return new Outcome(true, "PLUGIN_DHCP_READ_COMPLETED", args, snapshot);
        }
        catch (DhcpApiException e) when (e.Code == DhcpApi.AccessDenied) { return new Outcome(false, "PLUGIN_DHCP_ACCESS_DENIED", None, null); }
        catch (DhcpApiException e)
        {
            // The service may stop during the read.
            if (DhcpService.State() != DhcpService.Status.Running) return new Outcome(true, "PLUGIN_DHCP_SERVICE_STOPPED", None, DhcpSnapshot.Stopped(server, domain, "unknown"));
            return new Outcome(false, "PLUGIN_DHCP_READ_FAILED", new Dictionary<string, string> { ["error"] = e.Code.ToString(System.Globalization.CultureInfo.InvariantCulture) }, null);
        }
    }
}

// The DHCP Server service (DHCPServer) through the service control manager, read only.
internal static class DhcpService
{
    internal enum Status { Missing, Stopped, Running }
    [StructLayout(LayoutKind.Sequential)] private struct ServiceStatus { public uint Type, CurrentState, ControlsAccepted, Win32ExitCode, ServiceSpecificExitCode, CheckPoint, WaitHint; }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenSCManagerW(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatus(IntPtr service, out ServiceStatus status);
    [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr handle);

    internal static Status State()
    {
        IntPtr manager = OpenSCManagerW(null, null, 0x0001); // SC_MANAGER_CONNECT
        if (manager == IntPtr.Zero) return Status.Missing;
        try
        {
            IntPtr service = OpenServiceW(manager, "DHCPServer", 0x0004); // SERVICE_QUERY_STATUS
            if (service == IntPtr.Zero) return Status.Missing;
            try { return QueryServiceStatus(service, out var status) && status.CurrentState == 4 ? Status.Running : Status.Stopped; }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }
}
