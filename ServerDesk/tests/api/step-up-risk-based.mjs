// Step-up MFA only where the risk is real (lib/step-up.ts, docs/portal-sessions.md "Which actions ask for MFA
// again") through the real routes on an isolated migrated PostgreSQL test database: the kept actions (terminal open,
// an RBAC role assignment, saving the organization assistant key, customer technicians) still need and consume a
// fresh proof; the dropped ones (notification channel create and rotate-secret, customer create and set-status,
// removing the organization assistant key) commit behind the live MFA session fence, leave a supplied proof unused
// and answer the session error when the session ends before the commit; the conditional ones (deleting a device
// group, the maintenance save, the customer edit) ask only in their risky case, also when the risk arrives between
// the read and the commit; a console job asks for nothing new. A viewer without the right gets the same error as
// before any step-up, and the audit rows are the same with and without a proof. Every audit row is checked in its
// writing batch.
import '../support/offline-fetch.mjs';
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError,genericCode} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';
import {enableMultipleCustomers} from '../support/customer-separation.mjs';
import {sessionHeaders} from '../support/session-cookies.mjs';
import {sql} from '../../runtime/database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';

const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const origin='https://risk.test',time=Date.now(),defaultCustomer='00000000-0000-4000-8000-000000000100';
 const HttpError=realHttpError;
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex'),uuid=()=>crypto.randomUUID();
 // The one-shot hook runs right before the next batch; every batch's SQL is recorded.
 let beforeBatch=null,current=null;const batches=[],leases=[],logs=[];
 const facade=hookDatabase(d,{transaction:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}},record:batches});
 const identity=async()=>{if(!current)throw new HttpError(401,'Bitte anmelden.','IDENTITY_LOGIN_REQUIRED');return current;};
 const server={
  db:()=>facade,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:'',now:()=>Date.now(),random:token,hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:request=>request.json(),sameOrigin:()=>{},
  requireViewer:identity,requireIdentity:identity,requireAuthIdentity:async()=>current,
  log:async(...entry)=>{logs.push(entry);},
  failure:e=>Response.json({error:e instanceof HttpError?e.message:serverText('apiError.storageUnavailable'),...(e instanceof HttpError&&e.code&&!genericCode(e.code)?{code:e.code}:{})},{status:e instanceof HttpError?e.status:503}),
 };
 const snapshotOf=device=>JSON.parse(device.snapshot||'{}');
 const v3={modern:snapshotOf,snapshot:snapshotOf,maintenanceBusy:async()=>false,pendingWork:async()=>false,pendingTransfers:async()=>false,lease:async(...args)=>{leases.push(args);},releaseLease:async()=>{},bucket:()=>({}),CHUNK_SIZE:262144,MAX_TRANSFER:1<<30,securityFile:()=>false};
 // Stubs only for what these flows never reach (agent packages, R2, RDP sweeps, the release source).
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,
  '../agent/agent-protocol':v3,'./agent-protocol':v3,'@/lib/server/agent/agent-protocol':v3,'../devices/transfers':{clearTransfer:async()=>{}},'./transfers':{clearTransfer:async()=>{}},
  '@/lib/server/agent/agent-crypto':{sealAgentSecrets:async()=>({})},'@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
  '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>({publicKey:'fixture-job-key'}),JOB_SIGNING_KEY_MISSING:'missing'},'@/lib/server/devices/rdp':{sweepRdp:async()=>{}}};
 const load=sourceLoader();
 const api={
  access:load('app/api/access/route.ts',imports),console:load('app/api/console/route.ts',imports),rbac:load('app/api/rbac/route.ts',imports),terminal:load('app/api/terminal/route.ts',imports),
  customers:load('app/api/customers/route.ts',imports),channels:load('app/api/notifications/channels/route.ts',imports),assistant:load('app/api/assistant/settings/route.ts',imports),maintenance:load('app/api/maintenance/route.ts',imports),
 };
 const paths={access:'/api/access',console:'/api/console',rbac:'/api/rbac',terminal:'/api/terminal',customers:'/api/customers',channels:'/api/notifications/channels',assistant:'/api/assistant/settings',maintenance:'/api/maintenance'};

 // ---- Fixture -------------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const count=async statement=>Number((await d.one(statement)).n);
 async function account(label,permissions=['*']){
  const {actor}=await sourceActor(d,label,permissions);actor.userId=actor.id;
  await d.exec(sql`UPDATE local_users SET password_hash='fixture-password',must_reset=0 WHERE id=${actor.id}`);
  await insert('mfa_accounts',{principal:actor.principal,secret_enc:'migrated:authenticator-managed',recovery_hashes:'[]',last_counter:-1,created_at:time,authenticators_migrated:1});
  return actor;
 }
 // A signed-in browser: bound primary session, live MFA session and, unless proof is false, one fresh management proof.
 async function browser(actor,{proof=true}={}){
  const at=Date.now(),primary=token(),session=token(),management=token();
  await insert('mfa_sessions',{token_hash:sha(session),principal:actor.principal,created_at:at,last_activity:at,idle_expires_at:at+900_000,expires_at:at+86_400_000});
  await insert('local_auth_sessions',{token_hash:sha(primary),user_id:actor.id,auth_version:1,created_at:at,expires_at:at+86_400_000,pending_until:at+600_000,mfa_hash:sha(session)});
  if(proof)await insert('mfa_management_proofs',{token_hash:sha(management),principal:actor.principal,session_hash:sha(session),expires_at:at+300_000});
  return {primary,session,management:proof?management:null};
 }
 const post=async(route,actor,b,payload)=>{current=actor;batches.length=0;const response=await api[route].POST(new Request(origin+paths[route],{method:'POST',headers:sessionHeaders(b,{'Content-Type':'application/json'}),body:JSON.stringify(payload)}));const text=await response.text();let body;try{body=JSON.parse(text);}catch{body={text};}return {status:response.status,body};};
 const proofExists=async value=>await count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${sha(value)}`)===1;
 const touchesProof=()=>batches.some(batch=>batch.some(statement=>/mfa_management_proofs/.test(statement)));
 const audits=()=>d.query(sql`SELECT actor,action,target,scope,server_id,customer_id FROM audit ORDER BY id`);
 const auditCount=()=>count(sql`SELECT count(*) AS n FROM audit`);
 const endSession=b=>()=>d.exec(sql`UPDATE mfa_sessions SET idle_expires_at=${Date.now()-1000} WHERE token_hash=${sha(b.session)}`);
 const sessionError=result=>result.status===401&&['SESSION_EXPIRED','MFA_LOGIN_REQUIRED','IDENTITY_LOGIN_REQUIRED'].includes(result.body.code);
 const group=async(name,customer=defaultCustomer)=>{const id=uuid();await insert('device_groups',{id,name,description:'',created_at:time,parent_id:null,customer_id:customer});return id;};
 const device=async(name,extra={})=>{const id=uuid();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:Date.now(),management:1,snapshot:JSON.stringify({protocolVersion:3,agentVersion:'4.5.0',mode:'Management',agentCapabilities:['terminal','terminal-multi']}),...extra});return id;};
 const viewerRole=uuid();await insert('rbac_roles',{id:viewerRole,name:'Leser '+viewerRole,description:'',permissions:'["view"]',builtin:0,created_at:time});
 const customerRevision=async id=>Number((await d.one(sql`SELECT revision FROM customers WHERE id=${id}`)).revision);
 const owner=await account('owner@risk.test');

 // A kept action: without a valid proof 403 MFA_STEP_UP_REQUIRED and nothing written; with one success and the proof consumed in the writing batch.
 async function kept(label,send,state){
  for(const [kind,value] of [['missing',undefined],['unknown',token()]]){
   const b=await browser(owner,{proof:false}),before=await state(),rows=await auditCount();
   const result=await send(b,value);
   check([result.status,result.body.code],[403,'MFA_STEP_UP_REQUIRED'],`${label} ${kind} token: 403 MFA_STEP_UP_REQUIRED (${result.body.error})`);
   check([await state(),await auditCount()],[before,rows],`${label} ${kind} token: no row and no audit row`);
  }
  const b=await browser(owner),before=await state(),result=await send(b,b.management);
  check(result.status,200,`${label} with a proof: 200 (${result.body.error})`);
  check([JSON.stringify(await state())!==JSON.stringify(before),await proofExists(b.management)],[true,false],`${label}: the change happened and the proof is gone`);
  check(batches.some(batch=>batch.some(statement=>/^DELETE FROM mfa_management_proofs\b/.test(statement))&&batch.some(statement=>/^(?:INSERT INTO|UPDATE) (?!mfa_management_proofs)/.test(statement))),true,`${label}: the proof is consumed in the batch that writes the change`);
  return result;
 }
 // A dropped action: success without a proof, a supplied proof stays, and an MFA session that ends before the commit writes nothing.
 async function dropped(label,send,state,{prepare=async()=>{}}={}){
  {
   const b=await browser(owner,{proof:false}),rows=await auditCount(),result=await send(b,undefined);
   check(result.status,200,`${label} without a proof: 200 (${result.body.error})`);
   check([await auditCount(),touchesProof()],[rows+1,false],`${label}: one audit row, no proof read or consumed`);
   check(batches.at(-1).some(statement=>statement.includes('live_session.idle_expires_at>')),true,`${label}: the commit carries the session fence`);
  }
  {
   await prepare();const b=await browser(owner),result=await send(b,b.management);
   check([result.status,await proofExists(b.management)],[200,true],`${label} with a supplied proof: 200, the proof stays`);
  }
  {
   await prepare();const b=await browser(owner,{proof:false}),before=await state(),rows=await auditCount();beforeBatch=endSession(b);
   const result=await send(b,undefined);
   check([beforeBatch,sessionError(result)],[null,true],`${label}: an MFA session that ends before the commit answers the session error (${result.status} ${result.body.code})`);
   check([await state(),await auditCount()],[before,rows],`${label}: and writes nothing`);
  }
 }
 const withToken=(payload,value)=>value===undefined?payload:{...payload,managementToken:value};

 // ==== Kept ==========================================================================
 {
  const host=await device('SRV-TERMINAL');
  await kept('terminal open',(b,value)=>post('terminal',owner,b,withToken({action:'open',serverId:host,confirm:true,cols:100,rows:30},value)),()=>count(sql`SELECT count(*) AS n FROM terminal_sessions`));
  const target=await account('target@risk.test',['view']);
  await kept('rbac add-assignment',(b,value)=>post('rbac',owner,b,withToken({action:'add-assignment',subjectType:'user',subjectId:target.id,roleId:viewerRole,scopeType:'global',scopeId:'*'},value)),()=>count(sql`SELECT count(*) AS n FROM role_assignments WHERE principal_id=${target.id} AND role_id=${viewerRole}`));
  await kept('assistant set-organization-key',(b,value)=>post('assistant',owner,b,withToken({action:'set-organization-key',provider:'anthropic',model:'claude-opus-5-5',key:'sk-ant-api03-RISKkey00000000000000000AAAA',revision:null},value)),()=>count(sql`SELECT count(*) AS n FROM assistant_keys WHERE scope='organization'`));
  const tech=await account('tech@risk.test',['view']);
  await kept('customer set-technicians',async(b,value)=>post('customers',owner,b,withToken({action:'set-technicians',id:defaultCustomer,userIds:[tech.id],groupIds:[],revision:await customerRevision(defaultCustomer)},value)),()=>count(sql`SELECT count(*) AS n FROM customer_assignments WHERE principal_id=${tech.id}`));
 }

 // ==== Dropped =======================================================================
 {
  const channels=()=>d.query(sql`SELECT id,name,revision,secret FROM notification_channels ORDER BY name`);
  let serial=0;
  const createChannel=(b,value)=>post('channels',owner,b,withToken({action:'create',type:'webhook',name:'Hook '+(++serial),url:'https://hooks.example.com/notify'},value));
  await dropped('notification channel create',createChannel,channels);
  const hook=(await channels())[0];
  // The audit rows of today's path: one portal row per create, its target names the channel.
  const channelRows=await d.query(sql`SELECT a.actor,a.target,a.scope,a.customer_id FROM audit a WHERE a.action='notification-channel.create' ORDER BY a.id`);
  check(channelRows.map(row=>({...row,target:JSON.parse(row.target)})),(await channels()).map(row=>({actor:'owner@risk.test',target:{id:row.id,name:row.name,type:'webhook'},scope:'portal',customer_id:null})),'notification channel create: the audit rows of today, without and with a supplied proof');
  const rotate=async(b,value)=>{const row=await d.one(sql`SELECT revision FROM notification_channels WHERE id=${hook.id}`);return post('channels',owner,b,withToken({action:'rotate-secret',id:hook.id,revision:Number(row.revision)},value));};
  await dropped('notification channel rotate-secret',rotate,channels);

  const customers=()=>d.query(sql`SELECT id,name,status,revision FROM customers ORDER BY name`);
  // A second customer exists only while "Multiple customers" is on.
  await d.exec(enableMultipleCustomers());
  await dropped('customer create',(b,value)=>post('customers',owner,b,withToken({action:'create',name:'Kunde '+(++serial)},value)),customers);
  const created=(await d.one(sql`SELECT id FROM customers WHERE id<>${defaultCustomer} ORDER BY created_at LIMIT 1`)).id;
  check((await d.query(sql`SELECT a.actor,a.action,a.target,a.scope,a.customer_id FROM audit a JOIN customers c ON c.id=a.customer_id WHERE a.action='Kunde angelegt' ORDER BY a.id`)).map(row=>[row.actor,row.target.startsWith('Kunde '),row.scope,!!row.customer_id]),[['owner@risk.test',true,'portal',true],['owner@risk.test',true,'portal',true]],'customer create: the audit rows of today, with the customer');
  const status=async(b,value)=>{const row=await d.one(sql`SELECT status,revision FROM customers WHERE id=${created}`);return post('customers',owner,b,withToken({action:'set-status',id:created,status:row.status==='active'?'disabled':'active',revision:Number(row.revision)},value));};
  await dropped('customer set-status',status,customers);

  const orgKey=()=>d.query(sql`SELECT id,revision FROM assistant_keys WHERE scope='organization'`);
  const setKey=async()=>{const b=await browser(owner),row=(await orgKey())[0];const result=await post('assistant',owner,b,{action:'set-organization-key',provider:'anthropic',model:'claude-opus-5-5',key:'sk-ant-api03-RISKkey00000000000000000'+String(++serial).padStart(4,'0'),revision:row?Number(row.revision):null,managementToken:b.management});check(result.status,200,'set the key again: '+result.body.error);};
  const remove=async(b,value)=>{const row=(await orgKey())[0];return post('assistant',owner,b,withToken({action:'remove-organization-key',revision:Number(row.revision)},value));};
  await dropped('assistant remove-organization-key',remove,orgKey,{prepare:setKey});
 }

 // ==== Conditional: delete-group ======================================================
 {
  const exists=id=>count(sql`SELECT count(*) AS n FROM device_groups WHERE id=${id}`);
  const overview=async()=>{const b=await browser(owner,{proof:false});current=owner;const response=await api.access.GET(new Request(origin+'/api/access',{headers:sessionHeaders(b)}));return (await response.json()).groups;};
  const flag=async id=>(await overview()).find(entry=>entry.id===id)?.stepUpOnDelete;
  const remove=(b,id,value)=>post('access',owner,b,withToken({action:'delete-group',id,confirm:true},value));
  // An empty group: no proof, behind the session fence, and the same audit row as with a proof.
  const empty=await group('Leer');
  check(await flag(empty),false,'GET /api/access: an empty group has stepUpOnDelete false');
  {
   const b=await browser(owner),from=await auditCount(),result=await remove(b,empty,b.management);
   check([result.status,await exists(empty),await proofExists(b.management)],[200,0,true],'an empty group deletes without a proof; a supplied proof stays');
   check(batches.find(batch=>batch.some(statement=>/^DELETE FROM device_groups\b/.test(statement)))?.[0].includes('live_session.idle_expires_at>'),true,'the admitting audit row carries the session fence');
   const row=(await audits()).slice(from);
   check([row.length,row[0].action,row[0].actor,row[0].scope,row[0].target.startsWith('Leer / '+empty+' / ')],[1,'Gerätegruppe gelöscht','owner@risk.test','portal',true],'one audit row with the receipt, as with a proof');
  }
  // With a device (of another customer, which the actor sees here) or an assignment: the proof as today.
  const second=(await d.one(sql`SELECT id FROM customers WHERE id<>${defaultCustomer} ORDER BY created_at LIMIT 1`)).id;
  await d.exec(sql`UPDATE customers SET status='active' WHERE id=${second}`);
  for(const [label,prepare] of [['a device of another customer',async id=>{const server=await device('SRV-'+id.slice(0,4),{customer_id:second});await d.exec(sql`ALTER TABLE device_group_members DISABLE TRIGGER USER`);await insert('device_group_members',{server_id:server,group_id:id});await d.exec(sql`ALTER TABLE device_group_members ENABLE TRIGGER USER`);}],['an assignment',async id=>insert('role_assignments',{id:uuid(),principal_type:'user',principal_id:(await account('member'+id.slice(0,4)+'@risk.test',['view'])).id,role_id:viewerRole,scope_type:'devicegroup',scope_id:id,created_at:time,created_by:'fixture'})]]){
   const id=await group('Voll '+label);await prepare(id);
   check(await flag(id),true,`GET /api/access: a group with ${label} has stepUpOnDelete true`);
   const bare=await browser(owner,{proof:false}),rows=await auditCount(),refused=await remove(bare,id);
   check([refused.status,refused.body.code,await exists(id),await auditCount()],[403,'MFA_STEP_UP_REQUIRED',1,rows],`a group with ${label}: without a proof 403 and nothing written`);
   const b=await browser(owner),done=await remove(b,id,b.management);
   check([done.status,await exists(id),await proofExists(b.management)],[200,0,false],`a group with ${label}: with a proof deleted and the proof consumed`);
  }
  // Empty at the read, a device before the commit: nothing deleted and the step-up answer.
  {
   const id=await group('Rennen'),server=await device('SRV-RACE');
   const b=await browser(owner,{proof:false}),rows=await auditCount();beforeBatch=()=>insert('device_group_members',{server_id:server,group_id:id});
   const result=await remove(b,id);
   check([beforeBatch,result.status,result.body.code,await exists(id),await auditCount()],[null,403,'MFA_STEP_UP_REQUIRED',1,rows],'a device that arrives before the commit: 403 MFA_STEP_UP_REQUIRED and the group stays');
   check(batches.at(-1)[0].includes('risk_member'),true,'the emptiness condition is part of the committing statement');
  }
  // Without the global right the old 403 comes first, before any step-up.
  {
   const manager=await account('manager@risk.test',['view']),id=await group('Fremd');await prepareMember(id);
   async function prepareMember(groupId){const server=await device('SRV-M-'+groupId.slice(0,4));await insert('device_group_members',{server_id:server,group_id:groupId});}
   const result=await post('access',manager,await browser(manager,{proof:false}),{action:'delete-group',id,confirm:true});
   check([result.status,result.body.error],[403,serverText('apiError.rbac.groupDeleteGlobalRight')],'delete-group without the right: the rights error, not a step-up');
  }
 }

 // ==== Conditional: maintenance set ===================================================
 {
  const settings=()=>d.one(sql`SELECT audit_days,job_days,run_at,time_zone,revision FROM maintenance_settings WHERE id=1`);
  const save=async(b,change,value)=>{const row=await settings();return post('maintenance',owner,b,withToken({action:'set',auditDays:row.audit_days??30,jobDays:row.job_days??30,runAt:'03:00',timeZone:'UTC',revision:Number(row.revision),...change},value));};
  const b=await browser(owner),moved=await save(b,{runAt:'04:15'},b.management);
  check([moved.status,(await settings()).run_at,await proofExists(b.management),touchesProof()],[200,255,true,false],'maintenance: a run time change saves without a proof');
  for(const change of [{auditDays:7},{jobDays:7}]){
   const bare=await browser(owner,{proof:false}),before=await settings(),refused=await save(bare,{...change,runAt:'04:15'});
   check([refused.status,refused.body.code,await settings()],[403,'MFA_STEP_UP_REQUIRED',before],'maintenance: a shorter '+Object.keys(change)[0]+' needs a proof');
   const proven=await browser(owner),done=await save(proven,{...change,runAt:'04:15'},proven.management);
   check([done.status,await proofExists(proven.management)],[200,false],'maintenance: with a proof saved and consumed');
  }
  // A non-Owner gets the Owner error before any step-up.
  const reader=await account('reader@risk.test',['view']),refused=await post('maintenance',reader,await browser(reader,{proof:false}),{action:'set',auditDays:1,jobDays:1,runAt:'03:00',timeZone:'UTC',revision:0});
  check([refused.status,refused.body.code],[403,'MAINTENANCE_OWNER_ONLY'],'maintenance: a non-Owner gets the Owner error, not a step-up');
 }

 // ==== Conditional: customer update ===================================================
 {
  const id=uuid();await insert('customers',{id,name:'Aufbewahrung',contact_name:'',contact_email:'',contact_phone:'',audit_retention_days:30,status:'active',revision:0,created_at:time,updated_at:time});
  const update=async(b,change,value)=>post('customers',owner,b,withToken({action:'update',id,name:'Aufbewahrung',auditRetentionDays:30,revision:await customerRevision(id),...change},value));
  const b=await browser(owner),renamed=await update(b,{name:'Aufbewahrung Nord'},b.management);
  check([renamed.status,await proofExists(b.management),touchesProof()],[200,true,false],'customer update: a name change saves without a proof');
  const bare=await browser(owner,{proof:false}),before=await customerRevision(id),refused=await update(bare,{name:'Aufbewahrung Nord',auditRetentionDays:10});
  check([refused.status,refused.body.code,await customerRevision(id)],[403,'MFA_STEP_UP_REQUIRED',before],'customer update: a shorter audit retention needs a proof');
  const proven=await browser(owner),done=await update(proven,{name:'Aufbewahrung Nord',auditRetentionDays:10},proven.management);
  check([done.status,await proofExists(proven.management)],[200,false],'customer update: with a proof saved and consumed');
  // Customer writes stay Owner-only, before any step-up.
  const reader=await account('reader2@risk.test',['view']);
  for(const payload of [{action:'create',name:'Fremd'},{action:'set-status',id,status:'disabled',revision:0},{action:'update',id,name:'Fremd',auditRetentionDays:1,revision:0}]){
   const result=await post('customers',reader,await browser(reader,{proof:false}),payload);
   check([result.status,result.body.error],[403,serverText('apiError.customer.ownerOnly')],`customer ${payload.action} by a non-Owner: the Owner error, not a step-up`);
  }
 }

 // ==== RBAC unchanged: notification channels and RBAC ==================================
 {
  const operator=await account('operator@risk.test',['view','terminal']);
  const channel=await post('channels',operator,await browser(operator,{proof:false}),{action:'create',type:'webhook',name:'Fremd',url:'https://hooks.example.com/x'});
  check([channel.status,channel.body.code],[403,undefined],'a channel create without the notifications right: the old 403, not a step-up');
  const assignment=await post('rbac',operator,await browser(operator,{proof:false}),{action:'add-assignment',subjectType:'user',subjectId:operator.id,roleId:viewerRole,scopeType:'global',scopeId:'*'});
  check([assignment.status===403,assignment.body.code==='MFA_STEP_UP_REQUIRED'],[true,true],'rbac reads the proof first for every caller, as today');
 }

 // ==== Not added: a console job needs no proof, and the routine routes read none ========
 {
  const host=await device('SRV-JOB',{snapshot:JSON.stringify({protocolVersion:3,agentVersion:'4.5.0',mode:'Management',agentCapabilities:['restart-service']})}),b=await browser(owner,{proof:false});
  const result=await post('console',owner,b,{action:'job',id:host,kind:'restart-service',params:{name:'Spooler'},confirm:true});
  check([result.status,touchesProof(),await count(sql`SELECT count(*) AS n FROM jobs WHERE server_id=${host} AND action='restart-service'`)],[200,false,1],`a restart-service job: 200 without a proof (${result.body.error})`);
  for(const file of ['app/api/rdp/route.ts','app/api/files/route.ts','app/api/transfers/route.ts','app/api/runbooks/route.ts','app/api/releases/route.ts','app/api/plugins/route.ts','app/api/diagnostics/route.ts']){
   let text='';try{text=readFileSync(file,'utf8');}catch{continue;}
   check(/prepareManagementAuthorization|managementAuthorization\(|readMfaManagementProof/.test(text),false,file+' reads no step-up proof');
  }
 }

 console.log(`PASS step-up risk-based (${checks} assertions): kept actions consume a fresh proof, dropped ones commit behind the session fence, conditional ones ask only in their risky case (also on a race), a console job asks for nothing, rights first.`);
}finally{d.close();}
