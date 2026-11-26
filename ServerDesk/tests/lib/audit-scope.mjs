// Release catalog lifecycle/view regressions supersede the removed campaign UI. Audit rows without a device are
// Owner-only portal rows.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {dbNow,sql} from '../../runtime/database.mjs';

import * as crossCustomerRight from '../../lib/cross-customer-right.ts';
import {i18nRequire} from '../support/i18n-stubs.mjs';
import {runtimePath} from '../support/runtime-path.mjs';

import {sourceDatabase,dbModule} from '../support/source-database.mjs';
const require=createRequire(import.meta.url),database=await sourceDatabase();
const source=name=>fs.readFileSync(name,'utf8');
function compile(name,imports){
 const mod={exports:{}},code=ts.transpileModule(source(name),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 new Function('require','module','exports',code)(id=>i18nRequire(id)??(Object.hasOwn(imports,id)?imports[id]:(id==='./db'||id==='../db'||id==='../../db'?dbModule():require(runtimePath(id)))),mod,mod.exports);return mod.exports;
}
// failure() classifies through the server-independent error modules, compiled as they are.
const errorCodes=compile('lib/errors/codes.ts',{}),errorFailure=compile('lib/server/errors/failure.ts',{'./codes':errorCodes,'./db-codes':compile('lib/server/errors/db-codes.ts',{'../../errors/codes':errorCodes})});
const server=compile('lib/server/context.ts',{'cloudflare:workers':{env:{}},'next/headers':{headers:()=>new Headers()},'./errors/failure':errorFailure});
const access=compile('lib/server/identity/access.ts',{'../context':server,'../../cross-customer-right':crossCustomerRight});
const authorization=compile('lib/server/identity/feature-authorization.ts',{'./access':access});
const policy=compile('lib/server/identity/policy/can.ts',{'../access':access,'../feature-authorization':authorization,'../../context':server});
const audit=compile('lib/server/audit-scope.ts',{'./identity/access':access,'./identity/feature-authorization':authorization,'./identity/policy/can':policy,'./identity/account-names':compile('lib/server/identity/account-names.ts',{})});
const idA=crypto.randomUUID(),idB=crypto.randomUUID(),idC=crypto.randomUUID();
async function user(name,permissions,devices=[],owner=false){
 const id=crypto.randomUUID(),principal='private:'+name,role=crypto.randomUUID();
 await database.exec(sql`INSERT INTO local_users(id,username,display_name,auth_principal,auth_email,status,created_at,updated_at) VALUES(${id},${name},${name},${principal},${name},'active',${Date.now()},${Date.now()})`);
 await database.exec(sql`INSERT INTO rbac_roles(id,name,permissions,created_at) VALUES(${role},${name},${JSON.stringify(permissions)},${Date.now()})`);
 for(const device of owner?['*']:devices)await database.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${crypto.randomUUID()},${'user'},${id},${role},${owner?'global':'device'},${device},${Date.now()},${'fixture'})`);
 // Every reader carries the version stamp of its account (auth_version 1), as resolvePrincipal gives it.
 return {id,label:name,principal,authorization:{authVersion:1}};
}
const read=async guard=>(await database.query(sql`${audit.auditSelect} WHERE ${guard} ORDER BY a.id`));
try{
 // A row without a device (as historical rows were) is an Owner-only portal row on the baseline.
 await database.exec(sql`INSERT INTO audit(at,actor,action,target) VALUES(1,'historic','Geräteaktion','Duplicate / C:\Private')`);
 assert.deepEqual(await database.one(sql`SELECT server_id,scope,target FROM audit`),{server_id:null,scope:'portal',target:'Duplicate / C:\Private'},'a row without a device is an Owner-only portal row and keeps its name');
 for(const id of [idA,idB,idC])await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at) VALUES(${id},${'Duplicate'},${'token'},${Date.now()})`);
 const owner=await user('owner',['*'],[],true),reader=await user('reader',['view','security.events'],[idA]),monitor=await user('monitor',['view'],[idB]),securityOnly=await user('security-only',['security.events'],[idC]),fakeAdmin={...monitor,permissions:['*']};
 await server.log('owner','Agentupdate geplant','4.7.0',[idA,idB,idA]);
 await server.log('owner','SYSTEM-Terminal geöffnet','Sitzung',idC);
 await server.log('owner','Benutzer erstellt','portal-user');
 const campaign=(await database.query(sql`SELECT server_id,scope,target FROM audit WHERE action='Agentupdate geplant'`));
 assert.equal(campaign.length,2,'campaign writes exactly one row per immutable target');
 assert.deepEqual(campaign.map(row=>row.server_id).sort(),[idA,idB].sort());
 assert.ok(campaign.every(row=>row.scope==='device'&&row.target==='4.7.0'),'shared target text never contains another device');
 assert.deepEqual((await read(audit.deviceAuditGuard(reader,[idA,idB]))).map(row=>row.serverId),[idA],'scoped users cannot gain other device audit data from caller-supplied IDs');
 assert.deepEqual(await read(audit.deviceAuditGuard(monitor,[idB])),[],'monitoring alone does not expose security audit details');
 assert.deepEqual(await read(audit.deviceAuditGuard(securityOnly,[idC])),[],'security permission alone still requires device visibility');
 const groupId=crypto.randomUUID(),groupReader=await user('group-reader',['view','security.events']);
 const groupRole=(await database.one(sql`SELECT id FROM rbac_roles WHERE name=${groupReader.label}`)).id;
 await database.exec(sql`INSERT INTO device_groups(id,name,description,created_at) VALUES(${groupId},${'Duplicate group'},${''},${Date.now()})`);
 await database.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${idA},${groupId})`);
 await database.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${crypto.randomUUID()},'user',${groupReader.id},${groupRole},'devicegroup',${groupId},${Date.now()},'fixture')`);
 assert.deepEqual((await read(audit.deviceAuditGuard(groupReader,[idA,idB,idC]))).map(row=>row.serverId),[idA],'group-inherited permissions still isolate current members by immutable device ID');
 await database.exec(sql`DELETE FROM device_group_members WHERE server_id=${idA}`);
 assert.deepEqual(await read(audit.deviceAuditGuard(groupReader,[idA])),[],'group membership changes are live at audit read time');
 assert.deepEqual((await read(audit.deviceAuditGuard(owner,[idA,idB,idC]))).map(row=>row.serverId).sort(),[idA,idB,idC].sort());
 assert.deepEqual((await read(audit.portalAuditGuard(owner))).map(row=>row.scope),['portal','portal'],'new device events are absent from portal logs');
 assert.deepEqual(await read(audit.portalAuditGuard(fakeAdmin)),[],'client-side permissions cannot bypass live owner authorization');
 await database.exec(sql`UPDATE servers SET name=${'Renamed'} WHERE id=${idA}`);
 assert.equal((await read(audit.deviceAuditGuard(reader,[idA])))[0].serverId,idA,'renaming and duplicate names never affect association');
 const local={...reader};
 assert.equal((await read(audit.deviceAuditGuard(local,[idA]))).length,1);
 assert.deepEqual(await read(audit.deviceAuditGuard({...local,authorization:{authVersion:2}},[idA])),[],'stale account versions cannot read history');
 assert.deepEqual(await read(audit.deviceAuditGuard({...local,authorization:undefined},[idA])),[],'a viewer without a stamp fails closed');
 const time=Date.now(),sessionHash=crypto.randomBytes(32).toString('hex'),mfaHash=crypto.randomBytes(32).toString('hex');
 await database.exec(sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${reader.principal},${'isolated-test-fixture'},${'[]'},${-1},${time})`);
 await database.exec(sql`INSERT INTO mfa_sessions(token_hash,principal,created_at,last_activity,idle_expires_at,expires_at) VALUES(${mfaHash},${reader.principal},${time},${time},${time+60000},${time+60000})`);
 await database.exec(sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) VALUES(${sessionHash},${reader.id},${1},${time},${time+60000},${time+60000},${mfaHash})`);
 const boundLocal={...local,authorization:{authVersion:1,sessionHash}};
 assert.equal((await read(audit.deviceAuditGuard(boundLocal,[idA]))).length,1,'live primary and MFA sessions authorize device audit history');
 // Set this expired fixture relative to the database clock that the
 // production SQL guard uses (dbNow), not the JS clock.
 const databaseClock=()=>database.one(sql`SELECT ${dbNow} AS clock`).then(row=>row===null?null:row.clock);
 const expiredIdle=Number(await databaseClock())-1000;
 await database.exec(sql`UPDATE mfa_sessions SET idle_expires_at=${expiredIdle} WHERE token_hash=${mfaHash}`);
 assert.ok(Number(await databaseClock())>=expiredIdle,'expired MFA fixture is in the past according to the database authorization clock');
 assert.deepEqual(await read(audit.deviceAuditGuard(boundLocal,[idA])),[],'MFA idle expiration blocks an already-admitted audit query');
 await database.exec(sql`UPDATE mfa_sessions SET idle_expires_at=${time+60000} WHERE token_hash=${mfaHash}`);
 await database.exec(sql`DELETE FROM local_auth_sessions WHERE token_hash=${sessionHash}`);
 assert.deepEqual(await read(audit.deviceAuditGuard(boundLocal,[idA])),[],'primary logout blocks an already-admitted audit query');
 await database.exec(sql`DELETE FROM role_assignments WHERE principal_id=${reader.id}`);
 assert.deepEqual(await read(audit.deviceAuditGuard(reader,[idA])),[],'revocation after a visibility snapshot is checked again in the query');
 await database.exec(sql`UPDATE servers SET revoked=1 WHERE id=${idB}`);
 assert.ok((await read(audit.deviceAuditGuard(owner,[idA,idB,idC]))).every(row=>row.serverId!==idB),'removed devices cannot leak into active scopes');
 await database.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${owner.id}`);
 assert.deepEqual(await read(audit.portalAuditGuard(owner)),[],'deactivated owners cannot read portal archives');
 await assert.rejects(server.log('owner','Invalid','target','Duplicate'),/Ungültige Gerätezuordnung/);
 const before=await database.one(sql`SELECT count(*) AS count FROM audit`);await server.log('owner','No targets','empty',[]);assert.deepEqual(await database.one(sql`SELECT count(*) AS count FROM audit`),before);
 await assert.rejects(database.exec(sql`INSERT INTO audit(at,actor,action,target,scope) VALUES(2,'actor','action','target','invalid')`),/audit_scope/);
 await assert.rejects(database.exec(sql`INSERT INTO audit(at,actor,action,target,scope) VALUES(3,'actor','action','target','legacy')`),/audit_scope/,'the scope legacy is gone');
 // The audit log page and the device access views render through the shared ActivityTable: the Area column
 // (Portal or the customer), the device names and the targets are checked in tests/ui/settings/audit-log-view.mjs and
 // tests/ui/devices/history-access-view.mjs; targetName and the older-entries cursor against PostgreSQL in tests/api/audit-log-api.mjs.
 console.log('PASS: audit rows without a device are Owner-only portal rows; immutable device IDs, isolated campaigns and live view/security/owner/session guards protect scoped audit history.');
}finally{database.close();}
