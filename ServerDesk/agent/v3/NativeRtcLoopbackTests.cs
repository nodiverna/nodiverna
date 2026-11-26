using System.Net;
using System.Diagnostics;
using System.Security.Cryptography;
using SIPSorcery.Net;

namespace ServerDesk.Agent;

// This test uses the shipped library, actual ICE/DTLS/SCTP and only loopback
// sockets. Linux sandbox network-watch APIs are unavailable; the Windows
// self-test invokes this directly, with no modified dependency or relay.
internal static class NativeRtcLoopbackTests
{
    internal static async Task RunAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var opened = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var receivedAgent = new TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        var receivedBrowser = new TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        RTCDataChannel? agentChannel = null;
        var browser = new RTCPeerConnection(new RTCConfiguration { X_BindAddress = IPAddress.Loopback });
        var agent = new RTCPeerConnection(new RTCConfiguration
        {
            X_BindAddress = IPAddress.Loopback,
            // Intentionally no listener: public STUN discovery cannot succeed.
            iceServers = [new RTCIceServer { urls = "stun:127.0.0.1:9" }],
        });
        try
        {
            agent.ondatachannel += channel => { agentChannel = channel; channel.onmessage += (_, _, data) => receivedAgent.TrySetResult(data); };
            var client = await browser.createDataChannel("serverdesk-rdp-v1", new RTCDataChannelInit { ordered = true });
            client.onopen += () => opened.TrySetResult(); client.onmessage += (_, _, data) => receivedBrowser.TrySetResult(data);
            while (browser.iceGatheringState != RTCIceGatheringState.complete) await Task.Delay(10, timeout.Token);
            var offer = browser.createOffer(); await browser.setLocalDescription(offer);
            if (agent.setRemoteDescription(offer) != SetDescriptionResultEnum.OK) throw new Exception("Loopback SDP offer was rejected.");
            var answer = await RdpRtcSignal.CreateAnswerAfterGatheringAsync(agent, TimeSpan.FromMilliseconds(250), timeout.Token);
            if (agent.iceGatheringState == RTCIceGatheringState.complete || !answer.sdp.Contains("a=candidate:", StringComparison.Ordinal)) throw new Exception("Unavailable-STUN test did not retain a gathered host candidate.");
            byte[] key = Enumerable.Range(0, 32).Select(i => (byte)i).ToArray();
            string id = Guid.NewGuid().ToString(), sealedAnswer = RdpRtcSignal.Seal(id, key, answer.sdp, false);
            await agent.setLocalDescription(answer);
            if (browser.setRemoteDescription(new RTCSessionDescriptionInit { type = RTCSdpType.answer, sdp = RdpRtcSignal.Open(id, key, sealedAnswer, false) }) != SetDescriptionResultEnum.OK) throw new Exception("Sealed loopback SDP answer was rejected.");
            await opened.Task.WaitAsync(timeout.Token);
            byte[] expected = Enumerable.Range(0, 16384).Select(i => (byte)(i % 251)).ToArray();
            client.send(expected); byte[] input = await receivedAgent.Task.WaitAsync(timeout.Token);
            if (!expected.SequenceEqual(input) || agentChannel is null) throw new Exception("Unavailable STUN corrupted loopback input.");
            agentChannel.send(input); byte[] output = await receivedBrowser.Task.WaitAsync(timeout.Token);
            if (!expected.SequenceEqual(output)) throw new Exception("Unavailable STUN corrupted loopback output.");
            Console.WriteLine("Native WebRTC loopback passed: unavailable STUN retained host candidates in sealed immutable SDP; exact 16-KiB DTLS/SCTP bytes in both directions, no trickle or relay.");
        }
        finally { browser.Close("test complete"); agent.Close("test complete"); }
        await DelayedAnswerAsync();
    }

    private static async Task DelayedAnswerAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        var opened = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var receivedAgent = new TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        var receivedBrowser = new TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        int deferredFailures = 0, alive = 1;
        long leaseDeadline = Stopwatch.GetTimestamp() + 15 * Stopwatch.Frequency;
        RTCDataChannel? agentChannel = null;
        var browser = new RTCPeerConnection(new RTCConfiguration { X_BindAddress = IPAddress.Loopback });
        var setup = new RdpRtcSetupBudget(Stopwatch.GetTimestamp());
        var agent = new RTCPeerConnection(new RTCConfiguration { X_BindAddress = IPAddress.Loopback });
        byte[] key = Enumerable.Range(0, 32).Select(i => (byte)(31 - i)).ToArray();
        string id = Guid.NewGuid().ToString();
        // Model ongoing authenticated control reports. These renew authorization
        // only; they never recreate or extend the shared setup policy's deadline.
        Task authorization = Task.Run(async () =>
        {
            while (!timeout.IsCancellationRequested)
            {
                await Task.Delay(100, timeout.Token);
                long now = Stopwatch.GetTimestamp();
                if (now >= Volatile.Read(ref leaseDeadline) || setup.IsExpired(now))
                {
                    Volatile.Write(ref alive, 0); agent.Close("setup test deadline");
                    opened.TrySetException(new Exception("Delayed signaling outlived setup or authorization."));
                    return;
                }
                Volatile.Write(ref leaseDeadline, now + 15 * Stopwatch.Frequency);
            }
        });
        try
        {
            agent.onconnectionstatechange += state =>
            {
                if (state is not (RTCPeerConnectionState.failed or RTCPeerConnectionState.closed or RTCPeerConnectionState.disconnected)) return;
                if (setup.ShouldDeferPeerFailure(state, agent.iceConnectionState, agent.IsDtlsNegotiationComplete, Volatile.Read(ref alive) != 0, Volatile.Read(ref leaseDeadline), Stopwatch.GetTimestamp()))
                { Interlocked.Increment(ref deferredFailures); return; }
                Volatile.Write(ref alive, 0); agent.Close("terminal setup test failure");
                opened.TrySetException(new Exception("Shared setup policy closed the delayed peer."));
            };
            agent.ondatachannel += channel =>
            {
                if (!channel.IsOpened || channel.readyState != RTCDataChannelState.open || !setup.TryMarkChannelOpened(Stopwatch.GetTimestamp()))
                { opened.TrySetException(new Exception("Delayed channel exceeded its fixed setup budget.")); return; }
                agentChannel = channel; channel.onmessage += (_, _, data) => receivedAgent.TrySetResult(data);
            };
            var client = await browser.createDataChannel("serverdesk-rdp-v1", new RTCDataChannelInit { ordered = true });
            client.onopen += () => opened.TrySetResult(); client.onmessage += (_, _, data) => receivedBrowser.TrySetResult(data);
            while (browser.iceGatheringState != RTCIceGatheringState.complete || agent.iceGatheringState != RTCIceGatheringState.complete) await Task.Delay(10, timeout.Token);
            var offer = browser.createOffer(); await browser.setLocalDescription(offer);
            string sealedOffer = RdpRtcSignal.Seal(id, key, offer.sdp, true);
            if (agent.setRemoteDescription(new RTCSessionDescriptionInit { type = RTCSdpType.offer, sdp = RdpRtcSignal.Open(id, key, sealedOffer, true) }) != SetDescriptionResultEnum.OK) throw new Exception("Delayed sealed offer was rejected.");
            var answer = await RdpRtcSignal.CreateAnswerAfterGatheringAsync(agent, TimeSpan.FromMilliseconds(250), timeout.Token); await agent.setLocalDescription(answer);
            string sealedAnswer = RdpRtcSignal.Seal(id, key, answer.sdp, false);
            await Task.Delay(TimeSpan.FromSeconds(18), timeout.Token);
            if (Volatile.Read(ref deferredFailures) < 1 || Volatile.Read(ref alive) == 0 || agent.iceConnectionState != RTCIceConnectionState.failed || agent.IsDtlsNegotiationComplete) throw new Exception("Delayed test did not retain a real initial ICE failure within the shared budget.");
            if (browser.setRemoteDescription(new RTCSessionDescriptionInit { type = RTCSdpType.answer, sdp = RdpRtcSignal.Open(id, key, sealedAnswer, false) }) != SetDescriptionResultEnum.OK) throw new Exception("Delayed sealed answer was rejected.");
            await opened.Task.WaitAsync(timeout.Token);
            byte[] expected = Enumerable.Range(0, 16384).Select(i => (byte)(i % 239)).ToArray();
            client.send(expected); byte[] input = await receivedAgent.Task.WaitAsync(timeout.Token);
            if (!expected.SequenceEqual(input) || agentChannel is null) throw new Exception("Delayed signaling corrupted loopback input.");
            agentChannel.send(input); byte[] output = await receivedBrowser.Task.WaitAsync(timeout.Token);
            if (!expected.SequenceEqual(output)) throw new Exception("Delayed signaling corrupted loopback output.");
            if (setup.ShouldDeferPeerFailure(RTCPeerConnectionState.failed, RTCIceConnectionState.failed, false, true, Volatile.Read(ref leaseDeadline), Stopwatch.GetTimestamp())) throw new Exception("Established delayed channel retained initial setup grace.");
            Console.WriteLine("Native WebRTC delayed loopback passed: real initial ICE failure, immutable encrypted SDP delayed 18 seconds, fixed 20-second shared setup policy, exact 16-KiB DTLS/SCTP bytes both ways and no grace after channel open.");
        }
        finally
        {
            Volatile.Write(ref alive, 0); timeout.Cancel(); browser.Close("test complete"); agent.Close("test complete"); CryptographicOperations.ZeroMemory(key);
            try { await authorization; } catch (OperationCanceledException) { }
        }
    }
}
