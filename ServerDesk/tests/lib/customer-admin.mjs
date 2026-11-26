// Customer administration (lib/server/identity/customer-admin.ts): create,
// update, setStatus and setTechnicians on a database without any license table.
// Each write needs a global Owner (403 for others) and, for an existing
// customer, the read revision (409 when stale). create, set-status and an edit
// that keeps or extends the audit retention commit behind the live session
// fence; an edit that shortens it and the technicians need a live MFA proof
// that is consumed once (lib/step-up.ts). The default customer cannot be disabled. The audit row is written in
// the same batch, and removed technicians lose their sessions and pending jobs.
// The fixture turns "Multiple customers" on; while it is off, create is refused
// before the commit and, in a race, through the insert trigger.
// Every time comes from the stubbed clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,statSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import {sql} from '../../runtime/database.mjs';
import {sourceDatabase} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {HttpError} from '../support/http-error.mjs';
import {serverDeskRoot} from '../support/paths.mjs';
import {enableMultipleCustomers} from '../support/customer-separation.mjs';

const root=serverDeskRoot,require=createRequire(import.meta.url);
const day=86_400_000,t0=Date.UTC(2031,5,1,12);
const firstCustomer='00000000-0000-4000-8000-000000000100';
// Each refusal as [status, code, message key] (lib/errors/api-error-keys.ts).
const refused={
 ownerOnly:[403,'FORBIDDEN','apiError.customer.ownerOnly'],
 name:[400,'INVALID_REQUEST','apiError.customer.name'],
 duplicate:[409,'CUSTOMER_NAME_TAKEN','apiError.customer.nameTaken'],
 contactName:[400,'INVALID_REQUEST','apiError.customer.contactName'],
 contactEmail:[400,'INVALID_REQUEST','apiError.customer.contactEmail'],
 contactPhone:[400,'INVALID_REQUEST','apiError.customer.contactPhone'],
 control:[400,'INVALID_REQUEST','apiError.customer.controlCharacters'],
 retention:[400,'INVALID_REQUEST','apiError.customer.retention'],
 window:[400,'INVALID_REQUEST','apiError.customer.maintenanceWindow'],
 status:[400,'INVALID_REQUEST','apiError.customer.status'],
 defaultProtected:[409,'CUSTOMER_DEFAULT_PROTECTED','apiError.customer.defaultProtected'],
 missing:[404,'CUSTOMER_MISSING','apiError.customer.gone'],
 concurrent:[409,'CONFLICT','apiError.customer.concurrent'],
 proofUsed:[403,'MFA_STEP_UP_REQUIRED','apiError.mfa.confirmationUsed'],
 technicians:[400,'INVALID_REQUEST','apiError.customer.technicians'],
 off:[409,'MULTIPLE_CUSTOMERS_OFF','apiError.customer.multipleCustomersOff'],
};

function loader(stubs){
 const cache=new Map();
 const file=specifier=>{for(const candidate of [specifier,specifier+'.ts',specifier+'.tsx',specifier+'/index.ts'])try{if(statSync(candidate).isFile())return candidate;}catch{/* next candidate */}throw new Error('Cannot resolve '+specifier);};
 function load(filename){
  const absolute=file(resolve(root,filename)),relative=absolute.slice(root.length).replaceAll('\\','/');
  if(Object.hasOwn(stubs,relative))return stubs[relative];
  if(cache.has(absolute))return cache.get(absolute).exports;
  const loaded={exports:{}};cache.set(absolute,loaded);
  const code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  const localRequire=id=>id.startsWith('@/')?load(id.slice(2)):id.startsWith('.')?(/[.]m?js$/.test(id)?require(resolve(dirname(absolute),id)):load(resolve(dirname(absolute),id))):require(id);
  new Function('require','module','exports',code)(localRequire,loaded,loaded.exports);return loaded.exports;
 }
 return load;
}

async function fixture(run){
 const d=await sourceDatabase(),clock={now:t0},flags={ownerPrecheck:null};
 const server={db:()=>d,HttpError,now:()=>clock.now,guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value),log:async()=>{throw new Error('customer changes audit in their own batch');}};
 // Owner rights are a SQL guard over a fixture table, so tests can revoke them between check and commit.
 // The other access functions (session and job revocation) are the real ones.
 const realAccess=loader({'lib/server/context.ts':server})('lib/server/identity/access.ts');
 const access={...realAccess,
  principal:viewer=>viewer.principal,
  globalOwnerGuard:expression=>sql`EXISTS (SELECT 1 FROM test_owners WHERE principal=${expression})`,
  hasGlobalPermission:async(viewer,permission)=>{if(flags.ownerPrecheck!==null){const answer=flags.ownerPrecheck;flags.ownerPrecheck=null;return answer;}return permission==='*'&&!!await d.one(sql`SELECT 1 AS ok FROM test_owners WHERE principal=${viewer.principal}`);},
 };
 // The Owner policy (lib/server/identity/policy/can.ts) over the same table. A request caches its
 // pre-check: flags.ownerPrecheck is that cached answer until a fresh re-check
 // reads the table again, to simulate a right revoked after the pre-check.
 const owns=async(viewer,right,options={})=>{if(flags.ownerPrecheck!==null){if(!options.fresh)return flags.ownerPrecheck;flags.ownerPrecheck=null;}return right==='instance.owner'&&!!await d.one(sql`SELECT 1 AS ok FROM test_owners WHERE principal=${viewer.principal}`);};
 const policy={...loader({'lib/server/context.ts':server,'lib/server/identity/access.ts':access})('lib/server/identity/policy/can.ts'),can:owns,requireCan:async(viewer,right,key='apiError.policy.permissionMissing')=>{if(!await owns(viewer,right))throw new HttpError(key);}};
 // The MFA session is a fixture table: the session fence holds while it has a row, and
 // requireLiveSessions answers the session's own 401 when it is empty. A proof is read
 // like lib/server/identity/mfa.ts reads it: a missing token asks for one, an unknown or used one is expired.
 const mfa={
  mfaSessionFence:async()=>sql`EXISTS (SELECT 1 FROM test_sessions)`,
  requireLiveSessions:async()=>{if(!await d.one(sql`SELECT 1 AS live FROM test_sessions`))throw new HttpError('apiError.mfa.sessionExpired');},
  readMfaManagementProof:async(_request,viewer,value)=>{
   if(typeof value!=='string'||!value)throw new HttpError('apiError.mfa.confirmChange');
   const guard=sql`EXISTS (SELECT 1 FROM mfa_management_proofs WHERE token_hash=${value} AND principal=${viewer.principal})`;
   if(!await d.one(sql`SELECT 1 AS live WHERE ${guard}`))throw new HttpError('apiError.mfa.proofExpired');
   return {tokenHash:value,key:viewer.principal,sessionHash:'session',guard};
  },
 };
 // The instance audit retention: the stored maintenance value, else the default of 30 days.
 const maintenance={instanceAuditRetention:async()=>{const row=await d.one(sql`SELECT audit_days FROM maintenance_settings WHERE id=1`);const stored=row?.audit_days===null||row?.audit_days===undefined?null:Number(row.audit_days);return {days:stored??30,stored};}};
 const load=loader({'lib/server/context.ts':server,'lib/server/identity/access.ts':access,'lib/server/identity/policy/can.ts':policy,'lib/server/identity/mfa.ts':mfa,'lib/server/identity/local-auth.ts':{primaryGuard:async()=>sql`TRUE`},'lib/server/maintenance.ts':maintenance});
 try{
  await d.exec(sql`CREATE TABLE test_owners(principal TEXT PRIMARY KEY)`);
  await d.exec(enableMultipleCustomers());
  await d.exec(sql`CREATE TABLE test_sessions(live INTEGER)`);await d.exec(sql`INSERT INTO test_sessions(live) VALUES(1)`);
  const endSession=()=>d.exec(sql`DELETE FROM test_sessions`),restoreSession=()=>d.exec(sql`INSERT INTO test_sessions(live) VALUES(1)`);
  const request=new Request('https://customers.test/api/customers',{method:'POST'});
  const owner={id:'owner',label:'owner@example.test',principal:'local:owner',permissions:['*']};
  const reader={id:'reader',label:'reader@example.test',principal:'local:reader',permissions:[]};
  await d.exec(sql`INSERT INTO test_owners(principal) VALUES(${owner.principal})`);
  let proofs=0;
  const proof=async(viewer=owner)=>{const token='proof-'+(++proofs);await d.exec(sql`INSERT INTO mfa_management_proofs(token_hash,principal,session_hash,expires_at) VALUES(${token},${viewer.principal},${'session'},${t0+1000*day})`);return {guard:sql`EXISTS (SELECT 1 FROM mfa_management_proofs WHERE token_hash=${token})`,tokenHash:token,key:viewer.principal,sessionHash:'session'};};
  // A managementToken for the writes that read the proof themselves; its MFA session is live.
  await d.exec(sql`INSERT INTO mfa_sessions(token_hash,principal,created_at,last_activity,idle_expires_at,expires_at) VALUES(${'session'},${owner.principal},${t0},${t0},${t0+1000*day},${t0+1000*day})`);
  const token=async(viewer=owner)=>{const value='token-'+(++proofs);await d.exec(sql`INSERT INTO mfa_management_proofs(token_hash,principal,session_hash,expires_at) VALUES(${value},${viewer.principal},${'session'},${t0+1000*day})`);return value;};
  const tokenExists=async value=>Number(await d.one(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${value}`).then(row=>row?.n??0))===1;
  const setInstanceDays=days=>d.exec(sql`UPDATE maintenance_settings SET audit_days=${days}::integer WHERE id=1`);
  const proofExists=async authorization=>await d.one(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${authorization.tokenHash}`).then(row=>row===null?null:row.n)===1;
  const audit=async()=>(await d.query(sql`SELECT actor,action,target FROM audit WHERE scope='portal' AND action LIKE 'Kunde %' ORDER BY id`));
  const rows=async()=>(await d.query(sql`SELECT * FROM customers ORDER BY created_at,id`));
  const customers=load('lib/server/identity/customers.ts');
  const admin=load('lib/server/identity/customer-admin.ts');
  // The commit is the first batch of every call. Runs action right before it.
  const batches=[],hooked=hookDatabase(d,{record:batches});
  const beforeCommit=async(action,call)=>{let batches=0;hooked.hooks.transaction=async()=>{if(++batches===1)await action();};try{return await call();}finally{hooked.hooks.transaction=null;}};
  return await run({d,clock,flags,load,admin,owner,reader,proof,proofExists,token,tokenExists,setInstanceDays,request,endSession,restoreSession,batches,audit,rows,customers,beforeCommit,HttpError});
 }finally{d.close();}
}
// A refusal is a keyed HttpError: status, code and message key, as the answer body carries them.
const rejects=(promise,[status,code,key],label)=>assert.rejects(promise,error=>{assert.ok(error instanceof HttpError,`${label??''} ${error}`);assert.deepEqual([error.status,error.code,error.messageKey],[status,code,key],label);return true;},label);
const input=(extra={})=>({name:'Muster GmbH',contactName:'',contactEmail:'',contactPhone:'',auditRetentionDays:null,maintenanceWindow:null,...extra});
const window=(extra={})=>({days:[1,2,3,4,5],start:'22:00',durationMinutes:240,timeZone:'Europe/Berlin',...extra});

test('the writes need no license table; reads keep every field',async()=>fixture(async({d,admin,owner,request,customers})=>{
 const id=await admin.createCustomer(request,owner,input({name:'Kunde Test',maintenanceWindow:window(),auditRetentionDays:90}));
 assert.equal((await customers.customerById(id)).name,'Kunde Test','create works');
 await admin.updateCustomer(request,owner,id,{...input({name:'Kunde Test',maintenanceWindow:window(),auditRetentionDays:90}),revision:0});
 await admin.setCustomerStatus(request,owner,id,'disabled',1);
 await admin.setCustomerStatus(request,owner,id,'active',2);
 const list=await customers.listCustomers();
 assert.deepEqual(list.map(entry=>entry.name),['Kunde Test','Standardkunde']);
 assert.deepEqual({...list[0],createdAt:0,updatedAt:0},{id,name:'Kunde Test',status:'active',contactName:'',contactEmail:'',contactPhone:'',createdAt:0,updatedAt:0,auditRetentionDays:90,maintenanceWindow:window(),revision:3,deviceCount:0,groupCount:0,runbookCount:0,templateCount:0,roleCount:0});
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM customers`).then(row=>row===null?null:row.n),2);
}));

test('create stores the normalized customer and one audit row behind the session fence, without a proof',async()=>fixture(async({admin,owner,request,proof,proofExists,audit,rows,customers,batches})=>{
 const unused=await proof();
 const id=await admin.createCustomer(request,owner,input({name:'  Kunde a  ',contactName:' Erika Muster ',contactEmail:' it@kunde-a.example ',contactPhone:' +49 (30) 123-45 ',auditRetentionDays:14,maintenanceWindow:window({days:[7,1,3],start:'23:45',durationMinutes:720,timeZone:' europe/berlin '})}));
 assert.match(id,/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,'a random UUID');
 const created=await customers.customerById(id);
 assert.deepEqual(created,{id,name:'Kunde a',status:'active',contactName:'Erika Muster',contactEmail:'it@kunde-a.example',contactPhone:'+49 (30) 123-45',createdAt:t0,updatedAt:t0,auditRetentionDays:14,maintenanceWindow:{days:[1,3,7],start:'23:45',durationMinutes:720,timeZone:'Europe/Berlin'},revision:0,deviceCount:0,groupCount:0,runbookCount:0,templateCount:0,roleCount:0});
 const row=(await rows()).find(entry=>entry.id===id);
 assert.deepEqual([row.maintenance_days,row.maintenance_start,row.maintenance_duration,row.maintenance_time_zone],[1|4|64,23*60+45,720,'Europe/Berlin'],'stored as bit mask and minutes');
 assert.deepEqual(await audit(),[{actor:owner.label,action:'Kunde angelegt',target:'Kunde a'}]);
 assert.equal(await proofExists(unused),true,'no proof is read or consumed');
 assert.ok(batches.at(-1).some(statement=>/^INSERT INTO customers\b/.test(statement)&&statement.includes('test_sessions')),'the insert carries the session fence');
 assert.equal(batches.at(-1).some(statement=>/mfa_management_proofs/.test(statement)),false,'the batch touches no proof');
 await rejects(admin.createCustomer(request,owner,input({name:'KUNDE A'})),refused.duplicate);
 await rejects(admin.createCustomer(request,owner,input({name:'standardkunde'})),refused.duplicate);
 await admin.createCustomer(request,owner,input({name:'Ärzte Nord'}));
 await rejects(admin.createCustomer(request,owner,input({name:'ärzte nord'})),refused.duplicate,'case folding beyond ASCII');
 assert.equal((await rows()).length,3);assert.equal((await audit()).length,2);
 const minimal=await admin.createCustomer(request,owner,{name:'Nur Name'});
 assert.deepEqual((({contactName,contactEmail,contactPhone,auditRetentionDays,maintenanceWindow})=>({contactName,contactEmail,contactPhone,auditRetentionDays,maintenanceWindow}))(await customers.customerById(minimal)),{contactName:'',contactEmail:'',contactPhone:'',auditRetentionDays:null,maintenanceWindow:null},'missing fields are empty');
}));

test('every input rule has a valid and an invalid case; invalid input changes nothing',async()=>fixture(async({admin,owner,request,audit,rows})=>{
 const invalid=[
  [{name:''},refused.name],[{name:'   '},refused.name],[{name:'x'.repeat(81)},refused.name],[{name:42},refused.name],[{name:undefined},refused.name],
  [{name:'Kunde\u0001X'},refused.control],[{name:'Kunde\nZwei'},refused.control],[{name:'Kunde\u007f'},refused.control],
  [{contactName:'x'.repeat(121)},refused.contactName],[{contactName:'Erika\tMuster'},refused.control],[{contactName:['x']},refused.contactName],
  [{contactEmail:'kein-at.example'},refused.contactEmail],[{contactEmail:'a@b'},refused.contactEmail],[{contactEmail:'a b@c.de'},refused.contactEmail],[{contactEmail:'a@'+'b'.repeat(250)+'.de'},refused.contactEmail],
  [{contactPhone:'12'},refused.contactPhone],[{contactPhone:'+49 abc 123'},refused.contactPhone],[{contactPhone:'+-() 1 2'},refused.contactPhone],[{contactPhone:'1'.repeat(41)},refused.contactPhone],
  [{auditRetentionDays:0},refused.retention],[{auditRetentionDays:3651},refused.retention],[{auditRetentionDays:1.5},refused.retention],[{auditRetentionDays:'30'},refused.retention],[{auditRetentionDays:Number.NaN},refused.retention],
  [{maintenanceWindow:window({days:[]})},refused.window],[{maintenanceWindow:window({days:[8]})},refused.window],[{maintenanceWindow:window({days:[0]})},refused.window],[{maintenanceWindow:window({days:[1,1]})},refused.window],[{maintenanceWindow:window({days:[1.5]})},refused.window],[{maintenanceWindow:window({days:'1'})},refused.window],
  [{maintenanceWindow:window({start:'22:10'})},refused.window],[{maintenanceWindow:window({start:'24:00'})},refused.window],[{maintenanceWindow:window({start:'7:00'})},refused.window],
  [{maintenanceWindow:window({durationMinutes:20})},refused.window],[{maintenanceWindow:window({durationMinutes:735})},refused.window],[{maintenanceWindow:window({durationMinutes:0})},refused.window],[{maintenanceWindow:window({durationMinutes:'240'})},refused.window],
  [{maintenanceWindow:window({timeZone:'Mars/Base'})},refused.window],[{maintenanceWindow:window({timeZone:''})},refused.window],[{maintenanceWindow:window({timeZone:'x'.repeat(65)})},refused.window],
  [{maintenanceWindow:{...window(),extra:true}},refused.window],[{maintenanceWindow:{days:[1],start:'22:00',durationMinutes:60}},refused.window],[{maintenanceWindow:[window()]},refused.window],[{maintenanceWindow:'täglich'},refused.window],
 ];
 const before=await rows();
 for(const [extra,expected] of invalid)await rejects(admin.createCustomer(request,owner,input(extra)),expected,JSON.stringify(extra).slice(0,80));
 assert.deepEqual(await rows(),before);assert.deepEqual(await audit(),[]);
 // An invalid update changes nothing either; it is refused before any proof would be read.
 await rejects(admin.updateCustomer(request,owner,firstCustomer,{...input({name:'Neu',maintenanceWindow:window({start:'22:10'}),auditRetentionDays:1}),revision:0}),refused.window);
 assert.deepEqual(await rows(),before);
 const valid=[
  {name:'x'.repeat(80)},{name:'Ein',contactName:'x'.repeat(120)},{name:'Mail',contactEmail:'it@kunde.example'},{name:'Mail lang',contactEmail:'a@'+'b'.repeat(249)+'.de'},
  {name:'Telefon',contactPhone:'+49 (30) 123-45.6/7'},{name:'Telefon kurz',contactPhone:'110'},{name:'Telefon lang',contactPhone:'1'.repeat(40)},
  {name:'Ein Tag',auditRetentionDays:1},{name:'Zehn Jahre',auditRetentionDays:3650},{name:'Standard',auditRetentionDays:null},
  {name:'Wochenende',maintenanceWindow:window({days:[6,7],start:'00:00',durationMinutes:15,timeZone:'UTC'})},
  {name:'Täglich',maintenanceWindow:window({days:[1,2,3,4,5,6,7],start:'23:45',durationMinutes:720,timeZone:'America/New_York'})},
 ];
 for(const extra of valid)assert.match(await admin.createCustomer(request,owner,input(extra)),/^[\da-f-]{36}$/,JSON.stringify(extra));
 assert.equal((await audit()).length,valid.length);
}));

test('update replaces the fields, raises the revision and is refused when stale',async()=>fixture(async({d,clock,admin,owner,request,audit,rows,customers})=>{
 const id=await admin.createCustomer(request,owner,input({name:'Alt'}));
 clock.now=t0+day;
 await admin.updateCustomer(request,owner,id,{...input({name:'Alt',contactName:'Erika',maintenanceWindow:window({days:[5,1],start:'22:00',durationMinutes:240})}),revision:0});
 let customer=await customers.customerById(id);
 assert.deepEqual([customer.revision,customer.updatedAt,customer.createdAt,customer.contactName],[1,t0+day,t0,'Erika']);
 assert.deepEqual(customer.maintenanceWindow,{days:[1,5],start:'22:00',durationMinutes:240,timeZone:'Europe/Berlin'},'the window reads back');
 assert.deepEqual((await audit()).at(-1),{actor:owner.label,action:'Kunde geändert',target:'Alt'});
 await admin.updateCustomer(request,owner,id,{...input({name:'Neu',contactName:'Erika'}),revision:1});
 customer=await customers.customerById(id);
 assert.deepEqual([customer.name,customer.revision,customer.maintenanceWindow],['Neu',2,null],'null removes the window');
 assert.deepEqual((await audit()).at(-1),{actor:owner.label,action:'Kunde geändert',target:'Alt → Neu'});
 // A stale revision: no change and no audit.
 const before=await rows(),entries=await audit();
 await rejects(admin.updateCustomer(request,owner,id,{...input({name:'Später'}),revision:1}),refused.concurrent);
 await rejects(admin.updateCustomer(request,owner,id,{...input({name:'Später'})}),refused.concurrent,'a missing revision is stale');
 await rejects(admin.updateCustomer(request,owner,randomUUID(),{...input({name:'Niemand'}),revision:0}),refused.missing);
 await rejects(admin.updateCustomer(request,owner,'kein-guid',{...input({name:'Niemand'}),revision:0}),refused.missing);
 await admin.createCustomer(request,owner,input({name:'Belegt'}));
 await rejects(admin.updateCustomer(request,owner,id,{...input({name:'BELEGT'}),revision:2}),refused.duplicate);
 assert.deepEqual((await rows()).filter(row=>row.id===id),before.filter(row=>row.id===id));
 assert.equal((await audit()).length,entries.length+1,'only the second create was audited');
 // A case-only rename of the customer itself is fine, and so is renaming the first customer.
 await admin.updateCustomer(request,owner,id,{...input({name:'NEU'}),revision:2});
 await admin.updateCustomer(request,owner,firstCustomer,{...input({name:'Hauptkunde',contactEmail:'it@haupt.example'}),revision:0});
 assert.deepEqual([(await customers.customerById(firstCustomer)).name,(await audit()).at(-1).target],['Hauptkunde','Standardkunde → Hauptkunde']);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM customers`).then(row=>row===null?null:row.n),3);
}));

test('update asks for a proof only when the audit retention gets shorter than the one that applied before',async()=>fixture(async({d,admin,owner,request,token,tokenExists,audit,customers,setInstanceDays,beforeCommit})=>{
 const revision=async id=>(await customers.customerById(id)).revision;
 // [label, own days before, own days after, stored instance days, needs a proof]
 const cases=[
  ['name only, own value',30,30,null,false],['longer own value',30,60,null,false],['shorter own value',30,10,null,true],
  ['own value from the instance value, longer',null,60,30,false],['own value from the instance value, shorter',null,10,30,true],
  ['back to a longer instance value',30,null,90,false],['back to a shorter instance value',30,null,10,true],
  ['from the default instance value (30), shorter',null,7,null,true],
 ];
 for(const [label,before,after,instance,risky] of cases){
  await setInstanceDays(instance);
  const id=await admin.createCustomer(request,owner,input({name:'Aufbewahrung '+randomUUID().slice(0,8),auditRetentionDays:before}));
  const name=(await customers.customerById(id)).name,payload={...input({name,auditRetentionDays:after}),revision:0};
  if(risky){
   const entries=(await audit()).length;
   await rejects(admin.updateCustomer(request,owner,id,payload),[403,'MFA_STEP_UP_REQUIRED','apiError.mfa.confirmChange'],label+': without a proof');
   assert.deepEqual([await revision(id),(await audit()).length],[0,entries],label+': nothing written without a proof');
   const used=await token();await d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${used}`);
   await rejects(admin.updateCustomer(request,owner,id,payload,used),[403,'MFA_STEP_UP_REQUIRED','apiError.mfa.proofExpired'],label+': with a used proof');
   const live=await token();
   await admin.updateCustomer(request,owner,id,payload,live);
   assert.deepEqual([(await customers.customerById(id)).auditRetentionDays,await tokenExists(live)],[after,false],label+': the proof is consumed with the change');
  }else{
   const unused=await token();
   await admin.updateCustomer(request,owner,id,payload,unused);
   assert.deepEqual([(await customers.customerById(id)).auditRetentionDays,await tokenExists(unused)],[after,true],label+': no proof is needed and a supplied one stays');
  }
  assert.deepEqual((await audit()).at(-1),{actor:owner.label,action:'Kunde geändert',target:name},label+': one audit row');
 }
 // The decision read the instance value: when it changes before the commit, the edit fails as stale.
 await setInstanceDays(30);
 const id=await admin.createCustomer(request,owner,input({name:'Instanzwert',auditRetentionDays:null}));
 const entries=(await audit()).length;
 await rejects(beforeCommit(()=>d.exec(sql`UPDATE maintenance_settings SET audit_days=90 WHERE id=1`),()=>admin.updateCustomer(request,owner,id,{...input({name:'Instanzwert',auditRetentionDays:60}),revision:0})),refused.concurrent);
 assert.deepEqual([await revision(id),(await audit()).length],[0,entries],'a changed instance value: nothing written');
 // An own value on both sides does not read the instance value: a change of it does not matter.
 const own=await admin.createCustomer(request,owner,input({name:'Eigener Wert',auditRetentionDays:30}));
 await beforeCommit(()=>d.exec(sql`UPDATE maintenance_settings SET audit_days=5 WHERE id=1`),()=>admin.updateCustomer(request,owner,own,{...input({name:'Eigener Wert',auditRetentionDays:40}),revision:0}));
 assert.equal(await revision(own),1,'the edit with own values commits');
}));

test('while multiple customers is off, create is refused before the commit and through the insert trigger in a race',async()=>fixture(async({d,admin,owner,request,audit,rows,beforeCommit})=>{
 const setting=enabled=>d.exec(sql`UPDATE customer_settings SET multiple_customers=${enabled} WHERE id=1`);
 await setting(false);
 const state=await rows(),entries=await audit();
 await rejects(admin.createCustomer(request,owner,input({name:'Aus'})),refused.off,'the check before the commit');
 assert.deepEqual([await rows(),await audit()],[state,entries],'no customer, no audit row');
 // On at the check, off right before the commit: customers_insert_multiple_customers refuses the insert.
 await setting(true);
 await rejects(beforeCommit(()=>setting(false),()=>admin.createCustomer(request,owner,input({name:'Rennen aus'}))),refused.off,'the trigger in a race');
 assert.deepEqual([await rows(),await audit()],[state,entries],'the rolled-back batch: no customer, no audit row');
}));

test('a name taken between the check and the commit answers through the constraint with the same key',async()=>fixture(async({d,admin,owner,request,audit,beforeCommit})=>{
 const entries=await audit();
 // UNIQUE customers_name (lower(name)) rolls the batch back; dbFailure gives customerMessages.duplicate.
 await rejects(beforeCommit(()=>d.exec(sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES(${randomUUID()},${'Rennen'},${t0},${t0})`),()=>admin.createCustomer(request,owner,input({name:'rennen'}))),refused.duplicate);
 assert.deepEqual(await audit(),entries,'no audit row');
}));

test('disable and enable write their audit rows; the first customer and unknown states are refused',async()=>fixture(async({d,admin,owner,request,token,tokenExists,audit,rows,customers})=>{
 const id=await admin.createCustomer(request,owner,input({name:'Kunde B'}));
 await admin.setCustomerStatus(request,owner,id,'disabled',0);
 assert.deepEqual([(await customers.customerById(id)).status,(await customers.customerById(id)).revision],['disabled',1]);
 assert.deepEqual((await audit()).at(-1),{actor:owner.label,action:'Kunde deaktiviert',target:'Kunde B'});
 await assert.rejects(d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id) VALUES(${randomUUID()},${'Neu'},${'fixture-new'},${1},${id})`),/customer-disabled/,'a disabled customer takes no new device');
 // The same status again writes nothing.
 const before=await rows(),entries=await audit(),unused=await token();
 await admin.setCustomerStatus(request,owner,id,'disabled',0);
 assert.deepEqual(await rows(),before);assert.deepEqual(await audit(),entries);assert.ok(await tokenExists(unused),'no proof is read');
 await admin.setCustomerStatus(request,owner,id,'active',1);
 assert.deepEqual([(await customers.customerById(id)).status,(await customers.customerById(id)).revision],['active',2]);
 assert.deepEqual((await audit()).at(-1),{actor:owner.label,action:'Kunde aktiviert',target:'Kunde B'});
 await rejects(admin.setCustomerStatus(request,owner,firstCustomer,'disabled',0),refused.defaultProtected);
 for(const status of ['archived','',null,undefined,1])await rejects(admin.setCustomerStatus(request,owner,id,status,2),refused.status);
 await rejects(admin.setCustomerStatus(request,owner,id,'disabled',1),refused.concurrent,'a stale revision');
 await rejects(admin.setCustomerStatus(request,owner,randomUUID(),'disabled',0),refused.missing);
 assert.equal((await customers.customerById(firstCustomer)).status,'active');
 assert.equal((await audit()).length,3);
}));

test('writes are bound to the Owner right, the customer revision and the live session',async()=>fixture(async({d,flags,admin,owner,reader,request,endSession,restoreSession,audit,rows,beforeCommit})=>{
 const id=await admin.createCustomer(request,owner,input({name:'Gebunden'}));
 const unchanged=async label=>{assert.deepEqual(await rows(),state,label+': no customer change');assert.deepEqual(await audit(),entries,label+': no audit row');};
 let state=await rows(),entries=await audit();
 const calls=[
  ['create',viewer=>admin.createCustomer(request,viewer,input({name:'Neu'}))],
  ['update',viewer=>admin.updateCustomer(request,viewer,id,{...input({name:'Neu'}),revision:0})],
  ['status',viewer=>admin.setCustomerStatus(request,viewer,id,'disabled',0)],
 ];
 for(const [label,call] of calls){
  // Not an Owner at all.
  await rejects(call(reader),refused.ownerOnly);
  await unchanged(label+' non-Owner');
  // The Owner right is revoked between the check and the commit.
  flags.ownerPrecheck=true;await d.exec(sql`DELETE FROM test_owners`);
  await rejects(call(owner),refused.ownerOnly);
  await unchanged(label+' revoked Owner');
  await d.exec(sql`INSERT INTO test_owners(principal) VALUES(${owner.principal})`);
  // The MFA session ends between the check and the commit: the session's own error, not a step-up.
  await rejects(beforeCommit(endSession,()=>call(owner)),[401,'SESSION_EXPIRED','apiError.mfa.sessionExpired']);
  await unchanged(label+' ended session');
  await restoreSession();
 }
 // The customer changes or disappears between the read and the commit.
 for(const [label,call] of calls.slice(1)){
  await rejects(beforeCommit(()=>d.exec(sql`UPDATE customers SET revision=revision+1 WHERE id=${id}`),()=>call(owner)),refused.concurrent);
  assert.equal((await audit()).length,entries.length,label+': no audit row');
  await d.exec(sql`UPDATE customers SET revision=0 WHERE id=${id}`);
  // A customer with audit rows ("Kunde angelegt") is deleted like any other empty customer; its rows stay.
  const vanish=()=>d.exec(sql`DELETE FROM customers WHERE id=${id}`);
  await rejects(beforeCommit(vanish,()=>call(owner)),refused.missing);
  assert.equal((await audit()).length,entries.length,label+': no audit row');
  // A removed id is never inserted again (customers_insert_removed_id) and its tombstone stays; for the next case the
  // fixture brings the same customer back with both triggers lifted for that one step.
  await d.exec(sql`ALTER TABLE customers DISABLE TRIGGER customers_insert_removed_id`);
  await d.exec(sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES(${id},${'Gebunden'},${state.find(row=>row.id===id).created_at},${state.find(row=>row.id===id).updated_at})`);
  await d.exec(sql`ALTER TABLE customers ENABLE TRIGGER customers_insert_removed_id`);
  await d.exec(sql`ALTER TABLE removed_customers DISABLE TRIGGER removed_customers_delete`);
  await d.exec(sql`DELETE FROM removed_customers WHERE id=${id}`);
  await d.exec(sql`ALTER TABLE removed_customers ENABLE TRIGGER removed_customers_delete`);
  state=await rows();entries=await audit();
 }
}));

// ---- Technicians that see a customer (customer boundary) -------------
async function technicianFixture(context){
 const {d}=context,people={};
 for(const name of ['tech1','tech2','member']){
  const id=randomUUID();people[name]={id,principal:'local:'+id};
  await d.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at) VALUES(${id},${name},${name+'@example.test'},${name},${'local:'+id},${name+'@example.test'},'active',1,${t0},${t0})`);
  await d.exec(sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until) VALUES(${'session-'+name},${id},1,${t0},${t0+day},${t0})`);
 }
 const team=randomUUID();
 await d.exec(sql`INSERT INTO user_groups(id,name,description,enabled,created_at) VALUES(${team},${'Team Nord'},${''},1,${t0})`);
 await d.exec(sql`INSERT INTO user_group_members(group_id,user_id) VALUES(${team},${people.member.id})`);
 const assignments=async(customer=firstCustomer)=>(await d.query(sql`SELECT principal_type AS type,principal_id AS id,created_by AS "createdBy" FROM customer_assignments WHERE customer_id=${customer} ORDER BY principal_type,principal_id`)).map(row=>({...row}));
 const technicianAudit=async()=>(await d.query(sql`SELECT actor,action,target FROM audit WHERE scope='portal' AND action='Techniker geändert' ORDER BY id`)).map(row=>({...row}));
 const revision=async(customer=firstCustomer)=>Number(await d.one(sql`SELECT revision FROM customers WHERE id=${customer}`).then(row=>row===null?null:row.revision));
 const sessions=async name=>Number(await d.one(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE user_id=${people[name].id}`).then(row=>row===null?null:row.n));
 const state=async()=>({assignments:(await d.query(sql`SELECT * FROM customer_assignments ORDER BY customer_id,principal_type,principal_id`)).map(row=>({...row})),customers:await context.rows(),audit:await technicianAudit()});
 return {people,team,assignments,technicianAudit,revision,sessions,state};
}

test('technicians: adding writes rows, the revision and one audit row; the same set again writes nothing; removing revokes the sessions',async()=>fixture(async context=>{
 const {clock,admin,owner,proof,proofExists,customers}=context,{people,team,assignments,technicianAudit,revision,sessions,state}=await technicianFixture(context);
 clock.now=t0+day;
 const authorization=await proof();
 await admin.setCustomerTechnicians(owner,firstCustomer,{userIds:[people.tech1.id,people.tech2.id,people.tech1.id],groupIds:[team],revision:0},authorization);
 assert.deepEqual(await assignments(),[{type:'group',id:team,createdBy:owner.principal},...[people.tech1.id,people.tech2.id].sort().map(id=>({type:'user',id,createdBy:owner.principal}))],'duplicates are dropped; created_by is the Owner');
 assert.equal(await revision(),1,'the revision rises by one');
 assert.equal((await customers.customerById(firstCustomer)).updatedAt,t0+day);
 assert.deepEqual(await technicianAudit(),[{actor:owner.label,action:'Techniker geändert',target:'Standardkunde (+3 / −0)'}]);
 assert.equal(await proofExists(authorization),false,'the proof is consumed');
 // The same set again: no write, no audit, the proof stays usable.
 const unchanged=await state(),again=await proof();
 await admin.setCustomerTechnicians(owner,firstCustomer,{userIds:[people.tech2.id,people.tech1.id],groupIds:[team],revision:1},again);
 assert.deepEqual(await state(),unchanged,'the same set writes nothing');assert.ok(await proofExists(again),'the proof stays usable');
 // Removing a user and the group revokes their sessions; tech2 keeps the row and the session.
 assert.deepEqual([await sessions('tech1'),await sessions('member'),await sessions('tech2')],[1,1,1]);
 await admin.setCustomerTechnicians(owner,firstCustomer,{userIds:[people.tech2.id],groupIds:[],revision:1},await proof());
 assert.deepEqual(await assignments(),[{type:'user',id:people.tech2.id,createdBy:owner.principal}]);
 assert.equal(await revision(),2);
 assert.deepEqual((await technicianAudit()).at(-1),{actor:owner.label,action:'Techniker geändert',target:'Standardkunde (+0 / −2)'});
 assert.deepEqual([await sessions('tech1'),await sessions('member'),await sessions('tech2')],[0,0,1],'the removed user and the members of the removed group lose their sessions');
 // A disabled customer can be assigned like any other.
 const other=await admin.createCustomer(context.request,owner,input({name:'Kunde Zwei'}));
 await admin.setCustomerStatus(context.request,owner,other,'disabled',0);
 await admin.setCustomerTechnicians(owner,other,{userIds:[people.tech1.id],groupIds:[],revision:1},await proof());
 assert.deepEqual((await assignments(other)).map(row=>row.id),[people.tech1.id]);
}));

test('technicians: invalid input, a stale revision, an unknown customer and a non-Owner change nothing',async()=>fixture(async context=>{
 const {admin,owner,reader,proof,proofExists}=context,{people,team,state}=await technicianFixture(context);
 const before=await state(),many=Array.from({length:1001},()=>randomUUID());
 const invalid=[
  {userIds:'x',groupIds:[]},{userIds:[],groupIds:null},{userIds:undefined,groupIds:[]},{userIds:{0:people.tech1.id},groupIds:[]},
  {userIds:['kein-guid'],groupIds:[]},{userIds:[42],groupIds:[]},{userIds:[],groupIds:['x']},
  {userIds:many,groupIds:[]},{userIds:[],groupIds:many},
  {userIds:[randomUUID()],groupIds:[]},{userIds:[],groupIds:[randomUUID()]},{userIds:[team],groupIds:[]},{userIds:[],groupIds:[people.tech1.id]},
 ];
 for(const extra of invalid){
  const authorization=await proof();
  await rejects(admin.setCustomerTechnicians(owner,firstCustomer,{...extra,revision:0},authorization),refused.technicians,JSON.stringify(extra).slice(0,80));
  assert.ok(await proofExists(authorization),'invalid input keeps the proof');
 }
 await rejects(admin.setCustomerTechnicians(owner,firstCustomer,{userIds:[people.tech1.id],groupIds:[],revision:1},await proof()),refused.concurrent);
 await rejects(admin.setCustomerTechnicians(owner,firstCustomer,{userIds:[people.tech1.id],groupIds:[]},await proof()),refused.concurrent,'a missing revision is stale');
 await rejects(admin.setCustomerTechnicians(owner,randomUUID(),{userIds:[people.tech1.id],groupIds:[],revision:0},await proof()),refused.missing);
 await rejects(admin.setCustomerTechnicians(reader,firstCustomer,{userIds:[people.tech1.id],groupIds:[],revision:0},await proof(reader)),refused.ownerOnly);
 assert.deepEqual(await state(),before,'nothing was written');
 // A user of any status can be assigned.
 await context.d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${people.tech1.id}`);
 await admin.setCustomerTechnicians(owner,firstCustomer,{userIds:[people.tech1.id],groupIds:[],revision:0},await proof());
 assert.equal((await state()).assignments.length,1,'a disabled user is assigned');
}));

test('technicians: the write is bound to the Owner right, the proof and the added subjects',async()=>fixture(async context=>{
 const {d,flags,admin,owner,proof,beforeCommit}=context,{people,state}=await technicianFixture(context);
 const call=authorization=>admin.setCustomerTechnicians(owner,firstCustomer,{userIds:[people.tech1.id],groupIds:[],revision:0},authorization);
 let before=await state();
 flags.ownerPrecheck=true;await d.exec(sql`DELETE FROM test_owners`);
 await rejects(call(await proof()),refused.ownerOnly);
 assert.deepEqual(await state(),before,'revoked Owner: nothing written');
 await d.exec(sql`INSERT INTO test_owners(principal) VALUES(${owner.principal})`);
 const used=await proof();await d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${used.tokenHash}`);
 await rejects(call(used),refused.proofUsed);
 assert.deepEqual(await state(),before,'used proof: nothing written');
 await rejects(beforeCommit(()=>d.exec(sql`UPDATE customers SET revision=revision+1 WHERE id=${firstCustomer}`),async()=>call(await proof())),refused.concurrent);
 assert.deepEqual((await state()).audit,before.audit,'customer revision: no audit');
 await d.exec(sql`UPDATE customers SET revision=0 WHERE id=${firstCustomer}`);
 before=await state();
 // The added user is deleted between the read and the commit.
 await rejects(beforeCommit(()=>d.exec(sql`DELETE FROM local_users WHERE id=${people.tech1.id}`),async()=>call(await proof())),refused.technicians);
 assert.deepEqual(await state(),before,'deleted subject: nothing written');
}));
