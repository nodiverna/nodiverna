using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Plugin.Dhcp;

// The changes of DHCP plugin 1.1.0 (docs/dhcp-server.md, "Change the DHCP
// server"). One operation per change, each validated again here against the
// same bounds as lib/dhcp-changes.ts, then run against the local DHCP server
// (every call names server null: no network connection). A multi-step change
// undoes its earlier steps when a later one fails, where the API allows it.
// After a successful change the plugin reads the server again and returns the
// snapshot, so the broker uploads it with the job id.
//
// Memory rule (plugin 1.1.1): memory that the DHCP API returns is never freed.
// The broker starts the plugin for one request and the process then ends
// (agent/v3/PluginHost.cs), so Windows frees it. Freeing the nested pointers
// with DhcpRpcFreeMemory corrupted the heap (0xC0000374) on a server with
// scopes. Input structs are the plugin's own memory: the Native scope of
// DhcpWriter allocates, clears and frees them.

/// <summary>A value of the request that is not valid: PLUGIN_DHCP_INVALID_CHANGE {field}.</summary>
internal sealed class InvalidChangeException(string field) : Exception("The field " + field + " is not valid.")
{
    internal string Field { get; } = field;
}
/// <summary>A refusal with its plugin code, for example PLUGIN_DHCP_OBJECT_MISSING {object}.</summary>
internal sealed class ChangeRefusedException(string code, params (string Name, string Value)[] args) : Exception(code)
{
    internal string Code { get; } = code;
    internal Dictionary<string, string> Args { get; } = args.ToDictionary(pair => pair.Name, pair => pair.Value, StringComparer.Ordinal);
}

/// <summary>Typed reads of the request parameters; every read validates and throws InvalidChangeException with the field name.</summary>
internal sealed class ChangeInput(JsonObject values)
{
    internal JsonObject Values { get; } = values;
    internal bool Has(string name) => Values[name] is not null;
    internal string Text(string name, int max, bool required = false, bool optional = false)
    {
        if (Values[name] is null && optional) return "";
        if (Values[name] is not JsonValue item || !item.TryGetValue<string>(out var text) || text is null || text.Length > max || text.Any(char.IsControl) || required && text.Trim().Length == 0) throw new InvalidChangeException(name);
        return text;
    }
    internal string? NullableText(string name, int max) => Values[name] is null ? null : Text(name, max);
    internal long Integer(string name, long min, long max)
    {
        if (Values[name] is not JsonValue item || !item.TryGetValue<long>(out long number) || number < min || number > max) throw new InvalidChangeException(name);
        return number;
    }
    internal long? NullableInteger(string name, long min, long max) => Values[name] is null ? null : Integer(name, min, max);
    internal bool Flag(string name)
    {
        if (Values[name] is not JsonValue item || !item.TryGetValue<bool>(out bool value)) throw new InvalidChangeException(name);
        return value;
    }
    internal string Choice(string name, params string[] allowed) { string value = Text(name, 32); if (!allowed.Contains(value, StringComparer.Ordinal)) throw new InvalidChangeException(name); return value; }
    internal uint Ipv4(string name) => DhcpChanges.ParseIpv4(Text(name, 15)) ?? throw new InvalidChangeException(name);
    internal byte[] Ipv6(string name) => DhcpChanges.ParseIpv6(Text(name, 45)) ?? throw new InvalidChangeException(name);
    internal byte[] Prefix(string name) { var value = Ipv6(name); if (value.Skip(8).Any(b => b != 0)) throw new InvalidChangeException(name); return value; }
    internal JsonArray Array(string name, int min, int max)
    {
        if (Values[name] is not JsonArray list || list.Count < min || list.Count > max) throw new InvalidChangeException(name);
        return list;
    }
    internal List<string> Strings(string name, int min, int max, int length) => Array(name, min, max).Select(item => item is JsonValue value && value.TryGetValue<string>(out var text) && text is not null && text.Length <= length && !text.Any(char.IsControl) ? text : throw new InvalidChangeException(name)).ToList();
    internal List<uint> Ipv4List(string name, int min, int max) { var list = Strings(name, min, max, 15).Select(text => DhcpChanges.ParseIpv4(text) ?? throw new InvalidChangeException(name)).ToList(); if (list.Distinct().Count() != list.Count) throw new InvalidChangeException(name); return list; }
    internal ChangeInput Child(JsonNode? node, string name) => node is JsonObject child ? new ChangeInput(child) : throw new InvalidChangeException(name);
    /// <summary>Only these keys may appear (the strict schemas of the portal).</summary>
    internal void Only(params string[] keys) { foreach (var pair in Values) if (!keys.Contains(pair.Key, StringComparer.Ordinal)) throw new InvalidChangeException(pair.Key); }
}

/// <summary>One value of an option in the API types (DHCP_OPTION_DATA_TYPE).</summary>
internal sealed record OptionElement(int Type, ulong Number, string? Text, byte[]? Bytes);
/// <summary>A policy condition in API terms (DHCP_POL_COND).</summary>
internal sealed record PolicyConditionData(int Type, uint OptionId, uint SubOptionId, int Operator, byte[] Value);

internal static class DhcpChanges
{
    internal static readonly string[] Operations =
    [
        "dhcp-scope-create", "dhcp-scope-edit", "dhcp-scope-activate", "dhcp-scope-deactivate", "dhcp-scope-delete",
        "dhcp-superscope-create", "dhcp-superscope-edit", "dhcp-superscope-activate", "dhcp-superscope-deactivate", "dhcp-superscope-delete",
        "dhcp-exclusion-add", "dhcp-exclusion-remove", "dhcp-reservation-add", "dhcp-reservation-edit", "dhcp-reservation-remove", "dhcp-lease-delete",
        "dhcp-option-set", "dhcp-option-remove", "dhcp-policy-create", "dhcp-policy-edit", "dhcp-policy-delete",
        "dhcp-failover-create", "dhcp-failover-edit", "dhcp-failover-remove", "dhcp-scope-apply",
    ];
    internal const long LeaseMin = 60, LeaseMax = 86_313_600, Unlimited = 0xFFFFFFFF;
        private static readonly string[] Criteria = ["mac", "vendorClass", "userClass", "clientId", "relayAgent", "circuitId", "remoteId", "subscriberId", "fqdn"];

    // ---- Addresses ---------------------------------------------------------------------------
    internal static uint? ParseIpv4(string text)
    {
        var parts = text.Split('.');
        if (parts.Length != 4) return null;
        uint value = 0;
        foreach (var part in parts)
        {
            if (part.Length is < 1 or > 3 || part.Length > 1 && part[0] == '0' || !part.All(char.IsAsciiDigit) || !uint.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out uint octet) || octet > 255) return null;
            value = value << 8 | octet;
        }
        return value;
    }
    internal static byte[]? ParseIpv6(string text)
    {
        if (text.Length is < 2 or > 45 || !text.All(c => Uri.IsHexDigit(c) || c is ':' or '.')) return null;
        return IPAddress.TryParse(text, out var address) && address.AddressFamily == AddressFamily.InterNetworkV6 ? address.GetAddressBytes() : null;
    }
    /// <summary>Hexadecimal bytes with -, :, . or no separator; null when the text is none.</summary>
    internal static byte[]? HexBytes(string text, int maximum)
    {
        string plain = new(text.Where(c => c is not ('-' or ':' or '.' or ' ')).ToArray());
        if (plain.Length < 2 || plain.Length % 2 != 0 || plain.Length > maximum * 2 || !plain.All(Uri.IsHexDigit)) return null;
        return Convert.FromHexString(plain);
    }
    internal static int MaskBits(uint mask) { for (int bits = 8; bits <= 30; bits++) if (mask == unchecked((uint)(0xFFFFFFFFUL << (32 - bits)))) return bits; return -1; }
    internal static uint Network(uint address, uint mask) => address & mask;

    // ---- Validation (the strict schemas of lib/dhcp-changes.ts) ------------------------------------
    private static void LeaseDuration(ChangeInput p) { if (p.Values["leaseDurationSeconds"] is not null) p.Integer("leaseDurationSeconds", LeaseMin, LeaseMax); else if (!p.Values.ContainsKey("leaseDurationSeconds")) throw new InvalidChangeException("leaseDurationSeconds"); }
    private static string Family(ChangeInput p) => p.Choice("family", "ipv4", "ipv6");
    private static void ScopeRef(ChangeInput p, string family) { if (family == "ipv4") p.Ipv4("scopeId"); else p.Prefix("prefix"); }
    private static void Criterion(ChangeInput c)
    {
        c.Only("type", "operator", "values"); c.Choice("type", Criteria); c.Choice("operator", "equals", "notEquals");
        foreach (var value in c.Strings("values", 1, 32, 256)) if (value.Length == 0) throw new InvalidChangeException("criteria");
    }
    private static void Range(ChangeInput r, string field) { r.Only("start", "end"); uint start = r.Ipv4("start"), end = r.Ipv4("end"); if (end < start) throw new InvalidChangeException(field); }

    /// <summary>Checks every field of one operation; throws InvalidChangeException with the field.</summary>
    internal static void Validate(string operation, JsonObject values)
    {
        var p = new ChangeInput(values);
        switch (operation)
        {
            case "dhcp-scope-create":
            case "dhcp-scope-edit":
            {
                bool create = operation == "dhcp-scope-create"; string family = Family(p);
                if (family == "ipv6")
                {
                    p.Only(create ? ["family", "prefix", "name", "description", "preference", "activate"] : ["family", "prefix", "name", "description", "preference"]);
                    p.Prefix("prefix"); p.Text("name", 256, required: true); p.Text("description", 1024); p.Integer("preference", 0, 255); if (create) p.Flag("activate");
                    break;
                }
                p.Only(create ? ["family", "scopeId", "name", "description", "startRange", "endRange", "subnetMask", "leaseDurationSeconds", "type", "activate"] : ["family", "scopeId", "name", "description", "startRange", "endRange", "leaseDurationSeconds", "type"]);
                p.Text("name", 256, required: true); p.Text("description", 1024); uint start = p.Ipv4("startRange"), end = p.Ipv4("endRange");
                if (end < start) throw new InvalidChangeException("endRange");
                LeaseDuration(p); p.Choice("type", "dhcp", "bootp", "both");
                if (create)
                {
                    uint mask = p.Ipv4("subnetMask"); if (MaskBits(mask) < 0) throw new InvalidChangeException("subnetMask");
                    if (Network(start, mask) != Network(end, mask)) throw new InvalidChangeException("endRange");
                    if (p.Has("scopeId") && p.Ipv4("scopeId") != Network(start, mask)) throw new InvalidChangeException("scopeId");
                    p.Flag("activate");
                }
                else p.Ipv4("scopeId");
                break;
            }
            case "dhcp-scope-activate": case "dhcp-scope-deactivate": case "dhcp-scope-delete":
            {
                string family = Family(p); p.Only("family", family == "ipv4" ? "scopeId" : "prefix"); ScopeRef(p, family); break;
            }
            case "dhcp-superscope-create": p.Only("name", "scopeIds"); p.Text("name", 256, required: true); p.Ipv4List("scopeIds", 1, 500); break;
            case "dhcp-superscope-edit": p.Only("name", "newName", "scopeIds"); p.Text("name", 256, required: true); if (p.Has("newName")) p.Text("newName", 256, required: true); p.Ipv4List("scopeIds", 1, 500); break;
            case "dhcp-superscope-activate": case "dhcp-superscope-deactivate": case "dhcp-superscope-delete": p.Only("name"); p.Text("name", 256, required: true); break;
            case "dhcp-exclusion-add": case "dhcp-exclusion-remove":
            {
                string family = Family(p); p.Only("family", family == "ipv4" ? "scopeId" : "prefix", "start", "end"); ScopeRef(p, family);
                if (family == "ipv4") { if (p.Ipv4("end") < p.Ipv4("start")) throw new InvalidChangeException("end"); }
                else if (new System.Numerics.BigInteger(p.Ipv6("end"), true, true) < new System.Numerics.BigInteger(p.Ipv6("start"), true, true)) throw new InvalidChangeException("end");
                break;
            }
            case "dhcp-reservation-add": case "dhcp-reservation-edit":
            {
                bool edit = operation == "dhcp-reservation-edit"; string family = Family(p);
                if (family == "ipv4")
                {
                    p.Only(edit ? ["family", "scopeId", "address", "newAddress", "clientId", "name", "description", "type"] : ["family", "scopeId", "address", "clientId", "name", "description", "type"]);
                    p.Ipv4("scopeId"); p.Ipv4("address"); if (edit && p.Has("newAddress")) p.Ipv4("newAddress");
                    if (HexBytes(p.Text("clientId", 256), 85) is null) throw new InvalidChangeException("clientId");
                    p.Text("name", 256, required: true); p.Text("description", 1024); p.Choice("type", "dhcp", "bootp", "both");
                }
                else
                {
                    p.Only(edit ? ["family", "prefix", "address", "newAddress", "duid", "iaid"] : ["family", "prefix", "address", "duid", "iaid"]);
                    p.Prefix("prefix"); p.Ipv6("address"); if (edit && p.Has("newAddress")) p.Ipv6("newAddress");
                    if (HexBytes(p.Text("duid", 400), 130) is not { Length: >= 2 }) throw new InvalidChangeException("duid");
                    p.Integer("iaid", 0, uint.MaxValue);
                }
                break;
            }
            case "dhcp-reservation-remove":
            {
                string family = Family(p); p.Only("family", family == "ipv4" ? "scopeId" : "prefix", "address"); ScopeRef(p, family); if (family == "ipv4") p.Ipv4("address"); else p.Ipv6("address"); break;
            }
            case "dhcp-lease-delete":
            {
                string family = Family(p); p.Only("family", family == "ipv4" ? "scopeId" : "prefix", "addresses"); ScopeRef(p, family);
                if (family == "ipv4") p.Ipv4List("addresses", 1, 100); else foreach (var text in p.Strings("addresses", 1, 100, 45)) if (ParseIpv6(text) is null) throw new InvalidChangeException("addresses");
                break;
            }
            case "dhcp-option-set": case "dhcp-option-remove":
            {
                bool set = operation == "dhcp-option-set";
                p.Only(set ? ["family", "level", "scopeId", "prefix", "policy", "code", "vendorClass", "userClass", "values"] : ["family", "level", "scopeId", "prefix", "policy", "code", "vendorClass", "userClass"]);
                string family = Family(p), level = p.Choice("level", "server", "scope", "policy");
                if (family == "ipv6" && level == "policy") throw new InvalidChangeException("level");
                if (level == "scope") { if (family == "ipv4") p.Ipv4("scopeId"); else p.Prefix("prefix"); }
                if (level == "policy") { p.Text("policy", 256, required: true); if (p.Values["scopeId"] is not null) p.Ipv4("scopeId"); }
                p.Integer("code", 0, 65535); p.NullableText("vendorClass", 128); p.NullableText("userClass", 128);
                if (set) p.Strings("values", 1, 32, 512);
                break;
            }
            case "dhcp-policy-create": case "dhcp-policy-edit":
            {
                bool edit = operation == "dhcp-policy-edit";
                p.Only(edit ? ["scopeId", "name", "newName", "description", "enabled", "order", "condition", "criteria", "ranges", "leaseDurationSeconds"] : ["scopeId", "name", "description", "enabled", "order", "condition", "criteria", "ranges", "leaseDurationSeconds"]);
                bool scoped = p.Values["scopeId"] is not null; if (scoped) p.Ipv4("scopeId"); else if (!p.Values.ContainsKey("scopeId")) throw new InvalidChangeException("scopeId");
                p.Text("name", 256, required: true); if (edit && p.Has("newName")) p.Text("newName", 256, required: true); p.Text("description", 1024); p.Flag("enabled"); p.Integer("order", 1, 65535); p.Choice("condition", "and", "or");
                foreach (var item in p.Array("criteria", 1, 32)) Criterion(p.Child(item, "criteria"));
                var ranges = p.Array("ranges", 0, 32); if (ranges.Count > 0 && !scoped) throw new InvalidChangeException("ranges");
                foreach (var item in ranges) Range(p.Child(item, "ranges"), "ranges");
                LeaseDuration(p);
                break;
            }
            case "dhcp-policy-delete":
                p.Only("scopeId", "name"); if (p.Values["scopeId"] is not null) p.Ipv4("scopeId"); else if (!p.Values.ContainsKey("scopeId")) throw new InvalidChangeException("scopeId"); p.Text("name", 256, required: true); break;
            case "dhcp-failover-create":
                p.Only("name", "partner", "serverType", "mode", "loadBalancePercent", "serverRole", "reservePercent", "mcltSeconds", "autoStateTransition", "stateSwitchIntervalSeconds", "messageAuthentication", "scopeIds", "serverAddress", "partnerAddress", "secrets");
                p.Text("name", 256, required: true); p.Text("partner", 256, required: true); p.Choice("serverType", "primary", "secondary"); p.Choice("mode", "loadBalance", "hotStandby");
                p.Integer("loadBalancePercent", 0, 100); p.Choice("serverRole", "active", "standby"); p.Integer("reservePercent", 0, 100); p.Integer("mcltSeconds", 60, 3_600_000); p.Flag("autoStateTransition");
                p.NullableInteger("stateSwitchIntervalSeconds", 60, LeaseMax); p.Flag("messageAuthentication"); p.Ipv4List("scopeIds", 1, 500); p.Ipv4("serverAddress"); p.Ipv4("partnerAddress");
                break;
            case "dhcp-failover-edit":
                p.Only("name", "loadBalancePercent", "reservePercent", "mcltSeconds", "autoStateTransition", "stateSwitchIntervalSeconds", "messageAuthentication", "addScopeIds", "removeScopeIds", "deleteRemovedScopes", "secrets");
                p.Text("name", 256, required: true);
                if (p.Has("loadBalancePercent")) p.Integer("loadBalancePercent", 0, 100); if (p.Has("reservePercent")) p.Integer("reservePercent", 0, 100);
                if (p.Has("mcltSeconds")) p.Integer("mcltSeconds", 60, 3_600_000); if (p.Has("autoStateTransition")) p.Flag("autoStateTransition");
                if (p.Has("stateSwitchIntervalSeconds")) p.Integer("stateSwitchIntervalSeconds", 60, LeaseMax); if (p.Has("messageAuthentication")) p.Flag("messageAuthentication");
                if (p.Has("addScopeIds")) p.Ipv4List("addScopeIds", 0, 500); if (p.Has("removeScopeIds")) p.Ipv4List("removeScopeIds", 0, 500); if (p.Has("deleteRemovedScopes")) p.Flag("deleteRemovedScopes");
                break;
            case "dhcp-failover-remove": p.Only("name", "deletePartnerScopes"); p.Text("name", 256, required: true); p.Flag("deletePartnerScopes"); break;
            case "dhcp-scope-apply": ScopeApply.Validate(p); break;
            default: throw new InvalidChangeException("operation");
        }
    }

    // ---- Option values ----------------------------------------------------------------------------
    /// <summary>The values of an option as API elements of its type (0 byte … 8 IPv6 address); InvalidChangeException("values") for a value that does not fit.</summary>
    internal static List<OptionElement> OptionValues(int type, bool multiValued, IReadOnlyList<string> values)
    {
        if (values.Count == 0 || values.Count > 32 || !multiValued && values.Count > 1) throw new InvalidChangeException("values");
        return values.Select(raw =>
        {
            string value = raw.Trim();
            ulong Whole(ulong max) => value.Length is > 0 and <= 20 && value.All(char.IsAsciiDigit) && ulong.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out ulong number) && number <= max ? number : throw new InvalidChangeException("values");
            return type switch
            {
                0 => new OptionElement(0, Whole(255), null, null),
                1 => new OptionElement(1, Whole(65535), null, null),
                2 => new OptionElement(2, Whole(uint.MaxValue), null, null),
                3 => new OptionElement(3, Whole(ulong.MaxValue), null, null),
                4 => new OptionElement(4, ParseIpv4(value) ?? throw new InvalidChangeException("values"), null, null),
                5 => value.Length is > 0 and <= 512 ? new OptionElement(5, 0, value, null) : throw new InvalidChangeException("values"),
                6 or 7 => new OptionElement(type, 0, null, HexBytes(value, 255) ?? throw new InvalidChangeException("values")),
                8 => ParseIpv6(value) is not null ? new OptionElement(8, 0, value, null) : throw new InvalidChangeException("values"),
                _ => throw new InvalidChangeException("values"),
            };
        }).ToList();
    }

    /// <summary>A criterion of the portal as API conditions: one condition per value; a leading or trailing * is a begins-with or ends-with match.</summary>
    internal static List<PolicyConditionData> Conditions(string criterion, string op, IEnumerable<string> values)
    {
        var result = new List<PolicyConditionData>();
        foreach (string raw in values)
        {
            bool begins = raw.EndsWith('*'), ends = !begins && raw.StartsWith('*'); string value = raw.Trim('*');
            int comparator = op == "equals" ? (begins ? 2 : ends ? 4 : 0) : (begins ? 3 : ends ? 5 : 1);
            (int Type, uint Option, uint Sub, bool Ascii) target = criterion switch
            {
                "mac" => (0, 0u, 0u, false), "vendorClass" => (1, 60u, 0u, true), "userClass" => (1, 77u, 0u, true), "clientId" => (1, 61u, 0u, false),
                "relayAgent" => (1, 82u, 0u, false), "circuitId" => (2, 82u, 1u, false), "remoteId" => (2, 82u, 2u, false), "subscriberId" => (2, 82u, 6u, false), "fqdn" => (3, 81u, 0u, true),
                _ => throw new InvalidChangeException("criteria"),
            };
            byte[] bytes = target.Ascii ? (value.All(c => c is >= ' ' and < (char)127) && value.Length is > 0 and <= 255 ? Encoding.ASCII.GetBytes(value) : throw new InvalidChangeException("criteria")) : HexBytes(value, 255) ?? throw new InvalidChangeException("criteria");
            result.Add(new PolicyConditionData(target.Type, target.Option, target.Sub, comparator, bytes));
        }
        return result;
    }

    // ---- Running a change -----------------------------------------------------------------------------
    /// <summary>
    /// One change: validate, check the role and the service, run it, read the
    /// server again. A secret never appears in a result.
    /// </summary>
    internal static Program.Outcome Run(string operation, JsonObject parameters, Func<Program.Outcome> read, IDhcpWriter? writer = null)
    {
        var none = new Dictionary<string, string>();
        try { Validate(operation, parameters); }
        catch (InvalidChangeException e) { return new Program.Outcome(false, "PLUGIN_DHCP_INVALID_CHANGE", new Dictionary<string, string> { ["field"] = e.Field }, null); }
        var target = writer ?? new DhcpWriter();
        var service = target.Service();
        if (service == DhcpService.Status.Missing) return new Program.Outcome(false, "PLUGIN_DHCP_NOT_INSTALLED", none, null);
        if (service != DhcpService.Status.Running) return new Program.Outcome(false, "PLUGIN_DHCP_SERVICE_STOPPED", none, null);
        try { Execute(operation, new ChangeInput(parameters), target); }
        catch (InvalidChangeException e) { return new Program.Outcome(false, "PLUGIN_DHCP_INVALID_CHANGE", new Dictionary<string, string> { ["field"] = e.Field }, null); }
        catch (ChangeRefusedException e) { return new Program.Outcome(false, e.Code, e.Args, null); }
        catch (DhcpApiException e) { return Refused(e); }
        var after = read();
        return after.Data is JsonObject data && after.Ok ? new Program.Outcome(true, "PLUGIN_DHCP_CHANGED", none, data) : new Program.Outcome(true, "PLUGIN_DHCP_CHANGED_NOT_READ", none, null);
    }

    // DHCP server error codes (dhcpmsg.h) that name an existing or a missing object.
    private static readonly uint[] ExistsCodes = [20004, 20009, 20014, 20021, 20022, 20117];
    private static readonly uint[] MissingCodes = [20005, 20010, 20018, 20118, 20119];
    internal static Program.Outcome Refused(DhcpApiException e)
    {
        string code = e.Code == DhcpApi.AccessDenied ? "PLUGIN_DHCP_ACCESS_DENIED" : ExistsCodes.Contains(e.Code) ? "PLUGIN_DHCP_OBJECT_EXISTS" : MissingCodes.Contains(e.Code) ? "PLUGIN_DHCP_OBJECT_MISSING" : "PLUGIN_DHCP_CHANGE_FAILED";
        var args = code switch { "PLUGIN_DHCP_OBJECT_EXISTS" or "PLUGIN_DHCP_OBJECT_MISSING" => new Dictionary<string, string> { ["object"] = e.Object ?? e.Call }, "PLUGIN_DHCP_CHANGE_FAILED" => new Dictionary<string, string> { ["error"] = e.Code.ToString(CultureInfo.InvariantCulture) }, _ => new Dictionary<string, string>() };
        return new Program.Outcome(false, code, args, null);
    }

    private static string Secret(ChangeInput p)
    {
        if (p.Values["secrets"] is not JsonObject secrets || secrets["secret"] is not JsonValue value || !value.TryGetValue<string>(out var secret) || secret is null || secret.Length is < 8 or > 255) throw new ChangeRefusedException("PLUGIN_DHCP_SECRET_MISSING");
        return secret;
    }

    private static void Execute(string operation, ChangeInput p, IDhcpWriter w)
    {
        string family = p.Has("family") ? p.Text("family", 8) : "ipv4";
        switch (operation)
        {
            case "dhcp-scope-create":
                if (family == "ipv6") w.CreateScopeV6(p.Prefix("prefix"), p.Text("name", 256), p.Text("description", 1024), (ushort)p.Integer("preference", 0, 255), p.Flag("activate"));
                else w.CreateScope(p.Ipv4("startRange"), p.Ipv4("endRange"), p.Ipv4("subnetMask"), p.Text("name", 256), p.Text("description", 1024), p.NullableInteger("leaseDurationSeconds", LeaseMin, LeaseMax), p.Text("type", 8), p.Flag("activate"));
                break;
            case "dhcp-scope-edit":
                if (family == "ipv6") w.EditScopeV6(p.Prefix("prefix"), p.Text("name", 256), p.Text("description", 1024), (ushort)p.Integer("preference", 0, 255));
                else w.EditScope(p.Ipv4("scopeId"), p.Ipv4("startRange"), p.Ipv4("endRange"), p.Text("name", 256), p.Text("description", 1024), p.NullableInteger("leaseDurationSeconds", LeaseMin, LeaseMax), p.Text("type", 8));
                break;
            case "dhcp-scope-activate": case "dhcp-scope-deactivate":
                if (family == "ipv6") w.ScopeStateV6(p.Prefix("prefix"), operation == "dhcp-scope-activate"); else w.ScopeState(p.Ipv4("scopeId"), operation == "dhcp-scope-activate");
                break;
            case "dhcp-scope-delete":
                if (family == "ipv6") w.DeleteScopeV6(p.Prefix("prefix"));
                else { uint scope = p.Ipv4("scopeId"); if (w.InFailover(scope)) throw new ChangeRefusedException("PLUGIN_DHCP_IN_FAILOVER", ("scope", DhcpSnapshot.Ipv4(scope))); w.DeleteScope(scope); }
                break;
            case "dhcp-superscope-create": w.SetSuperscope(p.Text("name", 256), null, p.Ipv4List("scopeIds", 1, 500), create: true); break;
            case "dhcp-superscope-edit": w.SetSuperscope(p.Text("name", 256), p.Has("newName") ? p.Text("newName", 256) : null, p.Ipv4List("scopeIds", 1, 500), create: false); break;
            case "dhcp-superscope-activate": case "dhcp-superscope-deactivate": foreach (uint scope in w.SuperscopeMembers(p.Text("name", 256))) w.ScopeState(scope, operation == "dhcp-superscope-activate"); break;
            case "dhcp-superscope-delete": w.DeleteSuperscope(p.Text("name", 256)); break;
            case "dhcp-exclusion-add": case "dhcp-exclusion-remove":
            {
                bool add = operation == "dhcp-exclusion-add";
                if (family == "ipv6") w.ExclusionV6(p.Prefix("prefix"), p.Ipv6("start"), p.Ipv6("end"), add); else w.Exclusion(p.Ipv4("scopeId"), p.Ipv4("start"), p.Ipv4("end"), add);
                break;
            }
            case "dhcp-reservation-add":
                if (family == "ipv6") w.AddReservationV6(p.Prefix("prefix"), p.Ipv6("address"), HexBytes(p.Text("duid", 400), 130)!, (uint)p.Integer("iaid", 0, uint.MaxValue));
                else w.AddReservation(p.Ipv4("scopeId"), p.Ipv4("address"), HexBytes(p.Text("clientId", 256), 85)!, p.Text("type", 8), p.Text("name", 256), p.Text("description", 1024));
                break;
            case "dhcp-reservation-edit":
                if (family == "ipv6") w.EditReservationV6(p.Prefix("prefix"), p.Ipv6("address"), p.Has("newAddress") ? p.Ipv6("newAddress") : p.Ipv6("address"), HexBytes(p.Text("duid", 400), 130)!, (uint)p.Integer("iaid", 0, uint.MaxValue));
                else w.EditReservation(p.Ipv4("scopeId"), p.Ipv4("address"), p.Has("newAddress") ? p.Ipv4("newAddress") : p.Ipv4("address"), HexBytes(p.Text("clientId", 256), 85)!, p.Text("type", 8), p.Text("name", 256), p.Text("description", 1024));
                break;
            case "dhcp-reservation-remove":
                if (family == "ipv6") w.RemoveReservationV6(p.Prefix("prefix"), p.Ipv6("address")); else w.RemoveReservation(p.Ipv4("scopeId"), p.Ipv4("address"));
                break;
            case "dhcp-lease-delete":
                if (family == "ipv6") foreach (var text in p.Strings("addresses", 1, 100, 45)) w.DeleteLeaseV6(ParseIpv6(text)!);
                else foreach (uint address in p.Ipv4List("addresses", 1, 100)) w.DeleteLease(address);
                break;
            case "dhcp-option-set": case "dhcp-option-remove":
            {
                var target = new OptionTarget(family, p.Text("level", 8), family == "ipv4" && p.Values["scopeId"] is not null ? p.Ipv4("scopeId") : null, family == "ipv6" && p.Has("prefix") ? p.Prefix("prefix") : null, p.Has("policy") ? p.Text("policy", 256) : null);
                int code = (int)p.Integer("code", 0, 65535); string? vendor = p.NullableText("vendorClass", 128), user = p.NullableText("userClass", 128);
                if (operation == "dhcp-option-remove") { w.RemoveOption(target, code, vendor, user); break; }
                var (type, multi) = w.OptionType(family, code, vendor);
                w.SetOption(target, code, vendor, user, OptionValues(type, multi, p.Strings("values", 1, 32, 512)));
                break;
            }
            case "dhcp-policy-create": case "dhcp-policy-edit":
                w.SetPolicy(PolicyOf(p), operation == "dhcp-policy-create", p.Has("newName") ? p.Text("newName", 256) : null);
                break;
            case "dhcp-policy-delete": w.DeletePolicy(p.Values["scopeId"] is null ? null : p.Ipv4("scopeId"), p.Text("name", 256)); break;
            case "dhcp-failover-create":
            {
                bool auth = p.Flag("messageAuthentication"); string? secret = auth ? Secret(p) : null;
                w.CreateFailover(new FailoverData(p.Text("name", 256), p.Text("partner", 256), p.Text("serverType", 16) == "primary", p.Text("mode", 16) == "hotStandby", (byte)p.Integer("loadBalancePercent", 0, 100), p.Text("serverRole", 16) == "active",
                    (byte)p.Integer("reservePercent", 0, 100), (uint)p.Integer("mcltSeconds", 60, 3_600_000), p.Flag("autoStateTransition") ? (uint)(p.NullableInteger("stateSwitchIntervalSeconds", 60, LeaseMax) ?? 3600) : 0, p.Ipv4("serverAddress"), p.Ipv4("partnerAddress"), p.Ipv4List("scopeIds", 1, 500)), secret);
                break;
            }
            case "dhcp-failover-edit":
            {
                string? secret = p.Has("messageAuthentication") && p.Flag("messageAuthentication") && p.Values["secrets"] is not null ? Secret(p) : null;
                w.EditFailover(p.Text("name", 256), p.Has("loadBalancePercent") ? (byte)p.Integer("loadBalancePercent", 0, 100) : null, p.Has("reservePercent") ? (byte)p.Integer("reservePercent", 0, 100) : null,
                    p.Has("mcltSeconds") ? (uint)p.Integer("mcltSeconds", 60, 3_600_000) : null, p.Has("autoStateTransition") ? (p.Flag("autoStateTransition") ? (uint)(p.NullableInteger("stateSwitchIntervalSeconds", 60, LeaseMax) ?? 3600) : 0u) : null,
                    p.Has("messageAuthentication") ? p.Flag("messageAuthentication") : null, secret, p.Has("addScopeIds") ? p.Ipv4List("addScopeIds", 0, 500) : [], p.Has("removeScopeIds") ? p.Ipv4List("removeScopeIds", 0, 500) : [], p.Has("deleteRemovedScopes") && p.Flag("deleteRemovedScopes"));
                break;
            }
            case "dhcp-failover-remove": w.RemoveFailover(p.Text("name", 256), p.Flag("deletePartnerScopes")); break;
            case "dhcp-scope-apply": ScopeApply.Run(w, p); break;
        }
    }

    internal static PolicyData PolicyOf(ChangeInput p)
    {
        var conditions = p.Array("criteria", 0, 32).Select(item => p.Child(item, "criteria")).Select(c => (Criterion: c.Text("type", 32), Operator: c.Text("operator", 16), Values: c.Strings("values", 0, 32, 256))).ToList();
        var ranges = p.Array("ranges", 0, 32).Select(item => p.Child(item, "ranges")).Select(r => (r.Ipv4("start"), r.Ipv4("end"))).ToList();
        uint order = (uint)p.Integer("order", 0, 65535);
        return new PolicyData(p.Values["scopeId"] is null ? null : p.Ipv4("scopeId"), p.Text("name", 256), p.Text("description", 1024), p.Flag("enabled"), order, p.Text("condition", 8) == "and",
            conditions.Select(c => (c.Criterion, c.Operator, (IReadOnlyList<string>)c.Values)).ToList(), ranges, p.Values["leaseDurationSeconds"] is null ? null : p.Integer("leaseDurationSeconds", 0, uint.MaxValue), []);
    }
}

internal sealed record OptionTarget(string Family, string Level, uint? Scope, byte[]? Prefix, string? Policy);
internal sealed record PolicyData(uint? Scope, string Name, string Description, bool Enabled, uint Order, bool And, IReadOnlyList<(string Criterion, string Operator, IReadOnlyList<string> Values)> Criteria,
    IReadOnlyList<(uint Start, uint End)> Ranges, long? LeaseSeconds, IReadOnlyList<(int Code, string? Vendor, string? User, IReadOnlyList<string> Values)> Options);
internal sealed record FailoverData(string Name, string Partner, bool Primary, bool HotStandby, byte LoadBalancePercent, bool Active, byte ReservePercent, uint Mclt, uint SafePeriod, uint ServerAddress, uint PartnerAddress, IReadOnlyList<uint> Scopes);
/// <summary>A reservation as scope-apply carries it.</summary>
internal sealed record ApplyReservation(uint Address, byte[] ClientId, string Type, string Name, string Description);
/// <summary>A scope as the writer reads it back for scope-apply: its range, exclusions, options, policies and reservations.</summary>
internal sealed record ScopeModel(uint Subnet, uint Mask, string Name, string Description, bool Active, uint Start, uint End, string Type,
    List<(uint Start, uint End)> Exclusions, List<(int Code, string? Vendor, string? User)> Options, List<string> Policies, List<ApplyReservation> Reservations);

/// <summary>
/// The writes of the DHCP plugin. DhcpWriter is the local DHCP server
/// (dhcpsapi.dll); the self-test uses an in-memory model for scope-apply.
/// </summary>
internal interface IDhcpWriter
{
    DhcpService.Status Service();
    void CreateScope(uint start, uint end, uint mask, string name, string description, long? leaseSeconds, string type, bool activate);
    void EditScope(uint scope, uint start, uint end, string name, string description, long? leaseSeconds, string type);
    void ScopeState(uint scope, bool active);
    void DeleteScope(uint scope);
    bool InFailover(uint scope);
    void CreateScopeV6(byte[] prefix, string name, string description, ushort preference, bool activate);
    void EditScopeV6(byte[] prefix, string name, string description, ushort preference);
    void ScopeStateV6(byte[] prefix, bool active);
    void DeleteScopeV6(byte[] prefix);
    void SetSuperscope(string name, string? newName, IReadOnlyList<uint> scopes, bool create);
    IReadOnlyList<uint> SuperscopeMembers(string name);
    void DeleteSuperscope(string name);
    void Exclusion(uint scope, uint start, uint end, bool add);
    void ExclusionV6(byte[] prefix, byte[] start, byte[] end, bool add);
    void AddReservation(uint scope, uint address, byte[] clientId, string type, string name, string description);
    void EditReservation(uint scope, uint address, uint newAddress, byte[] clientId, string type, string name, string description);
    void RemoveReservation(uint scope, uint address);
    void AddReservationV6(byte[] prefix, byte[] address, byte[] duid, uint iaid);
    void EditReservationV6(byte[] prefix, byte[] address, byte[] newAddress, byte[] duid, uint iaid);
    void RemoveReservationV6(byte[] prefix, byte[] address);
    void DeleteLease(uint address);
    void DeleteLeaseV6(byte[] address);
    (int Type, bool MultiValued) OptionType(string family, int code, string? vendor);
    void SetOption(OptionTarget target, int code, string? vendor, string? user, IReadOnlyList<OptionElement> values);
    void RemoveOption(OptionTarget target, int code, string? vendor, string? user);
    void SetPolicy(PolicyData policy, bool create, string? newName);
    void DeletePolicy(uint? scope, string name);
    void CreateFailover(FailoverData relationship, string? secret);
    void EditFailover(string name, byte? loadBalancePercent, byte? reservePercent, uint? mclt, uint? safePeriod, bool? authentication, string? secret, IReadOnlyList<uint> add, IReadOnlyList<uint> remove, bool deleteRemoved);
    void RemoveFailover(string name, bool deleteScopes);
    ScopeModel? ReadScope(uint scope);
}

/// <summary>
/// dhcp-scope-apply: part 1 creates the scope when it is missing and
/// replaces its settings, exclusions, scope options and scope policies; every
/// part upserts its reservations; the last part removes the reservations that
/// are not in `keep`.
/// </summary>
internal static class ScopeApply
{
    internal static void Validate(ChangeInput p)
    {
        p.Only("scopeId", "part", "parts", "settings", "reservations", "keep");
        p.Ipv4("scopeId"); long part = p.Integer("part", 1, 20), parts = p.Integer("parts", 1, 20); if (part > parts) throw new InvalidChangeException("part");
        if (p.Has("settings"))
        {
            var s = p.Child(p.Values["settings"], "settings");
            s.Only("name", "description", "startRange", "endRange", "subnetMask", "leaseDurationSeconds", "type", "state", "exclusions", "options", "policies");
            s.Text("name", 256); s.Text("description", 1024); if (s.Ipv4("endRange") < s.Ipv4("startRange")) throw new InvalidChangeException("settings"); if (DhcpChanges.MaskBits(s.Ipv4("subnetMask")) < 0) throw new InvalidChangeException("settings");
            s.NullableInteger("leaseDurationSeconds", 0, uint.MaxValue); s.Choice("type", "dhcp", "bootp", "both"); s.Choice("state", "active", "inactive");
            foreach (var item in s.Array("exclusions", 0, 100)) { var r = s.Child(item, "exclusions"); r.Only("start", "end"); r.Ipv4("start"); r.Ipv4("end"); }
            foreach (var item in s.Array("options", 0, 256)) Option(s.Child(item, "options"));
            foreach (var item in s.Array("policies", 0, 200))
            {
                var policy = s.Child(item, "policies");
                policy.Only("name", "order", "enabled", "condition", "criteria", "ranges", "leaseDurationSeconds", "description", "options");
                policy.Text("name", 256, required: true); policy.Integer("order", 0, 65535); policy.Flag("enabled"); policy.Choice("condition", "and", "or"); policy.Text("description", 1024); policy.NullableInteger("leaseDurationSeconds", 0, uint.MaxValue);
                foreach (var criterion in policy.Array("criteria", 0, 32)) { var c = policy.Child(criterion, "criteria"); c.Only("type", "operator", "values"); c.Text("type", 32); c.Choice("operator", "equals", "notEquals"); c.Strings("values", 0, 32, 256); }
                foreach (var range in policy.Array("ranges", 0, 32)) { var r = policy.Child(range, "ranges"); r.Only("start", "end"); r.Ipv4("start"); r.Ipv4("end"); }
                foreach (var option in policy.Array("options", 0, 256)) Option(policy.Child(option, "options"));
            }
        }
        foreach (var item in p.Array("reservations", 0, 2000)) Reservation(p.Child(item, "reservations"));
        if (p.Has("keep")) p.Ipv4List("keep", 0, 2000);
    }
    private static void Option(ChangeInput o) { o.Only("code", "name", "vendorClass", "userClass", "values"); o.Integer("code", 0, 65535); if (o.Has("name")) o.Text("name", 128); o.NullableText("vendorClass", 128); o.NullableText("userClass", 128); o.Strings("values", 0, 32, 512); }
    private static ApplyReservation Reservation(ChangeInput r)
    {
        r.Only("address", "clientId", "name", "description", "type");
        return new ApplyReservation(r.Ipv4("address"), DhcpChanges.HexBytes(r.Text("clientId", 256), 85) ?? throw new InvalidChangeException("reservations"), r.Choice("type", "dhcp", "bootp", "both"), r.Text("name", 256), r.Text("description", 1024));
    }

    internal static void Run(IDhcpWriter w, ChangeInput p)
    {
        uint scope = p.Ipv4("scopeId");
        if (p.Has("settings"))
        {
            var s = p.Child(p.Values["settings"], "settings");
            uint start = s.Ipv4("startRange"), end = s.Ipv4("endRange"), mask = s.Ipv4("subnetMask"); long? lease = s.NullableInteger("leaseDurationSeconds", 0, uint.MaxValue);
            string name = s.Text("name", 256), description = s.Text("description", 1024), type = s.Text("type", 8); bool active = s.Text("state", 8) == "active";
            var current = w.ReadScope(scope);
            if (current is null) w.CreateScope(start, end, mask, name, description, lease, type, active);
            else { w.EditScope(scope, start, end, name, description, lease, type); if (current.Active != active) w.ScopeState(scope, active); }
            current = w.ReadScope(scope) ?? throw new ChangeRefusedException("PLUGIN_DHCP_OBJECT_MISSING", ("object", DhcpSnapshot.Ipv4(scope)));
            // Exclusions: the list of the source replaces the partner's.
            var exclusions = s.Array("exclusions", 0, 100).Select(item => s.Child(item, "exclusions")).Select(r => (r.Ipv4("start"), r.Ipv4("end"))).ToList();
            foreach (var old in current.Exclusions.Where(old => !exclusions.Contains(old)).ToList()) w.Exclusion(scope, old.Start, old.End, add: false);
            foreach (var item in exclusions.Where(item => !current.Exclusions.Contains(item)).ToList()) w.Exclusion(scope, item.Item1, item.Item2, add: true);
            // Scope options: set every option of the source, remove the others (option 51, the lease, belongs to the settings).
            var options = s.Array("options", 0, 256).Select(item => s.Child(item, "options")).Select(o => (Code: (int)o.Integer("code", 0, 65535), Vendor: o.NullableText("vendorClass", 128), User: o.NullableText("userClass", 128), Values: o.Strings("values", 0, 32, 512))).Where(o => o.Code != 51).ToList();
            var target = new OptionTarget("ipv4", "scope", scope, null, null);
            foreach (var old in current.Options.Where(old => old.Code != 51 && !options.Any(o => o.Code == old.Code && o.Vendor == old.Vendor && o.User == old.User)).ToList()) w.RemoveOption(target, old.Code, old.Vendor, old.User);
            foreach (var option in options.Where(o => o.Values.Count > 0)) { var (kind, multi) = w.OptionType("ipv4", option.Code, option.Vendor); w.SetOption(target, option.Code, option.Vendor, option.User, DhcpChanges.OptionValues(kind, multi, option.Values)); }
            // Scope policies: replace by name, with their options.
            var policies = s.Array("policies", 0, 200).Select(item => s.Child(item, "policies")).ToList();
            var names = policies.Select(policy => policy.Text("name", 256)).ToList();
            foreach (var old in current.Policies.Where(old => !names.Contains(old, StringComparer.Ordinal)).ToList()) w.DeletePolicy(scope, old);
            foreach (var policy in policies)
            {
                var data = new PolicyData(scope, policy.Text("name", 256), policy.Text("description", 1024), policy.Flag("enabled"), (uint)policy.Integer("order", 0, 65535), policy.Text("condition", 8) == "and",
                    policy.Array("criteria", 0, 32).Select(item => policy.Child(item, "criteria")).Select(c => (c.Text("type", 32), c.Text("operator", 16), (IReadOnlyList<string>)c.Strings("values", 0, 32, 256))).Where(c => c.Item3.Count > 0).ToList(),
                    policy.Array("ranges", 0, 32).Select(item => policy.Child(item, "ranges")).Select(r => (r.Ipv4("start"), r.Ipv4("end"))).ToList(), policy.NullableInteger("leaseDurationSeconds", 0, uint.MaxValue),
                    policy.Array("options", 0, 256).Select(item => policy.Child(item, "options")).Select(o => ((int)o.Integer("code", 0, 65535), o.NullableText("vendorClass", 128), o.NullableText("userClass", 128), (IReadOnlyList<string>)o.Strings("values", 0, 32, 512))).ToList());
                w.SetPolicy(data, !current.Policies.Contains(data.Name, StringComparer.Ordinal), null);
            }
        }
        // Reservations: upsert this part's chunk.
        var existing = (w.ReadScope(scope) ?? throw new ChangeRefusedException("PLUGIN_DHCP_OBJECT_MISSING", ("object", DhcpSnapshot.Ipv4(scope)))).Reservations.ToList();
        foreach (var item in p.Array("reservations", 0, 2000).Select(item => Reservation(p.Child(item, "reservations"))))
        {
            var old = existing.FirstOrDefault(r => r.Address == item.Address);
            if (old is null)
            {
                // A reservation of the same client under another address goes first.
                var moved = existing.FirstOrDefault(r => r.ClientId.SequenceEqual(item.ClientId));
                if (moved is not null) w.RemoveReservation(scope, moved.Address);
                w.AddReservation(scope, item.Address, item.ClientId, item.Type, item.Name, item.Description);
            }
            else if (!old.ClientId.SequenceEqual(item.ClientId) || old.Type != item.Type || old.Name != item.Name || old.Description != item.Description) w.EditReservation(scope, item.Address, item.Address, item.ClientId, item.Type, item.Name, item.Description);
        }
        // The last part: remove every reservation the source does not have.
        if (p.Has("keep"))
        {
            var keep = p.Ipv4List("keep", 0, 2000).ToHashSet();
            foreach (var old in (w.ReadScope(scope)?.Reservations ?? []).Where(r => !keep.Contains(r.Address)).ToList()) w.RemoveReservation(scope, old.Address);
        }
    }
}

/// <summary>
/// The writes against the local DHCP server (dhcpsapi.dll). Every call passes
/// null as the server. Input structs live in unmanaged memory owned by a
/// Native scope and are freed with it. Memory the API returns is not freed:
/// the plugin process serves one request and ends (agent/v3/PluginHost.cs),
/// and freeing it corrupted the heap (0xC0000374) on a server with scopes.
/// The struct layouts are x64 (DhcpSelfTests checks them).
/// </summary>
internal sealed unsafe class DhcpWriter : IDhcpWriter
{
    private const string Library = "dhcpsapi.dll";
    private const int FullForce = 0, ReservedIps = 2, ExcludedRanges = 3, Ipv6Reserved = 1, Ipv6Excluded = 2;
    private const uint VendorFlag = 0x03, GlobalOptions = 1, SubnetOptions = 2, GlobalOptions6 = 3, ScopeOptions6 = 1;
    private const uint FailoverMclt = 0x01, FailoverSafePeriod = 0x02, FailoverSecret = 0x04, FailoverPercentage = 0x08;
    private const uint PolicyName = 0x01, PolicyOrder = 0x02, PolicyExpression = 0x04, PolicyDescription = 0x10, PolicyStatus = 0x20;

    [StructLayout(LayoutKind.Sequential)] internal struct ClientInfoV4 { public uint ClientIpAddress, SubnetMask; public DhcpApi.BinaryData ClientHardwareAddress; public char* ClientName, ClientComment; public DhcpApi.DateTime32 ClientLeaseExpires; public DhcpApi.HostInfo OwnerHost; public byte ClientType; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] internal struct SearchInfo { [FieldOffset(0)] public int SearchType; [FieldOffset(8)] public uint ClientIpAddress; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] internal struct SearchInfoV6 { [FieldOffset(0)] public int SearchType; [FieldOffset(8)] public DhcpApi.Ipv6Address ClientIpAddress; }
    [StructLayout(LayoutKind.Sequential)] internal struct AllOptionValuesPolicy { public char* PolicyName, VendorName; public int IsVendor; public DhcpApi.OptionValueArray* OptionsArray; }
    [StructLayout(LayoutKind.Sequential)] internal struct AllOptionValuesPb { public uint Flags, NumElements; public AllOptionValuesPolicy* Options; }

    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpCreateSubnet(string? server, uint subnet, ref DhcpApi.SubnetInfo info);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpSetSubnetInfo(string? server, uint subnet, ref DhcpApi.SubnetInfo info);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpGetSubnetInfo(string? server, uint subnet, out DhcpApi.SubnetInfo* info);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpDeleteSubnet(string? server, uint subnet, int force);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpAddSubnetElementV5(string? server, uint subnet, ref DhcpApi.ElementV5 element);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpRemoveSubnetElementV5(string? server, uint subnet, ref DhcpApi.ElementV5 element, int force);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpCreateSubnetV6(string? server, DhcpApi.Ipv6Address subnet, ref DhcpApi.SubnetInfoV6 info);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpSetSubnetInfoV6(string? server, DhcpApi.Ipv6Address subnet, ref DhcpApi.SubnetInfoV6 info);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpGetSubnetInfoV6(string? server, DhcpApi.Ipv6Address subnet, out DhcpApi.SubnetInfoV6* info);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpDeleteSubnetV6(string? server, DhcpApi.Ipv6Address subnet, int force);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpAddSubnetElementV6(string? server, DhcpApi.Ipv6Address subnet, ref DhcpApi.ElementV6 element);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpRemoveSubnetElementV6(string? server, DhcpApi.Ipv6Address subnet, ref DhcpApi.ElementV6 element, int force);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpSetSuperScopeV4(string? server, uint subnet, string? name, int changeExisting);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpDeleteSuperScopeV4(string? server, string name);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpGetClientInfoV4(string? server, ref SearchInfo search, out ClientInfoV4* info);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpSetClientInfoV4(string? server, ref ClientInfoV4 info);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpDeleteClientInfo(string? server, ref SearchInfo search);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpDeleteClientInfoV6(string? server, ref SearchInfoV6 search);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpGetOptionInfoV5(string? server, uint flags, uint optionId, string? className, string? vendorName, out DhcpApi.Option* info);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpGetOptionInfoV6(string? server, uint flags, uint optionId, string? className, string? vendorName, out DhcpApi.Option* info);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpSetOptionValueV5(string? server, uint flags, uint optionId, string? className, string? vendorName, ref DhcpApi.OptionScopeInfo scope, ref DhcpApi.OptionData value);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpRemoveOptionValueV5(string? server, uint flags, uint optionId, string? className, string? vendorName, ref DhcpApi.OptionScopeInfo scope);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpSetOptionValueV6(string? server, uint flags, uint optionId, string? className, string? vendorName, ref DhcpApi.OptionScopeInfo6 scope, ref DhcpApi.OptionData value);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpRemoveOptionValueV6(string? server, uint flags, uint optionId, string? className, string? vendorName, ref DhcpApi.OptionScopeInfo6 scope);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4SetOptionValue(string? server, uint flags, uint optionId, string? policyName, string? vendorName, ref DhcpApi.OptionScopeInfo scope, ref DhcpApi.OptionData value);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4RemoveOptionValue(string? server, uint flags, uint optionId, string? policyName, string? vendorName, ref DhcpApi.OptionScopeInfo scope);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4GetAllOptionValues(string? server, uint flags, ref DhcpApi.OptionScopeInfo scope, out AllOptionValuesPb* values);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4CreatePolicy(string? server, ref DhcpApi.Policy policy);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4SetPolicy(string? server, uint fields, int global, uint subnet, string? name, ref DhcpApi.Policy policy);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4GetPolicy(string? server, int global, uint subnet, string name, out DhcpApi.Policy* policy);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4DeletePolicy(string? server, int global, uint subnet, string name);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4AddPolicyRange(string? server, uint subnet, string name, ref DhcpApi.IpRange range);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4RemovePolicyRange(string? server, uint subnet, string name, ref DhcpApi.IpRange range);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4FailoverCreateRelationship(string? server, ref DhcpApi.FailoverRelationship relationship);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4FailoverSetRelationship(string? server, uint flags, ref DhcpApi.FailoverRelationship relationship);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4FailoverDeleteRelationship(string? server, string name);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4FailoverGetRelationship(string? server, string name, out DhcpApi.FailoverRelationship* relationship);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4FailoverGetScopeRelationship(string? server, uint scope, out DhcpApi.FailoverRelationship* relationship);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4FailoverAddScopeToRelationship(string? server, ref DhcpApi.FailoverRelationship relationship);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4FailoverDeleteScopeFromRelationship(string? server, ref DhcpApi.FailoverRelationship relationship);

    /// <summary>A failed call: DhcpApiException with the object it named.</summary>
    private static void Ok(string call, uint code, string target) { if (code != DhcpApi.Success) throw new DhcpApiException(call, code, target); }
    private static string Ip(uint address) => DhcpSnapshot.Ipv4(address);
    private static string Ip(byte[] address) => DhcpSnapshot.Ipv6(address);
    internal static DhcpApi.Ipv6Address V6(byte[] bytes) { ulong high = 0, low = 0; for (int i = 0; i < 8; i++) { high = high << 8 | bytes[i]; low = low << 8 | bytes[8 + i]; } return new DhcpApi.Ipv6Address { HighOrderBits = high, LowOrderBits = low }; }
    private static byte ClientType(string type) => type switch { "bootp" => 2, "both" => 3, _ => 1 };
    private static int RangeType(string type) => type switch { "bootp" => 7, "both" => 6, _ => 5 };

    /// <summary>Unmanaged input memory of one call, freed together.</summary>
    private sealed class Native : IDisposable
    {
        // Every block with its size: Dispose zeroes it before the free, so no input (a shared secret) stays in freed memory.
        private readonly List<(IntPtr Block, int Bytes)> blocks = [];
        internal char* Text(string? value) { if (value is null) return null; var block = Marshal.StringToHGlobalUni(value); blocks.Add((block, (value.Length + 1) * sizeof(char))); return (char*)block; }
        internal T* Items<T>(IReadOnlyList<T> values) where T : unmanaged
        {
            int bytes = Math.Max(1, values.Count) * sizeof(T); var block = Marshal.AllocHGlobal(bytes); blocks.Add((block, bytes));
            var items = (T*)block; for (int i = 0; i < values.Count; i++) items[i] = values[i];
            return items;
        }
        internal T* One<T>(T value) where T : unmanaged => Items([value]);
        internal byte* Bytes(byte[] value) => Items(value);
        internal DhcpApi.BinaryData* Binary(byte[] value) => One(new DhcpApi.BinaryData { DataLength = (uint)value.Length, Data = Bytes(value) });
        internal DhcpApi.IpArray* Ips(IReadOnlyList<uint> values) => One(new DhcpApi.IpArray { NumElements = (uint)values.Count, Elements = Items(values) });
        public void Dispose() { foreach (var (block, bytes) in blocks) { new Span<byte>((void*)block, bytes).Clear(); Marshal.FreeHGlobal(block); } blocks.Clear(); }
    }

    public DhcpService.Status Service() => DhcpService.State() is var state && state != DhcpService.Status.Missing && NativeLibrary.TryLoad(Library, out var library) ? Loaded(library, state) : DhcpService.Status.Missing;
    private static DhcpService.Status Loaded(IntPtr library, DhcpService.Status state) { NativeLibrary.Free(library); return state; }

    // ---- IPv4 scopes -------------------------------------------------------------------------------
    private static T WithSubnet<T>(uint scope, Func<DhcpApi.SubnetInfo, T> use)
    {
        Ok("DhcpGetSubnetInfo", DhcpGetSubnetInfo(null, scope, out var info), Ip(scope));
        return use(*info);
    }
    private static void SetSubnet(uint scope, string? name, string? description, int? state)
    {
        WithSubnet(scope, info =>
        {
            using var native = new Native();
            var next = info; if (name is not null) next.SubnetName = native.Text(name); if (description is not null) next.SubnetComment = native.Text(description); if (state is int value) next.SubnetState = value;
            Ok("DhcpSetSubnetInfo", DhcpSetSubnetInfo(null, scope, ref next), Ip(scope)); return 0;
        });
    }
    private static void Range(uint scope, uint start, uint end, string type, bool add)
    {
        using var native = new Native();
        var element = new DhcpApi.ElementV5 { ElementType = RangeType(type), Element = native.One(new DhcpApi.BootpIpRange { StartAddress = start, EndAddress = end, BootpAllocated = 0, MaxBootpAllowed = type == "dhcp" ? 0 : 0xFFFFFFFF }) };
        if (add) Ok("DhcpAddSubnetElementV5", DhcpAddSubnetElementV5(null, scope, ref element), Ip(start) + " – " + Ip(end));
        else Ok("DhcpRemoveSubnetElementV5", DhcpRemoveSubnetElementV5(null, scope, ref element, FullForce), Ip(start) + " – " + Ip(end));
    }
    private static void Lease(uint scope, long? seconds)
    {
        using var native = new Native();
        var scopeInfo = new DhcpApi.OptionScopeInfo { ScopeType = (int)SubnetOptions, Subnet = scope };
        var data = new DhcpApi.OptionData { NumElements = 1, Elements = native.One(new DhcpApi.OptionDataElement { OptionType = 2, DWord = seconds is long value ? (uint)value : (uint)DhcpChanges.Unlimited }) };
        Ok("DhcpSetOptionValueV5", DhcpSetOptionValueV5(null, 0, 51, null, null, ref scopeInfo, ref data), Ip(scope));
    }
    public void CreateScope(uint start, uint end, uint mask, string name, string description, long? leaseSeconds, string type, bool activate)
    {
        uint subnet = start & mask;
        using (var native = new Native())
        {
            var info = new DhcpApi.SubnetInfo { SubnetAddress = subnet, SubnetMask = mask, SubnetName = native.Text(name), SubnetComment = native.Text(description), SubnetState = 1 };
            Ok("DhcpCreateSubnet", DhcpCreateSubnet(null, subnet, ref info), Ip(subnet));
        }
        // The range, the lease and the state; a failure deletes the new subnet again.
        try { Range(subnet, start, end, type, add: true); Lease(subnet, leaseSeconds); if (activate) SetSubnet(subnet, null, null, 0); }
        catch { DhcpDeleteSubnet(null, subnet, FullForce); throw; }
    }
    private static DhcpApi.ElementV5Data? CurrentRange(uint scope) => DhcpApi.Elements(scope, 0).FirstOrDefault();
    public void EditScope(uint scope, uint start, uint end, string name, string description, long? leaseSeconds, string type)
    {
        SetSubnet(scope, name, description, null);
        var old = CurrentRange(scope);
        string oldType = old is null ? "dhcp" : DhcpSnapshot.ScopeType(old.Type);
        if (old is null || old.Start != start || old.End != end || oldType != type)
        {
            if (old is not null) Range(scope, old.Start, old.End, oldType, add: false);
            try { Range(scope, start, end, type, add: true); }
            catch { if (old is not null) try { Range(scope, old.Start, old.End, oldType, add: true); } catch (DhcpApiException) { } throw; }
        }
        Lease(scope, leaseSeconds);
    }
    public void ScopeState(uint scope, bool active) => WithSubnet(scope, info => { bool switched = info.SubnetState is 2 or 3; SetSubnet(scope, null, null, active ? (switched ? 2 : 0) : (switched ? 3 : 1)); return 0; });
    public void DeleteScope(uint scope) => Ok("DhcpDeleteSubnet", DhcpDeleteSubnet(null, scope, FullForce), Ip(scope));
    public bool InFailover(uint scope) => DhcpV4FailoverGetScopeRelationship(null, scope, out var relation) == DhcpApi.Success && relation != null;

    // ---- IPv6 scopes ---------------------------------------------------------------------------------
    private static void SetSubnetV6(byte[] prefix, string? name, string? description, ushort? preference, uint? state)
    {
        var subnet = V6(prefix);
        Ok("DhcpGetSubnetInfoV6", DhcpGetSubnetInfoV6(null, subnet, out var info), Ip(prefix));
        using var native = new Native(); var next = *info;
        if (name is not null) next.SubnetName = native.Text(name); if (description is not null) next.SubnetComment = native.Text(description); if (preference is ushort value) next.Preference = value; if (state is uint s) next.State = s;
        Ok("DhcpSetSubnetInfoV6", DhcpSetSubnetInfoV6(null, subnet, ref next), Ip(prefix));
    }
    public void CreateScopeV6(byte[] prefix, string name, string description, ushort preference, bool activate)
    {
        using var native = new Native();
        var info = new DhcpApi.SubnetInfoV6 { SubnetAddress = V6(prefix), Prefix = 64, Preference = preference, SubnetName = native.Text(name), SubnetComment = native.Text(description), State = activate ? 0u : 1u };
        Ok("DhcpCreateSubnetV6", DhcpCreateSubnetV6(null, V6(prefix), ref info), Ip(prefix));
    }
    public void EditScopeV6(byte[] prefix, string name, string description, ushort preference) => SetSubnetV6(prefix, name, description, preference, null);
    public void ScopeStateV6(byte[] prefix, bool active) => SetSubnetV6(prefix, null, null, null, active ? 0u : 1u);
    public void DeleteScopeV6(byte[] prefix) => Ok("DhcpDeleteSubnetV6", DhcpDeleteSubnetV6(null, V6(prefix), FullForce), Ip(prefix));

    // ---- Superscopes -----------------------------------------------------------------------------------
    public IReadOnlyList<uint> SuperscopeMembers(string name)
    {
        var members = DhcpApi.Superscopes().Where(item => item.Name == name).Select(item => item.Subnet).ToList();
        return members.Count > 0 ? members : throw new ChangeRefusedException("PLUGIN_DHCP_OBJECT_MISSING", ("object", name));
    }
    public void SetSuperscope(string name, string? newName, IReadOnlyList<uint> scopes, bool create)
    {
        var current = DhcpApi.Superscopes();
        if (create && current.Any(item => item.Name == name)) throw new ChangeRefusedException("PLUGIN_DHCP_OBJECT_EXISTS", ("object", name));
        if (!create && !current.Any(item => item.Name == name)) throw new ChangeRefusedException("PLUGIN_DHCP_OBJECT_MISSING", ("object", name));
        string target = newName ?? name;
        var done = new List<(uint Subnet, string? Before)>();
        try
        {
            foreach (uint scope in scopes)
            {
                string? before = current.FirstOrDefault(item => item.Subnet == scope).Name;
                Ok("DhcpSetSuperScopeV4", DhcpSetSuperScopeV4(null, scope, target, 1), Ip(scope)); done.Add((scope, before));
            }
            // An edit takes the scopes that left the superscope out of it.
            if (!create) foreach (var (subnet, _) in current.Where(item => item.Name == name && !scopes.Contains(item.Subnet)).ToList()) { Ok("DhcpSetSuperScopeV4", DhcpSetSuperScopeV4(null, subnet, null, 1), Ip(subnet)); done.Add((subnet, name)); }
        }
        catch
        {
            foreach (var (subnet, before) in done) DhcpSetSuperScopeV4(null, subnet, before, 1);
            throw;
        }
    }
    public void DeleteSuperscope(string name) => Ok("DhcpDeleteSuperScopeV4", DhcpDeleteSuperScopeV4(null, name), name);

    // ---- Exclusions and reservations ----------------------------------------------------------------------
    public void Exclusion(uint scope, uint start, uint end, bool add)
    {
        using var native = new Native();
        var element = new DhcpApi.ElementV5 { ElementType = ExcludedRanges, Element = native.One(new DhcpApi.IpRange { StartAddress = start, EndAddress = end }) };
        string label = Ip(start) + " – " + Ip(end);
        if (add) Ok("DhcpAddSubnetElementV5", DhcpAddSubnetElementV5(null, scope, ref element), label);
        else Ok("DhcpRemoveSubnetElementV5", DhcpRemoveSubnetElementV5(null, scope, ref element, FullForce), label);
    }
    public void ExclusionV6(byte[] prefix, byte[] start, byte[] end, bool add)
    {
        using var native = new Native();
        var element = new DhcpApi.ElementV6 { ElementType = Ipv6Excluded, Element = native.One(new DhcpApi.IpRangeV6 { StartAddress = V6(start), EndAddress = V6(end) }) };
        string label = Ip(start) + " – " + Ip(end);
        if (add) Ok("DhcpAddSubnetElementV6", DhcpAddSubnetElementV6(null, V6(prefix), ref element), label);
        else Ok("DhcpRemoveSubnetElementV6", DhcpRemoveSubnetElementV6(null, V6(prefix), ref element, FullForce), label);
    }
    private static DhcpApi.ElementV5Data? Reservation(uint scope, uint address) => DhcpApi.Elements(scope, ReservedIps).FirstOrDefault(item => item.Start == address);
    private static void Reserve(uint scope, uint address, byte[] clientId, byte types, bool add)
    {
        using var native = new Native();
        var element = new DhcpApi.ElementV5 { ElementType = ReservedIps, Element = native.One(new DhcpApi.ReservationV4 { ReservedIpAddress = address, ReservedForClient = native.Binary(clientId), AllowedClientTypes = types }) };
        if (add) Ok("DhcpAddSubnetElementV5", DhcpAddSubnetElementV5(null, scope, ref element), Ip(address));
        else Ok("DhcpRemoveSubnetElementV5", DhcpRemoveSubnetElementV5(null, scope, ref element, FullForce), Ip(address));
    }
    /// <summary>The name and description of a reservation: its client record, read, changed and written back.</summary>
    private static void ClientText(uint address, string name, string description)
    {
        var search = new SearchInfo { SearchType = 0, ClientIpAddress = address };
        Ok("DhcpGetClientInfoV4", DhcpGetClientInfoV4(null, ref search, out var info), Ip(address));
        using var native = new Native(); var next = *info; next.ClientName = native.Text(name); next.ClientComment = native.Text(description);
        Ok("DhcpSetClientInfoV4", DhcpSetClientInfoV4(null, ref next), Ip(address));
    }
    private static (string Name, string Description) ReadClientText(uint address)
    {
        var search = new SearchInfo { SearchType = 0, ClientIpAddress = address };
        return DhcpGetClientInfoV4(null, ref search, out var info) == DhcpApi.Success && info != null ? (info->ClientName == null ? "" : new string(info->ClientName), info->ClientComment == null ? "" : new string(info->ClientComment)) : ("", "");
    }
    public void AddReservation(uint scope, uint address, byte[] clientId, string type, string name, string description)
    {
        Reserve(scope, address, clientId, ClientType(type), add: true);
        try { ClientText(address, name, description); }
        catch { try { Reserve(scope, address, clientId, ClientType(type), add: false); } catch (DhcpApiException) { } throw; }
    }
    public void EditReservation(uint scope, uint address, uint newAddress, byte[] clientId, string type, string name, string description)
    {
        var old = Reservation(scope, address) ?? throw new ChangeRefusedException("PLUGIN_DHCP_OBJECT_MISSING", ("object", Ip(address)));
        byte[] oldClient = ClientId(old.ClientId ?? [], scope);
        if (newAddress == address && oldClient.SequenceEqual(clientId) && (old.Types & 3) == ClientType(type)) { ClientText(address, name, description); return; }
        // A new address, client ID or type: remove and add in the same call; a failed add restores the old reservation.
        var (oldName, oldDescription) = ReadClientText(address);
        Reserve(scope, address, old.ClientId ?? [], old.Types, add: false);
        try { AddReservation(scope, newAddress, clientId, type, name, description); }
        catch { try { Reserve(scope, address, old.ClientId ?? [], old.Types, add: true); ClientText(address, oldName, oldDescription); } catch (DhcpApiException) { } throw; }
    }
    /// <summary>The client ID without the subnet and hardware type prefix some records carry (DhcpSnapshot.ClientId).</summary>
    private static byte[] ClientId(byte[] uid, uint subnet) => Convert.FromHexString(DhcpSnapshot.ClientId(uid, subnet).Replace("-", "", StringComparison.Ordinal));
    public void RemoveReservation(uint scope, uint address)
    {
        var old = Reservation(scope, address) ?? throw new ChangeRefusedException("PLUGIN_DHCP_OBJECT_MISSING", ("object", Ip(address)));
        Reserve(scope, address, old.ClientId ?? [], old.Types, add: false);
    }
    private static void ReserveV6(byte[] prefix, byte[] address, byte[] duid, uint iaid, bool add)
    {
        using var native = new Native();
        var element = new DhcpApi.ElementV6 { ElementType = Ipv6Reserved, Element = native.One(new DhcpApi.ReservationV6 { ReservedIpAddress = V6(address), ReservedForClient = native.Binary(duid), InterfaceId = iaid }) };
        if (add) Ok("DhcpAddSubnetElementV6", DhcpAddSubnetElementV6(null, V6(prefix), ref element), Ip(address));
        else Ok("DhcpRemoveSubnetElementV6", DhcpRemoveSubnetElementV6(null, V6(prefix), ref element, FullForce), Ip(address));
    }
    public void AddReservationV6(byte[] prefix, byte[] address, byte[] duid, uint iaid) => ReserveV6(prefix, address, duid, iaid, add: true);
    public void EditReservationV6(byte[] prefix, byte[] address, byte[] newAddress, byte[] duid, uint iaid)
    {
        var old = DhcpApi.ReservationsV6(V6(prefix)).FirstOrDefault(item => item.Address.SequenceEqual(address)) ?? throw new ChangeRefusedException("PLUGIN_DHCP_OBJECT_MISSING", ("object", Ip(address)));
        ReserveV6(prefix, address, old.Duid, old.Iaid, add: false);
        try { ReserveV6(prefix, newAddress, duid, iaid, add: true); }
        catch { try { ReserveV6(prefix, address, old.Duid, old.Iaid, add: true); } catch (DhcpApiException) { } throw; }
    }
    public void RemoveReservationV6(byte[] prefix, byte[] address)
    {
        var old = DhcpApi.ReservationsV6(V6(prefix)).FirstOrDefault(item => item.Address.SequenceEqual(address)) ?? throw new ChangeRefusedException("PLUGIN_DHCP_OBJECT_MISSING", ("object", Ip(address)));
        ReserveV6(prefix, address, old.Duid, old.Iaid, add: false);
    }

    // ---- Leases --------------------------------------------------------------------------------------------
    public void DeleteLease(uint address) { var search = new SearchInfo { SearchType = 0, ClientIpAddress = address }; Ok("DhcpDeleteClientInfo", DhcpDeleteClientInfo(null, ref search), Ip(address)); }
    public void DeleteLeaseV6(byte[] address) { var search = new SearchInfoV6 { SearchType = 0, ClientIpAddress = V6(address) }; Ok("DhcpDeleteClientInfoV6", DhcpDeleteClientInfoV6(null, ref search), Ip(address)); }

    // ---- Options ---------------------------------------------------------------------------------------------
    public (int Type, bool MultiValued) OptionType(string family, int code, string? vendor)
    {
        DhcpApi.Option* info = null;
        uint result = family == "ipv6" ? DhcpGetOptionInfoV6(null, vendor is null ? 0 : VendorFlag, (uint)code, null, vendor, out info) : DhcpGetOptionInfoV5(null, vendor is null ? 0 : VendorFlag, (uint)code, null, vendor, out info);
        if (result != DhcpApi.Success || info == null) throw new ChangeRefusedException("PLUGIN_DHCP_OBJECT_MISSING", ("object", "Option " + code.ToString(CultureInfo.InvariantCulture)));
        int type = info->DefaultValue.NumElements > 0 && info->DefaultValue.Elements != null ? info->DefaultValue.Elements[0].OptionType : 5;
        return (type, info->OptionType == 1);
    }
    private static DhcpApi.OptionData Data(Native native, IReadOnlyList<OptionElement> values) => new()
    {
        NumElements = (uint)values.Count,
        Elements = native.Items(values.Select(value => value.Type switch
        {
            3 => new DhcpApi.OptionDataElement { OptionType = 3, DWord = (uint)(value.Number >> 32), DWord2 = (uint)value.Number },
            5 or 8 => new DhcpApi.OptionDataElement { OptionType = value.Type, Text = native.Text(value.Text) },
            6 or 7 => new DhcpApi.OptionDataElement { OptionType = value.Type, BinaryLength = (uint)value.Bytes!.Length, BinaryData = native.Bytes(value.Bytes) },
            _ => new DhcpApi.OptionDataElement { OptionType = value.Type, DWord = (uint)value.Number },
        }).ToList()),
    };
    public void SetOption(OptionTarget target, int code, string? vendor, string? user, IReadOnlyList<OptionElement> values)
    {
        using var native = new Native(); var data = Data(native, values); uint flags = vendor is null ? 0 : VendorFlag; string label = "Option " + code.ToString(CultureInfo.InvariantCulture);
        if (target.Family == "ipv6")
        {
            var scope = new DhcpApi.OptionScopeInfo6 { ScopeType = (int)(target.Level == "server" ? GlobalOptions6 : ScopeOptions6), Subnet = target.Level == "server" ? default : V6(target.Prefix!) };
            Ok("DhcpSetOptionValueV6", DhcpSetOptionValueV6(null, flags, (uint)code, user, vendor, ref scope, ref data), label);
            return;
        }
        var info = new DhcpApi.OptionScopeInfo { ScopeType = (int)(target.Scope is null ? GlobalOptions : SubnetOptions), Subnet = target.Scope ?? 0 };
        if (target.Level == "policy") Ok("DhcpV4SetOptionValue", DhcpV4SetOptionValue(null, flags, (uint)code, target.Policy, vendor, ref info, ref data), label);
        else Ok("DhcpSetOptionValueV5", DhcpSetOptionValueV5(null, flags, (uint)code, user, vendor, ref info, ref data), label);
    }
    public void RemoveOption(OptionTarget target, int code, string? vendor, string? user)
    {
        uint flags = vendor is null ? 0 : VendorFlag; string label = "Option " + code.ToString(CultureInfo.InvariantCulture);
        if (target.Family == "ipv6")
        {
            var scope = new DhcpApi.OptionScopeInfo6 { ScopeType = (int)(target.Level == "server" ? GlobalOptions6 : ScopeOptions6), Subnet = target.Level == "server" ? default : V6(target.Prefix!) };
            Ok("DhcpRemoveOptionValueV6", DhcpRemoveOptionValueV6(null, flags, (uint)code, user, vendor, ref scope), label);
            return;
        }
        var info = new DhcpApi.OptionScopeInfo { ScopeType = (int)(target.Scope is null ? GlobalOptions : SubnetOptions), Subnet = target.Scope ?? 0 };
        if (target.Level == "policy") Ok("DhcpV4RemoveOptionValue", DhcpV4RemoveOptionValue(null, flags, (uint)code, target.Policy, vendor, ref info), label);
        else Ok("DhcpRemoveOptionValueV5", DhcpRemoveOptionValueV5(null, flags, (uint)code, user, vendor, ref info), label);
    }
    /// <summary>The option values of every policy at the server (scope null) or one scope: DhcpV4GetAllOptionValues, the policy entries only.</summary>
    internal static Dictionary<string, List<RawOption>> PolicyOptions(uint? scope, Dictionary<uint, string> names)
    {
        var result = new Dictionary<string, List<RawOption>>(StringComparer.Ordinal);
        var info = new DhcpApi.OptionScopeInfo { ScopeType = (int)(scope is null ? GlobalOptions : SubnetOptions), Subnet = scope ?? 0 };
        if (DhcpV4GetAllOptionValues(null, 0, ref info, out var values) != DhcpApi.Success || values == null) return result;
        for (uint i = 0; i < values->NumElements; i++)
        {
            var entry = values->Options[i]; if (entry.PolicyName == null || entry.OptionsArray == null || entry.IsVendor != 0) continue;
            var list = result.TryGetValue(new string(entry.PolicyName), out var found) ? found : result[new string(entry.PolicyName)] = [];
            for (uint j = 0; j < entry.OptionsArray->NumElements && list.Count < 256; j++)
            {
                var value = entry.OptionsArray->Values[j]; var texts = new List<string>();
                for (uint k = 0; k < value.Value.NumElements && k < 32; k++) texts.Add(DhcpApi.FormatValue(value.Value.Elements[k]));
                list.Add(new RawOption(value.OptionId, names.TryGetValue(value.OptionId, out var name) ? name : "", texts));
            }
        }
        return result;
    }

    // ---- Policies --------------------------------------------------------------------------------------------
    /// <summary>The policy struct: one root expression with the AND/OR of the criteria, one expression per criterion (OR of its values, AND for does-not-equal), one condition per value.</summary>
    private static DhcpApi.Policy PolicyStruct(Native native, PolicyData policy, string name, bool withRanges)
    {
        var expressions = new List<DhcpApi.PolicyExpression> { new() { ParentExpr = 0, Operator = policy.And ? 1 : 0 } };
        var conditions = new List<DhcpApi.PolicyCondition>();
        foreach (var (criterion, op, values) in policy.Criteria)
        {
            uint parent = (uint)expressions.Count;
            expressions.Add(new DhcpApi.PolicyExpression { ParentExpr = 0, Operator = op == "equals" ? 0 : 1 });
            foreach (var condition in DhcpChanges.Conditions(criterion, op, values))
                conditions.Add(new DhcpApi.PolicyCondition { ParentExpr = parent, Type = condition.Type, OptionId = condition.OptionId, SubOptionId = condition.SubOptionId, Operator = condition.Operator, Value = native.Bytes(condition.Value), ValueLength = (uint)condition.Value.Length });
        }
        var ranges = withRanges ? policy.Ranges.Select(range => new DhcpApi.IpRange { StartAddress = range.Start, EndAddress = range.End }).ToList() : [];
        return new DhcpApi.Policy
        {
            PolicyName = native.Text(name), IsGlobalPolicy = policy.Scope is null ? 1 : 0, Subnet = policy.Scope ?? 0, ProcessingOrder = policy.Order,
            Conditions = native.One(new DhcpApi.PolicyConditionArray { NumElements = (uint)conditions.Count, Elements = native.Items(conditions) }),
            Expressions = native.One(new DhcpApi.PolicyExpressionArray { NumElements = (uint)expressions.Count, Elements = native.Items(expressions) }),
            Ranges = native.One(new DhcpApi.IpRangeArray { NumElements = (uint)ranges.Count, Elements = native.Items(ranges) }),
            Description = native.Text(policy.Description), Enabled = policy.Enabled ? 1 : 0,
        };
    }
    private void PolicyLease(PolicyData policy, string name)
    {
        var target = new OptionTarget("ipv4", "policy", policy.Scope, null, name);
        if (policy.LeaseSeconds is long seconds) SetOption(target, 51, null, null, [new OptionElement(2, (ulong)seconds, null, null)]);
        else try { RemoveOption(target, 51, null, null); } catch (DhcpApiException) { }
        foreach (var (code, vendor, user, values) in policy.Options.Where(option => option.Code != 51 && option.Values.Count > 0))
        { var (type, multi) = OptionType("ipv4", code, vendor); SetOption(target, code, vendor, user, DhcpChanges.OptionValues(type, multi, values)); }
    }
    public void SetPolicy(PolicyData policy, bool create, string? newName)
    {
        int global = policy.Scope is null ? 1 : 0; uint subnet = policy.Scope ?? 0;
        if (create)
        {
            using (var native = new Native()) { var data = PolicyStruct(native, policy, policy.Name, withRanges: true); Ok("DhcpV4CreatePolicy", DhcpV4CreatePolicy(null, ref data), policy.Name); }
            try { PolicyLease(policy, policy.Name); }
            catch { DhcpV4DeletePolicy(null, global, subnet, policy.Name); throw; }
            return;
        }
        string name = newName ?? policy.Name;
        using (var native = new Native())
        {
            var data = PolicyStruct(native, policy, name, withRanges: false);
            Ok("DhcpV4SetPolicy", DhcpV4SetPolicy(null, PolicyOrder | PolicyExpression | PolicyDescription | PolicyStatus | (newName is null ? 0 : PolicyName), global, subnet, policy.Name, ref data), policy.Name);
        }
        if (policy.Scope is uint scope)
        {
            // The ranges: remove those that are gone, add the new ones.
            var current = new List<(uint, uint)>();
            Ok("DhcpV4GetPolicy", DhcpV4GetPolicy(null, 0, scope, name, out var read), name);
            if (read->Ranges != null) for (uint i = 0; i < read->Ranges->NumElements; i++) current.Add((read->Ranges->Elements[i].StartAddress, read->Ranges->Elements[i].EndAddress));
            foreach (var (start, end) in current.Where(range => !policy.Ranges.Contains(range))) { var range = new DhcpApi.IpRange { StartAddress = start, EndAddress = end }; Ok("DhcpV4RemovePolicyRange", DhcpV4RemovePolicyRange(null, scope, name, ref range), name); }
            foreach (var (start, end) in policy.Ranges.Where(range => !current.Contains(range))) { var range = new DhcpApi.IpRange { StartAddress = start, EndAddress = end }; Ok("DhcpV4AddPolicyRange", DhcpV4AddPolicyRange(null, scope, name, ref range), name); }
        }
        PolicyLease(policy, name);
    }
    public void DeletePolicy(uint? scope, string name) => Ok("DhcpV4DeletePolicy", DhcpV4DeletePolicy(null, scope is null ? 1 : 0, scope ?? 0, name), name);

    // ---- Failover ----------------------------------------------------------------------------------------------
    private static string LocalName()
    {
        var properties = System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties();
        return string.IsNullOrEmpty(properties.DomainName) ? properties.HostName : properties.HostName + "." + properties.DomainName;
    }
    /// <summary>
    /// The relationship struct of a create: the primary in Windows terms is the
    /// active server of a hot standby, else the requested server type; the
    /// percentage is the primary's share (load balance) or the reserve (hot standby).
    /// </summary>
    internal static (bool LocalPrimary, byte Percentage) FailoverRoles(FailoverData relation)
    {
        bool localPrimary = relation.HotStandby ? relation.Active : relation.Primary;
        byte percentage = relation.HotStandby ? relation.ReservePercent : localPrimary ? relation.LoadBalancePercent : (byte)(100 - relation.LoadBalancePercent);
        return (localPrimary, percentage);
    }
    public void CreateFailover(FailoverData relation, string? secret)
    {
        var (localPrimary, percentage) = FailoverRoles(relation);
        using var native = new Native(); string local = LocalName();
        var data = new DhcpApi.FailoverRelationship
        {
            PrimaryServer = localPrimary ? relation.ServerAddress : relation.PartnerAddress, SecondaryServer = localPrimary ? relation.PartnerAddress : relation.ServerAddress,
            Mode = relation.HotStandby ? 1 : 0, ServerType = localPrimary ? 0 : 1, State = 0, PrevState = 0, Mclt = relation.Mclt, SafePeriod = relation.SafePeriod,
            RelationshipName = native.Text(relation.Name), PrimaryServerName = native.Text(localPrimary ? local : relation.Partner), SecondaryServerName = native.Text(localPrimary ? relation.Partner : local),
            Scopes = native.Ips(relation.Scopes), Percentage = percentage, SharedSecret = native.Text(secret),
        };
        Ok("DhcpV4FailoverCreateRelationship", DhcpV4FailoverCreateRelationship(null, ref data), relation.Name);
    }
    private static T WithRelationship<T>(string name, Func<DhcpApi.FailoverRelationship, T> use)
    {
        Ok("DhcpV4FailoverGetRelationship", DhcpV4FailoverGetRelationship(null, name, out var relation), name);
        return use(*relation);
    }
    private static void ScopesOf(string name, IReadOnlyList<uint> scopes, bool add)
    {
        if (scopes.Count == 0) return;
        using var native = new Native();
        var data = new DhcpApi.FailoverRelationship { RelationshipName = native.Text(name), Scopes = native.Ips(scopes) };
        if (add) Ok("DhcpV4FailoverAddScopeToRelationship", DhcpV4FailoverAddScopeToRelationship(null, ref data), name);
        else Ok("DhcpV4FailoverDeleteScopeFromRelationship", DhcpV4FailoverDeleteScopeFromRelationship(null, ref data), name);
    }
    public void EditFailover(string name, byte? loadBalancePercent, byte? reservePercent, uint? mclt, uint? safePeriod, bool? authentication, string? secret, IReadOnlyList<uint> add, IReadOnlyList<uint> remove, bool deleteRemoved)
    {
        WithRelationship(name, current =>
        {
            using var native = new Native(); var next = current; uint flags = 0;
            if (mclt is uint m) { next.Mclt = m; flags |= FailoverMclt; }
            if (safePeriod is uint period) { next.SafePeriod = period; flags |= FailoverSafePeriod; }
            if (current.Mode == 0 && loadBalancePercent is byte share) { next.Percentage = current.ServerType == 0 ? share : (byte)(100 - share); flags |= FailoverPercentage; }
            if (current.Mode == 1 && reservePercent is byte reserve) { next.Percentage = reserve; flags |= FailoverPercentage; }
            if (authentication == false) { next.SharedSecret = null; flags |= FailoverSecret; }
            else if (secret is not null) { next.SharedSecret = native.Text(secret); flags |= FailoverSecret; }
            if (flags != 0) Ok("DhcpV4FailoverSetRelationship", DhcpV4FailoverSetRelationship(null, flags, ref next), name);
            return 0;
        });
        ScopesOf(name, remove, add: false);
        // The partner side deletes the removed scopes, as the DHCP console does.
        if (deleteRemoved) foreach (uint scope in remove) DeleteScope(scope);
        ScopesOf(name, add, add: true);
    }
    public void RemoveFailover(string name, bool deleteScopes)
    {
        var scopes = WithRelationship(name, relation => { var list = new List<uint>(); if (relation.Scopes != null) for (uint i = 0; i < relation.Scopes->NumElements; i++) list.Add(relation.Scopes->Elements[i]); return list; });
        Ok("DhcpV4FailoverDeleteRelationship", DhcpV4FailoverDeleteRelationship(null, name), name);
        if (deleteScopes) foreach (uint scope in scopes) DeleteScope(scope);
    }

    // ---- Read back for scope-apply --------------------------------------------------------------------------------
    public ScopeModel? ReadScope(uint scope)
    {
        uint code = DhcpGetSubnetInfo(null, scope, out var info);
        if (code == 20005 || info == null) return null;
        Ok("DhcpGetSubnetInfo", code, Ip(scope));
        // The subnet info is copied before the next call.
        (uint mask, string subnetName, string comment, bool active) = (info->SubnetMask, info->SubnetName == null ? "" : new string(info->SubnetName), info->SubnetComment == null ? "" : new string(info->SubnetComment), info->SubnetState is 0 or 2);
        var range = CurrentRange(scope);
        var options = DhcpApi.OptionsV4(2, scope, []).Select(option => ((int)option.Code, (string?)null, (string?)null)).ToList();
        var policies = DhcpApi.Policies(false, scope).Select(policy => policy.Name).ToList();
        var reservations = DhcpApi.Elements(scope, ReservedIps).Select(item => { var (name, description) = ReadClientText(item.Start); return new ApplyReservation(item.Start, ClientId(item.ClientId ?? [], scope), DhcpSnapshot.ReservationType(item.Types), name, description); }).ToList();
        return new ScopeModel(scope, mask, subnetName, comment, active,
            range?.Start ?? 0, range?.End ?? 0, range is null ? "dhcp" : DhcpSnapshot.ScopeType(range.Type), DhcpApi.Elements(scope, ExcludedRanges).Select(item => (item.Start, item.End)).ToList(), options, policies, reservations);
    }

    /// <summary>The struct sizes of the new calls on x64, for the self-test.</summary>
    internal static IReadOnlyDictionary<string, (int Actual, int Expected)> Layout() => new Dictionary<string, (int, int)>
    {
        ["DHCP_CLIENT_INFO_V4"] = (sizeof(ClientInfoV4), 80), ["DHCP_CLIENT_INFO_V4.ClientType"] = ((int)Marshal.OffsetOf<ClientInfoV4>(nameof(ClientInfoV4.ClientType)), 72),
        ["DHCP_SEARCH_INFO"] = (sizeof(SearchInfo), 24), ["DHCP_SEARCH_INFO_V6"] = (sizeof(SearchInfoV6), 24),
        ["DHCP_ALL_OPTION_VALUES_PB"] = (sizeof(AllOptionValuesPb), 16), ["DHCP_ALL_OPTION_VALUES_PB.Options[]"] = (sizeof(AllOptionValuesPolicy), 32),
        ["DHCP_IP_RANGE"] = (sizeof(DhcpApi.IpRange), 8), ["DHCP_POL_COND_ARRAY"] = (sizeof(DhcpApi.PolicyConditionArray), 16), ["DHCP_IP_RANGE_ARRAY"] = (sizeof(DhcpApi.IpRangeArray), 16),
    };
}
