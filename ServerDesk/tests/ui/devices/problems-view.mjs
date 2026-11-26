// Health in the console, rendered with React SSR: the Alarms view "By device"
// (ui/devices/monitoring/problems.tsx) on All devices, a group and a customer, the level
// counts and filter, the customer column, the the sort heads, whole reasons with "Show N more", the jumps
// to the device areas (pressed on the hook-free parts), both empty states and
// the foot; the fixed Health column of the fleet table with its sort header, the
// level pill (no score, D8) and the issue counts, the same on DeviceCard; the start page group of the account
// menu and its palette actions; the help topic and the demo data. No browser,
// no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import React from 'react';
import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const problems=await import('../../../ui/devices/monitoring/problems.tsx');
const {default:FleetView,DeviceCard}=await import('../../../ui/devices/fleet/fleet.tsx');
const startPage=await import('../../../ui/shell/start-page.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {scopeDevices}=await import('../../../ui/devices/fleet/fleet-scope.ts');
const {topicFor}=await import('../../../ui/shell/help-panel.tsx');
const {availableFleetColumns}=await import('../../../ui/devices/fleet/fleet-columns.ts');
const {healthWeights,problemRows,alarmTarget}=await import('../../../ui/base/health-score.ts');
const {alarmText}=await import('../../../ui/devices/monitoring/alarms-view.ts');
const read=file=>readFileSync(file,'utf8');
const {translate}=await import('../../../lib/i18n/translate.ts');
const {demoData}=await import('../../../ui/shell/demo.ts');
const {fleetFilters,fleetFilterLabels}=await import('../../../ui/devices/fleet/fleet-filters.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const minute=60000,now=Date.UTC(2026,10,3,10,0,0);
// FleetView, its rows and DeviceCard read the console clock (ui/base/clock-store.ts); it stands at now.
(await import('../../../ui/base/clock-store.ts')).consoleClock.set(now);
const owner={id:'owner',label:'owner',permissions:['*']};
const groupParent={id:'g-parent',name:'Berlin',parentId:null,depth:0,direct:false},groupChild={id:'g-child',name:'Lab',parentId:'g-parent',depth:1,direct:true},groupOther={id:'g-other',name:'Munich',parentId:null,depth:0,direct:true};
const alert=(id,ruleId,key,level,minutesAgo,params={})=>({id,ruleId,key,level,peakLevel:level,peakValue:null,threshold:null,params,startedAt:now-minutesAgo*minute,openedAt:now-minutesAgo*minute,acknowledged:null,muted:null});
const device=(id,name,customerId,customerName,groups,alerts,changes={})=>({id,name,customerId,customerName,groupId:groups.find(group=>group.direct)?.id??null,groupName:groups.find(group=>group.direct)?.name??null,groups,alerts,permissions:['view'],lastSeen:now-10000,snapshot:null,createdAt:0,revoked:0,management:1,...changes});
const web=device('d-web','WEB-01','c-a','Contoso',[{...groupOther}],[
 alert('a-web-crit','memory','memory','critical',5,{value:96}),
 alert('a-web-cpu','cpu','cpu','warning',10,{value:91}),
 alert('a-web-info','inventory-incomplete','collection','info',30,{errors:['WMI']}),
]);
const lab=device('d-lab','LAB-01','c-b','Fabrikam',[{...groupParent},{...groupChild}],[
 alert('a-lab-disk','disk-free','disk-C:','warning',20,{name:'C:',freeGb:8,totalGb:100}),
 alert('a-lab-reboot','reboot-pending','reboot','warning',40),
 alert('a-lab-updates','updates-pending','updates','warning',60,{count:3}),
 alert('a-lab-cert','cert-expiring','cert-1','warning',80,{subject:'CN=lab',days:5}),
]);
const infoOnly=device('d-info','INFO-01','c-a','Contoso',[{...groupParent}],[alert('a-info','inventory-incomplete','collection','info',30,{errors:['WMI']})]);
const quiet=device('d-quiet','QUIET','c-a','Contoso',[{...groupParent}],[]);
const fresh=device('d-fresh','NEW-01','c-a','Contoso',[],[],{lastSeen:null});
const devices=[web,lab,infoOnly,quiet,fresh];
const noop=()=>{};
const render=(props,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},h(problems.default,{devices,now,customerColumn:true,onOpen:noop,onShowDevices:noop,...props})));
/** The body rows of the table: the device name (the open button) and the text of each cell. */
const rows=html=>{const body=html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1]??'';return [...body.matchAll(/<tr class="sdx-row-clickable[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)].map(match=>({id:match[1].match(/<button type="button" class="sdx-row-open">([^<]+)<\/button>/)?.[1],html:match[1],cells:[...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(cell=>cell[1].replace(/<[^>]+>/g,''))}));};
const heads=html=>[...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map(match=>match[1].replace(/<[^>]+>/g,''));
const sortOf=html=>Object.fromEntries([...html.matchAll(/<th scope="col"[^>]*aria-sort="(\w+)"[^>]*>(.*?)<\/th>/g)].map(match=>[match[2].replace(/<[^>]+>/g,''),match[1]]));
const decode=text=>text.replace(/&#x27;/g,"'").replace(/&quot;/g,'"').replace(/&amp;/g,'&');
const names={'d-web':'WEB-01','d-lab':'LAB-01','d-busy':'BUSY-01'};
const ids=list=>list.map(row=>Object.keys(names).find(id=>names[id]===row.id)??row.id);

// ---- The tab on All devices, a group and a customer ----
let html=render({devices:scopeDevices(devices,{type:'all'})});
check(ids(rows(html)),['d-web','d-lab'],'All devices: critical before warning; info-only, quiet and new devices are not listed');
check(heads(html),['Health','Device','Customer','Reasons','Open for'],'columns with the customer column (two customers)');
ok(/<section class="sdx-health-tab sdx-problems" aria-labelledby="([^"]+)"><header class="sdx-section-head"><div class="sdx-section-head-text"><h2 id="\1" class="sr-only">By device<\/h2><p>This list shows the devices with an open warning or critical alarm\. Devices with the most severe and oldest alarms are at the top\.<\/p>/.test(html),'one SectionHead: the sr-only h2 names the section, the meta is the visible description');
ok(!/sdx-health-head|sdx-icon-tile/.test(html),'no own head and no icon tile');
const webRow=rows(html)[0];
check(webRow.cells[0],'Critical','the health cell: the level only, the score stays on the device health line (D8)');
ok(!html.includes('/100'),'no score anywhere in the Problems tab');
check([webRow.cells[1],webRow.cells[2],webRow.cells[4]],['WEB-01','Contoso','5 min'],'device, customer and open for (since the oldest critical alarm)');
ok(/<td><span title="[^"]+">5 min<\/span><\/td>/.test(webRow.html),'open for carries the exact time as title');
html=render({devices:scopeDevices(devices,{type:'group',id:'g-parent'})});
check(ids(rows(html)),['d-lab'],'a group: only its devices, subgroups included');
html=render({devices:scopeDevices(devices,{type:'customer',id:'c-a'})});
check(ids(rows(html)),['d-web'],'a customer: only its devices');
ok(!heads(html).includes('Customer'),'one customer in the view: no customer column, even with several customers in the portal');
ok(!heads(render({devices:scopeDevices(devices,{type:'all'}),customerColumn:false})).includes('Customer'),'no customer column with one customer');
ok(!heads(render({devices:[web,{...lab,customerId:'c-a',customerName:'Contoso'}]})).includes('Customer'),'All devices with one customer: no customer column (customerColumnDistinguishes)');
ok(/<div class="sdx-table-wrap" role="region" aria-label="By device" tabindex="0"><table class="sdx-table sdx-data-table">/.test(render({})),'a DataTable: the table scrolls inside its labelled region');

// ---- Sort heads: Health (default, worst first), Device and Open for ----
html=render({devices:scopeDevices(devices,{type:'all'})});
check(sortOf(html),{Health:'descending',Device:'none','Open for':'none'},'sortable: Health (active, descending), Device and Open for; Reasons and Customer do not sort');
ok(html.includes('aria-label="Health: sort ascending"')&&html.includes('aria-label="Device: sort ascending"')&&html.includes('aria-label="Open for: sort descending"'),'each button names the next direction; Open for starts with the longest');
const busy=device('d-busy','BUSY-01','c-a','Contoso',[{...groupOther}],[
 alert('a-busy-1','cpu','cpu','warning',300,{value:95}),alert('a-busy-2','reboot-pending','reboot','warning',200),alert('a-busy-3','updates-pending','updates','warning',100,{count:2}),
 alert('a-busy-4','disk-free','disk-D:','warning',90,{name:'D:',freeGb:4,totalGb:100}),alert('a-busy-5','cert-expiring','cert-2','warning',80,{subject:'CN=busy',days:3}),
]);
const sortRows=problemRows([web,lab,busy]);
check(sortRows.map(row=>row.device.id),['d-web','d-busy','d-lab'],'problemRows: worst first, then the longest open');
check(problems.sortedProblemRows(sortRows,'all',{column:'device',direction:'asc'},now).map(row=>row.device.name),['BUSY-01','LAB-01','WEB-01'],'sort by Device ascending');
check(problems.sortedProblemRows(sortRows,'all',{column:'device',direction:'desc'},now).map(row=>row.device.name),['WEB-01','LAB-01','BUSY-01'],'sort by Device descending');
check(problems.sortedProblemRows(sortRows,'all',{column:'openFor',direction:'desc'},now).map(row=>row.device.id),['d-busy','d-lab','d-web'],'Open for descending: the longest open first');
check(problems.sortedProblemRows(sortRows,'all',{column:'health',direction:'asc'},now).map(row=>row.device.id),['d-lab','d-busy','d-web'],'Health ascending reverses the worst-first order');
check(problems.sortedProblemRows(sortRows,'warning',problems.defaultProblemSort,now).map(row=>row.device.id),['d-busy','d-lab'],'the level filter, then the sort');

// ---- Segmented counts and the level filter ----
html=render({devices:scopeDevices(devices,{type:'all'})});
ok(/<div class="sdx-toolbar"><div class="sdx-toolbar-filters"><div class="sdx-segmented sdx-segmented-sm" role="group" aria-label="Level">/.test(html),'the level control in the kit Toolbar');
for(const [label,count] of [['All',2],['Critical',1],['Warning',1]])ok(new RegExp(`<span>${label}</span><b[^>]*>${count}</b>`).test(html),`${label} ${count}`);
ok(/<span>Critical<\/span><b class="sdx-count-critical">1<\/b>/.test(html)&&/<span>Warning<\/span><b>1<\/b>/.test(html),'only the worst non-zero count carries its tone');
ok(html.includes('>2 of 2 devices with open alarms<'),'the foot');
html=render({devices:scopeDevices(devices,{type:'all'}),initialLevel:'warning'});
check(ids(rows(html)),['d-lab'],'the warning filter');
ok(html.includes('>1 of 2 devices with open alarms<'),'the foot counts the shown rows');
check(ids(rows(render({devices:scopeDevices(devices,{type:'all'}),initialLevel:'critical'}))),['d-web'],'the critical filter');
ok(render({devices:[lab]}).includes('>1 of 1 device with open alarms<'),'the foot in the singular');

// ---- Reasons: whole titles, three chips, "Show N more" expands in place ----
html=render({devices:[lab]});
const labRow=rows(html)[0];
check(problemRows([lab])[0].reasons.map(item=>item.id),['a-lab-cert','a-lab-updates','a-lab-reboot','a-lab-disk'],'reasons: the oldest first within a level');
const buttons=[...labRow.html.matchAll(/<button type="button" class="sdx-problem-reason warning" aria-label="([^"]+)">/g)].map(match=>decode(match[1]));
check(buttons.length,3,'three reason chips');
ok(buttons.every(label=>/^Open (Management|Software) on LAB-01: .+/.test(label))&&buttons.some(label=>label.startsWith('Open Software on LAB-01: ')),'the aria-label names the area (the certificate alarm opens Software), the device and the title');
ok(/<button type="button" class="sdx-problem-more" aria-expanded="false" aria-controls="sdx-problem-reasons-d-lab">Show 1 more<\/button>/.test(labRow.html),'"Show 1 more" is a button, collapsed, controlling the reasons of its row');
ok(/<span class="sdx-problem-reasons" id="sdx-problem-reasons-d-lab">/.test(labRow.html)&&!/<td title=/.test(labRow.html),'the reasons list has the id; the cell keeps no title with the joined list');
const fullTitles=problemRows([lab])[0].reasons.slice(0,3).map(item=>alarmText(item,'en',now).title);
ok(fullTitles.every(title=>labRow.html.includes(`<span>${title}</span>`)),'each chip shows its whole title');
ok(!render({devices:[web]}).includes('sdx-problem-more'),'three reasons need no "Show N more"');
ok(/<button type="button" class="sdx-problem-more" aria-expanded="false"[^>]*>2 weitere anzeigen<\/button>/.test(render({devices:[busy]},'de')),'German "2 weitere anzeigen"');
ok(render({devices:[lab]},'de').includes('>1 weiteren anzeigen<'),'German singular');
const reasonCss=read('ui/devices/monitoring/alarms.css');
ok(!/\.sdx-problem-reason[^{]*\{[^}]*(text-overflow|max-width:\s*240px)/.test(reasonCss)&&!/\.sdx-problem-reason span\s*\{[^}]*ellipsis/.test(reasonCss),'no ellipsis and no 240px cut on a chip');
ok(/td\.sdx-problem-reasons-col \{ min-width: 280px; \}/.test(reasonCss)&&/\.sdx-problem-reasons \{[^}]*flex-wrap: wrap/.test(reasonCss),'the reasons cell wraps its chips and keeps 280px');

// The view without hooks: the expand button, the jumps, the empty states.
const toggled=[],opened=[],calls=[];
const viewProps={level:'all',onLevel:level=>calls.push(['level',level]),sort:problems.defaultProblemSort,onSort:sort=>calls.push(['sort',sort]),expanded:new Set(),onToggle:id=>toggled.push(id),now,locale:'en',customer:false,onOpen:(...args)=>opened.push(args),onShowDevices:()=>calls.push(['devices'])};
const view=props=>problems.ProblemsView({...viewProps,...props});
const tree=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(tree):[node,...[node.props?.children].flat(Infinity).flatMap(tree)];
const cellOf=(table,id,rowIndex=0)=>table.props.columns.find(column=>column.id===id).cell(table.props.rows[rowIndex]);
let table=view({rows:problemRows([lab])});
let more=tree(cellOf(table,'reasons')).find(node=>node.type==='button'&&node.props.className==='sdx-problem-more');
check([more.props['aria-expanded'],more.props.children],[false,'Show 1 more'],'collapsed: "Show 1 more"');
more.props.onClick();
check([toggled,opened],[['d-lab'],[]],'pressing it toggles its row and opens nothing');
table=view({rows:problemRows([lab]),expanded:new Set(['d-lab'])});
const expandedNodes=tree(cellOf(table,'reasons'));
more=expandedNodes.find(node=>node.type==='button'&&node.props.className==='sdx-problem-more');
check([expandedNodes.filter(node=>node.type==='button'&&String(node.props.className).startsWith('sdx-problem-reason ')).length,more.props['aria-expanded'],more.props.children],[4,true,'Show fewer'],'expanded: all four reasons in place and "Show fewer"');
check(more.key,'more','the button keeps its key, so the focus stays on it while the chips change');
check(tree(cellOf(view({rows:problemRows([lab,web]),expanded:new Set(['d-web'])}),'reasons',1)).filter(node=>node.type==='button'&&String(node.props.className).startsWith('sdx-problem-reason ')).length,3,'the state is per row: another row stays collapsed');

// ---- The jumps: reason chips, the row open (device button and row click) ----
table=view({rows:problemRows([web,lab])});
for(const index of [0,1])for(const button of tree(cellOf(table,'reasons',index)).filter(node=>node.type==='button'&&String(node.props.className).startsWith('sdx-problem-reason ')))button.props.onClick();
check(opened,[['d-web','diagnostics','processes'],['d-web','diagnostics','processes'],['d-web','overview',undefined],['d-lab','software','certificates'],['d-lab','management','updates'],['d-lab','management','updates']],'each reason opens the area of its alarm');
opened.length=0;
for(const row of table.props.rows)table.props.onOpen(row);
check(opened,[['d-web','diagnostics','processes'],['d-lab','software','certificates']],'the row open (device button and row click) opens the area of the first reason');
check([table.props.columns.find(column=>column.primary).id,table.props.cards,table.props.entranceId,table.props.label],['device',true,'problem-rows','By device'],'primary Device column, cards, entrance and the label');
check(alarmTarget('disk-free'),{section:'management',detail:'storage'},'a disk alarm opens Management, Storage');

// ---- Empty states and their actions ----
html=render({devices:[infoOnly,quiet,fresh]});
ok(html.includes('No device has a warning or critical alarm')&&html.includes('A device appears here when it has an open warning or critical alarm.')&&html.includes('>Show devices<')&&!html.includes('sdx-table-foot'),'no problem in the scope: "Show devices", no foot');
ok(/<tr class="sdx-table-empty"><td colSpan="4"><div class="sdx-empty">/.test(html)&&heads(html).length===4,'the table keeps its head and shows the Empty as its one row');
ok(/lucide-heart-pulse/.test(html),'the empty state has the HeartPulse icon');
html=render({devices:[lab],initialLevel:'critical'});
ok(html.includes('No devices match the filter')&&html.includes('Choose another level or show all.')&&html.includes('>Show all<')&&rows(html).length===0,'the level hides every row');
ok(render({devices:[]},'de').includes('Kein Gerät hat einen kritischen Alarm oder eine Warnung')&&render({devices:[]},'de').includes('>Geräte anzeigen<'),'German empty state with "Geräte anzeigen"');
calls.length=0;
view({rows:[]}).props.empty.action.props.onShowDevices();
view({rows:problemRows([lab]),level:'critical'}).props.empty.action.props.onReset();
view({rows:problemRows([lab])}).props.toolbar.props.filters.props.onChange('warning');
view({rows:problemRows([lab])}).props.onSort({column:'device',direction:'asc'});
check(calls,[['devices'],['level','all'],['level','warning'],['sort',{column:'device',direction:'asc'}]],'"Show devices" switches to the devices tab, "Show all" resets the level, the Segmented sets it, a head sets the sort');

// ---- Fleet table: the fixed Health column with the level pill and the issue counts ----
// WEB-01 has an inventory with issues; the other fixtures have none (no snapshot).
const {servers:samples}=demoData();
const inventory=samples.find(item=>item.snapshot)?.snapshot;
const issue=(key,ruleId,level,params={})=>({key,ruleId,level,live:false,params});
const webInventory={...web,snapshot:inventory,issues:[issue('memory','memory','critical',{value:96}),issue('cpu','cpu','warning',{value:91}),issue('collection','inventory-incomplete','info',{errors:['WMI']})]};
const quietInventory={...quiet,snapshot:inventory,issues:[]};
const fleetDevices=[webInventory,lab,infoOnly,quietInventory,fresh];
const fleetHtml=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(FleetView,{header:null,servers:fleetDevices,scoped:fleetDevices,groupEmpty:false,viewer:owner,demo:false,saving:false,now,jobs:[],audit:[],tab:'devices',onTab:noop,canOffboard:false,onOpen:noop,onConfirm:noop,onSelectJob:noop,onCancelJob:noop,onUpdated:noop,onDemo:noop,canMove:false,onMove:noop,customerColumn:false})));
const fleetHeads=[...fleetHtml.match(/<thead>.*?<\/thead>/s)[0].matchAll(/<th scope="col"[^>]*><button[^>]*>([^<]+)</g)].map(match=>match[1]);
check(fleetHeads.slice(0,4),['Device','Status','Health','Group'],'Health sits after Status and before Group');
ok(!fleetHeads.includes('Issues'),'no separate Issues column');
ok(/aria-sort="none"><button type="button" class="sdx-sort" aria-label="Health: sort ascending">/.test(fleetHtml),'a SortHead whose first press sorts ascending');
check(availableFleetColumns(false,true).includes('health'),false,'Health is fixed: not in the column menu');
const fleetRow=id=>[...fleetHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(match=>match[1]).find(part=>part.includes(`<strong>${id}</strong>`));
const healthCell=id=>fleetRow(id).match(/<td><span class="sdx-health-cell">([\s\S]*?)<\/span><\/td>/)?.[1]??'';
ok(healthCell('WEB-01').startsWith('<span class="sdx-pill sdx-pill-critical"><i aria-hidden="true"></i>Critical</span><span class="sdx-issue-counts">'),'the level pill without title, then the issue counts in one cell');
check([...healthCell('WEB-01').matchAll(/<span class="sdx-issue-count (\w+)" role="img" aria-label="([^:"]+):/g)].map(match=>[match[1],match[2]]),[['critical','1 critical issue'],['warning','1 warning'],['info','1 info']],'one count per level with its aria-label and title (the IssueSummary of before)');
ok(/<span class="sdx-pill sdx-pill-warning"><i aria-hidden="true"><\/i>Warning<\/span>$/.test(healthCell('LAB-01')),'warning pill; no inventory, no counts');
check(healthCell('QUIET'),'<span class="sdx-pill sdx-pill-success"><i aria-hidden="true"></i>Good</span>','an inventory without issues: the level pill only, no "None" text');
ok(/<span class="sdx-pill sdx-pill-success"><i aria-hidden="true"><\/i>Good<\/span>/.test(healthCell('INFO-01')),'info alarms keep the state good');
check(healthCell('NEW-01'),'<span class="sdx-pill sdx-pill-neutral" title="No data yet. The health score appears after the first Heartbeat."><i aria-hidden="true"></i>No data</span>','no data: the neutral pill keeps its title');
ok(!/\/100|Health \d+ of 100/.test(fleetHtml),'no score and no score tooltip in the fleet table');
{const noInventory=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(problems.HealthPill,{server:{lastSeen:now,alerts:[],snapshot:null}})));
 ok(noInventory.endsWith('No data</span>'),'a device without an inventory and without alarms has no data yet');}
{const unknown=renderToStaticMarkup(h(LocaleProvider,{locale:'de'},h(problems.HealthPill,{server:{lastSeen:null,alerts:[]}})));
 ok(/>Keine Daten<\/span>$/.test(unknown)&&!/\d/.test(unknown.replace(/title="[^"]*"/,'')),'German unknown: "Keine Daten" with no number');
 const critical=renderToStaticMarkup(h(LocaleProvider,{locale:'de'},h(problems.HealthPill,{server:web})));
 check(critical,'<span class="sdx-pill sdx-pill-critical"><i aria-hidden="true"></i>Kritisch</span>','German: "Kritisch", no score, no title');}
// The state filter now sits in the Filters popover (tests/ui/devices/fleet-toolbar.mjs renders it); its options keep their order.
check(fleetFilters.slice(0,4).map(value=>translate('en',fleetFilterLabels[value])),['All devices','Health: critical','Health: warning','Health: good'],'the state filter lists the health filters after All devices');
const card=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(DeviceCard,{server:webInventory,now,customer:false,selectable:false,selected:false,draggable:false,onDragStart:noop,onSelect:noop,onOpen:noop,menu:null})));
ok(/<div class="sdx-device-card-status"><span class="sdx-pill sdx-pill-online">.*?<\/span><span class="sdx-health-cell"><span class="sdx-pill sdx-pill-critical"><i aria-hidden="true"><\/i>Critical<\/span><span class="sdx-issue-counts">/.test(card),'the card: connection pill, level pill and issue counts');
ok(!card.includes('/100'),'the card shows no score');
ok(/<div role="tablist"[^>]*>.*?<span>Devices<\/span><b>5<\/b><\/a><a[^>]*><span>Monitoring<\/span>/s.test(fleetHtml)&&!/<span>Problems<\/span>/.test(fleetHtml),'the Monitoring tab follows Devices, without an icon; there is no Problems tab');

// ---- Start page: the Preferences card of My account (tests/ui/account/account-preferences.mjs renders it), palette, storage ----
check(startPage.startPageOptions.map(option=>[option.page,translate('en',option.label),translate('de',option.label)]),[['dashboard','Dashboard','Dashboard'],['devices','All devices','Alle Geräte'],['alarms','Alarms','Alarme']],'the start page options in both languages');
ok(!('StartPageMenuGroup' in startPage)&&!/StartPage/.test(readFileSync('ui/shell/shell.tsx','utf8')),'the account menu has no start page group');
const store=new Map(),storage=()=>({getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value)});
check(startPage.readStartPage(storage),'dashboard','nothing stored: the Dashboard');
startPage.saveStartPage('devices',storage);check(startPage.readStartPage(storage),'devices','a stored devices stays');
startPage.saveStartPage('alarms',storage);
check([store.get('serverdesk.redesign.startPage'),startPage.readStartPage(storage)],['"alarms"','alarms'],'saved as JSON and read back');
store.set('serverdesk.redesign.startPage','"problems"');check(startPage.readStartPage(storage),'alarms','an older stored "problems" reads as alarms');
store.set('serverdesk.redesign.startPage','"elsewhere"');check(startPage.readStartPage(storage),'dashboard','an invalid value acts as the default');
store.set('serverdesk.redesign.startPage','{broken');check(startPage.readStartPage(storage),'dashboard','unreadable JSON acts as the default');
check(startPage.readStartPage(()=>{throw new Error('blocked');}),'dashboard','a blocked storage acts as the default');
const saved=[],toasts=[];
const items=startPage.startPagePaletteItems('en',()=>toasts.push(translate('en','startPage.saved')),page=>saved.push(page));
check(items.map(item=>item.label),['Start page: Dashboard','Start page: All devices','Start page: Alarms'],'three palette actions');
items[2].run();items[1].run();items[0].run();
check([saved,toasts],[['alarms','devices','dashboard'],['Start page saved.','Start page saved.','Start page saved.']],'each action saves the value and shows the toast');
check(startPage.startPagePaletteItems('de').map(item=>item.label),['Startseite: Dashboard','Startseite: Alle Geräte','Startseite: Alarme'],'German palette actions');

// ---- The start page in the console: applied in place on the first read, a link always wins ----
const {consoleHarness}=await import('../../support/console-harness.mjs');
const consoleBase={servers:devices,jobs:[],deviceGroups:[],permissionDevices:[],customers:[],audit:[],deviceAudit:[],maintenance:null};
const start=async(hash,stored)=>{const ui=consoleHarness({viewer:owner,hash,startPage:stored,base:consoleBase});await ui.settle();return ui;};
let ui=await start('','alarms');
check([ui.history,ui.location.hash,ui.fleet().props.tab],[[['replace','#devices/monitoring']],'#devices/monitoring','problems'],'no hash and the start page alarms: Monitoring › By device, replaced in place without a history entry');
ui=await start('','problems');
check([ui.history,ui.location.hash,ui.fleet().props.tab],[[['replace','#devices/monitoring']],'#devices/monitoring','problems'],'an older stored problems opens the same view');
ui=await start('#devices/monitoring/list','problems');
check([ui.history,ui.fleet().props.tab],[[],'alarms'],'a link with a hash wins');
ui=await start('','devices');
check([ui.history.filter(([type])=>type==='push'),ui.fleet().props.tab],[[],'devices'],'the start page devices opens All devices');
await ui.navigateTo('#devices/problems');
check(ui.fleet().props.tab,'problems','Back and Forward to Monitoring › By device');
ui=await start('#devices/monitoring','problems');await ui.navigateTo('');
check(ui.fleet().props.tab,'devices','only the first read applies the start page; a later empty hash opens All devices');

// ---- Help topic ----
const topic=topicFor({view:'devices',tab:'problems'},'en');
check(topic.title,'Alarms by device','the problems topic ("Alarms by device") wins over alarms and notifications');
check(topic.tips.length,3,'three tips');
ok(topic.tips[1].includes(`critical ${healthWeights.critical}, warning ${healthWeights.warning}, info ${healthWeights.info}`),'the tip takes the weights from healthWeights');
check(topic.docs,[{label:'Alert rules',file:'docs/alert-rules.md'}],'the docs link');
check(topicFor({view:'devices',tab:'problems'},'de').docs[0].label,'Alarmregeln','German doc label');

// ---- Demo data ----
const demo=demoData().servers,demoNow=Date.now();
const expected=demo.filter(server=>server.alerts?.some(item=>item.level!=='info')).map(server=>server.id);
ok(expected.length>0,'some sample devices have warning or critical alarms');
const demoHtml=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(problems.default,{devices:demo,now:demoNow,customerColumn:false,onOpen:noop,onShowDevices:noop})));
check(rows(demoHtml).map(row=>demo.find(server=>server.name===row.id)?.id).sort(),[...expected].sort(),'the tab lists the sample devices with warning or critical alarms');

console.log(`PASS problems view (${checks} checks): Alarms › By device on All devices, a group and a customer, counts and level filter, the customer column, the sort heads, whole reasons with "Show N more", the jumps to the device areas, both empty states and the foot, the Health column with sort, menu and pill, the card pill, the start page menu, palette and storage, the help topic and the demo data.`);
