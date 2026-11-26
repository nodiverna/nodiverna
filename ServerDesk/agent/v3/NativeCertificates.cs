using System.Globalization;
using System.Management;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace ServerDesk.Agent;

// The machine certificates (docs/v3-health-signals.md) of the LocalMachine stores
// My, WebHosting and Remote Desktop, opened read-only, and what they are bound
// to: http.sys (SslBindingInfo, SslSniBindingInfo) and the RDP listener.
// Private keys and certificate files never leave the device: the collector only
// asks whether a private key exists (HasPrivateKey) and reads names, dates and
// the subject alternative names. It never touches the key, never exports and
// never copies the encoded certificate into the result.
internal interface ICertificateSource
{
    /// <summary>The certificates of each store; a store that does not exist is missing from the result.</summary>
    IEnumerable<(string Store, X509Certificate2 Certificate)> Certificates();
    /// <summary>The http.sys TLS bindings: endpoint ("0.0.0.0:443", "host:443") and certificate hash (hex).</summary>
    IEnumerable<(string Endpoint, string Hash)> HttpBindings();
    /// <summary>The certificate hash (hex) of the RDP-Tcp listener, or null.</summary>
    string? RdpHash();
}

internal sealed class NativeCertificates(ICertificateSource? source = null, Func<DateTimeOffset>? clock = null)
{
    internal const int IntervalSeconds = 900;
    internal const int DeadlineSeconds = 20;
    internal const int MaximumItems = 100;
    internal const int MaximumBytes = 65_536;
    internal const int MaximumSans = 10;
    internal static readonly string[] Stores = ["My", "WebHosting", "Remote Desktop"];
    private readonly ICertificateSource certificates = source ?? new WindowsCertificateSource();
    private readonly Func<DateTimeOffset> now = clock ?? (() => DateTimeOffset.UtcNow);

    private sealed class Draft(string thumbprint)
    {
        internal string Thumbprint { get; } = thumbprint;
        internal List<string> Stores { get; } = [];
        internal string Subject = "", Issuer = "";
        internal List<string> Sans { get; } = [];
        internal DateTimeOffset NotBefore, NotAfter;
        internal bool HasPrivateKey, SelfSigned;
        internal List<JsonObject> Bindings { get; } = [];
    }

    internal JsonObject Collect()
    {
        var at = now(); var warnings = new JsonArray();
        var drafts = new Dictionary<string, Draft>(StringComparer.Ordinal);
        foreach (var (store, certificate) in certificates.Certificates())
        {
            using (certificate)
            {
                string thumbprint = certificate.Thumbprint.ToUpperInvariant();
                if (thumbprint.Length != 40 || !thumbprint.All(Uri.IsHexDigit)) continue;
                if (!drafts.TryGetValue(thumbprint, out var draft))
                {
                    draft = new Draft(thumbprint)
                    {
                        Subject = Limit(certificate.Subject, 1024), Issuer = Limit(certificate.Issuer, 1024),
                        NotBefore = new DateTimeOffset(certificate.NotBefore.ToUniversalTime(), TimeSpan.Zero), NotAfter = new DateTimeOffset(certificate.NotAfter.ToUniversalTime(), TimeSpan.Zero),
                        HasPrivateKey = certificate.HasPrivateKey, SelfSigned = string.Equals(certificate.SubjectName.Name, certificate.IssuerName.Name, StringComparison.Ordinal)
                    };
                    draft.Sans.AddRange(AlternativeNames(certificate));
                    drafts[thumbprint] = draft;
                }
                if (!draft.Stores.Contains(store, StringComparer.Ordinal)) draft.Stores.Add(store);
            }
        }
        // A binding whose hash is in none of the three stores is ignored.
        try
        {
            foreach (var (endpoint, hash) in certificates.HttpBindings())
                if (drafts.TryGetValue(hash.ToUpperInvariant(), out var draft) && draft.Bindings.Count < 20 && endpoint.Length is > 0 and <= 300) draft.Bindings.Add(new JsonObject { ["type"] = "https", ["endpoint"] = endpoint });
        }
        catch (Exception error) when (error is not OutOfMemoryException) { warnings.Add("The http.sys bindings could not be read (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
        try
        {
            if (certificates.RdpHash() is string rdp && drafts.TryGetValue(rdp.ToUpperInvariant(), out var draft) && draft.Bindings.Count < 20) draft.Bindings.Add(new JsonObject { ["type"] = "rdp", ["endpoint"] = "RDP-Tcp" });
        }
        catch (Exception error) when (error is not OutOfMemoryException) { warnings.Add("The Remote Desktop certificate could not be read (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
        var ordered = drafts.Values.OrderBy(draft => draft.NotAfter).ThenBy(draft => draft.Thumbprint, StringComparer.Ordinal).ToList();
        var items = ordered.Take(MaximumItems).Select(Item).ToList();
        while (items.Count > 0 && Encoding.UTF8.GetByteCount(new JsonArray(items.Select(item => (JsonNode)item.DeepClone()).ToArray()).ToJsonString()) > MaximumBytes) items.RemoveAt(items.Count - 1);
        var result = new JsonObject { ["certificates"] = new JsonObject { ["collectedAt"] = at.ToString("O", CultureInfo.InvariantCulture), ["items"] = new JsonArray(items.Select(item => (JsonNode)item).ToArray()), ["truncated"] = items.Count < ordered.Count } };
        if (warnings.Count > 0) result["_collectionWarnings"] = warnings;
        return result;
    }

    private static JsonObject Item(Draft draft) => new()
    {
        ["thumbprint"] = draft.Thumbprint,
        ["stores"] = new JsonArray(Stores.Where(draft.Stores.Contains).Select(store => (JsonNode?)JsonValue.Create(store)).ToArray()),
        ["subject"] = draft.Subject, ["sans"] = new JsonArray(draft.Sans.Select(name => (JsonNode?)JsonValue.Create(name)).ToArray()), ["issuer"] = draft.Issuer,
        ["notBefore"] = draft.NotBefore.ToString("O", CultureInfo.InvariantCulture), ["notAfter"] = draft.NotAfter.ToString("O", CultureInfo.InvariantCulture),
        ["hasPrivateKey"] = draft.HasPrivateKey, ["selfSigned"] = draft.SelfSigned,
        ["bindings"] = new JsonArray(draft.Bindings.Select(binding => (JsonNode)binding.DeepClone()).ToArray())
    };

    /// <summary>The DNS names and IP addresses of the subject alternative name extension, at most 10 of at most 256 characters.</summary>
    internal static List<string> AlternativeNames(X509Certificate2 certificate)
    {
        var result = new List<string>();
        foreach (var extension in certificate.Extensions)
        {
            if (extension is not X509SubjectAlternativeNameExtension names) continue;
            try
            {
                foreach (string dns in names.EnumerateDnsNames()) { if (result.Count >= MaximumSans) break; result.Add(Limit(dns, 256)); }
                foreach (var address in names.EnumerateIPAddresses()) { if (result.Count >= MaximumSans) break; result.Add(Limit(address.ToString(), 256)); }
            }
            catch (CryptographicException) { }
        }
        return result;
    }

    private static string Limit(string value, int maximum) => value.Length <= maximum ? value : value[..maximum];
    /// <summary>The upper-case hex form of a binary certificate hash, or null.</summary>
    internal static string? Hex(object? value) => value switch
    {
        byte[] { Length: 20 } bytes => Convert.ToHexString(bytes),
        string text when text.Trim().Length == 40 && text.Trim().All(Uri.IsHexDigit) => text.Trim().ToUpperInvariant(),
        _ => null
    };
}

internal sealed class WindowsCertificateSource : ICertificateSource
{
    public IEnumerable<(string Store, X509Certificate2 Certificate)> Certificates()
    {
        foreach (string name in NativeCertificates.Stores)
        {
            var store = new X509Store(name, StoreLocation.LocalMachine);
            List<X509Certificate2> found;
            try
            {
                store.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
                var all = store.Certificates.Cast<X509Certificate2>().ToList();
                found = all.Take(500).ToList();
                foreach (var extra in all.Skip(500)) extra.Dispose();
            }
            catch (CryptographicException) { store.Dispose(); continue; }
            foreach (var certificate in found) yield return (name, certificate);
            store.Dispose();
        }
    }

    public IEnumerable<(string Endpoint, string Hash)> HttpBindings()
    {
        if (!OperatingSystem.IsWindows()) yield break;
        foreach (string list in new[] { "SslBindingInfo", "SslSniBindingInfo" })
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\HTTP\Parameters\" + list);
            if (key is null) continue;
            foreach (string endpoint in key.GetSubKeyNames().Take(500))
            {
                using var binding = key.OpenSubKey(endpoint);
                if (NativeCertificates.Hex(binding?.GetValue("SslCertHash")) is string hash) yield return (endpoint, hash);
            }
        }
    }

    public string? RdpHash()
    {
        var options = new ConnectionOptions { EnablePrivileges = true, Authentication = AuthenticationLevel.PacketPrivacy, Timeout = TimeSpan.FromSeconds(5) };
        using var searcher = new ManagementObjectSearcher(new ManagementScope(@"root\cimv2\TerminalServices", options), new ObjectQuery("SELECT SSLCertificateSHA1Hash FROM Win32_TSGeneralSetting WHERE TerminalName='RDP-Tcp'"), new System.Management.EnumerationOptions { ReturnImmediately = true, Rewindable = false, Timeout = TimeSpan.FromSeconds(5) });
        using var rows = searcher.Get();
        foreach (ManagementObject row in rows) using (row) return NativeCertificates.Hex(row["SSLCertificateSHA1Hash"]);
        return null;
    }
}
