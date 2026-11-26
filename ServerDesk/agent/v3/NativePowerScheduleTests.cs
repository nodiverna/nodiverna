using System.Text.Json.Nodes;
using System.Runtime.InteropServices;
using System.Xml;
using System.Xml.Linq;
using System.Xml.Schema;

namespace ServerDesk.Agent;

internal static class NativePowerScheduleTests
{
    internal static void Run()
    {
        static void Assert(bool value, string label) { if (!value) throw new InvalidOperationException("Native power planning regression: " + label); }
        static void Refused(Action action, string label)
        {
            try { action(); } catch (Exception e) when (e is InvalidDataException or InvalidOperationException or XmlException or XmlSchemaException) { return; }
            throw new InvalidOperationException("Native power planning regression: accepted " + label);
        }
        foreach (uint missingCode in new[] { 0x80070002u, 0x80070003u })
        {
            Exception mapped = Marshal.GetExceptionForHR(unchecked((int)missingCode))!;
            Assert(mapped is FileNotFoundException or DirectoryNotFoundException, "Windows missing-item HRESULT becomes a typed IO exception");
            Assert(NativePowerSchedule.FindSchedulerItem(() => throw mapped) is null, "mapped missing folder/task is a normal no-plan state");
            Assert(NativePowerSchedule.FindSchedulerItem(() => throw new COMException("Missing", unchecked((int)missingCode))) is null, "unmapped missing COM item remains supported");
        }
        object existingItem = new();
        Assert(ReferenceEquals(NativePowerSchedule.FindSchedulerItem(() => existingItem), existingItem), "successful scheduler lookup preserves the owned item");
        foreach (Exception failure in new Exception[] { new UnauthorizedAccessException(), new COMException("Denied", unchecked((int)0x80070005)), new COMException("Disconnected", unchecked((int)0x800704E3)), new InvalidOperationException("Ownership mismatch"), new IOException("Storage unavailable") })
        {
            bool propagated = false;
            try { NativePowerSchedule.FindSchedulerItem(() => throw failure); }
            catch (Exception actual) when (ReferenceEquals(actual, failure)) { propagated = true; }
            Assert(propagated, "non-missing scheduler errors remain inventory failures: " + failure.GetType().Name);
        }
        DateTimeOffset now = DateTimeOffset.Parse("2026-10-24T22:00:00Z");
        JsonObject Parameters(double seconds) => new() { ["operation"] = "shutdown", ["scheduledAt"] = NativePowerSchedule.CanonicalUtc(now.AddSeconds(seconds)), ["reason"] = "Calendar maintenance" };
        foreach (double seconds in new[] { 60d, 3600, 30 * 86400d }) NativePowerSchedule.ValidateSchedule(Parameters(seconds), now);
        foreach (double seconds in new[] { -1d, 0, 59, 30 * 86400d + 1 }) Refused(() => NativePowerSchedule.ValidateSchedule(Parameters(seconds), now), "past/short/long date");
        foreach (var key in new[] { "operation", "scheduledAt", "reason" }) { var p = Parameters(3600); p.Remove(key); Refused(() => NativePowerSchedule.ValidateSchedule(p, now), "missing " + key); }
        foreach (string at in new[] { "2026-10-25T01:00:00", "2026-10-25T01:00:00+01:00", "2026-02-30T01:00:00Z", "2026-10-25", "2026-10-25T01:00:00Z;shutdown" }) { var p = Parameters(3600); p["scheduledAt"] = at; Refused(() => NativePowerSchedule.ValidateSchedule(p, now), "ambiguous/malformed UTC"); }
        // Both occurrences of the local DST-fold hour remain different instants.
        Assert(NativePowerSchedule.ParseUtc("2026-10-25T00:30:00Z") != NativePowerSchedule.ParseUtc("2026-10-25T01:30:00Z"), "DST fold UTC identity");
        foreach (JsonNode? operation in new JsonNode?[] { JsonValue.Create("sleep"), JsonValue.Create(1), JsonValue.Create(true), null }) { var p = Parameters(3600); p["operation"] = operation; Refused(() => NativePowerSchedule.ValidateSchedule(p, now), "invalid operation"); }
        foreach (string reason in new[] { "", "maintenance\nshutdown", new string('x', 201) }) { var p = Parameters(3600); p["reason"] = reason; Refused(() => NativePowerSchedule.ValidateSchedule(p, now), "unsafe reason"); }
        var extra = Parameters(3600); extra["script"] = "powershell"; Refused(() => NativePowerSchedule.ValidateSchedule(extra, now), "unknown script parameter");
        string id = Guid.NewGuid().ToString(); NativePowerSchedule.ValidateCancel(new() { ["scheduleId"] = id });
        Refused(() => NativePowerSchedule.ValidateCancel(new() { ["scheduleId"] = "not-id" }), "cancel identifier");
        Refused(() => NativePowerSchedule.ValidateCancel(new() { ["scheduleId"] = id, ["taskName"] = "Other Task" }), "arbitrary cancellation target");
        const string path = @"C:\Windows\System32\shutdown.exe";
        var plan = Parameters(3600); plan["id"] = id; plan["reason"] = "Quotes \" & < > \\ ends\\";
        string xml = NativePowerSchedule.BuildXml(plan, path); ValidateSchedulerSchema(xml); var parsed = NativePowerSchedule.ParseOwnedXml(xml, path);
        Assert(JsonNode.DeepEquals(parsed, plan), "metadata escaped and round-tripped");
        Assert(NativePowerSchedule.Arguments(plan).StartsWith("/s /f /t 0 /d p:4:1 /c \"", StringComparison.Ordinal), "fixed safe executable arguments");
        Assert(NativePowerSchedule.QuoteArgument("x\"y\\") == "\"x\\\"y\\\\\"", "Windows quote/backslash encoding");
        Refused(() => NativePowerSchedule.ParseOwnedXml(xml, @"D:\Other\shutdown.exe"), "foreign executable");
        Refused(() => NativePowerSchedule.ParseOwnedXml(xml.Replace(NativePowerSchedule.Owner, "Foreign Owner", StringComparison.Ordinal), path), "foreign source");
        XNamespace ns = "http://schemas.microsoft.com/windows/2004/02/mit/task";
        void Changed(Action<XDocument> change, string label) { var doc = XDocument.Parse(xml); change(doc); Refused(() => NativePowerSchedule.ParseOwnedXml(doc.ToString(), path), label); }
        Changed(doc => doc.Descendants(ns + "StartWhenAvailable").Single().Value = "true", "catch-up at boot");
        Changed(doc => doc.Descendants(ns + "WakeToRun").Single().Value = "true", "unexpected wake");
        Changed(doc => doc.Descendants(ns + "UserId").Single().Value = "OtherUser", "wrong principal");
        Changed(doc => doc.Descendants(ns + "Principal").Single().Add(new XElement(ns + "LogonType", "InteractiveToken")), "interactive logon");
        var invalidSchema = XDocument.Parse(xml); invalidSchema.Descendants(ns + "Principal").Single().Add(new XElement(ns + "LogonType", "ServiceAccount"));
        Refused(() => ValidateSchedulerSchema(invalidSchema.ToString()), "unsupported XML ServiceAccount enum (COM uses logonType5 separately)");
        Changed(doc => doc.Descendants(ns + "StartBoundary").Single().Value = "2026-10-24T23:00:00", "missing UTC boundary suffix");
        Changed(doc => doc.Descendants(ns + "Arguments").Single().Value += " /m \\\\OtherHost", "foreign command arguments");
        Changed(doc => doc.Descendants(ns + "Actions").Single().Add(new XElement(ns + "Exec", new XElement(ns + "Command", "cmd.exe"))), "extra command");
        Changed(doc => doc.Descendants(ns + "TimeTrigger").Single().Add(new XElement(ns + "Repetition", new XElement(ns + "Interval", "PT1M"))), "repeat trigger");
        Changed(doc => doc.Descendants(ns + "StartBoundary").Single().Value = "2026-10-25T00:00:01.000Z", "metadata versus execution time");
        Refused(() => NativePowerSchedule.ParseOwnedXml("<!DOCTYPE Task [<!ENTITY unsafe SYSTEM 'file:///etc/passwd'>]>" + xml, path), "XML external entity");
        // Task Scheduler can normalize fractional precision, but the instant
        // must remain identical and explicitly UTC after its COM round-trip.
        var normalized = XDocument.Parse(xml); normalized.Descendants(ns + "StartBoundary").Single().Value = "2026-10-24T23:00:00Z"; NativePowerSchedule.ParseOwnedXml(normalized.ToString(), path);
        normalized.Descendants(ns + "StartBoundary").Single().Value = "2026-10-24T23:00:00+00:00"; NativePowerSchedule.ParseOwnedXml(normalized.ToString(), path);
        var current = new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["operation"] = "restart", ["scheduledAt"] = NativePowerSchedule.CanonicalUtc(DateTimeOffset.UtcNow.AddHours(1)), ["reason"] = "Cache test" };
        long initial = NativePowerSchedule.CacheGeneration; NativePowerSchedule.Mutation(current); NativePowerSchedule.Observe(new JsonObject { ["powerSchedule"] = null }, initial);
        var snapshot = new JsonObject(); NativePowerSchedule.ApplyCurrentState(snapshot);
        Assert(JsonNode.DeepEquals(snapshot["powerSchedule"], current), "late inventory cannot erase successful scheduling");
        snapshot["powerSchedule"]!["reason"] = "Browser mutation"; var another = new JsonObject(); NativePowerSchedule.ApplyCurrentState(another);
        Assert(another["powerSchedule"]!["reason"]!.GetValue<string>() == "Cache test", "heartbeat owns a clone");
        long beforeCancel = NativePowerSchedule.CacheGeneration; NativePowerSchedule.Mutation(null); NativePowerSchedule.Observe(new JsonObject { ["powerSchedule"] = current.DeepClone() }, beforeCancel);
        another = new(); NativePowerSchedule.ApplyCurrentState(another); Assert(another.ContainsKey("powerSchedule") && another["powerSchedule"] is null, "late inventory cannot restore cancelled scheduling");
        NativePowerSchedule.Observe(null, NativePowerSchedule.CacheGeneration); another["powerSchedule"] = current.DeepClone(); NativePowerSchedule.ApplyCurrentState(another); Assert(!another.ContainsKey("powerSchedule"), "failed native read becomes unknown, not no-plan");
        var expired = current.DeepClone().AsObject(); expired["scheduledAt"] = NativePowerSchedule.CanonicalUtc(DateTimeOffset.UtcNow.AddMinutes(-1)); NativePowerSchedule.Mutation(expired); another = new(); NativePowerSchedule.ApplyCurrentState(another); Assert(another.ContainsKey("powerSchedule") && another["powerSchedule"] is null, "expired scheduling never looks pending");
        NativePowerSchedule.Observe(null, NativePowerSchedule.CacheGeneration);
    }
    // Independent, narrow fixture for the portions of Microsoft's published
    // task-scheduler XSD used here. In particular, XML's logon enum omits
    // ServiceAccount, task version is1.3, and trigger order is Enabled/Boundary.
    // https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema
    private static void ValidateSchedulerSchema(string xml)
    {
        const string schema = """
        <xs:schema targetNamespace="http://schemas.microsoft.com/windows/2004/02/mit/task" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:t="http://schemas.microsoft.com/windows/2004/02/mit/task" elementFormDefault="qualified">
          <xs:element name="Task"><xs:complexType><xs:all>
            <xs:element name="RegistrationInfo"><xs:complexType><xs:all><xs:element name="Author" type="xs:string"/><xs:element name="Description" type="xs:string"/><xs:element name="Source" type="xs:string"/></xs:all></xs:complexType></xs:element>
            <xs:element name="Triggers"><xs:complexType><xs:sequence><xs:element name="TimeTrigger"><xs:complexType><xs:sequence><xs:element name="Enabled" type="xs:boolean"/><xs:element name="StartBoundary" type="xs:dateTime"/></xs:sequence><xs:attribute name="id" type="xs:ID"/></xs:complexType></xs:element></xs:sequence></xs:complexType></xs:element>
            <xs:element name="Principals"><xs:complexType><xs:sequence><xs:element name="Principal"><xs:complexType><xs:all>
              <xs:element name="UserId" type="xs:string"/>
              <xs:element name="LogonType" minOccurs="0"><xs:simpleType><xs:restriction base="xs:string"><xs:enumeration value="S4U"/><xs:enumeration value="Password"/><xs:enumeration value="InteractiveToken"/><xs:enumeration value="InteractiveTokenOrPassword"/></xs:restriction></xs:simpleType></xs:element>
              <xs:element name="RunLevel"><xs:simpleType><xs:restriction base="xs:string"><xs:enumeration value="LeastPrivilege"/><xs:enumeration value="HighestAvailable"/></xs:restriction></xs:simpleType></xs:element>
            </xs:all><xs:attribute name="id" type="xs:ID"/></xs:complexType></xs:element></xs:sequence></xs:complexType></xs:element>
            <xs:element name="Settings"><xs:complexType><xs:all>
              <xs:element name="MultipleInstancesPolicy" type="xs:string"/>
              <xs:element name="DisallowStartIfOnBatteries" type="xs:boolean"/><xs:element name="StopIfGoingOnBatteries" type="xs:boolean"/>
              <xs:element name="AllowHardTerminate" type="xs:boolean"/><xs:element name="StartWhenAvailable" type="xs:boolean"/>
              <xs:element name="RunOnlyIfNetworkAvailable" type="xs:boolean"/><xs:element name="Enabled" type="xs:boolean"/>
              <xs:element name="Hidden" type="xs:boolean"/><xs:element name="RunOnlyIfIdle" type="xs:boolean"/><xs:element name="WakeToRun" type="xs:boolean"/>
              <xs:element name="ExecutionTimeLimit" type="xs:duration"/><xs:element name="Priority" type="xs:byte"/>
            </xs:all></xs:complexType></xs:element>
            <xs:element name="Actions"><xs:complexType><xs:sequence><xs:element name="Exec"><xs:complexType><xs:sequence><xs:element name="Command" type="xs:string"/><xs:element name="Arguments" type="xs:string"/></xs:sequence></xs:complexType></xs:element></xs:sequence><xs:attribute name="Context" type="xs:IDREF"/></xs:complexType></xs:element>
          </xs:all><xs:attribute name="version" type="xs:string" fixed="1.3"/></xs:complexType></xs:element>
        </xs:schema>
        """;
        var set = new XmlSchemaSet(); set.Add("http://schemas.microsoft.com/windows/2004/02/mit/task", XmlReader.Create(new StringReader(schema)));
        var settings = new XmlReaderSettings { ValidationType = ValidationType.Schema, Schemas = set, DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
        settings.ValidationEventHandler += (_, e) => throw new XmlSchemaValidationException(e.Message);
        using var reader = XmlReader.Create(new StringReader(xml), settings); while (reader.Read()) { }
    }

}
