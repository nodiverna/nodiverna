using System.Diagnostics;
using System.IO.Compression;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace ServerDesk.Agent;

internal static class AgentInstaller
{
    private const string Maintenance = "install-maintenance.bin";
    internal static bool InMaintenance(string root)
    {
        string path = Path.Combine(root, Maintenance);
        if (!File.Exists(path)) return false;
        try
        {
            var marker = LocalStore.ReadProtected(path);
            using var process = Process.GetProcessById(marker["pid"]!.GetValue<int>());
            return !process.HasExited && process.StartTime.ToUniversalTime().Ticks == marker["startedTicks"]!.GetValue<long>();
        }
        catch { return false; } // An interrupted installer cannot permanently block the agent.
    }
    private static void RequireAdministrator()
    {
        if (!OperatingSystem.IsWindows() || System.Runtime.InteropServices.RuntimeInformation.OSArchitecture != System.Runtime.InteropServices.Architecture.X64) throw new PlatformNotSupportedException("ServerDesk requires x64 Windows.");
        using var identity = WindowsIdentity.GetCurrent();
        if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) throw new UnauthorizedAccessException("Start the native installer from an elevated administrator terminal.");
    }
    private static void RequireSupportedWindows()
    {
        using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
        string type = key?.GetValue("InstallationType") as string ?? "", edition = key?.GetValue("EditionID") as string ?? "";
        if (!int.TryParse(key?.GetValue("CurrentBuildNumber") as string, out int build)) throw new PlatformNotSupportedException("Windows build could not be determined.");
        bool server = (type is "Server" or "Server Core") && (build is 20348 or 26100);
        bool client = type == "Client" && build >= 22000 && build < 30000 && (edition.StartsWith("Professional", StringComparison.Ordinal) || edition.StartsWith("Enterprise", StringComparison.Ordinal));
        if (!server && !client) throw new PlatformNotSupportedException("Supported: Windows Server 2022/2025 and Windows 11 Pro/Enterprise, x64.");
    }
    internal static JsonObject ValidateConfiguration(JsonObject value)
    {
        string id = value["id"]?.GetValue<string>() ?? "", token = value["token"]?.GetValue<string>() ?? "", origin = value["origin"]?.GetValue<string>() ?? "", mode = value["mode"]?.GetValue<string>() ?? "ReadOnly";
        if (!Guid.TryParseExact(id, "D", out _) || token.Length != 64 || !token.All(Uri.IsHexDigit)) throw new InvalidDataException("Invalid registration identity or token.");
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var site) || site.Scheme != "https" || site.AbsolutePath != "/" || site.UserInfo.Length != 0 || site.Query.Length != 0 || site.Fragment.Length != 0 || site.Port < 1) throw new InvalidDataException("The registration requires an HTTPS origin.");
        if (mode is not ("ReadOnly" or "Management")) throw new InvalidDataException("Only ReadOnly or Management is supported.");
        var clean = new JsonObject { ["id"] = id, ["token"] = token, ["origin"] = origin.TrimEnd('/'), ["mode"] = mode };
        if (value["jobSigningKey"]?.GetValue<string>() is string jobSigningKey) clean["jobSigningKey"] = DispatchVerifier.ValidateKey(jobSigningKey);
        if (value["privateKey"]?.GetValue<string>() is string privateKey)
        {
            if (privateKey.Length > 16384) throw new InvalidDataException("Invalid device key size.");
            using var rsa = LocalStore.ReadRsa(privateKey); if (rsa.KeySize < 2048 || rsa.ExportParameters(true).D is null) throw new InvalidDataException("A private device RSA key is required.");
            clean["privateKey"] = privateKey;
        }
        return clean;
    }
    private static void AssertNoReparse(string root)
    {
        for (string? path = Path.GetFullPath(root); path is not null; path = Path.GetDirectoryName(path))
            if ((Directory.Exists(path) || File.Exists(path)) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("The agent installation path contains a junction or symbolic link.");
    }
    internal static void SecureDirectory(string root, bool recursive = true)
    {
        AssertNoReparse(root); Directory.CreateDirectory(root);
        var admins = new SecurityIdentifier("S-1-5-32-544"); var system = new SecurityIdentifier("S-1-5-18");
        void ProtectFolder(string path)
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("The agent directory contains a reparse point.");
            var security = new DirectorySecurity(); security.SetAccessRuleProtection(true, false); security.SetOwner(admins);
            foreach (var sid in new[] { admins, system }) security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(path).SetAccessControl(security);
            if (!recursive) return;
            // The worker's own directory keeps its separate ACL. Recursing into
            // it would let planted links redirect this administrator write.
            foreach (string folder in Directory.GetDirectories(path)) if (!Path.GetFullPath(folder).Equals(Path.GetFullPath(BrokerProtocol.WorkerRoot(root)), StringComparison.OrdinalIgnoreCase)) ProtectFolder(folder);
            foreach (string file in Directory.GetFiles(path))
            {
                // The caller holds this exclusive handle; it inherits the root ACL.
                if (Path.GetFullPath(file).Equals(Path.Combine(Path.GetFullPath(root), "update.lock"), StringComparison.OrdinalIgnoreCase)) continue;
                if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("The agent directory contains a reparse point.");
                using var locked = File.OpenHandle(file, FileMode.Open, FileAccess.Read, FileShare.Read); PathPolicy.NoHardLinks(locked);
                var acl = new FileSecurity(); acl.SetAccessRuleProtection(true, false); acl.SetOwner(admins);
                foreach (var sid in new[] { admins, system }) acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
                new FileInfo(file).SetAccessControl(acl);
            }
        }
        ProtectFolder(root);
    }
    private static void AssertIdle(string root)
    {
        if (AgentUpdater.Pending(root)) throw new InvalidOperationException("An agent update is pending. Allow its recovery to finish first.");
        if (!NativeServiceSetup.Running()) return;
        string path = Path.Combine(root, "active-state.json");
        if (!File.Exists(path)) throw new InvalidOperationException("The service has not reported its current work state. Retry shortly.");
        var state = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        if (!DateTimeOffset.TryParse(state["at"]?.GetValue<string>(), out var at) || DateTimeOffset.UtcNow - at > TimeSpan.FromSeconds(30) || at > DateTimeOffset.UtcNow.AddSeconds(5)) throw new InvalidOperationException("The service work state is stale; inspect the service before installation.");
        if ((state["runningJobs"]?.AsArray().Count ?? 0) != 0 || state["terminalActive"]?.GetValue<bool>() == true || state["rdpActive"]?.GetValue<bool>() == true || state["transfersActive"]?.GetValue<bool>() == true || state["updatePending"]?.GetValue<bool>() == true) throw new InvalidOperationException("Finish active jobs, terminals, remote desktops and file transfers before changing the installation.");
    }
    private static void MarkMaintenance(string root)
    {
        using var process = Process.GetCurrentProcess();
        LocalStore.SaveProtected(Path.Combine(root, Maintenance), new JsonObject { ["pid"] = process.Id, ["startedTicks"] = process.StartTime.ToUniversalTime().Ticks });
    }
    private static async Task<JsonObject?> ReadInputAsync(string[] args)
    {
        int option = Array.IndexOf(args, "--config");
        if (option >= 0)
        {
            if (option + 1 >= args.Length) throw new InvalidDataException("--config requires a registration JSON file.");
            var file = new FileInfo(args[option + 1]); if (file.Length is < 1 or > 32768) throw new InvalidDataException("Registration JSON must be at most 32 KiB.");
            return JsonNode.Parse(await File.ReadAllTextAsync(file.FullName))?.AsObject() ?? throw new InvalidDataException("Invalid registration JSON.");
        }
        if (!Console.IsInputRedirected) return null;
        var text = new StringBuilder(); char[] buffer = new char[1024];
        while (true) { int count = await Console.In.ReadAsync(buffer); if (count == 0) break; text.Append(buffer, 0, count); if (text.Length > 32768) throw new InvalidDataException("Registration JSON must be at most 32 KiB."); }
        return text.Length == 0 ? null : JsonNode.Parse(text.ToString())?.AsObject() ?? throw new InvalidDataException("Invalid registration JSON.");
    }
    internal static async Task<int> InstallAsync(string root, string[] args)
    {
        RequireAdministrator(); RequireSupportedWindows(); AssertNoReparse(root); SecureDirectory(root, false);
        using var lease = AgentUpdateLease.Acquire(root); string work = Path.Combine(root, "install-" + Guid.NewGuid().ToString("N")), configPath = Path.Combine(root, "config.bin");
        try
        {
            if (AgentUpdater.Pending(root)) throw new InvalidOperationException("An agent update is pending. Allow recovery to finish first.");
            bool hadService = NativeServiceSetup.Exists(), wasRunning = NativeServiceSetup.Running();
            byte[]? oldProtected = null;
            if (File.Exists(configPath))
            {
                if ((File.GetAttributes(configPath) & FileAttributes.ReparsePoint) != 0 || new FileInfo(configPath).Length > 32768) throw new UnauthorizedAccessException("Unsafe stored registration file.");
                using var locked = File.OpenHandle(configPath, FileMode.Open, FileAccess.Read, FileShare.Read); PathPolicy.NoHardLinks(locked);
                oldProtected = File.ReadAllBytes(configPath);
            }
            JsonObject? old = oldProtected is null ? null : ValidateConfiguration(LocalStore.ReadProtected(configPath));
            JsonObject? input = await ReadInputAsync(args); if (input is not null) input = ValidateConfiguration(input);
            if (old is not null && (!hadService || !File.Exists(Path.Combine(root, "current", "ServerDesk.Agent.exe")))) throw new InvalidOperationException("The stored registration has no installed service. Use a new portal registration or restore the existing installation first.");
            if (old is not null && input is not null && (old["id"]!.GetValue<string>() != input["id"]!.GetValue<string>() || old["origin"]!.GetValue<string>() != input["origin"]!.GetValue<string>())) throw new InvalidOperationException("This device is already registered to a different identity or portal.");
            var config = old ?? input ?? throw new InvalidOperationException("Download a registration JSON in the portal, then run ServerDesk.Agent.exe --install --config registration.json. Existing installations need no registration file.");
            if (old is not null && input?["jobSigningKey"] is JsonNode signingKey) config["jobSigningKey"] = signingKey.DeepClone();
            if (config["jobSigningKey"] is null) throw new InvalidOperationException("The registration has no portal job-signing key. Configure AGENT_JOB_SIGNING_KEY on the portal, then download a new registration JSON.");
            int modeOption = Array.IndexOf(args, "--mode"); if (modeOption >= 0) { if (modeOption + 1 >= args.Length || args[modeOption + 1] is not ("ReadOnly" or "Management")) throw new InvalidDataException("--mode requires ReadOnly or Management."); config["mode"] = args[modeOption + 1]; }
            Directory.CreateDirectory(work); SecureDirectory(work);
            using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(10));
            string stage = await DownloadVerifiedBinaryAsync(root, work, config, deadline.Token);
            MarkMaintenance(root); AssertIdle(root);
            string current = Path.Combine(root, "current"), previous = Path.Combine(root, "install-previous"), executable = Path.Combine(current, "ServerDesk.Agent.exe");
            string self = Path.GetFullPath(Environment.ProcessPath!);
            if (self.StartsWith(Path.GetFullPath(current).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Run installation from the downloaded EXE outside the current agent directory. Use --set-mode for an installed mode change.");
            bool moved = false, installed = false, serviceChanged = false;
            try
            {
                if (hadService) await AgentUpdater.StopServicesAsync();
                SecureDirectory(root);
                if (Directory.Exists(previous)) Directory.Delete(previous, true);
                if (Directory.Exists(current)) { Directory.Move(current, previous); moved = true; }
                Directory.Move(stage, current); installed = true;
                if (config["privateKey"] is null) { using var rsa = RSA.Create(2048); config["privateKey"] = rsa.ToXmlString(true); }
                LocalStore.SaveProtected(configPath, config); Directory.CreateDirectory(Path.Combine(root, "runtime")); SecureDirectory(root);
                // The first broker start after --install applies the policy silently and writes a new integrity baseline.
                File.Delete(Path.Combine(root, IntegrityBaseline.FileName));
                WorkerAccess.CreateData(root, recreate: true); WorkerAccess.WriteConfiguration(root, config); WorkerAccess.GrantPackage(root);
                NativeServiceSetup.Configure(executable); serviceChanged = true;
                DateTimeOffset started = DateTimeOffset.UtcNow; AgentUpdater.StartServices();
                if (!await AgentUpdater.HealthAsync(root, Program.Version, started, 180)) throw new InvalidOperationException("The new services did not report a successful portal heartbeat within three minutes. Inspect connectivity, the registration and " + Path.Combine(BrokerProtocol.WorkerRoot(root), "agent-worker.log") + ".");
                Console.WriteLine("ServerDesk " + Program.Version + " installed: SYSTEM broker service plus unprivileged worker service (NT SERVICE\\" + BrokerProtocol.WorkerService + "). Mode: " + config["mode"] + ". Device identity retained. Delete the downloaded registration JSON after use.");
                return 0;
            }
            catch
            {
                try { if (serviceChanged || hadService) await AgentUpdater.StopServicesAsync(); } catch { }
                if (installed && Directory.Exists(current)) Directory.Delete(current, true);
                if (moved) Directory.Move(previous, current);
                if (oldProtected is not null) LocalStore.Atomic(configPath, oldProtected); else File.Delete(configPath);
                if (hadService) { NativeServiceSetup.Configure(executable); try { WorkerAccess.Repair(root); if (File.Exists(configPath)) WorkerAccess.WriteConfiguration(root, LocalStore.ReadProtected(configPath)); } catch { } if (wasRunning) AgentUpdater.StartServices(); }
                else if (NativeServiceSetup.Exists()) NativeServiceSetup.Delete();
                throw;
            }
        }
        finally
        {
            try { File.Delete(Path.Combine(root, Maintenance)); } catch (DirectoryNotFoundException) { }
            try { if (Directory.Exists(work)) Directory.Delete(work, true); } catch { }
        }
    }
    private static async Task<string> DownloadVerifiedBinaryAsync(string root, string work, JsonObject config, CancellationToken token)
    {
        // In memory only: the installer never writes the worker's token state.
        using var http = DeviceTokenClient.CreateHttp(config, TimeSpan.FromMinutes(5), stateDirectory: null);
        string origin = config["origin"]!.GetValue<string>();
        // From 4.12.0 the installer asks for the path form; it accepts either form in the answer.
        using var response = await http.GetAsync(origin + "/Agent-v3-release.json?form=path", HttpCompletionOption.ResponseHeadersRead, token); response.EnsureSuccessStatusCode();
        await using var manifestStream = await response.Content.ReadAsStreamAsync(token); using var manifestBuffer = new MemoryStream(); byte[] buffer = new byte[65536];
        while (true) { int count = await manifestStream.ReadAsync(buffer, token); if (count == 0) break; if (manifestBuffer.Length + count > 32768) throw new InvalidDataException("Release envelope exceeds 32 KiB."); manifestBuffer.Write(buffer, 0, count); }
        var envelope = JsonNode.Parse(manifestBuffer.ToArray())!.AsObject();
        var release = AgentUpdater.VerifyManifest(envelope["manifest"]!.GetValue<string>(), envelope["signature"]!.GetValue<string>(), origin);
        if (release["version"]!.GetValue<string>() != Program.Version) throw new InvalidOperationException("This installer is not the current signed release. Download the current EXE in the portal.");
        if (release["exe"] is JsonObject binary)
        {
            long expectedLength = binary["size"]!.GetValue<long>(); string expectedHash = binary["sha256"]!.GetValue<string>();
            string nativeStage = Path.Combine(work, "stage"); Directory.CreateDirectory(nativeStage);
            await using var own = new FileStream(Environment.ProcessPath!, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true);
            if (own.Length != expectedLength || Convert.ToHexString(await SHA256.HashDataAsync(own, token)).ToLowerInvariant() != expectedHash.ToLowerInvariant()) throw new CryptographicException("The running EXE differs from the locally pinned publisher's signed release.");
            own.Position = 0;
            await using var installed = new FileStream(Path.Combine(nativeStage, "ServerDesk.Agent.exe"), FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true);
            await own.CopyToAsync(installed, token); await installed.FlushAsync(token);
            return nativeStage;
        }
        string zip = Path.Combine(work, "release.zip"); long size = release["size"]!.GetValue<long>();
        var pieces = release["parts"] is JsonArray parts && parts.Count > 0 ? parts : new JsonArray(new JsonObject { ["url"] = release["url"]!.DeepClone(), ["size"] = size, ["sha256"] = release["sha256"]!.DeepClone() });
        await using (var output = new FileStream(zip, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
        {
            foreach (var piece in pieces)
            {
                long length = piece!["size"]!.GetValue<long>(); using var part = await http.GetAsync(piece["url"]!.GetValue<string>(), HttpCompletionOption.ResponseHeadersRead, token); part.EnsureSuccessStatusCode();
                if (part.Content.Headers.ContentLength is long declared && declared != length) throw new InvalidDataException("Release part size differs from its signed manifest.");
                await using var input = await part.Content.ReadAsStreamAsync(token); using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256); long total = 0;
                while (true) { int read = await input.ReadAsync(buffer, token); if (read == 0) break; total += read; if (total > length) throw new InvalidDataException("Release part exceeds its signed size."); hash.AppendData(buffer, 0, read); await output.WriteAsync(buffer.AsMemory(0, read), token); }
                if (total != length || Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant() != piece["sha256"]!.GetValue<string>().ToLowerInvariant()) throw new CryptographicException("Release part integrity verification failed.");
            }
            await output.FlushAsync(token);
        }
        await using (var stream = File.OpenRead(zip)) if (stream.Length != size || Convert.ToHexString(await SHA256.HashDataAsync(stream, token)).ToLowerInvariant() != release["sha256"]!.GetValue<string>().ToLowerInvariant()) throw new CryptographicException("Signed release artifact verification failed.");
        string stage = Path.Combine(work, "stage"); Directory.CreateDirectory(stage);
        using var archive = ZipFile.OpenRead(zip);
        if (archive.Entries.Count != 1 || archive.Entries[0].FullName != "ServerDesk.Agent.exe" || archive.Entries[0].Length is < 1 or > 300_000_000 || (archive.Entries[0].ExternalAttributes >> 16 & 0xF000) == 0xA000) throw new InvalidDataException("The native release must contain exactly one regular ServerDesk.Agent.exe.");
        string executable = Path.Combine(stage, "ServerDesk.Agent.exe"); archive.Entries[0].ExtractToFile(executable, false);
        await using var expectedExe = File.OpenRead(executable); await using var runningExe = File.OpenRead(Environment.ProcessPath!);
        byte[] expectedDigest = await SHA256.HashDataAsync(expectedExe, token), actualDigest = await SHA256.HashDataAsync(runningExe, token);
        if (runningExe.Length != expectedExe.Length || !CryptographicOperations.FixedTimeEquals(expectedDigest, actualDigest)) throw new CryptographicException("The running installer differs from the locally pinned publisher's signed EXE.");
        return stage;
    }
    internal static Task<int> SetModeAsync(string root, string mode)
    {
        RequireAdministrator(); if (mode is not ("ReadOnly" or "Management")) throw new InvalidDataException("Mode must be ReadOnly or Management.");
        AssertNoReparse(root); SecureDirectory(root, false); using var lease = AgentUpdateLease.Acquire(root);
        try { MarkMaintenance(root); AssertIdle(root); var config = ValidateConfiguration(LocalStore.ReadProtected(Path.Combine(root, "config.bin"))); config["mode"] = mode; LocalStore.SaveProtected(Path.Combine(root, "config.bin"), config); Console.WriteLine("Local agent mode changed to " + mode + "."); return Task.FromResult(0); }
        finally { try { File.Delete(Path.Combine(root, Maintenance)); } catch (DirectoryNotFoundException) { } }
    }
    /// <summary>The detached uninstaller must run from outside the agent root, so it can delete every file under it.</summary>
    internal static void AssertDetachedLocation(string exe, string root)
    {
        if (Path.GetFullPath(exe).StartsWith(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The detached uninstaller must run from outside the agent directory.");
    }
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)] private static extern bool MoveFileExW(string existing, string? replacement, int flags);
    private static void DeleteAtReboot(string path) { if (OperatingSystem.IsWindows()) MoveFileExW(path, null, 4); } // MOVEFILE_DELAY_UNTIL_REBOOT
    // The portal uninstall (agent-uninstall): the broker started this staged copy
    // after the portal revoked the device. Nobody reads its console, so the output
    // and any exception go to uninstall.log next to it. The copy and its folder are
    // deleted at the next reboot; after a failure the log stays.
    internal static async Task<int> UninstallDetachedAsync(string root, string jobId)
    {
        if (!Guid.TryParseExact(jobId, "D", out _)) throw new InvalidDataException("Invalid uninstall job ID.");
        string exe = Path.GetFullPath(Environment.ProcessPath!), folder = Path.GetDirectoryName(exe)!, log = Path.Combine(folder, "uninstall.log");
        int code = 1;
        using (var writer = new StreamWriter(log, append: true) { AutoFlush = true })
        {
            TextWriter output = Console.Out, error = Console.Error;
            Console.SetOut(writer); Console.SetError(writer);
            try
            {
                writer.WriteLine(DateTimeOffset.UtcNow.ToString("O") + " Portal uninstall of job " + jobId + " started.");
                AssertDetachedLocation(exe, root);
                code = await UninstallAsync(root, detached: true);
            }
            catch (Exception e) { writer.WriteLine(e.ToString()); }
            finally { writer.WriteLine(DateTimeOffset.UtcNow.ToString("O") + " Exit code " + code + "."); Console.SetOut(output); Console.SetError(error); }
        }
        DeleteAtReboot(exe); DeleteAtReboot(Path.Combine(folder, PortalUninstall.LaunchedMarker));
        if (code == 0) { DeleteAtReboot(log); DeleteAtReboot(folder); }
        return code;
    }
    internal static async Task<int> UninstallAsync(string root, bool detached = false)
    {
        RequireAdministrator(); AssertNoReparse(root); if (!Directory.Exists(root)) { Console.WriteLine("No ServerDesk installation found."); return 0; }
        SecureDirectory(root, false); using var lease = AgentUpdateLease.Acquire(root);
        try
        {
            MarkMaintenance(root); AssertIdle(root);
            // A local uninstall tells the portal before anything is removed
            // (agent-removed, local-uninstall), whatever the answer. The portal
            // uninstall (detached) posts nothing: the portal started it.
            // The maintenance marker keeps the worker's own stop event silent.
            if (!detached) await WorkerIntegrity.ReportLocalUninstallAsync(root, Console.WriteLine);
            if (WindowsService.Exists(BrokerProtocol.WorkerService)) await WindowsService.StopAsync(BrokerProtocol.WorkerService);
            if (NativeServiceSetup.Exists()) await WindowsService.StopAsync(BrokerProtocol.BrokerService);
            NativeServiceSetup.Delete();
            await UpdateGuardian.RemoveAsync();
            // The plugins go with the folders below; their firewall rules go here.
            try { PluginHost.RemoveAllFirewallRules(); } catch (Exception e) { Console.WriteLine("The plugin firewall rules could not be removed: " + e.Message + ". Remove the rules \"" + WindowsPluginFirewall.Prefix + "*\" by hand."); }
            SecureDirectory(root);
            File.Delete(Path.Combine(root, "config.bin")); File.Delete(BrokerProtocol.WorkerConfigPath(root)); File.Delete(Path.Combine(root, Maintenance));
            if (Directory.Exists(BrokerProtocol.WorkerRoot(root))) Directory.Delete(BrokerProtocol.WorkerRoot(root), true);
            if (!detached && Path.GetFullPath(Environment.ProcessPath!).StartsWith(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Service and credentials removed. To delete all files, run the downloaded EXE --uninstall from outside the agent directory.");
            foreach (string folder in Directory.GetDirectories(root)) Directory.Delete(folder, true);
            foreach (string file in Directory.GetFiles(root)) if (Path.GetFileName(file) != "update.lock") File.Delete(file);
            // Release the lease before deleting its file. Credentials and service
            // are already removed; cleanup of this empty directory is best-effort.
            lease.Dispose();
            try { File.Delete(Path.Combine(root, "update.lock")); Directory.Delete(root); } catch (IOException) { }
            Console.WriteLine("ServerDesk services, device credentials and local files removed. Revoke the device registration in the portal as well."); return 0;
        }
        finally { try { File.Delete(Path.Combine(root, Maintenance)); } catch (DirectoryNotFoundException) { } }
    }
}
