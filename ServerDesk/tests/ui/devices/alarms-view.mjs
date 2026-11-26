// The alarms in the console rendered with React SSR (ui/devices/monitoring/alarms.tsx)
// and the pure helpers of ui/devices/monitoring/alarms-view.ts: the Alarms view "By alarm" on All
// devices, a group and a customer, level counts and filters (subgroups
// included), the customer column only with several customers, the sort order, the status
// texts, blocked menu entries without the right and in demo mode, both empty
// states, the device History segment "Alarms" with open rows first and the close
// reasons, its AnalysisTab head (sr-only title, description, summary after the head, no pointer rows), the error texts by code, the CSV export and the demo alarms; the
// one SectionHead without a KPI row, the sort heads, the overdue
// peak, the empty-state actions and the row entrance. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const tab=await import('../../../ui/devices/monitoring/alarms.tsx');
const view=await import('../../../ui/devices/monitoring/alarms-view.ts');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {scopeDevices}=await import('../../../ui/devices/fleet/fleet-scope.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
const {ApiError}=await import('../../../ui/base/http.ts');
const {demoData}=await import('../../../ui/shell/demo.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const minute=60000,now=Date.UTC(2026,9,27,10,0,0);
const owner={id:'owner',label:'owner',permissions:['*']},technician={id:'tech',label:'tech',permissions:['view']};
const groupParent={id:'g-parent',name:'Berlin',parentId:null,depth:0,direct:false},groupChild={id:'g-child',name:'Lab',parentId:'g-parent',depth:1,direct:true},groupOther={id:'g-other',name:'Munich',parentId:null,depth:0,direct:true};
const alert=(id,ruleId,key,level,minutesAgo,extra={})=>({id,ruleId,key,level,peakLevel:level,peakValue:null,threshold:null,params:{},startedAt:now-minutesAgo*minute,openedAt:now-minutesAgo*minute,acknowledged:null,muted:null,...extra});
const device=(id,name,customerId,customerName,groups,alerts,permissions=['view','alerts.manage'])=>({id,name,customerId,customerName,groupId:groups.find(group=>group.direct)?.id??null,groupName:groups.find(group=>group.direct)?.name??null,groups,alerts,permissions,lastSeen:now-10000,snapshot:null,createdAt:0,revoked:0,management:1});
const web=device('d-web','WEB-01','c-a','Contoso',[{...groupOther}],[
 alert('a-web-cpu','cpu','cpu','warning',10,{peakValue:91.26,threshold:80,params:{value:91}}),
 alert('a-web-crit','memory','memory','critical',5,{peakValue:96,threshold:90,params:{value:96}}),
 alert('a-web-info','inventory-incomplete','collection','info',30,{params:{errors:['WMI']}}),
]);
const lab=device('d-lab','LAB-01','c-b','Fabrikam',[{...groupParent},{...groupChild}],[
 alert('a-lab-disk','disk-free','disk-C:','critical',20,{peakValue:3.04,threshold:5,params:{name:'C:',freeGb:3,totalGb:100},acknowledged:{at:now-minute,by:'anna@contoso.test'},muted:{until:now+60*minute,by:'anna@contoso.test'}}),
],['view']);
const quiet=device('d-quiet','QUIET','c-a','Contoso',[{...groupParent}],[]);
const devices=[web,lab,quiet];
const noop=()=>{};
const render=(props,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},h(tab.default,{devices,viewer:owner,demo:false,now,customerColumn:true,onOpen:noop,onRefresh:noop,onShowDevices:noop,...props})));
/** The body rows of a DataTable: the id of the alarm (found by its device and its rule and title) and the text of each cell. */
const known=[...web.alerts,...lab.alerts].map(item=>({id:item.id,device:[web,lab].find(server=>server.alerts.includes(item)).name,text:view.alarmText(item,'en',now).rule+view.alarmText(item,'en',now).title+(view.alarmText(item,'en',now).unknown??[]).join('')}));
const rows=html=>{const body=html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1]??'';return [...body.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)].filter(match=>!match[1].includes('sdx-table-empty')).map(match=>{const cells=[...match[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(cell=>cell[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&'));return {id:known.find(item=>cells.includes(item.device)&&cells.includes(item.text))?.id??null,attributes:match[1],cells};});};
const heads=html=>[...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map(match=>match[1].replace(/<[^>]+>/g,''));
const sortOf=html=>Object.fromEntries([...html.matchAll(/<th scope="col"[^>]*aria-sort="(\w+)"[^>]*>(.*?)<\/th>/g)].map(match=>[match[2].replace(/<[^>]+>/g,''),match[1]]));

// ---- Pure rows: sort, counts, filters, options ----
const all=view.alarmRows(devices);
check(all.map(row=>row.alert.id),['a-lab-disk','a-web-crit','a-web-cpu','a-web-info'],'critical → warning → info, then the oldest start first');
check(view.alarmCounts(all),{all:4,critical:2,warning:1,info:1},'level counts');
check(view.filterAlarmRows(all,{level:'critical',customer:'',group:''}).map(row=>row.alert.id),['a-lab-disk','a-web-crit'],'level filter');
check(view.filterAlarmRows(all,{level:'all',customer:'c-a',group:''}).map(row=>row.alert.id),['a-web-crit','a-web-cpu','a-web-info'],'customer filter');
check(view.filterAlarmRows(all,{level:'all',customer:'',group:'g-parent'}).map(row=>row.alert.id),['a-lab-disk'],'a group matches the devices of its subgroups');
check(view.alarmCustomerOptions(all),[{id:'c-a',name:'Contoso'},{id:'c-b',name:'Fabrikam'}],'only customers of devices with alarms');
check(view.alarmGroupOptions(all).map(group=>group.name),['Berlin','Lab','Munich'],'the groups on the group paths, QUIET adds nothing new');
// The column sort (ui/base/table-sort.ts): the order of alarmRows in, Level descending keeps it.
const sorted=sort=>tab.sortedAlarmRows(all,sort,'en').map(row=>row.alert.id);
check(sorted(tab.defaultAlarmSort),['a-lab-disk','a-web-crit','a-web-cpu','a-web-info'],'Level descending (default): the order of alarmRows');
check(sorted({column:'level',direction:'asc'}),['a-web-info','a-web-cpu','a-web-crit','a-lab-disk'],'Level ascending reverses it');
check(sorted({column:'device',direction:'asc'}),['a-lab-disk','a-web-crit','a-web-cpu','a-web-info'],'Device ascending; ties keep the alarmRows order');
check(sorted({column:'alarm',direction:'asc'}),['a-web-cpu','a-lab-disk','a-web-info','a-web-crit'],'Alarm ascending: by rule name (CPU usage, Free disk space, Inventory incomplete, RAM usage)');
check(sorted({column:'since',direction:'asc'}),['a-web-info','a-lab-disk','a-web-cpu','a-web-crit'],'Since ascending: the oldest first');

// ---- Texts ----
const t=(key,params)=>translate('en',key,params),de=(key,params)=>translate('de',key,params);
check(view.alarmStatus(lab.alerts[0],'en').startsWith('Acknowledged by anna@contoso.test, muted until '),true,'acknowledged and muted in one sentence');
check([view.alarmStatus(web.alerts[0],'en'),view.alarmStatus({acknowledged:{at:1,by:'bob'},muted:null},'de'),view.alarmStatus({acknowledged:null,muted:{until:now,by:'x'}},'en').startsWith('Muted until ')],['Open','Quittiert von bob',true],'status texts');
check([view.alarmPeak(web.alerts[0],'en'),view.alarmPeak(lab.alerts[0],'de'),view.alarmPeak(web.alerts[2],'en'),view.alarmPeak({ruleId:'device-offline',peakValue:16.9},'en')],['91.3 %','3 %',null,'16 minutes'],'peak in the rule unit, none for a boolean rule or without a reading, minutes rounded down');
// A days-left rule past its date: "overdue", never a negative number; zero and positive values stay.
check([view.alarmPeak({ruleId:'cert-expiring',peakValue:-20},'en'),view.alarmPeak({ruleId:'cert-expiring',peakValue:-20},'de'),view.alarmPeak({ruleId:'cert-expiring-no-key',peakValue:-1},'en'),view.alarmPeak({ruleId:'os-support-end',peakValue:-3.5},'de')],['20 days overdue','20 Tage überfällig','1 day overdue','4 Tage überfällig'],'negative days left: overdue in English and German');
check([view.alarmPeak({ruleId:'cert-expiring',peakValue:0},'en'),view.alarmPeak({ruleId:'cert-expiring',peakValue:12},'en'),view.alarmPeak({ruleId:'os-support-end',peakValue:180},'en')],['0 days','12 days','180 days'],'zero and positive days are unchanged');
ok(!String(view.alarmPeak({ruleId:'signatures-age',peakValue:-2},'en')).includes('overdue'),'an age rule never says overdue');
check(view.alarmText(lab.alerts[0],'en',now),{rule:'Free disk space',title:'C: low on space',detail:view.alarmText(lab.alerts[0],'en',now).detail},'rule name and the issue title of the issue formatter');
check([view.alarmDuration(0,59*minute,'en'),view.alarmDuration(0,125*minute,'en'),view.alarmDuration(0,(2*1440+90)*minute,'de')],['59 min','2 h 5 min','2 Tg. 1 Std.'],'durations');

// ---- The tab on All devices, a group and a customer ----
let html=render({devices:scopeDevices(devices,{type:'all'})});
// One head without tile, no KPI row and the row entrance (once per page load).
ok(/<section class="sdx-health-tab sdx-alarms" aria-labelledby="([^"]+)"><header class="sdx-section-head"><div class="sdx-section-head-text"><h2 id="\1" class="sr-only">By alarm<\/h2><p>This list shows the open alarms of the devices in this view, the most severe at the top\. Acknowledge an alarm to show that someone is working on it, or mute it for a while\.<\/p><\/div><\/header>/.test(html),'one SectionHead: the sr-only h2 names the section, the meta is the visible description');
ok(!/sdx-health-head|sdx-alarms-head/.test(html)&&!/<header[^>]*>(?:(?!<\/header>).)*sdx-icon-tile/s.test(html),'no own head and no icon tile in the head');
ok(!html.includes('sdx-kpi-row'),'no KPI row: the level counts sit in the filter, the open count on the scope tab');
ok(/<tbody><tr class="[^"]*sdx-enter[^"]*" style="animation-delay:0ms"/.test(html),'the first rows rise in on the first render');
ok(!/<tr [^>]*sdx-enter/.test(render({devices:scopeDevices(devices,{type:'all'})})),'a later render (filter, sort, acknowledge, refresh) does not replay it');
check(heads(html),['Level','Device','Customer','Alarm','Peak','Since','Status','Actions'],'columns with the customer column (two customers)');
check(sortOf(html),{Level:'descending',Device:'none',Alarm:'none',Since:'none'},'sortable: Level (active, descending), Device, Alarm and Since; the other columns do not sort');
ok(html.includes('aria-label="Level: sort ascending"')&&html.includes('aria-label="Device: sort ascending"')&&html.includes('aria-label="Alarm: sort ascending"')&&html.includes('aria-label="Since: sort ascending"'),'each button names the next direction');
check(rows(html).map(row=>row.id),['a-lab-disk','a-web-crit','a-web-cpu','a-web-info'],'All devices: every alarm, sorted');
const first=rows(html)[0].cells;
check([first[0],first[1],first[2],first[3],first[4],first[5]],['Critical','LAB-01','Fabrikam','Free disk spaceC: low on space','3 %','20 min ago'],'a row: level as text, device, customer, rule and title, peak, since');
ok(first[6].startsWith('Acknowledged by anna@contoso.test, muted until'),'status cell');
ok(/<td><button type="button" class="sdx-row-open">LAB-01<\/button><\/td>/.test(html)&&rows(html).every(row=>row.attributes.includes('sdx-row-clickable')),'the device is the primary column: the row and its button open the device');
ok(/<div class="sdx-toolbar"><div class="sdx-toolbar-filters"><div class="sdx-segmented sdx-segmented-sm" role="group" aria-label="Level">/.test(html)&&/<select class="sdx-select sdx-select-sm" aria-label="Customer"/.test(html)&&/<select class="sdx-select sdx-select-sm" aria-label="Group"/.test(html)&&html.includes('All customers')&&html.includes('All groups'),'the level, customer and group filters in the kit Toolbar: the filters are kit Selects (size sm)');
// The group filter only while an alarm row has a group (alarmGroupOptions(rows).length>0).
{
 const ungrouped=devices.map(item=>({...item,groupId:null,groupName:null,groups:[]}));
 check(view.alarmGroupOptions(view.alarmRows(ungrouped)),[],'alarm rows without a group give no group option');
 const bare=render({devices:ungrouped});
 ok(!bare.includes('aria-label="Group"')&&!bare.includes('All groups')&&/<select class="sdx-select sdx-select-sm" aria-label="Customer"/.test(bare),'without a group: no group filter, the customer filter stays');
 ok(!/<select/.test((await import('node:fs')).readFileSync(new URL('../../../ui/devices/monitoring/alarms.tsx',import.meta.url),'utf8')),'alarms.tsx has no native <select literal');
}
ok(/<span>Critical<\/span><b class="sdx-count-critical">2<\/b>/.test(html)&&/<span>Warning<\/span><b>1<\/b>/.test(html),'only the worst non-zero level carries its tone');
ok(/<div class="sdx-toolbar-actions"><button type="button" class="sdx-icon-btn sdx-btn-ghost sdx-icon-btn-framed" aria-label="Export alarms as CSV"/.test(html),'CSV in the toolbar actions');
ok(html.includes('>4 of 4 alarms<'),'the foot');
ok(/<div class="sdx-table-wrap" role="region" aria-label="By alarm" tabindex="0"><table class="sdx-table sdx-data-table">/.test(html),'a DataTable named like its subtab: the table scrolls inside its labelled region');
html=render({devices:scopeDevices(devices,{type:'group',id:'g-parent'})});
check(rows(html).map(row=>row.id),['a-lab-disk'],'a group: only alarms of its devices and subgroups');
html=render({devices:scopeDevices(devices,{type:'group',id:'g-child'})});
ok(!heads(html).includes('Customer')&&!html.includes('aria-label="Customer"'),'a group with one customer: no customer column and no customer filter');
html=render({devices:scopeDevices(devices,{type:'customer',id:'c-a'})});
check(rows(html).map(row=>row.id),['a-web-crit','a-web-cpu','a-web-info'],'a customer: only its alarms');
ok(!heads(html).includes('Customer')&&!html.includes('aria-label="Customer"'),'no customer column and no customer filter in a customer view');
html=render({customerColumn:false});
ok(!heads(html).includes('Customer')&&!html.includes('All customers'),'with one customer no customer column and no customer filter');
html=render({initialFilter:{level:'warning',customer:'',group:''}});
check(rows(html).map(row=>row.id),['a-web-cpu'],'the level filter in the table');
ok(html.includes('>1 of 4 alarms<'),'the foot counts the shown rows');

// ---- Empty states and their actions ----
html=render({devices:[quiet]});
ok(html.includes('No open alarms')&&html.includes('When a device crosses a threshold of an alert rule, its alarm appears here.')&&html.includes('>Show devices<')&&!html.includes('sdx-table-foot'),'no alarm, no Alert rules tab: "Show devices"');
ok(/<tr class="sdx-table-empty"><td colSpan="7">/.test(html)&&heads(html).length===7,'the table keeps its head and shows the Empty as its one row');
ok(render({devices:[quiet],onOpenAlertRules:noop}).includes('>Open alert rules<')&&!render({devices:[quiet],onOpenAlertRules:noop}).includes('>Show devices<'),'no alarm where the scope has Alert rules: "Open alert rules"');
html=render({initialFilter:{level:'info',customer:'c-b',group:''}});
ok(html.includes('No alarms match the filters')&&html.includes('Reset filters')&&rows(html).length===0,'filters that hide every alarm');
ok(render({devices:[quiet]},'de').includes('Keine offenen Alarme')&&render({devices:[quiet],onOpenAlertRules:noop},'de').includes('>Alarmregeln öffnen<'),'German empty states');

// ---- Row menu: rights, demo, acknowledged, muted ----
const calls=[];
const actions={onAcknowledge:()=>calls.push('ack'),onMute:()=>calls.push('mute'),onUnmute:()=>calls.push('unmute'),onOpen:()=>calls.push('open')};
const entries=(target,viewer=owner,demo=false)=>tab.alarmMenu(target,viewer,demo,t,actions).filter(entry=>!entry.separator).map(entry=>[entry.id,entry.blocked??null]);
check(entries({alert:web.alerts[0],device:web}),[['acknowledge',null],['mute',null],['open',null]],'an open alarm: acknowledge, mute, open device; no unmute');
check(entries({alert:lab.alerts[0],device:lab}),[['acknowledge',t('alarms.blocked.acknowledged')],['mute',null],['unmute',null],['open',null]],'acknowledged and muted: acknowledge is blocked, unmute appears');
check(entries({alert:lab.alerts[0],device:lab},technician),[['acknowledge',t('alarms.blocked.right')],['mute',t('alarms.blocked.right')],['unmute',t('alarms.blocked.right')],['open',null]],'without alerts.manage the state entries stay visible and blocked');
check(entries({alert:web.alerts[0],device:web},owner,true),[['acknowledge','Not available for sample devices.'],['mute','Not available for sample devices.'],['open',null]],'demo mode blocks the state entries');
check(t('alarms.blocked.right'),'To change alarms on this device, you need the permission “Manage alert rules and alarms”.','the right text');
tab.alarmMenu({alert:web.alerts[0],device:web},owner,false,t,actions).filter(entry=>!entry.separator).forEach(entry=>entry.onSelect());
check(calls,['ack','mute','open'],'the entries call their actions');

// ---- Error texts by code ----
check([new ApiError('x',409,'ALERT_STATE_CHANGED'),new ApiError('x',400,'ALERT_INVALID'),new ApiError('x',403),new ApiError('Alarm nicht gefunden.',404),new Error('offline')].map(error=>tab.alarmFailure(error,t)),
 [t('alarms.error.changed'),t('alarms.error.invalid'),t('alarms.blocked.right'),t('alarms.error.changed'),t('alarms.error.changed')],'localized failures, never a raw status');
check(tab.alarmFailure(new ApiError('x',409,'ALERT_STATE_CHANGED'),de),'Dieser Alarm hat sich inzwischen geändert, zum Beispiel weil er geschlossen wurde. Aktualisiere die Liste und versuche es erneut.','German failure');

// ---- Device History segment ----
const closed=[
 {...alert('h-1','cpu','cpu','warning',300,{peakValue:95,peakLevel:'critical',threshold:90,params:{value:95}}),state:'closed',closedAt:now-240*minute,closeReason:'recovered'},
 {...alert('h-2','reboot-pending','reboot','warning',600),state:'closed',closedAt:now-500*minute,closeReason:'rule-off'},
 {...alert('h-3','cpu','cpu','critical',900),state:'closed',closedAt:now-890*minute,closeReason:'no-data'},
 {...alert('a-web-crit','memory','memory','critical',5),state:'open',closedAt:null,closeReason:null},
];
const historyRows=view.alarmHistoryRows(web.alerts,closed);
check(historyRows.map(row=>[row.id,row.state]),[['a-web-crit','open'],['a-web-cpu','open'],['a-web-info','open'],['h-1','closed'],['h-2','closed'],['h-3','closed']],'open rows first (newest start first), the history without duplicates');
const historyHtml=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(tab.AlarmHistoryTable,{rows:historyRows,now,menu:row=>tab.alarmMenu({alert:row,device:web},owner,false,t,actions)})));
check(heads(historyHtml),['Level','Alarm','Start','End','Duration','Peak','Closed because','Actions'],'history columns');
const history=rows(historyHtml);
check(history[0].cells.slice(0,7),['Critical','RAM usageRAM high','5 min ago','Still open','5 min','96 %','—'],'an open row: still open, duration so far, the shared placeholder for no reason');
check(history[3].cells.slice(0,7),['Critical','CPU usageCPU high','5 h ago','4 h ago','1 h 0 min','95 %','Recovered'],'a closed row: peak level, end, duration, reason');
check(history.slice(3).map(row=>row.cells[6]),['Recovered','Rule turned off','No data'],'the three close reasons');
ok((historyHtml.match(/sdx-col-actions"><button/g)??[]).length===3,'only open rows keep the row menu');
const emptyHistory=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(tab.AlarmHistoryTable,{rows:[],now,menu:()=>[]})));
ok(emptyHistory.includes('No alarms yet')&&emptyHistory.includes('An alarm appears here when a value on this device crosses a threshold of an alert rule.'),'empty history');
ok(/<div class="sdx-table-wrap" role="region" aria-label="Alarms"[^>]*><table class="sdx-table sdx-data-table">/.test(historyHtml)&&!/<tr class="sdx-row-clickable/.test(historyHtml),'the history is a DataTable without row open');
check(/<span class="sdx-muted-cell" role="img" aria-label="Not used">—<\/span>/.test(renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(tab.AlarmHistoryTable,{rows:[{...alert('h-0','reboot-pending','reboot','warning',60),state:'closed',closedAt:now,closeReason:'recovered'}],now,menu:()=>[]})))),true,'a peak without a value: the shared placeholder named "Not used"');
ok(/<span class="sdx-muted-cell" role="img" aria-label="Nicht genutzt">—<\/span>/.test(renderToStaticMarkup(h(LocaleProvider,{locale:'de'},h(tab.AlarmHistoryTable,{rows:[{...alert('h-0','reboot-pending','reboot','warning',60),state:'closed',closedAt:now,closeReason:'recovered'}],now,menu:()=>[]})))),'German: "Nicht genutzt"');
const loadingHistory=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(tab.AlarmHistory,{device:web,viewer:owner,demo:false,now,onRefresh:noop})));
ok(/<div class="sdx-skeleton-set sdx-skeleton-table" role="status" aria-label="Loading the alarm history">/.test(loadingHistory)&&!loadingHistory.includes('sdx-loading'),'the kit table Skeleton with role status before the first page');
// The AnalysisTab head (nodiverna-ui §4 "Device section"): section labelled by an sr-only h2, the
// description, then the summary row, then the Skeleton or the table.
const historyHead=html=>{
 const section=html.match(/^<section class="sdx-health-tab sdx-alarm-history" aria-labelledby="([^"]+)">/);
 const heading=html.match(/<h2 id="([^"]+)" class="sr-only">([^<]*)<\/h2>/);
 return {labelled:!!section&&!!heading&&section[1]===heading[1],title:heading?.[2]??null};
};
const summaryNode=h('div',{className:'test-summary'},'SUMMARY');
const loadingHead=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(tab.AlarmHistory,{device:web,viewer:owner,demo:false,now,onRefresh:noop,summary:summaryNode})));
check(historyHead(loadingHead),{labelled:true,title:'Alarms'},'loading: a section labelled by the sr-only h2 "Alarms"');
const historyMeta='This list shows the alarms of this device. Open alarms are at the top, and closed alarms follow, newest first.';
ok(loadingHead.includes('<p>'+historyMeta+'</p></div></header>'),'loading: the description line is the SectionHead description');
ok(loadingHead.indexOf('</h2>')<loadingHead.indexOf(historyMeta)&&loadingHead.indexOf(historyMeta)<loadingHead.indexOf('SUMMARY')&&loadingHead.indexOf('SUMMARY')<loadingHead.indexOf('sdx-skeleton-table'),'loading: head, description, summary, then the Skeleton');
ok(!/sdx-section-head-actions|<button/.test(loadingHead.slice(0,loadingHead.indexOf('SUMMARY'))),'no head actions');

// ---- Demo: sample alarms, no closed history ----
const demo=demoData().servers;
const demoAlarms=demo.flatMap(server=>server.alerts??[]);
ok(demoAlarms.length>0&&demoAlarms.every(item=>item.startedAt===demoAlarms[0].startedAt&&item.level!=='info'&&item.acknowledged===null&&item.muted===null),'every warning or critical issue of a sample device is an open alarm');
check(demo.every(server=>(server.alerts??[]).length===(server.issues??[]).filter(issue=>issue.level!=='info').length),true,'one alarm per warning or critical issue');
ok(demo.some(server=>server.alerts?.some(item=>item.ruleId==='device-offline')),'the offline sample device has a Device offline alarm');
const demoHistory=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(tab.AlarmHistory,{device:demo.find(server=>server.alerts?.length),viewer:owner,demo:true,now:Date.now(),onRefresh:noop})));
ok(rows(demoHistory).length>0&&rows(demoHistory).every(row=>row.cells[3]==='Still open'),'demo history: the sample alarms, no closed rows');
{
 const demoDevice=demo.find(server=>server.alerts?.length);
 const demoHead=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(tab.AlarmHistory,{device:demoDevice,viewer:owner,demo:true,now:Date.now(),onRefresh:noop,summary:summaryNode})));
 check(historyHead(demoHead),{labelled:true,title:'Alarms'},'demo: a section labelled by the sr-only h2 "Alarms"');
 ok(demoHead.indexOf(historyMeta)>0&&demoHead.indexOf(historyMeta)<demoHead.indexOf('SUMMARY')&&demoHead.indexOf('SUMMARY')<demoHead.indexOf('<table'),'demo: description, summary, then the table');
 ok(rows(demoHead).length>0&&rows(demoHead).every(row=>row.cells[3]==='Still open'),'demo with the head: still only "Still open" rows');
 const german=renderToStaticMarkup(h(LocaleProvider,{locale:'de'},h(tab.AlarmHistory,{device:demoDevice,viewer:owner,demo:true,now:Date.now(),onRefresh:noop})));
 check(historyHead(german).title,'Alarme','German sr-only title');
 ok(german.includes('Diese Liste zeigt die Alarme dieses Geräts. Offene Alarme stehen oben, darunter folgen die geschlossenen, die neuesten zuerst.'),'German description');
 check(translate('de','alarms.history.meta'),'Diese Liste zeigt die Alarme dieses Geräts. Offene Alarme stehen oben, darunter folgen die geschlossenen, die neuesten zuerst.','German catalog entry');
 // The history rows open nothing, so the AnalysisTab pointer cursor and nowrap cells must not apply to them.
 const css=readFileSync('ui/devices/monitoring/alarms.css','utf8');
 ok(css.includes('.sdx-health-tab.sdx-alarm-history .sdx-table tbody tr:not(.sdx-row-clickable) { cursor: default; }'),'the history overrides the pointer cursor of .sdx-health-tab rows');
 ok(css.includes('.sdx-health-tab.sdx-alarm-history .sdx-table td { white-space: normal; }'),'the history cells wrap as before');
 ok(readFileSync('ui/devices/inventory/health-signals.css','utf8').includes('.sdx-health-tab .sdx-table tbody tr { cursor: pointer; }'),'the overridden rule is the one in health-signals.css (lower specificity than the override)');
 ok(!/<tr class="sdx-row-clickable/.test(demoHead),'no history row is clickable');
}
const demoTab=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(tab.default,{devices:demo,viewer:owner,demo:true,now:Date.now(),customerColumn:false,onOpen:noop,onRefresh:noop,onShowDevices:noop})));
check(rows(demoTab).length,demoAlarms.length,'the tab works in demo mode');

// ---- CSV ----
const csvDevice={...web,name:'=cmd()'};
const csv=view.alarmsCsv([{alert:web.alerts[0],device:csvDevice}],{customer:true},'en',now);
const [headLine,line]=csv.replace('﻿','').split('\r\n');
check(headLine,'"Level";"Device";"Customer";"Rule";"Alarm";"Peak";"Since";"Status"','CSV header with the customer column');
check(line,`"Warning";"'=cmd()";"Contoso";"CPU usage";"CPU high";"91.3 %";"${new Date(now-10*minute).toISOString()}";"Open"`,'one CSV row, protected against formulas');
check(view.alarmsCsv([{alert:alert('a-cert','cert-expiring','cert-9','critical',5,{peakValue:-20,params:{subject:'CN=old',days:-20}}),device:web}],{},'en',now).split('\r\n')[1].split(';')[4],'"20 days overdue"','the CSV peak says overdue like the table');
check(view.alarmsCsvFileName(Date.UTC(2026,9,5,12),'de'),'ServerDesk-Alarme-2026-10-05.csv','file name');

console.log(`PASS alarms view (${checks} checks): sort, counts and filters with subgroups, status, peak and duration texts, the tab on All devices, a group and a customer, the customer column only with several customers, both empty states, blocked menu entries, error texts, the device history segment, demo alarms, the CSV, the one head without a KPI row, the sort heads and the overdue peak.`);
