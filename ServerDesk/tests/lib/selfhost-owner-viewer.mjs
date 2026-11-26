// A global Owner keeps '*' in the client viewer (usage data, customers, audit).
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import ts from 'typescript';
import {sql} from '../../runtime/database.mjs';

import {bootstrapOwner} from '../../scripts/selfhost.mjs';

import {sourceDatabase,insertRow} from '../support/source-database.mjs';
import {serverDeskRoot} from '../support/paths.mjs';
const root=serverDeskRoot,require=createRequire(import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');
const env={SITE_ORIGIN:'https://owner.test',SESSION_SECRET:'fixture-session-secret-with-at-least-32-bytes',PASSWORD_PEPPER:'fixture-password-pepper-with-at-least-32-bytes'};
const sections=['accounts','user-groups','roles','customers','audit','usage-data'];

// The real userViewer, permission queries, built-in roles and client capability
// checks run against a PostgreSQL test database. Only lib/server/context.ts and the MFA leaf are replaced.
async function fixture(run){
 const d=await sourceDatabase(),cache=new Map();
 const HttpError=realHttpError;
 const server={db:()=>d,guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value),HttpError,now:()=>Date.now(),hash:async value=>sha(value),random:()=>randomUUID(),config:()=>'https://owner.test',log:async()=>{}};
 const overrides={'lib/server/context.ts':server,'lib/server/identity/mfa.ts':{readMfaManagementProof:async()=>{throw new Error('not used');}}};
 function load(filename){
  const absolute=resolve(root,filename),relative=absolute.slice(root.length).replaceAll('\\','/');
  if(overrides[relative])return overrides[relative];if(cache.has(absolute))return cache.get(absolute).exports;
  const loadedModule={exports:{}};cache.set(absolute,loadedModule);
  const code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const localRequire=id=>id.startsWith('@/')?load(id.slice(2)+'.ts'):id.startsWith('.')?(/[.]m?js$/.test(id)?require(resolve(dirname(absolute),id)):load(resolve(dirname(absolute),id)+'.ts')):require(id);
  new Function('require','module','exports',code)(localRequire,loadedModule,loadedModule.exports);return loadedModule.exports;
 }
 const insert=(table,row)=>insertRow(d,table,row);
 const row=id=>d.one(sql`SELECT * FROM local_users WHERE id=${id}`);
 async function user(name){
  const id=randomUUID(),at=Date.now();
  await insert('local_users',{id,username:name,display_name:name,auth_principal:'private:'+name+'@owner.test',auth_email:name+'@owner.test',status:'active',password_hash:'fixture',created_at:at,updated_at:at});
  return id;
 }
 const assign=(principalType,principalId,roleId)=>insert('role_assignments',{id:randomUUID(),principal_type:principalType,principal_id:principalId,role_id:roleId,scope_type:'global',scope_id:'*',created_at:Date.now(),created_by:'fixture'});
 async function role(permissions){const id=randomUUID();await insert('rbac_roles',{id,name:id,permissions:JSON.stringify(permissions),created_at:Date.now()});return id;}
 try{
  const {userId}=await bootstrapOwner(d,{username:'admin',displayName:'Administrator',env});
  // bootstrap-owner writes no old role column and no seed marker.
  assert.equal((await d.one(sql`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='local_users' AND column_name=${['legacy','role'].join('_')}`)).n,0);
  assert.equal(await d.one(sql`SELECT value FROM identity_settings WHERE key=${'local_users_seeded_v1'}`),null);
  // Seeds the other built-in roles from lib/server/identity/rbac.ts, as the first sign-in does.
  await load('lib/server/identity/rbac.ts').ensureBuiltinRoles();
  // Redeeming the invitation only sets the status and the password hash.
  await d.exec(sql`UPDATE local_users SET status='active',password_hash='fixture' WHERE id=${userId}`);
  return await run({d,load,insert,row,user,assign,role,ownerId:userId,auth:load('lib/server/identity/local-auth.ts'),access:load('lib/server/identity/access.ts'),capabilities:load('ui/base/access-capabilities.ts'),rbac:load('lib/server/identity/rbac.ts')});
 }finally{d.close();}
}

test('a bootstrap Owner keeps * in the viewer and opens usage data, customers and audit',()=>fixture(async({row,ownerId,auth,access,capabilities})=>{
 const viewer=await auth.userViewer(await row(ownerId));
 assert.ok(viewer.permissions.includes('*'));
 for(const right of ['portal.users.manage','portal.msp.crossCustomer','groups.manage'])assert.ok(viewer.permissions.includes(right),right);
 assert.deepEqual(viewer.permissions.filter(right=>right!=='*'),await access.globalPermissions(viewer));
 for(const section of sections)assert.equal(capabilities.canOpenAccessSection(viewer,section),true,section);
 assert.equal(capabilities.canManageInstanceSettings(viewer),true);
 assert.equal(viewer.canManageDeviceGroups,true);
 assert.equal((await access.globalPermissions(viewer)).includes('*'),false);
}));

test('a User Access Administrator gets no * and keeps the Owner-only pages closed',()=>fixture(async({row,user,assign,auth,access,capabilities,rbac})=>{
 const id=await user('useraccess');await assign('user',id,rbac.builtinRoleIds.userAccessAdministrator);
 const viewer=await auth.userViewer(await row(id));
 assert.equal(viewer.permissions.includes('*'),false);
 assert.ok(viewer.permissions.includes('portal.users.manage'));
 assert.deepEqual(viewer.permissions,await access.globalPermissions(viewer));
 for(const section of ['usage-data','customers','audit'])assert.equal(capabilities.canOpenAccessSection(viewer,section),false,section);
 for(const section of ['accounts','user-groups','roles'])assert.equal(capabilities.canOpenAccessSection(viewer,section),true,section);
 assert.equal(capabilities.canManageInstanceSettings(viewer),false);
}));

test('a role that lists every single right but not * does not make an Owner',()=>fixture(async({row,user,assign,role,auth,access,capabilities})=>{
 const id=await user('everyright');await assign('user',id,await role([...access.allPermissions,...access.allPortalPermissions]));
 const viewer=await auth.userViewer(await row(id)),expanded=await access.globalPermissions(viewer);
 assert.deepEqual(viewer.permissions,expanded);
 assert.equal(viewer.permissions.includes('*'),false);
 assert.equal(capabilities.canManageInstanceSettings(viewer),false);
 for(const section of ['usage-data','customers','audit'])assert.equal(capabilities.canOpenAccessSection(viewer,section),false,section);
}));

test('an Owner through a user group gets * like globalOwnerGuard',()=>fixture(async({row,user,assign,insert,auth,access,capabilities,rbac})=>{
 const id=await user('groupowner'),groupId=randomUUID();
 await insert('user_groups',{id:groupId,name:'Owners',created_at:Date.now()});
 await insert('user_group_members',{group_id:groupId,user_id:id});
 await assign('group',groupId,rbac.builtinRoleIds.owner);
 const viewer=await auth.userViewer(await row(id));
 assert.ok(viewer.permissions.includes('*'));
 assert.ok(viewer.permissions.includes('portal.users.manage'));
 assert.equal(await access.hasGlobalPermission(viewer,'*'),true);
 assert.equal(capabilities.canOpenAccessSection(viewer,'usage-data'),true);
 assert.equal(capabilities.canManageInstanceSettings(viewer),true);
}));

test('userViewer names the roles of the account: direct and through a user group, once each, sorted',()=>fixture(async({row,user,assign,insert,ownerId,auth,rbac})=>{
 assert.deepEqual((await auth.userViewer(await row(ownerId))).roles,['Owner'],'the bootstrapped Owner has the built-in name');
 const id=await user('roles'),groupId=randomUUID(),disabledId=randomUUID();
 const zeta=randomUUID(),alpha=randomUUID(),hidden=randomUUID();
 for(const [roleId,name] of [[zeta,'Zeta operators'],[alpha,'Alpha readers'],[hidden,'Disabled group role']])await insert('rbac_roles',{id:roleId,name,permissions:JSON.stringify(['view']),created_at:Date.now()});
 await insert('user_groups',{id:groupId,name:'Operators',created_at:Date.now()});
 await insert('user_groups',{id:disabledId,name:'Off',enabled:0,created_at:Date.now()});
 for(const group of [groupId,disabledId])await insert('user_group_members',{group_id:group,user_id:id});
 await assign('user',id,zeta);await assign('group',groupId,zeta);await assign('group',groupId,alpha);await assign('group',disabledId,hidden);
 await insert('role_assignments',{id:randomUUID(),principal_type:'user',principal_id:id,role_id:alpha,scope_type:'device',scope_id:randomUUID(),created_at:Date.now(),created_by:'fixture'});
 assert.deepEqual((await auth.userViewer(await row(id))).roles,['Alpha readers','Zeta operators'],'each name once, any scope, sorted; a disabled group gives none');
 const none=await user('noroles');
 assert.deepEqual((await auth.userViewer(await row(none))).roles,[],'an account without assignments has no role');
 assert.equal(typeof rbac.builtinRoleIds.owner,'string');
}));
