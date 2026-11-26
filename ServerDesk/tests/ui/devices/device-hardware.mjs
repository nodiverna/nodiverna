// Render the real Hardware workspace on the kit and exercise its component controls.
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from '../../support/render-de.mjs';
const require=createRequire(import.meta.url),root=process.cwd(),cache=new Map(),jsx=require('react/jsx-runtime'),charts=require('recharts');
let states=[],cursor=0,buttons=[],btns=[],gpuProps,chartPoints,chartCurve,checks=0,Btn=null;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const nb=value=>value.replace(/ (?=(?:B|KiB|MiB|GiB|TiB)\b)/g,'\u00a0');
const react={...React,useState(initial){const index=cursor++;if(!states[index])states[index]={value:typeof initial==='function'?initial():initial};return[states[index].value,next=>{states[index].value=typeof next==='function'?next(states[index].value):next;}];},useRef(initial){const index=cursor++;if(!states[index])states[index]={current:initial};return states[index];},useLayoutEffect:fn=>fn(),useMemo:fn=>fn()};
const track=original=>(type,props,...rest)=>{if(type==='button')buttons.push(props);if(Btn&&type===Btn)btns.push(props);if(type===charts.AreaChart)chartPoints=props.data;if(type===charts.Area)chartCurve=props;if(type===GpuStub)gpuProps=props;return original(type,props,...rest);};
const runtime={...jsx,jsx:track(jsx.jsx),jsxs:track(jsx.jsxs)};
const toasts=[];
const sonner={toast:{success:message=>toasts.push(['success',message]),error:message=>toasts.push(['error',message]),info:message=>toasts.push(['info',message])}};
function GpuStub(props){return React.createElement('div',{'data-exact-gpu':props.focusGpu??''},'Existing GPU view');}
function load(file){
 const absolute=path.resolve(file);if(absolute===germanLocalePath)return germanLocale;if(absolute.endsWith('.css'))return {};if(cache.has(absolute))return cache.get(absolute).exports;
 const fixture={exports:{}};cache.set(absolute,fixture);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const localRequire=id=>{if(id==='react')return absolute===path.join(root,'ui/devices/hardware/device-hardware.tsx')?react:React;if(id==='react/jsx-runtime')return runtime;if(id==='sonner')return sonner;if(id==='@/ui/devices/hardware/device-gpu')return{default:GpuStub,__esModule:true};if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),candidate=[base,base+'.ts',base+'.tsx'].find(name=>fs.existsSync(name)&&fs.statSync(name).isFile());if(candidate)return load(candidate);}return require(id);};
 new Function('require','module','exports',code)(localRequire,fixture,fixture.exports);return fixture.exports;
}
const {default:Hardware,deviceHardwareSummary,deviceInstalledMemoryBytes}=load('ui/devices/hardware/device-hardware.tsx'),now=Date.now(),iso=new Date(now).toISOString(),GiB=1073741824;
({Btn}=load('ui/kit/kit.tsx'));
const {Check}=require('lucide-react');

// ---- kit only, no local tiles, facts or empty texts, ticks at 12px ----
for(const file of ['ui/devices/hardware/device-hardware.tsx','ui/devices/hardware/device-gpu.tsx']){
 const source=fs.readFileSync(file,'utf8');
 ok(!source.includes('@/components/ui/')&&!/LoadingSkeleton|loading-skeleton/.test(source),file+' imports no shadcn component and no LoadingSkeleton');
 ok(!/function (?:Fact|Metric|Missing|Action)\(/.test(source),file+' has no local Fact, Metric, Missing or Action');
 ok(!/fontSize:10\b/.test(source)&&(source.match(/fontSize:12,fill:'var\(--sd-muted\)'/g)??[]).length===2,file+': both axes tick at 12px');
}

const legacy={hostname:'PC-TEST',os:'Windows 11 Pro',build:'26100',manufacturer:'Example',model:'Workstation',cores:16,memoryGb:32,cpu:0,memory:25,disks:[{name:'C:',label:'System',freeGb:200,totalGb:500}],networks:[{name:'Ethernet',mac:'AA-BB-CC-DD-EE-FF',addresses:['10.0.0.1'],speedMbps:1000}],performance:{processorQueue:0,pagefilePercent:0,diskLatencyMs:0,diskReadBytesSec:0,diskWriteBytesSec:1.2*1048576},pagefile:{automatic:true,files:[{name:'C:\\pagefile.sys',allocatedMb:512,currentUsageMb:0,peakUsageMb:20}]}};
const inventory={collectedAt:iso,intervalSeconds:900,complete:true,cpus:[{id:'CPU0',name:'AMD Ryzen 9 7950X',manufacturer:'AMD',cores:16,threads:32,maxClockMhz:5700,socket:'AM5'}],memoryModules:[{id:'DIMM1',deviceLocator:'DIMM A2',bankLabel:'Bank 0',capacityBytes:16*GiB,memoryType:'DDR5',formFactor:'DIMM',configuredClockMhz:6000,speedMhz:6400,manufacturer:'Example RAM',partNumber:'RAM-16G',serialNumber:'RAM001'},{id:'DIMM2',deviceLocator:'DIMM B2',bankLabel:'Bank 1',capacityBytes:16*GiB,memoryType:'DDR5',formFactor:'DIMM',configuredClockMhz:null,speedMhz:6000,manufacturer:null,partNumber:null,serialNumber:null}],memoryArray:{slots:4,maxCapacityBytes:null},disks:[{id:'Disk0',model:'NVMe Test SSD',sizeBytes:1000*GiB,busType:'NVMe',mediaType:'SSD',healthStatus:'healthy',serialNumber:'SSD001',firmwareVersion:'1A'}],system:{manufacturer:'Example',model:'Workstation',systemType:'x64 PC',uuid:'system-uuid'},bios:{manufacturer:'AMI',name:'UEFI',version:'1.23',releasedAt:new Date(now-182*86400000).toISOString(),serialNumber:'BIOS001'},baseboard:{manufacturer:'Example',product:'Test B650',version:'Rev 1',serialNumber:'BOARD001'},networkAdapters:[{id:'NIC0',name:'Intel Ethernet',manufacturer:'Intel',mac:'AA-BB-CC-DD-EE-FF',speedMbps:1000,physicalAdapter:true}]};
const server={id:'host',name:'PC-TEST',revoked:0,lastSeen:now,permissions:['view'],snapshot:legacy},viewer={id:'reader',permissions:[],label:'Reader'};
let navigation;
const base={server,viewer,demo:false,now,samples:[],jobs:[],onNavigate:target=>{navigation=target;}};
function render(props={},reset=false){if(reset)states=[];cursor=0;buttons=[];btns=[];gpuProps=undefined;chartPoints=undefined;chartCurve=undefined;return renderToStaticMarkup(React.createElement(Hardware,{...base,...props}));}
const text=value=>Array.isArray(value)?value.map(text).join(''):typeof value==='string'?value:value?.props?.children?text(value.props.children):'';
const button=label=>buttons.find(props=>text(props.children)===label||props['aria-label']===label);
// A plain left click: the subarea tabs are kit Tabs (ui/kit/tabs.tsx), whose click handler reads the event.
const press=()=>({button:0,ctrlKey:false,metaKey:false,shiftKey:false,altKey:false,preventDefault(){}});
function click(label,props={}){assert.ok(button(label),'button exists '+label);button(label).onClick(press());return render(props);}
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** The KPI tile with this label (kit Kpi: article aria-label "Label: value"). */
const kpi=(html,label)=>html.match(new RegExp('<article class="sdx-kpi[^"]*"[^>]*aria-label="'+escape(label)+': [^"]*"[^>]*>[\\s\\S]*?</article>'))?.[0];
/** The kit Card whose head title (or open button) has this text. */
const card=(html,title)=>{const at=html.search(new RegExp('<h2[^>]*>(?:<span class="sdx-icon-tile[^"]*"[^>]*>(?:(?!</h2>)[\\s\\S])*?</span>)?(?:<button type="button" class="sdx-card-hit"[^>]*>)?'+escape(title)+'<'));if(at<0)return undefined;const start=html.lastIndexOf('<section class="sdx-card',at);let depth=0;const tag=/<\/?section\b/g;tag.lastIndex=start;for(let match;(match=tag.exec(html));){depth+=match[0]==='<section'?1:-1;if(!depth)return html.slice(start,match.index+'</section>'.length);}return undefined;};
const region=(html,label)=>html.match(new RegExp('<div class="sdx-table-wrap[^"]*" role="region" aria-label="'+escape(label)+'"[^>]*>[\\s\\S]*?</table>'))?.[0];

// ---- Components on an older agent (legacy facts, no detail inventory) ----
let html=render({},true);
assert.match(html,/Detailinventar noch nicht gemeldet/);assert.doesNotMatch(html,/Temperatur|DDR5|AMD Ryzen|data-gpu-id/,'old agents expose available legacy facts without invented details');
for(const marker of ['dhw-metric','dhw-card','dhw-empty','dhw-actions','dhw-component'])ok(!html.includes(marker),'no classic '+marker);
ok(html.includes('sdx-card')&&html.includes('sdx-section-head'),'Components renders kit cards with section heads');
check([...html.matchAll(/<button type="button" class="sdx-card-hit">([^<]+)<\/button>/g)].map(match=>match[1]),['Prozessor','Arbeitsspeicher','Datenträger','Netzwerk','System &amp; BIOS'],'the interactive component cards');
const staticGpu=card(html,'Grafikkarte');ok(staticGpu&&!staticGpu.includes('sdx-card-interactive')&&!staticGpu.includes('<button')&&staticGpu.includes('Nicht gemeldet')&&staticGpu.includes('Keine unterstützte Grafikkarte gemeldet.'),'without a GPU a static Graphics card card says Not reported');
const staticBattery=card(html,'Akku');ok(staticBattery&&!staticBattery.includes('sdx-card-interactive')&&staticBattery.includes('Aktualisiere den Agent auf 4.11.0'),'without battery data the static Battery card says battery.notReported');
ok(!html.includes('sdx-kpi'),'Components repeats no CPU/RAM utilization KPI');
ok(card(html,'Arbeitsspeicher').includes(nb('32 GiB nutzbar')),'the Memory card shows the usable size through formatBytes');

// ---- CPU ----
html=click('CPU');assert.match(html,/<dt>Modell<\/dt><dd>Nicht gemeldet<\/dd>/);ok(html.includes('<dl class="sdx-facts">'),'facts are kit Facts');
const cpuRow=html.match(/<section class="sdx-kpi-row" aria-label="Prozessorwerte">[\s\S]*?<\/section>/)?.[0];check((cpuRow?.match(/<article class="sdx-kpi/g)??[]).length,3,'the CPU KpiRow has three tiles');
assert.match(kpi(html,'CPU-Auslastung'),/aria-valuenow="0"/,'a real zero CPU load remains valid');
const cpuHistory=card(html,'CPU-Auslastungsverlauf');ok(cpuHistory&&/sdx-card-actions[\s\S]*role="group"[\s\S]*Prozesse öffnen/.test(cpuHistory),'the history card head holds the range and "Open processes"');
ok(cpuHistory.includes('Keine CPU-Messwerte in diesem Zeitraum'),'an empty history shows the Empty title');
button('Prozesse öffnen').onClick();check(navigation,{section:'diagnostics',diagnosis:'processes'},'CPU links to processes without running an operation');
html=render({onNavigate:undefined,focus:{serverId:'host',section:'cpu',revision:9}},true);ok(!html.includes('Prozesse öffnen'),'without onNavigate there is no button');
html=render({historyLoading:true,focus:{serverId:'host',section:'cpu',revision:9}},true);assert.match(html,/role="status" aria-label="CPU-Verlauf wird geladen"/);ok(html.includes('sdx-skeleton-chart'),'the kit chart skeleton');assert.doesNotMatch(html,/Keine CPU-Messwerte/);
const history=[{serverId:'host',at:now-1000,cpu:0,memory:0},{serverId:'host',at:now,cpu:null,memory:101},{serverId:'other',at:now,cpu:90,memory:90},{serverId:'host',at:now+1,cpu:99,memory:99}];
html=render({samples:history,historyLoading:true,focus:{serverId:'host',section:'cpu',revision:9}});assert.match(html,/CPU-Auslastungsverlauf in Prozent/);check(chartPoints.map(point=>point.cpu),[0,null],'history uses scoped real samples with explicit gaps');check(chartCurve.connectNulls,false,'history never fabricates a line over missing rates');

// ---- Memory ----
const full={...server,snapshot:{...legacy,hardware:inventory}};
check(deviceInstalledMemoryBytes(inventory),32*GiB,'complete DIMM capacities have an exact installed sum');
check(deviceInstalledMemoryBytes({...inventory,complete:false}),null,'incomplete or capped inventory cannot imply installed total');
check(deviceInstalledMemoryBytes({...inventory,memoryModules:[{...inventory.memoryModules[0],capacityBytes:null}]}),null,'unknown DIMM capacity cannot produce a partial installed total');
check(deviceInstalledMemoryBytes({...inventory,memoryModules:[]}),null,'no module rows cannot imply zero installed RAM');
const distinctMemory={...full,snapshot:{...full.snapshot,memoryGb:31.9}};
html=render({server:distinctMemory,focus:{serverId:'host',section:'memory',revision:1}},true);
ok(kpi(html,'Für Windows nutzbar')?.includes(nb('32 GiB')),'Windows usable memory is its own labeled tile, through formatBytes');
ok(kpi(html,'Installiert (Module)')?.includes(nb('32 GiB')),'DIMMs keep their actual installed capacity in a separate tile');
assert.doesNotMatch(html,/ GB| MB/,'IEC units only');
const incompleteMemory={...full,snapshot:{...full.snapshot,hardware:{...inventory,complete:false}}};
html=render({server:incompleteMemory,focus:{serverId:'host',section:'memory',revision:1}},true);
assert.doesNotMatch(html,/Installiert \(Module\)/,'partial inventory shows individual modules without a false complete total');
html=render({server:{...full,snapshot:{...full.snapshot,hardware:{...inventory,errors:['CPU: access denied','BIOS: timeout']}}}},true);
ok(/sdx-notice-warning[\s\S]*Einige Hardwaredetails konnten im letzten Inventar nicht gelesen werden[\s\S]*<details[^>]*><summary>Erfassungshinweise · 2<\/summary><ul><li>CPU: access denied<\/li><li>BIOS: timeout<\/li>/.test(html),'collection errors are a warning Notice with the notes behind a details element');

// ---- Components with the detail inventory ----
html=render({server:full},true);assert.match(html,/AMD Ryzen 9 7950X/);assert.match(html,/2 von 4 belegt/);assert.match(html,/1 physischer Datenträger/);assert.doesNotMatch(html,/Temperatur/,'CPU temperatures are not fabricated from WMI');
html=click('CPU',{server:full});for(const value of ['AM5','16','32','5.700 MHz'])assert.ok(html.includes(value),value+' is shown');ok(card(html,'AMD Ryzen 9 7950X')?.includes('<dl class="sdx-facts">'),'each CPU is a Card with Facts');
html=click('Arbeitsspeicher',{server:full});
const modules=region(html,'Speichermodule');ok(modules,'the memory modules are a DataTable region');for(const value of ['DIMM A2','DIMM B2',nb('16 GiB'),'DDR5','6.000 MHz','6.400 MHz','RAM-16G','RAM001','Steckplatz'])ok(modules.includes(value),'memory field '+value);
ok(kpi(html,'Belegt')?.includes(nb('8 GiB')),'used RAM is derived from a real percentage and the usable capacity');
const pagefiles=region(html,'Auslagerungsdateien');ok(pagefiles&&/role="region" aria-label="Auslagerungsdateien" tabindex="0"/.test(html),'the page-file table scrolls in the focusable kit region');ok(pagefiles.includes('C:\\pagefile.sys')&&pagefiles.includes(nb('512 MiB'))&&pagefiles.includes(nb('20 MiB')),'page-file sizes through formatBytes');
assert.doesNotMatch(html,/Maximaler Arbeitsspeicher|dhw-table-wrap/,'unknown memoryArray maximum cannot become a fake capacity');
html=render({server,focus:{serverId:'host',section:'memory',revision:1}},true);ok(card(html,'Speichermodule')?.includes('Keine Speichermodule gemeldet')&&html.includes('Aktualisiere den Agent auf diesem Gerät auf 4.6.7 oder neuer, um diese Liste zu füllen.'),'without snapshot.hardware the modules Empty asks for the agent update');
html=render({server:{...full,snapshot:{...full.snapshot,hardware:{...inventory,memoryModules:[]}}},focus:{serverId:'host',section:'memory',revision:1}},true);ok(html.includes('Windows hat im letzten Inventar keine Einträge für diese Liste gemeldet.'),'an inventory without modules points to the next inventory');
html=render({server:{...server,snapshot:{...legacy,pagefile:undefined}},focus:{serverId:'host',section:'memory',revision:1}},true);ok(!html.includes('Auslagerungsdateien'),'the page-file card renders only with page files');

// ---- Disks ----
render({server:full},true);html=click('Datenträger',{server:full});
const disks=region(html,'Physische Datenträger');for(const value of ['NVMe Test SSD',nb('1.000 GiB'),'SSD','NVMe','SSD001','1A'])ok(disks?.includes(value),'physical disk '+value);ok(/sdx-pill sdx-pill-success"><i aria-hidden="true"><\/i>In Ordnung/.test(disks),'healthy ("In Ordnung") is a success StatusPill');
ok(/<section class="sdx-card"[^>]*>[\s\S]*?Laufwerke[\s\S]*?sdx-card-actions[\s\S]*?Datenträger verwalten/.test(card(html,'Laufwerke')),'the Drives card head holds "Manage disks"');
ok(!buttons.some(props=>text(props.children)==='C: verwalten'),'no per-drive "Manage C:" button');
assert.match(html,/C: belegt/);assert.match(html,/aria-valuenow="60"/);
button('Datenträger C: verwalten').onClick();check(navigation,{section:'management',management:'storage',drive:'C:'},'the drive row keeps the exact drive context');
button('Datenträger verwalten').onClick();check(navigation,{section:'management',management:'storage'},'the card head opens storage');
ok(kpi(html,'Schreibrate')?.includes(nb('1,2 MiB/s'))&&kpi(html,'Leserate')?.includes(nb('0 B/s')),'rates through formatRate');
html=render({server:{...full,snapshot:{...full.snapshot,hardware:{...inventory,disks:[{...inventory.disks[0],healthStatus:'unhealthy'}]}}},focus:{serverId:'host',section:'storage',drive:'C:',revision:5}},true);
ok(/sdx-pill sdx-pill-critical"><i aria-hidden="true"><\/i>Fehler</.test(html),'unhealthy is the critical pill "Error"');
ok(/<button type="button" class="sdx-drive-selected" aria-current="true" aria-label="Datenträger C: verwalten"/.test(html),'focus.drive selects the drive row');

// ---- Network and System ----
render({server:full},true);html=click('Netzwerk',{server:full});
const adapters=region(html,'Netzwerkadapter');ok(adapters?.includes('Intel Ethernet')&&adapters.includes('Physisch')&&adapters.includes('1.000 Mbit/s')&&adapters.includes('<td class="mono">AA-BB-CC-DD-EE-FF</td>'),'the adapter table');
ok(/sdx-card-actions[\s\S]*Netzwerk konfigurieren/.test(card(html,'Netzwerkadapter')),'"Configure network" sits in the card head');
button('Netzwerk konfigurieren').onClick();check(navigation,{section:'management',management:'network'},'adapter details link to configuration');
html=render({focus:{serverId:'host',section:'network',revision:6}},true);ok(region(html,'Netzwerkadapter')?.includes('Ethernet')&&region(html,'Netzwerkadapter').includes('Nicht gemeldet'),'without networkAdapters the rows come from snapshot.networks');
html=render({server:{...server,snapshot:{...legacy,networks:[]}},focus:{serverId:'host',section:'network',revision:6}},true);ok(html.includes('Keine Netzwerkadapter gemeldet')&&html.includes('auf 4.6.7 oder neuer'),'no adapters: Empty with the cause');
render({server:full},true);html=click('System & BIOS',{server:full});for(const value of ['Workstation','system-uuid','x64 PC','UEFI','1.23','BIOS001','Test B650','Rev 1','BOARD001','BIOS und Firmware','Mainboard','UUID'])ok(html.includes(value),'system field '+value);
ok(/sdx-card-actions[\s\S]*System verwalten/.test(card(html,'System')),'"Manage system" sits in the System card head');button('System verwalten').onClick();check(navigation,{section:'management',management:'system'},'system link');

// ---- Offline: stale live values show "—" without a meter ----
for(const section of ['cpu','memory','storage']){html=render({server:{...full,lastSeen:now-180000},focus:{serverId:'host',section,revision:2}},true);assert.doesNotMatch(html,/Livewerte nicht verfügbar|dhw-offline/,'the offline state is the shared device notice, not part of the status line');assert.match(html,/class="dhw-status"><svg[^>]*>(?:(?!<\/p>).)*<time>/,'the status line keeps the inventory time');assert.doesNotMatch(html,/aria-valuenow="0"/,'stale live measurements are hidden '+section);ok(!html.includes('undefined')&&!html.includes('NaN'),'no undefined or NaN '+section);}
html=render({server:{...full,lastSeen:now-180000},focus:{serverId:'host',section:'cpu',revision:2}},true);ok(kpi(html,'CPU-Auslastung').includes('<span class="sdx-kpi-value">—</span>')&&!kpi(html,'CPU-Auslastung').includes('sdx-meter'),'offline CPU: "—" and no meter');ok(kpi(html,'Prozessorwarteschlange').includes('<span class="sdx-kpi-value">—</span>'),'offline queue: "—"');
html=render({server:{...full,lastSeen:now-180000},focus:{serverId:'host',section:'storage',revision:2}},true);for(const label of ['Datenträgerlatenz','Leserate','Schreibrate'])ok(kpi(html,label)?.includes('<span class="sdx-kpi-value">—</span>'),'offline '+label+': "—"');
html=render({server:{...full,lastSeen:now-180000},focus:{serverId:'host',section:'cpu',revision:3},samples:history},true);assert.match(html,/AMD Ryzen/);assert.match(html,/CPU-Auslastungsverlauf in Prozent/,'valid historical CPU samples remain visible offline');

// ---- GPUs ----
const gpu=(id,name)=>({id,name,vendor:'nvidia',utilization:10,collectedAt:iso}),gpus=[gpu(' first/gpu','NVIDIA GPU A'),gpu('second.gpu','NVIDIA GPU B')],graphics={...full,snapshot:{...full.snapshot,gpus}};
html=render({server:graphics},true);assert.match(html,/Grafikkarten/);check((html.match(/data-gpu-id="/g)??[]).length,2,'two GPU cards');ok(!html.includes('Keine unterstützte Grafikkarte gemeldet.')&&!html.includes('sdx-notice-info'),'with GPUs neither the static card nor the notice');
const gpuCard=buttons.find(props=>props['data-gpu-id']==='second.gpu');gpuCard.onClick();html=render({server:graphics});check(gpuProps.focusGpu,'second.gpu','component card selects the exact physical GPU');check(gpuProps.viewer,viewer,'GPU still receives its own view checks');check(gpuProps.server,graphics,'GPU details keep the actual snapshot');
html=render({server:graphics,focus:{serverId:'host',section:'gpu',gpuId:' first/gpu',revision:4}});check(gpuProps.focusGpu,' first/gpu','external GPU overview focus overrides an older local selection');html=render({server:{...graphics,snapshot:{...full.snapshot,gpus:[]}},focus:{serverId:'host',section:'gpu',gpuId:' first/gpu',revision:4}});assert.doesNotMatch(html,/>Grafikkarte[n]?<\/button>/);assert.ok(gpuProps,'a disappearing GPU remains a readonly empty GPU page rather than auto-opening a diagnosis');

// ---- Rights and missing snapshot ----
html=render({server:{...full,permissions:[]}},true);ok(html.includes('Hardwareinventar nicht verfügbar')&&html.includes('Berechtigung „Geräte und Monitoring ansehen“')&&html.includes('lucide-lock'),'no view right: the Lock Empty');assert.doesNotMatch(html,/Ryzen|Workstation|sdx-component-card/,'withdrawn rights remove all inventory');html=render({server:{...full,revoked:1}},true);assert.match(html,/Hardwareinventar nicht verfügbar/);assert.doesNotMatch(html,/Ryzen/);
html=render({server:{...server,snapshot:null,lastSeen:null}},true);ok(html.includes('Noch kein Hardwareinventar')&&html.includes('Die Komponenten erscheinen, nachdem sich der Agent zum ersten Mal gemeldet hat.'),'no snapshot: the Empty');assert.doesNotMatch(html,/sd-loading-detail|sdx-skeleton|0 GiB|0 logische/,'no skeleton, and pending inventory does not imply missing/zero hardware');

// ---- Copy text ----
const summary=deviceHardwareSummary(graphics);assert.match(summary,/AMD Ryzen 9 7950X/);ok(summary.includes(nb('RAM-Modul: DIMM A2 · 16 GiB · DDR5 · 6.000 MHz')),'module line');ok(summary.includes(nb('Datenträger: NVMe Test SSD · 1.000 GiB · NVMe')),'disk line');ok(summary.includes(nb('Laufwerk C: 200 GiB frei von 500 GiB')),'drive line');assert.match(summary,/GPU: NVIDIA GPU A/);assert.doesNotMatch(summary,/RAM001|SSD001|BIOS001|BOARD001/,'compact inventory copy does not dump unnecessary serial identifiers');
ok(deviceHardwareSummary(distinctMemory).includes(nb('RAM (für Windows nutzbar): 32 GiB')),'usable RAM line');ok(deviceHardwareSummary(distinctMemory).includes(nb('RAM (installierte Module): 32 GiB')),'installed RAM line');assert.doesNotMatch(deviceHardwareSummary(incompleteMemory),/installierte Module/);assert.doesNotMatch(summary,/ GB| MB/,'copy uses the same binary units as the visible inventory');

// ---- Copy button ----
html=render({server:full},true);ok(/<div class="dhw-toolbar"><nav[\s\S]*?<\/nav><button type="button" class="sdx-btn sdx-btn-secondary sdx-btn-sm" aria-label="Hardwareinventar kopieren"/.test(html),'the copy Btn follows the Tabs');
const copied=[];const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async value=>{copied.push(value);}}}});
try{
 render({server:full},true);const copy=button('Hardwareinventar kopieren');await copy.onClick();await new Promise(resolve=>setImmediate(resolve));check(copied.length,1,'copy runs from an explicit user control');check(toasts.at(-1),['success','Inventar kopiert.'],'a success toast');
 html=render({server:full});check(btns.find(props=>props['aria-label']==='Hardwareinventar kopieren').icon,Check,'the icon turns into a check');ok(html.includes('lucide-check')&&!html.includes('role="status">Inventar kopiert'),'no inline status text');check(text(btns.find(props=>props['aria-label']==='Hardwareinventar kopieren').children),'Inventar kopieren','the label does not change');
 const retained=button('Hardwareinventar kopieren');render({server:{...full,permissions:[]}});await retained.onClick();await new Promise(resolve=>setImmediate(resolve));check(copied.length,1,'a retained copy handler rejects withdrawn view rights');
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{throw new Error('denied');}}}});
 render({server:full},true);await button('Hardwareinventar kopieren').onClick();check(toasts.at(-1),['error','Das Inventar konnte nicht kopiert werden. Erlaube den Zugriff auf die Zwischenablage im Browser und versuche es erneut.'],'a failing clipboard shows the error toast');
}finally{if(descriptor)Object.defineProperty(globalThis,'navigator',descriptor);else delete globalThis.navigator;}

// ---- Battery ----
const withBattery=battery=>({...full,snapshot:{...full.snapshot,battery}});
const batteryCards=markup=>(markup.match(/<h2[^>]*>(?:<span class="sdx-icon-tile[^"]*"[^>]*>(?:(?!<\/h2>)[\s\S])*?<\/span>)?Akku</g)??[]).length;
html=render({server:withBattery({collectedAt:iso,present:false,reason:'no-battery',batteries:[]})},true);ok(card(html,'Akku')?.includes('Kein Akku')&&card(html,'Akku').includes('Das Gerät meldet keinen eingebauten Akku.'),'no-battery: "No battery" in the grid');
html=render({server:withBattery({collectedAt:iso,present:false,reason:'access-denied',batteries:[]})},true);ok(card(html,'Akku')?.includes('Nicht verfügbar')&&card(html,'Akku').includes('Windows hat keine Akkudaten geliefert.'),'access-denied: "Not available"');
html=render({server:withBattery({collectedAt:iso,present:true,batteries:[]})},true);ok(card(html,'Akku')?.includes('Nicht verfügbar'),'a present battery without a list: "Not available"');
html=render({server:withBattery({collectedAt:iso,present:true,batteries:[{id:0,name:'Internal',designCapacityMWh:60000,fullChargeCapacityMWh:33000,healthPercent:55,cycleCount:312}]})},true);
const batteryCard=card(html,'Akku');ok(/role="meter" aria-label="Akkuzustand von Internal"[^>]*aria-valuenow="55"/.test(batteryCard)&&batteryCard.includes('sdx-meter-warning'),'one battery at 55%: the warning meter');check(batteryCards(html),1,'exactly one battery element');ok(!batteryCard.includes('Kein Akku')&&!html.slice(html.indexOf('dhw-parts'),html.indexOf('sdx-battery')).includes('>Akku<'),'the Battery card sits below the grid, no static card');

// ---- Linked hardware subareas: the tab and GPU position come from the route, changes go to the callback ----
const reported=[],onDetailChange=(section,position)=>reported.push([section,position]),activeTab=markup=>markup.match(/role="tab" class="sdx-tab active" aria-selected="true"[^>]*><span>([^<]+)</)?.[1];
html=render({server:full,detail:'cpu',onDetailChange},true);check(activeTab(html),'CPU','a linked CPU subarea opens the CPU tab');assert.match(html,/AM5/);
html=render({server:full,detail:'system',onDetailChange},true);check(activeTab(html),'System &amp; BIOS','linked system subarea');
// ---- Device type glyph on the System card and the manufacturer in System › Hersteller (docs/manufacturer-logos.md) ----
{
 const vendorFact=markup=>markup.match(/>Hersteller<\/dt><dd[^>]*>([\s\S]*?)<\/dd>/)?.[1]??'';
 ok(/class="sdx-manufacturer sdx-manufacturer-md"><svg[^>]*class="lucide lucide-factory sdx-manufacturer-fallback"[^>]*aria-hidden="true"[\s\S]*<span class="sdx-manufacturer-name">Example<\/span>/.test(vendorFact(html)),'an unknown manufacturer: the neutral glyph and the name');
 const dell={...full,snapshot:{...full.snapshot,hardware:{...inventory,system:{...inventory.system,manufacturer:'Dell Inc.',model:'Precision 7960'}}}};
 const dellFact=vendorFact(render({server:dell,detail:'system',onDetailChange},true));
 ok(/<svg class="sdx-manufacturer-logo" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17\.963/.test(dellFact)&&dellFact.includes('>Dell</span>'),'Dell: the monochrome logo and the display name');
 const placeholder={...full,snapshot:{...full.snapshot,manufacturer:'System manufacturer',hardware:{...inventory,system:{...inventory.system,manufacturer:'To be filled by O.E.M.'}}}};
 check(vendorFact(render({server:placeholder,detail:'system',onDetailChange},true)),'Nicht gemeldet','a placeholder: not reported as before');
 const overviewHtml=render({server:full,onDetailChange},true);
 const serverGlyph=/lucide-server(?![-\w])/,monitorGlyph=/lucide-monitor(?![-\w])/;
 ok(monitorGlyph.test(overviewHtml)&&!serverGlyph.test(overviewHtml),'the System card shows the type glyph of a workstation, not the Server glyph');
 const member={...full,snapshot:{...full.snapshot,security:{domainJoined:true,domainRole:3,rdpEnabled:false,firewall:[],defender:{available:true,enabled:true,signatureAt:iso,realTimeProtection:true},lastBoot:iso}}};
 ok(serverGlyph.test(render({server:member,onDetailChange},true)),'a member server: the Server glyph');
}
html=render({server:graphics,detail:'gpu',gpu:2,onDetailChange},true);check(activeTab(html),'Grafikkarten','linked GPU tab');check(gpuProps.focusGpu,'second.gpu','position 2 selects the second GPU in list order');assert.match(html,/data-exact-gpu="second.gpu"/);
html=render({server:graphics,detail:'gpu',onDetailChange},true);check(gpuProps.focusGpu,' first/gpu','no position means the first GPU');
html=render({server:graphics,detail:'gpu',gpu:5,onDetailChange},true);check(gpuProps.focusGpu,' first/gpu','a position past the end falls back to the first GPU');
const before=reported.length;html=render({server:{...graphics,snapshot:{...full.snapshot,gpus:[]}},detail:'gpu',gpu:2,onDetailChange},true);check(activeTab(html),'Komponenten','without a supported GPU the link shows the components');check(gpuProps,undefined,'no empty GPU page for a link');
ok(/sdx-notice sdx-notice-info" role="status"><svg[^>]*lucide-info[\s\S]*?Dieses Gerät hat keine unterstützte Grafikkarte, daher siehst du seine anderen Komponenten\./.test(html),'an info Notice explains the missing GPU');check(reported.length,before,'onDetailChange is not called, the hash stays');
html=render({server:{...server,snapshot:null,lastSeen:null},detail:'gpu',gpu:2},true);assert.match(html,/Noch kein Hardwareinventar/,'missing inventory keeps the empty state');
html=render({server:{...graphics,permissions:[]},detail:'gpu',gpu:2},true);assert.match(html,/Hardwareinventar nicht verfügbar/,'a link never bypasses the view right');check(gpuProps,undefined,'no GPU details without view right');
html=render({server:graphics,detail:'overview',onDetailChange},true);button('CPU').onClick(press());check(reported.at(-1),['cpu',undefined],'tab click reports the subarea');html=render({server:graphics,detail:'overview',onDetailChange});check(activeTab(html),'Komponenten','the route stays in control until the parent updates it');
buttons.find(props=>props['data-gpu-id']==='second.gpu').onClick();check(reported.at(-1),['gpu',2],'component card reports the GPU position');
html=render({server:graphics,detail:'gpu',gpu:1,onDetailChange});gpuProps.onSelect('second.gpu');check(reported.at(-1),['gpu',2],'GPU list selection reports its position');const count=reported.length;gpuProps.onSelect('unknown');check(reported.length,count,'unknown GPU IDs are ignored');
html=render({server:graphics,detail:'cpu',onDetailChange});button('Grafikkarten').onClick(press());check(reported.at(-1),['gpu',2],'returning to the GPU tab keeps the chosen GPU');
render({server:graphics,detail:'gpu',onDetailChange},true);button('Grafikkarten').onClick(press());check(reported.at(-1),['gpu',undefined]);
const revoked={...graphics,permissions:[]};render({server:graphics,detail:'overview',onDetailChange},true);const retainedCard=buttons.find(props=>props['data-gpu-id']==='second.gpu');render({server:revoked,detail:'overview',onDetailChange});const stable=reported.length;retainedCard.onClick();check(reported.length,stable,'a retained GPU card cannot report after view right withdrawal');
console.log(`PASS: ${checks} hardware UI checks plus kit cards, KPI rows and tables, component grid with GPU and battery states, old-agent fallbacks, physical drives, drive list, Mainboard/BIOS, GPU focus and links, live/offline values, CPU/RAM history cards, copy toasts and revoked copy/view rights.`);
