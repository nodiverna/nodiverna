using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// File transfers and agent update downloads move bytes for the broker, but
// the broker opens no network connection. It queues a fixed set of portal
// requests here; the worker takes them over the pipe, performs the HTTPS call
// with its own device token and returns the bytes. Everything the broker
// writes is still bound to a signed plan: upload hashes come from the signed
// transfer, update bytes from the pinned release manifest.
internal sealed class WorkerRelay
{
    private readonly ConcurrentQueue<Pending> queue = new();
    private readonly ConcurrentDictionary<long, Pending> inflight = new();
    private readonly SemaphoreSlim available = new(0, int.MaxValue);
    private long next;
    private sealed record Pending(long Id, JsonObject Request, TaskCompletionSource<JsonObject> Reply);

    internal async Task<JsonObject> CallAsync(JsonObject request, TimeSpan timeout, CancellationToken token)
    {
        var pending = new Pending(Interlocked.Increment(ref next), request, new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously));
        inflight[pending.Id] = pending; queue.Enqueue(pending); available.Release();
        try { return await pending.Reply.Task.WaitAsync(timeout, token); }
        catch (TimeoutException) { throw new TimeoutException("The worker did not complete the portal request " + request["kind"] + " in time."); }
        finally { inflight.TryRemove(pending.Id, out _); }
    }

    internal async Task<JsonArray> TakeAsync(int waitMilliseconds, CancellationToken token)
    {
        var taken = new JsonArray();
        if (!await available.WaitAsync(Math.Clamp(waitMilliseconds, 0, 20000), token)) return taken;
        do
        {
            // Requests whose caller already gave up are dropped, not executed.
            if (queue.TryDequeue(out var pending) && inflight.ContainsKey(pending.Id)) taken.Add(new JsonObject { ["id"] = pending.Id, ["request"] = pending.Request.DeepClone() });
        }
        while (taken.Count < 8 && available.Wait(0));
        return taken;
    }

    internal void Complete(long id, JsonObject? result, string? error)
    {
        if (!inflight.TryRemove(id, out var pending)) return;
        if (error is not null || result is null) pending.Reply.TrySetException(new IOException("Portal request failed in the worker: " + (error ?? "no result")));
        else pending.Reply.TrySetResult(result);
    }
}

internal interface ITransferPortal
{
    Task<byte[]> ReadChunkAsync(string id, int chunk, int length, CancellationToken token);
    Task PrepareAsync(string id, long size, string sha256, CancellationToken token);
    Task WriteChunkAsync(string id, int chunk, ReadOnlyMemory<byte> data, CancellationToken token);
    Task AuthorizeAsync(string id, CancellationToken token);
}

internal interface IReleaseSource
{
    Task CopyAsync(string url, long length, Stream output, IncrementalHash hash, CancellationToken token);
}

internal sealed class RelayTransferPortal(WorkerRelay relay) : ITransferPortal
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(90);
    public async Task<byte[]> ReadChunkAsync(string id, int chunk, int length, CancellationToken token)
    {
        var reply = await relay.CallAsync(new JsonObject { ["kind"] = "transfer-read", ["id"] = id, ["chunk"] = chunk, ["length"] = length }, Timeout, token);
        byte[] data = Convert.FromBase64String(reply["data"]!.GetValue<string>());
        if (data.Length != length) throw new InvalidDataException("Transfer chunk length mismatch");
        return data;
    }
    public Task PrepareAsync(string id, long size, string sha256, CancellationToken token) => relay.CallAsync(new JsonObject { ["kind"] = "transfer-prepare", ["id"] = id, ["size"] = size, ["sha256"] = sha256 }, Timeout, token);
    public Task WriteChunkAsync(string id, int chunk, ReadOnlyMemory<byte> data, CancellationToken token) => relay.CallAsync(new JsonObject { ["kind"] = "transfer-write", ["id"] = id, ["chunk"] = chunk, ["data"] = Convert.ToBase64String(data.Span) }, Timeout, token);
    public Task AuthorizeAsync(string id, CancellationToken token) => relay.CallAsync(new JsonObject { ["kind"] = "transfer-authorize", ["id"] = id }, Timeout, token);
}

internal sealed class RelayReleaseSource(WorkerRelay relay) : IReleaseSource
{
    internal const int SliceBytes = 524_288;
    public async Task CopyAsync(string url, long length, Stream output, IncrementalHash hash, CancellationToken token)
    {
        var opened = await relay.CallAsync(new JsonObject { ["kind"] = "release-open", ["url"] = url, ["size"] = length }, TimeSpan.FromMinutes(10), token);
        string handle = opened["handle"]!.GetValue<string>();
        try
        {
            for (long offset = 0; offset < length;)
            {
                int count = (int)Math.Min(SliceBytes, length - offset);
                var slice = await relay.CallAsync(new JsonObject { ["kind"] = "release-read", ["handle"] = handle, ["offset"] = offset, ["length"] = count }, TimeSpan.FromMinutes(1), token);
                byte[] data = Convert.FromBase64String(slice["data"]!.GetValue<string>());
                if (data.Length != count) throw new InvalidDataException("Release slice length mismatch.");
                hash.AppendData(data); await output.WriteAsync(data, token); offset += count;
            }
        }
        finally { try { await relay.CallAsync(new JsonObject { ["kind"] = "release-close", ["handle"] = handle }, TimeSpan.FromSeconds(30), CancellationToken.None); } catch { } }
    }
}

// Broker side of a GPU driver download (GpuDriverUpdate): one fixed relay kind
// with a handle the broker chooses, so a close also stops a download that is
// still running in the worker. Slices are larger than release slices (2 MiB,
// within BrokerProtocol.MaximumFrame after base64) because packages reach 1.7 GB.
internal sealed class RelayGpuDriverSource(WorkerRelay relay) : IGpuDriverSource
{
    internal const int SliceBytes = 2_097_152;
    public async Task CopyAsync(GpuDriverJob job, Stream output, IncrementalHash hash, CancellationToken token)
    {
        string handle = Guid.NewGuid().ToString("N");
        try
        {
            await relay.CallAsync(new JsonObject { ["kind"] = "gpu-driver-open", ["handle"] = handle, ["vendor"] = job.Vendor, ["url"] = job.Url.AbsoluteUri, ["size"] = job.SizeBytes }, GpuDriverUpdate.DownloadLimit + TimeSpan.FromMinutes(1), token);
            for (long offset = 0; offset < job.SizeBytes;)
            {
                int count = (int)Math.Min(SliceBytes, job.SizeBytes - offset);
                var slice = await relay.CallAsync(new JsonObject { ["kind"] = "gpu-driver-read", ["handle"] = handle, ["offset"] = offset, ["length"] = count }, TimeSpan.FromMinutes(1), token);
                byte[] data = Convert.FromBase64String(slice["data"]!.GetValue<string>());
                if (data.Length != count) throw new InvalidDataException("GPU driver slice length mismatch.");
                hash.AppendData(data); await output.WriteAsync(data, token); offset += count;
            }
        }
        finally { try { await relay.CallAsync(new JsonObject { ["kind"] = "gpu-driver-close", ["handle"] = handle }, TimeSpan.FromSeconds(30), CancellationToken.None); } catch { } }
    }
}

// Worker side: the direct HTTPS implementation of the transfer protocol. The
// single-process agent used the same requests from inside FileTransfers.
internal sealed class HttpTransferPortal(HttpClient http, JsonObject config) : ITransferPortal
{
    private string Endpoint(string id, int? chunk = null) => "/api/agent/transfers?serverId=" + Uri.EscapeDataString(config["id"]!.GetValue<string>()) + "&id=" + Uri.EscapeDataString(id) + (chunk is int c ? "&chunk=" + c : "");
    public Task<byte[]> ReadChunkAsync(string id, int chunk, int length, CancellationToken token) => FileTransfers.ReadUploadChunkAsync(http, Endpoint(id, chunk), length, token);
    public async Task PrepareAsync(string id, long size, string sha256, CancellationToken token)
    {
        using var body = new StringContent(new JsonObject { ["serverId"] = config["id"]!.DeepClone(), ["id"] = id, ["action"] = "prepare", ["size"] = size, ["sha256"] = sha256 }.ToJsonString(), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/api/agent/transfers", body, token); response.EnsureSuccessStatusCode();
    }
    public async Task WriteChunkAsync(string id, int chunk, ReadOnlyMemory<byte> data, CancellationToken token)
    {
        using var body = new ReadOnlyMemoryContent(data); body.Headers.ContentType = new("application/octet-stream");
        using var response = await http.PutAsync(Endpoint(id, chunk), body, token); response.EnsureSuccessStatusCode();
    }
    public async Task AuthorizeAsync(string id, CancellationToken token)
    {
        using var body = new StringContent(new JsonObject { ["serverId"] = config["id"]!.DeepClone(), ["id"] = id, ["action"] = "authorize" }.ToJsonString(), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/api/agent/transfers", body, token); response.EnsureSuccessStatusCode();
    }
}

// Worker side: executes only the fixed relay kinds above, with every ID and
// URL validated again, so the relay is not a generic HTTP proxy either way.
internal sealed class WorkerRelayExecutor
{
    private readonly HttpClient http, downloads;
    private readonly JsonObject config;
    private readonly ITransferPortal transfers;
    private readonly string downloadRoot;
    private readonly ConcurrentDictionary<string, string> releases = new(StringComparer.Ordinal);
    // GPU driver downloads by the broker's handle: the part file and the cancellation of a running download.
    private readonly GpuDriverDownloads gpuDrivers = new();
    // Vendor hosts get no device token: a client of its own, redirects followed by hand.
    private readonly HttpClient vendors;

    internal WorkerRelayExecutor(HttpClient http, HttpClient downloads, JsonObject config, string workerRoot)
    {
        this.http = http; this.downloads = downloads; this.config = config; transfers = new HttpTransferPortal(http, config);
        vendors = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = Timeout.InfiniteTimeSpan };
        vendors.DefaultRequestHeaders.UserAgent.ParseAdd("ServerDesk/" + Program.Version);
        downloadRoot = Path.Combine(workerRoot, "downloads");
        if (Directory.Exists(downloadRoot)) foreach (string stale in Directory.GetFiles(downloadRoot, "*.part")) try { File.Delete(stale); } catch { }
        Directory.CreateDirectory(downloadRoot);
    }

    internal async Task<JsonObject> ExecuteAsync(JsonObject request, CancellationToken token)
    {
        string kind = request["kind"]?.GetValue<string>() ?? "";
        switch (kind)
        {
            case "transfer-read":
            {
                int length = request["length"]!.GetValue<int>(), chunk = request["chunk"]!.GetValue<int>();
                if (chunk < 0 || length is < 1 or > 262144) throw new InvalidDataException("Invalid relayed transfer chunk.");
                return new JsonObject { ["data"] = Convert.ToBase64String(await transfers.ReadChunkAsync(TransferId(request), chunk, length, token)) };
            }
            case "transfer-prepare":
            {
                long size = request["size"]!.GetValue<long>(); string hash = request["sha256"]!.GetValue<string>();
                if (size is < 0 or > 268_435_456 || hash.Length != 64 || !hash.All(Uri.IsHexDigit)) throw new InvalidDataException("Invalid relayed transfer metadata.");
                await transfers.PrepareAsync(TransferId(request), size, hash, token); return new JsonObject();
            }
            case "transfer-write":
            {
                int chunk = request["chunk"]!.GetValue<int>(); byte[] data = Convert.FromBase64String(request["data"]!.GetValue<string>());
                if (chunk < 0 || data.Length is < 1 or > 262144) throw new InvalidDataException("Invalid relayed transfer chunk.");
                await transfers.WriteChunkAsync(TransferId(request), chunk, data, token); return new JsonObject();
            }
            case "transfer-authorize": await transfers.AuthorizeAsync(TransferId(request), token); return new JsonObject();
            case "drift-upload":
            {
                string report = (request["report"] as JsonObject ?? throw new InvalidDataException("Invalid drift report.")).ToJsonString();
                if (Encoding.UTF8.GetByteCount(report) > 2_097_152) throw new InvalidDataException("Drift report too large.");
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromSeconds(15));
                using var body = new StringContent(report, Encoding.UTF8, "application/json");
                using var reply = await http.PostAsync("/api/drift/ingest", body, deadline.Token); reply.EnsureSuccessStatusCode();
                return new JsonObject();
            }
            case "plugin-data-upload":
            {
                // The data of one plugin operation: at most 2 MiB, to the portal with the device credentials.
                if (request["data"] is not JsonObject data) throw new InvalidDataException("Invalid plugin data.");
                string plugin = request["plugin"]?.GetValue<string>() ?? "", operation = request["operation"]?.GetValue<string>() ?? "", collectedAt = request["collectedAt"]?.GetValue<string>() ?? "";
                string? jobId = request["jobId"] is JsonValue job && job.TryGetValue<string>(out var text) ? text : null;
                if (!ServerDesk.Plugins.PluginProtocol.IsName(plugin) || !ServerDesk.Plugins.PluginProtocol.IsCapability(operation) || !DateTimeOffset.TryParse(collectedAt, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out _) || jobId is not null && !Guid.TryParse(jobId, out _)) throw new InvalidDataException("Invalid plugin data.");
                if (Encoding.UTF8.GetByteCount(data.ToJsonString()) > 2_097_152) throw new InvalidDataException("Plugin data too large.");
                var payload = new JsonObject { ["serverId"] = config["id"]!.DeepClone(), ["plugin"] = plugin, ["operation"] = operation, ["jobId"] = jobId, ["collectedAt"] = collectedAt, ["data"] = data.DeepClone() };
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromSeconds(15));
                using var body = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");
                using var reply = await http.PostAsync("/api/agent/plugin-data", body, deadline.Token); reply.EnsureSuccessStatusCode();
                return new JsonObject();
            }
            case "release-open": return await OpenReleaseAsync(request, token);
            case "release-read":
            {
                string path = Release(request); long offset = request["offset"]!.GetValue<long>(); int length = request["length"]!.GetValue<int>();
                if (offset < 0 || length is < 1 or > RelayReleaseSource.SliceBytes) throw new InvalidDataException("Invalid release slice.");
                await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true);
                if (offset + length > file.Length) throw new InvalidDataException("Release slice beyond the downloaded part.");
                byte[] buffer = new byte[length]; file.Position = offset; await file.ReadExactlyAsync(buffer, token);
                return new JsonObject { ["data"] = Convert.ToBase64String(buffer) };
            }
            case "release-close":
            {
                if (releases.TryRemove(request["handle"]?.GetValue<string>() ?? "", out string? path)) try { File.Delete(path); } catch { }
                return new JsonObject();
            }
            case "gpu-driver-open": return await OpenGpuDriverAsync(request, token);
            case "gpu-driver-read":
            {
                string handle = GpuDriverHandle(request); var download = gpuDrivers.Get(handle); long offset = request["offset"]!.GetValue<long>(); int length = request["length"]!.GetValue<int>();
                if (offset < 0 || length is < 1 or > RelayGpuDriverSource.SliceBytes) throw new InvalidDataException("Invalid GPU driver slice.");
                await using var file = gpuDrivers.OpenPart(handle, download);
                if (offset + length > file.Length) throw new InvalidDataException("GPU driver slice beyond the downloaded part.");
                byte[] buffer = new byte[length]; file.Position = offset; await file.ReadExactlyAsync(buffer, token);
                return new JsonObject { ["data"] = Convert.ToBase64String(buffer) };
            }
            case "gpu-driver-close":
            {
                gpuDrivers.Close(GpuDriverHandle(request));
                return new JsonObject();
            }
            default: throw new InvalidDataException("Unsupported relay request.");
        }
    }

    private static string TransferId(JsonObject request) => Guid.TryParse(request["id"]?.GetValue<string>(), out var id) ? id.ToString() : throw new InvalidDataException("Invalid relayed transfer ID.");
    private string Release(JsonObject request) => releases.TryGetValue(request["handle"]?.GetValue<string>() ?? "", out string? path) ? path : throw new InvalidDataException("Unknown release download.");

    private static string GpuDriverHandle(JsonObject request) => request["handle"]?.GetValue<string>() is { Length: 32 } handle && handle.All(Uri.IsHexDigit) && handle == handle.ToLowerInvariant() ? handle : throw new InvalidDataException("Invalid GPU driver handle.");

    // The vendor URL is checked again here against the agent's own host list, on
    // every redirect hop as well. The declared and the received length must equal
    // the job's size, and the whole download has 30 minutes.
    private async Task<JsonObject> OpenGpuDriverAsync(JsonObject request, CancellationToken token)
    {
        string handle = GpuDriverHandle(request), vendor = request["vendor"]?.GetValue<string>() ?? "", url = request["url"]?.GetValue<string>() ?? ""; long size = request["size"]!.GetValue<long>();
        if (!GpuDriverUpdate.AllowedUrl(vendor, url)) throw new InvalidDataException("GPU driver URL is outside the vendor download hosts.");
        if (size is < 1 or > GpuDriverUpdate.MaximumBytes) throw new InvalidDataException("Invalid GPU driver size.");
        string path = Path.Combine(downloadRoot, "gpu-" + handle + ".part");
        // A download whose 30 minutes are over is stale (for example its broker died before the close): Add purges it, so it never blocks the next one.
        var download = gpuDrivers.Add(handle, path, GpuDriverUpdate.DownloadLimit, token);
        var stop = download.Token;
        try
        {
            var target = new Uri(url);
            for (int hop = 0; ; hop++)
            {
                using var message = new HttpRequestMessage(HttpMethod.Get, target);
                if (vendor == "amd") message.Headers.Referrer = new Uri(GpuDriverUpdate.AmdReferer);
                using var response = await vendors.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, stop);
                if ((int)response.StatusCode is >= 300 and < 400)
                {
                    var next = response.Headers.Location is { } location ? new Uri(target, location) : null;
                    if (hop >= 3 || next is null || !GpuDriverUpdate.AllowedUrl(vendor, next.AbsoluteUri)) throw new InvalidDataException("GPU driver redirect leaves the vendor download hosts.");
                    target = next; continue;
                }
                response.EnsureSuccessStatusCode();
                if (response.Content.Headers.ContentLength is long declared && declared != size) throw new InvalidDataException("The GPU driver package has a different length than the job.");
                await using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 20, true))
                await using (var input = await response.Content.ReadAsStreamAsync(stop))
                {
                    byte[] buffer = new byte[1 << 20]; long total = 0;
                    while (true) { int read = await input.ReadAsync(buffer, stop); if (read == 0) break; total += read; if (total > size) throw new InvalidDataException("The GPU driver package exceeded its size."); await output.WriteAsync(buffer.AsMemory(0, read), stop); }
                    if (total != size) throw new InvalidDataException("The GPU driver package is incomplete.");
                }
                return new JsonObject { ["handle"] = handle };
            }
        }
        catch { gpuDrivers.Fail(handle, download); throw; }
    }

    private async Task<JsonObject> OpenReleaseAsync(JsonObject request, CancellationToken token)
    {
        string url = request["url"]!.GetValue<string>(); long size = request["size"]!.GetValue<long>();
        var target = new Uri(url); var site = new Uri(config["origin"]!.GetValue<string>());
        if (target.Scheme != "https" || target.Host != site.Host || target.Port != site.Port || target.UserInfo.Length != 0 || !target.AbsolutePath.StartsWith("/downloads/", StringComparison.Ordinal) || target.Query.Length != 0 || target.Fragment.Length != 0) throw new InvalidDataException("Release URL is outside the registered portal.");
        if (size is < 1 or > 262_144_000) throw new InvalidDataException("Invalid release size.");
        if (releases.Count >= 2) throw new InvalidOperationException("Too many release downloads are open.");
        string handle = Guid.NewGuid().ToString("N"), path = Path.Combine(downloadRoot, handle + ".part");
        try
        {
            using var response = await downloads.GetAsync(target, HttpCompletionOption.ResponseHeadersRead, token);
            response.EnsureSuccessStatusCode();
            if (response.Content.Headers.ContentLength is long declared && declared != size) throw new InvalidDataException("Release part length does not match its signed manifest.");
            await using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
            await using (var input = await response.Content.ReadAsStreamAsync(token))
            {
                byte[] buffer = new byte[65536]; long total = 0;
                while (true) { int read = await input.ReadAsync(buffer, token); if (read == 0) break; total += read; if (total > size) throw new InvalidDataException("The release part exceeded its signed size."); await output.WriteAsync(buffer.AsMemory(0, read), token); }
                if (total != size) throw new InvalidDataException("The release part is incomplete.");
            }
            releases[handle] = path; return new JsonObject { ["handle"] = handle };
        }
        catch { try { File.Delete(path); } catch { } throw; }
    }
}

// Worker side: the open GPU driver downloads by the broker's handle (at most
// one at a time). The registry has no HTTP, so --gpu-driver-self-test runs it.
// Disposal: only the owner disposes the CancellationTokenSource of a download,
// that is the open call that failed (Fail) or gpu-driver-close after it removed
// the entry (Close). The stale purge cancels, removes and deletes the part, but
// never disposes. A Download keeps its token from the start, and its Cancel
// ignores a source that is already disposed, so a running open or read that
// still holds the entry never sees ObjectDisposedException.
internal sealed class GpuDriverDownloads
{
    internal const string UnknownMessage = "Unknown GPU driver download.";
    internal static InvalidDataException Unknown() => new(UnknownMessage);

    internal sealed class Download
    {
        private readonly CancellationTokenSource stop;
        internal Download(string path, CancellationTokenSource stop) { Path = path; this.stop = stop; Token = stop.Token; }
        internal string Path { get; }
        /// <summary>Taken when the download starts: safe to use after the source is disposed.</summary>
        internal CancellationToken Token { get; }
        internal bool Cancelled => Token.IsCancellationRequested;
        internal void Cancel() { try { stop.Cancel(); } catch (ObjectDisposedException) { } }
        internal void Dispose() => stop.Dispose();
    }

    private readonly ConcurrentDictionary<string, Download> downloads = new(StringComparer.Ordinal);
    internal int Count => downloads.Count;

    /// <summary>
    /// Removes the stale downloads first: a download whose time limit is over or
    /// that was cancelled (for example, its broker died before the close). Then
    /// adds the new one with its own time limit, or throws when another is open.
    /// The caller owns the returned download until it closes or fails.
    /// </summary>
    internal Download Add(string handle, string path, TimeSpan limit, CancellationToken token)
    {
        PurgeStale();
        var stop = CancellationTokenSource.CreateLinkedTokenSource(token); stop.CancelAfter(limit);
        var download = new Download(path, stop);
        if (!downloads.IsEmpty || !downloads.TryAdd(handle, download)) { stop.Dispose(); throw new InvalidOperationException("Another GPU driver download is open."); }
        return download;
    }

    /// <summary>Cancels, removes and deletes the part of each cancelled download. Never disposes: a running open or read can still hold the entry.</summary>
    internal void PurgeStale()
    {
        foreach (var stale in downloads)
            if (stale.Value.Cancelled && downloads.TryRemove(stale)) { stale.Value.Cancel(); try { File.Delete(stale.Value.Path); } catch { } }
    }

    /// <summary>The live download of a handle, else InvalidDataException("Unknown GPU driver download.").</summary>
    internal Download Get(string handle) => downloads.TryGetValue(handle, out var download) && !download.Cancelled ? download : throw Unknown();

    /// <summary>
    /// The part file of a download for reading. A download that was removed or
    /// cancelled, or whose part is gone (also between Get and the open), gives
    /// InvalidDataException("Unknown GPU driver download.").
    /// </summary>
    internal FileStream OpenPart(string handle, Download download)
    {
        FileStream file;
        try { file = new FileStream(download.Path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true); }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException) { throw Unknown(); }
        if (download.Cancelled || !downloads.TryGetValue(handle, out var current) || !ReferenceEquals(current, download)) { file.Dispose(); throw Unknown(); }
        return file;
    }

    /// <summary>gpu-driver-close: removes the download, stops it, deletes its part and disposes it (the owner after the removal). False when it is gone already.</summary>
    internal bool Close(string handle)
    {
        if (!downloads.TryRemove(handle, out var download)) return false;
        download.Cancel(); try { File.Delete(download.Path); } catch { }
        download.Dispose();
        return true;
    }

    /// <summary>
    /// The failure path of the open call that owns the download: removes only its
    /// own entry, deletes its part unless a newer download holds the handle, and
    /// disposes its source.
    /// </summary>
    internal void Fail(string handle, Download download)
    {
        if (downloads.TryRemove(new KeyValuePair<string, Download>(handle, download))) download.Cancel();
        if (!downloads.ContainsKey(handle)) try { File.Delete(download.Path); } catch { }
        download.Dispose();
    }
}
