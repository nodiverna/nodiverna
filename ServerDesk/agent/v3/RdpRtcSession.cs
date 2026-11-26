using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Diagnostics;
using SIPSorcery.Net;

namespace ServerDesk.Agent;

// Screen and input bytes travel only through DTLS/SCTP, never through Snapshot.
// The portal's absolute authorization lease continues to govern the direct peer.
internal sealed class RdpRtcSession : IRdpAgentSession
{
    internal const int MaximumQueuedBytes = 1_048_576, MaximumBufferedBytes = 524_288;
    private readonly string root;
    private readonly JsonObject config;
    private readonly byte[] key;
    private readonly string sealedOffer;
    private readonly FileStream activity;
    private readonly DateTimeOffset expiry;
    private readonly RdpRtcSetupBudget setup;
    private readonly Action notify;
    private readonly object gate = new();
    private readonly RdpRtcInputBuffer inputs = new();
    private readonly SemaphoreSlim sendGate = new(1, 1);
    private readonly CancellationTokenSource stopping = new();
    private readonly Task initializeTask, inputTask, lifetimeTask;
    private Task? outputTask, cleanup;
    private RTCPeerConnection? peer;
    private RTCDataChannel? channel;
    private NativeRdpProxy? proxy;
    private NativeRdpRtcFirewall? socketFirewall;
    private string firewallDiagnostic = "not-prepared";
    private long leaseDeadline;
    private int alive = 1, openedChannels;
    private string state = "opening", error = "", sealedAnswer = "", phase = "authorization";
    public string Id { get; }
    public bool Alive => Volatile.Read(ref alive) != 0;
    public bool Expired => Stopwatch.GetTimestamp() >= Volatile.Read(ref leaseDeadline);
    public bool IsDirect => true;
    public bool HasPendingOutput => false;

    internal RdpRtcSession(string id, string root, JsonObject config, byte[] key, DateTimeOffset expiry, string offer, long authorizationDeadline, Action notify)
    {
        setup = new RdpRtcSetupBudget(Stopwatch.GetTimestamp());
        Id = id; this.root = root; this.config = config; this.expiry = expiry; this.notify = notify;
        leaseDeadline = authorizationDeadline;
        if (authorizationDeadline <= Stopwatch.GetTimestamp()) throw new InvalidDataException("Direct Remote Desktop authorization expired in transit.");
        if (key.Length != 32) throw new InvalidDataException("Invalid direct Remote Desktop authorization.");
        this.key = key.ToArray(); sealedOffer = offer;
        try { activity = AgentUpdateLease.AcquireActivity(root); } catch { CryptographicOperations.ZeroMemory(this.key); throw; }
        try
        {
            inputTask = Task.Run(InputLoopAsync); lifetimeTask = Task.Run(LifetimeLoopAsync); initializeTask = Task.Run(InitializeAsync);
        }
        catch { activity.Dispose(); CryptographicOperations.ZeroMemory(this.key); throw; }
    }
    public JsonObject Snapshot()
    {
        lock (gate)
        {
            var report = new JsonObject { ["id"] = Id, ["transport"] = "webrtc", ["state"] = state, ["inputAck"] = 0, ["output"] = new JsonArray() };
            if (sealedAnswer.Length != 0) report["answer"] = sealedAnswer;
            if (error.Length != 0) report["error"] = error;
            return report;
        }
    }
    public void Accept(JsonObject command)
    {
        if (!Alive || Expired) throw new InvalidOperationException("Direct Remote Desktop authorization expired. Start a new session.");
        if (command["transport"]?.GetValue<string>() != "webrtc" || command["input"] is not JsonArray input || input.Count != 0 || RdpSession.ReadSequence(command, "outputAck", true) != 0 || RdpSession.ReadSequence(command, "outputStored", true) != 0) throw new InvalidDataException("Invalid direct Remote Desktop control command.");
        if (command["offer"] is JsonValue offered && offered.GetValue<string>() != sealedOffer) throw new InvalidDataException("Direct Remote Desktop description changed.");
        long deadline = command["_rtcLeaseDeadline"]?.GetValue<long>() ?? throw new InvalidDataException("Missing direct Remote Desktop authorization deadline.");
        if (deadline <= Stopwatch.GetTimestamp()) throw new InvalidDataException("Direct Remote Desktop authorization expired in transit.");
        // An absolute deadline cannot become a fresh fifteen seconds merely
        // because a delayed HTTP response has finally arrived.
        Volatile.Write(ref leaseDeadline, deadline);
        AssertAllowed();
    }
    private void AssertLive()
    {
        if (!Alive || Expired) throw new InvalidOperationException("Direct Remote Desktop authorization expired. Start a new session.");
    }
    private void AssertAllowed()
    {
        AssertLive();
        NativeManagement.AssertManagement(root, config);
        if (AgentInstaller.InMaintenance(root) || AgentUpdater.Pending(root)) throw new InvalidOperationException("Remote Desktop cannot run during an agent update.");
        JsonObject availability = NativeRdpAvailability.Read();
        if (availability["enabled"]?.GetValue<bool>() != true || availability["nla"]?.GetValue<bool>() != true || availability["policyBlocked"]?.GetValue<bool>() == true) throw new InvalidOperationException("Enable Windows Remote Desktop with NLA/TLS before connecting. A blocking domain policy cannot be overridden.");
    }
    private async Task InitializeAsync()
    {
        try
        {
            AssertAllowed(); Volatile.Write(ref phase, "offer"); string offer = RdpRtcSignal.Open(Id, key, sealedOffer, offer: true); RdpRtcSignal.ValidateOffer(offer);
            Volatile.Write(ref phase, "gathering");
            var candidate = new RTCPeerConnection(new RTCConfiguration
            {
                iceServers = [new RTCIceServer { urls = "stun:stun.cloudflare.com:3478" }],
                X_GatherTimeoutMs = 8000,
                X_ICEIncludeAllInterfaceAddresses = true,
            });
            lock (gate)
            {
                if (stopping.IsCancellationRequested) { candidate.Close("cancelled"); throw new OperationCanceledException(stopping.Token); }
                peer = candidate;
            }
            // SIPSorcery's high-level channel currently normalizes the DCEP
            // reliability fields. Validate the original wire declaration first.
            candidate.sctp.RTCSctpAssociation.OnNewDataChannel += (_, type, _, reliability, label, protocol) =>
            {
                try
                {
                    RdpRtcSignal.ValidateDeclaration(type, reliability, label, protocol);
                    if (Interlocked.Increment(ref openedChannels) != 1) throw new InvalidDataException("A second direct Remote Desktop channel was refused.");
                }
                catch (Exception e) { Fail(e); }
            };
            candidate.ondatachannel += AcceptChannel;
            candidate.onconnectionstatechange += value =>
            {
                if (value is RTCPeerConnectionState.failed or RTCPeerConnectionState.closed or RTCPeerConnectionState.disconnected)
                {
                    if (stopping.IsCancellationRequested) return;
                    try
                    {
                        AssertAllowed();
                        if (setup.ShouldDeferPeerFailure(value, candidate.iceConnectionState, candidate.IsDtlsNegotiationComplete, Alive, Volatile.Read(ref leaseDeadline), Stopwatch.GetTimestamp())) return;
                        Fail(new IOException("Direct Remote Desktop peer negotiation was interrupted."));
                    }
                    catch (Exception e) { Fail(e); }
                }
            };
            Volatile.Write(ref phase, "firewall");
            NativeRdpRtcFirewall prepared = NativeRdpRtcFirewall.Acquire(root, Id, candidate.GetRtpChannel().RTPPort, stopping.Token, AssertAllowed,
                message => LocalStore.Log(root, AgentHttpTransport.RedactDiagnostic(message, config)));
            try
            {
                lock (gate)
                {
                    if (!Alive) throw new OperationCanceledException(stopping.Token);
                    stopping.Token.ThrowIfCancellationRequested(); socketFirewall = prepared;
                    Volatile.Write(ref firewallDiagnostic, prepared.Diagnostic);
                }
            }
            catch { prepared.Dispose(); throw; }
            Volatile.Write(ref phase, "gathering");
            if (candidate.setRemoteDescription(new RTCSessionDescriptionInit { type = RTCSdpType.offer, sdp = offer }) != SetDescriptionResultEnum.OK) throw new InvalidDataException("Direct Remote Desktop offer validation failed.");
            var answer = await RdpRtcSignal.CreateAnswerAfterGatheringAsync(candidate, TimeSpan.FromSeconds(8), stopping.Token);
            AssertAllowed(); await candidate.setLocalDescription(answer);
            string sealedDescription = RdpRtcSignal.Seal(Id, key, answer.sdp, offer: false);
            lock (gate) { if (stopping.IsCancellationRequested) throw new OperationCanceledException(stopping.Token); sealedAnswer = sealedDescription; }
            Volatile.Write(ref phase, "ice-dtls"); notify();
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception e) { Fail(e); }
    }
    private void AcceptChannel(RTCDataChannel value)
    {
        try
        {
            AssertAllowed();
            lock (gate)
            {
                if (channel is not null) throw new InvalidDataException("A second direct Remote Desktop data channel was refused.");
                RdpRtcSignal.ValidateChannel(value.label, value.ordered, value.maxPacketLifeTime, value.maxRetransmits, value.negotiated);
                if (value.IsOpened && value.readyState == RTCDataChannelState.open && !setup.TryMarkChannelOpened(Stopwatch.GetTimestamp())) throw new InvalidOperationException(RdpRtcSetupBudget.TimeoutMessage);
                channel = value; Volatile.Write(ref phase, "sctp");
            }
            value.onopen += () =>
            {
                try { AssertAllowed(); if (!setup.TryMarkChannelOpened(Stopwatch.GetTimestamp())) throw new InvalidOperationException(RdpRtcSetupBudget.TimeoutMessage); }
                catch (Exception e) { Fail(e); }
            };
            value.onmessage += (_, protocol, bytes) => Receive(protocol, bytes);
            value.onclose += () => { if (!stopping.IsCancellationRequested) Fail(new IOException("Direct Remote Desktop data channel closed.")); };
            value.onerror += _ => { if (!stopping.IsCancellationRequested) Fail(new IOException("Direct Remote Desktop data channel failed.")); };
        }
        catch (Exception e) { Fail(e); }
    }
    private void Receive(DataChannelPayloadProtocols protocol, byte[] bytes)
    {
        try
        {
            if (!Alive || Expired || protocol != DataChannelPayloadProtocols.WebRTC_Binary || bytes.Length is < 1 or > RdpFrameCipher.MaximumPlainBytes) throw new InvalidDataException("Invalid direct Remote Desktop binary message.");
            if (!inputs.Add(bytes)) throw new InvalidDataException("Direct Remote Desktop input buffer limit reached. Start a new session.");
        }
        catch (Exception e) { Fail(e); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }
    private async Task InputLoopAsync()
    {
        try
        {
            while (!stopping.IsCancellationRequested)
            {
                byte[] bytes = await inputs.ReadAsync(stopping.Token);
                try
                {
                    AssertLive();
                    if (proxy is null)
                    {
                        Volatile.Write(ref phase, "rdp"); AssertAllowed(); int port = NativeRdpAvailability.Read()["port"]!.GetValue<int>(); string pin = NativeRdpAvailability.CertificatePin(); AssertAllowed();
                        NativeRdpProxy connected = await NativeRdpProxy.ConnectAsync(bytes, Id, port, pin, stopping.Token);
                        try { AssertAllowed(); lock (gate) { if (stopping.IsCancellationRequested) throw new OperationCanceledException(stopping.Token); proxy = connected; } }
                        catch { connected.Dispose(); throw; }
                        for (int offset = 0; offset < connected.Response.Length; offset += RdpFrameCipher.MaximumPlainBytes)
                            await SendAsync(connected.Response, offset, Math.Min(RdpFrameCipher.MaximumPlainBytes, connected.Response.Length - offset));
                        lock (gate) state = "open";
                        Volatile.Write(ref phase, "stream");
                        outputTask = OutputLoopAsync(connected); notify();
                    }
                    else await proxy.WriteAsync(bytes, stopping.Token);
                }
                finally { CryptographicOperations.ZeroMemory(bytes); }
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception e) { Fail(e); }
    }
    private async Task SendAsync(byte[] bytes, int offset, int length)
    {
        await sendGate.WaitAsync(stopping.Token);
        try
        {
            while (true)
            {
                AssertLive(); RTCDataChannel active = channel ?? throw new IOException("Direct Remote Desktop data channel is unavailable.");
                if (!active.IsOpened || active.readyState != RTCDataChannelState.open) throw new IOException("Direct Remote Desktop data channel is closed.");
                // Backpressure reaches the local TLS reader. No screen bytes are
                // dropped or allowed to accumulate in an unbounded send queue.
                if (active.bufferedAmount + (ulong)length <= MaximumBufferedBytes) { active.send(bytes, offset, length); return; }
                await Task.Delay(5, stopping.Token);
            }
        }
        finally { sendGate.Release(); }
    }
    private async Task OutputLoopAsync(NativeRdpProxy connected)
    {
        await using var coalescer = new RdpOutputCoalescer(connected.ReadAsync, stopping.Token);
        try
        {
            while (!stopping.IsCancellationRequested)
            {
                AssertLive(); byte[]? bytes = await coalescer.ReadFrameAsync();
                if (bytes is null) { Close(); return; }
                try { await SendAsync(bytes, 0, bytes.Length); } finally { CryptographicOperations.ZeroMemory(bytes); }
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception e) { Fail(e); }
    }
    private async Task LifetimeLoopAsync()
    {
        try
        {
            while (!stopping.IsCancellationRequested)
            {
                await Task.Delay(100, stopping.Token); AssertAllowed();
                if (setup.IsExpired(Stopwatch.GetTimestamp())) throw new InvalidOperationException(RdpRtcSetupBudget.TimeoutMessage);
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception e) { Fail(e); }
    }
    private void Fail(Exception e)
    {
        string message = e switch
        {
            CryptographicException => "Direct Remote Desktop description authentication failed. Start a new session.",
            System.Security.Authentication.AuthenticationException => "The local Windows RDP certificate did not match its listener or TLS negotiation failed.",
            OperationCanceledException => "Direct Remote Desktop connection setup was cancelled.",
            InvalidDataException or InvalidOperationException => e.Message,
            _ => "Direct Remote Desktop negotiation failed. Check the reported connection phase.",
        };
        RTCPeerConnection? active = peer;
        var local = active?.GetRtpChannel().Candidates;
        // Diagnose stages without exposing addresses, ICE credentials, SDP,
        // certificate fingerprints or implementation exception messages.
        string diagnostic = $"phase={Volatile.Read(ref phase)}; ice={active?.iceConnectionState.ToString() ?? "none"}; peer={active?.connectionState.ToString() ?? "none"}; dtls={active?.IsDtlsNegotiationComplete == true}; sctp={active?.sctp.state.ToString() ?? "none"}; host={local?.Count(c => c.type == RTCIceCandidateType.host) ?? 0}; srflx={local?.Count(c => c.type == RTCIceCandidateType.srflx) ?? 0}; firewall={Volatile.Read(ref firewallDiagnostic)}; exception={e.GetType().Name}";
        string safe = message[..Math.Min(260, message.Length)] + " (" + diagnostic + ")";
        lock (gate) { if (!Alive || state == "error") return; state = "error"; error = safe[..Math.Min(500, safe.Length)]; }
        Close(preserveError: true);
    }
    private void Close(bool preserveError = false)
    {
        NativeRdpRtcFirewall? releaseFirewall;
        lock (gate)
        {
            if (!preserveError && state != "error") state = "closed";
            if (Interlocked.Exchange(ref alive, 0) == 0) return;
            releaseFirewall = socketFirewall; socketFirewall = null;
        }
        stopping.Cancel();
        try { proxy?.Dispose(); }
        finally
        {
            try { peer?.Close("ServerDesk session ended"); }
            finally { releaseFirewall?.Dispose(); }
        }
        notify();
    }
    public ValueTask DisposeAsync()
    {
        Task task; lock (gate) task = cleanup ??= CleanupAsync(); return new ValueTask(task);
    }
    private async Task CleanupAsync()
    {
        await Task.Yield(); Close();
        try { await initializeTask; await inputTask; await lifetimeTask; if (outputTask is not null) await outputTask; }
        finally
        {
            // Close normally takes the lease when its UDP socket is closed.
            // Retain a fallback after all session tasks have finished.
            socketFirewall?.Dispose();
            inputs.Dispose();
            CryptographicOperations.ZeroMemory(key); activity.Dispose(); sendGate.Dispose(); stopping.Dispose();
        }
    }
}
