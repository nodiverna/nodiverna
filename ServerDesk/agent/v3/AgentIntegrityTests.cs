using System.Security.AccessControl;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// --integrity-self-test (4.18.0): the pure parts of the tamper protection
// (AgentIntegrity.cs, NativeServiceSetup.cs) without a service or elevation:
// the failure-action comparison, the DACL and folder finding mapping, the
// baseline and run-marker rules, the event store bounds and its ack, the
// watchdog decisions, the planned contexts and the worker's stop event.
internal static class AgentIntegrityTests
{
    internal static int RunSelfTest()
    {
        int checks = 0;
        void Check(bool condition, string label) { if (!condition) throw new Exception("Integrity self-test failed: " + label); checks++; }
        try
        {
            // ---- Failure actions: 5000/30000/60000 ms, reset 86400 s, flag true ----
            (int, uint)[] good = [(1, 5000), (1, 30000), (1, 60000)];
            Check(NativeServiceSetup.RecoveryDifference(86400, good, true) is null, "the shared set matches");
            Check(NativeServiceSetup.RecoveryDifference(86400, [(1, 60000), (1, 60000), (1, 60000)], true) == "delay 0 60000", "the 4.17.0 set (60 s x3) differs in the first delay");
            Check(NativeServiceSetup.RecoveryDifference(86400, good[..2], true) == "count 2", "a missing action");
            Check(NativeServiceSetup.RecoveryDifference(86400, [], true) == "count 0", "no action");
            Check(NativeServiceSetup.RecoveryDifference(86400, [(1, 5000), (0, 30000), (1, 60000)], true) == "type 1 0", "a none action");
            Check(NativeServiceSetup.RecoveryDifference(0, good, true) == "reset 0", "the reset period");
            Check(NativeServiceSetup.RecoveryDifference(86400, good, false) == "flag false", "the non-crash flag");
            Check(NativeServiceSetup.RecoveryDelaysMs.SequenceEqual(new uint[] { 5000, 30000, 60000 }) && NativeServiceSetup.RecoveryResetSeconds == 86400 && NativeServiceSetup.RecoveryOnNonCrashFailures, "the constant set");
            // ---- Service DACL findings ----
            if (OperatingSystem.IsWindows())
            {
                string Finding(string sddl) => NativeServiceSetup.DescriptorFinding(new RawSecurityDescriptor(sddl)) ?? "";
                Check(NativeServiceSetup.DescriptorFinding(new RawSecurityDescriptor(NativeServiceSetup.SecurityDescriptor)) is null, "the installer DACL has no finding");
                Check(Finding(NativeServiceSetup.SecurityDescriptor.Replace("O:BA", "O:AU", StringComparison.Ordinal)) == "owner S-1-5-11", "a foreign owner");
                Check(Finding(NativeServiceSetup.SecurityDescriptor.Replace("0x2008D", "0xF01FF", StringComparison.Ordinal)) == "access S-1-5-11 0xF01FF", "a widened ACE");
                Check(Finding(NativeServiceSetup.SecurityDescriptor + "(A;;0x10;;;WD)") == "ace-count 4", "an extra ACE");
                Check(Finding("O:BAD:P(A;;0xF01FF;;;SY)(A;;0xF01FF;;;BA)(A;;0x2008D;;;WD)") == "ace S-1-1-0", "a foreign ACE");
                Check(Finding("O:BAD:P(A;;0xF01FF;;;SY)(D;;0xF01FF;;;BA)(A;;0x2008D;;;AU)") == "ace-type S-1-5-32-544", "a deny ACE");
                Check(NativeServiceSetup.StartTypeName(2, true) == "delayed-auto" && NativeServiceSetup.StartTypeName(2, false) == "auto" && NativeServiceSetup.StartTypeName(3, false) == "manual" && NativeServiceSetup.StartTypeName(4, false) == "disabled" && NativeServiceSetup.StartTypeName(0, false) == "unknown", "the start type names");
            }
            // ---- Folder findings: the PluginAcl rules with a protected DACL ----
            PluginAcl.Ace Ace(string sid, int rights) => new(sid, rights, true);
            var safe = new[] { Ace(PluginAcl.SystemSid, 0x1F01FF), Ace(PluginAcl.AdministratorsSid, 0x1F01FF) };
            Check(BrokerIntegrity.FolderFinding("current", PluginAcl.UnsafeReason(PluginAcl.AdministratorsSid, safe, true, true)) is null, "a safe folder");
            Check(BrokerIntegrity.FolderFinding("current", PluginAcl.UnsafeReason(PluginAcl.AdministratorsSid, safe.Append(Ace(BrokerProtocol.WorkerSid, 0x1200A9)), true, true)) is null, "the worker's read grant on current");
            Check(BrokerIntegrity.FolderFinding("current", PluginAcl.UnsafeReason(PluginAcl.AdministratorsSid, safe, false, true)) == "current inherited", "an inherited DACL");
            Check(BrokerIntegrity.FolderFinding("ServerDesk", PluginAcl.UnsafeReason("S-1-5-11", safe, true, true)) == "ServerDesk owner", "a foreign owner");
            Check(BrokerIntegrity.FolderFinding("ServerDesk", PluginAcl.UnsafeReason(PluginAcl.AdministratorsSid, safe.Append(Ace("S-1-5-32-545", 0x1301BF)), true, true)) == "ServerDesk ace S-1-5-32-545", "Users with Modify (icacls /grant Users:M)");
            var folders = BrokerIntegrity.Folders(@"C:\ProgramData\ServerDesk");
            Check(folders.Select(item => item.Target).SequenceEqual(new[] { "folder-agent", "folder-agent", "folder-plugins", "folder-staging" }) && folders[0].Required && folders[1].Required && !folders[2].Required && !folders[3].Required && folders[2].Folder.EndsWith("plugins", StringComparison.Ordinal) && folders[3].Folder.EndsWith("updates", StringComparison.Ordinal), "the agent, plugin and staging folders");
            Check(IntegrityContract.Clean("a\u0001b" + new string('x', 200), 120) == "a b" + new string('x', 117), "a finding is cleaned and at most 120 characters");
            // ---- Baseline: a finding at start is reported only with a baseline of this version and policy ----
            string hash = IntegrityBaseline.PolicyHash;
            Check(hash.Length == 64, "the policy hash");
            Check(!IntegrityBaseline.Reports(null, "4.18.0", hash), "no baseline: the first start repairs silently");
            Check(!IntegrityBaseline.Reports(new JsonObject { ["version"] = "4.17.0", ["policyHash"] = hash }, "4.18.0", hash), "a baseline of the previous version: an update repairs silently");
            Check(!IntegrityBaseline.Reports(new JsonObject { ["version"] = "4.18.0", ["policyHash"] = "x" }, "4.18.0", hash), "another policy");
            Check(IntegrityBaseline.Reports(new JsonObject { ["version"] = "4.18.0", ["policyHash"] = hash }, "4.18.0", hash), "a baseline of this version reports");
            // ---- Run marker: same boot session gives service-ended, an earlier boot nothing ----
            var boot = DateTimeOffset.Parse("2026-11-09T08:00:00Z");
            JsonObject Marker(DateTimeOffset at) => new() { ["pid"] = 1, ["bootTime"] = at.ToString("O") };
            Check(RunMarker.Ended(Marker(boot.AddSeconds(30)), boot, planned: false), "a marker of this boot session");
            Check(!RunMarker.Ended(Marker(boot.AddHours(-3)), boot, planned: false), "a marker of an earlier boot (reboot, power loss)");
            Check(!RunMarker.Ended(Marker(boot), boot, planned: true), "a planned start");
            Check(!RunMarker.Ended(null, boot, planned: false), "no marker: the last stop was clean");
            Check(RunMarker.BootTime(boot.AddMinutes(10), 600_000) == boot, "the boot time");
            // ---- Event store: at most 50, oldest dropped, 20 pending, ack, kept across restarts ----
            string path = Path.Combine(Path.GetTempPath(), "serverdesk-integrity-" + Guid.NewGuid().ToString("N") + ".json");
            try
            {
                var store = new IntegrityEventStore(path);
                var ids = new List<string>();
                for (int i = 0; i < 55; i++) { var item = IntegrityContract.Event("service-ended", boot.AddSeconds(i), service: "worker"); ids.Add(item["id"]!.GetValue<string>()); store.Add(item); }
                Check(store.Count == 50, "at most 50 events");
                var pending = store.Pending();
                Check(pending.Count == 20 && pending[0]!["id"]!.GetValue<string>() == ids[5], "20 pending, the oldest 5 dropped");
                var reloaded = new IntegrityEventStore(path);
                Check(reloaded.Count == 50, "the events survive a restart");
                Check(reloaded.Acknowledge(pending.Select(item => item!["id"]!.GetValue<string>()).Append("unknown")) == 20 && reloaded.Count == 30, "integrity-ack deletes the accepted events");
                Check(new IntegrityEventStore(path).Count == 30, "the ack is saved");
                var recent = new IntegrityEventStore(path);
                recent.Add(IntegrityContract.Event("service-ended", boot.AddMinutes(10), service: "worker")); recent.Add(IntegrityContract.Event("service-ended", boot.AddMinutes(10), service: "broker"));
                recent.DropRecentWorkerEvents(boot.AddMinutes(10).AddSeconds(5), TimeSpan.FromSeconds(60));
                Check(recent.Count == 31, "a system shutdown drops the worker's last-minute events only");
            }
            finally { File.Delete(path); }
            // ---- Events: the contract fields ----
            var removed = IntegrityContract.Event("agent-removed", boot, reason: "local-uninstall", user: "CONTOSO\\admin");
            Check(Guid.TryParseExact(removed["id"]!.GetValue<string>(), "D", out _) && removed["at"]!.GetValue<string>() == "2026-11-09T08:00:00.000Z" && removed["user"]!.GetValue<string>() == "CONTOSO\\admin" && !removed.ContainsKey("service"), "an agent-removed event");
            Check(IntegrityContract.Event("start-type-changed", boot, service: "worker", startType: "auto")["startType"]!.GetValue<string>() == "unknown", "an event start type is manual, disabled or unknown");
            bool refused = false; try { IntegrityContract.Event("service-paused", boot); } catch (ArgumentException) { refused = true; }
            Check(refused, "an unknown kind is refused");
            // ---- Watchdog decisions ----
            TimeSpan minutes(double value) => TimeSpan.FromMinutes(value);
            Check(WorkerWatchdog.Decide(1, "delayed-auto", null, false, 1) == WatchdogAction.None, "stopped in one check: wait");
            Check(WorkerWatchdog.Decide(1, "delayed-auto", null, false, 2) == WatchdogAction.Start, "stopped in two checks, delayed-auto: start");
            Check(WorkerWatchdog.Decide(1, "auto", null, false, 3) == WatchdogAction.Start, "auto: start");
            Check(WorkerWatchdog.Decide(1, "manual", null, false, 5) == WatchdogAction.None && WorkerWatchdog.Decide(1, "disabled", null, false, 5) == WatchdogAction.None && WorkerWatchdog.Decide(1, "unknown", null, false, 5) == WatchdogAction.None, "manual, disabled or unknown: never start");
            Check(WorkerWatchdog.Decide(4, "delayed-auto", minutes(3), false, 0) == WatchdogAction.End, "no request for 3 minutes: end");
            Check(WorkerWatchdog.Decide(4, "delayed-auto", minutes(2.99), false, 0) == WatchdogAction.None, "a slow worker below 3 minutes stays");
            Check(WorkerWatchdog.Decide(4, "delayed-auto", null, false, 0) == WatchdogAction.None, "no request age: nothing");
            Check(WorkerWatchdog.Decide(1, "delayed-auto", null, true, 9) == WatchdogAction.None && WorkerWatchdog.Decide(4, "delayed-auto", minutes(30), true, 0) == WatchdogAction.None, "a planned context: nothing");
            Check(WorkerWatchdog.Decide(2, "delayed-auto", minutes(30), false, 0) == WatchdogAction.None, "a start pending: nothing");
            // ---- Planned contexts ----
            Check(!PlannedContext.Planned(false, false, false, false, false), "no planned context");
            Check(PlannedContext.Planned(true, false, false, false, false) && PlannedContext.Planned(false, true, false, false, false) && PlannedContext.Planned(false, false, true, false, false) && PlannedContext.Planned(false, false, false, true, false) && PlannedContext.Planned(false, false, false, false, true), "shutdown, maintenance, update plan, update job and portal uninstall are planned");
            // ---- The worker's last message and the broker outage ----
            Check(WorkerIntegrity.StopEvent(planned: true, deleted: true, boot) is null, "a planned stop posts nothing");
            var deletedEvent = WorkerIntegrity.StopEvent(planned: false, deleted: true, boot)!;
            Check(deletedEvent["kind"]!.GetValue<string>() == "agent-removed" && deletedEvent["reason"]!.GetValue<string>() == "service-deleted", "a service marked for deletion: agent-removed");
            var stoppedEvent = WorkerIntegrity.StopEvent(planned: false, deleted: false, boot)!;
            Check(stoppedEvent["kind"]!.GetValue<string>() == "service-stopped" && stoppedEvent["service"]!.GetValue<string>() == "worker", "otherwise service-stopped (worker)");
            Check(!WorkerIntegrity.BrokerUnresponsive(minutes(2.9), false) && WorkerIntegrity.BrokerUnresponsive(minutes(3), false) && !WorkerIntegrity.BrokerUnresponsive(minutes(10), true), "broker-unresponsive after 3 minutes, once per outage");
            Check(WorkerIntegrity.Accepted(new JsonObject { ["accepted"] = new JsonArray("a", 1, "b") }).SequenceEqual(new[] { "a", "b" }), "the accepted IDs");
            Check(IntegrityContract.Kinds.Length == 8 && IntegrityContract.Targets.Length == 6 && IntegrityContract.StopKinds.All(IntegrityContract.Kinds.Contains), "the contract lists");
            Console.WriteLine("Integrity self-test passed (" + checks + " checks): failure actions, DACL and folder findings, baseline, run marker, event store, watchdog, planned contexts and stop events.");
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }
}
