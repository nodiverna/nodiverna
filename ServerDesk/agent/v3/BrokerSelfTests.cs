using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// Portable checks for the broker/worker boundary. Windows-only parts (pipe
// ACLs, service accounts, impersonation) are verified on a real install.
internal static class BrokerSelfTests
{
    internal static int Run()
    {
        try
        {
            RunAsync().GetAwaiter().GetResult();
            Console.WriteLine("Broker self-test passed.");
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine("Broker self-test failed: " + e.Message); return 1; }
    }

    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    private static void Rejects<T>(Action action, string message) where T : Exception
    {
        try { action(); } catch (T) { return; }
        throw new Exception(message);
    }

    private static async Task RunAsync()
    {
        // The portal uninstall is broker work; the release build runs this self-test.
        AgentUninstallTests.Run();
        // Service SID derivation, checked against a fixed Windows value.
        Check(BrokerProtocol.ServiceSid("TrustedInstaller") == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", "Service SID derivation differs from Windows.");
        Check(BrokerProtocol.WorkerSid.StartsWith("S-1-5-80-", StringComparison.Ordinal) && BrokerProtocol.WorkerSid != BrokerProtocol.ServiceSid(BrokerProtocol.BrokerService), "Worker and broker SIDs must differ.");

        await FramingAsync();
        PortalVector();
        Envelopes();
        TerminalLease();
        await RelayAsync();
        await RemoteRenewalAsync();
        WorkerConfiguration();
        await StaleLaneAsync();
    }

    // A fake broker pipe. Each written frame is one request; `answer` gives its
    // reply frame, or null for an end of stream on the next read. `Broken`
    // makes every later write fail as a pipe whose server end has closed.
    private sealed class FakePipe(Func<JsonObject, JsonObject?> answer) : Stream
    {
        private readonly MemoryStream replies = new();
        private long position;
        internal bool Broken;
        internal int Requests;
        public override bool CanRead => true;
        public override bool CanWrite => true;
        public override bool CanSeek => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public override int Read(Span<byte> buffer) { replies.Position = position; int read = replies.Read(buffer); position = replies.Position; return read; }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) => ValueTask.FromResult(Read(buffer.Span));
        public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));
        public override void Write(ReadOnlySpan<byte> frame)
        {
            if (Broken) throw new IOException("Pipe is broken.");
            Requests++;
            var reply = answer(JsonNode.Parse(frame[4..].ToArray())!.AsObject());
            if (reply is null) return;
            byte[] body = Encoding.UTF8.GetBytes(reply.ToJsonString());
            replies.Position = replies.Length; replies.Write(BitConverter.GetBytes(body.Length)); replies.Write(body);
        }
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken token = default) { Write(buffer.Span); return ValueTask.CompletedTask; }
    }

    private static JsonObject? Echo(JsonObject request) => new() { ["ok"] = true, ["op"] = request["op"]?.DeepClone() };

    private static async Task<Exception?> FailureOf(Func<Task> action)
    {
        try { await action(); return null; } catch (Exception e) { return e; }
    }

    // A lane that was idle while the broker restarted holds a dead pipe. Its next
    // call retries once on a fresh pipe, but never runs a mutating op twice.
    private static async Task StaleLaneAsync()
    {
        var timeout = TimeSpan.FromSeconds(5);
        JsonObject Request(string op) => new() { ["op"] = op };

        // A dead pipe fails at the write: one retry on a fresh pipe, for every op.
        {
            var a = new FakePipe(Echo); var b = new FakePipe(Echo); var pipes = new Queue<FakePipe>([a, b]); int opened = 0;
            await using var client = new BrokerClient(_ => { opened++; return Task.FromResult<Stream>(pipes.Dequeue()); });
            Check((await client.CallAsync("channel", Request("channel-state"), timeout, CancellationToken.None))["op"]?.GetValue<string>() == "channel-state", "The first call on a lane did not succeed.");
            a.Broken = true;
            var reply = await client.CallAsync("channel", Request("channel-apply"), timeout, CancellationToken.None);
            Check(reply["op"]?.GetValue<string>() == "channel-apply" && opened == 2 && b.Requests == 1 && a.Requests == 1, "A stale pipe that fails at the write did not retry once on a fresh pipe.");
        }
        // A dead pipe that takes the write and then ends: only a read-only op retries.
        {
            int calls = 0;
            var a = new FakePipe(request => ++calls == 1 ? Echo(request) : null); var b = new FakePipe(Echo); var pipes = new Queue<FakePipe>([a, b]); int opened = 0;
            await using var client = new BrokerClient(_ => { opened++; return Task.FromResult<Stream>(pipes.Dequeue()); });
            await client.CallAsync("telemetry:Drivers", new JsonObject { ["op"] = "telemetry", ["name"] = "Drivers" }, timeout, CancellationToken.None);
            var reply = await client.CallAsync("telemetry:Drivers", new JsonObject { ["op"] = "telemetry", ["name"] = "Drivers" }, timeout, CancellationToken.None);
            Check(reply["op"]?.GetValue<string>() == "telemetry" && opened == 2 && a.Requests == 2 && b.Requests == 1, "A read-only op on a stale pipe that ended did not retry once.");
        }
        {
            int calls = 0;
            var a = new FakePipe(request => ++calls == 1 ? Echo(request) : null); int opened = 0;
            await using var client = new BrokerClient(_ => { opened++; return Task.FromResult<Stream>(opened == 1 ? a : new FakePipe(Echo)); });
            await client.CallAsync("channel", Request("channel-state"), timeout, CancellationToken.None);
            var error = await FailureOf(() => client.CallAsync("channel", Request("channel-apply"), timeout, CancellationToken.None));
            Check(error is BrokerUnavailableException && opened == 1 && a.Requests == 2, "A mutating op that reached a stale pipe was sent again.");
        }
        // A pipe opened in this call that fails is a real outage: no retry.
        {
            int opened = 0;
            await using var client = new BrokerClient(_ => { opened++; return Task.FromResult<Stream>(new FakePipe(Echo) { Broken = true }); });
            var error = await FailureOf(() => client.CallAsync("status", Request("status"), timeout, CancellationToken.None));
            Check(error is BrokerUnavailableException && opened == 1, "A fresh pipe that failed was retried.");
        }
        // The retry's open fails: exactly one retry, and the caller sees the broker as unavailable.
        {
            var a = new FakePipe(Echo); int opened = 0;
            await using var client = new BrokerClient(_ => { opened++; return opened == 1 ? Task.FromResult<Stream>(a) : Task.FromException<Stream>(new BrokerUnavailableException("The ServerDesk broker is not accepting connections.")); });
            await client.CallAsync("terminal", Request("terminal-snapshot"), timeout, CancellationToken.None);
            a.Broken = true;
            var error = await FailureOf(() => client.CallAsync("terminal", Request("terminal-snapshot"), timeout, CancellationToken.None));
            Check(error is BrokerUnavailableException && opened == 2, "A failed open of the retry was retried again or changed its type.");
        }
        // A broker reply, even a refusal, is no stale pipe: no retry.
        {
            int calls = 0;
            var a = new FakePipe(request => ++calls == 1 ? Echo(request) : new JsonObject { ["ok"] = false, ["error"] = "refused", ["errorCode"] = "error" }); int opened = 0;
            await using var client = new BrokerClient(_ => { opened++; return Task.FromResult<Stream>(opened == 1 ? a : new FakePipe(Echo)); });
            await client.CallAsync("status", Request("status"), timeout, CancellationToken.None);
            var error = await FailureOf(() => client.CallAsync("status", Request("status"), timeout, CancellationToken.None));
            Check(error is BrokerException { Message: "refused" } && opened == 1 && a.Requests == 2, "A broker refusal was retried.");
        }
        // The retry keeps the call's deadline: a slow open gives TimeoutException within the first timeout.
        {
            var a = new FakePipe(Echo); int opened = 0;
            await using var client = new BrokerClient(async token => { opened++; if (opened > 1) await Task.Delay(TimeSpan.FromSeconds(10), token); return a; });
            await client.CallAsync("relay", Request("relay-take"), timeout, CancellationToken.None);
            a.Broken = true;
            var watch = System.Diagnostics.Stopwatch.StartNew();
            var error = await FailureOf(() => client.CallAsync("relay", Request("relay-take"), TimeSpan.FromMilliseconds(300), CancellationToken.None));
            Check(error is TimeoutException && opened == 2 && watch.Elapsed < TimeSpan.FromSeconds(5), "A retry did not keep the call's deadline: " + error?.GetType().Name + " after " + watch.ElapsedMilliseconds + " ms.");
        }
    }

    private static async Task FramingAsync()
    {
        using var stream = new MemoryStream();
        await BrokerProtocol.WriteAsync(stream, new JsonObject { ["op"] = "status", ["text"] = "äöü" }, CancellationToken.None);
        await BrokerProtocol.WriteAsync(stream, new JsonObject { ["op"] = "second" }, CancellationToken.None);
        stream.Position = 0;
        Check((await BrokerProtocol.ReadAsync(stream, CancellationToken.None))?["text"]?.GetValue<string>() == "äöü", "Frame round trip changed the payload.");
        Check((await BrokerProtocol.ReadAsync(stream, CancellationToken.None))?["op"]?.GetValue<string>() == "second", "Consecutive frames were not separated.");
        Check(await BrokerProtocol.ReadAsync(stream, CancellationToken.None) is null, "Clean end of stream was not reported.");
        using var oversized = new MemoryStream(BitConverter.GetBytes(BrokerProtocol.MaximumFrame + 1));
        bool rejected = false; try { await BrokerProtocol.ReadAsync(oversized, CancellationToken.None); } catch (InvalidDataException) { rejected = true; }
        Check(rejected, "An oversized frame header was accepted.");
        using var truncated = new MemoryStream([10, 0, 0, 0, (byte)'{']);
        rejected = false; try { await BrokerProtocol.ReadAsync(truncated, CancellationToken.None); } catch (EndOfStreamException) { rejected = true; }
        Check(rejected, "A truncated frame was accepted.");
    }

    // Produced by Node's crypto.sign(..., {dsaEncoding: 'ieee-p1363'}), as in lib/server/agent/agent-dispatch.ts.
    private static void PortalVector()
    {
        const string key = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEuyPLWIiAojfKFQHliK1eSPaAYfjTkWyNptuHk/IJGCeeqWrh7k6momfLD5mynhB3qYLkSZG9PfFJ+KKxS9zRJA==";
        const string payload = """{"v":1,"kind":"job","deviceId":"6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b","iat":1790000000,"exp":1790000900,"job":{"id":"0b7c2e64-58f1-4c47-9d4e-5a6b7c8d9e0f","action":"refresh","target":null,"parameters":{"note":"Grüße ✓"}}}""";
        const string signature = "h/KDqxZbWSZv7lm9lVxs0PTDIMeMGLQ20kVANUDo42LQaDWT5MQ++uFXEH3l1FSFssZMPXCemswm+k8n7NzKrA==";
        var verifier = new DispatchVerifier(key, "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b", () => DateTimeOffset.FromUnixTimeSeconds(1790000100));
        var data = verifier.Verify(new JsonObject { ["payload"] = payload, ["signature"] = signature }, "job", DispatchVerifier.JobLifetime);
        Check(data["job"]?["parameters"]?["note"]?.GetValue<string>() == "Grüße ✓", "The portal's signed UTF-8 payload did not verify.");
        Check(DispatchVerifier.ValidateKey(key) == key, "A valid portal P-256 key was rejected.");
    }

    private static (DispatchVerifier Verifier, Func<JsonObject, JsonObject> Sign, string Device) Signer(DateTimeOffset now)
    {
        var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        string device = Guid.NewGuid().ToString();
        var verifier = new DispatchVerifier(Convert.ToBase64String(key.ExportSubjectPublicKeyInfo()), device, () => now);
        JsonObject Sign(JsonObject payload)
        {
            string text = payload.ToJsonString();
            return new JsonObject { ["payload"] = text, ["signature"] = Convert.ToBase64String(key.SignData(Encoding.UTF8.GetBytes(text), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) };
        }
        return (verifier, Sign, device);
    }

    private static void Envelopes()
    {
        var now = DateTimeOffset.UtcNow; long t = now.ToUnixTimeSeconds();
        var (verifier, sign, device) = Signer(now);
        JsonObject Job(long iat, long exp, string? deviceId = null, string kind = "job") => new() { ["v"] = 1, ["kind"] = kind, ["deviceId"] = deviceId ?? device, ["iat"] = iat, ["exp"] = exp, ["job"] = new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["action"] = "refresh" } };
        Check(verifier.Verify(sign(Job(t, t + 900)), "job", DispatchVerifier.JobLifetime)["job"]?["action"]?.GetValue<string>() == "refresh", "A valid signed job was refused.");
        var tampered = sign(Job(t, t + 900)); tampered["payload"] = tampered["payload"]!.GetValue<string>().Replace("refresh", "restart-computer");
        Rejects<CryptographicException>(() => verifier.Verify(tampered, "job", DispatchVerifier.JobLifetime), "A modified payload kept its signature.");
        var foreign = Signer(now);
        Rejects<CryptographicException>(() => verifier.Verify(foreign.Sign(Job(t, t + 900)), "job", DispatchVerifier.JobLifetime), "A different portal key was accepted.");
        Rejects<InvalidDataException>(() => verifier.Verify(sign(Job(t, t + 900, Guid.NewGuid().ToString())), "job", DispatchVerifier.JobLifetime), "A job for another device was accepted.");
        Rejects<InvalidDataException>(() => verifier.Verify(sign(Job(t, t + 900, kind: "transfer")), "job", DispatchVerifier.JobLifetime), "A transfer envelope was accepted as a job.");
        Rejects<InvalidDataException>(() => verifier.Verify(sign(Job(t - 2000, t - 1100)), "job", DispatchVerifier.JobLifetime), "An expired job was accepted.");
        Rejects<InvalidDataException>(() => verifier.Verify(sign(Job(t + 600, t + 1200)), "job", DispatchVerifier.JobLifetime), "A job issued in the future was accepted.");
        Rejects<InvalidDataException>(() => verifier.Verify(sign(Job(t, t + 7200)), "job", DispatchVerifier.JobLifetime), "An excessive job lifetime was accepted.");
        Check(verifier.Verify(sign(Job(t - 900, t - 60)), "job", DispatchVerifier.JobLifetime) is not null, "Small clock skew was not tolerated.");
        var extra = sign(Job(t, t + 900)); extra["job"] = new JsonObject { ["action"] = "restart-computer" };
        Rejects<InvalidDataException>(() => verifier.Verify(extra, "job", DispatchVerifier.JobLifetime), "Unsigned fields beside the payload were accepted.");
        Rejects<InvalidDataException>(() => verifier.Verify(new JsonObject { ["payload"] = "{}" }, "job", DispatchVerifier.JobLifetime), "An unsigned payload was accepted.");
        Rejects<InvalidDataException>(() => verifier.Verify(null, "job", DispatchVerifier.JobLifetime), "A missing envelope was accepted.");
        using var p384 = ECDsa.Create(ECCurve.NamedCurves.nistP384);
        Rejects<InvalidDataException>(() => DispatchVerifier.ValidateKey(Convert.ToBase64String(p384.ExportSubjectPublicKeyInfo())), "A P-384 job key was accepted.");
        using var rsa = RSA.Create(2048);
        Rejects<InvalidDataException>(() => DispatchVerifier.ValidateKey(Convert.ToBase64String(rsa.ExportSubjectPublicKeyInfo())), "An RSA job key was accepted.");
    }

    private static void TerminalLease()
    {
        var now = DateTimeOffset.UtcNow; long t = now.ToUnixTimeSeconds();
        var (verifier, sign, device) = Signer(now);
        string a = Guid.NewGuid().ToString(), b = Guid.NewGuid().ToString(), c = Guid.NewGuid().ToString();
        var commands = new JsonArray(
            new JsonObject { ["id"] = a, ["state"] = "open", ["input"] = new JsonArray(), ["outputAck"] = 3, ["expiresAt"] = now.AddHours(1).ToString("O") },
            new JsonObject { ["id"] = b, ["state"] = "opening", ["input"] = new JsonArray(), ["outputAck"] = 0, ["expiresAt"] = now.AddHours(1).ToString("O") },
            new JsonObject { ["id"] = c, ["state"] = "closed", ["input"] = new JsonArray(), ["outputAck"] = 0 });
        var lease = sign(new JsonObject { ["v"] = 1, ["kind"] = "terminal", ["deviceId"] = device, ["iat"] = t, ["exp"] = t + 60, ["sessions"] = new JsonArray(a) });
        var applied = verifier.ApplyTerminalLease(commands, lease, _ => { });
        Check(applied[0]?["state"]?.GetValue<string>() == "open" && DateTimeOffset.Parse(applied[0]!["expiresAt"]!.GetValue<string>()) <= now.AddSeconds(61), "A leased shell was not clamped to its lease.");
        Check(applied[1]?["state"]?.GetValue<string>() == "closed", "A shell outside the signed lease was not closed.");
        Check(applied[2]?["state"]?.GetValue<string>() == "closed", "A closing command was changed.");
        var unsigned = verifier.ApplyTerminalLease(commands, null, _ => { });
        Check(unsigned.All(item => item?["state"]?.GetValue<string>() == "closed"), "Shells stayed open without a signed lease.");
        var stale = sign(new JsonObject { ["v"] = 1, ["kind"] = "terminal", ["deviceId"] = device, ["iat"] = t - 600, ["exp"] = t - 540, ["sessions"] = new JsonArray(a) });
        Check(verifier.ApplyTerminalLease(commands, stale, _ => { })[0]?["state"]?.GetValue<string>() == "closed", "A replayed stale lease kept a shell open.");
    }

    private static async Task RelayAsync()
    {
        var relay = new WorkerRelay();
        // A fake worker answering every relay request in order.
        byte[] release = RandomNumberGenerator.GetBytes(RelayReleaseSource.SliceBytes * 2 + 1234);
        using var stop = new CancellationTokenSource();
        var worker = Task.Run(async () =>
        {
            while (!stop.IsCancellationRequested)
            {
                JsonArray taken;
                try { taken = await relay.TakeAsync(200, stop.Token); } catch (OperationCanceledException) { return; }
                foreach (var item in taken)
                {
                    long id = item!["id"]!.GetValue<long>(); var request = item["request"]!.AsObject();
                    JsonObject result = request["kind"]!.GetValue<string>() switch
                    {
                        "transfer-read" => new JsonObject { ["data"] = Convert.ToBase64String(new byte[request["length"]!.GetValue<int>()]) },
                        "release-open" => new JsonObject { ["handle"] = "h" },
                        "release-read" => new JsonObject { ["data"] = Convert.ToBase64String(release.AsSpan((int)request["offset"]!.GetValue<long>(), request["length"]!.GetValue<int>())) },
                        _ => new JsonObject()
                    };
                    relay.Complete(id, request["kind"]!.GetValue<string>() == "transfer-authorize" ? null : result, request["kind"]!.GetValue<string>() == "transfer-authorize" ? "denied" : null);
                }
            }
        });
        var portal = new RelayTransferPortal(relay);
        Check((await portal.ReadChunkAsync(Guid.NewGuid().ToString(), 0, 4096, CancellationToken.None)).Length == 4096, "Relayed chunk length changed.");
        bool failed = false; try { await portal.AuthorizeAsync(Guid.NewGuid().ToString(), CancellationToken.None); } catch (IOException) { failed = true; }
        Check(failed, "A worker-side failure was reported as success.");
        using var output = new MemoryStream(); using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        await new RelayReleaseSource(relay).CopyAsync("https://portal.test/downloads/a", release.Length, output, hash, CancellationToken.None);
        Check(output.ToArray().AsSpan().SequenceEqual(release) && hash.GetHashAndReset().AsSpan().SequenceEqual(SHA256.HashData(release)), "Relayed release bytes or hash changed.");
        stop.Cancel(); await worker;
        // A request nobody takes times out, and a late taker never sees it.
        var idle = new WorkerRelay();
        failed = false; try { await idle.CallAsync(new JsonObject { ["kind"] = "transfer-authorize" }, TimeSpan.FromMilliseconds(50), CancellationToken.None); } catch (TimeoutException) { failed = true; }
        Check(failed && (await idle.TakeAsync(0, CancellationToken.None)).Count == 0, "An abandoned relay request was still handed to the worker.");
    }

    // The worker renews with a broker signature instead of holding the key.
    private static async Task RemoteRenewalAsync()
    {
        using var rsa = RSA.Create(2048);
        string origin = "https://serverdesk.test", id = Guid.NewGuid().ToString();
        var brokerConfig = new JsonObject { ["id"] = id, ["origin"] = origin, ["token"] = new string('a', 64), ["privateKey"] = rsa.ToXmlString(true) };
        var workerConfig = WorkerAccess.WorkerConfiguration(brokerConfig);
        JsonObject? offered = null; bool signedByBroker = false;
        async Task<JsonObject> Post(string path, JsonObject body, CancellationToken token)
        {
            await Task.Yield();
            if (path.EndsWith("/challenge", StringComparison.Ordinal))
            {
                var date = DateTimeOffset.UtcNow;
                offered = new JsonObject { ["version"] = 1, ["serverId"] = id, ["origin"] = origin, ["challengeId"] = Guid.NewGuid().ToString(), ["nonce"] = new string('n', 43), ["proof"] = new string('p', 43), ["expiresAt"] = date.ToUnixTimeSeconds() + 120, ["algorithm"] = "RS256", ["_httpServerDate"] = date.ToString("O") };
                offered["message"] = "ServerDesk device access token v1\n" + origin + "\n" + id + "\n" + offered["challengeId"] + "\n" + offered["nonce"] + "\n" + offered["expiresAt"];
                return offered.DeepClone().AsObject();
            }
            Check(rsa.VerifyData(Encoding.UTF8.GetBytes(offered!["message"]!.GetValue<string>()), Convert.FromBase64String(body["signature"]!.GetValue<string>()), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1), "The relayed renewal signature is invalid.");
            return new JsonObject { ["serverId"] = id, ["tokenMode"] = "key-bound", ["token"] = new string('b', 64), ["expiresIn"] = 900, ["expiresAt"] = DateTimeOffset.UtcNow.AddMinutes(15).ToString("O") };
        }
        var client = new DeviceTokenClient(workerConfig, null, () => true, Post, _ => { }, () => 0, signer: (challenge, _) => { signedByBroker = true; return Task.FromResult(DeviceTokenClient.SignChallenge(brokerConfig, challenge)); });
        Check(await client.AccessAsync(CancellationToken.None) == new string('b', 64) && signedByBroker, "The worker did not renew through the broker signer.");
        // The broker refuses to sign anything but a renewal challenge for its own portal and device.
        var wrongPurpose = offered!.DeepClone().AsObject(); wrongPurpose["message"] = "Anything else";
        Rejects<InvalidDataException>(() => DeviceTokenClient.SignChallenge(brokerConfig, wrongPurpose), "The broker signed a message that is not a renewal challenge.");
        var otherPortal = offered.DeepClone().AsObject(); otherPortal["origin"] = "https://attacker.test";
        Rejects<InvalidDataException>(() => DeviceTokenClient.SignChallenge(brokerConfig, otherPortal), "The broker signed a challenge for another portal.");
    }

    private static void WorkerConfiguration()
    {
        using var rsa = RSA.Create(2048);
        var config = new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["origin"] = "https://serverdesk.test", ["token"] = new string('a', 64), ["mode"] = "Management", ["privateKey"] = rsa.ToXmlString(true), ["jobSigningKey"] = "x" };
        var worker = WorkerAccess.WorkerConfiguration(config);
        Check(worker["privateKey"] is null && worker["jobSigningKey"] is null && worker["mode"] is null, "Broker-only secrets or authority leaked into the worker configuration.");
        Check(worker["keyHash"]?.GetValue<string>() == DeviceTokenClient.Fingerprint(config["privateKey"]!.GetValue<string>()), "The worker key fingerprint differs from the device key.");
    }
}
