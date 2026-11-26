using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// The unprivileged half of the agent: NT SERVICE\ServerDeskWorker, a
// virtual account without SeImpersonate or other
// administrator privileges. It owns every portal connection, the device
// bearer and telemetry parsing. Anything that changes the host is forwarded
// as the portal's signed envelope to the SYSTEM broker, which verifies it
// independently. A compromise of this process therefore does not yield SYSTEM.
internal sealed class AgentWorker
{
    private readonly string root, data;
    private readonly JsonObject config;
    private readonly HttpClient http, downloads;
    private readonly BrokerClient broker = new();
    private readonly NativeTelemetryCollector telemetry;
    private readonly WorkerRelayExecutor relay;
    private readonly WorkerIsolation isolation;
    private readonly object snapshotGate = new();
    private JsonObject snapshot;
    private CancellationToken stopping;
    private int unsignedReported;
    private readonly SoftwareUploadPolicy softwareUploads = new(), driverUploads = new(), autostartUploads = new();

    internal AgentWorker(string root)
    {
        this.root = root; data = BrokerProtocol.WorkerRoot(root);
        isolation = WorkerIsolation.Inspect();
        config = LocalStore.ReadProtected(BrokerProtocol.WorkerConfigPath(root));
        string origin = config["origin"]!.GetValue<string>();
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var url) || url.Scheme != "https" || url.AbsolutePath != "/" || !string.IsNullOrEmpty(url.UserInfo) || url.Query != "" || url.Fragment != "") throw new InvalidDataException("An HTTPS origin is required");
        if (config["privateKey"] is not null) throw new InvalidDataException("The worker configuration must not contain the device key.");
        Func<JsonObject, CancellationToken, Task<string>> signer = async (challenge, token) =>
            (await broker.CallAsync("sign", new JsonObject { ["op"] = "sign-renewal", ["challenge"] = challenge.DeepClone() }, TimeSpan.FromSeconds(15), token))["signature"]!.GetValue<string>();
        http = DeviceTokenClient.CreateHttp(config, TimeSpan.FromSeconds(15), data, signer, baseAddress: true);
        downloads = DeviceTokenClient.CreateHttp(config, TimeSpan.FromMinutes(5), data, signer);
        telemetry = new NativeTelemetryCollector(root, config, Privileged);
        snapshot = NativeTelemetryCollector.CreateBaseSnapshot(root, config);
        relay = new WorkerRelayExecutor(http, downloads, config, data);
    }

    internal async Task RunAsync(ServiceStop service)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(service.Token);
        CancellationToken token = stopping = lifetime.Token;
        LogSafe("Worker started. Version=" + Program.Version + ", account=" + isolation.Account + ", privileges=" + string.Join(",", isolation.Privileges));
        var inventory = telemetry.RunAsync(token);
        var heartbeat = HeartbeatLoopAsync(token); var telemetrySnapshots = TelemetryLoopAsync(token);
        var terminalTransport = TerminalLoopAsync(token); var relayTransport = RelayLoopAsync(token);
        var brokerWatch = BrokerWatchLoopAsync(token);
        try { await ChannelLoopAsync(token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        finally
        {
            lifetime.Cancel();
            // The last message runs beside the loops' shutdown and fits the 15 s stop wait hint.
            var last = service.Control != 0 ? StoppingAsync(service) : Task.CompletedTask;
            try { await Task.WhenAll(terminalTransport, relayTransport, heartbeat, telemetrySnapshots, inventory, brokerWatch); } catch (OperationCanceledException) { }
            await last;
            await telemetry.StopAsync();
            await broker.DisposeAsync();
            http.Dispose(); downloads.Dispose();
        }
    }

    // STOP (not SHUTDOWN) outside a planned context: one event straight to the
    // portal within 5 s (agent-removed when a service is marked for deletion,
    // otherwise service-stopped). Then, on STOP and SHUTDOWN, the notice
    // worker-stopping, so that the broker does not count this end as unexpected.
    // A failure never delays the stop further.
    private async Task StoppingAsync(ServiceStop service)
    {
        string reason = service.Shutdown ? "shutdown" : "stop";
        try
        {
            if (service.Stopped)
            {
                bool planned = false;
                try { planned = (await broker.CallAsync("stop", new JsonObject { ["op"] = "stop-context" }, WorkerIntegrity.StopContextTimeout, CancellationToken.None))["planned"]?.GetValue<bool>() == true; }
                catch (Exception e) { LogSafe("Stop context: " + Describe(e)); }
                if (WorkerIntegrity.StopEvent(planned, WorkerIntegrity.MarkedForDeletion(), DateTimeOffset.UtcNow) is JsonObject last)
                {
                    using var budget = new CancellationTokenSource(WorkerIntegrity.StopPostBudget);
                    try { await PostAsync(IntegrityContract.Route, WorkerIntegrity.Payload(config, [last]), budget.Token); LogSafe("Stop reported to the portal: " + last["kind"]); }
                    catch (Exception e) { LogSafe("Stop report: " + Describe(e)); }
                }
            }
        }
        finally
        {
            try { await broker.CallAsync("stop", new JsonObject { ["op"] = "worker-stopping", ["reason"] = reason }, WorkerIntegrity.StopContextTimeout, CancellationToken.None); }
            catch (Exception e) { LogSafe("Stop notice: " + Describe(e)); }
        }
    }

    // The broker's queued integrity events go to POST /api/agent/integrity; the
    // accepted ones are deleted with integrity-ack. One delivery at a time; a
    // failed one is retried after 30 s at the earliest.
    private int integrityBusy;
    private long integrityRetryAt;
    private void RequestIntegrityDelivery()
    {
        if (Environment.TickCount64 < Interlocked.Read(ref integrityRetryAt) || Interlocked.CompareExchange(ref integrityBusy, 1, 0) != 0) return;
        _ = Task.Run(async () =>
        {
            try
            {
                var status = await Broker("integrity", new JsonObject { ["op"] = "status" }, 15, stopping);
                if (status["integrityEvents"] is not JsonArray events || events.Count == 0) return;
                var reply = await PostAsync(IntegrityContract.Route, WorkerIntegrity.Payload(config, events.OfType<JsonObject>()), stopping);
                var accepted = WorkerIntegrity.Accepted(reply);
                if (accepted.Count > 0) await Broker("integrity", new JsonObject { ["op"] = "integrity-ack", ["ids"] = new JsonArray(accepted.Select(id => (JsonNode)JsonValue.Create(id)!).ToArray()) }, 15, stopping);
            }
            catch (Exception e) when (!stopping.IsCancellationRequested)
            {
                // A portal without the route (404) or one that refuses the report (400) is asked again after 10 minutes, other failures after 30 s.
                bool refused = e is AgentHttpException { StatusCode: System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.BadRequest };
                Interlocked.Exchange(ref integrityRetryAt, Environment.TickCount64 + (refused ? 600_000 : 30_000)); LogSafe("Integrity events: " + Describe(e));
            }
            catch (Exception) { }
            finally { Interlocked.Exchange(ref integrityBusy, 0); }
        }, CancellationToken.None);
    }

    // The worker watches the broker: when every broker call failed or timed out
    // for 3 minutes, it posts broker-unresponsive once per outage. It never
    // starts or ends the broker; it has no right to.
    private async Task BrokerWatchLoopAsync(CancellationToken token)
    {
        bool reported = false;
        while (!token.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(15), token);
            TimeSpan since = broker.SinceLastAnswer;
            if (since < WorkerIntegrity.BrokerOutage) { reported = false; continue; }
            if (!WorkerIntegrity.BrokerUnresponsive(since, reported)) continue;
            try
            {
                var outage = IntegrityContract.Event("broker-unresponsive", DateTimeOffset.UtcNow - since, service: "broker");
                await PostAsync(IntegrityContract.Route, WorkerIntegrity.Payload(config, [outage]), token);
                reported = true; LogSafe("The broker did not answer for " + (int)since.TotalSeconds + " s; reported to the portal.");
            }
            catch (Exception e) when (!token.IsCancellationRequested) { LogSafe("Broker outage report: " + Describe(e)); }
        }
    }

    private Task<JsonObject> Broker(string lane, JsonObject request, int seconds, CancellationToken token) => broker.CallAsync(lane, request, TimeSpan.FromSeconds(seconds), token);

    // The broker call of a privileged read waits for the collector's deadline
    // plus 15 s, at least 45 s (NativeDriverInventory: 45 s deadline, 60 s call).
    internal const int MinimumPrivilegedCallSeconds = 45;
    internal static int PrivilegedCallSeconds(int deadlineSeconds) => Math.Max(MinimumPrivilegedCallSeconds, deadlineSeconds + 15);

    private JsonObject Privileged(string name, int deadlineSeconds)
    {
        var reply = Broker("telemetry:" + name, new JsonObject { ["op"] = "telemetry", ["name"] = name }, PrivilegedCallSeconds(deadlineSeconds), stopping).GetAwaiter().GetResult();
        return reply["value"] as JsonObject ?? new JsonObject();
    }

    private static JsonArray Signed(JsonObject reply, string name)
    {
        var items = new JsonArray();
        foreach (var item in reply[name] as JsonArray ?? new JsonArray()) items.Add(item?.DeepClone());
        return items;
    }

    private async Task ChannelLoopAsync(CancellationToken token)
    {
        var backoff = new PortalRetryBackoff();
        while (!token.IsCancellationRequested)
        {
            int interval = 5000; bool busy = false; string? uninstallJob = null;
            try
            {
                var state = await Broker("channel", new JsonObject { ["op"] = "channel-state", ["rdpActive"] = false }, 30, token);
                if (state["refreshInventory"]?.GetValue<bool>() == true) telemetry.RequestRefresh();
                // Integrity events reach the portal within 15 s (the channel polls every 5 s at most).
                if (state["integrityPending"]?.GetValue<bool>() == true) RequestIntegrityDelivery();
                var results = state["results"] as JsonArray ?? new JsonArray(); var transferStates = state["transfers"] as JsonArray ?? new JsonArray();
                var request = new JsonObject { ["serverId"] = config["id"]!.DeepClone(), ["results"] = results.DeepClone(), ["runningJobs"] = state["runningJobs"]?.DeepClone() ?? new JsonArray(), ["transfers"] = transferStates.DeepClone() };
                var headers = UninstallChannel.Headers(state["uninstallJob"]?.GetValue<string>());
                uninstallJob = headers.Length > 0 ? headers[0].Value : null;
                var reply = await PostAsync("/api/agent/channel", request, token, headers);
                backoff.Success();
                int plain = (reply["jobs"] as JsonArray)?.Count ?? 0, signed = (reply["signedJobs"] as JsonArray)?.Count ?? 0;
                if (plain > signed && Interlocked.Exchange(ref unsignedReported, 1) == 0) LogSafe("The portal offered jobs without signatures. Configure AGENT_JOB_SIGNING_KEY on the portal; unsigned work is never executed.");
                await Broker("channel", new JsonObject
                {
                    ["op"] = "channel-apply", ["results"] = results.DeepClone(), ["transferStates"] = transferStates.DeepClone(),
                    ["jobs"] = Signed(reply, "signedJobs"), ["transfers"] = Signed(reply, "signedTransfers"),
                    ["driftPolicy"] = reply["signedDriftPolicy"]?.DeepClone(), ["pluginPolicy"] = reply["signedPluginPolicy"]?.DeepClone()
                }, 30, token);
                interval = Math.Clamp(reply["intervalMs"]?.GetValue<int>() ?? 5000, 250, 5000);
                busy = state["transfersBusy"]?.GetValue<bool>() == true;
                if (state["jobsBusy"]?.GetValue<bool>() == true || signed > 0 || results.Count > 0) interval = Math.Min(interval, 300);
            }
            catch (Exception e) when (!token.IsCancellationRequested)
            {
                // A proxy, portal or broker outage waits longer with each attempt and logs at most one line per 30 s.
                var retry = backoff.Failed(e, DateTimeOffset.UtcNow);
                if (retry.Log) LogSafe("Channel: " + Describe(e));
                interval = Math.Max(interval, retry.DelayMs);
                // Only the portal's proof goes to the broker: 403 AGENT_UNINSTALL_CONFIRMED
                // or 409 AGENT_UNINSTALL_NOT_CONFIRMED for the job this post named.
                // A 401 or another 403, for example from a proxy, is only logged.
                if (UninstallChannel.BrokerSignal(e, uninstallJob) is JsonObject signal)
                {
                    try { await Broker("channel", signal, 30, token); }
                    catch (Exception refused) when (!token.IsCancellationRequested) { LogSafe("Channel uninstall signal: " + Describe(refused)); }
                }
            }
            if (busy) interval = Math.Min(interval, 300);
            await Task.Delay(interval, token);
        }
    }

    // The shells run in the broker. This loop only carries frames between the
    // portal and the broker; ConPTY output wakes the broker's snapshot wait.
    private async Task TerminalLoopAsync(CancellationToken token)
    {
        int wait = 0;
        var backoff = new PortalRetryBackoff();
        while (!token.IsCancellationRequested)
        {
            DateTimeOffset started = DateTimeOffset.UtcNow; bool failed = false; int retryDelay = 0;
            try
            {
                var snap = await Broker("terminal", new JsonObject { ["op"] = "terminal-snapshot", ["waitMs"] = wait }, 15, token);
                started = DateTimeOffset.UtcNow;
                var reply = await PostAsync("/api/agent/terminal", new JsonObject { ["serverId"] = config["id"]!.DeepClone(), ["terminals"] = snap["terminals"]?.DeepClone() ?? new JsonArray() }, token);
                backoff.Success();
                var offered = reply["terminals"] as JsonArray ?? throw new InvalidDataException("Missing authoritative terminal list");
                await Broker("terminal", new JsonObject { ["op"] = "terminal-accept", ["terminals"] = offered.DeepClone(), ["lease"] = reply["terminalLease"]?.DeepClone() }, 30, token);
                wait = Math.Clamp(reply["intervalMs"]?.GetValue<int>() ?? 180, 100, 1000);
            }
            catch (Exception e) when (!token.IsCancellationRequested)
            {
                failed = true; wait = 0;
                // A portal or broker outage waits 2 to 30 s and logs at most one line per 30 s.
                var retry = backoff.Failed(e, DateTimeOffset.UtcNow);
                if (retry.Log) LogSafe("Terminal channel: " + Describe(e));
                retryDelay = retry.DelayMs;
            }
            if (failed) await Task.Delay(Math.Max(1000, retryDelay), token);
            // Minimum request spacing protects the endpoint during tiny output bursts.
            int remaining = 80 - (int)(DateTimeOffset.UtcNow - started).TotalMilliseconds;
            if (remaining > 0) await Task.Delay(remaining, token);
        }
    }

    private async Task RelayLoopAsync(CancellationToken token)
    {
        // While the broker is down, wait 2 to 30 s and log at most one line per 30 s.
        var backoff = new PortalRetryBackoff();
        while (!token.IsCancellationRequested)
        {
            try
            {
                var taken = await Broker("relay", new JsonObject { ["op"] = "relay-take", ["waitMs"] = 10000 }, 30, token);
                backoff.Success();
                foreach (var item in taken["requests"] as JsonArray ?? new JsonArray())
                {
                    long id = item!["id"]!.GetValue<long>(); var request = item["request"] as JsonObject ?? new JsonObject();
                    _ = Task.Run(() => ExecuteRelayAsync(id, request, token), CancellationToken.None);
                }
            }
            catch (Exception e) when (!token.IsCancellationRequested)
            {
                var retry = backoff.Failed(e, DateTimeOffset.UtcNow);
                if (retry.Log) LogSafe("Broker relay: " + e.Message);
                await Task.Delay(Math.Max(1000, retry.DelayMs), token);
            }
        }
    }

    private async Task ExecuteRelayAsync(long id, JsonObject request, CancellationToken token)
    {
        JsonObject? result = null; string? error = null;
        try { result = await relay.ExecuteAsync(request, token); }
        catch (Exception e) { error = AgentHttpTransport.RedactDiagnostic(e.Message, config); }
        try { await Broker("relay-reply", new JsonObject { ["op"] = "relay-complete", ["id"] = id, ["result"] = result, ["error"] = error }, 30, token); }
        catch (Exception e) when (!token.IsCancellationRequested) { LogSafe("Broker relay reply: " + e.Message); }
    }

    internal Task<JsonObject> PostAsync(string path, JsonObject payload, CancellationToken token, IEnumerable<KeyValuePair<string, string>>? headers = null) => AgentHttpTransport.PostAsync(http, path, payload, token, config, headers);

    private async Task HeartbeatLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                var status = await Broker("status", new JsonObject { ["op"] = "status" }, 15, token);
                var identity = broker.Hello ?? throw new InvalidOperationException("The broker identity is not available yet.");
                JsonObject latest;
                lock (snapshotGate) latest = snapshot.DeepClone().AsObject();
                string mode = status["mode"]?.GetValue<string>() == "Management" ? "Management" : "ReadOnly";
                latest["publicKey"] = identity["publicKey"]?.DeepClone();
                latest["protocolVersion"] = 3; latest["agentVersion"] = Program.Version;
                latest["mode"] = mode; latest["management"] = mode == "Management";
                // A scan that the portal started and that still runs (4.15.0); absent otherwise. A top-level key, so older portals drop it.
                if (status["defenderScan"] is JsonObject defenderScan) latest["defenderScan"] = defenderScan.DeepClone(); else latest.Remove("defenderScan");
                latest["agentIsolation"] = isolation.ToJson(identity["version"]?.GetValue<string>() ?? "");
                // The broker's integrity check (4.18.0): start types and the protection findings still open after its repair. A top-level key, so older portals drop it.
                if (status["integrity"] is JsonObject integrity && integrity.ContainsKey("checkedAt")) latest["agentIntegrity"] = integrity.DeepClone(); else latest.Remove("agentIntegrity");
                if (status["integrityEvents"] is JsonArray { Count: > 0 }) RequestIntegrityDelivery();
                // Remote Desktop needs the broker-held device key to open its
                // session key; it is not offered by the split agent.
                // release-paths (4.12.0): the agent verifies path-form release manifests.
                // plugin-host (4.16.0): the broker installs, verifies and runs signed agent plugins (docs/agent-plugins.md).
                // assistant-powershell (4.17.0): a PowerShell script from the device assistant (docs/ai-assistant.md).
                // plugin-secrets (4.17.0): a plugin job gets its sealed secrets, for example the DHCP failover shared secret.
                // agent-integrity (4.18.0): the snapshot agentIntegrity and the events of POST /api/agent/integrity (docs/native-agent-v4.md).
                // plugin-ad-identity (4.19.0): the ad-sign-in job, and plugin changes run as the signed-in account.
                latest["agentCapabilities"] = new JsonArray(JobRunner.ManagementActions.Concat(JobRunner.AdditionalManagementCapabilities).Concat(JobRunner.DiagnosticActions).Concat(JobRunner.FileActions).Concat(JobRunner.StorageActions).Concat(JobRunner.DesiredStateActions).Concat(JobRunner.DefenderActions).Concat(JobRunner.AssistantActions).Concat(new[] { "terminal", "terminal-multi", "terminal-live", "files", "agent-update", "agent-uninstall", "runbook-step", "drift", "native-agent", "signed-dispatch", "release-paths", "defender-status", "plugin-host", "plugin-secrets", PluginIdentity.Capability, JobConcurrency.Capability, IntegrityContract.Capability }).Select(name => (JsonNode)JsonValue.Create(name)!).ToArray());
                // The plugins the broker verified, at most 16.
                if (status["plugins"] is JsonArray plugins) latest["plugins"] = new JsonArray(plugins.Take(16).Select(item => item?.DeepClone()).ToArray());
                var answer = await PostAsync("/api/heartbeat", new JsonObject { ["serverId"] = config["id"]!.DeepClone(), ["snapshot"] = latest, ["results"] = new JsonArray(), ["runningJobs"] = status["runningJobs"]?.DeepClone() ?? new JsonArray() }, token);
                static string? Text(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
                static bool Flag(JsonNode? node) => node is JsonValue value && value.TryGetValue<bool>(out bool flag) && flag;
                softwareUploads.Heartbeat(Text(latest["softwareChecksum"]), Flag(answer["softwareResync"]));
                driverUploads.Heartbeat(Text(latest["driverHealth"]?["checksum"]), Flag(answer["driverResync"]));
                autostartUploads.Heartbeat(Text(latest["autostartChecksum"]), Flag(answer["autostartResync"]));
                await UploadListAsync(telemetry.Software, softwareUploads, "/api/agent/software", "Software inventory", token);
                await UploadListAsync(telemetry.Drivers, driverUploads, "/api/agent/drivers", "Driver inventory", token);
                await UploadListAsync(telemetry.Autostart, autostartUploads, "/api/agent/autostart", "Autostart inventory", token);
                // Written only after the portal accepted a heartbeat from this
                // worker while the broker of the same version answered.
                LocalStore.Json(BrokerProtocol.WorkerHealthPath(root), new JsonObject { ["version"] = Program.Version, ["brokerVersion"] = identity["version"]?.DeepClone(), ["at"] = DateTimeOffset.UtcNow.ToString("O") });
            }
            catch (Exception e) when (!token.IsCancellationRequested) { LogSafe("Heartbeat: " + Describe(e)); }
            await Task.Delay(30000, token);
        }
    }

    // The software, driver and autostart lists go to the portal only when their
    // checksum changed or the portal asked for them (SoftwareUploadPolicy, one per
    // list); never with every heartbeat.
    private async Task UploadListAsync(JsonObject? list, SoftwareUploadPolicy policy, string path, string label, CancellationToken token)
    {
        string? checksum = list?["checksum"] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
        if (list is null || checksum is null || !policy.ShouldUpload(checksum, DateTimeOffset.UtcNow)) return;
        try
        {
            await PostAsync(path, new JsonObject { ["serverId"] = config["id"]!.DeepClone(), ["checksum"] = checksum, ["count"] = list["count"]?.DeepClone(), ["truncated"] = list["truncated"]?.DeepClone(), ["items"] = list["items"]?.DeepClone() ?? new JsonArray() }, token);
            policy.Succeeded(checksum, DateTimeOffset.UtcNow);
        }
        catch (Exception e) when (!token.IsCancellationRequested) { policy.Failed(DateTimeOffset.UtcNow); LogSafe(label + " upload: " + Describe(e)); }
    }

    private async Task TelemetryLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                JsonObject collected = await telemetry.CollectAsync(token);
                lock (snapshotGate) snapshot = collected;
            }
            catch (Exception e) when (!token.IsCancellationRequested) { LogSafe("Native telemetry: " + e.GetType().Name); }
            await Task.Delay(TimeSpan.FromSeconds(NativeTelemetryCollector.RefreshSeconds), token);
        }
    }
    // TLS and socket failures only say what went wrong in their inner exceptions.
    private static string Describe(Exception e) { var parts = new List<string>(); for (Exception? x = e; x is not null && parts.Count < 4; x = x.InnerException) parts.Add(x.Message); return string.Join(" -> ", parts); }
    private void LogSafe(string message) => LocalStore.Log(data, AgentHttpTransport.RedactDiagnostic(message, config));
}

// The wait of the channel, terminal and relay loops after a failed portal or
// broker request. Transient failures (HTTP 502/503/504 from a proxy, no
// connection, an HTTP timeout, and a broker that is not reachable: its pipe
// cannot be opened, broke or ended, or it refused the hello during an update)
// wait 2, 4, 8, 16 and then 30 s, the heartbeat period; the next successful
// iteration resets the series. Each series logs its first failure and then at
// most one line per 30 s. Other failures, a broker timeout among them, keep
// the loop's own wait and are always logged.
internal sealed class PortalRetryBackoff
{
    internal const int CapMilliseconds = 30_000;
    private static readonly int[] Steps = [2_000, 4_000, 8_000, 16_000, CapMilliseconds];
    private static readonly TimeSpan LogSpacing = TimeSpan.FromSeconds(30);
    private int failures;
    private DateTimeOffset lastLogged;
    /// <summary>The number of transient failures since the last success.</summary>
    internal int Failures => failures;

    internal static bool IsTransient(Exception error) => error switch
    {
        AgentHttpException http => http.StatusCode is System.Net.HttpStatusCode.BadGateway or System.Net.HttpStatusCode.ServiceUnavailable or System.Net.HttpStatusCode.GatewayTimeout,
        HttpRequestException request => request.StatusCode is null,
        // The broker turns its own timeouts into TimeoutException; a canceled request with a live loop is an HTTP timeout.
        OperationCanceledException => true,
        // The broker is not reachable, for example while it restarts or an update replaces it.
        BrokerUnavailableException => true,
        BrokerException broker => broker.Code == CollectorErrorCodes.BrokerUnavailable,
        _ => false
    };

    /// <summary>The minimum wait in milliseconds after this failure (0 when it is not transient) and whether to log it.</summary>
    internal (int DelayMs, bool Log) Failed(Exception error, DateTimeOffset now)
    {
        if (!IsTransient(error)) return (0, true);
        int delay = Steps[Math.Min(failures, Steps.Length - 1)];
        failures = Math.Min(failures + 1, Steps.Length + 1);
        bool log = failures == 1 || now - lastLogged >= LogSpacing;
        if (log) lastLogged = now;
        return (delay, log);
    }

    internal void Success() { failures = 0; lastLogged = default; }
}

// The worker refuses to run with more rights than intended and reports what
// it actually holds, so a misconfigured service is visible in the portal.
internal sealed class WorkerIsolation
{
    private static readonly string[] Forbidden = ["SeImpersonatePrivilege", "SeAssignPrimaryTokenPrivilege", "SeTcbPrivilege", "SeDebugPrivilege", "SeBackupPrivilege", "SeRestorePrivilege", "SeTakeOwnershipPrivilege", "SeLoadDriverPrivilege", "SeCreateTokenPrivilege", "SeSecurityPrivilege", "SeManageVolumePrivilege"];
    internal string Account { get; }
    internal string[] Privileges { get; }
    private WorkerIsolation(string account, string[] privileges) { Account = account; Privileges = privileges; }

    internal static WorkerIsolation Inspect()
    {
        using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        string sid = identity.User?.Value ?? "";
        if (sid != BrokerProtocol.WorkerSid) throw new UnauthorizedAccessException("The worker must run as NT SERVICE\\" + BrokerProtocol.WorkerService + ", not " + sid + ".");
        if (new System.Security.Principal.WindowsPrincipal(identity).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator)) throw new UnauthorizedAccessException("The worker token is a member of Administrators.");
        string[] privileges = TokenPrivileges(identity.Token);
        string[] excess = privileges.Intersect(Forbidden, StringComparer.OrdinalIgnoreCase).ToArray();
        if (excess.Length > 0) throw new UnauthorizedAccessException("The worker token holds " + string.Join(", ", excess) + ". Reinstall the agent to restore the worker's privilege limits.");
        return new WorkerIsolation("NT SERVICE\\" + BrokerProtocol.WorkerService, privileges);
    }

    internal JsonObject ToJson(string brokerVersion) => new() { ["split"] = true, ["brokerVersion"] = brokerVersion, ["account"] = Account, ["elevated"] = false, ["privileges"] = new JsonArray(Privileges.Select(name => (JsonNode)JsonValue.Create(name)!).ToArray()) };

    [System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int type, IntPtr buffer, int length, out int needed);
    [System.Runtime.InteropServices.DllImport("advapi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)] private static extern bool LookupPrivilegeNameW(string? system, ref long luid, StringBuilder name, ref int length);
    private static string[] TokenPrivileges(IntPtr token)
    {
        GetTokenInformation(token, 3, IntPtr.Zero, 0, out int needed);
        if (needed is < 4 or > 65536) throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
        IntPtr buffer = System.Runtime.InteropServices.Marshal.AllocHGlobal(needed);
        try
        {
            if (!GetTokenInformation(token, 3, buffer, needed, out _)) throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
            int count = System.Runtime.InteropServices.Marshal.ReadInt32(buffer); var names = new List<string>();
            for (int i = 0; i < Math.Min(count, 64); i++)
            {
                long luid = System.Runtime.InteropServices.Marshal.ReadInt64(buffer, 4 + i * 12);
                var name = new StringBuilder(64); int length = name.Capacity;
                if (LookupPrivilegeNameW(null, ref luid, name, ref length)) names.Add(name.ToString());
            }
            return names.Order(StringComparer.Ordinal).ToArray();
        }
        finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(buffer); }
    }
}

// A successful heartbeat is an acknowledgement from the portal, not merely
// a running local service. Cancellation must also stop a never-ready channel.
internal sealed class AgentHeartbeatGate
{
    private readonly TaskCompletionSource acknowledged = new(TaskCreationOptions.RunContinuationsAsynchronously);
    internal void Acknowledge() => acknowledged.TrySetResult();
    internal async Task RunAsync(Func<CancellationToken, Task> transport, CancellationToken token)
    {
        await acknowledged.Task.WaitAsync(token); token.ThrowIfCancellationRequested();
        await transport(token);
    }
}

// The worker's part of the uninstall confirmation: the header that names the
// armed uninstall job on a channel post, and the only portal answers that go to
// the broker. A 401, a 403 without the portal's code (a proxy or WAF can send
// those) and every other failure stay a log line.
internal static class UninstallChannel
{
    internal const string Header = "X-ServerDesk-Uninstall-Job";
    internal const string NotConfirmedCode = "AGENT_UNINSTALL_NOT_CONFIRMED";
    /// <summary>The channel post's extra headers: the armed job ID when there is one, otherwise none.</summary>
    internal static KeyValuePair<string, string>[] Headers(string? armedJob) => Guid.TryParseExact(armedJob, "D", out _) ? [new(Header, armedJob!)] : [];
    /// <summary>The broker request for a failed channel post that carried `sentJob` in the header, or null.</summary>
    internal static JsonObject? BrokerSignal(Exception error, string? sentJob)
    {
        if (sentJob is null || error is not AgentHttpException http) return null;
        if (http.StatusCode == System.Net.HttpStatusCode.Forbidden && http.Code == PortalUninstall.ConfirmedCode) return new JsonObject { ["op"] = "channel-refused", ["uninstallJob"] = sentJob, ["code"] = http.Code };
        if (http.StatusCode == System.Net.HttpStatusCode.Conflict && http.Code == NotConfirmedCode) return new JsonObject { ["op"] = "channel-unconfirmed", ["uninstallJob"] = sentJob };
        return null;
    }
}

/// <summary>A portal answer outside 2xx, with the `code` of its bounded JSON error body when it has a valid one.</summary>
internal sealed class AgentHttpException(string message, System.Net.HttpStatusCode status, string? code) : HttpRequestException(message, null, status)
{
    internal string? Code { get; } = code;
}

internal static class AgentHttpTransport
{
    private const int MaximumResponseBytes = 2_097_152, MaximumErrorBytes = 8192;
    internal static async Task<JsonObject> PostAsync(HttpClient http, string path, JsonObject payload, CancellationToken token, JsonObject? config = null, IEnumerable<KeyValuePair<string, string>>? headers = null)
    {
        // ResponseHeadersRead ends HttpClient's timeout after the headers. Keep
        // the same deadline over bounded body reads, including a stalled proxy.
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        if (http.Timeout != Timeout.InfiniteTimeSpan) deadline.CancelAfter(http.Timeout);
        CancellationToken requestToken = deadline.Token;
        using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json") };
        foreach (var header in headers ?? []) request.Headers.Add(header.Key, header.Value);
        // Do not buffer an unbounded error page or success response before the
        // size check. Only the portal's bounded JSON error fields are logged.
        using var reply = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, requestToken);
        if (!reply.IsSuccessStatusCode)
        {
            string detail = ""; string? errorCode = null;
            if (reply.Content.Headers.ContentType?.MediaType == "application/json")
            {
                try
                {
                    byte[] bytes = await ReadBoundedAsync(reply.Content, MaximumErrorBytes, requestToken);
                    if (JsonNode.Parse(bytes) is JsonObject error)
                    {
                        if (error["error"] is JsonValue message && message.TryGetValue<string>(out string? text) && text is not null)
                        {
                            string safe = RedactDiagnostic(text, config ?? new JsonObject()); detail = ": " + safe[..Math.Min(500, safe.Length)];
                        }
                        if (error["code"] is JsonValue code && code.TryGetValue<string>(out string? value) && value is not null && value.Length is > 0 and <= 80 && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')) { detail += " [" + value + "]"; errorCode = value; }
                    }
                }
                catch (Exception e) when (e is System.Text.Json.JsonException or InvalidDataException) { }
            }
            throw new AgentHttpException("HTTP " + (int)reply.StatusCode + " from " + path + detail, reply.StatusCode, errorCode);
        }
        byte[] json = await ReadBoundedAsync(reply.Content, MaximumResponseBytes, requestToken);
        var parsed = JsonNode.Parse(json) as JsonObject ?? throw new InvalidDataException("Invalid server response");
        // Internal transport metadata comes only from this authenticated HTTPS
        // response. RTC leases use it to tolerate a skewed device wall clock.
        parsed.Remove("_httpServerDate");
        if ((path == "/api/agent/rdp" || path.StartsWith("/api/agent/token/", StringComparison.Ordinal)) && reply.Headers.Date is { } serverDate) parsed["_httpServerDate"] = serverDate.ToString("O");
        return parsed;
    }
    internal static async Task<byte[]> ReadBoundedAsync(HttpContent content, int maximum, CancellationToken token)
    {
        if (content.Headers.ContentLength > maximum) throw new InvalidDataException("Oversized server response");
        using Stream stream = await content.ReadAsStreamAsync(token); using var bytes = new MemoryStream(); byte[] buffer = new byte[4096];
        while (true)
        {
            int count = await stream.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, maximum - (int)bytes.Length + 1)), token);
            if (count == 0) return bytes.ToArray();
            if (bytes.Length + count > maximum) throw new InvalidDataException("Oversized server response");
            bytes.Write(buffer, 0, count);
        }
    }
    internal static string RedactDiagnostic(string message, JsonObject config)
    {
        string redacted = SecretMask.Apply(message, new[] { "token", "privateKey" }.Select(name => config[name] is JsonValue value && value.TryGetValue<string>(out string? text) ? text ?? "" : "").Concat(DeviceTokenClient.SensitiveTokens()));
        return new string(redacted.Select(c => char.IsControl(c) ? ' ' : c).Take(1500).ToArray());
    }
}
