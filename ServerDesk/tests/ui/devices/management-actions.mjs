// The rules of the management actions in ui/devices/management/management-actions.ts, used by Management → Accounts
// (ui/devices/management/device-accounts.tsx), Roles & features (ui/devices/management/roles-features.tsx) and System (Computer & domain,
// Firewall rules, Scheduled tasks): every reason branch in its fixed order, the review lines, the
// device line and the job labels (operationLabel) of the job dock.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
const {managementActionReasonKey,managementActionReason,managementMode,managementReview,confirmationDevice,reviewParameters,operationLabel,DOMAIN_CONTROLLER_PROTECTED,MANAGEMENT_READ_ACTIONS}=await import('../../../ui/devices/management/management-actions.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

// ---- Reasons: each branch and its order ----
const open={demo:false,canOperate:true,canDiagnose:true,offline:false,capabilities:['rename-computer','join-domain','set-firewall-rule','set-task','scan-updates','refresh'],domainRole:3,management:true};
check(managementActionReasonKey(open,'rename-computer'),null,'nothing blocks');
check(managementActionReasonKey({...open,demo:true},'rename-computer'),'kit.unavailable.demo','sample device');
check(managementActionReasonKey({...open,canOperate:false},'rename-computer'),'management.blocked.manage','manage right');
check(managementActionReasonKey({...open,canDiagnose:false},'refresh'),'management.blocked.diagnose','a read action needs diagnose');
check(managementActionReasonKey({...open,canOperate:false,canDiagnose:undefined},'refresh'),'management.blocked.diagnose','without canDiagnose a read action falls back to canOperate');
check(managementActionReasonKey({...open,canOperate:false},'refresh'),null,'a read action does not need manage');
check(managementActionReasonKey({...open,offline:true},'rename-computer'),'management.blocked.offline','offline');
check(managementActionReasonKey({...open,capabilities:[]},'rename-computer'),'management.blocked.unsupported','capability');
check(managementActionReasonKey({...open,capabilities:null},'rename-computer'),'management.blocked.unsupported','no capabilities reported');
check(managementActionReasonKey({...open,domainRole:4},'rename-computer'),'management.blocked.domainController','backup domain controller');
check(managementActionReasonKey({...open,domainRole:5},'join-domain'),'management.blocked.domainController','primary domain controller');
check(managementActionReasonKey({...open,domainRole:5},'set-firewall-rule'),null,'firewall rules are not protected on a domain controller');
check(managementActionReasonKey({...open,management:false},'set-task'),'management.blocked.readOnly','Management mode');
check(managementActionReasonKey({...open,management:false},'scan-updates'),null,'a read action needs no Management mode');
// Order: demo > right > offline > capability > domain controller > mode.
check(managementActionReasonKey({demo:true,canOperate:false,offline:true,capabilities:[],domainRole:5,management:false},'rename-computer'),'kit.unavailable.demo','demo first');
check(managementActionReasonKey({demo:false,canOperate:false,offline:true,capabilities:[],domainRole:5,management:false},'rename-computer'),'management.blocked.manage','then the right');
check(managementActionReasonKey({demo:false,canOperate:true,offline:true,capabilities:[],domainRole:5,management:false},'rename-computer'),'management.blocked.offline','then the connection');
check(managementActionReasonKey({demo:false,canOperate:true,offline:false,capabilities:[],domainRole:5,management:false},'rename-computer'),'management.blocked.unsupported','then the capability');
check(managementActionReasonKey({demo:false,canOperate:true,offline:false,capabilities:['rename-computer'],domainRole:5,management:false},'rename-computer'),'management.blocked.domainController','then the domain controller');
check(DOMAIN_CONTROLLER_PROTECTED.includes('leave-domain')&&DOMAIN_CONTROLLER_PROTECTED.includes('delete-local-user'),true,'identity and account actions are protected');
check(MANAGEMENT_READ_ACTIONS,['scan-updates','test-connection','refresh'],'read actions');
for(const locale of ['en','de'])for(const key of ['kit.unavailable.demo','management.blocked.manage','management.blocked.diagnose','management.blocked.offline','management.blocked.unsupported','management.blocked.domainController','management.blocked.readOnly']){assert.match(translate(locale,key),/\.$/,`${locale} ${key} is a full sentence`);checks++;}
check(managementActionReason({...open,demo:true},'rename-computer','en'),'Not available for sample devices.','the sentence in English');
check(managementActionReason(open,'rename-computer','de'),'','available');
check([managementMode({management:1,snapshot:{mode:'ReadOnly'}}),managementMode({management:0,snapshot:{mode:'Management'}}),managementMode({management:1,snapshot:null}),managementMode({management:0})],[false,true,true,false],'the reported mode wins over the device flag');

// ---- Review lines ----
const snapshot={hostname:'SRV-01',domain:'WORKGROUP',firewallRules:[{name:'RDP-In',displayName:'Remote Desktop',enabled:true}],tasks:[{name:'Backup',path:'\\Ops\\',state:'Disabled'}]};
check(managementReview('rename-computer',{name:'SRV-02'},snapshot,'en'),'Computer name: SRV-01 → SRV-02','rename');
check(managementReview('rename-computer',{name:'SRV-02',username:'CORP\\admin',password:'secret'},snapshot,'en'),'Computer name: SRV-01 → SRV-02\nDomain account: CORP\\admin','rename with a domain account, no password');
const join=managementReview('join-domain',{domain:'corp.example',ouPath:'',username:'CORP\\admin',password:'secret'},snapshot,'en');
check(join.split('\n')[0],'Domain / workgroup: WORKGROUP → corp.example','join: the change');
assert.ok(join.includes('CORP\\admin')&&!join.includes('secret')&&!join.includes('ouPath'),'join: the account, no password and no empty OU');checks++;
check(managementReview('leave-domain',{workgroup:'WORKGROUP',username:'CORP\\admin',password:'secret'},{...snapshot,domain:'corp.example'},'en').split('\n')[0],'Domain / workgroup: corp.example → WORKGROUP','leave');
check(managementReview('set-firewall-rule',{name:'RDP-In',enabled:false},snapshot,'en'),'Rule: Remote Desktop\nTurned on: Yes → No','firewall');
check(managementReview('set-task',{name:'Backup',path:'\\Ops\\',enabled:true},snapshot,'en'),'Task: \\Ops\\Backup\nTurned on: No → Yes','task');
check(reviewParameters({name:'x',password:'secret',secrets:'y',empty:''},'en'),'Name: x','passwords, secrets and empty values never show');
check(confirmationDevice('SRV-01','de'),[{label:'Gerät',value:'SRV-01'}],'the device line');
// The classic ManagementPanel is gone; the Accounts and Roles & features panels use the same helpers.
assert.equal(existsSync('app/management-panel.tsx'),false,'app/management-panel.tsx no longer exists');
for(const file of ['ui/devices/management/device-accounts.tsx','ui/devices/management/roles-features.tsx']){const source=readFileSync(file,'utf8');assert.match(source,/managementActionReason\(/,file);assert.match(source,/managementReview\(/,file);assert.match(source,/confirmationDevice\(/,file);}
// operationLabel moved here with the same output: an action label, another management label, or the kind itself.
check(['install-feature','delete-local-user','start-service','install-gpu-driver','refresh','unknown-kind'].map(kind=>operationLabel(kind,'en')),['Install role / feature','Delete local user','Start service','Update graphics driver','Refresh inventory','unknown-kind'],'operationLabel in English');
check(['install-feature','delete-local-user','start-service','install-gpu-driver','refresh','unknown-kind'].map(kind=>operationLabel(kind,'de')),['Rolle / Feature installieren','Lokalen Benutzer löschen','Dienst starten','Grafiktreiber aktualisieren','Inventar aktualisieren','unknown-kind'],'operationLabel in German');
check(operationLabel('__proto__','en'),'__proto__','no prototype key');
assert.match(readFileSync('ui/shell/console-jobs.tsx','utf8'),/import \{operationLabel\} from '@\/ui\/devices\/management\/management-actions';/,'the job dock imports it from the lib');
checks+=8;
console.log(`PASS management actions (${checks} checks): every reason branch and its order (demo, right, offline, capability, domain controller, mode), full sentences, the review lines of rename, join, leave, firewall and task, the device line, operationLabel in English and German, and the panels on the shared helpers without the classic ManagementPanel.`);
