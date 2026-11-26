using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class NativeTelemetrySelfTests
{
    internal static async Task RunAsync()
    {
        var baseline = NativeTelemetryCollector.CreateBaseSnapshot(Path.GetTempPath(), new JsonObject { ["mode"] = "ReadOnly" });
        foreach (var key in new[] { "hostname", "os", "build", "manufacturer", "model", "domain", "cores", "memoryGb", "cpu", "memory", "uptimeSeconds", "rebootPending", "rebootReasons", "pendingFileOperationsCount", "management", "disks", "services", "processes", "events", "networks", "hotfixes", "collectionErrors", "protocolVersion", "agentVersion", "mode", "agentCapabilities" }) if (!baseline.ContainsKey(key)) throw new Exception("Native boot telemetry misses required field: " + key);
        if (baseline["processInventory"]?["complete"]?.GetValue<bool>() != false || baseline["processInventory"]?["error"] is null || baseline["management"]!.GetValue<bool>()) throw new Exception("Boot telemetry fabricated a current process inventory or management authority.");
        var management = NativeTelemetryCollector.CreateBaseSnapshot(Path.GetTempPath(), new JsonObject { ["mode"] = "Management" });
        if (!management["management"]!.GetValue<bool>() || management["mode"]!.GetValue<string>() != "Management") throw new Exception("Native snapshot mode disagrees with Management policy.");
        bool corruptUpdateRejected = false;
        try { NativeTelemetryCollector.NormalizeUpdates(new JsonObject { ["pendingCount"] = -1 }); } catch (InvalidDataException) { corruptUpdateRejected = true; }
        if (!corruptUpdateRejected) throw new Exception("Corrupt optional update cache can produce an invalid heartbeat.");
        var updateCache = NativeTelemetryCollector.NormalizeUpdates(new JsonObject { ["checkedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["pendingCount"] = 1, ["items"] = new JsonArray(new JsonObject { ["id"] = Guid.NewGuid().ToString("B"), ["title"] = new string('x', 1000), ["kb"] = "KB1", ["severity"] = "Critical", ["rebootRequired"] = true }) });
        if (updateCache["items"]![0]!["title"]!.GetValue<string>().Length != 500 || updateCache["items"]![0]!["id"]!.GetValue<string>().Length != 36) throw new Exception("Optional update cache exceeds the portal contract.");
        var unrated = NativeTelemetryCollector.NormalizeUpdates(new JsonObject { ["checkedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["pendingCount"] = 3, ["items"] = new JsonArray(
            new JsonObject { ["id"] = Guid.NewGuid().ToString("D"), ["title"] = "Security Intelligence Update", ["kb"] = "KB2267602", ["severity"] = null, ["rebootRequired"] = false },
            new JsonObject { ["id"] = Guid.NewGuid().ToString("D"), ["title"] = "Feature update", ["kb"] = "KB1", ["rebootRequired"] = true },
            new JsonObject { ["id"] = Guid.NewGuid().ToString("D"), ["title"] = "Driver update", ["kb"] = null, ["severity"] = "Important", ["rebootRequired"] = false }) });
        var unratedItems = unrated["items"]!.AsArray();
        if (unrated["pendingCount"]!.GetValue<int>() != 3 || unratedItems.Count != 3 || unratedItems[0]!["severity"]!.GetValue<string>() != "" || unratedItems[1]!["severity"]!.GetValue<string>() != "" || unratedItems[2]!["kb"]!.GetValue<string>() != "" || unratedItems[2]!["severity"]!.GetValue<string>() != "Important") throw new Exception("An update without a severity, title or KB rejected the update inventory.");
        bool numericFieldRejected = false;
        try { NativeTelemetryCollector.NormalizeUpdates(new JsonObject { ["checkedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["pendingCount"] = 1, ["items"] = new JsonArray(new JsonObject { ["id"] = Guid.NewGuid().ToString("D"), ["title"] = "Update", ["kb"] = "KB1", ["severity"] = 5, ["rebootRequired"] = false }) }); } catch (InvalidDataException) { numericFieldRejected = true; }
        if (!numericFieldRejected) throw new Exception("A non-string update field passed as a valid update inventory.");

        var at = DateTimeOffset.UtcNow;
        if (NativeProcessInventory.ComputeCpu(10, at.AddSeconds(-30), 40, at, 4) != 25 || NativeProcessInventory.ComputeCpu(100, at.AddSeconds(-30), 1, at, 4) is not null || NativeProcessInventory.ComputeCpu(0, at.AddSeconds(-121), 30, at, 4) is not null || NativeProcessInventory.ComputeCpu(0, at, 1, at, 4) is not null || NativeProcessInventory.ComputeCpu(0, at.AddSeconds(-30), double.NaN, at, 4) is not null) throw new Exception("Process CPU samples accept reset counters, clock reversals, nonfinite values or stale gaps.");

        int calls = 0; var unblock = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously); var entered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var slow = new TelemetryCollectorSlot("Slow provider", TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(3), () => { Interlocked.Increment(ref calls); entered.TrySetResult(true); unblock.Task.GetAwaiter().GetResult(); return new JsonObject { ["services"] = new JsonArray(new JsonObject { ["name"] = "Recovered" }) }; });
        slow.StartIfDue(at);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        for (int i = 1; i < 50; i++) slow.StartIfDue(at.AddSeconds(i * 30));
        var waiting = slow.Read(at.AddMinutes(25));
        if (calls != 1 || waiting.Value is not null || waiting.Error is null) throw new Exception("Hung telemetry provider accumulated retries or concealed its deadline.");
        unblock.SetResult(true);
        await slow.CurrentTask!;
        var recovered = slow.Read(at.AddMinutes(25));
        if (recovered.Value?["services"]?.AsArray().Count != 1 || recovered.Error is not null) throw new Exception("An independently recovering provider failed to republish its inventory.");
        if (slow.Read(at.AddMinutes(27)).Value is not null) throw new Exception("Old inventory survived its bounded staleness limit.");

        int refreshCalls = 0;
        var refresh = new TelemetryCollectorSlot("Refresh provider", TimeSpan.FromMinutes(5), TimeSpan.FromSeconds(3), () => new JsonObject { ["version"] = Interlocked.Increment(ref refreshCalls) });
        refresh.StartIfDue(at); await refresh.CurrentTask!; _ = refresh.Read(at);
        refresh.StartIfDue(at.AddSeconds(1)); if (refreshCalls != 1) throw new Exception("Inventory ignored its five-minute interval.");
        refresh.RequestRefresh(); refresh.StartIfDue(at.AddSeconds(2)); await refresh.CurrentTask!;
        if (refresh.Read(at.AddSeconds(2)).Value?["version"]?.GetValue<int>() != 2) throw new Exception("Management-triggered refresh retained old native inventory.");

        var failed = new TelemetryCollectorSlot("Broken provider", TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(3), () => throw new InvalidOperationException("provider-private-detail"));
        failed.StartIfDue(at); try { await failed.CurrentTask!; } catch { }
        var failure = failed.Read(at);
        if (failure.Value is not null || failure.Error is null || failure.Error.Contains("provider-private-detail")) throw new Exception("Failed telemetry provider leaked raw diagnostic content or disappeared without an error.");

        await SchedulingAsync(at);
        ProviderCachesAndMetrics(at);

        var huge = new JsonObject { ["events"] = new JsonArray(new JsonObject { ["message"] = new string('x', 10000) }), ["collectionErrors"] = new JsonArray(), ["features"] = new JsonArray(new JsonObject { ["name"] = "Role" }), ["localGroups"] = new JsonArray(Enumerable.Range(0, 100).Select(_ => (JsonNode)new JsonObject { ["members"] = new JsonArray(Enumerable.Range(0, 100).Select(__ => (JsonNode?)JsonValue.Create(new string('x', 500))).ToArray()) }).ToArray()) };
        NativeTelemetryCollector.LimitSnapshot(huge);
        if (huge["events"]![0]!["message"]!.GetValue<string>().Length > 3500 || huge["localGroups"]?.AsArray().Count != 0 || huge["features"]?.AsArray().Count != 1 || huge["collectionErrors"]?.AsArray().Count != 1) throw new Exception("Telemetry payload bounds removed feature relationships or failed to trim oversized inventories.");
    }

    private static async Task SchedulingAsync(DateTimeOffset at)
    {
        int firstCalls = 0, secondCalls = 0, thirdCalls = 0;
        var unblock = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = new TelemetryCollectorSlot("First", TimeSpan.FromMinutes(5), TimeSpan.FromSeconds(5), () => { Interlocked.Increment(ref firstCalls); firstEntered.TrySetResult(); unblock.Task.GetAwaiter().GetResult(); return new JsonObject { ["first"] = true }; });
        var second = new TelemetryCollectorSlot("Second", TimeSpan.FromMinutes(5), TimeSpan.FromSeconds(5), () => { Interlocked.Increment(ref secondCalls); secondEntered.TrySetResult(); unblock.Task.GetAwaiter().GetResult(); return new JsonObject { ["second"] = true }; });
        var third = new TelemetryCollectorSlot("Third", TimeSpan.FromMinutes(5), TimeSpan.FromSeconds(5), () => new JsonObject { ["version"] = Interlocked.Increment(ref thirdCalls) });
        var scheduler = new TelemetryInventoryScheduler(new[] { first, second, third });
        if (!scheduler.Tick(at)) throw new Exception("Staggered inventory did not start the first provider.");
        await firstEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        if (scheduler.Tick(at.AddSeconds(1))) throw new Exception("Inventory providers were launched together instead of respecting the spacing.");
        if (!scheduler.Tick(at.AddSeconds(2))) throw new Exception("The second inventory provider was starved.");
        await secondEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        if (scheduler.Tick(at.AddSeconds(4)) || thirdCalls != 0) throw new Exception("Inventory exceeded its responsive-provider concurrency limit.");
        for (int i = 0; i < 20; i++) first.RequestRefresh();
        if (!scheduler.Tick(at.AddSeconds(7))) throw new Exception("A stuck Windows provider prevented unrelated inventory from refreshing.");
        await third.CurrentTask!;
        if (firstCalls != 1 || secondCalls != 1 || third.Read(at.AddSeconds(7)).Value?["version"]?.GetValue<int>() != 1) throw new Exception("Deadline handling multiplied stuck workers or lost healthy provider output.");
        unblock.SetResult(); await first.CurrentTask!; await second.CurrentTask!;
        _ = first.Read(at.AddSeconds(8)); _ = second.Read(at.AddSeconds(8));
        if (!scheduler.Tick(at.AddSeconds(9))) throw new Exception("Explicit inventory refresh was lost while its provider was busy.");
        await first.CurrentTask!;
        if (firstCalls != 2 || scheduler.Tick(at.AddSeconds(11))) throw new Exception("Coalesced refresh produced duplicate native collections.");

        int shutdownCalls = 0;
        var slowUnblock = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var shutdownEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var shutdownSlot = new TelemetryCollectorSlot("Stalled at shutdown", TimeSpan.FromMinutes(5), TimeSpan.FromSeconds(3), () => { Interlocked.Increment(ref shutdownCalls); shutdownEntered.TrySetResult(); slowUnblock.Task.GetAwaiter().GetResult(); return new JsonObject(); });
        var stopping = new TelemetryInventoryScheduler(new[] { shutdownSlot }, TimeSpan.FromMilliseconds(20));
        _ = stopping.RunAsync(CancellationToken.None);
        await shutdownEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await stopping.StopAsync().WaitAsync(TimeSpan.FromSeconds(1));
        if (shutdownCalls != 1) throw new Exception("Service shutdown duplicated an abandoned collection worker.");
        slowUnblock.SetResult(); await shutdownSlot.CurrentTask!;
    }

    private static void ProviderCachesAndMetrics(DateTimeOffset at)
    {
        var startModes = new NativeServiceStartModeCache(2); int registryReads = 0; uint mode = 2;
        uint? ReadStart() { registryReads++; return mode; }
        _ = startModes.Read("Example", at, ReadStart); mode = 3;
        if (startModes.Read("EXAMPLE", at.AddSeconds(30), ReadStart) != 2 || registryReads != 1) throw new Exception("Service telemetry repeated stable startup registry reads each heartbeat.");
        if (startModes.Read("Example", at.AddMinutes(5), ReadStart) != 3 || registryReads != 2) throw new Exception("Native service startup cache concealed an out-of-band configuration change.");
        mode = 4; startModes.Invalidate();
        if (startModes.Read("Example", at.AddMinutes(5), ReadStart) != 4 || registryReads != 3) throw new Exception("Management refresh retained cached service configuration.");
        _ = startModes.Read("Other", at, ReadStart); _ = startModes.Read("Third", at, ReadStart);
        if (startModes.Count != 2) throw new Exception("Service startup cache accumulated removed service names without bounds.");

        var cache = new BoundedEventDescriptionCache(128); int renders = 0;
        string Render() { renders++; return "Event message"; }
        for (int cycle = 0; cycle < 10; cycle++) for (int record = 0; record < 60; record++) _ = cache.GetOrAdd("System|" + record + "|old-timestamp", Render);
        if (renders != 60 || cache.Count != 60) throw new Exception("Unchanged event inventory repeatedly rendered provider messages.");
        _ = cache.GetOrAdd("System|1|new-timestamp", Render);
        if (renders != 61) throw new Exception("Reused event RecordID returned a message from before the channel was cleared.");
        for (int record = 60; record < 400; record++) _ = cache.GetOrAdd("Application|" + record, Render);
        if (cache.Count != 128) throw new Exception("Event description cache grew beyond its resource budget.");
        int before = renders; _ = cache.GetOrAdd("System|0|old-timestamp", Render);
        if (renders != before + 1 || cache.Count != 128) throw new Exception("Event description eviction retained an unbounded stale catalog.");

        if (NativeServiceInventory.EntrySize != (IntPtr.Size == 8 ? 56 : 44) || NativePerformanceInventory.FormattedValueSize != 16) throw new Exception("Native telemetry structure layout does not match the Windows ABI.");
        if (NativeServiceInventory.State(2) != "Start Pending" || NativeServiceInventory.StartMode(2) != "Auto" || NativeServiceInventory.StartMode(null) != "Unknown") throw new Exception("Native service status changed the portal inventory contract.");
        if (NativePerformanceInventory.ValidMetric(0, .0025, 1000) != 2.5 || NativePerformanceInventory.ValidMetric(1, 150, percentage: true) != 100 || NativePerformanceInventory.ValidMetric(2, 10) is not null || NativePerformanceInventory.ValidMetric(0, double.NaN) is not null || NativePerformanceInventory.ValidMetric(0, -1) is not null || NativePerformanceInventory.ValidMetric(0, double.MaxValue, 1000) is not null) throw new Exception("Native performance metrics accepted a counter error or invalid units/value.");
        if (NativePerformanceInventory.Rate(100, at.AddSeconds(-30), 3100, at) != 100 || NativePerformanceInventory.Rate(100, at.AddSeconds(-30), 1, at) is not null || NativePerformanceInventory.Rate(100, at.AddSeconds(-121), 3100, at) is not null || NativePerformanceInventory.Rate(100, at, 3100, at) is not null || NativePerformanceInventory.Rate(100, default, 3100, at) is not null) throw new Exception("Native network rates accepted a counter reset, cold start, clock reversal or stale sample.");
    }
}
