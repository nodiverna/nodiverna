using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class DeviceTokenClientTests
{
    internal static async Task RunAsync()
    {
        using var rsa = RSA.Create(2048);
        string origin = "https://serverdesk.test", id = Guid.NewGuid().ToString(), legacy = new('a', 64);
        var config = new JsonObject { ["id"] = id, ["origin"] = origin, ["token"] = legacy, ["privateKey"] = rsa.ToXmlString(true), ["mode"] = "ReadOnly" };
        double clock = 0; bool ready = false, failRenewal = false, loseResponse = false, failSave = false;
        int challenges = 0, issued = 0, saved = 0; JsonObject? durable = null;
        JsonObject Challenge()
        {
            var date = DateTimeOffset.UtcNow;
            var challenge = new JsonObject { ["version"] = 1, ["serverId"] = id, ["origin"] = origin, ["challengeId"] = Guid.NewGuid().ToString(), ["nonce"] = new string('n', 43), ["proof"] = new string('p', 43), ["expiresAt"] = date.ToUnixTimeSeconds() + 120, ["algorithm"] = "RS256", ["_httpServerDate"] = date.ToString("O") };
            challenge["message"] = "ServerDesk device access token v1\n" + origin + "\n" + id + "\n" + challenge["challengeId"]!.GetValue<string>() + "\n" + challenge["nonce"]!.GetValue<string>() + "\n" + challenge["expiresAt"]!.GetValue<long>();
            return challenge;
        }
        JsonObject? offered = null;
        async Task<JsonObject> Post(string path, JsonObject body, CancellationToken token)
        {
            await Task.Yield(); token.ThrowIfCancellationRequested();
            if (path.EndsWith("/challenge", StringComparison.Ordinal)) { challenges++; offered = Challenge(); return offered.DeepClone().AsObject(); }
            if (failRenewal) throw new HttpRequestException("Transient test failure", null, HttpStatusCode.ServiceUnavailable);
            Check(offered is not null && body["expiresAt"]!.GetValue<long>() == offered["expiresAt"]!.GetValue<long>() && body["proof"]!.GetValue<string>() == offered["proof"]!.GetValue<string>(), "Challenge expiry/proof was not echoed");
            Check(rsa.VerifyData(Encoding.UTF8.GetBytes(offered!["message"]!.GetValue<string>()), Convert.FromBase64String(body["signature"]!.GetValue<string>()), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1), "Renewal did not prove the private device key");
            issued++;
            if (loseResponse) { loseResponse = false; throw new HttpRequestException("Lost response after server rotation"); }
            return new JsonObject { ["serverId"] = id, ["tokenMode"] = "key-bound", ["token"] = issued.ToString("x").PadLeft(64, '0'), ["expiresIn"] = 900, ["expiresAt"] = DateTimeOffset.UtcNow.AddMinutes(15).ToString("O") };
        }
        void Save(JsonObject state) { if (failSave) { failSave = false; throw new IOException("Test durable state write failure"); } durable = state.DeepClone().AsObject(); saved++; }
        var client = new DeviceTokenClient(config, null, () => ready, Post, Save, () => clock);
        Check(await client.AccessAsync(CancellationToken.None) == legacy && challenges == 0, "Migration bypassed pending install/update safety gate");
        ready = true;
        string[] parallel = await Task.WhenAll(Enumerable.Range(0, 16).Select(_ => client.AccessAsync(CancellationToken.None)));
        Check(challenges == 1 && issued == 1 && saved == 1 && parallel.Distinct().Count() == 1, "Parallel channels raced token rotation or durability");
        Check(config["token"]!.GetValue<string>() == legacy && durable?["token"]?.GetValue<string>() == parallel[0], "Bootstrap changed or current bearer was not durable");
        clock = 610; failRenewal = true;
        Check(await client.AccessAsync(CancellationToken.None) == parallel[0], "Proactive renewal failure dropped a still-live terminal token");
        clock = 1000;
        await RejectAsync(() => client.AccessAsync(CancellationToken.None), "An expired access token was kept after failed renewal");
        failRenewal = false;
        string recovered = await client.AccessAsync(CancellationToken.None);
        Check(recovered != parallel[0] && saved == 2, "Offline/expired bearer did not recover with the device key");
        var restart = new DeviceTokenClient(config, durable, () => false, Post, Save, () => clock);
        int beforeRestart = issued;
        Check(await restart.AccessAsync(CancellationToken.None) != legacy && issued == beforeRestart, "Restart did not adopt a still-live durable token");
        JsonObject? changed = null;
        var installer = new DeviceTokenClient(config, durable, () => true, Post, Save, () => clock, () => { var state = changed; changed = null; return state; });
        changed = durable!.DeepClone().AsObject(); changed["token"] = new string('f', 64);
        Check(await installer.AccessAsync(CancellationToken.None) == new string('f', 64) && issued == beforeRestart, "A parallel installer ignored the latest durable service token");
        var wrongIdentity = durable.DeepClone().AsObject(); wrongIdentity["serverId"] = Guid.NewGuid().ToString();
        var otherDevice = new DeviceTokenClient(config, wrongIdentity, () => false, Post, Save, () => clock);
        Check(await otherDevice.AccessAsync(CancellationToken.None) == legacy, "A token from another device bypassed identity binding");

        // Server rotation may succeed while the response or local disk write is
        // lost. A fresh proof recovers without a second permanent bearer.
        var interrupted = new DeviceTokenClient(config, null, () => true, Post, Save, () => clock);
        loseResponse = true;
        Check(await interrupted.AccessAsync(CancellationToken.None) == legacy, "Lost issuance response fabricated a usable token");
        clock += 31;
        Check(await interrupted.AccessAsync(CancellationToken.None) != legacy, "Lost issuance response prevented recovery");
        var diskFailure = new DeviceTokenClient(config, null, () => true, Post, Save, () => clock);
        failSave = true;
        Check(await diskFailure.AccessAsync(CancellationToken.None) == legacy, "Token was exposed before durable storage committed");
        clock += 31;
        Check(await diskFailure.AccessAsync(CancellationToken.None) != legacy, "Failed durable storage prevented later key recovery");

        foreach (string field in new[] { "origin", "serverId", "message", "nonce", "proof", "expiresAt", "algorithm" })
        {
            var invalid = Challenge();
            if (field == "expiresAt") invalid[field] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 1;
            else invalid[field] = "tampered";
            bool rejected = false; try { DeviceTokenClient.ValidateChallenge(invalid, origin, id); } catch (InvalidDataException) { rejected = true; }
            Check(rejected, "Unbound or stale challenge was signed: " + field);
        }
        // The challenge uses server time, so a large Windows wall-clock skew
        // neither signs stale challenges nor prevents legitimate offline renewals.
        var skew = Challenge(); var serverDate = DateTimeOffset.UtcNow.AddDays(-30); skew["_httpServerDate"] = serverDate.ToString("O"); skew["expiresAt"] = serverDate.ToUnixTimeSeconds() + 120;
        skew["message"] = "ServerDesk device access token v1\n" + origin + "\n" + id + "\n" + skew["challengeId"]!.GetValue<string>() + "\n" + skew["nonce"]!.GetValue<string>() + "\n" + skew["expiresAt"]!.GetValue<long>();
        _ = DeviceTokenClient.ValidateChallenge(skew, origin, id);

        int sends = 0, renewBefore = issued; string? firstBody = null; bool generic = false;
        var inner = new TestHandler(async request => {
            sends++; string value = request.Content is null ? "" : await request.Content.ReadAsStringAsync();
            firstBody ??= value; Check(value == firstBody, "Authentication recovery changed the request body");
            if (generic || sends == 1) return new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent(generic ? "{\"error\":\"post-dispatch denial\"}" : "{\"code\":\"DEVICE_TOKEN_REJECTED\"}", Encoding.UTF8, "application/json") };
            Check(request.Headers.Authorization?.Parameter != recovered, "Rejected bearer was replayed unchanged");
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}") };
        });
        using var http = new HttpClient(new DeviceTokenClient.DeviceAuthorizationHandler(client) { InnerHandler = inner });
        using var success = await http.PostAsync(origin + "/api/agent/channel", new StringContent("{\"results\":[]}", Encoding.UTF8, "application/json"));
        Check(success.IsSuccessStatusCode && sends == 2 && issued == renewBefore + 1, "Initial authentication rejection did not make one safe retry");
        generic = true; sends = 0; renewBefore = issued;
        using var denial = await http.PostAsync(origin + "/api/agent/channel", new StringContent(firstBody!, Encoding.UTF8, "application/json"));
        Check(denial.StatusCode == HttpStatusCode.Forbidden && sends == 1 && issued == renewBefore, "Generic/post-dispatch denial replayed work");
        inner.Reply = request => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("{\"code\":{\"unexpected\":true}}", Encoding.UTF8, "application/json") });
        using var malformed = await http.GetAsync(origin + "/api/agent/channel");
        Check(malformed.StatusCode == HttpStatusCode.Forbidden && issued == renewBefore, "Malformed denial code triggered renewal or an exception");
        using var stop = new CancellationTokenSource(); stop.Cancel();
        await RejectAsync(() => client.AccessAsync(stop.Token), "Cancelled renewal did not stop");
        Console.WriteLine("Device token client tests passed: RSA binding, single-flight renewal, durable-before-use, expiry/offline/restart recovery, install rollback gate, transient refresh, skew and initial-auth-only retry.");
    }
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    private static async Task RejectAsync(Func<Task<string>> action, string message) { bool rejected = false; try { await action(); } catch (Exception e) when (e is HttpRequestException or OperationCanceledException) { rejected = true; } Check(rejected, message); }
    private sealed class TestHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        internal Func<HttpRequestMessage, Task<HttpResponseMessage>> Reply { get; set; } = send;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => Reply(request);
    }
}
