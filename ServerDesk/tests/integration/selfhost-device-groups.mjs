// Device groups on PostgreSQL: the hierarchy and its depth, parent rights for descendant devices, membership
// moves and their guards (pnpm test:selfhost).
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import {sql} from '../../runtime/database.mjs';
import {createTrigger,dropTrigger,inTransaction,insertRow,sourceDatabase} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {serverDeskRoot} from '../support/paths.mjs';

const root=serverDeskRoot,require=createRequire(import.meta.url);
async function fixture(run){
 const d=await sourceDatabase(),cache=new Map();let beforeBatch=async()=>{};
 // beforeBatch runs once, before the next transaction starts.
 const facade=hookDatabase(d,{transaction:async()=>{const hook=beforeBatch;beforeBatch=async()=>{};await hook();}});
 const HttpError=realHttpError;
 const server={db:()=>facade,guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value),HttpError,now:()=>Date.now(),log:async()=>{}};
 function load(filename){
  const absolute=resolve(root,filename),relative=absolute.slice(root.length).replaceAll('\\','/');
  if(relative==='lib/server/context.ts')return server;
  if(relative==='lib/server/identity/mfa.ts')return {};
  if(cache.has(absolute))return cache.get(absolute).exports;
  const loaded={exports:{}};cache.set(absolute,loaded);
  const code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const localRequire=id=>id.startsWith('.')?(/[.]m?js$/.test(id)?require(resolve(dirname(absolute),id)):load(resolve(dirname(absolute),id)+'.ts')):require(id);
  new Function('require','module','exports',code)(localRequire,loaded,loaded.exports);return loaded.exports;
 }
 const insert=(table,row)=>insertRow(d,table,row);
 async function user(name,permissions=['*']){
  const id=randomUUID(),at=Date.now(),principal='private:'+name+'@groups.test';
  await insert('local_users',{id,username:name,display_name:name,auth_principal:principal,auth_email:name+'@groups.test',status:'active',created_at:at,updated_at:at});
  const viewer=Object.defineProperty({id,principal,label:name+'@groups.test'},'authorization',{value:{authVersion:1},enumerable:false});
  if(permissions.length)await grant(viewer,permissions);return viewer;
 }
 async function grant(viewer,permissions,scopeType='global',scopeId='*'){
  const roleId=randomUUID();await insert('rbac_roles',{id:roleId,name:roleId,permissions:JSON.stringify(permissions),created_at:Date.now()});
  await insert('role_assignments',{id:randomUUID(),principal_type:'user',principal_id:viewer.id,role_id:roleId,scope_type:scopeType,scope_id:scopeId,created_at:Date.now(),created_by:'fixture'});return roleId;
 }
 async function group(name,parentId=null){const id=randomUUID();await insert('device_groups',{id,name,parent_id:parentId,created_at:Date.now()});return id;}
 async function device(name){const id=randomUUID();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:Date.now()});return id;}
 async function proof(viewer){
  const tokenHash=randomUUID(),sessionHash=randomUUID();await insert('mfa_management_proofs',{token_hash:tokenHash,principal:viewer.principal,session_hash:sessionHash,expires_at:Date.now()+60000});
  // The proof is its own guard fragment and carries the fields of a management authorization.
  const guard=sql`EXISTS (SELECT 1 FROM mfa_management_proofs WHERE token_hash=${tokenHash} AND expires_at>${Date.now()})`;
  return Object.assign(Object.create(guard),{tokenHash,key:viewer.principal,sessionHash,guard});
 }
 try{return await run({d,insert,user,grant,group,device,proof,load,beforeBatch:hook=>{beforeBatch=hook;},owner:await user('owner')});}finally{await d.close();}
}

test('hierarchy preserves roots, allows four child levels and rejects cycles, missing parents and depth overflow in the database',async()=>fixture(async({d,group,load})=>{
 const levels=[await group('Root')];for(let n=1;n<=4;n++)levels.push(await group('Level '+n,levels[n-1]));
 assert.deepEqual(await load('lib/server/devices/device-groups.ts').deviceGroupAncestors(levels[4]),levels.toReversed().map((id,depth)=>({id,depth})));
 await assert.rejects(()=>group('Too deep',levels[4]),/device-group-depth-limit/);
 await assert.rejects(()=>group('Missing',randomUUID()),/device-group-parent-missing/);
 await assert.rejects(()=>d.exec(sql`UPDATE device_groups SET parent_id=${levels[4]} WHERE id=${levels[0]}`),/device-group-cycle/);
 await assert.rejects(()=>d.exec(sql`UPDATE device_groups SET parent_id=${levels[1]} WHERE id=${levels[1]}`),/device-group-cycle/);
 const other=await group('Other');await assert.rejects(()=>d.exec(sql`UPDATE device_groups SET parent_id=${other} WHERE id=${levels[0]}`),/device-group-depth-limit/);
 await assert.rejects(()=>d.exec(sql`DELETE FROM device_groups WHERE id=${levels[0]}`),/device-group-has-children/);
 assert.equal(await d.one(sql`SELECT parent_id FROM device_groups WHERE id=${levels[0]}`).then(row=>row===null?null:row.parent_id),null);
 const path=await load('lib/server/devices/device-groups.ts').deviceGroupPath(levels[4]);assert.deepEqual(path.map(row=>row.name),['Root','Level 1','Level 2','Level 3','Level 4']);
}));

test('parent RBAC reaches descendant devices and grants without leaking to sibling roots',async()=>fixture(async f=>{
 const {d,insert,user,grant,group,device,load}=f,rootGroup=await group('Root'),child=await group('Child',rootGroup),deep=await group('Deep',child),other=await group('Other'),a=await device('A'),b=await device('B'),c=await device('C');
 await insert('device_group_members',{server_id:a,group_id:deep});await insert('device_group_members',{server_id:b,group_id:child});await insert('device_group_members',{server_id:c,group_id:other});
 await assert.rejects(()=>insert('device_group_members',{server_id:a,group_id:other}),error=>error.code==='23505'&&error.constraint_name==='idx_device_group_members_server','a device cannot join a second root');
 const reader=await user('reader',[]);await grant(reader,['view','groups.manage'],'devicegroup',rootGroup);
 const access=load('lib/server/identity/access.ts');assert.deepEqual((await access.allowedDeviceIds(reader)).sort(),[a,b].sort());assert.deepEqual((await access.allowedGroupIds(reader,'groups.manage')).sort(),[rootGroup,child,deep].sort());
 assert.ok((await access.groupPermissions(reader,deep)).includes('groups.manage'));assert.ok((await access.permissionsFor(reader,a)).includes('view'));assert.equal((await access.permissionsFor(reader,c)).includes('view'),false);await access.requireDevice(reader,a);await assert.rejects(()=>access.requireDevice(reader,c),error=>error.status===403);
 const guard=load('lib/server/identity/feature-authorization.ts').featureTargetsGuard(reader,[a,b],['view']);assert.ok(await d.one(sql`SELECT 1 AS allowed WHERE ${guard}`));
 const denied=load('lib/server/identity/feature-authorization.ts').featureTargetsGuard(reader,[a,c],['view']);assert.equal(await d.one(sql`SELECT 1 AS allowed WHERE ${denied}`),null);
 assert.deepEqual((await load('lib/server/devices/device-groups.ts').deviceGroupDeviceIds(rootGroup)).sort(),[a,b].sort());
 await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${b}`);assert.deepEqual(await load('lib/server/devices/device-groups.ts').deviceGroupDeviceIds(rootGroup),[a]);
 const inheritedUsers=await load('lib/server/identity/rbac.ts').affectedDeviceGroupUsers(deep);assert.ok(inheritedUsers.some(row=>row.auth_principal===reader.principal));
}));

test('checkbox batches move added devices and remove unchecked ones; legacy replace remains explicit',async()=>fixture(async f=>{
 const {d,insert,group,device,proof,owner,load}=f,target=await group('Target'),other=await group('Other'),a=await device('A'),b=await device('B');
 await insert('device_group_members',{server_id:a,group_id:target});await insert('device_group_members',{server_id:b,group_id:other});
 const membership=load('lib/server/devices/device-group-membership.ts'),confirmation=await proof(owner);
 assert.deepEqual(await membership.changeDeviceMemberships(owner,[b],target,true,confirmation,false,[a]),{ok:true,count:2});
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_group_members WHERE server_id=${a}`).then(row=>row===null?null:row.n),0,'an unchecked device leaves the group');
 assert.deepEqual((await d.query(sql`SELECT group_id FROM device_group_members WHERE server_id=${b}`)),[{group_id:target}],'a checked device moves out of its previous group');
 // Organizing devices is routine (lib/step-up.ts): the guard is a session fence, nothing is consumed.
 assert.equal(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`).then(row=>row===null?null:row.token_hash),confirmation.tokenHash,'no proof is consumed');
 await d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`);
 await assert.rejects(()=>membership.changeDeviceMemberships(owner,[b],target,false,confirmation),error=>error.status===403,'a fence that no longer holds refuses the change');
 await membership.changeDeviceMemberships(owner,[b],other,true,await proof(owner),true);assert.deepEqual((await d.query(sql`SELECT group_id FROM device_group_members WHERE server_id=${b}`)),[{group_id:other}]);
 await membership.changeDeviceMemberships(owner,[b],null,true,await proof(owner),true);assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_group_members WHERE server_id=${b}`).then(row=>row===null?null:row.n),0);
}));

test('adding a device to any group moves it along its path and across independent branches',async()=>fixture(async({d,insert,group,device,proof,owner,load})=>{
 const rootGroup=await group('Root'),child=await group('Child',rootGroup),deep=await group('Deep',child),sibling=await group('Sibling',rootGroup),other=await group('Other'),a=await device('A'),membership=load('lib/server/devices/device-group-membership.ts');
 const members=async()=>((await d.query(sql`SELECT group_id FROM device_group_members WHERE server_id=${a} ORDER BY group_id`)).map(row=>row.group_id));
 await insert('device_group_members',{server_id:a,group_id:rootGroup});
 await membership.changeDeviceMemberships(owner,[a],child,true,await proof(owner));assert.deepEqual(await members(),[child]);
 await membership.changeDeviceMemberships(owner,[a],deep,true,await proof(owner));assert.deepEqual(await members(),[deep]);
 await membership.changeDeviceMemberships(owner,[a],sibling,true,await proof(owner));assert.deepEqual(await members(),[sibling],'a sibling branch replaces the previous membership');
 await membership.changeDeviceMemberships(owner,[a],other,true,await proof(owner));assert.deepEqual(await members(),[other],'an independent root replaces the previous membership');
 await membership.changeDeviceMemberships(owner,[a],rootGroup,true,await proof(owner));assert.deepEqual(await members(),[rootGroup]);
 await membership.changeDeviceMemberships(owner,[a],child,true,await proof(owner));await membership.changeDeviceMemberships(owner,[a],child,true,await proof(owner));assert.deepEqual(await members(),[child],'repeated selection neither duplicates nor erases the membership');
 assert.deepEqual(await load('lib/server/devices/device-groups.ts').deviceGroupDeviceIds(rootGroup),[a],'parent scope still inherits the child device');
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit WHERE action='Gerätezuordnung geändert'`).then(row=>row===null?null:row.n),7);
}));

test('the database rejects a second membership on insert/update and keeps the path error for ancestor pairs',async()=>fixture(async({d,insert,group,device,load})=>{
 const rootGroup=await group('Root'),child=await group('Child',rootGroup),deep=await group('Deep',child),sibling=await group('Sibling',rootGroup),other=await group('Other'),otherChild=await group('Other child',other),a=await device('A'),b=await device('B');
 await insert('device_group_members',{server_id:a,group_id:deep});
 await assert.rejects(()=>insert('device_group_members',{server_id:a,group_id:rootGroup}),/device-group-membership-path-conflict/);
 await assert.rejects(()=>insert('device_group_members',{server_id:a,group_id:child}),/device-group-membership-path-conflict/);
 await assert.rejects(()=>insert('device_group_members',{server_id:a,group_id:sibling}),error=>error.code==='23505'&&error.constraint_name==='idx_device_group_members_server');
 await assert.rejects(()=>insert('device_group_members',{server_id:a,group_id:otherChild}),error=>error.code==='23505'&&error.constraint_name==='idx_device_group_members_server');
 await insert('device_group_members',{server_id:b,group_id:rootGroup});await assert.rejects(()=>insert('device_group_members',{server_id:b,group_id:deep}),/device-group-membership-path-conflict/);
 await assert.rejects(()=>insert('device_group_members',{server_id:b,group_id:otherChild}),error=>error.code==='23505'&&error.constraint_name==='idx_device_group_members_server');
 await assert.rejects(()=>d.exec(sql`UPDATE device_group_members SET server_id=${a} WHERE server_id=${b} AND group_id=${rootGroup}`),/device-group-membership-path-conflict/);
 await d.exec(sql`UPDATE device_group_members SET group_id=group_id WHERE server_id=${a} AND group_id=${deep}`);
 await d.exec(sql`UPDATE device_group_members SET group_id=${child} WHERE server_id=${b} AND group_id=${rootGroup}`);assert.equal(await d.one(sql`SELECT group_id FROM device_group_members WHERE server_id=${b}`).then(row=>row===null?null:row.group_id),child,'one direct membership can be moved with UPDATE');
 await d.exec(sql`UPDATE device_group_members SET group_id=${otherChild} WHERE server_id=${b} AND group_id=${child}`);assert.equal(await d.one(sql`SELECT group_id FROM device_group_members WHERE server_id=${b}`).then(row=>row===null?null:row.group_id),otherChild,'UPDATE moves across branches as well');
 const independentParent=await group('Independent parent');await d.exec(sql`UPDATE device_groups SET parent_id=${independentParent} WHERE id=${other}`);assert.equal(await d.one(sql`SELECT parent_id FROM device_groups WHERE id=${other}`).then(row=>row===null?null:row.parent_id),independentParent,'reparenting stays valid because a device has one membership');
 // Driver errors in the PostgreSQL shape: SQLSTATE, severity and the constraint name.
 const {deviceGroupConflict}=load('lib/server/devices/device-groups.ts'),driverError=(message,code,constraint)=>Object.assign(new Error(message),{code,severity:'ERROR',...(constraint?{constraint_name:constraint}:{})});
 const unique=()=>driverError('duplicate key value violates unique constraint "idx_device_group_members_server"','23505','idx_device_group_members_server');
 const path=deviceGroupConflict(driverError('device-group-membership-path-conflict','P0001'));
 assert.equal(path.status,409);assert.equal(path.messageKey,'apiError.group.membershipPathConflict');assert.equal(path.code,'DEVICE_GROUP_MEMBERSHIP_PATH_CONFLICT');
 const taken=deviceGroupConflict(unique());
 assert.equal(taken.status,409);assert.equal(taken.messageKey,'apiError.group.membershipTaken');assert.equal(taken.code,'DEVICE_GROUP_MEMBERSHIP_TAKEN');
 const mapped=load('lib/server/identity/rbac.ts').rbacFailure(unique());assert.equal(mapped.status,409);assert.equal(mapped.messageKey,'apiError.group.membershipTaken');
}));

test('delegated moves need only changed source and target permissions and preserve unrelated-user sessions',async()=>fixture(async({d,insert,user,grant,group,device,proof,load})=>{
 const rootGroup=await group('Managed'),child=await group('Child',rootGroup),other=await group('Unrelated'),a=await device('A'),manager=await user('manager',[]),localReader=await user('local-reader',[]),otherReader=await user('other-reader',[]),membership=load('lib/server/devices/device-group-membership.ts');
 await grant(manager,['view','groups.manage'],'devicegroup',rootGroup);await grant(localReader,['view'],'devicegroup',rootGroup);await grant(otherReader,['view'],'devicegroup',other);
 await insert('device_group_members',{server_id:a,group_id:rootGroup});
 for(const viewer of[localReader,otherReader])await insert('mfa_sessions',{token_hash:viewer.id,principal:viewer.principal,created_at:Date.now(),last_activity:Date.now(),idle_expires_at:Date.now()+60000,expires_at:Date.now()+60000});
 await insert('jobs',{id:randomUUID(),server_id:a,action:'refresh',target:'fixture',parameters:'{}',created_at:Date.now(),actor:otherReader.id,actor_email:otherReader.label,actor_principal:otherReader.principal});
 await membership.changeDeviceMemberships(manager,[a],child,true,await proof(manager));
 assert.deepEqual((await d.query(sql`SELECT group_id FROM device_group_members WHERE server_id=${a}`)).map(row=>row.group_id),[child]);
 assert.equal(await d.one(sql`SELECT token_hash FROM mfa_sessions WHERE principal=${localReader.principal}`),null,'users of changed ancestor scope are revoked');
 assert.ok(await d.one(sql`SELECT token_hash FROM mfa_sessions WHERE principal=${otherReader.principal}`),'users of unchanged independent scope retain their session');
 assert.equal(await d.one(sql`SELECT state FROM jobs WHERE actor=${otherReader.id}`).then(row=>row===null?null:row.state),'pending','unrelated-root user job is not cancelled');
 const childOnly=await user('child-only',[]),b=await device('B');await grant(childOnly,['groups.manage'],'devicegroup',child);await grant(childOnly,['view'],'device',b);await insert('device_group_members',{server_id:b,group_id:rootGroup});
 const confirmation=await proof(childOnly);await assert.rejects(()=>membership.changeDeviceMemberships(childOnly,[b],child,true,confirmation),error=>error.status===403);
 assert.equal(await d.one(sql`SELECT group_id FROM device_group_members WHERE server_id=${b}`).then(row=>row===null?null:row.group_id),rootGroup,'target permission cannot authorize removal from an unmanaged ancestor');
 assert.ok(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`),'denied source move leaves MFA proof unconsumed');
 const c=await device('C');await grant(manager,['view'],'device',c);await insert('device_group_members',{server_id:c,group_id:other});
 const crossBranch=await proof(manager);await assert.rejects(()=>membership.changeDeviceMemberships(manager,[c],child,true,crossBranch),error=>error.status===403);
 assert.equal(await d.one(sql`SELECT group_id FROM device_group_members WHERE server_id=${c}`).then(row=>row===null?null:row.group_id),other,'a move out of an unmanaged independent root is refused');
 assert.ok(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${crossBranch.tokenHash}`));
}));

test('complete ancestry CAS rejects a changed target or source hierarchy before a move',async()=>fixture(async({d,insert,group,device,proof,owner,load,beforeBatch})=>{
 const rootGroup=await group('Root'),target=await group('Target',rootGroup),other=await group('Other'),newParent=await group('New parent'),a=await device('A'),membership=load('lib/server/devices/device-group-membership.ts');
 await insert('device_group_members',{server_id:a,group_id:other});
 let confirmation=await proof(owner);beforeBatch(()=>d.exec(sql`UPDATE device_groups SET parent_id=${newParent} WHERE id=${target}`));
 await assert.rejects(()=>membership.changeDeviceMemberships(owner,[a],target,true,confirmation),error=>error.status===403);
 assert.ok(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`));
 await d.exec(sql`UPDATE device_groups SET parent_id=${rootGroup} WHERE id=${target}`);
 confirmation=await proof(owner);beforeBatch(()=>d.exec(sql`UPDATE device_groups SET parent_id=${newParent} WHERE id=${other}`));
 await assert.rejects(()=>membership.changeDeviceMemberships(owner,[a],target,true,confirmation),error=>error.status===403);
 assert.deepEqual((await d.query(sql`SELECT group_id FROM device_group_members WHERE server_id=${a}`)).map(row=>row.group_id),[other]);
 assert.ok(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`));
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit WHERE action='Gerätezuordnung geändert'`).then(row=>row===null?null:row.n),0,'failed ancestry CAS causes no partial audit/revocation/membership writes');
}));

test('source permission revoked at commit cannot move a device despite live target/view rights',async()=>fixture(async({d,insert,user,grant,group,device,proof,load,beforeBatch})=>{
 const rootGroup=await group('Source'),child=await group('Target',rootGroup),a=await device('A'),manager=await user('move-manager',[]);
 const sourceRole=await grant(manager,['groups.manage'],'devicegroup',rootGroup);await grant(manager,['groups.manage'],'devicegroup',child);await grant(manager,['view'],'device',a);await insert('device_group_members',{server_id:a,group_id:rootGroup});
 const confirmation=await proof(manager);beforeBatch(()=>d.exec(sql`UPDATE rbac_roles SET permissions='[]' WHERE id=${sourceRole}`));
 await assert.rejects(()=>load('lib/server/devices/device-group-membership.ts').changeDeviceMemberships(manager,[a],child,true,confirmation),error=>error.status===403);
 assert.ok((await load('lib/server/identity/access.ts').groupPermissions(manager,child)).includes('groups.manage'),'target permission remains live');
 assert.ok((await load('lib/server/identity/access.ts').permissionsFor(manager,a)).includes('view'),'canonical device view remains live');
 assert.equal(await d.one(sql`SELECT group_id FROM device_group_members WHERE server_id=${a}`).then(row=>row===null?null:row.group_id),rootGroup);
 assert.ok(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`));
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit WHERE action='Gerätezuordnung geändert'`).then(row=>row===null?null:row.n),0);
}));

test('path move, proof and ancestor-user revocation roll back atomically when cleanup fails',async()=>fixture(async({d,insert,user,grant,group,device,proof,owner,load})=>{
 const rootGroup=await group('Source'),child=await group('Target',rootGroup),a=await device('A'),reader=await user('path-reader',[]);await grant(reader,['view'],'devicegroup',rootGroup);
 await insert('device_group_members',{server_id:a,group_id:rootGroup});
 await insert('mfa_sessions',{token_hash:'path-reader-session',principal:reader.principal,created_at:Date.now(),last_activity:Date.now(),idle_expires_at:Date.now()+60000,expires_at:Date.now()+60000});
 const confirmation=await proof(owner);await createTrigger(d,'reject_move_cleanup','mfa_sessions','BEFORE DELETE',{message:'fixture-move-cleanup-failed'});
 await assert.rejects(()=>load('lib/server/devices/device-group-membership.ts').changeDeviceMemberships(owner,[a],child,true,confirmation),/fixture-move-cleanup-failed/);
 assert.deepEqual((await d.query(sql`SELECT group_id FROM device_group_members WHERE server_id=${a}`)).map(row=>row.group_id),[rootGroup]);
 assert.ok(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`));assert.ok(await d.one(sql`SELECT token_hash FROM mfa_sessions WHERE principal=${reader.principal}`));
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit WHERE action='Gerätezuordnung geändert'`).then(row=>row===null?null:row.n),0);
}));

test('a membership conflict at commit surfaces as a keyed 409 and rolls back the whole move',async()=>fixture(async({d,insert,group,device,proof,owner,load})=>{
 const source=await group('Quelle'),target=await group('Ziel'),a=await device('A');await insert('device_group_members',{server_id:a,group_id:source});
 // A BEFORE DELETE trigger that returns NULL silently keeps the old row, so the move's INSERT hits the unique index.
 await createTrigger(d,'keep_old_membership','device_group_members','BEFORE DELETE',{body:'RETURN NULL;'});
 const confirmation=await proof(owner);
 await assert.rejects(()=>load('lib/server/devices/device-group-membership.ts').changeDeviceMemberships(owner,[a],target,true,confirmation),error=>error.status===409&&error.messageKey==='apiError.group.membershipTaken'&&!/23505|duplicate key/.test(error.message));
 assert.deepEqual((await d.query(sql`SELECT group_id FROM device_group_members WHERE server_id=${a}`)).map(row=>row.group_id),[source]);
 assert.ok(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`),'the proof stays usable after the rolled back batch');
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit WHERE action='Gerätezuordnung geändert'`).then(row=>row===null?null:row.n),0);
}));

test('an unauthorized/missing device aborts the complete checkbox batch without consuming its proof',async()=>fixture(async f=>{
 const {d,group,device,user,grant,proof,load}=f,target=await group('Target'),a=await device('A'),b=await device('B'),manager=await user('manager',['groups.manage']);await grant(manager,['view'],'device',a);
 const membership=load('lib/server/devices/device-group-membership.ts'),confirmation=await proof(manager);
 await assert.rejects(()=>membership.changeDeviceMemberships(manager,[a,b],target,true,confirmation),error=>error.status===403);assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_group_members WHERE group_id=${target}`).then(row=>row===null?null:row.n),0);
 assert.ok(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`));
 await assert.rejects(async()=>membership.changeDeviceMemberships(manager,[a,randomUUID()],target,true,await proof(manager)),error=>error.status===403);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit WHERE action='Gerätezuordnung geändert'`).then(row=>row===null?null:row.n),0);
}));

test('concurrent permissions, hierarchy removal or secondary membership changes fence every target before write',async()=>fixture(async f=>{
 const {d,insert,group,device,proof,owner,load,beforeBatch}=f,target=await group('Target'),other=await group('Other'),a=await device('A'),b=await device('B'),membership=load('lib/server/devices/device-group-membership.ts');
 let confirmation=await proof(owner);beforeBatch(()=>insert('device_group_members',{server_id:a,group_id:other}));await assert.rejects(()=>membership.changeDeviceMemberships(owner,[a,b],target,true,confirmation),error=>error.status===403);assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_group_members WHERE group_id=${target}`).then(row=>row===null?null:row.n),0);
 confirmation=await proof(owner);beforeBatch(()=>d.exec(sql`DELETE FROM device_groups WHERE id=${target}`));await assert.rejects(()=>membership.changeDeviceMemberships(owner,[a,b],target,true,confirmation),error=>error.status===403);
 const next=await group('Next');confirmation=await proof(owner);beforeBatch(()=>d.exec(sql`UPDATE rbac_roles SET permissions='[]' WHERE id IN (SELECT role_id FROM role_assignments WHERE principal_id=${owner.id})`));await assert.rejects(()=>membership.changeDeviceMemberships(owner,[a,b],next,true,confirmation),error=>error.status===403);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit WHERE action='Gerätezuordnung geändert'`).then(row=>row===null?null:row.n),0);assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_group_members WHERE group_id=${next}`).then(row=>row===null?null:row.n),0);
}));

test('inherited-user revocation and membership changes roll back together if credential cleanup fails',async()=>fixture(async f=>{
 const {d,insert,user,grant,group,device,proof,owner,load}=f,rootGroup=await group('Root'),child=await group('Child',rootGroup),a=await device('A'),reader=await user('reader',[]);await grant(reader,['view'],'devicegroup',rootGroup);await insert('device_group_members',{server_id:a,group_id:child});
 await insert('mfa_sessions',{token_hash:'reader-session',principal:reader.principal,created_at:Date.now(),last_activity:Date.now(),idle_expires_at:Date.now()+60000,expires_at:Date.now()+60000});
 const confirmation=await proof(owner);await createTrigger(d,'refuse_session_cleanup','mfa_sessions','BEFORE DELETE',{message:'fixture-cleanup-failed'});
 await assert.rejects(()=>load('lib/server/devices/device-group-membership.ts').changeDeviceMemberships(owner,[a],child,false,confirmation),/fixture-cleanup-failed/);
 assert.ok(await d.one(sql`SELECT server_id FROM device_group_members WHERE server_id=${a} AND group_id=${child}`));assert.ok(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`));assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit WHERE action='Gerätezuordnung geändert'`).then(row=>row===null?null:row.n),0);
 await dropTrigger(d,'refuse_session_cleanup');await load('lib/server/devices/device-group-membership.ts').changeDeviceMemberships(owner,[a],child,false,confirmation);assert.equal(await d.one(sql`SELECT token_hash FROM mfa_sessions WHERE principal=${reader.principal}`),null);assert.equal(await d.one(sql`SELECT server_id FROM device_group_members WHERE server_id=${a}`),null);
}));

test('parents cannot be deleted through RBAC while children still exist',async()=>fixture(async({d,group,proof,owner,load})=>{
 const rootGroup=await group('Root'),child=await group('Child',rootGroup),confirmation=await proof(owner);
 await assert.rejects(()=>load('lib/server/identity/rbac.ts').deleteDeviceGroup(owner,rootGroup,true,confirmation),error=>error.status===409);
 assert.ok(await d.one(sql`SELECT id FROM device_groups WHERE id=${child}`));assert.ok(await d.one(sql`SELECT id FROM device_groups WHERE id=${rootGroup}`));assert.ok(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`));
}));

test('1000 device memberships are admitted together with one parameter for the device list',async()=>fixture(async({d,group,proof,owner,load})=>{
 const target=await group('Fleet'),ids=Array.from({length:1000},()=>randomUUID()),at=Date.now();
 await inTransaction(d,ids.map(id=>sql`INSERT INTO servers(id,name,token_hash,created_at) VALUES(${id},${'VM-'+id},${id},${at})`));
 assert.deepEqual(await load('lib/server/devices/device-group-membership.ts').changeDeviceMemberships(owner,ids,target,true,await proof(owner)),{ok:true,count:1000});
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_group_members WHERE group_id=${target}`).then(row=>row===null?null:row.n),1000);
 assert.equal((await load('lib/server/devices/device-groups.ts').deviceGroupDeviceIds(target)).length,1000);
 const child=await group('Fleet child',target);assert.deepEqual(await load('lib/server/devices/device-group-membership.ts').changeDeviceMemberships(owner,ids,child,true,await proof(owner)),{ok:true,count:1000});
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_group_members WHERE group_id=${target}`).then(row=>row===null?null:row.n),0);assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_group_members WHERE group_id=${child}`).then(row=>row===null?null:row.n),1000);
 assert.equal((await load('lib/server/devices/device-groups.ts').deviceGroupDeviceIds(target)).length,1000,'1000-device path move keeps inherited parent scope intact');
 await assert.rejects(async()=>load('lib/server/devices/device-group-membership.ts').changeDeviceMemberships(owner,[...ids,randomUUID()],target,true,await proof(owner)),error=>error.status===400);
}));
