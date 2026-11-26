import {dhcpUsageSummary,type DhcpSnapshot} from '@/lib/dhcp';
import {DHCP_CHANGE_OPERATIONS,type PluginReleaseSummary} from '@/lib/plugin-catalog';
import type {DhcpAlertData} from '@/lib/types';
import {demoDnsRelease} from '@/ui/shell/demo-dns';

// The sample DHCP server of SRV-DC01 (docs/dhcp-server.md): three IPv4 scopes
// (Office 62 %, Wi-Fi Guests 93 %, Lab inactive), the superscope Campus, one
// IPv6 scope, exclusions, reservations, about 20 leases, server options, a
// server and a scope policy and one load-balance failover relationship. It
// passes dhcpSnapshotSchema (lib/dhcp.ts); the device view and the fleet card
// show it in demo mode. Illustrative only, never sent to an agent.

export const demoDhcpServerId='demo-dc';
const demoCapabilities=['dhcp-read',...DHCP_CHANGE_OPERATIONS];
/** The sample plugin releases: DHCP 1.1.0 and DNS 1.0.0 (ui/shell/demo-dns.ts). */
export const demoPluginReleases=(time:number):PluginReleaseSummary[]=>[{id:'demo-plugin-dhcp-1.1.0',name:'dhcp',target:'dhcp',version:'1.1.0',minAgentVersion:'4.16.0',capabilities:demoCapabilities,changelog:{features:['Changes the DHCP server of the device: scopes, superscopes, exclusions, reservations, leases, options, policies and failover.'],fixes:[]},createdAt:time-6*86400000},demoDnsRelease(time)];
/** The plugin entry of SRV-DC01 in its heartbeat snapshot. */
export const demoDhcpPlugin={name:'dhcp',target:'dhcp',version:'1.1.0',capabilities:demoCapabilities,state:'ready' as const,networkBlocked:true};
/** The stored DHCP data of SRV-DC01 for the DHCP alert rules, read 6 minutes ago. */
export function demoDhcpAlerts(time:number):DhcpAlertData{
 return {service:'running',collectedAt:time-6*60_000,scopes:dhcpUsageSummary(demoDhcpSnapshot(time)).filter(row=>row.family==='ipv4'&&row.total!==null).map(row=>({scopeId:row.scopeId,state:row.state,inUse:row.inUse,total:row.total!,percent:row.percent}))};
}

const option=(code:number,name:string,values:string[])=>({code,name,vendorClass:null,userClass:null,values});
const definition=(code:number,name:string,type:NonNullable<DhcpSnapshot['ipv4']['optionDefinitions']>[number]['type'],multiValued=false)=>({code,name,type,multiValued,vendorClass:null});
const lease=(address:string,scope:string,name:string|null,clientId:string,expires:number|null,state:DhcpSnapshot['leases']['items'][number]['state']='active',family:'ipv4'|'ipv6'='ipv4')=>({family,address,scope,name,clientId,expiresAt:expires===null?null:new Date(expires).toISOString(),state});

export function demoDhcpSnapshot(time:number):DhcpSnapshot{
 const hour=3600000,day=24*hour;
 const offices=['pc-anna','pc-ben','pc-carla','pc-dirk','pc-eva','pc-frank','pc-greta','pc-hans','pc-ines','pc-jan','pc-kim','pc-lena'];
 const leases=[
  ...offices.map((name,index)=>lease(`10.10.0.${101+index}`,'10.10.0.0',`${name}.corp.example`,`00-15-5d-0a-01-${(16+index).toString(16)}`,time+(index+1)*5*hour)),
  lease('10.10.0.20','10.10.0.0','printer-2og.corp.example','00-1b-a9-4c-22-10',null,'reserved'),
  lease('10.10.0.21','10.10.0.0','scanner-empfang.corp.example','00-1b-a9-4c-22-11',null,'reserved'),
  lease('10.20.0.15','10.20.0.0','guest-phone-01','a4-83-e7-12-34-56',time+3*hour),
  lease('10.20.0.16','10.20.0.0','guest-laptop-07','f0-18-98-aa-bb-01',time+2*hour),
  lease('10.20.0.17','10.20.0.0',null,'f0-18-98-aa-bb-02',time-2*hour,'expired'),
  lease('10.20.0.18','10.20.0.0','guest-tablet-03','3c-22-fb-9e-00-11',time+5*hour),
  lease('10.20.0.19','10.20.0.0',null,'00-00-00-00-00-00',time+day,'declined'),
  lease('2001:db8:10::1a','2001:db8:10::','pc-anna.corp.example','00-01-00-01-2c-3d-4e-5f-00-15-5d-0a-01-10',time+8*day,'active','ipv6'),
 ];
 return {
  schema:1,service:'running',
  server:{name:'SRV-DC01.corp.example',authorization:'authorized',domain:'corp.example'},
  ipv4:{
   scopes:[
    {id:'10.10.0.0',name:'Office',description:'Wired clients of the head office',subnetMask:'255.255.255.0',startRange:'10.10.0.10',endRange:'10.10.0.209',state:'active',leaseDurationSeconds:691200,type:'dhcp',superscope:'Campus',failover:'DC01-DC02',
     usage:{total:200,inUse:124,free:76,reserved:2,percent:62},
     exclusions:[{start:'10.10.0.10',end:'10.10.0.19'}],
     reservations:[
      {address:'10.10.0.20',name:'printer-2og.corp.example',clientId:'00-1b-a9-4c-22-10',type:'both',description:'Printer, 2nd floor'},
      {address:'10.10.0.21',name:'scanner-empfang.corp.example',clientId:'00-1b-a9-4c-22-11',type:'dhcp',description:'Scanner at the reception'},
     ],
     options:[option(3,'Router',['10.10.0.1']),option(6,'DNS Servers',['10.10.1.4','10.10.1.5']),option(15,'DNS Domain Name',['corp.example'])],
     policies:[{name:'IP phones',scopeId:'10.10.0.0',order:1,enabled:true,condition:'or',criteria:[{type:'mac',operator:'equals',values:['00-15-5D*','00-1D-D8*']}],ranges:[{start:'10.10.0.180',end:'10.10.0.199'}],leaseDurationSeconds:null,description:'Phones get their own range.',options:[option(66,'Boot Server Host Name',['voip.corp.example'])]}]},
    {id:'10.20.0.0',name:'Wi-Fi Guests',description:'Guest network, internet only',subnetMask:'255.255.255.0',startRange:'10.20.0.10',endRange:'10.20.0.109',state:'active',leaseDurationSeconds:28800,type:'dhcp',superscope:'Campus',failover:'DC01-DC02',
     usage:{total:100,inUse:93,free:7,reserved:2,percent:93},
     exclusions:[{start:'10.20.0.100',end:'10.20.0.109'}],
     reservations:[
      {address:'10.20.0.11',name:'ap-lobby',clientId:'b4-fb-e4-11-22-01',type:'dhcp',description:'Access point, lobby'},
      {address:'10.20.0.12',name:'ap-cafeteria',clientId:'b4-fb-e4-11-22-02',type:'dhcp',description:'Access point, cafeteria'},
     ],
     options:[option(3,'Router',['10.20.0.1']),option(6,'DNS Servers',['10.20.0.1'])],policies:[]},
    {id:'10.30.0.0',name:'Lab',description:'Test lab, switched off between projects',subnetMask:'255.255.255.0',startRange:'10.30.0.10',endRange:'10.30.0.59',state:'inactive',leaseDurationSeconds:null,type:'both',superscope:null,failover:null,
     usage:{total:50,inUse:0,free:50,reserved:0,percent:0},exclusions:[],reservations:[],options:[option(3,'Router',['10.30.0.1'])],policies:[]},
   ],
   superscopes:[{name:'Campus',scopeIds:['10.10.0.0','10.20.0.0']}],
   serverOptions:[option(3,'Router',['10.10.0.1']),option(6,'DNS Servers',['10.10.1.4','10.10.1.5']),option(15,'DNS Domain Name',['corp.example']),option(51,'Lease',['691200'])],
   policies:[{name:'Printers',scopeId:null,order:1,enabled:true,condition:'and',criteria:[{type:'vendorClass',operator:'equals',values:['HP Printer']}],ranges:[],leaseDurationSeconds:null,description:'Long leases for printers.'}],
   failover:[{name:'DC01-DC02',partner:'SRV-DC02.corp.example',mode:'loadBalance',serverRole:null,loadBalancePercent:50,reservePercent:null,state:'normal',mcltSeconds:3600,autoStateTransition:true,stateSwitchIntervalSeconds:3600,scopeIds:['10.10.0.0','10.20.0.0'],messageAuthentication:true}],
   optionDefinitions:[definition(3,'Router','ipAddress',true),definition(6,'DNS Servers','ipAddress',true),definition(15,'DNS Domain Name','string'),definition(42,'NTP Servers','ipAddress',true),definition(44,'WINS/NBNS Servers','ipAddress',true),definition(51,'Lease','dword'),definition(66,'Boot Server Host Name','string'),definition(67,'Bootfile Name','string')],
  },
  ipv6:{
   scopes:[{prefix:'2001:db8:10::',name:'Office IPv6',description:'Stateful addresses for the head office',state:'active',preference:0,preferredLifetimeSeconds:691200,validLifetimeSeconds:1036800,
    usage:{inUse:1,free:4294967295,percent:0},exclusions:[],reservations:[],options:[option(23,'DNS Recursive Name Server IPv6 Address List',['2001:db8:10::4'])]}],
   serverOptions:[option(23,'DNS Recursive Name Server IPv6 Address List',['2001:db8:10::4','2001:db8:10::5'])],
   optionDefinitions:[definition(23,'DNS Recursive Name Server IPv6 Address List','ipv6Address',true),definition(24,'Domain Search List','string')],
  },
  leases:{items:leases,total:leases.length,truncated:false},
  truncated:{reservations:false,leases:false},
 };
}
