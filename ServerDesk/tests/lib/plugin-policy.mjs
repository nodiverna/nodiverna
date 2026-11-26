// The signed plugin policy of the agent channel (lib/server/agent/agent-channel.ts,
// docs/agent-plugins.md, "Signed collection") on PostgreSQL: every channel
// answer signs plugin-policy, with the DHCP read every 15 minutes only while
// the last snapshot reports the plugin dhcp ready with dhcp-read. The payload
// verifies with the public key of the portal job key. A successful plugin
// removal deletes the plugin data of the device in the transaction that ends
// the job. The channel's neighbours that this test does not need are stubs.
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
 const channel=load();
 function load(){return sourceLoader()('lib/server/agent/agent-channel.ts',imports);}
 const plugin=(state,capabilities=['dhcp-read'])=>({name:'dhcp',role:'dhcp',version:'1.0.0',capabilities,state,networkBlocked:true});
 async function device(plugins){
  const id=uuid();
  await insertRow(d,'servers',{id,name:'SRV-'+id.slice(0,6),token_hash:'fixture-'+id,created_at:clock,last_seen:clock,management:0,snapshot:JSON.stringify({protocolVersion:3,agentVersion:'4.16.0',mode:'ReadOnly',agentCapabilities:['plugin-host','signed-dispatch'],plugins})});
  return id;
 }
 const post=async(serverId,body={})=>{clock+=1000;const response=await channel.agentChannel(new Request('https://plugins.test/api/agent/channel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serverId,...body})}));return {status:response.status,body:await response.json()};};
 const verified=(envelope,deviceId)=>{
  check(crypto.verify('sha256',Buffer.from(envelope.payload,'utf8'),{key:keys.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(envelope.signature,'base64')),true,'the plugin policy verifies with the public key of the job key');
  const payload=JSON.parse(envelope.payload);
  check([payload.v,payload.kind,payload.deviceId,payload.exp-payload.iat],[1,'plugin-policy',deviceId,900],'kind, device and a 15-minute lifetime');
  return payload.policy;
 };
 const ready=await device([plugin('ready')]),none=await device([]),damaged=await device([plugin('damaged')]),noRead=await device([plugin('ready',['dhcp-write'])]);
 let answer=await post(ready);
 check(answer.status,200,'the channel answers');
 check(verified(answer.body.signedPluginPolicy,ready),{collect:[{plugin:'dhcp',operation:'dhcp-read',intervalSeconds:900}]},'dhcp ready with dhcp-read: the DHCP read every 15 minutes');
 for(const [label,id] of [['without the plugin',none],['with a damaged plugin',damaged],['without dhcp-read',noRead]])check(verified((await post(id)).body.signedPluginPolicy,id),{collect:[]},`${label}: no collection`);

 // A successful removal deletes the device's plugin data in the transaction that ends the job.
 const job=uuid(),other=uuid();
 await insertRow(d,'jobs',{id:job,server_id:ready,action:'plugin-remove',target:'dhcp',parameters:JSON.stringify({name:'dhcp'}),state:'running',created_at:clock,actor:'local:x',actor_email:'x@example.test',actor_principal:'private:x@example.test',claimed_at:clock,last_progress:clock});
 for(const [server,name] of [[ready,'dhcp'],[none,'dhcp'],[ready,'dns']])await insertRow(d,'device_plugin_data',{server_id:server,plugin:name,operation:name+'-read',data:'{}',summary:'[]',collected_at:clock,received_at:clock});
 await insertRow(d,'jobs',{id:other,server_id:none,action:'plugin-remove',target:'dhcp',parameters:JSON.stringify({name:'dhcp'}),state:'running',created_at:clock,actor:'local:x',actor_email:'x@example.test',actor_principal:'private:x@example.test',claimed_at:clock,last_progress:clock});
 answer=await post(none,{results:[{id:other,ok:false,message:'The plugin is busy with another task. Try again in a minute.',code:'AGENT_PLUGIN_BUSY'}]});
 check((await d.query(sql`SELECT plugin FROM device_plugin_data WHERE server_id=${none}`)).length,1,'a failed removal keeps the data');
 answer=await post(ready,{results:[{id:job,ok:true,message:'The plugin dhcp is removed.',code:'AGENT_PLUGIN_REMOVED',args:{name:'dhcp'}}]});
 check((await d.one(sql`SELECT state,result_code FROM jobs WHERE id=${job}`)),{state:'succeeded',result_code:'AGENT_PLUGIN_REMOVED'},'the removal succeeded');
 check((await d.query(sql`SELECT plugin FROM device_plugin_data WHERE server_id=${ready} ORDER BY plugin`)).map(row=>row.plugin),['dns'],'the data of the removed plugin are gone, other plugins stay');
 // A plugin result code passes through the channel as stored code and arguments.
 const read=uuid();
 await insertRow(d,'jobs',{id:read,server_id:ready,action:'plugin-job',target:'dhcp-read',parameters:JSON.stringify({plugin:'dhcp',operation:'dhcp-read'}),state:'running',created_at:clock,actor:'local:x',actor_email:'x@example.test',actor_principal:'private:x@example.test',claimed_at:clock,last_progress:clock});
 await post(ready,{results:[{id:read,ok:true,message:'The DHCP server was read: 3 scopes, 20 leases.',code:'PLUGIN_DHCP_READ_COMPLETED',args:{scopes:'3',leases:'20'}}]});
 check(await d.one(sql`SELECT state,result_code,result_args FROM jobs WHERE id=${read}`),{state:'succeeded',result_code:'PLUGIN_DHCP_READ_COMPLETED',result_args:'{"scopes":"3","leases":"20"}'},'a PLUGIN_ code is stored with its arguments');
 console.log(`PASS plugin policy (${checks} checks): signed plugin-policy with the DHCP read only for a ready plugin, verified with the job key; the removal deletes the plugin data with the job; plugin codes pass through.`);
}finally{await d.close();}
