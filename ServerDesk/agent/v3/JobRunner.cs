using System.Text;
using System.Text.Json.Nodes;
using ServerDesk.Plugins;

namespace ServerDesk.Agent;

internal sealed class JobRunner
{
    internal static readonly string[] FileActions = ["list-files", "create-directory", "rename-file", "delete-file"];
    internal static readonly string[] StorageActions = ["storage-inspect", "storage-initialize", "storage-set-disk", "storage-new-volume", "storage-resize", "storage-drive-letter", "storage-format", "storage-delete-partition"];
    internal static readonly string[] DesiredStateActions = ["desired-state-test", "desired-state-apply"];
    internal static readonly string[] ManagementActions = ["refresh", "scan-updates", "test-connection", "start-service", "stop-service", "restart-service", "set-service-startup", "install-feature", "remove-feature", "set-network", "set-dns", "join-domain", "leave-domain", "rename-computer", "set-pagefile", "create-local-user", "set-local-user", "reset-local-password", "delete-local-user", "local-group-add", "local-group-remove", "restart-computer", "shutdown-computer", "schedule-power", "cancel-power-schedule", "install-updates", "set-firewall-rule", "add-firewall-rule", "set-task", "set-rdp", "install-gpu-driver"];
    internal static readonly string[] AdditionalManagementCapabilities = ["install-all-updates"];
    internal static readonly string[] DiagnosticActions = ["list-processes", "list-sessions", "list-connections", "network-diagnostics", "query-events", "export-events", "support-bundle", "kill-process", "message-session", "disconnect-session", "logoff-session"];
    // Microsoft Defender of 4.15.0 (NativeDefenderControl.cs): Management mode only, never in ReadActions.
    internal static readonly string[] DefenderActions = ["defender-quick-scan", "defender-full-scan", "defender-update-signatures", "defender-clean-detections"];
    // Agent plugins (docs/agent-plugins.md): install and remove distribute signed SYSTEM code like agent-update; plugin-job runs one plugin operation.
    internal static readonly string[] PluginActions = ["plugin-install", "plugin-remove", "plugin-job"];
    // A PowerShell script from the device assistant (4.17.0, AssistantPowerShell.cs): Management mode only, checked by the job itself.
    internal static readonly string[] AssistantActions = [AssistantPowerShell.Kind];
    internal static readonly string[] ReadActions = ["refresh", "scan-updates", "test-connection", "list-processes", "list-sessions", "list-connections", "network-diagnostics", "query-events", "export-events", "support-bundle", "list-files", "storage-inspect"];
    private readonly string root, package;
    private readonly JsonObject config;
    private readonly Action? refreshInventory;
    private readonly IReleaseSource? releases;
    private readonly IGpuDriverSource? gpuDrivers;
    private readonly PluginHost? plugins;
    private readonly Func<PluginUpload, CancellationToken, Task>? pluginUpload;
    private readonly Func<(bool Terminal, bool Rdp, bool Transfers)>? host;
    internal PortalUninstall Uninstall { get; }
    /// <summary>The broker-held slot of a portal scan; the broker status answer reports it as defenderScan.</summary>
    internal DefenderScanSlot DefenderScans { get; }
    private readonly IDefenderControlProvider? defenderProvider;
    // The jobs this broker started (4.21.0, parallel-jobs): several may run at once by their class (JobConcurrency.cs).
    private sealed record RunningJob(string Id, string? Action, JobClass Class, Task Task);
    private readonly List<RunningJob> running = [];
    private readonly object gate = new();
    /// <summary>Test seam of the self-tests: awaited before a job starts its work, so a test can hold jobs running. Null in the service.</summary>
    internal Func<string, Task>? HoldForTest { get; init; }
    // Call under gate: the jobs whose task has not finished, after dropping the finished ones.
    private List<RunningJob> Live() { running.RemoveAll(job => job.Task.IsCompleted); return running; }
    internal bool Busy { get { lock (gate) return Live().Count > 0; } }
    internal bool Updating { get { lock (gate) return Live().Any(job => job.Action == "agent-update"); } }
    // Actions that run in ReadOnly and Management mode: reads, the agent's own update and uninstall, and plugin install and removal.
    // ad-sign-in (4.19.0) only checks an account and changes nothing, so it also runs in ReadOnly mode.
    internal static bool AllowedInReadOnly(string action) => ReadActions.Contains(action) || action is "agent-update" or "agent-uninstall" or "plugin-install" or "plugin-remove" or PluginIdentity.SignInKind;
    // A plugin job runs in ReadOnly mode only for a read operation (dhcp-read, dns-read, dns-zone-read); any other operation needs Management.
    internal static bool AllowedInReadOnly(string action, JsonObject parameters) => AllowedInReadOnly(action) || action == "plugin-job" && PluginHost.ReadOperation(parameters["operation"] is JsonValue value && value.TryGetValue<string>(out var operation) ? operation : null);
    internal static string BusyCode(string? action) => action switch { "agent-update" => "AGENT_UPDATE_BUSY", "agent-uninstall" => "AGENT_UNINSTALL_BUSY", _ => "AGENT_BUSY" };
    internal JobRunner(string root, string package, JsonObject config, Action? refreshInventory = null, IReleaseSource? releases = null, Func<(bool Terminal, bool Rdp, bool Transfers)>? host = null, PortalUninstall? uninstall = null, IGpuDriverSource? gpuDrivers = null, IDefenderControlProvider? defender = null, PluginHost? plugins = null, Func<PluginUpload, CancellationToken, Task>? pluginUpload = null)
    {
        this.root = root; this.package = package; this.config = config; this.refreshInventory = refreshInventory; this.releases = releases; this.host = host; Uninstall = uninstall ?? new PortalUninstall(root); this.gpuDrivers = gpuDrivers; this.plugins = plugins; this.pluginUpload = pluginUpload;
        // When a portal scan ends, the inventory refresh runs the Defender collector again at once.
        DefenderScans = new DefenderScanSlot(refreshInventory); defenderProvider = defender;
        // A GPU driver package that a previous broker staged never runs later: its folder goes at start.
        GpuDriverUpdate.CleanStaging(root);
        Directory.CreateDirectory(Path.Combine(root, "v3-jobs", "operations"));
        string? pendingUpdateId = AgentUpdater.PendingJobId(root);
        foreach (string path in Directory.GetFiles(Path.Combine(root, "v3-jobs"), "*.claim"))
        {
            string id = Path.GetFileNameWithoutExtension(path);
            if (Guid.TryParse(id, out _) && id != pendingUpdateId && !File.Exists(path + ".ack") && !File.Exists(ResultPath(id))) SaveResult(AgentMessages.Write(new JsonObject { ["id"] = id, ["ok"] = false }, "AGENT_JOB_INTERRUPTED"));
        }
        // A new broker never launches an uninstall it did not stage itself. An
        // undelivered start result becomes a failure, so the portal keeps the device.
        foreach (var result in Results()) if (result?["code"]?.GetValue<string>() == "AGENT_UNINSTALL_STARTED" && result["id"]?.GetValue<string>() is string id) ReplaceUninstallResult(id, "The agent restarted before the uninstall started");
    }
    private void ReplaceUninstallResult(string id, string detail) { if (File.Exists(ResultPath(id))) SaveResult(AgentMessages.Write(new JsonObject { ["id"] = id, ["ok"] = false }, "AGENT_UNINSTALL_STAGE_FAILED", ("detail", detail))); }
    /// <summary>Housekeeping: an undelivered uninstall result expires after the delivery timeout.</summary>
    internal void Tick() { if (Uninstall.Tick() is string expired) lock (gate) ReplaceUninstallResult(expired, "The portal did not confirm the result within 10 minutes"); }
    /// <summary>The portal refused the device credentials of a post that named this uninstall job, with this code.</summary>
    internal void CredentialsRefused(string jobId, string? code) => Uninstall.CredentialsRefused(jobId, code);
    /// <summary>The portal answered the start result with 409 AGENT_UNINSTALL_NOT_CONFIRMED: disarm and report the failure instead.</summary>
    internal void Unconfirmed(string jobId) { if (Uninstall.Unconfirmed(jobId)) lock (gate) ReplaceUninstallResult(jobId, "The portal did not confirm the uninstall"); }
    private string ResultPath(string id) => Path.Combine(root, "v3-jobs", id + ".result.json");
    // Every running job, plus the ID of a staged agent update until the updater writes its result: at most MaxRunning + 1 IDs.
    internal JsonArray Running
    {
        get
        {
            lock (gate)
            {
                var ids = Live().Select(job => job.Id).ToList();
                string? pending = AgentUpdater.PendingJobId(root);
                if (pending is not null && !ids.Contains(pending) && !File.Exists(ResultPath(pending))) ids.Add(pending);
                return new JsonArray(ids.Select(id => (JsonNode)JsonValue.Create(id)!).ToArray());
            }
        }
    }
    internal JsonArray Results()
    {
        var results = new JsonArray();
        foreach (string file in Directory.EnumerateFiles(Path.Combine(root, "v3-jobs"), "*.result.json"))
        {
            string id = Path.GetFileName(file)[..^".result.json".Length];
            if (!Guid.TryParse(id, out _)) continue;
            try { var result = JsonNode.Parse(File.ReadAllText(file)); if (result?["id"]?.GetValue<string>() == id) results.Add(result); } catch { }
            if (results.Count == 5) break;
        }
        return results;
    }
    internal void Acknowledge(JsonArray results)
    {
        foreach (var result in results) if (result?["id"]?.GetValue<string>() is string id && Guid.TryParse(id, out _))
        {
            LocalStore.Atomic(Path.Combine(root, "v3-jobs", id + ".claim.ack"), Encoding.UTF8.GetBytes(DateTimeOffset.UtcNow.ToString("O"))); File.Delete(ResultPath(id));
        }
        // The portal answered the post that carried these results: a delivered uninstall start may launch now.
        Uninstall.Acknowledged(results);
    }
    internal void Start(JsonObject job, bool exclusiveBusy, CancellationToken token)
    {
        string id = job["id"]?.GetValue<string>() ?? ""; if (!Guid.TryParse(id, out _)) throw new InvalidDataException("Invalid job ID");
        lock (gate)
        {
            string claim = Path.Combine(root, "v3-jobs", id + ".claim");
            if (File.Exists(claim)) return; // Permanent durable no-replay marker, also after successful acknowledgement.
            LocalStore.Atomic(claim, Encoding.UTF8.GetBytes(DateTimeOffset.UtcNow.ToString("O")));
            string? action = job["action"]?.GetValue<string>();
            // The portal claims by the same classes; this local check refuses a job that would break them (defense in depth).
            var kind = JobConcurrency.Classify(action, job["parameters"] as JsonObject);
            if (exclusiveBusy || Uninstall.Busy || !JobConcurrency.Admits(kind, Live().Select(other => other.Class).ToList())) { SaveResult(AgentMessages.Write(new JsonObject { ["id"] = id, ["ok"] = false }, BusyCode(action))); return; }
            running.Add(new RunningJob(id, action, kind, Task.Run(() => ExecuteAsync(job.DeepClone().AsObject(), token), CancellationToken.None)));
        }
    }
    private void SaveResult(JsonObject result) => LocalStore.Json(ResultPath(result["id"]!.GetValue<string>()), result);
    private async Task ExecuteAsync(JsonObject job, CancellationToken token)
    {
        string id = job["id"]!.GetValue<string>(), action = job["action"]!.GetValue<string>(); var p = job["parameters"]?.AsObject() ?? new JsonObject();
        var result = new JsonObject { ["id"] = id, ["ok"] = false };
        if (HoldForTest is not null) await HoldForTest(id);
        try
        {
            // Update and uninstall check local maintenance themselves and report it with their own code.
            using var activityLease = action is "agent-update" or "agent-uninstall" ? null : AgentUpdateLease.AcquireActivity(root);
            string mode = LocalStore.ReadProtected(Path.Combine(root, "config.bin"))["mode"]!.GetValue<string>();
            bool trustedRunbookDiagnosis = action == "runbook-step" && p["kind"]?.GetValue<string>() == "diagnosis" && new[] { "refresh", "scan-updates", "test-connection" }.Contains(p["operation"]?.GetValue<string>());
            // The assistant script reports its own Management code (AGENT_ASSISTANT_MANAGEMENT_REQUIRED).
            if (!AllowedInReadOnly(action, p) && !trustedRunbookDiagnosis && !AssistantActions.Contains(action) && mode != "Management") throw new AgentMessageException("AGENT_READONLY");
            if (FileActions.Contains(action)) { var (data, message) = await FileBrowser.ExecuteAsync(root, action, p, token); result["data"] = data; result["ok"] = true; AgentMessages.Write(result, message); }
            else if (StorageActions.Contains(action)) result = await NativeStorage.ExecuteAsync(root, config, job, token);
            else if (DesiredStateActions.Contains(action)) result = await DesiredStateJobs.ExecuteAsync(root, package, config, job, token);
            else if (ManagementActions.Contains(action)) result = await NativeManagement.ExecuteAsync(root, config, job, token, gpuDrivers);
            else if (DiagnosticActions.Contains(action)) result = await NativeDiagnostics.ExecuteAsync(root, config, job, token);
            else if (DefenderActions.Contains(action)) result = await new NativeDefenderControl(DefenderScans, defenderProvider).ExecuteAsync(job, token);
            else if (action == "runbook-step") result = await RunbookAsync(job, token);
            else if (action == AssistantPowerShell.Kind) result = await AssistantPowerShell.RunAsync(job, LocalStore.ReadProtected(Path.Combine(root, "config.bin"))["mode"]?.GetValue<string>(), token);
            else if (action == "agent-update") { await AgentUpdater.PrepareAsync(root, package, config, job, releases ?? throw new AgentMessageException("AGENT_UPDATE_RELAY_REQUIRED"), token); return; } // Only the separate updater writes the final result after health/rollback.
            else if (action == "agent-uninstall") result = Uninstall.Prepare(id, UninstallProbe(id));
            else if (action == "plugin-install") result = await (plugins ?? throw new AgentMessageException("AGENT_UNKNOWN_ACTION")).InstallAsync(job, config["origin"]!.GetValue<string>(), releases ?? throw new AgentMessageException("AGENT_UPDATE_RELAY_REQUIRED"), token);
            else if (action == "plugin-remove") result = await (plugins ?? throw new AgentMessageException("AGENT_UNKNOWN_ACTION")).RemoveAsync(id, p["name"] is JsonValue name && name.TryGetValue<string>(out var text) ? text : "", token);
            // 4.17.0 (plugin-secrets): sealed secrets of a plugin job open with the device key, as for a runbook step.
            // 4.19.0 (plugin-ad-identity): the password check of an AD sign-in; the password comes sealed to the device key.
            else if (action == PluginIdentity.SignInKind) result = PluginIdentity.SignIn(job, box => LocalStore.DecryptSecrets(box, config["privateKey"]?.GetValue<string>() ?? throw new System.Security.Cryptography.CryptographicException("No device key.")));
            else if (action == "plugin-job") result = await (plugins ?? throw new AgentMessageException("AGENT_UNKNOWN_ACTION")).RunJobAsync(job, pluginUpload ?? throw new AgentMessageException("AGENT_UPDATE_RELAY_REQUIRED"), token, box => LocalStore.DecryptSecrets(box, config["privateKey"]?.GetValue<string>() ?? throw new System.Security.Cryptography.CryptographicException("No device key.")));
            else throw new AgentMessageException("AGENT_UNKNOWN_ACTION");
        }
        catch (Exception e) { AgentMessages.Fail(result, e); }
        result["id"] = id; SaveResult(result);
        // A GPU driver install refreshes the inventory after success and failure, so the GPU view shows the driver that is there now.
        // A Defender job refreshes after success and failure, so the Defender collector runs again at once.
        // An assistant script refreshes after success, like a runbook step.
        if (DefenderActions.Contains(action) || (result["ok"]?.GetValue<bool>() == true || action is "schedule-power" or "cancel-power-schedule" or "install-gpu-driver") && (ManagementActions.Contains(action) || DesiredStateActions.Contains(action) || action == "runbook-step" || AssistantActions.Contains(action))) refreshInventory?.Invoke();
        // An installed or removed plugin shows in the next heartbeat.
        if (action is "plugin-install" or "plugin-remove") refreshInventory?.Invoke();
    }
    private UninstallProbe UninstallProbe(string id)
    {
        var (terminal, rdp, transfers) = host?.Invoke() ?? (false, false, false);
        int others = Running.Count(node => node?.GetValue<string>() != id);
        return new UninstallProbe(PortalUninstall.IsAdministrator(), package, root, AgentInstaller.InMaintenance(root), AgentUpdater.Pending(root), others, terminal, rdp, transfers);
    }
    private async Task<JsonObject> RunbookAsync(JsonObject job, CancellationToken token)
    {
        string id = job["id"]!.GetValue<string>(); var p = job["parameters"]!.AsObject();
        if (p["kind"]?.GetValue<string>() == "diagnosis")
        {
            string action = p["operation"]!.GetValue<string>(); if (!new[] { "refresh", "scan-updates", "test-connection" }.Contains(action)) throw new AgentMessageException("AGENT_RUNBOOK_DIAGNOSIS_UNTRUSTED");
            return await NativeManagement.ExecuteAsync(root, config, new JsonObject { ["id"] = id, ["action"] = action, ["parameters"] = p["operationParameters"]?.DeepClone() ?? new JsonObject() }, token);
        }
        if (p["kind"]?.GetValue<string>() != "powershell" || LocalStore.ReadProtected(Path.Combine(root, "config.bin"))["mode"]?.GetValue<string>() != "Management") throw new AgentMessageException("AGENT_RUNBOOK_MANAGEMENT_REQUIRED");
        var parameters = p["parameters"]?.DeepClone().AsObject() ?? new JsonObject(); var secrets = p["secretParameters"] is JsonObject box ? LocalStore.DecryptSecrets(box, config["privateKey"]!.GetValue<string>()) : new JsonObject();
        foreach (var entry in secrets) parameters[entry.Key] = entry.Value?.DeepClone();
        int seconds = Math.Clamp(p["timeoutSeconds"]?.GetValue<int>() ?? 120, 5, 3600);
        var execution = await PowerShellRunner.RunUserScriptAsync(p["script"]!.GetValue<string>(), parameters, TimeSpan.FromSeconds(seconds), token);
        string[] knownSecrets = secrets.Select(secret => secret.Value is JsonValue v && v.TryGetValue<string>(out var value) ? value : secret.Value?.ToJsonString() ?? "").ToArray();
        string output = SecretMask.Apply(execution.Output, knownSecrets), error = SecretMask.Apply(execution.Error, knownSecrets);
        bool truncated = execution.Truncated || output.Length > 32768; output = output[..Math.Min(32768, output.Length)];
        var step = new JsonObject { ["id"] = id, ["ok"] = execution.ExitCode == 0, ["data"] = new JsonObject { ["output"] = output, ["stderr"] = error[..Math.Min(8192, error.Length)], ["exitCode"] = execution.ExitCode, ["truncated"] = truncated } };
        return execution.ExitCode == 0 ? AgentMessages.Write(step, "AGENT_RUNBOOK_STEP_COMPLETED") : AgentMessages.Write(step, AgentMessages.Of("AGENT_RUNBOOK_FAILED", ("detail", error)), knownSecrets);
    }
    internal async Task StopAsync() { Task[] tasks; lock (gate) tasks = Live().Select(job => job.Task).ToArray(); await Task.WhenAll(tasks); }
}
