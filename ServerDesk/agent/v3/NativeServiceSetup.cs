using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using Microsoft.Win32;

namespace ServerDesk.Agent;

// The two service names. The installed names are ServerDeskAgent and
// ServerDeskWorker; the lifecycle self-test (ServiceLifecycleTests.cs) runs the
// same setup code with test names.
internal sealed record AgentServiceNames(string Broker, string Worker)
{
    internal static readonly AgentServiceNames Installed = new(BrokerProtocol.BrokerService, BrokerProtocol.WorkerService);
    internal string WorkerSid => BrokerProtocol.ServiceSid(Worker);
}

// Service installation uses the Service Control Manager directly. No shell or
// service-management command is executed with the registration credentials.
internal static class NativeServiceSetup
{
    // A per-service SID identifies each service independently of its logon
    // account. The SYSTEM broker keeps UNRESTRICTED for its management
    // actions. The worker runs as its own virtual account, also UNRESTRICTED:
    // with a RESTRICTED (write-restricted) token Schannel cannot acquire client
    // credentials (SEC_E_NO_CREDENTIALS) and every HTTPS call to the portal fails.
    internal const uint ServiceSidType = 1, WorkerSidType = 1;
    // Every other default service privilege, notably SeImpersonate and
    // SeCreateGlobal, is removed from the worker's token.
    internal const string WorkerPrivileges = "SeChangeNotifyPrivilege";
    // Local groups that grant read-only telemetry without administrator rights.
    internal static readonly string[] WorkerGroups = ["S-1-5-32-558", "S-1-5-32-573"];
    // Repair both owner and DACL: an untrusted owner could otherwise replace a
    // secure DACL through the owner's implicit WRITE_DAC access. Administrators
    // and SYSTEM retain all service controls, updates and local recovery. Other
    // authenticated users can inspect/monitor, but cannot mutate or stop it.
    // No entry denies Administrators: a local administrator can always change
    // the start type, stop and delete both services (docs/native-agent-v4.md,
    // "Remove the agent by hand").
    internal const string SecurityDescriptor = "O:BAD:P(A;;0xF01FF;;;SY)(A;;0xF01FF;;;BA)(A;;0x2008D;;;AU)";
    // The failure actions of both services, one shared set (4.18.0): restart
    // after 5 s, then 30 s, then 60 s; the failure count resets after one day;
    // they also apply when ServiceHost stops a service with an error exit code.
    internal static readonly uint[] RecoveryDelaysMs = [5000, 30000, 60000]; internal const uint RecoveryResetSeconds = 86400; internal const bool RecoveryOnNonCrashFailures = true;
    private const int ScActionRestart = 1;
    private const uint ServiceAllAccess = 0xF01FF;
    private const uint ServiceQueryConfig = 0x0001, ServiceChangeConfig = 0x0002, ServiceStart = 0x0010;
    private const uint ReadControl = 0x20000, WriteDacl = 0x40000, WriteOwner = 0x80000;
    // SERVICE_START: the Service Control Manager refuses SC_ACTION_RESTART
    // failure actions on a handle without it (ERROR_ACCESS_DENIED).
    internal const uint SecurityPolicyAccess = ServiceQueryConfig | ServiceChangeConfig | ServiceStart | ReadControl | WriteDacl | WriteOwner;
    // The integrity check only reads.
    internal const uint InspectAccess = ServiceQueryConfig | ReadControl;
    private const uint OwnerAndDaclInformation = 0x0005, ServiceSidConfigLevel = 5, FailureActionsLevel = 2, FailureActionsFlagLevel = 4, DelayedStartLevel = 3;
    [StructLayout(LayoutKind.Sequential)] private struct Status { public int Type, State, Controls, Win32Exit, SpecificExit, Checkpoint, WaitHint; }
    [StructLayout(LayoutKind.Sequential)] private struct Description { public IntPtr Text; }
    [StructLayout(LayoutKind.Sequential)] private struct FailureAction { public int Type; public uint Delay; }
    [StructLayout(LayoutKind.Sequential)] private struct FailureActions { public uint ResetPeriod; public IntPtr RebootMessage, Command; public uint Count; public IntPtr Actions; }
    [StructLayout(LayoutKind.Sequential)] private struct DelayedStart { [MarshalAs(UnmanagedType.Bool)] public bool Enabled; }
    [StructLayout(LayoutKind.Sequential)] private struct FailureActionsFlag { [MarshalAs(UnmanagedType.Bool)] public bool OnNonCrashFailures; }
    [StructLayout(LayoutKind.Sequential)] private struct ServiceSid { public uint Type; }
    [StructLayout(LayoutKind.Sequential)] private struct RequiredPrivileges { public IntPtr Names; }
    [StructLayout(LayoutKind.Sequential)] private struct GroupMember { public IntPtr Sid; }
    [StructLayout(LayoutKind.Sequential)] private struct ServiceConfig { public uint Type, StartType, ErrorControl; public IntPtr Binary, Group; public uint Tag; public IntPtr Dependencies, Account, Display; }
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern int NetLocalGroupAddMembers(string? server, string group, int level, ref GroupMember members, int count);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern int NetLocalGroupDelMembers(string? server, string group, int level, ref GroupMember members, int count);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenSCManagerW(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateServiceW(IntPtr manager, string name, string display, uint access, uint type, uint start, uint error, string path, string? group, IntPtr tag, string? dependencies, string? account, string? password);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ChangeServiceConfigW(IntPtr service, uint type, uint start, uint error, string? path, string? group, IntPtr tag, string? dependencies, string? account, string? password, string? display);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ChangeServiceConfig2W(IntPtr service, uint level, IntPtr data);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryServiceConfigW(IntPtr service, IntPtr config, uint size, out uint needed);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatus(IntPtr service, out Status status);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DeleteService(IntPtr service);
    [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr handle);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string descriptor, uint revision, out IntPtr security, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetServiceObjectSecurity(IntPtr service, uint information, IntPtr security);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceObjectSecurity(IntPtr service, uint information, IntPtr security, uint size, out uint needed);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryServiceConfig2W(IntPtr service, uint level, IntPtr data, uint size, out uint needed);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    private static IntPtr Manager(uint access = 1) { IntPtr manager = OpenSCManagerW(null, null, access); if (manager == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error()); return manager; }
    internal static bool Exists() => Exists(BrokerProtocol.BrokerService);
    internal static bool Exists(string name)
    {
        IntPtr manager = Manager();
        try { IntPtr service = OpenServiceW(manager, name, 4); if (service == IntPtr.Zero) { int error = Marshal.GetLastWin32Error(); if (error == 1060) return false; throw new Win32Exception(error); } CloseServiceHandle(service); return true; }
        finally { CloseServiceHandle(manager); }
    }
    internal static bool Running()
    {
        IntPtr manager = Manager();
        try { IntPtr service = OpenServiceW(manager, BrokerProtocol.BrokerService, 4); if (service == IntPtr.Zero) { int error = Marshal.GetLastWin32Error(); if (error == 1060) return false; throw new Win32Exception(error); } try { if (!QueryServiceStatus(service, out var status)) throw new Win32Exception(Marshal.GetLastWin32Error()); return status.State != 1; } finally { CloseServiceHandle(service); } }
        finally { CloseServiceHandle(manager); }
    }
    // Installs or repairs both services: the SYSTEM broker and the worker,
    // which depends on the broker and runs as NT SERVICE\ServerDeskWorker.
    internal static void Configure(string executable)
    {
        string root = Directory.GetParent(Path.GetDirectoryName(executable)!)!.FullName;
        Configure(AgentServiceNames.Installed, "\"" + executable + "\" --broker", "\"" + executable + "\" --worker", root);
    }
    internal static void Configure(AgentServiceNames names, string brokerCommand, string workerCommand, string root)
    {
        ConfigureService(names, names.Broker, "ServerDesk Agent", brokerCommand, "LocalSystem", null, "ServerDesk privileged broker: verifies portal-signed work and changes the host", Path.Combine(root, "runtime"));
        ConfigureService(names, names.Worker, "ServerDesk Agent Worker", workerCommand, "NT SERVICE\\" + names.Worker, names.Broker + "\0", "ServerDesk unprivileged worker: portal connection and telemetry", Path.Combine(BrokerProtocol.WorkerRoot(root), "runtime"));
        ChangeGroups(names, add: true);
    }
    private static void ConfigureService(AgentServiceNames names, string name, string display, string binary, string account, string? dependencies, string description, string extraction)
    {
        if (names != AgentServiceNames.Installed) display += " (self-test)";
        IntPtr manager = Manager(3), service = IntPtr.Zero;
        try
        {
            service = OpenServiceW(manager, name, ServiceAllAccess);
            if (service == IntPtr.Zero)
            {
                if (Marshal.GetLastWin32Error() != 1060) throw new Win32Exception(Marshal.GetLastWin32Error());
                service = CreateServiceW(manager, name, display, ServiceAllAccess, 0x10, 2, 1, binary, null, IntPtr.Zero, dependencies, account, null);
                if (service == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            else if (!ChangeServiceConfigW(service, 0x10, 2, 1, binary, null, IntPtr.Zero, dependencies ?? "", account, null, display)) throw new Win32Exception(Marshal.GetLastWin32Error());
            using (var registration = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\" + name, true) ?? throw new IOException("Service registry configuration is missing."))
            {
                string[] existing = registration.GetValue("Environment") as string[] ?? [];
                registration.SetValue("Environment", existing.Where(entry => !entry.StartsWith("DOTNET_BUNDLE_EXTRACT_BASE_DIR=", StringComparison.OrdinalIgnoreCase)).Append("DOTNET_BUNDLE_EXTRACT_BASE_DIR=" + extraction).ToArray(), RegistryValueKind.MultiString);
            }
            IntPtr text = Marshal.StringToHGlobalUni(description);
            try { SetConfig(service, 1, new Description { Text = text }); } finally { Marshal.FreeHGlobal(text); }
            SetConfig(service, DelayedStartLevel, new DelayedStart { Enabled = true });
            // DACL, SID, worker privileges and failure actions, each read back:
            // a difference throws, and the installer rolls back.
            ApplySecurityPolicy(service, name, names);
        }
        finally { if (service != IntPtr.Zero) CloseServiceHandle(service); CloseServiceHandle(manager); }
    }
    // Ordinary automatic updates switch the executable without reinstalling
    // the service. Reapply the same policy at service start so those devices
    // receive the repair too, the failure actions included. This changes
    // neither logon account nor privileges.
    internal static void ApplySecurityPolicy() => ApplySecurityPolicy(AgentServiceNames.Installed);
    internal static void ApplySecurityPolicy(AgentServiceNames names)
    {
        foreach (string name in new[] { names.Broker, names.Worker })
        {
            IntPtr manager = Manager(), service = IntPtr.Zero;
            try
            {
                service = OpenServiceW(manager, name, SecurityPolicyAccess);
                if (service == IntPtr.Zero) { int error = Marshal.GetLastWin32Error(); if (error == 1060 && name == names.Worker) continue; throw new Win32Exception(error); }
                ApplySecurityPolicy(service, name, names);
            }
            finally { if (service != IntPtr.Zero) CloseServiceHandle(service); CloseServiceHandle(manager); }
        }
    }
    private static void ApplySecurityPolicy(IntPtr service, string name, AgentServiceNames names)
    {
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(SecurityDescriptor, 1, out IntPtr security, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            // OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION; leave
            // operator-configured audit/SACL policy intact.
            // SetServiceObjectSecurity supports these component flags only;
            // unlike SetSecurityInfo, it ignores unsupported protection flags.
            // Verify persisted owner/ACEs below rather than assume SDDL's P
            // control bit was honored by the SCM setter.
            if (!SetServiceObjectSecurity(service, OwnerAndDaclInformation, security)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { LocalFree(security); }
        uint sidType = name == names.Worker ? WorkerSidType : ServiceSidType;
        SetConfig(service, ServiceSidConfigLevel, new ServiceSid { Type = sidType });
        if (name == names.Worker)
        {
            IntPtr privileges = Marshal.StringToHGlobalUni(WorkerPrivileges + "\0");
            try { SetConfig(service, 6, new RequiredPrivileges { Names = privileges }); } finally { Marshal.FreeHGlobal(privileges); }
        }
        ApplyRecovery(service);
        VerifyAppliedSecurityPolicy(service, sidType);
    }
    // The failure actions of RecoveryDelaysMs, on a handle with SERVICE_START.
    private static void ApplyRecovery(IntPtr service)
    {
        SetConfig(service, FailureActionsFlagLevel, new FailureActionsFlag { OnNonCrashFailures = RecoveryOnNonCrashFailures });
        int length = Marshal.SizeOf<FailureAction>(); IntPtr actions = Marshal.AllocHGlobal(length * RecoveryDelaysMs.Length);
        try
        {
            for (int i = 0; i < RecoveryDelaysMs.Length; i++) Marshal.StructureToPtr(new FailureAction { Type = ScActionRestart, Delay = RecoveryDelaysMs[i] }, actions + i * length, false);
            SetConfig(service, FailureActionsLevel, new FailureActions { ResetPeriod = RecoveryResetSeconds, Count = (uint)RecoveryDelaysMs.Length, Actions = actions });
        }
        finally { Marshal.FreeHGlobal(actions); }
    }
    private static void VerifyAppliedSecurityPolicy(IntPtr service, uint sidType)
    {
        // Validate the persisted descriptor, not merely the SDDL we intended to
        // apply. Service objects have no inheritable child ACLs; exact owner and
        // non-inherited access entries are the relevant access-control boundary.
        ValidateSecurityDescriptor(ReadDescriptor(service));
        if (ReadSidType(service) != sidType) throw new IOException("The per-service SID policy did not persist.");
        // SERVICE_CONFIG_FAILURE_ACTIONS and SERVICE_CONFIG_FAILURE_ACTIONS_FLAG as the Service Control Manager stored them.
        var (reset, actions, flag) = ReadRecovery(service);
        if (RecoveryDifference(reset, actions, flag) is string difference) throw new IOException("The service recovery differs from the trusted policy (" + difference + ").");
    }
    private static RawSecurityDescriptor ReadDescriptor(IntPtr service)
    {
        if (QueryServiceObjectSecurity(service, OwnerAndDaclInformation, IntPtr.Zero, 0, out uint needed) || Marshal.GetLastWin32Error() != 122 || needed is < 20 or > 8192) throw new IOException("The service security descriptor size could not be determined.");
        IntPtr descriptor = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!QueryServiceObjectSecurity(service, OwnerAndDaclInformation, descriptor, needed, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
            byte[] bytes = new byte[needed]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            return new RawSecurityDescriptor(bytes, 0);
        }
        finally { Marshal.FreeHGlobal(descriptor); }
    }
    private static uint ReadSidType(IntPtr service)
    {
        uint size = (uint)Marshal.SizeOf<ServiceSid>(); IntPtr sid = Marshal.AllocHGlobal((int)size);
        try
        {
            if (!QueryServiceConfig2W(service, ServiceSidConfigLevel, sid, size, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return Marshal.PtrToStructure<ServiceSid>(sid).Type;
        }
        finally { Marshal.FreeHGlobal(sid); }
    }
    // A variable-size configuration: the size query first, at most 8 KiB.
    private delegate bool Query(IntPtr buffer, uint size, out uint needed);
    private static T ReadVariable<T>(Query query, Func<IntPtr, T> parse)
    {
        if (query(IntPtr.Zero, 0, out uint needed) || Marshal.GetLastWin32Error() != 122 || needed is 0 or > 8192) throw new IOException("The service configuration size could not be determined.");
        IntPtr buffer = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!query(buffer, needed, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return parse(buffer);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    private static (uint Reset, (int Type, uint Delay)[] Actions, bool Flag) ReadRecovery(IntPtr service)
    {
        var (reset, actions) = ReadVariable((IntPtr buffer, uint size, out uint needed) => QueryServiceConfig2W(service, FailureActionsLevel, buffer, size, out needed), buffer =>
        {
            var value = Marshal.PtrToStructure<FailureActions>(buffer); int length = Marshal.SizeOf<FailureAction>();
            var list = new (int Type, uint Delay)[value.Actions == IntPtr.Zero ? 0 : Math.Min(value.Count, 16)];
            for (int i = 0; i < list.Length; i++) { var action = Marshal.PtrToStructure<FailureAction>(value.Actions + i * length); list[i] = (action.Type, action.Delay); }
            return (value.ResetPeriod, list);
        });
        uint size = (uint)Marshal.SizeOf<FailureActionsFlag>(); IntPtr flag = Marshal.AllocHGlobal((int)size);
        try
        {
            if (!QueryServiceConfig2W(service, FailureActionsFlagLevel, flag, size, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return (reset, actions, Marshal.PtrToStructure<FailureActionsFlag>(flag).OnNonCrashFailures);
        }
        finally { Marshal.FreeHGlobal(flag); }
    }
    /// <summary>
    /// Null when the failure actions as read match the shared set, otherwise
    /// the first difference: "count N", "type I T", "delay I MS", "reset S" or
    /// "flag false". Pure, so the installer self-test covers every case.
    /// </summary>
    internal static string? RecoveryDifference(uint reset, IReadOnlyList<(int Type, uint Delay)> actions, bool flag)
    {
        if (actions.Count != RecoveryDelaysMs.Length) return "count " + actions.Count;
        for (int i = 0; i < actions.Count; i++)
        {
            if (actions[i].Type != ScActionRestart) return "type " + i + " " + actions[i].Type;
            if (actions[i].Delay != RecoveryDelaysMs[i]) return "delay " + i + " " + actions[i].Delay;
        }
        if (reset != RecoveryResetSeconds) return "reset " + reset;
        if (flag != RecoveryOnNonCrashFailures) return "flag " + (flag ? "true" : "false");
        return null;
    }
    internal static void ValidateSecurityDescriptor(RawSecurityDescriptor descriptor)
    {
        if (DescriptorFinding(descriptor) is string finding) throw new IOException("The service owner or DACL differs from the trusted policy (" + finding + ").");
    }
    /// <summary>
    /// Null when owner and DACL match SecurityDescriptor, otherwise a short
    /// technical finding: "owner SID", "ace-count N", "ace-type SID", "ace SID",
    /// "access SID 0x…" or "missing SID". Pure.
    /// </summary>
    internal static string? DescriptorFinding(RawSecurityDescriptor descriptor)
    {
        if (descriptor.Owner?.Value != "S-1-5-32-544") return "owner " + (descriptor.Owner?.Value ?? "none");
        if (descriptor.DiscretionaryAcl is null || descriptor.DiscretionaryAcl.Count != 3) return "ace-count " + (descriptor.DiscretionaryAcl?.Count ?? 0);
        var expected = new Dictionary<string, int> { ["S-1-5-18"] = 0xF01FF, ["S-1-5-32-544"] = 0xF01FF, ["S-1-5-11"] = 0x2008D };
        foreach (GenericAce entry in descriptor.DiscretionaryAcl)
        {
            if (entry is not CommonAce ace) return "ace-type " + entry.AceType;
            string sid = ace.SecurityIdentifier.Value;
            if (ace.AceQualifier != AceQualifier.AccessAllowed || ace.AceFlags != AceFlags.None) return "ace-type " + sid;
            if (!expected.Remove(sid, out int access)) return "ace " + sid;
            if (ace.AccessMask != access) return "access " + sid + " 0x" + ace.AccessMask.ToString("X", System.Globalization.CultureInfo.InvariantCulture);
        }
        return expected.Count != 0 ? "missing " + expected.Keys.First() : null;
    }
    /// <summary>One service as the integrity check reads it: whether it exists, its start type, and per protection target a finding (null: as installed).</summary>
    internal sealed record ServiceInspection(string Name, bool Exists, string StartType, string? Dacl, string? Sid, string? Recovery);
    /// <summary>Reads, never changes: the start type, the DACL and owner, the SID type and the failure actions.</summary>
    internal static ServiceInspection Inspect(string name, bool worker)
    {
        IntPtr manager = Manager(), service = IntPtr.Zero;
        try
        {
            service = OpenServiceW(manager, name, InspectAccess);
            if (service == IntPtr.Zero) { int error = Marshal.GetLastWin32Error(); if (error == 1060) return new ServiceInspection(name, false, "unknown", null, null, null); throw new Win32Exception(error); }
            string startType = "unknown";
            try
            {
                uint start = ReadVariable((IntPtr buffer, uint size, out uint needed) => QueryServiceConfigW(service, buffer, size, out needed), buffer => Marshal.PtrToStructure<ServiceConfig>(buffer).StartType);
                bool delayed = false;
                if (start == 2)
                {
                    uint size = (uint)Marshal.SizeOf<DelayedStart>(); IntPtr data = Marshal.AllocHGlobal((int)size);
                    try { delayed = QueryServiceConfig2W(service, DelayedStartLevel, data, size, out _) && Marshal.PtrToStructure<DelayedStart>(data).Enabled; } finally { Marshal.FreeHGlobal(data); }
                }
                startType = StartTypeName(start, delayed);
            }
            catch (Exception e) when (e is Win32Exception or IOException) { }
            string? Read(Func<string?> check) { try { return check(); } catch (Exception e) when (e is Win32Exception or IOException or ArgumentException) { return "unreadable"; } }
            string? dacl = Read(() => DescriptorFinding(ReadDescriptor(service)));
            uint expectedSid = worker ? WorkerSidType : ServiceSidType;
            string? sid = Read(() => { uint type = ReadSidType(service); return type == expectedSid ? null : "sid-type " + type; });
            string? recovery = Read(() => { var (reset, actions, flag) = ReadRecovery(service); return RecoveryDifference(reset, actions, flag); });
            return new ServiceInspection(name, true, startType, dacl, sid, recovery);
        }
        finally { if (service != IntPtr.Zero) CloseServiceHandle(service); CloseServiceHandle(manager); }
    }
    /// <summary>SERVICE_AUTO_START (2) with or without the delayed flag, SERVICE_DEMAND_START (3) and SERVICE_DISABLED (4); anything else is unknown.</summary>
    internal static string StartTypeName(uint start, bool delayed) => start switch { 2 => delayed ? "delayed-auto" : "auto", 3 => "manual", 4 => "disabled", _ => "unknown" };
    private static void SetConfig<T>(IntPtr service, uint level, T data) where T : struct
    {
        IntPtr pointer = Marshal.AllocHGlobal(Marshal.SizeOf<T>());
        try { Marshal.StructureToPtr(data, pointer, false); if (!ChangeServiceConfig2W(service, level, pointer)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        finally { Marshal.FreeHGlobal(pointer); }
    }
    private static void ChangeGroups(AgentServiceNames names, bool add)
    {
        var workerSid = new System.Security.Principal.SecurityIdentifier(names.WorkerSid);
        byte[] sid = new byte[workerSid.BinaryLength];
        workerSid.GetBinaryForm(sid, 0);
        IntPtr pointer = Marshal.AllocHGlobal(sid.Length);
        try
        {
            Marshal.Copy(sid, 0, pointer, sid.Length);
            foreach (string group in WorkerGroups)
            {
                // Group names are localized; resolve them from their well-known SIDs.
                string account = new System.Security.Principal.SecurityIdentifier(group).Translate(typeof(System.Security.Principal.NTAccount)).Value;
                string name = account[(account.IndexOf('\\') + 1)..];
                var member = new GroupMember { Sid = pointer };
                int status = add ? NetLocalGroupAddMembers(null, name, 0, ref member, 1) : NetLocalGroupDelMembers(null, name, 0, ref member, 1);
                if (status != 0 && status != (add ? 1378 : 1377)) throw new Win32Exception(status, "Cannot " + (add ? "add the worker to " : "remove the worker from ") + name);
            }
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }
    internal static void Delete() => Delete(AgentServiceNames.Installed);
    internal static void Delete(AgentServiceNames names)
    {
        try { ChangeGroups(names, add: false); } catch (Exception) { /* The virtual account disappears with its service. */ }
        RemoveService(names.Worker); RemoveService(names.Broker);
    }
    private static void RemoveService(string name)
    {
        IntPtr manager = Manager();
        try { IntPtr service = OpenServiceW(manager, name, 0x10000); if (service == IntPtr.Zero) { int error = Marshal.GetLastWin32Error(); if (error == 1060) return; throw new Win32Exception(error); } try { if (!DeleteService(service)) throw new Win32Exception(Marshal.GetLastWin32Error()); } finally { CloseServiceHandle(service); } }
        finally { CloseServiceHandle(manager); }
    }
}
