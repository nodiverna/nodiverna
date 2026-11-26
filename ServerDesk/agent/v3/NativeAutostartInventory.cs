using System.Buffers.Binary;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace ServerDesk.Agent;

// Programs that start automatically (docs/v3-health-signals.md): the Run and
// RunOnce keys of the machine (64- and 32-bit views) and of signed-in users
// (hives Windows already loaded), the Startup folders, Winlogon Shell and
// Userinit, and, for the "Autostart" read, services with start mode Auto and
// enabled scheduled tasks that are not from Microsoft. Commands are masked with
// SecretMask.CommandLine before the ID, the checksum and the drift output are
// computed; user folders become X:\Users\… and no SID or user name is sent.
// Signatures are checked locally (embedded or system catalog), without
// revocation checks or network retrieval.
internal sealed record RunValue(string Category, string Scope, string Location, string Name, string Command);
internal sealed record StartupFile(string Scope, string Folder, string FileName, Func<byte[]?> Read);
internal sealed record AutoService(string Name, string ImagePath, string? ServiceDll);
internal sealed record ScheduledTaskEntry(string Folder, string Name, IReadOnlyList<(string? Execute, string? Arguments)> Actions);

internal interface IAutostartSource
{
    IEnumerable<RunValue> RunValues();
    IEnumerable<StartupFile> StartupFiles();
    IEnumerable<(string Name, string Value)> Winlogon();
    IEnumerable<AutoService> AutoServices();
    IEnumerable<ScheduledTaskEntry> EnabledTasks();
}

internal interface IFileInspector
{
    string Expand(string text);
    bool Exists(string path);
    /// <summary>valid, invalid, unsigned or unknown (the file cannot be read), and the signer's common name.</summary>
    (string Signature, string? Signer) Signature(string path);
    string? Publisher(string path);
}

internal sealed record AutostartEntry(string Id, string Category, string Scope, string Location, string Name, string Command, string? Target, string Signature, string? Signer, string? Publisher, bool Microsoft, bool UserPath);

internal sealed partial class NativeAutostartInventory(IAutostartSource? source = null, IFileInspector? inspector = null, Func<IEnumerable<string>>? secrets = null)
{
    internal const int IntervalSeconds = 900;
    internal const int DeadlineSeconds = 45;
    internal const int MaximumItems = 2000;
    internal const int MaximumBytes = 900_000;
    // The autostart list travels with the collector result under this key, never in the snapshot.
    internal const string InventoryKey = "_autostartInventory";
    /// <summary>The agent's own secrets (token, keys); the broker sets them once its configuration is read.</summary>
    internal static Func<IEnumerable<string>> KnownSecrets { get; set; } = () => [];
    internal static readonly HashSet<string> MicrosoftSigners = new(["Microsoft Windows", "Microsoft Windows Publisher", "Microsoft Corporation"], StringComparer.Ordinal);
    private readonly IAutostartSource entries = source ?? new WindowsAutostartSource();
    private readonly IFileInspector files = inspector ?? new WindowsFileInspector();
    private readonly Func<IEnumerable<string>> knownSecrets = secrets ?? (() => KnownSecrets());

    /// <summary>The "Autostart" read: every entry, the checksum for the heartbeat and the list for the upload.</summary>
    internal JsonObject Collect()
    {
        var warnings = new JsonArray();
        var all = Entries(includeServicesAndTasks: true, warnings);
        var (items, count, truncated) = Limit(all);
        string checksum = Checksum(items);
        var result = new JsonObject
        {
            ["autostartChecksum"] = checksum,
            [InventoryKey] = new JsonObject { ["checksum"] = checksum, ["count"] = count, ["truncated"] = truncated, ["items"] = new JsonArray(items.Select(Item).ToArray()) }
        };
        if (warnings.Count > 0) result["_collectionWarnings"] = warnings;
        return result;
    }

    /// <summary>The drift category autostart: the Run, RunOnce, Startup folder and Winlogon entries (services and tasks are their own categories).</summary>
    internal JsonArray Drift()
    {
        var warnings = new JsonArray();
        var list = Entries(includeServicesAndTasks: false, warnings);
        if (warnings.Count > 0) throw new InvalidDataException(warnings[0]!.GetValue<string>());
        return new JsonArray(list.Select(Item).ToArray());
    }

    internal List<AutostartEntry> Entries(bool includeServicesAndTasks, JsonArray warnings)
    {
        var known = knownSecrets().Where(secret => !string.IsNullOrEmpty(secret)).ToList();
        var result = new List<AutostartEntry>(); var seen = new HashSet<string>(StringComparer.Ordinal);
        void Add(AutostartEntry? entry) { if (entry is not null && seen.Add(entry.Id)) result.Add(entry); }
        void Read(string what, Action read)
        {
            try { read(); }
            catch (Exception error) when (error is not OutOfMemoryException) { if (warnings.Count < 8) warnings.Add("The autostart entries could not be read completely: " + what + " (" + NativeInventoryDiagnostics.Describe(error) + ")."); }
        }
        Read("Run keys", () => { foreach (var value in entries.RunValues()) Add(Build(value.Category, value.Scope, value.Location, value.Name, value.Command, null, known)); });
        Read("Startup folders", () =>
        {
            foreach (var file in entries.StartupFiles())
            {
                string path = file.Folder.TrimEnd('\\') + "\\" + file.FileName, command = path, target = path;
                if (file.FileName.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase))
                {
                    var link = ShellLink.Parse(file.Read());
                    if (link?.Target is string linked) { target = linked; command = (linked.Contains(' ') ? "\"" + linked + "\"" : linked) + (string.IsNullOrWhiteSpace(link.Arguments) ? "" : " " + link.Arguments.Trim()); }
                    else if (link?.RelativePath is string relative) { target = Path.GetFullPath(Path.Combine(file.Folder, relative)); command = target; }
                    else target = "";
                }
                Add(Build("startup-folder", file.Scope, file.Folder, file.FileName, command, target.Length == 0 ? null : target, known));
            }
        });
        Read("Winlogon", () => { foreach (var (name, value) in entries.Winlogon()) Add(Build("winlogon", "machine", @"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon", name, value, null, known)); });
        if (includeServicesAndTasks)
        {
            Read("services", () =>
            {
                foreach (var service in entries.AutoServices())
                {
                    string? image = ResolveTarget(service.ImagePath);
                    // A shared svchost process says nothing; its ServiceDll is the service's code.
                    string? judged = image is not null && string.Equals(Path.GetFileName(image), "svchost.exe", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(service.ServiceDll) ? files.Expand(service.ServiceDll.Trim().Trim('"')) : image;
                    var entry = Build("service", "machine", @"HKLM\SYSTEM\CurrentControlSet\Services\" + service.Name, service.Name, service.ImagePath, judged ?? "", known);
                    if (entry is not null && !entry.Microsoft) Add(entry);
                }
            });
            Read("scheduled tasks", () =>
            {
                foreach (var task in entries.EnabledTasks())
                {
                    var exec = task.Actions.Where(action => !string.IsNullOrWhiteSpace(action.Execute)).ToList();
                    var first = exec.FirstOrDefault();
                    string command = first.Execute is null ? "" : (first.Execute.Contains(' ') && !first.Execute.StartsWith('"') ? "\"" + first.Execute + "\"" : first.Execute) + (string.IsNullOrWhiteSpace(first.Arguments) ? "" : " " + first.Arguments.Trim());
                    var entry = Build("task", "machine", task.Folder, task.Name, command, first.Execute is null ? "" : ResolveTarget(first.Execute) ?? "", known);
                    if (entry is null) continue;
                    // Microsoft only below \Microsoft\ and with Microsoft executables; other actions there count as Microsoft.
                    bool microsoft = task.Folder.StartsWith(@"\Microsoft\", StringComparison.OrdinalIgnoreCase) && exec.All(action => ResolveTarget(action.Execute!) is string path && IsMicrosoft(files.Signature(path)));
                    if (!microsoft) Add(entry with { Microsoft = false });
                }
            });
        }
        return result;
    }

    /// <summary>One entry: target resolved and judged before scrubbing, command masked, user parts scrubbed, ID over the cleaned values.</summary>
    internal AutostartEntry? Build(string category, string scope, string location, string name, string command, string? target, IReadOnlyCollection<string> known)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        string? resolved = target is null ? ResolveTarget(command) : target.Length == 0 ? null : target;
        bool userPath = resolved is not null && IsUserPath(resolved);
        var (signature, signer) = resolved is null ? ("unknown", (string?)null) : files.Signature(resolved);
        string? publisher = resolved is null || signature == "unknown" ? null : files.Publisher(resolved);
        string cleanLocation = Short(Scrub(location), 1024), cleanName = Short(Scrub(name), 256), cleanCommand = Short(Scrub(SecretMask.CommandLine(command ?? "", known)), 1024);
        string? cleanTarget = resolved is null ? null : Short(Scrub(SecretMask.CommandLine(resolved, known)), 1024);
        if (cleanLocation.Length == 0 || cleanName.Length == 0) return null;
        return new AutostartEntry(Id(category, scope, cleanLocation, cleanName, cleanCommand), category, scope, cleanLocation, cleanName, cleanCommand, cleanTarget, signature,
            signer is null ? null : Short(signer, 256), publisher is null ? null : Short(Scrub(publisher), 256), IsMicrosoft((signature, signer)), userPath);
    }

    internal static bool IsMicrosoft((string Signature, string? Signer) result) => result.Signature == "valid" && result.Signer is not null && MicrosoftSigners.Contains(result.Signer);

    /// <summary>The executable of a command line: a quoted path, or the longest leading run of words that names a file; relative names are looked up in System32 and the Windows folder.</summary>
    internal string? ResolveTarget(string command)
    {
        string text = files.Expand((command ?? "").Trim());
        if (text.StartsWith(@"\??\", StringComparison.Ordinal)) text = text[4..];
        if (text.StartsWith(@"\SystemRoot\", StringComparison.OrdinalIgnoreCase)) text = files.Expand("%SystemRoot%") + text[11..];
        if (text.Length == 0) return null;
        string candidate;
        if (text[0] == '"') { int end = text.IndexOf('"', 1); candidate = end > 0 ? text[1..end] : text[1..]; }
        else
        {
            string[] words = text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            candidate = words[0];
            for (int count = words.Length; count >= 1; count--)
            {
                string joined = string.Join(' ', words.Take(count)).TrimEnd(',');
                if (files.Exists(joined)) { candidate = joined; break; }
                if (!Path.HasExtension(joined) && files.Exists(joined + ".exe")) { candidate = joined + ".exe"; break; }
            }
        }
        candidate = candidate.Trim().TrimEnd(',').Trim();
        if (candidate.Length == 0) return null;
        if (!Path.IsPathRooted(candidate) || !Regex.IsMatch(candidate, @"^(?:[A-Za-z]:\\|\\\\)"))
        {
            string name = Path.HasExtension(candidate) ? candidate : candidate + ".exe";
            foreach (string folder in new[] { files.Expand(@"%SystemRoot%\System32"), files.Expand("%SystemRoot%") })
            {
                string path = folder.TrimEnd('\\') + "\\" + name;
                if (files.Exists(path)) return path;
            }
        }
        return candidate;
    }

    /// <summary>True for a target in a user profile (X:\Users\…) or a temp folder; decided before scrubbing.</summary>
    internal static bool IsUserPath(string path) => UserProfile().IsMatch(path) || TempFolder().IsMatch(path);
    /// <summary>X:\Users\name becomes X:\Users\…; a user SID becomes S-1-5-21-…; HKU\&lt;SID&gt; becomes HKCU.</summary>
    internal static string Scrub(string value)
    {
        string text = UserHive().Replace(value, "HKCU");
        text = NativeSoftwareInventory.Scrub(text);
        return UserSid().Replace(text, "S-1-5-21-…");
    }
    private static string Short(string value, int maximum) => value.Length <= maximum ? value : value[..maximum];

    /// <summary>SHA-256 (lower-case hex) of JSON.stringify([category,scope,location,name,command]), as autostartId in lib/autostart-inventory.ts.</summary>
    internal static string Id(string category, string scope, string location, string name, string command)
    {
        var json = new StringBuilder("[");
        string[] values = [category, scope, location, name, command];
        for (int i = 0; i < values.Length; i++) { if (i > 0) json.Append(','); NativeSoftwareInventory.AppendJson(json, values[i]); }
        json.Append(']');
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json.ToString()))).ToLowerInvariant();
    }

    internal static (List<AutostartEntry> Items, int Count, bool Truncated) Limit(List<AutostartEntry> all)
    {
        var sorted = all.OrderBy(entry => entry.Id, StringComparer.Ordinal).ToList();
        var items = sorted.Take(MaximumItems).ToList();
        int bytes = 2;
        for (int i = 0; i < items.Count; i++)
        {
            bytes += Encoding.UTF8.GetByteCount(Item(items[i]).ToJsonString()) + 1;
            if (bytes > MaximumBytes) { items.RemoveRange(i, items.Count - i); break; }
        }
        return (items, sorted.Count, sorted.Count > items.Count);
    }

    internal static JsonNode Item(AutostartEntry entry) => new JsonObject
    {
        ["id"] = entry.Id, ["category"] = entry.Category, ["scope"] = entry.Scope, ["location"] = entry.Location, ["name"] = entry.Name, ["command"] = entry.Command, ["target"] = entry.Target,
        ["signature"] = entry.Signature, ["signer"] = entry.Signer, ["publisher"] = entry.Publisher, ["microsoft"] = entry.Microsoft, ["userPath"] = entry.UserPath
    };

    /// <summary>
    /// SHA-256 over the canonical JSON that lib/autostart-inventory.ts builds: an array of
    /// [id,category,scope,location,name,command,target,signature,signer,publisher,microsoft,userPath]
    /// arrays, sorted ordinally by id.
    /// </summary>
    internal static string Checksum(IEnumerable<AutostartEntry> items)
    {
        var sorted = items.OrderBy(item => item.Id, StringComparer.Ordinal).ToList();
        var json = new StringBuilder("[");
        for (int i = 0; i < sorted.Count; i++)
        {
            var item = sorted[i];
            if (i > 0) json.Append(',');
            json.Append('[');
            string?[] values = [item.Id, item.Category, item.Scope, item.Location, item.Name, item.Command, item.Target, item.Signature, item.Signer, item.Publisher];
            for (int j = 0; j < values.Length; j++) { if (j > 0) json.Append(','); NativeSoftwareInventory.AppendJson(json, values[j]); }
            json.Append(',').Append(item.Microsoft ? "true" : "false").Append(',').Append(item.UserPath ? "true" : "false").Append(']');
        }
        json.Append(']');
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json.ToString()))).ToLowerInvariant();
    }

    [GeneratedRegex(@"^[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+", RegexOptions.IgnoreCase)] private static partial Regex UserProfile();
    [GeneratedRegex(@"(?:[\\/]AppData[\\/]Local[\\/]Temp[\\/]|^[A-Za-z]:[\\/]Windows[\\/]Temp[\\/]|^[A-Za-z]:[\\/]Temp[\\/])", RegexOptions.IgnoreCase)] private static partial Regex TempFolder();
    [GeneratedRegex(@"^(?:HKU|HKEY_USERS)\\S-1-5-21-[0-9-]+(?=\\|$)", RegexOptions.IgnoreCase)] private static partial Regex UserHive();
    [GeneratedRegex(@"S-1-5-21-[0-9]+(?:-[0-9]+)*", RegexOptions.IgnoreCase)] private static partial Regex UserSid();
}

/// <summary>
/// A bounded reader of Windows shortcuts (MS-SHLLINK): the local target path from
/// the LinkInfo structure, the relative path and the arguments from the string
/// data. A shortcut is untrusted input: every offset and length is checked and
/// the reader never throws; anything unexpected gives null.
/// </summary>
internal static class ShellLink
{
    internal const int MaximumBytes = 65_536;
    internal sealed record Result(string? Target, string? Arguments, string? RelativePath);

    internal static Result? Parse(byte[]? data)
    {
        try { return data is null || data.Length > MaximumBytes ? null : Read(data); }
        catch (Exception error) when (error is ArgumentException or IndexOutOfRangeException or DecoderFallbackException) { return null; }
    }

    private static Result? Read(byte[] data)
    {
        if (data.Length < 76 || BinaryPrimitives.ReadUInt32LittleEndian(data) != 0x4C) return null;
        uint flags = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(20));
        int position = 76;
        if ((flags & 0x1) != 0)
        {
            if (position + 2 > data.Length) return null;
            position += 2 + BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(position));
        }
        string? target = null;
        if ((flags & 0x2) != 0)
        {
            if (position + 28 > data.Length) return null;
            int size = (int)BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(position));
            int headerSize = (int)BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(position + 4));
            uint infoFlags = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(position + 8));
            if (size < 28 || position + size > data.Length || headerSize < 28 || headerSize > size) return null;
            var info = data.AsSpan(position, size);
            if ((infoFlags & 0x1) != 0)
            {
                // The Unicode offsets exist when the header is at least 0x24 bytes; the ANSI path is the fallback.
                string? basePath = null, suffix = null;
                if (headerSize >= 0x24)
                {
                    basePath = Terminated(info, (int)BinaryPrimitives.ReadUInt32LittleEndian(info[28..]), true);
                    suffix = Terminated(info, (int)BinaryPrimitives.ReadUInt32LittleEndian(info[32..]), true);
                }
                if (string.IsNullOrEmpty(basePath))
                {
                    basePath = Terminated(info, (int)BinaryPrimitives.ReadUInt32LittleEndian(info[16..]), false);
                    suffix = Terminated(info, (int)BinaryPrimitives.ReadUInt32LittleEndian(info[24..]), false);
                }
                if (!string.IsNullOrEmpty(basePath)) target = basePath + (suffix ?? "");
            }
            position += size;
        }
        bool wide = (flags & 0x80) != 0;
        string? Next(uint flag)
        {
            if ((flags & flag) == 0) return null;
            if (position + 2 > data.Length) throw new ArgumentException("truncated");
            int count = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(position)); position += 2;
            int bytes = count * (wide ? 2 : 1);
            if (position + bytes > data.Length) throw new ArgumentException("truncated");
            string value = wide ? Encoding.Unicode.GetString(data, position, bytes) : Encoding.Latin1.GetString(data, position, bytes);
            position += bytes;
            return value;
        }
        Next(0x4); string? relative = Next(0x8); Next(0x10); string? arguments = Next(0x20);
        return new Result(target, arguments, string.IsNullOrWhiteSpace(relative) ? null : relative);
    }

    private static string? Terminated(ReadOnlySpan<byte> info, int offset, bool unicode)
    {
        if (offset <= 0 || offset >= info.Length) return null;
        var rest = info[offset..];
        if (unicode)
        {
            for (int i = 0; i + 1 < rest.Length; i += 2) if (rest[i] == 0 && rest[i + 1] == 0) return Encoding.Unicode.GetString(rest[..i]);
            return null;
        }
        int end = rest.IndexOf((byte)0);
        return end < 0 ? null : Encoding.Latin1.GetString(rest[..end]);
    }
}

// Reads the autostart locations. User hives are those Windows already loaded for
// signed-in users; the agent never loads a hive.
internal sealed partial class WindowsAutostartSource : IAutostartSource
{
    private const string RunKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\";

    public IEnumerable<RunValue> RunValues()
    {
        if (!OperatingSystem.IsWindows()) yield break;
        var list = new List<RunValue>();
        foreach (var (view, prefix) in new[] { (RegistryView.Registry64, @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\"), (RegistryView.Registry32, @"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\") })
        {
            using var root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
            foreach (string name in new[] { "Run", "RunOnce" }) Values(root, RunKey + name, prefix + name, name == "Run" ? "run" : "run-once", "machine", list);
        }
        foreach (string sid in UserSids())
            foreach (string name in new[] { "Run", "RunOnce" }) Values(Registry.Users, sid + @"\" + RunKey + name, @"HKU\" + sid + @"\" + RunKey + name, name == "Run" ? "run" : "run-once", "user", list);
        foreach (var value in list) yield return value;
    }

    private static void Values(RegistryKey root, string path, string location, string category, string scope, List<RunValue> list)
    {
        try
        {
            using var key = root.OpenSubKey(path);
            if (key is null) return;
            foreach (string name in key.GetValueNames().Take(500))
                if (key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames) is string command && name.Length > 0) list.Add(new RunValue(category, scope, location, name, command));
        }
        catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException) { }
    }

    private static string[] UserSids()
    {
        try { return Registry.Users.GetSubKeyNames().Where(name => UserSid().IsMatch(name)).Order(StringComparer.Ordinal).Take(200).ToArray(); }
        catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException) { return []; }
    }

    public IEnumerable<StartupFile> StartupFiles()
    {
        if (!OperatingSystem.IsWindows()) yield break;
        var folders = new List<(string Scope, string Folder)> { ("machine", Environment.GetFolderPath(Environment.SpecialFolder.CommonStartup)) };
        foreach (string sid in UserSids())
        {
            try
            {
                using var profile = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + sid);
                if (profile?.GetValue("ProfileImagePath") is string home) folders.Add(("user", Environment.ExpandEnvironmentVariables(home).TrimEnd('\\') + @"\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup"));
            }
            catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException) { }
        }
        var files = new List<StartupFile>();
        foreach (var (scope, folder) in folders)
        {
            if (string.IsNullOrEmpty(folder)) continue;
            var directory = new DirectoryInfo(folder);
            if (!directory.Exists || directory.Attributes.HasFlag(FileAttributes.ReparsePoint)) continue;
            foreach (var file in directory.EnumerateFiles("*", new EnumerationOptions { RecurseSubdirectories = false, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint | FileAttributes.Device | FileAttributes.Offline }).Take(200))
            {
                if (file.Name.Equals("desktop.ini", StringComparison.OrdinalIgnoreCase)) continue;
                string path = file.FullName;
                files.Add(new StartupFile(scope, folder, file.Name, () => ReadBounded(path)));
            }
        }
        foreach (var file in files) yield return file;
    }

    private static byte[]? ReadBounded(string path)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (stream.Length > ShellLink.MaximumBytes) return null;
            var buffer = new byte[(int)stream.Length]; int total = 0;
            while (total < buffer.Length) { int read = stream.Read(buffer, total, buffer.Length - total); if (read == 0) break; total += read; }
            return total == buffer.Length ? buffer : buffer[..total];
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return null; }
    }

    public IEnumerable<(string Name, string Value)> Winlogon()
    {
        if (!OperatingSystem.IsWindows()) yield break;
        using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon");
        foreach (string name in new[] { "Shell", "Userinit" })
            if (key?.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames) is string value && value.Trim().Length > 0) yield return (name, value);
    }

    public IEnumerable<AutoService> AutoServices()
    {
        var result = new List<AutoService>();
        foreach (var row in WindowsManagement.Query(@"root\cimv2", "SELECT Name,PathName FROM Win32_Service WHERE StartMode='Auto'", 5000, TimeSpan.FromSeconds(15)))
        {
            string name = WindowsManagement.Text(row, "Name", 256), path = WindowsManagement.Text(row, "PathName", 2048);
            if (name.Length == 0 || path.Length == 0) continue;
            string? dll = null;
            try { using var parameters = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\" + name + @"\Parameters"); dll = parameters?.GetValue("ServiceDll", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string; }
            catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException) { }
            result.Add(new AutoService(name, path, dll));
        }
        return result;
    }

    public IEnumerable<ScheduledTaskEntry> EnabledTasks()
    {
        var result = new List<ScheduledTaskEntry>();
        Type type = Type.GetTypeFromProgID("Schedule.Service", throwOnError: true)!;
        object serviceObject = Activator.CreateInstance(type)!;
        try
        {
            dynamic service = serviceObject; service.Connect();
            object folder = service.GetFolder("\\");
            try { Visit(folder, result, 0); } finally { Release(folder); }
        }
        finally { Release(serviceObject); }
        return result;
    }

    private static void Visit(object folderObject, List<ScheduledTaskEntry> result, int depth)
    {
        if (depth > 32 || result.Count >= 5000) return;
        dynamic folder = folderObject; object tasksObject = folder.GetTasks(1);
        try
        {
            foreach (object taskObject in (System.Collections.IEnumerable)tasksObject)
            {
                object? definitionObject = null, actionsObject = null;
                try
                {
                    if (result.Count >= 5000) break;
                    dynamic task = taskObject;
                    if (!(bool)task.Enabled) continue;
                    definitionObject = task.Definition; dynamic definition = definitionObject; actionsObject = definition.Actions;
                    var actions = new List<(string?, string?)>();
                    foreach (object actionObject in (System.Collections.IEnumerable)actionsObject)
                    {
                        try { dynamic action = actionObject; actions.Add((int)action.Type == 0 ? ((string)action.Path, (string)action.Arguments) : (null, null)); }
                        finally { Release(actionObject); }
                    }
                    string path = (string)task.Path; int separator = path.LastIndexOf('\\');
                    result.Add(new ScheduledTaskEntry(path[..(separator + 1)], (string)task.Name, actions));
                }
                finally { Release(actionsObject); Release(definitionObject); Release(taskObject); }
            }
        }
        finally { Release(tasksObject); }
        object foldersObject = folder.GetFolders(0);
        try { foreach (object child in (System.Collections.IEnumerable)foldersObject) try { Visit(child, result, depth + 1); } finally { Release(child); } }
        finally { Release(foldersObject); }
    }

    private static void Release(object? value) { if (value is not null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value); }
    [GeneratedRegex(@"^S-1-5-21-[0-9-]+$")] private static partial Regex UserSid();
}

// The local signature check: WinVerifyTrust for the embedded signature, then the
// system catalogs, without revocation checks and without network retrieval.
// The driver read keeps its own cache by file size and time (useCache: false).
internal sealed class WindowsFileInspector(bool useCache = true) : IFileInspector
{
    private readonly Dictionary<string, (string, string?)> cache = new(StringComparer.OrdinalIgnoreCase);
    public string Expand(string text) => Environment.ExpandEnvironmentVariables(text);
    public bool Exists(string path) { try { return File.Exists(path); } catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException) { return false; } }
    public string? Publisher(string path)
    {
        try { string? company = System.Diagnostics.FileVersionInfo.GetVersionInfo(path).CompanyName?.Trim(); return string.IsNullOrEmpty(company) ? null : company; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException) { return null; }
    }

    public (string Signature, string? Signer) Signature(string path)
    {
        if (!useCache) return Check(path);
        if (cache.TryGetValue(path, out var known)) return known;
        var result = Check(path);
        if (cache.Count < 4000) cache[path] = result;
        return result;
    }

    private static (string, string?) Check(string path)
    {
        if (!OperatingSystem.IsWindows()) return ("unknown", null);
        FileStream stream;
        try { stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return ("unknown", null); }
        using (stream)
        {
            int embedded = VerifyFile(path, stream.SafeFileHandle.DangerousGetHandle());
            if (embedded == 0) return ("valid", SignerName(path));
            if (embedded is not (unchecked((int)0x800B0100) or unchecked((int)0x800B0003) or unchecked((int)0x800B0001))) return ("invalid", SignerName(path));
            foreach (string? algorithm in new[] { "SHA256", null })
            {
                var catalog = VerifyCatalog(path, stream, algorithm);
                if (catalog is not null) return catalog.Value.Valid ? ("valid", SignerName(catalog.Value.Catalog)) : ("invalid", null);
            }
            return ("unsigned", null);
        }
    }

    private static string? SignerName(string path)
    {
        try
        {
#pragma warning disable SYSLIB0057 // The signer of a signed file; X509CertificateLoader does not read Authenticode signatures.
            using var signer = X509Certificate.CreateFromSignedFile(path);
            using var certificate = new X509Certificate2(signer);
#pragma warning restore SYSLIB0057
            string name = certificate.GetNameInfo(X509NameType.SimpleName, false);
            return string.IsNullOrWhiteSpace(name) ? null : name.Trim();
        }
        catch (Exception error) when (error is CryptographicException or IOException or UnauthorizedAccessException or ArgumentException) { return null; }
    }

    private static int VerifyFile(string path, IntPtr handle)
    {
        var file = new WintrustFileInfo { cbStruct = (uint)Marshal.SizeOf<WintrustFileInfo>(), pcwszFilePath = path, hFile = handle };
        IntPtr info = Marshal.AllocHGlobal(Marshal.SizeOf<WintrustFileInfo>());
        try { Marshal.StructureToPtr(file, info, false); return Verify(1, info); }
        finally { Marshal.DestroyStructure<WintrustFileInfo>(info); Marshal.FreeHGlobal(info); }
    }

    private static (bool Valid, string Catalog)? VerifyCatalog(string path, FileStream stream, string? algorithm)
    {
        if (!CryptCATAdminAcquireContext2(out IntPtr admin, IntPtr.Zero, algorithm, IntPtr.Zero, 0)) return null;
        IntPtr catalogContext = IntPtr.Zero;
        try
        {
            stream.Position = 0;
            uint size = 0;
            CryptCATAdminCalcHashFromFileHandle2(admin, stream.SafeFileHandle.DangerousGetHandle(), ref size, null, 0);
            if (size == 0 || size > 64) return null;
            var hash = new byte[size];
            stream.Position = 0;
            if (!CryptCATAdminCalcHashFromFileHandle2(admin, stream.SafeFileHandle.DangerousGetHandle(), ref size, hash, 0)) return null;
            IntPtr previous = IntPtr.Zero;
            catalogContext = CryptCATAdminEnumCatalogFromHash(admin, hash, size, 0, ref previous);
            if (catalogContext == IntPtr.Zero) return null;
            var catalog = new CatalogInfo { cbStruct = (uint)Marshal.SizeOf<CatalogInfo>() };
            if (!CryptCATCatalogInfoFromContext(catalogContext, ref catalog, 0)) return null;
            var member = new WintrustCatalogInfo
            {
                cbStruct = (uint)Marshal.SizeOf<WintrustCatalogInfo>(), pcwszCatalogFilePath = catalog.wszCatalogFile, pcwszMemberTag = Convert.ToHexString(hash), pcwszMemberFilePath = path,
                hMemberFile = stream.SafeFileHandle.DangerousGetHandle(), hCatAdmin = admin
            };
            IntPtr hashBuffer = Marshal.AllocHGlobal(hash.Length), info = Marshal.AllocHGlobal(Marshal.SizeOf<WintrustCatalogInfo>());
            try
            {
                Marshal.Copy(hash, 0, hashBuffer, hash.Length);
                member.pbCalculatedFileHash = hashBuffer; member.cbCalculatedFileHash = (uint)hash.Length;
                Marshal.StructureToPtr(member, info, false);
                return (Verify(2, info) == 0, catalog.wszCatalogFile);
            }
            finally { Marshal.DestroyStructure<WintrustCatalogInfo>(info); Marshal.FreeHGlobal(info); Marshal.FreeHGlobal(hashBuffer); }
        }
        finally
        {
            if (catalogContext != IntPtr.Zero) CryptCATAdminReleaseCatalogContext(admin, catalogContext, 0);
            CryptCATAdminReleaseContext(admin, 0);
        }
    }

    private static int Verify(uint choice, IntPtr info)
    {
        Guid action = new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        // UI none, revocation none, verify then close, cache-only URL retrieval, no revocation check.
        var data = new WintrustData { cbStruct = (uint)Marshal.SizeOf<WintrustData>(), dwUIChoice = 2, fdwRevocationChecks = 0, dwUnionChoice = choice, pInfo = info, dwStateAction = 1, dwProvFlags = 0x1000 | 0x10 | 0x2000 };
        int result = WinVerifyTrust(new IntPtr(-1), ref action, ref data);
        data.dwStateAction = 2;
        WinVerifyTrust(new IntPtr(-1), ref action, ref data);
        return result;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct WintrustFileInfo { public uint cbStruct; public string pcwszFilePath; public IntPtr hFile; public IntPtr pgKnownSubject; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct WintrustCatalogInfo { public uint cbStruct; public uint dwCatalogVersion; public string pcwszCatalogFilePath; public string pcwszMemberTag; public string pcwszMemberFilePath; public IntPtr hMemberFile; public IntPtr pbCalculatedFileHash; public uint cbCalculatedFileHash; public IntPtr pcCatalogContext; public IntPtr hCatAdmin; }
    [StructLayout(LayoutKind.Sequential)] private struct WintrustData { public uint cbStruct; public IntPtr pPolicyCallbackData; public IntPtr pSIPClientData; public uint dwUIChoice; public uint fdwRevocationChecks; public uint dwUnionChoice; public IntPtr pInfo; public uint dwStateAction; public IntPtr hWVTStateData; public IntPtr pwszURLReference; public uint dwProvFlags; public uint dwUIContext; public IntPtr pSignatureSettings; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct CatalogInfo { public uint cbStruct; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string wszCatalogFile; }
    [DllImport("wintrust.dll", CharSet = CharSet.Unicode)] private static extern int WinVerifyTrust(IntPtr hwnd, ref Guid action, ref WintrustData data);
    [DllImport("wintrust.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool CryptCATAdminAcquireContext2(out IntPtr admin, IntPtr subsystem, string? hashAlgorithm, IntPtr strongHashPolicy, uint flags);
    [DllImport("wintrust.dll", SetLastError = true)] private static extern bool CryptCATAdminCalcHashFromFileHandle2(IntPtr admin, IntPtr file, ref uint hashSize, byte[]? hash, uint flags);
    [DllImport("wintrust.dll", SetLastError = true)] private static extern IntPtr CryptCATAdminEnumCatalogFromHash(IntPtr admin, byte[] hash, uint hashSize, uint flags, ref IntPtr previous);
    [DllImport("wintrust.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool CryptCATCatalogInfoFromContext(IntPtr catalog, ref CatalogInfo info, uint flags);
    [DllImport("wintrust.dll")] private static extern bool CryptCATAdminReleaseCatalogContext(IntPtr admin, IntPtr catalog, uint flags);
    [DllImport("wintrust.dll")] private static extern bool CryptCATAdminReleaseContext(IntPtr admin, uint flags);
}
