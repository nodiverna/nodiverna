using System.Globalization;
using System.Management;
using System.Text.Json.Nodes;
using static ServerDesk.Agent.WindowsManagement;

namespace ServerDesk.Agent;

// The BitLocker state of every volume (docs/v3-health-signals.md) from
// Win32_EncryptableVolume. The agent calls only the four read methods in
// ReadMethods plus GetKeyProtectorType; it never calls a method that returns
// or escrows a secret, and it sends no protector IDs. Windows does not record
// when protection was suspended, so the agent keeps the time it first saw the
// suspension in a local state file and clears it once protection is back on.
internal sealed record BitLockerVolumeRow(string Path, string? DriveLetter, uint? VolumeType);

internal sealed class BitLockerUnavailableException(string message) : Exception(message);

internal interface IBitLockerProvider
{
    /// <summary>The encryptable volumes. Throws BitLockerUnavailableException when the namespace or class is missing.</summary>
    IReadOnlyList<BitLockerVolumeRow> Volumes();
    (uint? Status, uint? Percent) ConversionStatus(string path);
    uint? ProtectionStatus(string path);
    uint? EncryptionMethod(string path);
    IReadOnlyList<string> KeyProtectorIds(string path);
    uint? KeyProtectorType(string path, string id);
}

internal sealed class NativeBitLocker(string statePath, IBitLockerProvider? provider = null, Func<DateTimeOffset>? clock = null)
{
    internal const int IntervalSeconds = 300;
    internal const int DeadlineSeconds = 20;
    internal const int MaximumVolumes = 64;
    private readonly IBitLockerProvider volumes = provider ?? new WmiBitLockerProvider();
    private readonly Func<DateTimeOffset> now = clock ?? (() => DateTimeOffset.UtcNow);
    private readonly object gate = new();

    internal JsonObject Collect()
    {
        lock (gate)
        {
            var at = now();
            JsonObject Unavailable(string reason) => new() { ["bitlocker"] = new JsonObject { ["available"] = false, ["reason"] = reason, ["collectedAt"] = at.ToString("O"), ["volumes"] = new JsonArray() } };
            IReadOnlyList<BitLockerVolumeRow> rows;
            try { rows = volumes.Volumes(); }
            catch (BitLockerUnavailableException) { return Unavailable("not-supported"); }
            catch (UnauthorizedAccessException) { return Unavailable("access-denied"); }
            catch (ManagementException error) when (error.ErrorCode is ManagementStatus.InvalidNamespace or ManagementStatus.InvalidClass or ManagementStatus.NotFound) { return Unavailable("not-supported"); }
            catch (ManagementException error) when (error.ErrorCode == ManagementStatus.AccessDenied) { return Unavailable("access-denied"); }
            catch (Exception error) when (error is not OutOfMemoryException) { return Unavailable("error"); }
            var state = ReadState(); var seen = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var result = new JsonArray();
            foreach (var row in rows.Take(MaximumVolumes))
            {
                string conversion = "unknown", protection = "unknown", method = "unknown"; uint? percent = null;
                var protectors = new List<string>();
                try { var (status, value) = volumes.ConversionStatus(row.Path); conversion = Conversion(status); percent = value is <= 100 ? value : null; } catch (Exception error) when (error is not OutOfMemoryException) { }
                try { protection = Protection(volumes.ProtectionStatus(row.Path), conversion); } catch (Exception error) when (error is not OutOfMemoryException) { }
                try { method = Method(volumes.EncryptionMethod(row.Path)); } catch (Exception error) when (error is not OutOfMemoryException) { }
                try
                {
                    foreach (string id in volumes.KeyProtectorIds(row.Path).Take(32))
                    {
                        string kind = Protector(volumes.KeyProtectorType(row.Path, id));
                        if (!protectors.Contains(kind)) protectors.Add(kind);
                    }
                }
                catch (Exception error) when (error is not OutOfMemoryException) { }
                string? drive = Drive(row.DriveLetter);
                string key = drive ?? row.Path;
                string? since = null;
                if (protection == "suspended")
                {
                    since = state.TryGetValue(key, out var stored) && DateTimeOffset.TryParse(stored, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed) ? parsed.ToUniversalTime().ToString("O") : at.ToString("O");
                    seen[key] = since;
                }
                result.Add(new JsonObject
                {
                    ["drive"] = drive, ["volumeType"] = row.VolumeType switch { 0 => "os", 2 => "removable", _ => "fixed" },
                    ["conversion"] = conversion, ["percent"] = percent is null ? null : JsonValue.Create((double)percent.Value), ["protection"] = protection, ["method"] = method,
                    ["protectors"] = new JsonArray(protectors.Select(kind => (JsonNode)JsonValue.Create(kind)!).ToArray()), ["suspendedSince"] = since
                });
            }
            // Keep only the suspensions that still hold; a volume back on loses its time.
            if (!SameState(state, seen)) WriteState(seen);
            return new JsonObject { ["bitlocker"] = new JsonObject { ["available"] = true, ["collectedAt"] = at.ToString("O"), ["volumes"] = result } };
        }
    }

    internal static string Conversion(uint? status) => status switch { 0 => "decrypted", 1 => "encrypted", 2 => "encrypting", 3 => "decrypting", 4 => "paused-encrypting", 5 => "paused-decrypting", _ => "unknown" };
    // Suspended: the volume is (being) encrypted while its protection is off.
    internal static string Protection(uint? status, string conversion) => status switch
    {
        0 when conversion is "encrypted" or "encrypting" or "paused-encrypting" => "suspended",
        0 => "off", 1 => "on", _ => "unknown"
    };
    internal static string Method(uint? method) => method switch { 0 => "none", 1 => "aes-128-diffuser", 2 => "aes-256-diffuser", 3 => "aes-128", 4 => "aes-256", 5 => "hardware", 6 => "xts-aes-128", 7 => "xts-aes-256", _ => "unknown" };
    internal static string Protector(uint? type) => type switch
    {
        1 => "tpm", 2 => "external-key", 3 => "numerical-password", 4 => "tpm-pin", 5 => "tpm-startup-key", 6 => "tpm-pin-startup-key",
        7 => "public-key", 8 => "passphrase", 9 => "tpm-certificate", 10 => "ad-account", _ => "unknown"
    };
    private static string? Drive(string? letter) => letter is { Length: 2 } && char.IsAsciiLetter(letter[0]) && letter[1] == ':' ? letter.ToUpperInvariant() : null;

    private Dictionary<string, string> ReadState()
    {
        try
        {
            if (!File.Exists(statePath) || new FileInfo(statePath).Length > 65536) return new(StringComparer.OrdinalIgnoreCase);
            var parsed = JsonNode.Parse(File.ReadAllText(statePath)) as JsonObject;
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in parsed ?? new JsonObject()) if (pair.Value is JsonValue value && value.TryGetValue<string>(out var text) && result.Count < MaximumVolumes) result[pair.Key] = text;
            return result;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Text.Json.JsonException) { return new(StringComparer.OrdinalIgnoreCase); }
    }
    private void WriteState(Dictionary<string, string> state)
    {
        try { var json = new JsonObject(); foreach (var pair in state) json[pair.Key] = pair.Value; LocalStore.Json(statePath, json); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }
    private static bool SameState(Dictionary<string, string> a, Dictionary<string, string> b) => a.Count == b.Count && a.All(pair => b.TryGetValue(pair.Key, out var value) && value == pair.Value);
}

// Read-only WMI access to root\cimv2\Security\MicrosoftVolumeEncryption.
internal sealed class WmiBitLockerProvider : IBitLockerProvider
{
    private const string Namespace = @"root\cimv2\Security\MicrosoftVolumeEncryption";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(4);
    // The only methods this provider ever invokes.
    internal static readonly string[] ReadMethods = ["GetConversionStatus", "GetProtectionStatus", "GetEncryptionMethod", "GetKeyProtectors", "GetKeyProtectorType"];

    public IReadOnlyList<BitLockerVolumeRow> Volumes()
    {
        List<Dictionary<string, object?>> rows;
        try { rows = Query(Namespace, "SELECT DeviceID,DriveLetter,VolumeType FROM Win32_EncryptableVolume", NativeBitLocker.MaximumVolumes, Timeout); }
        catch (ManagementException error) when (error.ErrorCode is ManagementStatus.InvalidNamespace or ManagementStatus.InvalidClass or ManagementStatus.NotFound) { throw new BitLockerUnavailableException("BitLocker is not available."); }
        return rows.Select(row => new BitLockerVolumeRow(Convert.ToString(row.GetValueOrDefault("__PATH"), CultureInfo.InvariantCulture) ?? "", Text(row, "DriveLetter", 8) is { Length: > 0 } drive ? drive : null, uint.TryParse(Text(row, "VolumeType", 12), NumberStyles.Integer, CultureInfo.InvariantCulture, out uint type) ? type : null)).Where(row => row.Path.Length > 0).ToList();
    }

    private static Dictionary<string, object?> Call(string path, string method, Dictionary<string, object?>? parameters = null)
    {
        if (!ReadMethods.Contains(method, StringComparer.Ordinal)) throw new InvalidOperationException("This BitLocker method is not allowed.");
        var output = Invoke(Namespace, path, method, parameters, Timeout);
        // A failing method (non-zero HRESULT) gives an unknown value, never a guess.
        if (output.TryGetValue("ReturnValue", out var value) && Convert.ToInt64(value, CultureInfo.InvariantCulture) != 0) throw new InvalidDataException("BitLocker method failed.");
        return output;
    }
    private static uint? Unsigned(Dictionary<string, object?> row, string name) => row.TryGetValue(name, out var value) && value is not null ? Convert.ToUInt32(value, CultureInfo.InvariantCulture) : null;

    public (uint? Status, uint? Percent) ConversionStatus(string path) { var output = Call(path, "GetConversionStatus"); return (Unsigned(output, "ConversionStatus"), Unsigned(output, "EncryptionPercentage")); }
    public uint? ProtectionStatus(string path) => Unsigned(Call(path, "GetProtectionStatus"), "ProtectionStatus");
    public uint? EncryptionMethod(string path) => Unsigned(Call(path, "GetEncryptionMethod"), "EncryptionMethod");
    public IReadOnlyList<string> KeyProtectorIds(string path) => Call(path, "GetKeyProtectors").GetValueOrDefault("VolumeKeyProtectorID") is object[] ids ? ids.Select(id => Convert.ToString(id, CultureInfo.InvariantCulture) ?? "").Where(id => id.Length > 0).Take(32).ToList() : [];
    public uint? KeyProtectorType(string path, string id) => Unsigned(Call(path, "GetKeyProtectorType", new Dictionary<string, object?> { ["VolumeKeyProtectorID"] = id }), "KeyProtectorType");
}
