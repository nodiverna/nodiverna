using System.ComponentModel;
using System.Management;
using System.Net;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// --failure-paths-self-test: the failure paths of agent 4.11.1 without Windows
// providers. The collector error codes, the failure series of a slot (thrown,
// stalled, recovered), the kept driver list, the snapshot while Drivers fails or
// stalls, the broker failure reply and BrokerException, the log line formats,
// the privileged call timeout, the portal retry backoff and the snapshot limit
// of collectorErrors. Agent 4.13.2: a broker outage uses the same backoff.
internal static class AgentFailurePathTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Failure path regression: " + message); }
    internal static async Task<int> RunSelfTestAsync()
    {
        try { await RunAsync(); Console.WriteLine("Failure path self-test passed."); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }

    private static async Task RunAsync()
    {
        Codes();
        await SeriesAsync();
        await StallAsync();
        await RetentionAsync();
        await SchedulerAsync();
        await RolesAsync();
        BrokerReplies();
        LogLines();
        Budgets();
        Backoff();
        Limits();
    }

    // ---- one code per failure ----
    private static void Codes()
    {
        string Code(Exception error) => CollectorErrorCodes.Classify(error);
        Check(Code(new TimeoutException()) == "timeout" && CollectorErrorCodes.Classify(ManagementStatus.Timedout) == "timeout" && CollectorErrorCodes.Classify(ManagementStatus.CallCanceled) == "timeout", "timeouts.");
        Check(Code(new UnauthorizedAccessException()) == "access-denied" && CollectorErrorCodes.Classify(ManagementStatus.AccessDenied) == "access-denied" && Code(new Win32Exception(5)) == "access-denied", "access denied.");
        Check(Code(new Win32Exception(2)) == "error", "another Windows error is error.");
        Check(Code(new PlatformNotSupportedException()) == "not-supported" && Code(new DllNotFoundException()) == "not-supported" && Code(new EntryPointNotFoundException()) == "not-supported"
            && new[] { ManagementStatus.InvalidClass, ManagementStatus.NotSupported, ManagementStatus.InvalidNamespace }.All(status => CollectorErrorCodes.Classify(status) == "not-supported"), "not supported.");
        Check(CollectorErrorCodes.Classify(ManagementStatus.Failed) == "error", "another WMI status is error.");
        Check(Code(new BrokerUnavailableException("The ServerDesk broker is not accepting connections.", new IOException("pipe"))) == "broker-unavailable" && Code(new BrokerUnavailableException("The broker closed the connection.")) == "broker-unavailable"
            && Code(new BrokerException("Broker 4.11.1 refuses worker 4.11.0.", code: "broker-unavailable")) == "broker-unavailable", "the broker pipe is not reachable, closed or refused the hello.");
        Check(Code(new InvalidOperationException("x")) == "error" && Code(new IOException("disk")) == "error", "anything else is error.");
        Check(Code(new BrokerException("Zeitüberschreitung", "ManagementException", "ManagementException, WMI=Timedout (0x80043001)", "timeout", 15012)) == "timeout" && Code(new BrokerException("x", code: "made-up")) == "error" && Code(new BrokerException("x")) == "error", "a broker failure keeps the broker's code; an unknown code is error.");
        Check(Code(new NativeInventoryException("Drivers", new TimeoutException())) == "timeout" && Code(new AggregateException(new UnauthorizedAccessException())) == "access-denied", "wrapped failures keep the inner code.");
        Check(CollectorErrorCodes.All.SequenceEqual(new[] { "timeout", "access-denied", "not-supported", "broker-unavailable", "error" }), "the five codes.");
        Check(new[] { "Drivers", "Software inventory", "Disk and battery health", "BitLocker", "Performance counters" }.Select(TelemetryCollectorSlot.CollectorId).SequenceEqual(new[] { "drivers", "software-inventory", "disk-and-battery-health", "bitlocker", "performance-counters" }), "collector ids.");
        Check(NativeTelemetryCollector.PrivilegedProviders.Select(TelemetryCollectorSlot.CollectorId).All(id => System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-z][a-z0-9-]{0,47}$")), "every id matches the portal pattern.");
    }

    // ---- a failure series: 1 → 2 failures, unchanged since, removed after a success ----
    private static async Task SeriesAsync()
    {
        bool fail = true; var lines = new List<string>();
        var slot = new TelemetryCollectorSlot("Software inventory", TimeSpan.FromMinutes(15), TimeSpan.FromSeconds(30), () => fail ? throw new TimeoutException("The operation has timed out.") : new JsonObject { ["software"] = 1 }, lines.Add);
        var at = DateTimeOffset.Parse("2026-11-03T16:00:00Z");
        slot.StartIfDue(at); try { await slot.CurrentTask!; } catch (TimeoutException) { }
        var first = slot.Read(at.AddSeconds(1)).Failure;
        Check(first is { Collector: "software-inventory", Code: "timeout", Failures: 1 } && first.Since == first.LastAt && first.ElapsedMs is >= 0, "the first failure starts a series.");
        slot.StartIfDue(at.AddMinutes(15)); try { await slot.CurrentTask!; } catch (TimeoutException) { }
        var second = slot.Read(at.AddMinutes(15).AddSeconds(1)).Failure;
        Check(second is { Failures: 2, Code: "timeout" } && second.Since == first!.Since && second.LastAt > first.LastAt, "the second failure counts on; since is unchanged.");
        var json = second!.ToJson();
        Check(json.Select(pair => pair.Key).SequenceEqual(new[] { "collector", "code", "since", "lastAt", "failures", "elapsedMs" }) && json["since"]!.GetValue<string>().StartsWith("2026-11-03T16:00:00.") && json["since"]!.GetValue<string>().EndsWith("+00:00") && json["failures"]!.GetValue<int>() == 2, "the JSON entry: " + json.ToJsonString());
        Check(lines.Count == 2 && lines.All(line => line.StartsWith("Inventory Software inventory: TimeoutException after ") && line.EndsWith(" ms; The operation has timed out.")), "one log line per failed run: " + string.Join(" | ", lines));
        fail = false;
        slot.StartIfDue(at.AddMinutes(30)); await slot.CurrentTask!;
        var recovered = slot.Read(at.AddMinutes(30).AddSeconds(1));
        Check(recovered.Failure is null && recovered.Error is null && recovered.Value?["software"]?.GetValue<int>() == 1, "a success removes the entry.");
    }

    // ---- a stalled slot is a timeout with its elapsed time and one log line per run ----
    private static async Task StallAsync()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var lines = new List<string>();
        var slot = new TelemetryCollectorSlot("Drivers", TimeSpan.FromMinutes(15), TimeSpan.FromSeconds(45), () => { entered.TrySetResult(); release.Task.GetAwaiter().GetResult(); return new JsonObject { ["driverHealth"] = new JsonObject() }; }, lines.Add, keepLastValue: true);
        var at = DateTimeOffset.Parse("2026-11-03T16:00:00Z");
        slot.StartIfDue(at); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Check(slot.Read(at.AddSeconds(30)).Failure is null, "a run within its deadline is no failure.");
        var stalled = slot.Read(at.AddSeconds(50)).Failure;
        Check(stalled is { Collector: "drivers", Code: "timeout", Failures: 1, ElapsedMs: >= 45_000 }, "past the deadline: timeout with elapsedMs ≥ the deadline.");
        Check(slot.IsResponsiveAt(at.AddSeconds(52)) == false, "a stalled slot is not responsive.");
        var later = slot.Read(at.AddSeconds(80)).Failure;
        Check(later is { Failures: 1, ElapsedMs: 80_000 } && later.Since == stalled!.Since, "the same run stays one failure; its elapsed time grows.");
        Check(lines.SequenceEqual(new[] { "Inventory Drivers: no result after 50000 ms; the collection continues in the background." }), "exactly one stall line per run: " + string.Join(" | ", lines));
        release.SetResult(); await slot.CurrentTask!;
        Check(slot.Read(at.AddSeconds(90)).Failure is null, "the late success removes the entry.");
        // A second stalled run counts once more and logs once more.
        var again = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var second = new TelemetryCollectorSlot("Drivers", TimeSpan.FromMinutes(15), TimeSpan.FromSeconds(45), () => { again.Task.GetAwaiter().GetResult(); throw new TimeoutException("late"); }, lines.Add);
        second.StartIfDue(at); second.Read(at.AddSeconds(46)); second.Read(at.AddSeconds(47));
        again.SetResult(); try { await second.CurrentTask!; } catch (TimeoutException) { }
        var ended = second.Read(at.AddSeconds(48)).Failure;
        Check(ended is { Failures: 1, Code: "timeout" } && lines.Count(line => line.Contains("no result after")) == 2 && lines[^1].StartsWith("Inventory Drivers: TimeoutException after "), "a stalled run that then fails stays one failure and logs its cause.");
    }

    private static JsonObject DriverValue(string collectedAt) => new()
    {
        ["driverHealth"] = new JsonObject { ["collectedAt"] = collectedAt, ["checksum"] = new string('a', 64) },
        [NativeDriverInventory.InventoryKey] = new JsonObject { ["checksum"] = new string('a', 64), ["count"] = 0, ["truncated"] = false, ["items"] = new JsonArray() }
    };

    // ---- the driver list survives failures for 3 × interval; another slot goes stale ----
    private static async Task RetentionAsync()
    {
        var interval = TimeSpan.FromSeconds(NativeDriverInventory.IntervalSeconds);
        var at = DateTimeOffset.Parse("2026-11-03T16:00:00Z");
        bool fail = false;
        var drivers = new TelemetryCollectorSlot("Drivers", interval, TimeSpan.FromSeconds(45), () => fail ? throw new BrokerException("Zeitüberschreitung", "ManagementException", "ManagementException, WMI=Timedout (0x80043001)", "timeout", 15012) : DriverValue(at.ToString("O")), keepLastValue: true);
        var other = new TelemetryCollectorSlot("Certificates", interval, TimeSpan.FromSeconds(30), () => fail ? throw new InvalidOperationException("x") : new JsonObject { ["certificates"] = new JsonObject() });
        foreach (var slot in new[] { drivers, other }) { slot.StartIfDue(at); await slot.CurrentTask!; }
        fail = true;
        for (int run = 1; run <= 3; run++)
            foreach (var slot in new[] { drivers, other }) { slot.StartIfDue(at + run * interval); try { await slot.CurrentTask!; } catch (Exception) { } }
        var now = at + 3 * interval + TimeSpan.FromSeconds(30);
        var snapshot = new JsonObject(); var errors = new JsonArray(); var lists = new Dictionary<string, JsonObject>();
        NativeTelemetryCollector.ApplyCollectors(snapshot, new[] { drivers, other }, now, errors, (key, list) => lists[key] = list);
        Check(snapshot["driverHealth"]?["collectedAt"]?.GetValue<string>() == at.ToString("O"), "the old driverHealth with its old collectedAt is kept.");
        Check(lists.ContainsKey(NativeDriverInventory.InventoryKey) && !snapshot.ContainsKey(NativeDriverInventory.InventoryKey), "the old list stays available for upload and never enters the snapshot.");
        Check(!snapshot.ContainsKey("certificates"), "another slot's value goes stale as before.");
        var entries = snapshot["collectorErrors"]!.AsArray();
        var driverError = entries.Single(entry => entry!["collector"]!.GetValue<string>() == "drivers")!;
        Check(driverError["code"]!.GetValue<string>() == "timeout" && driverError["failures"]!.GetValue<int>() == 3 && entries.Count == 2, "a drivers error with the broker's code and three failures.");
        Check(errors.Select(error => error!.GetValue<string>()).Any(error => error.StartsWith("Drivers could not be read")), "the collectionErrors strings stay.");
    }

    // ---- a stalled Drivers collector does not block the others ----
    private static async Task SchedulerAsync()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var lines = new List<string>();
        var drivers = new TelemetryCollectorSlot("Drivers", TimeSpan.FromSeconds(NativeDriverInventory.IntervalSeconds), TimeSpan.FromSeconds(NativeDriverInventory.DeadlineSeconds), () => { entered.TrySetResult(); release.Task.GetAwaiter().GetResult(); return DriverValue("x"); }, lines.Add, keepLastValue: true);
        var others = new[] { "Reliability", "Disk and battery health", "Certificates", "Autostart" }.Select(name => new TelemetryCollectorSlot(name, TimeSpan.FromMinutes(15), TimeSpan.FromSeconds(30), () => new JsonObject { [TelemetryCollectorSlot.CollectorId(name)] = true }, lines.Add)).ToList();
        var all = new List<TelemetryCollectorSlot> { drivers }; all.AddRange(others);
        var scheduler = new TelemetryInventoryScheduler(all);
        var at = DateTimeOffset.Parse("2026-11-03T16:00:00Z");
        Check(scheduler.Tick(at), "the scheduler starts Drivers.");
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        // Past the Drivers deadline every other due collector still starts.
        var tick = at.AddSeconds(NativeDriverInventory.DeadlineSeconds + 5);
        foreach (var slot in others)
        {
            Check(scheduler.Tick(tick), "a stalled Drivers read does not block " + slot.Name + ".");
            await slot.CurrentTask!.WaitAsync(TimeSpan.FromSeconds(5));
            tick = tick.AddSeconds(2);
        }
        var snapshot = new JsonObject { ["hostname"] = "PC" }; var errors = new JsonArray();
        NativeTelemetryCollector.ApplyCollectors(snapshot, all, tick, errors);
        foreach (var slot in others) Check(snapshot[slot.Id]?.GetValue<bool>() == true, slot.Name + " reaches the snapshot while Drivers stalls.");
        var entries = snapshot["collectorErrors"]!.AsArray();
        Check(entries.Count == 1 && entries[0]!["collector"]!.GetValue<string>() == "drivers" && entries[0]!["code"]!.GetValue<string>() == "timeout" && entries[0]!["elapsedMs"]!.GetValue<long>() >= NativeDriverInventory.DeadlineSeconds * 1000L, "only Drivers has an error, a timeout.");
        Check(lines.Count(line => line.StartsWith("Inventory Drivers: no result after ")) == 1, "one stall line for the run.");
        NativeTelemetryCollector.LimitSnapshot(snapshot);
        Check(snapshot["collectorErrors"]!.AsArray().Count == 1 && snapshot["hostname"]!.GetValue<string>() == "PC", "LimitSnapshot keeps collectorErrors.");
        release.SetResult(); await drivers.CurrentTask!;
        // A throwing Drivers collector does not remove the other fields either.
        var broken = new TelemetryCollectorSlot("Drivers", TimeSpan.FromMinutes(15), TimeSpan.FromSeconds(45), () => throw new UnauthorizedAccessException("denied"));
        broken.StartIfDue(at); try { await broken.CurrentTask!; } catch (UnauthorizedAccessException) { }
        snapshot = new JsonObject(); errors = new JsonArray();
        NativeTelemetryCollector.ApplyCollectors(snapshot, new[] { broken }.Concat(others), tick, errors);
        Check(others.All(slot => snapshot[slot.Id]?.GetValue<bool>() == true) && snapshot["collectorErrors"]!.AsArray().Single()!["code"]!.GetValue<string>() == "access-denied", "a throwing Drivers collector keeps the other fields.");
    }

    // ---- 4.21.5: a slow role enumeration within its deadline shows the roles; a real failure keeps its line ----
    private static async Task RolesAsync()
    {
        var deadline = TimeSpan.FromSeconds(NativeFeatures.InventoryDeadlineSeconds);
        var at = DateTimeOffset.Parse("2026-11-26T09:00:00Z");
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var lines = new List<string>();
        var slot = new TelemetryCollectorSlot("Roles and features", TimeSpan.FromSeconds(NativeTelemetryCollector.InventorySeconds), deadline,
            () => { entered.TrySetResult(); release.Task.GetAwaiter().GetResult(); return new JsonObject { ["features"] = new JsonArray(new JsonObject { ["name"] = "Web-Server", ["installed"] = true }) }; }, lines.Add);
        slot.StartIfDue(at); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        foreach (int seconds in new[] { 26, 46, 100, NativeFeatures.ServerEnumerationSeconds, NativeFeatures.InventoryDeadlineSeconds })
        {
            var running = slot.Read(at.AddSeconds(seconds));
            Check(running.Failure is null && running.Error == "Roles and features is being initialized.", "a role read at " + seconds + " s is no failure and no \"does not answer in time\" line: " + running.Error);
        }
        release.SetResult(); await slot.CurrentTask!;
        var snapshot = new JsonObject(); var errors = new JsonArray();
        NativeTelemetryCollector.ApplyCollectors(snapshot, new[] { slot }, at.AddSeconds(NativeFeatures.InventoryDeadlineSeconds), errors);
        Check(snapshot["features"]?[0]?["name"]?.GetValue<string>() == "Web-Server" && errors.Count == 0 && snapshot["collectorErrors"]!.AsArray().Count == 0 && lines.Count == 0,
            "a slow read within the deadline fills features without a collection error: " + snapshot.ToJsonString());

        // A run past the deadline still reports the stall line.
        var stuck = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var late = new TelemetryCollectorSlot("Roles and features", TimeSpan.FromSeconds(NativeTelemetryCollector.InventorySeconds), deadline, () => { stuck.Task.GetAwaiter().GetResult(); return new JsonObject { ["features"] = new JsonArray() }; }, lines.Add);
        late.StartIfDue(at);
        var stalled = late.Read(at.AddSeconds(NativeFeatures.InventoryDeadlineSeconds + 1));
        Check(stalled.Error == "Roles and features: the Windows provider does not answer in time; the collection continues independently." && stalled.Failure is { Collector: "roles-and-features", Code: "timeout" }, "past 150 s the stall line stays.");
        stuck.SetResult(); await late.CurrentTask!;

        // Real failures keep today's line, one classified entry and the worker log line.
        foreach (var (failure, code) in new (Exception, string)[]
        {
            (new AgentMessageException("AGENT_FEATURE_INVENTORY_TIMEOUT"), "error"),
            (new AgentMessageException("AGENT_FEATURE_INVENTORY_EMPTY"), "error"),
            (new BrokerException("ServerManager failed.", "NativeInventoryException", "NativeInventoryException, WMI=AccessDenied (0x80041003)", "access-denied", 4200), "access-denied")
        })
        {
            lines.Clear();
            var failing = new TelemetryCollectorSlot("Roles and features", TimeSpan.FromSeconds(NativeTelemetryCollector.InventorySeconds), deadline, () => throw failure, lines.Add);
            failing.StartIfDue(at); try { await failing.CurrentTask!; } catch (Exception) { }
            snapshot = new JsonObject(); errors = new JsonArray();
            NativeTelemetryCollector.ApplyCollectors(snapshot, new[] { failing }, at.AddSeconds(1), errors);
            var entries = snapshot["collectorErrors"]!.AsArray();
            Check(!snapshot.ContainsKey("features") && errors.Count == 1 && errors[0]!.GetValue<string>() == "Roles and features could not be read (" + NativeInventoryDiagnostics.Describe(failure) + ")."
                && entries.Count == 1 && entries[0]!["collector"]!.GetValue<string>() == "roles-and-features" && entries[0]!["code"]!.GetValue<string>() == code
                && lines.Count == 1 && lines[0].StartsWith("Inventory Roles and features: ", StringComparison.Ordinal), "a real failure keeps its line and code: " + errors.ToJsonString() + " " + entries.ToJsonString() + " " + string.Join(" | ", lines));
        }
    }

    // ---- the broker failure reply round-trips into BrokerException ----
    private static void BrokerReplies()
    {
        var reply = BrokerProtocol.Failure(new TimeoutException("The privileged inventory is still running."), 30012);
        Check(reply["ok"]!.GetValue<bool>() == false && reply["error"]!.GetValue<string>() == "The privileged inventory is still running." && reply["errorType"]!.GetValue<string>() == "TimeoutException"
            && reply["errorDetail"]!.GetValue<string>() == "TimeoutException" && reply["errorCode"]!.GetValue<string>() == "timeout" && reply["elapsedMs"]!.GetValue<long>() == 30012, "the failure reply: " + reply.ToJsonString());
        var round = BrokerException.FromReply(JsonNode.Parse(reply.ToJsonString())!.AsObject(), "fallback");
        Check(round.Message == "The privileged inventory is still running." && round.RemoteType == "TimeoutException" && round.Detail == "TimeoutException" && round.Code == "timeout" && round.ElapsedMs == 30012, "the reply becomes a BrokerException with its properties.");
        Check(CollectorErrorCodes.Classify(round) == "timeout", "a broker timeout stays timeout in the worker.");
        var denied = BrokerProtocol.Failure(new NativeInventoryException("Driver signatures", new Win32Exception(5)), 12);
        Check(denied["errorType"]!.GetValue<string>() == "NativeInventoryException" && denied["errorDetail"]!.GetValue<string>().Contains("Win32Exception, Windows code=5") && denied["errorCode"]!.GetValue<string>() == "access-denied", "a wrapped Windows error keeps its detail and code.");
        var old = BrokerException.FromReply(new JsonObject { ["ok"] = false, ["error"] = "Broker 4.11.1 refuses worker 4.11.0." }, "fallback");
        Check(old.RemoteType is null && old.Detail is null && old.Code is null && old.ElapsedMs is null && CollectorErrorCodes.Classify(old) == "error", "absent fields are null.");
        Check(BrokerException.FromReply(new JsonObject { ["ok"] = false }, "The broker refused the request.").Message == "The broker refused the request.", "a reply without a message uses the fallback.");
        Check(BrokerProtocol.Failure(new InvalidOperationException(new string('x', 2000)), 1)["error"]!.GetValue<string>().Length == 1500 && BrokerProtocol.Failure(new NativeInventoryException(new string('c', 300), new IOException()), 1)["errorDetail"]!.GetValue<string>().Length <= 200, "message ≤ 1500 and detail ≤ 200 characters.");
    }

    // ---- log lines name collector, type, code and elapsed time ----
    private static void LogLines()
    {
        const string message = "Zeitüberschreitung";
        var broker = new BrokerException(message, "ManagementException", "ManagementException, WMI=Timedout (0x80043001)", "timeout", 15012);
        string worker = TelemetryCollectorSlot.FailureLine("Drivers", broker, 15400);
        Check(worker == "Inventory Drivers: broker ManagementException, WMI=Timedout (0x80043001) after 15012 ms; Zeitüberschreitung", "the worker line of a broker failure: " + worker);
        string local = TelemetryCollectorSlot.FailureLine("Drivers", new TimeoutException("The broker did not answer telemetry in time."), 60001);
        Check(local == "Inventory Drivers: TimeoutException after 60001 ms; The broker did not answer telemetry in time.", "the worker line of a local failure: " + local);
        string unavailable = TelemetryCollectorSlot.FailureLine("Drivers", new BrokerUnavailableException("The ServerDesk broker is not accepting connections.", new IOException("pipe")), 5003);
        Check(unavailable == "Inventory Drivers: BrokerUnavailableException after 5003 ms; pipe", "the worker line when the broker is not reachable: " + unavailable);
        string stall = TelemetryCollectorSlot.StallLine("Drivers", 45012);
        Check(stall == "Inventory Drivers: no result after 45012 ms; the collection continues in the background.", "the stall line.");
        // The broker line, with the message redacted and limited to 300 characters.
        string brokerLine = BrokerTelemetry.FailureLine("Drivers", new TimeoutException(message), 15012, text => text);
        Check(brokerLine == "Broker telemetry Drivers: TimeoutException after 15012 ms; Zeitüberschreitung", "the broker line: " + brokerLine);
        string redacted = BrokerTelemetry.FailureLine("Drivers", new InvalidOperationException("token=secret " + new string('y', 400)), 3, text => text.Replace("secret", "***"));
        Check(redacted.Contains("token=***") && !redacted.Contains("secret") && redacted.Length <= "Broker telemetry Drivers: InvalidOperationException after 3 ms; ".Length + 300, "the broker line is redacted and short.");
        foreach (string line in new[] { worker, local, unavailable, stall, brokerLine, redacted })
            Check(line != message && line != nameof(BrokerException) && !line.StartsWith("Inventory Drivers: BrokerException") && line.Contains(" ms"), "no line is only the Windows message or BrokerException: " + line);
    }

    // ---- the privileged broker call waits for the collector's deadline plus 15 s, at least 45 s ----
    private static void Budgets()
    {
        Check(AgentWorker.PrivilegedCallSeconds(NativeDriverInventory.DeadlineSeconds) == 60 && AgentWorker.PrivilegedCallSeconds(6) == 45 && AgentWorker.PrivilegedCallSeconds(30) == 45 && AgentWorker.PrivilegedCallSeconds(31) == 46, "max(45, deadline + 15).");
    }

    // ---- the portal retry backoff ----
    private static void Backoff()
    {
        var backoff = new PortalRetryBackoff();
        var at = DateTimeOffset.Parse("2026-11-03T16:00:00Z");
        var proxy = new AgentHttpException("HTTP 502 from /api/agent/channel", HttpStatusCode.BadGateway, null);
        var waits = new List<int>(); var logged = new List<bool>(); var time = at;
        for (int i = 0; i < 7; i++) { var retry = backoff.Failed(proxy, time); waits.Add(retry.DelayMs); logged.Add(retry.Log); time = time.AddMilliseconds(Math.Max(5000, retry.DelayMs)); }
        Check(waits.SequenceEqual(new[] { 2000, 4000, 8000, 16000, 30000, 30000, 30000 }), "2, 4, 8, 16, then 30 s: " + string.Join(",", waits));
        Check(logged[0] && !logged[1] && !logged[2] && logged.Count(flag => flag) <= 1 + (int)((time - at).TotalSeconds / 30), "the first failure is logged, then at most one line per 30 s.");
        backoff.Success();
        Check(backoff.Failures == 0 && backoff.Failed(proxy, time) == (2000, true), "a success resets the series; the next failure logs again.");
        foreach (var status in new[] { HttpStatusCode.BadGateway, HttpStatusCode.ServiceUnavailable, HttpStatusCode.GatewayTimeout })
            Check(PortalRetryBackoff.IsTransient(new AgentHttpException("HTTP", status, null)), (int)status + " is transient.");
        Check(PortalRetryBackoff.IsTransient(new HttpRequestException("No connection could be made.", new System.Net.Sockets.SocketException(10061))) && PortalRetryBackoff.IsTransient(new TaskCanceledException("The request was canceled due to the configured HttpClient.Timeout.")), "a connection failure and an HTTP timeout are transient.");
        foreach (var status in new[] { HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden, HttpStatusCode.Conflict, HttpStatusCode.InternalServerError })
            Check(!PortalRetryBackoff.IsTransient(new AgentHttpException("HTTP", status, "AGENT_UNINSTALL_NOT_CONFIRMED")), (int)status + " is not transient.");
        Check(PortalRetryBackoff.IsTransient(new BrokerUnavailableException("Pipe is broken.")) && PortalRetryBackoff.IsTransient(new BrokerException("Broker 4.13.2 refuses worker 4.13.1.", code: "broker-unavailable")), "a broker that is not reachable or refused the hello is transient.");
        Check(!PortalRetryBackoff.IsTransient(new BrokerException("x")) && !PortalRetryBackoff.IsTransient(new BrokerException("x", code: "timeout")) && !PortalRetryBackoff.IsTransient(new TimeoutException("The broker did not answer channel-state in time.")) && !PortalRetryBackoff.IsTransient(new UnauthorizedAccessException("The broker pipe is not served by the ServerDesk broker service.")), "other broker failures, a broker timeout and a pipe squatter are not transient.");
        var other = new PortalRetryBackoff();
        Check(other.Failed(new AgentHttpException("HTTP 409", HttpStatusCode.Conflict, "AGENT_UNINSTALL_NOT_CONFIRMED"), at) == (0, true) && other.Failures == 0, "other failures keep the loop's own wait and are always logged.");
        BrokerOutage();
    }

    // ---- 4.13.2: a broker outage uses the same backoff and log spacing ----
    private static void BrokerOutage()
    {
        var at = DateTimeOffset.Parse("2026-11-03T16:00:00Z");
        var down = new BrokerUnavailableException("Pipe is broken.");
        var series = new PortalRetryBackoff(); var waits = new List<int>(); var logged = new List<bool>(); var time = at;
        for (int i = 0; i < 6; i++) { var retry = series.Failed(down, time); waits.Add(retry.DelayMs); logged.Add(retry.Log); time = time.AddMilliseconds(Math.Max(1000, retry.DelayMs)); }
        Check(waits.SequenceEqual(new[] { 2000, 4000, 8000, 16000, 30000, 30000 }), "a broker outage waits 2, 4, 8, 16, then 30 s: " + string.Join(",", waits));
        Check(logged[0] && logged.Count(flag => flag) <= 1 + (int)((time - at).TotalSeconds / 30), "the first broker failure is logged, then at most one line per 30 s.");
        // The terminal and relay loops wait max(1000, delay), the channel loop max(5000, delay):
        // a fake clock over a 33 s outage, then the broker is back.
        foreach (var (loop, minimum) in new[] { ("Terminal channel", 1000), ("Broker relay", 1000), ("Channel", 5000) })
        {
            var backoff = new PortalRetryBackoff(); var clock = at; var end = at.AddSeconds(33); int lines = 0, attempts = 0; var spacing = new List<int>(); DateTimeOffset? lastLine = null;
            while (clock < end)
            {
                var retry = backoff.Failed(down, clock); attempts++;
                if (retry.Log) { Check(lastLine is null || clock - lastLine >= TimeSpan.FromSeconds(30), loop + ": two lines less than 30 s apart."); lines++; lastLine = clock; }
                int wait = Math.Max(minimum, retry.DelayMs); spacing.Add(wait);
                Check(wait <= PortalRetryBackoff.CapMilliseconds, loop + ": a wait above 30 s.");
                clock = clock.AddMilliseconds(wait);
            }
            // The next attempt after the outage comes at most 30 s after the broker is back, and it succeeds.
            Check(clock - end <= TimeSpan.FromSeconds(30), loop + ": the next attempt after the outage comes within 30 s.");
            backoff.Success();
            Check(lines is >= 1 and <= 2 && attempts <= 6 && backoff.Failures == 0, loop + ": " + lines + " lines in " + attempts + " attempts over 33 s.");
            int[] expected = minimum == 5000 ? [5000, 5000, 8000, 16000, 30000] : [2000, 4000, 8000, 16000, 30000];
            Check(spacing.Count >= 4 && spacing.SequenceEqual(expected.Take(spacing.Count)), loop + " waits " + string.Join(",", spacing) + " ms.");
        }
        // One backoff per loop for broker and portal failures: a portal 503 continues the broker series.
        var mixed = new PortalRetryBackoff();
        mixed.Failed(down, at); mixed.Failed(new AgentHttpException("HTTP 503", HttpStatusCode.ServiceUnavailable, null), at.AddSeconds(2));
        Check(mixed.Failures == 2 && mixed.Failed(new BrokerException("Broker 4.13.2 refuses worker 4.13.1.", code: "broker-unavailable"), at.AddSeconds(6)) == (8000, false), "broker and portal failures share one series.");
        // A broker timeout keeps the 1 s wait and is always logged.
        Check(mixed.Failed(new TimeoutException("The broker did not answer relay-take in time."), at.AddSeconds(14)) == (0, true), "a broker timeout is not throttled.");
    }

    // ---- LimitSnapshot keeps at most 30 collectorErrors ----
    private static void Limits()
    {
        var at = DateTimeOffset.Parse("2026-11-03T16:00:00Z");
        var entries = Enumerable.Range(0, 40).Select(i => (JsonNode?)new CollectorFailure("collector-" + i, "error", at, at, 1, null).ToJson()).ToArray();
        var snapshot = new JsonObject { ["collectorErrors"] = new JsonArray(entries), ["collectionErrors"] = new JsonArray() };
        NativeTelemetryCollector.LimitSnapshot(snapshot);
        Check(snapshot["collectorErrors"]!.AsArray().Count == 30 && snapshot["collectorErrors"]![0]!["elapsedMs"] is null, "at most 30 collectorErrors; elapsedMs may be null.");
        var bounded = new CollectorFailure("drivers", "timeout", at, at, 2_000_000, 9_000_000).ToJson();
        Check(bounded["failures"]!.GetValue<int>() == 1_000_000 && bounded["elapsedMs"]!.GetValue<long>() == 3_600_000, "failures and elapsedMs stay within the portal bounds.");
    }
}
