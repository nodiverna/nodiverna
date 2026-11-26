// The Devices toolbar of FleetView and the kit FilterPopover, rendered statically in German.
// A hand-written loader stubs radix Popover and DropdownMenu inline (their content renders without
// opening), presets the filter state and records the state setters, so the test can read the popover
// fields and press Reset. The real FilterPopover trigger (radix) is checked with register.mjs. Also
// the agent updates trigger as a kit Btn, the notice and toolbar CSS, and the copy. No browser.
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import '../../support/register.mjs';
const require=createRequire(import.meta.url),root=process.cwd();
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const h=React.createElement;

// ---- Loader: radix stubs, preset filter state, recorded setters ----
let preset=null;const setterCalls=[];
const isFilters=value=>!!value&&typeof value==='object'&&'tagName' in value&&'filter' in value;
const react={...React,useState(initial){
 const start=isFilters(initial)&&preset?preset:initial;
 const [value,set]=React.useState(start);
 return [value,next=>{setterCalls.push({initial:start,next});set(next);}];
}};
const part=name=>Object.assign(({children,checked,className,...rest})=>name==='Trigger'||name==='Root'||name==='Portal'?children:h('div',{'data-part':name,className,...(checked===undefined?{}:{'data-checked':String(checked)}),...Object.fromEntries(Object.entries(rest).filter(([key])=>key.startsWith('aria-')))},children),{displayName:name});
const stub=()=>new Proxy({},{get:(_target,name)=>part(String(name))});
const radix={...require('radix-ui'),DropdownMenu:stub(),Popover:stub()};
const agentContext={rows:[{inspect:true,update:{version:'4.6.0'},active:false}],loading:false,busy:false,open:()=>{}};
const empty=()=>null;
function loader(){
 const cache=new Map();
 function load(filename){
  const absolute=path.resolve(filename);if(absolute===germanLocalePath)return germanLocale;if(cache.has(absolute))return cache.get(absolute).exports;if(absolute.endsWith('.css'))return {};
  const mod={exports:{}};cache.set(absolute,mod);
  const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  // The agent updates module reads its context; here it gets a fixed one with one open update.
  let own=null;
  const agentReact={...react,createContext:value=>(own=React.createContext(value)),useContext:context=>{const value=React.useContext(context);return context===own?agentContext:value;}};
  function localRequire(id){
   if(id==='react')return absolute.endsWith('fleet-agent-updates.tsx')?agentReact:react;
   if(id==='radix-ui')return radix;
   if(id==='sonner')return {toast:{error(){},success(){}}};
   if(id==='@/ui/devices/fleet/fleet-agent-updates'&&!absolute.endsWith('fleet-agent-updates.tsx'))return {FleetAgentUpdates:({children})=>children,FleetAgentUpdateToolbar:()=>h('button',{type:'button','data-agent-updates':''},'Agent-Updates'),FleetAgentUpdateCell:empty};
   if(id==='@/ui/devices/history/history')return {__esModule:true,default:empty};
   if(id==='@/ui/devices/fleet/fleet-export')return {__esModule:true,default:()=>h('button',{type:'button','data-csv':''},'CSV')};
   if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),candidate=[base,base+'.ts',base+'.tsx',base+'/index.ts',base+'/index.tsx'].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());if(candidate)return load(candidate);}
   return require(id);
  }
  new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
 }
 return load;
}
const load=loader();
const {default:FleetView,emptyFleetFilters,fleetFilterCount,columnMenuEntries}=load('ui/devices/fleet/fleet.tsx');
const {FilterPopover,DataTable}=load('ui/kit/data-table.tsx');
const {de}=await import('../../support/i18n-stubs.mjs');

const now=Date.UTC(2026,10,9,10,0,0);
// FleetView, its rows and DeviceCard read the console clock (ui/base/clock-store.ts); it stands at now.
load('ui/base/clock-store.ts').consoleClock.set(now);
const device=(id,name,changes={})=>({id,name,createdAt:now-86400000,lastSeen:now-30000,revoked:0,management:0,snapshot:null,permissions:['view'],...changes});
const servers=[device('a','SRV-A',{tags:[{name:'Rolle',value:'Web'}]}),device('b','SRV-B',{tags:[{name:'Rolle',value:'SQL'}]}),device('c','SRV-C')];
const viewer={id:'owner',label:'owner@example.test',permissions:['*']};
const noop=()=>{};
const props={header:null,servers,scoped:servers,groupEmpty:false,viewer,demo:false,saving:false,now,jobs:[],audit:[],tab:'devices',onTab:noop,canOffboard:false,onOpen:noop,onConfirm:noop,onSelectJob:noop,onCancelJob:noop,onUpdated:noop,onDemo:noop,canMove:false,onMove:noop,customerColumn:false};
const render=(filters=null)=>{preset=filters;const html=renderToStaticMarkup(h(FleetView,props));preset=null;return html;};
const find=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(Array.isArray(node)){for(const child of node){const found=find(child,predicate);if(found)return found;}return null;}if(predicate(node))return node;for(const value of Object.values(node.props??{})){const found=typeof value==='object'?find(value,predicate):null;if(found)return found;}return null;};
const tree=(filters=null)=>{preset=filters;let built;renderToStaticMarkup(h(()=>{built=FleetView.type(props);return null;}));preset=null;return built;};
const attr=(tag,name)=>tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]??null;

// ---- Toolbar structure ----
let html=render();
const toolbar=html.match(/<div class="sdx-toolbar sdx-fleet-toolbar">(.*?)<div class="sdx-table-wrap"/s)?.[1];
ok(toolbar,'the kit Toolbar with the fleet class sits above the table');
const search=toolbar.match(/<label class="sdx-searchfield sdx-toolbar-search">.*?<input[^>]*>/s)[0].match(/<input[^>]*>/)[0];
check([attr(search,'id'),attr(search,'aria-keyshortcuts'),attr(search,'aria-label'),attr(search,'placeholder')],['sdx-fleet-search','/','Geräte filtern','Name, IP, Gruppe oder Tag'],'search: id, the / shortcut, its label and the placeholder');
const filters=toolbar.match(/<div class="sdx-toolbar-filters">(.*?)<\/div><span class="sdx-toolbar-spacer"><\/span>/s)?.[1];
ok(filters&&filters.startsWith('<div class="sdx-segmented sdx-segmented-sm" role="group" aria-label="Status">'),'filters: the status Segmented first');
ok(/<b class="sdx-count-online">3<\/b>/.test(filters)&&/<b class="sdx-count-offline">0<\/b>/.test(filters),'the status keeps its counts and tones');
ok(/<button type="button" class="sdx-btn sdx-btn-secondary sdx-btn-sm sdx-filter-trigger"[^>]*><svg[^>]*lucide-sliders-horizontal[^>]*>.*?<\/svg><span>Filter<\/span><\/button>/s.test(filters),'then the FilterPopover trigger: a small kit Btn with SlidersHorizontal and the text "Filter", no badge without filters');
const actions=toolbar.match(/<div class="sdx-toolbar-actions">(.*)$/s)[1];
const order=['data-csv','data-agent-updates','aria-label="Spalten auswählen"','aria-label="Darstellung"'].map(marker=>actions.indexOf(marker));
ok(order.every((index,position)=>index>=0&&(position===0||index>order[position-1])),'actions: CSV, agent updates, column menu, layout switch');
ok(!/<select/.test(toolbar.replace(/<div data-part="Content".*$/s,'')),'no select outside the popover');

// ---- Popover content ----
const content=toolbar.match(/<div data-part="Content" class="sdx-layer sdx-menu sdx-filter-popover" aria-labelledby="([^"]+)">(.*?)<\/div><\/div><span class="sdx-toolbar-spacer">/s);
ok(content,'the content is the menu surface, labelled');
ok(content[2].startsWith(`<h2 id="${content[1]}" class="sdx-filter-popover-title">Geräte filtern</h2>`),'its title "Geräte filtern" names it');
// The kit Select (sdx-select, md) inside its Field: the label's for is the select's id.
const fields=html=>[...html.matchAll(/<label class="sdx-field-label" for="([^"]+)">([^<]+)<\/label><select class="sdx-select" id="([^"]+)"/g)].map(match=>({label:match[2],bound:match[1]===match[3]}));
check(fields(content[2]).map(field=>field.label),['Gerätetyp','Zustand','Nach Tag filtern'],'type, state and tag as labelled Fields');
ok(fields(content[2]).every(field=>field.bound),'each label is bound to its select');
ok(!/<select/.test(fs.readFileSync('ui/devices/fleet/fleet.tsx','utf8')),'fleet.tsx has no native <select literal: the popover fields are kit Selects');
ok(!content[2].includes('Filter zurücksetzen'),'no reset without filters');
ok(/<option value="health-critical">Gesundheit: kritisch<\/option>/.test(content[2])&&/<option value="Rolle">Rolle<\/option>/.test(content[2]),'the state and tag options are unchanged');
html=render({type:'server',filter:'all',tagName:'Rolle',tagValue:null});
check(fields(html).map(field=>field.label),['Gerätetyp','Zustand','Nach Tag filtern','Tag-Wert'],'the tag value only while a tag is chosen');
ok(/<span>Filter<b class="sdx-btn-count" aria-hidden="true">2<\/b><\/span>/.test(html)&&html.includes('aria-label="Filter, 2 aktiv"'),'two filters: the badge 2 and the name "Filter, 2 aktiv"');
ok(/<div class="sdx-filter-popover-foot"><button type="button" class="sdx-btn sdx-btn-ghost sdx-btn-sm"[^>]*>.*?<span>Filter zurücksetzen<\/span><\/button><\/div>/s.test(html),'with filters the ghost reset button shows');

// ---- Count and reset ----
check([fleetFilterCount(emptyFleetFilters,''),fleetFilterCount({type:'server',filter:'all'},''),fleetFilterCount({type:'server',filter:'crashes'},''),fleetFilterCount({type:'all',filter:'all'},'Rolle'),fleetFilterCount({type:'client',filter:'battery'},'Rolle')],[0,1,2,1,3],'type, state and a chosen tag count one each; the tag value counts with its tag');
{
 setterCalls.length=0;
 const chosen={type:'server',filter:'crashes',tagName:'Rolle',tagValue:'Web'};
 const built=tree(chosen);
 const popover=find(built,node=>node.type===FilterPopover);
 check([popover.props.active,popover.props.activeLabel,popover.props.label,popover.props.title,popover.props.resetLabel],[3,'Filter, 3 aktiv','Filter','Geräte filtern','Filter zurücksetzen'],'the popover props');
 setterCalls.length=0;popover.props.onReset();
 check(setterCalls.map(call=>[call.initial===chosen,call.next]),[[true,emptyFleetFilters]],'Reset sets type, state, tag and value back in one call and leaves search and status');
 setterCalls.length=0;
 find(built,node=>node.type===DataTable).props.empty.action.props.onClick();
 check(setterCalls.map(call=>call.next),['','all',emptyFleetFilters],'the empty-state "Filter zurücksetzen" still resets search, status and the popover filters');
}

// ---- The real trigger (radix Popover) ----
{
 const {FilterPopover:Real}=await import('../../../ui/kit/data-table.tsx');
 const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
 const trigger=active=>renderToStaticMarkup(h(LocaleProvider,{locale:'de'},h(Real,{label:'Filter',title:'Geräte filtern',active,activeLabel:`Filter, ${active} aktiv`,onReset:noop,resetLabel:'Filter zurücksetzen'},h('select'))));
 const two=trigger(2).match(/<button[^>]*>/)[0];
 check([attr(two,'aria-haspopup'),attr(two,'aria-expanded'),attr(two,'aria-label')],['dialog','false','Filter, 2 aktiv'],'trigger: aria-haspopup dialog, aria-expanded and the name "Filter, 2 aktiv"');
 ok(attr(two,'aria-label').startsWith('Filter'),'the accessible name starts with the visible text');
 const none=trigger(0).match(/<button[^>]*>/)[0];
 check(attr(none,'aria-label'),null,'without filters the visible text is the name');
 ok(!trigger(2).includes('Geräte filtern'),'the content renders only when open');
}

// ---- Focus after closing: back to the trigger unless another control took it ----
{
 const {returnsFocusToTrigger}=await import('../../../ui/kit/data-table.tsx');
 const body={isConnected:true,tabIndex:-1},element=(tabIndex,isConnected=true)=>({tabIndex,isConnected});
 check([returnsFocusToTrigger(null,body),returnsFocusToTrigger(body,body),returnsFocusToTrigger(element(0,false),body),returnsFocusToTrigger(element(-1),body),returnsFocusToTrigger(element(0),body)],[true,true,true,true,false],'focus returns from nowhere, the body, a removed field and main (tabIndex -1, a tap on plain text); another control keeps it');
 const source=fs.readFileSync('ui/kit/data-table.tsx','utf8');
 ok(/onCloseAutoFocus=\{closeFocus\}/.test(source)&&/const closeFocus=\(event:Event\)=>\{event\.preventDefault\(\);requestAnimationFrame\(\(\)=>\{if\(returnsFocusToTrigger\(document\.activeElement,document\.body\)\)trigger\.current\?\.focus\(\);\}\);\};/.test(source)&&/<Btn ref=\{trigger\} size="sm" icon=\{SlidersHorizontal\}/.test(source),'the popover content returns the focus to the trigger after Esc and an outside tap');
}

// ---- Agent updates trigger: a kit Btn ----
{
 const {FleetAgentUpdateToolbar}=load('ui/devices/fleet/fleet-agent-updates.tsx');
 const markup=renderToStaticMarkup(h(FleetAgentUpdateToolbar));
 ok(/^<button type="button" class="sdx-btn sdx-btn-secondary sdx-btn-sm"[^>]*><svg[^>]*lucide-circle-arrow-up[^>]*>.*?<\/svg><span>Agent-Updates<b class="sdx-btn-count" aria-hidden="true">1<\/b><\/span><\/button>$/s.test(markup),'one update available: a small secondary kit Btn with its icon, text and the count badge');
 check(attr(markup.match(/<button[^>]*>/)[0],'aria-label'),'Agent-Updates, 1 verfügbar','the name says the number (agentUpdates.fleet.buttonCount)');
 // An active rollout or no update: nothing to do, the button is quiet.
 const rows=agentContext.rows;
 agentContext.rows=[{inspect:true,update:null,active:false},{inspect:true,update:{version:'4.6.0'},active:true}];
 const quiet=renderToStaticMarkup(h(FleetAgentUpdateToolbar));
 ok(/^<button type="button" class="sdx-btn sdx-btn-ghost sdx-btn-sm"/.test(quiet)&&!quiet.includes('sdx-btn-count')&&attr(quiet.match(/<button[^>]*>/)[0],'aria-label')===null&&quiet.includes('<span>Agent-Updates</span>'),'none available: a ghost Btn without badge or aria-label, the same label');
 agentContext.rows=[{inspect:false,update:{version:'4.6.0'},active:false}];
 check(renderToStaticMarkup(h(FleetAgentUpdateToolbar)),'','no row to inspect: no button');
 agentContext.rows=rows;
 ok(!/data-slot="button"|sdfau-launch|inline-flex items-center/.test(markup),'no shadcn Button');
 agentContext.loading=true;
 ok(/aria-busy="true"/.test(renderToStaticMarkup(h(FleetAgentUpdateToolbar)))&&/sdx-spin/.test(renderToStaticMarkup(h(FleetAgentUpdateToolbar))),'loading while the check runs');
 agentContext.loading=false;agentContext.busy=true;
 ok(/aria-busy="true"/.test(renderToStaticMarkup(h(FleetAgentUpdateToolbar))),'loading while a rollout is busy');
 agentContext.busy=false;
 const source=fs.readFileSync('ui/devices/fleet/fleet-agent-updates.tsx','utf8');
 ok(/export function FleetAgentUpdateToolbar\(\)\{[\s\S]*?return <Btn size="sm" variant=\{count>0\?'secondary':'ghost'\} icon=\{ArrowUpCircle\} loading=\{context\.loading\|\|context\.busy\} count=\{count\} countLabel=\{t\('agentUpdates\.fleet\.buttonCount',\{count\}\)\} onClick=\{\(\)=>context\.open\(\)\}>/.test(source)&&!source.includes('<b className="sdx-btn-count"'),'the same open() and the kit Btn count in the source, no hand-placed badge');
}

// ---- CSS: notices span the content, new rules use tokens and the 4px grid ----
{
 const css=fs.readFileSync('ui/styles/console.css','utf8');
 ok(/\.sdx-main > \.sdx-notice \{ width: 100%; \}/.test(css),'page notices stretch in the flex-column main (no margin:auto shrink)');
 ok(/\.sdx-main > \* \{ max-width: 1680px; margin-left: auto; margin-right: auto; \}/.test(css),'and keep the page width and centring of every main child');
 const block=css.slice(css.indexOf('/* Devices table'));
 ok(block.length>200,'the new block is found');
 ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(block),'no new hex or rgba');
 const offGrid=[...block.matchAll(/(?:^|[;{\s])((?:margin|padding|gap|width|height|min-width|max-width|min-height)(?:-[a-z]+)?):\s*([^;}]+)/g)].flatMap(([,property,value])=>[...value.matchAll(/(\d+(?:\.\d+)?)px/g)].map(match=>[property,Number(match[1])])).filter(([,value])=>value%4!==0);
 check(offGrid,[],'spacing and sizes on the 4px grid');
 ok(/\.sdx-filter-popover \{ --sdx-rise-from: 4px;[^}]*animation: sdx-rise var\(--sd-dur\) var\(--sd-ease-out\);/.test(css),'the popover fades in and rises 4px with --sd-ease-out');
 ok(/:is\(\.sdx, \.sdx-layer\) \*, \.sdx-menu, \.sdx-menu \* \{ animation: none !important;/.test(css),'reduced motion switches it off (.sdx-menu)');
 // The kit rule gives every toolbar search room for its whole placeholder ("Name oder Anzeigename suchen…"
 // needs more than the 178px a 240px field leaves after its 32px/30px padding); the fleet-only rule is gone.
 ok(/\.sdx-toolbar > \.sdx-toolbar-search \{ flex: 1 1 280px; min-width: 280px; \}/.test(css)&&/\.sdx-toolbar > \.sdx-toolbar-search \{ flex-basis: 100%; min-width: 0; max-width: none; \}/.test(css)&&!css.includes('.sdx-fleet-toolbar > .sdx-toolbar-search'),'the search keeps room for its placeholder (280px) and takes the first row at 760px');
 // No page sets its own search width: only the kit sheet sizes .sdx-toolbar-search.
 const sheets=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{const file=path.posix.join(dir,entry.name);return entry.isDirectory()?sheets(file):entry.name.endsWith('.css')?[file]:[];});
 const local=[...sheets('app'),...sheets('ui')].filter(file=>file!=='ui/styles/console.css').flatMap(file=>[...fs.readFileSync(file,'utf8').matchAll(/([^{}]*\.sdx-toolbar-search[^{}]*)\{([^}]*)\}/g)].filter(([,,body])=>/(?:^|;)\s*(?:min-width|flex(?:-basis)?)\s*:/.test(body)).map(([,selector])=>`${file}: ${selector.trim()}`));
 check(local,[],'no stylesheet other than ui/styles/console.css sets a min-width or flex on .sdx-toolbar-search');
 ok(/@media \(max-width: 760px\) \{\s*\.sdx-fleet-toolbar > \.sdx-toolbar-filters \{ display: contents; \}\s*\}/.test(css),'at 760px the filter group dissolves, so Filters and the actions share a row');
 ok(/\.sdx-fleet-description \{ display: block; max-width: 200px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; \}/.test(css),'the description is one line of at most 200px');
 ok(/\.sdx-col-device \.sdx-device-cell strong \{ overflow: visible; text-overflow: clip; \}/.test(css)&&/\.sdx-col-device \.sdx-device-cell \{ min-width: 176px; \}/.test(css),'device names are never cut and the column fits 15 characters');
 ok(/td\.sdx-col-group \{ white-space: nowrap; \}/.test(css),'the group stays on one line');
}

// ---- The column menu is the kit Menu ----
{
 const source=fs.readFileSync('ui/devices/fleet/fleet.tsx','utf8');
 ok(!/DropdownMenu|from 'radix-ui'/.test(source),'fleet.tsx uses no radix DropdownMenu of its own');
 const trigger=html.match(/<button[^>]*aria-label="Spalten auswählen"[^>]*>/)?.[0]??'';
 ok(trigger&&/class="sdx-icon-btn sdx-btn-ghost sdx-icon-btn-framed"/.test(trigger)&&!/\stitle=/.test(trigger),'the trigger is a framed IconBtn named "Spalten auswählen", with the kit Tooltip and no native title');
 const menu=html.slice(html.indexOf('data-part="Label" class="sdx-menu-heading"'));
 ok(menu.startsWith('data-part="Label" class="sdx-menu-heading">Sichtbare Spalten<'),'the heading fleet.columns.visible');
 ok(/data-part="CheckboxItem" class="sdx-menu-item sdx-menu-switch" data-checked="true"><span>CPU<\/span><span class="sdx-switch-visual" aria-hidden="true"><\/span>/.test(menu),'one switch entry per column (CheckboxItem in the switch look)');
ok(!/<span>Gruppe<\/span>/.test(menu),'no device of the view is in a group: no Gruppe entry (groupColumnShows)');
 const toggled=[];
 const entries=columnMenuEntries({group:true,os:false},['group','os'],key=>toggled.push(key),(key)=>key);
 check(entries.map(entry=>'heading' in entry?['heading',entry.heading]:[entry.id,entry.label,entry.checked]),[['heading','fleet.columns.visible'],['group','csv.group',true],['os','csv.os',false]],'columnMenuEntries: the heading, then one checkbox entry per available column');
 entries[2].onCheckedChange(true);check(toggled,['os'],'toggling a column calls the toggle (saved to localStorage by toggleColumn)');
 ok(/const toggleColumn=\(key:FleetColumnKey\)=>setColumns\(previous=>\{const next=\{\.\.\.previous,\[key\]:!previous\[key\]\};write\('serverdesk\.redesign\.columns',next\);return next;\}\);/.test(source),'the choice is still saved to localStorage');
}
// ---- The selection bar is the kit BulkBar ----
{
 const source=fs.readFileSync('ui/devices/fleet/fleet.tsx','utf8');
 ok(source.includes('{selectable&&<BulkBar count={selected.length} onClear={()=>setSelection([])}>')&&!source.includes('className="sdx-bulkbar"')&&!source.includes("t('fleet.bulk.clear')"),'the Devices tab renders its selection bar through BulkBar, in table and card layout');
 const bar=source.slice(source.indexOf('<BulkBar'),source.indexOf('</BulkBar>'));
 const order=["t('groups.assign.submit')","t('tags.bulk.add')","t('tags.bulk.remove')","t('fleet.bulk.removeFromGroup')","t('console.removal.bulkButton'"].map(part=>bar.indexOf(part));
 ok(order.every((index,position)=>index>0&&(!position||index>order[position-1])),'the same actions in the same order: move to group, add tag, remove tag, remove from group, remove devices');
 ok(bar.includes("blocked={demoBlocked}")&&bar.includes("blocked={tagBlocked}")&&bar.includes("t('fleet.bulk.notDirect')")&&bar.includes("t('fleet.bulk.max')"),'the same blocked reasons');
}

// ---- Copy ----
check(['fleet.filters.button','fleet.filters.title','fleet.filters.condition'].map(key=>de(key)),['Filter','Geräte filtern','Zustand'],'German copy');
check([de('fleet.filters.activeLabel',{count:1}),de('fleet.filters.activeLabel',{count:4})],['Filter, 1 aktiv','Filter, 4 aktiv'],'German plural');
const {translate}=await import('../../../lib/i18n/translate.ts');
check(['fleet.filters.button','fleet.filters.title','fleet.filters.condition','fleet.tabs.areas'].map(key=>translate('en',key)),['Filters','Filter devices','State','Areas'],'English copy');
check([translate('en','fleet.filters.activeLabel',{count:1}),translate('en','fleet.filters.activeLabel',{count:2})],['Filters, 1 active','Filters, 2 active'],'English plural');

console.log(`PASS fleet toolbar (${checks} checks): the kit Toolbar with search, status and Filters, the actions in order, the FilterPopover fields, count, badge, name, reset and focus return, the agent updates kit Btn, the notice and toolbar CSS, the copy, the kit column menu and the BulkBar.`);
