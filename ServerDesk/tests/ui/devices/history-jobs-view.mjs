// History › Jobs on the kit (ui/devices/history/job-table.tsx in ui/devices/history/history.tsx), run on hook cells: the JobTable
// columns with the state first and the job's object as the second line, one row Menu (Show details, Cancel job with
// its blocked reason), the <time> with the exact time, the search over object and device, both empty states with the
// reset, the foot and 25 rows per page, the analysis frame of a scope versus the device block, and the view Segmented
// inside the toolbar.
import assert from 'node:assert/strict';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const harness=panelHarness({hooked:['ui/devices/history/history.tsx','ui/devices/history/job-table.tsx','ui/devices/history/activity-table.tsx']});
const History=harness.load('ui/devices/history/history.tsx').default;
const JobTable=harness.load('ui/devices/history/job-table.tsx').default;
const now=1800000000000,owner={id:'owner',label:'Owner',permissions:['*']},reader={id:'reader',label:'Reader',permissions:[]};
const devices=[{id:'a',name:'CT-WEB01',revoked:0,permissions:['view','manage']},{id:'b',name:'CT-DHCP01',revoked:0,permissions:['view']}];
const job=(id,extra)=>({id,serverId:'a',action:'stop-service',target:'Spooler',state:'succeeded',createdAt:now-60000,claimedAt:now-59000,result:null,actor:'anna@example.test',...extra});
const jobs=[job('j1',{object:'Spooler'}),job('j2',{serverId:'b',action:'plugin-job',target:'dhcp-scope-create',state:'failed',object:'10.0.0.0'}),job('j3',{state:'pending',action:'restart-service',target:'W32Time',object:'W32Time',claimedAt:null})];
const selected=[],cancelled=[];
const base={jobs,servers:devices,viewer:owner,demo:false,saving:false,now,onSelect:job=>selected.push(job.id),onCancel:job=>cancelled.push(job.id),showDevice:true};
const heads=markup=>[...markup.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map(match=>text(match[1]));

// ---- the columns, the object line and the row Menu ----
harness.reset();let markup=harness.html(JobTable,base);
check(heads(markup),['Status','Auftrag','Gerät','Konto','Zeit','Aktionen'],'State, Job, Device, Account, Time and the actions column');
ok(/<th scope="col" class="sdx-col-actions"><span class="sr-only">Aktionen<\/span><\/th>/.test(markup),'the actions column has a hidden label');
ok(markup.includes('<strong>DHCP-Bereich erstellen</strong><small>10.0.0.0</small>')||/<strong>[^<]*DHCP[^<]*<\/strong><small>10\.0\.0\.0<\/small>/.test(markup),'the job label with its object as the second line');
ok(!markup.includes('dhcp-scope-create'),'the raw operation id never shows');
ok(/<time dateTime="[^"]+" title="[^"]+">/.test(markup),'the time with the exact time as title');
ok(text(markup).includes('3 von 3 Aufträgen'),'the foot');
let tree=harness.tree(JobTable,base);
ok(!harness.walk(tree).some(node=>node.type?.displayName==='IconBtn'||node.props?.icon&&node.props?.label==='Auftrag abbrechen'),'no IconBtn in a row');
check(harness.menu(tree,'Aktionen für Dienst stoppen').map(entry=>entry.label??(entry.separator?'—':'')),['Details anzeigen'],'a finished job: Show details only');
harness.menu(tree,'Aktionen für Dienst stoppen')[0].onSelect();check(selected,['j1'],'Show details opens the job');
const pendingMenu=harness.menu(tree,'Aktionen für Dienst neu starten');
check(pendingMenu.map(entry=>entry.label??'—'),['Details anzeigen','—','Auftrag abbrechen'],'a pending job: Show details, then Cancel job after a separator');
pendingMenu[2].onSelect();check(cancelled,['j3'],'Cancel job cancels');
harness.reset();tree=harness.tree(JobTable,{...base,viewer:reader,servers:[{...devices[0],permissions:['view']},devices[1]]});
check(harness.menu(tree,'Aktionen für Dienst neu starten')[2].blocked,de('jobs.cancel.blockedPermission'),'without the right: blocked with its reason');
// Demo and saving: blocked with the reason (cancelJobBlocked), never a silent entry; selecting it calls nothing.
for(const [extra,reason,label] of [[{demo:true},'kit.unavailable.demo','demo'],[{saving:true},'kit.busy','while saving'],[{demo:true,viewer:reader},'kit.unavailable.demo','demo without the right']]){
 harness.reset();tree=harness.tree(JobTable,{...base,...extra});
 const entry=harness.menu(tree,'Aktionen für Dienst neu starten')[2];
 check([entry.label,entry.blocked,entry.danger],['Auftrag abbrechen',de(reason),true],`${label}: the entry stays, blocked with its reason`);
 entry.onSelect?.();check(cancelled,['j3'],`${label}: selecting it calls nothing`);
}
// The open control and the row open the job.
harness.reset();tree=harness.tree(JobTable,base);
const table=harness.table(tree,'Aufträge');
check([table.props.entranceId,table.props.cards,table.props.openLabel(jobs[0])],['history-jobs',true,'Details zu Dienst stoppen anzeigen'],'entrance, cards and the open label');

// ---- Search over object and device, empty states ----
const search=()=>harness.find(tree,node=>node.props?.search).props.search;
check(search().placeholder,de('history.search.fleetJobs'),'scope placeholder');
search().onChange('10.0.0');tree=harness.tree(JobTable,base);
check(harness.table(tree,'Aufträge').props.rows.map(row=>row.id),['j2'],'the search matches the object');
search().onChange('ct-web');tree=harness.tree(JobTable,base);
check(harness.table(tree,'Aufträge').props.rows.map(row=>row.id),['j1','j3'],'the search matches the device');
search().onChange('zzz');tree=harness.tree(JobTable,base);markup=harness.html(JobTable,base);
ok(text(markup).includes(de('history.jobs.noMatch'))&&text(markup).includes('Suche löschen'),'no match: the reset');
harness.find(tree,node=>node.props?.label==='Suche löschen').props.onReset();tree=harness.tree(JobTable,base);
check(harness.table(tree,'Aufträge').props.rows.length,3,'the reset clears the search');
harness.reset();markup=harness.html(JobTable,{...base,jobs:[],showDevice:false});
ok(text(markup).includes(de('history.jobs.noneDevice'))&&text(markup).includes(de('jobs.emptyHint')),'a device without jobs');
harness.reset();markup=harness.html(JobTable,{...base,jobs:[]});
ok(text(markup).includes(de('history.jobs.noneScope')),'a scope without jobs');
// 26 jobs: 25 per page.
const many=Array.from({length:26},(_,index)=>job('m'+index,{object:'S'+index}));
harness.reset();tree=harness.tree(JobTable,{...base,jobs:many});
check([harness.table(tree,'Aufträge').props.rows.length,harness.table(tree,'Aufträge').props.pagination.total],[25,26],'pagination at 26 rows');

// ---- the frames and the view switch ----
const historyBase={servers:devices,viewer:owner,demo:false,saving:false,now,jobs,audit:[],onSelectJob:()=>{},onCancelJob:()=>{}};
harness.reset();markup=harness.html(History,{...historyBase,scoped:devices,tab:'jobs'});
ok(/^<section class="sdx-health-tab sdx-history"/.test(markup)&&!/class="sdx-card/.test(markup),'scope: the analysis frame, no Card');
harness.reset();markup=harness.html(History,{...historyBase,scoped:[devices[0]],single:true,tab:'jobs',viewSwitch:false});
ok(/^<div class="sdx-history"><div class="sdx-toolbar">/.test(markup)&&!/aria-pressed/.test(markup),'device: its block, no view switch');
check(heads(markup),['Status','Auftrag','Konto','Zeit','Aktionen'],'device: no Device column');
harness.reset();markup=harness.html(History,{...historyBase,scoped:[devices[0]],single:true,tab:'jobs'});
ok(/<div class="sdx-toolbar"><label class="sdx-searchfield sdx-toolbar-search">.*?<div class="sdx-toolbar-filters"><div class="sdx-segmented/.test(markup),'with viewSwitch: the Segmented sits in the toolbar filters');
ok((markup.match(/class="sdx-toolbar"/g)??[]).length===1,'one toolbar row');

console.log(`PASS history jobs view (${checks} checks): the JobTable columns and object line, the row Menu with its blocked cancel, the time title, search, empty states, foot and paging, the frames and the Segmented in the toolbar.`);
