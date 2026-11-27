using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// --crash-self-test: the merge rules over synthetic event records and the
// minidump parser over synthetic, truncated and manipulated dumps.
internal static class NativeCrashInventoryTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Crash inventory regression: " + message); }
    internal static int RunSelfTest() { try { Run(); Console.WriteLine("Crash inventory self-test passed."); return 0; } catch (Exception error) { Console.Error.WriteLine(error); return 1; } }

    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-20T12:00:00Z");

    private sealed class FakeSource : ICrashSource
    {
        internal List<CrashEventRecord> Records = [];
        internal List<MinidumpFile> Files = [];
        internal List<string> VersionLookups = [];
        internal int Reads;
        public IReadOnlyList<CrashEventRecord> Events(DateTimeOffset since, List<string> errors) => Records;
        public IReadOnlyList<MinidumpFile> Minidumps() => Files;
        public (string? Version, string? Manufacturer) DriverVersion(string name) { VersionLookups.Add(name); return name.Equals("vjoy.sys", StringComparison.OrdinalIgnoreCase) ? ("2.1.9.1", "Contoso Devices") : (null, null); }
        internal MinidumpFile File(string name, byte[] bytes, DateTimeOffset written, long? length = null) => new(name, length ?? bytes.LongLength, written, () => { Reads++; return bytes; });
    }

    // A 64-bit kernel triage dump: header page, TRIAGE_DUMP64, driver list and string pool.
    internal static byte[] Dump64(uint code, ulong[] parameters, ulong exceptionAddress, (string Name, ulong Base, uint Size)[] drivers, uint dumpType = 4)
    {
        const int triage = 0x2000, list = 0x2100, entry = 0x90;
        int pool = list + drivers.Length * entry;
        var names = drivers.Select(d => Encoding.Unicode.GetBytes(d.Name)).ToArray();
        int poolSize = names.Sum(n => 4 + n.Length);
        var data = new byte[pool + poolSize];
        "PAGE"u8.CopyTo(data); "DU64"u8.CopyTo(data.AsSpan(4));
        BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(0x38), code);
        for (int i = 0; i < 4; i++) BinaryPrimitives.WriteUInt64LittleEndian(data.AsSpan(0x40 + i * 8), parameters[i]);
        BinaryPrimitives.WriteUInt64LittleEndian(data.AsSpan(0xF10), exceptionAddress);
        BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(0xF98), dumpType);
        BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(triage + 0x30), list);
        BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(triage + 0x34), (uint)drivers.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(triage + 0x38), (uint)pool);
        BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(triage + 0x3C), (uint)poolSize);
        int cursor = pool;
        for (int i = 0; i < drivers.Length; i++)
        {
            int at = list + i * entry;
            BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(at), (uint)cursor);
            BinaryPrimitives.WriteUInt64LittleEndian(data.AsSpan(at + 0x38), drivers[i].Base);
            BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(at + 0x48), drivers[i].Size);
            BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(cursor), (uint)drivers[i].Name.Length);
            names[i].CopyTo(data.AsSpan(cursor + 4)); cursor += 4 + names[i].Length;
        }
        return data;
    }

    private static readonly (string, ulong, uint)[] Drivers = [(@"\SystemRoot\system32\ntoskrnl.exe", 0xfffff80000000000, 0x1000000), ("vjoy.sys", 0xfffff80410000000, 0x20000)];
    private static readonly ulong[] Parameters = [0xc0000005, 0xfffff80410001234, 0xffffd00012345678, 0];

    private static void Run()
    {
        // ---- Merge rules ----
        var source = new FakeSource();
        var crashAt = Now.AddDays(-2);
        source.Records =
        [
            new(CrashEventKind.KernelPower, crashAt.AddMinutes(2)),
            new(CrashEventKind.UnexpectedShutdown, crashAt.AddMinutes(2.5), RecordedShutdown: crashAt),
            new(CrashEventKind.BugCheck, crashAt.AddMinutes(3), 0x3B, Parameters, "102026-12000-01.dmp"),
        ];
        var result = new NativeCrashInventory(source, () => Now).Collect();
        var crashes = result["crashes"]!.AsArray();
        Check(crashes.Count == 1 && crashes[0]!["kind"]!.GetValue<string>() == "bugcheck" && crashes[0]!["stopCode"]!.GetValue<uint>() == 0x3B, "1001 + 41 + 6008 within minutes are one bugcheck.");
        Check(crashes[0]!["at"]!.GetValue<string>() == "2026-10-18T12:00:00.000Z", "at is the recorded shutdown time of 6008.");
        Check(crashes[0]!["parameters"]![1]!.GetValue<string>() == "0xfffff80410001234" && crashes[0]!["source"]!.GetValue<string>() == "event" && crashes[0]!["dumpStatus"]!.GetValue<string>() == "none", "parameters as hex; no dump.");
        Check(crashes[0]!["id"]!.GetValue<string>() == NativeCrashInventory.StableId("bugcheck", "2026-10-18T12:00:00.000Z") && result["crashInventory"]!["windowDays"]!.GetValue<int>() == 30 && result["crashInventory"]!["complete"]!.GetValue<bool>(), "stable id and inventory state.");

        source.Records = [new(CrashEventKind.KernelPower, Now.AddDays(-1))];
        crashes = new NativeCrashInventory(source, () => Now).Collect()["crashes"]!.AsArray();
        Check(crashes.Count == 1 && crashes[0]!["kind"]!.GetValue<string>() == "unexpected-shutdown" && crashes[0]!["stopCode"] is null, "41 alone is an unexpected shutdown.");
        source.Records = [new(CrashEventKind.KernelPower, Now.AddDays(-1), 0x9F, [3, 1, 2, 4])];
        Check(new NativeCrashInventory(source, () => Now).Collect()["crashes"]![0]!["kind"]!.GetValue<string>() == "bugcheck", "41 with a bugcheck code is a bugcheck.");
        source.Records = [new(CrashEventKind.Whea, Now.AddDays(-3), Detail: "WHEA 18, ErrorSource 3, ErrorType 9")];
        crashes = new NativeCrashInventory(source, () => Now).Collect()["crashes"]!.AsArray();
        Check(crashes.Count == 1 && crashes[0]!["kind"]!.GetValue<string>() == "hardware-error" && crashes[0]!["detail"]!.GetValue<string>().Contains("ErrorSource 3"), "a WHEA error is a hardware error with its detail.");
        source.Records = [new(CrashEventKind.Whea, Now.AddDays(-3), Detail: "WHEA 19", Error: false)];
        Check(new NativeCrashInventory(source, () => Now).Collect()["crashes"]!.AsArray().Count == 0, "a corrected WHEA warning is ignored.");
        source.Records = [new(CrashEventKind.KernelPower, Now.AddDays(-31)), new(CrashEventKind.KernelPower, Now.AddDays(-29))];
        Check(new NativeCrashInventory(source, () => Now).Collect()["crashes"]!.AsArray().Count == 1, "events older than 30 days are dropped.");
        source.Records = Enumerable.Range(0, 60).Select(i => new CrashEventRecord(CrashEventKind.KernelPower, Now.AddHours(-i * 6))).ToList();
        result = new NativeCrashInventory(source, () => Now).Collect();
        crashes = result["crashes"]!.AsArray();
        Check(crashes.Count == 50 && result["crashInventory"]!["truncated"]!.GetValue<bool>() && crashes[0]!["at"]!.GetValue<string>().CompareTo(crashes[49]!["at"]!.GetValue<string>()) > 0, "more than 50 crashes: the newest 50, newest first, truncated.");

        // ---- Minidumps ----
        var valid = Dump64(0x3B, Parameters, 0xfffff80410001234, Drivers);
        var parsed = NativeMinidumpParser.Parse(valid);
        Check(parsed.Status == "parsed" && parsed.StopCode == 0x3B && parsed.Parameters![0] == 0xc0000005 && parsed.Driver == "vjoy.sys", "valid 64-bit triage dump: stop code, parameters and the driver of the fault address.");
        Check(NativeMinidumpParser.Parse(Dump64(0x3B, Parameters, 0xfffff80000001000, Drivers)).Driver == "ntoskrnl.exe", "a full path in the string pool gives only the file name.");
        Check(NativeMinidumpParser.Parse(Dump64(0x3B, Parameters, 0x1234, Drivers)) is { Status: "parsed", Driver: null }, "valid without a matching module: driver null.");
        Check(NativeMinidumpParser.Parse(Dump64(0xD1, [0, 2, 0, 0xfffff80410000010], 0, Drivers)).Driver == "vjoy.sys", "without an exception address the code's address parameter is used (0xD1: P4).");
        Check(NativeMinidumpParser.Parse(Dump64(0x3B, Parameters, 0xfffff80410001234, Drivers, dumpType: 1)) is { Status: "parsed", Driver: null }, "a full kernel dump has no triage driver list.");
        var dump32 = new byte[0x1100]; "PAGE"u8.CopyTo(dump32); "DUMP"u8.CopyTo(dump32.AsSpan(4)); BinaryPrimitives.WriteUInt32LittleEndian(dump32.AsSpan(0x28), 0x7E);
        Check(NativeMinidumpParser.Parse(dump32) is { Status: "parsed", StopCode: 0x7E, Driver: null }, "the 32-bit dump format is read.");

        var watch = Stopwatch.StartNew();
        var broken = new List<(string Label, byte[] Bytes)>
        {
            ("truncated at the header", valid[..0x800]),
            ("truncated inside the driver list", valid[..(0x2100 + 0x90 + 0x20)]),
            ("truncated inside the string pool", valid[..(valid.Length - 6)]),
            ("wrong signature", Encoding.ASCII.GetBytes("MDMP").Concat(valid.Skip(4)).ToArray()),
            ("empty file", []),
        };
        byte[] Mutate(Action<byte[]> change) { var copy = (byte[])valid.Clone(); change(copy); return copy; }
        broken.Add(("driver list beyond EOF", Mutate(b => BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(0x2030), 0x7FFFFF00))));
        broken.Add(("string pool offset + size overflows", Mutate(b => { BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(0x2038), 0xFFFFFFF0); BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(0x203C), 0x20); })));
        broken.Add(("driver count 2^31", Mutate(b => BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(0x2034), 0x80000000))));
        broken.Add(("name offset beyond EOF", Mutate(b => BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(0x2100 + 0x90), 0xFFFFFFFC))));
        broken.Add(("string length beyond the pool", Mutate(b => { int pool = (int)BinaryPrimitives.ReadUInt32LittleEndian(b.AsSpan(0x2100 + 0x90)); BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(pool), 200); })));
        broken.Add(("string length 2^31", Mutate(b => { int pool = (int)BinaryPrimitives.ReadUInt32LittleEndian(b.AsSpan(0x2100 + 0x90)); BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(pool), 0x80000000); })));
        var random = new Random(42);
        for (int i = 0; i < 20; i++) { var bytes = new byte[random.Next(0, 20000)]; random.NextBytes(bytes); if (i % 2 == 0 && bytes.Length > 8) { "PAGEDU64"u8.CopyTo(bytes); } broken.Add(("random bytes " + i, bytes)); }
        foreach (var (label, bytes) in broken)
        {
            var outcome = NativeMinidumpParser.Parse(bytes);
            bool safe = outcome.Status == "unreadable" || outcome.Status == "parsed" && label.StartsWith("random", StringComparison.Ordinal);
            Check(safe && (label.StartsWith("random", StringComparison.Ordinal) || outcome.Status == "unreadable"), label + " gives unreadable without an exception (" + outcome.Status + ").");
        }
        Check(NativeMinidumpParser.Parse(new byte[33 * 1024 * 1024]).Status == "too-large", "a 33 MiB buffer is too large.");
        Check(watch.Elapsed < TimeSpan.FromSeconds(5), "the broken dumps parse in bounded time.");

        // ---- Dumps joined to crashes ----
        source = new FakeSource();
        source.Records = [new(CrashEventKind.BugCheck, crashAt, 0x3B, Parameters, "102026-12000-01.dmp")];
        source.Files =
        [
            source.File("102026-12000-01.dmp", valid, crashAt.AddHours(5)),
            source.File("101926-9000-01.dmp", Dump64(0x133, [0, 0x501, 0x500, 0], 0, Drivers), Now.AddDays(-5)),
            source.File("huge.dmp", [], Now.AddDays(-6), length: 33L * 1024 * 1024),
            source.File("broken.dmp", valid[..100], Now.AddDays(-7)),
        ];
        var inventory = new NativeCrashInventory(source, () => Now);
        result = inventory.Collect();
        crashes = result["crashes"]!.AsArray();
        var byFile = crashes.ToDictionary(c => c!["dumpFile"]?.GetValue<string>() ?? "", c => c!);
        Check(crashes.Count == 4, "one crash per event group and per unmatched dump.");
        Check(byFile["102026-12000-01.dmp"]["source"]!.GetValue<string>() == "event+minidump" && byFile["102026-12000-01.dmp"]["driver"]!["name"]!.GetValue<string>() == "vjoy.sys" && byFile["102026-12000-01.dmp"]["driver"]!["version"]!.GetValue<string>() == "2.1.9.1" && byFile["102026-12000-01.dmp"]["driver"]!["manufacturer"]!.GetValue<string>() == "Contoso Devices", "a dump joins its crash by the file name in the event; driver version and manufacturer.");
        Check(byFile["101926-9000-01.dmp"]["source"]!.GetValue<string>() == "minidump" && byFile["101926-9000-01.dmp"]["kind"]!.GetValue<string>() == "bugcheck" && byFile["101926-9000-01.dmp"]["stopCode"]!.GetValue<uint>() == 0x133, "a dump without an event is its own bugcheck.");
        Check(byFile["huge.dmp"]["dumpStatus"]!.GetValue<string>() == "too-large" && byFile["broken.dmp"]["dumpStatus"]!.GetValue<string>() == "unreadable", "too large and broken dumps keep an entry with their status.");
        Check(source.Reads == 3, "a too-large dump is never read.");
        string json = result.ToJsonString();
        Check(!json.Contains(@"\\", StringComparison.Ordinal) && !json.Contains("Windows", StringComparison.OrdinalIgnoreCase) && !json.Contains("SystemRoot", StringComparison.OrdinalIgnoreCase), "no path is in the output, only file names.");
        inventory.Collect();
        Check(source.Reads == 3, "parsed dumps are cached per name, size and write time.");
        source.Files = Enumerable.Range(0, 30).Select(i => source.File("many-" + i + ".dmp", valid, Now.AddDays(-1).AddMinutes(-i * 30))).ToList();
        source.Records = []; source.Reads = 0;
        crashes = new NativeCrashInventory(source, () => Now).Collect()["crashes"]!.AsArray();
        Check(source.Reads == 20 && crashes.Count == 20, "at most 20 dumps are parsed per run.");

        // ---- Driver names for the version lookup ----
        Check(NativeCrashInventory.PlainDriverName("vjoy.sys") && !NativeCrashInventory.PlainDriverName(@"..\evil.sys") && !NativeCrashInventory.PlainDriverName("a/b.sys") && !NativeCrashInventory.PlainDriverName("C:evil.sys") && !NativeCrashInventory.PlainDriverName(new string('a', 65)) && !NativeCrashInventory.PlainDriverName(".."), "only a plain file name of at most 64 characters is looked up.");
        Check(source.VersionLookups.All(NativeCrashInventory.PlainDriverName), "the collector never looks up a name with separators.");
        foreach (var name in new[] { "con", "CON.sys", "nul.sys", "Aux", "com1.sys", "LPT9", "COM¹.sys", "conin$", "clock$.sys", "vjoy.sys.", "vjoy.sys ", "CON .sys", "prn", "conout$.sys", "lpt³" })
            Check(!NativeCrashInventory.PlainDriverName(name), "a reserved device name or a trailing space or dot is never looked up: " + name);
        foreach (var name in new[] { "vjoy.sys", "console.sys", "nullsys.sys", "com10.sys", "auxiliary.sys" })
            Check(NativeCrashInventory.PlainDriverName(name), "a plain driver name is looked up: " + name);

        // A dump whose driver is a reserved device name keeps the name, without a version lookup.
        source = new FakeSource();
        source.Files = [source.File("nul.dmp", Dump64(0x3B, Parameters, 0xfffff80410001234, [("nul.sys", 0xfffff80410000000, 0x20000)]), Now.AddDays(-1))];
        crashes = new NativeCrashInventory(source, () => Now).Collect()["crashes"]!.AsArray();
        Check(crashes.Count == 1 && crashes[0]!["driver"]!["name"]!.GetValue<string>() == "nul.sys" && crashes[0]!["driver"]!["version"] is null && crashes[0]!["driver"]!["manufacturer"] is null, "a reserved driver name is reported with version and manufacturer null.");
        Check(source.VersionLookups.Count == 0, "a reserved driver name is never looked up.");
        Check(new WindowsCrashSource().DriverVersion("nul.sys") == (null, null) && new WindowsCrashSource().DriverVersion("CON") == (null, null), "the Windows source refuses a reserved driver name.");

        if (OperatingSystem.IsWindows()) OpenDumpFileChecks();
    }

    // The handle path of the Windows source: a regular file opens; a directory and a file symbolic link are refused.
    private static void OpenDumpFileChecks()
    {
        string folder = Path.Combine(Path.GetTempPath(), "sd-crash-self-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            string file = Path.Combine(folder, "regular.dmp");
            byte[] bytes = Dump64(0x3B, Parameters, 0xfffff80410001234, Drivers);
            File.WriteAllBytes(file, bytes);
            using (var handle = WindowsCrashSource.OpenDumpFile(file)) Check(!handle.IsInvalid, "a regular dump file opens.");
            Check(WindowsCrashSource.ReadBounded(file).AsSpan().SequenceEqual(bytes), "the bytes read through the checked handle match the file.");
            Check(Refused(() => WindowsCrashSource.OpenDumpFile(folder)), "a directory is refused.");
            Check(Refused(() => WindowsCrashSource.ReadBounded(folder)), "a directory is never read.");
            string link = Path.Combine(folder, "link.dmp");
            bool linked;
            try { File.CreateSymbolicLink(link, file); linked = true; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { linked = false; Console.WriteLine("Crash inventory self-test: symbolic link case skipped (" + error.GetType().Name + ": no privilege to create a symbolic link)."); }
            if (linked)
            {
                Check(Refused(() => WindowsCrashSource.OpenDumpFile(link)), "a file symbolic link is refused.");
                var linkSource = new FakeSource();
                linkSource.Files = [new MinidumpFile("link.dmp", bytes.LongLength, Now.AddDays(-1), () => WindowsCrashSource.ReadBounded(link))];
                var entry = new NativeCrashInventory(linkSource, () => Now).Collect()["crashes"]!.AsArray();
                Check(entry.Count == 1 && entry[0]!["dumpStatus"]!.GetValue<string>() == "unreadable", "a refused dump keeps its entry as unreadable.");
            }
        }
        finally { try { Directory.Delete(folder, true); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
    }

    private static bool Refused(Action open)
    {
        try { open(); return false; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException or System.ComponentModel.Win32Exception) { return true; }
    }
}
