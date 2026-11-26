// Device removal in the console: offline, unregistered and read-only devices, the blocked states, the exact
// confirmation and the uninstall limits.
import {serverText} from '../../support/server-text.mjs';
import '../../support/register.mjs';
import '../../support/german-default.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {de} from '../../support/i18n-stubs.mjs';
const removal=await import('../../../ui/devices/device/device-removal.tsx');
const {deviceRemovalConfirmation,bulkDeviceRemovalConfirmation,canRemoveDevices}=removal;
// The classic DeviceRemoval button is deleted: the device header Menu and the fleet bulk bar open the removal.
assert.equal(removal.default,undefined,'the classic DeviceRemoval default export is gone');
assert.doesNotMatch(fs.readFileSync('ui/devices/device/device-removal.tsx','utf8'),/@\/components\/ui\//,'the removal module imports no shadcn part');
const admin={id:'owner',label:'owner@test.example',permissions:['*']};
const device={id:'00000000-0000-4000-8000-000000000001',name:'OFFLINE-SRV',createdAt:1,lastSeen:null,revoked:0,management:0,snapshot:null};
const confirmation=deviceRemovalConfirmation(device);
assert.deepEqual(confirmation.payload,{action:'remove-server',id:device.id,confirm:true});
assert.match(confirmation.description,/auch wenn es offline ist/);assert.match(confirmation.description,/schon laufen, können noch/);assert.doesNotMatch(confirmation.description,/ServerDesk\.Agent\.exe/,'the uninstall command is only in the "cannot uninstall itself" hint');assert.doesNotMatch(confirmation.description,/Uninstall-ServerDesk\.ps1/);
// One name from the button to the dialog, the device as a fact, the kit danger tone.
assert.equal(confirmation.confirmLabel,'Gerät entfernen');assert.equal(confirmation.tone,'danger');
assert.deepEqual(confirmation.lines,[{label:'Gerät',value:'OFFLINE-SRV'}]);
assert.equal(confirmation.uninstall.confirmLabel,'Deinstallieren und entfernen');
assert.equal(deviceRemovalConfirmation(device,'en').confirmLabel,'Remove device');assert.deepEqual(deviceRemovalConfirmation(device,'en').lines,[{label:'Device',value:'OFFLINE-SRV'}]);
assert.equal(deviceRemovalConfirmation(device,'en').uninstall.confirmLabel,'Uninstall and remove');
assert.match(deviceRemovalConfirmation(device).title,/OFFLINE-SRV/);
assert.equal(canRemoveDevices(admin),true);
for(const permissions of [[],['view','update','manage'],undefined])assert.equal(canRemoveDevices({...admin,permissions}),false);
const other={id:'00000000-0000-4000-8000-000000000002',name:'LAB-SRV'};
const bulk=bulkDeviceRemovalConfirmation([device,other,device]);
assert.deepEqual(bulk.payload,{action:'remove-servers',ids:[device.id,other.id],confirm:true});
assert.match(bulk.title,/2 Geräte/);assert.doesNotMatch(bulk.description,/OFFLINE-SRV|LAB-SRV/,'the names are in the lines, not in the description');assert.match(bulk.description,/entfernt Nodiverna keines davon/);assert.doesNotMatch(bulk.description,/ServerDesk\.Agent\.exe/);
assert.equal(bulk.confirmLabel,'2 Geräte entfernen');assert.equal(bulk.tone,'danger');assert.deepEqual(bulk.lines,[{label:'Geräte',value:'OFFLINE-SRV, LAB-SRV'}]);
assert.doesNotMatch(bulk.uninstall.description,/OFFLINE-SRV|LAB-SRV/);assert.equal(bulk.uninstall.confirmLabel,'Deinstallieren und entfernen');
assert.equal(bulkDeviceRemovalConfirmation([device,other],'en').confirmLabel,'Remove 2 devices');assert.equal(bulkDeviceRemovalConfirmation([device],'en').confirmLabel,'Remove device');assert.equal(bulkDeviceRemovalConfirmation([device],'de').confirmLabel,'Gerät entfernen');
// ServerDesk.Agent.exe --uninstall appears exactly once in the whole dialog: in the "cannot uninstall itself" hint.
for(const locale of ['de','en']){const hint=deviceRemovalConfirmation({...device,snapshot:{mode:'ReadOnly'}},locale).uninstall;assert.equal(hint.hint.split('ServerDesk.Agent.exe --uninstall').length-1,1,locale+': once in the hint');
 for(const text of [deviceRemovalConfirmation(device,locale).description,hint.description,bulkDeviceRemovalConfirmation([device,other],locale).description,bulkDeviceRemovalConfirmation([device,other],locale).uninstall.description])assert.doesNotMatch(text,/ServerDesk\.Agent\.exe/);}
assert.throws(()=>bulkDeviceRemovalConfirmation([]),/1 bis 100/);
assert.throws(()=>bulkDeviceRemovalConfirmation(Array.from({length:101},(_,index)=>({id:String(index),name:String(index)}))),/1 bis 100/);
// Removal needs a fresh step-up proof (lib/step-up.ts). The console
// uses these helpers: the dialog opens before anything is sent, the verified
// proof goes out once with the payload, MFA_STEP_UP_REQUIRED (by code) reopens.
const {removalNeedsStepUp,removalProofRejected,removalProofRetry,missingProofMessage}=await import('../../../ui/devices/device/device-removal.tsx');
const {ApiError}=await import('../../../ui/base/http.ts');
assert.equal(missingProofMessage,'Nodiverna konnte deine Identität nicht bestätigen. Versuche es erneut.');
for(const payload of [confirmation.payload,bulk.payload])assert.equal(removalNeedsStepUp(payload),true,payload.action+' asks for the step-up first');
assert.equal(removalNeedsStepUp({...bulk.payload,managementToken:'proof'}),false,'a payload with its proof is sent');
for(const payload of [{action:'job',serverId:device.id},{action:'cancel-job',id:'x'},{action:'enroll',name:'X'},{action:['revoke','server'].join('-'),id:device.id}])assert.equal(removalNeedsStepUp(payload),false,payload.action+' is no removal');
assert.equal(removalProofRejected(new ApiError('Die Bestätigung ist abgelaufen oder bereits verwendet.',403,'MFA_STEP_UP_REQUIRED')),true);
assert.equal(removalProofRejected(new ApiError(serverText('apiError.mfa.loginRequired'),403,'MFA_LOGIN_REQUIRED')),true);
assert.equal(removalProofRejected(new ApiError('MFA Bestätigung erforderlich',403)),false,'the message text alone never reopens the dialog');
assert.equal(removalProofRejected(new Error('MFA Bestätigung')),false);
const sent=[],reports=[],retry=removalProofRetry({...bulk.payload,managementToken:'used'},payload=>{sent.push(payload);},message=>reports.push(message));
retry({});assert.deepEqual([sent,reports],[[],[missingProofMessage]],'a proof without managementToken sends nothing');
retry({managementToken:'fresh'});assert.deepEqual(sent,[{action:'remove-servers',ids:[device.id,other.id],confirm:true,managementToken:'fresh'}],'the payload goes out once with the new proof');
// The console's action runs in ui/shell/console-action.ts. It is
// driven here with fakes for every dependency: no network, DOM or console render.
{
 const {runConsoleAction}=await import('../../../ui/shell/console-action.ts');
 // The toast shows the catalog text of the sent key in the page language (German here).
 const expired=de('apiError.mfa.proofExpired');
 const reply=(status,body)=>Response.json(body,{status});
 function fakeConsole({demo=false,allowed=true,replies=[]}={}){
  const state={posts:[],toasts:[],saving:[],opened:[],removed:[],refreshes:0,allowed};
  const deps={demo,canOffboard:()=>state.allowed,
   post:async payload=>{state.posts.push(payload);const next=replies.shift();assert.ok(next,'unexpected POST '+JSON.stringify(payload));return typeof next==='function'?next():next;},
   openStepUp:retry=>{state.opened.push(retry);},toast:{success:message=>state.toasts.push(message),error:message=>state.toasts.push('error:'+message)},
   onRemoved:ids=>state.removed.push(ids),refresh:()=>{state.refreshes++;},setSaving:value=>state.saving.push(value),action:payload=>runConsoleAction(payload,deps)};
  return {state,run:payload=>runConsoleAction(payload,deps),retry:()=>state.opened.at(-1)};
 }
 const single=confirmation.payload,many=bulk.payload;
 // Demo mode sends nothing, for removals and jobs.
 for(const payload of [single,{...single,managementToken:'t1'},{action:'job',id:device.id,kind:'refresh'}]){const ui=fakeConsole({demo:true});await ui.run(payload);assert.deepEqual([ui.state.posts,ui.state.opened,ui.state.toasts,ui.state.saving],[[],[],[],[]],'demo: nothing happens for '+payload.action);}
 // Without the offboard right: one error toast, nothing sent, no dialog.
 {const ui=fakeConsole({allowed:false});await ui.run(single);assert.deepEqual([ui.state.toasts,ui.state.posts,ui.state.opened.length],[['error:'+de('console.noRemoveRight')],[],0]);}
 for(const [payload,success] of [[single,de('console.deviceRemoved')],[many,de('console.devicesRemoved',{count:2})]]){
  const ui=fakeConsole({replies:[reply(200,{ok:true})]});
  // Removal without a token: the dialog opens first, nothing is sent, saving stays off.
  await ui.run(payload);assert.equal(ui.state.opened.length,1,payload.action+': the step-up opens first');assert.deepEqual([ui.state.posts,ui.state.saving,ui.state.toasts],[[],[],[]],payload.action+': nothing is sent before the proof');
  // A proof without token sends nothing and reports.
  await ui.retry()({});assert.deepEqual([ui.state.posts,ui.state.toasts],[[],['error:'+missingProofMessage]],payload.action+': a proof without token sends nothing');ui.state.toasts.length=0;
  // With t1: one POST, saving true then false, success toast, success callback, one refresh.
  await ui.retry()({managementToken:'t1'});
  assert.deepEqual(ui.state.posts,[{...payload,managementToken:'t1'}],payload.action+': one POST with the proof');
  assert.deepEqual(ui.state.saving,[true,false]);assert.deepEqual(ui.state.toasts,[success]);assert.deepEqual(ui.state.removed,[payload.ids??[payload.id]]);assert.equal(ui.state.refreshes,1);assert.equal(ui.state.opened.length,1,'no second dialog');
 }
 // MFA_STEP_UP_REQUIRED: the server text as toast, the dialog again, the next proof replaces t1, one more POST.
 {
  const ui=fakeConsole({replies:[reply(403,{error:expired,code:'MFA_STEP_UP_REQUIRED',messageKey:'apiError.mfa.proofExpired'}),reply(200,{ok:true})]});
  await ui.run(single);await ui.retry()({managementToken:'t1'});
  assert.deepEqual(ui.state.toasts,['error:'+expired],'the refusal reports the server text');assert.equal(ui.state.opened.length,2,'the dialog opens again');assert.deepEqual(ui.state.saving,[true,false]);assert.equal(ui.state.refreshes,0);
  await ui.retry()({managementToken:'t2'});
  assert.deepEqual(ui.state.posts,[{...single,managementToken:'t1'},{...single,managementToken:'t2'}],'exactly one more POST, with t2 in place of t1');assert.deepEqual(ui.state.toasts,['error:'+expired,de('console.deviceRemoved')]);assert.equal(ui.state.refreshes,1);
 }
 // Any other refusal only reports.
 {const ui=fakeConsole({replies:[reply(404,{error:serverText('apiError.devices.removeNotFound')})]});await ui.run(single);await ui.retry()({managementToken:'t1'});
  assert.deepEqual(ui.state.toasts,['error:Mindestens ein Gerät wurde nicht gefunden. Es wurden keine Geräte entfernt.']);assert.equal(ui.state.opened.length,1,'404 opens no dialog');assert.deepEqual(ui.state.removed,[]);}
 // The right is lost while the request runs: no toast and no dialog for the reply.
 {const replies=[],ui=fakeConsole({replies});await ui.run(single);replies.push(()=>{ui.state.allowed=false;return reply(403,{error:expired,code:'MFA_STEP_UP_REQUIRED',messageKey:'apiError.mfa.proofExpired'});});await ui.retry()({managementToken:'t1'});
  assert.deepEqual([ui.state.posts.length,ui.state.toasts,ui.state.opened.length,ui.state.saving],[1,[],1,[true,false]],'a reply after the right is lost shows nothing');}
 // Jobs and cancelling keep their toasts. A failed job opens the step-up only for an MFA error code, never for a message text.
 {const ui=fakeConsole({replies:[reply(200,{id:'job-1'}),reply(200,{ok:true})]});
  await ui.run({action:'job',id:device.id,kind:'refresh'});assert.deepEqual(ui.state.toasts,[de('console.jobCreated')]);assert.equal(de('console.jobCreated'),'Auftrag erstellt. Den Fortschritt siehst du unten unter „Aufträge“.');assert.deepEqual(ui.state.posts,[{action:'job',id:device.id,kind:'refresh'}],'a job is sent at once');
  await ui.run({action:'cancel-job',id:'job-1'});assert.equal(ui.state.toasts.at(-1),de('console.saved'));assert.equal(ui.state.refreshes,2);assert.deepEqual(ui.state.removed,[]);assert.equal(ui.state.opened.length,0);}
 for(const code of ['MFA_STEP_UP_REQUIRED','MFA_LOGIN_REQUIRED']){const ui=fakeConsole({replies:[reply(403,{error:'Request refused.',code}),reply(200,{id:'job-2'})]});
  // A known code without a message key (the text form of HttpError, which only test doubles use) shows the sent text (apiErrorText); the code still opens the dialog.
  await ui.run({action:'job',id:device.id,kind:'refresh'});assert.deepEqual(ui.state.toasts,['error:Request refused.']);assert.equal(ui.state.opened.length,1,'a job refused with '+code+' opens the dialog');await ui.retry()({});
  assert.deepEqual(ui.state.posts,[{action:'job',id:device.id,kind:'refresh'},{action:'job',id:device.id,kind:'refresh'}],'and sends the same job again after it');}
 // The Defender bulk action: the plural toast with the number of jobs, and an MFA code sends the same payload once more.
 {const defenderJobs={action:'defender-jobs',kind:'defender-quick-scan',ids:['00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000a2'],confirm:true};
  const ui=fakeConsole({replies:[reply(403,{error:'Request refused.',code:'MFA_STEP_UP_REQUIRED'}),reply(200,{jobs:['j1','j2']}),reply(200,{jobs:['j3']})]});
  await ui.run(defenderJobs);assert.equal(ui.state.opened.length,1,'defender-jobs refused with an MFA code opens the dialog');
  await ui.retry()({});assert.deepEqual(ui.state.posts,[defenderJobs,defenderJobs],'and sends the same payload once more');
  assert.equal(ui.state.toasts.at(-1),'Aufträge für 2 Geräte erstellt. Den Fortschritt siehst du unten bei den Aufträgen.','the plural toast with the count');
  await ui.run({...defenderJobs,ids:defenderJobs.ids.slice(0,1)});assert.equal(ui.state.toasts.at(-1),'Auftrag für 1 Gerät erstellt. Den Fortschritt siehst du unten bei den Aufträgen.','one device');
  assert.equal(ui.state.refreshes,2,'each success refreshes');}
 {const ui=fakeConsole({replies:[reply(403,{error:serverText('apiError.mfa.loginRequired')})]});
  await ui.run({action:'job',id:device.id,kind:'refresh'});assert.deepEqual(ui.state.toasts,['error:Melde dich mit MFA an, um fortzufahren.']);assert.equal(ui.state.opened.length,0,'an MFA message text without an error code opens no dialog');assert.equal(ui.state.posts.length,1);}
}
// The console delegates to it and wires MfaStepUp and the rights-loss effect.
{const file='ui/shell/console.tsx';
 const text=fs.readFileSync(file,'utf8');
 assert.match(text,/const action=\(payload:Record<string,unknown>,onSettled\?:Confirmation\['onSettled'\],options:ConsoleActionOptions=\{\}\):Promise<void>=>runConsoleAction\(payload,\{/,file+': action delegates to console-action.ts');
 assert.match(text,/canOffboard:\(\)=>offboardAllowed\.current/,file+': the offboard right is read live');
 assert.match(text,/openStepUp:retry=>\{mfaRetry\.current=retry;setMfaOpen\(true\);\}/,file+': the step-up opens through the shared MfaStepUp');
 assert.match(text,/setSaving,action:next=>action\(next,onSettled,options\),locale,onSettled,\n \},options\);/,file+': the retry resends through the action itself, with the outcome hook and the send options of the confirmation');
 assert.match(text,/onVerified=\{proof=>\{const retry=mfaRetry\.current;mfaRetry\.current=null;void retry\?\.\(proof\);\}\}/,file+': the verified proof reaches the retry');
 assert.match(text,/onClose=\{\(\)=>\{setMfaOpen\(false\);mfaRetry\.current=null;\}\}/,file+': cancel drops the retry');
 assert.match(text,/setConfirmation\(current=>isDeviceRemovalAction\(current\?\.payload\.action\)\?null:current\);/,file+': losing the right still clears a pending removal');
}
// Enroll: a personal registration needs a fresh step-up proof. The
// server answers MFA_STEP_UP_REQUIRED after validation; the console decides by
// code (stepUpRejected), opens the dialog without an error toast and resends the
// same input once with managementToken through the shared stepUpRetry.
{
 const {stepUpRejected,stepUpRetry}=await import('../../../ui/devices/device/device-removal.tsx');
 assert.equal(stepUpRejected(new ApiError(serverText('apiError.mfa.confirmChange'),403,'MFA_STEP_UP_REQUIRED')),true,'enroll MFA_STEP_UP_REQUIRED opens the dialog');
 assert.equal(stepUpRejected(new ApiError(serverText('apiError.console.serverName'),400)),false,'a validation error only reports');
 assert.equal(stepUpRejected(new Error('MFA Bestätigung')),false,'the message text alone never opens the dialog');
 const input={name:'SRV-APP01',mode:'Management',groupId:'group-1'},sent=[],reports=[];
 const retry=stepUpRetry(input,next=>{sent.push(next);},text=>reports.push(text));
 retry({});assert.deepEqual([sent,reports],[[],[missingProofMessage]],'enroll: a proof without managementToken sends nothing and reports');
 retry({managementToken:'enroll-proof'});assert.deepEqual(sent,[{...input,managementToken:'enroll-proof'}],'enroll: the same input goes out once with the proof');
 const again=stepUpRetry({...input,managementToken:'used'},next=>{sent.push(next);},()=>{});again({managementToken:'fresh'});assert.equal(sent.at(-1).managementToken,'fresh','a used token is replaced');
 // The console wires enroll to the helpers and no longer matches message text.
 const text=fs.readFileSync('ui/shell/console.tsx','utf8'),body=text.slice(text.indexOf(' const enroll=async('),text.indexOf('\n };',text.indexOf(' const enroll=async(')));
 assert.match(body,/managementToken\?:string/,'enroll takes an optional managementToken');
 // The request itself lives in ui/devices/add-device/enroll-action.ts (enrollBody, submitEnrollment).
 const enrollAction=fs.readFileSync('ui/devices/add-device/enroll-action.ts','utf8');
 assert.match(enrollAction,/\.\.\.\(input\.managementToken\?\{managementToken:input\.managementToken\}:\{\}\)/,'the token goes into the enroll body only when present');
 assert.match(body,/await submitEnrollment\(input,\{/,'the console sends the registration through submitEnrollment');
 assert.match(body,/return new ApiError\([^;]*response\.status,result\.code\)/,'the reply code reaches the client error');
 assert.match(enrollAction,/if\(!response\.ok\)throw await effects\.failure\(response\);/,'a failed answer throws that error');
 assert.match(body,/stepUp:failure=>\{if\(!stepUpRejected\(failure\)\)return false;mfaRetry\.current=stepUpRetry\(input,payload=>enroll\(payload,registered\),toast\.error,locale\);setMfaOpen\(true\);return true;\}/,'MFA_STEP_UP_REQUIRED opens the dialog; the retry keeps the page callback');
 assert.match(enrollAction,/if\(effects\.stepUp\(failure\)\)return;\s*effects\.error\(/,'a step-up answer returns before the error toast');
 assert.doesNotMatch(body,/MFA\|Bestätigung/,'enroll decides by code, not by message text');
 assert.doesNotMatch(body.slice(body.indexOf('stepUp:')),/setEnrollOpen/,'a step-up or failure keeps the enroll dialog and its input');
 assert.doesNotMatch(enrollAction.slice(enrollAction.indexOf('}catch(failure){')),/created/,'only a success reaches created, which closes the dialog');
}
// The uninstall switch of the removal dialog: capability, open job and the console's online rule.
{
 const {confirmedView}=await import('../../../ui/base/confirmation.ts');
 const now=Date.now(),capable={protocolVersion:3,mode:'ReadOnly',agentCapabilities:['refresh','agent-uninstall']},old={protocolVersion:3,mode:'ReadOnly',agentCapabilities:['refresh']};
 const online={id:'00000000-0000-4000-8000-000000000011',name:'SRV-ONLINE',lastSeen:now-1000,snapshot:capable},offline={...online,id:'00000000-0000-4000-8000-000000000012',name:'SRV-OFFLINE',lastSeen:now-121_000},legacy={...online,id:'00000000-0000-4000-8000-000000000013',name:'SRV-OLD',snapshot:old};
 const choice=(server,context={now})=>{const {available,checked,hint}=deviceRemovalConfirmation(server,'de',context).uninstall;return {available,checked,hint};};
 assert.deepEqual(choice(online),{available:true,checked:true,hint:de('console.removal.uninstall.hintReady')},'online and capable: the switch is on');
 assert.deepEqual(choice(offline),{available:true,checked:false,hint:de('console.removal.uninstall.hintOffline')},'offline and capable: available, not preselected');
 assert.deepEqual(choice(legacy),{available:false,checked:false,hint:de('console.removal.uninstall.hintUnsupported')},'an old agent: disabled with its reason');
 assert.deepEqual(choice({...online,snapshot:{...capable,protocolVersion:2}}),{available:false,checked:false,hint:de('console.removal.uninstall.hintUnsupported')},'protocol 3 is required');
 assert.deepEqual(choice(online,{now,pending:new Set([online.id])}),{available:false,checked:false,hint:de('console.removal.uninstall.hintPending')},'an open uninstall job: off and blocked');
 assert.deepEqual(choice({...online,maintenance:{state:'updating',version:'4.9.0',notBefore:0}}),{available:true,checked:false,hint:de('console.removal.uninstall.hintOffline')},'the console online rule decides, as in ui/base/ui-device.ts');
 const single=deviceRemovalConfirmation(online,'de',{now});
 assert.equal(single.uninstall.title,de('console.removal.uninstallTitle',{name:'SRV-ONLINE'}));assert.equal(single.uninstall.description,de('console.removal.uninstallDescription'));
 const lines=[{label:'Gerät',value:'SRV-ONLINE'}];
 assert.deepEqual(confirmedView(single,true),{title:single.uninstall.title,description:single.uninstall.description,confirmLabel:'Deinstallieren und entfernen',lines,tone:'danger',payload:{action:'remove-server',id:online.id,confirm:true,uninstall:true}},'switch on: uninstall title, description, the uninstall verb and uninstall:true');
 assert.deepEqual(confirmedView(single,false),{title:single.title,description:single.description,confirmLabel:'Gerät entfernen',lines,tone:'danger',payload:{action:'remove-server',id:online.id,confirm:true,uninstall:false}},'switch off: the plain text, "Gerät entfernen" and uninstall:false');
 assert.equal(confirmedView(deviceRemovalConfirmation(legacy,'de',{now}),true).payload.uninstall,false,'a disabled switch never sends uninstall:true');
 assert.equal(confirmedView(deviceRemovalConfirmation(legacy,'de',{now}),true).confirmLabel,'Gerät entfernen','a disabled switch keeps the plain verb');
 const job={title:'T',description:'D',payload:{action:'cancel-job',id:'x'}};assert.deepEqual(confirmedView(job,true),{...job,confirmLabel:undefined,lines:undefined,tone:undefined},'a confirmation without the fields keeps its text and payload, with no verb, lines or tone');
 assert.deepEqual(confirmedView({...job,confirmLabel:'Abbrechen',tone:'default',lines:[{label:'Gerät',value:'X'}]},true),{...job,confirmLabel:'Abbrechen',tone:'default',lines:[{label:'Gerät',value:'X'}]},'confirmLabel, lines and tone pass through');
 const bulkChoice=(servers,context={now})=>{const {available,checked,hint}=bulkDeviceRemovalConfirmation(servers,'de',context).uninstall;return {available,checked,hint};};
 const second={...online,id:'00000000-0000-4000-8000-000000000014',name:'SRV-ONLINE-2'};
 assert.deepEqual(bulkChoice([online,second]),{available:true,checked:true,hint:de('console.removal.uninstall.hintReady')},'bulk: preselected when every device is online and capable');
 assert.deepEqual(bulkChoice([online,offline,legacy]),{available:true,checked:false,hint:de('console.removal.uninstall.hintBulkPartial',{ready:1,count:3})},'bulk partial: available, not preselected, counts in the hint');
 assert.match(de('console.removal.uninstall.hintBulkPartial',{ready:1,count:3}),/^1 von 3 Geräten/);
 assert.deepEqual(bulkChoice([legacy,{...legacy,id:second.id}]),{available:false,checked:false,hint:de('console.removal.uninstall.hintUnsupported')},'bulk without a capable device: disabled');
 const bulkConfirmation=bulkDeviceRemovalConfirmation([online,second],'de',{now});
 assert.equal(bulkConfirmation.uninstall.title,de('console.removal.uninstallBulkTitle',{count:2}));assert.doesNotMatch(bulkConfirmation.uninstall.description,/SRV-ONLINE/,'the device list is the "Geräte" line, not part of the uninstall description');
 assert.deepEqual(confirmedView(bulkConfirmation,true).lines,[{label:'Geräte',value:'SRV-ONLINE, SRV-ONLINE-2'}]);assert.equal(confirmedView(bulkConfirmation,true).confirmLabel,'Deinstallieren und entfernen');assert.equal(confirmedView(bulkConfirmation,false).confirmLabel,'2 Geräte entfernen');
 assert.deepEqual(confirmedView(bulkConfirmation,true).payload,{action:'remove-servers',ids:[online.id,second.id],confirm:true,uninstall:true});
 // The switch row (Field inline): role="switch", the label wraps it, the visible hint is its description through a generated id, no title.
 const {UninstallSwitch}=await import('../../../ui/devices/device/device-removal.tsx');
 const ready=renderToStaticMarkup(React.createElement(UninstallSwitch,{choice:single.uninstall,checked:true,onChange:()=>{}}));
 assert.match(ready,/^<div class="sdx-field sdx-field-inline sdx-uninstall-choice"><label><input type="checkbox" role="switch"[^>]*checked=""/);assert.match(ready,/Agent auf dem Gerät deinstallieren<\/span><\/label>/);assert.doesNotMatch(ready,/disabled=""/);
 const describedBy=markup=>{const id=markup.match(/role="switch"[^>]*aria-describedby="([^"]+)"/)?.[1];return id&&markup.match(new RegExp(`<small id="${id.replace(/[^\w-]/g,'\\$&')}">([^<]+)</small>`))?.[1];};
 assert.equal(describedBy(ready),de('console.removal.uninstall.hintReady'),'the switch is described by its visible hint');
 assert.doesNotMatch(ready,/sdx-uninstall-hint|title=/,'no fixed id and no title');
 const locked=renderToStaticMarkup(React.createElement(UninstallSwitch,{choice:deviceRemovalConfirmation(legacy,'de',{now}).uninstall,checked:true,onChange:()=>{}}));
 assert.match(locked,/disabled=""/);assert.doesNotMatch(locked,/checked=""/);assert.doesNotMatch(locked,/title=/);
 assert.match(describedBy(locked),/^Diese Agentversion kann sich nicht selbst deinstallieren/,'an unavailable switch stays natively disabled and its reason stays visible below it');
 // The console renders every confirmation through the kit ConfirmDialog, with the switch row as its child.
 const text=fs.readFileSync('ui/shell/console.tsx','utf8');
 assert.match(text,/\{confirmation\?\.uninstall&&<UninstallSwitch choice=\{confirmation\.uninstall\} checked=\{uninstallOn\} onChange=\{setUninstallOn\}\/>\}/,'the dialog renders the switch row');
 assert.match(text,/onConfirm=\{\(\)=>\{if\(confirmed\)void action\(confirmed\.payload,confirmation\?\.onSettled,confirmationOptions\(confirmation\)\);setConfirmation\(null\);\}\}/,'confirming sends the payload of the switch state with the send options of the confirmation and closes');
 // The header's "More actions" entry, the fleet row menu and the bulk bar name the action like the dialog does.
 const deviceSource=fs.readFileSync('ui/devices/device/device.tsx','utf8'),fleetSource=fs.readFileSync('ui/devices/fleet/fleet.tsx','utf8');
 assert.match(deviceSource,/\{id:'remove',label:t\('console\.removal\.button'\),icon:Trash2,danger:true,blocked:removal\.blocked,onSelect:removal\.onSelect\}/,'the device header menu entry says console.removal.button');
 assert.match(deviceSource,/onSelect:\(\)=>onConfirm\(deviceRemovalConfirmation\(server,locale,removalContext\)\)/,'choosing it opens the same removal confirmation');
 assert.match(fleetSource,/\{id:'remove',label:t\('console\.removal\.button'\),icon:Trash2,danger:true/,'the fleet row menu says console.removal.button');
 assert.match(fleetSource,/onConfirm\(bulkDeviceRemovalConfirmation\(selected,locale,removalContext\)\);\}\}>\{t\('console\.removal\.bulkButton',\{count:selected\.length\}\)\}<\/Btn>/,'the bulk bar says console.removal.bulkButton');
 assert.doesNotMatch(deviceSource+fleetSource,/device\.offboard|fleet\.menu\.removeFromPortal/);
 {
  const {default:DeviceView}=await import('../../../ui/devices/device/device.tsx');
  const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
  const {demoData}=await import('../../../ui/shell/demo.ts');
  const noop=()=>{},live={...demoData().servers.find(item=>item.id==='demo-app'),lastSeen:now};
  for(const locale of ['de','en']){
   const page=renderToStaticMarkup(React.createElement(LocaleProvider,{locale},React.createElement(DeviceView,{server:live,servers:[live],viewer:admin,demo:false,saving:false,now,section:'overview',onSection:noop,samples:[],historyLoading:false,jobs:[],audit:[],crumbs:[],onConfirm:noop,onSelectJob:noop,onCancelJob:noop,panel:null,onPanel:noop,canOffboard:true})));
   const header=page.slice(0,page.indexOf('</header>'));
   assert.doesNotMatch(header,/sdx-btn-danger|sdx-btn-primary/,`${locale}: the header has no danger or primary button`);
   assert.match(header,new RegExp(`<button type="button" class="sdx-icon-btn sdx-btn-ghost" aria-label="${locale==='de'?'Weitere Aktionen':'More actions'}"[^>]*aria-haspopup="menu"`),`${locale}: the "More actions" trigger`);
  }
  // The menu entry itself (radix renders the menu content only when open).
  const {deviceHeaderMenu}=await import('../../../ui/devices/device/device.tsx');
  const {translate}=await import('../../../lib/i18n/translate.ts');
  for(const [locale,label] of [['de','Gerät entfernen'],['en','Remove device']]){
   const entry=deviceHeaderMenu({narrow:false,removal:{onSelect:noop}},(key,params)=>translate(locale,key,params)).find(item=>item.id==='remove');
   assert.deepEqual([entry.label,entry.danger],[label,true],`${locale}: the menu entry reads ${label}`);
  }
 }
 // A removal with uninstall: no onRemoved, the requested toast and the drawer callback.
 const {runConsoleAction}=await import('../../../ui/shell/console-action.ts');
 const run=async(payload,body)=>{const state={posts:[],toasts:[],removed:[],drawer:[],opened:[]};const deps={demo:false,canOffboard:()=>true,post:async sent=>{state.posts.push(sent);return Response.json(body);},openStepUp:retry=>state.opened.push(retry),toast:{success:m=>state.toasts.push(m),error:m=>state.toasts.push('error:'+m)},onRemoved:ids=>state.removed.push(ids),onUninstallRequested:ids=>state.drawer.push(ids),refresh:()=>{},setSaving:()=>{},action:next=>runConsoleAction(next,deps)};await runConsoleAction(payload,deps);return state;};
 const many={...confirmedView(bulkConfirmation,true).payload,managementToken:'t1'};
 let state=await run(many,{ok:true,ids:many.ids,uninstall:{queued:many.ids,unsupported:[],alreadyPending:[],queueFull:[],unchanged:[]}});
 assert.deepEqual([state.posts,state.removed,state.toasts,state.drawer],[[many],[],[de('console.uninstall.requested',{count:2})],[many.ids]],'uninstall: sent with uninstall:true, nothing removed, the requested toast, the drawer opens');
 state=await run({...many,ids:[online.id]},{ok:true,ids:[online.id],uninstall:{queued:[],unsupported:[online.id],alreadyPending:[],queueFull:[],unchanged:[]}});
 assert.deepEqual([state.removed,state.toasts,state.drawer],[[],[de('console.uninstall.noneQueued')],[[online.id]]],'nothing queued: its own toast, the drawer still opens');
 const plain={...confirmedView(single,false).payload,managementToken:'t1'};state=await run(plain,{ok:true});
 assert.deepEqual([state.posts[0].uninstall,state.removed,state.drawer],[false,[[online.id]],[]],'switch off: a plain removal still calls onRemoved');
 // Without a proof the step-up opens first and nothing is sent, also with uninstall.
 state=await run(confirmedView(bulkConfirmation,true).payload,{ok:true});assert.deepEqual([state.posts,state.opened.length],[[],1],'uninstall enters the step-up flow before sending');
 // Demo mode sends nothing, also with uninstall.
 const demoState={posts:[]};await runConsoleAction(many,{demo:true,post:async sent=>{demoState.posts.push(sent);}});assert.deepEqual(demoState.posts,[],'demo sends nothing');
}
// The fleet row menu: Open, Terminal, Files, Restart…, Move to group, a separator, Remove device; Restart… is in every row.
{
 const {fleetRowMenu}=await import('../../../ui/devices/fleet/fleet.tsx');
 const {powerMenuEntry}=await import('../../../ui/devices/management/device-power.tsx');
 const {translate}=await import('../../../lib/i18n/translate.ts');
 const t=(key,params)=>translate('en',key,params),calls=[];
 const action=(id,blocked)=>({blocked,onSelect:()=>calls.push(id)});
 const full=fleetRowMenu({move:action('move'),restart:action('restart'),removal:action('remove'),onOpen:section=>calls.push('open:'+(section??''))},t);
 assert.deepEqual(full.map(entry=>entry.separator?'—':entry.label),['Open','Terminal','Files','Restart…','Move to group…','—','Remove device'],'the row menu order');
 for(const entry of full)if(!entry.separator)entry.onSelect();
 assert.deepEqual(calls,['open:','open:terminal','open:files','restart','move','remove'],'every entry runs its action');
 assert.deepEqual(fleetRowMenu({restart:action('restart'),onOpen:()=>{}},t).map(entry=>entry.id),['open','terminal','files','restart'],'without move and removal: Restart… is still there');
 // Restart… is blocked with the reason of the shared power flow.
 const now=Date.now(),online={id:'srv',name:'SRV',lastSeen:now-1000,management:1,revoked:0,snapshot:{mode:'Management',agentCapabilities:['restart-computer']}};
 const reason=(server,extra={})=>powerMenuEntry('restart-computer',{server,viewer:admin,demo:false,saving:false,now,...extra},()=>{},'de').blocked;
 assert.deepEqual([reason(online),reason({...online,lastSeen:now-600000}),reason({...online,management:0}),reason(online,{demo:true}),reason({...online,snapshot:{...online.snapshot,agentCapabilities:[]}})],
  [undefined,de('management.blocked.offline'),de('management.blocked.readOnly'),de('kit.unavailable.demo'),de('management.blocked.unsupported')],'Restart… is blocked with its reason where it cannot run');
 assert.match(fs.readFileSync('ui/devices/fleet/fleet.tsx','utf8'),/restart:powerMenuEntry\('restart-computer',\{server,viewer,demo,saving,now:consoleClock\.now\(\)\},setPower,locale\)/,'the fleet row opens the shared power drawer (with the clock when its menu opens)');
}
console.log('PASS: removal UI supports offline/unregistered/ReadOnly devices, protects admin-only/demo/busy states, confirms the exact device and describes local execution and uninstall limits; enroll retries once with a fresh step-up proof, decided by code.');
