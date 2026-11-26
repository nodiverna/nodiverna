using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using SIPSorcery.Net;

namespace ServerDesk.Agent;

internal static class NativeRtcTests
{
    private const string Id = "8753ef53-e23a-4c16-b862-e0f7e51dc4b4";
    private const string Sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
    internal static async Task RunAsync()
    {
        Require(NativeRdpChannel.FailureReport(Id, "lease refused", true)["transport"]?.GetValue<string>() == "webrtc" && !NativeRdpChannel.FailureReport(Id, "legacy refused", false).ContainsKey("transport"), "Initial transport refusals lost their WebRTC/legacy identity.");
        byte[] key = Enumerable.Range(0, 32).Select(i => (byte)i).ToArray();
        // Independent Python cryptography AESGCM vectors, not values calculated
        // by the implementation under test.
        const string offer = "1yA7BB64GtTjU3M4HevpteDIajbV8K7m2bKLkbHIQ6PjyoV4fn4kInT5+bARLN9y2dzH8fPyozgDrTOQaDApRNCVlZtQus8=";
        const string answer = "QKmpCi/xhgtctQlKWnK96ksgYYtfEcf9lykZ5PMmjZXKeeiPOz4MVM37wwZd95lEi9cI2d6U3wPFx05sbN0dFLemJfzlOrE=";
        Require(RdpRtcSignal.Seal(Id, key, Sdp, true) == offer && RdpRtcSignal.Seal(Id, key, Sdp, false) == answer, "SDP sealing changed independent vectors.");
        Require(RdpRtcSignal.Open(Id, key, offer, true) == Sdp && RdpRtcSignal.Open(Id, key, answer, false) == Sdp, "SDP sealing did not roundtrip.");
        Reject(() => RdpRtcSignal.Open(Id, key, offer, false), "Offer was accepted as answer.");
        Reject(() => RdpRtcSignal.Open(Guid.NewGuid().ToString(), key, offer, true), "SDP moved across session IDs.");
        Reject(() => RdpRtcSignal.Open(Id, new byte[32], offer, true), "SDP accepted wrong key.");
        byte[] tampered = Convert.FromBase64String(offer); tampered[^1] ^= 1;
        Reject(() => RdpRtcSignal.Open(Id, key, Convert.ToBase64String(tampered), true), "SDP tag corruption accepted.");
        Reject(() => RdpRtcSignal.Open(Id, key, offer + "\n", true), "Noncanonical SDP envelope accepted.");
        Reject(() => RdpRtcSignal.Seal(Id, key, new string('x', 32769), true), "Oversized SDP accepted.");
        RdpRtcSignal.ValidateOffer(Sdp);
        Reject(() => RdpRtcSignal.ValidateOffer(Sdp + "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"), "Extra media track accepted.");
        RdpRtcSignal.ValidateChannel("serverdesk-rdp-v1", true, null, null, false);
        Reject(() => RdpRtcSignal.ValidateChannel("other", true, null, null, false), "Wrong data channel accepted.");
        Reject(() => RdpRtcSignal.ValidateChannel("serverdesk-rdp-v1", false, null, null, false), "Unordered channel accepted.");
        Reject(() => RdpRtcSignal.ValidateChannel("serverdesk-rdp-v1", true, null, 0, false), "Partially reliable channel accepted.");
        RdpRtcSignal.ValidateDeclaration(DataChannelTypes.DATA_CHANNEL_RELIABLE, 0, "serverdesk-rdp-v1", "");
        Reject(() => RdpRtcSignal.ValidateDeclaration(DataChannelTypes.DATA_CHANNEL_RELIABLE_UNORDERED, 0, "serverdesk-rdp-v1", ""), "Raw unordered DCEP accepted.");
        Reject(() => RdpRtcSignal.ValidateDeclaration(DataChannelTypes.DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT, 1, "serverdesk-rdp-v1", ""), "Raw partial DCEP accepted.");
        DateTimeOffset server = new(2026, 10, 9, 14, 30, 0, TimeSpan.Zero), expiry = server.AddHours(2);
        double remaining = RdpRtcSignal.RemainingLeaseMilliseconds(server.AddSeconds(15).ToString("O"), expiry, 15000, server, TimeSpan.FromSeconds(2));
        Require(remaining == 13000, "HTTP transit delay refreshed the authorization lease.");
        Require(RdpRtcSignal.RemainingLeaseMilliseconds(server.AddMilliseconds(15500).ToString("O"), expiry, 15000, server, TimeSpan.FromSeconds(2)) == 13000, "HTTP Date fractional rounding increased the lease.");
        Reject(() => RdpRtcSignal.RemainingLeaseMilliseconds(server.AddSeconds(15).ToString("O"), expiry, 15000, server, TimeSpan.FromSeconds(15)), "Delayed expired HTTP authorization accepted.");
        Reject(() => RdpRtcSignal.RemainingLeaseMilliseconds(server.AddSeconds(17).ToString("O"), expiry, 15000, server, TimeSpan.Zero), "Overlong server lease accepted.");
        Reject(() => RdpRtcSignal.RemainingLeaseMilliseconds(expiry.AddSeconds(1).ToString("O"), expiry, 15000, server, TimeSpan.Zero), "Authorization outlived session expiry.");
        long monotonic = RdpRtcSignal.MonotonicDeadline(20); await Task.Delay(30);
        Require(Stopwatch.GetTimestamp() >= monotonic, "Monotonic authorization deadline did not expire.");
        SetupBudget();
        NativeRdpRtcFirewallTests.Run();
        await InputBufferAsync();
        if (OperatingSystem.IsWindows()) await NativeRtcLoopbackTests.RunAsync();
        Console.WriteLine("Native WebRTC tests passed: independent sealed-SDP vectors, peer/session binding, raw DCEP reliability checks, absolute/monotonic authorization, fixed initial setup deadline and byte-bounded tiny-input coalescing. Windows/browser DTLS interoperability requires the pilot.");
    }
    private static void SetupBudget()
    {
        long began = 100 * Stopwatch.Frequency, before = began + 19 * Stopwatch.Frequency, boundary = began + 20 * Stopwatch.Frequency, lease = before + 15 * Stopwatch.Frequency;
        var setup = new RdpRtcSetupBudget(began);
        Require(setup.Deadline == boundary && !setup.IsExpired(before) && setup.IsExpired(boundary), "Setup budget did not retain its fixed monotonic boundary.");
        Require(setup.ShouldDeferPeerFailure(RTCPeerConnectionState.failed, RTCIceConnectionState.failed, false, true, lease, before), "Initial ICE failure shortened the setup budget.");
        Require(!setup.ShouldDeferPeerFailure(RTCPeerConnectionState.failed, RTCIceConnectionState.failed, false, true, lease, boundary), "Initial ICE failure was deferred at its deadline.");
        Require(!setup.ShouldDeferPeerFailure(RTCPeerConnectionState.failed, RTCIceConnectionState.failed, false, true, before, before), "Expired authorization was deferred during setup.");
        Require(!setup.ShouldDeferPeerFailure(RTCPeerConnectionState.failed, RTCIceConnectionState.failed, false, false, lease, before), "Cancelled or revoked session was deferred during setup.");
        Require(!setup.ShouldDeferPeerFailure(RTCPeerConnectionState.failed, RTCIceConnectionState.connected, false, true, lease, before), "A non-ICE negotiation failure was deferred.");
        Require(!setup.ShouldDeferPeerFailure(RTCPeerConnectionState.failed, RTCIceConnectionState.failed, true, true, lease, before), "A completed DTLS transport received initial ICE grace.");
        Require(!setup.ShouldDeferPeerFailure(RTCPeerConnectionState.closed, RTCIceConnectionState.failed, false, true, lease, before) && !setup.ShouldDeferPeerFailure(RTCPeerConnectionState.disconnected, RTCIceConnectionState.failed, false, true, lease, before), "Closed or disconnected peers received initial ICE grace.");
        Require(!setup.TryMarkChannelOpened(boundary), "A late SCTP channel cancelled the fixed setup deadline.");
        Require(setup.TryMarkChannelOpened(before) && !setup.IsExpired(boundary + Stopwatch.Frequency), "An opened channel did not complete setup permanently.");
        Require(!setup.ShouldDeferPeerFailure(RTCPeerConnectionState.failed, RTCIceConnectionState.failed, false, true, lease, before), "An established channel received setup grace.");
    }
    private static async Task InputBufferAsync()
    {
        using var input = new RdpRtcInputBuffer();
        byte[] cleanPath = [48, 8, 1, 2, 3], bytes = Enumerable.Range(0, 16000).Select(i => (byte)(i % 251)).ToArray();
        Require(input.Add(cleanPath), "First CleanPath message was rejected.");
        for (int offset = 0; offset < bytes.Length; offset += 8) Require(input.Add(bytes.AsSpan(offset, 8)), "Tiny input writes exhausted byte-sized slots.");
        Require(input.Count == 2 && input.Bytes == cleanPath.Length + bytes.Length, "Input coalescing retained message-count credit or lost byte accounting.");
        Require((await input.ReadAsync(CancellationToken.None)).SequenceEqual(cleanPath), "CleanPath boundary merged with following TLS bytes.");
        Require((await input.ReadAsync(CancellationToken.None)).SequenceEqual(bytes), "Coalesced input lost or reordered bytes.");
        byte[] block = new byte[16384];
        for (int i = 0; i < 64; i++) Require(input.Add(block), "One MiB input window stopped early.");
        Require(input.Bytes == RdpRtcInputBuffer.MaximumBytes && input.Count == 64 && !input.Add(new byte[] { 1 }), "Input exceeded its byte window.");
        Require((await input.ReadAsync(CancellationToken.None)).Length == 16384 && input.Add(new byte[] { 2 }), "Input consumption did not free bounded credit.");
        Require(!input.Add(new byte[16385]), "Oversized input accepted.");
        using var waiting = new RdpRtcInputBuffer(); using var cancel = new CancellationTokenSource();
        Task<byte[]> read = waiting.ReadAsync(cancel.Token); cancel.Cancel();
        try { await read; throw new Exception("Input cancellation remained pending."); } catch (OperationCanceledException) { }
    }
    private static void Require(bool okay, string message) { if (!okay) throw new Exception(message); }
    private static void Reject(Action action, string message)
    {
        try { action(); } catch (CryptographicException) { return; } catch (InvalidDataException) { return; }
        throw new Exception(message);
    }
}
