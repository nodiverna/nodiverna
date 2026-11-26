// Actual source, actual PostgreSQL transactions, isolated configuration snapshots.
// No Windows command or production database is touched by these regressions.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ts from 'typescript';
import {sql} from '../../runtime/database.mjs';

import {sourceDatabase,inTransaction} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
const require=createRequire(import.meta.url),d=await sourceDatabase(),cache=new Map(),root=process.cwd(),uuid=()=>crypto.randomUUID();
let clock=Date.now(),beforeBatch=null,beforeWrite=null,checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const HttpError=realHttpError;
// Race hooks: beforeBatch runs once before the next transaction, beforeWrite once
// before the next INSERT, UPDATE or DELETE statement.
const facade=hookDatabase(d,{
 transaction:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}},
 statement:async text=>{if(beforeWrite&&/^\s*(?:INSERT|UPDATE|DELETE)/i.test(text)){const hook=beforeWrite;beforeWrite=null;await hook();}}
});
const server={db:()=>facade,now:()=>clock,hash:async value=>crypto.createHash('sha256').update(value).digest('hex'),guid:value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value),HttpError,log:async()=>{}};
const mocks=new Map([
 ['lib/server/context.ts',server],['lib/server/identity/local-auth.ts',{}],
 ['lib/server/identity/mfa.ts',{isMfaEnabled:async viewer=>!!await d.one(sql`SELECT 1 FROM mfa_accounts WHERE principal=${viewer.principal??'private:'+viewer.label}`)}],
 ['lib/management.ts',{operations:Object.fromEntries(['refresh','scan-updates','test-connection'].map(name=>[name,{schema:{safeParse:()=>({success:true})}}]))}],
 ['lib/server/agent/agent-crypto.ts',{sealAgentSecrets:async()=>({})}]
]);
function load(filename){const absolute=path.resolve(filename),relative=path.relative(root,absolute).replaceAll('\\','/');if(mocks.has(relative))return mocks.get(relative);if(cache.has(absolute))return cache.get(absolute).exports;const mod={exports:{}};cache.set(absolute,mod);const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;new Function('require','module','exports',code)(id=>{if(id.startsWith('.')){const base=path.resolve(path.dirname(absolute),id),file=[base,base+'.ts',base+'.tsx'].find(name=>fs.existsSync(name)&&fs.statSync(name).isFile());if(file)return /[.]m?js$/.test(file)?require(file):load(file);}return require(id);},mod,mod.exports);return mod.exports;}
const scopes=load('lib/server/automation/automation-scopes.ts'),device=load('lib/server/automation/automation-device.ts'),drift=load('lib/server/automation/drift.ts'),access=load('lib/server/identity/access.ts');
try{
 const owner={id:uuid(),label:'owner@automation.test',permissions:['*']};Object.defineProperty(owner,'authorization',{value:{authVersion:1},enumerable:false});
 const actor=access.principal(owner),role=uuid(),group=uuid(),child=uuid(),peer=uuid(),source=uuid(),target=uuid(),nested=uuid(),joined=uuid();
 const snapshot={os:'Windows Server 2025',protocolVersion:3,mode:'Management',management:true,agentCapabilities:['desired-state-test']};
 await inTransaction(d,[
  sql`INSERT INTO local_users(id,username,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at) VALUES(${owner.id},${'owner'},${'Owner'},${actor},${owner.label},'active',1,${clock},${clock})`,
  sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${actor},'fixture','[]',0,${clock-86400000})`,
  sql`INSERT INTO rbac_roles(id,name,permissions,created_at) VALUES(${role},'Owner','["*"]',${clock})`,
  sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${owner.id},${role},'global','*',${clock},${actor})`,
  ...[[group,null],[child,group],[peer,null]].map(([id,parent])=>sql`INSERT INTO device_groups(id,name,parent_id,description,created_at) VALUES(${id},${id},${parent},'',${clock})`),
  ...[source,target,nested,joined].map(id=>sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen,management,snapshot) VALUES(${id},${id},${id},${clock},${clock},1,${JSON.stringify(snapshot)})`),
  sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${target},${group})`,sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${nested},${child})`
 ]);
 const policy=await drift.setDriftPolicy(owner,source,{enabled:true,paths:[{path:'C:\\Config'}]});
 const entry={key:'file:c:\\config\\app.txt',kind:'file',path:'C:\\Config\\app.txt',hash:'a'.repeat(64),size:10};
 await drift.ingestDrift(source,{policyId:policy.policyId,version:policy.version,scanId:uuid(),at:clock,complete:true,entries:[entry],errors:[]});
 const baseline=await scopes.createAutomationTemplate(owner,{kind:'drift',name:'OS Baseline',sourceServerId:source});
 // A source policy saved before the exclude limits is a clear 409, not a validation crash.
 const savedPolicy=(await d.one(sql`SELECT policy FROM drift_policies WHERE server_id=${source}`)).policy;
 await d.exec(sql`UPDATE drift_policies SET policy=jsonb_set(policy::jsonb,'{excludes}',${JSON.stringify(['*'+'A'.repeat(247)+'B*'])}::jsonb)::text WHERE server_id=${source}`);
 check(await scopes.createAutomationTemplate(owner,{kind:'drift',name:'Legacy',sourceServerId:source}).then(()=>'created',error=>error.status+' '+error.message),'409 '+serverText('apiError.drift.policyNeedsFix'),'a legacy source policy is rejected with a clear message');
 await d.exec(sql`UPDATE drift_policies SET policy=${savedPolicy} WHERE server_id=${source}`);
 await scopes.assignAutomationScope(owner,{templateId:baseline.id,scopeType:'group',scopeId:group,confirm:true});
 await device.reconcileDeviceAutomation(target);await device.reconcileDeviceAutomation(nested);
 let materialized=await d.one(sql`SELECT id,version,policy FROM drift_policies WHERE server_id=${target}`);
 check(materialized.version,1,'first inherited policy is materialized once');
 check((await d.one(sql`SELECT entries FROM drift_baselines WHERE server_id=${target}`)).entries,JSON.stringify([entry]),'shared baseline is copied from the approved complete reference scan');
 check((await d.one(sql`SELECT status FROM automation_device_state WHERE server_id=${target}`)).status,'applied','actual state records successful materialization');
 await device.reconcileDeviceAutomation(target);check((await d.one(sql`SELECT version FROM drift_policies WHERE server_id=${target}`)).version,1,'unchanged approval never bumps policy version or baseline');
 await d.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${joined},${child})`);await device.reconcileDeviceAutomation(joined);
 check((await d.one(sql`SELECT count(*) AS n FROM drift_policies WHERE server_id=${joined}`)).n,1,'future descendant membership inherits without another assignment');
 let report=await drift.ingestDrift(target,{policyId:materialized.id,version:materialized.version,scanId:uuid(),at:clock,complete:true,entries:[entry],errors:[]});check(report.state,'in_sync','target scan compares against shared reference baseline');
 clock+=30000;report=await drift.ingestDrift(target,{policyId:materialized.id,version:materialized.version,scanId:uuid(),at:clock,complete:true,entries:[{...entry,hash:'b'.repeat(64)}],errors:[]});check(report.state,'drifted','reference differences are detected on other devices');
 const other=await scopes.createAutomationTemplate(owner,{kind:'drift',name:'Child Baseline',sourceServerId:source});
 await scopes.assignAutomationScope(owner,{templateId:other.id,scopeType:'group',scopeId:child,confirm:true});
 check((await scopes.effectiveAutomationForDevice(nested,'drift'))[0].templateId,other.id,'deepest descendant overrides root baseline');
 await scopes.assignAutomationScope(owner,{templateId:baseline.id,scopeType:'device',scopeId:nested,confirm:true});check((await scopes.effectiveAutomationForDevice(nested,'drift'))[0].templateId,baseline.id,'explicit device assignment overrides child');
 check(await d.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${target},${peer})`).then(()=>'inserted',error=>error.code==='23505'&&error.constraint_name==='idx_device_group_members_server'?'rejected':error.message),'rejected','a device cannot join a second, equally specific group');const peerAssignment=await scopes.assignAutomationScope(owner,{templateId:other.id,scopeType:'group',scopeId:peer,confirm:true});
 await device.reconcileDeviceAutomation(target);check((await d.one(sql`SELECT enabled FROM drift_policies WHERE server_id=${target}`)).enabled,1,'a peer group template never reaches a device of another group');check((await scopes.effectiveAutomationForDevice(target,'drift'))[0].templateId,baseline.id,'the device keeps its own group template');
 await scopes.removeAutomationScope(owner,{assignmentId:peerAssignment.id,confirm:true});await device.reconcileDeviceAutomation(target);
 materialized=await d.one(sql`SELECT id,version,policy FROM drift_policies WHERE server_id=${target}`);
 await drift.setDriftEnabled(owner,target,false,materialized.version);await device.reconcileDeviceAutomation(target);
 check((await d.one(sql`SELECT enabled FROM drift_policies WHERE server_id=${target}`)).enabled,0,'local pause remains paused at the next heartbeat');check((await d.one(sql`SELECT status FROM automation_device_state WHERE server_id=${target}`)).status,'local_override','local edits are identified');
 await scopes.assignAutomationScope(owner,{templateId:baseline.id,scopeType:'device',scopeId:target,confirm:true});
 await device.reconcileDeviceAutomation(target);materialized=await d.one(sql`SELECT id,version FROM drift_policies WHERE server_id=${target}`);
 const oldBaselines=(await d.one(sql`SELECT count(*) AS n FROM drift_baselines WHERE server_id=${target}`)).n;
 await scopes.assignAutomationScope(owner,{templateId:other.id,scopeType:'device',scopeId:target,confirm:true});
 beforeBatch=()=>d.exec(sql`UPDATE drift_policies SET version=version+1,updated_by=${'another-writer'} WHERE server_id=${target}`);
 await device.reconcileDeviceAutomation(target);
 check((await d.one(sql`SELECT count(*) AS n FROM drift_baselines WHERE server_id=${target}`)).n,oldBaselines,'failed policy CAS never appends a baseline to another writer\'s N+1 policy');
 check((await d.one(sql`SELECT version,updated_by FROM drift_policies WHERE server_id=${target}`)).updated_by,'another-writer','the concurrent manual policy is preserved');
 const templatesBefore=(await d.one(sql`SELECT count(*) AS n FROM automation_templates`)).n;
 beforeWrite=()=>d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${owner.id}`);await assert.rejects(scopes.createAutomationTemplate(owner,{kind:'drift',name:'Revoked reference',sourceServerId:source}),e=>e.status===409);checks++;
 check((await d.one(sql`SELECT count(*) AS n FROM automation_templates`)).n,templatesBefore,'revoked reference/account rights cannot commit a copied baseline');await d.exec(sql`UPDATE local_users SET status='active' WHERE id=${owner.id}`);
 beforeWrite=()=>d.exec(sql`UPDATE drift_policies SET version=version+1 WHERE server_id=${source}`);await assert.rejects(scopes.createAutomationTemplate(owner,{kind:'drift',name:'Stale reference',sourceServerId:source}),e=>e.status===409);checks++;
 check((await d.one(sql`SELECT count(*) AS n FROM automation_templates`)).n,templatesBefore,'reference policy changed before commit rejects template');
 const config=uuid(),version=uuid();await inTransaction(d,[sql`INSERT INTO desired_configs(id,name,description,created_by,created_at) VALUES(${config},'OS Desired','',${actor},${clock})`,sql`INSERT INTO desired_versions(id,config_id,version,engine,content,sha256,created_by,created_at) VALUES(${version},${config},1,'dsc-v3-json','{}',${'c'.repeat(64)},${actor},${clock})`]);
 const desired=await scopes.createAutomationTemplate(owner,{kind:'desired',name:'Desired OS',versionId:version,intervalSeconds:900});await scopes.assignAutomationScope(owner,{templateId:desired.id,scopeType:'group',scopeId:group,confirm:true});await device.reconcileDeviceAutomation(nested);
 let desiredRow=await d.one(sql`SELECT id,version_id,interval_seconds,enabled FROM desired_assignments WHERE server_id=${nested}`);check(desiredRow.version_id,version,'desired version materializes on a descendant');check(desiredRow.interval_seconds,900,'explicit approved system-check interval is inherited');
 await device.reconcileDeviceAutomation(nested);check((await d.one(sql`SELECT id FROM desired_assignments WHERE server_id=${nested}`)).id,desiredRow.id,'desired assignment is stable across heartbeats');
 await d.exec(sql`UPDATE desired_assignments SET enabled=0,interval_seconds=0 WHERE id=${desiredRow.id}`);await device.reconcileDeviceAutomation(nested);check((await d.one(sql`SELECT enabled FROM desired_assignments WHERE id=${desiredRow.id}`)).enabled,0,'local desired removal is not automatically re-enabled');
 const paused=await scopes.assignAutomationScope(owner,{templateId:desired.id,scopeType:'device',scopeId:joined,disabled:true,confirm:true});await device.reconcileDeviceAutomation(joined);check((await d.one(sql`SELECT count(*) AS n FROM desired_assignments WHERE server_id=${joined}`)).n,0,'explicit device exclusion blocks inherited desired checks');
 await scopes.removeAutomationScope(owner,{assignmentId:paused.id,confirm:true});await device.reconcileDeviceAutomation(joined);check((await d.one(sql`SELECT enabled FROM desired_assignments WHERE server_id=${joined}`)).enabled,1,'removing exclusion restores inherited desired choice');
 await scopes.assignAutomationScope(owner,{templateId:baseline.id,scopeType:'device',scopeId:target,confirm:true});await device.reconcileDeviceAutomation(target);
 const beforePause=await d.one(sql`SELECT id,version FROM drift_policies WHERE server_id=${target}`),baselineCount=(await d.one(sql`SELECT count(*) AS n FROM drift_baselines WHERE server_id=${target}`)).n;
 await scopes.assignAutomationScope(owner,{templateId:other.id,scopeType:'device',scopeId:target,confirm:true});
 beforeBatch=()=>drift.setDriftEnabled(owner,target,false,beforePause.version);await device.reconcileDeviceAutomation(target);
 check((await d.one(sql`SELECT enabled,version FROM drift_policies WHERE server_id=${target}`)),{enabled:0,version:beforePause.version},'a concurrent local pause without a version bump survives inherited policy commit');
 check((await d.one(sql`SELECT count(*) AS n FROM drift_baselines WHERE server_id=${target}`)).n,baselineCount,'a concurrent pause cannot install a new baseline');
 desiredRow=await d.one(sql`SELECT id FROM desired_assignments WHERE server_id=${joined}`);
 await scopes.assignAutomationScope(owner,{templateId:desired.id,scopeType:'device',scopeId:joined,confirm:true});
 beforeBatch=()=>d.exec(sql`UPDATE desired_assignments SET enabled=0,interval_seconds=0 WHERE id=${desiredRow.id}`);await device.reconcileDeviceAutomation(joined);
 check((await d.one(sql`SELECT id,enabled,interval_seconds FROM desired_assignments WHERE server_id=${joined}`)),{id:desiredRow.id,enabled:0,interval_seconds:0},'a concurrent local desired pause or schedule edit cannot be re-enabled by materialization');
 await scopes.assignAutomationScope(owner,{templateId:desired.id,scopeType:'device',scopeId:joined,confirm:true});await device.reconcileDeviceAutomation(joined);
 await d.exec(sql`UPDATE mfa_accounts SET created_at=${clock+1} WHERE principal=${actor}`);await device.reconcileDeviceAutomation(joined);check((await d.one(sql`SELECT enabled FROM desired_assignments WHERE server_id=${joined}`)).enabled,0,'new MFA enrollment invalidates existing automatic approvals');
 check(await scopes.automationAssignmentActor((await scopes.effectiveAutomationForDevice(joined,'desired'))[0],joined),null,'old approvals do not re-arm after MFA replacement');
 const list=await scopes.listAutomationScopes(owner);check(list.templates.find(t=>t.id===baseline.id).payload.baseline,undefined,'catalog never includes copied reference file contents');check(list.templates.find(t=>t.id===baseline.id).payload.hasBaseline,true,'catalog displays baseline availability');
 // The Schedules tab reads the next run of a runbook assignment with a recurrence: null until the first evaluation
 // writes the cursor row, then automation_runbook_schedules.next_due. Drift and desired assignments carry null.
 const recurring=uuid(),recurringAssignment=uuid();
 await inTransaction(d,[
  sql`INSERT INTO automation_templates(id,kind,slot,name,payload,created_by,created_at) VALUES(${recurring},'runbook',${'book-'+recurring},'Nightly',${JSON.stringify({versionId:uuid(),recurrence:{kind:'interval',minutes:60}})},${actor},${clock})`,
  sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,disabled,actor,auth_version,created_at) VALUES(${recurringAssignment},'runbook',${'book-'+recurring},'group',${peer},${recurring},0,${actor},1,${clock})`
 ]);
 let next=(await scopes.listAutomationScopes(owner)).assignments;
 check(next.find(a=>a.id===recurringAssignment).nextDue,null,'a runbook assignment has no next run before its first evaluation');
 check([...new Set(next.filter(a=>a.kind!=='runbook').map(a=>a.nextDue))],[null],'drift and desired assignments carry no next run');
 await d.exec(sql`INSERT INTO automation_runbook_schedules(assignment_id,next_due,created_at) VALUES(${recurringAssignment},${clock+3600000},${clock})`);
 next=(await scopes.listAutomationScopes(owner)).assignments;
 check(next.find(a=>a.id===recurringAssignment).nextDue,clock+3600000,'after the evaluation the next run is the cursor of automation_runbook_schedules');
 console.log(`PASS: ${checks} actual database automation checks: inherited drift baselines/DSC, conflicts/overrides/new members, local pauses, MFA replacement, source-revocation and competing-policy CAS races.`);
}finally{d.close();}
