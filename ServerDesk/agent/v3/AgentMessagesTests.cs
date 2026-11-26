using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ServerDesk.Agent;

internal static class AgentMessagesTests
{
    internal static void Run()
    {
        static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Agent message regression: " + message); }
        Check(AgentMessages.Templates.Count > 0, "the registry has entries");
        foreach (var (code, (one, other)) in AgentMessages.Templates)
        {
            Check(Regex.IsMatch(code, "^(AGENT|PLUGIN)_[A-Z0-9_]{1,60}$"), "code format " + code);
            var names = AgentMessages.Placeholders(one);
            Check(names.Count <= AgentMessages.MaxArgs, "at most eight arguments for " + code);
            Check(names.SequenceEqual(AgentMessages.Placeholders(other)), "both plural forms of " + code + " use the same arguments");
            Check(names.All(name => Regex.IsMatch(name, "^[a-z][A-Za-z0-9]{0,31}$")), "argument names of " + code);
            Check(one == other || names.Contains("count"), "a plural entry " + code + " uses {count}");
        }

        var result = AgentMessages.Write(new JsonObject { ["id"] = "x", ["ok"] = true }, "AGENT_TCP_CONNECTED", ("host", "srv.example.test"), ("port", 443));
        Check(result["code"]?.GetValue<string>() == "AGENT_TCP_CONNECTED" && result["message"]?.GetValue<string>() == "TCP connection succeeded: srv.example.test:443", "the English fallback is the filled template");
        Check(result["args"]?["host"]?.GetValue<string>() == "srv.example.test" && result["args"]?["port"]?.GetValue<string>() == "443", "arguments are strings");

        // A plugin code passes through: the registered template when every argument is there, else the plugin's text.
        var plugin = AgentMessages.WritePlugin(new JsonObject(), "PLUGIN_DHCP_READ_COMPLETED", new Dictionary<string, string> { ["scopes"] = "3", ["leases"] = "20" }, "ignored");
        Check(plugin["code"]?.GetValue<string>() == "PLUGIN_DHCP_READ_COMPLETED" && plugin["message"]?.GetValue<string>() == "The DHCP server was read: 3 scopes, 20 leases." && plugin["args"]?["leases"]?.GetValue<string>() == "20", "a known plugin code gets its template");
        var unknown = AgentMessages.WritePlugin(new JsonObject(), "PLUGIN_DNS_NEWER", new Dictionary<string, string>(), "A newer plugin" + (char)7 + " text.");
        Check(unknown["code"]?.GetValue<string>() == "PLUGIN_DNS_NEWER" && unknown["message"]?.GetValue<string>() == "A newer plugin  text." && unknown["args"] is null, "an unknown plugin code keeps the plugin's English text");
        bool foreign = false; try { AgentMessages.WritePlugin(new JsonObject(), "AGENT_UPDATE_BUSY", new Dictionary<string, string>(), "x"); } catch (AgentMessageException e) { foreign = e.Code == "AGENT_PLUGIN_OUTPUT_INVALID"; }
        Check(foreign, "a plugin cannot send an agent code");

        var plural = AgentMessages.Of("AGENT_UPDATES_INSTALLED", ("count", 1));
        Check(plural.Text == "1 update installed. Restart the device to finish. The agent did not restart it.", "count 1 selects the singular form");
        Check(AgentMessages.Of("AGENT_UPDATES_INSTALLED", ("count", 3)).Text.StartsWith("3 updates installed.", StringComparison.Ordinal), "other counts select the plural form");

        var masked = AgentMessages.Write(new JsonObject(), AgentMessages.Of("AGENT_WORKGROUP_FAILED", ("detail", "failed for Secret-Value-1")), ["Secret-Value-1"]);
        Check(!masked.ToJsonString().Contains("Secret-Value-1", StringComparison.Ordinal) && masked["args"]?["detail"]?.GetValue<string>() == "failed for [redacted]", "masking covers arguments and message");

        var longValue = AgentMessages.Of("AGENT_RUNBOOK_FAILED", ("detail", new string('x', 5000)));
        Check(longValue.Args["detail"].Length == AgentMessages.MaxArgValue, "argument values are cut at 1000 characters");
        bool refused = false; try { AgentMessages.Of("AGENT_TCP_CONNECTED", ("a1", 1), ("a2", 2), ("a3", 3), ("a4", 4), ("a5", 5), ("a6", 6), ("a7", 7), ("a8", 8), ("a9", 9)); } catch (InvalidOperationException) { refused = true; }
        Check(refused, "more than eight arguments are refused");
        refused = false; try { AgentMessages.Of("AGENT_NOT_REGISTERED"); } catch (InvalidOperationException) { refused = true; }
        Check(refused, "an unregistered code is refused");

        var coded = AgentMessages.Fail(new JsonObject { ["code"] = "stale" }, new AgentMessageException("AGENT_FEATURE_NOT_FOUND"));
        Check(coded["code"]?.GetValue<string>() == "AGENT_FEATURE_NOT_FOUND" && coded["message"]?.GetValue<string>() == "Role or feature not found." && coded["args"] is null, "an agent exception keeps its code");
        var raw = AgentMessages.Fail(new JsonObject { ["code"] = "stale", ["args"] = new JsonObject() }, new System.ComponentModel.Win32Exception(5, "Access is denied."));
        Check(raw["code"] is null && raw["args"] is null && raw["message"]?.GetValue<string>() == "Access is denied.", "an OS exception text passes through without a code");
        var cancelled = AgentMessages.Fail(new JsonObject(), new OperationCanceledException());
        Check(cancelled["code"]?.GetValue<string>() == "AGENT_JOB_CANCELLED", "cancellation has its own code");
        var cut = AgentMessages.Fail(new JsonObject(), new IOException(new string('y', 5000)), limit: 2000);
        Check(cut["message"]!.GetValue<string>().Length == 2000, "a raw text keeps the caller's length limit");
        Console.WriteLine("Agent message tests passed: unique codes, at most eight arguments, plural forms, English fallback, masked arguments, length limits and raw OS text without a code.");
    }
}
