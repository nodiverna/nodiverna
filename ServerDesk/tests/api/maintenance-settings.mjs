// The page Settings → Data retention on the server: the real route
// app/api/maintenance/route.ts, lib/server/maintenance.ts, lib/server/identity/rbac.ts, lib/server/identity/mfa.ts,
// lib/server/identity/local-auth.ts, lib/server/audit.ts and runtime/maintenance.mjs on an isolated
// PostgreSQL test database. log() throws, so the audit row comes from the
// committing batch. Also the size facts of GET (lib/server/maintenance-storage.ts):
// catalog and statistics reads only, null values on a failing statement, the
// environment-only retention and the customers with their own retention. Last,
// the audit rows of a deleted customer (removed_customers) follow the instance
// retention of a maintenance run.
// No test reaches GitHub: the release check of a maintenance run fails as unreachable.
import '../support/offline-fetch.mjs';
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';
import {enableMultipleCustomers} from '../support/customer-separation.mjs';
import {sessionHeaders} from '../support/session-cookies.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {createStorage} from '../../runtime/storage.mjs';
import {nextMaintenanceSlot,runMaintenance} from '../../runtime/maintenance.mjs';

const d=await sourceDatabase();
const directory=await mkdtemp(path.join(os.tmpdir(),'serverdesk-maintenance-settings-'));
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const origin='https://maintenance.test',time=Date.now(),day=86_400_000;
 const HttpError=realHttpError;
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 let current=null;const batches=[];
 const hooked=hookDatabase(d,{record:batches});
 const server={
  config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:'',now:()=>Date.now(),random:token,hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:request=>request.json(),
  sameOrigin:request=>{if(request.headers.get('origin')!==origin)throw new HttpError(403,serverText('apiError.request.invalidOrigin'));},
  requireViewer:async()=>{if(!current)throw new HttpError(401,'Bitte anmelden.','IDENTITY_LOGIN_REQUIRED');return current;},requireAuthIdentity:async()=>current,
  log:async()=>{throw new Error('log() must not be used by these actions');},
  failure:e=>Response.json({error:e instanceof HttpError?e.message:serverText('apiError.storageUnavailable'),...(e instanceof HttpError&&e.code?{code:e.code}:{})},{status:e instanceof HttpError?e.status:503}),
 };
 const storage=createStorage({OBJECT_STORAGE_DRIVER:'filesystem',OBJECT_STORAGE_PATH:path.join(directory,'objects')});
 // The portal environment of lib/server/maintenance.ts: retention start values and the object storage.
 const runtime={BUCKET:storage};
 const env=new Proxy({},{get:(_target,key)=>Object.hasOwn(runtime,key)?runtime[key]:''});
 const webauthn={generateRegistrationOptions:async()=>({}),verifyRegistrationResponse:async()=>({verified:false}),generateAuthenticationOptions:async()=>({}),verifyAuthenticationResponse:async()=>({verified:false})};
 const load=sourceLoader(),imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'@simplewebauthn/server':webauthn,'cloudflare:workers':{env}};
 const maintenance=load('lib/server/maintenance.ts',imports),api=load('app/api/maintenance/route.ts',imports),codes=load('lib/errors/codes.ts');
 const text=code=>codes.errorCatalog[code].message;
 check([text('MAINTENANCE_OWNER_ONLY'),text('MAINTENANCE_RETENTION_INVALID'),text('MAINTENANCE_TIME_INVALID'),text('MAINTENANCE_TIME_ZONE_INVALID'),text('MAINTENANCE_SETTINGS_CONFLICT'),text('MAINTENANCE_RUNNING'),text('MAINTENANCE_MIGRATIONS_PENDING')],
  [serverText('apiError.maintenance.ownerOnly'),serverText('apiError.maintenance.retentionInvalid'),serverText('apiError.maintenance.timeInvalid'),serverText('apiError.maintenance.timeZoneInvalid'),serverText('apiError.maintenance.settingsConflict'),serverText('apiError.maintenance.running'),serverText('apiError.maintenance.migrationsPending')],'German default texts with the meaning of the UI copy');
 check([codes.errorCatalog.MAINTENANCE_OWNER_ONLY.status,codes.errorCatalog.MAINTENANCE_RETENTION_INVALID.status,codes.errorCatalog.MAINTENANCE_SETTINGS_CONFLICT.status,codes.errorCatalog.MAINTENANCE_RUNNING.status,codes.errorCatalog.MAINTENANCE_MIGRATIONS_PENDING.status],[403,400,409,409,409],'statuses');

 // ---- Fixture -------------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 async function account(label,permissions=['*']){
  const {actor}=await sourceActor(d,label,permissions);actor.userId=actor.id;
  await d.exec(sql`UPDATE local_users SET password_hash='fixture-password',must_reset=0 WHERE id=${actor.id}`);
  await insert('mfa_accounts',{principal:actor.principal,secret_enc:'migrated:authenticator-managed',recovery_hashes:'[]',last_counter:-1,created_at:time,authenticators_migrated:1});
  return actor;
 }
 // A signed-in browser: bound primary session, live MFA session and one fresh management proof unless proof is false.
 async function browser(actor,{proof=true}={}){
  const at=Date.now(),primary=token(),session=token(),management=token();
  await insert('mfa_sessions',{token_hash:sha(session),principal:actor.principal,created_at:at,last_activity:at,idle_expires_at:at+900_000,expires_at:at+86_400_000});
  await insert('local_auth_sessions',{token_hash:sha(primary),user_id:actor.id,auth_version:1,created_at:at,expires_at:at+86_400_000,pending_until:at+600_000,mfa_hash:sha(session)});
  if(proof)await insert('mfa_management_proofs',{token_hash:sha(management),principal:actor.principal,session_hash:sha(session),expires_at:at+300_000});
  return {primary,session,management:proof?management:null};
 }
 const answer=async response=>({status:response.status,body:await response.json(),cache:response.headers.get('cache-control')});
 const get=async(actor,b)=>{current=actor;return answer(await api.GET(new Request(origin+'/api/maintenance',{headers:sessionHeaders(b)})));};
 const post=async(actor,b,payload)=>{current=actor;batches.length=0;return answer(await api.POST(new Request(origin+'/api/maintenance',{method:'POST',headers:sessionHeaders(b,{'Content-Type':'application/json',Origin:origin}),body:JSON.stringify(payload)})));};
 const settings=()=>d.one(sql`SELECT audit_days,job_days,run_at,time_zone,revision,updated_by FROM maintenance_settings WHERE id=1`);
 const audits=()=>d.query(sql`SELECT actor,action,target,scope,server_id,customer_id FROM audit WHERE action='Maintenance settings changed' ORDER BY id`);
 const runs=()=>d.query(sql`SELECT id,status,trigger,requested_by,result,error FROM maintenance_runs ORDER BY id`);
 const runAudits=()=>d.query(sql`SELECT actor,action,target,scope,server_id,customer_id FROM audit WHERE action='Maintenance run started' ORDER BY id`);
 const proofExists=async value=>!!await d.one(sql`SELECT 1 AS present FROM mfa_management_proofs WHERE token_hash=${sha(value)}`);
 const owner=await account('owner@maintenance.test'),technician=await account('tech@maintenance.test',['view','portal.users.manage']);
 const valid={action:'set',auditDays:10,jobDays:30,runAt:'04:30',timeZone:'Europe/Berlin',revision:0};

 // ---- Owner only ------------------------------------------------------------------
 {
  const b=await browser(technician),before=await settings();
  // No storage or customer statement runs before the Owner check.
  const seen=[];hooked.hooks.statement=text=>{seen.push(text);};
  await get(technician,b);
  hooked.hooks.statement=null;
  check(seen.filter(text=>/pg_database_size|pg_total_relation_size|pg_stat_user_tables|transfer_chunks|audit_retention_days/.test(text)),[],'a non-Owner GET runs no storage or customer statement');
  for(const [label,result] of [['GET',await get(technician,b)],['set',await post(technician,b,{...valid,managementToken:b.management})],['run',await post(technician,b,{action:'run'})],['unknown action',await post(technician,b,{action:'drop'})]]){
   check([result.status,result.body.code,result.body.error],[403,'MAINTENANCE_OWNER_ONLY',serverText('apiError.maintenance.ownerOnly')],`non-Owner ${label}: 403`);
  }
  check(await settings(),before,'a non-Owner changes nothing');check(await runs(),[],'a non-Owner starts no run');check(await audits(),[],'and writes no audit row');
  check(await runAudits(),[],'403 on Run now writes no Maintenance run started row');
  check(await proofExists(b.management),true,'the proof is not touched');
 }

 // ---- Validation before any write --------------------------------------------------
 {
  const b=await browser(owner),before=await settings();
  const cases=[
   ...[0,3651,1.5,'30',null].flatMap(value=>[[{auditDays:value},'MAINTENANCE_RETENTION_INVALID'],[{jobDays:value},'MAINTENANCE_RETENTION_INVALID']]),
   [{auditDays:undefined},'MAINTENANCE_RETENTION_INVALID'],
   ...['24:00','3:00','03:60','',null,180].map(value=>[{runAt:value},'MAINTENANCE_TIME_INVALID']),
   ...['Mars/Base','','Europe/berlin ',null,'Local'].map(value=>[{timeZone:value},'MAINTENANCE_TIME_ZONE_INVALID']),
   [{revision:undefined},'VALIDATION_FAILED'],[{revision:-1},'VALIDATION_FAILED'],[{revision:'0'},'VALIDATION_FAILED'],[{revision:1.5},'VALIDATION_FAILED'],
  ];
  for(const [change,code] of cases){
   const result=await post(owner,b,{...valid,...change,managementToken:b.management});
   check([result.status,result.body.code,result.body.error],[code==='VALIDATION_FAILED'?400:codes.errorCatalog[code].status,code,text(code)],`${JSON.stringify(change)}: ${code} with its readable text`);
  }
  check(await settings(),before,'nothing is written');check(await audits(),[],'no audit row');check(await proofExists(b.management),true,'the proof stays');
  check(batches.length,0,'no transaction ran');
  const unknown=await post(owner,b,{action:'drop'});check([unknown.status,unknown.body.code],[400,'VALIDATION_FAILED'],'an unknown action gives 400');
 }

 // ---- GET: settings, source flags, status and history ---------------------------------
 {
  runtime.AUDIT_RETENTION_DAYS='15';runtime.JOB_RETENTION_DAYS='abc';
  const b=await browser(owner,{proof:false}),now=Date.now();
  for(let index=0;index<25;index++)await d.exec(sql`INSERT INTO maintenance_runs(started_at,finished_at,status,trigger,result) VALUES(${now-(25-index)*1000},${now-(25-index)*1000+10},'succeeded','schedule','{}')`);
  const result=await get(owner,b);
  check([result.status,result.cache],[200,'no-store'],'GET answers 200 with no-store');
  check(Object.keys(result.body),['settings','envInvalid','status','history','storage','areaRetention','customerRetention'],'the shape');
  check(result.body.settings,{auditDays:15,jobDays:null,runAt:'03:00',timeZone:'UTC',revision:0,source:{auditDays:'env',jobDays:'env'}},'start values from the environment; an invalid one shows as empty');
  check(result.body.envInvalid,{auditDays:false,jobDays:true},'the invalid start value is flagged');
  check(result.body.history.length,20,'at most 20 rows');
  const ids=(await runs()).map(row=>row.id).reverse().slice(0,20);
  check(result.body.history.map(run=>run.id),ids,'newest first');
  check(Object.keys(result.body.history[0]),['id','startedAt','finishedAt','status','trigger','requestedBy','result','error'],'the run shape');
  check(result.body.status.lastRun,result.body.history[0],'lastRun is history[0]');
  check([result.body.status.running,result.body.status.stale,result.body.status.lastSuccessAt],[false,false,now-1000+10],'status from the runs');
  check(result.body.status.nextRunAt,nextMaintenanceSlot(Date.now(),180,'UTC'),'nextRunAt is the next slot after now');
  runtime.JOB_RETENTION_DAYS='';
  check((await get(owner,b)).body.settings.source,{auditDays:'env',jobDays:'default'},'an empty variable counts as unset');
  delete runtime.AUDIT_RETENTION_DAYS;delete runtime.JOB_RETENTION_DAYS;
  await d.exec(sql`DELETE FROM maintenance_runs`);
 }

 // ---- GET: size facts from the catalog and the statistics only ---------------------------
 {
  const b=await browser(owner,{proof:false});
  const retained=['audit','jobs','job_outputs','device_software_changes','alerts','notification_events','notification_deliveries','agent_integrity_events','transfers','transfer_chunks'];
  const readsTable=text=>retained.some(table=>new RegExp(`\\b(FROM|JOIN)\\s+${table}\\b`,'i').test(text));
  const seen=[];hooked.hooks.statement=text=>{seen.push(text);};
  const result=await get(owner,b);
  hooked.hooks.statement=null;
  const {storage}=result.body;
  check([result.status,typeof storage.databaseBytes==='number'&&storage.databaseBytes>0],[200,true],'the database size is a positive number');
  check(Object.keys(storage.tables).sort(),[...retained].sort(),'one entry per retained table');
  for(const table of retained)check([Number.isInteger(storage.tables[table].bytes)&&storage.tables[table].bytes>=0,Number.isInteger(storage.tables[table].rows)&&storage.tables[table].rows>=0],[true,true],`${table}: numeric bytes and estimated rows`);
  check(storage.transferObjectBytes,0,'no chunks: no file transfer storage');
  // Only catalog functions and the statistics view; the one table read is the sum over transfer_chunks.
  check(seen.filter(readsTable),['SELECT COALESCE(sum(size),0)::bigint AS bytes FROM transfer_chunks'],'no statement selects from a retained table except the transfer_chunks sum');
  const storageTexts=seen.filter(text=>/pg_database_size|pg_total_relation_size|pg_stat_user_tables|transfer_chunks/.test(text));
  check(storageTexts.length,3,'three storage statements');
  check(storageTexts.filter(text=>/count\(/i.test(text)),[],'no count( in a storage statement');
  check(seen.filter(text=>/count\(/i.test(text)&&readsTable(text)),[],'no count( over a retained table');
  check(storageTexts.every(text=>/pg_database_size\(current_database\(\)\)|pg_total_relation_size\(relid\).*FROM pg_stat_user_tables WHERE schemaname=current_schema\(\)|sum\(size\)/.test(text)),true,'database size, table sizes with indexes and TOAST from the statistics of the app schema, and the chunk sum');

  // The chunks of transfers that are not cleared are the file transfer storage.
  const transfer='00000000-0000-4000-8000-0000000000f1',now=Date.now();
  await d.exec(sql`INSERT INTO transfers(id,server_id,principal,direction,path,size,sha256,state,overwrite,created_at,updated_at,expires_at) VALUES(${transfer},'device-a','private:tester','upload','C:\\Temp\\f.bin',4000,${'f'.repeat(64)},'active',0,${now},${now},${now+day})`);
  for(const [chunk,size] of [[0,1024],[1,2048],[2,7]])await d.exec(sql`INSERT INTO transfer_chunks(id,transfer_id,chunk,size,sha256) VALUES(${transfer+'-'+chunk},${transfer},${chunk},${size},${'e'.repeat(64)})`);
  check((await get(owner,b)).body.storage.transferObjectBytes,3079,'transferObjectBytes is the sum of the chunk sizes');
  await d.exec(sql`DELETE FROM transfer_chunks WHERE transfer_id=${transfer}`);await d.exec(sql`DELETE FROM transfers WHERE id=${transfer}`);

  // A failing statement: 200, its values null, one log line without SQL in the answer.
  const logged=[],error=console.error;console.error=line=>{logged.push(String(line));};
  hooked.hooks.statement=text=>{if(/pg_stat_user_tables|pg_database_size/.test(text))throw new Error('permission denied for function pg_total_relation_size');};
  let failing;
  try{failing=await get(owner,b);}finally{hooked.hooks.statement=null;console.error=error;}
  check(failing.status,200,'a failing storage statement still gives 200');
  check([failing.body.storage.databaseBytes,failing.body.storage.tables.audit,failing.body.storage.tables.transfer_chunks,failing.body.storage.transferObjectBytes],[null,{bytes:null,rows:null},{bytes:null,rows:null},0],'the affected values are null; the chunk sum still answers');
  check([logged.length,logged[0]?.includes('permission denied')],[1,true],'the failure goes to the server log once per request');
  check(/pg_|SELECT|permission denied/.test(JSON.stringify(failing.body)),false,'no SQL or error text in the answer');

  // The environment-only retention: default, env, invalid.
  check(result.body.areaRetention,{softwareDays:{days:365,source:'default',envInvalid:false},alertDays:{days:90,source:'default',envInvalid:false},assistantScriptDays:7,integrityDays:90},'the defaults and the two fixed areas');
  runtime.SOFTWARE_CHANGE_RETENTION_DAYS='120';runtime.ALERT_RETENTION_DAYS='0';
  check((await get(owner,b)).body.areaRetention,{softwareDays:{days:120,source:'env',envInvalid:false},alertDays:{days:null,source:'env',envInvalid:true},assistantScriptDays:7,integrityDays:90},'a valid variable is the env source; an invalid one gives null and envInvalid');
  delete runtime.SOFTWARE_CHANGE_RETENTION_DAYS;delete runtime.ALERT_RETENTION_DAYS;

  // Customers with their own audit retention.
  check(result.body.customerRetention,{count:0,minDays:null,maxDays:null},'no customer with its own retention');
  const customerIds=['00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000c2','00000000-0000-4000-8000-0000000000c3'];
  await d.exec(enableMultipleCustomers());
  for(const [id,days] of [[customerIds[0],7],[customerIds[1],400],[customerIds[2],null]])await d.exec(sql`INSERT INTO customers(id,name,status,created_at,updated_at,audit_retention_days) VALUES(${id},${'Kunde '+id.slice(-2)},'active',1,1,${days})`);
  check((await get(owner,b)).body.customerRetention,{count:2,minDays:7,maxDays:400},'two customers of 7 and 400 days; a customer without its own value does not count');
  await d.exec(sql`DELETE FROM customers WHERE id IN (${customerIds[0]},${customerIds[1]},${customerIds[2]})`);
 }

 // ---- set: step-up for a shorter retention, one commit with the audit row, conflicts ----
 {
  runtime.AUDIT_RETENTION_DAYS='15';
  const without=await browser(owner,{proof:false});
  const refused=await post(owner,without,{...valid});
  check([refused.status,refused.body.code],[403,'MFA_STEP_UP_REQUIRED'],'a set that shortens the audit retention (15 → 10) without proof asks for the step-up');
  check((await settings()).revision,0,'nothing stored without proof');
  const b=await browser(owner),saved=await post(owner,b,{...valid,managementToken:b.management});
  check(saved.status,200,'saved: '+saved.body.error);
  check(await settings(),{audit_days:10,job_days:30,run_at:270,time_zone:'Europe/Berlin',revision:1,updated_by:'owner@maintenance.test'},'the values are stored and the revision grows');
  check(saved.body.settings,{auditDays:10,jobDays:30,runAt:'04:30',timeZone:'Europe/Berlin',revision:1,source:{auditDays:'stored',jobDays:'stored'}},'the reply has the new values');
  check(await audits(),[{actor:'owner@maintenance.test',action:'Maintenance settings changed',target:`Audit 15 → 10 days, ${['jobs','30'].join(' ')} → 30 days, daily run 03:00 UTC → 04:30 Europe/Berlin`,scope:'portal',server_id:null,customer_id:null}],'exactly one portal audit row with the target');
  const committing=batches.filter(batch=>batch.some(statement=>/^UPDATE maintenance_settings\b/.test(statement)));
  check(committing.length,1,'one committing batch');
  check(committing[0].some(statement=>/^INSERT INTO audit\b/.test(statement))&&committing[0].some(statement=>/^DELETE FROM mfa_management_proofs\b/.test(statement)),true,'the update, the audit row and the proof consumption commit together');
  check(await proofExists(b.management),false,'the proof is consumed');

  const again=await browser(owner),unchanged=await post(owner,again,{...valid,revision:1,managementToken:again.management});
  check([unchanged.status,(await settings()).revision,(await audits()).length,await proofExists(again.management)],[200,1,1,true],'an unchanged set writes nothing, no audit row, and keeps the proof');
  const stale=await post(owner,again,{...valid,auditDays:20,revision:0,managementToken:again.management});
  check([stale.status,stale.body.code,stale.body.error],[409,'MAINTENANCE_SETTINGS_CONFLICT',text('MAINTENANCE_SETTINGS_CONFLICT')],'a stale revision gives 409');
  check([(await settings()).audit_days,(await audits()).length,await proofExists(again.management)],[10,1,true],'the conflict writes nothing');
  // Without a shorter retention (lib/step-up.ts maintenanceSetNeedsStepUp) the save needs no proof:
  // it commits the same audit row behind the live session fence and leaves a supplied proof unused.
  const schedule={...valid,runAt:'05:00',timeZone:'UTC',revision:1};
  const plain=await browser(owner),moved=await post(owner,plain,{...schedule,managementToken:plain.management});
  check([moved.status,(await settings()).run_at,(await settings()).revision,await proofExists(plain.management)],[200,300,2,true],'a schedule change saves without a proof; the supplied proof stays');
  check((await audits()).at(-1),{actor:'owner@maintenance.test',action:'Maintenance settings changed',target:`Audit 10 → 10 days, ${['jobs','30'].join(' ')} → 30 days, daily run 04:30 Europe/Berlin → 05:00 UTC`,scope:'portal',server_id:null,customer_id:null},'the same audit row as with a proof');
  const fenced=batches.filter(batch=>batch.some(statement=>/^UPDATE maintenance_settings\b/.test(statement)));
  check([fenced.length,fenced[0].some(statement=>/^INSERT INTO audit\b/.test(statement)),fenced[0].some(statement=>/mfa_management_proofs/.test(statement)),fenced[0].some(statement=>statement.includes('live_session.idle_expires_at>'))],[1,true,false,true],'one batch with the audit row and the session fence, no proof');
  const longer=await post(owner,await browser(owner,{proof:false}),{...schedule,auditDays:40,jobDays:60,revision:2});
  check([longer.status,(await settings()).audit_days,(await settings()).job_days],[200,40,60],'a longer retention saves without a proof');
  const shorterJobs=await post(owner,await browser(owner,{proof:false}),{...schedule,auditDays:40,jobDays:59,revision:3});
  check([shorterJobs.status,shorterJobs.body.code,(await settings()).job_days,(await settings()).revision],[403,'MFA_STEP_UP_REQUIRED',60,3],'a shorter job retention asks for the step-up and writes nothing');
  // The live session is part of the commit: an MFA session that ends before it writes nothing and answers the session error.
  {
   const ending=await browser(owner,{proof:false}),before=await settings(),rows=(await audits()).length;
   hooked.hooks.transaction=async()=>{hooked.hooks.transaction=null;await d.exec(sql`UPDATE mfa_sessions SET idle_expires_at=${Date.now()-1000} WHERE token_hash=${sha(ending.session)}`);};
   const ended=await post(owner,ending,{...schedule,auditDays:40,jobDays:60,runAt:'06:00',revision:3});
   check([ended.status,['SESSION_EXPIRED','MFA_LOGIN_REQUIRED','IDENTITY_LOGIN_REQUIRED'].includes(ended.body.code),await settings(),(await audits()).length],[401,true,before,rows],'an ended MFA session: the session error, nothing written');
  }
  // The revision keeps the decision: a save that changes the retention in between leaves the harmless save without effect.
  {
   const racing=await browser(owner,{proof:false}),rows=(await audits()).length;
   hooked.hooks.transaction=async()=>{hooked.hooks.transaction=null;await d.exec(sql`UPDATE maintenance_settings SET audit_days=5,revision=revision+1 WHERE id=1`);};
   const raced=await post(owner,racing,{...schedule,auditDays:40,jobDays:60,runAt:'06:00',revision:3});
   check([raced.status,raced.body.code,(await settings()).audit_days,(await settings()).run_at,(await audits()).length],[409,'MAINTENANCE_SETTINGS_CONFLICT',5,300,rows],'a concurrent retention change: 409 and nothing written');
   await d.exec(sql`UPDATE maintenance_settings SET audit_days=10,job_days=30,run_at=270,time_zone='Europe/Berlin',revision=1 WHERE id=1`);
  }
  // A demoted Owner gets 403 after the fresh re-check.
  const demoted=await account('demoted@maintenance.test'),db2=await browser(demoted);
  const [assignment]=await d.query(sql`SELECT id FROM role_assignments WHERE principal_id=${demoted.id}`);
  await d.exec(sql`DELETE FROM role_assignments WHERE id=${assignment.id}`);
  const lost=await post({...demoted},db2,{...valid,auditDays:20,revision:1,managementToken:db2.management});
  check([lost.status,lost.body.code],[403,'MAINTENANCE_OWNER_ONLY'],'a demoted Owner gets 403');
  check((await settings()).audit_days,10,'and changes nothing');
  delete runtime.AUDIT_RETENTION_DAYS;
 }

 // ---- run: 202, manual row, held lock, changed retention at the next run ------------
 {
  const b=await browser(owner,{proof:false}),now=Date.now();
  for(const age of [9,11,40])await d.exec(sql`INSERT INTO audit(at,actor,action,target,server_id,scope) VALUES(${now-age*day-60_000},'tester','test.action','target',NULL,'portal')`);
  // A transfer whose storage listing waits, so the first run holds the lock.
  await d.exec(sql`INSERT INTO transfers(id,server_id,principal,direction,path,size,sha256,state,overwrite,created_at,updated_at,expires_at) VALUES('00000000-0000-4000-8000-000000000009','device-a','private:tester','upload','C:\\Temp\\c.bin',10,${'c'.repeat(64)},'cancelled',0,${now-day},${now-day},${now+day})`);
  let entered,release;const inside=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  runtime.BUCKET={...storage,async list(options){entered();await gate;return storage.list(options);}};
  const started=await post(owner,b,{action:'run'});
  check([started.status,started.cache,Object.keys(started.body)],[202,'no-store',['runId']],'Run now answers 202 with the run id');
  await inside;
  const [row]=await runs();
  check([row.id,row.status,row.trigger,row.requested_by],[started.body.runId,'running','manual','owner@maintenance.test'],'a manual row with the account label');
  check(maintenance.maintenanceRunAuditAction,'Maintenance run started','the exported audit action');
  check(await runAudits(),[{actor:'owner@maintenance.test',action:'Maintenance run started',target:`Run now, trigger manual, run ${started.body.runId}`,scope:'portal',server_id:null,customer_id:null}],'Run now writes exactly one portal audit row with the actor, the trigger and the run id');
  check((await get(owner,b)).body.status.running,true,'GET reports the running run');
  const second=await post(owner,b,{action:'run'});
  check([second.status,second.body.code,second.body.error],[409,'MAINTENANCE_RUNNING',text('MAINTENANCE_RUNNING')],'a second run while the lock is held gives 409');
  check((await runs()).length,1,'and writes no row');
  check((await runAudits()).length,1,'and no audit row');
  release();
  await maintenance.settledMaintenanceRuns();
  runtime.BUCKET=storage;
  const [done]=await runs();
  check(done.status,'succeeded','the run finished after the reply');
  const result=JSON.parse(done.result);
  check(result.retention,{auditDays:10,jobDays:30,softwareDays:365,alertDays:90},'the saved retention applies to the next run (software changes: no stored value, 365 days)');
  check((await d.query(sql`SELECT at FROM audit WHERE actor='tester' ORDER BY at`)).map(entry=>Math.round((now-entry.at)/day)),[9],'rows older than 10 days are gone, the row of 9 days stays');
  const view=await get(owner,b);
  check([view.body.status.running,view.body.status.lastRun.status,view.body.status.lastRun.requestedBy,view.body.history[0].result.usageReport],[false,'succeeded','owner@maintenance.test',{status:'disabled'}],'the history shows the finished run');
  check((await d.one(sql`SELECT holder FROM maintenance_lock`)).holder,null,'the lock is cleared');

  // A pending migration: 409 and no row.
  const last=await d.one(sql`SELECT name,checksum,applied_at FROM _serverdesk_migrations ORDER BY name DESC LIMIT 1`);
  await d.exec(sql`DELETE FROM _serverdesk_migrations WHERE name=${last.name}`);
  const pending=await post(owner,b,{action:'run'});
  check([pending.status,pending.body.code],[409,'MAINTENANCE_MIGRATIONS_PENDING'],'a pending migration gives 409');
  check((await runs()).length,1,'and writes no row');
  check((await runAudits()).length,1,'and no audit row');
  await d.exec(sql`INSERT INTO _serverdesk_migrations(name,checksum,applied_at) VALUES(${last.name},${last.checksum},${last.applied_at})`);

  // The usage report error leaves the server only as its code; customer passes carry the name.
  await d.exec(enableMultipleCustomers());
  await d.exec(sql`INSERT INTO customers(id,name,status,created_at,updated_at,audit_retention_days) VALUES('00000000-0000-4000-8000-0000000000a1','Kunde A','active',1,1,7)`);
  await d.exec(sql`INSERT INTO maintenance_runs(started_at,finished_at,status,trigger,result) VALUES(${Date.now()},${Date.now()+1},'succeeded','schedule',${JSON.stringify({retention:{auditDays:10,jobDays:30},audit:{deleted:0,more:false},customerAudit:[{customerId:'00000000-0000-4000-8000-0000000000a1',auditDays:7,deleted:2,more:false},{customerId:'00000000-0000-4000-8000-0000000000b2',auditDays:9,deleted:0,more:false}],jobs:{deleted:0,more:false},jobOutputs:{deleted:0,more:false},transfers:{cleared:0,failed:0,more:false},usageReport:{status:'failed',error:'https://license.example/secret path'}})})`);
  const latest=(await get(owner,b)).body.history[0].result;
  check(latest.usageReport,{status:'failed',error:'internal'},'only an error code leaves the server');
  check(latest.customerAudit.map(pass=>pass.customerName),['Kunde A',null],'customer passes carry the customer name');
 }

 // ---- GET: the error of a run leaves the server only as a reason key -----------------
 {
  const b=await browser(owner,{proof:false}),base=Date.now()+60_000,raw='connect ECONNREFUSED 10.0.0.5:5432 relation "x"';
  const stored=[
   ['serverMessage.maintenance.lockLost','serverMessage.maintenance.lockLost'],
   ['Maintenance stopped because another instance took over the lock.','serverMessage.maintenance.lockLost'],
   ['The run stopped before it finished. The lock expired and another run took over.','serverMessage.maintenance.lockExpired'],
   ['3 transfers could not be cleared. Check the file storage and run maintenance again.','serverMessage.maintenance.transfersFailed'],
   ['JOB_RETENTION_DAYS: enter a whole number of days from 1 to 3650.','serverMessage.maintenance.retentionInvalid'],
   [raw,'serverMessage.maintenance.internal'],
   ['serverMessage.maintenance.unknown','serverMessage.maintenance.internal'],
   ['--audit-days: enter a whole number of days from 1 to 3650.','serverMessage.maintenance.internal'],
  ];
  for(const [index,[error]] of stored.entries())await d.exec(sql`INSERT INTO maintenance_runs(started_at,finished_at,status,trigger,error) VALUES(${base+index},${base+index+1},'failed','schedule',${error})`);
  const result=await get(owner,b),newest=result.body.history.slice(0,stored.length).reverse();
  check(newest.map(run=>run.error),stored.map(([,key])=>key),'each stored value maps to its key: keys stay, old texts by their exact form, everything else internal');
  check(result.body.status.lastRun.error,'serverMessage.maintenance.internal','lastRun carries the key too');
  check(result.body.history.every(run=>run.error===null||/^serverMessage\.maintenance\.(retentionInvalid|lockLost|lockExpired|transfersFailed|internal)$/.test(run.error)),true,'every error is one of the five keys or null');
  const body=JSON.stringify(result.body);
  check([raw,'ECONNREFUSED','enter a whole number','could not be cleared','took over the lock'].filter(part=>body.includes(part)),[],'no raw stored text in the GET body');
 }
 // ---- A deleted customer: its audit rows follow the instance retention ----------------
 {
  const now=Date.now(),removedIds=[crypto.randomUUID(),crypto.randomUUID()];
  // One customer without and one with its own retention: once deleted, both use the instance retention.
  for(const [id,days] of [[removedIds[0],null],[removedIds[1],3650]])await insert('customers',{id,name:'Gelöscht '+id.slice(0,4),created_at:now,updated_at:now,audit_retention_days:days});
  const row=(customer,at)=>d.one(sql`INSERT INTO audit(at,actor,action,target,scope,customer_id) VALUES(${at},'fixture','Kunde angelegt','Gelöscht','portal',${customer}) RETURNING id`).then(entry=>Number(entry.id));
  const old=[await row(removedIds[0],now-60*day),await row(removedIds[1],now-60*day)],recent=[await row(removedIds[0],now-day),await row(removedIds[1],now-day)];
  for(const id of removedIds)await d.exec(sql`DELETE FROM customers WHERE id=${id}`);
  const result=await runMaintenance(d,storage,{retention:{auditDays:30,jobDays:3650},now});
  const left=async ids=>(await d.query(sql`SELECT id FROM audit WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids.map(String))}::jsonb)::bigint)`)).length;
  check([await left(old),await left(recent)],[0,2],'the old rows of the deleted customers are purged at 30 days, the recent ones stay');
  check(result.customerAudit.some(pass=>removedIds.includes(pass.customerId)),false,'a deleted customer has no pass of its own retention');
  check(result.audit.deleted>=2,true,'the instance pass counts their rows');
 }
 console.log(`PASS ${checks} maintenance settings checks: Owner only, validation codes, GET shape, step-up, one commit with audit, conflicts, Run now 202 with its audit row, held lock, pending migration, retention at the next run, run errors only as reason keys, size facts from the catalog with null on failure, the environment-only and customer retention, and the audit rows of deleted customers under the instance retention.`);
}finally{
 await d.close();
 await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
