using System.Buffers.Binary;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.Win32.SafeHandles;

namespace ServerDesk.Agent;

// Crashes of the last 30 days (docs/v3-health-signals.md): bugchecks, unexpected
// shutdowns and uncorrected hardware errors from the event logs, merged into one
// entry per crash, plus the stop code and the probable driver from the
// minidumps in %SystemRoot%\Minidump. A dump is untrusted binary input read as
// SYSTEM: NativeMinidumpParser checks every offset, length and count against the
// file and fixed caps and never throws. Dump bytes, memory and paths never
// leave the device; only the dump's file name does.
internal enum CrashEventKind { BugCheck, WerBlueScreen, KernelPower, UnexpectedShutdown, Whea }

internal sealed record CrashEventRecord(CrashEventKind Kind, DateTimeOffset Logged, uint? StopCode = null, ulong[]? Parameters = null, string? DumpFile = null, DateTimeOffset? RecordedShutdown = null, string? Detail = null, bool Error = true);

internal sealed record MinidumpFile(string Name, long Length, DateTimeOffset Written, Func<byte[]> Read);

internal interface ICrashSource
{
    /// <summary>The crash events since <paramref name="since"/>; a log that cannot be read throws.</summary>
    IReadOnlyList<CrashEventRecord> Events(DateTimeOffset since, List<string> errors);
    IReadOnlyList<MinidumpFile> Minidumps();
    (string? Version, string? Manufacturer) DriverVersion(string name);
}

internal sealed class NativeCrashInventory(ICrashSource? source = null, Func<DateTimeOffset>? clock = null)
{
    internal const int IntervalSeconds = 900;
    internal const int DeadlineSeconds = 25;
    internal const int WindowDays = 30;
    internal const int MaximumEntries = 50;
    internal const int MaximumParsedDumps = 20;
    internal static readonly TimeSpan MergeWindow = TimeSpan.FromMinutes(10);
    private readonly ICrashSource crashes = source ?? new WindowsCrashSource();
    private readonly Func<DateTimeOffset> now = clock ?? (() => DateTimeOffset.UtcNow);
    private readonly Dictionary<string, MinidumpResult> cache = new(StringComparer.OrdinalIgnoreCase);
    private readonly object gate = new();

    internal JsonObject Collect()
    {
        lock (gate)
        {
            var at = now(); var since = at.AddDays(-WindowDays); var errors = new List<string>();
            IReadOnlyList<CrashEventRecord> events = [];
            try { events = crashes.Events(since, errors); }
            catch (Exception error) when (error is not OutOfMemoryException) { errors.Add("The event logs could not be read (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
            var dumps = new List<(MinidumpFile File, MinidumpResult Result)>();
            try
            {
                int parsed = 0; var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var file in crashes.Minidumps().Where(file => file.Written >= since).OrderByDescending(file => file.Written).Take(200))
                {
                    string key = file.Name + "|" + file.Length.ToString(CultureInfo.InvariantCulture) + "|" + file.Written.UtcTicks.ToString(CultureInfo.InvariantCulture);
                    seen.Add(key);
                    if (!cache.TryGetValue(key, out var result))
                    {
                        if (file.Length > NativeMinidumpParser.MaximumBytes) result = MinidumpResult.TooLarge;
                        else if (parsed >= MaximumParsedDumps) continue;
                        else { parsed++; result = ParseFile(file); }
                        cache[key] = result;
                    }
                    dumps.Add((file, result));
                }
                foreach (var stale in cache.Keys.Where(key => !seen.Contains(key)).ToArray()) cache.Remove(stale);
            }
            catch (Exception error) when (error is not OutOfMemoryException) { errors.Add("The minidump folder could not be read (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
            var entries = Merge(events.Where(e => e.Logged >= since).ToList(), dumps, since, crashes.DriverVersion);
            bool truncated = entries.Count > MaximumEntries;
            var inventory = new JsonObject { ["collectedAt"] = at.ToString("O"), ["windowDays"] = WindowDays, ["complete"] = errors.Count == 0, ["truncated"] = truncated };
            if (errors.Count > 0) inventory["error"] = Limit(string.Join(" ", errors), 256);
            return new JsonObject { ["crashes"] = new JsonArray(entries.Take(MaximumEntries).Select(entry => (JsonNode)entry).ToArray()), ["crashInventory"] = inventory };
        }
    }

    private static MinidumpResult ParseFile(MinidumpFile file)
    {
        try { return NativeMinidumpParser.Parse(file.Read()); }
        catch (Exception error) when (error is not OutOfMemoryException) { return MinidumpResult.Unreadable; }
    }

    /// <summary>One entry per crash, newest first: events within 10 minutes of each other are one crash; dumps join by file name or write time.</summary>
    internal static List<JsonObject> Merge(List<CrashEventRecord> events, List<(MinidumpFile File, MinidumpResult Result)> dumps, DateTimeOffset since, Func<string, (string? Version, string? Manufacturer)> driverVersion)
    {
        // Corrected hardware errors (warnings) are no crash.
        var relevant = events.Where(e => e.Kind != CrashEventKind.Whea || e.Error).OrderBy(e => e.Logged).ToList();
        var groups = new List<List<CrashEventRecord>>();
        foreach (var record in relevant)
        {
            if (groups.Count > 0 && record.Logged - groups[^1][^1].Logged <= MergeWindow) groups[^1].Add(record);
            else groups.Add([record]);
        }
        var crashes = groups.Select(group => new CrashDraft(group)).ToList();
        var unmatched = new List<(MinidumpFile File, MinidumpResult Result)>();
        foreach (var dump in dumps)
        {
            var target = crashes.FirstOrDefault(crash => crash.Dump is null && crash.DumpFiles.Contains(dump.File.Name))
                ?? crashes.Where(crash => crash.Dump is null && crash.Times.Any(time => (time - dump.File.Written).Duration() <= MergeWindow)).OrderBy(crash => crash.Times.Min(time => (time - dump.File.Written).Duration())).FirstOrDefault();
            if (target is not null) target.Dump = dump; else unmatched.Add(dump);
        }
        foreach (var dump in unmatched) crashes.Add(new CrashDraft([]) { Dump = dump, DumpOnly = dump.File.Written });
        return crashes.Select(crash => crash.ToJson(driverVersion)).Where(entry => entry is not null && DateTimeOffset.Parse(entry["at"]!.GetValue<string>(), CultureInfo.InvariantCulture) >= since)
            .Select(entry => entry!).OrderByDescending(entry => entry["at"]!.GetValue<string>(), StringComparer.Ordinal).ToList();
    }

    private sealed class CrashDraft(List<CrashEventRecord> events)
    {
        internal (MinidumpFile File, MinidumpResult Result)? Dump;
        internal DateTimeOffset? DumpOnly;
        internal HashSet<string> DumpFiles { get; } = new(events.Where(e => e.DumpFile is not null).Select(e => e.DumpFile!), StringComparer.OrdinalIgnoreCase);
        internal IEnumerable<DateTimeOffset> Times => events.Select(e => e.Logged).Concat(events.Where(e => e.RecordedShutdown is not null).Select(e => e.RecordedShutdown!.Value));

        internal JsonObject? ToJson(Func<string, (string? Version, string? Manufacturer)> driverVersion)
        {
            var coded = events.Where(e => e.StopCode is > 0).OrderBy(e => e.Kind switch { CrashEventKind.BugCheck => 0, CrashEventKind.WerBlueScreen => 1, _ => 2 }).FirstOrDefault();
            var dump = Dump?.Result;
            uint? stopCode = coded?.StopCode ?? (dump?.Status == "parsed" ? dump.StopCode : null);
            ulong[]? parameters = coded?.Parameters ?? (dump?.Status == "parsed" ? dump.Parameters : null);
            string kind = stopCode is > 0 || events.Count == 0 ? "bugcheck" : events.Any(e => e.Kind == CrashEventKind.Whea) ? "hardware-error" : "unexpected-shutdown";
            DateTimeOffset at = events.FirstOrDefault(e => e.RecordedShutdown is not null)?.RecordedShutdown ?? (events.Count > 0 ? events.Min(e => e.Logged) : DumpOnly ?? DateTimeOffset.MinValue);
            if (at == DateTimeOffset.MinValue) return null;
            string atText = at.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
            JsonObject? driver = null;
            if (dump?.Driver is string name)
            {
                var (version, manufacturer) = PlainDriverName(name) ? driverVersion(name) : (null, null);
                driver = new JsonObject { ["name"] = Limit(name, 256), ["version"] = version is null ? null : Limit(version, 256), ["manufacturer"] = manufacturer is null ? null : Limit(manufacturer, 256) };
            }
            string? detail = events.Where(e => e.Kind == CrashEventKind.Whea && e.Detail is not null).Select(e => e.Detail).FirstOrDefault();
            return new JsonObject
            {
                ["id"] = StableId(kind, atText), ["kind"] = kind, ["at"] = atText,
                ["stopCode"] = stopCode is null ? null : JsonValue.Create(stopCode.Value),
                ["parameters"] = parameters is { Length: 4 } ? new JsonArray(parameters.Select(value => (JsonNode)JsonValue.Create("0x" + value.ToString("x16", CultureInfo.InvariantCulture))!).ToArray()) : null,
                ["driver"] = driver,
                ["source"] = Dump is null ? "event" : events.Count == 0 ? "minidump" : "event+minidump",
                ["dumpFile"] = Dump is null ? null : Limit(Dump.Value.File.Name, 256),
                ["dumpStatus"] = dump?.Status ?? "none",
                ["detail"] = detail is null ? null : Limit(detail, 256)
            };
        }
    }

    /// <summary>A plain driver file name: no separators, no "..", at most 64 characters, no trailing space or dot and no reserved DOS device name; only then the agent looks up its file version.</summary>
    internal static bool PlainDriverName(string name) => name.Length is > 0 and <= 64 && name.IndexOfAny(['\\', '/', ':']) < 0 && name != "." && !name.Contains("..", StringComparison.Ordinal) && name.All(c => !char.IsControl(c))
        && !name.EndsWith(' ') && !name.EndsWith('.') && !ReservedDeviceNames.Contains(name.Split('.')[0].TrimEnd(' '));

    // Older hosts (Server 2016 to 2022) open the device for "NUL.ext" too, so the part before the first dot is compared.
    internal static readonly HashSet<string> ReservedDeviceNames = new(
        ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$",
         .. Enumerable.Range(0, 10).SelectMany(digit => new[] { "COM" + digit, "LPT" + digit }),
         "COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"],
        StringComparer.OrdinalIgnoreCase);
    internal static string StableId(string kind, string at) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(kind + "|" + at)))[..16].ToLowerInvariant();
    internal static string Limit(string value, int maximum) => value.Length <= maximum ? value : value[..maximum];
}

internal sealed record MinidumpResult(string Status, uint? StopCode = null, ulong[]? Parameters = null, string? Driver = null)
{
    internal static readonly MinidumpResult Unreadable = new("unreadable");
    internal static readonly MinidumpResult TooLarge = new("too-large");
}

// Kernel dump header and triage dump (DUMP_HEADER64/32, TRIAGE_DUMP64/32). Every
// offset, length and count is checked against the buffer and a fixed cap
// before it is used; arithmetic is checked; allocations never follow an
// untrusted size beyond those caps. Any failure gives "unreadable".
internal static class NativeMinidumpParser
{
    internal const long MaximumBytes = 32L * 1024 * 1024;
    internal const int MaximumDrivers = 4096;
    internal const int MaximumNameChars = 260;
    private const uint DumpTypeTriage = 4;
    private sealed record Layout(int HeaderSize, int BugCheckCode, int Parameters, int ParameterSize, int ExceptionAddress, int ContextIp, int DumpType, int DriverEntrySize, int DllBase, int SizeOfImage);
    private static readonly Layout Layout64 = new(0x2000, 0x38, 0x40, 8, 0xF10, 0x348 + 0xF8, 0xF98, 0x90, 0x38, 0x48);
    private static readonly Layout Layout32 = new(0x1000, 0x28, 0x2C, 4, 0x7DC, 0x320 + 0xB8, 0xF88, 0x4C, 0x1C, 0x24);

    internal static MinidumpResult Parse(byte[] data)
    {
        try { return ParseUnchecked(data); }
        catch (Exception error) when (error is not OutOfMemoryException) { return MinidumpResult.Unreadable; }
    }

    private static MinidumpResult ParseUnchecked(byte[] data)
    {
        if (data.LongLength > MaximumBytes) return MinidumpResult.TooLarge;
        var span = new ReadOnlySpan<byte>(data);
        if (span.Length < 8 || !span[..4].SequenceEqual("PAGE"u8)) return MinidumpResult.Unreadable;
        Layout layout = span.Slice(4, 4).SequenceEqual("DU64"u8) ? Layout64 : span.Slice(4, 4).SequenceEqual("DUMP"u8) ? Layout32 : null!;
        if (layout is null || span.Length < layout.HeaderSize) return MinidumpResult.Unreadable;
        bool wide = layout == Layout64;
        uint code = U32(span, layout.BugCheckCode);
        var parameters = new ulong[4];
        for (int i = 0; i < 4; i++) parameters[i] = wide ? U64(span, checked(layout.Parameters + i * 8)) : U32(span, checked(layout.Parameters + i * 4));
        ulong address = wide ? U64(span, layout.ExceptionAddress) : U32(span, layout.ExceptionAddress);
        if (address == 0) address = wide ? U64(span, layout.ContextIp) : U32(span, layout.ContextIp);
        if (address == 0) address = ParameterAddress(code, parameters);
        string? driver = null;
        if (U32(span, layout.DumpType) == DumpTypeTriage) driver = FindDriver(span, layout, wide, address);
        return new MinidumpResult("parsed", code, parameters, driver);
    }

    /// <summary>The address parameter of stop codes that name the faulting address.</summary>
    internal static ulong ParameterAddress(uint code, ulong[] parameters) => code switch
    {
        0x3B or 0x7E or 0x1E or 0x8E => parameters[1],
        0xD1 or 0x0A => parameters[3],
        0x50 => parameters[2],
        _ => 0
    };

    private static string? FindDriver(ReadOnlySpan<byte> span, Layout layout, bool wide, ulong address)
    {
        if (address == 0) return null;
        int triage = layout.HeaderSize;
        Require(span, triage, 0x40);
        uint listOffset = U32(span, triage + 0x30), count = U32(span, triage + 0x34), poolOffset = U32(span, triage + 0x38), poolSize = U32(span, triage + 0x3C);
        if (count > MaximumDrivers) throw new InvalidDataException("Too many drivers.");
        long poolEnd = checked((long)poolOffset + poolSize);
        if (poolOffset < triage || poolEnd > span.Length) throw new InvalidDataException("String pool outside the file.");
        long listEnd = checked((long)listOffset + (long)count * layout.DriverEntrySize);
        if (listOffset < triage || listEnd > span.Length) throw new InvalidDataException("Driver list outside the file.");
        for (int i = 0; i < count; i++)
        {
            int entry = checked((int)listOffset + i * layout.DriverEntrySize);
            ulong baseAddress = wide ? U64(span, entry + layout.DllBase) : U32(span, entry + layout.DllBase);
            uint size = U32(span, entry + layout.SizeOfImage);
            if (size == 0 || address < baseAddress || address - baseAddress >= size) continue;
            return DriverName(span, U32(span, entry), poolOffset, poolEnd);
        }
        return null;
    }

    // DUMP_STRING inside the string pool: ULONG length in characters, then UTF-16.
    private static string DriverName(ReadOnlySpan<byte> span, uint offset, uint poolStart, long poolEnd)
    {
        if (offset < poolStart || checked((long)offset + 4) > poolEnd) throw new InvalidDataException("Driver name outside the string pool.");
        uint length = U32(span, (int)offset);
        if (length == 0 || length > MaximumNameChars) throw new InvalidDataException("Driver name too long.");
        long end = checked((long)offset + 4 + length * 2L);
        if (end > poolEnd) throw new InvalidDataException("Driver name beyond the string pool.");
        string name = Encoding.Unicode.GetString(span.Slice((int)offset + 4, (int)length * 2));
        // The pool holds full paths for some entries; only the file name is reported.
        int slash = name.LastIndexOfAny(['\\', '/']);
        name = (slash >= 0 ? name[(slash + 1)..] : name).Trim();
        if (name.Length == 0 || name.Any(char.IsControl)) throw new InvalidDataException("Invalid driver name.");
        return name;
    }

    private static void Require(ReadOnlySpan<byte> span, int offset, int length) { if (offset < 0 || length < 0 || checked((long)offset + length) > span.Length) throw new InvalidDataException("Read outside the file."); }
    private static uint U32(ReadOnlySpan<byte> span, int offset) { Require(span, offset, 4); return BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(offset, 4)); }
    private static ulong U64(ReadOnlySpan<byte> span, int offset) { Require(span, offset, 8); return BinaryPrimitives.ReadUInt64LittleEndian(span.Slice(offset, 8)); }
}

// The Windows sources: fixed XPath queries over the System and Application
// logs, the Minidump folder without recursion or reparse points (each dump
// opened through one checked handle, OpenDumpFile), and the version resource
// of a driver in System32\drivers.
internal sealed partial class WindowsCrashSource : ICrashSource
{
    private const int MaximumEvents = 500;

    public IReadOnlyList<CrashEventRecord> Events(DateTimeOffset since, List<string> errors)
    {
        long window = Math.Max(1, (long)(DateTimeOffset.UtcNow - since).TotalMilliseconds);
        string time = "TimeCreated[timediff(@SystemTime) <= " + window.ToString(CultureInfo.InvariantCulture) + "]";
        var result = new List<CrashEventRecord>();
        void Read(string log, string xpath, Func<EventRecord, CrashEventRecord?> map)
        {
            try
            {
                using var reader = new EventLogReader(new EventLogQuery(log, PathType.LogName, xpath) { ReverseDirection = true });
                for (int read = 0; read < MaximumEvents; read++)
                {
                    using var record = reader.ReadEvent();
                    if (record is null) break;
                    try { if (record.TimeCreated is not null && map(record) is { } crash) result.Add(crash); }
                    catch (Exception error) when (error is not OutOfMemoryException) { }
                }
            }
            catch (EventLogNotFoundException) { }
            catch (Exception error) when (error is not OutOfMemoryException) { if (errors.Count < 4) errors.Add("The " + log + " event log could not be read (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
        }
        Read("System", "*[System[Provider[@Name='Microsoft-Windows-WER-SystemErrorReporting' or @Name='BugCheck'] and EventID=1001 and " + time + "]]", BugCheck);
        Read("Application", "*[System[Provider[@Name='Windows Error Reporting'] and EventID=1001 and " + time + "]]", BlueScreen);
        Read("System", "*[System[Provider[@Name='Microsoft-Windows-Kernel-Power'] and EventID=41 and " + time + "]]", KernelPower);
        Read("System", "*[System[Provider[@Name='EventLog'] and EventID=6008 and " + time + "]]", Shutdown);
        Read("System", "*[System[Provider[@Name='Microsoft-Windows-WHEA-Logger'] and (Level=1 or Level=2) and " + time + "]]", Whea);
        return result;
    }

    private static DateTimeOffset Logged(EventRecord record) => new DateTimeOffset(record.TimeCreated!.Value.ToUniversalTime(), TimeSpan.Zero);
    private static string Property(EventRecord record, int index) => record.Properties.Count > index ? Convert.ToString(record.Properties[index].Value, CultureInfo.InvariantCulture) ?? "" : "";

    // "0x0000003b (0x00000000c0000005, 0xfffff80..., 0x..., 0x...)" and the dump path in the second value.
    private static CrashEventRecord? BugCheck(EventRecord record)
    {
        var match = BugCheckText().Match(Property(record, 0));
        if (!match.Success) return new CrashEventRecord(CrashEventKind.BugCheck, Logged(record), DumpFile: DumpName(Property(record, 1)));
        var parameters = new ulong[4];
        for (int i = 0; i < 4; i++) parameters[i] = ulong.Parse(match.Groups[2 + i].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        return new CrashEventRecord(CrashEventKind.BugCheck, Logged(record), uint.Parse(match.Groups[1].Value[^Math.Min(8, match.Groups[1].Value.Length)..], NumberStyles.HexNumber, CultureInfo.InvariantCulture), parameters, DumpName(Property(record, 1)));
    }

    // Application 1001 of Windows Error Reporting with event name BlueScreen: P1 is the code, P2 to P5 the parameters.
    private static CrashEventRecord? BlueScreen(EventRecord record)
    {
        if (!string.Equals(Property(record, 2), "BlueScreen", StringComparison.OrdinalIgnoreCase)) return null;
        uint? code = uint.TryParse(Property(record, 5).Replace("0x", "", StringComparison.OrdinalIgnoreCase), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out uint value) ? value : null;
        var parameters = new ulong[4]; bool valid = true;
        for (int i = 0; i < 4; i++) valid &= ulong.TryParse(Property(record, 6 + i).Replace("0x", "", StringComparison.OrdinalIgnoreCase), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out parameters[i]);
        string? dump = Enumerable.Range(0, record.Properties.Count).Select(i => DumpName(Property(record, i))).FirstOrDefault(name => name is not null);
        return new CrashEventRecord(CrashEventKind.WerBlueScreen, Logged(record), code, valid ? parameters : null, dump);
    }

    private static CrashEventRecord? KernelPower(EventRecord record)
    {
        uint? code = uint.TryParse(Property(record, 0), NumberStyles.Integer, CultureInfo.InvariantCulture, out uint value) && value != 0 ? value : null;
        ulong[]? parameters = null;
        if (code is not null) { parameters = new ulong[4]; for (int i = 0; i < 4; i++) ulong.TryParse(Property(record, 1 + i), NumberStyles.Integer, CultureInfo.InvariantCulture, out parameters[i]); }
        return new CrashEventRecord(CrashEventKind.KernelPower, Logged(record), code, parameters);
    }

    // 6008 carries the recorded shutdown time as two SYSTEMTIME values (local, then UTC) in its binary data.
    private static CrashEventRecord? Shutdown(EventRecord record)
    {
        DateTimeOffset? recorded = null;
        string? binary = XDocument.Parse(record.ToXml()).Descendants().FirstOrDefault(e => e.Name.LocalName == "Binary")?.Value;
        if (binary is { Length: >= 64 } && binary.All(Uri.IsHexDigit))
        {
            byte[] bytes = Convert.FromHexString(binary[..64]);
            ushort Word(int offset) => BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(16 + offset, 2));
            try { recorded = new DateTimeOffset(Word(0), Word(2), Word(6), Word(8), Word(10), Word(12), Word(14), TimeSpan.Zero); } catch (ArgumentOutOfRangeException) { }
        }
        return new CrashEventRecord(CrashEventKind.UnexpectedShutdown, Logged(record), RecordedShutdown: recorded);
    }

    private static CrashEventRecord? Whea(EventRecord record)
    {
        var data = XDocument.Parse(record.ToXml()).Descendants().Where(e => e.Name.LocalName == "Data").ToDictionary(e => (string?)e.Attribute("Name") ?? "", e => e.Value, StringComparer.OrdinalIgnoreCase);
        string detail = string.Join(", ", new[] { "ErrorSource", "ErrorType" }.Where(data.ContainsKey).Select(name => name + " " + data[name]).Prepend("WHEA " + record.Id.ToString(CultureInfo.InvariantCulture)));
        return new CrashEventRecord(CrashEventKind.Whea, Logged(record), Detail: detail, Error: record.Level is 1 or 2);
    }

    private static string? DumpName(string value)
    {
        var match = DumpPath().Match(value);
        return match.Success ? match.Groups[1].Value : null;
    }

    public IReadOnlyList<MinidumpFile> Minidumps()
    {
        string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Minidump");
        var directory = new DirectoryInfo(folder);
        if (!directory.Exists || directory.Attributes.HasFlag(FileAttributes.ReparsePoint)) return [];
        return directory.EnumerateFiles("*.dmp", new EnumerationOptions { RecurseSubdirectories = false, AttributesToSkip = FileAttributes.ReparsePoint | FileAttributes.Device | FileAttributes.Offline, IgnoreInaccessible = true, MatchCasing = MatchCasing.CaseInsensitive })
            .Where(file => !file.Attributes.HasFlag(FileAttributes.ReparsePoint)).Take(500)
            .Select(file => new MinidumpFile(file.Name, file.Length, new DateTimeOffset(file.LastWriteTimeUtc, TimeSpan.Zero), () => ReadBounded(file.FullName))).ToList();
    }

    // The size cap and the read use the handle that OpenDumpFile checked, so a
    // file swapped after the enumeration is never followed.
    internal static byte[] ReadBounded(string path)
    {
        using var handle = OpenDumpFile(path);
        long length = RandomAccess.GetLength(handle);
        if (length > NativeMinidumpParser.MaximumBytes) throw new InvalidDataException("Dump too large.");
        using var stream = new FileStream(handle, FileAccess.Read, 65536);
        var buffer = new byte[(int)length]; int total = 0;
        while (total < buffer.Length) { int read = stream.Read(buffer, total, buffer.Length - total); if (read == 0) break; total += read; }
        return total == buffer.Length ? buffer : buffer[..total];
    }

    private const uint GenericRead = 0x80000000, ShareRead = 0x1, ShareWrite = 0x2, ShareDelete = 0x4, OpenExisting = 3;
    private const uint OpenReparsePoint = 0x00200000, SequentialScan = 0x08000000, FileTypeDisk = 1;
    private const int FileAttributeTagInfo = 9;
    private const FileAttributes Refused = FileAttributes.ReparsePoint | FileAttributes.Directory | FileAttributes.Device | FileAttributes.Offline;
    [StructLayout(LayoutKind.Sequential)] private struct AttributeTagInfo { public uint Attributes; public uint ReparseTag; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out AttributeTagInfo info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint GetFileType(SafeFileHandle handle);

    /// <summary>
    /// The only way a dump file is opened: never through a junction or symbolic
    /// link (FILE_FLAG_OPEN_REPARSE_POINT opens the link itself), and the opened
    /// handle must be a plain file on disk before any byte is read. A refused or
    /// failed open throws; the caller reports the dump as unreadable.
    /// </summary>
    internal static SafeFileHandle OpenDumpFile(string path)
    {
        var handle = CreateFileW(path, GenericRead, ShareRead | ShareWrite | ShareDelete, IntPtr.Zero, OpenExisting, OpenReparsePoint | SequentialScan, IntPtr.Zero);
        if (handle.IsInvalid) { int code = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(code); }
        try
        {
            // FILE_ATTRIBUTE_TAG_INFO: two DWORDs (attributes, reparse tag), 8 bytes.
            if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, out var info, (uint)Marshal.SizeOf<AttributeTagInfo>())) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (((FileAttributes)info.Attributes & Refused) != 0) throw new InvalidDataException("The dump is not a plain file.");
            if (GetFileType(handle) != FileTypeDisk) throw new InvalidDataException("The dump is not a file on disk.");
            return handle;
        }
        catch { handle.Dispose(); throw; }
    }

    public (string? Version, string? Manufacturer) DriverVersion(string name)
    {
        if (!NativeCrashInventory.PlainDriverName(name)) return (null, null);
        string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "drivers", name);
        if (!File.Exists(path)) return (null, null);
        var info = FileVersionInfo.GetVersionInfo(path);
        return (string.IsNullOrWhiteSpace(info.FileVersion) ? null : info.FileVersion.Trim(), string.IsNullOrWhiteSpace(info.CompanyName) ? null : info.CompanyName.Trim());
    }

    [GeneratedRegex(@"0x([0-9a-fA-F]{1,16})\s*\(\s*0x([0-9a-fA-F]{1,16})\s*,\s*0x([0-9a-fA-F]{1,16})\s*,\s*0x([0-9a-fA-F]{1,16})\s*,\s*0x([0-9a-fA-F]{1,16})\s*\)")] private static partial Regex BugCheckText();
    [GeneratedRegex(@"\\Minidump\\([^\\/:*?""<>|\r\n]{1,200}\.dmp)", RegexOptions.IgnoreCase)] private static partial Regex DumpPath();
}
