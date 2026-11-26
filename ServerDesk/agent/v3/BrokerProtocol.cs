using System.Buffers.Binary;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Win32.SafeHandles;

namespace ServerDesk.Agent;

// One local named pipe joins the SYSTEM broker and the unprivileged worker.
// Frames are a 4-byte little-endian length followed by UTF-8 JSON. Each
// connection carries one request at a time; the worker opens one connection
// per independent loop so terminal traffic never waits behind a job upload.
internal static class BrokerProtocol
{
    internal const string PipeName = "ServerDesk.Broker";
    internal const string BrokerService = "ServerDeskAgent", WorkerService = "ServerDeskWorker";
    internal const int MaximumFrame = 3_145_728;
    internal const int MaximumConnections = 24;

    internal static string WorkerRoot(string root) => Path.Combine(root, "worker");
    internal static string WorkerConfigPath(string root) => Path.Combine(root, "worker.bin");
    internal static string WorkerHealthPath(string root) => Path.Combine(WorkerRoot(root), "v3-health.json");
    internal static string InstalledExecutable(string root) => Path.GetFullPath(Path.Combine(root, "current", "ServerDesk.Agent.exe"));

    // Windows derives a service SID from the upper-case service name:
    // S-1-5-80 followed by the SHA-1 digest as five little-endian integers.
    internal static string ServiceSid(string service)
    {
        byte[] digest = SHA1.HashData(Encoding.Unicode.GetBytes(service.ToUpperInvariant()));
        var parts = Enumerable.Range(0, 5).Select(i => BinaryPrimitives.ReadUInt32LittleEndian(digest.AsSpan(i * 4, 4)).ToString(System.Globalization.CultureInfo.InvariantCulture));
        return "S-1-5-80-" + string.Join('-', parts);
    }
    internal static string WorkerSid => ServiceSid(WorkerService);

    internal static async Task WriteAsync(Stream stream, JsonObject message, CancellationToken token)
    {
        byte[] body = Encoding.UTF8.GetBytes(message.ToJsonString());
        if (body.Length > MaximumFrame) throw new InvalidDataException("Broker message exceeds the frame limit.");
        byte[] frame = new byte[4 + body.Length];
        BinaryPrimitives.WriteInt32LittleEndian(frame, body.Length); body.CopyTo(frame, 4);
        await stream.WriteAsync(frame, token); await stream.FlushAsync(token);
    }

    // Returns null on a clean end of stream before a new frame.
    internal static async Task<JsonObject?> ReadAsync(Stream stream, CancellationToken token)
    {
        byte[] header = new byte[4];
        if (!await FillAsync(stream, header, token, allowEmpty: true)) return null;
        int length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is < 2 or > MaximumFrame) throw new InvalidDataException("Invalid broker frame length.");
        byte[] body = new byte[length];
        await FillAsync(stream, body, token, allowEmpty: false);
        return JsonNode.Parse(body) as JsonObject ?? throw new InvalidDataException("Broker frame is not a JSON object.");
    }

    private static async Task<bool> FillAsync(Stream stream, byte[] buffer, CancellationToken token, bool allowEmpty)
    {
        int read = 0;
        while (read < buffer.Length)
        {
            int count = await stream.ReadAsync(buffer.AsMemory(read), token);
            if (count == 0) { if (read == 0 && allowEmpty) return false; throw new EndOfStreamException("Broker connection closed mid-frame."); }
            read += count;
        }
        return true;
    }

    internal static JsonObject Failure(string message) => new() { ["ok"] = false, ["error"] = message[..Math.Min(1500, message.Length)] };

    /// <summary>
    /// The failure reply of a broker operation: the message, the exception type, the
    /// diagnostic description (type and provider code), the collector error code and
    /// the elapsed time, so that the worker logs and reports the real cause.
    /// </summary>
    internal static JsonObject Failure(Exception error, long elapsedMs)
    {
        var reply = Failure(error.Message);
        reply["errorType"] = WindowsManagement.Limit(error.GetType().Name, 100);
        reply["errorDetail"] = WindowsManagement.Limit(NativeInventoryDiagnostics.Describe(error), 200);
        reply["errorCode"] = CollectorErrorCodes.Classify(error);
        reply["elapsedMs"] = CollectorFailure.Bound(elapsedMs);
        return reply;
    }
}

internal static class BrokerNative
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafePipeHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool WaitNamedPipeW(string name, uint timeout);

    internal static uint ClientProcessId(SafePipeHandle pipe) => GetNamedPipeClientProcessId(pipe, out uint id) ? id : throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    internal static uint ServerProcessId(SafePipeHandle pipe) => GetNamedPipeServerProcessId(pipe, out uint id) ? id : throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

    internal static string ImagePath(uint processId)
    {
        IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
        if (process == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var name = new StringBuilder(1024); uint size = (uint)name.Capacity;
            if (!QueryFullProcessImageNameW(process, 0, name, ref size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return Path.GetFullPath(name.ToString(0, (int)size));
        }
        finally { CloseHandle(process); }
    }

    // The worker asks for read/write data only. It cannot create a server
    // instance, and identification-level QoS means even a squatting server
    // could only identify, never impersonate, the worker.
    internal static NamedPipeClientStream Connect(int timeoutMilliseconds)
    {
        const uint ReadData = 0x1, WriteData = 0x2, ReadAttributes = 0x80, Synchronize = 0x100000;
        const uint OpenExisting = 3, Overlapped = 0x40000000, SqosPresent = 0x00100000, Identification = 0x00010000;
        string path = @"\\.\pipe\" + BrokerProtocol.PipeName;
        if (!WaitNamedPipeW(path, (uint)timeoutMilliseconds)) throw new IOException("The ServerDesk broker is not accepting connections.", Marshal.GetLastWin32Error());
        var handle = CreateFileW(path, ReadData | WriteData | ReadAttributes | Synchronize, 0, IntPtr.Zero, OpenExisting, Overlapped | SqosPresent | Identification, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new System.ComponentModel.Win32Exception(error, "Cannot open the ServerDesk broker pipe"); }
        try { return new NamedPipeClientStream(PipeDirection.InOut, isAsync: true, isConnected: true, handle); }
        catch { handle.Dispose(); throw; }
    }
}

// Worker-side client. Each lane owns one connection and serializes its calls;
// a timed-out call drops the connection so a late reply cannot be read as the
// answer to the next request. The broker has no idle close, so a lane that was
// idle while the broker restarted still holds the dead pipe of the old broker:
// such a stale pipe gets one retry on a fresh pipe (see CallAsync).
internal sealed class BrokerClient : IAsyncDisposable
{
    private readonly Dictionary<string, Lane> lanes = new(StringComparer.Ordinal);
    private readonly object gate = new();
    private readonly Func<CancellationToken, Task<Stream>> opener;
    // The broker's identity reply (version, device ID, public device key).
    internal JsonObject? Hello { get; private set; }
    private long lastAnswer = System.Diagnostics.Stopwatch.GetTimestamp();
    /// <summary>The time since the broker last answered any call (a refusal counts); from the client's creation before the first answer. The worker reports broker-unresponsive after 3 minutes.</summary>
    internal TimeSpan SinceLastAnswer => System.Diagnostics.Stopwatch.GetElapsedTime(Interlocked.Read(ref lastAnswer));

    internal BrokerClient() : this(null) { }
    /// <summary>Test seam: `opener` replaces the pipe, the server PID check and the hello. Null uses the broker pipe.</summary>
    internal BrokerClient(Func<CancellationToken, Task<Stream>>? opener) { this.opener = opener ?? OpenAsync; }

    /// <summary>The ops that only read: a retry after the request reached the broker cannot run anything twice.</summary>
    internal static bool IsReadOnly(string? op) => op is "telemetry" or "status";

    internal async Task<JsonObject> CallAsync(string lane, JsonObject request, TimeSpan timeout, CancellationToken token)
    {
        Lane owner; lock (gate) { if (!lanes.TryGetValue(lane, out owner!)) lanes[lane] = owner = new Lane(); }
        await owner.Gate.WaitAsync(token);
        try
        {
            // The retry shares this deadline; it does not get a new timeout.
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(timeout);
            bool readOnly = IsReadOnly(Text(request["op"]));
            for (int attempt = 0; ; attempt++)
            {
                // Only the first attempt can reuse a stream, one that an earlier call
                // opened. A pipe opened in this call that fails is a real outage, and
                // so is a failed open of the retry.
                bool reused = attempt == 0 && owner.Stream is not null, written = false;
                try
                {
                    owner.Stream ??= await opener(deadline.Token);
                    await BrokerProtocol.WriteAsync(owner.Stream, request, deadline.Token);
                    written = true;
                    var reply = await BrokerProtocol.ReadAsync(owner.Stream, deadline.Token) ?? throw new BrokerUnavailableException("The broker closed the connection.");
                    Interlocked.Exchange(ref lastAnswer, System.Diagnostics.Stopwatch.GetTimestamp());
                    if (reply["ok"]?.GetValue<bool>() != true) throw BrokerException.FromReply(reply, "The broker refused the request.");
                    return reply;
                }
                catch (Exception e) when (e is not BrokerException)
                {
                    await owner.ResetAsync();
                    if (!token.IsCancellationRequested && e is OperationCanceledException) throw new TimeoutException("The broker did not answer " + request["op"] + " in time.", e);
                    // A stale pipe that broke while the request was written: the broker
                    // never read it, so every op may retry. After a complete write only
                    // a read-only op retries, because the broker may have run it already.
                    if (reused && e is IOException && !deadline.IsCancellationRequested && (!written || readOnly)) continue;
                    // A pipe that cannot be opened, breaks or ends: the broker is not reachable.
                    if (e is IOException and not BrokerUnavailableException) throw new BrokerUnavailableException(e.Message, e);
                    throw;
                }
            }
        }
        finally { owner.Gate.Release(); }
    }

    internal static string? Text(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out string? text) && !string.IsNullOrEmpty(text) ? text : null;

    private async Task<Stream> OpenAsync(CancellationToken token)
    {
        var stream = await Task.Run(() => BrokerNative.Connect(5000), token);
        try
        {
            // Only the process the Service Control Manager runs as the broker
            // service is trusted to answer; a pipe squatter is rejected here.
            uint server = BrokerNative.ServerProcessId(stream.SafePipeHandle);
            if (server == 0 || server != (uint)WindowsService.ProcessId(BrokerProtocol.BrokerService)) throw new UnauthorizedAccessException("The broker pipe is not served by the ServerDesk broker service.");
            await BrokerProtocol.WriteAsync(stream, new JsonObject { ["op"] = "hello", ["version"] = Program.Version }, token);
            var hello = await BrokerProtocol.ReadAsync(stream, token) ?? throw new BrokerUnavailableException("The broker closed the connection during hello.");
            if (hello["ok"]?.GetValue<bool>() != true) throw new BrokerException(Text(hello["error"]) ?? "The broker refused the worker.", code: CollectorErrorCodes.BrokerUnavailable);
            Hello = hello;
            return stream;
        }
        catch { await stream.DisposeAsync(); throw; }
    }

    public async ValueTask DisposeAsync()
    {
        Lane[] all; lock (gate) all = lanes.Values.ToArray();
        foreach (var lane in all) await lane.ResetAsync();
    }

    private sealed class Lane
    {
        internal readonly SemaphoreSlim Gate = new(1, 1);
        internal Stream? Stream;
        internal async Task ResetAsync() { var stream = Stream; Stream = null; if (stream is not null) { try { await stream.DisposeAsync(); } catch { } } }
    }
}

/// <summary>A failure reply of the broker, with the broker's exception type, description, collector error code and elapsed time (null when absent).</summary>
internal sealed class BrokerException(string message, string? remoteType = null, string? detail = null, string? code = null, long? elapsedMs = null) : Exception(message)
{
    internal string? RemoteType { get; } = remoteType;
    internal string? Detail { get; } = detail;
    internal string? Code { get; } = code;
    internal long? ElapsedMs { get; } = elapsedMs;

    internal static BrokerException FromReply(JsonObject reply, string fallback)
    {
        long? elapsed = reply["elapsedMs"] is JsonValue value && value.TryGetValue<long>(out long milliseconds) && milliseconds >= 0 ? milliseconds : null;
        return new BrokerException(BrokerClient.Text(reply["error"]) ?? fallback, BrokerClient.Text(reply["errorType"]), BrokerClient.Text(reply["errorDetail"]), BrokerClient.Text(reply["errorCode"]), elapsed);
    }
}

/// <summary>The broker pipe cannot be opened, broke, or the broker closed it: code broker-unavailable.</summary>
internal sealed class BrokerUnavailableException(string message, Exception? inner = null) : IOException(message, inner);
