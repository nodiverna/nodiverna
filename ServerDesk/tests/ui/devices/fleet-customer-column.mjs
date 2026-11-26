// The "Kunde" column of the fleet overview. Pure parts (stored column
// selection, sort, search text, CSV) and the real FleetView rendered statically,
// with one customer (customerColumn false) and with several customers (true).
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {de} from '../../support/i18n-stubs.mjs';
const require=createRequire(import.meta.url),root=process.cwd(),cache=new Map();
let layout='table';
// The layout is local UI state; the shim lets the same render show cards.
const react={...React,useState:initial=>React.useState(initial==='table'?layout:initial)};
const empty=()=>null,asDefault=component=>({__esModule:true,default:component});
// Radix menus render into a portal only when open; the stub renders every part
// inline, so the static markup contains the column menu and its switches.
const part=name=>Object.assign(({children,checked})=>React.createElement('div',{'data-part':name,...(checked===undefined?{}:{'data-checked':String(checked)})},children),{displayName:'DropdownMenu.'+name});
const radix={...require('radix-ui'),DropdownMenu:new Proxy({},{get:(_target,name)=>part(String(name))})};
function load(filename){
 const absolute=path.resolve(filename);if(absolute===germanLocalePath)return germanLocale;if(cache.has(absolute))return cache.get(absolute).exports;if(absolute.endsWith('.css'))return {};
 const mod={exports:{}};cache.set(absolute,mod);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 function localRequire(id){
  if(id==='react')return react;
  if(id==='radix-ui')return radix;
  if(id==='sonner')return {toast:{error(){},success(){}}};
  if(id==='@/ui/devices/fleet/fleet-agent-updates')return {FleetAgentUpdates:({children})=>children,FleetAgentUpdateToolbar:empty,FleetAgentUpdateCell:empty};
  if(id==='@/ui/devices/history/history'||id==='@/ui/devices/fleet/fleet-export')return asDefault(empty);
  if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),candidate=[base,base+'.ts',base+'.tsx',base+'/index.ts',base+'/index.tsx'].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());if(candidate)return load(candidate);}
  return require(id);
 }
 new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
}
const {defaultFleetColumns,parseFleetColumns,fleetSearchText,fleetSearchPlaceholder,availableFleetColumns,fleetColumnNames,customerColumnDistinguishes}=load('ui/devices/fleet/fleet-columns.ts');
const {compareFleetDevices,fleetSortState,nextFleetSort}=load('ui/devices/fleet/fleet-sort.ts');
const {fleetCsv}=load('ui/devices/fleet/fleet-csv.ts');
const {default:FleetView,DeviceCard}=load('ui/devices/fleet/fleet.tsx');

// ---- Default and stored selections --------------------------------------
const today={group:true,description:false,tags:false,os:false,manufacturer:false,cpu:true,memory:true,disk:true,agent:false,osSupport:false,bitlocker:false,diskHealth:false,ssdWear:false,battery:false};
assert.deepEqual(defaultFleetColumns,{customer:true,...today},'customer is on by default, the rest unchanged');
const old={group:false,os:true,cpu:true,memory:true,disk:true,agent:false};
assert.deepEqual(parseFleetColumns(old),{...old,customer:true,description:false,tags:false,manufacturer:false,osSupport:false,bitlocker:false,diskHealth:false,ssdWear:false,battery:false},'an old selection keeps its values and gets customer:true (and the later description, tags and health signal columns off)');
assert.deepEqual(parseFleetColumns({...old,customer:false}),{...old,customer:false,description:false,tags:false,manufacturer:false,osSupport:false,bitlocker:false,diskHealth:false,ssdWear:false,battery:false},'customer:false stays');
assert.deepEqual(parseFleetColumns({...old,customer:false,osSupport:true,bitlocker:true,health:false}),{...old,customer:false,description:false,tags:false,manufacturer:false,osSupport:true,bitlocker:true,diskHealth:false,ssdWear:false,battery:false},'stored health signal columns stay; a stored health key is ignored');
for(const stored of [null,undefined,'text',42,{customer:'x'},{group:'no',customer:1}])assert.deepEqual(parseFleetColumns(stored),defaultFleetColumns,`${JSON.stringify(stored)} falls back to the defaults`);
assert.deepEqual(parseFleetColumns({cpu:false,os:'yes'}),{...defaultFleetColumns,cpu:false},'non-booleans fall back per key');
assert.deepEqual(availableFleetColumns(true,true),['customer','group','description','tags','os','manufacturer','cpu','memory','disk','agent','osSupport','bitlocker','diskHealth','ssdWear','battery'],'Kunde first, before Gruppe');
assert.deepEqual(availableFleetColumns(false,true),['group','description','tags','os','manufacturer','cpu','memory','disk','agent','osSupport','bitlocker','diskHealth','ssdWear','battery'],'no Kunde without the column');
assert.equal(de(fleetColumnNames.customer),'Kunde');
assert.equal(fleetSearchPlaceholder(true),'Name, IP, Kunde oder Tag');
assert.equal(fleetSearchPlaceholder(false),'Name, IP, Gruppe oder Tag');
const fleet=fs.readFileSync('ui/devices/fleet/fleet.tsx','utf8');
assert.match(fleet,/read\('serverdesk\.redesign\.columns',defaultFleetColumns,parseFleetColumns\)/,'fleet.tsx reads the selection through parseFleetColumns');
assert.doesNotMatch(fleet,/Object\.fromEntries\(Object\.entries\(default/,'fleet.tsx has no own validator');

// ---- Where the column distinguishes ----------------------
assert.equal(customerColumnDistinguishes([{customerId:'c1'},{customerId:'c2'}]),true,'two customer ids');
assert.equal(customerColumnDistinguishes([{customerId:'c1'},{customerId:'c1',customerName:'Kunde A'}]),false,'one customer id');
assert.equal(customerColumnDistinguishes([{customerName:' Kunde A '},{customerName:'Kunde B'}]),true,'the trimmed name when there is no id');
assert.equal(customerColumnDistinguishes([{customerName:'Kunde A'},{customerName:' Kunde A'}]),false,'the same trimmed name is one customer');
assert.equal(customerColumnDistinguishes([{customerId:'c1'},{},{customerName:'  '}]),false,'devices without a customer are ignored');
assert.equal(customerColumnDistinguishes([]),false,'no devices');
assert.equal(customerColumnDistinguishes([{},{}]),false,'none has a customer');

// ---- Sorting -------------------------------------------------------------
const now=Date.parse('2026-10-23T08:00:00.000Z');
// FleetView, its rows and DeviceCard read the console clock (ui/base/clock-store.ts); it stands at now.
load('ui/base/clock-store.ts').consoleClock.set(now);
const device=(id,name,changes={})=>({id,name,createdAt:now-86400000,lastSeen:now-30000,revoked:0,management:0,snapshot:null,permissions:['view'],...changes});
const sortList=[device('1','PC-1',{customerName:'Kunde 10'}),device('2','PC-2',{customerName:'kunde 2'}),device('3','PC-3'),device('4','PC-4',{customerName:'Kunde 2'}),device('5','PC-0',{customerName:'  '}),device('6','PC-5',{customerName:' Alpha '})];
const order=sort=>[...sortList].sort((a,b)=>compareFleetDevices(a,b,sort,now)).map(server=>server.name);
assert.deepEqual(order('customer'),['PC-5','PC-2','PC-4','PC-1','PC-0','PC-3'],'natural, case-insensitive, trimmed, ties by name, missing last');
assert.deepEqual(order('customer:desc'),['PC-1','PC-2','PC-4','PC-5','PC-0','PC-3'],'descending keeps missing names last and ties by name');
assert.deepEqual(fleetSortState('customer'),{key:'customer',direction:'asc'});
assert.equal(nextFleetSort('name','customer'),'customer:asc');
assert.equal(nextFleetSort('customer:asc','customer'),'customer:desc');
assert.equal(nextFleetSort('customer:desc','customer'),'customer:asc');
assert.deepEqual([...sortList].sort((a,b)=>compareFleetDevices(a,b,'customer',now)).filter(server=>server.customerName==='Kunde 2'||server.customerName==='kunde 2').map(server=>server.id),['2','4'],'equal names (case-insensitive) fall back to the device name');

// ---- Search text ---------------------------------------------------------
assert.ok(fleetSearchText(device('x','SRV-X',{customerName:'Kunde B',groupName:'Berlin'})).includes('kunde b'),'search text contains the customer name');
assert.ok(fleetSearchText(device('x','SRV-X',{groupName:'Berlin'})).includes('berlin'));
assert.match(fleet,/fleetSearchText\(server\)\.includes\(/,'fleet.tsx searches through fleetSearchText');

// ---- CSV ----------------------------------------------------------------
const csvDevices=[device('a','SRV-A',{customerName:'Kunde B',groupName:'Berlin',lastSeen:null}),device('b','SRV-B',{lastSeen:null}),device('c','SRV-C',{customerName:'=Kunde',lastSeen:null}),device('d','SRV-D',{customerName:'@x',lastSeen:null}),device('e','SRV-E',{customerName:'a"b',lastSeen:null})];
const csvLines=fleetCsv(csvDevices,{customer:true}).slice(1).split('\r\n');
assert.equal(csvLines[0],'"Name";"Kunde";"Gruppe";"Beschreibung";"Tags";"Betriebssystem";"Gerätetyp";"Hersteller";"Modell";"Agent-Version";"Letzter Heartbeat"');
assert.equal(csvLines[1],'"SRV-A";"Kunde B";"Berlin";"";"";"";"Gerätetyp noch nicht gemeldet";"";"";"";""');
assert.equal(csvLines[2],'"SRV-B";"";"";"";"";"";"Gerätetyp noch nicht gemeldet";"";"";"";""','a missing name is an empty cell');
assert.deepEqual(csvLines.slice(3).map(line=>line.split(';')[1]),['"\'=Kunde"','"\'@x"','"a""b"'],'formulas neutralized, quotes doubled');
const plainCsv=fleetCsv(csvDevices);
assert.equal(plainCsv.slice(1).split('\r\n')[0],'"Name";"Gruppe";"Beschreibung";"Tags";"Betriebssystem";"Gerätetyp";"Hersteller";"Modell";"Agent-Version";"Letzter Heartbeat"');
assert.equal(fleetCsv(csvDevices,{customer:false}),plainCsv,'customer:false is byte for byte the old output');
assert.ok(!plainCsv.includes('Kunde B'),'without the option no customer name');
assert.match(fs.readFileSync('ui/devices/fleet/fleet-export.tsx','utf8'),/fleetCsv\(devices,\{customer\},locale\)/,'the export button passes its customer prop');

// ---- FleetView and DeviceCard -------------------------
const servers=[device('a','SRV-A',{customerName:'Kunde B',groupName:'Berlin'}),device('b','SRV-B',{customerName:'Kunde C',customerDisabled:true}),device('c','SRV-C',{customerName:''})];
const viewer={id:'owner',label:'owner@example.test',permissions:['*']};
const noop=()=>{};
const render=customerColumn=>renderToStaticMarkup(React.createElement(FleetView,{header:null,servers,scoped:servers,groupEmpty:false,viewer,demo:false,saving:false,now,jobs:[],audit:[],tab:'devices',onTab:noop,canOffboard:false,onOpen:noop,onConfirm:noop,onSelectJob:noop,onCancelJob:noop,onUpdated:noop,onDemo:noop,canMove:false,onMove:noop,customerColumn}));
const headers=html=>[...html.match(/<thead>.*?<\/thead>/s)[0].matchAll(/<th scope="col"[^>]*><button[^>]*>([^<]+)</g)].map(match=>match[1]);
const menuEntries=html=>[...html.matchAll(/<div data-part="CheckboxItem"[^>]*><span>([^<]+)<\/span>/g)].map(match=>match[1]);
const row=(html,name)=>{const found=[...html.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map(match=>match[1]).find(part=>part.includes(`<strong>${name}</strong>`));assert.ok(found,`${name} is rendered`);return found;};
// The placeholders fit the search field at 1440 px: at most 26 code points in both catalogs.
for(const catalog of ['en','de']){
 const source=fs.readFileSync(`lib/i18n/messages/${catalog}.ts`,'utf8');
 for(const key of ['fleet.search','fleet.searchWithCustomer']){
  const text=source.match(new RegExp(`'${key.replaceAll('.','\\.')}': '([^']*)'`))?.[1];
  assert.ok(text,`${catalog} ${key} exists`);
  assert.ok([...text].length<=26,`${catalog} ${key} has at most 26 code points: ${text}`);
 }
}
layout='table';
{
 const html=render(false);
 assert.doesNotMatch(html,/>Kunde</,'one customer: no Kunde header, cell or menu entry');
 assert.match(html,/placeholder="Name, IP, Gruppe oder Tag"/);
 assert.deepEqual(headers(html),['Gerät','Status','Gesundheit','Gruppe','CPU','RAM','Frei','Letzte Meldung'],'default columns: Device, Status, Health, Group, CPU, RAM, Free, Last report; no Issues column');
 assert.deepEqual(menuEntries(html),['Gruppe','Beschreibung','Tags','Betriebssystem','Hersteller','CPU','RAM','Freier Speicher','Agent','Supportstatus','BitLocker','Datenträgerzustand','SSD-Verschleiß','Akku'],'one customer: the menu has no Kunde');
 assert.ok(!html.includes('Kunde B')&&!html.includes('Deaktiviert'),'one customer: no customer cell content');
}
{
 const html=render(true);
 assert.deepEqual(headers(html).slice(0,5),['Gerät','Status','Gesundheit','Kunde','Gruppe'],'Kunde before Gruppe');
 assert.match(html,/aria-label="Kunde: aufsteigend sortieren"/);
 assert.deepEqual(menuEntries(html),['Kunde','Gruppe','Beschreibung','Tags','Betriebssystem','Hersteller','CPU','RAM','Freier Speicher','Agent','Supportstatus','BitLocker','Datenträgerzustand','SSD-Verschleiß','Akku'],'menu: Kunde first, then Gruppe; Health is fixed');
 assert.match(html,/<div data-part="CheckboxItem" data-checked="true"><span>Kunde<\/span>/,'the switch shows the default on');
 assert.match(html,/placeholder="Name, IP, Kunde oder Tag"/);
 assert.match(row(html,'SRV-A'),/<td class="sdx-muted-cell"><span class="sdx-customer-cell"><span>Kunde B<\/span><\/span><\/td>/);
 assert.doesNotMatch(row(html,'SRV-A'),/Deaktiviert|title="Kunde deaktiviert"/);
 assert.match(row(html,'SRV-B'),/<td class="sdx-muted-cell"><span class="sdx-customer-cell" title="Kunde deaktiviert"><span>Kunde C<\/span><span class="sdx-tag">Deaktiviert<\/span><\/span><\/td>/);
 assert.match(row(html,'SRV-C'),/<\/td><td class="sdx-muted-cell">—<\/td><td class="sdx-muted-cell sdx-col-group">Ohne Gruppe<\/td>/,'a missing name shows —');
}
// The CSV button gets customerColumn; the column switch does not matter.
assert.match(fleet,/<FleetCsvExport devices=\{visible\} customer=\{customerColumn\}\/>/);
assert.match(fleet,/const customerDistinct=useMemo\(\(\)=>customerColumn&&customerColumnDistinguishes\(scoped\),\[customerColumn,scoped\]\);/,'the column, menu entry, card line and placeholder only where devices of two or more customers show');
assert.match(fleet,/const showCustomer=customerDistinct&&columns\.customer;/,'the column also follows its switch');
assert.match(fleet,/showCustomer&&\{\.\.\.sortable\('customer'\),label:t\('common\.customer'\),width:'var\(--sd-col-customer\)',className:'sdx-muted-cell',cell:server=><CustomerCell server=\{server\}\/>\}/,'a DataTable column with the fleet sort key');
assert.match(fleet,/import \{DataTable,FilterPopover,Toolbar,BulkBar,type DataColumn\} from '@\/ui\/kit\/data-table';/);assert.doesNotMatch(fleet,/function SortHead\(|<table/,'no local SortHead and no own table');assert.equal(de('common.customer'),'Kunde');
assert.match(fleet,/availableFleetColumns\(customerDistinct,groupShows\)/,'the menu entry');
assert.match(fleet,/placeholder:fleetSearchPlaceholder\(customerDistinct,locale\)/,'the placeholder');
assert.match(fleet,/customer=\{customerDistinct\}/,'the card line');
assert.match(fs.readFileSync('ui/shell/console.tsx','utf8'),/customerColumn=\{!demo&&data\?\.multipleCustomers===true\}/,'console: only live data with several customers, never in demo mode');

layout='cards';
{
 const card=(html,name)=>{const found=[...html.matchAll(/<article\b[^>]*>(.*?)<\/article>/g)].map(match=>match[1]).find(part=>part.includes(`<strong>${name}</strong>`));assert.ok(found,`${name} card`);return found;};
 const on=render(true),off=render(false);
 assert.match(card(on,'SRV-A'),/<\/header><p class="sdx-device-card-customer"><svg(?=[^>]*aria-hidden="true")(?=[^>]*lucide-building2)[^>]*>.*?<\/svg><span><span class="sr-only">Kunde: <\/span>Kunde B<\/span><\/p><div class="sdx-device-card-status">/,'card line between header and status');
 assert.match(card(on,'SRV-B'),/<span class="sr-only">Kunde: <\/span>Kunde C<\/span><span class="sdx-tag">Deaktiviert<\/span><\/p>/);
 assert.doesNotMatch(off,/sdx-device-card-customer|Kunde: /,'one customer: no card line');
}
const props={now,selectable:false,selected:false,draggable:false,onDragStart:noop,onSelect:noop,onOpen:noop,menu:null};
assert.match(renderToStaticMarkup(React.createElement(DeviceCard,{...props,server:servers[1],customer:true})),/Kunde: <\/span>Kunde C<\/span><span class="sdx-tag">Deaktiviert<\/span>/);
assert.doesNotMatch(renderToStaticMarkup(React.createElement(DeviceCard,{...props,server:servers[1],customer:false})),/Kunde/);

// The shared scope tabs (ui/devices/fleet/fleet-scope.ts): Geräte, Monitoring and Historie on every scope; the
// Configuration tab only when the console passes one of its pages (root and groups).
{
 layout='table';
 const view=changes=>renderToStaticMarkup(React.createElement(FleetView,{header:null,servers,scoped:servers,groupEmpty:false,viewer,demo:false,saving:false,now,jobs:[],audit:[],tab:'devices',onTab:noop,canOffboard:false,onOpen:noop,onConfirm:noop,onSelectJob:noop,onCancelJob:noop,onUpdated:noop,onDemo:noop,canMove:false,onMove:noop,customerColumn:false,...changes}));
 const tabs=html=>[...html.match(/<div role="tablist"[^>]*>.*?<\/div>/s)[0].matchAll(/<span>([^<]+)<\/span>/g)].map(match=>match[1]);
 assert.deepEqual(tabs(view({})),['Geräte','Monitoring','Inventar','Historie'],'customer view: exactly the shared tabs');
 assert.deepEqual(tabs(view({permissions:React.createElement('section'),settings:React.createElement('section')})),['Geräte','Monitoring','Inventar','Historie','Konfiguration'],'groups: the shared tabs, then Configuration with permissions and settings');
 assert.match(view({}),/<span>Geräte<\/span><b>3<\/b>/,'the device count on the Geräte tab');
 // A customer without devices, seen by a viewer who cannot add devices: its own empty state without an action; other servers do not matter.
 const none=view({scoped:[],customerEmpty:true});
 assert.match(none,/<strong>Dieser Kunde hat noch keine Geräte<\/strong><p>Füge ein Gerät für diesen Kunden hinzu, damit es hier erscheint\.<\/p><\/div>/);
 assert.doesNotMatch(none,/Filter zurücksetzen|Beispielgeräte/,'no action');
 // A filter without match in a customer with devices keeps the filter empty state, and the foot counts the customer's devices.
 assert.match(view({scoped:servers.slice(0,2),customerEmpty:false}),/<div class="sdx-table-foot"><p>2 von 2 Geräten<\/p><\/div>/);
}

// Card line style: tokens only, --sd-muted at 12px.
const css=fs.readFileSync('ui/styles/console.css','utf8'),rule=css.match(/\.sdx-device-card-customer \{([^}]*)\}/)[1];
assert.match(rule,/color: var\(--sd-muted\)/);assert.match(rule,/font-size: 12px/);
for(const block of css.match(/\.sdx-(?:device-card-customer|customer-cell)[^{]*\{[^}]*\}/g))assert.doesNotMatch(block,/#[0-9a-f]{3,8}\b|rgba?\(/i,'no raw colors');

// ---- Scope views: the column, menu entry, card line and placeholder only where they distinguish ----
{
 const mixed=[device('a','SRV-A',{customerId:'c1',customerName:'Kunde B'}),device('b','SRV-B',{customerId:'c2',customerName:'Kunde C'})];
 const single=[device('a','SRV-A',{customerId:'c1',customerName:'Kunde B'}),device('b','SRV-B',{customerId:'c1',customerName:'Kunde B'})];
 const view=(scoped,scope,cards=false)=>{layout=cards?'cards':'table';const html=renderToStaticMarkup(React.createElement(FleetView,{header:null,servers:mixed,scoped,groupEmpty:false,viewer,demo:false,saving:false,now,jobs:[],audit:[],tab:'devices',onTab:noop,canOffboard:false,onOpen:noop,onConfirm:noop,onSelectJob:noop,onCancelJob:noop,onUpdated:noop,onDemo:noop,canMove:false,onMove:noop,customerColumn:true,scope}));layout='table';return html;};
 const hidden=(html,cards,what)=>{
  assert.ok(!headers(html).includes('Kunde'),what+': no Kunde th');
  assert.ok(!menuEntries(html).includes('Kunde'),what+': no menu entry');
  assert.match(html,/placeholder="Name, IP, Gruppe oder Tag"/,what+': the placeholder without the customer');
  assert.doesNotMatch(cards,/sdx-device-card-customer/,what+': no card line');
 };
 hidden(view(single,{type:'customer',id:'c1'}),view(single,{type:'customer',id:'c1'},true),'customer view');
 hidden(view(single,{type:'group',id:'g1'}),view(single,{type:'group',id:'g1'},true),'group view');
 hidden(view(single,{type:'all'}),view(single,{type:'all'},true),'All devices with one customer');
 const all=view(mixed,{type:'all'}),allCards=view(mixed,{type:'all'},true);
 assert.ok(headers(all).includes('Kunde')&&menuEntries(all).includes('Kunde'),'All devices with two customers: the column and its menu entry');
 assert.match(all,/placeholder="Name, IP, Kunde oder Tag"/,'and the placeholder with the customer');
 assert.match(allCards,/sdx-device-card-customer/,'and the card line');
 // The CSV keeps its Customer column whenever customerColumn is true, also with one customer.
 assert.ok(fleetCsv(single,{customer:true}).includes('"Kunde"'),'the CSV keeps its Customer column with one customer');
}

console.log('PASS fleet customer column: stored selection, sort, search, CSV, table header and cell, column menu, card line, one-customer and demo gate.');
