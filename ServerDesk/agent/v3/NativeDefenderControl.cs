using System.Globalization;
using System.Management;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// The Microsoft Defender actions of 4.15.0 (docs/native-agent-v4.md, "Microsoft
// Defender actions in 4.15.0"): quick scan, full scan, signature update and
// "clean all active detections", each as one typed static WMI method of
// root\Microsoft\Windows\Defender (the methods behind Start-MpScan,
// Update-MpSignature and Remove-MpThreat). No command interpreter, no
// MpCmdRun, no process, no preference change. MSFT_MpThreat.Remove takes no
// threat ID: it acts on every active threat, so the portal names the action
// "Clean all active detections". NativeDefender.cs, the collector, stays read-only.
internal interface IDefenderControlProvider
{
    /// <summary>AMRunningMode of MSFT_MpComputerStatus. Throws DefenderUnavailableException when the namespace, the class or the row is missing.</summary>
    string? RunningMode();
    /// <summary>MSFT_MpScan.Start with ScanType 1 (quick) or 2 (full). Returns when the scan ends; the return value is Defender's result code.</summary>
    uint StartScan(byte scanType);
    /// <summary>MSFT_MpSignature.Update without an update source: the source set on the device.</summary>
    uint UpdateSignatures();
    /// <summary>MSFT_MpThreat.Remove: no parameter, all active threats.</summary>
    uint RemoveThreats();
    /// <summary>The number of active threats (MSFT_MpThreat.IsActive).</summary>
    int ActiveThreats();
    /// <summary>AntivirusSignatureVersion of MSFT_MpComputerStatus.</summary>
    string? SignatureVersion();
}

/// <summary>
/// The broker-held slot of a scan that the portal started: at most one per
/// device. The scan job ends after at most 60 s; the slot keeps the WMI call
/// until Defender returns, then clears and asks for an inventory refresh.
/// While it is busy, the snapshot carries defenderScan (State). A slot older
/// than 24 hours is released, so a call that never returns blocks no new scan.
/// </summary>
internal sealed class DefenderScanSlot(Action? finished = null, Func<DateTimeOffset>? clock = null)
{
    internal static readonly TimeSpan MaximumAge = TimeSpan.FromHours(24);
    private readonly object gate = new();
    private readonly Func<DateTimeOffset> now = clock ?? (() => DateTimeOffset.UtcNow);
    private Task<uint>? task;
    private string kind = "";
    private DateTimeOffset startedAt;

    // Under the lock.
    private void ReleaseExpired() { if (task is not null && now() - startedAt > MaximumAge) task = null; }

    /// <summary>Starts the scan call in the slot, or returns null while another portal scan runs.</summary>
    internal Task<uint>? TryStart(string scanKind, Func<uint> scan)
    {
        lock (gate)
        {
            ReleaseExpired();
            if (task is not null) return null;
            var started = Task.Factory.StartNew(scan, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            task = started; kind = scanKind; startedAt = now();
            // The continuation waits for this lock, so it always sees the slot set.
            started.ContinueWith(ended =>
            {
                _ = ended.Exception; // A late failure is observed here; the next collector run shows Defender's state.
                lock (gate) if (ReferenceEquals(task, started)) task = null;
                finished?.Invoke();
            }, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
            return started;
        }
    }

    internal bool Busy { get { lock (gate) { ReleaseExpired(); return task is not null; } } }

    /// <summary>The snapshot key defenderScan {kind, startedAt} while the slot is busy, otherwise null.</summary>
    internal JsonObject? State()
    {
        lock (gate)
        {
            ReleaseExpired();
            return task is null ? null : new JsonObject { ["kind"] = kind, ["startedAt"] = startedAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture) };
        }
    }
}

/// <summary>How long a job waits for Defender. The self-test uses short values.</summary>
internal sealed record DefenderControlWaits(TimeSpan Scan, TimeSpan Signatures, TimeSpan Clean)
{
    internal static readonly DefenderControlWaits Default = new(TimeSpan.FromSeconds(60), TimeSpan.FromMinutes(SignatureMinutes), TimeSpan.FromMinutes(CleanMinutes));
    internal const int SignatureMinutes = 15, CleanMinutes = 10;
}

internal sealed class NativeDefenderControl(DefenderScanSlot slot, IDefenderControlProvider? provider = null, DefenderControlWaits? waits = null)
{
    private readonly IDefenderControlProvider source = provider ?? new WmiDefenderControlProvider();
    private readonly DefenderControlWaits limits = waits ?? DefenderControlWaits.Default;

    internal async Task<JsonObject> ExecuteAsync(JsonObject job, CancellationToken token)
    {
        string action = job["action"]!.GetValue<string>();
        var result = new JsonObject { ["id"] = job["id"]?.DeepClone(), ["ok"] = false };
        EnsureAvailable();
        switch (action)
        {
            case "defender-quick-scan":
            case "defender-full-scan":
            {
                bool quick = action == "defender-quick-scan";
                byte scanType = quick ? (byte)1 : (byte)2;
                var scan = slot.TryStart(quick ? "quick" : "full", () => source.StartScan(scanType)) ?? throw new AgentMessageException("AGENT_DEFENDER_SCAN_RUNNING");
                var done = await Task.WhenAny(scan, Task.Delay(limits.Scan, token));
                token.ThrowIfCancellationRequested();
                // Still running: the job ends here, the slot keeps the call until Defender returns.
                if (done != scan) { result["ok"] = true; return AgentMessages.Write(result, AgentMessages.Of(quick ? "AGENT_DEFENDER_QUICK_SCAN_STARTED" : "AGENT_DEFENDER_FULL_SCAN_STARTED")); }
                Succeeded(await Outcome(scan));
                result["ok"] = true; return AgentMessages.Write(result, AgentMessages.Of("AGENT_DEFENDER_SCAN_COMPLETED"));
            }
            case "defender-update-signatures":
            {
                Succeeded(await Within(source.UpdateSignatures, limits.Signatures, DefenderControlWaits.SignatureMinutes, token));
                string version;
                try { version = source.SignatureVersion() is { Length: > 0 } read ? WindowsManagement.Limit(read, 64) : "-"; }
                catch (Exception error) when (error is not OutOfMemoryException) { version = "-"; }
                result["ok"] = true; return AgentMessages.Write(result, AgentMessages.Of("AGENT_DEFENDER_SIGNATURES_UPDATED", ("version", version)));
            }
            case "defender-clean-detections":
            {
                int before = Read(source.ActiveThreats);
                if (before == 0) { result["ok"] = true; return AgentMessages.Write(result, AgentMessages.Of("AGENT_DEFENDER_NO_ACTIVE_DETECTIONS")); }
                // A result code is not decisive here: the count afterwards says what Defender cleaned.
                await Within(source.RemoveThreats, limits.Clean, DefenderControlWaits.CleanMinutes, token);
                int after = Read(source.ActiveThreats);
                if (after == 0) { result["ok"] = true; return AgentMessages.Write(result, AgentMessages.Of("AGENT_DEFENDER_DETECTIONS_CLEANED", ("count", before))); }
                return AgentMessages.Write(result, AgentMessages.Of("AGENT_DEFENDER_DETECTIONS_REMAIN", ("cleaned", Math.Max(0, before - after)), ("remaining", after)));
            }
            default: throw new AgentMessageException("AGENT_UNKNOWN_ACTION");
        }
    }

    /// <summary>A missing namespace, class or status row, or the mode "Not running", gives AGENT_DEFENDER_UNAVAILABLE.</summary>
    private void EnsureAvailable()
    {
        string? mode = Read(source.RunningMode);
        if (NativeDefender.Mode(mode) == "not-running") throw new AgentMessageException("AGENT_DEFENDER_UNAVAILABLE");
    }

    private static T Read<T>(Func<T> read)
    {
        try { return read(); }
        catch (Exception error) when (Unavailable(error)) { throw new AgentMessageException(error, "AGENT_DEFENDER_UNAVAILABLE"); }
        catch (ManagementException error) { throw new AgentMessageException(error, "AGENT_DEFENDER_ACTION_FAILED", ("detail", Detail(error))); }
    }

    private static bool Unavailable(Exception error) => error is DefenderUnavailableException || error is ManagementException { ErrorCode: ManagementStatus.InvalidNamespace or ManagementStatus.InvalidClass or ManagementStatus.NotFound or ManagementStatus.InvalidMethod };
    private static string Detail(Exception error) => WindowsManagement.Limit(NativeInventoryDiagnostics.Describe(error) + ": " + error.Message, 500);

    /// <summary>Runs the call; a call that is still running after the limit gives AGENT_DEFENDER_TIMEOUT {minutes}.</summary>
    private static async Task<uint> Within(Func<uint> call, TimeSpan limit, int minutes, CancellationToken token)
    {
        var task = Task.Run(call, CancellationToken.None);
        var done = await Task.WhenAny(task, Task.Delay(limit, token));
        token.ThrowIfCancellationRequested();
        if (done != task) { _ = task.ContinueWith(ended => _ = ended.Exception, TaskScheduler.Default); throw new AgentMessageException("AGENT_DEFENDER_TIMEOUT", ("minutes", minutes)); }
        return await Outcome(task);
    }

    private static async Task<uint> Outcome(Task<uint> call)
    {
        try { return await call; }
        catch (Exception error) when (Unavailable(error)) { throw new AgentMessageException(error, "AGENT_DEFENDER_UNAVAILABLE"); }
        catch (ManagementException error) { throw new AgentMessageException(error, "AGENT_DEFENDER_ACTION_FAILED", ("detail", Detail(error))); }
    }

    /// <summary>A result code other than 0 is Defender's refusal; the hex code goes into the message.</summary>
    private static void Succeeded(uint code)
    {
        if (code != 0) throw new AgentMessageException("AGENT_DEFENDER_ACTION_FAILED", ("detail", "0x" + code.ToString("X8", CultureInfo.InvariantCulture)));
    }
}

// Typed WMI of the Defender namespace: three static methods and two reads.
internal sealed class WmiDefenderControlProvider : IDefenderControlProvider
{
    private const string DefenderNamespace = @"root\Microsoft\Windows\Defender";
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(10);

    public string? RunningMode()
    {
        Dictionary<string, object?>? row;
        // SELECT *: AMRunningMode is missing on older Defender platforms, and naming a missing property fails the query.
        try { row = WindowsManagement.Query(DefenderNamespace, "SELECT * FROM MSFT_MpComputerStatus", 1, ReadTimeout).FirstOrDefault(); }
        catch (ManagementException error) when (error.ErrorCode is ManagementStatus.InvalidNamespace or ManagementStatus.InvalidClass or ManagementStatus.NotFound) { throw new DefenderUnavailableException("Microsoft Defender is not installed."); }
        if (row is null) throw new DefenderUnavailableException("Microsoft Defender reports no status.");
        return row.TryGetValue("AMRunningMode", out var value) ? Convert.ToString(value, CultureInfo.InvariantCulture) : null;
    }

    public uint StartScan(byte scanType) => Code(WindowsManagement.Invoke(DefenderNamespace, "MSFT_MpScan", "Start", new Dictionary<string, object?> { ["ScanType"] = scanType }, DefenderScanSlot.MaximumAge));
    public uint UpdateSignatures() => Code(WindowsManagement.Invoke(DefenderNamespace, "MSFT_MpSignature", "Update", null, TimeSpan.FromMinutes(DefenderControlWaits.SignatureMinutes)));
    public uint RemoveThreats() => Code(WindowsManagement.Invoke(DefenderNamespace, "MSFT_MpThreat", "Remove", null, TimeSpan.FromMinutes(DefenderControlWaits.CleanMinutes)));

    public int ActiveThreats() => WindowsManagement.Query(DefenderNamespace, "SELECT ThreatID,IsActive FROM MSFT_MpThreat", 5000, ReadTimeout)
        .Count(row => row.TryGetValue("IsActive", out var value) && value is bool active && active);

    public string? SignatureVersion() => WindowsManagement.Query(DefenderNamespace, "SELECT AntivirusSignatureVersion FROM MSFT_MpComputerStatus", 1, ReadTimeout).FirstOrDefault() is { } row
        && row.TryGetValue("AntivirusSignatureVersion", out var value) ? Convert.ToString(value, CultureInfo.InvariantCulture) : null;

    private static uint Code(Dictionary<string, object?> output) => output.TryGetValue("ReturnValue", out var value) && value is not null ? Convert.ToUInt32(value, CultureInfo.InvariantCulture) : 0;
}
