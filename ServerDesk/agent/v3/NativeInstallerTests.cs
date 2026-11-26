using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class NativeInstallerTests
{
    internal static void Run()
    {
        JsonObject Config() => new() { ["id"] = "00000000-0000-4000-8000-000000000001", ["token"] = new string('a', 64), ["origin"] = "https://serverdesk.example", ["mode"] = "ReadOnly", ["untrustedOption"] = "discard" };
        var approved = AgentInstaller.ValidateConfiguration(Config());
        if (approved["mode"]!.GetValue<string>() != "ReadOnly" || approved.ContainsKey("untrustedOption") || approved.ContainsKey("privateKey")) throw new Exception("Registration configuration is not normalized to known fields.");
        var management = Config(); management["mode"] = "Management";
        if (AgentInstaller.ValidateConfiguration(management)["mode"]!.GetValue<string>() != "Management") throw new Exception("Explicit Management registration was rejected.");
        var missingMode = Config(); missingMode.Remove("mode");
        if (AgentInstaller.ValidateConfiguration(missingMode)["mode"]!.GetValue<string>() != "ReadOnly") throw new Exception("Missing mode did not default to ReadOnly.");
        foreach (string origin in new[] { "https://serverdesk.example:8443", "https://192.168.1.10:8443", "https://nas.local", "https://[::1]:8443" })
        {
            var localPortal = Config(); localPortal["origin"] = origin;
            if (AgentInstaller.ValidateConfiguration(localPortal)["origin"]!.GetValue<string>() != origin) throw new Exception("A private HTTPS origin or custom HTTPS port was rejected.");
        }
        foreach (var (field, value) in new[]
        {
            ("id", "not-an-identity"), ("token", "short"), ("token", new string('g', 64)),
            ("mode", "Administrator"), ("mode", "management"), ("origin", "http://serverdesk.example"),
            ("origin", "https://user:password@serverdesk.example"), ("origin", "https://serverdesk.example:65536"), ("origin", "https://serverdesk.example:0"),
            ("origin", "https://serverdesk.example/portal"), ("origin", "https://serverdesk.example?token=secret"),
            ("origin", "https://serverdesk.example#fragment")
        })
        {
            var invalid = Config(); invalid[field] = value; bool rejected = false;
            try { AgentInstaller.ValidateConfiguration(invalid); } catch (InvalidDataException) { rejected = true; }
            if (!rejected) throw new Exception("Unsafe installer field accepted: " + field);
        }
        VerifyServiceSecurityPolicy();
        VerifyReleaseForms();
        Console.WriteLine("Native installer registration tests passed: modes, identity, HTTPS origin, header injection and allowlisted fields.");
    }
    // Both manifest forms of 4.12.0, signed with a throwaway key through the
    // test-only trust parameter. Production callers always use the embedded key.
    private static void VerifyReleaseForms()
    {
        const string origin = "https://portal.test:8443";
        using var key = System.Security.Cryptography.ECDsa.Create(System.Security.Cryptography.ECCurve.NamedCurves.nistP256);
        string trust = key.ExportSubjectPublicKeyInfoPem();
        string Sign(string manifest) => Convert.ToBase64String(key.SignData(System.Text.Encoding.UTF8.GetBytes(manifest), System.Security.Cryptography.HashAlgorithmName.SHA256, System.Security.Cryptography.DSASignatureFormat.Rfc3279DerSequence));
        string hash = new('a', 64);
        // file(name) gives the entry key and value of one file in the wanted form.
        string Manifest(Func<string, string> file, string? exePart = null) =>
            "{\"version\":\"4.12.0\",\"protocolVersion\":3,\"minProtocolVersion\":3,\"os\":[\"Windows 11 Pro\"],\"arch\":\"x64\"," + file("agent.zip") + ",\"sha256\":\"" + hash + "\",\"size\":30,\"layout\":\"single-exe\","
            + "\"exe\":{" + file("agent.exe") + ",\"sha256\":\"" + hash + "\",\"size\":30,\"parts\":[{" + (exePart ?? file("agent.exe.part1")) + ",\"sha256\":\"" + hash + "\",\"size\":10},{" + file("agent.exe.part2") + ",\"sha256\":\"" + hash + "\",\"size\":20}]},"
            + "\"parts\":[{" + file("agent.zip.part1") + ",\"sha256\":\"" + hash + "\",\"size\":30}],\"createdAt\":\"2026-11-01T10:00:00.000Z\"}";
        static string PathEntry(string name) => "\"path\":\"/downloads/" + name + "\"";
        string UrlEntry(string name) => "\"url\":\"" + origin + "/downloads/" + name + "\"";
        string pathForm = Manifest(PathEntry);
        var release = AgentUpdater.VerifyManifest(pathForm, Sign(pathForm), origin, trust);
        var urls = new[] { release["url"], release["parts"]![0]!["url"], release["exe"]!["url"], release["exe"]!["parts"]![0]!["url"], release["exe"]!["parts"]![1]!["url"] }.Select(node => node!.GetValue<string>()).ToArray();
        if (!urls.SequenceEqual(new[] { "agent.zip", "agent.zip.part1", "agent.exe", "agent.exe.part1", "agent.exe.part2" }.Select(name => origin + "/downloads/" + name)) || release["exe"]!.AsObject().ContainsKey("path")) throw new Exception("A path-form release did not resolve against the registered origin.");
        string absolute = Manifest(UrlEntry);
        if (AgentUpdater.VerifyManifest(absolute, Sign(absolute), origin, trust)["exe"]!["url"]!.GetValue<string>() != origin + "/downloads/agent.exe") throw new Exception("An absolute-form release on the registered origin was refused.");
        var refused = new (string Label, string Manifest)[]
        {
            ("a foreign origin", Manifest(name => "\"url\":\"https://evil.test:8443/downloads/" + name + "\"")),
            ("/downloads/../x", Manifest(PathEntry, "\"path\":\"/downloads/../x\"")),
            ("/downloads/a/b", Manifest(PathEntry, "\"path\":\"/downloads/a/b\"")),
            ("/other/x", Manifest(PathEntry, "\"path\":\"/other/x\"")),
            ("a query", Manifest(PathEntry, "\"path\":\"/downloads/x?y\"")),
            ("a backslash", Manifest(PathEntry, "\"path\":\"/downloads/a\\\\b\"")),
            ("a trailing line break", Manifest(PathEntry, "\"path\":\"/downloads/x\\n\"")),
            ("mixed forms", Manifest(PathEntry, UrlEntry("agent.exe.part1"))),
            ("an entry with both keys", Manifest(PathEntry, PathEntry("agent.exe.part1") + "," + UrlEntry("agent.exe.part1"))),
            ("an entry without a file", Manifest(PathEntry, "\"name\":\"agent.exe.part1\"")),
        };
        foreach (var (label, manifest) in refused)
        {
            bool rejected = false;
            try { AgentUpdater.VerifyManifest(manifest, Sign(manifest), origin, trust); } catch (InvalidDataException) { rejected = true; }
            if (!rejected) throw new Exception("A release with " + label + " was accepted.");
        }
        string signature = Sign(pathForm), changed = pathForm.Replace("\"size\":30,\"layout\"", "\"size\":31,\"layout\"", StringComparison.Ordinal);
        bool tampered = false;
        try { AgentUpdater.VerifyManifest(changed, signature, origin, trust); } catch (System.Security.Cryptography.CryptographicException) { tampered = true; }
        if (!tampered || changed == pathForm) throw new Exception("A changed byte of a signed release was accepted.");
        bool foreignKey = false;
        try { AgentUpdater.VerifyManifest(pathForm, signature, origin); } catch (System.Security.Cryptography.CryptographicException) { foreignKey = true; }
        if (!foreignKey) throw new Exception("The production overload accepted a release that the embedded publisher did not sign.");
        // Dev builds (ReleaseVersion): a signed X.Y.Z-dev.<sha7> manifest verifies; every other non-X.Y.Z version is refused.
        string devForm = pathForm.Replace("\"version\":\"4.12.0\"", "\"version\":\"4.21.5-dev.abc1234\"", StringComparison.Ordinal);
        if (devForm == pathForm || AgentUpdater.VerifyManifest(devForm, Sign(devForm), origin, trust)["version"]!.GetValue<string>() != "4.21.5-dev.abc1234") throw new Exception("A signed dev release manifest was refused.");
        foreach (string malformed in new[] { "4.21.5-dev.ABC1234", "4.21.5-dev.abc123", "4.21.5-rc.1", "4.21.5-dev.abc1234.1", "04.1.0", "4.21", "4.21.5.0" })
        {
            string text = pathForm.Replace("\"version\":\"4.12.0\"", "\"version\":\"" + malformed + "\"", StringComparison.Ordinal);
            bool rejected = false;
            try { AgentUpdater.VerifyManifest(text, Sign(text), origin, trust); } catch (InvalidDataException) { rejected = true; }
            if (!rejected) throw new Exception("The release version " + malformed + " was accepted.");
        }
        // The single-EXE rule of agent 4 and later uses the base of a dev version.
        string devWithoutExe = devForm.Replace("\"layout\":\"single-exe\",", "", StringComparison.Ordinal);
        bool needsExe = false;
        try { AgentUpdater.VerifyManifest(devWithoutExe, Sign(devWithoutExe), origin, trust); } catch (InvalidDataException) { needsExe = true; }
        if (!needsExe || devWithoutExe == devForm) throw new Exception("A dev 4.x release without the single-EXE layout was accepted.");
        VerifyUpdateRanks();
        Console.WriteLine("Release manifest tests passed: path form resolves against the registered origin, absolute form on that origin, unsafe paths, foreign origins, mixed forms and changed bytes refused.");
    }
    // The update rule of PrepareAsync by rank (ReleaseVersion): a lower rank is a downgrade, the
    // identical string is installed already, another dev build of the same base may replace one.
    private static void VerifyUpdateRanks()
    {
        foreach (var (target, installed, message) in new[]
        {
            ("4.21.5-dev.abc1234", "4.21.5", "Agent downgrades are not supported."),
            ("4.21.4", "4.21.5-dev.abc1234", "Agent downgrades are not supported."),
            ("4.21.4", "4.21.5", "Agent downgrades are not supported."),
            ("4.21.5-dev.abc1234", "4.21.5-dev.abc1234", "This release is already installed."),
            ("4.21.5", "4.21.5", "This release is already installed."),
        })
        {
            string? actual = null;
            try { AgentUpdater.CheckTarget(target, installed); } catch (InvalidOperationException e) { actual = e.Message; }
            if (actual != message) throw new Exception("The update from " + installed + " to " + target + " gave " + (actual ?? "no error") + ", not: " + message);
        }
        foreach (var (target, installed) in new[] { ("4.21.5-dev.bbbbbbb", "4.21.5-dev.aaaaaaa"), ("4.21.5-dev.abc1234", "4.21.4"), ("4.21.5", "4.21.5-dev.abc1234"), ("4.22.0", "4.21.5") })
            AgentUpdater.CheckTarget(target, installed);
    }
    // The failure actions as VerifyAppliedSecurityPolicy reads them back (4.18.0):
    // a match, or the first difference, which makes the installation roll back.
    private static void VerifyRecoveryComparison()
    {
        (int, uint)[] expected = [(1, 5000), (1, 30000), (1, 60000)];
        if (NativeServiceSetup.RecoveryDifference(86400, expected, true) is not null) throw new Exception("The shared failure actions do not match themselves.");
        var differences = new (string Expected, string? Actual)[]
        {
            ("count 2", NativeServiceSetup.RecoveryDifference(86400, expected[..2], true)),
            ("type 2 0", NativeServiceSetup.RecoveryDifference(86400, [(1, 5000), (1, 30000), (0, 60000)], true)),
            ("delay 1 60000", NativeServiceSetup.RecoveryDifference(86400, [(1, 5000), (1, 60000), (1, 60000)], true)),
            ("reset 3600", NativeServiceSetup.RecoveryDifference(3600, expected, true)),
            ("flag false", NativeServiceSetup.RecoveryDifference(86400, expected, false)),
        };
        foreach (var (wanted, actual) in differences) if (actual != wanted) throw new Exception("Failure-action comparison: expected " + wanted + ", got " + (actual ?? "a match") + ".");
        Console.WriteLine("Failure-action comparison passed: count, type, delay, reset period and flag.");
    }
    private static void VerifyServiceSecurityPolicy()
    {
        if (NativeServiceSetup.ServiceSidType != 1) throw new Exception("The per-service SID must preserve existing unrestricted management functionality.");
        const uint requiredHandleRights = 0xE0013; // query/change config, SERVICE_START (restart failure actions), READ_CONTROL, WRITE_DAC, WRITE_OWNER
        if (NativeServiceSetup.SecurityPolicyAccess != requiredHandleRights) throw new Exception("Service policy mutation and native readback require their distinct handle rights.");
        VerifyRecoveryComparison();
        if (!OperatingSystem.IsWindows())
        {
            Console.WriteLine("Service DACL/SID Windows validation requires a Windows host; not exercised by the portable self-test.");
            return;
        }
        var descriptor = new System.Security.AccessControl.RawSecurityDescriptor(NativeServiceSetup.SecurityDescriptor);
        NativeServiceSetup.ValidateSecurityDescriptor(descriptor);
        // The older service setter need not persist SDDL's protection control
        // bit. Exact persisted ownership and non-inherited ACE masks are checked
        // by the same verifier, independently of that unsupported flag.
        NativeServiceSetup.ValidateSecurityDescriptor(new System.Security.AccessControl.RawSecurityDescriptor(NativeServiceSetup.SecurityDescriptor.Replace("D:P", "D:", StringComparison.Ordinal)));
        if (descriptor.Owner?.Value != "S-1-5-32-544" || descriptor.DiscretionaryAcl is null || descriptor.DiscretionaryAcl.Count != 3) throw new Exception("Service security policy did not establish trusted ownership and explicit access rights.");
        var granted = new Dictionary<string, int>();
        foreach (System.Security.AccessControl.GenericAce entry in descriptor.DiscretionaryAcl)
        {
            if (entry is not System.Security.AccessControl.CommonAce ace || ace.AceQualifier != System.Security.AccessControl.AceQualifier.AccessAllowed || ace.AceFlags != System.Security.AccessControl.AceFlags.None || !granted.TryAdd(ace.SecurityIdentifier.Value, ace.AccessMask)) throw new Exception("Unexpected service access-control entry.");
        }
        if (granted["S-1-5-18"] != 0xF01FF || granted["S-1-5-32-544"] != 0xF01FF) throw new Exception("SYSTEM/admin service installation, controls, repair and updates must remain available.");
        int monitoring = granted["S-1-5-11"];
        const int requiredMonitoring = 0x2008D; // status/config/dependencies/interrogate/READ_CONTROL
        const int forbidden = 0xD0172; // owner/DACL/delete/config/start/stop/pause/user controls
        if ((monitoring & requiredMonitoring) != requiredMonitoring || (monitoring & forbidden) != 0) throw new Exception("Unprivileged service monitoring gained mutation rights or lost status access.");
        foreach (string unsafeDescriptor in new[] {
            NativeServiceSetup.SecurityDescriptor.Replace("O:BA", "O:AU", StringComparison.Ordinal),
            NativeServiceSetup.SecurityDescriptor.Replace("0x2008D", "0xF01FF", StringComparison.Ordinal),
            NativeServiceSetup.SecurityDescriptor.Replace("(A;;0xF01FF;;;SY)", "", StringComparison.Ordinal),
            NativeServiceSetup.SecurityDescriptor + "(A;;0xF01FF;;;WD)"
        })
        {
            bool rejected = false;
            try { NativeServiceSetup.ValidateSecurityDescriptor(new System.Security.AccessControl.RawSecurityDescriptor(unsafeDescriptor)); } catch (IOException) { rejected = true; }
            if (!rejected) throw new Exception("The applied service policy verifier accepted untrusted ownership, excess access or missing recovery rights.");
        }
        Console.WriteLine("Service security policy tests passed: trusted owner, explicit DACL, SYSTEM/admin recovery and unprivileged monitoring only.");
    }
}
