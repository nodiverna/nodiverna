// The customer model invariants also run here so the merge check covers them.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import {sql,SqlFragment} from '../../runtime/database.mjs';

import {migrateDatabase} from '../../scripts/selfhost.mjs';

import {sourceDatabase,insertRow,tableColumns,tableIndexes,indexColumns} from '../support/source-database.mjs';
import {serverDeskRoot} from '../support/paths.mjs';
const root=serverDeskRoot,require=createRequire(import.meta.url);
const firstCustomer='00000000-0000-4000-8000-000000000100';
const mismatchMessage=serverText('apiError.customer.mismatch');
// A trigger exception as the driver throws it: SQLSTATE P0001 with the literal as message.
const constraintError=message=>Object.assign(new Error(message),{code:'P0001',severity:'ERROR'});
const migrationCount=readdirSync(resolve(root,'drizzle')).filter(name=>/^\d{4}_.+\.sql$/.test(name)).length;

async function fixture(run){
 const d=await sourceDatabase(),cache=new Map();
 const HttpError=realHttpError;
 const server={db:()=>d,guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value),HttpError,now:()=>Date.now(),log:async()=>{}};
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
 const customer=async(name,extra={})=>{const id=randomUUID(),at=Date.now();await insert('customers',{id,name,created_at:at,updated_at:at,...extra});return id;};
 const group=async(name,parentId=null,customerId)=>{const id=randomUUID();await insert('device_groups',{id,name,parent_id:parentId,created_at:Date.now(),...(customerId?{customer_id:customerId}:{})});return id;};
 const device=async(name,customerId)=>{const id=randomUUID();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:Date.now(),...(customerId?{customer_id:customerId}:{})});return id;};
 const customerOf=(table,id)=>d.one(sql`SELECT customer_id FROM ${sql.ident(table)} WHERE id=${id}`).then(row=>row===null?null:row.customer_id);
 try{return await run({d,insert,customer,group,device,customerOf,load});}finally{d.close();}
}

test('a fresh migration creates exactly the first customer and still no groups or users; a rerun applies nothing',async()=>fixture(async({d})=>{
 const customers=(await d.query(sql`SELECT * FROM customers`));
 assert.equal(customers.length,1);
 const [first]=customers;
 assert.deepEqual({...first,created_at:0,updated_at:0},{id:firstCustomer,name:'Standardkunde',status:'active',contact_name:'',contact_email:'',contact_phone:'',created_at:0,updated_at:0,audit_retention_days:null,maintenance_days:null,maintenance_start:null,maintenance_duration:null,maintenance_time_zone:null,revision:0},'the settings of 0031 start empty');
 assert.equal(first.created_at,first.updated_at);
 // The seed row is written when the database is migrated (the test template may be older than this run).
 assert.ok(Number.isInteger(first.created_at)&&first.created_at>Date.UTC(2020,0,1)&&first.created_at<=Date.now()+1000,'timestamps are milliseconds');
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_groups`).then(row=>row===null?null:row.n),0,'new installations still start without a device group');
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM local_users`).then(row=>row===null?null:row.n),0,'migration creates no users');
 assert.deepEqual(await migrateDatabase(d),{applied:0,total:migrationCount});
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM customers`).then(row=>row===null?null:row.n),1,'a second run adds no customer');
 const columns=Object.fromEntries((await tableColumns(d,'customers')).map(column=>[column.name,column]));
 assert.deepEqual(Object.keys(columns),['id','name','status','contact_name','contact_email','contact_phone','created_at','updated_at','audit_retention_days','maintenance_days','maintenance_start','maintenance_duration','maintenance_time_zone','revision']);
 for(const name of['audit_retention_days','maintenance_days','maintenance_start','maintenance_duration']){assert.equal(columns[name].type.toUpperCase(),'BIGINT');assert.equal(columns[name].notnull,0);assert.equal(columns[name].dflt_value,null);}
 assert.equal(columns.maintenance_time_zone.type.toUpperCase(),'TEXT');assert.equal(columns.maintenance_time_zone.notnull,0);
 assert.equal(columns.revision.type.toUpperCase(),'BIGINT');assert.equal(columns.revision.notnull,1);assert.equal(columns.revision.dflt_value,'0');
 assert.equal(columns.id.pk,1);assert.equal(columns.id.type.toUpperCase(),'TEXT');
 assert.equal(columns.status.dflt_value,"'active'");
 for(const name of['contact_name','contact_email','contact_phone']){assert.equal(columns[name].type.toUpperCase(),'TEXT');assert.equal(columns[name].notnull,1);assert.equal(columns[name].dflt_value,"''");}
 for(const name of['created_at','updated_at'])assert.equal(columns[name].type.toUpperCase(),'BIGINT');
 for(const table of['servers','device_groups']){
  const column=(await tableColumns(d,table)).find(entry=>entry.name==='customer_id');
  assert.ok(column,table+' has customer_id');assert.equal(column.type.toUpperCase(),'TEXT');assert.equal(column.notnull,1);
 }
}));

test('customer rows need a known status, a visible name and a case-insensitively unique name',async()=>fixture(async({d,customer})=>{
 await assert.rejects(()=>customer('Archiv',{status:'archived'}),error=>error.code==='23514');
 await assert.rejects(()=>customer(''),error=>error.code==='23514');
 await assert.rejects(()=>customer('   '),error=>error.code==='23514');
 await assert.rejects(()=>customer('\t \n'),error=>error.code==='23514');
 await assert.rejects(()=>customer('standardkunde'),error=>error.code==='23505');
 await assert.rejects(()=>customer('STANDARDKUNDE'),error=>error.code==='23505');
 const disabled=await customer('Kunde B',{status:'disabled'});
 assert.equal(await d.one(sql`SELECT status FROM customers WHERE id=${disabled}`).then(row=>row===null?null:row.status),'disabled');
 const active=await customer('Kunde C');
 assert.deepEqual(await d.one(sql`SELECT status,contact_name,contact_email,contact_phone FROM customers WHERE id=${active}`),{status:'active',contact_name:'',contact_email:'',contact_phone:''});
}));

test('devices and groups inserted without customer_id belong to the first customer',async()=>fixture(async({group,device,customerOf})=>{
 const parent=await group('Root'),child=await group('Child',parent),server=await device('A');
 assert.equal(await customerOf('device_groups',parent),firstCustomer);
 assert.equal(await customerOf('device_groups',child),firstCustomer);
 assert.equal(await customerOf('servers',server),firstCustomer);
}));

test('the database keeps groups, subgroups and memberships within one customer',async()=>fixture(async({d,insert,customer,group,device,customerOf})=>{
 const other=await customer('Kunde B'),unknown=randomUUID();
 // (a) unknown customers
 await assert.rejects(()=>device('Unknown',unknown),/customer-missing/);
 await assert.rejects(()=>group('Unknown',null,unknown),/customer-missing/);
 const defaultRoot=await group('Default root'),defaultDevice=await device('Default device');
 await assert.rejects(()=>d.exec(sql`UPDATE servers SET customer_id=${unknown} WHERE id=${defaultDevice}`),/customer-missing/);
 await assert.rejects(()=>d.exec(sql`UPDATE device_groups SET customer_id=${unknown} WHERE id=${defaultRoot}`),/customer-missing/);
 // Links within the second customer succeed.
 const otherRoot=await group('Other root',null,other),otherChild=await group('Other child',otherRoot,other),otherDevice=await device('Other device',other);
 await insert('device_group_members',{server_id:otherDevice,group_id:otherChild});
 assert.equal(await customerOf('device_groups',otherChild),other);
 // (b) subgroup of another customer's group, on insert and on update
 await assert.rejects(()=>group('Foreign child',otherRoot),/customer-mismatch/,'a subgroup without customer_id cannot join a foreign parent');
 await assert.rejects(()=>group('Foreign child',defaultRoot,other),/customer-mismatch/);
 const defaultChild=await group('Default child',defaultRoot);
 await assert.rejects(()=>d.exec(sql`UPDATE device_groups SET parent_id=${otherRoot} WHERE id=${defaultChild}`),/customer-mismatch/);
 const lone=await group('Lone',null,other);
 await assert.rejects(()=>d.exec(sql`UPDATE device_groups SET parent_id=${defaultRoot} WHERE id=${lone}`),/customer-mismatch/);
 await d.exec(sql`UPDATE device_groups SET parent_id=${otherRoot} WHERE id=${lone}`);
 assert.equal(await d.one(sql`SELECT parent_id FROM device_groups WHERE id=${lone}`).then(row=>row===null?null:row.parent_id),otherRoot,'reparenting within one customer succeeds');
 // (c) membership across customers
 await assert.rejects(()=>insert('device_group_members',{server_id:defaultDevice,group_id:otherRoot}),/customer-mismatch/);
 await assert.rejects(()=>insert('device_group_members',{server_id:otherDevice,group_id:defaultRoot}),/customer-mismatch/);
 await insert('device_group_members',{server_id:defaultDevice,group_id:defaultChild});
 await assert.rejects(()=>d.exec(sql`UPDATE device_group_members SET group_id=${otherRoot} WHERE server_id=${defaultDevice}`),/customer-mismatch/);
 // (d) changing customer_id under existing links
 await assert.rejects(()=>d.exec(sql`UPDATE servers SET customer_id=${other} WHERE id=${defaultDevice}`),/customer-mismatch/,'member device cannot leave its group customer');
 await assert.rejects(()=>d.exec(sql`UPDATE device_groups SET customer_id=${other} WHERE id=${defaultChild}`),/customer-mismatch/,'subgroup cannot leave its parent customer');
 await assert.rejects(()=>d.exec(sql`UPDATE device_groups SET customer_id=${firstCustomer} WHERE id=${otherRoot}`),/customer-mismatch/,'parent cannot leave its children customer');
 const memberGroup=await group('Member root'),memberDevice=await device('Member device');await insert('device_group_members',{server_id:memberDevice,group_id:memberGroup});
 await assert.rejects(()=>d.exec(sql`UPDATE device_groups SET customer_id=${other} WHERE id=${memberGroup}`),/customer-mismatch/,'group cannot leave its member devices customer');
 const looseDevice=await device('Loose');await d.exec(sql`UPDATE servers SET customer_id=${other} WHERE id=${looseDevice}`);
 assert.equal(await customerOf('servers',looseDevice),other,'an ungrouped device has no link to break');
 for(const [table,id] of[['servers',defaultDevice],['device_groups',defaultChild],['device_groups',otherRoot],['device_groups',memberGroup]])assert.notEqual(await customerOf(table,id),null);
 assert.equal(await customerOf('servers',defaultDevice),firstCustomer);
 // (e) deleting a customer in use, (f) deleting the first customer
 await assert.rejects(()=>d.exec(sql`DELETE FROM customers WHERE id=${other}`),/customer-in-use/);
 await assert.rejects(()=>d.exec(sql`DELETE FROM customers WHERE id=${firstCustomer}`),/customer-default-protected/);
 await assert.rejects(()=>d.exec(sql`UPDATE customers SET id=${randomUUID()} WHERE id=${firstCustomer}`),/customer-default-protected/);
 await assert.rejects(()=>d.exec(sql`UPDATE customers SET id=${randomUUID()} WHERE id=${other}`),/customer-in-use/);
 await d.exec(sql`UPDATE customers SET name='Erster Kunde' WHERE id=${firstCustomer}`);
 assert.equal(await d.one(sql`SELECT name FROM customers WHERE id=${firstCustomer}`).then(row=>row===null?null:row.name),'Erster Kunde','the first customer can be renamed');
 const empty=await customer('Kunde leer');
 await d.exec(sql`DELETE FROM customers WHERE id=${empty}`);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM customers WHERE id=${empty}`).then(row=>row===null?null:row.n),0,'an empty customer can be deleted');
 const onlyDevices=await customer('Kunde Geräte');await device('Device only',onlyDevices);
 await assert.rejects(()=>d.exec(sql`DELETE FROM customers WHERE id=${onlyDevices}`),/customer-in-use/,'devices alone keep a customer in use');
 const onlyGroups=await customer('Kunde Gruppen');await group('Group only',null,onlyGroups);
 await assert.rejects(()=>d.exec(sql`DELETE FROM customers WHERE id=${onlyGroups}`),/customer-in-use/,'groups alone keep a customer in use');
}));

test('lib/server/identity/customers reads customers, device and group customers through db()',async()=>fixture(async({d,customer,group,device,load})=>{
 const customers=load('lib/server/identity/customers.ts');
 assert.equal(customers.defaultCustomerId,firstCustomer);
 const zeta=await customer('Zeta',{contact_name:'Erika Muster',contact_email:'erika@example.test',contact_phone:'+49 30 123',status:'disabled'}),alpha=await customer('alpha');
 assert.deepEqual((await customers.listCustomers()).map(entry=>entry.name),['alpha','Standardkunde','Zeta'],'sorted by name');
 const [first]=(await customers.listCustomers()).filter(entry=>entry.id===firstCustomer);
 assert.deepEqual(Object.keys(first).sort(),['auditRetentionDays','contactEmail','contactName','contactPhone','createdAt','deviceCount','groupCount','id','maintenanceWindow','name','revision','roleCount','runbookCount','status','templateCount','updatedAt']);
 const loaded=await customers.customerById(zeta);
 assert.deepEqual({...loaded,createdAt:0,updatedAt:0},{id:zeta,name:'Zeta',status:'disabled',contactName:'Erika Muster',contactEmail:'erika@example.test',contactPhone:'+49 30 123',createdAt:0,updatedAt:0,auditRetentionDays:null,maintenanceWindow:null,revision:0,deviceCount:0,groupCount:0,runbookCount:0,templateCount:0,roleCount:0});
 assert.equal(typeof loaded.createdAt,'number');
 assert.equal((await customers.customerById(firstCustomer)).name,'Standardkunde');
 assert.equal(await customers.customerById(randomUUID()),null,'unknown id');
 for(const invalid of['not-a-guid','',null,undefined,42,"' OR 1=1 --"])assert.equal(await customers.customerById(invalid),null,'invalid id yields null');
 const server=await device('A'),alphaServer=await device('B',alpha),root=await group('Root'),alphaGroup=await group('Alpha',null,alpha);
 assert.equal(await customers.deviceCustomerId(server),firstCustomer);
 assert.equal(await customers.deviceCustomerId(alphaServer),alpha);
 assert.equal(await customers.deviceCustomerId(randomUUID()),null);
 assert.equal(await customers.groupCustomerId(root),firstCustomer);
 assert.equal(await customers.groupCustomerId(alphaGroup),alpha);
 assert.equal(await customers.groupCustomerId(randomUUID()),null);
 assert.equal(await customers.groupCustomerId(null),null);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM customers`).then(row=>row===null?null:row.n),3);
}));

test('moving a device into another customer\'s group ends as 409 without membership or audit entry',async()=>fixture(async({d,insert,customer,group,device,load})=>{
 const id=randomUUID(),at=Date.now(),principal='private:owner@customers.test',roleId=randomUUID();
 await insert('local_users',{id,username:'owner',display_name:'owner',auth_principal:principal,auth_email:'owner@customers.test',status:'active',created_at:at,updated_at:at});
 await insert('rbac_roles',{id:roleId,name:roleId,permissions:JSON.stringify(['*']),created_at:at});
 await insert('role_assignments',{id:randomUUID(),principal_type:'user',principal_id:id,role_id:roleId,scope_type:'global',scope_id:'*',created_at:at,created_by:'fixture'});
 // A signed-in viewer carries the authorization stamp of its account.
 const owner=Object.defineProperty({id,principal,label:'owner@customers.test'},'authorization',{value:{authVersion:1},enumerable:false});
 const proof=async()=>{const tokenHash=randomUUID(),sessionHash=randomUUID();await insert('mfa_management_proofs',{token_hash:tokenHash,principal,session_hash:sessionHash,expires_at:Date.now()+60000});return {tokenHash,key:principal,sessionHash,guard:sql`EXISTS (SELECT 1 FROM mfa_management_proofs WHERE token_hash=${tokenHash} AND expires_at>${Date.now()})`};};
 const other=await customer('Kunde B'),foreign=await group('Fremd',null,other),own=await group('Eigen'),server=await device('A');
 const membership=load('lib/server/devices/device-group-membership.ts'),confirmation=await proof();
 await assert.rejects(()=>membership.changeDeviceMemberships(owner,[server],foreign,true,confirmation.guard),error=>error.status===409&&error.message===mismatchMessage);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_group_members`).then(row=>row===null?null:row.n),0,'no membership is written');
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM audit`).then(row=>row===null?null:row.n),0,'no audit entry is written');
 assert.ok(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash}`),'the confirmation stays unused');
 assert.deepEqual(await membership.changeDeviceMemberships(owner,[server],own,true,(await proof()).guard),{ok:true,count:1},'a group of the same customer still works');
 const second=await proof();await assert.rejects(()=>membership.changeDeviceMemberships(owner,[server],foreign,true,second.guard),error=>error.status===409&&error.message===mismatchMessage,'a move out of a group is refused as a whole');
 assert.deepEqual((await d.query(sql`SELECT group_id FROM device_group_members WHERE server_id=${server}`)),[{group_id:own}],'the previous membership is kept');
}));

test('customer-mismatch maps to the German 409 message',async()=>fixture(async({load})=>{
 const {deviceGroupConflict}=load('lib/server/devices/device-groups.ts');
 for(const error of [constraintError('customer-mismatch'),Object.assign(new Error('Statement failed.'),{cause:constraintError('customer-mismatch')})]){
  const conflict=deviceGroupConflict(error);
  assert.deepEqual([conflict.status,conflict.message,conflict.code],[409,mismatchMessage,'CUSTOMER_MISMATCH']);
 }
 const mapped=load('lib/server/identity/rbac.ts').rbacFailure(constraintError('customer-mismatch'));
 assert.equal(mapped.status,409);assert.equal(mapped.message,mismatchMessage);
}));

// Migration 0031: per-customer settings and the first effect of 'disabled'.
test('customer settings are all-or-nothing and within their bounds, also for direct SQL',async()=>fixture(async({d,customer,load})=>{
 // A fragment, or fixture SQL text with ? placeholders for the bindings.
 const update=(set,...bindings)=>d.exec(sql`UPDATE customers SET ${typeof set==='string'?new SqlFragment(set.split('?'),bindings):set} WHERE id=${firstCustomer}`);
 const settings=()=>d.one(sql`SELECT audit_retention_days,maintenance_days,maintenance_start,maintenance_duration,maintenance_time_zone,revision FROM customers WHERE id=${firstCustomer}`);
 const before=await settings();
 for(const [sql,...bindings] of [
  ['audit_retention_days=0'],['audit_retention_days=3651'],['audit_retention_days=?',1.5],['audit_retention_days=?','dreißig'],
  ['maintenance_days=31'],['maintenance_start=0'],['maintenance_duration=60'],['maintenance_time_zone=?','UTC'],
  ['maintenance_days=0,maintenance_start=0,maintenance_duration=60,maintenance_time_zone=?','UTC'],['maintenance_days=128,maintenance_start=0,maintenance_duration=60,maintenance_time_zone=?','UTC'],
  ['maintenance_days=1,maintenance_start=1430,maintenance_duration=60,maintenance_time_zone=?','UTC'],['maintenance_days=1,maintenance_start=10,maintenance_duration=60,maintenance_time_zone=?','UTC'],['maintenance_days=1,maintenance_start=-15,maintenance_duration=60,maintenance_time_zone=?','UTC'],
  ['maintenance_days=1,maintenance_start=0,maintenance_duration=735,maintenance_time_zone=?','UTC'],['maintenance_days=1,maintenance_start=0,maintenance_duration=20,maintenance_time_zone=?','UTC'],['maintenance_days=1,maintenance_start=0,maintenance_duration=0,maintenance_time_zone=?','UTC'],
  ['maintenance_days=1,maintenance_start=0,maintenance_duration=60,maintenance_time_zone=?',''],['maintenance_days=1,maintenance_start=0,maintenance_duration=60,maintenance_time_zone=?','x'.repeat(65)],
  ['revision=-1'],['revision=NULL'],
 ])await assert.rejects(()=>update(sql,...bindings),error=>['23514','23502','22P02'].includes(error.code),sql);
 assert.deepEqual(await settings(),before,'nothing changed');
 await assert.rejects(()=>customer('Halbes Fenster',{maintenance_days:3}),error=>error.code==='23514'&&error.constraint_name==='customers_settings_valid','an insert with half a window');
 await assert.rejects(()=>customer('Null Tage',{audit_retention_days:0}),error=>error.code==='23514'&&error.constraint_name==='customers_settings_valid');
 await update(sql`audit_retention_days=1,maintenance_days=127,maintenance_start=1425,maintenance_duration=720,maintenance_time_zone=${'Europe/Berlin'}`);
 await update(sql`audit_retention_days=3650,maintenance_days=1,maintenance_start=0,maintenance_duration=15,maintenance_time_zone=${'x'.repeat(64)}`);
 const full=await customer('Vollständig',{audit_retention_days:30,maintenance_days:1|16,maintenance_start:22*60,maintenance_duration:240,maintenance_time_zone:'Europe/Berlin'});
 await update(sql`audit_retention_days=NULL,maintenance_days=NULL,maintenance_start=NULL,maintenance_duration=NULL,maintenance_time_zone=NULL,revision=revision+1`);
 assert.deepEqual(await settings(),{audit_retention_days:null,maintenance_days:null,maintenance_start:null,maintenance_duration:null,maintenance_time_zone:null,revision:1},'clearing all four removes the window');
 const customers=load('lib/server/identity/customers.ts');
 assert.deepEqual((await customers.customerById(full)).maintenanceWindow,{days:[1,5],start:'22:00',durationMinutes:240,timeZone:'Europe/Berlin'},'mask and minutes read back as weekdays and HH:MM');
 assert.equal((await customers.customerById(full)).auditRetentionDays,30);
 assert.deepEqual(customers.maintenanceDaysFromMask(127),[1,2,3,4,5,6,7]);assert.equal(customers.maintenanceDaysMask([1,7]),65);assert.equal(customers.maintenanceStartText(5),'00:05');
}));

test('a disabled customer keeps its devices and groups but takes no new ones; the first customer stays active',async()=>fixture(async({d,insert,customer,group,device,customerOf,load})=>{
 await assert.rejects(()=>d.exec(sql`UPDATE customers SET status='disabled' WHERE id=${firstCustomer}`),/customer-default-protected/);
 assert.equal(await d.one(sql`SELECT status FROM customers WHERE id=${firstCustomer}`).then(row=>row===null?null:row.status),'active');
 await d.exec(sql`UPDATE customers SET name='Erster Kunde',status='active' WHERE id=${firstCustomer}`);
 const other=await customer('Kunde B'),root=await group('Root B',null,other),child=await group('Child B',root,other),server=await device('Gerät B',other),loose=await device('Ohne Gruppe');
 await insert('device_group_members',{server_id:server,group_id:child});
 const defaultRoot=await group('Default root');
 await d.exec(sql`UPDATE customers SET status='disabled' WHERE id=${other}`);
 await assert.rejects(()=>device('Neu B',other),/customer-disabled/,'no new device');
 await assert.rejects(()=>group('Neu B',null,other),/customer-disabled/,'no new root group');
 await assert.rejects(()=>group('Neue Untergruppe',root,other),/customer-disabled/,'no new subgroup');
 await assert.rejects(()=>d.exec(sql`UPDATE servers SET customer_id=${other} WHERE id=${loose}`),/customer-disabled/,'no device moved onto it');
 await assert.rejects(()=>d.exec(sql`UPDATE device_groups SET customer_id=${other} WHERE id=${defaultRoot}`),/customer-disabled/,'no group moved onto it');
 // Everything it already has stays and keeps working.
 assert.equal(await customerOf('servers',server),other);assert.equal(await customerOf('servers',loose),firstCustomer);
 assert.equal(await customerOf('device_groups',root),other);assert.equal(await customerOf('device_groups',child),other);assert.equal(await customerOf('device_groups',defaultRoot),firstCustomer);
 assert.deepEqual((await d.query(sql`SELECT group_id FROM device_group_members WHERE server_id=${server}`)),[{group_id:child}]);
 await d.exec(sql`UPDATE servers SET name='Gerät B neu',last_seen=1 WHERE id=${server}`);
 await d.exec(sql`UPDATE servers SET customer_id=customer_id WHERE id=${server}`);
 await d.exec(sql`UPDATE device_groups SET name='Root B neu' WHERE id=${root}`);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM servers WHERE customer_id=${other}`).then(row=>row===null?null:row.n),1);
 await d.exec(sql`UPDATE customers SET status='active' WHERE id=${other}`);
 const later=await device('Neu B',other),revoked=await device('Alt B',other);
 await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${revoked}`);
 assert.equal(await customerOf('servers',later),other,'after enabling, new devices are accepted again');
 const counts=Object.fromEntries((await load('lib/server/identity/customers.ts').listCustomers()).map(entry=>[entry.name,[entry.deviceCount,entry.groupCount,entry.status]]));
 assert.deepEqual(counts,{'Erster Kunde':[1,1,'active'],'Kunde B':[2,2,'active']},'devices without revoked ones and groups per customer');
}));

test('customer-disabled maps to the German 409 message',async()=>fixture(async({load})=>{
 const message=serverText('apiError.customer.disabled');
 const conflict=load('lib/server/devices/device-groups.ts').deviceGroupConflict(constraintError('customer-disabled'));
 assert.deepEqual([conflict.status,conflict.message,conflict.code],[409,message,'CUSTOMER_DISABLED']);
 const mapped=load('lib/server/identity/rbac.ts').rbacFailure(constraintError('customer-disabled'));
 assert.equal(mapped.status,409);assert.equal(mapped.message,message);
}));

// ---- Customer assignments, the membership gap and the customer boundary ----
const memberMissingMessage=serverText('apiError.group.memberMissing');
async function user(insert,name,status='active'){const id=randomUUID(),at=Date.now();await insert('local_users',{id,username:name,email:name+'@example.test',display_name:name==='nolabel'?'':name.toUpperCase(),auth_principal:'local:'+id,auth_email:name+'@example.test',status,auth_version:1,created_at:at,updated_at:at});return {id,principal:'local:'+id,label:name+'@example.test'};}
async function userGroup(insert,name,enabled=1){const id=randomUUID();await insert('user_groups',{id,name,description:'',enabled,created_at:Date.now()});return id;}
async function ownerRole(insert,subjectType,subjectId){const roleId=randomUUID(),at=Date.now();await insert('rbac_roles',{id:roleId,name:'Owner '+roleId,description:'',permissions:'["*"]',builtin:0,created_at:at});await insert('role_assignments',{id:randomUUID(),principal_type:subjectType,principal_id:subjectId,role_id:roleId,scope_type:'global',scope_id:'*',created_at:at,created_by:'test'});}
const assign=(insert,customerId,type,id)=>insert('customer_assignments',{customer_id:customerId,principal_type:type,principal_id:id,created_at:Date.now(),created_by:'test'});
const assignmentCount=async d=>Number(await d.one(sql`SELECT count(*) AS n FROM customer_assignments`).then(row=>row===null?null:row.n));

test('customer_assignments has its columns, CHECK, primary key and subject index, and the migration adds no rows',async()=>fixture(async({d,insert})=>{
 const columns=await tableColumns(d,'customer_assignments');
 assert.deepEqual(columns.map(column=>[column.name,column.type.toUpperCase(),column.notnull,column.pk]),[['customer_id','TEXT',1,1],['principal_type','TEXT',1,2],['principal_id','TEXT',1,3],['created_at','BIGINT',1,0],['created_by','TEXT',1,0]]);
 const index=(await tableIndexes(d,'customer_assignments')).find(row=>row.name==='customer_assignments_subject');
 assert.ok(index,'the subject index exists');
 assert.deepEqual(await indexColumns(d,'customer_assignments_subject'),['principal_type','principal_id']);
 assert.equal(await assignmentCount(d),0,'the migration creates no assignments');
 const person=await user(insert,'check');
 await assert.rejects(assign(insert,firstCustomer,'role',person.id),error=>error.code==='23514','only user or group');
 await assign(insert,firstCustomer,'user',person.id);
 await assert.rejects(assign(insert,firstCustomer,'user',person.id),error=>error.code==='23505','one row per customer and subject');
}));

test('assignments need a known customer and subject and disappear with them',async()=>fixture(async({d,insert,customer,group})=>{
 const person=await user(insert,'tech'),team=await userGroup(insert,'Team'),other=await customer('Kunde Assign');
 await assert.rejects(assign(insert,randomUUID(),'user',person.id),/customer-missing/);
 await assert.rejects(assign(insert,firstCustomer,'user',randomUUID()),/customer-assignment-subject-missing/);
 await assert.rejects(assign(insert,firstCustomer,'group',randomUUID()),/customer-assignment-subject-missing/);
 await assert.rejects(assign(insert,firstCustomer,'group',person.id),/customer-assignment-subject-missing/,'a user id is no group');
 await assert.rejects(assign(insert,firstCustomer,'user',team),/customer-assignment-subject-missing/,'a group id is no user');
 assert.equal(await assignmentCount(d),0);
 for(const customerId of [firstCustomer,other]){await assign(insert,customerId,'user',person.id);await assign(insert,customerId,'group',team);}
 await assert.rejects(d.exec(sql`UPDATE customer_assignments SET customer_id=${randomUUID()} WHERE customer_id=${other} AND principal_type=${'user'}`),/customer-missing/);
 await assert.rejects(d.exec(sql`UPDATE customer_assignments SET principal_id=${randomUUID()} WHERE customer_id=${other} AND principal_type=${'user'}`),/customer-assignment-subject-missing/);
 assert.equal(await assignmentCount(d),4,'refused updates change nothing');
 // Deleting the user, the user group and an empty customer removes their rows.
 await d.exec(sql`DELETE FROM local_users WHERE id=${person.id}`);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM customer_assignments WHERE principal_type='user'`).then(row=>row===null?null:row.n),0,'user rows are gone');
 await d.exec(sql`DELETE FROM customers WHERE id=${other}`);
 assert.deepEqual((await d.query(sql`SELECT customer_id,principal_type FROM customer_assignments`)).map(row=>[row.customer_id,row.principal_type]),[[firstCustomer,'group']],'customer rows are gone');
 await d.exec(sql`DELETE FROM user_groups WHERE id=${team}`);
 assert.equal(await assignmentCount(d),0,'group rows are gone');
 // A customer that still owns a group keeps its assignments (the delete is refused).
 const busy=await customer('Kunde Busy'),keeper=await user(insert,'keeper');await group('Busy group',null,busy);await assign(insert,busy,'user',keeper.id);
 await assert.rejects(d.exec(sql`DELETE FROM customers WHERE id=${busy}`),/customer-in-use/);
 assert.equal(await assignmentCount(d),1);
 // A customer whose id changes (only possible while it owns nothing) loses them.
 const empty=await customer('Kunde Leer');await assign(insert,empty,'user',keeper.id);
 await d.exec(sql`UPDATE customers SET id=${randomUUID()} WHERE id=${empty}`);
 assert.equal(await assignmentCount(d),1,'the assignment of the renamed id is gone');
}));

test('a membership needs an existing device and group on INSERT and UPDATE; valid memberships still work',async()=>fixture(async({d,insert,group,device,load})=>{
 const g=await group('Ziel'),g2=await group('Ziel 2'),s=await device('Gerät'),s2=await device('Gerät 2');
 await assert.rejects(insert('device_group_members',{server_id:randomUUID(),group_id:g}),/device-group-member-missing/,'missing device');
 await assert.rejects(insert('device_group_members',{server_id:s,group_id:randomUUID()}),/device-group-member-missing/,'missing group');
 await insert('device_group_members',{server_id:s,group_id:g});
 await assert.rejects(d.exec(sql`UPDATE device_group_members SET group_id=${randomUUID()} WHERE server_id=${s}`),/device-group-member-missing/,'update onto a missing group');
 await assert.rejects(d.exec(sql`UPDATE device_group_members SET server_id=${randomUUID()} WHERE server_id=${s}`),/device-group-member-missing/,'update onto a missing device');
 await d.exec(sql`UPDATE device_group_members SET group_id=${g2} WHERE server_id=${s}`);
 await insert('device_group_members',{server_id:s2,group_id:g});
 assert.deepEqual((await d.query(sql`SELECT server_id,group_id FROM device_group_members ORDER BY group_id=${g2} DESC`)).map(row=>[row.server_id,row.group_id]),[[s,g2],[s2,g]]);
 const {deviceGroupConflict}=load('lib/server/devices/device-groups.ts');
 for(const error of [constraintError('device-group-member-missing'),Object.assign(new Error('Statement failed.'),{cause:constraintError('device-group-member-missing')})]){
  const conflict=deviceGroupConflict(error);
  assert.deepEqual([conflict.status,conflict.message,conflict.code],[409,memberMissingMessage,'DEVICE_GROUP_MEMBER_MISSING'],error.message);
 }
 const {rbacFailure}=load('lib/server/identity/rbac.ts'),mapped=rbacFailure(constraintError('device-group-member-missing'));
 assert.deepEqual([mapped.status,mapped.message],[409,memberMissingMessage]);
}));

test('visibleCustomers follows the customer boundary; listCustomerTechnicians lists users, groups and assignments',async()=>fixture(async({insert,customer,load})=>{
 const customers=load('lib/server/identity/customers.ts');
 const owner=await user(insert,'owner'),groupOwner=await user(insert,'groupowner'),tech=await user(insert,'tech'),member=await user(insert,'member'),idle=await user(insert,'nolabel','invited'),disabledOwner=await user(insert,'oldowner','disabled');
 await ownerRole(insert,'user',owner.id);await ownerRole(insert,'user',disabledOwner.id);
 const owners=await userGroup(insert,'Owners'),team=await userGroup(insert,'Team B'),off=await userGroup(insert,'Off',0);
 await insert('user_group_members',{group_id:owners,user_id:groupOwner.id});await insert('user_group_members',{group_id:team,user_id:member.id});await insert('user_group_members',{group_id:off,user_id:member.id});
 await ownerRole(insert,'group',owners);await ownerRole(insert,'group',off);
 // Only the default customer: it is visible for everybody.
 for(const viewer of [owner,tech,idle])assert.deepEqual(await customers.visibleCustomers(viewer),[{id:firstCustomer,name:'Standardkunde'}]);
 // A second customer switches the boundary on.
 const b=await customer('Beta'),a=await customer('alpha'),gone=await customer('Zeta',{status:'disabled'});
 assert.deepEqual((await customers.visibleCustomers(owner)).map(row=>row.name),['alpha','Beta','Standardkunde'],'an Owner sees every active customer');
 assert.deepEqual((await customers.visibleCustomers(groupOwner)).map(row=>row.name),['alpha','Beta','Standardkunde'],'an Owner through a user group too');
 assert.deepEqual(await customers.visibleCustomers(tech),[],'a technician without assignment sees nothing');
 await assign(insert,b,'user',tech.id);await assign(insert,gone,'user',tech.id);await assign(insert,a,'group',team);await assign(insert,firstCustomer,'group',off);
 assert.deepEqual(await customers.visibleCustomers(tech),[{id:b,name:'Beta'}],'assigned active customers; disabled ones are missing');
 assert.deepEqual((await customers.visibleCustomers(member)).map(row=>row.name),['alpha'],'through an enabled user group only');
 assert.deepEqual(await customers.visibleCustomers(disabledOwner),[],'a disabled account sees nothing');
 const listed=await customers.listCustomerTechnicians();
 assert.deepEqual(Object.keys(listed),['users','groups','assignments']);
 assert.deepEqual(listed.users.map(row=>[row.label,row.email,row.status,row.owner]),[['GROUPOWNER','groupowner@example.test','active',true],['MEMBER','member@example.test','active',false],['nolabel','nolabel@example.test','invited',false],['OLDOWNER','oldowner@example.test','disabled',false],['OWNER','owner@example.test','active',true],['TECH','tech@example.test','active',false]],'label falls back to the username; owner needs an active account and an enabled group');
 assert.deepEqual(Object.keys(listed.users[0]),['id','label','email','status','owner']);
 assert.equal(listed.users.find(row=>row.label==='TECH').id,tech.id);
 assert.deepEqual(listed.groups.map(row=>({...row})),[{id:off,name:'Off',enabled:false},{id:owners,name:'Owners',enabled:true},{id:team,name:'Team B',enabled:true}]);
 assert.deepEqual(new Set(listed.assignments.map(row=>JSON.stringify({...row}))),new Set([{customerId:b,subjectType:'user',subjectId:tech.id},{customerId:gone,subjectType:'user',subjectId:tech.id},{customerId:a,subjectType:'group',subjectId:team},{customerId:firstCustomer,subjectType:'group',subjectId:off}].map(row=>JSON.stringify(row))));
}));

// ---- Customer installers (migration 0033) ---------------------------------
const installerRow=(customerId,extra={})=>({id:randomUUID(),customer_id:customerId,group_id:null,name:'Rollout',key_hash:randomUUID().replaceAll('-','').repeat(2),mode:'ReadOnly',expires_at:Date.now()+86_400_000,max_devices:null,created_at:Date.now(),created_by:'local:owner',...extra});
const installerCount=d=>d.one(sql`SELECT count(*) AS n FROM customer_installers`).then(row=>row===null?null:row.n);

test('customer_installers has its columns, CHECKs, the unique key hash and the customer index, and the migration adds no rows',async()=>fixture(async({d,insert})=>{
 const columns=await tableColumns(d,'customer_installers');
 assert.deepEqual(columns.map(column=>[column.name,column.type.toUpperCase(),column.notnull,column.pk,column.dflt_value]),[
  ['id','TEXT',1,1,null],['customer_id','TEXT',1,0,null],['group_id','TEXT',0,0,null],['name','TEXT',1,0,null],['key_hash','TEXT',1,0,null],['mode','TEXT',1,0,null],
  ['expires_at','BIGINT',1,0,null],['max_devices','BIGINT',0,0,null],['enrollments','BIGINT',1,0,'0'],['created_at','BIGINT',1,0,null],['created_by','TEXT',1,0,null],
  ['last_used_at','BIGINT',0,0,null],['revoked_at','BIGINT',0,0,null],['revoked_by','TEXT',0,0,null]]);
 const indexes=await tableIndexes(d,'customer_installers');
 const unique=indexes.find(row=>row.name==='customer_installers_key_hash');
 assert.equal(unique?.unique,1,'key_hash is unique');
 assert.deepEqual(await indexColumns(d,'customer_installers_key_hash'),['key_hash']);
 assert.deepEqual(await indexColumns(d,'customer_installers_customer'),['customer_id'],'the customer index');
 assert.equal(await installerCount(d),0,'the migration creates no installers');
 for(const [extra,label] of [[{name:'  '},'blank name'],[{name:'\t\n'},'whitespace name'],[{mode:'Admin'},'mode'],[{max_devices:0},'max 0'],[{max_devices:10001},'max 10001'],[{max_devices:2.5},'max fraction'],[{enrollments:-1},'negative enrollments'],[{max_devices:2,enrollments:3},'enrollments over the limit']])
  // A fraction never reaches the CHECK: the bigint column refuses it (22P02).
  await assert.rejects(insert('customer_installers',installerRow(firstCustomer,extra)),error=>error.code===(label==='max fraction'?'22P02':'23514'),label);
 const row=installerRow(firstCustomer,{max_devices:1});await insert('customer_installers',row);
 await assert.rejects(insert('customer_installers',installerRow(firstCustomer,{key_hash:row.key_hash})),error=>error.code==='23505','one installer per key hash');
 await d.exec(sql`UPDATE customer_installers SET enrollments=1 WHERE id=${row.id}`);
 await assert.rejects(d.exec(sql`UPDATE customer_installers SET enrollments=2 WHERE id=${row.id}`),error=>error.code==='23514','enrollments cannot pass max_devices');
 for(const value of [1,10000])await insert('customer_installers',installerRow(firstCustomer,{max_devices:value,mode:'Management'}));
 assert.equal(await installerCount(d),3);
}));

test('installers need an active customer and a group of that customer; customer, group, key, mode, lifetime and limit never change; a revocation is final',async()=>fixture(async({d,insert,customer,group})=>{
 const other=await customer('Kunde Installer B'),disabled=await customer('Kunde Installer C',{status:'disabled'});
 const groupA=await group('Gruppe A'),groupB=await group('Gruppe B',null,other);
 await assert.rejects(insert('customer_installers',installerRow(randomUUID())),/customer-missing/,'unknown customer');
 await assert.rejects(insert('customer_installers',installerRow(disabled)),/customer-disabled/,'disabled customer');
 await assert.rejects(insert('customer_installers',installerRow(firstCustomer,{group_id:groupB})),/customer-installer-group-mismatch/,'a group of another customer');
 await assert.rejects(insert('customer_installers',installerRow(firstCustomer,{group_id:randomUUID()})),/customer-installer-group-mismatch/,'a missing group');
 const row=installerRow(firstCustomer,{group_id:groupA,max_devices:5});await insert('customer_installers',row);
 await insert('customer_installers',installerRow(other,{group_id:groupB}));
 for(const [column,value] of [['id',randomUUID()],['customer_id',other],['group_id',groupB],['group_id',null],['key_hash','f'.repeat(64)],['mode','Management'],['expires_at',row.expires_at+1],['max_devices',6],['max_devices',null],['created_at',row.created_at+1],['created_by','local:other']])
  await assert.rejects(d.exec(sql`UPDATE customer_installers SET ${sql.ident(column)}=${value} WHERE id=${row.id}`),/customer-installer-immutable/,column);
 await d.exec(sql`UPDATE customer_installers SET enrollments=enrollments+1,last_used_at=${Date.now()} WHERE id=${row.id}`);
 await d.exec(sql`UPDATE customer_installers SET revoked_at=${Date.now()},revoked_by='local:owner' WHERE id=${row.id}`);
 await assert.rejects(d.exec(sql`UPDATE customer_installers SET revoked_at=NULL WHERE id=${row.id}`),/customer-installer-revoked/,'reset');
 await assert.rejects(d.exec(sql`UPDATE customer_installers SET revoked_at=revoked_at+1 WHERE id=${row.id}`),/customer-installer-revoked/,'another value');
 const stored=await d.one(sql`SELECT customer_id,group_id,enrollments FROM customer_installers WHERE id=${row.id}`);
 assert.deepEqual({...stored},{customer_id:firstCustomer,group_id:groupA,enrollments:1});
 // Deleting a customer that owns nothing but an installer removes it; a customer in use stays.
 const empty=await customer('Kunde ohne Geräte');
 await insert('customer_installers',installerRow(empty));
 await d.exec(sql`DELETE FROM customers WHERE id=${empty}`);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM customer_installers WHERE customer_id=${empty}`).then(row=>row===null?null:row.n),0,'the installers go with the customer');
 const renamed=await customer('Kunde neue ID');
 await insert('customer_installers',installerRow(renamed));
 await d.exec(sql`UPDATE customers SET id=${randomUUID()} WHERE id=${renamed}`);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM customer_installers WHERE customer_id=${renamed}`).then(row=>row===null?null:row.n),0,'an id change removes them too');
 await assert.rejects(d.exec(sql`DELETE FROM customers WHERE id=${other}`),/customer-in-use/,'a customer with groups stays');
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM customer_installers WHERE customer_id=${other}`).then(row=>row===null?null:row.n),1);
}));

// Catalog owners (0034). NULL is the MSP library, otherwise one customer.
const catalogRows={
 runbooks:(customerId,extra={})=>({id:randomUUID(),name:'Runbook',description:'',created_at:Date.now(),created_by:'local:owner',customer_id:customerId,...extra}),
 automation_templates:(customerId,extra={})=>({id:randomUUID(),kind:'desired',slot:'default',name:'Vorlage',payload:'{}',created_by:'local:owner',created_at:Date.now(),customer_id:customerId,...extra}),
 rbac_roles:(customerId,extra={})=>({id:randomUUID(),name:'Rolle '+randomUUID(),description:'',permissions:'["view"]',builtin:0,created_at:Date.now(),customer_id:customerId,...extra}),
};
test('runbooks, templates and roles have a nullable customer_id with an index; built-in roles are library',async()=>fixture(async({d,load})=>{
 await load('lib/server/identity/rbac.ts').ensureBuiltinRoles();
 for(const [table,index] of [['runbooks','idx_runbooks_customer'],['automation_templates','idx_automation_templates_customer'],['rbac_roles','idx_rbac_roles_customer']]){
  const column=(await tableColumns(d,table)).find(row=>row.name==='customer_id');
  assert.deepEqual([column?.type.toUpperCase(),column?.notnull,column?.dflt_value],['TEXT',0,null],table+'.customer_id');
  assert.deepEqual(await indexColumns(d,index),['customer_id'],index);
 }
 assert.ok(await d.one(sql`SELECT count(*) AS n FROM rbac_roles WHERE builtin=1`).then(row=>row.n>0),'the built-in roles are seeded');
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM rbac_roles WHERE builtin=1 AND customer_id IS NOT NULL`).then(row=>row.n),0,'the built-in roles stay library');
}));
test('catalog entries need an active customer, never change owner, and customer roles hold device rights only',async()=>fixture(async({d,insert,customer})=>{
 const other=await customer('Katalog B'),disabled=await customer('Katalog C',{status:'disabled'});
 for(const [table,row] of Object.entries(catalogRows)){
  await assert.rejects(insert(table,row(randomUUID())),/customer-missing/,table+': unknown customer');
  await assert.rejects(insert(table,row(disabled)),/customer-disabled/,table+': disabled customer');
  const library=row(null),own=row(firstCustomer);await insert(table,library);await insert(table,own);
  for(const [id,value,label] of [[library.id,firstCustomer,'NULL→A'],[own.id,other,'A→B'],[own.id,null,'A→NULL']])
   await assert.rejects(d.exec(sql`UPDATE ${sql.ident(table)} SET customer_id=${value} WHERE id=${id}`),/customer-catalog-immutable/,table+': '+label);
  await d.exec(sql`UPDATE ${sql.ident(table)} SET name=${'Neu '+randomUUID()} WHERE id=${own.id}`);
  await d.exec(sql`UPDATE ${sql.ident(table)} SET customer_id=customer_id WHERE id=${own.id}`);
 }
 await assert.rejects(insert('rbac_roles',catalogRows.rbac_roles(firstCustomer,{permissions:'["*"]'})),/customer-role-permissions/,'a customer role with *');
 await assert.rejects(insert('rbac_roles',catalogRows.rbac_roles(firstCustomer,{permissions:'["view","portal.operator"]'})),/customer-role-permissions/,'a customer role with portal.operator');
 const role=catalogRows.rbac_roles(firstCustomer,{permissions:'["view","terminal"]'});await insert('rbac_roles',role);
 for(const rights of ['["*"]','["portal.roles.manage"]'])await assert.rejects(d.exec(sql`UPDATE rbac_roles SET permissions=${rights} WHERE id=${role.id}`),/customer-role-permissions/,'update to '+rights);
 await d.exec(sql`UPDATE rbac_roles SET permissions=${'["view"]'} WHERE id=${role.id}`);
 await insert('rbac_roles',catalogRows.rbac_roles(null,{permissions:'["*","portal.operator"]'}));
 // The compatibility grant upserts its role: an existing role of a disabled customer is updated, a new one refused.
 const kept=catalogRows.rbac_roles(other);await insert('rbac_roles',kept);await d.exec(sql`UPDATE customers SET status='disabled' WHERE id=${other}`);
 const upsert=row=>d.exec(sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at,customer_id) VALUES(${row.id},${row.name},${row.description},${row.permissions},${row.builtin},${row.created_at},${row.customer_id}) ON CONFLICT(id) DO UPDATE SET permissions=excluded.permissions`);
 await upsert({...kept,permissions:'["view","diagnose"]'});
 assert.equal(await d.one(sql`SELECT permissions FROM rbac_roles WHERE id=${kept.id}`).then(row=>row===null?null:row.permissions),'["view","diagnose"]','an existing role of a disabled customer is updated');
 await assert.rejects(upsert(catalogRows.rbac_roles(other)),/customer-disabled/,'a new role of a disabled customer, also through an upsert');
}));
test('customer roles and templates stay on targets of their customer; customers with catalog entries stay',async()=>fixture(async({d,insert,customer,group,device})=>{
 const other=await customer('Katalog B');
 const gA=await group('Gruppe A'),gB=await group('Gruppe B',null,other),dA=await device('Server A'),dB=await device('Server B',other);
 const role=catalogRows.rbac_roles(firstCustomer);await insert('rbac_roles',role);
 const libraryRole=catalogRows.rbac_roles(null);await insert('rbac_roles',libraryRole);
 const user=randomUUID(),assignment=(roleId,scopeType,scopeId)=>({id:randomUUID(),principal_type:'user',principal_id:user,role_id:roleId,scope_type:scopeType,scope_id:scopeId,created_at:Date.now(),created_by:'local:owner'});
 for(const [scopeType,scopeId,label] of [['global','*','global'],['devicegroup',gB,'group of B'],['device',dB,'device of B'],['devicegroup',randomUUID(),'missing group'],['device',randomUUID(),'missing device']])
  await assert.rejects(insert('role_assignments',assignment(role.id,scopeType,scopeId)),/customer-role-scope/,'customer role: '+label);
 const onGroup=assignment(role.id,'devicegroup',gA),onDevice=assignment(role.id,'device',dA);await insert('role_assignments',onGroup);await insert('role_assignments',onDevice);
 await assert.rejects(d.exec(sql`UPDATE role_assignments SET scope_id=${gB} WHERE id=${onGroup.id}`),/customer-role-scope/,'moving the assignment to B');
 await assert.rejects(d.exec(sql`UPDATE role_assignments SET scope_type='global',scope_id='*' WHERE id=${onDevice.id}`),/customer-role-scope/,'making it global');
 const libraryOnB=assignment(libraryRole.id,'devicegroup',gB);await insert('role_assignments',libraryOnB);
 await assert.rejects(d.exec(sql`UPDATE role_assignments SET role_id=${role.id} WHERE id=${libraryOnB.id}`),/customer-role-scope/,'switching to the customer role on B');
 await insert('role_assignments',assignment(libraryRole.id,'global','*'));
 // Runbook templates: library with library runbooks only, a customer with its own or library runbooks.
 const bookA=catalogRows.runbooks(firstCustomer),bookB=catalogRows.runbooks(other),bookLibrary=catalogRows.runbooks(null);for(const book of [bookA,bookB,bookLibrary])await insert('runbooks',book);
 const runbookTemplate=(customerId,slot)=>catalogRows.automation_templates(customerId,{kind:'runbook',slot});
 await assert.rejects(insert('automation_templates',runbookTemplate(null,bookA.id)),/customer-catalog-mismatch/,'library template with a runbook of A');
 await assert.rejects(insert('automation_templates',runbookTemplate(other,bookA.id)),/customer-catalog-mismatch/,'template of B with a runbook of A');
 const templateA=runbookTemplate(firstCustomer,bookA.id),templateAOnLibrary=runbookTemplate(firstCustomer,bookLibrary.id),templateLibrary=runbookTemplate(null,bookLibrary.id);
 for(const row of [templateA,templateAOnLibrary,templateLibrary])await insert('automation_templates',row);
 await assert.rejects(d.exec(sql`UPDATE automation_templates SET slot=${bookB.id} WHERE id=${templateA.id}`),/customer-catalog-mismatch/,'pointing the template of A at a runbook of B');
 await assert.rejects(d.exec(sql`UPDATE automation_templates SET slot=${bookA.id} WHERE id=${templateLibrary.id}`),/customer-catalog-mismatch/,'pointing the library template at a runbook of A');
 // Assignments of a customer template: only on groups and devices of its customer, also through an upsert.
 const scope=(templateId,scopeType,scopeId,slot=bookA.id)=>({id:randomUUID(),kind:'runbook',slot,scope_type:scopeType,scope_id:scopeId,template_id:templateId,disabled:0,actor:'local:owner',auth_version:1,created_at:Date.now()});
 for(const [scopeType,scopeId,label] of [['group',gB,'group of B'],['device',dB,'device of B'],['group',randomUUID(),'missing group'],['device',randomUUID(),'missing device']])
  await assert.rejects(insert('automation_scope_assignments',scope(templateA.id,scopeType,scopeId)),/customer-catalog-mismatch/,'template of A: '+label);
 const upsert=row=>d.exec(sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,disabled,actor,auth_version,created_at) VALUES(${sql.join(Object.values(row).map(value=>sql`${value}`))}) ON CONFLICT(kind,slot,scope_type,scope_id) DO UPDATE SET id=excluded.id,template_id=excluded.template_id`);
 const libraryOnGroupB=scope(templateLibrary.id,'group',gB,bookLibrary.id);await insert('automation_scope_assignments',libraryOnGroupB);
 // The insert half of the upsert names the library template; only the update half switches to the template of A.
 await assert.rejects(d.exec(sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,disabled,actor,auth_version,created_at) VALUES(${randomUUID()},${'runbook'},${bookLibrary.id},${'group'},${gB},${templateLibrary.id},0,${'local:owner'},1,${Date.now()}) ON CONFLICT(kind,slot,scope_type,scope_id) DO UPDATE SET template_id=${templateAOnLibrary.id}`),/customer-catalog-mismatch/,'the ON CONFLICT update onto B');
 await assert.rejects(upsert(scope(templateAOnLibrary.id,'group',gB,bookLibrary.id)),/customer-catalog-mismatch/,'an upsert of the template of A onto B');
 assert.equal(await d.one(sql`SELECT template_id FROM automation_scope_assignments WHERE id=${libraryOnGroupB.id}`).then(row=>row===null?null:row.template_id),templateLibrary.id,'the library assignment on B stays');
 const onGroupA=scope(templateA.id,'group',gA),onDeviceA=scope(templateA.id,'device',dA);await insert('automation_scope_assignments',onGroupA);await insert('automation_scope_assignments',onDeviceA);
 await assert.rejects(d.exec(sql`UPDATE automation_scope_assignments SET scope_id=${gB} WHERE id=${onGroupA.id}`),/customer-catalog-mismatch/,'moving the template assignment to B');
 // Moving a target to another customer while such an assignment hangs on it.
 await assert.rejects(d.exec(sql`UPDATE servers SET customer_id=${other} WHERE id=${dA}`),/customer-mismatch/,'moving dA with role and template of A');
 await assert.rejects(d.exec(sql`UPDATE device_groups SET customer_id=${other} WHERE id=${gA}`),/customer-mismatch/,'moving gA with role and template of A');
 await d.exec(sql`DELETE FROM role_assignments WHERE id=${onGroup.id}`);
 await assert.rejects(d.exec(sql`UPDATE device_groups SET customer_id=${other} WHERE id=${gA}`),/customer-mismatch/,'moving gA with the template of A alone');
 await d.exec(sql`DELETE FROM automation_scope_assignments WHERE id=${onDeviceA.id}`);
 await assert.rejects(d.exec(sql`UPDATE servers SET customer_id=${other} WHERE id=${dA}`),/customer-mismatch/,'moving dA with the role of A alone');
 await d.exec(sql`DELETE FROM role_assignments WHERE id=${onDevice.id}`);
 await insert('automation_scope_assignments',onDeviceA);
 await assert.rejects(d.exec(sql`UPDATE servers SET customer_id=${other} WHERE id=${dA}`),/customer-mismatch/,'moving dA with the template of A alone');
 await d.exec(sql`DELETE FROM automation_scope_assignments WHERE id=${onDeviceA.id}`);
 await d.exec(sql`UPDATE servers SET customer_id=${other} WHERE id=${dA}`);
 assert.equal(await d.one(sql`SELECT customer_id FROM servers WHERE id=${dA}`).then(row=>row===null?null:row.customer_id),other,'control: without such assignments the device moves');
 // Customers that own a runbook, a template or a role are neither deleted nor renamed.
 for(const table of Object.keys(catalogRows)){
  const owner=await customer('Besitzer '+table);await insert(table,catalogRows[table](owner));
  await assert.rejects(d.exec(sql`DELETE FROM customers WHERE id=${owner}`),/customer-in-use/,table+': delete');
  await assert.rejects(d.exec(sql`UPDATE customers SET id=${randomUUID()} WHERE id=${owner}`),/customer-in-use/,table+': new id');
 }
 const empty=await customer('Ohne Katalog');await d.exec(sql`DELETE FROM customers WHERE id=${empty}`);
}));

// Audit per customer. Device rows inherit their device's customer, customer
// entries name it explicitly; the customer of a row never changes.
test('audit.customer_id is a nullable text with an index on (customer_id, at); the scope CHECK allows portal and device',async()=>fixture(async({d})=>{
 const column=(await tableColumns(d,'audit')).find(entry=>entry.name==='customer_id');
 assert.deepEqual([column?.type.toUpperCase(),column?.notnull,column?.dflt_value],['TEXT',0,null],'audit.customer_id is a nullable TEXT');
 assert.deepEqual(await indexColumns(d,'idx_audit_customer_at'),['customer_id','at'],'idx_audit_customer_at on (customer_id, at)');
 assert.match(String(await d.one(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='audit'::regclass AND conname='audit_scope'`).then(row=>row===null?null:row.definition)),/scope.*'portal'.*'device'/i,'the scope CHECK names portal and device');
}));
test('audit rows: device rows inherit the customer, explicit customers must exist and match, a set customer never changes, a customer with audit rows keeps its id and can be deleted',async()=>fixture(async({d,customer,device})=>{
 const other=await customer('Audit B'),disabled=await customer('Audit C'),devA=await device('Audit A1'),devB=await device('Audit B1',other);
 await d.exec(sql`UPDATE customers SET status='disabled' WHERE id=${disabled}`);
 const insert=(serverId,customerId,scope=serverId?'device':'portal')=>d.one(sql`INSERT INTO audit(at,actor,action,target,server_id,scope,customer_id) VALUES(${Date.now()},${'tester'},${'test.action'},${'target'},${serverId},${scope},${customerId}) RETURNING id`).then(row=>row===null?null:row.id);
 const customerOfRow=id=>d.one(sql`SELECT customer_id FROM audit WHERE id=${id}`).then(row=>row===null?null:row.customer_id);
 // 1. Filled from the device, also when the device is missing (then NULL, no failure).
 const viaLog=await insert(devB,null);assert.equal(await customerOfRow(viaLog),other,'a new device row gets the device\'s customer');
 const missing=await insert(randomUUID(),null);assert.equal(await customerOfRow(missing),null,'a missing device leaves NULL');
 const portal=await insert(null,null);assert.equal(await customerOfRow(portal),null,'a portal row without customer stays NULL');
 // 2. Explicit customers.
 await assert.rejects(insert(null,randomUUID()),/customer-missing/,'unknown customer');
 await assert.rejects(insert(devA,other),/customer-mismatch/,'device of another customer');
 const entry=await insert(null,other);assert.equal(await customerOfRow(entry),other,'a customer entry keeps its customer');
 const matching=await insert(devA,firstCustomer);assert.equal(await customerOfRow(matching),firstCustomer,'an explicit, matching customer');
 const ofDisabled=await insert(null,disabled);assert.equal(await customerOfRow(ofDisabled),disabled,'a disabled customer is allowed');
 // 3. Immutable once set: A→B and A→NULL fail; NULL→value passes the same checks.
 for(const [value,label] of [[firstCustomer,'B→A'],[null,'B→NULL']])await assert.rejects(d.exec(sql`UPDATE audit SET customer_id=${value} WHERE id=${entry}`),/audit-customer-immutable/,label);
 await d.exec(sql`UPDATE audit SET customer_id=customer_id,target=${'changed'} WHERE id=${entry}`);
 await assert.rejects(d.exec(sql`UPDATE audit SET customer_id=${randomUUID()} WHERE id=${portal}`),/customer-missing/,'NULL→unknown');
 await d.exec(sql`UPDATE audit SET customer_id=${other} WHERE id=${portal}`);assert.equal(await customerOfRow(portal),other,'NULL→value is allowed');
 // 4. A customer with audit rows keeps its id, but it can be deleted (docs/customers.md, "Delete a customer"): its
 // rows keep the customer id and removed_customers keeps the name.
 const onlyAudit=await customer('Nur Audit'),kept=await insert(null,onlyAudit);
 await assert.rejects(d.exec(sql`UPDATE customers SET id=${randomUUID()} WHERE id=${onlyAudit}`),/customer-in-use/,'new id');
 await d.exec(sql`DELETE FROM customers WHERE id=${onlyAudit}`);
 assert.equal(await customerOfRow(kept),onlyAudit,'the audit row keeps the id of the deleted customer');
 assert.equal(await d.one(sql`SELECT name FROM removed_customers WHERE id=${onlyAudit}`).then(row=>row===null?null:row.name),'Nur Audit','the tombstone keeps the name');
 const empty=await customer('Ohne Audit');await d.exec(sql`DELETE FROM customers WHERE id=${empty}`);
}));
