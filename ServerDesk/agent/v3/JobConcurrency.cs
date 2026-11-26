using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ServerDesk.Agent;

/// <summary>
/// How a job runs next to others (4.21.0, capability parallel-jobs): Parallel changes nothing on the device and runs next
/// to other parallel jobs and next to one exclusive job; Exclusive changes the device, one at a time; Sole needs the device alone.
/// </summary>
internal enum JobMode { Parallel, Exclusive, Sole }

/// <summary>The class of one job: its mode and its group (at most one running job per group, whatever the mode).</summary>
internal readonly record struct JobClass(JobMode Mode, string? Group);

/// <summary>
/// The concurrency table of every job kind. It mirrors lib/server/devices/jobs/concurrency.ts of the portal, which claims by it;
/// tests/agent/agent-parallel-jobs-source.mjs compares both. The JobRunner checks it again before a job starts (defense in depth).
/// Keep one entry per line in the form ["kind"] = new(JobMode.X, group).
/// </summary>
internal static class JobConcurrency
{
    internal const string Capability = "parallel-jobs";
    internal const int MaxRunning = 4;
    private static readonly JobClass SoleClass = new(JobMode.Sole, null);

    // Every kind with a fixed class. runbook-step and plugin-job depend on their parameters.
    internal static readonly IReadOnlyDictionary<string, JobClass> Kinds = new Dictionary<string, JobClass>(StringComparer.Ordinal)
    {
        // Management operations.
        ["refresh"] = new(JobMode.Parallel, "inventory"),
        ["scan-updates"] = new(JobMode.Parallel, "windows-update"),
        ["test-connection"] = new(JobMode.Parallel, null),
        ["start-service"] = new(JobMode.Exclusive, null),
        ["stop-service"] = new(JobMode.Exclusive, null),
        ["restart-service"] = new(JobMode.Exclusive, null),
        ["set-service-startup"] = new(JobMode.Exclusive, null),
        ["install-feature"] = new(JobMode.Exclusive, null),
        ["remove-feature"] = new(JobMode.Exclusive, null),
        ["set-network"] = new(JobMode.Exclusive, null),
        ["set-dns"] = new(JobMode.Exclusive, null),
        ["set-rdp"] = new(JobMode.Exclusive, null),
        ["set-pagefile"] = new(JobMode.Exclusive, null),
        ["set-task"] = new(JobMode.Exclusive, null),
        ["join-domain"] = new(JobMode.Exclusive, null),
        ["leave-domain"] = new(JobMode.Exclusive, null),
        ["rename-computer"] = new(JobMode.Exclusive, null),
        ["create-local-user"] = new(JobMode.Exclusive, null),
        ["set-local-user"] = new(JobMode.Exclusive, null),
        ["reset-local-password"] = new(JobMode.Exclusive, null),
        ["delete-local-user"] = new(JobMode.Exclusive, null),
        ["local-group-add"] = new(JobMode.Exclusive, null),
        ["local-group-remove"] = new(JobMode.Exclusive, null),
        ["set-firewall-rule"] = new(JobMode.Exclusive, null),
        ["add-firewall-rule"] = new(JobMode.Exclusive, null),
        ["schedule-power"] = new(JobMode.Exclusive, null),
        ["cancel-power-schedule"] = new(JobMode.Exclusive, null),
        ["restart-computer"] = new(JobMode.Sole, null),
        ["shutdown-computer"] = new(JobMode.Sole, null),
        ["install-updates"] = new(JobMode.Exclusive, "windows-update"),
        ["install-gpu-driver"] = new(JobMode.Exclusive, null),
        // Microsoft Defender: one Defender job at a time.
        ["defender-quick-scan"] = new(JobMode.Parallel, "defender"),
        ["defender-full-scan"] = new(JobMode.Parallel, "defender"),
        ["defender-update-signatures"] = new(JobMode.Exclusive, "defender"),
        ["defender-clean-detections"] = new(JobMode.Exclusive, "defender"),
        // Files.
        ["list-files"] = new(JobMode.Parallel, null),
        ["create-directory"] = new(JobMode.Exclusive, null),
        ["rename-file"] = new(JobMode.Exclusive, null),
        ["delete-file"] = new(JobMode.Exclusive, null),
        // Storage: no disk read during a disk change.
        ["storage-inspect"] = new(JobMode.Parallel, "storage"),
        ["storage-initialize"] = new(JobMode.Exclusive, "storage"),
        ["storage-set-disk"] = new(JobMode.Exclusive, "storage"),
        ["storage-new-volume"] = new(JobMode.Exclusive, "storage"),
        ["storage-resize"] = new(JobMode.Exclusive, "storage"),
        ["storage-drive-letter"] = new(JobMode.Exclusive, "storage"),
        ["storage-format"] = new(JobMode.Exclusive, "storage"),
        ["storage-delete-partition"] = new(JobMode.Exclusive, "storage"),
        // Desired State: the Local Configuration Manager runs one operation at a time.
        ["desired-state-test"] = new(JobMode.Exclusive, null),
        ["desired-state-apply"] = new(JobMode.Exclusive, null),
        // Diagnostics.
        ["list-processes"] = new(JobMode.Parallel, null),
        ["list-sessions"] = new(JobMode.Parallel, null),
        ["list-connections"] = new(JobMode.Parallel, null),
        ["network-diagnostics"] = new(JobMode.Parallel, null),
        ["query-events"] = new(JobMode.Parallel, null),
        ["export-events"] = new(JobMode.Parallel, null),
        ["support-bundle"] = new(JobMode.Parallel, null),
        ["kill-process"] = new(JobMode.Exclusive, null),
        ["message-session"] = new(JobMode.Exclusive, null),
        ["disconnect-session"] = new(JobMode.Exclusive, null),
        ["logoff-session"] = new(JobMode.Exclusive, null),
        // Scripts, the AD sign-in, plugin installation and the agent itself.
        ["assistant-powershell"] = new(JobMode.Exclusive, null),
        ["ad-sign-in"] = new(JobMode.Parallel, null),
        ["plugin-install"] = new(JobMode.Sole, null),
        ["plugin-remove"] = new(JobMode.Sole, null),
        ["agent-update"] = new(JobMode.Sole, null),
        ["agent-uninstall"] = new(JobMode.Sole, null),
    };

    // plugin-job by its operation: reads are parallel, changes exclusive, each in the group plugin:<plugin>.
    // An operation that is missing here, or a job whose plugin differs from the operation's, is sole.
    internal static readonly IReadOnlyDictionary<string, JobClass> PluginOperations = new Dictionary<string, JobClass>(StringComparer.Ordinal)
    {
        ["dhcp-read"] = new(JobMode.Parallel, "plugin:dhcp"),
        ["dhcp-scope-create"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-scope-edit"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-scope-activate"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-scope-deactivate"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-scope-delete"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-superscope-create"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-superscope-edit"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-superscope-activate"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-superscope-deactivate"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-superscope-delete"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-exclusion-add"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-exclusion-remove"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-reservation-add"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-reservation-edit"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-reservation-remove"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-lease-delete"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-option-set"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-option-remove"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-policy-create"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-policy-edit"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-policy-delete"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-failover-create"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-failover-edit"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-failover-remove"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dhcp-scope-apply"] = new(JobMode.Exclusive, "plugin:dhcp"),
        ["dns-read"] = new(JobMode.Parallel, "plugin:dns"),
        ["dns-zone-read"] = new(JobMode.Parallel, "plugin:dns"),
        ["dns-zone-create"] = new(JobMode.Exclusive, "plugin:dns"),
        ["dns-zone-edit"] = new(JobMode.Exclusive, "plugin:dns"),
        ["dns-zone-delete"] = new(JobMode.Exclusive, "plugin:dns"),
        ["dns-zone-transfer"] = new(JobMode.Exclusive, "plugin:dns"),
        ["dns-record-add"] = new(JobMode.Exclusive, "plugin:dns"),
        ["dns-record-edit"] = new(JobMode.Exclusive, "plugin:dns"),
        ["dns-record-delete"] = new(JobMode.Exclusive, "plugin:dns"),
        ["dns-conditional-create"] = new(JobMode.Exclusive, "plugin:dns"),
        ["dns-conditional-edit"] = new(JobMode.Exclusive, "plugin:dns"),
        ["dns-conditional-delete"] = new(JobMode.Exclusive, "plugin:dns"),
        ["dns-forwarders-set"] = new(JobMode.Exclusive, "plugin:dns"),
        ["dns-scavenging-set"] = new(JobMode.Exclusive, "plugin:dns"),
        ["dns-scavenge-now"] = new(JobMode.Exclusive, "plugin:dns"),
        ["dns-cache-clear"] = new(JobMode.Exclusive, "plugin:dns"),
    };

    // The fixed diagnoses a runbook step may run without a script, as in JobRunner.RunbookAsync.
    private static readonly string[] RunbookDiagnoses = ["refresh", "scan-updates", "test-connection"];

    // The portal's dnsName pattern in lib/management.ts, character for character; tests/agent/agent-parallel-jobs-source.mjs compares both.
    internal const string HostPattern = @"^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$";
    private static readonly Regex Host = new(HostPattern, RegexOptions.CultureInvariant);

    internal static JobMode Mode(string? action, JsonObject? parameters) => Classify(action, parameters).Mode;
    internal static string? Group(string? action, JsonObject? parameters) => Classify(action, parameters).Group;

    /// <summary>The class of a job. Never throws; an unknown kind or plugin operation is sole, the fail-safe.</summary>
    internal static JobClass Classify(string? action, JsonObject? parameters)
    {
        try
        {
            if (action is null) return SoleClass;
            if (action == "runbook-step")
            {
                // A fixed diagnosis without script and with valid operation parameters does the work of its console kind;
                // any other step counts as a script. The same rule as isReadOnlyRunbookJob in lib/jobs/runbook-step.ts.
                string? operation = Text(parameters?["operation"]);
                bool noScript = Falsy(parameters?["script"]);
                return Text(parameters?["kind"]) == "diagnosis" && operation is not null && RunbookDiagnoses.Contains(operation) && noScript && ValidOperationParameters(operation, parameters?["operationParameters"]) ? Kinds[operation] : new JobClass(JobMode.Exclusive, null);
            }
            if (action == "plugin-job")
            {
                string? operation = Text(parameters?["operation"]);
                if (operation is null || !PluginOperations.TryGetValue(operation, out var rule) || "plugin:" + Text(parameters?["plugin"]) != rule.Group) return SoleClass;
                return rule;
            }
            return Kinds.TryGetValue(action, out var known) ? known : SoleClass;
        }
        catch { return SoleClass; }
    }

    /// <summary>Whether a job of this class may start next to the running ones: the cap, sole alone, one exclusive, one per group.</summary>
    internal static bool Admits(JobClass next, IReadOnlyCollection<JobClass> running)
    {
        if (running.Count >= MaxRunning) return false;
        if (running.Count > 0 && next.Mode == JobMode.Sole) return false;
        if (running.Any(job => job.Mode == JobMode.Sole)) return false;
        if (next.Mode == JobMode.Exclusive && running.Any(job => job.Mode == JobMode.Exclusive)) return false;
        return next.Group is null || running.All(job => job.Group != next.Group);
    }

    // The portal schema of the diagnosis (lib/management.ts) on its operation parameters; missing or JSON null reads as {},
    // as the portal's p.operationParameters ?? {}. refresh and scan-updates take an empty object. test-connection takes
    // exactly host (a dnsName string) and port (an integral JSON number from 1 to 65535); a string port is refused.
    private static bool ValidOperationParameters(string operation, JsonNode? node)
    {
        if (node is not null && node is not JsonObject) return false;
        var fields = node as JsonObject ?? new JsonObject();
        if (operation is "refresh" or "scan-updates") return fields.Count == 0;
        if (operation != "test-connection" || fields.Count != 2) return false;
        if (!fields.TryGetPropertyValue("host", out var host) || !fields.TryGetPropertyValue("port", out var port)) return false;
        return Text(host) is { Length: >= 1 and <= 253 } name && WholeMatch(Host, name)
            && port is JsonValue number && number.GetValueKind() == JsonValueKind.Number && number.TryGetValue<double>(out double value)
            && value == Math.Floor(value) && value >= 1 && value <= 65535;
    }

    // A match of the whole text: .NET's $ also matches before a final newline, JavaScript's does not.
    private static bool WholeMatch(Regex pattern, string text)
    {
        var match = pattern.Match(text);
        return match.Success && match.Index == 0 && match.Length == text.Length;
    }

    // JavaScript falsiness of a JSON value, as the portal's !p.script: missing, null, false, 0 or "".
    private static bool Falsy(JsonNode? node) => node is null || node is JsonValue value && value.GetValueKind() switch
    {
        JsonValueKind.Null or JsonValueKind.False => true,
        JsonValueKind.String => value.GetValue<string>().Length == 0,
        JsonValueKind.Number => value.TryGetValue<double>(out var number) && number == 0,
        _ => false,
    };
    private static string? Text(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
}
