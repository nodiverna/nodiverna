using System.ComponentModel;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Win32;
using static ServerDesk.Agent.WindowsManagement;

namespace ServerDesk.Agent;

internal sealed class NativeTelemetryCollector
{
    internal const int RefreshSeconds = 30;
    internal const int InventorySeconds = 900;
    internal const int ConfigurationSeconds = 300;
    private readonly string root;
    private readonly JsonObject config;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly NativeProcessInventory processes;
    private readonly NativeEventInventory events = new();
    private readonly NativeServiceInventory services = new();
    private readonly NativePerformanceInventory performance = new();
    private readonly NativeGpuInventory gpu = new();
    private readonly TelemetryCollectorSlot gpuCollector;
    private readonly List<TelemetryCollectorSlot> collectors = [];
    private readonly TelemetryInventoryScheduler scheduler;
    private ulong? previousIdle, previousKernel, previousUser;
    // name and collector deadline in seconds → the broker's result (AgentWorker.Privileged).
    private readonly Func<string, int, JsonObject>? privileged;
    private const int DefaultDeadlineSeconds = 6;
    // collectorErrors: at most one entry per collector, at most this many.
    internal const int MaximumCollectorErrors = 30;
    // These inventories need administrator rights. In the unprivileged worker
    // they are fixed, argument-free broker reads; everything else is collected
    // with the worker's own rights (Performance Monitor and Event Log Readers).
    internal static readonly string[] PrivilegedProviders = ["Hardware inventory", "Roles and features", "Security", "Local firewall rules", "Scheduled tasks", "Scheduled system action", "Crashes", "BitLocker", "Software inventory", "Drivers", "Reliability", "Disk and battery health", "Certificates", "Autostart", "Defender", "Windows license"];
    // The software, driver and autostart lists travel with the collector result under these keys, never in the snapshot.
    internal const string SoftwareInventoryKey = "_softwareInventory";
    private static readonly string[] ListKeys = [SoftwareInventoryKey, NativeDriverInventory.InventoryKey, NativeAutostartInventory.InventoryKey];
    private readonly Dictionary<string, JsonObject> lists = new(StringComparer.Ordinal);
    private JsonObject? List(string key) { lock (softwareGate) return lists.TryGetValue(key, out var list) ? list.DeepClone().AsObject() : null; }
    /// <summary>The newest software list ({checksum, count, truncated, items}) for POST /api/agent/software, or null before the first collection.</summary>
    internal JsonObject? Software => List(SoftwareInventoryKey);
    /// <summary>The newest driver list for POST /api/agent/drivers, or null before the first collection.</summary>
    internal JsonObject? Drivers => List(NativeDriverInventory.InventoryKey);
    /// <summary>The newest autostart list for POST /api/agent/autostart, or null before the first collection.</summary>
    internal JsonObject? Autostart => List(NativeAutostartInventory.InventoryKey);
    private readonly object softwareGate = new();

    internal NativeTelemetryCollector(string root, JsonObject config, Func<string, int, JsonObject>? privileged = null)
    {
        this.root = root; this.config = config; this.privileged = privileged; processes = new(root);
        // Fast native measurements come first; provider inventories are spread
        // across the cycle instead of waking every provider at the same instant.
        Add("Performance counters", RefreshSeconds, performance.Collect);
        Add("Graphics cards", RefreshSeconds, gpu.Collect);
        gpuCollector = collectors[^1];
        Add("Processes", RefreshSeconds, processes.Collect, 5);
        Add("Drives", RefreshSeconds, NativeDriveInventory.Collect);
        Add("Services", RefreshSeconds, services.Collect);
        Add("Event logs", 60, events.Collect);
        Add("Network", ConfigurationSeconds, Networks);
        Add("System inventory", InventorySeconds, ComputerInventory);
        Add("Hardware inventory", NativeHardwareInventory.IntervalSeconds, new NativeHardwareInventory().Collect, NativeHardwareInventory.DeadlineSeconds);
        Add("Roles and features", InventorySeconds, () => new JsonObject { ["features"] = NativeFeatures.ListAsync(IsServer(), CancellationToken.None).GetAwaiter().GetResult() }, 25);
        Add("Local accounts", InventorySeconds, LocalAccounts, 10);
        Add("Page file", ConfigurationSeconds, Pagefile);
        Add("Security", ConfigurationSeconds, Security);
        Add("Local firewall rules", InventorySeconds, FirewallRules, 10);
        Add("Scheduled tasks", InventorySeconds, Tasks, 10);
        Add("Scheduled system action", ConfigurationSeconds, NativePowerSchedule.Collect, 6);
        // Health signals of 4.10.0: fixed, argument-free reads in the SYSTEM broker, each with its own deadline.
        Add("Crashes", NativeCrashInventory.IntervalSeconds, new NativeCrashInventory().Collect, NativeCrashInventory.DeadlineSeconds);
        Add("BitLocker", NativeBitLocker.IntervalSeconds, new NativeBitLocker(Path.Combine(root, "bitlocker-state.json")).Collect, NativeBitLocker.DeadlineSeconds);
        Add("Software inventory", NativeSoftwareInventory.IntervalSeconds, new NativeSoftwareInventory().Collect, NativeSoftwareInventory.DeadlineSeconds);
        // Health signals of 4.11.0: the same kind of fixed, argument-free broker reads.
        // The driver list is kept until the next successful read (4.11.1), so a failing read never empties the Drivers area.
        Add("Drivers", NativeDriverInventory.IntervalSeconds, new NativeDriverInventory().Collect, NativeDriverInventory.DeadlineSeconds, keepLastValue: true);
        Add("Reliability", NativeReliability.IntervalSeconds, new NativeReliability().Collect, NativeReliability.DeadlineSeconds);
        Add("Disk and battery health", NativeDiskHealth.IntervalSeconds, new NativeDiskHealth().Collect, NativeDiskHealth.DeadlineSeconds);
        Add("Certificates", NativeCertificates.IntervalSeconds, new NativeCertificates().Collect, NativeCertificates.DeadlineSeconds);
        Add("Autostart", NativeAutostartInventory.IntervalSeconds, new NativeAutostartInventory().Collect, NativeAutostartInventory.DeadlineSeconds);
        // Microsoft Defender of 4.14.0: the same kind of fixed, argument-free broker read; it only reads.
        Add("Defender", NativeDefender.IntervalSeconds, new NativeDefender().Collect, NativeDefender.DeadlineSeconds);
        // Windows activation of 4.22.0: the same kind of fixed, argument-free broker read, once an hour; it only reads.
        Add("Windows license", NativeWindowsLicense.IntervalSeconds, new NativeWindowsLicense().Collect, NativeWindowsLicense.DeadlineSeconds);
        scheduler = new(collectors);
    }

    private void Add(string name, int seconds, Func<JsonObject> collect, int deadlineSeconds = DefaultDeadlineSeconds, bool keepLastValue = false) => collectors.Add(new(name, TimeSpan.FromSeconds(seconds), TimeSpan.FromSeconds(deadlineSeconds), privileged is not null && PrivilegedProviders.Contains(name) ? () => privileged(name, deadlineSeconds) : collect,
        line => LocalStore.Log(root, AgentHttpTransport.RedactDiagnostic(line, config)), keepLastValue));
    internal void RequestRefresh() { services.RequestRefresh(); foreach (var collector in collectors) collector.RequestRefresh(); }
    internal Task RunAsync(CancellationToken token) => scheduler.RunAsync(token);
    internal async Task StopAsync()
    {
        await scheduler.StopAsync();
        var pending = collectors[0].CurrentTask;
        // A native provider may ignore cancellation. Never wait on its lock in
        // service shutdown; release its PDH query when that one worker returns.
        if (pending is { IsCompleted: false }) _ = pending.ContinueWith(_ => performance.Dispose(), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        else performance.Dispose();
        gpu.DisposeWhenComplete(gpuCollector.CurrentTask);
    }

    // Collection starts independently. At boot we publish real native CPU/RAM/
    // uptime immediately, with explicit unavailable inventories, rather than
    // waiting for every Windows provider to finish its initialization.
    internal async Task<JsonObject> CollectAsync(CancellationToken token)
    {
        await gate.WaitAsync(token);
        try
        {
            token.ThrowIfCancellationRequested();
            var snapshot = CreateBaseSnapshot(root, config);
            snapshot["cpu"] = Cpu();
            var errors = new JsonArray();
            ApplyCollectors(snapshot, collectors, DateTimeOffset.UtcNow, errors, (key, list) => { lock (softwareGate) lists[key] = list.DeepClone().AsObject(); });
            if (snapshot["processInventory"]?["complete"]?.GetValue<bool>() != true && errors.Count < 20) errors.Add("The process list is being initialized or is not available at the moment.");
            var updates = Path.Combine(root, "updates.json");
            try
            {
                if (privileged is not null) { if ((await Task.Run(() => privileged("updates", DefaultDeadlineSeconds), token))["updates"] is JsonObject scanned) snapshot["updates"] = NormalizeUpdates(scanned); }
                else if (File.Exists(updates) && new FileInfo(updates).Length <= 150000) snapshot["updates"] = NormalizeUpdates(JsonNode.Parse(await File.ReadAllTextAsync(updates, token)));
            } catch (Exception) when (!token.IsCancellationRequested) { if (errors.Count < 20) errors.Add("The last update inventory could not be read."); }
            NativePowerSchedule.ApplyCurrentState(snapshot);
            snapshot["collectionErrors"] = errors;
            LimitSnapshot(snapshot);
            return snapshot;
        }
        finally { gate.Release(); }
    }

    internal static JsonObject CreateBaseSnapshot(string root, JsonObject config)
    {
        var memory = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
        bool hasMemory = OperatingSystem.IsWindows() && GlobalMemoryStatusEx(ref memory);
        string os = "Windows", build = "", product = "";
        JsonObject? osInfo = null;
        if (OperatingSystem.IsWindows())
        {
            using var version = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
            build = Limit(version?.GetValue("CurrentBuildNumber")?.ToString());
            product = Limit(version?.GetValue("ProductName")?.ToString());
            os = product;
            if (!IsServer() && int.TryParse(build, out int number) && number >= 22000) os = product.Replace("Windows 10", "Windows 11", StringComparison.OrdinalIgnoreCase);
            osInfo = OsInfo(name => version?.GetValue(name));
        }
        var now = DateTimeOffset.UtcNow;
        var reboot = NativeRebootStatus.Read();
        string mode = config["mode"]?.GetValue<string>() == "Management" ? "Management" : "ReadOnly";
        return new JsonObject
        {
            ["hostname"] = Limit(Environment.MachineName), ["os"] = os, ["build"] = build,
            ["manufacturer"] = "", ["model"] = "", ["domain"] = "", ["cores"] = Math.Clamp(Environment.ProcessorCount, 1, 8192),
            ["memoryGb"] = hasMemory ? Math.Round(memory.TotalPhysical / 1073741824d, 1) : 0,
            ["cpu"] = null, ["memory"] = hasMemory ? Math.Clamp((double)memory.MemoryLoad, 0, 100) : 0,
            ["uptimeSeconds"] = Math.Max(0, Environment.TickCount64 / 1000d), ["rebootPending"] = reboot.Pending,
            ["rebootReasons"] = reboot.ToJson()["rebootReasons"]!.DeepClone(), ["pendingFileOperationsCount"] = reboot.PendingFileOperationsCount,
            ["management"] = mode == "Management", ["mode"] = mode, ["protocolVersion"] = 3, ["agentVersion"] = Program.Version,
            ["agentCapabilities"] = new JsonArray(), ["disks"] = new JsonArray(), ["services"] = new JsonArray(), ["processes"] = new JsonArray(),
            ["processInventory"] = new JsonObject { ["collectedAt"] = now.ToString("O"), ["count"] = 0, ["truncated"] = false, ["complete"] = false, ["intervalSeconds"] = RefreshSeconds, ["error"] = "The process list is being initialized." },
            ["events"] = new JsonArray(), ["networks"] = new JsonArray(), ["hotfixes"] = new JsonArray(), ["collectionErrors"] = new JsonArray("The system inventory is being initialized; available data loads independently."),
            ["osInfo"] = osInfo, ["softwareChecksum"] = null
        };
    }

    /// <summary>
    /// The values that decide the lifecycle of the operating system, from
    /// HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion: EditionID, InstallationType,
    /// DisplayVersion (else ReleaseId), UBR, ProductName and CurrentBuild. Strings
    /// have at most 100 characters; a missing value is null.
    /// </summary>
    internal static JsonObject OsInfo(Func<string, object?> value)
    {
        string? Text(string name) { var text = Convert.ToString(value(name), CultureInfo.InvariantCulture)?.Trim(); return string.IsNullOrEmpty(text) ? null : text[..Math.Min(100, text.Length)]; }
        object? ubr = value("UBR");
        long? patch = ubr is int or long or uint ? Convert.ToInt64(ubr, CultureInfo.InvariantCulture) : null;
        return new JsonObject
        {
            ["editionId"] = Text("EditionID"), ["installationType"] = Text("InstallationType"), ["displayVersion"] = Text("DisplayVersion") ?? Text("ReleaseId"),
            ["ubr"] = patch is >= 0 and <= uint.MaxValue ? JsonValue.Create(patch.Value) : null, ["productName"] = Text("ProductName"), ["currentBuild"] = Text("CurrentBuild")
        };
    }

    internal static bool IsServer()
    {
        if (!OperatingSystem.IsWindows()) return false;
        using var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\ProductOptions");
        return key?.GetValue("ProductType")?.ToString() is string value && !value.Equals("WinNT", StringComparison.OrdinalIgnoreCase);
    }
    private double? Cpu()
    {
        if (!OperatingSystem.IsWindows() || !GetSystemTimes(out var idle, out var kernel, out var user)) return null;
        ulong i = idle.Value, k = kernel.Value, u = user.Value;
        double? result = null;
        if (previousIdle is ulong pi && previousKernel is ulong pk && previousUser is ulong pu && i >= pi && k >= pk && u >= pu)
        {
            double total = (k - pk) + (double)(u - pu), free = i - pi;
            if (total > 0) result = Math.Round(Math.Clamp(100d * (total - free) / total, 0, 100), 2);
        }
        previousIdle = i; previousKernel = k; previousUser = u; return result;
    }
    private static JsonObject ComputerInventory()
    {
        var computer = Query(@"root\cimv2", "SELECT Manufacturer,Model,Domain,NumberOfLogicalProcessors,TotalPhysicalMemory FROM Win32_ComputerSystem", 1).First();
        var hotfixes = Query(@"root\cimv2", "SELECT HotFixID,InstalledOn FROM Win32_QuickFixEngineering", 1000).Select(row => (Row: row, Date: HotfixDate(Text(row, "InstalledOn")))).OrderByDescending(x => x.Date, StringComparer.Ordinal).Take(20);
        return new JsonObject { ["manufacturer"] = Text(computer, "Manufacturer"), ["model"] = Text(computer, "Model"), ["domain"] = Text(computer, "Domain"), ["cores"] = Math.Clamp((int)Number(computer, "NumberOfLogicalProcessors", Environment.ProcessorCount), 1, 8192), ["memoryGb"] = Math.Round(Math.Max(0, Number(computer, "TotalPhysicalMemory")) / 1073741824d, 1), ["hotfixes"] = new JsonArray(hotfixes.Select(row => (JsonNode)new JsonObject { ["id"] = Text(row.Row, "HotFixID"), ["installedOn"] = row.Date }).ToArray()) };
    }
    private static string HotfixDate(string value)
    {
        if (DateTime.TryParseExact(value, new[] { "yyyy-MM-dd", "M/d/yyyy", "MM/dd/yyyy", "d.M.yyyy", "dd.MM.yyyy", "yyyyMMdd" }, CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)) return date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (value.Length == 16 && long.TryParse(value, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out long ticks)) try { return DateTime.FromFileTimeUtc(ticks).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); } catch (ArgumentOutOfRangeException) { }
        return "";
    }
    private static JsonObject Networks() => NativeNetworkInventory.Telemetry();

    private static JsonObject LocalAccounts()
    {
        var computer = Query(@"root\cimv2", "SELECT DomainRole FROM Win32_ComputerSystem", 1).First();
        if (Number(computer, "DomainRole") >= 4) return new JsonObject { ["localUsers"] = new JsonArray(), ["localGroups"] = new JsonArray() };
        var profiles = Query(@"root\cimv2", "SELECT Name,LastLogon,FullName FROM Win32_NetworkLoginProfile", 1000).GroupBy(x => Text(x, "Name"), StringComparer.OrdinalIgnoreCase).ToDictionary(x => x.Key, x => x.First(), StringComparer.OrdinalIgnoreCase);
        var users = new JsonArray(Query(@"root\cimv2", "SELECT Name,SID,Disabled,FullName,Description,PasswordExpires FROM Win32_UserAccount WHERE LocalAccount=TRUE", 500).Select(row => { string name = Text(row, "Name"); profiles.TryGetValue(name, out var profile); return (JsonNode)new JsonObject { ["name"] = name, ["sid"] = Text(row, "SID"), ["enabled"] = !Boolean(row, "Disabled"), ["fullName"] = Text(row, "FullName"), ["description"] = Text(row, "Description"), ["passwordExpires"] = Boolean(row, "PasswordExpires"), ["lastLogon"] = profile is null ? "" : Date(profile, "LastLogon") }; }).ToArray());
        var groups = new JsonArray();
        foreach (var row in Query(@"root\cimv2", "SELECT Name,SID FROM Win32_Group WHERE LocalAccount=TRUE", 100))
        {
            string name = Text(row, "Name"); var members = new JsonArray();
            uint resume = 0; int status = NetLocalGroupGetMembers(null, name, 3, out var buffer, 65536, out int count, out _, ref resume);
            try
            {
                if (status is not (0 or 234)) throw new Win32Exception(status);
                int size = Marshal.SizeOf<LocalGroupMember>();
                for (int i = 0; i < Math.Min(count, 100); i++) members.Add(Limit(Marshal.PtrToStringUni(Marshal.PtrToStructure<LocalGroupMember>(IntPtr.Add(buffer, i * size)).Name)));
            }
            finally { if (buffer != IntPtr.Zero) NetApiBufferFree(buffer); }
            groups.Add(new JsonObject { ["name"] = name, ["sid"] = Text(row, "SID"), ["members"] = members });
        }
        return new JsonObject { ["localUsers"] = users, ["localGroups"] = groups };
    }

    private static JsonObject Pagefile()
    {
        var computer = Query(@"root\cimv2", "SELECT AutomaticManagedPagefile FROM Win32_ComputerSystem", 1).First();
        var usage = Query(@"root\cimv2", "SELECT Name,AllocatedBaseSize,CurrentUsage,PeakUsage FROM Win32_PageFileUsage", 20);
        var settings = Query(@"root\cimv2", "SELECT Name,InitialSize,MaximumSize FROM Win32_PageFileSetting", 20);
        if (settings.Count == 0) settings = usage;
        var files = new JsonArray(settings.Select(row => { var current = usage.FirstOrDefault(u => Text(u, "Name").Equals(Text(row, "Name"), StringComparison.OrdinalIgnoreCase)) ?? row; return (JsonNode)new JsonObject { ["name"] = Text(row, "Name"), ["initialMb"] = Math.Max(0, Number(row, "InitialSize")), ["maximumMb"] = Math.Max(0, Number(row, "MaximumSize")), ["allocatedMb"] = Math.Max(0, Number(current, "AllocatedBaseSize")), ["currentUsageMb"] = Math.Max(0, Number(current, "CurrentUsage")), ["peakUsageMb"] = Math.Max(0, Number(current, "PeakUsage")) }; }).ToArray());
        return new JsonObject { ["pagefile"] = new JsonObject { ["automatic"] = Boolean(computer, "AutomaticManagedPagefile"), ["files"] = files } };
    }

    internal static JsonObject Security()
    {
        var computer = Query(@"root\cimv2", "SELECT PartOfDomain,DomainRole FROM Win32_ComputerSystem", 1).First();
        var defender = new JsonObject { ["available"] = false, ["enabled"] = false, ["signatureAt"] = "", ["realTimeProtection"] = false };
        try
        {
            var status = Query(@"root\Microsoft\Windows\Defender", "SELECT AntivirusEnabled,AntivirusSignatureLastUpdated,RealTimeProtectionEnabled FROM MSFT_MpComputerStatus", 1).FirstOrDefault();
            if (status is not null) defender = new JsonObject { ["available"] = true, ["enabled"] = Boolean(status, "AntivirusEnabled"), ["signatureAt"] = Date(status, "AntivirusSignatureLastUpdated"), ["realTimeProtection"] = Boolean(status, "RealTimeProtectionEnabled") };
        }
        catch (Exception) { /* Defender is an optional Windows component. */ }
        var profiles = new JsonArray(); object? policy = null;
        try
        {
            policy = Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2", true)!);
            dynamic p = policy!;
            foreach (var profile in new[] { (1, "Domain"), (2, "Private"), (4, "Public") }) profiles.Add(new JsonObject { ["name"] = profile.Item2, ["enabled"] = (bool)p.FirewallEnabled[profile.Item1] });
        }
        finally { Release(policy); }
        using var rdp = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Terminal Server");
        var result = new JsonObject { ["security"] = new JsonObject { ["domainJoined"] = Boolean(computer, "PartOfDomain"), ["domainRole"] = Math.Clamp((int)Number(computer, "DomainRole"), 0, 5), ["rdpEnabled"] = Convert.ToInt32(rdp?.GetValue("fDenyTSConnections") ?? 1) == 0, ["firewall"] = profiles, ["defender"] = defender, ["lastBoot"] = DateTimeOffset.UtcNow.AddMilliseconds(-Math.Max(0, Environment.TickCount64)).ToString("O") } };
        // 4.19.0: the directory for the AD sign-in of plugin changes, read through LSA without network; left out when LSA does not answer.
        if (PluginIdentity.DirectoryJson() is JsonObject directory) result["security"]!["directory"] = directory;
        return result;
    }

    internal static JsonObject FirewallRules()
    {
        // PolicyStoreSource is populated only by traced ActiveStore retrieval;
        // it is not a reliable WQL predicate for the default local store. The
        // persistent policy's registry value names are the technical rule IDs.
        using var persistent = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules");
        var localIds = new HashSet<string>(persistent?.GetValueNames() ?? [], StringComparer.OrdinalIgnoreCase);
        var localRows = Query(@"root\StandardCimv2", "SELECT InstanceID,DisplayName,Enabled,Direction,Action FROM MSFT_NetFirewallRule", 20000).Where(row => localIds.Contains(Text(row, "InstanceID"))).ToArray();
        if (localRows.Select(row => Text(row, "InstanceID")).Distinct(StringComparer.OrdinalIgnoreCase).Count() != localRows.Length || localRows.Length < Math.Min(300, localIds.Count)) throw new InvalidDataException("The local firewall rule catalog is incomplete at the moment.");
        var rows = localRows.OrderByDescending(x => Number(x, "Enabled") == 1).Take(300);
        var ports = Query(@"root\StandardCimv2", "SELECT InstanceID,Protocol,LocalPort FROM MSFT_NetProtocolPortFilter", 15000).GroupBy(x => Text(x, "InstanceID"), StringComparer.OrdinalIgnoreCase).ToDictionary(x => x.Key, x => x.First(), StringComparer.OrdinalIgnoreCase);
        var addresses = Query(@"root\StandardCimv2", "SELECT InstanceID,RemoteAddress FROM MSFT_NetAddressFilter", 15000).GroupBy(x => Text(x, "InstanceID"), StringComparer.OrdinalIgnoreCase).ToDictionary(x => x.Key, x => x.First(), StringComparer.OrdinalIgnoreCase);
        return new JsonObject { ["firewallRules"] = new JsonArray(rows.Select(row => { string id = Text(row, "InstanceID"); ports.TryGetValue(id, out var port); addresses.TryGetValue(id, out var address); return (JsonNode)new JsonObject { ["name"] = id, ["displayName"] = Text(row, "DisplayName"), ["enabled"] = Number(row, "Enabled") == 1, ["direction"] = Number(row, "Direction") == 1 ? "Inbound" : "Outbound", ["action"] = Number(row, "Action") switch { 2 => "Allow", 3 => "AllowBypass", 4 => "Block", _ => "Unknown" }, ["protocol"] = port is null ? "" : Text(port, "Protocol"), ["port"] = port is null ? "" : Limit(string.Join(",", Strings(port, "LocalPort", 100))), ["remoteAddress"] = address is null ? "" : Limit(string.Join(",", Strings(address, "RemoteAddress", 100))) }; }).ToArray()) };
    }

    internal static JsonObject Tasks()
    {
        object? scheduler = null, initial = null; var result = new JsonArray(); var folders = new Stack<object>();
        try
        {
            scheduler = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", true)!); dynamic service = scheduler!; service.Connect(); initial = service.GetFolder("\\"); folders.Push(initial); initial = null;
            int visited = 0;
            while (folders.Count > 0 && visited++ < 500 && result.Count < 200)
            {
                object folder = folders.Pop(); object? tasks = null, children = null;
                try
                {
                    dynamic f = folder; tasks = f.GetTasks(1); dynamic list = tasks;
                    for (int i = 1; i <= (int)list.Count && result.Count < 200; i++)
                    {
                        object? task = null;
                        try { task = list.Item(i); dynamic t = task; string full = (string)t.Path; int slash = full.LastIndexOf('\\'); result.Add(new JsonObject { ["name"] = Limit((string)t.Name), ["path"] = Limit(full[..(slash + 1)]), ["state"] = (int)t.State switch { 1 => "Disabled", 2 => "Queued", 3 => "Ready", 4 => "Running", _ => "Unknown" }, ["lastRun"] = ComDate(t.LastRunTime), ["nextRun"] = ComDate(t.NextRunTime), ["lastResult"] = (long)t.LastTaskResult }); } finally { Release(task); }
                    }
                    children = f.GetFolders(0); dynamic childList = children;
                    for (int i = 1; i <= (int)childList.Count && folders.Count < 500; i++) folders.Push(childList.Item(i));
                }
                finally { Release(children); Release(tasks); Release(folder); }
            }
        }
        finally { while (folders.Count > 0) Release(folders.Pop()); Release(initial); Release(scheduler); }
        return new JsonObject { ["tasks"] = result };
    }
    private static string ComDate(object value) => value is DateTime date && date.Year > 1900 ? date.ToUniversalTime().ToString("O") : "";
    private static void Release(object? value) { if (value is not null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value); }

    /// <summary>
    /// Merges every collector's current value into the snapshot and sets
    /// collectorErrors: one entry per collector whose most recent run failed or
    /// stalled. A failing collector never removes the fields of the others.
    /// </summary>
    internal static void ApplyCollectors(JsonObject snapshot, IEnumerable<TelemetryCollectorSlot> collectors, DateTimeOffset now, JsonArray errors, Action<string, JsonObject>? keepList = null)
    {
        var failures = new JsonArray();
        foreach (var collector in collectors)
        {
            var result = collector.Read(now);
            foreach (string key in ListKeys)
                if (result.Value?[key] is JsonObject list) keepList?.Invoke(key, list);
            if (result.Value is not null) MergeCollectorSnapshot(snapshot, result.Value, errors);
            if (result.Error is not null && errors.Count < 20) errors.Add(result.Error);
            if (result.Failure is not null && failures.Count < MaximumCollectorErrors) failures.Add(result.Failure.ToJson());
        }
        snapshot["collectorErrors"] = failures;
    }

    internal static void MergeCollectorSnapshot(JsonObject snapshot, JsonObject result, JsonArray errors)
    {
        // Keys with "_" are collector metadata (warnings, the software list), never snapshot fields.
        foreach (var pair in result)
            if (!pair.Key.StartsWith('_')) snapshot[pair.Key] = pair.Value?.DeepClone();
        if (result["_collectionWarnings"] is JsonArray warnings)
            foreach (var warning in warnings.Take(8))
                if (errors.Count < 20 && warning is JsonValue text && text.TryGetValue<string>(out var message)) errors.Add(Limit(message));
    }

    internal static void LimitSnapshot(JsonObject snapshot)
    {
        static void LimitValues(JsonNode? node, string field = "")
        {
            if (node is JsonObject value) foreach (var key in value.Select(p => p.Key).ToArray()) { if (value[key] is JsonValue text && text.TryGetValue<string>(out string? s)) value[key] = Limit(s, key == "message" ? 3500 : key is "collectedAt" or "startedAt" ? 60 : 500); else LimitValues(value[key], key); }
            else if (node is JsonArray array) for (int i = 0; i < array.Count; i++) { if (array[i] is JsonValue text && text.TryGetValue<string>(out string? s)) array[i] = Limit(s); else LimitValues(array[i], field); }
        }
        LimitValues(snapshot);
        if (snapshot["collectorErrors"] is JsonArray failures && failures.Count > MaximumCollectorErrors) snapshot["collectorErrors"] = new JsonArray(failures.Take(MaximumCollectorErrors).Select(x => x?.DeepClone()).ToArray());
        if (Encoding.UTF8.GetByteCount(snapshot.ToJsonString()) <= 1500000) return;
        snapshot["localGroups"] = new JsonArray(); snapshot["firewallRules"] = new JsonArray(); snapshot["tasks"] = new JsonArray();
        foreach (var item in new[] { ("services", 300), ("events", 10) }) if (snapshot[item.Item1] is JsonArray array) snapshot[item.Item1] = new JsonArray(array.Take(item.Item2).Select(x => x?.DeepClone()).ToArray());
        var errors = snapshot["collectionErrors"] as JsonArray ?? new JsonArray(); snapshot["collectionErrors"] = new JsonArray(new[] { (JsonNode?)JsonValue.Create("Very large inventory: groups, firewall rules and tasks were shortened for this heartbeat.") }.Concat(errors.Take(19).Select(x => x?.DeepClone())).ToArray());
    }

    internal static JsonObject NormalizeUpdates(JsonNode? node)
    {
        if (node is not JsonObject source || source["checkedAt"] is not JsonValue checkedAt || !checkedAt.TryGetValue<string>(out var date) || source["pendingCount"] is not JsonValue count || !count.TryGetValue<int>(out int pending) || pending < 0 || source["items"] is not JsonArray items) throw new InvalidDataException("Invalid update inventory.");
        var result = new JsonArray();
        foreach (var entry in items.Take(100))
        {
            if (entry is not JsonObject item || item["id"] is not JsonValue idValue || !idValue.TryGetValue<string>(out var id) || !Guid.TryParse(id, out var guid) || item["rebootRequired"] is not JsonValue reboot || !reboot.TryGetValue<bool>(out bool required)) throw new InvalidDataException("Invalid update inventory entry.");
            string Field(string field) => item[field] switch { null => "", JsonValue value when value.TryGetValue<string>(out string? text) => Limit(text), _ => throw new InvalidDataException("Invalid update field.") };
            result.Add(new JsonObject { ["id"] = guid.ToString("D"), ["title"] = Field("title"), ["kb"] = Field("kb"), ["severity"] = Field("severity"), ["rebootRequired"] = required });
        }
        return new JsonObject { ["checkedAt"] = Limit(date), ["pendingCount"] = pending, ["items"] = result };
    }

    [StructLayout(LayoutKind.Sequential)] private struct MemoryStatus { public uint Length, MemoryLoad; public ulong TotalPhysical, AvailablePhysical, TotalPagefile, AvailablePagefile, TotalVirtual, AvailableVirtual, AvailableExtendedVirtual; }
    [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint Low, High; public ulong Value => ((ulong)High << 32) | Low; }
    [StructLayout(LayoutKind.Sequential)] private struct LocalGroupMember { public IntPtr Name; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalMemoryStatusEx(ref MemoryStatus value);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetSystemTimes(out FileTime idle, out FileTime kernel, out FileTime user);
    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)] private static extern int NetLocalGroupGetMembers(string? server, string name, int level, out IntPtr buffer, int preferred, out int read, out int total, ref uint resume);
    [DllImport("Netapi32.dll")] private static extern int NetApiBufferFree(IntPtr buffer);
}

internal sealed class NativeProcessInventory(string root)
{
    private readonly Dictionary<string, ProcessCpuSample> samples = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (string Sid, string? User)> owners = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string?> paths = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> accountNames = new(StringComparer.Ordinal);
    private readonly object gate = new();
    internal JsonObject Collect()
    {
        lock (gate)
        {
            var at = DateTimeOffset.UtcNow; var rows = new JsonArray(); int count = 0;
            var nextSamples = new Dictionary<string, ProcessCpuSample>(StringComparer.Ordinal); var nextOwners = new Dictionary<string, (string Sid, string? User)>(StringComparer.Ordinal); var nextPaths = new Dictionary<string, string?>(StringComparer.Ordinal);
            try
            {
                var parentMap = Parents(); var ancestors = new HashSet<int>(); int ancestor = Environment.ProcessId;
                for (int depth = 0; depth < 12 && ancestor > 0 && ancestors.Add(ancestor); depth++) if (!parentMap.TryGetValue(ancestor, out ancestor)) break;
                var processes = Process.GetProcesses().OrderBy(p => p.Id).ToArray(); count = processes.Length; int bytes = 2;
                foreach (var process in processes)
                {
                    using (process)
                    {
                        if (rows.Count >= 5000) continue;
                        int id = process.Id; string name = "PID " + id; string? path = null, started = null, owner = null, sid = null, identity = null; int session = 0; double memory = 0; double? cpuSeconds = null, cpuPercent = null; bool protectedProcess = true;
                        try { name = process.ProcessName + ".exe"; } catch { }
                        try { memory = Math.Round(Math.Max(0, process.WorkingSet64) / 1048576d, 2); } catch { }
                        try { session = Math.Max(0, process.SessionId); } catch { }
                        try { var start = process.StartTime.ToUniversalTime(); started = start.ToString("O"); identity = id + "|" + start.Ticks; cpuSeconds = Math.Max(0, Finite(process.TotalProcessorTime.TotalSeconds)); } catch { }
                        if (identity is not null)
                        {
                            // MainModule walks executable modules on every
                            // snapshot. Query the image once per exact process
                            // identity using a limited-information handle.
                            if (!paths.TryGetValue(identity, out path)) path = ImagePath(id);
                            nextPaths[identity] = path;
                            if (cpuSeconds is double seconds) { if (samples.TryGetValue(identity, out var previous)) cpuPercent = ComputeCpu(previous.Seconds, previous.At, seconds, at, Environment.ProcessorCount); nextSamples[identity] = new(seconds, at); }
                            if (!owners.TryGetValue(identity, out var account)) account = Owner(process);
                            owner = account.User; sid = account.Sid; nextOwners[identity] = account;
                            bool known = id <= 4 || ancestors.Contains(id) || CriticalNames.Contains(name) || path is not null && path.StartsWith(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
                            if (!known) protectedProcess = Protected(id);
                        }
                        var row = new JsonObject { ["name"] = Limit(name, 128), ["pid"] = id, ["memoryMb"] = memory, ["cpuSeconds"] = cpuSeconds, ["cpuPercent"] = cpuPercent, ["parentPid"] = Math.Max(0, parentMap.GetValueOrDefault(id)), ["sessionId"] = session, ["user"] = owner is null ? null : Limit(owner), ["sid"] = sid, ["path"] = path is null ? null : Limit(path), ["protected"] = protectedProcess };
                        if (started is not null) row["startedAt"] = started;
                        int length = Encoding.UTF8.GetByteCount(row.ToJsonString()) + 1; if (bytes + length > 900000) continue; bytes += length; rows.Add(row);
                    }
                }
                samples.Clear(); foreach (var sample in nextSamples) samples[sample.Key] = sample.Value;
                owners.Clear(); foreach (var account in nextOwners) owners[account.Key] = account.Value;
                paths.Clear(); foreach (var path in nextPaths) paths[path.Key] = path.Value;
                return new JsonObject { ["processes"] = rows, ["processInventory"] = new JsonObject { ["collectedAt"] = at.ToString("O"), ["count"] = count, ["truncated"] = rows.Count < count, ["complete"] = true, ["intervalSeconds"] = NativeTelemetryCollector.RefreshSeconds } };
            }
            catch (Exception)
            {
                samples.Clear(); owners.Clear(); paths.Clear(); return new JsonObject { ["processes"] = new JsonArray(), ["processInventory"] = new JsonObject { ["collectedAt"] = at.ToString("O"), ["count"] = 0, ["truncated"] = false, ["complete"] = false, ["intervalSeconds"] = NativeTelemetryCollector.RefreshSeconds, ["error"] = "The process list could not be read." } };
            }
        }
    }
    internal static double? ComputeCpu(double previous, DateTimeOffset previousAt, double current, DateTimeOffset at, int cores)
    {
        double elapsed = (at - previousAt).TotalSeconds, delta = current - previous;
        return double.IsFinite(delta) && elapsed > 0 && elapsed <= 120 && delta >= 0 ? Math.Round(Math.Clamp(100 * delta / elapsed / Math.Max(1, cores), 0, 100), 2) : null;
    }
    private (string Sid, string? User) Owner(Process process)
    {
        IntPtr token = IntPtr.Zero, buffer = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(process.Handle, 8, out token)) return ("", null);
            GetTokenInformation(token, 1, IntPtr.Zero, 0, out int needed); if (needed <= 0 || needed > 65536) return ("", null);
            buffer = Marshal.AllocHGlobal(needed); if (!GetTokenInformation(token, 1, buffer, needed, out _)) return ("", null);
            var pointer = Marshal.ReadIntPtr(buffer); var sid = new SecurityIdentifier(pointer).Value;
            if (!accountNames.TryGetValue(sid, out string? name))
            {
                var user = new StringBuilder(256); uint userSize = 256; var domain = new StringBuilder(256); uint domainSize = 256;
                name = LookupAccountSid(null, pointer, user, ref userSize, domain, ref domainSize, out _) ? (domain.Length > 0 ? domain + "\\" : "") + user : sid;
                if (accountNames.Count < 10000) accountNames[sid] = name;
            }
            return (sid, name);
        }
        catch { return ("", null); }
        finally { if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer); if (token != IntPtr.Zero) CloseHandle(token); }
    }
    private static string? ImagePath(int id)
    {
        IntPtr handle = OpenProcess(0x1000, false, id);
        if (handle == IntPtr.Zero) return null;
        try
        {
            var buffer = new StringBuilder(32768); uint length = (uint)buffer.Capacity;
            return QueryFullProcessImageName(handle, 0, buffer, ref length) ? buffer.ToString() : null;
        }
        finally { CloseHandle(handle); }
    }
    private static bool Protected(int id)
    {
        IntPtr handle = OpenProcess(0x1000, false, id);
        if (handle == IntPtr.Zero) return true;
        try { return !IsProcessCritical(handle, out bool critical) || critical; }
        finally { CloseHandle(handle); }
    }
    private static readonly HashSet<string> CriticalNames = new(new[] { "System.exe", "Registry.exe", "Memory Compression.exe", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe", "lsaiso.exe", "ServerDesk.Agent.exe", "ServerDesk.Updater.exe" }, StringComparer.OrdinalIgnoreCase);
    private static Dictionary<int, int> Parents()
    {
        var result = new Dictionary<int, int>(); var snapshot = CreateToolhelp32Snapshot(2, 0); if (snapshot == new IntPtr(-1)) return result;
        try
        {
            var row = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>(), Executable = "" };
            if (Process32First(snapshot, ref row)) do { if (row.Id <= int.MaxValue && row.ParentId <= int.MaxValue) result[(int)row.Id] = (int)row.ParentId; } while (Process32Next(snapshot, ref row));
        }
        finally { CloseHandle(snapshot); }
        return result;
    }
    private readonly record struct ProcessCpuSample(double Seconds, DateTimeOffset At);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct ProcessEntry { public uint Size, Usage, Id; public UIntPtr Heap; public uint ModuleId, Threads, ParentId; public int BasePriority; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Executable; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint id);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32FirstW")] private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry row);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32NextW")] private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry row);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessCritical(IntPtr process, out bool critical);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int id);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "QueryFullProcessImageNameW")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint length);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr information, int length, out int needed);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool LookupAccountSid(string? system, IntPtr sid, StringBuilder name, ref uint nameLength, StringBuilder domain, ref uint domainLength, out int kind);
}
