// The fleet without KPI rows that mirror a filter (UI review slice 2): the Devices
// tab of All devices, a group and a customer renders no KPI row (the status
// Segmented with counts stays), the open alarms of the scope move into the count
// of the scope tab "Monitoring" in the tone of the worst level (alarmTabCount in
// ui/devices/monitoring/alarms-view.ts), and By alarm renders no KPI row. React SSR, no
// browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const {alarmTabCount}=await import('../../../ui/devices/monitoring/alarms-view.ts');
const {default:FleetView}=await import('../../../ui/devices/fleet/fleet.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {demoData}=await import('../../../ui/shell/demo.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const minute=60000,now=Date.UTC(2026,10,3,10,0,0);
const owner={id:'owner',label:'owner',permissions:['*']},noop=()=>{};
const alert=(id,level,extra={})=>({id,ruleId:'cpu',key:id,level,peakLevel:level,peakValue:null,threshold:null,params:{},startedAt:now-10*minute,openedAt:now-10*minute,acknowledged:null,muted:null,...extra});
const device=(id,alerts=[],changes={})=>({id,name:id.toUpperCase(),customerId:null,customerName:null,groupId:null,groupName:null,groups:[],alerts,permissions:['view'],lastSeen:now-10000,snapshot:null,createdAt:0,revoked:0,management:1,...changes});

// ---- alarmTabCount: every open alarm, the tone of the worst level ----
const critical=[device('a',[alert('w1','warning'),alert('i1','info')]),device('b',[alert('c1','critical',{acknowledged:{at:now,by:'anna'}})])];
check(alarmTabCount(critical),{count:3,tone:'critical'},'one critical alarm (acknowledged too) gives the critical tone; every open alarm counts');
check(alarmTabCount([device('a',[alert('w1','warning',{muted:{until:now+minute,by:'anna'}}),alert('i1','info')])]),{count:2,tone:'warning'},'only warnings and infos: warning tone, muted ones count');
check(alarmTabCount([device('a',[alert('i1','info')]),device('b',[alert('i2','info')])]),{count:2},'only infos: a count without a tone');
check(alarmTabCount([device('a'),device('b')]),null,'no open alarm: no count');
check(alarmTabCount([]),null,'an empty scope: no count');

// ---- FleetView ----
const fleetProps={header:null,groupEmpty:false,viewer:owner,demo:true,saving:false,now:Date.now(),jobs:[],audit:[],onTab:noop,canOffboard:false,onOpen:noop,onConfirm:noop,onSelectJob:noop,onCancelJob:noop,onUpdated:noop,onDemo:noop,canMove:false,onMove:noop,customerColumn:false};
const {servers}=demoData();
const fleet=(props,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},h(FleetView,{...fleetProps,servers,scoped:servers,tab:'devices',...props})));
/** The content of the "Alarms" scope tab: label and count. */
const alarmTab=html=>html.match(/id="sdx-fleet-panel-tab-monitoring"[^>]*>([\s\S]*?)<\/a>/)?.[1];

// no KPI row on the Devices tab of any scope; the status Segmented with counts stays.
for(const [scope,props] of [['all',{scope:{type:'all'}}],['group',{scope:{type:'group',id:'g1'},group:{id:'g1',name:'Berlin'}}],['customer',{scope:{type:'customer',id:'c1'}}]]){
 const html=fleet(props);
 ok(!html.includes('sdx-kpi-row')&&!html.includes('sdx-kpi'),`${scope}: the Devices tab renders no KPI row`);
 ok(/<div class="sdx-segmented sdx-segmented-sm" role="group" aria-label="Status">/.test(html)&&/<span>All<\/span><b>\d+<\/b>/.test(html),`${scope}: the status Segmented with counts stays`);
}
ok(!fleet({scoped:[],groupEmpty:true}).includes('sdx-kpi-row')&&fleet({scoped:[],groupEmpty:true}).includes('sdx-empty'),'an empty group: no KPI row, the Empty stays');

// the Monitoring tab count and tone, on the inactive tab as well.
const open=alarmTabCount(servers);
ok(open&&open.count>0,'the sample devices have open alarms');
const tab=alarmTab(fleet({}));
check(tab,`<span>Monitoring</span><b${open.tone?` class="sdx-count-${open.tone}"`:''}>${open.count}</b>`,'the inactive Monitoring tab shows the open count in the worst tone');
const fixtures=[
 ['critical',[device('a',[alert('c1','critical'),alert('w1','warning')]),device('b',[alert('i1','info')])],'<span>Monitoring</span><b class="sdx-count-critical">3</b>'],
 ['only warning',[device('a',[alert('w1','warning')]),device('b',[alert('i1','info')])],'<span>Monitoring</span><b class="sdx-count-warning">2</b>'],
 ['only info',[device('a',[alert('i1','info')])],'<span>Monitoring</span><b>1</b>'],
 ['none',[device('a'),device('b')],'<span>Monitoring</span>'],
];
for(const [label,devices,expected] of fixtures){
 check(alarmTab(fleet({servers:devices,scoped:devices,demo:false})),expected,`${label}: the Monitoring tab count and tone`);
 check(alarmTab(fleet({servers:devices,scoped:devices,demo:false,tab:'alarms'})),expected,`${label}: the same on the active Monitoring tab`);
}
ok(fleet({},'de').includes('id="sdx-fleet-panel-tab-monitoring"'),'German render');

// the By alarm subtab renders no KPI row (the summary row is By device only); the level Segmented with counts stays.
const alarms=fleet({tab:'alarms'});
ok(!alarms.includes('sdx-kpi-row'),'the By alarm subtab renders no KPI row');
ok(/role="group" aria-label="Level"/.test(alarms),'the level Segmented stays');

console.log(`PASS fleet KPIs (${checks} checks): no KPI row on the Devices tab of All devices, a group or a customer, the status Segmented stays, the open alarms as the Monitoring tab count with the worst tone (critical, warning, none) on the inactive and active tab, and no KPI row on By alarm.`);
