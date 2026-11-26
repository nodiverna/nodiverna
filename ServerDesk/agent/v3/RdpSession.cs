using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace ServerDesk.Agent;

internal sealed class RdpSession : IRdpAgentSession
{
    private readonly string root;
    private readonly JsonObject config;
    private readonly RdpFrameCipher cipher;
    private readonly FileStream activity;
    private readonly DateTimeOffset expiry;
    private readonly Action notify;
    private readonly object gate = new();
    private readonly RdpInputLedger ledger = new();
    private readonly SortedDictionary<long, string> queued = new();
    private readonly Channel<(long Sequence, string Data)> inputs = Channel.CreateBounded<(long, string)>(new BoundedChannelOptions(64) { SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.Wait });
    private readonly RdpFrameWindow output = new();
    private readonly CancellationTokenSource stopping = new();
    private readonly Task inputTask;
    private readonly Task lifetimeTask;
    private Task? outputTask;
    private NativeRdpProxy? proxy;
    private Task? cleanup;
    private int alive = 1;
    private long lastContactTicks = DateTime.UtcNow.Ticks;
    private string state = "open", error = "";
    public string Id { get; }
    public bool Alive => Volatile.Read(ref alive) != 0;
    public bool Expired => DateTimeOffset.UtcNow >= expiry;
    public bool HasPendingOutput => output.HasPendingUpload;
    public bool IsDirect => false;
    internal RdpSession(string id, string root, JsonObject config, byte[] key, DateTimeOffset expiry, Action notify)
    {
        Id = id; this.root = root; this.config = config; this.expiry = expiry; this.notify = notify;
        // This shared lease excludes all local installers and updates while allowing
        // other users' independent sessions/jobs. It outlives every socket task.
        activity = AgentUpdateLease.AcquireActivity(root);
        try { cipher = new RdpFrameCipher(id, key); inputTask = Task.Run(InputLoopAsync); lifetimeTask = Task.Run(LifetimeLoopAsync); }
        catch { activity.Dispose(); throw; }
    }
    public JsonObject Snapshot()
    {
        lock (gate)
        {
            var result = new JsonObject { ["id"] = Id, ["state"] = state, ["inputAck"] = ledger.Ack, ["output"] = output.Snapshot() };
            if (error.Length != 0) result["error"] = error;
            return result;
        }
    }
    public void Accept(JsonObject command)
    {
        var frames = command["input"] as JsonArray ?? throw new InvalidDataException("Missing RDP input frame list.");
        if (frames.Count > 16) throw new InvalidDataException("Too many RDP input frames.");
        long acknowledged = ReadSequence(command, "outputAck", allowZero: true);
        long? stored = command.ContainsKey("outputStored") ? ReadSequence(command, "outputStored", allowZero: true) : null;
        bool progress = output.Acknowledge(acknowledged, stored);
        lock (gate)
        {
            foreach (JsonNode? entry in frames)
            {
                if (entry is not JsonObject frame) throw new InvalidDataException("Invalid RDP input frame.");
                long seq = ReadSequence(frame, "seq"); string data = frame["data"]?.GetValue<string>() ?? throw new InvalidDataException("Missing RDP input ciphertext.");
                if (seq <= ledger.Ack) { ledger.Validate(seq, data); continue; }
                if (queued.TryGetValue(seq, out string? previous)) { if (previous != data) throw new InvalidDataException("RDP input retry changed."); continue; }
                long next = queued.Count == 0 ? ledger.Ack + 1 : queued.Keys.Last() + 1;
                if (seq != next || queued.Count >= 64) throw new InvalidDataException("RDP input sequence gap or exhausted credit.");
                RdpFrameCipher.Decode(data); queued.Add(seq, data);
                if (!inputs.Writer.TryWrite((seq, data))) throw new InvalidDataException("RDP input queue is unavailable.");
            }
        }
        Volatile.Write(ref lastContactTicks, DateTime.UtcNow.Ticks);
        if (progress) notify();
    }
    internal static long ReadSequence(JsonObject value, string key, bool allowZero = false)
    {
        if (value[key] is not JsonValue number || !number.TryGetValue<long>(out long sequence) || sequence < (allowZero ? 0 : 1) || sequence > RdpFrameCipher.MaximumSequence) throw new InvalidDataException("Invalid RDP sequence number.");
        return sequence;
    }
    private void AssertAllowed()
    {
        if (Expired) throw new InvalidOperationException("Remote Desktop session expired.");
        NativeManagement.AssertManagement(root, config);
        if (AgentInstaller.InMaintenance(root) || AgentUpdater.Pending(root)) throw new InvalidOperationException("Remote Desktop cannot run during an agent update.");
        JsonObject availability = NativeRdpAvailability.Read();
        if (availability["enabled"]?.GetValue<bool>() != true || availability["nla"]?.GetValue<bool>() != true || availability["policyBlocked"]?.GetValue<bool>() == true) throw new InvalidOperationException("Enable Windows Remote Desktop with NLA/TLS before connecting. A blocking domain policy cannot be overridden.");
    }
    private async Task LifetimeLoopAsync()
    {
        try
        {
            while (!stopping.IsCancellationRequested)
            {
                await Task.Delay(500, stopping.Token);
                AssertAllowed();
                if (DateTime.UtcNow.Ticks - Volatile.Read(ref lastContactTicks) >= TimeSpan.FromSeconds(45).Ticks) throw new TimeoutException("Remote Desktop channel contact expired. Start a new session.");
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception e) { Fail(e); }
    }
    private async Task InputLoopAsync()
    {
        try
        {
            await foreach (var frame in inputs.Reader.ReadAllAsync(stopping.Token))
            {
                AssertAllowed(); byte[] plain = cipher.Decrypt(frame.Sequence, frame.Data);
                try
                {
                    if (proxy is null)
                    {
                        int port = NativeRdpAvailability.Read()["port"]!.GetValue<int>();
                        string pin = NativeRdpAvailability.CertificatePin(); AssertAllowed();
                        NativeRdpProxy connected = await NativeRdpProxy.ConnectAsync(plain, Id, port, pin, stopping.Token);
                        try { AssertAllowed(); lock (gate) { if (stopping.IsCancellationRequested) throw new OperationCanceledException(); proxy = connected; } }
                        catch { connected.Dispose(); throw; }
                        for (int offset = 0; offset < connected.Response.Length; offset += RdpFrameCipher.MaximumPlainBytes)
                        {
                            await output.WaitForCreditAsync(stopping.Token);
                            output.Add(connected.Response.AsSpan(offset, Math.Min(RdpFrameCipher.MaximumPlainBytes, connected.Response.Length - offset)).ToArray(), cipher);
                        }
                        outputTask = OutputLoopAsync(connected);
                    }
                    else await proxy.WriteAsync(plain, stopping.Token);
                    lock (gate) { ledger.Commit(frame.Sequence, frame.Data); queued.Remove(frame.Sequence); }
                }
                finally { CryptographicOperations.ZeroMemory(plain); }
                notify();
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception e) { Fail(e); }
    }
    private async Task OutputLoopAsync(NativeRdpProxy connected)
    {
        await using var coalescer = new RdpOutputCoalescer(connected.ReadAsync, stopping.Token);
        try
        {
            while (!stopping.IsCancellationRequested)
            {
                await output.WaitForCreditAsync(stopping.Token); AssertAllowed();
                byte[]? chunk = await coalescer.ReadFrameAsync();
                if (chunk is null) { Close(); break; }
                try { AssertAllowed(); output.Add(chunk, cipher); } finally { CryptographicOperations.ZeroMemory(chunk); }
                notify();
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception e) { Fail(e); }
    }
    private void Fail(Exception error)
    {
        string message = error switch
        {
            CryptographicException => "Remote Desktop encryption validation failed. Start a new session.",
            System.Security.Authentication.AuthenticationException => "The local Windows RDP certificate did not match its listener or TLS negotiation failed.",
            _ => error.Message,
        };
        lock (gate) { state = "error"; this.error = message[..Math.Min(500, message.Length)]; }
        Close(preserveError: true);
    }
    private void Close(bool preserveError = false)
    {
        lock (gate) { if (!preserveError && state != "error") state = "closed"; Volatile.Write(ref alive, 0); }
        stopping.Cancel(); inputs.Writer.TryComplete(); proxy?.Dispose(); notify();
    }
    public ValueTask DisposeAsync()
    {
        Task task;
        lock (gate) task = cleanup ??= CleanupAsync();
        return new ValueTask(task);
    }
    private async Task CleanupAsync()
    {
        // Yield before invoking notify: no external callback may run while the
        // registry/session lock is held (the worker publishes update state).
        await Task.Yield(); Close();
        try { await inputTask; await lifetimeTask; if (outputTask is not null) await outputTask; }
        finally { lock (gate) queued.Clear(); output.Clear(); cipher.Dispose(); activity.Dispose(); stopping.Dispose(); }
    }
}
