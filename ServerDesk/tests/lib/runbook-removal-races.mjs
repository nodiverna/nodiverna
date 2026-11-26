// The real delete implementation against an isolated PostgreSQL test database, paused before its batch.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import {mock} from '../support/register.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceActor,inTransaction} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
const d=await sourceDatabase();
const time=1800000000000;let intercept;
const HttpError=realHttpError;
try{
 const group=crypto.randomUUID(),device=crypto.randomUUID();
 const {actor:owner}=await sourceActor(d,'owner@removal.test',['*']);
 const {actor:admin,roleId:adminRole}=await sourceActor(d,'admin@removal.test',['*']);
 const {actor:author,roleId:authorRole,assignmentId:authorAssignment}=await sourceActor(d,'author@removal.test',['runbooks.manage'],'devicegroup',group);
 const facade=hookDatabase(d,{transaction:async()=>{const pause=intercept;intercept=null;if(pause)await pause();}});
 const server={config:()=>'',db:()=>facade,now:()=>time,guid:id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id),HttpError,log:async()=>{throw new Error('A rejected delete must never audit success.');}};
 mock('lib/server/context.ts',server);
 mock('lib/server/agent/agent-crypto.ts',{sealAgentSecrets:async()=>({})});
 mock('lib/management.ts',{operations:{refresh:{schema:{safeParse:()=>({success:true})}}}});
 mock('lib/server/identity/mfa.ts',{isMfaEnabled:async()=>true});
 const {principal}=await import('../../lib/server/identity/access.ts');
 const {deleteRunbook}=await import('../../lib/server/automation/runbooks.ts');
 const reset=async()=>{
  for(const v of [admin,author]){v.authorization.authVersion=1;await d.exec(sql`UPDATE local_users SET status='active',auth_version=1,updated_at=${time} WHERE id=${v.id}`);}
  await d.exec(sql`UPDATE rbac_roles SET permissions=${'["*"]'} WHERE id=${adminRole}`);
  await d.exec(sql`UPDATE rbac_roles SET permissions=${'["runbooks.manage"]'} WHERE id=${authorRole}`);
 };
 await inTransaction(d,[sql`INSERT INTO servers (id,name,token_hash,created_at) VALUES (${device},${'Scope VM'},${'fixture'},${time})`,sql`INSERT INTO device_groups (id,name,description,created_at) VALUES (${group},${'Scope'},${''},${time})`,sql`INSERT INTO device_group_members (server_id,group_id) VALUES (${device},${group})`]);
 const grantAuthor=()=>d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${authorAssignment},'user',${author.id},${authorRole},'devicegroup',${group},${time},${principal(owner)}) ON CONFLICT(id) DO NOTHING`);
 async function rejectRace(actor,mutate,label,beforeCapture=async()=>{}){
  await reset();await grantAuthor();await beforeCapture();const book=crypto.randomUUID(),version=crypto.randomUUID(),run=crypto.randomUUID(),schedule=crypto.randomUUID(),job=crypto.randomUUID();
  await inTransaction(d,[sql`INSERT INTO runbooks (id,name,description,created_at,created_by) VALUES (${book},${label},${'Fixture'},${time},${principal(author)})`,sql`INSERT INTO runbook_versions (id,runbook_id,version,definition,created_at,created_by) VALUES (${version},${book},1,${'{"steps":[],"parameters":[]}'},${time},${principal(author)})`,sql`INSERT INTO runbook_runs (id,version_id,actor,parameters,concurrency,failure_stop,created_at,expires_at) VALUES (${run},${version},${principal(owner)},${'{}'},1,1,${time},${time+100000})`,sql`INSERT INTO runbook_run_devices (run_id,server_id,state,job_id,sealed_secrets) VALUES (${run},${device},${'running'}, ${job},${'{"sealed":"retain"}'})`,sql`INSERT INTO jobs (id,server_id,action,target,state,parameters,created_at,actor,actor_email,actor_principal) VALUES (${job},${device},${'runbook-step'},${'Fixture'},${'pending'},${'{"value":"retain"}'},${time},${owner.id},${owner.label},${principal(owner)})`,sql`INSERT INTO runbook_schedules (id,version_id,actor,targets,parameters,sealed_secrets,recurrence,next_due,catchup_seconds,concurrency,failure_stop,approved_at,created_at) VALUES (${schedule},${version},${principal(owner)},${JSON.stringify([device])},${'{}'},${'{"sealed":"retain"}'},${'{"kind":"interval","minutes":5}'},${time},0,1,1,${time},${time})`]);
  intercept=()=>mutate({book,version,run,schedule,job});await assert.rejects(()=>deleteRunbook(actor,{runbookId:book,confirm:true}),error=>error.status===403,label);assert.equal(intercept,null,label+': the pre-commit race was exercised');
  assert.equal((await d.one(sql`SELECT archived FROM runbooks WHERE id=${book}`)).archived,0,label+': definition stays active');assert.equal((await d.one(sql`SELECT enabled FROM runbook_schedules WHERE id=${schedule}`)).enabled,1,label+': no schedule cleanup');assert.equal((await d.one(sql`SELECT state FROM jobs WHERE id=${job}`)).state,'pending',label+': no pending cancellation');assert.equal((await d.one(sql`SELECT sealed_secrets FROM runbook_run_devices WHERE run_id=${run}`)).sealed_secrets,'{"sealed":"retain"}',label+': no partial secret deletion');
 }
 await rejectRace(admin,()=>d.exec(sql`UPDATE rbac_roles SET permissions='[]' WHERE id=${adminRole}`),'admin demotion before transaction');
 await rejectRace(admin,()=>d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${admin.id}`),'admin membership revocation before transaction');
 await rejectRace(author,()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${authorAssignment}`),'author device management grant revoked');
 await rejectRace(author,()=>d.exec(sql`UPDATE rbac_roles SET permissions='[]' WHERE id=${authorRole}`),'author role demoted');
 await rejectRace(admin,()=>d.exec(sql`UPDATE local_users SET auth_version=3,updated_at=${time} WHERE id=${admin.id}`),'membership decision changes at same timestamp',async()=>{admin.authorization.authVersion=2;await d.exec(sql`UPDATE local_users SET auth_version=2,updated_at=${time} WHERE id=${admin.id}`);});
 const foreign=crypto.randomUUID();await d.exec(sql`INSERT INTO servers (id,name,token_hash,created_at) VALUES (${foreign},${'Foreign scope'},${'foreign'},${time})`);
 await rejectRace(author,({schedule})=>d.exec(sql`UPDATE runbook_schedules SET targets=${JSON.stringify([device,foreign])} WHERE id=${schedule}`),'new foreign-scope schedule target before transaction');
 console.log('PASS: delayed runbook deletion rejects current admin/author role, membership and device-grant revocation without partial cleanup.');
}finally{d.close();}
