// A real PostgreSQL test database and the actual scheduler/guards. No agent is contacted and the
// queued PowerShell source is never executed on the host running these tests.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ts from 'typescript';
import {sql,SqlFragment} from '../../runtime/database.mjs';

import {sourceDatabase,inTransaction,createTrigger,dropTrigger} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
const require=createRequire(import.meta.url),d=await sourceDatabase(),cache=new Map(),root=process.cwd(),uuid=()=>crypto.randomUUID();
let clock=Date.now(),beforeBatch=null,checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const HttpError=realHttpError;
const facade=hookDatabase(d,{transaction:async()=>{if(beforeBatch){const pause=beforeBatch;beforeBatch=null;await pause();}}});
const server={db:()=>facade,now:()=>clock,hash:async value=>crypto.createHash('sha256').update(value).digest('hex'),guid:value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value),HttpError,log:async()=>{}};
const mocks=new Map([
 ['lib/server/context.ts',server],['lib/server/identity/local-auth.ts',{}],
 ['lib/server/identity/mfa.ts',{isMfaEnabled:async viewer=>!!await d.one(sql`SELECT 1 FROM mfa_accounts WHERE principal=${viewer.principal??'private:'+viewer.label}`)}],
 ['lib/management.ts',{operations:Object.fromEntries(['refresh','scan-updates','test-connection'].map(name=>[name,{schema:{safeParse:()=>({success:true})}}]))}],
 ['lib/server/agent/agent-crypto.ts',{sealAgentSecrets:async()=>({})}]
]);
function load(filename){
 const absolute=path.resolve(filename),relative=path.relative(root,absolute).replaceAll('\\','/');if(mocks.has(relative))return mocks.get(relative);if(cache.has(absolute))return cache.get(absolute).exports;
 const mod={exports:{}};cache.set(absolute,mod);
 const source=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const localRequire=id=>{if(id.startsWith('.')){const base=path.resolve(path.dirname(absolute),id),file=[base,base+'.ts',base+'.tsx'].find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isFile());if(file)return /[.]m?js$/.test(file)?require(file):load(file);}return require(id);};
 new Function('require','module','exports',source)(localRequire,mod,mod.exports);return mod.exports;
}
const scoped=load('lib/server/automation/automation-runbooks.ts'),runbooks=load('lib/server/automation/runbooks.ts');load('lib/server/automation/automation-scopes.ts');const access=load('lib/server/identity/access.ts');
try{
 const owner={id:uuid(),label:'owner@scope.test',permissions:['*']};Object.defineProperty(owner,'authorization',{value:{authVersion:1},enumerable:false});
 const actor=access.principal(owner),role=uuid(),group=uuid(),child=uuid(),peer=uuid(),book=uuid(),version=uuid(),otherVersion=uuid(),mfaCreatedAt=clock-86400000;
 const snapshot={os:'Windows Server 2025',protocolVersion:3,agentVersion:'4.6.3',agentCapabilities:['runbook-step'],mode:'Management',management:true};
 const definition={parameters:[],steps:[{id:'first',name:'First',kind:'powershell',script:'Write-Output "first"',timeoutSeconds:60,operationParameters:{}},{id:'second',name:'Second',kind:'powershell',script:'Write-Output "second"',timeoutSeconds:60,operationParameters:{}}]};
 await inTransaction(d,[
  sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,must_reset,created_at,updated_at) VALUES(${owner.id},${owner.label},${owner.label},${owner.label},${actor},${owner.label},'active',1,0,${clock},${clock})`,
  sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${actor},'fixture','[]',0,${mfaCreatedAt})`,
  sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${role},'Owner','','["*"]',0,${clock})`,
  sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${owner.id},${role},'global','*',${clock},${actor})`,
  ...[[group,null],[child,group],[peer,null]].map(([id,parent])=>sql`INSERT INTO device_groups(id,name,description,parent_id,created_at) VALUES(${id},${id},'',${parent},${clock})`),
  sql`INSERT INTO runbooks(id,name,description,created_at,created_by) VALUES(${book},'Scoped book','',${clock},${actor})`,
  ...[[version,1],[otherVersion,2]].map(([id,number])=>sql`INSERT INTO runbook_versions(id,runbook_id,version,definition,created_at,created_by) VALUES(${id},${book},${number},${JSON.stringify(definition)},${clock},${actor})`)
 ]);
 const device=uuid(),nested=uuid(),overridden=uuid(),conflicted=uuid(),disabled=uuid();
 async function addDevices(ids,targetGroup){await inTransaction(d,[
  sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen,snapshot,management) SELECT value,value,'token-'||value,${clock},${clock},${JSON.stringify(snapshot)},1 FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)`,
  sql`INSERT INTO device_group_members(server_id,group_id) SELECT value,${targetGroup} FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)`
 ]);}
 await addDevices([device,overridden,conflicted,disabled],group);await addDevices([nested],child);
 const payload=(extras={})=>({versionId:version,parameters:{},recurrence:null,catchupSeconds:3600,concurrency:2,failureStop:true,...extras});
 async function assign(scopeType,scopeId,{templateId,templatePayload,disabled=false,id=uuid(),createdAt=clock}={}){
  templateId??=uuid();if(!await d.one(sql`SELECT 1 FROM automation_templates WHERE id=${templateId}`))await d.exec(sql`INSERT INTO automation_templates(id,kind,slot,name,payload,created_by,created_at) VALUES(${templateId},'runbook',${book},'Scope template',${JSON.stringify(templatePayload??payload())},${actor},${clock})`);
  await d.exec(sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,disabled,actor,auth_version,created_at) VALUES(${id},'runbook',${book},${scopeType},${scopeId},${templateId},${disabled?1:0},${actor},1,${createdAt})`);return {id,templateId};
 }
 const base=await assign('group',group);await assign('device',overridden,{templatePayload:payload({versionId:otherVersion})});await assign('device',disabled,{disabled:true});await assign('group',peer,{templatePayload:payload({versionId:otherVersion})});
 // One group per device: a second membership is rejected, a move replaces it.
 await assert.rejects(()=>d.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${conflicted},${peer})`),error=>error.code==='23505'&&error.constraint_name==='idx_device_group_members_server');checks++;
 await d.exec(sql`UPDATE device_group_members SET group_id=${peer} WHERE server_id=${conflicted}`);
 const resetWork=()=>inTransaction(d,['DELETE FROM runbook_step_results','DELETE FROM jobs','DELETE FROM runbook_run_devices','DELETE FROM automation_runbook_runs','DELETE FROM runbook_runs','DELETE FROM automation_runbook_schedules','DELETE FROM automation_device_state','DELETE FROM audit'].map(text=>new SqlFragment([text],[])));
 // where is fixture text with ? placeholders for args.
 const count=async(table,where='',...args)=>Number((await d.one(sql`SELECT count(*) AS n FROM ${sql.ident(table)} ${new SqlFragment(where.split('?'),args)}`)).n);
 const rejected=async(action,label)=>{await assert.rejects(action,error=>error instanceof HttpError&&(error.status===409||error.status===403),label);checks++;};
 // Campaign audit: one device row per frozen target, written in the campaign batch.
 const manualAction='Runbook über Zuweisung gestartet',scheduledAction='Runbook-Zuweisung per Zeitplan gestartet',campaignFailure='apiError.runbook.campaignNotStarted';
 const campaignAudits=async runId=>(await d.query(sql`SELECT actor,action,target,server_id,scope,customer_id,at FROM audit WHERE target LIKE '%/ '||${runId} ORDER BY server_id`));
 const campaignAuditCount=()=>count('audit','WHERE action IN (?,?)',manualAction,scheduledAction);
 const createdAt=async runId=>(await d.one(sql`SELECT created_at FROM runbook_runs WHERE id=${runId}`)).created_at;
 const failAudit=()=>createTrigger(d,'audit_unavailable','audit','BEFORE INSERT',{message:'audit unavailable'}),restoreAudit=()=>dropTrigger(d,'audit_unavailable');
 const serverLog=async action=>{const lines=[],original=console.error;console.error=(...args)=>lines.push(args.map(String).join(' '));try{await action();}finally{console.error=original;}return lines;};
 let result=await scoped.startAutomationRun(owner,{assignmentId:base.id,confirm:true,requestId:uuid()});
 check(result.targets,2,'parent group includes descendant membership and excludes direct/disabled overrides and devices moved to a peer group');
 check((await d.query(sql`SELECT server_id FROM runbook_run_devices WHERE run_id=${result.id} ORDER BY server_id`)).map(x=>x.server_id),[device,nested].sort(),'frozen effective targets are exact');
 {
  const audits=await campaignAudits(result.id),at=await createdAt(result.id),customers=(await d.query(sql`SELECT customer_id FROM servers WHERE id IN (${device},${nested}) ORDER BY id`)).map(x=>x.customer_id);
  check(audits.map(x=>x.server_id),[device,nested].sort(),'group campaign writes one audit row per frozen target, none for overrides, disabled or peer devices');
  check(audits.map(({actor,action,target,scope,at})=>({actor,action,target,scope,at})),audits.map(()=>({actor:owner.label,action:manualAction,target:'Scoped book / v1 / '+result.id,scope:'device',at})),'manual campaign audit names the acting user, runbook version and run at the run time');
  check(audits.map(x=>x.customer_id),customers,'campaign audit inherits each device customer through the trigger');check(audits.every(x=>x.customer_id!==null),true,'campaign audit customer is never NULL');
 }
 await resetWork();await scoped.tickScopedRunbooks(device);check(await count('runbook_runs'),0,'recurrence:null does not automatically execute PowerShell');

 // Membership and approval races after reads, before the atomic campaign batch.
 for(const [label,change,restore]of[
  ['membership removed',()=>d.exec(sql`DELETE FROM device_group_members WHERE server_id=${nested}`),()=>d.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${nested},${child})`)],
  ['role revoked',()=>d.exec(sql`UPDATE rbac_roles SET permissions='[]' WHERE id=${role}`),()=>d.exec(sql`UPDATE rbac_roles SET permissions='["*"]' WHERE id=${role}`)],
  ['approval reset',()=>d.exec(sql`UPDATE local_users SET auth_version=2 WHERE id=${owner.id}`),()=>d.exec(sql`UPDATE local_users SET auth_version=1 WHERE id=${owner.id}`)],
  ['MFA removed',()=>d.exec(sql`DELETE FROM mfa_accounts WHERE principal=${actor}`),()=>d.exec(sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${actor},'fixture','[]',0,${mfaCreatedAt})`)],
  ['MFA recreated',()=>inTransaction(d,[sql`DELETE FROM mfa_accounts WHERE principal=${actor}`,sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${actor},'re-enrolled','[]',0,${clock+1})`]),()=>d.exec(sql`UPDATE mfa_accounts SET created_at=${mfaCreatedAt} WHERE principal=${actor}`)],
  ['assignment disabled',()=>d.exec(sql`UPDATE automation_scope_assignments SET disabled=1 WHERE id=${base.id}`),()=>d.exec(sql`UPDATE automation_scope_assignments SET disabled=0 WHERE id=${base.id}`)]
 ]){beforeBatch=change;await rejected(()=>scoped.startAutomationRun(owner,{assignmentId:base.id,confirm:true}),label);check(await count('runbook_runs'),0,label+': no partial campaign');check(await count('automation_runbook_runs'),0,label+': no orphan approval metadata');check(await campaignAuditCount(),0,label+': no audit without campaign');await restore();}
 const joined=uuid();beforeBatch=()=>addDevices([joined],group);await rejected(()=>scoped.startAutomationRun(owner,{assignmentId:base.id,confirm:true}),'new member at commit');check(await count('runbook_runs'),0,'membership additions also force fresh resolution');check(await campaignAuditCount(),0,'new member at commit: no audit without campaign');
 result=await scoped.startAutomationRun(owner,{assignmentId:base.id,confirm:true});check(result.targets,3,'fresh resolution automatically includes a new group member');
 await resetWork();

 // One shared campaign enforces global concurrency across all devices, and a
 // terminal unknown result stops the campaign without replaying either step.
 result=await scoped.startAutomationRun(owner,{assignmentId:base.id,confirm:true});
 await Promise.all([runbooks.tickAutomation(device,snapshot),runbooks.tickAutomation(nested,snapshot),runbooks.tickAutomation(joined,snapshot)]);
 check(await count('runbook_run_devices',"WHERE run_id=? AND state='running'",result.id),2,'parallel channels share the configured campaign concurrency');
 check(await count('jobs'),2,'global concurrency cannot become one independent budget per device');
 // A code from an earlier step on the other device; the portal text that stops it must clear it.
 await d.exec(sql`UPDATE runbook_run_devices SET result='Earlier step',result_code='AGENT_JOB_CANCELLED',result_args='{}' WHERE run_id=${result.id} AND server_id=${nested} AND state='running'`);
 await d.exec(sql`UPDATE jobs SET state='expired',result='Unknown',result_code='AGENT_TCP_CONNECTED',result_args='{"host":"srv","port":"443"}' WHERE server_id=${device}`);await runbooks.tickAutomation(device,snapshot);
 check(await d.one(sql`SELECT state,result,result_code,result_args FROM runbook_run_devices WHERE run_id=${result.id} AND server_id=${device}`),{state:'unknown',result:'Unknown',result_code:'AGENT_TCP_CONNECTED',result_args:'{"host":"srv","port":"443"}'},'the device summary keeps result_code and result_args of the job it copies');
 check(await d.one(sql`SELECT state,result,result_code,result_args FROM runbook_run_devices WHERE run_id=${result.id} AND server_id=${nested}`),{state:'cancelled',result:'serverMessage.runbook.campaignStopped',result_code:null,result_args:null},'a later portal text in the device summary clears result_code and result_args');
 {const listed=(await runbooks.listRunbooks(owner,device,result.id)).runs.find(r=>r.id===result.id)?.devices.find(x=>x.serverId===device);check(listed&&{result:listed.result,resultCode:listed.resultCode,resultArgs:listed.resultArgs,raw:'result_code' in listed},{result:'Unknown',resultCode:'AGENT_TCP_CONNECTED',resultArgs:{host:'srv',port:'443'},raw:false},'the run list returns the device summary with resultCode and resultArgs');}
 check(await count('jobs'),2,'unknown result does not enqueue a retry');check((await d.one(sql`SELECT state FROM runbook_runs WHERE id=${result.id}`)).state,'unknown','unknown result remains unknown across failure-stop');
 await resetWork();

 // Final agent claim and delivery use the same live scope guard. A scope change
 // after a job has been prepared cannot expose its script to an agent.
 result=await scoped.startAutomationRun(owner,{assignmentId:base.id,confirm:true});await runbooks.tickAutomation(device,snapshot);
 let job=await d.one(sql`SELECT id,parameters FROM jobs WHERE server_id=${device}`);assert.ok(job);checks++;
 const claim=await scoped.scopedRunbookClaimGuard(job.id,device,JSON.parse(job.parameters).runId);
 await d.exec(sql`UPDATE automation_scope_assignments SET disabled=1 WHERE id=${base.id}`);
 check((await d.exec(sql`UPDATE jobs SET state='running' WHERE id=${job.id} AND state='pending' AND (${claim})`)).rowCount,0,'atomic agent claim rejects a concurrently disabled scope');
 await runbooks.tickAutomation(device,snapshot);check((await d.one(sql`SELECT state FROM jobs WHERE id=${job.id}`)).state,'cancelled','withdrawn approval cancels prepared pending work');
 await d.exec(sql`UPDATE automation_scope_assignments SET disabled=0 WHERE id=${base.id}`);await resetWork();
 result=await scoped.startAutomationRun(owner,{assignmentId:base.id,confirm:true});await runbooks.tickAutomation(device,snapshot);job=await d.one(sql`SELECT id,parameters FROM jobs WHERE server_id=${device}`);
 const delivery=await scoped.scopedRunbookClaimGuard(job.id,device,result.id);await d.exec(sql`UPDATE jobs SET state='running' WHERE id=${job.id} AND (${delivery})`);
 await d.exec(sql`UPDATE local_users SET auth_version=2 WHERE id=${owner.id}`);
 check(await d.one(sql`SELECT parameters FROM jobs WHERE id=${job.id} AND state='running' AND (${delivery})`),null,'last delivery check rejects password/MFA reset after job claim');
 await d.exec(sql`UPDATE local_users SET auth_version=1 WHERE id=${owner.id}`);
 await inTransaction(d,[sql`DELETE FROM mfa_accounts WHERE principal=${actor}`,sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${actor},'re-enrolled','[]',0,${clock+1})`]);
 check(await d.one(sql`SELECT parameters FROM jobs WHERE id=${job.id} AND state='running' AND (${delivery})`),null,'newly enrolled MFA cannot restore final delivery for an old approval');
 await d.exec(sql`UPDATE mfa_accounts SET created_at=${mfaCreatedAt} WHERE principal=${actor}`);await resetWork();

 // Scheduled scope approvals have one cursor and one campaign per occurrence.
 // Simultaneous channels cannot duplicate the campaign or its target rows.
 await d.exec(sql`DELETE FROM automation_scope_assignments WHERE id=${base.id}`);
 const scheduled=await assign('group',group,{templatePayload:payload({recurrence:{kind:'interval',minutes:5}}),createdAt:clock-300001});
 await Promise.all([scoped.tickScopedRunbooks(device),scoped.tickScopedRunbooks(nested),scoped.tickScopedRunbooks(joined)]);
 check(await count('automation_runbook_schedules'),1,'one central cursor serves the whole group');check(await count('runbook_runs'),1,'racing ticks create one campaign for the due occurrence');
 const scheduledRun=await d.one(sql`SELECT id,concurrency FROM runbook_runs`);check(await count('runbook_run_devices','WHERE run_id=?',scheduledRun.id),3,'scheduled campaign includes live descendant/new membership');
 const scheduledAudits=await campaignAudits(scheduledRun.id),scheduledAt=await createdAt(scheduledRun.id);
 check(scheduledAudits.map(x=>x.server_id),[device,nested,joined].sort(),'racing ticks write exactly one audit row per target');
 check(scheduledAudits.map(({actor,action,target,scope,at})=>({actor,action,target,scope,at})),scheduledAudits.map(()=>({actor:'System',action:scheduledAction,target:'Scoped book / v1 / '+scheduledRun.id,scope:'device',at:scheduledAt})),'scheduled campaign audit is written as System');
 await scoped.tickScopedRunbooks(device);check(await count('runbook_runs'),1,'same occurrence cannot replay');check(await campaignAuditCount(),3,'a second tick for the same occurrence writes no audit');
 const next=(await d.one(sql`SELECT next_due FROM automation_runbook_schedules`)).next_due;
 await inTransaction(d,[sql`DELETE FROM mfa_accounts WHERE principal=${actor}`,sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${actor},'re-enrolled','[]',0,${clock+1})`]);
 clock=next;await scoped.tickScopedRunbooks(device);check(await count('runbook_runs'),1,'re-enrolled MFA cannot reactivate an old scheduled approval');
 check((await d.one(sql`SELECT status FROM automation_device_state WHERE server_id=${device} AND kind='runbook'`)).status,'blocked','re-enrolled approval is reported as blocked');
 await d.exec(sql`UPDATE mfa_accounts SET created_at=${mfaCreatedAt} WHERE principal=${actor}`);
 clock=next+3600001;await scoped.tickScopedRunbooks(device);check(await count('runbook_runs'),1,'outside catchup window skips execution');
 check((await d.one(sql`SELECT last_due FROM automation_runbook_schedules`)).last_due,next,'skipped occurrence still advances the durable cursor');
 await d.exec(sql`DELETE FROM automation_scope_assignments WHERE id=${scheduled.id}`);check(await count('automation_runbook_schedules'),0,'deleting assignment cleans only its central cursor');await resetWork();

 // Large fleets use a JSON-backed INSERT and one concurrency budget. The
 // existing manual API remains capped at 100, and overlarge scopes fail closed.
 const largeGroup=uuid();await d.exec(sql`INSERT INTO device_groups(id,name,description,created_at) VALUES(${largeGroup},'Large scope','',${clock})`);
 const thousand=Array.from({length:1000},()=>uuid());await addDevices(thousand,largeGroup);const large=await assign('group',largeGroup);
 const requestId=uuid();result=await scoped.startAutomationRun(owner,{assignmentId:large.id,confirm:true,requestId});check(result.targets,1000,'1000 effective targets supported without a per-device schedule');check(await count('runbook_run_devices','WHERE run_id=?',result.id),1000,'all 1000 targets freeze in one transaction');check(await count('automation_runbook_schedules'),0,'manual scoped campaign does not create 1000 schedules');
 const again=await scoped.startAutomationRun(owner,{assignmentId:large.id,confirm:true,requestId});check(again.id,result.id,'explicit requestId is idempotent');check(await count('runbook_runs'),1,'idempotent retry never replays unknown writes');
 check(again.deduplicated,true,'retry reports deduplication');check((await campaignAudits(result.id)).length,1000,'1000 targets get 1000 audit rows and the deduplicated retry adds none');
 await addDevices([uuid()],largeGroup);await rejected(()=>scoped.startAutomationRun(owner,{assignmentId:large.id,confirm:true}),'1001 targets rejected without partial splitting');check(await count('runbook_runs'),1,'1001 target attempt creates no partial campaign');check(await campaignAuditCount(),1000,'1001 target attempt writes no audit');
 await assert.rejects(()=>runbooks.startRun(owner,{versionId:version,targets:thousand.slice(0,101),parameters:{},confirm:true}),error=>error.status===400);checks++;
 await resetWork();
 // Peer scopes can no longer overlap on one device. Concurrent ticks still
 // share one schedule cursor and dispatch the device once.
 const twinGroups=[uuid(),uuid()],twinDevice=uuid();await inTransaction(d,twinGroups.map(id=>sql`INSERT INTO device_groups(id,name,description,created_at) VALUES(${id},'Twin scope','',${clock})`));
 await addDevices([twinDevice],twinGroups[0]);await assert.rejects(()=>d.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${twinDevice},${twinGroups[1]})`),error=>error.code==='23505'&&error.constraint_name==='idx_device_group_members_server');checks++;
 const firstTwin=await assign('group',twinGroups[0],{id:'00000000-0000-4000-a000-000000000002',templatePayload:payload({recurrence:{kind:'interval',minutes:5}})}),secondTwin=await assign('group',twinGroups[1],{id:'ffffffff-ffff-4fff-afff-ffffffffffff',templateId:firstTwin.templateId});clock+=300001;
 await Promise.all([scoped.tickScopedRunbooks(twinDevice),scoped.tickScopedRunbooks(twinDevice)]);
 check(await count('automation_runbook_schedules'),1,'concurrent ticks share one canonical schedule cursor');check(await count('runbook_runs'),1,'concurrent ticks never dispatch duplicate scheduled campaigns');
 check(await count('runbook_run_devices'),1,'the device is dispatched exactly once');
 check(await count('audit','WHERE action=? AND server_id=?',scheduledAction,twinDevice),1,'the twin device is audited exactly once');
 await rejected(()=>scoped.startAutomationRun(owner,{assignmentId:secondTwin.id,confirm:true}),'a peer scope without members cannot start an extra campaign');check(await count('audit','WHERE action=?',manualAction),0,'rejected peer scope start writes no audit');check(await campaignAuditCount(),1,'rejected peer scope start leaves campaign audit unchanged');
 await resetWork();
 // Scope approval A and manual executor B are separate identities. Re-enrolling
 // B's MFA must not restore old campaigns just because A's approval is intact.
 const executor={id:uuid(),label:'executor@scope.test',permissions:['*']};Object.defineProperty(executor,'authorization',{value:{authVersion:1},enumerable:false});const executorActor=access.principal(executor),executorMfaAt=clock-86400000;
 await inTransaction(d,[
  sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,must_reset,created_at,updated_at) VALUES(${executor.id},${executor.label},${executor.label},${executor.label},${executorActor},${executor.label},'active',1,0,${clock},${clock})`,
  sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${executorActor},'executor','[]',0,${executorMfaAt})`,
  sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${executor.id},${role},'global','*',${clock},${actor})`
 ]);
 const delegated=await assign('device',twinDevice);
 const reenrollExecutor=()=>inTransaction(d,[sql`DELETE FROM mfa_accounts WHERE principal=${executorActor}`,sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${executorActor},'new-executor-enrollment','[]',0,${clock+2})`]);
 beforeBatch=reenrollExecutor;await rejected(()=>scoped.startAutomationRun(executor,{assignmentId:delegated.id,confirm:true}),'distinct executor MFA re-enrollment before campaign commit');check(await count('runbook_runs'),0,'executor MFA race leaves no partial campaign');check(await campaignAuditCount(),0,'executor MFA race writes no audit');
 await d.exec(sql`UPDATE mfa_accounts SET created_at=${executorMfaAt} WHERE principal=${executorActor}`);
 result=await scoped.startAutomationRun(executor,{assignmentId:delegated.id,confirm:true});
 check(await campaignAudits(result.id),[{actor:executor.label,action:manualAction,target:'Scoped book / v1 / '+result.id,server_id:twinDevice,scope:'device',customer_id:(await d.one(sql`SELECT customer_id FROM servers WHERE id=${twinDevice}`)).customer_id,at:await createdAt(result.id)}],'device assignment start writes exactly one audit row for the executor');await runbooks.tickAutomation(twinDevice,snapshot);job=await d.one(sql`SELECT id FROM jobs WHERE server_id=${twinDevice}`);assert.ok(job);checks++;
 const executionGuard=await scoped.scopedRunbookClaimGuard(job.id,twinDevice,result.id);
 check((await d.exec(sql`UPDATE jobs SET state='running' WHERE id=${job.id} AND state='pending' AND (${executionGuard})`)).rowCount,1,'a separately approved executor can claim the current campaign');
 await reenrollExecutor();
 check(await d.one(sql`SELECT parameters FROM jobs WHERE id=${job.id} AND state='running' AND (${executionGuard})`),null,'executor B re-enrollment blocks final delivery despite intact scope approval A');
 await d.exec(sql`UPDATE jobs SET state='succeeded',result='Completed prior claimed action',result_code='AGENT_TCP_CONNECTED',result_args='{"host":"srv","port":"443"}' WHERE id=${job.id}`);await runbooks.tickAutomation(twinDevice,snapshot);
 // The step result keeps the agent's message code and arguments with its text.
 check(await d.one(sql`SELECT state,result,result_code,result_args FROM runbook_step_results WHERE job_id=${job.id}`),{state:'succeeded',result:'Completed prior claimed action',result_code:'AGENT_TCP_CONNECTED',result_args:'{"host":"srv","port":"443"}'},'a runbook step result keeps result_code and result_args');
 check(await count('jobs'),1,'withdrawn executor enrollment cannot enqueue the next step after an actual result');check((await d.one(sql`SELECT state FROM runbook_run_devices WHERE run_id=${result.id} AND server_id=${twinDevice}`)).state,'cancelled','old executor campaign remains stopped');
 clock+=3;const fresh=await scoped.startAutomationRun(executor,{assignmentId:delegated.id,confirm:true}),freshGuard=await scoped.scopedRunbookGuard(fresh.id,twinDevice);
 check(!!await d.one(sql`SELECT 1 WHERE ${freshGuard}`),true,'fresh explicit confirmation after executor enrollment permits a new campaign');
 await runbooks.tickAutomation(twinDevice,snapshot);const freshJob=await d.one(sql`SELECT id FROM jobs WHERE server_id=${twinDevice} AND id<>${job.id}`);assert.ok(freshJob);checks++;
 const freshClaim=await scoped.scopedRunbookClaimGuard(freshJob.id,twinDevice,fresh.id);await reenrollExecutor();
 check((await d.exec(sql`UPDATE jobs SET state='running' WHERE id=${freshJob.id} AND state='pending' AND (${freshClaim})`)).rowCount,0,'distinct executor re-enrollment before claim rejects the actual pending-job CAS');
 await runbooks.tickAutomation(twinDevice,snapshot);check((await d.one(sql`SELECT state FROM jobs WHERE id=${freshJob.id}`)).state,'cancelled','executor enrollment withdrawal cancels unclaimed pending work');
 await resetWork();

 // No campaign without its audit: a failing audit insert rolls the whole batch
 // back with a clear 503, and the same request succeeds once audit works again.
 const audited=await assign('group',group),failedRequest=uuid();await failAudit();
 let logged=await serverLog(()=>assert.rejects(()=>scoped.startAutomationRun(owner,{assignmentId:audited.id,confirm:true,requestId:failedRequest}),error=>error instanceof HttpError&&error.status===503&&error.messageKey===campaignFailure));checks++;
 check(logged.some(line=>line.includes('audit unavailable')),true,'the original batch error stays in the server log');
 check([await count('runbook_runs'),await count('automation_runbook_runs'),await count('runbook_run_devices'),await count('audit')],[0,0,0,0],'audit failure leaves no campaign, approval metadata, target rows or audit');
 await restoreAudit();result=await scoped.startAutomationRun(owner,{assignmentId:audited.id,confirm:true,requestId:failedRequest});
 check(result.deduplicated,false,'the same requestId starts once audit is available again');check((await campaignAudits(result.id)).length,result.targets,'the retried start audits every target');
 await d.exec(sql`DELETE FROM automation_scope_assignments WHERE id=${audited.id}`);await resetWork();

 // The same for a due schedule: the device is blocked with the message, the
 // cursor stays, and a later tick inside the catchup window starts that due.
 const recurring=await assign('group',group,{templatePayload:payload({recurrence:{kind:'interval',minutes:5}}),createdAt:clock-600000}),due=clock-1000;
 await d.exec(sql`INSERT INTO automation_runbook_schedules(assignment_id,next_due,created_at) VALUES(${recurring.id},${due},${clock-600000})`);
 await failAudit();logged=await serverLog(()=>scoped.tickScopedRunbooks(device));
 check(logged.some(line=>line.includes('audit unavailable')),true,'the scheduled batch error stays in the server log');
 check(await count('runbook_runs'),0,'scheduled audit failure starts no campaign');
 check(await d.one(sql`SELECT next_due,last_due FROM automation_runbook_schedules WHERE assignment_id=${recurring.id}`),{next_due:due,last_due:null},'scheduled audit failure keeps the cursor');
 check(await d.one(sql`SELECT status,message FROM automation_device_state WHERE server_id=${device} AND kind='runbook'`),{status:'blocked',message:campaignFailure},'scheduled audit failure blocks the device with the message');
 await restoreAudit();clock+=1000;await scoped.tickScopedRunbooks(device);
 const recovered=await d.query(sql`SELECT id FROM runbook_runs`).then(results=>({results}));check(recovered.results.length,1,'a later tick inside the catchup window starts the same due');
 check((await d.one(sql`SELECT due_key FROM runbook_runs`)).due_key,`scope:${recurring.id}:${due}`,'the recovered campaign is exactly the blocked due');
 const recoveredAudits=await campaignAudits(recovered.results[0].id);check([recoveredAudits.length,recoveredAudits.every(x=>x.actor==='System'&&x.action===scheduledAction)],[await count('runbook_run_devices'),true],'the recovered campaign audits every target as System');
 check((await d.one(sql`SELECT status FROM automation_device_state WHERE server_id=${device} AND kind='runbook'`)).status,'scheduled','the device state returns to scheduled');

 // A stored template payload that fails its schema (a ZodError) blocks the device with the invalid-schedule message.
 const invalidGroup=uuid(),invalidDevice=uuid();
 await d.exec(sql`INSERT INTO device_groups(id,name,description,parent_id,created_at) VALUES(${invalidGroup},${invalidGroup},'',NULL,${clock})`);await addDevices([invalidDevice],invalidGroup);
 await assign('group',invalidGroup,{templatePayload:payload({concurrency:99,recurrence:{kind:'interval',minutes:5}})});
 await scoped.tickScopedRunbooks(invalidDevice);
 check(await d.one(sql`SELECT status,message FROM automation_device_state WHERE server_id=${invalidDevice} AND kind='runbook'`),{status:'blocked',message:'serverMessage.automation.invalidSchedule'},'an invalid stored payload blocks the device as an invalid schedule');
 console.log(`PASS ${checks} scoped runbook checks: live inherited membership, overrides/conflicts/disabled scopes, 1000/1001 bounds, central due cursor/catchup/dedup, global concurrency, no unknown replay, RBAC/MFA/password/membership transaction races, final agent claim/delivery guards, campaign audit per device in the same batch, audit failure rollback.`);
}finally{d.close();}
