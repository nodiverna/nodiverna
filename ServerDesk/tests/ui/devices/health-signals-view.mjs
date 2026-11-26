// The health signal views rendered with React SSR and the sample devices: the
// crash list in Events, the OS support fact with its ESU origin, the BitLocker
// row and column, the three scope tabs on All devices, a group and a customer,
// the device area Software and the blocked ESU actions in demo mode. No
// browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {blockedReasons,buttons} from '../../support/blocked-buttons.mjs';
import {panelHarness} from '../../support/panel-harness.mjs';
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {demoData}=await import('../../../ui/shell/demo.ts');
const {default:CrashList}=await import('../../../ui/devices/diagnostics/crash-list.tsx');
const {default:DeviceSummary}=await import('../../../ui/devices/device/device-summary.tsx');
const {default:StoragePanel}=await import('../../../ui/devices/management/storage-panel.tsx');
const {default:SoftwareTab}=await import('../../../ui/devices/inventory/software-tab.tsx');
const {default:OsSupportTab}=await import('../../../ui/devices/inventory/os-support.tsx');
const {default:EncryptionTab}=await import('../../../ui/devices/inventory/encryption-tab.tsx');
const {default:DeviceSoftware}=await import('../../../ui/devices/inventory/device-software.tsx');
const {default:DeviceCertificates,certificateHeadTone,certificateCounts}=await import('../../../ui/devices/inventory/device-certificates.tsx');
const {scopeDevices}=await import('../../../ui/devices/fleet/fleet-scope.ts');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
const noop=()=>{};
const {servers}=demoData(),now=Date.now();
const byId=Object.fromEntries(servers.map(server=>[server.id,server]));
const owner={id:'owner',label:'owner',permissions:['*']};

// ---- Crash list in Events ----
let html=render(h(CrashList,{server:byId['demo-app']}));
ok(text(html).includes('Crashes')&&text(html).includes('Blue screens, unexpected shutdowns and hardware errors of the last 30 days.'),'title and meta');
check([...html.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(match=>match[1]),['Time','Type','Stop code','Driver','Source'],'columns');
ok(html.includes('href="https://learn.microsoft.com/windows-hardware/drivers/debugger/bug-check-0x3b--system-service-exception" target="_blank" rel="noopener noreferrer"'),'the documentation link opens in a new tab without referrer');
ok(text(html).includes('0x3B SYSTEM_SERVICE_EXCEPTION')&&text(html).includes('vjoy.sys')&&text(html).includes('2.1.9.1 · Shaul Eizikovich')&&text(html).includes('Event log and minidump'),'stop code, driver with version and manufacturer, source');
html=render(h(CrashList,{server:byId['demo-db']}));
ok(text(html).includes('Unexpected shutdown')&&!html.includes('learn.microsoft.com'),'no documentation link without a bugcheck');
ok(text(render(h(CrashList,{server:byId['demo-file']}))).includes('No crashes in the last 30 days'),'empty');
ok(text(render(h(CrashList,{server:{snapshot:{...byId['demo-file'].snapshot,crashInventory:undefined,crashes:undefined}}}))).includes('This device does not report crashes yet. Update the agent to 4.10.0 or later.'),'older agent');
ok(text(render(h(CrashList,{server:{snapshot:{...byId['demo-app'].snapshot,crashInventory:{...byId['demo-app'].snapshot.crashInventory,truncated:true}}}}))).includes('Only the newest 50 crashes are shown.'),'truncated note');
ok(text(render(h(CrashList,{server:byId['demo-app']}),'de')).includes('Abstürze')&&text(render(h(CrashList,{server:byId['demo-app']}),'de')).includes('Microsoft-Dokumentation'),'German texts');

// ---- Device overview: OS support fact and BitLocker row ----
const summary=(server,locale='en')=>render(h(DeviceSummary,{server,viewer:owner,demo:true,now,samples:[],jobs:[],historyLoading:false,onNavigate:noop,onRefreshInventory:noop,refreshBlocked:'',onOpenEsuGroup:noop,onRefresh:noop}),locale);
html=summary(byId['demo-app']);
ok(text(html).includes('OS support')&&/Supported until \d/.test(text(html))&&html.includes('href="https://learn.microsoft.com/lifecycle/products/windows-server-2025"'),'supported with the Microsoft source page');
ok(text(html).includes('System drive encrypted'),'BitLocker row: encrypted');
html=summary(byId['demo-db']);
ok(/Support ends in \d+ days/.test(text(html))&&/ESU until \d/.test(text(html)),'ending with the ESU line');
ok(/Protection suspended for 2 days/.test(text(html)),'BitLocker row: suspended with its duration');
html=summary(byId['demo-file']);
ok(/No support since \d/.test(text(html))&&text(html).includes('System drive not encrypted'),'ended with ESU, system drive not encrypted');
html=summary(byId['demo-dc']);
ok(text(html).includes('Unknown')&&text(html).includes('Nodiverna has no support dates for this version.')&&text(html).includes('BitLocker is not available on this edition.'),'unknown with its hint; BitLocker not available');
const inherited={...byId['demo-file'],osSupport:{...byId['demo-file'].osSupport,esu:{until:'2026-10-13',origin:{type:'group',id:'g1',name:'Berlin'}}}};
html=summary(inherited);
ok(html.includes('sdx-inherited-origin')&&text(html).includes('Device group: Berlin'),'an ESU date from a group shows its origin link');
// The ESU date is a direct icon button next to the status pill, no menu.
const esuButton=markup=>buttons(markup).find(button=>button.label==='Set ESU date');
ok(esuButton(html)&&esuButton(html).inner.includes('lucide-calendar-clock')&&!/aria-haspopup="menu"[^>]*aria-label="Set ESU date"|aria-label="Set ESU date"[^>]*aria-haspopup="menu"/.test(html),'the OS support fact has the icon button "Set ESU date" and no menu trigger');
ok(/<span class="sdx-fact-line"><span class="sdx-pill [^"]*"[^>]*>[\s\S]*?<\/span><button[^>]*aria-label="Set ESU date"/.test(html),'the button follows the status pill on the same line');
ok(esuButton(html).blocked&&esuButton(html).description==='Not available for sample devices.'&&blockedReasons(html).includes('Not available for sample devices.'),'demo mode: blocked and focusable with the demo reason');
ok(text(html).includes('Device group: Berlin')&&/ESU until \d/.test(text(html))&&html.includes('href="https://learn.microsoft.com/'),'the ESU line, its origin and the Microsoft source still render');
const viewerSummary=(server,viewer)=>render(h(DeviceSummary,{server,viewer,demo:false,now,samples:[],jobs:[],historyLoading:false,onNavigate:noop,onRefreshInventory:noop,refreshBlocked:'',onOpenEsuGroup:noop,onRefresh:noop}));
const reader={id:'reader',label:'reader',permissions:[]};
html=viewerSummary({...inherited,permissions:['view']},reader);
ok(esuButton(html).blocked&&esuButton(html).description==='You need permission to manage alert rules here.','without alerts.manage: blocked with the right reason');
html=viewerSummary({...inherited,permissions:['view','alerts.manage']},reader);
ok(esuButton(html)&&!esuButton(html).blocked,'with alerts.manage outside demo mode: available');
ok(text(summary(byId['demo-db'],'de')).includes('Supportstatus')&&/Support endet in \d+ Tagen/.test(text(summary(byId['demo-db'],'de'))),'German fact');

// ---- Storage area: BitLocker column ----
html=render(h(StoragePanel,{server:byId['demo-file'],viewer:owner,demo:true,saving:false,onConfirm:noop}));
ok(text(html).includes('BitLocker')&&text(html).includes('Not encrypted')&&text(html).includes('Encrypting 42%'),'reported drives with the BitLocker column');
ok(text(render(h(StoragePanel,{server:byId['demo-dc'],viewer:owner,demo:true,saving:false,onConfirm:noop}))).includes('Not available'),'not available');
ok(text(render(h(StoragePanel,{server:byId['demo-db'],viewer:owner,demo:true,saving:false,onConfirm:noop}))).includes('Protection suspended'),'suspended');

// ---- The three scope tabs on all, a group and a customer ----
const scoped={all:servers,group:scopeDevices(servers,{type:'group',id:'none'}),customer:servers.slice(0,2)};
for(const [type,devices] of Object.entries(scoped)){
 const scope=type==='all'?{type:'all'}:type==='group'?{type:'group',id:'none'}:{type:'customer',id:'c1'};
 html=render(h(SoftwareTab,{scope,devices,demo:true,now,onOpen:noop}));
 ok(html.includes('sdx-toolbar')&&html.includes('type="search"'),`${type}: software tab with search`);
 html=render(h(OsSupportTab,{devices,demo:true,onOpen:noop,onRefresh:noop}));
 ok(/Catalog as of \d/.test(text(html)),`${type}: OS support tab with the catalog date`);
 html=render(h(EncryptionTab,{devices,onOpen:noop}));
 ok(text(html).includes('Encryption'),`${type}: encryption tab`);
}
html=render(h(SoftwareTab,{scope:{type:'all'},devices:servers,demo:true,now,onOpen:noop}));
const softwareRows=[...html.matchAll(/<tr[^>]*><td><button[^>]*>([^<]+)<\/button><\/td><td class="mono">([^<]+)<\/td><td>.*?<\/td><td><span class="sdx-muted-cell">[^<]*<\/span><\/td><td class="sdx-cell-end mono">(\d+)<\/td><\/tr>/g)].map(match=>[match[1],match[2],Number(match[3])]);
ok(softwareRows.length>5&&softwareRows[0][2]>=softwareRows.at(-1)[2],'software rows sorted by device count');
ok(softwareRows.some(([name,version,count])=>name==='Google Chrome'&&version==='120.0.6099.130'&&count===3)&&softwareRows.some(([name,version,count])=>name==='Google Chrome'&&version==='109.0.5414.120'&&count===1),'Chrome grouped by version');
ok(/\d+ of \d+ products/.test(text(html)),'software foot');
ok(text(render(h(SoftwareTab,{scope:{type:'group',id:'none'},devices:[],demo:true,now,onOpen:noop}))).includes('No software reported for these devices yet'),'empty software tab');
html=render(h(OsSupportTab,{devices:servers,demo:true,onOpen:noop,onRefresh:noop}));
check(["Supported","Ending","Ended","Unknown"].map(label=>new RegExp(`<span>${label}</span><b[^>]*>1</b>`).test(html)),[true,true,true,true],'one sample device per support status');
ok(text(html).includes('Windows Server 2025')&&text(html).includes('Unknown version'),'rows per catalog entry and the unknown row');
html=render(h(OsSupportTab,{devices:servers,esuScope:{type:'group',id:'g1'},demo:true,onOpen:noop,onRefresh:noop}));
ok(blockedReasons(html).includes('Not available for sample devices.')&&text(html).includes('Set ESU date'),'the group ESU action is blocked in demo mode with its reason');
ok(/<header class="sdx-section-head"><div class="sdx-section-head-text"><h2 id="[^"]+" class="sr-only">OS support<\/h2><p>[^<]+<\/p><p class="sdx-section-head-meta">Catalog as of [^<]+<\/p><\/div><div class="sdx-section-head-actions"><div class="sdx-esu-group">/.test(html),'OS support head: the catalog date in meta, the group ESU in the head actions');
// The customer view: the same scope ESU control with the customer label.
html=render(h(OsSupportTab,{devices:servers,esuScope:{type:'customer',id:'c1'},demo:true,onOpen:noop,onRefresh:noop}));
ok(text(html).includes('ESU date of this customer')&&blockedReasons(html).includes('Not available for sample devices.')&&html.includes('class="sdx-esu-group"'),'a customer: the ESU value of this customer with "Set ESU date", blocked in demo');
ok(!/sdx-table-foot"><p>Catalog/.test(html)&&/\d+ of \d+ versions/.test(text(html)),'the catalog date left the table foot; the foot counts the versions');
html=render(h(EncryptionTab,{devices:servers,onOpen:noop}));
check([...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map(match=>match[1].replace(/<[^>]+>/g,'')),['Device','System drive','Protection','Method','Protectors','Recovery password','Volumes'],'encryption columns');
check([...html.matchAll(/<th scope="col" aria-sort="(\w+)"><button[^>]*>([^<]+)</g)].map(match=>[match[2],match[1]]),[['Device','none'],['System drive','none']],'Device and System drive sort; no sort is active, so the rows keep the device order');
ok(text(html).includes('2 of 2 volumes encrypted')&&text(html).includes('TPM, Recovery password'),'volumes and protectors');

// ---- Device area Software ----
html=render(h(DeviceSoftware,{server:byId['demo-app'],demo:true,now}));
ok(text(html).includes('Installed')&&text(html).includes('Change history')&&text(html).includes('Google Chrome'),'installed view with the programs');
ok(/\d+ of \d+ programs/.test(text(html)),'foot "X of Y programs"');
check([...html.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(match=>match[1]),['Name','Version','Vulnerabilities','Publisher','Installed on','Architecture','Scope'],'software columns with the vulnerability column of the sample check');
ok(text(render(h(DeviceSoftware,{server:byId['demo-app'],demo:true,now}),'de')).includes('Änderungsverlauf'),'German view switch');
// The kit head: the sr-only subarea name, the description and the report time; no visible duplicate title.
ok(/<h2 class="sr-only">Software<\/h2>/.test(html)&&text(html).includes('Programs installed on the devices, as Windows lists them under Installed apps.')&&/Last report /.test(text(html)),'SectionHead hideTitle with description and meta');
check((html.match(/>Software</g)||[]).length,1,'"Software" only as the accessible heading');
// The views switch with a small Segmented with counts in the list's Toolbar (UI-Rework 13b); each view is a flush DataTable in one Card.
check([...html.matchAll(/<button type="button" aria-pressed="(?:true|false)"[^>]*><span>([^<]+)<\/span><b[^>]*>(\d+)<\/b>/g)].map(match=>match[1]).slice(0,3),['Installed','Change history','Vulnerabilities'],'three view items with counts');
ok(!/role="tablist"|role="tabpanel"/.test(html)&&/role="region" aria-label="Installed" tabindex="0"/.test(html),'no Tabs; a focusable table region');
ok(!html.includes('sdx-loading')&&!/<table class="sdx-table">/.test(html),'no old loader, no raw table');
html=render(h(DeviceSoftware,{server:byId['demo-app'],demo:true,now,initialView:'history'}));
ok(/role="region" aria-label="Change history" tabindex="0"/.test(html)&&text(html).includes('Microsoft Edge'),'the change history view');
// Offline: no own notice (the shared DeviceStateNotice covers it).
html=render(h(DeviceSoftware,{server:{...byId['demo-app'],lastSeen:now-86400000},demo:true,now}));
ok(!text(html).includes('The device is offline')&&!html.includes('sdx-notice-warning'),'offline: no own offline notice');
{
 // Outside demo mode, run on hook cells: the Skeleton while loading, pagination at more than 50 programs, and a failed GET with "Try again".
 const requests=[];let fail=false;
 const sample=(await import('../../../ui/shell/demo.ts')).demoSoftwareView('demo-app',now);
 const many={...sample,items:Array.from({length:120},(_,index)=>({...sample.items[index%sample.items.length],key:'k'+index,name:'Program '+String(index).padStart(3,'0')}))};
 const harness=panelHarness({hooked:['ui/devices/inventory/device-software.tsx'],locale:'en',stubs:{'@/ui/base/api':{api:url=>{requests.push(url);return fail?Promise.reject(new Error('down')):Promise.resolve(many);},message:()=>'The request failed.'}}});
 const Panel=harness.load('ui/devices/inventory/device-software.tsx').default,props={server:byId['demo-app'],demo:false,now};
 harness.reset();let markup=harness.html(Panel,props);
 ok(/role="status" aria-label="Loading the installed programs"/.test(markup)&&!markup.includes('sdx-loading'),'first load: the kit Skeleton');
 await harness.flush();markup=harness.html(Panel,props);
 check(requests.length,1,'one GET');
 check((markup.match(/<tr[^>]*><td class="sdx-cell-wrap">Program /g)||[]).length,50,'50 rows on the first page');
 ok(markup.includes('class="sdx-pagination"')&&text(markup).includes('120 of 120 programs'),'pagination at more than 50 rows, with the foot');
 fail=true;harness.reset();harness.tree(Panel,props);await harness.flush();
 const tree=harness.tree(Panel,props);markup=harness.html(Panel,props);
 ok(markup.includes('sdx-notice-danger')&&text(markup).includes('The software inventory could not be loaded. Try again.'),'a failed GET: the danger notice');
 const retry=harness.button(tree,'Try again');
 ok(!!retry,'with "Try again"');
 retry.props.onClick();harness.tree(Panel,props);await harness.flush();
 check(requests.length,3,'"Try again" repeats the request');
 check(requests[2],requests[1],'the same GET');
}

// ---- Device area Certificates: the kit DataTable in a flush card ----
{
 const app=byId['demo-app'],inventory=app.snapshot.certificates;
 const withItems=items=>({snapshot:{...app.snapshot,certificates:{...inventory,items}}});
 html=render(h(DeviceCertificates,{server:app,now}),'de');
 ok(/<div class="sdx-table-wrap sdx-table-wrap-flush sdx-certificate-table" role="region" aria-label="Zertifikate" tabindex="0">/.test(html),'a labelled region, focusable before the first measurement');
 html=render(h(DeviceCertificates,{server:app,now}));
 check([...html.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map(match=>match[1]),['Subject','Issuer','Store','Valid from','Expires','Private key','Bound to','Thumbprint'],'the 8 heads in order');
 ok(html.includes('<th scope="col" class="sdx-hide-below-1280">Valid from</th>'),'Valid from may hide below 1280px');
 const firstRow=html.match(/<tbody>.*?<\/tr>/s)?.[0]??'';
 ok(firstRow.startsWith('<tbody><tr class="sdx-enter"')||firstRow.startsWith('<tbody><tr>'),'static rows: no clickable class');
 const firstCells=[...html.matchAll(/<tr[^>]*><td class="sdx-cell-wrap">([^<]+)(<small class="sdx-cell-note">[^<]+<\/small>)?<\/td>/g)];
 check(firstCells.length,inventory.items.length,'the subject is the first (primary) cell of every row');
 ok(firstCells.some(match=>match[2]),'the SANs are a note below the subject');
 ok(/<td class="mono sdx-cell-wrap"><span class="sdx-thumbprint">[0-9A-F]+<\/span><\/td>/i.test(html),'the thumbprint is mono and wraps');
 ok(!html.includes('sdx-row-open')&&!html.includes('sdx-row-clickable'),'no open buttons and no clickable rows');
 ok(html.includes('sdx-icon-tile-danger')&&html.includes('Certificates of this computer for websites, services and Remote Desktop, sorted by expiry date.')&&text(html).includes('Last report '),'an expired certificate: the danger tile, the description and the reported time');
 const expiring=inventory.items.filter(cert=>{const days=(Date.parse(cert.notAfter)-now)/86400000;return days>0&&days<=30;});
 const valid=inventory.items.filter(cert=>(Date.parse(cert.notAfter)-now)/86400000>30);
 ok(expiring.length>0&&valid.length>0,'the sample device has expiring and valid certificates');
 check([certificateHeadTone(inventory.items,now),certificateHeadTone(expiring,now),certificateHeadTone(valid,now),certificateHeadTone([],now)],['danger','warning','accent','accent'],'the head tone per worst status');
 ok(render(h(DeviceCertificates,{server:withItems(expiring),now})).includes('sdx-icon-tile-warning')&&render(h(DeviceCertificates,{server:withItems(valid),now})).includes('sdx-icon-tile-accent'),'expiring: warning tile, otherwise accent');
 // The kit head and the KPI row: counted with certificateStatus.
 const expired=inventory.items.filter(cert=>Date.parse(cert.notAfter)<=now);
 const one=[expired[0],expiring[0],valid[0]];
 check(certificateCounts(one,now),{expired:1,expiring:1,valid:1},'one expired, one expiring, one valid');
 html=render(h(DeviceCertificates,{server:{id:'demo-app',...withItems(one)},now}));
 const kpis=[...html.matchAll(/<article[^>]*aria-label="([^"]+)"/g)].map(match=>match[1]);
 ok(kpis.length===3,'three KPI tiles: '+kpis.join(' | '));
 ok(/<h2 class="sr-only">Certificates<\/h2>/.test(html)&&text(html).includes('Machine certificates')&&(html.match(/>Certificates</g)||[]).length===1,'SectionHead hideTitle; the card is "Machine certificates"');
 ok(['Expired','Expires within 30 days','Valid'].every(label=>kpis.some(value=>value.startsWith(label))),'the tiles Expired, Expires within 30 days and Valid');
 html=render(h(DeviceCertificates,{server:{snapshot:{...app.snapshot,certificates:undefined}},now}));
 ok(!html.includes('sdx-kpi'),'no inventory: tiles without a value are left out, and with them the row');
 html=render(h(DeviceCertificates,{server:{snapshot:{...app.snapshot,certificates:{...inventory,truncated:true}}},now}));
 ok(/<div class="sdx-table-foot"><p>[^<]+<\/p><\/div><\/div>/.test(html),'the truncated note is the foot inside the wrap');
 html=render(h(DeviceCertificates,{server:withItems([]),now}));
 ok(/<tbody><tr class="sdx-table-empty"><td colSpan="8"><div class="sdx-empty">/i.test(html)&&text(html).includes('This computer has no certificates for websites, services or Remote Desktop'),'no certificates: the Empty row under the kept head');
 html=render(h(DeviceCertificates,{server:{snapshot:{...app.snapshot,certificates:undefined}},now}));
 ok(!html.includes('<table')&&html.includes('sdx-empty')&&!html.includes('Last report'),'not reported: Empty without a table');
}

console.log(`PASS health signals view (${checks} checks): crash list, OS support fact and ESU origin, BitLocker row and column, the scope tabs with sample devices, the Software area, blocked ESU actions in demo mode and the device Certificates DataTable with its head tone, foot and empty states.`);
