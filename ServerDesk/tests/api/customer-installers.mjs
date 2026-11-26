// Installer per customer (lib/server/agent/customer-installers.ts): creating
// without any license, with an Owner and an MFA proof, the key in the answer
// once and only its hash stored; listing and revoking; the real routes
// /api/customers and /api/agent/enroll; and the customer boundary of an
// enrollment, against an isolated PostgreSQL test database. Customer A is the
// first customer, B is created by SQL, C is disabled. Every time is relative to now.
import {serverText} from '../support/server-text.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import {readdirSync,readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';

import {sql} from '../../runtime/database.mjs';

import {hookDatabase} from '../support/hooked-database.mjs';
import {HttpError} from '../support/http-error.mjs';
const {apiErrorBody,classifyFailure}=await import('../../lib/server/errors/failure.ts');
const day=86_400_000;
const customerA='00000000-0000-4000-8000-000000000100';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const installerHash=key=>sha('ServerDesk customer installer v1\n'+key);
const randomKey=()=>crypto.randomBytes(32).toString('hex');
const uuid=()=>crypto.randomUUID();
const jobSigningKey=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'});
// The texts of the enrollment answers (POST /api/agent/enroll).
const messages={
 origin:serverText('apiError.deviceToken.originNotConfigured'),
 signingMissing:serverText('apiError.signing.keyMissing'),
 request:serverText('apiError.installer.invalidRequest'),
 deviceName:serverText('apiError.installer.deviceName'),
 invalid:serverText('apiError.installer.invalid'),
 revoked:serverText('apiError.installer.revoked'),
 expired:serverText('apiError.installer.expired'),
 exhausted:serverText('apiError.installer.exhausted'),
 customerDisabled:serverText('apiError.installer.customerDisabled'),
 groupMissing:serverText('apiError.installer.groupMissing'),
 rateLimited:serverText('apiError.installer.rateLimited'),
};
// Each refusal as [status, code, message key] (lib/errors/api-error-keys.ts).
const refused={
 ownerOnly:[403,'FORBIDDEN','apiError.customer.ownerOnly'],
 proofUsed:[403,'MFA_STEP_UP_REQUIRED','apiError.mfa.confirmationUsed'],
 customer:[400,'INVALID_REQUEST','apiError.customer.invalid'],
 name:[400,'INVALID_REQUEST','apiError.installer.name'],
 control:[400,'INVALID_REQUEST','apiError.customer.controlCharacters'],
 group:[400,'CUSTOMER_INSTALLER_GROUP_MISMATCH','apiError.customer.installerGroupMismatch'],
 mode:[400,'INVALID_REQUEST','apiError.console.agentMode'],
 validDays:[400,'INVALID_REQUEST','apiError.installer.validDays'],
 maxDevices:[400,'INVALID_REQUEST','apiError.installer.maxDevices'],
 missing:[404,'CUSTOMER_MISSING','apiError.customer.gone'],
 disabled:[409,'CUSTOMER_DISABLED','apiError.customer.disabled'],
 // Core refusals of lib/server/agent/customer-installers.ts and the route prerequisites.
 revokeMissing:[404,'NOT_FOUND','apiError.installer.gone'],
 origin:[503,'SERVICE_UNAVAILABLE','apiError.deviceToken.originNotConfigured'],
 signingMissing:[503,'AGENT_JOB_SIGNING_KEY_MISSING','apiError.signing.keyMissing'],
};

// The production body reader: size limit, JSON, objects only.
async function body(request,limit=256000){
 if(Number(request.headers.get('content-length')??0)>limit)throw new HttpError('apiError.request.tooLarge');
 const bytes=Buffer.from(await request.arrayBuffer());
 if(bytes.length>limit)throw new HttpError('apiError.request.tooLarge');
 let parsed;try{parsed=JSON.parse(bytes.toString('utf8'));}catch{throw new HttpError('apiError.request.invalidJson');}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new HttpError('apiError.request.invalidJson');
 return parsed;
}
// As lib/server/context.ts failure(): an HttpError answers with its status, code, message key and params.
const failure=error=>{const answer=error instanceof HttpError?classifyFailure(error):{status:503,body:apiErrorBody('apiError.storageUnavailable')};return Response.json(answer.body,{status:answer.status,headers:{'Cache-Control':'no-store'}});};
// The status, code and message key of an error answer.
const keyed=async response=>{const sent=await response.json();return [response.status,sent.code,sent.messageKey];};

// One isolated portal per test: real access, RBAC, customers and installers;
// only the request environment (session, MFA proof reader) is replaced.
async function fixture(run){
 const d=await sourceDatabase();
 const clock={offset:0},time=()=>Date.now()+clock.offset;
 const env={SITE_ORIGIN:'https://portal.test',AGENT_JOB_SIGNING_KEY:jobSigningKey};
 const counters={db:0,mfaReads:0};
 let viewer=null,hook=null;
 const facade=hookDatabase(d,{transaction:async()=>{if(hook&&--hook.n===0){const action=hook.action;hook=null;await action();}}});
 const server={db:()=>{counters.db++;return facade;},now:time,config:key=>env[key]??'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>sha(value),HttpError,body,failure,
  guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value),sameOrigin:()=>{},
  requireViewer:async()=>{if(!viewer)throw new HttpError('apiError.auth.loginRequired');return viewer;},
  log:async(actor,action,target,serverId)=>{await d.exec(sql`INSERT INTO audit(at,actor,action,target,server_id,scope) VALUES(${time()},${actor},${action},${target},${serverId??null},${serverId?'device':'portal'})`);}};
 const mfa={requireMfa:async()=>{},isMfaEnabled:async()=>true,
  readMfaManagementProof:async(_request,actor,token)=>{counters.mfaReads++;if(typeof token!=='string')throw new HttpError('apiError.mfa.stepUpRequired');return {tokenHash:token,key:actor.principal,sessionHash:sha(actor.id+'mfa'),guard:sql`TRUE`};}};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./mfa':mfa,'../identity/mfa':mfa,'./identity/mfa':mfa,'@/lib/server/identity/mfa':mfa};
 const load=sourceLoader();
 const access=load('lib/server/identity/access.ts',imports);
 imports['./local-auth']=imports['./identity/local-auth']={primaryGuard:async(_request,actor)=>access.viewerWriteGuard(actor)};
 const customersApi=load('app/api/customers/route.ts',imports),enrollApi=load('app/api/agent/enroll/route.ts',imports);
 const installers=load('lib/server/agent/customer-installers.ts',imports),rbac=load('lib/server/identity/rbac.ts',imports),deviceTokens=load('lib/server/agent/device-tokens.ts',imports);

 // ---- Fixture ----------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const customerB=uuid(),customerC=uuid(),gA=uuid(),gA2=uuid(),gB=uuid();
 await insert('customers',{id:customerB,name:'Kunde B',created_at:time(),updated_at:time()});
 await insert('customers',{id:customerC,name:'Kunde C',status:'disabled',created_at:time(),updated_at:time()});
 for(const [id,name,customer] of [[gA,'Gruppe A',customerA],[gA2,'Gruppe A zwei',customerA],[gB,'Gruppe B',customerB]])await insert('device_groups',{id,name,description:'',created_at:time(),parent_id:null,customer_id:customer});
 const owner=(await sourceActor(d,'owner@installer.test',['*']));
 const tech=(await sourceActor(d,'tech@installer.test',[...access.allPermissions])).actor;
 for(const actor of [owner.actor,tech]){actor.userId=actor.id;await insert('mfa_sessions',{token_hash:sha(actor.id+'mfa'),principal:actor.principal,created_at:time(),last_activity:time(),idle_expires_at:time()+30*day,expires_at:time()+30*day});}
 await insert('customer_assignments',{customer_id:customerA,principal_type:'user',principal_id:tech.id,created_at:time(),created_by:owner.actor.principal});

 const token=async(actor=owner.actor)=>{const value=uuid();await insert('mfa_management_proofs',{token_hash:value,principal:actor.principal,session_hash:sha(actor.id+'mfa'),expires_at:time()+300_000});return value;};
 const authorization=async(actor=owner.actor)=>rbac.prepareManagementAuthorization(new Request('https://portal.test/api/customers'),actor,await token(actor));
 const proofExists=async proof=>Number((await d.one(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash}`)).n)===1;
 const post=async(actor,payload,{proof=true}={})=>{viewer=actor;return customersApi.POST(new Request('https://portal.test/api/customers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,...(proof?{managementToken:await token(actor)}:{})})}));};
 const get=async actor=>{viewer=actor;return customersApi.GET(new Request('https://portal.test/api/customers'));};
 const enroll=(payload,{api=enrollApi,raw}={})=>api.POST(new Request('https://portal.test/api/agent/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:raw??JSON.stringify(payload)}));
 const answer=async response=>({status:response.status,body:await response.json(),cache:response.headers.get('cache-control')});
 const count=async statement=>Number((await d.one(statement)).n);
 const rows=async()=>(await d.query(sql`SELECT * FROM customer_installers ORDER BY created_at,id`)).map(row=>({...row}));
 const serverCount=()=>count(sql`SELECT count(*) AS n FROM servers`);
 const installerAudit=async()=>(await d.query(sql`SELECT actor,action,target,server_id AS "serverId",scope FROM audit WHERE action IN ('Installer erzeugt','Installer widerrufen','Agent über Installer registriert') ORDER BY id`)).map(row=>({...row}));
 // Runs `action` right before the nth batch from now on: the commit of a write.
 const beforeBatch=async(n,action,call)=>{hook={n,action};try{return await call();}finally{hook=null;}};
 // An installer row written by SQL, for the enrollment and status cases.
 const seed=async({customer=customerA,group=null,name='Seed',mode='ReadOnly',expiresAt=time()+30*day,maxDevices=null,enrollments=0,revokedAt=null,createdAt=time()}={})=>{
  const key=randomKey(),id=uuid();
  await insert('customer_installers',{id,customer_id:customer,group_id:group,name,key_hash:installerHash(key),mode,expires_at:expiresAt,max_devices:maxDevices,enrollments,created_at:createdAt,created_by:owner.actor.principal,revoked_at:revokedAt,revoked_by:revokedAt===null?null:owner.actor.principal});
  return {id,key};
 };
 try{
  return await run({d,clock,time,env,counters,installers,deviceTokens,customersApi,enrollApi,load,imports,owner:owner.actor,ownerAssignment:owner.assignmentId,tech,customerB,customerC,gA,gA2,gB,
   insert,token,authorization,proofExists,post,get,enroll,answer,count,rows,serverCount,installerAudit,beforeBatch,seed});
 }finally{d.close();}
}
// A refusal is a keyed HttpError: status, code and message key, as the answer body carries them.
const rejects=(promise,[status,code,key],label)=>assert.rejects(promise,error=>{assert.ok(error instanceof HttpError,`${label??''}: ${error}`);assert.deepEqual([error.status,error.code,error.messageKey],[status,code,key],label);return true;},label);
const input=(extra={})=>({customerId:customerA,name:'Rollout Nord',groupId:null,mode:'ReadOnly',validDays:30,maxDevices:null,...extra});
const isoDay=time=>new Date(time).toISOString().slice(0,10);

// ---- Creating --------------------------------------------------------------
test('a technician is refused; invalid input keeps the proof',async()=>fixture(async({installers,owner,tech,customerB,customerC,gB,authorization,proofExists,rows})=>{
 let proof;
 await rejects(installers.createCustomerInstaller(tech,input(),await authorization(tech)),refused.ownerOnly,'technician');
 const invalid=[
  [{customerId:'kein-guid'},refused.customer],[{customerId:undefined},refused.customer],
  [{name:''},refused.name],[{name:'   '},refused.name],[{name:'x'.repeat(81)},refused.name],[{name:42},refused.name],
  [{name:'Roll\u0001out'},refused.control],[{name:'Roll\nout'},refused.control],
  [{groupId:'kein-guid'},refused.group],[{groupId:5},refused.group],
  [{mode:'Admin'},refused.mode],[{mode:undefined},refused.mode],
  [{validDays:0},refused.validDays],[{validDays:366},refused.validDays],[{validDays:1.5},refused.validDays],[{validDays:'30'},refused.validDays],
  [{maxDevices:0},refused.maxDevices],[{maxDevices:10001},refused.maxDevices],[{maxDevices:2.5},refused.maxDevices],[{maxDevices:'5'},refused.maxDevices],
  [{groupId:gB},refused.group],
 ];
 for(const [extra,expected] of invalid){
  proof=await authorization();
  await rejects(installers.createCustomerInstaller(owner,input(extra),proof),expected,JSON.stringify(extra));
  assert.ok(await proofExists(proof),'invalid input keeps the proof: '+JSON.stringify(extra));
 }
 await rejects(installers.createCustomerInstaller(owner,input({customerId:uuid()}),await authorization()),refused.missing,'unknown customer');
 await rejects(installers.createCustomerInstaller(owner,input({customerId:customerC}),await authorization()),refused.disabled,'disabled customer');
 await rejects(installers.createCustomerInstaller(owner,input({customerId:customerB,groupId:uuid()}),await authorization()),refused.group,'missing group');
 assert.deepEqual(await rows(),[],'nothing was written');
}));

test('create stores the hash, the customer and the lifetime, one audit row without the secret, and consumes the proof',async()=>fixture(async({time,owner,customerB,gB,authorization,proofExists,rows,installerAudit,installers})=>{
 const proof=await authorization(),before=time();
 const created=await installers.createCustomerInstaller(owner,input({name:'  Rollout Nord  ',validDays:7,maxDevices:25}),proof);
 const after=time();
 assert.match(created.key,/^[a-f0-9]{64}$/,'the key is 64 lowercase hex');
 assert.deepEqual({...created,key:undefined,id:undefined},{key:undefined,id:undefined,name:'Rollout Nord',customerName:'Standardkunde',mode:'ReadOnly'});
 const [row]=await rows();
 assert.equal(row.id,created.id);assert.equal(row.customer_id,customerA);assert.equal(row.group_id,null);assert.equal(row.name,'Rollout Nord');
 assert.equal(row.key_hash,installerHash(created.key),'only installerKeyHash(key) is stored');
 assert.equal(row.key_hash,await installers.installerKeyHash(created.key));
 assert.notEqual(row.key_hash,sha(created.key),'the hash is domain-separated from device tokens');
 assert.ok(row.created_at>=before&&row.created_at<=after);assert.equal(row.expires_at-row.created_at,7*day);
 assert.deepEqual([row.max_devices,row.enrollments,row.last_used_at,row.revoked_at,row.created_by],[25,0,null,null,owner.principal]);
 const audit=await installerAudit();
 assert.deepEqual(audit,[{actor:owner.label,action:'Installer erzeugt',target:`Standardkunde: Rollout Nord (ReadOnly, gültig bis ${isoDay(row.expires_at)})`,serverId:null,scope:'portal'}]);
 assert.ok(!JSON.stringify(audit).includes(created.key)&&!JSON.stringify(audit).includes(row.key_hash),'no secret in the audit');
 assert.equal(await proofExists(proof),false,'the proof is consumed');
 // A group of the same customer, Management and the edge values.
 const grouped=await installers.createCustomerInstaller(owner,input({customerId:customerB,groupId:gB,mode:'Management',validDays:365,maxDevices:10000,name:'x'.repeat(80)}),await authorization());
 const stored=(await rows()).find(entry=>entry.id===grouped.id);
 assert.deepEqual([stored.customer_id,stored.group_id,stored.mode,stored.max_devices,stored.expires_at-stored.created_at],[customerB,gB,'Management',10000,365*day]);
 assert.equal(grouped.customerName,'Kunde B');
 const shortest=await installers.createCustomerInstaller(owner,input({validDays:1,maxDevices:1}),await authorization());
 assert.equal((await rows()).find(entry=>entry.id===shortest.id).expires_at-(await rows()).find(entry=>entry.id===shortest.id).created_at,day);
 assert.notEqual(grouped.key,created.key);
}));

test('create is bound to the Owner right, the active customer and the group',async()=>fixture(async({d,installers,owner,ownerAssignment,customerB,gB,authorization,rows,installerAudit,beforeBatch})=>{
 // Each call is a request with its own viewer: can() answers once per viewer object.
 const unchanged=async label=>{assert.deepEqual(await rows(),[],label+': no installer');assert.deepEqual(await installerAudit(),[],label+': no audit');};
 // The commit is the first batch of the call.
 const assignment=await d.one(sql`SELECT * FROM role_assignments WHERE id=${ownerAssignment}`);
 await rejects(beforeBatch(1,()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${ownerAssignment}`),async()=>installers.createCustomerInstaller({...owner},input(),await authorization())),refused.ownerOnly,'Owner revoked');
 await unchanged('Owner revoked');
 await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${assignment.id},${assignment.principal_type},${assignment.principal_id},${assignment.role_id},${assignment.scope_type},${assignment.scope_id},${assignment.created_at},${assignment.created_by})`);
 await rejects(beforeBatch(1,()=>d.exec(sql`UPDATE customers SET status='disabled' WHERE id=${customerB}`),async()=>installers.createCustomerInstaller({...owner},input({customerId:customerB}),await authorization())),refused.disabled,'customer disabled');
 await unchanged('customer disabled');
 await d.exec(sql`UPDATE customers SET status='active' WHERE id=${customerB}`);
 await rejects(beforeBatch(1,()=>d.exec(sql`DELETE FROM device_groups WHERE id=${gB}`),async()=>installers.createCustomerInstaller({...owner},input({customerId:customerB,groupId:gB}),await authorization())),refused.group,'group deleted');
 await unchanged('group deleted');
 const used=await authorization();await d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${used.tokenHash}`);
 await rejects(installers.createCustomerInstaller({...owner},input(),used),refused.proofUsed,'used proof');
 await unchanged('used proof');
}));

// ---- Listing and revoking ---------------------------------------------------
test('revoke writes once with an audit row; again it writes nothing; technicians and unknown ids are refused',async()=>fixture(async({d,installers,owner,tech,authorization,proofExists,rows,installerAudit})=>{
 const created=await installers.createCustomerInstaller(owner,input({name:'Rollout'}),await authorization());
 await rejects(installers.revokeCustomerInstaller(tech,created.id,await authorization(tech)),refused.ownerOnly,'technician');
 await rejects(installers.revokeCustomerInstaller(owner,uuid(),await authorization()),refused.revokeMissing,'unknown id');
 await rejects(installers.revokeCustomerInstaller(owner,'kein-guid',await authorization()),refused.revokeMissing,'no GUID');
 const proof=await authorization();
 await installers.revokeCustomerInstaller(owner,created.id,proof);
 const [row]=await rows();
 assert.ok(row.revoked_at>0);assert.equal(row.revoked_by,owner.principal);
 assert.equal(await proofExists(proof),false,'the proof is consumed');
 assert.deepEqual((await installerAudit()).at(-1),{actor:owner.label,action:'Installer widerrufen',target:'Standardkunde: Rollout',serverId:null,scope:'portal'});
 const again=await authorization(),entries=await installerAudit();
 await installers.revokeCustomerInstaller(owner,created.id,again);
 assert.deepEqual(await rows(),[row],'nothing is written');assert.deepEqual(await installerAudit(),entries,'no second audit row');
 assert.ok(await proofExists(again),'the proof stays usable');
 // A revocation is final, also by SQL.
 await assert.rejects(d.exec(sql`UPDATE customer_installers SET revoked_at=NULL WHERE id=${created.id}`),/customer-installer-revoked/);
 // A used proof writes nothing.
 const second=await installers.createCustomerInstaller(owner,input({name:'Zwei'}),await authorization()),used=await authorization();
 await d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${used.tokenHash}`);
 await rejects(installers.revokeCustomerInstaller(owner,second.id,used),refused.proofUsed,'used proof');
 assert.equal((await rows()).find(entry=>entry.id===second.id).revoked_at,null);
}));

test('revoke is bound to the Owner right at commit time: a demoted Owner gets 403 and nothing is written',async()=>fixture(async({d,installers,owner,ownerAssignment,authorization,rows,installerAudit,beforeBatch})=>{
 // Each call is a request with its own viewer: can() answers once per viewer object.
 const created=await installers.createCustomerInstaller({...owner},input({name:'Rollout'}),await authorization());
 const before=[await rows(),await installerAudit()],assignment=await d.one(sql`SELECT * FROM role_assignments WHERE id=${ownerAssignment}`);
 // The pre-check passes; the commit is the first batch of the call.
 const proof=await authorization();
 await rejects(beforeBatch(1,()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${ownerAssignment}`),()=>installers.revokeCustomerInstaller({...owner},created.id,proof)),refused.ownerOnly,'Owner revoked');
 assert.deepEqual([await rows(),await installerAudit()],before,'Owner revoked: nothing written');
 await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${assignment.id},${assignment.principal_type},${assignment.principal_id},${assignment.role_id},${assignment.scope_type},${assignment.scope_id},${assignment.created_at},${assignment.created_by})`);
 await installers.revokeCustomerInstaller({...owner},created.id,await authorization());
 assert.ok((await rows()).find(entry=>entry.id===created.id).revoked_at>0,'restored: the revoke applies');
}));

// ---- The route -------------------------------------------------------------
test('POST create-installer answers with the script file; GET lists installers and groups without secrets',async()=>fixture(async({d,owner,tech,customerB,gA,gB,post,get,rows,counters,env})=>{
 // The real route creates an installer without any license; a technician is refused,
 // and without an MFA confirmation nothing is written.
 assert.deepEqual(await keyed(await post(tech,{action:'create-installer',...input()})),refused.ownerOnly,'a technician');
 assert.equal((await post(owner,{action:'create-installer',...input()},{proof:false})).status,403,'no MFA confirmation');
 assert.deepEqual(await rows(),[],'nothing written without Owner and MFA');
 let response=await post(owner,{action:'create-installer',...input({name:'Rollout Nord/Süd',groupId:gA})});
 assert.equal(response.status,200,await response.clone().text());
 assert.equal(response.headers.get('content-type'),'application/octet-stream');
 assert.equal(response.headers.get('content-disposition'),'attachment; filename="Install-ServerDesk-Standardkunde-Rollout_Nord_S_d.ps1"');
 assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 const bytes=Buffer.from(await response.arrayBuffer());
 assert.deepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf],'the script starts with a BOM');
 const script=bytes.subarray(3).toString('utf8');
 const embedded=JSON.parse(/\$Enrollment='(.*)'\|ConvertFrom-Json/.exec(script)[1].replaceAll("''","'"));
 assert.deepEqual(Object.keys(embedded),['origin','installerKey'],'no service token is embedded');
 assert.deepEqual({...embedded,installerKey:'k'},{origin:'https://portal.test',installerKey:'k'});
 assert.match(script,/\$Config='null'\|ConvertFrom-Json/);
 const [row]=await rows();assert.equal(row.key_hash,installerHash(embedded.installerKey),'the script carries the key of the stored hash');assert.equal(row.group_id,gA);
 // Long names are cut to 40 characters each.
 await d.exec(sql`UPDATE customers SET name=${'Kunde mit einem sehr langen Namen GmbH & Co. KG Nord'} WHERE id=${customerB}`);
 response=await post(owner,{action:'create-installer',...input({customerId:customerB,groupId:gB,name:'y'.repeat(60)})});
 assert.equal(response.headers.get('content-disposition'),`attachment; filename="Install-ServerDesk-${'Kunde_mit_einem_sehr_langen_Namen_GmbH__'.slice(0,40)}-${'y'.repeat(40)}.ps1"`);
 // GET: installers and device groups, never a key or a hash.
 const listed=await (await get(owner)).json();
 assert.equal(listed.installers.length,2);
 assert.deepEqual(listed.deviceGroups.map(group=>group.name),['Gruppe A','Gruppe A zwei','Gruppe B']);
 assert.deepEqual(Object.keys(listed.deviceGroups[0]).sort(),['customerId','id','name']);
 const text=JSON.stringify(listed);
 for(const stored of await rows())assert.ok(!text.includes(stored.key_hash),'no hash in the list');
 assert.ok(!text.includes(embedded.installerKey)&&!/key_?hash|installerKey/i.test(text),'no key in the list');
 // Portal prerequisites: 503 before the MFA proof, nothing written.
 const before=(await rows()).length,reads=counters.mfaReads;
 const signing=env.AGENT_JOB_SIGNING_KEY;env.AGENT_JOB_SIGNING_KEY='';
 response=await post(owner,{action:'create-installer',...input()});
 assert.deepEqual(await keyed(response),refused.signingMissing);
 env.AGENT_JOB_SIGNING_KEY='kein-schluessel';
 assert.equal((await post(owner,{action:'create-installer',...input()})).status,503,'an unreadable signing key');
 env.AGENT_JOB_SIGNING_KEY=signing;env.SITE_ORIGIN='http://portal.test';
 response=await post(owner,{action:'create-installer',...input()});
 assert.deepEqual(await keyed(response),refused.origin);
 env.SITE_ORIGIN='https://portal.test/pfad';
 assert.equal((await post(owner,{action:'create-installer',...input()})).status,503,'an origin with a path');
 env.SITE_ORIGIN='https://portal.test';
 assert.equal((await rows()).length,before,'no installer without the prerequisites');assert.equal(counters.mfaReads,reads,'refused before the MFA proof');
}));

test('POST revoke-installer answers with the GET shape; technicians and unknown ids are refused',async()=>fixture(async({owner,tech,post,get,rows,installers,authorization})=>{
 const created=await installers.createCustomerInstaller(owner,input({name:'Alt'}),await authorization());
 assert.equal((await post(tech,{action:'revoke-installer',id:created.id})).status,403,'technicians are refused');
 const response=await post(owner,{action:'revoke-installer',id:created.id});
 assert.equal(response.status,200,await response.clone().text());
 const state=await response.json();
 assert.equal(state.installers[0].status,'revoked','the answer has the GET shape');
 assert.equal(Object.hasOwn(state,'edition'),false,'no edition field');
 assert.deepEqual(Object.keys(state).sort(),Object.keys(await (await get(owner)).json()).sort());
 assert.ok((await rows())[0].revoked_at>0);
 const missing=await post(owner,{action:'revoke-installer',id:uuid()});
 assert.deepEqual(await keyed(missing),refused.revokeMissing);
}));

// ---- Enrollment without a session ------------------------------------------

test('concurrent enrollments never exceed max_devices; a revoked installer stops at once',async()=>fixture(async({d,customerB,enroll,answer,count,seed,owner,authorization,installers})=>{
 const single=await seed({customer:customerB,maxDevices:1});
 const results=await Promise.all([enroll({installerKey:single.key,name:'SRV-A'}),enroll({installerKey:single.key,name:'SRV-B'})].map(async request=>answer(await request)));
 assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
 assert.equal(await count(sql`SELECT count(*) AS n FROM servers WHERE customer_id=${customerB}`),1,'exactly one device');
 assert.equal((await d.one(sql`SELECT enrollments FROM customer_installers WHERE id=${single.id}`)).enrollments,1);
 await assert.rejects(d.exec(sql`UPDATE customer_installers SET enrollments=2 WHERE id=${single.id}`),error=>error.code==='23514','the CHECK caps the counter');
 // Revoking stops the next enrollment; the enrolled device stays.
 const created=await installers.createCustomerInstaller(owner,input({customerId:customerB,name:'Widerruf'}),await authorization());
 const first=await answer(await enroll({installerKey:created.key,name:'SRV-W'}));assert.equal(first.status,200);
 await installers.revokeCustomerInstaller(owner,created.id,await authorization());
 const stopped=await answer(await enroll({installerKey:created.key,name:'SRV-W2'}));assert.deepEqual([stopped.status,stopped.body.code,stopped.body.messageKey],[403,'INSTALLER_REVOKED','apiError.installer.revoked']);
 assert.equal((await d.one(sql`SELECT customer_id,revoked FROM servers WHERE id=${first.body.id}`)).customer_id,customerB,'the enrolled device stays');
}));

// ---- Listing, enrollment and the rate limit ---------------------------------------
test('listCustomerInstallers names the first matching status and never the key',async()=>fixture(async({d,time,installers,customerB,gA,seed})=>{
 const now=time(),gone=uuid();
 await d.exec(sql`INSERT INTO device_groups(id,name,description,created_at,parent_id,customer_id) VALUES(${gone},${'Weg'},${''},${now},${null},${customerB})`);
 const cases=[
  ['revoked',{name:'revoked',expiresAt:now-day,maxDevices:1,enrollments:1,revokedAt:now-1}],
  ['expired',{name:'expired',expiresAt:now,maxDevices:1,enrollments:1}],
  ['exhausted',{name:'exhausted',customer:customerB,group:gone,maxDevices:2,enrollments:2}],
  ['group-missing',{name:'group-missing',customer:customerB,group:gone}],
  ['active',{name:'active',group:gA,maxDevices:3,enrollments:2}],
  ['active',{name:'active ohne Gruppe'}],
 ];
 let created=now;
 for(const [,options] of cases)await seed({...options,createdAt:created++});
 await d.exec(sql`DELETE FROM device_groups WHERE id=${gone}`);
 const list=await installers.listCustomerInstallers(now);
 assert.deepEqual(list.map(entry=>[entry.name,entry.status]),[...cases].reverse().map(([status,options])=>[options.name,status]),'newest first, status in order');
 assert.deepEqual(Object.keys(list[0]).sort(),['createdAt','customerId','enrollments','expiresAt','groupId','groupName','id','lastUsedAt','maxDevices','mode','name','revokedAt','status']);
 assert.equal(list.find(entry=>entry.name==='active').groupName,'Gruppe A');
 assert.equal(list.find(entry=>entry.name==='group-missing').groupName,null);
 assert.ok(!JSON.stringify(list).match(/key|hash/i),'neither key nor hash');
 // The time argument decides "expired".
 assert.equal((await installers.listCustomerInstallers(now-1)).find(entry=>entry.name==='expired').status,'exhausted');
}));

const registrationKeys=['customerName','id','jobSigningKey','mode','origin','token'];
test('an installer enrolls a device with its own customer and group; the token works; the request cannot name a customer',async()=>fixture(async({d,time,customerB,gA,gB,enroll,answer,count,serverCount,seed,deviceTokens,installers})=>{
 const plain=await seed({name:'Rollout A'});
 const result=await answer(await enroll({installerKey:plain.key,name:'  SRV-01.lab  '}));
 assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.cache,'no-store');
 assert.deepEqual(Object.keys(result.body).sort(),registrationKeys);
 assert.match(result.body.id,/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);assert.match(result.body.token,/^[a-f0-9]{64}$/);
 assert.deepEqual([result.body.origin,result.body.mode,result.body.customerName],['https://portal.test','ReadOnly','Standardkunde']);
 assert.ok(result.body.jobSigningKey.length>40,'the job-signing public key');
 const device=await d.one(sql`SELECT * FROM servers WHERE id=${result.body.id}`);
 assert.deepEqual([device.customer_id,device.name,device.token_hash],[customerA,'SRV-01.lab',sha(result.body.token)]);
 assert.equal(device.name_source,'hostname','the installer sends the computer name, so the device name follows it (lib/device-name.ts)');
 assert.equal(device.token_expires_at-device.created_at,86400000,'an installer registration expires after 24 hours');
 assert.equal(await count(sql`SELECT count(*) AS n FROM device_group_members WHERE server_id=${device.id}`),0,'no group');
 const installer=await d.one(sql`SELECT * FROM customer_installers WHERE id=${plain.id}`);
 assert.equal(installer.enrollments,1);assert.ok(installer.last_used_at>0);
 const audit=await d.query(sql`SELECT actor,action,target,server_id AS "serverId",scope FROM audit WHERE server_id=${device.id}`).then(results=>({results}));
 assert.deepEqual(audit.results.map(row=>({...row})),[{actor:'Installer „Rollout A“',action:'Agent über Installer registriert',target:'SRV-01.lab',serverId:device.id,scope:'device'}]);
 assert.ok(!JSON.stringify(audit.results).includes(plain.key)&&!JSON.stringify(audit.results).includes(installerHash(plain.key)));
 // The device token passes the heartbeat guard.
 const guard=deviceTokens.deviceTokenSql(sha(result.body.token),time());
 assert.equal((await d.one(sql`SELECT id FROM servers WHERE id=${device.id} AND ${guard}`))?.id,device.id);
 // With a group: the device is a member of exactly that group.
 const grouped=await seed({name:'Gruppe',group:gA,mode:'Management'});
 const second=await answer(await enroll({installerKey:grouped.key,name:'SRV-02'}));
 assert.equal(second.status,200);assert.equal(second.body.mode,'Management','the mode comes from the installer');
 assert.deepEqual((await d.query(sql`SELECT group_id FROM device_group_members WHERE server_id=${second.body.id}`)).map(row=>row.group_id),[gA]);
 // Any further key is refused, and no device is created.
 const devices=await serverCount();
 for(const extra of [{customerId:customerB},{groupId:gB},{mode:'Management'},{id:crypto.randomUUID()},{token:'a'.repeat(64)}]){
  const refused=await answer(await enroll({installerKey:plain.key,name:'SRV-X',...extra}));
  assert.deepEqual([refused.status,refused.body.error,refused.cache],[400,messages.request,'no-store'],JSON.stringify(extra));
 }
 for(const [payload,message,raw] of [
  [{installerKey:plain.key,name:'SRV/01'},messages.deviceName],[{installerKey:plain.key,name:'   '},messages.deviceName],[{installerKey:plain.key,name:'x'.repeat(65)},messages.deviceName],
  [{installerKey:plain.key},messages.request],[{installerKey:plain.key,name:7},messages.request],[{installerKey:42,name:'SRV'},messages.request],[{installerKey:plain.key.toUpperCase(),name:'SRV'},messages.request],
  [null,messages.request,'["x"]'],[null,messages.request,'"text"'],[null,messages.request,'kein json'],[null,messages.request,JSON.stringify({installerKey:plain.key,name:'SRV',pad:'x'.repeat(5000)})],
 ]){
  const refused=await answer(await enroll(payload,{raw}));
  assert.deepEqual([refused.status,refused.body.error],[400,message],raw?.slice(0,40)??JSON.stringify(payload));
 }
 assert.equal(await serverCount(),devices,'no device from a refused request');
 assert.equal((await d.one(sql`SELECT enrollments FROM customer_installers WHERE id=${plain.id}`)).enrollments,1);
 assert.equal((await installers.listCustomerInstallers()).length,2);
}));

test('invalid, revoked, expired, exhausted, disabled and group-less installers create no device',async()=>fixture(async({d,time,customerB,gA2,gB,enroll,answer,count,serverCount,seed,env})=>{
 const devices=await serverCount();
 const expect=async(key,status,code,message,label)=>{const result=await answer(await enroll({installerKey:key,name:'SRV'}));assert.deepEqual([result.status,result.body.code,result.body.error,result.cache],[status,code,message,'no-store'],label);};
 await expect(randomKey(),403,'INSTALLER_INVALID',messages.invalid,'unknown key');
 // A device token is no installer key: the hashes are domain-separated.
 const deviceToken=randomKey();
 await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id) VALUES(${uuid()},${'Bestand'},${sha(deviceToken)},${time()},${customerA})`);
 await expect(deviceToken,403,'INSTALLER_INVALID',messages.invalid,'device token');
 await expect((await seed({revokedAt:time()-1,expiresAt:time()-1})).key,403,'INSTALLER_REVOKED',messages.revoked,'revoked');
 await expect((await seed({expiresAt:time()})).key,403,'INSTALLER_EXPIRED',messages.expired,'expired');
 const single=await seed({maxDevices:1});
 assert.equal((await answer(await enroll({installerKey:single.key,name:'SRV-1'}))).status,200);
 await expect(single.key,409,'INSTALLER_EXHAUSTED',messages.exhausted,'exhausted');
 const forB=await seed({customer:customerB});
 await d.exec(sql`UPDATE customers SET status='disabled' WHERE id=${customerB}`);
 await expect(forB.key,409,'CUSTOMER_DISABLED',messages.customerDisabled,'customer disabled later');
 await d.exec(sql`UPDATE customers SET status='active' WHERE id=${customerB}`);
 const withGroup=await seed({customer:customerB,group:gB});
 await d.exec(sql`DELETE FROM device_groups WHERE id=${gB}`);
 await expect(withGroup.key,409,'INSTALLER_GROUP_MISSING',messages.groupMissing,'group deleted');
 // A group of A moved to B by SQL: the installer of A creates nothing, and nothing at B.
 const moved=await seed({group:gA2});
 await d.exec(sql`UPDATE device_groups SET customer_id=${customerB} WHERE id=${gA2}`);
 await expect(moved.key,409,'INSTALLER_GROUP_MISSING',messages.groupMissing,'group of another customer');
 assert.equal(await count(sql`SELECT count(*) AS n FROM servers WHERE customer_id=${customerB}`),0,'no device at B');
 // Without the signing key or a secure origin: 503 before any write.
 const usable=await seed();
 env.AGENT_JOB_SIGNING_KEY='';
 let result=await answer(await enroll({installerKey:usable.key,name:'SRV'}));
 assert.deepEqual([result.status,result.body.error],[503,messages.signingMissing]);
 env.AGENT_JOB_SIGNING_KEY=jobSigningKey;env.SITE_ORIGIN='http://portal.test';
 result=await answer(await enroll({installerKey:usable.key,name:'SRV'}));
 assert.deepEqual([result.status,result.body.error],[503,messages.origin]);
 env.SITE_ORIGIN='https://portal.test';
 assert.equal(await serverCount(),devices+2,'only the bestand device and the one enrollment of `single` exist');
 assert.equal((await d.one(sql`SELECT enrollments FROM customer_installers WHERE id=${usable.id}`)).enrollments,0);
}));

test('the rate limit answers 429 before any database access',async()=>fixture(async({load,imports,installers,enroll,answer,counters,seed})=>{
 const {key}=await seed();
 const limiter=installers.createEnrollmentLimiter({limit:2,globalLimit:600});
 // The real route file, with the limiter of this test injected.
 const limitedApi=sourceLoader()('app/api/agent/enroll/route.ts',{...imports,'@/lib/server/agent/customer-installers':{...installers,enrollWithInstaller:request=>installers.enrollWithInstaller(request,limiter)}});
 for(const name of ['SRV-1','SRV-2'])assert.equal((await answer(await enroll({installerKey:key,name},{api:limitedApi}))).status,200);
 const before=counters.db;
 const third=await answer(await enroll({installerKey:key,name:'SRV-3'},{api:limitedApi}));
 assert.deepEqual([third.status,third.body.error,third.cache],[429,messages.rateLimited,'no-store']);
 assert.equal(counters.db,before,'no database access');
 // Clients behind different trusted addresses have their own window; the process window caps all.
 const shared=installers.createEnrollmentLimiter({limit:1,globalLimit:2});
 assert.deepEqual(['10.0.0.1','10.0.0.2','10.0.0.3'].map(address=>shared(address)),[true,true,false]);
 assert.equal(typeof load,'function');
}));

// ---- Only the customer move changes a device's customer ----------------------
// lib/server/devices/device-customer-move.ts is the one path (docs/customers.md "Move devices to another customer").
test('no source under app/ or lib/ but the customer move sets servers.customer_id in an UPDATE',()=>{
 const files=[];
 const walk=directory=>{for(const entry of readdirSync(directory)){const full=path.join(directory,entry);if(statSync(full).isDirectory())walk(full);else if(/\.(?:ts|tsx|mjs|js)$/.test(entry))files.push(full);}};
 for(const directory of ['app','ui','lib'])walk(directory);
 assert.ok(files.length>100);
 const offenders=files.filter(file=>/UPDATE\s+servers\b[^;`'"]*?\bSET\b[^;`'"]*?\bcustomer_id\s*=/i.test(readFileSync(file,'utf8')));
 assert.deepEqual(offenders.map(file=>file.split(path.sep).join('/')),['lib/server/devices/device-customer-move.ts']);
 assert.ok(/UPDATE\s+servers\b[^;`'"]*?\bSET\b[^;`'"]*?\bcustomer_id\s*=/i.test('UPDATE servers SET name=?,customer_id=? WHERE id=?'),'the scan finds such an update');
});
