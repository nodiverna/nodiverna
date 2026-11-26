using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class DesiredStateJobs
{
    internal static readonly string[] Actions = ["desired-state-test", "desired-state-apply"];
    private static JsonObject OpenConfiguration(JsonObject box, string privateXml)
    {
        using RSA rsa = LocalStore.ReadRsa(privateXml);
        byte[] key = rsa.Decrypt(Convert.FromBase64String(box["key"]!.GetValue<string>()), RSAEncryptionPadding.OaepSHA1);
        try
        {
            byte[] iv = Convert.FromBase64String(box["iv"]!.GetValue<string>()), data = Convert.FromBase64String(box["data"]!.GetValue<string>()), mac = Convert.FromBase64String(box["mac"]!.GetValue<string>());
            if (key.Length != 64 || iv.Length != 16 || mac.Length != 32 || data.Length == 0 || data.Length > 400000 || data.Length % 16 != 0) throw new AgentMessageException("AGENT_DESIRED_STATE_ENVELOPE_INVALID");
            byte[] signed = [.. iv, .. data];
            if (!CryptographicOperations.FixedTimeEquals(HMACSHA256.HashData(key.AsSpan(32), signed), mac)) throw new AgentMessageException("AGENT_DESIRED_STATE_INTEGRITY_FAILED");
            using var aes = Aes.Create(); aes.Key = key.AsSpan(0, 32).ToArray(); aes.IV = iv;
            byte[] plaintext = aes.DecryptCbc(data, iv);
            try { return JsonNode.Parse(plaintext)!.AsObject(); }
            finally { CryptographicOperations.ZeroMemory(plaintext); }
        }
        finally { CryptographicOperations.ZeroMemory(key); }
    }
    internal static async Task<JsonObject> ExecuteAsync(string root, string package, JsonObject config, JsonObject job, CancellationToken token)
    {
        string action = job["action"]!.GetValue<string>(), id = job["id"]!.GetValue<string>();
        if (!Guid.TryParse(id, out _) || !Actions.Contains(action)) throw new AgentMessageException("AGENT_DESIRED_STATE_JOB_INVALID");
        if (LocalStore.ReadProtected(Path.Combine(root, "config.bin"))["mode"]?.GetValue<string>() != "Management") throw new AgentMessageException("AGENT_DESIRED_STATE_MANAGEMENT_REQUIRED");
        var p = job["parameters"]!.AsObject();
        string content = OpenConfiguration(p["configuration"]!.AsObject(), config["privateKey"]!.GetValue<string>())["content"]!.GetValue<string>();
        byte[] contentBytes = Encoding.UTF8.GetBytes(content);
        try
        {
            string digest = Convert.ToHexStringLower(SHA256.HashData(contentBytes));
            if (contentBytes.Length is < 1 or > 65536 || content.Contains('\0') || digest != p["contentSha256"]?.GetValue<string>()) throw new AgentMessageException("AGENT_DESIRED_STATE_CONTENT_MISMATCH");
            int seconds = Math.Clamp(p["timeoutSeconds"]?.GetValue<int>() ?? 900, 30, 1800);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromSeconds(seconds));
            var data = await NativeDesiredState.ExecuteAsync(root, id, content, p, action == "desired-state-apply", TimeSpan.FromSeconds(seconds), deadline.Token);
            data["versionId"] = p["versionId"]?.DeepClone(); data["sha256"] = digest;
            return AgentMessages.Write(new JsonObject { ["id"] = id, ["ok"] = true, ["data"] = data }, data["compliant"]?.GetValue<bool>() == true ? "AGENT_DESIRED_STATE_COMPLIANT" : "AGENT_DESIRED_STATE_DRIFT");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(contentBytes);
        }
    }
}
