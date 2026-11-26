using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json.Nodes;
using ServerDesk.Plugins;

namespace ServerDesk.Agent;

// The SYSTEM half of the agent. It holds config.bin, the device key and the
// pinned job-signing key, and it is the only process that changes the host:
// jobs, terminals, file commits, drift scans and updates. It opens no network
// connection. It accepts work only from the worker service over a local pipe,
// and only when the portal's signature, the device ID, the expiry, the
// durable claim marker, the action allowlist and the local mode all agree.
internal sealed class AgentBroker
{
    private readonly string root, package, workerSid, workerImage;
    private readonly JsonObject config;
    private readonly JsonObject publicKey;
    private readonly DispatchVerifier verifier;
    private readonly WorkerRelay relay = new();
    private readonly JobRunner jobs;
    private readonly PluginHost plugins;
    private readonly FileTransfers transfers;
    private readonly DriftMonitor drift;
    private readonly TerminalBroker terminals;
    private readonly BrokerTelemetry telemetry;
    private readonly AgentLocalMode localMode;
    private readonly AgentActiveStateWriter activeState;
    private readonly BrokerIntegrity integrity;
    private readonly object stateGate = new();
    private int refreshRequested, connections;
    private volatile bool rdpActive;
    private CancellationToken lifetime;
    private ServiceStop? serviceStop;

    internal AgentBroker(string root, BrokerIntegrity integrity)
    {
        this.root = root; package = AppContext.BaseDirectory; this.integrity = integrity;
        config = LocalStore.ReadProtected(Path.Combine(root, "config.bin"));
        if (config["mode"]?.GetValue<string>() is not ("ReadOnly" or "Management")) throw new InvalidDataException("Invalid local mode");
        string origin = config["origin"]!.GetValue<string>();
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var url) || url.Scheme != "https" || url.AbsolutePath != "/" || !string.IsNullOrEmpty(url.UserInfo) || url.Query != "" || url.Fragment != "") throw new InvalidDataException("An HTTPS origin is required");
        string signingKey = config["jobSigningKey"]?.GetValue<string>() ?? throw new InvalidDataException("This installation has no portal job-signing key. Reinstall with a current registration JSON.");
        verifier = new DispatchVerifier(signingKey, config["id"]!.GetValue<string>());
        workerSid = BrokerProtocol.WorkerSid; workerImage = BrokerProtocol.InstalledExecutable(root);
        using (RSA rsa = LocalStore.ReadRsa(config["privateKey"]!.GetValue<string>()))
        {
            var key = rsa.ExportParameters(false);
            publicKey = new JsonObject { ["kty"] = "RSA", ["n"] = Base64Url(key.Modulus!), ["e"] = Base64Url(key.Exponent!) };
        }
        localMode = new AgentLocalMode(root);
        activeState = new AgentActiveStateWriter(state => LocalStore.Json(Path.Combine(root, "active-state.json"), state));
        transfers = new FileTransfers(root, new RelayTransferPortal(relay));
        terminals = new TerminalBroker(root, localMode, verifier, Log);
        plugins = new PluginHost(root, Log);
        // 4.19.0: installs from 4.16 to 4.18 get the read ACE for Authenticated Users once, so a change can start the plugin as the account.
        PluginAcl.EnsureUserRead(PluginFiles.Root(root), Log);
        jobs = new JobRunner(root, package, config, () => Interlocked.Exchange(ref refreshRequested, 1), new RelayReleaseSource(relay), () => (terminals.AnyAlive, rdpActive, transfers.Busy), new PortalUninstall(root, log: Log), new RelayGpuDriverSource(relay), plugins: plugins, pluginUpload: UploadPluginDataAsync);
        drift = new DriftMonitor(root, config, (report, token) => relay.CallAsync(new JsonObject { ["kind"] = "drift-upload", ["report"] = JsonNode.Parse(report) }, TimeSpan.FromSeconds(30), token));
        telemetry = new BrokerTelemetry(root, Log);
        // The planned contexts of the integrity events and the watchdog (AgentIntegrity.cs).
        integrity.Attach(() => PlannedContext.Planned(serviceStop?.Shutdown == true, AgentInstaller.InMaintenance(root), AgentUpdater.Pending(root), jobs.Updating, jobs.Uninstall.Busy));
        // Autostart command lines never carry the agent's own secrets (SecretMask.CommandLine).
        NativeAutostartInventory.KnownSecrets = () => new[] { "token", "privateKey", "jobSigningKey" }.Select(name => config[name] is JsonValue value && value.TryGetValue<string>(out string? text) ? text ?? "" : "").Concat(DeviceTokenClient.SensitiveTokens()).ToList();
    }
    // The plugin data go to the portal through the worker (POST /api/agent/plugin-data), like a drift report.
    // The envelope comes from the shared builder, which never moves a node that has a parent (4.21.2).
    private Task UploadPluginDataAsync(PluginUpload upload, CancellationToken token) => relay.CallAsync(PluginProtocol.UploadMessage(upload), TimeSpan.FromSeconds(60), token);
    private static string Base64Url(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    internal async Task RunAsync(ServiceStop service)
    {
        serviceStop = service; CancellationToken token = service.Token;
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(token);
        lifetime = stop.Token;
        LocalStore.Log(root, "Broker started. Mode=" + config["mode"] + ", version=" + Program.Version);
        // Runs before the service reports RUNNING, so the dependent worker
        // starts only after its package and data ACLs are in place.
        try { WorkerAccess.Repair(root); } catch (Exception e) { Log("Worker access repair: " + e.Message); }
        NativeRdpRtcFirewall.CleanupAtStartup(root, Log);
        jobs.Uninstall.CleanupStale();
        var server = ServeAsync(lifetime); var housekeeping = HousekeepingAsync(lifetime);
        try { await Task.WhenAll(server, housekeeping); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        finally
        {
            stop.Cancel();
            await terminals.StopAsync(); await transfers.StopAsync(); await drift.StopAsync(); await jobs.StopAsync(); await plugins.StopAsync();
            PublishState();
            // A clean end after STOP or SHUTDOWN: a STOP outside a planned context
            // is reported at the next start. A fatal error keeps the run marker.
            if (service.Control != 0) integrity.Stopped(service);
        }
    }

    private async Task HousekeepingAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                await terminals.TickAsync(); jobs.Tick(); PublishState();
                // Periodic plugin reads under the signed plugin policy; skipped while an agent update or uninstall is pending.
                plugins.Tick(AgentInstaller.InMaintenance(root) || AgentUpdater.Pending(root) || jobs.Updating || jobs.Uninstall.Busy, UploadPluginDataAsync, token);
                // The protection check (5 min, registry poll 10 s) and the watchdog over the worker (15 s).
                integrity.Tick(token.IsCancellationRequested);
            }
            catch (Exception e) when (!token.IsCancellationRequested) { Log("Broker housekeeping: " + e.Message); }
            await Task.Delay(2000, token);
        }
    }

    private void PublishState()
    {
        lock (stateGate) activeState.Publish(new JsonObject { ["runningJobs"] = jobs.Running, ["terminalActive"] = terminals.AnyAlive, ["rdpActive"] = rdpActive, ["transfersActive"] = transfers.Busy, ["updatePending"] = AgentUpdater.Pending(root) });
    }

    private NamedPipeServerStream CreatePipe(bool first)
    {
        // SYSTEM owns the pipe. The worker service SID may read and write an
        // existing instance but cannot create one. FirstPipeInstance makes a
        // pre-created (squatted) name a startup failure instead of a takeover.
        var security = new PipeSecurity();
        security.SetOwner(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(workerSid), PipeAccessRights.ReadData | PipeAccessRights.WriteData | PipeAccessRights.ReadAttributes | PipeAccessRights.Synchronize, AccessControlType.Allow));
        return NamedPipeServerStreamAcl.Create(BrokerProtocol.PipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | (first ? PipeOptions.FirstPipeInstance : PipeOptions.None), 65536, 65536, security);
    }

    private async Task ServeAsync(CancellationToken token)
    {
        bool first = true;
        while (!token.IsCancellationRequested)
        {
            var pipe = CreatePipe(first); first = false;
            try { await pipe.WaitForConnectionAsync(token); }
            catch { await pipe.DisposeAsync(); throw; }
            if (Interlocked.Increment(ref connections) > BrokerProtocol.MaximumConnections)
            {
                Interlocked.Decrement(ref connections); await pipe.DisposeAsync(); Log("Broker connection limit reached."); continue;
            }
            _ = Task.Run(() => HandleAsync(pipe, token), CancellationToken.None);
        }
    }

    private async Task HandleAsync(NamedPipeServerStream pipe, CancellationToken token)
    {
        try
        {
            JsonObject? hello;
            using (var handshake = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                handshake.CancelAfter(TimeSpan.FromSeconds(10));
                hello = await BrokerProtocol.ReadAsync(pipe, handshake.Token);
            }
            // Impersonation needs one received frame. The worker connects with
            // identification-level QoS, enough to read its token, never to act.
            if (hello?["op"]?.GetValue<string>() != "hello") throw new InvalidDataException("Missing broker hello.");
            Authenticate(pipe);
            int client = (int)BrokerNative.ClientProcessId(pipe.SafePipeHandle);
            integrity.NoteRequest();
            if (hello["version"]?.GetValue<string>() != Program.Version) { await BrokerProtocol.WriteAsync(pipe, BrokerProtocol.Failure("Broker " + Program.Version + " refuses worker " + hello["version"] + "."), token); return; }
            await BrokerProtocol.WriteAsync(pipe, new JsonObject { ["ok"] = true, ["version"] = Program.Version, ["deviceId"] = config["id"]!.DeepClone(), ["publicKey"] = publicKey.DeepClone(), ["mode"] = Mode() }, token);
            while (!token.IsCancellationRequested)
            {
                var request = await BrokerProtocol.ReadAsync(pipe, token);
                if (request is null) return;
                integrity.NoteRequest();
                JsonObject reply;
                var watch = Stopwatch.StartNew();
                try { reply = await DispatchAsync(request, client, token); }
                catch (Exception e) when (!token.IsCancellationRequested)
                {
                    reply = BrokerProtocol.Failure(e, watch.ElapsedMilliseconds);
                    // Every failed telemetry read is logged, a timeout included, with the collector, the type and the time.
                    if (BrokerClient.Text(request["op"]) == "telemetry") Log(BrokerTelemetry.FailureLine(BrokerClient.Text(request["name"]) ?? "", e, watch.ElapsedMilliseconds, message => AgentHttpTransport.RedactDiagnostic(message, config)));
                    else if (e is not (BrokerException or TimeoutException)) Log("Broker " + request["op"] + ": " + e.Message);
                }
                await BrokerProtocol.WriteAsync(pipe, reply, token);
            }
        }
        catch (Exception e) when (!token.IsCancellationRequested && e is not EndOfStreamException) { Log("Broker connection refused or failed: " + e.Message); }
        catch (Exception) { }
        finally { await pipe.DisposeAsync(); Interlocked.Decrement(ref connections); }
    }

    private void Authenticate(NamedPipeServerStream pipe)
    {
        string? sid = null;
        pipe.RunAsClient(() => { using var identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query); sid = identity.User?.Value; });
        if (!string.Equals(sid, workerSid, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("Pipe client is not the ServerDesk worker service (" + (sid ?? "unknown") + ").");
        string image = BrokerNative.ImagePath(BrokerNative.ClientProcessId(pipe.SafePipeHandle));
        if (!string.Equals(image, workerImage, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("Pipe client does not run the installed agent executable.");
    }

    private string Mode() { try { return localMode.Read(force: true); } catch { return "ReadOnly"; } }

    private async Task<JsonObject> DispatchAsync(JsonObject request, int client, CancellationToken token)
    {
        string op = request["op"]?.GetValue<string>() ?? "";
        switch (op)
        {
            case "status":
                // integrity: the heartbeat's agentIntegrity; integrityEvents: the pending events, at most 20 (4.18.0).
                return new JsonObject { ["ok"] = true, ["mode"] = Mode(), ["maintenance"] = AgentInstaller.InMaintenance(root), ["updatePending"] = AgentUpdater.Pending(root), ["runningJobs"] = jobs.Running, ["defenderScan"] = jobs.DefenderScans.State(), ["plugins"] = Plugins(), ["integrity"] = integrity.Snapshot(), ["integrityEvents"] = integrity.Events.Pending() };
            case "sign-renewal":
                return new JsonObject { ["ok"] = true, ["signature"] = DeviceTokenClient.SignChallenge(config, request["challenge"] as JsonObject ?? throw new InvalidDataException("Missing renewal challenge.")) };
            case "channel-state":
            {
                rdpActive = request["rdpActive"]?.GetValue<bool>() == true;
                bool refresh = Interlocked.Exchange(ref refreshRequested, 0) == 1;
                // uninstallJob: the armed uninstall whose start waits for the portal. The worker names it in X-ServerDesk-Uninstall-Job.
                var state = new JsonObject { ["ok"] = true, ["results"] = jobs.Results(), ["runningJobs"] = jobs.Running, ["transfers"] = transfers.States(), ["jobsBusy"] = jobs.Busy, ["transfersBusy"] = transfers.Busy, ["refreshInventory"] = refresh, ["uninstallJob"] = jobs.Uninstall.PendingJob };
                // The worker then reads the events with status and posts them (AgentWorker.DeliverIntegrityAsync).
                if (integrity.Events.Any) state["integrityPending"] = true;
                return state;
            }
            case "channel-apply": ApplyChannel(request); return new JsonObject { ["ok"] = true };
            // The portal refused the device credentials of a post that named this uninstall job; only AGENT_UNINSTALL_CONFIRMED launches.
            case "channel-refused": jobs.CredentialsRefused(request["uninstallJob"]?.GetValue<string>() ?? "", request["code"]?.GetValue<string>()); PublishState(); return new JsonObject { ["ok"] = true };
            // The portal answered the start result with 409 AGENT_UNINSTALL_NOT_CONFIRMED.
            case "channel-unconfirmed": jobs.Unconfirmed(request["uninstallJob"]?.GetValue<string>() ?? ""); PublishState(); return new JsonObject { ["ok"] = true };
            case "terminal-snapshot": return await terminals.SnapshotAsync(request["waitMs"]?.GetValue<int>() ?? 0, lifetime);
            case "terminal-accept":
            {
                bool updating = AgentInstaller.InMaintenance(root) || AgentUpdater.Pending(root) || jobs.Updating || jobs.Uninstall.Busy;
                var reply = await terminals.AcceptAsync(request["terminals"] as JsonArray ?? throw new InvalidDataException("Missing authoritative terminal list"), request["lease"], updating, lifetime);
                PublishState(); return reply;
            }
            case "telemetry": return new JsonObject { ["ok"] = true, ["value"] = await telemetry.CollectAsync(request["name"]?.GetValue<string>() ?? "", token) };
            case "relay-take": return new JsonObject { ["ok"] = true, ["requests"] = await relay.TakeAsync(request["waitMs"]?.GetValue<int>() ?? 0, token) };
            case "relay-complete":
                relay.Complete(request["id"]!.GetValue<long>(), request["result"] as JsonObject, request["error"]?.GetValue<string>());
                return new JsonObject { ["ok"] = true };
            // The portal accepted these integrity events: delete them.
            case "integrity-ack":
                return new JsonObject { ["ok"] = true, ["removed"] = integrity.Events.Acknowledge((request["ids"] as JsonArray ?? []).Take(IntegrityEventStore.PendingLimit).Select(item => item is JsonValue value && value.TryGetValue<string>(out var id) ? id ?? "" : "")) };
            // The worker's STOP: whether it is planned, so that it knows whether to post its last message.
            case "stop-context": return integrity.StopContext();
            // The worker ends cleanly; without this notice its end counts as unexpected.
            case "worker-stopping":
                integrity.WorkerStopping(client, request["reason"]?.GetValue<string>() == "shutdown" ? "shutdown" : "stop");
                return new JsonObject { ["ok"] = true };
            default: throw new InvalidDataException("Unknown broker operation.");
        }
    }

    private void ApplyChannel(JsonObject request)
    {
        try { jobs.Acknowledge(request["results"] as JsonArray ?? new JsonArray()); } catch (Exception e) { Log("Job acknowledgement: " + e.Message); }
        try { transfers.Acknowledge(request["transferStates"] as JsonArray ?? new JsonArray()); } catch (Exception e) { Log("Transfer acknowledgement: " + e.Message); }
        // A saved uninstall start refuses new work like a local maintenance, across channel polls.
        bool maintenance = AgentInstaller.InMaintenance(root) || AgentUpdater.Pending(root) || jobs.Uninstall.Busy;
        foreach (var envelope in request["jobs"] as JsonArray ?? new JsonArray())
        {
            try
            {
                var job = verifier.Verify(envelope, "job", DispatchVerifier.JobLifetime)["job"] as JsonObject ?? throw new InvalidDataException("Signed job payload is missing.");
                jobs.Start(job, AgentWorkPolicy.BlocksJob(job["action"]?.GetValue<string>(), terminals.AnyAlive || rdpActive, transfers.Busy, maintenance), lifetime);
            }
            catch (Exception e) { Log("Job refused: " + e.Message); }
        }
        var plans = new JsonArray();
        foreach (var envelope in request["transfers"] as JsonArray ?? new JsonArray())
        {
            try { plans.Add((verifier.Verify(envelope, "transfer", DispatchVerifier.JobLifetime)["transfer"] as JsonObject ?? throw new InvalidDataException("Signed transfer payload is missing.")).DeepClone()); }
            catch (Exception e) { Log("Transfer refused: " + e.Message); }
        }
        transfers.Accept(plans, AgentWorkPolicy.BlocksTransfer(maintenance, jobs.Busy), lifetime);
        if (request["driftPolicy"] is JsonNode signedPolicy)
        {
            // Missing or invalid policy envelopes leave the current policy in
            // place; only a verified portal decision may replace or disable it.
            try { drift.Configure(verifier.Verify(signedPolicy, "drift-policy", DispatchVerifier.JobLifetime)["policy"] as JsonObject, lifetime); }
            catch (Exception e) { Log("Drift policy refused: " + e.Message); }
        }
        // Plugins collect only under a valid, unexpired plugin policy of this
        // portal; a missing, unsigned, expired or foreign one stops all collection.
        JsonObject? pluginPolicy = null;
        if (request["pluginPolicy"] is JsonNode signedPlugins)
        {
            try { pluginPolicy = verifier.Verify(signedPlugins, "plugin-policy", DispatchVerifier.JobLifetime); }
            catch (Exception e) { Log("Plugin policy refused: " + e.Message); }
        }
        plugins.ConfigurePolicy(pluginPolicy);
        PublishState();
    }

    private void Log(string message) => LocalStore.Log(root, AgentHttpTransport.RedactDiagnostic(message, config));

    // The plugin report of the status answer; a failure there never fails the status.
    private JsonArray Plugins() { try { return plugins.Report(); } catch (Exception e) { Log("Plugin report: " + e.Message); return new JsonArray(); } }
}

// The terminal registry, its claims and every ConPTY process live in the
// broker. The worker only forwards the portal's exchange; a signed lease
// decides which sessions may exist and until when.
internal sealed class TerminalBroker
{
    private readonly TerminalRegistry registry;
    private readonly TerminalWake wake = new();
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly AgentLocalMode localMode;
    private readonly DispatchVerifier verifier;
    private readonly Action<string> log;
    private long lastAccept = Stopwatch.GetTimestamp();
    internal bool AnyAlive => registry.AnyAlive;

    internal TerminalBroker(string root, AgentLocalMode localMode, DispatchVerifier verifier, Action<string> log)
    {
        this.localMode = localMode; this.verifier = verifier; this.log = log;
        registry = new TerminalRegistry(
            command => new TerminalSession(command["id"]!.GetValue<string>(), root, (short)Math.Clamp(command["cols"]?.GetValue<int>() ?? 100, 20, 400), (short)Math.Clamp(command["rows"]?.GetValue<int>() ?? 30, 5, 200), DateTimeOffset.Parse(command["expiresAt"]!.GetValue<string>()), wake.Signal),
            id => File.Exists(Path.Combine(root, "terminal-claims", id + ".claim")),
            id => LocalStore.Atomic(Path.Combine(root, "terminal-claims", id + ".claim"), Encoding.UTF8.GetBytes(DateTimeOffset.UtcNow.ToString("O"))),
            log);
    }

    internal async Task<JsonObject> SnapshotAsync(int waitMilliseconds, CancellationToken token)
    {
        // ConPTY output wakes this wait at once, as the in-process loop did.
        if (waitMilliseconds > 0) await wake.WaitAsync(Math.Min(waitMilliseconds, 1000), token);
        await gate.WaitAsync(token);
        try
        {
            if (!localMode.ManagementAllowed) await registry.StopAsync();
            await registry.CloseExpiredAsync();
            return new JsonObject { ["ok"] = true, ["terminals"] = registry.Snapshots(), ["alive"] = registry.AnyAlive };
        }
        finally { gate.Release(); }
    }

    internal async Task<JsonObject> AcceptAsync(JsonArray offered, JsonNode? lease, bool updatePending, CancellationToken token)
    {
        var commands = verifier.ApplyTerminalLease(offered, lease, log);
        await gate.WaitAsync(token);
        try
        {
            // Explicit commands use an uncached local admission check.
            string mode = commands.Count > 0 ? localMode.Read(force: true) : localMode.ManagementAllowed ? "Management" : "ReadOnly";
            await registry.AcceptAsync(commands, mode == "Management", updatePending, token);
            Volatile.Write(ref lastAccept, Stopwatch.GetTimestamp());
            return new JsonObject { ["ok"] = true, ["alive"] = registry.AnyAlive };
        }
        finally { gate.Release(); }
    }

    internal async Task TickAsync()
    {
        await gate.WaitAsync();
        try
        {
            await registry.CloseExpiredAsync();
            // Without a portal exchange the shells lose their owner. Close them
            // as the single-process agent did after 30 seconds of channel loss.
            if (registry.AnyAlive && Stopwatch.GetElapsedTime(Volatile.Read(ref lastAccept)) > TimeSpan.FromSeconds(30)) { log("Terminal channel lost for 30 seconds; closing shells."); await registry.StopAsync(); }
        }
        finally { gate.Release(); }
    }

    internal async Task StopAsync() { await gate.WaitAsync(); try { await registry.StopAsync(); } finally { gate.Release(); } }
}

// Fixed, argument-free administrator inventories for the worker's telemetry.
// `collect` is a self-test seam that replaces the provider reads; null reads Windows.
internal sealed class BrokerTelemetry(string root, Action<string>? log = null, Func<string, JsonObject>? collect = null)
{
    private readonly NativeHardwareInventory hardware = new();
    private readonly NativeCrashInventory crashes = new();
    private readonly NativeBitLocker bitlocker = new(Path.Combine(root, "bitlocker-state.json"));
    private readonly NativeSoftwareInventory software = new();
    private readonly NativeDriverInventory drivers = new();
    private readonly NativeReliability reliability = new();
    private readonly NativeDiskHealth diskHealth = new();
    private readonly NativeCertificates certificates = new();
    private readonly NativeAutostartInventory autostart = new();
    private readonly NativeDefender defender = new();
    private readonly object flights = new();
    private readonly Dictionary<string, Task<JsonObject>> running = new(StringComparer.Ordinal);
    private readonly NativeFeatureTiming rolesTiming = new();

    // Single flight per name (4.21.5): a request for a name whose read runs
    // awaits that same read instead of failing after a fixed wait. Only the
    // request's own token ends its wait; the read goes on for the other requests.
    // Its result or its failure goes to every waiting request and is never kept:
    // the next request after the read starts a new one.
    internal async Task<JsonObject> CollectAsync(string name, CancellationToken token)
    {
        if (name != "updates" && !NativeTelemetryCollector.PrivilegedProviders.Contains(name)) throw new InvalidDataException("Unknown privileged inventory.");
        token.ThrowIfCancellationRequested();
        TaskCompletionSource<JsonObject>? owner = null; Task<JsonObject> run;
        lock (flights)
        {
            if (!running.TryGetValue(name, out run!)) { owner = new(TaskCreationOptions.RunContinuationsAsynchronously); running[name] = run = owner.Task; }
        }
        if (owner is not null) _ = RunAsync(name, owner);
        var value = await run.WaitAsync(token);
        // A JSON node has one parent: every reply gets its own copy.
        lock (value) return (JsonObject)value.DeepClone();
    }

    private async Task RunAsync(string name, TaskCompletionSource<JsonObject> owner)
    {
        try
        {
            var value = await Task.Run(() => collect is null ? Collect(name) : collect(name));
            lock (flights) running.Remove(name);
            owner.SetResult(value);
        }
        catch (Exception error)
        {
            lock (flights) running.Remove(name);
            owner.SetException(error);
        }
    }

    private JsonObject Collect(string name) => name switch
    {
        "Hardware inventory" => hardware.Collect(),
        "Roles and features" => Roles(),
        "Security" => NativeTelemetryCollector.Security(),
        "Local firewall rules" => NativeTelemetryCollector.FirewallRules(),
        "Scheduled tasks" => NativeTelemetryCollector.Tasks(),
        "Scheduled system action" => NativePowerSchedule.Collect(),
        "Crashes" => crashes.Collect(),
        "BitLocker" => bitlocker.Collect(),
        "Software inventory" => software.Collect(),
        "Drivers" => Drivers(),
        "Reliability" => reliability.Collect(),
        "Disk and battery health" => diskHealth.Collect(),
        "Certificates" => certificates.Collect(),
        "Autostart" => autostart.Collect(),
        "Defender" => defender.Collect(),
        "updates" => Updates(),
        _ => throw new InvalidDataException("Unknown privileged inventory.")
    };

    // The time of the first driver read after the broker start and of every slow one.
    private JsonObject Drivers()
    {
        var value = drivers.Collect();
        if (drivers.TimingLogLine() is string line) log?.Invoke(line);
        return value;
    }

    // The time of the first role read after the broker start and of every slow one (4.21.5).
    private JsonObject Roles()
    {
        var watch = Stopwatch.StartNew();
        var features = NativeFeatures.ListAsync(NativeTelemetryCollector.IsServer(), CancellationToken.None).GetAwaiter().GetResult();
        if (rolesTiming.LogLine(watch.ElapsedMilliseconds, features.Count) is string line) log?.Invoke(line);
        return new JsonObject { ["features"] = features };
    }

    /// <summary>The broker log line of a failed telemetry read: collector, type and provider code, elapsed time, and the redacted message (at most 300 characters).</summary>
    internal static string FailureLine(string name, Exception error, long elapsedMs, Func<string, string> redact) =>
        "Broker telemetry " + WindowsManagement.Limit(name, 64) + ": " + WindowsManagement.Limit(NativeInventoryDiagnostics.Describe(error), 200) + " after " + CollectorFailure.Bound(elapsedMs).ToString(System.Globalization.CultureInfo.InvariantCulture) + " ms; " + WindowsManagement.Limit(redact(error.Message), 300);

    private JsonObject Updates()
    {
        string path = Path.Combine(root, "updates.json");
        if (!File.Exists(path) || new FileInfo(path).Length > 150000) return new JsonObject();
        return new JsonObject { ["updates"] = NativeTelemetryCollector.NormalizeUpdates(JsonNode.Parse(File.ReadAllText(path))) };
    }
}
