using System.Diagnostics;
using SIPSorcery.Net;

namespace ServerDesk.Agent;

// ICE checking begins before the immutable answer reaches the browser. Its
// first failed event must not shorten the advertised setup budget.
// Authorization and established-channel failures remain independent.
internal sealed class RdpRtcSetupBudget
{
    internal const string TimeoutMessage = "Direct Remote Desktop ICE/DTLS/data-channel setup exceeded its fixed 20-second deadline. Start a new session.";
    private readonly object gate = new();
    private bool completed;
    internal long Deadline { get; }

    internal RdpRtcSetupBudget(long startedAt)
    {
        Deadline = checked(startedAt + 20 * Stopwatch.Frequency);
    }

    internal bool IsExpired(long now)
    {
        lock (gate) return !completed && now >= Deadline;
    }

    internal bool TryMarkChannelOpened(long now)
    {
        lock (gate)
        {
            if (completed) return true;
            if (now >= Deadline) return false;
            completed = true;
            return true;
        }
    }

    internal bool ShouldDeferPeerFailure(RTCPeerConnectionState state, RTCIceConnectionState ice, bool dtlsComplete, bool alive, long leaseDeadline, long now)
    {
        lock (gate)
            return state == RTCPeerConnectionState.failed && ice == RTCIceConnectionState.failed && !dtlsComplete && !completed && alive && now < leaseDeadline && now < Deadline;
    }
}
