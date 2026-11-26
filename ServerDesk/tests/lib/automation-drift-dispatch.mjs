// Execute the real authorization predicates and final policy SELECT in PostgreSQL.
// Race hooks change isolated fixture rows just before policy delivery.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ts from 'typescript';
import {sql} from '../../runtime/database.mjs';

import {sourceDatabase,inTransaction,insertRow} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
const require=createRequire(import.meta.url),d=await sourceDatabase(),cache=new Map(),root=process.cwd(),uuid=()=>crypto.randomUUID();
const clock=Date.now();let beforeFinal=null,checks=0,deliveries=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const HttpError=realHttpError;
// The final policy read (one statement) counts as a delivery; beforeFinal runs
// once right before it.
const facade=hookDatabase(d,{statement:async text=>{
 if(/FROM drift_policies policy WHERE policy[.]server_id=[$][0-9]+/i.test(text)){deliveries++;if(beforeFinal){const change=beforeFinal;beforeFinal=null;await change();}}
}});
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
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 new Function('require','module','exports',code)(id=>{if(id.startsWith('.')){const base=path.resolve(path.dirname(absolute),id),file=[base,base+'.ts',base+'.tsx'].find(name=>fs.existsSync(name)&&fs.statSync(name).isFile());if(file)return /[.]m?js$/.test(file)?require(file):load(file);}return require(id);},mod,mod.exports);return mod.exports;
}
const automation=load('lib/server/automation/automation-device.ts'),scopes=load('lib/server/automation/automation-scopes.ts'),drift=load('lib/server/automation/drift.ts'),access=load('lib/server/identity/access.ts');
try{
 const owner={id:uuid(),label:'owner@drift-dispatch.test',permissions:['*']};Object.defineProperty(owner,'authorization',{value:{authVersion:1},enumerable:false});
 const actor=access.principal(owner),role=uuid(),group=uuid(),child=uuid(),peer=uuid(),source=uuid(),target=uuid(),mfaCreatedAt=clock-86400000;
 await inTransaction(d,[
  sql`INSERT INTO local_users(id,username,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at) VALUES(${owner.id},${'owner'},${'Owner'},${actor},${owner.label},'active',1,${clock},${clock})`,
  sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${actor},'fixture','[]',0,${mfaCreatedAt})`,
  sql`INSERT INTO rbac_roles(id,name,permissions,created_at) VALUES(${role},'Owner','["*"]',${clock})`,
  sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${owner.id},${role},'global','*',${clock},${actor})`,
  ...[[group,null],[child,group],[peer,null]].map(([id,parent])=>sql`INSERT INTO device_groups(id,name,parent_id,description,created_at) VALUES(${id},${id},${parent},'',${clock})`),
  ...[source,target].map(id=>sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen) VALUES(${id},${id},${id},${clock},${clock})`),
  sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${target},${child})`
 ]);
 await drift.setDriftPolicy(owner,source,{enabled:true,paths:[{path:'C:\\Config',includeText:true,extensions:['.txt']}],registry:[{path:'HKLM\\Software\\Example',includeValues:true}],config:['services'],includeConfigValues:true});
 const template=await scopes.createAutomationTemplate(owner,{kind:'drift',name:'Shared contents',sourceServerId:source,includeBaseline:false});
 const other=await scopes.createAutomationTemplate(owner,{kind:'drift',name:'Other source',sourceServerId:source,includeBaseline:false});
 const assignment=await scopes.assignAutomationScope(owner,{templateId:template.id,scopeType:'group',scopeId:group,confirm:true});
 await automation.reconcileDeviceAutomation(target);
 const materialized=await d.one(sql`SELECT * FROM drift_policies WHERE server_id=${target}`);
 const originalState=await d.one(sql`SELECT * FROM automation_device_state WHERE server_id=${target} AND kind='drift' AND slot='default'`);
 const templatePayload=(await d.one(sql`SELECT payload FROM automation_templates WHERE id=${template.id}`)).payload;
 const restoreAssignment=()=>d.exec(sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,actor,auth_version,created_at) VALUES(${assignment.id},'drift','default','group',${group},${template.id},${actor},1,${clock})`);
 const restoreMfa=()=>d.exec(sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${actor},'fixture','[]',0,${mfaCreatedAt})`);
 const policyRow=()=>d.one(sql`SELECT * FROM drift_policies WHERE server_id=${target}`);
 const policy=await automation.getAutomationDriftPolicy(target);
 check(policy.enabled,true,'the confirmed materialized central policy is delivered');
 check(policy.policyId,materialized.id,'delivery retains policy identity');check(policy.version,materialized.version,'delivery retains policy version');
 check(policy.paths[0].includeText,true,'approved contents options reach the agent');
 check(deliveries,1,'delivery makes exactly one final policy read');
 const cases=[
  ['removed scope',()=>d.exec(sql`DELETE FROM automation_scope_assignments WHERE id=${assignment.id}`),restoreAssignment],
  ['replaced scope ID',()=>d.exec(sql`UPDATE automation_scope_assignments SET id=${other.id} WHERE id=${assignment.id}`),()=>d.exec(sql`UPDATE automation_scope_assignments SET id=${assignment.id} WHERE id=${other.id}`)],
  ['replaced template',()=>d.exec(sql`UPDATE automation_scope_assignments SET template_id=${other.id} WHERE id=${assignment.id}`),()=>d.exec(sql`UPDATE automation_scope_assignments SET template_id=${template.id} WHERE id=${assignment.id}`)],
  ['paused scope',()=>d.exec(sql`UPDATE automation_scope_assignments SET disabled=1 WHERE id=${assignment.id}`),()=>d.exec(sql`UPDATE automation_scope_assignments SET disabled=0 WHERE id=${assignment.id}`)],
  ['member removed',()=>d.exec(sql`DELETE FROM device_group_members WHERE server_id=${target}`),()=>d.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${target},${child})`)],
  ['account disabled',()=>d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${owner.id}`),()=>d.exec(sql`UPDATE local_users SET status='active' WHERE id=${owner.id}`)],
  ['auth version revoked',()=>d.exec(sql`UPDATE local_users SET auth_version=2 WHERE id=${owner.id}`),()=>d.exec(sql`UPDATE local_users SET auth_version=1 WHERE id=${owner.id}`)],
  ['MFA removed',()=>d.exec(sql`DELETE FROM mfa_accounts WHERE principal=${actor}`),restoreMfa],
  ['MFA replaced',()=>d.exec(sql`UPDATE mfa_accounts SET created_at=${clock+1} WHERE principal=${actor}`),()=>d.exec(sql`UPDATE mfa_accounts SET created_at=${mfaCreatedAt} WHERE principal=${actor}`)],
  ['management permission revoked',()=>d.exec(sql`UPDATE rbac_roles SET permissions='[]' WHERE id=${role}`),()=>d.exec(sql`UPDATE rbac_roles SET permissions='["*"]' WHERE id=${role}`)],
  ['contents permission revoked',()=>d.exec(sql`UPDATE rbac_roles SET permissions=${JSON.stringify(['view','drift.manage','drift.read'])} WHERE id=${role}`),()=>d.exec(sql`UPDATE rbac_roles SET permissions='["*"]' WHERE id=${role}`)],
  ['template archived',()=>d.exec(sql`UPDATE automation_templates SET archived=1 WHERE id=${template.id}`),()=>d.exec(sql`UPDATE automation_templates SET archived=0 WHERE id=${template.id}`)],
  ['template payload changed',()=>d.exec(sql`UPDATE automation_templates SET payload=jsonb_set(payload::jsonb,'{policy,intervalSeconds}','600')::text WHERE id=${template.id}`),()=>d.exec(sql`UPDATE automation_templates SET payload=${templatePayload} WHERE id=${template.id}`)],
  ['state no longer applied',()=>d.exec(sql`UPDATE automation_device_state SET status='paused' WHERE server_id=${target} AND kind='drift'`),()=>d.exec(sql`UPDATE automation_device_state SET status='applied' WHERE server_id=${target} AND kind='drift'`)],
  ['state approval replaced',()=>d.exec(sql`UPDATE automation_device_state SET fingerprint='another-approval' WHERE server_id=${target} AND kind='drift'`),()=>d.exec(sql`UPDATE automation_device_state SET fingerprint=${originalState.fingerprint} WHERE server_id=${target} AND kind='drift'`)]
 ];
 for(const [label,change,restore] of cases){
  await change();check((await automation.getAutomationDriftPolicy(target)).enabled,false,label+' between reconcile and getter rejects collection');await restore();
  beforeFinal=change;check((await automation.getAutomationDriftPolicy(target)).enabled,false,label+' immediately before the final SELECT rejects collection');
  check(beforeFinal,null,label+' race hook ran at the final SELECT');await restore();
  check(await policyRow(),materialized,label+' dispatch rejection never rewrites the stored policy');
  check((await automation.getAutomationDriftPolicy(target)).enabled,true,label+' restored fixture remains deliverable');
 }
 const direct=uuid(),conflict=uuid();
 beforeFinal=()=>d.exec(sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,actor,auth_version,created_at) VALUES(${direct},'drift','default','device',${target},${other.id},${actor},1,${clock})`);
 check((await automation.getAutomationDriftPolicy(target)).enabled,false,'a concurrent direct override rejects the already materialized group policy');await d.exec(sql`DELETE FROM automation_scope_assignments WHERE id=${direct}`);
 beforeFinal=()=>inTransaction(d,[sql`UPDATE device_group_members SET group_id=${peer} WHERE server_id=${target}`,sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,actor,auth_version,created_at) VALUES(${conflict},'drift','default','group',${peer},${other.id},${actor},1,${clock})`]);
 check((await automation.getAutomationDriftPolicy(target)).enabled,false,'a concurrent move into a peer group with another template rejects central collection');await inTransaction(d,[sql`DELETE FROM automation_scope_assignments WHERE id=${conflict}`,sql`UPDATE device_group_members SET group_id=${child} WHERE server_id=${target}`]);
 beforeFinal=()=>d.exec(sql`DELETE FROM automation_device_state WHERE server_id=${target} AND kind='drift'`);
 check((await automation.getAutomationDriftPolicy(target)).enabled,false,'deleting provenance during delivery cannot relabel an observed inherited policy as local');
 await insertRow(d,'automation_device_state',originalState);
 beforeFinal=()=>d.exec(sql`UPDATE drift_policies SET enabled=0 WHERE server_id=${target}`);
 check((await automation.getAutomationDriftPolicy(target)).enabled,false,'the final SELECT sees a concurrent local pause without a policy/version change');await d.exec(sql`UPDATE drift_policies SET enabled=1 WHERE server_id=${target}`);
 beforeFinal=()=>inTransaction(d,[sql`DELETE FROM automation_scope_assignments WHERE id=${assignment.id}`,sql`UPDATE drift_policies SET version=version+1,policy=jsonb_set(policy::jsonb,'{intervalSeconds}','900')::text,updated_by='local-writer' WHERE server_id=${target}`]);
 const override=await automation.getAutomationDriftPolicy(target);check(override.enabled,true,'a concurrent genuine local override remains independent after inherited scope removal');check(override.intervalSeconds,900,'dispatch uses the actual final local policy rather than a cached inherited payload');
 const local=await policyRow();check(local.updated_by,'local-writer','dispatch preserves the local writer');
 check((await automation.getAutomationDriftPolicy(target)).enabled,true,'a later read keeps the local override active with no inherited approval');
 await d.exec(sql`UPDATE drift_policies SET enabled=0 WHERE server_id=${target}`);check((await automation.getAutomationDriftPolicy(target)).enabled,false,'local paused policy stays paused after its group scope was removed');
 check((await policyRow()).version,local.version,'dispatch neither restores nor bumps local policy version');
 check(await automation.getAutomationDriftPolicy(uuid()),{enabled:false},'missing policy returns disabled');
 console.log(`PASS: ${checks} actual database drift delivery checks: atomic source/MFA/permission/member revocation, resource provenance, local overrides and pause races.`);
}finally{d.close();}
