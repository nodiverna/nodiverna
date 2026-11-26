// The step-up dialog (ui/session/mfa-step-up.tsx) on kit parts: a radix Dialog in the kit dialog look, the
// passkey choice as kit Btns, the code as a Field-bound input, errors as a danger Notice and the
// footer Btns with loading and blocked reasons. The step-up logic stays: the verify payloads for an
// authenticator code, a recovery code and a passkey, onVerified with the proof, onClose, and the
// server's notice in the error slot. The dialog runs on hook cells (tests/support/panel-harness.mjs),
// in German.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {panelHarness} from '../../support/panel-harness.mjs';

let posts=[],passkeyStatus=null,verifyFailure=null,ceremonies=[],checks=0;
const proof={managementToken:'proof-1',managementExpiresAt:1};
const harness=panelHarness({hooked:['ui/session/mfa-step-up.tsx'],stubs:{
 '@/ui/base/api':{message:error=>error.message,api:async(url,body,signal)=>{if(!body){assert.equal(url,'/api/passkeys');return passkeyStatus;}posts.push({url,body,signal:!!signal});if(verifyFailure)throw verifyFailure;return proof;}},
 '@/ui/session/passkey-client':{passkeySupportProblem:()=>null,passkeyError:error=>error.message,authenticatePasskey:async(device,signal)=>{ceremonies.push([device,signal instanceof AbortSignal]);return proof;}},
 '@/ui/session/identity-source':{identitySource:()=>'local'},
 '@/ui/session/entra-confirm':{useEntraConfirm:()=>({waiting:false,error:'',start(){},cancel(){},setError(){}})},
}});
const {MfaStepUp}=harness.load('ui/session/mfa-step-up.tsx');
let verified=[],closed=0;
const props=extra=>({open:true,onClose:()=>closed++,onVerified:value=>verified.push(value),...extra});
async function open(status,extra={}){
 harness.reset();posts=[];ceremonies=[];verified=[];closed=0;verifyFailure=null;passkeyStatus=status;
 harness.tree(MfaStepUp,props(extra));await harness.flush();return harness.tree(MfaStepUp,props(extra));
}
const rerender=(extra={})=>harness.tree(MfaStepUp,props(extra));
const field=tree=>harness.find(tree,item=>item.props.children?.props?.id==='v3-stepup'&&'label' in item.props);
const type=(tree,value)=>field(tree).props.children.props.onChange({target:{value}});
const confirm=tree=>harness.button(tree,'Bestätigen');

// Source: kit parts only, nothing of shadcn, ErrorNote or the classic passkey panel.
const source=fs.readFileSync('ui/session/mfa-step-up.tsx','utf8');
assert.doesNotMatch(source,/@\/components\/ui\/|<Button\b|<Input\b|ErrorNote|passkeys-panel|sd-mfa-dialog/,'no shadcn control, no ErrorNote, no classic passkey choice');
assert.match(source,/import \{Dialog\} from '@\/ui\/kit\/confirm-dialog';/,'the kit Dialog (radix inside), no local StepUpDialog');assert.doesNotMatch(source,/function StepUpDialog/);assert.match(source,/<Field label=/);
assert.doesNotMatch(fs.readFileSync('ui/account/account-panel.tsx','utf8'),/function MfaStepUp|function EntraStepUp|@\/components\/ui\/dialog'[^\n]*\n[^\n]*MfaStepUp/,'the account page no longer holds the step-up dialog');checks+=4;

// An authenticator account: the code field, the blocked confirm until 6 digits, then the unchanged payload.
let tree=await open({available:true,count:0,authenticatorCount:1});
assert.equal(posts.length,0,'nothing is sent on open');
assert.equal(harness.text(field(tree).props.label)||field(tree).props.label,'Authenticator-Code');
assert.equal(confirm(tree).props.variant,'primary');
assert.equal(confirm(tree).props.blocked,'Gib zuerst den 6-stelligen Code aus deinem Authenticator ein.','the confirm stays focusable and names what is missing');
type(tree,'12345');tree=rerender();assert.ok(confirm(tree).props.blocked,'5 digits are not enough');
type(tree,'123456');tree=rerender();assert.equal(confirm(tree).props.blocked,undefined);
confirm(tree).props.onClick();tree=rerender();assert.equal(confirm(tree).props.loading,true,'the confirm shows its spinner while the check runs');
await harness.settle();
assert.deepEqual(posts,[{url:'/api/mfa',body:{action:'verify',code:'123456'},signal:true}],'TOTP: the verify payload is unchanged');
assert.deepEqual([verified,closed],[[proof],1],'the proof reaches onVerified and the dialog closes');checks+=9;

// The recovery code: the toggle, the label, the payload.
tree=await open({available:true,count:0,authenticatorCount:1});
harness.button(tree,'Wiederherstellungscode verwenden').props.onClick();tree=rerender();
assert.equal(field(tree).props.label,'Wiederherstellungscode');
assert.equal(confirm(tree).props.blocked,'Gib zuerst einen Wiederherstellungscode ein.');
type(tree,'AAAA-BBBB');tree=rerender();confirm(tree).props.onClick();await harness.settle();
assert.deepEqual(posts.map(post=>post.body),[{action:'verify',recoveryCode:'AAAA-BBBB'}],'recovery: the verify payload is unchanged');
assert.equal(verified.length,1);checks+=4;
// A passkey-only account has no toggle: the recovery code is its only code.
tree=await open({available:true,count:1,authenticatorCount:0});
assert.equal(harness.button(tree,'Authenticator verwenden'),undefined);assert.equal(harness.button(tree,'Wiederherstellungscode verwenden'),undefined);
assert.equal(field(tree).props.label,'Wiederherstellungscode');checks+=3;

// The passkey: the kit choice, the ceremony with the same arguments, the proof.
tree=await open({available:true,count:1,authenticatorCount:1});
const choice=harness.find(tree,item=>typeof item.props.onSelect==='function'&&'pending' in item.props);
assert.ok(choice,'the passkey choice shows for an account with a passkey');assert.equal(choice.props.divider,'oder Authenticator-Code');
choice.props.onSelect('local');tree=rerender();
assert.equal(confirm(tree).props.loading,false,'the code confirm does not spin during the passkey ceremony');assert.equal(confirm(tree).props.disabled,true);
await harness.settle();
assert.deepEqual(ceremonies,[['local',true]],'passkey: the ceremony gets the device and the abort signal');
assert.deepEqual([posts.length,verified,closed],[0,[proof],1],'the passkey proof reaches onVerified without a code request');checks+=6;
const passkeyHtml=harness.html(MfaStepUp,props());
assert.match(passkeyHtml,/Mit Passkey bestätigen/);assert.match(passkeyHtml,/Dieses Gerät \/ Windows Hello/);assert.match(passkeyHtml,/class="sdx-btn sdx-btn-secondary"/);checks+=3;

// Errors: the server's notice, then the own verify error, as a danger Notice (role=alert).
const expired='Die Bestätigung ist abgelaufen oder wurde bereits verwendet. Bestätige erneut.';
tree=await open({available:true,count:0,authenticatorCount:1},{notice:expired});
let html=harness.html(MfaStepUp,props({notice:expired}));
assert.match(html,new RegExp(`class="sdx-notice sdx-notice-danger" role="alert">.*${expired}`),'the notice shows in the danger Notice');
verifyFailure=new Error('Der Code ist ungültig. Versuche es erneut.');
type(tree,'654321');tree=rerender({notice:expired});confirm(tree).props.onClick();await harness.settle();
html=harness.html(MfaStepUp,props({notice:expired}));
assert.match(html,/role="alert">.*Der Code ist ungültig\. Versuche es erneut\./,'the own error replaces the notice');assert.doesNotMatch(html,new RegExp(expired));
assert.deepEqual([verified.length,closed],[0,0],'a refused code keeps the dialog open');checks+=4;

// The markup: the kit dialog look, a bound label, kit buttons only, Cancel before the confirm.
tree=await open({available:false,count:0,authenticatorCount:1});
html=harness.html(MfaStepUp,props());
assert.match(html,/class="sdx-layer sdx-confirm-dialog sdx-stepup"/);assert.match(html,/<h2[^>]*class="sdx-confirm-title"[^>]*>Identität bestätigen<\/h2>/);
assert.match(html,/<label class="sdx-field-label" for="v3-stepup">Authenticator-Code<\/label>/,'the label is bound to the code input');
assert.doesNotMatch(html,/data-slot="button"|data-slot="input"|data-slot="dialog|notice danger v3-note|text-button/,'no shadcn part, no ErrorNote, no text button');
assert.match(html,/>Abbrechen<.*>Bestätigen</,'Cancel leads, the confirm verb trails');
assert.match(html,/class="sdx-btn sdx-btn-primary" aria-disabled="true"/,'the empty code blocks the confirm, which stays focusable');checks+=6;
// Cancel closes through onClose and sends nothing.
harness.button(harness.tree(MfaStepUp,props()),'Abbrechen').props.onClick();
assert.deepEqual([closed,posts.length],[1,0],'Cancel closes and sends nothing');checks++;

console.log(`PASS mfa step-up kit (${checks} checks): kit dialog, Field-bound code, passkey Btns, danger Notice; unchanged TOTP, recovery and passkey payloads, onVerified, notice and Cancel.`);
