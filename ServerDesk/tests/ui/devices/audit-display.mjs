// The display map of stored audit actions and targets (ui/devices/history/audit-display.ts) and the Area of a row, pure: a source scan of every writer
// in lib/, app/api/, runtime/ and scripts/ (tests/support/audit-writers.mjs) finds each literal action, and each one,
// every writer constant, every operation and diagnostic label and the dynamic families resolve to a known code with
// a label in both catalogs. Unknown codes and free text, the categories, the readable target rules and the search.
// The server-written targets in German or English (usage data, agent releases, vulnerability check, idle timeout and
// MFA, automation assignments, cross-customer counts with the Defender label) show in the viewer's language; the
// fixtures come from the writers' own helpers and constants, and a pattern applies only to its action code.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {scanAuditActions} from '../../support/audit-writers.mjs';
const display=await import('../../../ui/devices/history/audit-display.ts');
const {auditActionView,auditTargetView,activitySearchText,activityCsv,activityCsvFileName,auditActionCodes,activityCategories,codeShape}=display;
const {default:en}=await import('../../../lib/i18n/messages/en.ts');
const {default:de}=await import('../../../lib/i18n/messages/de.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
const {operations}=await import('../../../lib/management.ts');
const {diagnosticDefinitions}=await import('../../../lib/diagnostics.ts');
const {AGENT_INTEGRITY_KINDS}=await import('../../../lib/agent-integrity-contract.ts');
const {DHCP_CHANGE_OPERATIONS,DNS_CHANGE_OPERATIONS}=await import('../../../lib/plugin-catalog.ts');
const {dhcpAuditAction}=await import('../../../lib/server/extensions/dhcp-manage.ts').catch(()=>({}));
const actions=await import('../../../lib/audit-actions.ts');
const runtimeActions=await import('../../../runtime/audit-actions.mjs');
const {jobActionLabel}=await import('../../../ui/shell/console-jobs.tsx');
// The writers of the server-written targets that the audit log translates: the fixtures come from them.
const {idleTimeoutAuditTarget,idleMfaAuditTarget}=await import('../../../lib/server/identity/session-settings.ts');
const {automationAssignmentAuditTarget}=await import('../../../lib/server/automation/automation-scopes.ts');
const {crossCustomerAuditTarget}=await import('../../../lib/server/identity/cross-customer.ts');
const {usageDataAudit}=await import('../../../lib/server/usage-data.ts');
const {releaseSourceAuditTarget}=await import('../../../lib/server/agent/release-source.ts');
const {vulnerabilityAuditTarget}=await import('../../../lib/server/devices/vulnerabilities.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};

/** A stored value resolves: a known code with its key in both catalogs, or a job action. */
function resolves(value,where){
 const view=auditActionView(value);
 ok(view.known,`${JSON.stringify(value)} (${where}) maps to a known code`);
 if(view.label==='job'){ok(view.code.startsWith('job.')&&!!view.jobKind,`${JSON.stringify(value)} is a job action`);return view;}
 ok(view.labelKey===`audit.action.${view.code}`&&typeof en[view.labelKey]==='string'&&typeof de[view.labelKey]==='string',`${view.code} has its label in en and de`);
 return view;
}

// ---- every literal action of every writer ----
const found=scanAuditActions('.');
ok(found.length>=150,`the scan finds the writers (${found.length} literals)`);
for(const form of ['log','auditEvent','audit entry','insert','assignment','customerEntries'])ok(found.some(item=>item.form===form),`the scan covers the ${form} form`);
ok(found.some(item=>item.form.startsWith('wrapper ')),'the scan covers wrappers with an action parameter');
ok(found.some(item=>item.form.startsWith('constant ')),'the scan covers the constant maps');
for(const item of found){
 // 'agent.integrity.'+kind is a prefix of the dynamic family below.
 if(item.value.endsWith('.'))continue;
 resolves(item.value,`${item.file}, ${item.form}`);
}
// The writer constants, all of them, through the imports (a changed constant cannot drift).
for(const [name,value] of [...Object.entries(actions),...Object.entries(runtimeActions)]){
 const values=typeof value==='string'?[value]:Object.values(value);
 for(const text of values)resolves(text,name);
}
// Every operation and diagnostic label (lib/server/devices/device-job-queue.ts writes it as the job's action): job.<kind> with jobActionLabel.
for(const [kind,definition] of [...Object.entries(operations),...Object.entries(diagnosticDefinitions)]){
 const view=resolves(definition.label,kind);
 check([view.code,view.jobKind,view.category],[`job.${kind}`,kind,'jobs'],`${definition.label} → job.${kind}`);
}
check(auditActionView('assistant.powershell').code,'job.assistant-powershell','the assistant script job');
// The dynamic families: every alert action, every integrity kind, both ESU actions, the DHCP and DNS labels.
for(const action of ['acknowledge','mute','unmute'])resolves(`alert.${action}`,'lib/server/devices/alerts.ts');
for(const kind of AGENT_INTEGRITY_KINDS)resolves(`agent.integrity.${kind}`,'lib/server/agent/agent-integrity.ts');
for(const code of ['os-esu.set','os-esu.clear'])resolves(code,'lib/server/devices/os-esu.ts');
for(const operation of [...DHCP_CHANGE_OPERATIONS,...DNS_CHANGE_OPERATIONS]){
 const label=translate('en',(await import('../../../lib/job-display.ts')).pluginJobLabelKey('plugin-job',operation));
 const view=resolves(label,operation);
 check([view.code,view.jobKind,view.jobTarget],[`job.${operation}`,'plugin-job',operation],`${label} → job.${operation}`);
}
if(dhcpAuditAction)check(auditActionView(dhcpAuditAction('dhcp-scope-create')).code,'job.dhcp-scope-create','dhcpAuditAction resolves');

// ---- Fixtures of the spec ----
const label=(view,locale)=>view.labelKey?translate(locale,view.labelKey):jobActionLabel(view.jobKind,locale,view.jobTarget);
let view=auditActionView('Terminal geschlossen');
check([view.code,label(view,'en'),label(view,'de')],['terminal.close','Terminal closed','Terminal geschlossen'],'a German text gets its code and the English label in en');
view=auditActionView('Plugin removal queued');
check([view.code,label(view,'de')],['plugin.remove.queued','Entfernen einer Erweiterung in Warteschlange'],'an English text gets the German label in de');
view=auditActionView('Computer umbenennen');
check([view.code,view.label,view.jobKind,label(view,'en')],['job.rename-computer','job','rename-computer',jobActionLabel('rename-computer','en')],'an operation label is job.<kind> with jobActionLabel');
check(auditActionView('tag.set').code,'tag.set','a stored code maps to itself');
// ---- unknown values ----
view=auditActionView('foo.bar-baz');
check([view.code,view.known,view.labelKey],['foo.bar-baz',false,undefined],'an unknown code is shown as the code, without a label');
view=auditActionView('Irgendein Text');
check([view.code,view.known,translate('en',view.labelKey),translate('de',view.labelKey)],['',false,'Unlisted action','Nicht zugeordnete Aktion'],'free text is "Unlisted action"');
ok(codeShape.test('a.b-c')&&!codeShape.test('Irgendein Text')&&!codeShape.test('Tag.set'),'the code shape');
// No German text is ever the English label, and no English text the German one.
for(const code of Object.keys(auditActionCodes)){
 const key=`audit.action.${code}`;
 ok(!/[äöüß]|\b(geändert|gelöscht|erstellt|entfernt)\b/i.test(en[key]),`${key}: the English label is English`);
}

// ---- every known code has a category ----
for(const [code,category] of Object.entries(auditActionCodes))ok(activityCategories.includes(category),`${code} has a category`);
check(['auth.login','mfa.setup','passkey.signIn','auth.lockout','auth.emergency.login'].map(code=>auditActionView(code).category),['signIn','signIn','signIn','signIn','signIn'],'sign-in, MFA, passkeys, lockout and emergency access');
check(['auth.user.create','roleAssignment.create','technician.update','installer.revoke'].map(code=>auditActionView(code).category),['accounts','accounts','accounts','accounts'],'accounts, roles, assignments, technicians and installers');
check(['device.name.set','tag.set','os-esu.set','deviceGroup.create','agent.integrity.service-stopped','agent.update.schedule','agent.uninstall.start','device.remove'].map(code=>auditActionView(code).category),Array(8).fill('devices'),'device facts, groups, integrity, update, uninstall and removal');
check(['terminal.open','rdp.open','transfer.upload','runbook.start','desired.apply','drift.enable','defender.crossCustomer','plugin.install.queued','plugin.ad.signIn','assistant.ask'].map(code=>auditActionView(code).category),Array(10).fill('jobs'),'jobs and remote access');
check(['auth.entra.settings.update','session.idleTimeout.set','notification-channel.create','retention.audit.apply','assistant.organization-key.set','alert-rule.set','release.import'].map(code=>auditActionView(code).category),Array(7).fill('settings'),'settings');
check(auditActionView('alert.mute').category,'other','the rest');

// ---- the target rules, in order ----
const devices=new Map([['5f3e1a2b-1111-4222-8333-444455556666','SRV-01']]);
let target=auditTargetView({target:'4d2c@local.serverdesk.invalid',targetName:'Anna Admin'},{deviceNames:devices});
check(target,{text:'Anna Admin',mono:false,details:[{label:'Account ID',value:'4d2c@local.serverdesk.invalid'}]},'1. targetName: the name, the stored value as Account ID');
target=auditTargetView({target:JSON.stringify({provider:'openai',model:'gpt-x',followUp:true})});
check(target,{text:'gpt-x',mono:false,details:[{label:'provider',value:'openai'},{label:'model',value:'gpt-x'},{label:'followUp',value:'true'}]},'2. JSON: the first name-like value, one detail per key');
check(auditTargetView({target:JSON.stringify({a:{b:1}})}).text,'—','2. JSON without a name-like key');
check(auditTargetView({target:JSON.stringify({a:{b:1}})}).details,[{label:'a',value:'{"b":1}'}],'2. nested values as compact JSON');
target=auditTargetView({target:'reason=not-in-group user=anna@contoso.com tenant=t1'});
check(target,{text:'anna@contoso.com',mono:false,details:[{label:'reason',value:'not-in-group'},{label:'user',value:'anna@contoso.com'},{label:'tenant',value:'t1'}]},'3. key=value: the user first, one detail per pair');
check(auditTargetView({target:'emergency=e1 locked=3'}).text,'emergency=e1','3. without a named key: the first pair');
target=auditTargetView({target:'5f3e1a2b-1111-4222-8333-444455556666'},{deviceNames:devices});
check([target.text,target.mono],['SRV-01',false],'4. a device GUID: the device name');
target=auditTargetView({target:'5f3e1a2b-9999-4222-8333-444455556666'},{deviceNames:devices});
check([target.text,target.mono,target.details],['ID 5f3e1a2b…',true,[{label:'id',value:'5f3e1a2b-9999-4222-8333-444455556666'}]],'4. a foreign GUID: "ID 5f3e1a2b…" in mono with the full id');
target=auditTargetView({target:'local:abc@local.serverdesk.invalid'},{locale:'de'});
check([target.text,target.details[0].value],['Internes Konto','local:abc@local.serverdesk.invalid'],'5. an internal account without a name');
check(auditTargetView({target:'SRV-01 / Spooler'}),{text:'SRV-01 / Spooler',mono:false,details:[]},'6. other text unchanged');

// ---- server-written targets in the viewer's language (before rule 6) ----
const shown=(target,action,locale)=>auditTargetView({target,action},{locale});
const plain=view=>({...view,text:view.text.replaceAll('\u00a0',' ')});
// The writers still store exactly today's German text (no migration, stored rows unchanged).
check([idleTimeoutAuditTarget(30,60),idleMfaAuditTarget(true,false),automationAssignmentAuditTarget('Patch Tuesday','group'),automationAssignmentAuditTarget('Patch Tuesday','device'),crossCustomerAuditTarget('x',3,10)],
 ['30 → 60 Minuten','an → aus','Patch Tuesday · Gruppe','Patch Tuesday · Gerät','x · 3 von 10 Geräten'],'the writer helpers keep the stored form');
const translated=(target,action,en,de,label)=>{
 check(plain(shown(target,action,'en')),{text:en,mono:false,details:[]},`${label} (en)`);
 check(plain(shown(target,action,'de')),{text:de,mono:false,details:[]},`${label} (de)`);
};
translated(usageDataAudit.target,usageDataAudit.enabled,'Data for product improvement','Daten zur Produktverbesserung','the usage data target');
translated(releaseSourceAuditTarget,actions.retiredReleaseSourceAuditActions.tokenSet,'Agent releases','Agent-Releases','the agent release source target of an old token row');
translated(releaseSourceAuditTarget,actions.releaseSourceAuditActions.checkRequested,'Agent releases','Agent-Releases','the agent release source target of a check');
// The release source has no token since the repository is public: Check now and the dev builds switch write. Old token rows keep their labels.
translated(releaseSourceAuditTarget,actions.releaseSourceAuditActions.devBuildsOn,'Agent releases','Agent-Releases','the agent release source target of the dev builds switch');
check(Object.keys(actions.releaseSourceAuditActions),['checkRequested','devBuildsOn','devBuildsOff'],'releaseSourceAuditActions has checkRequested and the dev builds switch');
check(actions.retiredReleaseSourceAuditActions,{tokenSet:'GitHub token for agent releases saved',tokenRemoved:'GitHub token for agent releases removed'},'the retired texts, display only');
for(const [action,code,enText,deText] of [['GitHub token for agent releases saved','release.token.set','GitHub token for agent releases saved','GitHub-Token für Agent-Releases gespeichert'],['GitHub token for agent releases removed','release.token.remove','GitHub token for agent releases removed','GitHub-Token für Agent-Releases entfernt']]){
 const view=auditActionView(action);
 check([view.known,view.code,view.labelKey,en[view.labelKey],de[view.labelKey]],[true,code,`audit.action.${code}`,enText,deText],`an old row "${action}" shows its catalog label in en and de`);
 check([view.category,auditActionCodes[code]],['settings','settings'],`${code} is in the category settings`);
}
{
 // No writer imports the retired constant: only the display map reads it.
 const {readdirSync,readFileSync}=await import('node:fs');
 const files=dir=>readdirSync(dir,{recursive:true}).map(String).filter(file=>/\.(ts|tsx|mjs)$/.test(file)).map(file=>dir+'/'+file.replaceAll('\\','/'));
 check([...files('lib/server'),...files('app'),...files('runtime'),...files('scripts')].filter(file=>/retiredReleaseSourceAuditActions/.test(readFileSync(file,'utf8'))),[],'no file under lib/server, app, runtime or scripts uses the retired constant');
}
translated(vulnerabilityAuditTarget,actions.vulnerabilityAuditActions.on,'Vulnerability check','Schwachstellenprüfung','the vulnerability check target');
translated(idleTimeoutAuditTarget(30,60),actions.sessionIdleTimeoutAuditAction,'30 min → 1 h','30 Min → 1 Std','the idle timeout through formatDuration');
translated(idleMfaAuditTarget(true,false),actions.sessionIdleRequiresMfaAuditAction,'On → Off','Ein → Aus','MFA after an automatic logout');
translated(automationAssignmentAuditTarget('Patch Tuesday','group'),'Automatisierung zugewiesen','Patch Tuesday · Group','Patch Tuesday · Gruppe','an assignment to a group');
translated(automationAssignmentAuditTarget('Patch Tuesday','device'),'Geerbte Automatisierung ausgesetzt','Patch Tuesday · Device','Patch Tuesday · Gerät','an inherited assignment suspended on a device');
translated(crossCustomerAuditTarget('4.7.0',3,10),'Agent-Update kundenübergreifend geplant','4.7.0 · 3 of 10 devices','4.7.0 · 3 von 10 Geräten','a cross-customer entry: the count in the viewer\'s language');
translated(crossCustomerAuditTarget('4.7.0',1,1),'Agent-Update kundenübergreifend geplant','4.7.0 · 1 of 1 device','4.7.0 · 1 von 1 Gerät','a cross-customer entry of one device');
// The Defender bulk action stores the German operation label as its inner target: the job's own label.
translated(crossCustomerAuditTarget(operations['defender-quick-scan'].label,2,5),'Defender-Aktion kundenübergreifend gestartet',
 `${jobActionLabel('defender-quick-scan','en')} · 2 of 5 devices`,`${jobActionLabel('defender-quick-scan','de')} · 2 von 5 Geräten`,'the Defender label in the viewer\'s language');
ok(!/[äöüß]|Schnellscan|starten/i.test(shown(crossCustomerAuditTarget(operations['defender-quick-scan'].label,2,5),'Defender-Aktion kundenübergreifend gestartet','en').text),'the English Defender row has no German word');
// A pattern with another action code stays as stored.
check(shown(idleTimeoutAuditTarget(30,60),'tag.set','en').text,'30 → 60 Minuten','the idle timeout pattern needs its action code');
check(shown(idleMfaAuditTarget(true,false),actions.sessionIdleTimeoutAuditAction,'en').text,'an → aus','the MFA pattern needs its action code');
check(shown(automationAssignmentAuditTarget('Patch Tuesday','group'),'Automatisierungszuweisung entfernt','en').text,'Patch Tuesday · Gruppe','the assignment pattern needs its action code');
// The search uses the translated text, as for the other target rules.
{
 const entry={actor:'Anna',target:automationAssignmentAuditTarget('Patch Tuesday','group'),action:'Automatisierung zugewiesen'};
 const view=auditActionView(entry.action),row={action:view,label:translate('en',view.labelKey),target:auditTargetView(entry,{locale:'en'})};
 const search=activitySearchText(entry,row);
 ok(search.includes('patch tuesday · group')&&!search.includes('gruppe'),'the search text holds the translated target');
}
check(auditTargetView({target:''}).text,'—','6. empty');

// ---- the search text ----
const entry={actor:'Anna',target:'reason=x user=bob@contoso.com',action:'auth.entra.login.refused'};
const action=auditActionView(entry.action),row={action,label:translate('de',action.labelKey),target:auditTargetView(entry)};
const text=activitySearchText(entry,row,'SRV-01');
ok(text.includes('auth.entra.login.refused')&&text.includes('bob@contoso.com')&&text.includes('entra-anmeldung abgelehnt')&&text.includes('srv-01')&&text.includes('anna'),'the search covers code, readable target, label, account and device');

// ---- CSV helpers ----
const csv=activityCsv(['Zeit','Ziel'],[['2026-01-01T00:00:00.000Z','=cmd'],['x','a"b']]);
check(csv,'﻿"Zeit";"Ziel"\r\n"2026-01-01T00:00:00.000Z";"\'=cmd"\r\n"x";"a""b"','the CSV quotes, guards formulas and uses CRLF');
check(activityCsvFileName('audit-log',new Date(2026,10,13,9).getTime()),'audit-log-2026-11-13.csv','the file name');
// The Area of a row (table, CSV and drawer): the customer, a deleted customer with its last name, or the portal.
check(['de','en'].map(locale=>[display.auditAreaText({customerName:'Acme',customerRemoved:true},locale),display.auditAreaText({customerName:'Acme',customerRemoved:false},locale),display.auditAreaText({customerName:null},locale)]),
 [['Acme (gelöscht)','Acme',translate('de','audit.portal')],['Acme (deleted)','Acme',translate('en','audit.portal')]],'the Area texts');
check([auditActionView(actions.customerAuditActions.delete).category,auditActionView(actions.customerAuditActions.delete).labelKey],['settings','audit.action.customer.delete'],'customer.delete is a settings entry');
const customerMove=auditActionView(actions.deviceCustomerAuditActions.move);
check([customerMove.known,customerMove.code,customerMove.category,customerMove.labelKey],[true,'device.customer.move','devices','audit.action.device.customer.move'],'device.customer.move is a devices entry');

console.log(`PASS audit display (${checks} checks): every writer literal, constant, operation label and dynamic family maps to a code with a label in both catalogs; unknown codes and free text; categories; the target rules; the search and the CSV.`);
