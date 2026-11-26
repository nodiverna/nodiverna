using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace ServerDesk.Agent;

// Tamper protection of agent 4.18.0 (docs/native-agent-v4.md, "Tamper
// protection in 4.18.0"). A real Protected Process Light is not possible, so
// the broker checks what the installer set, restores it, and reports every
// change as an integrity event; the portal raises its own alarms for them
// (lib/server/agent/agent-integrity.ts). A local administrator can always stop, disable and
// remove the agent: the start type is reported, never changed back.

/// <summary>The shared contract with the portal (lib/server/agent/agent-integrity.ts): event kinds, targets, services, start types and reasons.</summary>
internal static class IntegrityContract
{
    internal static readonly string[] Kinds = ["service-stopped", "service-ended", "service-hung", "service-restarted", "broker-unresponsive", "start-type-changed", "agent-removed", "protection-changed"];
    internal static readonly string[] Targets = ["service-dacl", "service-sid", "service-recovery", "folder-agent", "folder-plugins", "folder-staging"];
    internal static readonly string[] Services = ["broker", "worker"];
    /// <summary>The start types of the heartbeat snapshot.</summary>
    internal static readonly string[] StartTypes = ["auto", "delayed-auto", "manual", "disabled", "unknown"];
    /// <summary>The start types of a start-type-changed event: the agent no longer starts on its own.</summary>
    internal static readonly string[] EventStartTypes = ["manual", "disabled", "unknown"];
    internal static readonly string[] Reasons = ["local-uninstall", "service-deleted"];
    /// <summary>The kinds that a planned context (PlannedContext) never creates.</summary>
    internal static readonly string[] StopKinds = ["service-stopped", "service-ended", "service-hung", "service-restarted", "broker-unresponsive"];
    internal const string Capability = "agent-integrity";
    internal const string Route = "/api/agent/integrity";
    internal const int FindingLength = 120, UserLength = 256;

    /// <summary>One event with a new GUID. Optional fields are left out when null.</summary>
    internal static JsonObject Event(string kind, DateTimeOffset at, string? service = null, string? target = null, string? startType = null, string? reason = null, string? user = null, bool? repaired = null, string? finding = null)
    {
        if (!Kinds.Contains(kind)) throw new ArgumentException("Unknown integrity event kind.", nameof(kind));
        var value = new JsonObject { ["id"] = Guid.NewGuid().ToString("D"), ["kind"] = kind, ["at"] = at.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture) };
        if (service is not null) value["service"] = Services.Contains(service) ? service : throw new ArgumentException("Unknown service.", nameof(service));
        if (target is not null) value["target"] = Targets.Contains(target) ? target : throw new ArgumentException("Unknown target.", nameof(target));
        if (startType is not null) value["startType"] = EventStartTypes.Contains(startType) ? startType : "unknown";
        if (reason is not null) value["reason"] = Reasons.Contains(reason) ? reason : throw new ArgumentException("Unknown reason.", nameof(reason));
        if (user is not null) value["user"] = Clean(user, UserLength);
        if (repaired is not null) value["repaired"] = repaired.Value;
        if (finding is not null) value["finding"] = Clean(finding, FindingLength);
        return value;
    }
    /// <summary>At most `length` characters, control characters replaced by a space.</summary>
    internal static string Clean(string text, int length) => new(text.Select(c => char.IsControl(c) ? ' ' : c).Take(length).ToArray());
    internal static string ServiceKey(AgentServiceNames names, string name) => name == names.Worker ? "worker" : "broker";
}

/// <summary>
/// The contexts in which a stop, an end or a hung worker is expected: a system
/// shutdown, an agent update (plan file or running job), a local installation
/// or uninstall (maintenance marker), and a portal uninstall. They create no
/// stop event, and the watchdog does nothing while they last.
/// </summary>
internal static class PlannedContext
{
    internal static bool Planned(bool shutdown, bool maintenance, bool updatePending, bool updating, bool uninstallBusy) => shutdown || maintenance || updatePending || updating || uninstallBusy;
    /// <summary>The planned context of an agent root without a running broker: maintenance marker or update plan.</summary>
    internal static bool AtRoot(string root) => Planned(false, AgentInstaller.InMaintenance(root), AgentUpdater.Pending(root), false, false);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    /// <summary>SM_SHUTTINGDOWN: Windows shuts down; services may end before they receive SHUTDOWN.</summary>
    internal static bool SystemShuttingDown() { try { return OperatingSystem.IsWindows() && GetSystemMetrics(0x2000) != 0; } catch { return false; } }
}

/// <summary>
/// The pending events of the broker in %ProgramData%\ServerDesk\integrity-events.json
/// (SYSTEM and Administrators only): at most 50, the oldest dropped first, kept
/// across restarts until the worker delivered them and sent integrity-ack.
/// </summary>
internal sealed class IntegrityEventStore
{
    internal const int Maximum = 50, PendingLimit = 20;
    private const long MaximumFileBytes = 262_144;
    private readonly string path;
    private readonly object gate = new();
    private readonly List<JsonObject> events = [];
    internal IntegrityEventStore(string path)
    {
        this.path = path;
        try
        {
            var file = new FileInfo(path);
            if (file.Exists && file.Length <= MaximumFileBytes && (file.Attributes & FileAttributes.ReparsePoint) == 0 && JsonNode.Parse(File.ReadAllText(path))?["events"] is JsonArray stored)
                foreach (var item in stored) if (item is JsonObject value && value["id"] is JsonValue && value["kind"] is JsonValue kind && IntegrityContract.Kinds.Contains(kind.GetValue<string>())) events.Add(value.DeepClone().AsObject());
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException or FormatException) { }
        Trim();
    }
    internal int Count { get { lock (gate) return events.Count; } }
    internal bool Any => Count > 0;
    internal void Add(JsonObject value) { lock (gate) { events.Add(value); Trim(); Save(); } }
    /// <summary>The oldest pending events, at most 20, as copies.</summary>
    internal JsonArray Pending() { lock (gate) return new JsonArray(events.Take(PendingLimit).Select(item => (JsonNode)item.DeepClone()).ToArray()); }
    /// <summary>Removes the accepted events; returns how many were removed.</summary>
    internal int Acknowledge(IEnumerable<string> ids)
    {
        var accepted = ids.ToHashSet(StringComparer.Ordinal);
        lock (gate)
        {
            int removed = events.RemoveAll(item => item["id"]?.GetValue<string>() is string id && accepted.Contains(id));
            if (removed > 0) Save();
            return removed;
        }
    }
    /// <summary>Drops the worker events of the last `window` before a system shutdown: the worker may end before the broker receives SHUTDOWN.</summary>
    internal void DropRecentWorkerEvents(DateTimeOffset now, TimeSpan window)
    {
        lock (gate)
        {
            int removed = events.RemoveAll(item => item["service"]?.GetValue<string>() == "worker" && IntegrityContract.StopKinds.Contains(item["kind"]?.GetValue<string>()) && DateTimeOffset.TryParse(item["at"]?.GetValue<string>(), out var at) && now - at <= window);
            if (removed > 0) Save();
        }
    }
    private void Trim() { if (events.Count > Maximum) events.RemoveRange(0, events.Count - Maximum); }
    private void Save() { try { LocalStore.Json(path, new JsonObject { ["events"] = new JsonArray(events.Select(item => (JsonNode)item.DeepClone()).ToArray()) }); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { } }
}

/// <summary>
/// The baseline of the protection check: the version and a hash of the
/// verified policy, written after a check without a finding. At start a
/// finding is reported only with a baseline of the running version; the first
/// start of a new version, and a start after --install, repair silently.
/// </summary>
internal static class IntegrityBaseline
{
    internal const string FileName = "integrity-baseline.json";
    /// <summary>SHA-256 of the policy the check compares against: service DACL, SID types, worker privileges, failure actions and the folder rule.</summary>
    internal static string PolicyHash { get; } = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n",
        NativeServiceSetup.SecurityDescriptor, NativeServiceSetup.ServiceSidType, NativeServiceSetup.WorkerSidType, NativeServiceSetup.WorkerPrivileges,
        string.Join(",", NativeServiceSetup.RecoveryDelaysMs), NativeServiceSetup.RecoveryResetSeconds, NativeServiceSetup.RecoveryOnNonCrashFailures,
        PluginAcl.UnsafeRights, "owner+protected+no-write-ace")))).ToLowerInvariant();
    /// <summary>Whether a finding at start is reported: a baseline of this version and policy exists.</summary>
    internal static bool Reports(JsonObject? baseline, string version, string policyHash) =>
        baseline?["version"] is JsonValue v && v.TryGetValue<string>(out var stored) && stored == version && baseline["policyHash"] is JsonValue h && h.TryGetValue<string>(out var hash) && hash == policyHash;
}

/// <summary>The run marker of the broker: written at start, deleted on a clean stop or shutdown. A marker left from the same boot session means the broker ended unexpectedly.</summary>
internal static class RunMarker
{
    internal const string FileName = "broker-run.json";
    /// <summary>Two boot times within this tolerance belong to one boot session (clock adjustment after boot).</summary>
    internal static readonly TimeSpan BootTolerance = TimeSpan.FromMinutes(2);
    internal static DateTimeOffset BootTime(DateTimeOffset now, long tickCount64) => now - TimeSpan.FromMilliseconds(tickCount64);
    internal static bool SameBoot(DateTimeOffset previous, DateTimeOffset current) => (previous - current).Duration() <= BootTolerance;
    /// <summary>Whether a marker left at start gives service-ended (broker).</summary>
    internal static bool Ended(JsonObject? marker, DateTimeOffset bootTime, bool planned) =>
        !planned && marker?["bootTime"] is JsonValue value && value.TryGetValue<string>(out var text) && DateTimeOffset.TryParse(text, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out var previous) && SameBoot(previous, bootTime);
}

internal enum WatchdogAction { None, Start, End }

/// <summary>The decisions of the broker's watchdog over the worker, every 15 s. Pure.</summary>
internal static class WorkerWatchdog
{
    internal static readonly TimeSpan Interval = TimeSpan.FromSeconds(15), HangLimit = TimeSpan.FromMinutes(3);
    internal const int ServiceStopped = 1, ServiceRunning = 4;
    /// <summary>
    /// Start: the worker is STOPPED in two checks in a row and starts
    /// automatically. End: it runs but made no pipe request for 3 minutes; the
    /// failure actions restart it. A crash or kill is left to the failure
    /// actions. Nothing happens in a planned context, and nothing starts a
    /// worker set to manual or disabled.
    /// </summary>
    internal static WatchdogAction Decide(int state, string startType, TimeSpan? sinceLastRequest, bool planned, int stoppedChecks)
    {
        if (planned) return WatchdogAction.None;
        if (state == ServiceStopped) return stoppedChecks >= 2 && startType is "auto" or "delayed-auto" ? WatchdogAction.Start : WatchdogAction.None;
        if (state == ServiceRunning && sinceLastRequest is TimeSpan age && age >= HangLimit) return WatchdogAction.End;
        return WatchdogAction.None;
    }
}

/// <summary>One protection difference: a target, for a service target the service, and a short technical finding.</summary>
internal readonly record struct IntegrityFinding(string Target, string? Service, string Finding)
{
    internal string Key => Target + "/" + (Service ?? "");
}

/// <summary>
/// The broker's integrity check and watchdog. Start() runs once before the
/// broker opens its pipe; Tick() runs from the broker housekeeping. All reads
/// and repairs use the installer's own functions.
/// </summary>
internal sealed class BrokerIntegrity
{
    internal static readonly TimeSpan CheckInterval = TimeSpan.FromMinutes(5), RegistryPoll = TimeSpan.FromSeconds(10);
    private readonly string root;
    private readonly AgentServiceNames names = AgentServiceNames.Installed;
    private readonly Action<string> log;
    private readonly Func<DateTimeOffset> clock;
    private readonly object gate = new();
    private Func<bool> planned;
    private HashSet<string> open = [];
    private Dictionary<string, string> startTypes = new(StringComparer.Ordinal);
    private JsonObject snapshot = new();
    private DateTimeOffset nextCheck, nextPoll;
    private string? registryFingerprint;
    // Watchdog state.
    private long lastRequest = Stopwatch.GetTimestamp();
    private int workerPid, stoppedChecks, killedPid;
    private DateTimeOffset nextWatch;
    private readonly Dictionary<int, string> notices = [];
    internal IntegrityEventStore Events { get; }

    internal BrokerIntegrity(string root, Action<string> log, Func<DateTimeOffset>? clock = null)
    {
        this.root = root; this.log = log; this.clock = clock ?? (() => DateTimeOffset.UtcNow);
        Events = new IntegrityEventStore(Path.Combine(root, "integrity-events.json"));
        planned = () => PlannedContext.AtRoot(root);
    }

    /// <summary>The broker's full planned context, once its job runner exists.</summary>
    internal void Attach(Func<bool> plannedContext) => planned = plannedContext;
    internal bool Planned() { try { return planned(); } catch { return true; } }

    /// <summary>
    /// Broker start, before the pipe opens and before the service reports
    /// RUNNING: the run marker, then the protection check before the policy
    /// repair (reported only with a baseline of this version), the repair
    /// with the installer's functions, the check again, and the baseline.
    /// </summary>
    internal void Start()
    {
        DateTimeOffset now = clock(), boot = RunMarker.BootTime(now, Environment.TickCount64);
        bool atStartPlanned = PlannedContext.AtRoot(root);
        string markerPath = Path.Combine(root, RunMarker.FileName);
        try
        {
            if (RunMarker.Ended(ReadJson(markerPath), boot, atStartPlanned)) Events.Add(IntegrityContract.Event("service-ended", now, service: "broker"));
            using var self = Process.GetCurrentProcess();
            LocalStore.Json(markerPath, new JsonObject { ["pid"] = self.Id, ["startedAt"] = now.ToString("O"), ["bootTime"] = boot.ToString("O") });
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { log("Integrity run marker: " + e.Message); }
        var baseline = ReadJson(Path.Combine(root, IntegrityBaseline.FileName));
        bool reports = IntegrityBaseline.Reports(baseline, Program.Version, IntegrityBaseline.PolicyHash) && !atStartPlanned;
        if (baseline?["startTypes"] is JsonObject known) foreach (var (service, value) in known) if (value is JsonValue text && text.TryGetValue<string>(out var type)) startTypes[service] = type;
        // ApplySecurityPolicy runs at every broker start, also without
        // a finding: after a portal update it brings the failure actions.
        Check(report: reports, applyPolicy: true);
        nextCheck = now + CheckInterval; nextPoll = now + RegistryPoll;
    }

    /// <summary>From the broker housekeeping (2 s): the 5-minute check, the 10-second registry poll and the 15-second watchdog.</summary>
    internal void Tick(bool stopping)
    {
        if (stopping) return;
        DateTimeOffset now = clock();
        bool isPlanned = Planned();
        bool due = now >= nextCheck;
        if (now >= nextPoll)
        {
            nextPoll = now + RegistryPoll;
            string fingerprint = RegistryFingerprint();
            if (registryFingerprint is not null && fingerprint != registryFingerprint) due = true;
            registryFingerprint = fingerprint;
        }
        // Updates, installs and uninstalls change these objects on purpose:
        // the check waits until they are over.
        if (due && !isPlanned) { nextCheck = now + CheckInterval; Check(report: true, applyPolicy: false); registryFingerprint = RegistryFingerprint(); }
        if (now >= nextWatch) { nextWatch = now + WorkerWatchdog.Interval; Watch(isPlanned || PlannedContext.SystemShuttingDown()); }
    }

    /// <summary>Every pipe request of the worker: the watchdog's sign of life.</summary>
    internal void NoteRequest() => Volatile.Write(ref lastRequest, Stopwatch.GetTimestamp());

    /// <summary>The worker announced its clean end (op worker-stopping): no service-ended for this process.</summary>
    internal void WorkerStopping(int pid, string reason) { lock (gate) { notices[pid] = reason; } }

    /// <summary>The op stop-context: whether the worker's stop is planned.</summary>
    internal JsonObject StopContext() => new() { ["ok"] = true, ["planned"] = Planned() };

    /// <summary>The broker's clean end: a STOP outside a planned context queues service-stopped (broker) for the next start; the run marker goes.</summary>
    internal void Stopped(ServiceStop stop)
    {
        try
        {
            if (stop.Shutdown) Events.DropRecentWorkerEvents(clock(), TimeSpan.FromSeconds(60));
            else if (stop.Stopped && !Planned() && !PlannedContext.SystemShuttingDown()) Events.Add(IntegrityContract.Event("service-stopped", clock(), service: "broker"));
            File.Delete(Path.Combine(root, RunMarker.FileName));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { log("Integrity stop: " + e.Message); }
    }

    /// <summary>The heartbeat snapshot agentIntegrity: checkedAt, the start type per service and the findings still open after the repair.</summary>
    internal JsonObject Snapshot() { lock (gate) return snapshot.DeepClone().AsObject(); }

    private void Check(bool report, bool applyPolicy)
    {
        try
        {
            var (before, types) = Inspect();
            var events = new List<(IntegrityFinding Finding, JsonObject Event)>();
            foreach (var finding in before)
            {
                if (!report || open.Contains(finding.Key)) continue;
                events.Add((finding, IntegrityContract.Event("protection-changed", clock(), service: finding.Service, target: finding.Target, finding: finding.Finding)));
            }
            if (applyPolicy || before.Count > 0) Repair(before, applyPolicy);
            var after = before.Count > 0 || applyPolicy ? Inspect().Findings : before;
            var still = after.Select(item => item.Key).ToHashSet(StringComparer.Ordinal);
            foreach (var (finding, value) in events) { value["repaired"] = !still.Contains(finding.Key); Events.Add(value); log("Protection changed: " + finding.Target + " " + (finding.Service ?? "") + " " + finding.Finding + (still.Contains(finding.Key) ? " (not restored)" : " (restored)")); }
            // A start type that no longer starts the agent is reported once per change, never changed back.
            foreach (var (service, type) in types)
            {
                bool changed = startTypes.TryGetValue(service, out var previous) && previous != type;
                if ((changed || !startTypes.ContainsKey(service) && report) && IntegrityContract.EventStartTypes.Contains(type)) Events.Add(IntegrityContract.Event("start-type-changed", clock(), service: service, startType: type));
                startTypes[service] = type;
            }
            lock (gate)
            {
                open = still;
                snapshot = new JsonObject
                {
                    ["checkedAt"] = clock().UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture),
                    ["services"] = new JsonArray(types.Select(pair => (JsonNode)new JsonObject { ["service"] = pair.Key, ["startType"] = pair.Value }).ToArray()),
                    ["findings"] = new JsonArray(after.Take(16).Select(item => (JsonNode)(item.Service is null ? new JsonObject { ["target"] = item.Target } : new JsonObject { ["target"] = item.Target, ["service"] = item.Service })).ToArray())
                };
            }
            var baseline = ReadJson(Path.Combine(root, IntegrityBaseline.FileName)) ?? new JsonObject();
            if (after.Count == 0) { baseline["version"] = Program.Version; baseline["policyHash"] = IntegrityBaseline.PolicyHash; baseline["at"] = clock().ToString("O"); }
            baseline["startTypes"] = new JsonObject(startTypes.Select(pair => KeyValuePair.Create(pair.Key, (JsonNode?)JsonValue.Create(pair.Value))));
            LocalStore.Json(Path.Combine(root, IntegrityBaseline.FileName), baseline);
        }
        catch (Exception e) { log("Integrity check: " + e.GetType().Name + ": " + e.Message); }
    }

    // Reads, never changes: both services and the agent, plugin and staging folders (no recursion into files).
    private (List<IntegrityFinding> Findings, List<KeyValuePair<string, string>> StartTypes) Inspect()
    {
        var findings = new List<IntegrityFinding>(); var types = new List<KeyValuePair<string, string>>();
        foreach (string name in new[] { names.Broker, names.Worker })
        {
            string service = IntegrityContract.ServiceKey(names, name);
            var inspection = NativeServiceSetup.Inspect(name, worker: name == names.Worker);
            types.Add(KeyValuePair.Create(service, inspection.StartType));
            if (!inspection.Exists) continue;
            if (inspection.Dacl is string dacl) findings.Add(new("service-dacl", service, dacl));
            if (inspection.Sid is string sid) findings.Add(new("service-sid", service, sid));
            if (inspection.Recovery is string recovery) findings.Add(new("service-recovery", service, recovery));
        }
        findings.AddRange(FolderFindings(root));
        return (findings, types);
    }

    /// <summary>The folder findings of an agent root: agent = the root and current; plugins and updates when present. Safe by the PluginAcl rules with a protected DACL.</summary>
    internal static List<IntegrityFinding> FolderFindings(string root)
    {
        var findings = new List<IntegrityFinding>();
        foreach (var (target, folder, required) in Folders(root))
        {
            string? reason;
            try { reason = PluginAcl.Check(folder, requireProtected: true); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException) { reason = "unreadable"; }
            if (reason == "missing" && !required) continue;
            if (FolderFinding(Path.GetFileName(folder.TrimEnd(Path.DirectorySeparatorChar)), reason) is string finding) findings.Add(new(target, null, finding));
        }
        return findings;
    }
    internal static (string Target, string Folder, bool Required)[] Folders(string root) =>
        [("folder-agent", root, true), ("folder-agent", Path.Combine(root, "current"), true), ("folder-plugins", PluginFiles.Root(root), false), ("folder-staging", Path.Combine(root, "updates"), false)];
    /// <summary>The finding of one folder from its PluginAcl reason, for example "current inherited" or "ServerDesk ace S-1-5-11"; null when it is safe. Pure.</summary>
    internal static string? FolderFinding(string folder, string? reason) => reason is null ? null : IntegrityContract.Clean(folder + " " + reason, IntegrityContract.FindingLength);

    // The installer state, restored with the installer's own functions.
    private void Repair(List<IntegrityFinding> findings, bool applyPolicy)
    {
        void Try(string label, Action action) { try { action(); } catch (Exception e) { log("Integrity repair " + label + ": " + e.GetType().Name + ": " + e.Message); } }
        if (applyPolicy || findings.Any(item => item.Target.StartsWith("service-", StringComparison.Ordinal))) Try("services", () => NativeServiceSetup.ApplySecurityPolicy(names));
        if (findings.Any(item => item.Target == "folder-agent"))
        {
            Try("agent folder", () => AgentInstaller.SecureDirectory(root, recursive: false));
            // current: the protected Administrators/SYSTEM DACL plus the worker's read grant.
            Try("current folder", () => { AgentInstaller.SecureDirectory(Path.Combine(root, "current"), recursive: false); WorkerAccess.Repair(root); });
        }
        if (findings.Any(item => item.Target == "folder-plugins")) Try("plugin folder", () => PluginAcl.Protect(PluginFiles.Root(root)));
        if (findings.Any(item => item.Target == "folder-staging")) Try("update folder", () => AgentInstaller.SecureDirectory(Path.Combine(root, "updates")));
    }

    // The service registry keys of both services: a change of start type,
    // security, SID type, failure actions or the delete flag triggers a check
    // within 10 s.
    private string RegistryFingerprint()
    {
        var text = new StringBuilder();
        foreach (string name in new[] { names.Broker, names.Worker })
        {
            try
            {
                using var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\" + name);
                if (key is null) { text.Append(name).Append(":missing;"); continue; }
                foreach (string value in new[] { "Start", "DelayedAutostart", "ServiceSidType", "FailureActions", "FailureActionsOnNonCrashFailures", "DeleteFlag" }) text.Append(Describe(key.GetValue(value))).Append('|');
                using var security = key.OpenSubKey("Security");
                text.Append(Describe(security?.GetValue("Security"))).Append(';');
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Security.SecurityException) { text.Append(name).Append(":unreadable;"); }
        }
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text.ToString())));
        static string Describe(object? value) => value switch { null => "-", byte[] bytes => Convert.ToHexString(bytes), _ => Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) ?? "" };
    }

    // The watchdog over the worker (docs/agent-broker-worker.md, "Watchdog").
    private void Watch(bool isPlanned)
    {
        try
        {
            var (exists, state, pid) = WindowsService.Query(names.Worker);
            if (!exists) { workerPid = 0; stoppedChecks = 0; return; }
            DateTimeOffset now = clock();
            if (pid != workerPid)
            {
                // The worker process is gone or replaced. Without its worker-stopping
                // notice, and when the watchdog did not end it, it ended unexpectedly.
                bool noticed; lock (gate) { noticed = notices.Remove(workerPid); if (notices.Count > 8) notices.Clear(); }
                if (workerPid != 0 && !noticed && killedPid != workerPid && !isPlanned) Events.Add(IntegrityContract.Event("service-ended", now, service: "worker"));
                workerPid = pid; NoteRequest();
            }
            stoppedChecks = state == WorkerWatchdog.ServiceStopped ? stoppedChecks + 1 : 0;
            if (isPlanned) { stoppedChecks = 0; NoteRequest(); return; }
            // The start type matters only for a stopped worker; reading it costs a few SCM calls.
            string startType = stoppedChecks >= 2 ? NativeServiceSetup.Inspect(names.Worker, worker: true).StartType : "unknown";
            TimeSpan since = Stopwatch.GetElapsedTime(Volatile.Read(ref lastRequest));
            switch (WorkerWatchdog.Decide(state, startType, since, isPlanned, stoppedChecks))
            {
                case WatchdogAction.Start:
                    WindowsService.Start(names.Worker); stoppedChecks = 0;
                    Events.Add(IntegrityContract.Event("service-restarted", now, service: "worker"));
                    log("Watchdog: the worker service was stopped and was started again.");
                    break;
                case WatchdogAction.End:
                    // Only the process that the Service Control Manager runs as the worker.
                    if (pid > 0 && WindowsService.Query(names.Worker).ProcessId == pid)
                    {
                        using var process = Process.GetProcessById(pid);
                        process.Kill(); killedPid = pid; NoteRequest();
                        Events.Add(IntegrityContract.Event("service-hung", now, service: "worker"));
                        log("Watchdog: the worker made no request for " + (int)since.TotalSeconds + " s and was ended; its failure actions restart it.");
                    }
                    break;
            }
        }
        catch (Exception e) { log("Watchdog: " + e.GetType().Name + ": " + e.Message); }
    }

    private static JsonObject? ReadJson(string path)
    {
        try
        {
            var file = new FileInfo(path);
            if (!file.Exists || file.Length > 65536 || (file.Attributes & FileAttributes.ReparsePoint) != 0) return null;
            return JsonNode.Parse(File.ReadAllText(path)) as JsonObject;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Text.Json.JsonException) { return null; }
    }
}

/// <summary>
/// The worker's direct posts to POST /api/agent/integrity: the last message on
/// a stop and broker-unresponsive. The broker's queued events go through
/// AgentWorker.DeliverIntegrityAsync.
/// </summary>
internal static class WorkerIntegrity
{
    internal static readonly TimeSpan StopContextTimeout = TimeSpan.FromSeconds(2), StopPostBudget = TimeSpan.FromSeconds(5), BrokerOutage = TimeSpan.FromMinutes(3);
    /// <summary>Whether either service is marked for deletion (DeleteFlag in its registry key): sc.exe delete while it runs.</summary>
    internal static bool MarkedForDeletion()
    {
        foreach (string name in new[] { BrokerProtocol.BrokerService, BrokerProtocol.WorkerService })
        {
            try { using var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\" + name); if (key?.GetValue("DeleteFlag") is int flag && flag != 0) return true; }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Security.SecurityException) { }
        }
        return false;
    }
    /// <summary>The last message of a worker STOP outside a planned context: agent-removed (service-deleted) or service-stopped (worker). Null in a planned context. Pure.</summary>
    internal static JsonObject? StopEvent(bool planned, bool deleted, DateTimeOffset now) =>
        planned ? null : deleted ? IntegrityContract.Event("agent-removed", now, reason: "service-deleted") : IntegrityContract.Event("service-stopped", now, service: "worker");
    /// <summary>Whether the worker reports the broker as unresponsive now: every call failed for 3 minutes and this outage was not reported yet. Pure.</summary>
    internal static bool BrokerUnresponsive(TimeSpan sinceLastAnswer, bool reported) => !reported && sinceLastAnswer >= BrokerOutage;
    internal static JsonObject Payload(JsonObject config, IEnumerable<JsonObject> events) => new() { ["serverId"] = config["id"]!.DeepClone(), ["events"] = new JsonArray(events.Select(item => (JsonNode)item.DeepClone()).ToArray()) };
    /// <summary>The accepted event IDs of the portal's answer.</summary>
    internal static List<string> Accepted(JsonObject reply) => (reply["accepted"] as JsonArray ?? []).Select(item => item is JsonValue value && value.TryGetValue<string>(out var id) ? id : null).Where(id => id is not null).Select(id => id!).ToList();

    /// <summary>
    /// --uninstall (not detached): agent-removed (local-uninstall) with the
    /// elevated Windows user, posted with an in-memory device token client from
    /// config.bin within 10 s. False when the portal was not informed; the
    /// uninstall continues either way.
    /// </summary>
    internal static async Task<bool> ReportLocalUninstallAsync(string root, Action<string> output)
    {
        try
        {
            string configPath = Path.Combine(root, "config.bin");
            if (!File.Exists(configPath)) { output("The portal was not informed: no device registration found."); return false; }
            var config = LocalStore.ReadProtected(configPath);
            string user; using (var identity = System.Security.Principal.WindowsIdentity.GetCurrent()) user = identity.Name;
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            // In memory only, like the installer's download: no token state is written.
            using var http = DeviceTokenClient.CreateHttp(config, TimeSpan.FromSeconds(10), stateDirectory: null, baseAddress: true);
            var reply = await AgentHttpTransport.PostAsync(http, IntegrityContract.Route, Payload(config, [IntegrityContract.Event("agent-removed", DateTimeOffset.UtcNow, reason: "local-uninstall", user: user)]), deadline.Token, config);
            bool informed = Accepted(reply).Count == 1;
            output(informed ? "The portal was informed that the agent is removed." : "The portal did not confirm the removal report.");
            return informed;
        }
        catch (Exception e) { output("The portal was not informed about the removal: " + e.GetType().Name + "."); return false; }
    }
}
