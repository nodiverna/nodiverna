// The device panel Management → Defender on the kit (UI-Rework 13b), rendered with React SSR:
// SectionHead with the hidden title, description and last-report meta; one PanelUnavailable without
// defender.control; the Status and Scans facts as the kit Facts; the detections as a flush kit DataTable
// ("Detections"/"Funde") with sort heads on Threat, Severity and Detected (sortTableRows) and the
// truncated sentence as its foot; "Run quick scan" as a secondary button. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {default:DeviceDefender}=await import('../../../ui/devices/protection/device-defender.tsx');
const {sortTableRows}=await import('../../../ui/base/table-sort.ts');
const {defenderSeverityRank,sortedDetections}=await import('../../../lib/defender.ts');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const now=Date.parse('2026-11-04T12:00:00Z'),day=86400000,iso=offset=>new Date(now-offset).toISOString();
const owner={id:'owner',label:'owner',permissions:['*']},reader={id:'reader',label:'reader',permissions:[]};
const detections=[
 {id:'{Q}',threatId:'3',name:'Virus:DOS/EICAR_Test_File',severity:'severe',status:'quarantined',active:false,path:'C:\\eicar.txt',resourceCount:1,at:iso(5*day),user:null},
 {id:'{L}',threatId:'2',name:'PUA:Win32/Example',severity:'low',status:'abandoned',active:true,path:'C:\\Temp\\pua.exe',resourceCount:1,at:iso(day),user:null},
 {id:'{T}',threatId:'1',name:'Trojan:Win32/Wacatac.B!ml',severity:'high',status:'detected',active:true,path:'C:\\invoice.pdf.exe',resourceCount:3,at:iso(2*day),user:null}];
const report=(extra={})=>({available:true,collectedAt:iso(60000),mode:'normal',antivirusEnabled:true,realTimeProtection:true,tamperProtected:true,quickScanAt:iso(day),fullScanAt:iso(10*day),signatureAt:iso(3600000),signatureVersion:'1.421.1868.0',productVersion:'4.18.24090.11',otherAntivirus:[],detectionCount:250,activeCount:2,highestActiveSeverity:'high',truncated:true,detections,exclusions:{paths:[],extensions:[],processes:[]},...extra});
const kinds=['defender-status','defender-quick-scan','defender-full-scan','defender-update-signatures','defender-clean-detections'];
const server=(extra={})=>({id:'d1',name:'SRV-01',lastSeen:now-10000,revoked:0,management:1,createdAt:now-30*day,permissions:['view','defender.read','defender.control'],issues:[],snapshot:{agentCapabilities:kinds,mode:'Management',defender:report()},...extra});
const area=(device=server(),viewer=owner,locale='en',extra={})=>render(h(DeviceDefender,{server:device,viewer,demo:false,now,saving:false,jobs:[],onConfirm:()=>{},...extra}),locale);

// ---- SectionHead hideTitle and one PanelUnavailable ----
let html=area();
ok(/aria-label="Detections"[^>]*><table[\s\S]*?<tbody><tr class="sdx-enter"/.test(html),'the first render: the detection rows rise in once (entranceId defender-detections)');
ok(/^<div class="sdx-defender-panel"><header class="sdx-section-head"><div class="sdx-section-head-text"><h2 class="sr-only">Microsoft Defender<\/h2><p>See whether Microsoft Defender protects this device, run scans, and review detections and exclusions\.<\/p><p class="sdx-section-head-meta">Last report /.test(html),'the panel starts with SectionHead hideTitle: title, description and the last report meta');
ok(!html.includes('sdx-notice-info'),'with defender.control there is no panel notice');
html=area(server({permissions:['view','defender.read']}),reader);
ok(html.includes('sdx-notice-info')&&text(html).includes('You can still read the Defender report.'),'without defender.control: one panel notice with the read-only sentence');
check((html.match(/sdx-notice-info/g)??[]).length,1,'exactly one panel notice');
ok(text(area(server(),owner,'en',{demo:true})).includes('You can still read the Defender report.'),'demo: the notice with the demo reason');
ok(text(area(server({permissions:['view','defender.read']}),reader,'de')).includes('Den Defender-Bericht kannst du weiter lesen.'),'German read-only sentence');
ok(html.indexOf('sdx-section-head')<html.indexOf('sdx-notice')&&html.indexOf('sdx-notice')<html.indexOf('sdx-kpi-row'),'order: head, notice, KPI row');
ok(text(area(server({snapshot:{agentCapabilities:[]}}))).includes('Defender not reported'),'the early states keep their text');

// ---- kit Facts, Quick scan secondary ----
html=area();
const facts=html.match(/<dl class="sdx-facts">/g)??[];
check(facts.length,2,'the Status and Scans cards use the kit Facts (dl.sdx-facts)');
ok(/<dt>Product version<\/dt><dd><span class="mono">4\.18\.24090\.11<\/span><\/dd>/.test(html),'a mono fact keeps the mono face');
ok(/<button[^>]*class="sdx-btn sdx-btn-secondary sdx-btn-sm"[^>]*>.*?<span>Run quick scan<\/span>/.test(html)&&!html.includes('sdx-btn-primary'),'Run quick scan is a secondary small button; no primary in the panel');

// ---- the detections DataTable ----
ok(/<div class="sdx-table-wrap sdx-table-wrap-flush" role="region" aria-label="Detections"/.test(html),'a flush DataTable region "Detections"');
ok(/role="region" aria-label="Funde"/.test(area(server(),owner,'de')),'the German card title (defender.detections.title, unchanged: Funde) names the region');
check([...html.matchAll(/<th scope="col"[^>]*aria-sort="[a-z]+"><button[^>]*>([^<]+)</g)].map(match=>match[1]),['Threat','Severity','Detected'],'sort heads on Threat, Severity and Detected');
ok(/<div class="sdx-table-foot"><p>Showing the newest 3 of 250 detections\.<\/p><\/div>/.test(html),'the truncated sentence is the foot');
ok(html.includes('<td><strong>PUA:Win32/Example</strong></td>'),'an active row keeps its mark (strong name)');
const names=markup=>[...markup.matchAll(/<td>(?:<strong>)?([A-Za-z]+:[^<]+)</g)].map(match=>match[1].split(':')[0]);
check(names(html),['PUA','Trojan','Virus'],'default order: sortedDetections (active first, newest first)');
const values={threat:row=>row.name,severity:row=>defenderSeverityRank[row.severity],detected:row=>row.at?Date.parse(row.at):null};
check(sortTableRows(sortedDetections(detections),{column:'severity',direction:'desc'},values).map(row=>row.id),['{Q}','{T}','{L}'],'Severity sorts by rank through sortTableRows');
check(sortTableRows(sortedDetections(detections),{column:'detected',direction:'asc'},values).map(row=>row.id),['{Q}','{T}','{L}'],'Detected sorts by time');
check(sortTableRows(sortedDetections(detections),{column:'threat',direction:'asc'},values).map(row=>row.id),['{L}','{T}','{Q}'],'Threat sorts by name');
html=area(server({snapshot:{agentCapabilities:kinds,mode:'Management',defender:report({truncated:false})}}));
ok(!html.includes('sdx-table-foot'),'no foot without truncation');

// ---- Source guards ----
const source=readFileSync('ui/devices/protection/device-defender.tsx','utf8');
ok(!/<table\b/.test(source)&&!/function Fact\b/.test(source)&&!/dl className="sdx-facts"/.test(source)&&!/variant="primary"/.test(source),'device-defender.tsx: no <table, no local Fact, no hand dl.sdx-facts, no primary');
ok(/entranceId="defender-detections"/.test(source)&&/sortTableRows\(sortedDetections\(detections\)/.test(source),'the entrance id and the default order through sortTableRows');
ok(!/sdx-defender-table/.test(readFileSync('ui/devices/protection/defender.css','utf8')),'the hand table CSS is gone');

console.log(`PASS device Defender panel (${checks} checks): SectionHead with hidden title and last report, one PanelUnavailable, kit Facts, the secondary quick scan, the detections DataTable with sort heads, default order, foot and entrance.`);
