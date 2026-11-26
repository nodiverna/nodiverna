using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class NativeDriftMonitorTests
{
    internal static async Task RunAsync()
    {
        Scheduling();
        await UploadRetryAsync();
        await ReplacementAsync();
        Console.WriteLine("Native drift monitor tests passed: paced full scans, burst coalescing, changes during collection, retained bounded reports, exponential upload retry, serialized policy replacement and cancellation.");
    }
    private static void Scheduling()
    {
        DateTimeOffset at = new(2026, 10, 9, 0, 0, 0, TimeSpan.Zero);
        var schedule = new DriftScanSchedule(TimeSpan.FromSeconds(300));
        Assert(schedule.TryBeginScan(at), "A newly enabled drift policy must make its first full scan.");
        Assert(!schedule.TryBeginScan(at.AddSeconds(1)), "A schedule cannot admit a second overlapping scan.");
        schedule.Changed(at.AddSeconds(10)); // This event occurs during the scan.
        schedule.ScanFinished(at.AddSeconds(20));
        Assert(!schedule.TryBeginScan(at.AddSeconds(79)), "File changes must not trigger full hashing less than 60 seconds after a scan finishes.");
        Assert(schedule.TryBeginScan(at.AddSeconds(80)), "A change during collection must remain dirty and produce the paced followup scan.");
        schedule.ScanFinished(at.AddSeconds(80));
        Assert(!schedule.TryBeginScan(at.AddSeconds(379)), "The configured periodic interval must be honored after a clean scan.");
        Assert(schedule.TryBeginScan(at.AddSeconds(380)), "An unchanged policy must still get its periodic full scan.");
        schedule.ScanFinished(at.AddSeconds(380));
        schedule.Changed(at.AddSeconds(439));
        Assert(!schedule.TryBeginScan(at.AddSeconds(440)), "The minimum scan gap does not remove filesystem burst debounce.");
        Assert(schedule.TryBeginScan(at.AddSeconds(442)), "A quiet file change must become eligible once both pacing and debounce pass.");
        schedule.ScanFailed(at.AddSeconds(442));
        Assert(!schedule.TryBeginScan(at.AddSeconds(501)) && schedule.TryBeginScan(at.AddSeconds(502)), "A collector failure must not create an immediate full-rescan loop.");
        schedule.ScanFinished(at.AddSeconds(502));
        for (int second = 503; second <= 802; second++) schedule.Changed(at.AddSeconds(second));
        Assert(schedule.TryBeginScan(at.AddSeconds(802)), "A continuously changing folder must not starve the configured periodic scan.");
        schedule.Changed(at, overflow: true);
        Assert(schedule.TakeOverflow() && !schedule.TakeOverflow(), "An overflow belongs to one report and must not leak into every subsequent report.");
        schedule.Changed(at, overflow: true);
        Assert(schedule.TakeOverflow(), "A new overflow after a completed scan must still be reported.");
        var retry = new DriftScanSchedule(TimeSpan.FromSeconds(60));
        foreach (int seconds in new[] { 2, 4, 8, 16, 32, 60, 60, 60 })
        {
            Assert(retry.UploadFailed(at) == TimeSpan.FromSeconds(seconds), "Drift upload retry must use bounded exponential backoff.");
            Assert(!retry.UploadDue(at.AddSeconds(seconds).AddTicks(-1)) && retry.UploadDue(at.AddSeconds(seconds)), "Retry cannot be admitted before its deadline.");
            at = at.AddSeconds(seconds);
        }
        retry.UploadSucceeded();
        Assert(retry.UploadDue(at) && retry.UploadFailed(at) == TimeSpan.FromSeconds(2), "An upload ACK must reset the next outage's retry budget.");
    }
    private static JsonObject Policy(int version = 1) => new()
    {
        ["enabled"] = true, ["policyId"] = "e66c71bd-94da-4f36-8d4b-486c8d55fca3", ["version"] = version,
        ["intervalSeconds"] = 300, ["paths"] = new JsonArray()
    };
    private static async Task UploadRetryAsync()
    {
        var clock = new ManualClock(); int scans = 0; var uploads = new List<string>();
        var monitor = new DriftMonitor(
            (_, _) => Task.FromResult(new JsonObject { ["scanId"] = "scan-" + ++scans, ["entries"] = new JsonArray() }),
            (report, _) => { uploads.Add(report); return uploads.Count < 4 ? Task.FromException(new HttpRequestException("offline")) : Task.CompletedTask; },
            clock.Now, clock.DelayAsync);
        try
        {
            monitor.Configure(Policy(), CancellationToken.None);
            await clock.WaitForDelayAsync();
            Assert(scans == 1 && uploads.Count == 1, "The first report should be collected and uploaded immediately.");
            monitor.Configure(Policy(), CancellationToken.None); // Every agent channel repeats the same policy.
            monitor.NotifyChange(overflow: true);
            clock.Advance(TimeSpan.FromSeconds(1)); await clock.WaitForDelayAsync();
            Assert(scans == 1 && uploads.Count == 1, "An outage or repeated channel policy cannot restart inventory before its upload retry deadline.");
            clock.Advance(TimeSpan.FromSeconds(1)); await clock.WaitForDelayAsync();
            clock.Advance(TimeSpan.FromSeconds(4)); await clock.WaitForDelayAsync();
            clock.Advance(TimeSpan.FromSeconds(8)); await clock.WaitForDelayAsync();
            Assert(scans == 1 && uploads.Count == 4 && uploads.All(report => report == uploads[0]), "Retries must retain the exact bounded completed report and scanId without rehashing or allocating more reports.");
            clock.Advance(TimeSpan.FromSeconds(45)); await clock.WaitForDelayAsync();
            Assert(scans == 1, "Changes during upload retries must wait for the minimum full-scan gap.");
            clock.Advance(TimeSpan.FromSeconds(1)); await clock.WaitForDelayAsync();
            Assert(scans == 2 && uploads.Count == 5 && JsonNode.Parse(uploads[4])!["overflow"]!.GetValue<bool>(), "File changes and overflows during a retained upload must survive into the next paced full scan.");
            monitor.Configure(new JsonObject { ["enabled"] = false }, CancellationToken.None);
            await monitor.StopAsync().WaitAsync(TimeSpan.FromSeconds(2));
            Assert(clock.PendingDelay.IsCanceled, "Disabling a drift policy must cancel its pending delay and stop the worker.");
        }
        finally { await monitor.StopAsync().WaitAsync(TimeSpan.FromSeconds(2)); }
    }
    private static async Task ReplacementAsync()
    {
        var clock = new ManualClock();
        var hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        CancellationToken oldToken = default;
        int active = 0, maximum = 0; var scans = new List<int>(); var uploads = new List<int>();
        var monitor = new DriftMonitor(async (policy, token) =>
        {
            int version = policy["version"]!.GetValue<int>(); scans.Add(version);
            int concurrent = Interlocked.Increment(ref active); maximum = Math.Max(maximum, concurrent);
            try
            {
                if (version == 1) { oldToken = token; started.TrySetResult(); await hold.Task; }
                return new JsonObject { ["version"] = version, ["entries"] = new JsonArray() };
            }
            finally { Interlocked.Decrement(ref active); }
        }, (report, _) => { uploads.Add(JsonNode.Parse(report)!["version"]!.GetValue<int>()); return Task.CompletedTask; }, clock.Now, clock.DelayAsync);
        try
        {
            monitor.Configure(Policy(), CancellationToken.None);
            await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
            monitor.Configure(Policy(2), CancellationToken.None);
            monitor.Configure(Policy(3), CancellationToken.None);
            Assert(oldToken.IsCancellationRequested, "Policy replacement must promptly cancel its old in-progress collection.");
            hold.TrySetResult();
            await clock.WaitForDelayAsync();
            Assert(maximum == 1 && scans.SequenceEqual(new[] { 1, 3 }), "Replacement policy scans must serialize and an already superseded pending policy must never collect.");
            Assert(uploads.SequenceEqual(new[] { 3 }), "A cancelled old scan must not upload into its replacement's baseline.");
            await monitor.StopAsync().WaitAsync(TimeSpan.FromSeconds(2));
        }
        finally { hold.TrySetResult(); await monitor.StopAsync().WaitAsync(TimeSpan.FromSeconds(2)); }

        var blockedUpload = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelling = new DriftMonitor((_, _) => Task.FromResult(new JsonObject()), async (_, token) =>
        {
            blockedUpload.TrySetResult(); await Task.Delay(Timeout.InfiniteTimeSpan, token);
        }, clock.Now, clock.DelayAsync);
        cancelling.Configure(Policy(), CancellationToken.None);
        await blockedUpload.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await cancelling.StopAsync().WaitAsync(TimeSpan.FromSeconds(2));
    }
    private sealed class ManualClock
    {
        private readonly object gate = new();
        private readonly Queue<TaskCompletionSource> delays = new();
        private readonly SemaphoreSlim waiting = new(0);
        private DateTimeOffset at = new(2026, 10, 9, 0, 0, 0, TimeSpan.Zero);
        internal Task PendingDelay { get; private set; } = Task.CompletedTask;
        internal DateTimeOffset Now() { lock (gate) return at; }
        internal Task DelayAsync(TimeSpan duration, CancellationToken token)
        {
            var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            CancellationTokenRegistration registration = token.Register(() => completion.TrySetCanceled(token));
            _ = completion.Task.ContinueWith(_ => registration.Dispose(), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            lock (gate) { delays.Enqueue(completion); PendingDelay = completion.Task; }
            waiting.Release(); return completion.Task;
        }
        internal async Task WaitForDelayAsync() => Assert(await waiting.WaitAsync(TimeSpan.FromSeconds(2)), "The drift test worker did not yield to its clock.");
        internal void Advance(TimeSpan duration)
        {
            TaskCompletionSource next; lock (gate) { at += duration; next = delays.Dequeue(); }
            next.TrySetResult();
        }
    }
    private static void Assert(bool condition, string message) { if (!condition) throw new InvalidDataException(message); }
}
