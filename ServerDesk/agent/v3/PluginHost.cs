using System.Collections.Concurrent;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Win32.SafeHandles;
using ServerDesk.Plugins;

namespace ServerDesk.Agent;

// Agent plugins (docs/agent-plugins.md). A plugin is a separate EXE with its
// own signed manifest. The SYSTEM broker keeps each plugin in
// %ProgramData%\ServerDesk\plugins\<name>\ (EXE, manifest.json with the exact
// signed bytes, manifest.sig) behind a protected DACL for SYSTEM and
// Administrators. Before every start and every report it checks the folder
// DACL, the manifest signature against the embedded publisher key, the name,
// the protocol, the minimum agent version and the EXE size and SHA-256 through
// a handle that refuses writers until the process runs. A plugin runs only for
// one request, as a child of the broker in its own job object, with a minimal
// environment and the fixed argument --plugin-host. Two Windows Firewall rules
// block its network. It gets only operations of a verified job envelope or a
// verified plugin policy, and only ones its manifest lists. A crash, a timeout
// or a broken answer fails that one request; the broker keeps running.

/// <summary>A verified plugin manifest: the parsed fields and the exact signed bytes.</summary>
internal sealed record PluginManifest(string Name, string Role, string Version, string MinAgentVersion, string[] Capabilities, string ExePath, string Sha256, long Size, JsonArray? Parts, string Text, string Signature);

internal static class PluginFiles
{
    internal const string ManifestFile = "manifest.json", SignatureFile = "manifest.sig", StagingFolder = ".staging";
    internal static string Root(string root) => Path.Combine(root, "plugins");
    internal static string Folder(string root, string name) => Path.Combine(Root(root), name);
    internal static string Pascal(string name) => string.Concat(name.Split('-').Select(part => part.Length == 0 ? "" : char.ToUpperInvariant(part[0]) + part[1..]));
    internal static string ExeName(string name) => "ServerDesk.Plugin." + Pascal(name) + ".exe";
    internal static string Executable(string root, string name) => Path.Combine(Folder(root, name), ExeName(name));
    internal static string DownloadPath(string name, string version) => "/downloads/ServerDesk-Plugin-" + name + "-" + version + "-win-x64.exe";
}

internal static class PluginManifests
{
    internal const int MaximumBytes = 8192;
    internal const long MaximumExe = 104_857_600, MaximumPart = 20_971_520;

    /// <summary>
    /// Verifies the signature over the exact manifest bytes with the trusted key
    /// (AgentUpdater.PublicKey in production), then kind, name, protocol, the
    /// minimum agent version and the EXE entry in the path form.
    /// AGENT_PLUGIN_SIGNATURE_INVALID or AGENT_PLUGIN_AGENT_TOO_OLD otherwise.
    /// </summary>
    internal static PluginManifest Verify(string manifest, string signature, string expectedName, string agentVersion, string trustedPublicKeyPem)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(manifest);
        bool valid = false;
        try
        {
            using var key = ECDsa.Create(); key.ImportFromPem(trustedPublicKeyPem);
            valid = bytes.Length <= MaximumBytes && signature.Length is > 0 and <= 256 && key.VerifyData(bytes, Convert.FromBase64String(signature), HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
        }
        catch (Exception e) when (e is FormatException or CryptographicException or ArgumentException) { valid = false; }
        if (!valid) throw new AgentMessageException("AGENT_PLUGIN_SIGNATURE_INVALID");
        JsonObject data;
        try { data = JsonNode.Parse(bytes) as JsonObject ?? throw new InvalidDataException(); }
        catch (Exception e) when (e is System.Text.Json.JsonException or InvalidDataException) { throw new AgentMessageException("AGENT_PLUGIN_SIGNATURE_INVALID"); }
        string Text(JsonObject value, string name) => PluginProtocol.Text(value, name);
        string name = Text(data, "name"), version = Text(data, "version"), minimum = Text(data, "minAgentVersion"), role = Text(data, "role");
        if (Text(data, "kind") != "plugin" || name != expectedName || !PluginProtocol.IsName(name) || PluginProtocol.Integer(data, "protocolVersion") != PluginProtocol.Version
            || Text(data, "arch") != "x64" || !PluginProtocol.IsVersion(version) || !PluginProtocol.IsBaseVersion(minimum) || !PluginProtocol.IsName(role)) throw new AgentMessageException("AGENT_PLUGIN_SIGNATURE_INVALID");
        if (data["capabilities"] is not JsonArray list || list.Count is < 1 or > 32) throw new AgentMessageException("AGENT_PLUGIN_SIGNATURE_INVALID");
        string[] capabilities = list.Select(item => item is JsonValue value && value.TryGetValue<string>(out var text) ? text : "").ToArray();
        if (capabilities.Any(item => !PluginProtocol.IsCapability(item)) || capabilities.Distinct(StringComparer.Ordinal).Count() != capabilities.Length) throw new AgentMessageException("AGENT_PLUGIN_SIGNATURE_INVALID");
        if (data["exe"] is not JsonObject exe) throw new AgentMessageException("AGENT_PLUGIN_SIGNATURE_INVALID");
        string path = Text(exe, "path"), sha256 = Text(exe, "sha256"); long size = PluginProtocol.Integer(exe, "size");
        if (path != PluginFiles.DownloadPath(name, version) || !AgentUpdater.IsDownloadPath(path) || sha256.Length != 64 || !sha256.All(Uri.IsHexDigit) || size is < 1 or > MaximumExe) throw new AgentMessageException("AGENT_PLUGIN_SIGNATURE_INVALID");
        JsonArray? parts = null;
        if (exe["parts"] is JsonArray pieces)
        {
            if (pieces.Count is < 1 or > 6) throw new AgentMessageException("AGENT_PLUGIN_SIGNATURE_INVALID");
            long total = 0; int index = 0;
            foreach (var piece in pieces)
            {
                index++;
                if (piece is not JsonObject part || Text(part, "path") != path + ".part" + index || !AgentUpdater.IsDownloadPath(Text(part, "path")) || Text(part, "sha256").Length != 64 || !Text(part, "sha256").All(Uri.IsHexDigit)
                    || PluginProtocol.Integer(part, "size") is < 1 or > MaximumPart) throw new AgentMessageException("AGENT_PLUGIN_SIGNATURE_INVALID");
                total += PluginProtocol.Integer(part, "size");
            }
            if (total != size) throw new AgentMessageException("AGENT_PLUGIN_SIGNATURE_INVALID");
            parts = pieces;
        }
        else if (exe["parts"] is not null) throw new AgentMessageException("AGENT_PLUGIN_SIGNATURE_INVALID");
        // The minimum is X.Y.Z; a dev agent X.Y.Z-dev.<sha7> meets it by its base X.Y.Z.
        if (!System.Version.TryParse(minimum, out var needed) || !ReleaseVersion.TryParse(agentVersion, out var running, out _) || needed > running) throw new AgentMessageException("AGENT_PLUGIN_AGENT_TOO_OLD", ("version", minimum));
        return new PluginManifest(name, role, version, minimum, capabilities, path, sha256.ToLowerInvariant(), size, parts, manifest, signature);
    }
}

// The DACL rule of the plugin folders: owner SYSTEM or Administrators, and no
// ACE that grants another principal write, append, delete, WRITE_DAC or
// WRITE_OWNER. plugins\ itself must also be protected (no inherited ACEs).
// Since 4.19.0 plugins\ also grants Authenticated Users read and execute, so
// a plugin change can start the EXE with the token of the signed-in account
// (docs/plugin-ad-sign-in.md). Read rights are not unsafe.
internal static class PluginAcl
{
    internal const string SystemSid = "S-1-5-18", AdministratorsSid = "S-1-5-32-544", AuthenticatedUsersSid = "S-1-5-11";
    internal const int ReadAndExecute = (int)FileSystemRights.ReadAndExecute;
    // WriteData, AppendData, DeleteSubdirectoriesAndFiles, Delete, WRITE_DAC, WRITE_OWNER, GENERIC_ALL and GENERIC_WRITE.
    internal const int UnsafeRights = 0x2 | 0x4 | 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
    internal readonly record struct Ace(string Sid, int Rights, bool Allow);

    /// <summary>Null for a safe folder; otherwise the reason. Pure, so the self-test covers every case.</summary>
    internal static string? UnsafeReason(string? ownerSid, IEnumerable<Ace> aces, bool protectedDacl, bool requireProtected)
    {
        if (ownerSid is not (SystemSid or AdministratorsSid)) return "owner";
        if (requireProtected && !protectedDacl) return "inherited";
        foreach (var ace in aces) if (ace.Allow && ace.Sid is not (SystemSid or AdministratorsSid) && (ace.Rights & UnsafeRights) != 0) return "ace " + ace.Sid;
        return null;
    }

    /// <summary>The reason a folder is unsafe, or null. A reparse point is unsafe.</summary>
    internal static string? Check(string path, bool requireProtected)
    {
        var info = new DirectoryInfo(path);
        if (!info.Exists) return "missing";
        if ((info.Attributes & FileAttributes.ReparsePoint) != 0) return "reparse";
        var security = info.GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner);
        string? owner = (security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier)?.Value;
        var aces = security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>()
            .Select(rule => new Ace(((SecurityIdentifier)rule.IdentityReference).Value, (int)rule.FileSystemRights, rule.AccessControlType == AccessControlType.Allow));
        return UnsafeReason(owner, aces, security.AreAccessRulesProtected, requireProtected);
    }

    /// <summary>The protected DACL of plugins\: FullControl for SYSTEM and Administrators, ReadAndExecute for Authenticated Users, owner Administrators, all inherited to the children.</summary>
    internal static DirectorySecurity ProtectedSecurity()
    {
        var admins = new SecurityIdentifier(AdministratorsSid); var system = new SecurityIdentifier(SystemSid);
        var security = new DirectorySecurity(); security.SetAccessRuleProtection(true, false); security.SetOwner(admins);
        foreach (var sid in new[] { system, admins }) security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(AuthenticatedUsersSid), FileSystemRights.ReadAndExecute, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        return security;
    }
    internal static void Protect(string path)
    {
        Directory.CreateDirectory(path);
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("The plugin folder is a reparse point.");
        new DirectoryInfo(path).SetAccessControl(ProtectedSecurity());
    }

    /// <summary>The ACEs of a DACL in the form UnsafeReason checks; `Inherits` marks ACEs that reach files and subfolders.</summary>
    internal static IEnumerable<(Ace Ace, bool Inherits)> Aces(DirectorySecurity security) => security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>()
        .Select(rule => (new Ace(((SecurityIdentifier)rule.IdentityReference).Value, (int)rule.FileSystemRights, rule.AccessControlType == AccessControlType.Allow), rule.InheritanceFlags == (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit) && rule.PropagationFlags == PropagationFlags.None));
    /// <summary>Whether plugins\ grants Authenticated Users read and execute for every child (4.19.0). Pure, for the self-test.</summary>
    internal static bool UserCanRead(IEnumerable<(Ace Ace, bool Inherits)> aces) => aces.Any(entry => entry.Inherits && entry.Ace.Allow && entry.Ace.Sid == AuthenticatedUsersSid && (entry.Ace.Rights & ReadAndExecute) == ReadAndExecute);

    /// <summary>
    /// At start-up: an install from 4.16 to 4.18 gets the read ACE of 4.19.0 once,
    /// so a change can start the plugin with the account's token. A missing
    /// folder stays missing; a failure only logs.
    /// </summary>
    internal static void EnsureUserRead(string path, Action<string> log)
    {
        try
        {
            var info = new DirectoryInfo(path);
            if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0) return;
            if (UserCanRead(Aces(info.GetAccessControl(AccessControlSections.Access)))) return;
            Protect(path); log("Plugin folder: read access for Authenticated Users added (4.19.0).");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException or SystemException) { log("Plugin folder read access: " + e.Message); }
    }
}

/// <summary>A running plugin process: its pipes, its exit and a kill of its job object.</summary>
internal interface IPluginProcess : IDisposable
{
    Stream Input { get; }
    Stream Output { get; }
    Stream Error { get; }
    Task<int> WaitForExitAsync(CancellationToken token);
    void Kill();
}
/// <summary>Starts a plugin; with `account` (4.19.0) the process runs with that primary token instead of the broker's LocalSystem token.</summary>
internal interface IPluginProcessFactory { IPluginProcess Start(string executable, string workingDirectory, IPluginAccountToken? account = null); }

// Starts a plugin suspended, puts it into its own job object (kill on close,
// one active process, 512 MiB job memory) and only then lets it run. The child
// inherits only its three pipe ends, gets a minimal environment and the fixed
// command line "<exe>" --plugin-host. A plugin change (4.19.0) starts the same
// way through CreateProcessAsUserW with the account's primary token and an
// empty desktop name, so Windows gives the process a window station of its
// own logon session instead of the service desktop.
internal sealed class WindowsPluginProcessFactory : IPluginProcessFactory
{
    internal const long JobMemoryLimit = 512L * 1024 * 1024;
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { public long PerProcessUser, PerJobUser; public uint Flags; public UIntPtr Minimum, Maximum; public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct Limits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo { public int Size; public IntPtr Reserved, Desktop, Title; public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags; public short ShowWindow, ReservedBytes; public IntPtr ReservedPointer, Input, Output, Error; }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { public StartupInfo Startup; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr Process, Thread; public int Id, ThreadId; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, int size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, int mask, int flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, int flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, int flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo info);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, int flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo info);
    [StructLayout(LayoutKind.Sequential)] private struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] private struct OnePrivilege { public int Count; public Luid Luid; public int Attributes; }
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, int access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool LookupPrivilegeValueW(string? system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref OnePrivilege state, int length, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    private static int privilegesEnabled;
    // LocalSystem holds both privileges that CreateProcessAsUserW needs; they are enabled once.
    private static void EnablePrivileges()
    {
        if (Interlocked.Exchange(ref privilegesEnabled, 1) == 1) return;
        if (!OpenProcessToken(GetCurrentProcess(), 0x20 | 0x8, out var token)) return;
        try
        {
            foreach (string name in new[] { "SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege" })
                if (LookupPrivilegeValueW(null, name, out var luid)) { var state = new OnePrivilege { Count = 1, Luid = luid, Attributes = 0x2 }; AdjustTokenPrivileges(token, false, ref state, Marshal.SizeOf<OnePrivilege>(), IntPtr.Zero, IntPtr.Zero); }
        }
        finally { CloseHandle(token); }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits info, int length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern int ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    /// <summary>The environment of a plugin: only the Windows paths a .NET process needs.</summary>
    internal static string EnvironmentBlock()
    {
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows), system = Environment.SystemDirectory, temp = Path.Combine(windows, "Temp");
        var variables = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["SystemRoot"] = windows, ["windir"] = windows, ["SystemDrive"] = Path.GetPathRoot(windows)!.TrimEnd('\\'), ["TEMP"] = temp, ["TMP"] = temp,
            ["PATH"] = system + ";" + windows, ["COMPUTERNAME"] = Environment.MachineName, ["PROCESSOR_ARCHITECTURE"] = "AMD64", ["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1",
        };
        return string.Concat(variables.Select(pair => pair.Key + "=" + pair.Value + "\0")) + "\0";
    }

    public IPluginProcess Start(string executable, string workingDirectory, IPluginAccountToken? account = null)
    {
        if (!Path.IsPathFullyQualified(executable) || executable.Contains('"')) throw new InvalidDataException("Invalid plugin path.");
        if (account is not null && account.Handle == IntPtr.Zero) throw new InvalidOperationException("The account token is closed.");
        var inheritable = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Inherit = 1 };
        IntPtr inRead = IntPtr.Zero, inWrite = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero, job = IntPtr.Zero, list = IntPtr.Zero, handles = IntPtr.Zero, environment = IntPtr.Zero, desktop = IntPtr.Zero;
        var info = new ProcessInfo();
        try
        {
            if (!CreatePipe(out inRead, out inWrite, ref inheritable, 0) || !CreatePipe(out outRead, out outWrite, ref inheritable, 0) || !CreatePipe(out errRead, out errWrite, ref inheritable, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot create the plugin pipes");
            // The broker's ends are never inherited.
            foreach (var own in new[] { inWrite, outRead, errRead }) if (!SetHandleInformation(own, 1, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            job = CreateJobObjectW(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            // KILL_ON_JOB_CLOSE, DIE_ON_UNHANDLED_EXCEPTION, ACTIVE_PROCESS (1) and JOB_MEMORY.
            var limits = new Limits { Basic = new BasicLimits { Flags = 0x2000u | 0x400u | 0x8u | 0x200u, ActiveProcesses = 1 }, JobMemory = (UIntPtr)JobMemoryLimit };
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf<Limits>())) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot limit the plugin job object");
            // Only the three child ends are inherited (PROC_THREAD_ATTRIBUTE_HANDLE_LIST).
            IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            list = Marshal.AllocHGlobal(size); if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3); Marshal.WriteIntPtr(handles, 0, inRead); Marshal.WriteIntPtr(handles, IntPtr.Size, outWrite); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, errWrite);
            if (!UpdateProcThreadAttribute(list, 0, (IntPtr)0x20002, handles, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            // A user token gets the empty desktop name: a window station of its own logon session.
            if (account is not null) desktop = Marshal.StringToHGlobalUni("");
            var startup = new StartupInfoEx { Startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfoEx>(), Flags = 0x100, Input = inRead, Output = outWrite, Error = errWrite, Desktop = desktop }, AttributeList = list };
            environment = Marshal.StringToHGlobalUni(EnvironmentBlock());
            var command = new StringBuilder("\"" + executable + "\" " + PluginProtocol.Argument);
            // CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, CREATE_NO_WINDOW.
            const int flags = 0x4 | 0x400 | 0x80000 | 0x08000000;
            if (account is null)
            {
                if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, flags, environment, workingDirectory, ref startup, out info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot start the plugin");
            }
            else
            {
                EnablePrivileges();
                if (!CreateProcessAsUserW(account.Handle, executable, command, IntPtr.Zero, IntPtr.Zero, true, flags, environment, workingDirectory, ref startup, out info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot start the plugin with the account");
            }
            if (!AssignProcessToJobObject(job, info.Process)) { int error = Marshal.GetLastWin32Error(); TerminateProcess(info.Process, 1); throw new Win32Exception(error, "Cannot put the plugin into its job object"); }
            if (ResumeThread(info.Thread) < 0) { int error = Marshal.GetLastWin32Error(); TerminateJobObject(job, 1); throw new Win32Exception(error, "Cannot resume the plugin"); }
            var process = new Handles(job, info.Process, new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write, 1), new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read, 1), new FileStream(new SafeFileHandle(errRead, true), FileAccess.Read, 1));
            job = IntPtr.Zero; info.Process = IntPtr.Zero; inWrite = outRead = errRead = IntPtr.Zero;
            return process;
        }
        finally
        {
            // The child ends belong to the child now; the parent closes its copies.
            foreach (var handle in new[] { inRead, outWrite, errWrite, inWrite, outRead, errRead, info.Thread, info.Process, job }) if (handle != IntPtr.Zero) CloseHandle(handle);
            if (list != IntPtr.Zero) { DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); }
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (desktop != IntPtr.Zero) Marshal.FreeHGlobal(desktop);
        }
    }

    private sealed class Handles(IntPtr job, IntPtr process, Stream input, Stream output, Stream error) : IPluginProcess
    {
        private IntPtr job = job, process = process;
        private readonly object gate = new();
        public Stream Input { get; } = input;
        public Stream Output { get; } = output;
        public Stream Error { get; } = error;
        public async Task<int> WaitForExitAsync(CancellationToken token)
        {
            IntPtr handle; lock (gate) handle = process;
            if (handle == IntPtr.Zero) return -1;
            using var wait = new ManualResetEvent(false) { SafeWaitHandle = new SafeWaitHandle(handle, false) };
            var exited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var registration = ThreadPool.RegisterWaitForSingleObject(wait, (_, _) => exited.TrySetResult(), null, Timeout.Infinite, true);
            try { await exited.Task.WaitAsync(token); }
            finally { registration.Unregister(null); }
            return GetExitCodeProcess(handle, out uint code) ? unchecked((int)code) : -1;
        }
        public void Kill() { lock (gate) if (job != IntPtr.Zero) TerminateJobObject(job, 1); }
        public void Dispose()
        {
            try { Input.Dispose(); } catch { } try { Output.Dispose(); } catch { } try { Error.Dispose(); } catch { }
            lock (gate)
            {
                // Closing the job kills whatever is still running in it.
                if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
                if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
            }
        }
    }
}

/// <summary>The two Windows Firewall rules that block a plugin EXE in both directions.</summary>
internal interface IPluginFirewall
{
    bool Blocked(string name, string executable);
    void Ensure(string name, string executable);
    void Remove(string name);
    void RemoveAll();
}

// Rules the agent owns: "ServerDesk Plugin <name> (block outbound)" and
// "(block inbound)", program = the plugin EXE, every protocol and profile.
internal sealed class WindowsPluginFirewall : IPluginFirewall
{
    internal const string Prefix = "ServerDesk Plugin ", Group = "ServerDesk agent plugins";
    internal static string RuleName(string name, bool outbound) => Prefix + name + (outbound ? " (block outbound)" : " (block inbound)");
    private sealed record Rule(string Name, string Application, int Direction, int Action, int Protocol, bool Enabled, string Grouping);

    private static List<Rule> Read(object policyObject)
    {
        var rules = new List<Rule>(); object? list = null;
        try
        {
            dynamic policy = policyObject; dynamic all = list = policy.Rules;
            foreach (dynamic rule in all)
            {
                try
                {
                    string name = (string)rule.Name;
                    if (name.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase)) rules.Add(new Rule(name, (string?)rule.ApplicationName ?? "", (int)rule.Direction, (int)rule.Action, (int)rule.Protocol, (bool)rule.Enabled, (string?)rule.Grouping ?? ""));
                }
                finally { NativeManagement.ReleaseCom(rule); }
            }
        }
        finally { NativeManagement.ReleaseCom(list); }
        return rules;
    }
    private static bool Matches(Rule rule, string name, string executable, bool outbound) => rule.Name == RuleName(name, outbound) && string.Equals(rule.Application, executable, StringComparison.OrdinalIgnoreCase) && rule.Direction == (outbound ? 2 : 1) && rule.Action == 0 && rule.Protocol == 256 && rule.Enabled;

    public bool Blocked(string name, string executable)
    {
        object policy = NativeManagement.CreateCom("HNetCfg.FwPolicy2");
        try { var rules = Read(policy); return new[] { true, false }.All(outbound => rules.Any(rule => Matches(rule, name, executable, outbound))); }
        finally { NativeManagement.ReleaseCom(policy); }
    }

    public void Ensure(string name, string executable)
    {
        object policyObject = NativeManagement.CreateCom("HNetCfg.FwPolicy2");
        try
        {
            var rules = Read(policyObject);
            foreach (bool outbound in new[] { true, false })
            {
                if (rules.Any(rule => Matches(rule, name, executable, outbound))) continue;
                // A rule of this name with other values is replaced, never kept beside the right one.
                if (rules.Any(rule => string.Equals(rule.Name, RuleName(name, outbound), StringComparison.OrdinalIgnoreCase))) RemoveNamed(policyObject, RuleName(name, outbound));
                object? ruleObject = null, list = null;
                try
                {
                    dynamic rule = ruleObject = NativeManagement.CreateCom("HNetCfg.FWRule");
                    rule.Name = RuleName(name, outbound); rule.Description = "Blocks the network of the ServerDesk agent plugin " + name + "."; rule.Grouping = Group;
                    rule.ApplicationName = executable; rule.Protocol = 256; rule.Direction = outbound ? 2 : 1; rule.Action = 0; rule.Profiles = int.MaxValue; rule.Enabled = true;
                    dynamic policy = policyObject; dynamic all = list = policy.Rules; all.Add(rule);
                }
                finally { NativeManagement.ReleaseCom(list); NativeManagement.ReleaseCom(ruleObject); }
            }
        }
        finally { NativeManagement.ReleaseCom(policyObject); }
    }

    private static void RemoveNamed(object policyObject, string name)
    {
        object? list = null;
        try { dynamic policy = policyObject; dynamic all = list = policy.Rules; all.Remove(name); }
        finally { NativeManagement.ReleaseCom(list); }
    }

    public void Remove(string name)
    {
        object policyObject = NativeManagement.CreateCom("HNetCfg.FwPolicy2");
        try
        {
            var rules = Read(policyObject);
            foreach (bool outbound in new[] { true, false }) foreach (var rule in rules.Where(rule => string.Equals(rule.Name, RuleName(name, outbound), StringComparison.OrdinalIgnoreCase))) RemoveNamed(policyObject, rule.Name);
        }
        finally { NativeManagement.ReleaseCom(policyObject); }
    }

    public void RemoveAll()
    {
        object policyObject = NativeManagement.CreateCom("HNetCfg.FwPolicy2");
        try { foreach (var rule in Read(policyObject).Where(rule => rule.Grouping == Group)) RemoveNamed(policyObject, rule.Name); }
        finally { NativeManagement.ReleaseCom(policyObject); }
    }
}

// The protocol client: one hello, at most one request, one result.
internal static class PluginSession
{
    /// <summary>
    /// Runs the exchange of AC on one started process. Without an operation it
    /// is the hello handshake of an install. Every failure is an
    /// AgentMessageException with its AGENT_PLUGIN_* code; the process is killed then.
    /// </summary>
    internal static async Task<PluginResult?> ExchangeAsync(IPluginProcess process, PluginManifest manifest, string agentVersion, string? requestId, string? operation, JsonObject? parameters, TimeSpan helloTimeout, TimeSpan resultTimeout, CancellationToken token)
    {
        var reader = new PluginLineReader(process.Output);
        async Task<int> ExitCodeAsync()
        {
            using var wait = CancellationTokenSource.CreateLinkedTokenSource(token); wait.CancelAfter(TimeSpan.FromSeconds(10));
            try { return await process.WaitForExitAsync(wait.Token); }
            catch (OperationCanceledException) when (!token.IsCancellationRequested) { process.Kill(); return -1; }
        }
        async Task<JsonObject> ReadAsync(string type, TimeSpan timeout)
        {
            var read = reader.ReadLineAsync(PluginProtocol.MaximumPluginLine, CancellationToken.None);
            var finished = await Task.WhenAny(read, Task.Delay(timeout, token));
            if (finished != read)
            {
                process.Kill();
                try { await read; } catch { }
                token.ThrowIfCancellationRequested();
                throw new AgentMessageException("AGENT_PLUGIN_TIMEOUT");
            }
            byte[]? line;
            try { line = await read; }
            catch (ProtocolException e) when (e.Reason == "eof") { line = null; }
            catch (ProtocolException) { process.Kill(); throw new AgentMessageException("AGENT_PLUGIN_OUTPUT_INVALID"); }
            catch (IOException) { line = null; }
            if (line is null) throw new AgentMessageException("AGENT_PLUGIN_CRASHED", ("exitCode", await ExitCodeAsync()));
            try { return PluginProtocol.Parse(line, type); }
            catch (ProtocolException) { process.Kill(); throw new AgentMessageException("AGENT_PLUGIN_OUTPUT_INVALID"); }
        }
        async Task WriteAsync(JsonObject value)
        {
            try { await PluginProtocol.WriteLineAsync(process.Input, value, PluginProtocol.MaximumBrokerLine, token); }
            catch (IOException) { throw new AgentMessageException("AGENT_PLUGIN_CRASHED", ("exitCode", await ExitCodeAsync())); }
        }
        await WriteAsync(PluginProtocol.BrokerHello(agentVersion));
        JsonObject hello;
        try { hello = await ReadAsync("hello", helloTimeout); }
        catch (AgentMessageException e) when (e.Code == "AGENT_PLUGIN_OUTPUT_INVALID") { throw new AgentMessageException("AGENT_PLUGIN_HANDSHAKE_FAILED"); }
        try
        {
            var (name, version, capabilities) = PluginProtocol.ReadPluginHello(hello);
            if (name != manifest.Name || version != manifest.Version || !capabilities.OrderBy(item => item, StringComparer.Ordinal).SequenceEqual(manifest.Capabilities.OrderBy(item => item, StringComparer.Ordinal))) throw new ProtocolException("The plugin hello differs from its manifest.", "handshake");
        }
        catch (ProtocolException) { process.Kill(); throw new AgentMessageException("AGENT_PLUGIN_HANDSHAKE_FAILED"); }
        if (requestId is null || operation is null)
        {
            process.Input.Dispose();
            int code = await ExitCodeAsync();
            if (code != 0) throw new AgentMessageException("AGENT_PLUGIN_CRASHED", ("exitCode", code));
            return null;
        }
        await WriteAsync(PluginProtocol.Request(requestId, operation, parameters ?? new JsonObject()));
        process.Input.Dispose();
        var line = await ReadAsync("result", resultTimeout);
        PluginResult result;
        try { result = PluginProtocol.ReadResult(line, requestId); }
        catch (ProtocolException) { process.Kill(); throw new AgentMessageException("AGENT_PLUGIN_OUTPUT_INVALID"); }
        int exit = await ExitCodeAsync();
        if (exit != 0) throw new AgentMessageException("AGENT_PLUGIN_CRASHED", ("exitCode", exit));
        return result;
    }
}

internal sealed class PluginHost
{
    internal const int MaximumPlugins = 16, MaximumStderr = 65_536;
    internal static readonly TimeSpan BusyWait = TimeSpan.FromSeconds(30), HelloTimeout = TimeSpan.FromSeconds(10), ResultTimeout = TimeSpan.FromSeconds(120), ReportLifetime = TimeSpan.FromMinutes(15), FirstCollection = TimeSpan.FromSeconds(60);
    private readonly string root, agentVersion, publicKeyPem;
    private readonly IPluginProcessFactory processes;
    private readonly IPluginTokenFactory tokens;
    private readonly IPluginFirewall firewall;
    private readonly Func<string, bool, string?> aclCheck;
    private readonly Action<string> log;
    private readonly Func<DateTimeOffset> clock;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);
    private readonly object reportGate = new(), policyGate = new();
    private (DateTimeOffset At, JsonArray Report)? cached;
    // 4.21.1: the last verified entry of every plugin, under reportGate. Invalidate() keeps it, so a
    // plugin whose gate is busy (a read, an install, a removal) stays in the report with this entry.
    private readonly Dictionary<string, JsonObject> lastEntries = new(StringComparer.Ordinal);
    private JsonObject[] collect = [];
    private DateTimeOffset policyExpires;
    private readonly Dictionary<string, DateTimeOffset> next = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Task> collecting = new(StringComparer.Ordinal);
    private volatile string? changing;

    internal PluginHost(string root, Action<string> log, IPluginProcessFactory? processes = null, IPluginFirewall? firewall = null, string? publicKeyPem = null, Func<string, bool, string?>? aclCheck = null, Func<DateTimeOffset>? clock = null, string? agentVersion = null, IPluginTokenFactory? tokens = null)
    {
        this.root = root; this.log = log; this.processes = processes ?? new WindowsPluginProcessFactory(); this.firewall = firewall ?? new WindowsPluginFirewall();
        this.tokens = tokens ?? new WindowsPluginTokenFactory(() => { try { return new WindowsAdLogon().Directory(); } catch (Win32Exception) { return null; } });
        this.publicKeyPem = publicKeyPem ?? AgentUpdater.PublicKey; this.aclCheck = aclCheck ?? PluginAcl.Check; this.clock = clock ?? (() => DateTimeOffset.UtcNow); this.agentVersion = agentVersion ?? Program.Version;
        // A staged install of a previous broker never becomes a plugin.
        try { string staging = Path.Combine(PluginFiles.Root(root), PluginFiles.StagingFolder); if (Directory.Exists(staging)) Directory.Delete(staging, true); } catch (Exception e) { log("Plugin staging cleanup: " + e.Message); }
    }

    private SemaphoreSlim Gate(string name) => gates.GetOrAdd(name, _ => new SemaphoreSlim(1, 1));
    /// <summary>The name of the plugin an install or removal changes right now, or null.</summary>
    internal string? Changing => changing;

    /// <summary>The verified installed plugin: both folder DACLs, the signed manifest and the EXE size and SHA-256 through `exe`.</summary>
    private PluginManifest VerifyInstalled(string name, out FileStream exe)
    {
        string folder = PluginFiles.Folder(root, name);
        if (!Directory.Exists(folder)) throw new AgentMessageException("AGENT_PLUGIN_NOT_INSTALLED", ("name", name));
        if (aclCheck(PluginFiles.Root(root), true) is string top) { log("Plugin folder unsafe: plugins (" + top + ")."); throw new AgentMessageException("AGENT_PLUGIN_FOLDER_UNSAFE"); }
        if (aclCheck(folder, false) is string own) { log("Plugin folder unsafe: " + name + " (" + own + ")."); throw new AgentMessageException("AGENT_PLUGIN_FOLDER_UNSAFE"); }
        string manifestPath = Path.Combine(folder, PluginFiles.ManifestFile), signaturePath = Path.Combine(folder, PluginFiles.SignatureFile);
        if (!File.Exists(manifestPath) || !File.Exists(signaturePath) || new FileInfo(manifestPath).Length > PluginManifests.MaximumBytes || new FileInfo(signaturePath).Length > 256) throw new AgentMessageException("AGENT_PLUGIN_SIGNATURE_INVALID");
        var manifest = PluginManifests.Verify(File.ReadAllText(manifestPath, new UTF8Encoding(false, true)), File.ReadAllText(signaturePath).Trim(), name, agentVersion, publicKeyPem);
        string path = PluginFiles.Executable(root, name);
        FileStream? stream = null;
        try
        {
            // No writer and no delete while the broker hashes and starts the EXE.
            stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.SequentialScan);
            if (stream.Length != manifest.Size || Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant() != manifest.Sha256) throw new AgentMessageException("AGENT_PLUGIN_HASH_MISMATCH");
            exe = stream; stream = null; return manifest;
        }
        catch (FileNotFoundException) { throw new AgentMessageException("AGENT_PLUGIN_HASH_MISMATCH"); }
        finally { stream?.Dispose(); }
    }

    /// <summary>
    /// One request to one plugin: the gate (30 s, else AGENT_PLUGIN_BUSY), the
    /// checks before the start, the firewall rules, the process and the exchange.
    /// A change needs `actAs` (4.19.0, else AGENT_PLUGIN_ACCOUNT_REQUIRED): the
    /// plugin then runs with the S4U token of that account, whose user SID must
    /// be actAs.userSid (else AGENT_PLUGIN_ACCOUNT_MISMATCH). The token is
    /// closed after the run and on every failure.
    /// </summary>
    internal async Task<PluginResult> RunAsync(string name, string operation, JsonObject parameters, string requestId, CancellationToken token, bool wait = true, IReadOnlyCollection<string>? secrets = null, PluginActAs? actAs = null)
    {
        if (!PluginProtocol.IsName(name)) throw new AgentMessageException("AGENT_PLUGIN_NOT_INSTALLED", ("name", name));
        var gate = Gate(name);
        if (!await gate.WaitAsync(wait ? BusyWait : TimeSpan.Zero, token)) throw new AgentMessageException("AGENT_PLUGIN_BUSY");
        try
        {
            PluginManifest manifest; FileStream exe;
            try { manifest = VerifyInstalled(name, out exe); }
            catch (AgentMessageException) { Invalidate(); throw; }
            using (exe)
            {
                if (!manifest.Capabilities.Contains(operation, StringComparer.Ordinal)) throw new AgentMessageException("AGENT_PLUGIN_OPERATION_UNKNOWN");
                // A change never falls back to SYSTEM.
                if (actAs is null && !ReadOperation(operation)) throw new AgentMessageException("AGENT_PLUGIN_ACCOUNT_REQUIRED");
                string path = PluginFiles.Executable(root, name);
                try { firewall.Ensure(name, path); } catch (Exception e) { log("Plugin firewall rules of " + name + ": " + e.Message); }
                using var account = actAs is null ? null : OpenAccount(actAs);
                using var process = processes.Start(path, PluginFiles.Folder(root, name), account);
                // The process runs from the verified bytes; the handle may go now.
                exe.Dispose();
                return (await ExchangeAsync(process, manifest, requestId, operation, parameters, token, secrets))!;
            }
        }
        finally { gate.Release(); }
    }

    /// <summary>The S4U token of actAs; a token of another user is closed and refused.</summary>
    private IPluginAccountToken OpenAccount(PluginActAs actAs)
    {
        var account = tokens.Logon(actAs);
        if (string.Equals(account.UserSid, actAs.UserSid, StringComparison.OrdinalIgnoreCase)) return account;
        account.Dispose();
        throw new AgentMessageException("AGENT_PLUGIN_ACCOUNT_MISMATCH");
    }

    private async Task<PluginResult?> ExchangeAsync(IPluginProcess process, PluginManifest manifest, string? requestId, string? operation, JsonObject? parameters, CancellationToken token, IReadOnlyCollection<string>? secrets = null)
    {
        var stderr = Task.Run(async () =>
        {
            byte[] buffer = new byte[4096]; using var kept = new MemoryStream();
            try { while (true) { int read = await process.Error.ReadAsync(buffer, CancellationToken.None); if (read == 0) break; if (kept.Length < MaximumStderr) kept.Write(buffer, 0, (int)Math.Min(read, MaximumStderr - kept.Length)); } }
            catch (Exception) { }
            return Encoding.UTF8.GetString(kept.ToArray());
        }, CancellationToken.None);
        try { return await PluginSession.ExchangeAsync(process, manifest, agentVersion, requestId, operation, parameters, HelloTimeout, ResultTimeout, token); }
        catch (OperationCanceledException) { process.Kill(); throw; }
        finally
        {
            process.Kill();
            var finished = await Task.WhenAny(stderr, Task.Delay(TimeSpan.FromSeconds(2), CancellationToken.None));
            // The secrets of the job (4.17.0) never reach the log, also not through the plugin's stderr.
            if (finished == stderr && (await stderr).Trim() is { Length: > 0 } text) log("Plugin " + manifest.Name + " stderr: " + SecretMask.Apply(new string(text.Select(c => char.IsControl(c) && c is not ('\n' or '\t') ? ' ' : c).ToArray()), secrets ?? []));
        }
    }

    /// <summary>
    /// plugin-install: the signed manifest of the job, the download of the EXE
    /// through the worker into plugins\.staging\&lt;jobId&gt;\ with size and
    /// SHA-256 checked while copying, the hello handshake from staging, then the
    /// swap with the old folder kept until the new one passes.
    /// </summary>
    internal async Task<JsonObject> InstallAsync(JsonObject job, string origin, IReleaseSource releases, CancellationToken token)
    {
        string id = job["id"]!.GetValue<string>(); var p = job["parameters"] as JsonObject ?? new JsonObject();
        string name = PluginProtocol.Text(p, "name"), manifestText = PluginProtocol.Text(p, "manifest"), signature = PluginProtocol.Text(p, "signature");
        if (!PluginProtocol.IsName(name) || !Guid.TryParse(id, out _)) throw new AgentMessageException("AGENT_PLUGIN_SIGNATURE_INVALID");
        var manifest = PluginManifests.Verify(manifestText, signature, name, agentVersion, publicKeyPem);
        string top = PluginFiles.Root(root), staging = Path.Combine(top, PluginFiles.StagingFolder, id), folder = PluginFiles.Folder(root, name), previous = Path.Combine(top, PluginFiles.StagingFolder, id + ".previous");
        var gate = Gate(name);
        if (!await gate.WaitAsync(BusyWait, token)) throw new AgentMessageException("AGENT_PLUGIN_BUSY");
        changing = name;
        bool moved = false, installed = false, rulesStaged = false;
        try
        {
            PluginAcl.Protect(top);
            Directory.CreateDirectory(Path.Combine(top, PluginFiles.StagingFolder));
            if (Directory.Exists(staging)) Directory.Delete(staging, true);
            Directory.CreateDirectory(staging);
            string stagedExe = Path.Combine(staging, PluginFiles.ExeName(name));
            var site = new Uri(origin).GetLeftPart(UriPartial.Authority);
            var pieces = manifest.Parts ?? new JsonArray(new JsonObject { ["path"] = manifest.ExePath, ["size"] = manifest.Size, ["sha256"] = manifest.Sha256 });
            await using (var output = new FileStream(stagedExe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
            {
                foreach (var piece in pieces)
                {
                    long length = piece!["size"]!.GetValue<long>(), before = output.Length; using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromMinutes(15));
                    await releases.CopyAsync(site + piece["path"]!.GetValue<string>(), length, output, hash, deadline.Token);
                    if (output.Length - before != length || Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant() != piece["sha256"]!.GetValue<string>().ToLowerInvariant()) throw new AgentMessageException("AGENT_PLUGIN_HASH_MISMATCH");
                }
                await output.FlushAsync(token);
                if (output.Length != manifest.Size) throw new AgentMessageException("AGENT_PLUGIN_HASH_MISMATCH");
            }
            File.WriteAllText(Path.Combine(staging, PluginFiles.ManifestFile), manifest.Text, new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(staging, PluginFiles.SignatureFile), manifest.Signature, new UTF8Encoding(false));
            // The whole EXE against the manifest, then the hello handshake from these verified bytes.
            await using (var check = new FileStream(stagedExe, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (check.Length != manifest.Size || Convert.ToHexString(await SHA256.HashDataAsync(check, token)).ToLowerInvariant() != manifest.Sha256) throw new AgentMessageException("AGENT_PLUGIN_HASH_MISMATCH");
                // The handshake start has no network either: both block rules first point to the staged EXE.
                // Rules keep their names, so the Ensure after the swap moves them to the installed EXE.
                rulesStaged = true;
                try { firewall.Ensure(name, stagedExe); } catch (Exception e) { log("Plugin firewall rules of " + name + ": " + e.Message); }
                using var process = processes.Start(stagedExe, staging);
                await ExchangeAsync(process, manifest, null, null, null, token);
            }
            if (Directory.Exists(previous)) Directory.Delete(previous, true);
            if (Directory.Exists(folder)) { Directory.Move(folder, previous); moved = true; }
            Directory.Move(staging, folder); installed = true;
            try { firewall.Ensure(name, PluginFiles.Executable(root, name)); } catch (Exception e) { log("Plugin firewall rules of " + name + ": " + e.Message); }
            // The new folder passes the same checks as before every start.
            VerifyInstalled(name, out var verified); verified.Dispose();
            if (moved) try { Directory.Delete(previous, true); } catch (Exception e) { log("Previous plugin folder of " + name + ": " + e.Message); }
            moved = false;
            ScheduleAfterInstall(name);
            log("Plugin " + name + " " + manifest.Version + " installed.");
            return AgentMessages.Write(new JsonObject { ["id"] = id, ["ok"] = true }, "AGENT_PLUGIN_INSTALLED", ("name", name), ("version", manifest.Version));
        }
        catch
        {
            // Restore the old folder on every failure after the swap.
            try { if (installed && Directory.Exists(folder)) Directory.Delete(folder, true); if (moved && Directory.Exists(previous)) Directory.Move(previous, folder); }
            catch (Exception e) { log("Plugin restore of " + name + ": " + e.Message); }
            // The rules follow the folder that stays: back to the kept plugin, or gone without one.
            if (rulesStaged)
                try { if (Directory.Exists(folder)) firewall.Ensure(name, PluginFiles.Executable(root, name)); else firewall.Remove(name); }
                catch (Exception e) { log("Plugin firewall rules of " + name + ": " + e.Message); }
            throw;
        }
        finally
        {
            try { if (Directory.Exists(staging)) Directory.Delete(staging, true); } catch { }
            // Invalidate after the release: the next report verifies this plugin instead of skipping it as busy.
            changing = null; gate.Release(); Invalidate();
        }
    }

    /// <summary>plugin-remove: waits for a running process (30 s, else AGENT_PLUGIN_BUSY), deletes the folder and both firewall rules.</summary>
    internal async Task<JsonObject> RemoveAsync(string id, string name, CancellationToken token)
    {
        if (!PluginProtocol.IsName(name) || !Directory.Exists(PluginFiles.Folder(root, name))) throw new AgentMessageException("AGENT_PLUGIN_NOT_INSTALLED", ("name", name));
        var gate = Gate(name);
        if (!await gate.WaitAsync(BusyWait, token)) throw new AgentMessageException("AGENT_PLUGIN_BUSY");
        changing = name;
        try
        {
            try { firewall.Remove(name); } catch (Exception e) { log("Plugin firewall rules of " + name + ": " + e.Message); }
            Directory.Delete(PluginFiles.Folder(root, name), true);
            // A removed plugin is never reported from its last entry.
            lock (reportGate) lastEntries.Remove(name);
            lock (policyGate) foreach (var key in next.Keys.Where(key => key.StartsWith(name + "/", StringComparison.Ordinal)).ToArray()) next.Remove(key);
            log("Plugin " + name + " removed.");
            return AgentMessages.Write(new JsonObject { ["id"] = id, ["ok"] = true }, "AGENT_PLUGIN_REMOVED", ("name", name));
        }
        finally { changing = null; gate.Release(); Invalidate(); }
    }

    /// <summary>Removes every plugin firewall rule; the uninstall deletes plugins\ itself.</summary>
    internal static void RemoveAllFirewallRules(IPluginFirewall? firewall = null) => (firewall ?? new WindowsPluginFirewall()).RemoveAll();

    /// <summary>Drops the cached report; the last entry of every plugin stays (lastEntries).</summary>
    internal void Invalidate() { lock (reportGate) cached = null; }

    /// <summary>
    /// The plugins for the status answer, at most 16, from a verification at
    /// most 15 minutes old. A plugin that fails a check is damaged with its code.
    /// A plugin whose gate is busy right now (a read, an install, a removal)
    /// keeps its last entry, also after Invalidate(). A report that had to skip
    /// a busy plugin without any known entry is not cached, so the next status
    /// builds it again and a new plugin shows in the next heartbeat.
    /// </summary>
    internal JsonArray Report()
    {
        lock (reportGate)
        {
            if (cached is { } fresh && clock() - fresh.At < ReportLifetime) return (JsonArray)fresh.Report.DeepClone();
            var report = new JsonArray(); bool skipped = false;
            string top = PluginFiles.Root(root);
            var names = Directory.Exists(top) ? Directory.GetDirectories(top).Select(Path.GetFileName).Where(name => PluginProtocol.IsName(name)).Order(StringComparer.Ordinal).Take(MaximumPlugins).Select(name => name!).ToArray() : [];
            foreach (string name in names)
            {
                var gate = Gate(name);
                if (!gate.Wait(0))
                {
                    if (lastEntries.TryGetValue(name, out var kept)) report.Add(kept.DeepClone()); else skipped = true;
                    continue;
                }
                try { var entry = Entry(name); lastEntries[name] = (JsonObject)entry.DeepClone(); report.Add(entry); }
                finally { gate.Release(); }
            }
            // A plugin whose folder is gone is not kept.
            foreach (string gone in lastEntries.Keys.Where(name => !names.Contains(name, StringComparer.Ordinal)).ToArray()) lastEntries.Remove(gone);
            cached = skipped ? null : (clock(), report);
            return (JsonArray)report.DeepClone();
        }
    }

    private JsonObject Entry(string name)
    {
        string path = PluginFiles.Executable(root, name);
        bool Blocked() { try { return firewall.Blocked(name, path); } catch { return false; } }
        try
        {
            var manifest = VerifyInstalled(name, out var exe); exe.Dispose();
            return new JsonObject { ["name"] = name, ["role"] = manifest.Role, ["version"] = manifest.Version, ["capabilities"] = new JsonArray(manifest.Capabilities.Select(item => (JsonNode)JsonValue.Create(item)!).ToArray()), ["state"] = "ready", ["networkBlocked"] = Blocked() };
        }
        catch (Exception e)
        {
            string code = e is AgentMessageException coded && coded.Code.StartsWith("AGENT_PLUGIN_", StringComparison.Ordinal) ? coded.Code : "AGENT_PLUGIN_SIGNATURE_INVALID";
            if (e is not AgentMessageException) log("Plugin check of " + name + ": " + e.Message);
            // The role and version of a damaged plugin come from its manifest when that still parses.
            string role = "unknown", version = "0.0.0";
            try
            {
                var data = JsonNode.Parse(File.ReadAllText(Path.Combine(PluginFiles.Folder(root, name), PluginFiles.ManifestFile))) as JsonObject;
                if (data is not null && PluginProtocol.IsName(PluginProtocol.Text(data, "role"))) role = PluginProtocol.Text(data, "role");
                if (data is not null && PluginProtocol.IsVersion(PluginProtocol.Text(data, "version"))) version = PluginProtocol.Text(data, "version");
            }
            catch { }
            return new JsonObject { ["name"] = name, ["role"] = role, ["version"] = version, ["capabilities"] = new JsonArray(), ["state"] = "damaged", ["networkBlocked"] = Blocked(), ["error"] = code };
        }
    }

    // ---- Signed collection (plugin-policy) --------------------------------------------

    /// <summary>
    /// The verified plugin policy of the latest channel answer, or null for an
    /// unsigned, expired or foreign one: then every collection stops.
    /// </summary>
    internal void ConfigurePolicy(JsonObject? verified)
    {
        lock (policyGate)
        {
            var entries = new List<JsonObject>();
            if (verified?["policy"]?["collect"] is JsonArray list)
            {
                foreach (var item in list.Take(16))
                {
                    if (item is not JsonObject entry) continue;
                    string plugin = PluginProtocol.Text(entry, "plugin"), operation = PluginProtocol.Text(entry, "operation"); long interval = PluginProtocol.Integer(entry, "intervalSeconds");
                    // Periodic runs ignore the agent mode, so the policy may only start read operations.
                    if (PluginProtocol.IsName(plugin) && PluginProtocol.IsCapability(operation) && ReadOperation(operation) && interval is >= 60 and <= 86400) entries.Add(new JsonObject { ["plugin"] = plugin, ["operation"] = operation, ["intervalSeconds"] = interval });
                }
            }
            collect = entries.ToArray();
            policyExpires = verified is null ? DateTimeOffset.MinValue : DateTimeOffset.FromUnixTimeSeconds(PluginProtocol.Integer(verified, "exp"));
            var now = clock(); var keys = entries.Select(Key).ToHashSet(StringComparer.Ordinal);
            foreach (var key in next.Keys.Where(key => !keys.Contains(key)).ToArray()) next.Remove(key);
            // The first run comes 60 seconds after the first valid policy.
            foreach (var key in keys) next.TryAdd(key, now + FirstCollection);
        }
    }
    private static string Key(JsonObject entry) => PluginProtocol.Text(entry, "plugin") + "/" + PluginProtocol.Text(entry, "operation");
    private void ScheduleAfterInstall(string name) { lock (policyGate) foreach (var entry in collect.Where(entry => PluginProtocol.Text(entry, "plugin") == name)) next[Key(entry)] = clock() + FirstCollection; }

    /// <summary>The entries that are due now under a valid policy; each gets its next time. Blocked runs are skipped, not queued.</summary>
    internal JsonObject[] Due(bool blocked)
    {
        lock (policyGate)
        {
            var now = clock();
            if (collect.Length == 0 || now > policyExpires) return [];
            var due = new List<JsonObject>();
            foreach (var entry in collect)
            {
                string key = Key(entry);
                if (!next.TryGetValue(key, out var at) || at > now) continue;
                next[key] = now + TimeSpan.FromSeconds(PluginProtocol.Integer(entry, "intervalSeconds"));
                if (!blocked && changing != PluginProtocol.Text(entry, "plugin") && !collecting.ContainsKey(key)) due.Add(entry);
            }
            return due.ToArray();
        }
    }

    /// <summary>
    /// Housekeeping: starts each due periodic read in the background. `blocked`
    /// is true while an agent update or uninstall is pending. A busy plugin
    /// skips the run; a failed run only logs.
    /// </summary>
    internal void Tick(bool blocked, Func<PluginUpload, CancellationToken, Task> upload, CancellationToken token)
    {
        foreach (var entry in Due(blocked))
        {
            string key = Key(entry), plugin = PluginProtocol.Text(entry, "plugin"), operation = PluginProtocol.Text(entry, "operation");
            var run = Task.Run(async () =>
            {
                try
                {
                    var result = await RunAsync(plugin, operation, new JsonObject(), Guid.NewGuid().ToString(), token, wait: false);
                    if (result.Data is JsonObject data) await upload(new PluginUpload(plugin, operation, null, clock().ToString("O", CultureInfo.InvariantCulture), data), token);
                    else if (!result.Ok) log("Plugin read " + key + ": " + result.Code);
                }
                catch (AgentMessageException e) when (e.Code == "AGENT_PLUGIN_BUSY") { }
                catch (Exception e) when (!token.IsCancellationRequested) { log("Plugin read " + key + ": " + (e is AgentMessageException coded ? coded.Code : e.Message)); }
                finally { collecting.TryRemove(key, out _); }
            }, CancellationToken.None);
            collecting[key] = run;
        }
    }

    internal async Task StopAsync() { try { await Task.WhenAll(collecting.Values.ToArray()); } catch { } }

    /// <summary>
    /// plugin-job: one operation for a verified job. The data go to the portal
    /// through the upload with the job id; the job result carries the plugin's
    /// code and arguments only. Since 4.17.0 (plugin-secrets) the sealed
    /// secretParameters of the job are opened with the device key (`unseal`) and
    /// go to the plugin as parameters.secrets; they are masked in the result, the
    /// message and the logged stderr. A box that does not open fails the job with
    /// AGENT_PLUGIN_SECRET_INVALID before the plugin starts. Since 4.19.0
    /// (plugin-ad-identity) a change runs as the job's actAs account; a read
    /// ignores actAs and runs as SYSTEM. A plugin's _ACCESS_DENIED code in a run
    /// with an account becomes AGENT_PLUGIN_ACCOUNT_DENIED with the account.
    /// Since 4.21.2 a plugin-job result always carries a code: a failed upload
    /// is AGENT_PLUGIN_UPLOAD_FAILED, any other uncoded failure
    /// AGENT_PLUGIN_FAILED; the exception text goes only to the agent log.
    /// </summary>
    internal async Task<JsonObject> RunJobAsync(JsonObject job, Func<PluginUpload, CancellationToken, Task> upload, CancellationToken token, Func<JsonObject, JsonObject>? unseal = null)
    {
        string[] secrets = []; string label = "";
        try { return await RunJobCoreAsync(job, upload, token, unseal, (name, masked) => { label = name; secrets = masked; }); }
        catch (Exception e) when (e is not AgentMessageException and not OperationCanceledException)
        {
            log("Plugin job " + label + ": " + SecretMask.Apply(e.Message, secrets));
            throw new AgentMessageException(e, "AGENT_PLUGIN_FAILED");
        }
    }

    private async Task<JsonObject> RunJobCoreAsync(JsonObject job, Func<PluginUpload, CancellationToken, Task> upload, CancellationToken token, Func<JsonObject, JsonObject>? unseal, Action<string, string[]> started)
    {
        string id = job["id"]!.GetValue<string>(); var p = job["parameters"] as JsonObject ?? new JsonObject();
        string plugin = PluginProtocol.Text(p, "plugin"), operation = PluginProtocol.Text(p, "operation");
        if (!PluginProtocol.IsCapability(operation)) throw new AgentMessageException("AGENT_PLUGIN_OPERATION_UNKNOWN");
        var actAs = ReadOperation(operation) ? null : PluginActAs.Read(p["actAs"]) ?? throw new AgentMessageException("AGENT_PLUGIN_ACCOUNT_REQUIRED");
        // A copy: the job's own node has a parent and cannot move into the plugin request.
        var parameters = (p["parameters"] as JsonObject)?.DeepClone().AsObject() ?? new JsonObject(); string[] secrets = [];
        if (p["secretParameters"] is JsonObject box)
        {
            JsonObject opened;
            try { opened = (unseal ?? throw new CryptographicException("No device key."))(box); }
            catch (Exception e) when (e is CryptographicException or FormatException or InvalidOperationException or NullReferenceException or System.Text.Json.JsonException or ArgumentException) { throw new AgentMessageException("AGENT_PLUGIN_SECRET_INVALID"); }
            var holder = new JsonObject(); foreach (var entry in opened) holder[entry.Key] = entry.Value?.DeepClone();
            parameters["secrets"] = holder;
            secrets = opened.Select(entry => entry.Value is JsonValue value && value.TryGetValue<string>(out var text) ? text : entry.Value?.ToJsonString() ?? "").Where(text => text.Length > 0).ToArray();
        }
        started(plugin + "/" + operation, secrets);
        var result = await RunAsync(plugin, operation, parameters, id, token, secrets: secrets, actAs: actAs);
        if (result.Data is JsonObject data)
        {
            // The plugin did its work; only the way to the portal failed. A cancellation of the job stays a cancellation.
            try { await upload(new PluginUpload(plugin, operation, id, clock().ToString("O", CultureInfo.InvariantCulture), data), token); }
            catch (Exception e) when (e is not OperationCanceledException || !token.IsCancellationRequested)
            {
                log("Plugin upload " + plugin + "/" + operation + ": " + SecretMask.Apply(e.Message, secrets));
                throw new AgentMessageException(e, "AGENT_PLUGIN_UPLOAD_FAILED");
            }
        }
        if (actAs is not null && PluginIdentity.AccessDenied(result.Code)) return AgentMessages.Write(new JsonObject { ["id"] = id, ["ok"] = false }, "AGENT_PLUGIN_ACCOUNT_DENIED", ("account", actAs.Account));
        var args = result.Args.ToDictionary(pair => pair.Key, pair => SecretMask.Apply(pair.Value, secrets), StringComparer.Ordinal);
        return AgentMessages.WritePlugin(new JsonObject { ["id"] = id, ["ok"] = result.Ok }, result.Code, args, SecretMask.Apply(result.Message, secrets));
    }

    /// <summary>
    /// The read operations: they run in ReadOnly mode, as SYSTEM, and the signed
    /// policy may start them periodically. An explicit list, never a pattern:
    /// dhcp-read, and since 4.20.0 dns-read and dns-zone-read. Any other
    /// operation needs Management and an account.
    /// </summary>
    internal static bool ReadOperation(string? operation) => operation is "dhcp-read" or "dns-read" or "dns-zone-read";
}

