// Exercise actual drift writes on an isolated PostgreSQL test database with permission changes after reads.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,sourceActor} from '../support/source-database.mjs';

import {sql} from '../../runtime/database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
const d=await sourceDatabase();
try{
 const time=Date.now(),device=crypto.randomUUID(),second=crypto.randomUUID(),group=crypto.randomUUID();
 const {actor:owner}=await sourceActor(d,'owner@drift.test',['*']);
 const {actor:admin,roleId:adminRole}=await sourceActor(d,'admin@drift.test',['*']);
 const {actor:operator,roleId:operatorRole}=await sourceActor(d,'operator@drift.test',['drift.manage','drift.contents'],'devicegroup',group);
 const HttpError=realHttpError;
 let hook=null,logged=0;
 // The change lands right after the matching read of the request returns.
 const wrappedDb=hookDatabase(d,{after:async text=>{if(hook?.match(text)){const captured=hook;hook=null;await captured.change();}}});
 const server={db:()=>wrappedDb,config:()=>'',now:()=>Date.now(),guid:x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x),HttpError,log:async()=>{logged++;}};
 const load=sourceLoader();
 const access=load('lib/server/identity/access.ts',{'../context':server}),drift=load('lib/server/automation/drift.ts',{'../context':server,'../identity/access':access,'./access':access});
 await d.exec(sql`INSERT INTO device_groups(id,name,description,created_at) VALUES (${group},${'Drift race'},${'Fixture'},${time})`);
 for(const id of [device,second]){
  await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen,management,snapshot) VALUES (${id},${'Drift race'},${'a'.repeat(64)},${time},${time},1,${'{}'})`);
  await d.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES (${id},${group})`);
 }
 const permissions=values=>d.exec(sql`UPDATE rbac_roles SET permissions=${JSON.stringify(values)} WHERE id=${operatorRole}`);
 const metadataPolicy={enabled:true,config:['services']},contentPolicy={enabled:true,paths:[{path:'C:\\Config',includeText:true,extensions:['.txt']}]};
 const policyRow=()=>d.one(sql`SELECT version,policy FROM drift_policies WHERE server_id=${device}`);
 const beforeWrite=(match,change)=>{hook={match:sql=>sql.startsWith(match),change};};
 const denied=async action=>{const before=logged;await assert.rejects(action,error=>error.status===409);assert.equal(hook,null,'race was exercised');assert.equal(logged,before,'denied write has no success audit');};
 await drift.setDriftPolicy(operator,device,contentPolicy);const initial=await policyRow();assert.equal(initial.version,1);assert.equal(JSON.parse(initial.policy).paths[0].includeText,true,'authorized content collection is preserved');
 beforeWrite('SELECT id,version,created_at FROM drift_policies',()=>permissions(['drift.manage']));
 await denied(()=>drift.setDriftPolicy(operator,device,contentPolicy));assert.deepEqual(await policyRow(),initial,'content-right withdrawal cannot overwrite the current policy');
 beforeWrite('SELECT id,version,created_at FROM drift_policies',()=>permissions([]));
 await denied(()=>drift.setDriftPolicy(operator,device,metadataPolicy));assert.deepEqual(await policyRow(),initial,'management-right withdrawal cannot persist a policy');
 beforeWrite('SELECT id,version,created_at FROM drift_policies',()=>d.exec(sql`UPDATE rbac_roles SET permissions='[]' WHERE id=${adminRole}`));
 await denied(()=>drift.setDriftPolicy(admin,device,contentPolicy));assert.deepEqual(await policyRow(),initial,'stale global admin cannot bypass current role');
 await permissions(['drift.manage','drift.contents']);
 beforeWrite('SELECT id,version,created_at FROM drift_policies',()=>d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${operator.id}`));
 await denied(()=>drift.setDriftPolicy(operator,device,contentPolicy));assert.deepEqual(await policyRow(),initial,'disabled account cannot retain write access');
 await d.exec(sql`UPDATE local_users SET status='active' WHERE id=${operator.id}`);
 const applied=await drift.applyGroupDriftPolicy(operator,group,metadataPolicy,true);assert.equal(applied.count,2,'authorized group collection remains available');
 const beforeGroup=await policyRow();
 beforeWrite('SELECT server_id,id,version,created_at FROM drift_policies',()=>permissions([]));
 await denied(()=>drift.applyGroupDriftPolicy(operator,group,metadataPolicy,true));assert.deepEqual(await policyRow(),beforeGroup,'group policy observes withdrawn permissions at commit');
 await permissions(['drift.manage','drift.contents']);
 beforeWrite('SELECT server_id,id,version,created_at FROM drift_policies',()=>d.exec(sql`DELETE FROM device_group_members WHERE server_id=${device}`));
 const partial=await drift.applyGroupDriftPolicy(owner,group,metadataPolicy,true);assert.deepEqual(partial.deviceIds,[second],'group operation excludes a concurrently moved device even for owner');assert.deepEqual(await policyRow(),beforeGroup);
 await d.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES (${device},${group})`);
 const current=await d.one(sql`SELECT version FROM drift_policies WHERE server_id=${device}`),report=crypto.randomUUID();
 await d.exec(sql`INSERT INTO drift_reports(id,server_id,policy_version,scan_id,received_at,scanned_at,complete,state,entries,changes,errors) VALUES (${report},${device},${current.version},${crypto.randomUUID()},${time},${time},1,${'baseline_missing'},${'[]'},${'[]'},${'[]'})`);
 // Seed a retained history so rejected acceptance cannot trigger pruning.
 for(let i=0;i<51;i++)await d.exec(sql`INSERT INTO drift_baselines(id,server_id,policy_version,report_id,entries,created_at,created_by) VALUES (${crypto.randomUUID()},${device},${current.version},${report},${'[]'},${time-i},${access.principal(owner)})`);
 const baselineCount=async()=>Number((await d.one(sql`SELECT count(*) AS n FROM drift_baselines WHERE server_id=${device}`)).n);
 beforeWrite('SELECT r.*,p.version AS current_version',()=>permissions([]));
 await denied(()=>drift.acceptDriftBaseline(operator,device,report,true));assert.equal(await baselineCount(),51,'denied baseline acceptance leaves retained history unchanged');
 await permissions(['drift.manage']);const accepted=await drift.acceptDriftBaseline(operator,device,report,true);assert.ok(accepted.id);assert.equal(await baselineCount(),50,'manage-only baseline acceptance and successful retention are preserved');
 console.log('PASS drift authorization races: current management/content/role/membership fences, group scope and baseline retention; permitted workflows retained.');
}finally{d.close();}
