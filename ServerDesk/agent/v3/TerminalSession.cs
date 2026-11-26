using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal sealed class TerminalSession : IAgentTerminal
{
    private readonly object gate = new();
    private readonly Action changed;
    private readonly Queue<(long Sequence, string Data)> frames = new();
    private readonly Decoder decoder = new UTF8Encoding(false, false).GetDecoder();
    private ConPty? shell;
    private FileStream? activity;
    private Task? cleanup;
    private string state = "opening", error = "";
    private long nextOutput = 1, inputAck;
    private int buffered;
    private readonly DateTimeOffset started = DateTimeOffset.UtcNow;
    private DateTimeOffset expires;
    public string Id { get; }
    public bool Alive { get { lock (gate) return state is "opening" or "open"; } }
    public bool Expired => DateTimeOffset.UtcNow >= expires || DateTimeOffset.UtcNow - started >= TimeSpan.FromHours(1);
    internal TerminalSession(string id, string root, short cols, short rows, DateTimeOffset expires, Action? changed = null)
    {
        Id = id; this.changed = changed ?? (() => { }); this.expires = expires < started.AddHours(1) ? expires : started.AddHours(1);
        try
        {
            // Admission and the entire native shell lifetime share a read lease.
            // An installer/updater's exclusive lease cannot race terminal startup
            // or switch files while a terminal process is still being drained.
            activity = AgentUpdateLease.AcquireActivity(root);
            var instance = new ConPty(PowerShellRunner.Executable, Environment.GetFolderPath(Environment.SpecialFolder.Windows), cols, rows, "--terminal-host");
            shell = instance;
            state = "open";
            instance.Output += OnOutput;
            instance.Exited += code => _ = Task.Run(async () => await CloseAsync(drainFinalOutput: true, exitMessage: "PowerShell exited (" + code + ")."));
        }
        catch (Exception e)
        {
            state = "error"; error = e.Message;
            // ConPTY construction cleans its native handles before throwing. If
            // startup failed later, close that shell before releasing admission.
            CloseAsync(drainFinalOutput: false).AsTask().GetAwaiter().GetResult();
        }
    }
    private void OnOutput(byte[] bytes)
    {
        lock (gate)
        {
            if (!Alive) return;
            char[] characters = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)]; decoder.Convert(bytes, characters, false, out _, out int count, out _);
            int position = 0;
            while (position < count)
            {
                int take = Math.Min(4096, count - position); if (position + take < count && char.IsHighSurrogate(characters[position + take - 1])) take--;
                string data = new(characters, position, take); buffered += Encoding.UTF8.GetByteCount(data);
                if (buffered > 262144) { state = "error"; error = "Terminal output buffer exceeded 256 KiB while disconnected. The shell was closed to avoid missing output."; _ = Task.Run(async () => await DisposeAsync()); return; }
                frames.Enqueue((nextOutput++, data)); position += take;
            }
        }
        changed();
    }
    public JsonObject Snapshot()
    {
        lock (gate)
        {
            // Json serialization escapes non-ASCII characters, so a UTF-8-only
            // bound is insufficient when eight independent reports are sent.
            // Retain unsent frames until their own per-session acknowledgement.
            var output = TerminalOutputFrames.Select(frames);
            // A stopped shell cannot execute input (Alive stays false), but its
            // protocol lease remains open until the final bounded output packet.
            // The server persists that packet before returning the close command.
            string reportedState = TerminalOutputFrames.ReportState(state, frames.Count, output.Count);
            var snapshot = new JsonObject { ["id"] = Id, ["state"] = reportedState, ["inputAck"] = inputAck, ["output"] = output }; if (!string.IsNullOrEmpty(error) && reportedState != "open") snapshot["error"] = error[..Math.Min(500, error.Length)]; return snapshot;
        }
    }
    public async Task AcceptAsync(JsonObject request, CancellationToken token)
    {
        if (request["id"]?.GetValue<string>() != Id) throw new InvalidOperationException("Terminal session mismatch");
        lock (gate)
        {
            long outputAck = request["outputAck"]?.GetValue<long>() ?? 0;
            while (frames.TryPeek(out var frame) && frame.Sequence <= outputAck) { frames.Dequeue(); buffered -= Encoding.UTF8.GetByteCount(frame.Data); }
        }
        expires = DateTimeOffset.TryParse(request["expiresAt"]?.GetValue<string>(), out var date) ? date < started.AddHours(1) ? date : started.AddHours(1) : expires;
        if (request["state"]?.GetValue<string>() is "closed" or "error" || Expired) { await DisposeAsync(); return; }
        try
        {
            foreach (var input in request["input"]?.AsArray() ?? new JsonArray())
            {
                long seq = input!["seq"]!.GetValue<long>(); if (seq <= inputAck) continue;
                if (seq != inputAck + 1) throw new InvalidDataException("Terminal input sequence gap; no input replay.");
                if (!Alive || shell is null || shell.HasExited) break;
                switch (input["kind"]!.GetValue<string>())
                {
                    case "input":
                        string data = input["data"]?.GetValue<string>() ?? ""; if (Encoding.UTF8.GetByteCount(data) > 32768) throw new InvalidDataException("Terminal input too large");
                        Task writing = shell.WriteAsync(Encoding.UTF8.GetBytes(data), token);
                        try { await writing.WaitAsync(TimeSpan.FromSeconds(5), token); }
                        catch { _ = writing.ContinueWith(task => _ = task.Exception, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default); throw; }
                        break; // A timeout/cancellation closes the entire shell in the catch below; uncertain input is never retried.
                    case "resize": shell.Resize((short)Math.Clamp(input["cols"]!.GetValue<int>(), 20, 400), (short)Math.Clamp(input["rows"]!.GetValue<int>(), 5, 200)); break;
                    default: throw new InvalidDataException("Unknown terminal input type");
                }
                inputAck = seq;
            }
        }
        catch { lock (gate) { state = "error"; error = "Terminal input failed or became uncertain. The shell was closed; input will not be replayed."; } await DisposeAsync(); throw; }
    }
    public ValueTask DisposeAsync() => CloseAsync(drainFinalOutput: false);

    private ValueTask CloseAsync(bool drainFinalOutput, string? exitMessage = null)
    {
        lock (gate)
        {
            if (!drainFinalOutput && state != "error") state = "closed";
            if (cleanup is null)
            {
                var instance = shell; shell = null;
                var lease = activity; activity = null;
                cleanup = CleanupAsync(instance, lease, exitMessage);
            }
            // Concurrent exit, expiry, and service shutdown all await the same
            // cleanup. None can release the lease before the native process tree.
            return new ValueTask(cleanup);
        }
    }
    private async Task CleanupAsync(ConPty? instance, FileStream? lease, string? exitMessage)
    {
        try { if (instance is not null) await instance.DisposeAsync(); }
        finally
        {
            lock (gate)
            {
                if (state != "error") { state = "closed"; if (exitMessage is not null) error = exitMessage; }
            }
            lease?.Dispose();
            changed();
        }
    }
}
