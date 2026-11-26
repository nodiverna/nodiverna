using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class NativeWindowsUpdatesTests
{
    internal static void Run()
    {
        static void Assert(bool value, string label) { if (!value) throw new InvalidOperationException("Native update regression: " + label); }
        static void Refused(Action action, string label)
        {
            try { action(); } catch (Exception e) when (e is InvalidDataException or InvalidOperationException) { return; }
            throw new InvalidOperationException("Native update regression: accepted " + label);
        }
        NativeWindowsUpdates.ValidateInstall(new() { ["all"] = true });
        var chosen = Enumerable.Range(0, 50).Select(_ => Guid.NewGuid()).ToArray();
        NativeWindowsUpdates.ValidateInstall(new() { ["updateIds"] = new JsonArray(chosen.Select(id => (JsonNode)JsonValue.Create(id.ToString())!).ToArray()) });
        foreach (var p in new JsonObject[] { new(), new() { ["all"] = false }, new() { ["all"] = "true" }, new() { ["all"] = true, ["updateIds"] = new JsonArray(chosen[0].ToString()) }, new() { ["all"] = true, ["script"] = "powershell" }, new() { ["updateIds"] = new JsonArray() }, new() { ["updateIds"] = new JsonArray("bad") }, new() { ["updateIds"] = new JsonArray(chosen[0].ToString(), chosen[0].ToString().ToUpperInvariant()) }, new() { ["updateIds"] = new JsonArray(Enumerable.Range(0, 51).Select(_ => (JsonNode)JsonValue.Create(Guid.NewGuid().ToString())!).ToArray()) } }) Refused(() => NativeWindowsUpdates.ValidateInstall(p), "invalid/exclusive/oversized parameters");
        var catalog = Enumerable.Range(0, 130).Select(_ => new NativeWindowsUpdates.UpdatePolicy(Guid.NewGuid(), false, false)).ToList();
        var batches = NativeWindowsUpdates.PlanBatches(catalog, null); Assert(batches.Count == 1 && batches[0].Length == 130, "all uses full catalog beyond inventory100 and selected50");
        Assert(NativeWindowsUpdates.PlanBatches([], null).Count == 0, "fresh empty all is success without installation");
        var selection = catalog.Take(50).Select(item => item.Id).ToHashSet(); batches = NativeWindowsUpdates.PlanBatches(catalog, selection); Assert(batches.Single().ToHashSet().SetEquals(selection), "selected identity remains exact");
        var exclusive = new NativeWindowsUpdates.UpdatePolicy(Guid.NewGuid(), false, true); catalog.Add(exclusive); catalog.Add(new(Guid.NewGuid(), false, true));
        batches = NativeWindowsUpdates.PlanBatches(catalog, null); Assert(batches.Count == 3 && batches[0].Length == 130 && batches.Skip(1).All(batch => batch.Length == 1), "exclusive installation isolated from normal and other exclusive updates");
        var interactive = new NativeWindowsUpdates.UpdatePolicy(Guid.NewGuid(), true, false); catalog.Add(interactive);
        Refused(() => NativeWindowsUpdates.PlanBatches(catalog, null), "interaction preflight fails entire all before mutation");
        NativeWindowsUpdates.PlanBatches(catalog, selection);
        Refused(() => NativeWindowsUpdates.PlanBatches(catalog, new HashSet<Guid> { Guid.NewGuid() }), "missing selected update");
        Refused(() => NativeWindowsUpdates.PlanBatches([exclusive, exclusive], null), "ambiguous catalog identity");
    }
}
