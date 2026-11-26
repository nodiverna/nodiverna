// Drive the real My account handlers without a browser: the password Drawer, the authenticator
// Drawers with the QR step, removals through the danger ConfirmDialog, recovery codes with CopyValue,
// the passkey Drawer that keeps the user gesture for WebAuthn after the step-up, and toasts instead of
// inline status lines. Every change that needs a fresh proof waits for MfaStepUp and forwards its one-use proof.
import assert from 'node:assert/strict';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

const at=Date.now();
let requests=[],registrations=[],apiFailures=[],registerFailures=[],continuation=null,navigations=[];
const status={enabled:true,available:true,authenticated:true,verifiedUntil:at+3600000,authenticatorCount:2,maximumAuthenticators:10,passkeyCount:1,passkeysAvailable:true,authenticators:[{id:'one',name:'Phone',createdAt:at,lastUsedAt:null},{id:'two',name:'Backup',createdAt:at,lastUsedAt:null}]};
const keyStatus={available:true,canManage:true,count:1,authenticatorCount:1,passkeys:[{id:'key',name:'Laptop',device:'local',createdAt:at,lastUsedAt:null,backedUp:false,deviceType:'singleDevice'}]};
const proof={managementToken:'fresh-one-use-proof',managementExpiresAt:at+300000},proof2={managementToken:'second-one-use-proof',managementExpiresAt:at+300000};
class ApiError extends Error{constructor(text,status,code){super(text);this.status=status;this.code=code;}}
const failing=(code,statusCode=403)=>new ApiError('Server text for '+code,statusCode,code);
let mfaStatus=status,passkeyStatus=keyStatus;
const shared={ApiError,message:e=>e.message,stamp:value=>String(value),downloadText:(...args)=>requests.push({download:args}),api:async(url,body)=>{
 requests.push({url,body});
 const failure=body&&['delete','rename','password-change'].includes(body.action)?apiFailures.shift():undefined;if(failure)throw failure;
 if(!body)return url==='/api/passkeys'?passkeyStatus:mfaStatus;
 if(body.action==='authenticator-begin')return {challengeId:'pending',secret:'BASE32SECRET',uri:'otpauth://totp/Nodiverna',expiresAt:at+600000};
 if(body.action==='regenerate-recovery')return {recoveryCodes:['CODE-A','CODE-B']};
 return {ok:true};
}};
function MfaStepUp(){return null;}
function MfaQrCode(){return null;}
globalThis.window={dispatchEvent(){},addEventListener(){},removeEventListener(){},location:{replace:target=>navigations.push(target)}};
const harness=panelHarness({hooked:['ui/account/account-panel.tsx','ui/account/passkeys-panel.tsx','ui/account/password-settings.tsx','ui/shell/page-frame.ts'],stubs:{
 '@/ui/base/api':shared,
 '@/ui/base/http':{portalNow:()=>at,SESSION_LOCK_EVENT:'lock',SESSION_SYNC_EVENT:'sync'},
 '@/ui/session/passkey-client':{passkeyError:e=>e.message,registerPasskey:async(...args)=>{registrations.push(args);const failure=registerFailures.shift();if(failure)throw failure;return {ok:true};}},
 '@/ui/session/passkey-support':{usePasskeySupport:()=>null,DirectTabLink:()=>null},
 '@/ui/session/mfa-step-up':{MfaStepUp},
 '@/ui/session/mfa-qr-code':{__esModule:true,default:MfaQrCode},
}});
const {SignInSecurityCard}=harness.load('ui/account/account-panel.tsx');
const PasskeysPanel=harness.load('ui/account/passkeys-panel.tsx').default,PasswordSettings=harness.load('ui/account/password-settings.tsx').default;
const {Drawer}=harness.load('ui/kit/kit.tsx'),{ConfirmDialog}=harness.load('ui/kit/confirm-dialog.tsx');
const viewer={id:'owner',label:'owner@example.test',username:'owner',permissions:['*']};
let tree=null,Panel=null,props=null;
const render=()=>{tree=harness.tree(Panel,props);return tree;};
async function start(component,componentProps,seed={}){harness.reset(seed);requests=[];registrations=[];apiFailures=[];registerFailures=[];continuation=null;navigations=[];mfaStatus=component===SignInSecurityCard&&seed[0]||status;passkeyStatus=component===PasskeysPanel&&seed[0]||keyStatus;Panel=component;props=componentProps;render();await harness.flush();render();requests=[];}
const find=predicate=>harness.find(tree,predicate);
const button=label=>{const node=harness.button(tree,label);assert.ok(node,`button ${label}`);return node;};
const byId=id=>find(node=>node.props?.id===id);
const openDrawer=()=>find(node=>node.type===Drawer&&node.props.open);
const confirm=()=>find(node=>node.type===ConfirmDialog&&node.props.open);
const submit=id=>byId(id).props.onSubmit({preventDefault(){}});
const stepUp=()=>find(node=>node.type===MfaStepUp);
const menuEntry=(name,id)=>{const entries=harness.menu(tree,de('account.rowActions',{name}));assert.ok(entries,`row menu of ${name}`);return entries.find(entry=>entry.id===id);};
const toasts=()=>harness.toasts.splice(0);
const sent=action=>requests.filter(request=>request.body?.action===action);

// ---- Add authenticator: name Drawer, step-up, QR step, activation ----
await start(SignInSecurityCard,{viewer},{7:false});
button(de('account.addAuthenticator')).props.onClick();render();
let open=openDrawer();
check([open.props.title,open.props.description],[de('account.addAuthenticator'),de('account.addIntro')],'a kit Drawer "Add authenticator"');
check(byId('account-authenticator-name').props.value,de('account.defaultAuthenticatorName'),'step one: the Name field');
ok(harness.text(open.props.footer).includes(de('common.continue'))&&find(node=>node.props?.form==='account-authenticator-form').props.variant==='primary','the primary submits the form');
submit('account-authenticator-form');render();
check(requests.length,0,'no enrollment from the old session alone');
ok(stepUp().props.open&&!openDrawer(),'the step-up opens, the drawer waits');
stepUp().props.onVerified(proof);await harness.settle();render();
check(sent('authenticator-begin')[0].body,{action:'authenticator-begin',name:de('account.defaultAuthenticatorName'),managementToken:proof.managementToken},'begin with the fresh proof');
open=openDrawer();
ok(open&&find(node=>node.type===MfaQrCode)?.props.uri==='otpauth://totp/Nodiverna','step two: the QR code');
const setupKey=find(node=>node.props?.value==='BASE32SECRET');
check([setupKey.props.label,setupKey.props.success],[de('session.copySetupKey'),de('session.setupKeyCopied')],'the setup key is a CopyValue with its toast');
ok(harness.text(open).includes(de('session.setupKey'))&&find(node=>node.type==='a'&&node.props.href==='otpauth://totp/Nodiverna'),'the label "Setup key" and the link Open authenticator');
const primary=()=>find(node=>node.props?.form==='account-authenticator-form');
check([harness.text(primary()),primary().props.blocked],[de('account.activateAuthenticator'),de('session.codeBlocked')],'Activate authenticator is blocked until 6 digits');
check([byId('account-authenticator-code').props.inputMode,byId('account-authenticator-code').props.maxLength],['numeric',6],'the code field is numeric with 6 digits');
byId('account-authenticator-code').props.onChange({target:{value:'12a3456'}});render();
check(primary().props.blocked,undefined,'six digits unblock it');
submit('account-authenticator-form');await harness.settle();render();
check(sent('authenticator-confirm')[0].body,{action:'authenticator-confirm',challengeId:'pending',code:'123456'},'activation confirms the pending secret');
check(toasts(),[de('account.authenticatorAdded')],'success is a toast');
ok(!openDrawer()&&!find(node=>node.type===MfaQrCode),'the drawer closes');

// ---- Reset: step-up, QR step, closing cancels the challenge ----
await start(SignInSecurityCard,{viewer},{7:false});
menuEntry('Phone','reset').onSelect();render();
check(openDrawer().props.title,de('account.title.reset'),'Reset authenticator opens a Drawer');
submit('account-authenticator-form');render();check(requests.length,0,'reset waits for a fresh proof');
stepUp().props.onVerified(proof);await harness.settle();render();
check(sent('authenticator-begin')[0].body,{action:'authenticator-begin',id:'one',name:'Phone',managementToken:proof.managementToken},'begin with the entry id');
check(harness.text(primary()),de('account.confirmReset'),'the primary reads Confirm reset');
openDrawer().props.onClose();await harness.settle();render();
check(sent('authenticator-cancel')[0].body,{action:'authenticator-cancel',challengeId:'pending'},'closing the drawer cancels the pending challenge');
ok(!sent('authenticator-confirm').length&&!openDrawer(),'nothing was confirmed');

// ---- Rename authenticator ----
await start(SignInSecurityCard,{viewer},{7:false});
menuEntry('Backup','rename').onSelect();render();
check([openDrawer().props.title,harness.text(primary())],[de('account.title.rename'),de('account.rename')],'Rename opens a Drawer with the verb Rename');
ok(byId('account-authenticator-name').props.autoFocus,'the Name field takes the focus');
check(primary().props.blocked,de('common.noChanges'),'Rename is blocked while the name is unchanged');
submit('account-authenticator-form');await harness.settle();render();
check(sent('authenticator-rename').length,0,'an unchanged name sends nothing');
byId('account-authenticator-name').props.onChange({target:{value:'  Tablet  '}});render();
ok(openDrawer().props.dirty,'the changed name makes the drawer dirty');
submit('account-authenticator-form');await harness.settle();render();
check(sent('authenticator-rename')[0].body,{action:'authenticator-rename',id:'two',name:'Tablet'},'rename sends the trimmed name');
check(toasts(),[de('account.authenticatorRenamed')],'rename toasts');

// ---- Remove authenticator: danger ConfirmDialog, then the step-up ----
await start(SignInSecurityCard,{viewer},{7:false});
menuEntry('Backup','remove').onSelect();render();
let dialog=confirm();
check([dialog.props.tone,dialog.props.title,dialog.props.confirmLabel,dialog.props.lines],['danger',de('account.title.remove'),de('account.removeAuthenticator'),[{label:de('common.name'),value:'Backup'}]],'ConfirmDialog danger with the question, the name and the verb');
check(dialog.props.body,de('account.removeIntro',{name:'Backup'}),'the consequence sentence');
dialog.props.onConfirm();render();
check(requests.length,0,'removal waits for a fresh factor');ok(stepUp().props.open&&!confirm(),'the step-up follows the confirmation');
stepUp().props.onVerified(proof);await harness.settle();render();
check(sent('authenticator-delete')[0].body,{action:'authenticator-delete',id:'two',managementToken:proof.managementToken},'delete with the proof');
check(toasts(),[de('account.authenticatorRemoved')],'removal toasts');
// The last factor stays.
await start(SignInSecurityCard,{viewer},{0:{...status,authenticatorCount:1,passkeyCount:0,authenticators:[status.authenticators[0]]},7:false});
check(menuEntry('Phone','remove').blocked,de('passkeys.lastFactor'),'remove on the last factor is blocked with its sentence');

// ---- Recovery codes: step-up, then the codes inline with CopyValue, Download and Hide ----
await start(SignInSecurityCard,{viewer},{7:false});
button(de('account.newCodes')).props.onClick();render();
check(requests.length,0,'new codes wait for a fresh factor');
stepUp().props.onVerified(proof);await harness.settle();render();
check(sent('regenerate-recovery')[0].body.managementToken,proof.managementToken,'the proof reaches the regeneration');
check(toasts(),[de('account.newCodesCreated')],'new codes toast');
const codes=find(node=>node.props?.value==='CODE-A\nCODE-B');
check([codes.props.label,codes.props.success],[de('account.copyCodes'),de('account.codesCopied')],'the codes are one CopyValue with its toast');
ok(harness.text(codes.props.display).includes('CODE-A')&&harness.text(tree).includes(de('account.codesLabel')),'it shows the code list under "Recovery codes"');
button(de('account.saveCodes')).props.onClick();
check(requests.at(-1).download,['ServerDesk-Recovery-Codes.txt','CODE-A\nCODE-B','text/plain'],'Download codes saves the same file');
check(button(de('account.hide')).props.variant,'ghost','Hide is a ghost Btn');
button(de('account.hide')).props.onClick();render();
ok(!find(node=>node.props?.value==='CODE-A\nCODE-B'),'Hide removes the codes');
ok(!harness.text(tree).includes('sd-account-feedback'),'no inline success line');

// ---- Password: Drawer, field errors, step-up cancel keeps the input, success replaces the location ----
let confirmed=null,cancelled=null;
await start(PasswordSettings,{viewer,onConfirmIdentity:(yes,no)=>{confirmed=yes;cancelled=no;}});
button(de('password.change')).props.onClick();render();
open=openDrawer();
check([open.props.title,open.props.description],[de('password.change'),de('password.dialogIntro')],'a Drawer "Change password" with its consequences');
check(harness.text(find(node=>node.props?.form==='account-password-form')),de('password.change'),'the trigger, the title and the submit all read Change password');
const fieldOf=id=>find(node=>node.props?.label!==undefined&&node.props?.children?.props?.id===id);
check([fieldOf('account-current-password').props.label,fieldOf('account-new-password').props.label,fieldOf('account-new-password').props.hint,fieldOf('account-new-password-confirm').props.label],[de('password.current'),de('identity.newPassword'),de('password.rule'),de('password.newRepeat')],'Current password, New password with its hint, Repeat new password');
check([fieldOf('account-current-password').props.error,fieldOf('account-new-password').props.error],[false,false],'no field errors before the first submit');
submit('account-password-form');render();
ok(!confirmed&&fieldOf('account-current-password').props.error===de('password.enterCurrent')&&fieldOf('account-new-password').props.error===de('password.tooShort'),'after the first submit the errors show under the fields');
const fill=(current,next,repeat)=>{byId('account-current-password').props.onChange({target:{value:current}});render();byId('account-new-password').props.onChange({target:{value:next}});render();byId('account-new-password-confirm').props.onChange({target:{value:repeat}});render();};
fill('old-password-phrase','new-password-phrase','new-password-phrasX');
check(fieldOf('account-new-password-confirm').props.error,de('password.mismatch'),'a different repetition shows under Repeat new password');
ok(openDrawer().props.dirty,'the input makes the drawer dirty');
fill('old-password-phrase','new-password-phrase','new-password-phrase');
submit('account-password-form');render();
ok(typeof confirmed==='function'&&!openDrawer()&&requests.length===0,'submit opens the step-up and sends nothing yet');
cancelled();render();
ok(openDrawer()&&byId('account-current-password').props.value==='old-password-phrase'&&byId('account-new-password-confirm').props.value==='new-password-phrase','a cancelled step-up returns to the drawer with the input kept');
submit('account-password-form');render();confirmed({managementToken:'password-proof'});await harness.settle();render();
check(sent('password-change')[0].body,{action:'password-change',currentPassword:'old-password-phrase',newPassword:'new-password-phrase',managementToken:'password-proof'},'the change carries the proof');
check(navigations,['/'],'success replaces the location with /');
// A blocked password change stays visible with its reason.
await start(PasswordSettings,{viewer,blocked:de('account.blocked.confirm'),onConfirmIdentity(){}});
check(button(de('password.change')).props.blocked,de('account.blocked.confirm'),'Change password is blocked with a sentence');

// ---- Passkeys: Add passkey Drawer, step-up first, then the ceremony on the next submit ----
const keyProps={mfaEnabled:true,reloadKey:0,onConfirmIdentity:next=>{continuation=next;}};
const take=()=>{const next=continuation;continuation=null;return next;};
const addSubmit=()=>find(node=>node.props?.form==='passkey-add-form');
await start(PasskeysPanel,keyProps);
button(de('passkeys.add')).props.onClick();render();
open=openDrawer();
check([open.props.title,open.props.description],[de('passkeys.add'),de('passkeys.addIntro')],'a Drawer "Add passkey"');
const picks=harness.walk(tree).filter(node=>node.props?.onSelect&&'selected' in node.props);
check(picks.map(node=>[node.props.label,node.props.selected]),[[de('passkeys.thisDevice'),true],[de('passkeys.device.phone'),false]],'a radio PickList: This device / Smartphone');
check(byId('passkey-name').props.value,'Windows Hello','the default name');
picks[1].props.onSelect();render();
check(byId('passkey-name').props.value,de('passkeys.defaultPhoneName'),'Smartphone: "Mein Smartphone"');
ok(harness.text(openDrawer()).includes(de('passkeys.phoneInstruction')),'the instruction of the chosen location');
harness.walk(tree).filter(node=>node.props?.onSelect&&'selected' in node.props)[0].props.onSelect();render();
check([harness.text(addSubmit()),addSubmit().props.variant],[de('passkeys.add'),'primary'],'the primary reads Add passkey');
submit('passkey-add-form');render();
ok(registrations.length===0&&typeof continuation==='function'&&!openDrawer(),'without a fresh grant the submit opens the step-up first');
take()(proof);render();
ok(openDrawer()&&harness.text(openDrawer()).includes(de('passkeys.identityConfirmed')),'after the proof the drawer is open again with "Identity confirmed"');
check(registrations.length,0,'the ceremony does not start by itself');
submit('passkey-add-form');await harness.settle();render();
check([registrations.length,registrations[0][0],registrations[0][1],registrations[0][3]],[1,'Windows Hello','local',proof.managementToken],'the same submit starts the WebAuthn ceremony with the one-use grant');
check(toasts(),[de('passkeys.saved')],'Passkey saved. is a toast');ok(!openDrawer(),'the drawer closes');
// While the ceremony runs: loading primary and the status line.
await start(PasskeysPanel,keyProps);
button(de('passkeys.add')).props.onClick();render();submit('passkey-add-form');take()(proof);render();
submit('passkey-add-form');render();
ok(addSubmit().props.loading===true&&harness.text(openDrawer()).includes(de('passkeys.confirmInBrowser')),'a running ceremony: the submit is loading and the status line says to confirm in the browser dialog');
await harness.settle();toasts();
// A step-up code during the ceremony asks again; only a new click restarts it.
await start(PasskeysPanel,keyProps);registerFailures=[failing('MFA_STEP_UP_REQUIRED')];
button(de('passkeys.add')).props.onClick();render();submit('passkey-add-form');take()(proof);render();submit('passkey-add-form');await harness.settle();render();
ok(registrations.length===1&&typeof continuation==='function'&&!openDrawer(),'a step-up code closes the drawer and asks for identity again');
take()(proof2);render();ok(openDrawer(),'the new proof reopens the drawer');check(registrations.length,1,'no restart by itself');
submit('passkey-add-form');await harness.settle();check([registrations.length,registrations[1][3]],[2,proof2.managementToken],'the second ceremony uses the new grant');toasts();
// A proof without a usable grant shows the existing text; other codes show in the drawer.
await start(PasskeysPanel,keyProps);registerFailures=[failing('MFA_LOGIN_REQUIRED')];
button(de('passkeys.add')).props.onClick();render();submit('passkey-add-form');take()(proof);render();submit('passkey-add-form');await harness.settle();take()({managementToken:'no-expiry'});render();
ok(!openDrawer(),'no drawer without a grant');check(toasts(),['error:'+de('mfa.missingProof')],'the missing proof is an error toast');
await start(PasskeysPanel,keyProps);registerFailures=[failing('MFA_SETUP_REQUIRED')];
button(de('passkeys.add')).props.onClick();render();submit('passkey-add-form');take()(proof);render();submit('passkey-add-form');await harness.settle();render();
ok(continuation===null&&openDrawer(),'MFA_SETUP_REQUIRED does not ask for identity');
const danger=find(node=>node.props?.tone==='danger'&&harness.text(node).includes('Server text for MFA_SETUP_REQUIRED'));ok(danger,'the ceremony error is a danger Notice in the drawer');
// A stale continuation does nothing.
await start(PasskeysPanel,keyProps);
button(de('passkeys.add')).props.onClick();render();submit('passkey-add-form');const stale=take();render();button(de('passkeys.add')).props.onClick();render();openDrawer().props.onClose();render();stale(proof2);render();
ok(!openDrawer()&&registrations.length===0,'a stale add proof does not reopen the drawer');

// ---- Passkeys: rename Drawer and removal through the ConfirmDialog ----
const keyEntry=id=>harness.menu(tree,de('account.rowActions',{name:'Laptop'})).find(entry=>entry.id===id);
await start(PasskeysPanel,keyProps);
keyEntry('rename').onSelect();render();
check([openDrawer().props.title,harness.text(find(node=>node.props?.form==='passkey-rename-form'))],[de('passkeys.renameTitle'),de('passkeys.rename')],'Rename passkey: a Drawer with the verb Rename');
ok(byId('passkey-edited-name').props.autoFocus,'its Name field takes the focus');
check(find(node=>node.props?.form==='passkey-rename-form').props.blocked,de('common.noChanges'),'Rename passkey is blocked while the name is unchanged');
submit('passkey-rename-form');await harness.settle();render();
check(sent('rename').length,0,'an unchanged passkey name sends nothing');
byId('passkey-edited-name').props.onChange({target:{value:'  Büro  '}});render();submit('passkey-rename-form');await harness.settle();render();
check(sent('rename').map(request=>request.body),[{action:'rename',id:'key',name:'Büro'}],'rename sends the trimmed name');check(toasts(),[de('passkeys.renamed')],'rename toasts');
// A step-up code on rename asks once and resends the same name.
await start(PasskeysPanel,keyProps);apiFailures=[failing('MFA_LOGIN_REQUIRED')];
keyEntry('rename').onSelect();render();byId('passkey-edited-name').props.onChange({target:{value:'Büro'}});render();submit('passkey-rename-form');await harness.settle();render();
ok(typeof continuation==='function'&&!openDrawer(),'a login code on rename asks for identity again');
take()({});await harness.settle();check(sent('rename').length,2,'exactly one more rename');check(toasts(),[de('passkeys.renamed')],'then the toast');
// Codes that are no step-up show their message in the rename drawer.
await start(PasskeysPanel,keyProps);apiFailures=[failing('VALIDATION_FAILED',400)];
keyEntry('rename').onSelect();render();byId('passkey-edited-name').props.onChange({target:{value:'Büro'}});render();submit('passkey-rename-form');await harness.settle();render();
ok(continuation===null&&find(node=>node.props?.tone==='danger'&&harness.text(node).includes('Server text for VALIDATION_FAILED')),'a refused rename shows a danger Notice in the drawer');
// Remove: ConfirmDialog danger, then the step-up, then the delete with the proof.
await start(PasskeysPanel,keyProps);
keyEntry('remove').onSelect();render();dialog=confirm();
check([dialog.props.tone,dialog.props.title,dialog.props.confirmLabel,dialog.props.lines,dialog.props.body],['danger',de('passkeys.removeTitle'),de('passkeys.remove'),[{label:de('common.name'),value:'Laptop'}],de('passkeys.removeIntro',{name:'Laptop'})],'Remove passkey? with the name, the consequence and the verb');
ok(harness.text(dialog).includes(de('passkeys.lastPasskey')),'the last passkey next to an authenticator gets its note');
dialog.props.onConfirm();render();check(requests.length,0,'removal waits for a fresh proof');ok(!confirm()&&typeof continuation==='function','the step-up follows the confirmation');
take()(proof);await harness.settle();check(sent('delete')[0].body,{action:'delete',id:'key',managementToken:proof.managementToken},'delete with the proof');check(toasts(),[de('passkeys.removed')],'removal toasts');
// A delete that hits a step-up code resends exactly once with the new token; a second code only shows the message.
await start(PasskeysPanel,keyProps);apiFailures=[failing('MFA_STEP_UP_REQUIRED'),failing('MFA_STEP_UP_REQUIRED')];
keyEntry('remove').onSelect();render();confirm().props.onConfirm();take()(proof);await harness.settle();take()(proof2);await harness.settle();
check([sent('delete').length,sent('delete')[1].body.managementToken,continuation],[2,proof2.managementToken,null],'one resend with the new token, no second prompt');check(toasts(),['error:Server text for MFA_STEP_UP_REQUIRED'],'the second refusal is an error toast');
// The last factor cannot be removed.
await start(PasskeysPanel,keyProps,{0:{...keyStatus,authenticatorCount:0},1:false});
check(keyEntry('remove').blocked,de('passkeys.lastFactor'),'remove on the last factor is blocked with its sentence');

// ---- The console refresh (frame.refresh, ui/shell/page-frame.ts) loads /api/mfa again; the loaded methods stay shown ----
{
 const frame=refresh=>({header:()=>null,refresh,tab:'',onTab(){}});
 await start(SignInSecurityCard,{viewer,frame:frame(0)},{7:false});
 check(requests.filter(request=>request.url==='/api/mfa'&&!request.body).length,0,'no second load on mount');
 mfaStatus=new Promise(()=>{});
 props={viewer,frame:frame(1)};render();await harness.flush();render();
 check(requests.filter(request=>request.url==='/api/mfa'&&!request.body).length,1,'a refresh change loads /api/mfa once');
 ok(harness.text(tree).includes('Phone')&&!find(node=>node.props?.variant==='facts'&&node.props?.label),'while it runs the loaded methods stay shown, no Skeleton');
 render();await harness.flush();render();
 check(requests.filter(request=>request.url==='/api/mfa'&&!request.body).length,1,'the same count loads nothing more');
 mfaStatus=status;
}

console.log(`PASS account security actions (${checks} checks): password, authenticator and passkey flows on Drawer and ConfirmDialog wait for fresh MFA and forward its one-use proof, keep the WebAuthn gesture, cancel pending challenges, show recovery codes with CopyValue, and confirm with toasts.`);
