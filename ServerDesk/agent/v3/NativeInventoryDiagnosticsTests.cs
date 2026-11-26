using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class NativeInventoryDiagnosticsTests
{
    internal static async Task RunAsync()
    {
        var partial = new JsonObject
        {
            ["networks"] = new JsonArray(new JsonObject { ["name"] = "Healthy adapter" }),
            ["_collectionWarnings"] = new JsonArray("One adapter detail is unavailable")
        };
        var snapshot = new JsonObject(); var errors = new JsonArray();
        NativeTelemetryCollector.MergeCollectorSnapshot(snapshot, partial, errors);
        if (snapshot.ContainsKey("_collectionWarnings") || snapshot["networks"]!.AsArray().Count != 1 || errors.Count != 1)
            throw new Exception("Partial network data disappeared or collector metadata escaped into telemetry.");
        partial["networks"]![0]!["name"] = "Changed source";
        if (snapshot["networks"]![0]!["name"]!.GetValue<string>() != "Healthy adapter")
            throw new Exception("Telemetry inventory shares mutable nodes with its collector.");
        for (int i = errors.Count; i < 20; i++) errors.Add("Earlier collector warning");
        NativeTelemetryCollector.MergeCollectorSnapshot(snapshot, partial, errors);
        if (errors.Count != 20) throw new Exception("Partial inventory warnings exceeded the heartbeat error budget.");

        string network = NativeInventoryDiagnostics.Describe(new NetworkInformationException(10043));
        var providerError = new NativeInventoryException("ServerManager metadata", new COMException("provider-private-detail", unchecked((int)0x80041010)));
        string provider = NativeInventoryDiagnostics.Describe(providerError);
        if (!network.Contains("10043") || !provider.Contains("80041010") || !provider.Contains("ServerManager metadata") || provider.Contains("provider-private-detail") || !providerError.Message.Contains("80041010") || providerError.Message.Contains("provider-private-detail"))
            throw new Exception("Inventory diagnostics lost native codes or exposed an arbitrary provider message.");

        int logged = 0; var at = DateTimeOffset.UtcNow;
        var failed = new TelemetryCollectorSlot("Provider", TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(3),
            () => throw new COMException("provider-private-detail", unchecked((int)0x80041010)),
            _ => { logged++; throw new IOException("Local log unavailable"); });
        failed.StartIfDue(at); try { await failed.CurrentTask!; } catch (COMException) { }
        var first = failed.Read(at); var again = failed.Read(at);
        if (logged != 1 || first.Error is null || !first.Error.Contains("80041010") || first.Error.Contains("provider-private-detail") || first.Error != again.Error)
            throw new Exception("Diagnostic logging interrupted collection, repeated on every heartbeat, or leaked provider messages.");
    }
}
