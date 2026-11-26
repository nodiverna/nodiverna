// The Monitoring tab: the summary helper ui/devices/monitoring/monitoring-summary-model.ts, the summary KPI row of the default
// Monitoring subtab (ui/devices/monitoring/monitoring-summary.tsx) with its loads (a customer counts its own alert rules),
// the editable alert rules of a customer and the device Monitoring area with Alarms by default and a History
// without Alarms.
// React SSR, no browser, no server.
import {mock} from '../../support/register.mjs';
import * as radix from 'radix-ui';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
mock('radix-ui',{...radix,DropdownMenu:{...radix.DropdownMenu,Portal:({children})=>children}});
const {monitoringSummary}=await import('../../../ui/devices/monitoring/monitoring-summary-model.ts');
const {MonitoringKpis}=await import('../../../ui/devices/monitoring/monitoring-summary.tsx');
const alertPanel=await import('../../../ui/devices/monitoring/alert-rules.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {default:DeviceView}=await import('../../../ui/devices/device/device.tsx');
const {demoData}=await import('../../../ui/shell/demo.ts');
const alertRules=await import('../../../lib/alert-rules.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
const catalogs={en:(await import('../../../lib/i18n/messages/en.ts')).default,de:(await import('../../../lib/i18n/messages/de.ts')).default};
const {panelHarness}=await import('../../support/panel-harness.mjs');
const {ApiError}=await import('../../../ui/base/http.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const noop=()=>{};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=value=>value.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();

// ---- monitoringSummary ----
const channel=(id,enabled=true)=>({id,name:id,type:'webhook',enabled});
const notificationRule=(id,channelId,changes={})=>({id,scope:{type:'all',id:'*'},channel:channel(channelId),levels:['critical'],events:{open:true,close:true,escalate:true},enabled:true,revision:0,...changes});
const defaults=alertRules.defaultAlertRuleView({type:'global',id:'*',name:''});
const changedView={rules:defaults.rules.map((row,index)=>index===0?{...row,effective:{...row.effective,enabled:!row.effective.enabled},override:{...row.effective,enabled:!row.effective.enabled,updatedAt:1}}:index===1?{...row,override:{...row.effective,updatedAt:2}}:row)};
const onByDefault=defaults.rules.filter(row=>row.effective.enabled).length;
const notifications={direct:[notificationRule('r1','c1'),notificationRule('r2','c2',{enabled:false})],inherited:[{...notificationRule('r3','c1'),origin:{type:'all',id:'*',name:'',visible:true}},{...notificationRule('r4','c3',{channel:channel('c3',false)}),origin:{type:'all',id:'*',name:'',visible:true}},{...notificationRule('r5','c4'),origin:{type:'group',id:'g',name:'G',visible:false}}]};
check(monitoringSummary(defaults,notifications),{alertRulesOn:onByDefault,alertRulesChanged:0,notificationRules:3,channels:2},'the default rules; rules that send: on and with a channel that is on; distinct channels');
const firstOn=defaults.rules[0].effective.enabled;
check(monitoringSummary(changedView,null),{alertRulesOn:onByDefault+(firstOn?-1:1),alertRulesChanged:2,notificationRules:null,channels:null},'effective.enabled counts, every override counts as changed; no notification view: null');
check(monitoringSummary(null,{direct:[],inherited:[]}),{alertRulesOn:null,alertRulesChanged:null,notificationRules:0,channels:0},'no alert view: null; no rule: 0 rules, 0 channels');
check(monitoringSummary(null,null),{alertRulesOn:null,alertRulesChanged:null,notificationRules:null,channels:null},'both null');
check(monitoringSummary(null,{direct:[notificationRule('r1','c1',{enabled:false})],inherited:[{...notificationRule('r2','c2',{channel:channel('c2',false)}),origin:{type:'all',id:'*',name:'',visible:true}}]}),{alertRulesOn:null,alertRulesChanged:null,notificationRules:0,channels:0},'a disabled rule and a rule of a disabled channel send nothing');

// ---- The summary KPI row ----
const tiles=html=>[...html.matchAll(/<button type="button" class="([^"]*sdx-kpi[^"]*)"[^>]*>(.*?)<\/button>/gs)].map(match=>({classes:match[1],label:text(match[2].match(/<span class="sdx-kpi-label"[^>]*>(.*?)<\/span>/s)?.[1]??''),value:text(match[2].match(/<span class="sdx-kpi-value">(.*?)<\/span>/s)?.[1]??''),detail:text(match[2].match(/<span class="sdx-kpi-detail"[^>]*>(.*?)<\/span>/s)?.[1]??''),icon:match[2].match(/lucide-([a-z-]+)/)?.[1]}));
const opened=[];
const kpis=(summary,demo=false,locale='en')=>render(h(MonitoringKpis,{summary,demo,onOpenAlertRules:()=>opened.push('alerts'),onOpenNotificationRules:()=>opened.push('notifications')}),locale);
const html=kpis({alertRulesOn:24,alertRulesChanged:3,notificationRules:4,channels:2});
ok(/<section class="sdx-kpi-row" aria-label="Monitoring summary"/.test(html),'a KpiRow named "Monitoring summary"');
check(tiles(html).map(tile=>[tile.label,tile.value,tile.detail,tile.icon,/sdx-kpi-warning/.test(tile.classes),/sdx-lift/.test(tile.classes)]),[['Alert rules on','24','3 changed here','bell-ring',false,true],['Notification rules','4','2 channels','send',false,true]],'two pressable tiles: alert rules on with the changes, notification rules with their channels');
check(tiles(kpis({alertRulesOn:24,alertRulesChanged:1,notificationRules:1,channels:1})).map(tile=>tile.detail),['1 changed here','1 channel'],'singular details');
check(tiles(kpis({alertRulesOn:24,alertRulesChanged:0,notificationRules:0,channels:0})).map(tile=>[tile.value,tile.detail,/sdx-kpi-warning/.test(tile.classes)]),[['24','No changes here',false],['0','Nobody gets notified.',true]],'nobody notified: the one warning tile');
check(tiles(kpis({alertRulesOn:24,alertRulesChanged:0,notificationRules:null,channels:null},true)).map(tile=>[tile.value,tile.detail,/sdx-kpi-warning/.test(tile.classes)]),[['24','No changes here',false],['0','Sample devices have no notification rules.',false]],'sample devices: 0, the demo detail, neutral');
check(kpis({alertRulesOn:null,alertRulesChanged:null,notificationRules:3,channels:1}),'','a pending or failed alert view: one tile left, so no row');
check(kpis({alertRulesOn:12,alertRulesChanged:0,notificationRules:null,channels:null}),'','a pending or failed notification view: no row and no error');
ok(/<div class="sdx-kpi-grid[^"]*">/.test(html),'the tiles sit in the grid of the row');
check(tiles(kpis({alertRulesOn:24,alertRulesChanged:2,notificationRules:0,channels:0},false,'de')).map(tile=>[tile.label,tile.detail]),[['Aktive Alarmregeln','2 hier geändert'],['Benachrichtigungsregeln','Niemand wird benachrichtigt.']],'German tiles');

// ---- MonitoringSummaryRow: the same GETs as the subtabs; demo loads nothing; a failure shows no row ----
{
 const calls=[];let fail=false;
 const api=async url=>{calls.push(url);if(fail)throw new ApiError('offline',503);return url.startsWith('/api/alert-rules')?changedView:notifications;};
 const harness=panelHarness({hooked:['ui/devices/monitoring/monitoring-summary.tsx'],stubs:{'@/ui/base/api':{api}},locale:'en'});
 const Row=harness.load('ui/devices/monitoring/monitoring-summary.tsx').default;
 const props={alertScope:{type:'customer',id:'c1'},notificationScope:{type:'customer',id:'c1'},demo:false,onOpenAlertRules:()=>opened.push('alerts'),onOpenNotificationRules:()=>opened.push('notifications')};
 harness.reset();
 check(harness.html(Row,props),'','nothing before the answers');
 await harness.flush();
 check(calls,['/api/alert-rules?scopeType=customer&scopeId=c1','/api/notifications/rules?scope=customer%3Ac1'],'a customer reads its own alert rules and notification rules');
 const loaded=harness.html(Row,props);
 check(tiles(loaded).map(tile=>[tile.label,tile.value]),[['Alert rules on',String(onByDefault+(firstOn?-1:1))],['Notification rules','3']],'the row shows the counts of both views');
 const element=harness.tree(Row,props);
 element.props.onOpenAlertRules();element.props.onOpenNotificationRules();
 check(opened.splice(0),['alerts','notifications'],'the tiles open Alert rules and Notification rules');
 // A device: both GETs of the device.
 harness.reset();calls.length=0;
 harness.tree(Row,{...props,alertScope:{type:'device',id:'d1'},notificationScope:{type:'device',id:'d1'}});await harness.flush();
 check(calls,['/api/alert-rules?scopeType=device&scopeId=d1','/api/notifications/rules?scope=device%3Ad1'],'a device reads its alert rules and the rules that reach it');
 // A failed request: no value, no row, no extra error.
 harness.reset();calls.length=0;fail=true;
 harness.tree(Row,props);await harness.flush();
 const failed=harness.html(Row,props);
 check([failed,calls.length],['',2],'a failed request leaves the tile without a value: no row, no notice');
 // Sample devices: nothing is loaded; the default rules and the demo tile.
 harness.reset();calls.length=0;fail=false;
 harness.tree(Row,{...props,demo:true});await harness.flush();
 const demo=harness.html(Row,{...props,demo:true});
 check([calls,tiles(demo).map(tile=>[tile.value,tile.detail])],[[],[[String(onByDefault),'No changes here'],['0','Sample devices have no notification rules.']]],'sample devices load nothing and show the demo tile');
 // A scope without rules subtabs (Ungrouped): the console passes no row; the component alone renders nothing.
 check(harness.html(Row,{...props,alertScope:null,notificationScope:null}),'','no scopes: no row');
}

// ---- Customer › Monitoring › Alert rules: the customer level, editable like a group ----
{
 const customer={type:'customer',id:'c1'};
 const own={type:'customer',id:'c1',name:'Contoso',visible:true},global={type:'global',id:'*',name:'',visible:true};
 // Row 0 inherits from All devices, row 1 is changed on the customer (inherited from All devices), the rest is the default.
 const view={scope:{type:'customer',id:'c1',name:'Contoso'},canEdit:true,reason:null,rules:defaults.rules.map((row,index)=>index===0?{...row,origin:global,inherited:{...row.inherited,origin:global}}:index===1?{...row,origin:own,override:{...row.effective,updatedAt:5},inherited:{...row.inherited,origin:global}}:row)};
 const origins=[];
 const table=render(h(alertPanel.AlertRulesTable,{view,scope:customer,customerView:true,onEdit:noop,onReset:noop,onOpenOrigin:origin=>origins.push(origin)}));
 const body=table.slice(table.indexOf('<tbody'),table.indexOf('</tbody>'));
 // The origin is the second-to-last cell of a row (before the row menu).
 const originCells=[...body.matchAll(/<tr(?: [^>]*)?>(.*?)<\/tr>/gs)].map(row=>[...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(cell=>text(cell[1])).at(-2));
 check([originCells[0],originCells[1].startsWith('Changed Inherited:')&&originCells[1].endsWith('from All devices'),originCells[2]],['Inherited All devices',true,'Default'],'All devices is a higher origin, the own change is "Changed" with the inherited value, the default is muted');
 ok(/<button type="button" class="sdx-inherited-link" aria-label="Open All devices">All devices<\/button>/.test(body),'All devices is the origin link');
 const t=(key,params)=>translate('en',key,params);
 const menu=alertPanel.alertRuleMenu(view.rules[1],customer,t,{customerView:true,onEdit:()=>origins.push('edit'),onReset:()=>origins.push('reset'),onOpenOrigin:origin=>origins.push(origin)});
 check(menu.map(entry=>[entry.id,entry.blocked??null]),[['edit',null],['reset',null]],'a customer change: edit and reset, no origin (it is the scope itself)');
 menu[0].onSelect();menu[1].onSelect();
 check(origins.splice(0),['edit','reset'],'edit and reset act');
 const customerRight=t('alertRules.blocked.customerRight');
 check(alertPanel.alertRuleMenu(view.rules[0],customer,t,{blocked:customerRight,onEdit:noop,onReset:noop,onOpenOrigin:noop}).map(entry=>[entry.id,entry.blocked??null]),[['edit',customerRight],['origin',null]],'blocked with the customer-right reason; All devices still opens');
 // The panel: the customer GET, no notice, and reset and save send the customer scope.
 const calls=[];let answer=view;
 const harness=panelHarness({hooked:['ui/devices/monitoring/alert-rules.tsx'],stubs:{'@/ui/base/api':{api:async(url,payload)=>{calls.push([url,payload]);return payload?{ok:true,updatedAt:null}:answer;},ApiError,message:failure=>failure.message}},locale:'en'});
 const Panel=harness.load('ui/devices/monitoring/alert-rules.tsx').default;
 const refreshed=[];
 const props={scope:customer,scopeName:'Contoso',demo:false,customerView:true,onRefresh:()=>{refreshed.push('console');},onOpenOrigin:noop};
 harness.reset();harness.tree(Panel,props);await harness.flush();
 const panelHtml=harness.html(Panel,props);
 check(calls,[['/api/alert-rules?scopeType=customer&scopeId=c1',undefined]],'it loads the rules of the customer');
 ok(!panelHtml.includes('role="status"')&&!/no alert rules of their own/.test(panelHtml),'no read-only notice');
 const rulesTable=harness.find(harness.tree(Panel,props),item=>typeof item.props?.onReset==='function'&&item.props.view);
 check([rulesTable.props.blocked,'readOnly' in rulesTable.props,rulesTable.props.customerView],[undefined,false,true],'the table is editable and has no readOnly prop');
 rulesTable.props.onReset(view.rules[1]);await harness.settle();
 check(calls.slice(1,2),[['/api/alert-rules',{action:'reset-rule',scopeType:'customer',scopeId:'c1',ruleId:view.rules[1].ruleId,expected:5}]],'reset sends the customer scope with the expected fence');
 check([calls.length,refreshed],[3,['console']],'after the reset the panel and the console data reload');
 answer={...view,canEdit:false,reason:'customer-right'};
 harness.reset();calls.length=0;harness.tree(Panel,props);await harness.flush();
 check(harness.find(harness.tree(Panel,props),item=>typeof item.props?.onReset==='function'&&item.props.view).props.blocked,customerRight,'without the global right: blocked with the customer-right reason');
 check(['en','de'].map(locale=>Object.hasOwn(catalogs[locale],'alertRules.customer.notice')),[false,false],'the read-only notice is gone from both catalogs');
 check([translate('en','alertRules.origin.customer',{name:'Contoso'}),translate('de','alertRules.origin.customer',{name:'Contoso'})],['Customer: Contoso','Kunde: Contoso'],'the customer origin label');
}

// ---- The device: Monitoring with Alarms by default, the History without Alarms ----
{
 const {servers}=demoData();
 const server=servers.find(item=>(item.alerts?.length??0)>0)??servers[0];
 const viewer={id:'owner',label:'owner',permissions:['*']};
 const props=patch=>({server,servers,viewer,demo:true,saving:false,now:Date.now(),section:'overview',onSection:noop,samples:[],historyLoading:false,jobs:[],audit:[],crumbs:[],onConfirm:noop,onSelectJob:noop,onCancelJob:noop,canOffboard:false,permissions:h('div',null,'perms'),...patch});
 const bar=(markup,label)=>{const start=markup.indexOf(`aria-label="${label}"`);return start<0?'':markup.slice(start,markup.indexOf('</nav>',start));};
 const labels=markup=>[...markup.matchAll(/role="tab"[^>]*>(?:<span>)?([^<]+)</g)].map(match=>match[1]);
 const monitoring=render(h(DeviceView,props({section:'monitoring'})));
 const areas=labels(bar(monitoring,'Device areas'));
 check(areas.slice(-2),['Monitoring','Configuration'],'Monitoring before Configuration, at the end of the area bar');
 check(labels(bar(monitoring,'Monitoring area')),['Alarms','Alert rules','Notification rules'],'the Monitoring pill bar: Alarms, Alert rules, Notification rules');
 ok(/<nav class="sdx-tabbar sdx-tabbar-pill sdx-subtabs" aria-label="Monitoring area"/.test(monitoring),'a pill subtab bar named "Monitoring area"');
 ok(/<section class="sdx-kpi-row" aria-label="Monitoring summary"/.test(monitoring),'Alarms shows the summary row first');
 ok(monitoring.indexOf('Monitoring summary')<monitoring.indexOf('<table'),'the summary row above the alarm table');
 const history=render(h(DeviceView,props({section:'history'})));
 check(labels(bar(history,'History area')),['Jobs','Device access'],'the History bar has no Alarms tab');
 const rules=render(h(DeviceView,props({section:'monitoring',detail:{deviceDetail:'alert-rules'},alerts:h('div',null,'device alert rules')})));
 ok(rules.includes('<div>device alert rules</div>')&&!rules.includes('Monitoring summary'),'Alert rules shows the device alert rules, without the summary');
 const reader=render(h(DeviceView,props({section:'configuration',permissions:undefined,viewer:{id:'reader',label:'reader',permissions:[]},alerts:h('div',null,'device alert rules')})));
 ok(reader.includes('<div>device alert rules</div>')&&!labels(bar(reader,'Device areas')).includes('Configuration'),'without the role assignment right: no Configuration tab, a Configuration link shows Monitoring › Alert rules');
 check([translate('en','device.monitoringArea'),translate('de','device.monitoringArea'),translate('de','device.section.monitoring')],['Monitoring area','Monitoring-Bereich','Monitoring'],'the area labels');
}

console.log(`PASS monitoring tab (${checks} checks): monitoringSummary with null inputs, disabled rules and channels and distinct channels; the summary KPI row with its warning, demo and missing tiles and its loads; the editable customer alert rules; the device Monitoring area with Alarms by default and the History without Alarms.`);
