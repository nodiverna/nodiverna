// Run the production channel's authentication, claim and final dispatch SQL
// an isolated PostgreSQL test database, advancing time or changing device identity after a job is claimed.
// Unrelated background schedulers are idle fixtures; access checks remain real.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ts from 'typescript';
import {sourceDatabase,inTransaction} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {enableMultipleCustomers,separateCustomers} from '../support/customer-separation.mjs';
const require=createRequire(import.meta.url);
const d=await sourceDatabase();
let assertions=0;
const check=(actual,expected,label)=>{assert.equal(actual,expected,label);assertions++;};
try{
 const origin='https://serverdesk.test',owner='owner@expiry.test',sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 const key=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'}),pinned=JSON.stringify({kty:key.kty,n:key.n,e:key.e});
 let clock=Date.now(),afterClaim=async()=>{};
 // The test clock moves right after the claim UPDATE returned its row.
 const facade=hookDatabase(d,{after:async(text,_inTransaction,row)=>{if(row&&text.startsWith("UPDATE jobs SET state='running'"))await afterClaim();}});
 const HttpError=realHttpError;
 const server={db:()=>facade,config:name=>name==='SITE_ORIGIN'?origin:'',now:()=>clock,hash:async value=>sha(value),guid:value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value),body:request=>request.json(),HttpError,failure:error=>Response.json({error:error.message,...(error.code?{code:error.code}:{})},{status:error.status??503})};
 const cache=new Map([['lib/server/context.ts',server]]),idle=async()=>{};
 function load(file){
  if(cache.has(file))return cache.get(file);
  const fixture={exports:{}},code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  cache.set(file,fixture.exports);
  new Function('require','exports','module',code)(name=>{
   if(name==='cloudflare:workers')return {env:{}};
   if(name.startsWith('@/'))return load(name.slice(2)+'.ts');
   // Plain runtime modules (runtime/secret-keyring.mjs) load as they are.
   if(name.startsWith('.')&&name.endsWith('.mjs'))return require(path.resolve(path.posix.dirname(file),name));
   if(name.startsWith('.'))return load(path.posix.normalize(path.posix.join(path.posix.dirname(file),name))+'.ts');
   return require(name);
  },fixture.exports,fixture);cache.set(file,fixture.exports);return fixture.exports;
 }
 const {z}=require('zod');
 cache.set('lib/server/automation/runbooks.ts',{tickAutomation:idle});
 cache.set('lib/server/automation/drift.ts',{getDriftPolicy:async()=>null,ingestDrift:idle});
 cache.set('lib/server/devices/transfers.ts',{verifyTransfer:idle,sweepTransfers:idle});
 cache.set('lib/server/devices/terminal-lifecycle.ts',{sweepTerminalSessions:idle});
 cache.set('lib/server/devices/rdp.ts',{sweepRdp:idle});
 cache.set('lib/server/devices/terminal-channel.ts',{terminalReport:z.object({id:z.guid()}),exchangeTerminals:async()=>[]});
 cache.set('lib/server/automation/desired-state.ts',{advanceDesiredState:idle,checkPendingDesiredJob:async()=>true});
 const channel=load('app/api/agent/channel/route.ts'),v3=load('lib/server/agent/agent-protocol.ts');
 // The jobs' actor is a live global Owner, so its pending jobs stay deliverable.
 {const ownerId=crypto.randomUUID(),ownerRole=crypto.randomUUID(),at=Date.now();await inTransaction(d,[
  sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at) VALUES(${ownerId},${'owner'},${owner},${'Owner'},${'private:'+owner},${owner},'active',1,${at},${at})`,
  sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${ownerRole},'Fixture Owner','','["*"]',0,${at})`,
  sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${crypto.randomUUID()},'user',${ownerId},${ownerRole},'global','*',${at},'fixture')`
 ]);}
 async function fixture(){
  clock=Date.now();afterClaim=idle;
  const id=crypto.randomUUID(),job=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex');
  const snapshot={protocolVersion:3,agentVersion:'4.6.0',mode:'Management',agentCapabilities:['refresh','terminal-live','terminal-multi']};
  await d.exec(sql`INSERT INTO servers(id,name,token_hash,token_expires_at,created_at,last_seen,management,snapshot,agent_public_key) VALUES (${id},${'In-flight fixture'},${sha(token)},${clock+900000},${clock},${clock},1,${JSON.stringify(snapshot)},${pinned})`);
  await d.exec(sql`INSERT INTO jobs(id,server_id,action,target,created_at,actor,actor_email,actor_principal,parameters) VALUES (${job},${id},'refresh','Inventory',${clock},${'owner'},${owner},${'private:'+owner},'{}')`);
  const request=(extra={})=>new Request(origin+'/api/agent/channel',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({serverId:id,results:[],runningJobs:[],...extra})});
  return {id,job,token,request};
 }
 let f=await fixture();afterClaim=async()=>{clock+=900001;};
 let response=await channel.POST(f.request());check(response.status,200,'admitted request can dispatch after its bearer expires');check((await response.json()).jobs[0].id,f.job);check((await d.one(sql`SELECT state FROM jobs WHERE id=${f.job}`)).state,'running','claimed work is delivered rather than stranded');
 const admitted=await d.one(sql`SELECT id,last_seen,management,snapshot,name,agent_public_key FROM servers WHERE id=${f.id}`);check((await v3.assertAgentActive(admitted)).id,f.id,'active pinned device is independent of the bearer deadline');
 response=await channel.POST(f.request());check(response.status,403,'expiry still gates every new request');check((await response.json()).code,'DEVICE_TOKEN_REJECTED');
 f=await fixture();afterClaim=async()=>{const previous=clock+120000;await d.exec(sql`UPDATE servers SET previous_token_hash=token_hash,previous_token_expires_at=${previous},token_hash=${sha('b'.repeat(64))} WHERE id=${f.id}`);clock=previous+1;};
 response=await channel.POST(f.request());check(response.status,200,'admitted request survives a concurrent rotation past overlap');check((await response.json()).jobs[0].id,f.job);
 response=await channel.POST(f.request());check(response.status,403,'old generation cannot start a later request');check((await response.json()).code,'DEVICE_TOKEN_REJECTED');
 f=await fixture();afterClaim=()=>d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${f.id}`);
 response=await channel.POST(f.request());check(response.status,403,'offboarding after claim still suppresses dispatch');check((await response.json()).code,'FORBIDDEN','post-claim rejection cannot trigger an automatic POST replay');
 f=await fixture();afterClaim=()=>d.exec(sql`UPDATE servers SET agent_public_key=${'different-pinned-key'} WHERE id=${f.id}`);
 response=await channel.POST(f.request());check(response.status,403,'key replacement after claim still suppresses dispatch');check((await response.json()).code,'FORBIDDEN');
 await assert.rejects(()=>v3.assertAgentActive({...admitted,id:f.id}),error=>error.status===403&&error.code==='FORBIDDEN');assertions++;
 const noKey={...admitted,id:crypto.randomUUID(),agent_public_key:null};await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at) VALUES (${noKey.id},${'Unpinned device'},${sha('c'.repeat(64))},${clock})`);check((await v3.assertAgentActive(noKey)).id,noKey.id,'NULL pins retain exact identity semantics');await d.exec(sql`UPDATE servers SET agent_public_key=${pinned} WHERE id=${noKey.id}`);await assert.rejects(()=>v3.assertAgentActive(noKey),error=>error.status===403);assertions++;
 // Job outputs follow the maintenance job retention; a poll must not delete them for any device.
 f=await fixture();const aged=clock-40*86400000,ownOutput=crypto.randomUUID(),foreignOutput=crypto.randomUUID();
 for(const [job,server] of [[ownOutput,f.id],[foreignOutput,crypto.randomUUID()]])await d.exec(sql`INSERT INTO job_outputs(job_id,server_id,data,created_at) VALUES (${job},${server},${'{}'},${aged})`);
 response=await channel.POST(f.request());check(response.status,200,'poll with aged outputs succeeds');check((await response.json()).jobs[0].id,f.job);
 for(const job of [ownOutput,foreignOutput])check((await d.one(sql`SELECT created_at FROM job_outputs WHERE job_id=${job}`))?.created_at,aged,'channel poll keeps a 40 day old output of '+(job===ownOutput?'its own':'another')+' device');
 clock+=1000;response=await channel.POST(f.request({results:[{id:f.job,ok:true,message:'Inventar aktualisiert',data:{items:1}}]}));check(response.status,200,'result report succeeds');
 const written=(await d.query(sql`SELECT server_id FROM job_outputs WHERE job_id=${f.job}`));check(written.length,1,'a result with data writes exactly one output');check(written[0].server_id,f.id,'the output belongs to the reporting device');
 check((await d.one(sql`SELECT state FROM jobs WHERE id=${f.job}`)).state,'succeeded','the reported job completes');
 // Pending jobs outside the heartbeat's 5 minute bound are never delivered; expiring them stays with the heartbeat.
 const days=3*86400000,stateOf=async job=>d.one(sql`SELECT state,claimed_at FROM jobs WHERE id=${job}`);
 f=await fixture();await d.exec(sql`UPDATE servers SET last_seen=${clock-days} WHERE id=${f.id}`);await d.exec(sql`UPDATE jobs SET created_at=${clock-days} WHERE id=${f.job}`);
 response=await channel.POST(f.request());check(response.status,200,'device returning after days polls successfully');check((await response.json()).jobs.length,0,'a 3 day old pending job is not delivered');
 let row=await stateOf(f.job);check(row.state,'pending','the old job is left for the heartbeat to expire');check(row.claimed_at,null,'the old job is not claimed');
 check((await d.one(sql`SELECT count(*) AS count FROM device_leases WHERE owner_id=${f.job}`)).count,0,'no lease is taken for the old job');
 f=await fixture();await d.exec(sql`UPDATE servers SET last_seen=${clock-days} WHERE id=${f.id}`);await d.exec(sql`UPDATE jobs SET created_at=${clock-days} WHERE id=${f.job}`);
 const fresh=crypto.randomUUID();await d.exec(sql`INSERT INTO jobs(id,server_id,action,target,created_at,actor,actor_email,actor_principal,parameters) VALUES (${fresh},${f.id},'refresh','Inventory',${clock-1000},${'owner'},${owner},${'private:'+owner},'{}')`);
 response=await channel.POST(f.request());check(response.status,200);check((await response.json()).jobs[0]?.id,fresh,'the fresh job is delivered although the old one sorts first');
 check((await stateOf(fresh)).state,'running','the fresh job is claimed');check((await stateOf(f.job)).state,'pending','the old job stays pending');
 for(const [label,createdAt,notBefore,delivered] of [['exactly 5 minutes old',-300000,0,true],['5 minutes and 1 ms old',-300001,0,false],['3 days old but not_before 1 minute ago',-days,-60000,true],['not_before in the future',0,60000,false]]){
  f=await fixture();await d.exec(sql`UPDATE jobs SET created_at=${clock+createdAt},not_before=${notBefore?clock+notBefore:0} WHERE id=${f.job}`);
  response=await channel.POST(f.request());check(response.status,200,label+' polls successfully');const jobs=(await response.json()).jobs;
  check(jobs[0]?.id,delivered?f.job:undefined,label+(delivered?' is delivered':' is not delivered'));row=await stateOf(f.job);check(row.state,delivered?'running':'pending',label+' state');
 }
 // Once a second customer exists, a technician's pending job is delivered
 // only while the technician still sees the device's customer.
 {
  const tech='tech@expiry.test',techId=crypto.randomUUID(),roleId=crypto.randomUUID(),firstCustomer='00000000-0000-4000-8000-000000000100';
  await inTransaction(d,[
   sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at) VALUES(${techId},${'tech'},${tech},${'Tech'},${'private:'+tech},${tech},'active',1,${clock},${clock})`,
   sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${roleId},'Techniker','',${JSON.stringify(['view','diagnose','manage','update'])},0,${clock})`,
   sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${crypto.randomUUID()},'user',${techId},${roleId},'global','*',${clock},'fixture')`,
   enableMultipleCustomers(),
   separateCustomers(clock),
   sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${firstCustomer},'user',${techId},${clock},'fixture')`
  ]);
  const techJob=async()=>{const created=await fixture();await d.exec(sql`UPDATE jobs SET actor=${techId},actor_email=${tech},actor_principal=${'private:'+tech} WHERE id=${created.job}`);return created;};
  f=await techJob();response=await channel.POST(f.request());check(response.status,200,'control: an assigned technician polls');check((await response.json()).jobs[0]?.id,f.job,'control: the job of an assigned technician is delivered');check((await stateOf(f.job)).state,'running','control: the job runs');
  f=await techJob();await d.exec(sql`DELETE FROM customer_assignments WHERE principal_type='user' AND principal_id=${techId}`);
  response=await channel.POST(f.request());check(response.status,200,'the device still polls');check((await response.json()).jobs.length,0,'the job of a technician without the customer is not delivered');check((await stateOf(f.job)).state,'cancelled','the job is cancelled at the claim');
 }
 console.log(`PASS in-flight agent expiry races: ${assertions} assertions; claimed jobs finish across expiry and rotation, new requests still expire, and revocation or pinned-key changes still suppress dispatch without retry codes, polls keep aged job outputs, and pending jobs past the 5 minute bound are never delivered.`);
}finally{d.close();}
