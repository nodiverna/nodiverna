using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class NativeDesiredDriftTests
{
    internal static void Run()
    {
        Assert(DriftMonitor.Canonical(JsonNode.Parse("{\"z\":1,\"a\":{\"b\":2,\"a\":1}}")) == "{\"a\":{\"a\":1,\"b\":2},\"z\":1}", "Stable drift object hashes must not depend on property order.");
        Assert(DriftMonitor.Canonical(JsonNode.Parse("[2,1]")) != DriftMonitor.Canonical(JsonNode.Parse("[1,2]")), "Ordered resource data must retain array ordering.");
        NativeDesiredState.ValidateParameters(new JsonObject { ["Name"] = "Demo", ["Enabled"] = true, ["Port"] = 443, ["Ratio"] = 1.5 });
        Reject(() => NativeDesiredState.ValidateParameters(new JsonObject { ["outputpath"] = "C:\\elsewhere" }), "Compiler-controlled output path cannot be overridden through PowerShell's case-insensitive parameter binding.");
        Reject(() => NativeDesiredState.ValidateParameters(new JsonObject { ["ConfigurationData"] = "data" }), "Compiler configuration data cannot bypass the assigned configuration.");
        Reject(() => NativeDesiredState.ValidateParameters(new JsonObject { ["Invalid-Parameter"] = 1 }), "Invalid parameter identifiers must be rejected.");
        Reject(() => NativeDesiredState.ValidateParameters(new JsonObject { ["Name"] = new JsonObject() }), "Nested configuration parameters must be rejected.");
        Reject(() => NativeDesiredState.ValidateParameters(new JsonObject { ["Name"] = new string('x', 4097) }), "Configuration parameter strings must be bounded.");
        var tooMany = new JsonObject(); for (int index = 0; index < 31; index++) tooMany["P" + index] = index;
        Reject(() => NativeDesiredState.ValidateParameters(tooMany), "Configuration parameter count must be bounded.");
        var resources = new JsonArray();
        NativeDesiredState.AddDsc3Resources(JsonNode.Parse("[{\"name\":\"Group\",\"type\":\"Adapter\",\"result\":{\"results\":[{\"name\":\"File\",\"type\":\"File\",\"result\":{\"inDesiredState\":false,\"differingProperties\":[\"Contents\"]}},{\"name\":\"Registry\",\"type\":\"Registry\",\"result\":{\"actualState\":{\"_inDesiredState\":true}}}]}}]")!.AsArray(), resources);
        Assert(resources.Count == 2 && resources[0]!["inDesiredState"]!.GetValue<bool>() == false && resources[1]!["inDesiredState"]!.GetValue<bool>(), "Nested DSC adapters must report genuine resource compliance.");
        Assert(resources[0]!["differingProperties"]!.AsArray()[0]!.GetValue<string>() == "Contents", "DSC differing properties must be preserved.");
        var unknown = new JsonArray(); NativeDesiredState.AddDsc3Resources(JsonNode.Parse("[{\"name\":\"Unreported\",\"type\":\"Resource\",\"result\":{}}]")!.AsArray(), unknown);
        Assert(unknown[0]!["inDesiredState"] is null, "Missing compliance must never be fabricated as true.");
        Reject(() => NativeDesiredState.AddDsc3Resources(new JsonArray("malformed"), new JsonArray()), "Malformed DSC entries cannot silently disappear from compliance.");
        var oversized = new JsonArray(); for (int index = 0; index < 201; index++) oversized.Add(new JsonObject { ["name"] = "R" + index, ["type"] = "Resource", ["result"] = new JsonObject { ["inDesiredState"] = true } });
        Reject(() => NativeDesiredState.AddDsc3Resources(oversized, new JsonArray()), "Truncated DSC results must not become a partial compliance claim.");
        FirewallInventory();
    }

    private static void FirewallInventory()
    {
        static Dictionary<string, object?> Row(params (string Name, object? Value)[] values) => values.ToDictionary(value => value.Name, value => value.Value, StringComparer.OrdinalIgnoreCase);
        const string ns = @"\\HOST\root\StandardCimv2:";
        static string Rule(int id) => "MSFT_NetFirewallRule.InstanceID=\"rule-" + id + "\"";
        static string Port(int id) => "MSFT_NetProtocolPortFilter.InstanceID=\"port-" + id + "\"";
        static string Address(int id) => "MSFT_NetAddressFilter.InstanceID=\"address-" + id + "\"";
        var local = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        var rules = new List<Dictionary<string, object?>>(); var ports = new List<Dictionary<string, object?>>(); var addresses = new List<Dictionary<string, object?>>();
        var portLinks = new List<Dictionary<string, object?>>(); var addressLinks = new List<Dictionary<string, object?>>();
        for (int id = 0; id < 250; id++)
        {
            local["rule-" + id] = true;
            // Deliberately distinct identities and identical display labels:
            // only association references may connect these provider objects.
            rules.Add(Row(("InstanceID", "rule-" + id), ("ElementName", "Shared label"), ("Enabled", 1), ("Direction", 1), ("Action", id == 1 ? 3 : 2), ("PolicyStoreSourceType", 1), ("__PATH", ns + Rule(id))));
            ports.Add(Row(("Protocol", 6), ("LocalPort", id == 1 ? null : new[] { (4000 + id).ToString() }), ("__PATH", Port(id))));
            addresses.Add(Row(("RemoteAddress", new[] { "10.0.0." + id }), ("__PATH", ns + Address(id))));
            portLinks.Add(Row(("GroupComponent", Rule(id)), ("PartComponent", ns + Port(id))));
            addressLinks.Add(Row(("GroupComponent", @"root\StandardCimv2:" + Rule(id)), ("PartComponent", Address(id))));
        }
        int calls = 0;
        List<Dictionary<string, object?>> Query(string wql)
        {
            calls++; Assert(!wql.Contains("ASSOCIATORS", StringComparison.Ordinal), "Firewall inventory must not query associations per rule.");
            string className = wql[(wql.IndexOf(" FROM ", StringComparison.Ordinal) + 6)..];
            return className switch
            {
                "MSFT_NetFirewallRule" => rules,
                "MSFT_NetProtocolPortFilter" => ports,
                "MSFT_NetAddressFilter" => addresses,
                "MSFT_NetFirewallRuleFilterByProtocolPort" => portLinks,
                "MSFT_NetFirewallRuleFilterByAddress" => addressLinks,
                _ => throw new InvalidDataException("Unexpected firewall query fixture.")
            };
        }
        var inventory = NativeDriftInventory.Firewall(local, Query);
        Assert(calls == 5 && inventory.Count == 250, "Hundreds of firewall rules must require five provider queries, not two per rule.");
        var first = inventory.OfType<JsonObject>().Single(row => row["name"]!.GetValue<string>() == "rule-0");
        Assert(first["protocol"]!.GetValue<string>() == "6" && first["ports"]![0]!.GetValue<string>() == "4000" && first["remote"]![0]!.GetValue<string>() == "10.0.0.0", "Batched native filters must retain exact existing drift data.");
        var bypass = inventory.OfType<JsonObject>().Single(row => row["name"]!.GetValue<string>() == "rule-1");
        Assert(bypass["action"]!.GetValue<string>() == "AllowBypass" && bypass["ports"]!.AsArray().Count == 1 && bypass["ports"]![0] is null,
            "Bypass actions and genuinely inapplicable port sentinels must remain unchanged.");

        var removed = addressLinks[0]; addressLinks.RemoveAt(0);
        Reject(() => NativeDriftInventory.Firewall(local, Query), "Missing filter associations must fail the category, not become an empty/deleted baseline.");
        addressLinks.Insert(0, removed); addressLinks.Add(removed);
        Reject(() => NativeDriftInventory.Firewall(local, Query), "Ambiguous filter associations must fail closed.");
        addressLinks.RemoveAt(addressLinks.Count - 1);
        var duplicate = ports[0]; ports.Add(duplicate);
        Reject(() => NativeDriftInventory.Firewall(local, Query), "Duplicate filter identities must fail closed."); ports.RemoveAt(ports.Count - 1);
        rules[0]["PolicyStoreSourceType"] = 2;
        bool refused = false; try { NativeDriftInventory.Firewall(local, Query); } catch (InvalidOperationException) { refused = true; }
        Assert(refused, "Group Policy firewall rows cannot replace local persistent rules."); rules[0]["PolicyStoreSourceType"] = 1;
        local["rule-0"] = false; refused = false; try { NativeDriftInventory.Firewall(local, Query); } catch (InvalidOperationException) { refused = true; }
        Assert(refused, "A non-string/missing local registry rule cannot become a valid inventory row.");

        calls = 0; Assert(NativeDriftInventory.Firewall(new Dictionary<string, bool>(), Query).Count == 0 && calls == 0,
            "An empty persistent firewall store requires no provider scans.");
        const string quoted = "MSFT_NetFirewallRule.InstanceID=\"rule:with\\\\escaped\\\"key\"";
        Assert(NativeDriftInventory.FirewallObjectPath(ns + quoted, "MSFT_NetFirewallRule") == quoted && NativeDriftInventory.FirewallObjectPath(quoted, "MSFT_NetFirewallRule") == quoted,
            "WMI path normalization must preserve colons and escaped keys.");
        Reject(() => NativeDriftInventory.FirewallObjectPath("OtherClass.InstanceID=\"MSFT_NetFirewallRule.name\"", "MSFT_NetFirewallRule"), "A class name inside a quoted key cannot be mistaken for the object class.");
    }
    private static void Assert(bool condition, string message) { if (!condition) throw new InvalidDataException(message); }
    private static void Reject(Action action, string message) { try { action(); } catch (InvalidDataException) { return; } catch (AgentMessageException) { return; } throw new InvalidDataException(message); }
}
