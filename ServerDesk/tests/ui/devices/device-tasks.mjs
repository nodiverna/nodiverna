// Management → Scheduled tasks (ui/devices/management/device-tasks.tsx), a device subarea of its own since slice 6: the hidden title,
// the System panel notice, the task list with search, paging and its foot, Enable and Disable with the classic
// confirmation texts and payloads, the blocked reasons, and "Open scheduling" on the Nodiverna power task.
// The panel runs on hook cells (tests/support/panel-harness.mjs): cell 0 the search and page; ref 0 the live props.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';
const harness=panelHarness({hooked:['ui/devices/management/device-tasks.tsx']});
const {load,find}=harness;
const {default:DeviceTasks,ownedTask,matchingTasks}=load('ui/devices/management/device-tasks.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};

const now=Date.UTC(2026,9,10,0,45),viewer={id:'owner',label:'Owner',permissions:['*']};
const capabilities=['set-task','refresh'];
const tasks=[{name:'Scheduled Power',path:'\\ServerDesk\\',state:'Ready',lastRun:'',nextRun:'',lastResult:0},{name:'Backup',path:'\\Ops\\',state:'Disabled',lastRun:'2026-10-09 22:00',nextRun:'',lastResult:267011},{name:'Cleanup',path:'\\Ops\\',state:'Running',lastRun:'2026-10-09 23:00',nextRun:'2026-10-10 23:00',lastResult:0}];
const server={id:'device',name:'WINDOWS-SRV',lastSeen:now-1000,management:1,revoked:0,snapshot:{mode:'Management',agentCapabilities:capabilities,tasks}};
let confirmations=[],scheduling=0;
const props={server,viewer,demo:false,saving:false,now,onConfirm:value=>confirmations.push(value),onOpenScheduling:()=>scheduling++};
const reset=()=>{harness.reset();confirmations=[];scheduling=0;};
const tree=(overrides={})=>harness.tree(DeviceTasks,{...props,...overrides}),html=(overrides={})=>harness.html(DeviceTasks,{...props,...overrides});
/** The one entry of a task's row Menu ("Actions for {name}"). */
const entryOf=(element,name)=>harness.menu(element,de('tree.actionsForName',{name}))?.[0];
const reasonOf=(_,label)=>{const element=tree(currentOverrides);const entry=['Backup','Cleanup'].map(name=>entryOf(element,name)).find(item=>item?.label===label);return {description:entry?.blocked,blocked:!!entry?.blocked,disabled:false};};
let currentOverrides={};

// ---- The panel head and the list ----
reset();let markup=html();
ok(/<h2 class="sr-only">Geplante Aufgaben<\/h2>/.test(markup),'SectionHead hideTitle: the subtab names the panel, the h2 stays for the outline');
ok(/role="region" aria-label="Geplante Aufgaben"/.test(markup),'the task table is a labelled region');
ok(markup.includes('3 von 3 Aufgaben'),'the foot counts the tasks');
ok(markup.includes('Backup')&&markup.includes('Cleanup')&&markup.includes('Scheduled Power'),'every task is listed');
check([ownedTask(tasks[0]),ownedTask(tasks[1]),ownedTask({name:'scheduled power',path:'\\Other\\'})],[true,false,false],'the Nodiverna power task by name and path');
check(matchingTasks(tasks,' ops ').map(task=>task.name),['Backup','Cleanup'],'the search matches name and path');

// ---- Search and paging ----
let element=tree();find(element,item=>item.props.search?.label===de('system.tasks.search')).props.search.onChange('backup');markup=html();
ok(markup.includes('1 von 3 Aufgaben')&&!markup.includes('Cleanup'),'the search filters the list');
reset();find(tree(),item=>item.props.search).props.search.onChange('nichts');markup=html();
ok(markup.includes(de('system.tasks.noMatch')),'no match: the cause-specific empty state');
reset();const many=Array.from({length:30},(_,index)=>({name:`Task ${String(index+1).padStart(2,'0')}`,path:'\\Ops\\',state:'Ready',lastRun:'',nextRun:'',lastResult:0}));
const manyServer={...server,snapshot:{...server.snapshot,tasks:many}};
markup=html({server:manyServer});ok(markup.includes('Task 25')&&!markup.includes('Task 26'),'25 tasks per page');
const table=harness.table(tree({server:manyServer}),'Geplante Aufgaben');table.props.pagination.onPage(2);markup=html({server:manyServer});
ok(markup.includes('Task 26')&&markup.includes('Task 30')&&!markup.includes('Task 01<'),'page 2 shows the rest');
find(tree({server:manyServer}),item=>item.props.search).props.search.onChange('Task');check(harness.table(tree({server:manyServer}),'Geplante Aufgaben').props.pagination.page,1,'a new search goes back to page 1');
reset();markup=html({server:{...server,snapshot:{...server.snapshot,tasks:undefined}}});ok(markup.includes(de('management.tasks.noInventory')),'not collected: the empty state');

// ---- Enable and Disable keep the classic confirmation ----
reset();element=tree();
entryOf(element,'Backup').onSelect();
check(confirmations[0].payload,{action:'job',id:'device',kind:'set-task',params:{name:'Backup',path:'\\Ops\\',enabled:true},confirm:true},'Enable: the classic payload');
check([confirmations[0].confirmLabel,confirmations[0].lines],['Einschalten',[{label:'Gerät',value:'WINDOWS-SRV'}]],'the verb and the device line');
ok(/\?$/.test(confirmations[0].title)&&confirmations[0].description.includes('Backup'),'the title is a question, the description names the task');
entryOf(element,'Cleanup').onSelect();
check([confirmations[1].payload.params,confirmations[1].confirmLabel],[{name:'Cleanup',path:'\\Ops\\',enabled:false},'Ausschalten'],'Disable: the classic payload and verb');
// A retained toggle checks the live device again.
reset();const retained=entryOf(tree(),'Backup');tree({server:{...server,lastSeen:now-180000}});retained.onSelect();check(confirmations.length,0,'offline now: nothing to confirm');
reset();const retainedOther=entryOf(tree(),'Backup');tree({server:{...server,id:'other'}});retainedOther.onSelect();check(confirmations.length,0,'another device now: nothing to confirm');

// ---- Blocked reasons and the panel notice ----
reset();currentOverrides={server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}}};markup=html(currentOverrides);
check(reasonOf(markup,'Einschalten').description,de('management.blocked.readOnly'),'Read-only mode blocks the toggle with the reason');
currentOverrides={demo:true};markup=html(currentOverrides);
check(reasonOf(markup,'Ausschalten').description,de('kit.unavailable.demo'),'demo: blocked with the demo reason');
ok(reasonOf(markup,'Ausschalten').blocked&&!reasonOf(markup,'Ausschalten').disabled,'a blocked toggle stays focusable');
ok(markup.includes(`<div>${de('kit.unavailable.demo')} ${de('system.readOnly')}</div>`),'the System panel notice');
currentOverrides={viewer:{...viewer,permissions:[]},server:{...server,permissions:['view']}};markup=html(currentOverrides);
check(reasonOf(markup,'Einschalten').description,de('management.blocked.manage'),'without manage: blocked with the right');
currentOverrides={saving:true};markup=html(currentOverrides);check(reasonOf(markup,'Einschalten').description,de('services.blocked.saving'),'a running save blocks');

// ---- "Open scheduling" on the power task ----
reset();currentOverrides={};
check(harness.menu(tree(),de('tree.actionsForName',{name:'Scheduled Power'})).map(entry=>entry.label),['Terminplanung öffnen'],'the power task offers Open scheduling, no generic toggle');
entryOf(tree(),'Scheduled Power').onSelect();check(scheduling,1,'Open scheduling asks for Management → System with the schedule focus');
// the actions are one row Menu in a hideLabel sdx-col-actions column, also in card mode (no card:false), no Btn per row.
const actionsColumn=harness.table(tree(),'Geplante Aufgaben').props.columns.find(column=>column.id==='actions');
check([actionsColumn.hideLabel,actionsColumn.className,actionsColumn.card],[true,'sdx-col-actions',undefined],'the row Menu column keeps its place in the cards');
ok(!/<Btn\b/.test(fs.readFileSync('ui/devices/management/device-tasks.tsx','utf8')),'no Btn per row');

console.log(`PASS device tasks (${checks} checks): Management → Scheduled tasks with the hidden title, the System notice, search, paging and foot, the classic Enable and Disable confirmations with live checks, the blocked reasons and Open scheduling on the power task.`);
