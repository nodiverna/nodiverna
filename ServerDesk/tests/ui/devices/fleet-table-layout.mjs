// The fixed column layout of the fleet Devices table (ui/devices/fleet/fleet.tsx on the kit DataTable layout="fixed"):
// every column but Device has a width token from app/globals.css (one per column kind, px on the 4px grid, declared
// once in :root), Device takes the rest with its minimum, the widths follow the shown columns (column switches, the
// customer and group rules, the long status labels), every column key of the menu has a width, and the table renders
// with the fixed class while the card layout stays as it was. React SSR and PostCSS, no browser.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const {postcss}=await import('../../support/theme-colors.mjs');
const {fleetColumnKeys,fleetColumnNames,defaultFleetColumns}=await import('../../../ui/devices/fleet/fleet-columns.ts');
const {default:FleetView,DeviceCard,fleetTableColumns,longStatusKinds}=await import('../../../ui/devices/fleet/fleet.tsx');
const {fixedTableMinWidth}=await import('../../../ui/kit/data-table.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
const noop=()=>{};
const now=Date.UTC(2026,10,14,10,0,0);
(await import('../../../ui/base/clock-store.ts')).consoleClock.set(now);
const t=(key,params)=>translate('en',key,params);
const columnsOf=(columns,extra={})=>fleetTableColumns({columns,showCustomer:true,showGroup:true,locale:'en',t,menu:()=>null,...extra});
const allOn=Object.fromEntries(fleetColumnKeys.map(key=>[key,true]));
const allOff=Object.fromEntries(fleetColumnKeys.map(key=>[key,false]));
const token=/^var\(--sd-col-[a-z-]+\)$/;

// ---- Every column but Device has a width token; Device has none and carries the minimum ----
for(const [name,columns,extra] of [['every column on',allOn,{}],['the defaults',defaultFleetColumns,{}],['customer and group off',defaultFleetColumns,{showCustomer:false,showGroup:false}],['every switch off',allOff,{}]]){
 const shown=columnsOf(columns,extra);
 const device=shown.find(column=>column.primary);
 check([device?.id,device?.width,device?.minWidth],['name',undefined,'var(--sd-col-device-min)'],`${name}: Device is the primary column without a width, with the minimum token`);
 const others=shown.filter(column=>!column.primary);
 check(others.filter(column=>!token.test(String(column.width))).map(column=>column.id),[],`${name}: every other column has a var(--sd-col-…) width`);
}
check(columnsOf(allOn).map(column=>[column.id,column.width??null]),[
 ['name',null],['connection','var(--sd-col-status)'],['health','var(--sd-col-health)'],['customer','var(--sd-col-customer)'],['group','var(--sd-col-group)'],
 ['description','var(--sd-col-description)'],['tags','var(--sd-col-tags)'],['os','var(--sd-col-os)'],['manufacturer','var(--sd-col-manufacturer)'],['cpu','var(--sd-col-meter)'],['memory','var(--sd-col-meter)'],
 ['disk','var(--sd-col-free)'],['agent','var(--sd-col-agent)'],['osSupport','var(--sd-col-os-support)'],['bitlocker','var(--sd-col-bitlocker)'],['diskHealth','var(--sd-col-disk-health)'],
 ['ssdWear','var(--sd-col-ssd-wear)'],['battery','var(--sd-col-battery)'],['heartbeat','var(--sd-col-last-seen)'],['actions','var(--sd-col-actions)'],
],'every column on: one token per column kind, in table order (CPU and RAM share the meter width)');
check(columnsOf(defaultFleetColumns).map(column=>column.id),['name','connection','health','customer','group','cpu','memory','disk','heartbeat','actions'],'the defaults: the fixed columns plus customer, group, CPU, RAM and Free');
check(columnsOf(defaultFleetColumns,{showCustomer:false,showGroup:false}).map(column=>column.id),['name','connection','health','cpu','memory','disk','heartbeat','actions'],'customer and group off: both leave');

// ---- Every key of the column menu maps to a column with a width (a future column without one fails here) ----
for(const key of fleetColumnKeys){
 // The Customer column follows showCustomer (several customers in the portal, two or more in the view, and its switch), the others their switch.
 const shown=columnsOf({...allOff,[key]:true},{showCustomer:key==='customer'}),fixed=columnsOf(allOff,{showCustomer:false}).map(column=>column.id);
 const added=shown.filter(column=>!fixed.includes(column.id));
 check(added.length,1,`${key}: switching it on adds one column`);
 ok(token.test(String(added[0].width)),`${key} (${fleetColumnNames[key]}): its column has a width token`);
}
check(columnsOf(allOff,{showCustomer:false}).map(column=>column.id),['name','connection','health','heartbeat','actions'],'Status, Health, Last seen and Actions are fixed columns (with their widths above)');

// ---- The min-width follows the shown columns ----
const sum=(columns,extra)=>fixedTableMinWidth(columnsOf(columns,extra),true);
check(sum(defaultFleetColumns,{showCustomer:false,showGroup:false}),'calc(var(--sd-col-check) + var(--sd-col-device-min) + var(--sd-col-status) + var(--sd-col-health) + var(--sd-col-meter) + var(--sd-col-meter) + var(--sd-col-free) + var(--sd-col-last-seen) + var(--sd-col-actions))','defaults without customer and group: the check column, the Device minimum and every shown width');
ok(sum(defaultFleetColumns).includes('var(--sd-col-customer) + var(--sd-col-group)')&&!sum(defaultFleetColumns,{showCustomer:false}).includes('--sd-col-customer')&&!sum(defaultFleetColumns,{showGroup:false}).includes('--sd-col-group'),'the customer and group widths come and go with their columns');
ok(!sum({...defaultFleetColumns,cpu:false}).includes('--sd-col-meter) + var(--sd-col-meter')&&sum({...defaultFleetColumns,os:true}).includes('--sd-col-os)'),'a column switch adds or removes its width');
// The long connection labels widen the Status column while such a device shows.
check([...longStatusKinds].sort(),['maintenance','waiting'],'waiting (first report pending, registration expired) and agent maintenance are the long labels');
check(columnsOf(defaultFleetColumns,{longStatus:true}).find(column=>column.id==='connection').width,'var(--sd-col-status-long)','longStatus: the long status width');
ok(sum(defaultFleetColumns,{longStatus:true}).includes('var(--sd-col-status-long)'),'and the min-width counts it');

// ---- The tokens: defined once in :root, px on the 4px grid, nowhere else ----
const root=new Map();
postcss.parse(read('app/globals.css')).each(node=>{if(node.type==='rule'&&node.selector.trim()===':root')node.walkDecls(/^--sd-col-/,decl=>root.set(decl.prop,[...(root.get(decl.prop)??[]),decl.value]));});
const used=new Set([...columnsOf(allOn),...columnsOf(allOn,{longStatus:true})].flatMap(column=>[column.width,column.minWidth]).filter(Boolean).map(value=>/var\((--sd-col-[a-z-]+)\)/.exec(value)[1]));
used.add('--sd-col-check');
for(const name of used){
 const values=root.get(name)??[];
 check(values.length,1,`${name} is declared once in :root`);
 const px=/^(\d+)px$/.exec(values[0]??'');
 ok(px&&Number(px[1])%4===0,`${name} is ${values[0]}: px on the 4px grid`);
}
const elsewhere=[];
for(const file of ['ui/styles/console.css','ui/styles/motion.css'])postcss.parse(read(file)).walkDecls(/^--sd-col-/,decl=>elsewhere.push(`${file} ${decl.prop}`));
postcss.parse(read('app/globals.css')).walkDecls(/^--sd-col-/,decl=>{if(decl.parent.selector?.trim()!==':root')elsewhere.push(`globals ${decl.parent.selector}`);});
check(elsewhere,[],'no other rule defines a column token');
check(Number(root.get('--sd-col-status-long')[0].replace('px',''))>Number(root.get('--sd-col-status')[0].replace('px','')),true,'the long status width is wider than the short one');

// ---- FleetView: the Devices table has the fixed layout; the card layout is unchanged ----
const device=(id,name,extra={})=>({id,name,createdAt:now-86400000,lastSeen:now-30000,revoked:0,management:0,snapshot:null,permissions:['view'],...extra});
const viewer={id:'owner',label:'owner@example.test',permissions:['*']};
const props={header:null,groupEmpty:false,viewer,demo:false,saving:false,jobs:[],audit:[],tab:'devices',onTab:noop,canOffboard:false,onOpen:noop,onConfirm:noop,onSelectJob:noop,onCancelJob:noop,onUpdated:noop,onDemo:noop,canMove:true,onMove:noop,customerColumn:false};
const fleet=(devices,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},h(FleetView,{...props,servers:devices,scoped:devices})));
const online=[device('a','SRV-A',{groupId:'g1',groupName:'Berlin'}),device('b','SRV-B')];
const html=fleet(online);
const table=html.match(/<table\b[^>]*>/)[0];
ok(/class="sdx-table sdx-data-table sdx-table-sticky-actions sdx-table-fixed"/.test(table),'FleetView: the Devices table has the sticky actions and the fixed layout');
check(/style="min-width:([^"]*)"/.exec(table)[1],'calc(var(--sd-col-check) + var(--sd-col-device-min) + var(--sd-col-status) + var(--sd-col-health) + var(--sd-col-group) + var(--sd-col-meter) + var(--sd-col-meter) + var(--sd-col-free) + var(--sd-col-last-seen) + var(--sd-col-actions))','the min-width of the shown default columns (a grouped device, no customer column)');
const heads=[...html.slice(html.indexOf('<thead>'),html.indexOf('</thead>')).matchAll(/<th\b[^>]*>/g)].map(match=>/style="width:([^"]*)"/.exec(match[0])?.[1]??null);
check(heads,[null,null,'var(--sd-col-status)','var(--sd-col-health)','var(--sd-col-group)','var(--sd-col-meter)','var(--sd-col-meter)','var(--sd-col-free)','var(--sd-col-last-seen)','var(--sd-col-actions)'],'the head row: the check column (class width), Device without a width, every other column its token');
{const none=fleet([]);check(/<td colSpan="(\d+)">/.exec(none)?.[1],String((none.match(/<th[ >]/g)??[]).length),'no devices: the empty row spans every head (nine: no group column without a grouped device)');}
ok(fleet([device('w','SRV-NEW',{lastSeen:null})]).includes('style="width:var(--sd-col-status-long)"'),'a device waiting for its first report widens the Status column');
ok(!html.includes('--sd-col-status-long'),'with Online and Offline only, the short Status width');
ok(/style="width:var\(--sd-col-last-seen\)" aria-sort="none"><button type="button" class="sdx-sort" aria-label="Letzte Meldung/.test(fleet(online,'de')),'German: the same widths, the same heads');
// A device with a minimal snapshot (no networks, disks, services, processes, events or hotfixes keys: seed data, a
// partial report) renders beside a normal one, in the table, with every column on, and as a card: one such device
// must not blank the Devices page.
{const minimal=device('m','SRV-MINIMAL',{snapshot:{protocolVersion:3,os:'Windows Server 2022',agentVersion:'1.0.0',mode:'ReadOnly'}});
 const full=device('n','SRV-NORMAL',{snapshot:{protocolVersion:3,os:'Windows Server 2022',agentVersion:'1.0.0',mode:'Management',cpu:12,memory:40,networks:[{name:'Ethernet',addresses:['10.0.0.5']}],disks:[{name:'C:',totalGb:100,freeGb:40}],services:[],processes:[],events:[],hotfixes:[]}});
 let markup='';
 assert.doesNotThrow(()=>{markup=fleet([minimal,full]);},'FleetView renders a fleet with a minimal snapshot');checks++;
 ok(markup.includes('SRV-MINIMAL')&&markup.includes('SRV-NORMAL'),'both device rows are in the markup');
 let wide='';
 assert.doesNotThrow(()=>{wide=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h('table',null,h('tbody',null,h('tr',null,...columnsOf(allOn).map(column=>h('td',{key:column.id},column.cell(minimal,now))))))));},'every column cell renders for a minimal snapshot');checks++;
 ok(wide.includes('SRV-MINIMAL'),'the Device cell names it');
 let minimalCard='';
 assert.doesNotThrow(()=>{minimalCard=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(DeviceCard,{server:minimal,customer:false,group:true,selectable:true,selected:false,draggable:true,onDragStart:noop,onSelect:noop,onOpen:noop,menu:null})));},'the card renders for a minimal snapshot');checks++;
 ok(minimalCard.includes('SRV-MINIMAL'),'the card names it');}
// The cards (the "Cards" layout and the phone) use DeviceCard: no table, no fixed class, no width.
const card=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(DeviceCard,{server:online[0],customer:false,group:true,selectable:true,selected:false,draggable:true,onDragStart:noop,onSelect:noop,onOpen:noop,menu:null})));
ok(card.startsWith('<article')||card.includes('sdx-device-card'),'DeviceCard renders a card');
ok(!/sdx-table|--sd-col-|min-width/.test(card),'the card has no table class and no column width');
const source=read('ui/devices/fleet/fleet.tsx');
check((source.match(/layout="fixed"/g)??[]).length,1,'one table in fleet.tsx takes the fixed layout: the Devices DataTable');
ok(/stickyActions layout="fixed"/.test(source)&&/<EntranceList id="fleet-rows" className="sdx-cards">/.test(source),'the Devices DataTable is fixed; the card branch keeps its EntranceList of DeviceCards');

console.log(`PASS fleet table layout (${checks} checks): a width token per fleet column kind (defined once, 4px grid), Device takes the rest with its minimum, the min-width follows the shown columns, every menu column has a width, the Devices table is fixed and the cards are unchanged.`);
