using System.Diagnostics;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// A file stamp is cheap to inspect. Decrypt credentials only when the protected
// configuration changes or the short fallback interval expires. Administrative
// operations still perform their own uncached Management admission checks.
internal readonly record struct AgentConfigStamp(long Length, long CreatedTicks, long WrittenTicks);

internal sealed class AgentLocalMode
{
    private readonly object gate = new();
    private readonly Func<AgentConfigStamp> inspect;
    private readonly Func<string> read;
    private readonly Func<TimeSpan> clock;
    private AgentConfigStamp? stamp;
    private string? mode;
    private TimeSpan checkedAt;
    internal static readonly TimeSpan MaximumCacheAge = TimeSpan.FromSeconds(15);

    internal AgentLocalMode(string root) : this(
        () => Inspect(Path.Combine(root, "config.bin")),
        () => LocalStore.ReadProtected(Path.Combine(root, "config.bin"))["mode"]?.GetValue<string>() ?? "",
        () => Stopwatch.GetElapsedTime(0)) { }

    internal AgentLocalMode(Func<AgentConfigStamp> inspect, Func<string> read, Func<TimeSpan> clock)
    { this.inspect = inspect; this.read = read; this.clock = clock; }

    private static AgentConfigStamp Inspect(string path)
    {
        var file = new FileInfo(path);
        if (!file.Exists) throw new FileNotFoundException("Protected agent configuration is unavailable.");
        return new(file.Length, file.CreationTimeUtc.Ticks, file.LastWriteTimeUtc.Ticks);
    }

    internal string Read(bool force = false)
    {
        lock (gate)
        {
            try
            {
                var observed = inspect(); var now = clock();
                if (!force && mode is not null && stamp == observed && now >= checkedAt && now - checkedAt < MaximumCacheAge) return mode;
                string next = read();
                if (next is not ("ReadOnly" or "Management")) throw new InvalidDataException("Invalid local agent mode.");
                if (inspect() != observed) throw new IOException("Agent configuration changed while being read.");
                stamp = observed; mode = next; checkedAt = now;
                return next;
            }
            catch { stamp = null; mode = null; throw; }
        }
    }

    internal bool ManagementAllowed
    {
        get { try { return Read() == "Management"; } catch { return false; } }
    }
}

// active-state remains durable installation authority. Keep it fresh inside the
// installer's 30-second bound, with immediate writes for actual state changes.
internal sealed class AgentActiveStateWriter
{
    internal static readonly TimeSpan RenewalInterval = TimeSpan.FromSeconds(10);
    private readonly Action<JsonObject> write;
    private readonly Func<TimeSpan> clock;
    private string? previous;
    private TimeSpan writtenAt;
    internal AgentActiveStateWriter(Action<JsonObject> write, Func<TimeSpan>? clock = null)
    { this.write = write; this.clock = clock ?? (() => Stopwatch.GetElapsedTime(0)); }
    internal void Publish(JsonObject state)
    {
        string identity = state.ToJsonString(); var now = clock();
        if (identity == previous && now >= writtenAt && now - writtenAt < RenewalInterval) return;
        var durable = state.DeepClone().AsObject(); durable["at"] = DateTimeOffset.UtcNow.ToString("O");
        write(durable); // A failed write must not suppress the next attempt.
        previous = identity; writtenAt = now;
    }
}
