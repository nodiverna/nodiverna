using System.Buffers.Binary;
using System.Formats.Asn1;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace ServerDesk.Agent;

internal static class RdpCleanPath
{
    private static Asn1Tag Tag(int tag) => new(TagClass.ContextSpecific, tag, true);
    internal static byte[] ReadRequest(byte[] raw, string sessionId)
    {
        if (raw.Length is < 20 or > RdpFrameCipher.MaximumPlainBytes) throw new InvalidDataException("Invalid RDCleanPath request size.");
        var reader = new AsnReader(raw, AsnEncodingRules.DER); var root = reader.ReadSequence(); reader.ThrowIfNotEmpty();
        var version = root.ReadSequence(Tag(0)); if (version.ReadInteger() != 3390) throw new InvalidDataException("Unsupported RDCleanPath version."); version.ThrowIfNotEmpty();
        var destination = root.ReadSequence(Tag(2)); if (destination.ReadCharacterString(UniversalTagNumber.UTF8String) != "localhost:3389") throw new InvalidDataException("RDP target must be this device's own listener."); destination.ThrowIfNotEmpty();
        var authorization = root.ReadSequence(Tag(3)); if (authorization.ReadCharacterString(UniversalTagNumber.UTF8String) != sessionId) throw new UnauthorizedAccessException("Invalid RDP session authorization."); authorization.ThrowIfNotEmpty();
        var request = root.ReadSequence(Tag(6)); byte[] x224 = request.ReadOctetString(); request.ThrowIfNotEmpty(); root.ThrowIfNotEmpty();
        if (x224.Length is < 19 or > 4096 || x224[0] != 3 || x224[1] != 0 || BinaryPrimitives.ReadUInt16BigEndian(x224.AsSpan(2)) != x224.Length || x224[5] != 0xE0) throw new InvalidDataException("Invalid X.224 connection request.");
        // Negotiation must request CredSSP. RDP cookies remain opaque; credentials
        // and preconnection/injection fields are never interpreted or accepted.
        ReadNegotiation(x224, 1);
        uint requested = BinaryPrimitives.ReadUInt32LittleEndian(x224.AsSpan(x224.Length - 4));
        if ((requested & (2u | 8u)) == 0) throw new InvalidDataException("RDP requires Network Level Authentication.");
        return x224;
    }
    private static void ReadNegotiation(byte[] tpkt, byte kind)
    {
        if (tpkt.Length < 19 || tpkt[0] != 3 || tpkt[1] != 0 || BinaryPrimitives.ReadUInt16BigEndian(tpkt.AsSpan(2)) != tpkt.Length || tpkt[^8] != kind || BinaryPrimitives.ReadUInt16LittleEndian(tpkt.AsSpan(tpkt.Length - 6)) != 8) throw new InvalidDataException("Invalid RDP security negotiation.");
    }
    internal static void RequireNla(byte[] confirm)
    {
        ReadNegotiation(confirm, 2);
        if (confirm[5] != 0xD0 || BinaryPrimitives.ReadUInt32LittleEndian(confirm.AsSpan(confirm.Length - 4)) is not (2u or 8u)) throw new InvalidDataException("The Windows RDP listener must require NLA/CredSSP and TLS.");
    }
    internal static byte[] Response(byte[] confirm, IEnumerable<byte[]> certificates, int port)
    {
        RequireNla(confirm); if (port is < 1 or > 65535) throw new InvalidDataException("Invalid local RDP port.");
        byte[][] chain = certificates.Take(11).ToArray(); if (chain.Length is < 1 or > 10 || chain.Any(c => c.Length is < 1 or > 8192)) throw new InvalidDataException("Invalid RDP certificate chain.");
        var writer = new AsnWriter(AsnEncodingRules.DER); writer.PushSequence();
        writer.PushSequence(Tag(0)); writer.WriteInteger(3390); writer.PopSequence(Tag(0));
        writer.PushSequence(Tag(6)); writer.WriteOctetString(confirm); writer.PopSequence(Tag(6));
        writer.PushSequence(Tag(7)); writer.PushSequence(); foreach (byte[] certificate in chain) writer.WriteOctetString(certificate); writer.PopSequence(); writer.PopSequence(Tag(7));
        writer.PushSequence(Tag(9)); writer.WriteCharacterString(UniversalTagNumber.UTF8String, "127.0.0.1:" + port); writer.PopSequence(Tag(9)); writer.PopSequence();
        byte[] response = writer.Encode();
        if (response.Length > 65_536) throw new InvalidDataException("The Windows RDP certificate response exceeds the browser handshake limit.");
        return response;
    }
    internal static async Task<byte[]> ReadTpktAsync(Stream stream, CancellationToken token)
    {
        byte[] header = new byte[4]; await stream.ReadExactlyAsync(header, token);
        int length = BinaryPrimitives.ReadUInt16BigEndian(header.AsSpan(2));
        if (header[0] != 3 || header[1] != 0 || length is < 11 or > 4096) throw new InvalidDataException("Invalid Windows RDP connection response.");
        byte[] result = new byte[length]; header.CopyTo(result, 0); await stream.ReadExactlyAsync(result.AsMemory(4), token); return result;
    }
}

internal sealed class NativeRdpProxy : IDisposable
{
    private readonly TcpClient client;
    private readonly SslStream tls;
    internal byte[] Response { get; }
    private NativeRdpProxy(TcpClient client, SslStream tls, byte[] response) { this.client = client; this.tls = tls; Response = response; }
    internal static async Task<NativeRdpProxy> ConnectAsync(ReadOnlyMemory<byte> request, string sessionId, int port, string expectedCertSHA1, CancellationToken token)
    {
        if (port is < 1 or > 65535 || expectedCertSHA1.Length != 40 || expectedCertSHA1.Any(c => !Uri.IsHexDigit(c))) throw new InvalidDataException("No valid pinned certificate is available for the local RDP listener.");
        byte[] x224 = RdpCleanPath.ReadRequest(request.ToArray(), sessionId); var client = new TcpClient(AddressFamily.InterNetwork) { NoDelay = true }; SslStream? tls = null;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(12));
        byte[][] chain = [];
        try
        {
            await client.ConnectAsync(IPAddress.Loopback, port, timeout.Token); NetworkStream tcp = client.GetStream();
            await tcp.WriteAsync(x224, timeout.Token); byte[] confirm = await RdpCleanPath.ReadTpktAsync(tcp, timeout.Token); RdpCleanPath.RequireNla(confirm);
            tls = new SslStream(tcp, leaveInnerStreamOpen: false, (_, certificate, presentedChain, _) =>
            {
                if (certificate is null) return false;
                using var leaf = X509CertificateLoader.LoadCertificate(certificate.GetRawCertData());
                bool valid = leaf.NotBefore.ToUniversalTime() <= DateTime.UtcNow && leaf.NotAfter.ToUniversalTime() > DateTime.UtcNow;
                bool pinned = CryptographicOperations.FixedTimeEquals(SHA1.HashData(leaf.RawData), Convert.FromHexString(expectedCertSHA1));
                if (!valid || !pinned) return false;
                chain = presentedChain?.ChainElements.Cast<X509ChainElement>().Take(10).Select(c => c.Certificate.RawData).ToArray() ?? [leaf.RawData];
                if (chain.Length == 0) chain = [leaf.RawData];
                return true; // Only a valid exact LOCAL listener leaf can bypass normal self-signed/name validation.
            });
            await tls.AuthenticateAsClientAsync(new SslClientAuthenticationOptions { TargetHost = Environment.MachineName, EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13, CertificateRevocationCheckMode = X509RevocationMode.NoCheck }, timeout.Token);
            return new NativeRdpProxy(client, tls, RdpCleanPath.Response(confirm, chain, port));
        }
        catch { tls?.Dispose(); client.Dispose(); throw; }
    }
    internal ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token) => tls.ReadAsync(buffer, token);
    internal ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken token) => tls.WriteAsync(buffer, token);
    public void Dispose() { tls.Dispose(); client.Dispose(); }
}
