// The setting "Multiple customers" through the real route app/api/customers/route.ts
// (lib/server/identity/multiple-customers.ts, docs/customers.md): a new portal
// starts off; create is refused while it is off; set-multiple-customers needs a
// global Owner and a management MFA proof, a boolean and the stored revision;
// it writes the value, the revision, one audit row and the use of the proof in
// one batch; switching off is refused while another customer exists, also when
// that customer appears between the check and the commit; the same value writes
// nothing; the writes for the default customer keep working while it is off.
// Against an isolated PostgreSQL test database; only the request environment
// (session, MFA proof reader) is replaced.
import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {HttpError} from '../support/http-error.mjs';
const {apiErrorBody,classifyFailure}=await import('../../lib/server/errors/failure.ts');

const day=86_400_000,defaultCustomer='00000000-0000-4000-8000-000000000100';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const uuid=()=>crypto.randomUUID();
const jobSigningKey=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'});
// Each refusal as [status, code, message key] (lib/errors/api-error-keys.ts).
const refused={
 ownerOnly:[403,'FORBIDDEN','apiError.customer.ownerOnly'],
 stepUp:[403,'MFA_STEP_UP_REQUIRED','apiError.mfa.stepUpRequired'],
 invalid:[400,'INVALID_REQUEST','apiError.request.invalid'],
 off:[409,'MULTIPLE_CUSTOMERS_OFF','apiError.customer.multipleCustomersOff'],
 inUse:[409,'MULTIPLE_CUSTOMERS_IN_USE','apiError.customer.multipleCustomersInUse'],
 changed:[409,'CONFLICT','apiError.customer.multipleCustomersChanged'],
};

// The production body reader: size limit, JSON, objects only.
async function body(request){
 let parsed;try{parsed=JSON.parse(Buffer.from(await request.arrayBuffer()).toString('utf8'));}catch{throw new HttpError('apiError.request.invalidJson');}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new HttpError('apiError.request.invalidJson');
 return parsed;
}
// As lib/server/context.ts failure(): an HttpError answers with its status, code and message key.
const failure=error=>{const answer=error instanceof HttpError?classifyFailure(error):{status:503,body:apiErrorBody('apiError.storageUnavailable')};return Response.json(answer.body,{status:answer.status,headers:{'Cache-Control':'no-store'}});};
const keyed=async response=>{const sent=await response.json();return [response.status,sent.code,sent.messageKey];};

// One isolated new portal per call: only the default customer, the setting off.
async function fixture(run){
 const d=await sourceDatabase(),time=()=>Date.now();
 const env={SITE_ORIGIN:'https://portal.test',AGENT_JOB_SIGNING_KEY:jobSigningKey};
 let viewer=null,hook=null;
 const facade=hookDatabase(d,{transaction:async()=>{if(hook&&--hook.n===0){const action=hook.action;hook=null;await action();}}});
 const server={db:()=>facade,now:time,config:key=>env[key]??'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>sha(value),HttpError,body,failure,
  guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value),sameOrigin:()=>{},
  requireViewer:async()=>{if(!viewer)throw new HttpError('apiError.auth.loginRequired');return viewer;},
  log:async()=>{throw new Error('the customer route writes its audit rows in its own batches');}};
 // The live MFA login session holds (create, set-status and a harmless update commit behind it).
 const mfa={requireMfa:async()=>{},isMfaEnabled:async()=>true,mfaSessionFence:async()=>sql`TRUE`,requireLiveSessions:async()=>{},
  readMfaManagementProof:async(_request,actor,token)=>{if(typeof token!=='string')throw new HttpError('apiError.mfa.stepUpRequired');return {tokenHash:token,key:actor.principal,sessionHash:sha(actor.id+'mfa'),guard:sql`TRUE`};}};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./mfa':mfa,'../identity/mfa':mfa,'./identity/mfa':mfa,'@/lib/server/identity/mfa':mfa};
 const load=sourceLoader();
 const access=load('lib/server/identity/access.ts',imports);
 imports['./local-auth']=imports['./identity/local-auth']={primaryGuard:async(_request,actor)=>access.viewerWriteGuard(actor)};
 const route=load('app/api/customers/route.ts',imports);
 const insert=(table,row)=>insertRow(d,table,row);
 const owner=(await sourceActor(d,'owner@multiple.test',['*'])).actor;
 const tech=(await sourceActor(d,'tech@multiple.test',[...access.allPermissions])).actor;
 for(const actor of [owner,tech]){actor.userId=actor.id;await insert('mfa_sessions',{token_hash:sha(actor.id+'mfa'),principal:actor.principal,created_at:time(),last_activity:time(),idle_expires_at:time()+30*day,expires_at:time()+30*day});}
 const token=async(actor=owner)=>{const value=uuid();await insert('mfa_management_proofs',{token_hash:value,principal:actor.principal,session_hash:sha(actor.id+'mfa'),expires_at:time()+300_000});return value;};
 const proofExists=async value=>Number((await d.one(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${value}`)).n)===1;
 const request=payload=>new Request('https://portal.test/api/customers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 /** POST with a fresh proof (managementToken null: none); the answer and the token. */
 const post=async(actor,payload,{managementToken}={})=>{const value=managementToken===undefined?await token(actor):managementToken;viewer=actor;return {response:await route.POST(request({...payload,...(value===null?{}:{managementToken:value})})),token:value};};
 const get=async actor=>{viewer=actor;return route.GET(new Request('https://portal.test/api/customers'));};
 const setting=async()=>({...await d.one(sql`SELECT multiple_customers,revision,updated_at,updated_by FROM customer_settings`)});
 const customerCount=async()=>Number((await d.one(sql`SELECT count(*) AS n FROM customers`)).n);
 const audit=async()=>(await d.query(sql`SELECT actor,action,target,customer_id AS "customerId" FROM audit WHERE action LIKE 'customers.multiple.%' OR action='Kunde angelegt' ORDER BY id`)).map(row=>({...row}));
 // Runs `action` right before the nth batch from now on: the commit of a write.
 const beforeBatch=async(n,action,call)=>{hook={n,action};try{return await call();}finally{hook=null;}};
 try{return await run({d,owner,tech,token,proofExists,post,get,setting,customerCount,audit,beforeBatch,insert});}
 finally{d.close();}
}
const turn=(enabled,revision)=>({action:'set-multiple-customers',enabled,revision});

test('a new portal starts off, refuses create, and an Owner with a proof turns the setting on',async()=>fixture(async({owner,tech,post,get,setting,customerCount,audit,proofExists})=>{
 const response=await get(owner);
 assert.equal(response.status,200);
 assert.deepEqual((await response.json()).multipleCustomers,{enabled:false,otherCustomers:0,revision:0},'a new portal: off, no other customer, revision 0');
 assert.deepEqual(await keyed(await get(tech)),refused.ownerOnly,'GET stays Owner-only');
 // Create while off: no customer, no audit row, the proof stays.
 let sent=await post(owner,{action:'create',name:'Kunde B'});
 assert.deepEqual(await keyed(sent.response),refused.off);
 assert.deepEqual([await customerCount(),await audit(),await proofExists(sent.token)],[1,[],true],'no customer, no audit row, the proof is not used');
 // set-multiple-customers: Owner only, a proof, a boolean.
 assert.deepEqual(await keyed((await post(tech,turn(true,0))).response),refused.ownerOnly,'a non-Owner');
 assert.deepEqual(await keyed((await post(owner,turn(true,0),{managementToken:null})).response),refused.stepUp,'no proof: the step-up code');
 for(const enabled of ['true',1,null,undefined])assert.deepEqual(await keyed((await post(owner,turn(enabled,0))).response),refused.invalid,`enabled ${JSON.stringify(enabled)}`);
 assert.deepEqual([(await setting()).multiple_customers,(await setting()).revision,await audit()],[false,0,[]],'nothing changed');
 // On with a proof: value, revision, updated_at/by, one audit row, the proof used.
 sent=await post(owner,turn(true,0));
 assert.equal(sent.response.status,200);
 const state=await sent.response.json();
 assert.deepEqual(state.multipleCustomers,{enabled:true,otherCustomers:0,revision:1},'the answer carries the new state');
 assert.deepEqual(state.customers.map(customer=>customer.id),[defaultCustomer],'and the rest of the page state');
 const stored=await setting();
 assert.deepEqual([stored.multiple_customers,stored.revision,stored.updated_by],[true,1,owner.principal]);
 assert.ok(stored.updated_at>0,'updated_at is set');
 assert.deepEqual(await audit(),[{actor:owner.label,action:'customers.multiple.enable',target:'',customerId:null}],'one audit row, empty target');
 assert.equal(await proofExists(sent.token),false,'the proof is used');
 // Now create works, and the count of other customers follows.
 sent=await post(owner,{action:'create',name:'Kunde B'});
 assert.equal(sent.response.status,200);
 const created=await sent.response.json();
 assert.deepEqual([created.multipleCustomers,created.customers.length],[{enabled:true,otherCustomers:1,revision:1},2]);
}));

test('switching off is refused while another customer exists; a stale revision and the same value change nothing',async()=>fixture(async({owner,post,setting,audit,proofExists})=>{
 assert.equal((await post(owner,turn(true,0))).response.status,200);
 assert.equal((await post(owner,{action:'create',name:'Kunde B'})).response.status,200);
 const before=await audit();
 let sent=await post(owner,turn(false,1));
 assert.deepEqual(await keyed(sent.response),refused.inUse,'off with another customer');
 assert.deepEqual([(await setting()).multiple_customers,(await setting()).revision,await audit(),await proofExists(sent.token)],[true,1,before,true],'still on, no audit row, the proof stays');
 sent=await post(owner,turn(false,0));
 assert.deepEqual(await keyed(sent.response),refused.changed,'a stale revision');
 sent=await post(owner,turn(true,1));
 assert.equal(sent.response.status,200,'the same value answers with the state');
 assert.deepEqual((await sent.response.json()).multipleCustomers,{enabled:true,otherCustomers:1,revision:1});
 assert.deepEqual([(await setting()).revision,await audit(),await proofExists(sent.token)],[1,before,true],'the same value writes nothing and keeps the proof');
}));

test('a portal with only the default customer turns the setting on and off again; a customer that appears before the commit keeps it on',async()=>fixture(async({d,owner,post,setting,audit,beforeBatch,insert})=>{
 assert.equal((await post(owner,turn(true,0))).response.status,200);
 let sent=await post(owner,turn(false,1));
 assert.equal(sent.response.status,200);
 assert.deepEqual((await sent.response.json()).multipleCustomers,{enabled:false,otherCustomers:0,revision:2});
 assert.deepEqual((await audit()).map(row=>[row.action,row.target]),[['customers.multiple.enable',''],['customers.multiple.disable','']],'one row per change');
 // On again; a customer created between the check and the commit: the update trigger refuses the switch-off.
 assert.equal((await post(owner,turn(true,2))).response.status,200);
 const entries=await audit(),other=crypto.randomUUID();
 sent=await beforeBatch(1,()=>insert('customers',{id:other,name:'Rennen',created_at:Date.now(),updated_at:Date.now()}),()=>post(owner,turn(false,3)));
 assert.deepEqual(await keyed(sent.response),refused.inUse,'the trigger answers with the same code');
 assert.deepEqual([(await setting()).multiple_customers,(await setting()).revision,await audit()],[true,3,entries],'still on, no audit row');
 assert.equal(Number((await d.one(sql`SELECT count(*) AS n FROM customers WHERE id=${other}`)).n),1);
}));

test('while the setting is off, the other writes for the default customer keep working',async()=>fixture(async({d,owner,post,get})=>{
 let sent=await post(owner,{action:'update',id:defaultCustomer,revision:0,name:'Hauptkunde',contactEmail:'it@haupt.example'});
 assert.equal(sent.response.status,200,'update');
 sent=await post(owner,{action:'set-technicians',id:defaultCustomer,revision:1,userIds:[],groupIds:[]});
 assert.equal(sent.response.status,200,'set-technicians');
 sent=await post(owner,{action:'create-installer',customerId:defaultCustomer,name:'Rollout',groupId:null,mode:'ReadOnly',validDays:30,maxDevices:null});
 assert.equal(sent.response.status,200,'create-installer');
 assert.equal(sent.response.headers.get('content-type'),'application/octet-stream');
 const installer=await d.one(sql`SELECT id,customer_id FROM customer_installers`);
 assert.equal(installer.customer_id,defaultCustomer);
 sent=await post(owner,{action:'revoke-installer',id:installer.id});
 assert.equal(sent.response.status,200,'revoke-installer');
 const state=await (await get(owner)).json();
 assert.deepEqual([state.customers[0].name,state.multipleCustomers.enabled,state.installers.length],['Hauptkunde',false,1]);
}));
