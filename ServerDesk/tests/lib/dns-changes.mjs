// The DNS changes of plugin 1.0.0 without a database (lib/dns-changes.ts,
// lib/dns.ts, docs/dns-server.md "Change the DNS server"): one strict schema
// per operation with good, unknown-key, out-of-bound and oversized input, every
// validation code against the sample server and its records, the reverse zone
// names (the same vectors as the plugin's self-test), the confirmation
// sentences per scope and operation, the order of the manage gate, the job
// requirements and labels of the 16 operations, the plugin policy and the KPIs.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const changes=await import('../../lib/dns-changes.ts');
const dns=await import('../../lib/dns.ts');
const {demoDnsSnapshot,demoDnsRecords,demoDnsPlugin}=await import('../../ui/shell/demo-dns.ts');
const {jobRequirements,jobViewRequirements,jobParametersFromTarget}=await import('../../lib/jobs/requirements.ts');
const {pluginOperations,pluginCollectionPolicy,DNS_CHANGE_OPERATIONS,DNS_READ_OPERATIONS}=await import('../../lib/plugin-catalog.ts');
const {pluginOperationNeedsAccount,pluginManagePermission}=await import('../../lib/plugin-ad.ts');
const {pluginJobLabelKey}=await import('../../lib/job-display.ts');
const {translate}=await import('../../lib/i18n/translate.ts');
const {dnsChangeSchemas,validateDnsChange,dnsReverseZoneName,dnsChangeDescription,dnsManageBlocked,dnsChangeObject,normalizeDnsChange,dnsRecordKey,DNS_JOB_PARAMETER_LIMIT,dnsErrorKeys}=changes;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const now=Date.UTC(2026,10,9,12),snapshot=demoDnsSnapshot(now),corp=demoDnsRecords(now,'corp.example'),reverse=demoDnsRecords(now,'20.10.in-addr.arpa');
const codes=(operation,parameters,records=null,base=snapshot)=>{const result=validateDnsChange(operation,parameters,base,records);return result.ok?[]:result.errors.map(error=>`${error.field}:${error.code}`);};

// ---- The operations, their requirements and labels ---------------------------------------------
check([...DNS_READ_OPERATIONS],['dns-read','dns-zone-read'],'two reads');
check(DNS_CHANGE_OPERATIONS.length,14,'14 changes');
for(const operation of DNS_READ_OPERATIONS){
 check(pluginOperations[operation],{plugin:'dns',permission:'dns.read',readOnly:true},`${operation}: dns.read, a read`);
 const required=jobRequirements('plugin-job',{plugin:'dns',operation});
 check([required.known,required.permissions,required.managementMode,required.mfa,required.capabilities],[true,['dns.read'],false,false,['plugin-host']],`${operation}: no Management mode, no MFA`);
 check(pluginOperationNeedsAccount(operation),false,`${operation} runs as SYSTEM without an AD sign-in`);
}
for(const operation of DNS_CHANGE_OPERATIONS){
 check(pluginOperations[operation],{plugin:'dns',permission:'dns.manage',readOnly:false},`${operation}: dns.manage, a change`);
 const required=jobRequirements('plugin-job',{plugin:'dns',operation});
 check([required.known,required.permissions,required.managementMode,required.mfa,required.capabilities],[true,['dns.manage'],true,true,['plugin-host']],`${operation}: Management mode, MFA, plugin-host`);
 check(jobViewRequirements('plugin-job',{},{target:operation}).permissions,['dns.manage'],`${operation}: a finished job keeps dns.manage through its target`);
 check(jobParametersFromTarget('plugin-job',operation),{plugin:'dns',operation},`${operation}: the target names the plugin`);
 check(pluginOperationNeedsAccount(operation),true,`${operation} needs the AD sign-in`);
 check(Object.hasOwn(dnsChangeSchemas,operation),true,`${operation} has a schema`);
}
check(jobRequirements('plugin-job',{plugin:'dhcp',operation:'dns-read'}).known,false,'a DNS operation under another plugin is unknown');
check(pluginManagePermission('dns'),'dns.manage','the AD sign-in of the DNS plugin needs dns.manage');
const english=operation=>translate('en',pluginJobLabelKey('plugin-job',operation));
check(['dns-read','dns-zone-read','dns-zone-create','dns-record-delete','dns-conditional-edit','dns-forwarders-set','dns-cache-clear'].map(english),['Read DNS server','Read DNS zone','Create DNS zone','Delete DNS records','Edit conditional forwarder','Set DNS forwarders','Clear DNS cache'],'the English job labels (also the audit actions)');
check(translate('de',pluginJobLabelKey('plugin-job','dns-scavenge-now')),'DNS-Einträge aufräumen','the German job label');
check(DNS_CHANGE_OPERATIONS.every(operation=>pluginJobLabelKey('plugin-job',operation)?.startsWith('jobs.kind.dns.')&&translate('en',pluginJobLabelKey('plugin-job',operation))!==pluginJobLabelKey('plugin-job',operation)),true,'every change has a catalog label');

// ---- The plugin policy -----------------------------------------------------------------------------
const plugins=list=>({plugins:list});
check(pluginCollectionPolicy(plugins([demoDnsPlugin])),{collect:[{plugin:'dns',operation:'dns-read',intervalSeconds:900}]},'the DNS server read every 15 minutes');
check(pluginCollectionPolicy(plugins([{name:'dhcp',role:'dhcp',version:'1.1.0',capabilities:['dhcp-read'],state:'ready',networkBlocked:true},demoDnsPlugin])).collect.map(entry=>entry.operation),['dhcp-read','dns-read'],'DHCP and DNS next to each other');
check(pluginCollectionPolicy(plugins([{...demoDnsPlugin,state:'damaged'}])),{collect:[]},'a damaged plugin collects nothing');
check(pluginCollectionPolicy(plugins([{...demoDnsPlugin,capabilities:['dns-zone-read']}])),{collect:[]},'dns-zone-read is never periodic');

// ---- The read schemas and the sample ------------------------------------------------------------------
check(dns.dnsSnapshotSchema.safeParse(snapshot).success,true,'the sample server passes the schema');
check([corp,reverse].every(item=>dns.dnsZoneRecordsSchema.safeParse(item).success),true,'the sample records pass the schema');
check(dns.dnsSnapshotSchema.safeParse({...snapshot,extra:1}).success,false,'the server schema is strict');
check(dns.dnsSnapshotSchema.safeParse({...snapshot,zones:[{...snapshot.zones[0],name:'Corp.Example'}]}).success,false,'zone names are stored lower case');
check(dns.dnsZoneRecordsSchema.safeParse({...corp,records:[{...corp.records[2],data:{address:'10.0.0.1',extra:1}}]}).success,false,'record data are typed per type');
check(dns.dnsZoneRecordsSchema.safeParse({...corp,records:[{...corp.records[0],type:'CAA',data:{}}]}).success,true,'another type has {} as data');
check(dns.dnsKpis(snapshot),{zones:5,forward:4,reverse:1,ad:4,records:30,forwarders:2,useRootHints:true,scavenging:true,intervalHours:168},'the KPIs of the sample: zones without the conditional forwarder');
check(dns.dnsZoneSummary(snapshot).map(zone=>zone.name),snapshot.zones.map(zone=>zone.name),'the summary lists every zone');
check(dns.dnsFleetRows('demo-dc',dns.dnsZoneSummary(snapshot),1).map(row=>row.zone),['corp.example','_msdcs.corp.example','20.10.in-addr.arpa','partner.example','branch.example'],'the fleet rows leave out the zones Windows created');
check(dns.filterDnsZones(dns.dnsZones(snapshot),{query:'CORP',lookup:'forward'}).map(zone=>zone.name),['corp.example','_msdcs.corp.example'],'the zone filter: name and lookup');
check(dns.filterDnsRecords(corp.records,{query:'',type:'other'}).map(record=>record.type),['CAA'],'the record filter: other types');
check(dns.filterDnsRecords(corp.records,{query:'srv-app',type:''}).length,2,'the record search covers name and data');

// ---- The schemas: good input, unknown keys, bounds, oversize ---------------------------------------------
const good={
 'dns-zone-create':{kind:'primary',lookup:'forward',name:'lab.corp.example',storage:'ad',replicationScope:'domain',fileName:null,masters:[],dynamicUpdate:'secure'},
 'dns-zone-edit':{zone:'corp.example',transfers:{mode:'list',servers:['10.0.0.2']}},
 'dns-zone-delete':{zone:'corp.example'},
 'dns-zone-transfer':{zone:'partner.example'},
 'dns-record-add':{zone:'corp.example',name:'www',type:'A',ttlSeconds:3600,ageRecord:false,data:{address:'10.10.1.80'}},
 'dns-record-edit':{zone:'corp.example',record:{name:'srv-app01',type:'A',data:{address:'10.10.1.12'}},data:{address:'10.10.1.13'}},
 'dns-record-delete':{zone:'corp.example',records:[{name:'intranet',type:'CNAME',data:{target:'srv-app01.corp.example'}}]},
 'dns-conditional-create':{name:'other.example',masters:['10.50.0.10'],storage:'ad',replicationScope:'forest',timeoutSeconds:5},
 'dns-conditional-edit':{name:'branch.example',timeoutSeconds:7},
 'dns-conditional-delete':{name:'branch.example'},
 'dns-forwarders-set':{servers:['9.9.9.9','2620:fe::fe'],timeoutSeconds:3,useRootHints:false},
 'dns-scavenging-set':{enabled:true,intervalHours:168,defaultAging:{enabled:true,noRefreshHours:168,refreshHours:168},applyToAdZones:true},
 'dns-scavenge-now':{},
 'dns-cache-clear':{},
};
check(Object.keys(good).sort(),[...DNS_CHANGE_OPERATIONS].sort(),'a sample per operation');
for(const [operation,parameters] of Object.entries(good)){
 check(dnsChangeSchemas[operation].safeParse(parameters).success,true,`${operation}: the schema takes a good input`);
 check(dnsChangeSchemas[operation].safeParse({...parameters,extra:1}).success,false,`${operation}: an unknown key is refused`);
 const records=changes.DNS_RECORD_OPERATIONS.has(operation)?corp:null;
 check(codes(operation,parameters,records),[],`${operation}: the sample is valid against the sample server`);
}
check(dnsChangeSchemas['dns-conditional-create'].parse({name:'x.example',masters:['10.0.0.1'],storage:'file',replicationScope:null}).timeoutSeconds,5,'the conditional forwarder timeout defaults to 5 seconds');
const bounds=[
 ['dns-record-add',{...good['dns-record-add'],ttlSeconds:2147483648},'ttlSeconds:number'],
 ['dns-record-add',{...good['dns-record-add'],type:'MX',data:{preference:65536,exchange:'mail.corp.example'}},'preference:number'],
 ['dns-record-add',{...good['dns-record-add'],type:'SRV',data:{priority:0,weight:-1,port:1,target:'x.corp.example'}},'weight:number'],
 ['dns-record-add',{...good['dns-record-add'],type:'TXT',data:{strings:Array(17).fill('a')}},'strings:text'],
 ['dns-record-add',{...good['dns-record-add'],type:'TXT',data:{strings:['a'.repeat(256)]}},'strings:text'],
 ['dns-record-add',{...good['dns-record-add'],type:'SOA',data:{}},'type:invalid'],
 ['dns-record-delete',{zone:'corp.example',records:[]},'records:invalid'],
 ['dns-record-delete',{zone:'corp.example',records:Array(101).fill(good['dns-record-delete'].records[0])},'records:invalid'],
 ['dns-forwarders-set',{...good['dns-forwarders-set'],timeoutSeconds:16},'timeoutSeconds:number'],
 ['dns-forwarders-set',{...good['dns-forwarders-set'],servers:Array(17).fill('10.0.0.1')},'servers:invalid'],
 ['dns-conditional-create',{...good['dns-conditional-create'],masters:[]},'masters:mastersRequired'],
 ['dns-scavenging-set',{...good['dns-scavenging-set'],intervalHours:8761},'intervalHours:number'],
 ['dns-scavenging-set',{...good['dns-scavenging-set'],defaultAging:{enabled:true,noRefreshHours:0,refreshHours:1}},'noRefreshHours:number'],
 ['dns-zone-edit',{zone:'corp.example',aging:{enabled:true,noRefreshHours:168,refreshHours:9000}},'refreshHours:number'],
 ['dns-zone-create',{...good['dns-zone-create'],masters:Array(17).fill('10.0.0.1')},'masters:invalid'],
];
for(const [operation,parameters,code] of bounds)check(codes(operation,parameters,corp)[0],code,`${operation}: ${code}`);
check(codes('dns-record-add',{...good['dns-record-add'],data:{address:'10.0.0.1'},name:'x'.repeat(DNS_JOB_PARAMETER_LIMIT)},corp),['parameters:tooLarge'],'more than 48 KiB is refused');
check(Object.values(dnsErrorKeys).every(key=>translate('en',key)!==key&&translate('de',key)!==key),true,'every code has a text in both catalogs');

// ---- Validation codes against the sample --------------------------------------------------------------
const zone=(over)=>({...good['dns-zone-create'],...over});
check(codes('dns-zone-create',zone({name:'bad name.example'})),['name:name'],'a bad zone name');
check(codes('dns-zone-create',zone({name:'Corp.Example.'})),['name:zoneExists'],'an existing zone (case and trailing dot)');
check(validateDnsChange('dns-zone-create',zone({name:'corp.example'}),snapshot,null).errors[0].params,{zone:'corp.example'},'zoneExists names the zone');
check(codes('dns-zone-create',zone({name:'branch.example'})),['name:zoneExists'],'a conditional forwarder name is taken too');
const notDc={...snapshot,server:{...snapshot.server,isDomainController:false}};
check(codes('dns-zone-create',zone({}),null,notDc),['storage:notDc'],'AD on a server that is no domain controller');
check(codes('dns-zone-create',zone({kind:'secondary',masters:['192.0.2.1'],dynamicUpdate:'none'})),['storage:secondaryAd'],'a secondary zone in AD');
check(codes('dns-zone-create',zone({storage:'file',replicationScope:null})),['dynamicUpdate:secureNeedsAd'],'secure updates without AD');
check(codes('dns-zone-create',zone({replicationScope:null})),['replicationScope:scopeRequired'],'AD without a replication scope');
check(codes('dns-zone-create',zone({storage:'file',replicationScope:'domain',dynamicUpdate:'none'})),['replicationScope:invalid'],'a file zone with a replication scope');
check(codes('dns-zone-create',zone({fileName:'x.dns'})),['fileName:invalid'],'a file name with AD');
check(codes('dns-zone-create',zone({kind:'secondary',storage:'file',replicationScope:null,masters:[],dynamicUpdate:'none'})),['masters:mastersRequired'],'a secondary zone without masters');
check(codes('dns-zone-create',zone({kind:'stub',storage:'file',replicationScope:null,masters:['10.0.0.1','10.0.0.1'],dynamicUpdate:'none'})),['masters:duplicateAddress'],'a master twice');
check(codes('dns-zone-create',zone({kind:'stub',storage:'file',replicationScope:null,masters:['10.0.0.300'],dynamicUpdate:'none'})),['masters:address'],'a master that is no address');
check(codes('dns-zone-create',{...zone({lookup:'reverse',networkId:'10.30'}),name:undefined}),[],'a new reverse zone by its network ID');
check(codes('dns-zone-create',{...zone({lookup:'reverse',networkId:'10.20'}),name:undefined}),['networkId:zoneExists'],'the reverse zone of 10.20 exists');
check(codes('dns-zone-create',{...zone({lookup:'reverse',networkId:'10.20.30.40'}),name:undefined}),['networkId:networkId'],'a network ID with 4 octets');
// Edits and deletes: the object and its kind.
check(codes('dns-zone-edit',{zone:'gone.example',dynamicUpdate:'none'}),['zone:zoneMissing'],'a zone that is gone');
check(codes('dns-zone-edit',{zone:'branch.example',dynamicUpdate:'none'}),['zone:kind'],'a conditional forwarder is no zone');
check(codes('dns-zone-edit',{zone:'corp.example'}),['zone:unchanged'],'an edit without a change');
check(codes('dns-zone-edit',{zone:'partner.example',dynamicUpdate:'nonsecureAndSecure'}),['dynamicUpdate:kind'],'dynamic updates only on a primary zone');
check(codes('dns-zone-edit',{zone:'corp.example',masters:['10.0.0.1']}),['masters:kind'],'masters only on a secondary or stub zone');
check(codes('dns-zone-edit',{zone:'partner.example',masters:['192.0.2.53','192.0.2.99']}),[],'new masters of the secondary zone');
check(codes('dns-zone-edit',{zone:'corp.example',transfers:{mode:'list',servers:[]}}),['transfersServers:serversRequired'],'a transfer list without servers');
check(codes('dns-zone-edit',{zone:'corp.example',storage:'file'}),['storage:secureNeedsAd'],'moving a secure zone to a file');
check(codes('dns-zone-edit',{zone:'corp.example',storage:'file',dynamicUpdate:'none'}),[],'a file with nonsecure updates');
check(codes('dns-zone-edit',{zone:'corp.example',replicationScope:'forest'}),[],'a new replication scope');
check(codes('dns-zone-edit',{zone:'partner.example',storage:'ad',replicationScope:'domain'}),['storage:secondaryAd'],'a secondary zone stays a file');
check(codes('dns-zone-transfer',{zone:'corp.example'}),['zone:kind'],'a primary zone has no primary server to transfer from');
check(codes('dns-zone-delete',{zone:'branch.example'}),['zone:kind'],'the zone delete refuses a conditional forwarder');
check(codes('dns-conditional-delete',{name:'corp.example'}),['name:kind'],'the conditional delete refuses a zone');
check(codes('dns-conditional-edit',{name:'branch.example'}),['name:unchanged'],'a conditional edit without a change');
check(codes('dns-conditional-create',{...good['dns-conditional-create'],storage:'ad',replicationScope:'forest'},null,notDc),['storage:notDc'],'a conditional forwarder in AD needs a domain controller');
// Records.
const add=(over)=>({...good['dns-record-add'],...over});
check(codes('dns-record-add',add({}),null),['zone:recordsNotRead'],'records not read');
check(codes('dns-record-add',add({}),reverse),['zone:recordsNotRead'],'the records of another zone');
check(codes('dns-record-add',add({zone:'partner.example'}),corp),['zone:secondary'],'records change only in primary zones');
check(codes('dns-record-add',add({name:'a b'}),corp),['name:recordName'],'a bad record name');
check(codes('dns-record-add',add({name:'*.lab'}),corp),[],'a wildcard name');
check(codes('dns-record-add',add({name:'srv-app01',data:{address:'10.10.1.12'}}),corp),['name:duplicate'],'a duplicate');
check(codes('dns-record-add',add({name:'SRV-APP01.',data:{address:'10.10.1.12'}}),corp),['name:duplicate'],'a duplicate in other case and with a trailing dot');
check(codes('dns-record-add',add({name:'intranet'}),corp),['name:cnameTaken'],'no other record on a CNAME name');
check(validateDnsChange('dns-record-add',add({name:'intranet'}),snapshot,corp).errors[0].params,{name:'intranet'},'cnameTaken names the name');
check(codes('dns-record-add',add({name:'mail',type:'CNAME',data:{target:'web.corp.example'}}),corp),['name:cname'],'a CNAME on a name with records');
check(codes('dns-record-add',add({name:'1.1',type:'PTR',data:{host:'x.corp.example'}}),corp),['type:ptrReverse'],'PTR outside a reverse zone');
check(codes('dns-record-add',{...add({zone:'20.10.in-addr.arpa',name:'30.1',type:'PTR',data:{host:'srv-x.corp.example'}})},reverse),[],'PTR in the reverse zone');
check(codes('dns-record-add',add({data:{address:'2001:db8::1'}}),corp),['address:ipv4'],'A needs IPv4');
check(codes('dns-record-add',add({type:'AAAA',data:{address:'10.0.0.1'}}),corp),['address:ipv6'],'AAAA needs IPv6');
check(codes('dns-record-add',add({type:'MX',data:{preference:10,exchange:'mail'}}),corp),['exchange:fqdn'],'targets are full host names');
check(codes('dns-record-add',add({name:'_x._tcp',type:'SRV',data:{priority:0,weight:0,port:0,target:'.'}}),corp),[],'SRV takes "." as target');
check(codes('dns-record-edit',{...good['dns-record-edit'],record:{name:'gone',type:'A',data:{address:'10.0.0.1'}}},corp),['record:missing'],'an edited record that is gone');
check(codes('dns-record-edit',{zone:'corp.example',record:{name:'@',type:'SOA',data:corp.records[0].data},ttlSeconds:60},corp),['record:soa'],'SOA can never change');
check(codes('dns-record-edit',{zone:'corp.example',record:{name:'@',type:'CAA',data:{}},ttlSeconds:60},corp),['record:otherType'],'other types change with the DNS Manager');
check(codes('dns-record-edit',{...good['dns-record-edit'],data:{address:'10.10.1.20'}},corp),[],'an edit onto another record of another name is no duplicate');
check([codes('dns-record-edit',{...good['dns-record-edit'],data:{address:5}},corp),codes('dns-record-edit',{...good['dns-record-edit'],data:{address:'10.10.1.30',extra:1}},corp)],[['address:invalid'],['data:invalid']],'a bad edited data field is named by its field below data, an unknown data key by data');
check(codes('dns-record-edit',{zone:'corp.example',record:{name:'@',type:'A',data:{address:'10.10.1.4'}},data:{address:'10.10.1.4'},ttlSeconds:60},corp),[],'a TTL change keeps the data');
check(codes('dns-record-edit',{zone:'corp.example',record:{name:'srv-app01',type:'A',data:{address:'10.10.1.12'}}},corp),['record:unchanged'],'an edit without a change');
check(codes('dns-record-delete',{zone:'corp.example',records:[{name:'@',type:'NS',data:{nameServer:'srv-dc01.corp.example'}}]},corp),['records:lastNs'],'the last apex NS stays');
check(codes('dns-record-delete',{zone:'corp.example',records:[{name:'nope',type:'A',data:{address:'10.0.0.9'}}]},corp),['records:missing'],'a deleted record that is gone');
check(codes('dns-forwarders-set',{...good['dns-forwarders-set'],servers:['9.9.9.9','9.9.9.9']}),['servers:duplicateAddress'],'a forwarder twice');
check(codes('dns-forwarders-set',{...good['dns-forwarders-set'],servers:['dns.example']}),['servers:address'],'a forwarder that is no address');
check(codes('dns-scavenge-now',{},null,{...snapshot,scavenging:{...snapshot.scavenging,enabled:false}}),['scavenging:scavengingOff'],'scavenging now needs scavenging on');

// ---- Normalization, identity and the object --------------------------------------------------------------
check(normalizeDnsChange('dns-record-add',{zone:'Corp.Example.',name:'WWW.',type:'AAAA',ttlSeconds:null,ageRecord:false,data:{address:'2001:0DB8::0010'}}),{zone:'corp.example',name:'www',type:'AAAA',ttlSeconds:null,ageRecord:false,data:{address:'2001:db8::10'}},'names lower case without the dot, IPv6 compressed');
check(normalizeDnsChange('dns-zone-create',{...zone({lookup:'reverse',networkId:'10.30',storage:'file',replicationScope:null,dynamicUpdate:'none'}),name:undefined}).name,'30.10.in-addr.arpa','the reverse zone name goes to the job');
check(normalizeDnsChange('dns-zone-create',zone({storage:'file',replicationScope:null,dynamicUpdate:'none'})).fileName,'lab.corp.example.dns','a file zone gets <zone>.dns');
check(dnsRecordKey({name:'Intranet',type:'cname',data:{target:'SRV-APP01.corp.example.'}}),dnsRecordKey(corp.records[7]),'the identity ignores case and the trailing dot');
check(['dns-zone-delete','dns-record-add','dns-record-delete','dns-conditional-edit','dns-forwarders-set','dns-scavenging-set','dns-cache-clear'].map(operation=>dnsChangeObject(operation,{...good[operation]})),
 ['corp.example','corp.example / www A','corp.example / intranet CNAME','branch.example','Forwarders','Scavenging','Cache'],'the object of the confirmation and the audit');

// ---- Reverse zone names: the plugin's vectors ---------------------------------------------------------------
const selfTests=await readFile(new URL('../../agent/plugins/dns/DnsSelfTests.cs',import.meta.url),'utf8');
const vectors=[...selfTests.matchAll(/^\s*\("([^"]*)", (?:"([^"]+)"|null)\),$/gm)].map(match=>[match[1],match[2]??null]);
check(vectors.length>=14,true,'the plugin lists its reverse vectors');
for(const [input,expected] of vectors)check(dnsReverseZoneName(input),expected,`reverse zone of "${input}" as in the plugin`);
check([dnsReverseZoneName('10.20.30'),dnsReverseZoneName('2001:db8:1::/48'),dnsReverseZoneName('2001:db8::/31')],['30.20.10.in-addr.arpa','1.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa',null],'IPv4 octets, IPv6 nibbles, a length that is no multiple of 4');

// ---- The confirmation sentences ---------------------------------------------------------------------------
const keys=(operation,parameters,base=snapshot)=>dnsChangeDescription(operation,parameters,base,'SRV-DC01').map(sentence=>sentence.key);
check(dnsChangeDescription('dns-record-add',good['dns-record-add'],snapshot,'SRV-DC01'),[{key:'dns.confirm.adDomain',params:{object:'corp.example'}}],'a record of a domain-wide AD zone');
check(keys('dns-zone-edit',{zone:'_msdcs.corp.example',dynamicUpdate:'secure'}),['dns.confirm.adForest'],'a forest-wide zone');
check(keys('dns-zone-create',zone({replicationScope:'legacy'})),['dns.confirm.adLegacy'],'a new zone on all domain controllers');
const custom={...snapshot,zones:snapshot.zones.map(item=>item.name==='corp.example'?{...item,replicationScope:'custom',partition:'Branch.Partition'}:item)};
check(dnsChangeDescription('dns-zone-delete',{zone:'corp.example'},custom,'SRV-DC01'),[{key:'dns.confirm.adCustom',params:{object:'corp.example',partition:'Branch.Partition'}},{key:'dns.confirm.zoneDelete'}],'a custom partition and the delete sentence');
check(keys('dns-zone-transfer',{zone:'partner.example'}),['dns.confirm.local','dns.confirm.transfer'],'a file zone applies only here');
check(keys('dns-conditional-delete',{name:'branch.example'}),['dns.confirm.adForest','dns.confirm.zoneDelete'],'a conditional forwarder in AD');
check(dnsChangeDescription('dns-record-delete',{zone:'corp.example',records:[{},{}]},snapshot,'SRV-DC01')[1],{key:'dns.confirm.recordDelete',params:{count:2}},'the record count');
check(keys('dns-forwarders-set',good['dns-forwarders-set']),['dns.confirm.local'],'forwarders apply only to this server');
check(keys('dns-cache-clear',{}),['dns.confirm.local','dns.confirm.cacheClear'],'the cache');
check(keys('dns-scavenge-now',{}),['dns.confirm.local','dns.confirm.scavengeNow'],'scavenge now');
check(keys('dns-scavenging-set',good['dns-scavenging-set']),['dns.confirm.local','dns.confirm.applyAd'],'scavenging that also ages the AD zones');
check(translate('en','dns.confirm.adDomain',{object:'corp.example'}),'corp.example is stored in Active Directory. The change replicates to all DNS servers in the domain.','the English sentence');
check(translate('de','dns.confirm.recordDelete',{count:1}),'1 Eintrag wird gelöscht.','the German singular');

// ---- The manage gate: the first reason in order --------------------------------------------------------------
const device={permissions:['dns.manage'],lastSeen:now,management:1,snapshot:{mode:'Management',agentCapabilities:['plugin-host','plugin-ad-identity'],plugins:[demoDnsPlugin]}};
const data={snapshot};
const blocked=(over={},viewer={permissions:[]},demo=false,given=data)=>dnsManageBlocked({...device,...over,snapshot:{...device.snapshot,...(over.snapshot??{})}},viewer,demo,now,given);
check(blocked({},{permissions:[]},true),'kit.unavailable.demo','1. demo');
check(blocked({permissions:['dns.read']}),'dns.blocked.manageRight','2. no dns.manage');
check(blocked({permissions:['dns.read'],lastSeen:now-3600_000}),'dns.blocked.manageRight','the right before offline');
check(blocked({lastSeen:now-3600_000}),'extensions.blocked.offline','3. offline');
check(blocked({lastSeen:now-3600_000,snapshot:{plugins:[]}}),'extensions.blocked.offline','offline before the plugin');
check(blocked({snapshot:{plugins:[{...demoDnsPlugin,capabilities:['dns-read']}]}}),'dns.blocked.plugin','4. the plugin lacks the operation');
check(blocked({snapshot:{plugins:[],agentCapabilities:['plugin-host']}}),'dns.blocked.plugin','the plugin before the agent');
check(blocked({snapshot:{agentCapabilities:['plugin-host']}}),'pluginAd.blocked.agent','5. an agent without the AD identity');
check(blocked({snapshot:{agentCapabilities:['plugin-host'],mode:'ReadOnly'}}),'pluginAd.blocked.agent','the agent before ReadOnly');
check(blocked({management:0}),'dns.blocked.readOnly','6. ReadOnly');
check(blocked({management:0},undefined,false,{snapshot:{...snapshot,service:'stopped'}}),'dns.blocked.readOnly','ReadOnly before the service');
check(blocked({},undefined,false,{snapshot:{...snapshot,service:'stopped'}}),'dns.blocked.stopped','7. a stopped service');
check(blocked({},undefined,false,{snapshot:null}),'dns.blocked.noData','8. no data');
check(blocked({},undefined,false,null),'dns.blocked.noData','no data at all');
check(blocked({}),null,'every gate open');
check(blocked({permissions:[]},{permissions:['*']}),null,'an Owner holds every right');
check(dnsManageBlocked({...device},{permissions:[]},false,now,undefined,'dns-cache-clear'),null,'without data the last two steps are skipped');

console.log(`PASS DNS changes (${checks} checks): 16 operations with requirements, AD sign-in and labels, the plugin policy, the read schemas and KPIs, strict change schemas with bounds and size, every validation code against the sample server and records, normalization and identity, the plugin's reverse vectors, the confirmation sentences per scope and operation, and the order of the manage gate.`);
