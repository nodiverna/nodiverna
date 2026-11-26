// Real database checks for automatic Desired-State provenance at admission,
// atomic agent claim and final parameter delivery; no HTTP/database mocks.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ts from 'typescript';
import {compile,sql} from '../../runtime/database.mjs';

import {sourceDatabase,inTransaction,idents} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
const require=createRequire(import.meta.url),d=await sourceDatabase(),cache=new Map(),root=process.cwd(),uuid=()=>crypto.randomUUID();
const clock=Date.now();let beforeBatch=null,checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const HttpError=realHttpError;
const facade=hookDatabase(d,{transaction:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}}});
// config reads settings, so a case can configure the authenticated GitHub import.
const settings={},server={db:()=>facade,now:()=>clock,config:key=>settings[key]??'',hash:async value=>crypto.createHash('sha256').update(value).digest('hex'),guid:value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value),HttpError,log:async()=>{}};
const mocks=new Map([
 ['lib/server/context.ts',server],['lib/server/identity/local-auth.ts',{}],
 ['lib/server/identity/mfa.ts',{isMfaEnabled:async viewer=>!!await d.one(sql`SELECT 1 FROM mfa_accounts WHERE principal=${viewer.principal??'private:'+viewer.label}`)}],
 ['lib/management.ts',{operations:Object.fromEntries(['refresh','scan-updates','test-connection'].map(name=>[name,{schema:{safeParse:()=>({success:true})}}]))}],
 ['lib/server/agent/agent-crypto.ts',{sealAgentSecrets:async()=>({key:'fixture',iv:'fixture',data:'fixture',mac:'fixture'})}]
]);
function load(filename){
 const absolute=path.resolve(filename),relative=path.relative(root,absolute).replaceAll('\\','/');if(mocks.has(relative))return mocks.get(relative);if(cache.has(absolute))return cache.get(absolute).exports;
 const loaded={exports:{}};cache.set(absolute,loaded);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const localRequire=id=>{if(id.startsWith('.')){const base=path.resolve(path.dirname(absolute),id),file=[base,base+'.ts',base+'.tsx'].find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isFile());if(file)return /[.]m?js$/.test(file)?require(file):load(file);}return require(id);};
 new Function('require','module','exports',code)(localRequire,loaded,loaded.exports);return loaded.exports;
}
const desired=load('lib/server/automation/desired-state.ts'),automation=load('lib/server/automation/automation-device.ts'),scopes=load('lib/server/automation/automation-scopes.ts'),access=load('lib/server/identity/access.ts');
try{
 const owner={id:uuid(),label:'owner@desired.test',permissions:['*']};Object.defineProperty(owner,'authorization',{value:{authVersion:1},enumerable:false});
 const actor=access.principal(owner),role=uuid(),group=uuid(),child=uuid(),peer=uuid(),device=uuid(),config=uuid(),version=uuid(),otherVersion=uuid(),template=uuid(),otherTemplate=uuid(),source=uuid(),mfaCreatedAt=clock-86400000;
 const snapshot={os:'Windows 11',protocolVersion:3,agentVersion:'4.6.3',agentCapabilities:['desired-state-test','desired-state-apply'],mode:'Management',management:true};
 const content=JSON.stringify({resources:[{name:'Folder',type:'File',properties:{path:'C:\\Managed'}}]}),digest=await server.hash(content);
 const payload={versionId:version,intervalSeconds:300};
 await inTransaction(d,[
  sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,must_reset,created_at,updated_at) VALUES(${owner.id},${owner.label},${owner.label},${owner.label},${actor},${owner.label},'active',1,0,${clock},${clock})`,
  sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${actor},'fixture','[]',0,${mfaCreatedAt})`,
  sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${role},'Owner','','["*"]',0,${clock})`,
  sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${owner.id},${role},'global','*',${clock},${actor})`,
  ...[[group,null],[child,group],[peer,null]].map(([id,parent])=>sql`INSERT INTO device_groups(id,name,description,parent_id,created_at) VALUES(${id},${id},'',${parent},${clock})`),
  sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen,snapshot,management) VALUES(${device},'Desired device','fixture',${clock},${clock},${JSON.stringify(snapshot)},1)`,
  sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${device},${child})`,
  sql`INSERT INTO desired_configs(id,name,description,created_by,created_at) VALUES(${config},'Desired config','',${actor},${clock})`,
  ...[[version,1],[otherVersion,2]].map(([id,n])=>sql`INSERT INTO desired_versions(id,config_id,version,engine,content,sha256,parameters,source,created_at,created_by) VALUES(${id},${config},${n},'dsc3',${content},${digest},'{}','{}',${clock},${actor})`),
  ...[[template,payload],[otherTemplate,{...payload,versionId:otherVersion}]].map(([id,p])=>sql`INSERT INTO automation_templates(id,kind,slot,name,payload,created_by,created_at) VALUES(${id},'desired','default','Desired template',${JSON.stringify(p)},${actor},${clock})`),
  sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,actor,auth_version,created_at) VALUES(${source},'desired','default','group',${group},${template},${actor},1,${clock})`
 ]);
 const count=async table=>Number((await d.one(sql`SELECT count(*) AS n FROM ${sql.ident(table)}`)).n);
 const clearJobs=()=>inTransaction(d,[sql`DELETE FROM desired_runs`,sql`DELETE FROM jobs`,sql`UPDATE desired_assignments SET last_checked_at=NULL`]);
 const pending=()=>d.one(sql`SELECT id,server_id,action,actor_email,actor_principal,parameters FROM jobs WHERE server_id=${device}`);
 const admits=async guard=>!!await d.one(sql`SELECT 1 FROM jobs WHERE server_id=${device} AND (${guard})`);
 const local=()=>d.one(sql`SELECT * FROM desired_assignments WHERE server_id=${device}`);
 await automation.reconcileDeviceAutomation(device);const assignment=await local();assert.ok(assignment);checks++;
 await desired.advanceDesiredState(device);let job=await pending();assert.ok(job);checks++;
 check(JSON.parse(job.parameters).automationApproval.id,source,'automatic inherited check retains immutable source approval');
 check(await desired.checkPendingDesiredJob(job),true,'valid inherited approval passes preflight');
 const initial=await desired.desiredJobClaimGuard(job.id,device);check(await admits(initial),true,'valid inherited approval permits final claim');
 const unchanged=assignment.id;

 // Mutate the scope after reconciliation/queueing and after guard construction.
 // The old local assignment stays enabled, so only the live source fence stops it.
 for(const [label,change,restore] of[
  ['removed source',()=>d.exec(sql`DELETE FROM automation_scope_assignments WHERE id=${source}`),()=>d.exec(sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,actor,auth_version,created_at) VALUES(${source},'desired','default','group',${group},${template},${actor},1,${clock})`)],
  ['replaced source',()=>d.exec(sql`UPDATE automation_scope_assignments SET template_id=${otherTemplate} WHERE id=${source}`),()=>d.exec(sql`UPDATE automation_scope_assignments SET template_id=${template} WHERE id=${source}`)],
  ['disabled source',()=>d.exec(sql`UPDATE automation_scope_assignments SET disabled=1 WHERE id=${source}`),()=>d.exec(sql`UPDATE automation_scope_assignments SET disabled=0 WHERE id=${source}`)],
  ['membership removed',()=>d.exec(sql`DELETE FROM device_group_members WHERE server_id=${device}`),()=>d.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${device},${child})`)],
  ['password reset',()=>d.exec(sql`UPDATE local_users SET auth_version=2 WHERE id=${owner.id}`),()=>d.exec(sql`UPDATE local_users SET auth_version=1 WHERE id=${owner.id}`)],
  ['MFA removed',()=>d.exec(sql`DELETE FROM mfa_accounts WHERE principal=${actor}`),()=>d.exec(sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${actor},'fixture','[]',0,${mfaCreatedAt})`)],
  ['MFA recreated',()=>d.exec(sql`UPDATE mfa_accounts SET created_at=${clock+1} WHERE principal=${actor}`),()=>d.exec(sql`UPDATE mfa_accounts SET created_at=${mfaCreatedAt} WHERE principal=${actor}`)],
  ['role revoked',()=>d.exec(sql`UPDATE rbac_roles SET permissions='[]' WHERE id=${role}`),()=>d.exec(sql`UPDATE rbac_roles SET permissions='["*"]' WHERE id=${role}`)],
  ['local schedule paused',()=>d.exec(sql`UPDATE desired_assignments SET interval_seconds=0 WHERE id=${unchanged}`),()=>d.exec(sql`UPDATE desired_assignments SET interval_seconds=300 WHERE id=${unchanged}`)],
  ['local assignment disabled',()=>d.exec(sql`UPDATE desired_assignments SET enabled=0 WHERE id=${unchanged}`),()=>d.exec(sql`UPDATE desired_assignments SET enabled=1 WHERE id=${unchanged}`)]
 ]){
  await change();check(await desired.checkPendingDesiredJob(job),false,label+': pending preflight rejects stale approval');
  check((await d.exec(sql`UPDATE jobs SET state='running' WHERE id=${job.id} AND state='pending' AND (${initial})`)).rowCount,0,label+': atomic claim rejects stale approval');
  await restore();check(await admits(initial),true,label+': restored fixture leaves original live guard valid');
 }
 const direct=uuid();await d.exec(sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,actor,auth_version,created_at) VALUES(${direct},'desired','default','device',${device},${otherTemplate},${actor},1,${clock})`);
 check(await admits(initial),false,'new direct override rejects already prepared inherited job');await d.exec(sql`DELETE FROM automation_scope_assignments WHERE id=${direct}`);
 const conflict=uuid();await inTransaction(d,[sql`UPDATE device_group_members SET group_id=${peer} WHERE server_id=${device}`,sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,actor,auth_version,created_at) VALUES(${conflict},'desired','default','group',${peer},${otherTemplate},${actor},1,${clock})`]);
 check(await admits(initial),false,'a move into a peer group with another template rejects prepared job');await inTransaction(d,[sql`DELETE FROM automation_scope_assignments WHERE id=${conflict}`,sql`UPDATE device_group_members SET group_id=${child} WHERE server_id=${device}`]);
 await d.exec(sql`UPDATE jobs SET state='running' WHERE id=${job.id} AND (${initial})`);
 await d.exec(sql`UPDATE automation_scope_assignments SET disabled=1 WHERE id=${source}`);
 check(await d.one(sql`SELECT parameters FROM jobs WHERE id=${job.id} AND state='running' AND (${initial})`),null,'last parameter delivery rejects withdrawal after claim');
 await d.exec(sql`UPDATE automation_scope_assignments SET disabled=0 WHERE id=${source}`);await clearJobs();

 // Admission uses the same source fence, not just the precomputed Viewer.
 beforeBatch=()=>d.exec(sql`UPDATE automation_scope_assignments SET template_id=${otherTemplate} WHERE id=${source}`);
 await desired.advanceDesiredState(device);check(await count('jobs'),0,'replacement during automatic admission creates no job');check(await count('desired_runs'),0,'replacement during automatic admission creates no orphan run');
 check((await local()).last_checked_at,null,'failed admission does not advance the desired cursor');
 await d.exec(sql`UPDATE automation_scope_assignments SET template_id=${template} WHERE id=${source}`);
 await d.exec(sql`UPDATE automation_scope_assignments SET disabled=1 WHERE id=${source}`);await desired.advanceDesiredState(device);check(await count('jobs'),0,'withdrawal between reconcile and advance never becomes a local timer');
 await d.exec(sql`UPDATE automation_scope_assignments SET disabled=0 WHERE id=${source}`);

 // Explicit local requests retain their own approval and cannot inject a central
 // approval by adding a similarly named property to the request body.
 const result=await desired.queueDesiredState(owner,{assignmentId:assignment.id,action:'test',confirmSystem:true,automationApproval:(await scopes.effectiveAutomationForDevice(device,'desired'))[0]});job=await pending();
 check(Object.hasOwn(JSON.parse(job.parameters),'automationApproval'),false,'request body cannot forge internal automatic provenance');
 const manual=await desired.desiredJobClaimGuard(result.jobId,device);await d.exec(sql`DELETE FROM automation_scope_assignments WHERE id=${source}`);
 check(await desired.checkPendingDesiredJob(job),true,'explicit manual request is independent of the removed central source');check(await admits(manual),true,'manual request retains its explicit current assignment approval');
 await d.exec(sql`UPDATE desired_assignments SET enabled=0 WHERE id=${assignment.id}`);check(await admits(manual),false,'manual job still requires its exact live local assignment');
 await d.exec(sql`UPDATE desired_assignments SET enabled=1 WHERE id=${assignment.id}`);
 const parameters=JSON.parse(job.parameters);parameters.automationApproval={kind:'desired'};await d.exec(sql`UPDATE jobs SET parameters=${JSON.stringify(parameters)} WHERE id=${job.id}`);
 check(compile(await desired.desiredJobClaimGuard(job.id,device)).text,'FALSE','malformed persisted provenance fails closed');
 check(await admits(manual),false,'prepared guard rejects any post-validation parameter mutation');

 // When the automation upsert replaces the local row (new id, new version), the
 // stored last result and verdict of the old assignment are reset (migration 0037).
 const statusColumns='last_job_id,last_result_state,last_result_at,last_compliant,last_compliant_at';
 await d.exec(sql`UPDATE desired_assignments SET last_job_id='old-job',last_result_state='succeeded',last_result_at=${clock},last_compliant=1,last_compliant_at=${clock} WHERE id=${assignment.id}`);
 await d.exec(sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,actor,auth_version,created_at) VALUES(${source},'desired','default','group',${group},${otherTemplate},${actor},1,${clock})`);
 await automation.reconcileDeviceAutomation(device);const replaced=await local();
 check([replaced.id!==assignment.id,replaced.version_id],[true,otherVersion],'the automation upsert replaced the local assignment');
 check(await d.one(sql`SELECT ${idents(statusColumns)} FROM desired_assignments WHERE id=${replaced.id}`),{last_job_id:null,last_result_state:null,last_result_at:null,last_compliant:null,last_compliant_at:null},'the replaced assignment starts without the old result and verdict');

 // Authenticated GitHub import: the Owner right is asked again, fresh,
 // before every call that carries the token. An Owner demoted during the first
 // call gets 403 and the second call is never made.
 Object.assign(settings,{DESIRED_STATE_GITHUB_TOKEN:'fixture-token',DESIRED_STATE_GITHUB_REPOSITORIES:'contoso/dsc'});
 const ownerAssignment=await d.one(sql`SELECT * FROM role_assignments WHERE principal_id=${owner.id} AND role_id=${role}`),fetches=[],realFetch=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{fetches.push({url:String(url),authorization:init?.headers?.Authorization});if(fetches.length===1){await d.exec(sql`DELETE FROM role_assignments WHERE id=${ownerAssignment.id}`);return Response.json({sha:'a'.repeat(40)});}return Response.json({type:'file',encoding:'base64',size:2,content:Buffer.from('{}').toString('base64')});};
 const importer={...owner};Object.defineProperty(importer,'authorization',{value:{authVersion:1},enumerable:false});
 try{await assert.rejects(desired.importDesiredGithub(importer,{name:'GitHub import',github:{owner:'contoso',repository:'dsc',ref:'main',path:'config.json'}}),error=>error.status===403&&error.message===serverText('apiError.desired.githubRightsChanged'));checks++;}
 finally{globalThis.fetch=realFetch;await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${ownerAssignment.id},${ownerAssignment.principal_type},${ownerAssignment.principal_id},${ownerAssignment.role_id},${ownerAssignment.scope_type},${ownerAssignment.scope_id},${ownerAssignment.created_at},${ownerAssignment.created_by})`);}
 check([fetches.length,fetches[0].url,fetches[0].authorization],[1,'https://api.github.com/repos/contoso/dsc/commits/main','Bearer fixture-token'],'the demoted Owner makes no second tokened GitHub call');
 console.log(`PASS ${checks} Desired-State approval checks: source replacement/withdrawal, inherited membership, conflicts/overrides, password/MFA/RBAC races, queue/claim/final delivery, schedule pause and explicit manual authorization.`);
}finally{d.close();}
