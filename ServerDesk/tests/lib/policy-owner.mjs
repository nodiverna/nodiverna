// Owner checks through lib/server/identity/policy/can.ts: live, cached per request, commit stays live.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import {sql,compile} from '../../runtime/database.mjs';


import {sourceDatabase,insertRow} from '../support/source-database.mjs';
import {serverDeskRoot} from '../support/paths.mjs';
const root=serverDeskRoot,require=createRequire(import.meta.url);

// The real lib/server/identity/policy/can.ts, lib/server/identity/access.ts and lib/server/identity/feature-authorization.ts run
// against a PostgreSQL test database. Only lib/server/context.ts is replaced; its db() counts every
// prepared statement and can be told to fail the next one.
async function fixture(run){
 const d=await sourceDatabase(),cache=new Map(),stats={prepared:0,failNext:false};
 const HttpError=realHttpError;
 // Counts the statements of the code under test and can fail the next one.
 const counted=hookDatabase(d,{statement:async()=>{stats.prepared++;if(stats.failNext){stats.failNext=false;throw new Error('storage unavailable');}}});
 const server={db:()=>counted,HttpError,guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value),now:()=>Date.now()};
 function load(filename){
  const absolute=resolve(root,filename),relative=absolute.slice(root.length).replaceAll('\\','/');
  if(relative==='lib/server/context.ts')return server;if(cache.has(absolute))return cache.get(absolute).exports;
  const loadedModule={exports:{}};cache.set(absolute,loadedModule);
  const code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const localRequire=id=>id.startsWith('@/')?load(id.slice(2)+'.ts'):id.startsWith('.')?(/\.m?js$/.test(id)?require(resolve(dirname(absolute),id)):load(resolve(dirname(absolute),id)+'.ts')):require(id);
  new Function('require','module','exports',code)(localRequire,loadedModule,loadedModule.exports);return loadedModule.exports;
 }
 const insert=(table,row)=>insertRow(d,table,row);
 async function user(name,status='active'){
  const id=randomUUID(),at=Date.now();
  await insert('local_users',{id,username:name,display_name:name,auth_principal:'private:'+name+'@policy.test',auth_email:name+'@policy.test',status,password_hash:'fixture',created_at:at,updated_at:at});
  return id;
 }
 async function role(permissions){const id=randomUUID();await insert('rbac_roles',{id,name:id,permissions:JSON.stringify(permissions),created_at:Date.now()});return id;}
 const assign=async(principalType,principalId,roleId)=>{const id=randomUUID();await insert('role_assignments',{id,principal_type:principalType,principal_id:principalId,role_id:roleId,scope_type:'global',scope_id:'*',created_at:Date.now(),created_by:'fixture'});return id;};
 async function group(enabled=true){const id=randomUUID();await insert('user_groups',{id,name:id,enabled:enabled?1:0,created_at:Date.now()});return id;}
 // A viewer as resolvePrincipal builds it: role taken once, the version stamp non-enumerable.
 async function viewer(name,role='admin'){
  const row=await d.one(sql`SELECT id,auth_principal,auth_email,auth_version FROM local_users WHERE username=${name}`);
  const v={id:row?.id??randomUUID(),userId:row?.id,label:row?.auth_email??name+'@policy.test',principal:row?.auth_principal??'private:'+name+'@policy.test',username:name,displayName:name,role,provider:'local'};
  Object.defineProperty(v,'authorization',{value:{authVersion:row?.auth_version??1},enumerable:false});return v;
 }
 try{
  const ownerRole=await role(['*']);
  return await run({d,stats,insert,user,role,assign,group,viewer,ownerRole,can:load('lib/server/identity/policy/can.ts'),access:load('lib/server/identity/access.ts')});
 }finally{d.close();}
}

test('can() answers exactly like hasGlobalPermission(v,"*") for every kind of actor',()=>fixture(async({user,role,assign,group,insert,viewer,ownerRole,can,access})=>{
 await assign('user',await user('direct'),ownerRole);
 const enabled=await group(true),disabled=await group(false),operatorRole=await role(['portal.operator']);
 await insert('user_group_members',{group_id:enabled,user_id:await user('viagroup')});await assign('group',enabled,ownerRole);
 await insert('user_group_members',{group_id:disabled,user_id:await user('disabledgroup')});await assign('group',disabled,ownerRole);
 await assign('user',await user('inactive','disabled'),ownerRole);
 await assign('user',await user('operator'),operatorRole);
 const expected={direct:true,viagroup:true,disabledgroup:false,inactive:false,operator:false,nobody:false};
 for(const [name,owner] of Object.entries(expected)){
  const v=await viewer(name);
  assert.equal(await access.hasGlobalPermission(v,'*'),owner,name+' (hasGlobalPermission)');
  assert.equal(await can.can(v,'instance.owner'),owner,name);
 }
}));

test('canSql is globalOwnerGuard: the same SQL and bindings for any expression',()=>fixture(async({can,access})=>{
 for(const expression of [sql`${'private:x'}`,sql`policy_actor.principal`,sql`technician.auth_principal`])assert.deepEqual(compile(can.canSql(expression,'instance.owner')),compile(access.globalOwnerGuard(expression)),compile(expression).text);
}));

test('can() asks once per viewer object; a copy, fresh and a failed query ask again',()=>fixture(async({d,stats,user,assign,viewer,ownerRole,can})=>{
 const id=await user('cached');const assignment=await assign('user',id,ownerRole);const v=await viewer('cached');
 const before=JSON.stringify(v);stats.prepared=0;
 assert.equal(await can.can(v,'instance.owner'),true);assert.equal(await can.can(v,'instance.owner'),true);
 assert.equal(stats.prepared,1,'two calls on one viewer: one query');
 assert.equal(JSON.stringify(v),before,'nothing is stored on the viewer');
 assert.deepEqual(Object.getOwnPropertyNames(v).sort(),['displayName','id','label','principal','provider','role','userId','username','authorization'].sort());
 const copy={...v};Object.defineProperty(copy,'authorization',{value:v.authorization,enumerable:false});
 assert.equal(await can.can(copy,'instance.owner'),true);assert.equal(stats.prepared,2,'a spread copy asks again');
 // Concurrent calls on one viewer share the single query.
 const other=await viewer('cached');stats.prepared=0;
 assert.deepEqual(await Promise.all([can.can(other,'instance.owner'),can.can(other,'instance.owner')]),[true,true]);assert.equal(stats.prepared,1);
 // fresh always asks and replaces the cached answer.
 await d.exec(sql`DELETE FROM role_assignments WHERE id=${assignment}`);stats.prepared=0;
 assert.equal(await can.can(v,'instance.owner'),true,'still the cached answer');assert.equal(stats.prepared,0);
 assert.equal(await can.can(v,'instance.owner',{fresh:true}),false);assert.equal(stats.prepared,1);
 assert.equal(await can.can(v,'instance.owner'),false,'the fresh answer is cached');assert.equal(stats.prepared,1);
 // A rejected query is not cached.
 await assign('user',id,ownerRole);const failing=await viewer('cached');stats.prepared=0;stats.failNext=true;
 await assert.rejects(can.can(failing,'instance.owner'),/storage unavailable/);
 assert.equal(await can.can(failing,'instance.owner'),true);assert.equal(stats.prepared,2);
 assert.equal(await can.can(failing,'instance.owner'),true);assert.equal(stats.prepared,2);
}));

test('requireCan resolves for an Owner and answers 403 with the default or the given message',()=>fixture(async({user,assign,viewer,ownerRole,can})=>{
 await assign('user',await user('owner'),ownerRole);await user('reader');
 await can.requireCan(await viewer('owner'),'instance.owner');
 await assert.rejects(can.requireCan(await viewer('reader'),'instance.owner'),error=>error.status===403&&error.message===serverText('apiError.policy.permissionMissing'));
 await assert.rejects(can.requireCan(await viewer('reader'),'instance.owner','apiError.devices.removeAdminOnly'),error=>error.status===403&&error.message===serverText('apiError.devices.removeAdminOnly'));
}));

test('viewerCanSql holds only while the actor is an Owner with a valid stamp',()=>fixture(async({d,user,assign,viewer,ownerRole,can,access})=>{
 const holds=async v=>{const guard=can.viewerCanSql(v,'instance.owner');return !!await d.one(sql`SELECT 1 AS allowed WHERE ${guard}`);};
 const id=await user('stamped'),assignment=await assign('user',id,ownerRole),v=await viewer('stamped');
 const owner=can.canSql(sql`policy_actor.principal`,'instance.owner'),write=access.viewerWriteGuard(v),guard=can.viewerCanSql(v,'instance.owner');
 assert.deepEqual(compile(guard),compile(sql`(EXISTS (SELECT 1 FROM (SELECT ${access.principal(v)}::text AS principal) policy_actor WHERE ${owner})) AND (${write})`));
 assert.equal(await holds(v),true);
 await d.exec(sql`UPDATE local_users SET auth_version=auth_version+1 WHERE id=${id}`);
 assert.equal(await holds(v),false,'a bumped auth_version');
 assert.equal(await holds(await viewer('stamped')),true,'a viewer with the new stamp');
 await d.exec(sql`DELETE FROM role_assignments WHERE id=${assignment}`);
 assert.equal(await holds(await viewer('stamped')),false,'the assignment is gone');
}));

test('the commit stays live: a demotion after the pre-check changes no row while can() keeps its answer',()=>fixture(async({d,user,assign,viewer,ownerRole,can})=>{
 const id=await user('demoted'),assignment=await assign('user',id,ownerRole),v=await viewer('demoted');
 assert.equal(await can.can(v,'instance.owner'),true);
 await d.exec(sql`DELETE FROM role_assignments WHERE id=${assignment}`);
 const guard=can.viewerCanSql(v,'instance.owner');
 const result=await d.exec(sql`UPDATE local_users SET display_name='changed' WHERE id=${id} AND (${guard})`);
 assert.equal(result.rowCount,0);
 assert.equal((await d.one(sql`SELECT display_name FROM local_users WHERE id=${id}`)).display_name,'demoted');
 assert.equal(await can.can(v,'instance.owner'),true,'the pre-check answer is cached for the request');
}));
