// Authenticator begin/confirm/delete, MFA disable and passkey registration commit
// in one batch fenced by the still-live primary and MFA session; the
// audited ones write their audit row inside that batch. Real route and
// lib sources run against a migrated PostgreSQL test database; log() throws, so every
// success proves the audit row was written in the batch.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,sourceActor,inTransaction,createTrigger,dropTrigger} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sessionHeaders} from '../support/session-cookies.mjs';
import {sql} from '../../runtime/database.mjs';

const d=await sourceDatabase();
try{
 const origin='https://passkey.test';
 const HttpError=realHttpError;
 const unavailable=serverText('apiError.storageUnavailable');
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 // A one-shot hook runs right before the first transaction whose statements
 // match (the hooked database reads them in a rolled-back dry run). Writes
 // outside a transaction are recorded, so each action can prove it commits
 // through exactly one transaction.
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
  // Mirrors lib/server/context.ts failure(): any non-HttpError becomes the generic 503.
  failure:e=>Response.json({error:e instanceof HttpError?e.message:unavailable,...(e instanceof HttpError&&e.code?{code:e.code}:{})},{status:e instanceof HttpError?e.status:503}),
 };
 const webauthn={
  generateRegistrationOptions:async()=>({challenge:'registration-'+token()}),
  verifyRegistrationResponse:async({response})=>({verified:true,registrationInfo:{credential:{id:response.id,publicKey:new Uint8Array([1,2,3,4]),counter:0,transports:[]},credentialDeviceType:'singleDevice',credentialBackedUp:false}}),
  generateAuthenticationOptions:async()=>({}),verifyAuthenticationResponse:async()=>({verified:false}),
 };
 const load=sourceLoader(),dependencies={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'@simplewebauthn/server':webauthn};
 const mfa=load('lib/server/identity/mfa.ts',dependencies);
 const {otpauthUri}=load('lib/server/identity/mfa-uri.ts',dependencies);
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
 const code=secret=>mfa.totp(secret,Math.floor(Date.now()/30000));

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
 const managementProof=(fixture,session,management)=>sql`INSERT INTO mfa_management_proofs(token_hash,principal,session_hash,expires_at) VALUES(${sha(management)},${fixture.key},${sha(session)},${Date.now()+300_000})`;
 // A fully signed-in browser: bound primary session, MFA session and a fresh
 // management proof.
 async function signedIn(fixture){
  const at=Date.now(),primary=token(),session=token(),management=token();
  await inTransaction(d,[
   mfaSession(fixture,session),
   sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) SELECT ${sha(primary)},id,auth_version,${at},${at+86_400_000},${at+600_000},${sha(session)} FROM local_users WHERE id=${fixture.actor.id}`,
   managementProof(fixture,session,management),
  ]);
  return {primary,session,management};
 }
 // A second authenticator, a passkey, and another browser with its own MFA
 // session, proof, pending authenticator challenge, MFA grants and challenges.
 async function extras(fixture){
  const at=Date.now(),other=token(),otherProof=token(),secondAuthenticator=token(),passkeyId='cred_'+crypto.randomBytes(8).toString('hex');
  await inTransaction(d,[
   sql`INSERT INTO mfa_authenticators(id,principal,name,secret_enc,last_counter,created_at,last_used_at) VALUES(${secondAuthenticator},${fixture.key},'Zweiter',${await mfa.encryptSecret('B'.repeat(32),fixture.key)},-1,${at+1},NULL)`,
   sql`INSERT INTO passkey_credentials(id,principal,public_key,counter,transports,name,device,device_type,backed_up,created_at,last_used_at) VALUES(${passkeyId},${fixture.key},'AAAA',0,'[]','Laptop','local','singleDevice',0,${at},NULL)`,
   mfaSession(fixture,other),managementProof(fixture,other,otherProof),
   sql`INSERT INTO mfa_authenticator_challenges(id,principal,session_hash,authenticator_id,previous_secret_enc,name,secret_enc,expires_at) VALUES(${token()},${fixture.key},${sha(other)},NULL,NULL,'Fremd','pending',${at+300_000})`,
   sql`INSERT INTO mfa_grants(token_hash,principal,user_id,created_at,expires_at) VALUES(${sha(token())},${fixture.key},${fixture.actor.id},${at},${at+28_800_000})`,
   sql`INSERT INTO mfa_grants(token_hash,principal,user_id,created_at,expires_at) VALUES(${sha(token())},${fixture.key},${fixture.actor.id},${at},${at+28_800_000})`,
   sql`INSERT INTO passkey_challenges(id,principal,purpose,challenge,browser_hash,session_hash,rp_id,origin,name,device,expires_at) VALUES(${token()},${fixture.key},'authentication','challenge',${sha(token())},NULL,'passkey.test',${origin},'','any',${at+300_000})`,
   sql`INSERT INTO mfa_challenges(principal,secret_enc,expires_at) VALUES(${fixture.key},'enrollment',${at+600_000})`,
   sql`INSERT INTO mfa_proofs(token_hash,principal,expires_at) VALUES(${sha(token())},${fixture.key},${at+300_000})`,
  ]);
  return {other,otherProof,secondAuthenticator,passkeyId};
 }
 async function scene(label,{rich=true}={}){
  const fixture=await account(label),more=rich?await extras(fixture):{},browser=await signedIn(fixture);
  return {fixture,browser,...more};
 }
 // The ten MFA and passkey tables of the principal plus the total audit count.
 // `skip` leaves out the request's own proof and challenge, which a stale
 // request may consume.
 const tables=[['mfa_accounts','principal'],['mfa_authenticators','id'],['mfa_authenticator_challenges','id'],['mfa_challenges','principal'],['mfa_proofs','token_hash'],['mfa_sessions','token_hash'],['mfa_grants','token_hash'],['mfa_management_proofs','token_hash'],['passkey_credentials','id'],['passkey_challenges','id']];
 async function snapshot(fixture,skip={}){
  const result={};
  for(const [table,column] of tables){
   const rows=(await d.query(sql`SELECT * FROM ${sql.ident(table)} WHERE principal=${fixture.key} ORDER BY ${sql.ident(column)}`));
   result[table]=JSON.stringify(rows.filter(row=>!(table==='mfa_management_proofs'&&row.token_hash===skip.proof)&&!(table==='mfa_authenticator_challenges'&&row.id===skip.authenticatorChallenge)&&!(table==='passkey_challenges'&&row.id===skip.passkeyChallenge)));
  }
  result.audit=await allAudits();
  return result;
 }
 // The tokens travel only as cookies.
 const headers=(browser,cookie)=>sessionHeaders(browser,cookie?{Cookie:cookie}:{});
 const post=(api,path,payload,h)=>{const data={...payload};current=data.viewer;delete data.viewer;batches=0;standaloneWrites=[];return api.POST(new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...h},body:JSON.stringify(data)}));};
 const begin=(s,{id,managementToken=s.browser.management}={})=>post(mfaApi,'/api/mfa',{viewer:s.fixture.actor,action:'authenticator-begin',name:'Telefon',managementToken,...(id?{id}:{})},headers(s.browser));
 const confirm=(s,challengeId,value)=>post(mfaApi,'/api/mfa',{viewer:s.fixture.actor,action:'authenticator-confirm',challengeId,code:value},headers(s.browser));
 const removeAuthenticator=(s,id,managementToken=s.browser.management)=>post(mfaApi,'/api/mfa',{viewer:s.fixture.actor,action:'authenticator-delete',id,managementToken},headers(s.browser));
 const disableMfa=(s,managementToken=s.browser.management)=>post(mfaApi,'/api/mfa',{viewer:s.fixture.actor,action:'disable',managementToken},headers(s.browser));
 const regenerate=(s,managementToken=s.browser.management)=>post(mfaApi,'/api/mfa',{viewer:s.fixture.actor,action:'regenerate-recovery',managementToken},headers(s.browser));
 const options=(s,managementToken=s.browser.management)=>post(passkeyApi,'/api/passkeys',{viewer:s.fixture.actor,action:'registration-options',name:'Neuer Passkey',device:'local',managementToken},headers(s.browser));
 const credentialId='cred_'+crypto.randomBytes(8).toString('hex');
 const registrationResponse=(id=credentialId)=>({id,rawId:id,type:'public-key',response:{clientDataJSON:Buffer.from(JSON.stringify({type:'webauthn.create',challenge:'x',origin})).toString('base64url'),attestationObject:'AAAA'}});
 const verify=(s,registration,response=registrationResponse())=>post(passkeyApi,'/api/passkeys',{viewer:s.fixture.actor,action:'registration-verify',challengeId:registration.challengeId,response},headers(s.browser,registration.cookie));
 // Fresh begin (consumes the proof) for the confirm scenes.
 async function begun(s,id){
  const response=await begin(s,{id});assert.equal(response.status,200,'begin succeeds');return response.json();
 }
 // Fresh registration options (consumes the proof) for the verify scenes.
 async function registration(s){
  const response=await options(s),body=await response.json();assert.equal(response.status,200,'registration options succeed');
  const cookie=response.headers.getSetCookie().find(value=>value.startsWith('__Host-serverdesk-passkey='));
  return {challengeId:body.challengeId,cookie:cookie.split(';')[0]};
 }
 const matches=prefix=>texts=>texts.some(text=>text.startsWith(prefix));
 const mutations={
  disable:s=>()=>d.exec(sql`UPDATE local_users SET status='disabled',auth_version=auth_version+1 WHERE id=${s.fixture.actor.id}`),
  passwordReset:s=>()=>d.exec(sql`UPDATE local_users SET auth_version=auth_version+1 WHERE id=${s.fixture.actor.id}`),
  logout:s=>()=>d.exec(sql`DELETE FROM local_auth_sessions WHERE token_hash=${sha(s.browser.primary)}`),
  primaryExpiry:s=>()=>d.exec(sql`UPDATE local_auth_sessions SET expires_at=${Date.now()-1000} WHERE token_hash=${sha(s.browser.primary)}`),
 };
 // Runs the request with a hook right before its committing batch and checks
 // that the batch changed nothing: neither against the pre-request state nor
 // against the state the hook left behind.
 async function stale(s,match,mutate,request,what,skip={}){
  const before=await snapshot(s.fixture,skip);let atHook=null;
  beforeBatch={match,run:async()=>{await mutate();atHook=await snapshot(s.fixture,skip);}};
  const response=await request(),body=await response.json();
  assert.equal(beforeBatch,null,`${what}: the hook ran right before the committing batch`);
  beforeBatch=null;
  assert.ok([401,403].includes(response.status),`${what}: a stale request is rejected with 401 or 403, got ${response.status} ${body.error}`);
  assert.ok(staleCodes.includes(body.code),`${what}: a stale request gets an existing re-login code, got ${body.code}`);
  const after=await snapshot(s.fixture,skip);
  assert.deepEqual(after,before,`${what}: the principal's rows stay byte-identical to the pre-request state`);
  assert.deepEqual(after,atHook,`${what}: the committing batch changed nothing after the hook`);
 }

 // A bystander whose rows no request of another user may touch.
 const bystander=await scene('bystander@mfa.test'),bystanderBefore=await snapshot(bystander.fixture);
 const bystanderUnchanged=async what=>{const now=await snapshot(bystander.fixture);for(const [table] of tables)assert.deepEqual(now[table],bystanderBefore[table],`${what}: the other principal's ${table} are unchanged`);};

 // Fresh begin creates one challenge bound to the MFA session and consumes the proof.
 {
  const s=await scene('begin@mfa.test');
  const response=await begin(s),body=await response.json();
  assert.equal(response.status,200,'a fresh begin succeeds');
  assert.ok(body.challengeId&&body.secret&&body.uri&&body.expiresAt,'begin returns challengeId, secret, uri and expiresAt');
  // The URI comes from lib/server/identity/mfa-uri.ts and keeps its exact format.
  const label='Nodiverna:'+s.fixture.actor.label+' (Telefon)';
  assert.equal(body.uri,otpauthUri(label,body.secret),'begin returns the URI of otpauthUri');
  assert.equal(body.uri,`otpauth://totp/${encodeURIComponent(label)}?secret=${body.secret}&issuer=Nodiverna&algorithm=SHA1&digits=6&period=30`,'the URI format is unchanged');
  assert.equal(batches,1,'begin issues exactly one batch');assert.deepEqual(standaloneWrites,[],'begin issues no write outside its batch');
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_authenticator_challenges WHERE principal=${s.fixture.key} AND session_hash=${sha(s.browser.session)}`),1,'exactly one challenge bound to the current MFA session');
  assert.ok(await one(sql`SELECT id FROM mfa_authenticator_challenges WHERE id=${body.challengeId} AND session_hash=${sha(s.browser.session)}`),'the returned challenge is the bound one');
  assert.equal(await one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${sha(s.browser.management)}`),null,'the proof is consumed');
  const again=await begin(s);
  assert.equal(again.status,403);assert.equal((await again.json()).code,'MFA_STEP_UP_REQUIRED','a used proof requires a new step-up');
 }
 // Stale begin creates no challenge.
 for(const [name,mutate] of Object.entries(mutations)){
  const s=await scene(`begin-${name}@mfa.test`);
  await stale(s,matches('INSERT INTO mfa_authenticator_challenges'),mutate(s),()=>begin(s),`stale begin ${name}`,{proof:sha(s.browser.management)});
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_authenticator_challenges WHERE session_hash=${sha(s.browser.session)}`),0,`stale begin ${name}: no challenge is created`);
 }
 // Fresh confirm adds the authenticator and writes the audit row in the batch.
 {
  const s=await scene('confirm-add@mfa.test'),started=await begun(s);
  await d.exec(sql`INSERT INTO mfa_attempts(principal,attempts,window_at,blocked_until) VALUES(${s.fixture.key},2,${Date.now()},0)`);
  const response=await confirm(s,started.challengeId,await code(started.secret)),body=await response.json();
  assert.equal(response.status,200,'a fresh confirm succeeds although log() throws');
  assert.equal(body.authenticatorCount,3,'the response carries the updated authenticator count');assert.equal(body.authenticators.length,3);
  assert.equal(batches,1,'confirm issues exactly one batch');
  assert.equal(standaloneWrites.length,1,'the only standalone write is the attempt counter');assert.match(standaloneWrites[0],/^INSERT INTO mfa_attempts/);
  const added=await one(sql`SELECT * FROM mfa_authenticators WHERE principal=${s.fixture.key} AND name='Telefon'`);
  assert.ok(added,'the new authenticator exists');
  assert.equal(await mfa.decryptSecret(added.secret_enc,s.fixture.key),started.secret,'it holds the begun secret');
  assert.equal(await one(sql`SELECT id FROM mfa_authenticator_challenges WHERE id=${started.challengeId}`),null,'the challenge is gone');
  assert.equal(await one(sql`SELECT principal FROM mfa_attempts WHERE principal=${s.fixture.key}`),null,'the attempt counter is reset');
  assert.equal(await audits('Authenticator eingerichtet oder zurückgesetzt',s.fixture),1,'exactly one audit row');
  assert.deepEqual(await one(sql`SELECT actor,target,server_id,scope FROM audit WHERE action='Authenticator eingerichtet oder zurückgesetzt' AND actor=${s.fixture.actor.label}`),{actor:'confirm-add@mfa.test',target:'confirm-add@mfa.test',server_id:null,scope:'portal'},'audit row keeps actor, target and portal scope');
  // Replay of the used challenge.
  const replay=await confirm(s,started.challengeId,await code(started.secret)),replayBody=await replay.json();
  assert.equal(replay.status,409,'a replayed confirm is rejected');
  assert.ok([serverText('apiError.mfa.addSetupExpired'),serverText('apiError.mfa.authenticatorChangedRestart')].includes(replayBody.error),'the replay gets an existing 409 text');
  assert.equal(await audits('Authenticator eingerichtet oder zurückgesetzt',s.fixture),1,'a replay writes no second audit row');
 }
 // Fresh reset replaces the secret and ends other sessions and pending work.
 {
  const s=await scene('confirm-reset@mfa.test'),started=await begun(s,s.fixture.authenticatorId);
  const response=await confirm(s,started.challengeId,await code(started.secret));
  assert.equal(response.status,200,'a fresh reset succeeds although log() throws');
  assert.equal(batches,1,'reset issues exactly one batch');
  const reset=await one(sql`SELECT * FROM mfa_authenticators WHERE id=${s.fixture.authenticatorId}`);
  assert.equal(await mfa.decryptSecret(reset.secret_enc,s.fixture.key),started.secret,'the authenticator holds the new secret');
  assert.equal(await one(sql`SELECT token_hash FROM mfa_sessions WHERE token_hash=${sha(s.other)}`),null,'the other MFA session is gone');
  assert.ok(await one(sql`SELECT token_hash FROM mfa_sessions WHERE token_hash=${sha(s.browser.session)}`),'the current MFA session stays');
  for(const table of ['mfa_grants','mfa_management_proofs','passkey_challenges','mfa_authenticator_challenges'])assert.equal(await count(sql`SELECT count(*) AS n FROM ${sql.ident(table)} WHERE principal=${s.fixture.key}`),0,`fresh reset: ${table} of the principal are gone`);
  assert.equal(await audits('Authenticator eingerichtet oder zurückgesetzt',s.fixture),1,'exactly one audit row');
 }
 // Stale confirm on the add and the reset path changes nothing.
 for(const path of ['add','reset'])for(const [name,mutate] of Object.entries(mutations)){
  const s=await scene(`confirm-${path}-${name}@mfa.test`),started=await begun(s,path==='reset'?s.fixture.authenticatorId:undefined);
  const match=matches(path==='reset'?'UPDATE mfa_authenticators SET name = $1,secret_enc':'INSERT INTO mfa_authenticators');
  const value=await code(started.secret);
  await stale(s,match,mutate(s),()=>confirm(s,started.challengeId,value),`stale confirm ${path} ${name}`,{authenticatorChallenge:started.challengeId});
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_sessions WHERE token_hash=${sha(s.other)}`),1,`stale confirm ${path} ${name}: the other session stays`);
 }
 // Fresh delete removes the authenticator, other sessions, MFA grants, challenges and proofs.
 const deleted=await scene('delete@mfa.test');
 {
  const s=deleted;
  const response=await removeAuthenticator(s,s.secondAuthenticator),body=await response.json();
  assert.equal(response.status,200,'a fresh delete succeeds although log() throws');
  assert.equal(body.authenticatorCount,1);assert.deepEqual(body.authenticators.map(a=>a.id),[s.fixture.authenticatorId],'the response carries the updated metadata');
  assert.equal(batches,1,'delete issues exactly one batch');assert.deepEqual(standaloneWrites,[],'delete issues no write outside its batch');
  assert.equal(await one(sql`SELECT id FROM mfa_authenticators WHERE id=${s.secondAuthenticator}`),null,'the authenticator is gone');
  assert.equal(await one(sql`SELECT token_hash FROM mfa_sessions WHERE token_hash=${sha(s.other)}`),null,'the other MFA session is gone');
  assert.ok(await one(sql`SELECT token_hash FROM mfa_sessions WHERE token_hash=${sha(s.browser.session)}`),'the current MFA session stays');
  for(const table of ['mfa_grants','mfa_authenticator_challenges','passkey_challenges'])assert.equal(await count(sql`SELECT count(*) AS n FROM ${sql.ident(table)} WHERE principal=${s.fixture.key}`),0,`fresh delete: ${table} of the principal are gone`);
  assert.equal(await one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${sha(s.browser.management)}`),null,'the own proof is consumed');
  assert.equal(await one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${sha(s.otherProof)}`),null,'the other browser\'s proof is gone');
  assert.equal(await audits('Authenticator entfernt',s.fixture),1,'exactly one audit row');
  await bystanderUnchanged('fresh delete');
 }
 // Stale delete keeps everything, including the other browser's proof.
 for(const [name,mutate] of Object.entries(mutations)){
  const s=await scene(`delete-${name}@mfa.test`);
  await stale(s,matches('DELETE FROM mfa_authenticators'),mutate(s),()=>removeAuthenticator(s,s.secondAuthenticator),`stale delete ${name}`,{proof:sha(s.browser.management)});
  assert.ok(await one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${sha(s.otherProof)}`),`stale delete ${name}: the other session's proof is kept`);
 }
 // Existing guards: last authenticator, unknown id, used proof.
 {
  const s=await scene('delete-guards@mfa.test',{rich:false}),before=await snapshot(s.fixture);
  const last=await removeAuthenticator(s,s.fixture.authenticatorId),lastBody=await last.json();
  assert.equal(last.status,409);assert.equal(lastBody.error,serverText('apiError.mfa.lastAuthenticator'),'the last authenticator cannot be removed');
  assert.equal(batches,0,'the last-authenticator check writes nothing');
  const unknown=await removeAuthenticator(s,token());
  assert.equal(unknown.status,404);assert.equal((await unknown.json()).error,serverText('apiError.mfa.authenticatorNotFound'));
  assert.equal(batches,0,'an unknown id writes nothing');
  assert.deepEqual(await snapshot(s.fixture),before,'neither case changes a row, and the proof stays unused');
  const used=await removeAuthenticator(deleted,deleted.fixture.authenticatorId);
  assert.equal(used.status,403);assert.equal((await used.json()).code,'MFA_STEP_UP_REQUIRED','a used proof requires a new step-up');
 }
 // Fresh disable removes every MFA and passkey row of the principal.
 {
  const s=await scene('disable@mfa.test');
  const response=await disableMfa(s);
  assert.equal(response.status,200,'a fresh disable succeeds although log() throws');
  assert.deepEqual(await response.json(),{ok:true,authenticated:false});
  const cookies=response.headers.getSetCookie();
  assert.ok(cookies.some(c=>c.startsWith('__Host-serverdesk-mfa=;')&&c.includes('Max-Age=0')),'the MFA session cookie is cleared');
  assert.ok(cookies.some(c=>c.startsWith('__Host-serverdesk-mfa-grant=;')&&c.includes('Max-Age=0')),'the MFA grant cookie is cleared');
  assert.ok(cookies.some(c=>c.startsWith('__Host-serverdesk-mfa-trust=;')&&c.includes('Max-Age=0')),'the cookie of the removed remembered browser is cleared too');
  assert.equal(batches,1,'disable issues exactly one batch');assert.deepEqual(standaloneWrites,[],'disable issues no write outside its batch');
  for(const [table] of tables)assert.equal(await count(sql`SELECT count(*) AS n FROM ${sql.ident(table)} WHERE principal=${s.fixture.key}`),0,`fresh disable: ${table} of the principal are gone`);
  assert.equal(await audits('MFA deaktiviert',s.fixture),1,'exactly one audit row');
  await bystanderUnchanged('fresh disable');
 }
 // Stale disable consumes nothing, the account stays.
 for(const [name,mutate] of Object.entries(mutations)){
  const s=await scene(`disable-${name}@mfa.test`);
  await stale(s,matches('DELETE FROM mfa_accounts'),mutate(s),()=>disableMfa(s),`stale disable ${name}`);
  assert.ok(await one(sql`SELECT principal FROM mfa_accounts WHERE principal=${s.fixture.key}`),`stale disable ${name}: the MFA account still exists`);
 }
 // Registration options: fresh and stale.
 {
  const s=await scene('options@mfa.test');
  const response=await options(s),body=await response.json();
  assert.equal(response.status,200,'fresh registration options succeed');
  assert.ok(body.challengeId&&body.options,'options return challengeId and options');
  assert.equal(batches,1,'options issue exactly one batch');
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_challenges WHERE principal=${s.fixture.key} AND purpose='registration' AND session_hash=${sha(s.browser.session)}`),1,'exactly one registration challenge bound to the MFA session');
  assert.equal(await one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${sha(s.browser.management)}`),null,'the proof is consumed');
  const again=await options(s);
  assert.equal(again.status,403);assert.equal((await again.json()).code,'MFA_STEP_UP_REQUIRED','a used proof requires a new step-up');
 }
 for(const [name,mutate] of Object.entries(mutations)){
  const s=await scene(`options-${name}@mfa.test`);
  await stale(s,matches('INSERT INTO passkey_challenges'),mutate(s),()=>options(s),`stale options ${name}`,{proof:sha(s.browser.management)});
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_challenges WHERE principal=${s.fixture.key} AND purpose='registration'`),0,`stale options ${name}: no registration challenge exists`);
 }
 // Fresh verify stores the credential and writes the audit row in the batch.
 {
  const s=await scene('verify@mfa.test'),started=await registration(s);
  const response=await verify(s,started),body=await response.json();
  assert.equal(response.status,200,'a fresh verify succeeds although log() throws');assert.deepEqual(body,{ok:true});
  assert.ok(response.headers.getSetCookie().some(c=>c.startsWith('__Host-serverdesk-passkey=;')&&c.includes('Max-Age=0')),'the passkey cookie is cleared');
  assert.equal(batches,1,'verify issues exactly one batch');
  assert.equal(standaloneWrites.length,1,'the only standalone write is the attempt counter');assert.match(standaloneWrites[0],/^INSERT INTO mfa_attempts/);
  assert.ok(await one(sql`SELECT id FROM passkey_credentials WHERE id=${credentialId} AND principal=${s.fixture.key}`),'the credential exists');
  assert.equal(await one(sql`SELECT id FROM passkey_challenges WHERE id=${started.challengeId}`),null,'the challenge is gone');
  assert.equal(await audits('Passkey eingerichtet',s.fixture),1,'exactly one audit row');
  // Replay of the used challenge.
  const replay=await verify(s,started,registrationResponse('cred_replay0000000'));
  assert.equal(replay.status,409,'a replayed verify gets the existing 409');
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_credentials WHERE principal=${s.fixture.key} AND id=${'cred_replay0000000'}`),0,'no second credential');
  assert.equal(await audits('Passkey eingerichtet',s.fixture),1,'no second audit row');
 }
 // Stale verify creates no credential.
 for(const [name,mutate] of Object.entries(mutations)){
  const s=await scene(`verify-${name}@mfa.test`),started=await registration(s);
  await stale(s,matches('INSERT INTO passkey_credentials'),mutate(s),()=>verify(s,started,registrationResponse('cred_stale_'+name)),`stale verify ${name}`,{passkeyChallenge:started.challengeId});
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_credentials WHERE principal=${s.fixture.key} AND name='Neuer Passkey'`),0,`stale verify ${name}: no credential is created`);
 }
 // A failing audit insert rolls back everything; the same request then succeeds.
 async function auditFailure(what,s,request,action){
  const before=await snapshot(s.fixture);
  await failAudit();
  let response,failed;try{response=await request();failed={status:response.status,body:await response.json()};}finally{await restoreAudit();}
  assert.ok(response.status>=400,`${what}: fails when the audit row cannot be written`);
  assert.deepEqual(await snapshot(s.fixture),before,`${what}: the principal's rows, own proof and own challenge stay unchanged`);
  assert.equal(await audits(action,s.fixture),0,`${what}: no audit row`);
  const retry=await request();
  assert.equal(retry.status,200,`${what}: the same request succeeds once the audit works again`);
  assert.equal(await audits(action,s.fixture),1,`${what}: exactly one audit row after the retry`);
  return failed;
 }
 {
  const s=await scene('audit-confirm@mfa.test'),started=await begun(s);
  await auditFailure('audit failure confirm',s,async()=>confirm(s,started.challengeId,await code(started.secret)),'Authenticator eingerichtet oder zurückgesetzt');
 }
 {const s=await scene('audit-delete@mfa.test');await auditFailure('audit failure delete',s,()=>removeAuthenticator(s,s.secondAuthenticator),'Authenticator entfernt');}
 {const s=await scene('audit-disable@mfa.test');await auditFailure('audit failure disable',s,()=>disableMfa(s),'MFA deaktiviert');}
 {
  const s=await scene('audit-verify@mfa.test'),started=await registration(s);
  const failed=await auditFailure('audit failure verify',s,()=>verify(s,started,registrationResponse('cred_auditretry000')),'Passkey eingerichtet');
  // The audit trigger error is not a duplicate ID, so it keeps the generic 503.
  assert.equal(failed.status,503,'audit failure verify: a failing audit insert returns exactly 503');
  assert.equal(failed.body.error,unavailable,'audit failure verify: a failing audit insert keeps the generic text');
 }
 // A credential ID that is already stored returns one neutral 409 and
 // discards the registration challenge; nothing else changes.
 const duplicateText=serverText('apiError.passkey.duplicate');
 const usedText=serverText('apiError.passkey.ceremonyExpiredOrUsed');
 // The ID belongs to the requester's own passkey.
 {
  const s=await scene('dup-own@mfa.test'),started=await registration(s);
  const before=await snapshot(s.fixture,{passkeyChallenge:started.challengeId}),own=await one(sql`SELECT * FROM passkey_credentials WHERE id=${s.passkeyId}`);
  assert.ok(await one(sql`SELECT id FROM passkey_challenges WHERE id=${started.challengeId}`),'own duplicate ID: the registration challenge is open before the verify');
  const response=await verify(s,started,registrationResponse(s.passkeyId)),body=await response.json();
  assert.equal(response.status,409,'own duplicate ID: an own duplicate ID returns 409');
  assert.equal(body.error,duplicateText,'own duplicate ID: the duplicate 409 carries the UI copy');
  assert.equal(body.code,'CONFLICT','own duplicate ID: the duplicate 409 has no re-login code');
  assert.equal(batches,1,'own duplicate ID: the duplicate verify issues exactly one batch');
  const after=await snapshot(s.fixture,{passkeyChallenge:started.challengeId});
  assert.equal(after.passkey_credentials,before.passkey_credentials,'own duplicate ID: the passkey credentials of the principal are unchanged');
  assert.deepEqual(await one(sql`SELECT * FROM passkey_credentials WHERE id=${s.passkeyId}`),own,'own duplicate ID: the existing credential row is byte-identical');
  assert.deepEqual(after,before,'own duplicate ID: apart from the own challenge, the rows of the principal and the audit count are unchanged');
  assert.equal(await audits('Passkey eingerichtet',s.fixture),0,'own duplicate ID: no audit row for the rejected duplicate');
  assert.equal(await allAudits(),before.audit,'own duplicate ID: the total audit count is unchanged');
  assert.equal(await one(sql`SELECT id FROM passkey_challenges WHERE id=${started.challengeId}`),null,'own duplicate ID: the registration challenge is deleted');
  // The same challenge cannot be replayed after a duplicate.
  const replay=await verify(s,started,registrationResponse(s.passkeyId)),replayBody=await replay.json();
  assert.equal(replay.status,409,'replay after a duplicate: a replay after a duplicate returns 409, not 503 or 200');
  assert.equal(replayBody.error,usedText,'replay after a duplicate: the replay gets the existing used-challenge text');
  assert.equal(await allAudits(),before.audit,'replay after a duplicate: the replay writes no audit row');
  await bystanderUnchanged('own duplicate ID');
 }
 // The ID belongs to another principal; same response, nothing of theirs changes.
 {
  const s=await scene('dup-other@mfa.test'),started=await registration(s);
  const before=await snapshot(s.fixture,{passkeyChallenge:started.challengeId});
  const response=await verify(s,started,registrationResponse(bystander.passkeyId)),body=await response.json();
  assert.equal(response.status,409,'foreign duplicate ID: a foreign duplicate ID returns 409');
  assert.equal(body.error,duplicateText,'foreign duplicate ID: the same text as for an own duplicate, so the owner is not revealed');
  assert.equal(body.code,'CONFLICT','foreign duplicate ID: the duplicate 409 has no re-login code');
  await bystanderUnchanged('foreign duplicate ID');
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_credentials WHERE principal=${s.fixture.key} AND id=${bystander.passkeyId}`),0,'foreign duplicate ID: the requester gets no row with that ID');
  assert.deepEqual(await snapshot(s.fixture,{passkeyChallenge:started.challengeId}),before,'foreign duplicate ID: apart from the own challenge, the rows of the requester and the audit count are unchanged');
  assert.equal(await one(sql`SELECT id FROM passkey_challenges WHERE id=${started.challengeId}`),null,'foreign duplicate ID: the registration challenge is deleted');
 }
 // A stale session wins over a duplicate ID: the guarded insert writes nothing.
 {
  const s=await scene('dup-stale@mfa.test'),started=await registration(s);
  await stale(s,matches('INSERT INTO passkey_credentials'),mutations.logout(s),()=>verify(s,started,registrationResponse(bystander.passkeyId)),'stale duplicate ID',{passkeyChallenge:started.challengeId});
  await bystanderUnchanged('stale duplicate ID');
 }
 // Fresh recovery renewal replaces the hashes and writes the audit row in the batch.
 const recoveryHashes=(s,codes)=>JSON.stringify(codes.map(value=>sha(s.fixture.key+'\0'+value.replace(/-/g,''))));
 const storedHashes=async s=>(await one(sql`SELECT recovery_hashes FROM mfa_accounts WHERE principal=${s.fixture.key}`)).recovery_hashes;
 {
  const s=await scene('recovery@mfa.test');
  const response=await regenerate(s),body=await response.json();
  assert.equal(response.status,200,'a fresh recovery renewal succeeds although log() throws');
  assert.deepEqual(Object.keys(body).sort(),['ok','recoveryCodes'],'the response shape is {ok,recoveryCodes}');
  assert.equal(body.ok,true);assert.equal(body.recoveryCodes.length,10,'ten recovery codes');
  assert.equal(await storedHashes(s),recoveryHashes(s,body.recoveryCodes),'the stored hashes match the returned codes in order');
  assert.equal(await one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${sha(s.browser.management)}`),null,'the proof is consumed');
  assert.equal(await audits('MFA-Wiederherstellungscodes erneuert',s.fixture),1,'exactly one audit row');
  const row=await one(sql`SELECT actor,target,server_id,scope FROM audit WHERE action=${'MFA-Wiederherstellungscodes erneuert'} AND actor=${s.fixture.actor.label}`);
  assert.deepEqual({...row},{actor:s.fixture.actor.label,target:s.fixture.actor.label,server_id:null,scope:'portal'},'the audit row names the principal, without server, in the portal scope');
  assert.equal(batches,1,'the renewal issues exactly one batch');assert.deepEqual(standaloneWrites,[],'the renewal issues no write outside its batch');
  await bystanderUnchanged('fresh recovery renewal');
  // Reuse of the consumed proof.
  const hashes=await storedHashes(s),again=await regenerate(s),againBody=await again.json();
  assert.equal(again.status,403);assert.equal(againBody.code,'MFA_STEP_UP_REQUIRED','a used proof requires a new step-up');
  assert.equal(againBody.recoveryCodes,undefined,'a reused proof returns no codes');
  assert.equal(await storedHashes(s),hashes,'reused renewal proof: the hashes are unchanged');
  assert.equal(await audits('MFA-Wiederherstellungscodes erneuert',s.fixture),1,'reused renewal proof: still exactly one audit row');
 }
 // Stale renewal keeps the old hashes and returns no codes.
 for(const [name,mutate] of Object.entries(mutations)){
  const s=await scene(`recovery-${name}@mfa.test`),hashes=await storedHashes(s),before=await allAudits();
  let body=null;
  await stale(s,matches('UPDATE mfa_accounts SET recovery_hashes'),mutate(s),async()=>{const response=await regenerate(s);body=await response.clone().json();return response;},`stale renewal ${name}`,{proof:sha(s.browser.management)});
  assert.equal(body.recoveryCodes,undefined,`stale renewal ${name}: no recovery codes are returned`);
  assert.equal(await storedHashes(s),hashes,`stale renewal ${name}: the hashes keep their previous value`);
  assert.equal(await allAudits(),before,`stale renewal ${name}: no audit row is added`);
 }
 // A failing audit insert rolls back the renewal; the same request then succeeds.
 {const s=await scene('audit-recovery@mfa.test');await auditFailure('audit failure renewal',s,()=>regenerate(s),'MFA-Wiederherstellungscodes erneuert');}
 // Static check: no post-commit log(), no standalone proof consumption.
 {
  const branch=(file,action)=>readFileSync(file,'utf8').split('\n').find(line=>line.includes(`p.action==='${action}'`));
  for(const [file,action] of [['app/api/mfa/route.ts','authenticator-confirm'],['app/api/mfa/route.ts','authenticator-delete'],['app/api/mfa/route.ts','disable'],['app/api/mfa/route.ts','regenerate-recovery'],['app/api/passkeys/route.ts','registration-verify']])assert.ok(!branch(file,action).includes('log('),`${action} does not call log()`);
  assert.ok(!readFileSync('lib/server/identity/passkeys.ts','utf8').includes('consumeMfaManagementProof'),'passkeys.ts does not consume the proof separately');
  assert.ok(!readFileSync('lib/server/identity/mfa.ts','utf8').includes('consumeMfaManagementProof'),'the unused standalone proof consumption is gone');
 }
 await bystanderUnchanged('end');
 console.log('PASS mfa session binding: authenticator begin/confirm/delete, MFA disable, recovery renewal and passkey registration commit in one batch fenced by the live primary and MFA session, with the audit row inside it; stale requests change nothing; a duplicate passkey ID returns 409 and discards the challenge.');
}finally{d.close();}
