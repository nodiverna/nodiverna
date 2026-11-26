// The job result of a plugin install or removal updates the stored snapshot (lib/server/agent/agent-channel.ts,
// lib/server/extensions/plugin-results.ts, docs/agent-plugins.md "Install and remove") on PostgreSQL: a succeeded
// plugin-remove drops the plugin entry and its device_plugin_data in the transaction that ends the job;
// a succeeded plugin-install (install, repair, rollout) writes the ready entry from the job parameters,
// sorted by name, in place of an older or damaged entry. Other snapshot keys and entries stay. A failed
// result, a job that is not running, a null snapshot, an unparsable manifest or a full list (16 other
// plugins) change no snapshot, while the job result is stored as before. The channel's neighbours that
// this test does not need are stubs, as in tests/lib/plugin-policy.mjs.
import {HttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {z} from 'zod';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';

const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const keys=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const signingKey=keys.privateKey.export({type:'pkcs8',format:'pem'});
 let clock=Date.now();
 const uuid=()=>crypto.randomUUID(),noop=async()=>{},allow=sql`TRUE`;
 const server={
  db:()=>d,now:()=>clock,config:key=>key==='AGENT_JOB_SIGNING_KEY'?signingKey:'',guid:value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  hash:async value=>crypto.createHash('sha256').update(value).digest('hex'),HttpError,log:noop,body:request=>request.json(),
  failure:error=>Response.json({error:error.message,messageKey:error.messageKey},{status:error.status??500}),
 };
 const deviceRow=id=>d.one(sql`SELECT id,last_seen,management,snapshot,name,agent_public_key FROM servers WHERE id=${id}`);
 const v3={snapshot:row=>row.snapshot?JSON.parse(row.snapshot):null,agentFromBearer:async request=>deviceRow((await request.clone().json()).serverId),assertAgentActive:noop,releaseLease:noop,securityFile:()=>false,lease:noop};
 const imports={
  '../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./agent-protocol':v3,'@/lib/server/agent/agent-protocol':v3,
  '../automation/runbooks':{tickAutomation:noop},'../automation/drift':{ingestDrift:noop},'../devices/file-access':{requireFileAccess:noop},
  '../devices/transfers':{verifyTransfer:noop,sweepTransfers:noop,transferAuthorizationGuard:()=>allow},'./transfers':{verifyTransfer:noop,sweepTransfers:noop,transferAuthorizationGuard:()=>allow},'../devices/terminal-lifecycle':{sweepTerminalSessions:noop},'../devices/rdp':{sweepRdp:noop},
  '../devices/terminal-channel':{terminalReport:z.object({}),exchangeTerminals:async()=>[]},
  '../automation/desired-state':{advanceDesiredState:noop,checkPendingDesiredJob:async()=>true,desiredJobClaimGuard:async()=>allow},
  '../automation/desired-state-result':{desiredResultActions:new Set(),desiredResultStatement:()=>null},
  '../automation/automation-device':{reconcileDeviceAutomation:noop,getAutomationDriftPolicy:async()=>null},
 };
 const channel=sourceLoader()('lib/server/agent/agent-channel.ts',imports);

 // The channel needs a v3 snapshot to accept the post; the fixture devices without one are posted from a helper device.
 const base={protocolVersion:3,agentVersion:'4.21.3',mode:'ReadOnly',agentCapabilities:['plugin-host','signed-dispatch'],os:'Microsoft Windows Server 2022 Datacenter'};
 const entry=(name,extra={})=>({name,target:name,version:'1.0.0',capabilities:[name+'-read'],state:'ready',networkBlocked:true,...extra});
 async function device(snapshot){
  const id=uuid();
  await insertRow(d,'servers',{id,name:'SRV-'+id.slice(0,6),token_hash:'fixture-'+id,created_at:clock,last_seen:clock,management:0,snapshot:snapshot===null?null:JSON.stringify(snapshot)});
  return id;
 }
 const stored=async id=>{const row=await d.one(sql`SELECT snapshot FROM servers WHERE id=${id}`);return row.snapshot===null?null:JSON.parse(row.snapshot);};
 const job=async(serverId,action,target,parameters,state='running')=>{
  const id=uuid();
  await insertRow(d,'jobs',{id,server_id:serverId,action,target,parameters:JSON.stringify(parameters),state,created_at:clock,actor:'local:x',actor_email:'x@example.test',actor_principal:'private:x@example.test',claimed_at:clock,last_progress:clock});
  return id;
 };
 const post=async(serverId,results)=>{clock+=1000;const response=await channel.agentChannel(new Request('https://plugins.test/api/agent/channel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serverId,results})}));return response.status;};
 const jobState=async id=>(await d.one(sql`SELECT state FROM jobs WHERE id=${id}`)).state;
 const removed={ok:true,message:'The plugin dhcp is removed.',code:'AGENT_PLUGIN_REMOVED',args:{name:'dhcp'}};
 const installed={ok:true,message:'The plugin is installed.'};
 const manifest=(extra={})=>JSON.stringify({name:'dhcp',version:'1.1.0',target:'dhcp',role:'dhcp',capabilities:['dhcp-read','dhcp-scope-create'],kind:'plugin',...extra});
 const installParams=(manifestText=manifest())=>({name:'dhcp',releaseId:uuid(),version:'1.1.0',manifest:manifestText,signature:'c2lnbmF0dXJl'});
 const expectedEntry={name:'dhcp',target:'dhcp',version:'1.1.0',capabilities:['dhcp-read','dhcp-scope-create'],state:'ready',networkBlocked:true};

 // ---- A succeeded removal drops the entry, keeps the rest, deletes the plugin data ----
 {
  const id=await device({...base,plugins:[entry('dns'),entry('dhcp')]});
  for(const name of ['dhcp','dns'])await insertRow(d,'device_plugin_data',{server_id:id,plugin:name,operation:name+'-read',data:'{}',summary:'[]',collected_at:clock,received_at:clock});
  const remove=await job(id,'plugin-remove','dhcp',{name:'dhcp'});
  check(await post(id,[{id:remove,...removed}]),200,'the channel answers');
  const after=await stored(id);
  check(after.plugins,[entry('dns')],'the dhcp entry is gone, the dns entry is unchanged');
  check([after.os,after.agentVersion,after.protocolVersion,after.agentCapabilities],[base.os,base.agentVersion,3,base.agentCapabilities],'the other snapshot keys are unchanged');
  check((await d.query(sql`SELECT plugin FROM device_plugin_data WHERE server_id=${id}`)).map(row=>row.plugin),['dns'],'the data of the removed plugin are gone');
  check(await d.one(sql`SELECT state,result_code,parameters FROM jobs WHERE id=${remove}`),{state:'succeeded',result_code:'AGENT_PLUGIN_REMOVED',parameters:'{}'},'the job succeeded with its code, parameters wiped');
 }
 // ---- A failed removal changes no snapshot ----
 {
  const snapshot={...base,plugins:[entry('dhcp'),entry('dns')]},id=await device(snapshot);
  const remove=await job(id,'plugin-remove','dhcp',{name:'dhcp'});
  await post(id,[{id:remove,ok:false,message:'The plugin is busy with another task. Try again in a minute.',code:'AGENT_PLUGIN_BUSY'}]);
  check(await stored(id),snapshot,'a failed removal: snapshot unchanged');
  check(await jobState(remove),'failed','and the job failed');
 }
 // ---- A succeeded install writes the ready entry, sorted by name ----
 {
  const id=await device({...base,plugins:[entry('dns'),entry('ad-ds')]});
  const install=await job(id,'plugin-install','dhcp 1.1.0',installParams());
  await post(id,[{id:install,...installed}]);
  const after=await stored(id);
  check(after.plugins.find(plugin=>plugin.name==='dhcp'),expectedEntry,'the entry from the job parameters and the manifest');
  check(after.plugins.map(plugin=>plugin.name),['ad-ds','dhcp','dns'],'the list is sorted by name');
  check([after.plugins[0],after.plugins[2],after.os],[entry('ad-ds'),entry('dns'),base.os],'the other entries and keys stay');
  check(await jobState(install),'succeeded','the install succeeded');
 }
 // ---- A role-only manifest: target = role; a snapshot without plugins gets the key ----
 {
  const id=await device({...base});
  const install=await job(id,'plugin-install','dhcp 1.1.0',installParams(manifest({target:undefined})));
  await post(id,[{id:install,...installed}]);
  check((await stored(id)).plugins,[expectedEntry],'a role-only manifest gives target = role; the plugins key is created');
 }
 // ---- Repair: a damaged entry is replaced by the ready entry without error ----
 {
  const id=await device({...base,plugins:[entry('dhcp',{version:'1.1.0',state:'damaged',networkBlocked:false,error:'AGENT_PLUGIN_HASH_MISMATCH'}),entry('dns')]});
  const repair=await job(id,'plugin-install','dhcp 1.1.0',installParams());
  await post(id,[{id:repair,...installed}]);
  check((await stored(id)).plugins,[expectedEntry,entry('dns')],'the damaged entry is replaced by the ready one without error');
 }
 // ---- An older version is replaced (rollout) ----
 {
  const id=await device({...base,plugins:[entry('dhcp')]});
  const rollout=await job(id,'plugin-install','dhcp 1.1.0',installParams());
  await post(id,[{id:rollout,...installed}]);
  check((await stored(id)).plugins,[expectedEntry],'the entry of 1.0.0 is replaced by 1.1.0');
 }
 // ---- No write: an unparsable manifest, no capabilities, no target or role, a full list ----
 for(const [label,text] of [['an unparsable manifest','{not json'],['a manifest without capabilities',manifest({capabilities:undefined})],['a manifest without target or role',manifest({target:undefined,role:undefined})]]){
  const snapshot={...base,plugins:[entry('dns')]},id=await device(snapshot);
  const install=await job(id,'plugin-install','dhcp 1.1.0',installParams(text));
  await post(id,[{id:install,...installed}]);
  check([await stored(id),await jobState(install)],[snapshot,'succeeded'],`${label}: snapshot unchanged, the job succeeded`);
 }
 {
  const others=Array.from({length:16},(_,index)=>entry('p'+String(index).padStart(2,'0')));
  const snapshot={...base,plugins:others},id=await device(snapshot);
  const install=await job(id,'plugin-install','dhcp 1.1.0',installParams());
  await post(id,[{id:install,...installed}]);
  check([await stored(id),await jobState(install)],[snapshot,'succeeded'],'16 other plugins: snapshot unchanged, the job succeeded');
  // With 15 others and an older dhcp entry the install replaces it.
  const fifteen={...base,plugins:[...others.slice(0,15),entry('dhcp')]},full=await device(fifteen);
  const replace=await job(full,'plugin-install','dhcp 1.1.0',installParams());
  await post(full,[{id:replace,...installed}]);
  check((await stored(full)).plugins.length,16,'15 others and the replaced dhcp entry: 16 entries');
 }
 // ---- A result for a job that is not running, and a null snapshot ----
 {
  const snapshot={...base,plugins:[entry('dhcp'),entry('dns')]},id=await device(snapshot);
  for(const state of ['succeeded','expired']){
   const remove=await job(id,'plugin-remove','dhcp',{name:'dhcp'},state);
   await post(id,[{id:remove,...removed}]);
   check(await stored(id),snapshot,`a result for a job already ${state}: snapshot unchanged`);
   const install=await job(id,'plugin-install','dhcp 1.1.0',installParams(),state);
   await post(id,[{id:install,...installed}]);
   check(await stored(id),snapshot,`an install result for a job already ${state}: snapshot unchanged`);
  }
 }
 {
  // The channel needs a v3 snapshot to accept the post; the null snapshot is set after the job is claimed.
  const id=await device({...base,plugins:[entry('dhcp')]});
  const remove=await job(id,'plugin-remove','dhcp',{name:'dhcp'}),install=await job(id,'plugin-install','dhcp 1.1.0',installParams());
  const originalSnapshot=v3.snapshot;v3.snapshot=row=>row.id===id?base:originalSnapshot(row);
  await d.exec(sql`UPDATE servers SET snapshot=NULL WHERE id=${id}`);
  await post(id,[{id:remove,...removed},{id:install,...installed}]);
  check([await stored(id),await jobState(remove),await jobState(install)],[null,'succeeded','succeeded'],'a null snapshot stays null; both jobs succeed');
  await d.exec(sql`UPDATE servers SET snapshot='[1,2]' WHERE id=${id}`);
  const again=await job(id,'plugin-install','dhcp 1.1.0',installParams());
  await post(id,[{id:again,...installed}]);
  check((await d.one(sql`SELECT snapshot FROM servers WHERE id=${id}`)).snapshot,'[1,2]','a snapshot that is no JSON object stays as it is');
  v3.snapshot=originalSnapshot;
 }
 console.log(`PASS plugin job results (${checks} checks): a succeeded removal drops the plugin entry and its data, a succeeded install or repair writes the ready entry sorted by name; other keys and entries stay; failed results, jobs that are not running, a null snapshot, an invalid manifest and a full list change no snapshot.`);
}finally{await d.close();}
