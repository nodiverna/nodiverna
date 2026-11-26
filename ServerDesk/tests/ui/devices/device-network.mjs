// The network summary of a device (ui/devices/device/device-network.ts): the useful IPv4 address first, the full inventory
// unchanged and the counted interfaces.
import assert from 'node:assert/strict';
import {deviceIpv4Addresses,deviceIpv4InterfaceCount,primaryDeviceAddress} from '../../../ui/devices/device/device-network.ts';
const device=networks=>({snapshot:{networks:networks.map((addresses,index)=>({name:'Adapter '+index,addresses}))}});
let server=device([['fe80::abcd%5','2001:db8::1','192.168.2.10'],['10.20.30.40','192.168.2.10',' 172.16.4.12 ']]);
assert.equal(primaryDeviceAddress(server),'192.168.2.10','IPv4 is chosen even when IPv6 comes first');
assert.deepEqual(deviceIpv4Addresses(server),['192.168.2.10','10.20.30.40','172.16.4.12'],'private IPv4 remains useful and duplicate interface addresses are removed');
const original=structuredClone(server);deviceIpv4Addresses(server);assert.deepEqual(server,original,'full network inventory remains unchanged for diagnosis');
server=device([['0.0.0.0','0.12.34.56','127.0.0.1','127.15.20.30','169.254.12.34','224.1.2.3','239.255.255.250','240.1.2.3','255.255.255.255'],['10.0.0.2','100.64.0.2','169.255.1.2','126.0.0.1']]);
assert.deepEqual(deviceIpv4Addresses(server),['10.0.0.2','100.64.0.2','169.255.1.2','126.0.0.1'],'nonhost ranges are filtered while legitimate unicast/private/VPN addresses remain');
assert.equal(primaryDeviceAddress(device([['fe80::1%2','::1','2001:db8::1','::ffff:192.168.1.3']])) ,null,'IPv6 is never a fleet address fallback');
assert.deepEqual(deviceIpv4Addresses(device([['256.0.0.1','192.168.0','192.168.0.1:443','[192.168.0.1]','192.168.01.2','-1.2.3.4','192.168.1.2/33','host.test']])) ,[],'malformed, ambiguous and non-address values are ignored');
assert.deepEqual(deviceIpv4Addresses(device([['10.4.5.6/24','10.4.5.6','10.4.5.7/32']])),['10.4.5.6','10.4.5.7'],'valid CIDR inventory entries render their host address once');
assert.equal(primaryDeviceAddress({snapshot:null}),null);assert.deepEqual(deviceIpv4Addresses(device([])),[]);
assert.equal(deviceIpv4InterfaceCount({snapshot:null}),null,'missing inventory is not reported as zero adapters');
assert.equal(deviceIpv4InterfaceCount(device(Array.from({length:8},()=>[]))),null,'raw/filter interfaces do not define the IPv4 adapter count');
const configurations={snapshot:{networkConfig:[{interfaceIndex:5,alias:'Ethernet 4',status:'Up'},{interfaceIndex:5,alias:'Ethernet 4',status:'Up'},{interfaceIndex:9,alias:'VPN',status:'Disconnected'},{interfaceIndex:0},{interfaceIndex:-1},{interfaceIndex:4.5},{interfaceIndex:Number.NaN}]}};
assert.equal(deviceIpv4InterfaceCount(configurations),2,'count uses unique known Windows IPv4 indexes, including configured disconnected adapters without claiming activity');
assert.equal(deviceIpv4InterfaceCount({snapshot:{networkConfig:[]}}),0,'known empty IPv4 inventory is distinguishable from missing configuration');
console.log('PASS: device summaries prefer useful IPv4, preserve full network inventory and count only uniquely identified captured IPv4 interfaces.');
