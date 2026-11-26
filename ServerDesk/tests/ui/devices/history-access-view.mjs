// History › Device access and the shared ActivityTable (ui/devices/history/activity-table.tsx, ui/devices/history/history.tsx),
// run on hook cells (tests/support/panel-harness.mjs): the labelled kit DataTable with the kit Toolbar, the columns
// with the action label and its mono code, one-line meta columns, the "Action type" filter with only the present
// categories and their counts, search and page reset, the CSV of the filtered rows, the cause-specific Empty states,
// the foot with and without a limit, the detail drawer, and the scope frame with the partial note and the notice.
import assert from 'node:assert/strict';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
const downloads=[];
const harness=panelHarness({hooked:['ui/devices/history/history.tsx','ui/devices/history/activity-table.tsx','ui/devices/history/job-table.tsx']});
const History=harness.load('ui/devices/history/history.tsx').default;
const ActivityTable=harness.load('ui/devices/history/activity-table.tsx').default;
const viewer={id:'owner',label:'Owner',permissions:['*']},now=1800000000000;
const deviceA='5f3e1a2b-1111-4222-8333-444455556666',deviceB='6a7b8c9d-1111-4222-8333-444455556666';
const devices=[{id:deviceA,name:'CT-WEB01',revoked:0,permissions:[]},{id:deviceB,name:'CT-SQL01',revoked:0,permissions:[]}];
const entry=(id,serverId,action,target)=>({id,at:now-id*60000,actor:'owner@example.test',action,target,scope:'device',serverId});
const audit=[entry(1,deviceA,'Terminal geschlossen','CT-WEB01'),entry(2,deviceB,'SYSTEM-Terminal geöffnet',''),entry(3,deviceA,'Dienst neu starten','CT-WEB01 / W32Time'),entry(4,deviceA,'tag.set','{"tag":"Rolle","value":"=SUM(1)"}')];
const base={servers:devices,viewer,demo:false,saving:false,now,jobs:[],audit:[],onSelectJob:()=>{},onCancelJob:()=>{},tab:'access',onTab:()=>{}};
const html=props=>{harness.reset();return harness.html(History,{...base,...props});};
const heads=markup=>[...markup.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map(match=>text(match[1]));

// ---- one labelled kit table with the kit Toolbar ----
let markup=html({scoped:devices,audit});
ok(/role="region" aria-label="Gerätezugriffe"/.test(markup),'the labelled table region');
ok(markup.includes(`<p>${de('history.access.description')}</p>`)&&!markup.includes('sdx-section-head-meta'),'scope: the head description; no freshness without updatedAt');
ok(html({scoped:devices,audit,updatedAt:now}).includes('<p class="sdx-section-head-meta">Aktualisiert '),'scope: the freshness meta with updatedAt');
ok(html({scoped:devices,audit,updatedAt:now,demo:true}).includes(`<p>${de('history.access.description')}</p>`)&&!html({scoped:devices,audit,updatedAt:now,demo:true}).includes('sdx-section-head-meta'),'demo: the description without the freshness');
check(heads(markup),['Zeit','Konto','Gerät','Aktion','Ziel'],'scope: Time, Account, Device, Action, Target');
ok(!/class="sdx-card/.test(markup),'no Card around the table');
ok(/<div class="sdx-toolbar"><label class="sdx-searchfield sdx-toolbar-search">/.test(markup)&&!/<label class="sdx-searchfield">/.test(markup),'the kit Toolbar search, no bare search field');
ok(markup.includes('<strong>Terminal geschlossen</strong><small class="mono">terminal.close</small>'),'the action label with its mono code below');
ok(markup.includes('<strong>Dienst neu starten</strong><small class="mono">job.restart-service</small>'),'an operation job action: its job label and job.<kind>');
ok(/<td class="sdx-cell-nowrap"><time dateTime="[^"]+">/.test(markup)&&/<td class="sdx-cell-nowrap">CT-SQL01<\/td>/.test(markup),'time and device stay on one line');
ok(markup.includes('<span class="sdx-cell-clamp" title="Rolle">Rolle</span>'),'the readable target of a JSON target');
ok(text(markup).includes('4 von 4 Einträgen'),'the foot without a limit');
markup=html({scoped:[devices[0]],audit,single:true});
check(heads(markup),['Zeit','Konto','Aktion','Ziel'],'device: no Device column');
ok(/placeholder="Aktion, Ziel oder Konto"/.test(markup),'device: the placeholder without the device');

// ---- category filter, search, page reset, CSV ----
const props={entries:audit,servers:devices,label:'Gerätezugriffe',entranceId:'history-access',exportName:'device-access',showDevice:true,empty:{title:'leer'},now,download:(name,body)=>downloads.push({name,body})};
harness.reset();let tree=harness.tree(ActivityTable,props);
const toolbar=()=>harness.find(tree,node=>node.props?.search&&node.props.actions!==undefined);
const select=()=>harness.find(tree,node=>node.props?.['aria-label']==='Art der Aktion');
check(harness.walk(select()).filter(node=>node.type==='option').map(node=>harness.text(node)),['Alle Aktionen','Geräte (1)','Aufträge und Fernzugriff (3)'],'only the present categories, with counts');
select().props.onChange({target:{value:'devices'}});tree=harness.tree(ActivityTable,props);
check(harness.table(tree,'Gerätezugriffe').props.rows.map(row=>row.entry.id),[4],'the category filters the rows');
toolbar().props.search.onChange('w32time');tree=harness.tree(ActivityTable,props);
check(harness.table(tree,'Gerätezugriffe').props.rows.length,0,'search and category together');
markup=renderTable();
ok(text(markup).includes(de('activity.noMatch'))&&text(markup).includes('Filter zurücksetzen'),'no match: the reset of both');
const reset=harness.find(tree,node=>node.props?.label==='Filter zurücksetzen');
reset.props.onReset();tree=harness.tree(ActivityTable,props);
check(harness.table(tree,'Gerätezugriffe').props.rows.length,4,'the reset clears search and category');
// 26 rows page by 25, and a search goes back to page 1.
const many=Array.from({length:26},(_,index)=>entry(index+1,deviceA,'tag.set',`T${index}`));
const pageProps={...props,entries:many};
harness.reset();tree=harness.tree(ActivityTable,pageProps);
check([harness.table(tree,'Gerätezugriffe').props.rows.length,harness.table(tree,'Gerätezugriffe').props.pagination.total],[25,26],'25 rows per page');
harness.table(tree,'Gerätezugriffe').props.pagination.onPage(2);tree=harness.tree(ActivityTable,pageProps);
check(harness.table(tree,'Gerätezugriffe').props.pagination.page,2,'page 2');
toolbar().props.search.onChange('t1');tree=harness.tree(ActivityTable,pageProps);
check(harness.table(tree,'Gerätezugriffe').props.pagination.page,1,'a search goes back to page 1');
// CSV: exactly the shown filtered rows across pages, every cell guarded.
harness.reset();tree=harness.tree(ActivityTable,props);
select().props.onChange({target:{value:'devices'}});tree=harness.tree(ActivityTable,props);
harness.find(tree,node=>node.props?.label==='Als CSV exportieren').props.onClick();
check(downloads.length,1,'one download');
const day=new Date(now),pad=value=>String(value).padStart(2,'0');
check(downloads[0].name,`device-access-${day.getFullYear()}-${pad(day.getMonth()+1)}-${pad(day.getDate())}.csv`,'the file name with the local date');
check(downloads[0].body.split('\r\n'),['﻿"Zeit";"Konto";"Gerät";"Aktion";"Aktionscode";"Ziel"',`"${new Date(now-4*60000).toISOString()}";"owner@example.test";"CT-WEB01";"Tag gesetzt";"tag.set";"Rolle"`],'the CSV of the filtered rows: ISO time, code column, readable target');
ok(harness.toasts.includes('1 Eintrag exportiert.'),'the export toast');
harness.reset();tree=harness.tree(ActivityTable,{...props,entries:[]});
check(harness.find(tree,node=>node.props?.label==='Als CSV exportieren').props.blocked,de('activity.export.none'),'CSV is blocked without rows');
harness.reset();tree=harness.tree(ActivityTable,{...props,entries:[entry(9,deviceA,'Terminal geschlossen','=HYPERLINK("x")')]});
harness.find(tree,node=>node.props?.label==='Als CSV exportieren').props.onClick();
ok(downloads.at(-1).body.includes('"\'=HYPERLINK(""x"")"'),'a formula target is neutralized and quoted');

// ---- the foot with a limit ----
harness.reset();markup=harness.html(ActivityTable,{...props,limit:4});
ok(text(markup).includes('4 der neuesten 4 Einträge'),'at the limit: of the newest entries');
harness.reset();markup=harness.html(ActivityTable,{...props,limit:200});
ok(text(markup).includes('4 von 4 Einträgen'),'below the limit: the plain foot');

// ---- the detail drawer ----
const opened=[];
const drawerProps={...props,entries:[{...entry(5,deviceA,'auth.entra.login.refused','reason=not-in-group user=anna@contoso.com')},entry(6,deviceA,'Irgendein Text','x')],onOpenDevice:id=>opened.push(id)};
harness.reset();tree=harness.tree(ActivityTable,drawerProps);
harness.table(tree,'Gerätezugriffe').props.onOpen(harness.table(tree,'Gerätezugriffe').props.rows[0]);
markup=renderTable(drawerProps);
ok(/role="dialog"/.test(markup)&&text(markup).includes('Entra-Anmeldung abgelehnt'),'the drawer opens with the action label as title');
for(const fact of ['Zeit','Konto','Gerät','Aktion','Aktionscode','Ziel','Details','Gespeichertes Ziel'])ok(text(markup).includes(fact),`the drawer shows ${fact}`);
ok(markup.includes('auth.entra.login.refused')&&text(markup).includes('anna@contoso.com')&&text(markup).includes('not-in-group'),'the code, the readable target and the pair details');
ok(text(markup).includes('CT-WEB01 öffnen'),'"Open {device}" with onOpenDevice');
tree=harness.tree(ActivityTable,drawerProps);
harness.find(tree,node=>Array.isArray(node.props?.items)&&node.props.items.some(item=>item.id==='device')).props.items.find(item=>item.id==='device').value.props.onClick();
check(opened,[deviceA],'it opens the device');
harness.reset();tree=harness.tree(ActivityTable,{...drawerProps,onOpenDevice:undefined});
harness.table(tree,'Gerätezugriffe').props.onOpen(harness.table(tree,'Gerätezugriffe').props.rows[1]);
markup=renderTable({...drawerProps,onOpenDevice:undefined});
ok(text(markup).includes('Nicht zugeordnete Aktion')&&text(markup).includes('Gespeicherte Aktion')&&text(markup).includes('Irgendein Text'),'an unlisted action shows its stored text only in the drawer');
ok(!text(markup).includes('CT-WEB01 öffnen'),'no "Open {device}" without onOpenDevice');

// ---- the frame, the notes and the empty texts ----
markup=html({scoped:[devices[0]],single:true});
ok(text(markup).includes(de('history.access.noneDevice'))&&text(markup).includes(de('history.access.noneDeviceHint')),'device without entries: its sentence and hint, no action');
markup=html({scoped:devices,audit:[]});
ok(text(markup).includes(de('history.access.none'))&&text(markup).includes(de('history.access.noneHint')),'scope without entries: its sentence and hint');
const partial=[{...devices[0],permissions:['security.events']},devices[1]];
markup=html({scoped:partial,audit,viewer:{id:'reader',label:'Reader',permissions:[]}});
ok(text(markup).includes(de('history.access.partial',{missing:1,count:2})),'the partial note');
markup=html({scoped:devices,viewer:{id:'reader',label:'Reader',permissions:[]}});
ok(text(markup).includes(de('history.access.needRight'))&&!markup.includes('role="region"'),'without the right: the notice, no table');
for(const tab of ['jobs','access']){
 markup=html({scoped:devices,audit,tab});
 ok(new RegExp(`^<section class="sdx-health-tab sdx-history" aria-labelledby="([^"]+)"><header class="sdx-section-head"><div class="sdx-section-head-text"><h2 id="\\1" class="sr-only">${de('history.tab.'+tab)}</h2>`).test(markup),`scope ${tab}: the AnalysisTab named by its subtab`);
 ok(!/aria-pressed/.test(markup),`scope ${tab}: no Segmented`);
}
harness.reset();tree=harness.tree(History,{...base,scoped:devices,audit,onOpenDevice:()=>{}});
const table=harness.find(tree,node=>node.props?.exportName==='device-access');
check([table.props.showDevice,table.props.limit,table.props.entranceId,typeof table.props.onOpenDevice],[true,200,'history-access','function'],'scope: Device column, the 200 limit, the entrance and onOpenDevice');
harness.reset();tree=harness.tree(History,{...base,scoped:[devices[0]],single:true,audit,onOpenDevice:()=>{}});
check([harness.find(tree,node=>node.props?.exportName==='device-access').props.showDevice,harness.find(tree,node=>node.props?.exportName==='device-access').props.onOpenDevice],[false,undefined],'device: no Device column, no onOpenDevice');
const {scopeHistoryCounts}=harness.load('ui/devices/history/history.tsx');
const withRight=devices.map(device=>({...device,permissions:['security.events']}));
check(scopeHistoryCounts({scoped:withRight,viewer:{id:'reader',permissions:[]},jobs:[{id:'j',serverId:deviceA},{id:'k',serverId:'x'}],audit,demo:false}),{jobs:1,access:4},'the pill counts');
check(scopeHistoryCounts({scoped:devices,viewer:{id:'reader',permissions:[]},jobs:[],audit,demo:false}),{jobs:0},'without the right: no access count');
// Demo shows the empty state.
markup=html({scoped:devices,audit,demo:true});
ok(text(markup).includes(de('history.access.none')),'demo: the empty state');

function renderTable(extra=props){return harness.html(ActivityTable,extra);}
console.log(`PASS history access view (${checks} checks): the shared ActivityTable with label and code, one-line meta columns, the category filter, search, paging, CSV, the Empty states, the foot, the drawer, and the scope frame.`);
