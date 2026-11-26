using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using static ServerDesk.Agent.WindowsManagement;

namespace ServerDesk.Agent;

internal delegate List<Dictionary<string, object?>> HardwareQuery(string ns, string wql, int maximum, TimeSpan timeout);

// Static physical inventory runs in one dedicated, cached, single-flight slot.
// Each query is read-only and bounded; one failed category does not erase the
// remaining categories. No WMI work runs on the heartbeat HTTP worker.
internal sealed class NativeHardwareInventory(HardwareQuery? provider = null, Func<DateTimeOffset>? clock = null)
{
    internal const int IntervalSeconds = 900;
    internal const int DeadlineSeconds = 25;
    private const double MaximumBytes = 9007199254740991d;
    private readonly HardwareQuery query = provider ?? ((ns, wql, maximum, timeout) => Query(ns, wql, maximum, timeout));
    private readonly Func<DateTimeOffset> now = clock ?? (() => DateTimeOffset.UtcNow);
    private static readonly TimeSpan QueryTimeout = TimeSpan.FromSeconds(2);

    internal JsonObject Collect()
    {
        // Timestamp precedes provider work. A provider that returns late must
        // not relabel old data as collected at its eventual completion time.
        var inventory = new JsonObject { ["collectedAt"] = now().ToString("O"), ["intervalSeconds"] = IntervalSeconds, ["complete"] = true };
        var errors = new JsonArray();
        void Warn(string category, string detail) { if (errors.Count < 10) errors.Add(Limit(category + ": " + detail, 500)); }
        void Category(string key, string label, Func<JsonNode?> read)
        {
            try { var value = read(); if (value is not null) inventory[key] = value; }
            catch (Exception error) when (error is not OutOfMemoryException and not StackOverflowException)
            { Warn(label, "Inventory not available (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
        }
        List<Dictionary<string, object?>> Rows(string ns, string wql, int maximum, string label)
        {
            var rows = query(ns, wql, maximum + 1, QueryTimeout);
            if (rows.Count > maximum) Warn(label, "Inventory limit reached.");
            return rows.Take(maximum).ToList();
        }
        JsonArray Array(List<Dictionary<string, object?>> rows, string category, Func<Dictionary<string, object?>, int, JsonObject> convert)
        {
            var result = new JsonArray(); var identities = new HashSet<string>(StringComparer.Ordinal);
            for (int index = 0; index < rows.Count; index++)
            {
                var row = convert(rows[index], index);
                if (identities.Add(row["id"]!.GetValue<string>())) result.Add(row);
                else Warn(category, "Duplicate hardware ID; record skipped.");
            }
            return result;
        }

        Category("cpus", "Processors", () => Array(Rows(@"root\cimv2", "SELECT DeviceID,Name,Manufacturer,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,SocketDesignation FROM Win32_Processor", 64, "Processors"), "Processors", Cpu));
        Category("memoryModules", "Memory", () => Array(Rows(@"root\cimv2", "SELECT Tag,DeviceLocator,BankLabel,Capacity,Speed,ConfiguredClockSpeed,FormFactor,SMBIOSMemoryType,MemoryType,Manufacturer,PartNumber,SerialNumber FROM Win32_PhysicalMemory", 512, "Memory"), "Memory", Memory));
        Category("memoryArray", "Memory slots", () => MemoryArray(Rows(@"root\cimv2", "SELECT MemoryDevices FROM Win32_PhysicalMemoryArray WHERE Use=3", 64, "Memory slots")));
        Category("disks", "Physical disks", () =>
        {
            try
            {
                return Array(Rows(@"root\Microsoft\Windows\Storage", "SELECT DeviceId,UniqueId,Model,FriendlyName,SerialNumber,Size,BusType,MediaType,HealthStatus,FirmwareVersion FROM MSFT_PhysicalDisk", 128, "Physical disks"), "Physical disks", PhysicalDisk);
            }
            catch (Exception error) when (error is not OutOfMemoryException and not StackOverflowException)
            {
                // Never infer SSD/NVMe/SMART health from a drive letter or
                // Win32_DiskDrive.Status=OK. The fallback keeps such data null.
                Warn("Disk details", "Storage provider not available (" + NativeInventoryDiagnostics.Describe(error) + "); the basic inventory is used.");
                return Array(Rows(@"root\cimv2", "SELECT DeviceID,Model,SerialNumber,Size,InterfaceType,FirmwareRevision FROM Win32_DiskDrive", 128, "Physical disks"), "Physical disks", BasicDisk);
            }
        });
        Category("system", "System", () =>
        {
            var rows = Rows(@"root\cimv2", "SELECT Manufacturer,Model,SystemType FROM Win32_ComputerSystem", 1, "System");
            if (rows.Count == 0) throw new InvalidDataException("System inventory returned no row.");
            var row = rows[0];
            var value = new JsonObject { ["manufacturer"] = Value(row, "Manufacturer"), ["model"] = Value(row, "Model"), ["systemType"] = Value(row, "SystemType"), ["uuid"] = null };
            try
            {
                var products = Rows(@"root\cimv2", "SELECT UUID FROM Win32_ComputerSystemProduct", 1, "System ID");
                if (products.Count > 0 && Guid.TryParse(Value(products[0], "UUID"), out var id) && id != Guid.Empty && id != Guid.Parse("ffffffff-ffff-ffff-ffff-ffffffffffff")) value["uuid"] = id.ToString();
            }
            catch (Exception error) when (error is not OutOfMemoryException and not StackOverflowException)
            { Warn("System ID", "Inventory not available (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
            return value;
        });
        Category("bios", "BIOS", () =>
        {
            var rows = Rows(@"root\cimv2", "SELECT Manufacturer,Name,SMBIOSBIOSVersion,ReleaseDate,SerialNumber FROM Win32_BIOS", 1, "BIOS");
            if (rows.Count == 0) throw new InvalidDataException("BIOS inventory returned no row.");
            var row = rows[0]; string date = Date(row, "ReleaseDate");
            return new JsonObject { ["manufacturer"] = Value(row, "Manufacturer"), ["name"] = Value(row, "Name"), ["version"] = Value(row, "SMBIOSBIOSVersion"), ["releasedAt"] = date.Length > 0 ? date : null, ["serialNumber"] = Value(row, "SerialNumber") };
        });
        Category("baseboard", "Baseboard", () =>
        {
            var rows = Rows(@"root\cimv2", "SELECT Manufacturer,Product,Version,SerialNumber FROM Win32_BaseBoard WHERE HostingBoard=TRUE", 1, "Baseboard");
            if (rows.Count == 0) return null;
            var row = rows[0];
            return new JsonObject { ["manufacturer"] = Value(row, "Manufacturer"), ["product"] = Value(row, "Product"), ["version"] = Value(row, "Version"), ["serialNumber"] = Value(row, "SerialNumber") };
        });
        Category("networkAdapters", "Network adapters", () => Array(Rows(@"root\cimv2", "SELECT DeviceID,PNPDeviceID,Name,Manufacturer,MACAddress,Speed,PhysicalAdapter FROM Win32_NetworkAdapter WHERE PhysicalAdapter=TRUE", 128, "Network adapters").Where(row =>
        {
            // Some VPN miniports also report PhysicalAdapter=true. Keep
            // software/root enumerated devices in the existing IP inventory,
            // rather than presenting them as physical NICs in Hardware.
            string pnp = Identifier(row, "PNPDeviceID") ?? "";
            return !pnp.StartsWith(@"ROOT\", StringComparison.OrdinalIgnoreCase) && !pnp.StartsWith(@"SWD\", StringComparison.OrdinalIgnoreCase);
        }).ToList(), "Network adapters", Network));
        inventory["complete"] = errors.Count == 0;
        if (errors.Count > 0) inventory["errors"] = errors;
        return new JsonObject { ["hardware"] = inventory };
    }

    private static JsonObject Cpu(Dictionary<string, object?> row, int index) => new()
    {
        ["id"] = Identity("cpu", Identifier(row, "DeviceID"), index), ["name"] = Value(row, "Name") ?? "", ["manufacturer"] = Value(row, "Manufacturer"),
        ["cores"] = Positive(row, "NumberOfCores", 8192), ["threads"] = Positive(row, "NumberOfLogicalProcessors", 8192), ["maxClockMhz"] = Positive(row, "MaxClockSpeed", 100000), ["socket"] = Value(row, "SocketDesignation")
    };
    private static JsonObject Memory(Dictionary<string, object?> row, int index) => new()
    {
        ["id"] = Identity("memory", Identifier(row, "Tag") ?? Identifier(row, "DeviceLocator"), index), ["deviceLocator"] = Value(row, "DeviceLocator"), ["bankLabel"] = Value(row, "BankLabel"),
        ["capacityBytes"] = Positive(row, "Capacity", MaximumBytes), ["speedMhz"] = Positive(row, "Speed", 100000), ["configuredClockMhz"] = Positive(row, "ConfiguredClockSpeed", 100000),
        ["formFactor"] = Code(row, "FormFactor") switch { 7 => "SIMM", 8 => "DIMM", 11 => "RIMM", 12 => "SODIMM", 13 => "SRIMM", 14 => "SMD", 23 => "LGA", _ => null },
        ["memoryType"] = MemoryType(row), ["manufacturer"] = Value(row, "Manufacturer"), ["partNumber"] = Value(row, "PartNumber"), ["serialNumber"] = Value(row, "SerialNumber")
    };
    private static JsonObject MemoryArray(List<Dictionary<string, object?>> rows)
    {
        var counts = rows.Select(row => Positive(row, "MemoryDevices", 8192)).ToArray();
        double? count = counts.Length > 0 && counts.All(value => value is not null) && counts.Sum(value => value!.Value) <= 8192 ? counts.Sum(value => value!.Value) : null;
        // MaxCapacity/MaxCapacityEx have inconsistent public unit descriptions
        // across provider versions. Do not infer a supported maximum from RAM
        // installed now, nor publish a value with an unverified byte unit.
        return new JsonObject { ["slots"] = count, ["maxCapacityBytes"] = null };
    }
    private static JsonObject PhysicalDisk(Dictionary<string, object?> row, int index) => new()
    {
        ["id"] = Identity("physical-disk", Identifier(row, "UniqueId") ?? Identifier(row, "DeviceId"), index), ["model"] = Value(row, "Model") ?? Value(row, "FriendlyName"), ["serialNumber"] = Value(row, "SerialNumber"),
        ["sizeBytes"] = Positive(row, "Size", MaximumBytes), ["busType"] = Code(row, "BusType") switch { 1 => "SCSI", 2 => "ATAPI", 3 => "ATA", 4 => "IEEE 1394", 5 => "SSA", 6 => "Fibre Channel", 7 => "USB", 8 => "RAID", 9 => "iSCSI", 10 => "SAS", 11 => "SATA", 12 => "SD", 13 => "MMC", 15 => "File-Backed Virtual", 16 => "Storage Spaces", 17 => "NVMe", _ => null },
        ["mediaType"] = Code(row, "MediaType") switch { 3 => "HDD", 4 => "SSD", 5 => "SCM", _ => null },
        ["healthStatus"] = Code(row, "HealthStatus") switch { 0 => "healthy", 1 => "warning", 2 => "unhealthy", 5 => "unknown", _ => null }, ["firmwareVersion"] = Value(row, "FirmwareVersion")
    };
    private static JsonObject BasicDisk(Dictionary<string, object?> row, int index) => new()
    {
        ["id"] = Identity("disk-drive", Identifier(row, "DeviceID"), index), ["model"] = Value(row, "Model"), ["serialNumber"] = Value(row, "SerialNumber"), ["sizeBytes"] = Positive(row, "Size", MaximumBytes),
        ["busType"] = Value(row, "InterfaceType"), ["mediaType"] = null, ["healthStatus"] = null, ["firmwareVersion"] = Value(row, "FirmwareRevision")
    };
    private static JsonObject Network(Dictionary<string, object?> row, int index)
    {
        double? speed = Positive(row, "Speed", 1e13);
        return new JsonObject { ["id"] = Identity("network-adapter", Identifier(row, "PNPDeviceID") ?? Identifier(row, "DeviceID"), index), ["name"] = Value(row, "Name"), ["manufacturer"] = Value(row, "Manufacturer"), ["mac"] = Value(row, "MACAddress"), ["speedMbps"] = speed is null ? null : Math.Round(speed.Value / 1000000d, 3), ["physicalAdapter"] = row.GetValueOrDefault("PhysicalAdapter") is bool physical ? physical : null };
    }
    private static string? MemoryType(Dictionary<string, object?> row)
    {
        int? type = Code(row, "SMBIOSMemoryType");
        if (type is null or 0 or 1 or 2) type = Code(row, "MemoryType");
        return type switch { 17 => "SDRAM", 18 => "SGRAM", 19 => "RDRAM", 20 => "DDR", 21 => "DDR2", 22 => "DDR2 FB-DIMM", 24 => "DDR3", 25 => "FBD2", 26 => "DDR4", 27 => "LPDDR", 28 => "LPDDR2", 29 => "LPDDR3", 30 => "LPDDR4", 34 => "DDR5", 35 => "LPDDR5", _ => null };
    }
    private static int? Code(Dictionary<string, object?> row, string field)
    {
        double? value = Numeric(row, field); return value is >= 0 and <= int.MaxValue && value == Math.Truncate(value.Value) ? (int)value.Value : null;
    }
    private static double? Positive(Dictionary<string, object?> row, string field, double maximum)
    {
        double? value = Numeric(row, field); return value is > 0 && value <= maximum && value == Math.Truncate(value.Value) ? value : null;
    }
    private static double? Numeric(Dictionary<string, object?> row, string field)
    {
        if (!row.TryGetValue(field, out var value) || value is null || value is bool) return null;
        try { double number = Convert.ToDouble(value, CultureInfo.InvariantCulture); return double.IsFinite(number) ? number : null; }
        catch (Exception error) when (error is FormatException or InvalidCastException or OverflowException) { return null; }
    }
    private static string? Value(Dictionary<string, object?> row, string field)
    {
        string value = Text(row, field, 2048).Trim();
        if (value.Length == 0 || value.Equals("unknown", StringComparison.OrdinalIgnoreCase) || value.Equals("none", StringComparison.OrdinalIgnoreCase) || value.Equals("not specified", StringComparison.OrdinalIgnoreCase) || value.Equals("default string", StringComparison.OrdinalIgnoreCase) || value.StartsWith("To be filled by O.E.M", StringComparison.OrdinalIgnoreCase)) return null;
        return Limit(value, 256);
    }
    private static string? Identifier(Dictionary<string, object?> row, string field)
    {
        string value = Text(row, field, 2048).Trim(); return value.Length > 0 ? value : null;
    }
    private static string Identity(string category, string? value, int index)
    {
        string identity = category + ":" + (value ?? "row-" + index.ToString(CultureInfo.InvariantCulture));
        return identity.Length <= 128 ? identity : category + ":sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity))).ToLowerInvariant();
    }
}
