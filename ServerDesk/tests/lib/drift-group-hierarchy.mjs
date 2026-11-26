// Actual drift implementation, inherited RBAC and database commit races.
// No application service, Windows command or deployed database is touched.
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
const require=createRequire(import.meta.url),d=await sourceDatabase(),root=process.cwd(),cache=new Map(),uuid=()=>crypto.randomUUID(),time=Date.now();
let beforeBatch=null,checks=0;
const logs=[];
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const HttpError=realHttpError;
const facade=hookDatabase(d,{transaction:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}}});
const server={db:()=>facade,now:()=>time,guid:value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value),HttpError,log:async(...args)=>logs.push(args)};
function load(filename){
 const absolute=path.resolve(filename),relative=path.relative(root,absolute).replaceAll('\\','/');if(relative==='lib/server/context.ts')return server;
 if(cache.has(absolute))return cache.get(absolute).exports;
 const fixture={exports:{}};cache.set(absolute,fixture);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 new Function('require','module','exports',code)(id=>{if(id.startsWith('.'))return /[.]m?js$/.test(id)?require(path.resolve(path.dirname(absolute),id)):load(path.resolve(path.dirname(absolute),id+'.ts'));return require(id);},fixture,fixture.exports);
 return fixture.exports;
}
const drift=load('lib/server/automation/drift.ts'),access=load('lib/server/identity/access.ts');
const owner={id:uuid(),label:'owner@drift-group.test',permissions:['*']},operator={id:uuid(),label:'operator@drift-group.test',permissions:[]};
const ownerSession=uuid(),operatorSession=uuid(),ownerMfa=uuid(),operatorMfa=uuid();
for(const [viewer,sessionHash] of [[owner,ownerSession],[operator,operatorSession]])Object.defineProperty(viewer,'authorization',{value:{authVersion:1,sessionHash},enumerable:false});
const parent=uuid(),child=uuid(),grandchild=uuid(),sibling=uuid(),foreign=uuid(),empty=uuid(),parentRole=uuid(),ownerRole=uuid(),operatorAssignment=uuid();
const nested=uuid(),branched=uuid(),direct=uuid(),outside=uuid(),revoked=uuid(),joined=uuid();
const metadataPolicy={enabled:true,config:['services']},contentPolicy={enabled:true,paths:[{path:'C:\\Config',includeText:true,extensions:['.txt']}]};
const allPolicies=()=>d.query(sql`SELECT server_id,id,version,enabled,policy,created_at,updated_at,updated_by FROM drift_policies ORDER BY server_id`).then(results=>({results})).then(result=>result.results);
const policy=id=>d.one(sql`SELECT id,version,enabled,policy,created_at,updated_at,updated_by FROM drift_policies WHERE server_id=${id}`);
const sorted=ids=>[...ids].sort();
const apply=(viewer=operator,group=parent,body=metadataPolicy)=>drift.applyGroupDriftPolicy(viewer,group,body,true);
const rejected=async(action,status,label)=>{const before=logs.length;await assert.rejects(action,error=>error instanceof HttpError&&error.status===status,label);check(logs.length,before,label+' leaves success audit untouched');check(beforeBatch,null,label+' exercised any configured commit race');};
const addServer=(id,removed=false)=>sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen,management,snapshot,revoked) VALUES(${id},${id},${id},${time},${time},1,${'{}'},${removed?1:0})`;
try{
 await inTransaction(d,[
  ...[owner,operator].map(viewer=>sql`INSERT INTO local_users(id,username,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at) VALUES(${viewer.id},${viewer.id},${viewer.label},${access.principal(viewer)},${viewer.label},'active',1,${time},${time})`),
  ...[[ownerRole,'Owner',['*']],[parentRole,'Scoped Drift',['drift.manage','drift.contents']]].map(([id,name,rights])=>sql`INSERT INTO rbac_roles(id,name,permissions,created_at) VALUES(${id},${name},${JSON.stringify(rights)},${time})`),
  sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${owner.id},${ownerRole},'global','*',${time},${access.principal(owner)})`,
  sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${operatorAssignment},'user',${operator.id},${parentRole},'devicegroup',${parent},${time},${access.principal(owner)})`,
  ...[[parent,null],[child,parent],[grandchild,child],[sibling,parent],[foreign,null],[empty,null]].map(([id,parentId])=>sql`INSERT INTO device_groups(id,name,parent_id,description,created_at) VALUES(${id},${id},${parentId},'',${time})`),
  ...[nested,branched,direct,outside].map(id=>addServer(id)),addServer(revoked,true),
  ...[[nested,grandchild],[branched,child],[direct,parent],[outside,foreign],[revoked,child]].map(([id,group])=>sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${id},${group})`),
  ...[[owner,ownerMfa,ownerSession],[operator,operatorMfa,operatorSession]].flatMap(([viewer,mfaHash,sessionHash])=>[
   sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${access.principal(viewer)},'fixture','[]',0,${time-86400000})`,
   sql`INSERT INTO mfa_sessions(token_hash,principal,created_at,last_activity,idle_expires_at,expires_at) VALUES(${mfaHash},${access.principal(viewer)},${time},${time},${time+86400000},${time+86400000})`,
   sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) VALUES(${sessionHash},${viewer.id},1,${time},${time+86400000},${time+86400000},${mfaHash})`
  ])
 ]);
 const initial=await apply(operator,parent,contentPolicy);
 check(initial.deviceIds,sorted([nested,branched,direct]),'parent targets direct children and deeper descendants exactly once');
 check(initial.count,3,'each descendant device is targeted once');
 check((await allPolicies()).map(row=>row.version),[1,1,1],'one policy version per target device');
 check(await policy(outside),null,'foreign roots are outside the requested group');check(await policy(revoked),null,'revoked descendants are excluded');
 const nestedPolicy=await policy(nested),report=uuid(),baseline=uuid();
 await inTransaction(d,[
  sql`INSERT INTO drift_reports(id,server_id,policy_version,scan_id,received_at,scanned_at,complete,state,entries,changes,errors) VALUES(${report},${nested},${nestedPolicy.version},${uuid()},${time},${time},1,${'in_sync'},${'[]'},${'[]'},${'[]'})`,
  sql`INSERT INTO drift_baselines(id,server_id,policy_version,report_id,entries,created_at,created_by) VALUES(${baseline},${nested},${nestedPolicy.version},${report},${'[]'},${time},${access.principal(owner)})`
 ]);
 const baselineRows=await d.query(sql`SELECT * FROM drift_baselines ORDER BY id`).then(results=>({results}));
 await apply();check((await policy(nested)).id,nestedPolicy.id,'existing policy identity is preserved');check((await policy(nested)).version,2,'existing policy version advances once');
 check((await d.query(sql`SELECT * FROM drift_baselines ORDER BY id`)),baselineRows.results,'group policy edits retain historical baselines');
 const stable=await allPolicies();
 await rejected(()=>drift.applyGroupDriftPolicy(owner,parent,metadataPolicy,false),400,'explicit group confirmation is required');
 await rejected(()=>apply(owner,uuid()),404,'missing group is rejected');await rejected(()=>apply(owner,empty),409,'empty group is rejected');
 await d.exec(sql`UPDATE role_assignments SET scope_id=${child} WHERE id=${operatorAssignment}`);
 await rejected(()=>apply(),403,'child-only rights do not authorize every parent target');check(await allPolicies(),stable,'failed per-device authorization writes no policy');
 await d.exec(sql`UPDATE role_assignments SET scope_id=${parent} WHERE id=${operatorAssignment}`);
 await d.exec(sql`UPDATE rbac_roles SET permissions=${'["drift.manage"]'} WHERE id=${parentRole}`);
 await rejected(()=>apply(operator,parent,contentPolicy),403,'content collection still requires drift.contents on each target');check(await allPolicies(),stable,'content denial writes no policy');
 await d.exec(sql`UPDATE rbac_roles SET permissions=${'["drift.manage","drift.contents"]'} WHERE id=${parentRole}`);
 beforeBatch=()=>d.exec(sql`UPDATE rbac_roles SET permissions=${'[]'} WHERE id=${parentRole}`);
 await rejected(()=>apply(),409,'live role withdrawal blocks all committing inherited targets');check(await allPolicies(),stable,'commit role withdrawal leaves policies intact');
 await d.exec(sql`UPDATE rbac_roles SET permissions=${'["drift.manage","drift.contents"]'} WHERE id=${parentRole}`);
 beforeBatch=()=>d.exec(sql`DELETE FROM mfa_sessions WHERE token_hash=${operatorMfa}`);
 await rejected(()=>apply(),409,'MFA session withdrawal blocks a prepared group write');check(await allPolicies(),stable,'MFA race leaves policies intact');
 await d.exec(sql`INSERT INTO mfa_sessions(token_hash,principal,created_at,last_activity,idle_expires_at,expires_at) VALUES(${operatorMfa},${access.principal(operator)},${time},${time},${time+86400000},${time+86400000})`);
 beforeBatch=()=>d.exec(sql`UPDATE local_users SET auth_version=auth_version+1 WHERE id=${operator.id}`);
 await rejected(()=>apply(),409,'changed authentication version blocks a prepared group write');check(await allPolicies(),stable,'authentication version race leaves policies intact');
 await d.exec(sql`UPDATE local_users SET auth_version=1 WHERE id=${operator.id}`);
 const branchedBefore=await policy(branched);
 beforeBatch=()=>d.exec(sql`UPDATE device_group_members SET group_id=${foreign} WHERE server_id=${branched}`);
 const moved=await apply(owner);check(moved.deviceIds,sorted([nested,direct]),'a device moved out before commit is omitted even for the global owner');check(await policy(branched),branchedBefore,'moved device existing policy is not overwritten');
 check((await d.query(sql`SELECT group_id FROM device_group_members WHERE server_id=${branched}`)),[{group_id:foreign}],'the move replaced the only direct membership');
 await d.exec(sql`UPDATE device_group_members SET group_id=${child} WHERE server_id=${branched}`);
 const nestedBefore=await policy(nested);
 beforeBatch=()=>d.exec(sql`UPDATE device_groups SET parent_id=${foreign} WHERE id=${grandchild}`);
 const reparented=await apply(owner);check(reparented.deviceIds,sorted([branched,direct]),'moving the containing subtree outside the selected group is checked at commit');check(await policy(nested),nestedBefore,'reparent race keeps the prior policy intact');
 await d.exec(sql`UPDATE device_groups SET parent_id=${child} WHERE id=${grandchild}`);
 beforeBatch=()=>inTransaction(d,[sql`DELETE FROM device_group_members WHERE server_id=${nested} AND group_id=${grandchild}`,sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${nested},${sibling})`]);
 check((await apply(owner)).deviceIds,sorted([nested,branched,direct]),'moving between descendants keeps effective parent membership at commit');
 beforeBatch=()=>inTransaction(d,[addServer(joined),sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${joined},${child})`]);
 check((await apply(owner)).count,3,'new members after target resolution are not silently added to the approved snapshot');check(await policy(joined),null,'late member receives no unprepared policy');
 check((await apply(owner)).count,4,'a later group action includes the new descendant');
 const onlyParent=uuid(),onlyChild=uuid(),onlyTarget=uuid();
 await inTransaction(d,[sql`INSERT INTO device_groups(id,name,description,created_at) VALUES(${onlyParent},${onlyParent},'',${time})`,sql`INSERT INTO device_groups(id,name,parent_id,description,created_at) VALUES(${onlyChild},${onlyChild},${onlyParent},'',${time})`,addServer(onlyTarget),sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${onlyTarget},${onlyChild})`]);
 beforeBatch=()=>d.exec(sql`DELETE FROM device_group_members WHERE server_id=${onlyTarget}`);
 await rejected(()=>apply(owner,onlyParent),409,'removing the final inherited target denies the group action');check(await policy(onlyTarget),null,'new policy is never inserted for a stale descendant');
 const limitParent=uuid(),limitChild=uuid(),limitPeer=uuid(),hundred=Array.from({length:100},uuid),extra=uuid();
 await inTransaction(d,[
  ...[[limitParent,null],[limitChild,limitParent],[limitPeer,limitParent]].map(([id,parentId])=>sql`INSERT INTO device_groups(id,name,parent_id,description,created_at) VALUES(${id},${id},${parentId},'',${time})`),
  ...hundred.flatMap((id,index)=>[addServer(id),sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${id},${index<50?limitChild:limitPeer})`])
 ]);
 check((await apply(owner,limitParent)).count,100,'100 descendant targets across two subgroups pass');
 check((await d.query(sql`SELECT DISTINCT version FROM drift_policies WHERE server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(hundred)}::jsonb))`)),[{version:1}],'limit-sized action applies once per distinct target');
 await inTransaction(d,[addServer(extra),sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${extra},${limitChild})`]);
 const beforeLimit=await allPolicies();await rejected(()=>apply(owner,limitParent),413,'101 unique descendants preserve the existing group action bound');check(await allPolicies(),beforeLimit,'oversized group action has no partial writes');
 check((await d.query(sql`SELECT * FROM drift_baselines ORDER BY id`)),baselineRows.results,'all target and permission races preserve baselines');
 console.log(`PASS: ${checks} actual database drift-group checks: inherited/distinct targets, 100-device limit, retained baselines, per-device content/RBAC/MFA/auth-version fences and membership/reparent commit races.`);
}finally{d.close();}
