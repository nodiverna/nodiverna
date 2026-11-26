// The heartbeat cancels a pending job only when the agent cannot run its kind
// ("The agent does not support this function"). The agent reports the
// capabilities plugin-host and plugin-ad-identity, never the job kinds
// plugin-job, plugin-install, plugin-remove or ad-sign-in, so a heartbeat that
// landed before the channel claimed a DNS read cancelled it. Runs the real
// heartbeat route and lib/server/agent/heartbeat.ts against a test database:
// - the capabilities of agent 4.20.0 (the literal list of AgentWorker.cs) leave
//   pending plugin jobs (dns-read, dns-zone-read, a DNS change), plugin-install,
//   plugin-remove and ad-sign-in pending, and still cancel a kind it lacks;
// - an agent without plugin-host or plugin-ad-identity still gets those jobs
//   cancelled with serverMessage.job.unsupported;
// - jobKindsOfCapabilities (lib/jobs/requirements.ts) agrees with
//   jobRequirements(...).capabilities, the mapping of the channel claim.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {HttpError} from '../support/http-error.mjs';
import {serverText} from '../support/server-text.mjs';

const uuid=()=>crypto.randomUUID(),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const customerA='00000000-0000-4000-8000-000000000100',minute=60_000;
let clock=Date.UTC(2026,10,10,9,0,0),checks=0;
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
const {jobKindsOfCapabilities,jobRequirements}=load('lib/jobs/requirements.ts',imports);

// The literal capabilities of AgentWorker.cs (4.20.0 reports the same plugin capabilities), with its constants resolved, plus one management action.
const worker=fs.readFileSync('agent/v3/AgentWorker.cs','utf8');
const literal=/latest\["agentCapabilities"\][^\n]*new\[\] \{ ([^}]+) \}/.exec(worker);
assert.ok(literal,'AgentWorker.cs has the literal capability list');
// A constant such as PluginIdentity.Capability is the first `Capability = "…"` after `class PluginIdentity` in agent/v3.
const agentSources=fs.readdirSync('agent/v3').filter(name=>name.endsWith('.cs')).map(name=>fs.readFileSync(`agent/v3/${name}`,'utf8'));
const constant=item=>{
 const owner=/^(\w+)\.Capability$/.exec(item)?.[1];if(!owner)return undefined;
 for(const text of agentSources){const at=text.search(new RegExp(`class ${owner}\\b`));if(at>=0){const value=/\bCapability = "([^"]+)"/.exec(text.slice(at))?.[1];if(value)return value;}}
 return undefined;
};
const agent420=[...literal[1].split(',').map(item=>item.trim()).map(item=>item.startsWith('"')?JSON.parse(item):constant(item)),'refresh'];
check(agent420.every(item=>typeof item==='string'),true,'every capability of the list is resolved');
check(['plugin-host','plugin-ad-identity'].every(item=>agent420.includes(item)),true,'the agent reports plugin-host and plugin-ad-identity');
check(['plugin-job','plugin-install','plugin-remove','ad-sign-in'].some(item=>agent420.includes(item)),false,'the agent reports none of the plugin job kinds');
check(agent420.includes('set-rdp'),false,'set-rdp is a kind the list lacks');

const insert=(table,row)=>insertRow(d,table,row),agents=new Map();
const keyPair=()=>crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'});
async function device(name){
 const id=uuid(),token=crypto.randomBytes(32).toString('hex'),jwk=keyPair();
 await insert('servers',{id,name,token_hash:sha(token),token_expires_at:clock+365*24*60*minute,created_at:clock,last_seen:clock-minute,management:1,snapshot:null,agent_public_key:JSON.stringify({kty:jwk.kty,n:jwk.n,e:jwk.e}),customer_id:customerA});
 agents.set(id,{token,jwk});return id;
}
const beat=async(id,capabilities,extra={})=>{
 const {token,jwk}=agents.get(id);
 const snapshot={hostname:'SRV-DC01',os:'Microsoft Windows Server 2022 Datacenter',build:'20348',manufacturer:'Microsoft',model:'VM',domain:'corp.example',cores:4,memoryGb:8,cpu:10,memory:20,uptimeSeconds:300,rebootPending:false,management:true,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.20.0',mode:'Management',publicKey:{kty:'RSA',n:jwk.n,e:jwk.e},agentCapabilities:capabilities,...extra};
 const response=await heartbeatApi.POST(new Request('https://heartbeat.test/api/heartbeat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({serverId:id,snapshot,results:[],runningJobs:[]})}));
 return {status:response.status,body:await response.json()};
};
const job=async(serverId,action,target,parameters)=>{const id=uuid();await insert('jobs',{id,server_id:serverId,action,target,parameters:JSON.stringify(parameters),state:'pending',created_at:clock,actor:'fixture',actor_email:'fixture@heartbeat.test',actor_principal:'private:fixture@heartbeat.test'});return id;};
const state=async id=>{const row=await d.one(sql`SELECT state,result,parameters FROM jobs WHERE id=${id}`);return [row.state,row.result,row.parameters];};
const actAs={sessionId:uuid(),userSid:'S-1-5-21-1000-2000-3000-1105',logonName:'CORP\\anna',account:'CORP\\anna',kind:'domain'};
const pluginJobs=async serverId=>({
 dnsRead:await job(serverId,'plugin-job','dns-read',{plugin:'dns',operation:'dns-read'}),
 zoneRead:await job(serverId,'plugin-job','dns-zone-read',{plugin:'dns',operation:'dns-zone-read',parameters:{zone:'corp.example'}}),
 change:await job(serverId,'plugin-job','dns-cache-clear',{plugin:'dns',operation:'dns-cache-clear',parameters:{},actAs}),
 install:await job(serverId,'plugin-install','dns 1.0.1',{name:'dns',releaseId:uuid(),version:'1.0.1',manifest:'{}',signature:'x'}),
 remove:await job(serverId,'plugin-remove','dns',{name:'dns'}),
 signIn:await job(serverId,'ad-sign-in','dns/CORP\\anna',{plugin:'dns',account:'CORP\\anna'}),
 refresh:await job(serverId,'refresh','Inventory',{}),
 rdp:await job(serverId,'set-rdp','Remote Desktop',{enabled:true}),
});
const unsupported=['cancelled','serverMessage.job.unsupported','{}'];

try{
 // ---- Agent 4.20.0: the plugin jobs stay pending, a missing kind is cancelled ----
 {
  const dc=await device('SRV-DC01'),jobs=await pluginJobs(dc);
  for(let round=1;round<=3;round++){
   clock+=minute;
   const answer=await beat(dc,agent420);
   check(answer.status,200,`heartbeat ${round} is stored: ${JSON.stringify(answer.body)}`);
  }
  for(const name of ['dnsRead','zoneRead','change','install','remove','signIn','refresh']){
   const [stateName,result]=await state(jobs[name]);
   check([stateName,result],['pending',null],`${name} stays pending after three heartbeats of agent 4.20.0`);
  }
  check(await state(jobs.rdp),unsupported,'set-rdp, which the agent does not report, is cancelled with serverMessage.job.unsupported');
 }

 // ---- An agent without plugin-host and plugin-ad-identity ----
 {
  const old=await device('SRV-OLD'),jobs=await pluginJobs(old);
  const without=agent420.filter(item=>item!=='plugin-host'&&item!=='plugin-ad-identity');
  clock+=minute;
  check((await beat(old,without)).status,200,'the heartbeat without the plugin host is stored');
  for(const name of ['dnsRead','zoneRead','change','install','remove','signIn','rdp'])check(await state(jobs[name]),unsupported,`${name} is cancelled without plugin-host or plugin-ad-identity`);
  check((await state(jobs.refresh))[0],'pending','refresh, which the agent reports, stays pending');
 }

 // ---- plugin-host alone: the plugin jobs stay, ad-sign-in goes ----
 {
  const host=await device('SRV-HOST'),jobs=await pluginJobs(host);
  clock+=minute;
  check((await beat(host,['refresh','plugin-host'])).status,200,'the heartbeat with plugin-host alone is stored');
  for(const name of ['dnsRead','zoneRead','change','install','remove','refresh'])check((await state(jobs[name]))[0],'pending',`${name} stays pending with plugin-host`);
  check(await state(jobs.signIn),unsupported,'ad-sign-in is cancelled without plugin-ad-identity');
 }

 // ---- The plugin report of a current agent (role only) is stored with target ----
 {
  const reporter=await device('SRV-REPORT');
  const report={name:'dns',role:'dns',version:'1.0.1',capabilities:['dns-read'],state:'ready',networkBlocked:true};
  const damaged={name:'dhcp',role:'unknown',version:'0.0.0',capabilities:[],state:'damaged',networkBlocked:false,error:'AGENT_PLUGIN_MANIFEST_INVALID'};
  clock+=minute;
  check((await beat(reporter,agent420,{plugins:[report,damaged]})).status,200,'a heartbeat of agent 4.20.0 with role-only plugin reports is accepted');
  const stored=JSON.parse((await d.one(sql`SELECT snapshot FROM servers WHERE id=${reporter}`)).snapshot).plugins;
  check(stored,[{name:'dns',version:'1.0.1',capabilities:['dns-read'],state:'ready',networkBlocked:true,target:'dns'},{name:'dhcp',version:'0.0.0',capabilities:[],state:'damaged',networkBlocked:false,error:'AGENT_PLUGIN_MANIFEST_INVALID',target:'unknown'}],'the stored reports carry target (from role, unknown for a damaged plugin) and no role');
  clock+=minute;
  check((await beat(reporter,agent420,{plugins:[{name:'dns',version:'1.0.1',capabilities:[],state:'ready',networkBlocked:true}]})).status,400,'a report with neither target nor role is refused');
 }

 // ---- The helper and the claim mapping agree ----
 {
  const kinds=['plugin-job','plugin-install','plugin-remove','ad-sign-in','refresh','set-rdp','agent-update','list-files'];
  const parameters={'plugin-job':{plugin:'dns',operation:'dns-read'},'ad-sign-in':{plugin:'dns'}};
  for(const capabilities of [agent420,agent420.filter(item=>item!=='plugin-host'),agent420.filter(item=>item!=='plugin-ad-identity'),['plugin-host'],['plugin-ad-identity'],['plugin-job','ad-sign-in'],[]]){
   const covered=new Set(jobKindsOfCapabilities(capabilities));
   for(const kind of kinds)check(covered.has(kind),jobRequirements(kind,parameters[kind]??{}).capabilities.every(item=>capabilities.includes(item)),`${kind} with [${capabilities.length>4?'agent 4.20.0 list…':capabilities.join(',')}]: the heartbeat helper agrees with jobRequirements`);
   for(const kind of covered)check(jobRequirements(kind,parameters[kind]??{}).capabilities.every(item=>capabilities.includes(item)),true,`every kind the helper lists (${kind}) has its capabilities`);
  }
  check(jobKindsOfCapabilities(['plugin-host','plugin-ad-identity']).filter(kind=>!['plugin-host','plugin-ad-identity'].includes(kind)).sort(),['ad-sign-in','plugin-install','plugin-job','plugin-remove'],'plugin-host and plugin-ad-identity run the four plugin kinds');
 }

 const heartbeatSource=fs.readFileSync('lib/server/agent/heartbeat.ts','utf8');
 check(/result = 'serverMessage\.job\.unsupported'/.test(heartbeatSource)&&/jobKindsOfCapabilities\(h\.capabilities\)/.test(heartbeatSource),true,'the heartbeat SQL keeps its literal and reads the kinds from the helper');

 console.log(`PASS heartbeat plugin jobs (${checks} checks): three heartbeats of agent 4.20.0 leave pending plugin-job reads and changes, plugin-install, plugin-remove and ad-sign-in pending and cancel set-rdp; without plugin-host or plugin-ad-identity those jobs are cancelled with serverMessage.job.unsupported; jobKindsOfCapabilities agrees with jobRequirements.`);
}finally{await d.close();}
