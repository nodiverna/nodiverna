using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// --bitlocker-self-test: simulated WMI answers for every conversion, protection,
// method and protector code, the suspension time kept across runs, missing
// BitLocker and denied access. The fake provider also offers secret-looking
// values; none of them may reach the result.
internal static class NativeBitLockerTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("BitLocker regression: " + message); }
    internal static int RunSelfTest() { try { Run(); Console.WriteLine("BitLocker self-test passed."); return 0; } catch (Exception error) { Console.Error.WriteLine(error); return 1; } }

    private const string Secret = "123456-654321-111111-222222-333333-444444-555555-666666";
    private sealed class FakeProvider : IBitLockerProvider
    {
        internal List<BitLockerVolumeRow> Rows = [];
        internal Dictionary<string, (uint? Conversion, uint? Percent, uint? Protection, uint? Method, (string Id, uint Type)[] Protectors)> State = [];
        internal Exception? Failure;
        public IReadOnlyList<BitLockerVolumeRow> Volumes() => Failure is null ? Rows : throw Failure;
        public (uint? Status, uint? Percent) ConversionStatus(string path) => (State[path].Conversion, State[path].Percent);
        public uint? ProtectionStatus(string path) => State[path].Protection;
        public uint? EncryptionMethod(string path) => State[path].Method;
        public IReadOnlyList<string> KeyProtectorIds(string path) => State[path].Protectors.Select(p => p.Id).ToList();
        public uint? KeyProtectorType(string path, string id) => State[path].Protectors.First(p => p.Id == id).Type;
    }

    private static void Run()
    {
        Check(Enumerable.Range(0, 7).Select(i => NativeBitLocker.Conversion((uint)i)).SequenceEqual(new[] { "decrypted", "encrypted", "encrypting", "decrypting", "paused-encrypting", "paused-decrypting", "unknown" }) && NativeBitLocker.Conversion(null) == "unknown", "conversion codes.");
        Check(NativeBitLocker.Protection(1, "encrypted") == "on" && NativeBitLocker.Protection(0, "decrypted") == "off" && NativeBitLocker.Protection(0, "encrypted") == "suspended" && NativeBitLocker.Protection(0, "encrypting") == "suspended" && NativeBitLocker.Protection(0, "paused-encrypting") == "suspended" && NativeBitLocker.Protection(0, "decrypting") == "off" && NativeBitLocker.Protection(2, "encrypted") == "unknown" && NativeBitLocker.Protection(null, "encrypted") == "unknown", "protection codes and suspended detection.");
        Check(Enumerable.Range(0, 9).Select(i => NativeBitLocker.Method((uint)i)).SequenceEqual(new[] { "none", "aes-128-diffuser", "aes-256-diffuser", "aes-128", "aes-256", "hardware", "xts-aes-128", "xts-aes-256", "unknown" }), "method codes.");
        Check(Enumerable.Range(0, 12).Select(i => NativeBitLocker.Protector((uint)i)).SequenceEqual(new[] { "unknown", "tpm", "external-key", "numerical-password", "tpm-pin", "tpm-startup-key", "tpm-pin-startup-key", "public-key", "passphrase", "tpm-certificate", "ad-account", "unknown" }), "protector codes.");

        string folder = Path.Combine(Path.GetTempPath(), "serverdesk-bitlocker-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            string state = Path.Combine(folder, "bitlocker-state.json");
            var provider = new FakeProvider();
            provider.Rows = [new(@"\\HOST\root\cimv2\Security\MicrosoftVolumeEncryption:Win32_EncryptableVolume.DeviceID=""\\?\Volume{1}\""", "c:", 0), new(@"Volume{2}", "D:", 1), new(@"Volume{3}", null, 2), new(@"Volume{4}", "E:", 1)];
            provider.State[provider.Rows[0].Path] = (1, 100, 1, 7, [("{" + Secret + "}", 1), ("{AAAA-BBBB}", 3), ("{CCCC}", 3)]);
            provider.State["Volume{2}"] = (2, 42, 0, 6, [("{DDDD}", 3)]);
            provider.State["Volume{3}"] = (0, 0, 0, 0, []);
            provider.State["Volume{4}"] = (1, 100, 1, 4, [("{EEEE}", 4), ("{FFFF}", 2), ("{GGGG}", 5), ("{HHHH}", 6), ("{IIII}", 7), ("{JJJJ}", 8), ("{KKKK}", 9), ("{LLLL}", 10), ("{MMMM}", 0)]);
            var first = DateTimeOffset.Parse("2026-10-20T08:00:00Z"); var clock = first;
            var result = new NativeBitLocker(state, provider, () => clock).Collect()["bitlocker"]!.AsObject();
            var volumes = result["volumes"]!.AsArray();
            Check(result["available"]!.GetValue<bool>() && result["reason"] is null && volumes.Count == 4, "four volumes, available.");
            Check(volumes[0]!["drive"]!.GetValue<string>() == "C:" && volumes[0]!["volumeType"]!.GetValue<string>() == "os" && volumes[0]!["conversion"]!.GetValue<string>() == "encrypted" && volumes[0]!["protection"]!.GetValue<string>() == "on" && volumes[0]!["method"]!.GetValue<string>() == "xts-aes-256", "the OS volume.");
            Check(volumes[0]!["protectors"]!.AsArray().Select(p => p!.GetValue<string>()).SequenceEqual(new[] { "tpm", "numerical-password" }), "protector kinds are unique.");
            Check(volumes[1]!["conversion"]!.GetValue<string>() == "encrypting" && volumes[1]!["percent"]!.GetValue<double>() == 42 && volumes[1]!["protection"]!.GetValue<string>() == "suspended" && volumes[1]!["suspendedSince"]!.GetValue<string>() == first.ToString("O"), "encrypting with protection off is suspended since the first sighting.");
            Check(volumes[2]!["drive"] is null && volumes[2]!["volumeType"]!.GetValue<string>() == "removable" && volumes[2]!["protection"]!.GetValue<string>() == "off" && volumes[2]!["method"]!.GetValue<string>() == "none", "a removable volume without letter.");
            Check(volumes[3]!["protectors"]!.AsArray().Count == 9, "every protector kind is reported.");
            string json = result.ToJsonString();
            foreach (string forbidden in new[] { Secret, "AAAA-BBBB", "DDDD", "Volume{", "DeviceID", "MMMM" }) Check(!json.Contains(forbidden, StringComparison.Ordinal), "no protector ID, secret or volume path in the result: " + forbidden);

            clock = first.AddHours(5);
            volumes = new NativeBitLocker(state, provider, () => clock).Collect()["bitlocker"]!["volumes"]!.AsArray();
            Check(volumes[1]!["suspendedSince"]!.GetValue<string>() == first.ToString("O"), "the suspension time survives a restart (state file).");
            provider.State["Volume{2}"] = (2, 60, 1, 6, [("{DDDD}", 3)]);
            volumes = new NativeBitLocker(state, provider, () => clock).Collect()["bitlocker"]!["volumes"]!.AsArray();
            Check(volumes[1]!["protection"]!.GetValue<string>() == "on" && volumes[1]!["suspendedSince"] is null && !File.ReadAllText(state).Contains("D:", StringComparison.Ordinal), "protection back on clears the time.");
            provider.State["Volume{2}"] = (2, 61, 0, 6, [("{DDDD}", 3)]);
            clock = first.AddDays(1);
            volumes = new NativeBitLocker(state, provider, () => clock).Collect()["bitlocker"]!["volumes"]!.AsArray();
            Check(volumes[1]!["suspendedSince"]!.GetValue<string>() == clock.ToString("O"), "a new suspension starts a new time.");

            provider.Failure = new BitLockerUnavailableException("missing");
            result = new NativeBitLocker(state, provider, () => clock).Collect()["bitlocker"]!.AsObject();
            Check(!result["available"]!.GetValue<bool>() && result["reason"]!.GetValue<string>() == "not-supported" && result["volumes"]!.AsArray().Count == 0, "a missing namespace or class: not available.");
            provider.Failure = new UnauthorizedAccessException("denied");
            result = new NativeBitLocker(state, provider, () => clock).Collect()["bitlocker"]!.AsObject();
            Check(!result["available"]!.GetValue<bool>() && result["reason"]!.GetValue<string>() == "access-denied", "access denied.");
            provider.Failure = new InvalidOperationException("broken provider " + Secret);
            result = new NativeBitLocker(state, provider, () => clock).Collect()["bitlocker"]!.AsObject();
            Check(result["reason"]!.GetValue<string>() == "error" && !result.ToJsonString().Contains(Secret, StringComparison.Ordinal), "another failure is an error without its message.");
        }
        finally { try { Directory.Delete(folder, true); } catch (IOException) { } }

        // Only the read methods are allowed.
        Check(WmiBitLockerProvider.ReadMethods.SequenceEqual(new[] { "GetConversionStatus", "GetProtectionStatus", "GetEncryptionMethod", "GetKeyProtectors", "GetKeyProtectorType" }), "the provider invokes only the read methods.");
    }
}
