// The device inventory of the console on PostgreSQL: group catalog and counts per scope, maintenance state for
// Owners, scope names and the enrollment membership (pnpm test:selfhost).
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import ts from 'typescript';
import {sql} from '../../runtime/database.mjs';
import {createTrigger,dropTrigger,insertRow,sourceDatabase} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {testDatabase} from '../support/postgres.mjs';
import {bootstrapOwner,migrateDatabase} from '../../scripts/selfhost.mjs';
import {serverDeskRoot} from '../support/paths.mjs';
import {enableMultipleCustomers,separateCustomers} from '../support/customer-separation.mjs';
const jobSigningKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jobSigningSecret=jobSigningKey.privateKey.export({type:'pkcs8',format:'pem'});

const root=serverDeskRoot,require=createRequire(import.meta.url),legacyGroupId='00000000-0000-4000-8000-000000000001';
const sha=value=>createHash('sha256').update(value).digest('hex');

// The actual route, scope guards, catalog and mutations run against a
// PostgreSQL test database. Only external authentication/packaging leaves are replaced.
async function fixture(run){
 const d=await sourceDatabase(),cache=new Map();let viewer,beforeBatch=async()=>{},mfaAllowed=true;
 // beforeBatch runs once, before the next transaction starts.
 const facade=hookDatabase(d,{transaction:async()=>{const hook=beforeBatch;beforeBatch=async()=>{};await hook();}});
 const HttpError=realHttpError;
 const server={db:()=>facade,guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value),HttpError,now:()=>Date.now(),hash:async value=>sha(value),random:()=>randomUUID(),config:key=>key==='AGENT_JOB_SIGNING_KEY'?jobSigningSecret:'https://inventory.test',body:request=>request.json(),sameOrigin:()=>{},log:async()=>{},failure:error=>Response.json({error:error.message,code:error.code},{status:error.status??503}),requireViewer:async()=>{if(!viewer)throw new HttpError(403,'Administrator required');return viewer;}};
 const overrides={
  'lib/server/context.ts':server,
  'lib/server/identity/local-auth.ts':{primaryGuard:async(_request,actor)=>load('lib/server/identity/access.ts').viewerWriteGuard(actor)},
  'lib/server/identity/mfa.ts':{requireLiveSessions:async()=>{},mfaSessionFence:async(_request,actor)=>load('lib/server/identity/access.ts').viewerWriteGuard(actor),requireMfa:async()=>{if(!mfaAllowed)throw new HttpError(403,'MFA required');},readMfaManagementProof:async(_request,actor,tokenHash)=>({tokenHash,key:actor.principal,sessionHash:sha(actor.id+'mfa'),guard:sql`TRUE`})},
  'agent/package-v3.ts':{registrationV3:options=>JSON.stringify(options),installerV3:options=>JSON.stringify(options)},
  'lib/management.ts':{operations:{}},'lib/server/agent/agent-crypto.ts':{},'lib/server/agent/agent-protocol.ts':{},
  'lib/diagnostics.ts':{diagnosticDefinitions:{},isDiagnosticKind:()=>false,diagnosticSecurityAccess:()=>false},
  'lib/server/devices/file-access.ts':{},
  'lib/server/devices/device-lifecycle.ts':{sweepRemovedTransfers:async()=>{}},'lib/server/devices/rdp.ts':{sweepRdp:async()=>{}}
 };
 function load(filename){
  const absolute=resolve(root,filename),relative=absolute.slice(root.length).replaceAll('\\','/');
  if(overrides[relative])return overrides[relative];if(cache.has(absolute))return cache.get(absolute).exports;
  const loadedModule={exports:{}};cache.set(absolute,loadedModule);
  const code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const localRequire=id=>id.startsWith('@/')?load(id.slice(2)+'.ts'):id.startsWith('.')&&/\.(?:mjs|json)$/.test(id)?require(resolve(dirname(absolute),id)):id.startsWith('.')?load(resolve(dirname(absolute),id)+'.ts'):require(id);
  new Function('require','module','exports',code)(localRequire,loadedModule,loadedModule.exports);return loadedModule.exports;
 }
 const insert=(table,row)=>insertRow(d,table,row);
 async function user(name,permissions=['*']){
  const id=randomUUID(),at=Date.now(),principal='private:'+name+'@inventory.test',sessionHash=sha(id+'primary'),mfaHash=sha(id+'mfa');
  await insert('local_users',{id,username:name,display_name:name,auth_principal:principal,auth_email:name+'@inventory.test',status:'active',password_hash:'fixture',created_at:at,updated_at:at});
  await insert('mfa_accounts',{principal,secret_enc:'fixture',recovery_hashes:'[]',last_counter:0,created_at:at});
  await insert('mfa_sessions',{token_hash:mfaHash,principal,created_at:at,last_activity:at,idle_expires_at:at+3600000,expires_at:at+3600000});
  await insert('local_auth_sessions',{token_hash:sessionHash,user_id:id,auth_version:1,created_at:at,expires_at:at+3600000,pending_until:0,mfa_hash:mfaHash});
  const actor={id,principal,label:name+'@inventory.test',provider:'local',role:permissions.includes('*')?'admin':'viewer'};
  Object.defineProperty(actor,'authorization',{value:{authVersion:1,sessionHash},enumerable:false});
  if(permissions.length)await grant(actor,permissions);return actor;
 }
 async function grant(actor,permissions,scopeType='global',scopeId='*'){
  const roleId=randomUUID();await insert('rbac_roles',{id:roleId,name:roleId,permissions:JSON.stringify(permissions),created_at:Date.now()});
  await insert('role_assignments',{id:randomUUID(),principal_type:'user',principal_id:actor.id,role_id:roleId,scope_type:scopeType,scope_id:scopeId,created_at:Date.now(),created_by:'fixture'});return roleId;
 }
 async function group(name,parentId=null,id=randomUUID()){await insert('device_groups',{id,name,parent_id:parentId,created_at:Date.now()});return id;}
 async function device(name,groupId=null,revoked=0){const id=randomUUID();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:Date.now(),revoked});if(groupId)await insert('device_group_members',{server_id:id,group_id:groupId});return id;}
 async function proof(actor){const token=randomUUID();await insert('mfa_management_proofs',{token_hash:token,principal:actor.principal,session_hash:sha(actor.id+'mfa'),expires_at:Date.now()+60000});return token;}
 async function get(actor,jobsOnly=false){viewer=actor;return load('app/api/console/route.ts').GET(new Request('https://inventory.test/api/console'+(jobsOnly?'?jobsOnly=1':'')));}
 // Enroll needs a fresh step-up proof (tests/api/step-up-high-risk.mjs): each enroll request brings its own.
 async function post(actor,payload,api='console'){viewer=actor;const body=payload.action==='enroll'&&!Object.hasOwn(payload,'managementToken')?{...payload,managementToken:await proof(actor)}:payload;return load(`app/api/${api}/route.ts`).POST(new Request('https://inventory.test/api/'+api,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));}
 try{return await run({d,insert,user,grant,group,device,proof,get,post,load,beforeBatch:hook=>{beforeBatch=hook;},denyMfa:()=>{mfaAllowed=false;}});}finally{await d.close();}
}

test('a fresh deployment and first Owner bootstrap create no implicit device group',async()=>{
 const d=await testDatabase({template:false});
 try{
  await migrateDatabase(d);assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_groups`).then(row=>row===null?null:row.n),0);
  await bootstrapOwner(d,{username:'admin',displayName:'Administrator',env:{SITE_ORIGIN:'https://inventory.test',SESSION_SECRET:'fixture-session-secret-with-at-least-32-bytes',PASSWORD_PEPPER:'fixture-password-pepper-with-at-least-32-bytes'}});
  await migrateDatabase(d);assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_groups`).then(row=>row===null?null:row.n),0);assert.equal(await d.one(sql`SELECT count(*) AS n FROM local_users`).then(row=>row===null?null:row.n),1);
 }finally{await d.close();}
});

test('console catalog shows empty groups, hierarchy and distinct visible descendant counts to an Owner',async()=>fixture(async f=>{
 const {group,device,user,get,insert}=f,owner=await user('owner'),parent=await group('Parent'),child=await group('Child',parent),empty=await group('Empty',parent),other=await group('Other'),a=await device('A',child);
 await assert.rejects(()=>insert('device_group_members',{server_id:a,group_id:other}),error=>error.code==='23505'&&error.constraint_name==='idx_device_group_members_server','a device belongs to one group');await device('B',child);await device('C',other);await device('Revoked',child,1);
 const response=await get(owner);assert.equal(response.status,200);const data=await response.json();assert.equal(data.servers.length,3);assert.equal(data.deviceGroups.length,4);
 const byId=new Map(data.deviceGroups.map(row=>[row.id,row]));assert.equal(byId.get(parent).deviceCount,2);assert.equal(byId.get(child).deviceCount,2);assert.equal(byId.get(other).deviceCount,1);assert.equal(byId.get(empty).deviceCount,0);assert.equal(byId.get(child).parentId,parent);assert.equal(byId.get(child).depth,1);assert.ok(byId.get(empty).permissions.includes('groups.manage'));
 const jobs=await (await get(owner,true)).json();assert.equal(Object.hasOwn(jobs,'deviceGroups'),false,'lightweight job polling does not reload the group catalog');
}));

// Only an Owner gets the state of the maintenance command, never in the job poll.
test('the console gives Owners the maintenance state and nobody else, also not in the job poll',async()=>fixture(async f=>{
 const {user,get,insert}=f,owner=await user('owner'),reader=await user('reader',['view']);
 const body=await (await get(owner)).json();
 assert.deepEqual(body.maintenance,{lastSuccessAt:null,lastRun:null,stale:true},'empty table: never succeeded');
 assert.equal(Object.hasOwn(await (await get(owner,true)).json(),'maintenance'),false,'jobsOnly stays unchanged');
 const readerBody=await (await get(reader)).json();assert.equal(Object.hasOwn(readerBody,'servers'),true);assert.equal(Object.hasOwn(readerBody,'maintenance'),false,'a viewer without instance.owner gets no key');
 assert.equal(Object.hasOwn(await (await get(reader,true)).json(),'maintenance'),false);
 const finished=Date.now()-3_600_000;
 await insert('maintenance_runs',{started_at:finished-1000,finished_at:finished,status:'succeeded',result:'{}'});
 await insert('maintenance_runs',{started_at:finished+1000,finished_at:finished+2000,status:'failed',error:'secret detail'});
 const later=(await (await get(owner)).json()).maintenance;
 assert.deepEqual(later,{lastSuccessAt:finished,lastRun:{startedAt:finished+1000,finishedAt:finished+2000,status:'failed'},stale:false});
}));

test('scoped catalog retains empty descendants and context ancestors without exposing empty siblings',async()=>fixture(async f=>{
 const {group,device,user,grant,get}=f,parent=await group('Parent'),child=await group('Child',parent),deep=await group('Empty deep',child),sibling=await group('Hidden sibling',parent),foreign=await group('Foreign root'),reader=await user('reader',[]);
 await device('Visible',child);await device('Hidden sibling',sibling);await grant(reader,['view'],'devicegroup',child);
 const data=await (await get(reader)).json();assert.deepEqual(data.deviceGroups.map(row=>row.id).sort(),[parent,child,deep].sort());assert.equal(data.deviceGroups.find(row=>row.id===parent).deviceCount,1);assert.deepEqual(data.deviceGroups.find(row=>row.id===parent).permissions,[]);assert.ok(data.deviceGroups.find(row=>row.id===deep).permissions.includes('view'));assert.ok(!JSON.stringify(data).includes(foreign));
 const manager=await user('manager',[]);await grant(manager,['groups.manage'],'devicegroup',deep);const managed=await (await get(manager)).json();assert.equal(managed.servers.length,0);assert.deepEqual(managed.deviceGroups.map(row=>row.id).sort(),[parent,child,deep].sort());assert.deepEqual(managed.deviceGroups.find(row=>row.id===deep).permissions,['groups.manage']);
}));

test('device-only scope contributes its path but no group authority or hidden sibling counts',async()=>fixture(async f=>{
 const {group,device,user,grant,get}=f,parent=await group('Parent'),leaf=await group('Leaf',parent),other=await group('Other',parent),deviceId=await device('Visible',leaf),reader=await user('reader',[]);
 await device('Hidden same leaf',leaf);await device('Hidden other leaf',other);await grant(reader,['view'],'device',deviceId);
 const data=await (await get(reader)).json();assert.deepEqual(data.servers.map(row=>row.id),[deviceId]);assert.deepEqual(data.deviceGroups.map(row=>row.id).sort(),[parent,leaf].sort());assert.ok(data.deviceGroups.every(row=>row.deviceCount===1&&row.permissions.length===0));
 const outsider=await user('outsider',[]);const denied=await (await get(outsider)).json();assert.deepEqual(denied.deviceGroups,[]);assert.deepEqual(denied.servers,[]);
}));

test('assignment administrators receive scope names without obtaining monitoring, jobs or audit data',async()=>fixture(async f=>{
 const {d,insert,group,device,user,get}=f,parent=await group('Parent'),child=await group('Child',parent),empty=await group('Empty'),active=await device('Assignment target',child),ungrouped=await device('Ungrouped target'),revoked=await device('Revoked target',child,1),manager=await user('accessadmin',['portal.roleAssignments.manage']);
 manager.role='operator';manager.permissions=['portal.roleAssignments.manage'];
 await d.exec(sql`UPDATE servers SET snapshot=${JSON.stringify({hostname:'PRIVATE-HOSTNAME',os:'PRIVATE-OS',cpu:99,memory:88,processes:[],networks:[{addresses:['192.0.2.77']}]})},last_seen=${Date.now()},management=1 WHERE id=${active}`);
 await insert('jobs',{id:randomUUID(),server_id:active,action:'refresh',target:'PRIVATE-JOB-TARGET',result:'PRIVATE-JOB-OUTPUT',actor:'fixture',created_at:Date.now()});
 await insert('samples',{server_id:active,at:Date.now(),cpu:99,memory:88});
 await insert('audit',{at:Date.now(),actor:'fixture',action:'PRIVATE-PORTAL-AUDIT',target:'PRIVATE-AUDIT-TARGET',scope:'portal'});
 await insert('audit',{at:Date.now(),actor:'fixture',action:'PRIVATE-DEVICE-AUDIT',target:'PRIVATE-AUDIT-TARGET',server_id:active,scope:'device'});
 const response=await get(manager);assert.equal(response.status,200);const data=await response.json();
 assert.deepEqual(data.servers,[]);assert.equal('samples' in data,false,'the console answer has no samples');assert.equal(['shared','Viewers'].join('') in data.auth,false,'the console answer has no shared viewer list');assert.deepEqual(data.jobs,[]);assert.deepEqual(data.audit,[]);assert.deepEqual(data.deviceAudit,[]);
 assert.deepEqual(data.permissionDevices.map(row=>row.id).sort(),[active,ungrouped].sort());assert.ok(!JSON.stringify(data.permissionDevices).includes(revoked));
 const target=data.permissionDevices.find(row=>row.id===active);assert.deepEqual(Object.keys(target).sort(),['customerId','groupId','groupName','groups','id','name']);assert.equal(target.customerId,await d.one(sql`SELECT customer_id FROM servers WHERE id=${active}`).then(row=>row===null?null:row.customer_id),'the permission target names the customer of its device');assert.equal(target.groupId,child);assert.equal(target.groupName,'Child');assert.deepEqual(target.groups.map(row=>row.id).sort(),[parent,child].sort());assert.ok(target.groups.find(row=>row.id===child).direct);assert.equal(target.groups.find(row=>row.id===parent).direct,false);
 assert.deepEqual(data.deviceGroups.map(row=>row.id).sort(),[parent,child,empty].sort());assert.ok(data.deviceGroups.every(row=>row.deviceCount===0&&row.permissions.length===0));
 for(const row of data.deviceGroups)assert.equal(row.customerId,await d.one(sql`SELECT customer_id FROM device_groups WHERE id=${row.id}`).then(row=>row===null?null:row.customer_id),'every catalog group names its own customer');
 assert.doesNotMatch(JSON.stringify(data),/PRIVATE-|192\.0\.2\.77|snapshot|lastSeen|maintenance|createdAt/,'scope navigation contains no monitoring or protected output fields');
 const jobs=await (await get(manager,true)).json();assert.equal(Object.hasOwn(jobs,'permissionDevices'),false);assert.deepEqual(jobs.jobs,[]);
}));

test('ordinary scoped viewers and a spoofed compatibility admin role cannot enumerate permission targets',async()=>fixture(async f=>{
 const {group,device,user,grant,get}=f,allowed=await group('Allowed'),hidden=await group('PRIVATE-GROUP'),active=await device('Visible device',allowed),hiddenDevice=await device('PRIVATE-DEVICE',hidden),reader=await user('reader',[]);
 await grant(reader,['view'],'device',active);const data=await (await get(reader)).json();assert.equal(Object.hasOwn(data,'permissionDevices'),false);assert.deepEqual(data.deviceGroups.map(row=>row.id),[allowed]);assert.doesNotMatch(JSON.stringify(data),/PRIVATE-/);assert.ok(!JSON.stringify(data).includes(hiddenDevice));
 const spoofed=await user('spoofed',[]);spoofed.role='admin';const spoof=await (await get(spoofed)).json();assert.equal(Object.hasOwn(spoof,'permissionDevices'),false);assert.deepEqual(spoof.deviceGroups,[]);assert.deepEqual(spoof.servers,[]);
}));

test('enrollment creates the exact selected membership or an explicitly ungrouped device, never a fallback',async()=>fixture(async f=>{
 const {d,group,user,post,get}=f,owner=await user('owner'),parent=await group('Parent'),selected=await group('Selected',parent);
 let response=await post(owner,{action:'enroll',name:'Grouped',groupId:selected});assert.equal(response.status,200);let registered=await response.json();assert.equal(registered.jobSigningKey,jobSigningKey.publicKey.export({type:'spki',format:'der'}).toString('base64'),'registration pins the portal job-signing key');assert.equal(await d.one(sql`SELECT group_id FROM device_group_members WHERE server_id=${registered.id}`).then(row=>row===null?null:row.group_id),selected);assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_group_members WHERE group_id=${parent}`).then(row=>row===null?null:row.n),0);
 response=await post(owner,{action:'enroll',name:'Ungrouped'});assert.equal(response.status,200);registered=await response.json();assert.equal(await d.one(sql`SELECT group_id FROM device_group_members WHERE server_id=${registered.id}`),null);
 // A new personal registration expires 7 days after creation, for both formats,
 // and the device list shows that deadline only until the agent connects.
 const lifetime=async id=>{const row=await d.one(sql`SELECT created_at,token_expires_at FROM servers WHERE id=${id}`);return row.token_expires_at-row.created_at;};
 assert.equal(await lifetime(registered.id),7*86400000,'personal registration expires after 7 days');
 const listed=async id=>(await (await get(owner)).json()).servers.find(row=>row.id===id);
 const expiresAt=await d.one(sql`SELECT token_expires_at FROM servers WHERE id=${registered.id}`).then(row=>row===null?null:row.token_expires_at);
 assert.deepEqual((await listed(registered.id)).registration,{expiresAt},'never-connected device carries its registration deadline');
 await d.exec(sql`UPDATE servers SET agent_public_key=${'{}'},last_seen=${Date.now()} WHERE id=${registered.id}`);
 assert.equal(Object.hasOwn(await listed(registered.id),'registration'),false,'connected device has no registration field');
 response=await post(owner,{action:'enroll',name:'Bootstrap',format:'bootstrap'});assert.equal(response.status,200);const bootstrap=JSON.parse((await response.text()).replace(/^\uFEFF/,''));
 assert.equal(await lifetime(bootstrap.id),7*86400000,'bootstrap registration expires after 7 days');
 for(const [groupId,status] of [['',400],['not-a-group',400],[randomUUID(),404]]){response=await post(owner,{action:'enroll',name:'Invalid',groupId});assert.equal(response.status,status);}
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM servers`).then(row=>row===null?null:row.n),3);
}));

test('selected-group enrollment rechecks group existence, Owner and exact password/MFA session at commit',async()=>fixture(async f=>{
 const {d,group,user,post,beforeBatch}=f,owner=await user('owner');let selected=await group('Selected');
 beforeBatch(()=>d.exec(sql`DELETE FROM device_groups WHERE id=${selected}`));let response=await post(owner,{action:'enroll',name:'Deleted group',groupId:selected});assert.equal(response.status,403);assert.equal(await d.one(sql`SELECT count(*) AS n FROM servers`).then(row=>row===null?null:row.n),0);
 selected=await group('Selected');beforeBatch(()=>d.exec(sql`DELETE FROM role_assignments WHERE principal_id=${owner.id}`));response=await post(owner,{action:'enroll',name:'Revoked Owner',groupId:selected});assert.equal(response.status,403);assert.equal(await d.one(sql`SELECT count(*) AS n FROM servers`).then(row=>row===null?null:row.n),0);
 const nextOwner=await user('nextowner');beforeBatch(()=>d.exec(sql`DELETE FROM mfa_sessions WHERE principal=${nextOwner.principal}`));response=await post(nextOwner,{action:'enroll',name:'Logged out',groupId:selected});assert.equal(response.status,403);assert.equal(await d.one(sql`SELECT count(*) AS n FROM servers`).then(row=>row===null?null:row.n),0);
}));

test('a failing membership write rolls back enrollment and scoped grouping alone cannot enroll',async()=>fixture(async f=>{
 const {d,group,user,post,grant,denyMfa}=f,owner=await user('owner'),selected=await group('Selected');
 await createTrigger(d,'deny_enrollment_member','device_group_members','BEFORE INSERT',{message:'fixture-membership-failure'});const failed=await post(owner,{action:'enroll',name:'Failure',groupId:selected});assert.equal(failed.status,503);assert.equal(await d.one(sql`SELECT count(*) AS n FROM servers`).then(row=>row===null?null:row.n),0);
 await dropTrigger(d,'deny_enrollment_member');const manager=await user('manager',[]);await grant(manager,['view','groups.manage'],'devicegroup',selected);assert.equal((await post(manager,{action:'enroll',name:'Denied',groupId:selected})).status,403);
 denyMfa();assert.equal((await post(owner,{action:'enroll',name:'No MFA',groupId:selected})).status,403);assert.equal(await d.one(sql`SELECT count(*) AS n FROM servers`).then(row=>row===null?null:row.n),0);
}));

test('a group removed inside the enrollment transaction aborts instead of committing an ungrouped device',async()=>fixture(async f=>{
 const {d,group,user,post}=f,owner=await user('owner'),selected=await group('Selected');
 await createTrigger(d,'fixture_enrollment_group_removal','servers','BEFORE INSERT',{body:`DELETE FROM device_groups WHERE id='${selected}';`});
 assert.equal((await post(owner,{action:'enroll',name:'Trigger race',groupId:selected})).status,503);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM servers`).then(row=>row===null?null:row.n),0);assert.ok(await d.one(sql`SELECT id FROM device_groups WHERE id=${selected}`),'the failed membership also rolls back the in-transaction group deletion');
}));

test('rename uses actual scoped group permission, the MFA login session and live commit guards',async()=>fixture(async f=>{
 const {d,group,user,grant,proof,post,beforeBatch}=f,selected=await group('Before'),other=await group('Other'),manager=await user('manager',[]),role=await grant(manager,['groups.manage'],'devicegroup',selected);
 // Renaming is routine (lib/step-up.ts): no managementToken needed, a supplied one is ignored and stays.
 let response=await post(manager,{action:'update-group',id:selected,name:' After ',description:' Test '},'access');assert.equal(response.status,200);assert.deepEqual(await d.one(sql`SELECT name,description FROM device_groups WHERE id=${selected}`),{name:'After',description:'Test'});
 const managementToken=await proof(manager);response=await post(manager,{action:'update-group',id:selected,name:'After',description:'Test',managementToken},'access');assert.equal(response.status,200);assert.equal(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${managementToken}`).then(row=>row===null?null:row.token_hash),managementToken);
 assert.equal((await post(manager,{action:'update-group',id:other,name:'Denied'},'access')).status,403);
 assert.equal((await post(manager,{action:'update-group',id:selected,name:'Moved',parentId:other},'access')).status,400);assert.equal(await d.one(sql`SELECT parent_id FROM device_groups WHERE id=${selected}`).then(row=>row===null?null:row.parent_id),null);
 beforeBatch(()=>d.exec(sql`UPDATE rbac_roles SET permissions=${'[]'} WHERE id=${role}`));response=await post(manager,{action:'update-group',id:selected,name:'Stale rename'},'access');assert.equal(response.status,403);assert.equal(await d.one(sql`SELECT name FROM device_groups WHERE id=${selected}`).then(row=>row===null?null:row.name),'After');
 await d.exec(sql`UPDATE rbac_roles SET permissions=${'["groups.manage"]'} WHERE id=${role}`);
 beforeBatch(()=>d.exec(sql`DELETE FROM local_auth_sessions WHERE user_id=${manager.id}`));response=await post(manager,{action:'update-group',id:selected,name:'Logged out'},'access');assert.equal(response.status,403);assert.equal(await d.one(sql`SELECT name FROM device_groups WHERE id=${selected}`).then(row=>row===null?null:row.name),'After','a logout before the commit stops the rename');
}));

test('retained legacy imports can be deleted like an ordinary group while retaining devices',async()=>fixture(async f=>{
 const {d,group,device,user,proof,post,get}=f,owner=await user('owner'),legacy=await group('Bestehende Geräte',null,legacyGroupId),deviceId=await device('Keep',legacy);
 await get(owner);
 const catalog=await (await f.load('app/api/access/route.ts').GET()).json();assert.equal(catalog.groups.find(row=>row.id===legacy).protected,false);assert.equal(catalog.groups.find(row=>row.id===legacy).deletable,true);
 const response=await post(owner,{action:'delete-group',id:legacy,confirm:true,managementToken:await proof(owner)},'access');assert.equal(response.status,200);assert.equal(await d.one(sql`SELECT id FROM device_groups WHERE id=${legacy}`),null);assert.ok(await d.one(sql`SELECT id FROM servers WHERE id=${deviceId} AND revoked=0`));assert.equal(await d.one(sql`SELECT server_id FROM device_group_members WHERE server_id=${deviceId}`),null);
}));

// Once a second customer exists a console registration needs a customer: customerId
// or a group of that customer (docs/customers.md, "Registration in the console").
test('enrollment goes to the first customer while it is the only one and to a chosen customer with several customers',async()=>fixture(async f=>{
 const {d,insert,user,proof,post,beforeBatch}=f,owner=await user('owner'),first='00000000-0000-4000-8000-000000000100',at=Date.now();
 const B=randomUUID(),C=randomUUID();
 const groupOf=async(name,customerId)=>{const id=randomUUID();await insert('device_groups',{id,name,parent_id:null,created_at:at,customer_id:customerId});return id;};
 const groupFirst=await groupOf('Gruppe A',first);
 const count=()=>d.one(sql`SELECT count(*) AS n FROM servers`).then(row=>Number(row.n));
 const proofLeft=token=>d.one(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${token}`).then(row=>Number(row.n));
 const customerOf=id=>d.one(sql`SELECT customer_id FROM servers WHERE id=${id}`).then(row=>row?.customer_id??null);
 const answer=async response=>({status:response.status,body:response.status===200?null:await response.json()});
 const required={error:serverText('apiError.console.enrollCustomerRequired'),code:'ENROLL_CUSTOMER_REQUIRED'};
 // Only the default customer: without customer and group as before.
 let response=await post(owner,{action:'enroll',name:'Eins'});assert.equal(response.status,200);
 assert.equal(await customerOf((await response.json()).id),first,'the column default: the first customer');
 // customerId is accepted with one customer too.
 response=await post(owner,{action:'enroll',name:'Eins A',customerId:first});assert.equal(response.status,200);assert.equal(await customerOf((await response.json()).id),first);
 // Invalid and unknown customerId, before the proof is read.
 let token=await proof(owner);
 assert.deepEqual(await answer(await post(owner,{action:'enroll',name:'Invalid',customerId:'kein-guid',managementToken:token})),{status:400,body:{error:serverText('apiError.customer.invalid'),code:'INVALID_REQUEST'}});
 const unknown=await answer(await post(owner,{action:'enroll',name:'Unknown',customerId:randomUUID(),managementToken:token}));
 assert.deepEqual([unknown.status,unknown.body.code],[404,'CUSTOMER_MISSING']);
 assert.equal(await proofLeft(token),1,'validation failures keep the proof');
 const before=await count();
 // Customers B and C: from now on a new device needs a customer.
 await insert('customers',{id:B,name:'Kunde B',created_at:at,updated_at:at});await insert('customers',{id:C,name:'Kunde C',created_at:at,updated_at:at});
 const groupB=await groupOf('Gruppe B',B),groupC=await groupOf('Gruppe C',C);
 token=await proof(owner);
 assert.deepEqual(await answer(await post(owner,{action:'enroll',name:'Ohne Kunde',managementToken:token})),{status:400,body:required},'without customer and group');
 assert.deepEqual(await answer(await post(owner,{action:'enroll',name:'Ohne Kunde',groupId:null,customerId:null,managementToken:token})),{status:400,body:required},'explicit nulls count as missing');
 assert.equal(await count(),before,'no device row');assert.equal(await proofLeft(token),1,'the proof is not consumed');
 // With customerId of B.
 response=await post(owner,{action:'enroll',name:'Kunde B',customerId:B,managementToken:token});assert.equal(response.status,200);
 let id=(await response.json()).id;assert.equal(await customerOf(id),B);assert.equal(await proofLeft(token),0,'the success consumes the proof');
 assert.equal(await d.one(sql`SELECT group_id FROM device_group_members WHERE server_id=${id}`),null,'customer without a group: no membership');
 // With a group of B: the group's customer and the membership.
 response=await post(owner,{action:'enroll',name:'Gruppe B',groupId:groupB});assert.equal(response.status,200);
 id=(await response.json()).id;assert.equal(await customerOf(id),B);assert.equal(await d.one(sql`SELECT group_id FROM device_group_members WHERE server_id=${id}`).then(row=>row?.group_id),groupB);
 // customerId and a group of the same customer.
 response=await post(owner,{action:'enroll',name:'Beides B',groupId:groupB,customerId:B});assert.equal(response.status,200);assert.equal(await customerOf((await response.json()).id),B);
 // customerId of the first customer and a group of B: 409, nothing created, the proof stays.
 const created=await count();token=await proof(owner);
 const mismatch=await answer(await post(owner,{action:'enroll',name:'Mismatch',groupId:groupB,customerId:first,managementToken:token}));
 assert.deepEqual([mismatch.status,mismatch.body.code,mismatch.body.error],[409,'CUSTOMER_MISMATCH',serverText('apiError.customer.mismatch')]);
 assert.equal(await count(),created);assert.equal(await proofLeft(token),1);
 // The customer-mismatch trigger also rolls the batch back if the group moves after the pre-check.
 beforeBatch(()=>d.exec(sql`UPDATE device_groups SET customer_id=${C} WHERE id=${groupFirst}`));
 const raced=await answer(await post(owner,{action:'enroll',name:'Mismatch race',groupId:groupFirst,customerId:first,managementToken:token}));
 assert.deepEqual([raced.status,raced.body.code],[409,'CUSTOMER_MISMATCH'],'the trigger answers 409 too');assert.equal(await count(),created);assert.equal(await proofLeft(token),1);
 // A disabled customer takes no device, via customerId or via its group.
 await d.exec(sql`UPDATE customers SET status='disabled' WHERE id=${C}`);
 for(const payload of [{customerId:C},{groupId:groupC},{groupId:groupC,customerId:C}]){
  const disabled=await answer(await post(owner,{action:'enroll',name:'Deaktiviert',...payload,managementToken:token}));
  assert.deepEqual([disabled.status,disabled.body.code],[409,'CUSTOMER_DISABLED'],JSON.stringify(payload));
 }
 assert.equal(await count(),created);assert.equal(await proofLeft(token),1);
}));

test('a second customer created between the enrollment pre-check and the commit creates no device without a chosen customer',async()=>fixture(async f=>{
 const {d,user,proof,post,beforeBatch}=f,owner=await user('owner');
 const token=await proof(owner);
 // The commit is the next transaction after the route's pre-checks.
 // The setting is on before the request; only the second customer appears in the race.
 await d.exec(enableMultipleCustomers());
 beforeBatch(()=>d.exec(separateCustomers(Date.now())));
 const response=await post(owner,{action:'enroll',name:'Race',managementToken:token});
 assert.equal(response.status,400);assert.equal((await response.json()).code,'ENROLL_CUSTOMER_REQUIRED');
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM servers`).then(row=>Number(row.n)),0,'no device row');
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${token}`).then(row=>Number(row.n)),1,'the proof is not consumed');
}));
