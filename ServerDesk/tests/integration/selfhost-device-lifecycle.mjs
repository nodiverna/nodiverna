// Device offboarding and group deletion on PostgreSQL: bulk admission, revoked credentials, audit rollback,
// step-up proofs and assignment cleanup (pnpm test:selfhost).
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import ts from 'typescript';
import {sql} from '../../runtime/database.mjs';
import {createTrigger,dropTrigger,insertRow,sourceDatabase} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {serverDeskRoot} from '../support/paths.mjs';

const root=serverDeskRoot,require=createRequire(import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');

// Actual source SQL runs against an isolated PostgreSQL test database, through
// the data layer of the portal. Only network/files and proof decoding are leaves.
async function fixture(run){
 const d=await sourceDatabase();
 let beforeBatch=async()=>{};
 // beforeBatch runs once before the next transaction; every transaction records its statements.
 const batches=[],facade=hookDatabase(d,{transaction:async()=>{const hook=beforeBatch;beforeBatch=async()=>{};await hook();},record:batches});
 const HttpError=realHttpError;
 const server={db:()=>facade,guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value),HttpError,now:()=>Date.now(),hash:async value=>sha(value),body:request=>request.json(),log:async()=>{},config:()=>'',privateViewers:()=>[]};
 const cache=new Map(),cleaned=[];
 const overrides={
  'lib/server/context.ts':server,
  'lib/server/devices/transfers.ts':{clearTransfer:async id=>{cleaned.push(id);await d.exec(sql`DELETE FROM transfer_chunks WHERE transfer_id=${id}`);}},
  'lib/server/identity/local-auth.ts':{primaryGuard:async(_request,viewer)=>load('lib/server/identity/access.ts').viewerWriteGuard(viewer)},
  'lib/server/identity/mfa.ts':{readMfaManagementProof:async(_request,viewer,tokenHash)=>({tokenHash,key:viewer.principal,sessionHash:sha(viewer.id+'mfa'),guard:sql`TRUE`})}
 };
 function load(filename){
  const absolute=resolve(root,filename),relative=absolute.slice(root.length).replaceAll('\\','/');
  if(overrides[relative])return overrides[relative];
  if(cache.has(absolute))return cache.get(absolute).exports;
  const loadedModule={exports:{}};cache.set(absolute,loadedModule);
  const code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const localRequire=id=>id.startsWith('.')&&id.endsWith('.mjs')?require(resolve(dirname(absolute),id)):id.startsWith('.')?load(resolve(dirname(absolute),id)+'.ts'):require(id);
  new Function('require','module','exports',code)(localRequire,loadedModule,loadedModule.exports);return loadedModule.exports;
 }
 const insert=(table,row)=>insertRow(d,table,row);
 async function user(name,permissions=['*'],role='admin'){
  const id=randomUUID(),at=Date.now(),principal='private:'+name+'@fixture.test',sessionHash=sha(id+'primary'),mfaHash=sha(id+'mfa');
  await insert('local_users',{id,username:name,display_name:name,auth_principal:principal,auth_email:name+'@fixture.test',status:'active',password_hash:'fixture-password-hash',created_at:at,updated_at:at});
  await insert('mfa_accounts',{principal,secret_enc:'fixture-secret',recovery_hashes:'[]',last_counter:0,created_at:at});
  await insert('mfa_sessions',{token_hash:mfaHash,principal,created_at:at,last_activity:at,idle_expires_at:at+3600000,expires_at:at+3600000});
  await insert('local_auth_sessions',{token_hash:sessionHash,user_id:id,auth_version:1,created_at:at,expires_at:at+3600000,pending_until:0,mfa_hash:mfaHash});
  const viewer={id,label:name+'@fixture.test',principal,provider:'local',role,authorization:{authVersion:1,sessionHash}};
  if(permissions.length)await grant(viewer,permissions);return viewer;
 }
 async function grant(viewer,permissions,scopeType='global',scopeId='*',subjectType='user',subjectId=viewer.id){
  const id=randomUUID(),roleId=randomUUID(),at=Date.now();await insert('rbac_roles',{id:roleId,name:roleId,permissions:JSON.stringify(permissions),created_at:at});
  await insert('role_assignments',{id,principal_type:subjectType,principal_id:subjectId,role_id:roleId,scope_type:scopeType,scope_id:scopeId,created_at:at,created_by:'fixture'});return id;
 }
 async function device(name){
  const id=randomUUID(),at=Date.now(),token=sha(name+'token'),previous=sha(name+'previous');
  await insert('servers',{id,name,token_hash:token,previous_token_hash:previous,previous_token_expires_at:at+60000,token_expires_at:at+60000,created_at:at,last_seen:at,snapshot:'{"hostname":"'+name+'"}',management:1,agent_public_key:'fixture-public-key'});return {id,name,token,previous};
 }
 async function group(name){const id=randomUUID();await insert('device_groups',{id,name,created_at:Date.now()});return id;}
 async function proof(viewer){const tokenHash=randomUUID(),sessionHash=sha(viewer.id+'mfa');await insert('mfa_management_proofs',{token_hash:tokenHash,principal:viewer.principal,session_hash:sessionHash,expires_at:Date.now()+60000});return load('lib/server/identity/rbac.ts').prepareManagementAuthorization(new Request('https://fixture.test'),viewer,tokenHash);}
 try{
  const actor=await user('owner');
  return await run({d,insert,user,grant,device,group,proof,actor,load,cleaned,batches,beforeBatch:hook=>{beforeBatch=hook;}});
 }finally{await d.close();}
}

test('bulk offboarding rejects incomplete selection, missing confirmation and any denied target before mutation',async()=>fixture(async f=>{
 const {d,device,user,grant,actor,load,proof}=f,first=await device('A'),second=await device('B'),lifecycle=load('lib/server/devices/device-lifecycle.ts');
 const reader=await user('reader',['view'],'viewer'),scoped=await user('scoped',[],'admin');await grant(scoped,['manage'],'device',first.id);
 for(const [viewer,ids,confirm,status] of [[reader,[first.id],true,403],[scoped,[first.id,second.id],true,403],[actor,[],true,400],[actor,[first.id],false,400],[actor,[first.id,'invalid'],true,400],[actor,[first.id,randomUUID()],true,404],[actor,Array(101).fill(first.id),true,400]])await assert.rejects(async()=>lifecycle.removeDevices(viewer,ids,confirm,await proof(viewer)),error=>error.status===status);
 assert.deepEqual((await d.query(sql`SELECT revoked FROM servers ORDER BY name`)),[{revoked:0},{revoked:0}]);assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit`).then(row=>row===null?null:row.n),0);
}));

test('captured Owner role or session cannot partially offboard a selection after revocation',async()=>fixture(async f=>{
 const {d,device,actor,load,beforeBatch,proof}=f,a=await device('A'),b=await device('B'),lifecycle=load('lib/server/devices/device-lifecycle.ts');
 let confirmation=await proof(actor);beforeBatch(()=>d.exec(sql`UPDATE rbac_roles SET permissions='["view"]'`));
 await assert.rejects(()=>lifecycle.removeDevices(actor,[a.id,b.id],true,confirmation),error=>error.status===403);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM servers WHERE revoked=1`).then(row=>row===null?null:row.n),0);
 await d.exec(sql`UPDATE rbac_roles SET permissions='["*"]'`);
 confirmation=await proof(actor);beforeBatch(()=>d.exec(sql`DELETE FROM local_auth_sessions WHERE user_id=${actor.id}`));
 await assert.rejects(()=>lifecycle.removeDevices(actor,[a.id,b.id],true,confirmation),error=>error.status===403);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM servers WHERE revoked=1`).then(row=>row===null?null:row.n),0);assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit`).then(row=>row===null?null:row.n),0);
}));

test('a target changed after selection cancels the entire bulk admission',async()=>fixture(async f=>{
 const {d,device,actor,load,beforeBatch,proof}=f,a=await device('A'),b=await device('B');
 const confirmation=await proof(actor);beforeBatch(()=>d.exec(sql`UPDATE servers SET revoked=1,token_hash='concurrent-offboarding' WHERE id=${b.id}`));
 await assert.rejects(()=>load('lib/server/devices/device-lifecycle.ts').removeDevices(actor,[a.id,b.id],true,confirmation),error=>error.status===403);
 assert.equal(await d.one(sql`SELECT revoked FROM servers WHERE id=${a.id}`).then(row=>row===null?null:row.revoked),0,'unchanged target stays registered');assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit`).then(row=>row===null?null:row.n),0);
}));

test('bulk cleanup revokes both agent credentials, preserves other devices and supports idempotent retries',async()=>fixture(async f=>{
 const {d,insert,device,group,grant,user,actor,load,cleaned,proof}=f,a=await device('A'),b=await device('B'),keep=await device('Keep'),groupId=await group('Production'),at=Date.now(),reader=await user('reader',['view'],'viewer');
 const lifecycle=load('lib/server/devices/device-lifecycle.ts'),tokens=load('lib/server/agent/device-tokens.ts');
 for(const server of [a,b,keep]){
  await insert('device_group_members',{server_id:server.id,group_id:groupId});await grant(reader,['view'],'device',server.id);
  await insert('samples',{server_id:server.id,at,cpu:10,memory:20});await insert('device_token_nonces',{nonce_hash:sha(server.id),server_id:server.id,expires_at:at+60000});
  for(const state of ['pending','running','succeeded'])await insert('jobs',{id:randomUUID(),server_id:server.id,action:'refresh',target:'',state,created_at:at,parameters:'{"sensitive":"payload"}',result:state==='succeeded'?'Historical result':null,actor:actor.id,actor_email:actor.label,actor_principal:actor.principal});
  await insert('device_leases',{server_id:server.id,owner_kind:'job',owner_id:randomUUID(),expires_at:at+60000});
  const terminal=randomUUID(),rdp=randomUUID();
  await insert('terminal_sessions',{id:terminal,server_id:server.id,principal:actor.principal,state:'open',cols:80,rows:24,created_at:at,last_activity:at,expires_at:at+60000});await insert('terminal_frames',{id:randomUUID(),session_id:terminal,direction:'out',seq:1,data:'private output',created_at:at});
  await insert('rdp_sessions',{id:rdp,server_id:server.id,principal:actor.principal,mfa_hash:sha(actor.id+'mfa'),state:'open',key_envelope:'private envelope',key_hash:'fixture',created_at:at,last_presence:at,expires_at:at+60000});
  for(const id of [server.id,'terminal:'+server.id,'drift:'+server.id])await insert('agent_channels',{server_id:id,last_at:at});
  const transfer=randomUUID();await insert('transfers',{id:transfer,server_id:server.id,principal:actor.principal,direction:'download',path:'C:\\fixture.txt',state:'active',created_at:at,updated_at:at,expires_at:at+60000});await insert('transfer_chunks',{id:randomUUID(),transfer_id:transfer,chunk:0,size:1,sha256:sha('fixture')});
 }
 const schedule=randomUUID();await insert('runbook_schedules',{id:schedule,version_id:randomUUID(),actor:actor.principal,targets:JSON.stringify([a.id,b.id,keep.id]),parameters:'{}',sealed_secrets:JSON.stringify({[a.id]:{secret:'A'},[b.id]:{secret:'B'},[keep.id]:{secret:'Keep'}}),recurrence:'{}',next_due:at+60000,catchup_seconds:0,concurrency:1,failure_stop:0,enabled:1,approved_at:at,created_at:at});
 const result=await lifecycle.removeDevices(actor,[a.id,b.id,a.id],true,await proof(actor));assert.equal(result.removedCount,2);assert.equal(result.unchangedCount,0);assert.deepEqual(result.ids,[a.id,b.id]);assert.equal(result.cleanupPending,false);assert.equal(cleaned.length,2);
 for(const server of [a,b]){
  assert.deepEqual(await d.one(sql`SELECT revoked,snapshot,last_seen,management,agent_public_key,previous_token_hash,previous_token_expires_at,token_expires_at FROM servers WHERE id=${server.id}`),{revoked:1,snapshot:null,last_seen:null,management:0,agent_public_key:null,previous_token_hash:null,previous_token_expires_at:null,token_expires_at:null});
  for(const hash of [server.token,server.previous]){const guard=tokens.deviceTokenSql(hash);assert.equal(await d.one(sql`SELECT id FROM servers WHERE id=${server.id} AND ${guard}`),null);}
  await assert.rejects(()=>tokens.issueDeviceTokenChallenge(new Request('https://fixture.test/api/agent/token/challenge',{method:'POST',body:JSON.stringify({serverId:server.id})})),error=>error.status===403);
  for(const table of ['samples','device_leases','device_group_members','device_token_nonces'])assert.equal(await d.one(sql`SELECT count(*) AS n FROM ${sql.ident(table)} WHERE server_id=${server.id}`).then(row=>row===null?null:row.n),0,table);
  for(const id of [server.id,'terminal:'+server.id,'drift:'+server.id])assert.equal(await d.one(sql`SELECT count(*) AS n FROM agent_channels WHERE server_id=${id}`).then(row=>row===null?null:row.n),0,'agent_channels '+id);
  assert.equal(await d.one(sql`SELECT count(*) AS n FROM role_assignments WHERE scope_type='device' AND scope_id=${server.id}`).then(row=>row===null?null:row.n),0);
  assert.deepEqual((await d.query(sql`SELECT state,parameters,result FROM jobs WHERE server_id=${server.id} ORDER BY state`)),[{state:'cancelled',parameters:'{}',result:'serverMessage.device.removed'},{state:'expired',parameters:'{}',result:'serverMessage.device.removedResultUnknown'},{state:'succeeded',parameters:'{"sensitive":"payload"}',result:'Historical result'}]);
 }
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM agent_channels WHERE server_id IN (${keep.id},${'terminal:'+keep.id},${'drift:'+keep.id})`).then(row=>row===null?null:row.n),3,'other devices keep their channel slots');
 assert.equal(await d.one(sql`SELECT revoked FROM servers WHERE id=${keep.id}`).then(row=>row===null?null:row.revoked),0);assert.equal(await d.one(sql`SELECT count(*) AS n FROM samples WHERE server_id=${keep.id}`).then(row=>row===null?null:row.n),1);assert.equal(await d.one(sql`SELECT state FROM transfers WHERE server_id=${keep.id}`).then(row=>row===null?null:row.state),'active');
 const retained=await d.one(sql`SELECT targets,sealed_secrets,enabled FROM runbook_schedules WHERE id=${schedule}`);assert.deepEqual(JSON.parse(retained.targets),[keep.id]);assert.deepEqual(JSON.parse(retained.sealed_secrets),{[keep.id]:{secret:'Keep'}});assert.equal(retained.enabled,1);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit WHERE action='Gerät aus Portal entfernt'`).then(row=>row===null?null:row.n),2);
 const retry=await lifecycle.removeDevices(actor,[a.id,b.id],true,await proof(actor));assert.equal(retry.removedCount,0);assert.equal(retry.unchangedCount,2);assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit WHERE action='Gerät aus Portal entfernt'`).then(row=>row===null?null:row.n),2);
 assert.equal((await lifecycle.removeDevice(actor,keep.id,true,await proof(actor))).status,'removed','single-device endpoint retains its response contract');
}));

test('a failed bulk audit rolls back revocation and all device cleanup',async()=>fixture(async f=>{
 const {d,insert,device,actor,load,proof}=f,a=await device('A'),b=await device('B'),at=Date.now();await insert('samples',{server_id:a.id,at,cpu:1,memory:2});
 await createTrigger(d,'deny_removal_audit','audit','BEFORE INSERT',{message:'fixture-audit-denied',when:"NEW.action='Gerät aus Portal entfernt'"});
 const confirmation=await proof(actor);await assert.rejects(()=>load('lib/server/devices/device-lifecycle.ts').removeDevices(actor,[a.id,b.id],true,confirmation),/fixture-audit-denied/);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`).then(row=>row===null?null:row.n),1,'a rolled back removal keeps its proof');
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM servers WHERE revoked=1`).then(row=>row===null?null:row.n),0);assert.equal(await d.one(sql`SELECT count(*) AS n FROM samples`).then(row=>row===null?null:row.n),1);assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit`).then(row=>row===null?null:row.n),0);
}));

test('removal consumes its step-up proof in the removing batch and refuses a used or vanished proof',async()=>fixture(async f=>{
 const {d,device,actor,load,proof,batches,beforeBatch}=f,a=await device('A'),b=await device('B'),lifecycle=load('lib/server/devices/device-lifecycle.ts');
 const proofs=hash=>d.one(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${hash}`).then(row=>row===null?null:row.n);
 const removalAudit=()=>d.one(sql`SELECT count(*) AS n FROM audit WHERE action='Gerät aus Portal entfernt'`).then(row=>row===null?null:row.n);
 // The proof row disappears between the checks and the batch: nothing is removed.
 const vanishing=await proof(actor);beforeBatch(()=>d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${vanishing.tokenHash}`));
 await assert.rejects(()=>lifecycle.removeDevices(actor,[a.id,b.id],true,vanishing),error=>error.status===403&&error.code==='MFA_STEP_UP_REQUIRED');
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM servers WHERE revoked=1`).then(row=>row===null?null:row.n),0);assert.equal(await removalAudit(),0);
 // A valid proof removes exactly as before, and the same batch deletes the proof.
 const confirmation=await proof(actor);batches.length=0;
 const result=await lifecycle.removeDevices(actor,[a.id,b.id],true,confirmation);assert.equal(result.removedCount,2);
 assert.equal(await proofs(confirmation.tokenHash),0,'the proof is consumed');assert.equal(await removalAudit(),2);
 const removing=batches.find(batch=>batch.some(sql=>/^UPDATE servers SET revoked=1/.test(sql)));
 assert.ok(removing?.some(sql=>/^DELETE FROM mfa_management_proofs\b/.test(sql)),'the removing batch deletes the proof');
 assert.ok(removing.findIndex(sql=>/^DELETE FROM mfa_management_proofs\b/.test(sql))>removing.findIndex(sql=>/^UPDATE servers SET revoked=1/.test(sql)),'the proof is deleted after the admitting update');
 // Reusing the consumed proof is refused before anything changes.
 const keep=await device('Keep');
 await assert.rejects(()=>lifecycle.removeDevice(actor,keep.id,true,confirmation),error=>error.status===403&&error.code==='MFA_STEP_UP_REQUIRED');
 assert.equal(await d.one(sql`SELECT revoked FROM servers WHERE id=${keep.id}`).then(row=>row===null?null:row.revoked),0);assert.equal(await removalAudit(),2);
}));

test('group deletion requires explicit confirmation, global grouping and assignment authority',async()=>fixture(async f=>{
 const {d,group,user,grant,proof,actor,load}=f,rbac=load('lib/server/identity/rbac.ts'),groupId=await group('Production'),manager=await user('manager',['groups.manage'],'operator'),reader=await user('reader',['view'],'viewer'),scoped=await user('scoped',[],'operator');await grant(scoped,['groups.manage'],'devicegroup',groupId);await grant(reader,['view'],'devicegroup',groupId);
 for(const [viewer,id,confirm,status] of [[actor,groupId,false,400],[reader,groupId,true,403],[scoped,groupId,true,403],[manager,groupId,true,403]]){const confirmation=await proof(viewer);await assert.rejects(()=>rbac.deleteDeviceGroup(viewer,id,confirm,confirmation),error=>error.status===status);}
 assert.ok(await d.one(sql`SELECT id FROM device_groups WHERE id=${groupId}`));assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit`).then(row=>row===null?null:row.n),0);
}));

test('group deletion atomically cleans direct/group assignments while retaining devices and unrelated scopes',async()=>fixture(async f=>{
 const {d,insert,group,device,user,grant,proof,actor,load}=f,rbac=load('lib/server/identity/rbac.ts'),groupId=await group('Production'),other=await group('Keep'),a=await device('A'),b=await device('Keep'),reader=await user('reader',['view'],'viewer'),userGroup=randomUUID(),at=Date.now();
 await insert('user_groups',{id:userGroup,name:'Operators',enabled:1,created_at:at});await insert('user_group_members',{group_id:userGroup,user_id:reader.id});
 await grant(reader,['view'],'devicegroup',groupId);await grant(reader,['view'],'devicegroup',groupId,'group',userGroup);const retainedAssignment=await grant(reader,['view'],'devicegroup',other),directAssignment=await grant(reader,['view'],'device',a.id);
 await insert('device_group_members',{server_id:a.id,group_id:groupId});await insert('device_group_members',{server_id:b.id,group_id:other});
 const confirmation=await proof(actor);assert.deepEqual(await rbac.deleteDeviceGroup(actor,groupId,true,confirmation),{ok:true,id:groupId});
 assert.equal(await d.one(sql`SELECT id FROM device_groups WHERE id=${groupId}`),null);assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_group_members WHERE group_id=${groupId}`).then(row=>row===null?null:row.n),0);assert.equal(await d.one(sql`SELECT count(*) AS n FROM role_assignments WHERE scope_type='devicegroup' AND scope_id=${groupId}`).then(row=>row===null?null:row.n),0);
 for(const id of [retainedAssignment,directAssignment])assert.ok(await d.one(sql`SELECT id FROM role_assignments WHERE id=${id}`));assert.equal(await d.one(sql`SELECT group_id FROM device_group_members WHERE server_id=${b.id}`).then(row=>row===null?null:row.group_id),other);assert.equal(await d.one(sql`SELECT count(*) AS n FROM servers WHERE revoked=0`).then(row=>row===null?null:row.n),2);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM mfa_sessions WHERE principal=${reader.principal}`).then(row=>row===null?null:row.n),0,'affected privileged sessions are revoked');assert.equal(await d.one(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE user_id=${reader.id}`).then(row=>row===null?null:row.n),0);assert.equal(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`),null);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit WHERE action='Gerätegruppe gelöscht'`).then(row=>row===null?null:row.n),1);
}));

test('group proof/permission races and a late SQL failure cannot partially delete memberships or grants',async()=>fixture(async f=>{
 const {d,insert,group,device,proof,actor,load,beforeBatch}=f,rbac=load('lib/server/identity/rbac.ts'),groupId=await group('Production'),a=await device('A');await insert('device_group_members',{server_id:a.id,group_id:groupId});
 let confirmation=await proof(actor);beforeBatch(()=>d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`));await assert.rejects(()=>rbac.deleteDeviceGroup(actor,groupId,true,confirmation),error=>error.status===403);assert.ok(await d.one(sql`SELECT server_id FROM device_group_members WHERE group_id=${groupId}`));
 confirmation=await proof(actor);beforeBatch(()=>d.exec(sql`UPDATE rbac_roles SET permissions='["view"]'`));await assert.rejects(()=>rbac.deleteDeviceGroup(actor,groupId,true,confirmation),error=>error.status===403);assert.ok(await d.one(sql`SELECT id FROM device_groups WHERE id=${groupId}`));await d.exec(sql`UPDATE rbac_roles SET permissions='["*"]'`);
 confirmation=await proof(actor);await createTrigger(d,'deny_group_delete','device_groups','BEFORE DELETE',{message:'fixture-group-delete-denied'});await assert.rejects(()=>rbac.deleteDeviceGroup(actor,groupId,true,confirmation),/fixture-group-delete-denied/);
 assert.ok(await d.one(sql`SELECT server_id FROM device_group_members WHERE group_id=${groupId}`));assert.ok(await d.one(sql`SELECT id FROM device_groups WHERE id=${groupId}`));assert.ok(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`));assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit`).then(row=>row===null?null:row.n),0);
}));

test('a concurrently added group assignment requires assignment authority before any cleanup',async()=>fixture(async f=>{
 const {d,insert,group,device,user,grant,proof,load,beforeBatch}=f,manager=await user('manager',['groups.manage'],'operator'),reader=await user('reader',['view'],'viewer'),groupId=await group('Production'),a=await device('A');await insert('device_group_members',{server_id:a.id,group_id:groupId});
 const confirmation=await proof(manager);beforeBatch(()=>grant(reader,['view'],'devicegroup',groupId));await assert.rejects(()=>load('lib/server/identity/rbac.ts').deleteDeviceGroup(manager,groupId,true,confirmation),error=>error.status===403);
 assert.ok(await d.one(sql`SELECT id FROM device_groups WHERE id=${groupId}`));assert.ok(await d.one(sql`SELECT server_id FROM device_group_members WHERE group_id=${groupId}`));assert.equal(await d.one(sql`SELECT count(*) AS n FROM role_assignments WHERE scope_type='devicegroup' AND scope_id=${groupId}`).then(row=>row===null?null:row.n),1);assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit`).then(row=>row===null?null:row.n),0);
}));

test('an admitted group deletion completes atomically when its proof expires during the transaction',async()=>fixture(async f=>{
 const {d,insert,group,device,user,proof,load}=f,manager=await user('manager',['groups.manage'],'operator'),groupId=await group('Production'),a=await device('A');await insert('device_group_members',{server_id:a.id,group_id:groupId});const confirmation=await proof(manager);
 await createTrigger(d,'expire_admitted_proof','audit','AFTER INSERT',{when:"NEW.action='Gerätegruppe gelöscht'",body:'UPDATE mfa_management_proofs SET expires_at=0;'});
 assert.deepEqual(await load('lib/server/identity/rbac.ts').deleteDeviceGroup(manager,groupId,true,confirmation),{ok:true,id:groupId});assert.equal(await d.one(sql`SELECT id FROM device_groups WHERE id=${groupId}`),null);assert.equal(await d.one(sql`SELECT server_id FROM device_group_members WHERE server_id=${a.id}`),null);assert.equal(await d.one(sql`SELECT revoked FROM servers WHERE id=${a.id}`).then(row=>row===null?null:row.revoked),0);assert.equal(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`),null);assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit WHERE action='Gerätegruppe gelöscht'`).then(row=>row===null?null:row.n),1);
}));

for(const [table,event] of [['jobs','UPDATE'],['local_auth_sessions','DELETE']])test(`a ${table} revocation failure rolls back the group, grants, audit and all credential changes`,async()=>fixture(async f=>{
 const {d,insert,group,device,user,grant,proof,actor,load}=f,rbac=load('lib/server/identity/rbac.ts'),groupId=await group('Production'),a=await device('A'),recipient=await user('recipient',['view'],'viewer'),unaffected=await user('unaffected',['view'],'viewer'),at=Date.now();
 const assignment=await grant(recipient,['view'],'devicegroup',groupId),pendingJob=randomUUID(),retainedJob=randomUUID(),terminal=randomUUID(),rdp=randomUUID(),transfer=randomUUID(),run=randomUUID();
 await insert('device_group_members',{server_id:a.id,group_id:groupId});
 for(const [id,viewer] of [[pendingJob,recipient],[retainedJob,unaffected]])await insert('jobs',{id,server_id:a.id,action:'refresh',target:'',state:'pending',parameters:'{"private":"payload"}',created_at:at,actor:viewer.id,actor_email:viewer.label,actor_principal:viewer.principal});
 await insert('terminal_sessions',{id:terminal,server_id:a.id,principal:recipient.principal,state:'open',cols:80,rows:24,created_at:at,last_activity:at,expires_at:at+60000});
 await insert('rdp_sessions',{id:rdp,server_id:a.id,principal:recipient.principal,mfa_hash:sha(recipient.id+'mfa'),state:'open',key_envelope:'private envelope',key_hash:'fixture',created_at:at,last_presence:at,expires_at:at+60000});
 await insert('rdp_frames',{session_id:rdp,direction:'out',seq:1,data:'private frame',created_at:at});
 await insert('transfers',{id:transfer,server_id:a.id,principal:recipient.principal,direction:'download',path:'C:\\fixture.txt',state:'active',created_at:at,updated_at:at,expires_at:at+60000});
 await insert('runbook_runs',{id:run,version_id:randomUUID(),actor:recipient.principal,state:'running',parameters:'{}',concurrency:1,failure_stop:0,created_at:at,expires_at:at+60000});
 const recipientProof=await proof(recipient),confirmation=await proof(actor);
 await createTrigger(d,'fail_group_revocation',table,`BEFORE ${event}`,{message:'fixture-revocation-denied'});
 await assert.rejects(()=>rbac.deleteDeviceGroup(actor,groupId,true,confirmation),/fixture-revocation-denied/);
 assert.ok(await d.one(sql`SELECT id FROM device_groups WHERE id=${groupId}`));assert.ok(await d.one(sql`SELECT server_id FROM device_group_members WHERE group_id=${groupId}`));assert.ok(await d.one(sql`SELECT id FROM role_assignments WHERE id=${assignment}`));
 assert.equal(await d.one(sql`SELECT state FROM jobs WHERE id=${pendingJob}`).then(row=>row===null?null:row.state),'pending');assert.equal(await d.one(sql`SELECT parameters FROM jobs WHERE id=${pendingJob}`).then(row=>row===null?null:row.parameters),'{"private":"payload"}');
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM mfa_sessions WHERE principal=${recipient.principal}`).then(row=>row===null?null:row.n),1);assert.equal(await d.one(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE user_id=${recipient.id}`).then(row=>row===null?null:row.n),1);
 for(const token of [confirmation.tokenHash,recipientProof.tokenHash])assert.ok(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${token}`));assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit`).then(row=>row===null?null:row.n),0);
 assert.equal(await d.one(sql`SELECT state FROM terminal_sessions WHERE id=${terminal}`).then(row=>row===null?null:row.state),'open');assert.equal(await d.one(sql`SELECT key_envelope FROM rdp_sessions WHERE id=${rdp}`).then(row=>row===null?null:row.key_envelope),'private envelope');assert.equal(await d.one(sql`SELECT state FROM transfers WHERE id=${transfer}`).then(row=>row===null?null:row.state),'active');assert.equal(await d.one(sql`SELECT cancel_requested FROM runbook_runs WHERE id=${run}`).then(row=>row===null?null:row.cancel_requested),0);
 await dropTrigger(d,'fail_group_revocation');assert.deepEqual(await rbac.deleteDeviceGroup(actor,groupId,true,confirmation),{ok:true,id:groupId},'the same rolled-back proof can safely retry');
 assert.equal(await d.one(sql`SELECT id FROM device_groups WHERE id=${groupId}`),null);assert.equal(await d.one(sql`SELECT state FROM jobs WHERE id=${pendingJob}`).then(row=>row===null?null:row.state),'cancelled');assert.equal(await d.one(sql`SELECT parameters FROM jobs WHERE id=${pendingJob}`).then(row=>row===null?null:row.parameters),'{}');assert.equal(await d.one(sql`SELECT state FROM jobs WHERE id=${retainedJob}`).then(row=>row===null?null:row.state),'pending');
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM mfa_sessions WHERE principal=${recipient.principal}`).then(row=>row===null?null:row.n),0);assert.equal(await d.one(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE user_id=${recipient.id}`).then(row=>row===null?null:row.n),0);assert.equal(await d.one(sql`SELECT count(*) AS n FROM mfa_sessions WHERE principal=${unaffected.principal}`).then(row=>row===null?null:row.n),1);assert.equal(await d.one(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE user_id=${unaffected.id}`).then(row=>row===null?null:row.n),1);
 assert.equal(await d.one(sql`SELECT state FROM terminal_sessions WHERE id=${terminal}`).then(row=>row===null?null:row.state),'closed');assert.deepEqual(await d.one(sql`SELECT state,key_envelope FROM rdp_sessions WHERE id=${rdp}`),{state:'closed',key_envelope:null});assert.equal(await d.one(sql`SELECT count(*) AS n FROM rdp_frames WHERE session_id=${rdp}`).then(row=>row===null?null:row.n),0);assert.equal(await d.one(sql`SELECT state FROM transfers WHERE id=${transfer}`).then(row=>row===null?null:row.state),'cancelled');assert.equal(await d.one(sql`SELECT cancel_requested FROM runbook_runs WHERE id=${run}`).then(row=>row===null?null:row.cancel_requested),1);
 for(const token of [confirmation.tokenHash,recipientProof.tokenHash])assert.equal(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${token}`),null);assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit WHERE action='Gerätegruppe gelöscht'`).then(row=>row===null?null:row.n),1);
}));

test('a group-assigned Owner can delete the group while atomically revoking their own sessions and proof',async()=>fixture(async f=>{
 const {d,group,grant,proof,actor,load}=f,groupId=await group('Production');await grant(actor,['view'],'devicegroup',groupId);const confirmation=await proof(actor);
 assert.deepEqual(await load('lib/server/identity/rbac.ts').deleteDeviceGroup(actor,groupId,true,confirmation),{ok:true,id:groupId});assert.equal(await d.one(sql`SELECT id FROM device_groups WHERE id=${groupId}`),null);assert.equal(await d.one(sql`SELECT count(*) AS n FROM mfa_sessions WHERE principal=${actor.principal}`).then(row=>row===null?null:row.n),0);assert.equal(await d.one(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE user_id=${actor.id}`).then(row=>row===null?null:row.n),0);assert.equal(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`),null);assert.equal(await d.one(sql`SELECT count(*) AS n FROM role_assignments WHERE principal_id=${actor.id} AND scope_type='global'`).then(row=>row===null?null:row.n),1);assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit WHERE action='Gerätegruppe gelöscht'`).then(row=>row===null?null:row.n),1);
}));
