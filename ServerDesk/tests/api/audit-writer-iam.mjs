// Audit writer and IAM audit in the batch: auditEvent() in lib/server/audit.ts,
// commitWithAudit on top of it, manageRbac, the access route, disable-user and
// device removal, against the real modules on an isolated PostgreSQL test
// database, and the customer and installer entries of
// lib/server/identity/customer-admin.ts and lib/server/agent/customer-installers.ts in
// the same batch, with their customer retention. A second customer switches the
// customer boundary on. failure() in the server stub is built from the real
// lib/server/errors/failure.ts. log() throws, so a converted writer that still used it
// would fail here. A one-shot hook runs right before the next batch.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,sourceActor,insertRow,idents,createTrigger,dropTrigger,dbModule} from '../support/source-database.mjs';
import {compile,sql,SqlFragment} from '../../runtime/database.mjs';
import {runMaintenance} from '../../scripts/selfhost.mjs';

import {hookDatabase} from '../support/hooked-database.mjs';
import {enableMultipleCustomers,separateCustomers} from '../support/customer-separation.mjs';
const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const day=86_400_000,uuid=()=>crypto.randomUUID(),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 const customerA='00000000-0000-4000-8000-000000000100';
 const HttpError=realHttpError;
 const load=sourceLoader();
 const {classifyFailure}=load('lib/server/errors/failure.ts');
 // Every batch is recorded (its SQL texts); the hook runs once before the next one.
 let viewer=null,beforeBatch=null;const batches=[];
 const facade=hookDatabase(d,{transaction:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}},record:batches});
 const server={db:()=>facade,now:()=>Date.now(),config:key=>key==='SITE_ORIGIN'?'https://audit.test':'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:request=>request.json(),sameOrigin:()=>{},
  requireViewer:async()=>{if(!viewer)throw new HttpError(401,'Bitte anmelden.');return viewer;},
  log:async()=>{throw new Error('log() must not be used by the converted writers');},
  // As lib/server/context.ts failure(): an HttpError as thrown, everything else through the real classifyFailure.
  failure:error=>{const answer=error instanceof HttpError?{status:error.status,body:{error:error.message,...(error.code?{code:error.code}:{})}}:classifyFailure(error);return Response.json(answer.body,{status:answer.status,headers:{'Cache-Control':'no-store'}});}};
 // Routine writes (lib/step-up.ts) commit behind the live-session fence.
 const mfa={requireLiveSessions:async()=>{},mfaSessionFence:async(request,actor)=>localAuth.primaryGuard(request,actor),isMfaEnabled:async()=>true,requireMfa:async()=>{},readMfaManagementProof:async(_request,actor,token)=>({tokenHash:token,key:actor.principal,sessionHash:sha(actor.id+'mfa'),guard:sql`TRUE`}),
  clearMfaSessionCookie:()=>'mfa=; Max-Age=0',clearMfaTrustCookie:()=>'trust=; Max-Age=0'};
 const localAuth={primaryGuard:async(_request,actor)=>load('lib/server/identity/access.ts').viewerWriteGuard(actor),clearLocalAuthCookie:()=>'auth=; Max-Age=0',
  rateLimit:async()=>{},username:value=>value,hashNewPassword:async value=>'hashed:'+value,userViewer:async user=>({id:user.id}),
  revocationStatements:(user,guard=sql`TRUE`)=>[sql`DELETE FROM local_auth_sessions WHERE user_id=${user.id} AND (${guard})`]};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./mfa':mfa,'@/lib/server/identity/mfa':mfa,'./local-auth':localAuth,'@/lib/server/identity/local-auth':localAuth,'@/lib/server/identity/passwords':{verifyPassword:async()=>false},'./transfers':{clearTransfer:async()=>{}}};
 const access=load('lib/server/identity/access.ts',imports);
 const audit=load('lib/server/audit.ts',imports),commit=load('lib/server/security-commit.ts',imports),rbac=load('lib/server/identity/rbac.ts',imports);
 const lifecycle=load('lib/server/devices/device-lifecycle.ts',imports);
 const customerAdmin=load('lib/server/identity/customer-admin.ts',imports),technicians=load('lib/server/identity/customer-technicians.ts',imports),installers=load('lib/server/agent/customer-installers.ts',imports);
 const customersApi=load('app/api/customers/route.ts',imports);
 // The request of a write behind the session fence; the mfa fixture reads no cookie from it.
 const sessionRequest=()=>new Request('https://audit.test/api/customers',{method:'POST'});
 const rbacApi=load('app/api/rbac/route.ts',imports),accessApi=load('app/api/access/route.ts',imports),authApi=load('app/api/auth/route.ts',imports);

 // ---- Fixture ----------------------------------------------------------------------
 const time=Date.now();
 const insert=(table,row)=>insertRow(d,table,row);
 const one=statement=>d.one(statement);
 const count=async(sql,...bindings)=>Number((await one(sql,...bindings)).n);
 const builtin={owner:'builtin-owner',reader:'builtin-reader'};
 for(const [id,name,permissions] of [[builtin.owner,'Owner',['*']],[builtin.reader,'Reader',access.rolePermissions.viewer]])await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:1,created_at:time});
 const actor=async(label,permissions)=>{const {actor:value,assignmentId}=await sourceActor(d,label,permissions);value.userId=value.id;
  await d.exec(sql`UPDATE local_users SET password_hash='fixture-password' WHERE id=${value.id}`);
  await insert('mfa_sessions',{token_hash:sha(value.id+'mfa'),principal:value.principal,created_at:time,last_activity:time,idle_expires_at:time+30*day,expires_at:time+30*day});
  return Object.assign(value,{assignmentId});};
 const owner=await actor('owner@audit.test',['*']);owner.roleId=(await one(sql`SELECT role_id FROM role_assignments WHERE id=${owner.assignmentId}`)).role_id;
 // A user administrator without '*': its right can be taken away between check and commit.
 const admin=await actor('uaa@audit.test',['portal.userGroups.manage','portal.roles.manage','portal.roleAssignments.manage','portal.users.manage','groups.manage'],'operator');
 const restoreAdmin=()=>insert('role_assignments',{id:admin.assignmentId,principal_type:'user',principal_id:admin.id,role_id:(admin.roleId),scope_type:'global',scope_id:'*',created_at:time,created_by:'fixture'});
 admin.roleId=(await one(sql`SELECT role_id FROM role_assignments WHERE id=${admin.assignmentId}`)).role_id;
 // A technician of the first customer, so it sees that customer's device groups once a second customer exists.
 await insert('customer_assignments',{customer_id:customerA,principal_type:'user',principal_id:admin.id,created_at:time,created_by:owner.principal});
 const revokeAdmin=()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${admin.assignmentId}`);
 const user=async(status='active')=>{const id=uuid();await insert('local_users',{id,username:'u'+id.slice(0,8)+id.slice(-4),email:'',display_name:'Konto '+id.slice(0,8),auth_principal:'local:'+id,auth_email:id+'@local.serverdesk.invalid',status,password_hash:status==='active'?'fixture-password':null,auth_version:1,must_reset:0,created_at:time,updated_at:time});return id;};
 const link=async(userId,usedAt=null)=>{const token='link-'+uuid();await insert('local_account_tokens',{token_hash:token,user_id:userId,kind:'reset',created_at:time,expires_at:time+3_600_000,auth_version:1,used_at:usedAt});return token;};
 const assignRole=async(type,subject,role,scopeType='global',scopeId='*')=>{const id=uuid();await insert('role_assignments',{id,principal_type:type,principal_id:subject,role_id:role,scope_type:scopeType,scope_id:scopeId,created_at:time,created_by:'fixture'});return id;};
 const customRole=async permissions=>{const id=uuid();await insert('rbac_roles',{id,name:'Rolle '+id,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});return id;};
 const userGroup=async(enabled=1,role)=>{const id=uuid();await insert('user_groups',{id,name:'Gruppe '+id,description:'',enabled,created_at:time});if(role)await assignRole('group',id,role);return id;};
 const member=(groupId,userId)=>insert('user_group_members',{group_id:groupId,user_id:userId});
 const deviceGroup=async(customer=customerA)=>{const id=uuid();await insert('device_groups',{id,name:'Standort '+id.slice(0,8),description:'',created_at:time,parent_id:null,customer_id:customer});return id;};
 const device=async(customer=customerA,revoked=0)=>{const id=uuid();await insert('servers',{id,name:'Server '+id.slice(0,8),token_hash:'fixture-'+id,created_at:time,last_seen:time,management:1,snapshot:'{}',customer_id:customer,revoked});return id;};
 const token=async(who=owner)=>{const value=uuid();await insert('mfa_management_proofs',{token_hash:value,principal:who.principal,session_hash:sha(who.id+'mfa'),expires_at:Date.now()+300_000});return value;};
 const authorization=async(who=owner,value)=>rbac.prepareManagementAuthorization(new Request('https://audit.test/api'),who,value??await token(who));
 const proofExists=async value=>await count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${value}`)===1;
 const manageWith=async(who,payload,value)=>{viewer=who;return rbac.manageRbac(who,payload,await authorization(who,value));};
 const manage=async(who,payload)=>manageWith(who,payload,await token(who));
 const post=async(api,path,who,payload,value)=>{viewer=who;const response=await api.POST(new Request('https://audit.test'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({managementToken:value??await token(who),...payload})}));return {status:response.status,body:await response.json()};};
 const rejects=async(promise,status,message,label)=>{await assert.rejects(promise,error=>{assert.equal(error.status,status,label+': '+error.message);if(message)assert.equal(error.message,message,label);return true;},label);checks++;};
 const columns='actor,action,target,scope,server_id,customer_id';
 const lastAudit=async()=>Number((await one(sql`SELECT coalesce(max(id),0) AS n FROM audit`)).n);
 const since=async from=>(await d.query(sql`SELECT ${idents(columns)} FROM audit WHERE id>${from} ORDER BY id`)).map(row=>({...row}));
 const row=(who,action,target,customer=null)=>({actor:who.label,action,target,scope:'portal',server_id:null,customer_id:customer});
 // Runs an action and returns its new audit rows and the batches it issued.
 const observe=async run=>{const from=await lastAudit();batches.length=0;const result=await run();return {result,rows:await since(from),batches:batches.map(batch=>[...batch])};};
 const isAudit=sql=>/^INSERT INTO audit\b/.test(sql),isProof=sql=>/^DELETE FROM mfa_management_proofs\b/.test(sql);
 // The audit row is in the committing batch, before the proof is consumed, and no other batch writes audit.
 const sameBatch=(observed,label)=>{
  const auditing=observed.batches.filter(batch=>batch.some(isAudit));
  check(auditing.length,1,label+': exactly one batch writes audit');
  const [batch]=auditing,auditAt=batch.findIndex(isAudit),proofAt=batch.findIndex(isProof);
  check(proofAt>auditAt,true,label+': the audit row comes before the proof is consumed in the same batch');
 };
 // Routine changes (lib/step-up.ts): one batch writes audit, and no batch touches a proof.
 const routineBatch=(observed,label)=>{
  check(observed.batches.filter(batch=>batch.some(isAudit)).length,1,label+': exactly one batch writes audit');
  check(observed.batches.some(batch=>batch.some(isProof)),false,label+': no proof is consumed');
 };
 const auditUnavailable=()=>createTrigger(d,'audit_unavailable','audit','BEFORE INSERT',{message:'audit unavailable'});
 const auditAvailable=()=>dropTrigger(d,'audit_unavailable');
 // Statement texts with their parameter numbers ignored ($1, $2 … become ?).
 const unnumbered=text=>text.replace(/[$][0-9]+/g,"?");
 // Steps (with auditAfterChange) in one transaction, as commitAll runs them.
 const commitSteps=steps=>d.transaction(tx=>dbModule().runSteps(tx,steps));
 const admissionPlan=async text=>{
  const numbers=[...new Set(text.match(/[$][0-9]+/g)??[])],renumbered=text.replace(/[$][0-9]+/g,match=>'$'+(numbers.indexOf(match)+1));
  return d.transaction(async tx=>{
   await tx.exec(sql`SET LOCAL enable_seqscan=off`);await tx.exec(sql`SET LOCAL plan_cache_mode=force_generic_plan`);
   await tx.exec(new SqlFragment(['PREPARE audit_admission AS SELECT 1 AS admitted WHERE '+renumbered],[]));
   const rows=await tx.query(new SqlFragment(['EXPLAIN EXECUTE audit_admission('+numbers.map(()=>'NULL').join(',')+')'],[]));
   await tx.exec(sql`DEALLOCATE audit_admission`);
   return rows.map(row=>row['QUERY PLAN']);
  });
 };
 const snapshotTables=['user_groups','user_group_members','rbac_roles','role_assignments','local_users','local_account_tokens','local_auth_sessions','device_groups','device_group_members','customers','customer_assignments','customer_installers','servers','jobs','audit','mfa_management_proofs'];
 const snapshot=async()=>{const state={};for(const table of snapshotTables)state[table]=(await d.query(sql`SELECT * FROM ${sql.ident(table)}`)).map(entry=>JSON.stringify(entry)).sort();return state;};

 // ---- auditEvent ---------------------------------------------------------------
 {
  const yes=sql`TRUE`,no=sql`FALSE`,serverA=await device(),serverB=await device();
  const portal=audit.auditEvent({actor:'unit',action:'Einheit',target:'portal',guard:yes});
  check(portal.length,1,'portal: one statement');
  check(/^INSERT INTO audit \(at,actor,action,target,server_id,scope,customer_id\) SELECT .* WHERE \(TRUE\)$/.test(compile(portal[0]).text),true,'portal: INSERT … SELECT … WHERE (<guard>)');
  const devices=audit.auditEvent({actor:'unit',action:'Einheit',target:'geräte',serverIds:[serverA,serverB,serverA],guard:sql`${1}=1`});
  check(devices.length,2,'devices: one statement per distinct ID');
  check(audit.auditEvent({actor:'unit',action:'Einheit',target:'leer',serverIds:[],guard:yes}),[],'an empty array gives no statement');
  check(audit.auditEvent({actor:'unit',action:'Einheit',target:'einzeln',serverIds:serverA,guard:yes}).length,1,'a single server ID as a string');
  assert.throws(()=>audit.auditEvent({actor:'unit',action:'Einheit',target:'x',serverIds:[serverA,'kein-guid'],guard:yes}),error=>error.constructor===Error&&error.message==='Ungültige Gerätezuordnung für das Zugriffsprotokoll.','an invalid server ID throws the text of log()');checks++;
  const from=await lastAudit();
  await commitSteps([...portal,...devices,...audit.auditEvent({actor:'unit',action:'Einheit',target:'kunde',customerId:customerA,guard:yes}),...audit.auditEvent({actor:'unit',action:'Einheit',target:'nein',guard:no})]);
  const written=await since(from);
  check(written.map(entry=>[entry.target,entry.scope,entry.server_id,entry.customer_id]),[['portal','portal',null,null],['geräte','device',serverA,customerA],['geräte','device',serverB,customerA],['kunde','portal',null,customerA]],'columns; device rows get their customer from the trigger; a false guard writes nothing');
  const ats=await d.query(sql`SELECT DISTINCT at FROM audit WHERE id>${from} AND target='geräte'`).then(results=>({results}));
  check(ats.results.length,1,'all rows of one call share at');
  await assert.rejects(commitSteps(audit.auditEvent({actor:'unit',action:'Einheit',target:'fremd',customerId:uuid(),guard:yes})),/customer-missing/,'an unknown customer is refused by the trigger');checks++;
  // auditAfterChange: no row after an UPDATE of 0 rows, one after an UPDATE of 1 row.
  const marker=uuid();await insert('identity_settings',{key:'unit-'+marker,value:'0'});
  const after=await lastAudit();
  await commitSteps([sql`UPDATE identity_settings SET value=${'1'} WHERE key=${'nicht-vorhanden'}`,...audit.auditEvent({actor:'unit',action:'Nach Änderung',target:'0',guard:audit.auditAfterChange})]);
  await commitSteps([sql`UPDATE identity_settings SET value=${'1'} WHERE key=${'unit-'+marker}`,...audit.auditEvent({actor:'unit',action:'Nach Änderung',target:'1',guard:audit.auditAfterChange})]);
  check((await since(after)).map(entry=>entry.target),['1'],'auditAfterChange writes only after a changing statement');
  check(audit.auditEvent({actor:'unit',action:'Nach Änderung',target:'x',guard:audit.auditAfterChange}).map(step=>Object.keys(step)),[['afterChange']],'auditAfterChange makes a step that runs only after a change');
  const source=readFileSync('lib/server/audit.ts','utf8');
  check(/\b(?:db|commitAll|runSteps)\(|\.(?:query|one|exec|transaction)\(/.test(source),false,'lib/server/audit.ts runs no statement');
  // The removed counter call, built from parts so the scan of tests/repo/legacy-cleanup.mjs skips this file.
  const counter=['changes','()'].join('');
  check(source.includes(counter),false,'lib/server/audit.ts has no row counter condition');
  check(/\bcatch\b/.test(source),false,'lib/server/audit.ts catches no error');
  check(/directly follows the effect/i.test(source)||/Only valid when the audit statement directly follows/i.test(source),true,'the rule for auditAfterChange is written down');
 }

 // ---- commitWithAudit ------------------------------------------------------------
 {
  const mark=key=>sql`INSERT INTO identity_settings(key,value) VALUES(${key},${'1'})`;
  const from=await lastAudit(),key='commit-'+uuid();
  const done=await commit.commitWithAudit([mark(key)],{audit:{actor:'unit',action:'Mit Kunde',target:'k',customerId:customerA},guard:sql`TRUE`});
  check([done.audited,done.results.length],[true,1],'audited and the results without the audit row');
  check(await since(from),[{actor:'unit',action:'Mit Kunde',target:'k',scope:'portal',server_id:null,customer_id:customerA}],'customerId becomes customer_id');
  const plain=await commit.commitWithAudit([mark(key+'-2'),mark(key+'-3')],{audit:{actor:'unit',action:'Ohne Kunde',target:'p'},guard:sql`FALSE`,at:1});
  check([plain.audited,plain.results.length],[false,2],'a false guard: not audited, caller indexes kept');
  check((await since(from)).length,1,'no row for the false guard');
  check(audit.auditEvent.length,1,'auditEvent takes one object');
  check(readFileSync('lib/server/security-commit.ts','utf8').includes('auditEvent('),true,'security-commit builds on auditEvent');
 }

 // ---- A second customer: the customer boundary applies ---------------------------------
 await d.exec(enableMultipleCustomers());await d.exec(separateCustomers(Date.now()));

 // ---- manageRbac --------------------------------------------------------------
 {
  const label=owner.label,target=await user(),groupName='Team '+uuid().slice(0,8);
  const expectOne=async(payload,action,targetText,name)=>{const observed=await observe(()=>manage(owner,payload));check(observed.rows,[row(owner,action,targetText)],name+': one row');sameBatch(observed,name);return observed.result;};
  const created=await expectOne({action:'create-group',name:groupName},'Benutzergruppe erstellt',groupName,'create-group');
  const renamed=groupName+' neu';
  await expectOne({action:'update-group',id:created.id,name:renamed,description:'',enabled:true},'Benutzergruppe geändert',renamed,'update-group');
  await expectOne({action:'add-member',groupId:created.id,userId:target},'Benutzergruppenmitglied hinzugefügt',target+' / '+renamed,'add-member');
  const repeat=await observe(()=>manage(owner,{action:'add-member',groupId:created.id,userId:target}));
  check([repeat.result,repeat.rows],[{ok:true},[]],'add-member of an existing member writes no row');
  await expectOne({action:'remove-member',groupId:created.id,userId:target},'Benutzergruppenmitglied entfernt',target+' / '+renamed,'remove-member');
  // delete-group removes its assignments and members in the same batch.
  await member(created.id,target);const groupAssignment=await assignRole('group',created.id,builtin.reader);
  const deleted=await observe(()=>manage(owner,{action:'delete-group',id:created.id}));
  check(deleted.rows,[row(owner,'Benutzergruppe gelöscht',renamed)],'delete-group: one row');sameBatch(deleted,'delete-group');
  check(deleted.batches.length>=1&&deleted.batches[0].some(sql=>/^DELETE FROM role_assignments WHERE principal_type='group'/.test(sql))&&deleted.batches[0].some(sql=>/^DELETE FROM user_group_members WHERE group_id=/.test(sql)),true,'delete-group: the cleanup is in the committing batch');
  check(deleted.batches.filter(batch=>batch.some(sql=>/role_assignments|user_group_members/.test(sql)&&/^DELETE/.test(sql))).length,1,'delete-group: no second cleanup batch');
  check([await count(sql`SELECT count(*) AS n FROM role_assignments WHERE id=${groupAssignment}`),await count(sql`SELECT count(*) AS n FROM user_group_members WHERE group_id=${created.id}`)],[0,0],'delete-group: assignments and members are gone');
  const roleName='Rolle '+uuid().slice(0,8);
  const role=await expectOne({action:'create-role',name:roleName,permissions:['view']},'Benutzerdefinierte Rolle erstellt',roleName,'create-role');
  const roleRenamed=roleName+' neu';
  await expectOne({action:'update-role',id:role.id,name:roleRenamed,description:'',permissions:['view','terminal']},'Benutzerdefinierte Rolle geändert',roleRenamed,'update-role');
  const assignment={action:'add-assignment',subjectType:'user',subjectId:target,roleId:role.id,scopeType:'global',scopeId:'*'};
  const assigned=await expectOne(assignment,'Rollenzuweisung erstellt',`user:${target} / ${roleRenamed} / global:*`,'add-assignment');
  const again=await observe(()=>manage(owner,assignment));
  check([again.result,again.rows],[{ok:true,id:assigned.id},[]],'an identical add-assignment returns the existing id and writes no row');
  await expectOne({action:'delete-assignment',id:assigned.id},'Rollenzuweisung entfernt',assigned.id,'delete-assignment');
  await expectOne({action:'delete-role',id:role.id},'Benutzerdefinierte Rolle gelöscht',roleRenamed,'delete-role');
  check(label,owner.label,'actor label');

  // A refused commit writes no row: the hook takes the administrator's right away.
  // Role catalogs are Owner-only once a second customer exists, so role actions run as the Owner and lose '*'.
  const revokeOwner=()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${owner.assignmentId}`);
  const restoreOwner=()=>insert('role_assignments',{id:owner.assignmentId,principal_type:'user',principal_id:owner.id,role_id:owner.roleId,scope_type:'global',scope_id:'*',created_at:time,created_by:'fixture'});
  const refused=async(payload,status,name,extra=async()=>{},asOwner=false)=>{
   const from=await lastAudit();beforeBatch=asOwner?revokeOwner:revokeAdmin;
   try{await rejects(manage(asOwner?owner:admin,payload),status,undefined,name);}finally{const pending=beforeBatch;beforeBatch=null;check(pending,null,name+': the hook ran before the commit');}
   check(await since(from),[],name+': no row');
   await extra();await (asOwner?restoreOwner:restoreAdmin)();
  };
  await refused({action:'create-group',name:'Abgelehnt '+uuid().slice(0,8)},403,'refused create-group');
  const keep=await userGroup(1),keeper=await user();await member(keep,keeper);const keepAssignment=await assignRole('group',keep,builtin.reader);
  await refused({action:'update-group',id:keep,name:'Abgelehnt',description:'',enabled:true},403,'refused update-group');
  await refused({action:'add-member',groupId:keep,userId:await user()},403,'refused add-member');
  await refused({action:'remove-member',groupId:keep,userId:keeper},403,'refused remove-member');
  await refused({action:'delete-group',id:keep},403,'refused delete-group',async()=>{
   check([await count(sql`SELECT count(*) AS n FROM user_groups WHERE id=${keep}`),await count(sql`SELECT count(*) AS n FROM user_group_members WHERE group_id=${keep}`),await count(sql`SELECT count(*) AS n FROM role_assignments WHERE id=${keepAssignment}`)],[1,1,1],'refused delete-group: group, members and assignments stay');});
  await refused({action:'create-role',name:'Abgelehnt '+uuid().slice(0,8),permissions:['view']},403,'refused create-role',async()=>{},true);
  const plainRole=await customRole(['view']);
  await refused({action:'update-role',id:plainRole,name:'Abgelehnt',description:'',permissions:['view','terminal']},403,'refused update-role',async()=>{},true);
  await refused({action:'add-assignment',subjectType:'user',subjectId:keeper,roleId:plainRole,scopeType:'global',scopeId:'*'},403,'refused add-assignment');
  const removable=await assignRole('user',keeper,plainRole);
  await refused({action:'delete-assignment',id:removable},409,'refused delete-assignment');
  const deletable=await customRole(['view']);
  await refused({action:'delete-role',id:deletable},403,'refused delete-role',async()=>{},true);
 }

 // ---- Voided account links ------------------------------------------------------------
 {
  const voided='Konto-Links wegen Rechteanstieg verfallen';
  const open=userId=>count(sql`SELECT count(*) AS n FROM local_account_tokens WHERE user_id=${userId} AND used_at IS NULL`);
  const linked=async()=>{const id=await user();await link(id);return id;};
  const bystander=await linked();
  const voidRows=rows=>rows.filter(entry=>entry.action===voided);
  const assignment=(subjectType,subjectId,roleId,scopeType='global',scopeId='*')=>({action:'add-assignment',subjectType,subjectId,roleId,scopeType,scopeId});
  // Owner to a user.
  {const target=await linked(),observed=await observe(()=>manage(owner,assignment('user',target,builtin.owner)));
   check(voidRows(observed.rows),[row(owner,voided,target)],'Owner to a user: one row for the account');check(await open(target),0,'Owner to a user: the link is voided');sameBatch(observed,'Owner to a user');}
  // Owner to a group with two members: two rows.
  {const groupId=await userGroup(1),first=await linked(),second=await linked();await member(groupId,first);await member(groupId,second);
   const observed=await observe(()=>manage(owner,assignment('group',groupId,builtin.owner)));
   check(voidRows(observed.rows).map(entry=>entry.target).sort(),[first,second].sort(),'Owner to a group: one row per member');}
  // add-member to an Owner group.
  {const groupId=await userGroup(1,builtin.owner),target=await linked(),observed=await observe(()=>manage(owner,{action:'add-member',groupId,userId:target}));
   check(voidRows(observed.rows),[row(owner,voided,target)],'add-member to an Owner group');}
  // Enabling an Owner group.
  {const groupId=await userGroup(0,builtin.owner),target=await linked();await member(groupId,target);
   const group=await one(sql`SELECT name FROM user_groups WHERE id=${groupId}`),observed=await observe(()=>manage(owner,{action:'update-group',id:groupId,name:group.name,description:'',enabled:true}));
   check(voidRows(observed.rows),[row(owner,voided,target)],'enabling an Owner group');}
  // A role that becomes privileged.
  {const roleId=await customRole(['view']),target=await linked();await assignRole('user',target,roleId);
   const observed=await observe(()=>manage(owner,{action:'update-role',id:roleId,name:'Rolle '+roleId,description:'',permissions:['view',access.crossCustomerPermission]}));
   check(voidRows(observed.rows),[row(owner,voided,target)],'a role that becomes privileged');}
  // No row: Reader and view assignments, a bystander, links already used, a refused assignment.
  {const target=await linked(),viewRole=await customRole(['view']);
   const reader=await observe(()=>manage(owner,assignment('user',target,builtin.reader)));
   const view=await observe(()=>manage(owner,assignment('user',target,viewRole)));
   check([voidRows(reader.rows),voidRows(view.rows),await open(target)],[[],[],1],'Reader and view assignments void nothing and log nothing');
   const used=await user();await link(used,time-5);
   const usedRun=await observe(()=>manage(owner,assignment('user',used,builtin.owner)));
   check(voidRows(usedRun.rows),[],'an account whose links were already used gets no row');
   const refusedTarget=await linked(),from=await lastAudit();
   await rejects(manage(admin,assignment('user',refusedTarget,builtin.owner)),403,rbac.privilegedRoleOwnerOnlyMessage,'a non-Owner assigning Owner with several customers');
   check([await since(from),await open(refusedTarget)],[[],1],'the refused assignment: no row, the link stays');
   check(await count(sql`SELECT count(*) AS n FROM audit WHERE action=${voided} AND target=${bystander}`),0,'the bystander never gets a row');
   check(await open(bystander),1,'the bystander keeps its link');}
 }

 // ---- Access route ------------------------------------------------------------------
 {
  const name='Gerätegruppe '+uuid().slice(0,8);
  // Routine: a supplied token is ignored and stays.
  const createToken=await token(),created=await observe(()=>post(accessApi,'/api/access',owner,{action:'create-group',name,description:''},createToken));
  check([created.result.status,created.rows],[200,[row(owner,'Gerätegruppe erstellt',name)]],'access create-group: one row');routineBatch(created,'access create-group');check(await proofExists(createToken),true,'access create-group: the token stays');
  const groupId=created.result.body.id,renamed=name+' neu';
  const updateToken=await token(),updated=await observe(()=>post(accessApi,'/api/access',owner,{action:'update-group',id:groupId,name:renamed,description:''},updateToken));
  check([updated.result.status,updated.rows],[200,[row(owner,'Gerätegruppe geändert',renamed)]],'access update-group: one row');routineBatch(updated,'access update-group');check(await proofExists(updateToken),true,'access update-group: the token stays');
  const grantee=await user(),grantRole=await customRole(['view']),grant=await assignRole('user',grantee,grantRole,'devicegroup',groupId);
  const removed=await observe(()=>post(accessApi,'/api/access',owner,{action:'delete-grant',id:grant}));
  check([removed.result.status,removed.rows],[200,[row(owner,'Gerätegruppenfreigabe entfernt',grant)]],'access delete-grant: one row');sameBatch(removed,'access delete-grant');
  // A refused commit writes no row.
  for(const [label,payload] of [['create-group',{action:'create-group',name:'Abgelehnt',description:''}],['update-group',{action:'update-group',id:groupId,name:'Abgelehnt',description:''}],['delete-grant',{action:'delete-grant',id:await assignRole('user',grantee,grantRole,'devicegroup',await deviceGroup())}]]){
   const from=await lastAudit();beforeBatch=revokeAdmin;
   const answer=await post(accessApi,'/api/access',admin,payload),pending=beforeBatch;beforeBatch=null;
   check([answer.status,pending,await since(from)],[403,null,[]],'access '+label+' refused: 403 and no row');await restoreAdmin();
  }
  // deleteDeviceGroup: its admission row through auditEvent, first in the batch, then the cleanup it admits.
  const member=await device();await insert('device_group_members',{server_id:member,group_id:groupId});
  const removedGroup=await observe(()=>post(accessApi,'/api/access',owner,{action:'delete-group',id:groupId,confirm:true}));
  check([removedGroup.result.status,removedGroup.rows.length,removedGroup.rows[0]?.action,removedGroup.rows[0]?.target.startsWith(`${renamed} / ${groupId} / `)],[200,1,'Gerätegruppe gelöscht',true],'deleteDeviceGroup: one row with the receipt');
  sameBatch(removedGroup,'deleteDeviceGroup');check(removedGroup.batches.find(batch=>batch.some(isAudit)).findIndex(isAudit),0,'deleteDeviceGroup: the admission row runs first');
  check([await count(sql`SELECT count(*) AS n FROM device_groups WHERE id=${groupId}`),await count(sql`SELECT count(*) AS n FROM device_group_members WHERE group_id=${groupId}`)],[0,0],'deleteDeviceGroup: group and members are gone');
  // Every admitted statement finds its receipt row through idx_audit_at,
  // never by scanning audit inside the write transaction.
  // EXPLAIN runs on the admission check itself as a plain read: an EXPLAIN of a
  // write statement leaves the local driver with a statement in progress.
  const admissions=removedGroup.batches.find(batch=>batch.some(isAudit)).flatMap(sql=>sql.match(/EXISTS \(SELECT 1 FROM audit WHERE [^)]*\)/g)??[]);
  check([admissions.length>=10,new Set(admissions.map(unnumbered)).size],[true,1],'deleteDeviceGroup: every cleanup statement carries the same admission check');
  // A generic plan of the admission check (its parameters renumbered from $1),
  // with sequential scans forbidden: it must find the receipt row through idx_audit_at.
  const plan=await admissionPlan(admissions[0]);
  check([plan.length>0,/idx_audit_at/.test(plan.join(' ')),plan.some(line=>/Seq Scan on audit\b/.test(line))],[true,true,false],'deleteDeviceGroup admission uses idx_audit_at, no scan of audit: '+plan.join(' | '));
  const source=readFileSync('app/api/access/route.ts','utf8');
  check(/\blog\b/.test(source.split('\n')[0]),false,'the access route does not import log');
  // The route's write code lives in lib/server/identity/access-admin.ts.
  check(readFileSync('lib/server/identity/access-admin.ts','utf8').includes("commitWithAudit(statements,{audit:{actor:v.label,action:'Gerätegruppenrechte geändert'"),true,'set-grant stays on commitWithAudit');
 }

 // ---- deleteDeviceGroup removes orphaned compat roles --------------------------
 {
  const groupG=await deviceGroup(),groupH=await deviceGroup(),u1=await user(),u2=await user(),u3=await user(),compat=(userId,groupId)=>'compat-grant:'+userId+':'+groupId;
  for(const [groupId,userId] of [[groupG,u1],[groupG,u2],[groupH,u1]]){
   const granted=await post(accessApi,'/api/access',owner,{action:'set-grant',groupId,principal:'local:'+userId,role:'viewer',permissions:['view']});
   check(granted.status,200,'compat roles: set-grant '+userId+' on '+groupId);
  }
  // compat-grant:<u2>:<G> is also assigned at a second scope, so it stays in use.
  const elsewhere=await device();await assignRole('user',u2,compat(u2,groupG),'device',elsewhere);
  const custom=await customRole(['view']);
  const role=(id,builtinFlag=0)=>insert('rbac_roles',{id,name:'Rolle '+id,description:'',permissions:JSON.stringify(['view']),builtin:builtinFlag,created_at:time});
  // An orphan of G, and ids that only look like G's: another group id ending in G, a user part with ':', a built-in role.
  const orphan=compat(u3,groupG),lookalikes=[compat(u1,'x'+groupG),'compat-grant:'+u1+':y:'+groupG,'compat-grant::'+groupG,'compat-grant:'+groupG,'xcompat-grant:'+u1+':'+groupG];
  await role(orphan);for(const id of lookalikes)await role(id);
  const builtinLookalike=compat(uuid(),groupG);await role(builtinLookalike,1);
  const roleExists=async id=>await count(sql`SELECT count(*) AS n FROM rbac_roles WHERE id=${id}`)===1;
  const roleState=async()=>Promise.all([compat(u1,groupG),compat(u2,groupG),compat(u1,groupH),orphan,custom,builtinLookalike,...lookalikes].map(roleExists));
  check(await roleState(),Array(11).fill(true),'compat roles: fixture');
  // A refused delete (expired proof) removes no role and answers as before.
  const expired=await token();await d.exec(sql`UPDATE mfa_management_proofs SET expires_at=${Date.now()-1000} WHERE token_hash=${expired}`);
  const before=await lastAudit(),refused=await post(accessApi,'/api/access',owner,{action:'delete-group',id:groupG,confirm:true},expired);
  check([refused.status,refused.body.code,await since(before)],[403,'MFA_STEP_UP_REQUIRED',[]],'compat roles: an expired proof is refused without a row');
  check([await roleState(),await count(sql`SELECT count(*) AS n FROM device_groups WHERE id=${groupG}`)],[Array(11).fill(true),1],'compat roles: a refused delete removes no role');
  const removedG=await observe(()=>post(accessApi,'/api/access',owner,{action:'delete-group',id:groupG,confirm:true}));
  check([removedG.result.status,removedG.rows.map(entry=>entry.action)],[200,['Gerätegruppe gelöscht']],'compat roles: one audit row');
  check(await roleState(),[false,true,true,false,true,true,...lookalikes.map(()=>true)],'compat roles: only the unassigned compat roles of G are gone');
  check(await count(sql`SELECT count(*) AS n FROM role_assignments WHERE role_id=${compat(u2,groupG)}`),1,'compat roles: the second scope keeps its assignment');
  const admissions=removedG.batches.find(batch=>batch.some(isAudit)).flatMap(sql=>sql.match(/EXISTS \(SELECT 1 FROM audit WHERE [^)]*\)/g)??[]);
  const roleCleanup=removedG.batches.find(batch=>batch.some(isAudit)).filter(sql=>/^DELETE FROM rbac_roles\b/.test(sql));
  check([roleCleanup.length,new Set(admissions.map(unnumbered)).size,roleCleanup.every(sql=>unnumbered(sql).includes(unnumbered(admissions[0])))],[1,1,true],'compat roles: the role cleanup carries the same admission');
  check(/\bLIKE\b/i.test(roleCleanup[0]),false,'compat roles: the id is compared literally');
 }

 // ---- disable-user ------------------------------------------------------------------
 {
  const disables=userId=>count(sql`SELECT count(*) AS n FROM audit WHERE action='auth.user.disable' AND actor=${owner.label} AND target=${userId}`);
  // Someone else disables the target between the pre-check and the commit, to exactly the target state.
  const raced=await user();
  beforeBatch=()=>d.exec(sql`UPDATE local_users SET status='disabled',auth_version=auth_version+1 WHERE id=${raced}`);
  const answer=await post(authApi,'/api/auth',owner,{action:'disable-user',userId:raced,disabled:true});
  check([answer.status,answer.body.code,beforeBatch],[409,'AUTH_STATE_CHANGED',null],'race: the request is refused');
  check(await disables(raced),0,'race: no auth.user.disable row under the actor');
  const control=await user(),observed=await observe(()=>post(authApi,'/api/auth',owner,{action:'disable-user',userId:control,disabled:true}));
  check(observed.result.status,200,'control: disabled');
  check(observed.rows.filter(entry=>entry.action==='auth.user.disable'),[row(owner,'auth.user.disable',control)],'control: exactly one row');
  const enabled=await observe(()=>post(authApi,'/api/auth',owner,{action:'disable-user',userId:control,disabled:false}));
  check(enabled.rows.filter(entry=>entry.action==='auth.user.enable'),[row(owner,'auth.user.enable',control)],'enable: exactly one row');
  // A disable-user that would not change the account has no effect.
  // A strict proof reader for this block: like lib/server/identity/mfa.ts, a missing or expired
  // proof is refused before the commit, and proof.sql checks it again in the commit.
  const lenient={read:mfa.readMfaManagementProof};
  mfa.readMfaManagementProof=async(_request,who,value)=>{
   const proofRow=await one(sql`SELECT 1 AS live FROM mfa_management_proofs WHERE token_hash=${String(value)} AND principal=${who.principal} AND expires_at>${Date.now()}`);
   if(!proofRow)throw new HttpError(403,'Die Bestätigung ist abgelaufen oder bereits verwendet. Bitte die Identität erneut bestätigen.','MFA_STEP_UP_REQUIRED');
   const sessionHash=sha(who.id+'mfa');
   return {tokenHash:value,key:who.principal,sessionHash,guard:sql`EXISTS (SELECT 1 FROM mfa_management_proofs live WHERE live.token_hash=${String(value)} AND live.principal=${who.principal} AND live.session_hash=${sessionHash} AND live.expires_at>${Date.now()})`};
  };
  try{
   const state=userId=>one(sql`SELECT status,auth_version AS version,updated_at AS updated FROM local_users WHERE id=${userId}`);
   const enables=userId=>count(sql`SELECT count(*) AS n FROM audit WHERE action='auth.user.enable' AND target=${userId}`);
   const sessions=userId=>count(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE user_id=${userId}`);
   const session=userId=>insert('local_auth_sessions',{token_hash:'session-'+uuid(),user_id:userId,auth_version:2,created_at:time,expires_at:time+day,pending_until:0});
   const disable=(who,userId,disabled=true,value)=>post(authApi,'/api/auth',who,{action:'disable-user',userId,disabled},value);
   // First disable: one row, one bump. Then a repeat: 200, nothing changes.
   const target=await user(),first=await disable(owner,target);
   check([first.status,(await state(target)).status,(await state(target)).version,await disables(target)],[200,'disabled',2,1],'no-op: the first disable changes the account once');
   const pending=await link(target);await session(target);
   const beforeRepeat=await state(target),sessionCount=await sessions(target),repeatToken=await token();
   const repeat=await observe(()=>disable(owner,target,true,repeatToken));
   check([repeat.result.status,repeat.result.body.ok,repeat.result.body.user?.id,repeat.result.body.user?.status],[200,true,target,'disabled'],'no-op: a repeated disable answers 200 with the user');
   check([await state(target),await disables(target),repeat.rows],[beforeRepeat,1,[]],'no-op: status, auth_version and updated_at are unchanged, no audit row');
   check([(await one(sql`SELECT used_at FROM local_account_tokens WHERE token_hash=${pending}`)).used_at,await sessions(target)],[null,sessionCount],'no-op: the outstanding token stays unused and no session is revoked');
   check(repeat.batches.some(batch=>batch.some(sql=>/^DELETE FROM local_auth_sessions\b|^UPDATE local_account_tokens\b|^INSERT INTO audit\b/.test(sql))),false,'no-op: no token, revocation or audit statement runs');
   check(await proofExists(repeatToken),false,'no-op: the proof is consumed');
   check(repeat.batches.flat().filter(isProof).map(sql=>sql.includes(['changes','()'].join(''))),[false],'no-op: one proof DELETE, without a row counter condition');
   const reused=await disable(owner,target,true,repeatToken);
   check([reused.status,reused.body.code],[403,'MFA_STEP_UP_REQUIRED'],'no-op: reusing the consumed proof is refused');
   // disabled:false on an account that is already active, and on an invited account without a password.
   for(const [label,status] of [['active','active'],['invited','invited']]){
    const enabledTarget=await user(status),beforeEnable=await state(enabledTarget),answer=await disable(owner,enabledTarget,false);
    check([answer.status,await state(enabledTarget),await enables(enabledTarget)],[200,beforeEnable,0],'no-op: enabling an '+label+' account changes nothing and writes no row');
   }
   // The no-op needs the same authorization as a real change. A refusal changes
   // nothing but the actor's own proof, and that proof survives exactly when it
   // survives a refused real change, so it does not show the target's status.
   const refusedLike=async(label,who,makeTarget,value=()=>token(who))=>{
    const changing=await makeTarget('active'),repeated=await makeTarget('disabled');
    const realProof=await value(),real=await disable(who,changing,true,realProof);
    const noopProof=await value(),before=await snapshot(),noop=await disable(who,repeated,true,noopProof);
    check([noop.status,noop.body.code,noop.body.error],[real.status,real.body.code,real.body.error],label+': the repeated disable is refused like a real one');
    check(noop.status===200,false,label+': never 200');
    check(await proofExists(noopProof),await proofExists(realProof),label+': the no-op uses up the proof exactly like a real change');
    const after=await snapshot(),proofs=table=>table.map(entry=>JSON.parse(entry));
    check(snapshotTables.filter(table=>table!=='mfa_management_proofs').map(table=>after[table]),snapshotTables.filter(table=>table!=='mfa_management_proofs').map(table=>before[table]),label+': nothing else changed');
    const kept=new Set(after.mfa_management_proofs);
    check([after.mfa_management_proofs.every(entry=>before.mfa_management_proofs.includes(entry)),proofs(before.mfa_management_proofs.filter(entry=>!kept.has(entry))).every(entry=>entry.token_hash===noopProof)],[true,true],label+': at most the proof of the actor is gone');
   };
   const disabledUser=async status=>{const userId=await user();if(status==='disabled')await d.exec(sql`UPDATE local_users SET status='disabled',auth_version=2 WHERE id=${userId}`);return userId;};
   const noManage=await actor('nomanage@audit.test',['groups.manage','portal.roleAssignments.manage'],'operator');
   await refusedLike('without portal.users.manage',noManage,disabledUser);
   const expiredToken=async()=>{const value=await token();await d.exec(sql`UPDATE mfa_management_proofs SET expires_at=${Date.now()-1000} WHERE token_hash=${value}`);return value;};
   await refusedLike('without a valid proof',owner,disabledUser,expiredToken);
   const usersOnly=await actor('usersonly@audit.test',['portal.users.manage'],'operator');
   const assignedUser=async status=>{const userId=await disabledUser(status);await assignRole('user',userId,builtin.reader);return userId;};
   await refusedLike('without dominance over the target',usersOnly,assignedUser);
   // Refused inside the batch on an already disabled target: the proof is gone,
   // just as after a refused real change.
   const probed=await disabledUser('disabled'),probeProof=await token(noManage),probe=await disable(noManage,probed,true,probeProof);
   check([probe.status,probe.body.code,await proofExists(probeProof)],[409,'AUTH_STATE_CHANGED',false],'no-op without portal.users.manage: refused and the proof is used up');
   const probeAgain=await disable(noManage,probed,true,probeProof);
   check([probeAgain.status,probeAgain.body.code],[403,'MFA_STEP_UP_REQUIRED'],'no-op without portal.users.manage: reusing the proof is refused');
   // A no-op that loses a race: the account changes between the pre-check and the commit.
   const racedNoop=await disabledUser('disabled'),raceProof=await token();
   beforeBatch=()=>d.exec(sql`UPDATE local_users SET auth_version=auth_version+1 WHERE id=${racedNoop}`);
   try{
    const lost=await disable(owner,racedNoop,true,raceProof);
    check([lost.status,lost.body.code,beforeBatch,await proofExists(raceProof)],[409,'AUTH_STATE_CHANGED',null,false],'no-op race: refused and the proof is used up');
   }finally{beforeBatch=null;}
  }finally{mfa.readMfaManagementProof=lenient.read;}
  // The other account actions keep their action, target and guard.
  const linkTarget=await user(),issued=await observe(()=>post(authApi,'/api/auth',owner,{action:'reset-link',userId:linkTarget}));
  check([issued.result.status,issued.rows],[200,[row(owner,'auth.user.password-link',linkTarget)]],'reset-link: its row through auditEvent');
 }

 // ---- An injected audit failure makes nothing effective -----------------------------------
 {
  const isHttp=error=>error instanceof HttpError||Number.isInteger(error?.status);
  // Runs `call` with the audit table refusing every insert; `proofToken` is the proof the action uses.
  const failing=async(label,prepare,call,{proof=true}={})=>{
   const setup=await prepare(),value=proof?await token(setup.who??owner):null;
   const before=await snapshot();await auditUnavailable();
   let outcome;try{outcome=await call(setup,value).then(result=>({result}),error=>({error}));}finally{await auditAvailable();}
   check(await snapshot(),before,label+': nothing changed');
   if(proof)check(await proofExists(value),true,label+': the proof still exists');
   return outcome;
  };
  const libFails=async(label,prepare,call,options)=>{const {error}=await failing(label,prepare,call,options);check([!!error,error&&/audit unavailable/.test(error.message),error&&isHttp(error)],[true,true,false],label+': rejects with the original error');};
  const httpFails=async(label,prepare,call)=>{const {result}=await failing(label,prepare,call);
   check([result?.status,result?.body?.code,/^[0-9a-f]{8}$/.test(result?.body?.reference??'')],[500,'INTERNAL_ERROR',true],label+': 500 INTERNAL_ERROR with a reference');
   check(JSON.stringify(result?.body).includes('audit unavailable'),false,label+': the body has no raw text');};
  const rbacCall=payload=>async(_setup,value)=>manageWith(owner,typeof payload==='function'?payload(_setup):payload,value);
  const group=async()=>{const id=await userGroup(1);return {id,name:(await one(sql`SELECT name FROM user_groups WHERE id=${id}`)).name};};
  // The 10 actions of manageRbac.
  await libFails('rbac create-group',async()=>({}),rbacCall({action:'create-group',name:'Ausfall '+uuid().slice(0,8)}));
  await libFails('rbac update-group',group,rbacCall(s=>({action:'update-group',id:s.id,name:s.name+' x',description:'',enabled:true})));
  await libFails('rbac add-member',async()=>({...await group(),user:await user()}),rbacCall(s=>({action:'add-member',groupId:s.id,userId:s.user})));
  await libFails('rbac remove-member',async()=>{const s={...await group(),user:await user()};await member(s.id,s.user);return s;},rbacCall(s=>({action:'remove-member',groupId:s.id,userId:s.user})));
  await libFails('rbac delete-group',async()=>{const s={...await group(),user:await user()};await member(s.id,s.user);await assignRole('group',s.id,builtin.reader);return s;},rbacCall(s=>({action:'delete-group',id:s.id})));
  await libFails('rbac create-role',async()=>({}),rbacCall({action:'create-role',name:'Ausfall '+uuid().slice(0,8),permissions:['view']}));
  await libFails('rbac update-role',async()=>({role:await customRole(['view'])}),rbacCall(s=>({action:'update-role',id:s.role,name:'Ausfall',description:'',permissions:['view','terminal']})));
  await libFails('rbac delete-role',async()=>({role:await customRole(['view'])}),rbacCall(s=>({action:'delete-role',id:s.role})));
  await libFails('rbac add-assignment of Owner with an open link',async()=>{const target=await user();await link(target);return {target};},rbacCall(s=>({action:'add-assignment',subjectType:'user',subjectId:s.target,roleId:builtin.owner,scopeType:'global',scopeId:'*'})));
  await libFails('rbac delete-assignment',async()=>({assignment:await assignRole('user',await user(),builtin.reader)}),rbacCall(s=>({action:'delete-assignment',id:s.assignment})));
  await httpFails('POST /api/rbac',async()=>({}),(_setup,value)=>post(rbacApi,'/api/rbac',owner,{action:'create-group',name:'Ausfall '+uuid().slice(0,8)},value));
  // The access route: create-group, update-group, set-grant and delete-grant.
  const deviceGroupWithGrant=async()=>{const id=await deviceGroup(),grantee=await user();return {id,grantee,grant:await assignRole('user',grantee,await customRole(['view']),'devicegroup',id)};};
  await httpFails('POST /api/access create-group',async()=>({}),(_setup,value)=>post(accessApi,'/api/access',owner,{action:'create-group',name:'Ausfall',description:''},value));
  await httpFails('POST /api/access update-group',deviceGroupWithGrant,(s,value)=>post(accessApi,'/api/access',owner,{action:'update-group',id:s.id,name:'Ausfall',description:''},value));
  await httpFails('POST /api/access set-grant',deviceGroupWithGrant,(s,value)=>post(accessApi,'/api/access',owner,{action:'set-grant',groupId:s.id,principal:'local:'+s.grantee,role:'viewer',permissions:['view']},value));
  await httpFails('POST /api/access delete-grant',deviceGroupWithGrant,(s,value)=>post(accessApi,'/api/access',owner,{action:'delete-grant',id:s.grant},value));
  // disable-user through /api/auth.
  await httpFails('POST /api/auth disable-user',async()=>({target:await user()}),(s,value)=>post(authApi,'/api/auth',owner,{action:'disable-user',userId:s.target,disabled:true},value));
  const proofOf=value=>authorization(owner,value);
  await libFails('removeDevices',async()=>({server:await device()}),async(s,value)=>{viewer=owner;return lifecycle.removeDevices(owner,[s.server],true,await proofOf(value));});
 }

 // ---- Customer and installer entries ---------------------------------------------
 const customerRows=async(customer,from=0)=>(await d.query(sql`SELECT ${idents(columns)} FROM audit WHERE id>${from} AND customer_id=${customer} ORDER BY id`)).map(entry=>({...entry}));
 // Writes every customer and installer entry for one customer; returns the customer.
 const customerLife=async(name,retention=null)=>{
  const from=await lastAudit();
  // create, a harmless edit and the status rely on the session fence (lib/step-up.ts); the rest keeps its proof.
  const id=await customerAdmin.createCustomer(sessionRequest(),owner,{name,auditRetentionDays:retention});
  await customerAdmin.updateCustomer(sessionRequest(),owner,id,{name:name+' GmbH',auditRetentionDays:retention,revision:0},undefined);
  const tech=await user();
  await customerAdmin.setCustomerTechnicians(owner,id,{userIds:[tech],groupIds:[],revision:1},await authorization());
  await technicians.removeCustomerTechnicians(owner,id,{userIds:[],groupIds:[],revision:2},await authorization());
  const created=await installers.createCustomerInstaller(owner,{customerId:id,name:'Rollout',groupId:null,mode:'ReadOnly',validDays:30,maxDevices:null},await authorization());
  await installers.revokeCustomerInstaller(owner,created.id,await authorization());
  const server=await device(id);viewer=owner;
  await lifecycle.removeDevices(owner,[server],true,await authorization());
  await customerAdmin.setCustomerStatus(sessionRequest(),owner,id,'disabled',3);
  await customerAdmin.setCustomerStatus(sessionRequest(),owner,id,'active',4);
  return {id,from,tech,server,installer:created.id};
 };
 {
  const life=await customerLife('Kunde Audit '+uuid().slice(0,6));
  const name=(await one(sql`SELECT name FROM customers WHERE id=${life.id}`)).name,first=name.replace(/ GmbH$/,''),expiry=(await one(sql`SELECT expires_at FROM customer_installers WHERE id=${life.installer}`)).expires_at;
  const serverName=(await one(sql`SELECT name FROM servers WHERE id=${life.server}`)).name;
  check(await customerRows(life.id,life.from),[
   row(owner,'Kunde angelegt',first,life.id),
   row(owner,'Kunde geändert',`${first} → ${name}`,life.id),
   row(owner,'Techniker geändert',`${name} (+1 / −0)`,life.id),
   row(owner,'Techniker geändert',`${name} (+0 / −1)`,life.id),
   row(owner,'Installer erzeugt',`${name}: Rollout (ReadOnly, gültig bis ${new Date(expiry).toISOString().slice(0,10)})`,life.id),
   row(owner,'Installer widerrufen',`${name}: Rollout`,life.id),
   row(owner,'Gerät aus Portal entfernt',`${serverName} / ${life.server}`,life.id),
   row(owner,'Kunde deaktiviert',name,life.id),
   row(owner,'Kunde aktiviert',name,life.id),
  ],'every customer and installer entry carries the customer, scope portal, no server');
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE id>${life.from} AND customer_id IS NULL AND (action LIKE 'Kunde %' OR action IN ('Techniker geändert','Installer erzeugt','Installer widerrufen','Gerät aus Portal entfernt'))`),0,'no such entry without customer');
  // A used proof on an edit that shortens the retention: no change and no row.
  const shortened=await customerAdmin.createCustomer(sessionRequest(),owner,{name:'Kunde ohne Beleg '+uuid().slice(0,6),auditRetentionDays:30});
  const used=await token();await d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${used}`);
  const from=await lastAudit(),stored=await one(sql`SELECT audit_retention_days,revision FROM customers WHERE id=${shortened}`);
  await rejects(customerAdmin.updateCustomer(sessionRequest(),owner,shortened,{name:'Kunde ohne Beleg',auditRetentionDays:10,revision:0},used),403,serverText('apiError.mfa.confirmationUsed'),'updateCustomer that shortens the retention with a used proof');
  check([await one(sql`SELECT audit_retention_days,revision FROM customers WHERE id=${shortened}`),await since(from)],[stored,[]],'used proof: no change and no row');
  // removeDevices over two customers; an already removed device gets no row.
  const other=await customerAdmin.createCustomer(sessionRequest(),owner,{name:'Kunde Zwei '+uuid().slice(0,6)});
  const deviceA=await device(customerA),deviceB=await device(other),gone=await device(other,1);
  const names=Object.fromEntries(await Promise.all([deviceA,deviceB].map(async id=>[id,(await one(sql`SELECT name FROM servers WHERE id=${id}`)).name])));
  const removalProof=await authorization(),removal=await observe(()=>lifecycle.removeDevices(owner,[deviceA,deviceB,gone],true,removalProof));
  const byTarget=(a,b)=>a.target.localeCompare(b.target);
  check([...removal.rows].sort(byTarget),[row(owner,'Gerät aus Portal entfernt',`${names[deviceA]} / ${deviceA}`,customerA),row(owner,'Gerät aus Portal entfernt',`${names[deviceB]} / ${deviceB}`,other)].sort(byTarget),'two customers: one row each with its customer, none for the removed device');
  const repeatProof=await authorization(),repeat=await observe(()=>lifecycle.removeDevices(owner,[deviceA],true,repeatProof));
  check(repeat.rows,[],'an already removed device writes no row');
 }

 // ---- An injected audit failure makes nothing effective -----------------------------------
 {
  const isHttp=error=>error instanceof HttpError||Number.isInteger(error?.status);
  // Runs `call` with the audit table refusing every insert; `proofToken` is the proof the action uses.
  const failing=async(label,prepare,call,{proof=true}={})=>{
   const setup=await prepare(),value=proof?await token(setup.who??owner):null;
   const before=await snapshot();await auditUnavailable();
   let outcome;try{outcome=await call(setup,value).then(result=>({result}),error=>({error}));}finally{await auditAvailable();}
   check(await snapshot(),before,label+': nothing changed');
   if(proof)check(await proofExists(value),true,label+': the proof still exists');
   return outcome;
  };
  const libFails=async(label,prepare,call,options)=>{const {error}=await failing(label,prepare,call,options);check([!!error,error&&/audit unavailable/.test(error.message),error&&isHttp(error)],[true,true,false],label+': rejects with the original error');};
  const httpFails=async(label,prepare,call)=>{const {result}=await failing(label,prepare,call);
   check([result?.status,result?.body?.code,/^[0-9a-f]{8}$/.test(result?.body?.reference??'')],[500,'INTERNAL_ERROR',true],label+': 500 INTERNAL_ERROR with a reference');
   check(JSON.stringify(result?.body).includes('audit unavailable'),false,label+': the body has no raw text');};
  // Customers and installers.
  const customer=async()=>{const id=await customerAdmin.createCustomer(sessionRequest(),owner,{name:'Ausfall '+uuid().slice(0,8)});return {id,revision:(await one(sql`SELECT revision FROM customers WHERE id=${id}`)).revision};};
  const proofOf=value=>authorization(owner,value);
  // create, a harmless edit and the status ignore the supplied proof, so it stays.
  await libFails('createCustomer',async()=>({}),async()=>customerAdmin.createCustomer(sessionRequest(),owner,{name:'Ausfall '+uuid().slice(0,8)}));
  await libFails('updateCustomer',customer,async(s,value)=>customerAdmin.updateCustomer(sessionRequest(),owner,s.id,{name:'Umbenannt '+uuid().slice(0,8),revision:s.revision},value));
  await libFails('setCustomerStatus',customer,async(s)=>customerAdmin.setCustomerStatus(sessionRequest(),owner,s.id,'disabled',s.revision));
  await libFails('setCustomerTechnicians',async()=>({...await customer(),tech:await user()}),async(s,value)=>customerAdmin.setCustomerTechnicians(owner,s.id,{userIds:[s.tech],groupIds:[],revision:s.revision},await proofOf(value)));
  const withTechnician=async()=>{const s={...await customer(),tech:await user()};await customerAdmin.setCustomerTechnicians(owner,s.id,{userIds:[s.tech],groupIds:[],revision:s.revision},await authorization());return {...s,revision:s.revision+1};};
  await libFails('removeCustomerTechnicians',withTechnician,async(s,value)=>technicians.removeCustomerTechnicians(owner,s.id,{userIds:[],groupIds:[],revision:s.revision},await proofOf(value)));
  await libFails('createCustomerInstaller',customer,async(s,value)=>installers.createCustomerInstaller(owner,{customerId:s.id,name:'Ausfall',groupId:null,mode:'ReadOnly',validDays:30,maxDevices:null},await proofOf(value)));
  await libFails('revokeCustomerInstaller',async()=>{const s=await customer();return {...s,installer:(await installers.createCustomerInstaller(owner,{customerId:s.id,name:'Ausfall',groupId:null,mode:'ReadOnly',validDays:30,maxDevices:null},await authorization())).id};},async(s,value)=>installers.revokeCustomerInstaller(owner,s.installer,await proofOf(value)));
  await httpFails('POST /api/customers update',customer,(s,value)=>post(customersApi,'/api/customers',owner,{action:'update',id:s.id,name:'Umbenannt '+uuid().slice(0,8),revision:s.revision},value));
 }

 // ---- Customer retention covers the rows ----------------------------------------------------
 {
  const retained=await customerLife('Kunde Kurz '+uuid().slice(0,6),1),open=await customerLife('Kunde Lang '+uuid().slice(0,6));
  const portalFrom=await lastAudit();await manage(owner,{action:'create-group',name:'Alt '+uuid().slice(0,8)});const [portal]=await since(portalFrom);
  const portalId=Number((await one(sql`SELECT max(id) AS n FROM audit`)).n);
  const now=Date.now(),old=now-2*day;
  await d.exec(sql`UPDATE audit SET at=${old} WHERE customer_id IN (${retained.id},${open.id}) OR id=${portalId}`);
  const rowsOf=customer=>count(sql`SELECT count(*) AS n FROM audit WHERE customer_id=${customer} AND at=${old}`);
  const retainedRows=await rowsOf(retained.id),openRows=await rowsOf(open.id);
  check([retainedRows,openRows],[9,9],'both customers have their nine entries from the real writers');
  const first=await runMaintenance(d,{},{retention:{auditDays:3650,jobDays:3650},now});
  check(first.customerAudit.find(entry=>entry.customerId===retained.id),{customerId:retained.id,auditDays:1,deleted:retainedRows,more:false},'customer A: its retention reports the rows');
  check([await rowsOf(retained.id),await rowsOf(open.id)],[0,openRows],'customer A rows are deleted, customer B rows stay at 3650 days');
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE id=${portalId} AND customer_id IS NULL`),1,'the equally old portal row without customer stays');
  check(portal.customer_id,null,'the portal row has no customer');
  await runMaintenance(d,{},{retention:{auditDays:1,jobDays:3650},now});
  check(await rowsOf(open.id),0,'customer B rows follow the shorter instance retention');
 }

 // ---- Static checks ----------------------------------------------------------------
 {
  for(const file of ['lib/server/identity/customer-admin.ts','lib/server/identity/rbac.ts','app/api/access/route.ts','lib/server/identity/access-admin.ts','app/api/auth/route.ts','lib/server/identity/account-admin.ts','lib/server/identity/customer-technicians.ts','lib/server/devices/device-lifecycle.ts','lib/server/security-commit.ts']){
   const source=readFileSync(file,'utf8'),serverImport=source.match(/import \{([^}]*)\} from '(?:\.\.?\/context|@\/lib\/server\/context)'/)?.[1]??'';
   check(serverImport.split(',').map(name=>name.trim()).includes('log'),false,file+': no log import from server');
   check(/(?<![.\w])log\(/.test(source),false,file+': no log() call');
   check(/INSERT INTO audit\b/i.test(source),false,file+': no INSERT INTO audit');
  }
  check(/INSERT INTO audit\b/.test(readFileSync('lib/server/audit.ts','utf8')),true,'lib/server/audit.ts writes the rows');
  const installerSource=readFileSync('lib/server/agent/customer-installers.ts','utf8');
  check(/(?<![.\w])log\(/.test(installerSource),false,'lib/server/agent/customer-installers.ts: no log()');
  check((installerSource.match(/INSERT INTO audit\b/g)??[]).length,1,'lib/server/agent/customer-installers.ts: one direct audit insert');
  check(/INSERT INTO audit \(at,actor,action,target,server_id,scope\) SELECT \$\{time\},'Installer „'/.test(installerSource),true,'it is the device row of enrollWithInstaller');
 }
 console.log(`audit-writer-iam: ${checks} checks passed`);
}finally{d.close();}
