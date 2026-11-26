// The data of the DNS plugin on PostgreSQL (lib/server/extensions/plugin-data.ts, lib/server/extensions/dns-data.ts,
// docs/dns-server.md): the server read with its row, service, summary and
// alarm sync; the records of a zone only for a running job of that zone; the
// change uploads of both kinds; the zone rows that go with a zone and stay with
// a cut read; an older read never overwrites; the table, its keys, its check,
// the FK cascade and the revoke trigger; the views of GET /api/dns per right and
// customer boundary, the fleet zones in one statement; DHCP uploads unchanged;
// jobs whose parameters are no JSON object do not break the zone guard (jsonText).
import {HttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {enableMultipleCustomers,separateCustomers} from '../support/customer-separation.mjs';

const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 let clock=Date.UTC(2026,10,9,12);
 const uuid=()=>crypto.randomUUID();
 const counted={on:false,statements:0};
 const db=hookDatabase(d,{statement:()=>{if(counted.on)counted.statements++;}});
 const body=async request=>JSON.parse(await request.text());
 const serverModule={db:()=>db,now:()=>clock,config:()=>'',HttpError,body,guid:value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)};
 const deviceRow=id=>d.one(sql`SELECT id,last_seen,management,snapshot,name,agent_public_key FROM servers WHERE id=${id}`);
 const v3={snapshot:row=>row.snapshot?JSON.parse(row.snapshot):null,agentFromBearer:async request=>deviceRow(request.headers.get('x-test-device'))};
 const load=sourceLoader(),imports={'../context':serverModule,'./context':serverModule,'@/lib/server/context':serverModule,'../agent/agent-protocol':v3};
 const data=load('lib/server/extensions/plugin-data.ts',imports),dnsData=load('lib/server/extensions/dns-data.ts',imports),{demoDnsSnapshot,demoDnsRecords}=load('ui/shell/demo-dns.ts',imports),{demoDhcpSnapshot}=load('ui/shell/demo-dhcp.ts',imports);
 const {DNS_CHANGE_OPERATIONS}=load('lib/plugin-catalog.ts',imports);

 // ---- The table: keys, check, cascade --------------------------------------------------------
 const columns=await d.query(sql`SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_name='device_dns_zone_records' ORDER BY ordinal_position`);
 check(columns.map(row=>[row.column_name,row.data_type,row.is_nullable]),[['server_id','text','NO'],['zone','text','NO'],['data','text','NO'],['record_count','integer','NO'],['truncated','boolean','NO'],['collected_at','bigint','NO'],['received_at','bigint','NO']],'device_dns_zone_records: the columns');
 const constraints=await d.query(sql`SELECT conname,contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='device_dns_zone_records'::regclass ORDER BY conname`);
 check(constraints.map(row=>[row.contype,row.definition]),[['c','CHECK ((data IS JSON OBJECT))'],['p','PRIMARY KEY (server_id, zone)'],['f','FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE']],'the check, the key per device and zone, the FK with cascade');

 // ---- Devices ---------------------------------------------------------------------------------------
 const capabilities=['dns-read','dns-zone-read',...DNS_CHANGE_OPERATIONS];
 const ready={name:'dns',role:'dns',version:'1.0.0',capabilities,state:'ready',networkBlocked:true};
 const dhcpReady={name:'dhcp',role:'dhcp',version:'1.1.0',capabilities:['dhcp-read'],state:'ready',networkBlocked:true};
 async function device(name,plugins=[ready,dhcpReady]){
  const id=uuid();
  await insertRow(d,'servers',{id,name,token_hash:'fixture-'+id,created_at:clock,last_seen:clock,management:0,snapshot:JSON.stringify({protocolVersion:3,agentVersion:'4.20.0',mode:'ReadOnly',agentCapabilities:['plugin-host'],plugins})});
  return id;
 }
 const upload=async(bearer,payload)=>{const response=await data.ingestPluginData(new Request('https://data.test/api/agent/plugin-data',{method:'POST',headers:{'Content-Type':'application/json','x-test-device':bearer},body:JSON.stringify(payload)}));return {status:response.status,body:await response.json()};};
 const attempt=async payload=>{try{return await upload(payload.serverId,payload);}catch(error){return {status:error.status,key:error.messageKey};}};
 const iso=()=>new Date(clock).toISOString();
 const server=(serverId,extra={})=>({serverId,plugin:'dns',operation:'dns-read',collectedAt:iso(),data:demoDnsSnapshot(clock),...extra});
 const zoneData=(zone='corp.example')=>demoDnsRecords(clock,zone);
 const job=async(serverId,operation,parameters,state='running')=>{const id=uuid();await insertRow(d,'jobs',{id,server_id:serverId,action:'plugin-job',target:operation,parameters:JSON.stringify({plugin:'dns',operation,...(parameters?{parameters}:{})}),state,created_at:clock,actor:'local:x',actor_email:'x@example.test',actor_principal:'private:x@example.test'});return id;};
 const row=id=>d.one(sql`SELECT plugin,operation,service,summary,collected_at FROM device_plugin_data WHERE server_id=${id} AND plugin='dns'`);
 const zoneRows=id=>d.query(sql`SELECT zone,record_count,truncated FROM device_dns_zone_records WHERE server_id=${id} ORDER BY zone`);
 const dc=await device('SRV-DC01'),dc2=await device('SRV-DC02'),dhcpOnly=await device('SRV-DHCP',[dhcpReady]);

 // ---- The server read -------------------------------------------------------------------------------
 const alarms=id=>d.query(sql`SELECT rule_id,key,state FROM alerts WHERE server_id=${id} ORDER BY rule_id`);
 let result=await upload(dc,server(dc));
 check([result.status,result.body.stored],[200,true],'the periodic server read');
 const stored=await row(dc);
 check([stored.operation,stored.service,JSON.parse(stored.summary).map(zone=>zone.name)],['dns-read','running',demoDnsSnapshot(clock).zones.map(zone=>zone.name)],'one dns-read row with the service and the zone summary');
 check(Object.keys(JSON.parse(stored.summary)[0]).sort(),['autoCreated','dynamicUpdate','kind','lookup','name','recordCount','replicationScope','storage'],'the summary fields');
 clock+=30_000;
 check((await attempt(server(dc,{collectedAt:iso()}))).key,'apiError.plugin.dataTooSoon','a second periodic DNS read within 60 s');
 check((await attempt({serverId:dc,plugin:'dhcp',operation:'dhcp-read',collectedAt:iso(),data:demoDhcpSnapshot(clock)})).status,200,'the spacing is per plugin: a DHCP read passes');
 check((await attempt(server(dc,{operation:'dns-zone-read',collectedAt:iso(),data:zoneData()}))).key,'apiError.plugin.dataInvalid','only the periodic read uploads without a job id');
 check((await attempt(server(dc,{operation:'dhcp-read'}))).key,'apiError.plugin.dataInvalid','an operation of another plugin');
 check((await attempt(server(dc,{plugin:'wsus'}))).key,'apiError.plugin.dataInvalid','an unknown plugin');
 check((await attempt(server(dhcpOnly))).key,'apiError.plugin.notReported','a device without the DNS plugin');
 check((await attempt(server(dc2,{data:{...demoDnsSnapshot(clock),extra:1}}))).key,'apiError.plugin.dataInvalid','data that fail the schema');
 check((await attempt(server(dc2,{data:zoneData()}))).key,'apiError.plugin.dataInvalid','zone data without a job');
 // A stopped service opens the alarm in the same upload.
 const stoppedRead={...demoDnsSnapshot(clock),service:'stopped',zones:[],forwarders:{servers:[],timeoutSeconds:0,useRootHints:true}};
 result=await upload(dc2,server(dc2,{data:stoppedRead}));
 check([result.body.stored,(await row(dc2)).service],[true,'stopped'],'a stopped service is stored');
 check((await alarms(dc2)).filter(item=>item.rule_id==='dns-service-stopped').map(item=>[item.key,item.state]),[['dns-service','open']],'the upload syncs the alarm: DNS service stopped opens');

 // ---- Zone records: only a running job of that zone ------------------------------------------------------
 // Jobs whose free-text parameters are no JSON object (legacy rows) must not make the zone guard throw.
 const rawJob=async(serverId,operation,parameters,state)=>{const id=uuid();await insertRow(d,'jobs',{id,server_id:serverId,action:'plugin-job',target:operation,parameters,state,created_at:clock,actor:'local:x',actor_email:'x@example.test',actor_principal:'private:x@example.test'});return id;};
 const legacyRunning=await rawJob(dc,'dns-zone-read','legacy','running');
 await rawJob(dc,'dns-zone-read','[1]','pending');
 await rawJob(dc,'dns-read','"x"','running');
 await rawJob(dc,'dns-read','legacy','pending');
 check((await attempt({serverId:dc,plugin:'dns',operation:'dns-zone-read',jobId:legacyRunning,collectedAt:iso(),data:zoneData()})).key,'apiError.plugin.dataInvalid','a running zone read whose parameters are no JSON object is refused, not an error');
 const readJob=await job(dc,'dns-zone-read',{zone:'corp.example'});
 result=await upload(dc,{serverId:dc,plugin:'dns',operation:'dns-zone-read',jobId:readJob,collectedAt:iso(),data:zoneData()});
 check([result.status,result.body.stored],[200,true],'a zone read with its running job');
 check(await zoneRows(dc),[{zone:'corp.example',record_count:14,truncated:false}],'one row per zone with the total');
 check((await attempt({serverId:dc,plugin:'dns',operation:'dns-zone-read',jobId:readJob,collectedAt:iso(),data:zoneData('20.10.in-addr.arpa')})).key,'apiError.plugin.dataInvalid','the job of another zone does not admit the records');
 check((await attempt({serverId:dc,plugin:'dns',operation:'dns-zone-read',jobId:readJob,collectedAt:iso(),data:demoDnsSnapshot(clock)})).key,'apiError.plugin.dataInvalid','a zone read may not upload the server');
 const doneJob=await job(dc,'dns-zone-read',{zone:'20.10.in-addr.arpa'},'succeeded');
 check((await attempt({serverId:dc,plugin:'dns',operation:'dns-zone-read',jobId:doneJob,collectedAt:iso(),data:zoneData('20.10.in-addr.arpa')})).key,'apiError.plugin.jobNotRunning','a job that no longer runs');
 const otherDevice=await job(dc2,'dns-zone-read',{zone:'20.10.in-addr.arpa'});
 check((await attempt({serverId:dc,plugin:'dns',operation:'dns-zone-read',jobId:otherDevice,collectedAt:iso(),data:zoneData('20.10.in-addr.arpa')})).key,'apiError.plugin.jobNotRunning','the job of another device');
 // An older read never overwrites.
 result=await upload(dc,{serverId:dc,plugin:'dns',operation:'dns-zone-read',jobId:readJob,collectedAt:new Date(clock-600_000).toISOString(),data:{...zoneData(),records:[],total:0}});
 check([result.body.stored,(await zoneRows(dc))[0].record_count],[false,14],'an older zone read does not overwrite');

 // ---- Change uploads: records after a record change, the server after any other ------------------------------
 const add=await job(dc,'dns-record-add',{zone:'20.10.in-addr.arpa',name:'5.1',type:'PTR'});
 result=await upload(dc,{serverId:dc,plugin:'dns',operation:'dns-record-add',jobId:add,collectedAt:iso(),data:zoneData('20.10.in-addr.arpa')});
 check([result.body.stored,(await zoneRows(dc)).map(item=>item.zone)],[true,['20.10.in-addr.arpa','corp.example']],'a record change stores the records of its zone');
 check((await attempt({serverId:dc,plugin:'dns',operation:'dns-record-add',jobId:add,collectedAt:iso(),data:demoDnsSnapshot(clock)})).key,'apiError.plugin.dataInvalid','a record change does not upload the server');
 const transfer=await job(dc,'dns-zone-transfer',{zone:'partner.example'});
 check((await upload(dc,{serverId:dc,plugin:'dns',operation:'dns-zone-transfer',jobId:transfer,collectedAt:iso(),data:{...zoneData(),zone:'partner.example'}})).body.stored,true,'a transfer stores the records of its zone');
 clock+=1000;
 const create=await job(dc,'dns-zone-create',{kind:'primary'});
 const withNew={...demoDnsSnapshot(clock),zones:[...demoDnsSnapshot(clock).zones,{...demoDnsSnapshot(clock).zones[0],name:'lab.corp.example'}]};
 result=await upload(dc,{serverId:dc,plugin:'dns',operation:'dns-zone-create',jobId:create,collectedAt:iso(),data:withNew});
 check([result.body.stored,JSON.parse((await row(dc)).summary).some(zone=>zone.name==='lab.corp.example')],[true,true],'a zone change stores the server read');
 check((await attempt({serverId:dc,plugin:'dns',operation:'dns-zone-create',jobId:create,collectedAt:iso(),data:zoneData()})).key,'apiError.plugin.dataInvalid','a zone change does not upload zone records');
 // A read with cut zones keeps every zone row; a full read drops the rows of zones that are gone.
 clock+=61_000;
 const cut={...demoDnsSnapshot(clock),zones:demoDnsSnapshot(clock).zones.slice(0,1),truncated:{zones:true}};
 await upload(dc,server(dc,{collectedAt:iso(),data:cut}));
 check((await zoneRows(dc)).length,3,'a cut read keeps the zone rows');
 clock+=61_000;
 await upload(dc,server(dc,{collectedAt:iso(),data:{...demoDnsSnapshot(clock),zones:demoDnsSnapshot(clock).zones.filter(zone=>zone.name!=='partner.example')}}));
 check((await zoneRows(dc)).map(item=>item.zone),['20.10.in-addr.arpa','corp.example'],'a full read drops the rows of a zone that is gone');
 clock+=61_000;
 check((await upload(dc,server(dc,{collectedAt:new Date(clock-3600_000).toISOString()}))).body.stored,false,'an older server read does not overwrite');

 // ---- consoleDnsAlerts in one statement --------------------------------------------------------------------
 counted.on=true;counted.statements=0;
 const alerts=await dnsData.consoleDnsAlerts(JSON.stringify([dc,dc2,dhcpOnly]));
 counted.on=false;
 check([counted.statements,alerts.size,alerts.get(dc2),alerts.get(dc).service],[1,2,{service:'stopped',collectedAt:Date.UTC(2026,10,9,12)+30_000},'running'],'consoleDnsAlerts: one statement, the service and the read time');

 // ---- GET /api/dns ----------------------------------------------------------------------------------------
 const viewerOf=async(label,permissions,scopeType='global',scopeId='*')=>{const {actor}=await sourceActor(d,label,permissions,scopeType,scopeId);return actor;};
 const reader=await viewerOf('reader@dns-data.test',['view','dns.read']),nobody=await viewerOf('nobody@dns-data.test',['view','dhcp.read']);
 const view=await dnsData.deviceDnsView(reader,dc);
 check([view.snapshot.kind,view.plugin,typeof view.collectedAt,typeof view.receivedAt],['server',{version:'1.0.0',state:'ready'},'number','number'],'?serverId=: the server read and the plugin');
 check((await dnsData.deviceDnsView(reader,dhcpOnly)),{snapshot:null,collectedAt:null,receivedAt:null,plugin:null},'a device without the DNS plugin');
 const records=await dnsData.deviceDnsZoneView(reader,dc,'corp.example');
 check([records.records.zone,records.records.total,typeof records.collectedAt],['corp.example',14,'number'],'?serverId=&zone=: the stored records');
 check(await dnsData.deviceDnsZoneView(reader,dc,'unread.example'),{records:null,collectedAt:null,receivedAt:null},'a zone without a read');
 await assert.rejects(dnsData.deviceDnsView(nobody,dc),error=>error.messageKey==='apiError.access.devicePermissionMissing','without dns.read');checks++;
 await assert.rejects(dnsData.deviceDnsZoneView(nobody,dc,'corp.example'),error=>error.messageKey==='apiError.access.devicePermissionMissing','the records need dns.read');checks++;
 await assert.rejects(dnsData.deviceDnsZoneView(reader,dc,''),error=>error.messageKey==='apiError.request.invalid','an empty zone');checks++;
 const onlyDc=await viewerOf('dc@dns-data.test',['view','dns.read'],'device',dc);
 counted.on=true;counted.statements=0;
 const zones=await dnsData.dnsFleetZones(onlyDc);
 counted.on=false;
 check(counted.statements,1,'?zones=1: one statement for every device');
 check([...new Set(zones.map(item=>item.serverId))],[dc],'only the devices with dns.read');
 check(zones.map(item=>item.zone),['_msdcs.corp.example','20.10.in-addr.arpa','branch.example','corp.example'],'sorted by zone name, without the zones Windows created');
 check(Object.keys(zones[0]).sort(),['collectedAt','dynamicUpdate','kind','lookup','recordCount','replicationScope','serverId','storage','zone'],'the fleet zone fields');
 check((await dnsData.dnsFleetZones(reader)).filter(item=>item.zone==='corp.example').map(item=>item.serverId),[dc],'the stopped server has no zones');
 check(await dnsData.dnsFleetZones(nobody),[],'without dns.read: []');

 // ---- Removal: the revoke trigger and the cascade ---------------------------------------------------------
 await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${dc}`);
 check([await zoneRows(dc),await d.query(sql`SELECT server_id FROM device_plugin_data WHERE server_id=${dc}`)],[[],[]],'a removed device keeps no DNS data and no zone records');
 await insertRow(d,'device_dns_zone_records',{server_id:dc2,zone:'x.example',data:'{}',record_count:0,truncated:false,collected_at:clock,received_at:clock});
 await d.exec(sql`DELETE FROM jobs WHERE server_id=${dc2}`);await d.exec(sql`DELETE FROM alerts WHERE server_id=${dc2}`);await d.exec(sql`DELETE FROM alert_events WHERE server_id=${dc2}`).catch(()=>{});
 await d.exec(sql`DELETE FROM servers WHERE id=${dc2}`);
 check(await zoneRows(dc2),[],'deleting the device cascades to its zone records');
 await assert.rejects(d.exec(sql`INSERT INTO device_dns_zone_records (server_id,zone,data,record_count,truncated,collected_at,received_at) VALUES (${dhcpOnly},'y.example','[]',0,false,1,1)`),'the data must be a JSON object');checks++;
 // Once a second customer exists the customer boundary applies: a non-owner without a customer assignment sees nothing.
 const dc3=await device('SRV-DC03');clock+=61_000;await upload(dc3,server(dc3,{collectedAt:iso()}));
 check((await dnsData.dnsFleetZones(reader)).some(item=>item.serverId===dc3),true,'with one customer the reader sees the zones');
 await d.exec(enableMultipleCustomers());await d.exec(separateCustomers(clock));
 check(await dnsData.dnsFleetZones(reader),[],'outside the customer boundary nothing shows');
 // The zone guard reads the parameters through jsonText, never through a left-to-right AND.
 const dnsDataSource=readFileSync(new URL('../../lib/server/extensions/dns-data.ts',import.meta.url),'utf8');
 check([dnsDataSource.includes('IS JSON OBJECT AND'),dnsDataSource.includes("AND ${jsonText(sql`parameters`,'parameters','zone')}=${records.zone})")],[false,true],'dns-data.ts: the zone guard uses jsonText');
 console.log(`PASS DNS data (${checks} checks): the table with its key, check and cascade, the server read with its service, summary and alarm sync, the per-plugin spacing, zone records only for a running job of the zone, the change uploads of both kinds, the zone rows that go with a zone and stay with a cut read, no older overwrite, consoleDnsAlerts in one statement, the views per right and boundary, the fleet zones in one statement and the revoke trigger.`);
}finally{await d.close();}
