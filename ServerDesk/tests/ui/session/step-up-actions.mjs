// Which panel actions open the MFA step-up dialog before they send (lib/step-up.ts, docs/portal-sessions.md
// "Which actions ask for MFA again"): stepUpController, the pure core of useStepUp, driven without a DOM with the
// predicates the panels use. A device group delete asks first only with stepUpOnDelete; an empty-group delete that
// gets 403 MFA_STEP_UP_REQUIRED opens the dialog and resends once with the token; Cancel sends nothing; a
// notification channel change and a customer create go out at once; a maintenance Save asks first only for a
// shorter retention, and a customer edit only for a known shorter own retention.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {stepUpController}=await import('../../../ui/session/step-up-retry.ts');
const {ApiError}=await import('../../../ui/base/http.ts');
const {accessRequestNeedsStepUp}=await import('../../../ui/devices/fleet/groups-model.ts');
const {maintenanceSaveNeedsStepUp}=await import('../../../ui/settings/retention-model.ts');
const {customerBodyNeedsStepUp}=await import('../../../ui/settings/customers-model.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const settle=async()=>{for(let index=0;index<8;index++)await new Promise(resolve=>setImmediate(resolve));};
const stepUpError=()=>new ApiError('Confirm the change.',403,'MFA_STEP_UP_REQUIRED');

/** A controller with recorded sends; needsStepUp is the panel's predicate, reply decides each answer. */
function setup(needsStepUp,reply=()=>({ok:true})){
 const sent=[],reports=[];
 const controller=stepUpController({send:async payload=>{sent.push(payload);return reply(payload,sent.length);},needsStepUp,report:text=>reports.push(text),describe:failure=>failure instanceof Error?failure.message:String(failure),locale:()=>'en',onState:()=>{}});
 return {controller,sent,reports,open:()=>controller.state().open};
}

// ---- Device group delete (ui/devices/fleet/groups.tsx, useAccessChange) ----
{
 const remove=(stepUpOnDelete)=>({body:{action:'delete-group',id:'g1',confirm:true},success:'Deleted.',...(stepUpOnDelete===undefined?{}:{stepUpOnDelete})});
 // A group with a device or an assignment: the dialog first, nothing sent; the proof sends once.
 {
  const flow=setup(accessRequestNeedsStepUp),pending=flow.controller.run(remove(true));
  check([flow.open(),flow.sent],[true,[]],'stepUpOnDelete: the dialog opens before any request');
  flow.controller.verified({managementToken:'proof-1'});
  check(await pending,{ok:true},'the delete resolves');
  check(flow.sent.map(payload=>payload.managementToken),['proof-1'],'one request with the token');
 }
 // Cancel sends nothing.
 {
  const flow=setup(accessRequestNeedsStepUp),pending=flow.controller.run(remove(true));
  flow.controller.cancel();
  check([await pending,flow.sent,flow.open()],[null,[],false],'Cancel sends nothing and resolves null');
 }
 // An empty group: at once, without the dialog.
 for(const flag of [false,undefined]){
  const flow=setup(accessRequestNeedsStepUp),pending=flow.controller.run(remove(flag));
  check([flow.open(),flow.sent.length],[false,1],`stepUpOnDelete ${String(flag)}: sent at once`);
  check([await pending,flow.sent[0].managementToken],[{ok:true},undefined],'without a token');
 }
 // The race: a device arrives before the commit, the server answers 403; the dialog opens and the delete goes out once more with the token.
 {
  const flow=setup(accessRequestNeedsStepUp,(payload,attempt)=>{if(attempt===1)throw stepUpError();return {ok:true};});
  const pending=flow.controller.run(remove(false));await settle();
  check([flow.open(),flow.sent.length],[true,1],'the 403 opens the dialog');
  flow.controller.verified({managementToken:'race'});
  check([await pending,flow.sent.map(payload=>payload.managementToken)],[{ok:true},[undefined,'race']],'resent exactly once with the token');
 }
 // The always-asking access actions keep asking; the routine ones do not.
 check(['set-grant','delete-grant','create-group','update-group','assign-device'].map(action=>accessRequestNeedsStepUp({body:{action}})),[true,true,false,false,false],'set-grant and delete-grant always ask');
}

// ---- Notification channels (ui/settings/notifications-panel.tsx): no change asks first ----
{
 const source=readFileSync('ui/settings/notifications-panel.tsx','utf8');
 check(/useStepUp<Record<string,unknown>,ChangeResult>\(\{locale,needsStepUp:\(\)=>false,/.test(source),true,'the panel opens no dialog first');
 for(const action of ['create','update','delete','set-enabled','rotate-secret']){
  const flow=setup(()=>false),pending=flow.controller.run({action,id:'c1',revision:0});
  check([flow.open(),flow.sent.length,await pending],[false,1,{ok:true}],action+' goes out at once');
 }
}

// ---- Customers (ui/settings/customer-drawers.tsx with customerBodyNeedsStepUp) ----
{
 const customers=[{id:'c1',auditRetentionDays:30},{id:'c2',auditRetentionDays:null}];
 const needs=body=>customerBodyNeedsStepUp(body,customers);
 for(const body of [{action:'create',name:'Neu'},{action:'set-status',id:'c1',status:'disabled',revision:0},{action:'update',id:'c1',name:'Neu',auditRetentionDays:30,revision:0},{action:'update',id:'c2',auditRetentionDays:5,revision:0}]){
  const flow=setup(needs),pending=flow.controller.run(body);
  check([flow.open(),flow.sent.length,await pending],[false,1,{ok:true}],JSON.stringify(body)+' goes out at once');
 }
 for(const body of [{action:'set-technicians',id:'c1',userIds:[],groupIds:[],revision:0},{action:'update',id:'c1',auditRetentionDays:10,revision:0}]){
  const flow=setup(needs),pending=flow.controller.run(body);
  check([flow.open(),flow.sent],[true,[]],body.action+': the dialog first');
  flow.controller.cancel();check(await pending,null,'Cancel sends nothing');
 }
}

// ---- Maintenance Save (ui/settings/maintenance-panel.tsx with maintenanceSaveNeedsStepUp) ----
{
 const settings={auditDays:30,jobDays:30},save=(auditDays,jobDays,runAt='03:00')=>({action:'set',auditDays,jobDays,runAt,timeZone:'UTC',revision:1});
 const needs=payload=>maintenanceSaveNeedsStepUp(settings,payload);
 for(const [label,payload] of [['run time only',save(30,30,'04:30')],['longer retention',save(60,90)]]){
  const flow=setup(needs),pending=flow.controller.run(payload);
  check([flow.open(),flow.sent.length,await pending],[false,1,{ok:true}],label+': saved at once');
 }
 for(const [label,payload] of [['shorter audit retention',save(10,30)],['shorter job retention',save(30,7)]]){
  const flow=setup(needs),pending=flow.controller.run(payload);
  check([flow.open(),flow.sent],[true,[]],label+': the dialog first');
  flow.controller.verified({managementToken:'retention'});
  check([await pending,flow.sent.map(sent=>sent.managementToken)],[{ok:true},['retention']],label+': sent once with the token');
 }
 // Without loaded settings the client cannot know the old value: it sends, and the 403 opens the dialog.
 const flow=setup(payload=>maintenanceSaveNeedsStepUp(undefined,payload),(payload,attempt)=>{if(attempt===1)throw stepUpError();return {ok:true};});
 const pending=flow.controller.run(save(1,1));await settle();
 check([flow.open(),flow.sent.length],[true,1],'unknown old values: sent without a token, the 403 opens the dialog');
 flow.controller.verified({managementToken:'late'});
 check([await pending,flow.sent.map(sent=>sent.managementToken)],[{ok:true},[undefined,'late']],'resent once with the token');
}

console.log(`PASS step-up actions (${checks} assertions): the panels open the MFA dialog first only for the actions and cases that lib/step-up.ts names; a 403 MFA_STEP_UP_REQUIRED resends once; Cancel sends nothing.`);
