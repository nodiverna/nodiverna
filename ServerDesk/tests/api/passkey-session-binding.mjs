// Passkey delete and passkey/authenticator renames commit their change and audit
// row in one batch that is fenced by the still-live primary and MFA session.
// Real route and lib sources run against a migrated PostgreSQL test database;
// log() throws, so every success proves the audit row was written in the batch.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,sourceActor,inTransaction,createTrigger,dropTrigger} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sessionHeaders} from '../support/session-cookies.mjs';
import {sql,SqlFragment} from '../../runtime/database.mjs';

const d=await sourceDatabase();
try{
 const origin='https://passkey.test';
 const HttpError=realHttpError;
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 // A one-shot hook runs right before the first transaction whose statements
 // match (the hooked database reads them in a rolled-back dry run).
 // Writes outside a transaction are recorded, so each action can prove it
 // commits through exactly one transaction.
 let beforeBatch=null,batches=0,standaloneWrites=[];
 const isWrite=text=>/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(text);
 const database=hookDatabase(d,{
  transaction:async()=>{batches++;},
  statement:async(text,kind,inTransaction)=>{if(!inTransaction&&isWrite(text))standaloneWrites.push(text);},
  batch:async texts=>{const hook=beforeBatch;if(hook&&hook.match(texts)){beforeBatch=null;await hook.run();}},
 });
 let current=null;
 const server={
  db:()=>database,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:'',now:()=>Date.now(),random:token,hash:async value=>sha(value),HttpError,
  body:request=>request.json(),sameOrigin:()=>{},requireAuthIdentity:async()=>current,
  log:async()=>{throw new Error('log() must not be used by atomic security actions');},
  failure:e=>Response.json({error:e.message,...(e instanceof HttpError&&e.code?{code:e.code}:{})},{status:e instanceof HttpError?e.status:503}),
 };
 const webauthn={generateRegistrationOptions:async()=>({}),verifyRegistrationResponse:async()=>({verified:false}),generateAuthenticationOptions:async()=>({}),verifyAuthenticationResponse:async()=>({verified:false})};
 const load=sourceLoader(),dependencies={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'@simplewebauthn/server':webauthn};
 const mfa=load('lib/server/identity/mfa.ts',dependencies);
 const mfaApi=load('app/api/mfa/route.ts',dependencies),passkeyApi=load('app/api/passkeys/route.ts',dependencies);
 // The portal seeds the built-in roles on its first request; seed them before batches are counted.
 await load('lib/server/identity/rbac.ts',dependencies).ensureBuiltinRoles();

 const one=async statement=>d.one(statement);
 const count=async(sql,...bindings)=>(await one(sql,...bindings)).n;
 const audits=async(action,fixture)=>count(sql`SELECT count(*) AS n FROM audit WHERE action=${action} AND actor=${fixture.actor.label}`);
 const allAudits=()=>count(sql`SELECT count(*) AS n FROM audit`);
 const failAudit=()=>createTrigger(d,'audit_unavailable','audit','BEFORE INSERT',{message:'audit unavailable'});
 const restoreAudit=()=>dropTrigger(d,'audit_unavailable');
 const staleCodes=['IDENTITY_LOGIN_REQUIRED','SESSION_EXPIRED','MFA_STEP_UP_REQUIRED'];

 // A local user with password, MFA account and one migrated authenticator.
 async function account(label){
  const {actor}=await sourceActor(d,label,['*']);actor.userId=actor.id;
  const key=actor.principal,at=Date.now(),authenticatorId=token();
  await d.exec(sql`UPDATE local_users SET password_hash='fixture-password',must_reset=0 WHERE id=${actor.id}`);
  await inTransaction(d,[
   sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at,authenticators_migrated) VALUES(${key},'migrated:authenticator-managed','[]',-1,${at},1)`,
   sql`INSERT INTO mfa_authenticators(id,principal,name,secret_enc,last_counter,created_at,last_used_at) VALUES(${authenticatorId},${key},'Authenticator',${await mfa.encryptSecret('A'.repeat(32),key)},-1,${at},NULL)`,
  ]);
  return {actor,key,authenticatorId};
 }
 const mfaSession=(fixture,session,passkeyId=null)=>{const at=Date.now();return sql`INSERT INTO mfa_sessions(token_hash,principal,created_at,last_activity,idle_expires_at,expires_at,passkey_id) VALUES(${sha(session)},${fixture.key},${at},${at},${at+3_600_000},${at+86_400_000},${passkeyId})`;};
 // A fully signed-in browser: bound primary session, MFA session (optionally
 // opened with a passkey) and a fresh management proof.
 async function signedIn(fixture,{passkeyId=null}={}){
  const at=Date.now(),primary=token(),session=token(),management=token();
  await inTransaction(d,[
   mfaSession(fixture,session,passkeyId),
   sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) SELECT ${sha(primary)},id,auth_version,${at},${at+86_400_000},${at+600_000},${sha(session)} FROM local_users WHERE id=${fixture.actor.id}`,
   sql`INSERT INTO mfa_management_proofs(token_hash,principal,session_hash,expires_at) VALUES(${sha(management)},${fixture.key},${sha(session)},${at+300_000})`,
  ]);
  return {primary,session,management};
 }
 async function passkey(fixture,name='Laptop'){
  const id='cred_'+crypto.randomBytes(8).toString('hex');
  await d.exec(sql`INSERT INTO passkey_credentials(id,principal,public_key,counter,transports,name,device,device_type,backed_up,created_at,last_used_at) VALUES(${id},${fixture.key},'AAAA',0,'[]',${name},'local','singleDevice',0,${Date.now()},NULL)`);
  return id;
 }
 async function extras(fixture,passkeyId){
  const at=Date.now();
  await inTransaction(d,[
   mfaSession(fixture,token(),passkeyId),
   sql`INSERT INTO mfa_grants(token_hash,principal,user_id,created_at,expires_at) VALUES(${sha(token())},${fixture.key},${fixture.actor.id},${at},${at+28_800_000})`,
   sql`INSERT INTO mfa_grants(token_hash,principal,user_id,created_at,expires_at) VALUES(${sha(token())},${fixture.key},${fixture.actor.id},${at},${at+28_800_000})`,
   sql`INSERT INTO passkey_challenges(id,principal,purpose,challenge,browser_hash,session_hash,rp_id,origin,name,device,expires_at) VALUES(${token()},${fixture.key},'authentication','challenge',${sha(token())},NULL,'passkey.test',${origin},'','any',${at+300_000})`,
  ]);
 }
 // A user with two passkeys; the target has a second MFA session, and the principal has MFA grants.
 async function scene(label,{currentPasskey=false}={}){
  const fixture=await account(label),target=await passkey(fixture,'Ziel'),second=await passkey(fixture,'Zweiter');
  await extras(fixture,target);
  const browser=await signedIn(fixture,{passkeyId:currentPasskey?target:null});
  return {fixture,target,second,browser};
 }
 async function snapshot(fixture){
  // text is fixture SQL with one ? for the value.
  const rows=async(text,value)=>JSON.stringify(await d.query(new SqlFragment(text.split('?'),[value])));
  return {
   credentials:await rows('SELECT * FROM passkey_credentials WHERE principal=? ORDER BY id',fixture.key),
   sessions:await rows('SELECT * FROM mfa_sessions WHERE principal=? ORDER BY token_hash',fixture.key),
   grants:await rows('SELECT * FROM mfa_grants WHERE principal=? ORDER BY token_hash',fixture.key),
   challenges:await rows('SELECT * FROM passkey_challenges WHERE principal=? ORDER BY id',fixture.key),
   primary:await rows('SELECT * FROM local_auth_sessions WHERE user_id=? ORDER BY token_hash',fixture.actor.id),
   authenticators:await rows('SELECT * FROM mfa_authenticators WHERE principal=? ORDER BY id',fixture.key),
   audit:await allAudits(),
  };
 }
 const proofs=fixture=>count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE principal=${fixture.key}`);
 // The tokens travel only as cookies.
 const headers=browser=>sessionHeaders(browser);
 const post=(api,path,payload,h)=>{const data={...payload};current=data.viewer;delete data.viewer;batches=0;standaloneWrites=[];return api.POST(new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...h},body:JSON.stringify(data)}));};
 const remove=(s,id=s.target,managementToken=s.browser.management)=>post(passkeyApi,'/api/passkeys',{viewer:s.fixture.actor,action:'delete',id,managementToken},headers(s.browser));
 const renamePasskey=(s,id,name)=>post(passkeyApi,'/api/passkeys',{viewer:s.fixture.actor,action:'rename',id,name},headers(s.browser));
 const renameAuthenticator=(s,id,name)=>post(mfaApi,'/api/mfa',{viewer:s.fixture.actor,action:'authenticator-rename',id,name},headers(s.browser));
 const isDelete=texts=>texts.some(text=>text.startsWith('DELETE FROM passkey_credentials'));
 const isPasskeyRename=texts=>texts.some(text=>text.startsWith('UPDATE passkey_credentials SET name'));
 const isAuthenticatorRename=texts=>texts.some(text=>text.startsWith('UPDATE mfa_authenticators SET name'));
 const disable=s=>()=>d.exec(sql`UPDATE local_users SET status='disabled',auth_version=auth_version+1 WHERE id=${s.fixture.actor.id}`);
 const passwordReset=s=>()=>d.exec(sql`UPDATE local_users SET auth_version=auth_version+1 WHERE id=${s.fixture.actor.id}`);
 const logout=s=>()=>d.exec(sql`DELETE FROM local_auth_sessions WHERE token_hash=${sha(s.browser.primary)}`);
 const primaryExpiry=s=>()=>d.exec(sql`UPDATE local_auth_sessions SET expires_at=${Date.now()-1000} WHERE token_hash=${sha(s.browser.primary)}`);
 // Runs the request with a hook right before its committing batch and checks
 // that the batch changed nothing: neither against the pre-request state nor
 // against the state the hook left behind.
 async function stale(s,match,mutate,request,what){
  const before=await snapshot(s.fixture);let atHook=null;
  beforeBatch={match,run:async()=>{await mutate();atHook=await snapshot(s.fixture);}};
  const response=await request(),body=await response.json();
  assert.equal(beforeBatch,null,`${what}: the hook ran right before the committing batch`);
  assert.ok([401,403].includes(response.status),`${what}: a stale request is rejected with 401 or 403, got ${response.status}`);
  assert.ok(staleCodes.includes(body.code),`${what}: a stale request gets an existing re-login code, got ${body.code}`);
  const after=await snapshot(s.fixture);
  for(const table of ['credentials','sessions','trust','challenges','authenticators','audit'])assert.deepEqual(after[table],before[table],`${what}: ${table} stay byte-identical`);
  assert.deepEqual(after,atHook,`${what}: the committing batch changed nothing after the hook`);
 }

 // A bystander whose rows no request of another user may touch.
 const bystander=await account('bystander@passkey.test'),bystanderPasskey=await passkey(bystander);
 await extras(bystander,bystanderPasskey);
 const bystanderBrowser=await signedIn(bystander,{passkeyId:bystanderPasskey}),bystanderBefore=await snapshot(bystander);
 const bystanderUnchanged=async what=>{const now=await snapshot(bystander);for(const table of ['credentials','sessions','trust','challenges','primary'])assert.deepEqual(now[table],bystanderBefore[table],`${what}: the other principal's ${table} are unchanged`);};

 // Fresh delete removes credential, its sessions, trust, challenges and proof.
 const fresh=await scene('fresh@passkey.test');
 {
  const s=fresh,before=await snapshot(s.fixture);
  const response=await remove(s);
  assert.equal(response.status,200,'a fresh delete succeeds although log() throws');assert.deepEqual(await response.json(),{ok:true});
  // One batch, no standalone write.
  assert.equal(batches,1,'delete issues exactly one batch');assert.deepEqual(standaloneWrites,[],'delete issues no write outside its batch');
  assert.equal(await one(sql`SELECT id FROM passkey_credentials WHERE id=${s.target}`),null,'the credential is gone');
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_sessions WHERE passkey_id=${s.target}`),0,'every MFA session opened with the passkey is gone');
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_grants WHERE principal=${s.fixture.key}`),0,'every MFA grant of the principal is gone');
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_challenges WHERE principal=${s.fixture.key}`),0,'all passkey challenges of the principal are gone');
  assert.equal(await one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${sha(s.browser.management)}`),null,'the management proof is consumed');
  assert.equal(await audits('Passkey entfernt',s.fixture),1,'exactly one audit row');
  assert.deepEqual(await one(sql`SELECT actor,target,server_id,scope FROM audit WHERE action='Passkey entfernt' AND actor=${s.fixture.actor.label}`),{actor:'fresh@passkey.test',target:'fresh@passkey.test',server_id:null,scope:'portal'},'audit row keeps actor, target and portal scope');
  const after=await snapshot(s.fixture);
  assert.deepEqual(JSON.parse(after.credentials).map(row=>row.id),[s.second],'the second passkey stays');
  assert.equal(JSON.parse(after.credentials)[0].name,JSON.parse(before.credentials).find(row=>row.id===s.second).name);
  assert.ok(await one(sql`SELECT token_hash FROM mfa_sessions WHERE token_hash=${sha(s.browser.session)}`),'the current MFA session (not opened with the passkey) stays');
  await bystanderUnchanged('fresh delete');
 }
 // The same proof cannot delete a second passkey.
 {
  const s=fresh,response=await remove(s,s.second);
  assert.equal(response.status,403);assert.equal((await response.json()).code,'MFA_STEP_UP_REQUIRED','a used proof requires a new step-up');
  assert.ok(await one(sql`SELECT id FROM passkey_credentials WHERE id=${s.second}`),'the second passkey still exists');
  assert.equal(await audits('Passkey entfernt',s.fixture),1,'no second audit row');
 }
 // Account disabled between check and commit.
 {const s=await scene('disabled@passkey.test');await stale(s,isDelete,disable(s),()=>remove(s),'disabled account');}
 // Password reset only (auth_version changes, account stays active).
 {const s=await scene('reset@passkey.test');await stale(s,isDelete,passwordReset(s),()=>remove(s),'password reset');}
 // Logout and primary expiry between check and commit.
 {const s=await scene('logout@passkey.test');await stale(s,isDelete,logout(s),()=>remove(s),'logout');}
 {const s=await scene('expiry@passkey.test');await stale(s,isDelete,primaryExpiry(s),()=>remove(s),'primary expiry');}
 // Deleting the passkey the current MFA session was opened with.
 {
  const s=await scene('current@passkey.test',{currentPasskey:true});
  const response=await remove(s);
  assert.equal(response.status,200,'the passkey of the current session can be deleted');
  assert.equal(await one(sql`SELECT id FROM passkey_credentials WHERE id=${s.target}`),null,'the credential is gone');
  assert.equal(await one(sql`SELECT token_hash FROM mfa_sessions WHERE token_hash=${sha(s.browser.session)}`),null,'the current MFA session opened with it is gone');
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_sessions WHERE passkey_id=${s.target}`),0,'no session of the deleted passkey remains');
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_grants WHERE principal=${s.fixture.key}`),0,'the MFA grants are gone');
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_challenges WHERE principal=${s.fixture.key}`),0,'challenges are gone');
  assert.equal(await proofs(s.fixture),0,'the proof is gone');
  assert.equal(await audits('Passkey entfernt',s.fixture),1,'exactly one audit row');
  assert.ok(await one(sql`SELECT id FROM passkey_credentials WHERE id=${s.second}`),'the second passkey stays');
 }
 // A failing audit insert rolls back everything; a retry succeeds.
 {
  const s=await scene('audit-fail@passkey.test'),before=await snapshot(s.fixture),proofCount=await proofs(s.fixture);
  await failAudit();
  const response=await remove(s);
  await restoreAudit();
  assert.ok(response.status>=400,'delete fails when the audit row cannot be written');
  assert.deepEqual(await snapshot(s.fixture),before,'credential, sessions, trust, challenges and audit stay unchanged');
  assert.equal(await proofs(s.fixture),proofCount,'the proof is kept for a retry');
  assert.equal(await audits('Passkey entfernt',s.fixture),0,'no audit row');
  const retry=await remove(s);
  assert.equal(retry.status,200,'the same management token succeeds once the audit works again');
  assert.equal(await one(sql`SELECT id FROM passkey_credentials WHERE id=${s.target}`),null);
  assert.equal(await audits('Passkey entfernt',s.fixture),1,'exactly one audit row after the retry');
 }
 // Unknown or foreign id.
 {
  const s=await scene('foreign@passkey.test'),before=await snapshot(s.fixture);
  for(const id of ['cred_unknown0000000',bystanderPasskey]){
   const response=await remove(s,id),body=await response.json();
   assert.equal(response.status,404);assert.equal(body.error,serverText('apiError.passkey.notFound'),`unknown id ${id} gives the existing 404`);
  }
  assert.deepEqual(await snapshot(s.fixture),before,'nothing of the requester changes and no audit row is written');
  assert.ok(await one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${sha(s.browser.management)}`),'the proof stays unused');
  await bystanderUnchanged('unknown or foreign id');
 }
 // Rename passkey.
 {
  const s=await scene('rename@passkey.test');
  const response=await renamePasskey(s,s.target,'  Neuer Name ');
  assert.equal(response.status,200,'a fresh rename succeeds although log() throws');assert.deepEqual(await response.json(),{ok:true});
  assert.equal(batches,1,'passkey rename issues exactly one batch');assert.deepEqual(standaloneWrites,[],'passkey rename issues no write outside its batch');
  assert.equal((await one(sql`SELECT name FROM passkey_credentials WHERE id=${s.target}`)).name,'Neuer Name','the name is updated');
  assert.equal(await audits('Passkey umbenannt',s.fixture),1,'exactly one audit row');
  const unknown=await renamePasskey(s,'cred_unknown0000000','Name');
  assert.equal(unknown.status,404);assert.equal((await unknown.json()).error,serverText('apiError.passkey.notFound'));
  assert.equal(await audits('Passkey umbenannt',s.fixture),1,'an unknown id writes no audit row');
  const staleScene=await scene('rename-stale@passkey.test');
  await stale(staleScene,isPasskeyRename,disable(staleScene),()=>renamePasskey(staleScene,staleScene.target,'Spät'),'stale passkey rename');
  assert.equal((await one(sql`SELECT name FROM passkey_credentials WHERE id=${staleScene.target}`)).name,'Ziel','a stale rename keeps the name');
  assert.equal(await audits('Passkey umbenannt',staleScene.fixture),0,'a stale rename writes no audit row');
 }
 // Rename authenticator.
 {
  const s=await scene('authenticator@passkey.test');
  const response=await renameAuthenticator(s,s.fixture.authenticatorId,'Telefon'),body=await response.json();
  assert.equal(response.status,200,'a fresh authenticator rename succeeds although log() throws');
  assert.equal(batches,1,'authenticator rename issues exactly one batch');assert.deepEqual(standaloneWrites,[],'authenticator rename issues no write outside its batch');
  assert.equal(body.authenticatorCount,1,'the response keeps the authenticator metadata');
  assert.deepEqual(body.authenticators.map(a=>a.name),['Telefon']);
  assert.equal((await one(sql`SELECT name FROM mfa_authenticators WHERE id=${s.fixture.authenticatorId}`)).name,'Telefon');
  assert.equal(await audits('Authenticator umbenannt',s.fixture),1,'exactly one audit row');
  const unknown=await renameAuthenticator(s,token(),'Name');
  assert.equal(unknown.status,404);assert.equal((await unknown.json()).error,serverText('apiError.mfa.authenticatorNotFound'));
  const staleScene=await scene('authenticator-stale@passkey.test');
  await stale(staleScene,isAuthenticatorRename,disable(staleScene),()=>renameAuthenticator(staleScene,staleScene.fixture.authenticatorId,'Spät'),'stale authenticator rename');
  assert.equal((await one(sql`SELECT name FROM mfa_authenticators WHERE id=${staleScene.fixture.authenticatorId}`)).name,'Authenticator','a stale rename keeps the name');
  assert.equal(await audits('Authenticator umbenannt',staleScene.fixture),0,'a stale rename writes no audit row');
 }
 // Static check: no standalone proof consumption, no post-commit log().
 {
  const passkeys=readFileSync('lib/server/identity/passkeys.ts','utf8'),deleteBody=passkeys.slice(passkeys.indexOf('export async function deletePasskey('));
  assert.ok(!deleteBody.slice(0,deleteBody.indexOf('\n}')).includes('consumeMfaManagementProof'),'deletePasskey does not consume the proof separately');
  const branch=(file,action)=>readFileSync(file,'utf8').split('\n').find(line=>line.includes(`p.action==='${action}'`));
  for(const [file,action] of [['app/api/passkeys/route.ts','rename'],['app/api/passkeys/route.ts','delete'],['app/api/mfa/route.ts','authenticator-rename']])assert.ok(!branch(file,action).includes('log('),`${action} does not call log()`);
 }
 await bystanderUnchanged('end');
 assert.ok(await one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${sha(bystanderBrowser.management)}`),'the other principal keeps its proof');
 console.log('PASS passkey session binding: passkey delete and passkey/authenticator renames commit change and audit row in one batch fenced by the live primary and MFA session; stale requests change nothing.');
}finally{d.close();}
