// POST /api/session-settings with action 'set' (setSessionSettings in lib/server/identity/session-settings.ts): both session rules
// with one proof, the one Save of Settings › Sessions. Real lib/server/identity/session-settings.ts, its route, lib/server/identity/mfa.ts,
// lib/server/identity/rbac.ts, lib/server/audit.ts and lib/server/identity/access.ts on an isolated PostgreSQL test database: one batch with one proof
// consumed, audit rows only for changed values, the clamp only on a changed timeout, the MFA grant delete only when MFA
// turns on, no proof needed when nothing changed, invalid values, a concurrent change and a missing proof. Also the
// reading rule of the switch (no row or exact "0" off, anything else on), GET with mfaGrantHours and set-idle-mfa.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError,genericCode} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';
import {browserAfter,sessionHeaders} from '../support/session-cookies.mjs';
import {sql} from '../../runtime/database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const origin='https://idle.test',time=Date.now(),minute=60_000;
 const HttpError=realHttpError;
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 const text={ownerOnly:serverText('apiError.settings.ownerOnly'),invalid:serverText('apiError.settings.idleTimeoutInvalid'),unknown:serverText('apiError.request.unknownAction'),conflict:serverText('apiError.settings.conflict'),origin:serverText('apiError.request.invalidOrigin')};
 let beforeBatch=null,current=null;const batches=[];
 const facade=hookDatabase(d,{transaction:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}},record:batches});
 const server={
  db:()=>facade,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:'',now:()=>Date.now(),random:token,hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:request=>request.json(),
  sameOrigin:request=>{if(request.headers.get('origin')!==origin)throw new HttpError(403,text.origin);},
  requireViewer:async()=>{if(!current)throw new HttpError(401,'Bitte anmelden.','IDENTITY_LOGIN_REQUIRED');return current;},requireAuthIdentity:async()=>current,
  log:async()=>{throw new Error('log() must not be used by these actions');},
  failure:e=>Response.json({error:e instanceof HttpError?e.message:serverText('apiError.storageUnavailable'),...(e instanceof HttpError&&e.code&&!genericCode(e.code)?{code:e.code}:{})},{status:e instanceof HttpError?e.status:503}),
 };
 const webauthn={generateRegistrationOptions:async()=>({}),verifyRegistrationResponse:async()=>({verified:false}),generateAuthenticationOptions:async()=>({}),verifyAuthenticationResponse:async()=>({verified:false})};
 const load=sourceLoader(),imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'@simplewebauthn/server':webauthn};
 const settings=load('lib/server/identity/session-settings.ts',imports),mfa=load('lib/server/identity/mfa.ts',imports);
 const settingsApi=load('app/api/session-settings/route.ts',imports),mfaApi=load('app/api/mfa/route.ts',imports);
 check([settings.sessionSettingsOwnerOnlyMessage,settings.sessionIdleTimeoutInvalidMessage,settings.sessionSettingsUnknownActionMessage,settings.sessionSettingsConflictMessage],[text.ownerOnly,text.invalid,text.unknown,text.conflict],'server texts from UI copy');

 // ---- Fixture -------------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const one=statement=>d.one(statement);
 const count=async(sql,...bindings)=>Number((await one(sql,...bindings)).n);
 // A local account with password, MFA account, recovery codes and a pending primary session.
 async function account(label,permissions=['*']){
  const {actor,assignmentId}=await sourceActor(d,label,permissions);actor.userId=actor.id;
  const codes=Array.from({length:40},()=>crypto.randomBytes(16).toString('hex').toUpperCase());
  await d.exec(sql`UPDATE local_users SET password_hash='fixture-password',must_reset=0 WHERE id=${actor.id}`);
  await insert('mfa_accounts',{principal:actor.principal,secret_enc:'migrated:authenticator-managed',recovery_hashes:JSON.stringify(codes.map(code=>sha(actor.principal+'\0'+code))),last_counter:-1,created_at:time,authenticators_migrated:1});
  return {actor,assignmentId,codes};
 }
 async function pending(actor){const primary=token(),at=Date.now();await insert('local_auth_sessions',{token_hash:sha(primary),user_id:actor.id,auth_version:1,created_at:at,expires_at:at+86_400_000,pending_until:at+600_000,mfa_hash:null});return primary;}
 // The tokens travel only as cookies.
 const headers=browser=>sessionHeaders(browser);
 const request=(path,browser,payload,requestOrigin=origin)=>new Request(origin+path,{method:payload?'POST':'GET',headers:{'Content-Type':'application/json',Origin:requestOrigin,...(browser?headers(browser):{})},...(payload?{body:JSON.stringify(payload)}:{})});
 const answer=async response=>({status:response.status,body:await response.json()});
 // A real recovery-code login (verifyMfa through POST /api/mfa): a new MFA session and a fresh proof.
 async function login(fixture){
  current=fixture.actor;const primary=await pending(fixture.actor);
  const response=await mfaApi.POST(request('/api/mfa',{primary,session:''},{action:'verify',recoveryCode:fixture.codes.shift()})),result=await answer(response);
  assert.equal(result.status,200,'recovery login: '+result.body.error);
  const browser=browserAfter(response,{primary});
  return {primary:browser.primary,session:browser.session,management:result.body.managementToken,reply:result.body};
 }
 const settingsPost=async(fixture,browser,payload,requestOrigin)=>{current=fixture.actor;batches.length=0;return answer(await settingsApi.POST(request('/api/session-settings',browser,payload,requestOrigin)));};
 const live=async(fixture,browser)=>{try{await mfa.requireMfa(new Request(origin,{headers:headers(browser)}),fixture.actor);return true;}catch(error){if(error.status===401||error.status===403)return false;throw error;}};
 const mfaKey='session_idle_requires_mfa',timeoutKey='session_idle_timeout_minutes';
 const value=async key=>(await one(sql`SELECT value FROM identity_settings WHERE key=${key}`))?.value??null;
 const put=async(key,next)=>{await d.exec(sql`DELETE FROM identity_settings WHERE key=${key}`);if(next!==null)await insert('identity_settings',{key,value:next});};
 const audit=()=>d.query(sql`SELECT action,target FROM audit WHERE action IN ('Automatische Abmeldung geändert','MFA nach automatischer Abmeldung geändert') ORDER BY id`).then(rows=>rows.map(row=>({...row})));
 const proofs=browser=>count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${sha(browser.management)}`);
 // The grants of the other account (the logins of the Owner create their own grants while the switch is off).
 const grants=()=>count(sql`SELECT count(*) AS n FROM mfa_grants WHERE principal=${other.actor.principal}`);
 const addGrant=async fixture=>{const at=Date.now();await d.exec(sql`INSERT INTO mfa_grants(token_hash,principal,user_id,created_at,expires_at) VALUES(${sha(token())},${fixture.actor.principal},${fixture.actor.id},${at},${at+settings.MFA_GRANT_LIFETIME_MS})`);};
 const settingsView=(minutes,idleRequiresMfa)=>({idleTimeoutMinutes:minutes,options:[5,15,30,45],defaultMinutes:15,idleRequiresMfa,mfaGrantHours:8});
 const state=async()=>({timeout:await value(timeoutKey),mfa:await value(mfaKey),audit:await audit(),grants:await grants(),sessions:(await d.query(sql`SELECT token_hash,idle_expires_at FROM mfa_sessions ORDER BY token_hash`)).map(row=>({...row}))});
 const owner=await account('owner@set.test'),other=await account('other@set.test',['view']);
 check(load('lib/step-up.ts',imports).sessionSettingsStepUpActions.has('set'),true,'set needs a fresh proof (lib/step-up.ts)');
 const uaa=await account('uaa@set.test',['portal.users.manage','portal.userGroups.manage','portal.roles.manage','portal.roleAssignments.manage']);
 async function sessionAt(fixture,lastActivity){
  const primary=token(),session=token(),at=Date.now();
  await insert('mfa_sessions',{token_hash:sha(session),principal:fixture.actor.principal,created_at:lastActivity,last_activity:lastActivity,idle_expires_at:lastActivity+15*minute,expires_at:at+86_400_000});
  await insert('local_auth_sessions',{token_hash:sha(primary),user_id:fixture.actor.id,auth_version:1,created_at:at,expires_at:at+86_400_000,pending_until:at+600_000,mfa_hash:sha(session)});
  return {primary,session};
 }

 // The switch: a missing row and exact "0" read off; "1" and any other text read on. GET names mfaGrantHours.
 {
  check([settings.MFA_GRANT_LIFETIME_MS,settings.mfaGrantHours],[8*60*minute,8],'the grant lifetime is one constant of 8 hours');
  for(const [stored,expected] of [[null,false],[undefined,false],['0',false],['1',true],['x',true],['',true],[' 0',true],['00',true]])check(settings.idleRequiresMfaFrom(stored),expected,`stored ${JSON.stringify(stored)}`);
  for(const [stored,expected] of [[null,false],['0',false],['1',true],['x',true]]){await put(mfaKey,stored);check(await settings.sessionIdleRequiresMfa(),expected,`row ${JSON.stringify(stored)}`);}
  await put(mfaKey,null);
  const browser=await login(owner);current=owner.actor;
  check(await answer(await settingsApi.GET(request('/api/session-settings',browser))),{status:200,body:settingsView(15,false)},'GET: idleRequiresMfa off by default and mfaGrantHours 8');
 }

 // Nothing changed: the view, without a proof and without a batch.
 {
  const browser=await login(owner),before=await state();
  check(await settingsPost(owner,browser,{action:'set',idleTimeoutMinutes:15,idleRequiresMfa:false}),{status:200,body:settingsView(15,false)},'unchanged: the view without a proof');
  check([batches.length,await state(),await proofs(browser)],[0,before,1],'no batch, nothing written, the proof stays');
 }

 // Both values change: one batch, two audit rows, the clamp, no grant delete (MFA turns off), one proof consumed.
 {
  await put(mfaKey,'1');await addGrant(other);
  const idleBrowser=await sessionAt(other,Date.now()-10*minute),browser=await login(owner);
  const result=await settingsPost(owner,browser,{action:'set',idleTimeoutMinutes:5,idleRequiresMfa:false,managementToken:browser.management});
  check(result,{status:200,body:settingsView(5,false)},'both values');
  const committing=batches.filter(batch=>batch.some(text=>text.includes('INTO identity_settings')));
  check(committing.length,1,'one batch');
  check(committing[0].filter(text=>text.includes('INTO identity_settings')).length,2,'both upserts in it');
  check(committing[0].filter(text=>text.includes('DELETE FROM mfa_management_proofs')).length,1,'one proof consumption');
  check([await value(timeoutKey),await value(mfaKey),await proofs(browser)],['5','0',0],'stored, and the proof is used');
  check(await audit(),[{action:'Automatische Abmeldung geändert',target:'15 → 5 Minuten'},{action:'MFA nach automatischer Abmeldung geändert',target:'an → aus'}],'one audit row per changed value, with the targets of the single setters');
  check([await grants(),await live(other,idleBrowser)],[1,false],'switching off deletes no grant; the clamp ends the idle session at once');
 }

 // Only MFA turns on: one audit row, the grant delete, no clamp.
 {
  const browser=await login(owner),before=await state();
  const result=await settingsPost(owner,browser,{action:'set',idleTimeoutMinutes:5,idleRequiresMfa:true,managementToken:browser.management});
  check(result,{status:200,body:settingsView(5,true)},'MFA on');
  const committing=batches.find(batch=>batch.some(text=>text.includes('INTO identity_settings')));
  check([committing.some(text=>text.includes('UPDATE mfa_sessions')),committing.some(text=>text.includes('DELETE FROM mfa_grants'))],[false,true],'no clamp, the grant delete');
  check([await grants(),(await audit()).slice(before.audit.length),await value(timeoutKey),await value(mfaKey)],[0,[{action:'MFA nach automatischer Abmeldung geändert',target:'aus → an'}],'5','1'],'every MFA grant ends; only the MFA row');
 }

 // Only the timeout changes: one audit row, the clamp, no grant delete, no switch audit row.
 {
  await addGrant(other);const browser=await login(owner),before=await state();
  check(await settingsPost(owner,browser,{action:'set',idleTimeoutMinutes:30,idleRequiresMfa:true,managementToken:browser.management}),{status:200,body:settingsView(30,true)},'timeout only');
  const committing=batches.find(batch=>batch.some(text=>text.includes('INTO identity_settings')));
  check([committing.some(text=>text.includes('UPDATE mfa_sessions')),committing.some(text=>text.includes('DELETE FROM mfa_grants'))],[true,false],'the clamp, no grant delete');
  check([await grants(),(await audit()).slice(before.audit.length)],[1,[{action:'Automatische Abmeldung geändert',target:'5 → 30 Minuten'}]],'only the timeout row');
 }

 // Invalid values: 400 before the proof is read; the proof stays.
 {
  const browser=await login(owner),before=await state();
  for(const [minutes,required,error] of [[10,true,text.invalid],['15',true,text.invalid],[null,false,text.invalid],[15,'yes',serverText('apiError.settings.idleRequiresMfaInvalid')],[15,undefined,serverText('apiError.settings.idleRequiresMfaInvalid')]]){
   check(await settingsPost(owner,browser,{action:'set',idleTimeoutMinutes:minutes,idleRequiresMfa:required,managementToken:browser.management}),{status:400,body:{error}},`invalid ${JSON.stringify([minutes,required])}`);
  }
  check([await state(),await proofs(browser)],[before,1],'nothing changes, the proof stays');
  const uaaBrowser=await login(uaa);
  check(await settingsPost(uaa,uaaBrowser,{action:'set',idleTimeoutMinutes:5,idleRequiresMfa:false,managementToken:uaaBrowser.management}),{status:403,body:{error:text.ownerOnly}},'Owners only');
 }

 // A missing proof, a proof gone before the commit, and a concurrent change of either key.
 {
  const browser=await login(owner),before=await state();
  check(await settingsPost(owner,browser,{action:'set',idleTimeoutMinutes:15,idleRequiresMfa:false}),{status:403,body:{error:serverText('apiError.mfa.confirmChange'),code:'MFA_STEP_UP_REQUIRED'}},'no proof: the step-up');
  beforeBatch=()=>d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${sha(browser.management)}`);
  const expired=await settingsPost(owner,browser,{action:'set',idleTimeoutMinutes:15,idleRequiresMfa:false,managementToken:browser.management});
  check([expired.status,await state()],[403,before],'a proof gone before the commit: nothing is written');
  for(const [key,concurrent] of [[timeoutKey,'45'],[mfaKey,'0']]){
   const race=await login(owner),start=await state();beforeBatch=()=>put(key,concurrent);
   check(await settingsPost(owner,race,{action:'set',idleTimeoutMinutes:5,idleRequiresMfa:false,managementToken:race.management}),{status:409,body:{error:text.conflict}},`a concurrent change of ${key} gives 409`);
   const after=await state();
   check([after.audit,after.grants,after.sessions,await proofs(race),key===timeoutKey?after.timeout:after.mfa],[start.audit,start.grants,start.sessions,1,concurrent],`${key}: no audit row, no clamp, the proof stays, only the concurrent value`);
   await put(key,key===timeoutKey?'30':'1');
  }
 }

 // set-idle-mfa: the step-up, the audit row, the grant delete when it turns on (none when off) and the 409.
 {
  await put(mfaKey,null);await addGrant(other);
  const browser=await login(owner);
  const missing=await settingsPost(owner,browser,{action:'set-idle-mfa',required:true});
  check([missing.status,missing.body.code,await value(mfaKey)],[403,'MFA_STEP_UP_REQUIRED',null],'set-idle-mfa needs the step-up');
  const before=await audit();
  check(await settingsPost(owner,browser,{action:'set-idle-mfa',required:true,managementToken:browser.management}),{status:200,body:settingsView(30,true)},'set-idle-mfa on');
  const committing=batches.find(batch=>batch.some(text=>text.includes('INTO identity_settings')));
  check(committing.findIndex(text=>text.includes('DELETE FROM mfa_grants'))<committing.findIndex(text=>text.includes('INTO identity_settings')),true,'the grant delete runs in the batch, before the upsert');
  check([await grants(),await value(mfaKey),(await audit()).slice(before.length),await proofs(browser)],[0,'1',[{action:'MFA nach automatischer Abmeldung geändert',target:'aus → an'}],0],'every grant ends, the audit row, the proof is used');
  check(await count(sql`SELECT count(*) AS n FROM mfa_grants`),0,'no grant of any account is left, also the grants of the Owner logins');
  await addGrant(other);const off=await login(owner);
  check(await settingsPost(owner,off,{action:'set-idle-mfa',required:false,managementToken:off.management}),{status:200,body:settingsView(30,false)},'set-idle-mfa off');
  check([await grants(),await value(mfaKey),(await audit()).at(-1).target],[1,'0','an → aus'],'switching off deletes no grant');
  const race=await login(owner);beforeBatch=()=>put(mfaKey,'x');
  check(await settingsPost(owner,race,{action:'set-idle-mfa',required:true,managementToken:race.management}),{status:409,body:{error:text.conflict}},'a concurrent change gives 409');
  check([await value(mfaKey),await grants(),await proofs(race)],['x',1,1],'409: the concurrent value stays, no grant delete, the proof stays');
 }
 console.log(`PASS session settings set (${checks} assertions): one batch with one proof, audit rows per changed value, clamp and grant delete only when needed, the switch reading rule, set-idle-mfa, unchanged without a proof, invalid values, Owners only, missing proof and conflicts.`);
}finally{d.close();}
