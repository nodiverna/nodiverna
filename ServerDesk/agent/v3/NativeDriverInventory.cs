using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace ServerDesk.Agent;

// Devices with an error in Device Manager and the driver inventory
// (docs/v3-health-signals.md). Since 4.11.1 the read uses no WMI: CfgMgr32 gives
// the present devices with their problem code and driver properties, the
// registry gives the image path of a device's service, and an offline catalog
// check of %SystemRoot%\INF\<infName> gives the signature. A device is
// identified by the first 16 hex characters of the SHA-256 of its device
// instance ID; the ID itself never leaves the device. The snapshot carries the
// problems and a summary; the full list is sent only when its checksum changes
// (SoftwareUploadPolicy).
internal interface IDriverSource
{
    /// <summary>The present devices.</summary>
    IReadOnlyList<DriverDevice> Devices();
    /// <summary>The ImagePath of HKLM\SYSTEM\CurrentControlSet\Services\&lt;service&gt;, or null.</summary>
    string? ServiceImagePath(string service);
    /// <summary>Size and last write time (UTC) of %SystemRoot%\INF\&lt;infName&gt;, or null when the file does not exist.</summary>
    (long Size, DateTime LastWriteUtc)? InfFile(string infName);
    /// <summary>valid, invalid, unsigned or unknown, and the signer's common name, of %SystemRoot%\INF\&lt;infName&gt;.</summary>
    (string Signature, string? Signer) InfSignature(string infName);
}

/// <summary>One present device. ProblemCode is 0 when Device Manager reports no problem; DriverDate is a FILETIME.</summary>
internal sealed record DriverDevice(string Id, int ProblemCode, string? Name, string? Class, string? Manufacturer, string? Service, string? InfName, string? Version, long? DriverDate, string? Provider);

internal sealed record DriverEntry(string Key, string DeviceName, string? DeviceClass, string? InfName, string? File, string? Service, string? Provider, string? Version, string? Date, bool? Signed, string? Signer);

/// <summary>The time of one driver read, for the broker log.</summary>
internal sealed record DriverRunTiming(int Drivers, int Devices, long TotalMs, long DevicesMs, long ServicesMs, long SignaturesMs, int Pending);

internal sealed class NativeDriverInventory(IDriverSource? source = null, Func<DateTimeOffset>? clock = null, Func<long>? milliseconds = null, TimeSpan? signatureBudget = null)
{
    internal const int IntervalSeconds = 900;
    // The budgets of the driver read, set together. The device read (CfgMgr32 and
    // the registry) takes well under a second. Signature checks of INF files that
    // are not cached stop after SignatureBudgetSeconds; the files left over stay
    // null and are checked first in the next run. The worker's collector deadline
    // is DeadlineSeconds, and its broker call waits BrokerCallSeconds
    // (AgentWorker.PrivilegedCallSeconds: the deadline plus 15 s, at least 45 s).
    internal const int SignatureBudgetSeconds = 20;
    internal const int DeadlineSeconds = 45;
    internal static int BrokerCallSeconds => AgentWorker.PrivilegedCallSeconds(DeadlineSeconds);
    // The broker logs the time of the first run after its start and of every run above this limit.
    internal const int TimingLogMilliseconds = 5000;
    internal const int SignatureCacheSize = 4000;
    internal const int MaximumItems = 2000;
    internal const int MaximumProblems = 100;
    internal const int MaximumUnsigned = 20;
    // The portal accepts at most 1 MiB per report; the list stays below this budget.
    internal const int MaximumBytes = 900_000;
    // The driver list travels with the collector result under this key, never in the snapshot.
    internal const string InventoryKey = "_driverInventory";
    private readonly IDriverSource drivers = source ?? new WindowsDriverSource();
    private readonly Func<DateTimeOffset> now = clock ?? (() => DateTimeOffset.UtcNow);
    private readonly Func<long> elapsed = milliseconds ?? (() => Environment.TickCount64);
    private readonly long budgetMs = (long)(signatureBudget ?? TimeSpan.FromSeconds(SignatureBudgetSeconds)).TotalMilliseconds;
    private readonly object gate = new();
    // Signature results by (INF name, file size, last write time UTC), for the life of the broker process.
    private readonly Dictionary<(string Inf, long Size, long Ticks), (bool? Signed, string? Signer)> signatures = new();
    private HashSet<string> pending = new(StringComparer.OrdinalIgnoreCase);
    private bool timingLogged;

    /// <summary>The time of the last completed run, or null before the first one.</summary>
    internal DriverRunTiming? LastRun { get; private set; }
    /// <summary>The number of cached signature results.</summary>
    internal int CachedSignatures { get { lock (gate) return signatures.Count; } }

    internal JsonObject Collect()
    {
        lock (gate)
        {
            long begin = elapsed();
            var devices = drivers.Devices();
            long afterDevices = elapsed();
            var files = ServiceFiles(devices);
            long afterServices = elapsed();
            var signed = Signatures(devices, out int left);
            long afterSignatures = elapsed();
            var problems = Problems(devices);
            var (items, count, truncated) = Inventory(devices, files, signed);
            string checksum = Checksum(items);
            var unsigned = items.Where(item => item.Signed == false).ToList();
            var health = new JsonObject
            {
                ["collectedAt"] = now().ToString("O", CultureInfo.InvariantCulture), ["checksum"] = checksum, ["count"] = count, ["truncated"] = truncated,
                ["unsignedCount"] = unsigned.Count,
                ["unsigned"] = new JsonArray(unsigned.OrderBy(item => item.DeviceName, StringComparer.OrdinalIgnoreCase).ThenBy(item => item.Key, StringComparer.Ordinal).Take(MaximumUnsigned)
                    .Select(item => (JsonNode)new JsonObject { ["key"] = item.Key, ["deviceName"] = item.DeviceName, ["infName"] = item.InfName, ["file"] = item.File, ["provider"] = item.Provider, ["version"] = item.Version }).ToArray()),
                ["problems"] = new JsonArray(problems.Take(MaximumProblems).Select(problem => (JsonNode)problem.DeepClone()).ToArray()),
                ["problemsTruncated"] = problems.Count > MaximumProblems,
            };
            LastRun = new DriverRunTiming(count, devices.Count, elapsed() - begin, afterDevices - begin, afterServices - afterDevices, afterSignatures - afterServices, left);
            return new JsonObject
            {
                ["driverHealth"] = health,
                [InventoryKey] = new JsonObject { ["checksum"] = checksum, ["count"] = count, ["truncated"] = truncated, ["items"] = new JsonArray(items.Select(Item).ToArray()) }
            };
        }
    }

    /// <summary>The broker's timing line for the last run: for the first run of this process and for every run above TimingLogMilliseconds, else null.</summary>
    internal string? TimingLogLine()
    {
        lock (gate)
        {
            if (LastRun is not { } run || timingLogged && run.TotalMs <= TimingLogMilliseconds) return null;
            timingLogged = true;
            return TimingLine(run);
        }
    }

    internal static string TimingLine(DriverRunTiming run) => string.Create(CultureInfo.InvariantCulture,
        $"Broker telemetry Drivers: {run.Drivers} drivers, {run.Devices} devices in {run.TotalMs} ms (devices {run.DevicesMs} ms, services {run.ServicesMs} ms, signatures {run.SignaturesMs} ms, {run.Pending} INF files not checked yet).");

    /// <summary>The first 16 hex characters (lower case) of the SHA-256 of the upper-case device instance ID.</summary>
    internal static string DeviceKey(string deviceId) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(deviceId.Trim().ToUpperInvariant())))[..16].ToLowerInvariant();

    internal static List<JsonObject> Problems(IReadOnlyList<DriverDevice> devices)
    {
        var result = new List<JsonObject>();
        foreach (var device in devices)
        {
            string? id = Clean(device.Id);
            if (device.ProblemCode <= 0 || id is null) continue;
            result.Add(new JsonObject { ["key"] = DeviceKey(id), ["name"] = Clean(device.Name) ?? "Unknown device", ["class"] = Clean(device.Class), ["code"] = Math.Min(device.ProblemCode, 999), ["manufacturer"] = Clean(device.Manufacturer) });
        }
        return result.OrderBy(problem => problem["name"]!.GetValue<string>(), StringComparer.OrdinalIgnoreCase).ThenBy(problem => problem["key"]!.GetValue<string>(), StringComparer.Ordinal).ToList();
    }

    /// <summary>The drivers: every device with an INF name or a driver version. The driver class is upper case, as Win32_PnPSignedDriver reported it in 4.11.0.</summary>
    internal static (List<DriverEntry> Items, int Count, bool Truncated) Inventory(IReadOnlyList<DriverDevice> devices, IReadOnlyDictionary<string, string?>? files = null, IReadOnlyDictionary<string, (bool? Signed, string? Signer)>? signed = null)
    {
        var entries = new Dictionary<string, DriverEntry>(StringComparer.Ordinal);
        foreach (var device in devices)
        {
            string? id = Clean(device.Id);
            string? inf = Clean(device.InfName), version = Clean(device.Version);
            if (id is null || inf is null && version is null) continue;
            string key = DeviceKey(id);
            string? service = Clean(device.Service);
            string? file = service is null ? null : files?.GetValueOrDefault(service);
            var (isSigned, signer) = inf is not null && signed is not null && signed.TryGetValue(inf, out var signature) ? signature : (null, null);
            entries[key] = new DriverEntry(key, Clean(device.Name) ?? "Unknown device", Clean(device.Class)?.ToUpperInvariant(), inf, file, service, Clean(device.Provider), version, DriverDate(device.DriverDate), isSigned, Clean(signer));
        }
        var all = entries.Values.OrderBy(entry => entry.Key, StringComparer.Ordinal).ToList();
        var items = all.Take(MaximumItems).ToList();
        int bytes = 2;
        for (int i = 0; i < items.Count; i++)
        {
            bytes += Encoding.UTF8.GetByteCount(Item(items[i]).ToJsonString()) + 1;
            if (bytes > MaximumBytes) { items.RemoveRange(i, items.Count - i); break; }
        }
        return (items, all.Count, all.Count > items.Count);
    }

    // service → driver file name, one registry read per service.
    private Dictionary<string, string?> ServiceFiles(IReadOnlyList<DriverDevice> devices)
    {
        var files = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (var device in devices)
        {
            if (Clean(device.Service) is not string service || files.ContainsKey(service) || Clean(device.InfName) is null && Clean(device.Version) is null) continue;
            try { files[service] = FileName(drivers.ServiceImagePath(service)); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or SecurityException or ArgumentException) { files[service] = null; }
        }
        return files;
    }

    // Signature per unique INF. Cached results cost nothing; the other INF files
    // are checked within the budget, the ones left over by the last run first.
    private Dictionary<string, (bool? Signed, string? Signer)> Signatures(IReadOnlyList<DriverDevice> devices, out int left)
    {
        var result = new Dictionary<string, (bool?, string?)>(StringComparer.OrdinalIgnoreCase);
        var due = new List<(string Inf, (string, long, long) Key)>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var device in devices)
        {
            if (Clean(device.InfName) is not string inf || !seen.Add(inf)) continue;
            (long Size, DateTime LastWriteUtc)? file = null;
            if (IsInfName(inf))
            {
                try { file = drivers.InfFile(inf); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or SecurityException or ArgumentException or NotSupportedException) { }
            }
            if (file is not { } found) { result[inf] = (null, null); continue; }
            var key = (inf.ToLowerInvariant(), found.Size, found.LastWriteUtc.Ticks);
            if (signatures.TryGetValue(key, out var cached)) result[inf] = cached;
            else due.Add((inf, key));
        }
        var remaining = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long start = elapsed(), slowest = 0;
        foreach (var (inf, key) in due.OrderBy(item => pending.Contains(item.Inf) ? 0 : 1).ThenBy(item => item.Inf, StringComparer.OrdinalIgnoreCase))
        {
            // Stop before a check that would likely end past the budget.
            if (elapsed() - start + slowest > budgetMs) { remaining.Add(inf); result[inf] = (null, null); continue; }
            long before = elapsed();
            (string Signature, string? Signer) checkedValue;
            try { checkedValue = drivers.InfSignature(inf); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or SecurityException or ArgumentException or Win32Exception or COMException) { checkedValue = ("unknown", null); }
            slowest = Math.Max(slowest, elapsed() - before);
            var value = SignatureValue(checkedValue.Signature, checkedValue.Signer);
            result[inf] = value;
            // "unknown" (the file cannot be read) is checked again in the next run.
            if (checkedValue.Signature == "unknown") continue;
            if (signatures.Count >= SignatureCacheSize)
            {
                var current = new HashSet<string>(result.Keys.Select(name => name.ToLowerInvariant()), StringComparer.Ordinal);
                foreach (var stale in signatures.Keys.Where(cachedKey => !current.Contains(cachedKey.Inf)).ToList()) signatures.Remove(stale);
            }
            if (signatures.Count < SignatureCacheSize) signatures[key] = value;
        }
        pending = remaining;
        left = remaining.Count;
        return result;
    }

    /// <summary>valid → signed with the signer; invalid or unsigned → not signed; unknown → null.</summary>
    internal static (bool? Signed, string? Signer) SignatureValue(string signature, string? signer) => signature switch
    {
        "valid" => (true, Clean(signer)),
        "invalid" or "unsigned" => (false, null),
        _ => (null, null)
    };

    /// <summary>A plain INF file name (oem42.inf, machine.inf), never a path.</summary>
    internal static bool IsInfName(string? name) => name is { Length: > 4 and <= 255 } && FileName(name) == name && name.EndsWith(".inf", StringComparison.OrdinalIgnoreCase);

    /// <summary>YYYY-MM-DD of a FILETIME (UTC) between 1980 and 2100, else null.</summary>
    internal static string? DriverDate(long? fileTime)
    {
        if (fileTime is not long value || value <= 0) return null;
        DateTime day;
        try { day = DateTime.FromFileTimeUtc(value); }
        catch (ArgumentOutOfRangeException) { return null; }
        return day.Year is >= 1980 and <= 2100 ? day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null;
    }

    /// <summary>The plain file name of a driver's image path (\SystemRoot\System32\drivers\vjoy.sys → vjoy.sys), else null.</summary>
    internal static string? FileName(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        string trimmed = path.Trim().Trim('"');
        int separator = Math.Max(trimmed.LastIndexOf('\\'), trimmed.LastIndexOf('/'));
        string name = separator >= 0 ? trimmed[(separator + 1)..] : trimmed;
        return name.Length is > 0 and <= 256 && name.IndexOfAny(['\\', '/', ':']) < 0 ? name : null;
    }

    private static string? Clean(string? value)
    {
        string? text = value?.Trim();
        return string.IsNullOrEmpty(text) ? null : text.Length <= 256 ? text : text[..256];
    }

    private static JsonNode Item(DriverEntry entry) => new JsonObject { ["key"] = entry.Key, ["deviceName"] = entry.DeviceName, ["deviceClass"] = entry.DeviceClass, ["infName"] = entry.InfName, ["file"] = entry.File, ["service"] = entry.Service, ["provider"] = entry.Provider, ["version"] = entry.Version, ["date"] = entry.Date, ["signed"] = entry.Signed, ["signer"] = entry.Signer };

    /// <summary>
    /// SHA-256 (lower-case hex) over the canonical JSON that lib/driver-inventory.ts
    /// builds with JSON.stringify: an array of [key,deviceName,deviceClass,infName,
    /// file,service,provider,version,date,signed,signer] arrays, sorted ordinally by key.
    /// </summary>
    internal static string Checksum(IEnumerable<DriverEntry> items)
    {
        var sorted = items.OrderBy(item => item.Key, StringComparer.Ordinal).ToList();
        var json = new StringBuilder("[");
        for (int i = 0; i < sorted.Count; i++)
        {
            var item = sorted[i];
            if (i > 0) json.Append(',');
            json.Append('[');
            string?[] values = [item.Key, item.DeviceName, item.DeviceClass, item.InfName, item.File, item.Service, item.Provider, item.Version, item.Date];
            for (int j = 0; j < values.Length; j++) { if (j > 0) json.Append(','); NativeSoftwareInventory.AppendJson(json, values[j]); }
            json.Append(',').Append(item.Signed is null ? "null" : item.Signed.Value ? "true" : "false").Append(',');
            NativeSoftwareInventory.AppendJson(json, item.Signer);
            json.Append(']');
        }
        json.Append(']');
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json.ToString()))).ToLowerInvariant();
    }
}

// The native read: CfgMgr32 for the present devices and their driver
// properties, the registry for the service image paths, and the offline catalog
// check of WindowsFileInspector (no network, no revocation check) for the INF files.
internal sealed class WindowsDriverSource : IDriverSource
{
    private const uint PresentFilter = 0x00000100; // CM_GETIDLIST_FILTER_PRESENT
    private const uint Success = 0x00, BufferSmall = 0x1A; // CR_SUCCESS, CR_BUFFER_SMALL
    private const uint HasProblem = 0x00000400; // DN_HAS_PROBLEM
    private const uint StringType = 0x12, FileTimeType = 0x10; // DEVPROP_TYPE_STRING, DEVPROP_TYPE_FILETIME
    private const uint GeneralFailure = 31; // ERROR_GEN_FAILURE
    private static readonly Guid NameGroup = new("b725f130-47ef-101a-a5f1-02608c9eebac"), DeviceGroup = new("a45c254e-df1c-4efd-8020-67d146a850e0"), DriverGroup = new("a8b865dd-2e3d-4094-ad97-e593a70c75d6");
    private static readonly DevPropKey Name = new(NameGroup, 10), Class = new(DeviceGroup, 9), Manufacturer = new(DeviceGroup, 13), Service = new(DeviceGroup, 6);
    private static readonly DevPropKey DriverDate = new(DriverGroup, 2), DriverVersion = new(DriverGroup, 3), DriverInfPath = new(DriverGroup, 5), DriverProvider = new(DriverGroup, 9);
    private readonly WindowsFileInspector inspector = new(useCache: false);

    public IReadOnlyList<DriverDevice> Devices()
    {
        var result = new List<DriverDevice>();
        foreach (string id in DeviceIds())
        {
            // A device removed after the list was read is skipped.
            if (CM_Locate_DevNodeW(out uint node, id, 0) != Success) continue;
            int problem = CM_Get_DevNode_Status(out uint status, out uint number, node, 0) == Success && (status & HasProblem) != 0 ? (int)Math.Min(number, 999u) : 0;
            result.Add(new DriverDevice(id, problem, Text(node, Name), Text(node, Class), Text(node, Manufacturer), Text(node, Service), Text(node, DriverInfPath), Text(node, DriverVersion), FileTime(node, DriverDate), Text(node, DriverProvider)));
        }
        return result;
    }

    public string? ServiceImagePath(string service)
    {
        if (service.Length is 0 or > 256 || service.IndexOfAny(['\\', '/']) >= 0) return null;
        using var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\" + service);
        return key?.GetValue("ImagePath", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
    }

    public (long Size, DateTime LastWriteUtc)? InfFile(string infName)
    {
        var file = new FileInfo(InfPath(infName));
        return file.Exists ? (file.Length, file.LastWriteTimeUtc) : null;
    }

    public (string Signature, string? Signer) InfSignature(string infName) => inspector.Signature(InfPath(infName));

    private static string InfPath(string infName) => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "INF", infName);

    private static List<string> DeviceIds()
    {
        // The list can grow between the size and the read; read it again then.
        for (int attempt = 0; attempt < 4; attempt++)
        {
            uint result = CM_Get_Device_ID_List_SizeW(out uint length, null, PresentFilter);
            if (result != Success) throw Failure(result, "CM_Get_Device_ID_List_Size");
            var buffer = new char[length + 1];
            result = CM_Get_Device_ID_ListW(null, buffer, (uint)buffer.Length, PresentFilter);
            if (result == BufferSmall) continue;
            if (result != Success) throw Failure(result, "CM_Get_Device_ID_List");
            return new string(buffer).Split('\0', StringSplitOptions.RemoveEmptyEntries).ToList();
        }
        throw new InvalidOperationException("The device list kept changing while it was read.");
    }

    private static Win32Exception Failure(uint result, string call) => new((int)CM_MapCrToWin32Err(result, GeneralFailure), call + " failed (CONFIGRET 0x" + result.ToString("X2", CultureInfo.InvariantCulture) + ").");

    private static byte[]? Property(uint node, DevPropKey key, uint expected)
    {
        uint size = 0;
        uint result = CM_Get_DevNode_PropertyW(node, ref key, out uint type, null, ref size, 0);
        // A value that grows between the two calls gets a new buffer; a missing value (CR_NO_SUCH_VALUE) is null.
        for (int attempt = 0; attempt < 3 && result == BufferSmall; attempt++)
        {
            if (size is 0 or > 65536) return null;
            var buffer = new byte[size];
            result = CM_Get_DevNode_PropertyW(node, ref key, out type, buffer, ref size, 0);
            if (result == Success) return type == expected && size <= buffer.Length ? buffer[..(int)size] : null;
        }
        return null;
    }

    private static string? Text(uint node, DevPropKey key)
    {
        if (Property(node, key, StringType) is not { } bytes) return null;
        string text = Encoding.Unicode.GetString(bytes, 0, bytes.Length & ~1);
        int end = text.IndexOf('\0');
        text = (end >= 0 ? text[..end] : text).Trim();
        return text.Length == 0 ? null : text;
    }

    private static long? FileTime(uint node, DevPropKey key) => Property(node, key, FileTimeType) is { Length: >= 8 } bytes ? BitConverter.ToInt64(bytes, 0) : null;

    [StructLayout(LayoutKind.Sequential)]
    private struct DevPropKey(Guid group, uint id) { public Guid Group = group; public uint Id = id; }

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] private static extern uint CM_Get_Device_ID_List_SizeW(out uint length, string? filter, uint flags);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] private static extern uint CM_Get_Device_ID_ListW(string? filter, [Out] char[] buffer, uint length, uint flags);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] private static extern uint CM_Locate_DevNodeW(out uint node, string deviceId, uint flags);
    [DllImport("cfgmgr32.dll")] private static extern uint CM_Get_DevNode_Status(out uint status, out uint problem, uint node, uint flags);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] private static extern uint CM_Get_DevNode_PropertyW(uint node, ref DevPropKey key, out uint type, [Out] byte[]? buffer, ref uint size, uint flags);
    [DllImport("cfgmgr32.dll")] private static extern uint CM_MapCrToWin32Err(uint result, uint defaultError);
}
