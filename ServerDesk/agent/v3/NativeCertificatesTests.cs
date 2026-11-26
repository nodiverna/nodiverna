using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ServerDesk.Agent;

// --certificates-self-test: certificates created in the test (valid, expiring in
// 10 days, expired, without private key, the same certificate in two stores,
// more than 10 alternative names), bindings from simulated http.sys and RDP
// readers including a hash in none of the stores, and the guarantee that no key
// material, PEM text or encoded certificate reaches the result.
internal static partial class NativeCertificatesTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Certificate regression: " + message); }
    internal static int RunSelfTest() { try { Run(); Console.WriteLine("Certificate self-test passed."); return 0; } catch (Exception error) { Console.Error.WriteLine(error); return 1; } }

    private sealed class FakeSource(Func<IEnumerable<(string, X509Certificate2)>> certificates, IEnumerable<(string, string)> bindings, string? rdp) : ICertificateSource
    {
        public IEnumerable<(string Store, X509Certificate2 Certificate)> Certificates() => certificates();
        public IEnumerable<(string Endpoint, string Hash)> HttpBindings() => bindings;
        public string? RdpHash() => rdp;
    }

    private static X509Certificate2 Create(string subject, DateTimeOffset notBefore, DateTimeOffset notAfter, int sans = 1, X509Certificate2? issuer = null, bool authority = false)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=" + subject, key, HashAlgorithmName.SHA256);
        var names = new SubjectAlternativeNameBuilder();
        for (int i = 0; i < sans; i++) names.AddDnsName(i == 0 ? subject : "alt" + i + "." + subject);
        names.AddIpAddress(System.Net.IPAddress.Parse("10.0.0.5"));
        request.CertificateExtensions.Add(names.Build());
        if (authority) request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        if (issuer is null) return request.CreateSelfSigned(notBefore, notAfter);
        // Signed by another certificate: the result carries no private key.
        return request.Create(issuer, notBefore, notAfter, [1, 2, 3, 4]);
    }

    private static void Run()
    {
        var at = DateTimeOffset.UtcNow;
        using var root = Create("Contoso Root", at.AddYears(-5), at.AddYears(5), authority: true);
        using var web = Create("web.contoso.local", at.AddDays(-100), at.AddDays(200));
        using var rdp = Create("srv01.contoso.local", at.AddDays(-355), at.AddDays(10));
        using var expired = Create("old.contoso.local", at.AddDays(-400), at.AddDays(-5));
        using var noKey = Create("intermediate.contoso.local", at.AddDays(-30), at.AddDays(-1), issuer: root);
        using var many = Create("many.contoso.local", at.AddDays(-1), at.AddDays(90), sans: 14);
        Check(!noKey.HasPrivateKey && web.HasPrivateKey, "the test certificates: one without private key.");
        X509Certificate2 Copy(X509Certificate2 certificate) => X509CertificateLoader.LoadPkcs12(certificate.Export(X509ContentType.Pkcs12, "t"), "t", X509KeyStorageFlags.EphemeralKeySet);
        X509Certificate2 Public(X509Certificate2 certificate) => X509CertificateLoader.LoadCertificate(certificate.RawData);
        IEnumerable<(string, X509Certificate2)> Stores() => [("My", Copy(web)), ("WebHosting", Copy(web)), ("Remote Desktop", Copy(rdp)), ("My", Copy(expired)), ("My", Public(noKey)), ("My", Copy(many))];
        string unknown = new('A', 40);
        var source = new FakeSource(Stores, [("0.0.0.0:443", web.Thumbprint.ToLowerInvariant()), ("intranet.contoso.local:443", web.Thumbprint), ("[::]:8443", unknown)], rdp.Thumbprint);
        var result = new NativeCertificates(source, () => at).Collect();
        var inventory = result["certificates"]!.AsObject();
        var items = inventory["items"]!.AsArray().Select(item => item!.AsObject()).ToList();
        Check(items.Count == 5 && !inventory["truncated"]!.GetValue<bool>(), "one entry per thumbprint across stores.");
        Check(items.Select(item => DateTimeOffset.Parse(item["notAfter"]!.GetValue<string>())).SequenceEqual(items.Select(item => DateTimeOffset.Parse(item["notAfter"]!.GetValue<string>())).Order()), "sorted by expiry.");
        var webItem = items.Single(item => item["thumbprint"]!.GetValue<string>() == web.Thumbprint.ToUpperInvariant());
        Check(webItem["stores"]!.AsArray().Select(s => s!.GetValue<string>()).SequenceEqual(new[] { "My", "WebHosting" }), "the same certificate in two stores.");
        Check(webItem["hasPrivateKey"]!.GetValue<bool>() && webItem["selfSigned"]!.GetValue<bool>() && webItem["subject"]!.GetValue<string>() == "CN=web.contoso.local", "subject, private key flag and self-signed.");
        Check(webItem["sans"]!.AsArray().Select(s => s!.GetValue<string>()).SequenceEqual(new[] { "web.contoso.local", "10.0.0.5" }), "DNS and IP alternative names.");
        Check(webItem["bindings"]!.ToJsonString() == "[{\"type\":\"https\",\"endpoint\":\"0.0.0.0:443\"},{\"type\":\"https\",\"endpoint\":\"intranet.contoso.local:443\"}]", "http.sys bindings by hash, case-insensitive; IP and SNI.");
        var rdpItem = items.Single(item => item["thumbprint"]!.GetValue<string>() == rdp.Thumbprint);
        Check(rdpItem["bindings"]!.ToJsonString() == "[{\"type\":\"rdp\",\"endpoint\":\"RDP-Tcp\"}]" && rdpItem["stores"]!.AsArray().Single()!.GetValue<string>() == "Remote Desktop", "the RDP listener binding.");
        Check(!result.ToJsonString().Contains(unknown) && items.All(item => item["bindings"]!.AsArray().All(binding => binding!["endpoint"]!.GetValue<string>() != "[::]:8443")), "a binding whose hash is in no store is ignored.");
        var noKeyItem = items.Single(item => item["thumbprint"]!.GetValue<string>() == noKey.Thumbprint);
        Check(!noKeyItem["hasPrivateKey"]!.GetValue<bool>() && !noKeyItem["selfSigned"]!.GetValue<bool>() && noKeyItem["issuer"]!.GetValue<string>() == "CN=Contoso Root", "a certificate without private key, not self-signed.");
        Check(items.Single(item => item["thumbprint"]!.GetValue<string>() == expired.Thumbprint)["notAfter"]!.GetValue<string>().StartsWith(at.AddDays(-5).UtcDateTime.ToString("yyyy-MM-dd")), "an expired certificate keeps its expiry.");
        Check(items.Single(item => item["thumbprint"]!.GetValue<string>() == many.Thumbprint)["sans"]!.AsArray().Count == 10, "at most 10 alternative names.");
        string json = result.ToJsonString();
        Check(!json.Contains("-----BEGIN") && !Blob().IsMatch(json), "no PEM text and no base64 blob longer than 100 characters.");
        Check(!Regex.IsMatch(json, "\"(?:privateKey|rawData|raw|pem|der)\"", RegexOptions.IgnoreCase), "no private key or raw data keys.");
        Check(json.Length <= NativeCertificates.MaximumBytes + 200, "the result stays below 64 KiB.");

        // ---- 150 certificates → the 100 that expire first ----
        var bulk = Enumerable.Range(0, 150).Select(i => Create("bulk" + i.ToString("D3") + ".contoso.local", at.AddDays(-10), at.AddDays(10 + i))).ToList();
        try
        {
            var limited = new NativeCertificates(new FakeSource(() => bulk.Select(certificate => ("My", Copy(certificate))), [], null), () => at).Collect()["certificates"]!;
            var subjects = limited["items"]!.AsArray().Select(item => item!["subject"]!.GetValue<string>()).ToList();
            Check(subjects.Count == 100 && limited["truncated"]!.GetValue<bool>() && subjects[0] == "CN=bulk000.contoso.local" && subjects[^1] == "CN=bulk099.contoso.local", "150 certificates: the 100 that expire first, truncated.");
        }
        finally { foreach (var certificate in bulk) certificate.Dispose(); }
    }

    [GeneratedRegex("[A-Za-z0-9+/=]{101,}")] private static partial Regex Blob();
}
