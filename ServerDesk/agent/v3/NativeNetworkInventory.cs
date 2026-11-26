using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// Keep the Windows provider behind a small seam so protocol binding and
// disappearing/unsupported adapters can be tested without a Windows host.
internal interface INativeNetworkAdapter
{
    NetworkInterfaceType InterfaceType { get; }
    string Alias { get; }
    string Description { get; }
    string Mac { get; }
    long Speed { get; }
    OperationalStatus Status { get; }
    bool Supports(NetworkInterfaceComponent component);
    INativeNetworkProperties GetProperties();
}

internal interface INativeNetworkProperties
{
    IReadOnlyList<string> Addresses();
    IReadOnlyList<NativeIpv4Address> Ipv4Addresses();
    IReadOnlyList<string> Gateways();
    IReadOnlyList<string> Dns();
    NativeIpv4Properties? Ipv4();
    int? Ipv6Index();
}

internal sealed record NativeIpv4Properties(int Index, bool Dhcp);
internal sealed record NativeIpv4Address(string Address, int Prefix);

internal static class NativeNetworkInventory
{
    internal const string WarningKey = "_collectionWarnings";
    private const int MaximumWarnings = 8;

    internal static JsonObject Telemetry() => Telemetry(Adapters());
    internal static JsonArray Drift() => Drift(Adapters());
    private static IEnumerable<INativeNetworkAdapter> Adapters() => NetworkInterface.GetAllNetworkInterfaces().Select(adapter => (INativeNetworkAdapter)new SystemAdapter(adapter));

    internal static JsonObject Telemetry(IEnumerable<INativeNetworkAdapter> adapters)
    {
        var scan = Read(adapters, 100, true);
        return new JsonObject { ["networks"] = scan.Networks, ["networkConfig"] = scan.Configuration, [WarningKey] = scan.Warnings() };
    }

    internal static JsonArray Drift(IEnumerable<INativeNetworkAdapter> adapters)
    {
        var scan = Read(adapters, 5000, false);
        // A partial inventory must never look like deleted configuration or
        // become a new baseline. Telemetry can publish healthy adapters, drift
        // must fail the category until every applicable adapter is readable.
        if (scan.Incomplete) throw new InvalidDataException("Network configuration inventory is incomplete.");
        return new JsonArray(scan.DriftRows.OrderBy(row => row["index"]!.GetValue<int>()).Cast<JsonNode>().ToArray());
    }

    private static Scan Read(IEnumerable<INativeNetworkAdapter> adapters, int maximum, bool telemetry)
    {
        var scan = new Scan(); int count = 0;
        foreach (var adapter in adapters)
        {
            string alias = "";
            bool ReadValue<T>(string detail, Func<T> get, out T value)
            {
                try { value = get(); return true; }
                catch (Exception exception) when (Recoverable(exception))
                {
                    value = default!; scan.Warn(alias ?? "", detail, NativeInventoryDiagnostics.Describe(exception)); return false;
                }
            }

            if (!ReadValue("Adapter type", () => adapter.InterfaceType, out var type)) type = NetworkInterfaceType.Unknown;
            if (type == NetworkInterfaceType.Loopback) continue;
            if (++count > maximum) { scan.Warn("", "The number of adapters exceeds the inventory limit", "inventory limit"); break; }
            bool aliasKnown = ReadValue("Name", () => adapter.Alias, out alias); alias ??= "";

            JsonObject? basic = null;
            if (telemetry)
            {
                ReadValue("Description", () => adapter.Description, out string description);
                ReadValue("MAC address", () => adapter.Mac, out string mac);
                ReadValue("Speed", () => adapter.Speed, out long speed);
                basic = new JsonObject { ["name"] = Limit(description ?? alias), ["addresses"] = new JsonArray(), ["mac"] = Limit(mac ?? ""), ["speedMbps"] = Math.Round(Math.Max(0, speed) / 1000000d) };
                scan.Networks.Add(basic);
            }

            // Some Windows filter/tunnel adapters do not bind IPv4. In .NET 10
            // GetIPv4Properties can throw instead of returning null for them.
            bool v4Known = ReadValue("IPv4 binding", () => adapter.Supports(NetworkInterfaceComponent.IPv4), out bool supportsV4);
            bool supportsV6 = false;
            // IPv6's index is a fallback only for an IPv6-only adapter; don't
            // let an irrelevant protocol provider break healthy IPv4 data.
            bool v6Known = v4Known && supportsV4 || ReadValue("IPv6 binding", () => adapter.Supports(NetworkInterfaceComponent.IPv6), out supportsV6);
            if (v4Known && v6Known && !supportsV4 && !supportsV6) continue;
            if (!ReadValue("IP properties", adapter.GetProperties, out var properties)) continue;
            if (basic is not null && ReadValue("IP addresses", properties.Addresses, out var addresses)) basic["addresses"] = Array(addresses.Take(20).Select(Limit));

            // Unknown binding is not equivalent to disabled binding.
            if (!v4Known || !v6Known || !aliasKnown) continue;
            if (!supportsV4 && !supportsV6) continue;
            if (telemetry && !supportsV4) continue;

            int? index = null; bool? dhcp = null;
            if (supportsV4)
            {
                if (!ReadValue("IPv4 properties", properties.Ipv4, out var v4)) continue;
                if (v4 is null || v4.Index <= 0) { scan.Warn(alias, "IPv4 adapter index not available", "adapter index"); continue; }
                index = v4.Index; dhcp = v4.Dhcp;
            }
            else
            {
                if (!ReadValue("IPv6 adapter index", properties.Ipv6Index, out index)) continue;
                if (index is not > 0) { scan.Warn(alias, "IPv6 adapter index not available", "adapter index"); continue; }
            }

            IReadOnlyList<NativeIpv4Address> ipv4 = [];
            if (supportsV4 && !ReadValue("IPv4 addresses", properties.Ipv4Addresses, out ipv4)) continue;
            bool gatewaysKnown = ReadValue("Gateways", properties.Gateways, out var gateways);
            bool dnsKnown = ReadValue("DNS-Server", properties.Dns, out var dns);
            if (!gatewaysKnown || !dnsKnown) continue;
            if (ipv4.Count > 5000 || gateways.Count > 5000 || dns.Count > 5000) throw new InvalidDataException("Network adapter configuration exceeds its bounded resource size.");
            if (ipv4.Any(address => !IPAddress.TryParse(address.Address, out var ip) || ip.AddressFamily != AddressFamily.InterNetwork || address.Prefix is < 0 or > 32))
            { scan.Warn(alias, "IPv4 address or prefix not readable", "address format"); continue; }

            scan.DriftRows.Add(new JsonObject
            {
                ["index"] = index.Value, ["alias"] = alias,
                ["addresses"] = new JsonArray(ipv4.OrderBy(address => address.Address, StringComparer.Ordinal).Select(address => (JsonNode)new JsonObject { ["address"] = address.Address, ["prefix"] = address.Prefix }).ToArray()),
                ["gateway"] = Array(gateways.Order(StringComparer.Ordinal)), ["dns"] = Array(dns)
            });

            // The management contract is specifically IPv4: DHCP is mandatory
            // and must be known, so an IPv6-only adapter remains in the basic
            // inventory without fabricated actionable configuration.
            if (!telemetry || dhcp is null) continue;
            if (!ReadValue("Connection state", () => adapter.Status, out var status)) continue;
            if (ipv4.Count > 50 || gateways.Count > 20 || dns.Count > 20)
            { scan.Warn(alias, "The IPv4 configuration exceeds the management limit", "inventory limit"); continue; }
            scan.Configuration.Add(new JsonObject
            {
                ["interfaceIndex"] = index.Value, ["alias"] = Limit(alias), ["dhcp"] = dhcp.Value,
                ["addresses"] = new JsonArray(ipv4.Select(address => (JsonNode)new JsonObject { ["address"] = address.Address, ["prefixLength"] = address.Prefix }).ToArray()),
                ["gateway"] = Array(gateways.Where(address => IPAddress.TryParse(address, out var ip) && ip.AddressFamily == AddressFamily.InterNetwork).Select(Limit)),
                ["dns"] = Array(dns.Select(Limit)), ["status"] = status == OperationalStatus.Up ? "Up" : status == OperationalStatus.Down ? "Disconnected" : status.ToString()
            });
        }
        return scan;
    }

    private static bool Recoverable(Exception exception) => exception is NetworkInformationException or NotSupportedException;
    private static string Limit(string value) => value[..Math.Min(value.Length, 500)];
    private static JsonArray Array(IEnumerable<string> values) => new(values.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());

    private sealed class Scan
    {
        internal JsonArray Networks { get; } = new();
        internal JsonArray Configuration { get; } = new();
        internal List<JsonObject> DriftRows { get; } = [];
        private readonly List<string> warnings = [];
        private int warningCount;
        internal bool Incomplete => warningCount > 0;
        internal void Warn(string alias, string detail, string kind)
        {
            warningCount++;
            if (warnings.Count < MaximumWarnings - 1) warnings.Add("Network partly readable" + (alias.Length > 0 ? " · " + alias[..Math.Min(alias.Length, 100)] : "") + ": " + detail + " (" + kind + ").");
        }
        internal JsonArray Warnings() => Array(warningCount > warnings.Count ? warnings.Append("Network: " + (warningCount - warnings.Count) + " more adapter details could not be read.") : warnings);
    }

    private sealed class SystemAdapter(NetworkInterface adapter) : INativeNetworkAdapter
    {
        public NetworkInterfaceType InterfaceType => adapter.NetworkInterfaceType;
        public string Alias => adapter.Name;
        public string Description => adapter.Description;
        public string Mac => string.Join(":", adapter.GetPhysicalAddress().GetAddressBytes().Select(value => value.ToString("X2")));
        public long Speed => adapter.Speed;
        public OperationalStatus Status => adapter.OperationalStatus;
        public bool Supports(NetworkInterfaceComponent component) => adapter.Supports(component);
        public INativeNetworkProperties GetProperties() => new SystemProperties(adapter.GetIPProperties());
    }

    private sealed class SystemProperties(IPInterfaceProperties properties) : INativeNetworkProperties
    {
        public IReadOnlyList<string> Addresses() => properties.UnicastAddresses.Take(5001).Select(address => address.Address.ToString()).ToArray();
        public IReadOnlyList<NativeIpv4Address> Ipv4Addresses() => properties.UnicastAddresses.Where(address => address.Address.AddressFamily == AddressFamily.InterNetwork).Take(5001).Select(address => new NativeIpv4Address(address.Address.ToString(), address.PrefixLength)).ToArray();
        public IReadOnlyList<string> Gateways() => properties.GatewayAddresses.Take(5001).Select(address => address.Address.ToString()).ToArray();
        public IReadOnlyList<string> Dns() => properties.DnsAddresses.Take(5001).Select(address => address.ToString()).ToArray();
        public NativeIpv4Properties? Ipv4() { var value = properties.GetIPv4Properties(); return value is null ? null : new(value.Index, value.IsDhcpEnabled); }
        public int? Ipv6Index() => properties.GetIPv6Properties()?.Index;
    }
}
