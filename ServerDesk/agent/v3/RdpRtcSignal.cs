using System.Buffers.Binary;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using SIPSorcery.Net;

namespace ServerDesk.Agent;

// Signalling is encrypted end to end. The SDP pins the peer's DTLS certificate,
// so all subsequent ordered SCTP bytes are bound to this exact session key.
internal static class RdpRtcSignal
{
    internal const int MaximumSdpBytes = 32_768;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static (byte[] Nonce, byte[] Aad) Parameters(string id, bool offer)
    {
        if (!Guid.TryParseExact(id, "D", out Guid parsed) || parsed.ToString() != id) throw new CryptographicException("Invalid WebRTC session identifier.");
        byte[] nonce = new byte[12]; Encoding.ASCII.GetBytes(offer ? "BOFR" : "AANS").CopyTo(nonce, 0);
        BinaryPrimitives.WriteUInt64BigEndian(nonce.AsSpan(4), 1);
        return (nonce, Encoding.UTF8.GetBytes($"ServerDesk:RDP:RTC:1:{id}:{(offer ? "offer" : "answer")}"));
    }
    internal static string Seal(string id, byte[] key, string sdp, bool offer)
    {
        if (key.Length != 32) throw new CryptographicException("Invalid WebRTC session key.");
        byte[] plain = Utf8.GetBytes(sdp);
        try
        {
            if (plain.Length is < 1 or > MaximumSdpBytes) throw new InvalidDataException("Invalid WebRTC description size.");
            byte[] ciphertext = new byte[plain.Length + 16]; var parameters = Parameters(id, offer);
            using var aes = new AesGcm(key, 16); aes.Encrypt(parameters.Nonce, plain, ciphertext.AsSpan(0, plain.Length), ciphertext.AsSpan(plain.Length), parameters.Aad);
            return Convert.ToBase64String(ciphertext);
        }
        finally { CryptographicOperations.ZeroMemory(plain); }
    }
    internal static string Open(string id, byte[] key, string sealedSdp, bool offer)
    {
        if (key.Length != 32 || sealedSdp.Length is < 24 or > 43_712) throw new CryptographicException("Invalid encrypted WebRTC description.");
        byte[] ciphertext;
        try { ciphertext = Convert.FromBase64String(sealedSdp); } catch (FormatException e) { throw new CryptographicException("Invalid encrypted WebRTC description.", e); }
        if (ciphertext.Length is < 17 or > MaximumSdpBytes + 16 || Convert.ToBase64String(ciphertext) != sealedSdp) throw new CryptographicException("Invalid encrypted WebRTC description.");
        byte[] plain = new byte[ciphertext.Length - 16]; var parameters = Parameters(id, offer);
        try
        {
            using var aes = new AesGcm(key, 16); aes.Decrypt(parameters.Nonce, ciphertext.AsSpan(0, plain.Length), ciphertext.AsSpan(plain.Length), plain, parameters.Aad);
            return Utf8.GetString(plain);
        }
        finally { CryptographicOperations.ZeroMemory(plain); }
    }
    internal static double RemainingLeaseMilliseconds(string? value, DateTimeOffset expiry, int leaseMs, DateTimeOffset serverDate, TimeSpan requestAge)
    {
        if (!DateTimeOffset.TryParse(value, out DateTimeOffset deadline) || deadline <= serverDate || deadline > expiry || leaseMs is < 1 or > 15000 || requestAge < TimeSpan.Zero) throw new InvalidDataException("WebRTC authorization lease expired or invalid.");
        // HTTP Date has one-second precision. Its fractional uncertainty can
        // never increase the grant above leaseMs or fifteen seconds, and the
        // full locally measured request age is subtracted before accepting it.
        if (deadline > serverDate.AddSeconds(16)) throw new InvalidDataException("WebRTC authorization lease is too long.");
        double remaining = Math.Min(leaseMs, Math.Min(15000, (deadline - serverDate).TotalMilliseconds)) - requestAge.TotalMilliseconds;
        if (remaining <= 0) throw new InvalidDataException("WebRTC authorization lease expired in transit.");
        return remaining;
    }
    internal static long MonotonicDeadline(double remainingMs)
    {
        if (!double.IsFinite(remainingMs) || remainingMs is <= 0 or > 15000) throw new InvalidDataException("Invalid WebRTC authorization duration.");
        return Stopwatch.GetTimestamp() + (long)(remainingMs * Stopwatch.Frequency / 1000);
    }
    internal static void ValidateDeclaration(DataChannelTypes type, uint reliability, string label, string protocol)
    {
        if (type != DataChannelTypes.DATA_CHANNEL_RELIABLE || reliability != 0 || label != "serverdesk-rdp-v1" || protocol != "") throw new InvalidDataException("Invalid direct Remote Desktop channel declaration.");
    }
    internal static void ValidateChannel(string label, bool ordered, ushort? lifetime, ushort? retransmits, bool negotiated)
    {
        if (label != "serverdesk-rdp-v1" || !ordered || lifetime is not null || retransmits is not null || negotiated) throw new InvalidDataException("Invalid direct Remote Desktop data channel.");
    }
    internal static async Task<RTCSessionDescriptionInit> CreateAnswerAfterGatheringAsync(RTCPeerConnection peer, TimeSpan budget, CancellationToken token)
    {
        if (budget <= TimeSpan.Zero || budget > TimeSpan.FromSeconds(8)) throw new ArgumentOutOfRangeException(nameof(budget));
        long began = Stopwatch.GetTimestamp();
        // STUN adds useful public candidates, but is optional for a reachable
        // LAN/VPN host path. The library can remain in gathering when STUN is
        // unavailable even though it already has valid host candidates.
        while (peer.iceGatheringState != RTCIceGatheringState.complete && Stopwatch.GetElapsedTime(began) < budget)
            await Task.Delay(10, token);
        token.ThrowIfCancellationRequested();
        if (peer.GetRtpChannel().Candidates.Count == 0) throw new InvalidOperationException("Direct Remote Desktop discovery found no usable UDP candidate.");
        // Encode every candidate available now into the immutable answer. No
        // trickle API or unencrypted connection information is required.
        return peer.createAnswer(new RTCAnswerOptions { X_WaitForIceGatheringToComplete = false });
    }
    internal static void ValidateOffer(string sdp)
    {
        var media = sdp.Split('\n').Select(line => line.TrimEnd('\r')).Where(line => line.StartsWith("m=", StringComparison.Ordinal)).ToArray();
        if (media.Length != 1 || !media[0].StartsWith("m=application ", StringComparison.Ordinal) || !media[0].Contains(" UDP/DTLS/SCTP webrtc-datachannel", StringComparison.Ordinal)) throw new InvalidDataException("WebRTC accepts one secure data channel transport only.");
    }
}
