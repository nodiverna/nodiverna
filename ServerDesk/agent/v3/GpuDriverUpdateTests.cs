using System.Security.Cryptography.X509Certificates;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// --gpu-driver-self-test: the rules of the GPU driver job (agent 4.13.0)
// without a download or an installer: parameter validation, the download host
// allow list, the signer organization, the signature decision (4.17.1), exit
// codes, size and free space, the AMD Software version from the display class
// key, and the registry of open downloads in the worker relay (4.17.1).
internal static class GpuDriverUpdateTests
{
    internal static async Task<int> RunSelfTestAsync()
    {
        try { await RunAsync(); Console.WriteLine("GPU driver self-test passed."); return 0; }
        catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }

    private static void Assert(bool condition, string label) { if (!condition) throw new InvalidOperationException("GPU driver regression: " + label); }
    private static string? Code(Action action) { try { action(); return null; } catch (AgentMessageException e) { return e.Code; } }
    private static async Task<AgentMessageException?> Failure(Func<Task> action) { try { await action(); return null; } catch (AgentMessageException e) { return e; } }

    private const string NvidiaUrl = "https://us.download.nvidia.com/Windows/581.80/581.80-desktop-win10-win11-64bit-international-dch-whql.exe";
    private const string AmdUrl = "https://drivers.amd.com/drivers/whql-amd-software-adrenalin-edition-25.10.1-win10-win11-oct-rdna.exe";
    private static JsonObject Job(string vendor = "nvidia", string version = "581.80", string url = NvidiaUrl, long size = 1_037_190_000) =>
        new() { ["vendor"] = vendor, ["version"] = version, ["url"] = url, ["sizeBytes"] = size };

    internal static async Task RunAsync()
    {
        // ---- Parameters ----
        var valid = GpuDriverUpdate.Validate(Job());
        Assert(valid.Vendor == "nvidia" && valid.Version == "581.80" && valid.SizeBytes == 1_037_190_000 && valid.Url.IdnHost == "us.download.nvidia.com" && valid.VendorName == "NVIDIA", "a valid NVIDIA job");
        Assert(GpuDriverUpdate.Validate(Job("amd", "25.10.1", AmdUrl, 900_000_000)).VendorName == "AMD", "a valid AMD job");
        Assert(GpuDriverUpdate.Validate(Job(url: "https://international.download.nvidia.com/Windows/581.80/x.exe")).Url.IdnHost == "international.download.nvidia.com", "the international NVIDIA host");
        var invalid = new List<JsonObject>
        {
            Job("intel"), Job("NVIDIA"), Job(version: "581"), Job(version: "581.80a"), Job(version: "12345.1"), Job(version: "1.2.3.4.5"), Job(version: "581.80 -s"),
            Job(size: 0), Job(size: -1), Job(size: GpuDriverUpdate.MaximumBytes + 1),
            Job(url: "http://us.download.nvidia.com/x.exe"), Job(url: "https://evil.example/x.exe"), Job(url: "https://user:pw@us.download.nvidia.com/x.exe"),
            Job(url: "https://us.download.nvidia.com.evil.example/x.exe"), Job(url: "https://us.download.nvidia.com:8443/x.exe"), Job(url: "https://us.download.nvidia.com/x.exe#frag"),
            Job(url: AmdUrl), Job("amd", "25.10.1", NvidiaUrl), Job(url: "us.download.nvidia.com/x.exe"), Job(url: "file:///C:/x.exe"),
        };
        var extra = Job(); extra["arguments"] = "-clean"; invalid.Add(extra);
        var missing = Job(); missing.Remove("url"); invalid.Add(missing);
        var text = Job(); text["sizeBytes"] = "1000"; invalid.Add(text);
        foreach (var job in invalid) Assert(Code(() => GpuDriverUpdate.Validate(job)) == "AGENT_GPU_DRIVER_INVALID", "invalid parameters are refused: " + job.ToJsonString());
        Assert(Code(() => NativeManagement.ValidateParameters("install-gpu-driver", Job("intel"))) == "AGENT_GPU_DRIVER_INVALID" && Code(() => NativeManagement.ValidateParameters("install-gpu-driver", Job())) is null, "NativeManagement validates the job");

        // ---- Host allow list ----
        foreach (var (vendor, url, expected) in new (string, string?, bool)[]
        {
            ("nvidia", NvidiaUrl, true), ("amd", AmdUrl, true), ("nvidia", "https://US.DOWNLOAD.NVIDIA.COM/x.exe", true),
            ("nvidia", "https://download.nvidia.com/x.exe", false), ("amd", "https://www.amd.com/x.exe", false), ("amd", "https://drivers.amd.com@evil.example/x.exe", false),
            ("intel", NvidiaUrl, false), ("nvidia", null, false), ("nvidia", "", false),
        })
            Assert(GpuDriverUpdate.AllowedUrl(vendor, url) == expected, $"allow list {vendor} {url}");
        Assert(GpuDriverUpdate.AllowedHosts["nvidia"].SequenceEqual(["us.download.nvidia.com", "international.download.nvidia.com"]) && GpuDriverUpdate.AllowedHosts["amd"].SequenceEqual(["drivers.amd.com"]), "the host lists are the documented constants");

        // ---- Signer organization ----
        Assert(GpuDriverUpdate.SignerMatches("nvidia", "NVIDIA Corporation") && GpuDriverUpdate.SignerMatches("amd", "Advanced Micro Devices, Inc.") && GpuDriverUpdate.SignerMatches("amd", "Advanced Micro Devices Inc."), "the pinned signers match");
        foreach (var (vendor, organization) in new (string, string?)[] { ("nvidia", "Advanced Micro Devices, Inc."), ("amd", "NVIDIA Corporation"), ("nvidia", "NVIDIA Corporation Ltd"), ("nvidia", "nvidia corporation"), ("nvidia", null), ("intel", "Intel Corporation") })
            Assert(!GpuDriverUpdate.SignerMatches(vendor, organization), $"another signer is refused: {vendor} {organization}");
        Assert(GpuDriverUpdate.Organization(new X500DistinguishedName("CN=NVIDIA Corporation, O=NVIDIA Corporation, L=Santa Clara, S=California, C=US")) == "NVIDIA Corporation", "the organization of an NVIDIA subject");
        Assert(GpuDriverUpdate.Organization(new X500DistinguishedName("CN=\"Advanced Micro Devices, Inc.\", O=\"Advanced Micro Devices, Inc.\", L=Santa Clara, S=California, C=US")) == "Advanced Micro Devices, Inc.", "the organization of an AMD subject with a comma");
        Assert(GpuDriverUpdate.Organization(new X500DistinguishedName("CN=NVIDIA Corporation, C=US")) is null, "a subject without O= has no organization (the common name does not count)");

        // ---- Exit codes ----
        var nvidia = GpuDriverUpdate.Validate(Job()); var amd = GpuDriverUpdate.Validate(Job("amd", "25.10.1", AmdUrl, 900_000_000)); string hash = new('a', 64);
        var installed = GpuDriverUpdate.ExitMessage(nvidia, 0, false, hash);
        Assert(installed.Code == "AGENT_GPU_DRIVER_INSTALLED" && installed.Args["version"] == "581.80" && installed.Args["sha256"] == hash && installed.Text == "Graphics driver 581.80 installed.", "exit code 0 is installed");
        Assert(GpuDriverUpdate.ExitMessage(nvidia, 0, true, hash).Code == "AGENT_GPU_DRIVER_INSTALLED_REBOOT", "exit code 0 with a pending reboot asks for a restart");
        foreach (int code in new[] { 3010, 1641 }) foreach (var job in new[] { nvidia, amd }) Assert(GpuDriverUpdate.ExitMessage(job, code, false, hash).Code == "AGENT_GPU_DRIVER_INSTALLED_REBOOT", $"{job.Vendor} reboot exit code {code}");
        var failed = GpuDriverUpdate.ExitMessage(amd, 1603, false, hash);
        Assert(failed.Code == "AGENT_GPU_DRIVER_INSTALL_FAILED" && failed.Args["code"] == "1603" && failed.Args["sha256"] == hash, "another exit code fails with the code");
        Assert(GpuDriverUpdate.ExitMessage(nvidia, -1, false, hash).Args["code"] == "-1", "a negative exit code is reported as it is");
        Assert(GpuDriverUpdate.Arguments["nvidia"].SequenceEqual(["-s", "-noreboot"]) && GpuDriverUpdate.Arguments["amd"].SequenceEqual(["-INSTALL"]), "the fixed silent arguments");

        // ---- Size and free space ----
        Assert(GpuDriverUpdate.RequiredFreeBytes(1_000_000_000) == 3_000_000_000, "three times the package");
        Assert(Code(() => GpuDriverUpdate.AssertFreeSpace(1_000_000_000, 3_000_000_000)) is null, "exactly three times is enough");
        try { GpuDriverUpdate.AssertFreeSpace(1_000_000_000, 2_999_999_999); Assert(false, "too little space"); }
        catch (AgentMessageException e) { Assert(e.Code == "AGENT_GPU_DRIVER_DISK_SPACE" && e.Args["size"] == "3.0 GB", "the disk-space failure names the size needed: " + e.Message); }
        Assert(GpuDriverUpdate.FormatSize(750_000_000) == "750 MB" && GpuDriverUpdate.FormatSize(5_111_570_000) == "5.1 GB", "sizes in MB and GB");

        // ---- AMD Software version from the display class key ----
        const uint device = 0x744C;
        Assert(GpuDriverUpdate.AmdVersionOf([(@"pci\ven_1002&dev_744c&subsys_0e3b1002", "25.10.1")], device) == "25.10.1", "the version of the matching key");
        Assert(GpuDriverUpdate.AmdVersionOf([(@"PCI\VEN_1002&DEV_744C", " 25.10.1 "), (@"pci\ven_10de&dev_2786", "581.57"), (null, "1.0")], device) == "25.10.1", "only the key of this device counts, case-insensitive and trimmed");
        Assert(GpuDriverUpdate.AmdVersionOf([(@"pci\ven_1002&dev_744c", "25.10.1"), (@"pci\ven_1002&dev_744c&subsys_1", "25.10.1")], device) == "25.10.1", "two cards of one model with one version");
        foreach (var (entries, label) in new (IEnumerable<(string?, object?)>, string)[]
        {
            ([], "no display class key"), ([(@"pci\ven_1002&dev_73bf", "25.10.1")], "another AMD device"), ([(@"pci\ven_1002&dev_744c", null)], "no value"),
            ([(@"pci\ven_1002&dev_744c", "25.10")], "too few segments are still a version"), ([(@"pci\ven_1002&dev_744c", "Adrenalin 25.10.1")], "text around the version"),
            ([(@"pci\ven_1002&dev_744c", 251001)], "a DWORD value"), ([(@"pci\ven_1002&dev_744c", "25.10.1\u0000")], "a control character"),
            ([(@"pci\ven_1002&dev_744c", "25.10.1"), (@"pci\ven_1002&dev_744c&subsys_2", "25.9.2")], "two different versions are ambiguous"),
        })
        {
            string? value = GpuDriverUpdate.AmdVersionOf(entries, device);
            Assert(label.StartsWith("too few", StringComparison.Ordinal) ? value == "25.10" : value is null, "AMD version: " + label);
        }
        var row = new JsonObject(); NativeGpuDetails.Text(row, "vendorDriverVersion", GpuDriverUpdate.AmdVersionOf([(@"pci\ven_1002&dev_744c", "25.10.1")], device));
        Assert(row["vendorDriverVersion"]?.GetValue<string>() == "25.10.1", "the AMD version passes the details text rules");

        // ---- The install flow before any download ----
        bool asked = false;
        var refused = await Failure(() => GpuDriverUpdate.InstallAsync(Path.GetTempPath(), Job("intel"), null, CancellationToken.None, _ => { asked = true; return true; }));
        Assert(refused?.Code == "AGENT_GPU_DRIVER_INVALID" && !asked, "invalid parameters fail before the inventory or a download");
        var noGpu = await Failure(() => GpuDriverUpdate.InstallAsync(Path.GetTempPath(), Job("amd", "25.10.1", AmdUrl, 900_000_000), null, CancellationToken.None, vendor => vendor != "amd"));
        Assert(noGpu?.Code == "AGENT_GPU_DRIVER_NO_GPU" && noGpu.Args["vendor"] == "AMD", "no GPU of the vendor in the agent's inventory");
        Interlocked.Exchange(ref GpuDriverUpdate.running, 1);
        try
        {
            var busy = await Failure(() => GpuDriverUpdate.InstallAsync(Path.GetTempPath(), Job(), null, CancellationToken.None, _ => true));
            Assert(busy?.Code == "AGENT_BUSY", "a second GPU driver job is refused while one runs");
        }
        finally { Interlocked.Exchange(ref GpuDriverUpdate.running, 0); }
        Assert(JobRunner.ManagementActions.Contains("install-gpu-driver") && !JobRunner.AllowedInReadOnly("install-gpu-driver"), "the capability is a management action that never runs in ReadOnly mode");
        Assert(RelayGpuDriverSource.SliceBytes * 4 / 3 + 1024 < BrokerProtocol.MaximumFrame, "a base64 slice fits one broker frame");

        // ---- Signatures: one valid SHA-256 or stronger signature of the pinned organization ----
        const string Sha1 = "1.3.14.3.2.26", Sha256 = "2.16.840.1.101.3.4.2.1", Sha384 = "2.16.840.1.101.3.4.2.2", Sha512 = "2.16.840.1.101.3.4.2.3";
        const string Nvidia = "NVIDIA Corporation", Amd = "Advanced Micro Devices, Inc.";
        foreach (var (vendor, signatures, expected, label) in new (string, (int, string?, string?)[], bool, string)[]
        {
            ("nvidia", [(0, Nvidia, Sha256)], true, "one valid SHA-256 vendor signature"),
            ("nvidia", [(0, Nvidia, Sha1), (0, Nvidia, Sha256)], true, "dual-signed: SHA-1 primary and SHA-256 nested"),
            ("nvidia", [(0, Nvidia, Sha1)], false, "a SHA-1 vendor signature only"),
            ("nvidia", [(0, Nvidia, Sha1), (0, Nvidia, Sha1)], false, "two SHA-1 vendor signatures"),
            ("nvidia", [(0, "Other Publisher Inc.", Sha256), (0, Nvidia, Sha256)], true, "another organization as primary, a valid SHA-256 vendor signature nested"),
            ("nvidia", [(0, "Other Publisher Inc.", Sha256), (unchecked((int)0x800B0100), Nvidia, Sha256)], false, "the nested vendor signature does not verify"),
            ("nvidia", [(unchecked((int)0x80096010), Nvidia, Sha256)], false, "a vendor signature with a bad digest"),
            ("nvidia", [], false, "no signatures"),
            ("nvidia", [(0, null, Sha256)], false, "a signature without an organization"),
            ("nvidia", [(0, Nvidia, null)], false, "a signature without a digest algorithm"),
            ("nvidia", [(0, Amd, Sha256)], false, "the other vendor's signature"),
            ("amd", [(0, Amd, Sha256)], true, "AMD with a comma"),
            ("amd", [(0, "Advanced Micro Devices Inc.", Sha384)], true, "AMD without a comma, SHA-384"),
            ("amd", [(0, Amd, Sha512)], true, "AMD SHA-512"),
            ("amd", [(0, "Advanced Micro Devices", Sha256)], false, "an AMD variant that is not pinned"),
            ("intel", [(0, "Intel Corporation", Sha256)], false, "no pinned signer for another vendor"),
        })
            Assert(GpuDriverUpdate.SignatureAccepted(vendor, signatures) == expected, "signature decision: " + label);
        Assert(GpuDriverUpdate.StrongDigests.SequenceEqual([Sha256, Sha384, Sha512]), "SHA-256, SHA-384 and SHA-512 are the accepted digests");

        // ---- The registry of open GPU driver downloads (worker relay) ----
        Registry();
    }

    // An expected failure as "Type: message"; ObjectDisposedException is an InvalidOperationException, so the type is part of the text.
    private static string? Thrown(Action action)
    {
        try { action(); return null; }
        catch (Exception e) when (e is InvalidDataException or InvalidOperationException or IOException) { return e.GetType().Name + ": " + e.Message; }
    }

    // GpuDriverDownloads without HTTP: part files in a temporary folder, cancellation through the parent token.
    private static void Registry()
    {
        const string Unknown = "InvalidDataException: Unknown GPU driver download.";
        var limit = GpuDriverUpdate.DownloadLimit;
        string folder = Path.Combine(Path.GetTempPath(), "serverdesk-gpu-registry-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            string Part(string name) { string path = Path.Combine(folder, "gpu-" + name + ".part"); File.WriteAllBytes(path, new byte[16]); return path; }
            string? Read(GpuDriverDownloads registry, string handle) => Thrown(() => { using var file = registry.OpenPart(handle, registry.Get(handle)); Assert(file.Length == 16, "the part is read"); });
            string a = new('a', 32), b = new('b', 32), c = new('c', 32);

            // A live download: read, untouched by a purge, and the only open one.
            var registry = new GpuDriverDownloads();
            using var first = new CancellationTokenSource();
            string pathA = Part(a);
            var live = registry.Add(a, pathA, limit, first.Token);
            registry.PurgeStale();
            Assert(Read(registry, a) is null && File.Exists(pathA) && registry.Count == 1, "a purge does not touch a live download");
            Assert(Thrown(() => registry.Add(b, Part(b), limit, CancellationToken.None)) == "InvalidOperationException: Another GPU driver download is open.", "at most one download is open");
            Assert(Read(registry, new string('d', 32)) == Unknown, "an unknown handle");

            // Its part goes away while it is open: the clean error.
            File.Delete(pathA);
            Assert(Read(registry, a) == Unknown, "a read whose part is gone");
            File.WriteAllBytes(pathA, new byte[16]);

            // The download goes stale (time limit or broker gone): cancelled, then purged.
            first.Cancel();
            Assert(Read(registry, a) == Unknown, "a read of a cancelled download");
            registry.PurgeStale();
            Assert(registry.Count == 0 && !File.Exists(pathA), "the purge removes the stale download and deletes its part");
            Assert(Read(registry, a) == Unknown, "a read after the purge gets the clean error");
            Assert(!registry.Close(a), "a close after the purge is a no-op");
            // The stale open still holds its entry: token, cancel and its failure path work without ObjectDisposedException.
            Assert(Thrown(() => { _ = live.Token.IsCancellationRequested; live.Cancel(); registry.Fail(a, live); }) is null && live.Cancelled, "the stale open ends on its failure path without ObjectDisposedException");

            // A read that got the entry before the purge, and opens the part after it.
            using var second = new CancellationTokenSource();
            string pathB = Part(b);
            var older = registry.Add(b, pathB, limit, second.Token);
            var held = registry.Get(b);
            second.Cancel(); registry.PurgeStale();
            Assert(Thrown(() => registry.OpenPart(b, held).Dispose()) == Unknown, "get, purge, then open: the clean error");
            File.WriteAllBytes(pathB, new byte[16]); // As if the delete of the purge had failed.
            Assert(Thrown(() => registry.OpenPart(b, held).Dispose()) == Unknown, "a removed download is unknown even while its part exists");
            Assert(Thrown(() => { _ = held.Token; held.Cancel(); }) is null, "the held entry stays usable after the purge");

            // A newer download under the same handle: the stale open's failure leaves it alone.
            File.Delete(pathB);
            string newerPath = Path.Combine(folder, "newer.part"); File.WriteAllBytes(newerPath, new byte[16]);
            var newer = registry.Add(b, newerPath, limit, CancellationToken.None);
            registry.Fail(b, older);
            Assert(registry.Count == 1 && File.Exists(newerPath) && ReferenceEquals(registry.Get(b), newer) && Read(registry, b) is null, "the failure of a stale open does not remove or delete a newer download");
            Assert(Thrown(() => registry.OpenPart(b, held).Dispose()) == Unknown, "the stale entry does not read the newer download");

            // Close: removes, deletes and disposes; a running open or read that still holds the entry gets no ObjectDisposedException.
            Assert(registry.Close(b) && registry.Count == 0 && !File.Exists(newerPath), "the close removes the download and deletes its part");
            Assert(Thrown(() => { _ = newer.Token.IsCancellationRequested; newer.Cancel(); registry.Fail(b, newer); }) is null && newer.Cancelled, "the open of a closed download ends without ObjectDisposedException");
            Assert(Thrown(() => registry.OpenPart(b, newer).Dispose()) == Unknown && !registry.Close(b), "a read and a second close after the close");

            // A failed open removes its own entry and part, so the next download can open.
            var failing = registry.Add(c, Part(c), limit, CancellationToken.None);
            registry.Fail(c, failing);
            Assert(registry.Count == 0 && !File.Exists(Path.Combine(folder, "gpu-" + c + ".part")) && Read(registry, c) == Unknown, "a failed open removes its entry and its part");
            _ = registry.Add(a, Part(a), limit, CancellationToken.None);
            Assert(Read(registry, a) is null && registry.Close(a), "the next download opens after a failure");
        }
        finally { try { Directory.Delete(folder, true); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
    }
}

