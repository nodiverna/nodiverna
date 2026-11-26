// Real heartbeat storage and validation, using the self-hosted data layer.
// Every device in this test is isolated; no installed agent or NAS is touched.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import ts from 'typescript';
import {sql} from '../../runtime/database.mjs';


import {sourceDatabase} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {serverDeskRoot} from '../support/paths.mjs';
const root=serverDeskRoot,require=createRequire(import.meta.url),d=await sourceDatabase(),cache=new Map();
let checks=0,beforeBatch,clock=Date.now();
const check=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
// beforeBatch runs once, before the next transaction starts.
hookDatabase(d,{transaction:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=undefined;await hook();}}});
function load(filename){
 const absolute=resolve(root,filename);if(cache.has(absolute))return cache.get(absolute).exports;
 const loaded={exports:{}};cache.set(absolute,loaded);
 const code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 // The alarm state after a heartbeat has its own test (tests/api/alerts.mjs), so it is stubbed here.
 new Function('require','module','exports',code)(name=>name==='cloudflare:workers'?{env:{}}:name==='@/lib/server/devices/alerts'?{syncDeviceAlerts:async()=>{}}:name.startsWith('@/')?load(name.slice(2)+'.ts'):name.startsWith('.')&&(name.endsWith('.mjs')||name.endsWith('.json'))?require(resolve(dirname(absolute),name)):name.startsWith('.')?load(resolve(dirname(absolute),name)+'.ts'):require(name),loaded,loaded.exports);
 if(absolute===resolve(root,'lib/server/context.ts'))loaded.exports.now=()=>clock;
 return loaded.exports;
}
const {telemetry}=load('lib/server/agent/telemetry.ts'),{hardwareInventory}=load('lib/server/devices/hardware-inventory.ts'),heartbeat=load('app/api/heartbeat/route.ts');
const token='a'.repeat(64),id=randomUUID(),at=new Date(clock-3600000).toISOString();
const snapshot={hostname:'HARDWARE-TEST',os:'Windows 11 Pro',build:'26100',manufacturer:'Example',model:'PC',domain:'WORKGROUP',cores:8,memoryGb:32,cpu:1,memory:20,uptimeSeconds:3600,rebootPending:false,management:false,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.6.6',mode:'ReadOnly',publicKey:{kty:'RSA',n:'A'.repeat(342),e:'AQAB'},agentCapabilities:['refresh']};
const cpu={id:'cpu:CPU0',name:'Example CPU',manufacturer:'Example',cores:8,threads:16,maxClockMhz:5000,socket:'SOCKET 0'};
const memory={id:'memory:Physical Memory 0',deviceLocator:'DIMM A1',bankLabel:'BANK 0',capacityBytes:17179869184,speedMhz:5600,configuredClockMhz:4800,formFactor:'DIMM',memoryType:'DDR5',manufacturer:'Example',partNumber:'EXAMPLE-16GB',serialNumber:null};
const disk={id:'physical-disk:1',model:'Example NVMe',serialNumber:null,sizeBytes:2000398934016,busType:'NVMe',mediaType:'SSD',healthStatus:'healthy',firmwareVersion:'1.2.3'};
const nic={id:'network-adapter:1',name:'Ethernet',manufacturer:'Example',mac:'00:11:22:33:44:55',speedMbps:2500,physicalAdapter:true};
const hardware={collectedAt:at,intervalSeconds:900,complete:true,cpus:[cpu],memoryModules:[memory],memoryArray:{slots:4,maxCapacityBytes:null},disks:[disk],system:{manufacturer:'Example',model:'PC',systemType:'x64-based PC',uuid:null},bios:{manufacturer:'Example',name:'UEFI',version:'1.2.3',releasedAt:null,serialNumber:null},baseboard:{manufacturer:'Example',product:'Board',version:'1.0',serialNumber:null},networkAdapters:[nic]};
const nullable=row=>Object.fromEntries(Object.entries(row).map(([name,value])=>[name,name==='id'||name==='name'&&row===cpu?value:null]));
const minimal={collectedAt:at,intervalSeconds:900,complete:false,errors:['Hardware provider unavailable.']};
const send=async(changes={},credential=token)=>{
 clock+=11000;
 const response=await heartbeat.POST(new Request('https://hardware.test/api/heartbeat',{method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},body:JSON.stringify({serverId:id,snapshot:{...snapshot,...changes},results:[]})}));
 const text=await response.text();return {status:response.status,body:JSON.parse(text)};
};
const state=()=>d.one(sql`SELECT snapshot,last_seen,management FROM servers WHERE id=${id}`);
const stored=async()=>JSON.parse((await state()).snapshot);
const samples=async()=>(await d.one(sql`SELECT COUNT(*) AS count FROM samples WHERE server_id=${id}`)).count;

try{
 await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,token_expires_at) VALUES(${id},${'Hardware regression'},${createHash('sha256').update(token).digest('hex')},${Date.now()},${Date.now()+7*86400000})`);
 check(telemetry.parse(snapshot).hardware,undefined,'agent 4.6.6 remains accepted without fabricated hardware');
 for(const value of [hardware,minimal,{collectedAt:at,intervalSeconds:900,complete:true,cpus:[],memoryModules:[],disks:[],networkAdapters:[]},{...hardware,cpus:[nullable(cpu)],memoryModules:[nullable(memory)],disks:[nullable(disk)],networkAdapters:[nullable(nic)]}])check(telemetry.parse({...snapshot,hardware:value}).hardware,value,'complete, absent and nullable inventories retain their exact fields');
 for(const [section,row,maximum] of [['cpus',cpu,64],['memoryModules',memory,512],['disks',disk,128],['networkAdapters',nic,128]]){
  check(hardwareInventory.parse({...hardware,[section]:Array.from({length:maximum},(_,index)=>({...row,id:'item-'+index}))})[section].length,maximum,'bounded physical count accepted: '+section);
  for(const invalid of [null,{},[null],[row,row],Array.from({length:maximum+1},(_,index)=>({...row,id:'item-'+index})),[{...row,id:''}],[{...row,id:'i'.repeat(129)}],[{...row,inventedSensor:20}]])check(hardwareInventory.safeParse({...hardware,[section]:invalid}).success,false,'malformed, duplicate and oversized category is rejected: '+section);
 }
 const invalid=[
  null,[],{...hardware,collectedAt:'bad-date'},{...hardware,intervalSeconds:30},{...hardware,intervalSeconds:86401},{...hardware,intervalSeconds:300.5},
  {...hardware,complete:false},{...hardware,complete:true,errors:['failure']},{...minimal,errors:[]},{...minimal,errors:Array(11).fill('failure')},{...minimal,errors:['x'.repeat(501)]},
  {...hardware,cpus:[{...cpu,cores:0}]},{...hardware,cpus:[{...cpu,threads:-1}]},{...hardware,cpus:[{...cpu,maxClockMhz:Infinity}]},{...hardware,cpus:[{...cpu,name:'x'.repeat(257)}]},
  {...hardware,memoryModules:[{...memory,capacityBytes:Number.MAX_SAFE_INTEGER+1}]},{...hardware,memoryModules:[{...memory,speedMhz:0}]},{...hardware,memoryModules:[{...memory,configuredClockMhz:2.5}]},
  {...hardware,memoryArray:{slots:0,maxCapacityBytes:null}},{...hardware,memoryArray:{slots:4,maxCapacityBytes:-1}},
  {...hardware,disks:[{...disk,healthStatus:'OK'}]},{...hardware,disks:[{...disk,sizeBytes:NaN}]},{...hardware,disks:[{...disk,busType:'x'.repeat(257)}]},
  {...hardware,networkAdapters:[{...nic,speedMbps:1e8}]},{...hardware,networkAdapters:[{...nic,physicalAdapter:'true'}]},
  {...hardware,bios:{...hardware.bios,releasedAt:'not-a-date'}},{...hardware,baseboard:{...hardware.baseboard,product:'x'.repeat(257)}},{...hardware,system:{...hardware.system,secret:'unexpected'}},
 ];
 for(const value of invalid)check(hardwareInventory.safeParse(value).success,false,'invalid physical inventory cannot enter snapshot storage');
 for(const status of ['healthy','warning','unhealthy','unknown',null])check(hardwareInventory.parse({...hardware,disks:[{...disk,healthStatus:status}]}).disks[0].healthStatus,status,'explicit disk health and unavailable status are preserved');
 check((await send()).status,200,'legacy agent heartbeat remains accepted');check((await stored()).hardware,undefined,'old heartbeat has no synthetic hardware');
 for(const value of [hardware,minimal]){check((await send({agentVersion:'4.6.7',hardware:value})).status,200,'real read-only agent heartbeat accepts optional hardware');check((await stored()).hardware,value,'the database stores actual hardware with optional categories intact');check((await state()).management,0,'hardware is available without enabling management');}
 const before=await stored(),beforeSamples=await samples();
 for(const value of invalid){
  // JSON cannot encode NaN/Infinity. Those schema cases above are covered
  // directly; here exercise malformed finite wire values and containers.
  if(JSON.stringify(value)?.includes('"maxClockMhz":null')||JSON.stringify(value)?.includes('"sizeBytes":null'))continue;
  check((await send({hardware:value})).status,400,'invalid hardware wire payload rejected by actual route');
 }
 check(await stored(),before,'failed inventory cannot replace last accepted snapshot');check(await samples(),beforeSamples,'invalid inventory cannot insert history');
 check((await send({hardware},'wrong-token')).status,401,'hardware heartbeat requires the pinned device credential');check(await stored(),before,'credential failure preserves snapshot');
 await send();check((await stored()).hardware,undefined,'later old-agent heartbeat clears stale optional hardware');
 beforeBatch=async()=>{await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${id}`);};
 const revokedBefore=await state(),revokedSamples=await samples();check((await send({hardware})).status,403,'revocation race rejects hardware batch');
 check((await state()).snapshot,revokedBefore.snapshot,'revoked hardware never changes snapshot');check(await samples(),revokedSamples,'revoked hardware never adds a measurement');
 console.log('PASS hardware inventory:',checks,'schema and actual heartbeat/database assertions.');
}finally{d.close();}
