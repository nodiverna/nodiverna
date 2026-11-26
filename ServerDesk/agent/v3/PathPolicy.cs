using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Text;

namespace ServerDesk.Agent;

internal static class PathPolicy
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [StructLayout(LayoutKind.Sequential)] private struct FileInfo { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Modified; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, IntPtr data, uint size);
    internal static SafeFileHandle OpenStaging(string path, bool resume)
    {
        var handle = CreateFileW(path, 0xC0010000, 0, IntPtr.Zero, resume ? 3u : 1u, 0x40000080, IntPtr.Zero); // READ|WRITE|DELETE, exclusive, overlapped I/O.
        if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); return handle;
    }
    internal static void RenameOpenFile(SafeFileHandle handle, string target, bool overwrite)
    {
        NoHardLinks(handle); byte[] name = Encoding.Unicode.GetBytes(target); IntPtr info = Marshal.AllocHGlobal(20 + name.Length + 2);
        try { Marshal.Copy(new byte[20 + name.Length + 2], 0, info, 20 + name.Length + 2); Marshal.WriteInt32(info, 0, overwrite ? 1 : 0); Marshal.WriteIntPtr(info, 8, IntPtr.Zero); Marshal.WriteInt32(info, 16, name.Length); Marshal.Copy(name, 0, info + 20, name.Length); if (!SetFileInformationByHandle(handle, 3, info, (uint)(20 + name.Length + 2))) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Atomic target commit failed"); }
        finally { Marshal.FreeHGlobal(info); }
    }
    internal static string NoHardLinks(SafeFileHandle handle)
    {
        if (!GetFileInformationByHandle(handle, out var info)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        if (info.Links != 1 || (info.Attributes & (uint)FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("Guided transfers and drift do not read or write hardlinked files or reparse points.");
        return info.Volume.ToString("x8") + ":" + info.IndexHigh.ToString("x8") + info.IndexLow.ToString("x8");
    }
    internal static string Validate(string value, string root, bool writing)
    {
        if (value.Length is < 4 or > 1024 || !Path.IsPathFullyQualified(value) || !char.IsAsciiLetter(value[0]) || value[1] != ':' || value[2] != '\\' || value[2..].Contains(':') || value.Contains('\0') || value.Contains('*') || value.Contains('?')) throw new InvalidDataException("Only absolute local drive paths without alternate streams are allowed.");
        string path = Path.GetFullPath(value), agent = Path.GetFullPath(root).TrimEnd('\\') + "\\";
        if (path.StartsWith(agent, StringComparison.OrdinalIgnoreCase) || string.Equals(path.TrimEnd('\\'), agent.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("Agent configuration, keys, and working files are protected.");
        string? current = writing ? Path.GetDirectoryName(path) : path;
        if (current is null || (writing && !Directory.Exists(current))) throw new DirectoryNotFoundException("The target directory must already exist.");
        for (string? part = current; part is not null; part = Path.GetDirectoryName(part.TrimEnd('\\')))
        {
            if (File.Exists(part) || Directory.Exists(part)) if ((File.GetAttributes(part) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("File transfers through junctions, symlinks, or reparse points are blocked.");
            if (part.Length <= 3) break;
        }
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("The destination is a reparse point.");
        return path;
    }
    internal static SafeFileHandle LockParent(string path)
    {
        var handle = CreateFileW(Path.GetDirectoryName(path)!, 0, 3, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero); // No FILE_SHARE_DELETE, protecting the parent from replacement during commit.
        if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); return handle;
    }
    internal static string FinalPath(SafeFileHandle handle)
    {
        var text = new StringBuilder(32768); uint count = GetFinalPathNameByHandleW(handle, text, (uint)text.Capacity, 0);
        if (count == 0 || count >= text.Capacity) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        string value = text.ToString(); return value.StartsWith("\\\\?\\", StringComparison.Ordinal) ? value[4..] : value;
    }
}
