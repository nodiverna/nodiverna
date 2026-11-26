using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// A PowerShell script that a user ran from the device assistant (4.17.0,
// docs/ai-assistant.md). The portal queues it only for a user with the terminal
// right, with fresh MFA and after a confirmation. The agent runs it as SYSTEM
// only in Management mode, through the embedded script host of the runbooks,
// with a time limit of 10 to 600 seconds and no parameters. The result keeps
// at most 32 KiB of output and 8 KiB of stderr.
internal static class AssistantPowerShell
{
    internal const string Kind = "assistant-powershell";
    internal const int MaxScriptChars = 8000, MinTimeoutSeconds = 10, MaxTimeoutSeconds = 600, DefaultTimeoutSeconds = 120, MaxOutputChars = 32768, MaxErrorChars = 8192;

    /// <summary>The script and its time limit, after the mode check; otherwise an AgentMessageException.</summary>
    internal static (string Script, int TimeoutSeconds) Parse(JsonObject parameters, string? mode)
    {
        if (mode != "Management") throw new AgentMessageException("AGENT_ASSISTANT_MANAGEMENT_REQUIRED");
        foreach (var entry in parameters) if (entry.Key is not "script" and not "timeoutSeconds") throw new AgentMessageException("AGENT_UNKNOWN_PARAMETER", ("name", entry.Key));
        if (parameters["script"] is not JsonValue scriptValue || !scriptValue.TryGetValue<string>(out var script)) throw new AgentMessageException("AGENT_TEXT_MISSING", ("name", "script"));
        // 1 to 8,000 characters with a visible one; no control characters except newline, carriage return and tab.
        if (script.Length > MaxScriptChars || string.IsNullOrWhiteSpace(script) || script.Any(c => char.IsControl(c) && c is not '\n' and not '\r' and not '\t')) throw new AgentMessageException("AGENT_INVALID_TEXT_PARAMETER", ("name", "script"));
        int seconds = DefaultTimeoutSeconds;
        if (parameters["timeoutSeconds"] is JsonNode timeout && (timeout is not JsonValue number || !number.TryGetValue<int>(out seconds))) throw new AgentMessageException("AGENT_INVALID_NUMBER", ("name", "timeoutSeconds"));
        if (seconds < MinTimeoutSeconds || seconds > MaxTimeoutSeconds) throw new AgentMessageException("AGENT_NUMBER_OUT_OF_RANGE", ("name", "timeoutSeconds"));
        return (script, seconds);
    }

    /// <summary>The job result: output (32 KiB), stderr (8 KiB), the exit code and whether anything was cut.</summary>
    internal static JsonObject Result(string id, (int ExitCode, string Output, string Error, bool Truncated) execution)
    {
        bool truncated = execution.Truncated || execution.Output.Length > MaxOutputChars || execution.Error.Length > MaxErrorChars;
        string output = execution.Output[..Math.Min(MaxOutputChars, execution.Output.Length)], error = execution.Error[..Math.Min(MaxErrorChars, execution.Error.Length)];
        var result = new JsonObject { ["id"] = id, ["ok"] = execution.ExitCode == 0, ["data"] = new JsonObject { ["output"] = output, ["stderr"] = error, ["exitCode"] = execution.ExitCode, ["truncated"] = truncated } };
        if (execution.ExitCode == 0) return AgentMessages.Write(result, "AGENT_ASSISTANT_SCRIPT_COMPLETED");
        string detail = string.IsNullOrWhiteSpace(error) ? "exit code " + execution.ExitCode : error.Trim();
        return AgentMessages.Write(result, "AGENT_ASSISTANT_SCRIPT_FAILED", ("detail", detail));
    }

    /// <summary>Runs one job in the given agent mode.</summary>
    internal static async Task<JsonObject> RunAsync(JsonObject job, string? mode, CancellationToken token)
    {
        string id = job["id"]!.GetValue<string>();
        var (script, seconds) = Parse(job["parameters"] as JsonObject ?? new JsonObject(), mode);
        var execution = await PowerShellRunner.RunUserScriptAsync(script, new JsonObject(), TimeSpan.FromSeconds(seconds), token);
        return Result(id, execution);
    }
}
