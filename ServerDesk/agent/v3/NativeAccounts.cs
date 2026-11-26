using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class NativeAccounts
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct User1 { [MarshalAs(UnmanagedType.LPWStr)] internal string Name; internal IntPtr Password; internal uint PasswordAge, Privilege; [MarshalAs(UnmanagedType.LPWStr)] internal string? HomeDirectory, Comment; internal uint Flags; [MarshalAs(UnmanagedType.LPWStr)] internal string? ScriptPath; }
    [StructLayout(LayoutKind.Sequential)] private struct User23 { internal IntPtr Name, FullName, Comment; internal uint Flags; internal IntPtr Sid; }
    [StructLayout(LayoutKind.Sequential)] private struct Luid { internal uint Low; internal int High; }
    [StructLayout(LayoutKind.Sequential)] private struct TokenPrivilege { internal uint Count; internal Luid Luid; internal uint Attributes; }
    private record User(string Name, string Sid, uint Flags);
    private static readonly object MembershipGate = new();
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetUserGetInfo(string? server, string user, uint level, out IntPtr buffer);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetUserEnum(string? server, uint level, uint filter, out IntPtr buffer, uint preferred, out uint read, out uint total, ref uint resume);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetUserAdd(string? server, uint level, ref User1 user, out uint parameter);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetUserSetInfo(string? server, string user, uint level, IntPtr buffer, out uint parameter);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetUserDel(string? server, string user);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetLocalGroupGetInfo(string? server, string group, uint level, out IntPtr buffer);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetLocalGroupGetMembers(string? server, string group, uint level, out IntPtr buffer, uint preferred, out uint read, out uint total, ref UIntPtr resume);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetLocalGroupAddMembers(string? server, string group, uint level, IntPtr buffer, uint count);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetLocalGroupDelMembers(string? server, string group, uint level, IntPtr buffer, uint count);
    [DllImport("netapi32.dll")] private static extern uint NetApiBufferFree(IntPtr buffer);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool LookupAccountSid(string? system, byte[] sid, StringBuilder name, ref uint nameSize, StringBuilder domain, ref uint domainSize, out int use);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetJoinDomain(string? server, string domain, string? ou, string? account, string? password, uint options);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetUnjoinDomain(string? server, string account, string password, uint options);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetRenameMachineInDomain(string? server, string name, string? account, string? password, uint options);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool SetComputerNameEx(int type, string name);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr value);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool LookupPrivilegeValue(string? system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivilege state, uint size, IntPtr previous, IntPtr length);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool InitiateSystemShutdownEx(string? machine, string message, uint seconds, [MarshalAs(UnmanagedType.Bool)] bool force, [MarshalAs(UnmanagedType.Bool)] bool reboot, uint reason);

    internal static AgentMessage Execute(string action, JsonObject p, JsonObject secrets)
    {
        NativeManagement.ValidateParameters(action, p); NativeManagement.AssertNotDomainController();
        lock (MembershipGate)
        {
            string name = NativeManagement.Text(p, "name", 20);
            if (action == "create-local-user")
            {
                string password = NativeManagement.Text(secrets, "password", 127); IntPtr secret = Marshal.StringToCoTaskMemUni(password);
                try
                {
                    var user = new User1 { Name = name, Password = secret, Privilege = 1, Comment = NativeManagement.OptionalText(p, "description", 48) ?? "", Flags = 0x201U | (NativeManagement.Boolean(p, "passwordNeverExpires") ? 0x10000U : 0U) };
                    Check(NetUserAdd(null, 1, ref user, out uint parameter), "AGENT_USER_CREATE_FAILED", parameter);
                    SetString(name, 1011, NativeManagement.OptionalText(p, "fullName", 256) ?? "");
                }
                finally { Marshal.ZeroFreeCoTaskMemUnicode(secret); }
                return AgentMessages.Of("AGENT_USER_CREATED");
            }
            User existing = GetUser(name);
            switch (action)
            {
                case "set-local-user":
                    bool enabled = NativeManagement.Boolean(p, "enabled"); if (!enabled) AssertAdminSurvives(existing);
                    uint flags = existing.Flags; flags = enabled ? flags & ~2U : flags | 2U; flags = NativeManagement.Boolean(p, "passwordNeverExpires") ? flags | 0x10000U : flags & ~0x10000U;
                    SetString(name, 1011, NativeManagement.OptionalText(p, "fullName", 256) ?? ""); SetString(name, 1007, NativeManagement.OptionalText(p, "description", 48) ?? ""); SetFlags(name, flags);
                    return AgentMessages.Of("AGENT_USER_UPDATED");
                case "reset-local-password": SetString(name, 1003, NativeManagement.Text(secrets, "password", 127), secret: true); return AgentMessages.Of("AGENT_PASSWORD_CHANGED");
                case "delete-local-user":
                    if (existing.Sid.EndsWith("-500", StringComparison.Ordinal) || existing.Sid.EndsWith("-501", StringComparison.Ordinal)) throw new AgentMessageException("AGENT_USER_BUILTIN_PROTECTED");
                    AssertAdminSurvives(existing); Check(NetUserDel(null, name), "AGENT_USER_DELETE_FAILED"); return AgentMessages.Of("AGENT_USER_DELETED");
                case "local-group-add": case "local-group-remove":
                    string sid = NativeManagement.Text(p, "groupSid", 184), group = LocalGroupName(sid);
                    if (action == "local-group-remove" && sid == "S-1-5-32-544") AssertAdminSurvives(existing);
                    var userSid = new SecurityIdentifier(existing.Sid); byte[] bytes = new byte[userSid.BinaryLength]; userSid.GetBinaryForm(bytes, 0); IntPtr sidMemory = Marshal.AllocHGlobal(bytes.Length), member = Marshal.AllocHGlobal(IntPtr.Size);
                    try { Marshal.Copy(bytes, 0, sidMemory, bytes.Length); Marshal.WriteIntPtr(member, sidMemory); Check(action == "local-group-add" ? NetLocalGroupAddMembers(null, group, 0, member, 1) : NetLocalGroupDelMembers(null, group, 0, member, 1), "AGENT_GROUP_MEMBERSHIP_FAILED"); }
                    finally { Marshal.FreeHGlobal(member); Marshal.FreeHGlobal(sidMemory); }
                    return AgentMessages.Of("AGENT_GROUP_MEMBERSHIP_CHANGED");
                default: throw new AgentMessageException("AGENT_UNKNOWN_USER_ACTION");
            }
        }
    }
    private static User GetUser(string name)
    {
        NativeManagement.ValidateUsername(name); Check(NetUserGetInfo(null, name, 23, out IntPtr buffer), "AGENT_USER_READ_FAILED");
        try { var user = Marshal.PtrToStructure<User23>(buffer); string exact = Marshal.PtrToStringUni(user.Name) ?? ""; if (!exact.Equals(name, StringComparison.OrdinalIgnoreCase)) throw new AgentMessageException("AGENT_USERNAME_AMBIGUOUS"); return new User(exact, new SecurityIdentifier(user.Sid).Value, user.Flags); }
        finally { NetApiBufferFree(buffer); }
    }
    private static List<string> EnabledUsers()
    {
        var names = new List<string>(); uint resume = 0, status;
        do
        {
            status = NetUserEnum(null, 1, 2, out IntPtr memory, 65536, out uint read, out _, ref resume); if (status is not 0 and not 234) Check(status, "AGENT_USERS_READ_FAILED");
            try { int size = Marshal.SizeOf<User1>(); for (int i = 0; i < read; i++) { var user = Marshal.PtrToStructure<User1>(memory + i * size); if ((user.Flags & 2) == 0) names.Add(user.Name); } }
            finally { if (memory != IntPtr.Zero) NetApiBufferFree(memory); }
            if (names.Count > 10000) throw new AgentMessageException("AGENT_USER_INVENTORY_TOO_LARGE");
        } while (status == 234);
        return names;
    }
    internal static HashSet<string> GroupMembers(string group)
    {
        var members = new HashSet<string>(StringComparer.OrdinalIgnoreCase); UIntPtr resume = UIntPtr.Zero; uint status;
        do
        {
            status = NetLocalGroupGetMembers(null, group, 0, out IntPtr memory, 65536, out uint read, out _, ref resume); if (status is not 0 and not 234) Check(status, "AGENT_ADMINS_READ_FAILED");
            try { for (int i = 0; i < read; i++) members.Add(new SecurityIdentifier(Marshal.ReadIntPtr(memory + i * IntPtr.Size)).Value); }
            finally { if (memory != IntPtr.Zero) NetApiBufferFree(memory); }
            if (members.Count > 10000) throw new AgentMessageException("AGENT_GROUP_INVENTORY_TOO_LARGE");
        } while (status == 234);
        return members;
    }
    private static void AssertAdminSurvives(User user)
    {
        var administrators = GroupMembers(LocalGroupName("S-1-5-32-544")); if (!administrators.Contains(user.Sid)) return;
        if (!EnabledUsers().Any(name => !name.Equals(user.Name, StringComparison.OrdinalIgnoreCase) && administrators.Contains(GetUser(name).Sid))) throw new AgentMessageException("AGENT_LAST_ADMIN");
    }
    internal static string LocalGroupName(string value)
    {
        var sid = new SecurityIdentifier(value); byte[] bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0); uint names = 256, domains = 256; var name = new StringBuilder(256); var domain = new StringBuilder(256);
        if (!LookupAccountSid(null, bytes, name, ref names, domain, ref domains, out int use)) throw new AgentMessageException(new Win32Exception(Marshal.GetLastWin32Error()), "AGENT_LOCAL_GROUP_NOT_FOUND");
        if (use != 4 || !(value.StartsWith("S-1-5-32-", StringComparison.Ordinal) || domain.ToString().Equals(Environment.MachineName, StringComparison.OrdinalIgnoreCase))) throw new AgentMessageException("AGENT_LOCAL_GROUP_ONLY");
        Check(NetLocalGroupGetInfo(null, name.ToString(), 1, out IntPtr buffer), "AGENT_GROUP_CHECK_FAILED"); NetApiBufferFree(buffer); return name.ToString();
    }
    private static void SetString(string name, uint level, string value, bool secret = false)
    {
        IntPtr text = Marshal.StringToCoTaskMemUni(value), input = Marshal.AllocHGlobal(IntPtr.Size);
        try { Marshal.WriteIntPtr(input, text); Check(NetUserSetInfo(null, name, level, input, out uint parameter), "AGENT_USER_UPDATE_FAILED", parameter); }
        finally { Marshal.FreeHGlobal(input); if (secret) Marshal.ZeroFreeCoTaskMemUnicode(text); else Marshal.FreeCoTaskMem(text); }
    }
    private static void SetFlags(string name, uint flags)
    {
        IntPtr input = Marshal.AllocHGlobal(sizeof(uint)); try { Marshal.WriteInt32(input, unchecked((int)flags)); Check(NetUserSetInfo(null, name, 1008, input, out uint parameter), "AGENT_ACCOUNT_STATUS_FAILED", parameter); } finally { Marshal.FreeHGlobal(input); }
    }
    internal static void ChangeComputer(string action, JsonObject p, JsonObject secrets)
    {
        NativeManagement.ValidateParameters(action, p); NativeManagement.AssertNotDomainController(); var computer = NativeManagement.Computer(); bool joined = Convert.ToBoolean(computer["PartOfDomain"]);
        lock (MembershipGate)
        {
            if (action == "join-domain")
            {
                string domain = NativeManagement.Text(p, "domain", 253);
                if (joined && !domain.Equals(Convert.ToString(computer["Domain"]), StringComparison.OrdinalIgnoreCase)) throw new AgentMessageException("AGENT_DOMAIN_LEAVE_FIRST");
                Check(NetJoinDomain(null, domain, NativeManagement.OptionalText(p, "ouPath", 1000), NativeManagement.Text(secrets, "username", 256), NativeManagement.Text(secrets, "password", 256), 3), "AGENT_DOMAIN_JOIN_FAILED");
            }
            else if (action == "leave-domain")
            {
                if (!joined) throw new AgentMessageException("AGENT_NOT_DOMAIN_MEMBER");
                Check(NetUnjoinDomain(null, NativeManagement.Text(secrets, "username", 256), NativeManagement.Text(secrets, "password", 256), 4), "AGENT_DOMAIN_LEAVE_FAILED");
                try { Check(NetJoinDomain(null, NativeManagement.Text(p, "workgroup", 15), null, null, null, 0), "AGENT_WORKGROUP_SET_FAILED"); }
                catch (Exception e) { throw new AgentMessageException(e, "AGENT_WORKGROUP_FAILED", ("detail", e.Message)); }
            }
            else if (joined) Check(NetRenameMachineInDomain(null, NativeManagement.Text(p, "name", 15), NativeManagement.Text(secrets, "username", 256), NativeManagement.Text(secrets, "password", 256), 2), "AGENT_DOMAIN_RENAME_FAILED");
            else if (!SetComputerNameEx(5, NativeManagement.Text(p, "name", 15))) throw new AgentMessageException(new Win32Exception(Marshal.GetLastWin32Error()), "AGENT_COMPUTER_RENAME_FAILED");
        }
    }
    internal static void SchedulePower(bool reboot, uint delay, string reason)
    {
        if (!OpenProcessToken(GetCurrentProcess(), 0x28, out IntPtr token)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            if (!LookupPrivilegeValue(null, "SeShutdownPrivilege", out Luid luid)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var privilege = new TokenPrivilege { Count = 1, Luid = luid, Attributes = 2 };
            if (!AdjustTokenPrivileges(token, false, ref privilege, 0, IntPtr.Zero, IntPtr.Zero) || Marshal.GetLastWin32Error() == 1300) throw new AgentMessageException(new Win32Exception(Marshal.GetLastWin32Error()), "AGENT_SHUTDOWN_PRIVILEGE_MISSING");
            if (!InitiateSystemShutdownEx(null, reason, delay, true, reboot, 0x80040001)) throw new AgentMessageException(new Win32Exception(Marshal.GetLastWin32Error()), "AGENT_POWER_SCHEDULE_FAILED");
        }
        finally { CloseHandle(token); }
    }
    // failureCode names the operation; a code with a _PARAMETER variant also reports the invalid parameter index.
    private static void Check(uint status, string failureCode, uint parameter = 0)
    {
        if (status == 0) return;
        if (parameter == 0) throw new AgentMessageException(new Win32Exception((int)status), failureCode, ("status", status));
        throw new AgentMessageException(new Win32Exception((int)status), failureCode + "_PARAMETER", ("status", status), ("parameter", parameter));
    }
}
