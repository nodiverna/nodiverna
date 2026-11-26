using System.Runtime.InteropServices;

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
        Console.WriteLine("PASS native feature provider: complete same-namespace resolution, missing metadata fallback, all-missing diagnostics, operational/permission failure isolation and cancellation.");
    }
}
