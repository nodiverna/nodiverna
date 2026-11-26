// DNS changes on PostgreSQL (POST /api/dns, lib/server/extensions/dns-manage.ts, docs/dns-server.md
// "Change the DNS server"): a change queues one plugin job with actAs and one
// audit row that names the AD account; each refusal of the gates, in their
// order, writes nothing; a DNS change through POST /api/plugins is refused;
// dns-zone-read takes {zone} of the latest read, is unique per device and zone
// and refuses anything else, also next to jobs whose parameters are no JSON
// object (jsonText guard). Real routes and libraries (access, rbac, mfa, v3)
// run against an isolated migrated database.
import {HttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';
import {sessionHeaders} from '../support/session-cookies.mjs';
import {sql} from '../../runtime/database.mjs';

const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const origin='https://dns.test',time=Date.now();
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex'),uuid=()=>crypto.randomUUID();
 let current=null;
 const identity=async()=>{if(!current)throw new HttpError(401,'Sign in.','IDENTITY_LOGIN_REQUIRED');return current;};
 const server={
  db:()=>d,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:'',now:()=>Date.now(),random:token,hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:request=>request.json(),sameOrigin:()=>{},
  requireViewer:identity,requireIdentity:identity,requireAuthIdentity:async()=>current,log:async()=>{},
  failure:e=>{const known=e instanceof HttpError||e instanceof Error&&typeof e.status==='number'&&typeof e.code==='string';return Response.json({error:e instanceof Error?e.message:'failed',...(known?{code:e.code,messageKey:e.messageKey,params:e.params}:{})},{status:known?e.status:500});},
 };
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server};
 const load=sourceLoader();
 const api=load('app/api/dns/route.ts',imports),plugins=load('app/api/plugins/route.ts',imports),{demoDnsSnapshot,demoDnsRecords}=load('ui/shell/demo-dns.ts',imports);
 const {DNS_CHANGE_OPERATIONS,DNS_READ_OPERATIONS}=load('lib/plugin-catalog.ts',imports);

 // ---- Fixture ------------------------------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const count=async statement=>Number((await d.one(statement)).n);
 const jobs=()=>count(sql`SELECT count(*) AS n FROM jobs`),audits=()=>count(sql`SELECT count(*) AS n FROM audit WHERE scope='device'`);
 async function account(label,permissions){
  const {actor}=await sourceActor(d,label,permissions);actor.userId=actor.id;
  await d.exec(sql`UPDATE local_users SET password_hash='fixture-password',must_reset=0 WHERE id=${actor.id}`);
  await insert('mfa_accounts',{principal:actor.principal,secret_enc:'migrated:authenticator-managed',recovery_hashes:'[]',last_counter:-1,created_at:time,authenticators_migrated:1});
  return actor;
 }
 const corpSid='S-1-5-21-1000-2000-3000';
 const corp={kind:'domain',name:'corp.example',netbiosName:'CORP',sid:corpSid};
 async function browser(actor,{ad=true}={}){
  const at=Date.now(),primary=token(),session=token();
  await insert('mfa_sessions',{token_hash:sha(session),principal:actor.principal,created_at:at,last_activity:at,idle_expires_at:at+900_000,expires_at:at+86_400_000});
  await insert('local_auth_sessions',{token_hash:sha(primary),user_id:actor.id,auth_version:1,created_at:at,expires_at:at+86_400_000,pending_until:at+600_000,mfa_hash:sha(session)});
  const b={primary,session};
  if(ad){b.adSession=uuid();await insert('plugin_ad_sessions',{id:b.adSession,principal:actor.principal,session_hash:sha(session),state:'active',source:'password',directory_kind:'domain',directory_name:'corp.example',directory_sid:corpSid,user_sid:corpSid+'-1105',account:'CORP\\anna',upn:null,created_at:at,verified_at:at,expires_at:at+8*3600_000});}
  return b;
 }
 const keyPair=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),jwk=keyPair.publicKey.export({format:'jwk'});
 const capabilities=[...DNS_READ_OPERATIONS,...DNS_CHANGE_OPERATIONS];
 const plugin=(caps=capabilities)=>({name:'dns',role:'dns',version:'1.0.0',capabilities:caps,state:'ready',networkBlocked:true});
 async function device(name,{plugins=[plugin()],management=1,mode='Management',lastSeen=Date.now(),agent=['plugin-host','plugin-ad-identity'],data=true,service='running'}={}){
  const id=uuid();
  const snapshot={protocolVersion:3,agentVersion:'4.20.0',mode,agentCapabilities:agent,plugins,publicKey:{kty:'RSA',n:jwk.n,e:jwk.e},hostname:name,domain:'corp.example',security:{directory:corp}};
  await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:lastSeen,management,snapshot:JSON.stringify(snapshot)});
  if(data){
   const read={...demoDnsSnapshot(time),service};
   await insert('device_plugin_data',{server_id:id,plugin:'dns',operation:'dns-read',data:JSON.stringify(read),summary:'[]',collected_at:time,received_at:time,service});
  }
  return id;
 }
 const zoneRecords=async(id,zone='corp.example')=>{const records=demoDnsRecords(time,zone);await insert('device_dns_zone_records',{server_id:id,zone,data:JSON.stringify(records),record_count:records.total,truncated:false,collected_at:time,received_at:time});};
 const call=async(actor,b,payload,route=api)=>{current=actor;const response=await route.POST(new Request(origin+'/api/dns',{method:'POST',headers:sessionHeaders(b,{'Content-Type':'application/json'}),body:JSON.stringify(payload)}));return {status:response.status,body:await response.json()};};
 const change=(serverId,operation,parameters,extra={})=>({action:'change',serverId,operation,parameters,confirm:true,...extra});
 const record={zone:'corp.example',name:'WWW',type:'A',ttlSeconds:null,ageRecord:false,data:{address:'10.10.1.80'}};

 const owner=await account('owner@dns.test',['*']),manager=await account('manager@dns.test',['view','dns.read','dns.manage']),reader=await account('reader@dns.test',['view','dns.read']);
 const dc01=await device('SRV-DC01');await zoneRecords(dc01);
 const mb=await browser(manager);

 // ---- One change: one job with actAs, one audit row -------------------------------------
 {
  const result=await call(manager,mb,change(dc01,'dns-record-add',record));
  check(result.status,200,'a change with the right, MFA, Management mode, the AD sign-in and a confirmation');
  check(result.body.jobs.map(job=>job.serverId),[dc01],'one job on the device');
  const job=await d.one(sql`SELECT action,target,parameters,state FROM jobs WHERE id=${result.body.jobs[0].id}`);
  const actAs={sessionId:mb.adSession,userSid:corpSid+'-1105',logonName:'CORP\\anna',account:'CORP\\anna',kind:'domain'};
  check([job.action,job.target,job.state,JSON.parse(job.parameters)],['plugin-job','dns-record-add','pending',{plugin:'dns',operation:'dns-record-add',parameters:{...record,name:'www'},actAs}],'the job: the operation as target, normalized parameters, actAs');
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE action='Add DNS record' AND target='SRV-DC01 / corp.example / www A (AD: CORP\\anna)' AND server_id=${dc01}`),1,'the audit row: the English label and the AD account');
  // Several change jobs may wait on one device.
  const second=await call(manager,mb,change(dc01,'dns-cache-clear',{}));
  check([second.status,await jobs()],[200,2],'a second change waits next to the first');
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE action='Clear DNS cache' AND target='SRV-DC01 / Cache (AD: CORP\\anna)'`),1,'the object of a server change');
  const zoneCreate=await call(manager,mb,change(dc01,'dns-zone-create',{kind:'primary',lookup:'reverse',networkId:'10.30',storage:'ad',replicationScope:'domain',fileName:null,masters:[],dynamicUpdate:'secure'}));
  check(JSON.parse((await d.one(sql`SELECT parameters FROM jobs WHERE id=${zoneCreate.body.jobs[0].id}`)).parameters).parameters.name,'30.10.in-addr.arpa','the job carries the reverse zone name');
  await d.exec(sql`DELETE FROM jobs`);await d.exec(sql`DELETE FROM audit`);
 }

 // ---- Each refusal writes nothing, in the order of the gates ------------------------------------------------
 {
  const refuse=async(label,actor,b,payload,key,params)=>{
   const before=[await jobs(),await audits()],result=await call(actor,b,payload);
   check([result.body.messageKey??result.body.code,...(params?[result.body.params]:[])],[key,...(params?[params]:[])],label);
   check([await jobs(),await audits()],before,label+': nothing written');
   return result;
  };
  await refuse('1. an unknown operation',manager,mb,change(dc01,'dns-write',{}),'apiError.plugin.operationUnknown');
  await refuse('1. a read is no change',manager,mb,change(dc01,'dns-read',{}),'apiError.plugin.operationUnknown');
  await refuse('2. without dns.manage',reader,await browser(reader),change(dc01,'dns-record-add',record),'apiError.access.devicePermissionMissing');
  await refuse('3. offline',manager,mb,change(await device('SRV-OFF',{lastSeen:Date.now()-10*60_000}),'dns-record-add',record),'apiError.agent.notConnected',{name:'SRV-OFF'});
  await refuse('4. no plugin host',manager,mb,change(await device('SRV-NOHOST',{agent:[]}),'dns-record-add',record),'apiError.agent.v3FunctionRequired',{name:'SRV-NOHOST'});
  await refuse('5. the plugin lacks the operation',manager,mb,change(await device('SRV-OLD',{plugins:[plugin(['dns-read'])]}),'dns-record-add',record),'apiError.dns.pluginMissing',{name:'SRV-OLD'});
  await refuse('5. no DNS plugin',manager,mb,change(await device('SRV-NOPLUGIN',{plugins:[]}),'dns-record-add',record),'apiError.dns.pluginMissing',{name:'SRV-NOPLUGIN'});
  await refuse('6. without an MFA session',manager,null,change(dc01,'dns-record-add',record),'apiError.mfa.loginRequired');
  const busy=await device('SRV-BUSY');await insert('device_leases',{server_id:busy,owner_kind:'maintenance',owner_id:uuid(),expires_at:Date.now()+600_000});
  await refuse('7. maintenance',manager,mb,{...change(busy,'dns-record-add',record),confirm:false},'apiError.agent.maintenanceRetry');
  await refuse('8. ReadOnly (management off)',manager,mb,change(await device('SRV-RO',{management:0}),'dns-record-add',record),'apiError.agent.readOnlyEnableManagement');
  await refuse('8. ReadOnly (agent mode)',manager,mb,change(await device('SRV-RO2',{mode:'ReadOnly'}),'dns-record-add',record),'apiError.agent.readOnlyEnableManagement');
  const noAd=await refuse('9. without an AD sign-in',manager,await browser(manager,{ad:false}),change(dc01,'dns-record-add',record),'apiError.pluginAd.signInRequired',{domain:'corp.example',serverId:dc01});
  check([noAd.status,noAd.body.code],[403,'PLUGIN_AD_SIGN_IN_REQUIRED'],'403 PLUGIN_AD_SIGN_IN_REQUIRED');
  await refuse('9. an agent without plugin-ad-identity',manager,mb,change(await device('SRV-419',{agent:['plugin-host']}),'dns-record-add',record),'apiError.pluginAd.agentTooOld',{name:'SRV-419'});
  await refuse('9. the sign-in before the confirmation',manager,await browser(manager,{ad:false}),{...change(dc01,'dns-record-add',record),confirm:false},'apiError.pluginAd.signInRequired',{domain:'corp.example',serverId:dc01});
  await refuse('10. without confirmation',manager,mb,{...change(dc01,'dns-record-add',record),confirm:false},'apiError.console.confirmServerChange');
  await refuse('11. no stored read',manager,mb,change(await device('SRV-NODATA',{data:false}),'dns-record-add',record),'apiError.dns.noData',{name:'SRV-NODATA'});
  await refuse('12. a stopped service',manager,mb,change(await device('SRV-STOP',{service:'stopped'}),'dns-record-add',record),'apiError.dns.serviceStopped',{name:'SRV-STOP'});
  const invalid=await refuse('13. values that do not fit',manager,mb,change(dc01,'dns-record-add',{...record,name:'intranet',data:{address:'10.0.0.300'}}),'apiError.dns.changeInvalid',{fields:'address'});
  check([invalid.status,invalid.body.errors],[400,[{field:'address',code:'ipv4'}]],'changeInvalid: 400 with the field errors');
  const conflict=await call(manager,mb,change(dc01,'dns-record-add',{...record,name:'intranet'}));
  check([conflict.status,conflict.body.errors],[400,[{field:'name',code:'cnameTaken',params:{name:'intranet'}}]],'the stored records of the zone decide a CNAME conflict');
  const notRead=await call(manager,mb,change(dc01,'dns-record-add',{...record,zone:'20.10.in-addr.arpa',name:'9.9',type:'PTR',data:{host:'x.corp.example'}}));
  check(notRead.body.errors,[{field:'zone',code:'recordsNotRead'}],'a zone without stored records: recordsNotRead');
  const full=await device('SRV-FULL');
  for(let n=0;n<20;n++)await insert('jobs',{id:uuid(),server_id:full,action:'refresh',target:'',parameters:'{}',state:'pending',created_at:time,actor:owner.id,actor_email:owner.label,actor_principal:owner.principal});
  const before=await jobs(),result=await call(manager,mb,change(full,'dns-cache-clear',{}));
  check([result.status,result.body.messageKey,await jobs()],[429,'apiError.console.queueFull',before],'14. a full queue: 429 and nothing written');
  await d.exec(sql`DELETE FROM jobs`);
  // POST /api/plugins with action job accepts only reads.
  const viaPlugins=await call(manager,mb,{action:'job',serverId:dc01,plugin:'dns',operation:'dns-zone-delete',parameters:{zone:'corp.example'}},plugins);
  check([viaPlugins.body.messageKey,await jobs()],['apiError.plugin.operationUnknown',0],'a DNS change through /api/plugins is refused');
 }

 // ---- dns-zone-read: {zone} of the latest read, one open job per device and zone -------------------------------
 {
  const rb=await browser(reader,{ad:false});
  const read=(parameters,serverId=dc01)=>call(reader,rb,{action:'job',serverId,plugin:'dns',operation:'dns-zone-read',...(parameters===undefined?{}:{parameters})},plugins);
  // Open zone reads whose free-text parameters are no JSON object (legacy rows) neither break nor match the guard.
  for(const [parameters,state] of [['legacy','pending'],['[1]','running'],['"x"','pending']])await insert('jobs',{id:uuid(),server_id:dc01,action:'plugin-job',target:'dns-zone-read',parameters,state,created_at:time,actor:owner.id,actor_email:owner.label,actor_principal:owner.principal});
  const legacy=3;
  const first=await read({zone:'corp.example'});
  check(first.status,200,'a zone read with dns.read, without MFA and without an AD sign-in');
  check(JSON.parse((await d.one(sql`SELECT parameters FROM jobs WHERE id=${first.body.id}`)).parameters),{plugin:'dns',operation:'dns-zone-read',parameters:{zone:'corp.example'}},'the job carries the zone and no actAs');
  check((await read({zone:'corp.example'})).body.id,first.body.id,'a second request answers the open job of the zone');
  const other=await read({zone:'20.10.in-addr.arpa'});
  check([other.status,other.body.id!==first.body.id,await jobs()],[200,true,legacy+2],'another zone gets its own job');
  check([(await read({zone:'gone.example'})).body.messageKey,(await read({zone:'gone.example'})).body.params],['apiError.dns.zoneMissing',{zone:'gone.example'}],'a zone that is not in the latest read');
  check((await read({zone:'branch.example'})).body.messageKey,'apiError.dns.zoneMissing','a conditional forwarder has no records to read');
  check((await read(undefined)).body.messageKey,'apiError.request.invalid','the zone read needs parameters');
  check((await read({zone:'corp.example',extra:1})).body.messageKey,'apiError.request.invalid','the parameters are strict');
  check((await read({zone:'corp.example'},await device('SRV-NOREAD',{data:false}))).body.messageKey,'apiError.dns.zoneMissing','no stored read: no zone');
  check(await jobs(),legacy+2,'the refusals wrote nothing');
  const server=await call(reader,rb,{action:'job',serverId:dc01,plugin:'dns',operation:'dns-read',parameters:{zone:'ignored'}},plugins);
  check(JSON.parse((await d.one(sql`SELECT parameters FROM jobs WHERE id=${server.body.id}`)).parameters),{plugin:'dns',operation:'dns-read'},'dns-read takes no parameters');
  const none=await account('none@dns.test',['view']);
  check((await call(none,await browser(none,{ad:false}),{action:'job',serverId:dc01,plugin:'dns',operation:'dns-zone-read',parameters:{zone:'corp.example'}},plugins)).body.messageKey,'apiError.access.devicePermissionMissing','the zone read needs dns.read');
  await d.exec(sql`DELETE FROM jobs`);
  // The open-job guard reads the zone through jsonText, never through a left-to-right AND.
  const pluginsSource=readFileSync(new URL('../../lib/server/extensions/plugins.ts',import.meta.url),'utf8');
  check([pluginsSource.includes('IS JSON OBJECT AND'),pluginsSource.includes("same=sql`${jsonText(sql`parameters`,'parameters','zone')}=${zone}`")],[false,true],'plugins.ts: the zone-read guard uses jsonText');
  const libDir=fileURLToPath(new URL('../../lib/',import.meta.url));
  const libFiles=readdirSync(libDir,{recursive:true}).map(String).filter(file=>file.endsWith('.ts'));
  check(libFiles.filter(file=>readFileSync(join(libDir,file),'utf8').includes('IS JSON OBJECT AND')),[],'no file under lib/ relies on IS JSON OBJECT AND');
 }
 console.log(`PASS DNS manage (${checks} checks): one job with actAs and its audit row with the AD account, every refusal of the 14 gates in their order without a write, the stored records in the validation, no change through /api/plugins, and the zone read with its zone check and one open job per zone.`);
}finally{await d.close();}
