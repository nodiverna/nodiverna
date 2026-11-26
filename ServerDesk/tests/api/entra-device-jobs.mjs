// Device jobs of Microsoft Entra ID accounts: a job stores the real
// portal principal of the account that queued it (jobs.actor_principal), and
// every claim guard, ownership check and pending-job cancellation uses it.
// An Entra account's principal is entra:<tid>:<oid> and its label
// <oid>@<tid>.entra.serverdesk.invalid, so the old rebuild
// 'private:' || actor_email never matched its role assignments. Real console,
// files and agent channel routes, real lib/server/identity/access.ts, lib/server/devices/device-job-queue.ts,
// lib/server/devices/device-lifecycle.ts, lib/server/automation/desired-state.ts, lib/server/automation/automation-device.ts,
// lib/server/identity/rbac.ts, lib/server/devices/device-group-membership.ts and lib/server/identity/local-auth.ts run against
// an isolated migrated PostgreSQL test database.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {sourceDatabase,sourceLoader,inTransaction} from '../support/source-database.mjs';
import {compile,sql} from '../../runtime/database.mjs';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const d=await sourceDatabase();
try{
 const HttpError=realHttpError;
 let clock=Date.now(),viewer=null;
 const uuid=()=>crypto.randomUUID(),noop=async()=>{},allow=sql`TRUE`,sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 const server={
  db:()=>d,now:()=>clock,config:()=>'',guid:value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  hash:async value=>sha(value),HttpError,log:noop,
  requireViewer:async()=>viewer,sameOrigin:()=>{},body:request=>request.json(),random:()=>crypto.randomBytes(16).toString('hex'),
  failure:error=>Response.json({error:error.message},{status:error.status??500}),
 };
 const deviceRow=id=>d.one(sql`SELECT id,last_seen,management,snapshot,name,agent_public_key FROM servers WHERE id=${id}`);
 // Transport, schedulers and storage stay idle; access, policy, jobs, desired state and the lifecycle are real.
 const imports={
  '../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,
  '@/lib/server/identity/mfa':{requireMfa:noop},
  '@/lib/server/agent/agent-protocol':{
   maintenanceBusy:async()=>false,
   modern:row=>JSON.parse(row.snapshot),
   agentFromBearer:async request=>deviceRow((await request.clone().json()).serverId),assertAgentActive:noop,snapshot:row=>JSON.parse(row.snapshot),releaseLease:noop,securityFile:()=>false,lease:noop,
  },
  '@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
  '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>null,DISPATCH_LIFETIME_SECONDS:60,JOB_SIGNING_KEY_MISSING:'missing'},
  '@/lib/server/devices/device-group-catalog':{deviceGroupCatalog:async()=>[],devicePermissionTargets:async()=>[]},'@/lib/server/agent/device-tokens':{PERSONAL_REGISTRATION_LIFETIME:1},
  '@/lib/server/devices/rdp':{sweepRdp:noop},'@/lib/server/audit-scope':{auditSelect:sql`SELECT 1`,deviceAuditGuard:()=>allow,portalAuditGuard:()=>allow},'@/lib/server/identity/customers':{visibleCustomers:async()=>[]},
  '@/lib/server/automation/runbooks':{tickAutomation:noop},'@/lib/server/automation/drift':{ingestDrift:noop},'@/lib/server/devices/file-access':{requireFileAccess:noop},
  '@/lib/server/devices/transfers':{verifyTransfer:noop,sweepTransfers:noop,transferAuthorizationGuard:()=>allow},'@/lib/server/devices/terminal-lifecycle':{sweepTerminalSessions:noop},
  '@/lib/server/devices/terminal-channel':{terminalReport:z.object({}),exchangeTerminals:async()=>[]},
  '@/lib/server/automation/automation-device':{reconcileDeviceAutomation:noop,getAutomationDriftPolicy:async()=>null},'@/lib/server/automation/automation-runbooks':{scopedRunbookClaimGuard:async()=>allow},
 };
 const modules=sourceLoader(),load=file=>modules(file,imports);
 const consoleApi=load('app/api/console/route.ts'),filesApi=load('app/api/files/route.ts'),channel=load('app/api/agent/channel/route.ts');
 const lifecycle=load('lib/server/devices/device-lifecycle.ts'),desired=load('lib/server/automation/desired-state.ts'),automation=load('lib/server/automation/automation-device.ts'),scopes=load('lib/server/automation/automation-scopes.ts');
 const rbac=load('lib/server/identity/rbac.ts'),membership=load('lib/server/devices/device-group-membership.ts'),localAuth=load('lib/server/identity/local-auth.ts'),{commitAll}=load('lib/server/db.ts');

 // ---- Fixture ---------------------------------------------------------------------------------------
 const tenant='7c7c7c7c-0000-4000-8000-000000000232',at=clock;
 const rsa=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'});
 const capabilities=['refresh','list-files','agent-uninstall','desired-state-test','desired-state-apply'];
 const snapshot=JSON.stringify({protocolVersion:3,agentVersion:'4.19.0',mode:'Management',os:'Windows 11 Pro',agentCapabilities:capabilities,publicKey:{kty:'RSA',n:rsa.n,e:rsa.e}});
 async function group(name){const id=uuid();await d.exec(sql`INSERT INTO device_groups(id,name,description,created_at) VALUES(${id},${name},'Entra jobs fixture',${at})`);return id;}
 async function device(name,groupId){
  const id=uuid();
  await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen,management,snapshot) VALUES(${id},${name},${'token-'+id},${at},${at+1e12},1,${snapshot})`);
  if(groupId)await d.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${id},${groupId})`);
  return id;
 }
 const viewerOf=(row,extra)=>{const v={id:row.id,userId:row.id,label:row.label,principal:row.principal,username:row.name,displayName:row.name,permissions:[],...extra};Object.defineProperty(v,'authorization',{value:{authVersion:1},enumerable:false});return v;};
 async function role(userId,permissions,scopeType,scopeId,source='manual'){
  const roleId=uuid();
  await inTransaction(d,[
   sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${roleId},${'Role '+roleId},'Entra jobs fixture',${JSON.stringify(permissions)},0,${at})`,
   sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by,source) VALUES(${uuid()},'user',${userId},${roleId},${scopeType},${scopeId},${at},${source==='entra'?'entra:sync':'fixture'},${source})`,
  ]);
 }
 // An account from Microsoft Entra ID as the Entra sign-in creates it, with its rights from a role_assignments row of the Entra role sync.
 async function entraAccount(name,permissions,scopeType='global',scopeId='*'){
  const id=uuid(),oid=uuid(),principal=`entra:${tenant}:${oid}`,label=`${oid}@${tenant}.entra.serverdesk.invalid`;
  await d.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at,password_hash,must_reset,identity_source,entra_tenant_id,entra_object_id) VALUES(${id},${name},${name+'@contoso.test'},${name},${principal},${label},'active',1,${at},${at},NULL,0,'entra',${tenant},${oid})`);
  await role(id,permissions,scopeType,scopeId,'entra');
  return viewerOf({id,label,principal,name},{identitySource:'entra',entra:{tenantId:tenant,objectId:oid,email:name+'@contoso.test'}});
 }
 async function localAccount(name,permissions,scopeType='global',scopeId='*',principal='private:'+name){
  const id=uuid();
  await d.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at,password_hash,must_reset) VALUES(${id},${name},${name},${name},${principal},${name},'active',1,${at},${at},'fixture-password',0)`);
  await role(id,permissions,scopeType,scopeId);
  return viewerOf({id,label:name,principal,name},{identitySource:'local'});
 }
 const request=(payload,url='https://jobs.test/api')=>new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 const answer=async response=>({status:response.status,body:await response.json()});
 const clear=()=>inTransaction(d,[sql`DELETE FROM desired_runs`,sql`DELETE FROM jobs`,sql`DELETE FROM job_outputs`]);
 const jobRow=id=>d.one(sql`SELECT state,result,actor_email,actor_principal FROM jobs WHERE id=${id}`);
 async function poll(serverId){
  clock+=1000;const response=await channel.POST(request({serverId},'https://jobs.test/api/agent/channel'));
  assert.equal(response.status,200,'channel answers: '+JSON.stringify(await response.clone().json()));return response.json();
 }
 async function rawJob(serverId,v,{action='refresh',principal=v.principal,state='pending'}={}){
  const id=uuid();
  await d.exec(sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,actor,parameters,actor_email,actor_principal,not_before) VALUES(${id},${serverId},${action},'',${state},${clock},${v.id},'{}',${v.label},${principal},0)`);
  return id;
 }

 const operations=await group('Operations'),moved=await group('Moved'),automated=await group('Automated');
 const srv=await device('SRV-ENTRA-01',operations),auto=await device('SRV-ENTRA-AUTO',automated),bystander=await device('SRV-LOCAL-01',null);
 // Operator rights on the group only, as an Entra group mapping gives them.
 const operator=await entraAccount('operator',['view','diagnose','files.read','desired.read','desired.apply','desired.manage'],'devicegroup',operations);
 const reader=await entraAccount('reader',['view','files.read'],'devicegroup',operations);
 const owner=await entraAccount('owner',['*']);
 const local=await localAccount('local@jobs.test',['view','diagnose','files.read']);
 const admin=await localAccount('admin@jobs.test',['*']);
 check([operator.principal.startsWith('entra:'),operator.label.endsWith('.entra.serverdesk.invalid')],[true,true],'the Entra fixture has the principal and label of an Entra sign-in');

 // ---- an Entra viewer's device job is claimed -----------------------------------------------------
 {
  viewer=operator;
  const queued=await answer(await consoleApi.POST(request({action:'job',id:srv,kind:'refresh',params:{},confirm:true})));
  check(queued.status,200,'the Entra operator queues refresh');
  const claimed=await poll(srv),row=await jobRow(queued.body.id);
  check([row.state,row.result,claimed.jobs.map(job=>job.id)],['running',null,[queued.body.id]],'the agent claims the Entra operator\'s refresh');
  check([row.actor_email,row.actor_principal],[operator.label,operator.principal],'the job stores the label as actor_email and the Entra principal as actor_principal');
  await clear();
  // The same job with the principal the old claim rebuilt from actor_email is refused.
  const rebuilt=await rawJob(srv,operator,{principal:'private:'+operator.label});await poll(srv);
  check(await jobRow(rebuilt),{state:'cancelled',result:'serverMessage.job.permissionOrCapabilityMissing',actor_email:operator.label,actor_principal:'private:'+operator.label},'the rebuilt principal private:<label> has no rights: cancelled');
  await clear();
  // A job without an actor is never claimable, as before.
  const anonymous=uuid();await d.exec(sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,actor,parameters,not_before) VALUES(${anonymous},${srv},'refresh','','pending',${clock},'System','{}',0)`);await poll(srv);
  check((await jobRow(anonymous)).state,'cancelled','a job without actor_principal is not claimed');
  await clear();
  // A local account keeps working unchanged.
  viewer=local;const own=await answer(await consoleApi.POST(request({action:'job',id:srv,kind:'refresh',params:{},confirm:true})));
  await poll(srv);check(await jobRow(own.body.id),{state:'running',result:null,actor_email:local.label,actor_principal:'private:'+local.label},'a local account\'s job stores private:<email> and is claimed');
  await clear();
 }

 // ---- file job ownership -------------------------------------------------------------------------
 {
  viewer=operator;
  const queued=await answer(await filesApi.POST(request({serverId:srv,kind:'list-files',params:{},confirm:true})));
  check([queued.status,(await jobRow(queued.body.id)).actor_principal],[200,operator.principal],'the Entra operator queues a file listing');
  check((await poll(srv)).jobs.map(job=>job.id),[queued.body.id],'the agent claims the Entra file job');
  const read=async v=>{viewer=v;return answer(await filesApi.GET(new Request(`https://jobs.test/api/files?serverId=${srv}&jobId=${queued.body.id}`)));};
  const ownRead=await read(operator);
  check([ownRead.status,ownRead.body.job?.id],[200,queued.body.id],'the Entra viewer reads their own file job');
  const notFound=serverText('apiError.files.jobNotFound');
  check([(await read(reader)).body.error,(await read(local)).body.error],[notFound,notFound],'another Entra viewer and a local viewer get jobNotFound');
  await clear();
 }

 // ---- uninstall by an Entra Owner ------------------------------------------------------------------
 {
  const proof={guard:sql`TRUE`,tokenHash:'none',key:owner.principal,sessionHash:'none'};
  const {uninstall}=await lifecycle.requestAgentUninstall(owner,[srv],true,proof);
  check(uninstall.queued,[srv],'the Entra Owner queues the agent uninstall');
  const job=await d.one(sql`SELECT id,actor_principal FROM jobs WHERE server_id=${srv} AND action='agent-uninstall'`);
  check(job.actor_principal,owner.principal,'the uninstall job carries the Entra Owner\'s principal');
  const claimed=await poll(srv);
  check([claimed.jobs.map(item=>item.id),(await jobRow(job.id)).state],[[job.id],'running'],'the uninstall of an Entra Owner is claimed (instance.owner over jobs.actor_principal)');
  await clear();
 }

 // ---- a desired-state-test job of an Entra viewer ---------------------------------------------------
 const content=JSON.stringify({resources:[{name:'Folder',type:'File',properties:{path:'C:\\Managed'}}]}),digest=sha(content);
 const config=uuid(),version=uuid();
 await inTransaction(d,[
  sql`INSERT INTO desired_configs(id,name,description,created_by,created_at) VALUES(${config},'Entra config','',${owner.principal},${at})`,
  sql`INSERT INTO desired_versions(id,config_id,version,engine,content,sha256,parameters,source,created_at,created_by) VALUES(${version},${config},1,'dsc3',${content},${digest},'{}','{}',${at},${owner.principal})`,
 ]);
 {
  const assignment=uuid();
  await d.exec(sql`INSERT INTO desired_assignments(id,server_id,version_id,assigned_by,assigned_at,enabled,interval_seconds) VALUES(${assignment},${srv},${version},${operator.principal},${at},1,0)`);
  const queued=await desired.queueDesiredState(operator,{action:'test',assignmentId:assignment,confirmSystem:true});
  const run=await d.one(sql`SELECT created_by FROM desired_runs WHERE id=${queued.runId}`),job=await d.one(sql`SELECT id,server_id,action,actor_principal,parameters FROM jobs WHERE id=${queued.jobId}`);
  check([run.created_by,job.actor_principal],[operator.principal,operator.principal],'the run and the job carry the Entra principal');
  check(await desired.checkPendingDesiredJob(job),true,'checkPendingDesiredJob accepts the Entra job');
  const guard=await desired.desiredJobClaimGuard(job.id,srv);
  check((await d.query(sql`SELECT id FROM jobs WHERE ${guard}`)).length,1,'desiredJobClaimGuard gives one row for the Entra job');
  check([(await poll(srv)).jobs.map(item=>item.id),(await jobRow(job.id)).state],[[job.id],'running'],'the agent claims the Entra viewer\'s desired-state-test');
  // A run whose creator is not the job's actor principal fails closed.
  await d.exec(sql`UPDATE jobs SET state='pending',actor_principal=${'private:'+operator.label} WHERE id=${job.id}`);
  check([await desired.checkPendingDesiredJob({...job,actor_principal:'private:'+operator.label}),compile(await desired.desiredJobClaimGuard(job.id,srv)).text],[false,'FALSE'],'a job whose principal is not the run creator is refused');
  await clear();await d.exec(sql`DELETE FROM desired_assignments WHERE id=${assignment}`);
 }

 // ---- an automation approval of an Entra Owner ------------------------------------------------------
 {
  const template=uuid(),source=uuid();
  await inTransaction(d,[
   sql`INSERT INTO automation_templates(id,kind,slot,name,payload,created_by,created_at) VALUES(${template},'desired','default','Entra template',${JSON.stringify({versionId:version,intervalSeconds:300})},${owner.principal},${at})`,
   sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,actor,auth_version,created_at) VALUES(${source},'desired','default','group',${automated},${template},${owner.principal},1,${at})`,
  ]);
  await automation.reconcileDeviceAutomation(auto);
  const assignment=await d.one(sql`SELECT id,assigned_by FROM desired_assignments WHERE server_id=${auto}`);
  check(assignment?.assigned_by,owner.principal,'the automation assigns the version for the Entra Owner');
  await desired.advanceDesiredState(auto);
  const job=await d.one(sql`SELECT id,server_id,action,actor_principal,parameters FROM jobs WHERE server_id=${auto}`);
  check([job?.action,job?.actor_principal,JSON.parse(job?.parameters??'{}').automationApproval?.actor],['desired-state-test',owner.principal,owner.principal],'advanceDesiredState queues the scheduled test of an Entra approval');
  check(await desired.checkPendingDesiredJob(job),true,'the Entra approval passes the pending check');
  check((await d.query(sql`SELECT id FROM jobs WHERE ${await desired.desiredJobClaimGuard(job.id,auto)}`)).length,1,'and the claim guard');
  check((await poll(auto)).jobs.map(item=>item.id),[job.id],'the agent claims the scheduled test');
  await clear();
  // Any other prefix is still refused: the same approval by a foo: account queues nothing.
  const foreign='foo:legacy@jobs.test';await localAccount('legacy@jobs.test',['*'],'global','*',foreign);
  await inTransaction(d,[
   sql`UPDATE automation_scope_assignments SET actor=${foreign} WHERE id=${source}`,
   sql`UPDATE desired_assignments SET assigned_by=${foreign},last_checked_at=NULL WHERE id=${assignment.id}`,
  ]);
  const effective=(await scopes.effectiveAutomationForDevice(auto,'desired')).find(entry=>entry.slot==='default');
  check(effective?.actor,foreign,'the effective approval names the foo: actor');
  await desired.advanceDesiredState(auto);
  check(await d.one(sql`SELECT id FROM jobs WHERE server_id=${auto}`),null,'an approval with a foo: actor queues no test');
  await inTransaction(d,[sql`DELETE FROM automation_scope_assignments WHERE id=${source}`,sql`DELETE FROM desired_assignments WHERE server_id=${auto}`]);
 }

 // ---- pending jobs of an Entra account are cancelled by principal -----------------------------------
 {
  const pending=async()=>({entra:await rawJob(srv,operator),local:await rawJob(bystander,local)});
  const expectCancelled=async(jobs,result,label)=>{
   check(await jobRow(jobs.entra),{state:'cancelled',result,actor_email:operator.label,actor_principal:operator.principal},label+': the Entra job is cancelled');
   check((await jobRow(jobs.local)).state,'pending',label+': the local user\'s job stays pending');
   await clear();
  };
  // A role assignment change (lib/server/identity/rbac.ts invalidateRbacUsers → cancelPendingForPrincipal).
  let jobs=await pending();await rbac.invalidateRbacUsers([{auth_principal:operator.principal}]);
  await expectCancelled(jobs,'serverMessage.job.permissionChanged','role assignment change');
  // A device group change: the device moves out of the group that gives the Entra rights.
  jobs=await pending();await membership.changeDeviceMemberships(admin,[srv],moved,true,sql`TRUE`);
  await expectCancelled(jobs,'serverMessage.job.permissionChanged','device group change');
  await membership.changeDeviceMemberships(admin,[srv],operations,true,sql`TRUE`);await clear();
  // A deleted device group with an assignment of the Entra account (lib/server/identity/rbac.ts deleteDeviceGroup).
  const doomed=await group('Doomed');await role(operator.id,['view'],'devicegroup',doomed);
  await d.exec(sql`INSERT INTO mfa_management_proofs(token_hash,principal,session_hash,expires_at) VALUES('proof-232',${admin.principal},'session-232',${clock+60000})`);
  jobs=await pending();check(await rbac.deleteDeviceGroup(admin,doomed,true,{guard:sql`TRUE`,tokenHash:'proof-232',key:admin.principal,sessionHash:'session-232'}),{ok:true,id:doomed},'the admin deletes the group');
  await expectCancelled(jobs,'serverMessage.job.permissionChanged','device group deletion');
  // Entra sign-in turned off (lib/server/identity/entra/settings.ts → revocationStatementsFor).
  jobs=await pending();await commitAll(localAuth.revocationStatementsFor(sql`SELECT id,auth_principal FROM local_users WHERE identity_source='entra'`));
  await expectCancelled(jobs,'serverMessage.job.accountChanged','Entra sign-in turned off');
  // One account (lib/server/identity/local-auth.ts revocationStatements).
  jobs=await pending();await commitAll(localAuth.revocationStatements({id:operator.id,auth_principal:operator.principal}));
  await expectCancelled(jobs,'serverMessage.job.accountChanged','account revocation');
 }

 // ---- source scan ----------------------------------------------------------------------------
 {
  const files=[];
  const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(?:ts|tsx|mts|mjs|js)$/.test(entry.name))files.push(full.split(path.sep).join('/'));}};
  for(const dir of ['lib','app','ui','runtime'])if(fs.existsSync(dir))walk(dir);
  const rebuild=/'private:'\s*(?:\|\||\+)|"private:"\s*\+|`private:\$\{/,hits=[];
  for(const file of files)fs.readFileSync(file,'utf8').split('\n').forEach(line=>{if(rebuild.test(line))hits.push(file+': '+(line.match(/export const principal|INSERT INTO local_users|const callerKey/)?.[0]??line.trim().slice(0,80)));});
  check(hits.sort(),['lib/server/identity/access.ts: export const principal','lib/server/identity/account-admin.ts: INSERT INTO local_users'].sort(),'only principal() and the local account creation build a private: key');
  check(fs.existsSync('app/access-panel.tsx'),false,'the classic group panel with its callerKey fallback is deleted');
  check([/owner:owners\.get\(s\.principal\)\?\?null/.test(fs.readFileSync('lib/server/devices/rdp.ts','utf8')),/value\.startsWith\('private:'\)\?value\.slice\(8\):value/.test(fs.readFileSync('lib/account-display.ts','utf8'))],[true,true],'the RDP owner is the account name; a stored value strips only a leading private:');
  const inserts=[];
  for(const file of files.filter(file=>/^(?:lib|app)\//.test(file)))for(const match of fs.readFileSync(file,'utf8').matchAll(/INSERT INTO jobs \(([^)]*)\)/g))inserts.push([file,match[1].split(',').includes('actor_principal')]);
  check(inserts.length>=12,true,'every insert site is found');
  check(inserts.filter(([,has])=>!has),[],'every INSERT INTO jobs writes actor_principal');
  check(/actor_email/.test(fs.readFileSync('lib/server/agent/agent-channel.ts','utf8')),false,'the agent channel no longer reads actor_email');
 }
 console.log(`PASS Entra device jobs (${checks} checks): jobs store the real principal; the claim, uninstall, desired state, automation approval and file ownership work for Entra accounts; the old rebuild is refused; cancellations match by principal; no principal is rebuilt from actor_email.`);
}finally{await d.close();}
