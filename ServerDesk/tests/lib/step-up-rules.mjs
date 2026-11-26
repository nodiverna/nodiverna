// The one classification of the step-up MFA proof (lib/step-up.ts,
// docs/portal-sessions.md "Which actions ask for MFA again"): every set and
// predicate. Kept actions ask, notification channel changes and assistant key
// removal no longer ask, customer create and set-status never ask, and the
// conditional rules (device group delete, maintenance save, customer edit) ask
// only in their risky case. The module imports nothing.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as stepUp from '../../lib/step-up.ts';

let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const sorted=set=>[...set].sort();

// ---- No import, no removed export ----
const source=readFileSync('lib/step-up.ts','utf8');
check(/^\s*import\b|\brequire\(|\bimport\(/m.test(source),false,'lib/step-up.ts imports nothing');
check(['notificationChannelStepUpActions','notificationChannelActionNeedsStepUp','maintenanceStepUpActions','maintenanceActionNeedsStepUp'].filter(name=>name in stepUp),[],'the notification channel and the old maintenance classification are gone');
check(/Which actions ask for MFA\s*(?:\/\/\s*)?again/.test(source),true,'the header names the docs section');
const rule6=source.slice(source.indexOf('// 6.'),source.indexOf('// Distributing'));
check([/notification/i.test(rule6),/remov/i.test(rule6)],[false,false],'rule 6 lists neither notification channels nor key removal');

// ---- Sets that keep their content ----
check(Object.fromEntries(['accessStepUpActions','accessRoutineActions','accessWideningStepUpActions','deviceRemovalActions','deviceCustomerMoveActions','consoleStepUpActions','terminalStepUpActions','sessionSettingsStepUpActions','assistantSettingsStepUpActions','entraSettingsStepUpActions','assistantStepUpCommands','customerStepUpActions','customerConditionalStepUpActions','customerRoutineActions'].map(name=>[name,sorted(stepUp[name])])),{
 accessStepUpActions:['delete-grant','set-grant'],
 accessRoutineActions:['assign-device','create-group','set-device-memberships','update-device-memberships','update-group'],
 accessWideningStepUpActions:['assign-device','set-device-memberships','update-device-memberships'],
 deviceRemovalActions:['remove-server','remove-servers'],
 deviceCustomerMoveActions:['move-customer'],
 consoleStepUpActions:['enroll','move-customer','remove-server','remove-servers'],
 terminalStepUpActions:['open'],
 sessionSettingsStepUpActions:['set','set-idle-mfa','set-idle-timeout'],
 assistantSettingsStepUpActions:['set-customer-key','set-organization-key'],
 entraSettingsStepUpActions:['add-mapping','remove-mapping','save','set-emergency-account','set-enabled','set-entra-only'],
 assistantStepUpCommands:['powershell'],
 customerStepUpActions:['create-installer','delete','revoke-installer','set-multiple-customers','set-technicians'],
 customerConditionalStepUpActions:['update'],
 customerRoutineActions:['create','set-status'],
},'every set holds exactly its actions');

// ---- Kept actions ask ----
for(const action of ['set-grant','delete-grant'])check(stepUp.accessActionNeedsStepUp(action),true,'access '+action+' asks');
for(const action of ['delete-group','create-group','update-group','assign-device',undefined,null,42])check(stepUp.accessActionNeedsStepUp(action),false,'access '+String(action)+' does not always ask');
for(const action of ['enroll','remove-server','remove-servers','move-customer'])check(stepUp.consoleActionNeedsStepUp(action),true,'console '+action+' asks');
// Moving devices to another customer asks (rule 1) but is no removal.
check([stepUp.isDeviceRemovalAction('move-customer'),/move-customer/.test(source.slice(source.indexOf('// 1.'),source.indexOf('// 2.')))],[false,true],'move-customer is no removal and is named under rule 1');
check([stepUp.consoleActionNeedsStepUp('job'),stepUp.consoleActionNeedsStepUp('defender-jobs')],[false,false],'console jobs stay routine');
check([stepUp.terminalActionNeedsStepUp('open'),stepUp.terminalActionNeedsStepUp('input')],[true,false],'terminal open asks');
for(const action of ['set','set-idle-timeout','set-idle-mfa'])check(stepUp.sessionSettingsActionNeedsStepUp(action),true,'session settings '+action+' asks');
for(const action of ['save','set-enabled','add-mapping','remove-mapping','set-emergency-account','set-entra-only'])check(stepUp.entraSettingsActionNeedsStepUp(action),true,'entra '+action+' asks');
check(stepUp.entraSettingsActionNeedsStepUp('test'),false,'entra test is routine');
check([stepUp.assistantActionNeedsStepUp('run',{type:'powershell'}),stepUp.assistantActionNeedsStepUp('run',{type:'action'}),stepUp.assistantActionNeedsStepUp('ask',{type:'powershell'})],[true,false,false],'only an assistant PowerShell run asks');

// ---- Assistant keys: saving asks, removal and the rest do not ----
check(['set-organization-key','set-customer-key','remove-organization-key','remove-customer-key','test-organization-key','test-customer-key','set-personal-key','remove-personal-key','test-personal-key',undefined].map(stepUp.assistantSettingsActionNeedsStepUp),[true,true,false,false,false,false,false,false,false,false],'only saving an organization or customer key asks');

// ---- Customers ----
check(['set-technicians','create-installer','revoke-installer','set-multiple-customers','delete','update','create','set-status',undefined,'unknown'].map(stepUp.customerActionNeedsStepUp),[true,true,true,true,true,false,false,false,false,false],'technicians, installers, the delete and the setting Multiple customers always ask; update is conditional; create and set-status never');

// ---- Device group delete ----
check([
 stepUp.deviceGroupDeleteNeedsStepUp({hasMembers:false,hasAssignments:false}),
 stepUp.deviceGroupDeleteNeedsStepUp({hasMembers:true,hasAssignments:false}),
 stepUp.deviceGroupDeleteNeedsStepUp({hasMembers:false,hasAssignments:true}),
 stepUp.deviceGroupDeleteNeedsStepUp({hasMembers:true,hasAssignments:true}),
],[false,true,true,true],'an empty group deletes without a proof; members or an assignment ask');

// ---- Retention rules: equal, longer, shorter, from no limit, to no limit ----
const retention=[['equal',30,30,false],['longer',30,60,false],['shorter',30,10,true],['from no limit',null,10,true],['to no limit',30,null,false],['no limit both',null,null,false]];
for(const [label,before,after,expected] of retention){
 check(stepUp.retentionGetsShorter(before,after),expected,'retentionGetsShorter '+label);
 check(stepUp.customerUpdateNeedsStepUp(before,after),expected,'customerUpdateNeedsStepUp '+label);
 check(stepUp.maintenanceSetNeedsStepUp({auditDays:before,jobDays:30},{auditDays:after,jobDays:30}),expected,'maintenanceSetNeedsStepUp audit '+label);
 check(stepUp.maintenanceSetNeedsStepUp({auditDays:30,jobDays:before},{auditDays:30,jobDays:after}),expected,'maintenanceSetNeedsStepUp jobs '+label);
}
check(stepUp.maintenanceSetNeedsStepUp({auditDays:30,jobDays:30},{auditDays:60,jobDays:10}),true,'a longer audit and a shorter job retention ask');

console.log(`PASS step-up rules (${checks} assertions): one import-free classification in lib/step-up.ts with the risk-based sets and predicates.`);
