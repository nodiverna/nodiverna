// The agent routes with large bodies (channel, terminal, RDP, heartbeat, drift
// ingest) and the integrity route of agent 4.18.0 authenticate the device from its headers before they read a byte of
// the body, and the heartbeat's 10-second interval holds atomically inside its
// write batch. Runs the real routes, token SQL and heartbeat batch against
// an isolated PostgreSQL test database; only unrelated schedulers and payload handlers are idle.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import {z} from 'zod';
import {sourceDatabase,sourceLoader} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sql} from '../../runtime/database.mjs';
const d=await sourceDatabase();
let assertions=0;
const check=(actual,expected,message)=>{assert.equal(actual,expected,message);assertions++;};
try{
 const origin='https://serverdesk.test',owner='owner@auth-before-body.test',sha=value=>nodeCrypto.createHash('sha256').update(value).digest('hex');
 let clock=Date.parse('2026-10-21T08:00:00.000Z'),times=[];
 const HttpError=realHttpError;
 // Every body read goes through this stub: it records the route's size limit
 // and enforces it like lib/server/context.ts.
 const bodyCalls=[];
 const body=async(request,limit)=>{
  bodyCalls.push(limit);
  const text=await request.text();
  if(Buffer.byteLength(text)>limit)throw new HttpError(413,serverText('apiError.request.tooLarge'));
  try{const parsed=JSON.parse(text);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed;}catch{throw new HttpError(400,serverText('apiError.request.invalidJson'));}
 };
 // The database handle the routes see. A batch can wait on a barrier or run a
 // hook first; every batch result is recorded with its SQL.
 let barrier=null,beforeBatch=null;const batches=[];
 const facade=hookDatabase(d,{transaction:async()=>{if(beforeBatch)await beforeBatch();if(barrier)await barrier();},results:batches});
 const server={db:()=>facade,config:name=>({SITE_ORIGIN:origin})[name]??'',now:()=>times.length?times.shift():clock,hash:async value=>sha(value),random:()=>nodeCrypto.randomBytes(32).toString('hex'),guid:value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value),body,HttpError,failure:error=>{if(!(error instanceof HttpError))throw error;return Response.json({error:error.message,...(error.code?{code:error.code}:{})},{status:error.status});}};
 const idle=async()=>{},allow=sql`TRUE`,driftCalls=[];
 const load=sourceLoader(),imports={
  'cloudflare:workers':{env:{}},'@/lib/server/context':server,'../context':server,'./context':server,'../../context':server,
  '@/lib/server/automation/runbooks':{tickAutomation:idle},
  // The alarm state after a heartbeat runs its own transaction; tests/api/alerts.mjs covers it, the batch counts here stay the heartbeat's.
  '@/lib/server/devices/alerts':{syncDeviceAlerts:idle},
  // lib/server/agent/agent-integrity.ts imports the alarm sync relatively; tests/lib/agent-integrity.mjs covers it.
  '../devices/alerts':{syncDeviceAlerts:idle},
  '@/lib/server/automation/drift':{getDriftPolicy:async()=>null,ingestDrift:async(serverId,report)=>{driftCalls.push({serverId,report});return {ok:true,findings:0};}},
  '@/lib/server/devices/transfers':{verifyTransfer:idle,sweepTransfers:idle,transferAuthorizationGuard:()=>allow},
  '@/lib/server/devices/terminal-lifecycle':{sweepTerminalSessions:idle},
  '@/lib/server/devices/rdp':{sweepRdp:idle,rdpReport:z.object({id:z.guid()}),agentRdpExchange:async()=>({ok:true,sessions:[],intervalMs:1000})},
  '@/lib/server/devices/terminal-channel':{terminalReport:z.object({id:z.guid()}),exchangeTerminals:async()=>[]},
  '@/lib/server/automation/desired-state':{advanceDesiredState:idle,checkPendingDesiredJob:async()=>true,desiredJobClaimGuard:async()=>allow},
 };
 const route=file=>load(file,imports);
 const tokens=route('lib/server/agent/device-tokens.ts');
 const routes=[
  {name:'channel',path:'/api/agent/channel',post:route('app/api/agent/channel/route.ts').POST,limit:2097152,invalid:serverText('apiError.agent.invalidChannel')},
  {name:'terminal',path:'/api/agent/terminal',post:route('app/api/agent/terminal/route.ts').POST,limit:1572864,invalid:serverText('apiError.agent.invalidTerminalChannel')},
  {name:'rdp',path:'/api/agent/rdp',post:route('app/api/agent/rdp/route.ts').POST,limit:1500000,invalid:serverText('apiError.agent.invalidRdpChannel')},
  {name:'heartbeat',path:'/api/heartbeat',post:route('app/api/heartbeat/route.ts').POST,limit:2097152,invalid:serverText('apiError.heartbeat.invalidTelemetry',{fields:''})},
  {name:'drift',path:'/api/drift/ingest',post:route('app/api/drift/ingest/route.ts').POST,limit:2097152,invalid:serverText('apiError.agent.invalid')},
  {name:'integrity',path:'/api/agent/integrity',post:route('app/api/agent/integrity/route.ts').POST,limit:16384,invalid:serverText('apiError.agentIntegrity.invalid')},
 ];

 const agentKey=()=>{const jwk=nodeCrypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'});return {jwk,pinned:JSON.stringify({kty:jwk.kty,n:jwk.n,e:jwk.e})};};
 const capabilities=['refresh','terminal-live','terminal-multi','rdp-browser'];
 const telemetry=(key,cpu=10)=>({hostname:'VM',os:'Microsoft Windows Server 2025 Standard',build:'26100',manufacturer:'Microsoft',model:'VM',domain:'WORKGROUP',cores:4,memoryGb:8,cpu,memory:20,uptimeSeconds:300,rebootPending:false,management:true,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.6.7',mode:'Management',publicKey:{kty:'RSA',n:key.jwk.n,e:key.jwk.e},agentCapabilities:capabilities});
 const device=async({name='Device',key=agentKey(),pinned=true,expiresAt=clock+900000,lastSeen=clock-60000,created=clock}={})=>{
  const id=nodeCrypto.randomUUID(),token=nodeCrypto.randomBytes(32).toString('hex');
  await d.exec(sql`INSERT INTO servers(id,name,token_hash,token_expires_at,created_at,last_seen,management,snapshot,agent_public_key) VALUES (${id},${name},${sha(token)},${expiresAt},${created},${lastSeen},1,${lastSeen===null?null:JSON.stringify(telemetry(key))},${pinned?key.pinned:null})`);
  return {id,token,key};
 };
 const runningJob=async(serverId,lastProgress=clock-50000)=>{const id=nodeCrypto.randomUUID();await d.exec(sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,claimed_at,last_progress,actor,actor_email,actor_principal,parameters) VALUES (${id},${serverId},'refresh','Inventory','running',${clock-60000},${clock-60000},${lastProgress},${'owner'},${owner},${'private:'+owner},'{}')`);return id;};
 // A valid body per route for a device; `extra` adds the running job.
 const payload=(name,serverId,key,{cpu=10,jobs=[]}={})=>({
  channel:{serverId,results:[],runningJobs:jobs},
  terminal:{serverId,terminals:[]},
  rdp:{serverId,sessions:[]},
  heartbeat:{serverId,snapshot:telemetry(key,cpu),results:[],runningJobs:jobs},
  drift:{serverId,files:[]},
  integrity:{serverId,events:[{id:nodeCrypto.randomUUID(),kind:'service-stopped',at:new Date(clock).toISOString(),service:'worker'}]},
 })[name];
 // A body that records whether anything pulled from it. highWaterMark 0 keeps
 // the stream from pre-filling its queue when the Request is constructed.
 const streamed=text=>{const log={pulls:0},bytes=new TextEncoder().encode(text);let sent=false;return {log,stream:new ReadableStream({pull(controller){log.pulls++;if(sent){controller.close();return;}sent=true;controller.enqueue(bytes);}},{highWaterMark:0})};};
 const send=(item,{token,deviceId,authorization,json,extra={}})=>{
  const headers={'Content-Type':'application/json'};
  if(authorization!==undefined)headers.Authorization=authorization;else if(token)headers.Authorization='Bearer '+token;
  if(deviceId)headers['X-ServerDesk-Device-Id']=deviceId;
  Object.assign(headers,extra);
  const {log,stream}=streamed(json),request=new Request(origin+item.path,{method:'POST',headers,body:stream,duplex:'half'});
  return {log,request,response:item.post(request)};
 };
 const unread=async(item,options,status,code,message,label)=>{
  const calls=bodyCalls.length,{log,request,response}=send(item,options),result=await response,answer=await result.json();
  check(result.status,status,`${item.name}: ${label} status`);check(answer.code,code,`${item.name}: ${label} code`);check(answer.error,message,`${item.name}: ${label} message`);
  check(bodyCalls.length,calls,`${item.name}: ${label} never calls body()`);check(log.pulls,0,`${item.name}: ${label} never pulls the stream`);check(request.bodyUsed,false,`${item.name}: ${label} leaves the body unread`);
 };
 const large=(name,serverId,key)=>{const value=payload(name,serverId,key);return JSON.stringify({...value,padding:'x'.repeat(2_000_000)});};

 // Unknown, rejected or missing bearer never reads the body.
 {
  const pinned=await device({name:'Pinned'}),unknown='e'.repeat(64);
  for(const item of routes){
   const json=large(item.name,pinned.id,pinned.key);
   check(Buffer.byteLength(json)>2_000_000,true,'the probe body is about 2 MB');
   await unread(item,{token:unknown,json},403,'FORBIDDEN',serverText('apiError.agent.notApproved'),'unknown bearer');
   await unread(item,{token:unknown,deviceId:pinned.id,json},403,'DEVICE_TOKEN_REJECTED',serverText('apiError.agent.notApproved'),'wrong bearer for a pinned device header');
   await unread(item,{json},401,'UNAUTHORIZED',serverText('apiError.deviceToken.accessRequired'),'no Authorization header');
   await unread(item,{authorization:'Bearer xyz',json},401,'UNAUTHORIZED',serverText('apiError.deviceToken.accessRequired'),'malformed bearer');
   await unread(item,{authorization:'Basic '+'a'.repeat(64),json},401,'UNAUTHORIZED',serverText('apiError.deviceToken.accessRequired'),'other scheme');
  }
 }

 // The channel's uninstall confirmation reads headers only: an unknown or revoked
 // device with the device ID and uninstall job headers never reads the body, and
 // only a revoked device with its recent started uninstall job gets the code.
 {
  const channel=routes.find(item=>item.name==='channel'),unknown='e'.repeat(64);
  const revoked=await device({name:'Revoked'}),confirmed=await device({name:'Uninstalled'}),job=nodeCrypto.randomUUID(),other=nodeCrypto.randomUUID();
  await d.exec(sql`UPDATE servers SET revoked=1,token_hash=${'revoked:'+nodeCrypto.randomUUID()} WHERE id IN (${revoked.id},${confirmed.id})`);
  await d.exec(sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,claimed_at,last_progress,actor,actor_email,actor_principal,parameters,result_code) VALUES (${job},${confirmed.id},'agent-uninstall','','succeeded',${clock-60000},${clock-60000},${clock-30000},'owner',${owner},${'private:'+owner},'{}','AGENT_UNINSTALL_STARTED')`);
  const uninstall=id=>({'X-ServerDesk-Uninstall-Job':id});
  await unread(channel,{token:unknown,deviceId:nodeCrypto.randomUUID(),extra:uninstall(job),json:large('channel',revoked.id,revoked.key)},403,'FORBIDDEN',serverText('apiError.agent.notApproved'),'unknown device with the uninstall header');
  await unread(channel,{token:revoked.token,deviceId:revoked.id,extra:uninstall(other),json:large('channel',revoked.id,revoked.key)},403,'FORBIDDEN',serverText('apiError.agent.notApproved'),'revoked device with an unknown uninstall job');
  await unread(channel,{token:unknown,deviceId:revoked.id,extra:uninstall(job),json:large('channel',revoked.id,revoked.key)},403,'FORBIDDEN',serverText('apiError.agent.notApproved'),'revoked device with the job of another device');
  await unread(channel,{token:unknown,deviceId:confirmed.id,extra:uninstall(job),json:large('channel',confirmed.id,confirmed.key)},403,'AGENT_UNINSTALL_CONFIRMED',serverText('apiError.agent.uninstallConfirmed'),'revoked device with its started uninstall job');
  await unread(channel,{token:unknown,extra:uninstall(job),json:large('channel',confirmed.id,confirmed.key)},403,'FORBIDDEN',serverText('apiError.agent.notApproved'),'uninstall header without the device ID header');
 }

 // The rejection codes survive without the device header. A token without
 // expiry is rejected on every route, the heartbeat included.
 {
  const expiredMessage=tokens.registrationExpiredMessage;
  for(const item of routes){
   const expired=await device({name:'Expired registration',pinned:false,lastSeen:null,expiresAt:clock-1});
   await unread(item,{token:expired.token,json:large(item.name,expired.id,expired.key)},403,'DEVICE_REGISTRATION_EXPIRED',expiredMessage,'expired registration without header');
   await unread(item,{token:expired.token,deviceId:expired.id,json:large(item.name,expired.id,expired.key)},403,'DEVICE_REGISTRATION_EXPIRED',expiredMessage,'expired registration with header');
   const rotated=await device({name:'Rotated'});
   await d.exec(sql`UPDATE servers SET previous_token_hash=token_hash,previous_token_expires_at=${clock-1},token_hash=${sha('f'.repeat(64))} WHERE id=${rotated.id}`);
   await unread(item,{token:rotated.token,json:large(item.name,rotated.id,rotated.key)},403,'DEVICE_TOKEN_REJECTED',serverText('apiError.agent.notApproved'),'previous token past its overlap without header');
   const unlimited=await device({name:'Pinned without expiry',expiresAt:null});
   await unread(item,{token:unlimited.token,json:large(item.name,unlimited.id,unlimited.key)},403,'DEVICE_TOKEN_REJECTED',serverText('apiError.agent.notApproved'),'token without expiry without header');
   await unread(item,{token:unlimited.token,deviceId:unlimited.id,json:large(item.name,unlimited.id,unlimited.key)},403,'DEVICE_TOKEN_REJECTED',serverText('apiError.agent.notApproved'),'token without expiry with header');
  }
 }

 // A valid token whose device differs from the body's serverId writes nothing.
 {
  const a=await device({name:'Device A'}),b=await device({name:'Device B'}),jobA=await runningJob(a.id),jobB=await runningJob(b.id);
  const state=async()=>JSON.stringify({
   servers:(await d.query(sql`SELECT id,last_seen,snapshot,agent_public_key,token_hash FROM servers WHERE id IN (${a.id},${b.id}) ORDER BY id`)),
   samples:(await d.query(sql`SELECT server_id,at,cpu FROM samples WHERE server_id IN (${a.id},${b.id}) ORDER BY server_id,at`)),
   channels:(await d.query(sql`SELECT server_id,last_at FROM agent_channels WHERE server_id IN (${a.id},${b.id},${'terminal:'+a.id},${'terminal:'+b.id}) ORDER BY server_id`)),
   jobs:(await d.query(sql`SELECT id,state,last_progress FROM jobs WHERE id IN (${jobA},${jobB}) ORDER BY id`)),
  });
  const before=await state(),drift=driftCalls.length;
  for(const item of routes)for(const deviceId of [undefined,a.id]){
   clock+=20000;
   const {response}=send(item,{token:a.token,deviceId,json:JSON.stringify(payload(item.name,b.id,b.key,{jobs:[jobB]}))}),result=await response,answer=await result.json();
   check(result.status,403,`${item.name}: body of another device is refused`);check(answer.error,serverText('apiError.agent.notApproved'));check(answer.code,'FORBIDDEN',`${item.name}: a mismatch carries no retry code`);
  }
  check(await state(),before,'no server, sample, channel or job write for either device');
  check(driftCalls.length,drift,'no drift ingest for a mismatched body');
 }

 // Authenticated requests behave as before, with and without the header,
 // keep their size limits, and an invalid body gives the route's 400.
 {
  const a=await device({name:'Happy path'});
  for(const item of routes)for(const deviceId of [undefined,a.id]){
   clock+=20000;
   const calls=bodyCalls.length,{response}=send(item,{token:a.token,deviceId,json:JSON.stringify(payload(item.name,a.id,a.key))}),result=await response,answer=await result.json();
   check(result.status,200,`${item.name}: authenticated request succeeds (${deviceId?'header':'token hash'}): ${JSON.stringify(answer)}`);
   check(bodyCalls.length,calls+1,`${item.name}: body read once`);check(bodyCalls.at(-1),item.limit,`${item.name}: size limit unchanged`);
   check(result.headers.get('Cache-Control'),'no-store');
   if(item.name==='heartbeat')check(answer.intervalSeconds,30);else if(item.name==='drift')check(driftCalls.at(-1).serverId,a.id,'drift ingest gets the authenticated device');else check(answer.ok,true);
   clock+=20000;
   const invalid=await send(item,{token:a.token,deviceId,json:JSON.stringify({serverId:'kein-geraet'})}).response;
   check(invalid.status,400,`${item.name}: invalid body of an authenticated device`);check((await invalid.json()).error.startsWith(item.invalid),true,`${item.name}: route's own 400 message`);
  }
  clock+=20000;
  const tooLarge=await send(routes[2],{token:a.token,json:JSON.stringify({serverId:a.id,sessions:[],padding:'x'.repeat(1_500_001)})}).response;
  check(tooLarge.status,413,'RDP keeps its 1.5 MB limit');
 }

 const heartbeat=routes.find(item=>item.name==='heartbeat');
 const beat=(target,{cpu=10,jobs=[],deviceId,key=target.key}={})=>send(heartbeat,{token:target.token,deviceId,json:JSON.stringify(payload('heartbeat',target.id,key,{cpu,jobs}))}).response;
 const serverRow=id=>d.one(sql`SELECT last_seen,snapshot,agent_public_key FROM servers WHERE id=${id}`);
 const sampleRows=async id=>(await d.query(sql`SELECT at,cpu FROM samples WHERE server_id=${id} ORDER BY at`));
 const gate=count=>{let waiting=0,open;const opened=new Promise(resolve=>{open=resolve;});return async()=>{if(++waiting>=count)open();await opened;};};
 const sumChanges=(recorded,prefix)=>recorded.reduce((total,batch)=>total+batch.filter(statement=>statement.text.startsWith(prefix)).reduce((sum,statement)=>sum+statement.rowCount,0),0);

 // Two parallel heartbeats that both passed the precheck; exactly one writes.
 {
  const target=await device({name:'Parallel'}),job=await runningJob(target.id),first=clock+30000;
  clock=first;times=[first,first+1];barrier=gate(2);const start=batches.length,samplesBefore=(await sampleRows(target.id)).length;
  const results=await Promise.all([beat(target,{cpu:11,jobs:[job]}),beat(target,{cpu:22,jobs:[job]})]);barrier=null;times=[];
  const statuses=results.map(result=>result.status).sort();
  check(statuses.join(),'200,429','one parallel heartbeat wins and one is throttled');
  const loser=results.find(result=>result.status===429);check((await loser.json()).error,serverText('apiError.heartbeat.intervalTooShort'));
  const samples=await sampleRows(target.id),row=await serverRow(target.id);
  check(samples.length,samplesBefore+1,'exactly one new sample');
  check(samples.at(-1).cpu,JSON.parse(row.snapshot).cpu,'sample and snapshot come from the same request');
  check(samples.at(-1).at,row.last_seen,'sample time is the winner\'s time');
  const jobRow=await d.one(sql`SELECT last_progress FROM jobs WHERE id=${job}`);
  check(jobRow.last_progress,row.last_seen,'the job progress comes from the winner');
  // The core batches end with the server update; only the winner adds its own
  // history batch afterwards (lib/server/agent/heartbeat.ts recordHeartbeatSample).
  const recorded=batches.slice(start),core=recorded.filter(batch=>batch.at(-1).text.startsWith('UPDATE servers')),history=recorded.filter(batch=>!core.includes(batch));
  check(core.length,2,'both requests reached the core batch');check(history.length,1,'only the winner runs the history batch');
  check(history[0].map(statement=>statement.text.split(' ').slice(0,3).join(' ')).join(),'INSERT INTO samples,DELETE FROM samples','the history batch writes the sample and prunes');
  check(/last_seen=[$][0-9]+/.test(history[0][0].text),true,'the sample insert is admitted by the last_seen of the winner');
  check(sumChanges(recorded,'UPDATE jobs SET last_progress'),1,'the job progress was set exactly once');
  check(sumChanges(core,'INSERT INTO samples'),0,'the core batch writes no sample');
  check(sumChanges(recorded,'INSERT INTO samples'),1,'exactly one sample insert took effect');
  check(sumChanges(recorded,'UPDATE servers SET last_seen'),1,'exactly one server update took effect');
  // The device 'Parallel' follows the computer name 'VM' (lib/device-name.ts): only the winner renames and audits it.
  check(sumChanges(recorded,'UPDATE servers SET name ='),1,'exactly one rename took effect');
  check(sumChanges(recorded,'INSERT INTO audit'),1,'exactly one rename audit row');
  check((await d.one(sql`SELECT name FROM servers WHERE id=${target.id}`)).name,'VM','the device name follows the reported computer name');
  for(const batch of core)check(/last_seen<=[$][0-9]+/.test(batch.at(-1).text),true,'the server update carries the interval condition');
 }

 // The same for a first heartbeat (no last_seen, key not pinned yet).
 {
  const target=await device({name:'First contact',pinned:false,lastSeen:null,expiresAt:clock+86400000});
  clock+=1000;const at=clock;times=[at,at+1];barrier=gate(2);const start=batches.length;
  const results=await Promise.all([beat(target,{cpu:11}),beat(target,{cpu:22})]);barrier=null;times=[];
  check(results.map(result=>result.status).sort().join(),'200,429','one first heartbeat wins and one is throttled');
  const samples=await sampleRows(target.id),row=await serverRow(target.id);
  check(samples.length,1,'exactly one sample for the first contact');check(row.agent_public_key,target.key.pinned,'the key is pinned');
  check(samples[0].cpu,JSON.parse(row.snapshot).cpu,'sample and snapshot come from the same request');check(samples[0].at,row.last_seen);
  check(sumChanges(batches.slice(start),'INSERT INTO samples'),1,'one sample insert took effect');
 }

 // Sequential heartbeats around the 10-second interval.
 {
  const target=await device({name:'Sequential'});
  clock+=60000;const at=clock;check((await beat(target,{cpu:31})).status,200,'first heartbeat');
  const after=await serverRow(target.id),samples=(await sampleRows(target.id)).length,start=batches.length;
  clock=at+5000;let result=await beat(target,{cpu:32});check(result.status,429,'5 s later is throttled');check((await result.json()).error,serverText('apiError.heartbeat.intervalTooShort'));
  check(JSON.stringify(await serverRow(target.id)),JSON.stringify(after),'the throttled heartbeat writes nothing');check((await sampleRows(target.id)).length,samples);check(batches.length,start,'not even a batch runs');
  clock=at+10001;result=await beat(target,{cpu:33});check(result.status,200,'more than 10 s later is accepted');
  check((await serverRow(target.id)).last_seen,at+10001);check((await sampleRows(target.id)).length,samples+1);
 }

 // A batch that changed nothing still tells revoked, changed key and throttled apart.
 {
  const verdict=async(change,status,message,label)=>{
   const target=await device({name:label}),samples=(await sampleRows(target.id)).length;clock+=60000;beforeBatch=()=>change(target);
   const result=await beat(target);beforeBatch=null;check(result.status,status,label);check((await result.json()).error,message,label);
   check((await sampleRows(target.id)).length,samples,label+' writes no sample');
  };
  await verdict(target=>d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${target.id}`),403,serverText('apiError.agent.notApproved'),'revoked before the batch');
  await verdict(target=>d.exec(sql`UPDATE servers SET agent_public_key=${agentKey().pinned} WHERE id=${target.id}`),409,serverText('apiError.heartbeat.keyChanged'),'key replaced before the batch');
  await verdict(target=>d.exec(sql`UPDATE servers SET last_seen=${clock-1} WHERE id=${target.id}`),429,serverText('apiError.heartbeat.intervalTooShort'),'a heartbeat committed before the batch');
 }
 console.log(`PASS agent auth before body: ${assertions} assertions; channel, terminal, RDP, heartbeat, drift ingest and integrity reject unknown, wrong and missing bearers without reading the body, keep their retry codes without the device header, refuse a foreign serverId without writing, keep limits and 400s, and the heartbeat interval holds atomically in its batch.`);
}finally{d.close();}
