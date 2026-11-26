import type {Server} from '@/lib/types';

// Summary addresses should identify an interface that can reach other hosts.
// Private and VPN ranges remain useful; loopback, autoconfiguration, multicast
// and reserved class-E addresses do not make useful device labels.
function usableIpv4(value:string):string|null{
 const match=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/([0-9]|[12]\d|3[0-2]))?$/.exec(value.trim());
 if(!match)return null;
 const parts=match.slice(1,5);
 if(parts.some(part=>part.length>1&&part.startsWith('0')))return null;
 const octets=parts.map(Number);
 if(octets.some(part=>part>255)||octets[0]===0||octets[0]===127||octets[0]>=224||octets[0]===169&&octets[1]===254)return null;
 return octets.join('.');
}

export function deviceIpv4Addresses(server:Server):string[]{
 const result=new Set<string>();
 for(const network of server.snapshot?.networks??[]){
  for(const address of network.addresses??[]){
   const value=typeof address==='string'?usableIpv4(address):null;
   if(value)result.add(value);
  }
 }
 return [...result];
}

export function primaryDeviceAddress(server:Server):string|null{
 return deviceIpv4Addresses(server)[0]??null;
}

// Basic network telemetry also includes Windows filter and tunnel interfaces.
// Only the IPv4 management inventory provides a known Windows interface index.
// The count describes captured IPv4 configuration, not physical/active NICs.
export function deviceIpv4InterfaceCount(server:Server):number|null{
 const configuration=server.snapshot?.networkConfig;
 if(!Array.isArray(configuration))return null;
 return new Set(configuration.map(adapter=>adapter.interfaceIndex).filter(index=>Number.isInteger(index)&&index>0)).size;
}
