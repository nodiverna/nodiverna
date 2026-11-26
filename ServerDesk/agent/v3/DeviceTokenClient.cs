using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// The RSA device identity is the renewal credential. It stays in the broker's
// config.bin; the unprivileged worker holds only the key fingerprint and asks
// the broker to sign a validated renewal challenge. The worker is the only
// process that persists the short-lived bearer (machine DPAPI, worker-only
// directory). The installer renews in memory and never writes that file.
internal sealed class DeviceTokenClient
{
    private static readonly ConcurrentDictionary<string, DeviceTokenClient> clients = new();
    private readonly SemaphoreSlim renewal = new(1, 1);
    private readonly JsonObject config;
    private readonly string id, origin, keyHash;
    private readonly Func<bool> canMigrate;
    private readonly Func<string, JsonObject, CancellationToken, Task<JsonObject>> post;
    private readonly Func<JsonObject, CancellationToken, Task<string>> sign;
    private readonly Action<JsonObject> save;
    private readonly Func<double> clock;
    private readonly Func<JsonObject?> readChangedState = () => null;
    private readonly Func<CancellationToken, Task<IDisposable?>> acquireRenewalLease = _ => Task.FromResult<IDisposable?>(null);
    private string accessToken;
    private string[] diagnosticTokens = [];
    private bool migrated;
    private double refreshAt, validUntil, retryAt;

    private DeviceTokenClient(JsonObject config, string? stateDirectory, Func<JsonObject, CancellationToken, Task<string>>? signer)
    {
        this.config = config;
        id = config["id"]!.GetValue<string>(); origin = new Uri(config["origin"]!.GetValue<string>()).GetLeftPart(UriPartial.Authority);
        keyHash = KeyHash(config);
        accessToken = config["token"]!.GetValue<string>();
        diagnosticTokens = [accessToken];
        clock = () => (double)Stopwatch.GetTimestamp() / Stopwatch.Frequency;
        canMigrate = () => true;
        sign = signer ?? LocalSigner(config, origin, id);
        save = _ => { };
        if (stateDirectory is not null)
        {
            string statePath = Path.Combine(stateDirectory, "device-token.bin");
            long stamp = 0;
            readChangedState = () => {
                var file = new FileInfo(statePath);
                if (!file.Exists) return null;
                if (file.Length > 65536 || (file.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Unsafe device token state.");
                long changed = file.LastWriteTimeUtc.Ticks;
                if (changed == stamp) return null;
                var state = LocalStore.ReadProtected(statePath); stamp = changed; return state;
            };
            if (File.Exists(statePath))
            {
                try { AdoptState(readChangedState()); } catch (Exception e) when (e is InvalidDataException or IOException or CryptographicException or System.Text.Json.JsonException or System.ComponentModel.Win32Exception) { }
            }
            save = state => { LocalStore.SaveProtected(statePath, state); stamp = File.GetLastWriteTimeUtc(statePath).Ticks; };
            acquireRenewalLease = async token => {
                // Several HTTP clients in one worker share this instance; the
                // file lease also serializes a restarted worker with its predecessor.
                double deadline = clock() + 3;
                while (true)
                {
                    token.ThrowIfCancellationRequested();
                    try { return new FileStream(Path.Combine(stateDirectory, "device-token.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
                    catch (IOException) when (clock() < deadline) { await Task.Delay(50, token); }
                }
            };
        }
        var proofHttp = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { BaseAddress = new Uri(origin), Timeout = TimeSpan.FromSeconds(15) };
        AddClientHeaders(proofHttp);
        post = (path, body, token) => AgentHttpTransport.PostAsync(proofHttp, path, body, token, config);
    }

    // Test seam exercises the same transition and signing code without DPAPI,
    // network access, Windows APIs or sleep-based token expiry tests.
    internal DeviceTokenClient(JsonObject config, JsonObject? state, Func<bool> canMigrate,
        Func<string, JsonObject, CancellationToken, Task<JsonObject>> post, Action<JsonObject> save, Func<double> clock,
        Func<JsonObject?>? readChangedState = null, Func<CancellationToken, Task<IDisposable?>>? acquireRenewalLease = null,
        Func<JsonObject, CancellationToken, Task<string>>? signer = null)
    {
        this.config = config; this.canMigrate = canMigrate; this.post = post; this.save = save; this.clock = clock;
        id = config["id"]!.GetValue<string>(); origin = new Uri(config["origin"]!.GetValue<string>()).GetLeftPart(UriPartial.Authority); keyHash = KeyHash(config);
        sign = signer ?? LocalSigner(config, origin, id);
        accessToken = config["token"]!.GetValue<string>();
        diagnosticTokens = [accessToken];
        if (readChangedState is not null) this.readChangedState = readChangedState;
        if (acquireRenewalLease is not null) this.acquireRenewalLease = acquireRenewalLease;
        AdoptState(state);
    }

    private static string KeyHash(JsonObject config)
    {
        if (config["privateKey"]?.GetValue<string>() is string key) return Fingerprint(key);
        string hash = config["keyHash"]?.GetValue<string>() ?? "";
        return hash.Length == 64 && hash.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f') ? hash : throw new InvalidDataException("Missing device key fingerprint.");
    }

    // Signs only a challenge that names this portal, device and renewal
    // purpose. The broker exposes exactly this function to the worker, so the
    // device key never becomes a general signing oracle.
    internal static string SignChallenge(JsonObject config, JsonObject challenge)
    {
        string origin = new Uri(config["origin"]!.GetValue<string>()).GetLeftPart(UriPartial.Authority), message = ValidateChallenge(challenge, origin, config["id"]!.GetValue<string>());
        using var rsa = LocalStore.ReadRsa(config["privateKey"]!.GetValue<string>());
        return Convert.ToBase64String(rsa.SignData(Encoding.UTF8.GetBytes(message), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
    }
    private static Func<JsonObject, CancellationToken, Task<string>> LocalSigner(JsonObject config, string origin, string id) =>
        (challenge, _) => config["privateKey"] is null ? throw new InvalidOperationException("No device key signer is available.") : Task.FromResult(SignChallenge(config, challenge));

    private static DeviceTokenClient Get(JsonObject config, string? stateDirectory, Func<JsonObject, CancellationToken, Task<string>>? signer)
    {
        if (stateDirectory is null) return new DeviceTokenClient(config, null, signer);
        string key = Path.GetFullPath(stateDirectory) + "\n" + config["id"]!.GetValue<string>() + "\n" + config["origin"]!.GetValue<string>() + "\n" + KeyHash(config);
        return clients.GetOrAdd(key, _ => new DeviceTokenClient(config, stateDirectory, signer));
    }
    // stateDirectory null: an in-memory client (installer). Otherwise clients
    // with the same directory and identity share one renewal state.
    internal static HttpClient CreateHttp(JsonObject config, TimeSpan timeout, string? stateDirectory, Func<JsonObject, CancellationToken, Task<string>>? signer = null, bool baseAddress = false)
    {
        bool keyBound = config["privateKey"] is not null || config["keyHash"] is not null;
        HttpMessageHandler handler = new HttpClientHandler { AllowAutoRedirect = false };
        if (keyBound) handler = new DeviceAuthorizationHandler(Get(config, stateDirectory, signer)) { InnerHandler = handler };
        var http = new HttpClient(handler) { Timeout = timeout };
        if (baseAddress) http.BaseAddress = new Uri(config["origin"]!.GetValue<string>());
        if (!keyBound) http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", config["token"]!.GetValue<string>());
        AddClientHeaders(http); return http;
    }
    private static void AddClientHeaders(HttpClient http)
    {
        http.DefaultRequestHeaders.UserAgent.ParseAdd("ServerDesk/" + Program.Version);
    }
    internal static string Fingerprint(string xml)
    {
        using var rsa = LocalStore.ReadRsa(xml);
        return Convert.ToHexString(SHA256.HashData(rsa.ExportSubjectPublicKeyInfo())).ToLowerInvariant();
    }
    private static bool ValidToken(string? value) => value is { Length: 64 } && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    internal static IEnumerable<string> SensitiveTokens() => clients.Values.SelectMany(client => Volatile.Read(ref client.diagnosticTokens));
    private void RememberToken(string value) => Volatile.Write(ref diagnosticTokens, new[] { value }.Concat(diagnosticTokens).Distinct(StringComparer.Ordinal).Take(4).ToArray());

    internal async Task<string> AccessAsync(CancellationToken token)
    {
        await renewal.WaitAsync(token);
        try
        {
            AdoptState(readChangedState());
            double time = clock();
            if (!migrated && !canMigrate()) return accessToken;
            if (migrated && time < refreshAt || time < retryAt && (!migrated || time < validUntil)) return accessToken;
            try
            {
                using var lease = await acquireRenewalLease(token);
                AdoptState(readChangedState()); time = clock();
                if (migrated && time < refreshAt) return accessToken;
                var challenge = await post("/api/agent/token/challenge", new JsonObject { ["serverId"] = id }, token);
                ValidateChallenge(challenge, origin, id);
                string signature = await sign(challenge, token);
                var reply = await post("/api/agent/token/renew", new JsonObject {
                    ["serverId"] = id, ["challengeId"] = challenge["challengeId"]!.DeepClone(), ["nonce"] = challenge["nonce"]!.DeepClone(),
                    ["expiresAt"] = challenge["expiresAt"]!.DeepClone(), ["proof"] = challenge["proof"]!.DeepClone(), ["signature"] = signature
                }, token);
                string next = reply["token"]?.GetValue<string>() ?? "";
                int seconds = reply["expiresIn"]?.GetValue<int>() ?? 0;
                if (reply["serverId"]?.GetValue<string>() != id || reply["tokenMode"]?.GetValue<string>() != "key-bound" || !ValidToken(next) || seconds is < 300 or > 900 || !DateTimeOffset.TryParse(reply["expiresAt"]?.GetValue<string>(), out _)) throw new InvalidDataException("Invalid device access token response");
                var state = new JsonObject { ["serverId"] = id, ["origin"] = origin, ["keyHash"] = keyHash, ["token"] = next, ["expiresAt"] = reply["expiresAt"]!.DeepClone(), ["savedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["expiresIn"] = seconds, ["mode"] = "key-bound" };
                // Commit durable state before any operation can use the bearer.
                // A lost response or failed disk write is recovered with a new
                // signed challenge, never with an indefinite renewal bearer.
                save(state);
                accessToken = next; RememberToken(next); migrated = true; time = clock();
                validUntil = time + seconds - 20; refreshAt = time + seconds - 300; retryAt = 0;
                return accessToken;
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
            catch (Exception e) when (CanKeepAccess(e, clock()))
            {
                // Proactive refresh failures must not terminate a working
                // terminal or transfer while its existing token is still live.
                retryAt = clock() + 30; return accessToken;
            }
        }
        finally { renewal.Release(); }
    }
    private void AdoptState(JsonObject? state)
    {
        if (state is null || state["serverId"]?.GetValue<string>() != id || state["origin"]?.GetValue<string>() != origin || state["keyHash"]?.GetValue<string>() != keyHash || !ValidToken(state["token"]?.GetValue<string>())) return;
        accessToken = state["token"]!.GetValue<string>(); RememberToken(accessToken); migrated = true; refreshAt = validUntil = retryAt = 0;
        if (DateTimeOffset.TryParse(state["savedAt"]?.GetValue<string>(), out var saved) && state["expiresIn"]?.GetValue<int>() is >= 300 and <= 900)
        {
            double age = (DateTimeOffset.UtcNow - saved).TotalSeconds, seconds = state["expiresIn"]!.GetValue<int>();
            // A backward clock correction triggers a new proof. A stale bearer
            // accepted locally is still checked against server expiry; recovery
            // below also covers a lost state write after successful issuance.
            if (age >= 0 && age < seconds - 20) { validUntil = clock() + seconds - age - 20; refreshAt = clock() + seconds - age - 300; }
        }
    }
    internal async Task<string> RecoverAsync(string rejectedToken, CancellationToken token)
    {
        await renewal.WaitAsync(token);
        try
        {
            AdoptState(readChangedState());
            if (accessToken == rejectedToken) { migrated = true; refreshAt = validUntil = retryAt = 0; }
        }
        finally { renewal.Release(); }
        return await AccessAsync(token);
    }
    private bool CanKeepAccess(Exception e, double time)
    {
        if (e is InvalidDataException or CryptographicException or UnauthorizedAccessException) return false;
        if (e is HttpRequestException h && h.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden) return false;
        return !migrated || time < validUntil;
    }
    internal static string ValidateChallenge(JsonObject challenge, string origin, string id)
    {
        string challengeId = challenge["challengeId"]?.GetValue<string>() ?? "", nonce = challenge["nonce"]?.GetValue<string>() ?? "", proof = challenge["proof"]?.GetValue<string>() ?? "";
        long expires = challenge["expiresAt"]?.GetValue<long>() ?? 0;
        if (challenge["version"]?.GetValue<int>() != 1 || challenge["serverId"]?.GetValue<string>() != id || challenge["origin"]?.GetValue<string>() != origin || challenge["algorithm"]?.GetValue<string>() != "RS256" || !Guid.TryParseExact(challengeId, "D", out _) || nonce.Length != 43 || proof.Length != 43 || !nonce.Concat(proof).All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')) throw new InvalidDataException("Invalid device renewal challenge");
        // Server date avoids depending on a Windows clock which may be skewed.
        if (!DateTimeOffset.TryParse(challenge["_httpServerDate"]?.GetValue<string>(), out var date)) throw new InvalidDataException("Missing device renewal server date");
        long remaining = expires - date.ToUnixTimeSeconds();
        if (remaining is <= 0 or > 120) throw new InvalidDataException("Expired or excessive device renewal challenge");
        string message = "ServerDesk device access token v1\n" + origin + "\n" + id + "\n" + challengeId + "\n" + nonce + "\n" + expires.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (challenge["message"]?.GetValue<string>() != message) throw new InvalidDataException("Device renewal message is not bound to this portal and device");
        return message;
    }
    internal sealed class DeviceAuthorizationHandler(DeviceTokenClient client) : DelegatingHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            // Never mutate DefaultRequestHeaders while parallel telemetry,
            // terminal and file requests are running.
            string bearer = await client.AccessAsync(token);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
            request.Headers.Remove("X-ServerDesk-Device-Id"); request.Headers.Add("X-ServerDesk-Device-Id", client.id);
            var response = await base.SendAsync(request, token);
            if (response.StatusCode != HttpStatusCode.Forbidden || response.Content.Headers.ContentType?.MediaType != "application/json") return response;
            byte[] error;
            try { error = await AgentHttpTransport.ReadBoundedAsync(response.Content, 8192, token); }
            catch (InvalidDataException) { return response; }
            var headers = response.Content.Headers.ToArray(); response.Content.Dispose(); response.Content = new ByteArrayContent(error);
            foreach (var header in headers) response.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
            string? code = null;
            try { if ((JsonNode.Parse(error) as JsonObject)?["code"] is JsonValue value) value.TryGetValue<string>(out code); }
            catch (System.Text.Json.JsonException) { return response; }
            if (code != "DEVICE_TOKEN_REJECTED") return response;
            // This server code is reserved for initial authentication, before
            // any side effect. Generic errors and post-dispatch checks are never
            // replayed. All agent request bodies are bounded JSON/chunk arrays.
            using var retry = new HttpRequestMessage(request.Method, request.RequestUri) { Version = request.Version, VersionPolicy = request.VersionPolicy };
            foreach (var header in request.Headers) retry.Headers.TryAddWithoutValidation(header.Key, header.Value);
            if (request.Content is not null)
            {
                byte[] body = await AgentHttpTransport.ReadBoundedAsync(request.Content, 2_097_152, token);
                retry.Content = new ByteArrayContent(body);
                foreach (var header in request.Content.Headers) retry.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }
            retry.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await client.RecoverAsync(bearer, token));
            response.Dispose(); return await base.SendAsync(retry, token);
        }
    }
}
