// L12: the reasons the agent writes into snapshot.collectionErrors have catalog texts. Every fixed
// sentence of agent/v3/NativeTelemetry.cs (errors.Add, the base snapshot, LimitSnapshot) and the
// collector sentences map to an agentReason.* key in both catalogs; the "(detail)" patterns keep
// the Windows detail as received; an unknown text comes back as received and marked. The health
// line and the "By alarm" view show an unknown reason in mono after the translated title.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {germanIn} from '../support/german-text.mjs';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
const h=React.createElement;
const en=(await import('../../lib/i18n/messages/en.ts')).default,de=(await import('../../lib/i18n/messages/de.ts')).default;
const {agentReasonMatch,agentReasonLine,agentReasonLines,agentReasonPatterns,agentCollectorNames,agentNetworkDetails}=await import('../../ui/base/agent-reasons.ts');
const {issueText}=await import('../../ui/base/ui-device.ts');
const {alarmText}=await import('../../ui/devices/monitoring/alarms-view.ts');
const {demoData}=await import('../../ui/shell/demo.ts');
const {LocaleProvider}=await import('../../ui/base/locale.tsx');
const {HealthLineView}=await import('../../ui/devices/device/device-summary.tsx');

// ---- Every fixed agent sentence of NativeTelemetry.cs maps to a key in both catalogs ----
const telemetry=read('agent/v3/NativeTelemetry.cs');
const fixed=[...telemetry.matchAll(/errors\.Add\("([^"]+)"\)/g)].map(match=>match[1]);
const base=telemetry.match(/\["collectionErrors"\] = new JsonArray\("([^"]+)"\)/)?.[1];
const limit=telemetry.match(/JsonValue\.Create\("(Very large inventory[^"]+)"\)/)?.[1];
check(fixed.length,2,'NativeTelemetry.cs adds two fixed sentences');
ok(base&&limit,'the base snapshot and LimitSnapshot texts are found');
// The console says what the user sees; the agent keeps its own sentence (agent/v3/NativeTelemetry.cs).
const english={
 'The process list is being initialized or is not available at the moment.':'The process list is not available yet. The agent tries again by itself.',
 'The system inventory is being initialized; available data loads independently.':'The agent is still collecting the system inventory. The values that are ready already show.',
 'Very large inventory: groups, firewall rules and tasks were shortened for this heartbeat.':'The inventory of this device is very large. This report shows only part of the groups, firewall rules and scheduled tasks.',
};
for(const text of [...fixed,base,limit]){
 const match=agentReasonMatch(text);
 ok(match&&match.key.startsWith('agentReason.'),`"${text}" maps to an agentReason key`);
 ok(typeof en[match.key]==='string'&&typeof de[match.key]==='string'&&de[match.key]!==en[match.key],`${match.key} exists in both catalogs`);
 check(agentReasonLine('en',text),{known:true,text:english[text]??text},`the English text of ${match.key} is the catalog text`);
 const german=agentReasonLine('de',text);
 ok(german.known&&german.text!==text&&germanIn(german.text).length>0,`the German text of ${match.key} is German`);
}
// The spec examples.
check(agentReasonLine('de','The last update inventory could not be read.').text,'Das letzte Update-Inventar konnte nicht gelesen werden.','update inventory');
check(agentReasonLine('de','The process list is being initialized or is not available at the moment.').text,'Die Prozessliste ist noch nicht verfügbar. Der Agent versucht es von selbst erneut.','process list');
check(agentReasonLine('de','The system inventory is being initialized; available data loads independently.').text,'Der Agent erfasst das Systeminventar noch. Die Werte, die schon bereitstehen, werden bereits angezeigt.','system inventory');
check(agentReasonLine('de','Very large inventory: groups, firewall rules and tasks were shortened for this heartbeat.').text,'Das Inventar dieses Geräts ist sehr groß. Diese Meldung zeigt nur einen Teil der Gruppen, Firewallregeln und geplanten Aufgaben.','large inventory');

// ---- The "(detail)" patterns translate and keep the Windows detail verbatim ----
const detail='EventLogException, Windows code=5 (Access denied)';
check(agentReasonLine('de',`The Application event log could not be read (${detail}).`).text,`Das Ereignisprotokoll Application konnte nicht gelesen werden (${detail}).`,'the {log} event log pattern');
check(agentReasonLine('de',`The event logs could not be read (${detail}).`).text,`Die Ereignisprotokolle konnten nicht gelesen werden (${detail}).`,'the event logs pattern');
check(agentReasonLine('de',`The minidump folder could not be read (${detail}).`).text,`Der Minidump-Ordner konnte nicht gelesen werden (${detail}).`,'the minidump folder pattern');
check(agentReasonLine('de',`The System event log could not be read for disk errors (${detail}).`).text,`Das Ereignisprotokoll System konnte für Datenträgerfehler nicht gelesen werden (${detail}).`,'the disk error log comes before the general log pattern');
for(const pattern of ['The {log} event log could not be read ({detail}).','The event logs could not be read ({detail}).','The minidump folder could not be read ({detail}).'])ok(agentReasonPatterns.some(entry=>entry.text===pattern),`the pattern "${pattern}" is mapped`);

// ---- The collector sentences of the agent reach a key too ----
const sources=['NativeTelemetryScheduling.cs','NativeAutostartInventory.cs','NativeCertificates.cs','NativeDefender.cs','NativeDiskHealth.cs','NativeReliability.cs','NativeTelemetryProviders.cs','NativeNetworkInventory.cs','NativeCrashInventory.cs'].map(name=>read('agent/v3/'+name)).join('\n');
// Each sentence the agent builds with a Describe() detail, as the C# source spells its fixed part.
const describe=[...sources.matchAll(/(?:warnings|errors)\.Add\("([^"]+) \(" \+ NativeInventoryDiagnostics\.Describe\(error\) \+ "\)\."\)/g)].map(match=>match[1]);
ok(describe.length>=12,'the scan finds the collector warnings with a Windows detail');
for(const sentence of describe)ok(agentReasonMatch(`${sentence} (${detail}).`),`"${sentence} (…)." is mapped`);
ok(agentReasonMatch('The Application event log could not be read ('+detail+').')&&agentReasonMatch('The autostart entries could not be read completely: HKLM Run ('+detail+').'),'the event log and autostart warnings are mapped');
const collectorNames=[...read('agent/v3/NativeTelemetry.cs').matchAll(/(?:Add|TelemetryCollectorSlot)\("([A-Z][A-Za-z ]+)",/g)].map(match=>match[1]);
ok(collectorNames.length>=20,'the scan finds the collector names');
check(collectorNames.filter(name=>!Object.hasOwn(agentCollectorNames,name)),[],'every collector name has a catalog text');
for(const key of Object.values(agentCollectorNames))ok(typeof en[key]==='string'&&typeof de[key]==='string',key);
check(agentReasonLine('de','Drivers could not be read ('+detail+').').text,`Treiber konnte nicht gelesen werden (${detail}).`,'a failed collector');
check(agentReasonLine('de','Software inventory is being initialized.').text,'Softwareinventar: Der Agent erfasst diese Werte noch.','a starting collector');
check(agentReasonLine('de','Event logs: the Windows provider does not answer in time; the collection continues independently.').text,'Ereignisprotokolle: Windows antwortet zu langsam. Der Agent versucht es weiter, und die anderen Werte werden trotzdem aktualisiert.','a slow collector');
check(agentReasonLine('de','Network partly readable · Ethernet0: IPv4 properties (NetworkInformationException, Windows code=5).').text,'Einige Netzwerkwerte konnten nicht gelesen werden · Ethernet0: IPv4-Eigenschaften (NetworkInformationException, Windows code=5).','a network warning keeps the alias and the kind');
check(agentReasonLine('de','Network: 3 more adapter details could not be read.').text,'Netzwerk: 3 weitere Adapterdetails konnten nicht gelesen werden.','the network rest count is a plural');
const networkItems=[...read('agent/v3/NativeNetworkInventory.cs').matchAll(/ReadValue\("([^"]+)"|scan\.Warn\([^,]+, "([^"]+)"/g)].map(match=>match[1]??match[2]);
check(networkItems.filter(item=>!Object.hasOwn(agentNetworkDetails,item)),[],'every network item has a catalog text');

// ---- Unknown texts come back as received and marked ----
const unknown='Software inventory: the Windows Installer provider skipped 2 products with an invalid version.';
check(agentReasonLine('de',unknown),{known:false,text:unknown},'an unknown text stays as received');
check(agentReasonLine('de','Mystery collector could not be read (x).'),{known:false,text:'Mystery collector could not be read (x).'},'an unknown collector name is not translated half');
check(agentReasonLines('de',['The last update inventory could not be read.',unknown]),{known:['Das letzte Update-Inventar konnte nicht gelesen werden.'],unknown:[unknown]},'agentReasonLines splits known and unknown');

// ---- issueText: no English agent sentence inside a German issue ----
const issue={ruleId:'inventory-incomplete',params:{errors:['The last update inventory could not be read.','The process list is being initialized or is not available at the moment.',unknown]}};
const german=issueText(issue,'de',Date.now());
check(german.detail,'Das letzte Update-Inventar konnte nicht gelesen werden.\nDie Prozessliste ist noch nicht verfügbar. Der Agent versucht es von selbst erneut.','the German detail holds the translated reasons');
check(german.unknown,[unknown],'the unknown reason is marked');
ok(!/could not be read|is being initialized/.test(german.detail),'no English agent sentence in the German detail');
check(issueText({ruleId:'inventory-incomplete',params:{errors:['The last update inventory could not be read.']}},'de',Date.now()).unknown,undefined,'without unknown reasons there is no unknown list');
check(alarmText(issue,'de').unknown,[unknown],'alarmText carries the unknown reasons');

// ---- The sample devices show both forms ----
const {servers}=demoData(),errors=servers.flatMap(server=>server.snapshot?.collectionErrors??[]);
check(errors.length,2,'two sample devices report one collection error each');
ok(errors.every(text=>germanIn(text).length===0&&/^[A-Z][\x20-\x7e]+$/.test(text)),'the sample errors are English agent texts');
check(errors.map(text=>agentReasonLine('de',text).known).sort(),[false,true],'one sample error is known, one unknown');

// ---- The health line and the "By alarm" cell show the unknown reason in mono ----
const now=Date.now(),server={...servers[0],issues:[{key:'inventory-incomplete',ruleId:'inventory-incomplete',level:'warning',live:false,params:issue.params}]};
const html=renderToStaticMarkup(h(LocaleProvider,{locale:'de'},h(HealthLineView,{server,now,locale:'de',expanded:false,onToggle:()=>{},listId:'x',onNavigate:()=>{}})));
const lead=html.match(/<p class="sdx-health-line-issue">([\s\S]*?)<\/p>/)?.[1]??'';
ok(lead.includes(`<span class="mono sdx-agent-reason">${unknown}</span>`),'the unknown reason is a mono element');
ok(lead.indexOf('mono sdx-agent-reason')>lead.indexOf('</strong>'),'the mono reason follows the translated title');
ok(lead.includes('Das letzte Update-Inventar konnte nicht gelesen werden.')&&!/<span class="mono[^"]*">Das letzte/.test(lead),'the known reason is plain translated text');
ok(read('ui/devices/monitoring/alarms.tsx').includes('className="mono sdx-agent-reason"'),'the "By alarm" cell renders unknown reasons in mono');

console.log(`PASS agent reasons (${checks} checks): fixed and pattern sentences of the agent in both catalogs, details kept, unknown text marked, the health line and the sample devices.`);
