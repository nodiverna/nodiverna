using System.ComponentModel;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ServerDesk.Agent;

// Built-in operations use typed Windows interfaces. No command interpreter, scripts, or
// shell interpolation is involved. User-authored PowerShell is a separate subsystem.
internal static class NativeManagement
{
    private const string Cim = @"root\cimv2", Net = @"root\StandardCimv2";
    internal static async Task<JsonObject> ExecuteAsync(string root, JsonObject config, JsonObject job, CancellationToken token, IGpuDriverSource? gpuDrivers = null)
    {
        string id = job["id"]?.GetValue<string>() ?? "", action = job["action"]?.GetValue<string>() ?? "";
        var result = new JsonObject { ["id"] = id, ["ok"] = false }; JsonObject secrets = new();
        try
        {
            if (!Guid.TryParse(id, out _)) throw new AgentMessageException("AGENT_INVALID_JOB_ID");
            var p = job["parameters"]?.AsObject() ?? new JsonObject(); ValidateParameters(action, p);
            token.ThrowIfCancellationRequested();
            if (!new[] { "refresh", "scan-updates", "test-connection" }.Contains(action)) AssertManagement(root, config);
            if (!OperatingSystem.IsWindows()) throw new AgentMessageException("AGENT_WINDOWS_REQUIRED");
            if (p["secrets"] is JsonObject box) secrets = LocalStore.DecryptSecrets(box, config["privateKey"]?.GetValue<string>() ?? throw new AgentMessageException("AGENT_KEY_MISSING"));
            AgentMessage message;
            if (action == "refresh") message = AgentMessages.Of("AGENT_INVENTORY_REFRESH_REQUESTED");
            else if (action == "test-connection")
            {
                using var client = new TcpClient(); using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(10));
                await client.ConnectAsync(Text(p, "host", 253), (int)Integer(p, "port", 1, 65535), timeout.Token);
                message = AgentMessages.Of("AGENT_TCP_CONNECTED", ("host", Text(p, "host", 253)), ("port", Integer(p, "port", 1, 65535)));
            }
            else if (action is "install-feature" or "remove-feature")
            {
                bool server = Convert.ToInt32(ComputerOperatingSystem()["ProductType"]) != 1;
                if (action == "remove-feature" && Text(p, "name", 128).Equals("AD-Domain-Services", StringComparison.OrdinalIgnoreCase)) AssertNotDomainController();
                bool reboot;
                try { reboot = await NativeFeatures.ChangeAsync(server, Text(p, "name", 128), action == "install-feature", Boolean(p, "includeManagementTools"), token); }
                catch (NativeInventoryException failure) { throw new AgentMessageException(failure, "AGENT_FEATURE_CHANGE_FAILED", ("detail", failure.Message)); }
                message = AgentMessages.Of(reboot ? "AGENT_FEATURE_CHANGED_REBOOT" : "AGENT_FEATURE_CHANGED");
            }
            else if (action == "install-gpu-driver") message = await GpuDriverUpdate.InstallAsync(root, p, gpuDrivers, token);
            else message = await Task.Run(() => ExecuteWindows(root, config, action, p, secrets, token), token);
            result["ok"] = true; AgentMessages.Write(result, message, SecretValues(secrets));
        }
        catch (Exception e) { AgentMessages.Fail(result, e, SecretValues(secrets)); }
        finally { secrets.Clear(); }
        return result;
    }
    // Masking covers the message and every argument; no argument carries a secret value.
    private static string[] SecretValues(JsonObject secrets) => secrets.Select(x => x.Value is JsonValue v && v.TryGetValue<string>(out var s) ? s : "").ToArray();

    internal static void AssertManagement(string root, JsonObject config)
    {
        // A portal flag cannot override the locally protected opt-in, including an
        // administrator changing the mode while a queued job waits to execute.
        JsonObject local = File.Exists(Path.Combine(root, "config.bin")) ? LocalStore.ReadProtected(Path.Combine(root, "config.bin")) : config;
        if (local["mode"]?.GetValue<string>() != "Management") throw new AgentMessageException("AGENT_READONLY");
    }

    private static AgentMessage ExecuteWindows(string root, JsonObject config, string action, JsonObject p, JsonObject secrets, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        switch (action)
        {
            case "start-service": case "stop-service": case "restart-service": case "set-service-startup":
                NativeServiceManagement.Execute(action, Text(p, "name", 256), p["startup"]?.GetValue<string>(), token); return AgentMessages.Of("AGENT_SERVICE_ACTION_DONE");
            case "set-network": SetNetwork(p, token); return AgentMessages.Of("AGENT_NETWORK_CHANGED");
            case "set-dns": SetDns(p); return AgentMessages.Of("AGENT_DNS_CHANGED");
            case "join-domain": case "leave-domain": case "rename-computer": NativeAccounts.ChangeComputer(action, p, secrets); return AgentMessages.Of("AGENT_COMPUTER_CHANGE_PENDING");
            case "set-pagefile": SetPagefile(p); return AgentMessages.Of("AGENT_PAGEFILE_CHANGED");
            case "create-local-user": case "set-local-user": case "reset-local-password": case "delete-local-user": case "local-group-add": case "local-group-remove":
                return NativeAccounts.Execute(action, p, secrets);
            case "restart-computer": case "shutdown-computer": NativeAccounts.SchedulePower(action == "restart-computer", (uint)Integer(p, "delaySeconds", 60, 3600), Text(p, "reason", 400)); return AgentMessages.Of("AGENT_POWER_SCHEDULED", ("seconds", Integer(p, "delaySeconds", 60, 3600)));
            case "schedule-power": return NativePowerSchedule.Schedule(root, config, p, token);
            case "cancel-power-schedule": return NativePowerSchedule.Cancel(root, config, p, token);
            case "scan-updates": return NativeWindowsUpdates.Scan(root, token);
            case "install-updates": AssertManagement(root, config); return NativeWindowsUpdates.Install(root, config, p, token);
            case "set-firewall-rule": case "add-firewall-rule": SetFirewall(action, p, root, config); return AgentMessages.Of(action == "add-firewall-rule" ? "AGENT_FIREWALL_RULE_CREATED" : "AGENT_FIREWALL_RULE_CHANGED");
            case "set-task": SetTask(p); return AgentMessages.Of("AGENT_TASK_CHANGED");
            case "set-rdp": return NativeRdpAvailability.Set(root, config, Boolean(p, "enabled"), token);
            default: throw new AgentMessageException("AGENT_UNKNOWN_ACTION");
        }
    }

    // Validation is deliberately pure so malformed/injection inputs can be tested on
    // non-Windows build hosts without executing an OS mutation.
    internal static void ValidateParameters(string action, JsonObject p)
    {
        switch (action)
        {
            case "refresh": case "scan-updates": return;
            case "set-rdp": if (!Boolean(p, "enabled") && (p["confirm"] is not JsonValue confirmation || !confirmation.TryGetValue<bool>(out bool confirmed) || !confirmed)) throw new AgentMessageException("AGENT_RDP_DISABLE_CONFIRM"); return;
            case "test-connection": if (!Regex.IsMatch(Text(p, "host", 253), @"^[a-zA-Z0-9.:-]+$")) throw new AgentMessageException("AGENT_INVALID_NETWORK_TARGET"); Integer(p, "port", 1, 65535); return;
            case "start-service": case "stop-service": case "restart-service": case "set-service-startup":
                string service = Text(p, "name", 256); NoWildcards(service);
                if (service.Equals("ServerDeskAgent", StringComparison.OrdinalIgnoreCase) && action != "start-service") throw new AgentMessageException("AGENT_SERVICE_SELF_PROTECTED");
                if (action == "set-service-startup") Choice(p, "startup", "Automatic", "Manual", "Disabled"); return;
            case "install-feature": case "remove-feature": if (!Regex.IsMatch(Text(p, "name", 128), @"^[a-zA-Z0-9-]+$")) throw new AgentMessageException("AGENT_INVALID_FEATURE_NAME"); Boolean(p, "includeManagementTools"); return;
            case "set-network": Integer(p, "interfaceIndex", 1, int.MaxValue); if (!Boolean(p, "dhcp")) { string ip = Address(p, "address", true); int prefix = (int)Integer(p, "prefixLength", 1, 32); string? gw = OptionalText(p, "gateway", 100); if (!string.IsNullOrEmpty(gw)) ParseAddress(gw, true); ValidateSubnet(ip, prefix, gw); } return;
            case "set-dns": Integer(p, "interfaceIndex", 1, int.MaxValue); if (!Boolean(p, "automatic")) foreach (string ip in StringArray(p, "servers", 1, 8)) ParseAddress(ip, false); return;
            case "join-domain": if (!Regex.IsMatch(Text(p, "domain", 253), @"^[a-zA-Z0-9][a-zA-Z0-9.-]*$")) throw new AgentMessageException("AGENT_INVALID_DOMAIN"); OptionalText(p, "ouPath", 1000); return;
            case "leave-domain": if (!Regex.IsMatch(Text(p, "workgroup", 15), @"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")) throw new AgentMessageException("AGENT_INVALID_WORKGROUP"); return;
            case "rename-computer": string name = Text(p, "name", 15); if (!Regex.IsMatch(name, @"^[a-zA-Z0-9][a-zA-Z0-9-]*$") || Regex.IsMatch(name, @"^\d+$")) throw new AgentMessageException("AGENT_INVALID_COMPUTER_NAME"); return;
            case "set-pagefile": if (!Boolean(p, "automatic")) { if (!Regex.IsMatch(Text(p, "drive", 2), @"^[A-Z]:$")) throw new AgentMessageException("AGENT_PAGEFILE_DRIVE_FORMAT"); long initial = Integer(p, "initialMb", 16, 4194304), maximum = Integer(p, "maximumMb", 16, 4194304); if (maximum < initial) throw new AgentMessageException("AGENT_PAGEFILE_SIZE_ORDER"); } return;
            case "create-local-user": case "set-local-user": ValidateUsername(Text(p, "name", 20)); OptionalText(p, "fullName", 256); OptionalText(p, "description", 48); Boolean(p, "passwordNeverExpires"); if (action == "set-local-user") Boolean(p, "enabled"); return;
            case "reset-local-password": case "delete-local-user": ValidateUsername(Text(p, "name", 20)); return;
            case "local-group-add": case "local-group-remove": ValidateUsername(Text(p, "name", 20)); if (!Regex.IsMatch(Text(p, "groupSid", 184), @"^S-1-\d+(-\d+)+$")) throw new AgentMessageException("AGENT_INVALID_GROUP_SID"); return;
            case "restart-computer": case "shutdown-computer": Integer(p, "delaySeconds", 60, 3600); Text(p, "reason", 400); return;
            case "schedule-power": NativePowerSchedule.ValidateSchedule(p); return;
            case "cancel-power-schedule": NativePowerSchedule.ValidateCancel(p); return;
            case "install-updates": NativeWindowsUpdates.ValidateInstall(p); return;
            case "install-gpu-driver": GpuDriverUpdate.Validate(p); return;
            case "set-firewall-rule": NoWildcards(Text(p, "name", 256)); Boolean(p, "enabled"); return;
            case "add-firewall-rule":
                Text(p, "name", 200); Choice(p, "direction", "Inbound", "Outbound"); Choice(p, "action", "Allow", "Block"); Choice(p, "protocol", "TCP", "UDP");
                string ports = Text(p, "port", 300); if (!Regex.IsMatch(ports, @"^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$")) throw new AgentMessageException("AGENT_FIREWALL_PORT_FORMAT");
                foreach (string port in ports.Split(',')) { var bounds = port.Split('-').Select(x => int.Parse(x, System.Globalization.CultureInfo.InvariantCulture)).ToArray(); if (bounds.Any(x => x is < 1 or > 65535) || bounds.Length == 2 && bounds[0] > bounds[1]) throw new AgentMessageException("AGENT_INVALID_PORT_RANGE"); }
                foreach (string remote in Text(p, "remoteAddress", 500).Split(',')) { if (remote is "Any" or "LocalSubnet") continue; var parts = remote.Split('/'); var ip = ParseAddress(parts[0], false); if (parts.Length > 2 || parts.Length == 2 && (!Regex.IsMatch(parts[1], @"^\d{1,3}$") || !int.TryParse(parts[1], out int prefix) || prefix < 0 || prefix > (ip.AddressFamily == AddressFamily.InterNetwork ? 32 : 128))) throw new AgentMessageException("AGENT_INVALID_ADDRESS_PREFIX"); } return;
            case "set-task": string task = Text(p, "name", 256), path = Text(p, "path", 500); NoWildcards(task); NoWildcards(path); Boolean(p, "enabled"); if (path != @"\" && !Regex.IsMatch(path, @"^\\.*\\$")) throw new AgentMessageException("AGENT_INVALID_TASK_PATH"); if (task.Equals("Scheduled Power", StringComparison.OrdinalIgnoreCase) && path.Equals(@"\ServerDesk\", StringComparison.OrdinalIgnoreCase)) throw new AgentMessageException("AGENT_TASK_POWER_PROTECTED"); if (task.Equals("ServerDesk Update Recovery", StringComparison.OrdinalIgnoreCase) && path == @"\") throw new AgentMessageException("AGENT_TASK_RECOVERY_PROTECTED"); return;
            default: throw new AgentMessageException("AGENT_UNKNOWN_ACTION");
        }
    }

    internal static string Text(JsonObject p, string key, int maximum)
    {
        if (p[key] is not JsonValue v || !v.TryGetValue<string>(out string? s) || string.IsNullOrEmpty(s) || s.Length > maximum || s.Any(c => c < 32)) throw new AgentMessageException("AGENT_INVALID_TEXT_PARAMETER", ("name", key));
        return s;
    }
    internal static string? OptionalText(JsonObject p, string key, int maximum)
    {
        if (p[key] is null) return null; if (p[key] is not JsonValue v || !v.TryGetValue<string>(out string? s) || s is null || s.Length > maximum || s.Any(c => c < 32)) throw new AgentMessageException("AGENT_INVALID_TEXT_PARAMETER", ("name", key)); return s;
    }
    internal static long Integer(JsonObject p, string key, long minimum, long maximum)
    {
        if (p[key] is not JsonValue v || v.GetValueKind() != System.Text.Json.JsonValueKind.Number || !double.TryParse(v.ToJsonString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out double n) || !double.IsFinite(n) || Math.Floor(n) != n || n < minimum || n > maximum) throw new AgentMessageException("AGENT_NUMBER_OUT_OF_RANGE", ("name", key)); return (long)n;
    }
    internal static bool Boolean(JsonObject p, string key) => p[key] is JsonValue v && v.TryGetValue<bool>(out bool b) ? b : throw new AgentMessageException("AGENT_INVALID_BOOLEAN", ("name", key));
    internal static string[] StringArray(JsonObject p, string key, int minimum, int maximum)
    {
        if (p[key] is not JsonArray a || a.Count < minimum || a.Count > maximum) throw new AgentMessageException("AGENT_INVALID_COUNT", ("name", key));
        return a.Select(x => x is JsonValue v && v.TryGetValue<string>(out string? s) && !string.IsNullOrEmpty(s) ? s : throw new AgentMessageException("AGENT_INVALID_LIST_ENTRY", ("name", key))).ToArray();
    }
    internal static string Choice(JsonObject p, string key, params string[] choices) { string s = Text(p, key, 40); if (!choices.Contains(s)) throw new AgentMessageException("AGENT_INVALID_CHOICE", ("name", key)); return s; }
    private static void NoWildcards(string value) { if (value.IndexOfAny(['*', '?', '[', ']']) >= 0) throw new AgentMessageException("AGENT_WILDCARDS_NOT_ALLOWED"); }
    internal static void ValidateUsername(string name) { if (Regex.IsMatch(name, "[\"/\\\\\\[\\]:;|=,+*?<>@]") || Regex.IsMatch(name, "^[. ]+$")) throw new AgentMessageException("AGENT_INVALID_LOCAL_USERNAME"); }
    private static string Address(JsonObject p, string key, bool v4) { string s = Text(p, key, 100); ParseAddress(s, v4); return s; }
    internal static IPAddress ParseAddress(string value, bool v4)
    {
        if (!IPAddress.TryParse(value, out var ip) || v4 && (ip.AddressFamily != AddressFamily.InterNetwork || !Regex.IsMatch(value, @"^\d{1,3}(\.\d{1,3}){3}$"))) throw new AgentMessageException("AGENT_INVALID_IP"); return ip;
    }
    internal static void ValidateSubnet(string address, int prefix, string? gateway)
    {
        static ulong Number(string s) { byte[] a = IPAddress.Parse(s).GetAddressBytes(); return ((ulong)a[0] << 24) | ((ulong)a[1] << 16) | ((ulong)a[2] << 8) | a[3]; }
        ulong ip = Number(address), count = 1UL << (32 - prefix), mask = uint.MaxValue - (count - 1), network = ip & mask;
        if (ip == 0 || ip >= 3758096384 || prefix < 31 && (ip == network || ip == network + count - 1)) throw new AgentMessageException("AGENT_NO_UNICAST_ADDRESS");
        if (!string.IsNullOrEmpty(gateway)) { ulong gw = Number(gateway); if (gw == ip || (gw & mask) != network || gw == 0 || gw >= 3758096384 || prefix < 31 && (gw == network || gw == network + count - 1)) throw new AgentMessageException("AGENT_GATEWAY_SUBNET"); }
    }

    internal static Dictionary<string, object?> Computer() => WindowsManagement.Query(Cim, "SELECT * FROM Win32_ComputerSystem", 1).FirstOrDefault() ?? throw new AgentMessageException("AGENT_COMPUTER_INVENTORY_UNAVAILABLE");
    private static Dictionary<string, object?> ComputerOperatingSystem() => WindowsManagement.Query(Cim, "SELECT ProductType FROM Win32_OperatingSystem", 1).FirstOrDefault() ?? throw new AgentMessageException("AGENT_OS_INVENTORY_UNAVAILABLE");
    internal static void AssertNotDomainController() { if (Convert.ToInt32(Computer()["DomainRole"]) >= 4) throw new AgentMessageException("AGENT_DOMAIN_CONTROLLER"); }

    private static void SetNetwork(JsonObject p, CancellationToken token)
    {
        int index = (int)Integer(p, "interfaceIndex", 1, int.MaxValue); bool dhcp = Boolean(p, "dhcp");
        var interfaces = WindowsManagement.Query(Net, "SELECT * FROM MSFT_NetIPInterface WHERE InterfaceIndex=" + index + " AND AddressFamily=2", 8);
        if (interfaces.Count == 0) throw new AgentMessageException("AGENT_IPV4_ADAPTER_NOT_FOUND");
        var oldIps = WindowsManagement.Query(Net, "SELECT * FROM MSFT_NetIPAddress WHERE InterfaceIndex=" + index + " AND AddressFamily=2", 100);
        var oldRoutes = WindowsManagement.Query(Net, "SELECT * FROM MSFT_NetRoute WHERE InterfaceIndex=" + index + " AND AddressFamily=2 AND DestinationPrefix='0.0.0.0/0'", 100);
        byte oldDhcp = Convert.ToByte(interfaces[0]["Dhcp"]);
        try
        {
            token.ThrowIfCancellationRequested();
            foreach (var row in oldIps.Where(x => !dhcp || Convert.ToInt32(x["PrefixOrigin"]) == 1)) Delete(Net, PathOf(row));
            foreach (var row in oldRoutes.Where(x => !dhcp || Convert.ToInt32(x["Protocol"]) == 3)) Delete(Net, PathOf(row));
            foreach (var row in interfaces) Put(Net, PathOf(row), new() { ["Dhcp"] = DhcpValue(dhcp) });
            if (!dhcp) CreateAddress(index, Text(p, "address", 100), (byte)Integer(p, "prefixLength", 1, 32), OptionalText(p, "gateway", 100));
        }
        catch (Exception apply)
        {
            try
            {
                // Restore only manually configured entries; DHCP-derived entries must
                // be renewed by the Windows DHCP client rather than made static.
                foreach (var row in WindowsManagement.Query(Net, "SELECT * FROM MSFT_NetIPAddress WHERE InterfaceIndex=" + index + " AND AddressFamily=2", 100).Where(x => Convert.ToInt32(x["PrefixOrigin"]) == 1)) Delete(Net, PathOf(row));
                foreach (var row in WindowsManagement.Query(Net, "SELECT * FROM MSFT_NetRoute WHERE InterfaceIndex=" + index + " AND AddressFamily=2 AND DestinationPrefix='0.0.0.0/0'", 100).Where(x => Convert.ToInt32(x["Protocol"]) == 3)) Delete(Net, PathOf(row));
                foreach (var row in interfaces) Put(Net, PathOf(row), new() { ["Dhcp"] = DhcpValue(false) });
                foreach (var row in oldIps.Where(x => Convert.ToInt32(x["PrefixOrigin"]) == 1)) CreateAddress(index, Convert.ToString(row["IPAddress"])!, Convert.ToByte(row["PrefixLength"]), null);
                foreach (var row in oldRoutes.Where(x => Convert.ToInt32(x["Protocol"]) == 3)) Check(WindowsManagement.Invoke(Net, "MSFT_NetRoute", "Create", new() { ["InterfaceIndex"] = (uint)index, ["AddressFamily"] = (ushort)2, ["DestinationPrefix"] = "0.0.0.0/0", ["NextHop"] = row["NextHop"], ["RouteMetric"] = row["RouteMetric"], ["PolicyStore"] = "PersistentStore" }), "AGENT_IPV4_ROUTE_RESTORE_FAILED");
                foreach (var row in interfaces) Put(Net, PathOf(row), new() { ["Dhcp"] = oldDhcp });
            }
            catch { throw new AgentMessageException(apply, "AGENT_IP_CHANGE_RESTORE_FAILED", ("detail", apply.Message)); }
            throw new AgentMessageException(apply, "AGENT_IP_CHANGE_RESTORED", ("detail", apply.Message));
        }
    }
    private static void CreateAddress(int index, string address, byte prefix, string? gateway)
    {
        var properties = new Dictionary<string, object?> { ["InterfaceIndex"] = (uint)index, ["AddressFamily"] = (ushort)2, ["IPAddress"] = address, ["PrefixLength"] = prefix, ["PolicyStore"] = "PersistentStore" };
        if (!string.IsNullOrEmpty(gateway)) properties["DefaultGateway"] = gateway;
        Check(WindowsManagement.Invoke(Net, "MSFT_NetIPAddress", "Create", properties), "AGENT_IPV4_ADDRESS_FAILED");
    }
    internal static byte DhcpValue(bool enabled) => enabled ? (byte)1 : (byte)0;
    private static void SetDns(JsonObject p)
    {
        int index = (int)Integer(p, "interfaceIndex", 1, int.MaxValue); var adapter = WindowsManagement.Query(Cim, "SELECT * FROM Win32_NetworkAdapterConfiguration WHERE InterfaceIndex=" + index, 1).FirstOrDefault() ?? throw new AgentMessageException("AGENT_NETWORK_ADAPTER_NOT_FOUND");
        Check(WindowsManagement.Invoke(Cim, PathOf(adapter), "SetDNSServerSearchOrder", new() { ["DNSServerSearchOrder"] = Boolean(p, "automatic") ? null : StringArray(p, "servers", 1, 8) }), "AGENT_DNS_CONFIGURE_FAILED", allowReboot: true);
    }
    private static void SetPagefile(JsonObject p)
    {
        var computer = Computer(); bool automatic = Boolean(p, "automatic");
        if (automatic) { Put(Cim, PathOf(computer), new() { ["AutomaticManagedPagefile"] = true }); return; }
        string drive = Text(p, "drive", 2), filename = drive + @"\pagefile.sys"; uint initial = (uint)Integer(p, "initialMb", 16, 4194304), maximum = (uint)Integer(p, "maximumMb", 16, 4194304);
        var disk = WindowsManagement.Query(Cim, "SELECT FreeSpace FROM Win32_LogicalDisk WHERE DeviceID='" + drive + "' AND DriveType=3", 1).FirstOrDefault() ?? throw new AgentMessageException("AGENT_LOCAL_DRIVE_NOT_FOUND");
        var usage = WindowsManagement.Query(Cim, "SELECT Name,AllocatedBaseSize FROM Win32_PageFileUsage", 100).FirstOrDefault(x => string.Equals(Convert.ToString(x["Name"]), filename, StringComparison.OrdinalIgnoreCase));
        if ((ulong)initial * 1048576UL > Convert.ToUInt64(disk["FreeSpace"]) + (usage is null ? 0UL : Convert.ToUInt64(usage["AllocatedBaseSize"]) * 1048576UL)) throw new AgentMessageException("AGENT_PAGEFILE_NO_SPACE");
        var existing = WindowsManagement.Query(Cim, "SELECT * FROM Win32_PageFileSetting", 100).FirstOrDefault(x => string.Equals(Convert.ToString(x["Name"]), filename, StringComparison.OrdinalIgnoreCase));
        Put(Cim, PathOf(computer), new() { ["AutomaticManagedPagefile"] = false });
        var properties = new Dictionary<string, object?> { ["InitialSize"] = initial, ["MaximumSize"] = maximum };
        if (existing is not null) Put(Cim, PathOf(existing), properties); else { properties["Name"] = filename; Create(Cim, "Win32_PageFileSetting", properties); }
    }
    private static void SetFirewall(string action, JsonObject p, string root, JsonObject config)
    {
        object? policyObject = null, ruleObject = null;
        try
        {
            dynamic policy = policyObject = CreateCom("HNetCfg.FwPolicy2");
            if (action == "set-firewall-rule")
            {
                // NetSecurity uses an instance-ID distinct from its display label.
                // Resolve that exact local PersistentStore entry with the provider,
                // never an arbitrary/GPO rule that merely shares the display name.
                string id = Text(p, "name", 256);
                var rules = WindowsManagement.Query(Net, "SELECT * FROM MSFT_NetFirewallRule WHERE InstanceID='" + WqlString(id) + "'", 3);
                // SourceType is only populated when provider tracing is enabled.
                // Independently prove the exact ID exists in the machine's local
                // store, rather than accepting an effective GPO rule with that ID.
                using var localStore = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules", false);
                var target = SelectLocalFirewallRule(rules, id, localStore?.GetValue(id) is string);
                string rawName = Convert.ToString(target.GetValueOrDefault("ElementName")) ?? "";
                dynamic matched = policy.Rules.Item(rawName); ruleObject = matched;
                // COM identifies rules by name; duplicate names would make this unsafe.
                int duplicates = 0; foreach (dynamic rule in policy.Rules) { try { if (string.Equals((string)rule.Name, rawName, StringComparison.OrdinalIgnoreCase)) duplicates++; } finally { ReleaseCom(rule); } }
                if (duplicates != 1) throw new AgentMessageException("AGENT_FIREWALL_AMBIGUOUS_NAME");
                AssertManagement(root, config); matched.Enabled = Boolean(p, "enabled");
            }
            else
            {
                dynamic rule = ruleObject = CreateCom("HNetCfg.FWRule"); rule.Name = Text(p, "name", 200); rule.Description = "ServerDesk native management"; rule.Grouping = "ServerDesk";
                rule.Protocol = Text(p, "protocol", 40) == "TCP" ? 6 : 17; rule.LocalPorts = Text(p, "port", 300); rule.RemoteAddresses = Text(p, "remoteAddress", 500).Replace("Any", "*", StringComparison.Ordinal);
                rule.Direction = Text(p, "direction", 40) == "Inbound" ? 1 : 2; rule.Action = Text(p, "action", 40) == "Allow" ? 1 : 0; rule.Enabled = true; rule.Profiles = int.MaxValue;
                AssertManagement(root, config); policy.Rules.Add(rule);
            }
        }
        finally { ReleaseCom(ruleObject); ReleaseCom(policyObject); }
    }
    private static void SetTask(JsonObject p)
    {
        object? serviceObject = null, folderObject = null, taskObject = null;
        try { dynamic service = serviceObject = CreateCom("Schedule.Service"); service.Connect(); dynamic folder = folderObject = service.GetFolder(Text(p, "path", 500)); dynamic task = taskObject = folder.GetTask(Text(p, "name", 256)); task.Enabled = Boolean(p, "enabled"); }
        finally { ReleaseCom(taskObject); ReleaseCom(folderObject); ReleaseCom(serviceObject); }
    }
    internal static object CreateCom(string progId) => Activator.CreateInstance(Type.GetTypeFromProgID(progId, true)!) ?? throw new AgentMessageException("AGENT_WINDOWS_COMPONENT_MISSING", ("component", progId));
    internal static string WqlString(string value) => value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("'", "\\'", StringComparison.Ordinal);
    internal static Dictionary<string, object?> SelectLocalFirewallRule(IEnumerable<Dictionary<string, object?>> rows, string id, bool localStoreContainsId)
    {
        var exact = rows.Where(x => string.Equals(Convert.ToString(x.GetValueOrDefault("InstanceID")), id, StringComparison.OrdinalIgnoreCase) && Convert.ToInt32(x.GetValueOrDefault("PolicyStoreSourceType")) is 0 or 1).ToArray();
        if (!localStoreContainsId || exact.Length != 1 || string.IsNullOrEmpty(Convert.ToString(exact[0].GetValueOrDefault("ElementName")))) throw new AgentMessageException("AGENT_FIREWALL_RULE_NOT_FOUND");
        return exact[0];
    }
    internal static void ReleaseCom(object? value) { if (value is not null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value); }
    internal static string PathOf(Dictionary<string, object?> row) => Convert.ToString(row.GetValueOrDefault("__PATH")) ?? throw new AgentMessageException("AGENT_WMI_PATH_MISSING");
    // failureCode names the operation; its message carries the Windows return value as {status}.
    internal static void Check(Dictionary<string, object?> output, string failureCode, bool allowReboot = false)
    {
        uint code = Convert.ToUInt32(output.GetValueOrDefault("ReturnValue")); if (code != 0 && !(allowReboot && code == 1)) throw new AgentMessageException(failureCode, ("status", code));
    }
    internal static ManagementScope Scope(string ns) => new(@"\\.\" + ns, new ConnectionOptions { EnablePrivileges = true, Timeout = TimeSpan.FromSeconds(45) });
    internal static void Put(string ns, string path, Dictionary<string, object?> properties)
    {
        using var instance = new ManagementObject(Scope(ns), new ManagementPath(path), new ObjectGetOptions { Timeout = TimeSpan.FromSeconds(45) });
        instance.Get(); foreach (var entry in properties) instance[entry.Key] = entry.Value;
        instance.Put(new PutOptions { Type = PutType.UpdateOnly, Timeout = TimeSpan.FromSeconds(45) });
    }
    internal static void Delete(string ns, string path) { using var instance = new ManagementObject(Scope(ns), new ManagementPath(path), null); instance.Delete(new DeleteOptions { Timeout = TimeSpan.FromSeconds(45) }); }
    internal static void Create(string ns, string className, Dictionary<string, object?> properties)
    {
        using var type = new ManagementClass(Scope(ns), new ManagementPath(className), null); using var instance = type.CreateInstance() ?? throw new AgentMessageException("AGENT_WINDOWS_INSTANCE_FAILED");
        foreach (var entry in properties) instance[entry.Key] = entry.Value; instance.Put(new PutOptions { Type = PutType.CreateOnly, Timeout = TimeSpan.FromSeconds(45) });
    }
}

internal static class NativeServiceManagement
{
    [StructLayout(LayoutKind.Sequential)] private struct Status { internal uint Type, State, Controls, ExitCode, SpecificExit, CheckPoint, WaitHint; }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenSCManager(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenService(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool StartService(IntPtr service, uint count, IntPtr arguments);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool ControlService(IntPtr service, uint control, out Status status);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatus(IntPtr service, out Status status);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ChangeServiceConfig(IntPtr service, uint type, uint startup, uint error, string? binary, string? group, IntPtr tag, string? dependencies, string? account, string? password, string? display);
    [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr service);
    internal static void Execute(string action, string name, string? startup, CancellationToken token)
    {
        IntPtr manager = OpenSCManager(null, null, 1); if (manager == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr service = IntPtr.Zero;
        try
        {
            uint access = 4 | (action == "start-service" ? 16U : action == "stop-service" ? 32U : action == "restart-service" ? 48U : 2U);
            service = OpenService(manager, name, access); if (service == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            token.ThrowIfCancellationRequested();
            if (action == "set-service-startup") { if (!ChangeServiceConfig(service, uint.MaxValue, startup == "Automatic" ? 2U : startup == "Manual" ? 3U : 4U, uint.MaxValue, null, null, IntPtr.Zero, null, null, null, null)) throw new Win32Exception(Marshal.GetLastWin32Error()); return; }
            if (!QueryServiceStatus(service, out var status)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (action is "stop-service" or "restart-service") { if (status.State is not 1 and not 3 && !ControlService(service, 1, out _)) throw new Win32Exception(Marshal.GetLastWin32Error()); Wait(service, 1, token); }
            if (action is "start-service" or "restart-service") { if (!StartService(service, 0, IntPtr.Zero) && Marshal.GetLastWin32Error() != 1056) throw new Win32Exception(Marshal.GetLastWin32Error()); Wait(service, 4, token); }
        }
        finally { if (service != IntPtr.Zero) CloseServiceHandle(service); CloseServiceHandle(manager); }
    }
    private static void Wait(IntPtr service, uint target, CancellationToken token)
    {
        var deadline = DateTime.UtcNow.AddSeconds(60);
        while (true) { token.ThrowIfCancellationRequested(); if (!QueryServiceStatus(service, out var status)) throw new Win32Exception(Marshal.GetLastWin32Error()); if (status.State == target) return; if (DateTime.UtcNow > deadline) throw new AgentMessageException("AGENT_SERVICE_TIMEOUT"); if (token.WaitHandle.WaitOne(200)) token.ThrowIfCancellationRequested(); }
    }
}
