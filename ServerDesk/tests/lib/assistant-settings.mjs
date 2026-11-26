// The provider keys of the device assistant on PostgreSQL through the real
// route app/api/assistant/settings/route.ts: the organization key (Owners only,
// step-up to save it, none to remove it, one audit row per change, revision 409, model-only changes keep the
// key, a provider change needs a key), the personal key of each user (no
// step-up, isolation, deleted with the user), the customer keys (Owners only,
// once a second customer exists, the customer boundary, the audit column
// customer_id), validation, ciphertext with its context and no key in any
// answer or audit row, "Test key" with its shared limit of 5 in 60 s, an
// undecryptable key, rewrap-secrets and the CHECKs of the table. Everything
// before the customer keys runs on a database with only the default customer.
import assert from 'node:assert/strict';
import {sql} from '../../runtime/database.mjs';
import {createKeyring,decryptWithKeyring} from '../../runtime/secret-keyring.mjs';
import {rewrapSecrets} from '../../scripts/selfhost.mjs';
import {assistantFixture} from '../support/assistant-fixture.mjs';

const secretOld='assistant-session-secret-for-tests-0000000001',secretNew='assistant-session-secret-for-tests-0000000002';
const f=await assistantFixture({secret:secretOld});
const {d,settings,actor,fake}=f;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const keyA='sk-ant-api03-ORGkey000000000000000000AAAA',keyB='sk-ant-api03-ORGkey000000000000000000BBBB',keyOpenai='sk-proj-PERSONALkey00000000000000CCCC',keyCustomer='sk-ant-api03-CUSTOMERkey0000000000000DDDD';
const leaks=[keyA,keyB,keyOpenai,keyCustomer];
const noLeak=(value,label)=>{const text=JSON.stringify(value);for(const key of leaks)assert.ok(!text.includes(key),`${label} leaks a key`);checks++;};
const code=result=>[result.status,result.body.code,result.body.messageKey];
try{
 const {rolePermissions}=f.access;
 const owner=await actor('owner@assistant.test',['*']),reader=await actor('reader@assistant.test',rolePermissions.viewer),operator=await actor('operator@assistant.test',[...rolePermissions.operator,'portal.operator']);
 fake.on('api.anthropic.com',entry=>entry.headers['x-api-key']?.endsWith('0000')?[401,{type:'error',error:{type:'authentication_error'}}]:[200,{id:'claude-opus-5-5',type:'model'}]);
 fake.on('api.openai.com',()=>[200,{id:'gpt-5',object:'model'}]);
 const orgInput={action:'set-organization-key',provider:'anthropic',model:'claude-opus-5-5',key:keyA,revision:null};

 // ---- One customer: views and the Owner rule ----
 check((await settings.get(reader)).body,{personal:null},'a non-Owner sees only the personal key, no organization and no customer keys');
 check((await settings.get(owner)).body,{personal:null,organization:null,customerKeys:{visible:false,customers:[]}},'an Owner of a portal with one customer: no customer section');
 for(const as of [reader,operator])for(const action of ['set-organization-key','remove-organization-key','test-organization-key','set-customer-key','remove-customer-key','test-customer-key']){
  check(code(await settings.change(as,{action,provider:'nothing'})),[403,'ASSISTANT_FORBIDDEN','apiError.assistant.forbidden'],`${as.label} ${action}: 403 before the body`);
 }
 const noProof=await settings.post(owner,orgInput);
 check([noProof.status,noProof.body.code,(await f.keys()).length,(await f.audits()).length],[403,'MFA_STEP_UP_REQUIRED',0,0],'set without a step-up proof writes nothing');

 // ---- Validation ----
 const invalid=async(payload,field,label)=>{const result=await settings.change(owner,{...orgInput,...payload});check([result.status,result.body.code,result.body.params],[400,'ASSISTANT_FIELD_INVALID',{field}],label);};
 await invalid({provider:'azure'},'provider','an unknown provider');
 await invalid({model:''},'model','an empty model');
 await invalid({model:'x'.repeat(101)},'model','a model over 100 characters');
 await invalid({model:'claude opus'},'model','a model with a space');
 await invalid({model:'claude<5>'},'model','a model with other characters');
 await invalid({key:'sk-proj-0000000000000000000000'},'key','an Anthropic key without sk-ant-');
 await invalid({key:'sk-ant-short'},'key','a key under 20 characters');
 await invalid({key:'sk-ant-'+'a'.repeat(506)},'key','a key over 512 characters');
 await invalid({key:'sk-ant-api03-with space-000000'},'key','a key with a space');
 await invalid({key:'sk-ant-api03-ümlaut-0000000000'},'key','a key with non-ASCII characters');
 await invalid({key:''},'key','a new key is needed without a stored key');
 await invalid({provider:'openai',key:'ant-0000000000000000000000000'},'key','an OpenAI key without sk-');
 await invalid({revision:'0'},'revision','a revision that is no number');
 check((await f.keys()).length,0,'refused changes write nothing');

 // ---- Organization key ----
 const saved=await settings.change(owner,orgInput);
 check([saved.status,saved.cache,Object.keys(saved.body.key).sort(),saved.body.key.provider,saved.body.key.model,saved.body.key.keyHint,saved.body.key.revision],[200,'no-store',['keyHint','model','provider','revision','updatedAt'],'anthropic','claude-opus-5-5','AAAA',0],'the saved key: only provider, model, hint, revision and time');
 let [row]=await f.keys();
 check([row.scope,row.user_id,row.customer_id,row.key_hint,row.secret.startsWith('k1.'),row.updated_by],['organization',null,null,'AAAA',true,'owner@assistant.test'],'the stored row holds ciphertext');
 check(await f.decrypt(row.secret,'assistant-key:organization'),keyA,'it decrypts with the organization context');
 await assert.rejects(f.decrypt(row.secret,`assistant-key:user:${owner.id}`),'another context does not decrypt');checks++;
 let audit=await f.audits();
 check(audit.map(entry=>[entry.action,JSON.parse(entry.target),entry.scope,entry.customerId]),[['assistant.organization-key.set',{provider:'anthropic',model:'claude-opus-5-5',keyHint:'AAAA'},'portal',null]],'one portal audit row without the key');
 const view=(await settings.get(owner)).body;
 check(view.organization,saved.body.key,'GET returns the same view');
 noLeak([view,saved.body,audit,await d.query(sql`SELECT id,scope,provider,model,key_hint,updated_by FROM assistant_keys`)],'answers, audit and plain columns');
 check(code(await settings.change(owner,{...orgInput,key:keyB,revision:null})),[409,'ASSISTANT_SETTINGS_CHANGED','apiError.assistant.changed'],'a stale revision (null while a key is stored) answers 409');
 check(code(await settings.change(owner,{...orgInput,key:keyB,revision:7})),[409,'ASSISTANT_SETTINGS_CHANGED','apiError.assistant.changed'],'another stale revision answers 409');
 const same=await settings.post(owner,{...orgInput,key:'',revision:0});
 check([same.status,same.body.key.revision,(await f.audits()).length],[200,0,1],'no change: no proof needed, no audit row');
 const modelOnly=await settings.change(owner,{...orgInput,key:undefined,model:'claude-sonnet-5-5',revision:0});
 [row]=await f.keys();
 check([modelOnly.status,modelOnly.body.key.model,modelOnly.body.key.keyHint,modelOnly.body.key.revision,await f.decrypt(row.secret,'assistant-key:organization')],[200,'claude-sonnet-5-5','AAAA',1,keyA],'a model-only change keeps the stored key');
 await invalid({provider:'openai',model:'gpt-5',key:undefined,revision:1},'key','a provider change needs a new key');
 const replaced=await settings.change(owner,{...orgInput,key:keyB,revision:1});
 check([replaced.body.key.keyHint,replaced.body.key.revision,await f.decrypt((await f.keys())[0].secret,'assistant-key:organization')],['BBBB',2,keyB],'a new key replaces the stored one');
 check(code(await settings.post(owner,{action:'remove-organization-key',revision:1})),[409,'ASSISTANT_SETTINGS_CHANGED','apiError.assistant.changed'],'remove with a stale revision answers 409');
 // Removing a key only stops the assistant (lib/step-up.ts): no proof is needed, and a supplied one stays.
 const unused=await f.token(owner),removed=await settings.post(owner,{action:'remove-organization-key',revision:2,managementToken:unused});
 check([removed.status,removed.body.key,(await f.keys()).length],[200,null,0],'the organization key is removed without a step-up proof');
 check(Number((await f.d.one(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${unused}`)).n),1,'the supplied proof stays');
 audit=await f.audits();
 check(audit.map(entry=>[entry.action,JSON.parse(entry.target)]),[['assistant.organization-key.set',{provider:'anthropic',model:'claude-opus-5-5',keyHint:'AAAA'}],['assistant.organization-key.set',{provider:'anthropic',model:'claude-sonnet-5-5',keyHint:'AAAA'}],['assistant.organization-key.set',{provider:'anthropic',model:'claude-opus-5-5',keyHint:'BBBB'}],['assistant.organization-key.removed',{provider:'anthropic',model:'claude-opus-5-5',keyHint:'BBBB'}]],'one audit row per change');

 // ---- Personal keys ----
 const anna=await actor('anna@assistant.test',rolePermissions.viewer),ben=await actor('ben@assistant.test',rolePermissions.viewer);
 const personal=await settings.post(anna,{action:'set-personal-key',provider:'openai',model:'gpt-5',key:keyOpenai,revision:null,userId:ben.id});
 check([personal.status,personal.body.key.provider,personal.body.key.keyHint],[200,'openai','CCCC'],'a user saves a personal key without step-up');
 const annaRow=(await f.keys()).find(entry=>entry.scope==='personal');
 check([annaRow.user_id,await f.decrypt(annaRow.secret,`assistant-key:user:${anna.id}`)],[anna.id,keyOpenai],'the row belongs to the user, a userId parameter is ignored');
 check((await settings.get(anna)).body,{personal:personal.body.key},'the user sees the own key');
 check((await settings.get(ben)).body,{personal:null},'another user does not see it');
 check((await settings.post(ben,{action:'remove-personal-key',revision:null})).body,{key:null},'another user removes nothing');
 check((await f.keys()).filter(entry=>entry.scope==='personal').length,1,'the key of the first user stays');
 check(code(await settings.post(ben,{action:'set-personal-key',provider:'openai',model:'gpt-5',key:'',revision:null})),[400,'ASSISTANT_FIELD_INVALID','apiError.assistant.fieldInvalid'],'another user cannot reuse it without a key');
 check((await f.audits('assistant.personal-key.%')).map(entry=>[entry.action,JSON.parse(entry.target),entry.scope]),[['assistant.personal-key.set',{provider:'openai',model:'gpt-5',keyHint:'CCCC'},'portal']],'one audit row without the key');
 check(code(await settings.post(anna,{action:'remove-personal-key',revision:3})),[409,'ASSISTANT_SETTINGS_CHANGED','apiError.assistant.changed'],'a stale personal revision answers 409');

 // ---- Test key ----
 const tested=await settings.post(owner,{action:'test-organization-key',provider:'anthropic',model:'claude-opus-5-5',key:keyA});
 check([tested.status,tested.body],[200,{ok:true}],'test an entered key');
 const modelCall=fake.of('api.anthropic.com').at(-1);
 check([modelCall.method,modelCall.path,modelCall.headers['x-api-key']],['GET','/v1/models/claude-opus-5-5',keyA],'the model endpoint with the entered key');
 check(code(await settings.post(owner,{action:'test-organization-key',provider:'anthropic',model:'claude-opus-5-5'})),[400,'ASSISTANT_FIELD_INVALID','apiError.assistant.fieldInvalid'],'without a stored key the field is needed');
 const storedTest=await settings.post(anna,{action:'test-personal-key',provider:'openai',model:'gpt-5'});
 check([storedTest.status,fake.of('api.openai.com').at(-1).headers.authorization],[200,`Bearer ${keyOpenai}`],'an empty field tests the stored key');
 const rejected=await settings.post(owner,{action:'test-organization-key',provider:'anthropic',model:'claude-opus-5-5',key:'sk-ant-api03-REJECTED00000000000000'});
 check([rejected.status,rejected.body.code,rejected.body.messageKey,rejected.body.params,rejected.body.error],[502,'ASSISTANT_PROVIDER_FAILED','apiError.assistant.keyRejected',{provider:'Anthropic'},'Anthropic rejected the API key. Check the key and save it again.'],'a rejected key shows the mapped error');
 check((await settings.post(owner,{action:'test-personal-key',provider:'anthropic',model:'claude-opus-5-5',key:keyA})).status,200,'the 3rd test of the window');
 check((await settings.post(owner,{action:'test-organization-key',provider:'anthropic',model:'claude-opus-5-5',key:keyA})).status,200,'the 4th test of the window');
 check((await settings.post(owner,{action:'test-personal-key',provider:'anthropic',model:'claude-opus-5-5',key:keyA})).status,200,'the 5th test, across scopes');
 const limited=await settings.post(owner,{action:'test-organization-key',provider:'anthropic',model:'claude-opus-5-5',key:keyA});
 check(code(limited),[429,'ASSISTANT_RATE_LIMITED','apiError.assistant.testRateLimited'],'the 6th test in 60 s answers 429');
 check((await f.audits('assistant.%test%')).length,0,'tests write no audit row');
 await d.exec(sql`DELETE FROM assistant_limits`);

 // ---- An undecryptable key ----
 f.state.ring=createKeyring({SESSION_SECRET:'another-session-secret-for-tests-00000000009'});
 const broken=await settings.post(anna,{action:'test-personal-key',provider:'openai',model:'gpt-5'});
 check([broken.status,broken.body.code,broken.body.error],[409,'ASSISTANT_SECRET_UNDECRYPTABLE','The stored API key can no longer be read. Enter the key again.'],'a key that does not decrypt answers secretUndecryptable');
 f.state.ring=createKeyring({SESSION_SECRET:secretOld});
 await d.exec(sql`DELETE FROM assistant_limits`);

 // ---- Customer keys: while only the default customer exists ----
 const standard='00000000-0000-4000-8000-000000000100';
 const firstInput={action:'set-customer-key',customerId:standard,provider:'anthropic',model:'claude-opus-5-5',key:keyCustomer,revision:null};
 check(code(await settings.change(owner,firstInput)),[409,'ASSISTANT_CUSTOMER_KEYS_UNAVAILABLE','apiError.assistant.customerKeysUnavailable'],'with one customer set answers 409');
 check([(await f.keys()).filter(entry=>entry.scope==='customer').length,(await settings.get(owner)).body.customerKeys.visible],[0,false],'and writes nothing; the section stays hidden');

 // A key that exists with one customer (written directly) keeps the section visible and can be removed.
 await d.exec(sql`INSERT INTO assistant_keys(id,scope,customer_id,provider,model,secret,key_hint,revision,updated_at,updated_by) VALUES(${crypto.randomUUID()},'customer',${standard},'anthropic','claude-opus-5-5','k1.unused','ZZZZ',0,1,'test')`);
 check((await settings.get(owner)).body.customerKeys.visible,true,'a stored customer key keeps the section visible');
 check((await settings.change(owner,{action:'remove-customer-key',customerId:standard,revision:0})).body,{key:null},'remove works with one customer');
 check((await f.audits('assistant.customer-key.removed')).map(entry=>entry.customerId),[standard],'with its audit row');

 // ---- With a second customer ----
 const alpha=await f.customer('Alpha GmbH'),beta=await f.customer('Beta AG','disabled');
 const customerInput={action:'set-customer-key',customerId:alpha,provider:'anthropic',model:'claude-opus-5-5',key:keyCustomer,revision:null};
 check(code(await settings.change(owner,{...customerInput,customerId:'not-a-guid'})),[400,'INVALID_REQUEST','apiError.customer.invalid'],'a customer ID that is no GUID');
 check(code(await settings.change(owner,{...customerInput,customerId:crypto.randomUUID()})),[404,'CUSTOMER_MISSING','apiError.customer.unavailable'],'an unknown customer');
 check(code(await settings.post(owner,customerInput)),[403,'MFA_STEP_UP_REQUIRED','apiError.mfa.stepUpRequired'],'set needs a step-up proof');
 const customerSaved=await settings.change(owner,customerInput);
 check([customerSaved.status,customerSaved.body.key.keyHint,customerSaved.body.key.revision],[200,'DDDD',0],'the key of a customer');
 const customerRow=(await f.keys()).find(entry=>entry.scope==='customer');
 check([customerRow.customer_id,customerRow.user_id,await f.decrypt(customerRow.secret,`assistant-key:customer:${alpha}`)],[alpha,null,keyCustomer],'stored with the customer context');
 await assert.rejects(f.decrypt(customerRow.secret,'assistant-key:organization'),'only the customer context decrypts');checks++;
 check((await f.audits('assistant.customer-key.set')).map(entry=>[entry.action,JSON.parse(entry.target),entry.scope,entry.customerId]),[['assistant.customer-key.set',{customer:'Alpha GmbH',provider:'anthropic',model:'claude-opus-5-5',keyHint:'DDDD'},'portal',alpha]],'one audit row with the customer and customer_id, without the key');
 const disabled=await settings.change(owner,{...customerInput,customerId:beta,key:keyB});
 check([disabled.status,disabled.body.key.keyHint],[200,'BBBB'],'a disabled customer can get a key');
 check(code(await settings.change(owner,{...customerInput,revision:null})),[409,'ASSISTANT_SETTINGS_CHANGED','apiError.assistant.changed'],'a stale customer revision');
 const customerModel=await settings.change(owner,{...customerInput,key:undefined,model:'claude-haiku-5-5',revision:0});
 check([customerModel.body.key.model,customerModel.body.key.keyHint,await f.decrypt((await f.keys()).find(entry=>entry.customer_id===alpha).secret,`assistant-key:customer:${alpha}`)],['claude-haiku-5-5','DDDD',keyCustomer],'a model-only change keeps the customer key');
 check((await settings.change(owner,{...customerInput,provider:'openai',model:'gpt-5',key:undefined,revision:1})).body.params,{field:'key'},'a provider change without a key is refused');
 const listed=(await settings.get(owner)).body.customerKeys;
 check([listed.visible,listed.customers.map(entry=>[entry.customerName,entry.customerDisabled,entry.key?.keyHint??null])],[true,[['Alpha GmbH',false,'DDDD'],['Beta AG',true,'BBBB'],...listed.customers.slice(2).map(entry=>[entry.customerName,false,null])]],'Owners see every customer in name order with its key');
 ok(listed.customers.some(entry=>entry.customerId==='00000000-0000-4000-8000-000000000100'),'the first customer is listed too');
 noLeak(listed,'the customer list');
 check('customerKeys' in (await settings.get(reader)).body,false,'a non-Owner never gets customer keys');
 check((await settings.post(owner,{action:'test-customer-key',customerId:alpha,provider:'anthropic',model:'claude-haiku-5-5'})).status,200,'test the stored customer key');
 check(fake.of('api.anthropic.com').at(-1).headers['x-api-key'],keyCustomer,'with the customer key');
 for(let index=0;index<4;index++)await settings.post(owner,{action:'test-customer-key',customerId:alpha,provider:'anthropic',model:'claude-haiku-5-5'});
 check(code(await settings.post(anna,{action:'test-personal-key',provider:'openai',model:'gpt-5'})).slice(0,1),[200],'the limit is per principal');
 check(code(await settings.post(owner,{action:'test-organization-key',provider:'anthropic',model:'claude-opus-5-5',key:keyA})),[429,'ASSISTANT_RATE_LIMITED','apiError.assistant.testRateLimited'],'customer tests share the limit with the other scopes');
 const customerRemoved=await settings.post(owner,{action:'remove-customer-key',customerId:beta,revision:0});
 check([customerRemoved.status,customerRemoved.body.key,(await f.audits('assistant.customer-key.removed')).map(entry=>entry.customerId)],[200,null,[standard,beta]],'remove a customer key');

 // ---- Personal keys go with their user ----
 const gone=await actor('gone@assistant.test',rolePermissions.viewer);
 await settings.post(gone,{action:'set-personal-key',provider:'openai',model:'gpt-5',key:keyOpenai,revision:null});
 await d.exec(sql`DELETE FROM role_assignments WHERE principal_id=${gone.id}`);
 await d.exec(sql`DELETE FROM mfa_sessions WHERE principal=${gone.principal}`);
 await d.exec(sql`DELETE FROM local_users WHERE id=${gone.id}`);
 check((await f.keys()).filter(entry=>entry.user_id===gone.id).length,0,'deleting a user deletes the personal key');

 // ---- rewrap-secrets ----
 await d.exec(sql`DELETE FROM assistant_limits`);
 await settings.change(owner,{...orgInput,key:keyA,revision:null});
 await settings.change(owner,{...customerInput,revision:null});
 const before=await f.keys();
 const summary=await rewrapSecrets(d,{env:{SESSION_SECRET:secretNew,SESSION_SECRET_PREVIOUS:secretOld}});
 ok(summary.rewrapped>=before.length&&summary.failed===0,'rewrap-secrets re-wraps the assistant keys');
 const ringNew=createKeyring({SESSION_SECRET:secretNew});
 for(const entry of await f.keys()){
  const context=entry.scope==='organization'?'assistant-key:organization':entry.scope==='customer'?`assistant-key:customer:${entry.customer_id}`:`assistant-key:user:${entry.user_id}`;
  const value=await decryptWithKeyring(ringNew,entry.secret,context);
  ok(leaks.includes(value)&&entry.secret!==before.find(old=>old.id===entry.id).secret,`the ${entry.scope} key is re-wrapped with its context`);
 }

 // ---- CHECKs ----
 const insert=(scope,userId,customerId)=>d.exec(sql`INSERT INTO assistant_keys(id,scope,user_id,customer_id,provider,model,secret,key_hint,revision,updated_at,updated_by) VALUES(${crypto.randomUUID()},${scope},${userId},${customerId},'anthropic','m','k1.x','AAAA',0,1,'t')`);
 await assert.rejects(insert('customer',null,null),'a customer row needs customer_id');checks++;
 await assert.rejects(insert('organization',null,alpha),'an organization row has no customer_id');checks++;
 await assert.rejects(insert('personal',null,null),'a personal row needs user_id');checks++;
 await assert.rejects(insert('organization',anna.id,null),'an organization row has no user_id');checks++;
 await assert.rejects(insert('organization',null,null),'one organization row');checks++;

 const {assistantSettingsStepUpActions}=await import('../../lib/step-up.ts');
 check([...assistantSettingsStepUpActions],['set-organization-key','set-customer-key'],'the step-up actions: saving a key, not removing one');
}finally{await f.close();}
process.stdout.write(`PASS assistant settings (${checks} assertions): organization, personal and customer keys, Owner rule, step-up, audit, revision, validation, ciphertext, test limit, undecryptable key, rewrap, CHECKs; one customer without customer keys.\n`);
