using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// Only terminal public diagnostics survive retirement. There are no keys,
// descriptions, media bytes or authorization grants in this bounded outbox.
internal sealed class NativeRdpDiagnosticOutbox(int capacity = 4)
{
    internal sealed record Entry(string Id, string Error)
    {
        internal JsonObject Report() => NativeRdpChannel.FailureReport(Id, Error, true);
    }
    private readonly object gate = new();
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
    internal bool IsFull { get { lock (gate) return entries.Count >= capacity; } }

    internal static string? TerminalError(JsonObject snapshot)
    {
        if (snapshot["transport"]?.ToString() != "webrtc" || snapshot["state"]?.ToString() != "error" ||
            snapshot["inputAck"]?.ToJsonString() != "0" || snapshot["output"] is not JsonArray output || output.Count != 0 ||
            snapshot["error"] is not JsonValue value || !value.TryGetValue<string>(out string? error) ||
            string.IsNullOrWhiteSpace(error) || error.Length > 500 || error.Any(char.IsControl)) return null;
        return error;
    }

    // False applies backpressure: the owner must retain its disposed session
    // record rather than discard an unreported first terminal cause.
    internal bool TryCapture(string id, JsonObject snapshot)
    {
        string? error = TerminalError(snapshot); if (error is null) return true;
        lock (gate)
        {
            if (entries.ContainsKey(id)) return true;
            if (entries.Count >= capacity) return false;
            entries.Add(id, new Entry(id, error)); return true;
        }
    }
    internal IReadOnlyList<Entry> Snapshot() { lock (gate) return entries.Values.ToArray(); }
    internal void Acknowledge(IEnumerable<Entry> sent)
    {
        lock (gate)
            foreach (Entry entry in sent)
                if (entries.TryGetValue(entry.Id, out Entry? current) && ReferenceEquals(current, entry)) entries.Remove(entry.Id);
    }
}
