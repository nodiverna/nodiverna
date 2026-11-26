// Deleting a customer through the real route app/api/customers/route.ts (deleteCustomer in
// lib/server/identity/customer-admin.ts, docs/customers.md "Delete a customer"): a global Owner
// with a management MFA proof only; 404 for an unknown id, 409 for a stale revision, the default
// customer and a customer that still holds data (also when the data appears before the commit);
// a successful delete removes the customer with its installers, technician access, AI key,
// notification rule, alert rule and ESU overrides in one batch with one audit row, uses the proof,
// keeps the old audit rows readable through removed_customers, and a deleted installer key no longer
// enrolls. The last delete ends the customer boundary: it voids the open links and ends the MFA
// grants of the accounts that gain the default customer, and then "Multiple customers" can be
// turned off again. Against an isolated PostgreSQL test database; only the request environment
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
const linksAction='Konto-Links wegen Kundenzuweisung verfallen';
// Each refusal as [status, code, message key] (lib/errors/api-error-keys.ts).
const refused={
 ownerOnly:[403,'FORBIDDEN','apiError.customer.ownerOnly'],
 stepUp:[403,'MFA_STEP_UP_REQUIRED','apiError.mfa.stepUpRequired'],
 missing:[404,'CUSTOMER_MISSING','apiError.customer.gone'],
 concurrent:[409,'CONFLICT','apiError.customer.concurrent'],
 defaultProtected:[409,'CUSTOMER_DEFAULT_PROTECTED','apiError.customer.defaultDeleteProtected'],
 inUse:[409,'CUSTOMER_IN_USE','apiError.customer.inUse'],
 inUseSetting:[409,'MULTIPLE_CUSTOMERS_IN_USE','apiError.customer.multipleCustomersInUse'],
};

async function body(request){
 let parsed;try{parsed=JSON.parse(Buffer.from(await request.arrayBuffer()).toString('utf8'));}catch{throw new HttpError('apiError.request.invalidJson');}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new HttpError('apiError.request.invalidJson');
 return parsed;
}
// As lib/server/context.ts failure(): an HttpError answers with its status, code and message key.
const failure=error=>{const answer=error instanceof HttpError?classifyFailure(error):{status:503,body:apiErrorBody('apiError.storageUnavailable')};return Response.json(answer.body,{status:answer.status,headers:{'Cache-Control':'no-store'}});};
const keyed=async response=>{const sent=await response.json();return [response.status,sent.code,sent.messageKey];};

async function fixture(run){
 const d=await sourceDatabase(),time=()=>Date.now();
 const env={SITE_ORIGIN:'https://portal.test',AGENT_JOB_SIGNING_KEY:jobSigningKey};
 let viewer=null,hook=null;
 const facade=hookDatabase(d,{transaction:async()=>{if(hook&&--hook.n===0){const action=hook.action;hook=null;await action();}}});
 const server={db:()=>facade,now:time,config:key=>env[key]??'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>sha(value),HttpError,body,failure,
  guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value),sameOrigin:()=>{},
  requireViewer:async()=>{if(!viewer)throw new HttpError('apiError.auth.loginRequired');return viewer;},
  log:async()=>{throw new Error('the customer route writes its audit rows in its own batches');}};
 const mfa={requireMfa:async()=>{},isMfaEnabled:async()=>true,mfaSessionFence:async()=>sql`TRUE`,requireLiveSessions:async()=>{},
  readMfaManagementProof:async(_request,actor,token)=>{if(typeof token!=='string')throw new HttpError('apiError.mfa.stepUpRequired');return {tokenHash:token,key:actor.principal,sessionHash:sha(actor.id+'mfa'),guard:sql`TRUE`};}};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./mfa':mfa,'../identity/mfa':mfa,'./identity/mfa':mfa,'@/lib/server/identity/mfa':mfa};
 const load=sourceLoader();
 const access=load('lib/server/identity/access.ts',imports);
 imports['./local-auth']=imports['./identity/local-auth']={primaryGuard:async(_request,actor)=>access.viewerWriteGuard(actor)};
 const route=load('app/api/customers/route.ts',imports),enrollApi=load('app/api/agent/enroll/route.ts',imports);
 const installers=load('lib/server/agent/customer-installers.ts',imports),{auditSelect}=load('lib/server/audit-scope.ts',imports);
 const insert=(table,row)=>insertRow(d,table,row);
 const owner=(await sourceActor(d,'owner@delete.test',['*'])).actor;
 const tech=(await sourceActor(d,'tech@delete.test',[...access.allPermissions])).actor;
 for(const actor of [owner,tech]){actor.userId=actor.id;await insert('mfa_sessions',{token_hash:sha(actor.id+'mfa'),principal:actor.principal,created_at:time(),last_activity:time(),idle_expires_at:time()+30*day,expires_at:time()+30*day});}
 const token=async(actor=owner)=>{const value=uuid();await insert('mfa_management_proofs',{token_hash:value,principal:actor.principal,session_hash:sha(actor.id+'mfa'),expires_at:time()+300_000});return value;};
 const proofExists=async value=>Number((await d.one(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${value}`)).n)===1;
 const request=payload=>new Request('https://portal.test/api/customers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 /** POST with a fresh proof (managementToken null: none); the answer and the token. */
 const post=async(actor,payload,{managementToken}={})=>{const value=managementToken===undefined?await token(actor):managementToken;viewer=actor;return {response:await route.POST(request({...payload,...(value===null?{}:{managementToken:value})})),token:value};};
 const get=async actor=>{viewer=actor;return (await route.GET(new Request('https://portal.test/api/customers'))).json();};
 /** A customer (insertRow turns "Multiple customers" on) and its read revision. */
 const customer=async name=>{const id=uuid();await insert('customers',{id,name,created_at:time(),updated_at:time()});return id;};
 const count=async statement=>Number((await d.one(statement)).n);
 const audit=async()=>(await d.query(sql`SELECT id,actor,action,target,customer_id AS "customerId" FROM audit ORDER BY id`)).map(row=>({...row}));
 const enroll=key=>enrollApi.POST(new Request('https://portal.test/api/agent/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({installerKey:key,name:'SRV-1'})}));
 const beforeBatch=async(n,action,call)=>{hook={n,action};try{return await call();}finally{hook=null;}};
 try{return await run({d,owner,tech,token,proofExists,post,get,customer,count,audit,enroll,installers,auditSelect,beforeBatch,insert,time});}
 finally{d.close();}
}
const remove=(id,revision=0)=>({action:'delete',id,revision});

test('only an Owner with a proof deletes, and unknown, stale, default and busy customers are refused without a write',async()=>fixture(async({d,owner,tech,post,get,customer,count,audit,proofExists,beforeBatch,insert,time})=>{
 const busy=await customer('Kunde Belegt'),empty=await customer('Kunde Leer');
 await insert('customer_installers',{id:'inst-busy',customer_id:busy,name:'Rollout',key_hash:'busy-key',mode:'ReadOnly',expires_at:time()+day,created_at:time(),created_by:owner.principal});
 await insert('servers',{id:uuid(),name:'SRV-B',token_hash:'token-busy',created_at:time(),customer_id:busy});
 const before=await audit();
 assert.deepEqual(await keyed((await post(tech,remove(empty))).response),refused.ownerOnly,'a non-Owner');
 let sent=await post(owner,remove(empty),{managementToken:null});
 assert.deepEqual(await keyed(sent.response),refused.stepUp,'no proof: the step-up code');
 assert.deepEqual(await keyed((await post(owner,remove(uuid()))).response),refused.missing,'an unknown id');
 sent=await post(owner,remove(empty,7));
 assert.deepEqual(await keyed(sent.response),refused.concurrent,'a stale revision');
 assert.equal(await proofExists(sent.token),true,'a refused delete keeps the proof');
 assert.deepEqual(await keyed((await post(owner,remove(defaultCustomer))).response),refused.defaultProtected,'the default customer');
 assert.deepEqual(await keyed((await post(owner,remove(busy))).response),refused.inUse,'a customer with a device');
 assert.deepEqual([await count(sql`SELECT count(*) AS n FROM customers WHERE id IN (${busy},${empty})`),await count(sql`SELECT count(*) AS n FROM customer_installers WHERE id='inst-busy'`),await audit()],[2,1,before],'nothing changed');
 // GET returns the counts that keep a delete refused.
 const listed=(await get(owner)).customers.find(entry=>entry.id===busy);
 assert.deepEqual([listed.deviceCount,listed.groupCount,listed.runbookCount,listed.templateCount,listed.roleCount],[1,0,0,0,0]);
 // A runbook appears between the counts and the commit: the trigger answers with the same code, nothing is written.
 sent=await beforeBatch(1,()=>insert('runbooks',{id:'rb-race',name:'Rennen',description:'',created_at:time(),created_by:'fixture',customer_id:empty}),()=>post(owner,remove(empty)));
 assert.deepEqual(await keyed(sent.response),refused.inUse,'the trigger refuses in a race');
 assert.deepEqual([await count(sql`SELECT count(*) AS n FROM customers WHERE id=${empty}`),await audit(),await proofExists(sent.token)],[1,before,true],'no delete, no audit row, the proof stays');
 assert.deepEqual(await d.query(sql`SELECT id FROM removed_customers`),[],'no tombstone');
}));

test('a delete removes the customer and its configuration in one batch, keeps its history readable and stops its installer',async()=>fixture(async({d,owner,tech,post,get,customer,count,audit,proofExists,enroll,installers,auditSelect,insert,time})=>{
 const gone=await customer('Kunde Weg'),stays=await customer('Kunde Bleibt');
 const key=crypto.randomBytes(32).toString('hex');
 await insert('customer_installers',{id:'inst-gone',customer_id:gone,name:'Rollout',key_hash:await installers.installerKeyHash(key),mode:'ReadOnly',expires_at:time()+day,created_at:time(),created_by:owner.principal});
 await insert('customer_assignments',{customer_id:gone,principal_type:'user',principal_id:tech.id,created_at:time(),created_by:owner.principal});
 await insert('customer_assignments',{customer_id:stays,principal_type:'user',principal_id:tech.id,created_at:time(),created_by:owner.principal});
 await insert('assistant_keys',{id:'key-gone',scope:'customer',customer_id:gone,provider:'openai',model:'gpt',secret:'secret',key_hint:'abcd',updated_at:time(),updated_by:'fixture'});
 await insert('notification_channels',{id:'ch-1',type:'webhook',name:'Hook',enabled:1,config:'{}',target_hint:'',revision:0,created_at:time(),created_by:'fixture',updated_at:time(),updated_by:'fixture'});
 await insert('notification_rules',{id:'nr-gone',scope_type:'customer',scope_id:gone,channel_id:'ch-1',levels:'["critical"]',on_open:1,on_close:0,on_escalate:0,enabled:1,revision:0,created_at:time(),created_by:'fixture',updated_at:time(),updated_by:'fixture'});
 await insert('alert_rule_overrides',{id:'aro-gone',rule_id:'cpu',scope_type:'customer',scope_id:gone,enabled:1,actor:'fixture',updated_at:time()});
 await insert('os_esu_overrides',{id:'esu-gone',scope_type:'customer',scope_id:gone,until:'2030-01-01',actor:'fixture',updated_at:time()});
 await insert('notification_events',{id:'ev-gone',customer_id:gone,kind:'test',occurred_at:time(),status:'pending'});
 const created=(await d.one(sql`INSERT INTO audit(at,actor,action,target,scope,customer_id) VALUES(${time()},${owner.label},'Kunde angelegt','Kunde Weg','portal',${gone}) RETURNING id`)).id;
 const sent=await post(owner,remove(gone));
 assert.equal(sent.response.status,200);
 const state=await sent.response.json();
 assert.deepEqual(state.customers.map(entry=>entry.id).sort(),[defaultCustomer,stays].sort(),'the answer is the page state without the customer');
 assert.equal(state.multipleCustomers.otherCustomers,1);
 assert.equal((await get(owner)).customers.some(entry=>entry.id===gone),false,'GET no longer lists it');
 assert.equal(await proofExists(sent.token),false,'the proof is used');
 for(const [table,statement] of [['customer_installers',sql`SELECT count(*) AS n FROM customer_installers WHERE customer_id=${gone}`],['customer_assignments',sql`SELECT count(*) AS n FROM customer_assignments WHERE customer_id=${gone}`],
  ['assistant_keys',sql`SELECT count(*) AS n FROM assistant_keys WHERE customer_id=${gone}`],['notification_rules',sql`SELECT count(*) AS n FROM notification_rules WHERE scope_id=${gone}`],
  ['alert_rule_overrides',sql`SELECT count(*) AS n FROM alert_rule_overrides WHERE scope_id=${gone}`],['os_esu_overrides',sql`SELECT count(*) AS n FROM os_esu_overrides WHERE scope_id=${gone}`]])assert.equal(await count(statement),0,table+' of the customer are gone');
 assert.deepEqual([await count(sql`SELECT count(*) AS n FROM customer_assignments WHERE customer_id=${stays}`),await count(sql`SELECT count(*) AS n FROM notification_events WHERE id='ev-gone' AND customer_id=${gone}`)],[1,1],'other customers and the notification events stay');
 // One audit row of the delete, without a customer; the old row keeps its customer and shows the last name.
 const rows=await audit();
 assert.deepEqual(rows.filter(row=>row.action==='customer.delete').map(row=>({actor:row.actor,action:row.action,target:row.target,customerId:row.customerId})),[{actor:owner.label,action:'customer.delete',target:'Kunde Weg',customerId:null}],'one customer.delete row with the name as target');
 assert.deepEqual(rows.filter(row=>row.action===linksAction),[],'another customer remains: the boundary holds, no account loses its links');
 const old=await d.one(sql`${auditSelect} WHERE a.id=${created}`);
 assert.deepEqual([old.customerId,old.customerName,old.customerRemoved],[gone,'Kunde Weg',true],'the old row names the deleted customer');
 const live=await d.one(sql`${auditSelect} WHERE a.customer_id IS NULL AND a.action='customer.delete'`);
 assert.deepEqual([live.customerName,live.customerRemoved],[null,false]);
 // The installer of the deleted customer enrolls nothing.
 const response=await enroll(key);
 assert.deepEqual([response.status,(await response.json()).code],[403,'INSTALLER_INVALID'],'the key answers as an unknown installer');
 assert.equal(await count(sql`SELECT count(*) AS n FROM servers WHERE customer_id=${gone}`),0,'no device was created');
}));

test('the last delete ends the customer boundary for the accounts that gain the default customer, and then the setting turns off',async()=>fixture(async({d,owner,tech,post,get,customer,audit,insert,time})=>{
 const first=await customer('Kunde Eins'),last=await customer('Kunde Zwei');
 const deft=(await sourceActor(d,'default@delete.test',['view'])).actor;
 await insert('customer_assignments',{customer_id:defaultCustomer,principal_type:'user',principal_id:deft.id,created_at:time(),created_by:owner.principal});
 await insert('customer_assignments',{customer_id:first,principal_type:'user',principal_id:tech.id,created_at:time(),created_by:owner.principal});
 const link=async user=>{const hash=uuid();await insert('local_account_tokens',{token_hash:hash,user_id:user.id,kind:'invite',created_at:time(),expires_at:time()+day,auth_version:1});return hash;};
 const grant=async user=>{const hash=uuid();await insert('mfa_grants',{token_hash:hash,principal:user.principal,user_id:user.id,created_at:time(),expires_at:time()+day});return hash;};
 const links={tech:await link(tech),deft:await link(deft),owner:await link(owner)},grants={tech:await grant(tech),deft:await grant(deft),owner:await grant(owner)};
 const state=async()=>({
  open:(await d.query(sql`SELECT token_hash FROM local_account_tokens WHERE used_at IS NULL`)).map(row=>row.token_hash).sort(),
  grants:(await d.query(sql`SELECT token_hash FROM mfa_grants`)).map(row=>row.token_hash).sort(),
  rows:(await audit()).filter(row=>row.action===linksAction).map(row=>row.target),
 });
 const all={open:Object.values(links).sort(),grants:Object.values(grants).sort(),rows:[]};
 // Another customer remains: nothing happens to any account.
 assert.equal((await post(owner,remove(first))).response.status,200);
 assert.deepEqual(await state(),all,'the boundary holds: links and grants stay');
 // The technician now sees only the last other customer; its delete ends the boundary.
 await insert('customer_assignments',{customer_id:last,principal_type:'user',principal_id:tech.id,created_at:time(),created_by:owner.principal});
 let setting=(await get(owner)).multipleCustomers;
 assert.deepEqual(await keyed((await post(owner,{action:'set-multiple-customers',enabled:false,revision:setting.revision})).response),refused.inUseSetting,'before the last delete the setting stays on');
 assert.equal((await post(owner,remove(last))).response.status,200);
 assert.deepEqual(await state(),{open:[links.deft,links.owner].sort(),grants:[grants.deft,grants.owner].sort(),rows:[tech.id]},'only the technician loses its open link and its MFA grant, with one audit row');
 // "Multiple customers" turns off again.
 setting=(await get(owner)).multipleCustomers;
 assert.deepEqual([setting.enabled,setting.otherCustomers],[true,0]);
 const sent=await post(owner,{action:'set-multiple-customers',enabled:false,revision:setting.revision});
 assert.equal(sent.response.status,200,'the switch-off succeeds');
 assert.deepEqual((await sent.response.json()).multipleCustomers,{enabled:false,otherCustomers:0,revision:setting.revision+1});
}));
