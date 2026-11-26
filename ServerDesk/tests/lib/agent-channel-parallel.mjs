// Parallel agent jobs on PostgreSQL (236, lib/server/agent/agent-channel.ts with
// lib/server/devices/jobs/concurrency.ts, docs/native-agent-v4.md "Parallel jobs"): the real
// channel claims, for an agent with parallel-jobs, parallel jobs next to each
// other and next to one exclusive job, keeps exclusive jobs in queue order,
// lets no job overtake a waiting sole job, keeps groups and the cap of 4,
// treats a running job without a class as sole, and stores the class on the
// claimed row. An agent without the capability keeps one job at a time. The
// device lease is the real one of lib/server/agent/agent-protocol.ts. A sole job
// behind a held exclusive job ends the claim, so later reads do not overtake it (287).
import {HttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {z} from 'zod';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';

const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const origin='https://parallel-jobs.test',time=Date.now();
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex'),uuid=()=>crypto.randomUUID();
 const signing=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'});
 const noop=async()=>{},allow=sql`TRUE`;
 const server={
  db:()=>d,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:key==='AGENT_JOB_SIGNING_KEY'?signing:'',now:()=>Date.now(),random:token,hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:request=>request.json(),sameOrigin:()=>{},log:noop,
  failure:e=>{const known=e instanceof HttpError||e instanceof Error&&typeof e.status==='number'&&typeof e.code==='string';return Response.json({error:e instanceof Error?e.message:'failed',...(known?{code:e.code,messageKey:e.messageKey,params:e.params}:{})},{status:known?e.status:500});},
 };
 const load=sourceLoader();
 // The real device lease (lease, releaseLease); only the bearer check is replaced.
 const realV3=load('lib/server/agent/agent-protocol.ts',{'../context':server});
 const deviceRow=id=>d.one(sql`SELECT id,last_seen,management,snapshot,name,agent_public_key FROM servers WHERE id=${id}`);
 const v3={...realV3,agentFromBearer:async request=>deviceRow((await request.clone().json()).serverId),assertAgentActive:noop};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./agent-protocol':v3,'@/lib/server/agent/agent-protocol':v3,
  '../automation/runbooks':{tickAutomation:noop},'../automation/drift':{ingestDrift:noop},'../devices/file-access':{requireFileAccess:noop},
  '../devices/transfers':{verifyTransfer:noop,sweepTransfers:noop,transferAuthorizationGuard:()=>allow},'./transfers':{verifyTransfer:noop,sweepTransfers:noop,transferAuthorizationGuard:()=>allow},'../devices/terminal-lifecycle':{sweepTerminalSessions:noop},'../devices/rdp':{sweepRdp:noop},
  '../devices/terminal-channel':{terminalReport:z.object({}),exchangeTerminals:async()=>[]},
  '../automation/desired-state':{advanceDesiredState:noop,checkPendingDesiredJob:async()=>true,desiredJobClaimGuard:async()=>allow},
  '../automation/desired-state-result':{desiredResultActions:new Set(),desiredResultStatement:()=>null},
  '../automation/automation-device':{reconcileDeviceAutomation:noop,getAutomationDriftPolicy:async()=>null},
 };
 const channel=load('lib/server/agent/agent-channel.ts',imports);
 const {MAX_RUNNING_JOBS}=load('lib/server/devices/jobs/concurrency.ts',imports);

 // ---- Fixture ------------------------------------------------------------------------------------
 const label='technician@parallel-jobs.test';
 const {actor}=await sourceActor(d,label,['view','diagnose','manage','files.read','files.write','defender.control','update']);
 actor.principal='private:'+label;
 await d.exec(sql`UPDATE local_users SET auth_principal=${actor.principal},password_hash='fixture-password',must_reset=0 WHERE id=${actor.id}`);
 await insertRow(d,'mfa_accounts',{principal:actor.principal,secret_enc:'migrated:authenticator-managed',recovery_hashes:'[]',last_counter:-1,created_at:time,authenticators_migrated:1});
 const kinds=['refresh','scan-updates','test-connection','start-service','stop-service','set-service-startup','install-updates','list-files','list-processes','list-sessions','defender-quick-scan','defender-full-scan','agent-update'];
 async function device(name,{parallel=true}={}){
  const id=uuid();
  const snapshot={protocolVersion:3,agentVersion:parallel?'4.21.0':'4.20.0',mode:'Management',agentCapabilities:[...kinds,...(parallel?['parallel-jobs']:[])],hostname:name};
  await insertRow(d,'servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:Date.now(),management:1,snapshot:JSON.stringify(snapshot)});
  return id;
 }
 let order=0;
 // A pending job; created_at keeps the queue order of the calls.
 async function queue(serverId,action,parameters={}){
  const id=uuid();
  await insertRow(d,'jobs',{id,server_id:serverId,action,target:action,state:'pending',created_at:time-120_000+(order++)*10,actor:label,actor_email:label,actor_principal:actor.principal,parameters:JSON.stringify(parameters),not_before:0});
  return id;
 }
 // A running job as a claim stores it; an exclusive or sole job holds the device lease as the claim takes it.
 async function running(serverId,action,concurrency,group=null,parameters={}){
  const id=await queue(serverId,action,parameters),at=Date.now();
  await d.exec(sql`UPDATE jobs SET state='running',claimed_at=${at},last_progress=${at},concurrency=${concurrency},concurrency_group=${group} WHERE id=${id}`);
  if(concurrency!=='parallel')await d.exec(sql`INSERT INTO device_leases(server_id,owner_kind,owner_id,expires_at) VALUES(${serverId},'job',${id},${at+120_000})`);
  return id;
 }
 const state=async id=>(await d.one(sql`SELECT state FROM jobs WHERE id=${id}`)).state;
 const states=async ids=>Promise.all(ids.map(state));
 // The channel admits one post per device every 150 ms; a transient 429 or 5xx of the shared test database is tried again.
 async function poll(serverId,body={}){
  for(let attempt=1;;attempt++){
   await new Promise(resolve=>setTimeout(resolve,160*attempt));
   const response=await channel.agentChannel(new Request(origin+'/api/agent/channel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serverId,...body})}));
   if(attempt<3&&(response.status===429||response.status>=500))continue;
   const answer=await response.json();
   assert.equal(response.status,200,JSON.stringify(answer));
   return answer.jobs.map(job=>job.id);
  }
 }
 const done=id=>({id,ok:true,message:'Done.'});
 const runningIds=async serverId=>(await d.query(sql`SELECT id FROM jobs WHERE server_id=${serverId} AND state='running' ORDER BY created_at`)).map(row=>row.id);

 check(MAX_RUNNING_JOBS,4,'the cap');

 // ---- a. Reads next to an update installation; a change waits ----------------------------------------------
 {
  const srv=await device('SRV-A'),install=await running(srv,'install-updates','exclusive','windows-update',{});
  const refresh=await queue(srv,'refresh'),service=await queue(srv,'set-service-startup',{name:'Spooler',startup:'Manual'}),files=await queue(srv,'list-files',{path:'C:\\Temp'});
  check((await poll(srv,{runningJobs:[install]})).sort(),[refresh,files].sort(),'a: refresh and list-files are claimed in one poll next to install-updates');
  check(await states([refresh,files,service]),['running','running','pending'],'a: set-service-startup stays pending');
  // h. The claim stores the class and group on the row.
  check(await d.query(sql`SELECT action,concurrency,concurrency_group FROM jobs WHERE id IN (${refresh},${files}) ORDER BY action`),[{action:'list-files',concurrency:'parallel',concurrency_group:null},{action:'refresh',concurrency:'parallel',concurrency_group:'inventory'}],'h: claimed rows carry their class and group');
  check(await d.one(sql`SELECT owner_id FROM device_leases WHERE server_id=${srv}`),{owner_id:install},'a: parallel claims take no device lease');
  // After the installation, the change gets the device lease.
  check(await poll(srv,{runningJobs:[refresh,files],results:[done(install)]}),[service],'a: after the installation the change is claimed next to the reads');
  check(await d.one(sql`SELECT owner_id FROM device_leases WHERE server_id=${srv}`),{owner_id:service},'a: the change holds the device lease');
  check(await d.one(sql`SELECT concurrency,concurrency_group FROM jobs WHERE id=${service}`),{concurrency:'exclusive',concurrency_group:null},'h: an exclusive claim stores its class');
 }

 // ---- b. The owner example: a Defender scan next to an update search -------------------------------------
 {
  const srv=await device('SRV-B'),search=await running(srv,'scan-updates','parallel','windows-update');
  const scan=await queue(srv,'defender-quick-scan'),second=await queue(srv,'scan-updates'),install=await queue(srv,'install-updates',{all:false,kbs:[]});
  check(await poll(srv,{runningJobs:[search]}),[scan],'b: the Defender quick scan runs next to the update search');
  check(await states([second,install]),['pending','pending'],'b: a second search and the installation wait for the group windows-update');
  check(await d.one(sql`SELECT concurrency_group FROM jobs WHERE id=${scan}`),{concurrency_group:'defender'},'h: the scan stores the group defender');
 }

 // ---- c. One Defender job at a time ------------------------------------------------------------------------------
 {
  const srv=await device('SRV-C'),scan=await running(srv,'defender-quick-scan','parallel','defender'),full=await queue(srv,'defender-full-scan');
  check(await poll(srv,{runningJobs:[scan]}),[],'c: a full scan waits for the running quick scan');
  check(await state(full),'pending','c: still pending');
 }

 // ---- d. A sole job is not overtaken, and nothing runs next to it ------------------------------------------
 {
  const srv=await device('SRV-D'),refresh=await running(srv,'refresh','parallel','inventory');
  const update=await queue(srv,'agent-update',{releaseId:uuid()}),files=await queue(srv,'list-files',{path:'C:\\Temp'});
  check(await poll(srv,{runningJobs:[refresh]}),[],'d: nothing is claimed while the agent update waits for the refresh');
  check(await states([update,files]),['pending','pending'],'d: the read does not overtake the agent update');
  check(await poll(srv,{results:[done(refresh)]}),[update],'d: after the refresh result the agent update alone is claimed');
  check(await d.one(sql`SELECT concurrency,owner_id FROM jobs JOIN device_leases l ON l.owner_id=jobs.id WHERE jobs.id=${update}`),{concurrency:'sole',owner_id:update},'d: the update holds the device lease as sole');
  check(await poll(srv,{runningJobs:[update]}),[],'d: nothing is claimed while the agent update runs');
  check(await poll(srv,{runningJobs:[]}),[],'d: also not when the agent reports nothing running');
  check(await state(files),'pending','d: the read still waits');
 }

 // ---- e. Exclusive jobs keep their order; reads behind them still run ----------------------------------------
 {
  const srv=await device('SRV-E'),e0=await running(srv,'set-service-startup','exclusive',null,{name:'Spooler',startup:'Manual'});
  const e1=await queue(srv,'start-service',{name:'Spooler'}),e2=await queue(srv,'stop-service',{name:'W32Time'}),p=await queue(srv,'list-files',{path:'C:\\Temp'});
  check(await poll(srv,{runningJobs:[e0]}),[p],'e: only the read is claimed while E0 runs');
  check(await states([e1,e2]),['pending','pending'],'e: E1 and E2 wait');
  check(await poll(srv,{runningJobs:[p],results:[done(e0)]}),[e1],'e: after E0, E1 is claimed before E2');
  check(await state(e2),'pending','e: E2 waits for E1');
  check(await poll(srv,{runningJobs:[p],results:[done(e1)]}),[e2],'e: then E2');
 }

 // ---- f. The cap of 4 running jobs -----------------------------------------------------------------------------
 {
  const srv=await device('SRV-F');
  const four=[await running(srv,'refresh','parallel','inventory'),await running(srv,'list-files','parallel'),await running(srv,'test-connection','parallel'),await running(srv,'list-processes','parallel')];
  const fifth=await queue(srv,'list-sessions');
  check(await poll(srv,{runningJobs:four}),[],'f: no fifth job is claimed');
  check(await poll(srv,{runningJobs:four.slice(1),results:[done(four[0])]}),[fifth],'f: one finished job frees one place');
 }
 {
  // Several pending reads fill the free places in one poll, up to the cap.
  const srv=await device('SRV-F2'),first=await running(srv,'refresh','parallel','inventory');
  const pending=[await queue(srv,'list-files',{path:'C:\\'}),await queue(srv,'test-connection',{host:'example.test',port:443}),await queue(srv,'list-processes'),await queue(srv,'list-sessions')];
  check(await poll(srv,{runningJobs:[first]}),pending.slice(0,3),'f: three more reads are claimed, in queue order');
  check(await state(pending[3]),'pending','f: the fifth waits');
 }

 // ---- g. A running job without a class (claimed before 0029) is sole ---------------------------------------------
 {
  const srv=await device('SRV-G'),old=await queue(srv,'list-files',{path:'C:\\'});
  await d.exec(sql`UPDATE jobs SET state='running',claimed_at=${Date.now()},last_progress=${Date.now()} WHERE id=${old}`);
  const read=await queue(srv,'refresh'),change=await queue(srv,'start-service',{name:'Spooler'});
  check(await poll(srv,{runningJobs:[old]}),[],'g: nothing is claimed next to a job without a class');
  check(await states([read,change]),['pending','pending'],'g: both wait');
  check(await poll(srv,{runningJobs:[]}),[],'g: also when the agent reports nothing running');
 }
 {
  // A job the agent still reports but the portal no longer counts as running (expired) is unknown, so sole.
  const srv=await device('SRV-G2'),gone=await queue(srv,'support-bundle');
  await d.exec(sql`UPDATE jobs SET state='expired',parameters='{}' WHERE id=${gone}`);
  const read=await queue(srv,'refresh');
  check(await poll(srv,{runningJobs:[gone]}),[],'g: nothing is claimed next to a job the agent still runs and the portal does not know as running');
  check(await poll(srv,{runningJobs:[]}),[read],'g: once the agent reports it finished, the read is claimed');
 }

 // ---- i. An agent without parallel-jobs: one job at a time, as before ---------------------------------------------
 {
  const srv=await device('SRV-I',{parallel:false}),busy=await running(srv,'refresh','parallel','inventory');
  const reads=[await queue(srv,'list-files',{path:'C:\\'}),await queue(srv,'list-processes'),await queue(srv,'list-sessions')];
  check(await poll(srv,{runningJobs:[busy]}),[],'i: no claim while the legacy agent reports a running job');
  check(await poll(srv,{runningJobs:[]}),[],'i: no claim while a job of the device runs');
  check(await poll(srv,{results:[done(busy)]}),[reads[0]],'i: when idle, exactly one claim per poll');
  check(await d.one(sql`SELECT concurrency,owner_id FROM jobs JOIN device_leases l ON l.owner_id=jobs.id WHERE jobs.id=${reads[0]}`),{concurrency:'parallel',owner_id:reads[0]},'i: the legacy claim stores the class and takes the device lease as before');
  check(await poll(srv,{runningJobs:[reads[0]]}),[],'i: the next read waits');
  check(await poll(srv,{results:[done(reads[0])]}),[reads[1]],'i: then the next one');
 }

 // ---- j. runningJobs takes the cap plus a pending update ID, and refreshes each ----------------------------------
 {
  const srv=await device('SRV-J'),old=Date.now()-60_000,ids=[];
  for(let i=0;i<5;i++){const id=await queue(srv,'list-files',{path:'C:\\'});await d.exec(sql`UPDATE jobs SET state='running',claimed_at=${old},last_progress=${old},concurrency='parallel' WHERE id=${id}`);ids.push(id);}
  const before=Date.now();
  check(await poll(srv,{runningJobs:ids}),[],'j: five running IDs are accepted');
  const progress=await d.query(sql`SELECT last_progress FROM jobs WHERE server_id=${srv} AND state='running'`);
  check(progress.length===5&&progress.every(row=>Number(row.last_progress)>=before),true,'j: last_progress is refreshed for each');
  await new Promise(resolve=>setTimeout(resolve,200));
  const response=await channel.agentChannel(new Request(origin+'/api/agent/channel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serverId:srv,runningJobs:[...ids,uuid()]})}));
  check(response.status,400,'j: six IDs are refused');
  check(await runningIds(srv),ids,'j: nothing changed');
 }
 // ---- k. A sole job behind a held exclusive job is not overtaken (287) -----------------------------------------
 {
  // The agent lacks terminal-multi; a live terminal lease without an open terminal session refuses the device
  // lease (409), so E is held with nothing running. Parallel claims pass next to a terminal lease.
  const srv=await device('SRV-K'),terminal=uuid();
  await d.exec(sql`INSERT INTO device_leases(server_id,owner_kind,owner_id,expires_at) VALUES(${srv},'terminal',${terminal},${Date.now()+600_000})`);
  const change=await queue(srv,'start-service',{name:'Spooler'}),update=await queue(srv,'agent-update',{releaseId:uuid()}),files=await queue(srv,'list-files',{path:'C:\\Temp'});
  check(await poll(srv,{runningJobs:[]}),[],'k: nothing is claimed while E is held and the agent update waits behind it');
  check(await states([change,update,files]),['pending','pending','pending'],'k: E, the agent update and the later read all stay pending');
  check(await d.one(sql`SELECT owner_kind,owner_id FROM device_leases WHERE server_id=${srv}`),{owner_kind:'terminal',owner_id:terminal},'k: the terminal lease is untouched');
  await d.exec(sql`DELETE FROM device_leases WHERE server_id=${srv}`);
  check(await poll(srv,{runningJobs:[]}),[change],'k: without the terminal lease E is claimed; the agent update waits behind it and stops the claim');
  check(await states([update,files]),['pending','pending'],'k: the read still does not overtake the agent update');
  check(await poll(srv,{runningJobs:[change]}),[],'k: nothing is claimed while E runs and the agent update waits');
  check(await poll(srv,{results:[done(change)]}),[update],'k: after E the agent update alone is claimed');
  check(await state(files),'pending','k: the read waits for the agent update');
 }

 // ---- l. A held exclusive job does not stop later reads when no sole job is between them (287) -----------------
 {
  const srv=await device('SRV-L'),terminal=uuid();
  await d.exec(sql`INSERT INTO device_leases(server_id,owner_kind,owner_id,expires_at) VALUES(${srv},'terminal',${terminal},${Date.now()+600_000})`);
  const change=await queue(srv,'start-service',{name:'Spooler'}),files=await queue(srv,'list-files',{path:'C:\\Temp'}),update=await queue(srv,'agent-update',{releaseId:uuid()});
  check(await poll(srv,{runningJobs:[]}),[files],'l: the read before the agent update is claimed next to the held E');
  check(await states([change,update]),['pending','pending'],'l: E and the agent update stay pending');
 }
}finally{await d.close();}
console.log(`agent-channel-parallel: ${checks} checks passed`);
