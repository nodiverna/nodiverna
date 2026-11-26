using System.Buffers.Binary;
using System.Formats.Asn1;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace ServerDesk.Agent;

// These fixtures exercise the real framing, cryptography and TLS proxy on a
// loopback listener. They do not claim to exercise Windows logon or an RDP UI.
internal static class NativeRdpTests
{
    private const string SessionId = "8753ef53-e23a-4c16-b862-e0f7e51dc4b4";
    private const long MaximumSequence = 9007199254740991;
    private static readonly byte[] RequestTpkt = Convert.FromHexString("030000130EE000000000000100080003000000");

    internal static async Task RunAsync()
    {
        await TransportTestsAsync();
        await NativeRdpChannelDiagnosticTests.RunAsync();
        CipherTests();
        KeyEnvelopeTests();
        CleanPathTests();
        InputLedgerTests();
        AvailabilityTests();
        await WindowTestsAsync();
        await StoredWindowTestsAsync();
        await OutputCoalescingTestsAsync();
        await TpktTestsAsync();
        await NativeTlsTestsAsync();
        await SessionLeaseTestsAsync();
        Console.WriteLine("Native RDP tests passed: independent AES-GCM vectors, DER/NLA validation, ordered replay protection, bounded flow control and real loopback TLS certificate pinning/relay. Windows logon requires the Windows pilot.");
    }

    private static async Task OutputCoalescingTestsAsync()
    {
        // Thousands of tiny TLS reads must become a handful of byte-sized
        // mailbox frames, retaining every byte and the normal 16-KiB limit.
        var burst = new ScriptedRdpStream(); byte[] expected = new byte[32_768];
        for (int offset = 0; offset < expected.Length; offset += 8)
        {
            byte[] chunk = Enumerable.Range(offset, 8).Select(value => (byte)value).ToArray(); chunk.CopyTo(expected, offset); burst.Write(chunk);
        }
        burst.End(); var frames = new List<byte[]>();
        await using (var coalescer = new RdpOutputCoalescer(burst.ReadAsync, CancellationToken.None))
        {
            while (await coalescer.ReadFrameAsync().WaitAsync(TimeSpan.FromSeconds(2)) is byte[] frame) frames.Add(frame);
        }
        Require(frames.Count < 32 && frames.All(frame => frame.Length is > 0 and <= RdpFrameCipher.MaximumPlainBytes) && frames.SelectMany(frame => frame).SequenceEqual(expected), "Tiny TLS bursts exhausted mailbox frames or lost/reordered coalesced bytes.");
        Require(burst.MaximumConcurrentReads == 1 && burst.ActiveReads == 0, "Output coalescing overlapped reads on the native TLS stream.");

        var irregular = new ScriptedRdpStream(); byte[] firstBytes = [1, 2, 3], crossing = RandomNumberGenerator.GetBytes(RdpFrameCipher.MaximumPlainBytes);
        irregular.Write(firstBytes); irregular.Write(crossing); irregular.End();
        await using (var coalescer = new RdpOutputCoalescer(irregular.ReadAsync, CancellationToken.None))
        {
            byte[]? first = await coalescer.ReadFrameAsync().WaitAsync(TimeSpan.FromSeconds(2)), suffix = await coalescer.ReadFrameAsync().WaitAsync(TimeSpan.FromSeconds(2));
            Require(first?.Length == RdpFrameCipher.MaximumPlainBytes && suffix?.Length == firstBytes.Length && first!.Concat(suffix!).SequenceEqual(firstBytes.Concat(crossing)) && await coalescer.ReadFrameAsync() is null, "A TLS read crossing a 16-KiB frame boundary lost or reordered its retained suffix.");
        }

        var delayed = new ScriptedRdpStream(); delayed.Write(new byte[] { 1, 2, 3 });
        await using (var coalescer = new RdpOutputCoalescer(delayed.ReadAsync, CancellationToken.None))
        {
            byte[]? first = await coalescer.ReadFrameAsync().WaitAsync(TimeSpan.FromSeconds(2));
            Require(first is not null && first.SequenceEqual(new byte[] { 1, 2, 3 }) && delayed.ActiveReads == 1, "A small native output frame waited indefinitely for the next TLS record.");
            delayed.Write(new byte[] { 4, 5 }); delayed.End();
            byte[]? second = await coalescer.ReadFrameAsync().WaitAsync(TimeSpan.FromSeconds(2));
            Require(second is not null && second.SequenceEqual(new byte[] { 4, 5 }) && await coalescer.ReadFrameAsync() is null && delayed.MaximumConcurrentReads == 1, "Timed output flush canceled/restarted a pending TLS read or lost its later bytes.");
        }
        var stalled = new ScriptedRdpStream(); stalled.Write(new byte[] { 9 });
        var cancelCoalescer = new RdpOutputCoalescer(stalled.ReadAsync, CancellationToken.None);
        Require((await cancelCoalescer.ReadFrameAsync().WaitAsync(TimeSpan.FromSeconds(2)))?.Length == 1 && stalled.ActiveReads == 1, "Native stalled-output cancellation fixture never reached its pending read.");
        await cancelCoalescer.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2));
        Require(stalled.ActiveReads == 0 && stalled.CanceledReads == 1, "Native coalescer released cleanup with an outstanding TLS read.");

        var lastCredit = new ScriptedRdpStream(); lastCredit.Write([7]); var lastWindow = new RdpFrameWindow(1);
        using (var cancel = new CancellationTokenSource())
        using (var lastCipher = new RdpFrameCipher(SessionId, RandomNumberGenerator.GetBytes(32)))
        {
            var coalescer = new RdpOutputCoalescer(lastCredit.ReadAsync, cancel.Token);
            byte[]? partial = await coalescer.ReadFrameAsync().WaitAsync(TimeSpan.FromSeconds(2));
            Require(partial is not null && lastCredit.ActiveReads == 1, "Last-credit fixture did not leave its bounded TLS read pending.");
            lastWindow.Add(partial!, lastCipher); CryptographicOperations.ZeroMemory(partial!);
            Task blocked = lastWindow.WaitForCreditAsync(cancel.Token);
            Require(!blocked.IsCompleted && lastWindow.Count == 1, "A partial native frame inflated the final credit window.");
            cancel.Cancel(); await RejectAsync(async () => await blocked, "Last-credit backpressure ignored session cancellation.", cancellation: true);
            await coalescer.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2));
            Require(lastCredit.ActiveReads == 0 && lastCredit.CanceledReads == 1 && lastWindow.Count == 1, "Cancellation at full credit left a carried TLS read or produced an extra encrypted frame.");
            lastWindow.Clear();
        }

        // Exercise the production credit-before-read order. A slow browser
        // retains exactly 64 output frames; its ACK resumes a contiguous drain.
        var full = new ScriptedRdpStream(); byte[] material = RandomNumberGenerator.GetBytes(32);
        for (int sequence = 1; sequence <= 80; sequence++) full.Write(Enumerable.Repeat((byte)sequence, RdpFrameCipher.MaximumPlainBytes).ToArray());
        full.End(); using var cipher = new RdpFrameCipher(SessionId, material); var window = new RdpFrameWindow();
        var sixtyFour = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var eighty = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task PumpAsync()
        {
            await using var coalescer = new RdpOutputCoalescer(full.ReadAsync, CancellationToken.None);
            while (true)
            {
                await window.WaitForCreditAsync(CancellationToken.None); byte[]? bytes = await coalescer.ReadFrameAsync(); if (bytes is null) return;
                try { window.Add(bytes, cipher); } finally { CryptographicOperations.ZeroMemory(bytes); }
                if (window.LastSequence == 64) sixtyFour.TrySetResult(); if (window.LastSequence == 80) eighty.TrySetResult();
            }
        }
        Task pumping = PumpAsync(); await sixtyFour.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Require(window.Count == 64 && !pumping.IsCompleted && full.CompletedReads == 64, "A full native output window continued to read or inflated its credit bound.");
        JsonArray firstPacket = window.Snapshot(); Require(firstPacket.Count == 16 && firstPacket[0]?["seq"]?.GetValue<long>() == 1, "Coalesced output changed the mailbox batch limit.");
        window.Acknowledge(16); await eighty.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Require(window.Count == 64 && window.Snapshot()[0]?["seq"]?.GetValue<long>() == 17, "Browser ACK failed to drain exactly its native output prefix.");
        foreach (JsonNode? value in window.Snapshot())
        {
            long seq = value!["seq"]!.GetValue<long>(); byte[] bytes = ReferenceDecrypt(SessionId, material, seq, value["data"]!.GetValue<string>(), false);
            Require(bytes.Length == RdpFrameCipher.MaximumPlainBytes && bytes.All(b => b == (byte)seq), "Native output coalescing changed bytes at the encrypted credit boundary.");
        }
        DrainLegacyWindow(window, 80); await pumping.WaitAsync(TimeSpan.FromSeconds(2));
        Require(window.Count == 0 && full.ActiveReads == 0, "Final browser ACK left native output frames or socket reads retained.");
        CryptographicOperations.ZeroMemory(material);
        Console.WriteLine("Native RDP output tests passed: tiny-record coalescing, bounded timed flush, single pending read, ordered 64-credit drain and cancellation.");
    }

    private sealed class ScriptedRdpStream
    {
        private readonly Channel<byte[]> chunks = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
        private int active, maximum, completed, canceled;
        internal int ActiveReads => Volatile.Read(ref active);
        internal int MaximumConcurrentReads => Volatile.Read(ref maximum);
        internal int CompletedReads => Volatile.Read(ref completed);
        internal int CanceledReads => Volatile.Read(ref canceled);
        internal void Write(byte[] bytes) => chunks.Writer.TryWrite(bytes);
        internal void End() => Write([]);
        internal async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token)
        {
            int readers = Interlocked.Increment(ref active); maximum = Math.Max(maximum, readers);
            try
            {
                byte[] bytes = await chunks.Reader.ReadAsync(token); Require(bytes.Length <= buffer.Length, "Native stream fixture received a smaller read buffer.");
                bytes.AsSpan().CopyTo(buffer.Span); Interlocked.Increment(ref completed); return bytes.Length;
            }
            catch (OperationCanceledException) { Interlocked.Increment(ref canceled); throw; }
            finally { Interlocked.Decrement(ref active); }
        }
    }

    private static async Task TransportTestsAsync()
    {
        Require(NativeRdpChannel.RemainingPollDelayMs(50, true, false, TimeSpan.FromMilliseconds(40)) == 10 && NativeRdpChannel.RemainingPollDelayMs(20, true, false, TimeSpan.FromMilliseconds(75)) == 0 && NativeRdpChannel.RemainingPollDelayMs(0, true, false, TimeSpan.FromMilliseconds(75)) == 0, "Active native RDP polls added their whole delay after the HTTP round trip.");
        Require(NativeRdpChannel.RemainingPollDelayMs(1000, false, false, TimeSpan.FromMilliseconds(75)) == 1000 && NativeRdpChannel.RemainingPollDelayMs(1000, true, true, TimeSpan.FromMilliseconds(75)) == 1000, "RDP pacing shortened idle polling or HTTP failure backoff.");
        // The actual startup gate must wait through an unacknowledged/failed
        // heartbeat, start once acknowledged, and shut down before readiness.
        var ready = new AgentHeartbeatGate(); bool started = false;
        Task remoteDesktop = ready.RunAsync(_ => { started = true; return Task.CompletedTask; }, CancellationToken.None);
        await Task.Yield(); Require(!started && !remoteDesktop.IsCompleted, "RDP polled before its first accepted capability heartbeat.");
        ready.Acknowledge(); ready.Acknowledge(); await remoteDesktop.WaitAsync(TimeSpan.FromSeconds(2));
        Require(started, "The first accepted heartbeat failed to release the RDP channel.");
        using (var canceled = new CancellationTokenSource())
        {
            var neverReady = new AgentHeartbeatGate(); bool opened = false;
            Task pending = neverReady.RunAsync(_ => { opened = true; return Task.CompletedTask; }, canceled.Token);
            canceled.Cancel(); await RejectAsync(async () => await pending, "Stopping before a heartbeat left a blocked RDP startup.", cancellation: true);
            neverReady.Acknowledge(); Require(!opened, "A canceled startup later created a Remote Desktop transport.");
        }

        const string agentToken = "TEST-AGENT-CREDENTIAL";
        var secrets = new JsonObject { ["token"] = agentToken };
        using var http = new HttpClient(new FixtureHttpHandler(request =>
        {
            Require(request.Method == HttpMethod.Post && request.RequestUri?.AbsolutePath == "/api/agent/rdp", "Native RDP used the wrong HTTP method or route.");
            Require(request.Headers.Authorization?.Parameter == agentToken, "Native HTTP transport dropped the registered authentication header.");
            return new HttpResponseMessage(HttpStatusCode.Conflict) { Content = new StringContent(new JsonObject { ["error"] = "Capability heartbeat missing\r\n" + agentToken, ["code"] = "RDP_AGENT_NOT_READY", ["payload"] = "NEVER-LOG-RESPONSE-PAYLOAD" }.ToJsonString(), Encoding.UTF8, "application/json") };
        })) { BaseAddress = new Uri("https://portal.example") };
        http.DefaultRequestHeaders.Authorization = new("Bearer", agentToken);
        HttpRequestException failure = await HttpFailureAsync(http, secrets);
        Require(failure.StatusCode == HttpStatusCode.Conflict && failure.Message.Contains("HTTP 409 from /api/agent/rdp") && failure.Message.Contains("Capability heartbeat missing") && failure.Message.Contains("RDP_AGENT_NOT_READY"), "Native HTTP errors lost the route, status or structured portal diagnostic.");
        Require(!failure.Message.Contains(agentToken) && !failure.Message.Contains("NEVER-LOG-RESPONSE-PAYLOAD") && !failure.Message.Any(char.IsControl), "Native HTTP diagnostics disclosed authentication or arbitrary response fields.");
        string crossingLimit = new string('x', 490) + agentToken;
        using var cutoff = Client(HttpStatusCode.ServiceUnavailable, new JsonObject { ["error"] = crossingLimit }.ToJsonString());
        failure = await HttpFailureAsync(cutoff, secrets);
        Require(!failure.Message.Contains("TEST-AGENT"), "Truncating an HTTP diagnostic disclosed the beginning of a credential.");

        using var html = Client(HttpStatusCode.NotFound, "<html>DO-NOT-LOG-RAW-ERROR-PAGE</html>", "text/html");
        failure = await HttpFailureAsync(html, secrets); Require(failure.StatusCode == HttpStatusCode.NotFound && !failure.Message.Contains("DO-NOT-LOG"), "Native HTTP diagnostics included a raw proxy error page.");
        using var malformed = Client(HttpStatusCode.BadGateway, "{not json");
        failure = await HttpFailureAsync(malformed, secrets); Require(failure.StatusCode == HttpStatusCode.BadGateway && failure.Message.Length < 100, "Malformed JSON masked the actual HTTP status.");
        using var oversizedError = Client(HttpStatusCode.ServiceUnavailable, new string('x', 8193));
        failure = await HttpFailureAsync(oversizedError, secrets); Require(failure.StatusCode == HttpStatusCode.ServiceUnavailable && failure.Message.Length < 100, "Oversized error diagnostics masked the status or entered logs.");
        using var valid = Client(HttpStatusCode.OK, "{\"sessions\":[],\"intervalMs\":1000}");
        JsonObject response = await AgentHttpTransport.PostAsync(valid, "/api/agent/rdp", new JsonObject(), CancellationToken.None);
        Require(response["sessions"] is JsonArray && response["intervalMs"]?.GetValue<int>() == 1000, "Bounded native HTTP transport changed a valid authoritative RDP response.");
        using var oversizedSuccess = Client(HttpStatusCode.OK, new string('x', 2_097_153));
        await RejectAsync(async () => await AgentHttpTransport.PostAsync(oversizedSuccess, "/api/agent/rdp", new JsonObject(), CancellationToken.None), "Unbounded portal data entered a successful native RDP response.");
        using var stopped = new CancellationTokenSource(); stopped.Cancel();
        await RejectAsync(async () => await AgentHttpTransport.PostAsync(valid, "/api/agent/rdp", new JsonObject(), stopped.Token), "Canceled native HTTP requests continued.", cancellation: true);
        var stalledBody = new StalledHttpStream();
        using var stalled = new HttpClient(new FixtureHttpHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(stalledBody) })) { BaseAddress = new Uri("https://portal.example"), Timeout = TimeSpan.FromMilliseconds(75) };
        await RejectAsync(async () => await AgentHttpTransport.PostAsync(stalled, "/api/agent/rdp", new JsonObject(), CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2)), "An HTTP body stalled past the channel timeout.", cancellation: true);
        Require(stalledBody.Disposed, "A timed-out channel body retained its HTTP stream.");
    }

    private static HttpClient Client(HttpStatusCode status, string body, string mediaType = "application/json") => new(new FixtureHttpHandler(_ => new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, mediaType) })) { BaseAddress = new Uri("https://portal.example") };
    private static async Task<HttpRequestException> HttpFailureAsync(HttpClient http, JsonObject config)
    {
        try { await AgentHttpTransport.PostAsync(http, "/api/agent/rdp", new JsonObject { ["sessions"] = new JsonArray() }, CancellationToken.None, config); }
        catch (HttpRequestException failure) { return failure; }
        throw new Exception("An unsuccessful native HTTP response was accepted.");
    }

    private sealed class FixtureHttpHandler(Func<HttpRequestMessage, HttpResponseMessage> reply) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested(); return Task.FromResult(reply(request));
        }
    }

    private sealed class StalledHttpStream : Stream
    {
        internal bool Disposed { get; private set; }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) { await Task.Delay(Timeout.Infinite, cancellationToken); return 0; }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { Disposed = true; base.Dispose(disposing); }
    }

    private static void CipherTests()
    {
        byte[] key = Enumerable.Range(0, 32).Select(value => (byte)value).ToArray();
        byte[] plain = Encoding.UTF8.GetBytes("RDP frame\0with bytes: ä\u6f22");
        using var cipher = new RdpFrameCipher(SessionId, key);
        foreach (long sequence in new[] { 1L, 17L, 4294967296L, MaximumSequence })
        {
            string expectedOut = ReferenceEncrypt(SessionId, key, sequence, plain, input: false);
            string actualOut = cipher.Encrypt(sequence, plain);
            Require(actualOut == expectedOut, "Agent RDP nonce, AAD or ciphertext differs from the browser wire contract.");
            Require(ReferenceDecrypt(SessionId, key, sequence, actualOut, input: false).SequenceEqual(plain), "Browser could not decrypt an agent frame.");
            string expectedIn = ReferenceEncrypt(SessionId, key, sequence, plain, input: true);
            Require(cipher.Decrypt(sequence, expectedIn).SequenceEqual(plain), "Agent could not decrypt a browser frame.");
            Require(RdpFrameCipher.EncryptDirection(SessionId, key, sequence, plain, true) == expectedIn, "Input encryption used an incorrect nonce direction.");
            Require(RdpFrameCipher.DecryptDirection(SessionId, key, sequence, actualOut, false).SequenceEqual(plain), "Explicit output decryption used an incorrect nonce direction.");
            Reject(() => cipher.Decrypt(sequence, actualOut), "An output frame was accepted as input under the same key.");
        }
        string encrypted = ReferenceEncrypt(SessionId, key, 1, plain, input: true);
        byte[] changed = Convert.FromBase64String(encrypted); changed[0] ^= 1;
        Reject(() => cipher.Decrypt(1, Convert.ToBase64String(changed)), "Tampered RDP ciphertext was accepted.");
        changed = Convert.FromBase64String(encrypted); changed[^1] ^= 1;
        Reject(() => cipher.Decrypt(1, Convert.ToBase64String(changed)), "Tampered RDP authentication tag was accepted.");
        Reject(() => cipher.Decrypt(2, encrypted), "RDP ciphertext was accepted under another sequence.");
        Reject(() => RdpFrameCipher.DecryptDirection(Guid.NewGuid().ToString(), key, 1, encrypted, true), "RDP ciphertext was accepted in another session.");
        Reject(() => cipher.Decrypt(1, "not base64!"), "Malformed RDP frame encoding was accepted.");
        Reject(() => cipher.Decrypt(1, encrypted + "\n"), "Noncanonical whitespace in RDP frame base64 was accepted.");
        string padded = ReferenceEncrypt(SessionId, key, 1, new byte[] { 1 }, input: true);
        const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        char[] alternate = padded.ToCharArray(); alternate[^2] = alphabet[alphabet.IndexOf(alternate[^2]) | 1]; string noncanonical = new(alternate);
        Require(Convert.FromBase64String(noncanonical).SequenceEqual(Convert.FromBase64String(padded)), "Noncanonical base64 test vector changed the decoded bytes.");
        Reject(() => cipher.Decrypt(1, noncanonical), "Noncanonical RDP base64 padding bits were accepted.");
        Reject(() => cipher.Decrypt(1, Convert.ToBase64String(new byte[15])), "An RDP frame shorter than its GCM tag was accepted.");
        foreach (long sequence in new[] { -1L, 0L, MaximumSequence + 1 })
        {
            Reject(() => cipher.Encrypt(sequence, plain), "An invalid RDP output sequence was accepted.");
            Reject(() => cipher.Decrypt(sequence, encrypted), "An invalid RDP input sequence was accepted.");
        }
        foreach (int length in new[] { 0, 16, 31, 33, 64 })
            Reject(() => { using var invalid = new RdpFrameCipher(SessionId, new byte[length]); }, "An invalid AES-256 session key was accepted.");
        byte[] maximum = RandomNumberGenerator.GetBytes(16384);
        string largest = cipher.Encrypt(101, maximum);
        Require(Convert.FromBase64String(largest).Length == 16400 && largest.Length == 21868, "Maximum RDP frame exceeded its declared wire limits.");
        Reject(() => cipher.Encrypt(102, new byte[16385]), "Oversized plaintext entered the RDP output queue.");
        Reject(() => cipher.Decrypt(102, ReferenceEncrypt(SessionId, key, 102, new byte[16385], true)), "Oversized authenticated input was accepted.");
        // Constructor ownership must not let a caller change an active session key.
        using var owned = new RdpFrameCipher(SessionId, key); byte[] initialKey = (byte[])key.Clone(); key[0] ^= 1;
        Require(owned.Encrypt(1, plain) == ReferenceEncrypt(SessionId, initialKey, 1, plain, false), "Caller mutation changed a live RDP cipher key.");
    }

    private static void KeyEnvelopeTests()
    {
        using RSA rsa = RSA.Create(2048); var parameters = rsa.ExportParameters(true);
        string Field(string name, byte[]? value) => "<" + name + ">" + Convert.ToBase64String(value!) + "</" + name + ">";
        string xml = "<RSAKeyValue>" + Field("Modulus", parameters.Modulus) + Field("Exponent", parameters.Exponent) + Field("D", parameters.D) + Field("P", parameters.P) + Field("Q", parameters.Q) + Field("DP", parameters.DP) + Field("DQ", parameters.DQ) + Field("InverseQ", parameters.InverseQ) + "</RSAKeyValue>";
        byte[] material = RandomNumberGenerator.GetBytes(32);
        string Seal(JsonNode value, RSAEncryptionPadding? padding = null) => Convert.ToBase64String(rsa.Encrypt(Encoding.UTF8.GetBytes(value.ToJsonString()), padding ?? RSAEncryptionPadding.OaepSHA256));
        var clear = new JsonObject { ["id"] = SessionId, ["key"] = Convert.ToBase64String(material) }; string envelope = Seal(clear);
        byte[] opened = NativeRdpChannel.OpenKey(envelope, SessionId, xml);
        Require(opened.SequenceEqual(material), "RSA-OAEP/SHA-256 did not recover the browser's exact RDP session key."); CryptographicOperations.ZeroMemory(opened);
        Reject(() => NativeRdpChannel.OpenKey(envelope, Guid.NewGuid().ToString(), xml), "An RDP key envelope was accepted for another session.");
        Reject(() => NativeRdpChannel.OpenKey(Seal(clear, RSAEncryptionPadding.OaepSHA1), SessionId, xml), "The RDP key envelope accepted legacy SHA-1 padding.");
        Reject(() => NativeRdpChannel.OpenKey(Seal(clear, RSAEncryptionPadding.Pkcs1), SessionId, xml), "The RDP key envelope accepted PKCS#1 v1.5 padding.");
        Reject(() => NativeRdpChannel.OpenKey(envelope + "\n", SessionId, xml), "Noncanonical ciphertext base64 was accepted in an RDP key envelope.");
        Reject(() => NativeRdpChannel.OpenKey("invalid!", SessionId, xml), "Malformed RDP key envelope encoding was accepted.");
        Reject(() => NativeRdpChannel.OpenKey(Convert.ToBase64String(new byte[255]), SessionId, xml), "An incorrectly sized RSA ciphertext was accepted.");
        foreach (int length in new[] { 0, 16, 31, 33, 64 })
            Reject(() => NativeRdpChannel.OpenKey(Seal(new JsonObject { ["id"] = SessionId, ["key"] = Convert.ToBase64String(new byte[length]) }), SessionId, xml), "An RDP sealed key with an invalid AES-256 length was accepted.");
        Reject(() => NativeRdpChannel.OpenKey(Seal(new JsonObject { ["id"] = SessionId, ["key"] = Convert.ToBase64String(material) + "\n" }), SessionId, xml), "Noncanonical session key encoding was accepted.");
        Reject(() => NativeRdpChannel.OpenKey(Seal(new JsonObject { ["id"] = SessionId, ["key"] = Convert.ToBase64String(material), ["password"] = "credential-injection" }), SessionId, xml), "Unexpected credential fields were accepted in the sealed RDP key.");
        Reject(() => NativeRdpChannel.OpenKey(Seal(new JsonArray()), SessionId, xml), "A nonobject RDP key envelope was accepted.");
        using RSA other = RSA.Create(2048);
        string wrongDevice = Convert.ToBase64String(other.Encrypt(Encoding.UTF8.GetBytes(clear.ToJsonString()), RSAEncryptionPadding.OaepSHA256));
        Reject(() => NativeRdpChannel.OpenKey(wrongDevice, SessionId, xml), "An RDP key sealed to another device was accepted.");
        CryptographicOperations.ZeroMemory(material);
    }

    private static void CleanPathTests()
    {
        // Captured from the pinned IronRDP browser SDK's real first Blob. This
        // crosses the browser/native boundary rather than reusing our encoder.
        const string sdkSession = "11111111-1111-4111-8111-111111111111";
        byte[] sdkRequest = Convert.FromBase64String("MG6gBAICDT6iEAwObG9jYWxob3N0OjMzODmjJgwkMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExpiwEKgMAACol4AAAAAAAQ29va2llOiBtc3RzaGFzaD10ZXN0DQoBAAgACwAAAA==");
        byte[] sdkTpkt = RdpCleanPath.ReadRequest(sdkRequest, sdkSession);
        Require(sdkTpkt.SequenceEqual(Convert.FromHexString("0300002A25E00000000000436F6F6B69653A206D737473686173683D746573740D0A010008000B000000")) && BinaryPrimitives.ReadUInt32LittleEndian(sdkTpkt.AsSpan(sdkTpkt.Length - 4)) == 11, "Native RDCleanPath rejected or changed the real browser SDK request.");
        byte[] request = Request();
        Require(RdpCleanPath.ReadRequest(request, SessionId).SequenceEqual(RequestTpkt), "RDCleanPath changed the original X.224 request.");
        byte[] classicRequest = (byte[])RequestTpkt.Clone(); BinaryPrimitives.WriteUInt32LittleEndian(classicRequest.AsSpan(15), 0);
        byte[] tlsOnlyRequest = (byte[])RequestTpkt.Clone(); BinaryPrimitives.WriteUInt32LittleEndian(tlsOnlyRequest.AsSpan(15), 1);
        foreach (byte[] malformed in new[]
        {
            Request(version: 3389), Request(destination: "127.0.0.1:3389"), Request(destination: "localhost:3390"),
            Request(destination: "server.example:3389"), Request(destination: "localhost:3389\0other"),
            Request(auth: Guid.NewGuid().ToString()), Request(auth: SessionId + ":password"),
            Request(extraTag: 4), Request(extraTag: 5), Request(extraTag: 8), Request(duplicateDestination: true),
            Request(omitAuthentication: true), Request(x224: new byte[16385]), Request(x224: classicRequest), Request(x224: tlsOnlyRequest), request[..^1],
            request.Concat(new byte[] { 0 }).ToArray(), new byte[] { 0x30, 0x80, 0, 0 }
        }) Reject(() => RdpCleanPath.ReadRequest(malformed, SessionId), "Malformed, credential-bearing or nonlocal RDCleanPath request was accepted.");

        byte[] confirm = Confirm(2), certificate = new byte[] { 0x30, 0x00 };
        var reader = new AsnReader(RdpCleanPath.Response(confirm, [certificate], 3391), AsnEncodingRules.DER);
        var response = reader.ReadSequence();
        Require(ReadInteger(response, 0) == 3390, "RDCleanPath response has the wrong protocol version.");
        Require(ReadBytes(response, 6).SequenceEqual(confirm), "RDCleanPath response changed the original X.224 confirmation.");
        var certificatesTag = response.ReadSequence(Context(7)); var certificates = certificatesTag.ReadSequence();
        Require(certificates.ReadOctetString().SequenceEqual(certificate), "RDCleanPath response omitted the actual certificate bytes.");
        certificates.ThrowIfNotEmpty(); certificatesTag.ThrowIfNotEmpty();
        var addressTag = response.ReadSequence(Context(9)); string address = addressTag.ReadCharacterString(UniversalTagNumber.UTF8String);
        Require(address.EndsWith(":3391", StringComparison.Ordinal), "RDCleanPath response did not report the configured local listener port.");
        addressTag.ThrowIfNotEmpty(); response.ThrowIfNotEmpty(); reader.ThrowIfNotEmpty();
        byte[] largeCertificate = RandomNumberGenerator.GetBytes(8192);
        byte[] largeResponse = RdpCleanPath.Response(confirm, [largeCertificate, largeCertificate, largeCertificate], 3389);
        Require(largeResponse.Length is > 16384 and <= 65536, "A valid multi-certificate RDCleanPath response could not span encrypted transport frames.");
        Reject(() => RdpCleanPath.Response(confirm, Enumerable.Range(0, 8).Select(_ => largeCertificate), 3389), "An RDCleanPath response exceeded the browser's 64-KiB reassembly limit.");
        Reject(() => RdpCleanPath.Response(confirm, [new byte[8193]], 3389), "An oversized RDP certificate entered the handshake.");
        RdpCleanPath.RequireNla(Confirm(2)); RdpCleanPath.RequireNla(Confirm(8));
        foreach (byte[] unsafeConfirm in new[] { Confirm(0), Confirm(1), Confirm(3), Confirm(2, type: 3), Confirm(2)[..^1], RequestTpkt, new byte[] { 3, 0, 0, 4 } })
            Reject(() => RdpCleanPath.RequireNla(unsafeConfirm), "The native proxy accepted a downgrade or malformed RDP negotiation response.");
    }

    private static void InputLedgerTests()
    {
        byte[] key = RandomNumberGenerator.GetBytes(32);
        string Frame(long sequence, string text) => ReferenceEncrypt(SessionId, key, sequence, Encoding.UTF8.GetBytes(text), input: true);
        string one = Frame(1, "one"); var ledger = new RdpInputLedger();
        Require(ledger.Ack == 0 && ledger.Validate(1, one), "RDP input did not start at the first contiguous sequence.");
        Require(ledger.Ack == 0, "Validating RDP input acknowledged bytes before delivery to Windows.");
        ledger.Commit(1, one);
        Require(ledger.Ack == 1 && !ledger.Validate(1, one), "An identical RDP retry would be delivered twice.");
        Reject(() => ledger.Validate(1, Frame(1, "changed")), "A changed retry reused an RDP sequence.");
        Reject(() => ledger.Validate(3, Frame(3, "gap")), "An RDP input gap was accepted.");
        Reject(() => ledger.Validate(0, one), "A nonpositive RDP input sequence was accepted.");
        Reject(() => ledger.Validate(MaximumSequence + 1, one), "An unsafe integer input sequence was accepted.");
        for (long sequence = 2; sequence <= 70; sequence++)
        {
            string data = Frame(sequence, "frame-" + sequence);
            Require(ledger.Validate(sequence, data), "A contiguous RDP frame was rejected."); ledger.Commit(sequence, data);
        }
        Require(ledger.Ack == 70 && !ledger.Validate(70, Frame(70, "frame-70")), "The latest RDP receipt did not survive acknowledgement.");
        Reject(() => ledger.Validate(1, one), "An expired replay receipt silently accepted unverifiable old input.");
        Reject(() => ledger.Validate(70, Frame(70, "different")), "An acknowledged RDP input frame changed without rejection.");
    }

    private static void AvailabilityTests()
    {
        JsonObject enabled = NativeRdpAvailability.ReadValues(0, null, 1, 2, 3391);
        Require(enabled["enabled"]!.GetValue<bool>() && enabled["nla"]!.GetValue<bool>() && enabled["port"]!.GetValue<int>() == 3391 && !enabled["policyBlocked"]!.GetValue<bool>(), "Native RDP availability misreported a secure custom-port listener.");
        JsonObject denied = NativeRdpAvailability.ReadValues(0, 1, 1, 2, 3389);
        Require(!denied["enabled"]!.GetValue<bool>() && denied["policyBlocked"]!.GetValue<bool>(), "A domain RDP deny policy was overridden by local settings.");
        JsonObject allowed = NativeRdpAvailability.ReadValues(1, 0, 0, 0, 3389, 1, 2);
        Require(allowed["enabled"]!.GetValue<bool>() && allowed["nla"]!.GetValue<bool>(), "Native RDP availability ignored authoritative secure domain policy.");
        foreach (int? invalidPort in new int?[] { null, 0, -1, 65536 })
            Require(NativeRdpAvailability.ReadValues(0, null, 1, 2, invalidPort)["port"]!.GetValue<int>() == 3389, "An invalid local RDP port entered availability metadata.");
        Require(!NativeRdpAvailability.ReadValues(null, null, null, null, null)["enabled"]!.GetValue<bool>(), "Missing registry settings were reported as an enabled RDP listener.");
        Require(NativeRdpAvailability.ReadValues(0, null, 1, 2, 3389, 0, null)["policyBlocked"]!.GetValue<bool>() && !NativeRdpAvailability.ReadValues(0, null, 1, 2, 3389, 0, null)["nla"]!.GetValue<bool>(), "A domain NLA disable policy was ignored.");
        Require(NativeRdpAvailability.ReadValues(0, null, 1, 2, 3389, null, 0)["policyBlocked"]!.GetValue<bool>(), "A domain classic RDP security policy was ignored.");
    }

    private static async Task WindowTestsAsync()
    {
        byte[] key = RandomNumberGenerator.GetBytes(32); using var cipher = new RdpFrameCipher(SessionId, key);
        var window = new RdpFrameWindow(64);
        for (int sequence = 1; sequence <= 64; sequence++) window.Add(Encoding.UTF8.GetBytes("output-" + sequence), cipher);
        Require(window.Count == 64 && window.LastSequence == 64 && window.Acknowledged == 0, "RDP output credit did not bound the retained window.");
        var packet = window.Snapshot();
        Require(packet.Count == 16 && packet[0]?["seq"]?.GetValue<long>() == 1 && packet[^1]?["seq"]?.GetValue<long>() == 16, "RDP output did not select the first bounded contiguous packet.");
        for (int index = 0; index < packet.Count; index++)
        {
            string data = packet[index]!["data"]!.GetValue<string>();
            Require(Encoding.UTF8.GetString(ReferenceDecrypt(SessionId, key, index + 1, data, false)) == "output-" + (index + 1), "RDP retained output was reordered or changed.");
        }
        string retained = packet[0]!["data"]!.GetValue<string>(); packet[0]!["data"] = "mutated external snapshot";
        Require(window.Snapshot()[0]?["data"]?.GetValue<string>() == retained, "RDP snapshots exposed mutable retained ciphertext.");
        Reject(() => window.Add(new byte[] { 1 }, cipher), "A full RDP output window silently dropped or overcommitted bytes.");
        Reject(() => window.Acknowledge(65), "A future RDP output ACK skipped undelivered bytes.");
        Reject(() => window.Acknowledge(-1), "A negative RDP output ACK was accepted.");
        Task credit = window.WaitForCreditAsync(CancellationToken.None);
        await Task.Yield(); Require(!credit.IsCompleted, "A full RDP queue granted additional output credit.");
        window.Acknowledge(16); await credit.WaitAsync(TimeSpan.FromSeconds(2));
        Require(window.Count == 48 && window.Acknowledged == 16 && window.Snapshot()[0]?["seq"]?.GetValue<long>() == 17, "RDP ACK did not release exactly its retained prefix.");
        window.Acknowledge(16); Require(window.Count == 48, "A repeated RDP ACK deleted additional output.");
        for (int sequence = 65; sequence <= 80; sequence++) window.Add(new byte[] { (byte)sequence }, cipher);
        using (var cancel = new CancellationTokenSource())
        {
            Task waiting = window.WaitForCreditAsync(cancel.Token); cancel.Cancel();
            await RejectAsync(async () => await waiting, "RDP credit wait ignored transport cancellation.", cancellation: true);
        }
        DrainLegacyWindow(window, 80);
        Require(window.Count == 0 && window.LastSequence == 80 && window.Snapshot().Count == 0, "Final RDP ACK failed to release screen payloads.");
        await window.WaitForCreditAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2));
    }

    private static void DrainLegacyWindow(RdpFrameWindow window, long through)
    {
        while (window.Acknowledged < through)
        {
            JsonArray delivered = window.Snapshot(); Require(delivered.Count != 0, "Legacy native drain stalled before all produced bytes were uploaded.");
            window.Acknowledge(Math.Min(through, delivered[^1]!["seq"]!.GetValue<long>()));
        }
    }

    private static async Task StoredWindowTestsAsync()
    {
        byte[] key = RandomNumberGenerator.GetBytes(32); using var cipher = new RdpFrameCipher(SessionId, key);
        var window = new RdpFrameWindow(); var immutable = new Dictionary<long, string>();
        for (int seq = 1; seq <= 64; seq++) window.Add(Encoding.UTF8.GetBytes("stored-output-" + seq), cipher);
        Require(window.HasPendingUpload && window.HighestSent == 0, "Produced RDP frames were treated as already uploaded.");
        Reject(() => window.Acknowledge(1, 1), "A portal watermark acknowledged output that was produced but never selected for upload.");
        Task credit = window.WaitForCreditAsync(CancellationToken.None);
        for (int first = 1; first <= 64; first += 16)
        {
            JsonArray packet = window.Snapshot(); string exact = packet.ToJsonString();
            Require(packet.Count == 16 && packet[0]?["seq"]?.GetValue<long>() == first && packet[^1]?["seq"]?.GetValue<long>() == first + 15, "Storage ACK failed to pipeline the next contiguous 16 native frames.");
            Require(window.Snapshot().ToJsonString() == exact, "A native upload retry changed encrypted bytes before storage ACK.");
            if (first == 1) Reject(() => window.Acknowledge(8, 7), "Browser consumption exceeded its storage watermark while both were below the highest sent frame.");
            foreach (JsonNode? value in packet) immutable.Add(value!["seq"]!.GetValue<long>(), value["data"]!.GetValue<string>());
            Reject(() => window.Acknowledge(0, first + 16), "A forged storage watermark exceeded the highest uploaded output frame.");
            Require(window.Acknowledge(0, first + 15) && window.Stored == first + 15 && window.HighestSent == first + 15 && window.Count == 64 && window.Acknowledged == 0 && !credit.IsCompleted, "Storage acknowledgement released browser credit or dropped retained native ciphertext.");
        }
        Require(!window.HasPendingUpload && window.Snapshot().Count == 0 && window.Count == 64, "Already stored output was pointlessly re-uploaded or discarded before browser consumption.");
        Require(!window.Acknowledge(0, 64), "An identical storage watermark falsely reported progress.");
        Reject(() => window.Add(new byte[] { 65 }, cipher), "Storage ACK inflated the 64-frame browser credit bound.");
        Reject(() => window.Acknowledge(0, 48), "A stale storage watermark regressed the native upload pipeline.");
        Reject(() => window.Acknowledge(0), "A portal omitted its storage watermark after the native pipeline was negotiated.");
        Reject(() => window.Acknowledge(65, 64), "Browser consumption exceeded committed uploaded output.");
        window.Acknowledge(16, 64); await credit.WaitAsync(TimeSpan.FromSeconds(2));
        Require(window.Count == 48 && window.Acknowledged == 16 && !window.HasPendingUpload, "Browser ACK failed to free exactly its consumed native prefix.");
        Reject(() => window.Acknowledge(8, 64), "A stale browser consumption ACK regressed the native output window.");
        for (int seq = 65; seq <= 80; seq++) window.Add(Encoding.UTF8.GetBytes("stored-output-" + seq), cipher);
        JsonArray resumed = window.Snapshot();
        Require(window.Count == 64 && resumed.Count == 16 && resumed[0]?["seq"]?.GetValue<long>() == 65 && resumed[^1]?["seq"]?.GetValue<long>() == 80, "Released browser credit failed to resume output at a fresh contiguous sequence.");
        window.Acknowledge(16, 80); Require(window.Snapshot().Count == 0 && window.Count == 64, "The resumed native upload was not retained behind storage acknowledgement.");
        foreach (var (seq, data) in immutable) Require(Encoding.UTF8.GetString(ReferenceDecrypt(SessionId, key, seq, data, false)) == "stored-output-" + seq, "Native pipeline retransmission changed immutable output ciphertext.");
        window.Acknowledge(80, 80); Require(window.Count == 0 && !window.HasPendingUpload, "Final browser ACK retained native output ciphertext or pending uploads.");

        using var legacyCipher = new RdpFrameCipher(Guid.NewGuid().ToString(), RandomNumberGenerator.GetBytes(32));
        var legacy = new RdpFrameWindow(); for (int seq = 1; seq <= 40; seq++) legacy.Add(new byte[] { (byte)seq }, legacyCipher);
        string firstPacket = legacy.Snapshot().ToJsonString(); legacy.Acknowledge(0);
        Require(legacy.Snapshot().ToJsonString() == firstPacket && legacy.HasPendingUpload, "An old portal without outputStored skipped the first unconsumed output batch.");
        legacy.Acknowledge(16); Require(legacy.Snapshot()[0]?["seq"]?.GetValue<long>() == 17, "Legacy consumption ACK failed to advance the first-unconsumed batch.");
        legacy.Acknowledge(16, 32); Require(legacy.Snapshot()[0]?["seq"]?.GetValue<long>() == 33, "Native output failed to negotiate storage watermark support after a legacy exchange.");
        Reject(() => legacy.Acknowledge(16), "A negotiated storage watermark silently fell back to legacy retransmission.");
        legacy.Acknowledge(40, 40); Require(legacy.Count == 0, "Negotiated native output could not finish its consumed drain.");
        CryptographicOperations.ZeroMemory(key);
        Console.WriteLine("Native RDP storage pipeline tests passed: four immutable 16-frame uploads, independent stored/consumed ACKs, strict sent bounds, credit retention/recovery and legacy fallback.");
    }

    private static async Task TpktTestsAsync()
    {
        byte[] packet = Confirm(2);
        using (var fragmented = new FragmentedStream(packet))
            Require((await RdpCleanPath.ReadTpktAsync(fragmented, CancellationToken.None)).SequenceEqual(packet), "Fragmented TPKT reads lost the X.224 confirmation.");
        foreach (byte[] invalid in new[] { packet[..^1], new byte[] { 3, 0, 0 }, new byte[] { 2, 0, 0, 4 }, new byte[] { 3, 1, 0, 4 }, new byte[] { 3, 0, 0, 3 } })
        {
            using var stream = new FragmentedStream(invalid);
            await RejectAsync(async () => { await RdpCleanPath.ReadTpktAsync(stream, CancellationToken.None); }, "Invalid or truncated TPKT confirmation was accepted.");
        }
        using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
        using var input = new FragmentedStream(packet);
        await RejectAsync(async () => { await RdpCleanPath.ReadTpktAsync(input, cancellation.Token); }, "A canceled native RDP read continued.", cancellation: true);
    }

    private static async Task NativeTlsTestsAsync()
    {
        using RSA rsa = RSA.Create(2048);
        var request = new CertificateRequest("CN=localhost", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        var purposes = new OidCollection { new Oid("1.3.6.1.5.5.7.3.1") };
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(purposes, true));
        var names = new SubjectAlternativeNameBuilder(); names.AddDnsName("localhost"); names.AddIpAddress(IPAddress.Loopback);
        request.CertificateExtensions.Add(names.Build());
        using X509Certificate2 valid = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddHours(1));
        using X509Certificate2 expired = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddHours(-2), DateTimeOffset.UtcNow.AddHours(-1));
        using X509Certificate2 future = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddHours(1), DateTimeOffset.UtcNow.AddHours(2));
        byte[] payload = RandomNumberGenerator.GetBytes(4097);
        await WithTlsPeerAsync(valid, async port =>
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            using var proxy = await NativeRdpProxy.ConnectAsync(Request(), SessionId, port, valid.Thumbprint, timeout.Token);
            CheckProxyResponse(proxy.Response, valid.RawData, port);
            await proxy.WriteAsync(payload, timeout.Token);
            byte[] received = new byte[payload.Length]; int consumed = 0;
            while (consumed < received.Length)
            {
                int count = await proxy.ReadAsync(received.AsMemory(consumed), timeout.Token);
                if (count == 0) throw new Exception("Native RDP TLS tunnel closed before relaying all bytes."); consumed += count;
            }
            Require(received.SequenceEqual(payload), "Native RDP TLS relay changed an opaque RDP byte stream.");
        }, echo: true);
        await WithTlsPeerAsync(valid, async port =>
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            await RejectAsync(async () => { using var proxy = await NativeRdpProxy.ConnectAsync(Request(), SessionId, port, new string('0', 40), timeout.Token); }, "Native RDP TLS accepted an unpinned local certificate.");
        });
        await WithTlsPeerAsync(expired, async port =>
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            await RejectAsync(async () => { using var proxy = await NativeRdpProxy.ConnectAsync(Request(), SessionId, port, expired.Thumbprint, timeout.Token); }, "Native RDP TLS accepted an expired pinned certificate.");
        });
        await WithTlsPeerAsync(future, async port =>
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            await RejectAsync(async () => { using var proxy = await NativeRdpProxy.ConnectAsync(Request(), SessionId, port, future.Thumbprint, timeout.Token); }, "Native RDP TLS accepted a pinned certificate that is not yet valid.");
        });
        await WithTlsPeerAsync(valid, async port =>
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            await RejectAsync(async () => { using var proxy = await NativeRdpProxy.ConnectAsync(Request(), SessionId, port, valid.Thumbprint, timeout.Token); }, "Native RDP TLS negotiated without NLA.");
        }, protocol: 1);
    }

    private static async Task SessionLeaseTestsAsync()
    {
        string root = Path.Combine(Path.GetTempPath(), "ServerDesk-RdpLease-" + Guid.NewGuid().ToString("N"));
        byte[] key = RandomNumberGenerator.GetBytes(32); var config = new JsonObject { ["mode"] = "ReadOnly" };
        RdpSession? first = null, second = null;
        try
        {
            using (var installation = AgentUpdateLease.Acquire(root))
                Reject(() => { var rejected = new RdpSession(Guid.NewGuid().ToString(), root, config, key, DateTimeOffset.UtcNow.AddMinutes(1), () => { }); }, "An exclusive installation lease permitted RDP session admission.");
            string firstId = Guid.NewGuid().ToString();
            first = new RdpSession(firstId, root, config, key, DateTimeOffset.UtcNow.AddMinutes(1), () => { });
            Require(!first.Snapshot().ContainsKey("error"), "A healthy RDP snapshot sent an invalid empty error field.");
            second = new RdpSession(Guid.NewGuid().ToString(), root, config, key, DateTimeOffset.UtcNow.AddMinutes(1), () => { });
            Reject(() => { using var installation = AgentUpdateLease.Acquire(root); }, "An installer crossed an active RDP activity lease.");
            first.Accept(new JsonObject
            {
                ["outputAck"] = 0L,
                ["input"] = new JsonArray(new JsonObject { ["seq"] = 1L, ["data"] = RdpFrameCipher.EncryptDirection(firstId, key, 1, Request(auth: firstId), true) })
            });
            async Task WaitUntilClosedAsync() { while (first.Alive) await Task.Delay(5); }
            await WaitUntilClosedAsync().WaitAsync(TimeSpan.FromSeconds(2));
            JsonObject rejectedSnapshot = first.Snapshot();
            Require(rejectedSnapshot["state"]!.GetValue<string>() == "error" && rejectedSnapshot["inputAck"]!.GetValue<long>() == 0 && rejectedSnapshot["error"]!.GetValue<string>().Contains("ReadOnly", StringComparison.Ordinal), "RDP input crossed the local ReadOnly boundary or was acknowledged before rejection.");
            await Task.WhenAll(first.DisposeAsync().AsTask(), first.DisposeAsync().AsTask()).WaitAsync(TimeSpan.FromSeconds(2));
            Reject(() => { using var installation = AgentUpdateLease.Acquire(root); }, "Cleaning one RDP session released another session's activity lease.");
            await Task.WhenAll(second.DisposeAsync().AsTask(), second.DisposeAsync().AsTask()).WaitAsync(TimeSpan.FromSeconds(2));
            using var afterCleanup = AgentUpdateLease.Acquire(root);
        }
        finally
        {
            if (first is not null) await first.DisposeAsync(); if (second is not null) await second.DisposeAsync();
            CryptographicOperations.ZeroMemory(key); if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }

    private static async Task WithTlsPeerAsync(X509Certificate2 certificate, Func<int, Task> exercise, bool echo = false, uint protocol = 2)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        bool serverObservedRequest = false;
        Task server = Task.Run(async () =>
        {
            using TcpClient client = await listener.AcceptTcpClientAsync(timeout.Token);
            using NetworkStream stream = client.GetStream();
            byte[] first = new byte[RequestTpkt.Length]; await stream.ReadExactlyAsync(first, timeout.Token);
            Require(first.SequenceEqual(RequestTpkt), "Native RDP proxy connected before validating or changed its X.224 request."); serverObservedRequest = true;
            await stream.WriteAsync(Confirm(protocol), timeout.Token);
            if (protocol != 2) return;
            using var tls = new SslStream(stream, leaveInnerStreamOpen: true);
            try
            {
                await tls.AuthenticateAsServerAsync(new SslServerAuthenticationOptions
                {
                    ServerCertificate = certificate, ClientCertificateRequired = false,
                    EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13, CertificateRevocationCheckMode = X509RevocationMode.NoCheck
                }, timeout.Token);
                if (!echo) return;
                byte[] buffer = new byte[8192]; int count;
                while ((count = await tls.ReadAsync(buffer, timeout.Token)) > 0) await tls.WriteAsync(buffer.AsMemory(0, count), timeout.Token);
            }
            catch (Exception error) when (!echo && error is AuthenticationException or IOException) { /* Peer rejection is expected for wrong/expired pins. */ }
        }, timeout.Token);
        Exception? primary = null;
        try { await exercise(port); }
        catch (Exception error) { primary = error; throw; }
        finally
        {
            listener.Stop();
            try { await server.WaitAsync(TimeSpan.FromSeconds(3)); }
            catch when (primary is not null) { /* Preserve the actual assertion instead of its cleanup consequence. */ }
            finally { timeout.Cancel(); }
        }
        Require(serverObservedRequest, "Native RDP TLS fixture was never reached.");
    }

    private static void CheckProxyResponse(byte[] encoded, byte[] expectedCertificate, int port)
    {
        var reader = new AsnReader(encoded, AsnEncodingRules.DER); var response = reader.ReadSequence();
        Require(ReadInteger(response, 0) == 3390 && ReadBytes(response, 6).SequenceEqual(Confirm(2)), "Native TLS proxy returned an invalid RDCleanPath handshake.");
        var certificatesTag = response.ReadSequence(Context(7)); var certificates = certificatesTag.ReadSequence();
        Require(certificates.ReadOctetString().SequenceEqual(expectedCertificate), "Native proxy returned a certificate other than the actual TLS leaf.");
        while (certificates.HasData) certificates.ReadOctetString(); certificatesTag.ThrowIfNotEmpty();
        var addressTag = response.ReadSequence(Context(9));
        Require(addressTag.ReadCharacterString(UniversalTagNumber.UTF8String).EndsWith(":" + port, StringComparison.Ordinal), "Native proxy returned the wrong loopback port.");
        addressTag.ThrowIfNotEmpty(); response.ThrowIfNotEmpty(); reader.ThrowIfNotEmpty();
    }

    private static byte[] Request(int version = 3390, string destination = "localhost:3389", string auth = SessionId, int? extraTag = null, bool duplicateDestination = false, bool omitAuthentication = false, byte[]? x224 = null)
    {
        var writer = new AsnWriter(AsnEncodingRules.DER); writer.PushSequence();
        writer.PushSequence(Context(0)); writer.WriteInteger(version); writer.PopSequence(Context(0));
        Text(writer, 2, destination); if (duplicateDestination) Text(writer, 2, destination);
        if (!omitAuthentication) Text(writer, 3, auth); if (extraTag is int tag) Text(writer, tag, "injected-credential");
        writer.PushSequence(Context(6)); writer.WriteOctetString(x224 ?? RequestTpkt); writer.PopSequence(Context(6)); writer.PopSequence(); return writer.Encode();
    }

    private static void Text(AsnWriter writer, int tag, string value) { writer.PushSequence(Context(tag)); writer.WriteCharacterString(UniversalTagNumber.UTF8String, value); writer.PopSequence(Context(tag)); }
    private static Asn1Tag Context(int value) => new(TagClass.ContextSpecific, value, isConstructed: true);
    private static int ReadInteger(AsnReader reader, int tag) { var field = reader.ReadSequence(Context(tag)); int result = (int)field.ReadInteger(); field.ThrowIfNotEmpty(); return result; }
    private static byte[] ReadBytes(AsnReader reader, int tag) { var field = reader.ReadSequence(Context(tag)); byte[] result = field.ReadOctetString(); field.ThrowIfNotEmpty(); return result; }
    private static byte[] Confirm(uint protocol, byte type = 2) { byte[] packet = Convert.FromHexString("030000130ED000000000000200080002000000"); packet[11] = type; BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(15), protocol); return packet; }

    private static string ReferenceEncrypt(string id, byte[] key, long sequence, byte[] plain, bool input)
    {
        byte[] nonce = new byte[12]; Encoding.ASCII.GetBytes(input ? "CLNT" : "AGNT").CopyTo(nonce, 0); BinaryPrimitives.WriteUInt64BigEndian(nonce.AsSpan(4), checked((ulong)sequence));
        byte[] aad = Encoding.UTF8.GetBytes($"ServerDesk:RDP:1:{id}:{(input ? "in" : "out")}:{sequence}");
        byte[] ciphertext = new byte[plain.Length], tag = new byte[16]; using var cipher = new AesGcm(key, tagSizeInBytes: 16); cipher.Encrypt(nonce, plain, ciphertext, tag, aad);
        return Convert.ToBase64String(ciphertext.Concat(tag).ToArray());
    }

    private static byte[] ReferenceDecrypt(string id, byte[] key, long sequence, string data, bool input)
    {
        byte[] nonce = new byte[12]; Encoding.ASCII.GetBytes(input ? "CLNT" : "AGNT").CopyTo(nonce, 0); BinaryPrimitives.WriteUInt64BigEndian(nonce.AsSpan(4), checked((ulong)sequence));
        byte[] aad = Encoding.UTF8.GetBytes($"ServerDesk:RDP:1:{id}:{(input ? "in" : "out")}:{sequence}"); byte[] ciphertext = Convert.FromBase64String(data), plain = new byte[ciphertext.Length - 16];
        using var cipher = new AesGcm(key, tagSizeInBytes: 16); cipher.Decrypt(nonce, ciphertext.AsSpan(0, plain.Length), ciphertext.AsSpan(plain.Length), plain, aad); return plain;
    }

    private static void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
    private static void Reject(Action action, string message)
    {
        try { action(); }
        catch (Exception error) when (error is ArgumentException or InvalidDataException or CryptographicException or AsnContentException or FormatException or InvalidOperationException or OverflowException or UnauthorizedAccessException or JsonException) { return; }
        throw new Exception(message);
    }
    private static async Task RejectAsync(Func<Task> action, string message, bool cancellation = false)
    {
        try { await action(); }
        catch (OperationCanceledException) when (cancellation) { return; }
        catch (Exception error) when (!cancellation && error is ArgumentException or InvalidDataException or CryptographicException or AuthenticationException or IOException or AsnContentException or FormatException or InvalidOperationException) { return; }
        throw new Exception(message);
    }

    private sealed class FragmentedStream(byte[] bytes) : MemoryStream(bytes, writable: false)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => base.ReadAsync(buffer[..Math.Min(buffer.Length, 1)], cancellationToken);
    }
}
