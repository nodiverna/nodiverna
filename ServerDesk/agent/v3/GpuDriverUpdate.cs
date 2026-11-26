using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace ServerDesk.Agent;

// The vendor package of an install-gpu-driver job (agent 4.13.0, docs/gpu-driver-updates.md).
internal sealed record GpuDriverJob(string Vendor, string Version, Uri Url, long SizeBytes)
{
    internal string VendorName => GpuDriverUpdate.VendorNames[Vendor];
}

// Broker side: the download of a vendor package through the worker relay. The
// broker opens no network connection; the worker downloads from the allow-listed
// vendor host and the broker copies the bytes into its own staging folder.
internal interface IGpuDriverSource
{
    Task CopyAsync(GpuDriverJob job, Stream output, IncrementalHash hash, CancellationToken token);
}

// Installs an NVIDIA or AMD graphics driver package. The portal resolves URL and
// size from the vendor's catalog; the agent trusts neither beyond its own rules:
// the URL must name a fixed vendor download host (a constant here, not portal
// data), the size is capped, the staged copy must carry a valid Authenticode
// signature (SHA-256 or stronger, primary or nested) of the pinned vendor
// organization, and the installer runs with
// fixed silent arguments only. The agent never restarts the device.
internal static class GpuDriverUpdate
{
    internal static readonly IReadOnlyDictionary<string, string> VendorNames = new Dictionary<string, string>(StringComparer.Ordinal) { ["nvidia"] = "NVIDIA", ["amd"] = "AMD" };
    // The same lists as gpuDriverDownloadHosts in lib/server/devices/gpu-drivers/catalog.ts.
    internal static readonly IReadOnlyDictionary<string, string[]> AllowedHosts = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["nvidia"] = ["us.download.nvidia.com", "international.download.nvidia.com"],
        ["amd"] = ["drivers.amd.com"],
    };
    // The subject organization (O=) of the signer certificate.
    internal static readonly IReadOnlyDictionary<string, string[]> Signers = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["nvidia"] = ["NVIDIA Corporation"],
        ["amd"] = ["Advanced Micro Devices, Inc.", "Advanced Micro Devices Inc."],
    };
    // Fixed silent-install arguments. No portal value goes into a command line.
    internal static readonly IReadOnlyDictionary<string, string[]> Arguments = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["nvidia"] = ["-s", "-noreboot"],
        ["amd"] = ["-INSTALL"],
    };
    // Exit codes that mean "installed, restart required" (Windows Installer convention). Confirm on hardware (docs).
    internal static readonly IReadOnlyDictionary<string, int[]> RebootExitCodes = new Dictionary<string, int[]>(StringComparer.Ordinal)
    {
        ["nvidia"] = [3010, 1641],
        ["amd"] = [3010, 1641],
    };
    internal const string AmdReferer = "https://www.amd.com/";
    internal const long MaximumBytes = 3L * 1024 * 1024 * 1024;
    internal const int FreeSpaceFactor = 3;
    internal static readonly TimeSpan DownloadLimit = TimeSpan.FromMinutes(30), InstallLimit = TimeSpan.FromMinutes(30);
    private static readonly Regex VersionPattern = new(@"^\d{1,4}(\.\d{1,5}){1,3}$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));
    // 1 while a GPU driver job runs (the self-test sets it to check the refusal).
    internal static int running;

    /// <summary>True for an https URL without user info, port, query or fragment on one of the vendor's download hosts.</summary>
    internal static bool AllowedUrl(string vendor, string? url) => ParseUrl(vendor, url) is not null;
    private static Uri? ParseUrl(string vendor, string? url)
    {
        if (string.IsNullOrEmpty(url) || url.Length > 2048 || !AllowedHosts.TryGetValue(vendor, out var hosts)) return null;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return null;
        return uri.Scheme == Uri.UriSchemeHttps && uri.UserInfo.Length == 0 && uri.IsDefaultPort && uri.Fragment.Length == 0 && !url.Contains('@') && hosts.Contains(uri.IdnHost, StringComparer.Ordinal) ? uri : null;
    }

    /// <summary>Pure: vendor, version, URL on the allow list and a size of 1 byte to 3 GiB, else AGENT_GPU_DRIVER_INVALID before any download.</summary>
    internal static GpuDriverJob Validate(JsonObject p)
    {
        static string? Text(JsonObject p, string key) { try { return p[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null; } catch (Exception) { return null; } }
        static long? Size(JsonObject p) { try { return p["sizeBytes"] is JsonValue value && value.TryGetValue<long>(out long size) ? size : null; } catch (Exception) { return null; } }
        string? vendor = Text(p, "vendor"), version = Text(p, "version"), url = Text(p, "url"); long? size = Size(p);
        if (p.Count != 4 || vendor is null || !VendorNames.ContainsKey(vendor) || version is null || !VersionPattern.IsMatch(version) || size is not (>= 1 and <= MaximumBytes)) throw new AgentMessageException("AGENT_GPU_DRIVER_INVALID");
        var uri = ParseUrl(vendor, url) ?? throw new AgentMessageException("AGENT_GPU_DRIVER_INVALID");
        return new GpuDriverJob(vendor, version, uri, size.Value);
    }

    /// <summary>The free space the system drive needs: three times the package (download, staged copy, extraction).</summary>
    internal static long RequiredFreeBytes(long size) => checked(size * FreeSpaceFactor);
    internal static string FormatSize(long bytes) => bytes >= 1_000_000_000 ? (bytes / 1e9).ToString("0.0", CultureInfo.InvariantCulture) + " GB" : Math.Max(1, (long)Math.Ceiling(bytes / 1e6)).ToString(CultureInfo.InvariantCulture) + " MB";
    internal static void AssertFreeSpace(long size, long available)
    {
        long required = RequiredFreeBytes(size);
        if (available < required) throw new AgentMessageException("AGENT_GPU_DRIVER_DISK_SPACE", ("size", FormatSize(required)));
    }

    /// <summary>True when the subject organization matches the vendor's pinned signer exactly.</summary>
    internal static bool SignerMatches(string vendor, string? organization) => organization is not null && Signers.TryGetValue(vendor, out var names) && names.Contains(organization, StringComparer.Ordinal);
    internal static string? Organization(X500DistinguishedName subject)
    {
        foreach (var name in subject.EnumerateRelativeDistinguishedNames())
            if (name.GetSingleElementType().Value == "2.5.4.10") return name.GetSingleElementValue()?.Trim();
        return null;
    }

    /// <summary>The job result of an installer exit code. pendingAfter: a reboot is pending after exit code 0.</summary>
    internal static AgentMessage ExitMessage(GpuDriverJob job, int exitCode, bool pendingAfter, string sha256)
    {
        if (exitCode == 0) return AgentMessages.Of(pendingAfter ? "AGENT_GPU_DRIVER_INSTALLED_REBOOT" : "AGENT_GPU_DRIVER_INSTALLED", ("version", job.Version), ("sha256", sha256));
        if (RebootExitCodes[job.Vendor].Contains(exitCode)) return AgentMessages.Of("AGENT_GPU_DRIVER_INSTALLED_REBOOT", ("version", job.Version), ("sha256", sha256));
        return AgentMessages.Of("AGENT_GPU_DRIVER_INSTALL_FAILED", ("code", exitCode), ("sha256", sha256));
    }

    /// <summary>The installed AMD Software version of a device: RadeonSoftwareVersion of the display class key whose MatchingDeviceId names VEN_1002 and the device. Null when missing, ambiguous or malformed.</summary>
    internal static string? AmdSoftwareVersion(uint deviceId)
    {
        if (!OperatingSystem.IsWindows()) return null;
        try
        {
            using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            using var display = machine.OpenSubKey(DisplayClass);
            if (display is null) return null;
            var entries = new List<(string?, object?)>();
            foreach (string name in display.GetSubKeyNames().Where(name => name.Length == 4 && name.All(char.IsAsciiDigit)).Take(64))
            {
                try { using var key = display.OpenSubKey(name); if (key is not null) entries.Add((key.GetValue("MatchingDeviceId") as string, key.GetValue("RadeonSoftwareVersion"))); }
                catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException) { }
            }
            return AmdVersionOf(entries, deviceId);
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException) { return null; }
    }
    internal const string DisplayClass = @"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    /// <summary>Pure: the one valid version among the entries of this device, null when none or when they differ.</summary>
    internal static string? AmdVersionOf(IEnumerable<(string? MatchingDeviceId, object? Value)> entries, uint deviceId)
    {
        string device = "VEN_1002&DEV_" + deviceId.ToString("X4", CultureInfo.InvariantCulture);
        var values = entries.Where(entry => entry.MatchingDeviceId is not null && entry.MatchingDeviceId.Contains(device, StringComparison.OrdinalIgnoreCase)).Select(entry => entry.Value).ToArray();
        if (values.Length == 0 || values.Any(value => value is not string text || !VersionPattern.IsMatch(text.Trim()) || text.Length > 128))
            return null;
        var distinct = values.Select(value => ((string)value!).Trim()).Distinct(StringComparer.Ordinal).ToArray();
        return distinct.Length == 1 ? distinct[0] : null;
    }

    /// <summary>True when the agent's own GPU inventory (DXGI) lists a physical adapter of the vendor.</summary>
    internal static bool InventoryHasGpu(string vendor)
    {
        using var source = new WindowsGpuInventorySource();
        return source.Adapters().Any(adapter => NativeGpuInventory.Vendor(adapter) == vendor);
    }

    internal static string StagingRoot(string root) => Path.Combine(root, "gpu-driver");
    /// <summary>Deletes staging folders that a previous broker left behind, through handles (StagingFiles).</summary>
    internal static void CleanStaging(string root, Action<string>? log = null)
    {
        string staging = StagingRoot(root);
        if (!OperatingSystem.IsWindows() || !Directory.Exists(staging)) return;
        foreach (string folder in Directory.GetDirectories(staging)) try { StagingFiles.DeleteFolder(folder, true, log ?? (_ => { })); } catch (Exception e) { log?.Invoke("GPU driver staging cleanup: " + e.Message); }
    }

    internal static async Task<AgentMessage> InstallAsync(string root, JsonObject p, IGpuDriverSource? source, CancellationToken token, Func<string, bool>? hasGpu = null)
    {
        var job = Validate(p);
        if (Interlocked.CompareExchange(ref running, 1, 0) != 0) throw new AgentMessageException("AGENT_BUSY");
        string? folder = null;
        try
        {
            if (!(hasGpu ?? InventoryHasGpu)(job.Vendor)) throw new AgentMessageException("AGENT_GPU_DRIVER_NO_GPU", ("vendor", job.VendorName));
            AssertFreeSpace(job.SizeBytes, new DriveInfo(Path.GetPathRoot(Environment.SystemDirectory)!).AvailableFreeSpace);
            if (source is null) throw new AgentMessageException("AGENT_GPU_DRIVER_DOWNLOAD_FAILED", ("host", job.Url.IdnHost));
            Directory.CreateDirectory(StagingRoot(root));
            // A new folder per job: created with a protected DACL for SYSTEM and Administrators, checked through a handle.
            folder = Path.Combine(StagingRoot(root), Guid.NewGuid().ToString("N"));
            StagingFiles.CreateNew(folder, secure: true); StagingFiles.VerifyNew(folder, secure: true);
            string file = Path.Combine(folder, job.Vendor + "-driver.exe");
            string sha256;
            using (var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
            {
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(DownloadLimit);
                try
                {
                    await using var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 20, true);
                    await source.CopyAsync(job, output, hash, deadline.Token);
                    if (output.Length != job.SizeBytes) throw new InvalidDataException("The staged package has the wrong size.");
                }
                catch (Exception e) when (!token.IsCancellationRequested) { throw new AgentMessageException(e, "AGENT_GPU_DRIVER_DOWNLOAD_FAILED", ("host", job.Url.IdnHost)); }
                sha256 = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            }
            // The pinned handle keeps the verified file unchanged until the installer has run.
            using var pinned = StagingFiles.Pin(folder, file);
            if (!SignedBy(job.Vendor, file, pinned.Stream.SafeFileHandle.DangerousGetHandle())) throw new AgentMessageException("AGENT_GPU_DRIVER_SIGNATURE", ("vendor", job.VendorName));
            int exitCode = await RunInstallerAsync(job, file, folder, token);
            return ExitMessage(job, exitCode, exitCode == 0 && NativeRebootStatus.Read().Pending, sha256);
        }
        finally
        {
            if (folder is not null) try { StagingFiles.DeleteFolder(folder, true, _ => { }); } catch (Exception) { }
            Volatile.Write(ref running, 0);
        }
    }

    // The verified file itself, without cmd.exe or PowerShell, with the fixed arguments.
    private static async Task<int> RunInstallerAsync(GpuDriverJob job, string file, string folder, CancellationToken token)
    {
        var start = new ProcessStartInfo(file) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = folder };
        foreach (string argument in Arguments[job.Vendor]) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new AgentMessageException("AGENT_GPU_DRIVER_INSTALL_FAILED", ("code", -1), ("sha256", ""));
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token); limit.CancelAfter(InstallLimit);
        try { await process.WaitForExitAsync(limit.Token); }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch (Exception) { }
            try { await process.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(30), CancellationToken.None); } catch (Exception) { }
            if (token.IsCancellationRequested) throw;
            throw new AgentMessageException("AGENT_GPU_DRIVER_TIMEOUT");
        }
        return process.ExitCode;
    }

    // The digest algorithms a vendor signature may use: SHA-256, SHA-384, SHA-512. SHA-1 does not count.
    internal static readonly string[] StrongDigests = ["2.16.840.1.101.3.4.2.1", "2.16.840.1.101.3.4.2.2", "2.16.840.1.101.3.4.2.3"];
    // More signatures than this are not read; a vendor installer has one or two.
    internal const int MaximumSignatures = 16;

    /// <summary>
    /// Pure: true when at least one signature of the file is valid (result 0), comes
    /// from the vendor's pinned organization and uses SHA-256 or stronger. All
    /// Authenticode signatures of a file cover the same file digest, so a nested
    /// vendor signature counts like the primary one.
    /// </summary>
    internal static bool SignatureAccepted(string vendor, IReadOnlyList<(int Result, string? Organization, string? DigestOid)> signatures) =>
        signatures.Any(signature => signature.Result == 0 && SignerMatches(vendor, signature.Organization) && signature.DigestOid is not null && StrongDigests.Contains(signature.DigestOid, StringComparer.Ordinal));

    // Every Authenticode signature of the pinned file, each verified by
    // WinVerifyTrust on the open handle; the signer comes from the same call.
    private static bool SignedBy(string vendor, string path, IntPtr handle)
    {
        if (!OperatingSystem.IsWindows()) return false;
        try { return SignatureAccepted(vendor, Signatures(path, handle)); }
        catch (Exception e) when (e is CryptographicException or IOException or UnauthorizedAccessException or ArgumentException or OutOfMemoryException) { return false; }
    }

    // Index 0 is the primary signature; its call also reports the number of nested (secondary) signatures.
    private static List<(int Result, string? Organization, string? DigestOid)> Signatures(string path, IntPtr handle)
    {
        var signatures = new List<(int Result, string? Organization, string? DigestOid)>();
        uint secondary = 0;
        for (uint index = 0; index <= secondary && index < MaximumSignatures; index++)
        {
            var (result, organization, digest, count) = Verify(path, handle, index);
            if (index == 0) secondary = count;
            signatures.Add((result, organization, digest));
        }
        return signatures;
    }

    private const uint WssVerifySpecific = 0x1, WssGetSecondarySigCount = 0x2;
    private const uint StateActionVerify = 1, StateActionClose = 2;

    // One WinVerifyTrust call for the signature at index: UI none, WTD_REVOKE_WHOLECHAIN,
    // file choice, revocation check of the chain without the root, no MD2/MD4.
    // The signer is read from the call's state before the state is closed.
    private static (int Result, string? Organization, string? DigestOid, uint Secondary) Verify(string path, IntPtr handle, uint index)
    {
        Guid action = new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE"); // WINTRUST_ACTION_GENERIC_VERIFY_V2
        IntPtr info = IntPtr.Zero, settings = IntPtr.Zero; bool fileMarshalled = false, opened = false;
        var data = new WintrustData { cbStruct = (uint)Marshal.SizeOf<WintrustData>(), dwUIChoice = 2, fdwRevocationChecks = 1, dwUnionChoice = 1, dwStateAction = StateActionVerify, dwProvFlags = 0x80 | 0x2000 };
        try
        {
            info = Marshal.AllocHGlobal(Marshal.SizeOf<WintrustFileInfo>());
            Marshal.StructureToPtr(new WintrustFileInfo { cbStruct = (uint)Marshal.SizeOf<WintrustFileInfo>(), pcwszFilePath = path, hFile = handle }, info, false); fileMarshalled = true;
            settings = Marshal.AllocHGlobal(Marshal.SizeOf<WintrustSignatureSettings>());
            Marshal.StructureToPtr(new WintrustSignatureSettings { cbStruct = (uint)Marshal.SizeOf<WintrustSignatureSettings>(), dwIndex = index, dwFlags = WssVerifySpecific | (index == 0 ? WssGetSecondarySigCount : 0) }, settings, false);
            data.pInfo = info; data.pSignatureSettings = settings;
            opened = true;
            int result = WinVerifyTrust(new IntPtr(-1), ref action, ref data);
            uint secondary = index == 0 ? Marshal.PtrToStructure<WintrustSignatureSettings>(settings).cSecondarySigs : 0;
            var (organization, digest) = result == 0 ? Signer(data.hWVTStateData) : (null, null);
            return (result, organization, digest, secondary);
        }
        finally
        {
            // Close the state of every verify call, also after an exception.
            if (opened) { data.dwStateAction = StateActionClose; WinVerifyTrust(new IntPtr(-1), ref action, ref data); }
            if (fileMarshalled) Marshal.DestroyStructure<WintrustFileInfo>(info);
            if (info != IntPtr.Zero) Marshal.FreeHGlobal(info);
            if (settings != IntPtr.Zero) Marshal.FreeHGlobal(settings);
        }
    }

    // The signer of a verified state: its leaf certificate (organization) and its digest algorithm.
    private static (string? Organization, string? DigestOid) Signer(IntPtr state)
    {
        IntPtr provider = state == IntPtr.Zero ? IntPtr.Zero : WTHelperProvDataFromStateData(state);
        IntPtr signerPointer = provider == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvSignerFromChain(provider, 0, false, 0);
        if (signerPointer == IntPtr.Zero) return (null, null);
        var signer = Marshal.PtrToStructure<CryptProviderSgnr>(signerPointer);
        if (signer.cbStruct < Marshal.SizeOf<CryptProviderSgnr>() || signer.psSigner == IntPtr.Zero) return (null, null);
        string? digest = Marshal.PtrToStructure<CmsgSignerInfo>(signer.psSigner).HashAlgorithmObjId is var oid && oid != IntPtr.Zero ? Marshal.PtrToStringAnsi(oid) : null;
        IntPtr certificatePointer = WTHelperGetProvCertFromChain(signerPointer, 0);
        if (certificatePointer == IntPtr.Zero) return (null, digest);
        var leaf = Marshal.PtrToStructure<CryptProviderCert>(certificatePointer);
        if (leaf.cbStruct < Marshal.SizeOf<CryptProviderCert>() || leaf.pCert == IntPtr.Zero) return (null, digest);
        // A copy of the certificate context: it stays valid after the state is closed, and it is disposed here.
        using var certificate = new X509Certificate2(leaf.pCert);
        return (Organization(certificate.SubjectName), digest);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct WintrustFileInfo { public uint cbStruct; public string pcwszFilePath; public IntPtr hFile; public IntPtr pgKnownSubject; }
    [StructLayout(LayoutKind.Sequential)] private struct WintrustData { public uint cbStruct; public IntPtr pPolicyCallbackData; public IntPtr pSIPClientData; public uint dwUIChoice; public uint fdwRevocationChecks; public uint dwUnionChoice; public IntPtr pInfo; public uint dwStateAction; public IntPtr hWVTStateData; public IntPtr pwszURLReference; public uint dwProvFlags; public uint dwUIContext; public IntPtr pSignatureSettings; }
    // WINTRUST_SIGNATURE_SETTINGS.
    [StructLayout(LayoutKind.Sequential)] private struct WintrustSignatureSettings { public uint cbStruct; public uint dwIndex; public uint dwFlags; public uint cSecondarySigs; public uint dwVerifiedSigIndex; public IntPtr pCryptoPolicy; }
    // The start of CRYPT_PROVIDER_SGNR up to psSigner (FILETIME as two DWORDs).
    [StructLayout(LayoutKind.Sequential)] private struct CryptProviderSgnr { public uint cbStruct; public uint sftVerifyAsOfLow; public uint sftVerifyAsOfHigh; public uint csCertChain; public IntPtr pasCertChain; public uint dwSignerType; public IntPtr psSigner; }
    // The start of CRYPT_PROVIDER_CERT up to pCert.
    [StructLayout(LayoutKind.Sequential)] private struct CryptProviderCert { public uint cbStruct; public IntPtr pCert; }
    [StructLayout(LayoutKind.Sequential)] private struct CryptoBlob { public uint cbData; public IntPtr pbData; }
    // The start of CMSG_SIGNER_INFO up to HashAlgorithm.pszObjId.
    [StructLayout(LayoutKind.Sequential)] private struct CmsgSignerInfo { public uint dwVersion; public CryptoBlob Issuer; public CryptoBlob SerialNumber; public IntPtr HashAlgorithmObjId; }
    [DllImport("wintrust.dll", CharSet = CharSet.Unicode)] private static extern int WinVerifyTrust(IntPtr hwnd, ref Guid action, ref WintrustData data);
    [DllImport("wintrust.dll")] private static extern IntPtr WTHelperProvDataFromStateData(IntPtr stateData);
    [DllImport("wintrust.dll")] private static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr providerData, uint signerIndex, [MarshalAs(UnmanagedType.Bool)] bool counterSigner, uint counterSignerIndex);
    [DllImport("wintrust.dll")] private static extern IntPtr WTHelperGetProvCertFromChain(IntPtr signer, uint certificateIndex);
}
