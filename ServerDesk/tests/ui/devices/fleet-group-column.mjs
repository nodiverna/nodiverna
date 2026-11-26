// The Group column of the Devices table (docs/customers.md): it shows only while a device of the
// scope is in a group (groupColumnShows in ui/devices/fleet/fleet-columns.ts), so an installation without groups
// no longer reads "No group" in every row. The column menu, the device card line and the sort follow
// it; the stored column choice and the CSV export keep their Group column. React SSR, no browser.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const {groupColumnShows,availableFleetColumns,defaultFleetColumns}=await import('../../../ui/devices/fleet/fleet-columns.ts');
const {compareFleetDevices,shownFleetSort,fleetTableSort}=await import('../../../ui/devices/fleet/fleet-sort.ts');
const {fleetCsv}=await import('../../../ui/devices/fleet/fleet-csv.ts');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {default:FleetView,DeviceCard,columnMenuEntries}=await import('../../../ui/devices/fleet/fleet.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const noop=()=>{};
const now=Date.UTC(2026,10,13,10,0,0);
// FleetView, its rows and DeviceCard read the console clock (ui/base/clock-store.ts); it stands at now.
(await import('../../../ui/base/clock-store.ts')).consoleClock.set(now);
const device=(id,name,extra={})=>({id,name,createdAt:now-86400000,lastSeen:now-30000,revoked:0,management:0,snapshot:null,permissions:['view'],...extra});
const viewer={id:'owner',label:'owner@example.test',permissions:['*']};

// ---- groupColumnShows ----
check(groupColumnShows([]),false,'no devices: no Group column');
check(groupColumnShows([device('a','A'),device('b','B',{groupId:null,groupName:null})]),false,'devices without a group');
check(groupColumnShows([device('a','A',{groupName:'   '}),device('b','B',{groupName:''})]),false,'a blank group name is no group');
check(groupColumnShows([device('a','A'),device('b','B',{groupId:'g1'})]),true,'one device with a groupId');
check(groupColumnShows([device('a','A'),device('b','B',{groupName:'Berlin'})]),true,'one device with a group name');
check(availableFleetColumns(true,false).includes('group'),false,'availableFleetColumns(true,false) leaves out the group');
check(availableFleetColumns(true,true).slice(0,2),['customer','group'],'with a grouped device the group follows the customer');
check(availableFleetColumns(false,false).includes('customer'),false,'the customer rule stays');

// ---- FleetView ----
const ungrouped=[device('a','SRV-A'),device('b','SRV-B'),device('c','SRV-C')];
const mixed=[device('a','SRV-A'),device('b','SRV-B',{groupId:'g1',groupName:'Berlin'}),device('c','SRV-C')];
const props={header:null,groupEmpty:false,viewer,demo:false,saving:false,now,jobs:[],audit:[],tab:'devices',onTab:noop,canOffboard:false,onOpen:noop,onConfirm:noop,onSelectJob:noop,onCancelJob:noop,onUpdated:noop,onDemo:noop,canMove:false,onMove:noop,customerColumn:false};
const fleet=(devices,locale='de')=>renderToStaticMarkup(h(LocaleProvider,{locale},h(FleetView,{...props,servers:devices,scoped:devices})));
const heads=html=>[...html.matchAll(/<th scope="col"[^>]*>(?:<button[^>]*>)?(?:<span class="sr-only">)?([^<]+)</g)].map(match=>match[1]);
let html=fleet(ungrouped);
ok(!heads(html).includes('Gruppe'),'no device in a group: no Group head');
ok(!html.includes('Ohne Gruppe')&&!html.includes('sdx-col-group'),'and no "Ohne Gruppe" cell');
ok(heads(html).includes('Gerät')&&heads(html).includes('CPU'),'the other columns stay');
html=fleet(mixed);
ok(heads(html).includes('Gruppe'),'one grouped device: the Group head shows again');
check((html.match(/<td class="sdx-muted-cell sdx-col-group">Ohne Gruppe<\/td>/g)??[]).length,2,'the other devices of the mixed scope read "Ohne Gruppe"');
ok(html.includes('<td class="sdx-muted-cell sdx-col-group">Berlin</td>'),'the grouped device shows its group');
ok(!heads(fleet(ungrouped,'en')).includes('Group')&&!fleet(ungrouped,'en').includes('No group'),'English: no Group head and no "No group"');
// The column menu offers the entry only with the column.
const t=key=>key,menuIds=keys=>columnMenuEntries(defaultFleetColumns,keys,noop,t).map(entry=>entry.id);
ok(!menuIds(availableFleetColumns(false,groupColumnShows(ungrouped))).includes('group'),'no Group entry in the column menu');
ok(menuIds(availableFleetColumns(false,groupColumnShows(mixed))).includes('group'),'the Group entry with a grouped device');
// The card footer: no group text without groups, "Ohne Gruppe" for the others in a mixed scope.
const card=(server,group)=>renderToStaticMarkup(h(LocaleProvider,{locale:'de'},h(DeviceCard,{server,now,customer:false,group,selectable:false,selected:false,draggable:false,onDragStart:noop,onSelect:noop,onOpen:noop,menu:null})));
ok(!card(ungrouped[0],false).includes('Ohne Gruppe'),'card mode without groups: no group text in the footer');
ok(card(mixed[0],true).includes('<span>Ohne Gruppe</span>')&&card(mixed[1],true).includes('<span>Berlin</span>'),'card mode with a grouped device: the group line');
const source=readFileSync(new URL('../../../ui/devices/fleet/fleet.tsx',import.meta.url),'utf8');
ok(source.includes('const groupShows=useMemo(()=>groupColumnShows(scoped),[scoped]);')&&source.includes('group={groupShows}')&&source.includes('availableFleetColumns(customerDistinct,groupShows)')&&source.includes('showGroup:groupShows'),'FleetView feeds groupColumnShows(scoped) to the table, the menu and the cards');
ok(!/write\('serverdesk\.redesign\.columns'[^)]*group/.test(source),'the stored column choice is not changed by the rule');

// ---- Sort and CSV ----
check(shownFleetSort('group:desc',false),'name','a sort by group with the column hidden sorts by name');
check(shownFleetSort('group:desc',true),'group:desc','with the column the group sort stays');
check(shownFleetSort('cpu:desc',false),'cpu:desc','other sorts stay');
check(fleetTableSort(shownFleetSort('group:asc',false)),{column:'name',direction:'asc'},'the sort head shows Device as the sorted column');
const named=[device('c','SRV-C'),device('a','SRV-A'),device('b','SRV-B')];
check([...named].sort((x,y)=>compareFleetDevices(x,y,shownFleetSort('group:asc',false),now)).map(item=>item.name),['SRV-A','SRV-B','SRV-C'],'the fleet sort by group orders by name while the column is hidden');
ok(/aria-sort="ascending"><button[^>]*>Gerät</.test(fleet(ungrouped)),'the Device head carries the sort');
const csv=fleetCsv(ungrouped,{},'en');
ok(csv.split('\r\n')[0].includes('Group'),'the CSV keeps its Group column');

console.log(`PASS fleet group column (${checks} checks): groupColumnShows, availableFleetColumns without the group, the Devices table, the column menu and the card line without groups and with one grouped device, the sort fallback to the name and the CSV Group column.`);
