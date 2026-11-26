using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;

namespace ServerDesk.Agent;

// --service-lifecycle-self-test (4.18.0): the real NativeServiceSetup code with
// the test services ServerDeskSelfTest and ServerDeskSelfTestWorker and a
// temporary root under %ProgramData%. Both services run the idle probe
// (--lifecycle-probe <name>) without configuration. Install and verify; start;
// kill the probe broker and wait for its failure action; stop both and check
// that they stay stopped; uninstall; reinstall and verify; uninstall. Cleanup
// runs in finally. Without elevation the test exits with code 2.
internal static class ServiceLifecycleTests
{
    internal static readonly AgentServiceNames Names = new("ServerDeskSelfTest", "ServerDeskSelfTestWorker");
    internal const int Skipped = 2;

    /// <summary>The idle service: waits for STOP or SHUTDOWN. Only the two test names are accepted.</summary>
    internal static int RunProbe(string name)
    {
        if (name != Names.Broker && name != Names.Worker) { Console.Error.WriteLine("Unknown lifecycle probe service."); return 1; }
        return ServiceHost.Run(name, (ServiceStop stop) => Task.Delay(Timeout.Infinite, stop.Token), repairPolicy: false);
    }

    internal static async Task<int> RunSelfTestAsync()
    {
        if (!OperatingSystem.IsWindows()) { Console.WriteLine("skipped: needs elevation (Windows)"); return Skipped; }
        using (var identity = WindowsIdentity.GetCurrent()) if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) { Console.WriteLine("skipped: needs elevation"); return Skipped; }
        string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ServerDeskSelfTest-" + Guid.NewGuid().ToString("N"));
        try
        {
            // A leftover of an interrupted earlier run is removed first.
            await RemoveAsync(root);
            for (int round = 1; round <= 2; round++)
            {
                Install(root);
                Verify(root, round);
                if (round == 1)
                {
                    WindowsService.Start(Names.Broker); WindowsService.Start(Names.Worker);
                    int broker = await WaitRunningAsync(Names.Broker, 0, TimeSpan.FromSeconds(30));
                    await WaitRunningAsync(Names.Worker, 0, TimeSpan.FromSeconds(30));
                    Console.WriteLine("Lifecycle: both test services run.");
                    using (var process = Process.GetProcessById(broker)) process.Kill();
                    int restarted = await WaitRunningAsync(Names.Broker, broker, TimeSpan.FromSeconds(20));
                    Console.WriteLine("Lifecycle: the killed broker probe was restarted by its failure action (PID " + broker + " -> " + restarted + ").");
                    await WindowsService.StopAsync(Names.Worker); await WindowsService.StopAsync(Names.Broker);
                    await Task.Delay(TimeSpan.FromSeconds(15));
                    foreach (string name in new[] { Names.Worker, Names.Broker }) if (WindowsService.Query(name).State != WorkerWatchdog.ServiceStopped) throw new Exception(name + " did not stay stopped for 15 s after a clean stop.");
                    Console.WriteLine("Lifecycle: both test services stayed stopped for 15 s.");
                }
                await RemoveAsync(root);
                foreach (string name in new[] { Names.Broker, Names.Worker }) if (NativeServiceSetup.Exists(name)) throw new Exception(name + " still exists after the uninstall.");
                if (Directory.Exists(root)) throw new Exception("The test root still exists after the uninstall.");
                Console.WriteLine("Lifecycle round " + round + ": uninstalled, services and root gone.");
            }
            Console.WriteLine("Service lifecycle self-test passed: install, failure actions, delayed start, DACL, SID, folder ACLs, kill and restart, clean stop, uninstall and reinstall.");
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine("Service lifecycle self-test failed: " + e.Message); return 1; }
        finally
        {
            try { await RemoveAsync(root); }
            catch (Exception e) { Console.Error.WriteLine("Lifecycle cleanup: " + e.Message + ". Remove the services " + Names.Broker + " and " + Names.Worker + " and the folder " + root + " by hand."); }
        }
    }

    // The installer's folder layout and ACLs, the EXE copy in current, then the services.
    private static void Install(string root)
    {
        AgentInstaller.SecureDirectory(root, recursive: false);
        string current = Path.Combine(root, "current"); Directory.CreateDirectory(current); Directory.CreateDirectory(Path.Combine(root, "runtime"));
        PluginAcl.Protect(PluginFiles.Root(root)); Directory.CreateDirectory(Path.Combine(root, "updates"));
        string process = Environment.ProcessPath!, probe = Path.Combine(current, "ServerDesk.Agent.exe");
        bool managed = Path.GetFileNameWithoutExtension(process).Equals("dotnet", StringComparison.OrdinalIgnoreCase);
        // The packaged single-file EXE is copied like an installation; a build
        // output with its assembly beside it (managed smoke mode, development
        // build) runs in place.
        string assembly = Path.Combine(AppContext.BaseDirectory, "ServerDesk.Agent.dll");
        bool inPlace = managed || File.Exists(assembly);
        if (!inPlace) File.Copy(process, probe, true);
        AgentInstaller.SecureDirectory(root);
        var worker = new SecurityIdentifier(Names.WorkerSid);
        new DirectoryInfo(BrokerProtocol.WorkerRoot(root)).Create(WorkerAccess.DataSecurity(worker));
        // The worker probe reads and runs the EXE copy, as the installed worker does (WorkerAccess.GrantPackage).
        var folder = new DirectoryInfo(current); var acl = folder.GetAccessControl();
        acl.AddAccessRule(new FileSystemAccessRule(worker, FileSystemRights.ReadAndExecute, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow)); folder.SetAccessControl(acl);
        foreach (var file in folder.EnumerateFiles()) { var fileAcl = file.GetAccessControl(); fileAcl.AddAccessRule(new FileSystemAccessRule(worker, FileSystemRights.ReadAndExecute, AccessControlType.Allow)); file.SetAccessControl(fileAcl); }
        string command = managed ? "\"" + process + "\" \"" + assembly + "\"" : "\"" + (inPlace ? process : probe) + "\"";
        NativeServiceSetup.Configure(Names, command + " --lifecycle-probe " + Names.Broker, command + " --lifecycle-probe " + Names.Worker, root);
    }

    // The same reads as the broker's integrity check.
    private static void Verify(string root, int round)
    {
        foreach (string name in new[] { Names.Broker, Names.Worker })
        {
            var inspection = NativeServiceSetup.Inspect(name, worker: name == Names.Worker);
            if (!inspection.Exists) throw new Exception(name + " was not installed.");
            if (inspection.StartType != "delayed-auto") throw new Exception(name + " has the start type " + inspection.StartType + ", not delayed-auto.");
            if (inspection.Dacl is not null || inspection.Sid is not null || inspection.Recovery is not null) throw new Exception(name + " differs from the installer policy: " + string.Join(", ", new[] { inspection.Dacl, inspection.Sid, inspection.Recovery }.Where(item => item is not null)));
        }
        var folders = BrokerIntegrity.FolderFindings(root);
        if (folders.Count > 0) throw new Exception("Folder ACLs differ: " + string.Join(", ", folders.Select(item => item.Target + " " + item.Finding)));
        Console.WriteLine("Lifecycle round " + round + ": installed; DACL, SID, failure actions 5/30/60 s, delayed-auto and folder ACLs verified.");
    }

    // A process ID of the running service other than `previous`, within `limit`.
    private static async Task<int> WaitRunningAsync(string name, int previous, TimeSpan limit)
    {
        var watch = Stopwatch.StartNew();
        while (watch.Elapsed < limit)
        {
            var (exists, state, pid) = WindowsService.Query(name);
            if (exists && state == WorkerWatchdog.ServiceRunning && pid > 0 && pid != previous) return pid;
            await Task.Delay(500);
        }
        throw new Exception(name + " did not run within " + (int)limit.TotalSeconds + " s.");
    }

    // Stops and deletes both services, waits until the SCM removed them, and deletes the root.
    private static async Task RemoveAsync(string root)
    {
        foreach (string name in new[] { Names.Worker, Names.Broker })
        {
            if (!NativeServiceSetup.Exists(name)) continue;
            try { await WindowsService.StopAsync(name); }
            catch (Exception) { var (_, _, pid) = WindowsService.Query(name); if (pid > 0) try { using var process = Process.GetProcessById(pid); process.Kill(); } catch (ArgumentException) { } }
        }
        NativeServiceSetup.Delete(Names);
        var watch = Stopwatch.StartNew();
        while ((NativeServiceSetup.Exists(Names.Broker) || NativeServiceSetup.Exists(Names.Worker)) && watch.Elapsed < TimeSpan.FromSeconds(20)) await Task.Delay(500);
        for (int attempt = 0; Directory.Exists(root); attempt++)
        {
            try { Directory.Delete(root, true); }
            catch (Exception) when (attempt < 20) { await Task.Delay(500); }
        }
    }
}
