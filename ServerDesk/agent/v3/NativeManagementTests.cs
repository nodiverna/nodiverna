using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class NativeManagementTests
{
    internal static void Run()
    {
        static JsonObject P(string json) => JsonNode.Parse(json)!.AsObject();
        static void Assert(bool condition, string message) { if (!condition) throw new InvalidOperationException("Native management regression: " + message); }
        static void Refused(Action action, string message) { try { action(); } catch (InvalidDataException) { return; } catch (InvalidOperationException) { return; } throw new InvalidOperationException("Native management regression: accepted " + message); }
        var valid = new Dictionary<string, string>
        {
            ["refresh"]="{}", ["scan-updates"]="{}", ["test-connection"]="{\"host\":\"srv.example.test\",\"port\":443}",
            ["start-service"]="{\"name\":\"Spooler\"}", ["stop-service"]="{\"name\":\"Spooler\"}", ["restart-service"]="{\"name\":\"Spooler\"}", ["set-service-startup"]="{\"name\":\"Spooler\",\"startup\":\"Manual\"}",
            ["install-feature"]="{\"name\":\"Web-Server\",\"includeManagementTools\":true}", ["remove-feature"]="{\"name\":\"Web-Server\",\"includeManagementTools\":false}",
            ["set-network"]="{\"interfaceIndex\":3,\"dhcp\":false,\"address\":\"10.20.30.40\",\"prefixLength\":24,\"gateway\":\"10.20.30.1\"}", ["set-dns"]="{\"interfaceIndex\":3,\"automatic\":false,\"servers\":[\"10.20.30.1\",\"2001:db8::1\"]}",
            ["join-domain"]="{\"domain\":\"example.test\",\"ouPath\":\"OU=Servers,DC=example,DC=test\"}", ["leave-domain"]="{\"workgroup\":\"WORKGROUP\"}", ["rename-computer"]="{\"name\":\"SRV-2025\"}",
            ["set-pagefile"]="{\"automatic\":false,\"drive\":\"D:\",\"initialMb\":4096,\"maximumMb\":8192}", ["create-local-user"]="{\"name\":\"test-user\",\"fullName\":\"Test User\",\"description\":\"Local test user\",\"passwordNeverExpires\":false}",
            ["set-local-user"]="{\"name\":\"test-user\",\"fullName\":\"Test User\",\"description\":\"Local test user\",\"enabled\":true,\"passwordNeverExpires\":false}", ["reset-local-password"]="{\"name\":\"test-user\"}", ["delete-local-user"]="{\"name\":\"test-user\"}",
            ["local-group-add"]="{\"name\":\"test-user\",\"groupSid\":\"S-1-5-32-544\"}", ["local-group-remove"]="{\"name\":\"test-user\",\"groupSid\":\"S-1-5-32-545\"}",
            ["restart-computer"]="{\"delaySeconds\":60,\"reason\":\"Planned update\"}", ["shutdown-computer"]="{\"delaySeconds\":300,\"reason\":\"Planned maintenance\"}",
            ["install-updates"]="{\"updateIds\":[\"12345678-1234-1234-1234-123456789abc\"]}", ["set-firewall-rule"]="{\"name\":\"ServerDesk-a1\",\"enabled\":false}",
            ["add-firewall-rule"]="{\"name\":\"Allow service\",\"direction\":\"Inbound\",\"action\":\"Allow\",\"protocol\":\"TCP\",\"port\":\"443,8000-8010\",\"remoteAddress\":\"10.20.0.0/16,2001:db8::/32,LocalSubnet\"}", ["set-task"]="{\"name\":\"Daily Cleanup\",\"path\":\"\\\\Operations\\\\\",\"enabled\":true}"
        };
        valid["set-rdp"] = "{\"enabled\":true}";
        valid["schedule-power"] = new JsonObject { ["operation"] = "shutdown", ["scheduledAt"] = NativePowerSchedule.CanonicalUtc(DateTimeOffset.UtcNow.AddHours(1)), ["reason"] = "Calendar maintenance" }.ToJsonString();
        valid["cancel-power-schedule"] = new JsonObject { ["scheduleId"] = Guid.NewGuid().ToString() }.ToJsonString();
        Assert(valid.Count == 30, "all built-in action fixtures present");
        foreach (var fixture in valid) NativeManagement.ValidateParameters(fixture.Key, P(fixture.Value));
        Refused(() => NativeManagement.ValidateParameters("not-an-action", new()), "unknown action");
        foreach (var action in new[] { "stop-service", "restart-service", "set-service-startup" }) Refused(() => NativeManagement.ValidateParameters(action, P("{\"name\":\"serverdeskagent\",\"startup\":\"Disabled\"}")), "agent self-stop");
        foreach (var name in new[] { "Spool*", "?", "Spool[er]", "Spooler\n" }) Refused(() => NativeManagement.ValidateParameters("start-service", new() { ["name"] = name }), "service wildcard/control character");
        foreach (JsonNode? number in new JsonNode?[] { JsonValue.Create("443"), JsonValue.Create(true), JsonValue.Create(443.5), JsonValue.Create(0), JsonValue.Create(65536), null }) Refused(() => NativeManagement.ValidateParameters("test-connection", new() { ["host"] = "localhost", ["port"] = number?.DeepClone() }), "noninteger TCP port");
        NativeManagement.ValidateParameters("test-connection", new() { ["host"] = "localhost", ["port"] = 443 });
        foreach (string host in new[] { "a; shutdown", "$(command)", "a/b", "a\r\n" }) Refused(() => NativeManagement.ValidateParameters("test-connection", new() { ["host"] = host, ["port"] = 443 }), "network target syntax");
        foreach (string address in new[] { "10.20.30.0", "10.20.30.255", "224.0.0.1", "0.0.0.0", "10.20.30", "0x0a141e28" }) Refused(() => NativeManagement.ValidateParameters("set-network", new() { ["interfaceIndex"] = 3, ["dhcp"] = false, ["address"] = address, ["prefixLength"] = 24 }), "nonunicast/malformed static address");
        Refused(() => NativeManagement.ValidateParameters("set-network", P("{\"interfaceIndex\":3,\"dhcp\":false,\"address\":\"10.20.30.40\",\"prefixLength\":24,\"gateway\":\"10.20.31.1\"}")), "gateway outside subnet");
        Refused(() => NativeManagement.ValidateParameters("set-network", P("{\"interfaceIndex\":3,\"dhcp\":false,\"address\":\"10.20.30.40\",\"prefixLength\":24,\"gateway\":\"10.20.30.40\"}")), "self gateway");
        NativeManagement.ValidateParameters("set-network", P("{\"interfaceIndex\":3,\"dhcp\":true}"));
        NativeManagement.ValidateParameters("set-network", P("{\"interfaceIndex\":3,\"dhcp\":false,\"address\":\"10.20.30.40\",\"prefixLength\":31,\"gateway\":\"10.20.30.41\"}"));
        Refused(() => NativeManagement.ValidateParameters("set-dns", P("{\"interfaceIndex\":3,\"automatic\":false,\"servers\":[]}")), "empty DNS list");
        NativeManagement.ValidateParameters("set-dns", P("{\"interfaceIndex\":3,\"automatic\":true}"));
        Refused(() => NativeManagement.ValidateParameters("set-pagefile", P("{\"automatic\":false,\"drive\":\"C:\",\"initialMb\":8192,\"maximumMb\":4096}")), "reversed pagefile sizes");
        Refused(() => NativeManagement.ValidateParameters("rename-computer", P("{\"name\":\"12345\"}")), "allnumeric computer name");
        foreach (string name in new[] { "Domain\\User", "user@domain", "a:b", "a*", ". .", "a;bad" }) Refused(() => NativeManagement.ValidateParameters("delete-local-user", new() { ["name"] = name }), "nonlocal username");
        foreach (string ports in new[] { "0", "65536", "5000-1000", "443;80", "*", "80,,443" }) Refused(() => { var p = P(valid["add-firewall-rule"]); p["port"] = ports; NativeManagement.ValidateParameters("add-firewall-rule", p); }, "invalid firewall ports");
        foreach (string remote in new[] { "10.0.0.1/33", "2001:db8::1/129", "Any,", "host.test", "10.0.0.1/24/32" }) Refused(() => { var p = P(valid["add-firewall-rule"]); p["remoteAddress"] = remote; NativeManagement.ValidateParameters("add-firewall-rule", p); }, "invalid firewall scope");
        Refused(() => NativeManagement.ValidateParameters("set-task", P("{\"name\":\"ServerDesk Update Recovery\",\"path\":\"\\\\\",\"enabled\":false}")), "self recovery task");
        Refused(() => NativeManagement.ValidateParameters("set-task", P("{\"name\":\"Test\",\"path\":\"relative\",\"enabled\":true}")), "relative task path");
        foreach (var fixture in valid.Where(x => x.Key is not "refresh" and not "scan-updates" and not "test-connection"))
        {
            var result = NativeManagement.ExecuteAsync(Path.Combine(Path.GetTempPath(), "ServerDeskManagementSelfTest-" + Guid.NewGuid().ToString("N")), new() { ["mode"] = "ReadOnly" }, new() { ["id"] = Guid.NewGuid().ToString(), ["action"] = fixture.Key, ["parameters"] = P(fixture.Value) }, CancellationToken.None).GetAwaiter().GetResult();
            Assert(result["ok"]?.GetValue<bool>() == false && result["message"]?.GetValue<string>().Contains("ReadOnly", StringComparison.Ordinal) == true, "local ReadOnly boundary for " + fixture.Key);
        }
        Assert(NativeFeatures.DismInstalled(4) && NativeFeatures.DismInstalled(1) && !NativeFeatures.DismInstalled(5) && !NativeFeatures.DismInstalled(3), "DISM installed/pending enum is accurate");
        Assert(NativeManagement.DhcpValue(true) == 1 && NativeManagement.DhcpValue(false) == 0, "MSFT_NetIPInterface DHCP native enum");
        var rule = new Dictionary<string, object?> { ["InstanceID"] = "exact-rule-id", ["ElementName"] = "@FirewallAPI.dll,-1", ["DisplayName"] = "Localized caption", ["PolicyStoreSourceType"] = 0 };
        Assert(ReferenceEquals(rule, NativeManagement.SelectLocalFirewallRule([rule], "exact-rule-id", true)), "untraced local firewall rule resolves stable identity/raw COM name");
        Refused(() => NativeManagement.SelectLocalFirewallRule([rule], "exact-rule-id", false), "effective rule without local store identity");
        Refused(() => NativeManagement.SelectLocalFirewallRule([rule, rule], "exact-rule-id", true), "duplicate firewall identity");
        Refused(() => NativeManagement.SelectLocalFirewallRule([rule], "different-id", true), "wrong firewall identity");
        rule["PolicyStoreSourceType"] = 2; Refused(() => NativeManagement.SelectLocalFirewallRule([rule], "exact-rule-id", true), "GPO firewall rule");
        var privilege = typeof(NativeAccounts).GetNestedType("TokenPrivilege", System.Reflection.BindingFlags.NonPublic)!;
        Assert(Marshal.SizeOf(privilege) == 16 && Marshal.OffsetOf(privilege, "Luid").ToInt32() == 4 && Marshal.OffsetOf(privilege, "Attributes").ToInt32() == 12, "shutdown TOKEN_PRIVILEGES ABI");
        Console.WriteLine("PASS native management: all 28 built-in actions, typed input/subnet/port validation, local ReadOnly boundary, protected agent/task, firewall identity/GPO isolation, DISM enum and shutdown privilege ABI.");
    }
}
