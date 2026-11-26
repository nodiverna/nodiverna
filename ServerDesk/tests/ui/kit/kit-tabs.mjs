// The kit Tabs (ui/kit/tabs.tsx) and its pure helpers (ui/kit/tab-reveal.ts), rendered
// with React SSR: nav landmark with one tablist, link and button tabs, aria-selected and
// aria-current, roving tabindex, aria-controls, counts, both variants and no "More" before the first
// measurement. Then the key, overflow and fit helpers, the device area bar (ui/devices/device/device.tsx)
// with its tabpanel, and a CSS guard for the density of the underline variant (ui/styles/console.css). No browser, no server.
import {mock} from '../../support/register.mjs';
// Loaded before the hooks of register.mjs, so this is the real package. The mock renders the
// dropdown menu in place: React's static renderer leaves portals empty.
import * as radix from 'radix-ui';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
mock('radix-ui',{...radix,DropdownMenu:{...radix.DropdownMenu,Portal:({children})=>children}});
const {Tabs,tabId}=await import('../../../ui/kit/tabs.tsx');
const {Menu}=await import('../../../ui/kit/kit.tsx');
const {tabKeyTarget,stripOverflow,fittingTabs,hiddenTabs}=await import('../../../ui/kit/tab-reveal.ts');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {default:DeviceView,deviceTabs,visibleDeviceTabs}=await import('../../../ui/devices/device/device.tsx');
const {demoData}=await import('../../../ui/shell/demo.ts');
const {consoleRouteHash}=await import('../../../lib/console-route.ts');
const en=(await import('../../../lib/i18n/messages/en.ts')).default;
const de=(await import('../../../lib/i18n/messages/de.ts')).default;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const noop=()=>{};
const Icon=({size})=>h('i',{'data-size':size,'aria-hidden':true});
const tags=(html,pattern)=>[...html.matchAll(pattern)].map(match=>match[0]);
const attr=(tag,name)=>tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]??null;
const tabTags=html=>tags(html,/<(?:a|button)\b[^>]*role="tab"[^>]*>/g);

// ---- Link tabs, underline variant (the default) ----
const links=[
 {id:'overview',label:'Overview',icon:Icon,href:'#/device/a/overview',shortcut:'1',title:'Overview (1)'},
 {id:'hardware',label:'Hardware',icon:Icon,href:'#/device/a/hardware',shortcut:'2'},
 {id:'alerts',label:'Alert rules',href:'#/device/a/overview',count:3,tone:'warning'},
];
let html=render(h(Tabs,{items:links,value:'hardware',onChange:noop,label:'Device areas',panelId:'panel-a'}));
ok(html.startsWith('<nav class="sdx-tabbar sdx-tabs" aria-label="Device areas" data-mode="scroll">'),'a nav landmark with the bar label, underline variant, scroll mode, no fade before measurement');
ok(/<div role="tablist" aria-label="Device areas" class="sdx-tablist">/.test(html),'one tablist inside the nav');
let tabs=tabTags(html);
check(tabs.length,3,'every item is a tab');
check(tabs.map(tag=>tag.slice(1,tag.indexOf(' '))),['a','a','a'],'items with href render as links');
check(tabs.map(tag=>attr(tag,'id')),[tabId('panel-a','overview'),tabId('panel-a','hardware'),tabId('panel-a','alerts')],'stable ids from the panel id');
check(tabId('panel-a','overview'),'panel-a-tab-overview','tabId joins base and id');
check(tabs.map(tag=>attr(tag,'href')),['#/device/a/overview','#/device/a/hardware','#/device/a/overview'],'hrefs stay');
check(tabs.map(tag=>attr(tag,'aria-selected')),['false','true','false'],'aria-selected on every tab');
check(tabs.map(tag=>attr(tag,'aria-current')),[null,'page',null],'aria-current="page" only on the active link');
check(tabs.map(tag=>attr(tag,'tabindex')),['-1','0','-1'],'roving focus: only the active tab is a Tab stop');
check(tabs.map(tag=>attr(tag,'aria-controls')),[null,'panel-a',null],'the active tab controls the panel');
check(tabs.map(tag=>attr(tag,'aria-keyshortcuts')),['1','2',null],'shortcuts as aria-keyshortcuts');
check(attr(tabs[0],'title'),'Overview (1)','the shortcut hint stays a native title');
ok(tabs[1].includes('class="sdx-tab active"')&&tabs[0].includes('class="sdx-tab"'),'the active tab carries the active class');
ok(html.includes('<b class="sdx-count-warning">3</b>'),'a count with its tone, like in Segmented');
ok(html.includes('aria-keyshortcuts="1"><span>Overview</span>')&&!html.includes('<i data-size')&&!html.includes('<svg'),'the label only: Tabs renders no icon, not even for an item that still carries one');
ok(!html.includes('sdx-tabs-more')&&!html.includes('aria-haspopup'),'no "More" before the first measurement');

// ---- Button tabs, pill variant, menu overflow, no panel ----
const plain=[{id:'all',label:'All',count:12},{id:'online',label:'Online',count:10,tone:'online'},{id:'offline',label:'Offline',count:2}];
html=render(h(Tabs,{items:plain,value:'all',onChange:noop,label:'Status',variant:'pill',overflow:'menu',className:'extra'}));
ok(html.startsWith('<nav class="sdx-tabbar sdx-tabbar-pill extra" aria-label="Status" data-mode="menu">'),'pill variant with its own class and the caller class');
tabs=tabTags(html);
check(tabs.map(tag=>tag.slice(1,tag.indexOf(' '))),['button','button','button'],'items without href render as buttons');
ok(tabs.every(tag=>attr(tag,'type')==='button'),'type="button"');
check(tabs.map(tag=>attr(tag,'aria-current')),[null,null,null],'buttons never carry aria-current');
check(tabs.map(tag=>attr(tag,'aria-controls')),[null,null,null],'without panelId no aria-controls');
check(tabs.map(tag=>attr(tag,'tabindex')),['0','-1','-1'],'one Tab stop');
ok(new Set(tabs.map(tag=>attr(tag,'id'))).size===3&&tabs.every(tag=>/-tab-(all|online|offline)$/.test(attr(tag,'id'))),'generated ids are unique and name the item');
ok(html.includes('<b class="sdx-count-online">10</b>')&&html.includes('<b>12</b>'),'counts with and without tone');
ok(!html.includes('sdx-tabs-more'),'menu overflow: all tabs in one row, no "More" before measurement');

// ---- Click and keyboard (source of the handlers) ----
{
 const source=readFileSync('ui/kit/tabs.tsx','utf8');
 ok(/if\(item\.href&&\(event\.button!==0\|\|event\.ctrlKey\|\|event\.metaKey\|\|event\.shiftKey\|\|event\.altKey\)\)return;\s*event\.preventDefault\(\);activate\(item\);/.test(source),'a plain left click activates and prevents the default; modified or non-left clicks keep the browser default');
 ok(/if\(event\.key===' '&&tabs\[index\]\.tagName==='A'\)\{event\.preventDefault\(\);/.test(source),'Space activates a link tab');
 ok(/const target=tabKeyTarget\(event\.key,index,tabs\.length\);[\s\S]{0,80}tabs\[target\]\.focus\(\{preventScroll:true\}\);/.test(source),'arrows move the focus only (manual activation)');
 ok(!/onFocus:\(\)=>[^,]*onChange/.test(source),'focus never activates');
 ok(/inMenu\.length>0&&<Menu /.test(source),'"More" is a kit Menu, rendered only when tabs are out of sight');
 ok(/aria-label=\{activeInMenu\?t\('kit\.tabs\.moreActive',\{label:activeLabel\}\):undefined\}/.test(source),'"More" names the active tab when it is in the menu');
 ok(/data-fade-start=\{scroll\?\.start\|\|undefined\} data-fade-end=\{scroll\?\.end\|\|undefined\}/.test(source),'the fades are data attributes from stripOverflow');
}

// ---- tabKeyTarget ----
check([tabKeyTarget('ArrowRight',0,4),tabKeyTarget('ArrowRight',3,4)],[1,0],'ArrowRight moves on and wraps');
check([tabKeyTarget('ArrowLeft',2,4),tabKeyTarget('ArrowLeft',0,4)],[1,3],'ArrowLeft moves back and wraps');
check([tabKeyTarget('Home',2,4),tabKeyTarget('End',1,4)],[0,3],'Home and End');
check([tabKeyTarget('Enter',1,4),tabKeyTarget(' ',1,4),tabKeyTarget('a',1,4),tabKeyTarget('ArrowDown',1,4),tabKeyTarget('ArrowRight',0,0)],[null,null,null,null,null],'other keys and an empty list give null');

// ---- stripOverflow ----
check(stripOverflow({scrollLeft:0,clientWidth:400,scrollWidth:400}),{start:false,end:false},'everything fits');
check(stripOverflow({scrollLeft:0,clientWidth:390,scrollWidth:900}),{start:false,end:true},'cut at the end');
check(stripOverflow({scrollLeft:510,clientWidth:390,scrollWidth:900}),{start:true,end:false},'scrolled to the end: cut at the start');
check(stripOverflow({scrollLeft:200,clientWidth:390,scrollWidth:900}),{start:true,end:true},'both edges');
check(stripOverflow({scrollLeft:0.6,clientWidth:390,scrollWidth:390.8}),{start:false,end:false},'1px of tolerance');
check(stripOverflow({scrollLeft:1.5,clientWidth:390,scrollWidth:393}),{start:true,end:true},'more than 1px counts');

// ---- hiddenTabs ----
const row=[{offsetLeft:12,offsetWidth:100},{offsetLeft:114,offsetWidth:100},{offsetLeft:216,offsetWidth:100},{offsetLeft:318,offsetWidth:100}];
check(hiddenTabs(row,{scrollLeft:0,clientWidth:500}),[],'all visible');
check(hiddenTabs(row,{scrollLeft:0,clientWidth:320}),[3],'the tab cut at the end');
check(hiddenTabs(row,{scrollLeft:120,clientWidth:300}),[0,1],'the tabs cut at the start, in order');
check(hiddenTabs(row,{scrollLeft:0,clientWidth:417.5}),[],'1px of tolerance');

// ---- fittingTabs ----
check(fittingTabs([100,100,100],300,80),3,'all fit: no room for "More" needed');
check(fittingTabs([100,100,100],299.5,80),3,'sub-pixel slack');
check(fittingTabs([100,100,100,100],300,80),2,'some fit next to "More"');
check(fittingTabs([100,120,90],250,80),1,'widths differ');
check(fittingTabs([200,200],150,80),0,'none fit');
check(fittingTabs([],100,80),0,'no tabs');
check(fittingTabs([],-16,80),0,'no tabs in a bar without room (hidden)');
// The room of the row with "More" can differ from the full row's (the underline bar at ≤900px pads 12px without and
// 4px with it): the full row decides whether all fit, the row with "More" how many fit next to it.
check(fittingTabs([80,76,61,60,91],362,90,370),4,'not all fit in the full row (362px): four fit next to "More" in its own room (370px)');
check(fittingTabs([80,76,61,60,91],362,90),3,'without a separate room the full row\'s room applies');
check(fittingTabs([80,76,61,60,91],368,66,376),5,'all fit in the full row: no "More"');
check(fittingTabs([100,100],150,10,400),1,'next to "More" never all tabs: the answer keeps "More" it was given for');

// ---- The device area bar ----
const {servers}=demoData();
const viewer={id:'owner',label:'owner',permissions:['*']};
// A device without a detected server role has the 10 base areas (Configuration with the role assignment right and its
// element); the Extensions tab is checked below.
const roleless=servers.find(server=>visibleDeviceTabs(server,viewer).length===deviceTabs.length),roleServer=servers.find(server=>visibleDeviceTabs(server,viewer).length>deviceTabs.length);
const deviceProps=(patch={})=>({server:roleless,servers,viewer,demo:true,saving:false,now:Date.now(),section:'overview',onSection:noop,samples:[],historyLoading:false,jobs:[],audit:[],crumbs:[],
 onConfirm:noop,onSelectJob:noop,onCancelJob:noop,canOffboard:false,permissions:h('div',null,'perms'),...patch});
const areaBar=markup=>{const start=markup.indexOf(`<nav class="sdx-tabbar sdx-tabs" aria-label="${en['device.areas']}"`);return start<0?'':markup.slice(start,markup.indexOf('</nav>',start)+6);};
html=render(h(DeviceView,deviceProps()));
const bar=areaBar(html);
ok(bar.length>100,'the device page renders the area bar as kit Tabs');
tabs=tabTags(bar);
check(tabs.length,10,'the 10 areas of a device without a server role: no Alert rules, Assistant or Permissions tab');
check(tabs.map(tag=>attr(tag,'aria-keyshortcuts')),['1','2','3','4','5','6','7','8',null,null],'aria-keyshortcuts 1–8; Monitoring and Configuration have no number key');
check(tabs.map(tag=>attr(tag,'href')),deviceTabs.map(tab=>consoleRouteHash({view:'device',deviceId:roleless.id,deviceSection:tab.id})),'hrefs unchanged');
check(attr(tabs[0],'title'),'Overview (1)','the shortcut title stays');
check([attr(tabs[8],'title'),attr(tabs[9],'title')],[null,null],'Monitoring and Configuration have no shortcut title');
check(tabs.map(tag=>attr(tag,'aria-selected')),['true',...Array(9).fill('false')],'Overview is selected');
check(tabTags(areaBar(render(h(DeviceView,deviceProps({permissions:undefined}))))).length,9,'without the Permissions element there is no Configuration tab');
ok(!/<svg/.test(bar),'the area tabs carry no icons');
let body=html.match(/<div class="sdx-device-body"[^>]*>/)?.[0]??'';
check([attr(body,'id'),attr(body,'role'),attr(body,'aria-labelledby')],['sdx-device-panel','tabpanel','sdx-device-panel-tab-overview'],'the body is the tabpanel labelled by the active tab');
check(attr(tabs[0],'aria-controls'),'sdx-device-panel','the active tab controls the body');
html=render(h(DeviceView,deviceProps({section:'configuration',alerts:h('div',null,'rules'),permissions:h('div',null,'perms')})));
tabs=tabTags(areaBar(html));
check(tabs.at(-1)&&[attr(tabs.at(-1),'aria-selected'),attr(tabs.at(-1),'aria-current'),attr(tabs.at(-1),'href')],['true','page',consoleRouteHash({view:'device',deviceId:roleless.id,deviceSection:'configuration'})],'Configuration is the last area tab');
body=html.match(/<div class="sdx-device-body"[^>]*>/)?.[0]??'';
check(attr(body,'aria-labelledby'),'sdx-device-panel-tab-configuration','the body follows the Configuration tab');
ok(html.includes('<div>perms</div>')&&!html.includes('<div>rules</div>'),'Configuration shows Permissions only');
html=render(h(DeviceView,deviceProps({section:'monitoring',detail:{deviceDetail:'alert-rules'},alerts:h('div',null,'rules')})));
tabs=tabTags(areaBar(html));
check(tabs.at(-2)&&[attr(tabs.at(-2),'aria-selected'),attr(tabs.at(-2),'href')],['true',consoleRouteHash({view:'device',deviceId:roleless.id,deviceSection:'monitoring'})],'Monitoring comes before Configuration');
ok(html.includes('<div>rules</div>'),'Monitoring › Alert rules shows the alert rules');
html=render(h(DeviceView,deviceProps({server:roleServer,section:'extensions'})));
tabs=tabTags(areaBar(html));
check(tabs.length,11,'a device with a detected server role gets Extensions as the 9th area tab, before Monitoring');
check([attr(tabs[8],'aria-keyshortcuts'),attr(tabs[8],'href'),attr(tabs[8],'title'),attr(tabs[8],'aria-selected')],['9',consoleRouteHash({view:'device',deviceId:roleServer.id,deviceSection:'extensions'}),`${en['device.section.extensions']} (9)`,'true'],'Extensions has key 9, its link, the shortcut title and is selected');
check([attr(tabs[9],'aria-keyshortcuts'),attr(tabs[10],'aria-keyshortcuts')],[null,null],'Monitoring and Configuration stay without a key');
html=render(h(DeviceView,deviceProps()),'de');
ok(html.includes(`<nav class="sdx-tabbar sdx-tabs" aria-label="${de['device.areas']}"`),'the German bar label');

// ---- Source: device.tsx uses Tabs and keeps its behavior ----
{
 const device=readFileSync('ui/devices/device/device.tsx','utf8');
 ok(/<Tabs items=\{areaTabs\} value=\{main\} onChange=\{id=>onSection\(id as DeviceMainSection\)\} label=\{t\('device\.areas'\)\} panelId=\{devicePanelId\}\/>/.test(device),'Tabs variant underline, overflow scroll (the defaults); every area tab calls onSection');
 ok(!/\bonPanel\b|\bdevicePanel\b/.test(device),'no panel tabs any more');
 ok(!/revealScrollLeft|tabStrip/.test(device),'no reveal effect of its own');
 ok(!/<Segmented/.test(device)&&(device.match(/<Tabs variant="pill" overflow="menu"/g)??[]).length===1,'every subarea bar is the one subBar: Tabs pill with overflow menu, no Segmented');
}

// ---- Copy ----
check([en['kit.tabs.more'],en['kit.tabs.moreActive'],de['kit.tabs.more'],de['kit.tabs.moreActive']],['More','{label}, more tabs','Mehr','{label}, weitere Tabs'],'the "More" copy in both catalogs');

// ---- A state tag after the label: in the tab, in its accessible name and in the "More" entry ----
{
 const items=[{id:'files',label:'Files'},{id:'terminal',label:'Terminal'},{id:'rdp',label:'Remote Desktop',tag:'Paused',href:'#devices/a/rdp'}];
 const tagged=render(h(Tabs,{items,value:'files',onChange:noop,label:'Remote access',variant:'pill',overflow:'menu'}));
 const rdp=tagged.match(/<a\b[^>]*role="tab"[^>]*>(.*?)<\/a>/)?.[1]??'';
 ok(rdp.includes('<span>Remote Desktop</span> <span class="sdx-tag">Paused</span>'),'the tag renders as span.sdx-tag right after the label, with a space for the accessible name');
 check(rdp.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(),'Remote Desktop Paused','the tab text, and so its accessible name, includes the tag');
 check((tagged.match(/sdx-tag/g)??[]).length,1,'items without a tag render none');
 const menu=render(h(Menu,{label:'More',open:true,entries:items.map(item=>({id:item.id,label:item.label,tag:item.tag,onSelect:noop}))}));
 ok(/role="menuitem"[^>]*>(?:(?!role="menuitem").)*<span>Remote Desktop <span class="sdx-tag">Paused<\/span><\/span>/.test(menu),'the "More" menu entry shows the same tag after the label');
 check((menu.match(/sdx-tag/g)??[]).length,1,'menu entries without a tag render none');
 const source=readFileSync('ui/kit/tabs.tsx','utf8');
 ok(/const itemsKey=items\.map\(item=>\x60[^\x60]*\$\{item\.tag\?\?''\}\x60\)/.test(source),'the fit key includes the tag, so a changed tag measures the row again');
 ok(/entries=\{inMenu\.map\(item=>\(\{id:item\.id,label:item\.label,tag:item\.tag,/.test(source),'tabs in "More" keep their tag');
}
// The underline density: 8px tab padding, no gap, a 20px lead so the first label starts on the 28px
// content edge, the underline 2px wider than the label on each side; height, font and the ≤900px bar padding unchanged.
{
 const css=readFileSync('ui/styles/console.css','utf8');
 // Top-level rules start a line; the rules inside a media block are indented.
 const rule=selector=>{const at=css.indexOf('\n'+selector+' {');assert.ok(at>=0,selector);return css.slice(at,css.indexOf('}',at));};
 const tab=rule('.sdx-tabs :is(.sdx-tab, .sdx-tabs-more)');
 ok(/height: 44px;/.test(tab)&&/padding: 0 8px;/.test(tab)&&/font: 550 13px\/1 var\(--sd-font\);/.test(tab),'tab and "More": 44px high, padding 0 8px, font 550 13px');
 const list=rule('.sdx-tabs > .sdx-tablist');
 ok(/gap: 0;/.test(list)&&/padding: 0 12px 0 20px;/.test(list),'the tablist: gap 0, padding 0 12px 0 20px');
 const line=rule('.sdx-tabs :is(.sdx-tab, .sdx-tabs-more)::after');
 ok(/left: 6px; right: 6px;/.test(line)&&/height: 2px;/.test(line),'the underline: inset 6px, 2px high');
 ok(css.includes('.sdx-tabs > .sdx-tablist { padding: 0 4px 0 12px; }'),'the ≤900px bar keeps its own padding');
}
console.log(`PASS kit tabs (${checks} checks): tablist in a nav, link and button tabs, aria-selected and aria-current, roving tabindex, aria-controls, counts, variants, no "More" before measurement, key, overflow and fit helpers, the device area bar with its tabpanel, and the underline density.`);
