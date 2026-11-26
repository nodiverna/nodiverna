using System.ComponentModel;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ServerDesk.Agent;

internal static class DiagnosticParameters
{
    internal static void Keys(JsonObject p, params string[] allowed) { foreach (var item in p) if (!allowed.Contains(item.Key, StringComparer.Ordinal)) throw new AgentMessageException("AGENT_UNKNOWN_PARAMETER", ("name", item.Key)); }
    internal static long Integer(JsonObject p, string key, long min, long max, long? defaultValue = null)
    {
        if (!p.TryGetPropertyValue(key, out var node)) return defaultValue ?? throw new AgentMessageException("AGENT_NUMBER_MISSING", ("name", key));
        if (node is not JsonValue value || !value.TryGetValue<System.Text.Json.JsonElement>(out var element) && !value.TryGetValue<long>(out _) && !value.TryGetValue<int>(out _)) throw new AgentMessageException("AGENT_INVALID_NUMBER", ("name", key));
        long number;
        if (value.TryGetValue<long>(out number)) { }
        else if (value.TryGetValue<int>(out int small)) number = small;
        else if (element.ValueKind == System.Text.Json.JsonValueKind.Number && element.TryGetInt64(out number)) { }
        else throw new AgentMessageException("AGENT_INVALID_NUMBER", ("name", key));
        if (number < min || number > max) throw new AgentMessageException("AGENT_NUMBER_OUT_OF_RANGE", ("name", key)); return number;
    }
    internal static string String(JsonObject p, string key, int maximum, bool allowEmpty = false, bool noControls = false, string? defaultValue = null)
    {
        if (!p.TryGetPropertyValue(key, out var node)) return defaultValue ?? throw new AgentMessageException("AGENT_TEXT_MISSING", ("name", key));
        if (node is not JsonValue value || !value.TryGetValue<string>(out string? text) || text is null || text.Length > maximum || (!allowEmpty && text.Length == 0) || text.Contains('\0') || noControls && text.Any(c => c < 32)) throw new AgentMessageException("AGENT_INVALID_TEXT_PARAMETER", ("name", key)); return text;
    }
    internal static bool Boolean(JsonObject p, string key, bool? defaultValue = null)
    {
        if (!p.TryGetPropertyValue(key, out var node)) return defaultValue ?? throw new AgentMessageException("AGENT_BOOLEAN_MISSING", ("name", key));
        if (node is not JsonValue v || !v.TryGetValue<bool>(out bool value)) throw new AgentMessageException("AGENT_INVALID_BOOLEAN", ("name", key)); return value;
    }
    internal static DateTimeOffset Date(JsonObject p, string key)
    {
        string text = String(p, key, 60);
        if (!Regex.IsMatch(text, @"^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$", RegexOptions.CultureInvariant) || !DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsed)) throw new AgentMessageException("AGENT_INVALID_TIMESTAMP"); return parsed.ToUniversalTime();
    }
}

/// <summary>Bounded native diagnostics; no PowerShell/script subprocesses.</summary>
internal static class NativeDiagnostics
{
    private static readonly HashSet<string> Mutations = ["kill-process", "message-session", "disconnect-session", "logoff-session"];
    private static readonly string[] States = ["Active", "Connected", "ConnectQuery", "Shadow", "Disconnected", "Idle", "Listen", "Reset", "Down", "Init"];
    private const string Measurement = "Connection snapshots; no per-process byte or bandwidth measurement. User is the current owning process identity; shared services may represent multiple users.";
    private const string NoDescription = "Description not available on this device.";
    private sealed record EventSelection(string Channel, int Limit, string Text, bool Xml, EventLogQuery Query);

    internal static async Task<JsonObject> ExecuteAsync(string root, JsonObject config, JsonObject job, CancellationToken token)
    {
        string id = job["id"]?.GetValue<string>() ?? "", action = job["action"]?.GetValue<string>() ?? "";
        var result = new JsonObject { ["id"] = id, ["ok"] = false };
        try
        {
            var p = job["parameters"]?.AsObject() ?? new JsonObject(); if (Encoding.UTF8.GetByteCount(p.ToJsonString()) > 64000) throw new AgentMessageException("AGENT_PARAMETERS_TOO_LARGE");
            if (Mutations.Contains(action))
            {
                if (LocalStore.ReadProtected(Path.Combine(root, "config.bin"))["mode"]?.GetValue<string>() != "Management") throw new AgentMessageException("AGENT_READONLY");
                if (!DiagnosticParameters.Boolean(p, "confirm", false)) throw new AgentMessageException("AGENT_CHANGE_NOT_CONFIRMED");
            }
            JsonObject data = action switch
            {
                "list-processes" => await ProcessesAsync(root, p, token),
                "kill-process" => await KillAsync(root, p, token),
                "list-sessions" => ListSessions(p),
                "message-session" or "disconnect-session" or "logoff-session" => SessionAction(action, p),
                "list-connections" => Connections(root, p),
                "network-diagnostics" => await NetworkAsync(p, token),
                "query-events" => await Task.Run(() => Events(p, token), token),
                "export-events" => await Task.Run(() => ExportEvents(root, p, token), token),
                "support-bundle" => await SupportAsync(root, p, token),
                _ => throw new AgentMessageException("AGENT_UNKNOWN_DIAGNOSTIC_ACTION")
            };
            bool security = data["scope"]?["security"]?.GetValue<bool>() ?? false;
            result["data"] = new JsonObject { ["kind"] = action, ["at"] = DateTimeOffset.UtcNow.ToString("O"), ["data"] = data, ["scope"] = new JsonObject { ["security"] = security } };
            result["ok"] = true;
            AgentMessages.Write(result, action switch { "kill-process" => data["terminated"]?.GetValue<bool>() == true ? "AGENT_PROCESS_ENDED" : "AGENT_PROCESS_END_REQUESTED", "message-session" or "disconnect-session" or "logoff-session" => "AGENT_SESSION_ACTION_SUBMITTED", _ => "AGENT_DIAGNOSTIC_COMPLETED" });
            if (Encoding.UTF8.GetByteCount(result.ToJsonString()) > 245000) throw new AgentMessageException("AGENT_DIAGNOSTIC_OUTPUT_TOO_LARGE");
        }
        catch (Exception e) { result["ok"] = false; result.Remove("data"); AgentMessages.Fail(result, e, limit: 2000); }
        return result;
    }

    private static async Task<JsonObject> ProcessesAsync(string root, JsonObject p, CancellationToken token)
    {
        DiagnosticParameters.Keys(p, "limit", "sampleMs"); int limit = (int)DiagnosticParameters.Integer(p, "limit", 1, 1000, 500), sample = (int)DiagnosticParameters.Integer(p, "sampleMs", 250, 1000, 350);
        var collector = new NativeProcessInventory(root); collector.Collect(); var watch = Stopwatch.StartNew(); await Task.Delay(sample, token);
        JsonObject snapshot = collector.Collect(); if (snapshot["processInventory"]?["complete"]?.GetValue<bool>() != true) throw new AgentMessageException("AGENT_PROCESS_LIST_UNAVAILABLE"); var all = snapshot["processes"]?.AsArray() ?? new JsonArray(); var rows = new JsonArray(); int bytes = 0;
        foreach (var row in all.OrderByDescending(r => r?["memoryMb"]?.GetValue<double>() ?? 0).Take(limit))
        {
            if (row is null) continue; int length = Encoding.UTF8.GetByteCount(row.ToJsonString()); if (bytes + length > 215000) break; bytes += length; rows.Add(row.DeepClone());
        }
        return new JsonObject { ["processes"] = rows, ["count"] = snapshot["processInventory"]?["count"]?.DeepClone() ?? JsonValue.Create(all.Count), ["truncated"] = rows.Count < all.Count || snapshot["processInventory"]?["truncated"]?.GetValue<bool>() == true, ["sampleSeconds"] = Math.Round(watch.Elapsed.TotalSeconds, 3), ["cpuScale"] = "Percent of all logical processors" };
    }
    private static async Task<JsonObject> KillAsync(string root, JsonObject p, CancellationToken token)
    {
        DiagnosticParameters.Keys(p, "pid", "startedAt", "confirm"); int pid = (int)DiagnosticParameters.Integer(p, "pid", 1, int.MaxValue); DateTimeOffset expected = DiagnosticParameters.Date(p, "startedAt");
        using var process = Process.GetProcessById(pid);
        // StartTime opens and caches the handle. All subsequent checks and Kill operate on that same process handle.
        if (process.StartTime.ToUniversalTime().Ticks != expected.UtcDateTime.Ticks) throw new AgentMessageException("AGENT_PID_REUSED");
        if (Protected(process, root)) throw new AgentMessageException("AGENT_PROCESS_PROTECTED");
        token.ThrowIfCancellationRequested(); process.Kill(); bool exited;
        try { await process.WaitForExitAsync(token).WaitAsync(TimeSpan.FromSeconds(5), token); exited = true; } catch (TimeoutException) { exited = false; }
        return new JsonObject { ["pid"] = pid, ["terminated"] = exited };
    }
    private static bool Protected(Process p, string root)
    {
        try
        {
            if (p.Id <= 4 || Regex.IsMatch(p.ProcessName, @"^(System|Registry|Memory Compression|smss|csrss|wininit|winlogon|services|lsass|lsaiso|ServerDesk\.Agent|ServerDesk\.Updater)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)) return true;
            string executable = p.MainModule?.FileName ?? ""; if (executable.Length == 0 || executable.StartsWith(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return true;
            if (!IsProcessCritical(p.Handle, out bool critical)) return true; if (critical) return true;
            var parents = ToolhelpParents(); int ancestor = Environment.ProcessId; var seen = new HashSet<int>();
            for (int i = 0; i < 32 && ancestor > 0 && seen.Add(ancestor); i++) { if (ancestor == p.Id) return true; if (!parents.TryGetValue(ancestor, out ancestor)) break; }
            return false;
        }
        catch { return true; }
    }
    private static Dictionary<int, int> ToolhelpParents()
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0); if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try { var rows = new Dictionary<int, int>(); var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>() }; if (!Process32First(snapshot, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error()); do { rows[(int)entry.Id] = (int)entry.ParentId; } while (Process32Next(snapshot, ref entry)); return rows; }
        finally { CloseHandle(snapshot); }
    }

    private static JsonObject ListSessions(JsonObject p) { DiagnosticParameters.Keys(p); return Sessions(); }
    private static JsonObject Sessions()
    {
        JsonArray rows = new(); Dictionary<int, int[]> processIds = new();
        foreach (var group in Process.GetProcesses().Select(p => { using (p) { try { return (id: p.Id, session: p.SessionId); } catch { return (id: -1, session: -1); } } }).Where(p => p.id > 0).GroupBy(p => p.session)) processIds[group.Key] = group.Select(p => p.id).ToArray();
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out IntPtr buffer, out int count)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            int size = Marshal.SizeOf<WtsSession>();
            for (int i = 0; i < Math.Min(count, 1024); i++)
            {
                var session = Marshal.PtrToStructure<WtsSession>(IntPtr.Add(buffer, i * size)); string user = WtsString(session.Id, 5); if (user.Length == 0) continue; string domain = WtsString(session.Id, 7); var detail = WtsDetails(session.Id);
                long? idle = detail is WtsInfo info && info.LastInputTime > 0 && info.CurrentTime >= info.LastInputTime ? (info.CurrentTime - info.LastInputTime) / 10000000 : null;
                string logon = detail is WtsInfo d && d.LogonTime > 0 ? DateTime.FromFileTimeUtc(d.LogonTime).ToString("O") : "";
                rows.Add(new JsonObject { ["sessionId"] = session.Id, ["username"] = domain.Length > 0 ? domain + "\\" + user : user, ["state"] = session.State >= 0 && session.State < States.Length ? States[session.State] : "Unknown", ["station"] = Marshal.PtrToStringUni(session.Station) ?? "", ["client"] = WtsString(session.Id, 10), ["logonAt"] = logon, ["idleSeconds"] = idle, ["processIds"] = new JsonArray(processIds.GetValueOrDefault(session.Id, []).Take(2000).Select(p => (JsonNode?)JsonValue.Create(p)).ToArray()) });
            }
        }
        finally { WTSFreeMemory(buffer); }
        return new JsonObject { ["sessions"] = rows };
    }
    private static JsonObject SessionAction(string action, JsonObject p)
    {
        DiagnosticParameters.Keys(p, action == "message-session" ? ["sessionId", "username", "confirm", "message"] : ["sessionId", "username", "confirm"]);
        int id = (int)DiagnosticParameters.Integer(p, "sessionId", 1, 65535); string expected = DiagnosticParameters.String(p, "username", 256);
        string user = WtsString(id, 5), domain = WtsString(id, 7), current = domain.Length > 0 ? domain + "\\" + user : user;
        if (user.Length == 0 || !current.Equals(expected, StringComparison.OrdinalIgnoreCase)) throw new AgentMessageException("AGENT_SESSION_CHANGED");
        bool ok;
        if (action == "message-session") { string message = DiagnosticParameters.String(p, "message", 2000); ok = WTSSendMessage(IntPtr.Zero, id, "ServerDesk", Encoding.Unicode.GetByteCount("ServerDesk"), message, Encoding.Unicode.GetByteCount(message), 0, 10, out _, false); }
        else ok = action == "disconnect-session" ? WTSDisconnectSession(IntPtr.Zero, id, false) : WTSLogoffSession(IntPtr.Zero, id, false);
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); return new JsonObject { ["sessionId"] = id, ["submitted"] = true };
    }
    private static string WtsString(int id, int kind) { if (!WTSQuerySessionInformation(IntPtr.Zero, id, kind, out IntPtr data, out int bytes)) return ""; try { return bytes > 0 ? Marshal.PtrToStringUni(data) ?? "" : ""; } finally { WTSFreeMemory(data); } }
    private static WtsInfo? WtsDetails(int id) { if (!WTSQuerySessionInformation(IntPtr.Zero, id, 24, out IntPtr data, out int bytes)) return null; try { return bytes >= Marshal.SizeOf<WtsInfo>() ? Marshal.PtrToStructure<WtsInfo>(data) : null; } finally { WTSFreeMemory(data); } }

    private static JsonObject Connections(string root, JsonObject p)
    {
        DiagnosticParameters.Keys(p, "limit", "pid"); int limit = (int)DiagnosticParameters.Integer(p, "limit", 1, 1000, 500); int? only = p.ContainsKey("pid") ? (int)DiagnosticParameters.Integer(p, "pid", 1, int.MaxValue) : null;
        var inventory = new NativeProcessInventory(root).Collect()["processes"]?.AsArray() ?? new();
        var owners = inventory.Where(v => v is not null).ToDictionary(v => v!["pid"]!.GetValue<int>(), v => v!); var rows = new JsonArray(); int bytes = 0; var snapshot = NativeConnectionTables.Snapshot(limit, only);
        foreach (JsonObject endpoint in snapshot.Rows)
        {
            int pid = endpoint["pid"]!.GetValue<int>();
            owners.TryGetValue(pid, out var owner); endpoint["name"] = owner?["name"]?.DeepClone() ?? JsonValue.Create(""); endpoint["user"] = owner?["user"]?.DeepClone() ?? JsonValue.Create(""); endpoint["sessionId"] = owner?["sessionId"]?.DeepClone();
            int length = Encoding.UTF8.GetByteCount(endpoint.ToJsonString()); if (bytes + length > 215000) continue; bytes += length; rows.Add(endpoint);
        }
        return new JsonObject { ["connections"] = rows, ["count"] = snapshot.Count, ["truncated"] = rows.Count < snapshot.Count, ["measurement"] = Measurement };
    }

    private static async Task<JsonObject> NetworkAsync(JsonObject p, CancellationToken token)
    {
        DiagnosticParameters.Keys(p, "host", "port"); int port = (int)DiagnosticParameters.Integer(p, "port", 1, 65535, 443); var addresses = new JsonArray(); var dns = new JsonArray();
        foreach (NetworkInterface nic in NetworkInterface.GetAllNetworkInterfaces().Take(100))
        {
            token.ThrowIfCancellationRequested(); IPInterfaceProperties props = nic.GetIPProperties(); int v4 = 0, v6 = 0; try { v4 = props.GetIPv4Properties()?.Index ?? 0; } catch { } try { v6 = props.GetIPv6Properties()?.Index ?? 0; } catch { }
            foreach (var address in props.UnicastAddresses) { if (addresses.Count >= 200) break; addresses.Add(new JsonObject { ["InterfaceIndex"] = address.Address.AddressFamily == AddressFamily.InterNetwork ? v4 : v6, ["InterfaceAlias"] = nic.Name, ["IPAddress"] = address.Address.ToString(), ["PrefixLength"] = address.PrefixLength, ["AddressFamily"] = address.Address.AddressFamily == AddressFamily.InterNetwork ? "IPv4" : "IPv6", ["AddressState"] = address.DuplicateAddressDetectionState.ToString() }); }
            foreach (AddressFamily family in new[] { AddressFamily.InterNetwork, AddressFamily.InterNetworkV6 }) dns.Add(new JsonObject { ["InterfaceIndex"] = family == AddressFamily.InterNetwork ? v4 : v6, ["InterfaceAlias"] = nic.Name, ["AddressFamily"] = family == AddressFamily.InterNetwork ? "IPv4" : "IPv6", ["ServerAddresses"] = new JsonArray(props.DnsAddresses.Where(a => a.AddressFamily == family).Select(a => (JsonNode?)JsonValue.Create(a.ToString())).ToArray()) });
        }
        var routes = new JsonArray();
        foreach (var route in WindowsManagement.Query(@"root\StandardCimv2", "SELECT InterfaceIndex,DestinationPrefix,NextHop,RouteMetric,Protocol FROM MSFT_NetRoute", 200, TimeSpan.FromSeconds(8))) routes.Add(new JsonObject { ["InterfaceIndex"] = (int)WindowsManagement.Number(route, "InterfaceIndex"), ["DestinationPrefix"] = WindowsManagement.Text(route, "DestinationPrefix"), ["NextHop"] = WindowsManagement.Text(route, "NextHop"), ["RouteMetric"] = WindowsManagement.Number(route, "RouteMetric"), ["Protocol"] = WindowsManagement.Number(route, "Protocol") });
        var listeners = new JsonArray(); foreach (JsonObject connection in NativeConnectionTables.Snapshot(10000).Rows.Where(c => c["protocol"]?.GetValue<string>() == "TCP" && c["state"]?.GetValue<string>() == "Listen").Take(200)) listeners.Add(new JsonObject { ["LocalAddress"] = connection["localAddress"]?.DeepClone(), ["LocalPort"] = connection["localPort"]?.DeepClone(), ["OwningProcess"] = connection["pid"]?.DeepClone() });
        var result = new JsonObject { ["addresses"] = addresses, ["routes"] = routes, ["dnsServers"] = dns, ["proxy"] = WinHttpProxy(), ["listeners"] = listeners };
        if (p.ContainsKey("host"))
        {
            string host = DiagnosticParameters.String(p, "host", 253); if (!Regex.IsMatch(host, @"^[a-zA-Z0-9.:-]+$", RegexOptions.CultureInvariant)) throw new AgentMessageException("AGENT_INVALID_NETWORK_TARGET");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(10));
            try { result["dns"] = new JsonArray((await Dns.GetHostAddressesAsync(host, timeout.Token)).Select(a => (JsonNode?)JsonValue.Create(a.ToString())).ToArray()); } catch (Exception e) when (!token.IsCancellationRequested) { result["dnsError"] = Short(e.Message, 1000); }
            var watch = Stopwatch.StartNew(); using var client = new TcpClient(); timeout.CancelAfter(TimeSpan.FromSeconds(10));
            try { await client.ConnectAsync(host, port, timeout.Token); result["tcp"] = new JsonObject { ["host"] = host, ["port"] = port, ["connected"] = true, ["durationMs"] = watch.ElapsedMilliseconds }; }
            catch (Exception e) when (!token.IsCancellationRequested) { result["tcp"] = new JsonObject { ["host"] = host, ["port"] = port, ["connected"] = false, ["durationMs"] = watch.ElapsedMilliseconds, ["error"] = Short(e.Message, 1000) }; }
        }
        return result;
    }
    private static string WinHttpProxy()
    {
        if (!WinHttpGetDefaultProxyConfiguration(out var proxy)) return "WinHTTP proxy unavailable: " + Marshal.GetLastWin32Error();
        try { return proxy.AccessType == 1 ? "Direct access (no proxy server)." : "Proxy: " + (Marshal.PtrToStringUni(proxy.Proxy) ?? "") + "; bypass: " + (Marshal.PtrToStringUni(proxy.Bypass) ?? ""); }
        finally { if (proxy.Proxy != IntPtr.Zero) GlobalFree(proxy.Proxy); if (proxy.Bypass != IntPtr.Zero) GlobalFree(proxy.Bypass); }
    }

    internal static string EventXPath(JsonObject filter)
    {
        DiagnosticParameters.Keys(filter, "channel", "from", "to", "levels", "provider", "eventIds", "text", "limit", "includeXml", "cursor");
        string channel = DiagnosticParameters.String(filter, "channel", 200, defaultValue: "System"); if (!Regex.IsMatch(channel, @"^[a-zA-Z0-9_. /-]+$", RegexOptions.CultureInvariant)) throw new AgentMessageException("AGENT_INVALID_EVENT_CHANNEL");
        DiagnosticParameters.Integer(filter, "limit", 1, 100, 50); DiagnosticParameters.String(filter, "text", 200, true, defaultValue: ""); DiagnosticParameters.Boolean(filter, "includeXml", false);
        var tests = new List<string>(); DateTimeOffset? from = null, to = null;
        if (filter.ContainsKey("from")) { from = DiagnosticParameters.Date(filter, "from"); tests.Add("TimeCreated[@SystemTime >= '" + XmlDate(from.Value) + "']"); }
        if (filter.ContainsKey("to")) { to = DiagnosticParameters.Date(filter, "to"); tests.Add("TimeCreated[@SystemTime <= '" + XmlDate(to.Value) + "']"); }
        if (from.HasValue && to.HasValue && from > to) throw new AgentMessageException("AGENT_EVENT_RANGE");
        AddNumbers("levels", "Level", 6, 5); AddNumbers("eventIds", "EventID", 50, 65535);
        if (filter.ContainsKey("provider")) { string provider = DiagnosticParameters.String(filter, "provider", 200); if (!Regex.IsMatch(provider, @"^[a-zA-Z0-9_. -]+$", RegexOptions.CultureInvariant)) throw new AgentMessageException("AGENT_INVALID_EVENT_PROVIDER"); tests.Add("Provider[@Name='" + provider + "']"); }
        if (filter.ContainsKey("cursor")) { var cursor = filter["cursor"] as JsonObject ?? throw new AgentMessageException("AGENT_INVALID_CURSOR"); DiagnosticParameters.Keys(cursor, "channel", "recordId", "timeCreated"); if (DiagnosticParameters.String(cursor, "channel", 200) != channel) throw new AgentMessageException("AGENT_EVENT_CURSOR_INVALID_CHANNEL"); DiagnosticParameters.Date(cursor, "timeCreated"); tests.Add("EventRecordID < " + DiagnosticParameters.Integer(cursor, "recordId", 1, 9007199254740991)); }
        return tests.Count == 0 ? "*" : "*[System[" + string.Join(" and ", tests) + "]]";
        void AddNumbers(string key, string property, int max, long upper) { if (!filter.ContainsKey(key)) return; if (filter[key] is not JsonArray numbers || numbers.Count > max) throw new AgentMessageException("AGENT_INVALID_EVENT_FILTER_LIST"); if (numbers.Count == 0) return; var expressions = new List<string>(); foreach (var number in numbers) { var holder = new JsonObject { [key] = number?.DeepClone() }; expressions.Add(property + "=" + DiagnosticParameters.Integer(holder, key, 0, upper)); } tests.Add("(" + string.Join(" or ", expressions) + ")"); }
    }
    private static EventSelection Selection(JsonObject filter)
    {
        string xpath = EventXPath(filter); string channel = DiagnosticParameters.String(filter, "channel", 200, defaultValue: "System");
        if (filter["cursor"] is JsonObject cursor)
        {
            long id = DiagnosticParameters.Integer(cursor, "recordId", 1, 9007199254740991); DateTimeOffset date = DiagnosticParameters.Date(cursor, "timeCreated");
            try { using var reader = new EventLogReader(new EventLogQuery(channel, PathType.LogName, "*[System[EventRecordID=" + id + "]]")); using var anchor = reader.ReadEvent(TimeSpan.FromSeconds(3)); if (anchor?.TimeCreated?.ToUniversalTime().Ticks != date.UtcDateTime.Ticks) throw new AgentMessageException("AGENT_EVENT_CURSOR_INVALID"); }
            catch (EventLogException) { throw new AgentMessageException("AGENT_EVENT_CURSOR_INVALID"); }
        }
        return new(channel, (int)DiagnosticParameters.Integer(filter, "limit", 1, 100, 50), DiagnosticParameters.String(filter, "text", 200, true, defaultValue: ""), DiagnosticParameters.Boolean(filter, "includeXml", false), new EventLogQuery(channel, PathType.LogName, xpath) { ReverseDirection = true });
    }
    private static JsonObject Events(JsonObject filter, CancellationToken token)
    {
        EventSelection selection = Selection(filter); using var reader = new EventLogReader(selection.Query); var rows = new JsonArray(); int scanned = 0, bytes = 0; JsonObject? cursor = null; bool more = false;
        while (scanned < 1000 && rows.Count < selection.Limit)
        {
            token.ThrowIfCancellationRequested(); using EventRecord? record = reader.ReadEvent(TimeSpan.FromSeconds(3)); if (record is null) break;
            scanned++; JsonObject? previous = cursor; var next = new JsonObject { ["channel"] = selection.Channel, ["recordId"] = record.RecordId, ["timeCreated"] = record.TimeCreated?.ToUniversalTime().ToString("O") ?? "" };
            string message; try { message = record.FormatDescription() ?? NoDescription; } catch (EventLogException) { message = NoDescription; }
            if (selection.Text.Length > 0 && !message.Contains(selection.Text, StringComparison.OrdinalIgnoreCase)) { cursor = next; continue; }
            var row = new JsonObject { ["recordId"] = record.RecordId, ["id"] = record.Id, ["level"] = Short(record.LevelDisplayName ?? "", 128), ["levelNumber"] = record.Level, ["provider"] = Short(record.ProviderName ?? "", 200), ["at"] = record.TimeCreated?.ToUniversalTime().ToString("O") ?? "", ["message"] = Short(message, 2000) };
            if (selection.Xml) { string xml = record.ToXml(); row["xml"] = Short(xml, 8000); row["xmlTruncated"] = xml.Length > 8000; }
            int length = Encoding.UTF8.GetByteCount(row.ToJsonString()); if (bytes + length > 210000) { cursor = previous; more = true; break; } cursor = next; bytes += length; rows.Add(row);
        }
        if (scanned >= 1000 || rows.Count >= selection.Limit) more = true;
        return new JsonObject { ["channel"] = selection.Channel, ["events"] = rows, ["cursor"] = cursor, ["hasMore"] = more, ["scanned"] = scanned, ["scanLimit"] = 1000, ["scope"] = new JsonObject { ["security"] = selection.Channel.Equals("Security", StringComparison.OrdinalIgnoreCase) } };
    }
    private static string XmlDate(DateTimeOffset date) => date.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);
    private static JsonObject ExportEvents(string root, JsonObject p, CancellationToken token)
    {
        DiagnosticParameters.Keys(p, "filter", "format"); string format = DiagnosticParameters.String(p, "format", 4); if (format is not ("json" or "csv" or "evtx")) throw new AgentMessageException("AGENT_INVALID_EXPORT_FORMAT");
        var filter = p["filter"] as JsonObject ?? throw new AgentMessageException("AGENT_EVENT_FILTER_MISSING"); EventSelection selection = Selection(filter); bool security = selection.Channel.Equals("Security", StringComparison.OrdinalIgnoreCase);
        if (format == "evtx" && selection.Text.Length > 0) throw new AgentMessageException("AGENT_EVTX_NO_TEXT_FILTER");
        string path = Path.Combine(ExportRoot(root), (security ? "security-events-" : "events-") + Guid.NewGuid().ToString("N") + "." + format);
        try
        {
            JsonObject page = Events(filter, token);
            if (format == "json") File.WriteAllText(path, page.ToJsonString(), new UTF8Encoding(false));
            else if (format == "csv") { string[] fields = ["recordId", "id", "level", "provider", "at", "message"]; using var writer = new StreamWriter(path, false, new UTF8Encoding(true)); writer.WriteLine(string.Join(",", fields.Select(Csv))); foreach (var row in page["events"]!.AsArray()) writer.WriteLine(string.Join(",", fields.Select(key => Csv(row?[key]?.ToString() ?? "")))); }
            else
            {
                JsonArray records = page["events"]!.AsArray(); if (records.Count == 0) throw new AgentMessageException("AGENT_EVENTS_NONE_FOR_EXPORT");
                string xpath = "*[System[" + string.Join(" or ", records.Select(row => "(EventRecordID=" + row!["recordId"]!.GetValue<long>() + " and TimeCreated[@SystemTime='" + XmlDate(DateTimeOffset.Parse(row["at"]!.GetValue<string>(), CultureInfo.InvariantCulture)) + "'])")) + "]]";
                EventLogSession.GlobalSession.ExportLog(selection.Channel, PathType.LogName, xpath, path, false);
            }
            return new JsonObject { ["file"] = FileInfo(path), ["format"] = format, ["channel"] = selection.Channel, ["scope"] = new JsonObject { ["security"] = security } };
        }
        catch { if (File.Exists(path)) File.Delete(path); throw; }
    }
    private static async Task<JsonObject> SupportAsync(string root, JsonObject p, CancellationToken token)
    {
        DiagnosticParameters.Keys(p, "channels", "includeEvents"); bool include = DiagnosticParameters.Boolean(p, "includeEvents", true); var channels = p.ContainsKey("channels") ? p["channels"] as JsonArray ?? throw new AgentMessageException("AGENT_INVALID_EVENT_CHANNELS") : new JsonArray("System", "Application"); if (channels.Count is < 1 or > 3) throw new AgentMessageException("AGENT_EVENT_CHANNEL_COUNT");
        foreach (var channel in channels) EventXPath(new JsonObject { ["channel"] = channel?.DeepClone() });
        bool security = include && channels.Any(c => c?.GetValue<string>().Equals("Security", StringComparison.OrdinalIgnoreCase) == true); string folder = ExportRoot(root), id = Guid.NewGuid().ToString("N"), stage = Path.Combine(folder, id), zip = Path.Combine(folder, (security ? "security-support-" : "support-") + id + ".zip");
        Directory.CreateDirectory(stage); var errors = new JsonArray();
        try
        {
            var data = new JsonObject { ["at"] = DateTimeOffset.UtcNow.ToString("O"), ["computer"] = Environment.MachineName, ["network"] = await NetworkAsync(new(), token), ["sessions"] = Sessions(), ["processes"] = await ProcessesAsync(root, new JsonObject { ["limit"] = 100, ["sampleMs"] = 350 }, token), ["errors"] = errors };
            if (include) foreach (var item in channels)
            {
                string channel = item!.GetValue<string>(); token.ThrowIfCancellationRequested();
                try { JsonObject events = await Task.Run(() => Events(new JsonObject { ["channel"] = channel, ["limit"] = 100 }, token), token); File.WriteAllText(Path.Combine(stage, "events-" + Regex.Replace(channel, "[^a-zA-Z0-9-]", "_") + ".json"), events.ToJsonString(), new UTF8Encoding(false)); }
                catch (Exception e) when (!token.IsCancellationRequested) { errors.Add(new JsonObject { ["channel"] = channel, ["error"] = Short(e.Message, 1000) }); }
            }
            File.WriteAllText(Path.Combine(stage, "diagnostics.json"), data.ToJsonString(), new UTF8Encoding(false)); ZipFile.CreateFromDirectory(stage, zip, CompressionLevel.Optimal, false);
            return new JsonObject { ["file"] = FileInfo(zip), ["errors"] = errors.DeepClone(), ["scope"] = new JsonObject { ["security"] = security } };
        }
        catch { if (File.Exists(zip)) File.Delete(zip); throw; }
        finally { Directory.Delete(stage, true); }
    }
    private static string ExportRoot(string root)
    {
        string folder = Path.Combine(Directory.GetParent(Path.GetFullPath(root))!.FullName, "ServerDeskExports"); if (Directory.Exists(folder) && (File.GetAttributes(folder) & FileAttributes.ReparsePoint) != 0) throw new AgentMessageException("AGENT_EXPORT_FOLDER_REPARSE");
        var directory = Directory.CreateDirectory(folder); var acl = new DirectorySecurity(); acl.SetAccessRuleProtection(true, false); foreach (string sid in new[] { "S-1-5-18", "S-1-5-32-544" }) acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow)); directory.SetAccessControl(acl);
        foreach (var file in directory.EnumerateFiles()) if (file.LastWriteTimeUtc < DateTime.UtcNow.AddDays(-1) && (file.Attributes & FileAttributes.ReparsePoint) == 0) { try { file.Delete(); } catch (IOException) { } }
        return folder;
    }
    private static JsonObject FileInfo(string path) { var file = new System.IO.FileInfo(path); if (file.Length > 100 * 1048576L) { file.Delete(); throw new AgentMessageException("AGENT_SUPPORT_EXPORT_TOO_LARGE"); } using var input = File.OpenRead(path); return new JsonObject { ["path"] = file.FullName, ["name"] = file.Name, ["size"] = file.Length, ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(input)), ["expiresAt"] = DateTimeOffset.UtcNow.AddHours(1).ToString("O") }; }
    private static string Csv(string value) => "\"" + value.Replace("\"", "\"\"") + "\"";
    private static string Short(string value, int max) => value[..Math.Min(value.Length, max)];

    [StructLayout(LayoutKind.Sequential)] private struct WtsSession { internal int Id; internal IntPtr Station; internal int State; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct WtsInfo { internal int State; internal uint SessionId, IncomingBytes, OutgoingBytes, IncomingFrames, OutgoingFrames, IncomingCompressedBytes, OutgoingCompressedBytes; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] internal string Station; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 17)] internal string Domain; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 21)] internal string User; internal long ConnectTime, DisconnectTime, LastInputTime, LogonTime, CurrentTime; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct ProcessEntry { internal uint Size, Usage, Id; internal UIntPtr Heap; internal uint Module, Threads, ParentId; internal int BasePriority; internal uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] internal string Exe; }
    [StructLayout(LayoutKind.Sequential)] private struct ProxyInfo { internal uint AccessType; internal IntPtr Proxy, Bypass; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessCritical(IntPtr process, out bool critical);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32FirstW")] private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32NextW")] private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalFree(IntPtr data);
    [DllImport("winhttp.dll", SetLastError = true)] private static extern bool WinHttpGetDefaultProxyConfiguration(out ProxyInfo info);
    [DllImport("wtsapi32.dll", SetLastError = true, EntryPoint = "WTSEnumerateSessionsW")] private static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr data, out int count);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr data);
    [DllImport("wtsapi32.dll", SetLastError = true, EntryPoint = "WTSQuerySessionInformationW")] private static extern bool WTSQuerySessionInformation(IntPtr server, int id, int kind, out IntPtr data, out int count);
    [DllImport("wtsapi32.dll", SetLastError = true)] private static extern bool WTSDisconnectSession(IntPtr server, int id, bool wait);
    [DllImport("wtsapi32.dll", SetLastError = true)] private static extern bool WTSLogoffSession(IntPtr server, int id, bool wait);
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "WTSSendMessageW")] private static extern bool WTSSendMessage(IntPtr server, int id, string title, int titleBytes, string message, int messageBytes, int style, int timeout, out int response, bool wait);
}

internal static class NativeConnectionTables
{
    internal sealed record ConnectionSnapshot(List<JsonObject> Rows, int Count);
    internal static ConnectionSnapshot Snapshot(int maximum = 1000, int? onlyPid = null)
    {
        maximum = Math.Clamp(maximum, 1, 20000); int count = 0; var rows = new List<JsonObject>(); foreach (int family in new[] { 2, 23 }) { Read(family, true, rows, maximum, onlyPid, ref count); Read(family, false, rows, maximum, onlyPid, ref count); } return new(rows, count);
    }
    private static void Read(int family, bool tcp, List<JsonObject> rows, int maximum, int? onlyPid, ref int total)
    {
        uint size = 0; uint code = tcp ? GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, 5, 0) : GetExtendedUdpTable(IntPtr.Zero, ref size, false, family, 1, 0);
        if (code != 122 && code != 0) throw new Win32Exception((int)code); if (size == 0) return;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            if (size > 32 * 1048576) throw new AgentMessageException("AGENT_CONNECTION_TABLE_TOO_LARGE"); IntPtr data = Marshal.AllocHGlobal((int)size);
            try
            {
                code = tcp ? GetExtendedTcpTable(data, ref size, false, family, 5, 0) : GetExtendedUdpTable(data, ref size, false, family, 1, 0); if (code == 122) continue; if (code != 0) throw new Win32Exception((int)code);
                if (size < 4) throw new AgentMessageException("AGENT_CONNECTION_TABLE_INVALID"); int count = Marshal.ReadInt32(data), stride = family == 2 ? tcp ? 24 : 12 : tcp ? 56 : 28;
                if (count < 0 || count > (size - 4) / stride) throw new AgentMessageException("AGENT_CONNECTION_TABLE_INVALID");
                for (int index = 0; index < count; index++)
                {
                    IntPtr p = IntPtr.Add(data, 4 + index * stride); int owningPid = Marshal.ReadInt32(p, family == 2 ? tcp ? 20 : 8 : tcp ? 52 : 24); if (onlyPid.HasValue && onlyPid != owningPid) continue; total++; if (rows.Count >= maximum) continue; string local, remote = "", state = "Endpoint"; int localPort, remotePort = 0, pid;
                    if (family == 2)
                    {
                        int offset = tcp ? 4 : 0; local = IPv4(p, offset); localPort = Port((uint)Marshal.ReadInt32(p, offset + 4)); pid = Marshal.ReadInt32(p, tcp ? 20 : 8); if (tcp) { state = TcpState(Marshal.ReadInt32(p)); remote = IPv4(p, 12); remotePort = Port((uint)Marshal.ReadInt32(p, 16)); }
                    }
                    else { local = IPv6(p, 0, (uint)Marshal.ReadInt32(p, 16)); localPort = Port((uint)Marshal.ReadInt32(p, 20)); pid = Marshal.ReadInt32(p, tcp ? 52 : 24); if (tcp) { remote = IPv6(p, 24, (uint)Marshal.ReadInt32(p, 40)); remotePort = Port((uint)Marshal.ReadInt32(p, 44)); state = TcpState(Marshal.ReadInt32(p, 48)); } }
                    rows.Add(new JsonObject { ["protocol"] = tcp ? "TCP" : "UDP", ["localAddress"] = local, ["localPort"] = localPort, ["remoteAddress"] = remote, ["remotePort"] = tcp ? remotePort : null, ["state"] = state, ["pid"] = pid });
                }
                return;
            }
            finally { Marshal.FreeHGlobal(data); }
        }
        throw new AgentMessageException("AGENT_CONNECTION_TABLE_CHANGED");
    }
    internal static int Port(uint port) => ((int)(port & 255) << 8) | (int)((port >> 8) & 255);
    private static string IPv4(IntPtr pointer, int offset) { byte[] bytes = new byte[4]; Marshal.Copy(IntPtr.Add(pointer, offset), bytes, 0, bytes.Length); return new IPAddress(bytes).ToString(); }
    private static string IPv6(IntPtr pointer, int offset, uint scope) { byte[] bytes = new byte[16]; Marshal.Copy(IntPtr.Add(pointer, offset), bytes, 0, bytes.Length); return new IPAddress(bytes, scope).ToString(); }
    private static string TcpState(int state) => state switch { 1 => "Closed", 2 => "Listen", 3 => "SynSent", 4 => "SynReceived", 5 => "Established", 6 => "FinWait1", 7 => "FinWait2", 8 => "CloseWait", 9 => "Closing", 10 => "LastAck", 11 => "TimeWait", 12 => "DeleteTcb", _ => "Unknown" };
    [DllImport("iphlpapi.dll", SetLastError = true)] private static extern uint GetExtendedTcpTable(IntPtr table, ref uint size, bool order, int family, int tableClass, uint reserved);
    [DllImport("iphlpapi.dll", SetLastError = true)] private static extern uint GetExtendedUdpTable(IntPtr table, ref uint size, bool order, int family, int tableClass, uint reserved);
}
