using System.Globalization;
using System.Management;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// WMI, registry/SCM, networking and Task Scheduler are Windows providers. The
// collector never launches PowerShell, creates a helper script, or shells out.
// A stuck provider has one outstanding collection at most, including after a
// policy refresh. Returning an error keeps a partial scan from becoming a new
// baseline or being mistaken for deletion of all its resources.
internal static class NativeDriftInventory
{
    private static readonly object Gate = new();
    private static readonly Dictionary<string, Task<JsonArray>> Flights = new(StringComparer.Ordinal);
    private const int Maximum = 5000;

    internal static async Task<JsonObject> CollectAsync(JsonArray requested, CancellationToken token)
    {
        var result = new JsonObject { ["errors"] = new JsonArray() };
        foreach (string category in requested.Select(node => node?.GetValue<string>() ?? "").Distinct(StringComparer.Ordinal))
        {
            token.ThrowIfCancellationRequested();
            try
            {
                Task<JsonArray> flight;
                lock (Gate)
                {
                    if (!Flights.TryGetValue(category, out flight!) || flight.IsCompleted)
                        Flights[category] = flight = Task.Run(() => Collect(category));
                }
                result[category] = (await flight.WaitAsync(TimeSpan.FromSeconds(90), token)).DeepClone();
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
            catch (Exception exception)
            {
                result["errors"]!.AsArray().Add("Configuration not completely readable: " + category + " (" + exception.GetType().Name + ").");
            }
        }
        return result;
    }

    private static JsonArray Collect(string category) => category switch
    {
        "services" => Services(),
        "roles" => Roles(),
        "network" => Network(),
        "firewall" => Firewall(),
        "localGroups" => LocalGroups(),
        "tasks" => Tasks(),
        // Run, RunOnce, Startup folders and Winlogon with masked commands (NativeAutostartInventory).
        "autostart" => new NativeAutostartInventory().Drift(),
        _ => throw new InvalidDataException("Unknown configuration category.")
    };

    private static List<Dictionary<string, object?>> Query(string ns, string wql)
    {
        var rows = WindowsManagement.Query(ns, wql, Maximum + 1, TimeSpan.FromSeconds(5));
        if (rows.Count > Maximum) throw new InvalidDataException("Configuration inventory exceeds 5,000 entries.");
        return rows;
    }
    private static JsonArray Array(IEnumerable<string> values) => new(values.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());
    private static JsonArray Objects(IEnumerable<JsonObject> values)
    {
        var result = new JsonArray(); int bytes = 0;
        foreach (JsonObject value in values)
        {
            bytes += Encoding.UTF8.GetByteCount(value.ToJsonString());
            if (result.Count >= Maximum || bytes > 780000) throw new InvalidDataException("Configuration inventory exceeds the bounded report size.");
            result.Add(value);
        }
        return result;
    }

    private static string[] Strings(Dictionary<string, object?> row, string field)
    {
        if (row.GetValueOrDefault(field) is not System.Collections.IEnumerable values || row.GetValueOrDefault(field) is string)
            throw new InvalidDataException("Configuration array field could not be read: " + field + ".");
        var result = values.Cast<object?>().Select(value => Convert.ToString(value, CultureInfo.InvariantCulture) ?? "").Take(5001).ToArray();
        if (result.Length > 5000 || result.Any(value => value.Length > 4096)) throw new InvalidDataException("Configuration array exceeds its bounded resource size.");
        return result;
    }

    private static JsonArray OptionalStrings(Dictionary<string, object?> row, string field)
    {
        if (!row.ContainsKey(field)) throw new InvalidDataException("Configuration array field could not be read: " + field + ".");
        // Port filters apply only to TCP/UDP. Preserve the old @($null) sentinel
        // for a provider's genuinely inapplicable field, not a missing property.
        return row[field] is null ? new JsonArray((JsonNode?)null) : Array(Strings(row, field));
    }

    private static string StrictText(Dictionary<string, object?> row, string field, int maximum = 32768)
    {
        if (!row.ContainsKey(field)) throw new InvalidDataException("Configuration field could not be read: " + field + ".");
        string value = Convert.ToString(row[field], CultureInfo.InvariantCulture) ?? "";
        if (value.Length > maximum) throw new InvalidDataException("Configuration field exceeds its bounded report size: " + field + ".");
        return value;
    }
    private static JsonArray Services() => Objects(Query(@"root\cimv2", "SELECT Name,StartMode,PathName,StartName FROM Win32_Service")
        .OrderBy(row => WindowsManagement.Text(row, "Name"), StringComparer.OrdinalIgnoreCase)
        .Select(row => new JsonObject { ["name"] = StrictText(row, "Name"), ["startMode"] = StrictText(row, "StartMode"), ["path"] = StrictText(row, "PathName"), ["account"] = StrictText(row, "StartName") }));

    private static JsonArray Roles()
    {
        // Read the native product identity without another WMI provider scan.
        // Unknown identity must fail the category rather than quietly selecting
        // client DISM names as a new server-role baseline.
        using var product = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\ProductOptions", false)
            ?? throw new InvalidDataException("Operating system inventory unavailable.");
        string kind = product.GetValue("ProductType") as string ?? throw new InvalidDataException("Operating system identity unavailable.");
        bool server = kind.Equals("ServerNT", StringComparison.OrdinalIgnoreCase) || kind.Equals("LanmanNT", StringComparison.OrdinalIgnoreCase);
        if (!server && !kind.Equals("WinNT", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Operating system identity unavailable.");
        // Keep exact ServerManager role names on servers and DISM feature names
        // on clients; numeric Win32_ServerFeature IDs omit role services.
        var features = NativeFeatures.ListAsync(server, CancellationToken.None).GetAwaiter().GetResult();
        return Array(features.OfType<JsonObject>().Where(feature => feature["installed"]?.GetValue<bool>() == true)
            .Select(feature => feature["name"]!.GetValue<string>()).Order(StringComparer.OrdinalIgnoreCase));
    }

    private static JsonArray Network() => Objects(NativeNetworkInventory.Drift().OfType<JsonObject>().Select(row => (JsonObject)row.DeepClone()));

    private static JsonArray Firewall()
    {
        using var persistent = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules", false)
            ?? throw new InvalidDataException("Local persistent firewall store could not be read.");
        string[] ids = persistent.GetValueNames();
        if (ids.Length > Maximum) throw new InvalidDataException("Firewall inventory exceeds 5,000 persistent rules.");
        return Firewall(ids.ToDictionary(id => id, id => persistent.GetValue(id) is string, StringComparer.OrdinalIgnoreCase),
            wql => Query(@"root\StandardCimv2", wql));
    }

    internal static JsonArray Firewall(IReadOnlyDictionary<string, bool> persistent, Func<string, List<Dictionary<string, object?>>> query)
    {
        if (persistent.Count > Maximum) throw new InvalidDataException("Firewall inventory exceeds 5,000 persistent rules.");
        if (persistent.Count == 0) return new JsonArray();
        List<Dictionary<string, object?>> Read(string wql)
        {
            var rows = query(wql);
            if (rows.Count > Maximum) throw new InvalidDataException("Configuration inventory exceeds 5,000 entries.");
            return rows;
        }

        // Fetch each provider class once. The documented association keys join
        // the exact rule/filter objects; InstanceID or display labels are not
        // assumed to match between classes. Previously this performed two WMI
        // ASSOCIATORS queries per rule and scanned the full rule list per ID.
        var queried = Read("SELECT InstanceID,ElementName,Enabled,Direction,Action,PolicyStoreSourceType,__PATH FROM MSFT_NetFirewallRule")
            .GroupBy(row => WindowsManagement.Text(row, "InstanceID"), StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.ToArray(), StringComparer.OrdinalIgnoreCase);
        var ports = Filters(Read("SELECT Protocol,LocalPort,__PATH FROM MSFT_NetProtocolPortFilter"), "MSFT_NetProtocolPortFilter");
        var addresses = Filters(Read("SELECT RemoteAddress,__PATH FROM MSFT_NetAddressFilter"), "MSFT_NetAddressFilter");
        var portLinks = Links(Read("SELECT GroupComponent,PartComponent FROM MSFT_NetFirewallRuleFilterByProtocolPort"), "MSFT_NetProtocolPortFilter");
        var addressLinks = Links(Read("SELECT GroupComponent,PartComponent FROM MSFT_NetFirewallRuleFilterByAddress"), "MSFT_NetAddressFilter");

        var rules = new List<JsonObject>();
        foreach (var pair in persistent)
        {
            string id = pair.Key;
            var rule = NativeManagement.SelectLocalFirewallRule(queried.GetValueOrDefault(id) ?? [], id, pair.Value);
            // InstanceID is the persistent rule identity used by the existing
            // baseline. COM rule.Name is merely a display label and can collide.
            string path = FirewallObjectPath(StrictText(rule, "__PATH", 8192), "MSFT_NetFirewallRule");
            var port = ResolveFilter(path, portLinks, ports);
            var address = ResolveFilter(path, addressLinks, addresses);
            rules.Add(new JsonObject
            {
                ["name"] = WindowsManagement.Text(rule, "InstanceID"), ["enabled"] = WindowsManagement.Number(rule, "Enabled") == 1 ? "True" : "False",
                ["direction"] = WindowsManagement.Number(rule, "Direction") == 1 ? "Inbound" : "Outbound", ["action"] = WindowsManagement.Number(rule, "Action") switch { 2 => "Allow", 3 => "AllowBypass", 4 => "Block", _ => throw new InvalidDataException("Unknown firewall action.") },
                ["protocol"] = WindowsManagement.Text(port, "Protocol"),
                ["ports"] = OptionalStrings(port, "LocalPort"), ["remote"] = OptionalStrings(address, "RemoteAddress")
            });
        }
        return Objects(rules.OrderBy(rule => rule["name"]!.GetValue<string>(), StringComparer.OrdinalIgnoreCase));
    }

    private static Dictionary<string, Dictionary<string, object?>> Filters(IEnumerable<Dictionary<string, object?>> rows, string className)
    {
        var result = new Dictionary<string, Dictionary<string, object?>>(StringComparer.OrdinalIgnoreCase);
        foreach (var row in rows)
            if (!result.TryAdd(FirewallObjectPath(StrictText(row, "__PATH", 8192), className), row))
                throw new InvalidDataException("Firewall filter identity is not unique.");
        return result;
    }

    private static Dictionary<string, List<string>> Links(IEnumerable<Dictionary<string, object?>> rows, string filterClass)
    {
        var result = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var row in rows)
        {
            string rule = FirewallObjectPath(StrictText(row, "GroupComponent", 8192), "MSFT_NetFirewallRule");
            string filter = FirewallObjectPath(StrictText(row, "PartComponent", 8192), filterClass);
            if (!result.TryGetValue(rule, out var filters)) result[rule] = filters = [];
            filters.Add(filter);
        }
        return result;
    }

    private static Dictionary<string, object?> ResolveFilter(string rule, Dictionary<string, List<string>> links, Dictionary<string, Dictionary<string, object?>> filters)
    {
        if (!links.TryGetValue(rule, out var associated) || associated.Count != 1 || !filters.TryGetValue(associated[0], out var filter))
            throw new InvalidDataException("Firewall filters could not be uniquely resolved.");
        return filter;
    }

    internal static string FirewallObjectPath(string path, string className)
    {
        // WMI references may be absolute, namespace-qualified or relative.
        // Strip only a namespace prefix before the expected class, preserving
        // escaped and quoted key values verbatim (including colons/backslashes).
        string start = className + ".";
        if (path.StartsWith(start, StringComparison.OrdinalIgnoreCase)) return path;
        int separator = path.IndexOf(':');
        if (separator > 0 && path.AsSpan(separator + 1).StartsWith(start, StringComparison.OrdinalIgnoreCase)
            && !path.AsSpan(0, separator).Contains('"') && !path.AsSpan(0, separator).Contains('='))
            return path[(separator + 1)..];
        throw new InvalidDataException("Firewall provider returned an unexpected object reference.");
    }

    private static JsonArray LocalGroups()
    {
        var result = new List<JsonObject>();
        foreach (var group in Query(@"root\cimv2", "SELECT Name,SID,__PATH FROM Win32_Group WHERE LocalAccount=TRUE")
            .OrderBy(row => WindowsManagement.Text(row, "Name"), StringComparer.OrdinalIgnoreCase))
        {
            var members = NativeAccounts.GroupMembers(WindowsManagement.Text(group, "Name")).Order(StringComparer.Ordinal);
            result.Add(new JsonObject { ["name"] = WindowsManagement.Text(group, "Name"), ["members"] = Array(members) });
        }
        return Objects(result);
    }

    private static JsonArray Tasks()
    {
        Type type = Type.GetTypeFromProgID("Schedule.Service", throwOnError: true)!;
        object serviceObject = Activator.CreateInstance(type)!;
        try
        {
            dynamic service = serviceObject; service.Connect();
            object folder = service.GetFolder("\\"); var result = new List<JsonObject>();
            try { VisitTasks(folder, result, 0); } finally { Release(folder); }
            return Objects(result.OrderBy(task => task["path"]!.GetValue<string>(), StringComparer.OrdinalIgnoreCase).ThenBy(task => task["name"]!.GetValue<string>(), StringComparer.OrdinalIgnoreCase));
        }
        finally { Release(serviceObject); }
    }

    private static void VisitTasks(object folderObject, List<JsonObject> result, int depth)
    {
        if (depth > 32) throw new InvalidDataException("Task Scheduler folder depth exceeds 32.");
        dynamic folder = folderObject; object tasksObject = folder.GetTasks(1);
        try
        {
            foreach (object taskObject in (System.Collections.IEnumerable)tasksObject)
            {
                object? definitionObject = null, principalObject = null, settingsObject = null, actionsObject = null;
                try
                {
                    if (result.Count >= Maximum) throw new InvalidDataException("Task Scheduler inventory exceeds 5,000 tasks.");
                    dynamic task = taskObject; definitionObject = task.Definition; dynamic definition = definitionObject;
                    principalObject = definition.Principal; settingsObject = definition.Settings; actionsObject = definition.Actions;
                    dynamic principal = principalObject; dynamic settings = settingsObject; var actions = new JsonArray();
                    foreach (object actionObject in (System.Collections.IEnumerable)actionsObject)
                    {
                        try
                        {
                            dynamic action = actionObject;
                            if ((int)action.Type == 0) actions.Add(new JsonObject { ["execute"] = (string)action.Path, ["arguments"] = (string)action.Arguments, ["directory"] = (string)action.WorkingDirectory });
                            else actions.Add(new JsonObject { ["type"] = (int)action.Type });
                        }
                        finally { Release(actionObject); }
                    }
                    string taskPath = (string)task.Path; int separator = taskPath.LastIndexOf('\\');
                    result.Add(new JsonObject { ["name"] = (string)task.Name, ["path"] = taskPath[..(separator + 1)], ["enabled"] = (bool)settings.Enabled, ["principal"] = (string)principal.UserId, ["actions"] = actions });
                }
                finally { Release(actionsObject); Release(settingsObject); Release(principalObject); Release(definitionObject); Release(taskObject); }
            }
        }
        finally { Release(tasksObject); }
        object foldersObject = folder.GetFolders(0);
        try { foreach (object child in (System.Collections.IEnumerable)foldersObject) try { VisitTasks(child, result, depth + 1); } finally { Release(child); } }
        finally { Release(foldersObject); }
    }

    private static void Release(object? value) { if (value is not null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value); }
}
