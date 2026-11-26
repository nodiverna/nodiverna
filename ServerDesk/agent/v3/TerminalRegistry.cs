using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal interface IAgentTerminal : IAsyncDisposable
{
    string Id { get; }
    bool Alive { get; }
    bool Expired { get; }
    JsonObject Snapshot();
    Task AcceptAsync(JsonObject request, CancellationToken token);
}

// Only the dedicated terminal loop mutates the registry. Each native shell owns its own
// input/output sequence, decoder, process tree and durable no-replay claim.
internal sealed class TerminalRegistry
{
    internal const int MaximumActive = 4, MaximumReports = 8;
    private readonly Dictionary<string, IAgentTerminal> sessions = new(StringComparer.Ordinal);
    private IAgentTerminal[] published = Array.Empty<IAgentTerminal>();
    private readonly Func<JsonObject, IAgentTerminal> create;
    private readonly Func<string, bool> claimed;
    private readonly Action<string> claim, log;
    internal bool AnyAlive => Volatile.Read(ref published).Any(session => session.Alive);
    private void Publish() => Volatile.Write(ref published, sessions.Values.ToArray());

    internal TerminalRegistry(Func<JsonObject, IAgentTerminal> create, Func<string, bool> claimed, Action<string> claim, Action<string> log)
    {
        this.create = create; this.claimed = claimed; this.claim = claim; this.log = log;
    }

    internal JsonArray Snapshots() => new(Volatile.Read(ref published).OrderByDescending(session => session.Alive).Take(MaximumReports).Select(session => (JsonNode)session.Snapshot()).ToArray());

    internal async Task CloseExpiredAsync()
    {
        foreach (var session in sessions.Values.Where(session => session.Alive && session.Expired)) await DisposeAsync(session);
    }

    internal async Task AcceptAsync(JsonArray commands, bool managementEnabled, bool updatePending, CancellationToken token)
    {
        var valid = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var item in commands)
        {
            try
            {
                if (item is not JsonObject command || !Guid.TryParse(command["id"]?.GetValue<string>(), out var id)) throw new InvalidDataException("Invalid terminal ID");
                string canonical = id.ToString();
                if (!valid.TryAdd(canonical, command)) throw new InvalidDataException("Duplicate terminal ID");
            }
            catch (Exception error) { log("Terminal command ignored: " + error.Message); }
        }

        // The response is an authoritative per-device list. A withdrawn lease,
        // permission or browser presence closes only the missing shell.
        foreach (string id in sessions.Keys.ToArray())
        {
            // Closing commands may appear after newly offered shells in the
            // response. Release their slots first so command order cannot make
            // a valid replacement session hit the active limit and its claim.
            bool closing = valid.TryGetValue(id, out var command) && command["state"] is JsonValue state && state.TryGetValue<string>(out var text) && text is "closed" or "error";
            if (!valid.ContainsKey(id) || closing) { await RemoveAsync(id); continue; }
            if (!managementEnabled || updatePending) await DisposeAsync(sessions[id]);
        }

        foreach (var (id, offered) in valid)
        {
            try
            {
                var command = (JsonObject)offered.DeepClone(); command["id"] = id;
                if (command["state"]?.GetValue<string>() is "closed" or "error") { await RemoveAsync(id); continue; }
                if (command["state"]?.GetValue<string>() is not ("opening" or "open")) throw new InvalidDataException("Invalid terminal state");
                if (!sessions.TryGetValue(id, out var session))
                {
                    string? refusal = !managementEnabled ? "Terminal requires locally enabled Management." : updatePending ? "Terminal cannot open during an agent update." : sessions.Values.Count(value => value.Alive) >= MaximumActive ? "The device already has four live terminal sessions." : claimed(id) ? "This terminal session was interrupted or already used. Start a new session; input will not be replayed." : null;
                    if (refusal is not null) { SetFailure(id, refusal); continue; }
                    if (!DateTimeOffset.TryParse(command["expiresAt"]?.GetValue<string>(), out var expiry) || expiry <= DateTimeOffset.UtcNow) throw new InvalidDataException("Terminal session has no valid future expiry");
                    claim(id); // Claim survives process or service interruption.
                    TrimReports(); sessions[id] = session = create(command); Publish();
                }
                await session.AcceptAsync(command, token);
            }
            catch (Exception error) when (!token.IsCancellationRequested)
            {
                await RemoveAsync(id);
                SetFailure(id, "Terminal failed and was closed; input will not be replayed. " + error.Message);
                log("Terminal " + id + ": " + error.Message);
            }
        }
    }

    private void TrimReports()
    {
        while (sessions.Count >= MaximumReports)
        {
            string? id = sessions.FirstOrDefault(entry => !entry.Value.Alive).Key;
            if (id is null) throw new InvalidOperationException("Terminal report limit reached");
            sessions.Remove(id); Publish(); // Inactive native shells have already disposed their process trees.
        }
    }
    private void SetFailure(string id, string error)
    {
        if (!claimed(id)) claim(id);
        TrimReports(); sessions[id] = new RejectedTerminal(id, error[..Math.Min(500, error.Length)]); Publish();
    }
    private async Task DisposeAsync(IAgentTerminal session) { try { await session.DisposeAsync(); } catch (Exception error) { log("Terminal " + session.Id + " cleanup: " + error.Message); } }
    private async Task RemoveAsync(string id) { if (sessions.Remove(id, out var session)) { Publish(); await DisposeAsync(session); } }
    internal async Task StopAsync() { foreach (var session in sessions.Values) await DisposeAsync(session); }

    private sealed class RejectedTerminal(string id, string error) : IAgentTerminal
    {
        public string Id => id;
        public bool Alive => false;
        public bool Expired => false;
        public JsonObject Snapshot() => new() { ["id"] = id, ["state"] = "error", ["inputAck"] = 0, ["output"] = new JsonArray(), ["error"] = error };
        public Task AcceptAsync(JsonObject request, CancellationToken token) => Task.CompletedTask;
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

internal static class AgentWorkPolicy
{
    // Agent update and uninstall need the device for themselves; a terminal blocks only them.
    internal static bool BlocksJob(string? action, bool terminalActive, bool transferActive, bool updatePending) => updatePending || transferActive || action is "agent-update" or "agent-uninstall" && terminalActive;
    internal static bool BlocksTransfer(bool updatePending, bool jobRunning) => updatePending || jobRunning;
}

internal static class TerminalOutputFrames
{
    internal const int MaximumBytes = 131072;
    internal static string ReportState(string state, int retainedFrames, int selectedFrames) => (state is "closed" or "error") && selectedFrames < retainedFrames ? "open" : state;
    internal static JsonArray Select(IEnumerable<(long Sequence, string Data)> frames)
    {
        var output = new JsonArray(); int encodedBytes = 0;
        foreach (var frame in frames.Take(16))
        {
            var item = new JsonObject { ["seq"] = frame.Sequence, ["data"] = frame.Data };
            int size = System.Text.Encoding.UTF8.GetByteCount(item.ToJsonString());
            if (encodedBytes + size > MaximumBytes) break;
            output.Add(item); encodedBytes += size;
        }
        return output;
    }
}

// Coalesce native output notifications without leaking pending waiters. A burst
// takes one wake; an output event before WaitAsync stays available for the next
// exchange. This keeps ACK retries bounded and avoids a spin loop on snapshots.
internal sealed class TerminalWake
{
    private readonly SemaphoreSlim signal = new(0, 1);
    internal void Signal() { try { signal.Release(); } catch (SemaphoreFullException) { } }
    internal Task<bool> WaitAsync(int milliseconds, CancellationToken token) => signal.WaitAsync(milliseconds, token);
}
