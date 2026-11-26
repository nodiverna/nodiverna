using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Management;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// Inventory work has its own clock, independent from the 30-second snapshot.
// One launch every two seconds prevents synchronized WMI/COM provider spikes.
// Two responsive providers may overlap. A provider that ignores its deadline
// remains single-flight, but cannot indefinitely starve unrelated inventories.
internal sealed class TelemetryInventoryScheduler(IReadOnlyList<TelemetryCollectorSlot> collectors, TimeSpan? launchSpacing = null, int maximumResponsive = 2)
{
    private readonly TimeSpan spacing = launchSpacing ?? TimeSpan.FromSeconds(2);
    private readonly object gate = new();
    private CancellationTokenSource? cancellation;
    private Task? run;
    private DateTimeOffset nextLaunch;
    private int cursor;

    internal Task RunAsync(CancellationToken token)
    {
        lock (gate)
        {
            if (run is not null) throw new InvalidOperationException("Inventory scheduler is already running.");
            cancellation = CancellationTokenSource.CreateLinkedTokenSource(token);
            return run = LoopAsync(cancellation.Token);
        }
    }

    private async Task LoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            Tick(DateTimeOffset.UtcNow);
            await Task.Delay(spacing, token);
        }
    }

    internal bool Tick(DateTimeOffset now)
    {
        if (now < nextLaunch || collectors.Count == 0) return false;
        if (collectors.Count(c => c.IsResponsiveAt(now)) >= maximumResponsive) return false;
        for (int offset = 0; offset < collectors.Count; offset++)
        {
            int index = (cursor + offset) % collectors.Count;
            if (!collectors[index].StartIfDue(now)) continue;
            cursor = (index + 1) % collectors.Count;
            nextLaunch = now + spacing;
            return true;
        }
        return false;
    }

    internal async Task StopAsync()
    {
        Task? pending;
        lock (gate) { cancellation?.Cancel(); pending = run; }
        if (pending is not null) try { await pending; } catch (OperationCanceledException) { }
        lock (gate) { cancellation?.Dispose(); cancellation = null; }
    }
}

// A stalled provider gets at most one dedicated worker. Provider work runs at
// below-normal priority and cannot occupy the HTTP/service shared thread pool.
// Keep successful values for a bounded interval and explicitly discard stale
// process snapshots; a fresh heartbeat never labels an old list as current.
// keepLastValue (Drivers) keeps the last successful value until the next
// success instead. A failed or stalled run becomes a coded collector error
// (collectorErrors) until the next success, and one log line.
internal sealed class TelemetryCollectorSlot(string name, TimeSpan interval, TimeSpan deadline, Func<JsonObject> collect, Action<string>? log = null, bool keepLastValue = false)
{
    private readonly object gate = new();
    private Task<JsonObject>? task;
    private DateTimeOffset started, completed;
    private JsonObject? value;
    private string? error;
    private bool refreshRequested, stallReported;
    private long runMilliseconds;
    private CollectorFailure? failure;
    internal string Name => name;
    /// <summary>The stable id of collectorErrors: the name in lower case, spaces replaced by "-".</summary>
    internal string Id { get; } = CollectorId(name);
    internal Task? CurrentTask { get { lock (gate) return task; } }
    internal void RequestRefresh() { lock (gate) refreshRequested = true; }
    internal static string CollectorId(string name) => name.Trim().ToLowerInvariant().Replace(' ', '-');

    internal bool StartIfDue(DateTimeOffset now)
    {
        lock (gate)
        {
            Consume(now);
            if (task is not null || !refreshRequested && started != default && now - started < interval) return false;
            started = now; refreshRequested = false; stallReported = false;
            task = Task.Factory.StartNew(() =>
            {
                var watch = Stopwatch.StartNew();
                try
                {
                    try { Thread.CurrentThread.Priority = ThreadPriority.BelowNormal; } catch { /* Scheduling policy is best effort. */ }
                    return collect();
                }
                finally { Volatile.Write(ref runMilliseconds, watch.ElapsedMilliseconds); }
            }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            return true;
        }
    }

    internal bool IsResponsiveAt(DateTimeOffset now)
    {
        lock (gate) { Consume(now); CheckStall(now); return task is not null && now - started <= deadline; }
    }

    private void Consume(DateTimeOffset now)
    {
        if (task is null || !task.IsCompleted) return;
        long elapsed = Volatile.Read(ref runMilliseconds);
        try { value = task.GetAwaiter().GetResult(); completed = now; error = null; failure = null; }
        catch (Exception e)
        {
            error = name + " could not be read (" + NativeInventoryDiagnostics.Describe(e) + ").";
            string code = CollectorErrorCodes.Classify(e);
            var at = started + TimeSpan.FromMilliseconds(elapsed);
            // A run that already counted as stalled is the same failure, now with its real cause.
            if (stallReported && failure is not null) failure = failure with { Code = code, LastAt = at, ElapsedMs = CollectorFailure.Bound(elapsed) };
            else Register(code, at, elapsed);
            Write(FailureLine(name, e, elapsed));
        }
        task = null;
    }

    // A run past its deadline counts as a timeout once, with one log line; its
    // elapsed time grows with every read until the run ends.
    private void CheckStall(DateTimeOffset now)
    {
        if (task is null || now - started <= deadline) return;
        long elapsed = (long)(now - started).TotalMilliseconds;
        if (!stallReported)
        {
            stallReported = true;
            Register(CollectorErrorCodes.Timeout, now, elapsed);
            Write(StallLine(name, elapsed));
        }
        else if (failure is not null) failure = failure with { ElapsedMs = CollectorFailure.Bound(elapsed) };
    }

    private void Register(string code, DateTimeOffset at, long elapsed) => failure = failure is null
        ? new CollectorFailure(Id, code, at, at, 1, CollectorFailure.Bound(elapsed))
        : failure with { Code = code, LastAt = at, Failures = Math.Min(failure.Failures + 1, CollectorFailure.MaximumFailures), ElapsedMs = CollectorFailure.Bound(elapsed) };

    private void Write(string line)
    {
        try { log?.Invoke(line); } catch { /* Diagnostics cannot interrupt a heartbeat. */ }
    }

    internal (JsonObject? Value, string? Error, CollectorFailure? Failure) Read(DateTimeOffset now)
    {
        lock (gate)
        {
            Consume(now); CheckStall(now);
            var message = task is not null && now - started > deadline ? name + ": the Windows provider does not answer in time; the collection continues independently." : error;
            if (value is null) message ??= name + " is being initialized.";
            bool stale = completed != default && now - completed > interval + interval + TimeSpan.FromSeconds(15);
            if (stale) message ??= name + ": the last successful state is out of date.";
            return (stale && !keepLastValue ? null : value, message, failure);
        }
    }

    /// <summary>The worker log line of a failed run: the broker's type and code for a broker failure, else the local description.</summary>
    internal static string FailureLine(string name, Exception error, long elapsedMs)
    {
        if (error is BrokerException broker)
            return "Inventory " + name + ": broker " + (broker.Detail ?? broker.RemoteType ?? nameof(BrokerException)) + " after " + Milliseconds(broker.ElapsedMs ?? elapsedMs) + " ms; " + WindowsManagement.Limit(broker.Message, 800);
        return "Inventory " + name + ": " + NativeInventoryDiagnostics.Describe(error) + " after " + Milliseconds(elapsedMs) + " ms; " + WindowsManagement.Limit(error.InnerException?.Message ?? error.Message, 800);
    }

    internal static string StallLine(string name, long elapsedMs) => "Inventory " + name + ": no result after " + Milliseconds(elapsedMs) + " ms; the collection continues in the background.";
    private static string Milliseconds(long value) => value.ToString(CultureInfo.InvariantCulture);
}

/// <summary>One entry of the snapshot's collectorErrors: the current failure series of one collector.</summary>
internal sealed record CollectorFailure(string Collector, string Code, DateTimeOffset Since, DateTimeOffset LastAt, int Failures, long? ElapsedMs)
{
    internal const int MaximumFailures = 1_000_000;
    internal const long MaximumElapsedMs = 3_600_000;
    internal static long Bound(long elapsed) => Math.Clamp(elapsed, 0, MaximumElapsedMs);
    internal JsonObject ToJson() => new()
    {
        ["collector"] = Collector, ["code"] = Code, ["since"] = Since.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture), ["lastAt"] = LastAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
        ["failures"] = Math.Clamp(Failures, 1, MaximumFailures), ["elapsedMs"] = ElapsedMs is long elapsed ? Bound(elapsed) : null
    };
}

// The codes of collectorErrors (docs/v3-health-signals.md). A failure inside the
// broker keeps the broker's code across the pipe (BrokerException.Code).
internal static class CollectorErrorCodes
{
    internal const string Timeout = "timeout", AccessDenied = "access-denied", NotSupported = "not-supported", BrokerUnavailable = "broker-unavailable", Error = "error";
    internal static readonly string[] All = [Timeout, AccessDenied, NotSupported, BrokerUnavailable, Error];

    internal static string Classify(Exception failure)
    {
        Exception current = failure;
        for (int depth = 0; depth < 4; depth++)
        {
            switch (current)
            {
                case BrokerException broker: return broker.Code is string code && All.Contains(code) ? code : Error;
                case BrokerUnavailableException: return BrokerUnavailable;
                case ManagementException management: return Classify(management.ErrorCode);
                case TimeoutException: return Timeout;
                case UnauthorizedAccessException: return AccessDenied;
                case Win32Exception { NativeErrorCode: 5 }: return AccessDenied;
                case PlatformNotSupportedException or DllNotFoundException or EntryPointNotFoundException: return NotSupported;
                case NativeInventoryException { InnerException: { } inner }: current = inner; continue;
                case AggregateException { InnerExceptions.Count: 1 } aggregate: current = aggregate.InnerExceptions[0]; continue;
            }
            break;
        }
        return Error;
    }

    internal static string Classify(ManagementStatus status) => status switch
    {
        ManagementStatus.Timedout or ManagementStatus.CallCanceled => Timeout,
        ManagementStatus.AccessDenied => AccessDenied,
        ManagementStatus.InvalidClass or ManagementStatus.NotSupported or ManagementStatus.InvalidNamespace => NotSupported,
        _ => Error
    };
}
