using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using Microsoft.Win32;

namespace ServerDesk.Agent;

// Only the installed agent's one ICE/DTLS/SCTP UDP socket is exposed. Windows
// policy, explicit block rules and edge traversal remain authoritative.
internal sealed class NativeRdpRtcFirewall : IDisposable
{
    internal const string NamePrefix = "ServerDesk RTC ", Group = "ServerDesk direct Remote Desktop", Marker = "ServerDesk RTC socket v1";
    private static readonly object Gate = new();
    private readonly RdpRtcFirewallRule? rule;
    private readonly Func<IRdpRtcFirewallStore> open;
    private readonly Action<string> log;
    private int disposed;
    internal string Diagnostic { get; }

    private NativeRdpRtcFirewall(RdpRtcFirewallRule? rule, Func<IRdpRtcFirewallStore> open, Action<string> log, string diagnostic)
    { this.rule = rule; this.open = open; this.log = log; Diagnostic = diagnostic; }

    internal static NativeRdpRtcFirewall Acquire(string root, string id, int port, CancellationToken token, Action assertAllowed, Action<string> log)
    {
        if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("Direct Remote Desktop socket firewall setup requires Windows.");
        using var process = Process.GetCurrentProcess();
        var rule = Definition(root, Environment.ProcessPath ?? "", id, port, process.Id, process.StartTime.ToUniversalTime().Ticks);
        try { return Acquire(rule, () => new WindowsRdpRtcFirewallStore(), token, assertAllowed, log, OwnerMayBeAlive); }
        catch (Exception e) when (e is not OperationCanceledException and not InvalidOperationException)
        { throw new InvalidOperationException("Direct Remote Desktop UDP socket firewall setup failed (" + ExceptionCode(e) + "). Check the Windows Firewall service and local permissions."); }
    }

    internal static void CleanupAtStartup(string root, Action<string> log)
    {
        if (!OperatingSystem.IsWindows()) return;
        try
        {
            using var process = Process.GetCurrentProcess();
            var identity = Definition(root, Environment.ProcessPath ?? "", Guid.Empty.ToString("D"), 1, process.Id, process.StartTime.ToUniversalTime().Ticks);
            lock (Gate) { using var store = new WindowsRdpRtcFirewallStore(); CleanupStale(store, identity.Application, OwnerMayBeAlive, log); }
        }
        catch (Exception e) { Log(log, "Remote Desktop socket firewall startup cleanup deferred; " + ExceptionCode(e)); }
    }

    internal static RdpRtcFirewallRule Definition(string root, string executable, string id, int port, int pid, long started)
    {
        if (!Guid.TryParseExact(id, "D", out Guid parsed) || id != parsed.ToString("D") || port is < 1 or > 65535 || pid < 1 || started < 1)
            throw new InvalidOperationException("Invalid direct Remote Desktop socket firewall authorization.");
        string installed = Path.GetFullPath(Path.Combine(root, "current", "ServerDesk.Agent.exe"));
        if (!Path.IsPathFullyQualified(executable) || !string.Equals(Path.GetFullPath(executable), installed, StringComparison.OrdinalIgnoreCase) || installed.Any(c => c < 32 || c == '|'))
            throw new InvalidOperationException("Direct Remote Desktop socket firewall setup requires the installed agent executable.");
        return new(NamePrefix + id, $"{Marker};pid={pid};started={started}", Group, installed, port.ToString(CultureInfo.InvariantCulture), 17, 1, 1, 7, true, false);
    }

    // The injectable store verifies lifecycle and policy behavior without
    // changing the build host's firewall.
    internal static NativeRdpRtcFirewall Acquire(RdpRtcFirewallRule rule, Func<IRdpRtcFirewallStore> open, CancellationToken token, Action assertAllowed, Action<string> log, Func<int, long, bool> ownerMayBeAlive)
    {
        token.ThrowIfCancellationRequested(); assertAllowed();
        lock (Gate)
        {
            using var store = open();
            var policy = store.ReadPolicy();
            string diagnostic = PolicyDiagnostic(policy);
            CleanupStale(store, rule.Application, ownerMayBeAlive, log);
            token.ThrowIfCancellationRequested(); assertAllowed();
            if (store.ReadRules().Any(r => SameName(r, rule))) throw new InvalidOperationException("Direct Remote Desktop socket firewall rule name is already in use. End the earlier session first.");
            bool added = false;
            try
            {
                store.Add(rule); added = true;
                if (!CanRemove(store, rule, out string ownership)) throw new InvalidOperationException("Direct Remote Desktop socket firewall ownership could not be verified (" + ownership + ").");
                token.ThrowIfCancellationRequested(); assertAllowed();
                return new(rule, open, log, "local-rule;" + diagnostic);
            }
            catch (Exception e)
            {
                // Add can throw after committing. Always inspect ownership
                // before removing, including on cancellation or revocation.
                RemoveOwned(store, rule, log);
                if (e is OperationCanceledException) throw;
                if (added || e is InvalidOperationException) throw;
                // A local exception cannot help when policy ignores it, and a
                // disabled firewall needs no exception. Keep solicited ICE or
                // an existing domain-managed allow path available.
                if (!policy.LocalRuleCanMatter)
                {
                    Log(log, "Remote Desktop socket firewall rule unavailable; " + diagnostic + "; " + ExceptionCode(e));
                    return new(null, open, log, "unavailable;" + diagnostic);
                }
                throw new InvalidOperationException("Direct Remote Desktop UDP socket firewall rule could not be created (" + ExceptionCode(e) + "). Check the Windows Firewall service and local permissions.");
            }
        }
    }

    internal static string PolicyDiagnostic(RdpRtcFirewallPolicy policy)
    {
        if ((policy.ActiveProfiles & ~7) != 0 || policy.ModifyState is < 0 or > 2) throw new InvalidOperationException("Direct Remote Desktop firewall policy returned an unsupported state.");
        int enabled = policy.ActiveProfiles & policy.LocallyEnabledProfiles & 7;
        string state = enabled == 0 ? "locally-disabled" : (policy.ActiveProfiles & policy.BlockedInboundProfiles & enabled) != 0 || policy.ModifyState == 2 ? "inbound-blocked" : policy.ModifyState == 1 ? "gpo-override" : "local-rules-allowed";
        return "policy=" + state;
    }

    internal static void CleanupStale(IRdpRtcFirewallStore store, string executable, Func<int, long, bool> ownerMayBeAlive, Action<string> log)
    {
        foreach (var candidate in store.ReadRules())
        {
            if (!OwnedShape(candidate, executable) || !TryOwner(candidate.Description, out int pid, out long started) || ownerMayBeAlive(pid, started)) continue;
            RemoveOwned(store, candidate, log);
        }
    }

    internal static bool OwnedShape(RdpRtcFirewallRule rule, string executable)
    {
        string id = rule.Name.StartsWith(NamePrefix, StringComparison.Ordinal) ? rule.Name[NamePrefix.Length..] : "";
        return Guid.TryParseExact(id, "D", out Guid parsed) && id == parsed.ToString("D") && rule.Grouping == Group && TryOwner(rule.Description, out _, out _)
            && string.Equals(rule.Application, executable, StringComparison.OrdinalIgnoreCase) && int.TryParse(rule.LocalPorts, NumberStyles.None, CultureInfo.InvariantCulture, out int port) && port is >= 1 and <= 65535 && rule.LocalPorts == port.ToString(CultureInfo.InvariantCulture)
            && rule.Protocol == 17 && rule.Direction == 1 && rule.Action == 1 && AllProfiles(rule.Profiles) && rule.Enabled && !rule.EdgeTraversal;
    }
    private static bool TryOwner(string description, out int pid, out long started)
    {
        pid = 0; started = 0; var fields = description.Split(';');
        return fields.Length == 3 && fields[0] == Marker && fields[1].StartsWith("pid=", StringComparison.Ordinal) && fields[2].StartsWith("started=", StringComparison.Ordinal)
            && int.TryParse(fields[1][4..], NumberStyles.None, CultureInfo.InvariantCulture, out pid) && pid > 0
            && long.TryParse(fields[2][8..], NumberStyles.None, CultureInfo.InvariantCulture, out started) && started > 0
            && description == $"{Marker};pid={pid};started={started}";
    }
    private static bool OwnerMayBeAlive(int pid, long started)
    {
        try { using var process = Process.GetProcessById(pid); return process.StartTime.ToUniversalTime().Ticks == started; }
        catch (ArgumentException) { return false; }
        catch { return true; } // Unknown ownership must never be deleted.
    }
    private static bool SameName(RdpRtcFirewallRule a, RdpRtcFirewallRule b) => string.Equals(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
    internal static bool AllProfiles(int profiles) => profiles is 7 or int.MaxValue;
    private static bool EquivalentOwnedRule(RdpRtcFirewallRule actual, RdpRtcFirewallRule expected) => actual.Name == expected.Name && actual.Description == expected.Description && actual.Grouping == expected.Grouping
        && string.Equals(actual.Application, expected.Application, StringComparison.OrdinalIgnoreCase) && actual.LocalPorts == expected.LocalPorts
        && actual.Protocol == expected.Protocol && actual.Direction == expected.Direction && actual.Action == expected.Action && AllProfiles(actual.Profiles) && AllProfiles(expected.Profiles)
        && actual.Enabled == expected.Enabled && actual.EdgeTraversal == expected.EdgeTraversal;
    private static bool CanRemove(IRdpRtcFirewallStore store, RdpRtcFirewallRule expected, out string diagnostic)
    {
        var matches = store.ReadRules().Where(r => SameName(r, expected)).ToArray();
        diagnostic = "com-name-count=" + (matches.Length > 1 ? "2+" : matches.Length.ToString(CultureInfo.InvariantCulture));
        if (matches.Length != 1) return false;
        diagnostic = "com-rule-mismatch";
        if (!EquivalentOwnedRule(matches[0], expected)) return false;
        diagnostic = "owned-scope-mismatch";
        if (!OwnedShape(expected, expected.Application)) return false;
        int local = store.LocalOwnedRuleCount(expected);
        diagnostic = "local-store-count=" + (local > 1 ? "2+" : Math.Max(0, local).ToString(CultureInfo.InvariantCulture));
        return local == 1;
    }
    private static void RemoveOwned(IRdpRtcFirewallStore store, RdpRtcFirewallRule expected, Action<string> log)
    {
        try { if (CanRemove(store, expected, out _)) store.Remove(expected.Name); }
        catch (Exception e) { Log(log, "Remote Desktop socket firewall cleanup deferred; " + ExceptionCode(e)); }
    }
    private static string ExceptionCode(Exception e) => e.GetType().Name + "/0x" + e.HResult.ToString("X8", CultureInfo.InvariantCulture);
    private static void Log(Action<string> log, string message) { try { log(message); } catch { } }
    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0 || rule is null) return;
        try { lock (Gate) { using var store = open(); RemoveOwned(store, rule, log); } }
        catch (Exception e) { Log(log, "Remote Desktop socket firewall cleanup deferred; " + ExceptionCode(e)); }
    }
}

internal sealed record RdpRtcFirewallRule(string Name, string Description, string Grouping, string Application, string LocalPorts, int Protocol, int Direction, int Action, int Profiles, bool Enabled, bool EdgeTraversal);
internal sealed record RdpRtcFirewallPolicy(int ActiveProfiles, int LocallyEnabledProfiles, int BlockedInboundProfiles, int ModifyState)
{
    internal bool LocalRuleCanMatter => (ActiveProfiles & LocallyEnabledProfiles & ~BlockedInboundProfiles & 7) != 0 && ModifyState == 0;
}
internal interface IRdpRtcFirewallStore : IDisposable
{
    RdpRtcFirewallPolicy ReadPolicy();
    IReadOnlyList<RdpRtcFirewallRule> ReadRules();
    int LocalOwnedRuleCount(RdpRtcFirewallRule expected);
    void Add(RdpRtcFirewallRule rule);
    void Remove(string name);
}

internal sealed class WindowsRdpRtcFirewallStore : IRdpRtcFirewallStore
{
    private readonly object policyObject = NativeManagement.CreateCom("HNetCfg.FwPolicy2");
    public RdpRtcFirewallPolicy ReadPolicy()
    {
        dynamic policy = policyObject; int active = (int)policy.CurrentProfileTypes, enabled = 0, blocked = 0;
        foreach (int profile in new[] { 1, 2, 4 })
        {
            if ((active & profile) == 0) continue;
            // COM indexed getters take exactly one profile bit. FirewallEnabled
            // is the local setting, not a claim to override effective GPO state.
            if (Convert.ToBoolean(Indexed("FirewallEnabled", profile))) enabled |= profile;
            if ((enabled & profile) != 0 && Convert.ToBoolean(Indexed("BlockAllInboundTraffic", profile))) blocked |= profile;
        }
        return new(active, enabled, blocked, (int)policy.LocalPolicyModifyState);
    }
    private object? Indexed(string name, int profile) => policyObject.GetType().InvokeMember(name, BindingFlags.GetProperty, null, policyObject, [profile], CultureInfo.InvariantCulture);
    public IReadOnlyList<RdpRtcFirewallRule> ReadRules()
    {
        var result = new List<RdpRtcFirewallRule>(); object? rulesObject = null;
        try
        {
            dynamic policy = policyObject; dynamic rules = rulesObject = policy.Rules;
            foreach (dynamic rule in rules)
            {
                try
                {
                    // Most unrelated rules need no additional COM queries.
                    string name = (string)rule.Name;
                    if (!name.StartsWith(NativeRdpRtcFirewall.NamePrefix, StringComparison.OrdinalIgnoreCase)) continue;
                    result.Add(new(name, (string?)rule.Description ?? "", (string?)rule.Grouping ?? "", (string?)rule.ApplicationName ?? "", (string?)rule.LocalPorts ?? "", (int)rule.Protocol, (int)rule.Direction, (int)rule.Action, (int)rule.Profiles, (bool)rule.Enabled, (bool)rule.EdgeTraversal));
                }
                finally { NativeManagement.ReleaseCom(rule); }
            }
        }
        finally { NativeManagement.ReleaseCom(rulesObject); }
        return result;
    }
    public int LocalOwnedRuleCount(RdpRtcFirewallRule expected)
    {
        using var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules", false);
        if (key is null) return 0;
        return key.GetValueNames().Count(name => key.GetValue(name) is string value && LocalValueMatches(value, expected));
    }
    internal static bool LocalValueMatches(string value, RdpRtcFirewallRule expected)
    {
        var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        int profiles = 0; bool specifiedProfiles = false;
        foreach (string part in value.Split('|'))
        {
            int equals = part.IndexOf('='); if (equals <= 0) continue;
            string name = part[..equals], field = part[(equals + 1)..];
            if (name.StartsWith("LPort", StringComparison.OrdinalIgnoreCase) && !name.Equals("LPort", StringComparison.OrdinalIgnoreCase)) return false;
            // MS-GPFAS RULE uses the union of repeatable Profile tokens; omission
            // means ALL. Identity, protocol and single-port fields stay unique.
            if (name.Equals("Profile", StringComparison.OrdinalIgnoreCase))
            {
                int bit = field switch { "Domain" => 1, "Private" => 2, "Public" => 4, _ => 0 };
                if (bit == 0) return false;
                specifiedProfiles = true; profiles |= bit;
            }
            else if (!fields.TryAdd(name, field)) return false;
        }
        return NativeRdpRtcFirewall.AllProfiles(expected.Profiles) && (!specifiedProfiles || profiles == 7)
            && fields.GetValueOrDefault("Name") == expected.Name && fields.GetValueOrDefault("Desc") == expected.Description
            && string.Equals(fields.GetValueOrDefault("App"), expected.Application, StringComparison.OrdinalIgnoreCase)
            && fields.GetValueOrDefault("Protocol") == "17" && fields.GetValueOrDefault("LPort") == expected.LocalPorts
            && fields.GetValueOrDefault("Dir") == "In" && fields.GetValueOrDefault("Action") == "Allow" && fields.GetValueOrDefault("Active") == "TRUE"
            && (!fields.TryGetValue("EmbedCtxt", out string? grouping) || grouping == expected.Grouping)
            && (!fields.TryGetValue("Edge", out string? edge) || edge == "FALSE") && !fields.ContainsKey("Defer");
    }
    public void Add(RdpRtcFirewallRule value)
    {
        object? ruleObject = null, rulesObject = null;
        try
        {
            dynamic rule = ruleObject = NativeManagement.CreateCom("HNetCfg.FWRule");
            rule.Name = value.Name; rule.Description = value.Description; rule.Grouping = value.Grouping; rule.ApplicationName = value.Application;
            rule.Protocol = value.Protocol; rule.LocalPorts = value.LocalPorts; rule.Direction = value.Direction; rule.Action = value.Action;
            rule.Profiles = value.Profiles; rule.EdgeTraversal = value.EdgeTraversal; rule.Enabled = value.Enabled;
            dynamic policy = policyObject; dynamic rules = rulesObject = policy.Rules; rules.Add(rule);
        }
        finally { NativeManagement.ReleaseCom(rulesObject); NativeManagement.ReleaseCom(ruleObject); }
    }
    public void Remove(string name)
    {
        object? rulesObject = null;
        try { dynamic policy = policyObject; dynamic rules = rulesObject = policy.Rules; rules.Remove(name); }
        finally { NativeManagement.ReleaseCom(rulesObject); }
    }
    public void Dispose() => NativeManagement.ReleaseCom(policyObject);
}
