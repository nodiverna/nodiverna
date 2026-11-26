using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Plugin.Dhcp;

// The DHCP server as the DHCP Server Management API returns it (DhcpApi.cs),
// and its mapping to the snapshot of schema 1 that the portal validates
// (dhcpSnapshotSchema in lib/dhcp.ts, docs/dhcp-server.md). Pure, so the
// self-test covers the mapping and the 2 MiB cap without a DHCP server.

internal sealed record RawOption(uint Code, string Name, IReadOnlyList<string> Values);
internal sealed record RawCondition(uint Parent, int Type, uint OptionId, uint SubOptionId, int Operator, byte[] Value);
internal sealed record RawPolicy(string Name, uint Subnet, uint Order, bool Enabled, string Description, IReadOnlyList<RawCondition> Conditions, int RootOperator, IReadOnlyList<(uint Start, uint End)> Ranges, IReadOnlyList<RawOption>? Options = null);
/// <summary>An option definition: its code, name, the API value type (0 byte … 8 IPv6 address) and whether it takes several values.</summary>
internal sealed record RawOptionDefinition(uint Code, string Name, int Type, bool MultiValued);
internal sealed record RawReservationV4(uint Address, byte[] ClientId, byte Types);
internal sealed record RawScopeV4(uint Subnet, uint Mask, string Name, string Comment, int State, int RangeType, uint Start, uint End, uint? LeaseSeconds, uint InUse, uint Free,
    IReadOnlyList<(uint Start, uint End)> Exclusions, IReadOnlyList<RawReservationV4> Reservations, IReadOnlyList<RawOption> Options, IReadOnlyList<RawPolicy> Policies);
internal sealed record RawClientV4(uint Address, uint Subnet, byte[] Hardware, string? Name, string? Comment, long Expires, byte AddressState);
internal sealed record RawReservationV6(byte[] Address, byte[] Duid, uint Iaid);
internal sealed record RawScopeV6(byte[] Prefix, uint PrefixLength, ushort Preference, string Name, string Comment, uint State, ulong InUse, ulong Free,
    IReadOnlyList<(byte[] Start, byte[] End)> Exclusions, IReadOnlyList<RawReservationV6> Reservations, IReadOnlyList<RawOption> Options);
internal sealed record RawClientV6(byte[] Address, byte[] Prefix, byte[] Duid, string? Name, string? Comment, long ValidExpires);
internal sealed record RawFailover(uint Primary, uint Secondary, int Mode, int ServerType, int State, uint Mclt, uint SafePeriod, string Name, string? PrimaryName, string? SecondaryName, IReadOnlyList<uint> Scopes, byte Percentage, bool HasSecret);
internal sealed record RawDhcp(string ServerName, string? Domain, string Authorization, IReadOnlyList<RawScopeV4> ScopesV4, IReadOnlyList<(uint Subnet, string Name)> Superscopes,
    IReadOnlyList<RawOption> ServerOptionsV4, IReadOnlyList<RawPolicy> ServerPolicies, IReadOnlyList<RawFailover> Failover, IReadOnlyList<RawScopeV6> ScopesV6, IReadOnlyList<RawOption> ServerOptionsV6,
    IReadOnlyList<RawClientV4> ClientsV4, IReadOnlyList<RawClientV6> ClientsV6, long ClientsTotal, IReadOnlyList<RawOptionDefinition>? DefinitionsV4 = null, IReadOnlyList<RawOptionDefinition>? DefinitionsV6 = null);

internal static class DhcpSnapshot
{
    internal const int MaximumBytes = 2_097_152, MaximumLeases = 10_000;
    private static readonly string[] FailoverStates = ["noState", "init", "startup", "normal", "communicationInterrupted", "partnerDown", "potentialConflict", "conflictDone", "resolutionInterrupted", "recover", "recoverWait", "recoverDone", "paused", "shutdown"];

    internal static string Clip(string? value, int maximum) { string text = new((value ?? "").Select(c => char.IsControl(c) ? ' ' : c).ToArray()); return text.Length <= maximum ? text : text[..maximum]; }
    internal static string Ipv4(uint address) => string.Join('.', (address >> 24) & 255, (address >> 16) & 255, (address >> 8) & 255, address & 255);
    internal static string Ipv6(byte[] address) => new IPAddress(address).ToString();
    /// <summary>The 16 address bytes of a DHCP_IPV6_ADDRESS: the high 64 bits first, each half most significant byte first.</summary>
    internal static byte[] Ipv6Bytes(ulong high, ulong low) { var bytes = new byte[16]; for (int i = 0; i < 8; i++) { bytes[i] = (byte)(high >> (56 - 8 * i)); bytes[8 + i] = (byte)(low >> (56 - 8 * i)); } return bytes; }
    internal static string Hex(byte[] bytes) => string.Join('-', bytes.Select(item => item.ToString("x2", CultureInfo.InvariantCulture)));
    /// <summary>
    /// The client ID as the DHCP console shows it. The API prefixes the hardware
    /// address of some records with the subnet (4 bytes) and the hardware type
    /// (1 byte); that prefix is cut when it names the subnet of the record.
    /// </summary>
    internal static string ClientId(byte[] uid, uint subnet)
    {
        if (uid.Length > 5)
        {
            uint little = BitConverter.ToUInt32(uid, 0), big = (uint)(uid[0] << 24 | uid[1] << 16 | uid[2] << 8 | uid[3]);
            if (little == subnet || big == subnet) return Hex(uid[5..]);
        }
        return Hex(uid);
    }
    internal static string ScopeState(int state) => state is 0 or 2 ? "active" : "inactive";
    internal static string ScopeType(int rangeType) => rangeType switch { 6 => "both", 7 => "bootp", _ => "dhcp" };
    internal static string ReservationType(byte types) => (types & 3) switch { 2 => "bootp", 3 => "both", _ => "dhcp" };
    /// <summary>Option 51 as seconds; 0xFFFFFFFF ("unlimited") and an unknown duration give null.</summary>
    internal static uint? LeaseDuration(uint? seconds) => seconds is null or 0xFFFFFFFF ? null : seconds;
    /// <summary>The in-use percent with one decimal; 0 without addresses.</summary>
    internal static double Percent(ulong inUse, ulong total) => total == 0 ? 0 : Math.Round(Math.Min(100, inUse * 100.0 / total), 1);
    /// <summary>A FILETIME as an ISO time; 0 and the "never" values give null.</summary>
    internal static string? Expiry(long fileTime) => fileTime <= 0 || fileTime >= 0x7FFF_FFFF_0000_0000 || fileTime > DateTime.MaxValue.ToFileTimeUtc() ? null : DateTime.FromFileTimeUtc(fileTime).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
    private static uint Count(ulong value) => (uint)Math.Min(value, uint.MaxValue);
    private static JsonArray Array(IEnumerable<JsonNode?> items) => new(items.ToArray());
    private static JsonArray Strings(IEnumerable<string> items) => Array(items.Select(item => (JsonNode)JsonValue.Create(item)!));

    internal static JsonObject Option(RawOption option) => new() { ["code"] = (int)option.Code, ["name"] = Clip(option.Name, 128), ["vendorClass"] = null, ["userClass"] = null, ["values"] = Strings(option.Values.Take(32).Select(value => Clip(value, 512))) };

    /// <summary>The policy conditions as criteria: one criterion per attribute and operator, with its values.</summary>
    internal static JsonObject Policy(RawPolicy policy, string? scopeId)
    {
        var criteria = new List<(string Type, string Operator, List<string> Values)>();
        foreach (var condition in policy.Conditions)
        {
            string? type = condition.Type switch
            {
                0 => "mac",
                1 => condition.OptionId switch { 60 => "vendorClass", 77 => "userClass", 61 => "clientId", 81 => "fqdn", 82 => "relayAgent", _ => null },
                2 => condition.OptionId == 82 ? condition.SubOptionId switch { 1 => "circuitId", 2 => "remoteId", 6 => "subscriberId", _ => "relayAgent" } : null,
                3 or 4 => "fqdn",
                _ => null,
            };
            if (type is null) continue;
            string value = type is "vendorClass" or "userClass" or "fqdn" && condition.Value.All(b => b is >= 32 and < 127) ? Encoding.ASCII.GetString(condition.Value) : Hex(condition.Value).ToUpperInvariant();
            value = condition.Operator switch { 2 or 3 => value + "*", 4 or 5 => "*" + value, _ => value };
            string op = condition.Operator is 1 or 3 or 5 ? "notEquals" : "equals";
            var existing = criteria.FirstOrDefault(item => item.Type == type && item.Operator == op);
            if (existing.Values is null) { existing = (type, op, new List<string>()); criteria.Add(existing); }
            existing.Values.Add(Clip(value, 256));
        }
        var node = new JsonObject
        {
            ["name"] = Clip(policy.Name, 256), ["scopeId"] = scopeId, ["order"] = (int)Math.Min(policy.Order, 65535u), ["enabled"] = policy.Enabled, ["condition"] = policy.RootOperator == 1 ? "and" : "or",
            ["criteria"] = Array(criteria.Take(32).Select(item => (JsonNode)new JsonObject { ["type"] = item.Type, ["operator"] = item.Operator, ["values"] = Strings(item.Values.Take(32)) })),
            ["ranges"] = Array(policy.Ranges.Take(32).Select(range => (JsonNode)new JsonObject { ["start"] = Ipv4(range.Start), ["end"] = Ipv4(range.End) })),
            ["leaseDurationSeconds"] = null, ["description"] = Clip(policy.Description, 1024),
        };
        if (policy.Options is not null) node["options"] = Array(policy.Options.Take(256).Select(item => (JsonNode)Option(item)));
        return node;
    }
    /// <summary>The snapshot names of the API option value types (lib/dhcp.ts dhcpOptionTypes).</summary>
    internal static readonly string[] OptionTypeNames = ["byte", "word", "dword", "dwordDword", "ipAddress", "string", "binary", "encapsulated", "ipv6Address"];
    internal static JsonArray Definitions(IReadOnlyList<RawOptionDefinition> definitions) => Array(definitions.Where(item => item.Type is >= 0 and <= 8 && item.Code <= 65535).GroupBy(item => item.Code).Select(group => group.First()).Take(512)
        .Select(item => (JsonNode)new JsonObject { ["code"] = (int)item.Code, ["name"] = Clip(item.Name, 128), ["type"] = OptionTypeNames[item.Type], ["multiValued"] = item.MultiValued, ["vendorClass"] = null }));

    private static JsonObject Failover(RawFailover relation)
    {
        bool primary = relation.ServerType == 0, standby = relation.Mode == 1;
        string partner = primary ? relation.SecondaryName ?? Ipv4(relation.Secondary) : relation.PrimaryName ?? Ipv4(relation.Primary);
        int percent = Math.Min((int)relation.Percentage, 100);
        return new JsonObject
        {
            ["name"] = Clip(relation.Name, 256), ["partner"] = Clip(partner, 256), ["mode"] = standby ? "hotStandby" : "loadBalance", ["serverRole"] = standby ? (primary ? "active" : "standby") : null,
            ["loadBalancePercent"] = standby ? null : primary ? percent : 100 - percent, ["reservePercent"] = standby ? percent : null,
            ["state"] = relation.State >= 0 && relation.State < FailoverStates.Length ? FailoverStates[relation.State] : "unknown", ["mcltSeconds"] = relation.Mclt, ["autoStateTransition"] = relation.SafePeriod > 0,
            ["stateSwitchIntervalSeconds"] = relation.SafePeriod > 0 ? relation.SafePeriod : null, ["scopeIds"] = Strings(relation.Scopes.Take(500).Select(Ipv4)), ["messageAuthentication"] = relation.HasSecret,
        };
    }

    /// <summary>The snapshot of a stopped service: the server facts and empty lists.</summary>
    internal static JsonObject Stopped(string server, string? domain, string authorization) => new()
    {
        ["schema"] = 1, ["service"] = "stopped", ["server"] = new JsonObject { ["name"] = Clip(server, 256), ["authorization"] = authorization, ["domain"] = domain is null ? null : Clip(domain, 256) },
        ["ipv4"] = new JsonObject { ["scopes"] = new JsonArray(), ["superscopes"] = new JsonArray(), ["serverOptions"] = new JsonArray(), ["policies"] = new JsonArray(), ["failover"] = new JsonArray() },
        ["ipv6"] = new JsonObject { ["scopes"] = new JsonArray(), ["serverOptions"] = new JsonArray() },
        ["leases"] = new JsonObject { ["items"] = new JsonArray(), ["total"] = 0, ["truncated"] = false }, ["truncated"] = new JsonObject { ["reservations"] = false, ["leases"] = false },
    };

    /// <summary>The snapshot of a running service, before the 2 MiB fit.</summary>
    internal static JsonObject Build(RawDhcp raw, DateTimeOffset now)
    {
        var snapshot = Stopped(raw.ServerName, raw.Domain, raw.Authorization); snapshot["service"] = "running";
        var superscopes = raw.Superscopes.Where(item => !string.IsNullOrEmpty(item.Name)).ToList();
        var failoverByScope = new Dictionary<uint, string>();
        foreach (var relation in raw.Failover) foreach (uint scope in relation.Scopes) failoverByScope.TryAdd(scope, Clip(relation.Name, 256));
        var reservedV4 = new HashSet<uint>(raw.ScopesV4.SelectMany(scope => scope.Reservations.Select(item => item.Address)));
        var clientsByAddress = raw.ClientsV4.GroupBy(client => client.Address).ToDictionary(group => group.Key, group => group.First());
        bool reservationsCut = false;
        var v4 = snapshot["ipv4"]!.AsObject();
        v4["scopes"] = Array(raw.ScopesV4.Take(500).Select(scope =>
        {
            if (scope.Reservations.Count > 2000) reservationsCut = true;
            ulong total = (ulong)scope.InUse + scope.Free;
            return (JsonNode)new JsonObject
            {
                ["id"] = Ipv4(scope.Subnet), ["name"] = Clip(scope.Name, 256), ["description"] = Clip(scope.Comment, 1024), ["subnetMask"] = Ipv4(scope.Mask), ["startRange"] = Ipv4(scope.Start), ["endRange"] = Ipv4(scope.End),
                ["state"] = ScopeState(scope.State), ["leaseDurationSeconds"] = LeaseDuration(scope.LeaseSeconds), ["type"] = ScopeType(scope.RangeType),
                ["superscope"] = superscopes.FirstOrDefault(item => item.Subnet == scope.Subnet).Name is string name ? Clip(name, 256) : null,
                ["failover"] = failoverByScope.TryGetValue(scope.Subnet, out var relation) ? relation : null,
                ["usage"] = new JsonObject { ["total"] = Count(total), ["inUse"] = scope.InUse, ["free"] = scope.Free, ["reserved"] = (uint)scope.Reservations.Count, ["percent"] = Percent(scope.InUse, total) },
                ["exclusions"] = Array(scope.Exclusions.Take(100).Select(range => (JsonNode)new JsonObject { ["start"] = Ipv4(range.Start), ["end"] = Ipv4(range.End) })),
                ["reservations"] = Array(scope.Reservations.Take(2000).Select(item =>
                {
                    clientsByAddress.TryGetValue(item.Address, out var client);
                    return (JsonNode)new JsonObject { ["address"] = Ipv4(item.Address), ["name"] = Clip(client?.Name, 256), ["clientId"] = Clip(ClientId(item.ClientId, scope.Subnet), 256), ["type"] = ReservationType(item.Types), ["description"] = Clip(client?.Comment, 1024) };
                })),
                ["options"] = Array(scope.Options.Take(256).Select(item => (JsonNode)Option(item))),
                ["policies"] = Array(scope.Policies.Take(200).Select(item => (JsonNode)Policy(item, Ipv4(scope.Subnet)))),
            };
        }));
        v4["superscopes"] = Array(superscopes.GroupBy(item => item.Name).Take(100).Select(group => (JsonNode)new JsonObject { ["name"] = Clip(group.Key, 256), ["scopeIds"] = Strings(group.Take(500).Select(item => Ipv4(item.Subnet))) }));
        v4["serverOptions"] = Array(raw.ServerOptionsV4.Take(256).Select(item => (JsonNode)Option(item)));
        v4["policies"] = Array(raw.ServerPolicies.Take(200).Select(item => (JsonNode)Policy(item, null)));
        v4["failover"] = Array(raw.Failover.Take(32).Select(item => (JsonNode)Failover(item)));
        if (raw.DefinitionsV4 is not null) v4["optionDefinitions"] = Definitions(raw.DefinitionsV4);
        var v6 = snapshot["ipv6"]!.AsObject();
        v6["scopes"] = Array(raw.ScopesV6.Take(200).Select(scope =>
        {
            if (scope.Reservations.Count > 2000) reservationsCut = true;
            return (JsonNode)new JsonObject
            {
                ["prefix"] = Ipv6(scope.Prefix), ["name"] = Clip(scope.Name, 256), ["description"] = Clip(scope.Comment, 1024), ["state"] = scope.State == 0 ? "active" : "inactive", ["preference"] = Math.Min((int)scope.Preference, 255),
                ["preferredLifetimeSeconds"] = null, ["validLifetimeSeconds"] = null,
                ["usage"] = new JsonObject { ["inUse"] = Count(scope.InUse), ["free"] = Count(scope.Free), ["percent"] = Percent(scope.InUse, scope.InUse + scope.Free) },
                ["exclusions"] = Array(scope.Exclusions.Take(100).Select(range => (JsonNode)new JsonObject { ["start"] = Ipv6(range.Start), ["end"] = Ipv6(range.End) })),
                ["reservations"] = Array(scope.Reservations.Take(2000).Select(item => (JsonNode)new JsonObject { ["address"] = Ipv6(item.Address), ["name"] = "", ["duid"] = Clip(Hex(item.Duid), 260), ["iaid"] = item.Iaid, ["description"] = "" })),
                ["options"] = Array(scope.Options.Take(256).Select(item => (JsonNode)Option(item))),
            };
        }));
        v6["serverOptions"] = Array(raw.ServerOptionsV6.Take(256).Select(item => (JsonNode)Option(item)));
        if (raw.DefinitionsV6 is not null) v6["optionDefinitions"] = Definitions(raw.DefinitionsV6);
        // Every lease, the latest expiry first ("never" first of all), so a cut keeps the newest ones.
        var leases = raw.ClientsV4.Select(client =>
        {
            string? expires = Expiry(client.Expires);
            string state = reservedV4.Contains(client.Address) ? "reserved" : (client.AddressState & 3) switch
            {
                1 => expires is not null && DateTime.FromFileTimeUtc(client.Expires) < now.UtcDateTime ? "expired" : "active",
                2 => "declined", 3 => "expired", _ => "other",
            };
            return (Sort: expires is null ? long.MaxValue : client.Expires, Node: new JsonObject { ["family"] = "ipv4", ["address"] = Ipv4(client.Address), ["scope"] = Ipv4(client.Subnet), ["name"] = client.Name is null ? null : Clip(client.Name, 256), ["clientId"] = Clip(ClientId(client.Hardware, client.Subnet), 260), ["expiresAt"] = expires, ["state"] = state });
        }).Concat(raw.ClientsV6.Select(client =>
        {
            string? expires = Expiry(client.ValidExpires);
            string state = expires is not null && DateTime.FromFileTimeUtc(client.ValidExpires) < now.UtcDateTime ? "expired" : "active";
            return (Sort: expires is null ? long.MaxValue : client.ValidExpires, Node: new JsonObject { ["family"] = "ipv6", ["address"] = Ipv6(client.Address), ["scope"] = Ipv6(client.Prefix), ["name"] = client.Name is null ? null : Clip(client.Name, 256), ["clientId"] = Clip(Hex(client.Duid), 260), ["expiresAt"] = expires, ["state"] = state });
        })).OrderByDescending(item => item.Sort).ToList();
        bool leasesCut = leases.Count > MaximumLeases || raw.ClientsTotal > leases.Count;
        snapshot["leases"] = new JsonObject { ["items"] = Array(leases.Take(MaximumLeases).Select(item => (JsonNode)item.Node)), ["total"] = Count((ulong)Math.Max(raw.ClientsTotal, leases.Count)), ["truncated"] = leasesCut };
        snapshot["truncated"] = new JsonObject { ["reservations"] = reservationsCut, ["leases"] = leasesCut };
        return snapshot;
    }

    internal static int Size(JsonObject snapshot) => Encoding.UTF8.GetByteCount(snapshot.ToJsonString());

    /// <summary>
    /// Keeps the snapshot at most `maximum` bytes: the leases are cut first (the
    /// list is ordered with the latest expiry first, so the newest stay), then the
    /// reservations, in scope order. Sets the truncated flags.
    /// </summary>
    internal static JsonObject Fit(JsonObject snapshot, int maximum = MaximumBytes)
    {
        if (Size(snapshot) <= maximum) return snapshot;
        var leases = snapshot["leases"]!["items"]!.AsArray().Select(item => item!.DeepClone()).ToList();
        int Keep(int count, Action<int> apply)
        {
            // The largest count in [0, count] that fits, by halving.
            int low = 0, high = count;
            while (low < high) { int middle = (low + high + 1) / 2; apply(middle); if (Size(snapshot) <= maximum) low = middle; else high = middle - 1; }
            apply(low); return low;
        }
        void Leases(int keep) => snapshot["leases"]!["items"] = new JsonArray(leases.Take(keep).Select(item => item!.DeepClone()).ToArray());
        int kept = Keep(leases.Count, Leases);
        if (kept < leases.Count) { snapshot["leases"]!["truncated"] = true; snapshot["truncated"]!["leases"] = true; }
        if (Size(snapshot) <= maximum) return snapshot;
        var scopes = snapshot["ipv4"]!["scopes"]!.AsArray().Select(scope => scope!.AsObject()).Concat(snapshot["ipv6"]!["scopes"]!.AsArray().Select(scope => scope!.AsObject())).ToList();
        var reservations = scopes.Select(scope => scope["reservations"]!.AsArray().Select(item => item!.DeepClone()).ToList()).ToList();
        int all = reservations.Sum(list => list.Count);
        void Reservations(int keep)
        {
            int left = keep;
            for (int i = 0; i < scopes.Count; i++) { int take = Math.Min(left, reservations[i].Count); scopes[i]["reservations"] = new JsonArray(reservations[i].Take(take).Select(item => item!.DeepClone()).ToArray()); left -= take; }
        }
        int keptReservations = Keep(all, Reservations);
        if (keptReservations < all) snapshot["truncated"]!["reservations"] = true;
        return snapshot;
    }
}
