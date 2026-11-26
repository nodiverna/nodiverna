using System.Security.Cryptography;
using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal sealed class NativeRdpChannel
{
    private const int MaximumSessions = 2, MaximumReports = 4, MaximumCommands = MaximumSessions + MaximumReports, MinimumActiveSpacingMs = 20;
    private readonly string root;
    private readonly JsonObject config;
    private readonly Func<string, JsonObject, CancellationToken, Task<JsonObject>> post;
    private readonly Action? stateChanged;
    private readonly Action<string> log;
    private readonly Func<bool>? managementAllowed;
    private readonly Dictionary<string, IRdpAgentSession> sessions = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (string Error, bool Direct)> failures = new(StringComparer.Ordinal);
    private readonly NativeRdpDiagnosticOutbox diagnostics = new(MaximumReports);
    private readonly HashSet<string> loggedFailures = new(StringComparer.Ordinal);
    private IRdpAgentSession[] published = [];
    private readonly TerminalWake wake = new();
    private readonly CancellationTokenSource stopped = new();
    private readonly object runGate = new();
    private Task? running;
    internal bool AnyAlive => Volatile.Read(ref published).Any(session => session.Alive);
    internal NativeRdpChannel(string root, JsonObject config, Func<string, JsonObject, CancellationToken, Task<JsonObject>> post, Action? stateChanged = null, Action<string>? log = null, Func<bool>? managementAllowed = null)
    {
        this.root = root; this.config = config; this.post = post; this.stateChanged = stateChanged;
        this.log = log ?? (message => LocalStore.Log(root, AgentHttpTransport.RedactDiagnostic(message, config)));
        this.managementAllowed = managementAllowed;
        Directory.CreateDirectory(Path.Combine(root, "rdp-claims"));
    }
    private void Publish() { Volatile.Write(ref published, sessions.Values.ToArray()); Notify(); }
    private void Notify() { wake.Signal(); stateChanged?.Invoke(); }
    internal Task RunAsync(CancellationToken token)
    {
        lock (runGate) return running ??= RunOwnedAsync(token);
    }
    internal async Task StopAsync()
    {
        stopped.Cancel(); Task? task; lock (runGate) task = running;
        if (task is not null) try { await task; } catch (OperationCanceledException) { }
    }
    private bool Management()
    {
        try { if (managementAllowed is not null) return managementAllowed(); NativeManagement.AssertManagement(root, config); return true; } catch { return false; }
    }
    private async Task RunOwnedAsync(CancellationToken outside)
    {
        using var tokenSource = CancellationTokenSource.CreateLinkedTokenSource(outside, stopped.Token); var token = tokenSource.Token;
        DateTimeOffset lastOk = DateTimeOffset.UtcNow;
        try
        {
            while (!token.IsCancellationRequested)
            {
                long requestedAt = Stopwatch.GetTimestamp();
                int interval = 1000; bool failed = false;
                try
                {
                    bool allowed = Management() && !AgentInstaller.InMaintenance(root) && !AgentUpdater.Pending(root);
                    foreach (var session in sessions.Values.Where(session => !session.Alive || !allowed || session.Expired).ToArray())
                    {
                        JsonObject status = session.Snapshot();
                        if (status["state"]?.GetValue<string>() == "error" && loggedFailures.Add(session.Id)) log("Remote Desktop " + session.Id + " failed: " + status["error"]?.GetValue<string>());
                        await session.DisposeAsync();
                    }
                    var sentDiagnostics = diagnostics.Snapshot();
                    var reports = new JsonArray(sentDiagnostics.Select(entry => entry.Report())
                        .Concat(sessions.Values.Select(session => session.Snapshot()))
                        .Concat(failures.Select(item => FailureReport(item.Key, item.Value.Error, item.Value.Direct)))
                        .DistinctBy(report => report["id"]?.GetValue<string>(), StringComparer.Ordinal)
                        .Take(MaximumReports).Select(report => (JsonNode)report).ToArray());
                    // Freeze exactly what this HTTP exchange transmitted. A native
                    // failure can occur while its earlier opening report is in flight.
                    var sentErrors = reports.OfType<JsonObject>().Where(report => NativeRdpDiagnosticOutbox.TerminalError(report) is not null)
                        .ToDictionary(report => report["id"]!.GetValue<string>(), report => NativeRdpDiagnosticOutbox.TerminalError(report)!, StringComparer.Ordinal);
                    var response = await post("/api/agent/rdp", new JsonObject { ["serverId"] = config["id"]!.DeepClone(), ["sessions"] = reports }, token); lastOk = DateTimeOffset.UtcNow;
                    bool paused = response["available"] is JsonValue availability && availability.TryGetValue<bool>(out bool available) && !available;
                    allowed = !paused && Management() && !AgentInstaller.InMaintenance(root) && !AgentUpdater.Pending(root);
                    // The backend includes up to two active commands and a close
                    // acknowledgement for each retired report not among them.
                    // An authenticated portal pause withdraws every authorization,
                    // even if the response also contains an inconsistent active
                    // command. Do not inspect keys, claim IDs, or renew its lease.
                    JsonArray offered;
                    if (paused) { offered = new JsonArray(); failures.Clear(); }
                    else if (response["sessions"] is JsonArray commands && commands.Count <= MaximumCommands) offered = commands;
                    else throw new InvalidDataException("Invalid authoritative Remote Desktop session list.");
                    diagnostics.Acknowledge(sentDiagnostics);
                    DateTimeOffset serverDate = DateTimeOffset.TryParse(response["_httpServerDate"]?.GetValue<string>(), out var dated) ? dated : DateTimeOffset.UtcNow;
                    await AcceptAsync(offered, allowed, token, serverDate, requestedAt, sentErrors);
                    bool fullyIdle = sessions.Count == 0 && failures.Count == 0 && diagnostics.Snapshot().Count == 0;
                    interval = PollIntervalMs(response["intervalMs"]?.GetValue<int>() ?? (paused ? 60000 : 50), paused, fullyIdle);
                    if (paused && !fullyIdle) interval = 1000;
                    else if (!AnyAlive) interval = Math.Max(interval, 1000);
                    else if (sessions.Values.Any(session => !session.IsDirect && session.HasPendingOutput)) interval = 0;
                    else if (sessions.Values.Any(session => !session.IsDirect)) interval = Math.Min(interval, 50);
                    else interval = sessions.Values.Any(session => session.Snapshot()["state"]?.GetValue<string>() == "opening") ? 250 : 5000;
                }
                catch (Exception e) when (!token.IsCancellationRequested)
                {
                    failed = true; interval = 1000;
                    log("Remote Desktop channel: " + e.GetType().Name + ": " + e.Message);
                    if (!Management() || DateTimeOffset.UtcNow - lastOk >= TimeSpan.FromSeconds(45)) foreach (var session in sessions.Values) await session.DisposeAsync();
                }
                int pollDelay = RemainingPollDelayMs(interval, AnyAlive, failed, Stopwatch.GetElapsedTime(requestedAt));
                if (failed) await Task.Delay(pollDelay, token); else await wake.WaitAsync(pollDelay, token);
                // HTTP/database latency already occupies the request interval.
                // Do not add another fixed sleep after a completed exchange.
                int spacing = MinimumActiveSpacingMs - (int)Stopwatch.GetElapsedTime(requestedAt).TotalMilliseconds;
                if (spacing > 0) await Task.Delay(spacing, token);
            }
        }
        finally { foreach (var session in sessions.Values) await session.DisposeAsync(); Publish(); }
    }
    internal static int RemainingPollDelayMs(int interval, bool active, bool failed, TimeSpan elapsed) => active && !failed ? Math.Max(0, interval - (int)Math.Max(0, elapsed.TotalMilliseconds)) : interval;
    internal static int PollIntervalMs(int requested, bool paused, bool fullyIdle) => paused && fullyIdle ? Math.Clamp(requested, 1000, 60000) : Math.Clamp(requested, MinimumActiveSpacingMs, 5000);
    private async Task<bool> RetireAsync(string id, IReadOnlyDictionary<string, string> sentErrors)
    {
        IRdpAgentSession old = sessions[id]; await old.DisposeAsync();
        if (old.IsDirect)
        {
            // Dispose joins the native tasks and freezes first-error state. Reading
            // before Dispose can miss a failure racing the HTTP close response.
            JsonObject status = old.Snapshot(); string? error = NativeRdpDiagnosticOutbox.TerminalError(status);
            if (error is not null && loggedFailures.Add(id)) log("Remote Desktop " + id + " failed: " + error);
            if (error is not null && (!sentErrors.TryGetValue(id, out string? sent) || sent != error) && !diagnostics.TryCapture(id, status))
            {
                log("Remote Desktop terminal diagnostics are awaiting delivery; new sessions are paused.");
                Publish(); return false;
            }
        }
        sessions.Remove(id); loggedFailures.Remove(id); Publish(); return true;
    }
    private async Task AcceptAsync(JsonArray offered, bool allowed, CancellationToken token, DateTimeOffset serverDate, long requestedAt, IReadOnlyDictionary<string, string> sentErrors)
    {
        var valid = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (JsonNode? item in offered)
        {
            if (item is not JsonObject command || command["id"] is not JsonValue value || !value.TryGetValue<string>(out string? id) || id is null || !Guid.TryParseExact(id, "D", out Guid parsed) || parsed.ToString() != id || !valid.TryAdd(id, command)) throw new InvalidDataException("Invalid or duplicate Remote Desktop session identifier.");
        }
        foreach (string id in sessions.Keys.ToArray())
        {
            if (!valid.TryGetValue(id, out var command) || command["state"]?.GetValue<string>() is "closed" or "error")
            { await RetireAsync(id, sentErrors); }
        }
        foreach (string id in failures.Keys.Where(id => !valid.ContainsKey(id) || valid[id]["state"]?.GetValue<string>() is "closed" or "error").ToArray()) failures.Remove(id);
        foreach (var (id, command) in valid)
        {
            token.ThrowIfCancellationRequested();
            if (command["state"]?.GetValue<string>() is "closed" or "error") continue;
            try
            {
                if (!allowed) throw new InvalidOperationException("Remote Desktop requires local Management and no pending agent update.");
                if (command["state"]?.GetValue<string>() is not ("opening" or "open")) throw new InvalidDataException("Invalid Remote Desktop state.");
                if (!DateTimeOffset.TryParse(command["expiresAt"]?.GetValue<string>(), out var expiry) || expiry <= serverDate || expiry > serverDate.AddHours(2).AddSeconds(10)) throw new InvalidDataException("Invalid Remote Desktop expiry.");
                if (command["transport"]?.GetValue<string>() == "webrtc")
                {
                    int leaseMs = command["leaseMs"]?.GetValue<int>() ?? throw new InvalidDataException("Missing direct Remote Desktop authorization lease.");
                    command["_rtcLeaseDeadline"] = RdpRtcSignal.MonotonicDeadline(RdpRtcSignal.RemainingLeaseMilliseconds(command["leaseExpiresAt"]?.GetValue<string>(), expiry, leaseMs, serverDate, Stopwatch.GetElapsedTime(requestedAt)));
                }
                if (!sessions.TryGetValue(id, out var session))
                {
                    if (failures.ContainsKey(id)) continue;
                    if (diagnostics.IsFull || sessions.Count >= MaximumSessions) throw new InvalidOperationException("Two Remote Desktop records are active or terminal diagnostics await delivery. Retry after their next control report.");
                    NativeManagement.AssertManagement(root, config); // New admission never relies on the idle mode cache.
                    Claim(id);
                    byte[] key = OpenKey(command["keyEnvelope"]?.GetValue<string>() ?? throw new InvalidDataException("Remote Desktop session key is missing."), id, config["privateKey"]!.GetValue<string>());
                    try
                    {
                        bool direct = command["transport"]?.GetValue<string>() == "webrtc";
                        if (command["transport"] is not null && !direct) throw new InvalidDataException("Unsupported Remote Desktop transport.");
                        session = direct
                            ? new RdpRtcSession(id, root, config, key, expiry, command["offer"]?.GetValue<string>() ?? throw new InvalidDataException("Missing direct Remote Desktop offer."), command["_rtcLeaseDeadline"]!.GetValue<long>(), Notify)
                            : new RdpSession(id, root, config, key, expiry, Notify);
                        sessions.Add(id, session); Publish();
                    }
                    finally { CryptographicOperations.ZeroMemory(key); }
                }
                if (!session.Alive || session.Expired) { await session.DisposeAsync(); continue; }
                if (session.IsDirect != (command["transport"]?.GetValue<string>() == "webrtc")) throw new InvalidDataException("Remote Desktop transport changed during the session.");
                session.Accept(command);
            }
            catch (Exception e) when (!token.IsCancellationRequested)
            {
                if (sessions.ContainsKey(id)) await RetireAsync(id, sentErrors);
                if (failures.Count < MaximumReports) failures[id] = (e is CryptographicException ? "Remote Desktop session key validation failed. Start a new session." : e.Message[..Math.Min(500, e.Message.Length)], command["transport"]?.GetValue<string>() == "webrtc");
                log("Remote Desktop " + id + " refused: " + e.GetType().Name + ": " + e.Message);
            }
        }
    }
    internal static JsonObject FailureReport(string id, string error, bool direct)
    {
        var report = new JsonObject { ["id"] = id, ["state"] = "error", ["inputAck"] = 0, ["output"] = new JsonArray(), ["error"] = error };
        if (direct) report["transport"] = "webrtc";
        return report;
    }
    private void Claim(string id)
    {
        string path = Path.Combine(root, "rdp-claims", id + ".claim");
        // CreateNew is durable and atomic. A service restart can only reject an
        // old session, never restore sockets or replay its previous input.
        using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 256, FileOptions.WriteThrough);
        stream.Write(Encoding.UTF8.GetBytes(DateTimeOffset.UtcNow.ToString("O"))); stream.Flush(true);
    }
    internal static byte[] OpenKey(string envelope, string id, string privateKey)
    {
        byte[] ciphertext;
        try { ciphertext = Convert.FromBase64String(envelope); } catch (FormatException e) { throw new CryptographicException("Invalid RDP key envelope.", e); }
        using RSA rsa = LocalStore.ReadRsa(privateKey);
        if (ciphertext.Length != rsa.KeySize / 8 || Convert.ToBase64String(ciphertext) != envelope) throw new CryptographicException("Invalid RDP key envelope size.");
        byte[] plain = rsa.Decrypt(ciphertext, RSAEncryptionPadding.OaepSHA256);
        try
        {
            if (plain.Length > 256 || JsonNode.Parse(plain) is not JsonObject sealedKey || sealedKey.Count != 2 || sealedKey["id"]?.GetValue<string>() != id) throw new CryptographicException("Invalid RDP sealed session identifier.");
            string encoded = sealedKey["key"]?.GetValue<string>() ?? ""; byte[] key = Convert.FromBase64String(encoded);
            if (key.Length != 32 || Convert.ToBase64String(key) != encoded) { CryptographicOperations.ZeroMemory(key); throw new CryptographicException("Invalid RDP key length."); }
            return key;
        }
        finally { CryptographicOperations.ZeroMemory(plain); }
    }
}
