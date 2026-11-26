using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// Guided file actions use held directory/object handles rather than unvalidated
// PowerShell strings. No recursion, links or alternate streams are accepted.
internal static class FileBrowser
{
    internal static readonly string[] Actions = ["list-files", "create-directory", "rename-file", "delete-file"];
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, IntPtr data, uint size);
    [StructLayout(LayoutKind.Sequential)] private struct FileInfo { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Modified; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    private static bool Same(string a, string b) => string.Equals(a.TrimEnd('\\'), b.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    private static bool SecurityFile(string path) => System.Text.RegularExpressions.Regex.IsMatch(path, @"\\(?:Security\.evtx|security-(?:events|support)-[^\\]+)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    private static bool Name(string value) => value.Length is > 0 and <= 255 && value.IndexOfAny(['\\', '/', ':', '*', '?', '<', '>', '"', '|']) < 0 && !value.Any(char.IsControl) && !value.EndsWith('.') && !value.EndsWith(' ') && value is not "." and not ".." && !System.Text.RegularExpressions.Regex.IsMatch(value, @"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)|^(?:ServerDesk|ServerDeskAgent)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    private static string Validate(string value, string root, bool rootAllowed = false)
    {
        if (rootAllowed && value.Length == 3 && char.IsAsciiLetter(value[0]) && value[1..] == ":\\") return Path.GetFullPath(value);
        if (value.Length > 240 || value.Contains('/') || value.Split('\\').Skip(1).Any(component => component is "." or ".." || component.EndsWith('.') || component.EndsWith(' '))) throw new AgentMessageException("AGENT_FILE_INVALID_PATH");
        if (value.Split('\\').Skip(1).Any(component => component.Length > 0 && !Name(component))) throw new AgentMessageException("AGENT_FILE_PATH_PROTECTED");
        return PathPolicy.Validate(value, root, false);
    }
    private static SafeFileHandle Open(string path, bool delete = false)
    {
        var handle = CreateFileW(path, delete ? 0x10080u : 0x80u, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero); // attributes[/DELETE], READ|WRITE sharing, OPEN_REPARSE_POINT|BACKUP_SEMANTICS; no share-delete.
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            if (!GetFileInformationByHandle(handle, out var info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((info.Attributes & (uint)FileAttributes.ReparsePoint) != 0) throw new AgentMessageException("AGENT_FILE_REPARSE_POINT");
            if ((info.Attributes & (uint)FileAttributes.Directory) == 0) PathPolicy.NoHardLinks(handle);
            if (!Same(PathPolicy.FinalPath(handle), path)) throw new AgentMessageException("AGENT_FILE_PATH_MISMATCH");
            return handle;
        }
        catch { handle.Dispose(); throw; }
    }
    private static List<SafeFileHandle> LockDirectories(string directory, string root)
    {
        var handles = new List<SafeFileHandle>();
        try
        {
            string drive = Path.GetPathRoot(directory)!, current = drive;
            handles.Add(Open(drive));
            foreach (string component in directory[drive.Length..].Split('\\', StringSplitOptions.RemoveEmptyEntries))
            {
                current = Path.Combine(current, component); Validate(current, root); handles.Add(Open(current));
            }
            return handles;
        }
        catch { foreach (var handle in handles) handle.Dispose(); throw; }
    }
    // Returns the data of the result and its coded message.
    internal static Task<(JsonObject Data, AgentMessage Message)> ExecuteAsync(string root, string action, JsonObject parameters, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (!Actions.Contains(action)) throw new AgentMessageException("AGENT_FILE_UNKNOWN_ACTION");
        if (action != "list-files" && LocalStore.ReadProtected(Path.Combine(root, "config.bin"))["mode"]?.GetValue<string>() != "Management") throw new AgentMessageException("AGENT_FILE_MANAGEMENT_REQUIRED");
        if (action == "list-files" && parameters["path"] is null)
        {
            var drives = new JsonArray();
            foreach (DriveInfo drive in DriveInfo.GetDrives().Where(d => d.DriveType is DriveType.Fixed or DriveType.Removable or DriveType.CDRom).OrderBy(d => d.Name))
            {
                token.ThrowIfCancellationRequested();
                var row = new JsonObject { ["name"] = drive.Name, ["kind"] = drive.DriveType.ToString(), ["ready"] = drive.IsReady };
                if (drive.IsReady) { try { row["label"] = drive.VolumeLabel; row["totalBytes"] = drive.TotalSize; row["freeBytes"] = drive.AvailableFreeSpace; } catch { } }
                drives.Add(row);
            }
            return Done(new JsonObject { ["path"] = null, ["drives"] = drives, ["entries"] = new JsonArray(), ["total"] = drives.Count, ["offset"] = 0, ["hasMore"] = false }, "AGENT_FILE_OPERATION_COMPLETED");
        }
        string path = Validate(parameters["path"]?.GetValue<string>() ?? "", root, action == "list-files");
        if (action != "list-files" && (path.Length <= 3 || Path.GetFullPath(root).StartsWith(path.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))) throw new AgentMessageException("AGENT_FILE_ROOT_PROTECTED");
        string directory = action == "list-files" ? path : Path.GetDirectoryName(path)!;
        var locks = LockDirectories(directory, root);
        try
        {
            token.ThrowIfCancellationRequested();
            if (action == "list-files")
            {
                if (!Directory.Exists(path)) throw new AgentMessageException("AGENT_FILE_FOLDER_NOT_FOUND");
                int offset = Math.Clamp(parameters["offset"]?.GetValue<int>() ?? 0, 0, 19800), limit = Math.Clamp(parameters["limit"]?.GetValue<int>() ?? 200, 1, 200);
                bool security = parameters["includeSecurity"]?.GetValue<bool>() == true;
                // Bound enumeration and result size so a very large directory cannot
                // monopolize the agent or overflow the encrypted channel envelope.
                string[] names = Directory.EnumerateFileSystemEntries(path).Where(p => security || !SecurityFile(p)).Take(20001).ToArray();
                bool truncated = names.Length > 20000; if (truncated) names = names[..20000];
                Array.Sort(names, StringComparer.OrdinalIgnoreCase);
                var entries = new JsonArray();
                foreach (string item in names.Skip(offset).Take(limit))
                {
                    token.ThrowIfCancellationRequested();
                    try
                    {
                        var attributes = File.GetAttributes(item); bool folder = (attributes & FileAttributes.Directory) != 0;
                        bool blocked = (attributes & FileAttributes.ReparsePoint) != 0 || !Name(Path.GetFileName(item)) || item.Length > 240;
                        var entry = new JsonObject { ["name"] = Path.GetFileName(item), ["path"] = item, ["kind"] = folder ? "directory" : "file", ["attributes"] = attributes.ToString(), ["blocked"] = blocked };
                        if (!blocked) { entry["modifiedAt"] = File.GetLastWriteTimeUtc(item).ToString("O"); if (!folder) entry["size"] = new System.IO.FileInfo(item).Length; }
                        entries.Add(entry);
                    }
                    catch (Exception error) when (error is IOException or UnauthorizedAccessException) { entries.Add(new JsonObject { ["name"] = Path.GetFileName(item), ["path"] = item, ["kind"] = "file", ["blocked"] = true, ["attributes"] = "Not accessible" }); }
                }
                return Done(new JsonObject { ["path"] = path, ["drives"] = new JsonArray(), ["entries"] = entries, ["total"] = names.Length, ["offset"] = offset, ["hasMore"] = offset + limit < names.Length, ["truncated"] = truncated, ["listedAt"] = DateTimeOffset.UtcNow.ToString("O") }, "AGENT_FILE_OPERATION_COMPLETED");
            }
            if (action == "create-directory")
            {
                if (File.Exists(path) || Directory.Exists(path)) throw new AgentMessageException("AGENT_FILE_ENTRY_EXISTS");
                Directory.CreateDirectory(path); return Done(new JsonObject { ["path"] = path }, "AGENT_FILE_FOLDER_CREATED");
            }
            using var itemHandle = Open(path, true);
            if (!GetFileInformationByHandle(itemHandle, out var currentInfo)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((currentInfo.Attributes & (uint)FileAttributes.Directory) == 0) PathPolicy.NoHardLinks(itemHandle);
            if (action == "rename-file")
            {
                string name = parameters["name"]?.GetValue<string>() ?? ""; if (!Name(name)) throw new AgentMessageException("AGENT_FILE_INVALID_NAME");
                string target = Validate(Path.Combine(directory, name), root);
                if (!Same(path, target) && (File.Exists(target) || Directory.Exists(target))) throw new AgentMessageException("AGENT_FILE_TARGET_EXISTS");
                byte[] bytes = Encoding.Unicode.GetBytes(target); IntPtr info = Marshal.AllocHGlobal(22 + bytes.Length);
                try { Marshal.Copy(new byte[22 + bytes.Length], 0, info, 22 + bytes.Length); Marshal.WriteIntPtr(info, 8, IntPtr.Zero); Marshal.WriteInt32(info, 16, bytes.Length); Marshal.Copy(bytes, 0, info + 20, bytes.Length); if (!SetFileInformationByHandle(itemHandle, 3, info, (uint)(20 + bytes.Length))) throw new Win32Exception(Marshal.GetLastWin32Error()); }
                finally { Marshal.FreeHGlobal(info); }
                return Done(new JsonObject { ["path"] = target }, "AGENT_FILE_ENTRY_RENAMED");
            }
            IntPtr disposition = Marshal.AllocHGlobal(4);
            try { Marshal.WriteInt32(disposition, 1); if (!SetFileInformationByHandle(itemHandle, 4, disposition, 4)) throw new AgentMessageException(new Win32Exception(Marshal.GetLastWin32Error()), "AGENT_FILE_DELETE_FAILED"); }
            finally { Marshal.FreeHGlobal(disposition); }
            return Done(new JsonObject { ["path"] = path }, "AGENT_FILE_ENTRY_DELETED");
        }
        finally { foreach (var handle in locks) handle.Dispose(); }
    }
    private static Task<(JsonObject Data, AgentMessage Message)> Done(JsonObject data, string code) => Task.FromResult((data, AgentMessages.Of(code)));
}
