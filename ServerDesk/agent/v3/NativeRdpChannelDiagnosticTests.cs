using System.Reflection;
using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace ServerDesk.Agent;

// Exercise the channel's actual asynchronous report/accept lifecycle. All
// sessions and HTTP responses are local fakes; no Windows listener is opened.
internal static class NativeRdpChannelDiagnosticTests
{
    private const string Id = "062a210c-80ad-4f56-870b-b8c155ba21e8";
    private const string FirstError = "Native initial ICE failure (phase=ice-dtls; ice=failed; peer=failed).";

    internal static async Task RunAsync()
    {
        Outbox();
        foreach (bool terminalCommand in new[] { false, true })
            foreach (bool finishErrorOnDispose in new[] { false, true })
                await FailedDuringPostAsync(terminalCommand, finishErrorOnDispose);
        await FullOutboxAsync();
        await AdmissionBackpressureAsync(fullOutbox: true);
        await AdmissionBackpressureAsync(fullOutbox: false);
        await SixAuthoritativeCommandsAsync();
        await PausedIdleAsync();
        await PausedClosesAndReportsAsync();
        await PausedRejectsCommandsAsync();
        await UncachedAdmissionAsync();
        Console.WriteLine("Native RDP diagnostic tests passed: held-HTTP failure races, minimal diagnostic retention and backpressure, authenticated pause cleanup, contradictory command denial, bounded minute idle polling and later resume.");
    }

    private static void Outbox()
    {
        var outbox = new NativeRdpDiagnosticOutbox(2);
        JsonObject original = Report(Id, FirstError);
        original["answer"] = "private SDP answer"; original["offer"] = "private SDP offer";
        original["keyEnvelope"] = "private session key";
        Require(outbox.TryCapture(Id, original), "A valid terminal RTC error was not retained.");
        var first = outbox.Snapshot();
        Require(first.Count == 1 && first[0].Id == Id && first[0].Error == FirstError, "Diagnostic outbox lost the first native cause.");
        original["error"] = "source snapshot was mutated";
        Require(first[0].Error == FirstError && outbox.Snapshot()[0].Error == FirstError, "Diagnostic entries retained mutable source JSON.");
        string[] fields = first[0].GetType().GetProperties(BindingFlags.Instance | BindingFlags.Public).Select(property => property.Name).Order().ToArray();
        Require(fields.SequenceEqual(new[] { "Error", "Id" }), "Diagnostic entries retained key, SDP or screen payload fields.");
        Require(outbox.TryCapture(Id, Report(Id, "later generic close")) && ReferenceEquals(outbox.Snapshot()[0], first[0]), "A later error replaced the first pending native diagnostic.");

        outbox.Acknowledge(first);
        Require(outbox.Snapshot().Count == 0 && first.Count == 1, "Acknowledgement mutated an existing immutable snapshot.");
        Require(outbox.TryCapture(Id, Report(Id, FirstError)), "An acknowledged ID could not produce a fresh diagnostic entry.");
        var replacement = outbox.Snapshot();
        Require(!ReferenceEquals(replacement[0], first[0]), "A new capture reused an acknowledged diagnostic identity.");
        outbox.Acknowledge(first);
        Require(ReferenceEquals(outbox.Snapshot().Single(), replacement[0]), "An old HTTP acknowledgement deleted a new equal-valued entry.");

        string second = Guid.NewGuid().ToString(), overflow = Guid.NewGuid().ToString();
        Require(outbox.TryCapture(second, Report(second, "second native error")), "Outbox capacity stopped before its bound.");
        var full = outbox.Snapshot();
        Require(!outbox.TryCapture(overflow, Report(overflow, "overflow native error")), "Outbox overflow silently discarded a native error.");
        Require(outbox.Snapshot().Count == 2 && ReferenceEquals(outbox.Snapshot()[0], full[0]) && ReferenceEquals(outbox.Snapshot()[1], full[1]), "Overflow evicted or mutated pending diagnostics.");
        Require(outbox.TryCapture(Id, Report(Id, "repeat while full")), "An existing first diagnostic incorrectly caused capacity backpressure.");

        foreach (JsonObject irrelevant in new[]
        {
            Report(overflow, "legacy error", transport: null),
            Report(overflow, "closed error", state: "closed"),
            Report(overflow, "active error", state: "open"),
            Report(overflow, "nonzero mailbox acknowledgement", inputAck: 1),
            Report(overflow, "mailbox payload", output: new JsonArray(new JsonObject { ["seq"] = 1, ["data"] = "screen bytes" })),
            Report(overflow, ""),
            Report(overflow, "   "),
            Report(overflow, new string('x', 501)),
            Report(overflow, "unsafe\ncontrol"),
            Report(overflow, "unsafe\0control"),
        })
            Require(outbox.TryCapture(overflow, irrelevant) && outbox.Snapshot().Count == 2, "An irrelevant snapshot consumed diagnostic credit or blocked cleanup.");
        outbox.Acknowledge(replacement);
        Require(outbox.TryCapture(overflow, Report(overflow, new string('x', 500))), "A valid 500-character diagnostic was rejected.");
        Require(outbox.Snapshot().Count == 2 && full.Count == 2, "Acknowledgement or later capture changed a prior snapshot.");
        outbox.Acknowledge(outbox.Snapshot());
        Require(outbox.Snapshot().Count == 0, "Exact successful-report identities were not acknowledged.");
    }

    private static async Task FailedDuringPostAsync(bool terminalCommand, bool finishErrorOnDispose)
    {
        await using var fixture = new ChannelFixture();
        var session = new FakeSession(Id); fixture.Seed(session); fixture.Start();
        PendingPost first = await fixture.NextAsync();
        JsonObject opening = SingleReport(first.Body);
        Require(opening["id"]?.GetValue<string>() == Id && opening["state"]?.GetValue<string>() == "opening" && opening["error"] is null, "The race fixture did not send an opening snapshot before the native failure.");
        session.Fail(FirstError, finishErrorOnDispose);
        fixture.Reply(first, terminalCommand ? new JsonArray(new JsonObject { ["id"] = Id, ["state"] = "closed", ["transport"] = "webrtc" }) : new JsonArray());

        PendingPost second = await fixture.NextAsync();
        AssertDiagnostic(SingleReport(second.Body), Id, FirstError);
        Require(session.Disposals >= 2 && !fixture.Sessions.ContainsKey(Id), "Terminal control cleanup retained a successfully captured dead session.");
        Require(first.Body["sessions"]?[0]?["state"]?.GetValue<string>() == "opening", "Late native failure mutated the opening HTTP request already in flight.");
        session.Fail("late replacement error", finishErrorOnDispose: false);
        second.Response.TrySetException(new HttpRequestException("simulated portal outage"));

        PendingPost third = await fixture.NextAsync();
        AssertDiagnostic(SingleReport(third.Body), Id, FirstError);
        fixture.Reply(third, new JsonArray());

        PendingPost fourth = await fixture.NextAsync();
        Require(fourth.Body["sessions"] is JsonArray reports && reports.Count == 0, "Successful HTTP acknowledgement did not remove exactly the sent native diagnostic.");
        Require(fixture.Logs.Any(message => message.Contains("simulated portal outage", StringComparison.Ordinal)), "The mock HTTP failure did not exercise actual channel retry handling.");
    }

    private static async Task FullOutboxAsync()
    {
        await using var fixture = new ChannelFixture();
        var session = new FakeSession(Id); fixture.Seed(session); fixture.Start();
        PendingPost opening = await fixture.NextAsync();
        Require(SingleReport(opening.Body)["state"]?.GetValue<string>() == "opening", "Pressure fixture did not hold an earlier opening report.");
        session.Fail(FirstError, finishErrorOnDispose: true);
        NativeRdpDiagnosticOutbox outbox = fixture.Outbox;
        var pending = new List<string>();
        for (int index = 0; index < 4; index++)
        {
            string id = Guid.NewGuid().ToString(); pending.Add(id);
            Require(outbox.TryCapture(id, Report(id, "pending native failure " + index)), "The channel's bounded diagnostic outbox filled early.");
        }
        // These entries appeared after the opening request was frozen. Its
        // successful response cannot acknowledge entries it never transmitted.
        fixture.Reply(opening, new JsonArray());
        PendingPost first = await fixture.NextAsync();
        Require(fixture.Sessions.ContainsKey(Id), "Full outbox discarded the disposed session containing an uncaptured native failure.");
        Require(outbox.Snapshot().Count == 4 && pending.All(id => outbox.Snapshot().Any(entry => entry.Id == id)), "Pressure evicted an older pending native failure.");
        Require(first.Body["sessions"] is JsonArray reports && reports.Count == 4 && reports.All(report => pending.Contains(report?["id"]?.GetValue<string>() ?? "")), "Full outbox reports were displaced by an uncaptured session.");
        Require(fixture.Logs.Any(message => message.Contains("diagnostic", StringComparison.OrdinalIgnoreCase) || message.Contains("outbox", StringComparison.OrdinalIgnoreCase)), "Diagnostic capacity pressure was not made visible in the agent log.");
        fixture.Reply(first, new JsonArray());
        PendingPost second = await fixture.NextAsync();
        AssertDiagnostic(SingleReport(second.Body), Id, FirstError);
        Require(!fixture.Sessions.ContainsKey(Id), "Freed diagnostic credit did not release the retained disposed session.");
        fixture.Reply(second, new JsonArray());
        PendingPost third = await fixture.NextAsync();
        Require(third.Body["sessions"] is JsonArray empty && empty.Count == 0, "Acknowledged pressure-recovery diagnostic kept occupying report capacity.");
    }

    private static async Task AdmissionBackpressureAsync(bool fullOutbox)
    {
        await using var fixture = new ChannelFixture(management: true);
        var retained = new List<FakeSession>();
        if (!fullOutbox)
        {
            // Disposed terminal records still own their admission slots. A
            // count of Alive sessions would incorrectly permit a third claim.
            for (int index = 0; index < 2; index++)
            {
                var session = new FakeSession(Guid.NewGuid().ToString()); session.Fail("retained native failure " + index, finishErrorOnDispose: false);
                retained.Add(session); fixture.Seed(session);
            }
        }
        fixture.Start(); PendingPost first = await fixture.NextAsync();
        if (fullOutbox)
            for (int index = 0; index < 4; index++)
            {
                string pending = Guid.NewGuid().ToString();
                Require(fixture.Outbox.TryCapture(pending, Report(pending, "unacknowledged native failure " + index)), "Admission fixture failed to fill unsent diagnostic capacity.");
            }
        string requested = Guid.NewGuid().ToString();
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var offered = new JsonArray(retained.Select(session => (JsonNode)Command(session.Id, now)).Append(Command(requested, now)).ToArray());
        fixture.Reply(first, offered);
        _ = await fixture.NextAsync();
        Require(!fixture.Claimed(requested), "Diagnostic or retained-record pressure reached durable claim/key admission.");
        Require(fixture.Logs.Any(message => message.Contains("diagnostic", StringComparison.OrdinalIgnoreCase) || message.Contains("records", StringComparison.OrdinalIgnoreCase)), "Admission backpressure was not visible in the agent log.");
        if (fullOutbox) Require(fixture.Outbox.Snapshot().Count == 4, "Admission displaced an unacknowledged native diagnostic.");
        else Require(retained.All(session => fixture.Sessions.ContainsKey(session.Id)), "Admission evicted retained terminal records to create a third slot.");
    }

    private static async Task SixAuthoritativeCommandsAsync()
    {
        await using var fixture = new ChannelFixture(management: true);
        var active = new[] { new FakeSession(Guid.NewGuid().ToString()), new FakeSession(Guid.NewGuid().ToString()) };
        foreach (FakeSession session in active) fixture.Seed(session);
        var retired = new List<string>();
        for (int index = 0; index < 4; index++)
        {
            string id = Guid.NewGuid().ToString(); retired.Add(id);
            Require(fixture.Outbox.TryCapture(id, Report(id, "retired native failure " + index)), "Six-command fixture lost pending report credit.");
        }
        fixture.Start(); PendingPost first = await fixture.NextAsync();
        Require(first.Body["sessions"] is JsonArray firstReports && firstReports.Count == 4 && firstReports.All(report => retired.Contains(report?["id"]?.GetValue<string>() ?? "")), "Six-command fixture did not send exactly four retired diagnostics.");
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var offered = new JsonArray(active.Select(session => (JsonNode)Command(session.Id, now))
            .Concat(retired.Select(id => (JsonNode)new JsonObject { ["id"] = id, ["state"] = "closed", ["transport"] = "webrtc" })).ToArray());
        Require(offered.Count == 6, "Six-command fixture did not model active commands plus retired report acknowledgements.");
        fixture.Reply(first, offered);
        PendingPost second = await fixture.NextAsync();
        Require(fixture.Outbox.Snapshot().Count == 0, "A valid six-command response failed to acknowledge four sent diagnostics.");
        Require(active.All(session => session.Accepts == 1 && fixture.Sessions.ContainsKey(session.Id)), "Six-command response did not preserve and process both active native sessions.");
        Require(second.Body["sessions"] is JsonArray nextReports && nextReports.Count == 2 && nextReports.Count <= 4 && nextReports.All(report => active.Any(session => session.Id == report?["id"]?.GetValue<string>())), "Six authoritative commands expanded the outgoing report bound or retained acknowledged diagnostics.");
        Require(!fixture.Logs.Any(message => message.Contains("Invalid authoritative", StringComparison.Ordinal)), "The valid active-plus-retired response hit the obsolete four-command rejection.");
    }

    private static async Task PausedIdleAsync()
    {
        Require(NativeRdpChannel.PollIntervalMs(60000, true, true) == 60000 && NativeRdpChannel.PollIntervalMs(int.MaxValue, true, true) == 60000, "Paused idle polling did not honor the bounded minute interval.");
        Require(NativeRdpChannel.PollIntervalMs(60000, false, true) == 5000 && NativeRdpChannel.PollIntervalMs(60000, true, false) == 5000, "A paused interval leaked into enabled or unreported session pacing.");
        await using var fixture = new ChannelFixture(management: true);
        fixture.Start(); PendingPost first = await fixture.NextAsync();
        fixture.ReplyPaused(first, new JsonArray());
        await Task.Delay(1200);
        Require(!fixture.HasQueuedPost, "Paused idle RDP kept polling every second.");
        // An ordinary later enabled response resumes the existing code path;
        // no process restart or permanent local feature toggle is required.
        fixture.Wake(); PendingPost resumed = await fixture.NextAsync();
        fixture.Reply(resumed, new JsonArray());
        PendingPost next = await fixture.NextAsync();
        Require(next.Body["sessions"] is JsonArray empty && empty.Count == 0, "Reenabled polling fabricated session reports.");
    }

    private static async Task PausedClosesAndReportsAsync()
    {
        await using var fixture = new ChannelFixture(management: true);
        var session = new FakeSession(Id, closeOnDispose: true); fixture.Seed(session); fixture.Start();
        PendingPost opening = await fixture.NextAsync();
        session.Fail(FirstError, finishErrorOnDispose: true);
        fixture.ReplyPaused(opening, new JsonArray(Command(Id, DateTimeOffset.UtcNow)));
        PendingPost diagnostic = await fixture.NextAsync();
        AssertDiagnostic(SingleReport(diagnostic.Body), Id, FirstError);
        Require(session.Disposals > 0 && session.Accepts == 0 && !session.Alive && fixture.Sessions.Count == 0, "A portal pause retained an active connection or renewed its lease.");
        fixture.ReplyPaused(diagnostic, new JsonArray());
        await Task.Delay(1200);
        Require(fixture.Outbox.Snapshot().Count == 0 && !fixture.HasQueuedPost, "Paused diagnostic acknowledgement kept polling or lost the minute idle wait.");
    }

    private static async Task PausedRejectsCommandsAsync()
    {
        foreach (bool malformed in new[] { false, true })
        {
            await using var fixture = new ChannelFixture(management: true);
            fixture.Start(); PendingPost first = await fixture.NextAsync();
            string requested = Guid.NewGuid().ToString();
            JsonNode commands = malformed ? new JsonObject { ["invalid"] = "not a session list" } : new JsonArray(Command(requested, DateTimeOffset.UtcNow), JsonValue.Create("invalid session"));
            fixture.ReplyPaused(first, commands);
            await Task.Delay(120);
            Require(!fixture.Claimed(requested) && fixture.Sessions.Count == 0 && fixture.Outbox.Snapshot().Count == 0, "An authenticated pause reached session claim/key admission for an inconsistent active response.");
            Require(!fixture.Logs.Any(message => message.Contains("channel:", StringComparison.OrdinalIgnoreCase)) && !fixture.HasQueuedPost, "An authenticated pause retried malformed active commands instead of denying them.");
        }
    }

    private static async Task UncachedAdmissionAsync()
    {
        // Model a stale positive idle cache against the actual local ReadOnly
        // mode. Admission must fail before writing a no-replay claim or key work.
        await using var fixture = new ChannelFixture(management: false, managementAllowed: () => true);
        fixture.Start(); PendingPost first = await fixture.NextAsync();
        string requested = Guid.NewGuid().ToString();
        fixture.Reply(first, new JsonArray(Command(requested, DateTimeOffset.UtcNow)));
        PendingPost refused = await fixture.NextAsync();
        Require(!fixture.Claimed(requested) && fixture.Sessions.Count == 0 && fixture.Logs.Any(message => message.Contains("ReadOnly", StringComparison.Ordinal)), "RDP admission trusted a stale positive idle cache instead of rechecking local Management.");
        Require(SingleReport(refused.Body)["state"]?.GetValue<string>() == "error", "Uncached ReadOnly refusal was not reported to the portal.");
    }

    private static JsonObject Command(string id, DateTimeOffset now) => new()
    {
        ["id"] = id, ["state"] = "opening", ["transport"] = "webrtc",
        ["expiresAt"] = now.AddHours(1).ToString("O"),
        ["leaseExpiresAt"] = now.AddSeconds(15).ToString("O"), ["leaseMs"] = 15000,
    };

    private static JsonObject Report(string id, string error, string? transport = "webrtc", string state = "error", int inputAck = 0, JsonArray? output = null)
    {
        var report = new JsonObject { ["id"] = id, ["state"] = state, ["inputAck"] = inputAck, ["output"] = output ?? new JsonArray(), ["error"] = error };
        if (transport is not null) report["transport"] = transport;
        return report;
    }

    private static JsonObject SingleReport(JsonObject body)
    {
        Require(body["sessions"] is JsonArray reports && reports.Count == 1 && reports[0] is JsonObject, "Expected one actual channel report.");
        return (JsonObject)body["sessions"]![0]!;
    }

    private static void AssertDiagnostic(JsonObject report, string id, string error)
    {
        Require(report["id"]?.GetValue<string>() == id && report["state"]?.GetValue<string>() == "error" && report["transport"]?.GetValue<string>() == "webrtc" && report["error"]?.GetValue<string>() == error && report["inputAck"]?.GetValue<int>() == 0 && report["output"] is JsonArray output && output.Count == 0, "Actual channel lost or changed the first terminal native RTC failure.");
        Require(report.Select(item => item.Key).Order().SequenceEqual(new[] { "error", "id", "inputAck", "output", "state", "transport" }), "Native diagnostic report included key, SDP or screen payload fields.");
    }

    private sealed class FakeSession(string id, bool closeOnDispose = false) : IRdpAgentSession
    {
        private readonly object gate = new();
        private string state = "opening", error = "", pendingError = "";
        private bool alive = true;
        private int disposals, accepts;
        public string Id { get; } = id;
        public bool Alive { get { lock (gate) return alive; } }
        public bool Expired => false;
        public bool IsDirect => true;
        public bool HasPendingOutput => false;
        internal int Disposals => Volatile.Read(ref disposals);
        internal int Accepts => Volatile.Read(ref accepts);
        public JsonObject Snapshot()
        {
            lock (gate)
            {
                var report = new JsonObject { ["id"] = Id, ["transport"] = "webrtc", ["state"] = state, ["inputAck"] = 0, ["output"] = new JsonArray() };
                if (error.Length != 0) report["error"] = error;
                return report;
            }
        }
        public void Accept(JsonObject command) => Interlocked.Increment(ref accepts);
        internal void Fail(string message, bool finishErrorOnDispose)
        {
            lock (gate)
            {
                alive = false;
                if (finishErrorOnDispose) pendingError = message;
                else { state = "error"; error = message; }
            }
        }
        public async ValueTask DisposeAsync()
        {
            Interlocked.Increment(ref disposals); await Task.Yield();
            lock (gate) if (pendingError.Length != 0) { state = "error"; error = pendingError; pendingError = ""; }
            if (closeOnDispose) lock (gate) { alive = false; if (state != "error") state = "closed"; }
            // Opening stays opening until the controlled failure: ReadOnly
            // cleanup cannot accidentally create the failure before first POST.
        }
    }

    private sealed record PendingPost(JsonObject Body, TaskCompletionSource<JsonObject> Response);

    private sealed class ChannelFixture : IAsyncDisposable
    {
        private readonly string root = Path.Combine(Path.GetTempPath(), "ServerDeskRdpDiagnosticTest-" + Guid.NewGuid().ToString("N"));
        private readonly CancellationTokenSource timeout = new(TimeSpan.FromSeconds(10));
        private readonly Channel<PendingPost> posts = Channel.CreateUnbounded<PendingPost>(new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
        private readonly NativeRdpChannel channel;
        private Task? running;
        internal List<string> Logs { get; } = [];
        internal Dictionary<string, IRdpAgentSession> Sessions => (Dictionary<string, IRdpAgentSession>)(typeof(NativeRdpChannel).GetField("sessions", BindingFlags.Instance | BindingFlags.NonPublic)?.GetValue(channel) ?? throw new Exception("Native RDP session collection was unavailable to the race fixture."));
        internal NativeRdpDiagnosticOutbox Outbox => (NativeRdpDiagnosticOutbox)(typeof(NativeRdpChannel).GetFields(BindingFlags.Instance | BindingFlags.NonPublic).Single(member => member.FieldType == typeof(NativeRdpDiagnosticOutbox)).GetValue(channel) ?? throw new Exception("Native RDP diagnostic outbox was unavailable to the pressure fixture."));
        internal ChannelFixture(bool management = false, Func<bool>? managementAllowed = null)
        {
            channel = new NativeRdpChannel(root, new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["mode"] = management ? "Management" : "ReadOnly" }, async (path, body, token) =>
            {
                Require(path == "/api/agent/rdp", "Diagnostic tests posted to an unexpected endpoint.");
                var response = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
                await posts.Writer.WriteAsync(new PendingPost((JsonObject)body.DeepClone(), response), token);
                return await response.Task.WaitAsync(token);
            }, log: message => { lock (Logs) Logs.Add(message); }, managementAllowed: managementAllowed);
        }
        internal void Seed(FakeSession session)
        {
            Sessions.Add(session.Id, session);
            typeof(NativeRdpChannel).GetMethod("Publish", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(channel, null);
        }
        internal void Start() => running = channel.RunAsync(timeout.Token);
        internal bool Claimed(string id) => File.Exists(Path.Combine(root, "rdp-claims", id + ".claim"));
        internal async Task<PendingPost> NextAsync() => await posts.Reader.ReadAsync(timeout.Token);
        internal bool HasQueuedPost => posts.Reader.TryPeek(out _);
        internal void Wake() => typeof(NativeRdpChannel).GetMethod("Notify", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(channel, null);
        internal void ReplyPaused(PendingPost pending, JsonNode offered) => pending.Response.TrySetResult(new JsonObject { ["available"] = false, ["sessions"] = offered, ["intervalMs"] = 60000 });
        internal void Reply(PendingPost pending, JsonArray offered)
        {
            Wake();
            pending.Response.TrySetResult(new JsonObject { ["sessions"] = offered, ["intervalMs"] = 20 });
        }
        public async ValueTask DisposeAsync()
        {
            timeout.Cancel(); await channel.StopAsync();
            if (running is not null) try { await running; } catch (OperationCanceledException) { }
            timeout.Dispose(); Directory.Delete(root, recursive: true);
        }
    }

    private static void Require(bool okay, string message) { if (!okay) throw new Exception(message); }
}
