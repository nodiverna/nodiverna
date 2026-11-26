// Recovery renewal and MFA/passkey logins commit their change, proof consumption
// and audit row in one batch. Real route and lib sources run against a
// migrated PostgreSQL test database; a trigger makes the audit insert fail on demand.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,sourceActor,inTransaction,createTrigger,dropTrigger} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {browserAfter,sessionHeaders} from '../support/session-cookies.mjs';
import {sql} from '../../runtime/database.mjs';

const d=await sourceDatabase();
try{
 const origin='https://audit.test';
 // Remembered browsers (scenes 5 and 10) need MFA after an automatic logout off.
 await d.exec(sql`INSERT INTO identity_settings(key,value) VALUES('session_idle_requires_mfa','0')`);
 const HttpError=realHttpError;
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 // A one-shot hook runs right before the first batch whose statements match.
 let beforeBatch=null,batches=0;
 // A hook lands right before the transaction whose statements it matches.
 const database=hookDatabase(d,{transaction:async()=>{batches++;},batch:async texts=>{const hook=beforeBatch;if(hook&&hook.match(texts.map(text=>({sql:text})))){beforeBatch=null;await hook.run();}}});
 let current=null;
 const server={
  db:()=>database,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:'',now:()=>Date.now(),random:token,hash:async value=>sha(value),HttpError,
  body:request=>request.json(),sameOrigin:()=>{},requireAuthIdentity:async()=>current,
  log:async()=>{throw new Error('log() must not be used by atomic security actions');},
  failure:e=>Response.json({error:e.message,...(e instanceof HttpError&&e.code?{code:e.code}:{})},{status:e instanceof HttpError?e.status:503}),
 };
 const webauthn={
  generateRegistrationOptions:async()=>({}),verifyRegistrationResponse:async()=>({verified:false}),generateAuthenticationOptions:async()=>({}),
  verifyAuthenticationResponse:async({credential})=>({verified:true,authenticationInfo:{newCounter:credential.counter+1,credentialBackedUp:false}}),
 };
 const load=sourceLoader(),dependencies={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'@simplewebauthn/server':webauthn};
 const mfa=load('lib/server/identity/mfa.ts',dependencies),commit=load('lib/server/security-commit.ts',dependencies);
 const mfaApi=load('app/api/mfa/route.ts',dependencies),passkeyApi=load('app/api/passkeys/route.ts',dependencies);

 const one=async statement=>d.one(statement);
 const count=async statement=>(await one(statement)).n;
 const audits=async(action,fixture)=>count(sql`SELECT count(*) AS n FROM audit WHERE action=${action} AND actor=${fixture.actor.label}`);
 const failAudit=()=>createTrigger(d,'audit_unavailable','audit','BEFORE INSERT',{message:'audit unavailable'});
 const restoreAudit=()=>dropTrigger(d,'audit_unavailable');
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
 const base32=bytes=>{let bits=0,value=0,out='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+=alphabet[(value<<(5-bits))&31];return out;};
 const counterNow=()=>Math.floor(Date.now()/30000);
 const sessionCookie=response=>response.headers.getSetCookie().find(c=>/^__Host-serverdesk-mfa=[a-f0-9]{64};/.test(c));

 async function pending(user){
  const primary=token(),at=Date.now();
  await d.exec(sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) SELECT ${sha(primary)},id,auth_version,${at},${at+86_400_000},${at+600_000},NULL FROM local_users WHERE id=${user.id}`);
  return primary;
 }
 // A local user with password, MFA account, one authenticator, ten recovery
 // codes and a pending (password-only) primary session.
 async function account(label,{enrolled=true}={}){
  const {actor}=await sourceActor(d,label,['*']);actor.userId=actor.id;
  const key=actor.principal,at=Date.now(),secret=base32(crypto.randomBytes(20)),authenticatorId=token();
  const codes=Array.from({length:10},()=>crypto.randomBytes(16).toString('hex').toUpperCase());
  await d.exec(sql`UPDATE local_users SET password_hash='fixture-password',must_reset=0 WHERE id=${actor.id}`);
  if(enrolled)await inTransaction(d,[
   sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at,authenticators_migrated) VALUES(${key},'migrated:authenticator-managed',${JSON.stringify(codes.map(c=>sha(key+'\0'+c)))},-1,${at},1)`,
   sql`INSERT INTO mfa_authenticators(id,principal,name,secret_enc,last_counter,created_at,last_used_at) VALUES(${authenticatorId},${key},'Authenticator',${await mfa.encryptSecret(secret,key)},-1,${at},NULL)`,
  ]);
  return {actor,key,secret,authenticatorId,codes,primary:await pending(actor)};
 }
 // A fully signed-in browser: bound primary session, MFA session and a fresh
 // management proof, as left behind by a step-up confirmation.
 async function signedIn(fixture,{proofExpires=Date.now()+300_000}={}){
  const at=Date.now(),primary=token(),session=token(),management=token();
  await inTransaction(d,[
   sql`INSERT INTO mfa_sessions(token_hash,principal,created_at,last_activity,idle_expires_at,expires_at) VALUES(${sha(session)},${fixture.key},${at},${at},${at+3_600_000},${at+86_400_000})`,
   sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) SELECT ${sha(primary)},id,auth_version,${at},${at+86_400_000},${at+600_000},${sha(session)} FROM local_users WHERE id=${fixture.actor.id}`,
   sql`INSERT INTO mfa_management_proofs(token_hash,principal,session_hash,expires_at) VALUES(${sha(management)},${fixture.key},${sha(session)},${proofExpires})`,
  ]);
  return {primary,session,management};
 }
 const post=(api,path,payload,headers)=>{const data={...payload};current=data.viewer;delete data.viewer;return api.POST(new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)}));};
 const regenerate=(fixture,browser,managementToken=browser.management)=>post(mfaApi,'/api/mfa',{viewer:fixture.actor,action:'regenerate-recovery',managementToken},sessionHeaders(browser));
 const verify=(fixture,proof,primary=fixture.primary)=>post(mfaApi,'/api/mfa',{viewer:fixture.actor,action:'verify',...proof},sessionHeaders({primary}));
 const hashes=async fixture=>(await one(sql`SELECT recovery_hashes FROM mfa_accounts WHERE principal=${fixture.key}`))?.recovery_hashes;
 const sessions=fixture=>count(sql`SELECT count(*) AS n FROM mfa_sessions WHERE principal=${fixture.key}`);
 async function snapshot(fixture){
  const rows=async statement=>JSON.stringify(await d.query(statement));
  return {
   sessions:await rows(sql`SELECT * FROM mfa_sessions WHERE principal=${fixture.key} ORDER BY token_hash`),
   proofs:await rows(sql`SELECT * FROM mfa_management_proofs WHERE principal=${fixture.key} ORDER BY token_hash`),
   grants:await rows(sql`SELECT * FROM mfa_grants WHERE principal=${fixture.key} ORDER BY token_hash`),
   primary:await rows(sql`SELECT * FROM local_auth_sessions WHERE user_id=${fixture.actor.id} ORDER BY token_hash`),
   account:await rows(sql`SELECT * FROM mfa_accounts WHERE principal=${fixture.key}`),
   authenticators:await rows(sql`SELECT * FROM mfa_authenticators WHERE principal=${fixture.key} ORDER BY id`),
   audit:await count(sql`SELECT count(*) AS n FROM audit`),
  };
 }

 // 1. Recovery renewal success.
 {
  const fixture=await account('renew@audit.test'),browser=await signedIn(fixture),before=await hashes(fixture);
  const response=await regenerate(fixture,browser),body=await response.json();
  assert.equal(response.status,200,'renewal succeeds although log() throws');
  assert.equal(body.recoveryCodes.length,10,'renewal returns ten recovery codes');
  const stored=JSON.parse(await hashes(fixture));
  assert.notEqual(await hashes(fixture),before,'renewal replaces the stored hashes');
  assert.equal(stored.length,10,'exactly ten new hashes are stored');
  assert.deepEqual(stored,body.recoveryCodes.map(code=>sha(fixture.key+'\0'+code.replace(/-/g,''))),'stored hashes belong to the returned codes');
  assert.equal(await one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${sha(browser.management)}`),null,'renewal consumes the management proof');
  assert.equal(await audits('MFA-Wiederherstellungscodes erneuert',fixture),1,'renewal writes exactly one audit row');
  const row=await one(sql`SELECT actor,target,server_id,scope FROM audit WHERE action='MFA-Wiederherstellungscodes erneuert' AND actor=${fixture.actor.label}`);
  assert.deepEqual(row,{actor:'renew@audit.test',target:'renew@audit.test',server_id:null,scope:'portal'},'audit row keeps actor, target and portal scope');
  const tables=(await d.query(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname='public'`)).map(r=>r.name);
  for(const table of tables){
   const dump=JSON.stringify((await d.query(sql`SELECT * FROM ${sql.ident(table)}`)));
   for(const code of body.recoveryCodes)assert.ok(!dump.includes(code)&&!dump.includes(code.replace(/-/g,'')),`no plaintext recovery code is stored in ${table}`);
  }
  // 3a. A consumed proof is rejected and writes nothing.
  const renewed=await hashes(fixture),reused=await regenerate(fixture,browser);
  assert.equal(reused.status,403);assert.equal((await reused.json()).code,'MFA_STEP_UP_REQUIRED','a used proof requires a new step-up');
  assert.equal(await hashes(fixture),renewed,'a used proof writes no hashes');
  assert.equal(await audits('MFA-Wiederherstellungscodes erneuert',fixture),1,'a used proof writes no audit row');
 }
 // 3b. An expired proof is rejected and writes nothing.
 {
  const fixture=await account('expired@audit.test'),browser=await signedIn(fixture,{proofExpires:Date.now()-1000}),before=await hashes(fixture),auditCount=await count(sql`SELECT count(*) AS n FROM audit`);
  const response=await regenerate(fixture,browser);
  assert.equal(response.status,403);assert.equal((await response.json()).code,'MFA_STEP_UP_REQUIRED','an expired proof requires a new step-up');
  assert.equal(await hashes(fixture),before,'an expired proof writes no hashes');
  assert.equal(await count(sql`SELECT count(*) AS n FROM audit`),auditCount,'an expired proof writes no audit row');
 }
 // 2. Recovery renewal with a failing audit insert.
 {
  const fixture=await account('renew-fail@audit.test'),browser=await signedIn(fixture),before=await hashes(fixture),auditCount=await count(sql`SELECT count(*) AS n FROM audit`);
  await failAudit();
  const response=await regenerate(fixture,browser),body=await response.json();
  await restoreAudit();
  assert.ok(response.status>=400,'renewal fails when the audit row cannot be written');
  assert.equal(body.recoveryCodes,undefined,'a failed renewal returns no codes');
  assert.equal(await hashes(fixture),before,'a failed renewal keeps the hashes byte-identical');
  assert.ok(await one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${sha(browser.management)}`),'a failed renewal keeps the management proof');
  assert.equal(await count(sql`SELECT count(*) AS n FROM audit`),auditCount,'a failed renewal adds no audit row');
  // An old recovery code still logs in, from a second password session.
  const login=await verify(fixture,{recoveryCode:fixture.codes[0]},await pending(fixture.actor));
  assert.equal(login.status,200,'an old recovery code still logs in after a failed renewal');
  const retry=await regenerate(fixture,browser);
  assert.equal(retry.status,200,'a retry with the same management token succeeds');
  assert.equal((await retry.json()).recoveryCodes.length,10);
  assert.equal(await audits('MFA-Wiederherstellungscodes erneuert',fixture),1,'only the successful retry is audited');
 }
 // 4. Recovery-code login success and single use.
 {
  const fixture=await account('recovery@audit.test'),code=fixture.codes[3];
  const response=await verify(fixture,{recoveryCode:code.match(/.{4}/g).join('-')}),body=await response.json();
  assert.equal(response.status,200,'recovery login succeeds although log() throws');
  assert.ok(sessionCookie(response),'recovery login sets the MFA session cookie');
  assert.ok(response.headers.getSetCookie().some(c=>/^__Host-serverdesk-auth=[a-f0-9]{64};/.test(c)),'recovery login sets the bound primary identity cookie');
  assert.ok(!JSON.parse(await hashes(fixture)).includes(sha(fixture.key+'\0'+code)),'the used recovery hash is removed');
  assert.equal(JSON.parse(await hashes(fixture)).length,9);
  assert.equal(await one(sql`SELECT token_hash FROM local_auth_sessions WHERE token_hash=${sha(fixture.primary)}`),null,'the pending primary session is retired');
  const issued=browserAfter(response),bound=await one(sql`SELECT mfa_hash FROM local_auth_sessions WHERE token_hash=${sha(issued.primary)}`);
  assert.equal(bound.mfa_hash,sha(issued.session),'the new primary session is bound to the new MFA session');
  assert.ok(await one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${sha(body.managementToken)} AND session_hash=${sha(issued.session)}`),'the management proof is committed');
  assert.equal(await audits('MFA angemeldet',fixture),1,'recovery login writes exactly one audit row');
  assert.deepEqual(await one(sql`SELECT actor,target,server_id,scope FROM audit WHERE action='MFA angemeldet' AND actor=${fixture.actor.label}`),{actor:'recovery@audit.test',target:'recovery@audit.test',server_id:null,scope:'portal'});
  const replay=await verify(fixture,{recoveryCode:code},issued.primary);
  assert.ok([401,409].includes(replay.status),'a recovery code yields at most one login');
  assert.equal(await sessions(fixture),1,'the replay creates no second session');
  assert.equal(await audits('MFA angemeldet',fixture),1,'the replay writes no audit row');
 }
 // 5. Recovery-code login with a failing audit insert.
 {
  const fixture=await account('recovery-fail@audit.test'),code=fixture.codes[5],before=await snapshot(fixture);
  await failAudit();
  const response=await verify(fixture,{recoveryCode:code});
  await restoreAudit();
  assert.ok(response.status>=400,'recovery login fails when the audit row cannot be written');
  assert.equal(sessionCookie(response),undefined,'a failed login sets no MFA session cookie');
  assert.deepEqual(await snapshot(fixture),before,'a failed login leaves sessions, proofs, MFA grants, primary sessions, hashes and audit unchanged');
  assert.ok(await one(sql`SELECT token_hash FROM local_auth_sessions WHERE token_hash=${sha(fixture.primary)} AND mfa_hash IS NULL`),'the pending primary session stays unbound');
  const retry=await verify(fixture,{recoveryCode:code});
  assert.equal(retry.status,200,'the same recovery code logs in once the audit works again');
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_grants WHERE principal=${fixture.key}`),1,'the MFA grant commits with the login');
 }
 // 6. TOTP login with a failing audit insert, then single use.
 {
  const fixture=await account('totp@audit.test'),code=await mfa.totp(fixture.secret,counterNow()),before=await snapshot(fixture);
  await failAudit();
  const response=await verify(fixture,{code});
  await restoreAudit();
  assert.ok(response.status>=400,'TOTP login fails when the audit row cannot be written');
  assert.equal(sessionCookie(response),undefined);
  assert.deepEqual(await snapshot(fixture),before,'a failed TOTP login keeps last_counter, sessions and audit unchanged');
  const success=await verify(fixture,{code});
  assert.equal(success.status,200,'the same TOTP code logs in once the audit works again');
  assert.ok(sessionCookie(success));
  const authenticator=await one(sql`SELECT last_counter,last_used_at FROM mfa_authenticators WHERE id=${fixture.authenticatorId}`);
  assert.ok(authenticator.last_counter>=counterNow()-1&&authenticator.last_used_at,'the TOTP counter is consumed in the login batch');
  assert.equal(await audits('MFA angemeldet',fixture),1,'the successful TOTP login writes exactly one audit row');
  const replay=await verify(fixture,{code},browserAfter(success).primary);
  assert.equal(replay.status,401,'a TOTP code yields at most one login within its window');
  assert.equal(await sessions(fixture),1);assert.equal(await audits('MFA angemeldet',fixture),1);
 }
 // 7. Primary binding fails right before the login batch.
 {
  const isLogin=statements=>statements.some(s=>s.sql.startsWith('INSERT INTO mfa_sessions'));
  const suspended=await account('suspended@audit.test'),code=suspended.codes[0],before=await snapshot(suspended);
  beforeBatch={match:isLogin,run:()=>d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${suspended.actor.id}`)};
  const response=await verify(suspended,{recoveryCode:code});
  assert.equal(beforeBatch,null,'the suspension ran right before the login batch');
  assert.equal(response.status,401);assert.ok(['IDENTITY_LOGIN_REQUIRED','SESSION_EXPIRED'].includes((await response.json()).code),'a suspended user gets the existing login codes');
  const after=await snapshot(suspended);
  assert.equal(after.sessions,'[]','no MFA session exists for the suspended user');
  assert.equal(after.account,before.account,'the recovery code is not consumed');
  assert.equal(after.primary,before.primary,'no bound primary session is added');
  assert.equal(after.audit,before.audit,'no audit row is written');
  const revoked=await account('revoked@audit.test'),totpCode=await mfa.totp(revoked.secret,counterNow()),revokedBefore=await snapshot(revoked);
  beforeBatch={match:isLogin,run:()=>d.exec(sql`DELETE FROM local_auth_sessions WHERE token_hash=${sha(revoked.primary)}`)};
  const deleted=await verify(revoked,{code:totpCode});
  assert.equal(deleted.status,401);assert.ok(['IDENTITY_LOGIN_REQUIRED','SESSION_EXPIRED'].includes((await deleted.json()).code),'a deleted primary session gets the existing login codes');
  const revokedAfter=await snapshot(revoked);
  assert.equal(revokedAfter.sessions,'[]');assert.equal(revokedAfter.authenticators,revokedBefore.authenticators,'the TOTP counter is not consumed');
  assert.equal(revokedAfter.primary,'[]','no bound primary session is added');assert.equal(revokedAfter.audit,revokedBefore.audit);
 }
 // 8. First enrollment with a failing audit insert.
 {
  const fixture=await account('enroll@audit.test',{enrolled:false});
  const headers=sessionHeaders({primary:fixture.primary});
  const begin=await post(mfaApi,'/api/mfa',{viewer:fixture.actor,action:'begin'},headers),{secret}=await begin.json();
  assert.equal(begin.status,200);
  const challenge=await one(sql`SELECT * FROM mfa_challenges WHERE principal=${fixture.key}`);
  await failAudit();
  const response=await post(mfaApi,'/api/mfa',{viewer:fixture.actor,action:'confirm',code:await mfa.totp(secret,counterNow())},headers);
  await restoreAudit();
  assert.ok(response.status>=400,'enrollment fails when the audit row cannot be written');
  assert.equal(await one(sql`SELECT principal FROM mfa_accounts WHERE principal=${fixture.key}`),null,'no MFA account remains');
  assert.equal(await one(sql`SELECT id FROM mfa_authenticators WHERE principal=${fixture.key}`),null,'no authenticator remains');
  assert.deepEqual(await one(sql`SELECT * FROM mfa_challenges WHERE principal=${fixture.key}`),challenge,'the enrollment challenge is kept');
  assert.equal(await sessions(fixture),0);
  const success=await post(mfaApi,'/api/mfa',{viewer:fixture.actor,action:'confirm',code:await mfa.totp(secret,counterNow()+1)},headers),body=await success.json();
  assert.equal(success.status,200,'enrollment succeeds with a fresh code once the audit works again');
  assert.equal(body.recoveryCodes.length,10);assert.ok(sessionCookie(success));
  assert.equal(await one(sql`SELECT principal FROM mfa_challenges WHERE principal=${fixture.key}`),null,'the challenge is consumed by the successful enrollment');
  assert.equal(await audits('MFA eingerichtet',fixture),1,'enrollment writes exactly one audit row');
 }
 // 9. Passkey login with a failing audit insert.
 {
  const fixture=await account('passkey@audit.test'),credential='cred_'+crypto.randomBytes(8).toString('hex'),challengeId=token(),browser=token(),at=Date.now();
  await inTransaction(d,[
   sql`INSERT INTO passkey_credentials(id,principal,public_key,counter,transports,name,device,device_type,backed_up,created_at,last_used_at) VALUES(${credential},${fixture.key},'AAAA',5,'[]','Laptop','local','singleDevice',0,${at},NULL)`,
   sql`INSERT INTO passkey_challenges(id,principal,purpose,challenge,browser_hash,session_hash,rp_id,origin,name,device,expires_at) VALUES(${challengeId},${fixture.key},'authentication','challenge',${sha(browser)},NULL,'audit.test',${origin},'','any',${at+300_000})`,
  ]);
  const clientDataJSON=Buffer.from('{}').toString('base64url');
  const authenticate=()=>post(passkeyApi,'/api/passkeys',{viewer:fixture.actor,action:'authentication-verify',challengeId,response:{id:credential,rawId:credential,type:'public-key',response:{clientDataJSON}}},sessionHeaders({primary:fixture.primary,passkey:browser}));
  const credentialRow=()=>one(sql`SELECT counter,last_used_at FROM passkey_credentials WHERE id=${credential}`);
  const before=await snapshot(fixture);
  await failAudit();
  const response=await authenticate();
  await restoreAudit();
  assert.ok(response.status>=400,'passkey login fails when the audit row cannot be written');
  assert.equal(sessionCookie(response),undefined);
  assert.deepEqual(await credentialRow(),{counter:5,last_used_at:null},'the passkey counter and last use stay unchanged');
  assert.ok(await one(sql`SELECT id FROM passkey_challenges WHERE id=${challengeId}`),'the passkey challenge stays open');
  assert.deepEqual(await snapshot(fixture),before,'a failed passkey login creates no session and no audit row');
  const success=await authenticate();
  assert.equal(success.status,200,'passkey login succeeds although log() throws');assert.ok(sessionCookie(success));
  const used=await credentialRow();
  assert.equal(used.counter,6,'the passkey counter is updated');assert.ok(used.last_used_at);
  assert.equal(await one(sql`SELECT id FROM passkey_challenges WHERE id=${challengeId}`),null,'the passkey challenge is consumed');
  assert.equal(await audits('Mit Passkey angemeldet',fixture),1,'passkey login writes exactly one audit row');
 }
 // 10. The removed resume answers like every unknown action and creates nothing.
 {
  const fixture=await account('resume@audit.test'),before=await snapshot(fixture);
  const response=await post(mfaApi,'/api/mfa',{viewer:fixture.actor,action:'resume'},sessionHeaders({primary:fixture.primary}));
  assert.equal(response.status,400,'resume is an unknown action');assert.equal(sessionCookie(response),undefined);
  assert.deepEqual(await snapshot(fixture),before,'resume changes nothing');
 }
 // 11. commitWithAudit: one batch, rollback on audit failure, false guard.
 {
  const audit={actor:'unit@audit.test',action:'Unit',target:'unit'},mark=key=>sql`INSERT INTO identity_settings(key,value) VALUES(${key},${'1'})`;
  const marked=key=>one(sql`SELECT key FROM identity_settings WHERE key=${key}`);
  await failAudit();
  batches=0;
  await assert.rejects(commit.commitWithAudit([mark('unit-rollback')],{audit,guard:sql`TRUE`}),/audit unavailable/,'the audit failure propagates');
  await restoreAudit();
  assert.equal(batches,1,'commitWithAudit issues exactly one batch');
  assert.equal(await marked('unit-rollback'),null,'a preceding mutation is rolled back with the audit insert');
  const skipped=await commit.commitWithAudit([mark('unit-false')],{audit,guard:sql`FALSE`});
  assert.equal(skipped.audited,false,'a false guard writes no audit row');assert.equal(skipped.results.length,1,'results keep the caller indexes');
  assert.ok(await marked('unit-false'),'the mutation is kept when the guard is false');
  const placed=await commit.commitWithAudit([mark('unit-a'),mark('unit-b')],{audit,guard:sql`EXISTS (SELECT 1 FROM identity_settings WHERE key=${'unit-a'})`,at:1});
  assert.equal(placed.audited,true);assert.equal(placed.results.length,2);assert.equal(placed.results[1].rowCount,1);
  assert.deepEqual(await one(sql`SELECT server_id,scope FROM audit WHERE action='Unit'`),{server_id:null,scope:'portal'},'audit rows are portal scoped');
 }
 console.log('PASS security audit atomicity: recovery renewal, MFA enrollment, TOTP/recovery and passkey logins commit change, proof consumption and audit row together; a failed audit leaves every proof reusable.');
}finally{d.close();}
