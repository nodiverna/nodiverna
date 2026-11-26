// The agent mode as the UI names it (owner decision D5): agentModeLabel (ui/base/agent-mode.ts) in English and
// German; the device header tag, the mode pick of the page Add device and the file browser tag render the labels (React SSR); every place
// that shows the mode calls the helper (the runbook target tag and the runbook preview Mode column included); no .tsx in app/ renders the raw values ReadOnly or Management as text; and the
// four catalogs name the mode with the new words. The submitted values stay ReadOnly and Management. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const {agentModeLabel,agentModeKey}=await import('../../../ui/base/agent-mode.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {default:DeviceView}=await import('../../../ui/devices/device/device.tsx');
const {AgentModePick}=await import('../../../ui/devices/add-device/agent-mode-pick.tsx');
const {default:FileBrowser}=await import('../../../ui/devices/remote/file-browser.tsx');
const {demoData}=await import('../../../ui/shell/demo.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const noop=()=>{};

// ---- The helper ----
const en=(key,params)=>translate('en',key,params),de=(key,params)=>translate('de',key,params);
check([agentModeLabel('ReadOnly',en),agentModeLabel('Management',en),agentModeLabel('ReadOnly',de),agentModeLabel('Management',de)],['Read-only','Management','Nur lesen','Verwaltung'],'the labels in English and German');
check([agentModeKey(undefined),agentModeKey(null),agentModeKey('other'),agentModeKey('Management')],['agentMode.readOnly','agentMode.readOnly','agentMode.readOnly','agentMode.management'],'any value but Management is the read-only mode');
check([en('device.mode.label',{mode:agentModeLabel('ReadOnly',en)}),de('device.mode.label',{mode:agentModeLabel('Management',de)})],['Mode: Read-only','Modus: Verwaltung'],'the sr-only label of the compact tag');

// ---- The device header tag (wide; the narrow tag is the same call in the sr-only span) ----
const {servers}=demoData();
const viewer={id:'owner',label:'owner',permissions:['*']};
const props=server=>({server,servers,viewer,demo:true,saving:false,now:Date.now(),section:'overview',onSection:noop,samples:[],historyLoading:false,jobs:[],audit:[],crumbs:[],onConfirm:noop,onSelectJob:noop,onCancelJob:noop,panel:null,onPanel:noop,canOffboard:false});
const modeTag=html=>html.match(/<span class="sdx-tag" title="(The agent[^"]*|Der Agent[^"]*)">.*?<\/span>/)?.[0]??'';
const readOnly=servers.find(server=>server.management===0||server.snapshot?.mode==='ReadOnly'),managed=servers.find(server=>server.management===1&&server.snapshot?.mode==='Management');
ok(readOnly&&managed,'the sample devices have both modes');
for(const [server,locale,label,hint] of [[readOnly,'en','Read-only','The agent only reports data and makes no changes.'],[managed,'en','Management','The agent reports data and can make changes on the device.'],[readOnly,'de','Nur lesen','Der Agent meldet nur Daten und führt keine Änderungen aus.'],[managed,'de','Verwaltung','Der Agent meldet Daten und kann Änderungen am Gerät ausführen.']]){
 const tag=modeTag(render(h(DeviceView,props(server)),locale));
 check([text(tag),tag.includes(`title="${hint}"`)],[label,true],`the header tag of ${server.name} (${locale}): the label, the hint as its description`);
}
const deviceSource=fs.readFileSync('ui/devices/device/device.tsx','utf8');
ok(deviceSource.includes("{narrow?<span className=\"sr-only\">{t('device.mode.label',{mode:agentModeLabel(mode,t)})}</span>:agentModeLabel(mode,t)}"),'narrow: the sr-only "Mode: …" with the translated label; wide: the label');

// ---- The mode pick of the page Add device: the radio titles ----
const pick=locale=>render(h(AgentModePick,{value:'ReadOnly',onChange:noop}),locale);
const radioTitles=html=>[...html.matchAll(/<button type="button" role="radio"[^>]*>.*?<strong>([^<]+)<\/strong>/g)].map(match=>match[1]);
check(radioTitles(pick('en')),['Read-only','Management'],'the mode radio titles in English');
check(radioTitles(pick('de')),['Nur lesen','Verwaltung'],'and in German');
const pickSource=fs.readFileSync('ui/devices/add-device/agent-mode-pick.tsx','utf8');
ok(/selected=\{value==='ReadOnly'\}.*onSelect=\{\(\)=>onChange\('ReadOnly'\)\}/.test(pickSource)&&/selected=\{value==='Management'\}.*onSelect=\{\(\)=>onChange\('Management'\)\}/.test(pickSource),'the submitted values stay ReadOnly and Management');

// ---- The file browser tag ----
const fileServer={...managed,management:0,snapshot:{...managed.snapshot,agentCapabilities:[...(managed.snapshot?.agentCapabilities??[]),'list-files']}};
const browser=locale=>render(h(FileBrowser,{server:fileServer,viewer,demo:false}),locale);
// UI-Rework 13b: the ReadOnly chip gave way to the one panel notice (PanelUnavailable) with the mode reason and files.readOnly.
ok(browser('en').includes('Turn on Management mode on the device itself to use this. You can still browse and download files.')&&browser('de').includes('Dateien durchsuchen und herunterladen kannst du weiter.')&&!browser('en').includes('v3-status'),'the file browser names the mode in its panel notice, no ReadOnly chip');

// ---- Every place that shows the mode calls the helper; no raw value as text ----
for(const [file,pattern] of [
 ['ui/devices/device/device.tsx',/agentModeLabel\(mode,t\)/],
 ['ui/devices/add-device/agent-mode-pick.tsx',/label=\{agentModeLabel\('ReadOnly',t\)\}[\s\S]*label=\{agentModeLabel\('Management',t\)\}/],
 ['ui/devices/add-device/add-device-installers.tsx',/cell:row=>agentModeLabel\(row\.mode,t\)/],
 ['ui/automation/runbook-panel.tsx',/<span className="sdx-tag">\{agentModeLabel\(s\.management\?'Management':'ReadOnly',t\)\}<\/span>/],
 ['ui/automation/runbook-panel.tsx',/\{id:'mode',label:t\('customers\.mode'\),cell:entry=>agentModeLabel\(entry\.mode,t\)\}/],
 ['ui/automation/desired-state-panel.tsx',/const deviceMode=\(device:Device\)=>agentModeLabel\(/],
])ok(pattern.test(fs.readFileSync(file,'utf8')),`${file} shows the mode through agentModeLabel (${pattern.source.slice(0,40)}…)`);
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):entry.name.endsWith('.tsx')?[path.join(dir,entry.name)]:[]);
const raw=['app','ui'].flatMap(walk).filter(file=>/>\s*(?:ReadOnly|Management)\s*<|\?'Management':'ReadOnly'\}\s*<|\?"Management":"ReadOnly"\}\s*</.test(fs.readFileSync(file,'utf8')));
check(raw.map(file=>file.split(path.sep).join('/')),[],'no .tsx in app/ renders ReadOnly or Management as text');

// ---- The catalogs: the new words; comments and key names do not count ----
const catalogs={en:(await import('../../../lib/i18n/messages/en.ts')).default,de:(await import('../../../lib/i18n/messages/de.ts')).default,'en-server':(await import('../../../lib/i18n/messages/en-server.ts')).default,'de-server':(await import('../../../lib/i18n/messages/de-server.ts')).default};
const values=catalog=>Object.entries(catalog).flatMap(([key,value])=>typeof value==='string'?[[key,value]]:Object.values(value).map(text=>[key,text]));
check(['en','en-server'].flatMap(name=>values(catalogs[name]).filter(([,value])=>/ReadOnly/.test(value)).map(([key])=>`${name} ${key}`)),[],'no English value contains ReadOnly');
check(['de','de-server'].flatMap(name=>values(catalogs[name]).filter(([,value])=>/ReadOnly|Management/.test(value)).map(([key])=>`${name} ${key}`)),[],'no German value contains ReadOnly or Management');
check([catalogs['en-server']['apiError.console.agentMode'],catalogs['de-server']['apiError.console.agentMode']],['Choose the agent mode Read-only or Management.','Wähle den Agent-Modus Nur lesen oder Verwaltung.'],'the server message of the mode');
check([catalogs.en['agentMode.readOnly'],catalogs.en['agentMode.management'],catalogs.de['agentMode.readOnly'],catalogs.de['agentMode.management']],['Read-only','Management','Nur lesen','Verwaltung'],'the two label keys');
ok(values(catalogs.de).some(([,value])=>value.includes('Nur-Lesen-Modus'))&&values(catalogs.de).some(([,value])=>value.includes('Verwaltungsmodus')),'German sentences name the Nur-Lesen-Modus and the Verwaltungsmodus');
ok(values(catalogs.en).some(([,value])=>value.includes('Read-only mode'))&&values(catalogs.en).some(([,value])=>value.includes('Management mode')),'English sentences name the Read-only mode and the Management mode');
// The German server fixture follows the server catalog.
const fixture=JSON.parse(fs.readFileSync('tests/fixtures/server-messages-de.json','utf8'));
check(Object.entries(fixture).filter(([,value])=>/ReadOnly|Management/.test(JSON.stringify(value))).map(([key])=>key),[],'the German server fixture names the mode with the new words');
check(['apiError.console.agentMode','apiError.transfer.agentReadOnly','serverMessage.rdp.managementRequired'].map(key=>fixture[key]===catalogs['de-server'][key]),[true,true,true],'and follows de-server.ts for the rewritten keys');
console.log(`PASS agent mode labels (${checks} checks): agentModeLabel in English and German, the device header tag, the Add device mode pick and the file browser tag, one helper call per place, no raw mode text in app/, and the catalogs with the new words.`);
