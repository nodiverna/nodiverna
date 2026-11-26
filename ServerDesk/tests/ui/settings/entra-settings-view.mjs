// Sign-in with Microsoft Entra ID in the UI, rendered with React SSR: Settings →
// Microsoft Entra ID (skeleton, load error with retry, not set up, the blocked
// switch, the saved secret, the certificate facts, the application ID URI of the
// portal API, the test result, the account
// check card in each state with its kept last Owner warning, the empty and filled group mappings), the Microsoft button and the #entra=<code> texts of
// the sign-in card, the gate after an Entra session ended, the step-up dialog of
// an Entra viewer, the Confirm with Microsoft controller, the account page, the account list, the capability, the tab,
// the palette entry and the help topic. No server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {buttons,blockedReasons} from '../../support/blocked-buttons.mjs';
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
const panel=await import('../../../ui/settings/entra-settings-panel.tsx');
const {default:EntraSettingsPanel,EntraCheckCard,checkTones,checkTileTone,permissionsText,enableBlockedReason,lastTestLabel,appFormErrors,appFormDirty,appFormOf,mappingFormErrors,entraStatus,mappingScopeLabel}=panel;
const {EntraSignInChoice,entraErrorKey,entraErrorDetail}=await import('../../../ui/session/identity-entry.tsx');
const amr=await import('../../../lib/entra/amr.ts');
const {apiErrorCodes}=await import('../../../lib/errors/api-error-keys.ts');
const {EntraProfileCard}=await import('../../../ui/account/account-panel.tsx');
const {EntraConfirmContent}=await import('../../../ui/session/mfa-step-up.tsx');
const {runEntraConfirm,entraConfirmWindow}=await import('../../../ui/session/entra-confirm.ts');
const {relativeTime,exactTime}=await import('../../../ui/kit/kit.tsx');
const {canOpenAccessSection}=await import('../../../ui/base/access-capabilities.ts');
const {topicFor}=await import('../../../ui/shell/help-panel.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
const t=(key,params)=>translate('en',key,params);
const owner={id:'owner',label:'owner',userId:'owner',permissions:['*']},member={id:'member',label:'member',userId:'member',permissions:['portal.users.manage']};
const now=Date.parse('2026-11-09T12:00:00Z'),tenant='11111111-2222-4333-8444-555555555555',client='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const base={tenantId:'',clientId:'',credentialKind:'secret',secretSaved:false,privateKeySaved:false,certificate:null,enabled:false,configured:false,redirectUri:'https://portal.example/api/auth/entra/callback',applicationIdUri:null,apiScope:'access_as_user',revision:0,lastTest:null,mappings:[],accounts:0,lastSignInAt:null,roles:[{id:'builtin-operator',name:'Operator',portal:false},{id:'builtin-user-access-administrator',name:'User Access Administrator',portal:true}],deviceGroups:[{id:'0f0f0f0f-0000-4000-8000-000000000001',name:'Production'}],
 directoryCheck:{state:'off',result:null,lastRunAt:null,lastOkAt:null,nextRunAt:null,checked:0,locked:0,groupChanges:0,remaining:0,keptOwners:[]},graphPermissions:['User.Read.All','GroupMember.Read.All'],
 entraOnly:{enabled:false,since:null,by:null,lockedAccounts:0},emergency:{account:null,candidates:[],lastSignInAt:null,openAlarms:0},switchChecks:{signIn:false,emergency:false,viewerEntraOwner:false,mailChannel:false}};
const configured={...base,tenantId:tenant,clientId:client,applicationIdUri:`api://${client}`,secretSaved:true,configured:true,revision:3,lastTest:{at:now-120_000,result:'ok',current:true},accounts:12,lastSignInAt:now-3_600_000,
 mappings:[{id:'m1',groupObjectId:'0b0b0b0b-0000-4000-8000-000000000001',groupName:'Ops',roleId:'builtin-operator',roleName:'Operator',scopeType:'global',scopeId:'*',scopeName:null},{id:'m2',groupObjectId:'0b0b0b0b-0000-4000-8000-000000000002',groupName:'',roleId:'builtin-operator',roleName:'Operator',scopeType:'devicegroup',scopeId:'0f0f0f0f-0000-4000-8000-000000000001',scopeName:'Production'}]};
const panelHtml=(props)=>render(h(EntraSettingsPanel,{viewer:owner,demo:false,now,...props}));

// ---- Loading, load error, not set up -------------------------------------------------------
{
 const loading=panelHtml({});
 ok(/role="status"/.test(loading)&&loading.includes(`aria-label="${t('nav.settings.entra')}"`),'first load: Skeleton facts with a label');
 const failed=text(panelHtml({initialLoadFailed:true}));
 ok(failed.includes(t('entra.loadError'))&&failed.includes(t('common.retry')),'load failure: danger Notice with Try again');
 const html=panelHtml({initialView:base}),plain=text(html);
 check(entraStatus(base),'notSetUp','status: not set up');
 ok(plain.includes(t('entra.status.notSetUp'))&&plain.includes(t('entra.status.title'))&&plain.includes(t('entra.status.description')),'status card: pill Not set up, title and description');
 ok(/role="switch"[^>]*aria-disabled="true"/.test(html)||/aria-disabled="true"[^>]*role="switch"/.test(html),'switch blocked');
 ok(plain.includes(t('entra.enableBlockedTest')),'switch reason: Test the connection first.');
 const reasons=blockedReasons(html);
 ok(reasons.includes(t('entra.testBlocked'))&&reasons.includes(t('common.noChanges')),'Test connection blocked until saved; Save blocked with No changes');
 ok(plain.includes(base.redirectUri)&&html.includes(`aria-label="${t('entra.copyRedirectUri')}"`),'redirect URI with its copy button');
 ok(plain.includes(t('entra.mappings.emptyTitle'))&&plain.includes(t('entra.mappings.emptyText'))&&plain.includes(t('entra.mappings.add')),'empty mappings: Empty with title, sentence and Add mapping');
 ok(plain.includes(t('entra.facts.never')),'facts: never signed in, never tested');
 ok(!plain.includes(t('entra.secretSaved')),'no saved-secret hint without a secret');
 ok(plain.includes(t('entra.applicationIdUri'))&&plain.includes(t('entra.applicationIdUriPending'))&&!html.includes(`aria-label="${t('entra.copyApplicationIdUri')}"`),'without a saved client ID: the pending hint and no copy button');
 ok(plain.includes(t('entra.apiScope'))&&/<code class="mono">access_as_user<\/code>/.test(html)&&plain.includes(t('entra.applicationIdUriHint')),'the scope access_as_user and the setup hint');
}

// ---- Configured: status on, saved secret, test result, mappings ----------------------------------
{
 const on={...configured,enabled:true},html=panelHtml({initialView:on}),plain=text(html);
 ok(plain.includes(t('entra.status.on'))&&/role="switch" checked=""|checked=""[^>]*role="switch"/.test(html),'status On with the switch on');
 ok(/sdx-entra-count">12</.test(html)&&plain.includes(t('entra.testResult.passed',{time:relativeTime(now-120_000,now,'en')}))&&plain.includes(relativeTime(now-3_600_000,now,'en')),'facts: accounts, last sign-in and the passed test with its time');
 ok(html.includes('placeholder="••••••••••••"')&&plain.includes(t('entra.secretSaved')),'saved secret: placeholder and hint, never the value');
 ok(html.includes(`value="${tenant}"`)&&html.includes(`value="${client}"`),'tenant and client ID in the fields');
 {
  const redirect=html.indexOf(t('entra.redirectUri')),uri=html.indexOf(t('entra.applicationIdUri')),scope=html.indexOf(`>${t('entra.apiScope')}<`),hint=html.indexOf(t('entra.applicationIdUriHint').slice(0,30));
  ok(redirect>0&&redirect<uri&&uri<scope&&scope<hint,'below the redirect URI: application ID URI, scope, hint');
  ok(html.includes(`<code class="mono">api://${client}</code>`)&&html.includes(`aria-label="${t('entra.copyApplicationIdUri')}"`)&&!plain.includes(t('entra.applicationIdUriPending')),'the application ID URI in code.mono with its copy button');
  const field=html.slice(uri-200,scope);
  ok(/class="sdx-field"/.test(field)&&field.includes('sdx-copy-value')&&field.includes('lucide-copy'),'the same .sdx-field pattern with the kit CopyValue as the redirect URI');
 }
 ok(/sdx-notice-success/.test(html)&&plain.includes(t('entra.test.ok')),'the passed test as a success Notice');
 ok(plain.includes('Ops')&&plain.includes('0b0b0b0b-0000-4000-8000-000000000001')&&plain.includes(t('entra.mappings.unnamed')),'mapping rows: name and object ID, unnamed group');
 ok(plain.includes(t('tree.allDevices'))&&plain.includes(t('rbac.scope.group',{value:'Production'})),'scopes: All devices and the device group');
 ok(html.includes(`aria-label="${t('entra.mappings.actions',{group:'Ops'})}"`),'row menu per mapping');
 check(blockedReasons(html).filter(reason=>![t('common.noChanges'),t('entra.only.blocked')].includes(reason)),[],'nothing else blocked for an Owner (the switch waits for its checks)');
 const failedTest=text(panelHtml({initialView:{...configured,lastTest:{at:now-60_000,result:'secretExpired',current:true}}}));
 ok(failedTest.includes(t('entra.test.secretExpired')),'a failed test shows the fix text of its code');
 for(const result of ['apiNotExposed','apiTokenVersion']){
  const apiHtml=panelHtml({initialView:{...configured,lastTest:{at:now-60_000,result,current:true}}});
  ok(/sdx-notice-danger/.test(apiHtml)&&text(apiHtml).includes(t(`entra.test.${result}`))&&text(apiHtml).includes(t('entra.enableBlockedTest')),`${result}: a danger Notice with its fix text; the switch stays blocked`);
 }
 check(t('entra.test.ok'),'Connection works. Tenant, app and credential were accepted.','entra.test.ok is unchanged');
 const outdated=render(h(EntraSettingsPanel,{viewer:owner,demo:false,now,initialView:{...configured,lastTest:{at:now-60_000,result:'ok',current:false}}}));
 ok(/sdx-notice-warning/.test(outdated)&&text(outdated).includes(t('entra.test.outdated')),'an outdated test: warning Notice');
 ok(text(outdated).includes(t('entra.enableBlockedTest')),'outdated test: the switch stays blocked');
 const certificate=text(panelHtml({initialView:{...configured,credentialKind:'certificate',secretSaved:false,privateKeySaved:true,certificate:{thumbprint:'AB12CD',expiresAt:Date.parse('2027-01-01T00:00:00Z')}}}));
 ok(certificate.includes('AB12CD')&&certificate.includes(t('entra.thumbprint'))&&certificate.includes(t('entra.validUntil'))&&certificate.includes(t('entra.privateKeySaved')),'certificate: thumbprint and validity as facts, key saved');
 // sample devices block nothing here; the page shows and changes the real settings.
 const demo=render(h(EntraSettingsPanel,{viewer:owner,demo:true,now,initialView:on}));
 ok(!blockedReasons(demo).includes(t('kit.unavailable.demo'))&&!text(demo).includes(t('kit.unavailable.demo')),'demo: no change is blocked with the demo reason');
 ok(demo.includes(tenant),'demo: the real settings stay visible');
 const demoSwitch=/<input[^>]*role="switch"[^>]*>/.exec(render(h(EntraSettingsPanel,{viewer:owner,demo:true,now,initialView:configured})))?.[0]??'';
 ok(demoSwitch&&!/aria-disabled/.test(demoSwitch),'demo: the switch is not blocked');
 const demoButtons=buttons(render(h(EntraSettingsPanel,{viewer:owner,demo:true,now,initialView:{...configured,switchChecks:{signIn:true,emergency:true,viewerEntraOwner:true,mailChannel:true}}})));
 for(const label of [t('entra.mappings.add'),t('entra.only.switch')])ok(demoButtons.some(button=>text(button.inner).includes(label)&&!button.blocked),`demo: ${label} is not blocked`);
 ok(!readFileSync('ui/settings/entra-settings-panel.tsx','utf8').includes('kit.unavailable.demo'),'no demo reason in the page');
}

// ---- Pure rules of the panel --------------------------------------------------------------------
{
 const tr=(key,params)=>t(key,params);
 check(enableBlockedReason(base,tr),t('entra.enableBlockedTest'),'blocked: not tested');
 check(enableBlockedReason(configured,tr),null,'free after a passing test of the current revision');
 check(enableBlockedReason({...configured,lastTest:{...configured.lastTest,result:'credentialRefused'}},tr),t('entra.enableBlockedTest'),'blocked after a failed test');
 for(const result of ['apiNotExposed','apiTokenVersion'])check(enableBlockedReason({...configured,lastTest:{...configured.lastTest,result}},tr),t('entra.enableBlockedTest'),`blocked after ${result}`);
 check(enableBlockedReason({...configured,enabled:true,lastTest:null},tr),null,'turning off is never blocked');
 check(lastTestLabel({...configured,lastTest:{at:now,result:'ok',current:false}},now,tr,'en'),t('entra.testResult.outdated'),'outdated label');
 check(Object.keys(appFormErrors({tenantId:'contoso',clientId:client,credentialKind:'secret',secret:'',certificatePem:'',privateKeyPem:''})),['tenantId'],'client check: tenant GUID');
 check(Object.keys(appFormErrors({tenantId:tenant,clientId:client,credentialKind:'secret',secret:'tab\tx',certificatePem:'',privateKeyPem:''})),['secret'],'client check: printable secret');
 check([appFormDirty(appFormOf(configured),configured),appFormDirty({...appFormOf(configured),secret:'x'},configured),appFormDirty({...appFormOf(configured),tenantId:tenant.toUpperCase()},configured)],[false,true,false],'dirty only with a real change');
 check(Object.keys(mappingFormErrors({groupObjectId:'Ops',groupName:'',roleId:'',scope:'global'},configured)).sort(),['groupObjectId','roleId'],'mapping: GUID and role required');
 check(mappingFormErrors({groupObjectId:'0b0b0b0b-0000-4000-8000-000000000003',groupName:'',roleId:'builtin-user-access-administrator',scope:'0f0f0f0f-0000-4000-8000-000000000001'},configured),{roleId:'apiError.entra.roleNotAllowed'},'mapping: a portal role only for all devices');
 check(mappingScopeLabel({scopeType:'devicegroup',scopeName:null,scopeId:'x'},tr),t('rbac.scope.group',{value:'x'}),'scope label falls back to the ID');
}

// ---- The amr diagnostic (lib/entra/amr.ts) ------------------------------------------------------
{
 const {amrDiagnostic,formatAmrDiagnostic,parseAmrDiagnostic,amrDetail}=amr;
 check([amrDiagnostic(undefined),amrDiagnostic(null),amrDiagnostic('mfa'),amrDiagnostic({0:'mfa'})],['missing','missing','missing','missing'],'missing when amr is absent or not an array');
 check(amrDiagnostic(['rsa','pwd','rsa','mfa']),['rsa','pwd','mfa'],'token order, deduplicated');
 check(amrDiagnostic(['pwd','x"<y>',7,null,{a:1},'MFA','pwd']),['pwd','other'],'unknown strings and non-strings become one other');
 check(amrDiagnostic([]),[],'an empty array gives an empty list');
 const all=['pwd','rsa','otp','fed','wia','mfa','ngcmfa','wiaormfa','none','fido','face','fpt','hwk','swk','sms','tel','pin','kba','mca','sc','pop','user','geo','iris','retina','rba','vbm'];
 check(all.every(value=>amr.amrAllowList.has(value))&&amr.amrAllowList.size===all.length,true,'the allow-list of RFC 8176 and Microsoft values');
 check(amrDiagnostic(all),all.slice(0,10),'at most 10 entries');
 check([formatAmrDiagnostic('missing'),formatAmrDiagnostic(['pwd','rsa']),formatAmrDiagnostic([])],['missing','pwd,rsa',''],'the text form');
 for(const value of [['pwd'],['pwd','other','rsa'],[],'missing',all.slice(0,10)])check(parseAmrDiagnostic(formatAmrDiagnostic(value)),value,`parse round trip of ${formatAmrDiagnostic(value)||'(empty)'}`);
 for(const value of ['pwd;x','<b>','pwd,,rsa','pwd,pwd','x','PWD','pwd ','missing,pwd',all.slice(0,11).join(','),null,7])check(parseAmrDiagnostic(value),null,`parse rejects ${JSON.stringify(value)}`);
 check([amrDetail('missing'),amrDetail([]),amrDetail(['pwd','other'])],[{key:'entra.error.amrMissing'},{key:'entra.error.amrMissing'},{key:'entra.error.amrValues',methods:'pwd, other'}],'the detail line of a diagnostic');
 const source=readFileSync('lib/entra/amr.ts','utf8');
 ok(!/^import /m.test(source),'the amr module imports nothing: client-safe');
}

// ---- Sign-in card, gate, step-up ----------------------------------------------------------------
{
 const choice=render(h(EntraSignInChoice,{redirecting:false,onStart:()=>{}})),busy=render(h(EntraSignInChoice,{redirecting:true,onStart:()=>{}}));
 const [button]=buttons(choice);
 ok(text(button.inner).includes(t('identity.signInWithMicrosoft'))&&choice.includes('lucide-log-in'),'the Microsoft button with LogIn');
 ok(choice.includes('role="separator"')&&text(choice).includes(t('identity.or')),'divider "or" before the built-in form');
 ok(text(busy).includes(t('identity.redirecting'))&&/aria-busy="true"/.test(busy),'loading state while it navigates');
 for(const code of ['notConfigured','cancelled','expired','mfaMissing','apiSetupMissing','wrongTenant','accountDisabled','groupsOverage','tokenRejected','unavailable'])check(entraErrorKey(code),`entra.error.${code}`,`#entra=${code}`);
 // The amr detail line of #entra=mfaMissing&amr=<diagnostic>.
 check([entraErrorDetail('mfaMissing','pwd,rsa'),entraErrorDetail('mfaMissing','missing'),entraErrorDetail('mfaMissing',''),entraErrorDetail('mfaMissing',null),entraErrorDetail('mfaMissing','pwd;x'),entraErrorDetail('mfaMissing','<b>'),entraErrorDetail('tokenRejected','pwd')],
  [{key:'entra.error.amrValues',params:{methods:'pwd, rsa'}},{key:'entra.error.amrMissing'},{key:'entra.error.amrMissing'},null,null,null,null],'detail line: the values, missing, an empty list, no or an unparsable amr, other codes');
 check(t('entra.error.amrValues',{methods:'pwd, rsa'}),'Microsoft reported these sign-in methods: pwd, rsa. MFA (mfa) is not among them.','the values line');
 ok(!/Conditional Access/i.test(t('entra.error.mfaMissing'))&&t('entra.error.mfaMissing').includes('per-user MFA')&&!/Conditional Access/i.test(translate('en','apiError.entra.confirm.mfaMissing'))&&translate('en','apiError.entra.confirm.mfaMissing')===t('entra.error.mfaMissing'),'the mfaMissing texts name per-user MFA, not Conditional Access');
 // The sign-in card and the confirmation answer show the same text for the same cause, in both languages.
 for(const code of ['mfaMissing','apiSetupMissing','accountDisabled','tokenRejected','unavailable','wrongAccount','staleSignIn'])for(const locale of ['en','de'])check(translate(locale,`apiError.entra.confirm.${code}`),translate(locale,`entra.error.${code}`),`${locale}: entra.error.${code} equals apiError.entra.confirm.${code}`);
 ok(!/Conditional Access/i.test(t('help.entra.tip2'))&&t('help.entra.tip2').includes('per-user MFA')&&translate('de','help.entra.tip2').includes('MFA pro Benutzer'),'the help tip names per-user MFA, not Conditional Access');
 check([apiErrorCodes['apiError.entra.confirm.apiSetupMissing'],translate('en','apiError.entra.confirm.apiSetupMissing'),translate('de','apiError.entra.confirm.apiSetupMissing')],['ENTRA_CONFIRM_REFUSED',t('entra.error.apiSetupMissing'),translate('de','entra.error.apiSetupMissing')],'the claim answer of apiSetupMissing: ENTRA_CONFIRM_REFUSED with the sign-in card text');
 check([entraErrorKey('busy'),entraErrorKey('rateLimited'),entraErrorKey('<script>'),entraErrorKey(null)],['apiError.entra.busy','apiError.auth.rateLimited','entra.error.tokenRejected','entra.error.tokenRejected'],'busy, rate limit and unknown codes');
 const entry=readFileSync('ui/session/identity-entry.tsx','utf8');
 ok(entry.includes("status?.entra?.enabled===true")&&entry.includes("{entra&&<EntraSignInChoice"),'the card offers the button only while entra.enabled');
 ok(/params\.has\('entra'\)[^\n]*replaceState/.test(entry)&&entry.includes('<Notice tone="danger" icon={AlertTriangle}>{entraError}'),'the fragment leaves the address bar; its text shows as a danger Notice (role alert)');
 ok(entry.includes("entraErrorDetail(code,params.get('amr'))")&&entry.includes('{entraDetail&&<span className="sd-session-error-detail">{entraDetail}</span>}</Notice>'),'the amr detail is a second line inside the same alert');
 ok(entry.includes("t(collapsed?'identity.signInIntroEntraOnly':entra?'identity.signInIntroEntra':'identity.signInIntro')")&&entry.includes("variant={entra?'secondary':'primary'}"),'intro text and secondary submit while Entra is on');
 // After the session ended, an Entra account signs in again on the normal card with Sign in with Microsoft (docs/portal-sessions.md).
 const sessionGate=readFileSync('ui/session/session-gate.tsx','utf8');
 ok(!sessionGate.includes('EntraSessionExpired')&&!sessionGate.includes('useEntraConfirm')&&!sessionGate.includes('session.entraContinue'),'SessionGate: no Continue with Microsoft gate and no confirmation for an ended session');
 ok(sessionGate.includes('onSessionEnded')&&sessionGate.includes('setIdentitySource(viewer.identitySource);'),'SessionGate: the hand-over to the sign-in card and the identity source for the console');
 ok(entry.includes('focus={!!ended?.entra}')&&entry.includes("entraAccount?'':account.username??''"),'the sign-in card focuses Sign in with Microsoft for an Entra account and fills in no username');
 check(entraErrorKey('staleSignIn'),'entra.error.staleSignIn','a forced sign-in without a fresh auth_time shows the staleSignIn text');
 // MfaStepUp of an Entra viewer: Confirm with Microsoft and Cancel, no code field.
 const idle=render(h(EntraConfirmContent,{waiting:false,error:'',onConfirm:()=>{},onCancel:()=>{}}));
 check(buttons(idle).map(button=>text(button.inner)),[t('common.cancel'),t('mfa.entraConfirm')],'step-up of an Entra viewer: Cancel and Confirm with Microsoft');
 ok(!idle.includes('<input')&&idle.includes('lucide-log-in')&&!/role="alert"/.test(idle)&&/sdx-btn-primary/.test(buttons(idle)[1].attributes),'no code field; the primary Btn with LogIn; no error');
 ok(/role="status" aria-live="polite"><\/p>/.test(idle),'the polite line is empty before the click');
 const waiting=render(h(EntraConfirmContent,{waiting:true,error:'',onConfirm:()=>{},onCancel:()=>{}})),[cancelButton,confirmButton]=buttons(waiting);
 ok(/aria-busy="true"/.test(confirmButton.attributes)&&confirmButton.inner.includes('sdx-spin')&&text(confirmButton.inner)===t('mfa.entraConfirm'),'while waiting: the button keeps its name and shows the spinner');
 ok(!cancelButton.disabled&&text(waiting).includes(t('mfa.entraWaiting')),'while waiting: Cancel stays usable and the polite line says what happens');
 const refused=render(h(EntraConfirmContent,{waiting:false,error:t('mfa.entraClosed'),onConfirm:()=>{},onCancel:()=>{}}));
 ok(/role="alert"/.test(refused)&&text(refused).includes(t('mfa.entraClosed'))&&!/aria-busy/.test(buttons(refused)[1].attributes),'a refusal in the error slot; the button reads again');
 const security=readFileSync('ui/session/mfa-step-up.tsx','utf8');
 ok(security.includes("if(open&&!entra){")&&security.includes('if(entra)return <EntraStepUp')&&!security.includes('EntraStepUpContent'),'MfaStepUp of an Entra viewer: the confirmation, no passkey list, the old notice removed');
 ok(security.includes(`<Dialog open={open} onOpenChange={next=>{if(!next)close();}} className="sdx-stepup" title={t('mfa.title')} description={t('mfa.entraConfirmText')}>`),'the dialog: the kit Dialog with title and description');
 check(entraConfirmWindow,{name:'nodiverna-entra-confirm',features:'popup,width=520,height=680'},'the window name and features');
 const confirmSource=readFileSync('ui/session/entra-confirm.ts','utf8'),startBody=confirmSource.slice(confirmSource.indexOf('const start=()=>{'));
 ok(/openWindow:\(\)=>window\.open\('about:blank',entraConfirmWindow\.name,entraConfirmWindow\.features\)/.test(startBody)&&!/const start=async/.test(confirmSource),'start() opens the window inside the click, with no await before it');
 ok(confirmSource.includes("t('mfa.entraPopupBlocked')")&&confirmSource.includes("t('mfa.entraClosed')"),'the blocked-window and closed-window texts');
}

// ---- The confirmation controller (runEntraConfirm) with a fake window, requests and timers ----------
{
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 const harness=({blocked=false}={})=>{
  const log=[],requests=[],timers=[],state={clock:0,result:null,failure:null};
  const popup=blocked?null:{closed:false,url:null,close(){this.closed=true;log.push('close');},location:{replace:url=>{popup.url=url;log.push('navigate');}}};
  const run=runEntraConfirm({
   openWindow:()=>{log.push('open');return popup;},
   post:(body,signal)=>{log.push(body.action);return new Promise((resolve,reject)=>requests.push({body,signal,resolve,reject}));},
   now:()=>state.clock,
   wait:(callback,ms)=>{const timer={callback,ms,live:true};timers.push(timer);return()=>{timer.live=false;};},
   onSuccess:result=>{log.push('success');state.result=result;},
   onFailure:failure=>{log.push(`failure ${failure.kind}`);state.failure=failure;},
  });
  const answer=async value=>{requests.shift().resolve(value);await flush();};
  const refuse=async error=>{requests.shift().reject(error);await flush();};
  const tick=async()=>{const due=timers.filter(timer=>timer.live);for(const timer of due){timer.live=false;timer.callback();}await flush();return due.length;};
  const live=()=>timers.filter(timer=>timer.live).length;
  return {log,requests,timers,state,popup,run,answer,refuse,tick,live};
 };
 const begun={flow:'handle',url:'https://login.microsoftonline.com/x/oauth2/v2.0/authorize?prompt=login',expiresAt:600_000};
 // Success: the window opens before the first request, then polling until the result.
 {
  const run=harness();
  check(run.log,['open','entra-begin'],'the window opens synchronously, before entra-begin');
  await run.answer(begun);
  check([run.popup.url,run.live(),run.timers[0].ms],[begun.url,1,1000],'the window moves to Microsoft; the first claim waits 1 s');
  await run.tick();check(run.requests.map(request=>request.body),[{action:'entra-claim',flow:'handle'}],'claim with the handle');
  await run.answer({pending:true});check(run.live(),1,'pending: the next claim in 1 s');
  await run.tick();await run.answer({authenticated:true,managementToken:'proof',managementExpiresAt:1});
  check([run.state.result?.managementToken,run.popup.closed,run.live(),run.requests.length],['proof',true,0,0],'success: the proof, the window closed, polling stopped');
  await run.tick();check(run.log.filter(entry=>entry==='entra-claim').length,2,'no claim after success');
 }
 // Refusal: the server error ends it.
 {
  const run=harness();await run.answer(begun);await run.tick();
  const error=Object.assign(new Error('refused'),{code:'ENTRA_CONFIRM_REFUSED'});
  await run.refuse(error);
  check([run.state.failure,run.popup.closed,run.live()],[{kind:'server',error},true,0],'refusal: the server error, the window closed, polling stopped');
  await run.tick();check(run.log.filter(entry=>entry==='entra-claim').length,1,'no claim after a refusal');
 }
 // A closed window gets exactly one last claim.
 {
  const run=harness();await run.answer(begun);await run.tick();await run.answer({pending:true});
  run.popup.closed=true;
  await run.tick();await run.answer({pending:true});
  check([run.state.failure,run.live(),run.log.filter(entry=>entry==='entra-claim').length],[{kind:'closed'},0,2],'closed window: one last claim, then the closed-window text');
  const late=harness();await late.answer(begun);late.popup.closed=true;await late.tick();await late.answer({authenticated:true,managementToken:'late'});
  check([late.state.result?.managementToken,late.state.failure],['late',null],'closed window: a confirmation that finished still counts');
 }
 // The end of the flow gets one last claim.
 {
  const run=harness();await run.answer(begun);run.state.clock=begun.expiresAt;
  await run.tick();await run.answer({pending:true});
  check([run.state.failure,run.live(),run.popup.closed],[{kind:'closed'},0,true],'expired flow: one last claim, then stop');
 }
 // Cancel: nothing more is sent, nothing is reported, the window closes.
 {
  const run=harness();await run.answer(begun);await run.tick();
  const pending=run.requests[0];
  run.run.cancel();
  check([pending.signal.aborted,run.popup.closed,run.live()],[true,true,0],'cancel: the running claim is aborted, the window closes, no timer');
  await run.answer({authenticated:true,managementToken:'late'});await run.tick();
  check([run.state.result,run.state.failure,run.log.filter(entry=>entry==='entra-claim').length],[null,null,1],'cancel: a late reply is ignored and nothing more is sent');
  const early=harness();early.run.cancel();await early.answer(begun);
  check([early.popup.url,early.popup.closed,early.live(),early.state.failure],[null,true,0,null],'cancel before entra-begin answers: the window never moves to Microsoft');
 }
 // A blocked window sends nothing.
 {
  const run=harness({blocked:true});
  check([run.log,run.state.failure,run.requests.length],[['open','failure blocked'],{kind:'blocked'},0],'blocked window: the blocked text and no request');
 }
}

// ---- Account page and account list ------------------------------------------------------------------
{
 const viewer={id:'u',label:'u@x',displayName:'Ada Lovelace',identitySource:'entra',entra:{tenantId:tenant,objectId:'99999999-8888-4777-8666-555555555555',email:'ada@contoso.example'}};
 const account=text(render(h(EntraProfileCard,{viewer})));
 ok([t('account.profile.title'),t('account.entraHint'),t('account.profile.signInEntra'),t('account.entraTenant'),tenant,t('account.entraObject'),viewer.entra.objectId,'ada@contoso.example'].every(part=>account.includes(part)),'account page: the Entra Profile card with sign-in, email, and tenant and object behind Details');
 ok(!account.includes(t('password.title'))&&!account.includes(t('account.authenticatorApps')),'no password or authenticator section');
 const accounts=readFileSync('ui/settings/settings-accounts.tsx','utf8'),assignments=readFileSync('ui/devices/configuration/permissions-tab.tsx','utf8');
 ok(accounts.includes(`user.identitySource==='entra'?<span className="sdx-tag">{t('rbac.entraAccount')}</span>`),'account list: the Microsoft Entra ID tag instead of password and MFA');
 ok(accounts.includes("const local=user.identitySource!=='entra'")&&accounts.includes("if(manages&&local)list.push({id:'edit'")&&accounts.includes("if(manages&&local)list.push({id:'link'"),'account list: no edit and password link entries for Entra accounts (behaviour in tests/ui/settings/settings-rbac-pages.mjs)');
 ok(assignments.includes("assignment.source==='entra'?<>{roleName(assignment,data,locale)} <span className=\"sdx-tag\">{t('rbac.fromEntra')}</span></>")&&assignments.includes("blocked:assignment.source==='entra'?t('rbac.entraAssignmentBlocked'):lockReason"),'assignments from Entra: tag and blocked remove (behaviour in tests/ui/settings/access-workspace.mjs)');
}

// ---- Capability, tab, palette, help --------------------------------------------------------------------
{
 check([canOpenAccessSection(owner,'entra'),canOpenAccessSection(member,'entra')],[true,false],'Owners only');
 const {navNode,settingsGroups}=await import('../../../ui/shell/nav-model.ts'),page=navNode('settings.entra');
 const ids=settingsGroups({viewer:owner,multipleCustomers:true})[0].pages.map(node=>node.id);
 check(ids.slice(ids.indexOf('settings.user-groups'),ids.indexOf('settings.user-groups')+3),['settings.user-groups','settings.roles','settings.entra'],'the page in Accounts & access, after User groups and Roles');
 check([page.label,page.hint,page.icon,page.placement.group,page.palette.keywordsKey],['nav.settings.entra','nav.settings.entraHint','LogIn','nav.settings.groupUsers','entra.paletteKeywords'],'navigator and palette entry with its keywords');
 const topic=topicFor({view:'settings',page:'entra'},'en');
 check([topic.title,topic.tips.length,topic.tips[3],topic.tips[4],topic.tips[5]],[t('help.entra.title'),6,t('help.entra.tip4'),t('help.entra.tip5'),t('help.entra.tip6')],'help topic with 6 tips, the last on the emergency access');
 ok(translate('de','identity.signInWithMicrosoft')==='Mit Microsoft anmelden'&&translate('de','entra.status.notSetUp')==='Nicht eingerichtet','German catalog');
}
// ---- The account check card -------------------------------------------------------------------
{
 const card=(directoryCheck,extra={})=>render(h(EntraCheckCard,{view:{...configured,enabled:directoryCheck.state!=='off',...extra,directoryCheck:{...base.directoryCheck,...directoryCheck}},now}));
 const off=card({state:'off'}),offText=text(off);
 ok(offText.includes(t('entra.check.title'))&&offText.includes(t('entra.check.description'))&&offText.includes(t('entra.check.state.off'))&&offText.includes(t('entra.check.offHint')),'off: title, description, pill Off and the off hint');
 ok(!offText.includes(t('entra.check.lastRun'))&&!offText.includes(t('entra.check.nextRun')),'off: no facts and no next check');
 ok(/sdx-pill-neutral/.test(off),'off: neutral pill');
 ok(offText.includes('User.Read.All')&&offText.includes('GroupMember.Read.All')&&offText.includes(t('entra.check.permissionsHint'))&&offText.includes(t('entra.check.permissions')),'off: the required permissions with the hint stay visible');
 ok(off.includes(`aria-label="${t('entra.check.copyPermissions')}"`),'copy button label');
 check(permissionsText(base),'User.Read.All, GroupMember.Read.All','copied text');
 const waiting=text(card({state:'waiting',nextRunAt:now+45_000}));
 ok(waiting.includes(t('entra.check.state.waiting'))&&waiting.includes(t('entra.facts.never'))&&waiting.includes(t('entra.check.nextRun'))&&waiting.includes(t('kit.inMinutes',{count:1})),'waiting: Never checked, next check in a minute');
 const okHtml=card({state:'ok',result:'ok',lastRunAt:now-300_000,lastOkAt:now-300_000,nextRunAt:now+600_000,checked:1250,locked:2,groupChanges:3,remaining:7}),okText=text(okHtml);
 ok(okText.includes(t('entra.check.state.ok'))&&/sdx-pill-success/.test(okHtml),'ok: pill Working in success');
 ok(okText.includes(relativeTime(now-300_000,now,'en'))&&okText.includes(exactTime(now-300_000,'en'))&&okText.includes(t('kit.inMinutes',{count:10})),'ok: last check relative with the exact time, next check');
 ok(/sdx-entra-check-count">1,250</.test(okHtml)&&/sdx-entra-check-count">2</.test(okHtml)&&/sdx-entra-check-count">3</.test(okHtml),'ok: tabular counts of the last run');
 ok(okText.includes(t('entra.check.remaining',{count:7}))&&okText.includes('7 more accounts follow'),'ok: remaining hint under Accounts checked');
 ok(!/sdx-notice-danger/.test(okHtml)&&!okText.includes(t('entra.check.remaining',{count:0})),'ok: no notice');
 ok(text(card({state:'ok',result:'ok',lastRunAt:now-1000,nextRunAt:now+1000,remaining:1})).includes('1 more account follows'),'remaining: singular');
 for(const code of ['permissionMissing','credentialRefused','secretExpired','certificateRefused','unavailable']){
  const failed=card({state:'failed',result:code,lastRunAt:now-60_000,nextRunAt:now+840_000});
  ok(/sdx-notice-danger/.test(failed)&&/role="alert"/.test(failed)&&text(failed).includes(t(`entra.check.result.${code}`))&&text(failed).includes(t('entra.check.state.failed'))&&/sdx-pill-critical/.test(failed),`failed: danger Notice with the text of ${code}`);
 }
 check(Object.fromEntries(Object.entries(checkTones).map(([state,tone])=>[state,tone.tile])),{off:'neutral',waiting:'neutral',ok:'success',failed:'danger'},'tile tones per state');
 ok(!/<button[^>]*>(?:(?!<\/button>).)*(Check now|Run)/.test(okHtml)&&buttons(okHtml).length===1,'no action button besides copy');
 // Kept last Owners (keptOwners): a warning Notice below the danger notice and above the facts, the tile turns warning, the pill stays.
 const zoe={id:'u1',name:'Zoe Owner',since:now-3_600_000},ben={id:'u2',name:'Ben Owner',since:now-60_000};
 const okCheck={state:'ok',result:'ok',lastRunAt:now-300_000,nextRunAt:now+600_000};
 const tile=html=>/class="sdx-icon-tile sdx-icon-tile-(\w+)/.exec(html)?.[1];
 const pill=html=>/class="sdx-pill[^"]*"/.exec(html)?.[0];
 const one=card({...okCheck,keptOwners:[zoe]}),oneText=text(one);
 check(oneText.includes('Microsoft Entra ID reports Zoe Owner as disabled or deleted. Nodiverna keeps the account active because it is the last Owner. Make another account an Owner in Accounts, and the next check locks this account.'),true,'one kept account: the exact singular text');
 ok(/sdx-notice-warning/.test(one)&&/role="status"/.test(one),'one kept account: a warning Notice');
 const two=card({...okCheck,keptOwners:[ben,zoe]});
 check(text(two).includes('Microsoft Entra ID reports Ben Owner, Zoe Owner as disabled or deleted. Nodiverna keeps these accounts active because they are the last Owners. Make another account an Owner in Accounts, and the next check locks these accounts.'),true,'two kept accounts: the exact plural text with the names joined by ", "');
 const germanOne=text(render(h(EntraCheckCard,{view:{...configured,enabled:true,directoryCheck:{...base.directoryCheck,...okCheck,keptOwners:[zoe]}},now}),'de'));
 const germanTwo=render(h(EntraCheckCard,{view:{...configured,enabled:true,directoryCheck:{...base.directoryCheck,...okCheck,keptOwners:[ben,zoe]}},now}),'de');
 check(germanOne.includes('Microsoft Entra ID meldet Zoe Owner als deaktiviert oder gelöscht. Nodiverna lässt das Konto aktiv, weil es der letzte Owner ist. Mache unter Konten ein anderes Konto zum Owner, und die nächste Prüfung sperrt dieses Konto.'),true,'German: the exact singular text');
 check(text(germanTwo).includes('Microsoft Entra ID meldet Ben Owner, Zoe Owner als deaktiviert oder gelöscht. Nodiverna lässt diese Konten aktiv, weil sie die letzten Owner sind. Mache unter Konten ein anderes Konto zum Owner, und die nächste Prüfung sperrt diese Konten.'),true,'German: the exact plural text');
 ok(/<a class="sdx-btn sdx-btn-secondary sdx-btn-sm" href="#settings\/accounts"><span>Konten öffnen<\/span><\/a>/.test(germanTwo),'German: the action Konten öffnen');
 ok(/<a class="sdx-btn sdx-btn-secondary sdx-btn-sm" href="#settings\/accounts"><span>Open Accounts<\/span><\/a>/.test(one),'the action: a small secondary button link to Settings → Accounts');
 ok(text(card({...okCheck,keptOwners:[{id:'u3',name:'',since:now}]})).includes(`reports ${t('entra.check.keptOwnerUnnamed')} as disabled`),'an account without a shown name: the fallback text');
 ok(one.indexOf('sdx-notice-warning')<one.indexOf('sdx-facts')&&one.indexOf('sdx-notice-warning')>=0,'the warning sits above the facts');
 const failedKept=card({state:'failed',result:'unavailable',lastRunAt:now-60_000,nextRunAt:now+840_000,keptOwners:[zoe]});
 ok(failedKept.indexOf('sdx-notice-danger')>=0&&failedKept.indexOf('sdx-notice-danger')<failedKept.indexOf('sdx-notice-warning')&&failedKept.indexOf('sdx-notice-warning')<failedKept.indexOf('sdx-facts'),'failed: the danger notice first, then the warning, then the facts');
 check([tile(one),tile(card({state:'waiting',nextRunAt:now+45_000,keptOwners:[zoe]})),tile(failedKept),tile(okHtml)],['warning','warning','danger','success'],'tile tone: warning for ok and waiting with kept accounts, danger stays for failed, success without');
 check([checkTileTone({state:'ok',keptOwners:[zoe]}),checkTileTone({state:'failed',keptOwners:[zoe]}),checkTileTone({state:'ok',keptOwners:[]})],['warning','danger','success'],'checkTileTone');
 check([pill(one),pill(failedKept)],[pill(card(okCheck)),pill(card({state:'failed',result:'unavailable',lastRunAt:now-60_000,nextRunAt:now+840_000}))],'the status pill does not change');
 check(card({...okCheck,keptOwners:[]}),card(okCheck),'an empty list renders exactly as before');
 ok(!/sdx-notice-warning/.test(okHtml),'no kept accounts: no warning');
 const german=render(h(EntraCheckCard,{view:{...configured,enabled:true,directoryCheck:{...base.directoryCheck,state:'ok',result:'ok',lastRunAt:now-1000,nextRunAt:now+1000,checked:1250}},now}),'de');
 ok(text(german).includes('Kontoprüfung')&&/sdx-entra-check-count">1\.250</.test(german),'German: title and grouped number');
 // Card order: Status, App registration, Account check, Group mappings.
 const page=panelHtml({initialView:{...configured,enabled:true,directoryCheck:{...base.directoryCheck,state:'ok',result:'ok'}}});
 const order=['sdx-entra-status','sdx-entra-app','sdx-entra-check','sdx-entra-mappings'].map(name=>page.indexOf(name));
 ok(order.every((position,index)=>position>=0&&(index===0||position>order[index-1])),'card order: status, app registration, account check, group mappings');
 const demo=render(h(EntraSettingsPanel,{viewer:owner,demo:true,now,initialView:{...configured,enabled:true,directoryCheck:{...base.directoryCheck,state:'failed',result:'permissionMissing'}}}));
 ok(text(demo).includes(t('entra.check.result.permissionMissing')),'demo: the same read-only data');
 // The new test codes map to catalog texts.
 for(const code of ['graphPermissionMissing','graphUnreachable']){
  const html=panelHtml({initialView:{...configured,lastTest:{at:now-60_000,result:code,current:true}}});
  ok(/sdx-notice-danger/.test(html)&&text(html).includes(t(`entra.test.${code}`))&&t(`entra.test.${code}`)!==`entra.test.${code}`,`test code ${code}: danger Notice with its text`);
 }
}
// ---- Emergency access and Microsoft sign-in only -------------------------------------------------
{
 const {emergencyState,emergencyFactors,switchBlockedReason,switchCheckRows,switchConfirmLines}=panel;
 const titleAt=(html,key)=>html.indexOf(`>${t(key)}</h2>`);
 const ready={...configured,enabled:true};
 const order=panelHtml({initialView:ready});
 const positions=['entra.status.title','entra.app.title','entra.check.title','entra.mappings.title','entra.emergency.title','entra.only.title'].map(key=>titleAt(order,key));
 check([positions.every(position=>position>=0),positions.every((position,index)=>index===0||position>positions[index-1])],[true,true],'card order: Status, App registration, Account check, Group mappings, Emergency access, Microsoft sign-in only');
 const source=readFileSync('ui/settings/entra-settings-panel.tsx','utf8');
 ok(source.includes('<EntraEmergencyCard key="emergency"')&&source.includes('<EntraOnlyCard key="only"')&&source.indexOf('<EntraOnlyCard key="only"')<source.indexOf('</EntranceList>'),'both new cards enter with the EntranceList stagger');
 // No candidates: the Empty state, pill Not chosen, neutral tile.
 const card=(view,props={})=>render(h(panel.EntraEmergencyCard,{view,now,change:{busy:null,dispatch:()=>{},dialog:null,locked:undefined},...props}));
 const none=card(ready),nonePlain=text(none);
 check(emergencyState(ready),'none','no account: none');
 ok(nonePlain.includes(t('entra.emergency.state.none'))&&nonePlain.includes(t('entra.emergency.emptyTitle'))&&nonePlain.includes(t('entra.emergency.emptyText'))&&!none.includes('<select'),'no candidates: Empty with title and text, no select');
 ok(none.includes('sdx-icon-tile-neutral')&&nonePlain.includes(t('entra.emergency.description')),'neutral LifeBuoy tile and the description');
 // Candidates: the select with the placeholder, Save blocked with No changes.
 const candidates=[{id:'u1',username:'alice',displayName:'Alice'},{id:'u2',username:'bob',displayName:''}];
 const choose=card({...ready,emergency:{...ready.emergency,candidates}}),choosePlain=text(choose);
 ok(choose.includes('<select')&&choosePlain.includes('Alice (alice)')&&choosePlain.includes('bob')&&choosePlain.includes(t('entra.emergency.choose')),'the select lists the candidates after the placeholder');
 ok(choosePlain.includes(t('entra.emergency.account'))&&choosePlain.includes(t('entra.emergency.accountHint')),'the field label and hint');
 check(blockedReasons(choose),[t('common.noChanges')],'Save emergency access blocked until the choice differs');
 ok(buttons(choose).some(button=>text(button.inner).includes(t('entra.emergency.save'))),'the save button');
 // Chosen: the facts, pill Ready, success tile.
 const account={id:'u1',username:'alice',displayName:'Alice',authenticator:true,passkeys:2};
 const chosenView={...ready,emergency:{account,candidates,lastSignInAt:now-3*3_600_000,openAlarms:0},switchChecks:{signIn:true,emergency:true,viewerEntraOwner:false,mailChannel:true}};
 const chosen=card(chosenView),chosenPlain=text(chosen);
 check(emergencyState(chosenView),'ready','chosen and qualifying: ready');
 ok(chosenPlain.includes(t('entra.emergency.state.ready'))&&chosen.includes('sdx-icon-tile-success'),'pill Ready with the success tile');
 ok(chosen.includes('sdx-facts-2')&&chosenPlain.includes('Alice')&&chosenPlain.includes(`${t('entra.emergency.factor.authenticator')} · ${t('entra.emergency.factor.passkeys',{count:2})}`),'facts in two columns: account and both factors');
 ok(chosenPlain.includes(relativeTime(now-3*3_600_000,now,'en'))&&chosenPlain.includes(exactTime(now-3*3_600_000,'en'))&&/sdx-entra-check-count">0</.test(chosen),'last emergency sign-in with its exact time; open alarms as a tabular number');
 check([emergencyFactors({authenticator:false,passkeys:1},t),emergencyFactors({authenticator:true,passkeys:0},t),emergencyFactors({authenticator:false,passkeys:0},t)],['1 passkey','Authenticator app','—'],'the factor line');
 ok(text(card({...chosenView,emergency:{...chosenView.emergency,lastSignInAt:null}})).includes(t('entra.facts.never')),'never used: Never');
 check(blockedReasons(chosen),[t('common.noChanges')],'the chosen account is selected: no changes');
 const used=card({...chosenView,emergency:{...chosenView.emergency,openAlarms:2}});
 ok(text(used).includes(t('entra.emergency.state.used'))&&used.includes('sdx-icon-tile-warning'),'open alarms: pill Used with the warning tile');
 // While on: the line instead of the select.
 const onView={...chosenView,entraOnly:{enabled:true,since:now-86_400_000,by:'owner@contoso.test',lockedAccounts:4}};
 const fixed=card(onView);
 ok(text(fixed).includes(t('entra.emergency.changeBlocked'))&&!fixed.includes('<select')&&buttons(fixed).length===0,'while on: changeBlocked instead of the select');
 // The checklist of the switch.
 const only=(view,props={})=>render(h(panel.EntraOnlyCard,{view,now,change:{busy:null,dispatch:()=>{},dialog:null},...props}));
 const missing={...ready,switchChecks:{signIn:true,emergency:false,viewerEntraOwner:false,mailChannel:false}};
 const list=only(missing),listPlain=text(list);
 ok(listPlain.includes(t('entra.only.state.off'))&&list.includes('sdx-icon-tile-neutral')&&listPlain.includes(t('entra.only.checks')),'off: pill Off, neutral LockKeyhole tile, the checklist heading');
 check(switchCheckRows(missing).map(row=>[row.id,row.met]),[['signIn',true],['emergency',false],['owner',false],['mail',false]],'four checks in order');
 check([...list.matchAll(/sdx-entra-check-row (is-\w+)/g)].map(match=>match[1]),['is-met','is-missing','is-missing','is-warning'],'met, missing (XCircle) and the mail warning (AlertTriangle)');
 ok(listPlain.includes(`${t('entra.only.check.met')}: ${t('entra.only.check.signIn')}`)&&listPlain.includes(`${t('entra.only.check.notMet')}: ${t('entra.only.check.owner')}`),'every row says met or not met in text, not by color alone');
 ok(listPlain.includes(t('entra.only.check.ownerHint'))&&listPlain.includes(t('entra.only.check.mailHint')),'the owner hint and the mail hint while not met');
 check(blockedReasons(list),[t('entra.only.blocked')],'the switch is blocked until the first three checks pass');
 ok(buttons(list).some(button=>text(button.inner).includes(t('entra.only.switch'))),'the primary button Switch to Microsoft sign-in only');
 const passing={...chosenView,switchChecks:{signIn:true,emergency:true,viewerEntraOwner:true,mailChannel:false}};
 const go=only(passing);
 check([blockedReasons(go),switchBlockedReason(passing,t)],[[],null],'all three checks: not blocked; the mail channel only warns');
 ok(!text(go).includes(t('entra.only.check.ownerHint'))&&text(go).includes(t('entra.only.check.mailHint')),'no owner hint once met; the mail warning stays');
 // The confirmation of the switch: its lines, label and tone.
 check(switchConfirmLines({...passing,entraOnly:{...passing.entraOnly,lockedAccounts:7}},t,'en'),['Built-in accounts to lock: 7','Emergency access: Alice'],'confirm lines: the accounts to lock and the emergency access');
 ok(source.includes("tone=\"danger\" title={t('entra.only.confirm.title')} body={t('entra.only.confirm.text')} confirmLabel={t('entra.only.switch')}"),'the switch confirmation: danger, its title and text, the button label as confirmLabel');
 ok(source.includes("title={t('entra.only.allowConfirm.title')} body={t('entra.only.allowConfirm.text')} confirmLabel={t('entra.only.allowLocal')}"),'the allow-again confirmation with its own label');
 ok(source.includes("t('entra.only.switched',{count:Number(done.locked??0)})")&&source.includes("toast.success(t('entra.only.allowed'))"),'a toast after each direction, the switch with the count');
 // While on: the facts and the way back; the warning while sign-in is off.
 const onHtml=only(onView),onPlain=text(onHtml);
 ok(onPlain.includes(t('entra.only.state.on'))&&onHtml.includes('sdx-icon-tile-success')&&onHtml.includes('sdx-facts-3'),'on: pill On, success tile, three facts');
 ok(onPlain.includes(t('entra.only.since'))&&onPlain.includes(relativeTime(now-86_400_000,now,'en'))&&onPlain.includes('owner@contoso.test')&&/sdx-entra-check-count">4</.test(onHtml),'switched on, by, and the locked built-in accounts');
 ok(buttons(onHtml).some(button=>text(button.inner).includes(t('entra.only.allowLocal')))&&!onPlain.includes(t('entra.only.checks')),'the secondary button Allow built-in accounts again, no checklist');
 ok(!onPlain.includes(t('entra.only.signInOff')),'no sign-in-off warning while Microsoft is on');
 const offSignIn=only({...onView,enabled:false});
 ok(/sdx-notice-warning/.test(offSignIn)&&text(offSignIn).includes(t('entra.only.signInOff')),'on with Microsoft off: the warning Notice');
 // The switch-off confirmation of the status card while Microsoft sign-in only is on.
 ok(source.includes("if(!enabled&&view.entraOnly.enabled)return new Promise<boolean>(resolve=>{offAnswer.current=resolve;setOffConfirm(true);});")&&source.includes("onOpenChange={open=>{if(!open)answerOff(false);}}")&&source.includes("title={t('entra.offConfirm.title')} body={t('entra.offConfirm.text')} confirmLabel={t('entra.offConfirm.action')}"),'turning sign-in off while Microsoft sign-in only is on confirms first');
 // Demo: the real data, and no action blocked by the demo.
 const demoPanel=render(h(EntraSettingsPanel,{viewer:owner,demo:true,now,initialView:{...passing,emergency:{...passing.emergency,account:{...account,id:'u3'}}}}));
 ok(text(demoPanel).includes('Alice')&&!blockedReasons(demoPanel).includes(t('kit.unavailable.demo')),'demo: both cards show the data and block nothing for the demo');
 const demoOn=render(h(EntraSettingsPanel,{viewer:owner,demo:true,now,initialView:onView}));
 ok(!blockedReasons(demoOn).includes(t('kit.unavailable.demo'))&&buttons(demoOn).some(button=>text(button.inner).includes(t('entra.only.allowLocal'))&&!button.blocked),'demo while on: Allow built-in accounts again is not blocked');
 // German.
 const german=text(render(h(EntraSettingsPanel,{viewer:owner,demo:false,now,initialView:missing}),'de'));
 ok(german.includes('Notfallzugang')&&german.includes('Nur Microsoft-Anmeldung')&&german.includes('Bevor du umstellst')&&german.includes('Nicht erfüllt'),'German copy of both cards');
}

// ---- The page on the kit (SettingsPage, Switch, CopyValue, Select, FormActions) and the edit rule ----------
{
 const {appFormOnView,emergencyChoiceOnView,emergencyChoiceOf,mappingFormDirty}=panel;
 const source=readFileSync('ui/settings/entra-settings-panel.tsx','utf8');
 // SettingsPage: the Skeleton on the first load, LoadFailed with Try again, the cards below the notice.
 const loading=panelHtml({});
 ok(/^<div class="sdx-settings-page sdx-entra-settings"><div class="sdx-settings"><div class="sdx-skeleton-set sdx-skeleton-facts" role="status" aria-label="[^"]+"/.test(loading)&&loading.includes(`aria-label="${t('nav.settings.entra')}"`),'first load: the SettingsPage Skeleton labelled with the page name');
 const failedOnly=panelHtml({initialLoadFailed:true});
 ok(/^<div class="sdx-settings-page sdx-entra-settings"><div class="sdx-settings"><div class="sdx-notice sdx-notice-danger" role="alert">/.test(failedOnly)&&text(failedOnly).includes(t('entra.loadError'))&&buttons(failedOnly).map(button=>text(button.inner)).join()===t('common.retry'),'a failed load without data: LoadFailed with entra.loadError and Try again in place of the cards');
 const failedWithData=panelHtml({initialView:configured,initialLoadFailed:true});
 ok(text(failedWithData).includes(`${t('entra.loadError')} ${t('notifications.staleData')}`)&&!text(failedOnly).includes(t('notifications.staleData')),'a failed reload with data adds the stale-data note; a failed first load does not');
 ok(failedWithData.indexOf('sdx-notice-danger')>0&&failedWithData.indexOf('sdx-notice-danger')<failedWithData.indexOf(t('entra.status.title')),'with loaded data the cards stay below the notice');
 ok(source.includes('onRetry={()=>void load()}')&&!/<Skeleton\b/.test(source)&&!/<Notice tone="danger" icon=\{AlertTriangle\} action=\{retry\}/.test(source),'the retry runs the same GET; no own Skeleton or Notice for the load');
 // Switch: role="switch", the blocked reason as its description, no tinted box.
 const blockedHtml=panelHtml({initialView:base}),input=blockedHtml.match(/<input type="checkbox" role="switch"[^>]*>/)?.[0]??'';
 const reasonId=input.match(/aria-describedby="([^"]+)"/)?.[1];
 ok(/aria-disabled="true"/.test(input)&&!/\sdisabled=""/.test(input)&&!!reasonId&&new RegExp(`<small id="${reasonId}" class="sdx-switch-reason">${t('entra.enableBlockedTest')}</small>`).test(blockedHtml),'the kit Switch: blocked, focusable, the reason below it as its description');
 ok(blockedHtml.includes(`<span>${t('entra.enable')}</span>`)&&blockedHtml.includes('sdx-switch-field sdx-switch-blocked')&&!blockedHtml.includes('sdx-entra-switch')&&!readFileSync('ui/settings/entra-settings.css','utf8').includes('sdx-entra-switch'),'label entra.enable; the tinted .sdx-entra-switch box and its CSS are gone');
 ok(source.includes("<Switch label={t('entra.enable')} checked={view.enabled} blocked={blocked} busy={busy} onChange={onToggle}/>")&&source.includes('.then(result=>result!==null)'),'the switch resolves false (rolls back) when the step-up is cancelled or the request failed');
 // CopyValue: the redirect URI, the application ID URI and the Graph permissions.
 const copyHtml=panelHtml({initialView:configured});
 const copies=buttons(copyHtml).filter(button=>button.inner.includes('lucide-copy')).map(button=>button.label);
 check(copies,[t('entra.copyRedirectUri'),t('entra.copyApplicationIdUri'),t('entra.check.copyPermissions')],'three kit CopyValues with their accessible names');
 ok((copyHtml.match(/class="sdx-copy-value( sdx-copy-value-custom)?"/g)??[]).length===4&&/class="sdx-copy-value sdx-copy-value-custom"><ul class="sdx-entra-permission-list">/.test(copyHtml),'the permissions show as the list (display) of a CopyValue; the scope line uses the same box');
 ok(source.includes("success={t('entra.redirectUriCopied')}")&&source.includes("success={t('entra.applicationIdUriCopied')}")&&source.includes("success={t('entra.check.permissionsCopied')}")&&source.includes('value={permissionsText(view)}'),'the success toasts stay the existing keys; the permissions copy permissionsText');
 ok(!/function CopyValue|navigator\.clipboard|setCopied/.test(source),'no local CopyValue and no own copy logic');
 // Select: the mapping drawer and the emergency account.
 ok(source.includes('<Select id={`${formId}-role`}')&&source.includes('<Select id={`${formId}-scope`}')&&source.includes('<Select id={`${id}-account`}')&&!/<select\b/.test(source),'Role, Scope and the emergency account are kit Selects inside Field');
 const emergencyHtml=render(h(panel.EntraEmergencyCard,{view:{...configured,emergency:{account:null,candidates:[{id:'u1',username:'alice',displayName:'Alice'}],lastSignInAt:null,openAlarms:0}},now,change:{busy:null,dispatch:()=>{},dialog:null,locked:undefined}}));
 ok(/<label class="sdx-field-label" for="sdx-entra-emergency-account">[^<]+<\/label><select[^>]*class="sdx-select"/.test(emergencyHtml),'the emergency Select is bound to its Field label');
 ok(source.includes('dirty={mappingFormDirty(form)}')&&source.includes("<DrawerCancel label={t('common.cancel')}"),'the mapping drawer passes dirty and uses DrawerCancel');
 check([mappingFormDirty({groupObjectId:'',groupName:'',roleId:'',scope:'global'}),mappingFormDirty({groupObjectId:'x',groupName:'',roleId:'',scope:'global'}),mappingFormDirty({groupObjectId:'',groupName:'',roleId:'',scope:'g1'})],[false,true,true],'mapping dirty: any field differs from empty');
 // FormActions: Test connection, then Save with entra.save; Discard only while dirty.
 const appButtons=buttons(copyHtml.slice(copyHtml.indexOf('id="sdx-entra-app-title"'),copyHtml.indexOf('id="sdx-entra-check-title"'))).filter(button=>!button.label);
 check(appButtons.map(button=>button.inner.match(/<span>([^<]+)<\/span>/)?.[1]),[t('entra.test'),t('common.save')],'the app card actions: Test connection (extra) first, then Save');
 ok(/type="submit"/.test(appButtons[1].attributes)&&appButtons[1].blocked&&appButtons[1].description===t('common.noChanges')&&/sdx-btn-secondary/.test(appButtons[1].attributes),'not dirty: Save is a blocked secondary with No changes');
 ok(source.includes("<FormActions dirty={dirty} busy={!!change.busy} loading={change.busy==='save'} saveLabel={t('common.save')} onDiscard={()=>reset(view)}")&&source.includes('extra={<Btn icon={FlaskConical}'),'FormActions with extra = Test connection and label entra.save; no demo block');
 // The edit rule: a new view keeps typed values while dirty.
 const next={...configured,revision:4,tenantId:'99999999-2222-4333-8444-555555555555'};
 const clean=appFormOf(configured),typed={...clean,clientId:'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee'};
 check(appFormOnView(clean,configured,next),appFormOf(next),'not dirty + a new view: the form takes the new stored values');
 check(appFormOnView(typed,configured,next),typed,'dirty + a new view: the typed values stay');
 check([appFormDirty(appFormOnView(typed,configured,next),next),appFormDirty(appFormOnView(clean,configured,next),next)],[true,false],'dirtiness is measured against the new view');
 ok(source.includes("saved=>{toast.success(t(saved.disabled===true?'entra.savedDisabled':'entra.saved'));reset(saved);}")&&source.includes('setForm(appFormOnView(form,baseline,view))')&&!source.includes('setForm(appFormOf(view));setSubmitted(false)'),'only the own Save and Discard reset the form');
 const candidates=[{id:'u1',username:'alice',displayName:'Alice'},{id:'u2',username:'bob',displayName:''}];
 const stored={emergency:{account:{id:'u1'},candidates}},moved={emergency:{account:{id:'u2'},candidates}};
 check([emergencyChoiceOf(stored),emergencyChoiceOnView('u1',stored,moved),emergencyChoiceOnView('u2',{emergency:{account:null,candidates}},{emergency:{account:{id:'u1'},candidates}}),emergencyChoiceOnView('u2',stored,{emergency:{account:{id:'u1'},candidates:[candidates[0]]}})],['u1','u2','u2','u1'],'the emergency choice: unchanged follows the new view, a changed choice stays while it is a candidate');
 // The removed keys.
 const en=readFileSync('lib/i18n/messages/en.ts','utf8'),de=readFileSync('lib/i18n/messages/de.ts','utf8');
 ok(![en,de].some(catalog=>/'entra\.(discard|noChanges)'/.test(catalog)),'entra.discard and entra.noChanges are gone from both catalogs');
}

console.log(`PASS entra settings view (${checks} checks): settings panel states, account check card, sign-in card, gate, step-up, the confirmation controller, account page and list, capability, tab, palette and help, the emergency access and Microsoft sign-in only cards, the page on the kit (SettingsPage, Switch, CopyValue, Select, FormActions) and the rule that keeps typed values.`);
