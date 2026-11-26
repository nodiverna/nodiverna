// The step-up flow of ui/session/step-up-retry.ts without a DOM: stepUpController (the pure core of useStepUp)
// driven with a fake send that resolves, rejects with an ApiError whose code opens the MFA prompt, or
// rejects with another error, and with fake verified/cancel calls. It checks the payloads sent (the
// token is replaced), the dialog state and notices, the reports, the resolved values, the one-request
// guard and that nothing happens after dispose (unmount). Then the hook's module boundary.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {stepUpController,useStepUp}=await import('../../../ui/session/step-up-retry.ts');
const {ApiError}=await import('../../../ui/base/http.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const settle=async()=>{for(let index=0;index<8;index++)await new Promise(resolve=>setImmediate(resolve));};
const stepUpError=(text='Confirm the change.')=>new ApiError(text,403,'MFA_STEP_UP_REQUIRED');

/** A controller with recorded sends, reports and states; reply decides each answer. */
function setup({critical=()=>false,reply=()=>({ok:true}),onError,locale='en'}={}){
 const sent=[],reports=[],states=[];
 const controller=stepUpController({
  send:async payload=>{sent.push(payload);return reply(payload,sent.length);},
  needsStepUp:critical,onError,
  report:text=>reports.push(text),
  describe:failure=>failure instanceof Error?failure.message:String(failure),
  locale:()=>locale,
  onState:state=>states.push(state),
 });
 return {controller,sent,reports,states,last:()=>controller.state()};
}

// a. A critical payload opens the dialog first; any other goes out at once.
{
 const ui=setup({critical:payload=>payload.action==='delete-group'});
 const routine=ui.controller.run({action:'rename-group',name:'N'});
 check([ui.sent,ui.last()],[[{action:'rename-group',name:'N'}],{open:false,notice:'',sending:true}],'a: a routine payload is sent at once (sending)');
 check(await routine,{ok:true},'a: it resolves with the result');
 check(ui.last(),{open:false,notice:'',sending:false},'a: idle again');
 const critical=ui.controller.run({action:'delete-group',id:'g1'});
 check([ui.sent.length,ui.last().open,ui.last().notice],[1,true,''],'a: a critical payload opens the dialog before any request');
 ui.controller.verified({managementToken:'proof-1'});
 check(await critical,{ok:true},'a: the proof sends it');
 check(ui.sent.at(-1),{action:'delete-group',id:'g1',managementToken:'proof-1'},'a: with the managementToken');
}
// b. A reply whose code opens the MFA prompt opens the dialog; the proof resends the same payload once, an old token replaced.
{
 const ui=setup({reply:payload=>{if(payload.managementToken!=='new')throw stepUpError();return {ok:true};}});
 const run=ui.controller.run({action:'assign-device',ids:['a'],managementToken:'old'});
 await settle();
 check([ui.last().open,ui.sent.length],[true,1],'b: MFA_STEP_UP_REQUIRED opens the dialog');
 ui.controller.verified({managementToken:'new'});ui.controller.cancel();
 check(await run,{ok:true},'b: onVerified (then onClose, as MfaStepUp calls them) resends and resolves');
 check(ui.sent,[{action:'assign-device',ids:['a'],managementToken:'old'},{action:'assign-device',ids:['a'],managementToken:'new'}],'b: the same payload once more, the old token replaced (stepUpRetry)');
 check(ui.reports,[],'b: nothing reported');
}
// c. A refused request that already carried a token reopens the dialog with the server's message.
{
 const ui=setup({critical:()=>true,reply:()=>{throw stepUpError('The confirmation expired. Confirm again.');}});
 const run=ui.controller.run({action:'delete-group',id:'g1'});
 check(ui.last().notice,'','c: the first dialog has no notice');
 ui.controller.verified({managementToken:'p1'});await settle();
 check([ui.last().open,ui.last().notice],[true,'The confirmation expired. Confirm again.'],'c: the refused resend reopens the dialog with the server message');
 ui.controller.cancel();
 check([await run,ui.last()],[null,{open:false,notice:'',sending:false}],'c: cancel clears the notice and resolves null');
}
// d. Cancelling sends nothing and resolves null.
{
 const ui=setup({critical:()=>true});
 const run=ui.controller.run({action:'delete-group'});ui.controller.cancel();
 check([await run,ui.sent,ui.reports],[null,[],[]],'d: cancel sends nothing, reports nothing, resolves null');
}
// e. A proof without a token sends nothing, reports mfa.missingProof in the viewer's locale and resolves null.
for(const locale of ['en','de']){
 const ui=setup({critical:()=>true,locale});
 const run=ui.controller.run({action:'delete-group'});ui.controller.verified({});
 check([await run,ui.sent,ui.reports],[null,[],[translate(locale,'mfa.missingProof')]],`e: no token: nothing sent, mfa.missingProof (${locale})`);
}
// f. Other errors are reported unless onError handles them; both resolve null.
{
 const conflict=new ApiError('The group was changed elsewhere.',409,'CONFLICT');
 let ui=setup({reply:()=>{throw conflict;}});
 check([await ui.controller.run({action:'save'}),ui.reports,ui.last().open],[null,['The group was changed elsewhere.'],false],'f: another error: toast.error(message), null, no dialog');
 const handled=[];
 ui=setup({reply:()=>{throw conflict;},onError:(failure,payload)=>{handled.push([failure,payload.action]);return true;}});
 check([await ui.controller.run({action:'save'}),ui.reports,handled],[null,[],[[conflict,'save']]],'f: onError returning true takes it: no report, null');
 ui=setup({reply:()=>{throw new ApiError('MFA confirmation failed',409);}});
 check([await ui.controller.run({action:'save'}),ui.last().open],[null,false],'f: the message text alone never opens the dialog (only the code does)');
}
// g. A run while a request or the dialog is pending resolves null at once and sends nothing.
{
 let release;const ui=setup({reply:()=>new Promise(resolve=>{release=resolve;})});
 const first=ui.controller.run({action:'one'});
 check([await ui.controller.run({action:'two'}),ui.sent.length],[null,1],'g: while a request is out, a second run resolves null and sends nothing');
 release({ok:1});check(await first,{ok:1},'g: the first one finishes');
 const dialog=setup({critical:()=>true});
 const waiting=dialog.controller.run({action:'a'});
 check([await dialog.controller.run({action:'b'}),dialog.sent.length],[null,0],'g: while the dialog waits, a run resolves null');
 dialog.controller.cancel();await waiting;
}
// h. A result after unmount sets no state and resolves null.
{
 let release;const ui=setup({reply:()=>new Promise(resolve=>{release=resolve;})});
 const run=ui.controller.run({action:'save'});const before=ui.states.length;
 ui.controller.dispose();release({ok:true});
 check([await run,ui.states.length],[null,before],'h: after dispose the result sets no state and resolves null');
 let fail;const failing=setup({reply:()=>new Promise((_resolve,reject)=>{fail=reject;})});
 const refused=failing.controller.run({action:'save'});failing.controller.dispose();fail(stepUpError());
 check([await refused,failing.controller.state().open,failing.reports],[null,false,[]],'h: a late refusal opens no dialog and reports nothing');
}

// The module: React and the controller, not the dialog; the two callers are built on it.
{
 check(typeof useStepUp,'function','useStepUp is exported');
 const source=readFileSync('ui/session/step-up-retry.ts','utf8');
 check([/from 'react'/.test(source),/mfa-step-up/.test(source)],[true,false],'step-up-retry.ts imports React but not MfaStepUp');
 const groups=readFileSync('ui/devices/fleet/groups.tsx','utf8'),entra=readFileSync('ui/settings/entra-settings-panel.tsx','utf8');
 check([/useStepUp<AccessRequest,AccessResult>\(/.test(groups),/return \{run,busy:change\.busy,prompt:<MfaStepUp \{\.\.\.change\.dialog\}\/>\};/.test(groups)],[true,true],'useAccessChange is built on useStepUp and keeps {run,busy,prompt}');
 check([/useStepUp<EntraRequest,EntraView>\(/.test(entra),/return \{busy:change\.sending\?action:null,dispatch,dialog:<MfaStepUp \{\.\.\.change\.dialog\}\/>\};/.test(entra),/opensMfaPrompt|stepUpRetry/.test(entra)],[true,true,false],'useEntraChange is built on useStepUp, keeps {busy,dispatch,dialog} (no demo lock) and has no own step-up logic');
}

console.log(`PASS use step-up (${checks} checks): the controller of useStepUp: dialog first for critical payloads, the code-driven prompt with one resend and the token replaced, the notice after a refused proof, cancel, the missing proof, other errors and onError, the one-request guard and no state after unmount; the module boundary and both callers.`);
