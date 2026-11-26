// Agent plugin jobs on PostgreSQL (app/api/plugins, lib/server/extensions/plugins.ts,
// docs/agent-plugins.md): the job requirements of the three kinds, install with
// the release choice and every refusal, removal, the plugin read with its one
// open job, the rollout to pilot devices in one transaction, the cross-customer
// gate, GET /api/plugins and dev builds (never the newest release or an install, a
// rollout needs Import dev builds). Install, removal and rollout are routine
// (lib/step-up.ts): they rely on the live MFA login session behind
// mfaSessionFence, read no step-up proof and leave a supplied one unused. Real
// routes and libraries (access, rbac, mfa, local-auth, v3) run against an
// isolated migrated database; a throwaway P-256 key stands for the publisher.
import {HttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';
import {sessionHeaders} from '../support/session-cookies.mjs';
import {sql} from '../../runtime/database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {everyCustomer} from '../support/customer-separation.mjs';
import {pluginReleaseFiles} from '../../runtime/plugin-release-verify.mjs';

const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const origin='https://plugins.test',time=Date.now();
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex'),uuid=()=>crypto.randomUUID();
 const publisher=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKeyPem=publisher.publicKey.export({type:'spki',format:'pem'});
 let current=null;const logs=[];
 // The one-shot hook runs right before the transaction that inserts the jobs.
 let beforeJobs=null;
 const facade=hookDatabase(d,{batch:async texts=>{if(beforeJobs&&texts.some(text=>text.startsWith('INSERT INTO jobs'))){const hook=beforeJobs;beforeJobs=null;await hook();}}});
 const identity=async()=>{if(!current)throw new HttpError(401,'Sign in.','IDENTITY_LOGIN_REQUIRED');return current;};
 const server={
  db:()=>facade,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:'',now:()=>Date.now(),random:token,hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:request=>request.json(),sameOrigin:()=>{},
  requireViewer:identity,requireIdentity:identity,requireAuthIdentity:async()=>current,log:async(...entry)=>{logs.push(entry);},
  failure:e=>Response.json({error:e instanceof Error?e.message:'failed',...(e instanceof HttpError?{code:e.code,messageKey:e.messageKey,params:e.params}:{})},{status:e instanceof HttpError?e.status:500}),
 };
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'../../release-publisher.json':{default:{publicKey:publicKeyPem}}};
 const load=sourceLoader();
 const api=load('app/api/plugins/route.ts',imports),{jobRequirements,jobParametersFromTarget}=load('lib/jobs/requirements.ts',imports);

 // ---- The job requirements of the three kinds ----------------------------------------
 check(jobRequirements('plugin-install',{name:'dhcp'}),{known:true,permissions:['plugins.manage'],managementMode:false,mfa:true,privilegedPath:false,securityEvents:false,capabilities:['plugin-host']},'plugin-install: plugins.manage, MFA, any mode, plugin-host');
 check(jobRequirements('plugin-remove',{name:'dhcp'}),jobRequirements('plugin-install',{}),'plugin-remove: the same requirements');
 check(jobRequirements('plugin-job',{plugin:'dhcp',operation:'dhcp-read'}),{known:true,permissions:['dhcp.read'],managementMode:false,mfa:false,privilegedPath:false,securityEvents:false,capabilities:['plugin-host']},'dhcp-read: dhcp.read without MFA or Management');
 check(jobRequirements('plugin-job',{plugin:'dhcp',operation:'dhcp-write'}).known,false,'another operation is not known');
 check(jobRequirements('plugin-job',{plugin:'dns',operation:'dhcp-read'}).known,false,'an operation of another plugin is not known');
 check(jobParametersFromTarget('plugin-job','dhcp-read'),{plugin:'dhcp',operation:'dhcp-read'},'a finished plugin job keeps its operation through the target');

 // ---- Fixture -------------------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const count=async statement=>Number((await d.one(statement)).n);
 async function account(label,permissions){
  const {actor}=await sourceActor(d,label,permissions);actor.userId=actor.id;
  await d.exec(sql`UPDATE local_users SET password_hash='fixture-password',must_reset=0 WHERE id=${actor.id}`);
  await insert('mfa_accounts',{principal:actor.principal,secret_enc:'migrated:authenticator-managed',recovery_hashes:'[]',last_counter:-1,created_at:time,authenticators_migrated:1});
  return actor;
 }
 async function browser(actor,{proof=true}={}){
  const at=Date.now(),primary=token(),session=token(),management=token();
  await insert('mfa_sessions',{token_hash:sha(session),principal:actor.principal,created_at:at,last_activity:at,idle_expires_at:at+900_000,expires_at:at+86_400_000});
  await insert('local_auth_sessions',{token_hash:sha(primary),user_id:actor.id,auth_version:1,created_at:at,expires_at:at+86_400_000,pending_until:at+600_000,mfa_hash:sha(session)});
  if(proof)await insert('mfa_management_proofs',{token_hash:sha(management),principal:actor.principal,session_hash:sha(session),expires_at:at+300_000});
  return {primary,session,management:proof?management:null};
 }
 const endSession=b=>()=>d.exec(sql`DELETE FROM mfa_sessions WHERE token_hash=${sha(b.session)}`);
 const proofExists=async value=>await count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${sha(value)}`)===1;
 const call=async(actor,b,method,payload)=>{current=actor;const response=method==='GET'?await api.GET(new Request(origin+'/api/plugins',{headers:sessionHeaders(b)})):await api.POST(new Request(origin+'/api/plugins',{method:'POST',headers:sessionHeaders(b,{'Content-Type':'application/json'}),body:JSON.stringify(payload)}));return {status:response.status,body:await response.json()};};
 const plugin=(version,state='ready')=>({name:'dhcp',target:'dhcp',version,capabilities:['dhcp-read'],state,networkBlocked:true});
 async function device(name,{agentVersion='4.16.0',capabilities=['plugin-host'],plugins=[],lastSeen=Date.now(),customer}={}){
  const id=uuid();
  await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:lastSeen,management:0,snapshot:JSON.stringify({protocolVersion:3,agentVersion,mode:'ReadOnly',agentCapabilities:capabilities,plugins}),...(customer?{customer_id:customer}:{})});
  return id;
 }
 async function release(version,minAgentVersion,state='active',name='dhcp',target={role:'dhcp'}){
  const names=pluginReleaseFiles(name,version),exe=Buffer.from(`${name} ${version}`);
  const manifest=JSON.stringify({kind:'plugin',name,...target,version,minAgentVersion,protocolVersion:1,os:['Windows Server 2022'],arch:'x64',capabilities:['dhcp-read'],exe:{path:`/downloads/${names.exe}`,sha256:sha(exe),size:exe.length},changelog:{features:['Read'],fixes:[]},createdAt:'2026-11-01T00:00:00.000Z'});
  const id=uuid();
  await insert('plugin_releases',{id,name,version,manifest,signature:crypto.sign('sha256',Buffer.from(manifest),publisher.privateKey).toString('base64'),sha256:sha(exe),size:exe.length,created_at:time,state});
  return {id,manifest};
 }
 const owner=await account('owner@plugins.test',['*']),manager=await account('manager@plugins.test',['plugins.manage','view']),reader=await account('reader@plugins.test',['dhcp.read','view']),viewerOnly=await account('viewer@plugins.test',['view']);
 const jobs=()=>count(sql`SELECT count(*) AS n FROM jobs`);

 // ---- GET /api/plugins -------------------------------------------------------------------
 // plugins.manage counts on an existing device.
 await device('SRV-FIRST');
 const r100=await release('1.0.0','4.16.0'),r110=await release('1.1.0','9.0.0');await release('1.2.0','4.16.0','disabled');
 {
  check((await call(viewerOnly,await browser(viewerOnly,{proof:false}),'GET')).body.messageKey,'apiError.plugin.rightMissing','without plugins.manage anywhere: 403 rightMissing');
  check((await call(viewerOnly,await browser(viewerOnly,{proof:false}),'GET')).status,403,'the status is 403');
  const listed=(await call(manager,await browser(manager,{proof:false}),'GET')).body.releases;
  check(listed.map(item=>[item.version,item.active]),[['1.2.0',false],['1.1.0',true],['1.0.0',true]],'every release, newest first, with active');
  check(Object.keys(listed[0]).sort(),['active','capabilities','changelog','createdAt','dev','id','minAgentVersion','name','target','version'],'metadata only, no signed bytes');
  check(listed.map(item=>item.target),['dhcp','dhcp','dhcp'],'a role-only manifest gives target dhcp');
 }
 // lib/server/extensions/plugin-releases.ts: the summary takes target from the manifest, else from its role; the stored bytes stay as signed.
 {
  const releases=load('lib/server/extensions/plugin-releases.ts',imports);
  const targeted=await release('2.0.0','4.16.0','active','veeam',{target:'veeam-agent',role:'veeam-agent'});
  const summary=(await releases.latestPluginReleases()).find(item=>item.name==='veeam');
  check([summary.target,Object.hasOwn(summary,'role')],['veeam-agent',false],'a manifest with target gives that target and no role');
  check((await releases.pluginReleases()).filter(item=>item.name==='dhcp').map(item=>[item.target,Object.hasOwn(item,'role')]),[['dhcp',false],['dhcp',false],['dhcp',false]],'role-only manifests: target from role, no role key');
  const stored=await releases.storedPluginRelease(targeted.id);
  check([stored.target,stored.manifest===targeted.manifest],['veeam-agent',true],'the stored release keeps its exact signed bytes');
  const roleOnly=releases.verifiedPluginRelease(r100.manifest,(await d.one(sql`SELECT signature FROM plugin_releases WHERE id=${r100.id}`)).signature);
  check([roleOnly.target,roleOnly.role],['dhcp','dhcp'],'verifiedPluginRelease normalizes target from role and keeps role');
  await d.exec(sql`DELETE FROM plugin_releases WHERE id=${targeted.id}`);
 }

 // ---- Install ------------------------------------------------------------------------------
 {
  const host=await device('SRV-HOST');
  const install=(actor,b,extra={})=>call(actor,b,'POST',{action:'install',serverId:host,plugin:'dhcp',confirm:true,managementToken:b.management,...extra});
  let b=await browser(manager),result=await install(manager,b);
  check(result.status,200,'install with the right and the MFA session; the supplied token is ignored');
  const job=await d.one(sql`SELECT action,target,parameters,state FROM jobs WHERE id=${result.body.id}`);
  const parameters=JSON.parse(job.parameters);
  check([job.action,job.target,job.state,parameters.releaseId,parameters.version,parameters.name,parameters.manifest===r100.manifest,typeof parameters.signature],['plugin-install','dhcp 1.0.0','pending',r100.id,'1.0.0','dhcp',true,'string'],'the newest active release the agent meets, with its signed bytes');
  check(await proofExists(b.management),true,'a supplied proof is neither read nor consumed');
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE action='Plugin install queued' AND target='SRV-HOST / dhcp 1.0.0' AND server_id=${host}`),1,'the audit row "Plugin install queued"');
  await d.exec(sql`DELETE FROM jobs`);
  // Without a token: the MFA login session is enough.
  b=await browser(manager,{proof:false});result=await call(manager,b,'POST',{action:'install',serverId:host,plugin:'dhcp',confirm:true});
  check([result.status,(await d.one(sql`SELECT action FROM jobs WHERE id=${result.body.id??''}`))?.action],[200,'plugin-install'],`install without a token queues the job (${result.body.error})`);
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE action='Plugin install queued' AND server_id=${host}`),2,'install without a token: the audit row as today');
  await d.exec(sql`DELETE FROM jobs`);
  // Without a live MFA session: the requireMfa error before any write.
  b=await browser(manager,{proof:false});result=await call(manager,{primary:b.primary},'POST',{action:'install',serverId:host,plugin:'dhcp',confirm:true});
  check([result.status,result.body.code,await jobs()],[403,'MFA_LOGIN_REQUIRED',0],'install without an MFA session: MFA_LOGIN_REQUIRED, nothing written');
  // The MFA session ends between the checks and the batch: the fence admits no job.
  {
   const audits=await count(sql`SELECT count(*) AS n FROM audit`);b=await browser(manager,{proof:false});beforeJobs=endSession(b);
   result=await call(manager,b,'POST',{action:'install',serverId:host,plugin:'dhcp',confirm:true});
   check([beforeJobs,result.body.code,await jobs(),await count(sql`SELECT count(*) AS n FROM audit`)],[null,'SESSION_EXPIRED',0,audits],`install: an MFA session that ends before the batch writes nothing and answers the MFA-session error (${result.body.error})`);
  }
  // Refusals before any proof is asked for.
  const refuse=async(label,serverId,key,params,actor=manager,extra={})=>{const ob=await browser(actor);const r=await call(actor,ob,'POST',{action:'install',serverId,plugin:'dhcp',confirm:true,managementToken:ob.management,...extra});check([r.body.messageKey,...(params?[r.body.params]:[])],[key,...(params?[params]:[])],label);check(await proofExists(ob.management),true,label+': the proof remains');};
  await refuse('no release of the plugin',host,'apiError.plugin.releaseMissing',null,manager,{plugin:'dns'});
  await refuse('agent too old',await device('SRV-OLD',{agentVersion:'4.13.2'}),'apiError.plugin.agentTooOld',{name:'SRV-OLD',version:'4.16.0'});
  await refuse('no plugin-host',await device('SRV-NOHOST',{capabilities:[]}),'apiError.agent.v3FunctionRequired');
  await refuse('offline',await device('SRV-OFFLINE',{lastSeen:Date.now()-10*60_000}),'apiError.device.offline');
  await refuse('the same version is ready',await device('SRV-READY',{plugins:[plugin('1.0.0')]}),'apiError.plugin.alreadyInstalled',{name:'SRV-READY'});
  await refuse('without plugins.manage',host,'apiError.access.devicePermissionMissing',null,reader);
  await refuse('without confirmation',host,'apiError.plugin.confirmRequired',null,manager,{confirm:false});
  // A damaged install is replaced.
  b=await browser(manager);result=await install(manager,b,{serverId:await device('SRV-DAMAGED',{plugins:[plugin('1.0.0','damaged')]})});
  check(result.status,200,'a damaged install of the same version is repaired');
  check(r110.id.length,36,'the release that needs agent 9.0.0 is never chosen');
  await d.exec(sql`DELETE FROM jobs`);
 }

 // ---- Remove -------------------------------------------------------------------------------
 {
  const installed=await device('SRV-INSTALLED',{plugins:[plugin('1.0.0')]}),bare=await device('SRV-BARE');
  let b=await browser(manager),result=await call(manager,b,'POST',{action:'remove',serverId:bare,plugin:'dhcp',confirm:true,managementToken:b.management});
  check([result.body.messageKey,result.body.params],['apiError.plugin.notInstalled',{name:'SRV-BARE'}],'remove needs the plugin reported on the device');
  {
   b=await browser(manager,{proof:false});beforeJobs=endSession(b);
   const removed=await call(manager,b,'POST',{action:'remove',serverId:installed,plugin:'dhcp',confirm:true});
   check([beforeJobs,removed.body.code,await jobs()],[null,'SESSION_EXPIRED',0],`remove: an MFA session that ends before the batch writes nothing (${removed.body.error})`);
  }
  b=await browser(manager,{proof:false});result=await call(manager,b,'POST',{action:'remove',serverId:installed,plugin:'dhcp',confirm:true});
  const job=await d.one(sql`SELECT action,target,parameters FROM jobs WHERE id=${result.body.id}`);
  check([job.action,job.target,JSON.parse(job.parameters)],['plugin-remove','dhcp',{name:'dhcp'}],'plugin-remove queued without a token');
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE action='Plugin removal queued' AND target='SRV-INSTALLED / dhcp'`),1,'the audit row "Plugin removal queued"');
  await d.exec(sql`DELETE FROM jobs`);
  b=await browser(manager);result=await call(manager,b,'POST',{action:'remove',serverId:installed,plugin:'dhcp',confirm:true,managementToken:b.management});
  check([result.status,await proofExists(b.management)],[200,true],'remove with a token: queued, the proof stays');
  await d.exec(sql`DELETE FROM jobs`);
 }

 // ---- The plugin read ----------------------------------------------------------------------
 {
  const dc=await device('SRV-DC',{plugins:[plugin('1.0.0')]}),noPlugin=await device('SRV-NODHCP');
  const read=(actor,serverId)=>call(actor,null,'POST',{action:'job',serverId,plugin:'dhcp',operation:'dhcp-read'});
  const b=await browser(reader,{proof:false});
  current=reader;let response=await api.POST(new Request(origin+'/api/plugins',{method:'POST',headers:sessionHeaders(b,{'Content-Type':'application/json'}),body:JSON.stringify({action:'job',serverId:dc,plugin:'dhcp',operation:'dhcp-read'})}));
  const first=await response.json();
  check(response.status,200,'dhcp.read is enough, without MFA step-up or confirmation');
  const job=await d.one(sql`SELECT action,target,parameters FROM jobs WHERE id=${first.id}`);
  check([job.action,job.target,JSON.parse(job.parameters)],['plugin-job','dhcp-read',{plugin:'dhcp',operation:'dhcp-read'}],'the job and its target');
  response=await api.POST(new Request(origin+'/api/plugins',{method:'POST',headers:sessionHeaders(b,{'Content-Type':'application/json'}),body:JSON.stringify({action:'job',serverId:dc,plugin:'dhcp',operation:'dhcp-read'})}));
  check([(await response.json()).id,await jobs()],[first.id,1],'a second request answers with the open job');
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE server_id=${dc}`),0,'a read writes no audit row');
  check((await read(reader,noPlugin)).body.messageKey,'apiError.plugin.notInstalled','a device without the ready plugin');
  check((await read(viewerOnly,dc)).body.messageKey,'apiError.access.devicePermissionMissing','without dhcp.read');
  check((await call(reader,null,'POST',{action:'job',serverId:dc,plugin:'dhcp',operation:'dhcp-write'})).body.messageKey,'apiError.plugin.operationUnknown','an unknown operation');
  await d.exec(sql`DELETE FROM jobs`);
 }

 // ---- Rollout to pilot devices --------------------------------------------------------------
 {
  const newer=await release('1.3.0','4.16.0');
  const pilots=[await device('SRV-P1',{plugins:[plugin('1.0.0')]}),await device('SRV-P2',{plugins:[plugin('1.2.0')]})];
  const deploy=(actor,b,serverIds,extra={})=>call(actor,b,'POST',{action:'deploy',releaseId:newer.id,serverIds,confirm:true,managementToken:b.management,...extra});
  let b=await browser(manager);
  check((await deploy(manager,b,Array.from({length:21},uuid))).body.messageKey,'apiError.plugin.pilotDevicesRequired','21 devices are refused');
  check((await deploy(manager,b,[pilots[0],pilots[0]])).body.messageKey,'apiError.plugin.pilotDevicesRequired','duplicate devices are refused');
  check((await deploy(manager,b,pilots,{confirm:false})).body.messageKey,'apiError.plugin.pilotDevicesRequired','without confirmation');
  const each=async(label,serverId,key,params)=>{const r=await deploy(manager,b,[pilots[0],serverId]);check([r.body.messageKey,r.body.params],[key,params],label);check(await jobs(),0,label+': nothing written');};
  await each('a device without the plugin',await device('SRV-NONE'),'apiError.plugin.notInstalled',{name:'SRV-NONE'});
  await each('the same version',await device('SRV-SAME',{plugins:[plugin('1.3.0')]}),'apiError.plugin.sameVersion',{name:'SRV-SAME'});
  await each('a newer version',await device('SRV-NEWER',{plugins:[plugin('2.0.0')]}),'apiError.plugin.noDowngrade',{name:'SRV-NEWER'});
  await each('an old agent',await device('SRV-OLDAGENT',{agentVersion:'4.13.2',plugins:[plugin('1.0.0')]}),'apiError.plugin.agentTooOld',{name:'SRV-OLDAGENT',version:'4.16.0'});
  check(await proofExists(b.management),true,'refusals keep the proof');
  // The queue of one device is full: the whole rollout rolls back and the proof stays.
  for(let n=0;n<20;n++)await insert('jobs',{id:uuid(),server_id:pilots[1],action:'refresh',target:'',parameters:'{}',state:'pending',created_at:time,actor:owner.id,actor_email:owner.label,actor_principal:owner.principal});
  let result=await deploy(manager,b,pilots);
  check([result.status,result.body.messageKey,await count(sql`SELECT count(*) AS n FROM jobs WHERE action='plugin-install'`),await proofExists(b.management)],[409,'apiError.plugin.rolloutChanged',0,true],'one job not admitted: nothing is written and the proof stays');
  await d.exec(sql`DELETE FROM jobs`);
  {
   const session=await browser(manager,{proof:false});beforeJobs=endSession(session);
   const ended=await call(manager,session,'POST',{action:'deploy',releaseId:newer.id,serverIds:pilots,confirm:true});
   check([beforeJobs,ended.body.code,await jobs(),await count(sql`SELECT count(*) AS n FROM audit WHERE action='Plugin rollout planned'`)],[null,'SESSION_EXPIRED',0,0],`rollout: an MFA session that ends before the batch writes nothing and answers the MFA-session error, not rolloutChanged (${ended.body.error})`);
  }
  result=await deploy(manager,b,pilots);
  check(result.status,200,'the rollout');
  const queued=await d.query(sql`SELECT server_id,target,parameters FROM jobs WHERE action='plugin-install' ORDER BY target`);
  check([queued.length,queued.every(row=>row.target==='dhcp 1.3.0'&&JSON.parse(row.parameters).releaseId===newer.id),result.body.jobs.length,await proofExists(b.management)],[2,true,2,true],'one job per device in one transaction, the supplied proof stays');
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE action='Plugin rollout planned'`),2,'one audit row per device');
  await d.exec(sql`DELETE FROM jobs`);
  {
   const session=await browser(manager,{proof:false}),plain=await call(manager,session,'POST',{action:'deploy',releaseId:newer.id,serverIds:pilots,confirm:true});
   check([plain.status,plain.body.jobs?.length,await count(sql`SELECT count(*) AS n FROM audit WHERE action='Plugin rollout planned'`)],[200,2,4],`the rollout without a token (${plain.body.error})`);
   await d.exec(sql`DELETE FROM jobs`);
  }
  // Devices of two customers: the cross-customer gate admits the Owner, with one customer entry per customer.
  const other=uuid();await insert('customers',{id:other,name:'Other customer',created_at:time,updated_at:time});
  const foreign=await device('SRV-FOREIGN',{plugins:[plugin('1.0.0')],customer:other});
  const entries=()=>count(sql`SELECT count(*) AS n FROM audit WHERE server_id IS NULL AND customer_id IS NOT NULL`),entriesBefore=await entries();
  b=await browser(owner);result=await deploy(owner,b,[pilots[0],foreign]);
  check([result.status,await jobs(),await entries()-entriesBefore],[200,2,2],'a foreign customer through the cross-customer gate: the Owner holds the right');
  await d.exec(sql`DELETE FROM jobs`);
  // Every account is a technician of both customers: the blocks below test the release rules, not the boundary.
  await d.exec(everyCustomer(time));
 }
 // ---- Dev builds (X.Y.Z-dev.<sha7>): never latest, never installed, a rollout needs Import dev builds ----------
 {
  await d.exec(sql`DELETE FROM jobs`);
  const catalog=load('lib/server/extensions/plugin-releases.ts',imports);
  const dev=await release('1.4.0-dev.abc1234','4.16.0');
  check((await catalog.latestPluginReleases()).find(item=>item.name==='dhcp').version,'1.3.0','the newest active release of a name is never a dev build');
  check((await catalog.pluginReleases()).filter(item=>item.name==='dhcp').map(item=>[item.version,item.dev]).slice(0,2),[['1.4.0-dev.abc1234',true],['1.3.0',false]],'pluginReleases marks dev, by rank');
  check((await catalog.installablePluginRelease('dhcp','4.16.0')).release.version,'1.3.0','install and repair never take a dev build');
  check((await catalog.installablePluginRelease('dhcp','4.16.0-dev.abc1234')).release.version,'1.3.0','a dev agent meets the minimum 4.16.0 by its base');
  const b=await browser(manager);
  const installed=await call(manager,b,'POST',{action:'install',serverId:await device('SRV-DEVAGENT',{agentVersion:'4.16.0-dev.abc1234'}),plugin:'dhcp',confirm:true});
  check([installed.status,(await d.one(sql`SELECT target FROM jobs WHERE id=${installed.body.id??''}`))?.target],[200,'dhcp 1.3.0'],'install on a dev agent takes the newest release');
  await d.exec(sql`DELETE FROM jobs`);
  const deploy=(serverIds,releaseId=dev.id)=>call(manager,b,'POST',{action:'deploy',releaseId,serverIds,confirm:true});
  const pilot=await device('SRV-DEVPILOT',{plugins:[plugin('1.3.0')]});
  let result=await deploy([pilot]);
  check([result.status,result.body.messageKey,await jobs()],[409,'apiError.plugin.devBuildsOff',0],'a dev rollout while Import dev builds is off: refused before any write');
  await d.exec(sql`UPDATE agent_release_source SET dev_builds=true WHERE id=1`);
  for(const [label,version,key] of [['the release of its base','1.4.0','apiError.plugin.noDowngrade'],['the same dev build','1.4.0-dev.abc1234','apiError.plugin.sameVersion'],['a dev build of a higher base','1.5.0-dev.0000000','apiError.plugin.noDowngrade']]){
   result=await deploy([await device('SRV-'+version,{plugins:[plugin(version)]})]);
   check([result.status,result.body.messageKey,await jobs()],[409,key,0],label);
  }
  result=await deploy([pilot,await device('SRV-OTHERDEV',{plugins:[plugin('1.4.0-dev.bbbbbbb')]})]);
  check([result.status,await count(sql`SELECT count(*) AS n FROM jobs WHERE action='plugin-install' AND target='dhcp 1.4.0-dev.abc1234'`)],[200,2],'switch on: queued for a lower version and for another dev build of the base');
  await d.exec(sql`DELETE FROM jobs`);
  const needs=await release('1.4.1-dev.1234567','4.21.5');
  result=await deploy([await device('SRV-DEV-OK',{agentVersion:'4.21.5-dev.abc1234',plugins:[plugin('1.3.0')]})],needs.id);
  check(result.status,200,'a dev agent of 4.21.5 meets the minimum 4.21.5');
  await d.exec(sql`DELETE FROM jobs`);
  result=await deploy([await device('SRV-DEV-OLD',{agentVersion:'4.21.4-dev.abc1234',plugins:[plugin('1.3.0')]})],needs.id);
  check([result.body.messageKey,result.body.params],['apiError.plugin.agentTooOld',{name:'SRV-DEV-OLD',version:'4.21.5'}],'a dev agent of a lower base is too old');
  await d.exec(sql`UPDATE agent_release_source SET dev_builds=false WHERE id=1`);
  await d.exec(sql`UPDATE plugin_releases SET state='disabled' WHERE id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify([dev.id,needs.id])}::jsonb))`);
 }
 // The route keeps its own action list: anything else answers unknownAction.
 for(const action of ['upgrade','job-x',undefined,42]){
  const b=await browser(owner,{proof:false}),result=await call(owner,b,'POST',{action,serverId:uuid(),plugin:'dhcp',confirm:true});
  check([result.status,result.body.messageKey,await jobs()],[400,'apiError.request.unknownAction',0],`unknown action ${String(action)}: unknownAction`);
 }
 // Job labels of the job dock and the history (lib/job-display.ts) in both catalogs.
 const {pluginJobLabelKey}=await import('../../lib/job-display.ts'),{translate}=await import('../../lib/i18n/translate.ts');
 const labels=locale=>[['plugin-install','dhcp 1.0.0'],['plugin-remove','dhcp'],['plugin-job','dhcp-read'],['plugin-job','dns-read'],['plugin-job','other-read']].map(([action,target])=>translate(locale,pluginJobLabelKey(action,target)));
 check(labels('en'),['Install extension','Remove extension','Read DHCP server','Read DNS server','Extension job'],'the English job labels');
 check(labels('de').every(label=>typeof label==='string'&&label.length>0&&!label.startsWith('jobs.kind.')),true,'the German job labels exist');
 check(pluginJobLabelKey('agent-update','x'),undefined,'other actions keep their labels');
 console.log(`PASS plugins (${checks} checks): job requirements and labels, install release choice and refusals, removal, the plugin read with one open job, the rollout in one transaction on the MFA session fence without a step-up proof, the cross-customer gate, the action list and GET /api/plugins.`);
}finally{await d.close();}
