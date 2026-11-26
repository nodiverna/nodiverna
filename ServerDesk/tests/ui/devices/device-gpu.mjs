// Real readonly GPU view on the kit: selection handlers, value guards, KPI tiles, facts and chart props.
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from '../../support/render-de.mjs';
const require=createRequire(import.meta.url),root=process.cwd(),cache=new Map(),charts=require('recharts'),jsx=require('react/jsx-runtime');
let states=[],cursor=0,selectors={},segments={},chartData=null,chartArea=null,tooltip=null,updates=0,checks=0,Segmented=null;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const nb=value=>value.replace(/ (?=(?:B|KiB|MiB|GiB|TiB)\b)/g,' ');
const react={...React,useState(initial){const index=cursor++;if(!states[index])states[index]={value:typeof initial==='function'?initial():initial};return [states[index].value,next=>{states[index].value=typeof next==='function'?next(states[index].value):next;}];},useMemo:fn=>fn()};
const track=original=>(type,props,...rest)=>{if(type==='select')selectors[props['aria-label']]=props;if(Segmented&&type===Segmented)segments[props.label]=props;if(type===charts.AreaChart)chartData=props.data;if(type===charts.Area)chartArea=props;if(type===charts.Tooltip)tooltip=props;return original(type,props,...rest);};
const runtime={...jsx,jsx:track(jsx.jsx),jsxs:track(jsx.jsxs)};
function load(file){
 const absolute=path.resolve(file);if(absolute===germanLocalePath)return germanLocale;if(absolute.endsWith('.css'))return {};if(cache.has(absolute))return cache.get(absolute).exports;
 const fixture={exports:{}};cache.set(absolute,fixture);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const localRequire=id=>{if(id==='react')return absolute===path.join(root,'ui/devices/hardware/device-gpu.tsx')?react:React;if(id==='react/jsx-runtime')return runtime;if(id==='@/ui/devices/device/agent-update-notice')return {__esModule:true,default:()=>{updates++;return React.createElement('aside',{'data-agent-update':'true'});}};if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),candidate=[base,base+'.ts',base+'.tsx'].find(name=>fs.existsSync(name)&&fs.statSync(name).isFile());if(candidate)return load(candidate);}return require(id);};
 new Function('require','module','exports',code)(localRequire,fixture,fixture.exports);return fixture.exports;
}
const {default:DeviceGpu,deviceGpuDetails}=load('ui/devices/hardware/device-gpu.tsx'),now=Date.now(),iso=new Date(now).toISOString(),GiB=1073741824;
({Segmented}=load('ui/kit/kit.tsx'));
const gpus=[{id:'luid.a\\phys_0',name:'NVIDIA GeForce RTX 4090',vendor:'nvidia',utilization:0,collectedAt:iso},{id:'luid.b',name:'AMD Radeon RX 7900 XTX',vendor:'amd',utilization:35,collectedAt:iso},{id:'luid.arc',name:'Intel Arc A770','vendor':'intel',utilization:10,collectedAt:iso}];
const details={id:gpus[0].id,collectedAt:iso,driverVersion:'32.0.15.7283',vendorDriverVersion:'572.83',driverModel:'WDDM 3.2',vbiosVersion:'95.02.3C.40.A0',vendorId:4318,deviceId:9860,subsystemId:0,revision:161,pciBusId:'0000:01:00.0',dedicatedMemoryBytes:24*GiB,sharedMemoryBytes:16*GiB,dedicatedMemoryUsedBytes:6*GiB,sharedMemoryUsedBytes:0,temperatureCelsius:66.6,coreClockMhz:2520,memoryClockMhz:10501,powerWatts:87.5,powerLimitWatts:450,fanPercent:110,pcieGeneration:1,pcieMaxGeneration:4,pcieLinkWidth:16,pcieMaxLinkWidth:16,memoryBusWidthBits:384,cudaCores:16384,sensorProvider:'nvidia-nvml'};
const amdDetails={id:gpus[1].id,collectedAt:iso,driverVersion:'31.0.AMD',dedicatedMemoryBytes:24*GiB,sharedMemoryBytes:16*GiB,dedicatedMemoryUsedBytes:4*GiB};
const server={id:'device',name:'Host',lastSeen:now,revoked:0,management:0,permissions:['view'],snapshot:{agentVersion:'4.6.6',gpus,gpuDetails:[details,amdDetails]}};
const viewer={id:'reader',label:'Reader',permissions:[]},base={server,viewer,demo:false,now,samples:[],jobs:[]};
function render(overrides={},reset=false){if(reset)states=[];cursor=0;selectors={};segments={};chartData=null;chartArea=null;tooltip=null;updates=0;return renderToStaticMarkup(React.createElement(DeviceGpu,{...base,...overrides}));}
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** The KPI tile with this label (kit Kpi: article aria-label "Label: value"). */
const metric=(html,label)=>html.match(new RegExp('<article class="sdx-kpi[^"]*"[^>]*aria-label="'+escape(label)+': [^"]*"[^>]*>[\\s\\S]*?</article>'))?.[0];
const value=(html,label)=>{const match=metric(html,label)?.match(/<span class="sdx-kpi-value">([^<]*)(?:<small class="sdx-kpi-unit">([^<]*)<\/small>)?<\/span>/);return match?match[1]+(match[2]?' '+match[2]:''):undefined;};
/** The GPU head: a kit Card whose title (h2) is the GPU name after its Gpu tile. */
const head=html=>html.match(/<section class="sdx-card dgp-head"[^>]*>[\s\S]*?<\/section>/)?.[0];
const headTitle=html=>head(html)?.match(/<h2>(?:<span class="sdx-icon-tile[^>]*>[\s\S]*?<\/span>)([^<]+)<\/h2>/)?.[1];
const fact=(html,label)=>html.match(new RegExp('<dt>'+escape(label)+'</dt><dd>([\\s\\S]*?)</dd>'))?.[1];

let html=render({},true);
// the head card with the Gpu tile, the name, the vendor description and the meta.
ok(head(html)&&head(html).includes('lucide-gpu')&&head(html).includes('NVIDIA · Grafikkarte')&&head(html).includes('Aktuelle Agentmeldung'),'the GPU head is a kit Card with the Gpu tile');
check(headTitle(html),'NVIDIA GeForce RTX 4090','the head title is the GPU name');
ok(/<select class="sdx-select sdx-select-sm" aria-label="Grafikkarte auswählen"/.test(head(html)),'with more GPUs the chooser is the kit Select (sm) in the head');
// KPI tiles.
ok(/<section class="sdx-kpi-row" aria-label="Grafikkartenwerte">/.test(html),'the GPU KpiRow');
check(value(html,'GPU-Auslastung'),'0 %','a real zero utilization stays');
check(value(html,'VRAM belegt'),nb('6 GiB'),'VRAM through formatBytes');ok(/role="meter"[^>]*aria-valuenow="25"/.test(metric(html,'VRAM belegt'))&&metric(html,'VRAM belegt').includes(nb('von 24 GiB')),'VRAM meter and detail');
check(value(html,'Temperatur'),'67'+String.fromCharCode(160)+'°C','temperature through formatTemperature (rounded)');check(value(html,'Leistung'),'87,5 W','power');ok(metric(html,'Leistung').includes('Limit 450 W'),'power limit detail');check(value(html,'GPU-Takt'),'2.520 MHz','core clock');check(value(html,'Speichertakt'),'10.501 MHz','memory clock');check(value(html,'Lüfter (Soll)'),'110 %','fan');assert.doesNotMatch(html,/RPM|DDR/);
// facts with mono identifiers, the sensor line and the memory bus unit.
check(fact(html,'Windows-Treiber'),'<span class="mono">32.0.15.7283</span>','Windows driver in mono');check(fact(html,'NVIDIA-Treiber'),'<span class="mono">572.83</span>','vendor driver in mono');check(fact(html,'VBIOS'),'<span class="mono">95.02.3C.40.A0</span>','VBIOS in mono');check(fact(html,'Hersteller-ID'),'<span class="mono">0x10DE</span>','vendor id in mono');check(fact(html,'PCI-Adresse'),'<span class="mono">0000:01:00.0</span>','PCI address in mono');
assert.match(html,/WDDM 3\.2/);assert.match(html,/Gen 1 · x16/);assert.match(html,/Gen 4 · x16/);assert.match(html,/0xA1/);assert.match(html,/0x00000000/);assert.match(html,/16\.384/);check(fact(html,'Speicherbus'),'384 Bit','memory bus through hardware.unit.bit');check(fact(html,'Dedizierter Speicher'),nb('24 GiB'),'memory facts through formatBytes');
ok(html.includes('<dl class="sdx-facts">')&&/<p class="dgp-sensor-status"><svg/.test(html),'kit Facts and the sensor line');check(updates,0,'modern detail inventory does not add an unnecessary update widget');
ok(!/dgp-metric|dgp-card|dgp-notice|v3-empty|dgp-identity/.test(html),'no classic GPU classes');
// The driver card follows the head and precedes the KPI row.
ok(html.indexOf('dgp-head')<html.indexOf('dgd-card')&&html.indexOf('dgd-card')<html.indexOf('sdx-kpi-row'),'the Graphics driver card sits between the head and the KPI row');

const select=selectors['Grafikkarte auswählen'];check(select.value,gpus[0].id,'default selection identifies the first physical adapter');select.onChange({target:{value:gpus[1].id}});html=render();check(headTitle(html),'AMD Radeon RX 7900 XTX','the chooser switches GPUs');assert.doesNotMatch(html,/CUDA-Kerne|NVIDIA-Treiber|95\.02\.3C/,'GPU selection never reuses another adapter\'s metadata');check(value(html,'VRAM belegt'),nb('4 GiB'),'AMD VRAM');check((html.match(/<article class="sdx-kpi/g)??[]).length,2,'AMD without optional sensors has utilization/VRAM rather than seven empty tiles');
selectors['Grafikkarte auswählen'].onChange({target:{value:'not-a-gpu'}});check(selectors['Grafikkarte auswählen'].value,gpus[1].id,'invalid selector values cannot select unrelated telemetry');html=render({focusGpu:gpus[0].id});check(headTitle(html),'NVIDIA GeForce RTX 4090','new overview focus overrides a previous manual selection');
html=render({focusGpu:gpus[2].id});check(headTitle(html),'Intel Arc A770','Intel GPU');assert.doesNotMatch(html,/CUDA-Kerne|NVIDIA-Treiber/);ok(/sdx-notice sdx-notice-info" role="status">[\s\S]*?Noch keine Hardware- oder Sensordaten gemeldet\./.test(html),'no detail data is an info Notice');
html=render({server:{...server,id:'second-device',snapshot:{...server.snapshot,gpus:[gpus[1]],gpuDetails:[amdDetails]}}});check(headTitle(html),'AMD Radeon RX 7900 XTX','selection from another device does not leak into its first GPU');ok(!html.includes('<select'),'one GPU: no chooser');
const zero={...details,temperatureCelsius:0,coreClockMhz:0,memoryClockMhz:0,powerWatts:0,powerLimitWatts:0,fanPercent:0,dedicatedMemoryUsedBytes:0};
html=render({server:{...server,snapshot:{...server.snapshot,gpuDetails:[zero]}},focusGpu:gpus[0].id},true);
for(const [label,text] of [['Temperatur','0 °C'],['GPU-Takt','0 MHz'],['Speichertakt','0 MHz'],['Leistung','0 W'],['Lüfter (Soll)','0 %'],['VRAM belegt',nb('0 B')]])check(value(html,label),text,'real sensor zero is preserved: '+label);
const invalid={...details,temperatureCelsius:NaN,powerWatts:Infinity,fanPercent:201,coreClockMhz:-1,memoryClockMhz:100001,dedicatedMemoryUsedBytes:Number.MAX_SAFE_INTEGER+1,dedicatedMemoryBytes:-1,pcieGeneration:0,pcieMaxGeneration:17,cudaCores:1.5,driverModel:'x'.repeat(129),pciBusId:'x'.repeat(33)};
html=render({server:{...server,snapshot:{...server.snapshot,gpuDetails:[invalid]}},focusGpu:gpus[0].id},true);
for(const label of ['Temperatur','Leistung','Lüfter (Soll)','GPU-Takt','Speichertakt','VRAM belegt'])check(value(html,label),'—','invalid sensors stay unknown: '+label);
ok(!metric(html,'VRAM belegt').includes('sdx-meter'),'no VRAM meter without a value');check(fact(html,'Treibermodell'),'Nicht gemeldet','a missing text fact says Not reported');
const normalized=deviceGpuDetails({...server,snapshot:{...server.snapshot,gpuDetails:[invalid]}},now,gpus[0].id);for(const key of ['temperatureCelsius','powerWatts','fanPercent','coreClockMhz','memoryClockMhz','dedicatedMemoryUsedBytes','dedicatedMemoryBytes','pcieGeneration','pcieMaxGeneration','cudaCores','driverModel','pciBusId'])check(normalized.fields[key],null,'invalid field is masked: '+key);
for(const override of [{lastSeen:now-180000},{maintenance:{state:'updating',version:'4.6.6',notBefore:now}}]){
 html=render({server:{...server,...override},focusGpu:gpus[0].id},true);assert.match(head(html),/Letzter Inventarstand/);assert.match(html,/32\.0\.15\.7283/);ok(html.includes(nb('24 GiB')),'offline keeps the inventory');assert.match(html,/Gen 4 · x16/);
 for(const label of ['GPU-Auslastung','Temperatur','Leistung','Lüfter (Soll)','GPU-Takt','Speichertakt','VRAM belegt']){check(value(html,label),'—','offline/maintenance values remain unknown: '+label);ok(!metric(html,label).includes('sdx-meter'),'no meter on a stale value: '+label);}
}
for(const collectedAt of [new Date(now-120001).toISOString(),new Date(now+1).toISOString(),'invalid',undefined]){
 const detail={...details,collectedAt};html=render({server:{...server,snapshot:{...server.snapshot,gpuDetails:[detail]}},focusGpu:gpus[0].id},true);assert.match(html,/32\.0\.15\.7283/);assert.match(html,/Sensorwerte nicht aktuell/);check(value(html,'Temperatur'),'—','stale temperature');check(value(html,'GPU-Auslastung'),'0 %','core GPU measurement uses its own independent freshness');
}
check(deviceGpuDetails({...server,snapshot:{...server.snapshot,gpuDetails:[{...details,collectedAt:new Date(now-120000).toISOString()}]}},now,gpus[0].id).fresh,true,'120-second detail boundary remains valid');
html=render({server:{...server,snapshot:{...server.snapshot,gpuDetails:[{...details,id:'different-adapter'}]}},focusGpu:gpus[0].id},true);assert.doesNotMatch(html,/32\.0\.15\.7283|95\.02\.3C|Sensorstand/,'different GPU IDs are never joined by index or model name');
html=render({server:{...server,snapshot:{...server.snapshot,agentVersion:'4.6.5',gpuDetails:undefined}},focusGpu:gpus[0].id},true);ok(/sdx-notice sdx-notice-info" role="status">[\s\S]*?Aktualisiere den Agent auf 4\.6\.6 oder neuer, um Hardware- und Sensordaten zu sehen/.test(html),'the agent-update Notice');check(value(html,'GPU-Auslastung'),'0 %','utilization without details');assert.doesNotMatch(html,/class="dgp-facts-grid"|aria-label="Temperatur/);check(updates,1,'older agent can expose the existing permitted agent update widget');
// the empty states.
for(const override of [{server:{...server,permissions:[]}},{server:{...server,revoked:1}}]){html=render(override,true);ok(/<div class="sdx-empty">[\s\S]*lucide-lock[\s\S]*<strong>Hardwareinventar nicht verfügbar<\/strong><p>[^<]*Berechtigung „Geräte und Monitoring ansehen“/.test(html),'no view right: the Lock Empty');assert.doesNotMatch(html,/GeForce|572\.83|Grafikkarte auswählen|v3-empty/,'denied view exposes no GPU inventory');}
html=render({server:{...server,snapshot:{gpus:[{...gpus[2],name:'Intel UHD Graphics 770'}]}}},true);ok(/lucide-gpu[\s\S]*<strong>Keine unterstützte Grafikkarte<\/strong><p>Details zur Grafikkarte erscheinen, wenn das Gerät eine unterstützte Grafikkarte meldet\.<\/p>/.test(html),'no supported GPU: the Gpu Empty');assert.doesNotMatch(html,/dgp-head|v3-empty/);
// History: the range Segmented in the card head, the chart skeleton and the Empty.
const at=now-600000,samples=[{serverId:server.id,at,cpu:20,memory:30,gpus:[{...gpus[0],utilization:0,collectedAt:new Date(at).toISOString()}]},{serverId:server.id,at:at+1000,cpu:20,memory:30},{serverId:server.id,at:at+2000,cpu:20,memory:30,gpus:[{...gpus[0],utilization:45,collectedAt:new Date(at+2000).toISOString()}]}];
html=render({samples,focusGpu:gpus[0].id,historyLoading:true},true);assert.match(html,/GPU-Auslastungsverlauf für NVIDIA GeForce RTX 4090/);assert.doesNotMatch(html,/GPU-Verlauf wird geladen/);check(chartData.map(point=>point.value),[0,null,45],'selected GPU-only chart preserves historical zero and gaps');check(chartArea.connectNulls,false,'GPU history never connects across missing measurements');check(chartArea.dot,{r:3},'first GPU measurements remain visible');check(tooltip.formatter(0),['0 %',gpus[0].name],'GPU Tooltip includes the selected adapter model');
ok(/<section class="sdx-card dgp-history"[\s\S]*?sdx-card-actions"><div class="sdx-segmented sdx-segmented-sm" role="group" aria-label="Zeitraum des GPU-Verlaufs"/.test(html),'the range is a Segmented in the history card head');
html=render({samples,focusGpu:gpus[1].id,historyLoading:true});assert.match(html,/role="status" aria-label="GPU-Verlauf wird geladen"/);ok(html.includes('sdx-skeleton-chart'),'the kit chart skeleton');check(chartData,null,'another GPU cannot adopt the selected adapter\'s history');
html=render({samples,focusGpu:gpus[1].id});ok(html.includes('<strong>Keine GPU-Messwerte in diesem Zeitraum</strong><p>Wähle einen längeren Zeitraum oder warte auf die nächste Meldung des Agents.</p>'),'an empty history shows the Empty');
html=render({samples,focusGpu:gpus[0].id,server:{...server,lastSeen:now-180000}});assert.match(html,/GPU-Auslastungsverlauf für NVIDIA/);check(chartData.map(point=>point.value),[0,null,45],'GPU history remains available offline');
segments['Zeitraum des GPU-Verlaufs'].onChange('30');html=render({samples:[...samples,{serverId:server.id,at:now-1800001,cpu:0,memory:0,gpus:[{...gpus[0],utilization:99,collectedAt:new Date(now-1800001).toISOString()}]}],focusGpu:gpus[0].id});check(chartData.length,3,'actual range selector filters GPU history');
console.log(`PASS: ${checks} GPU detail checks plus actual DOM/handlers for view rights, the kit head with GPU chooser, KPI tiles with IEC units, legacy agents, driver/memory/hardware facts, sensor zero/invalid/freshness/offline states and GPU-only history.`);
