using System.Net.NetworkInformation;
using System.Runtime.InteropServices;

namespace ServerDesk.Plugin.Dhcp;

// The DHCP Server Management API (dhcpsapi.dll) of the local server. Every call
// passes null as the server address, so the plugin reads only the server it
// runs on and opens no network connection of its own. The structs follow the
// x64 layout of dhcpsapi.h; DhcpSelfTests checks their sizes.
//
// Memory rule (plugin 1.1.1): memory that the DHCP API returns is never freed.
// The broker starts the plugin for one request and the process then ends
// (agent/v3/PluginHost.cs), so Windows frees it. Freeing the nested pointers
// with DhcpRpcFreeMemory corrupted the heap (0xC0000374) on a server with
// scopes. Every value is copied into managed objects before the next API call.

/// <summary>A failed DHCP API call with its Win32 or DHCP error code.</summary>
internal sealed class DhcpApiException(string call, uint code, string? target = null) : Exception(call + " failed with error " + code + ".")
{
    internal uint Code { get; } = code;
    internal string Call { get; } = call;
    /// <summary>The object of a change the call named, for PLUGIN_DHCP_OBJECT_EXISTS and _MISSING; null for reads.</summary>
    internal string? Object { get; } = target;
}

internal static unsafe class DhcpApi
{
    internal const uint Success = 0, AccessDenied = 5, MoreData = 234, NoMoreItems = 259, PreferredMaximum = 65536;
    internal const uint IsRogue = 0x01, IsPartOfDsdc = 0x03;

    // ---- Structs (x64) -------------------------------------------------------------------
    [StructLayout(LayoutKind.Sequential)] internal struct IpArray { public uint NumElements; public uint* Elements; }
    [StructLayout(LayoutKind.Sequential)] internal struct HostInfo { public uint IpAddress; public char* NetBiosName; public char* HostName; }
    [StructLayout(LayoutKind.Sequential)] internal struct SubnetInfo { public uint SubnetAddress, SubnetMask; public char* SubnetName, SubnetComment; public HostInfo PrimaryHost; public int SubnetState; }
    [StructLayout(LayoutKind.Sequential)] internal struct BinaryData { public uint DataLength; public byte* Data; }
    [StructLayout(LayoutKind.Sequential)] internal struct IpRange { public uint StartAddress, EndAddress; }
    [StructLayout(LayoutKind.Sequential)] internal struct BootpIpRange { public uint StartAddress, EndAddress, BootpAllocated, MaxBootpAllowed; }
    [StructLayout(LayoutKind.Sequential)] internal struct ReservationV4 { public uint ReservedIpAddress; public BinaryData* ReservedForClient; public byte AllowedClientTypes; }
    [StructLayout(LayoutKind.Sequential)] internal struct ElementV5 { public int ElementType; public void* Element; }
    [StructLayout(LayoutKind.Sequential)] internal struct ElementArrayV5 { public uint NumElements; public ElementV5* Elements; }
    [StructLayout(LayoutKind.Sequential)] internal struct DateTime32 { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] internal struct ClientV5 { public uint ClientIpAddress, SubnetMask; public BinaryData ClientHardwareAddress; public char* ClientName, ClientComment; public DateTime32 ClientLeaseExpires; public HostInfo OwnerHost; public byte ClientType, AddressState; }
    [StructLayout(LayoutKind.Sequential)] internal struct ClientArrayV5 { public uint NumElements; public ClientV5** Clients; }
    [StructLayout(LayoutKind.Sequential)] internal struct ScopeMibV5 { public uint Subnet, NumAddressesInuse, NumAddressesFree, NumPendingOffers; }
    [StructLayout(LayoutKind.Sequential)] internal struct MibV5 { public uint Discovers, Offers, Requests, Acks, Naks, Declines, Releases; public DateTime32 ServerStartTime; public uint QtnNumLeases, QtnPctQtnLeases, QtnProbationLeases, QtnNonQtnLeases, QtnExemptLeases, QtnCapableClients, QtnIASErrors, DelayedOffers, ScopesWithDelayedOffers, Scopes; public ScopeMibV5* ScopeInfo; }
    [StructLayout(LayoutKind.Sequential)] internal struct Ipv6Address { public ulong HighOrderBits, LowOrderBits; }
    [StructLayout(LayoutKind.Sequential)] internal struct Ipv6Array { public uint NumElements; public Ipv6Address* Elements; }
    [StructLayout(LayoutKind.Sequential)] internal struct SubnetInfoV6 { public Ipv6Address SubnetAddress; public uint Prefix; public ushort Preference; public char* SubnetName, SubnetComment; public uint State, ScopeId; }
    [StructLayout(LayoutKind.Sequential)] internal struct ReservationV6 { public Ipv6Address ReservedIpAddress; public BinaryData* ReservedForClient; public uint InterfaceId; }
    [StructLayout(LayoutKind.Sequential)] internal struct IpRangeV6 { public Ipv6Address StartAddress, EndAddress; }
    [StructLayout(LayoutKind.Sequential)] internal struct ElementV6 { public int ElementType; public void* Element; }
    [StructLayout(LayoutKind.Sequential)] internal struct ElementArrayV6 { public uint NumElements; public ElementV6* Elements; }
    [StructLayout(LayoutKind.Sequential)] internal struct HostInfoV6 { public Ipv6Address IpAddress; public char* NetBiosName; public char* HostName; }
    [StructLayout(LayoutKind.Sequential)] internal struct ClientV6 { public Ipv6Address ClientIpAddress; public BinaryData ClientDuid; public uint AddressType, Iaid; public char* ClientName, ClientComment; public DateTime32 ClientValidLeaseExpires, ClientPrefLeaseExpires; public HostInfoV6 OwnerHost; }
    [StructLayout(LayoutKind.Sequential)] internal struct ClientArrayV6 { public uint NumElements; public ClientV6** Clients; }
    [StructLayout(LayoutKind.Sequential)] internal struct ScopeMibV6 { public Ipv6Address Subnet; public ulong NumAddressesInuse, NumAddressesFree, NumPendingAdvertises; }
    [StructLayout(LayoutKind.Sequential)] internal struct MibV6 { public uint Solicits, Advertises, Requests, Renews, Rebinds, Replies, Confirms, Declines, Releases, Informs; public DateTime32 ServerStartTime; public uint Scopes; public ScopeMibV6* ScopeInfo; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] internal struct OptionDataElement { [FieldOffset(0)] public int OptionType; [FieldOffset(8)] public uint DWord; [FieldOffset(12)] public uint DWord2; [FieldOffset(8)] public char* Text; [FieldOffset(8)] public uint BinaryLength; [FieldOffset(16)] public byte* BinaryData; }
    [StructLayout(LayoutKind.Sequential)] internal struct OptionData { public uint NumElements; public OptionDataElement* Elements; }
    [StructLayout(LayoutKind.Sequential)] internal struct OptionValue { public uint OptionId; public OptionData Value; }
    [StructLayout(LayoutKind.Sequential)] internal struct OptionValueArray { public uint NumElements; public OptionValue* Values; }
    [StructLayout(LayoutKind.Sequential)] internal struct Option { public uint OptionId; public char* OptionName, OptionComment; public OptionData DefaultValue; public int OptionType; }
    [StructLayout(LayoutKind.Sequential)] internal struct OptionArray { public uint NumElements; public Option* Options; }
    [StructLayout(LayoutKind.Explicit, Size = 16)] internal struct OptionScopeInfo { [FieldOffset(0)] public int ScopeType; [FieldOffset(8)] public uint Subnet; }
    [StructLayout(LayoutKind.Explicit, Size = 40)] internal struct OptionScopeInfo6 { [FieldOffset(0)] public int ScopeType; [FieldOffset(8)] public Ipv6Address Subnet; }
    [StructLayout(LayoutKind.Sequential)] internal struct SuperScopeEntry { public uint SubnetAddress, SuperScopeNumber, NextInSuperScope; public char* SuperScopeName; }
    [StructLayout(LayoutKind.Sequential)] internal struct SuperScopeTable { public uint Entries; public SuperScopeEntry* Table; }
    [StructLayout(LayoutKind.Sequential)] internal struct PolicyCondition { public uint ParentExpr; public int Type; public uint OptionId, SubOptionId; public char* VendorName; public int Operator; public byte* Value; public uint ValueLength; }
    [StructLayout(LayoutKind.Sequential)] internal struct PolicyConditionArray { public uint NumElements; public PolicyCondition* Elements; }
    [StructLayout(LayoutKind.Sequential)] internal struct PolicyExpression { public uint ParentExpr; public int Operator; }
    [StructLayout(LayoutKind.Sequential)] internal struct PolicyExpressionArray { public uint NumElements; public PolicyExpression* Elements; }
    [StructLayout(LayoutKind.Sequential)] internal struct IpRangeArray { public uint NumElements; public IpRange* Elements; }
    [StructLayout(LayoutKind.Sequential)] internal struct Policy { public char* PolicyName; public int IsGlobalPolicy; public uint Subnet, ProcessingOrder; public PolicyConditionArray* Conditions; public PolicyExpressionArray* Expressions; public IpRangeArray* Ranges; public char* Description; public int Enabled; }
    [StructLayout(LayoutKind.Sequential)] internal struct PolicyArray { public uint NumElements; public Policy* Elements; }
    [StructLayout(LayoutKind.Sequential)] internal struct FailoverRelationship { public uint PrimaryServer, SecondaryServer; public int Mode, ServerType, State, PrevState; public uint Mclt, SafePeriod; public char* RelationshipName, PrimaryServerName, SecondaryServerName; public IpArray* Scopes; public byte Percentage; public char* SharedSecret; }
    [StructLayout(LayoutKind.Sequential)] internal struct FailoverArray { public uint NumElements; public FailoverRelationship* Relationships; }
    [StructLayout(LayoutKind.Sequential)] internal struct Attribute { public uint AttributeId, AttributeType; public int Value; }

    // ---- Calls -----------------------------------------------------------------------------
    private const string Library = "dhcpsapi.dll";
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpEnumSubnets(string? server, ref uint resume, uint preferred, out IpArray* info, out uint read, out uint total);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpGetSubnetInfo(string? server, uint subnet, out SubnetInfo* info);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpEnumSubnetElementsV5(string? server, uint subnet, int type, ref uint resume, uint preferred, out ElementArrayV5* info, out uint read, out uint total);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpEnumSubnetClientsV5(string? server, uint subnet, ref uint resume, uint preferred, out ClientArrayV5* info, out uint read, out uint total);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpGetMibInfoV5(string? server, out MibV5* info);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpEnumSubnetsV6(string? server, ref uint resume, uint preferred, out Ipv6Array* info, out uint read, out uint total);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpGetSubnetInfoV6(string? server, Ipv6Address subnet, out SubnetInfoV6* info);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpEnumSubnetElementsV6(string? server, Ipv6Address subnet, int type, ref uint resume, uint preferred, out ElementArrayV6* info, out uint read, out uint total);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpEnumSubnetClientsV6(string? server, Ipv6Address subnet, ref Ipv6Address resume, uint preferred, out ClientArrayV6* info, out uint read, out uint total);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpGetMibInfoV6(string? server, out MibV6* info);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpEnumOptionValuesV5(string? server, uint flags, string? className, string? vendorName, ref OptionScopeInfo scope, ref uint resume, uint preferred, out OptionValueArray* values, out uint read, out uint total);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpEnumOptionsV5(string? server, uint flags, string? className, string? vendorName, ref uint resume, uint preferred, out OptionArray* options, out uint read, out uint total);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpEnumOptionValuesV6(string? server, uint flags, string? className, string? vendorName, ref OptionScopeInfo6 scope, ref uint resume, uint preferred, out OptionValueArray* values, out uint read, out uint total);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpEnumOptionsV6(string? server, uint flags, string? className, string? vendorName, ref uint resume, uint preferred, out OptionArray* options, out uint read, out uint total);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpGetSuperScopeInfoV4(string? server, out SuperScopeTable* table);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4EnumPolicies(string? server, ref uint resume, uint preferred, int global, uint subnet, out PolicyArray* policies, out uint read, out uint total);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpV4FailoverEnumRelationship(string? server, ref uint resume, uint preferred, out FailoverArray* relationships, out uint read, out uint total);
    [DllImport(Library, CharSet = CharSet.Unicode)] private static extern uint DhcpServerQueryAttribute(string? server, uint reserved, uint attribute, out Attribute* value);

    private static string Text(char* value) => value == null ? "" : new string(value);
    private static string? Nullable(char* value) => value == null ? null : new string(value);
    private static byte[] Bytes(BinaryData data) => data.Data == null || data.DataLength == 0 ? [] : new ReadOnlySpan<byte>(data.Data, (int)Math.Min(data.DataLength, 1024)).ToArray();
    private static byte[] Bytes(Ipv6Address address) => DhcpSnapshot.Ipv6Bytes(address.HighOrderBits, address.LowOrderBits);
    internal static void Check(string call, uint code) { if (code != Success && code != MoreData) throw new DhcpApiException(call, code); }

    /// <summary>
    /// Runs one enumeration page by page: `enumerate` reads one buffer into managed
    /// objects and returns its element count. Stops at ERROR_NO_MORE_ITEMS, after the last
    /// page or when `limit` elements are read.
    /// </summary>
    internal static void Pages(string call, Func<uint> enumerate, int limit = int.MaxValue)
    {
        for (int read = 0, guard = 0; read < limit && guard < 100_000; guard++)
        {
            uint code = enumerate();
            if (code == NoMoreItems) return;
            Check(call, code);
            if (code != MoreData) return;
            read++;
        }
    }

    // ---- Reads -------------------------------------------------------------------------------
    internal static string Authorization()
    {
        bool? Read(uint id) => DhcpServerQueryAttribute(null, 0, id, out var value) == Success && value != null ? value->Value != 0 : null;
        bool? domain = Read(IsPartOfDsdc), rogue = Read(IsRogue);
        if (domain == false) return "notInDomain";
        if (domain is null || rogue is null) return "unknown";
        return rogue.Value ? "unauthorized" : "authorized";
    }

    private static List<uint> Subnets()
    {
        var result = new List<uint>(); uint resume = 0;
        Pages("DhcpEnumSubnets", () =>
        {
            uint code = DhcpEnumSubnets(null, ref resume, PreferredMaximum, out var info, out _, out _);
            if (info != null) for (uint i = 0; i < info->NumElements; i++) result.Add(info->Elements[i]);
            return code;
        });
        return result;
    }

    internal static List<ElementV5Data> Elements(uint subnet, int type)
    {
        var result = new List<ElementV5Data>(); uint resume = 0;
        Pages("DhcpEnumSubnetElementsV5", () =>
        {
            uint code = DhcpEnumSubnetElementsV5(null, subnet, type, ref resume, PreferredMaximum, out var info, out _, out _);
            if (info != null) for (uint i = 0; i < info->NumElements; i++)
            {
                var element = info->Elements[i];
                switch (element.ElementType)
                {
                    case 0 or 5 or 6 or 7 when element.Element != null:
                        var range = (BootpIpRange*)element.Element; result.Add(new ElementV5Data(element.ElementType, range->StartAddress, range->EndAddress, null, 0)); break;
                    case 3 when element.Element != null:
                        var excluded = (IpRange*)element.Element; result.Add(new ElementV5Data(3, excluded->StartAddress, excluded->EndAddress, null, 0)); break;
                    case 2 when element.Element != null:
                        var reserved = (ReservationV4*)element.Element;
                        result.Add(new ElementV5Data(2, reserved->ReservedIpAddress, 0, reserved->ReservedForClient == null ? [] : Bytes(*reserved->ReservedForClient), reserved->AllowedClientTypes)); break;
                }
            }
            return code;
        });
        return result;
    }
    internal sealed record ElementV5Data(int Type, uint Start, uint End, byte[]? ClientId, byte Types);

    private static List<RawClientV4> ClientsV4(uint subnet, int limit, ref long total)
    {
        var result = new List<RawClientV4>(); uint resume = 0; long counted = 0;
        Pages("DhcpEnumSubnetClientsV5", () =>
        {
            uint code = DhcpEnumSubnetClientsV5(null, subnet, ref resume, PreferredMaximum, out var info, out _, out _);
            if (info != null) for (uint i = 0; i < info->NumElements; i++)
            {
                var client = info->Clients[i]; if (client == null) continue;
                counted++;
                if (result.Count < limit) result.Add(new RawClientV4(client->ClientIpAddress, subnet, Bytes(client->ClientHardwareAddress), Nullable(client->ClientName), Nullable(client->ClientComment), (long)client->ClientLeaseExpires.High << 32 | client->ClientLeaseExpires.Low, client->AddressState));
            }
            return code;
        });
        total += counted;
        return result;
    }

    private static Dictionary<uint, ScopeMibV5> MibV4()
    {
        var result = new Dictionary<uint, ScopeMibV5>();
        Check("DhcpGetMibInfoV5", DhcpGetMibInfoV5(null, out var info));
        if (info != null) for (uint i = 0; i < info->Scopes; i++) result[info->ScopeInfo[i].Subnet] = info->ScopeInfo[i];
        return result;
    }

    internal static string FormatValue(OptionDataElement element) => element.OptionType switch
    {
        0 or 1 or 2 => element.DWord.ToString(System.Globalization.CultureInfo.InvariantCulture),
        3 => ((ulong)element.DWord << 32 | element.DWord2).ToString(System.Globalization.CultureInfo.InvariantCulture),
        4 => DhcpSnapshot.Ipv4(element.DWord),
        5 or 8 => Text(element.Text),
        6 or 7 => element.BinaryData == null ? "" : DhcpSnapshot.Hex(new ReadOnlySpan<byte>(element.BinaryData, (int)Math.Min(element.BinaryLength, 256)).ToArray()),
        _ => "",
    };

    internal static Dictionary<uint, string> OptionNames(bool v6) => OptionDefinitions(v6).ToDictionary(item => item.Code, item => item.Name);
    /// <summary>The option definitions of the default class (DhcpEnumOptionsV5/V6): code, name, value type of the default value and whether it takes several values.</summary>
    internal static List<RawOptionDefinition> OptionDefinitions(bool v6)
    {
        var definitions = new List<RawOptionDefinition>(); uint resume = 0;
        Pages(v6 ? "DhcpEnumOptionsV6" : "DhcpEnumOptionsV5", () =>
        {
            uint code = v6 ? DhcpEnumOptionsV6(null, 0, null, null, ref resume, PreferredMaximum, out var info, out _, out _) : DhcpEnumOptionsV5(null, 0, null, null, ref resume, PreferredMaximum, out info, out _, out _);
            if (info != null) for (uint i = 0; i < info->NumElements; i++)
            {
                var option = info->Options[i];
                int type = option.DefaultValue.NumElements > 0 && option.DefaultValue.Elements != null ? option.DefaultValue.Elements[0].OptionType : 5;
                definitions.Add(new RawOptionDefinition(option.OptionId, Text(option.OptionName), type, option.OptionType == 1));
            }
            return code;
        });
        return definitions;
    }

    private static List<RawOption> ReadOptionValues(Func<OptionValueArray*[], uint> call, Dictionary<uint, string> names)
    {
        var result = new List<RawOption>();
        Pages("DhcpEnumOptionValues", () =>
        {
            var holder = new OptionValueArray*[1];
            uint code = call(holder); var info = holder[0];
            if (info != null) for (uint i = 0; i < info->NumElements; i++)
            {
                var value = info->Values[i]; var values = new List<string>();
                for (uint j = 0; j < value.Value.NumElements && j < 32; j++) values.Add(FormatValue(value.Value.Elements[j]));
                result.Add(new RawOption(value.OptionId, names.TryGetValue(value.OptionId, out var name) ? name : "", values));
            }
            return code;
        }, 256);
        return result;
    }
    internal static List<RawOption> OptionsV4(int scopeType, uint subnet, Dictionary<uint, string> names)
    {
        uint resume = 0;
        return ReadOptionValues(holder => { var scope = new OptionScopeInfo { ScopeType = scopeType, Subnet = subnet }; uint code = DhcpEnumOptionValuesV5(null, 0, null, null, ref scope, ref resume, PreferredMaximum, out var values, out _, out _); holder[0] = values; return code; }, names);
    }
    private static List<RawOption> OptionsV6(int scopeType, Ipv6Address subnet, Dictionary<uint, string> names)
    {
        uint resume = 0;
        return ReadOptionValues(holder => { var scope = new OptionScopeInfo6 { ScopeType = scopeType, Subnet = subnet }; uint code = DhcpEnumOptionValuesV6(null, 0, null, null, ref scope, ref resume, PreferredMaximum, out var values, out _, out _); holder[0] = values; return code; }, names);
    }

    /// <summary>The reservations of one IPv6 scope: address, DUID and IAID.</summary>
    internal static List<RawReservationV6> ReservationsV6(Ipv6Address subnet)
    {
        var result = new List<RawReservationV6>(); uint resume = 0;
        Pages("DhcpEnumSubnetElementsV6", () =>
        {
            uint code = DhcpEnumSubnetElementsV6(null, subnet, 1, ref resume, PreferredMaximum, out var elements, out _, out _);
            if (elements != null) for (uint i = 0; i < elements->NumElements; i++)
            {
                var element = elements->Elements[i]; if (element.ElementType != 1 || element.Element == null) continue;
                var reserved = (ReservationV6*)element.Element; result.Add(new RawReservationV6(Bytes(reserved->ReservedIpAddress), reserved->ReservedForClient == null ? [] : Bytes(*reserved->ReservedForClient), reserved->InterfaceId));
            }
            return code;
        });
        return result;
    }

    internal static List<RawPolicy> Policies(bool global, uint subnet)
    {
        var result = new List<RawPolicy>(); uint resume = 0;
        Pages("DhcpV4EnumPolicies", () =>
        {
            uint code = DhcpV4EnumPolicies(null, ref resume, PreferredMaximum, global ? 1 : 0, subnet, out var info, out _, out _);
            if (info != null) for (uint i = 0; i < info->NumElements; i++)
            {
                var policy = info->Elements[i]; var conditions = new List<RawCondition>(); var ranges = new List<(uint, uint)>();
                if (policy.Conditions != null) for (uint j = 0; j < policy.Conditions->NumElements && j < 64; j++)
                {
                    var c = policy.Conditions->Elements[j];
                    conditions.Add(new RawCondition(c.ParentExpr, c.Type, c.OptionId, c.SubOptionId, c.Operator, c.Value == null ? [] : new ReadOnlySpan<byte>(c.Value, (int)Math.Min(c.ValueLength, 255)).ToArray()));
                }
                int root = policy.Expressions != null && policy.Expressions->NumElements > 0 ? policy.Expressions->Elements[0].Operator : 0;
                if (policy.Ranges != null) for (uint j = 0; j < policy.Ranges->NumElements && j < 32; j++) ranges.Add((policy.Ranges->Elements[j].StartAddress, policy.Ranges->Elements[j].EndAddress));
                result.Add(new RawPolicy(Text(policy.PolicyName), policy.Subnet, policy.ProcessingOrder, policy.Enabled != 0, Text(policy.Description), conditions, root, ranges));
            }
            return code;
        }, 200);
        return result;
    }

    internal static List<RawFailover> Failover()
    {
        var result = new List<RawFailover>(); uint resume = 0;
        try
        {
            Pages("DhcpV4FailoverEnumRelationship", () =>
            {
                uint code = DhcpV4FailoverEnumRelationship(null, ref resume, PreferredMaximum, out var info, out _, out _);
                if (info != null) for (uint i = 0; i < info->NumElements; i++)
                {
                    var r = info->Relationships[i]; var scopes = new List<uint>();
                    if (r.Scopes != null) for (uint j = 0; j < r.Scopes->NumElements && j < 500; j++) scopes.Add(r.Scopes->Elements[j]);
                    // The shared secret is never read: only whether one exists.
                    result.Add(new RawFailover(r.PrimaryServer, r.SecondaryServer, r.Mode, r.ServerType, r.State, r.Mclt, r.SafePeriod, Text(r.RelationshipName), Nullable(r.PrimaryServerName), Nullable(r.SecondaryServerName), scopes, r.Percentage, r.SharedSecret != null));
                }
                return code;
            }, 32);
        }
        // A server without failover answers with a DHCP failover error; that is no relationship.
        catch (DhcpApiException e) when (e.Code != AccessDenied) { }
        return result;
    }

    internal static List<(uint Subnet, string Name)> Superscopes()
    {
        var result = new List<(uint, string)>();
        Check("DhcpGetSuperScopeInfoV4", DhcpGetSuperScopeInfoV4(null, out var table));
        if (table != null) for (uint i = 0; i < table->Entries; i++) if (table->Table[i].SuperScopeName != null) result.Add((table->Table[i].SubnetAddress, Text(table->Table[i].SuperScopeName)));
        return result;
    }

    private static List<RawScopeV6> ScopesV6(Dictionary<uint, string> names, List<RawClientV6> clients, int limit, ref long total)
    {
        var result = new List<RawScopeV6>(); var subnets = new List<Ipv6Address>(); uint resume = 0;
        Pages("DhcpEnumSubnetsV6", () =>
        {
            uint code = DhcpEnumSubnetsV6(null, ref resume, PreferredMaximum, out var info, out _, out _);
            if (info != null) for (uint i = 0; i < info->NumElements; i++) subnets.Add(info->Elements[i]);
            return code;
        });
        var mib = new Dictionary<(ulong, ulong), ScopeMibV6>();
        if (DhcpGetMibInfoV6(null, out var mibInfo) == Success && mibInfo != null) for (uint i = 0; i < mibInfo->Scopes; i++) mib[(mibInfo->ScopeInfo[i].Subnet.HighOrderBits, mibInfo->ScopeInfo[i].Subnet.LowOrderBits)] = mibInfo->ScopeInfo[i];
        foreach (var subnet in subnets.Take(200))
        {
            Check("DhcpGetSubnetInfoV6", DhcpGetSubnetInfoV6(null, subnet, out var info));
            // The subnet info is copied before the next call.
            (uint prefix, ushort preference, string name, string comment, uint state) = (info->Prefix, info->Preference, Text(info->SubnetName), Text(info->SubnetComment), info->State);
            var exclusions = new List<(byte[], byte[])>(); var reservations = new List<RawReservationV6>(); uint elementResume = 0;
            foreach (int type in new[] { 2, 1 })
            {
                elementResume = 0;
                Pages("DhcpEnumSubnetElementsV6", () =>
                {
                    uint code = DhcpEnumSubnetElementsV6(null, subnet, type, ref elementResume, PreferredMaximum, out var elements, out _, out _);
                    if (elements != null) for (uint i = 0; i < elements->NumElements; i++)
                    {
                        var element = elements->Elements[i]; if (element.Element == null) continue;
                        if (element.ElementType == 2) { var range = (IpRangeV6*)element.Element; exclusions.Add((Bytes(range->StartAddress), Bytes(range->EndAddress))); }
                        if (element.ElementType == 1) { var reserved = (ReservationV6*)element.Element; reservations.Add(new RawReservationV6(Bytes(reserved->ReservedIpAddress), reserved->ReservedForClient == null ? [] : Bytes(*reserved->ReservedForClient), reserved->InterfaceId)); }
                    }
                    return code;
                });
            }
            mib.TryGetValue((subnet.HighOrderBits, subnet.LowOrderBits), out var usage);
            result.Add(new RawScopeV6(Bytes(subnet), prefix, preference, name, comment, state, usage.NumAddressesInuse, usage.NumAddressesFree, exclusions, reservations, OptionsV6(1, subnet, names)));
            // The leases of the scope.
            var clientResume = new Ipv6Address(); long counted = 0;
            Pages("DhcpEnumSubnetClientsV6", () =>
            {
                uint code = DhcpEnumSubnetClientsV6(null, subnet, ref clientResume, PreferredMaximum, out var list, out _, out _);
                if (list != null) for (uint i = 0; i < list->NumElements; i++)
                {
                    var client = list->Clients[i]; if (client == null) continue;
                    counted++;
                    if (clients.Count < limit) clients.Add(new RawClientV6(Bytes(client->ClientIpAddress), Bytes(subnet), Bytes(client->ClientDuid), Nullable(client->ClientName), Nullable(client->ClientComment), (long)client->ClientValidLeaseExpires.High << 32 | client->ClientValidLeaseExpires.Low));
                }
                return code;
            });
            total += counted;
        }
        return result;
    }

    /// <summary>The whole DHCP server of this device. Throws DhcpApiException; error 5 is access denied.</summary>
    internal static RawDhcp Read()
    {
        var definitions = OptionDefinitions(false); var definitionsV6 = OptionDefinitions(true);
        var names = definitions.GroupBy(item => item.Code).ToDictionary(group => group.Key, group => group.First().Name); var namesV6 = definitionsV6.GroupBy(item => item.Code).ToDictionary(group => group.Key, group => group.First().Name);
        // The options of the policies (plugin 1.1.0): DhcpV4GetAllOptionValues per scope and for the server.
        static List<RawPolicy> WithOptions(List<RawPolicy> policies, Dictionary<string, List<RawOption>> options) => policies.Select(policy => options.TryGetValue(policy.Name, out var list) ? policy with { Options = list } : policy with { Options = [] }).ToList();
        var mib = MibV4(); var serverOptions = OptionsV4(1, 0, names);
        var serverLease = serverOptions.FirstOrDefault(option => option.Code == 51)?.Values.FirstOrDefault();
        var scopes = new List<RawScopeV4>(); var clients = new List<RawClientV4>(); long total = 0;
        // Read a little more than the 10,000 kept leases, so the latest expiries among them stay.
        const int leaseLimit = 50_000;
        foreach (uint subnet in Subnets().Take(500))
        {
            Check("DhcpGetSubnetInfo", DhcpGetSubnetInfo(null, subnet, out var info));
            // The subnet info is copied before the next call.
            (uint mask, string name, string comment, int state) = (info->SubnetMask, Text(info->SubnetName), Text(info->SubnetComment), info->SubnetState);
            var ranges = Elements(subnet, 0); var exclusions = Elements(subnet, 3); var reservations = Elements(subnet, 2);
            var range = ranges.FirstOrDefault();
            var options = OptionsV4(2, subnet, names);
            string? lease = options.FirstOrDefault(option => option.Code == 51)?.Values.FirstOrDefault() ?? serverLease;
            mib.TryGetValue(subnet, out var usage);
            scopes.Add(new RawScopeV4(subnet, mask, name, comment, state, range?.Type ?? 0, range?.Start ?? 0, range?.End ?? 0,
                uint.TryParse(lease, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out uint seconds) ? seconds : null, usage.NumAddressesInuse, usage.NumAddressesFree,
                exclusions.Select(item => (item.Start, item.End)).ToList(), reservations.Select(item => new RawReservationV4(item.Start, item.ClientId ?? [], item.Types)).ToList(), options, WithOptions(Policies(false, subnet), DhcpWriter.PolicyOptions(subnet, names))));
            clients.AddRange(ClientsV4(subnet, Math.Max(0, leaseLimit - clients.Count), ref total));
        }
        var clientsV6 = new List<RawClientV6>();
        var scopesV6 = ScopesV6(namesV6, clientsV6, leaseLimit, ref total);
        var properties = IPGlobalProperties.GetIPGlobalProperties();
        string domain = properties.DomainName, server = string.IsNullOrEmpty(domain) ? properties.HostName : properties.HostName + "." + domain;
        // The IPv6 server options are the global options of the server (DhcpGlobalOptions6 = 3), as the writes set them.
        return new RawDhcp(server, string.IsNullOrEmpty(domain) ? null : domain, Authorization(), scopes, Superscopes(), serverOptions, WithOptions(Policies(true, 0), DhcpWriter.PolicyOptions(null, names)), Failover(), scopesV6, OptionsV6(3, new Ipv6Address(), namesV6), clients, clientsV6, total, definitions, definitionsV6);
    }

    /// <summary>The struct sizes of dhcpsapi.h on x64, for the self-test.</summary>
    internal static IReadOnlyDictionary<string, (int Actual, int Expected)> Layout() => new Dictionary<string, (int, int)>
    {
        ["DHCP_IP_ARRAY"] = (sizeof(IpArray), 16), ["DHCP_HOST_INFO"] = (sizeof(HostInfo), 24), ["DHCP_SUBNET_INFO"] = (sizeof(SubnetInfo), 56), ["DHCP_BINARY_DATA"] = (sizeof(BinaryData), 16),
        ["DHCP_BOOTP_IP_RANGE"] = (sizeof(BootpIpRange), 16), ["DHCP_IP_RESERVATION_V4"] = (sizeof(ReservationV4), 24), ["DHCP_SUBNET_ELEMENT_DATA_V5"] = (sizeof(ElementV5), 16),
        ["DHCP_CLIENT_INFO_V5"] = (sizeof(ClientV5), 80), ["SCOPE_MIB_INFO_V5"] = (sizeof(ScopeMibV5), 16), ["DHCP_MIB_INFO_V5"] = (sizeof(MibV5), 88),
        ["DHCP_IPV6_ADDRESS"] = (sizeof(Ipv6Address), 16), ["DHCP_SUBNET_INFO_V6"] = (sizeof(SubnetInfoV6), 48), ["DHCP_IP_RESERVATION_V6"] = (sizeof(ReservationV6), 32), ["DHCP_IP_RANGE_V6"] = (sizeof(IpRangeV6), 32),
        ["DHCP_CLIENT_INFO_V6"] = (sizeof(ClientV6), 104), ["SCOPE_MIB_INFO_V6"] = (sizeof(ScopeMibV6), 40), ["DHCP_MIB_INFO_V6"] = (sizeof(MibV6), 64),
        ["DHCP_OPTION_DATA_ELEMENT"] = (sizeof(OptionDataElement), 24), ["DHCP_OPTION_DATA"] = (sizeof(OptionData), 16), ["DHCP_OPTION_VALUE"] = (sizeof(OptionValue), 24), ["DHCP_OPTION"] = (sizeof(Option), 48),
        ["DHCP_OPTION_SCOPE_INFO"] = (sizeof(OptionScopeInfo), 16), ["DHCP_OPTION_SCOPE_INFO6"] = (sizeof(OptionScopeInfo6), 40), ["DHCP_SUPER_SCOPE_TABLE_ENTRY"] = (sizeof(SuperScopeEntry), 24),
        ["DHCP_POL_COND"] = (sizeof(PolicyCondition), 48), ["DHCP_POL_EXPR"] = (sizeof(PolicyExpression), 8), ["DHCP_POLICY"] = (sizeof(Policy), 64), ["DHCP_FAILOVER_RELATIONSHIP"] = (sizeof(FailoverRelationship), 80),
        ["DHCP_ATTRIB"] = (sizeof(Attribute), 12),
        ["DHCP_CLIENT_INFO_V5.ClientName"] = ((int)Marshal.OffsetOf<ClientV5>(nameof(ClientV5.ClientName)), 24), ["DHCP_CLIENT_INFO_V5.AddressState"] = ((int)Marshal.OffsetOf<ClientV5>(nameof(ClientV5.AddressState)), 73),
        ["DHCP_FAILOVER_RELATIONSHIP.Percentage"] = ((int)Marshal.OffsetOf<FailoverRelationship>(nameof(FailoverRelationship.Percentage)), 64), ["DHCP_POL_COND.Value"] = ((int)Marshal.OffsetOf<PolicyCondition>(nameof(PolicyCondition.Value)), 32),
        ["DHCP_SUBNET_INFO_V6.SubnetName"] = ((int)Marshal.OffsetOf<SubnetInfoV6>(nameof(SubnetInfoV6.SubnetName)), 24), ["DHCP_MIB_INFO_V5.ScopeInfo"] = ((int)Marshal.OffsetOf<MibV5>(nameof(MibV5.ScopeInfo)), 80),
    };
}
