// Fractional agent numbers on PostgreSQL. Agent 4.10.1 sends CPU and
// RAM as fractions (cpu 6.42); samples.cpu/memory are integer columns, so every
// heartbeat failed with 22P02 and the device went offline. Runs the real
// heartbeat route, lib/server/agent/heartbeat.ts, the alarm sync (lib/server/devices/alerts.ts) and the
// software ingest against a test database:
// - a payload generated from the zod telemetry schema, with a fractional value
//   in every non-integer number field, is stored with 200, the snapshot keeps
//   the exact values, the sample row holds the rounded CPU/RAM and the GPU JSON;
// - the same payload opens and updates alarms and a software report with the
//   largest allowed numbers is stored, all without a logged error;
// - rounding half up, a null CPU stays null;
// - the history write runs after the core commit: a failing sample insert or a
//   failing software check keeps the answer 200 and the core state, a failing
//   core update still answers 500, and two parallel heartbeats give one sample;
// - a dev agent (agentVersion X.Y.Z-dev.<sha7>) with a dev plugin is stored with
//   its full versions; every other suffix is refused.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,insertRow,createTrigger,dropTrigger} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {HttpError} from '../support/http-error.mjs';
import {serverText} from '../support/server-text.mjs';

const uuid=()=>crypto.randomUUID(),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const customerA='00000000-0000-4000-8000-000000000100',minute=60_000;
let clock=Date.UTC(2026,9,28,9,0,0),times=[],checks=0,barrier=null;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const d=await sourceDatabase();
// Every transaction can wait on a barrier (the parallel heartbeat case).
const db=hookDatabase(d,{transaction:async()=>{if(barrier)await barrier();}});
const server={db:()=>db,now:()=>times.length?times.shift():clock,config:()=>'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>sha(value),guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),HttpError,
 body:async request=>{const text=await request.text();try{return JSON.parse(text);}catch{throw new HttpError('apiError.request.invalidJson');}},
 sameOrigin:()=>{},requireViewer:async()=>{throw new HttpError('apiError.auth.loginRequired');},log:async()=>{},
 failure:error=>error instanceof HttpError?Response.json({error:error.message,code:error.code,messageKey:error.messageKey},{status:error.status}):Response.json({error:serverText('apiError.internalError',{reference:'test'}),code:'INTERNAL_ERROR'},{status:500})};
const mfa={requireLiveSessions:async()=>{},requireMfa:async()=>{},isMfaEnabled:async()=>true,mfaSessionFence:async()=>sql`TRUE`,readMfaManagementProof:async()=>({guard:sql`TRUE`})};
const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'../identity/mfa':mfa,'./mfa':mfa,'@/lib/server/identity/mfa':mfa};
const load=sourceLoader();
const {telemetry}=load('lib/server/agent/telemetry.ts',imports),inventory=load('lib/software-inventory.ts',imports);
const heartbeatApi=load('app/api/heartbeat/route.ts',imports),softwareApi=load('app/api/agent/software/route.ts',imports);
// A second loader whose software check throws.
const brokenSoftware={softwareResyncNeeded:async()=>{throw new Error('software-state-down');}};
const brokenHeartbeatApi=sourceLoader()('app/api/heartbeat/route.ts',{...imports,'@/lib/server/devices/software':brokenSoftware,'./software':brokenSoftware});

// ---- Payload generator: walks a zod 4 schema (schema._zod.def) ----
const def=schema=>schema._zod.def;
const checksOf=schema=>(def(schema).checks??[]).map(check=>check._zod.def);
function numberRange(schema){
 // z.int() is a number with an integer format; z.number().int() adds an integer format check.
 let lo=-Infinity,hi=Infinity,loOpen=false,hiOpen=false,int=['safeint','int32','uint32'].includes(def(schema).format);
 for(const c of checksOf(schema)){
  if(c.check==='greater_than'){lo=c.value;loOpen=!c.inclusive;}
  else if(c.check==='less_than'){hi=c.value;hiOpen=!c.inclusive;}
  else if(c.check==='number_format'&&['safeint','int32','uint32'].includes(c.format))int=true;
 }
 return {lo,hi,loOpen,hiOpen,int};
}
/** The minimum array length: the largest of min_length and length_equals. */
function arrayLength(schema){
 let length=0;
 for(const c of checksOf(schema)){if(c.check==='min_length')length=Math.max(length,c.minimum);else if(c.check==='length_equals')length=Math.max(length,c.length);}
 return length;
}
/** Counts the number leaves of a schema: fractional (no int check) and integer, every array element once. */
function numberLeaves(schema,count={fractional:[],integer:[]},at=''){
 const x=def(schema);
 switch(x.type){
  case 'object':for(const [key,value] of Object.entries(x.shape))numberLeaves(value,count,at?`${at}.${key}`:key);break;
  case 'array':numberLeaves(x.element,count,`${at}.0`);break;
  case 'optional':case 'nullable':case 'default':case 'prefault':numberLeaves(x.innerType,count,at);break;
  // A transform is a pipe from the input schema; the input holds the agent's fields.
  case 'pipe':numberLeaves(x.in,count,at);break;
  case 'union':x.options.forEach((option,index)=>numberLeaves(option,count,`${at}|${index}`));break;
  case 'record':numberLeaves(x.valueType,count,`${at}.*`);break;
  case 'number':(numberRange(schema).int?count.integer:count.fractional).push(at);break;
 }
 return count;
}
/**
 * A valid value for every field: optional and nullable fields are filled, every
 * array gets its minimum length (at least one element), every number without an
 * int check gets a fractional value inside its range and every int field an
 * in-range integer. Strings take the first candidate the field accepts.
 * `produced` collects the paths of the fractional values.
 */
function generate(schema,produced,at=''){
 const x=def(schema);
 switch(x.type){
  case 'object':return Object.fromEntries(Object.entries(x.shape).map(([key,value])=>[key,generate(value,produced,at?`${at}.${key}`:key)]));
  case 'array':{const length=Math.max(1,arrayLength(schema));return Array.from({length},(_,index)=>generate(x.element,index===0?produced:[],`${at}.${index}`));}
  case 'optional':case 'nullable':case 'default':case 'prefault':return generate(x.innerType,produced,at);
  case 'pipe':return generate(x.in,produced,at);
  case 'union':return generate(x.options[0],produced,at);
  case 'record':return {[generate(x.keyType,[],`${at}.*`)]:generate(x.valueType,produced,`${at}.*`)};
  case 'boolean':return true;
  case 'literal':return x.values[0];
  case 'enum':return Object.values(x.entries)[0];
  case 'string':{
   const candidates=['Fixture',new Date(clock-minute).toISOString(),uuid(),'C:','0x1f','4.10.1','abc123','2026-01-15','a'.repeat(64),'A'.repeat(342),'0123456789abcdef','0123456789ABCDEF0123456789ABCDEF01234567','unknown','AGENT_PLUGIN_BUSY','S-1-5-21-1000-2000-3000'];
   const value=candidates.find(candidate=>schema.safeParse(candidate).success);
   if(value===undefined)throw new Error(`The payload generator has no string for ${at}; add a candidate.`);
   return value;
  }
  case 'number':{
   const {lo,hi,loOpen,int}=numberRange(schema);
   if(int){const low=Number.isFinite(lo)?(loOpen?Math.floor(lo)+1:Math.ceil(lo)):0;return Math.min(low+1,hi);}
   const base=Number.isFinite(lo)?lo:0;
   let value=Number.isFinite(hi)?base+(hi-base)*0.4137:base+4.37;
   value=Math.round(value*100)/100;
   if(Number.isInteger(value))value+=value+0.37<hi?0.37:-0.37;
   assert.ok(!Number.isInteger(value)&&value>=lo&&value<=hi,`fractional value for ${at}`);
   produced.push(at);return value;
  }
  default:throw new Error(`The payload generator does not know ${x.type} at ${at}.`);
 }
}

const agentKey=()=>{const jwk=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'});return {jwk,pinned:JSON.stringify({kty:jwk.kty,n:jwk.n,e:jwk.e})};};
/** The 4.10.1 payload with fractional numbers, made valid across the cross-field rules of the schema. */
function fractionalPayload(key,values={}){
 const produced=[],payload=generate(telemetry,produced);
 Object.assign(payload,{os:'Microsoft Windows Server 2025 Standard',agentVersion:'4.10.1',protocolVersion:3,mode:'Management',management:true,publicKey:{kty:'RSA',n:key.jwk.n,e:key.jwk.e},cpu:6.42,memory:41.37});
 payload.rebootPending=payload.rebootReasons.length>0;
 Object.assign(payload.processInventory,{count:payload.processes.length,truncated:false,complete:true});
 payload.hardware.complete=false;
 Object.assign(payload,values);
 const parsed=telemetry.safeParse(payload);
 assert.ok(parsed.success,`the generated payload is valid telemetry: ${JSON.stringify(parsed.error?.issues?.slice(0,5))}`);
 return {payload,produced};
}

const insert=(table,row)=>insertRow(d,table,row),agents=new Map();
async function device(name){
 const id=uuid(),token=crypto.randomBytes(32).toString('hex'),key=agentKey();
 await insert('servers',{id,name,token_hash:sha(token),token_expires_at:clock+365*24*60*minute,created_at:clock,last_seen:clock-minute,management:1,snapshot:null,agent_public_key:key.pinned,customer_id:customerA});
 agents.set(id,{token,key});return id;
}
const post=async(api,id,snapshot)=>{
 const {token}=agents.get(id);
 const response=await api.POST(new Request('https://fractions.test/api/heartbeat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({serverId:id,snapshot,results:[],runningJobs:[]})}));
 return {status:response.status,body:await response.json()};
};
const serverRow=id=>d.one(sql`SELECT last_seen AS "lastSeen",snapshot FROM servers WHERE id=${id}`);
const sampleRows=id=>d.query(sql`SELECT at,cpu,memory,gpus FROM samples WHERE server_id=${id} ORDER BY at`);
/** Runs `work` with console.error captured; returns the logged lines. */
async function logged(work){const lines=[],error=console.error;console.error=(...parts)=>lines.push(parts.join(' '));try{await work();}finally{console.error=error;}return lines;}

try{
 // ---- The schema walk itself ----
 const leaves=numberLeaves(telemetry);
 const {payload:probe,produced:probeFractions}=fractionalPayload(agentKey());
 check(probeFractions.length>=leaves.fractional.length,true,`the generator gives every non-integer number leaf a fraction (${probeFractions.length} of ${leaves.fractional.length})`);
 check(leaves.fractional.length>=32,true,'the telemetry schema still has its non-integer number leaves');
 for(const field of ['cpu','memory','memoryGb','uptimeSeconds','disks.0.totalGb','disks.0.freeGb','networks.0.speedMbps','processes.0.memoryMb','processes.0.cpuSeconds','processes.0.cpuPercent','gpus.0.utilization','gpuDetails.0.temperatureCelsius','gpuDetails.0.powerWatts','performance.diskLatencyMs','performance.pagefilePercent','bitlocker.volumes.0.percent','pagefile.files.0.currentUsageMb','events.0.id','tasks.0.lastResult','hardware.networkAdapters.0.speedMbps'])
  check(probeFractions.includes(field),true,`${field} gets a fractional value`);
 check([Number.isInteger(probe.cores),Number.isInteger(probe.processes[0].pid),Number.isInteger(probe.gpuDetails[0].pcieGeneration)],[true,true,true],'int fields get integers');

 // ---- A fractional 4.10.1 heartbeat ----
 const nfi=await device('NFI-WS01'),{key}=agents.get(nfi);
 // A CPU alarm below the fractional reading: the first beat inserts it as
 // pending, the second (after the duration) updates it to open.
 await insert('alert_rule_overrides',{id:uuid(),rule_id:'cpu',scope_type:'device',scope_id:nfi,enabled:1,warning:5,critical:90,level:null,duration_minutes:1,recovery:1,actor:'fixture',updated_at:clock});
 await insert('alert_rule_overrides',{id:uuid(),rule_id:'memory',scope_type:'device',scope_id:nfi,enabled:1,warning:40,critical:90,level:null,duration_minutes:0,recovery:1,actor:'fixture',updated_at:clock});
 const {payload}=fractionalPayload(key);
 let answer;
 const firstLog=await logged(async()=>{answer=await post(heartbeatApi,nfi,payload);});
 check(answer.status,200,`the fractional heartbeat is stored: ${JSON.stringify(answer.body)}`);
 check([answer.body.ok,answer.body.intervalSeconds,answer.body.softwareResync],[true,30,true],'answer with the software resync hint');
 check(firstLog,[],'no part of the heartbeat logged an error (history, alarm sync, software check)');
 let row=await serverRow(nfi);
 check(Number(row.lastSeen),clock,'last_seen is the request time');
 const stored=JSON.parse(row.snapshot);
 check([stored.cpu,stored.memory],[6.42,41.37],'the snapshot keeps the exact CPU and RAM');
 // Plugin reports are stored with target and without role (lib/server/agent/telemetry.ts pluginReports); the generator sends both with the same value.
 check(stored,{...payload,plugins:payload.plugins.map(plugin=>Object.fromEntries(Object.entries(plugin).filter(([key])=>key!=='role')))},'the snapshot keeps every fractional value');
 let samples=await sampleRows(nfi);
 check(samples.map(sample=>[Number(sample.at),Number(sample.cpu),Number(sample.memory)]),[[clock,6,41]],'one sample with CPU and RAM rounded');
 check(JSON.parse(samples[0].gpus),payload.gpus,'the sample keeps the GPU JSON');
 const alarms=()=>d.query(sql`SELECT rule_id AS "ruleId",state,peak_value AS "peakValue",threshold FROM alerts WHERE server_id=${nfi} AND rule_id IN ('cpu','memory') ORDER BY rule_id`);
 check(await alarms(),[{ruleId:'cpu',state:'pending',peakValue:6.42,threshold:5},{ruleId:'memory',state:'open',peakValue:41.37,threshold:40}],'the fractional readings insert alarms with exact peaks');
 check(Number((await d.one(sql`SELECT count(*) AS n FROM alerts WHERE server_id=${nfi}`)).n)>2,true,'more rules fire on the generated payload');
 clock+=2*minute;
 const secondLog=await logged(async()=>{answer=await post(heartbeatApi,nfi,{...payload,cpu:7.81});});
 check([answer.status,secondLog],[200,[]],'the second fractional heartbeat');
 check(await alarms(),[{ruleId:'cpu',state:'open',peakValue:7.81,threshold:5},{ruleId:'memory',state:'open',peakValue:41.37,threshold:40}],'the alarm update stores the fractional peak');

 // Software ingest: the report has integer numbers only; the largest allowed
 // ones are stored. A new non-integer field there must be covered here.
 check(numberLeaves(inventory.softwareReport).fractional,[],'the software report has no non-integer numbers (cover a new one in this test)');
 const items=[{key:'{A1}',name:'Fixture App',version:'1.2.3',publisher:'Vendor',installDate:'2026-01-15',architecture:'x64',scope:'machine'}];
 const software=await softwareApi.POST(new Request('https://fractions.test/api/agent/software',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+agents.get(nfi).token},body:JSON.stringify({serverId:nfi,checksum:await inventory.softwareChecksum(items),count:1_000_000,truncated:true,items})}));
 check(software.status,200,`the software report is stored: ${await software.clone().text()}`);
 check(Number((await d.one(sql`SELECT count FROM device_software_state WHERE server_id=${nfi}`)).count),1_000_000,'the largest count is stored');

 // Rounding half up; a null CPU stays null.
 clock+=minute;answer=await post(heartbeatApi,nfi,{...payload,cpu:41.5,memory:99.5});check(answer.status,200,'half values');
 clock+=minute;answer=await post(heartbeatApi,nfi,{...payload,cpu:null,memory:0.49});check(answer.status,200,'no CPU reading');
 samples=await sampleRows(nfi);
 check(samples.slice(-3).map(sample=>[sample.cpu===null?null:Number(sample.cpu),Number(sample.memory)]),[[8,41],[42,100],[null,0]],'7.81 → 8, 41.5 → 42, 99.5 → 100, null stays null, 0.49 → 0');

 // ---- A failing history write keeps the heartbeat ----
 await createTrigger(d,'samples_insert_fails','samples','BEFORE INSERT',{message:'samples-down'});
 const before=(await sampleRows(nfi)).length;
 clock+=minute;
 const historyLog=await logged(async()=>{answer=await post(heartbeatApi,nfi,{...payload,cpu:12.34});});
 await dropTrigger(d,'samples_insert_fails');
 check(answer.status,200,'a failing sample insert still answers 200');
 row=await serverRow(nfi);
 check([Number(row.lastSeen),JSON.parse(row.snapshot).cpu],[clock,12.34],'last_seen and snapshot are committed');
 check((await sampleRows(nfi)).length,before,'no sample row');
 check(historyLog.length,1,'one error line');
 check(historyLog[0].includes(nfi)&&historyLog[0].includes('samples-down'),true,'the line names the device and the error');
 check(/Fixture|NFI-WS01|12\.34/.test(historyLog[0]),false,'the line holds no snapshot data');

 // ---- A failing software check omits the hint ----
 clock+=minute;
 const softwareLog=await logged(async()=>{answer=await post(brokenHeartbeatApi,nfi,{...payload,softwareChecksum:'b'.repeat(64)});});
 check([answer.status,answer.body.ok,'softwareResync' in answer.body],[200,true,false],'a failing software check answers 200 without softwareResync');
 check(softwareLog.length===1&&softwareLog[0].includes(nfi)&&softwareLog[0].includes('software-state-down'),true,'the failure is logged once with device and error');
 check(Number((await serverRow(nfi)).lastSeen),clock,'the core state is stored');
 check(Number((await sampleRows(nfi)).at(-1).at),clock,'the sample is stored');

 // ---- A failing core update still answers 500 ----
 await createTrigger(d,'servers_update_fails','servers','BEFORE UPDATE',{message:'servers-down'});
 const coreBefore=await serverRow(nfi),coreSamples=(await sampleRows(nfi)).length;
 clock+=minute;
 await logged(async()=>{answer=await post(heartbeatApi,nfi,payload);});
 await dropTrigger(d,'servers_update_fails');
 check([answer.status,answer.body.code],[500,'INTERNAL_ERROR'],'the core failure answers 500');
 check([await serverRow(nfi),(await sampleRows(nfi)).length],[coreBefore,coreSamples],'and writes nothing');

 // ---- Two parallel heartbeats give exactly one sample ----
 {
  const gate=count=>{let waiting=0,open;const opened=new Promise(resolve=>{open=resolve;});return async()=>{if(++waiting>=count)open();await opened;};};
  clock+=minute;const at=clock;times=[at,at+1];barrier=gate(2);
  const results=await Promise.all([post(heartbeatApi,nfi,{...payload,cpu:21.4}),post(heartbeatApi,nfi,{...payload,cpu:33.6})]);barrier=null;times=[];
  check(results.map(result=>result.status).sort().join(),'200,429','one parallel heartbeat wins and one is throttled');
  const winner=await serverRow(nfi),latest=(await sampleRows(nfi)).filter(sample=>Number(sample.at)>=at);
  check(latest.length,1,'exactly one sample');
  check([Number(latest[0].at),Number(latest[0].cpu)],[Number(winner.lastSeen),Math.round(JSON.parse(winner.snapshot).cpu)],'the sample comes from the winner');
 }

 // ---- A rejected heartbeat writes no sample: the admission needs last_seen = its time ----
 {
  const lib=load('lib/server/agent/heartbeat.ts',imports),count=(await sampleRows(nfi)).length;
  const late=await lib.recordHeartbeatSample({serverId:nfi,tokenHash:sha(agents.get(nfi).token),time:clock+5,publicKey:key.pinned,cpu:1,memory:1,gpus:null});
  const foreignKey=await lib.recordHeartbeatSample({serverId:nfi,tokenHash:sha(agents.get(nfi).token),time:Number((await serverRow(nfi)).lastSeen),publicKey:agentKey().pinned,cpu:1,memory:1,gpus:null});
  const wrongToken=await lib.recordHeartbeatSample({serverId:nfi,tokenHash:sha('other'),time:Number((await serverRow(nfi)).lastSeen),publicKey:key.pinned,cpu:1,memory:1,gpus:null});
  check([late,foreignKey,wrongToken,(await sampleRows(nfi)).length],[false,false,false,count],'another time, key or token writes no sample');
 }

 // ---- Dev builds: X.Y.Z-dev.<sha7> as agentVersion and as a plugin version; every other form is refused ----
 {
  const dev=await device('DEV-AGENT'),{key:devKey}=agents.get(dev),plugin={...payload.plugins[0],version:'1.0.4-dev.abc1234'};
  const {payload:devPayload}=fractionalPayload(devKey,{agentVersion:'4.21.5-dev.abc1234',plugins:[plugin]});
  clock+=minute;answer=await post(heartbeatApi,dev,devPayload);
  check(answer.status,200,`a dev agent with a dev plugin is stored: ${JSON.stringify(answer.body)}`);
  const kept=JSON.parse((await serverRow(dev)).snapshot);
  check([kept.agentVersion,kept.plugins[0].version],['4.21.5-dev.abc1234','1.0.4-dev.abc1234'],'the full versions are kept');
  for(const agentVersion of ['4.21.5-dev.ABC1234','4.21.5-dev.abc123','4.21.5-rc.1','4.21.5-dev.abc1234.1','5.0.0-dev.abc1234'])check(telemetry.safeParse({...devPayload,agentVersion}).success,false,`agentVersion ${agentVersion} is refused`);
  for(const version of ['1.0.4-dev.ABC1234','1.0.4-dev.abc123','1.0.4-rc.1'])check(telemetry.safeParse({...devPayload,plugins:[{...plugin,version}]}).success,false,`plugin version ${version} is refused`);
  clock+=minute;const refusedLog=await logged(async()=>{answer=await post(heartbeatApi,dev,{...devPayload,agentVersion:'4.21.5-dev.abc123'});});
  check([answer.status,refusedLog.length],[400,1],'a heartbeat with a malformed dev agent version is refused');
 }

 console.log(`PASS heartbeat fractional values (${checks} checks): a 4.10.1 payload generated from the telemetry schema (${leaves.fractional.length} fractional fields) is stored with exact snapshot values, rounded samples, alarm inserts and updates and a software report; a failing history write or software check keeps 200 and the core state, a failing core update answers 500, two parallel heartbeats give one sample.`);
}finally{await d.close();}
