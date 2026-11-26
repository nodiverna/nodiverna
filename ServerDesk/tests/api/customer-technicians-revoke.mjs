// Technicians of a customer through the real route /api/customers: a request
// that only removes goes through lib/server/identity/customer-technicians.ts,
// every request that adds through setCustomerTechnicians
// (lib/server/identity/customer-admin.ts). Both work without any license and
// answer without an edition field. Against an isolated PostgreSQL test
// database; only the session and the MFA proof reader are replaced.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';

import {sql} from '../../runtime/database.mjs';

import {hookDatabase} from '../support/hooked-database.mjs';
import {enableMultipleCustomers,separateCustomers} from '../support/customer-separation.mjs';
const day=86_400_000;
const customerA='00000000-0000-4000-8000-000000000100';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const uuid=()=>crypto.randomUUID();
const messages={
 ownerOnly:serverText('apiError.customer.ownerOnly'),
 technicians:serverText('apiError.customer.technicians'),
 missing:serverText('apiError.customer.gone'),
 concurrent:serverText('apiError.customer.concurrent'),
 proofUsed:serverText('apiError.mfa.confirmationUsed'),
};

const HttpError=realHttpError;
async function body(request,limit=256000){
 const bytes=Buffer.from(await request.arrayBuffer());
 if(bytes.length>limit)throw new HttpError(413,serverText('apiError.request.tooLarge'));
 let parsed;try{parsed=JSON.parse(bytes.toString('utf8'));}catch{throw new HttpError(400,serverText('apiError.request.invalidJson'));}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new HttpError(400,serverText('apiError.request.invalidJson'));
 return parsed;
}
const failure=error=>Response.json({error:error instanceof HttpError?error.message:serverText('apiError.storageUnavailable'),...(error instanceof HttpError&&error.code?{code:error.code}:{})},{status:error instanceof HttpError?error.status:503,headers:{'Cache-Control':'no-store'}});

// One isolated portal per test: real access, RBAC, customers and the route code.
async function fixture(run){
 const d=await sourceDatabase();
 const clock={offset:0},time=()=>Date.now()+clock.offset;
 const counters={mfaReads:0};
 let viewer=null,hook=null;
 const facade=hookDatabase(d,{transaction:async()=>{if(hook&&--hook.n===0){const action=hook.action;hook=null;await action();}}});
 const server={db:()=>facade,now:time,config:()=>'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>sha(value),HttpError,body,failure,
  guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value),sameOrigin:()=>{},
  requireViewer:async()=>{if(!viewer)throw new HttpError(401,'Bitte anmelden.');return viewer;},
  log:async(actor,action,target,serverId)=>{await d.exec(sql`INSERT INTO audit(at,actor,action,target,server_id,scope) VALUES(${time()},${actor},${action},${target},${serverId??null},${serverId?'device':'portal'})`);}};
 const mfa={requireMfa:async()=>{},isMfaEnabled:async()=>true,
  readMfaManagementProof:async(_request,actor,token)=>{counters.mfaReads++;if(typeof token!=='string')throw new HttpError(403,'Bestätige die Aktion.','MFA_STEP_UP_REQUIRED');return {tokenHash:token,key:actor.principal,sessionHash:sha(actor.id+'mfa'),guard:sql`TRUE`};}};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./mfa':mfa,'@/lib/server/identity/mfa':mfa};
 const load=sourceLoader();
 const access=load('lib/server/identity/access.ts',imports);
 imports['./local-auth']={primaryGuard:async(_request,actor)=>access.viewerWriteGuard(actor)};
 const customersApi=load('app/api/customers/route.ts',imports);
 const technicians=load('lib/server/identity/customer-technicians.ts',imports),rbac=load('lib/server/identity/rbac.ts',imports),customers=load('lib/server/identity/customers.ts',imports);

 // ---- Fixture ----------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const owner=await sourceActor(d,'owner@technicians.test',['*']);
 const people={};
 for(const name of ['tech1','tech2','member'])people[name]=(await sourceActor(d,name+'@technicians.test',[...access.allPermissions])).actor;
 for(const actor of [owner.actor,people.tech1]){actor.userId=actor.id;await insert('mfa_sessions',{token_hash:sha(actor.id+'mfa'),principal:actor.principal,created_at:time(),last_activity:time(),idle_expires_at:time()+30*day,expires_at:time()+30*day});}
 for(const [name,actor] of Object.entries(people))await insert('local_auth_sessions',{token_hash:'session-'+name,user_id:actor.id,auth_version:1,created_at:time(),expires_at:time()+day,pending_until:time()});
 const team=uuid();
 await insert('user_groups',{id:team,name:'Team Nord',description:'',enabled:1,created_at:time()});
 await insert('user_group_members',{group_id:team,user_id:people.member.id});
 const device=uuid(),job=uuid();
 await insert('servers',{id:device,name:'SRV-01',token_hash:sha(device),created_at:time()});
 await insert('jobs',{id:job,server_id:device,action:'refresh',target:'Inventory',created_at:time(),actor:'tech1',actor_email:'tech1@technicians.test',actor_principal:people.tech1.principal,parameters:'{}'});
 // tech1, tech2 and the group see the first customer; set by SQL.
 const assign=async(...subjects)=>{for(const [type,id] of subjects)await insert('customer_assignments',{customer_id:customerA,principal_type:type,principal_id:id,created_at:time(),created_by:owner.actor.principal});};
 const seed=()=>assign(['user',people.tech1.id],['user',people.tech2.id],['group',team]);

 let lastToken=null;
 const token=async(actor=owner.actor)=>{const value=uuid();await insert('mfa_management_proofs',{token_hash:value,principal:actor.principal,session_hash:sha(actor.id+'mfa'),expires_at:time()+300_000});lastToken=value;return value;};
 const authorization=async(actor=owner.actor)=>rbac.prepareManagementAuthorization(new Request('https://portal.test/api/customers'),actor,await token(actor));
 const proofExists=async value=>Number((await d.one(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${typeof value==='string'?value:value.tokenHash}`)).n)===1;
 const post=async(actor,payload,{proof=true}={})=>{viewer=actor;return customersApi.POST(new Request('https://portal.test/api/customers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'set-technicians',id:customerA,...payload,...(proof?{managementToken:await token(actor)}:{})})}));};
 const get=async actor=>{viewer=actor;return customersApi.GET(new Request('https://portal.test/api/customers'));};
 const assignments=async()=>(await d.query(sql`SELECT principal_type AS type,principal_id AS id FROM customer_assignments WHERE customer_id=${customerA} ORDER BY principal_type,principal_id`)).map(row=>[row.type,row.id]);
 const audit=async()=>(await d.query(sql`SELECT actor,action,target,scope FROM audit WHERE action='Techniker geändert' ORDER BY id`)).map(row=>({...row}));
 const customerRow=async()=>({...await d.one(sql`SELECT revision,updated_at FROM customers WHERE id=${customerA}`)});
 const state=async()=>({assignments:await assignments(),customer:await customerRow(),audit:await audit()});
 const sessions=async name=>Number((await d.one(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE user_id=${people[name].id}`)).n);
 const jobState=async()=>(await d.one(sql`SELECT state FROM jobs WHERE id=${job}`)).state;
 // Runs `action` right before the nth batch from now on.
 const beforeBatch=async(n,action,call)=>{hook={n,action};try{return await call();}finally{hook=null;}};
 try{
  return await run({d,clock,time,counters,load,imports,technicians,customers,owner:owner.actor,ownerAssignment:owner.assignmentId,people,team,
   seed,assign,token,authorization,proofExists,post,get,assignments,audit,state,sessions,jobState,beforeBatch,lastToken:()=>lastToken});
 }finally{d.close();}
}
const rejects=(promise,status,message,code,label)=>assert.rejects(promise,error=>{assert.equal(error.status,status,`${label??''}: ${error.message}`);if(message)assert.equal(error.message,message,label);if(code)assert.equal(error.code,code,label);return true;},label);
const answer=async response=>({status:response.status,body:await response.json()});

// ---- The route --------------------------------------------------------------
test('removing and adding both answer 200 through the real route, without an edition field',async()=>fixture(async({d,time,owner,people,team,seed,post,assignments,audit,sessions,jobState})=>{
 // The boundary is on: a second customer exists.
 await d.exec(enableMultipleCustomers());await d.exec(separateCustomers(time()-90*day));
 await seed();
 const {status,body:result}=await answer(await post(owner,{revision:0,userIds:[people.tech2.id],groupIds:[]}));
 assert.equal(status,200,JSON.stringify(result));
 assert.equal(Object.hasOwn(result,'edition'),false,'no edition field');
 assert.deepEqual(await assignments(),[['user',people.tech2.id]]);
 assert.deepEqual(await audit(),[{actor:owner.label,action:'Techniker geändert',target:'Standardkunde (+0 / −2)',scope:'portal'}]);
 assert.deepEqual([await sessions('tech1'),await sessions('member'),await sessions('tech2')],[0,0,1],'the removed user and the members of the removed group lose their sessions');
 assert.equal(await jobState(),'cancelled','the pending job of the removed user ends');
 // Adding, and adding together with removing, go through setCustomerTechnicians with the same audit text.
 const added=await answer(await post(owner,{revision:1,userIds:[people.tech2.id,people.tech1.id],groupIds:[team]}));
 assert.equal(added.status,200,JSON.stringify(added.body));
 assert.equal(Object.hasOwn(added.body,'edition'),false,'no edition field');
 assert.deepEqual((await assignments()).length,3);
 assert.deepEqual((await audit()).at(-1),{actor:owner.label,action:'Techniker geändert',target:'Standardkunde (+2 / −0)',scope:'portal'});
 const mixed=await answer(await post(owner,{revision:2,userIds:[people.member.id],groupIds:[team]}));
 assert.equal(mixed.status,200,JSON.stringify(mixed.body));
 assert.deepEqual(await assignments(),[['group',team],['user',people.member.id]]);
 assert.deepEqual((await audit()).at(-1),{actor:owner.label,action:'Techniker geändert',target:'Standardkunde (+1 / −2)',scope:'portal'});
 // The unchanged set writes nothing and answers 200.
 const entries=await audit();
 assert.equal((await answer(await post(owner,{revision:3,userIds:[people.member.id],groupIds:[team]}))).status,200);
 assert.deepEqual(await audit(),entries,'the unchanged set writes no audit row');
}));

// ---- Refusals of the core function ------------------------------------------------
test('removeCustomerTechnicians refuses non-Owners, invalid lists, unknown customers, stale revisions and additions without writing',async()=>fixture(async({technicians,owner,people,team,seed,state,authorization,proofExists})=>{
 await seed();
 const before=await state(),remove=(extra={},actor=owner,id=customerA)=>async proof=>technicians.removeCustomerTechnicians(actor,id,{userIds:[people.tech2.id],groupIds:[team],revision:0,...extra},proof);
 let proof=await authorization(people.tech1);
 await rejects(remove({},people.tech1)(proof),403,messages.ownerOnly,undefined,'non-Owner');
 assert.ok(await proofExists(proof),'non-Owner keeps the proof');
 const many=Array.from({length:1001},()=>uuid());
 for(const extra of [{userIds:'x'},{groupIds:null},{userIds:undefined},{userIds:{0:people.tech1.id}},{userIds:['kein-guid']},{userIds:[42]},{groupIds:['x']},{userIds:many},{groupIds:many}]){
  proof=await authorization();
  await rejects(remove(extra)(proof),400,messages.technicians,undefined,JSON.stringify(extra).slice(0,60));
  assert.ok(await proofExists(proof),'invalid ids keep the proof');
 }
 await rejects(remove({},owner,uuid())(await authorization()),404,messages.missing,undefined,'unknown customer');
 await rejects(remove({},owner,'kein-guid')(await authorization()),404,messages.missing,undefined,'no GUID');
 await rejects(remove({revision:1})(await authorization()),409,messages.concurrent,undefined,'stale revision');
 await rejects(remove({revision:undefined})(await authorization()),409,messages.concurrent,undefined,'missing revision');
 await rejects(remove({revision:'0'})(await authorization()),409,messages.concurrent,undefined,'revision as text');
 for(const [label,extra] of [['adds a user',{userIds:[people.tech1.id,people.tech2.id,people.member.id]}],['adds and removes',{userIds:[people.member.id]}],['adds an unknown user',{userIds:[people.tech2.id,uuid()]}]]){
  proof=await authorization();
  await rejects(remove(extra)(proof),409,messages.concurrent,undefined,label);
  assert.ok(await proofExists(proof),label+': the proof stays');
 }
 assert.deepEqual(await state(),before,'nothing was written');
 // The stored set again: a success without a write, and the proof stays usable.
 proof=await authorization();
 await technicians.removeCustomerTechnicians(owner,customerA,{userIds:[people.tech2.id,people.tech1.id,people.tech1.id],groupIds:[team],revision:0},proof);
 assert.deepEqual(await state(),before,'the same set writes nothing');assert.ok(await proofExists(proof),'the proof stays usable');
 await remove()(proof);
 assert.equal(await proofExists(proof),false,'the same proof then removes tech1');
 assert.equal((await state()).customer.revision,1);
}));

// ---- The commit is bound live -----------------------------------------------------
test('the removal is bound to the Owner right, the customer revision and the proof at commit time',async()=>fixture(async({d,technicians,owner,ownerAssignment,people,team,seed,state,authorization,beforeBatch})=>{
 await seed();
 // Each call is a request with its own viewer: can() answers once per viewer object.
 const call=proof=>technicians.removeCustomerTechnicians({...owner},customerA,{userIds:[people.tech2.id],groupIds:[team],revision:0},proof);
 let before=await state();
 // The commit is the first batch of the call.
 const assignment=await d.one(sql`SELECT * FROM role_assignments WHERE id=${ownerAssignment}`);
 let proof=await authorization();
 await rejects(beforeBatch(1,()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${ownerAssignment}`),()=>call(proof)),403,messages.ownerOnly,undefined,'Owner revoked');
 assert.deepEqual(await state(),before,'Owner revoked: nothing written');
 await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${assignment.id},${assignment.principal_type},${assignment.principal_id},${assignment.role_id},${assignment.scope_type},${assignment.scope_id},${assignment.created_at},${assignment.created_by})`);
 proof=await authorization();
 await rejects(beforeBatch(1,()=>d.exec(sql`UPDATE customers SET revision=revision+1 WHERE id=${customerA}`),()=>call(proof)),409,messages.concurrent,undefined,'customer revision');
 const bumped=await state();
 assert.deepEqual([bumped.assignments,bumped.audit,bumped.customer.updated_at],[before.assignments,before.audit,before.customer.updated_at],'customer revision: only the bump itself');
 await d.exec(sql`UPDATE customers SET revision=0 WHERE id=${customerA}`);
 before=await state();
 proof=await authorization();
 await rejects(beforeBatch(1,()=>d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash}`),()=>call(proof)),403,messages.proofUsed,'MFA_STEP_UP_REQUIRED','proof deleted');
 assert.deepEqual(await state(),before,'proof deleted: nothing written');
 // Unhindered, the same request applies.
 await call(await authorization());
 assert.deepEqual((await state()).assignments,[['group',team],['user',people.tech2.id]]);
}));

// ---- The classification ------------------------------------------------------------
test('techniciansRemoveOnly is true only for a valid removal without additions and never writes',async()=>fixture(async({technicians,people,team,seed,state})=>{
 await seed();
 const before=await state(),only=(userIds,groupIds,id=customerA)=>technicians.techniciansRemoveOnly(id,{userIds,groupIds});
 assert.equal(await only([people.tech2.id],[]),true,'removes tech1 and the group');
 assert.equal(await only([people.tech1.id,people.tech2.id,people.tech1.id],[]),true,'duplicates are ignored');
 for(const [label,result] of [
  ['an addition',only([people.tech1.id,people.tech2.id,people.member.id],[team])],
  ['add and remove',only([people.member.id],[team])],
  ['unchanged',only([people.tech2.id,people.tech1.id],[team])],
  ['user list not an array',only('x',[])],
  ['group list missing',only([],undefined)],
  ['too many ids',only(Array.from({length:1001},()=>uuid()),[])],
  ['unknown customer',only([],[],uuid())],
  ['customer id not a GUID',only([],[],'kein-guid')],
  ['an id not a GUID',only(['kein-guid'],[])],
  ['an unknown user',only([people.tech2.id,uuid()],[])],
 ])assert.equal(await result,false,label);
 assert.equal(await technicians.techniciansRemoveOnly(customerA,undefined),false,'no input');
 assert.equal(await technicians.techniciansRemoveOnly(customerA,null),false,'null input');
 assert.deepEqual(await state(),before,'nothing was written');
}));

// ---- The shared texts ---------------------------------------------------------
test('the three texts of the removal live once in lib/server/identity/customers.ts',async()=>fixture(async({customers})=>{
 assert.deepEqual([customers.customerTechniciansMessage,customers.customerMissingMessage,customers.customerConcurrentMessage],[messages.technicians,messages.missing,messages.concurrent]);
}));
