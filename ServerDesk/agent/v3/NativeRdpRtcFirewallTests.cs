using System.Runtime.InteropServices;

namespace ServerDesk.Agent;

internal static class NativeRdpRtcFirewallTests
{
    private const string Id = "8753ef53-e23a-4c16-b862-e0f7e51dc4b4";
    internal static void Run()
    {
        string root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "serverdesk-firewall-fixture"));
        string executable = Path.Combine(root, "current", "ServerDesk.Agent.exe");
        var rule = NativeRdpRtcFirewall.Definition(root, executable, Id, 49173, 173, 982451653);
        Require(rule.Application == executable && rule.LocalPorts == "49173" && rule.Protocol == 17 && rule.Direction == 1 && rule.Action == 1 && rule.Profiles == 7 && !rule.EdgeTraversal, "Firewall scope did not bind the installed process and its one UDP socket.");
        Reject(() => NativeRdpRtcFirewall.Definition(root, Path.Combine(root, "stage", "ServerDesk.Agent.exe"), Id, 49173, 173, 982451653), "Stage/updater executable received a socket exception.");
        Reject(() => NativeRdpRtcFirewall.Definition(root, "ServerDesk.Agent.exe", Id, 49173, 173, 982451653), "Relative executable received a socket exception.");
        Reject(() => NativeRdpRtcFirewall.Definition(root, executable, Id.ToUpperInvariant(), 49173, 173, 982451653), "Noncanonical session identity received a socket exception.");
        Reject(() => NativeRdpRtcFirewall.Definition(root, executable, Id, 0, 173, 982451653), "Invalid UDP socket received a firewall exception.");
        PolicyAndLifetime(rule);
        CancellationAndRevocation(rule);
        OwnershipAndCrashCleanup(rule);
        LocalStoreProof(rule);
        SerializedWindowsLifecycle(rule);
        Console.WriteLine("Native RTC socket firewall tests passed: scoped installed executable/UDP port, COM policy states 0/1/2, ignored/disabled policy fallback, revocation/cancellation rollback, collision protection, Windows repeated-profile serialization, normalized COM ownership, stale-owner cleanup and nonthrowing retirement.");
    }

    private static void PolicyAndLifetime(RdpRtcFirewallRule rule)
    {
        foreach (int state in new[] { 0, 1, 2 })
        {
            var store = new Store { Policy = new(3, 3, 0, state) }; int checks = 0;
            var lease = NativeRdpRtcFirewall.Acquire(rule, () => store, CancellationToken.None, () => checks++, _ => { }, (_, _) => true);
            Require(store.Adds == 1 && checks == 3 && store.Rules.SequenceEqual([rule]), "Authorization or COM policy state skipped narrow socket rule creation.");
            Require(lease.Diagnostic.Contains(state == 0 ? "local-rules-allowed" : state == 1 ? "gpo-override" : "inbound-blocked"), "COM policy state lost its diagnostic.");
            lease.Dispose(); lease.Dispose();
            Require(store.Removes == 1 && store.Rules.Count == 0, "Socket lease removal was lost or repeated.");
        }
        Require(NativeRdpRtcFirewall.PolicyDiagnostic(new(1, 1, 2, 0)) == "policy=local-rules-allowed", "Inactive profile shields-up blocked the active profile.");
        Require(NativeRdpRtcFirewall.PolicyDiagnostic(new(3, 1, 2, 0)) == "policy=local-rules-allowed", "Disabled profile shields-up blocked an enabled profile.");
        Require(NativeRdpRtcFirewall.PolicyDiagnostic(new(3, 1, 1, 0)) == "policy=inbound-blocked", "Enabled active shields-up lost its diagnostic.");
        foreach (var policy in new[] { new RdpRtcFirewallPolicy(1, 0, 0, 0), new(1, 1, 0, 1), new(1, 1, 0, 2) })
        {
            var store = new Store { Policy = policy, AddError = new COMException("private diagnostic that must not escape", unchecked((int)0x80070005)) };
            var logs = new List<string>();
            using var lease = NativeRdpRtcFirewall.Acquire(rule, () => store, CancellationToken.None, () => { }, logs.Add, (_, _) => true);
            Require(store.Removes == 0 && lease.Diagnostic.StartsWith("unavailable;policy=", StringComparison.Ordinal) && logs.Count == 1 && !logs[0].Contains("private"), "Disabled/ignored local policy broke an existing solicited path or leaked exception text.");
        }
        var failed = new Store { AddError = new COMException("sensitive diagnostic", unchecked((int)0x80070005)) };
        try { NativeRdpRtcFirewall.Acquire(rule, () => failed, CancellationToken.None, () => { }, _ => { }, (_, _) => true); throw new Exception("Required socket rule failure was ignored."); }
        catch (InvalidOperationException e) { Require(e.Message.Contains("UDP socket firewall") && e.Message.Contains("80070005") && !e.Message.Contains("sensitive"), "Socket rule creation failed without a meaningful safe diagnostic."); }
    }

    private static void CancellationAndRevocation(RdpRtcFirewallRule rule)
    {
        using var cancel = new CancellationTokenSource();
        var cancelled = new Store { AfterAdd = cancel.Cancel };
        try { NativeRdpRtcFirewall.Acquire(rule, () => cancelled, cancel.Token, () => { }, _ => { }, (_, _) => true); throw new Exception("Cancelled acquisition completed."); }
        catch (OperationCanceledException) { }
        Require(cancelled.Adds == 1 && cancelled.Removes == 1 && cancelled.Rules.Count == 0, "Cancellation left the UDP exception behind.");
        var revoked = new Store(); int checks = 0;
        Reject(() => NativeRdpRtcFirewall.Acquire(rule, () => revoked, CancellationToken.None, () => { if (++checks == 3) throw new InvalidOperationException("Management revoked"); }, _ => { }, (_, _) => true), "Management revocation after creation was ignored.");
        Require(revoked.Removes == 1 && revoked.Rules.Count == 0, "Local authorization revocation left the UDP exception behind.");
        var partial = new Store { AddError = new COMException("committed before error"), CommitBeforeError = true };
        Reject(() => NativeRdpRtcFirewall.Acquire(rule, () => partial, CancellationToken.None, () => { }, _ => { }, (_, _) => true), "Partial COM failure was ignored.");
        Require(partial.Removes == 1 && partial.Rules.Count == 0, "A COM failure after commit leaked its owned socket rule.");
    }

    private static void OwnershipAndCrashCleanup(RdpRtcFirewallRule rule)
    {
        var dead = new Store(); dead.Rules.Add(rule);
        NativeRdpRtcFirewall.CleanupStale(dead, rule.Application, (_, _) => false, _ => { });
        Require(dead.Removes == 1 && dead.Rules.Count == 0, "A crashed owner's exact socket exception was not cleaned up.");
        var live = new Store(); live.Rules.Add(rule);
        NativeRdpRtcFirewall.CleanupStale(live, rule.Application, (_, _) => true, _ => { });
        Require(live.Removes == 0, "Another live agent's socket exception was removed.");
        foreach (var changed in new[] { rule with { Application = rule.Application + ".old" }, rule with { Grouping = "Administrator" }, rule with { Description = "ServerDesk RTC socket v1;pid=173;started=0" }, rule with { Protocol = 6 }, rule with { LocalPorts = "49173-49174" }, rule with { Profiles = 1 }, rule with { EdgeTraversal = true } })
        {
            var unrelated = new Store(); unrelated.Rules.Add(changed);
            NativeRdpRtcFirewall.CleanupStale(unrelated, rule.Application, (_, _) => false, _ => { });
            Require(unrelated.Removes == 0, "Cleanup removed a changed or unrelated firewall rule.");
        }
        var duplicate = new Store(); duplicate.Rules.Add(rule); duplicate.Rules.Add(rule);
        NativeRdpRtcFirewall.CleanupStale(duplicate, rule.Application, (_, _) => false, _ => { });
        Require(duplicate.Removes == 0, "Cleanup removed an ambiguous display-name collision.");
        Reject(() => NativeRdpRtcFirewall.Acquire(rule, () => duplicate, CancellationToken.None, () => { }, _ => { }, (_, _) => true), "A colliding firewall name was overwritten.");
        Require(duplicate.Adds == 0, "A display-name collision mutated firewall policy.");
        var managed = new Store { IsLocal = false }; managed.Rules.Add(rule);
        NativeRdpRtcFirewall.CleanupStale(managed, rule.Application, (_, _) => false, _ => { });
        Require(managed.Removes == 0, "A domain-managed rule without local-store proof was removed.");
        var failedRemoval = new Store { RemoveError = new COMException("private path and credentials") }; var logs = new List<string>();
        var lease = NativeRdpRtcFirewall.Acquire(rule, () => failedRemoval, CancellationToken.None, () => { }, logs.Add, (_, _) => true);
        lease.Dispose();
        Require(logs.Count == 1 && logs[0].Length < 180 && !logs[0].Contains("private") && failedRemoval.Rules.Count == 1, "Cleanup failure escaped retirement, leaked data or lost stale ownership.");
    }

    private static void LocalStoreProof(RdpRtcFirewallRule rule)
    {
        string value = WindowsValue(rule);
        Require(WindowsRdpRtcFirewallStore.LocalValueMatches(value, rule), "Exact local persistent ownership proof was rejected.");
        Require(WindowsRdpRtcFirewallStore.LocalValueMatches(value.Replace("Profile=Domain|Profile=Private|Profile=Public|", ""), rule), "Omitted Profile=ALL ownership proof was rejected.");
        Require(WindowsRdpRtcFirewallStore.LocalValueMatches(value + "Profile=Domain|", rule), "Repeated Profile union was rejected.");
        Require(WindowsRdpRtcFirewallStore.LocalValueMatches(value + "Edge=FALSE|", rule), "Explicit disabled edge traversal was rejected.");
        foreach (string changed in new[] { value.Replace("Protocol=17", "Protocol=6"), value.Replace("App=" + rule.Application, "App=" + rule.Application + ".old"), value.Replace("Desc=" + rule.Description, "Desc=Administrator"), value + "Name=other|", value.Replace("Active=TRUE", "Active=FALSE"), value.Replace("Profile=Domain|", ""), value + "Profile=Unknown|", value.Replace("LPort=" + rule.LocalPorts, "LPort=" + rule.LocalPorts + ",49174"), value + "LPort2_10=1-65535|", value + "LPort2_20=RPC|", value.Replace("EmbedCtxt=" + rule.Grouping, "EmbedCtxt=Administrator"), value + "Edge=TRUE|", value + "Defer=App|" })
            Require(!WindowsRdpRtcFirewallStore.LocalValueMatches(changed, rule), "Forged or changed local persistent ownership proof was accepted.");
        foreach (string repeated in new[] { "Name=" + rule.Name, "Desc=" + rule.Description, "App=" + rule.Application, "Protocol=17", "LPort=" + rule.LocalPorts, "Dir=In", "Action=Allow", "Active=TRUE", "EmbedCtxt=" + rule.Grouping })
            Require(!WindowsRdpRtcFirewallStore.LocalValueMatches(value + repeated + "|", rule), "Duplicate singleton ownership field was accepted.");
    }

    private static string WindowsValue(RdpRtcFirewallRule rule) => $"v2.32|Action=Allow|Active=TRUE|Dir=In|Profile=Domain|Profile=Private|Profile=Public|Protocol=17|LPort={rule.LocalPorts}|App={rule.Application}|Name={rule.Name}|Desc={rule.Description}|EmbedCtxt={rule.Grouping}|";
    private static void SerializedWindowsLifecycle(RdpRtcFirewallRule rule)
    {
        var normalized = rule with { Application = rule.Application.ToUpperInvariant(), Profiles = int.MaxValue };
        var store = new Store { Serialize = WindowsValue, NormalizeAdded = _ => normalized };
        var lease = NativeRdpRtcFirewall.Acquire(rule, () => store, CancellationToken.None, () => { }, _ => { }, (_, _) => true);
        Require(store.Adds == 1 && store.Rules.Single() == normalized, "Actual Windows repeated Profile serialization or COM normalization failed acquisition.");
        lease.Dispose();
        Require(store.Removes == 1 && store.Rules.Count == 0, "Normalized Windows ownership failed lease removal.");

        int checks = 0; var revoked = new Store { Serialize = WindowsValue, NormalizeAdded = _ => normalized };
        Reject(() => NativeRdpRtcFirewall.Acquire(rule, () => revoked, CancellationToken.None, () => { if (++checks == 3) throw new InvalidOperationException("Management revoked"); }, _ => { }, (_, _) => true), "Serialized Windows acquisition ignored revocation.");
        Require(revoked.Removes == 1 && revoked.Rules.Count == 0, "Revocation left a Windows three-profile socket rule behind.");
        using var cancel = new CancellationTokenSource(); var cancelled = new Store { Serialize = WindowsValue, AfterAdd = cancel.Cancel };
        try { NativeRdpRtcFirewall.Acquire(rule, () => cancelled, cancel.Token, () => { }, _ => { }, (_, _) => true); throw new Exception("Serialized Windows acquisition ignored cancellation."); } catch (OperationCanceledException) { }
        Require(cancelled.Removes == 1 && cancelled.Rules.Count == 0, "Cancellation left a Windows three-profile socket rule behind.");

        var stale = new Store { Serialize = WindowsValue }; stale.Rules.Add(normalized);
        NativeRdpRtcFirewall.CleanupStale(stale, rule.Application, (_, _) => false, _ => { });
        Require(stale.Removes == 1 && stale.Rules.Count == 0, "A dead owner's normalized Windows three-profile rule was not cleaned up.");
        foreach (var changed in new[] { normalized with { Profiles = 1 }, normalized with { Profiles = 15 }, normalized with { Application = normalized.Application + ".old" }, normalized with { LocalPorts = "49173,49174" }, normalized with { Grouping = "Administrator" }, normalized with { EdgeTraversal = true } })
        {
            var altered = new Store { Serialize = WindowsValue }; altered.Rules.Add(changed);
            NativeRdpRtcFirewall.CleanupStale(altered, rule.Application, (_, _) => false, _ => { });
            Require(altered.Removes == 0, "Normalization removed a changed or broader rule.");
        }
        var managed = new Store { Serialize = WindowsValue, IsLocal = false }; managed.Rules.Add(normalized);
        NativeRdpRtcFirewall.CleanupStale(managed, rule.Application, (_, _) => false, _ => { });
        Require(managed.Removes == 0, "Serialized identity bypassed the local-store/GPO guard.");

        var malformed = new Store { Serialize = value => WindowsValue(value) + "App=" + value.Application + "|" };
        try { NativeRdpRtcFirewall.Acquire(rule, () => malformed, CancellationToken.None, () => { }, _ => { }, (_, _) => true); throw new Exception("Duplicate serialized identity passed acquisition."); }
        catch (InvalidOperationException e) { Require(e.Message.Contains("local-store-count=0") && !e.Message.Contains(rule.Application) && !e.Message.Contains(rule.Name), "Ownership mismatch stage was missing or exposed rule identity."); }
        NativeRdpRtcFirewall.CleanupStale(malformed, rule.Application, (_, _) => false, _ => { });
        Require(malformed.Removes == 0 && malformed.Rules.Count == 1, "Malformed persistent proof allowed deletion.");
    }

    private sealed class Store : IRdpRtcFirewallStore
    {
        internal readonly List<RdpRtcFirewallRule> Rules = [];
        internal RdpRtcFirewallPolicy Policy = new(1, 1, 0, 0);
        internal int Adds, Removes;
        internal bool IsLocal = true, CommitBeforeError;
        internal Exception? AddError, RemoveError;
        internal Action? AfterAdd;
        internal Func<RdpRtcFirewallRule, string>? Serialize;
        internal Func<RdpRtcFirewallRule, RdpRtcFirewallRule>? NormalizeAdded;
        public RdpRtcFirewallPolicy ReadPolicy() => Policy;
        public IReadOnlyList<RdpRtcFirewallRule> ReadRules() => Rules.ToArray();
        public int LocalOwnedRuleCount(RdpRtcFirewallRule expected) => IsLocal ? Rules.Count(r => Serialize is null ? r == expected : WindowsRdpRtcFirewallStore.LocalValueMatches(Serialize(r), expected)) : 0;
        public void Add(RdpRtcFirewallRule rule)
        {
            Adds++; if (AddError is null || CommitBeforeError) Rules.Add(NormalizeAdded?.Invoke(rule) ?? rule);
            AfterAdd?.Invoke(); if (AddError is not null) throw AddError;
        }
        public void Remove(string name)
        {
            Removes++; if (RemoveError is not null) throw RemoveError;
            Rules.RemoveAll(r => r.Name == name);
        }
        public void Dispose() { }
    }
    private static void Require(bool okay, string message) { if (!okay) throw new Exception(message); }
    private static void Reject(Action action, string message)
    { try { action(); } catch (InvalidOperationException) { return; } throw new Exception(message); }
}
