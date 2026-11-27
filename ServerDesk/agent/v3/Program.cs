using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class Program
{
    // The csproj <Version> (the base X.Y.Z). A dev build of the Agent release workflow
    // adds -dev.<sha7> (BuildVersion.DevSuffix, agent/BuildVersion.targets).
    internal const string BaseVersion = "4.22.0";
    internal const string Version = BaseVersion + BuildVersion.DevSuffix;
    internal static async Task<int> Main(string[] args)
    {
        if (args.Contains("--powershell-self-test")) return PowerShellRunner.RunSelfTests();
        if (args.Contains("--self-test")) return SelfTests.Run();
        if (args.Length == 1 && args[0] == "--broker-self-test") return BrokerSelfTests.Run();
        if (args.Contains("--installer-self-test")) { NativeInstallerTests.Run(); return 0; }
        if (args.Contains("--features-self-test")) return NativeFeaturesAbiTests.RunSelfTest();
        if (args.Length == 1 && args[0] == "--health-self-test") return NativeRebootStatusTests.RunSelfTest();
        if (args.Length == 1 && args[0] == "--jobs-self-test") return JobConcurrencyTests.RunSelfTest();
        if (args.Length == 1 && args[0] == "--gpu-self-test") return NativeGpuInventoryTests.RunSelfTest();
        if (args.Length == 1 && args[0] == "--gpu-details-self-test") return NativeGpuDetailsTests.RunSelfTest();
        if (args.Length == 1 && args[0] == "--hardware-self-test") return await NativeHardwareInventoryTests.RunSelfTestAsync();
        if (args.Length == 1 && args[0] == "--crash-self-test") return NativeCrashInventoryTests.RunSelfTest();
        if (args.Length == 1 && args[0] == "--software-self-test") return NativeSoftwareInventoryTests.RunSelfTest();
        if (args.Length == 1 && args[0] == "--bitlocker-self-test") return NativeBitLockerTests.RunSelfTest();
        if (args.Length == 1 && args[0] == "--drivers-self-test") return NativeDriverInventoryTests.RunSelfTest();
        if (args.Length == 1 && args[0] == "--reliability-self-test") return NativeReliabilityTests.RunSelfTest();
        if (args.Length == 1 && args[0] == "--disk-health-self-test") return NativeDiskHealthTests.RunSelfTest();
        if (args.Length == 1 && args[0] == "--certificates-self-test") return NativeCertificatesTests.RunSelfTest();
        if (args.Length == 1 && args[0] == "--autostart-self-test") return NativeAutostartTests.RunSelfTest();
        if (args.Length == 1 && args[0] == "--defender-self-test") return NativeDefenderTests.RunSelfTest();
        if (args.Length == 1 && args[0] == "--windows-license-self-test") return NativeWindowsLicenseTests.RunSelfTest();
        if (args.Length == 1 && args[0] == "--defender-control-self-test") return await NativeDefenderControlTests.RunSelfTestAsync();
        if (args.Length == 1 && args[0] == "--failure-paths-self-test") return await AgentFailurePathTests.RunSelfTestAsync();
        if (args.Length == 1 && args[0] == "--gpu-driver-self-test") return await GpuDriverUpdateTests.RunSelfTestAsync();
        if (args.Length == 1 && args[0] == "--plugin-self-test") return await PluginSelfTests.RunSelfTestAsync();
        if (args.Length == 1 && args[0] == "--integrity-self-test") return AgentIntegrityTests.RunSelfTest();
        // Installs, kills, stops and removes two test services; exit 2 without elevation (ServiceLifecycleTests.cs).
        if (args.Length == 1 && args[0] == "--service-lifecycle-self-test") return await ServiceLifecycleTests.RunSelfTestAsync();
        // The idle service of the lifecycle self-test: no configuration, no network, no change to the host.
        if (args.Length == 2 && args[0] == "--lifecycle-probe") return ServiceLifecycleTests.RunProbe(args[1]);
        if (args.Length == 1 && args[0] is "--hardware-inventory-sample" or "--hardware-probe") return NativeHardwareInventoryTests.Sample();
        if (args.Length == 1 && args[0] == "--gpu-telemetry-sample") return await NativeGpuInventoryTests.SampleAsync();
        // The five health signal reads of 4.11.0 on this host, for support (needs administrator rights for complete data).
        if (args.Length == 1 && args[0] == "--health-signals-probe")
        {
            var probe = new JsonObject();
            foreach (var (name, collect) in new (string, Func<JsonObject>)[] { ("drivers", new NativeDriverInventory().Collect), ("reliability", new NativeReliability().Collect), ("diskAndBattery", new NativeDiskHealth().Collect), ("certificates", new NativeCertificates().Collect), ("autostart", new NativeAutostartInventory().Collect) })
            {
                try { probe[name] = collect(); } catch (Exception e) { probe[name] = new JsonObject { ["error"] = NativeInventoryDiagnostics.Describe(e) }; }
            }
            Console.WriteLine(probe.ToJsonString()); return 0;
        }
        // Two driver reads on this host with their timing lines, for support (run it as administrator or SYSTEM for the broker's view).
        if (args.Length == 1 && args[0] == "--drivers-probe")
        {
            var inventory = new NativeDriverInventory();
            for (int run = 0; run < 2; run++) { inventory.Collect(); Console.WriteLine(NativeDriverInventory.TimingLine(inventory.LastRun!)); }
            return 0;
        }
        if (args.Length == 1 && args[0] == "--native-health-probe")
        {
            try
            {
                JsonObject health = NativeRebootStatus.Read().ToJson();
                health["powerSchedule"] = NativePowerSchedule.Collect()["powerSchedule"]?.DeepClone();
                Console.WriteLine(health.ToJsonString()); return 0;
            }
            catch (Exception e) { Console.Error.WriteLine(NativeInventoryDiagnostics.Describe(e)); return 1; }
        }
        if (args.Length == 1 && args[0] == "--native-features-probe") return await NativeFeaturesAbiTests.ProbeAsync();
        if (args.Contains("--version")) { Console.WriteLine(Version); return 0; }
        if (args.Contains("--third-party-notices")) { using var notices = typeof(Program).Assembly.GetManifestResourceStream("ServerDesk.Agent.THIRD-PARTY-NOTICES.txt") ?? throw new InvalidOperationException("Third-party notices are missing."); using var reader = new StreamReader(notices); Console.Write(reader.ReadToEnd()); return 0; }
        if (args.Length >= 3 && args[0] == "--verify-release")
        {
            try { var envelope = JsonNode.Parse(await File.ReadAllTextAsync(args[1]))!; var release = AgentUpdater.VerifyManifest(envelope["manifest"]!.GetValue<string>(), envelope["signature"]!.GetValue<string>(), args[2]); if (args.Length > 3) { await using var zip = File.OpenRead(args[3]); string hash = Convert.ToHexString(await System.Security.Cryptography.SHA256.HashDataAsync(zip)).ToLowerInvariant(); if (hash != release["sha256"]!.GetValue<string>() || zip.Length != release["size"]!.GetValue<long>()) throw new InvalidDataException("Signed full artifact hash or size mismatch"); } Console.WriteLine("Pinned publisher signature, release fields, parts, and supplied artifact verified."); return 0; } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
        }
        if (!OperatingSystem.IsWindows() || System.Runtime.InteropServices.RuntimeInformation.OSArchitecture != System.Runtime.InteropServices.Architecture.X64) { Console.Error.WriteLine("ServerDesk requires x64 Windows Server 2022/2025 or Windows 11 Pro/Enterprise."); return 1; }
        string root = Environment.GetEnvironmentVariable("SERVERDESK_DATA") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ServerDesk");
        try
        {
            if (args.Contains("--install")) return await AgentInstaller.InstallAsync(root, args);
            if (args.Length == 2 && args[0] == "--set-mode") return await AgentInstaller.SetModeAsync(root, args[1]);
            // The portal uninstall starts the staged copy outside the agent root with --uninstall --detached <jobId>.
            if (args.Length == 3 && args[0] == "--uninstall" && args[1] == "--detached") return await AgentInstaller.UninstallDetachedAsync(root, args[2]);
            if (args.Contains("--uninstall")) return await AgentInstaller.UninstallAsync(root);
            if (args.Length > 1 && args[0] == "--update") return await AgentUpdater.ApplyAsync(root, args[1]);
            // The unprivileged worker service: a virtual account, never SYSTEM.
            if (args.Length == 1 && args[0] == "--worker")
            {
                LocalStore.RedirectLog(BrokerProtocol.WorkerRoot(root));
                ProcessLifetime.AttachService(allowUpdaterBreakaway: false);
                return ServiceHost.Run(BrokerProtocol.WorkerService, (ServiceStop stop) => new AgentWorker(root).RunAsync(stop), e => LocalStore.Log(root, "Worker failed: " + e.GetType().Name + ": " + e.Message), repairPolicy: false);
            }
            if (System.Security.Principal.WindowsIdentity.GetCurrent().User?.Value != "S-1-5-18") throw new InvalidOperationException("The broker and its terminal must run as SYSTEM. Install the Windows services using this EXE with --install.");
            ProcessLifetime.AttachService(allowUpdaterBreakaway: !args.Contains("--script-host") && !args.Contains("--terminal-host"));
            if (args.Length == 1 && args[0] == "--script-host") return await PowerShellRunner.RunScriptHostAsync();
            if (args.Length == 1 && args[0] == "--terminal-host") return PowerShellRunner.RunTerminalHost();
            // The integrity start (AgentIntegrity.cs) checks the protection before it
            // repairs it with ApplySecurityPolicy, so ServiceHost does not repair first.
            if (args.Length == 1 && args[0] == "--broker") return ServiceHost.Run(BrokerProtocol.BrokerService, (ServiceStop stop) => { var integrity = new BrokerIntegrity(root, message => LocalStore.Log(root, message)); integrity.Start(); return new AgentBroker(root, integrity).RunAsync(stop); }, e => LocalStore.Log(root, "Broker failed: " + e.GetType().Name + ": " + e.Message), repairPolicy: false);
            throw new InvalidOperationException("Run with --install. The services start this EXE with --broker or --worker.");
        }
        catch (Exception e) { if (args.Any(argument => argument is "--install" or "--uninstall" or "--set-mode")) Console.Error.WriteLine(e.Message); LocalStore.Log(root, "Agent terminated: " + e.GetType().Name + ": " + e.Message); return 1; }
    }
}
