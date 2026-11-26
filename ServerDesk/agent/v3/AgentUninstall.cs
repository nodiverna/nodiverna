using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// The host facts the portal uninstall checks before it does anything. They are
// the conditions of AgentInstaller.AssertIdle and UninstallAsync.
internal sealed record UninstallProbe(bool Administrator, string Package, string Root, bool Maintenance, bool UpdatePending, int OtherJobs, bool TerminalActive, bool RdpActive, bool TransfersActive);

// The portal uninstall of the agent (job agent-uninstall). The broker checks the
// preconditions, stages a copy of its EXE outside the agent root and saves the
// result AGENT_UNINSTALL_STARTED. The portal revokes the device when that result
// arrives. Only when the portal confirms the revocation does the broker start the
// detached uninstaller: when the result comes back acknowledged (a portal answers
// a start it did not revoke with 409, never 200), or when the portal refuses the
// device credentials with AGENT_UNINSTALL_CONFIRMED for the armed job. Right
// before the start the broker hashes the staged EXE again under a handle that
// denies writers. Until then the broker starts no new job, terminal or transfer.
// Without a confirmation within ten minutes, after a 409
// AGENT_UNINSTALL_NOT_CONFIRMED, or after a broker restart, the agent stays installed.
internal sealed class PortalUninstall
{
    internal const string FolderPrefix = "ServerDesk-Uninstall-";
    internal const string LaunchedMarker = "launched";
    internal static readonly TimeSpan DeliveryTimeout = TimeSpan.FromMinutes(10);
    private readonly string root, stagingBase, sourceExe;
    private readonly Func<DateTimeOffset> clock;
    private readonly Action<string, string, string> launch;
    private readonly Action<string> log;
    private readonly bool secure;
    private readonly object gate = new();
    internal const string ConfirmedCode = "AGENT_UNINSTALL_CONFIRMED";
    private string? armedJob, armedFolder, armedExe;
    private byte[]? armedHash;
    private long armedLength;
    private DateTimeOffset armedAt;
    private bool launched;

    // secure=false only for self-tests without elevation: the staging folder then keeps the inherited ACL.
    internal PortalUninstall(string root, string? stagingBase = null, string? sourceExe = null, Func<DateTimeOffset>? clock = null, Action<string, string, string>? launch = null, Action<string>? log = null, bool secure = true)
    {
        this.root = root; this.secure = secure;
        this.stagingBase = stagingBase ?? Path.Combine(Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows", "Temp");
        this.sourceExe = sourceExe ?? Environment.ProcessPath!;
        this.clock = clock ?? (() => DateTimeOffset.UtcNow);
        this.launch = launch ?? ((exe, jobId, folder) => ProcessLifetime.LaunchUninstaller(exe, jobId, folder));
        this.log = log ?? (message => LocalStore.Log(root, message));
    }

    /// <summary>A success result is saved and not yet delivered, or the uninstaller runs: no new work.</summary>
    internal bool Busy { get { lock (gate) return armedJob is not null || launched; } }
    internal string? ArmedJob { get { lock (gate) return armedJob; } }
    /// <summary>The armed job whose start result waits for the portal's confirmation; null without one and after the launch.</summary>
    internal string? PendingJob { get { lock (gate) return launched ? null : armedJob; } }

    internal static bool IsAdministrator()
    {
        if (!OperatingSystem.IsWindows()) return false;
        using var identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    /// <summary>The code of the first precondition that fails, in the documented order, or null.</summary>
    internal static string? Refusal(UninstallProbe probe)
    {
        if (!probe.Administrator) return "AGENT_UNINSTALL_NOT_ADMIN";
        string current = Path.Combine(Path.GetFullPath(probe.Root), "current");
        if (!Path.GetFullPath(probe.Package).TrimEnd(Path.DirectorySeparatorChar).Equals(current, StringComparison.OrdinalIgnoreCase)) return "AGENT_UNINSTALL_SERVICE_REQUIRED";
        if (probe.Maintenance) return "AGENT_UNINSTALL_MAINTENANCE";
        if (probe.UpdatePending) return "AGENT_UNINSTALL_UPDATE_PENDING";
        if (probe.OtherJobs > 0) return "AGENT_UNINSTALL_JOB_ACTIVE";
        if (probe.TerminalActive || probe.RdpActive) return "AGENT_UNINSTALL_TERMINAL_ACTIVE";
        if (probe.TransfersActive) return "AGENT_UNINSTALL_TRANSFER_ACTIVE";
        return null;
    }

    /// <summary>The detached uninstaller's command line. A path with a quote is refused.</summary>
    internal static string Command(string exe, string jobId)
    {
        if (exe.Contains('"') || !Path.IsPathFullyQualified(exe)) throw new InvalidDataException("Invalid uninstaller path");
        if (!Guid.TryParseExact(jobId, "D", out _)) throw new InvalidDataException("Invalid uninstall job ID");
        return "\"" + exe + "\" --uninstall --detached " + jobId;
    }

    /// <summary>Checks the preconditions and stages the uninstaller. Returns the job result to save.</summary>
    internal JsonObject Prepare(string jobId, UninstallProbe probe)
    {
        var result = new JsonObject { ["id"] = jobId, ["ok"] = false };
        string? refusal = Refusal(probe);
        if (refusal is not null) return AgentMessages.Write(result, refusal);
        lock (gate)
        {
            if (armedJob is not null || launched) return AgentMessages.Write(result, "AGENT_UNINSTALL_BUSY");
            string folder;
            try { folder = Folder(jobId); }
            catch (Exception e) { return AgentMessages.Write(result, "AGENT_UNINSTALL_STAGE_FAILED", ("detail", e.Message)); }
            bool created = false;
            try
            {
                var (exe, hash, length) = Stage(folder, () => created = true);
                armedJob = jobId; armedFolder = folder; armedExe = exe; armedHash = hash; armedLength = length; armedAt = clock();
                result["ok"] = true;
                return AgentMessages.Write(result, "AGENT_UNINSTALL_STARTED");
            }
            catch (Exception e)
            {
                // A name that already existed is never touched; only a folder created here is removed.
                if (created) SafeDelete(folder);
                return AgentMessages.Write(result, "AGENT_UNINSTALL_STAGE_FAILED", ("detail", e.Message));
            }
        }
    }

    /// <summary>The acknowledged results of a successful channel post. Launches when they contain the armed success.</summary>
    internal void Acknowledged(JsonArray results)
    {
        foreach (var result in results)
            if (result?["id"]?.GetValue<string>() is string id && result["ok"]?.GetValue<bool>() == true && result["code"]?.GetValue<string>() == "AGENT_UNINSTALL_STARTED") Launch(id, "acknowledged");
    }

    /// <summary>
    /// The portal refused the device credentials of a channel post that named
    /// this job. Only AGENT_UNINSTALL_CONFIRMED for the armed job launches; any
    /// other refusal changes nothing.
    /// </summary>
    internal void CredentialsRefused(string jobId, string? code)
    {
        if (code == ConfirmedCode) Launch(jobId, "the portal confirmed the revocation");
    }

    /// <summary>
    /// The portal answered the start result of this job with 409
    /// AGENT_UNINSTALL_NOT_CONFIRMED: it did not revoke the device. The broker
    /// disarms at once and the agent stays installed. True when the job was armed.
    /// </summary>
    internal bool Unconfirmed(string jobId)
    {
        lock (gate)
        {
            if (armedJob != jobId || launched) return false;
            SafeDelete(armedFolder!);
            Disarm();
            log("The portal did not confirm the uninstall of job " + jobId + ". The agent stays installed.");
            return true;
        }
    }

    /// <summary>After the delivery timeout the broker stays installed. Returns the job ID that expired.</summary>
    internal string? Tick()
    {
        lock (gate)
        {
            if (armedJob is null || launched || clock() - armedAt <= DeliveryTimeout) return null;
            string expired = armedJob;
            SafeDelete(armedFolder!);
            Disarm();
            log("The portal did not confirm the uninstall result of job " + expired + " within 10 minutes. The agent stays installed.");
            return expired;
        }
    }

    /// <summary>
    /// Deletes staging folders of uninstalls that were never launched (after a
    /// broker restart): only ServerDesk-Uninstall-&lt;GUID&gt;, never the armed folder
    /// and never a folder with the launched marker. The safe delete skips links
    /// and, in secure mode, folders of other owners. One failure does not stop the others.
    /// </summary>
    internal void CleanupStale()
    {
        string[] candidates;
        try
        {
            if (!Directory.Exists(stagingBase)) return;
            candidates = Directory.GetDirectories(stagingBase, FolderPrefix + "*");
        }
        catch (Exception e) { log("Stale uninstall folders could not be inspected: " + e.Message); return; }
        foreach (string folder in candidates)
        {
            string name = Path.GetFileName(folder);
            if (!name.StartsWith(FolderPrefix, StringComparison.OrdinalIgnoreCase) || !Guid.TryParseExact(name[FolderPrefix.Length..], "D", out _)) continue;
            lock (gate)
            {
                if (armedFolder is not null && string.Equals(Path.GetFullPath(folder), armedFolder, StringComparison.OrdinalIgnoreCase)) continue;
                try { StagingFiles.DeleteFolder(folder, secure, log, LaunchedMarker); }
                catch (Exception e) { log("The stale uninstall folder " + folder + " could not be deleted: " + e.Message); }
            }
        }
    }

    private void Launch(string id, string reason)
    {
        lock (gate)
        {
            if (armedJob != id || launched) return;
            string? failure = null;
            try
            {
                // The EXE stays open with read sharing only until the launch hook
                // returns, so the bytes hashed here are the bytes that start.
                using var pinned = StagingFiles.Pin(armedFolder!, armedExe!);
                if (pinned.Stream.Length != armedLength || !CryptographicOperations.FixedTimeEquals(SHA256.HashData(pinned.Stream), armedHash!)) failure = "The staged EXE changed after staging.";
                else
                {
                    LocalStore.Atomic(Path.Combine(armedFolder!, LaunchedMarker), Encoding.UTF8.GetBytes(clock().ToString("O")));
                    launch(armedExe!, id, armedFolder!);
                    launched = true;
                }
            }
            catch (Exception e) { failure = e.Message; }
            if (launched) { log("Detached uninstaller started for job " + id + " (" + reason + ")."); return; }
            log("The detached uninstaller was not started for job " + id + ": " + failure + " The agent stays installed.");
            SafeDelete(armedFolder!);
            Disarm();
        }
    }

    private void Disarm() { armedJob = armedFolder = armedExe = null; armedHash = null; armedLength = 0; }

    private string Folder(string jobId)
    {
        if (!Guid.TryParseExact(jobId, "D", out _)) throw new InvalidDataException("Invalid uninstall job ID.");
        string folder = Path.GetFullPath(Path.Combine(stagingBase, FolderPrefix + jobId));
        string agentRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (folder.StartsWith(agentRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The staging folder must be outside the agent folder.");
        for (string? path = Path.GetFullPath(stagingBase); path is not null; path = Path.GetDirectoryName(path))
            if (Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("The staging path contains a junction or symbolic link.");
        return folder;
    }

    // A new folder for SYSTEM and Administrators only, created in one step that
    // fails when the name exists and then checked through a handle, and a
    // verified copy of the running EXE. Returns the copy with its SHA-256 and length.
    private (string Exe, byte[] Hash, long Length) Stage(string folder, Action created)
    {
        StagingFiles.CreateNew(folder, secure);
        created();
        StagingFiles.VerifyNew(folder, secure);
        string exe = Path.Combine(folder, "ServerDesk.Agent.exe");
        File.Copy(sourceExe, exe, false);
        using var source = File.OpenRead(sourceExe);
        using var copy = File.OpenRead(exe);
        byte[] hash = SHA256.HashData(copy);
        if (source.Length != copy.Length || !CryptographicOperations.FixedTimeEquals(SHA256.HashData(source), hash)) throw new CryptographicException("The staged copy differs from the running EXE.");
        return (exe, hash, copy.Length);
    }

    // Every deletion of a staging folder goes through the handle-based safe delete.
    private void SafeDelete(string folder)
    {
        try { StagingFiles.DeleteFolder(folder, secure, log); }
        catch (Exception e) { log("Uninstall staging folder could not be deleted: " + e.Message); }
    }
}
