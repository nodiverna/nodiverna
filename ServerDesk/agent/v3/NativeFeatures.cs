using System.Management;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// Server roles use the native ServerManager Deployment Provider, preserving its
// role names, dependency descriptors and hierarchy. Windows client features use
// DismApi.dll; invoking dism.exe or PowerShell is unnecessary.
internal static class NativeFeatures
{
    internal const string DeploymentTasksClass = "MSFT_ServerManagerDeploymentTasks";
    internal const string RequestGuidClass = "MSFT_ServerManagerRequestGuid";
    internal const string ServerManagerNamespace = @"root\Microsoft\Windows\ServerManager";
    internal const string DocumentedNamespace = @"root\StandardCimv2";
    private static readonly TimeSpan ProviderProbeTimeout = TimeSpan.FromSeconds(5);
    private static string? providerNamespace;
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static JsonArray? cached;
    private static DateTime cacheAt;
    private static bool cacheServer;
    private static IntPtr dismModule;
    private static readonly NativeFeatureDisplayCache DismDisplayNames = new();
    internal static async Task<JsonArray> ListAsync(bool server, CancellationToken token)
    {
        await Gate.WaitAsync(token);
        try
        {
            if (cached is not null && cacheServer == server && DateTime.UtcNow - cacheAt < TimeSpan.FromSeconds(20)) return (JsonArray)cached.DeepClone();
            var rows = await Task.Run(() => server ? ServerList(token) : DismList(token), token);
            cached = (JsonArray)rows.DeepClone(); cacheServer = server; cacheAt = DateTime.UtcNow; return rows;
        }
        finally { Gate.Release(); }
    }
    internal static async Task<bool> ChangeAsync(bool server, string name, bool install, bool managementTools, CancellationToken token)
    {
        NativeManagement.ValidateParameters(install ? "install-feature" : "remove-feature", new JsonObject { ["name"] = name, ["includeManagementTools"] = managementTools });
        await Gate.WaitAsync(token);
        try { return await Task.Run(() => server ? ChangeServer(name, install, managementTools, token) : ChangeDism(name, install, token), token); }
        finally { cached = null; DismDisplayNames.Clear(); Gate.Release(); }
    }

    // Probe the known ServerManager registration and the namespace documented
    // in the archived reference. Resolve both classes before invoking any task.
    // A missing class can select the alternate registration; an operational or
    // permission failure must remain a failure and must never trigger a mutation
    // through another provider.
    internal static string ResolveServerManagerNamespace(Action<string, string> probe, CancellationToken token)
    {
        Exception? missing = null;
        foreach (string ns in new[] { ServerManagerNamespace, DocumentedNamespace })
        {
            foreach (string className in new[] { DeploymentTasksClass, RequestGuidClass })
            {
                token.ThrowIfCancellationRequested();
                try { probe(ns, className); token.ThrowIfCancellationRequested(); }
                catch (Exception error) when (MissingProviderMetadata(error)) { missing = error; break; }
                catch (Exception error) when (error is not OperationCanceledException)
                {
                    throw new NativeInventoryException("ServerManager metadata: " + ns + ":" + className, error);
                }
                if (className == RequestGuidClass) return ns;
            }
        }
        throw new NativeInventoryException("ServerManager provider missing in " + ServerManagerNamespace + " and " + DocumentedNamespace,
            missing ?? new InvalidDataException("ServerManager metadata missing."));
    }
    private static bool MissingProviderMetadata(Exception error)
    {
        if (error is not ManagementException and not COMException) return false;
        int code = error is ManagementException management ? (int)management.ErrorCode : error.HResult;
        return code == (int)ManagementStatus.InvalidNamespace || code == (int)ManagementStatus.InvalidClass || code == (int)ManagementStatus.ProviderNotFound;
    }
    private static void ProbeServerManagerClass(string ns, string className)
    {
        var scope = new ManagementScope(@"\\.\" + ns, new ConnectionOptions { EnablePrivileges = true, Timeout = ProviderProbeTimeout });
        using var type = new ManagementClass(scope, new ManagementPath(className), new ObjectGetOptions { Timeout = ProviderProbeTimeout });
        type.Get();
    }
    private static ManagementClass OpenServerManager(CancellationToken token)
    {
        // List and change operations hold Gate, so the successful registration is
        // shared safely and never changes midway through an existing request.
        providerNamespace ??= ResolveServerManagerNamespace(ProbeServerManagerClass, token);
        token.ThrowIfCancellationRequested();
        return new ManagementClass(NativeManagement.Scope(providerNamespace), new ManagementPath(DeploymentTasksClass), null);
    }
    private static ManagementBaseObject NewRequest(ManagementClass tasks)
    {
        // Use the task's actual scope rather than resolving or guessing again.
        using var type = new ManagementClass(tasks.Scope, new ManagementPath(RequestGuidClass), null);
        var request = type.CreateInstance() ?? throw new InvalidDataException("ServerManager request ID missing.");
        try { byte[] guid = Guid.NewGuid().ToByteArray(); request["HighHalf"] = BitConverter.ToUInt64(guid, 0); request["LowHalf"] = BitConverter.ToUInt64(guid, 8); return request; }
        catch { request.Dispose(); throw; }
    }
    private static ManagementBaseObject Call(ManagementClass type, string method, Dictionary<string, object?> values)
    {
        try
        {
            using var input = type.GetMethodParameters(method); foreach (var pair in values) input[pair.Key] = pair.Value;
            var output = type.InvokeMethod(method, input, new InvokeMethodOptions { Timeout = TimeSpan.FromSeconds(45) }) ?? throw new InvalidDataException("ServerManager returned no answer.");
            try
            {
                uint code = Convert.ToUInt32(output["ReturnValue"]);
                if (code != 0) throw new System.ComponentModel.Win32Exception(unchecked((int)code), "The ServerManager call failed.");
                return output;
            }
            catch { output.Dispose(); throw; }
        }
        catch (Exception error) when (error is not OperationCanceledException and not NativeInventoryException)
        {
            throw new NativeInventoryException(ServerManagerContext(type, method), error);
        }
    }
    private static string ServerManagerContext(ManagementClass type, string operation) => "ServerManager " + operation + " [" + type.Scope.Path.NamespacePath + "]";
    private static bool Complete(ManagementBaseObject output, string key, out bool reboot)
    {
        if (output[key] is not ManagementBaseObject state) throw new InvalidDataException("ServerManager request state missing.");
        reboot = Convert.ToBoolean(state["RestartRequired"]); int status = Convert.ToInt32(state["RequestState"]);
        if (status == 2)
        {
            string detail = state["Error"] is ManagementBaseObject failure ? string.Join("; ", failure.Properties.Cast<PropertyData>().Where(p => p.Value is not null).Select(p => p.Name + ": " + p.Value)) : "";
            throw detail.Length == 0 ? new AgentMessageException("AGENT_FEATURE_REQUEST_FAILED") : new AgentMessageException("AGENT_FEATURE_REQUEST_FAILED_DETAIL", ("detail", detail));
        }
        if (status is not 0 and not 1) throw new AgentMessageException("AGENT_FEATURE_REQUEST_STATE_UNKNOWN", ("status", status));
        return status == 1;
    }
    private static List<ManagementBaseObject> EnumerateServer(ManagementClass type, CancellationToken token)
    {
        using var request = NewRequest(type); var values = new Dictionary<string, object?> { ["RequestGuid"] = request };
        using var first = Call(type, "GetServerComponentsAsync", values); ManagementBaseObject output = first; ManagementBaseObject? polled = null;
        var deadline = DateTime.UtcNow.AddMinutes(2);
        try
        {
            while (!Complete(output, "EnumerationState", out _))
            {
                token.ThrowIfCancellationRequested(); if (DateTime.UtcNow >= deadline) throw new AgentMessageException("AGENT_FEATURE_INVENTORY_TIMEOUT");
                if (token.WaitHandle.WaitOne(1000)) token.ThrowIfCancellationRequested(); polled?.Dispose(); polled = Call(type, "GetEnumerationRequestState", values); output = polled;
            }
            if (output["ServerComponents"] is not ManagementBaseObject[] components || components.Length == 0) throw new AgentMessageException("AGENT_FEATURE_INVENTORY_EMPTY");
            return components.Select(x => (ManagementBaseObject)x.Clone()).ToList();
        }
        finally { polled?.Dispose(); }
    }
    private static JsonArray ServerList(CancellationToken token)
    {
        using var type = OpenServerManager(token); List<ManagementBaseObject>? rows = null;
        try
        {
            rows = EnumerateServer(type, token);
            var result = new JsonArray(); var names = rows.ToDictionary(x => Convert.ToString(x["UniqueName"]) ?? "", StringComparer.OrdinalIgnoreCase);
            foreach (var row in rows.OrderBy(x => Convert.ToString(x["DisplayName"]), StringComparer.OrdinalIgnoreCase).Take(1000))
            {
                string name = Convert.ToString(row["UniqueName"]) ?? "", parent = Convert.ToString(row["ParentName"]) ?? ""; int depth = 0;
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { name }; string at = parent;
                while (!string.IsNullOrEmpty(at) && seen.Add(at) && names.TryGetValue(at, out var ancestor) && depth < 32) { depth++; at = Convert.ToString(ancestor["ParentName"]) ?? ""; }
                result.Add(new JsonObject { ["name"] = name, ["displayName"] = Convert.ToString(row["DisplayName"]) ?? name, ["installed"] = Convert.ToInt32(row["Installed"]) is 1 or 2, ["featureType"] = Convert.ToInt32(row["FeatureType"]) switch { 0 => "Role", 1 => "Role Service", _ => "Feature" }, ["parent"] = string.IsNullOrEmpty(parent) ? null : parent, ["subFeatures"] = new JsonArray(((string[]?)row["SubFeatures"] ?? []).Take(1000).Select(s => (JsonNode?)JsonValue.Create(s)).ToArray()), ["depth"] = depth });
            }
            return result;
        }
        catch (Exception error) when (error is not OperationCanceledException and not NativeInventoryException)
        {
            throw new NativeInventoryException(ServerManagerContext(type, "role inventory"), error);
        }
        finally { if (rows is not null) foreach (var row in rows) row.Dispose(); }
    }
    private static bool ChangeServer(string name, bool install, bool managementTools, CancellationToken token)
    {
        using var type = OpenServerManager(token); List<ManagementBaseObject>? rows = null;
        try
        {
            rows = EnumerateServer(type, token);
            var names = rows.ToDictionary(x => Convert.ToString(x["UniqueName"]) ?? "", StringComparer.OrdinalIgnoreCase);
            if (!names.ContainsKey(name)) throw new AgentMessageException("AGENT_FEATURE_NOT_FOUND");
            var selected = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            void Add(string key, bool withDefaultChildren)
            {
                if (!selected.Add(key)) return; if (!names.TryGetValue(key, out var row)) throw new AgentMessageException("AGENT_FEATURE_DEPENDENCY_MISSING", ("name", key));
                if (install)
                {
                    string parent = Convert.ToString(row["ParentName"]) ?? ""; if (!string.IsNullOrEmpty(parent)) Add(parent, false);
                    foreach (string dependency in (string[]?)row["NonAncestorDependencies"] ?? []) Add(dependency, false);
                    if (withDefaultChildren) foreach (string child in (string[]?)row["SubFeatures"] ?? []) if (names.TryGetValue(child, out var childRow) && Convert.ToBoolean(childRow["InstallWithParentByDefault"])) Add(child, true);
                }
                if (managementTools && row["OptionalCompanions"] is ManagementBaseObject[] companions) foreach (var companion in companions) { if (Convert.ToInt32(companion["CompanionType"]) == 0) Add(Convert.ToString(companion["CompanionComponentName"]) ?? "", false); }
            }
            Add(name, true);
            var descriptors = selected.Select(key => names[key]["Descriptor"] as ManagementBaseObject ?? throw new AgentMessageException("AGENT_FEATURE_DESCRIPTOR_MISSING", ("name", key))).ToArray();
            using var request = NewRequest(type); var values = new Dictionary<string, object?> { ["RequestGuid"] = request, ["ServerComponentDescriptors"] = descriptors };
            if (install) { values["Source"] = Array.Empty<string>(); values["ScanForUpdates"] = false; } else values["DeleteComponents"] = false;
            token.ThrowIfCancellationRequested(); using var first = Call(type, install ? "AddServerComponentAsync" : "RemoveServerComponentAsync", values); ManagementBaseObject output = first; ManagementBaseObject? polled = null;
            var deadline = DateTime.UtcNow.AddHours(2); bool reboot;
            try
            {
                while (!Complete(output, "AlterationState", out reboot))
                {
                    token.ThrowIfCancellationRequested(); if (DateTime.UtcNow >= deadline) throw new AgentMessageException("AGENT_FEATURE_CHANGE_TIMEOUT");
                    if (token.WaitHandle.WaitOne(500)) token.ThrowIfCancellationRequested(); polled?.Dispose(); polled = Call(type, "GetAlterationRequestState", new() { ["RequestGuid"] = request, ["KeepAlterationStateOnRestartRequired"] = false }); output = polled;
                }
                return reboot;
            }
            finally { polled?.Dispose(); }
        }
        // The agent's own coded failures stay job messages; provider errors keep their context.
        catch (Exception error) when (error is not OperationCanceledException and not NativeInventoryException and not AgentMessageException)
        {
            throw new NativeInventoryException(ServerManagerContext(type, install ? "role installation" : "role removal"), error);
        }
        finally { if (rows is not null) foreach (var row in rows) row.Dispose(); }
    }

    // DismAPI.h packs its returned structures to one byte. In particular, x64
    // DismFeature has a 12-byte array stride, and DismFeatureInfo.DisplayName
    // starts at byte 12. The CLR's default 8-byte alignment reads invalid
    // pointers here and can terminate the entire process with an access violation.
    // CustomProperty precedes CustomPropertyCount in the native definition.
    [StructLayout(LayoutKind.Sequential, Pack = 1)] internal struct DismFeature { internal IntPtr Name; internal int State; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] internal struct DismFeatureInfo { internal IntPtr Name; internal int State; internal IntPtr DisplayName, Description; internal int Restart; internal IntPtr Properties; internal uint PropertyCount; }
    internal delegate int DismFeatureInfoReader(out IntPtr info);
    [DllImport("DismApi.dll", CharSet = CharSet.Unicode)] private static extern int DismInitialize(int logLevel, string? logFile, string? scratch);
    [DllImport("DismApi.dll", CharSet = CharSet.Unicode)] private static extern int DismOpenSession(string imagePath, string? windows, string? systemDrive, out uint session);
    [DllImport("DismApi.dll")] private static extern int DismCloseSession(uint session);
    [DllImport("DismApi.dll")] private static extern int DismShutdown();
    [DllImport("DismApi.dll", CharSet = CharSet.Unicode)] private static extern int DismGetFeatures(uint session, string? identifier, int package, out IntPtr rows, out uint count);
    [DllImport("DismApi.dll", CharSet = CharSet.Unicode)] private static extern int DismGetFeatureInfo(uint session, string feature, string? identifier, int package, out IntPtr info);
    [DllImport("DismApi.dll", CharSet = CharSet.Unicode)] private static extern int DismEnableFeature(uint session, string feature, string? identifier, int package, [MarshalAs(UnmanagedType.Bool)] bool limitAccess, IntPtr sources, uint sourceCount, [MarshalAs(UnmanagedType.Bool)] bool enableAll, IntPtr cancel, IntPtr progress, IntPtr userData);
    [DllImport("DismApi.dll", CharSet = CharSet.Unicode)] private static extern int DismDisableFeature(uint session, string feature, string? package, [MarshalAs(UnmanagedType.Bool)] bool removePayload, IntPtr cancel, IntPtr progress, IntPtr userData);
    [DllImport("DismApi.dll")] private static extern int DismDelete(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr LoadLibraryEx(string filename, IntPtr file, uint flags);
    private static void DismCheck(int hr) { if (hr == 3010 || hr == unchecked((int)0x80070BC2)) return; if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
    private static T WithDism<T>(Func<uint, T> action)
    {
        // DISM lives in System32\Dism on supported Windows images. Loading the
        // inbox library from a trusted OS path also resolves its inbox dependencies
        // without adding a mutable directory to the process-wide DLL search path.
        if (dismModule == IntPtr.Zero)
        {
            string folder = Path.Combine(Environment.SystemDirectory, "Dism");
            string api = Path.Combine(folder, "DismApi.dll"); if (!File.Exists(api)) api = Path.Combine(Environment.SystemDirectory, "DismApi.dll");
            dismModule = LoadLibraryEx(api, IntPtr.Zero, 0x900); // DLL_LOAD_DIR | SYSTEM32
            if (dismModule == IntPtr.Zero) throw new AgentMessageException(new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()), "AGENT_DISM_UNAVAILABLE");
        }
        DismCheck(DismInitialize(1, null, null)); uint session = 0;
        try { DismCheck(DismOpenSession("DISM_{53BFAE52-B167-4E2F-A258-0A37B57FF845}", null, null, out session)); return action(session); }
        finally { if (session != 0) DismCloseSession(session); DismShutdown(); }
    }
    private static JsonArray DismList(CancellationToken token) => WithDism(session =>
    {
        IntPtr memory = IntPtr.Zero;
        try
        {
            DismCheck(DismGetFeatures(session, null, 0, out memory, out uint count));
            return ReadDismFeatures(memory, count, token, name =>
            {
                // DismGetFeatures already supplies current installation state.
                // Display labels are servicing metadata: do not make another
                // expensive CBS request for every feature on every refresh.
                return DismDisplayNames.Read(name, DateTimeOffset.UtcNow, () => ReadDismDisplayName(name,
                    (out IntPtr info) => DismGetFeatureInfo(session, name, null, 0, out info), info => { DismDelete(info); }));
            });
        }
        finally { if (memory != IntPtr.Zero) DismDelete(memory); }
    });
    internal static JsonArray ReadDismFeatures(IntPtr memory, uint count, CancellationToken token, Func<string, string> displayName)
    {
        if (count != 0 && memory == IntPtr.Zero) throw new InvalidDataException("DISM feature inventory returned no buffer.");
        var result = new JsonArray(); int size = Marshal.SizeOf<DismFeature>();
        for (int i = 0; i < Math.Min(count, 1000); i++)
        {
            token.ThrowIfCancellationRequested(); var feature = Marshal.PtrToStructure<DismFeature>(memory + i * size);
            string name = Marshal.PtrToStringUni(feature.Name) ?? "";
            // Only managed strings leave the owning DISM session/buffer scope.
            string display = displayName(name);
            // Client optional features are not fabricated into server-role trees.
            result.Add(new JsonObject { ["name"] = name, ["displayName"] = display, ["installed"] = DismInstalled(feature.State), ["featureType"] = "OptionalFeature", ["parent"] = null, ["subFeatures"] = new JsonArray(), ["depth"] = 0 });
        }
        return result;
    }
    internal static string ReadDismDisplayName(string name, DismFeatureInfoReader collect, Action<IntPtr> delete)
    {
        IntPtr info = IntPtr.Zero;
        try
        {
            DismCheck(collect(out info));
            if (info == IntPtr.Zero) throw new InvalidDataException("DISM feature metadata returned no buffer.");
            var details = Marshal.PtrToStructure<DismFeatureInfo>(info);
            // Copy while DISM still owns the strings, before DismDelete and
            // DismCloseSession. The metadata cache stores the managed copy.
            string? display = Marshal.PtrToStringUni(details.DisplayName);
            // Some valid inbox features have no localized display label: DISM
            // can return an allocated empty string as well as a null pointer.
            return string.IsNullOrWhiteSpace(display) ? name : display;
        }
        finally { if (info != IntPtr.Zero) delete(info); }
    }
    // Explicit read-only pilot: bypass both caches to exercise native feature
    // array/detail marshalling and the initialize/open/delete/close lifecycle.
    internal static async Task<JsonArray> ProbeDismAsync(CancellationToken token)
    {
        await Gate.WaitAsync(token);
        try { DismDisplayNames.Clear(); return await Task.Run(() => DismList(token), token); }
        finally { Gate.Release(); }
    }
    internal static bool DismInstalled(int state) => state is 4 or 1;
    private static bool ChangeDism(string name, bool install, CancellationToken token) => WithDism(session =>
    {
        DismCheck(DismGetFeatureInfo(session, name, null, 0, out IntPtr info)); DismDelete(info); token.ThrowIfCancellationRequested();
        using var cancelled = new EventWaitHandle(false, EventResetMode.ManualReset); using var registration = token.Register(() => cancelled.Set());
        int hr = install ? DismEnableFeature(session, name, null, 0, false, IntPtr.Zero, 0, true, cancelled.SafeWaitHandle.DangerousGetHandle(), IntPtr.Zero, IntPtr.Zero) : DismDisableFeature(session, name, null, false, cancelled.SafeWaitHandle.DangerousGetHandle(), IntPtr.Zero, IntPtr.Zero);
        DismCheck(hr); return hr == 3010 || hr == unchecked((int)0x80070BC2);
    });
}

// NativeFeatures.Gate owns this bounded metadata cache. State is never cached
// here: external installations/removals remain visible in DismGetFeatures.
internal sealed class NativeFeatureDisplayCache
{
    private const int Maximum = 2000;
    private static readonly TimeSpan Lifetime = TimeSpan.FromDays(1);
    private readonly Dictionary<string, (string Display, DateTimeOffset Expires)> entries = new(StringComparer.OrdinalIgnoreCase);
    internal string Read(string name, DateTimeOffset now, Func<string> collect)
    {
        if (entries.TryGetValue(name, out var previous) && now < previous.Expires) return previous.Display;
        string display = collect(); // A provider failure must not become a cached success.
        if (!entries.ContainsKey(name) && entries.Count >= Maximum)
        {
            foreach (string expired in entries.Where(entry => now >= entry.Value.Expires).Select(entry => entry.Key).ToArray()) entries.Remove(expired);
            if (entries.Count >= Maximum) entries.Clear();
        }
        entries[name] = (display, now + Lifetime);
        return display;
    }
    internal void Clear() => entries.Clear();
}
