using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ServerDesk.Agent;

// AD sign-in for plugin changes (agent 4.19.0, docs/plugin-ad-sign-in.md).
// The device reports its directory (security.directory): the AD domain, or
// the computer of a workgroup server, read locally through LSA. The
// ad-sign-in job proves an account once: the broker checks the password with
// LogonUserW (lsass talks to the domain controller), reads the account's SID
// and answers it to the portal. The password comes sealed to the device key,
// is used once and is never stored or logged. Every later plugin change
// carries the verified identity as actAs in its signed job. The broker then
// asks lsass for an S4U token of that account (no password) and starts the
// plugin with it, so the server checks the account's own rights and the
// Security log names it.

/// <summary>The directory of this device: kind domain or local, the DNS (or computer) name, the NetBIOS name, the directory SID and the SID of the machine account domain.</summary>
internal sealed record AdDirectory(string Kind, string Name, string NetbiosName, string Sid, string MachineSid)
{
    internal JsonObject ToJson() => new() { ["kind"] = Kind, ["name"] = Name, ["netbiosName"] = NetbiosName, ["sid"] = Sid };
}

/// <summary>An account as LogonUserW takes it: the shown form, the domain (null for a UPN) and the user part.</summary>
internal sealed record AdAccount(string Account, string? Domain, string User, bool Upn);

/// <summary>The verified identity of an ad-sign-in: the token user SID, DOMAIN\name and the UPN (or null).</summary>
internal sealed record AdVerified(string UserSid, string Account, string? Upn);

/// <summary>The account a plugin change runs as (the signed job's actAs).</summary>
internal sealed record PluginActAs(string SessionId, string UserSid, string LogonName, string Account, string Kind)
{
    /// <summary>
    /// The actAs of a job, or null without one. A malformed actAs fails with
    /// AGENT_PLUGIN_ACCOUNT_REQUIRED, so a broken envelope never runs as SYSTEM.
    /// </summary>
    internal static PluginActAs? Read(JsonNode? node)
    {
        if (node is null) return null;
        if (node is not JsonObject value) throw new AgentMessageException("AGENT_PLUGIN_ACCOUNT_REQUIRED");
        string Text(string name) => value[name] is JsonValue item && item.TryGetValue<string>(out var text) ? text : "";
        string session = Text("sessionId"), sid = Text("userSid"), logon = Text("logonName"), account = Text("account"), kind = Text("kind");
        if (!Guid.TryParse(session, out _) || !PluginIdentity.UserSid.IsMatch(sid) || !PluginIdentity.Name(logon) || !PluginIdentity.Name(account) || kind is not ("domain" or "local")) throw new AgentMessageException("AGENT_PLUGIN_ACCOUNT_REQUIRED");
        return new PluginActAs(session, sid, logon, account, kind);
    }
}

/// <summary>A primary token of the account of a plugin change. Disposing it closes the handle.</summary>
internal interface IPluginAccountToken : IDisposable
{
    IntPtr Handle { get; }
    string UserSid { get; }
}
/// <summary>Creates the token of an actAs. Fails with AGENT_PLUGIN_ACCOUNT_UNAVAILABLE or AGENT_AD_DOMAIN_UNREACHABLE.</summary>
internal interface IPluginTokenFactory { IPluginAccountToken Logon(PluginActAs actAs); }

/// <summary>The Windows side of the ad-sign-in job: the directory and the password check.</summary>
internal interface IAdLogon
{
    /// <summary>The directory of this device. Throws Win32Exception when LSA does not answer.</summary>
    AdDirectory Directory();
    /// <summary>Checks the password with a network logon. Throws Win32Exception with the logon error.</summary>
    AdVerified Verify(AdAccount account, string password);
}

internal static class PluginIdentity
{
    internal const string SignInKind = "ad-sign-in", Capability = "plugin-ad-identity";
    internal const int MaximumName = 256, MaximumPassword = 256;
    internal static readonly Regex UserSid = new(@"^S-1-5-21(-\d+){4}$", RegexOptions.CultureInvariant);
    internal static readonly Regex DirectorySid = new(@"^S-1-5-21(-\d+){3}$", RegexOptions.CultureInvariant);
    private static readonly Regex Denied = new("^PLUGIN_[A-Z0-9]+_ACCESS_DENIED$", RegexOptions.CultureInvariant);

    internal static bool Name(string value) => value.Length is > 0 and <= MaximumName && !value.Any(c => c < 0x20 || c == 0x7f);

    /// <summary>
    /// The account a technician typed, for this directory. The same rules as
    /// parseAdAccount in lib/plugin-ad.ts (the self-test vectors are checked
    /// by tests/lib/plugin-ad.mjs too). Code "invalid" or "localOnDomain" on failure.
    /// </summary>
    internal static (AdAccount? Account, string? Code) ParseAccount(string? input, string kind, string name, string netbiosName, string? computer)
    {
        if (input is null) return (null, "invalid");
        string value = input.Trim();
        if (value.Length is 0 or > MaximumName || value.Any(c => c < 0x20 || c == 0x7f)) return (null, "invalid");
        static bool Same(string left, string? right) => !string.IsNullOrEmpty(right) && string.Equals(left.ToUpperInvariant(), right.ToUpperInvariant(), StringComparison.Ordinal);
        static bool Part(string part) => part.Length > 0 && part.IndexOfAny(['\\', '@', '/']) < 0 && part.Trim() == part;
        int slash = value.IndexOf('\\');
        if (kind == "local")
        {
            if (value.Contains('@')) return (null, "invalid");
            string? domain = slash < 0 ? null : value[..slash]; string user = slash < 0 ? value : value[(slash + 1)..];
            if (!Part(user) || domain is not null && domain != "." && !Same(domain, name) && !Same(domain, computer)) return (null, "invalid");
            return (new AdAccount(name + "\\" + user, name, user, false), null);
        }
        if (slash >= 0)
        {
            string domain = value[..slash], user = value[(slash + 1)..];
            if (domain == "." || Same(domain, computer) && !Same(domain, netbiosName)) return Part(user) ? (null, "localOnDomain") : (null, "invalid");
            if (!Part(domain) || !Part(user)) return (null, "invalid");
            return (new AdAccount(domain + "\\" + user, domain, user, false), null);
        }
        int at = value.IndexOf('@');
        if (at >= 0)
        {
            string user = value[..at], suffix = value[(at + 1)..];
            if (!Part(user) || !Part(suffix) || !suffix.Contains('.') && !Same(suffix, netbiosName)) return (null, "invalid");
            return (new AdAccount(value, null, value, true), null);
        }
        if (!Part(value)) return (null, "invalid");
        return (new AdAccount(netbiosName + "\\" + value, netbiosName, value, false), null);
    }

    /// <summary>The message of a LogonUserW error: wrong password, restricted, expired, no logon right, no DC, else the number.</summary>
    internal static AgentMessage LogonError(int error, string account) => error switch
    {
        1326 => AgentMessages.Of("AGENT_AD_SIGN_IN_FAILED"),
        1327 or 1328 or 1331 or 1793 or 1909 => AgentMessages.Of("AGENT_AD_ACCOUNT_RESTRICTED", ("account", account)),
        1330 or 1907 => AgentMessages.Of("AGENT_AD_PASSWORD_EXPIRED", ("account", account)),
        1385 => AgentMessages.Of("AGENT_AD_NO_LOGON_RIGHT", ("account", account)),
        1311 => AgentMessages.Of("AGENT_AD_DOMAIN_UNREACHABLE"),
        _ => AgentMessages.Of("AGENT_AD_SIGN_IN_ERROR", ("error", error)),
    };

    /// <summary>
    /// The kind check of a verified SID: on a domain device an account of the
    /// machine account domain is local (a DC has no local accounts: there both
    /// SIDs are equal); on a workgroup server only the machine's own accounts count.
    /// </summary>
    internal static string? KindError(AdDirectory directory, string userSid)
    {
        if (!UserSid.IsMatch(userSid)) return "AGENT_AD_SIGN_IN_FAILED";
        string domain = userSid[..userSid.LastIndexOf('-')];
        bool machine = string.Equals(domain, directory.MachineSid, StringComparison.OrdinalIgnoreCase);
        if (directory.Kind == "domain") return machine && !string.Equals(directory.MachineSid, directory.Sid, StringComparison.OrdinalIgnoreCase) ? "AGENT_AD_LOCAL_ACCOUNT" : null;
        return machine ? null : "AGENT_AD_SIGN_IN_FAILED";
    }

    /// <summary>A plugin's access-denied code in a run with an account becomes AGENT_PLUGIN_ACCOUNT_DENIED.</summary>
    internal static bool AccessDenied(string code) => Denied.IsMatch(code);

    /// <summary>
    /// The names of the S4U logon: a UPN with no realm (lsass finds the realm),
    /// DOMAIN\name with the DNS domain as realm when DOMAIN is this device's
    /// NetBIOS name, and for a local account the user and the computer name.
    /// </summary>
    internal static (string User, string Realm) S4uNames(PluginActAs actAs, AdDirectory? directory)
    {
        int slash = actAs.LogonName.IndexOf('\\');
        if (actAs.Kind == "local")
        {
            string user = slash < 0 ? actAs.LogonName : actAs.LogonName[(slash + 1)..], domain = slash < 0 ? "." : actAs.LogonName[..slash];
            return (user, domain == "." ? Environment.MachineName : domain);
        }
        if (slash < 0) return (actAs.LogonName, "");
        string realm = actAs.LogonName[..slash];
        if (directory is { Kind: "domain" } && string.Equals(realm, directory.NetbiosName, StringComparison.OrdinalIgnoreCase)) realm = directory.Name;
        return (actAs.LogonName[(slash + 1)..], realm);
    }

    /// <summary>security.directory for the telemetry, or null when LSA does not answer.</summary>
    internal static JsonObject? DirectoryJson()
    {
        try { return new WindowsAdLogon().Directory().ToJson(); }
        catch (Exception e) when (e is Win32Exception or ArgumentException or InvalidOperationException or DllNotFoundException or EntryPointNotFoundException) { return null; }
    }

    /// <summary>
    /// ad-sign-in: unseals the password, checks the account with a
    /// network logon, reads its SID, name and UPN and checks the kind. The
    /// result data are {userSid, account, upn, directory}. The password is
    /// masked in the result and never logged.
    /// </summary>
    internal static JsonObject SignIn(JsonObject job, Func<JsonObject, JsonObject>? unseal, IAdLogon? logon = null)
    {
        string id = job["id"]!.GetValue<string>(); var p = job["parameters"] as JsonObject ?? new JsonObject();
        var result = new JsonObject { ["id"] = id, ["ok"] = false };
        string password = "";
        try
        {
            logon ??= new WindowsAdLogon();
            string typed = p["account"] is JsonValue value && value.TryGetValue<string>(out var text) ? text : "";
            AdDirectory directory;
            try { directory = logon.Directory(); }
            catch (Win32Exception e) { throw new AgentMessageException("AGENT_AD_SIGN_IN_ERROR", ("error", e.NativeErrorCode)); }
            var (account, code) = ParseAccount(typed, directory.Kind, directory.Name, directory.NetbiosName, Environment.MachineName);
            if (account is null) throw new AgentMessageException(code == "localOnDomain" ? "AGENT_AD_LOCAL_ACCOUNT" : "AGENT_AD_SIGN_IN_FAILED");
            if (p["secretParameters"] is not JsonObject box) throw new AgentMessageException("AGENT_PLUGIN_SECRET_INVALID");
            try
            {
                var opened = (unseal ?? throw new System.Security.Cryptography.CryptographicException("No device key."))(box);
                password = opened["password"] is JsonValue secret && secret.TryGetValue<string>(out var plain) ? plain : "";
                opened.Clear();
            }
            catch (Exception e) when (e is System.Security.Cryptography.CryptographicException or FormatException or InvalidOperationException or NullReferenceException or System.Text.Json.JsonException or ArgumentException) { throw new AgentMessageException("AGENT_PLUGIN_SECRET_INVALID"); }
            if (password.Length is 0 or > MaximumPassword) throw new AgentMessageException("AGENT_PLUGIN_SECRET_INVALID");
            AdVerified verified;
            try { verified = logon.Verify(account, password); }
            catch (Win32Exception e)
            {
                var refused = LogonError(e.NativeErrorCode, account.Account);
                throw new AgentMessageException(e, refused.Code, refused.Args.Select(pair => (pair.Key, (object?)pair.Value)).ToArray());
            }
            if (KindError(directory, verified.UserSid) is string wrongKind) throw new AgentMessageException(wrongKind);
            string shown = Name(verified.Account) ? verified.Account : account.Account;
            string? upn = verified.Upn is { } found && Name(found) ? found : null;
            result["ok"] = true;
            result["data"] = new JsonObject { ["userSid"] = verified.UserSid, ["account"] = shown, ["upn"] = upn, ["directory"] = directory.ToJson() };
            return AgentMessages.Write(result, AgentMessages.Of("AGENT_AD_SIGNED_IN", ("account", shown)), password.Length > 0 ? [password] : null);
        }
        catch (Exception e)
        {
            result["ok"] = false; result.Remove("data");
            // An OS text never reaches the portal raw from here: every failure has a code.
            var coded = e as AgentMessageException ?? new AgentMessageException(e, "AGENT_AD_SIGN_IN_ERROR", ("error", e is Win32Exception win ? win.NativeErrorCode : 0));
            return AgentMessages.Fail(result, coded, password.Length > 0 ? [password] : null);
        }
        finally { password = ""; }
    }
}

// The Windows side: LSA for the directory, LogonUserW for the password check.
internal sealed class WindowsAdLogon : IAdLogon
{
    [StructLayout(LayoutKind.Sequential)] private struct LsaUnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] private struct LsaObjectAttributes { public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
    [StructLayout(LayoutKind.Sequential)] private struct DnsDomainInfo { public LsaUnicodeString Name, DnsDomainName, DnsForestName; public Guid DomainGuid; public IntPtr Sid; }
    [StructLayout(LayoutKind.Sequential)] private struct AccountDomainInfo { public LsaUnicodeString DomainName; public IntPtr DomainSid; }
    [DllImport("advapi32.dll")] private static extern uint LsaOpenPolicy(IntPtr systemName, ref LsaObjectAttributes attributes, uint access, out IntPtr handle);
    [DllImport("advapi32.dll")] private static extern uint LsaQueryInformationPolicy(IntPtr handle, int infoClass, out IntPtr buffer);
    [DllImport("advapi32.dll")] private static extern uint LsaFreeMemory(IntPtr buffer);
    [DllImport("advapi32.dll")] private static extern uint LsaClose(IntPtr handle);
    [DllImport("advapi32.dll")] internal static extern int LsaNtStatusToWinError(uint status);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool LogonUserW(string user, string? domain, IntPtr password, int logonType, int provider, out IntPtr token);
    [DllImport("secur32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserNameExW(int format, StringBuilder? name, ref uint size);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private const int PolicyAccountDomainInformation = 5, PolicyDnsDomainInformation = 12, LogonNetwork = 3, ProviderDefault = 0, NameUserPrincipal = 8;
    private const uint PolicyViewLocalInformation = 0x1;

    private static string Text(LsaUnicodeString value) => value.Buffer == IntPtr.Zero || value.Length == 0 ? "" : Marshal.PtrToStringUni(value.Buffer, value.Length / 2);

    /// <summary>
    /// The directory without network: PolicyDnsDomainInformation for a domain
    /// member or DC (DNS name, NetBIOS name, domain SID), else
    /// PolicyAccountDomainInformation (kind local, the computer name, the machine SID).
    /// </summary>
    public AdDirectory Directory()
    {
        var attributes = new LsaObjectAttributes { Length = Marshal.SizeOf<LsaObjectAttributes>() };
        uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, PolicyViewLocalInformation, out var policy);
        if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
        IntPtr dns = IntPtr.Zero, account = IntPtr.Zero;
        try
        {
            status = LsaQueryInformationPolicy(policy, PolicyAccountDomainInformation, out account);
            if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
            var machine = Marshal.PtrToStructure<AccountDomainInfo>(account);
            if (machine.DomainSid == IntPtr.Zero) throw new Win32Exception(1355);
            string machineSid = new SecurityIdentifier(machine.DomainSid).Value, computer = Text(machine.DomainName);
            status = LsaQueryInformationPolicy(policy, PolicyDnsDomainInformation, out dns);
            if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
            var domain = Marshal.PtrToStructure<DnsDomainInfo>(dns);
            // A workgroup server has no domain SID.
            if (domain.Sid != IntPtr.Zero)
            {
                string netbios = Text(domain.Name), name = Text(domain.DnsDomainName);
                return new AdDirectory("domain", name.Length > 0 ? name : netbios, netbios, new SecurityIdentifier(domain.Sid).Value, machineSid);
            }
            return new AdDirectory("local", computer.Length > 0 ? computer : Environment.MachineName, computer.Length > 0 ? computer : Environment.MachineName, machineSid, machineSid);
        }
        finally
        {
            if (dns != IntPtr.Zero) LsaFreeMemory(dns);
            if (account != IntPtr.Zero) LsaFreeMemory(account);
            LsaClose(policy);
        }
    }

    /// <summary>LogonUserW NETWORK with the account, then the token user SID, DOMAIN\name and the UPN under a short impersonation. The token is always closed and the password buffer cleared.</summary>
    public AdVerified Verify(AdAccount account, string password)
    {
        IntPtr secret = Marshal.StringToCoTaskMemUni(password), token = IntPtr.Zero;
        try
        {
            if (!LogonUserW(account.User, account.Upn ? null : account.Domain, secret, LogonNetwork, ProviderDefault, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            using var identity = new WindowsIdentity(token);
            string sid = identity.User?.Value ?? throw new Win32Exception(1332);
            string name;
            try { name = identity.User.Translate(typeof(NTAccount)).Value; }
            catch (Exception e) when (e is IdentityNotMappedException or SystemException) { name = account.Account; }
            string? upn = null;
            try
            {
                upn = WindowsIdentity.RunImpersonated(identity.AccessToken, () =>
                {
                    uint size = 0; GetUserNameExW(NameUserPrincipal, null, ref size);
                    if (size is 0 or > 1024) return null;
                    var buffer = new StringBuilder((int)size);
                    return GetUserNameExW(NameUserPrincipal, buffer, ref size) ? buffer.ToString() : null;
                });
            }
            catch (Exception e) when (e is Win32Exception or UnauthorizedAccessException or SystemException) { upn = null; }
            return new AdVerified(sid, name, string.IsNullOrWhiteSpace(upn) ? null : upn);
        }
        finally
        {
            if (token != IntPtr.Zero) CloseHandle(token);
            Marshal.ZeroFreeCoTaskMemUnicode(secret);
        }
    }
}

// The S4U token of a plugin change: LsaRegisterLogonProcess (the broker is
// LocalSystem with SeTcbPrivilege, so the token can be used to start a
// process), KERB_S4U_LOGON for a domain account or MSV1_0_S4U_LOGON for a
// local one, origin "ServerDesk" and source "SrvDesk", then a primary token
// through DuplicateTokenEx. No password: lsass builds the token from the
// directory, so a disabled, locked or deleted account fails here.
internal sealed class WindowsPluginTokenFactory(Func<AdDirectory?> directory) : IPluginTokenFactory
{
    [StructLayout(LayoutKind.Sequential)] private struct LsaString { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] private struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
    // KERB_S4U_LOGON and MSV1_0_S4U_LOGON share this layout: MessageType 12, Flags, the user, the realm or domain.
    [StructLayout(LayoutKind.Sequential)] private struct S4uLogon { public int MessageType; public uint Flags; public UnicodeString User, Realm; }
    [StructLayout(LayoutKind.Sequential)] private struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] private unsafe struct TokenSource { public fixed byte Name[8]; public Luid Identifier; }
    [StructLayout(LayoutKind.Sequential)] private struct QuotaLimits { public UIntPtr PagedPool, NonPagedPool, MinimumWorkingSet, MaximumWorkingSet, Pagefile; public long TimeLimit; }
    [DllImport("secur32.dll")] private static extern uint LsaRegisterLogonProcess(ref LsaString name, out IntPtr handle, out uint mode);
    [DllImport("secur32.dll")] private static extern uint LsaLookupAuthenticationPackage(IntPtr handle, ref LsaString name, out uint package);
    [DllImport("secur32.dll")] private static extern uint LsaLogonUser(IntPtr handle, ref LsaString origin, int logonType, uint package, IntPtr authentication, uint authenticationLength, IntPtr localGroups, ref TokenSource source, out IntPtr profile, out uint profileLength, out Luid logonId, out IntPtr token, out QuotaLimits quotas, out int subStatus);
    [DllImport("secur32.dll")] private static extern uint LsaFreeReturnBuffer(IntPtr buffer);
    [DllImport("secur32.dll")] private static extern uint LsaDeregisterLogonProcess(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AllocateLocallyUniqueId(out Luid luid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr buffer, int length, out int needed);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private const int S4uMessage = 12, LogonNetwork = 3, TokenUser = 1, SecurityImpersonation = 2, TokenPrimary = 1;
    private const uint MaximumAllowed = 0x02000000;
    internal const string Origin = "ServerDesk", Source = "SrvDesk";

    private static LsaString Ansi(string text, out IntPtr buffer)
    {
        byte[] bytes = Encoding.ASCII.GetBytes(text); buffer = Marshal.AllocHGlobal(bytes.Length + 1);
        Marshal.Copy(bytes, 0, buffer, bytes.Length); Marshal.WriteByte(buffer, bytes.Length, 0);
        return new LsaString { Length = (ushort)bytes.Length, MaximumLength = (ushort)(bytes.Length + 1), Buffer = buffer };
    }
    private static AgentMessageException Failure(uint status, PluginActAs actAs)
    {
        int error = WindowsAdLogon.LsaNtStatusToWinError(status);
        return error == 1311 ? new AgentMessageException("AGENT_AD_DOMAIN_UNREACHABLE") : new AgentMessageException("AGENT_PLUGIN_ACCOUNT_UNAVAILABLE", ("account", actAs.Account));
    }
    /// <summary>The user SID of a token.</summary>
    internal static string TokenUserSid(IntPtr token)
    {
        GetTokenInformation(token, TokenUser, IntPtr.Zero, 0, out int needed);
        if (needed <= 0 || needed > 4096) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr buffer = Marshal.AllocHGlobal(needed);
        try
        {
            if (!GetTokenInformation(token, TokenUser, buffer, needed, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    public unsafe IPluginAccountToken Logon(PluginActAs actAs)
    {
        var (user, realm) = PluginIdentity.S4uNames(actAs, directory());
        IntPtr lsa = IntPtr.Zero, logonName = IntPtr.Zero, packageName = IntPtr.Zero, originName = IntPtr.Zero, authentication = IntPtr.Zero, profile = IntPtr.Zero, token = IntPtr.Zero, primary = IntPtr.Zero;
        try
        {
            var name = Ansi(Origin, out logonName);
            uint status = LsaRegisterLogonProcess(ref name, out lsa, out _);
            if (status != 0) throw Failure(status, actAs);
            var package = Ansi(actAs.Kind == "domain" ? "Kerberos" : "MICROSOFT_AUTHENTICATION_PACKAGE_V1_0", out packageName);
            status = LsaLookupAuthenticationPackage(lsa, ref package, out uint packageId);
            if (status != 0) throw Failure(status, actAs);
            // One block: the structure, then both strings it points to.
            byte[] first = Encoding.Unicode.GetBytes(user), second = Encoding.Unicode.GetBytes(realm);
            if (first.Length is 0 or > 1024 || second.Length > 1024) throw new AgentMessageException("AGENT_PLUGIN_ACCOUNT_UNAVAILABLE", ("account", actAs.Account));
            int head = Marshal.SizeOf<S4uLogon>(), size = head + first.Length + second.Length;
            authentication = Marshal.AllocHGlobal(size);
            new Span<byte>((void*)authentication, size).Clear();
            Marshal.Copy(first, 0, authentication + head, first.Length);
            if (second.Length > 0) Marshal.Copy(second, 0, authentication + head + first.Length, second.Length);
            var logon = new S4uLogon
            {
                MessageType = S4uMessage,
                User = new UnicodeString { Length = (ushort)first.Length, MaximumLength = (ushort)first.Length, Buffer = authentication + head },
                Realm = new UnicodeString { Length = (ushort)second.Length, MaximumLength = (ushort)second.Length, Buffer = second.Length > 0 ? authentication + head + first.Length : IntPtr.Zero },
            };
            Marshal.StructureToPtr(logon, authentication, false);
            var source = new TokenSource();
            byte[] sourceName = Encoding.ASCII.GetBytes(Source);
            for (int index = 0; index < sourceName.Length && index < 8; index++) source.Name[index] = sourceName[index];
            if (!AllocateLocallyUniqueId(out source.Identifier)) throw new AgentMessageException("AGENT_PLUGIN_ACCOUNT_UNAVAILABLE", ("account", actAs.Account));
            var origin = Ansi(Origin, out originName);
            status = LsaLogonUser(lsa, ref origin, LogonNetwork, packageId, authentication, (uint)size, IntPtr.Zero, ref source, out profile, out _, out _, out token, out _, out _);
            if (status != 0) throw Failure(status, actAs);
            if (!DuplicateTokenEx(token, MaximumAllowed, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out primary)) throw new AgentMessageException("AGENT_PLUGIN_ACCOUNT_UNAVAILABLE", ("account", actAs.Account));
            var result = new AccountToken(primary, TokenUserSid(primary));
            primary = IntPtr.Zero;
            return result;
        }
        catch (Win32Exception) { throw new AgentMessageException("AGENT_PLUGIN_ACCOUNT_UNAVAILABLE", ("account", actAs.Account)); }
        finally
        {
            // The LSA token and, on a failure, the primary token are closed here.
            if (token != IntPtr.Zero) CloseHandle(token);
            if (primary != IntPtr.Zero) CloseHandle(primary);
            if (profile != IntPtr.Zero) LsaFreeReturnBuffer(profile);
            if (authentication != IntPtr.Zero) Marshal.FreeHGlobal(authentication);
            foreach (var buffer in new[] { logonName, packageName, originName }) if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
            if (lsa != IntPtr.Zero) LsaDeregisterLogonProcess(lsa);
        }
    }

    private sealed class AccountToken(IntPtr handle, string sid) : IPluginAccountToken
    {
        private IntPtr handle = handle;
        public IntPtr Handle => handle;
        public string UserSid { get; } = sid;
        public void Dispose() { var open = Interlocked.Exchange(ref handle, IntPtr.Zero); if (open != IntPtr.Zero) CloseHandle(open); }
    }
}
