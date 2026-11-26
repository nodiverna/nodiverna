// The heartbeat's runningJobs bound follows the job cap (287): the route
// accepts MAX_RUNNING_JOBS+1 reported running job IDs (the cap plus a pending
// agent update) and refuses one more with 400. Drives the real heartbeat route
// against a test database, as tests/api/heartbeat-plugin-jobs.mjs does, and
// checks that the route and the channel read the bound from
// lib/server/devices/jobs/concurrency.ts instead of a literal.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {HttpError} from '../support/http-error.mjs';
import {serverText} from '../support/server-text.mjs';

const uuid=()=>crypto.randomUUID(),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const customerA='00000000-0000-4000-8000-000000000100',minute=60_000;
let clock=Date.UTC(2026,10,16,9,0,0),checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const d=await sourceDatabase();
const server={db:()=>d,now:()=>clock,config:()=>'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>sha(value),guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),HttpError,
 body:async request=>{const text=await request.text();try{return JSON.parse(text);}catch{throw new HttpError('apiError.request.invalidJson');}},
 sameOrigin:()=>{},requireViewer:async()=>{throw new HttpError('apiError.auth.loginRequired');},log:async()=>{},
 failure:error=>error instanceof HttpError?Response.json({error:error.message,code:error.code,messageKey:error.messageKey},{status:error.status}):Response.json({error:serverText('apiError.internalError',{reference:'test'}),code:'INTERNAL_ERROR'},{status:500})};
const mfa={requireLiveSessions:async()=>{},requireMfa:async()=>{},isMfaEnabled:async()=>true,mfaSessionFence:async()=>sql`TRUE`,readMfaManagementProof:async()=>({guard:sql`TRUE`})};
const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'../identity/mfa':mfa,'./mfa':mfa,'@/lib/server/identity/mfa':mfa};
const load=sourceLoader();
const heartbeatApi=load('app/api/heartbeat/route.ts',imports);
const {MAX_RUNNING_JOBS,MAX_REPORTED_RUNNING_JOBS}=load('lib/server/devices/jobs/concurrency.ts');

const insert=(table,row)=>insertRow(d,table,row),agents=new Map();
const keyPair=()=>crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'});
async function device(name){
 const id=uuid(),token=crypto.randomBytes(32).toString('hex'),jwk=keyPair();
 await insert('servers',{id,name,token_hash:sha(token),token_expires_at:clock+365*24*60*minute,created_at:clock,last_seen:clock-minute,management:1,snapshot:null,agent_public_key:JSON.stringify({kty:jwk.kty,n:jwk.n,e:jwk.e}),customer_id:customerA});
 agents.set(id,{token,jwk});return id;
}
const beat=async(id,runningJobs)=>{
 const {token,jwk}=agents.get(id);
 const snapshot={hostname:'SRV-APP01',os:'Microsoft Windows Server 2022 Datacenter',build:'20348',manufacturer:'Microsoft',model:'VM',domain:'corp.example',cores:4,memoryGb:8,cpu:10,memory:20,uptimeSeconds:300,rebootPending:false,management:true,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.21.4',mode:'Management',publicKey:{kty:'RSA',n:jwk.n,e:jwk.e},agentCapabilities:['refresh','list-files','parallel-jobs']};
 const response=await heartbeatApi.POST(new Request('https://heartbeat.test/api/heartbeat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({serverId:id,snapshot,results:[],runningJobs})}));
 return {status:response.status,body:await response.json()};
};
const runningJob=async serverId=>{const id=uuid();await insert('jobs',{id,server_id:serverId,action:'list-files',target:'C:\\',parameters:'{}',state:'running',created_at:clock,claimed_at:clock,last_progress:clock,concurrency:'parallel',actor:'fixture',actor_email:'fixture@heartbeat.test',actor_principal:'private:fixture@heartbeat.test'});return id;};

try{
 check(MAX_REPORTED_RUNNING_JOBS,MAX_RUNNING_JOBS+1,'the reported bound is the cap plus the pending agent-update ID');
 check(MAX_REPORTED_RUNNING_JOBS,5,'with the cap of 4 the bound is 5');

 const host=await device('SRV-APP01');
 const ids=[];for(let index=0;index<MAX_REPORTED_RUNNING_JOBS;index++)ids.push(await runningJob(host));

 // ---- The bound itself is accepted, and the reported jobs show progress ----
 clock+=minute;
 const accepted=await beat(host,ids);
 check(accepted.status,200,`a heartbeat with ${MAX_REPORTED_RUNNING_JOBS} running job IDs is accepted: ${JSON.stringify(accepted.body)}`);
 for(const id of ids)check(Number((await d.one(sql`SELECT last_progress FROM jobs WHERE id=${id}`)).last_progress),clock,'the heartbeat records progress of reported job '+id);

 // ---- One more ID is refused ----
 clock+=minute;
 const refused=await beat(host,[...ids,uuid()]);
 check(refused.status,400,`a heartbeat with ${MAX_REPORTED_RUNNING_JOBS+1} running job IDs is refused`);
 for(const id of ids)check(Number((await d.one(sql`SELECT last_progress FROM jobs WHERE id=${id}`)).last_progress),clock-minute,'the refused heartbeat records nothing for '+id);

 // ---- The route and the channel read the bound from concurrency.ts ----
 const route=fs.readFileSync('app/api/heartbeat/route.ts','utf8'),channel=fs.readFileSync('lib/server/agent/agent-channel.ts','utf8');
 check(/runningJobs:z\.array\([^\n]*?\)\.max\(\d+\)/.test(route),false,'the heartbeat route has no literal runningJobs bound');
 check(/runningJobs:z\.array\(z\.guid\(\)\)\.max\(MAX_REPORTED_RUNNING_JOBS\)/.test(route),true,'the heartbeat route uses MAX_REPORTED_RUNNING_JOBS');
 check(/import \{[^}]*\bMAX_REPORTED_RUNNING_JOBS\b[^}]*\} from '@\/lib\/server\/devices\/jobs\/concurrency';/.test(route),true,'the route imports the bound from concurrency.ts');
 check(/runningJobs:z\.array\(z\.guid\(\)\)\.max\(MAX_REPORTED_RUNNING_JOBS\)/.test(channel),true,'the channel schema uses the same bound');

 console.log(`PASS heartbeat running jobs (${checks} checks): ${MAX_REPORTED_RUNNING_JOBS} reported running job IDs are accepted and recorded, ${MAX_REPORTED_RUNNING_JOBS+1} are refused with 400, and the route and the channel both use MAX_REPORTED_RUNNING_JOBS`);
}finally{await d.close();}
