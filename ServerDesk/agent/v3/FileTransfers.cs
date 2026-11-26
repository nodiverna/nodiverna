using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal sealed class FileTransfers
{
    private readonly string root;
    private readonly ITransferPortal portal;
    private readonly object gate = new();
    private readonly Dictionary<string, JsonObject> states = new();
    private readonly Dictionary<string, (Task Task, CancellationTokenSource Stop)> active = new();
    internal bool Busy { get { lock (gate) return active.Values.Any(item => !item.Task.IsCompleted); } }
    // The broker owns every file handle, path check and commit. The portal
    // requests themselves run through ITransferPortal, which the broker binds
    // to the worker relay so this SYSTEM process opens no network connection.
    internal FileTransfers(string root, ITransferPortal portal)
    {
        this.root = root; this.portal = portal; Directory.CreateDirectory(Path.Combine(root, "transfers"));
        foreach (string path in Directory.GetFiles(Path.Combine(root, "transfers"), "*.result.bin"))
        {
            try
            {
                if (new FileInfo(path).Length > 65536) throw new InvalidDataException("Oversized transfer result");
                var result = LocalStore.ReadProtected(path); string id = result["id"]!.GetValue<string>();
                if (!Guid.TryParse(id, out _) || Path.GetFileName(path) != id + ".result.bin" || result["state"]?.GetValue<string>() is not ("completed" or "failed")) throw new InvalidDataException("Invalid durable transfer result");
                states[id] = result;
            }
            catch (Exception e)
            {
                LocalStore.Log(root, "Unreadable durable transfer result quarantined: " + Path.GetFileName(path) + " (" + e.GetType().Name + ")");
                try { File.Move(path, path + ".corrupt", true); } catch { }
            }
        }
        foreach (string path in Directory.GetFiles(Path.Combine(root, "transfers"), "*.ack")) if (DateTime.UtcNow - File.GetLastWriteTimeUtc(path) > TimeSpan.FromDays(30)) { string prefix = path[..^4]; File.Delete(prefix + ".claim.bin"); File.Delete(path); }
    }
    internal JsonArray States() { lock (gate) return new JsonArray(states.Values.Take(10).Select(v => v.DeepClone()).ToArray()); }
    internal void Acknowledge(JsonArray sent) { lock (gate) foreach (var item in sent) { string id = item!["id"]!.GetValue<string>(), reported = item["state"]!.GetValue<string>(); if (reported is "completed" or "failed" && states.TryGetValue(id, out var state) && state["state"]?.GetValue<string>() == reported) { LocalStore.Atomic(Path.Combine(root, "transfers", id + ".ack"), Encoding.UTF8.GetBytes(DateTimeOffset.UtcNow.ToString("O"))); File.Delete(Path.Combine(root, "transfers", id + ".result.bin")); File.Delete(Path.Combine(root, "transfers", id + ".resume.bin")); states.Remove(id); if (active.Remove(id, out var running)) running.Stop.Dispose(); } } }
    private void State(string id, string value, long? size = null, string? hash = null, string? message = null)
    {
        lock (gate) { var result = new JsonObject { ["id"] = id, ["state"] = value, ["size"] = size, ["sha256"] = hash, ["message"] = message }; states[id] = result; if (value is "completed" or "failed") LocalStore.SaveProtected(Path.Combine(root, "transfers", id + ".result.bin"), result); }
    }
    internal void Accept(JsonArray plans, bool busy, CancellationToken token)
    {
        lock (gate)
        {
            var offered = plans.Select(p => p?["id"]?.GetValue<string>()).ToHashSet();
            foreach (var item in active) if (!offered.Contains(item.Key) && !item.Value.Task.IsCompleted) item.Value.Stop.Cancel();
            foreach (var plan in plans)
            {
                string id = plan?["id"]?.GetValue<string>() ?? ""; if (!Guid.TryParse(id, out _) || active.ContainsKey(id) || states.ContainsKey(id) || File.Exists(Path.Combine(root, "transfers", id + ".ack"))) continue;
                if (busy) { State(id, "failed", message: "The device is executing a management job or preparing an agent update."); continue; }
                string claimPath = Path.Combine(root, "transfers", id + ".claim.bin");
                if (File.Exists(claimPath)) { var claim = LocalStore.ReadProtected(claimPath); if (claim["path"]?.GetValue<string>() != plan!["path"]?.GetValue<string>() || claim["direction"]?.GetValue<string>() != plan["direction"]?.GetValue<string>()) { State(id, "failed", message: "Transfer parameters changed after its durable claim; no replay."); continue; } }
                else LocalStore.SaveProtected(claimPath, new JsonObject { ["path"] = plan!["path"]!.DeepClone(), ["direction"] = plan["direction"]!.DeepClone(), ["at"] = DateTimeOffset.UtcNow.ToString("O") });
                var stop = CancellationTokenSource.CreateLinkedTokenSource(token); active[id] = (RunAsync(plan!.AsObject(), stop.Token), stop);
            }
        }
    }
    private async Task RunAsync(JsonObject plan, CancellationToken token)
    {
        string id = plan["id"]!.GetValue<string>(), direction = plan["direction"]!.GetValue<string>();
        string? staging = null; bool ownStaging = false;
        try
        {
            using var activityLease = AgentUpdateLease.AcquireActivity(root);
            bool writing = direction == "upload";
            if (direction is not ("upload" or "download")) throw new InvalidDataException("Unknown transfer direction");
            if (writing && LocalStore.ReadProtected(Path.Combine(root, "config.bin"))["mode"]?.GetValue<string>() != "Management") throw new UnauthorizedAccessException("File upload requires locally enabled Management.");
            string path = PathPolicy.Validate(plan["path"]!.GetValue<string>(), root, writing); State(id, "active", 0);
            if (writing)
            {
                long size = plan["size"]!.GetValue<long>(); string expected = plan["sha256"]!.GetValue<string>();
                if (size < 0 || size > 268_435_456 || expected.Length != 64) throw new InvalidDataException("Invalid transfer size or hash");
                bool overwrite = plan["overwrite"]?.GetValue<bool>() ?? false;
                using var parent = PathPolicy.LockParent(path);
                string parentPath = PathPolicy.FinalPath(parent);
                if (!string.Equals(parentPath.TrimEnd('\\'), Path.GetDirectoryName(path)?.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("Resolved target directory differs from the requested path.");
                staging = Path.Combine(parentPath, ".serverdesk-" + id + ".part");
                if (File.Exists(staging) && (File.GetAttributes(staging) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("Staging file is a reparse point.");
                int count = checked((int)((size + 262143) / 262144));
                string recordPath = Path.Combine(root, "transfers", id + ".resume.bin"); JsonObject? resumeRecord = File.Exists(recordPath) ? LocalStore.ReadProtected(recordPath) : null;
                if (resumeRecord is not null && resumeRecord["phase"]?.GetValue<string>() == "committing" && !File.Exists(staging))
                {
                    PathPolicy.Validate(path, root, false); await using var destination = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true);
                    string identity = PathPolicy.NoHardLinks(destination.SafeFileHandle); string resolved = PathPolicy.FinalPath(destination.SafeFileHandle); PathPolicy.Validate(resolved, root, false);
                    string hash = Convert.ToHexString(await SHA256.HashDataAsync(destination, token)).ToLowerInvariant();
                    if (identity != resumeRecord["identity"]?.GetValue<string>() || !string.Equals(resolved, path, StringComparison.OrdinalIgnoreCase) || destination.Length != size || hash != expected.ToLowerInvariant()) throw new InvalidDataException("A prior target commit is uncertain. No automatic overwrite or replay; inspect the destination.");
                    staging = null; State(id, "completed", size, hash); return;
                }
                if (resumeRecord is not null && !File.Exists(staging)) throw new InvalidDataException("The owned staging file disappeared. No automatic overwrite or replay; inspect the destination.");
                if (File.Exists(path) && !overwrite) throw new IOException("The destination already exists; overwrite was not authorized.");
                await using (var output = new FileStream(PathPolicy.OpenStaging(staging, resumeRecord is not null), FileAccess.ReadWrite, 262144, true))
                {
                    string identity = PathPolicy.NoHardLinks(output.SafeFileHandle);
                    if (!string.Equals(PathPolicy.FinalPath(output.SafeFileHandle), staging, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("The staging file resolves to a different path.");
                    if (resumeRecord is not null && (resumeRecord["identity"]?.GetValue<string>() != identity || resumeRecord["path"]?.GetValue<string>() != staging || resumeRecord["size"]?.GetValue<long>() != size || resumeRecord["sha256"]?.GetValue<string>() != expected)) throw new UnauthorizedAccessException("The staging file identity changed; resume was refused.");
                    ownStaging = true;
                    LocalStore.SaveProtected(recordPath, new JsonObject { ["identity"] = identity, ["path"] = staging, ["size"] = size, ["sha256"] = expected });
                    // Resume only complete chunks; all existing and new bytes are verified before atomic commit.
                    long resume = Math.Min(output.Length / 262144 * 262144, size); output.SetLength(resume); output.Position = resume;
                    for (int chunk = (int)(resume / 262144); chunk < count; chunk++)
                    {
                        token.ThrowIfCancellationRequested(); int length = (int)Math.Min(262144, size - (long)chunk * 262144);
                        byte[] bytes = await portal.ReadChunkAsync(id, chunk, length, token);
                        PathPolicy.NoHardLinks(output.SafeFileHandle); await output.WriteAsync(bytes, token); await output.FlushAsync(token); State(id, "active", output.Position);
                    }
                    output.Position = 0; string hash = Convert.ToHexString(await SHA256.HashDataAsync(output, token)).ToLowerInvariant();
                    if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(hash), Encoding.ASCII.GetBytes(expected.ToLowerInvariant()))) throw new CryptographicException("File SHA-256 mismatch; destination was not changed.");
                    output.Flush(true);
                    await portal.AuthorizeAsync(id, token);
                    if (LocalStore.ReadProtected(Path.Combine(root, "config.bin"))["mode"]?.GetValue<string>() != "Management") throw new UnauthorizedAccessException("Management was disabled before target commit.");
                    token.ThrowIfCancellationRequested(); PathPolicy.Validate(path, root, true);
                    LocalStore.SaveProtected(recordPath, new JsonObject { ["identity"] = identity, ["path"] = staging, ["size"] = size, ["sha256"] = expected, ["phase"] = "committing", ["destination"] = path });
                    PathPolicy.RenameOpenFile(output.SafeFileHandle, path, overwrite); staging = null;
                }
                State(id, "completed", size, expected.ToLowerInvariant());
            }
            else
            {
                await using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 262144, true);
                PathPolicy.NoHardLinks(input.SafeFileHandle);
                string actual = PathPolicy.FinalPath(input.SafeFileHandle); PathPolicy.Validate(actual, root, false);
                if (!string.Equals(actual, path, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("Resolved file differs from requested path.");
                if (input.Length > 268_435_456) throw new InvalidDataException("Transfers are limited to 256 MiB.");
                string hash = Convert.ToHexString(await SHA256.HashDataAsync(input, token)).ToLowerInvariant(); input.Position = 0;
                await portal.PrepareAsync(id, input.Length, hash, token);
                byte[] buffer = new byte[262144]; int chunk = 0;
                while (input.Position < input.Length)
                {
                    int target = (int)Math.Min(buffer.Length, input.Length - input.Position), count = 0;
                    while (count < target) { int n = await input.ReadAsync(buffer.AsMemory(count, target - count), token); if (n == 0) throw new EndOfStreamException(); count += n; }
                    await portal.WriteChunkAsync(id, chunk++, buffer.AsMemory(0, count), token); State(id, "active", input.Position);
                }
                await portal.AuthorizeAsync(id, token); State(id, "completed", input.Length, hash);
            }
        }
        catch (Exception e) { State(id, "failed", message: e is OperationCanceledException ? "Transfer cancelled; no complete destination was committed." : e.Message[..Math.Min(1500, e.Message.Length)]); if (staging is not null && ownStaging) { try { File.Delete(staging); File.Delete(Path.Combine(root, "transfers", id + ".resume.bin")); } catch { } } }
    }
    internal static async Task<byte[]> ReadUploadChunkAsync(HttpClient http, string endpoint, int expectedLength, CancellationToken token)
    {
        if (expectedLength is < 1 or > 262144) throw new InvalidDataException("Invalid transfer chunk length");
        // ResponseHeadersRead completes HttpClient's own timeout at headers.
        // Keep its deadline over the exact bounded body, including a stalled
        // proxy, without changing the transfer's resume or atomic commit path.
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        if (http.Timeout != Timeout.InfiniteTimeSpan) deadline.CancelAfter(http.Timeout);
        using var response = await http.GetAsync(endpoint, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
        response.EnsureSuccessStatusCode();
        byte[] bytes = await AgentHttpTransport.ReadBoundedAsync(response.Content, expectedLength, deadline.Token);
        if (bytes.Length != expectedLength) throw new InvalidDataException("Transfer chunk length mismatch");
        return bytes;
    }
    internal async Task StopAsync() { Task[] tasks; lock (gate) { foreach (var item in active.Values) item.Stop.Cancel(); tasks = active.Values.Select(item => item.Task).ToArray(); } await Task.WhenAll(tasks); }
}
