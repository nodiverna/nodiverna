using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using ServerDesk.Plugins;

namespace ServerDesk.Agent;

// --plugin-self-test, also part of --self-test: the plugin host without a real
// plugin, process, firewall or ACL. An injected process factory runs scripted
// plugins over in-memory streams; a throwaway P-256 key stands for the
// publisher; a vector signed by Node (lib/server/agent/agent-dispatch.ts) checks the plugin policy.
internal static class PluginSelfTests
{
    internal static async Task<int> RunSelfTestAsync()
    {
        try { await RunAsync(); await IdentityAsync(); await RealProcessAsync(); Console.WriteLine("Plugin self-test passed."); return 0; }
        catch (Exception e) { Console.Error.WriteLine("Plugin self-test failed: " + e.Message); return 1; }
    }

    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    private static async Task<string> CodeOfAsync(Func<Task> action)
    {
        try { await action(); } catch (AgentMessageException e) { return e.Code; }
        return "none";
    }
    private static string CodeOf(Action action) { try { action(); } catch (AgentMessageException e) { return e.Code; } return "none"; }

    // ---- In-memory pipes and scripted plugins -------------------------------------------
    private sealed class Pipe
    {
        private readonly Channel<byte[]> queue = Channel.CreateUnbounded<byte[]>();
        internal Stream Reader { get; }
        internal Stream Writer { get; }
        internal Pipe() { Reader = new ReadEnd(queue.Reader); Writer = new WriteEnd(queue.Writer); }
        internal void Complete() => queue.Writer.TryComplete();
        private sealed class ReadEnd(ChannelReader<byte[]> reader) : Stream
        {
            private byte[] current = []; private int offset;
            public override bool CanRead => true; public override bool CanWrite => false; public override bool CanSeek => false;
            public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
            public override void Flush() { }
            public override long Seek(long o, SeekOrigin s) => throw new NotSupportedException(); public override void SetLength(long v) => throw new NotSupportedException();
            public override void Write(byte[] b, int o, int c) => throw new NotSupportedException();
            public override int Read(byte[] buffer, int start, int count) => ReadAsync(buffer.AsMemory(start, count)).AsTask().GetAwaiter().GetResult();
            public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default)
            {
                while (offset >= current.Length)
                {
                    if (!await reader.WaitToReadAsync(token)) return 0;
                    if (reader.TryRead(out var next)) { current = next; offset = 0; }
                }
                int take = Math.Min(buffer.Length, current.Length - offset);
                current.AsMemory(offset, take).CopyTo(buffer); offset += take; return take;
            }
        }
        private sealed class WriteEnd(ChannelWriter<byte[]> writer) : Stream
        {
            public override bool CanRead => false; public override bool CanWrite => true; public override bool CanSeek => false;
            public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
            public override void Flush() { }
            public override long Seek(long o, SeekOrigin s) => throw new NotSupportedException(); public override void SetLength(long v) => throw new NotSupportedException();
            public override int Read(byte[] b, int o, int c) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) { if (!writer.TryWrite(buffer.AsSpan(offset, count).ToArray())) throw new IOException("The pipe is closed."); }
            public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken token = default) { if (!writer.TryWrite(buffer.ToArray())) throw new IOException("The pipe is closed."); return ValueTask.CompletedTask; }
            protected override void Dispose(bool disposing) { writer.TryComplete(); base.Dispose(disposing); }
        }
    }

    // The plugin side of a fake process: reads the broker lines, writes its own, returns the exit code.
    private delegate Task<int> Script(PluginLineReader input, Stream output, CancellationToken killed);
    private sealed class FakeProcess : IPluginProcess
    {
        private readonly Pipe toPlugin = new(), fromPlugin = new(), errors = new();
        private readonly TaskCompletionSource<int> exit = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly CancellationTokenSource killed = new();
        internal bool Killed => killed.IsCancellationRequested;
        public Stream Input => toPlugin.Writer;
        public Stream Output => fromPlugin.Reader;
        public Stream Error => errors.Reader;
        internal FakeProcess(Script script, string? stderr = null)
        {
            _ = Task.Run(async () =>
            {
                int code;
                try { code = await script(new PluginLineReader(toPlugin.Reader), fromPlugin.Writer, killed.Token); }
                catch { code = killed.IsCancellationRequested ? 1 : 3; }
                // What the plugin wrote to stderr, as the broker captures it.
                if (stderr is not null) await errors.Writer.WriteAsync(Encoding.UTF8.GetBytes(stderr));
                fromPlugin.Complete(); errors.Complete(); exit.TrySetResult(code);
            });
        }
        public Task<int> WaitForExitAsync(CancellationToken token) => exit.Task.WaitAsync(token);
        public void Kill() { killed.Cancel(); fromPlugin.Complete(); toPlugin.Complete(); errors.Complete(); exit.TrySetResult(1); }
        public void Dispose() => Kill();
    }
    private sealed class FakeFactory(Func<Script> next) : IPluginProcessFactory
    {
        internal int Started; internal string? LastExe; internal Action<string>? OnStart; internal string? Stderr; internal string? LastAccountSid; internal bool LastAccountOpen;
        public IPluginProcess Start(string executable, string workingDirectory, IPluginAccountToken? account = null)
        {
            OnStart?.Invoke(executable);
            Started++; LastExe = executable; LastAccountSid = account?.UserSid; LastAccountOpen = account is not null && account.Handle != IntPtr.Zero;
            return new FakeProcess(next(), Stderr);
        }
    }
    // The block rules per plugin name with their program, as Ensure replaces a rule of the same name with another program.
    private sealed class FakeFirewall : IPluginFirewall
    {
        internal readonly Dictionary<string, string> Programs = new(StringComparer.Ordinal); internal int Removed;
        internal ICollection<string> Rules => Programs.Keys;
        public bool Blocked(string name, string executable) => Programs.TryGetValue(name, out var program) && string.Equals(program, executable, StringComparison.OrdinalIgnoreCase);
        public void Ensure(string name, string executable) => Programs[name] = executable;
        public void Remove(string name) { Programs.Remove(name); Removed++; }
        public void RemoveAll() => Programs.Clear();
    }
    private sealed class FakeReleases(Dictionary<string, byte[]> files) : IReleaseSource
    {
        public async Task CopyAsync(string url, long length, Stream output, IncrementalHash hash, CancellationToken token)
        {
            byte[] bytes = files[new Uri(url).AbsolutePath];
            if (bytes.Length != length) throw new InvalidDataException("Release slice length mismatch.");
            hash.AppendData(bytes); await output.WriteAsync(bytes, token);
        }
    }

    private static async Task WriteAsync(Stream output, JsonObject value) => await PluginProtocol.WriteLineAsync(output, value, PluginProtocol.MaximumPluginLine, CancellationToken.None);
    /// <summary>A well-behaved plugin: its hello, then one result with data for the request; `hello` and `result` change the lines.</summary>
    private static Script Plugin(string name = "dhcp", string version = "1.0.0", string[]? capabilities = null, Func<JsonObject, JsonObject>? hello = null, Func<JsonObject, JsonObject>? result = null, int exitCode = 0) => async (input, output, killed) =>
    {
        var brokerHello = PluginProtocol.Parse((await input.ReadLineAsync(PluginProtocol.MaximumBrokerLine, killed))!, "hello");
        if (PluginProtocol.Integer(brokerHello, "protocol") != 1) return 4;
        await WriteAsync(output, (hello ?? (value => value))(PluginProtocol.PluginHello(name, version, capabilities ?? ["dhcp-read"])));
        var line = await input.ReadLineAsync(PluginProtocol.MaximumBrokerLine, killed);
        if (line is null) return exitCode;
        var request = PluginProtocol.Parse(line, "request");
        var answer = PluginProtocol.Result(PluginProtocol.Text(request, "id"), true, "PLUGIN_DHCP_READ_COMPLETED", new Dictionary<string, string> { ["scopes"] = "3", ["leases"] = "20" }, "The DHCP server was read: 3 scopes, 20 leases.", new JsonObject { ["schema"] = 1 });
        await WriteAsync(output, (result ?? (value => value))(answer));
        return exitCode;
    };

    // ---- Signed manifests of a throwaway publisher --------------------------------------
    private static string Hex(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    // The S4U tokens of 4.19.0: counts every token it hands out and every close.
    private sealed class FakeTokens : IPluginTokenFactory
    {
        internal int Issued, Closed; internal string? Sid; internal AgentMessageException? Fail; internal PluginActAs? Last;
        public IPluginAccountToken Logon(PluginActAs actAs) { Last = actAs; if (Fail is not null) throw Fail; Issued++; return new FakeToken(this, Sid ?? actAs.UserSid); }
    }
    private sealed class FakeToken(FakeTokens owner, string sid) : IPluginAccountToken
    {
        private bool closed;
        public IntPtr Handle => closed ? IntPtr.Zero : (IntPtr)1;
        public string UserSid => sid;
        public void Dispose() { if (closed) return; closed = true; owner.Closed++; }
    }
    // The Windows side of ad-sign-in: a fixed directory and a scripted password check.
    private sealed class FakeLogon(AdDirectory directory, Func<AdAccount, string, AdVerified> verify) : IAdLogon
    {
        internal AdAccount? Last;
        public AdDirectory Directory() => directory;
        public AdVerified Verify(AdAccount account, string password) { Last = account; return verify(account, password); }
    }

    private static (string Manifest, string Signature) Sign(ECDsa key, string name, string version, byte[] exe, string minAgent = "4.16.0", string kind = "plugin", string[]? capabilities = null)
    {
        string manifest = new JsonObject
        {
            ["kind"] = kind, ["name"] = name, ["role"] = "dhcp", ["version"] = version, ["minAgentVersion"] = minAgent, ["protocolVersion"] = 1, ["os"] = new JsonArray("Windows Server 2022"), ["arch"] = "x64",
            ["capabilities"] = new JsonArray((capabilities ?? ["dhcp-read"]).Select(item => (JsonNode)JsonValue.Create(item)!).ToArray()), ["exe"] = new JsonObject { ["path"] = PluginFiles.DownloadPath(name, version), ["sha256"] = Hex(exe), ["size"] = exe.Length },
            ["changelog"] = new JsonObject { ["features"] = new JsonArray("Read the DHCP server."), ["fixes"] = new JsonArray() }, ["createdAt"] = "2026-11-01T00:00:00.000Z",
        }.ToJsonString();
        return (manifest, Convert.ToBase64String(key.SignData(Encoding.UTF8.GetBytes(manifest), HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence)));
    }
    private static void Place(string root, string name, (string Manifest, string Signature) signed, byte[] exe)
    {
        string folder = PluginFiles.Folder(root, name); Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Combine(folder, PluginFiles.ManifestFile), signed.Manifest, new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(folder, PluginFiles.SignatureFile), signed.Signature);
        File.WriteAllBytes(PluginFiles.Executable(root, name), exe);
    }

    private static async Task RunAsync()
    {
        using var publisher = ECDsa.Create(ECCurve.NamedCurves.nistP256); using var foreign = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        string pem = publisher.ExportSubjectPublicKeyInfoPem();
        byte[] exe = Encoding.UTF8.GetBytes("plugin executable bytes 1.0.0");
        var good = Sign(publisher, "dhcp", "1.0.0", exe);

        // 1. The signed manifest before every start.
        Check(PluginManifests.Verify(good.Manifest, good.Signature, "dhcp", "4.16.0", pem).Capabilities.SequenceEqual(new[] { "dhcp-read" }), "A valid plugin manifest was refused.");
        Check(CodeOf(() => PluginManifests.Verify(good.Manifest.Replace("1.0.0", "1.0.1"), good.Signature, "dhcp", "4.16.0", pem)) == "AGENT_PLUGIN_SIGNATURE_INVALID", "A changed manifest kept its signature.");
        var foreignSigned = Sign(foreign, "dhcp", "1.0.0", exe);
        Check(CodeOf(() => PluginManifests.Verify(foreignSigned.Manifest, foreignSigned.Signature, "dhcp", "4.16.0", pem)) == "AGENT_PLUGIN_SIGNATURE_INVALID", "A manifest of a foreign key was accepted.");
        Check(CodeOf(() => PluginManifests.Verify(good.Manifest, good.Signature, "dns", "4.16.0", pem)) == "AGENT_PLUGIN_SIGNATURE_INVALID", "A manifest of another plugin name was accepted.");
        var newer = Sign(publisher, "dhcp", "1.0.0", exe, minAgent: "9.0.0");
        Check(CodeOf(() => PluginManifests.Verify(newer.Manifest, newer.Signature, "dhcp", "4.16.0", pem)) == "AGENT_PLUGIN_AGENT_TOO_OLD", "A plugin for a newer agent was accepted.");
        var agentKind = Sign(publisher, "dhcp", "1.0.0", exe, kind: "agent");
        Check(CodeOf(() => PluginManifests.Verify(agentKind.Manifest, agentKind.Signature, "dhcp", "4.16.0", pem)) == "AGENT_PLUGIN_SIGNATURE_INVALID", "A manifest of another kind was accepted.");
        // Dev builds: a plugin's own version may be X.Y.Z-dev.<sha7>; the minimum agent version stays X.Y.Z
        // and a dev agent meets it by its base.
        var devPlugin = Sign(publisher, "dhcp", "1.0.1-dev.abc1234", exe);
        Check(PluginManifests.Verify(devPlugin.Manifest, devPlugin.Signature, "dhcp", "4.16.0", pem).Version == "1.0.1-dev.abc1234", "A signed dev plugin manifest was refused.");
        foreach (string malformed in new[] { "1.0.1-dev.ABC1234", "1.0.1-dev.abc123", "1.0.1-rc.1", "1.0.1-dev.abc1234.1" })
        {
            var refused = Sign(publisher, "dhcp", malformed, exe);
            Check(CodeOf(() => PluginManifests.Verify(refused.Manifest, refused.Signature, "dhcp", "4.16.0", pem)) == "AGENT_PLUGIN_SIGNATURE_INVALID", "The plugin version " + malformed + " was accepted.");
        }
        var devMinimum = Sign(publisher, "dhcp", "1.0.0", exe, minAgent: "4.16.0-dev.abc1234");
        Check(CodeOf(() => PluginManifests.Verify(devMinimum.Manifest, devMinimum.Signature, "dhcp", "4.16.0", pem)) == "AGENT_PLUGIN_SIGNATURE_INVALID", "A dev minimum agent version was accepted.");
        var baseMinimum = Sign(publisher, "dhcp", "1.0.0", exe, minAgent: "4.21.5");
        Check(CodeOf(() => PluginManifests.Verify(baseMinimum.Manifest, baseMinimum.Signature, "dhcp", "4.21.5-dev.abc1234", pem)) == "none", "A dev agent did not meet the minimum of its base version.");
        Check(CodeOf(() => PluginManifests.Verify(baseMinimum.Manifest, baseMinimum.Signature, "dhcp", "4.21.4-dev.abc1234", pem)) == "AGENT_PLUGIN_AGENT_TOO_OLD", "A dev agent of a lower base met a higher minimum.");
        Check(PluginProtocol.IsVersion("1.0.1-dev.abc1234") && !PluginProtocol.IsVersion("1.0.1-dev.abc123") && !PluginProtocol.IsBaseVersion("1.0.1-dev.abc1234"), "The plugin version patterns differ from the dev build rule.");

        // 2. The DACL decision of the plugin folders.
        PluginAcl.Ace Ace(string sid, int rights, bool allow = true) => new(sid, rights, allow);
        const string users = "S-1-5-32-545", everyone = "S-1-1-0";
        var trusted = new[] { Ace(PluginAcl.SystemSid, 0x1F01FF), Ace(PluginAcl.AdministratorsSid, 0x1F01FF) };
        Check(PluginAcl.UnsafeReason(PluginAcl.AdministratorsSid, trusted, true, true) is null, "The protected SYSTEM and Administrators DACL was refused.");
        Check(PluginAcl.UnsafeReason(users, trusted, true, true) == "owner", "An owner other than SYSTEM or Administrators was accepted.");
        Check(PluginAcl.UnsafeReason(PluginAcl.SystemSid, trusted, false, true) == "inherited", "plugins\\ with inherited ACEs was accepted.");
        Check(PluginAcl.UnsafeReason(PluginAcl.SystemSid, trusted, false, false) is null, "A plugin folder that inherits the protected parent was refused.");
        foreach (int right in new[] { 0x2, 0x4, 0x40, 0x10000, 0x40000, 0x80000, 0x40000000, 0x10000000 })
            Check(PluginAcl.UnsafeReason(PluginAcl.SystemSid, trusted.Append(Ace(users, right)), true, true)?.StartsWith("ace ") == true, "An unsafe right 0x" + right.ToString("X") + " for Users was accepted.");
        Check(PluginAcl.UnsafeReason(PluginAcl.SystemSid, trusted.Append(Ace(users, 0x1200A9)), true, true) is null, "Read and execute for Users was refused.");
        Check(PluginAcl.UnsafeReason(PluginAcl.SystemSid, trusted.Append(Ace(everyone, 0x1F01FF, allow: false)), true, true) is null, "A deny ACE was taken for a grant.");

        // 3. The ReadOnly decision of every plugin action.
        Check(JobRunner.AllowedInReadOnly("plugin-install") && JobRunner.AllowedInReadOnly("plugin-remove"), "Plugin install and removal must run in ReadOnly mode like agent-update.");
        Check(JobRunner.AllowedInReadOnly("plugin-job", new JsonObject { ["plugin"] = "dhcp", ["operation"] = "dhcp-read" }), "The DHCP read must run in ReadOnly mode.");
        Check(!JobRunner.AllowedInReadOnly("plugin-job", new JsonObject { ["plugin"] = "dhcp", ["operation"] = "dhcp-write" }) && !JobRunner.AllowedInReadOnly("plugin-job"), "Another plugin operation must need Management.");
        // 4.20.0: the two DNS reads run in ReadOnly mode; every DNS change needs Management.
        Check(JobRunner.AllowedInReadOnly("plugin-job", new JsonObject { ["plugin"] = "dns", ["operation"] = "dns-read" }) && JobRunner.AllowedInReadOnly("plugin-job", new JsonObject { ["plugin"] = "dns", ["operation"] = "dns-zone-read" }), "The DNS reads must run in ReadOnly mode.");
        Check(!JobRunner.AllowedInReadOnly("plugin-job", new JsonObject { ["plugin"] = "dns", ["operation"] = "dns-record-add" }) && !PluginHost.ReadOperation("dns-zone-create") && !PluginHost.ReadOperation("dns-cache-clear") && !PluginHost.ReadOperation("dns-readx"), "A DNS change ran as a read.");

        // 4. The protocol on one process, with short timeouts.
        var manifest = PluginManifests.Verify(good.Manifest, good.Signature, "dhcp", "4.16.0", pem);
        async Task<string> Session(Script script, string? operation = "dhcp-read", int helloMs = 2000, int resultMs = 2000)
        {
            using var process = new FakeProcess(script);
            try { await PluginSession.ExchangeAsync(process, manifest, "4.16.0", operation is null ? null : "0b7c2e64-58f1-4c47-9d4e-5a6b7c8d9e0f", operation, new JsonObject(), TimeSpan.FromMilliseconds(helloMs), TimeSpan.FromMilliseconds(resultMs), CancellationToken.None); return "ok"; }
            catch (AgentMessageException e) { return e.Code + (e.Args.TryGetValue("exitCode", out var code) ? ":" + code : ""); }
        }
        Check(await Session(Plugin()) == "ok", "A valid exchange failed.");
        Check(await Session(Plugin(), operation: null) == "ok", "The install handshake failed.");
        Check(await Session(Plugin(version: "2.0.0")) == "AGENT_PLUGIN_HANDSHAKE_FAILED", "A hello of another version was accepted.");
        Check(await Session(Plugin(capabilities: ["dhcp-read", "dhcp-write"])) == "AGENT_PLUGIN_HANDSHAKE_FAILED", "A hello with other capabilities was accepted.");
        Check(await Session(Plugin(hello: value => { value["protocol"] = 2; return value; })) == "AGENT_PLUGIN_HANDSHAKE_FAILED", "A hello of protocol 2 was accepted.");
        Check(await Session(Plugin(result: value => { value["id"] = Guid.NewGuid().ToString(); return value; })) == "AGENT_PLUGIN_OUTPUT_INVALID", "A result for another request was accepted.");
        Check(await Session(Plugin(result: value => { value["code"] = "AGENT_UPDATE_BUSY"; return value; })) == "AGENT_PLUGIN_OUTPUT_INVALID", "A plugin result with an agent code was accepted.");
        Check(await Session(async (input, output, killed) =>
        {
            await input.ReadLineAsync(PluginProtocol.MaximumBrokerLine, killed);
            await WriteAsync(output, PluginProtocol.PluginHello("dhcp", "1.0.0", ["dhcp-read"]));
            await input.ReadLineAsync(PluginProtocol.MaximumBrokerLine, killed);
            await output.WriteAsync(Encoding.UTF8.GetBytes(new string('x', PluginProtocol.MaximumPluginLine + 10) + "\n"), killed);
            return 0;
        }) == "AGENT_PLUGIN_OUTPUT_INVALID", "An oversized plugin line was accepted.");
        Check(await Session(async (input, output, killed) =>
        {
            await input.ReadLineAsync(PluginProtocol.MaximumBrokerLine, killed);
            await WriteAsync(output, PluginProtocol.PluginHello("dhcp", "1.0.0", ["dhcp-read"]));
            return 3;
        }) == "AGENT_PLUGIN_CRASHED:3", "An end of stream before the result did not report the crash and its exit code.");
        Check(await Session(Plugin(exitCode: 5)) == "AGENT_PLUGIN_CRASHED:5", "A non-zero exit after the result was accepted.");
        Check(await Session(async (input, output, killed) => { await Task.Delay(Timeout.Infinite, killed); return 0; }, helloMs: 200) == "AGENT_PLUGIN_TIMEOUT", "A missing hello did not time out.");
        Check(await Session(async (input, output, killed) =>
        {
            await input.ReadLineAsync(PluginProtocol.MaximumBrokerLine, killed);
            await WriteAsync(output, PluginProtocol.PluginHello("dhcp", "1.0.0", ["dhcp-read"]));
            await Task.Delay(Timeout.Infinite, killed); return 0;
        }, resultMs: 200) == "AGENT_PLUGIN_TIMEOUT", "A missing result did not time out.");

        // 5. The host: checks before the start, the run, the report, the busy gate, install and removal.
        string root = Path.Combine(Path.GetTempPath(), "ServerDesk-PluginTest-" + Guid.NewGuid().ToString("N"));
        try
        {
            Script current = Plugin(); var factory = new FakeFactory(() => current); var firewall = new FakeFirewall(); string? unsafeAcl = null;
            var now = DateTimeOffset.FromUnixTimeSeconds(1790000100);
            var log = new List<string>();
            var host = new PluginHost(root, line => { lock (log) log.Add(line); }, factory, firewall, pem, (_, _) => unsafeAcl, () => now, "4.16.0");
            Check(host.Report().Count == 0, "A host without plugins reported one.");
            Check(await CodeOfAsync(() => host.RunAsync("dhcp", "dhcp-read", new JsonObject(), Guid.NewGuid().ToString(), CancellationToken.None)) == "AGENT_PLUGIN_NOT_INSTALLED", "A missing plugin did not answer not installed.");
            Place(root, "dhcp", good, exe);
            var result = await host.RunAsync("dhcp", "dhcp-read", new JsonObject(), Guid.NewGuid().ToString(), CancellationToken.None);
            Check(result.Ok && result.Code == "PLUGIN_DHCP_READ_COMPLETED" && result.Data is not null && factory.Started == 1 && firewall.Rules.Contains("dhcp"), "A verified plugin did not run with its firewall rules.");
            Check(await CodeOfAsync(() => host.RunAsync("dhcp", "dhcp-write", new JsonObject(), Guid.NewGuid().ToString(), CancellationToken.None)) == "AGENT_PLUGIN_OPERATION_UNKNOWN" && factory.Started == 1, "An operation outside the manifest started the plugin.");
            unsafeAcl = "ace S-1-5-32-545";
            Check(await CodeOfAsync(() => host.RunAsync("dhcp", "dhcp-read", new JsonObject(), Guid.NewGuid().ToString(), CancellationToken.None)) == "AGENT_PLUGIN_FOLDER_UNSAFE" && factory.Started == 1, "An unsafe folder started the plugin.");
            unsafeAcl = null;
            // A crash fails one request; the next request starts a fresh process.
            current = async (input, output, killed) => { await input.ReadLineAsync(PluginProtocol.MaximumBrokerLine, killed); return 7; };
            Check(await CodeOfAsync(() => host.RunAsync("dhcp", "dhcp-read", new JsonObject(), Guid.NewGuid().ToString(), CancellationToken.None)) == "AGENT_PLUGIN_CRASHED", "A crashed plugin did not fail its request.");
            current = Plugin();
            Check((await host.RunAsync("dhcp", "dhcp-read", new JsonObject(), Guid.NewGuid().ToString(), CancellationToken.None)).Ok && factory.Started == 3, "The request after a crash did not start a fresh plugin.");
            // The job: data through the upload with the job id, only code and arguments in the result.
            var uploads = new List<PluginUpload>(); string jobId = Guid.NewGuid().ToString();
            var jobResult = await host.RunJobAsync(new JsonObject { ["id"] = jobId, ["action"] = "plugin-job", ["parameters"] = new JsonObject { ["plugin"] = "dhcp", ["operation"] = "dhcp-read" } }, (upload, _) => { uploads.Add(upload); return Task.CompletedTask; }, CancellationToken.None);
            Check(jobResult["ok"]?.GetValue<bool>() == true && jobResult["code"]?.GetValue<string>() == "PLUGIN_DHCP_READ_COMPLETED" && jobResult["args"]?["scopes"]?.GetValue<string>() == "3" && jobResult["data"] is null, "The plugin job result is not the plugin code without data.");
            Check(uploads.Count == 1 && uploads[0].JobId == jobId && uploads[0].Plugin == "dhcp", "The job data did not go to the upload with the job id.");
            // 4.21.2: the data of a result line have no parent, so the real upload envelope takes them ("The node already has a parent" in 4.20.0).
            {
                var line = PluginProtocol.Parse(Encoding.UTF8.GetBytes(PluginProtocol.Result(jobId, true, "PLUGIN_DHCP_READ_COMPLETED", new Dictionary<string, string>(), "Read.", new JsonObject { ["schema"] = 1, ["scopes"] = new JsonArray(new JsonObject { ["id"] = "10.0.0.0" }) }).ToJsonString()), "result");
                var read = PluginProtocol.ReadResult(line, jobId);
                Check(read.Data is not null && read.Data.Parent is null && read.Data.ToJsonString() == line["data"]!.ToJsonString(), "ReadResult returned data with a parent or with other content.");
                var holder = new JsonObject { ["data"] = new JsonObject { ["schema"] = 2 } };
                var copied = PluginProtocol.UploadMessage(new PluginUpload("dhcp", "dhcp-read", null, "2026-11-10T09:00:00Z", holder["data"]!.AsObject()));
                Check(copied["data"]?["schema"]?.GetValue<int>() == 2 && holder["data"] is not null && copied["kind"]?.GetValue<string>() == "plugin-data-upload", "The envelope builder threw on or moved data that have a parent.");
                // A read job with and without actAs: one upload through the real builder, an ok result with the plugin code; a read ignores actAs.
                var actAs = new JsonObject { ["sessionId"] = Guid.NewGuid().ToString(), ["userSid"] = "S-1-5-21-1000-2000-3000-1105", ["logonName"] = @"CORPnna", ["account"] = @"CORPnna", ["kind"] = "domain" };
                foreach (var withAccount in new[] { false, true })
                {
                    var envelopes = new List<JsonObject>(); string readJob = Guid.NewGuid().ToString();
                    var parameters = new JsonObject { ["plugin"] = "dhcp", ["operation"] = "dhcp-read" }; if (withAccount) parameters["actAs"] = actAs.DeepClone();
                    var answer = await host.RunJobAsync(new JsonObject { ["id"] = readJob, ["action"] = "plugin-job", ["parameters"] = parameters }, (upload, _) => { envelopes.Add(PluginProtocol.UploadMessage(upload)); return Task.CompletedTask; }, CancellationToken.None);
                    Check(answer["ok"]?.GetValue<bool>() == true && answer["code"]?.GetValue<string>() == "PLUGIN_DHCP_READ_COMPLETED" && factory.LastAccountSid is null, "A read job " + (withAccount ? "with" : "without") + " actAs did not succeed as SYSTEM with the plugin code.");
                    var sent = envelopes.Count == 1 ? JsonNode.Parse(envelopes[0].ToJsonString())!.AsObject() : null;
                    Check(sent?["jobId"]?.GetValue<string>() == readJob && sent?["data"]?["schema"]?.GetValue<int>() == 1 && sent?["operation"]?.GetValue<string>() == "dhcp-read", "A read job " + (withAccount ? "with" : "without") + " actAs did not upload its data once through the envelope.");
                }
                // An upload that throws: AGENT_PLUGIN_UPLOAD_FAILED in the result, the text only in the log.
                async Task<JsonObject> Failed(Func<Task<JsonObject>> run) { try { return await run(); } catch (Exception e) { return AgentMessages.Fail(new JsonObject { ["ok"] = false }, e); } }
                JsonObject ReadJob() => new() { ["id"] = Guid.NewGuid().ToString(), ["action"] = "plugin-job", ["parameters"] = new JsonObject { ["plugin"] = "dhcp", ["operation"] = "dhcp-read" } };
                var lost = await Failed(() => host.RunJobAsync(ReadJob(), (_, _) => throw new InvalidOperationException("The node already has a parent."), CancellationToken.None));
                string uploadLog; lock (log) uploadLog = string.Join(" | ", log);
                Check(lost["code"]?.GetValue<string>() == "AGENT_PLUGIN_UPLOAD_FAILED" && lost["ok"]?.GetValue<bool>() == false && !lost.ToJsonString().Contains("parent", StringComparison.Ordinal), "A failed upload did not give AGENT_PLUGIN_UPLOAD_FAILED without the exception text.");
                Check(uploadLog.Contains("Plugin upload dhcp/dhcp-read: The node already has a parent.", StringComparison.Ordinal), "A failed upload did not log its text.");
                // A process start that throws an uncoded exception: AGENT_PLUGIN_FAILED, the text only in the log.
                factory.OnStart = _ => throw new System.ComponentModel.Win32Exception(2, "Start failed for the test.");
                var broken = await Failed(() => host.RunJobAsync(ReadJob(), (_, _) => Task.CompletedTask, CancellationToken.None));
                factory.OnStart = null;
                string startLog; lock (log) startLog = string.Join(" | ", log);
                Check(broken["code"]?.GetValue<string>() == "AGENT_PLUGIN_FAILED" && !broken.ToJsonString().Contains("Start failed", StringComparison.Ordinal), "An uncoded failure of a plugin job did not give AGENT_PLUGIN_FAILED without the exception text.");
                Check(startLog.Contains("Plugin job dhcp/dhcp-read: Start failed for the test.", StringComparison.Ordinal), "An uncoded failure of a plugin job did not log its text.");
                // A periodic read under the plugin policy uploads its data through the real envelope and logs nothing.
                var tickNow = now; var tickLog = new List<string>(); var periodicSent = new List<JsonObject>();
                var periodic = new PluginHost(root, line => { lock (tickLog) tickLog.Add(line); }, factory, firewall, pem, (_, _) => null, () => tickNow, "4.16.0");
                periodic.ConfigurePolicy(new JsonObject { ["policy"] = new JsonObject { ["collect"] = new JsonArray(new JsonObject { ["plugin"] = "dhcp", ["operation"] = "dhcp-read", ["intervalSeconds"] = 900L }) }, ["exp"] = tickNow.ToUnixTimeSeconds() + 900 });
                tickNow = tickNow.AddSeconds(61);
                periodic.Tick(false, (upload, _) => { lock (periodicSent) periodicSent.Add(PluginProtocol.UploadMessage(upload)); return Task.CompletedTask; }, CancellationToken.None);
                await periodic.StopAsync();
                string ticked; lock (tickLog) ticked = string.Join(" | ", tickLog);
                Check(periodicSent.Count == 1 && periodicSent[0]["jobId"] is null && periodicSent[0]["data"]?["schema"]?.GetValue<int>() == 1 && !ticked.Contains("Plugin read", StringComparison.Ordinal), "A periodic read did not upload its data or logged an error: " + ticked);
            }
            // 4.17.0 (plugin-secrets): the sealed secrets of a job open with the device key, reach the plugin as
            // parameters.secrets, and are masked in the result, the message and the logged stderr.
            {
                const string secret = "failover-secret-4161";
                using var deviceKey = RSA.Create(2048);
                JsonObject Seal(JsonObject value)
                {
                    byte[] material = RandomNumberGenerator.GetBytes(64), iv = RandomNumberGenerator.GetBytes(16), plain = Encoding.UTF8.GetBytes(value.ToJsonString());
                    using var aes = Aes.Create(); aes.Key = material[..32]; byte[] cipher = aes.EncryptCbc(plain, iv);
                    return new JsonObject { ["key"] = Convert.ToBase64String(deviceKey.Encrypt(material, RSAEncryptionPadding.OaepSHA1)), ["iv"] = Convert.ToBase64String(iv), ["data"] = Convert.ToBase64String(cipher), ["mac"] = Convert.ToBase64String(HMACSHA256.HashData(material[32..], iv.Concat(cipher).ToArray())) };
                }
                JsonObject Open(JsonObject box)
                {
                    byte[] key = deviceKey.Decrypt(Convert.FromBase64String(box["key"]!.GetValue<string>()), RSAEncryptionPadding.OaepSHA1);
                    byte[] iv = Convert.FromBase64String(box["iv"]!.GetValue<string>()), data = Convert.FromBase64String(box["data"]!.GetValue<string>());
                    if (!CryptographicOperations.FixedTimeEquals(HMACSHA256.HashData(key.AsSpan(32), iv.Concat(data).ToArray()), Convert.FromBase64String(box["mac"]!.GetValue<string>()))) throw new CryptographicException("Parameter integrity failed");
                    using var aes = Aes.Create(); aes.Key = key[..32]; return JsonNode.Parse(aes.DecryptCbc(data, iv))!.AsObject();
                }
                string seen = "", name = "";
                current = async (input, output, killed) =>
                {
                    await input.ReadLineAsync(PluginProtocol.MaximumBrokerLine, killed);
                    await WriteAsync(output, PluginProtocol.PluginHello("dhcp", "1.0.0", ["dhcp-read"]));
                    var request = PluginProtocol.Parse((await input.ReadLineAsync(PluginProtocol.MaximumBrokerLine, killed))!, "request");
                    seen = request["parameters"]?["secrets"]?["secret"]?.GetValue<string>() ?? ""; name = request["parameters"]?["name"]?.GetValue<string>() ?? "";
                    await WriteAsync(output, PluginProtocol.Result(PluginProtocol.Text(request, "id"), false, "PLUGIN_DHCP_CHANGE_FAILED", new Dictionary<string, string> { ["error"] = seen }, "Refused with " + seen, null));
                    return 0;
                };
                factory.Stderr = "trace " + secret + " " + JsonValue.Create(secret)!.ToJsonString();
                JsonObject SecretJob(JsonObject box) => new() { ["id"] = Guid.NewGuid().ToString(), ["action"] = "plugin-job", ["parameters"] = new JsonObject { ["plugin"] = "dhcp", ["operation"] = "dhcp-read", ["parameters"] = new JsonObject { ["name"] = "DC01-DC03" }, ["secretParameters"] = box } };
                var masked = await host.RunJobAsync(SecretJob(Seal(new JsonObject { ["secret"] = secret })), (_, _) => Task.CompletedTask, CancellationToken.None, Open);
                await Task.Delay(100);
                string logged; lock (log) logged = string.Join(" | ", log);
                Check(seen == secret && name == "DC01-DC03", "The plugin did not get the opened secret next to its parameters.");
                Check(masked.ToJsonString().Contains(SecretMask.Redacted, StringComparison.Ordinal) && !masked.ToJsonString().Contains(secret, StringComparison.Ordinal) && masked["code"]?.GetValue<string>() == "PLUGIN_DHCP_CHANGE_FAILED", "The secret was not masked in the job result.");
                Check(logged.Contains("trace", StringComparison.Ordinal) && !logged.Contains(secret, StringComparison.Ordinal), "The secret reached the log through the plugin's stderr.");
                // A broken box fails the job before the plugin starts; without the key the same.
                int before = factory.Started; var broken = Seal(new JsonObject { ["secret"] = secret }); broken["mac"] = Convert.ToBase64String(new byte[32]);
                Check(await CodeOfAsync(() => host.RunJobAsync(SecretJob(broken), (_, _) => Task.CompletedTask, CancellationToken.None, Open)) == "AGENT_PLUGIN_SECRET_INVALID" && factory.Started == before, "A broken sealed box did not fail the job before the start.");
                Check(await CodeOfAsync(() => host.RunJobAsync(SecretJob(Seal(new JsonObject { ["secret"] = secret })), (_, _) => Task.CompletedTask, CancellationToken.None)) == "AGENT_PLUGIN_SECRET_INVALID" && factory.Started == before, "A box without the device key did not fail the job.");
                factory.Stderr = null; current = Plugin();
            }
            // The report: ready with the verified manifest, damaged with the code after a changed EXE.
            var report = host.Report();
            Check(report.Count == 1 && report[0]?["state"]?.GetValue<string>() == "ready" && report[0]?["version"]?.GetValue<string>() == "1.0.0" && report[0]?["networkBlocked"]?.GetValue<bool>() == true, "The report does not show the ready plugin.");
            File.WriteAllBytes(PluginFiles.Executable(root, "dhcp"), Encoding.UTF8.GetBytes("plugin executable bytes 1.0.X"));
            Check(host.Report()[0]?["state"]?.GetValue<string>() == "ready", "The report was not cached.");
            now = now.AddMinutes(16);
            var damaged = host.Report();
            Check(damaged[0]?["state"]?.GetValue<string>() == "damaged" && damaged[0]?["error"]?.GetValue<string>() == "AGENT_PLUGIN_HASH_MISMATCH", "A changed EXE was not reported damaged after 15 minutes.");
            int started = factory.Started;
            Check(await CodeOfAsync(() => host.RunAsync("dhcp", "dhcp-read", new JsonObject(), Guid.NewGuid().ToString(), CancellationToken.None)) == "AGENT_PLUGIN_HASH_MISMATCH" && factory.Started == started, "A changed EXE started.");
            // Install (repair): download into staging, handshake, swap; a failing new version keeps the old folder.
            byte[] next = Encoding.UTF8.GetBytes("plugin executable bytes 1.1.0");
            var update = Sign(publisher, "dhcp", "1.1.0", next);
            var releases = new FakeReleases(new Dictionary<string, byte[]> { [PluginFiles.DownloadPath("dhcp", "1.1.0")] = next, [PluginFiles.DownloadPath("dhcp", "1.0.0")] = exe });
            JsonObject Job(string version, (string Manifest, string Signature) signed) => new() { ["id"] = Guid.NewGuid().ToString(), ["action"] = "plugin-install", ["parameters"] = new JsonObject { ["name"] = "dhcp", ["releaseId"] = Guid.NewGuid().ToString(), ["version"] = version, ["manifest"] = signed.Manifest, ["signature"] = signed.Signature } };
            current = Plugin();
            var repaired = await host.InstallAsync(Job("1.0.0", good), "https://portal.test/", releases, CancellationToken.None);
            Check(repaired["code"]?.GetValue<string>() == "AGENT_PLUGIN_INSTALLED" && host.Report()[0]?["state"]?.GetValue<string>() == "ready", "Repair did not restore a ready plugin.");
            // Every start, also the handshake from staging, finds both block rules for exactly the EXE it starts.
            string finalExe = PluginFiles.Executable(root, "dhcp");
            var starts = new List<(string Exe, string? Rule)>();
            factory.OnStart = started => starts.Add((started, firewall.Programs.GetValueOrDefault("dhcp")));
            current = Plugin(version: "1.0.0");
            Check(await CodeOfAsync(() => host.InstallAsync(Job("1.1.0", update), "https://portal.test/", releases, CancellationToken.None)) == "AGENT_PLUGIN_HANDSHAKE_FAILED", "A staged plugin with a wrong hello was installed.");
            Check(host.Report()[0]?["version"]?.GetValue<string>() == "1.0.0" && Directory.GetDirectories(Path.Combine(PluginFiles.Root(root), PluginFiles.StagingFolder)).Length == 0, "A failed install did not keep the old plugin or left its staging folder.");
            Check(starts.Count == 1 && starts[0].Exe.Contains(PluginFiles.StagingFolder, StringComparison.Ordinal) && starts[0].Rule == starts[0].Exe, "The staged plugin started before its firewall rules existed.");
            Check(firewall.Programs.GetValueOrDefault("dhcp") == finalExe, "A failed install did not point the firewall rules back to the kept plugin.");
            var tampered = new FakeReleases(new Dictionary<string, byte[]> { [PluginFiles.DownloadPath("dhcp", "1.1.0")] = Encoding.UTF8.GetBytes("plugin executable bytes 1.1.X") });
            Check(await CodeOfAsync(() => host.InstallAsync(Job("1.1.0", update), "https://portal.test/", tampered, CancellationToken.None)) == "AGENT_PLUGIN_HASH_MISMATCH", "A download with other bytes was installed.");
            current = Plugin(version: "1.1.0");
            var installed = await host.InstallAsync(Job("1.1.0", update), "https://portal.test/", releases, CancellationToken.None);
            Check(installed["args"]?["version"]?.GetValue<string>() == "1.1.0" && host.Report()[0]?["version"]?.GetValue<string>() == "1.1.0" && File.ReadAllText(Path.Combine(PluginFiles.Folder(root, "dhcp"), PluginFiles.ManifestFile)) == update.Manifest, "The update did not install the exact signed manifest.");
            Check(starts.Count == 2 && starts[1].Exe.Contains(PluginFiles.StagingFolder, StringComparison.Ordinal) && starts[1].Rule == starts[1].Exe, "The staged update started before its firewall rules existed.");
            Check(firewall.Programs.GetValueOrDefault("dhcp") == finalExe && host.Report()[0]?["networkBlocked"]?.GetValue<bool>() == true, "After the swap the firewall rules do not block the installed EXE.");
            factory.OnStart = null;
            Check(CodeOf(() => host.InstallAsync(Job("1.1.0", (update.Manifest, foreignSigned.Signature)), "https://portal.test/", releases, CancellationToken.None).GetAwaiter().GetResult()) == "AGENT_PLUGIN_SIGNATURE_INVALID", "An install with a foreign signature was accepted.");
            // The busy gate: a periodic read skips a plugin that runs right now.
            current = async (input, output, killed) => { await Task.Delay(Timeout.Infinite, killed); return 0; };
            var blocking = host.RunAsync("dhcp", "dhcp-read", new JsonObject(), Guid.NewGuid().ToString(), CancellationToken.None);
            await Task.Delay(100);
            Check(await CodeOfAsync(() => host.RunAsync("dhcp", "dhcp-read", new JsonObject(), Guid.NewGuid().ToString(), CancellationToken.None, wait: false)) == "AGENT_PLUGIN_BUSY", "A second request did not find the plugin busy.");
            try { await blocking; } catch (AgentMessageException) { }
            current = Plugin(version: "1.1.0");
            await KeptEntriesAsync(root, publisher, pem, host, factory, firewall, () => now, next, script => current = script);
            current = Plugin(version: "1.1.0");
            // Removal: the folder and the firewall rules go.
            var removed = await host.RemoveAsync(Guid.NewGuid().ToString(), "dhcp", CancellationToken.None);
            Check(removed["code"]?.GetValue<string>() == "AGENT_PLUGIN_REMOVED" && !Directory.Exists(PluginFiles.Folder(root, "dhcp")) && !firewall.Rules.Contains("dhcp") && host.Report().Count == 0, "Removal left the plugin or its rules.");
            Check(await CodeOfAsync(() => host.RemoveAsync(Guid.NewGuid().ToString(), "dhcp", CancellationToken.None)) == "AGENT_PLUGIN_NOT_INSTALLED", "Removing a missing plugin did not answer not installed.");
            // A first install that fails its handshake leaves no firewall rule behind.
            current = Plugin(version: "1.0.0");
            Check(await CodeOfAsync(() => host.InstallAsync(Job("1.1.0", update), "https://portal.test/", releases, CancellationToken.None)) == "AGENT_PLUGIN_HANDSHAKE_FAILED" && !firewall.Rules.Contains("dhcp") && !Directory.Exists(PluginFiles.Folder(root, "dhcp")), "A failed first install left firewall rules or a folder.");

            // 6. The signed plugin policy: the Node vector, then expired, foreign and unsigned policies.
            const string key = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE0VUPBqqmyFw1aNq5RZEdv0+jpnlpCJhRZqUpEvqes+BEv2NijFqt31Rj8OifX6UJs0TYu/UP0yogP3Yy/6cnww==";
            const string payload = """{"policy":{"collect":[{"plugin":"dhcp","operation":"dhcp-read","intervalSeconds":900}]},"v":1,"kind":"plugin-policy","deviceId":"6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b","iat":1790000000,"exp":1790000900}""";
            const string signature = "yDJ3UoLeMlKDbHM4aJXBfGfN2DPFL4v+3dem9Z7nqCr8IoMJVYyOSaJj/Hgr1he7WSzrq4JAdYvv3Lwb1Znxng==";
            const string device = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
            now = DateTimeOffset.FromUnixTimeSeconds(1790000100);
            var verifier = new DispatchVerifier(key, device, () => now);
            var envelope = new JsonObject { ["payload"] = payload, ["signature"] = signature };
            var policy = verifier.Verify(envelope, "plugin-policy", DispatchVerifier.JobLifetime);
            Check(policy["policy"]?["collect"]?[0]?["operation"]?.GetValue<string>() == "dhcp-read" && policy["exp"]!.GetValue<long>() - policy["iat"]!.GetValue<long>() == 900, "The portal's signed plugin policy did not verify.");
            var schedule = new PluginHost(root, _ => { }, factory, firewall, pem, (_, _) => null, () => now, "4.16.0");
            var blocked = new PluginHost(root, _ => { }, factory, firewall, pem, (_, _) => null, () => now, "4.16.0");
            schedule.ConfigurePolicy(policy); blocked.ConfigurePolicy(policy);
            Check(schedule.Due(false).Length == 0, "A policy ran before its first minute.");
            now = now.AddSeconds(60);
            Check(schedule.Due(false).Length == 1 && schedule.Due(false).Length == 0, "A due read did not run once per interval.");
            Check(blocked.Due(true).Length == 0 && blocked.Due(false).Length == 0, "A blocked run was queued instead of skipped.");
            now = DateTimeOffset.FromUnixTimeSeconds(1790000900 + 1);
            Check(schedule.Due(false).Length == 0, "An expired policy kept collecting.");
            now = DateTimeOffset.FromUnixTimeSeconds(1790000900 + 200);
            Check(schedule.Due(false).Length == 0, "An expired policy kept collecting.");
            Check(Rejected(() => verifier.Verify(envelope, "plugin-policy", DispatchVerifier.JobLifetime)), "An expired policy envelope verified.");
            now = DateTimeOffset.FromUnixTimeSeconds(1790000100);
            Check(Rejected(() => verifier.Verify(envelope, "drift-policy", DispatchVerifier.JobLifetime)), "A plugin policy verified as another kind.");
            Check(Rejected(() => new DispatchVerifier(Convert.ToBase64String(foreign.ExportSubjectPublicKeyInfo()), device, () => now).Verify(envelope, "plugin-policy", DispatchVerifier.JobLifetime)), "A policy of a foreign portal key verified.");
            Check(Rejected(() => verifier.Verify(new JsonObject { ["payload"] = payload }, "plugin-policy", DispatchVerifier.JobLifetime)), "An unsigned policy verified.");
            schedule.ConfigurePolicy(policy); now = now.AddSeconds(61); schedule.ConfigurePolicy(null);
            Check(schedule.Due(false).Length == 0, "A refused policy did not stop the collection.");
            // Periodic runs ignore the agent mode, so a signed entry with a write operation is dropped.
            var writing = new PluginHost(root, _ => { }, factory, firewall, pem, (_, _) => null, () => now, "4.16.0");
            writing.ConfigurePolicy(new JsonObject { ["policy"] = new JsonObject { ["collect"] = new JsonArray(new JsonObject { ["plugin"] = "dhcp", ["operation"] = "dhcp-write", ["intervalSeconds"] = 900L }, new JsonObject { ["plugin"] = "dhcp", ["operation"] = "dhcp-read", ["intervalSeconds"] = 900L }) }, ["exp"] = now.ToUnixTimeSeconds() + 900 });
            now = now.AddSeconds(61);
            var due = writing.Due(false);
            Check(due.Length == 1 && due[0].ToString().Contains("dhcp-read", StringComparison.Ordinal), "A plugin policy started a write operation.");
            // 4.20.0: the DNS server read is kept, a DNS change is dropped.
            var dns = new PluginHost(root, _ => { }, factory, firewall, pem, (_, _) => null, () => now, "4.20.0");
            dns.ConfigurePolicy(new JsonObject { ["policy"] = new JsonObject { ["collect"] = new JsonArray(new JsonObject { ["plugin"] = "dns", ["operation"] = "dns-read", ["intervalSeconds"] = 900L }, new JsonObject { ["plugin"] = "dns", ["operation"] = "dns-record-add", ["intervalSeconds"] = 900L }) }, ["exp"] = now.ToUnixTimeSeconds() + 900 });
            now = now.AddSeconds(61);
            var dnsDue = dns.Due(false);
            Check(dnsDue.Length == 1 && dnsDue[0].ToString().Contains("dns-read", StringComparison.Ordinal) && !dnsDue[0].ToString().Contains("dns-record-add", StringComparison.Ordinal), "The DNS policy did not keep dns-read alone.");
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }

    /// <summary>
    /// 4.21.1: with two installed plugins, a plugin whose gate is busy (here a
    /// running read) keeps its last entry in the report also after Invalidate();
    /// after the release the next report is fresh. A host that never saw a busy
    /// plugin leaves it out without caching, so the next report lists it; a
    /// removed plugin is not kept.
    /// </summary>
    private static async Task KeptEntriesAsync(string root, ECDsa publisher, string pem, PluginHost host, FakeFactory factory, FakeFirewall firewall, Func<DateTimeOffset> clock, byte[] dhcpExe, Action<Script> use)
    {
        static string Names(JsonArray list) => string.Join(",", list.Select(item => item?["name"]?.GetValue<string>() + " " + item?["state"]?.GetValue<string>()));
        byte[] dnsExe = Encoding.UTF8.GetBytes("plugin executable bytes dns 1.0.0");
        Place(root, "dns", Sign(publisher, "dns", "1.0.0", dnsExe), dnsExe);
        host.Invalidate();
        Check(Names(host.Report()) == "dhcp ready,dns ready", "The report does not list both installed plugins.");
        // Hold the gate of dhcp with a read that waits, change its EXE, then invalidate the report.
        var hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        use(async (input, output, killed) => { await hold.Task.WaitAsync(killed); return 0; });
        var reading = host.RunAsync("dhcp", "dhcp-read", new JsonObject(), Guid.NewGuid().ToString(), CancellationToken.None);
        await Task.Delay(100);
        string dhcpPath = PluginFiles.Executable(root, "dhcp");
        File.WriteAllBytes(dhcpPath, Encoding.UTF8.GetBytes("plugin executable bytes 1.1.X"));
        host.Invalidate();
        Check(Names(host.Report()) == "dhcp ready,dns ready", "A plugin with a busy gate left the report after Invalidate().");
        hold.SetResult();
        try { await reading; } catch (AgentMessageException) { }
        host.Invalidate();
        Check(Names(host.Report()) == "dhcp damaged,dns ready", "After the release the next report was not built fresh.");
        File.WriteAllBytes(dhcpPath, dhcpExe);
        host.Invalidate();
        Check(Names(host.Report()) == "dhcp ready,dns ready", "The restored plugin was not ready again.");
        // A host without a last entry of the busy plugin leaves it out and does not cache that report.
        var cold = new PluginHost(root, _ => { }, factory, firewall, pem, (_, _) => null, clock, "4.16.0");
        hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        use(async (input, output, killed) => { await hold.Task.WaitAsync(killed); return 0; });
        var coldReading = cold.RunAsync("dns", "dhcp-read", new JsonObject(), Guid.NewGuid().ToString(), CancellationToken.None);
        await Task.Delay(100);
        Check(Names(cold.Report()) == "dhcp ready", "A busy plugin without a last entry was reported.");
        hold.SetResult();
        try { await coldReading; } catch (AgentMessageException) { }
        Check(Names(cold.Report()) == "dhcp ready,dns ready", "A report that skipped a busy plugin was cached for its lifetime.");
        // A removed plugin is not kept from its last entry.
        var removed = await host.RemoveAsync(Guid.NewGuid().ToString(), "dns", CancellationToken.None);
        Check(removed["code"]?.GetValue<string>() == "AGENT_PLUGIN_REMOVED" && Names(host.Report()) == "dhcp ready", "A removed plugin stayed in the report.");
    }

    // The account parsing of ad-sign-in, the same vectors as parseAdAccount in lib/plugin-ad.ts (tests/lib/plugin-ad.mjs reads these lines).
    // Domain device: corp.example, NetBIOS CORP, computer SRV1. Workgroup server: WG1. "!code" is a refusal.
    private static readonly (string Input, string Kind, string Expected)[] AccountVectors =
    [
        (@"CORP\anna", "domain", @"CORP\anna"),
        (@"  corp\anna  ", "domain", @"corp\anna"),
        (@"anna@corp.example", "domain", @"anna@corp.example"),
        (@"anna@corp", "domain", @"anna@corp"),
        (@"anna", "domain", @"CORP\anna"),
        (@".\anna", "domain", @"!localOnDomain"),
        (@"SRV1\admin", "domain", @"!localOnDomain"),
        (@"anna@other", "domain", @"!invalid"),
        (@"CORP\", "domain", @"!invalid"),
        (@"CORP\an\na", "domain", @"!invalid"),
        (@"a/b", "domain", @"!invalid"),
        (@"   ", "domain", @"!invalid"),
        (@"admin", "local", @"WG1\admin"),
        (@".\admin", "local", @"WG1\admin"),
        (@"wg1\admin", "local", @"WG1\admin"),
        (@"CORP\anna", "local", @"!invalid"),
        (@"admin@wg1.local", "local", @"!invalid"),
    ];

    // 7. The AD sign-in of 4.19.0 (PluginIdentity.cs) and plugin changes as the account.
    private static async Task IdentityAsync()
    {
        foreach (var (input, kind, expected) in AccountVectors)
        {
            var (account, code) = kind == "domain" ? PluginIdentity.ParseAccount(input, "domain", "corp.example", "CORP", "SRV1") : PluginIdentity.ParseAccount(input, "local", "WG1", "WG1", "WG1");
            Check((account?.Account ?? "!" + code) == expected, "The account " + input + " parsed to " + (account?.Account ?? "!" + code) + ", not " + expected + ".");
        }
        Check(PluginIdentity.ParseAccount("anna\u0001", "domain", "corp.example", "CORP", "SRV1").Code == "invalid" && PluginIdentity.ParseAccount(new string('a', 257), "domain", "corp.example", "CORP", "SRV1").Code == "invalid", "A control character or 257 characters were accepted.");
        Check(PluginIdentity.ParseAccount("anna@corp.example", "domain", "corp.example", "CORP", "SRV1").Account is { Upn: true, Domain: null }, "A UPN did not stay a UPN.");

        // The Win32 errors of LogonUserW.
        foreach (var (error, code) in new[] { (1326, "AGENT_AD_SIGN_IN_FAILED"), (1327, "AGENT_AD_ACCOUNT_RESTRICTED"), (1328, "AGENT_AD_ACCOUNT_RESTRICTED"), (1331, "AGENT_AD_ACCOUNT_RESTRICTED"), (1793, "AGENT_AD_ACCOUNT_RESTRICTED"), (1909, "AGENT_AD_ACCOUNT_RESTRICTED"),
            (1330, "AGENT_AD_PASSWORD_EXPIRED"), (1907, "AGENT_AD_PASSWORD_EXPIRED"), (1385, "AGENT_AD_NO_LOGON_RIGHT"), (1311, "AGENT_AD_DOMAIN_UNREACHABLE"), (5, "AGENT_AD_SIGN_IN_ERROR") })
            Check(PluginIdentity.LogonError(error, @"CORP\anna").Code == code, "Win32 error " + error + " did not map to " + code + ".");
        Check(PluginIdentity.LogonError(1909, @"CORP\anna").Args["account"] == @"CORP\anna" && PluginIdentity.LogonError(5, "x").Args["error"] == "5", "A logon error lost its argument.");

        // The SID kind check: the machine account domain on a domain device is local, except on a DC.
        var member = new AdDirectory("domain", "corp.example", "CORP", "S-1-5-21-1-2-3", "S-1-5-21-9-9-9");
        var controller = member with { MachineSid = member.Sid };
        var workgroup = new AdDirectory("local", "WG1", "WG1", "S-1-5-21-9-9-9", "S-1-5-21-9-9-9");
        Check(PluginIdentity.KindError(member, "S-1-5-21-9-9-9-500") == "AGENT_AD_LOCAL_ACCOUNT" && PluginIdentity.KindError(member, "S-1-5-21-1-2-3-1105") is null, "A local account passed on a domain member, or a domain account did not.");
        Check(PluginIdentity.KindError(controller, "S-1-5-21-1-2-3-500") is null, "A domain account on a DC was taken for a local one.");
        Check(PluginIdentity.KindError(workgroup, "S-1-5-21-9-9-9-1001") is null && PluginIdentity.KindError(workgroup, "S-1-5-21-1-2-3-1105") == "AGENT_AD_SIGN_IN_FAILED" && PluginIdentity.KindError(member, "S-1-5-18") == "AGENT_AD_SIGN_IN_FAILED", "The kind check on a workgroup server or of a well-known SID is wrong.");

        // The S4U names: a UPN alone, DOMAIN\name with the DNS realm, a local account with its computer.
        PluginActAs Act(string logon, string kind = "domain", string sid = "S-1-5-21-1-2-3-1105") => new(Guid.NewGuid().ToString(), sid, logon, logon.Contains('@') ? @"CORP\anna" : logon, kind);
        Check(PluginIdentity.S4uNames(Act("anna@corp.example"), member) == ("anna@corp.example", "") && PluginIdentity.S4uNames(Act(@"CORP\anna"), member) == ("anna", "corp.example") && PluginIdentity.S4uNames(Act(@"OTHER\anna"), member) == ("anna", "OTHER"), "The Kerberos S4U names are wrong.");
        Check(PluginIdentity.S4uNames(Act(@"WG1\admin", "local", "S-1-5-21-9-9-9-1001"), workgroup) == ("admin", "WG1"), "The MSV1_0 S4U names are wrong.");

        // actAs: a valid one reads; a broken one fails as a missing account.
        var valid = new JsonObject { ["sessionId"] = Guid.NewGuid().ToString(), ["userSid"] = "S-1-5-21-1-2-3-1105", ["logonName"] = "anna@corp.example", ["account"] = @"CORP\anna", ["kind"] = "domain" };
        Check(PluginActAs.Read(valid)?.Account == @"CORP\anna" && PluginActAs.Read(null) is null, "A valid actAs did not read.");
        foreach (var (name, value) in new (string, JsonNode?)[] { ("sessionId", "x"), ("userSid", "S-1-5-18"), ("logonName", ""), ("account", "a\u0001"), ("kind", "forest") })
        {
            var broken = valid.DeepClone().AsObject(); broken[name] = value;
            Check(CodeOf(() => PluginActAs.Read(broken)) == "AGENT_PLUGIN_ACCOUNT_REQUIRED", "A broken actAs." + name + " was accepted.");
        }
        Check(CodeOf(() => PluginActAs.Read(JsonValue.Create("x"))) == "AGENT_PLUGIN_ACCOUNT_REQUIRED", "An actAs that is no object was accepted.");
        Check(JobRunner.AllowedInReadOnly(PluginIdentity.SignInKind) && PluginIdentity.AccessDenied("PLUGIN_DHCP_ACCESS_DENIED") && PluginIdentity.AccessDenied("PLUGIN_DNS_ACCESS_DENIED") && !PluginIdentity.AccessDenied("PLUGIN_DHCP_CHANGE_FAILED") && !PluginIdentity.AccessDenied("AGENT_PLUGIN_ACCESS_DENIED"), "ad-sign-in is not allowed in ReadOnly mode or the access-denied pattern is wrong.");

        // The plugins\ DACL of 4.19.0: read and execute for Authenticated Users, inherited, still safe.
        var aces = PluginAcl.Aces(PluginAcl.ProtectedSecurity()).ToArray();
        Check(PluginAcl.UserCanRead(aces) && PluginAcl.UnsafeReason(PluginAcl.AdministratorsSid, aces.Select(entry => entry.Ace), true, true) is null, "The protected DACL lacks the read ACE or is unsafe.");
        Check(aces.Any(entry => entry.Ace.Sid == PluginAcl.AuthenticatedUsersSid && entry.Inherits && (entry.Ace.Rights & PluginAcl.ReadAndExecute) == PluginAcl.ReadAndExecute), "The S-1-5-11 ACE is not ReadAndExecute for files and subfolders.");
        Check(!PluginAcl.UserCanRead(aces.Where(entry => entry.Ace.Sid != PluginAcl.AuthenticatedUsersSid)) && !PluginAcl.UserCanRead(aces.Select(entry => (entry.Ace, false))), "A DACL of 4.17 (or a non-inherited ACE) counted as readable.");

        // ad-sign-in: the result data, the message and the password masking.
        const string password = "Pa55-word-4180";
        JsonObject SignInJob(string account, bool sealedBox = true) => new() { ["id"] = Guid.NewGuid().ToString(), ["action"] = "ad-sign-in", ["parameters"] = new JsonObject { ["plugin"] = "dhcp", ["account"] = account, ["secretParameters"] = sealedBox ? new JsonObject { ["sealed"] = true } : null } };
        JsonObject Unseal(JsonObject box) => new() { ["password"] = password };
        string seen = "";
        var logon = new FakeLogon(member, (account, typed) => { seen = typed; return new AdVerified("S-1-5-21-1-2-3-1105", @"CORP\anna", "anna@corp.example"); });
        var signedIn = PluginIdentity.SignIn(SignInJob("anna"), Unseal, logon);
        Check(signedIn["ok"]?.GetValue<bool>() == true && signedIn["code"]?.GetValue<string>() == "AGENT_AD_SIGNED_IN" && seen == password && logon.Last is { Domain: "CORP", User: "anna", Upn: false }, "A sign-in with the right password did not pass.");
        Check(signedIn["data"]?["userSid"]?.GetValue<string>() == "S-1-5-21-1-2-3-1105" && signedIn["data"]?["upn"]?.GetValue<string>() == "anna@corp.example" && signedIn["data"]?["directory"]?["sid"]?.GetValue<string>() == "S-1-5-21-1-2-3" && signedIn["data"]?["directory"]?["kind"]?.GetValue<string>() == "domain" && signedIn["data"]?["directory"]?["netbiosName"]?.GetValue<string>() == "CORP", "The sign-in data are not {userSid, account, upn, directory}.");
        Check(!signedIn.ToJsonString().Contains(password, StringComparison.Ordinal), "The password reached the sign-in result.");
        var wrong = PluginIdentity.SignIn(SignInJob(@"CORP\anna"), Unseal, new FakeLogon(member, (_, _) => throw new System.ComponentModel.Win32Exception(1326)));
        Check(wrong["ok"]?.GetValue<bool>() == false && wrong["code"]?.GetValue<string>() == "AGENT_AD_SIGN_IN_FAILED" && wrong["data"] is null, "A wrong password did not fail with AGENT_AD_SIGN_IN_FAILED.");
        var locked = PluginIdentity.SignIn(SignInJob(@"CORP\anna"), Unseal, new FakeLogon(member, (_, _) => throw new System.ComponentModel.Win32Exception(1909)));
        Check(locked["code"]?.GetValue<string>() == "AGENT_AD_ACCOUNT_RESTRICTED" && locked["args"]?["account"]?.GetValue<string>() == @"CORP\anna", "A locked account did not name the account.");
        var leaking = PluginIdentity.SignIn(SignInJob(@"CORP\anna"), Unseal, new FakeLogon(member, (_, typed) => throw new InvalidOperationException("Logon of " + typed + " failed")));
        Check(leaking["code"]?.GetValue<string>() == "AGENT_AD_SIGN_IN_ERROR" && !leaking.ToJsonString().Contains(password, StringComparison.Ordinal), "An unexpected failure leaked the password or lost its code.");
        var local = PluginIdentity.SignIn(SignInJob(@"CORP\admin"), Unseal, new FakeLogon(member, (_, _) => new AdVerified("S-1-5-21-9-9-9-500", @"SRV1\admin", null)));
        Check(local["code"]?.GetValue<string>() == "AGENT_AD_LOCAL_ACCOUNT", "A local account on a domain member passed the sign-in.");
        Check(PluginIdentity.SignIn(SignInJob(@".\admin"), Unseal, logon)["code"]?.GetValue<string>() == "AGENT_AD_LOCAL_ACCOUNT", @"A .\name on a domain member reached LogonUserW.");
        Check(PluginIdentity.SignIn(SignInJob("anna", sealedBox: false), Unseal, logon)["code"]?.GetValue<string>() == "AGENT_PLUGIN_SECRET_INVALID" && PluginIdentity.SignIn(SignInJob("anna"), null, logon)["code"]?.GetValue<string>() == "AGENT_PLUGIN_SECRET_INVALID", "A sign-in without its sealed password or the device key passed.");
        var workgroupSignIn = PluginIdentity.SignIn(SignInJob(@".\admin"), Unseal, new FakeLogon(workgroup, (account, _) => new AdVerified("S-1-5-21-9-9-9-1001", @"WG1\admin", null)));
        Check(workgroupSignIn["ok"]?.GetValue<bool>() == true && workgroupSignIn["data"]?["directory"]?["kind"]?.GetValue<string>() == "local" && workgroupSignIn["data"]?["upn"] is null, "A local account on a workgroup server did not sign in.");

        // Plugin changes run as the account: the token reaches the start, it is closed after the run and on every failure.
        using var publisher = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        string pem = publisher.ExportSubjectPublicKeyInfoPem();
        byte[] exe = Encoding.UTF8.GetBytes("plugin executable bytes 1.1.0");
        string root = Path.Combine(Path.GetTempPath(), "ServerDesk-PluginIdentityTest-" + Guid.NewGuid().ToString("N"));
        try
        {
            Place(root, "dhcp", Sign(publisher, "dhcp", "1.1.0", exe, capabilities: ["dhcp-read", "dhcp-scope-create"]), exe);
            string code = "PLUGIN_DHCP_CHANGED";
            Script Change() => async (input, output, killed) =>
            {
                await input.ReadLineAsync(PluginProtocol.MaximumBrokerLine, killed);
                await WriteAsync(output, PluginProtocol.PluginHello("dhcp", "1.1.0", ["dhcp-read", "dhcp-scope-create"]));
                var request = PluginProtocol.Parse((await input.ReadLineAsync(PluginProtocol.MaximumBrokerLine, killed))!, "request");
                await WriteAsync(output, PluginProtocol.Result(PluginProtocol.Text(request, "id"), code == "PLUGIN_DHCP_CHANGED", code, new Dictionary<string, string>(), "Plugin text.", null));
                return 0;
            };
            Script current = Change(); var factory = new FakeFactory(() => current); var tokens = new FakeTokens();
            var host = new PluginHost(root, _ => { }, factory, new FakeFirewall(), pem, (_, _) => null, () => DateTimeOffset.UtcNow, "4.19.0", tokens);
            JsonObject ChangeJob(JsonNode? actAs, string operation = "dhcp-scope-create") => new() { ["id"] = Guid.NewGuid().ToString(), ["action"] = "plugin-job", ["parameters"] = new JsonObject { ["plugin"] = "dhcp", ["operation"] = operation, ["parameters"] = new JsonObject(), ["actAs"] = actAs } };
            Task<JsonObject> Run(JsonObject job) => host.RunJobAsync(job, (_, _) => Task.CompletedTask, CancellationToken.None);

            Check(await CodeOfAsync(() => Run(ChangeJob(null))) == "AGENT_PLUGIN_ACCOUNT_REQUIRED" && factory.Started == 0 && tokens.Issued == 0, "A change without actAs started the plugin.");
            Check(await CodeOfAsync(() => host.RunAsync("dhcp", "dhcp-scope-create", new JsonObject(), Guid.NewGuid().ToString(), CancellationToken.None)) == "AGENT_PLUGIN_ACCOUNT_REQUIRED" && factory.Started == 0, "A change without an account ran as SYSTEM.");
            var changed = await Run(ChangeJob(valid.DeepClone()));
            Check(changed["ok"]?.GetValue<bool>() == true && factory.Started == 1 && factory.LastAccountSid == "S-1-5-21-1-2-3-1105" && factory.LastAccountOpen && tokens.Issued == 1 && tokens.Closed == 1, "A change did not run with the open account token, or the token stayed open.");
            Check(tokens.Last?.LogonName == "anna@corp.example", "The token factory did not get the actAs logon name.");
            // A read ignores actAs and runs as SYSTEM.
            current = Plugin(version: "1.1.0", capabilities: ["dhcp-read", "dhcp-scope-create"]);
            var read = await Run(ChangeJob(valid.DeepClone(), "dhcp-read"));
            Check(read["ok"]?.GetValue<bool>() == true && factory.Started == 2 && factory.LastAccountSid is null && tokens.Issued == 1, "A read ran with the account.");
            // Another user SID in the token: refused before the start, the token closed.
            current = Change(); tokens.Sid = "S-1-5-21-1-2-3-9999";
            Check(await CodeOfAsync(() => Run(ChangeJob(valid.DeepClone()))) == "AGENT_PLUGIN_ACCOUNT_MISMATCH" && factory.Started == 2 && tokens.Closed == tokens.Issued, "A token of another user started the plugin or stayed open.");
            tokens.Sid = null;
            // S4U fails (disabled account, no DC): the job fails before the start.
            tokens.Fail = new AgentMessageException("AGENT_PLUGIN_ACCOUNT_UNAVAILABLE", ("account", @"CORP\anna"));
            Check(await CodeOfAsync(() => Run(ChangeJob(valid.DeepClone()))) == "AGENT_PLUGIN_ACCOUNT_UNAVAILABLE" && factory.Started == 2, "A failed S4U logon started the plugin.");
            tokens.Fail = null;
            // The start fails: the token is closed, and the job fails with AGENT_PLUGIN_FAILED around the Windows error (4.21.2).
            factory.OnStart = _ => throw new System.ComponentModel.Win32Exception(5);
            bool failedStart = false;
            try { await Run(ChangeJob(valid.DeepClone())); } catch (AgentMessageException e) when (e.Code == "AGENT_PLUGIN_FAILED" && e.InnerException is System.ComponentModel.Win32Exception) { failedStart = true; }
            Check(failedStart && tokens.Closed == tokens.Issued, "A failed start passed or left the token open.");
            factory.OnStart = null;
            // The plugin crashes: the token is closed.
            current = async (input, output, killed) => { await input.ReadLineAsync(PluginProtocol.MaximumBrokerLine, killed); return 7; };
            Check(await CodeOfAsync(() => Run(ChangeJob(valid.DeepClone()))) == "AGENT_PLUGIN_CRASHED" && tokens.Closed == tokens.Issued, "A crash left the token open.");
            // The server refuses the account: the plugin's access-denied code names the account.
            current = Change(); code = "PLUGIN_DHCP_ACCESS_DENIED";
            var denied = await Run(ChangeJob(valid.DeepClone()));
            Check(denied["ok"]?.GetValue<bool>() == false && denied["code"]?.GetValue<string>() == "AGENT_PLUGIN_ACCOUNT_DENIED" && denied["args"]?["account"]?.GetValue<string>() == @"CORP\anna" && tokens.Closed == tokens.Issued, "An access-denied change did not name the account.");
            // The DNS plugin's access-denied code is rewritten the same way (4.20.0).
            current = Change(); code = "PLUGIN_DNS_ACCESS_DENIED";
            var dnsDenied = await Run(ChangeJob(valid.DeepClone()));
            Check(dnsDenied["code"]?.GetValue<string>() == "AGENT_PLUGIN_ACCOUNT_DENIED" && dnsDenied["args"]?["account"]?.GetValue<string>() == @"CORP\anna" && tokens.Closed == tokens.Issued, "A DNS access-denied change did not name the account.");
            current = Plugin(version: "1.1.0", capabilities: ["dhcp-read", "dhcp-scope-create"], result: value => { value["ok"] = false; value["code"] = "PLUGIN_DHCP_ACCESS_DENIED"; value.Remove("data"); return value; });
            Check((await Run(ChangeJob(null, "dhcp-read")))["code"]?.GetValue<string>() == "PLUGIN_DHCP_ACCESS_DENIED", "A read without an account rewrote the plugin's access-denied code.");
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }

    // The real process start on Windows with cmd.exe as a stand-in plugin: it ignores the fixed argument
    // --plugin-host and runs the commands of its stdin. This covers the pipes, the suspended start in the job
    // object, the one-process limit (a child EXE cannot start), the minimal environment and the exit code.
    internal static async Task RealProcessAsync()
    {
        if (!OperatingSystem.IsWindows()) return;
        string cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe"), hostname = Path.Combine(Environment.SystemDirectory, "HOSTNAME.EXE");
        if (!File.Exists(cmd)) return;
        using var process = new WindowsPluginProcessFactory().Start(cmd, Environment.SystemDirectory);
        const char CR = '\r', NUL = '\0';
        string script = "\"" + hostname + "\"\r\nif errorlevel 1 (echo CHILD-REFUSED) else (echo CHILD-STARTED)\r\necho PLUGIN-%TEMP%\r\nexit 0\r\n";
        await process.Input.WriteAsync(Encoding.ASCII.GetBytes(script)); await process.Input.FlushAsync(); process.Input.Dispose();
        var reader = new PluginLineReader(process.Output); var lines = new List<string>();
        for (int i = 0; i < 40; i++) { var line = await reader.ReadLineAsync(4096, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(20)); if (line is null) break; lines.Add(Encoding.Default.GetString(line).TrimEnd(CR)); }
        int code = await process.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(20));
        string temp = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Temp");
        Check(code == 0 && lines.Contains("PLUGIN-" + temp), "The plugin process start through the job object failed (exit code " + code + ").");
        Check(lines.Contains("CHILD-REFUSED") && !lines.Contains("CHILD-STARTED"), "The plugin job object let the plugin start another process.");
        Check(WindowsPluginProcessFactory.EnvironmentBlock().Split(NUL).Count(entry => entry.Length > 0) <= 10 && !WindowsPluginProcessFactory.EnvironmentBlock().Contains("SERVERDESK", StringComparison.OrdinalIgnoreCase), "The plugin environment is not minimal.");
    }

    private static bool Rejected(Action action) { try { action(); return false; } catch (Exception e) when (e is InvalidDataException or CryptographicException) { return true; } }
}
