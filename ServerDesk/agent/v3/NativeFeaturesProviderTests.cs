using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// Resolver tests exercise the real selection/error policy without invoking WMI
// or pretending that provider installation was checked on this test host.
internal static class NativeFeaturesProviderTests
{
    internal static void Run()
    {
        static void Assert(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException("Native feature provider regression: " + message);
        }
        static COMException Missing(int code = unchecked((int)0x80041010)) => new("Missing fixture metadata.", code);
        var calls = new List<(string Namespace, string Class)>();
        void Record(string ns, string name) => calls.Add((ns, name));
        string selected = NativeFeatures.ResolveServerManagerNamespace(Record, CancellationToken.None);
        Assert(selected == NativeFeatures.ServerManagerNamespace && calls.SequenceEqual(new[]
        {
            (NativeFeatures.ServerManagerNamespace, NativeFeatures.DeploymentTasksClass),
            (NativeFeatures.ServerManagerNamespace, NativeFeatures.RequestGuidClass)
        }), "primary registration validates task and request classes together");

        foreach (int missingCode in new[] { unchecked((int)0x8004100E), unchecked((int)0x80041010), unchecked((int)0x80041011) })
        {
            calls.Clear();
            selected = NativeFeatures.ResolveServerManagerNamespace((ns, name) =>
            {
                Record(ns, name);
                if (ns == NativeFeatures.ServerManagerNamespace) throw Missing(missingCode);
            }, CancellationToken.None);
            Assert(selected == NativeFeatures.DocumentedNamespace && calls.Count == 3 &&
                calls[1] == (selected, NativeFeatures.DeploymentTasksClass) && calls[2] == (selected, NativeFeatures.RequestGuidClass),
                "missing namespace/class/provider can select the alternate complete registration");
        }

        calls.Clear();
        selected = NativeFeatures.ResolveServerManagerNamespace((ns, name) =>
        {
            Record(ns, name);
            if (ns == NativeFeatures.ServerManagerNamespace && name == NativeFeatures.RequestGuidClass) throw Missing();
        }, CancellationToken.None);
        Assert(selected == NativeFeatures.DocumentedNamespace && calls.Count == 4 &&
            calls[2] == (selected, NativeFeatures.DeploymentTasksClass) && calls[3] == (selected, NativeFeatures.RequestGuidClass),
            "request class must exist in the same selected namespace as tasks; registrations cannot be mixed");

        calls.Clear(); var lastMissing = Missing(); bool refused = false;
        try
        {
            NativeFeatures.ResolveServerManagerNamespace((ns, name) => { Record(ns, name); throw lastMissing; }, CancellationToken.None);
        }
        catch (NativeInventoryException error)
        {
            refused = ReferenceEquals(error.InnerException, lastMissing) &&
                error.Context.Contains(NativeFeatures.ServerManagerNamespace, StringComparison.Ordinal) &&
                error.Context.Contains(NativeFeatures.DocumentedNamespace, StringComparison.Ordinal);
        }
        Assert(refused && calls.Count == 2, "all missing registrations remain a diagnostic failure with the native code preserved");

        // WMI AccessDenied, COM E_ACCESSDENIED, provider failure/registration/load
        // errors and a timeout are operational failures rather than evidence that
        // another provider registration is absent.
        foreach (int code in new[]
        {
            unchecked((int)0x80041003), unchecked((int)0x80070005), unchecked((int)0x80041004),
            unchecked((int)0x80041012), unchecked((int)0x80041013), unchecked((int)0x800705B4)
        })
        {
            calls.Clear(); var native = new COMException("Operational fixture error.", code); refused = false;
            try
            {
                NativeFeatures.ResolveServerManagerNamespace((ns, name) => { Record(ns, name); throw native; }, CancellationToken.None);
            }
            catch (NativeInventoryException error)
            {
                refused = ReferenceEquals(error.InnerException, native) &&
                    error.Context.Contains(NativeFeatures.ServerManagerNamespace, StringComparison.Ordinal) &&
                    error.Context.Contains(NativeFeatures.DeploymentTasksClass, StringComparison.Ordinal);
            }
            Assert(refused && calls.Count == 1, "operational/permission failure preserves native diagnostics without fallback");
        }

        calls.Clear(); var deniedRequest = new COMException("Request metadata denied.", unchecked((int)0x80041003)); refused = false;
        try
        {
            NativeFeatures.ResolveServerManagerNamespace((ns, name) =>
            {
                Record(ns, name);
                if (name == NativeFeatures.RequestGuidClass) throw deniedRequest;
            }, CancellationToken.None);
        }
        catch (NativeInventoryException error)
        {
            refused = ReferenceEquals(error.InnerException, deniedRequest) && error.Context.Contains(NativeFeatures.RequestGuidClass, StringComparison.Ordinal);
        }
        Assert(refused && calls.Count == 2 && calls.All(call => call.Namespace == NativeFeatures.ServerManagerNamespace),
            "denied request-class metadata cannot switch away from the current registration");

        calls.Clear(); using var cancelled = new CancellationTokenSource(); cancelled.Cancel(); refused = false;
        try { NativeFeatures.ResolveServerManagerNamespace(Record, cancelled.Token); }
        catch (OperationCanceledException) { refused = true; }
        Assert(refused && calls.Count == 0, "cancelled inventory does not probe a provider");

        calls.Clear(); using var cancelDuringProbe = new CancellationTokenSource(); refused = false;
        try
        {
            NativeFeatures.ResolveServerManagerNamespace((ns, name) => { Record(ns, name); cancelDuringProbe.Cancel(); }, cancelDuringProbe.Token);
        }
        catch (OperationCanceledException) { refused = true; }
        Assert(refused && calls.Count == 1, "cancellation after metadata read stops before request selection");
        var labels = new NativeFeatureDisplayCache(); var now = DateTimeOffset.UtcNow; int labelReads = 0;
        string Label() { labelReads++; return "Lokalisierte Funktion"; }
        Assert(labels.Read("Example", now, Label) == "Lokalisierte Funktion" && labels.Read("example", now.AddMinutes(5), Label) == "Lokalisierte Funktion" && labelReads == 1,
            "periodic state inventory reuses metadata instead of repeating per-feature DISM detail queries");
        labels.Read("Example", now.AddDays(1), Label);
        Assert(labelReads == 2, "feature metadata is refreshed after its bounded lifetime");
        labels.Clear(); labels.Read("Example", now.AddDays(1), Label);
        Assert(labelReads == 3, "explicit feature changes invalidate metadata");
        bool failedLabel = false;
        try { labels.Read("Failure", now, () => throw new InvalidDataException("Provider fixture failed.")); }
        catch (InvalidDataException) { failedLabel = true; }
        labels.Read("Failure", now, Label);
        Assert(failedLabel && labelReads == 4, "failed DISM metadata reads are retried rather than cached as success");
        Budget(Assert);
        ListSingleFlightAsync(Assert).GetAwaiter().GetResult();
        Timing(Assert);
        Console.WriteLine("PASS native feature provider: complete same-namespace resolution, missing metadata fallback, all-missing diagnostics, operational/permission failure isolation and cancellation.");
        Console.WriteLine("PASS native feature list: time budget, single-flight enumeration with shared failure and cancellation, timing line.");
    }

    // ---- 4.21.5: the deadline covers the enumeration and the first provider probes; the broker call outlives it ----
    private static void Budget(Action<bool, string> Assert)
    {
        Assert(NativeFeatures.ServerEnumerationSeconds == 120 && NativeFeatures.InventoryDeadlineSeconds == 150, "the enumeration polls 120 s within a 150 s deadline.");
        Assert(NativeFeatures.InventoryDeadlineSeconds >= NativeFeatures.ServerEnumerationSeconds + 4 * NativeFeatures.ProviderProbeTimeout.TotalSeconds + 10,
            "the deadline covers the enumeration, four provider probes and 10 s margin.");
        Assert(AgentWorker.PrivilegedCallSeconds(NativeFeatures.InventoryDeadlineSeconds) > NativeFeatures.InventoryDeadlineSeconds && AgentWorker.PrivilegedCallSeconds(NativeFeatures.InventoryDeadlineSeconds) == 165,
            "the worker's broker call waits longer than the deadline (165 s).");
    }

    private static JsonArray Rows(params string[] names) => new(names.Select(name => (JsonNode?)new JsonObject { ["name"] = name, ["displayName"] = name, ["installed"] = true, ["featureType"] = "Role", ["parent"] = null, ["subFeatures"] = new JsonArray(), ["depth"] = 0 }).ToArray());
    private static string Names(JsonArray rows) => string.Join(",", rows.Select(row => row!["name"]!.GetValue<string>()));

    // ---- 4.21.5: one shared list enumeration for concurrent callers ----
    private static async Task ListSingleFlightAsync(Action<bool, string> Assert)
    {
        var wait = TimeSpan.FromSeconds(10);
        NativeFeatures.ResetListCache();
        try
        {
            int calls = 0;
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            JsonArray Blocking(bool server) { Interlocked.Increment(ref calls); entered.TrySetResult(); release.Task.GetAwaiter().GetResult(); return Rows("AD-Domain-Services", "Web-Server"); }
            var telemetry = NativeFeatures.ListAsync(true, CancellationToken.None, Blocking);
            await entered.Task.WaitAsync(wait);
            // The drift inventory and a cancelled caller start while the telemetry enumeration runs.
            var drift = NativeFeatures.ListAsync(true, CancellationToken.None, Blocking);
            using var cancel = new CancellationTokenSource();
            var cancelled = NativeFeatures.ListAsync(true, cancel.Token, Blocking);
            cancel.Cancel();
            bool stopped = false;
            try { await cancelled.WaitAsync(wait); } catch (OperationCanceledException) { stopped = true; }
            Assert(stopped && !telemetry.IsCompleted && !drift.IsCompleted, "a cancelled caller ends only its own wait; the shared enumeration goes on.");
            release.SetResult();
            var first = await telemetry.WaitAsync(wait); var second = await drift.WaitAsync(wait);
            Assert(calls == 1 && Names(first) == "AD-Domain-Services,Web-Server" && Names(second) == Names(first) && !ReferenceEquals(first, second),
                "two concurrent list calls share one enumeration and each get the rows (" + calls + " enumerations).");
            var fromCache = await NativeFeatures.ListAsync(true, CancellationToken.None, _ => throw new InvalidOperationException("The cache must answer."));
            Assert(Names(fromCache) == Names(first) && calls == 1, "a list call within 20 s reads the cache.");
            var client = await NativeFeatures.ListAsync(false, CancellationToken.None, _ => { Interlocked.Increment(ref calls); return Rows("Microsoft-Hyper-V"); });
            Assert(calls == 2 && Names(client) == "Microsoft-Hyper-V", "the cache keeps its server check.");

            // A failed enumeration reaches every waiting caller once and is not kept.
            NativeFeatures.ResetListCache(); calls = 0;
            var failEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var failRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            JsonArray Failing(bool server) { Interlocked.Increment(ref calls); failEntered.TrySetResult(); failRelease.Task.GetAwaiter().GetResult(); throw new AgentMessageException("AGENT_FEATURE_INVENTORY_TIMEOUT"); }
            var one = NativeFeatures.ListAsync(true, CancellationToken.None, Failing);
            await failEntered.Task.WaitAsync(wait);
            var two = NativeFeatures.ListAsync(true, CancellationToken.None, Failing);
            failRelease.SetResult();
            var failures = new List<Exception>();
            foreach (var call in new[] { one, two })
                try { await call.WaitAsync(wait); } catch (Exception error) { failures.Add(error); }
            Assert(calls == 1 && failures.Count == 2 && failures.All(error => error is AgentMessageException && error.Message == failures[0].Message),
                "a failed enumeration gives the same failure to both callers without a second enumeration.");
            var retried = await NativeFeatures.ListAsync(true, CancellationToken.None, _ => { Interlocked.Increment(ref calls); return Rows("Web-Server"); });
            Assert(calls == 2 && Names(retried) == "Web-Server", "the next call after a failure enumerates again.");
        }
        finally { NativeFeatures.ResetListCache(); }
    }

    // ---- 4.21.5: the broker's timing line of a role read ----
    private static void Timing(Action<bool, string> Assert)
    {
        var timing = new NativeFeatureTiming();
        Assert(timing.LogLine(812, 74) == "Broker telemetry Roles and features: read in 812 ms (74 components).", "the first read after the broker start gives a line.");
        Assert(timing.LogLine(900, 74) is null && timing.LogLine(19_999, 74) is null, "a fast read after the first gives no line.");
        Assert(timing.LogLine(20_000, 74) == "Broker telemetry Roles and features: read in 20000 ms (74 components).", "a read of 20 000 ms gives a line with its time and count.");
        Assert(timing.LogLine(95_310, 3) == "Broker telemetry Roles and features: read in 95310 ms (3 components).", "every slow read gives a line.");
    }
}
