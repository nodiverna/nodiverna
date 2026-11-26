// The Defender views of agent 4.14.0 rendered with React SSR in English and
// German: the device area Management → Defender in every state (older agent,
// not reported yet, not installed, failed read, passive with and without a
// product name, off with and without another antivirus), its KPI row, the
// detections table, the exclusions and the lock without defender.read; the
// scope tab "Protection" and its helpers in lib/defender.ts. The actions of agent
// 4.15.0: defenderActionBlock (ui/devices/protection/defender-model.ts) in priority order, the buttons and their blocked
// texts, the running portal scan, the confirmations (ui/devices/protection/defender-actions.ts),
// the selection and the bulk bar of the scope tab. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {demoData}=await import('../../../ui/shell/demo.ts');
const {default:DeviceDefender}=await import('../../../ui/devices/protection/device-defender.tsx');
const {default:ProtectionTab,DefenderBulkBar}=await import('../../../ui/devices/protection/protection-tab.tsx');
const {default:DeviceSummary}=await import('../../../ui/devices/device/device-summary.tsx');
const actions=await import('../../../ui/devices/protection/defender-actions.ts');
const defender=await import('../../../lib/defender.ts');
const defenderModel=await import('../../../ui/devices/protection/defender-model.ts');
const {DataTable}=await import('../../../ui/kit/data-table.tsx');
const {readFileSync}=await import('node:fs');
// The column heads of a DataTable: plain heads and the sort buttons of sortable heads.
const heads=markup=>[...markup.matchAll(/<th scope="col"[^>]*>(?:<button[^>]*>)?([^<]+)</g)].map(match=>match[1]);
const sortHeads=markup=>[...markup.matchAll(/<th scope="col"[^>]*aria-sort="[a-z]+"><button[^>]*>([^<]+)</g)].map(match=>match[1]);
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
const now=Date.parse('2026-11-04T12:00:00Z'),day=86400000,iso=offset=>new Date(now-offset).toISOString();
const owner={id:'owner',label:'owner',permissions:['*']},reader={id:'reader',label:'reader',permissions:[]};
const report=(extra={})=>({available:true,collectedAt:iso(60000),mode:'normal',antivirusEnabled:true,realTimeProtection:true,tamperProtected:true,quickScanAt:iso(day),fullScanAt:iso(10*day),signatureAt:iso(2*3600000),signatureVersion:'1.421.1868.0',productVersion:'4.18.24090.11',otherAntivirus:[],detectionCount:0,activeCount:0,highestActiveSeverity:null,truncated:false,detections:[],exclusions:{paths:[],extensions:[],processes:[]},...extra});
const server=(defenderValue,extra={})=>({id:'d1',name:'SRV-01',lastSeen:now-10000,revoked:0,management:0,createdAt:now-30*day,permissions:['view','defender.read'],issues:[],snapshot:{agentCapabilities:['defender-status'],...(defenderValue===undefined?{}:{defender:defenderValue})},...extra});
const area=(device,viewer=owner,locale='en',extra={})=>render(h(DeviceDefender,{server:device,viewer,demo:false,now,saving:false,jobs:[],onConfirm:()=>{},...extra}),locale);

// ---- Area states ----
check(text(area(server(undefined,{snapshot:{agentCapabilities:[]}}))),'Microsoft Defender Defender not reported This device does not report Microsoft Defender yet. Update the agent to 4.14.0 or later.','older agent');
ok(text(area(server(undefined))).includes('Waiting for the first report The agent has not reported Microsoft Defender yet. The first report arrives within 5 minutes.'),'capability without a report: the title states the fact');
ok(text(area(server({available:false,reason:'not-installed',collectedAt:iso(0)}))).includes('Microsoft Defender is not installed Install the Windows feature Microsoft Defender Antivirus, or protect the device with another antivirus.'),'not installed');
for(const reason of ['access-denied','error']){const html=area(server({available:false,reason,collectedAt:iso(0)}));ok(html.includes('sdx-notice-warning')&&text(html)==='The agent could not read the Defender status. It tries again within 5 minutes.',`${reason}: the warning notice with the retry sentence`);}
check(area({...server(undefined),snapshot:null}),'','no snapshot: the shared offline handling only');
ok(text(area(server(undefined,{snapshot:{agentCapabilities:[]}}),owner,'de')).includes('Dieses Gerät meldet Microsoft Defender noch nicht. Aktualisiere den Agent auf 4.14.0 oder neuer.'),'older agent (de)');

// ---- Notices ----
const contoso=[{name:'Contoso Endpoint Security',enabled:true}];
let html=area(server(report({mode:'passive',realTimeProtection:false,otherAntivirus:contoso})));
ok(html.includes('sdx-notice-info')&&text(html).includes('Defender runs in passive mode. Contoso Endpoint Security protects this device.'),'passive with the product name');
ok(text(html).includes('Defender status Passive Contoso Endpoint Security'),'the status KPI names the product');
html=area(server(report({mode:'sxs-passive',otherAntivirus:null})));
ok(text(html).includes('Defender runs in passive mode because another antivirus protects this device.')&&text(html).includes('Passive (side by side)')&&text(html).includes('Not available on Windows Server'),'passive without a name; the mode fact; no Security Center');
ok(text(area(server(report({mode:'edr-block'})))).includes('EDR block mode'),'EDR block mode');
html=area(server(report({realTimeProtection:false,otherAntivirus:contoso})));
ok(html.includes('sdx-notice-info')&&text(html).includes('Defender is off. Contoso Endpoint Security protects this device.'),'off next to another antivirus');
html=area(server(report({antivirusEnabled:false,otherAntivirus:[{name:'Old AV',enabled:false}]})));
ok(html.includes('sdx-notice-danger')&&text(html).includes('Defender is off and no other antivirus is reported. Turn on Defender on the device, or install another antivirus.')&&text(html).includes('Old AV (off)'),'off without another antivirus: the danger notice and the fix');
ok(text(area(server(report({mode:'passive',otherAntivirus:contoso})),owner,'de')).includes('Defender läuft im Passivmodus. Contoso Endpoint Security schützt dieses Gerät.'),'passive (de)');
ok(!text(area(server(report()))).includes('passive mode')&&!area(server(report())).includes('sdx-notice'),'an active Defender has no notice');

// ---- KPI row, status and scans ----
const detections=[
 {id:'{Q}',threatId:'3',name:'Virus:DOS/EICAR_Test_File',severity:'severe',status:'quarantined',active:false,path:'C:\\Users\\anna\\eicar.txt',resourceCount:1,at:iso(5*day),user:'CONTOSO\\anna'},
 {id:'{L}',threatId:'2',name:'PUA:Win32/Example',severity:'low',status:'abandoned',active:true,path:'C:\\Temp\\pua.exe',resourceCount:1,at:iso(day),user:null},
 {id:'{T}',threatId:'1',name:'Trojan:Win32/Wacatac.B!ml',severity:'severe',status:'detected',active:true,path:'C:\\Users\\anna\\Downloads\\invoice.pdf.exe',resourceCount:3,at:iso(2*day),user:'CONTOSO\\anna'},
 {id:'{M}',threatId:'4',name:null,severity:'moderate',status:'failed',active:false,path:null,resourceCount:0,at:null,user:null}];
const full=report({detectionCount:250,activeCount:2,highestActiveSeverity:'severe',truncated:true,detections,tamperProtected:null,quickScanAt:iso(12*day),fullScanAt:null,
 exclusions:{paths:['D:\\SQLData'],extensions:[],processes:['sqlservr.exe']}});
const scanIssue={key:'scan',ruleId:'scan-age',level:'warning',live:false,params:{scanAt:iso(12*day),threshold:7}};
html=area(server(full,{issues:[scanIssue]}));
let shown=text(html);
ok(html.includes('aria-label="Microsoft Defender at a glance"')&&html.includes('sdx-kpi-row'),'the KPI row');
ok(shown.includes('Defender status Active')&&shown.includes('Active detections 2 250 detections in total'),'status and active detections KPI');
ok(html.includes('sdx-kpi-critical'),'active detections use the critical tone');
ok(shown.includes('Last scan 12 days ago Quick scan')&&shown.includes('Signatures 2 h ago Version 1.421.1868.0'),'last scan and signatures KPI');
ok(shown.includes('Tamper protection Not reported')&&shown.includes('Other antivirus None reported')&&shown.includes('Product version 4.18.24090.11'),'status facts');
ok(shown.includes('Older than 7 days')&&shown.includes('Last full scan Never'),'the scan pill from the issue threshold; a missing full scan is Never');
ok(!text(area(server(full))).includes('Older than'),'no pill without an open scan-age issue (no client threshold)');

// ---- Detections table ----
// The detections are a kit DataTable since UI-Rework 13b: Threat, Severity and Detected are sort heads.
check([...html.matchAll(/<th scope="col"[^>]*>(?:<button[^>]*>)?([^<]+)/g)].map(match=>match[1]).slice(-6),['Threat','Severity','Status','Path','User','Detected'],'detection columns');
const rows=(html.match(/aria-label="Detections"[^>]*><table[\s\S]*?<\/table>/)?.[0].match(/<tr\b/g)??[]).length-1;
check(rows,4,'four rows');
const order=[...html.matchAll(/<td>(?:<strong>)?([^<]*?(?:Trojan|PUA|EICAR)[^<]*|<span class="sdx-muted-cell">Unnamed threat)/g)].map(match=>match[1].includes('Trojan')?'T':match[1].includes('PUA')?'L':match[1].includes('EICAR')?'Q':'M');
check(order,['L','T','Q','M'],'active first, then newest first');
ok(/sdx-pill-critical"><i aria-hidden="true"><\/i>Severe/.test(html)&&/sdx-pill-neutral"><i aria-hidden="true"><\/i>Low/.test(html)&&/sdx-pill-warning"><i aria-hidden="true"><\/i>Moderate/.test(html),'severity pills');
ok(/sdx-pill-critical"><i aria-hidden="true"><\/i>Active/.test(html)&&/sdx-pill-success"><i aria-hidden="true"><\/i>Quarantined/.test(html)&&/sdx-pill-warning"><i aria-hidden="true"><\/i>Action failed/.test(html),'status pills');
ok(shown.includes('+2 more files')&&shown.includes('Showing the newest 4 of 250 detections.'),'more files and the truncated foot');
ok(html.includes('sdx-enter'),'the first rows use the entrance stagger');
ok(text(area(server(report()))).includes('No detections Defender has not reported any threats on this device.'),'no detections');

// ---- Exclusions ----
ok(shown.includes('You can\'t change exclusions here. Change them through Group Policy, Intune or on the device.')&&shown.includes('Paths 1 D:\\SQLData')&&shown.includes('File extensions 0 None')&&shown.includes('Processes 1 sqlservr.exe'),'three exclusion groups');
ok(!/<(input|button|textarea)/.test(html.slice(html.indexOf('Exclusions'))),'no edit control in the exclusions');
ok(text(area(server(report()))).includes('No exclusions Defender scans every path, file type and process on this device.'),'no exclusions');
ok(text(area(server(report({exclusions:null})))).includes('The agent could not read the exclusions'),'exclusions not readable');

// ---- Lock without defender.read ----
const stripped=Object.fromEntries(Object.entries(full).filter(([key])=>key!=='detections'&&key!=='exclusions'));
html=area(server(stripped,{permissions:['view'],issues:[scanIssue]}),reader);shown=text(html);
ok(shown.includes('Detections are hidden Detections contain file paths and usernames. Ask an administrator for the permission “View Microsoft Defender”.')&&shown.includes('Exclusions are hidden'),'the lock state with the right name');
ok(shown.includes('Active detections 2')&&shown.includes('Last quick scan')&&shown.includes('Mode Active'),'KPI row, status and scans stay');
ok(!shown.includes('Trojan')&&!shown.includes('SQLData'),'nothing of the stripped lists');
ok(text(area(server(full,{permissions:['view']}),reader)).includes('Detections are hidden'),'the client check also hides lists that reached it');
ok(text(area(server(stripped,{permissions:['view']}),reader,'de')).includes('Funde ausgeblendet Funde enthalten Dateipfade und Benutzernamen. Frag eine Administratorin oder einen Administrator nach der Berechtigung „Microsoft Defender ansehen“.'),'lock (de)');
ok(text(area(server(full),owner,'de')).includes('Aktive Funde 2 250 Funde insgesamt'),'German KPI');

// ---- Helpers of the scope tab ----
const device=(id,value,extra={})=>({...server(value,extra),id,name:id});
const fleet=[
 device('threat',report({activeCount:1,detectionCount:1,highestActiveSeverity:'high',detections:[{...detections[2],active:true}]}),{issues:[{key:'defender',ruleId:'defender-off',level:'warning',live:false,params:{}}]}),
 device('off',report({realTimeProtection:false}),{issues:[{key:'defender',ruleId:'defender-off',level:'warning',live:false,params:{}},scanIssue]}),
 device('scan',report({quickScanAt:iso(30*day)}),{issues:[scanIssue]}),
 device('passive',report({mode:'passive',otherAntivirus:contoso})),
 device('ok',report()),
 device('missing',{available:false,reason:'not-installed',collectedAt:iso(0)}),
 device('old',undefined,{snapshot:{agentCapabilities:[]}}),
 device('pending',undefined),
 device('failed',{available:false,reason:'error',collectedAt:iso(0)}),
 device('hidden',stripped)];
check(fleet.map(defender.protectionStatus),['threat','off','scan-old','passive','protected','not-installed','update-agent','not-reported','not-reported','threat'],'status by priority');
check(defender.protectionCounts(fleet),{all:10,detections:2,'scan-old':2,off:2,passive:1,'not-reported':4},'filter counts; a device can be in more than one');
check(fleet.filter(item=>defender.matchesProtectionFilter(item,'off')).map(item=>item.id),['threat','off'],'Off reads the issues, not the snapshot');
check(defender.protectionRow(fleet[0]).newest,'Trojan:Win32/Wacatac.B!ml','the newest active detection with the list');
check(defender.protectionRow(fleet[9]).newest,undefined,'without the list (no defender.read) the column has no name');
check(defender.protectionRow(fleet[3]).coveredBy,'Contoso Endpoint Security','passive names the other antivirus');
check(defender.sortedDetections(detections).map(item=>item.id),['{L}','{T}','{Q}','{M}'],'detection order');
check(defender.defenderLastScanKind({quickScanAt:iso(3*day),fullScanAt:iso(day)}),{at:iso(day),kind:'full'},'the newer scan is the full scan');

// ---- Scope tab ----
const tabProps={now,onOpen:()=>{},viewer:owner,demo:false,saving:false,onConfirm:()=>{}};
html=render(h(ProtectionTab,{...tabProps,devices:fleet}));shown=text(html);
ok(!html.includes('sdx-kpi'),'no KPI row: the filter below carries the counts');
ok(shown.includes('All 10')&&shown.includes('With detections 2')&&shown.includes('Scan too old 2')&&shown.includes('Not reported 4')&&shown.includes('Passive 1'),'the filter with counts');
// Only the worst filter with a count above 0 carries its tone: Detections, then Off, then Scan too old (worstTone).
const tones=markup=>[...markup.match(/aria-label="Show">([\s\S]*?)<\/div>/)?.[1].matchAll(/<span>([^<]+)<\/span><b(?: class="sdx-count-([a-z]+)")?>/g)??[]].filter(match=>match[2]).map(match=>[match[1],match[2]]);
check(tones(html),[['With detections','critical']],'detections present: only With detections carries its tone');
check(tones(render(h(ProtectionTab,{...tabProps,devices:fleet.filter(item=>item.id!=='threat'&&item.id!=='hidden')}))),[['Off','critical']],'no detections: only Off carries its tone');
check(tones(render(h(ProtectionTab,{...tabProps,devices:fleet.filter(item=>!['threat','hidden','off'].includes(item.id))}))),[['Scan too old','warning']],'neither detections nor off: only Scan too old');
check(tones(render(h(ProtectionTab,{...tabProps,devices:fleet.filter(item=>['passive','ok','pending'].includes(item.id))}))),[],'All, Passive and Not reported never carry a tone');
check(heads(html),['Device','Status','Active detections','Newest detection','Last scan','Signatures','Tamper protection'],'columns');
check(sortHeads(html),['Device','Status','Active detections','Last scan','Signatures'],'Device, Status, Active, Last scan and Signatures sort');
check([...html.matchAll(/<div class="sdx-table-wrap[^"]*" role="region" aria-label="([^"]+)"/g)].map(match=>match[1]),['Defender'],'one DataTable region: Defender');
ok(/<div class="sdx-toolbar"><div class="sdx-toolbar-filters"><div class="sdx-segmented sdx-segmented-sm" role="group" aria-label="Show">/.test(html),'the status Segmented sits in the kit Toolbar');
ok(/<div class="sdx-table-foot"><p>10 of 10 devices<\/p>/.test(html),'the foot of the DataTable');
ok(html.includes('aria-label="Open threat"'),'the open control names the device (fleet.openDevice)');
ok(shown.includes('Threat active')&&shown.includes('Update agent')&&shown.includes('Not installed')&&shown.includes('Passive Contoso Endpoint Security'),'status pills and the passive product');
ok(shown.includes('10 of 10 devices'),'the foot');
// Active detections: a count in the mono face, a missing count as the plain EMPTY_VALUE like the other columns.
ok(/<td><span class="mono">\d+<\/span><\/td>/.test(html)&&html.includes('<td>—</td>')&&!/<td class="mono">/.test(html),'a count is mono, a missing count is a plain dash');
ok(text(render(h(ProtectionTab,{...tabProps,devices:[]}))).includes('No devices in this view')&&render(h(ProtectionTab,{...tabProps,devices:[]})).includes('<tr class="sdx-table-empty">'),'empty scope: the DataTable empty row');
// Sort through sortTableRows: without a sort the scope order stays; Status sorts by priority, Last scan with a running scan as the newest.
{
 const {sortedProtectionRows}=await import('../../../ui/devices/protection/protection-tab.tsx');
 const rows=fleet.map(defender.protectionRow);
 check(sortedProtectionRows(rows,null,now).map(row=>row.id),fleet.map(item=>item.id),'no sort: the scope order');
 check(sortedProtectionRows(rows,{column:'status',direction:'asc'},now).map(row=>row.status),['threat','threat','off','scan-old','passive','protected','not-installed','update-agent','not-reported','not-reported'],'Status ascending: the worst first');
 const newest=sortedProtectionRows(rows,{column:'lastScan',direction:'desc'},now).map(row=>row.lastScan).filter(Boolean);
 ok(newest.length>1&&newest.every((value,index)=>!index||Date.parse(newest[index-1])>=Date.parse(value)),'Last scan descending: the newest first');
 const scans=sortedProtectionRows(rows,{column:'lastScan',direction:'asc'},now).map(row=>row.lastScan).filter(Boolean);
 ok(scans.every((value,index)=>!index||Date.parse(scans[index-1])<=Date.parse(value)),'Last scan ascending: the oldest first');
 check(sortedProtectionRows(rows,{column:'lastScan',direction:'asc'},now).slice(-3).map(row=>row.lastScan),[null,null,null],'devices without a scan stay at the end');
 const running=sortedProtectionRows([...rows,{...rows[4],id:'running',scanRunning:true,lastScan:iso(40*day)}],{column:'lastScan',direction:'desc'},now);
 check(running[0].id,'running','a running scan counts as the newest');
}
ok(text(render(h(ProtectionTab,{...tabProps,devices:fleet}),'de')).includes('Mit Funden 2'),'German filter');
const {servers}=demoData(),demoCounts=defender.protectionCounts(servers);
check([demoCounts.detections,demoCounts['scan-old'],demoCounts.passive,demoCounts['not-reported']],[1,1,1,1],'the sample devices: one each with detections, an old scan, passive and not reported');
check(servers.map(defender.protectionStatus),['threat','update-agent','scan-old','passive'],'the sample devices by status');

// ---- The Defender row of the overview card opens the Defender area ----
const summary=(device,locale='en')=>render(h(DeviceSummary,{server:device,viewer:owner,demo:true,now:Date.now(),samples:[],jobs:[],historyLoading:false,onNavigate:()=>{},onRefreshInventory:()=>{},refreshBlocked:'',onOpenEsuGroup:()=>{},onRefresh:()=>{}}),locale);
const byName=Object.fromEntries(servers.map(item=>[item.name,item]));
ok(summary(byName['SRV-FILE01']).includes('aria-label="Microsoft Defender: Passive. Open"')&&text(summary(byName['SRV-FILE01'])).includes('Contoso Endpoint Security protects this device.'),'passive sample device: a button with the product name');
ok(summary(byName['SRV-APP01']).includes('aria-label="Microsoft Defender: 2 active detections. Open"'),'detections sample device: the critical row opens the area');
ok(!summary(byName['SRV-DC01']).includes('aria-label="Microsoft Defender:'),'older agent: no link into the area');
// ==== Actions of agent 4.15.0 ====
const kinds=['defender-quick-scan','defender-full-scan','defender-update-signatures','defender-clean-detections'];
const controlled=(value=report(),extra={})=>server(value,{management:1,permissions:['view','defender.read','defender.control'],...extra,snapshot:{agentCapabilities:['defender-status',...kinds],mode:'Management',...(value===undefined?{}:{defender:value}),...(extra.snapshot??{})}});
const operator={id:'op',label:'op',permissions:[]};
const block=(device,kind='defender-quick-scan',options={},viewer=operator)=>defenderModel.defenderActionBlock(device,viewer,kind,{demo:false,saving:false,now,...options});
const dirty=report({activeCount:2,detectionCount:2});
// Each reason wins over every later one: start from a device that fails all of them and fix one at a time.
const worst={...controlled(report({mode:'not-running'}),{management:0,lastSeen:now-10*60000,permissions:['view'],snapshot:{mode:'ReadOnly',agentCapabilities:['defender-status'],defenderScan:{kind:'quick',startedAt:iso(60000)}}})};
check(block(worst,'defender-quick-scan',{demo:true,saving:true}),'demo','1. demo');
check(block(worst,'defender-quick-scan',{saving:true}),'saving','2. saving');
check(block(worst),'right','3. no defender.control');
check(block({...worst,permissions:['view','defender.control']}),'read-only','4. ReadOnly (management 0)');
check(block({...worst,permissions:['defender.control'],management:1}),'read-only','4. ReadOnly (mode not confirmed)');
const step5={...worst,permissions:['defender.control'],management:1,snapshot:{...worst.snapshot,mode:'Management'}};
check(block(step5),'offline','5. offline');
check(block({...step5,lastSeen:now-10000}),'agent','6. capability missing');
const step7={...step5,lastSeen:now-10000,snapshot:{...step5.snapshot,agentCapabilities:['defender-status',...kinds]}};
check(block(step7),'unavailable','7. Defender not running');
check(block({...step7,snapshot:{...step7.snapshot,defender:undefined}}),'unavailable','7. no Defender report');
check(block({...step7,snapshot:{...step7.snapshot,defender:{available:false,reason:'not-installed',collectedAt:iso(0)}}}),'unavailable','7. not installed');
const step8={...step7,snapshot:{...step7.snapshot,defender:report()}};
check(block(step8),'scan-running','8. a portal scan runs (quick)');
check(block(step8,'defender-full-scan'),'scan-running','8. a portal scan runs (full)');
check(block(step8,'defender-update-signatures'),null,'8. only the scan kinds');
check(block(step8,'defender-clean-detections'),'no-detections','9. clean without active detections');
check(block({...step8,snapshot:{...step8.snapshot,defender:dirty}},'defender-clean-detections'),null,'9. clean with active detections');
check(block({...step8,permissions:[]},'defender-quick-scan',{},owner),'scan-running','the Owner holds every right');
check(defender.defenderStateBlock(step8.snapshot,'defender-quick-scan'),'scan-running','the server check is steps 7–9 of the same function');
check(defenderModel.defenderBlockText('right','de'),'Dir fehlt die Berechtigung „Microsoft Defender steuern“ auf diesem Gerät.','blocked text (de)');

// ---- Buttons in the device area ----
const button=(markup,label)=>{const match=new RegExp('<button([^>]*)>(?:(?!</button>).)*?<span>'+label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'</span>(?:<span[^>]*>([^<]*)</span>)?</button>').exec(markup);return match?{attributes:match[1],blocked:match[2]??null}:null;};
html=area(controlled(dirty),operator);
for(const label of ['Run quick scan','Update signatures','Clean all active detections'])ok(button(html,label)&&!button(html,label).attributes.includes('aria-disabled'),`${label}: a ready button`);
ok(button(html,'Run quick scan').attributes.includes('sdx-btn-secondary')&&!html.includes('sdx-btn-primary'),'Run quick scan is a secondary button; the panel has no primary');
ok(button(html,'Clean all active detections').attributes.includes('sdx-btn-danger')&&button(html,'Update signatures').attributes.includes('sdx-btn-secondary'),'clean is the danger button, signatures the secondary one');
ok(html.includes('aria-label="More scan actions"'),'the menu with the full scan');
ok(html.indexOf('sdx-kpi-row')<html.indexOf('Run quick scan'),'the KPI row stays the focal point above the actions');
html=area(controlled(report(),{permissions:['view','defender.read']}),reader);
check(button(html,'Run quick scan').blocked,'You need the permission “Control Microsoft Defender” on this device.','without defender.control the action is blocked and stays visible');
check(button(area(controlled(report()),operator),'Clean all active detections').blocked,'There are no active detections to clean.','clean without active detections');
check(button(area(controlled(report()),operator,'en',{demo:true}),'Update signatures').blocked,'Not available for sample devices.','demo mode');
check(button(area(controlled(report()),operator,'en',{saving:true}),'Update signatures').blocked,'Wait until the current change is saved.','saving');
check(button(area(controlled(report(),{management:0}),operator),'Run quick scan').blocked,'The agent runs in Read-only mode. Turn on Management mode on the device first.','ReadOnly');
check(button(area(controlled(report(),{lastSeen:now-600000}),operator),'Run quick scan').blocked,'The device is offline','offline');
check(button(area(controlled(report(),{snapshot:{agentCapabilities:['defender-status']}}),operator),'Run quick scan').blocked,'Update the agent to 4.15.0 or later to control Defender.','agent 4.14.0');
check(button(area(controlled(report({mode:'not-running'})),operator),'Update signatures').blocked,'Microsoft Defender is not running on this device.','Defender not running');
check(button(area(controlled(report(),{permissions:['view']}),reader,'de'),'Schnellscan starten').blocked,'Dir fehlt die Berechtigung „Microsoft Defender steuern“ auf diesem Gerät.','blocked text (de)');
for(const [label,device] of [['older agent',server(undefined,{snapshot:{agentCapabilities:[]}})],['not reported',server(undefined)],['not installed',server({available:false,reason:'not-installed',collectedAt:iso(0)})],['error',server({available:false,reason:'error',collectedAt:iso(0)})]])
 ok(!/<button/.test(area(device)),`${label}: no action`);
// The clean button also without defender.read: the count comes from the summary.
html=area(controlled(Object.fromEntries(Object.entries(dirty).filter(([key])=>key!=='detections'&&key!=='exclusions')),{permissions:['view','defender.control']}),operator);
ok(text(html).includes('Detections are hidden')&&button(html,'Clean all active detections')&&button(html,'Clean all active detections').blocked===null,'the clean button with hidden detections');

// ---- A running portal scan ----
html=area(controlled(report(),{snapshot:{defenderScan:{kind:'quick',startedAt:'2026-11-04T11:54:00Z'}}}),operator);shown=text(html);
ok(html.includes('class="sdx-defender-running" role="status"')&&html.includes('sdx-live-dot')&&/Quick scan running since \S+/.test(shown),'the running row with the live dot');
ok(shown.includes('Last scan Yesterday Scan running'),'the KPI detail reads Scan running');
check(button(html,'Run quick scan').blocked,'A scan is already running. Wait until it ends.','the quick scan is blocked while it runs');
ok(html.includes('aria-label="More scan actions"'),'the full scan stays in its menu');
ok(/Full scan running since/.test(text(area(controlled(report(),{snapshot:{defenderScan:{kind:'full',startedAt:iso(3600000)}}}),operator)))&&/Schnellscan läuft seit/.test(text(area(controlled(report(),{snapshot:{defenderScan:{kind:'quick',startedAt:iso(60000)}}}),operator,'de'))),'full scan; German');
ok(!area(controlled(report()),operator).includes('sdx-defender-running'),'no running row without defenderScan');

// ---- Confirmations ----
let confirmation=actions.defenderConfirmation({id:'d1',name:'SRV-01',activeCount:2},'defender-quick-scan');
check([confirmation.title,confirmation.confirmLabel,confirmation.tone,confirmation.payload],['Run a quick scan?','Run quick scan','default',{action:'job',id:'d1',kind:'defender-quick-scan',params:{},confirm:true}],'quick scan');
check([confirmation.lines,confirmation.description.startsWith('Defender checks the places where malware usually hides.')],[[{label:'Device',value:'SRV-01'}],true],'the line "Device: SRV-01", then what happens');
confirmation=actions.defenderConfirmation({id:'d1',name:'SRV-01',activeCount:2},'defender-clean-detections');
check([confirmation.title,confirmation.confirmLabel,confirmation.tone],['Clean all active detections?','Clean all active detections','danger'],'clean uses the danger tone');
ok(confirmation.description.includes('Defender removes all 2 active detections or moves them to quarantine')&&confirmation.description.includes('cannot restore quarantined files'),'clean names the count and the limits');
ok(actions.defenderConfirmation({id:'d1',name:'SRV-01',activeCount:1},'defender-clean-detections').description.includes('Defender removes the active detection or moves it to quarantine'),'clean, one detection');
check([actions.defenderConfirmation({id:'d1',name:'SRV-01'},'defender-full-scan').title,actions.defenderConfirmation({id:'d1',name:'SRV-01'},'defender-update-signatures').confirmLabel],['Run a full scan?','Update signatures'],'full scan and signatures');
confirmation=actions.defenderConfirmation({id:'d1',name:'SRV-01'},'defender-update-signatures','de');
check([confirmation.title,confirmation.confirmLabel],['Defender-Signaturen aktualisieren?','Signaturen aktualisieren'],'German title and confirm label');
check(confirmation.lines,[{label:'Gerät',value:'SRV-01'}],'German device line');
let confirmed=null;
html=area(controlled(dirty),operator,'en',{onConfirm:value=>{confirmed=value;}});
ok(confirmed===null,'nothing is confirmed by rendering');

// ---- After a Defender job ends ----
const job=(state,action='defender-quick-scan',serverId='d1')=>({id:'j1',serverId,action,state});
const step=defender.defenderJobTransition(new Map(),[job('running')],'d1');
ok(!step.ended&&step.states.get('j1')==='running','a running job is no end');
check(defender.defenderJobTransition(step.states,[job('succeeded')],'d1').ended,true,'running → succeeded ends the job');
check(defender.defenderJobTransition(new Map([['j1','pending']]),[job('failed')],'d1').ended,true,'pending → failed ends the job');
check(defender.defenderJobTransition(new Map(),[job('succeeded')],'d1').ended,false,'a job that was already done does not count');
check(defender.defenderJobTransition(new Map([['j1','running']]),[job('succeeded','restart-service')],'d1').ended,false,'other kinds do not count');
check(defender.defenderJobTransition(new Map([['j1','running']]),[job('succeeded','defender-quick-scan','d2')],'d1').ended,false,'other devices do not count');
check([defender.DEFENDER_REFRESH_EVERY_MS,defender.DEFENDER_REFRESH_FOR_MS],[10000,120000],'every 10 s for 2 min');

// ---- Scope tab: selection and bulk bar ----
const pick=(id,value,extra={})=>({...controlled(value,extra),id,name:id});
const pool=[pick('a',dirty),pick('b',report()),pick('c',report(),{snapshot:{agentCapabilities:['defender-status']}}),pick('d',report(),{lastSeen:now-600000}),pick('e',report(),{snapshot:{defenderScan:{kind:'full',startedAt:iso(600000)}}})];
let plan=defenderModel.defenderBulkPlan(pool,operator,'defender-quick-scan',now);
check([plan.eligible.map(item=>item.id),plan.skipped],[['a','b'],[{reason:'offline',count:1},{reason:'agent',count:1},{reason:'scan-running',count:1}]],'eligible devices and skip counts in reason order');
check(defenderModel.defenderSkipSentences(plan),['1 device is offline and is skipped.','1 device needs agent 4.15.0 or later and is skipped.','1 device is already running a scan and is skipped.'],'one skip sentence per reason');
plan=defenderModel.defenderBulkPlan(pool,operator,'defender-clean-detections',now);
check([plan.eligible.map(item=>item.id),defenderModel.defenderSkipSentences(plan,'de')],[['a'],['1 Gerät ist offline und wird übersprungen.','1 Gerät braucht Agent 4.15.0 oder neuer und wird übersprungen.','2 Geräte haben keine aktiven Funde und werden übersprungen.']],'clean skips devices without detections (de, plural)');
check(defender.defenderDeviceNames(['a','b','c','d','e','f','g']),'a, b, c, d, e and 2 more','up to 5 names, then "and N more"');
check([defender.defenderDeviceNames(['a','b','c','d','e','f']),defender.defenderDeviceNames(['a','b','c','d','e','f','g'],'de'),defender.defenderDeviceNames(['a'],'de')],['a, b, c, d, e and 1 more','a, b, c, d, e und 2 weitere','a'],'one more; German');
confirmation=actions.defenderBulkConfirmation(defenderModel.defenderBulkPlan(pool,operator,'defender-quick-scan',now),'defender-quick-scan',2);
check([confirmation.title,confirmation.confirmLabel,confirmation.tone,confirmation.payload,confirmation.lines],['Run a quick scan on 2 devices?','Run quick scan','default',{action:'defender-jobs',kind:'defender-quick-scan',ids:['a','b'],confirm:true},[{label:'Devices',value:'a, b'}]],'bulk confirmation: count of eligible devices, their IDs only, the line "Devices"');
check(confirmation.description.split('\n\n'),['Defender checks the places where malware usually hides. This usually takes a few minutes. The Defender area shows the result when the scan ends.','1 device is offline and is skipped.\n1 device needs agent 4.15.0 or later and is skipped.\n1 device is already running a scan and is skipped.','This affects devices of 2 customers. The audit log gets one entry for each customer.'],'device line, text, skip sentences, cross-customer hint');
confirmation=actions.defenderBulkConfirmation(defenderModel.defenderBulkPlan([pool[0]],operator,'defender-clean-detections',now),'defender-clean-detections',1,'de');
check([confirmation.title,confirmation.tone,confirmation.lines,confirmation.description.split('\n\n').length],['Alle aktiven Funde auf 1 Gerät bereinigen?','danger',[{label:'Geräte',value:'a'}],1],'bulk clean: danger tone, no skips, no hint for one customer (de)');
// The bar: selection state lives in the component, so the bar is checked with a selection-seeded render.
const tab=(devices,viewer=operator,extra={})=>render(h(ProtectionTab,{...tabProps,viewer,devices,...extra}));
html=tab(pool);
ok(html.includes('aria-label="Select all visible devices"')&&html.includes('aria-label="Select SRV-01"')===false&&html.includes('aria-label="Select a"'),'header and row checkboxes in the selection column');
ok(/<label class="sdx-check-hit"><input type="checkbox" aria-label="Select a"/.test(html),'the row checkbox sits in .sdx-check-hit');
ok(!tab(pool.map(item=>({...item,permissions:['view']})),operator).includes('Select all visible devices'),'no selection column without defender.control in scope');
ok(tab(pool.map(item=>({...item,permissions:['view']})),operator,{demo:true}).includes('Select all visible devices'),'the selection column in demo mode');
ok(!html.includes('sdx-bulkbar'),'no bulk bar without a selection');
check(heads(html),['Device','Status','Active detections','Newest detection','Last scan','Signatures','Tamper protection'],'the columns stay');
ok(/<th scope="col" class="sdx-col-check"><label class="sdx-check-hit"><input type="checkbox" aria-label="Select all visible devices"/.test(html)&&(html.match(/aria-selected="false"/g)??[]).length===pool.length,'DataTable selection: the head checkbox and aria-selected on every row');
ok(/<span class="sdx-live"><span class="sdx-pill sdx-pill-accent"><i aria-hidden="true"><\/i>Running<\/span><\/span>/.test(html),'the Last scan column shows the Running pill with the live dot');
ok(text(tab(pool,operator)).split('Running').length===2,'only the device with a running scan');
ok(text(render(h(ProtectionTab,{...tabProps,devices:pool}),'de')).includes('Läuft'),'Running (de)');
// The bulk bar, rendered with a selection.
const bar=(selected,extra={})=>render(h(DefenderBulkBar,{selected,devices:pool,viewer:operator,demo:false,saving:false,now,onConfirm:()=>{},onClear:()=>{},...extra}),extra.locale??'en');
html=bar(pool);
ok(html.includes('class="sdx-bulkbar" role="region" aria-label="Selection"')&&html.includes('<strong aria-live="polite">5 selected</strong>'),'the kit bar: region, label and the live count');
ok(/<button type="button" class="sdx-icon-btn"[^>]*aria-label="Clear selection"/.test(html)||html.includes('aria-label="Clear selection"'),'the kit clear button');
check(bar([]),'','no bar without a selection');
check(['Run quick scan','Run full scan','Update signatures','Clean all active detections'].map(label=>[button(html,label)?.attributes.includes('sdx-btn-sm'),button(html,label)?.blocked]),[[true,null],[true,null],[true,null],[true,null]],'four small buttons, ready while a device is eligible');
ok(button(html,'Clean all active detections').attributes.includes('sdx-btn-danger'),'clean is the danger button');
html=bar([pool[1],pool[2]]);
check([button(html,'Clean all active detections').blocked,button(html,'Run quick scan').blocked],['None of the selected devices can run this action.',null],'none eligible for clean, one for the scan');
check(button(bar(pool,{demo:true}),'Run quick scan').blocked,'Not available for sample devices.','demo mode blocks the bar');
const many=Array.from({length:101},(_,index)=>pick('m'+index,report()));
check(button(bar(many,{devices:many}),'Update signatures').blocked,'Select at most 100 devices at a time.','more than 100 selected');
check(button(bar(pool,{locale:'de'}),'Schnellscan starten').blocked,null,'German labels');
const lock=(customers,viewer,eligible=[1])=>actions.defenderBulkLock({plan:{eligible},selected:eligible.length,customers,viewer,demo:false,saving:false});
ok(lock(2,operator)?.includes('Start actions for several customers'),'two customers without the right: the cross-customer lock');
check([lock(2,owner),lock(1,operator),lock(2,{permissions:['portal.msp.crossCustomer']})],[undefined,undefined,undefined],'the Owner, one customer, or the right: no lock');
check(lock(2,operator),'The selection contains devices of several customers. You need the permission “Start actions for several customers” for this.','the lock shows only the reason of the permission');
const customerPool=[pick('x1',report(),{customerId:'A'}),pick('x2',report(),{customerId:'B'}),pick('x3',report(),{customerId:'B',lastSeen:now-600000})];
ok(button(bar(customerPool,{devices:customerPool}),'Run quick scan').blocked?.includes('Start actions for several customers'),'the bar locks a selection of two customers');
ok(button(bar([customerPool[0],customerPool[2]],{devices:customerPool}),'Run quick scan').blocked===null,'the lock counts only the eligible devices (the offline B device is skipped)');
// The selection and the empty states through a hook harness: the tab runs as a plain function.
{
 const internals=React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,saved=internals.H,states=[];let cursor=0;
 internals.H={useState(initial){const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return [states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];},useMemo:fn=>fn(),useCallback:fn=>fn,useContext:context=>context._currentValue,useEffect(){},useLayoutEffect(){},useRef:current=>({current}),useSyncExternalStore:(_subscribe,getSnapshot)=>getSnapshot()};
 try{
  const opened=[];
  const props={...tabProps,viewer:operator,devices:pool,onOpen:id=>opened.push(id)};
  const nodes=node=>!node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];
  const all=()=>{cursor=0;return nodes(ProtectionTab(props));};
  const table=()=>all().find(node=>node.type===DataTable);
  check([table().props.label,table().props.entranceId,table().props.cards,table().props.selection.allLabel],['Defender','protection-rows',true,'Select all visible devices'],'the DataTable: label, entrance, cards and the selection');
  table().props.onOpen(table().props.rows[1]);check(opened,['b'],'a row opens the device');
  table().props.selection.onChange(['a','b','e']);
  check(all().find(node=>node.type===DefenderBulkBar).props.selected.map(item=>item.id),['a','b','e'],'the bar gets the selected devices');
  // A filter change keeps the selection; the head checkbox then adds only the shown rows.
  table().props.toolbar.props.filters.props.onChange('detections');
  check([table().props.rows.map(row=>row.id),states[1]],[['a'],['a','b','e']],'the selection survives a filter change');
  check(table().props.empty.title,'No devices match this filter','the filter has rows: no empty yet');
  table().props.toolbar.props.filters.props.onChange('passive');
  const empty=table().props.empty;
  check([table().props.rows.length,empty.title,empty.action.props.label],[0,'No devices match this filter','Show all'],'no match: the reset Show all');
  empty.action.props.onReset();
  check(table().props.rows.length,pool.length,'Show all sets the filter to All');
  table().props.onSort({column:'name',direction:'desc'});
  check(table().props.rows.map(row=>row.id),['e','d','c','b','a'],'Device descending reverses the rows');
  props.devices=pool.map(item=>({...item,permissions:['view']}));
  check(table().props.selection,undefined,'without defender.control: no selection');
 }finally{internals.H=saved;}
}
// The source: no own table, toolbar or bulk bar.
{
 const source=readFileSync(new URL('../../../ui/devices/protection/protection-tab.tsx',import.meta.url),'utf8');
 ok(!/<table\b|className="sdx-toolbar"|className="sdx-bulkbar"/.test(source),'protection-tab.tsx: no <table, own toolbar or own bulk bar');
}
console.log(`PASS defender view (${checks} checks): the area states, notices, KPI row, status and scans, the detections table with order, pills, more files and truncation, the exclusions and their empty and null states, the lock without defender.read, the scope tab and its helpers, and the Defender actions (blocked reasons, buttons, running scan, confirmations, refresh after a job, selection, bulk plan and bulk confirmation) in English and German.`);
