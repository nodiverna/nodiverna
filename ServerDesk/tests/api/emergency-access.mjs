// Emergency sign-ins while Microsoft sign-in only is on (docs/entra-id.md):
// password plus TOTP, recovery code or passkey writes exactly one security
// alarm, one emergency notification event and one audit row with the client
// address, in the batch of the session; a refused or lost sign-in, a step-up,
// a refused re-verify after the idle end and a sign-in while the switch is off write none. Then the
// console data of the alarm (Owners only) and its acknowledgement. Real
// lib/server/identity/mfa.ts, lib/server/identity/passkeys.ts, lib/server/identity/local-auth.ts, lib/server/identity/security-alarms.ts and
// their routes on an isolated PostgreSQL database (tests/support/entra-fixture.mjs).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {entraFixture} from '../support/entra-fixture.mjs';
import {browserAfter} from '../support/session-cookies.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {HttpError} from '../support/http-error.mjs';
import {insertRow,sourceLoader} from '../support/source-database.mjs';
import {fixtureTotp} from '../support/mfa-fixture.mjs';
import {sql} from '../../runtime/database.mjs';

const passwords={verifyPassword:async(password,record)=>typeof password==='string'&&password===record,dummyPasswordRecord:async()=>'\0never-matches',hashPassword:async value=>value,validatePassword:value=>value};
// A passkey that always verifies: the ceremony itself is tested in tests/passkey-*.mjs.
const webauthn={generateRegistrationOptions:async()=>({}),verifyRegistrationResponse:async()=>({verified:false}),generateAuthenticationOptions:async()=>({challenge:crypto.randomBytes(16).toString('base64url')}),
 verifyAuthenticationResponse:async({credential})=>({verified:true,authenticationInfo:{newCounter:credential.counter+1,credentialBackedUp:false}})};
const f=await entraFixture({imports:{'./passwords':passwords,'@simplewebauthn/server':webauthn}}),{d,m,microsoft}=f;
const hooks=hookDatabase(d).hooks;
const alarmApi=f.load('app/api/security-alarms/route.ts'),passkeyApi=m.passkeyApi;
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const address='2001:db8:1:2:3:4:5:6',addressKey='2001:db8:1:2::/64';
const totpSecret='JBSWY3DPEHPK3PXP',credentialId='emergency-passkey-1';

try{
 await f.configure();
 // The emergency access: a built-in Owner with password, authenticator app, recovery codes and a passkey.
 const emergency=await f.localAccount('emergency@local.test');
 const id=emergency.actor.id,principal=emergency.actor.principal;
 await d.exec(sql`UPDATE local_users SET username='emergency',display_name='Erin Emergency',password_hash='emergency-password' WHERE id=${id}`);
 await d.exec(sql`UPDATE role_assignments SET role_id='builtin-owner' WHERE id=${emergency.assignmentId}`);
 await insertRow(d,'mfa_authenticators',{id:sha('authenticator'),principal,name:'Phone',secret_enc:await m.mfa.encryptSecret(totpSecret,principal),last_counter:-1,created_at:Date.now(),last_used_at:null});
 await insertRow(d,'passkey_credentials',{id:credentialId,principal,public_key:'AAAA',counter:0,transports:'[]',name:'Key',device:'any',device_type:'singleDevice',backed_up:0,created_at:Date.now(),last_used_at:null});
 await d.exec(sql`UPDATE entra_settings SET emergency_user_id=${id},entra_only=1,entra_only_at=${Date.now()},entra_only_by='fixture'`);
 let counter=Math.floor(Date.now()/30000)-1;

 const headers={'X-ServerDesk-Client-IP':address};
 const login=async()=>{const r=await f.answer(await m.authApi.POST(f.request('/api/auth',{payload:{action:'login',username:'emergency',password:'emergency-password'},headers})));assert.equal(r.status,200,'password login: '+r.body.error);return browserAfter(r.response,{});};
 const verify=async(browser,payload,extra={})=>{f.setViewer(await f.viewerOf(browser));const r=await f.answer(await m.mfaApi.POST(f.request('/api/mfa',{browser,payload:{action:'verify',...payload},headers:{...headers,...extra}})));return {...r,browser:r.status===200?browserAfter(r.response,browser):browser};};
 const passkey=async browser=>{
  f.setViewer(await f.viewerOf(browser));
  const options=await f.answer(await passkeyApi.POST(f.request('/api/passkeys',{browser,payload:{action:'authentication-options'},headers})));
  assert.equal(options.status,200,'passkey options: '+options.body.error);
  const withChallenge=browserAfter(options.response,browser);
  const response={id:credentialId,rawId:credentialId,type:'public-key',response:{clientDataJSON:Buffer.from(JSON.stringify({type:'webauthn.get',origin:'https://entra.test'})).toString('base64url'),authenticatorData:'AA',signature:'AA'}};
  const r=await f.answer(await passkeyApi.POST(f.request('/api/passkeys',{browser:withChallenge,payload:{action:'authentication-verify',challengeId:options.body.challengeId,response},headers})));
  return {...r,browser:r.status===200?browserAfter(r.response,withChallenge):withChallenge};
 };
 const counts=async()=>({alarms:await f.count(sql`SELECT count(*) AS n FROM security_alarms`),events:await f.count(sql`SELECT count(*) AS n FROM notification_events WHERE kind='emergency'`),audit:await f.count(sql`SELECT count(*) AS n FROM audit WHERE action='auth.emergency.login'`)});
 const latest=async()=>{
  const alarm=await d.one(sql`SELECT * FROM security_alarms ORDER BY occurred_at DESC,id DESC LIMIT 1`);
  const event=await d.one(sql`SELECT kind,level,status,alert_id,server_id,security_alarm_id FROM notification_events WHERE security_alarm_id=${alarm.id}`);
  const audit=await d.one(sql`SELECT actor,target FROM audit WHERE action='auth.emergency.login' AND target LIKE ${'%alarm='+alarm.id}`);
  return {alarm,event,audit};
 };
 const expectOne=async(before,label)=>{
  const after=await counts();
  check([after.alarms-before.alarms,after.events-before.events,after.audit-before.audit],[1,1,1],`${label}: one alarm, one event, one audit row`);
  const {alarm,event,audit}=await latest();
  check([alarm.kind,alarm.user_id,alarm.actor,alarm.display_name,alarm.address,alarm.acknowledged_at,alarm.acknowledged_by],['emergencySignIn',id,emergency.actor.label,'Erin Emergency',addressKey,null,null],`${label}: the alarm`);
  check(event,{kind:'emergency',level:'critical',status:'pending',alert_id:null,server_id:null,security_alarm_id:alarm.id},`${label}: the pending critical event`);
  check(audit,{actor:emergency.actor.label,target:`user=${id} address=${addressKey} alarm=${alarm.id}`},`${label}: the audit row with the address`);
 };
 const expectNone=async(before,label)=>check(await counts(),before,`${label}: no alarm, event or audit row`);

 // ---- The three ways in ------------------------------------------------------------------
 let signedIn;
 {
  let before=await counts();
  const totp=await verify(await login(),{code:fixtureTotp(totpSecret,counter++)});
  check(totp.status,200,'password + TOTP: '+totp.body.error);
  await expectOne(before,'password + TOTP');
  signedIn=totp.browser;
  before=await counts();
  const recovery=await verify(await login(),{recoveryCode:emergency.codes.shift()});
  check(recovery.status,200,'password + recovery code');
  await expectOne(before,'password + recovery code');
  before=await counts();
  const key=await passkey(await login());
  check(key.status,200,'password + passkey: '+key.body.error);
  await expectOne(before,'password + passkey');
 }

 // ---- No alarm ------------------------------------------------------------------------------
 {
  let before=await counts();
  const wrong=await verify(await login(),{code:'000000'});
  check(wrong.status>=400,true,'a wrong code is refused');
  await expectNone(before,'a refused second factor');
  // The pending session ends right before the batch: no session, so none of the three.
  const pending=await login();
  hooks.batch=async texts=>{if(texts.some(text=>text.includes('INSERT INTO security_alarms'))){hooks.batch=null;await d.exec(sql`DELETE FROM local_auth_sessions WHERE token_hash=${sha(pending.primary)}`);}};
  const lost=await verify(pending,{recoveryCode:emergency.codes.shift()});
  hooks.batch=null;
  check(lost.status>=400,true,'a sign-in whose session ended is refused');
  await expectNone(before,'a sign-in that does not commit');
  // A step-up on the bound session.
  before=await counts();
  const stepUp=await verify(signedIn,{recoveryCode:emergency.codes.shift()});
  check(stepUp.status,200,'a step-up of the bound session');
  await expectNone(before,'a step-up');
  // After the idle end the bound primary session ends with its MFA session: a re-verify with the old cookies is refused.
  await d.exec(sql`UPDATE mfa_sessions SET idle_expires_at=1 WHERE principal=${principal}`);
  const idle=await verify(stepUp.browser,{code:fixtureTotp(totpSecret,counter++)});
  check([idle.status,idle.body.code],[401,'IDENTITY_LOGIN_REQUIRED'],'a re-verify after the idle end needs a new sign-in');
  await expectNone(before,'a refused re-verify after the idle end');
  // The same sign-in while Microsoft sign-in only is off.
  await d.exec(sql`UPDATE entra_settings SET entra_only=0`);
  const off=await verify(await login(),{recoveryCode:emergency.codes.shift()});
  check(off.status,200,'a sign-in while the switch is off');
  await expectNone(before,'a sign-in while the switch is off');
  signedIn=off.browser;
  await d.exec(sql`UPDATE entra_settings SET entra_only=1`);
 }

 // ---- Console data: Owners only ---------------------------------------------------------------
 const owner=await (async()=>{
  f.resetMicrosoft();microsoft.claims={oid:'dddddddd-0000-4000-8000-000000000001'};
  const entra=await f.signIn();const viewer=await f.viewerOf(entra.browser);
  await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(gen_random_uuid()::text,'user',${viewer.userId},'builtin-owner','global','*',0,'fixture')`);
  return {browser:entra.browser};
 })();
 const reader=await f.localAccount('reader@local.test',['view']);
 const readerBrowser=await f.localLogin(reader);
 {
  // The console route with stubs for the parts this test does not need (as in tests/api/alerts.mjs).
  let consoleViewer=null;
  const server={...f.server,requireViewer:async()=>consoleViewer,log:async()=>{},failure:error=>Response.json({error:String(error?.message??error),messageKey:error?.messageKey},{status:error instanceof HttpError?error.status:500})};
  const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'../agent/agent-protocol':{maintenanceBusy:async()=>false},'@/lib/server/agent/agent-protocol':{maintenanceBusy:async()=>false},
   '@/lib/management':{operations:{},safeTarget:()=>''},'@/lib/server/agent/agent-crypto':{sealAgentSecrets:async()=>({})},'@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
   '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>({publicKey:'fixture-job-key'}),JOB_SIGNING_KEY_MISSING:'missing'},
   '@/lib/diagnostics':{diagnosticDefinitions:{},diagnosticSecurityAccess:()=>false,isDiagnosticKind:()=>false},'@/lib/file-operations':{fileSecurityAccess:()=>false},
   '@/lib/server/devices/device-lifecycle':{removeDevice:async()=>({}),removeDevices:async()=>({}),sweepRemovedTransfers:async()=>{}},'@/lib/server/devices/rdp':{sweepRdp:async()=>{}}};
  const consoleApi=sourceLoader()('app/api/console/route.ts',imports);
  const consoleData=async browser=>{consoleViewer=await f.viewerOf(browser);const response=await consoleApi.GET(f.request('/api/console'));assert.equal(response.status,200,'console data');return response.json();};
  const ownerData=await consoleData(owner.browser);
  const open=await f.count(sql`SELECT count(*) AS n FROM security_alarms WHERE acknowledged_at IS NULL`);
  const newest=await d.one(sql`SELECT id,occurred_at FROM security_alarms ORDER BY occurred_at DESC,id DESC LIMIT 1`);
  check(ownerData.emergencyAlarms,{open,latest:{id:newest.id,at:Number(newest.occurred_at),displayName:'Erin Emergency',address:addressKey,own:false}},'an Owner gets the open alarms and the newest one');
  check((await consoleData(signedIn)).emergencyAlarms.latest.own,true,'the emergency access sees that the newest alarm is its own');
  check('emergencyAlarms' in await consoleData(readerBrowser),false,'a viewer without the Owner role gets no field');
 }

 // ---- Acknowledge ---------------------------------------------------------------------------------
 {
  const acknowledge=async(browser,alarmId)=>{f.setViewer(await f.viewerOf(browser));return f.answer(await alarmApi.POST(f.request('/api/security-alarms',{browser,payload:{action:'acknowledge',id:alarmId}})));};
  const alarm=await d.one(sql`SELECT id FROM security_alarms WHERE acknowledged_at IS NULL ORDER BY occurred_at,id LIMIT 1`);
  const own=await acknowledge(signedIn,alarm.id);
  check([own.status,own.body.messageKey],[403,'apiError.alarm.ownEmergency'],'the emergency access cannot acknowledge its own sign-in');
  const readerTry=await acknowledge(readerBrowser,alarm.id);
  check(readerTry.status,403,'a viewer without the Owner role: 403');
  const open=await f.count(sql`SELECT count(*) AS n FROM security_alarms WHERE acknowledged_at IS NULL`);
  const done=await acknowledge(owner.browser,alarm.id);
  check([done.status,done.body.alarms.open],[200,open-1],'another Owner acknowledges it');
  const row=await d.one(sql`SELECT acknowledged_at,acknowledged_by FROM security_alarms WHERE id=${alarm.id}`);
  const ownerViewer=await f.viewerOf(owner.browser);
  check([typeof Number(row.acknowledged_at),row.acknowledged_by],['number',ownerViewer.label],'acknowledged with time and Owner');
  check((await f.auditRows('auth.emergency.acknowledge')).map(entry=>[entry.actor,entry.target]),[[ownerViewer.label,`alarm=${alarm.id}`]],'one audit row auth.emergency.acknowledge');
  const twice=await acknowledge(owner.browser,alarm.id);
  check([twice.status,twice.body.messageKey],[409,'apiError.alarm.changed'],'twice: changed');
  check((await f.auditRows('auth.emergency.acknowledge')).length,1,'twice writes no row');
 }
 console.log(`PASS emergency access (${checks} checks): one alarm, event and audit row per emergency sign-in by TOTP, recovery code and passkey, none for a refused or lost sign-in, a step-up, a refused re-verify after the idle end or while off; console data for Owners only; acknowledge rules.`);
}finally{await d.close();}
