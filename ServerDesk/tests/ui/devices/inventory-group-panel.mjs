// The group changes of the console (useAccessChange in ui/devices/fleet/groups.tsx), which the inventory drawers use.
// No network, database, browser or Windows device is changed by this harness.
import '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {i18nRequire} from '../../support/i18n-stubs.mjs';

let checks=0;
const clone=value=>structuredClone(value);
const jsx=(type,props,key)=>({type,props:props??{},key});
const source=filename=>ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;

// The redesigned console runs the same changes through useAccessChange
// (ui/devices/fleet/groups.tsx): routine changes and deleting an empty group go out at once, deleting a group
// with a device or an assignment (stepUpOnDelete) opens the MFA dialog first, and MFA_STEP_UP_REQUIRED (by code) opens it and
// resends the same body once with the proof.
{
 const cells=[],calls=[],toasts=[],cache=new Map();let cursor=0,reply=()=>({ok:true}),done=0;
 const hooks={useState(initial){const index=cursor++;cells[index]??={value:typeof initial==='function'?initial():initial};return [cells[index].value,value=>{cells[index].value=typeof value==='function'?value(cells[index].value):value;}];},useRef(initial){const index=cursor++;cells[index]??={value:{current:initial}};return cells[index].value;},useMemo(fn){return fn();},useEffect(){}};
 class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
 const api=async(url,payload)=>{calls.push({url,payload:clone(payload)});return reply(payload);};
 const load=filename=>{
  const absolute=path.resolve(filename);if(cache.has(absolute))return cache.get(absolute).exports;
  const mod={exports:{}};cache.set(absolute,mod);
  const require=id=>i18nRequire(id)??(id==='react'?hooks:id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:id==='lucide-react'?new Proxy({}, {get:(_target,key)=>String(key)}):id==='sonner'?{toast:{success:text=>toasts.push(text),error:text=>toasts.push('error:'+text)}}:id==='@/ui/session/mfa-step-up'?{MfaStepUp:'MfaStepUp'}:id==='@/ui/base/api'?{api,ApiError,message:error=>error.message}:id==='@/ui/session/step-up-retry'?load('ui/session/step-up-retry.ts'):id==='@/ui/base/access-capabilities'?load('ui/base/access-capabilities.ts'):id==='@/ui/kit/kit'?{Btn:'Btn',Card:'Card',Drawer:'Drawer',Empty:'Empty',cx:(...names)=>names.filter(Boolean).join(' ')}:id==='@/ui/kit/field'?{Field:'Field'}:id==='@/ui/kit/analysis-tab'?{AnalysisTab:'AnalysisTab'}:id==='@/ui/kit/name-confirm-drawer'?{NameConfirmDrawer:'NameConfirmDrawer'}:id==='@/ui/devices/fleet/customer-choice'?load('ui/devices/fleet/customer-choice.ts'):id==='@/lib/default-customer'?load('lib/default-customer.ts'):id==='@/lib/errors/codes'?load('lib/errors/codes.ts'):id==='@/lib/step-up'?load('lib/step-up.ts'):id==='@/ui/devices/fleet/groups-model'?load('ui/devices/fleet/groups-model.ts'):(()=>{throw Error('Unexpected import '+id);})());
  new Function('require','module','exports',source(absolute))(require,mod,mod.exports);return mod.exports;
 };
 // The harness drives the hook directly with its deterministic hook cells.
 const {useAccessChange:accessChangeHook}=load('ui/devices/fleet/groups.tsx');
 let change;const render=()=>{cursor=0;change=accessChangeHook(()=>{done++;});return change;};
 const prompt=()=>render().prompt.props,settle=async()=>{for(let n=0;n<5;n++)await new Promise(resolve=>setImmediate(resolve));};
 const stepUp=payload=>{if(!payload.managementToken)throw new ApiError('Bestätige die Änderung mit einem aktuellen Authenticator-Code, Wiederherstellungscode oder Passkey.',403,'MFA_STEP_UP_REQUIRED');return {ok:true};};
 // Routine changes: one request without managementToken and without the dialog.
 for(const body of [{action:'create-group',name:'Neu',description:'',parentId:null},{action:'update-group',id:'production',name:'Neu',description:''},{action:'assign-device',serverIds:['device-a'],groupId:'testing'},{action:'set-device-memberships',serverIds:['device-a'],groupId:'production',assigned:false}]){
  calls.length=0;toasts.length=0;render();const pending=change.run(body,'Gespeichert.');render();
  assert.deepEqual(calls.map(call=>call.payload),[body],body.action+' is sent at once');assert.equal(prompt().open,false,body.action+' opens no dialog');assert.equal(change.busy,true,body.action+' shows its loading state');
  assert.deepEqual(await pending,{ok:true});render();assert.equal(change.busy,false);assert.deepEqual(toasts,['Gespeichert.']);checks+=6;
 }
 // Deleting a group with a device or an assignment (stepUpOnDelete) opens the dialog first and sends the proof.
 calls.length=0;render();let pending=change.run({action:'delete-group',id:'child',confirm:true},'Gruppe gelöscht.',{stepUpOnDelete:true});assert.equal(calls.length,0);assert.equal(prompt().open,true);
 prompt().onVerified({managementToken:'delete-proof'});prompt().onClose();assert.deepEqual(await pending,{ok:true});assert.deepEqual(calls.map(call=>call.payload),[{action:'delete-group',id:'child',confirm:true,managementToken:'delete-proof'}]);checks+=4;
 // Cancelling the dialog sends nothing; a proof without token neither.
 calls.length=0;toasts.length=0;render();pending=change.run({action:'delete-group',id:'child',confirm:true},'Gruppe gelöscht.',{stepUpOnDelete:true});prompt().onClose();assert.equal(await pending,null);assert.equal(calls.length,0);checks+=2;
 render();pending=change.run({action:'delete-group',id:'child',confirm:true},'Gruppe gelöscht.',{stepUpOnDelete:true});prompt().onVerified({});assert.equal(await pending,null);assert.equal(calls.length,0);assert.deepEqual(toasts,['error:Nodiverna konnte deine Identität nicht bestätigen. Versuche es erneut.']);checks+=3;
 // An empty group (stepUpOnDelete false or unknown) deletes at once without the dialog.
for(const options of [{stepUpOnDelete:false},{}]){
 calls.length=0;toasts.length=0;render();pending=change.run({action:'delete-group',id:'empty',confirm:true},'Gruppe gelöscht.',options);
 assert.equal(prompt().open,false,'an empty group opens no dialog');assert.deepEqual(await pending,{ok:true});
 assert.deepEqual(calls.map(call=>call.payload),[{action:'delete-group',id:'empty',confirm:true}],'one request without managementToken');checks+=3;
}
// The race of the server (a device arrives before the commit): the 403 opens the dialog and resends once with the proof.
calls.length=0;toasts.length=0;reply=stepUp;render();pending=change.run({action:'delete-group',id:'empty',confirm:true},'Gruppe gelöscht.',{stepUpOnDelete:false});await settle();
assert.equal(prompt().open,true,'MFA_STEP_UP_REQUIRED on an empty-group delete opens the dialog');assert.equal(calls.length,1);
prompt().onVerified({managementToken:'race-proof'});prompt().onClose();assert.deepEqual(await pending,{ok:true});
assert.deepEqual(calls.map(call=>call.payload),[{action:'delete-group',id:'empty',confirm:true},{action:'delete-group',id:'empty',confirm:true,managementToken:'race-proof'}],'exactly one resend with the proof');reply=()=>({ok:true});checks+=4;
// MFA_STEP_UP_REQUIRED on a routine change opens the dialog and resends once with the proof.
 calls.length=0;toasts.length=0;reply=stepUp;render();pending=change.run({action:'update-group',id:'production',name:'Neu',description:''},'Gruppe gespeichert.');await settle();
 assert.equal(prompt().open,true,'MFA_STEP_UP_REQUIRED opens the dialog');assert.equal(calls.length,1);assert.equal(change.busy,true);
 prompt().onVerified({managementToken:'retry-proof'});prompt().onClose();assert.deepEqual(await pending,{ok:true});
 assert.deepEqual(calls.map(call=>call.payload),[{action:'update-group',id:'production',name:'Neu',description:''},{action:'update-group',id:'production',name:'Neu',description:'',managementToken:'retry-proof'}]);assert.deepEqual(toasts,['Gruppe gespeichert.']);checks+=6;
 // A device move that widens access answers MFA_STEP_UP_REQUIRED; the
 // dialog opens and the same move goes out once more with the proof.
 calls.length=0;toasts.length=0;reply=stepUp;render();pending=change.run({action:'assign-device',serverIds:['device-a'],groupId:'production'},'Gerätezuordnung gespeichert.');await settle();
 assert.equal(prompt().open,true,'a widening move opens the dialog');assert.equal(calls.length,1);
 prompt().onVerified({managementToken:'move-proof'});prompt().onClose();assert.deepEqual(await pending,{ok:true});
 assert.deepEqual(calls.map(call=>call.payload),[{action:'assign-device',serverIds:['device-a'],groupId:'production'},{action:'assign-device',serverIds:['device-a'],groupId:'production',managementToken:'move-proof'}]);assert.deepEqual(toasts,['Gerätezuordnung gespeichert.']);checks+=4;
 // A routine reply without a token opens the dialog without a notice.
 calls.length=0;toasts.length=0;reply=stepUp;render();pending=change.run({action:'assign-device',serverIds:['device-a'],groupId:'production'},'Gerätezuordnung gespeichert.');await settle();
 assert.equal(prompt().open,true);assert.equal(prompt().notice,'','a routine reply without a token opens without notice');prompt().onClose();assert.equal(await pending,null);assert.equal(prompt().notice,'');checks+=4;
 // A resend that carried a proof and is refused again by code reopens the dialog
 // with the server reason; the next proof resends once, cancel sends nothing.
 const expired='Die Bestätigung ist abgelaufen oder bereits verwendet. Bitte die Identität erneut bestätigen.';
 const refuseUntil=payload=>{if(payload.managementToken!=='p2')throw new ApiError(expired,403,'MFA_STEP_UP_REQUIRED');return {ok:true};};
 calls.length=0;toasts.length=0;reply=refuseUntil;render();pending=change.run({action:'delete-group',id:'child',confirm:true},'Gruppe gelöscht.',{stepUpOnDelete:true});
 assert.equal(prompt().open,true);assert.equal(prompt().notice,'','the first dialog has no notice');
 prompt().onVerified({managementToken:'p1'});await settle();
 assert.equal(prompt().open,true,'the refused resend reopens the dialog');assert.equal(prompt().notice,expired,'with the server reason as notice');assert.equal(calls.length,1);
 prompt().onVerified({managementToken:'p2'});assert.deepEqual(await pending,{ok:true});
 assert.deepEqual(calls.map(call=>call.payload),[{action:'delete-group',id:'child',confirm:true,managementToken:'p1'},{action:'delete-group',id:'child',confirm:true,managementToken:'p2'}],'exactly one more request with the new proof');
 assert.equal(prompt().open,false);assert.equal(prompt().notice,'','verification clears the notice');assert.deepEqual(toasts,['Gruppe gelöscht.'],'no extra toast');checks+=10;
 calls.length=0;toasts.length=0;render();pending=change.run({action:'delete-group',id:'child',confirm:true},'Gruppe gelöscht.',{stepUpOnDelete:true});prompt().onVerified({managementToken:'p1'});await settle();
 assert.equal(prompt().notice,expired);prompt().onClose();assert.equal(await pending,null);
 assert.equal(calls.length,1,'cancelling after a refused resend sends nothing');assert.equal(prompt().open,false);assert.equal(prompt().notice,'','cancelling clears the notice');assert.deepEqual(toasts,[],'no toast');checks+=6;
 // Other failures only report; the message text alone never opens the dialog.
 calls.length=0;toasts.length=0;reply=()=>{throw new ApiError('MFA Bestätigung fehlgeschlagen',409);};render();pending=change.run({action:'create-group',name:'Neu',description:'',parentId:null},'Gruppe erstellt.');assert.equal(await pending,null);render();assert.equal(prompt().open,false);assert.deepEqual(toasts,['error:MFA Bestätigung fehlgeschlagen']);checks+=3;
 // The client reads the classification from lib/step-up.ts and keeps no list of its own.
 {const text=fs.readFileSync('ui/devices/fleet/groups-model.ts','utf8');assert.match(text,/accessActionNeedsStepUp\(body\.action\)/);assert.match(text,/stepUpOnDelete===true/);checks++;assert.doesNotMatch(text,/\['delete-group','set-grant'/);checks+=2;}
 // The classic group access panel is deleted; every group change runs through this hook.
 assert.ok(!fs.existsSync('app/access-panel.tsx'),'app/access-panel.tsx does not exist');checks++;
 assert.ok(done>0);
}
console.log(`PASS inventory group changes (${checks} assertions): routine changes at once without MFA dialog, deletion behind the dialog, MFA_STEP_UP_REQUIRED retries with the proof, refused resends and cancellation, and the shared step-up classification.`);
