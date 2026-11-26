// The stored result and verdict of a Desired-State assignment outlive job
// retention: real lib/server/automation/desired-state.ts and lib/server/identity/access.ts with an Owner, the real
// result writer, the real maintenance command and the real device component.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {sql} from '../../runtime/database.mjs';

import {createStorage} from '../../runtime/storage.mjs';
import {runMaintenance} from '../../scripts/selfhost.mjs';
import {sourceDatabase,inTransaction,idents} from '../support/source-database.mjs';
const require=createRequire(import.meta.url),d=await sourceDatabase(),root=process.cwd(),uuid=()=>crypto.randomUUID(),day=86400000;
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'serverdesk-desired-status-'));
const clock=Date.now();let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const HttpError=realHttpError;
const server={db:()=>d,now:()=>clock,config:()=>'',hash:async value=>crypto.createHash('sha256').update(value).digest('hex'),guid:value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value),HttpError,log:async()=>{}};
const mocks=new Map([
 ['lib/server/context.ts',server],['lib/server/identity/local-auth.ts',{}],
 ['lib/server/identity/mfa.ts',{isMfaEnabled:async viewer=>!!await d.one(sql`SELECT 1 FROM mfa_accounts WHERE principal=${viewer.principal??'private:'+viewer.label}`)}],
 ['lib/server/agent/agent-crypto.ts',{sealAgentSecrets:async()=>({key:'fixture',iv:'fixture',data:'fixture',mac:'fixture'})}]
]),cache=new Map();
function load(filename){
 const absolute=path.resolve(filename),relative=path.relative(root,absolute).replaceAll('\\','/');if(mocks.has(relative))return mocks.get(relative);if(absolute.endsWith('.css'))return {};if(cache.has(absolute))return cache.get(absolute).exports;
 const loaded={exports:{}};cache.set(absolute,loaded);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const localRequire=id=>{if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),file=[base,base+'.ts',base+'.tsx',base+'/index.ts'].find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isFile());if(file)return /[.]m?js$/.test(file)?require(file):load(file);}return require(id);};
 new Function('require','module','exports',code)(localRequire,loaded,loaded.exports);return loaded.exports;
}
const desired=load('lib/server/automation/desired-state.ts'),access=load('lib/server/identity/access.ts'),writer=load('lib/server/automation/desired-state-result.ts'),ui=load('ui/automation/desired-state-ui.ts'),views=load('ui/automation/desired-state-components.tsx');
const columns='last_job_id,last_result_state,last_result_at,last_compliant,last_compliant_at';
try{
 const storage=createStorage({OBJECT_STORAGE_DRIVER:'filesystem',OBJECT_STORAGE_PATH:path.join(directory,'objects')});
 const owner={id:uuid(),label:'owner@status.test',principal:'private:owner@status.test',permissions:['*']};Object.defineProperty(owner,'authorization',{value:{authVersion:1},enumerable:false});
 const actor=access.principal(owner),role=uuid(),config=uuid(),version=uuid(),manual=uuid(),periodic=uuid();
 const snapshot={os:'Windows 11',protocolVersion:3,agentVersion:'4.6.3',agentCapabilities:['desired-state-test','desired-state-apply'],mode:'Management',management:true};
 const content=JSON.stringify({resources:[]}),digest=await server.hash(content);
 await inTransaction(d,[
  sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,must_reset,created_at,updated_at) VALUES(${owner.id},${owner.label},${owner.label},${owner.label},${actor},${owner.label},'active',1,0,${clock},${clock})`,
  sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${actor},'fixture','[]',0,${clock-day})`,
  sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${role},'Owner','','["*"]',0,${clock})`,
  sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${owner.id},${role},'global','*',${clock},${actor})`,
  ...[[manual,'Manual device'],[periodic,'Periodic device']].map(([id,name])=>sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen,snapshot,management) VALUES(${id},${name},${'fixture-'+id},${clock},${clock},${JSON.stringify(snapshot)},1)`),
  sql`INSERT INTO desired_configs(id,name,description,created_by,created_at) VALUES(${config},'Baseline','',${actor},${clock-60*day})`,
  sql`INSERT INTO desired_versions(id,config_id,version,engine,content,sha256,parameters,source,created_at,created_by) VALUES(${version},${config},1,'dsc3',${content},${digest},'{}','{}',${clock-60*day},${actor})`
 ]);
 // Both assignments through the real assignment path: manual (interval 0) and periodic.
 await desired.assignDesiredState(owner,{targets:[manual],versionId:version,intervalSeconds:0});
 await desired.assignDesiredState(owner,{targets:[periodic],versionId:version,intervalSeconds:900,confirmSystem:true});
 const assignmentOf=serverId=>d.one(sql`SELECT * FROM desired_assignments WHERE server_id=${serverId}`);
 const status=id=>d.one(sql`SELECT ${idents(columns)} FROM desired_assignments WHERE id=${id}`);
 const manualAssignment=await assignmentOf(manual),periodicAssignment=await assignmentOf(periodic);
 check(await status(manualAssignment.id),{last_job_id:null,last_result_state:null,last_result_at:null,last_compliant:null,last_compliant_at:null},'a new assignment starts without status');

 // One result written through the channel's SQL path: output, the real status writer, job state, one transaction.
 async function result(serverId,assignment,{ok,data,at,operation='test'}){
  const jobId=uuid();
  await inTransaction(d,[
   sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,claimed_at,last_progress,actor,actor_email,actor_principal,parameters) VALUES(${jobId},${serverId},${'desired-state-'+operation},'fixture','running',${at-2000},${at-2000},${at-2000},${owner.id},${owner.label},${owner.principal},'{}')`,
   sql`INSERT INTO desired_runs(id,assignment_id,server_id,version_id,job_id,operation,created_at,created_by) VALUES(${uuid()},${assignment.id},${serverId},${assignment.version_id},${jobId},${operation},${at-2000},${actor})`
  ]);
  const active=sql`EXISTS (SELECT 1 FROM servers WHERE id=${serverId} AND revoked=0)`;
  await inTransaction(d,[
   ...(data!==undefined?[sql`INSERT INTO job_outputs (job_id,server_id,data,created_at) SELECT ${jobId},${serverId},${JSON.stringify(data)},${at} WHERE EXISTS (SELECT 1 FROM jobs WHERE id=${jobId} AND server_id=${serverId} AND state='running') AND ${active} ON CONFLICT(job_id) DO NOTHING`]:[]),
   writer.desiredResultStatement({jobId,serverId,ok,data,time:at}),
   sql`UPDATE jobs SET state=${ok?'succeeded':'failed'},result=${ok?'Konform':'Fehlgeschlagen'},parameters='{}',last_progress=${at} WHERE id=${jobId} AND server_id=${serverId} AND state='running' AND ${active}`
  ]);
  return jobId;
 }
 const old=clock-40*day,checkedAt=old;
 await result(manual,manualAssignment,{ok:true,data:{engine:'dsc3',compliant:true,checkedAt:new Date(old).toISOString(),resources:[{name:'Folder',type:'File',inDesiredState:true,differingProperties:[]}]},at:old});
 await result(periodic,periodicAssignment,{ok:true,data:{engine:'dsc3',compliant:false},at:old});
 // The periodic assignment was last queued a minute ago; deleting jobs must not make it due.
 await d.exec(sql`UPDATE desired_assignments SET last_checked_at=${clock-60000} WHERE id=${periodicAssignment.id}`);
 const stored=await status(manualAssignment.id),storedPeriodic=await status(periodicAssignment.id);
 check(stored,{last_job_id:stored.last_job_id,last_result_state:'succeeded',last_result_at:old,last_compliant:1,last_compliant_at:old},'the compliant result is stored on the assignment');
 const before=await desired.listDesiredState(owner);
 check(before.assignments.find(a=>a.id===manualAssignment.id).latestComplianceRun?.data?.compliant,true,'control: before maintenance the run is still listed');

 // Maintenance deletes all jobs and outputs older than 30 days.
 await runMaintenance(d,storage,{now:clock,retention:{auditDays:30,jobDays:30}});
 check((await d.one(sql`SELECT count(*) AS n FROM jobs`)).n,0,'all jobs are deleted');
 check((await d.one(sql`SELECT count(*) AS n FROM job_outputs`)).n,0,'all outputs are deleted');
 check(await status(manualAssignment.id),stored,'the manual assignment\'s five columns are unchanged by maintenance');
 check(await status(periodicAssignment.id),storedPeriodic,'the periodic assignment\'s five columns are unchanged by maintenance');

 // The API reads the stored values from the assignment row.
 let data=await desired.listDesiredState(owner);let api=data.assignments.find(a=>a.id===manualAssignment.id);
 check({lastJobId:api.lastJobId,lastResultState:api.lastResultState,lastResultAt:api.lastResultAt,lastCompliant:api.lastCompliant,lastCompliantAt:api.lastCompliantAt},{lastJobId:stored.last_job_id,lastResultState:'succeeded',lastResultAt:old,lastCompliant:true,lastCompliantAt:checkedAt},'listDesiredState returns the stored status without any job');
 check([api.latestRun,api.latestComplianceRun],[null,null],'the run summaries are gone with their jobs');
 check(data.runs.filter(run=>run.assignmentId===manualAssignment.id),[],'no run of this assignment is listed');
 check(data.assignments.find(a=>a.id===periodicAssignment.id).lastCompliant,false,'a stored false verdict is returned as false');
 const configs=data.configs,render=(assignment,runs)=>renderToStaticMarkup(React.createElement(load('ui/base/locale.tsx').LocaleProvider,{locale:'de'},React.createElement(views.DesiredDeviceState,{assignment,configs,runs,deviceName:'VM-01',connected:true})));
 let html=render(api,[]);
 assert.match(html,/<dt>Letztes Prüfergebnis<\/dt><dd>Erfüllt<small>/,'the last check result shows Erfüllt after retention');checks++;
 assert.doesNotMatch(html,/Noch nicht geprüft/);assert.doesNotMatch(html,/Noch kein erfolgreiches Ergebnis/);checks+=2;
 assert.match(html,/sdx-pill-success"><i aria-hidden="true"><\/i>Erfüllt</,'the badge shows the stored verdict');checks++;
 assert.doesNotMatch(html,/Managed folder|Ressourcen ·/,'resource details are not shown once the run is gone');checks++;
 const state=ui.desiredAssignmentRuns(api,[],'de');check([state.compliant,state.compliantAt,state.status],[true,checkedAt,{label:'Erfüllt',tone:'good'}],'desiredAssignmentRuns falls back to the stored values');

 // A later failed run is still present while the compliant run is gone.
 await result(manual,manualAssignment,{ok:false,data:{error:'DSC fehlt'},at:clock-day});
 check(await status(manualAssignment.id),{...stored,last_job_id:(await status(manualAssignment.id)).last_job_id,last_result_state:'failed',last_result_at:clock-day},'the failure is stored, the verdict stays');
 data=await desired.listDesiredState(owner);api=data.assignments.find(a=>a.id===manualAssignment.id);
 check([api.latestRun?.state,api.latestComplianceRun],['failed',null],'the failed run is listed, no compliance run');
 html=render(api,data.runs);
 assert.match(html,/sdx-pill-critical"><i aria-hidden="true"><\/i>Fehlgeschlagen</,'the failed badge comes from the run');checks++;
 assert.match(html,/<dt>Letztes Prüfergebnis<\/dt><dd>Erfüllt<small>/,'the last check result still shows the stored verdict');checks++;
 assert.match(html,/role="alert"/,'the failed banner comes from the run');checks++;

 // Due checks still come from last_checked_at and interval_seconds only.
 await desired.advanceDesiredState(periodic);
 check((await d.one(sql`SELECT count(*) AS n FROM jobs WHERE server_id=${periodic}`)).n,0,'a recently queued periodic check is not due after jobs were deleted');
 await d.exec(sql`UPDATE desired_assignments SET last_checked_at=${clock-901000} WHERE id=${periodicAssignment.id}`);
 await desired.advanceDesiredState(periodic);
 check((await d.one(sql`SELECT count(*) AS n FROM jobs WHERE server_id=${periodic} AND action='desired-state-test' AND state='pending'`)).n,1,'control: once the interval has passed the check is queued');
 check(await status(periodicAssignment.id),storedPeriodic,'queueing a check leaves the stored status alone');
 await d.exec(sql`UPDATE jobs SET state='cancelled' WHERE server_id=${periodic}`);

 // An interval change keeps the status, removal keeps it, a re-assignment resets it.
 await desired.updateDesiredSchedule(owner,{assignmentId:periodicAssignment.id,versionId:version,intervalSeconds:0,expectedIntervalSeconds:900});
 check((await assignmentOf(periodic)).interval_seconds,0,'the interval changed');check(await status(periodicAssignment.id),storedPeriodic,'updateDesiredSchedule keeps the five columns');
 const kept=await status(manualAssignment.id);
 await desired.removeDesiredAssignment(owner,manualAssignment.id);
 check((await assignmentOf(manual)).enabled,0,'the assignment is removed');check(await status(manualAssignment.id),kept,'removeDesiredAssignment keeps the five columns');
 await desired.assignDesiredState(owner,{targets:[manual],versionId:version,intervalSeconds:0});
 const reassigned=await assignmentOf(manual);
 assert.notEqual(reassigned.id,manualAssignment.id,'the re-assignment has a new id');checks++;
 check(await status(reassigned.id),{last_job_id:null,last_result_state:null,last_result_at:null,last_compliant:null,last_compliant_at:null},'assignDesiredState resets the five columns on the new id');
 api=(await desired.listDesiredState(owner)).assignments.find(a=>a.id===reassigned.id);
 check([api.lastResultState,api.lastCompliant,ui.desiredAssignmentRuns(api,[],'de').status.label],[null,null,'Noch nicht geprüft'],'a fresh assignment shows no inherited verdict');
 await desired.deleteDesiredConfiguration(owner,{configId:config,confirmDelete:true});
 check(await status(periodicAssignment.id),storedPeriodic,'deleteDesiredConfiguration keeps the five columns');
 console.log(`PASS ${checks} Desired-State retention checks: stored result and verdict survive maintenance, API and device view fall back to them, due calculation unchanged, reset only on re-assignment.`);
}finally{d.close();fs.rmSync(directory,{recursive:true,force:true});}
