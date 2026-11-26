using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using Row = System.Collections.Generic.Dictionary<string, object?>;

namespace ServerDesk.Agent;

/// <summary>Windows Storage Management provider, without cmdlets or child processes.</summary>
internal static class NativeStorage
{
    private const string StorageNamespace = @"root\Microsoft\Windows\Storage";
    private const string BasicDataGuid = "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7";
    private const string MsrGuid = "E3C9E316-0B5C-4DB8-817D-F92DF00215AE";
    private const long MaxBytes = 9007199254740991;
    private sealed record Topology(List<Row> Disks, List<Row> Partitions, List<Row> Volumes, List<Row> Associations);
    private sealed record Protection(HashSet<string> Keys, bool Complete, List<string> Warnings);
    // Protection reasons and warnings are inventory text, not job messages: plain English.
    private const string ReadOnlyPartition = "Read-only partition", IncompleteProtection = "System protection could not be determined completely";

    internal static async Task<JsonObject> ExecuteAsync(string root, JsonObject config, JsonObject job, CancellationToken token)
    {
        string id = job["id"]?.GetValue<string>() ?? "", action = job["action"]?.GetValue<string>() ?? "";
        var result = new JsonObject { ["id"] = id, ["ok"] = false };
        try
        {
            var p = job["parameters"]?.AsObject() ?? new JsonObject(); Validate(action, p);
            token.ThrowIfCancellationRequested();
            string mode = LocalStore.ReadProtected(Path.Combine(root, "config.bin"))["mode"]?.GetValue<string>() ?? "ReadOnly";
            if (action != "storage-inspect" && mode != "Management") throw new AgentMessageException("AGENT_STORAGE_MANAGEMENT_REQUIRED");
            AgentMessage message = await Task.Run(() => Execute(root, action, p, token), token);
            var inventory = await Task.Run(() => Inventory(root, token), token);
            result["ok"] = true; AgentMessages.Write(result, message);
            result["data"] = new JsonObject { ["kind"] = action, ["at"] = DateTimeOffset.UtcNow.ToString("O"), ["data"] = inventory };
            if (Encoding.UTF8.GetByteCount(result.ToJsonString()) > 245000) throw new AgentMessageException("AGENT_STORAGE_INVENTORY_TOO_LARGE");
        }
        catch (Exception e) { result["ok"] = false; result.Remove("data"); AgentMessages.Fail(result, e); }
        return result;
    }

    internal static void Validate(string action, JsonObject p)
    {
        string[] common = ["diskNumber", "diskUniqueId", "expectedDiskSizeBytes", "confirm"];
        string[] partition = ["partitionNumber", "expectedOffsetBytes", "expectedSizeBytes"];
        string[] extra = action switch {
            "storage-inspect" => [], "storage-initialize" => ["partitionStyle"], "storage-set-disk" => ["setting"],
            "storage-new-volume" => ["sizeBytes", "useMaximumSize", "driveLetter", "fileSystem", "label"],
            "storage-resize" => ["sizeBytes"], "storage-drive-letter" => ["driveLetter", "remove"], "storage-format" => ["fileSystem", "label"],
            "storage-delete-partition" => [], _ => throw new AgentMessageException("AGENT_STORAGE_UNKNOWN_ACTION") };
        bool hasPartition = action is "storage-resize" or "storage-drive-letter" or "storage-format" or "storage-delete-partition";
        DiagnosticParameters.Keys(p, action == "storage-inspect" ? [] : common.Concat(hasPartition ? partition : []).Concat(extra).ToArray());
        if (action == "storage-inspect") return;
        if (!DiagnosticParameters.Boolean(p, "confirm", false)) throw new AgentMessageException("AGENT_STORAGE_NOT_CONFIRMED");
        DiagnosticParameters.Integer(p, "diskNumber", 0, 65535); DiagnosticParameters.String(p, "diskUniqueId", 512, false, true); DiagnosticParameters.Integer(p, "expectedDiskSizeBytes", 1, MaxBytes);
        if (hasPartition) { DiagnosticParameters.Integer(p, "partitionNumber", 1, 65535); DiagnosticParameters.Integer(p, "expectedOffsetBytes", 0, MaxBytes); DiagnosticParameters.Integer(p, "expectedSizeBytes", 1, MaxBytes); }
        if (action == "storage-initialize" && DiagnosticParameters.String(p, "partitionStyle", 3) is not ("GPT" or "MBR")) throw new AgentMessageException("AGENT_STORAGE_PARTITION_STYLE");
        if (action == "storage-set-disk" && DiagnosticParameters.String(p, "setting", 16) is not ("online" or "offline" or "readOnly" or "writable")) throw new AgentMessageException("AGENT_STORAGE_INVALID_STATE");
        if (action is "storage-new-volume" or "storage-format")
        {
            if (DiagnosticParameters.String(p, "fileSystem", 4) is not ("NTFS" or "ReFS")) throw new AgentMessageException("AGENT_STORAGE_FILE_SYSTEM");
            string label = DiagnosticParameters.String(p, "label", 32, true, true);
            if (label.IndexOfAny(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) >= 0) throw new AgentMessageException("AGENT_STORAGE_INVALID_LABEL");
        }
        if (p.ContainsKey("driveLetter")) { string letter = DiagnosticParameters.String(p, "driveLetter", 1); if (letter.Length != 1 || letter[0] < 'D' || letter[0] > 'Z') throw new AgentMessageException("AGENT_STORAGE_DRIVE_LETTER"); }
        if (action == "storage-new-volume") { bool maximum = DiagnosticParameters.Boolean(p, "useMaximumSize"); if (maximum && p.ContainsKey("sizeBytes")) throw new AgentMessageException("AGENT_STORAGE_SIZE_CONFLICT"); if (!maximum) DiagnosticParameters.Integer(p, "sizeBytes", 16777216, MaxBytes); }
        if (action == "storage-resize") DiagnosticParameters.Integer(p, "sizeBytes", 16777216, MaxBytes);
        if (action == "storage-drive-letter") { bool remove = DiagnosticParameters.Boolean(p, "remove"); if (remove == p.ContainsKey("driveLetter")) throw new AgentMessageException("AGENT_STORAGE_LETTER_OR_REMOVE"); }
    }

    private static Topology Load(CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var disks = WindowsManagement.Query(StorageNamespace, "SELECT * FROM MSFT_Disk", 129, TimeSpan.FromSeconds(15));
        token.ThrowIfCancellationRequested();
        // An empty result for RAW / newly initialized disks is valid. Provider errors propagate.
        var parts = WindowsManagement.Query(StorageNamespace, "SELECT * FROM MSFT_Partition", 4096, TimeSpan.FromSeconds(20));
        var volumes = WindowsManagement.Query(StorageNamespace, "SELECT * FROM MSFT_Volume", 4096, TimeSpan.FromSeconds(15));
        var links = WindowsManagement.Query(StorageNamespace, "SELECT * FROM MSFT_PartitionToVolume", 4096, TimeSpan.FromSeconds(15));
        return new(disks, parts, volumes, links);
    }

    internal static JsonObject Inventory(string root, CancellationToken token)
    {
        Topology t = Load(token); Protection protection = Protect(root, t);
        var disks = new JsonArray(); var warnings = new List<string>(protection.Warnings); int partitionCount = 0; bool truncated = t.Disks.Count > 128 || t.Partitions.Count >= 4096;
        foreach (Row disk in t.Disks.OrderBy(d => U(d, "Number")).Take(128))
        {
            token.ThrowIfCancellationRequested(); var parts = t.Partitions.Where(p => U(p, "DiskNumber") == U(disk, "Number")).OrderBy(p => U(p, "Offset")).ToList();
            List<string> diskReasons = DiskProtection(disk, parts, protection); var rows = new JsonArray();
            foreach (Row part in parts)
            {
                if (++partitionCount > 256) { truncated = true; break; }
                Row? volume = Volume(part, t); Row? range = null;
                try { range = Invoke(part, "GetSupportedSize", timeout: TimeSpan.FromSeconds(8)); } catch { }
                List<string> reasons = PartitionProtection(part, protection);
                rows.Add(new JsonObject { ["number"] = (long)U(part, "PartitionNumber"), ["offsetBytes"] = CheckedBytes(part, "Offset"), ["sizeBytes"] = CheckedBytes(part, "Size"), ["type"] = PartitionType(part), ["gptType"] = S(part, "GptType"), ["driveLetter"] = Letter(part), ["accessPaths"] = Strings(A(part, "AccessPaths").Take(8).Select(v => Short(v, 512))), ["fileSystem"] = volume is null ? "" : S(volume, "FileSystem"), ["label"] = volume is null ? "" : S(volume, "FileSystemLabel"), ["health"] = volume is null ? "" : VolumeHealth(U(volume, "HealthStatus")), ["freeBytes"] = volume is null ? null : CheckedBytes(volume, "SizeRemaining"), ["sizeMinBytes"] = range is null ? null : CheckedBytes(range, "SizeMin"), ["sizeMaxBytes"] = range is null ? null : CheckedBytes(range, "SizeMax"), ["protected"] = reasons.Count > 0, ["growOnly"] = range is not null && U(range, "SizeMax") > U(part, "Size") && CanGrowOs(disk, part, volume, protection), ["protectionReasons"] = Strings(reasons) });
            }
            string unique = S(disk, "UniqueId"); if (unique.Length > 512) { unique = ""; diskReasons.Add("Disk ID is too long"); }
            disks.Add(new JsonObject { ["number"] = (long)U(disk, "Number"), ["uniqueId"] = unique, ["name"] = Short(S(disk, "FriendlyName"), 256), ["serial"] = Short(S(disk, "SerialNumber").Trim(), 256), ["busType"] = Bus(U(disk, "BusType")), ["partitionStyle"] = Style(U(disk, "PartitionStyle")), ["sizeBytes"] = CheckedBytes(disk, "Size"), ["allocatedBytes"] = CheckedBytes(disk, "AllocatedSize"), ["largestFreeExtentBytes"] = CheckedBytes(disk, "LargestFreeExtent"), ["offline"] = B(disk, "IsOffline"), ["readOnly"] = B(disk, "IsReadOnly"), ["health"] = DiskHealth(U(disk, "HealthStatus")), ["operationalStatus"] = string.Join(", ", Values(disk, "OperationalStatus").Select(v => Operational(Convert.ToUInt64(v, CultureInfo.InvariantCulture)))), ["protected"] = diskReasons.Count > 0, ["protectionReasons"] = Strings(diskReasons.Distinct()), ["partitions"] = rows });
        }
        return new JsonObject { ["disks"] = disks, ["truncated"] = truncated, ["warnings"] = Strings(warnings.Distinct().Take(12)) };
    }

    private static Protection Protect(string root, Topology t)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal); var warnings = new List<string>(); bool complete = t.Partitions.Count < 4096 && t.Volumes.Count < 4096 && t.Associations.Count < 4096;
        var paths = new List<string> { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "ntoskrnl.exe"), Path.Combine(root, "config.bin"), Environment.ProcessPath ?? "" };
        try { paths.AddRange(WindowsManagement.Query(@"root\cimv2", "SELECT Name FROM Win32_PageFileUsage", 128, TimeSpan.FromSeconds(8)).Select(p => S(p, "Name"))); }
        catch { complete = false; warnings.Add("Page file protection could not be determined."); }
        foreach (string path in paths.Where(p => !string.IsNullOrEmpty(p)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var mount = new StringBuilder(32768); if (!GetVolumePathName(path, mount, mount.Capacity)) throw new Win32Exception(Marshal.GetLastWin32Error());
                var name = new StringBuilder(1024); if (!GetVolumeNameForVolumeMountPoint(mount.ToString(), name, name.Capacity)) throw new Win32Exception(Marshal.GetLastWin32Error());
                Row[] match = t.Partitions.Where(p => A(p, "AccessPaths").Any(v => SameVolume(v, name.ToString())) || Volume(p, t) is Row v && SameVolume(S(v, "Path"), name.ToString())).ToArray();
                if (match.Length != 1) throw new InvalidDataException("Volume is not unique."); keys.Add(Key(match[0]));
            }
            catch { complete = false; warnings.Add("A system or agent path could not be mapped to a disk."); }
        }
        return new(keys, complete, warnings);
    }

    internal static List<string> PartitionProtection(Row part, IEnumerable<string> protectedKeys, bool complete) => PartitionProtection(part, new Protection(protectedKeys.ToHashSet(), complete, []));
    private static List<string> PartitionProtection(Row p, Protection protection)
    {
        var reasons = new List<string>();
        if (B(p, "IsBoot") || B(p, "IsSystem")) reasons.Add("Boot or system partition");
        if (B(p, "IsActive")) reasons.Add("Active boot partition"); if (B(p, "IsReadOnly")) reasons.Add(ReadOnlyPartition);
        if (B(p, "IsHidden") || B(p, "IsShadowCopy")) reasons.Add("Hidden or shadow copy partition");
        string gpt = S(p, "GptType").Trim('{', '}'); if (gpt.Length > 0 && !gpt.Equals(BasicDataGuid, StringComparison.OrdinalIgnoreCase)) reasons.Add("Reserved GPT, EFI or recovery partition");
        if (U(p, "MbrType") is 39 or 66 or 239 || (U(p, "MbrType") is 5 or 15) || gpt.Length == 0 && U(p, "MbrType") == 0) reasons.Add("Protected partition type");
        if (protection.Keys.Contains(Key(p))) reasons.Add("Windows, agent or page files"); if (!protection.Complete) reasons.Add(IncompleteProtection);
        return reasons.Distinct().ToList();
    }
    internal static List<string> DiskProtection(Row d, List<Row> parts, IEnumerable<string> protectedKeys, bool complete) => DiskProtection(d, parts, new Protection(protectedKeys.ToHashSet(), complete, []));
    private static List<string> DiskProtection(Row d, List<Row> parts, Protection protection)
    {
        var reasons = new List<string>(); if (B(d, "IsBoot") || B(d, "IsSystem")) reasons.Add("Boot or system disk"); if (B(d, "IsClustered")) reasons.Add("Cluster disk"); if (U(d, "BusType") == 16) reasons.Add("Storage Spaces disk"); if (string.IsNullOrEmpty(S(d, "UniqueId"))) reasons.Add("Stable disk ID missing");
        bool critical = parts.Any(p => { bool onlyMsr = S(p, "GptType").Trim('{', '}').Equals(MsrGuid, StringComparison.OrdinalIgnoreCase) && !B(p, "IsBoot") && !B(p, "IsSystem") && !B(p, "IsActive") && !B(p, "IsShadowCopy") && !protection.Keys.Contains(Key(p)); return !onlyMsr && PartitionProtection(p, protection).Any(r => r != ReadOnlyPartition); });
        if (critical) reasons.Add("Contains protected partitions"); if (!protection.Complete) reasons.Add(IncompleteProtection); return reasons;
    }
    private static bool CanGrowOs(Row disk, Row part, Row? volume, Protection protection)
    {
        string gpt = S(part, "GptType").Trim('{', '}');
        return protection.Complete && B(part, "IsBoot") && !B(disk, "IsClustered") && U(disk, "BusType") != 16 && S(disk, "UniqueId").Length > 0 && !B(part, "IsHidden") && !B(part, "IsShadowCopy") && !B(part, "IsReadOnly") && (gpt.Length == 0 || gpt.Equals(BasicDataGuid, StringComparison.OrdinalIgnoreCase)) && U(part, "MbrType") is not (39 or 66 or 239 or 5 or 15) && volume is not null && S(volume, "FileSystem") == "NTFS";
    }

    private static AgentMessage Execute(string root, string action, JsonObject p, CancellationToken token)
    {
        if (action == "storage-inspect") return AgentMessages.Of("AGENT_STORAGE_INVENTORY_COLLECTED");
        var t = Load(token); Row[] targets = t.Disks.Where(d => U(d, "Number") == (ulong)DiagnosticParameters.Integer(p, "diskNumber", 0, 65535)).ToArray();
        if (targets.Length != 1) throw new AgentMessageException("AGENT_STORAGE_DISK_NOT_UNIQUE"); Row disk = targets[0];
        if (!S(disk, "UniqueId").Equals(p["diskUniqueId"]!.GetValue<string>(), StringComparison.Ordinal) || U(disk, "Size") != (ulong)p["expectedDiskSizeBytes"]!.GetValue<long>()) throw new AgentMessageException("AGENT_STORAGE_DISK_CHANGED");
        Protection protection = Protect(root, t); var parts = t.Partitions.Where(v => U(v, "DiskNumber") == U(disk, "Number")).ToList(); var diskReasons = DiskProtection(disk, parts, protection); Row? part = null; Row? volume = null;
        if (p.ContainsKey("partitionNumber"))
        {
            var selected = parts.Where(v => U(v, "PartitionNumber") == (ulong)p["partitionNumber"]!.GetValue<long>()).ToArray(); if (selected.Length != 1) throw new AgentMessageException("AGENT_STORAGE_PARTITION_NOT_UNIQUE"); part = selected[0]; volume = Volume(part, t);
            if (U(part, "Offset") != (ulong)p["expectedOffsetBytes"]!.GetValue<long>() || U(part, "Size") != (ulong)p["expectedSizeBytes"]!.GetValue<long>()) throw new AgentMessageException("AGENT_STORAGE_PARTITION_CHANGED");
            bool osGrow = action == "storage-resize" && (ulong)p["sizeBytes"]!.GetValue<long>() > U(part, "Size") && CanGrowOs(disk, part, volume, protection);
            var reasons = PartitionProtection(part, protection); if (reasons.Count > 0 && !osGrow) throw new AgentMessageException("AGENT_STORAGE_PARTITION_PROTECTED", ("reasons", string.Join(", ", reasons))); if (diskReasons.Count > 0 && !osGrow) throw new AgentMessageException("AGENT_STORAGE_DISK_PROTECTED", ("reasons", string.Join(", ", diskReasons)));
        }
        else if (diskReasons.Count > 0) throw new AgentMessageException("AGENT_STORAGE_DISK_PROTECTED", ("reasons", string.Join(", ", diskReasons)));
        token.ThrowIfCancellationRequested();
        if (action == "storage-set-disk")
        {
            string setting = p["setting"]!.GetValue<string>();
            if (setting is "online" or "offline") Invoke(disk, setting == "online" ? "Online" : "Offline");
            else Invoke(disk, "SetAttributes", new Row { ["IsReadOnly"] = setting == "readOnly" });
            return AgentMessages.Of("AGENT_STORAGE_DISK_STATE_CHANGED");
        }
        if (B(disk, "IsOffline") || B(disk, "IsReadOnly")) throw new AgentMessageException("AGENT_STORAGE_DISK_NOT_WRITABLE"); if (U(disk, "HealthStatus") != 0) throw new AgentMessageException("AGENT_STORAGE_DISK_UNHEALTHY");
        switch (action)
        {
            case "storage-initialize":
                if (U(disk, "PartitionStyle") != 0 || parts.Count != 0) throw new AgentMessageException("AGENT_STORAGE_INIT_ONLY_RAW");
                if (p["partitionStyle"]!.GetValue<string>() == "MBR" && U(disk, "Size") > 2199023255552UL) throw new AgentMessageException("AGENT_STORAGE_GPT_REQUIRED");
                Invoke(disk, "Initialize", new Row { ["PartitionStyle"] = (ushort)(p["partitionStyle"]!.GetValue<string>() == "GPT" ? 2 : 1) }); return AgentMessages.Of("AGENT_STORAGE_INITIALIZED");
            case "storage-new-volume":
                if (U(disk, "PartitionStyle") is not (1 or 2)) throw new AgentMessageException("AGENT_STORAGE_INITIALIZE_FIRST");
                EnsureLetterFree(p["driveLetter"]?.GetValue<string>(), null, t);
                bool maximum = p["useMaximumSize"]!.GetValue<bool>(); ulong size = maximum ? 0 : (ulong)p["sizeBytes"]!.GetValue<long>(); if (!maximum && size > U(disk, "LargestFreeExtent")) throw new AgentMessageException("AGENT_STORAGE_SIZE_EXCEEDS_FREE");
                var args = new Row { ["IsHidden"] = false };
                if (maximum) args["UseMaximumSize"] = true; else args["Size"] = size; if (p["driveLetter"] is not null) args["DriveLetter"] = p["driveLetter"]!.GetValue<string>()[0];
                if (U(disk, "PartitionStyle") == 2) args["GptType"] = "{" + BasicDataGuid + "}"; else { args["MbrType"] = (ushort)7; args["IsActive"] = false; }
                Invoke(disk, "CreatePartition", args);
                // CreatedPartition is embedded CIM/MOF, not an object path. Recheck the stable disk identity and require one new provider ObjectId/offset before formatting.
                Topology fresh = Load(token); Row[] sameDisk = fresh.Disks.Where(v => U(v, "Number") == U(disk, "Number") && S(v, "UniqueId").Equals(S(disk, "UniqueId"), StringComparison.Ordinal) && U(v, "Size") == U(disk, "Size")).ToArray(); if (sameDisk.Length != 1) throw new AgentMessageException("AGENT_STORAGE_DISK_CHANGED_DURING_CREATE"); Row[] newParts = fresh.Partitions.Where(v => U(v, "DiskNumber") == U(disk, "Number") && (U(disk, "PartitionStyle") == 2 ? S(v, "GptType").Trim('{', '}').Equals(BasicDataGuid, StringComparison.OrdinalIgnoreCase) : U(v, "MbrType") == 7) && !parts.Any(old => S(old, "ObjectId") == S(v, "ObjectId") && U(old, "Offset") == U(v, "Offset"))).ToArray();
                if (newParts.Length != 1) throw new AgentMessageException("AGENT_STORAGE_NEW_PARTITION_UNKNOWN");
                try { Row newVolume = Volume(newParts[0], fresh) ?? throw new InvalidDataException("The new volume is not available yet."); Format(newVolume, p); }
                catch (Exception e) { throw new AgentMessageException(e, "AGENT_STORAGE_FORMAT_FAILED", ("detail", e.Message)); }
                return AgentMessages.Of("AGENT_STORAGE_VOLUME_CREATED");
            case "storage-resize":
                if (volume is null || S(volume, "FileSystem") is not ("NTFS" or "ReFS")) throw new AgentMessageException("AGENT_STORAGE_RESIZE_FILE_SYSTEM");
                var range = Invoke(part!, "GetSupportedSize"); ulong requested = (ulong)p["sizeBytes"]!.GetValue<long>(); if (requested < U(range, "SizeMin") || requested > U(range, "SizeMax")) throw new AgentMessageException("AGENT_STORAGE_RESIZE_RANGE");
                Invoke(part!, "Resize", new Row { ["Size"] = requested }, TimeSpan.FromMinutes(15)); return AgentMessages.Of("AGENT_STORAGE_RESIZED");
            case "storage-drive-letter":
                bool remove = p["remove"]!.GetValue<bool>(); string current = Letter(part!);
                if (remove) { if (current.Length == 0) throw new AgentMessageException("AGENT_STORAGE_NO_DRIVE_LETTER"); Invoke(part!, "RemoveAccessPath", new Row { ["AccessPath"] = current + @":\" }); }
                else { string letter = p["driveLetter"]!.GetValue<string>(); EnsureLetterFree(letter, part, t); if (letter != current) { Invoke(part!, "AddAccessPath", new Row { ["AccessPath"] = letter + @":\" }); if (current.Length > 0) Invoke(part!, "RemoveAccessPath", new Row { ["AccessPath"] = current + @":\" }); } }
                return AgentMessages.Of("AGENT_STORAGE_DRIVE_LETTER_CHANGED");
            case "storage-format":
                Format(volume ?? throw new AgentMessageException("AGENT_STORAGE_VOLUME_NOT_UNIQUE"), p); return AgentMessages.Of("AGENT_STORAGE_FORMATTED");
            case "storage-delete-partition":
                Invoke(part!, "DeleteObject"); return AgentMessages.Of("AGENT_STORAGE_PARTITION_DELETED");
        }
        throw new AgentMessageException("AGENT_STORAGE_UNKNOWN_ACTION");
    }

    private static void EnsureLetterFree(string? letter, Row? current, Topology t)
    {
        if (string.IsNullOrEmpty(letter)) return;
        if (t.Partitions.Any(p => Letter(p).Equals(letter, StringComparison.OrdinalIgnoreCase) && (current is null || Key(p) != Key(current))) || Directory.GetLogicalDrives().Any(p => p.StartsWith(letter + ":", StringComparison.OrdinalIgnoreCase)) && (current is null || Letter(current) != letter)) throw new AgentMessageException("AGENT_STORAGE_LETTER_IN_USE");
    }
    private static void Format(Row volume, JsonObject p) => Invoke(volume, "Format", new Row { ["FileSystem"] = p["fileSystem"]!.GetValue<string>(), ["FileSystemLabel"] = p["label"]!.GetValue<string>(), ["Full"] = false, ["Force"] = false }, TimeSpan.FromMinutes(30));
    private static Row Invoke(Row row, string method, Row? arguments = null, TimeSpan? timeout = null)
    {
        string path = S(row, "__PATH"); if (path.Length == 0) throw new AgentMessageException("AGENT_STORAGE_OBJECT_PATH_MISSING");
        Row result = WindowsManagement.Invoke(StorageNamespace, path, method, arguments, timeout ?? TimeSpan.FromMinutes(2));
        if (!result.ContainsKey("ReturnValue")) throw new AgentMessageException("AGENT_STORAGE_NO_STATUS"); ulong status = U(result, "ReturnValue"); if (status != 0) throw new AgentMessageException("AGENT_STORAGE_METHOD_FAILED", ("method", method), ("status", status), ("detail", S(result, "ExtendedStatus"))); return result;
    }
    private static Row? Volume(Row p, Topology t)
    {
        string path = Relative(S(p, "__PATH"));
        var links = t.Associations.Where(a => Relative(S(a, "Partition")).Equals(path, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (links.Length != 1) return null; string volumePath = Relative(S(links[0], "Volume")); Row[] match = t.Volumes.Where(v => Relative(S(v, "__PATH")).Equals(volumePath, StringComparison.OrdinalIgnoreCase)).ToArray(); return match.Length == 1 ? match[0] : null;
    }
    private static string Relative(string path) { int colon = path.IndexOf(':'); return colon < 0 ? path : path[(colon + 1)..]; }
    private static bool SameVolume(string a, string b) => a.TrimEnd('\\').Equals(b.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    private static string Key(Row p) => U(p, "DiskNumber") + ":" + U(p, "PartitionNumber");
    private static string Letter(Row p) { string s = S(p, "DriveLetter"); return s.Length == 1 && char.IsAsciiLetter(s[0]) ? s.ToUpperInvariant() : ""; }
    private static string PartitionType(Row p) { string gpt = S(p, "GptType").Trim('{', '}').ToUpperInvariant(); return gpt switch { BasicDataGuid => "Basic", MsrGuid => "Reserved", "C12A7328-F81F-11D2-BA4B-00A0C93EC93B" => "System", "DE94BBA4-06D1-4D40-A16A-BFD50179D6AC" => "Recovery", "" => U(p, "MbrType") switch { 7 or 11 or 12 or 14 => "IFS", 5 or 15 => "Extended", 39 => "Recovery", 239 => "System", _ => "Unknown" }, _ => "Unknown" }; }
    private static string Style(ulong style) => style switch { 0 => "RAW", 1 => "MBR", 2 => "GPT", _ => "Unknown" };
    private static string Bus(ulong bus) => bus switch { 1 => "SCSI", 2 => "ATAPI", 3 => "ATA", 4 => "1394", 5 => "SSA", 6 => "Fibre Channel", 7 => "USB", 8 => "RAID", 9 => "iSCSI", 10 => "SAS", 11 => "SATA", 12 => "SD", 13 => "MMC", 14 => "Virtual", 15 => "File Backed Virtual", 16 => "Spaces", 17 => "NVMe", 18 => "SCM", 19 => "UFS", _ => "Unknown" };
    private static string DiskHealth(ulong health) => health switch { 0 => "Healthy", 1 => "Warning", 2 => "Unhealthy", _ => "Unknown" };
    private static string VolumeHealth(ulong health) => health switch { 0 => "Healthy", 1 => "Scan Needed", 2 => "Spot Fix Needed", 3 => "Full Repair Needed", _ => "Unknown" };
    private static string Operational(ulong status) => status switch { 0 => "Unknown", 1 => "Other", 2 => "OK", 3 => "Degraded", 4 => "Stressed", 5 => "Predictive Failure", 6 => "Error", 7 => "Non-Recoverable Error", 8 => "Starting", 9 => "Stopping", 10 => "Stopped", 11 => "In Service", 12 => "No Contact", 13 => "Lost Communication", 14 => "Aborted", 15 => "Dormant", 16 => "Supporting Entity in Error", 17 => "Completed", 18 => "Power Mode", _ => status.ToString(CultureInfo.InvariantCulture) };
    private static long CheckedBytes(Row r, string key) { ulong number = U(r, key); if (number > MaxBytes) throw new AgentMessageException("AGENT_STORAGE_SIZE_UNSAFE"); return (long)number; }
    private static string S(Row row, string key) => row.TryGetValue(key, out var value) ? Convert.ToString(value, CultureInfo.InvariantCulture) ?? "" : "";
    private static ulong U(Row row, string key) => row.TryGetValue(key, out var value) && value is not null ? Convert.ToUInt64(value, CultureInfo.InvariantCulture) : 0;
    private static bool B(Row row, string key) => row.TryGetValue(key, out var value) && value is not null && Convert.ToBoolean(value, CultureInfo.InvariantCulture);
    private static IEnumerable<object?> Values(Row row, string key) => row.TryGetValue(key, out var value) && value is Array arr ? arr.Cast<object?>() : value is not null ? [value] : [];
    private static IEnumerable<string> A(Row row, string key) => Values(row, key).Select(v => Convert.ToString(v, CultureInfo.InvariantCulture) ?? "");
    private static JsonArray Strings(IEnumerable<string> values) => new(values.Select(v => (JsonNode?)JsonValue.Create(v)).ToArray());
    private static string Short(string value, int limit) => value[..Math.Min(value.Length, limit)];
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "GetVolumePathNameW")]
    private static extern bool GetVolumePathName(string fileName, StringBuilder volumePathName, int bufferLength);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "GetVolumeNameForVolumeMountPointW")]
    private static extern bool GetVolumeNameForVolumeMountPoint(string volumeMountPoint, StringBuilder volumeName, int bufferLength);
}
