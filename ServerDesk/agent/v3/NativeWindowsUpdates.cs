using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// Windows Update Agent COM uses the machine's existing Windows Update/WSUS
// policy. It neither opts the device into Microsoft Update nor reboots it.
internal static class NativeWindowsUpdates
{
    private sealed class Search : IDisposable
    {
        internal readonly object Session, Searcher, Result, Updates;
        internal Search()
        {
            Session = NativeManagement.CreateCom("Microsoft.Update.Session");
            try
            {
                dynamic session = Session; session.ClientApplicationID = "ServerDesk native .NET 10";
                Searcher = session.CreateUpdateSearcher(); dynamic searcher = Searcher;
                Result = searcher.Search("IsInstalled=0 and IsHidden=0 and Type='Software'"); dynamic result = Result;
                if ((int)result.ResultCode != 2) throw new AgentMessageException("AGENT_UPDATE_SEARCH_INCOMPLETE", ("resultCode", (int)result.ResultCode));
                Updates = result.Updates;
            }
            catch { NativeManagement.ReleaseCom(Updates); NativeManagement.ReleaseCom(Result); NativeManagement.ReleaseCom(Searcher); NativeManagement.ReleaseCom(Session); throw; }
        }
        public void Dispose() { NativeManagement.ReleaseCom(Updates); NativeManagement.ReleaseCom(Result); NativeManagement.ReleaseCom(Searcher); NativeManagement.ReleaseCom(Session); }
    }
    internal static AgentMessage Scan(string root, CancellationToken token)
    {
        token.ThrowIfCancellationRequested(); using var search = new Search(); token.ThrowIfCancellationRequested(); SaveInventory(root, search); dynamic updates = search.Updates;
        return AgentMessages.Of("AGENT_UPDATE_SCAN_DONE", ("count", (int)updates.Count));
    }
    private static void SaveInventory(string root, Search search)
    {
        dynamic updates = search.Updates; var items = new JsonArray();
        for (int i = 0; i < Math.Min((int)updates.Count, 100); i++)
        {
            object? updateObject = null, identityObject = null, kbObject = null;
            try
            {
                dynamic update = updateObject = updates.Item(i); dynamic identity = identityObject = update.Identity; dynamic kb = kbObject = update.KBArticleIDs;
                var articles = new List<string>(); for (int k = 0; k < (int)kb.Count; k++) articles.Add((string)kb.Item(k));
                items.Add(new JsonObject { ["id"] = (string)identity.UpdateID, ["title"] = (string?)update.Title ?? "", ["kb"] = string.Join(',', articles), ["severity"] = (string?)update.MsrcSeverity ?? "", ["rebootRequired"] = (bool)update.RebootRequired });
            }
            finally { NativeManagement.ReleaseCom(kbObject); NativeManagement.ReleaseCom(identityObject); NativeManagement.ReleaseCom(updateObject); }
        }
        LocalStore.Json(Path.Combine(root, "updates.json"), new JsonObject { ["checkedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["pendingCount"] = (int)updates.Count, ["items"] = items });
    }
    internal sealed record UpdatePolicy(Guid Id, bool RequiresInteraction, bool Exclusive);
    internal static void ValidateInstall(JsonObject p)
    {
        bool all = p["all"] is JsonValue value && value.TryGetValue<bool>(out bool flag) && flag;
        if (all)
        {
            if (p.Count != 1) throw new AgentMessageException("AGENT_UPDATES_ALL_AND_IDS");
            return;
        }
        if (p.Count != 1 || !p.ContainsKey("updateIds")) throw new AgentMessageException("AGENT_UPDATES_IDS_REQUIRED");
        var ids = NativeManagement.StringArray(p, "updateIds", 1, 50);
        if (ids.Any(id => !Guid.TryParseExact(id, "D", out _)) || ids.Select(Guid.Parse).Distinct().Count() != ids.Length) throw new AgentMessageException("AGENT_UPDATES_INVALID_ID");
    }
    // The installer uses the full fresh search, never the 100-row UI inventory.
    // Exclusive WUA updates must be installed alone (InstallationImpact=2).
    internal static IReadOnlyList<Guid[]> PlanBatches(IReadOnlyList<UpdatePolicy> catalog, HashSet<Guid>? selected)
    {
        if (catalog.Select(item => item.Id).Distinct().Count() != catalog.Count) throw new AgentMessageException("AGENT_UPDATES_AMBIGUOUS_IDS");
        var chosen = catalog.Where(item => selected is null || selected.Contains(item.Id)).ToArray();
        if (selected is not null && chosen.Length != selected.Count) throw new AgentMessageException("AGENT_UPDATES_SELECTION_GONE");
        if (chosen.Any(item => item.RequiresInteraction)) throw new AgentMessageException("AGENT_UPDATES_INTERACTIVE");
        var batches = new List<Guid[]>(); var standard = chosen.Where(item => !item.Exclusive).Select(item => item.Id).ToArray();
        if (standard.Length > 0) batches.Add(standard);
        batches.AddRange(chosen.Where(item => item.Exclusive).Select(item => new[] { item.Id })); return batches;
    }
    internal static AgentMessage Install(string root, JsonObject config, JsonObject p, CancellationToken token)
    {
        ValidateInstall(p); bool all = p["all"] is JsonValue value && value.TryGetValue<bool>(out bool flag) && flag;
        HashSet<Guid>? ids = all ? null : NativeManagement.StringArray(p, "updateIds", 1, 50).Select(Guid.Parse).ToHashSet();
        token.ThrowIfCancellationRequested(); using var search = new Search(); SaveInventory(root, search);
        var retained = new Dictionary<Guid, object>(); var catalog = new List<UpdatePolicy>(); int completed = 0; bool rebootRequired = false, attempted = false;
        AgentMessage Summary() => AgentMessages.Of(rebootRequired ? "AGENT_UPDATES_INSTALLED" : "AGENT_UPDATES_INSTALLED_NO_RESTART", ("count", completed));
        try
        {
            dynamic available = search.Updates;
            for (int i = 0; i < (int)available.Count; i++)
            {
                token.ThrowIfCancellationRequested(); object? updateObject = null, identityObject = null, behaviorObject = null;
                try
                {
                    dynamic update = updateObject = available.Item(i); dynamic identity = identityObject = update.Identity;
                    if (!Guid.TryParse((string)identity.UpdateID, out Guid id)) throw new AgentMessageException("AGENT_UPDATES_INVALID_WINDOWS_ID");
                    if (ids is not null && !ids.Contains(id)) continue;
                    dynamic behavior = behaviorObject = update.InstallationBehavior;
                    catalog.Add(new(id, (bool)behavior.CanRequestUserInput, (int)behavior.Impact == 2));
                    if (!retained.TryAdd(id, updateObject)) throw new AgentMessageException("AGENT_UPDATES_DUPLICATE_WINDOWS_ID");
                    updateObject = null;
                }
                finally { NativeManagement.ReleaseCom(behaviorObject); NativeManagement.ReleaseCom(identityObject); NativeManagement.ReleaseCom(updateObject); }
            }
            var batches = PlanBatches(catalog, ids);
            if (batches.Count == 0) return AgentMessages.Of("AGENT_UPDATES_NONE");
            // Validate the entire selection before accepting licences or starting
            // downloads. Each mutation rechecks the protected local opt-in.
            NativeManagement.AssertManagement(root, new JsonObject()); token.ThrowIfCancellationRequested();
            foreach (object item in retained.Values)
            {
                dynamic update = item;
                NativeManagement.AssertManagement(root, new JsonObject()); token.ThrowIfCancellationRequested();
                if (!(bool)update.EulaAccepted) update.AcceptEula();
            }
            foreach (var batch in batches)
            {
                object? collectionObject = null, downloaderObject = null, downloadObject = null, installerObject = null, installationObject = null;
                try
                {
                    dynamic collection = collectionObject = NativeManagement.CreateCom("Microsoft.Update.UpdateColl");
                    foreach (Guid id in batch) collection.Add(retained[id]);
                    dynamic session = search.Session; dynamic installer = installerObject = session.CreateUpdateInstaller(); installer.Updates = collection; installer.ForceQuiet = true; installer.AllowSourcePrompts = false;
                    if ((bool)installer.IsBusy) throw new AgentMessageException("AGENT_UPDATES_INSTALLER_BUSY");
                    if ((bool)installer.RebootRequiredBeforeInstallation) { rebootRequired = true; throw new AgentMessageException("AGENT_UPDATES_REBOOT_FIRST"); }
                    NativeManagement.AssertManagement(root, new JsonObject()); token.ThrowIfCancellationRequested();
                    dynamic downloader = downloaderObject = session.CreateUpdateDownloader(); downloader.Updates = collection;
                    dynamic download = downloadObject = downloader.Download();
                    if ((int)download.ResultCode != 2) throw new AgentMessageException("AGENT_UPDATES_DOWNLOAD_INCOMPLETE", ("resultCode", (int)download.ResultCode));
                    NativeManagement.AssertManagement(root, new JsonObject()); token.ThrowIfCancellationRequested(); attempted = true;
                    dynamic installed = installationObject = installer.Install(); rebootRequired |= (bool)installed.RebootRequired;
                    for (int i = 0; i < batch.Length; i++)
                    {
                        object? updateResult = null;
                        try { dynamic single = updateResult = installed.GetUpdateResult(i); if ((int)single.ResultCode == 2) completed++; }
                        finally { NativeManagement.ReleaseCom(updateResult); }
                    }
                    if ((int)installed.ResultCode != 2) throw new AgentMessageException("AGENT_UPDATES_RESULT", ("resultCode", (int)installed.ResultCode));
                }
                finally { NativeManagement.ReleaseCom(installationObject); NativeManagement.ReleaseCom(installerObject); NativeManagement.ReleaseCom(downloadObject); NativeManagement.ReleaseCom(downloaderObject); NativeManagement.ReleaseCom(collectionObject); }
            }
            return Summary();
        }
        catch (Exception e) when (attempted)
        {
            throw new AgentMessageException(e, rebootRequired ? "AGENT_UPDATES_PARTIAL" : "AGENT_UPDATES_PARTIAL_NO_RESTART", ("count", completed), ("detail", e.Message));
        }
        finally
        {
            foreach (object update in retained.Values) NativeManagement.ReleaseCom(update);
            // A refresh failure must never convert an applied update into a
            // reported retryable failure. Successful and partial installs both
            // refresh their inventory independently of the job result.
            if (attempted && !token.IsCancellationRequested) try { using var fresh = new Search(); SaveInventory(root, fresh); } catch (Exception e) { LocalStore.Log(root, "Windows Update inventory refresh after installation failed: " + e.Message); }
        }
    }
}
