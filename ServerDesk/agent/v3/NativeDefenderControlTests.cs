using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// --defender-control-self-test: the Defender actions of 4.15.0 with a fake
// provider and short waits. The scan slot (start, still running after the wait,
// done within the wait, a second scan refused, release after 24 h, defenderScan
// only while busy, the refresh when the call ends), the clean outcomes 0/0, n/0
// and n/m, the signature version and the timeout code, and the unavailable cases.
internal static class NativeDefenderControlTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Defender control regression: " + message); }
    internal static async Task<int> RunSelfTestAsync() { try { await RunAsync(); Console.WriteLine("Defender control self-test passed."); return 0; } catch (Exception error) { Console.Error.WriteLine(error); return 1; } }

    private sealed class FakeProvider : IDefenderControlProvider
    {
        internal string? Mode = "Normal";
        internal Exception? ModeFailure;
        internal ManualResetEventSlim ScanGate = new(true);
        internal uint ScanCode, UpdateCode;
        internal ManualResetEventSlim UpdateGate = new(true);
        internal int Active, ActiveAfterRemove, Removes, Scans;
        internal byte LastScanType;
        internal string? Version = "1.421.2000.0";
        public string? RunningMode() => ModeFailure is null ? Mode : throw ModeFailure;
        public uint StartScan(byte scanType) { Interlocked.Increment(ref Scans); LastScanType = scanType; ScanGate.Wait(TimeSpan.FromSeconds(20)); return ScanCode; }
        public uint UpdateSignatures() { UpdateGate.Wait(TimeSpan.FromSeconds(20)); return UpdateCode; }
        public uint RemoveThreats() { Removes++; Active = ActiveAfterRemove; return 0; }
        public int ActiveThreats() => Active;
        public string? SignatureVersion() => Version;
    }

    private static readonly DefenderControlWaits Short = new(TimeSpan.FromMilliseconds(300), TimeSpan.FromMilliseconds(300), TimeSpan.FromMilliseconds(300));
    private static JsonObject Job(string action) => new() { ["id"] = Guid.NewGuid().ToString(), ["action"] = action, ["parameters"] = new JsonObject() };
    private static async Task<JsonObject> Run(NativeDefenderControl control, string action)
    {
        var job = Job(action);
        try { return await control.ExecuteAsync(job, CancellationToken.None); }
        catch (Exception error) { return AgentMessages.Fail(new JsonObject { ["id"] = job["id"]!.DeepClone(), ["ok"] = false }, error); }
    }
    private static bool Is(JsonObject result, bool ok, string code) => result["ok"]?.GetValue<bool>() == ok && result["code"]?.GetValue<string>() == code;
    private static string Arg(JsonObject result, string name) => result["args"]?[name]?.GetValue<string>() ?? "";
    private static async Task Until(Func<bool> condition, string message) { for (int i = 0; i < 100 && !condition(); i++) await Task.Delay(50); Check(condition(), message); }

    private static async Task RunAsync()
    {
        // ---- The scan slot: still running after the wait ----
        int refreshes = 0;
        var clock = DateTimeOffset.Parse("2026-11-04T12:00:00Z");
        var slot = new DefenderScanSlot(() => Interlocked.Increment(ref refreshes), () => clock);
        var provider = new FakeProvider { ScanGate = new ManualResetEventSlim(false) };
        var control = new NativeDefenderControl(slot, provider, Short);
        Check(slot.State() is null && !slot.Busy, "no defenderScan without a portal scan.");
        var started = await Run(control, "defender-quick-scan");
        Check(Is(started, true, "AGENT_DEFENDER_QUICK_SCAN_STARTED") && provider.LastScanType == 1, "a quick scan that still runs after the wait ends the job successfully (ScanType 1).");
        var state = slot.State();
        Check(state?["kind"]?.GetValue<string>() == "quick" && state["startedAt"]?.GetValue<string>() == "2026-11-04T12:00:00.0000000+00:00" && slot.Busy, "the slot is busy and defenderScan names the kind and the start.");
        var refused = await Run(control, "defender-full-scan");
        Check(Is(refused, false, "AGENT_DEFENDER_SCAN_RUNNING") && provider.Scans == 1, "a second scan while the slot is busy is refused and not started.");
        Check(refreshes == 0, "no refresh while the scan runs.");
        provider.ScanGate.Set();
        await Until(() => slot.State() is null && refreshes == 1, "when the call ends, the slot clears and requests a refresh.");

        // ---- Done within the wait ----
        provider.ScanGate = new ManualResetEventSlim(true);
        Check(Is(await Run(control, "defender-full-scan"), true, "AGENT_DEFENDER_SCAN_COMPLETED") && provider.LastScanType == 2, "a full scan that ends within the wait completes the job (ScanType 2).");
        await Until(() => slot.State() is null, "the slot is free again after a completed scan.");
        provider.ScanCode = 0x80508023;
        var failed = await Run(control, "defender-quick-scan");
        Check(Is(failed, false, "AGENT_DEFENDER_ACTION_FAILED") && Arg(failed, "detail") == "0x80508023", "a result code other than 0 fails the job with the code.");
        provider.ScanCode = 0;
        await Until(() => slot.State() is null, "a failed scan frees the slot.");

        // ---- Release after 24 hours ----
        provider.ScanGate = new ManualResetEventSlim(false);
        int before = refreshes;
        Check(Is(await Run(control, "defender-quick-scan"), true, "AGENT_DEFENDER_QUICK_SCAN_STARTED"), "a scan that never returns.");
        clock = clock.AddHours(23);
        Check(slot.Busy && Is(await Run(control, "defender-full-scan"), false, "AGENT_DEFENDER_SCAN_RUNNING"), "the slot stays busy for 23 hours.");
        clock = clock.AddHours(2);
        Check(slot.State() is null && !slot.Busy, "a slot older than 24 hours is released, and defenderScan is gone.");
        provider.ScanGate.Set();
        await Until(() => refreshes == before + 1, "the late end of the released call still requests a refresh.");
        Check(slot.State() is null, "the late end of a released call does not clear a newer slot state.");

        // ---- Clean all active detections ----
        provider = new FakeProvider { Active = 0 };
        control = new NativeDefenderControl(new DefenderScanSlot(), provider, Short);
        Check(Is(await Run(control, "defender-clean-detections"), true, "AGENT_DEFENDER_NO_ACTIVE_DETECTIONS") && provider.Removes == 0, "0 before: ok, and Remove is not called.");
        provider.Active = 3; provider.ActiveAfterRemove = 0;
        var cleaned = await Run(control, "defender-clean-detections");
        Check(Is(cleaned, true, "AGENT_DEFENDER_DETECTIONS_CLEANED") && Arg(cleaned, "count") == "3" && provider.Removes == 1, "n before, 0 after: cleaned with the count.");
        provider.Active = 3; provider.ActiveAfterRemove = 1;
        var remain = await Run(control, "defender-clean-detections");
        Check(Is(remain, false, "AGENT_DEFENDER_DETECTIONS_REMAIN") && Arg(remain, "cleaned") == "2" && Arg(remain, "remaining") == "1", "n before, m after: failed with cleaned and remaining.");

        // ---- Signatures ----
        var signed = await Run(control, "defender-update-signatures");
        Check(Is(signed, true, "AGENT_DEFENDER_SIGNATURES_UPDATED") && Arg(signed, "version") == "1.421.2000.0", "the version is read from MSFT_MpComputerStatus afterwards.");
        provider.UpdateCode = 0x8024402C;
        Check(Is(await Run(control, "defender-update-signatures"), false, "AGENT_DEFENDER_ACTION_FAILED"), "a refused update fails the job.");
        provider.UpdateCode = 0; provider.UpdateGate = new ManualResetEventSlim(false);
        var timeout = await Run(control, "defender-update-signatures");
        Check(Is(timeout, false, "AGENT_DEFENDER_TIMEOUT") && Arg(timeout, "minutes") == "15", "an update that does not end in time gives the timeout with 15 minutes.");
        provider.UpdateGate.Set();
        provider.Version = null;
        Check(Arg(await Run(control, "defender-update-signatures"), "version") == "-", "an unreadable version is shown as -.");

        // ---- Unavailable ----
        foreach (var action in JobRunner.DefenderActions)
        {
            var missing = new NativeDefenderControl(new DefenderScanSlot(), new FakeProvider { ModeFailure = new DefenderUnavailableException("missing") }, Short);
            Check(Is(await Run(missing, action), false, "AGENT_DEFENDER_UNAVAILABLE"), action + ": a missing Defender gives AGENT_DEFENDER_UNAVAILABLE.");
            var stopped = new FakeProvider { Mode = "Not running" };
            Check(Is(await Run(new NativeDefenderControl(new DefenderScanSlot(), stopped, Short), action), false, "AGENT_DEFENDER_UNAVAILABLE") && stopped.Scans == 0 && stopped.Removes == 0, action + ": the mode Not running gives AGENT_DEFENDER_UNAVAILABLE and calls nothing.");
        }
        Check(Is(await Run(new NativeDefenderControl(new DefenderScanSlot(), new FakeProvider { Mode = "Passive Mode" }, Short), "defender-update-signatures"), true, "AGENT_DEFENDER_SIGNATURES_UPDATED"), "passive mode is not blocked.");

        // ---- JobRunner lists ----
        Check(JobRunner.DefenderActions.All(action => !JobRunner.ReadActions.Contains(action) && !JobRunner.AllowedInReadOnly(action)), "the Defender actions are not read actions, so ReadOnly mode refuses them.");
    }
}
