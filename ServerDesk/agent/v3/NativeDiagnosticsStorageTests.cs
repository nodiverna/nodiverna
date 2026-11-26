using System.Text.Json.Nodes;
using Row = System.Collections.Generic.Dictionary<string, object?>;
namespace ServerDesk.Agent;

// Pure contract/safety tests: no Windows provider calls and no disk/process mutations.
internal static class NativeDiagnosticsStorageTests
{
    internal static void Run()
    {
        void Reject(Action test, string name) { bool rejected = false; try { test(); } catch (InvalidDataException) { rejected = true; } catch (AgentMessageException) { rejected = true; } if (!rejected) throw new Exception("Native diagnostics/storage accepted " + name); }
        JsonObject Parse(string text) => JsonNode.Parse(text)!.AsObject();
        const string disk = "\"diskNumber\":1,\"diskUniqueId\":\"disk-stable-1\",\"expectedDiskSizeBytes\":107374182400,\"confirm\":true";
        NativeStorage.Validate("storage-inspect", new());
        NativeStorage.Validate("storage-initialize", Parse("{" + disk + ",\"partitionStyle\":\"GPT\"}"));
        NativeStorage.Validate("storage-new-volume", Parse("{" + disk + ",\"useMaximumSize\":true,\"driveLetter\":\"D\",\"fileSystem\":\"NTFS\",\"label\":\"Data\"}"));
        NativeStorage.Validate("storage-new-volume", Parse("{" + disk + ",\"useMaximumSize\":false,\"sizeBytes\":4294967296,\"fileSystem\":\"ReFS\",\"label\":\"\"}"));
        Reject(() => NativeStorage.Validate("storage-inspect", Parse("{\"diskNumber\":1}")), "unexpected inspect mutation target");
        Reject(() => NativeStorage.Validate("storage-initialize", Parse("{" + disk.Replace("true", "false") + ",\"partitionStyle\":\"GPT\"}")), "unconfirmed disk mutation");
        Reject(() => NativeStorage.Validate("storage-initialize", Parse("{" + disk.Replace("\"diskNumber\":1", "\"diskNumber\":\"1\"") + ",\"partitionStyle\":\"GPT\"}")), "string disk number");
        Reject(() => NativeStorage.Validate("storage-new-volume", Parse("{" + disk + ",\"useMaximumSize\":true,\"sizeBytes\":4294967296,\"fileSystem\":\"NTFS\",\"label\":\"Data\"}")), "ambiguous size request");
        Reject(() => NativeStorage.Validate("storage-new-volume", Parse("{" + disk + ",\"useMaximumSize\":false,\"sizeBytes\":1048576,\"fileSystem\":\"NTFS\",\"label\":\"Data\"}")), "undersized volume");
        Reject(() => NativeStorage.Validate("storage-new-volume", Parse("{" + disk + ",\"useMaximumSize\":true,\"driveLetter\":\"C\",\"fileSystem\":\"NTFS\",\"label\":\"Data\"}")), "system drive letter");
        Reject(() => NativeStorage.Validate("storage-new-volume", Parse("{" + disk + ",\"useMaximumSize\":true,\"fileSystem\":\"NTFS\",\"label\":\"bad/path\"}")), "invalid volume label");
        const string part = ",\"partitionNumber\":2,\"expectedOffsetBytes\":1048576,\"expectedSizeBytes\":4294967296";
        NativeStorage.Validate("storage-resize", Parse("{" + disk + part + ",\"sizeBytes\":8589934592}"));
        Reject(() => NativeStorage.Validate("storage-drive-letter", Parse("{" + disk + part + ",\"remove\":true,\"driveLetter\":\"D\"}")), "ambiguous letter removal");
        NativeStorage.Validate("storage-delete-partition", Parse("{" + disk + part + "}"));
        var data = new Row { ["DiskNumber"] = 1, ["PartitionNumber"] = 2, ["GptType"] = "{EBD0A0A2-B9E5-4433-87C0-68B6B72699C7}", ["MbrType"] = 0 };
        var rawDisk = new Row { ["UniqueId"] = "stable", ["BusType"] = 1, ["PartitionStyle"] = 0 };
        if (NativeStorage.PartitionProtection(data, [], true).Count != 0 || NativeStorage.DiskProtection(rawDisk, [], [], true).Count != 0) throw new Exception("Native storage blocks an ordinary data partition or empty RAW disk.");
        if (NativeStorage.PartitionProtection(data, ["1:2"], true).Count == 0 || NativeStorage.PartitionProtection(data, [], false).Count == 0) throw new Exception("Critical path or unknown topology did not fail closed.");
        var msr = new Row { ["DiskNumber"] = 1, ["PartitionNumber"] = 1, ["GptType"] = "{e3c9e316-0b5c-4db8-817d-f92df00215ae}" };
        if (NativeStorage.PartitionProtection(msr, [], true).Count == 0 || NativeStorage.DiskProtection(rawDisk, [msr, data], [], true).Count != 0) throw new Exception("MSR protection leaked to adjacent data partitions or vanished.");
        if (NativeStorage.DiskProtection(new Row { ["UniqueId"] = "stable", ["IsClustered"] = true }, [], [], true).Count == 0 || NativeStorage.DiskProtection(new Row { ["UniqueId"] = "stable", ["BusType"] = 16 }, [], [], true).Count == 0) throw new Exception("Cluster or Storage Spaces disk was not protected.");
        string xpath = NativeDiagnostics.EventXPath(Parse("{\"channel\":\"System\",\"levels\":[1,2],\"eventIds\":[1000],\"provider\":\"Service Control Manager\"}"));
        if (!xpath.Contains("(Level=1 or Level=2)") || !xpath.Contains("EventID=1000") || !xpath.Contains("Provider[@Name='Service Control Manager']")) throw new Exception("Event filters lost their conditions.");
        Reject(() => NativeDiagnostics.EventXPath(Parse("{\"provider\":\"x'] or *[\"}")), "XPath provider injection");
        Reject(() => NativeDiagnostics.EventXPath(Parse("{\"levels\":[6]}")), "invalid event level");
        Reject(() => NativeDiagnostics.EventXPath(Parse("{\"includeXml\":\"true\"}")), "string XML flag");
        Reject(() => NativeDiagnostics.EventXPath(Parse("{\"channel\":\"System\",\"cursor\":{\"channel\":\"Security\",\"recordId\":1,\"timeCreated\":\"2026-10-08T14:00:00Z\"}}")), "cursor from another channel");
        Reject(() => NativeDiagnostics.EventXPath(Parse("{\"from\":\"2026-10-08T14:00:00Z\",\"to\":\"2026-10-07T14:00:00Z\"}")), "inverted date range");
        Reject(() => DiagnosticParameters.Integer(Parse("{\"pid\":true}"), "pid", 1, int.MaxValue), "boolean process ID");
        Reject(() => DiagnosticParameters.Integer(Parse("{\"pid\":1.5}"), "pid", 1, int.MaxValue), "fractional process ID");
        Reject(() => DiagnosticParameters.Date(Parse("{\"startedAt\":\"2026-10-08T14:00:00\"}"), "startedAt"), "ambiguous process timestamp");
        if (NativeConnectionTables.Port(0xBB01) != 443 || NativeConnectionTables.Port(0x3500) != 53) throw new Exception("IP Helper network-order port decoding failed.");
    }
}
