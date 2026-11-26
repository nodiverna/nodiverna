// The configurable automatic logout, and the rule that a bound primary session
// counts only while its MFA session is live (primarySession, primaryGuard,
// bindLocalMfaStatements; a step-up keeps the rebound session). Real lib/server/identity/session-settings.ts, its
// route, lib/server/identity/mfa.ts, lib/server/identity/local-auth.ts, lib/server/identity/rbac.ts, lib/server/audit.ts,
// lib/server/identity/feature-authorization.ts and lib/server/identity/access.ts on an isolated PostgreSQL test database. The JS
// clock of the server stub can be moved; log() throws, so audit rows come from
// the committing batch.
import {serverText} from '../support/server-text.mjs';
// The body keeps the codes a client branches on; the generic codes per status are checked in tests/repo/error-codes.mjs.
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
 let beforeBatch=null,current=null,offset=0;const batches=[];
 const facade=hookDatabase(d,{transaction:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}},record:batches});
 const server={
  db:()=>facade,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:'',now:()=>Date.now()+offset,random:token,hash:async value=>sha(value),HttpError,
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
 const sessionRow=browser=>one(sql`SELECT created_at,last_activity,idle_expires_at,expires_at FROM mfa_sessions WHERE token_hash=${sha(browser.session)}`);
 const status=async(fixture,browser)=>{current=fixture.actor;return answer(await mfaApi.GET(request('/api/mfa',browser)));};
 const activity=async(fixture,browser)=>{current=fixture.actor;return answer(await mfaApi.POST(request('/api/mfa',browser,{action:'activity'})));};
 const settingsGet=async(fixture,browser)=>{current=fixture.actor;return answer(await settingsApi.GET(request('/api/session-settings',browser)));};
 const settingsPost=async(fixture,browser,payload,requestOrigin)=>{current=fixture.actor;batches.length=0;return answer(await settingsApi.POST(request('/api/session-settings',browser,payload,requestOrigin)));};
 const stored=async()=>(await one(sql`SELECT value FROM identity_settings WHERE key='session_idle_timeout_minutes'`))?.value??null;
 const store=async value=>{await d.exec(sql`DELETE FROM identity_settings WHERE key='session_idle_timeout_minutes'`);if(value!==null)await insert('identity_settings',{key:'session_idle_timeout_minutes',value});};
 const auditRows=()=>d.query(sql`SELECT actor,action,target,scope,server_id,customer_id FROM audit WHERE action='Automatische Abmeldung geändert' ORDER BY id`).then(results=>({results})).then(result=>result.results.map(row=>({...row})));
 const live=async(fixture,browser)=>{try{await mfa.requireMfa(new Request(origin,{headers:headers(browser)}),fixture.actor);return true;}catch(error){if(error.status===401||error.status===403)return false;throw error;}};
 const view=minutes=>({idleTimeoutMinutes:minutes,options:[5,15,30,45],defaultMinutes:15,idleRequiresMfa:false,mfaGrantHours:8});
 // GET and POST answer the same view; the portal certificate moved to the console answer (page Add device).
 const getView=minutes=>view(minutes);

 // ---- Defaults and the configured value ------------------------------------
 const owner=await account('owner@idle.test');
 {
  const browser=await login(owner),row=await sessionRow(browser);
  check(row.idle_expires_at-row.created_at,15*minute,'no row: a code login idles after 15 minutes');
  check(row.expires_at-row.created_at,86_400_000,'the 24-hour absolute limit stays');
  check(browser.reply.idleTimeoutMs,900_000,'verify reports idleTimeoutMs');
  check((await status(owner,browser)).body.idleTimeoutMs,900_000,'GET /api/mfa reports idleTimeoutMs');
  for(const value of ['7','abc','45 ',' 5','','0','60','15.0','05'])check(settings.idleTimeoutMinutesFrom(value),15,`stored "${value}" means 15`);
  for(const value of [null,undefined,5,45])check(settings.idleTimeoutMinutesFrom(value),15,`non-text ${String(value)} means 15`);
  for(const value of ['5','15','30','45'])check(settings.idleTimeoutMinutesFrom(value),Number(value),`stored "${value}"`);
  for(const value of ['7','abc','45 ']){await store(value);check(await settings.sessionIdleTimeoutMs(),900_000,`a stored "${value}" row gives 15 minutes`);}
  await store('30');const thirty=await login(owner),thirtyRow=await sessionRow(thirty);
  check([thirtyRow.idle_expires_at-thirtyRow.created_at,thirty.reply.idleTimeoutMs],[30*minute,1_800_000],'a stored 30 applies to the next login');
  await store(null);
 }

 // ---- Only activity extends a session; expiry is final -------------------------------
 {
  await store('5');const browser=await login(owner),created=await sessionRow(browser);
  check(created.idle_expires_at-created.created_at,5*minute,'with 5 configured a login idles after 5 minutes');
  // Status reads, requireMfa (every requireViewer) and GETs leave the row byte-identical.
  for(let n=0;n<3;n++){await status(owner,browser);await mfa.mfaStatus(new Request(origin,{headers:headers(browser)}),owner.actor);await live(owner,browser);await settingsGet(owner,browser);}
  check(await sessionRow(browser),created,'reads never move last_activity or idle_expires_at');
  offset=minute;const before=Date.now()+offset,moved=await activity(owner,browser),after=Date.now()+offset,row=await sessionRow(browser);
  check(moved.status,200,'activity succeeds');check(moved.body.idleTimeoutMs,300_000,'activity reports the configured timeout');
  check(row.idle_expires_at>=before+5*minute&&row.idle_expires_at<=after+5*minute,true,'activity moves the deadline to now + 5 minutes');
  check(row.last_activity>=before&&row.last_activity<=after,true,'activity records the input time');
  offset=row.idle_expires_at-Date.now()+1000;
  check(await live(owner,browser),false,'past the deadline requireMfa rejects the session');
  const late=await activity(owner,browser);check([late.status,late.body.code],[401,'SESSION_EXPIRED'],'activity cannot revive an expired session');
  check(await sessionRow(browser),row,'the expired row is unchanged');
  offset=0;await store(null);
 }

 // ---- A bound primary session counts only while its MFA session is live -----------------
 {
  const localAuth=load('lib/server/identity/local-auth.ts',imports);
  const probe=browser=>new Request(origin,{headers:headers(browser)});
  const holds=guard=>one(sql`SELECT 1 AS holds WHERE ${guard}`).then(row=>!!row);
  const ends={
   idle:browser=>d.exec(sql`UPDATE mfa_sessions SET idle_expires_at=${Date.now()-1000} WHERE token_hash=${sha(browser.session)}`),
   absolute:browser=>d.exec(sql`UPDATE mfa_sessions SET expires_at=${Date.now()-1000} WHERE token_hash=${sha(browser.session)}`),
   deleted:browser=>d.exec(sql`DELETE FROM mfa_sessions WHERE token_hash=${sha(browser.session)}`),
  };
  for(const [cause,end] of Object.entries(ends)){
   const browser=await login(owner);
   check(!!await localAuth.localIdentity(probe(browser)),true,`${cause}: the bound primary session is live first`);
   // The guards are read while live and checked after the end, as a commit after the read would.
   const guard=await localAuth.primaryGuard(probe(browser),owner.actor),authentication=await localAuth.primaryAuthenticationGuard(probe(browser),owner.actor),binding=await localAuth.bindLocalMfaStatements(probe(browser),owner.actor,sha(token()));
   await end(browser);
   check(await localAuth.localIdentity(probe(browser)),null,`${cause}: primarySession no longer accepts the bound primary session`);
   check([await holds(guard),await holds(authentication)],[false,false],`${cause}: primaryGuard and primaryAuthenticationGuard refuse at commit time`);
   check((await d.exec(binding.bind)).rowCount,0,`${cause}: bindLocalMfaStatements copies nothing`);
   current=owner.actor;const verify=await answer(await mfaApi.POST(request('/api/mfa',browser,{action:'verify',recoveryCode:owner.codes.shift()})));
   check([verify.status,verify.body.code],[401,'IDENTITY_LOGIN_REQUIRED'],`${cause}: verify with the old cookies creates no MFA session`);
  }
  // A pending primary session stays valid as before.
  const primary=await pending(owner.actor);
  check(!!await localAuth.localIdentity(probe({primary})),true,'a pending primary session stays valid');
  // A step-up rotates the MFA session and rebinds the primary session in one batch: the rebound session stays live.
  const browser=await login(owner);current=owner.actor;
  const response=await mfaApi.POST(request('/api/mfa',browser,{action:'verify',recoveryCode:owner.codes.shift()})),stepUp=await answer(response);
  const next=browserAfter(response,browser);
  check([stepUp.status,next.primary!==browser.primary,next.session!==browser.session],[200,true,true],'a step-up rotates both cookies');
  check([!!await localAuth.localIdentity(probe(next)),await live(owner,next)],[true,true],'the rebound primary session and its new MFA session are live');
  check([await localAuth.localIdentity(probe(browser)),await count(sql`SELECT count(*) AS n FROM mfa_sessions WHERE token_hash=${sha(browser.session)}`)],[null,0],'the old pair is gone');
 }

 // ---- The Owner changes the setting --------------------------------------
 const uaa=await account('uaa@idle.test',['portal.users.manage','portal.userGroups.manage','portal.roles.manage','portal.roleAssignments.manage']);
 // Sessions of other accounts: one idle for 10 minutes, one active 2 minutes ago (both live under 15).
 const idle=await account('idle@idle.test',['view']),recent=await account('recent@idle.test',['view']);
 async function sessionAt(fixture,lastActivity){
  const primary=token(),session=token(),at=Date.now();
  await insert('mfa_sessions',{token_hash:sha(session),principal:fixture.actor.principal,created_at:lastActivity,last_activity:lastActivity,idle_expires_at:lastActivity+15*minute,expires_at:at+86_400_000});
  await insert('local_auth_sessions',{token_hash:sha(primary),user_id:fixture.actor.id,auth_version:1,created_at:at,expires_at:at+86_400_000,pending_until:at+600_000,mfa_hash:sha(session)});
  return {primary,session};
 }
 {
  const ownerBrowser=await login(owner),get=await settingsGet(owner,ownerBrowser);
  check(get,{status:200,body:getView(15)},'GET: Owner sees the default');
  for(const [who,browser] of [[uaa,await login(uaa)]]){
   check(await settingsGet(who,browser),{status:403,body:{error:text.ownerOnly}},'GET: a User Access Administrator gets 403');
  }
  const idleBrowser=await sessionAt(idle,Date.now()-10*minute),recentBrowser=await sessionAt(recent,Date.now()-2*minute);
  check([await live(idle,idleBrowser),await live(recent,recentBrowser)],[true,true],'both sessions are live under 15 minutes');
  const before=Date.now(),lowered=await settingsPost(owner,ownerBrowser,{action:'set-idle-timeout',minutes:5,managementToken:ownerBrowser.management});
  check(lowered,{status:200,body:view(5)},'POST 5: the reply is the new view');
  check(await stored(),'5','the value is stored as text');
  check(await auditRows(),[{actor:owner.actor.label,action:'Automatische Abmeldung geändert',target:'15 → 5 Minuten',scope:'portal',server_id:null,customer_id:null}],'one audit row, 15 when no row existed');
  check(await count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${sha(ownerBrowser.management)}`),0,'the proof is consumed');
  const committing=batches.filter(batch=>batch.some(sql=>/INTO identity_settings/.test(sql)));
  check(committing.length,1,'one batch writes the value');
  check(['INSERT INTO audit','UPDATE mfa_sessions SET idle_expires_at','INTO identity_settings','DELETE FROM mfa_management_proofs'].map(part=>committing[0].some(sql=>sql.includes(part))),[true,true,true,true],'value, audit row, clamp and proof consumption share the batch');
  const idleRow=await sessionRow(idleBrowser),recentRow=await sessionRow(recentBrowser);
  check(idleRow.idle_expires_at,idleRow.last_activity+5*minute,'the idle account is clamped to its last input + 5 minutes');
  check(idleRow.idle_expires_at<before,true,'which lies in the past');
  check(await live(idle,idleBrowser),false,'the idle account is rejected on its next request');
  check(recentRow.idle_expires_at,recentRow.last_activity+5*minute,'the recent account keeps 5 minutes from its last input');
  check(await live(recent,recentBrowser),true,'and stays signed in');
  check(await live(owner,ownerBrowser),true,'the saving Owner keeps working');
  check((await settingsGet(owner,ownerBrowser)).body,getView(5),'GET shows the new value');
  // Raising never lengthens a deadline.
  const deadlines=async()=>(await d.query(sql`SELECT token_hash,idle_expires_at FROM mfa_sessions ORDER BY token_hash`)).map(row=>({...row}));
  const raise=await login(owner),deadlinesBefore=(await deadlines()).filter(row=>row.token_hash!==sha(raise.session));
  check((await settingsPost(owner,raise,{action:'set-idle-timeout',minutes:45,managementToken:raise.management})).body,view(45),'POST 45');
  check((await deadlines()).filter(row=>row.token_hash!==sha(raise.session)),deadlinesBefore,'raising to 45 lengthens no idle_expires_at');
  check((await auditRows()).at(-1).target,'5 → 45 Minuten','audit names old and new value');
  // The same value is a no-op: no audit row, no batch, the proof stays.
  const same=await login(owner),auditCount=(await auditRows()).length;
  check(await settingsPost(owner,same,{action:'set-idle-timeout',minutes:45,managementToken:same.management}),{status:200,body:view(45)},'the same value returns the view');
  check([(await auditRows()).length,batches.length,await count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${sha(same.management)}`)],[auditCount,0,1],'no audit row, no batch, proof unused');
 }

 // ---- Errors change nothing ----------------------------------------------------------------
 {
  const state=async()=>({value:await stored(),audit:await auditRows(),sessions:(await d.query(sql`SELECT token_hash,idle_expires_at FROM mfa_sessions ORDER BY token_hash`)).map(row=>({...row}))});
  const unchanged=async(label,run,keepProof)=>{const before=await state();await run();check(await state(),before,label+': nothing changes');if(keepProof)check(await count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${sha(keepProof)}`),1,label+': the proof stays');};
  const browser=await login(owner);
  for(const minutes of [10,0,60,'15',null,undefined,15.5,'abc'])await unchanged('minutes '+JSON.stringify(minutes),async()=>{check(await settingsPost(owner,browser,{action:'set-idle-timeout',...(minutes===undefined?{}:{minutes}),managementToken:browser.management}),{status:400,body:{error:text.invalid}},'invalid minutes '+JSON.stringify(minutes));},browser.management);
  await unchanged('unknown action',async()=>{check(await settingsPost(owner,browser,{action:'set-everything',minutes:5,managementToken:browser.management}),{status:400,body:{error:text.unknown}},'unknown action');},browser.management);
  const uaaBrowser=await login(uaa);
  await unchanged('non-Owner',async()=>{
   check(await settingsPost(uaa,uaaBrowser,{action:'set-idle-timeout',minutes:5,managementToken:uaaBrowser.management}),{status:403,body:{error:text.ownerOnly}},'a User Access Administrator gets 403 on POST');
   check(await settingsPost(uaa,uaaBrowser,{action:'set-idle-timeout',minutes:10,managementToken:uaaBrowser.management}),{status:400,body:{error:text.invalid}},'validity is checked first');
  },uaaBrowser.management);
  await unchanged('missing proof',async()=>{check(await settingsPost(owner,browser,{action:'set-idle-timeout',minutes:30}),{status:403,body:{error:serverText('apiError.mfa.confirmChange'),code:'MFA_STEP_UP_REQUIRED'}},'missing proof');});
  const used=await login(owner);await d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${sha(used.management)}`);
  await unchanged('used proof',async()=>{const result=await settingsPost(owner,used,{action:'set-idle-timeout',minutes:30,managementToken:used.management});check([result.status,result.body.code],[403,'MFA_STEP_UP_REQUIRED'],'used proof');});
  await unchanged('foreign origin',async()=>{check(await settingsPost(owner,browser,{action:'set-idle-timeout',minutes:30,managementToken:browser.management},'https://evil.test'),{status:403,body:{error:text.origin}},'wrong Origin');},browser.management);
  // Compare-and-set: a value changed by someone else between read and commit.
  {
   const race=await login(owner);beforeBatch=()=>store('30');
   const before=await state(),result=await settingsPost(owner,race,{action:'set-idle-timeout',minutes:5,managementToken:race.management});
   check(result,{status:409,body:{error:text.conflict}},'a concurrent change gives 409');
   check(await state(),{...before,value:'30'},'only the concurrent value is there: no audit row, no clamp');
   check(await count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${sha(race.management)}`),1,'409: the proof stays');
   // A missing row is its own value: a row written meanwhile is a conflict too.
   await store(null);const fresh=await login(owner);beforeBatch=()=>store('15');
   check(await settingsPost(owner,fresh,{action:'set-idle-timeout',minutes:5,managementToken:fresh.management}),{status:409,body:{error:text.conflict}},'a row written into a missing one gives 409');
   check(await stored(),'15','the concurrent row stays');
  }
  // The Owner right lost between read and commit.
  {
   const race=await login(owner),before=await state();beforeBatch=()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${owner.assignmentId}`);
   check(await settingsPost(owner,race,{action:'set-idle-timeout',minutes:30,managementToken:race.management}),{status:403,body:{error:text.ownerOnly}},'Owner right lost: 403');
   check(await state(),before,'Owner right lost: nothing changes');
  }
 }
 console.log(`PASS session idle timeout (${checks} assertions): default 15 minutes, only exact 5/15/30/45, activity as the only extension, a bound primary session only with its live MFA session (idle, absolute, deleted) and a step-up that keeps the rebound session, Owner-only setting with step-up, compare-and-set, audit row and immediate clamp in one batch.`);
}finally{d.close();}
