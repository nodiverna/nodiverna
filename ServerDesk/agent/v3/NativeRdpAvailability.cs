using Microsoft.Win32;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class NativeRdpAvailability
{
    internal const string TerminalRegistry = @"SYSTEM\CurrentControlSet\Control\Terminal Server";
    internal const string ListenerRegistry = TerminalRegistry + @"\WinStations\RDP-Tcp";
    internal const string PolicyRegistry = @"SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services";
    private const string Namespace = @"root\cimv2\TerminalServices";
    internal static int? Value(RegistryKey? key, string name) => key?.GetValue(name) is int value ? value : null;
    internal static JsonObject ReadValues(int? localDeny, int? policyDeny, int? nla, int? securityLayer, int? port, int? policyNla = null, int? policyLayer = null) => new()
    {
        ["enabled"] = (policyDeny ?? localDeny ?? 1) == 0,
        ["nla"] = (policyNla ?? nla ?? 0) == 1 && (policyLayer ?? securityLayer ?? 0) is 1 or 2,
        ["port"] = port is >= 1 and <= 65535 ? port.Value : 3389,
        ["policyBlocked"] = policyDeny == 1 || policyNla == 0 || policyLayer == 0,
    };
    internal static JsonObject Read()
    {
        if (!OperatingSystem.IsWindows()) return ReadValues(1, null, 0, 0, 3389);
        try
        {
            using var local = Registry.LocalMachine.OpenSubKey(TerminalRegistry);
            using var listener = Registry.LocalMachine.OpenSubKey(ListenerRegistry);
            using var policy = Registry.LocalMachine.OpenSubKey(PolicyRegistry);
            return ReadValues(Value(local, "fDenyTSConnections"), Value(policy, "fDenyTSConnections"), Value(listener, "UserAuthentication"), Value(listener, "SecurityLayer"), Value(listener, "PortNumber"), Value(policy, "UserAuthentication"), Value(policy, "SecurityLayer"));
        }
        catch { return new JsonObject { ["enabled"] = false, ["nla"] = false, ["port"] = 3389, ["policyBlocked"] = true }; }
    }
    internal static string CertificatePin()
    {
        // One bounded single-flight provider call is shared by all openings. A
        // stalled WMI provider cannot accumulate abandoned per-session threads.
        lock (pinGate)
        {
            if (pinQuery is null || pinQuery.IsCompleted)
                pinQuery = Task.Run(() => WindowsManagement.Query(Namespace, "SELECT SSLCertificateSHA1Hash FROM Win32_TSGeneralSetting WHERE TerminalName='RDP-Tcp'", 2, TimeSpan.FromSeconds(3)));
            if (!pinQuery.Wait(TimeSpan.FromSeconds(4))) throw new TimeoutException("The local RDP certificate query timed out.");
            var rows = pinQuery.GetAwaiter().GetResult();
            if (rows.Count != 1) throw new InvalidDataException("The local Windows RDP listener is unavailable.");
            string pin = WindowsManagement.Text(rows[0], "SSLCertificateSHA1Hash").Replace(" ", "", StringComparison.Ordinal);
            if (pin.Length != 40 || pin.Any(c => !Uri.IsHexDigit(c))) throw new InvalidDataException("Windows has no configured RDP listener certificate. Enable RDP and retry after its listener has started.");
            return pin;
        }
    }
    private static readonly object pinGate = new();
    private static Task<List<Dictionary<string, object?>>>? pinQuery;

    internal static AgentMessage Set(string root, JsonObject config, bool enabled, CancellationToken token)
    {
        NativeManagement.AssertManagement(root, config); token.ThrowIfCancellationRequested();
        using var policy = Registry.LocalMachine.OpenSubKey(PolicyRegistry);
        int? deny = Value(policy, "fDenyTSConnections"), nla = Value(policy, "UserAuthentication"), layer = Value(policy, "SecurityLayer");
        if (deny.HasValue && deny != (enabled ? 0 : 1)) throw new AgentMessageException("AGENT_RDP_POLICY_CONTROLLED");
        if (enabled && (nla == 0 || layer == 0)) throw new AgentMessageException("AGENT_RDP_POLICY_BLOCKS_NLA");
        var setting = WindowsManagement.Query(Namespace, "SELECT * FROM Win32_TerminalServiceSetting", 2).SingleOrDefault() ?? throw new AgentMessageException("AGENT_RDP_LISTENER_UNSUPPORTED");
        if (enabled)
        {
            var listener = WindowsManagement.Query(Namespace, "SELECT * FROM Win32_TSGeneralSetting WHERE TerminalName='RDP-Tcp'", 2).SingleOrDefault() ?? throw new AgentMessageException("AGENT_RDP_LISTENER_MISSING");
            string path = WindowsManagement.Text(listener, "__PATH", 1000);
            if (nla is null) Invoke(path, "SetUserAuthenticationRequired", new() { ["UserAuthenticationRequired"] = 1u });
            if (layer is null) Invoke(path, "SetSecurityLayer", new() { ["SecurityLayer"] = 2u });
        }
        NativeManagement.AssertManagement(root, config); token.ThrowIfCancellationRequested();
        if (deny is null) Invoke(WindowsManagement.Text(setting, "__PATH", 1000), "SetAllowTSConnections", new() { ["AllowTSConnections"] = enabled ? 1u : 0u, ["ModifyFirewallException"] = 0u });
        if (enabled) NativeServiceManagement.Execute("start-service", "TermService", null, token);
        return AgentMessages.Of(enabled ? "AGENT_RDP_ENABLED" : "AGENT_RDP_DISABLED");
        void Invoke(string path, string method, Dictionary<string, object?> parameters)
        {
            NativeManagement.AssertManagement(root, config); token.ThrowIfCancellationRequested();
            var result = WindowsManagement.Invoke(Namespace, path, method, parameters);
            if (!result.TryGetValue("ReturnValue", out var code) || Convert.ToUInt32(code) != 0) throw new AgentMessageException("AGENT_RDP_METHOD_REFUSED", ("method", method));
        }
    }
}
