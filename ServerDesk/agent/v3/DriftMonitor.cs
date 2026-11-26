using Microsoft.Win32;
using System.IO.Enumeration;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal sealed class DriftMonitor
{
    private readonly string root;
    private readonly bool watch;
    private readonly JsonObject config;
    private readonly Func<JsonObject, CancellationToken, Task<JsonObject>> collect;
    private readonly Func<string, CancellationToken, Task> upload;
    private readonly Func<DateTimeOffset> now;
    private readonly Func<TimeSpan, CancellationToken, Task> delay;
    private readonly Action<JsonObject> persist;
    private readonly Action<string> log;
    private readonly List<FileSystemWatcher> watchers = new();
    private readonly object gate = new();
    private CancellationTokenSource? stop;
    private Task worker = Task.CompletedTask;
    private string? policyKey;
    private DriftScanSchedule? schedule;
    // The broker scans with its own rights; the report upload is handed to the
    // worker relay, which performs the HTTPS request with the device token.
    internal DriftMonitor(string root, JsonObject config, Func<string, CancellationToken, Task> upload)
    {
        this.root = root; this.config = config; watch = true;
        collect = ScanAsync; this.upload = (report, token) => UploadAsync(upload, report, token);
        now = () => DateTimeOffset.UtcNow; delay = (duration, token) => Task.Delay(duration, token);
        persist = policy => LocalStore.SaveProtected(Path.Combine(root, "drift-policy.bin"), policy);
        log = message => LocalStore.Log(root, message);
    }
    // Clock and transport seams exercise the real retry/lifecycle loop without
    // creating Windows watchers, changing protected settings or calling a site.
    internal DriftMonitor(Func<JsonObject, CancellationToken, Task<JsonObject>> collect, Func<string, CancellationToken, Task> upload,
        Func<DateTimeOffset> now, Func<TimeSpan, CancellationToken, Task> delay)
    {
        root = ""; config = new(); this.collect = collect; this.upload = upload; this.now = now; this.delay = delay;
        persist = _ => { }; log = _ => { };
    }
    internal void Configure(JsonObject? policy, CancellationToken token)
    {
        string? key = policy?["enabled"]?.GetValue<bool>() == true ? policy["policyId"] + ":" + policy["version"] : null;
        lock (gate)
        {
            if (key == policyKey) return;
            // Persist before replacing the running policy. A failed protected
            // write must not leave its still-active watchers without an owner.
            persist(policy ?? new JsonObject { ["enabled"] = false });
            stop?.Cancel(); foreach (var watcher in watchers) watcher.Dispose(); watchers.Clear(); policyKey = key;
            stop = null; schedule = null;
            if (key is null || policy is null) return;
            var cancellation = CancellationTokenSource.CreateLinkedTokenSource(token);
            stop = cancellation;
            var state = new DriftScanSchedule(TimeSpan.FromSeconds(Math.Clamp(policy["intervalSeconds"]?.GetValue<int>() ?? 300, 60, 86400)));
            schedule = state;
            if (watch) foreach (var item in policy["paths"]?.AsArray() ?? new JsonArray())
            {
                try
                {
                    string path = PathPolicy.Validate(item!["path"]!.GetValue<string>(), root, false);
                    bool singleFile = File.Exists(path); string? watchPath = singleFile ? Path.GetDirectoryName(path) : path;
                    if (watchPath is null || !Directory.Exists(watchPath)) continue;
                    var watcher = new FileSystemWatcher(watchPath) { Filter = singleFile ? Path.GetFileName(path) : "*", IncludeSubdirectories = !singleFile && (item["recursive"]?.GetValue<bool>() ?? true), InternalBufferSize = 8192, NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.Security };
                    // A delayed callback from a disposed old watcher belongs to
                    // that policy, never to its replacement's dirty/overflow state.
                    FileSystemEventHandler change = (_, _) => state.Changed(now());
                    watcher.Changed += change; watcher.Created += change; watcher.Deleted += change;
                    watcher.Renamed += (_, _) => state.Changed(now());
                    watcher.Error += (_, _) => state.Changed(now(), overflow: true);
                    watcher.EnableRaisingEvents = true; watchers.Add(watcher);
                }
                catch { /* Periodic scanning reports missing/inaccessible watch roots. */ }
            }
            Task previous = worker;
            JsonObject ownedPolicy = policy.DeepClone().AsObject();
            // Only one policy scans/hashes/uploads at a time. Replacement can
            // cancel immediately; its worker waits until the old one unwinds.
            worker = Task.Run(() => RunAfterPreviousAsync(previous, ownedPolicy, state, cancellation));
        }
    }
    internal void NotifyChange(bool overflow = false)
    {
        DriftScanSchedule? current; lock (gate) current = schedule;
        current?.Changed(now(), overflow);
    }
    private async Task RunAfterPreviousAsync(Task previous, JsonObject policy, DriftScanSchedule state, CancellationTokenSource cancellation)
    {
        try
        {
            try { await previous; }
            catch (Exception e) { log("Previous drift monitor: " + e.GetType().Name); }
            cancellation.Token.ThrowIfCancellationRequested();
            await LoopAsync(policy, state, cancellation.Token);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        catch (Exception e)
        {
            log("Drift monitor: " + e.GetType().Name);
            // Unexpected lifecycle failures may be restarted by the next
            // channel response, but ordinary upload/collection failures stay
            // inside the paced loop and preserve their pending report.
            lock (gate) if (ReferenceEquals(stop, cancellation)) policyKey = null;
        }
        finally
        {
            lock (gate) if (ReferenceEquals(stop, cancellation)) stop = null;
            cancellation.Dispose();
        }
    }
    private static async Task UploadAsync(Func<string, CancellationToken, Task> send, string report, CancellationToken token)
    {
        // The caller also supplies the service-stop/policy-replacement token.
        // The relayed request is bounded; no abandoned upload tasks are
        // launched on every subsequent retry.
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(30));
        await send(report, deadline.Token);
    }
    private async Task LoopAsync(JsonObject policy, DriftScanSchedule state, CancellationToken token)
    {
        string? pending = null;
        while (!token.IsCancellationRequested)
        {
            if (pending is null && state.TryBeginScan(now()))
            {
                try
                {
                    JsonObject report = await collect(policy, token);
                    token.ThrowIfCancellationRequested();
                    report["overflow"] = state.TakeOverflow();
                    pending = report.ToJsonString();
                    if (Encoding.UTF8.GetByteCount(pending) > 810_000) throw new InvalidDataException("Drift report exceeds its bounded upload size.");
                    state.ScanFinished(now());
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
                catch (Exception e)
                {
                    pending = null; state.ScanFailed(now());
                    log("Drift inventory: " + e.GetType().Name);
                }
            }
            if (pending is not null && state.UploadDue(now()))
            {
                try
                {
                    await upload(pending, token);
                    token.ThrowIfCancellationRequested();
                    pending = null; state.UploadSucceeded();
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
                catch (Exception e)
                {
                    // Retain this exact completed report/scanId. A network
                    // outage neither rehashes the host nor creates reports in
                    // an unbounded queue; the site's scanId deduplicates ACK loss.
                    state.UploadFailed(now());
                    log("Drift upload: " + e.GetType().Name);
                }
            }
            await delay(TimeSpan.FromSeconds(1), token);
        }
    }
    private async Task<JsonObject> ScanAsync(JsonObject policy, CancellationToken token)
    {
        int maxFiles = Math.Clamp(policy["maxFiles"]?.GetValue<int>() ?? 1000, 1, 5000), maxText = Math.Clamp(policy["maxTextBytes"]?.GetValue<int>() ?? 4096, 0, 16384);
        long maxBytes = Math.Clamp(policy["maxFileBytes"]?.GetValue<long>() ?? 10485760, 1, 1073741824);
        var entries = new JsonArray(); var errors = new JsonArray(); var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase); bool complete = true; int approximateBytes = 0, textBudget = 0;
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token); limit.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(policy["maxDurationSeconds"]?.GetValue<int>() ?? 60, 5, 300)));
        string[] excludes = (policy["excludes"]?.AsArray() ?? new JsonArray()).Select(x => x!.GetValue<string>()).ToArray();
        void Failure(string error) { complete = false; if (errors.Count < 20) errors.Add((JsonNode?)JsonValue.Create(error[..Math.Min(500, error.Length)])); }
        void Add(JsonObject entry) { if (!seen.Add(entry["key"]!.GetValue<string>())) return; int size = Encoding.UTF8.GetByteCount(entry.ToJsonString()); if (entries.Count >= maxFiles || approximateBytes + size > 780_000) throw new InvalidDataException("Drift inventory resource limit reached; scan is incomplete."); entries.Add((JsonNode)entry); approximateBytes += size; }
        try
        {
            foreach (var item in policy["paths"]?.AsArray() ?? new JsonArray())
            {
                try
                {
                    string path = PathPolicy.Validate(item!["path"]!.GetValue<string>(), root, false); if (!Directory.Exists(path) && !File.Exists(path)) { Failure("Configured path is missing: " + path); continue; }
                    bool recursive = item["recursive"]?.GetValue<bool>() ?? true, includeText = item["includeText"]?.GetValue<bool>() ?? false;
                    string[] extensions = (item["extensions"]?.AsArray() ?? new JsonArray()).Select(e => e!.GetValue<string>()).ToArray();
                    var enumeration = new EnumerationOptions { RecurseSubdirectories = recursive, IgnoreInaccessible = false, AttributesToSkip = FileAttributes.ReparsePoint, ReturnSpecialDirectories = false };
                    if (Directory.Exists(path))
                    {
                        foreach (string directory in new[] { path }.Concat(Directory.EnumerateDirectories(path, "*", enumeration)))
                        {
                            limit.Token.ThrowIfCancellationRequested(); string relative = Path.GetRelativePath(path, directory).Replace('\\', '/');
                            if (excludes.Any(pattern => FileSystemName.MatchesSimpleExpression(pattern.Replace('\\', '/'), relative, true) || FileSystemName.MatchesSimpleExpression(pattern, Path.GetFileName(directory), true))) continue;
                            PathPolicy.Validate(directory, root, false); Add(new JsonObject { ["key"] = "directory:" + directory.ToLowerInvariant(), ["kind"] = "directory", ["path"] = directory, ["hash"] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("directory"))).ToLowerInvariant(), ["size"] = 0 });
                        }
                    }
                    var files = Directory.Exists(path) ? Directory.EnumerateFiles(path, "*", enumeration) : new[] { path };
                    foreach (string file in files)
                    {
                        limit.Token.ThrowIfCancellationRequested(); string relative = Directory.Exists(path) ? Path.GetRelativePath(path, file).Replace('\\', '/') : Path.GetFileName(file);
                        if (excludes.Any(pattern => FileSystemName.MatchesSimpleExpression(pattern.Replace('\\', '/'), relative, true) || FileSystemName.MatchesSimpleExpression(pattern, Path.GetFileName(file), true))) continue;
                        try
                        {
                            PathPolicy.Validate(file, root, false); var info = new FileInfo(file); if (info.Length > maxBytes) { Failure("File exceeds configured hash limit: " + file); continue; }
                            await using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true);
                            PathPolicy.NoHardLinks(stream.SafeFileHandle);
                            string resolved = PathPolicy.FinalPath(stream.SafeFileHandle); PathPolicy.Validate(resolved, root, false); if (!string.Equals(resolved, file, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("Resolved drift file differs from the requested path.");
                            if (stream.Length > maxBytes) { Failure("File exceeds configured hash limit: " + file); continue; }
                            string hash = Convert.ToHexString(await SHA256.HashDataAsync(stream, limit.Token)).ToLowerInvariant(); string? text = null;
                            if (includeText && stream.Length <= maxText && textBudget + stream.Length <= 262144 && extensions.Contains(info.Extension, StringComparer.OrdinalIgnoreCase))
                            {
                                stream.Position = 0; byte[] data = new byte[(int)stream.Length]; await stream.ReadExactlyAsync(data, limit.Token);
                                try { text = new UTF8Encoding(false, true).GetString(data); if (text.Contains('\0')) text = null; else textBudget += data.Length; } catch (DecoderFallbackException) { }
                            }
                            var entry = new JsonObject { ["key"] = "file:" + file.ToLowerInvariant(), ["kind"] = "file", ["path"] = file, ["hash"] = hash, ["size"] = stream.Length, ["modifiedAt"] = info.LastWriteTimeUtc.ToString("O") }; if (text is not null) entry["text"] = text; Add(entry);
                        }
                        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { Failure("File could not be fully read: " + file); }
                    }
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { Failure(e.Message); }
            }
            foreach (var item in policy["registry"]?.AsArray() ?? new JsonArray())
            {
                limit.Token.ThrowIfCancellationRequested(); string path = item!["path"]!.GetValue<string>();
                try
                {
                    string normalized = path.Replace("HKLM:\\", "HKEY_LOCAL_MACHINE\\", StringComparison.OrdinalIgnoreCase).Replace("HKCU:\\", "HKEY_CURRENT_USER\\", StringComparison.OrdinalIgnoreCase).Replace("HKLM\\", "HKEY_LOCAL_MACHINE\\", StringComparison.OrdinalIgnoreCase).Replace("HKCU\\", "HKEY_CURRENT_USER\\", StringComparison.OrdinalIgnoreCase).Replace("HKEY_LOCAL_MACHINE:\\", "HKEY_LOCAL_MACHINE\\", StringComparison.OrdinalIgnoreCase).Replace("HKEY_CURRENT_USER:\\", "HKEY_CURRENT_USER\\", StringComparison.OrdinalIgnoreCase);
                    RegistryKey hive = normalized.StartsWith("HKEY_LOCAL_MACHINE\\", StringComparison.OrdinalIgnoreCase) ? Registry.LocalMachine : normalized.StartsWith("HKEY_CURRENT_USER\\", StringComparison.OrdinalIgnoreCase) ? Registry.CurrentUser : throw new InvalidDataException("Only HKLM/HKCU registry policies are supported");
                    using var key = hive.OpenSubKey(normalized[(normalized.IndexOf('\\') + 1)..], false);
                    if (key is null) { Failure("Registry key is missing: " + path); continue; }
                    string[] selectedNames = (item["names"]?.AsArray() ?? new JsonArray()).Select(n => n!.GetValue<string>()).ToArray();
                    if (selectedNames.Length == 0) { selectedNames = key.GetValueNames().OrderBy(n => n, StringComparer.OrdinalIgnoreCase).Take(101).ToArray(); if (selectedNames.Length > 100) { Failure("Registry key contains more than 100 values: " + path); selectedNames = selectedNames.Take(100).ToArray(); } }
                    foreach (string name in selectedNames)
                    {
                        object? value = key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames); string representation = Canonical(new JsonObject { ["type"] = value is null ? "Missing" : key.GetValueKind(name).ToString(), ["value"] = value switch { null => "<missing>", byte[] b => Convert.ToBase64String(b), string[] a => string.Join("\n", a), _ => Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) ?? "" } });
                        byte[] raw = Encoding.UTF8.GetBytes(representation); var entry = new JsonObject { ["key"] = "registry:" + normalized.ToLowerInvariant() + "\\" + name.ToLowerInvariant(), ["kind"] = "registry", ["path"] = path + "\\" + name, ["hash"] = Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant(), ["size"] = raw.Length };
                        if (item["includeValues"]?.GetValue<bool>() == true && raw.Length <= maxText && textBudget + raw.Length <= 262144) { entry["text"] = representation; textBudget += raw.Length; } Add(entry);
                    }
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidDataException) { Failure("Registry value could not be read: " + path); }
            }
            if (policy["config"] is JsonArray categories && categories.Count > 0)
            {
                {
                    var data = await NativeDriftInventory.CollectAsync(categories, limit.Token);
                    foreach (var field in data)
                    {
                        if (field.Key == "errors") { foreach (var e in field.Value?.AsArray() ?? new JsonArray()) Failure(e!.GetValue<string>()); continue; }
                        var items = field.Value is JsonArray array && array.Count > 0 ? array : new JsonArray(field.Value?.DeepClone());
                        foreach (var value in items)
                        {
                            string identifier = value is JsonObject obj ? field.Key == "network" ? obj["index"]?.ToJsonString() ?? "unknown" : field.Key == "tasks" ? (obj["path"]?.GetValue<string>() ?? "") + (obj["name"]?.GetValue<string>() ?? "unknown")
                                // An autostart entry is its category, location and name; a changed (masked) command shows as a change.
                                : field.Key == "autostart" ? AutostartIdentifier(obj) : obj["name"]?.GetValue<string>() ?? "unknown" : value is JsonValue scalar && scalar.TryGetValue<string>(out var itemName) ? itemName : "";
                            string canonical = Canonical(value); byte[] raw = Encoding.UTF8.GetBytes(canonical); bool sentinel = value is JsonArray;
                            var entry = new JsonObject { ["key"] = "config:" + field.Key + (identifier.Length == 0 ? "" : ":" + identifier.ToLowerInvariant()), ["kind"] = "config", ["path"] = field.Key + (identifier.Length == 0 ? "" : "/" + identifier), ["hash"] = Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant(), ["size"] = raw.Length };
                            if (policy["includeConfigValues"]?.GetValue<bool>() == true && raw.Length <= maxText && textBudget + raw.Length <= 262144) { entry["text"] = canonical; textBudget += raw.Length; } Add(entry);
                        }
                    }
                }
            }
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { Failure("The configured scan duration was exceeded; the report is incomplete."); }
        catch (InvalidDataException e) { Failure(e.Message); }
        return new JsonObject { ["serverId"] = config["id"]!.DeepClone(), ["policyId"] = policy["policyId"]!.DeepClone(), ["version"] = policy["version"]!.DeepClone(), ["scanId"] = Guid.NewGuid().ToString(), ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ["complete"] = complete, ["entries"] = entries, ["errors"] = errors, ["overflow"] = false };
    }
    /// <summary>The drift identifier of an autostart entry: category, location and name, at most 900 characters.</summary>
    internal static string AutostartIdentifier(JsonObject entry)
    {
        string text = (entry["category"]?.GetValue<string>() ?? "") + "\\" + (entry["location"]?.GetValue<string>() ?? "") + "\\" + (entry["name"]?.GetValue<string>() ?? "unknown");
        return text.Length <= 900 ? text : text[..900];
    }
    internal static string Canonical(JsonNode? node) => node switch { JsonObject obj => "{" + string.Join(",", obj.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => JsonValue.Create(p.Key)!.ToJsonString() + ":" + Canonical(p.Value))) + "}", JsonArray arr => "[" + string.Join(",", arr.Select(Canonical)) + "]", _ => node?.ToJsonString() ?? "null" };
    internal async Task StopAsync()
    {
        Task task;
        lock (gate) { stop?.Cancel(); foreach (var watcher in watchers) watcher.Dispose(); watchers.Clear(); schedule = null; policyKey = null; task = worker; }
        await task;
    }
}

// Collection pacing is separate from upload retry. A completed report stays in
// the loop until acknowledged, and watcher events during a scan stay dirty for
// the next scan. No size/mtime hash cache can hide same-metadata content edits.
internal sealed class DriftScanSchedule(TimeSpan interval)
{
    internal static readonly TimeSpan MinimumScanGap = TimeSpan.FromSeconds(60);
    internal static readonly TimeSpan ChangeDebounce = TimeSpan.FromSeconds(3);
    private readonly object gate = new();
    private DateTimeOffset? finished;
    private DateTimeOffset nextPeriodic = DateTimeOffset.MinValue, changedAt = DateTimeOffset.MinValue;
    private bool dirty = true, overflow, collecting;
    private int uploadFailures;
    private DateTimeOffset retryAt = DateTimeOffset.MinValue;
    internal void Changed(DateTimeOffset at, bool overflow = false)
    {
        lock (gate) { dirty = true; changedAt = at; this.overflow |= overflow; }
    }
    internal bool TryBeginScan(DateTimeOffset at)
    {
        lock (gate)
        {
            if (collecting || finished is DateTimeOffset previous && at - previous < MinimumScanGap) return false;
            if (at < nextPeriodic && (!dirty || at - changedAt < ChangeDebounce)) return false;
            dirty = false; collecting = true;
            return true;
        }
    }
    internal void ScanFinished(DateTimeOffset at) { lock (gate) { collecting = false; finished = at; nextPeriodic = at + interval; } }
    internal void ScanFailed(DateTimeOffset at) { lock (gate) { collecting = false; finished = at; nextPeriodic = at + interval; dirty = true; } }
    internal bool TakeOverflow() { lock (gate) { bool result = overflow; overflow = false; return result; } }
    internal bool UploadDue(DateTimeOffset at) => at >= retryAt;
    internal TimeSpan UploadFailed(DateTimeOffset at)
    {
        uploadFailures = Math.Min(uploadFailures + 1, 6);
        TimeSpan backoff = TimeSpan.FromSeconds(Math.Min(60, 2 << (uploadFailures - 1)));
        retryAt = at + backoff;
        return backoff;
    }
    internal void UploadSucceeded() { uploadFailures = 0; retryAt = DateTimeOffset.MinValue; }
}
