// UI-Rework 15: one word per idea and one sentence form in both catalogs (the glossary of the skill
// nodiverna-ui §5), and no visible literal, hand-built unit, en dash placeholder, em dash literal (the missing value is
// EMPTY_VALUE) or fixed-locale lower-casing under app/ and ui/. Each allowlist is a key list with its reason; the test also asserts that
// every allowlisted key exists and still contains the word, so no entry goes stale.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {translatedFiles} from '../support/translated-files.mjs';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const en=(await import('../../lib/i18n/messages/en.ts')).default,de=(await import('../../lib/i18n/messages/de.ts')).default;
const enServer=(await import('../../lib/i18n/messages/en-server.ts')).default,deServer=(await import('../../lib/i18n/messages/de-server.ts')).default;
const {translate}=await import('../../lib/i18n/translate.ts');
const read=file=>readFileSync(file,'utf8');
const walk=dir=>readdirSync(dir).flatMap(name=>{const file=path.posix.join(dir,name);return statSync(file).isDirectory()?walk(file):/\.(ts|tsx)$/.test(file)?[file]:[];});
const values=message=>message==null?[]:typeof message==='string'?[message]:[message.one,message.other];
// Placeholders are names, not words: "{right}" is no "right".
const words=value=>value.replace(/\{\w+\}/g,'');
// Palette search synonyms (*Keywords) are no visible copy; the term rules skip them.
const visibleKeys=Object.keys(en).filter(key=>!/Keywords$/.test(key));
ok(Object.keys(enServer).every(key=>key in en)&&Object.keys(deServer).every(key=>key in de),'the server catalogs are part of the guarded catalogs');

/** Keys of catalog whose value (any plural form) matches test, minus the allowlist, which must stay current. */
function termRule(name,catalog,test,allow={}){
 const allowed=new Map(Object.entries(allow).flatMap(([reason,keys])=>keys.map(key=>[key,reason])));
 for(const key of allowed.keys())ok(key in catalog&&values(catalog[key]).some(value=>test(words(value))),`${name}: the allowlisted key ${key} exists and still holds the word`);
 check(visibleKeys.filter(key=>!allowed.has(key)&&values(catalog[key]).some(value=>test(words(value)))),[],name);
}

// ── Term rules ─────────────────────────────────────────────────────────────────
termRule('no "Kennwort" in German',de,value=>/kennw/i.test(value));
termRule('no "Automatisierung" in German',de,value=>/Automatisierung/i.test(value));
// the spec: a German create action says "erstellen"; "erzeugen" stays only for non-actions (rules that produce issues) and Generate.
check(visibleKeys.filter(key=>values(de[key]).some(value=>/anleg|angelegt|erzeug|anzuleg/i.test(value))&&values(en[key]).some(value=>/creat/i.test(value))),[],'no create action says "anlegen" or "erzeugen"');
termRule('"permission", never "right(s)"',en,value=>/\brights?\b/i.test(value),{
 'a direction or a moment, not a permission':['apiError.mfa.passkeysUnusableHere','help.account.tip4','storage.confirm.description','agentUpdates.fleet.none','agentUpdates.fleet.noneEligible'],
 'Windows and Active Directory rights on the server':['management.users.createDescription','management.groups.addDescription','agentMessage.AGENT_UNINSTALL_NOT_ADMIN','pluginAd.signIn.bodyDomain','pluginAd.signIn.bodyLocal','agentMessage.AGENT_AD_NO_LOGON_RIGHT','help.dhcp.tip3'],
});
termRule('"Berechtigung", never "Recht(e)"',de,value=>/\bRecht(?:e|en)?\b/.test(value),{
 'Windows and Active Directory rights on the server':['management.groups.addDescription','pluginAd.signIn.bodyDomain','pluginAd.signIn.bodyLocal','help.dhcp.tip3'],
});
const windowsUsers={
 'local Windows users of the device (Management → Accounts)':['operation.createLocalUser','operation.setLocalUser','operation.deleteLocalUser','management.review.user','management.localUser','management.users.title','management.users.create','management.users.user','management.users.editDescription','management.users.deleteDescription','management.users.dcHint','management.users.noInventory','management.action.createLocalUser','management.action.setLocalUser','management.action.deleteLocalUser','accounts.description','accounts.metaUsers','accounts.readOnly','accounts.kpi.users','accounts.showDisabled','accounts.menu.edit','accounts.menu.delete','accounts.confirm.create','accounts.confirm.edit','accounts.confirm.delete','accounts.title.create','accounts.title.edit','accounts.title.delete','accounts.foot','accounts.blocked.noUsersOrGroups','agentMessage.AGENT_USER_CREATED','agentMessage.AGENT_USER_UPDATED','agentMessage.AGENT_USER_DELETED','agentMessage.AGENT_USER_INVENTORY_TOO_LARGE','agentMessage.AGENT_USER_CREATE_FAILED','agentMessage.AGENT_USER_CREATE_FAILED_PARAMETER','agentMessage.AGENT_USER_DELETE_FAILED','agentMessage.AGENT_USER_READ_FAILED','agentMessage.AGENT_USERS_READ_FAILED','agentMessage.AGENT_USER_UPDATE_FAILED','agentMessage.AGENT_USER_UPDATE_FAILED_PARAMETER','agentMessage.AGENT_UNKNOWN_USER_ACTION'],
 'Windows user sessions and process owners on the device':['operation.listSessions','operation.messageSession','operation.disconnectSession','operation.logoffSession','diagnostics.processes.filterPlaceholder','diagnostics.processes.allUsers','diagnostics.userSession','diagnostics.sessions.none','diagnostics.sessions.logoff','diagnostics.sessions.logoffTitle','diagnostics.sessions.messageLabel','diagnostics.sessions.noUser','diagnostics.connections.filterPlaceholder','diagnostics.connections.userHint','agentMessage.AGENT_SESSION_CHANGED'],
 'other Windows meanings: the RDP sign-in, user interaction, the user store, per-user software, user folders, the detection user, the DHCP user class':['agentMessage.AGENT_UPDATES_INTERACTIVE','rdp.account.invalid','rdp.panel.leaveHint','rdp.client.userPlaceholder','troubleshooting.portal.result','software.scope.machine','software.scope.user','alertRules.rule.autostartNewSuspicious.info','alertRules.rule.autostartNewSuspicious.warning','alertRules.rule.autostartNewSuspicious.critical','defender.col.user','agentMessage.PLUGIN_DHCP_ACCESS_DENIED','dhcp.col.userClass','dhcp.criterion.userClass','dhcp.field.userClass','jobs.input.userClass','jobs.input.username','agentMessage.AGENT_AD_NO_LOGON_RIGHT'],
};
termRule('"account", never "user" for a portal identity',en,value=>/\busers?\b/i.test(value.replace(/\buser groups?\b/gi,'').replace(/\busernames?\b/gi,'')),{
 ...windowsUsers,
 'English only: process owners and user-bound keys (Windows users)':['diagnostics.processes.user'],
 'Microsoft names (per-user MFA, the Graph permission User.Read.All)':['apiError.entra.confirm.mfaMissing','entra.error.mfaMissing','help.entra.tip2','entra.test.graphPermissionMissing','entra.check.result.permissionMissing'],
});
termRule('"Konto", never "Benutzer" for a portal identity',de,value=>/Benutzer(?!gruppe|name)/.test(value),{...windowsUsers,'the Microsoft name of per-user MFA (MFA pro Benutzer)':['apiError.entra.confirm.mfaMissing','entra.error.mfaMissing','help.entra.tip2']});
check([en['accounts.noMatch'],de['accounts.noMatch']].length&&[en['customers.users'],de['customers.users']],[{one:'1 account',other:'{count} accounts'},{one:'1 Konto',other:'{count} Konten'}],'customers.users counts accounts');
check(visibleKeys.filter(key=>de[key]==='An'),[],'no German state value "An"');
termRule('"issue" or "alarm", never "problem"',en,value=>/\bproblems?\b/i.test(value),{
 'Windows Device Manager names the device state "problem"':['deviceProblem.code.43','deviceProblem.code.48','deviceProblem.unknown','drivers.problems.title','drivers.problems.none','drivers.col.problem','help.drivers.tip1'],
 'the plain word for what people ask the AI assistant about (exact copy, pinned in copy-plain-language.mjs)':['assistant.empty.text'],
});
termRule('never "note(s)"',en,value=>/\bnotes?\b/i.test(value));
for(const [label,catalog,pattern] of [
 ['no ReadOnly as a mode name',en,/ReadOnly/],['no ReadOnly as a mode name (de)',de,/ReadOnly|Nur-Lese-Modus/],
 ['no "Campaign"',en,/Campaign/i],['no "Kampagne"',de,/Kampagne/i],
 ['no old label (en)',en,/Portal log\b|Users & access|Runbooks & schedules|Assign devices|Bring devices|^30 minutes$/],
 ['no old label (de)',de,/Portalprotokoll|Benutzer & Rechte|Runbooks & Zeitpläne|Geräte zuordnen|^30 Minuten$/],
 ['no "Reset filter" or "Clear filter"',en,/Reset filter\b(?!s)|Clear filter/],['no "Geräte zeigen"',de,/Geräte zeigen/],
 ['no space before … and no "..." (en)',en,/ …|\.\.\./],['no space before … and no "..." (de)',de,/ …|\.\.\./],
])check(visibleKeys.filter(key=>values(catalog[key]).some(value=>pattern.test(value))),[],label);
check(Object.keys(en).filter(key=>/^jobs?\b|^page-jobs/.test(key)&&/Keywords$/.test(key)&&/\btasks?\b/.test(String(en[key]))),[],'T10: no job keyword "tasks"');
ok(!/jobs:\{[^}]*keywords:'[^']*\btasks\b/.test(read('ui/shell/nav-model.ts')),'T10: the jobs page has no palette keyword "tasks"');
// The documentation quotes portal labels in bold; a renamed label must not stay behind under its old text.
const oldLabels=['Disable…','Disable release','Disable or delete a release:','Enable policy','Disable policy','User name','No group','Reset filter','Clear filter','Reset search and filter','Portal log','Users & access','Assign devices','The driver list is not available.','Kennwort','Automatisierung'];
const docFiles=['../README.md',...readdirSync('docs').filter(name=>name.endsWith('.md')).map(name=>'docs/'+name)];
check(docFiles.flatMap(file=>[...read(file).matchAll(/\*\*([^*\n]+)\*\*/g)].filter(match=>oldLabels.includes(match[1])).map(match=>`${file}: **${match[1]}**`)),[],'no doc quotes a renamed portal label in bold');

// ── Exact values (the glossary and the UI copy of the spec) ─────────────────────────────────────
const plural=(one,other)=>({one,other});
const exact={
 'problems.foot':[plural('{shown} of 1 device with open alarms','{shown} of {count} devices with open alarms'),plural('{shown} von 1 Gerät mit offenen Alarmen','{shown} von {count} Geräten mit offenen Alarmen')],
 'rbac.subjectColumn':['Account or user group','Konto oder Benutzergruppe'],
 'rbac.subject.userStatus':['Account · {statusLabel}','Konto · {statusLabel}'],
 'groups.noGroup':['Ungrouped','Ohne Gruppe'],
 'console.movedOneUngrouped':['{name} moved to “Ungrouped”.','{name} nach „Ohne Gruppe“ verschoben.'],
 'console.movedManyUngrouped':[plural('{count} device moved to “Ungrouped”.','{count} devices moved to “Ungrouped”.'),de['console.movedManyUngrouped']],
 'apiError.customer.installerGroupMismatch':['Select a device group of this customer or “Ungrouped”.',de['apiError.customer.installerGroupMismatch']],
 'runbooks.none':['No runbooks yet','Noch keine Runbooks'],
 'audit.emptyTitle':['No audit entries yet','Noch keine Audit-Einträge'],
 // The Overview usage card reads device.summary.utilization; device.summary.history stays the History area name.
 'device.summary.utilization':['Utilization','Auslastung'],'device.summary.history':['History','Verlauf'],
 'device.summary.range30':['30 min','30 Min'],'device.summary.range60':['1 h','1 Std'],'device.summary.range360':['6 h','6 Std'],'device.summary.range1440':['24 h','24 Std'],
 'jobs.dock.running':[plural('{count} running','{count} running'),plural('{count} läuft','{count} laufen')],
 'jobs.dock.waiting':[plural('{count} waiting','{count} waiting'),plural('{count} wartet','{count} warten')],
 'customers.users':[plural('1 account','{count} accounts'),plural('1 Konto','{count} Konten')],
 // An Empty title: the spec sentence without its period.
 'accounts.noMatch':['No account matches the search','Kein Konto passt zur Suche'],
 'files.blocked.write':['You don\'t have permission to change files on this device.','Dir fehlt die Berechtigung, auf diesem Gerät Dateien zu ändern.'],
 'rdp.panel.enable':['Turn on Remote Desktop','Remote Desktop einschalten'],'rdp.panel.disable':['Turn off Remote Desktop','Remote Desktop ausschalten'],
 'rdp.panel.enableTitle':['Turn on Remote Desktop?','Remote Desktop einschalten?'],'rdp.panel.disableTitle':['Turn off Remote Desktop?','Remote Desktop ausschalten?'],
 'management.enable':['Turn on','Einschalten'],'management.disable':['Turn off','Ausschalten'],
 'entra.status.on':[en['entra.status.on'],'Ein'],'notifications.status.on':[en['notifications.status.on'],'Ein'],'alertRules.status.on':[en['alertRules.status.on'],'Ein'],
 'customers.toast.created':['Customer created.','Kunde erstellt.'],
 'audit.action.auth.user.create':['Account created','Konto erstellt'],'audit.action.auth.owner.bootstrap':['First Owner account created','Erstes Owner-Konto erstellt'],
 'audit.action.automation.template.create':[en['audit.action.automation.template.create'],'Automationsvorlage erstellt'],
 'audit.action.transfer.upload':[en['audit.action.transfer.upload'],'Dateiupload erstellt'],
 'hardware.collectionNotes':['Collection issues · {length}','Erfassungshinweise · {length}'],
 'extensions.empty.showDevices':['Show devices','Geräte anzeigen'],
 'shortcuts.automation':['Automation','Automation'],'help.doc.automation':['Automation','Automation'],'rbac.category.automation':['Automation','Automation'],
 'help.deviceAutomation.title':[en['help.deviceAutomation.title'],'Automation am Gerät'],'automation.loading':[en['automation.loading'],'Automation wird geladen'],
 'storage.format':['Format…','Formatieren…'],'storage.deletePartition':['Delete partition…','Partition löschen…'],
 'alarms.menu.mute':['Mute…','Stummschalten…'],'terminal.connecting':['Connecting…','Verbindung wird aufgebaut…'],
 'kit.unavailable.demo':['Not available for sample devices.','Bei Beispielgeräten nicht möglich.'],
 'fleet.empty.resetFilter':['Reset filters','Filter zurücksetzen'],'fleet.analysis.clearSearch':['Clear search','Suche löschen'],'fleet.analysis.showAll':['Show all','Alle anzeigen'],
 'kit.unit.ms':['ms','ms'],'kit.unit.s':['s','s'],'kit.unit.min':['min','Min'],'kit.unit.h':['h','Std'],'kit.unit.hoursMinutes':['{hours} h {minutes} min','{hours} Std {minutes} Min'],
 // L7, built earlier: the drive reports its own state.
 'diskHealth.col.health':['Reported state','Gemeldeter Zustand'],'hardware.health':['Reported state','Gemeldeter Zustand'],'diskHealth.status.healthy':['OK','In Ordnung'],
};
for(const [key,[english,german]] of Object.entries(exact))check([en[key],de[key]],[english,german],key);
ok(/einschalten/i.test(de['management.tasks.enableDescription'])&&/ausschalten/i.test(de['management.tasks.disableDescription']),'the task descriptions say einschalten / ausschalten');
for(const key of ['device.overview.range30','device.overview.range60','device.overview.range360','device.overview.range1440','common.demoBlocked','hardware.unit.celsius','hardware.unit.ms'])ok(!(key in en)&&!(key in de),key+' is removed');
ok(read('ui/devices/hardware/history-range.tsx').includes("t('device.summary.range30')"),'the Overview range switch uses the one range label set');

// ── One key per generic text and plurals ────────────────────────────────────────
const generic=new Set(['Cancel','Close','Save','No changes','No changes.','Saving…','Try again','Not available for sample devices','Not available for sample devices.']);
check(visibleKeys.filter(key=>!/^(?:common|kit)\./.test(key)&&typeof en[key]==='string'&&generic.has(en[key])),[],'generic texts live only in common.* and kit.*');
// Count-neutral strings: symbols and fixed forms whose words do not change with the count.
const countNeutral=['dashboard.alarms.levelCount','dashboard.week.busiest','dashboard.more','dashboard.breakdown.part','dashboard.trend.week','dashboard.health.reasons','dashboard.customers.offline','dashboard.certificates.expired','dashboard.certificates.expiring','dashboard.autostart.suspiciousCount','shell.roles.more','notifyMessage.more','apiError.desired.otherIntervalAssignedMore','apiError.desired.otherVersionAssignedMore','kit.minutesAgo','kit.hoursAgo','jobs.dock.scheduled','jobs.badgeLabel','maintenancePage.result.deleted','maintenancePage.result.deletedMore','maintenancePage.result.cleared','maintenancePage.result.clearedFailed','agentUpdates.fleet.buttonCount','diagnostics.collectedOf','agentMessage.AGENT_DEFENDER_DETECTIONS_CLEANED','vulnerabilities.pill','device.description.counter','device.tags.moreCount','fleet.tags.more','tags.field.counter','diskHealth.unknownErrors','extensions.filter.option','dhcp.kpi.scopesDetail','dhcp.family.v4','dhcp.family.v6','dhcp.leases.truncated','assistantSettings.customers.count','entra.only.confirm.locked','activity.category.option'];
for(const key of countNeutral)ok(typeof en[key]==='string'&&(en[key].includes('{count}')||de[key].includes('{count}')),`${key} is a count-neutral string with {count}`);
check(Object.keys(en).filter(key=>!countNeutral.includes(key)&&(typeof en[key]==='string'&&en[key].includes('{count}')||typeof de[key]==='string'&&de[key].includes('{count}'))),[],'every count that words agree with is a plural object');
check([1,2].map(count=>translate('de','jobs.dock.running',{count})),['1 läuft','2 laufen'],'the German job dock agrees with the count');
check([1,2].map(count=>translate('de','kit.minutesAgo',{count})),['vor 1 Min','vor 2 Min'],'kit.minutesAgo stays correct for 1');

// ── Period rules over the keys that app/ passes ──────────────────────────────────────────
// Three models moved from lib/ to ui/ with lib/server/, and these checks never scanned them: the sample device
// data (ui/shell/demo.ts), the stored audit texts that ui/devices/history/audit-display.ts maps, and the job texts of
// ui/devices/management/management-actions.ts. They stay out, so the checks scan what they scanned before.
const formerLibModels=new Set(['ui/shell/demo.ts','ui/devices/history/audit-display.ts','ui/devices/management/management-actions.ts']);
const appFiles=[...walk('app'),...walk('ui')].filter(file=>!formerLibModels.has(file));
const stripComments=text=>text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:'"`\\])\/\/[^\n]*/g,'$1');
const sources=new Map(appFiles.map(file=>[file,stripComments(read(file))]));
// The expression after `blocked={` (to its closing brace) or `blocked:` (to the next comma or brace at depth 0).
function expressionAfter(text,start,prop){
 let depth=0,quote=null,i=start;
 for(;i<text.length;i++){
  const c=text[i];
  if(quote){if(c==='\\'){i++;continue;}if(c===quote)quote=null;continue;}
  if(c==="'"||c==='"'||c==='`'){quote=c;continue;}
  if('([{'.includes(c))depth++;
  else if(')]}'.includes(c)){if(depth===0)break;depth--;if(prop&&depth===0)return text.slice(start,i+1);}
  else if(c===','&&depth===0&&!prop)break;
 }
 return text.slice(start,i);
}
const keysIn=expression=>[...expression.matchAll(/\bt\(\s*'([\w.-]+)'/g)].map(match=>match[1]);
const collect=(pattern,prop)=>new Set([...sources.values()].flatMap(text=>[...text.matchAll(pattern)].flatMap(match=>keysIn(expressionAfter(text,match.index+match[0].length,prop)))));
const emptyTitles=new Set([...collect(/<Empty\b[^>]*?\btitle=\{/g,true),...[...sources.values()].flatMap(text=>[...text.matchAll(/\{icon:[^{}]*?\btitle:t\('([\w.-]+)'|\bempty=\{\{[^{}]*?\btitle:t\('([\w.-]+)'/g)].map(match=>match[1]??match[2]))]);
const blockedReasons=new Set([...collect(/\bblocked=\{/g,true),...collect(/[{,]\s*blocked:/g,false)]);
const toasts=new Set([...sources.values()].flatMap(text=>[...text.matchAll(/toast\.(?:success|error|info)\(\s*t\('([\w.-]+)'/g)].map(match=>match[1])));
const labels=new Set([...sources.values()].flatMap(text=>[...text.matchAll(/\blabel:\s*t\('([\w.-]+)'/g)].map(match=>match[1])));
ok(emptyTitles.has('runbooks.none')&&emptyTitles.has('audit.emptyTitle')&&emptyTitles.size>150,'the scan finds the Empty titles');
ok(blockedReasons.has('kit.unavailable.demo')&&blockedReasons.size>50&&toasts.size>50&&labels.size>500,'the scan finds blocked reasons, toasts and labels');
const forms=key=>[...values(en[key]),...values(de[key])];
check([...emptyTitles,...blockedReasons,...toasts,...labels].filter(key=>!(key in en)),[],'every scanned key exists');
check([...emptyTitles].filter(key=>forms(key).some(value=>/\.$/.test(value))),[],'Empty titles end without a period');
check([...emptyTitles].filter(key=>forms(key).some(value=>/[.!?]\s+\S/.test(value))),[],'an Empty title holds one sentence');
check([...blockedReasons].filter(key=>forms(key).some(value=>!/[.?]$/.test(value))),[],'blocked reasons end with a period');
check([...toasts].filter(key=>forms(key).some(value=>!/[.?]$/.test(value))),[],'toasts end with a period');
check([...labels].filter(key=>forms(key).some(value=>/[^.]\.$/.test(value))),[],'labels end without a period');

// ── Literals, units, placeholders and lower-casing in app/ ──────────────────────
const visibleProps=new Set(['label','title','placeholder','aria-label','alt','hint','description','content']),objectProps=new Set(['label','title','hint']);
const wordy=value=>/[A-Za-zÄÖÜäöüß]{2}/.test(value);
const isKey=value=>/^[a-z][\w-]*(?:\.[\w-]+)+$/.test(value)&&value in en;
/** The visible literals of a source: JSX text and string literals in the visible props and properties. */
function visibleLiterals(source,file='x.tsx'){
 const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS),found=[];
 const literal=node=>node&&(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))?node.text:null;
 // Text inside code, pre, kbd, Kbd or a .mono element is a technical value: a path, a command, a key cap.
 const technical=node=>{
  const opening=node.parent&&ts.isJsxElement(node.parent)?node.parent.openingElement:null;
  if(!opening)return false;
  if(['code','pre','kbd','Kbd'].includes(opening.tagName.getText(sf)))return true;
  return opening.attributes.properties.some(attribute=>ts.isJsxAttribute(attribute)&&attribute.name.getText(sf)==='className'&&attribute.initializer&&ts.isStringLiteral(attribute.initializer)&&/\bmono\b/.test(attribute.initializer.text));
 };
 const visit=node=>{
  if(ts.isJsxText(node)){const value=node.text.trim();if(value&&wordy(value)&&!technical(node))found.push(value);}
  else if(ts.isJsxAttribute(node)&&visibleProps.has(node.name.getText(sf))){
   const init=node.initializer,value=init&&ts.isStringLiteral(init)?init.text:init&&ts.isJsxExpression(init)?literal(init.expression):null;
   if(value!=null&&wordy(value)&&!isKey(value))found.push(value);
  }
  else if(ts.isPropertyAssignment(node)&&objectProps.has(node.name.getText(sf))){const value=literal(node.initializer);if(value!=null&&wordy(value)&&!isKey(value))found.push(value);}
  ts.forEachChild(node,visit);
 };
 visit(sf);
 return found;
}
const literalAllow={
 'example input values in placeholders (host names, paths, ids, JSON, PowerShell)':['organisation','server-configurations','ServerDeskConfig','contoso.onmicrosoft.com','SRV-APP01','2001:db8:1::','corp.example','branch.example','[{"name":"hostname","type":"string","required":true,"secret":false}]','Get-Service | Select-Object Name, Status','dc01.example.local','C:\\App\\Config','.json,.ini','HKLM:\\SOFTWARE\\MyApplication','C:\\\\Temp'],
 'key caps on buttons that send them':['Ctrl+Alt+Del','Ctrl+C'],
 'partition styles and file systems as Windows names them':['GPT','NTFS'],
};
const allowedLiterals=new Set(Object.values(literalAllow).flat());
const literalHits=appFiles.flatMap(file=>visibleLiterals(read(file),file).filter(value=>!allowedLiterals.has(value)).map(value=>`${file}: ${value}`));
check(literalHits,[],'every visible string in app/ comes from the catalog');
const allLiterals=new Set(appFiles.flatMap(file=>visibleLiterals(read(file),file)));
for(const value of allowedLiterals)ok(allLiterals.has(value),`the allowlisted literal ${value} is still used`);
// Hand-built units next to a number, an en dash as a missing value, fixed-locale lower-casing.
// A visible unit follows its number after a space; a CSS value (`${delay}ms`, `${width}%`) has none.
const handUnit=/\$\{[^}]*\}[\s\u00a0](?:ms|%|KB|KiB|MiB|GiB|TiB|MB|GB)(?![\w])|['"`][\s\u00a0](?:ms|KB|KiB|MiB|GiB|TiB|MB|GB)['"`]|°C/;
const dashPlaceholder=/(?:[:?]|\?\?|\|\||return)\s*'–'/;
const fixedCase=/toLocale(?:Lower|Upper)Case\(\s*(?:(['"])de\1)?\s*\)/;
const sourceHits=(pattern,files)=>files.filter(file=>pattern.test(stripComments(read(file))));
check(sourceHits(handUnit,[...appFiles,...translatedFiles]),[],'no unit is built by hand next to a number');
check(sourceHits(dashPlaceholder,appFiles),[],'a missing value is EMPTY_VALUE, never an en dash');
check(sourceHits(fixedCase,appFiles),[],'search text is lowered with the console locale');
// The scanners themselves.
for(const sample of ["const c=[{id:'s',label:'Status'}];",'const x=<span>Online</span>;','const y=<Btn title="Firewall"/>;'])ok(visibleLiterals(sample).length===1,`the literal scan flags ${sample}`);
for(const sample of ["const c=[{id:'s',label:t('fleet.col.status')}];","const k={keys:['1','–','9']};",'const z=<span className="mono">ServerDesk.Agent.exe</span>;','const w=<code>config.bin</code>;',"const v={label:'fleet.col.status'};"])check(visibleLiterals(sample),[],`the literal scan accepts ${sample}`);
for(const sample of ['const a=`${n} ms`;','const b=`${v} °C`;',"const c=x?y:'–';","const d=s.toLocaleLowerCase('de');",'const e=s.toLocaleLowerCase();'])ok([handUnit,dashPlaceholder,fixedCase].some(pattern=>pattern.test(sample)),`the source scan flags ${sample}`);
for(const sample of ["const k={keys:['1','–','9']};",'const s=x.toLocaleLowerCase(locale);',"const u=['GiB','MiB'];"])ok(![handUnit,dashPlaceholder,fixedCase].some(pattern=>pattern.test(sample)),`the source scan accepts ${sample}`);

// The missing value is EMPTY_VALUE (lib/i18n/format.ts), never a literal em dash: no string literal, no
// no-substitution template literal and no JSX text in .ts/.tsx under app/ and ui/ (all files, the former lib models
// included) is exactly "—". Comments are no code and may mention it; "a — b" in a longer text is no missing value.
/** The em dash literals of a source, as "line: kind". */
function emDashLiterals(source,file='x.tsx'){
 const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS),found=[];
 const visit=node=>{
  const value=ts.isJsxText(node)||ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)?node.text.trim():null;
  if(value==='—')found.push(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1}: ${ts.SyntaxKind[node.kind]}`);
  ts.forEachChild(node,visit);
 };
 visit(sf);
 return found;
}
check([...walk('app'),...walk('ui')].flatMap(file=>emDashLiterals(read(file),file).map(hit=>`${file}:${hit}`)),[],'a missing value is EMPTY_VALUE, never a literal em dash');
for(const sample of ["const a=x??'—';",'const b=<span>—</span>;','const c=x?y:"—";','const d=`—`;','const e=<td> — </td>;'])ok(emDashLiterals(sample).length===1,`the em dash scan flags ${sample}`);
for(const sample of ['// "—" comment\nconst a=1;',"import {EMPTY_VALUE} from '@/lib/i18n/format';const b=x??EMPTY_VALUE;","const c='a — b';",'const d=<span>a — b</span>;','/* — */const e=0;'])check(emDashLiterals(sample),[],`the em dash scan accepts ${sample}`);

console.log(`PASS copy terminology (${checks} checks): glossary terms, exact copy, periods, generic keys, plurals, literals, units, placeholders, em dash literals and locale lower-casing.`);
