import {DNS_CHANGE_OPERATIONS,DNS_READ_OPERATIONS,type PluginReleaseSummary} from '@/lib/plugin-catalog';
import type {DnsSnapshot,DnsZoneRecords} from '@/lib/dns';

// The sample DNS server of SRV-DC01 (docs/dns-server.md): a domain controller
// with the AD zones corp.example (domain, secure updates, aging on),
// _msdcs.corp.example (forest) and 20.10.in-addr.arpa (domain), the secondary
// file zone partner.example, the zone TrustAnchors that Windows created, the
// conditional forwarder branch.example (forest), two forwarders and
// scavenging on, and the records of corp.example and the reverse zone. It
// passes dnsSnapshotSchema and dnsZoneRecordsSchema (lib/dns.ts); the device
// view and the fleet card show it in demo mode. Illustrative only, never sent
// to an agent.

export const demoDnsServerId='demo-dc';
const demoCapabilities=[...DNS_READ_OPERATIONS,...DNS_CHANGE_OPERATIONS];
/** The sample plugin release: DNS 1.0.2. */
export const demoDnsRelease=(time:number):PluginReleaseSummary=>({id:'demo-plugin-dns-1.0.2',name:'dns',target:'dns',version:'1.0.2',minAgentVersion:'4.21.2',capabilities:demoCapabilities,
 changelog:{features:['Reads and changes the DNS server of the device: zones, records, forwarders, conditional forwarders, aging and scavenging.'],fixes:[]},createdAt:time-3*86400000});
/** The plugin entry of SRV-DC01 in its heartbeat snapshot. */
export const demoDnsPlugin={name:'dns',target:'dns',version:'1.0.2',capabilities:demoCapabilities,state:'ready' as const,networkBlocked:true};
/** The DNS data of SRV-DC01 were read 4 minutes ago. */
export const demoDnsReadAt=(time:number)=>time-4*60_000;

type Zone=DnsSnapshot['zones'][number];
const base:Omit<Zone,'name'|'kind'|'lookup'|'storage'|'replicationScope'>={partition:null,fileName:null,dynamicUpdate:'secure',transfers:{mode:'none',servers:[]},notify:{mode:'off',servers:[]},masters:[],aging:null,forwarderTimeoutSeconds:null,paused:false,autoCreated:false,serial:null,recordCount:null};

export function demoDnsSnapshot(time:number):DnsSnapshot{
 const at=(ms:number)=>new Date(ms).toISOString();
 return {
  kind:'server',collectedAt:at(demoDnsReadAt(time)),service:'running',
  server:{name:'SRV-DC01.corp.example',domain:'corp.example',version:'10.0.20348',isDomainController:true,listenAddresses:['10.10.1.4','fe80::4']},
  forwarders:{servers:['9.9.9.9','1.1.1.1'],timeoutSeconds:3,useRootHints:true},
  scavenging:{enabled:true,intervalHours:168,lastRunAt:at(time-2*86400000),defaultAging:{enabled:true,noRefreshHours:168,refreshHours:168}},
  zones:[
   {...base,name:'corp.example',kind:'primary',lookup:'forward',storage:'ad',replicationScope:'domain',aging:{enabled:true,noRefreshHours:168,refreshHours:168},transfers:{mode:'nameServers',servers:[]},notify:{mode:'nameServers',servers:[]},serial:2026110901,recordCount:14},
   {...base,name:'_msdcs.corp.example',kind:'primary',lookup:'forward',storage:'ad',replicationScope:'forest',aging:{enabled:false,noRefreshHours:168,refreshHours:168},serial:2026110402,recordCount:9},
   {...base,name:'20.10.in-addr.arpa',kind:'primary',lookup:'reverse',storage:'ad',replicationScope:'domain',aging:{enabled:false,noRefreshHours:168,refreshHours:168},serial:2026103101,recordCount:5},
   {...base,name:'partner.example',kind:'secondary',lookup:'forward',storage:'file',replicationScope:null,fileName:'partner.example.dns',dynamicUpdate:'none',masters:['192.0.2.53','192.0.2.54'],serial:2026110701,recordCount:31},
   {...base,name:'trustanchors',kind:'primary',lookup:'forward',storage:'ad',replicationScope:'forest',dynamicUpdate:'none',autoCreated:true,serial:1,recordCount:2},
   {...base,name:'branch.example',kind:'forwarder',lookup:'forward',storage:'ad',replicationScope:'forest',dynamicUpdate:'none',masters:['10.40.0.10','10.40.0.11'],forwarderTimeoutSeconds:5},
  ],
  truncated:{zones:false},
 };
}

type Record=DnsZoneRecords['records'][number];
const record=(name:string,type:string,ttlSeconds:number,data:Record['data'],text:string,timestamp:string|null=null):Record=>({name,type,ttlSeconds,timestamp,data,text});
/** The stored records of a sample zone, or null for a zone without a sample read. */
export function demoDnsRecords(time:number,zone:string):DnsZoneRecords|null{
 const at=(ms:number)=>new Date(ms).toISOString(),read=at(demoDnsReadAt(time)),day=86400000;
 const soa=(serial:number)=>record('@','SOA',3600,{primaryServer:'srv-dc01.corp.example',responsiblePerson:'hostmaster.corp.example',serial,refreshSeconds:900,retrySeconds:600,expireSeconds:86400,minimumTtlSeconds:3600},
  `[${serial}], srv-dc01.corp.example., hostmaster.corp.example.`);
 const ns=record('@','NS',3600,{nameServer:'srv-dc01.corp.example'},'srv-dc01.corp.example.');
 if(zone==='corp.example'){
  const records=[
   soa(2026110901),ns,
   record('@','A',600,{address:'10.10.1.4'},'10.10.1.4',at(time-3*day)),
   record('srv-dc01','A',3600,{address:'10.10.1.4'},'10.10.1.4'),
   record('srv-dc01','AAAA',3600,{address:'fd00:10:10:1::4'},'fd00:10:10:1::4'),
   record('srv-app01','A',1200,{address:'10.10.1.12'},'10.10.1.12',at(time-1*day)),
   record('srv-sql01','A',1200,{address:'10.10.1.20'},'10.10.1.20',at(time-2*day)),
   record('intranet','CNAME',3600,{target:'srv-app01.corp.example'},'srv-app01.corp.example.'),
   record('@','MX',3600,{preference:10,exchange:'mail.corp.example'},'[10] mail.corp.example.'),
   record('mail','A',3600,{address:'10.10.1.25'},'10.10.1.25'),
   record('@','TXT',3600,{strings:['v=spf1 mx -all']},'"v=spf1 mx -all"'),
   record('_ldap._tcp','SRV',600,{priority:0,weight:100,port:389,target:'srv-dc01.corp.example'},'[0][100][389] srv-dc01.corp.example.'),
   record('_kerberos._tcp','SRV',600,{priority:0,weight:100,port:88,target:'srv-dc01.corp.example'},'[0][100][88] srv-dc01.corp.example.'),
   record('@','CAA',3600,{},'0 issue "letsencrypt.org"'),
  ];
  return {kind:'zone',zone,collectedAt:read,records,total:records.length,truncated:false};
 }
 if(zone==='20.10.in-addr.arpa'){
  const records=[
   soa(2026103101),ns,
   record('4.1','PTR',3600,{host:'srv-dc01.corp.example'},'srv-dc01.corp.example.'),
   record('12.1','PTR',1200,{host:'srv-app01.corp.example'},'srv-app01.corp.example.',at(time-1*day)),
   record('20.1','PTR',1200,{host:'srv-sql01.corp.example'},'srv-sql01.corp.example.',at(time-2*day)),
  ];
  return {kind:'zone',zone,collectedAt:read,records,total:records.length,truncated:false};
 }
 return null;
}

/** The stored DNS data of SRV-DC01 for the DNS alert rule: the service runs. */
export const demoDnsAlerts=(time:number)=>({service:'running' as const,collectedAt:demoDnsReadAt(time)});
