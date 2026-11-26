using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace ServerDesk.Agent;

// Handle-based file operations for the uninstall staging folder in the
// world-writable %SystemRoot%\Temp. Every check and every delete works on a
// handle opened with FILE_FLAG_OPEN_REPARSE_POINT and without write or delete
// sharing. A junction or symbolic link is inspected as itself and never
// followed, and the entry that was checked is the entry that is deleted. A
// folder that is open here cannot be renamed or replaced, so the paths below it
// stay the same objects while the broker works on them.
internal static class StagingFiles
{
    private const uint FileListDirectory = 0x1, FileReadAttributes = 0x80, Delete = 0x10000, ReadControl = 0x20000, GenericRead = 0x80000000;
    private const uint ShareRead = 0x1, ShareWrite = 0x2, OpenExisting = 3, BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;
    private const uint AttributeDirectory = 0x10, AttributeReparsePoint = 0x400;
    private const int ErrorFileNotFound = 2, ErrorPathNotFound = 3, ErrorAlreadyExists = 183;
    private const int FileBasicInfo = 0, FileDispositionInfo = 4, FileDispositionInfoEx = 21;
    // FILE_DISPOSITION_FLAG_DELETE | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE.
    private const uint DispositionFlags = 0x1 | 0x2 | 0x10;
    private static readonly EnumerationOptions AllEntries = new() { AttributesToSkip = 0, RecurseSubdirectories = false, IgnoreInaccessible = false, ReturnSpecialDirectories = false };

    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicInfo { public long CreationTime, LastAccessTime, LastWriteTime, ChangeTime; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct DispositionEx { public uint Flags; }
    [StructLayout(LayoutKind.Sequential)] private struct Disposition { public byte Delete; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateDirectoryW(string path, ref SecurityAttributes security);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out BasicInfo info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref DispositionEx info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref Disposition info, uint size);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);

    private static readonly SecurityIdentifier Administrators = new(WellKnownSidType.BuiltinAdministratorsSid, null), LocalSystem = new(WellKnownSidType.LocalSystemSid, null);
    private static bool Trusted(SecurityIdentifier? sid) => sid is not null && (sid.Equals(Administrators) || sid.Equals(LocalSystem));

    /// <summary>
    /// Creates the folder in one step that fails when the name already exists, as
    /// a folder or as a file (CreateDirectoryW, ERROR_ALREADY_EXISTS). In secure
    /// mode it gets its protected descriptor at creation: owner Administrators,
    /// full control for SYSTEM and Administrators only. Otherwise it inherits.
    /// </summary>
    internal static void CreateNew(string path, bool secure)
    {
        byte[]? descriptor = null;
        if (secure)
        {
            var security = new DirectorySecurity(); security.SetAccessRuleProtection(true, false); security.SetOwner(Administrators);
            foreach (var sid in new[] { Administrators, LocalSystem }) security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            descriptor = security.GetSecurityDescriptorBinaryForm();
        }
        var pinned = descriptor is null ? default : GCHandle.Alloc(descriptor, GCHandleType.Pinned);
        try
        {
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = pinned.IsAllocated ? pinned.AddrOfPinnedObject() : IntPtr.Zero };
            if (CreateDirectoryW(path, ref attributes)) return;
            int error = Marshal.GetLastWin32Error();
            if (error == ErrorAlreadyExists) throw new IOException("The staging folder already exists.");
            throw new Win32Exception(error, "The staging folder could not be created: " + new Win32Exception(error).Message);
        }
        finally { if (pinned.IsAllocated) pinned.Free(); }
    }

    /// <summary>
    /// Checks a folder that CreateNew just made, through a handle that does not
    /// follow reparse points: a real folder, and in secure mode owned by
    /// Administrators or SYSTEM with a protected DACL for those two only.
    /// </summary>
    internal static void VerifyNew(string path, bool secure)
    {
        using var handle = Open(path, FileReadAttributes | ReadControl, ShareRead, out int error) ?? throw new Win32Exception(error, "The staging folder could not be opened: " + new Win32Exception(error).Message);
        uint attributes = Attributes(handle);
        if ((attributes & AttributeReparsePoint) != 0 || (attributes & AttributeDirectory) == 0) throw new UnauthorizedAccessException("The staging folder is a junction, a symbolic link or not a folder.");
        if (!secure) return;
        var descriptor = Security(handle);
        if (!Trusted(descriptor.Owner)) throw new UnauthorizedAccessException("The staging folder is not owned by SYSTEM or Administrators.");
        if (!AdministratorsOnly(descriptor)) throw new UnauthorizedAccessException("The staging folder grants access to accounts other than SYSTEM and Administrators.");
    }

    /// <summary>The DACL is protected and every entry names SYSTEM or Administrators.</summary>
    internal static bool AdministratorsOnly(RawSecurityDescriptor descriptor) =>
        (descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 && descriptor.DiscretionaryAcl is { Count: > 0 } acl && acl.Cast<GenericAce>().All(ace => ace is KnownAce known && Trusted(known.SecurityIdentifier));

    /// <summary>The owner and DACL of a path, read through a handle that does not follow reparse points.</summary>
    internal static RawSecurityDescriptor SecurityOf(string path)
    {
        using var handle = Open(path, FileReadAttributes | ReadControl, ShareRead | ShareWrite, out int error) ?? throw new Win32Exception(error);
        return Security(handle);
    }

    /// <summary>
    /// Opens the staged EXE for reading with read sharing only, so no other writer
    /// can change, replace or delete it while the returned object is alive. The
    /// folder stays open without delete sharing as well, so it cannot be renamed
    /// or swapped for a link. Throws when the folder or the EXE is a reparse point.
    /// </summary>
    internal static PinnedFile Pin(string folder, string file)
    {
        var folderHandle = Open(folder, FileReadAttributes, ShareRead | ShareWrite, out int error) ?? throw new Win32Exception(error, "The staging folder could not be opened: " + new Win32Exception(error).Message);
        try
        {
            uint attributes = Attributes(folderHandle);
            if ((attributes & AttributeReparsePoint) != 0 || (attributes & AttributeDirectory) == 0) throw new UnauthorizedAccessException("The staging folder is now a junction, a symbolic link or not a folder.");
            var fileHandle = CreateFileW(file, GenericRead | FileReadAttributes, ShareRead, IntPtr.Zero, OpenExisting, OpenReparsePoint, IntPtr.Zero);
            if (fileHandle.IsInvalid) { int failure = Marshal.GetLastWin32Error(); fileHandle.Dispose(); throw new Win32Exception(failure, "The staged EXE could not be opened: " + new Win32Exception(failure).Message); }
            try
            {
                uint fileAttributes = Attributes(fileHandle);
                if ((fileAttributes & (AttributeReparsePoint | AttributeDirectory)) != 0) throw new UnauthorizedAccessException("The staged EXE is now a reparse point or a folder.");
                return new PinnedFile(folderHandle, new FileStream(fileHandle, FileAccess.Read, 1));
            }
            catch { fileHandle.Dispose(); throw; }
        }
        catch { folderHandle.Dispose(); throw; }
    }

    internal sealed class PinnedFile(SafeFileHandle folder, FileStream stream) : IDisposable
    {
        internal FileStream Stream { get; } = stream;
        public void Dispose() { Stream.Dispose(); folder.Dispose(); }
    }

    /// <summary>
    /// Deletes a staging folder and its content through handles. A folder that is
    /// a junction or symbolic link is not deleted and not followed; in secure mode
    /// a folder whose owner is not SYSTEM or Administrators is kept as well. A
    /// link inside is removed as a link, never followed. When `keepMarker` names an
    /// entry that exists in the folder, the folder is kept. Each case that keeps
    /// something is logged. True when the folder is gone.
    /// </summary>
    internal static bool DeleteFolder(string folder, bool requireTrustedOwner, Action<string> log, string? keepMarker = null)
    {
        using var handle = Open(folder, Delete | FileReadAttributes | ReadControl | FileListDirectory, ShareRead, out int error);
        if (handle is null)
        {
            if (error is ErrorFileNotFound or ErrorPathNotFound) return true;
            log("The uninstall staging folder " + folder + " could not be opened for deletion: " + new Win32Exception(error).Message);
            return false;
        }
        uint attributes = Attributes(handle);
        if ((attributes & AttributeReparsePoint) != 0) { log("The uninstall staging folder " + folder + " is a junction or symbolic link. It was not deleted and not followed."); return false; }
        if ((attributes & AttributeDirectory) == 0) { log("The uninstall staging entry " + folder + " is not a folder. It was not deleted."); return false; }
        if (requireTrustedOwner && !Trusted(Security(handle).Owner)) { log("The uninstall staging folder " + folder + " is not owned by SYSTEM or Administrators. It was not deleted."); return false; }
        if (keepMarker is not null) { string marker = Path.Combine(folder, keepMarker); if (File.Exists(marker) || Directory.Exists(marker)) return false; }
        if (!DeleteChildren(folder, log)) { log("The uninstall staging folder " + folder + " was kept because an entry in it could not be deleted."); return false; }
        try { MarkForDeletion(handle); return true; }
        catch (Exception e) { log("The uninstall staging folder " + folder + " could not be deleted: " + e.Message); return false; }
    }

    // The children of a folder that is open without delete sharing. Each entry is
    // opened as itself; its handle checks and deletes it. True when all are gone.
    private static bool DeleteChildren(string folder, Action<string> log)
    {
        bool all = true;
        IEnumerable<string> entries;
        try { entries = Directory.EnumerateFileSystemEntries(folder, "*", AllEntries).ToArray(); }
        catch (Exception e) { log("The uninstall staging folder " + folder + " could not be listed: " + e.Message); return false; }
        foreach (string entry in entries)
        {
            try
            {
                using var handle = Open(entry, Delete | FileReadAttributes | FileListDirectory, ShareRead, out int error);
                if (handle is null)
                {
                    if (error is ErrorFileNotFound or ErrorPathNotFound) continue;
                    log("The uninstall staging entry " + entry + " could not be opened for deletion: " + new Win32Exception(error).Message); all = false; continue;
                }
                uint attributes = Attributes(handle);
                if ((attributes & AttributeReparsePoint) != 0) log("The uninstall staging entry " + entry + " is a junction or symbolic link. Only the link is removed; its target is not followed.");
                else if ((attributes & AttributeDirectory) != 0 && !DeleteChildren(entry, log)) { all = false; continue; }
                MarkForDeletion(handle);
            }
            catch (Exception e) { log("The uninstall staging entry " + entry + " could not be deleted: " + e.Message); all = false; }
        }
        return all;
    }

    private static SafeFileHandle? Open(string path, uint access, uint share, out int error)
    {
        var handle = CreateFileW(path, access, share, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
        if (!handle.IsInvalid) { error = 0; return handle; }
        error = Marshal.GetLastWin32Error(); handle.Dispose(); return null;
    }

    private static uint Attributes(SafeFileHandle handle)
    {
        if (!GetFileInformationByHandleEx(handle, FileBasicInfo, out var info, (uint)Marshal.SizeOf<BasicInfo>())) throw new Win32Exception(Marshal.GetLastWin32Error());
        return info.Attributes;
    }

    private static RawSecurityDescriptor Security(SafeFileHandle handle)
    {
        // SE_FILE_OBJECT; OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION.
        uint status = GetSecurityInfo(handle, 1, 0x1 | 0x4, out _, out _, out _, out _, out IntPtr descriptor);
        if (status != 0) throw new Win32Exception((int)status);
        try
        {
            byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            return new RawSecurityDescriptor(bytes, 0);
        }
        finally { LocalFree(descriptor); }
    }

    // The entry goes when this handle closes. POSIX semantics remove the name at
    // once, so the parent folder is empty for its own delete. Older file systems
    // without the extended class get the classic disposition.
    private static void MarkForDeletion(SafeFileHandle handle)
    {
        var extended = new DispositionEx { Flags = DispositionFlags };
        if (SetFileInformationByHandle(handle, FileDispositionInfoEx, ref extended, (uint)Marshal.SizeOf<DispositionEx>())) return;
        int error = Marshal.GetLastWin32Error();
        // ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED, ERROR_INVALID_PARAMETER: the class is unknown here.
        if (error is not (1 or 50 or 87)) throw new Win32Exception(error);
        var classic = new Disposition { Delete = 1 };
        if (!SetFileInformationByHandle(handle, FileDispositionInfo, ref classic, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
