using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class SelfTests
{
    internal static int Run()
    {
        try
        {
            JsonNode? a = JsonNode.Parse("{\"z\":2,\"a\":{\"b\":1,\"a\":3}}"), b = JsonNode.Parse("{\"a\":{\"a\":3,\"b\":1},\"z\":2}");
            if (DriftMonitor.Canonical(a) != DriftMonitor.Canonical(b)) throw new Exception("Semantic JSON configuration hash depends on object property ordering.");
            string unusualSecret = "domain\\user\"password", escapedSecret = JsonValue.Create(unusualSecret)!.ToJsonString(); string masked = SecretMask.Apply(unusualSecret + escapedSecret, new[] { unusualSecret }); if (masked.Contains(unusualSecret) || masked.Contains(escapedSecret[1..^1])) throw new Exception("Direct or JSON escaped runbook secrets were not masked.");
            using var rsa = RSA.Create(2048); var key = rsa.ExportParameters(true);
            string XmlField(string field, byte[]? bytes) => "<" + field + ">" + Convert.ToBase64String(bytes!) + "</" + field + ">";
            string xml = "<RSAKeyValue>" + XmlField("Modulus", key.Modulus) + XmlField("Exponent", key.Exponent) + XmlField("D", key.D) + XmlField("P", key.P) + XmlField("Q", key.Q) + XmlField("DP", key.DP) + XmlField("DQ", key.DQ) + XmlField("InverseQ", key.InverseQ) + "</RSAKeyValue>";
            byte[] material = RandomNumberGenerator.GetBytes(64), iv = RandomNumberGenerator.GetBytes(16), plain = Encoding.UTF8.GetBytes("{\"password\":\"test-secret\"}"); using var aes = Aes.Create(); aes.Key = material[..32]; byte[] ciphertext = aes.EncryptCbc(plain, iv);
            var box = new JsonObject { ["key"] = Convert.ToBase64String(rsa.Encrypt(material, RSAEncryptionPadding.OaepSHA1)), ["iv"] = Convert.ToBase64String(iv), ["data"] = Convert.ToBase64String(ciphertext), ["mac"] = Convert.ToBase64String(HMACSHA256.HashData(material[32..], iv.Concat(ciphertext).ToArray())) };
            if (LocalStore.DecryptSecrets(box, xml)["password"]!.GetValue<string>() != "test-secret") throw new Exception("RSA/AES/HMAC secret envelope round trip failed.");
            // Configuration JSON escapes may make a valid 64-KiB source much
            // larger than 75 KiB on the encrypted wire. Test the actual native
            // decoder, independently of the portal's transport round trip.
            string largeContent = new string('\n', 65536);
            byte[] largePlain = Encoding.UTF8.GetBytes(new JsonObject { ["content"] = largeContent }.ToJsonString());
            byte[] largeCipher = aes.EncryptCbc(largePlain, iv);
            var largeBox = new JsonObject { ["key"] = Convert.ToBase64String(rsa.Encrypt(material, RSAEncryptionPadding.OaepSHA1)), ["iv"] = Convert.ToBase64String(iv), ["data"] = Convert.ToBase64String(largeCipher), ["mac"] = Convert.ToBase64String(HMACSHA256.HashData(material[32..], iv.Concat(largeCipher).ToArray())) };
            var openConfiguration = typeof(DesiredStateJobs).GetMethod("OpenConfiguration", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
            var decodedConfiguration = (JsonObject)openConfiguration.Invoke(null, [largeBox, xml])!;
            if (largeCipher.Length <= 75000 || decodedConfiguration["content"]!.GetValue<string>() != largeContent) throw new Exception("Large encrypted DSC configuration was rejected or changed.");
            box["mac"] = Convert.ToBase64String(new byte[32]); bool rejected = false; try { LocalStore.DecryptSecrets(box, xml); } catch (CryptographicException) { rejected = true; } if (!rejected) throw new Exception("Corrupted HMAC was accepted.");
            rejected = false; try { AgentUpdater.VerifyManifest("{}", Convert.ToBase64String(new byte[70]), "https://example.test"); } catch (CryptographicException) { rejected = true; } if (!rejected) throw new Exception("Untrusted release was accepted.");
            string temporary = Path.Combine(Path.GetTempPath(), "ServerDesk-SelfTest-" + Guid.NewGuid().ToString("N"));
            try
            {
                var runner = new JobRunner(temporary, temporary, new JsonObject());
                string jobs = Path.Combine(temporary, "v3-jobs"), id = Guid.NewGuid().ToString();
                var result = new JsonObject { ["id"] = id, ["ok"] = true, ["message"] = "Dummy canonical result" };
                for (int i = 0; i < 6; i++) File.WriteAllText(Path.Combine(jobs, Guid.NewGuid() + ".parameters.bin.result.json"), result.ToJsonString());
                File.WriteAllText(Path.Combine(jobs, id + ".result.json"), result.ToJsonString());
                var results = runner.Results(); if (results.Count != 1 || results[0]?["id"]?.GetValue<string>() != id) throw new Exception("Temporary operation results starved or leaked into canonical results.");
                runner.Acknowledge(results); if (runner.Results().Count != 0 || !File.Exists(Path.Combine(jobs, id + ".claim.ack"))) throw new Exception("Canonical result acknowledgement was not durable.");
                string interrupted = Guid.NewGuid().ToString(); File.WriteAllText(Path.Combine(jobs, interrupted + ".claim"), "Dummy interrupted claim");
                var recovered = new JobRunner(temporary, temporary, new JsonObject());
                if (recovered.Results().Count != 1 || recovered.Results()[0]?["ok"]?.GetValue<bool>() != false) throw new Exception("Interrupted claims did not become durable failures without replay.");
            }
            finally { if (Directory.Exists(temporary)) Directory.Delete(temporary, true); }
            JobConcurrencyTests.Run();
            TerminalTestsAsync().GetAwaiter().GetResult();
            NativeTelemetrySelfTests.RunAsync().GetAwaiter().GetResult();
            NativeGpuInventoryTests.RunAsync().GetAwaiter().GetResult();
            NativeGpuDetailsTests.RunSelfTests();
            NativeHardwareInventoryTests.RunAsync().GetAwaiter().GetResult();
            NativeNetworkInventoryTests.Run();
            AgentMessagesTests.Run();
            AssistantPowerShellTests.Run();
            NativeFeaturesProviderTests.Run();
            NativeFeaturesAbiTests.Run();
            NativeInventoryDiagnosticsTests.RunAsync().GetAwaiter().GetResult();
            NativeDiagnosticsStorageTests.Run();
            NativeDesiredDriftTests.Run();
            NativeDriftMonitorTests.RunAsync().GetAwaiter().GetResult();
            AgentNativeTests.Run();
            AgentIdleStateTests.Run();
            AgentUninstallTests.Run();
            NativeInstallerTests.Run();
            DeviceTokenClientTests.RunAsync().GetAwaiter().GetResult();
            FileTransferTransportTests.RunAsync().GetAwaiter().GetResult();
            NativeManagementTests.Run();
            NativePowerScheduleTests.Run();
            NativeRebootStatusTests.Run();
            NativeWindowsUpdatesTests.Run();
            TerminalSessionLeaseTests.Run();
            NativeRdpTests.RunAsync().GetAwaiter().GetResult();
            NativeRtcTests.RunAsync().GetAwaiter().GetResult();
            // The plugin host: signatures, hashes, folder ACL decision, protocol failures, jobs and the signed plugin policy.
            if (PluginSelfTests.RunSelfTestAsync().GetAwaiter().GetResult() != 0) throw new Exception("The plugin self-test failed.");
            Console.WriteLine("Native protocol self-tests passed: stable hashes, secret envelope, HMAC tamper, publisher signature rejection, durable results, independent terminal lifecycles and no replay. Windows APIs require the Windows pilot."); return 0;
        }
        catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }

    private static async Task TerminalTestsAsync()
    {
        var wake = new TerminalWake();
        wake.Signal(); wake.Signal(); wake.Signal();
        if (!await wake.WaitAsync(50, CancellationToken.None) || await wake.WaitAsync(10, CancellationToken.None)) throw new Exception("Native output wakeups were lost or a burst created a spin loop.");
        var waiting = wake.WaitAsync(5000, CancellationToken.None); wake.Signal();
        if (!await waiting.WaitAsync(TimeSpan.FromSeconds(1))) throw new Exception("Native output did not interrupt the idle terminal wait.");
        using (var cancel = new CancellationTokenSource())
        {
            var cancelledWait = wake.WaitAsync(5000, cancel.Token); cancel.Cancel();
            bool cancelled = false; try { await cancelledWait; } catch (OperationCanceledException) { cancelled = true; }
            if (!cancelled) throw new Exception("Terminal transport cancellation left a pending wakeup waiter.");
        }
        var claims = new HashSet<string>(StringComparer.Ordinal); var created = new Dictionary<string, TestTerminal>();
        var registry = new TerminalRegistry(command => { string id = command["id"]!.GetValue<string>(); var terminal = new TestTerminal(id); created.Add(id, terminal); return terminal; }, claims.Contains, id => claims.Add(id), _ => { });
        string[] ids = Enumerable.Range(0, 8).Select(_ => Guid.NewGuid().ToString()).ToArray();
        JsonObject Command(string id, string state = "open", long? seq = null) => new() { ["id"] = id, ["state"] = state, ["expiresAt"] = DateTimeOffset.UtcNow.AddMinutes(2).ToString("O"), ["input"] = seq is long sequence ? new JsonArray(new JsonObject { ["seq"] = sequence, ["kind"] = "input", ["data"] = "test" }) : new JsonArray() };
        JsonArray Commands(IEnumerable<string> values) => new(values.Select(value => (JsonNode)Command(value)).ToArray());
        await registry.AcceptAsync(Commands(ids.Take(4)), true, false, CancellationToken.None);
        if (created.Count != 4 || !registry.AnyAlive || registry.Snapshots().Count != 4) throw new Exception("Four independent terminal sessions were not created.");
        var input = Commands(ids.Take(4)); input[0] = Command(ids[0], seq: 1); input[1] = Command(ids[1], seq: 1);
        await registry.AcceptAsync(input, true, false, CancellationToken.None);
        if (created[ids[0]].InputAck != 1 || created[ids[1]].InputAck != 1 || created[ids[2]].InputAck != 0) throw new Exception("Terminal sequence state leaked between session IDs.");
        await registry.AcceptAsync(Commands(ids.Take(5)), true, false, CancellationToken.None);
        if (created.Count != 4 || registry.Snapshots().First(item => item?["id"]?.GetValue<string>() == ids[4])?["state"]?.GetValue<string>() != "error") throw new Exception("The fifth terminal exceeded the independent shell limit.");
        var closing = Commands(new[] { ids[0], ids[2], ids[3], ids[5] }); closing.Add(Command(ids[1], "closed")); closing.Add(Command(ids[4], "closed"));
        await registry.AcceptAsync(closing, true, false, CancellationToken.None);
        if (created[ids[1]].Alive || !created[ids[0]].Alive || !created[ids[2]].Alive || !created[ids[5]].Alive) throw new Exception("Closing one user terminal disturbed another user's shell or failed to free the slot.");
        var malformed = Commands(new[] { ids[0], ids[2], ids[3], ids[5] }); malformed[0] = Command(ids[0], seq: 3); malformed[1] = Command(ids[2], seq: 1);
        await registry.AcceptAsync(malformed, true, false, CancellationToken.None);
        if (created[ids[0]].Alive || !created[ids[2]].Alive || created[ids[2]].InputAck != 1 || !created[ids[3]].Alive) throw new Exception("A malformed terminal command disrupted other session IDs.");
        await registry.AcceptAsync(Commands(new[] { ids[2], ids[5] }), true, false, CancellationToken.None);
        if (created[ids[3]].Alive || !created[ids[2]].Alive) throw new Exception("Authoritative terminal omission failed to close exactly the omitted lease.");
        created[ids[2]].Expired = true; await registry.CloseExpiredAsync();
        if (created[ids[2]].Alive || !created[ids[5]].Alive) throw new Exception("Terminal expiry cleanup was not independent.");
        await registry.StopAsync(); if (registry.AnyAlive) throw new Exception("Service or channel shutdown did not close all shells.");
        await registry.AcceptAsync(Commands(new[] { ids[1] }), true, false, CancellationToken.None);
        if (created.Count != 5 || registry.AnyAlive) throw new Exception("An interrupted terminal claim recreated its old shell.");
        await registry.AcceptAsync(Commands(new[] { ids[6] }), false, false, CancellationToken.None);
        if (created.ContainsKey(ids[6])) throw new Exception("ReadOnly mode permitted a new shell.");
        await registry.AcceptAsync(Commands(new[] { ids[7] }), true, true, CancellationToken.None);
        if (created.ContainsKey(ids[7])) throw new Exception("A pending update permitted a new shell.");
        await registry.AcceptAsync(Commands(Enumerable.Range(0, 20).Select(_ => Guid.NewGuid().ToString())), false, false, CancellationToken.None);
        if (registry.Snapshots().Count > TerminalRegistry.MaximumReports) throw new Exception("Rejected terminal reports grew without a bound.");
        if (AgentWorkPolicy.BlocksJob("refresh", true, false, false) || AgentWorkPolicy.BlocksJob("list-processes", true, false, false) || !AgentWorkPolicy.BlocksJob("agent-update", true, false, false) || !AgentWorkPolicy.BlocksJob("refresh", false, true, false) || !AgentWorkPolicy.BlocksJob("refresh", false, false, true) || AgentWorkPolicy.BlocksTransfer(false, false) || !AgentWorkPolicy.BlocksTransfer(true, false) || !AgentWorkPolicy.BlocksTransfer(false, true)) throw new Exception("Terminal coexistence or exclusive update/job/transfer policy failed.");
        // Jobs and telemetry can inspect the published registry while only the
        // terminal transport mutates its dictionary. Verify the actual view,
        // rather than relying on timing or Windows process APIs in this test.
        using (var observing = new CancellationTokenSource())
        {
            var observer = Task.Run(() => { while (!observing.IsCancellationRequested) { _ = registry.AnyAlive; _ = registry.Snapshots(); } });
            for (int i = 0; i < 30; i++) await registry.AcceptAsync(Commands(new[] { Guid.NewGuid().ToString() }), false, false, CancellationToken.None);
            observing.Cancel(); await observer;
        }
        var unicodeFrames = Enumerable.Range(1, 20).Select(sequence => ((long)sequence, new string('\u6f22', 4096))).ToArray();
        var output = TerminalOutputFrames.Select(unicodeFrames);
        if (output.Count == 0 || output.Count >= 16 || Encoding.UTF8.GetByteCount(output.ToJsonString()) > TerminalOutputFrames.MaximumBytes + 32 || output[0]?["seq"]?.GetValue<long>() != 1 || unicodeFrames.Length != 20) throw new Exception("Escaped Unicode terminal frames exceeded their channel budget or changed the retained frames.");
        var following = TerminalOutputFrames.Select(unicodeFrames.Skip(output.Count));
        if (following[0]?["seq"]?.GetValue<long>() != output.Count + 1) throw new Exception("Budgeted terminal output skipped the next unacknowledged frame.");
        var retained = unicodeFrames.ToList(); int acknowledged = 0;
        while (retained.Count > 0)
        {
            var packet = TerminalOutputFrames.Select(retained); bool final = packet.Count == retained.Count;
            if (TerminalOutputFrames.ReportState("closed", retained.Count, packet.Count) != (final ? "closed" : "open") || TerminalOutputFrames.ReportState("error", retained.Count, packet.Count) != (final ? "error" : "open") || packet[0]?["seq"]?.GetValue<long>() != acknowledged + 1) throw new Exception("A stopped shell closed before its final bounded output packet was reported.");
            acknowledged += packet.Count; retained.RemoveRange(0, packet.Count); // Model the server's exact output ACK.
        }
        if (acknowledged != unicodeFrames.Length || TerminalOutputFrames.ReportState("closed", 0, 0) != "closed" || TerminalOutputFrames.ReportState("open", 20, 5) != "open") throw new Exception("Final terminal output was skipped or the shell state was changed incorrectly.");
    }

    // Tests the actual registry and protocol state handling without requiring
    // ConPTY or pretending that Windows process APIs ran on this host.
    private sealed class TestTerminal(string id) : IAgentTerminal
    {
        public string Id => id;
        public bool Alive { get; private set; } = true;
        public bool Expired { get; set; }
        internal long InputAck { get; private set; }
        public JsonObject Snapshot() => new() { ["id"] = id, ["state"] = Alive ? "open" : "closed", ["inputAck"] = InputAck, ["output"] = new JsonArray(new JsonObject { ["seq"] = 1, ["data"] = id }) };
        public Task AcceptAsync(JsonObject request, CancellationToken token)
        {
            if (request["id"]?.GetValue<string>() != Id) throw new Exception("Session routing mismatch");
            foreach (var frame in request["input"]?.AsArray() ?? new JsonArray())
            {
                long seq = frame!["seq"]!.GetValue<long>(); if (seq <= InputAck) continue;
                if (seq != InputAck + 1) throw new InvalidDataException("Input sequence gap");
                InputAck = seq;
            }
            return Task.CompletedTask;
        }
        public ValueTask DisposeAsync() { Alive = false; return ValueTask.CompletedTask; }
    }
}
