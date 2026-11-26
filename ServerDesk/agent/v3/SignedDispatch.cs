using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// The broker executes nothing the unprivileged worker merely asserts. Every
// job, transfer plan, drift policy and terminal lease carries the portal's
// ECDSA P-256 signature over the exact payload bytes. The broker parses only
// verified bytes, so no canonical JSON form is needed on either side. The key
// is pinned at installation in the broker-only config.bin and is separate
// from the release publisher key.
internal sealed class DispatchVerifier
{
    internal static readonly TimeSpan ClockSkew = TimeSpan.FromMinutes(2);
    internal static readonly TimeSpan JobLifetime = TimeSpan.FromMinutes(15);
    internal static readonly TimeSpan TerminalLifetime = TimeSpan.FromMinutes(2);
    internal const int MaximumPayloadBytes = 786_432;
    private readonly ECDsa key;
    private readonly string deviceId;
    private readonly Func<DateTimeOffset> now;

    internal DispatchVerifier(string publicKey, string deviceId, Func<DateTimeOffset>? now = null)
    {
        key = Import(publicKey); this.deviceId = deviceId; this.now = now ?? (() => DateTimeOffset.UtcNow);
    }

    // The registration carries base64 SubjectPublicKeyInfo DER. Only P-256 is
    // accepted so a misconfigured RSA or weaker curve key fails at install time.
    internal static string ValidateKey(string value)
    {
        using var imported = Import(value);
        return Convert.ToBase64String(imported.ExportSubjectPublicKeyInfo());
    }

    private static ECDsa Import(string value)
    {
        if (value.Length is < 80 or > 400) throw new InvalidDataException("Invalid job signing key.");
        var ecdsa = ECDsa.Create();
        try
        {
            ecdsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(value), out int read);
            var curve = ecdsa.ExportParameters(false).Curve;
            if (read != Convert.FromBase64String(value).Length || ecdsa.KeySize != 256 || curve.Oid?.Value != "1.2.840.10045.3.1.7") throw new InvalidDataException("The job signing key must be an ECDSA P-256 public key.");
            return ecdsa;
        }
        catch (Exception e) when (e is FormatException or CryptographicException) { ecdsa.Dispose(); throw new InvalidDataException("Invalid job signing key.", e); }
        catch { ecdsa.Dispose(); throw; }
    }

    internal JsonObject Verify(JsonNode? envelope, string kind, TimeSpan maximumLifetime)
    {
        if (envelope is not JsonObject box || box.Count != 2 || box["payload"] is not JsonValue payloadValue || !payloadValue.TryGetValue<string>(out string? payload) || box["signature"] is not JsonValue signatureValue || !signatureValue.TryGetValue<string>(out string? signatureText)) throw new InvalidDataException("Unsigned or malformed portal dispatch.");
        byte[] bytes = Encoding.UTF8.GetBytes(payload);
        if (bytes.Length > MaximumPayloadBytes || signatureText.Length > 128) throw new InvalidDataException("Oversized portal dispatch.");
        byte[] signature;
        try { signature = Convert.FromBase64String(signatureText); } catch (FormatException) { throw new InvalidDataException("Malformed portal dispatch signature."); }
        if (signature.Length != 64 || !key.VerifyData(bytes, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) throw new CryptographicException("The dispatch was not signed by this device's portal job key.");
        var data = JsonNode.Parse(bytes) as JsonObject ?? throw new InvalidDataException("Invalid signed dispatch payload.");
        if (Integer(data, "v") != 1 || Text(data, "kind") != kind) throw new InvalidDataException("Signed dispatch has an unexpected kind or version.");
        if (!Guid.TryParse(Text(data, "deviceId"), out var target) || !Guid.TryParse(deviceId, out var own) || target != own) throw new InvalidDataException("Signed dispatch belongs to a different device.");
        long issued = Integer(data, "iat"), expires = Integer(data, "exp"), current = now().ToUnixTimeSeconds();
        if (expires <= issued || expires - issued > (long)maximumLifetime.TotalSeconds) throw new InvalidDataException("Signed dispatch has an invalid lifetime.");
        if (issued > current + (long)ClockSkew.TotalSeconds) throw new InvalidDataException("Signed dispatch was issued in the future; check the device clock.");
        if (expires < current - (long)ClockSkew.TotalSeconds) throw new InvalidDataException("Signed dispatch has expired; check the device clock.");
        return data;
    }

    private static string Text(JsonObject data, string name) => data[name] is JsonValue value && value.TryGetValue<string>(out string? text) ? text ?? "" : "";
    private static long Integer(JsonObject data, string name) => data[name] is JsonValue value && value.TryGetValue<long>(out long number) ? number : -1;

    // A terminal lease authorizes exactly the listed sessions until its expiry.
    // Commands for any other session are turned into closures, and every
    // expiry is clamped to the lease so a stalled or replaying worker cannot
    // keep a shell open beyond the portal's latest signed decision.
    internal JsonArray ApplyTerminalLease(JsonArray commands, JsonNode? lease, Action<string> log)
    {
        HashSet<string> allowed = new(StringComparer.Ordinal); DateTimeOffset? until = null;
        if (lease is not null)
        {
            try
            {
                var data = Verify(lease, "terminal", TerminalLifetime);
                foreach (var item in data["sessions"]?.AsArray() ?? new JsonArray()) if (item is JsonValue value && value.TryGetValue<string>(out string? id) && Guid.TryParse(id, out var parsed)) allowed.Add(parsed.ToString());
                until = DateTimeOffset.FromUnixTimeSeconds(data["exp"]!.GetValue<long>());
            }
            catch (Exception e) { log("Terminal lease rejected: " + e.Message); }
        }
        var result = new JsonArray();
        foreach (var item in commands)
        {
            if (item is not JsonObject command) continue;
            var copy = command.DeepClone().AsObject();
            string id = Guid.TryParse(copy["id"]?.GetValue<string>(), out var parsed) ? parsed.ToString() : "";
            bool opening = copy["state"]?.GetValue<string>() is "opening" or "open";
            if (opening && (until is null || !allowed.Contains(id))) { result.Add(new JsonObject { ["id"] = copy["id"]?.DeepClone(), ["state"] = "closed", ["input"] = new JsonArray(), ["outputAck"] = copy["outputAck"]?.DeepClone() ?? 0 }); continue; }
            if (opening && until is DateTimeOffset limit)
            {
                var requested = DateTimeOffset.TryParse(copy["expiresAt"]?.GetValue<string>(), out var date) ? date : limit;
                copy["expiresAt"] = (requested < limit ? requested : limit).ToString("O");
            }
            result.Add(copy);
        }
        return result;
    }
}
