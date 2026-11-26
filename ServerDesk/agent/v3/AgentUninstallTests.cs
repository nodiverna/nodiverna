using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// The portal uninstall without services or processes: preconditions, the
// ReadOnly and busy rules, staging outside a fake root, the delivery rule for
// the launch, the timeout, a broker restart, the command line and the
// detached root check. Real service stops and CreateProcessW run only on a pilot.
internal static class AgentUninstallTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new Exception("Agent uninstall: " + message); }

    internal static void Run()
    {
        string work = Path.Combine(Path.GetTempPath(), "ServerDesk-UninstallTest-" + Guid.NewGuid().ToString("N"));
        string root = Path.Combine(work, "root"), staging = Path.Combine(work, "temp"), source = Path.Combine(work, "source.exe");
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "current")); Directory.CreateDirectory(staging);
            File.WriteAllBytes(source, RandomNumberGenerator.GetBytes(4096));
            var ready = new UninstallProbe(true, Path.Combine(root, "current") + Path.DirectorySeparatorChar, root, false, false, 0, false, false, false);

            // Preconditions: each one alone gives its code; the first failing one wins.
            Check(PortalUninstall.Refusal(ready) is null, "an idle installed service passes");
            var cases = new (UninstallProbe Probe, string Code)[]
            {
                (ready with { Administrator = false }, "AGENT_UNINSTALL_NOT_ADMIN"),
                (ready with { Package = Path.Combine(work, "download") }, "AGENT_UNINSTALL_SERVICE_REQUIRED"),
                (ready with { Maintenance = true }, "AGENT_UNINSTALL_MAINTENANCE"),
                (ready with { UpdatePending = true }, "AGENT_UNINSTALL_UPDATE_PENDING"),
                (ready with { OtherJobs = 1 }, "AGENT_UNINSTALL_JOB_ACTIVE"),
                (ready with { TerminalActive = true }, "AGENT_UNINSTALL_TERMINAL_ACTIVE"),
                (ready with { RdpActive = true }, "AGENT_UNINSTALL_TERMINAL_ACTIVE"),
                (ready with { TransfersActive = true }, "AGENT_UNINSTALL_TRANSFER_ACTIVE"),
            };
            Check(PortalUninstall.Refusal(new UninstallProbe(false, work, root, true, true, 3, true, true, true)) == "AGENT_UNINSTALL_NOT_ADMIN", "the order starts with the administrator check");
            int launches = 0; string? launchedId = null; DateTimeOffset now = DateTimeOffset.UtcNow;
            PortalUninstall Create() => new(root, staging, source, () => now, (exe, id, folder) => { launches++; launchedId = id; }, _ => { }, secure: PortalUninstall.IsAdministrator());
            foreach (var (probe, code) in cases)
            {
                Check(PortalUninstall.Refusal(probe) == code, code + " for its precondition alone");
                var refused = Create().Prepare(Guid.NewGuid().ToString(), probe);
                Check(refused["ok"]!.GetValue<bool>() == false && refused["code"]!.GetValue<string>() == code, code + " ends the job");
            }
            Check(Directory.GetDirectories(staging).Length == 0 && launches == 0, "a refused precondition stages nothing and launches nothing");

            // ReadOnly, work policy and the busy code.
            Check(JobRunner.AllowedInReadOnly("agent-uninstall") && JobRunner.AllowedInReadOnly("agent-update") && !JobRunner.AllowedInReadOnly("restart-service"), "agent-uninstall passes the ReadOnly check");
            Check(AgentWorkPolicy.BlocksJob("agent-uninstall", true, false, false) && AgentWorkPolicy.BlocksJob("agent-uninstall", false, true, false) && AgentWorkPolicy.BlocksJob("agent-uninstall", false, false, true) && !AgentWorkPolicy.BlocksJob("agent-uninstall", false, false, false), "a terminal, transfer or pending update blocks the uninstall");
            Check(JobRunner.BusyCode("agent-uninstall") == "AGENT_UNINSTALL_BUSY" && JobRunner.BusyCode("agent-update") == "AGENT_UPDATE_BUSY" && JobRunner.BusyCode("refresh") == "AGENT_BUSY", "a blocked start reports AGENT_UNINSTALL_BUSY");

            // Staging: a verified copy outside the root, then the start result.
            var uninstall = Create(); var runner = new JobRunner(root, Path.Combine(root, "current"), new JsonObject(), uninstall: uninstall);
            string job = Guid.NewGuid().ToString();
            var started = uninstall.Prepare(job, ready);
            string folder = Path.Combine(staging, PortalUninstall.FolderPrefix + job), copy = Path.Combine(folder, "ServerDesk.Agent.exe");
            Check(started["ok"]!.GetValue<bool>() && started["code"]!.GetValue<string>() == "AGENT_UNINSTALL_STARTED", "staging saves AGENT_UNINSTALL_STARTED");
            Check(File.Exists(copy) && !Path.GetFullPath(copy).StartsWith(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase), "the copy is outside the agent root");
            Check(Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(copy))) == Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(source))), "the copy has the hash of the running EXE");
            Check(uninstall.Busy && launches == 0, "the saved start makes the broker busy and launches nothing yet");
            Check(uninstall.Prepare(Guid.NewGuid().ToString(), ready)["code"]!.GetValue<string>() == "AGENT_UNINSTALL_BUSY", "a second uninstall is refused while one waits");

            // Launch only after delivery: once after Acknowledge with the result ID.
            runner.Acknowledge(new JsonArray(new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["ok"] = true, ["code"] = "AGENT_UNINSTALL_STARTED" }));
            Check(launches == 0, "another result ID does not launch");
            runner.Acknowledge(new JsonArray(started.DeepClone()));
            Check(launches == 1 && launchedId == job && File.Exists(Path.Combine(folder, PortalUninstall.LaunchedMarker)), "the acknowledgement launches once with the result ID");
            runner.Acknowledge(new JsonArray(started.DeepClone())); uninstall.CredentialsRefused(job, PortalUninstall.ConfirmedCode);
            Check(launches == 1 && uninstall.Busy && uninstall.PendingJob is null, "the launch happens once and the broker stays busy");

            // A credential refusal: only AGENT_UNINSTALL_CONFIRMED for the armed job launches.
            launches = 0; var refusedRun = Create(); string refusedJob = Guid.NewGuid().ToString();
            refusedRun.Prepare(refusedJob, ready);
            Check(refusedRun.PendingJob == refusedJob, "the armed job is the pending job for the channel header");
            refusedRun.CredentialsRefused(refusedJob, "DEVICE_TOKEN_REJECTED"); refusedRun.CredentialsRefused(refusedJob, null);
            Check(launches == 0 && refusedRun.Busy, "a refusal of the armed job with another code or no code does not launch");
            refusedRun.CredentialsRefused(Guid.NewGuid().ToString(), PortalUninstall.ConfirmedCode);
            Check(launches == 0 && refusedRun.Busy, "a confirmed refusal for another job does not launch");
            refusedRun.CredentialsRefused(refusedJob, PortalUninstall.ConfirmedCode); refusedRun.CredentialsRefused(refusedJob, PortalUninstall.ConfirmedCode);
            Check(launches == 1 && launchedId == refusedJob, "a confirmed refusal of the armed job launches exactly once");

            StagingAndLaunchChecks(work, root, ready);
            UnconfirmedChecks(work, root, ready);
            StaleCleanupChecks(work, root, ready);
            WorkerSignalChecksAsync().GetAwaiter().GetResult();

            // Timeout: after ten minutes without delivery the folder goes and nothing launches.
            launches = 0; var late = Create(); var lateRunner = new JobRunner(root, Path.Combine(root, "current"), new JsonObject(), uninstall: late);
            string lateJob = Guid.NewGuid().ToString(), lateFolder = Path.Combine(staging, PortalUninstall.FolderPrefix + lateJob), resultPath = Path.Combine(root, "v3-jobs", lateJob + ".result.json");
            var lateResult = late.Prepare(lateJob, ready); LocalStore.Json(resultPath, lateResult);
            now += TimeSpan.FromMinutes(9); lateRunner.Tick();
            Check(late.Busy && Directory.Exists(lateFolder), "before the timeout the start waits");
            now += TimeSpan.FromMinutes(2); lateRunner.Tick();
            Check(!late.Busy && !Directory.Exists(lateFolder), "after the timeout the folder is deleted and the busy state ends");
            var replaced = JsonNode.Parse(File.ReadAllText(resultPath))!;
            Check(replaced["ok"]!.GetValue<bool>() == false && replaced["code"]!.GetValue<string>() == "AGENT_UNINSTALL_STAGE_FAILED", "the undelivered start becomes a failure");
            lateRunner.Acknowledge(new JsonArray(lateResult.DeepClone()));
            Check(launches == 0, "a late acknowledgement never launches");
            File.Delete(resultPath);

            // A broker restart: the new runner does not launch and removes the stale folder.
            var before = Create(); string restartJob = Guid.NewGuid().ToString(), restartFolder = Path.Combine(staging, PortalUninstall.FolderPrefix + restartJob);
            var restartResult = before.Prepare(restartJob, ready); LocalStore.Json(Path.Combine(root, "v3-jobs", restartJob + ".result.json"), restartResult);
            var after = Create(); var restarted = new JobRunner(root, Path.Combine(root, "current"), new JsonObject(), uninstall: after);
            after.CleanupStale();
            Check(!Directory.Exists(restartFolder) && Directory.Exists(folder), "only folders of never launched uninstalls are deleted");
            Check(restarted.Results().Any(result => result?["id"]?.GetValue<string>() == restartJob && result["code"]?.GetValue<string>() == "AGENT_UNINSTALL_STAGE_FAILED"), "the undelivered start of the old broker becomes a failure");
            restarted.Acknowledge(new JsonArray(restartResult.DeepClone()));
            Check(launches == 0 && !after.Busy, "a new runner on the same root does not launch");

            // Staging failure: a missing source reports STAGE_FAILED and leaves no folder.
            var broken = new PortalUninstall(root, staging, Path.Combine(work, "missing.exe"), () => now, (_, _, _) => launches++, _ => { }, secure: PortalUninstall.IsAdministrator());
            string brokenJob = Guid.NewGuid().ToString(); var failed = broken.Prepare(brokenJob, ready);
            Check(failed["ok"]!.GetValue<bool>() == false && failed["code"]!.GetValue<string>() == "AGENT_UNINSTALL_STAGE_FAILED" && failed["args"]?["detail"] is not null, "a staging failure reports AGENT_UNINSTALL_STAGE_FAILED with a detail");
            Check(!Directory.Exists(Path.Combine(staging, PortalUninstall.FolderPrefix + brokenJob)) && !broken.Busy, "a staging failure leaves no folder");
            var inside = new PortalUninstall(root, Path.Combine(root, "temp"), source, () => now, (_, _, _) => launches++, _ => { }, secure: false);
            Check(inside.Prepare(Guid.NewGuid().ToString(), ready)["code"]!.GetValue<string>() == "AGENT_UNINSTALL_STAGE_FAILED", "a staging folder inside the agent root is refused");

            // Command line and the detached root check.
            string id = Guid.NewGuid().ToString();
            Check(PortalUninstall.Command(@"C:\Windows\Temp\ServerDesk-Uninstall-" + id + @"\ServerDesk.Agent.exe", id) == "\"C:\\Windows\\Temp\\ServerDesk-Uninstall-" + id + "\\ServerDesk.Agent.exe\" --uninstall --detached " + id, "the command line");
            bool refusedQuote = false; try { PortalUninstall.Command("C:\\Temp\\a\"b\\ServerDesk.Agent.exe", id); } catch (InvalidDataException) { refusedQuote = true; }
            Check(refusedQuote, "a path with a quote is refused");
            AgentInstaller.AssertDetachedLocation(copy, root);
            bool refusedInside = false; try { AgentInstaller.AssertDetachedLocation(Path.Combine(root, "current", "ServerDesk.Agent.exe"), root); } catch (InvalidOperationException) { refusedInside = true; }
            Check(refusedInside, "the detached uninstaller refuses an EXE inside the agent root");
        }
        finally { try { Directory.Delete(work, true); } catch { } }
    }

    private sealed class Probe
    {
        internal int Launches; internal readonly List<string> Log = [];
        internal Action<string, string, string> Hook = (_, _, _) => { };
    }

    private static PortalUninstall Instance(string root, string staging, string source, Probe probe, bool secure) =>
        new(root, staging, source, () => DateTimeOffset.UtcNow, (exe, id, folder) => { probe.Launches++; probe.Hook(exe, id, folder); }, message => { lock (probe.Log) probe.Log.Add(message); }, secure);

    private static string Source(string work, string name) { string path = Path.Combine(work, name); File.WriteAllBytes(path, RandomNumberGenerator.GetBytes(4096)); return path; }

    // Staging and launch: a name that exists, the folder's owner and DACL, the pinned EXE and a changed copy.
    private static void StagingAndLaunchChecks(string work, string root, UninstallProbe ready)
    {
        string staging = Path.Combine(work, "staging-checks"), source = Source(work, "staging-source.exe"); Directory.CreateDirectory(staging);
        bool elevated = PortalUninstall.IsAdministrator();

        // A folder that already exists, with a file in it, is refused and not touched.
        var probe = new Probe(); var existing = Instance(root, staging, source, probe, elevated);
        string folderJob = Guid.NewGuid().ToString(), folder = Path.Combine(staging, PortalUninstall.FolderPrefix + folderJob), planted = Path.Combine(folder, "planted.txt");
        Directory.CreateDirectory(folder); File.WriteAllText(planted, "attacker content");
        var refused = existing.Prepare(folderJob, ready);
        Check(refused["ok"]!.GetValue<bool>() == false && refused["code"]!.GetValue<string>() == "AGENT_UNINSTALL_STAGE_FAILED" && refused["args"]?["detail"] is not null, "an existing staging folder gives STAGE_FAILED with a detail");
        Check(File.ReadAllText(planted) == "attacker content" && Directory.GetFileSystemEntries(folder).Length == 1 && !existing.Busy && probe.Launches == 0, "the existing folder and its content stay unchanged, nothing is armed or launched");
        // A file with the folder name is refused the same way.
        string fileJob = Guid.NewGuid().ToString(), file = Path.Combine(staging, PortalUninstall.FolderPrefix + fileJob);
        File.WriteAllText(file, "a file, not a folder");
        refused = existing.Prepare(fileJob, ready);
        Check(refused["code"]!.GetValue<string>() == "AGENT_UNINSTALL_STAGE_FAILED" && File.ReadAllText(file) == "a file, not a folder" && !existing.Busy && probe.Launches == 0, "a file with the staging name gives STAGE_FAILED and stays unchanged");

        // Elevated only: owner Administrators or SYSTEM, protected DACL for those two only.
        if (elevated)
        {
            var secureProbe = new Probe(); var secured = Instance(root, staging, source, secureProbe, true); string secureJob = Guid.NewGuid().ToString();
            Check(secured.Prepare(secureJob, ready)["ok"]!.GetValue<bool>(), "secure staging succeeds when elevated");
            var descriptor = StagingFiles.SecurityOf(Path.Combine(staging, PortalUninstall.FolderPrefix + secureJob));
            var owner = descriptor.Owner;
            Check(owner is not null && (owner.IsWellKnown(System.Security.Principal.WellKnownSidType.BuiltinAdministratorsSid) || owner.IsWellKnown(System.Security.Principal.WellKnownSidType.LocalSystemSid)), "the staging folder is owned by Administrators or SYSTEM");
            Check(StagingFiles.AdministratorsOnly(descriptor), "the staging folder has a protected DACL for SYSTEM and Administrators only");
            secured.Unconfirmed(secureJob);
        }

        // While the launch hook runs, nobody can open the staged EXE for write or delete it.
        var pinProbe = new Probe(); bool writeRefused = false, deleteRefused = false;
        pinProbe.Hook = (exe, _, _) =>
        {
            try { using var stream = File.Open(exe, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete); } catch (IOException) { writeRefused = true; }
            try { File.Delete(exe); } catch (IOException) { deleteRefused = true; }
        };
        var pinned = Instance(root, staging, source, pinProbe, elevated); string pinJob = Guid.NewGuid().ToString();
        var pinStart = pinned.Prepare(pinJob, ready);
        pinned.Acknowledged(new JsonArray(pinStart.DeepClone()));
        Check(pinProbe.Launches == 1 && writeRefused && deleteRefused, "the staged EXE cannot be opened for write or deleted while the launch hook runs");
        Check(File.Exists(Path.Combine(staging, PortalUninstall.FolderPrefix + pinJob, "ServerDesk.Agent.exe")), "the staged EXE is unchanged after the launch hook");

        // A copy that changed after staging is not launched; the folder goes and the busy state ends.
        var changeProbe = new Probe(); var changed = Instance(root, staging, source, changeProbe, false); string changeJob = Guid.NewGuid().ToString();
        string changeFolder = Path.Combine(staging, PortalUninstall.FolderPrefix + changeJob), changeExe = Path.Combine(changeFolder, "ServerDesk.Agent.exe");
        var changeStart = changed.Prepare(changeJob, ready);
        byte[] bytes = File.ReadAllBytes(changeExe); bytes[100] ^= 0xFF; File.WriteAllBytes(changeExe, bytes);
        changed.Acknowledged(new JsonArray(changeStart.DeepClone()));
        Check(changeProbe.Launches == 0 && !Directory.Exists(changeFolder) && !changed.Busy, "a changed staged EXE is not launched, its folder is deleted and the broker is not busy");
        Check(changeProbe.Log.Any(line => line.Contains("changed after staging")), "the refused launch is logged");
        changed.Acknowledged(new JsonArray(changeStart.DeepClone())); changed.CredentialsRefused(changeJob, PortalUninstall.ConfirmedCode);
        Check(changeProbe.Launches == 0, "a later acknowledgement or confirmed refusal of the same job does not launch");
        // A staged EXE that is gone cannot be opened: no launch either.
        var goneProbe = new Probe(); var gone = Instance(root, staging, source, goneProbe, false); string goneJob = Guid.NewGuid().ToString();
        var goneStart = gone.Prepare(goneJob, ready); File.Delete(Path.Combine(staging, PortalUninstall.FolderPrefix + goneJob, "ServerDesk.Agent.exe"));
        gone.Acknowledged(new JsonArray(goneStart.DeepClone()));
        Check(goneProbe.Launches == 0 && !gone.Busy && !Directory.Exists(Path.Combine(staging, PortalUninstall.FolderPrefix + goneJob)), "a staged EXE that cannot be opened is not launched");
    }

    // The portal did not confirm the start: disarm at once, report STAGE_FAILED, never launch.
    private static void UnconfirmedChecks(string work, string root, UninstallProbe ready)
    {
        string staging = Path.Combine(work, "unconfirmed-checks"), source = Source(work, "unconfirmed-source.exe"); Directory.CreateDirectory(staging);
        var probe = new Probe(); var uninstall = Instance(root, staging, source, probe, PortalUninstall.IsAdministrator());
        var runner = new JobRunner(root, Path.Combine(root, "current"), new JsonObject(), uninstall: uninstall);
        string job = Guid.NewGuid().ToString(), folder = Path.Combine(staging, PortalUninstall.FolderPrefix + job), resultPath = Path.Combine(root, "v3-jobs", job + ".result.json");
        var start = uninstall.Prepare(job, ready); LocalStore.Json(resultPath, start);
        runner.Unconfirmed(Guid.NewGuid().ToString());
        Check(uninstall.Busy && Directory.Exists(folder), "an unconfirmed signal for another job changes nothing");
        runner.Unconfirmed(job);
        Check(probe.Launches == 0 && !Directory.Exists(folder) && !uninstall.Busy && uninstall.PendingJob is null, "the unconfirmed signal disarms at once: no launch, no folder, not busy");
        var saved = JsonNode.Parse(File.ReadAllText(resultPath))!;
        Check(saved["ok"]!.GetValue<bool>() == false && saved["code"]!.GetValue<string>() == "AGENT_UNINSTALL_STAGE_FAILED" && saved["args"]?["detail"]?.GetValue<string>() == "The portal did not confirm the uninstall", "the saved result becomes STAGE_FAILED with the stated detail");
        runner.Acknowledge(new JsonArray(start.DeepClone())); uninstall.CredentialsRefused(job, PortalUninstall.ConfirmedCode);
        Check(probe.Launches == 0, "a later acknowledgement of the old start result does not launch");
    }

    private static void Junction(string link, string target)
    {
        var start = new System.Diagnostics.ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (string argument in new[] { "/c", "mklink", "/J", link, target }) start.ArgumentList.Add(argument);
        using var process = System.Diagnostics.Process.Start(start)!; process.StandardOutput.ReadToEnd(); process.StandardError.ReadToEnd(); process.WaitForExit();
        Check(process.ExitCode == 0 && (File.GetAttributes(link) & FileAttributes.ReparsePoint) != 0, "mklink /J created the test junction");
    }

    // Stale cleanup: the safe delete never follows a junction, keeps its other rules and goes on after a failure.
    private static void StaleCleanupChecks(string work, string root, UninstallProbe ready)
    {
        string staging = Path.Combine(work, "stale-checks"), outside = Path.Combine(work, "outside"), source = Source(work, "stale-source.exe");
        Directory.CreateDirectory(staging); Directory.CreateDirectory(outside);
        string outsideFile = Path.Combine(outside, "keep.txt"); File.WriteAllText(outsideFile, "outside content");
        string Candidate() => Path.Combine(staging, PortalUninstall.FolderPrefix + Guid.NewGuid());

        string linkCandidate = Candidate(); Junction(linkCandidate, outside);
        string withLink = Candidate(); Directory.CreateDirectory(withLink); File.WriteAllText(Path.Combine(withLink, "staged.txt"), "x"); Junction(Path.Combine(withLink, "child"), outside);
        string plain = Candidate(); Directory.CreateDirectory(Path.Combine(plain, "nested")); File.WriteAllText(Path.Combine(plain, "nested", "file.txt"), "x");
        File.SetAttributes(Path.Combine(plain, "nested", "file.txt"), FileAttributes.ReadOnly);
        string marked = Candidate(); Directory.CreateDirectory(marked); File.WriteAllText(Path.Combine(marked, PortalUninstall.LaunchedMarker), "x");
        string notGuid = Path.Combine(staging, PortalUninstall.FolderPrefix + "not-a-guid"); Directory.CreateDirectory(notGuid);
        string locked = Candidate(); Directory.CreateDirectory(locked); string lockedFile = Path.Combine(locked, "locked.txt"); File.WriteAllText(lockedFile, "x");
        string afterLocked = Candidate(); Directory.CreateDirectory(afterLocked); File.WriteAllText(Path.Combine(afterLocked, "file.txt"), "x");

        var probe = new Probe(); var uninstall = Instance(root, staging, source, probe, false);
        string armedJob = Guid.NewGuid().ToString(), armedFolder = Path.Combine(staging, PortalUninstall.FolderPrefix + armedJob);
        Check(uninstall.Prepare(armedJob, ready)["ok"]!.GetValue<bool>(), "the armed staging succeeds next to stale folders");
        using (new FileStream(lockedFile, FileMode.Open, FileAccess.Read, FileShare.None)) uninstall.CleanupStale();

        Check(Directory.Exists(outside) && File.ReadAllText(outsideFile) == "outside content", "a junction candidate and a junction inside a candidate never delete the outside folder or its file");
        Check(Directory.Exists(linkCandidate) && (File.GetAttributes(linkCandidate) & FileAttributes.ReparsePoint) != 0, "a candidate that is a junction is skipped, not deleted");
        Check(!Directory.Exists(withLink), "a stale folder with a child junction is deleted without following the link");
        Check(!Directory.Exists(plain), "a plain stale folder with nested and read-only content is deleted");
        Check(Directory.Exists(armedFolder) && File.Exists(Path.Combine(armedFolder, "ServerDesk.Agent.exe")) && uninstall.Busy, "the armed folder is kept");
        Check(Directory.Exists(marked) && Directory.Exists(notGuid), "a folder with the launched marker and a name without a GUID are kept");
        Check(Directory.Exists(locked) && !Directory.Exists(afterLocked), "a locked candidate does not stop the deletion of another");
        Check(probe.Log.Any(line => line.Contains(linkCandidate) && line.Contains("junction")) && probe.Log.Any(line => line.Contains("child") && line.Contains("junction")) && probe.Log.Any(line => line.Contains(locked)), "skipped links, removed links and failures are logged");

        uninstall.Unconfirmed(armedJob);

        // Elevated only: in secure mode a folder of another owner is kept and logged.
        using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        if (PortalUninstall.IsAdministrator() && identity.User is { } user && !user.IsWellKnown(System.Security.Principal.WellKnownSidType.LocalSystemSid))
        {
            string foreign = Candidate(); var info = Directory.CreateDirectory(foreign);
            var security = info.GetAccessControl(); security.SetOwner(user); info.SetAccessControl(security);
            var secureProbe = new Probe(); Instance(root, staging, source, secureProbe, true).CleanupStale();
            Check(Directory.Exists(foreign) && secureProbe.Log.Any(line => line.Contains(foreign) && line.Contains("not owned")), "in secure mode a stale folder of another owner is kept and logged");
        }
    }

    // The worker's header and the portal answers that reach the broker.
    private static async Task WorkerSignalChecksAsync()
    {
        string job = Guid.NewGuid().ToString();
        var headers = UninstallChannel.Headers(job);
        Check(headers.Length == 1 && headers[0].Key == "X-ServerDesk-Uninstall-Job" && headers[0].Value == job, "an armed job gives the uninstall header");
        Check(UninstallChannel.Headers(null).Length == 0 && UninstallChannel.Headers("not-a-guid").Length == 0, "without an armed job no header is sent");

        AgentHttpException Error(System.Net.HttpStatusCode status, string? code) => new("HTTP " + (int)status, status, code);
        var refused = UninstallChannel.BrokerSignal(Error(System.Net.HttpStatusCode.Forbidden, "AGENT_UNINSTALL_CONFIRMED"), job);
        Check(refused?["op"]?.GetValue<string>() == "channel-refused" && refused["uninstallJob"]?.GetValue<string>() == job && refused["code"]?.GetValue<string>() == "AGENT_UNINSTALL_CONFIRMED", "403 AGENT_UNINSTALL_CONFIRMED forwards a refusal that names the armed job");
        Check(UninstallChannel.BrokerSignal(Error(System.Net.HttpStatusCode.Forbidden, "AGENT_UNINSTALL_CONFIRMED"), null) is null, "a post without the uninstall header forwards nothing");
        Check(UninstallChannel.BrokerSignal(Error(System.Net.HttpStatusCode.Unauthorized, null), job) is null, "401 forwards nothing");
        Check(UninstallChannel.BrokerSignal(Error(System.Net.HttpStatusCode.Forbidden, null), job) is null, "403 without a code forwards nothing");
        Check(UninstallChannel.BrokerSignal(Error(System.Net.HttpStatusCode.Forbidden, "DEVICE_TOKEN_REJECTED"), job) is null, "403 DEVICE_TOKEN_REJECTED forwards nothing");
        Check(UninstallChannel.BrokerSignal(Error(System.Net.HttpStatusCode.Unauthorized, "AGENT_UNINSTALL_CONFIRMED"), job) is null, "the confirmation code on another status forwards nothing");
        Check(UninstallChannel.BrokerSignal(new HttpRequestException("HTTP 403", null, System.Net.HttpStatusCode.Forbidden), job) is null, "a refusal without a parsed portal body forwards nothing");
        var unconfirmed = UninstallChannel.BrokerSignal(Error(System.Net.HttpStatusCode.Conflict, "AGENT_UNINSTALL_NOT_CONFIRMED"), job);
        Check(unconfirmed?["op"]?.GetValue<string>() == "channel-unconfirmed" && unconfirmed["uninstallJob"]?.GetValue<string>() == job, "409 AGENT_UNINSTALL_NOT_CONFIRMED forwards the unconfirmed signal");
        Check(UninstallChannel.BrokerSignal(Error(System.Net.HttpStatusCode.Conflict, "AGENT_V3_REQUIRED"), job) is null, "another 409 forwards nothing");

        // The transport sends the header and exposes the code of the bounded JSON error body.
        string? seen = null; var status = System.Net.HttpStatusCode.Forbidden; string body = "{\"error\":\"Gerät entfernt.\",\"code\":\"AGENT_UNINSTALL_CONFIRMED\"}", type = "application/json";
        using var http = new HttpClient(new FixtureHandler(request =>
        {
            seen = request.Headers.TryGetValues(UninstallChannel.Header, out var values) ? values.Single() : null;
            return new HttpResponseMessage(status) { Content = new StringContent(body, System.Text.Encoding.UTF8, type) };
        })) { BaseAddress = new Uri("https://portal.test") };
        async Task<AgentHttpException?> Post(KeyValuePair<string, string>[] extra)
        {
            try { await AgentHttpTransport.PostAsync(http, "/api/agent/channel", new JsonObject(), CancellationToken.None, null, extra); return null; }
            catch (AgentHttpException e) { return e; }
        }
        var error = await Post(headers);
        Check(seen == job && error?.StatusCode == System.Net.HttpStatusCode.Forbidden && error.Code == "AGENT_UNINSTALL_CONFIRMED", "the channel post carries the header and the transport exposes status and code");
        error = await Post(UninstallChannel.Headers(null));
        Check(seen is null && error?.Code == "AGENT_UNINSTALL_CONFIRMED", "without an armed job the post has no uninstall header");
        body = "<html>403 Forbidden by proxy AGENT_UNINSTALL_CONFIRMED</html>"; type = "text/html";
        error = await Post(headers);
        Check(error?.StatusCode == System.Net.HttpStatusCode.Forbidden && error.Code is null && UninstallChannel.BrokerSignal(error, job) is null, "a proxy page has no code, even when its text names the code");
        status = System.Net.HttpStatusCode.Conflict; body = "{\"error\":\"Nicht bestätigt.\",\"code\":\"AGENT_UNINSTALL_NOT_CONFIRMED\"}"; type = "application/json";
        error = await Post(headers);
        Check(error is not null && UninstallChannel.BrokerSignal(error, job)?["op"]?.GetValue<string>() == "channel-unconfirmed", "a portal 409 NOT_CONFIRMED reaches the unconfirmed signal");
    }

    private sealed class FixtureHandler(Func<HttpRequestMessage, HttpResponseMessage> reply) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => Task.FromResult(reply(request));
    }
}
