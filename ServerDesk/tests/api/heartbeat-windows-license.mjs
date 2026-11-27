// The heartbeat key windowsLicense of agent 4.22.0 (lib/server/agent/telemetry.ts
// windowsLicenseState). Drives the real heartbeat route against a test database,
// as tests/api/heartbeat-running-jobs.mjs does: both shapes (available and not
// available) are stored as sent, and an evaluation opens its alarm with the days
// left as the peak; an unknown status, an unknown channel, an extra key (a
// product key), a missing reason and a bad date are refused with 400 and store
// nothing; a snapshot without the key (an older agent) is accepted.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {HttpError} from '../support/http-error.mjs';
import {serverText} from '../support/server-text.mjs';

const uuid=()=>crypto.randomUUID(),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const customerA='00000000-0000-4000-8000-000000000100',minute=60_000,day=86_400_000;
let clock=Date.UTC(2026,10,26,9,0,0),checks=0;
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

const agents=new Map();
const keyPair=()=>crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'});
async function device(name){
 const id=uuid(),token=crypto.randomBytes(32).toString('hex'),jwk=keyPair();
 await insertRow(d,'servers',{id,name,token_hash:sha(token),token_expires_at:clock+365*day,created_at:clock,last_seen:clock-minute,management:1,snapshot:null,agent_public_key:JSON.stringify({kty:jwk.kty,n:jwk.n,e:jwk.e}),customer_id:customerA});
 agents.set(id,{token,jwk});return id;
}
const snapshotOf=(id,extra={})=>{const {jwk}=agents.get(id);return {hostname:'SRV-EVAL01',os:'Microsoft Windows Server 2025 Standard Evaluation',build:'26100',manufacturer:'Microsoft',model:'VM',domain:'corp.example',cores:4,memoryGb:8,cpu:10,memory:20,uptimeSeconds:300,rebootPending:false,management:true,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.22.0',mode:'Management',publicKey:{kty:'RSA',n:jwk.n,e:jwk.e},agentCapabilities:['refresh'],...extra};};
// Every beat moves the clock, so the heartbeat throttle never answers 429.
const beat=async(id,extra)=>{
 clock+=minute;
 const response=await heartbeatApi.POST(new Request('https://heartbeat.test/api/heartbeat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+agents.get(id).token},body:JSON.stringify({serverId:id,snapshot:snapshotOf(id,extra),results:[],runningJobs:[]})}));
 return {status:response.status,body:await response.json()};
};
const stored=async id=>{const row=await d.one(sql`SELECT last_seen AS "lastSeen",snapshot FROM servers WHERE id=${id}`);return {lastSeen:Number(row.lastSeen),snapshot:row.snapshot?JSON.parse(row.snapshot):null};};
const iso=offset=>new Date(clock+offset).toISOString();

try{
 const host=await device('SRV-EVAL01');
 // ---- Both shapes are stored as sent ----
 const evaluation={available:true,collectedAt:iso(0),status:'licensed',channel:'evaluation',expiresAt:iso(47*day),evaluationEndsAt:null};
 let answer=await beat(host,{windowsLicense:evaluation});
 check(answer.status,200,`the available shape is stored: ${JSON.stringify(answer.body)}`);
 check((await stored(host)).snapshot.windowsLicense,evaluation,'the stored license equals the sent one');
 const alarm=await d.one(sql`SELECT rule_id AS "ruleId",level,peak_value AS "peakValue" FROM alerts WHERE server_id=${host} AND rule_id='windows-evaluation'`);
 check([alarm.ruleId,alarm.level,Number(alarm.peakValue)],['windows-evaluation','warning',47],'the evaluation opens a warning alarm with 47 days left as its peak');
 const unavailable={available:false,reason:'access-denied',collectedAt:iso(0)};
 answer=await beat(host,{windowsLicense:unavailable});
 check(answer.status,200,'the not available shape is stored');
 check((await stored(host)).snapshot.windowsLicense,unavailable,'the stored reason');
 for(const value of [{...evaluation,status:'notification',channel:'retail',expiresAt:null},{...evaluation,status:'initial-grace',channel:'volume-mak',evaluationEndsAt:iso(90*day)},{available:false,reason:'not-found',collectedAt:iso(0)},{available:false,reason:'error',collectedAt:iso(0)}]){
  answer=await beat(host,{windowsLicense:value});
  check([answer.status,(await stored(host)).snapshot.windowsLicense],[200,value],`stored: ${value.status??value.reason}`);
 }

 // ---- Refused values: 400, nothing stored ----
 const before=await stored(host);
 const refused={
  'an unknown status':{...evaluation,status:'activated'},
  'an unknown channel':{...evaluation,channel:'msdn'},
  'a product key':{...evaluation,productKey:'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX'},
  'a partial product key':{...evaluation,partialProductKey:'3V66T'},
  'a bad expiresAt':{...evaluation,expiresAt:'2027-01-12'},
  'a bad evaluationEndsAt':{...evaluation,evaluationEndsAt:'soon'},
  'a missing field':{available:true,collectedAt:iso(0),status:'licensed',channel:'retail',expiresAt:null},
  'an unknown reason':{available:false,reason:'denied',collectedAt:iso(0)},
  'no reason':{available:false,collectedAt:iso(0)},
  'a reason next to the available fields':{...evaluation,available:false,reason:'error'},
 };
 for(const [label,value] of Object.entries(refused)){
  answer=await beat(host,{windowsLicense:value});
  check(answer.status,400,`${label} is refused`);
 }
 check(await stored(host),before,'a refused heartbeat stores nothing');

 // ---- An older agent sends no key ----
 const old=await device('SRV-OLD01');
 answer=await beat(old,{agentVersion:'4.21.4'});
 check(answer.status,200,'a snapshot without windowsLicense is accepted');
 check('windowsLicense' in (await stored(old)).snapshot,false,'and stores no license');
 check(Number((await d.one(sql`SELECT count(*) AS n FROM alerts WHERE server_id=${old} AND rule_id IN ('windows-evaluation','windows-not-activated')`)).n),0,'and opens no license alarm');

 console.log(`PASS heartbeat Windows license (${checks} checks): both shapes stored as sent with the evaluation alarm, an unknown status, channel or reason, a product key, a bad date and a missing field refused with 400, and a snapshot of an older agent accepted.`);
}finally{await d.close();}
