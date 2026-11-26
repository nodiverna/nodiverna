using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class AgentUpdater
{
    internal static bool Pending(string root) => File.Exists(Path.Combine(root, "update-plan.bin"));
    internal static string? PendingJobId(string root)
    {
        if (!Pending(root)) return null; var plan = LocalStore.ReadProtected(Path.Combine(root, "update-plan.bin"));
        string? id = plan["id"]?.GetValue<string>(); // Only the updater/guardian owns journal cleanup, including after a crash or reboot.
        return Guid.TryParse(id, out _) ? id : null;
    }
    internal static string PublicKey
    {
        get { using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("ServerDesk.Agent.release-public.pem") ?? throw new InvalidDataException("Release trust anchor is missing"); using var reader = new StreamReader(stream); return reader.ReadToEnd(); }
    }
    // A path of the path form: one file name directly below /downloads/. \z, not $,
    // so that a trailing line break does not match.
    private static readonly System.Text.RegularExpressions.Regex DownloadPath = new(@"^/downloads/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\z", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    internal static bool IsDownloadPath(string? value) => value is not null && DownloadPath.IsMatch(value) && !value.Contains("..", StringComparison.Ordinal);
    /// <summary>Verifies a release against the embedded publisher key. This is the only overload of the production paths.</summary>
    internal static JsonObject VerifyManifest(string manifest, string signature, string origin) => VerifyManifest(manifest, signature, origin, PublicKey);
    /// <summary>
    /// Verifies the signature over the received bytes first, then the fields. The
    /// path form (4.12.0) names each file by a path below /downloads/; each path
    /// resolves against the registered origin (scheme, host, port). The absolute
    /// form keeps the same-origin check. In the returned object every file entry
    /// has the resolved "url". The trust parameter exists for --installer-self-test
    /// only (NativeInstallerTests); no command-line argument reaches it.
    /// </summary>
    internal static JsonObject VerifyManifest(string manifest, string signature, string origin, string trustedPublicKeyPem)
    {
        using var signer = ECDsa.Create(); signer.ImportFromPem(trustedPublicKeyPem);
        if (!signer.VerifyData(Encoding.UTF8.GetBytes(manifest), Convert.FromBase64String(signature), HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence)) throw new CryptographicException("The release signature is not from the locally pinned publisher.");
        var data = JsonNode.Parse(manifest)?.AsObject() ?? throw new InvalidDataException("Invalid release manifest");
        if (data["arch"]?.GetValue<string>() != "x64" || data["minProtocolVersion"]?.GetValue<int>() > 3 || data["protocolVersion"]?.GetValue<int>() < 3) throw new InvalidDataException("The release protocol or architecture is unsupported.");
        // X.Y.Z or a dev build X.Y.Z-dev.<sha7> (ReleaseVersion); every other form is refused.
        string version = data["version"]!.GetValue<string>(); if (!ReleaseVersion.IsValid(version) || version.Length > 40) throw new InvalidDataException("Invalid release version");
        var site = new Uri(origin);
        if (site.Scheme != "https" || site.UserInfo.Length != 0 || site.AbsolutePath != "/" || site.Query.Length != 0 || site.Fragment.Length != 0) throw new InvalidDataException("The registered origin is not an HTTPS origin.");
        void ValidateUrl(string value) { var url = new Uri(value); if (url.Scheme != "https" || url.Host != site.Host || url.Port != site.Port || url.UserInfo.Length != 0 || !url.AbsolutePath.StartsWith("/downloads/", StringComparison.Ordinal) || url.Query.Length != 0 || url.Fragment.Length != 0) throw new InvalidDataException("The signed release URL is outside the registered origin."); }
        ResolveFiles(data, site.GetLeftPart(UriPartial.Authority));
        ValidateUrl(data["url"]!.GetValue<string>());
        long size = data["size"]!.GetValue<long>(); string hash = data["sha256"]!.GetValue<string>(); if (size is < 1 or > 104857600 || hash.Length != 64 || !hash.All(Uri.IsHexDigit)) throw new InvalidDataException("Invalid release size or SHA-256");
        if (data["parts"] is JsonArray parts && parts.Count > 0)
        {
            if (parts.Count > 10) throw new InvalidDataException("Too many signed release parts"); long total = 0;
            foreach (var part in parts) { ValidateUrl(part!["url"]!.GetValue<string>()); long length = part["size"]!.GetValue<long>(); string digest = part["sha256"]!.GetValue<string>(); if (length is < 1 or > 20971520 || digest.Length != 64 || !digest.All(Uri.IsHexDigit)) throw new InvalidDataException("Invalid signed release part"); total += length; }
            if (total != size) throw new InvalidDataException("Signed release parts do not sum to the full size");
        }
        if (data["exe"] is JsonObject exe)
        {
            ValidateUrl(exe["url"]!.GetValue<string>());
            long length = exe["size"]!.GetValue<long>(); string digest = exe["sha256"]!.GetValue<string>();
            if (length is < 1 or > 250000000 || digest.Length != 64 || !digest.All(Uri.IsHexDigit)) throw new InvalidDataException("Invalid signed executable metadata");
            if (exe["parts"] is JsonArray pieces && pieces.Count > 0)
            {
                if (pieces.Count > 12) throw new InvalidDataException("Too many executable parts"); long total = 0;
                foreach (var part in pieces) { ValidateUrl(part!["url"]!.GetValue<string>()); long n = part["size"]!.GetValue<long>(); string h = part["sha256"]!.GetValue<string>(); if (n is < 1 or > 20971520 || h.Length != 64 || !h.All(Uri.IsHexDigit)) throw new InvalidDataException("Invalid executable part"); total += n; }
                if (total != length) throw new InvalidDataException("Executable parts do not sum to the signed size");
            }
        }
        if (ReleaseVersion.Base(version).Major >= 4 && (data["layout"]?.GetValue<string>() != "single-exe" || data["exe"] is not JsonObject)) throw new InvalidDataException("Native releases require signed single-EXE metadata");
        return data;
    }
    /// <summary>
    /// All file entries (the release, its parts, the EXE and its parts) must use
    /// one form. In the path form each "path" becomes "url" = authority + path.
    /// </summary>
    private static void ResolveFiles(JsonObject data, string authority)
    {
        var entries = new List<JsonObject> { data };
        if (data["parts"] is JsonArray parts) foreach (var part in parts) entries.Add(part?.AsObject() ?? throw new InvalidDataException("Invalid signed release part"));
        if (data["exe"] is JsonObject exe)
        {
            entries.Add(exe);
            if (exe["parts"] is JsonArray pieces) foreach (var part in pieces) entries.Add(part?.AsObject() ?? throw new InvalidDataException("Invalid executable part"));
        }
        bool? pathForm = null;
        foreach (var entry in entries)
        {
            bool hasPath = entry.ContainsKey("path"), hasUrl = entry.ContainsKey("url");
            if (hasPath == hasUrl) throw new InvalidDataException("A signed release file must have either a path or a URL.");
            if (pathForm is bool form && form != hasPath) throw new InvalidDataException("The signed release mixes file paths and URLs.");
            pathForm = hasPath;
        }
        if (pathForm != true) return;
        foreach (var entry in entries)
        {
            string? path = entry["path"] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
            if (!IsDownloadPath(path)) throw new InvalidDataException("The signed release names a file outside /downloads/.");
            entry.Remove("path"); entry["url"] = authority + path;
        }
    }
    /// <summary>
    /// Whether an update from the installed version to the target may start, by
    /// rank (ReleaseVersion): a lower rank is a downgrade, the identical string is
    /// installed already. A dev build of the same base with another commit has the
    /// same rank and may replace the installed dev build; a release replaces a dev
    /// build of its base.
    /// </summary>
    internal static void CheckTarget(string target, string installed)
    {
        if (ReleaseVersion.CompareRank(target, installed) < 0) throw new InvalidOperationException("Agent downgrades are not supported.");
        if (target == installed) throw new InvalidOperationException("This release is already installed.");
    }
    internal static async Task PrepareAsync(string root, string package, JsonObject config, JsonObject job, IReleaseSource releases, CancellationToken token)
    {
        using var prepareLease = AgentUpdateLease.Acquire(root);
        if (AgentInstaller.InMaintenance(root)) throw new InvalidOperationException("A local native installation is in progress.");
        if (Pending(root)) throw new InvalidOperationException("An agent update is already staged.");
        var parameters = job["parameters"]!.AsObject(); string manifest = parameters["manifest"]!.GetValue<string>(), signature = parameters["signature"]!.GetValue<string>();
        JsonObject release = VerifyManifest(manifest, signature, config["origin"]!.GetValue<string>());
        string version = release["version"]!.GetValue<string>(); CheckTarget(version, Program.Version);
        string current = Path.Combine(root, "current"); if (!Path.GetFullPath(package).TrimEnd(Path.DirectorySeparatorChar).Equals(current, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Portal updates require the installed ServerDesk service.");
        long size = release["size"]!.GetValue<long>(); var disk = new DriveInfo(Path.GetPathRoot(root)!); if (disk.AvailableFreeSpace < size * 4 + 150_000_000) throw new IOException("Insufficient disk space for staging, backup, and rollback.");
        string id = job["id"]!.GetValue<string>(), work = Path.Combine(root, "updates", id), zip = Path.Combine(work, "release.zip"), stage = Path.Combine(work, "stage");
        // The staging folder keeps the protected installer DACL that the broker's integrity check expects (folder-staging).
        AgentInstaller.SecureDirectory(Path.Combine(root, "updates"), recursive: false); Directory.CreateDirectory(work);
        var pieces = release["parts"] is JsonArray parts && parts.Count > 0 ? parts : new JsonArray(new JsonObject { ["url"] = release["url"]!.DeepClone(), ["size"] = size, ["sha256"] = release["sha256"]!.DeepClone() });
        await using (var output = new FileStream(zip, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
        {
            foreach (var piece in pieces)
            {
                // The worker downloads each signed part; the broker verifies
                // length and SHA-256 of every byte it writes into staging.
                using var partDeadline = CancellationTokenSource.CreateLinkedTokenSource(token); partDeadline.CancelAfter(TimeSpan.FromMinutes(15));
                long length = piece!["size"]!.GetValue<long>(), before = output.Length; using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                await releases.CopyAsync(piece["url"]!.GetValue<string>(), length, output, hash, partDeadline.Token);
                string digest = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant(); if (output.Length - before != length || digest != piece["sha256"]!.GetValue<string>().ToLowerInvariant()) throw new CryptographicException("A release part is incomplete or has an invalid SHA-256.");
            }
            await output.FlushAsync(token);
        }
        await VerifyZipAsync(zip, release["sha256"]!.GetValue<string>(), token); Extract(zip, stage);
        var plan = new JsonObject { ["id"] = id, ["version"] = version, ["previousVersion"] = Program.Version, ["stage"] = stage, ["zip"] = zip, ["manifest"] = manifest, ["signature"] = signature, ["preparedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["phase"] = "prepared", ["oldMoved"] = false };
        string planPath = Path.Combine(root, "update-plan.bin"); LocalStore.SaveProtected(planPath, plan);
        string updater = Path.Combine(work, "ServerDesk.Updater.exe"); File.Copy(Environment.ProcessPath!, updater, true);
        try { await UpdateGuardian.RegisterAsync(root, updater, planPath); prepareLease.Dispose(); ProcessLifetime.LaunchUpdater(updater, planPath, root); } // The updater records its own PID/phase; the parent must never overwrite a newer journal.
        catch { File.Delete(planPath); try { await UpdateGuardian.RemoveAsync(); } catch { } throw; }
    }
    private static async Task VerifyZipAsync(string path, string expected, CancellationToken token)
    {
        await using var stream = File.OpenRead(path); string actual = Convert.ToHexString(await SHA256.HashDataAsync(stream, token)).ToLowerInvariant(); if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase)) throw new CryptographicException("The release SHA-256 does not match the signed manifest.");
    }
    internal static void Extract(string zip, string stage)
    {
        Directory.CreateDirectory(stage); string prefix = Path.GetFullPath(stage) + Path.DirectorySeparatorChar; long extracted = 0;
        using var archive = ZipFile.OpenRead(zip);
        if (archive.Entries.Count != 1 || archive.Entries[0].FullName != "ServerDesk.Agent.exe") throw new InvalidDataException("A native release must contain exactly ServerDesk.Agent.exe.");
        foreach (var entry in archive.Entries)
        {
            if (entry.FullName.Contains('\\') || entry.FullName.StartsWith('/') || entry.FullName.Contains(':') || (entry.ExternalAttributes >> 16 & 0xF000) == 0xA000) throw new InvalidDataException("Unsafe release archive entry.");
            string path = Path.GetFullPath(Path.Combine(stage, entry.FullName)); if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Release archive path traversal blocked.");
            extracted += entry.Length; if (extracted > 250_000_000) throw new InvalidDataException("The expanded release exceeds the limit.");
            if (entry.FullName.EndsWith('/')) { Directory.CreateDirectory(path); continue; } Directory.CreateDirectory(Path.GetDirectoryName(path)!); entry.ExtractToFile(path, false);
        }
        if (!File.Exists(Path.Combine(stage, "ServerDesk.Agent.exe"))) throw new InvalidDataException("The native release is incomplete.");
    }
    internal static async Task<int> ApplyAsync(string root, string planPath)
    {
        if (!Path.GetFullPath(planPath).Equals(Path.Combine(root, "update-plan.bin"), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Invalid updater plan path");
        if (!File.Exists(planPath)) { try { await UpdateGuardian.RemoveAsync(); } catch { } return 0; }
        FileStream lease; try { lease = AgentUpdateLease.Acquire(root); } catch (InvalidOperationException) { return 0; }
        using var updateLease = lease;
        string current = Path.Combine(root, "current"), backup = Path.Combine(root, "previous"), failed = Path.Combine(root, "failed-update");
        var config = LocalStore.ReadProtected(Path.Combine(root, "config.bin")); var plan = LocalStore.ReadProtected(planPath); string version = plan["version"]!.GetValue<string>();
        if (!Guid.TryParse(plan["id"]?.GetValue<string>(), out _)) throw new InvalidDataException("Invalid update job ID");
        using (var self = Process.GetCurrentProcess()) { plan["updaterPid"] = self.Id; plan["updaterStartedAt"] = self.StartTime.ToUniversalTime().ToString("O"); LocalStore.SaveProtected(planPath, plan); }
        void Phase(string phase) { plan["phase"] = phase; LocalStore.SaveProtected(planPath, plan); }
        var status = new JsonObject { ["id"] = plan["id"]!.DeepClone(), ["version"] = version, ["at"] = DateTimeOffset.UtcNow.ToString("O"), ["state"] = "maintenance" };
        LocalStore.Json(Path.Combine(root, "update-status.json"), status);
        try
        {
            var release = VerifyManifest(plan["manifest"]!.GetValue<string>(), plan["signature"]!.GetValue<string>(), config["origin"]!.GetValue<string>()); await VerifyZipAsync(plan["zip"]!.GetValue<string>(), release["sha256"]!.GetValue<string>(), CancellationToken.None);
            if (plan["phase"]?.GetValue<string>() is "rolling-back" or "rolled-back") throw new InvalidOperationException("Resuming the interrupted rollback.");
            await Task.Delay(5000); // The job remains running until the updater publishes its final health result.
            await StopServicesAsync();
            string stage = plan["stage"]!.GetValue<string>();
            if (Directory.Exists(stage))
            {
                if (Directory.Exists(current)) { if (Directory.Exists(backup)) Directory.Delete(backup, true); plan["oldMoved"] = true; Phase("switching"); Directory.Move(current, backup); }
                if (!Directory.Exists(backup)) throw new InvalidOperationException("The installed release is missing; automatic switching was refused.");
                Phase("backup-ready"); Directory.Move(stage, current); Phase("new-installed");
            }
            else if (!Directory.Exists(current) || !Directory.Exists(backup) || plan["phase"]?.GetValue<string>() == "prepared") throw new InvalidOperationException("The staged release is missing. Inspect the retained directories.");
            DateTimeOffset started = DateTimeOffset.UtcNow; StartServices();
            if (!await HealthAsync(root, version, started, 180)) throw new InvalidOperationException("The new service did not report a healthy portal heartbeat within three minutes.");
            status["state"] = "completed"; status["message"] = "Release installed and successful heartbeat verified. Previous release retained for rollback."; LocalStore.Json(Path.Combine(root, "update-status.json"), status);
            LocalStore.Json(Path.Combine(root, "v3-jobs", plan["id"]!.GetValue<string>() + ".result.json"), new JsonObject { ["id"] = plan["id"]!.DeepClone(), ["ok"] = true, ["message"] = status["message"]!.DeepClone(), ["data"] = status.DeepClone() }); File.Delete(planPath); try { await UpdateGuardian.RemoveAsync(); } catch { } return 0;
        }
        catch (Exception e)
        {
            status["state"] = "failed"; status["message"] = e.Message[..Math.Min(1500, e.Message.Length)];
            try
            {
                Phase("rolling-back");
                await StopServicesAsync();
                if (plan["oldMoved"]?.GetValue<bool>() == true && Directory.Exists(backup)) { if (Directory.Exists(failed)) Directory.Delete(failed, true); if (Directory.Exists(current)) Directory.Move(current, failed); Directory.Move(backup, current); }
                if (!Directory.Exists(current)) throw new InvalidOperationException("No executable release remains in current; recover with the local bootstrap.");
                Phase("rolled-back"); DateTimeOffset restarted = DateTimeOffset.UtcNow; StartServices();
                bool healthy = await HealthAsync(root, plan["previousVersion"]!.GetValue<string>(), restarted, 180); status["state"] = healthy ? "rolled-back" : "rollback-health-unverified"; status["rollbackHealthy"] = healthy;
            }
            catch (Exception rollback) { status["state"] = "rollback-failed"; status["rollbackError"] = rollback.Message[..Math.Min(1000, rollback.Message.Length)]; }
            LocalStore.Json(Path.Combine(root, "update-status.json"), status); LocalStore.Json(Path.Combine(root, "v3-jobs", plan["id"]!.GetValue<string>() + ".result.json"), new JsonObject { ["id"] = plan["id"]!.DeepClone(), ["ok"] = false, ["message"] = "Agent update " + status["state"] + ": " + status["message"], ["data"] = status.DeepClone() }); File.Delete(planPath); try { await UpdateGuardian.RemoveAsync(); } catch { } return 1;
        }

    }
    // The worker depends on the broker. Stop it first so the Service Control
    // Manager accepts the broker stop; start the broker first so the worker
    // finds its pipe. The broker repairs the worker's package ACL at start.
    internal static async Task StopServicesAsync()
    {
        if (WindowsService.Exists(BrokerProtocol.WorkerService)) await WindowsService.StopAsync(BrokerProtocol.WorkerService);
        await WindowsService.StopAsync(BrokerProtocol.BrokerService);
    }
    internal static void StartServices()
    {
        WindowsService.Start(BrokerProtocol.BrokerService);
        if (WindowsService.Exists(BrokerProtocol.WorkerService)) WindowsService.Start(BrokerProtocol.WorkerService);
    }
    // The unprivileged worker writes health only after the portal accepted a
    // heartbeat that the broker of the same version answered.
    internal static async Task<bool> HealthAsync(string root, string version, DateTimeOffset started, int seconds)
    {
        for (int elapsed = 0; elapsed < seconds; elapsed += 2)
        {
            try { var file = new FileInfo(BrokerProtocol.WorkerHealthPath(root)); if (file.Length > 4096 || (file.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException(); var health = JsonNode.Parse(await File.ReadAllTextAsync(file.FullName))!; if (health["version"]?.GetValue<string>() == version && DateTimeOffset.Parse(health["at"]!.GetValue<string>()) > started) return true; } catch { }
            await Task.Delay(2000);
        }
        return false;
    }
}

internal static class WindowsService
{
    [StructLayout(LayoutKind.Sequential)] private struct Status { public int Type, State, Controls, Win32Exit, SpecificExit, Checkpoint, WaitHint; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessStatus { public Status Status; public int ProcessId, Flags; }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenSCManagerW(string? machine, string? database, int access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenServiceW(IntPtr manager, string name, int access);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatus(IntPtr service, out Status status);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatusEx(IntPtr service, int level, out ProcessStatus status, int size, out int needed);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool ControlService(IntPtr service, int control, out Status status);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool StartServiceW(IntPtr service, int argc, IntPtr argv);
    [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr handle);
    private static (IntPtr Manager, IntPtr Service) Open(string name) { IntPtr manager = OpenSCManagerW(null, null, 1); if (manager == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); IntPtr service = OpenServiceW(manager, name, 0x34); if (service == IntPtr.Zero) { CloseServiceHandle(manager); throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); } return (manager, service); }
    internal static async Task StopAsync(string name)
    {
        var handles = Open(name); Process? process = null;
        try
        {
            QueryServiceStatus(handles.Service, out var status); if (status.State == 1) return;
            if (QueryServiceStatusEx(handles.Service, 0, out var info, Marshal.SizeOf<ProcessStatus>(), out _) && info.ProcessId > 0) try { process = Process.GetProcessById(info.ProcessId); _ = process.Handle; } catch (ArgumentException) { }
            if (!ControlService(handles.Service, 1, out _) && Marshal.GetLastWin32Error() != 1062) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            for (int attempt = 0; attempt < 60; attempt++)
            {
                if (QueryServiceStatus(handles.Service, out status) && status.State == 1) { if (process is not null) await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30)); return; }
                await Task.Delay(1000);
            }
            throw new TimeoutException("The agent service did not stop; no files were switched.");
        }
        finally { process?.Dispose(); CloseServiceHandle(handles.Service); CloseServiceHandle(handles.Manager); }
    }
    internal static bool Exists(string name)
    {
        IntPtr manager = OpenSCManagerW(null, null, 1); if (manager == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try { IntPtr service = OpenServiceW(manager, name, 4); if (service == IntPtr.Zero) { int error = Marshal.GetLastWin32Error(); if (error == 1060) return false; throw new System.ComponentModel.Win32Exception(error); } CloseServiceHandle(service); return true; }
        finally { CloseServiceHandle(manager); }
    }
    internal static int ProcessId(string name)
    {
        IntPtr manager = OpenSCManagerW(null, null, 1); if (manager == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            IntPtr service = OpenServiceW(manager, name, 4); if (service == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            try { return QueryServiceStatusEx(service, 0, out var info, Marshal.SizeOf<ProcessStatus>(), out _) && info.Status.State == 4 ? info.ProcessId : 0; }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }
    /// <summary>Whether the service exists, its state (1 stopped, 4 running) and its process ID (0 without one), for the broker's watchdog.</summary>
    internal static (bool Exists, int State, int ProcessId) Query(string name)
    {
        IntPtr manager = OpenSCManagerW(null, null, 1); if (manager == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            IntPtr service = OpenServiceW(manager, name, 4);
            if (service == IntPtr.Zero) { int error = Marshal.GetLastWin32Error(); if (error == 1060) return (false, 0, 0); throw new System.ComponentModel.Win32Exception(error); }
            try { return QueryServiceStatusEx(service, 0, out var info, Marshal.SizeOf<ProcessStatus>(), out _) ? (true, info.Status.State, info.ProcessId) : throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }
    internal static void Start(string name) { var handles = Open(name); try { if (!StartServiceW(handles.Service, 0, IntPtr.Zero) && Marshal.GetLastWin32Error() != 1056) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); } finally { CloseServiceHandle(handles.Service); CloseServiceHandle(handles.Manager); } }
}
