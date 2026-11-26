using System.Net.NetworkInformation;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class NativeNetworkInventoryTests
{
    internal static void Run()
    {
        // The reported .NET 10 failure is reproduced by an adapter with no
        // IPv4 binding. Its throwing IPv4 getter must never be reached.
        var ipv6 = new Adapter("IPv6 tunnel", 17) { SupportsV4 = false, SupportsV6 = true };
        ipv6.Properties.AddressValues = ["2001:db8::17"];
        ipv6.Properties.GatewayValues = ["2001:db8::1"];
        ipv6.Properties.Ipv4Read = () => throw new NetworkInformationException(50);
        var telemetry = NativeNetworkInventory.Telemetry([ipv6]);
        Require(telemetry["networks"]!.AsArray().Count == 1 && telemetry["networks"]![0]!["addresses"]![0]!.GetValue<string>() == "2001:db8::17", "IPv6-only adapter disappeared from the basic inventory.");
        Require(telemetry["networkConfig"]!.AsArray().Count == 0 && Warnings(telemetry).Count == 0 && ipv6.Properties.Ipv4Calls == 0, "Unsupported IPv4 was queried or represented as an actionable DHCP configuration.");
        var ipv6Drift = NativeNetworkInventory.Drift([ipv6]);
        Require(ipv6Drift.Count == 1 && ipv6Drift[0]!["index"]!.GetValue<int>() == 17 && ipv6Drift[0]!["addresses"]!.AsArray().Count == 0 && ipv6.Properties.Ipv4Calls == 0, "IPv6 drift uses an invented index or queries unsupported IPv4.");
        var ipv4Only = new Adapter("IPv4-only", 19) { SupportsRead = component => component == NetworkInterfaceComponent.IPv4 ? true : throw new NetworkInformationException(50) };
        ipv4Only.Properties.Ipv4Read = () => new(19, true);
        var ipv4OnlyReport = NativeNetworkInventory.Telemetry([ipv4Only]);
        Require(ipv4OnlyReport["networkConfig"]![0]!["dhcp"]!.GetValue<bool>() && Warnings(ipv4OnlyReport).Count == 0, "An irrelevant IPv6 provider broke a known IPv4 DHCP configuration.");

        // Non-IP filter adapters retain their identity without querying an
        // inapplicable IP provider or generating a perpetual error warning.
        var filter = new Adapter("Filter", 0) { SupportsV4 = false, SupportsV6 = false, PropertiesRead = () => throw new NetworkInformationException(50) };
        var filterTelemetry = NativeNetworkInventory.Telemetry([filter]);
        Require(filterTelemetry["networks"]!.AsArray().Count == 1 && filterTelemetry["networkConfig"]!.AsArray().Count == 0 && Warnings(filterTelemetry).Count == 0 && filter.PropertiesCalls == 0 && NativeNetworkInventory.Drift([filter]).Count == 0, "An unbound filter adapter broke network collection.");

        var broken = new Adapter("Unavailable IPv4", 12);
        broken.Properties.Ipv4Read = () => throw new NetworkInformationException(50);
        var healthy = new Adapter("Ethernet", 6);
        var partial = NativeNetworkInventory.Telemetry([broken, healthy]);
        Require(partial["networks"]!.AsArray().Count == 2 && partial["networkConfig"]!.AsArray().Count == 1 && partial["networkConfig"]![0]!["interfaceIndex"]!.GetValue<int>() == 6, "One unreadable protocol discarded healthy adapters or basic NIC identity.");
        Require(Warnings(partial).Count == 1 && Warnings(partial)[0]!.GetValue<string>().Contains("IPv4 properties", StringComparison.Ordinal), "Partial protocol failure was hidden.");
        IncompleteDrift([broken, healthy]);

        var unavailable = new Adapter("Disappearing adapter", 13) { PropertiesRead = () => throw new NetworkInformationException(1168) };
        var unavailableReport = NativeNetworkInventory.Telemetry([unavailable, healthy]);
        Require(unavailableReport["networks"]!.AsArray().Count == 2 && unavailableReport["networks"]![0]!["addresses"]!.AsArray().Count == 0 && unavailableReport["networkConfig"]!.AsArray().Count == 1 && Warnings(unavailableReport).Count == 1, "A disappearing adapter removed the basic row or healthy configuration.");
        IncompleteDrift([unavailable, healthy]);
        var aliasUnknown = new Adapter("Alias unavailable", 20) { AliasRead = () => throw new NetworkInformationException(1168) };
        var aliasReport = NativeNetworkInventory.Telemetry([aliasUnknown, healthy]);
        Require(aliasReport["networks"]!.AsArray().Count == 2 && aliasReport["networkConfig"]!.AsArray().Count == 1 && Warnings(aliasReport).Count == 1, "Unreadable alias broke warning collection or fabricated an actionable adapter identity.");
        IncompleteDrift([aliasUnknown]);

        // DHCP and interface index are mandatory in the portal contract; an
        // unavailable value must not become false, zero or an IPv6 substitute.
        var zero = new Adapter("Unknown index", 0);
        var zeroReport = NativeNetworkInventory.Telemetry([zero, healthy]);
        Require(zeroReport["networkConfig"]!.AsArray().Count == 1 && Warnings(zeroReport).Count == 1, "A zero interface index became actionable.");
        IncompleteDrift([zero]);
        var nullV4 = new Adapter("Null IPv4", 10); nullV4.Properties.Ipv4Read = () => null;
        Require(NativeNetworkInventory.Telemetry([nullV4])["networkConfig"]!.AsArray().Count == 0, "Missing IPv4/DHCP properties were fabricated.");
        IncompleteDrift([nullV4]);

        var prefix = new Adapter("Unreadable prefix", 10);
        prefix.Properties.Ipv4AddressesRead = () => throw new NetworkInformationException(50);
        var prefixReport = NativeNetworkInventory.Telemetry([prefix, healthy]);
        Require(prefixReport["networks"]![0]!["addresses"]!.AsArray().Count == 2 && prefixReport["networkConfig"]!.AsArray().Count == 1, "Unreadable prefix removed otherwise readable protocol addresses.");
        IncompleteDrift([prefix]);
        var invalidPrefix = new Adapter("Invalid prefix", 11);
        invalidPrefix.Properties.Ipv4Values = [new("10.1.0.11", 99)];
        Require(NativeNetworkInventory.Telemetry([invalidPrefix])["networkConfig"]!.AsArray().Count == 0, "An unknown IPv4 prefix was clamped into false configuration.");
        IncompleteDrift([invalidPrefix]);

        var unknownStatus = new Adapter("Unreadable status", 14) { StatusRead = () => throw new NetworkInformationException(1168) };
        Require(NativeNetworkInventory.Telemetry([unknownStatus, healthy])["networkConfig"]!.AsArray().Count == 1, "Unknown status became an actionable disconnected adapter.");
        Require(NativeNetworkInventory.Drift([unknownStatus]).Count == 1, "Drift queried irrelevant operational status.");
        var dormant = new Adapter("Dormant", 15) { StatusRead = () => OperationalStatus.Dormant };
        Require(NativeNetworkInventory.Telemetry([dormant])["networkConfig"]![0]!["status"]!.GetValue<string>() == "Dormant", "A known non-up state was incorrectly called disconnected.");

        var dns = new Adapter("Unreadable DNS", 16); dns.Properties.DnsRead = () => throw new NetworkInformationException(50);
        Require(NativeNetworkInventory.Telemetry([dns, healthy])["networkConfig"]!.AsArray().Count == 1, "Unknown DNS was represented as an empty managed DNS list.");
        IncompleteDrift([dns]);
        var unknownBinding = new Adapter("Binding unknown", 18) { SupportsRead = _ => throw new NetworkInformationException(50) };
        Require(NativeNetworkInventory.Telemetry([unknownBinding])["networkConfig"]!.AsArray().Count == 0, "Unknown protocol binding was interpreted as disabled or supported.");
        IncompleteDrift([unknownBinding]);

        // IPv4 actions cannot prefill an IPv6 gateway. Drift retains the full
        // original gateway set, and DNS precedence stays in provider order.
        healthy.Properties.GatewayValues = ["2001:db8::1", "10.1.0.1"];
        healthy.Properties.DnsValues = ["2001:db8::53", "10.1.0.4"];
        var valid = NativeNetworkInventory.Telemetry([healthy]);
        Require(valid["networkConfig"]![0]!["gateway"]!.AsArray().Count == 1 && valid["networkConfig"]![0]!["gateway"]![0]!.GetValue<string>() == "10.1.0.1" && valid["networkConfig"]![0]!["dns"]![0]!.GetValue<string>() == "2001:db8::53", "IPv4 actions got an IPv6 gateway or DNS precedence changed.");
        Require(NativeNetworkInventory.Drift([healthy])[0]!["gateway"]!.AsArray().Count == 2, "Drift silently discarded IPv6 gateway configuration.");

        var manyBroken = Enumerable.Range(1, 25).Select(index => new Adapter("Unreadable " + new string('x', 600), index) { PropertiesRead = () => throw new NetworkInformationException(50) }).Cast<INativeNetworkAdapter>().Append(healthy);
        var bounded = NativeNetworkInventory.Telemetry(manyBroken);
        Require(Warnings(bounded).Count == 8 && Warnings(bounded).All(node => node!.GetValue<string>().Length <= 500) && bounded["networkConfig"]!.AsArray().Count == 1, "Partial diagnostics became unbounded or starved healthy configuration.");
        var excessive = NativeNetworkInventory.Telemetry(Enumerable.Range(1, 101).Select(index => (INativeNetworkAdapter)new Adapter("NIC " + index, index)));
        Require(excessive["networks"]!.AsArray().Count == 100 && excessive["networkConfig"]!.AsArray().Count == 100 && Warnings(excessive).Count == 1, "Network telemetry bounds discarded the entire inventory or silently hid truncation.");

        var loopback = new Adapter("Loopback", 1) { Type = NetworkInterfaceType.Loopback, PropertiesRead = () => throw new InvalidOperationException("must not be read") };
        Require(NativeNetworkInventory.Telemetry([loopback])["networks"]!.AsArray().Count == 0 && loopback.PropertiesCalls == 0, "Loopback queried an inapplicable IP provider.");
        bool unexpected = false;
        try { NativeNetworkInventory.Telemetry([new Adapter("Unexpected", 1) { PropertiesRead = () => throw new InvalidOperationException("private provider detail") }]); }
        catch (InvalidOperationException) { unexpected = true; }
        Require(unexpected, "Unexpected programming/provider failure was hidden as a partial adapter warning.");
        bool fatal = false;
        try { NativeNetworkInventory.Telemetry([new Adapter("Fatal", 1) { PropertiesRead = () => throw new OutOfMemoryException() }]); }
        catch (OutOfMemoryException) { fatal = true; }
        Require(fatal, "Fatal exception was swallowed as a partial network failure.");
    }

    private static JsonArray Warnings(JsonObject snapshot) => snapshot[NativeNetworkInventory.WarningKey]!.AsArray();
    private static void IncompleteDrift(IEnumerable<INativeNetworkAdapter> adapters)
    {
        bool failed = false;
        try { NativeNetworkInventory.Drift(adapters); } catch (InvalidDataException) { failed = true; }
        Require(failed, "Incomplete network configuration could become a drift baseline or deletion report.");
    }
    private static void Require(bool value, string message) { if (!value) throw new Exception(message); }

    private sealed class Adapter(string alias, int index) : INativeNetworkAdapter
    {
        public NetworkInterfaceType Type { get; init; } = NetworkInterfaceType.Ethernet;
        public bool SupportsV4 { get; init; } = true;
        public bool SupportsV6 { get; init; } = true;
        public Func<NetworkInterfaceComponent, bool>? SupportsRead { get; init; }
        public Func<string>? AliasRead { get; init; }
        public Func<INativeNetworkProperties>? PropertiesRead { get; init; }
        public Func<OperationalStatus>? StatusRead { get; init; }
        internal Properties Properties { get; } = new(index);
        internal int PropertiesCalls { get; private set; }
        public NetworkInterfaceType InterfaceType => Type;
        public string Alias => AliasRead?.Invoke() ?? alias;
        public string Description => alias;
        public string Mac => "00:11:22:33:44:55";
        public long Speed => 1000000000;
        public OperationalStatus Status => StatusRead?.Invoke() ?? OperationalStatus.Up;
        public bool Supports(NetworkInterfaceComponent component) => SupportsRead?.Invoke(component) ?? (component == NetworkInterfaceComponent.IPv4 ? SupportsV4 : SupportsV6);
        public INativeNetworkProperties GetProperties() { PropertiesCalls++; return PropertiesRead?.Invoke() ?? Properties; }
    }

    private sealed class Properties(int index) : INativeNetworkProperties
    {
        internal string[] AddressValues { get; set; } = ["10.1.0.10", "2001:db8::10"];
        internal NativeIpv4Address[] Ipv4Values { get; set; } = [new("10.1.0.10", 24)];
        internal string[] GatewayValues { get; set; } = ["10.1.0.1"];
        internal string[] DnsValues { get; set; } = ["10.1.0.4"];
        internal Func<NativeIpv4Properties?>? Ipv4Read { get; set; }
        internal Func<IReadOnlyList<NativeIpv4Address>>? Ipv4AddressesRead { get; set; }
        internal Func<IReadOnlyList<string>>? DnsRead { get; set; }
        internal int Ipv4Calls { get; private set; }
        public IReadOnlyList<string> Addresses() => AddressValues;
        public IReadOnlyList<NativeIpv4Address> Ipv4Addresses() => Ipv4AddressesRead?.Invoke() ?? Ipv4Values;
        public IReadOnlyList<string> Gateways() => GatewayValues;
        public IReadOnlyList<string> Dns() => DnsRead?.Invoke() ?? DnsValues;
        public NativeIpv4Properties? Ipv4() { Ipv4Calls++; return Ipv4Read is null ? new(index, false) : Ipv4Read(); }
        public int? Ipv6Index() => index;
    }
}
