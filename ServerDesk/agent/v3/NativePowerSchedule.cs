using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Security.Principal;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace ServerDesk.Agent;

// A single, explicitly owned native Task Scheduler task persists the operation.
// There is no agent timer, shell, script, remote resource, or catch-up at boot.
internal static class NativePowerSchedule
{
    internal const string FolderPath = @"\ServerDesk", TaskName = "Scheduled Power", Owner = "ServerDesk.NativePowerSchedule.v1";
    private static readonly XNamespace Ns = "http://schemas.microsoft.com/windows/2004/02/mit/task";
    private static readonly object Gate = new(), CacheGate = new();
    private static long cacheGeneration;
    internal static long CacheGeneration { get { lock (CacheGate) return cacheGeneration; } }
    private static bool cacheObserved;
    private static JsonObject? cachedState;
    // Heartbeats clone this tiny cache. The COM read lives only in the existing
    // five-minute inventory slot, and successful mutations become visible at once.
    internal static void ApplyCurrentState(JsonObject snapshot)
    {
        JsonObject? state; bool observed;
        lock (CacheGate) { observed = cacheObserved; state = cachedState?.DeepClone().AsObject(); }
        if (!observed) return;
        if (state is null) { snapshot.Remove("powerSchedule"); return; }
        if (state["powerSchedule"] is JsonObject plan && ParseUtc(plan["scheduledAt"]!.GetValue<string>()) <= DateTimeOffset.UtcNow) state["powerSchedule"] = null;
        snapshot["powerSchedule"] = state["powerSchedule"]?.DeepClone();
    }
    internal static void Observe(JsonObject? state, long generation)
    {
        lock (CacheGate) { if (cacheGeneration != generation) return; cacheObserved = true; cachedState = state?.DeepClone().AsObject(); }
    }
    internal static void Mutation(JsonObject? plan)
    {
        lock (CacheGate) { cacheGeneration++; cacheObserved = true; cachedState = new JsonObject { ["powerSchedule"] = plan?.DeepClone() }; }
    }
    private static string ShutdownPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "shutdown.exe");
    internal static void ValidateSchedule(JsonObject p, DateTimeOffset? now = null)
    {
        Strict(p, "operation", "scheduledAt", "reason");
        NativeManagement.Choice(p, "operation", "shutdown", "restart");
        DateTimeOffset at = ParseUtc(NativeManagement.Text(p, "scheduledAt", 60));
        var delay = at - (now ?? DateTimeOffset.UtcNow);
        if (delay < TimeSpan.FromSeconds(60) || delay > TimeSpan.FromDays(30)) throw new AgentMessageException("AGENT_POWER_TIME_RANGE");
        NativeManagement.Text(p, "reason", 200);
    }
    internal static void ValidateCancel(JsonObject p)
    {
        Strict(p, "scheduleId");
        if (!Guid.TryParseExact(NativeManagement.Text(p, "scheduleId", 36), "D", out _)) throw new AgentMessageException("AGENT_INVALID_SCHEDULE_ID");
    }
    private static void Strict(JsonObject p, params string[] keys)
    {
        if (p.Count != keys.Length || keys.Any(key => !p.ContainsKey(key)) || p.Any(pair => !keys.Contains(pair.Key, StringComparer.Ordinal))) throw new AgentMessageException("AGENT_INVALID_SCHEDULE_PARAMETERS");
    }
    internal static DateTimeOffset ParseUtc(string value)
    {
        if (!Regex.IsMatch(value, @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$") || !DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.None, out var at) || at.Offset != TimeSpan.Zero) throw new AgentMessageException("AGENT_SCHEDULE_TIME_FORMAT");
        return at;
    }
    internal static string CanonicalUtc(DateTimeOffset at) => at.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
    internal static string QuoteArgument(string value)
    {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    internal static string Arguments(JsonObject plan) => (plan["operation"]!.GetValue<string>() == "restart" ? "/r" : "/s") + " /f /t 0 /d p:4:1 /c " + QuoteArgument(plan["reason"]!.GetValue<string>());
    internal static string BuildXml(JsonObject plan, string executable)
    {
        object E(string name, object value) => new XElement(Ns + name, value);
        return new XDocument(new XElement(Ns + "Task", new XAttribute("version", "1.3"),
            new XElement(Ns + "RegistrationInfo", E("Author", "ServerDesk"), E("Description", plan.ToJsonString()), E("Source", Owner)),
            new XElement(Ns + "Triggers", new XElement(Ns + "TimeTrigger", new XAttribute("id", "ServerDeskPower"), E("Enabled", "true"), E("StartBoundary", plan["scheduledAt"]!.GetValue<string>()))),
            new XElement(Ns + "Principals", new XElement(Ns + "Principal", new XAttribute("id", "System"), E("UserId", "S-1-5-18"), E("RunLevel", "HighestAvailable"))),
            new XElement(Ns + "Settings", E("MultipleInstancesPolicy", "IgnoreNew"), E("DisallowStartIfOnBatteries", "false"), E("StopIfGoingOnBatteries", "false"), E("AllowHardTerminate", "true"), E("StartWhenAvailable", "false"), E("RunOnlyIfNetworkAvailable", "false"), E("Enabled", "true"), E("Hidden", "false"), E("RunOnlyIfIdle", "false"), E("WakeToRun", "false"), E("ExecutionTimeLimit", "PT5M"), E("Priority", 7)),
            new XElement(Ns + "Actions", new XAttribute("Context", "System"), new XElement(Ns + "Exec", E("Command", executable), E("Arguments", Arguments(plan)))))).ToString(SaveOptions.DisableFormatting);
    }
    // Parse and verify the complete mutation-relevant definition rather than a
    // display name or source marker alone. This function is testable on Linux.
    internal static JsonObject ParseOwnedXml(string xml, string executable)
    {
        if (xml.Length > 32768) throw new AgentMessageException("AGENT_SCHEDULE_DEFINITION_TOO_LARGE");
        using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 32768 });
        var doc = XDocument.Load(reader); var task = doc.Root;
        if (task?.Name != Ns + "Task") throw new AgentMessageException("AGENT_SCHEDULE_TASK_FOREIGN");
        XElement One(XElement parent, string name) => parent.Elements(Ns + name).SingleOrDefault() ?? throw new AgentMessageException("AGENT_SCHEDULE_DEFINITION_INCOMPLETE");
        string Value(XElement parent, string name) => One(parent, name).Value;
        void Require(bool condition) { if (!condition) throw new AgentMessageException("AGENT_SCHEDULE_OWNERSHIP_UNVERIFIED"); }
        var info = One(task, "RegistrationInfo"); Require(Value(info, "Source") == Owner);
        var plan = JsonNode.Parse(Value(info, "Description"))?.AsObject() ?? throw new AgentMessageException("AGENT_SCHEDULE_METADATA_MISSING");
        Strict(plan, "id", "operation", "scheduledAt", "reason");
        Require(Guid.TryParseExact(NativeManagement.Text(plan, "id", 36), "D", out _));
        NativeManagement.Choice(plan, "operation", "shutdown", "restart"); ParseUtc(NativeManagement.Text(plan, "scheduledAt", 60)); NativeManagement.Text(plan, "reason", 200);
        var triggers = One(task, "Triggers"); Require(triggers.Elements().Count() == 1);
        var trigger = One(triggers, "TimeTrigger"); Require(trigger.Elements().All(e => e.Name == Ns + "StartBoundary" || e.Name == Ns + "Enabled"));
        Require(Regex.IsMatch(Value(trigger, "StartBoundary"), @"(?:Z|[+-]\d{2}:\d{2})$") && DateTimeOffset.TryParse(Value(trigger, "StartBoundary"), CultureInfo.InvariantCulture, DateTimeStyles.None, out var boundary) && boundary.Offset == TimeSpan.Zero && boundary == ParseUtc(plan["scheduledAt"]!.GetValue<string>()) && Value(trigger, "Enabled") == "true");
        var principals = One(task, "Principals"); Require(principals.Elements().Count() == 1);
        var principal = One(principals, "Principal"); Require((string?)principal.Attribute("id") == "System" && Value(principal, "UserId") == "S-1-5-18" && !principal.Elements(Ns + "LogonType").Any() && !principal.Elements(Ns + "GroupId").Any() && Value(principal, "RunLevel") == "HighestAvailable");
        var settings = One(task, "Settings"); Require(Value(settings, "StartWhenAvailable") == "false" && Value(settings, "WakeToRun") == "false" && Value(settings, "RunOnlyIfIdle") == "false" && Value(settings, "RunOnlyIfNetworkAvailable") == "false" && (Value(settings, "Enabled") is "true" or "false") && Value(settings, "MultipleInstancesPolicy") == "IgnoreNew");
        var actions = One(task, "Actions"); Require(actions.Elements().Count() == 1 && (string?)actions.Attribute("Context") == "System");
        var action = One(actions, "Exec"); Require(action.Elements().Count() == 2 && string.Equals(Value(action, "Command"), executable, StringComparison.OrdinalIgnoreCase) && Value(action, "Arguments") == Arguments(plan));
        return plan;
    }
    internal static void InvalidateCache()
    {
        lock (CacheGate) { cacheGeneration++; cacheObserved = true; cachedState = null; }
    }
    private static void AssertRuntimePrincipal(object taskObject)
    {
        object? definitionObject = null, principalObject = null;
        try
        {
            dynamic task = taskObject; dynamic definition = definitionObject = task.Definition; dynamic principal = principalObject = definition.Principal;
            string userId = (string)principal.UserId;
            string sid = userId.Equals("S-1-5-18", StringComparison.OrdinalIgnoreCase) ? userId : ((SecurityIdentifier)new NTAccount(userId).Translate(typeof(SecurityIdentifier))).Value;
            if ((int)principal.LogonType != 5 || sid != "S-1-5-18" || (int)principal.RunLevel != 1) throw new AgentMessageException("AGENT_SCHEDULE_PRINCIPAL");
        }
        finally { NativeManagement.ReleaseCom(principalObject); NativeManagement.ReleaseCom(definitionObject); }
    }
    private static void AssertLocalManagement(string root)
    {
        // Missing protected configuration must not fall back to stale in-memory
        // opt-in after a queued job was admitted.
        NativeManagement.AssertManagement(root, new JsonObject());
    }
    internal static object? FindSchedulerItem(Func<object> lookup)
    {
        // COM interop maps these HRESULTs to typed IO exceptions on .NET.
        // Only an absent item at this lookup boundary means "no plan";
        // access, connection and malformed ownership errors still propagate.
        try { return lookup(); }
        catch (Exception e) when ((e is COMException or FileNotFoundException or DirectoryNotFoundException)
            && (unchecked((uint)e.HResult) is 0x80070002 or 0x80070003)) { return null; }
    }
    private static object? FindFolder(dynamic service)
    {
        return FindSchedulerItem(() => (object)service.GetFolder(FolderPath));
    }
    private static object? FindTask(dynamic folder)
    {
        return FindSchedulerItem(() => (object)folder.GetTask(TaskName));
    }
    internal static JsonObject Collect()
    {
        long generation; lock (CacheGate) generation = cacheGeneration;
        JsonObject Observed(JsonObject? plan) { var state = new JsonObject { ["powerSchedule"] = plan }; Observe(state, generation); return state; }
        object? serviceObject = null, folderObject = null, taskObject = null;
        try
        {
            dynamic service = serviceObject = NativeManagement.CreateCom("Schedule.Service"); service.Connect();
            folderObject = FindFolder(service); if (folderObject is null) return Observed(null);
            dynamic folder = folderObject; taskObject = FindTask(folder); if (taskObject is null) return Observed(null);
            dynamic task = taskObject; AssertRuntimePrincipal(taskObject); JsonObject plan = ParseOwnedXml((string)task.Xml, ShutdownPath);
            // Missed, disabled, or already executed plans are never reported as
            // pending. Task ownership errors remain explicit collection errors.
            if (!(bool)task.Enabled || ParseUtc(plan["scheduledAt"]!.GetValue<string>()) <= DateTimeOffset.UtcNow) return Observed(null);
            return Observed(plan);
        }
        catch { Observe(null, generation); throw; }
        finally { NativeManagement.ReleaseCom(taskObject); NativeManagement.ReleaseCom(folderObject); NativeManagement.ReleaseCom(serviceObject); }
    }
    internal static AgentMessage Schedule(string root, JsonObject config, JsonObject p, CancellationToken token)
    {
        lock (Gate)
        {
            ValidateSchedule(p); token.ThrowIfCancellationRequested();
            object? serviceObject = null, folderObject = null, rootFolderObject = null, taskObject = null, registeredObject = null;
            try
            {
                dynamic service = serviceObject = NativeManagement.CreateCom("Schedule.Service"); service.Connect();
                folderObject = FindFolder(service);
                if (folderObject is null)
                {
                    AssertLocalManagement(root); token.ThrowIfCancellationRequested();
                    dynamic rootFolder = rootFolderObject = service.GetFolder(@"\");
                    folderObject = rootFolder.CreateFolder("ServerDesk", "D:P(A;;FA;;;SY)(A;;FA;;;BA)");
                }
                dynamic folder = folderObject; taskObject = FindTask(folder);
                if (taskObject is not null)
                {
                    dynamic existing = taskObject; AssertRuntimePrincipal(taskObject); string before = (string)existing.Xml; var old = ParseOwnedXml(before, ShutdownPath);
                    if ((bool)existing.Enabled && ParseUtc(old["scheduledAt"]!.GetValue<string>()) > DateTimeOffset.UtcNow || (int)existing.State == 4) throw new AgentMessageException("AGENT_SCHEDULE_EXISTS");
                    AssertLocalManagement(root); token.ThrowIfCancellationRequested();
                    if ((string)existing.Xml != before) throw new AgentMessageException("AGENT_SCHEDULE_CHANGED");
                    folder.DeleteTask(TaskName, 0);
                }
                ValidateSchedule(p); AssertLocalManagement(root); token.ThrowIfCancellationRequested();
                var plan = new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["operation"] = p["operation"]!.DeepClone(), ["scheduledAt"] = CanonicalUtc(ParseUtc(p["scheduledAt"]!.GetValue<string>())), ["reason"] = p["reason"]!.DeepClone() };
                // TASK_CREATE=2 refuses an existing task, including a race with
                // another writer. SYSTEM's service-account logon needs no secret.
                registeredObject = folder.RegisterTask(TaskName, BuildXml(plan, ShutdownPath), 2, "S-1-5-18", null, 5, "D:P(A;;FA;;;SY)(A;;FA;;;BA)");
                dynamic registered = registeredObject; AssertRuntimePrincipal(registeredObject); var verified = ParseOwnedXml((string)registered.Xml, ShutdownPath);
                if (verified["id"]!.GetValue<string>() != plan["id"]!.GetValue<string>()) throw new AgentMessageException("AGENT_SCHEDULE_UNCONFIRMED");
                Mutation(verified);
                return AgentMessages.Of(p["operation"]!.GetValue<string>() == "restart" ? "AGENT_RESTART_SCHEDULED" : "AGENT_SHUTDOWN_SCHEDULED", ("time", plan["scheduledAt"]!.GetValue<string>()), ("scheduleId", plan["id"]!.GetValue<string>()));
            }
            catch { InvalidateCache(); throw; }
            finally { NativeManagement.ReleaseCom(registeredObject); NativeManagement.ReleaseCom(taskObject); NativeManagement.ReleaseCom(rootFolderObject); NativeManagement.ReleaseCom(folderObject); NativeManagement.ReleaseCom(serviceObject); }
        }
    }
    internal static AgentMessage Cancel(string root, JsonObject config, JsonObject p, CancellationToken token)
    {
        lock (Gate)
        {
            ValidateCancel(p); token.ThrowIfCancellationRequested();
            object? serviceObject = null, folderObject = null, taskObject = null;
            try
            {
                dynamic service = serviceObject = NativeManagement.CreateCom("Schedule.Service"); service.Connect();
                folderObject = FindFolder(service); if (folderObject is null) throw new AgentMessageException("AGENT_SCHEDULE_NOT_FOUND");
                dynamic folder = folderObject; taskObject = FindTask(folder); if (taskObject is null) throw new AgentMessageException("AGENT_SCHEDULE_NOT_FOUND");
                dynamic task = taskObject; AssertRuntimePrincipal(taskObject); string before = (string)task.Xml; var plan = ParseOwnedXml(before, ShutdownPath);
                if (!string.Equals(plan["id"]!.GetValue<string>(), p["scheduleId"]!.GetValue<string>(), StringComparison.OrdinalIgnoreCase)) throw new AgentMessageException("AGENT_SCHEDULE_CHANGED_RELOAD");
                if (ParseUtc(plan["scheduledAt"]!.GetValue<string>()) <= DateTimeOffset.UtcNow || (int)task.State == 4) throw new AgentMessageException("AGENT_SCHEDULE_REACHED");
                AssertLocalManagement(root); token.ThrowIfCancellationRequested();
                if ((string)task.Xml != before) throw new AgentMessageException("AGENT_SCHEDULE_CHANGED");
                folder.DeleteTask(TaskName, 0); Mutation(null); return AgentMessages.Of("AGENT_SCHEDULE_CANCELLED", ("scheduleId", p["scheduleId"]!.GetValue<string>()));
            }
            catch { InvalidateCache(); throw; }
            finally { NativeManagement.ReleaseCom(taskObject); NativeManagement.ReleaseCom(folderObject); NativeManagement.ReleaseCom(serviceObject); }
        }
    }
}
