using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.Management;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ServerDesk.Agent;

// Disk and battery health (docs/v3-health-signals.md): health, operational status
// and the reliability counters of every physical disk (MSFT_PhysicalDisk,
// MSFT_StorageReliabilityCounter), disk errors of the last 30 days from the
// System log (disk 7, 51, 153; Ntfs 55) and the battery capacity from root\wmi.
// A counter that a disk does not report (USB, virtual disks, some controllers)
// is null, never 0. No serial numbers leave the device.
internal sealed record DiskEventRecord(DateTimeOffset At, string Source, int EventId, IReadOnlyList<string> Data);

/// <summary>The battery provider cannot answer: not-supported, access-denied or error.</summary>
internal sealed class BatteryUnavailableException(string reason) : Exception("Battery data is not available: " + reason) { internal string Reason { get; } = reason; }

internal interface IDiskHealthSource
{
    IReadOnlyList<Dictionary<string, object?>> PhysicalDisks();
    /// <summary>The MSFT_StorageReliabilityCounter values of a disk row, or null when the disk has none.</summary>
    Dictionary<string, object?>? ReliabilityCounter(Dictionary<string, object?> disk);
    /// <summary>MSFT_Partition rows with DiskNumber and DriveLetter.</summary>
    IReadOnlyList<Dictionary<string, object?>> Partitions();
    IReadOnlyList<DiskEventRecord> DiskEvents(DateTimeOffset since);
    /// <summary>The number of Win32_Battery instances; throws BatteryUnavailableException.</summary>
    int BatteryCount();
    /// <summary>BatteryStaticData, BatteryFullChargedCapacity and BatteryCycleCount rows of root\wmi; throws BatteryUnavailableException when the namespace or class is missing.</summary>
    (IReadOnlyList<Dictionary<string, object?>> Static, IReadOnlyList<Dictionary<string, object?>> Full, IReadOnlyList<Dictionary<string, object?>>? Cycles) Batteries();
}

internal sealed partial class NativeDiskHealth(IDiskHealthSource? source = null, Func<DateTimeOffset>? clock = null)
{
    internal const int IntervalSeconds = 900;
    internal const int DeadlineSeconds = 25;
    internal const int WindowDays = 30;
    internal const int MaximumDisks = 64;
    internal const int MaximumEvents = 50;
    internal const int MaximumBatteries = 4;
    private readonly IDiskHealthSource health = source ?? new WindowsDiskHealthSource();
    private readonly Func<DateTimeOffset> now = clock ?? (() => DateTimeOffset.UtcNow);

    internal JsonObject Collect()
    {
        var at = now(); var warnings = new JsonArray();
        var result = new JsonObject();
        try { result["diskHealth"] = Disks(at, warnings); }
        catch (Exception error) when (error is not OutOfMemoryException) { warnings.Add("The disk health could not be read (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
        result["battery"] = Battery(at);
        if (warnings.Count > 0) result["_collectionWarnings"] = warnings;
        return result;
    }

    internal JsonObject Disks(DateTimeOffset at, JsonArray warnings)
    {
        var letters = new Dictionary<int, SortedSet<string>>();
        try
        {
            foreach (var partition in health.Partitions())
            {
                int? number = Integer(partition, "DiskNumber");
                string letter = Convert.ToString(partition.GetValueOrDefault("DriveLetter"), CultureInfo.InvariantCulture) ?? "";
                if (number is null || letter.Length == 0 || !char.IsAsciiLetter(letter[0])) continue;
                if (!letters.TryGetValue(number.Value, out var set)) letters[number.Value] = set = new SortedSet<string>(StringComparer.Ordinal);
                set.Add(char.ToUpperInvariant(letter[0]) + ":");
            }
        }
        catch (Exception error) when (error is not OutOfMemoryException) { warnings.Add("The partitions could not be read (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
        var disks = new JsonArray();
        foreach (var row in health.PhysicalDisks().Take(MaximumDisks))
        {
            string id = Text(row, "DeviceId", 128) ?? Text(row, "ObjectId", 128) ?? ("disk" + disks.Count.ToString(CultureInfo.InvariantCulture));
            int? number = int.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out int parsed) && parsed <= 4096 ? parsed : null;
            Dictionary<string, object?>? counter = null;
            try { counter = health.ReliabilityCounter(row); } catch (Exception error) when (error is not OutOfMemoryException) { counter = null; }
            disks.Add(new JsonObject
            {
                ["id"] = id, ["number"] = number, ["model"] = Text(row, "Model", 256) ?? Text(row, "FriendlyName", 256) ?? "", ["busType"] = Bus(Integer(row, "BusType")),
                ["mediaType"] = Media(Integer(row, "MediaType")), ["health"] = Health(Integer(row, "HealthStatus")),
                ["operationalStatus"] = new JsonArray(Values(row, "OperationalStatus").Select(Operational).Distinct(StringComparer.Ordinal).Take(8).Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
                ["driveLetters"] = new JsonArray((number is not null && letters.TryGetValue(number.Value, out var set) ? set.Take(26) : []).Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
                ["countersAvailable"] = counter is not null,
                ["wearPercent"] = Counter(counter, "Wear", 0, 100), ["temperatureC"] = Counter(counter, "Temperature", -50, 200), ["temperatureMaxC"] = Counter(counter, "TemperatureMax", -50, 200),
                ["readErrorsUncorrected"] = Counter(counter, "ReadErrorsUncorrected", 0, 9_007_199_254_740_991), ["powerOnHours"] = Counter(counter, "PowerOnHours", 0, 10_000_000)
            });
        }
        // NTFS events name a volume; its drive letter gives the disk.
        var diskOfLetter = letters.SelectMany(pair => pair.Value.Select(letter => (Letter: letter, Disk: pair.Key))).GroupBy(item => item.Letter).ToDictionary(group => group.Key, group => group.First().Disk, StringComparer.Ordinal);
        var since = at.AddDays(-WindowDays);
        var events = new List<JsonObject>(); var counts = new SortedDictionary<string, int>(StringComparer.Ordinal);
        try
        {
            foreach (var record in health.DiskEvents(since).Where(record => record.At >= since).OrderByDescending(record => record.At))
            {
                var parsed = Parse(record);
                if (parsed is null) continue;
                var (disk, volume) = parsed.Value;
                if (disk is null && volume is not null && diskOfLetter.TryGetValue(volume, out int mapped)) disk = mapped;
                string key = disk?.ToString(CultureInfo.InvariantCulture) ?? "unknown";
                counts[key] = counts.GetValueOrDefault(key) + 1;
                if (events.Count < MaximumEvents) events.Add(new JsonObject { ["at"] = record.At.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture), ["source"] = record.Source, ["eventId"] = record.EventId, ["disk"] = disk, ["volume"] = volume });
            }
        }
        catch (Exception error) when (error is not OutOfMemoryException) { warnings.Add("The System event log could not be read for disk errors (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
        int total = counts.Values.Sum();
        var countObject = new JsonObject();
        foreach (var pair in counts.Take(65)) countObject[pair.Key] = pair.Value;
        return new JsonObject
        {
            ["collectedAt"] = at.ToString("O", CultureInfo.InvariantCulture), ["disks"] = disks,
            ["events"] = new JsonObject { ["windowDays"] = WindowDays, ["items"] = new JsonArray(events.Select(item => (JsonNode)item).ToArray()), ["counts"] = countObject, ["truncated"] = total > events.Count }
        };
    }

    /// <summary>The disk number (\Device\HarddiskN) and the volume (C:) of a disk or NTFS event, or null for another event.</summary>
    internal static (int? Disk, string? Volume)? Parse(DiskEventRecord record)
    {
        bool known = record.Source == "disk" && record.EventId is 7 or 51 or 153 || record.Source == "ntfs" && record.EventId == 55;
        if (!known) return null;
        int? disk = null; string? volume = null;
        foreach (string value in record.Data)
        {
            var match = HarddiskPath().Match(value);
            if (disk is null && match.Success && int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out int number) && number <= 4096) disk = number;
            var drive = Volume().Match(value.Trim());
            if (volume is null && drive.Success) volume = char.ToUpperInvariant(drive.Groups[1].Value[0]) + ":";
        }
        return (disk, volume);
    }

    internal JsonObject Battery(DateTimeOffset at)
    {
        JsonObject Result(bool present, string? reason, JsonArray? batteries = null)
        {
            var value = new JsonObject { ["collectedAt"] = at.ToString("O", CultureInfo.InvariantCulture), ["present"] = present, ["batteries"] = batteries ?? new JsonArray() };
            if (reason is not null) value["reason"] = reason;
            return value;
        }
        int count;
        try { count = health.BatteryCount(); }
        catch (BatteryUnavailableException error) { return Result(false, error.Reason); }
        catch (Exception error) when (error is not OutOfMemoryException) { return Result(false, "error"); }
        if (count == 0) return Result(false, "no-battery");
        try
        {
            var (statics, fulls, cycles) = health.Batteries();
            string Instance(Dictionary<string, object?> row) => Convert.ToString(row.GetValueOrDefault("InstanceName"), CultureInfo.InvariantCulture) ?? "";
            var full = fulls.GroupBy(Instance, StringComparer.OrdinalIgnoreCase).ToDictionary(group => group.Key, group => group.First(), StringComparer.OrdinalIgnoreCase);
            var cycle = (cycles ?? []).GroupBy(Instance, StringComparer.OrdinalIgnoreCase).ToDictionary(group => group.Key, group => group.First(), StringComparer.OrdinalIgnoreCase);
            var list = new JsonArray(); int index = 0;
            foreach (var row in statics.OrderBy(Instance, StringComparer.OrdinalIgnoreCase).Take(MaximumBatteries))
            {
                string instance = Instance(row);
                long? design = Long(row, "DesignedCapacity"), charged = full.TryGetValue(instance, out var fullRow) ? Long(fullRow, "FullChargedCapacity") : null;
                long? cycleCount = cycles is not null && cycle.TryGetValue(instance, out var cycleRow) ? Long(cycleRow, "CycleCount") : null;
                int? percent = design is > 0 && charged is not null ? (int)Math.Clamp(Math.Round(charged.Value * 100.0 / design.Value, MidpointRounding.AwayFromZero), 0, 150) : null;
                list.Add(new JsonObject { ["id"] = index++, ["name"] = Text(row, "DeviceName", 256), ["designCapacityMWh"] = Bounded(design), ["fullChargeCapacityMWh"] = Bounded(charged), ["healthPercent"] = percent, ["cycleCount"] = cycleCount is >= 0 and <= 1_000_000 ? cycleCount : null });
            }
            return Result(true, null, list);
        }
        catch (BatteryUnavailableException error) { return Result(true, error.Reason); }
        catch (Exception error) when (error is not OutOfMemoryException) { return Result(true, "error"); }
    }

    internal static string Health(int? value) => value switch { 0 => "healthy", 1 => "warning", 2 => "unhealthy", _ => "unknown" };
    internal static string Media(int? value) => value switch { 3 => "hdd", 4 => "ssd", 5 => "scm", _ => "unspecified" };
    internal static string Operational(int value) => value switch
    {
        2 => "ok", 3 => "degraded", 4 => "stressed", 5 => "predictive-failure", 6 or 7 => "failed", 8 => "starting", 9 => "stopping", 10 => "stopped", 11 => "in-service",
        12 => "no-contact", 13 => "lost-communication", 14 => "aborted", 15 => "dormant", 16 => "supporting-entity-in-error", 17 => "completed", 18 => "power-mode", _ => "unknown"
    };
    internal static string Bus(int? value) => value switch
    {
        1 => "SCSI", 2 => "ATAPI", 3 => "ATA", 4 => "1394", 5 => "SSA", 6 => "Fibre Channel", 7 => "USB", 8 => "RAID", 9 => "iSCSI", 10 => "SAS", 11 => "SATA", 12 => "SD", 13 => "MMC",
        14 => "Virtual", 15 => "File Backed Virtual", 16 => "Storage Spaces", 17 => "NVMe", 18 => "SCM", 19 => "UFS", _ => "Unknown"
    };

    private static JsonNode? Counter(Dictionary<string, object?>? counter, string name, double minimum, double maximum)
    {
        if (counter is null || !counter.TryGetValue(name, out var raw) || raw is null) return null;
        try
        {
            double value = Convert.ToDouble(raw, CultureInfo.InvariantCulture);
            if (!double.IsFinite(value) || value < minimum || value > maximum) return null;
            return Math.Abs(value - Math.Round(value)) < 1e-9 ? JsonValue.Create((long)Math.Round(value)) : JsonValue.Create(value);
        }
        catch (Exception error) when (error is FormatException or InvalidCastException or OverflowException) { return null; }
    }
    private static long? Bounded(long? value) => value is >= 0 and <= 10_000_000 ? value : null;
    private static string? Text(Dictionary<string, object?> row, string name, int maximum)
    {
        string? value = row.TryGetValue(name, out var raw) && raw is not null ? Convert.ToString(raw, CultureInfo.InvariantCulture)?.Trim() : null;
        return string.IsNullOrEmpty(value) ? null : value.Length <= maximum ? value : value[..maximum];
    }
    private static int? Integer(Dictionary<string, object?> row, string name)
    {
        try { return row.TryGetValue(name, out var value) && value is not null ? Convert.ToInt32(value, CultureInfo.InvariantCulture) : null; } catch (Exception error) when (error is FormatException or InvalidCastException or OverflowException) { return null; }
    }
    private static long? Long(Dictionary<string, object?> row, string name)
    {
        try { return row.TryGetValue(name, out var value) && value is not null ? Convert.ToInt64(value, CultureInfo.InvariantCulture) : null; } catch (Exception error) when (error is FormatException or InvalidCastException or OverflowException) { return null; }
    }
    private static IEnumerable<int> Values(Dictionary<string, object?> row, string name)
    {
        if (row.GetValueOrDefault(name) is not System.Collections.IEnumerable values || row.GetValueOrDefault(name) is string) yield break;
        foreach (object? value in values)
        {
            int? number = null;
            try { number = Convert.ToInt32(value, CultureInfo.InvariantCulture); } catch (Exception error) when (error is FormatException or InvalidCastException or OverflowException) { }
            if (number is not null) yield return number.Value;
        }
    }

    [GeneratedRegex(@"\\Device\\Harddisk(\d{1,4})\b", RegexOptions.IgnoreCase)] private static partial Regex HarddiskPath();
    [GeneratedRegex(@"^([A-Za-z]):\\?$")] private static partial Regex Volume();
}

internal sealed class WindowsDiskHealthSource : IDiskHealthSource
{
    private const string Storage = @"root\Microsoft\Windows\Storage";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(15);
    public IReadOnlyList<Dictionary<string, object?>> PhysicalDisks() => WindowsManagement.Query(Storage, "SELECT DeviceId,ObjectId,Model,FriendlyName,BusType,MediaType,HealthStatus,OperationalStatus FROM MSFT_PhysicalDisk", 64, Timeout);
    public Dictionary<string, object?>? ReliabilityCounter(Dictionary<string, object?> disk)
    {
        if (disk.GetValueOrDefault("__PATH") is not string path || path.Length == 0) return null;
        var output = WindowsManagement.Invoke(Storage, path, "GetStorageReliabilityCounter", null, Timeout);
        return output.GetValueOrDefault("StorageReliabilityCounter") as Dictionary<string, object?>;
    }
    public IReadOnlyList<Dictionary<string, object?>> Partitions() => WindowsManagement.Query(Storage, "SELECT DiskNumber,DriveLetter FROM MSFT_Partition", 4096, Timeout);
    public IReadOnlyList<DiskEventRecord> DiskEvents(DateTimeOffset since)
    {
        var result = new List<DiskEventRecord>();
        if (!OperatingSystem.IsWindows()) return result;
        long age = Math.Max(0, (long)(DateTimeOffset.UtcNow - since).TotalMilliseconds);
        string query = "*[System[((Provider[@Name='disk'] and (EventID=7 or EventID=51 or EventID=153)) or ((Provider[@Name='Ntfs'] or Provider[@Name='Microsoft-Windows-Ntfs']) and EventID=55)) and TimeCreated[timediff(@SystemTime) <= " + age.ToString(CultureInfo.InvariantCulture) + "]]]";
        using var reader = new EventLogReader(new EventLogQuery("System", PathType.LogName, query) { ReverseDirection = true });
        for (int read = 0; read < 5000; read++)
        {
            using var record = reader.ReadEvent();
            if (record is null) break;
            if (record.TimeCreated is not DateTime created) continue;
            string source = string.Equals(record.ProviderName, "disk", StringComparison.OrdinalIgnoreCase) ? "disk" : "ntfs";
            result.Add(new DiskEventRecord(new DateTimeOffset(created.ToUniversalTime(), TimeSpan.Zero), source, record.Id, record.Properties.Take(12).Select(property => Convert.ToString(property.Value, CultureInfo.InvariantCulture) ?? "").ToList()));
        }
        return result;
    }
    public int BatteryCount() => Guard(() => WindowsManagement.Query(@"root\cimv2", "SELECT DeviceID FROM Win32_Battery", 16, Timeout).Count);
    public (IReadOnlyList<Dictionary<string, object?>> Static, IReadOnlyList<Dictionary<string, object?>> Full, IReadOnlyList<Dictionary<string, object?>>? Cycles) Batteries()
    {
        var statics = Guard(() => WindowsManagement.Query(@"root\wmi", "SELECT InstanceName,DesignedCapacity,DeviceName FROM BatteryStaticData", 16, Timeout));
        var fulls = Guard(() => WindowsManagement.Query(@"root\wmi", "SELECT InstanceName,FullChargedCapacity FROM BatteryFullChargedCapacity", 16, Timeout));
        // Not every battery driver offers the cycle count.
        IReadOnlyList<Dictionary<string, object?>>? cycles;
        try { cycles = Guard(() => WindowsManagement.Query(@"root\wmi", "SELECT InstanceName,CycleCount FROM BatteryCycleCount", 16, Timeout)); }
        catch (BatteryUnavailableException) { cycles = null; }
        return (statics, fulls, cycles);
    }
    private static T Guard<T>(Func<T> read)
    {
        try { return read(); }
        catch (ManagementException error) when (error.ErrorCode is ManagementStatus.InvalidNamespace or ManagementStatus.InvalidClass or ManagementStatus.NotFound or ManagementStatus.NotSupported) { throw new BatteryUnavailableException("not-supported"); }
        catch (ManagementException error) when (error.ErrorCode == ManagementStatus.AccessDenied) { throw new BatteryUnavailableException("access-denied"); }
    }
}
