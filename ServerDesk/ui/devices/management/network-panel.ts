import type {Server,ServerSnapshot,Viewer} from '@/lib/types';
import {deviceConnection} from '@/ui/base/ui-device';
import {operations} from '@/lib/management';
import {isOwner} from '@/ui/base/access-capabilities';
import {confirmationDevice} from '@/ui/devices/management/management-actions';

import {translate} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {EMPTY_VALUE} from '@/lib/i18n/format';
export type NetworkAdapter=NonNullable<ServerSnapshot['networkConfig']>[number];
export type NetworkContext={server:Server;viewer:Viewer;demo:boolean;saving:boolean;now:number};
export type NetworkSelection={serverId:string;interfaceIndex:number;fingerprint:string};
export const networkFingerprint=(adapter:NetworkAdapter)=>JSON.stringify([adapter.alias,adapter.dhcp,adapter.addresses,adapter.gateway,adapter.dns]);
export function networkAdapters(server:Server):NetworkAdapter[]{
  const seen=new Set<number>();
  return (server.snapshot?.networkConfig??[]).filter(adapter=>{
    if(!Number.isInteger(adapter.interfaceIndex)||adapter.interfaceIndex<=0||seen.has(adapter.interfaceIndex))return false;
    seen.add(adapter.interfaceIndex);return true;
  });
}
export function currentNetworkAdapter(server:Server,target:NetworkSelection):NetworkAdapter|null{
  if(server.id!==target.serverId||server.revoked)return null;
  const adapter=networkAdapters(server).find(item=>item.interfaceIndex===target.interfaceIndex);
  return adapter&&networkFingerprint(adapter)===target.fingerprint?adapter:null;
}
export function networkActionReason(context:NetworkContext,kind:string,locale:Locale=defaultLocale){
  const {server,viewer,demo,saving,now}=context,snapshot=server.snapshot;
  if(demo)return translate(locale,'kit.unavailable.demo');
  if(saving)return translate(locale,'services.blocked.saving');
  if(server.revoked)return translate(locale,'kit.unavailable.revoked');
  const read=['network-diagnostics','test-connection','refresh'].includes(kind),right=read?'diagnose':'manage';
  if(!(isOwner(viewer)||server.permissions?.includes(right)))return read?translate(locale,'management.blocked.diagnose'):translate(locale,'management.blocked.manage');
  if(!read&&(server.management!==1||snapshot?.mode!=='Management'))return translate(locale,'management.blocked.readOnly');
  if(deviceConnection(server,now).kind!=='online')return translate(locale,'management.blocked.offline');
  if(snapshot?.protocolVersion!==3||!snapshot.agentCapabilities?.includes(kind))return translate(locale,'management.blocked.unsupported');
  return '';
}
export function networkConfirmation(context:NetworkContext,target:NetworkSelection,kind:'set-network'|'set-dns',params:Record<string,unknown>,locale:Locale=defaultLocale){
  if(networkActionReason(context,kind,locale))return null;
  const adapter=currentNetworkAdapter(context.server,target);if(!adapter||params.interfaceIndex!==adapter.interfaceIndex)return null;
  const parsed=operations[kind].schema.safeParse(params);if(!parsed.success)return null;
  const p=parsed.data as Record<string,unknown>;
  const before=kind==='set-network'?translate(locale,'network.confirm.before',{value:adapter.dhcp?'DHCP':translate(locale,'management.static'),value2:adapter.addresses.map(ip=>`${ip.address}/${ip.prefixLength}`).join(', ')||EMPTY_VALUE,value3:adapter.gateway.join(', ')||EMPTY_VALUE}):`DNS: ${adapter.dns.join(', ')||EMPTY_VALUE}`;
  const after=kind==='set-network'?p.dhcp?'IPv4: DHCP':translate(locale,'network.confirm.after',{address:String(p.address),prefixLength:String(p.prefixLength),gateway:p.gateway?String(p.gateway):translate(locale,'management.noGateway')}):p.automatic?translate(locale,'network.confirm.dnsAutomatic'):`DNS: ${(p.servers as string[]).join(', ')}`;
  const warning=kind==='set-network'?translate(locale,'network.confirm.ipv4Warning'):translate(locale,'network.confirm.dnsWarning');
  return {title:kind==='set-network'?translate(locale,'network.confirm.ipv4Title'):translate(locale,'network.confirm.dnsTitle'),description:translate(locale,'network.confirm.description',{name:context.server.name,alias:adapter.alias,interfaceIndex:adapter.interfaceIndex,before,after,warning}),payload:{action:'job',id:context.server.id,kind,params:p,confirm:true},confirmLabel:translate(locale,kind==='set-network'?'management.network.change':'management.dns.change'),lines:confirmationDevice(context.server.name,locale)};
}
export function ipv4Subnet(address:string,prefix:number){
  const parts=address.split('.');
  if(parts.length!==4||parts.some(part=>!/^\d{1,3}$/.test(part)||Number(part)>255)||!Number.isInteger(prefix)||prefix<0||prefix>32)return null;
  const n=parts.reduce((value,part)=>(value*256+Number(part))>>>0,0),mask=prefix===0?0:(0xffffffff<<(32-prefix))>>>0;
  const dotted=(value:number)=>[24,16,8,0].map(shift=>(value>>>shift)&255).join('.');
  return {mask:dotted(mask),network:`${dotted((n&mask)>>>0)}/${prefix}`};
}
export const adapterStatus=(status:string,locale:Locale=defaultLocale)=>({Up:translate(locale,'network.status.up'),Disconnected:translate(locale,'network.status.disconnected'),Down:translate(locale,'network.status.disconnected'),Dormant:translate(locale,'network.status.dormant'),NotPresent:translate(locale,'network.status.notPresent'),LowerLayerDown:translate(locale,'network.status.lowerDown'),Testing:translate(locale,'network.status.testing'),Unknown:translate(locale,'services.unknown')} as Record<string,string>)[status]??(status||translate(locale,'services.unknown'));
export function networkIdentity(server:Server,adapter:NetworkAdapter){
  const addresses=new Set(adapter.addresses.map(ip=>ip.address));
  const matches=(server.snapshot?.networks??[]).filter(item=>item.addresses.some(address=>addresses.has(address.split('/')[0])));
  return matches.length===1?matches[0]:null;
}
