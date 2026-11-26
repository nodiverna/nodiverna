using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Xml.Linq;

namespace ServerDesk.Agent;

internal static class LocalStore
{
    [StructLayout(LayoutKind.Sequential)] private struct Blob { public int Length; public IntPtr Data; }
    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool CryptProtectData(ref Blob input, string? description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);
    [DllImport("crypt32.dll", SetLastError = true)] private static extern bool CryptUnprotectData(ref Blob input, IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    internal static byte[] Protect(byte[] bytes, bool decrypt = false)
    {
        var input = new Blob { Length = bytes.Length, Data = Marshal.AllocHGlobal(bytes.Length) };
        Marshal.Copy(bytes, 0, input.Data, bytes.Length);
        try
        {
            Blob output;
            bool ok = decrypt ? CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output) : CryptProtectData(ref input, null, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 5, out output);
            if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Machine DPAPI failed");
            try { var result = new byte[output.Length]; Marshal.Copy(output.Data, result, 0, result.Length); return result; }
            finally { LocalFree(output.Data); }
        }
        finally { Marshal.FreeHGlobal(input.Data); }
    }
    internal static JsonObject ReadProtected(string path)
    {
        byte[] plaintext = Protect(File.ReadAllBytes(path), true);
        try { return JsonNode.Parse(plaintext)?.AsObject() ?? throw new InvalidDataException("Invalid protected JSON"); }
        finally { CryptographicOperations.ZeroMemory(plaintext); }
    }
    internal static void SaveProtected(string path, JsonNode value) => Atomic(path, Protect(Encoding.UTF8.GetBytes(value.ToJsonString())));
    internal static void Atomic(string path, byte[] bytes)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 8192, FileOptions.WriteThrough)) { file.Write(bytes); file.Flush(true); }
        File.Move(temporary, path, true);
    }
    internal static void Json(string path, JsonNode value) => Atomic(path, Encoding.UTF8.GetBytes(value.ToJsonString()));
    // The worker cannot write the broker's directory; all of its components
    // log into the worker-owned directory instead.
    private static string? logDirectory;
    internal static void RedirectLog(string directory) => logDirectory = directory;
    internal static void Log(string root, string text)
    {
        try { lock (typeof(LocalStore)) { string path = logDirectory is null ? Path.Combine(root, "agent-v3.log") : Path.Combine(logDirectory, "agent-worker.log"); if (File.Exists(path) && new FileInfo(path).Length > 1_000_000) File.Move(path, path + ".1", true); File.AppendAllText(path, DateTimeOffset.UtcNow.ToString("O") + " " + text[..Math.Min(2000, text.Length)] + Environment.NewLine); } } catch { }
    }
    internal static RSA ReadRsa(string xml)
    {
        var root = XElement.Parse(xml); byte[]? Field(string name) => root.Element(name) is { } e ? Convert.FromBase64String(e.Value) : null;
        RSA key = RSA.Create(); key.ImportParameters(new RSAParameters { Modulus = Field("Modulus"), Exponent = Field("Exponent"), D = Field("D"), P = Field("P"), Q = Field("Q"), DP = Field("DP"), DQ = Field("DQ"), InverseQ = Field("InverseQ") }); return key;
    }
    internal static JsonObject DecryptSecrets(JsonObject box, string privateXml)
    {
        using RSA rsa = ReadRsa(privateXml);
        byte[] key = rsa.Decrypt(Convert.FromBase64String(box["key"]!.GetValue<string>()), RSAEncryptionPadding.OaepSHA1);
        try
        {
            byte[] iv = Convert.FromBase64String(box["iv"]!.GetValue<string>()), data = Convert.FromBase64String(box["data"]!.GetValue<string>()), mac = Convert.FromBase64String(box["mac"]!.GetValue<string>());
            if (key.Length != 64 || iv.Length != 16 || mac.Length != 32 || data.Length == 0 || data.Length > 8192 || data.Length % 16 != 0) throw new CryptographicException("Invalid sealed parameters");
            byte[] signed = [.. iv, .. data]; byte[] expected = HMACSHA256.HashData(key.AsSpan(32), signed);
            if (!CryptographicOperations.FixedTimeEquals(expected, mac)) throw new CryptographicException("Parameter integrity failed");
            using var aes = Aes.Create(); aes.Key = key.AsSpan(0, 32).ToArray(); aes.IV = iv;
            byte[] plain = aes.DecryptCbc(data, iv);
            try { return JsonNode.Parse(plain)!.AsObject(); } finally { CryptographicOperations.ZeroMemory(plain); }
        }
        finally { CryptographicOperations.ZeroMemory(key); }
    }
}
