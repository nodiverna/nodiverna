// The heartbeat keeps a succeeded plugin install or removal for PLUGIN_RESULT_HOLD_MS (lib/server/agent/heartbeat.ts,
// lib/server/extensions/plugin-results.ts, docs/agent-plugins.md "Install and remove"). The agent keeps a busy plugin's last
// entry while the removal holds its gate, so a heartbeat collected during the removal still lists the
// plugin and can arrive after the job result. Runs the real heartbeat route against a test database:
// - remove succeeded 30 s ago: a heartbeat that lists the plugin is stored without it; 90 001 ms after the
//   job, or with a newer pending install job, the report is stored as sent;
// - install succeeded 30 s ago: a heartbeat without the plugin keeps the stored entry at the job's version;
//   a damaged report always wins; outside the window the report is stored as sent;
// - a failed newest job leaves the report unchanged;
// and the pure merge (reconcilePluginReports, heldPluginResults, installedPluginEntry).
import '../support/register.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {HttpError} from '../support/http-error.mjs';
import {serverText} from '../support/server-text.mjs';

const uuid=()=>crypto.randomUUID(),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const customerA='00000000-0000-4000-8000-000000000100',minute=60_000,second=1000;
let clock=Date.UTC(2026,10,14,9,0,0),checks=0;
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
const results=await import('../../lib/server/extensions/plugin-results.ts');

const agents=new Map();
async function device(name){
 const id=uuid(),token=crypto.randomBytes(32).toString('hex'),jwk=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'});
 await insertRow(d,'servers',{id,name,token_hash:sha(token),token_expires_at:clock+365*24*60*minute,created_at:clock,last_seen:clock-minute,management:1,snapshot:null,agent_public_key:JSON.stringify({kty:jwk.kty,n:jwk.n,e:jwk.e}),customer_id:customerA});
 agents.set(id,{token,jwk});return id;
}
// One heartbeat of agent 4.21.3 with these plugin reports, one minute after the previous one.
const beat=async(id,plugins)=>{
 const {token,jwk}=agents.get(id);
 const snapshot={hostname:'SRV-DC01',os:'Microsoft Windows Server 2022 Datacenter',build:'20348',manufacturer:'Microsoft',model:'VM',domain:'corp.example',cores:4,memoryGb:8,cpu:10,memory:20,uptimeSeconds:300,rebootPending:false,management:true,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.21.3',mode:'Management',publicKey:{kty:'RSA',n:jwk.n,e:jwk.e},agentCapabilities:['refresh','plugin-host'],plugins};
 const response=await heartbeatApi.POST(new Request('https://heartbeat.test/api/heartbeat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({serverId:id,snapshot,results:[],runningJobs:[]})}));
 assert.equal(response.status,200,`the heartbeat is stored: ${JSON.stringify(await response.clone().json())}`);
};
const storedPlugins=async id=>JSON.parse((await d.one(sql`SELECT snapshot FROM servers WHERE id=${id}`)).snapshot).plugins;
const names=async id=>(await storedPlugins(id)).map(plugin=>plugin.name);
// A job that ended `ago` ms before the clock (last_progress), created a minute before it ended.
const job=async(serverId,action,target,state,ago,created=null)=>{
 const id=uuid(),ended=clock-ago;
 await insertRow(d,'jobs',{id,server_id:serverId,action,target,parameters:'{}',state,created_at:created??ended-minute,actor:'fixture',actor_email:'fixture@heartbeat.test',actor_principal:'private:fixture@heartbeat.test',claimed_at:state==='pending'?null:ended-minute+second,last_progress:state==='pending'?null:ended});
 return id;
};
const report=(name,extra={})=>({name,target:name,version:'1.1.0',capabilities:[name+'-read'],state:'ready',networkBlocked:true,...extra});
const step=()=>{clock+=minute;};

try{
 check(results.PLUGIN_RESULT_HOLD_MS,90_000,'PLUGIN_RESULT_HOLD_MS is 90 seconds');

 // ---- Remove succeeded: a stale report is dropped inside the window ----
 {
  const id=await device('SRV-REMOVE');
  step();await beat(id,[report('dhcp'),report('dns')]);
  step();await job(id,'plugin-remove','dhcp','succeeded',30*second);
  await beat(id,[report('dhcp'),report('dns')]);
  check(await storedPlugins(id),[report('dns')],'remove succeeded 30 s ago, the heartbeat lists dhcp: stored without dhcp');
  check(await names(id),['dns'],'the dns entry stays');
 }
 {
  const id=await device('SRV-REMOVE-EDGE');
  step();await job(id,'plugin-remove','dhcp','succeeded',90_000);
  await beat(id,[report('dhcp'),report('dns')]);
  check(await names(id),['dns'],'at exactly 90 000 ms the removal still holds');
 }
 {
  const id=await device('SRV-REMOVE-LATE');
  step();await job(id,'plugin-remove','dhcp','succeeded',90_001);
  await beat(id,[report('dhcp'),report('dns')]);
  check(await names(id),['dhcp','dns'],'at 90 001 ms the report is stored with dhcp');
 }
 {
  const id=await device('SRV-REMOVE-NEWER');
  step();await job(id,'plugin-remove','dhcp','succeeded',30*second);
  await job(id,'plugin-install','dhcp 1.1.0','pending',0,clock-10*second);
  await beat(id,[report('dhcp'),report('dns')]);
  check(await names(id),['dhcp','dns'],'a newer pending install job for dhcp: stored with dhcp');
 }
 {
  const id=await device('SRV-REMOVE-FAILED');
  step();await job(id,'plugin-install','dhcp 1.1.0','succeeded',5*minute);
  await job(id,'plugin-remove','dhcp','failed',30*second);
  await beat(id,[report('dhcp'),report('dns')]);
  check(await names(id),['dhcp','dns'],'a failed newest remove: the report is stored unchanged');
 }

 // ---- Install succeeded: the stored entry at the job's version stays until the agent reports ----
 const portalEntry={name:'dhcp',target:'dhcp',version:'1.1.0',capabilities:['dhcp-read','dhcp-scope-create'],state:'ready',networkBlocked:true};
 const withPortalEntry=async id=>{
  step();await beat(id,[report('dns')]);
  // The entry the channel wrote with the job result (tests/lib/plugin-job-results.mjs).
  await d.exec(sql`UPDATE servers SET snapshot=jsonb_set(snapshot::jsonb,'{plugins}',${JSON.stringify([portalEntry,report('dns')])}::jsonb)::text WHERE id=${id}`);
  step();
 };
 {
  const id=await device('SRV-INSTALL');
  await withPortalEntry(id);
  await job(id,'plugin-install','dhcp 1.1.0','succeeded',30*second);
  await beat(id,[report('dns')]);
  check(await storedPlugins(id),[portalEntry,report('dns')],'install succeeded 30 s ago, heartbeat without the plugin: the stored entry is kept, sorted by name');
  step();
  const damaged=report('dhcp',{state:'damaged',networkBlocked:false,error:'AGENT_PLUGIN_HASH_MISMATCH'});
  await beat(id,[damaged,report('dns')]);
  check(await storedPlugins(id),[damaged,report('dns')],'a damaged report of the plugin always wins');
 }
 {
  const id=await device('SRV-INSTALL-LATE');
  await withPortalEntry(id);
  await job(id,'plugin-install','dhcp 1.1.0','succeeded',90_001);
  await beat(id,[report('dns')]);
  check(await names(id),['dns'],'outside the window the report is stored without the plugin');
 }
 {
  const id=await device('SRV-INSTALL-VERSION');
  await withPortalEntry(id);
  await job(id,'plugin-install','dhcp 1.2.0','succeeded',30*second);
  await beat(id,[report('dns')]);
  check(await names(id),['dns'],'a stored entry at another version than the job is not kept');
 }
 {
  const id=await device('SRV-INSTALL-FAILED');
  await withPortalEntry(id);
  await job(id,'plugin-install','dhcp 1.1.0','failed',30*second);
  await beat(id,[report('dns')]);
  check(await names(id),['dns'],'a failed newest install: the report is stored unchanged');
 }

 // ---- The pure merge ----
 {
  const time=clock,record=(action,target,state,ago,createdAgo=ago+minute)=>({action,target,state,createdAt:time-createdAgo,endedAt:time-ago});
  const incoming=[report('dhcp'),report('dns')];
  check(results.reconcilePluginReports(incoming,undefined,[],time)===incoming,true,'without jobs the incoming list itself is returned');
  check(results.reconcilePluginReports(incoming,undefined,[record('plugin-remove','dhcp','succeeded',30*second)],time),[report('dns')],'a held removal drops the entry');
  check(results.reconcilePluginReports(undefined,[portalEntry],[record('plugin-install','dhcp 1.1.0','succeeded',30*second)],time),[portalEntry],'a report without plugins gets the kept entry');
  check(results.reconcilePluginReports([report('ad-ds'),report('dns')],[portalEntry],[record('plugin-install','dhcp 1.1.0','succeeded',30*second)],time).map(entry=>entry.name),['ad-ds','dhcp','dns'],'the kept entry at its name position');
  const sixteen=Array.from({length:16},(_,index)=>report('p'+String(index).padStart(2,'0')));
  check(results.reconcilePluginReports(sixteen,[portalEntry],[record('plugin-install','dhcp 1.1.0','succeeded',30*second)],time)===sixteen,true,'a full list keeps no extra entry');
  check([...results.heldPluginResults([record('plugin-install','dhcp 1.1.0','succeeded',30*second,2*minute),record('plugin-remove','dhcp','running',0,minute),record('plugin-job','dns-read','succeeded',0)],time)],[],'the newest job (an open removal) holds nothing; other kinds are ignored');
  check([...results.heldPluginResults([record('plugin-install','dns 1.0.0','succeeded',second)],time)],[['dns',{kind:'install',version:'1.0.0'}]],'a held install names its version');
  check(results.installedPluginEntry({name:'dhcp',version:'1.1.0',manifest:JSON.stringify({role:'dhcp',capabilities:['dhcp-read']})}),{name:'dhcp',target:'dhcp',version:'1.1.0',capabilities:['dhcp-read'],state:'ready',networkBlocked:true},'installedPluginEntry: target from the role');
  check([results.installedPluginEntry({name:'dhcp',version:'1.1.0',manifest:'{'}),results.installedPluginEntry({name:'dhcp',version:'1.1.0',manifest:'{"target":"dhcp"}'}),results.installedPluginEntry({name:'dhcp',manifest:'{"target":"dhcp","capabilities":[]}'}),results.installedPluginEntry(null)],[null,null,null,null],'installedPluginEntry: null without a valid manifest, version or parameters');
 }

 console.log(`PASS heartbeat plugin results (${checks} checks): for 90 s after a succeeded removal a heartbeat that still lists the plugin is stored without it, after a succeeded install the stored entry at the job version stays until the agent reports; a damaged report, a newer open job, a failed job and the end of the window store the report as sent; the pure merge.`);
}finally{await d.close();}
