using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class NativeRebootStatusTests
{
    internal static void Run()
    {
        static void Assert(bool condition, string label)
        {
            if (!condition) throw new InvalidOperationException("Native reboot status regression: " + label);
        }
        foreach (object? pending in new object?[] { null, Array.Empty<string>(), new[] { "" }, new[] { "", "" } })
        {
            var clear = NativeRebootStatus.Evaluate(false, false, pending);
            Assert(!clear.Pending && clear.Reasons.Length == 0 && clear.PendingFileOperationsCount == 0, "absent values and empty terminators mean no pending work");
        }
        foreach (var flags in new[] { (true, false), (false, true), (true, true) })
        {
            var reboot = NativeRebootStatus.Evaluate(flags.Item1, flags.Item2, null);
            Assert(reboot.Pending && reboot.Reasons.Contains("windows-servicing") == flags.Item1
                && reboot.Reasons.Contains("windows-update") == flags.Item2, "confirmed Windows reboot markers remain authoritative");
        }
        foreach (string source in new[] { @"C:\Windows\Temp\cleanup.tmp", @"\??\C:\Windows\Temp\cleanup.tmp", @"\\?\C:\Windows\Temp\cleanup.tmp", @"*1\??\C:\Windows\System32\gamingservicesproxy_13.dll.0" })
        {
            var cleanup = NativeRebootStatus.Evaluate(false, false, new[] { source, "" });
            Assert(!cleanup.Pending && cleanup.Reasons.Length == 0 && cleanup.PendingFileOperationsCount == 1, "valid local cleanup remains visible without manufacturing a reboot requirement");
            var updateAndCleanup = NativeRebootStatus.Evaluate(false, true, new[] { source, "" });
            Assert(updateAndCleanup.Pending && updateAndCleanup.Reasons.SequenceEqual(new[] { "windows-update" })
                && updateAndCleanup.PendingFileOperationsCount == 1, "cleanup never clears an independent Windows Update requirement");
        }
        var actualClient = NativeRebootStatus.Evaluate(false, false, new[] { @"*1\??\C:\Windows\System32\gamingservicesproxy_13.dll.0", "", @"*1\??\C:\WRP7A7F.tmp", "" });
        Assert(!actualClient.Pending && actualClient.PendingFileOperationsCount == 2, "the observed Windows 11 cleanup queue is neutral");
        foreach (string destination in new[] { @"C:\Windows\System32\driver.dll", @"\??\C:\Windows\System32\driver.dll", @"!\??\C:\Windows\System32\driver.dll", @"\\?\C:\Windows\System32\driver.dll" })
        {
            var rename = NativeRebootStatus.Evaluate(false, false, new[] { @"\??\C:\Temp\driver.new", destination });
            Assert(rename.Pending && rename.Reasons.SequenceEqual(new[] { "file-replacement" })
                && rename.PendingFileOperationsCount == 0, "file replacements still require a reboot");
        }
        foreach (object pending in new object[]
        {
            "invalid-registry-value", 1, new byte[] { 1 }, new[] { @"C:\Temp\unpaired.tmp" },
            new[] { @"C:\Temp\ok.tmp", "", @"C:\Temp\unpaired.tmp" }, new[] { "", @"C:\Temp\unexpected-target" },
            new[] { @"relative\file.tmp", "" }, new[] { @"C:file.tmp", "" }, new[] { @"\\host\share\file.tmp", "" },
            new[] { @"\SystemRoot\file.tmp", "" }, new[] { @"\??\UNC\host\share\file.tmp", "" },
            new[] { @"C:\Temp\..\file.tmp", "" }, new[] { "C:\\Temp\\invalid\0file.tmp", "" },
            new[] { @"C:\Temp\source.tmp", @"relative\target.dll" }, new[] { @"C:\Temp\source.tmp", null! },
            new[] { null!, "" }, new string[] { null!, null! }, new string[] { null! },
            new[] { @"C:\Temp\source.tmp", @"C:\Temp\target.dll:stream" }, new[] { @"C:\Temp\source.tmp", @"\Device\HarddiskVolume1\target.dll" }
        })
        {
            var unknown = NativeRebootStatus.Evaluate(false, false, pending);
            Assert(unknown.Pending && unknown.Reasons.Contains("file-operations-unknown"), "malformed/relative/unknown pending operations stay conservative");
        }
        var mixed = NativeRebootStatus.Evaluate(true, true, new[] { @"C:\Temp\cleanup.tmp", "", @"C:\Temp\replacement.tmp", @"C:\Windows\replacement.dll", @"C:\Temp\replacement2.tmp", @"!\??\C:\Windows\replacement2.dll", @"C:\Temp\unpaired.tmp" });
        Assert(mixed.Pending && mixed.PendingFileOperationsCount == 1 && mixed.Reasons.Length == 4
            && mixed.Reasons.Distinct().Count() == mixed.Reasons.Length, "mixed queues retain each distinct cause and neutral cleanup count");
        JsonObject json = mixed.ToJson();
        Assert(json["rebootPending"]!.GetValue<bool>() && json["pendingFileOperationsCount"]!.GetValue<int>() == 1
            && json["rebootReasons"]!.AsArray().Count == 4, "the heartbeat carries bounded causes and cleanup separately");
    }

    internal static int RunSelfTest()
    {
        try
        {
            Run(); NativePowerScheduleTests.Run();
            Console.WriteLine("Native health self-tests passed: confirmed reboot markers, replacement versus cleanup pairs, conservative malformed operations, mapped missing scheduler items, ownership and error propagation.");
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }
}
