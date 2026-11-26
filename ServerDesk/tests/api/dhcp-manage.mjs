// DHCP changes on PostgreSQL (POST /api/dhcp, lib/server/extensions/dhcp-manage.ts,
// docs/dhcp-server.md "Change the DHCP server"): a change queues one plugin
// job with its audit row; every refusal of the gates writes nothing; a write
// operation through POST /api/plugins is refused; a change of a failover scope
// goes to the matched partner in one transaction, and every partner refusal
// writes nothing; an unmatched partner gives a local job; failover create
// queues the local job, the scope-apply parts and the partner job in order;
// replicate refuses more parts than the partner has room for; a partner of
// another customer meets the cross-customer gate; the shared secret is sealed
// per device and never stored in plain text. Every change needs the AD sign-in
// of the portal session for each target's directory (docs/plugin-ad-sign-in.md):
// without one the answer is PLUGIN_AD_SIGN_IN_REQUIRED and nothing is written;
// with one each job carries actAs and its audit row names the account. Real
// routes and libraries (access, rbac, mfa, v3) run against an isolated migrated database.
import {HttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';
import {sessionHeaders} from '../support/session-cookies.mjs';
import {sql} from '../../runtime/database.mjs';

const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const origin='https://dhcp.test',time=Date.now();
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex'),uuid=()=>crypto.randomUUID();
 let current=null;
 const identity=async()=>{if(!current)throw new HttpError(401,'Sign in.','IDENTITY_LOGIN_REQUIRED');return current;};
 const server={
  db:()=>d,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:'',now:()=>Date.now(),random:token,hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:request=>request.json(),sameOrigin:()=>{},
  requireViewer:identity,requireIdentity:identity,requireAuthIdentity:async()=>current,log:async()=>{},
  // Any HttpError (also the one of lib/errors/http-error.ts that queueFullError builds) answers with its status and key.
  failure:e=>{const known=e instanceof HttpError||e instanceof Error&&typeof e.status==='number'&&typeof e.code==='string';return Response.json({error:e instanceof Error?e.message:'failed',...(known?{code:e.code,messageKey:e.messageKey,params:e.params}:{})},{status:known?e.status:500});},
 };
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server};
 const load=sourceLoader();
 const api=load('app/api/dhcp/route.ts',imports),plugins=load('app/api/plugins/route.ts',imports),{demoDhcpSnapshot}=load('ui/shell/demo-dhcp.ts',imports);
 const {DHCP_CHANGE_OPERATIONS}=load('lib/plugin-catalog.ts',imports);

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
 // An extra role on one device only.
 async function grant(actor,permissions,deviceId){
  const roleId=uuid();
  await insert('rbac_roles',{id:roleId,name:'Device role '+roleId,description:'fixture',permissions:JSON.stringify(permissions),builtin:0,created_at:time});
  await insert('role_assignments',{id:uuid(),principal_type:'user',principal_id:actor.id,role_id:roleId,scope_type:'device',scope_id:deviceId,created_at:time,created_by:actor.principal});
 }
 // The AD sign-in of a browser for one directory: an active plugin_ad_sessions row.
 const corpSid='S-1-5-21-1000-2000-3000',otherSid='S-1-5-21-4000-5000-6000';
 const corp={kind:'domain',name:'corp.example',netbiosName:'CORP',sid:corpSid};
 async function adSession(actor,b,sid=corpSid,account='CORP\\anna'){
  const id=uuid(),at=Date.now();
  await insert('plugin_ad_sessions',{id,principal:actor.principal,session_hash:sha(b.session),state:'active',source:'password',directory_kind:'domain',directory_name:'corp.example',directory_sid:sid,user_sid:sid+'-1105',account,upn:null,created_at:at,verified_at:at,expires_at:at+8*3600_000});
  return id;
 }
 async function browser(actor,{ad=true}={}){
  const at=Date.now(),primary=token(),session=token();
  await insert('mfa_sessions',{token_hash:sha(session),principal:actor.principal,created_at:at,last_activity:at,idle_expires_at:at+900_000,expires_at:at+86_400_000});
  await insert('local_auth_sessions',{token_hash:sha(primary),user_id:actor.id,auth_version:1,created_at:at,expires_at:at+86_400_000,pending_until:at+600_000,mfa_hash:sha(session)});
  const b={primary,session};
  if(ad)b.adSession=await adSession(actor,b);
  return b;
 }
 const keyPair=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),jwk=keyPair.publicKey.export({format:'jwk'});
 const capabilities=['dhcp-read',...DHCP_CHANGE_OPERATIONS];
 const plugin=(version='1.1.0',caps=capabilities)=>({name:'dhcp',role:'dhcp',version,capabilities:caps,state:'ready',networkBlocked:true});
 async function device(name,{plugins=[plugin()],management=1,mode='Management',lastSeen=Date.now(),agent=['plugin-host','plugin-secrets','plugin-ad-identity'],customer,address,directory=corp}={}){
  const id=uuid();
  const snapshot={protocolVersion:3,agentVersion:'4.19.0',mode,agentCapabilities:agent,plugins,publicKey:{kty:'RSA',n:jwk.n,e:jwk.e},hostname:name,domain:'corp.example',networks:address?[{name:'Ethernet',addresses:[address],mac:'00-15-5D-00-00-01',speedMbps:1000}]:[],security:{directory}};
  await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:lastSeen,management,snapshot:JSON.stringify(snapshot),...(customer?{customer_id:customer}:{})});
  return id;
 }
 // The stored read of a device: the sample server under the name `serverName`, failover partner `partner`.
 async function dhcpData(id,serverName,{partner='SRV-DC02.corp.example',service='running'}={}){
  const data=demoDhcpSnapshot(time);data.server.name=serverName;data.service=service;data.ipv4.failover[0].partner=partner;
  await insert('device_plugin_data',{server_id:id,plugin:'dhcp',operation:'dhcp-read',data:JSON.stringify(data),summary:'[]',collected_at:time,received_at:time,service});
 }
 async function dhcpDevice(name,options){const id=await device(name,options);await dhcpData(id,name+'.corp.example');return id;}
 const call=async(actor,b,payload,route=api)=>{current=actor;const response=await route.POST(new Request(origin+'/api/dhcp',{method:'POST',headers:sessionHeaders(b,{'Content-Type':'application/json'}),body:JSON.stringify(payload)}));return {status:response.status,body:await response.json()};};
 const change=(serverId,operation,parameters,extra={})=>({action:'change',serverId,operation,parameters,confirm:true,...extra});
 const reservation=(scopeId='10.30.0.0',address='10.30.0.20')=>({family:'ipv4',scopeId,address,clientId:'00-15-5D-0A-0B-0C',name:'pc-lab',description:'',type:'dhcp'});
 const failoverReservation=()=>reservation('10.10.0.0','10.10.0.60');

 const owner=await account('owner@dhcp.test',['*']),manager=await account('manager@dhcp.test',['view','dhcp.read','dhcp.manage']),reader=await account('reader@dhcp.test',['view','dhcp.read']);
 const dc01=await device('SRV-DC01',{address:'10.10.1.4'}),dc02=await device('SRV-DC02',{address:'10.10.1.5'});
 await dhcpData(dc01,'SRV-DC01.corp.example');await dhcpData(dc02,'SRV-DC02.corp.example',{partner:'SRV-DC01.corp.example'});
 const mb=await browser(manager);

 // ---- One change: one job, one audit row, the operation as target -------------------------------------
 {
  const result=await call(manager,mb,change(dc01,'dhcp-reservation-add',reservation()));
  check(result.status,200,'a change with the right, MFA, Management mode and a confirmation');
  check(result.body.jobs.map(job=>job.serverId),[dc01],'one job on the device');
  const job=await d.one(sql`SELECT action,target,parameters,state FROM jobs WHERE id=${result.body.jobs[0].id}`);
  const actAs={sessionId:mb.adSession,userSid:corpSid+'-1105',logonName:'CORP\\anna',account:'CORP\\anna',kind:'domain'};
  check([job.action,job.target,job.state,JSON.parse(job.parameters)],['plugin-job','dhcp-reservation-add','pending',{plugin:'dhcp',operation:'dhcp-reservation-add',parameters:reservation(),actAs}],'the job: plugin-job, the operation as target, the parameters with actAs');
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE action='Add DHCP reservation' AND target='SRV-DC01 / 10.30.0.20 (AD: CORP\\anna)' AND server_id=${dc01}`),1,'the audit row with the English job label and the AD account');
  // The UPN is the logon name when the sign-in knew it.
  await d.exec(sql`UPDATE plugin_ad_sessions SET upn='anna@corp.example' WHERE id=${mb.adSession}`);
  const upn=await call(manager,mb,change(dc01,'dhcp-reservation-add',reservation('10.30.0.0','10.30.0.22')));
  check(JSON.parse((await d.one(sql`SELECT parameters FROM jobs WHERE id=${upn.body.jobs[0].id}`)).parameters).actAs.logonName,'anna@corp.example','the UPN as logon name');
  await d.exec(sql`UPDATE plugin_ad_sessions SET upn=NULL WHERE id=${mb.adSession}`);
  const normalized=await call(manager,mb,change(dc01,'dhcp-reservation-add',{...reservation('10.30.0.0','10.30.0.21'),clientId:'00155d0a0b0d'}));
  check(JSON.parse((await d.one(sql`SELECT parameters FROM jobs WHERE id=${normalized.body.jobs[0].id}`)).parameters).parameters.clientId,'00-15-5D-0A-0B-0D','the client ID is stored normalized');
  await d.exec(sql`DELETE FROM jobs`);await d.exec(sql`DELETE FROM audit`);
 }

 // ---- Each refusal writes nothing -----------------------------------------------------------------------
 {
  const refuse=async(label,actor,b,payload,key,params)=>{
   const before=[await jobs(),await audits()],result=await call(actor,b,payload);
   check([result.body.messageKey??result.body.code,...(params?[result.body.params]:[])],[key,...(params?[params]:[])],label);
   check([await jobs(),await audits()],before,label+': nothing written');
   return result;
  };
  await refuse('an unknown operation',manager,mb,change(dc01,'dhcp-write',{}),'apiError.plugin.operationUnknown');
  await refuse('scope-apply is no change of its own',manager,mb,change(dc01,'dhcp-scope-apply',{}),'apiError.plugin.operationUnknown');
  await refuse('without dhcp.manage',reader,await browser(reader),change(dc01,'dhcp-reservation-add',reservation()),'apiError.access.devicePermissionMissing');
  await refuse('offline',manager,mb,change(await device('SRV-OFF',{lastSeen:Date.now()-10*60_000}),'dhcp-reservation-add',reservation()),'apiError.agent.notConnected',{name:'SRV-OFF'});
  await refuse('no plugin host',manager,mb,change(await device('SRV-NOHOST',{agent:[]}),'dhcp-reservation-add',reservation()),'apiError.agent.v3FunctionRequired',{name:'SRV-NOHOST'});
  await refuse('plugin 1.0.0 without the operation',manager,mb,change(await device('SRV-OLD',{plugins:[plugin('1.0.0',['dhcp-read'])]}),'dhcp-reservation-add',reservation()),'apiError.dhcp.pluginTooOld',{name:'SRV-OLD'});
  await refuse('without an MFA session',manager,null,change(dc01,'dhcp-reservation-add',reservation()),'apiError.mfa.loginRequired');
  // The AD sign-in: after Management mode, before the confirmation; nothing is written without it.
  const noAd=await refuse('without an AD sign-in for the directory',manager,await browser(manager,{ad:false}),change(dc01,'dhcp-reservation-add',reservation()),'apiError.pluginAd.signInRequired',{domain:'corp.example',serverId:dc01});
  check([noAd.status,noAd.body.code],[403,'PLUGIN_AD_SIGN_IN_REQUIRED'],'403 PLUGIN_AD_SIGN_IN_REQUIRED');
  await refuse('without an AD sign-in and without confirmation: the sign-in first',manager,await browser(manager,{ad:false}),{...change(dc01,'dhcp-reservation-add',reservation()),confirm:false},'apiError.pluginAd.signInRequired',{domain:'corp.example',serverId:dc01});
  await refuse('an agent without plugin-ad-identity',manager,mb,change(await dhcpDevice('SRV-417',{agent:['plugin-host','plugin-secrets']}),'dhcp-reservation-add',reservation()),'apiError.pluginAd.agentTooOld',{name:'SRV-417'});
  const twin=await dhcpDevice('SRV-TWIN',{directory:{...corp,sid:otherSid}});
  await refuse('a session of another directory with the same name does not match',manager,mb,change(twin,'dhcp-reservation-add',reservation()),'apiError.pluginAd.signInRequired',{domain:'corp.example',serverId:twin});
  const ended=await browser(manager);await d.exec(sql`UPDATE plugin_ad_sessions SET expires_at=${Date.now()-1} WHERE id=${ended.adSession}`);
  await refuse('an expired AD sign-in',manager,ended,change(dc01,'dhcp-reservation-add',reservation()),'apiError.pluginAd.signInRequired',{domain:'corp.example',serverId:dc01});
  const workgroup=await dhcpDevice('WG1',{directory:{kind:'local',name:'WG1',netbiosName:'WG1',sid:otherSid}});
  await refuse('a workgroup server names itself',manager,mb,change(workgroup,'dhcp-reservation-add',reservation()),'apiError.pluginAd.signInRequired',{domain:'WG1',serverId:workgroup});
  await refuse('ReadOnly (management off)',manager,mb,change(await device('SRV-RO',{management:0}),'dhcp-reservation-add',reservation()),'apiError.agent.readOnlyEnableManagement');
  await refuse('ReadOnly (agent mode)',manager,mb,change(await device('SRV-RO2',{mode:'ReadOnly'}),'dhcp-reservation-add',reservation()),'apiError.agent.readOnlyEnableManagement');
  await refuse('without confirmation',manager,mb,{...change(dc01,'dhcp-reservation-add',reservation()),confirm:false},'apiError.console.confirmServerChange');
  await refuse('no stored read',manager,mb,change(await device('SRV-NODATA'),'dhcp-reservation-add',reservation()),'apiError.dhcp.noData',{name:'SRV-NODATA'});
  const stopped=await device('SRV-STOP');await dhcpData(stopped,'SRV-STOP.corp.example',{service:'stopped'});
  await refuse('a stopped service',manager,mb,change(stopped,'dhcp-reservation-add',reservation()),'apiError.dhcp.serviceStopped',{name:'SRV-STOP'});
  const invalid=await refuse('values that do not fit',manager,mb,change(dc01,'dhcp-reservation-add',{...reservation(),address:'10.30.0.250',clientId:'zz'}),'apiError.dhcp.changeInvalid',{fields:'clientId, address'});
  check([invalid.status,invalid.body.errors],[400,[{field:'clientId',code:'clientId'},{field:'address',code:'outside',params:{start:'10.30.0.10',end:'10.30.0.59'}}]],'changeInvalid: 400 with the field errors');
  const full=await device('SRV-FULL');await dhcpData(full,'SRV-FULL.corp.example');
  for(let n=0;n<20;n++)await insert('jobs',{id:uuid(),server_id:full,action:'refresh',target:'',parameters:'{}',state:'pending',created_at:time,actor:owner.id,actor_email:owner.label,actor_principal:owner.principal});
  const before=await jobs(),result=await call(manager,mb,change(full,'dhcp-reservation-add',reservation()));
  check([result.status,result.body.messageKey,await jobs()],[429,'apiError.console.queueFull',before],'a full queue: 429 and nothing written');
  await d.exec(sql`DELETE FROM jobs`);
  // POST /api/plugins with action job accepts only reads.
  const viaPlugins=await call(manager,mb,{action:'job',serverId:dc01,plugin:'dhcp',operation:'dhcp-scope-delete'},plugins);
  check([viaPlugins.body.messageKey,await jobs()],['apiError.plugin.operationUnknown',0],'a change through /api/plugins is refused');
  // A read needs no AD sign-in and carries no actAs: it runs as SYSTEM.
  const read=await call(manager,await browser(manager,{ad:false}),{action:'job',serverId:dc01,plugin:'dhcp',operation:'dhcp-read'},plugins);
  check(JSON.parse((await d.one(sql`SELECT parameters FROM jobs WHERE id=${read.body.id}`)).parameters),{plugin:'dhcp',operation:'dhcp-read'},'dhcp-read has no actAs');
  await d.exec(sql`DELETE FROM jobs`);
 }

 // ---- Mirroring to the failover partner ----------------------------------------------------------------
 {
  let result=await call(manager,mb,change(dc01,'dhcp-reservation-add',failoverReservation()));
  check(result.body.jobs.map(job=>job.serverId),[dc01,dc02],'a change of a failover scope: the device and the partner');
  const rows=await d.query(sql`SELECT server_id,target,parameters FROM jobs ORDER BY created_at`);
  check(rows.map(row=>[row.server_id,row.target,JSON.parse(row.parameters).parameters]),[[dc01,'dhcp-reservation-add',failoverReservation()],[dc02,'dhcp-reservation-add',failoverReservation()]],'the same operation and parameters on both');
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE action='Add DHCP reservation' AND target='SRV-DC02 / 10.10.0.60 (AD: CORP\\anna)' AND server_id=${dc02}`),1,'one audit row per job');
  await d.exec(sql`DELETE FROM jobs`);
  // Partner refusals: each writes nothing on either device.
  const partnerCase=async(label,setup,key,teardown)=>{
   await setup();const before=[await jobs(),await audits()];
   result=await call(manager,mb,change(dc01,'dhcp-reservation-add',failoverReservation()));
   check([result.body.messageKey,result.body.params,await jobs(),await audits()],[key,{name:'SRV-DC02'},...before],`partner ${label}: refused before any write`);
   await teardown();
  };
  const partnerCase2=async(label,setup,key,params,teardown)=>{
   await setup();const before=[await jobs(),await audits()];
   result=await call(manager,mb,change(dc01,'dhcp-reservation-add',failoverReservation()));
   check([result.body.messageKey,result.body.params,await jobs(),await audits()],[key,params,...before],`partner ${label}: refused before any write`);
   await teardown();
  };
  const snapshotOf=async id=>JSON.parse((await d.one(sql`SELECT snapshot FROM servers WHERE id=${id}`)).snapshot);
  const original=await snapshotOf(dc02);
  const setSnapshot=value=>d.exec(sql`UPDATE servers SET snapshot=${JSON.stringify(value)} WHERE id=${dc02}`);
  await partnerCase('offline',()=>d.exec(sql`UPDATE servers SET last_seen=${Date.now()-10*60_000} WHERE id=${dc02}`),'apiError.dhcp.partnerOffline',()=>d.exec(sql`UPDATE servers SET last_seen=${Date.now()} WHERE id=${dc02}`));
  await partnerCase('with plugin 1.0.0',()=>setSnapshot({...original,plugins:[plugin('1.0.0',['dhcp-read'])]}),'apiError.dhcp.partnerPlugin',()=>setSnapshot(original));
  await partnerCase('in ReadOnly',()=>d.exec(sql`UPDATE servers SET management=0 WHERE id=${dc02}`),'apiError.dhcp.partnerReadOnly',()=>d.exec(sql`UPDATE servers SET management=1 WHERE id=${dc02}`));
  await d.exec(sql`DELETE FROM jobs`);await d.exec(sql`DELETE FROM audit`);
  // A partner in another directory needs its own sign-in: the answer names the partner.
  const branchDirectory={kind:'domain',name:'branch.example',netbiosName:'BRANCH',sid:otherSid};
  await partnerCase2('in another directory without a sign-in',()=>setSnapshot({...original,security:{directory:branchDirectory}}),'apiError.pluginAd.signInRequired',{domain:'branch.example',serverId:dc02},()=>setSnapshot(original));
  await partnerCase('on an agent without plugin-ad-identity',()=>setSnapshot({...original,agentCapabilities:['plugin-host','plugin-secrets']}),'apiError.pluginAd.agentTooOld',()=>setSnapshot(original));
  {
   await setSnapshot({...original,security:{directory:branchDirectory}});
   const branch=await adSession(manager,mb,otherSid,'BRANCH\\anna');
   result=await call(manager,mb,change(dc01,'dhcp-reservation-add',failoverReservation()));
   const rows=await d.query(sql`SELECT server_id,parameters FROM jobs ORDER BY created_at,id`);
   check(rows.map(row=>[row.server_id,JSON.parse(row.parameters).actAs.sessionId,JSON.parse(row.parameters).actAs.account]),[[dc01,mb.adSession,'CORP\\anna'],[dc02,branch,'BRANCH\\anna']],'each job carries the sign-in of its own directory');
   check(await count(sql`SELECT count(*) AS n FROM audit WHERE target='SRV-DC02 / 10.10.0.60 (AD: BRANCH\\anna)'`),1,'the partner audit row names its account');
   await d.exec(sql`DELETE FROM jobs`);await d.exec(sql`DELETE FROM audit`);await d.exec(sql`DELETE FROM plugin_ad_sessions WHERE id=${branch}`);await setSnapshot(original);
  }
  await partnerCase('with a stopped service',()=>d.exec(sql`UPDATE device_plugin_data SET service='stopped' WHERE server_id=${dc02}`),'apiError.dhcp.partnerServiceStopped',()=>d.exec(sql`UPDATE device_plugin_data SET service='running' WHERE server_id=${dc02}`));
  // The right on the partner: an actor with dhcp.manage only on SRV-DC01.
  const local=await account('local@dhcp.test',['view','dhcp.read']);await grant(local,['dhcp.manage'],dc01);
  const lb=await browser(local),before=await jobs();
  result=await call(local,lb,change(dc01,'dhcp-reservation-add',failoverReservation()));
  check([result.body.messageKey,result.body.params,await jobs()],['apiError.dhcp.partnerRight',{name:'SRV-DC02'},before],'partner without dhcp.manage: refused before any write');
  // An unmatched partner: the change stays local.
  await d.exec(sql`UPDATE device_plugin_data SET data=${JSON.stringify({...demoDhcpSnapshot(time),server:{name:'SRV-OTHER.corp.example',authorization:'authorized',domain:'corp.example'}})} WHERE server_id=${dc02}`);
  await d.exec(sql`UPDATE servers SET name='SRV-ELSEWHERE' WHERE id=${dc02}`);
  result=await call(manager,mb,change(dc01,'dhcp-reservation-add',failoverReservation()));
  check(result.body.jobs.map(job=>job.serverId),[dc01],'no matched partner: only the local job');
  await d.exec(sql`DELETE FROM jobs`);
  // A lease delete of a failover scope is never mirrored.
  await d.exec(sql`UPDATE servers SET name='SRV-DC02' WHERE id=${dc02}`);await dhcpDataReset(dc02);
  result=await call(manager,mb,change(dc01,'dhcp-lease-delete',{family:'ipv4',scopeId:'10.10.0.0',addresses:['10.10.0.101']}));
  check(result.body.jobs.map(job=>job.serverId),[dc01],'a lease delete stays local');
  await d.exec(sql`DELETE FROM jobs`);
 }
 async function dhcpDataReset(id){await d.exec(sql`DELETE FROM device_plugin_data WHERE server_id=${id}`);await dhcpData(id,'SRV-DC02.corp.example',{partner:'SRV-DC01.corp.example'});}

 // ---- Failover create, remove and replicate ----------------------------------------------------------------
 {
  const create={name:'DC01-DC03',partner:'SRV-DC03',serverType:'primary',mode:'loadBalance',loadBalancePercent:60,serverRole:'active',reservePercent:5,mcltSeconds:3600,autoStateTransition:false,stateSwitchIntervalSeconds:null,messageAuthentication:false,scopeIds:['10.30.0.0']};
  let result=await call(manager,mb,change(dc01,'dhcp-failover-create',create));
  check([result.body.messageKey,result.body.params,await jobs()],['apiError.dhcp.partnerMissing',{partner:'SRV-DC03'},0],'failover create without a partner device: refused');
  const dc03=await device('SRV-DC03',{address:'10.10.1.6'});await dhcpData(dc03,'SRV-DC03.corp.example',{partner:'nobody'});
  result=await call(manager,mb,change(dc01,'dhcp-failover-create',create));
  const rows=await d.query(sql`SELECT server_id,target,parameters,created_at FROM jobs ORDER BY created_at,id`);
  check(rows.map(row=>[row.server_id,row.target]),[[dc01,'dhcp-failover-create'],[dc03,'dhcp-scope-apply'],[dc03,'dhcp-failover-create']],'local create, the apply part, then the partner create');
  check(new Set(rows.map(row=>Number(row.created_at))).size,3,'the jobs keep their order through created_at');
  const local=JSON.parse(rows[0].parameters).parameters,partner=JSON.parse(rows[2].parameters).parameters,apply=JSON.parse(rows[1].parameters).parameters;
  check([local.serverType,local.partner,local.serverAddress,local.partnerAddress,local.loadBalancePercent],['primary','SRV-DC03.corp.example','10.10.1.4','10.10.1.6',60],'the local side: primary, the partner by its DHCP name, both endpoints');
  check([partner.serverType,partner.partner,partner.serverAddress,partner.partnerAddress,partner.loadBalancePercent],['secondary','SRV-DC01.corp.example','10.10.1.6','10.10.1.4',40],'the partner side: secondary, 100−p, the local server as partner');
  check([apply.scopeId,apply.part,apply.parts,apply.settings.name,apply.keep],['10.30.0.0',1,1,'Lab',[]],'the apply part carries the scope settings and keep');
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE action IN ('Create DHCP failover','Apply replicated DHCP scope')`),3,'one audit row per job');
  await d.exec(sql`DELETE FROM jobs`);
  // Remove: paired, the partner deletes the scopes.
  result=await call(manager,mb,change(dc01,'dhcp-failover-remove',{name:'DC01-DC02',deletePartnerScopes:true}));
  const removal=await d.query(sql`SELECT server_id,parameters FROM jobs ORDER BY created_at,id`);
  check(removal.map(row=>[row.server_id,JSON.parse(row.parameters).parameters]),[[dc01,{name:'DC01-DC02',deletePartnerScopes:false}],[dc02,{name:'DC01-DC02',deletePartnerScopes:true}]],'failover remove: the scopes stay locally and go on the partner');
  await d.exec(sql`DELETE FROM jobs`);
  // Replicate: two scopes, one free slot on the partner.
  for(let n=0;n<19;n++)await insert('jobs',{id:uuid(),server_id:dc02,action:'refresh',target:'',parameters:'{}',state:'pending',created_at:time,actor:owner.id,actor_email:owner.label,actor_principal:owner.principal});
  result=await call(manager,mb,{action:'replicate',serverId:dc01,relationship:'DC01-DC02',confirm:true});
  check([result.body.messageKey,result.body.params,await jobs()],['apiError.dhcp.replicateTooLarge',{name:'SRV-DC02',free:1},19],'replicate with more parts than free slots: refused');
  result=await call(manager,mb,{action:'replicate',serverId:dc01,relationship:'DC01-DC02',scopeId:'10.20.0.0',confirm:true});
  check([result.status,result.body.jobs.map(job=>job.serverId)],[200,[dc02]],'replicate of one scope fits');
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE action='Replicate DHCP failover' AND server_id=${dc02}`),1,'the replicate audit action');
  await d.exec(sql`DELETE FROM jobs`);
  // A read with cut reservations: the partner would lose reservations, so every scope copy is refused before any write.
  const full=await d.one(sql`SELECT data FROM device_plugin_data WHERE server_id=${dc01}`),cut=JSON.parse(full.data);cut.truncated.reservations=true;
  await d.exec(sql`UPDATE device_plugin_data SET data=${JSON.stringify(cut)} WHERE server_id=${dc01}`);
  const truncated=async(label,payload)=>{const before=[await jobs(),await audits()],answer=await call(manager,mb,payload);check([answer.body.messageKey,answer.body.params,await jobs(),await audits()],['apiError.dhcp.reservationsTruncated',{name:'SRV-DC01'},...before],`${label} from a truncated read: refused, nothing written`);};
  await truncated('replicate',{action:'replicate',serverId:dc01,relationship:'DC01-DC02',confirm:true});
  await truncated('failover create',change(dc01,'dhcp-failover-create',create));
  await truncated('adding a scope to a relationship',change(dc01,'dhcp-failover-edit',{name:'DC01-DC02',addScopeIds:['10.30.0.0']}));
  result=await call(manager,mb,change(dc01,'dhcp-failover-edit',{name:'DC01-DC02',mcltSeconds:7200}));
  check([result.status,result.body.jobs.length],[200,2],'an edit without new scopes still works');
  await d.exec(sql`DELETE FROM jobs`);await d.exec(sql`UPDATE device_plugin_data SET data=${full.data} WHERE server_id=${dc01}`);
  // The defaults of a failover create: an API client may leave them out.
  result=await call(manager,mb,change(dc01,'dhcp-failover-create',{name:'DC01-DC04',partner:'SRV-DC03',mode:'loadBalance',scopeIds:['10.30.0.0']}));
  const defaults=JSON.parse((await d.one(sql`SELECT parameters FROM jobs WHERE id=${result.body.jobs[0].id}`)).parameters).parameters;
  check([defaults.serverType,defaults.loadBalancePercent,defaults.serverRole,defaults.reservePercent,defaults.mcltSeconds,defaults.autoStateTransition,defaults.stateSwitchIntervalSeconds,defaults.messageAuthentication],['primary',50,'active',5,3600,false,3600,false],'failover create fills the spec defaults');
  await d.exec(sql`DELETE FROM jobs`);
 }

 // ---- The shared secret -------------------------------------------------------------------------------------
 {
  const secret='Correct-Horse-Battery-9';
  const edit={name:'DC01-DC02',messageAuthentication:true};
  // The sample relationship already authenticates: a new secret is optional, but it is sealed per device.
  let result=await call(manager,mb,change(dc01,'dhcp-failover-edit',edit,{secret}));
  check(result.status,200,'an edit with a new secret');
  const rows=await d.query(sql`SELECT server_id,parameters FROM jobs ORDER BY created_at,id`);
  const sealed=rows.map(row=>JSON.parse(row.parameters));
  check(sealed.map(job=>[Object.keys(job.secretParameters).sort(),'secret' in job.parameters]),[[['data','iv','key','mac'],false],[['data','iv','key','mac'],false]],'a sealed box per device, nothing in parameters');
  assert.notEqual(sealed[0].secretParameters.data,sealed[1].secretParameters.data);checks++;
  const opened=sealed.map(job=>{const material=crypto.privateDecrypt({key:keyPair.privateKey,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha1'},Buffer.from(job.secretParameters.key,'base64'));const decipher=crypto.createDecipheriv('aes-256-cbc',material.subarray(0,32),Buffer.from(job.secretParameters.iv,'base64'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(job.secretParameters.data,'base64')),decipher.final()]).toString());});
  check(opened,[{secret},{secret}],'each box opens with the device key');
  check(await count(sql`SELECT count(*) AS n FROM jobs WHERE parameters LIKE ${'%'+secret+'%'}`)+await count(sql`SELECT count(*) AS n FROM audit WHERE target LIKE ${'%'+secret+'%'} OR action LIKE ${'%'+secret+'%'}`),0,'no plain secret in jobs or audit');
  await d.exec(sql`DELETE FROM jobs`);
  check((await call(manager,mb,change(dc01,'dhcp-failover-edit',edit,{secret:'short'}))).body.errors,[{field:'secret',code:'secret'}],'a secret below 8 characters');
  check((await call(manager,mb,change(dc01,'dhcp-reservation-add',reservation(),{secret}))).body.errors,[{field:'secret',code:'invalid'}],'a secret without authentication');
  // A partner agent without plugin-secrets blocks a new secret.
  await d.exec(sql`UPDATE servers SET snapshot=jsonb_set(snapshot::jsonb,'{agentCapabilities}','["plugin-host","plugin-ad-identity"]')::text WHERE id=${dc02}`);
  result=await call(manager,mb,change(dc01,'dhcp-failover-edit',edit,{secret}));
  check([result.body.messageKey,result.body.params,await jobs()],['apiError.dhcp.secretAgent',{name:'SRV-DC02'},0],'a partner agent without plugin-secrets: secretAgent, nothing written');
  result=await call(manager,mb,change(dc01,'dhcp-failover-edit',{name:'DC01-DC02',messageAuthentication:false}));
  check([result.status,result.body.jobs.length],[200,2],'turning authentication off needs no secret');
  await d.exec(sql`DELETE FROM jobs`);
 }

 // ---- A partner of another customer ---------------------------------------------------------------------------
 {
  const other=uuid();await insert('customers',{id:other,name:'Other customer',created_at:time,updated_at:time});
  await d.exec(sql`UPDATE servers SET customer_id=${other} WHERE id=${dc02}`);
  const entries=()=>d.one(sql`SELECT count(*) AS n FROM audit WHERE server_id IS NULL AND customer_id IS NOT NULL`).then(row=>Number(row.n));
  const ob=await browser(owner),entriesBefore=await entries(),result=await call(owner,ob,change(dc01,'dhcp-reservation-add',failoverReservation()));
  check([result.status,await jobs(),await entries()-entriesBefore],[200,2,2],'a partner of another customer goes through the cross-customer gate: the Owner holds the right, one customer entry per customer');
 }
 console.log(`PASS DHCP manage (${checks} checks): one job with actAs and its audit row with the AD account, the AD sign-in gates (none, another directory, expired, agent too old, workgroup, partner), every refusal without a write, no change through /api/plugins, mirroring to the partner with every partner refusal, the local-only fallback, failover create, remove and replicate, the sealed secret and the cross-customer gate.`);
}finally{await d.close();}
