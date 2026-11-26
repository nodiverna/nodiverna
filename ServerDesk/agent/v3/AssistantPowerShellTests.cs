using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// Self-tests of the assistant PowerShell job (AssistantPowerShell.cs, 4.17.0):
// the mode check, the parameter and timeout bounds, and the output caps. They
// run without PowerShell.
internal static class AssistantPowerShellTests
{
    internal static void Run()
    {
        static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Assistant PowerShell regression: " + message); }
        static string? CodeOf(Action action) { try { action(); return null; } catch (AgentMessageException e) { return e.Code; } }
        static JsonObject Parameters(JsonNode? script, JsonNode? timeout = null)
        {
            var parameters = new JsonObject { ["script"] = script };
            if (timeout is not null) parameters["timeoutSeconds"] = timeout;
            return parameters;
        }

        // The mode: only Management runs a script, before anything else is read.
        Check(CodeOf(() => AssistantPowerShell.Parse(Parameters("Get-Date"), "ReadOnly")) == "AGENT_ASSISTANT_MANAGEMENT_REQUIRED", "ReadOnly mode ran a script");
        Check(CodeOf(() => AssistantPowerShell.Parse(Parameters("Get-Date"), null)) == "AGENT_ASSISTANT_MANAGEMENT_REQUIRED", "an unknown mode ran a script");
        Check(!JobRunner.AllowedInReadOnly(AssistantPowerShell.Kind) && !JobRunner.ReadActions.Contains(AssistantPowerShell.Kind), "the job counts as a read");

        // The timeout: 120 s by default, 10 to 600 s, whole seconds.
        Check(AssistantPowerShell.Parse(Parameters("Get-Date"), "Management") == ("Get-Date", 120), "the default timeout is not 120 s");
        Check(AssistantPowerShell.Parse(Parameters("Get-Date", 10), "Management").TimeoutSeconds == 10 && AssistantPowerShell.Parse(Parameters("Get-Date", 600), "Management").TimeoutSeconds == 600, "the bounds 10 and 600 s were refused");
        foreach (int seconds in new[] { 9, 601, 0, -1, 3600 }) Check(CodeOf(() => AssistantPowerShell.Parse(Parameters("Get-Date", seconds), "Management")) == "AGENT_NUMBER_OUT_OF_RANGE", "the timeout " + seconds + " s was accepted");
        Check(CodeOf(() => AssistantPowerShell.Parse(Parameters("Get-Date", "60"), "Management")) == "AGENT_INVALID_NUMBER" && CodeOf(() => AssistantPowerShell.Parse(Parameters("Get-Date", 1.5), "Management")) == "AGENT_INVALID_NUMBER", "a timeout that is no whole number was accepted");

        // The script: 1 to 8,000 characters, newline, carriage return and tab only as control characters, no other parameter.
        Check(AssistantPowerShell.Parse(Parameters("Get-Service\r\n\tSpooler"), "Management").Script == "Get-Service\r\n\tSpooler", "newline, carriage return and tab were refused");
        Check(AssistantPowerShell.Parse(Parameters(new string('x', 8000)), "Management").Script.Length == 8000, "8,000 characters were refused");
        foreach (string bad in new[] { new string('x', 8001), "", "  \n ", "Get-Date\u0007", "Get-Date\u0000" }) Check(CodeOf(() => AssistantPowerShell.Parse(Parameters(bad), "Management")) == "AGENT_INVALID_TEXT_PARAMETER", "an invalid script was accepted");
        Check(CodeOf(() => AssistantPowerShell.Parse(Parameters(null), "Management")) == "AGENT_TEXT_MISSING" && CodeOf(() => AssistantPowerShell.Parse(Parameters(42), "Management")) == "AGENT_TEXT_MISSING", "a missing script was accepted");
        var extra = Parameters("Get-Date"); extra["parameters"] = new JsonObject();
        Check(CodeOf(() => AssistantPowerShell.Parse(extra, "Management")) == "AGENT_UNKNOWN_PARAMETER", "another parameter was accepted");

        // The caps: 32 KiB of output and 8 KiB of stderr, truncated set, the codes by exit code.
        var big = AssistantPowerShell.Result("id", (0, new string('o', 40000), new string('e', 10000), false));
        var data = big["data"]!.AsObject();
        Check(data["output"]!.GetValue<string>().Length == 32768 && data["stderr"]!.GetValue<string>().Length == 8192 && data["truncated"]!.GetValue<bool>(), "the output caps do not hold");
        Check(big["ok"]!.GetValue<bool>() && big["code"]!.GetValue<string>() == "AGENT_ASSISTANT_SCRIPT_COMPLETED" && data["exitCode"]!.GetValue<int>() == 0, "exit code 0 is no success");
        var small = AssistantPowerShell.Result("id", (0, "done", "", false))["data"]!.AsObject();
        Check(small["output"]!.GetValue<string>() == "done" && !small["truncated"]!.GetValue<bool>(), "a short output was cut");
        Check(AssistantPowerShell.Result("id", (0, "x", "", true))["data"]!["truncated"]!.GetValue<bool>(), "the host's truncation got lost");
        var failed = AssistantPowerShell.Result("id", (1, "", "Access is denied.", false));
        Check(!failed["ok"]!.GetValue<bool>() && failed["code"]!.GetValue<string>() == "AGENT_ASSISTANT_SCRIPT_FAILED" && failed["args"]!["detail"]!.GetValue<string>() == "Access is denied.", "a failure has no detail");
        Check(AssistantPowerShell.Result("id", (3, "", " ", false))["args"]!["detail"]!.GetValue<string>() == "exit code 3", "a failure without stderr has no exit code");
    }
}
