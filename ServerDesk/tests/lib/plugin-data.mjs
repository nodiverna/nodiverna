// The data of the DHCP plugin on PostgreSQL (lib/server/extensions/plugin-data.ts, lib/dhcp.ts,
// docs/dhcp-server.md): the snapshot schema with its bounds, the upload with
// its device, plugin, size, spacing, job and freshness rules, the device read
// and the fleet usage in one statement inside the rights and the customer
// boundary, and the pure KPI and sort helpers.
import {HttpError} from '../support/http-error.mjs';
import {serverText} from '../support/server-text.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {enableMultipleCustomers,separateCustomers} from '../support/customer-separation.mjs';

const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 let clock=Date.UTC(2026,10,4,12);
 const uuid=()=>crypto.randomUUID();
 const counted={on:false,statements:0};
 const db=hookDatabase(d,{statement:()=>{if(counted.on)counted.statements++;}});
 const limits=[];
 const body=async(request,limit)=>{limits.push(limit);const text=await request.text();if(Buffer.byteLength(text)>limit)throw new HttpError(413,serverText('apiError.request.tooLarge'));return JSON.parse(text);};
 const server={db:()=>db,now:()=>clock,config:()=>'',HttpError,body,guid:value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)};
 const deviceRow=id=>d.one(sql`SELECT id,last_seen,management,snapshot,name,agent_public_key FROM servers WHERE id=${id}`);
 // The bearer device is the header of the fixture request; the body names its own serverId.
 const v3={snapshot:row=>row.snapshot?JSON.parse(row.snapshot):null,agentFromBearer:async request=>deviceRow(request.headers.get('x-test-device'))};
 const load=sourceLoader(),imports={'../context':server,'./context':server,'@/lib/server/context':server,'../agent/agent-protocol':v3};
 const data=load('lib/server/extensions/plugin-data.ts',imports),dhcp=load('lib/dhcp.ts',imports),{demoDhcpSnapshot}=load('ui/shell/demo-dhcp.ts',imports);
 const snapshot=demoDhcpSnapshot(clock);

 // ---- The snapshot schema ---------------------------------------------------------------
 check(dhcp.dhcpSnapshotSchema.safeParse(snapshot).success,true,'the sample snapshot passes');
 const refused=(label,edit)=>{const copy=structuredClone(snapshot);edit(copy);check(dhcp.dhcpSnapshotSchema.safeParse(copy).success,false,label);};
 refused('an unknown key',copy=>{copy.extra=1;});
 refused('an unknown key in a scope',copy=>{copy.ipv4.scopes[0].color='red';});
 refused('schema 2',copy=>{copy.schema=2;});
 refused('more than 500 IPv4 scopes',copy=>{copy.ipv4.scopes=Array.from({length:501},()=>copy.ipv4.scopes[2]);});
 refused('more than 10000 leases',copy=>{copy.leases.items=Array.from({length:10001},()=>copy.leases.items[0]);});
 refused('more than 2000 reservations in a scope',copy=>{copy.ipv4.scopes[0].reservations=Array.from({length:2001},()=>copy.ipv4.scopes[0].reservations[0]);});
 refused('more than 32 option values',copy=>{copy.ipv4.serverOptions[0].values=Array.from({length:33},()=>'x');});
 refused('a percent above 100',copy=>{copy.ipv4.scopes[0].usage.percent=101;});
 refused('an address that is no IPv4',copy=>{copy.ipv4.scopes[0].id='10.10.0.300';});
 refused('an unknown lease state',copy=>{copy.leases.items[0].state='lost';});
 const stopped=structuredClone(snapshot);stopped.service='stopped';stopped.ipv4.scopes=[];stopped.leases={items:[],total:0,truncated:false};
 check(dhcp.dhcpSnapshotSchema.safeParse(stopped).success,true,'a stopped service with empty lists');

 // ---- The pure helpers ------------------------------------------------------------------
 const kpis=dhcp.dhcpKpis(snapshot);
 check([kpis.scopes,kpis.active,kpis.inUse,kpis.total,kpis.percent,kpis.leases,kpis.fullest],[3,2,217,300,72.3,20,{id:'10.20.0.0',name:'Wi-Fi Guests',percent:93}],'the KPIs: in use over the active IPv4 scopes, the fullest scope');
 check(dhcp.dhcpKpis({...snapshot,ipv4:{...snapshot.ipv4,scopes:[]}}).percent,0,'no address gives 0 %');
 const rows=[{serverId:'b',scopeId:'10.2.0.0',percent:50},{serverId:'a',scopeId:'10.9.0.0',percent:50},{serverId:'a',scopeId:'10.10.0.0',percent:50},{serverId:'c',scopeId:'x',percent:93}];
 check(dhcp.sortDhcpUsageRows(rows,id=>({a:'SRV-2',b:'SRV-10',c:'SRV-9'})[id]).map(row=>row.serverId+':'+row.scopeId),['c:x','a:10.9.0.0','a:10.10.0.0','b:10.2.0.0'],'by percent, then server name (numeric), then scope id (numeric)');
 check(dhcp.dhcpUsageSummary(snapshot).map(row=>[row.family,row.scopeId,row.total,row.percent]),[['ipv4','10.10.0.0',200,62],['ipv4','10.20.0.0',100,93],['ipv4','10.30.0.0',50,0],['ipv6','2001:db8:10::',null,0]],'the usage summary: IPv6 has no total');

 // ---- The upload ------------------------------------------------------------------------
 const ready={name:'dhcp',role:'dhcp',version:'1.0.0',capabilities:['dhcp-read'],state:'ready',networkBlocked:true};
 async function device(name,plugins=[ready],customer){
  const id=uuid();
  await insertRow(d,'servers',{id,name,token_hash:'fixture-'+id,created_at:clock,last_seen:clock,management:0,snapshot:JSON.stringify({protocolVersion:3,agentVersion:'4.16.0',mode:'ReadOnly',agentCapabilities:['plugin-host'],plugins}),...(customer?{customer_id:customer}:{})});
  return id;
 }
 const upload=async(bearer,payload,raw)=>{const response=await data.ingestPluginData(new Request('https://data.test/api/agent/plugin-data',{method:'POST',headers:{'Content-Type':'application/json','x-test-device':bearer},body:raw??JSON.stringify(payload)}));return {status:response.status,body:await response.json()};};
 const attempt=async(...args)=>{try{return await upload(...args);}catch(error){return {status:error.status,key:error.messageKey};}};
 const payload=(serverId,extra={})=>({serverId,plugin:'dhcp',operation:'dhcp-read',collectedAt:new Date(clock).toISOString(),data:snapshot,...extra});
 const a=await device('SRV-A'),b=await device('SRV-B'),bare=await device('SRV-BARE',[]),damaged=await device('SRV-DAMAGED',[{...ready,state:'damaged'}]);
 const stored=id=>d.one(sql`SELECT collected_at,received_at,summary FROM device_plugin_data WHERE server_id=${id} AND plugin='dhcp'`);
 check((await attempt(a,payload(b))).key,'apiError.agent.notApproved','the bearer device must be the device of the body');
 check((await attempt(a,payload(b))).status,403,'403 for another device');
 check((await attempt(bare,payload(bare))).key,'apiError.plugin.notReported','a device that does not report the plugin');
 check((await attempt(damaged,payload(damaged))).key,'apiError.plugin.notReported','a damaged plugin');
 check([(await attempt(a,null,JSON.stringify(payload(a,{padding:'x'.repeat(2_700_000)})))).status,limits.at(-1)],[413,2_621_440],'a body above 2.5 MiB, checked before the parse');
 check((await attempt(a,payload(a,{data:{...snapshot,extra:true}}))).key,'apiError.plugin.dataInvalid','data that fail the schema');
 check((await attempt(a,payload(a,{collectedAt:new Date(clock+3_600_000).toISOString()}))).key,'apiError.plugin.dataInvalid','a collection time far ahead');
 let result=await upload(a,payload(a));
 check([result.status,result.body.stored],[200,true],'the first periodic upload');
 check(JSON.parse((await stored(a)).summary).length,4,'the usage summary is stored with the data');
 clock+=30_000;
 check((await attempt(a,payload(a,{collectedAt:new Date(clock).toISOString()}))).key,'apiError.plugin.dataTooSoon','a second periodic upload within 60 s: 429');
 check((await attempt(a,payload(a,{collectedAt:new Date(clock).toISOString()}))).status,429,'the status is 429');
 // With a running plugin job of this device the upload is accepted at once.
 const job=uuid();
 await insertRow(d,'jobs',{id:job,server_id:a,action:'plugin-job',target:'dhcp-read',parameters:JSON.stringify({plugin:'dhcp',operation:'dhcp-read'}),state:'running',created_at:clock,actor:'local:x',actor_email:'x@example.test',actor_principal:'private:x@example.test'});
 result=await upload(a,payload(a,{jobId:job,collectedAt:new Date(clock).toISOString()}));
 check([result.status,result.body.stored,Number((await stored(a)).collected_at)],[200,true,clock],'a job upload with a running job id');
 check((await attempt(a,payload(a,{jobId:uuid()}))).key,'apiError.plugin.jobNotRunning','an unknown job id');
 await d.exec(sql`UPDATE jobs SET state='succeeded' WHERE id=${job}`);
 check((await attempt(a,payload(a,{jobId:job}))).key,'apiError.plugin.jobNotRunning','a job that no longer runs');
 clock+=61_000;
 result=await upload(a,payload(a,{collectedAt:new Date(clock-600_000).toISOString()}));
 check([result.body.stored,Number((await stored(a)).collected_at)],[false,clock-61_000],'an older collectedAt does not overwrite');
 // ---- The read after a DHCP change (plugin 1.1.0) ------------------------------------------
 const c=await device('SRV-CHANGE',[{...ready,version:'1.1.0',capabilities:['dhcp-read','dhcp-scope-create']}]);
 const running={parameters:JSON.stringify({plugin:'dhcp',operation:'dhcp-scope-create'}),state:'running',created_at:clock,actor:'local:x',actor_email:'x@example.test',actor_principal:'private:x@example.test'};
 check((await attempt(c,payload(c,{operation:'dhcp-scope-create'}))).key,'apiError.plugin.dataInvalid','a change upload without a job id is refused');
 check((await attempt(c,payload(c,{operation:'dhcp-lease-delete',jobId:uuid()}))).key,'apiError.plugin.notReported','an operation the plugin does not report');
 const readJob=uuid(),changeJob=uuid();
 await insertRow(d,'jobs',{id:readJob,server_id:c,action:'plugin-job',target:'dhcp-read',...running});
 check((await attempt(c,payload(c,{operation:'dhcp-scope-create',jobId:readJob}))).key,'apiError.plugin.jobNotRunning','the job of another operation does not admit a change upload');
 await insertRow(d,'jobs',{id:changeJob,server_id:c,action:'plugin-job',target:'dhcp-scope-create',...running});
 const stoppedData={...structuredClone(snapshot),service:'stopped'};
 result=await upload(c,payload(c,{operation:'dhcp-scope-create',jobId:changeJob,data:stoppedData}));
 check([result.status,result.body.stored],[200,true],'the upload of a running change job');
 check(await d.query(sql`SELECT operation,service FROM device_plugin_data WHERE server_id=${c}`),[{operation:'dhcp-read',service:'stopped'}],'stored as the one dhcp-read row, with its service');
 check(Number((await stored(a)).collected_at)>0&&(await d.one(sql`SELECT service FROM device_plugin_data WHERE server_id=${a}`)).service,'running','a periodic upload writes the service as well');
 // consoleDhcpAlerts: the service and the IPv4 scopes of the summary, for many devices in one statement.
 counted.on=true;counted.statements=0;
 const alerts=await data.consoleDhcpAlerts(JSON.stringify([a,c,bare]));
 counted.on=false;
 check(counted.statements,1,'consoleDhcpAlerts: one statement');
 check([alerts.size,alerts.get(c).service,alerts.get(a).service,alerts.get(a).scopes.map(scope=>[scope.scopeId,scope.state,scope.percent,scope.total])],[2,'stopped','running',[['10.10.0.0','active',62,200],['10.20.0.0','active',93,100],['10.30.0.0','inactive',0,50]]],'the IPv4 scopes and the service per device');
 check(typeof alerts.get(a).collectedAt,'number','with the read time');
 // The device read.
 const viewerOf=async(label,permissions,scopeType='global',scopeId='*')=>{const {actor}=await sourceActor(d,label,permissions,scopeType,scopeId);return actor;};
 const reader=await viewerOf('reader@data.test',['view','dhcp.read']),nobody=await viewerOf('nobody@data.test',['view']);
 const view=await data.deviceDhcpView(reader,a);
 check([view.snapshot.ipv4.scopes.length,view.plugin,typeof view.collectedAt],[3,{version:'1.0.0',state:'ready'},'number'],'GET /api/dhcp?serverId=: the latest read and the plugin');
 check(await data.deviceDhcpView(reader,b),{snapshot:null,collectedAt:null,receivedAt:null,plugin:{version:'1.0.0',state:'ready'}},'a device without data yet');
 await assert.rejects(data.deviceDhcpView(nobody,a),error=>error.messageKey==='apiError.access.devicePermissionMissing','without dhcp.read');checks++;

 // ---- The fleet usage --------------------------------------------------------------------
 clock+=61_000;await upload(b,payload(b,{collectedAt:new Date(clock).toISOString()}));
 const onlyA=await viewerOf('device-a@data.test',['view','dhcp.read'],'device',a);
 counted.on=true;counted.statements=0;
 const usage=await data.dhcpUsage(onlyA);
 counted.on=false;
 check(counted.statements,1,'one statement for every device');
 check([...new Set(usage.map(row=>row.serverId))],[a],'only the devices with dhcp.read');
 check(usage.map(row=>row.scopeId),['10.20.0.0','10.10.0.0','10.30.0.0','2001:db8:10::'],'sorted by percent');
 check(Object.keys(usage[0]).sort(),['collectedAt','family','inUse','name','percent','range','scopeId','serverId','state','total'],'the usage row fields');
 check((await data.dhcpUsage(reader)).length,12,'a global dhcp.read sees every device with data');
 check(await data.dhcpUsage(nobody),[],'without dhcp.read: [], no error');
 // Once a second customer exists the customer boundary applies: a non-owner without a customer assignment sees nothing.
 await d.exec(enableMultipleCustomers());await d.exec(separateCustomers(clock));
 check(await data.dhcpUsage(reader),[],'outside the customer boundary nothing shows');
 // Removing the device removes its plugin data.
 await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${a}`);
 check(await d.query(sql`SELECT server_id FROM device_plugin_data WHERE server_id=${a}`),[],'a removed device keeps no plugin data');
 console.log(`PASS plugin data (${checks} checks): the DHCP snapshot schema and its bounds, the upload rules, the read after a change job with its service, consoleDhcpAlerts in one statement, the device read, the fleet usage in one statement within the rights and the customer boundary, KPIs and sort.`);
}finally{await d.close();}
