// Validate current GPU snapshots and execute the actual heartbeat route against
// the same data layer used in self-hosting (a PostgreSQL test database). No deployed device is touched.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import ts from 'typescript';
import {sql} from '../../runtime/database.mjs';


import {sourceDatabase,inTransaction,insertRow} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {serverDeskRoot} from '../support/paths.mjs';
const root=serverDeskRoot,require=createRequire(import.meta.url),d=await sourceDatabase(),cache=new Map();
let clock=Date.now(),checks=0,viewer,beforeHeartbeatBatch,beforeHistoryRead;
// Race hooks: beforeHeartbeatBatch runs once before the next transaction,
// beforeHistoryRead once before the next history SELECT.
hookDatabase(d,{
 transaction:async()=>{if(beforeHeartbeatBatch){const hook=beforeHeartbeatBatch;beforeHeartbeatBatch=undefined;await hook();}},
 statement:async(text,kind)=>{if(kind==='query'&&text.startsWith('SELECT server_id AS "serverId"')&&beforeHistoryRead){const hook=beforeHistoryRead;beforeHistoryRead=undefined;await hook();}}
});
function load(filename){
 const absolute=resolve(root,filename);
 if(cache.has(absolute))return cache.get(absolute).exports;
 const loaded={exports:{}};cache.set(absolute,loaded);
 const code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 new Function('require','module','exports',code)(name=>{
  if(name==='cloudflare:workers')return {env:{}};
  // The alarm state after a heartbeat has its own test (tests/api/alerts.mjs).
  if(name==='@/lib/server/devices/alerts')return {syncDeviceAlerts:async()=>{}};
  if(name.startsWith('@/'))return load(name.slice(2)+'.ts');
  // Plain runtime modules (runtime/secret-keyring.mjs) and JSON data files (lib/vulnerability-catalog.json) load as they are.
  if(name.startsWith('.')&&(name.endsWith('.mjs')||name.endsWith('.json')))return require(resolve(dirname(absolute),name));
  if(name.startsWith('.'))return load(resolve(dirname(absolute),name)+'.ts');
  return require(name);
 },loaded,loaded.exports);
 if(absolute===resolve(root,'lib/server/context.ts')){
  loaded.exports.now=()=>clock;
  // Browser credential decoding is a leaf; device RBAC, the live captured
  // password/MFA-session fence, route SQL and the data layer remain production code.
  loaded.exports.requireViewer=async()=>{if(!viewer)throw new loaded.exports.HttpError(401,'Anmeldung erforderlich.');return viewer;};
 }
 return loaded.exports;
}
const {telemetry}=load('lib/server/agent/telemetry.ts'),heartbeat=load('app/api/heartbeat/route.ts'),history=load('app/api/history/route.ts'),{parseGpuHistory}=load('lib/server/devices/gpu-history.ts');
const snapshot={hostname:'GPU-TEST',os:'Windows 11 Pro',build:'26100',manufacturer:'Example',model:'PC',domain:'WORKGROUP',cores:8,memoryGb:32,cpu:1,memory:20,uptimeSeconds:3600,rebootPending:false,management:true,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.6.3',mode:'Management',publicKey:{kty:'RSA',n:'A'.repeat(342),e:'AQAB'},agentCapabilities:['refresh']};
// A valid ISO timestamp with an explicit +02:00 offset for the same instant as `ms`.
const plusTwoHours=ms=>new Date(ms+7200000).toISOString().slice(0,19)+'+02:00';
const gpu={id:'PCI\\VEN_10DE&DEV_2782',name:'NVIDIA GeForce RTX 4070 Ti',vendor:'nvidia',utilization:38.5,collectedAt:new Date(clock-3600000).toISOString()};
const gpus=[gpu,{...gpu,id:'amd-1',name:'AMD Radeon RX 7900 XTX',vendor:'amd',utilization:0},{...gpu,id:'intel-1',name:'Intel Arc A770',vendor:'intel',utilization:100},{...gpu,id:'nvidia-2',utilization:null}];
const check=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
const invalidGpuFields=[
 {id:''},{id:'x'.repeat(129)},{id:null},{id:4},{id:undefined},
 {name:''},{name:'x'.repeat(257)},{name:null},{name:4},{name:undefined},
 {vendor:'NVIDIA'},{vendor:'other'},{vendor:null},{vendor:undefined},
 ...[-0.1,100.1,Infinity,-Infinity,NaN,'35',{},undefined].map(utilization=>({utilization})),
 {collectedAt:'not-a-date'},{collectedAt:'2026-02-30T10:00:00Z'},{collectedAt:'2026-10-11'},
 {collectedAt:'2026-10-11T10:00:00'},{collectedAt:'x'.repeat(61)},{collectedAt:null},{collectedAt:undefined},
 {unexpectedField:'unbounded metadata'}
];
const invalidLists=[null,{},'GPU',1,[null],[[]],Array.from({length:17},(_,index)=>({...gpu,id:'gpu-'+index})),[gpu,{...gpu,name:'Different name cannot make the same physical GPU unique'}]];
const detail={id:gpu.id,collectedAt:gpu.collectedAt};
const detailStrings=[['driverVersion',128],['vendorDriverVersion',128],['driverModel',128],['vbiosVersion',128],['pciBusId',32]];
const detailIntegers=[['vendorId',0,65535],['deviceId',0,65535],['subsystemId',0,4294967295],['revision',0,4294967295],...['dedicatedMemoryBytes','sharedMemoryBytes','dedicatedMemoryUsedBytes','sharedMemoryUsedBytes'].map(field=>[field,0,Number.MAX_SAFE_INTEGER]),['pcieGeneration',1,16],['pcieMaxGeneration',1,16],['pcieLinkWidth',1,128],['pcieMaxLinkWidth',1,128],['memoryBusWidthBits',1,65536],['cudaCores',1,10000000]];
const detailMetrics=[['temperatureCelsius',-50,200],['coreClockMhz',0,100000],['memoryClockMhz',0,100000],['powerWatts',0,10000],['powerLimitWatts',0,10000],['fanPercent',0,200]];
const optionalDetailFields=[...detailStrings.map(([field])=>field),...detailIntegers.map(([field])=>field),...detailMetrics.map(([field])=>field),'sensorProvider'];
const nullDetails={...detail,...Object.fromEntries(optionalDetailFields.map(field=>[field,null]))};
const fullDetails={...detail,driverVersion:'32.0.15.6094',vendorDriverVersion:'560.94',driverModel:'WDDM 3.2',vbiosVersion:'95.04.3E.00.8F',vendorId:4318,deviceId:10114,subsystemId:1090662512,revision:161,pciBusId:'00000000:01:00.0',dedicatedMemoryBytes:12884901888,sharedMemoryBytes:17179869184,dedicatedMemoryUsedBytes:4096,sharedMemoryUsedBytes:0,temperatureCelsius:47.5,coreClockMhz:2400.25,memoryClockMhz:10501.5,powerWatts:125.25,powerLimitWatts:285,fanPercent:0,pcieGeneration:4,pcieMaxGeneration:4,pcieLinkWidth:16,pcieMaxLinkWidth:16,memoryBusWidthBits:192,cudaCores:7680,sensorProvider:'nvidia-nvml'};
const invalidDetails=[
 ...['id','collectedAt'].flatMap(field=>[null,undefined,5,{}].map(value=>({[field]:value}))),
 {id:''},{id:'x'.repeat(129)},{id:'unreported-gpu'},
 ...['not-a-date','2026-02-30T10:00:00Z','2026-10-11','2026-10-11T10:00:00','x'.repeat(61)].map(collectedAt=>({collectedAt})),
 ...detailStrings.flatMap(([field,max])=>['x'.repeat(max+1),42,{},[]].map(value=>({[field]:value}))),
 ...detailIntegers.flatMap(([field,min,max])=>[min-1,max+1,min+0.5,Infinity,-Infinity,NaN,'1',{},true].map(value=>({[field]:value}))),
 ...detailMetrics.flatMap(([field,min,max])=>[min-0.1,max+0.1,Infinity,-Infinity,NaN,'1',{},true].map(value=>({[field]:value}))),
 ...['nvml','other',1,{}].map(sensorProvider=>({sensorProvider})),
 {name:'unexpected identity field'},{utilization:50},{futureUnknownField:true}
];
const diagnostics=[],previousError=console.error;
try{
 check(telemetry.parse(snapshot).gpus,undefined,'agents without GPU telemetry remain compatible');
 check(telemetry.parse({...snapshot,gpus:[]}).gpus,[],'no supported physical GPU is an empty array');
 check(telemetry.parse({...snapshot,gpus}).gpus,gpus,'all supported vendors, bounds and unavailable utilization survive validation');
 const bounded={...gpu,id:'i'.repeat(128),name:'n'.repeat(256),collectedAt:plusTwoHours(clock-3600000)};
 check(telemetry.parse({...snapshot,gpus:Array.from({length:16},(_,index)=>({...bounded,id:('gpu-'+index).padEnd(128,'i')}))}).gpus.length,16,'16 GPUs and maximum string lengths remain valid');
 for(const changed of invalidGpuFields)check(telemetry.safeParse({...snapshot,gpus:[{...gpu,...changed}]}).success,false,'invalid GPU field '+Object.keys(changed)[0]+' is rejected');
 for(const list of invalidLists)check(telemetry.safeParse({...snapshot,gpus:list}).success,false,'malformed, duplicate or unbounded GPU arrays are rejected');
 check(telemetry.parse(snapshot).gpuDetails,undefined,'old agents do not gain fabricated diagnostics');
 check(telemetry.parse({...snapshot,gpuDetails:[]}).gpuDetails,[],'an empty optional diagnostics inventory remains compatible with no GPUs');
 for(const value of [detail,nullDetails,fullDetails])check(telemetry.parse({...snapshot,gpus,gpuDetails:[value]}).gpuDetails,[value],'required-only, nullable and populated GPU diagnostics survive without invented fields');
 for(const provider of ['windows','nvidia-nvml',null])check(telemetry.parse({...snapshot,gpus,gpuDetails:[{...detail,sensorProvider:provider}]}).gpuDetails[0].sensorProvider,provider,'supported optional diagnostic providers remain explicit');
 for(const [field,max] of detailStrings)for(const value of ['',null,'x'.repeat(max)])check(telemetry.parse({...snapshot,gpus,gpuDetails:[{...detail,[field]:value}]}).gpuDetails[0][field],value,'bounded nullable string '+field+' retains its original value');
 for(const [field,min,max] of [...detailIntegers,...detailMetrics])for(const value of [min,max,null])check(telemetry.parse({...snapshot,gpus,gpuDetails:[{...detail,[field]:value}]}).gpuDetails[0][field],value,'diagnostic bounds and unknown '+field+' are exact');
 for(const [field,min] of detailMetrics)check(telemetry.parse({...snapshot,gpus,gpuDetails:[{...detail,[field]:min+0.25}]}).gpuDetails[0][field],min+0.25,'sensor '+field+' supports finite fractional readings');
 const sixteen=Array.from({length:16},(_,index)=>({...gpu,id:('diagnostic-'+index).padEnd(128,'i')})),sixteenDetails=sixteen.map(item=>({...nullDetails,id:item.id}));
 check(telemetry.parse({...snapshot,gpus:sixteen,gpuDetails:sixteenDetails}).gpuDetails,sixteenDetails,'16 bounded physical identities can carry separate optional diagnostics');
 const futureDetails={...fullDetails,collectedAt:new Date(clock+600000).toISOString()},offsetDetails={...fullDetails,collectedAt:plusTwoHours(clock-3600000)};
 for(const value of [futureDetails,offsetDetails])check(telemetry.parse({...snapshot,gpus,gpuDetails:[value]}).gpuDetails,[value],'diagnostic timestamps retain offsets/future times for frontend freshness handling');
 for(const changed of invalidDetails)check(telemetry.safeParse({...snapshot,gpus,gpuDetails:[{...detail,...changed}]}).success,false,'malformed, orphaned or out-of-bounds detail '+Object.keys(changed)[0]+' is rejected');
 for(const value of [null,{},[null],[[]],[detail,detail],Array(17).fill(detail)])check(telemetry.safeParse({...snapshot,gpus,gpuDetails:value}).success,false,'diagnostic containers reject malformed entries, duplicate IDs and excessive counts');
 for(const gpus of [undefined,[]])check(telemetry.safeParse({...snapshot,gpus,gpuDetails:[detail]}).success,false,'nonempty diagnostics require the corresponding physical GPU');

 // GPU history is an optional column: a CPU/RAM sample without GPU data keeps SQL NULL,
 // and the server/time history index serves the history reads.
 await d.exec(sql`INSERT INTO samples(server_id,at,cpu,memory) VALUES(${'existing-device'},${clock},${0},${100})`);
 check(await d.one(sql`SELECT server_id,at,cpu,memory,gpus FROM samples WHERE server_id=${'existing-device'}`),{server_id:'existing-device',at:clock,cpu:0,memory:100,gpus:null},'a CPU/RAM sample without GPU data stores no invented GPU data');
 check(!!await d.one(sql`SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='samples' AND indexname='idx_samples_server_at'`),true,'the server/time history index exists');
 await d.exec(sql`DELETE FROM samples WHERE server_id=${'existing-device'}`);
 const currentMeta=JSON.parse(readFileSync(resolve(root,'drizzle/meta/0000_snapshot.json'),'utf8'));
 check(currentMeta.tables['public.samples'].columns.gpus.notNull,false,'schema metadata keeps GPU history nullable');
 for(const value of [undefined,null,42,'','not-json','null','{}','[null]',JSON.stringify([gpu,gpu]),JSON.stringify([{...gpu,utilization:101}]),' '.repeat(65537)])check(parseGpuHistory(value),undefined,'damaged or legacy optional GPU history stays unknown');
 check(parseGpuHistory('[]'),[],'an explicit empty inventory remains empty');check(parseGpuHistory(JSON.stringify(gpus)),gpus,'history parser preserves measurements and physical identities exactly');

 const serverId=randomUUID(),token=randomBytes(32).toString('hex'),tokenHash=createHash('sha256').update(token).digest('hex');
 await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,token_expires_at) VALUES(${serverId},${'GPU fixture'},${tokenHash},${clock},${clock+7*86400000})`);
 const state=()=>d.one(sql`SELECT snapshot,last_seen,management,agent_public_key FROM servers WHERE id=${serverId}`);
 const samples=()=>d.one(sql`SELECT count(*) AS n FROM samples WHERE server_id=${serverId}`).then(row=>row===null?null:row.n);
 const latestGpu=()=>d.one(sql`SELECT gpus FROM samples WHERE server_id=${serverId} ORDER BY at DESC LIMIT 1`).then(row=>row===null?null:row.gpus);
 const stored=async()=>JSON.parse((await state()).snapshot);
 const request=raw=>new Request('https://fixture.test/api/heartbeat',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:raw});
 const body=changes=>JSON.stringify({serverId,snapshot:{...snapshot,...changes},results:[]});
 async function send(changes){clock+=11000;const response=await heartbeat.POST(request(body(changes)));check(response.status,200,await response.text());}
 // Pending jobs expire once MAX(created_at,not_before) is older than 5 minutes at the heartbeat's own time.
 const heartbeatAt=clock+11000,expiring=randomUUID(),boundary=randomUUID(),pendingJob=id=>d.one(sql`SELECT state,result FROM jobs WHERE id=${id}`);
 for(const [id,age] of [[expiring,300001],[boundary,300000]])await d.exec(sql`INSERT INTO jobs(id,server_id,action,target,created_at,not_before,actor,actor_email,actor_principal,parameters) VALUES(${id},${serverId},'refresh','Inventory',${heartbeatAt-age},0,'owner','owner@gpu.test','private:owner@gpu.test','{}')`);
 await send({});check((await stored()).gpus,undefined,'actual legacy heartbeat stores no invented GPU data');check(await latestGpu(),null,'legacy heartbeat stores SQL NULL in GPU history');
 check(clock,heartbeatAt,'the heartbeat runs at the planned time');
 check(await pendingJob(expiring),{state:'expired',result:'serverMessage.job.pendingExpired'},'a pending job older than 5 minutes expires on heartbeat');
 check((await pendingJob(boundary)).state,'pending','a pending job exactly 5 minutes old stays pending');
 await send({gpus:[]});check((await stored()).gpus,[],'actual heartbeat stores an empty GPU inventory');check(JSON.parse(await latestGpu()),[],'empty GPU inventory is recorded without zero load');
 await send({gpus});check((await stored()).gpus,gpus,'actual heartbeat persists GPU identity, vendor, utilization and timestamp');check(JSON.parse(await latestGpu()),gpus,'one heartbeat atomically records all per-GPU values, including zero/full/null');
 await send({gpus:[{...gpu,utilization:61.25}]});check((await stored()).gpus,[{...gpu,utilization:61.25}],'latest GPU inventory replaces the prior JSON snapshot');
 const before=await state(),sampleCount=await samples();
 // The route emits bounded field diagnostics for expected invalid payloads.
 console.error=(...values)=>diagnostics.push(values);
 const invalidBodies=[
  ...invalidLists.map(gpus=>body({gpus})),
  ...invalidGpuFields.filter(changed=>!Object.hasOwn(changed,'utilization')||!['number'].includes(typeof changed.utilization)||Number.isFinite(changed.utilization)).map(changed=>body({gpus:[{...gpu,...changed}]})),
  body({gpus:[{...gpu,utilization:'overflow'}]}).replace('"overflow"','1e999'),
  body({gpus:[{...gpu,utilization:'overflow'}]}).replace('"overflow"','-1e999'),
  body({gpus:[{...gpu,utilization:'invalid-json'}]}).replace('"invalid-json"','NaN')
 ];
 for(const raw of invalidBodies){const response=await heartbeat.POST(request(raw));check(response.status,400,await response.text());check(await state(),before,'invalid GPU telemetry cannot overwrite registered inventory, last_seen or identity');check(await samples(),sampleCount,'invalid GPU telemetry cannot insert performance samples');}
 check(diagnostics.length>0,true,'invalid requests exercise the real route diagnostics');
 await send({});check((await stored()).gpus,undefined,'a subsequent old-agent heartbeat remains valid and removes stale GPU values');check(await latestGpu(),null,'old agent does not copy previous GPU measurements into a new history point');

 // Diagnostics are persisted only in the current snapshot; samples retain the
 // unchanged small core inventory and its existing 64KiB database constraint.
 const diagnosticStart=(await samples()),diagnosticCore=JSON.stringify(gpus);
 for(const value of [detail,nullDetails,fullDetails,futureDetails,offsetDetails]){
  await send({agentVersion:'4.6.6',gpus,gpuDetails:[value]});
  check((await stored()).gpuDetails,[value],'real heartbeat preserves original nullable/sensor/metadata diagnostics');
  check(await latestGpu(),diagnosticCore,'diagnostic fields do not enlarge or modify historical GPU JSON');
 }
 const historyAtDiagnostic=(await d.query(sql`SELECT gpus FROM samples WHERE server_id=${serverId} ORDER BY at`)).slice(-5);
 check(historyAtDiagnostic.map(row=>parseGpuHistory(row.gpus)),Array(5).fill(gpus),'safe historical parser remains core-only after diagnostics snapshots');
 const beforeDetails=await state(),beforeDetailsCount=await samples();
 const invalidDetailBodies=[
  ...invalidDetails.filter(changed=>!Object.values(changed).some(value=>typeof value==='number'&&!Number.isFinite(value))).map(changed=>body({gpus,gpuDetails:[{...detail,...changed}]})),
  ...[null,{},[null],[[]],[detail,detail],Array(17).fill(detail)].map(gpuDetails=>body({gpus,gpuDetails})),
  body({gpuDetails:[detail]}),body({gpus:[],gpuDetails:[detail]}),
  ...detailMetrics.flatMap(([field])=>[body({gpus,gpuDetails:[{...detail,[field]:'overflow'}]}).replace('"overflow"','1e999'),body({gpus,gpuDetails:[{...detail,[field]:'overflow'}]}).replace('"overflow"','-1e999')]),
  ...detailIntegers.map(([field])=>body({gpus,gpuDetails:[{...detail,[field]:'overflow'}]}).replace('"overflow"','1e999'))
 ];
 for(const raw of invalidDetailBodies){const response=await heartbeat.POST(request(raw));check(response.status,400,await response.text());check(await state(),beforeDetails,'invalid diagnostics cannot overwrite a valid snapshot or identity');check(await samples(),beforeDetailsCount,'invalid diagnostics cannot add or mutate historical measurements');}
 await send({gpus});check((await stored()).gpuDetails,undefined,'a new core-only agent heartbeat removes outdated diagnostic fields');check(await latestGpu(),diagnosticCore,'core-only history remains compatible after a detailed agent');
 const detailSampleCount=(await samples())-diagnosticStart;

 const insert=(table,row)=>insertRow(d,table,row);
 async function user(name){
  const id=randomUUID(),principal='private:'+name+'@gpu.test',sessionHash=randomUUID(),mfaHash=randomUUID();
  await insert('local_users',{id,username:name,display_name:name,auth_principal:principal,auth_email:name+'@gpu.test',status:'active',created_at:clock,updated_at:clock});
  await insert('mfa_accounts',{principal,secret_enc:'fixture',recovery_hashes:'[]',last_counter:0,created_at:clock});
  await insert('mfa_sessions',{token_hash:mfaHash,principal,created_at:clock,last_activity:clock,idle_expires_at:clock+3600000,expires_at:clock+3600000});
  await insert('local_auth_sessions',{token_hash:sessionHash,user_id:id,auth_version:1,created_at:clock,expires_at:clock+3600000,pending_until:0,mfa_hash:mfaHash});
  return {id,principal,label:name+'@gpu.test',permissions:[],authorization:{authVersion:1,sessionHash}};
 }
 async function grant(actor,scopeType,scopeId){const role=randomUUID(),assignment=randomUUID();await insert('rbac_roles',{id:role,name:role,permissions:'["view"]',created_at:clock});await insert('role_assignments',{id:assignment,principal_type:'user',principal_id:actor.id,role_id:role,scope_type:scopeType,scope_id:scopeId,created_at:clock,created_by:'fixture'});return assignment;}
 const getHistory=id=>history.GET(new Request('https://fixture.test/api/history?serverId='+id));
 async function historySamples(id=serverId){const response=await getHistory(id);check(response.status,200,await response.clone().text());check(response.headers.get('cache-control'),'no-store','history must not be cached');return(await response.json()).samples;}
 check((await getHistory(serverId)).status,401,'anonymous clients cannot read GPU history');
 viewer=await user('scoped-reader');const directAssignment=await grant(viewer,'device',serverId);
 let historical=await historySamples();check(historical.length,5+detailSampleCount,'history includes every admitted heartbeat');check(historical[0].gpus,undefined,'legacy samples do not gain fabricated GPU readings');check(historical[1].gpus,[],'empty physical inventory stays distinct from missing telemetry');check(historical[2].gpus,gpus,'history route returns original IDs/names/null/zero/full/timestamps');check(historical[3].gpus,[{...gpu,utilization:61.25}],'successive sample values are independent');check(historical.map(sample=>sample.at),[...historical.map(sample=>sample.at)].sort((a,b)=>a-b),'history remains chronological');check(historical.every(sample=>sample.gpuDetails===undefined&&sample.gpus?.every(item=>Object.keys(item).length===5)!==false),true,'the history route exposes only core GPU records, never diagnostic metadata');
 const escaped=Array.from({length:16},(_,index)=>({...gpu,id:'\u0001'.repeat(126)+String(index).padStart(2,'0'),name:'\u0002'.repeat(256),collectedAt:plusTwoHours(clock-3600000)}));
 check(JSON.stringify(escaped).length>16384,true,'valid escaped GPU identities/names exceed a too-small 16KiB bound');
 await send({gpus:escaped});check((await historySamples()).at(-1).gpus,escaped,'64KiB bound allows every valid escaped 16-GPU inventory and preserves ISO offsets');
 const sampleInsert=(at,gpus)=>d.one(sql`INSERT INTO samples(server_id,at,cpu,memory,gpus) VALUES(${serverId},${at},0,100,${gpus}) RETURNING id`);
 for(const raw of ['broken','{}','null',JSON.stringify(Array(17).fill(gpu)),' '.repeat(65537)])await assert.rejects(()=>sampleInsert(clock,raw),/constraint|CHECK/i);
 await sampleInsert(clock+1,'[null]');await sampleInsert(clock+2,JSON.stringify([gpu,gpu]));
 historical=await historySamples();check(historical.at(-2).gpus,undefined,'damaged array entry cannot invent a valid GPU load');check(historical.at(-1).gpus,undefined,'duplicate stored physical IDs cannot be returned as distinct GPUs');check(historical.at(-1).cpu,0,'optional damaged GPU history does not discard valid CPU/RAM values');
 const outside=randomUUID();await insert('servers',{id:outside,name:'Other device',token_hash:'other',created_at:clock});await insert('samples',{server_id:outside,at:clock,cpu:10,memory:20,gpus:JSON.stringify(gpus)});
 check((await getHistory(outside)).status,403,'a device-scoped viewer cannot read another device history');check((await getHistory('not-a-guid')).status,400,'malformed history target remains rejected');check((await getHistory(randomUUID())).status,404,'missing devices remain rejected');
 // Inherited group visibility still reaches descendant device history.
 const rootGroup=randomUUID(),childGroup=randomUUID();await insert('device_groups',{id:rootGroup,name:'Root',created_at:clock});await insert('device_groups',{id:childGroup,name:'Child',parent_id:rootGroup,created_at:clock});await insert('device_group_members',{server_id:serverId,group_id:childGroup});
 viewer=await user('group-reader');const inheritedAssignment=await grant(viewer,'devicegroup',rootGroup);check((await historySamples()).length,historical.length,'parent group view permission includes descendant GPU history');check((await getHistory(outside)).status,403,'inherited view remains scoped');
 beforeHistoryRead=()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${inheritedAssignment}`);check(await historySamples(),[],'role revocation between preflight and history SELECT suppresses all readings');
 const restored=await grant(viewer,'devicegroup',rootGroup);beforeHistoryRead=()=>d.exec(sql`UPDATE local_users SET auth_version=auth_version+1 WHERE id=${viewer.id}`);check(await historySamples(),[],'captured identity version cannot read GPU history after credential reset');
 await d.exec(sql`UPDATE local_users SET auth_version=1 WHERE id=${viewer.id}`);
 beforeHistoryRead=()=>d.exec(sql`DELETE FROM mfa_sessions WHERE principal=${viewer.principal}`);check(await historySamples(),[],'MFA session revocation suppresses the captured history read');
 await d.exec(sql`DELETE FROM role_assignments WHERE id=${restored}`);
 viewer=await user('limit-reader');await grant(viewer,'device',serverId);
 const oldId=(await sampleInsert(clock-86400001,JSON.stringify(gpus))).id;
 check((await historySamples()).some(sample=>sample.at===clock-86400001),false,'history excludes samples beyond 24 hours');
 // Audit and job retention moved to `selfhost.mjs maintenance`; the heartbeat must not delete them.
 const stale=clock-40*86400000,staleAudit=(await d.one(sql`INSERT INTO audit(at,actor,action,target,server_id,scope) VALUES(${stale},'agent','device.test','target',${serverId},'device') RETURNING id`)).id,staleJobs=[randomUUID(),randomUUID()];
 for(const [id,owner] of [[staleJobs[0],serverId],[staleJobs[1],randomUUID()]])await d.exec(sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,actor) VALUES(${id},${owner},'refresh','target','succeeded',${stale},'tester')`);
 await send({gpus});check(await d.one(sql`SELECT id FROM samples WHERE id=${oldId}`),null,'heartbeat retains the existing 24-hour deletion policy for GPU samples');
 check(await d.one(sql`SELECT id FROM audit WHERE id=${staleAudit}`).then(row=>row===null?null:row.id),staleAudit,'heartbeat no longer deletes 40-day-old audit rows');
 for(const id of staleJobs)check(await d.one(sql`SELECT id FROM jobs WHERE id=${id}`).then(row=>row===null?null:row.id),id,'heartbeat no longer deletes 40-day-old finished jobs of this or another device');
 const rows=Array.from({length:3010},(_,index)=>sql`INSERT INTO samples(server_id,at,cpu,memory,gpus) VALUES(${serverId},${clock-index-1},1,2,${JSON.stringify([{...gpu,utilization:index%101}])})`);await inTransaction(d,rows);
 historical=await historySamples();check(historical.length,3000,'history still limits responses to the newest 3000 samples');check(historical.at(-1).at,clock,'newest sample survives chronological reversal');check(historical.every(sample=>sample.serverId===serverId&&sample.at>clock-86400000),true,'GPU history remains device-scoped and within its retention window');
 // Revocation/key changes after heartbeat preflight cannot add GPU history.
 let beforeCount=await samples();const beforeSnapshot=(await state()).snapshot;
 beforeHeartbeatBatch=()=>d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${serverId}`);clock+=11000;
 let response=await heartbeat.POST(request(body({gpus})));check(response.status,403,'revocation race rejects the real heartbeat batch');check(await samples(),beforeCount,'revoked heartbeat cannot insert CPU/RAM/GPU sample');check((await state()).snapshot,beforeSnapshot,'revoked heartbeat cannot change snapshot');
 await d.exec(sql`UPDATE servers SET revoked=0 WHERE id=${serverId}`);beforeCount=await samples();beforeHeartbeatBatch=()=>d.exec(sql`UPDATE servers SET agent_public_key=${'changed-key'} WHERE id=${serverId}`);clock+=11000;
 response=await heartbeat.POST(request(body({gpus})));check(response.status,409,'pinned identity change rejects the GPU sample batch');check(await samples(),beforeCount,'a different pinned key cannot insert GPU history');
 check(await d.one(sql`SELECT id FROM role_assignments WHERE id=${directAssignment}`).then(row=>row===null?null:row.id),directAssignment,'GPU writes never mutate portal role assignments');
 console.error=previousError;
 console.log(`PASS GPU telemetry/history/diagnostics (${checks} assertions): strict bounded nullable linked diagnostics in current snapshots, unchanged core-only GPU history, a nullable GPU history column, real heartbeat persistence/auth races, 5-minute pending job expiry, inherited live RBAC/MFA, 24-hour retention and 3000 samples.`);
}finally{console.error=previousError;d.close();}
