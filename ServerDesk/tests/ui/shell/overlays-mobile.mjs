// Overlays and mobile (UI rework slice 14), rendered with React SSR and checked in the sources: Help as the non-modal
// kit Drawer with its three sections and the corrected topics, the command palette on the kit Dialog, the top bar with
// the demo pill and the 900px navigator toggle, the bottom bar's Jobs item, the compact page header, the navigator
// overlay's focus and Esc, the 900px and 760px CSS (no dock bar, the Jobs item, the compact KPI row) and the catalogs.
// No browser, no server.
import {mock} from '../../support/register.mjs';
// Loaded before the hooks of register.mjs, so this is the real package; the mock renders the portals in place.
import * as radix from 'radix-ui';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {postcss} from '../../support/theme-colors.mjs';
import {panelHarness} from '../../support/panel-harness.mjs';
const inline=({children})=>children;
mock('radix-ui',{...radix,Dialog:{...radix.Dialog,Portal:inline},AlertDialog:{...radix.AlertDialog,Portal:inline},DropdownMenu:{...radix.DropdownMenu,Portal:inline}});
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const helpModule=await import('../../../ui/shell/help-panel.tsx');
const HelpPanel=helpModule.default,{topicFor}=helpModule;
const paletteModule=await import('../../../ui/shell/command-palette.tsx');
const CommandPalette=paletteModule.default,{filterPaletteItems}=paletteModule;
const shell=await import('../../../ui/shell/shell.tsx');
const kit=await import('../../../ui/kit/kit.tsx');
const {parseConsoleRoute}=await import('../../../lib/console-route.ts');
const {shortcutList}=await import('../../../ui/shell/console-shortcuts.ts');
const en=(await import('../../../lib/i18n/messages/en.ts')).default,de=(await import('../../../lib/i18n/messages/de.ts')).default;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>fs.readFileSync(file,'utf8');
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const noop=()=>{};
const Icon=()=>null;

// ---- Help: the non-modal kit Drawer ----
{
 const route={view:'devices'};
 const html=render(h(HelpPanel,{open:true,onOpenChange:noop,route}));
 const content=html.match(/<div role="dialog"[^>]*>/)?.[0]??'';
 ok(/class="sdx-layer sdx-drawer sdx-drawer-nonmodal"/.test(content)&&!html.includes('sdx-drawer-scrim'),'Help is the non-modal kit Drawer: no scrim');
 ok(/<h2 id="radix-[^"]+">Help<\/h2><p id="radix-[^"]+">All devices<\/p>/.test(html),'title Help, the topic title as description');
 check(topicFor(route).title,'All devices','the description is topicFor(route).title');
 ok(/<span class="sdx-icon-tile sdx-icon-tile-accent" aria-hidden="true"><svg[^>]*lucide-circle-question-mark/.test(html),'the CircleHelp icon tile anchors the head');
 const headings=[...html.matchAll(/<h3 id="sd-help-[a-z]+">(?:<svg[\s\S]*?<\/svg>)?([^<]+)<\/h3>/g)].map(match=>match[1]);
 check(headings,['On this page','Keyboard shortcuts','Documentation'],'three sections in this order');
 check((html.match(/<kbd class="sdx-kbd">/g)??[]).length,shortcutList.flatMap(item=>item.keys).filter(key=>key!=='shortcuts.or'&&key!=='–').length,'every key is a kit Kbd');
 ok(html.includes('<span>or</span>')&&render(h(HelpPanel,{open:true,onOpenChange:noop,route}),'de').includes('<span>oder</span>'),'"or" is translated');
 const links=[...html.matchAll(/<a href="[^"]+"[^>]*>/g)].map(match=>match[0]);
 ok(links.length>0&&links.every(link=>/target="_blank"/.test(link)&&/rel="noreferrer"/.test(link)),'documentation links open in a new tab with rel="noreferrer"');
 const source=read('ui/shell/help-panel.tsx');
 ok(!/@\/components\/ui/.test(source)&&/<Drawer open=\{open\} onClose=\{\(\)=>onOpenChange\(false\)\} modal=\{false\} icon=\{CircleHelp\}/.test(source),'help-panel.tsx imports nothing from @/components/ui and renders the Drawer with modal={false}');
 ok(!render(h(HelpPanel,{open:false,onOpenChange:noop,route})).includes('role="dialog"'),'closed: nothing renders');
 const css=read('ui/shell/help-panel.css');
 ok(!/!important/.test(css),'help-panel.css has no !important');
 const radii=[...css.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;}]+)/g)].map(match=>match[1].trim());
 ok(radii.length>0&&radii.every(value=>/^(?:var\(--sd-radius(?:-sm|-lg)?\)|99px)$/.test(value)),'radii are --sd-radius tokens (or a 99px pill)');
 ok(!/backdrop-filter|--sd-glass/.test(css),'no glass: the drawer content is a solid panel');
}

// ---- Help topics: the corrected tips and the stale-phrase guard ----
{
 const topics={
  '#devices':['help.fleet.tip1','help.fleet.tip2','help.fleet.tip3'],
  '#settings/customers':['help.customers.tip1','help.customers.tip2'],
  '#devices/alarms':['help.problems.tip3'],
  '#devices/inventory/extensions':['help.extensions.tip2'],
  '#device/d1':['help.deviceOverview.tip3'],
  '#devices/group/g1/configuration/tags':['help.tags.tip3'],
  '#device/d1/management':['help.management.tip1'],
  '#settings/agent-releases':['help.releases.tip2'],
  '#device/d1/history':['help.history.tip1'],
 };
 const expected={
  'help.fleet.tip1':['Use “Filters” above the table to show only devices with a certain state, health level or support status.','Mit „Filter“ über der Tabelle zeigst du nur Geräte mit einem bestimmten Zustand, einer Health-Stufe oder einem Supportstatus.'],
  'help.fleet.tip2':['To create a group, select “Create group” in the tree on the left. To move devices into a group, select “Move devices here…”.','Um eine Gruppe zu erstellen, wähle links im Baum „Gruppe erstellen“. Um Geräte in eine Gruppe zu verschieben, wähle „Geräte hierher verschieben…“.'],
  'help.fleet.tip3':['Use “Choose columns” above the table to show more values, such as the operating system.','Mit „Spalten auswählen“ über der Tabelle blendest du weitere Werte wie das Betriebssystem ein.'],
  'help.customers.tip1':['Accounts and user groups see only the customers that you assign to them with “Technician access…” in the customer menu. Owners see all customers.','Konten und Benutzergruppen sehen nur die Kunden, die du ihnen im Kundenmenü mit „Technikerzugriff…“ zuweist. Owner sehen alle Kunden.'],
  'help.customers.tip2':['To add several devices to a customer, select “Installers” in the customer menu. Each device that runs the installer goes straight to this customer.','Um mehrere Geräte zu einem Kunden hinzuzufügen, wähle im Kundenmenü „Installer“. Jedes Gerät, auf dem der Installer läuft, kommt direkt zu diesem Kunden.'],
  'help.problems.tip3':['Select a reason to open the device area it refers to. In “My account” › “Preferences” you can choose “Alarms” as your start page.','Wähle einen Grund, um den passenden Bereich des Geräts zu öffnen. Unter „Mein Konto“ › „Einstellungen der Oberfläche“ kannst du „Alarme“ als Startseite wählen.'],
  'help.extensions.tip2':['Choose the filter “Offered” to see where an extension is available. “Roll out” on an extension card updates the devices with an older version.','Wähle den Filter „Angeboten“, um zu sehen, wo eine Erweiterung verfügbar ist. „Ausrollen“ auf der Karte einer Erweiterung aktualisiert die Geräte mit einer älteren Version.'],
  'help.deviceOverview.tip3':['“Refresh inventory” reads the inventory of the device again. You find “Restart…” and “Shut down…” in “More actions”.','„Inventar aktualisieren“ liest das Inventar des Geräts neu ein. „Neu starten…“ und „Herunterfahren…“ findest du unter „Weitere Aktionen“.'],
  'help.tags.tip3':['You can change an inherited tag only where it is set. Search for a tag in “All devices” to find the devices that have it.','Einen geerbten Tag kannst du nur dort ändern, wo er gesetzt ist. Suche in „Alle Geräte“ nach einem Tag, um die Geräte zu finden, die ihn haben.'],
  'help.management.tip1':['Each change runs as a job on the device. You can follow its progress under “Jobs” at the bottom.','Jede Änderung läuft als Auftrag auf dem Gerät. Den Fortschritt siehst du unten unter „Aufträge“.'],
  'help.releases.tip2':['An imported release reaches devices only when you start an update with “Agent updates” in “All devices”. To deactivate or delete a release, open its row menu.','Ein importiertes Release erreicht Geräte erst, wenn du in „Alle Geräte“ mit „Agent-Updates“ ein Update startest. Zum Deaktivieren oder Löschen öffnest du das Menü der Zeile.'],
  'help.history.tip1':['“Jobs” shows the jobs on this device, and “Device access” shows who accessed this device through the portal. The alarms of the device are under “Monitoring”.','„Aufträge“ zeigt die Aufträge auf diesem Gerät, und „Gerätezugriffe“ zeigt, wer über das Portal auf dieses Gerät zugegriffen hat. Die Alarme des Geräts findest du unter „Monitoring“.'],
 };
 for(const [hash,keys] of Object.entries(topics)){
  const route=parseConsoleRoute(hash);
  for(const key of keys){
   ok(topicFor(route,'en').tips.includes(expected[key][0]),`${hash}: ${key} (en)`);
   ok(topicFor(route,'de').tips.includes(expected[key][1]),`${hash}: ${key} (de)`);
  }
 }
 // The further tip the builder corrected: the add-device topic names All devices, not an "overview".
 check([en['help.agents.tip2'],de['help.agents.tip2']],['Start the installation on the Windows device as an administrator. The device appears in “All devices” after its first Heartbeat.','Starte die Installation auf dem Windows-Gerät als Administrator. Das Gerät erscheint nach seinem ersten Heartbeat in „Alle Geräte“.'],'help.agents.tip2 names All devices');
 const stale={
  en:['status tile','“…” menu','“Columns”','Under “Installer”','under “Access”','In the account menu you can choose','Select a KPI','Use “Actions”','device overview','job bar'],
  de:['Statuskachel','Menü „…“','„Spalten“','Unter „Installer“','unter „Zugriff“','Im Kontomenü kannst du','Kennzahl oder','Über „Aktionen“','Geräteübersicht','Auftragsleiste'],
 };
 const offending=[];
 for(const [name,messages] of [['en',en],['de',de]])for(const [key,value] of Object.entries(messages)){
  if(!/^help\.[^.]+\.(?:tip\d+|uninstall)$/.test(key))continue;
  for(const phrase of stale[name])if(String(value).includes(phrase))offending.push(`${name} ${key}: ${phrase}`);
 }
 check(offending,[],'no help tip names a control, page or place that does not exist');
}

// ---- Command palette on the kit Dialog ----
{
 const source=read('ui/shell/command-palette.tsx');
 ok(/import \{Dialog\} from '@\/ui\/kit\/confirm-dialog';/.test(source)&&!/from\s*['"]radix-ui['"]/.test(source),'the palette imports the kit Dialog and not radix-ui');
 ok(source.includes(`<Dialog open={open} onOpenChange={onOpenChange} title={t('palette.title')} hideTitle variant="search" closing={closing}>`),'search variant, hidden title palette.title');
 const items=[{id:'d1',group:'Devices',label:'SRV-01',hint:'10.0.0.1',Icon,run:noop},{id:'d2',group:'Devices',label:'SRV-02',Icon,run:noop},{id:'page-jobs',group:'Pages',label:'Jobs',Icon,run:noop}];
 let html=render(h(CommandPalette,{open:true,onOpenChange:noop,getItems:()=>items}));
 const content=html.match(/<div role="dialog"[^>]*>/)?.[0]??'';
 ok(/class="sdx-layer sdx-confirm-dialog sdx-dialog-search"/.test(content),'the kit dialog surface in its search variant');
 ok(/<h2 id="radix-[^"]+" class="sr-only">Search and jump<\/h2>/.test(html),'the dialog is named "Search and jump" by its hidden title');
 const input=html.match(/<input[^>]*>/)?.[0]??'';
 ok(/role="combobox"/.test(input)&&/aria-controls="sd-palette-results"/.test(input)&&/aria-activedescendant="sd-palette-d1"/.test(input)&&/value=""/.test(input),'the combobox input with aria-controls and aria-activedescendant, empty');
 // No autoFocus: React would focus the field before the Dialog's onOpenAutoFocus remembers the opener, and Esc would
 // send focus to main. radix focuses the first tabbable (this field) after openFocus has remembered the opener.
 ok(!/autofocus/i.test(input)&&!/autoFocus/.test(source),'the field takes focus from radix after the opener is remembered, not from autoFocus');
 ok(source.indexOf('<input value={query}')>=0&&html.indexOf('<input')<html.search(/<button[^>]*role="option"/),'the search field is the first tabbable control of the dialog');
 ok(/<div class="sd-palette-results" id="sd-palette-results" role="listbox"/.test(html),'the listbox');
 check((html.match(/role="option"/g)??[]).length,3,'one option per item');
 check([...html.matchAll(/<div class="sd-palette-group" role="presentation">([^<]+)<\/div>/g)].map(match=>match[1]),['Devices','Pages'],'the group headings');
 ok(/<button type="button" id="sd-palette-d1" role="option" aria-selected="true">/.test(html),'the first row is selected (the gradient selector .sd-palette-results [aria-selected=true])');
 ok(html.includes('<kbd class="sdx-kbd">Esc</kbd>')&&html.includes('<footer class="sd-palette-foot">'),'Esc hint and foot hints with kit Kbd');
 html=render(h(CommandPalette,{open:true,onOpenChange:noop,getItems:()=>[]}));
 ok(html.includes('<p class="sd-palette-empty">No results for “”. Search for a device name, IP address, group or page.</p>'),'the "No results for …" text');
 check(filterPaletteItems(items,'zzz'),[],'an unmatched query has no results');
 check(filterPaletteItems(items,'srv 02').map(item=>item.id),['d2'],'filterPaletteItems is unchanged');
 ok(read('ui/shell/command-palette.css').includes('.sd-palette-results button[aria-selected="true"] { background: var(--sd-accent-grad); color: var(--sd-on-accent); }'),'the selected row keeps the guarded gradient');
}

// ---- Top bar: search text, demo pill, navigator toggle ----
{
 check([en['shell.search'],de['shell.search']],['Search devices, groups, pages and actions','Geräte, Gruppen, Seiten und Aktionen suchen'],'the search button text');
 const viewer={id:'u1',label:'ada@example.test',username:'ada',displayName:'Ada Lovelace',permissions:[]};
 const props={viewer,saving:false,navigatorOpen:false,canToggleNavigator:true,onToggleNavigator:noop,onSearch:noop,onRefresh:noop,loading:false,status:'Updated 10:00',onHelp:noop,onAccount:noop,onSignOut:noop};
 let ended=0;
 let html=render(h(shell.Topbar,{...props,status:'',demo:true,onEndDemo:()=>ended++}));
 const pill=html.match(/<span class="sdx-pill sdx-pill-accent sdx-demo-pill"[\s\S]*?<span id="sdx-demo-pill-hint"[^>]*>[^<]*<\/span><\/span>/)?.[0]??'';
 ok(pill,'demo: the pill renders');
 ok(/role="group" aria-labelledby="sdx-demo-pill-label" aria-describedby="sdx-demo-pill-hint"/.test(pill),'the pill is a group named by its text and described by the tooltip text');
 ok(/lucide-flask-conical/.test(pill)&&pill.includes('<span id="sdx-demo-pill-label" class="sdx-demo-pill-label">Sample devices</span>'),'flask icon and "Sample devices"');
 ok(/<button type="button" class="sdx-btn sdx-btn-ghost sdx-btn-sm" aria-label="End sample devices"[^>]*><span>End<\/span><\/button>/.test(pill),'a ghost Btn sm "End" named "End sample devices"');
 ok(pill.includes('<span id="sdx-demo-pill-hint" class="sr-only">All values are made up, and changes are turned off.</span>'),'the tooltip text is its description');
 ok(!html.includes('sdx-freshness'),'no freshness text in demo mode');
 const shellSource=read('ui/shell/shell.tsx');
 ok(shellSource.includes("<Tooltip content={t('console.demo.text')}>")&&shellSource.includes("onClick={()=>onEnd?.()}"),'the tooltip says the values are made up; End calls onEndDemo');
 ok(read('ui/shell/console.tsx').includes('onEndDemo={()=>startDemo(false)}'),'End turns demo mode off (startDemo(false))');
 html=render(h(shell.Topbar,props));
 ok(html.includes('<span class="sdx-freshness" aria-live="polite">Updated 10:00</span>')&&!html.includes('sdx-demo-pill'),'outside demo mode the freshness text');
 // The toggle: wide with aria-pressed, at 900px or narrower "Open navigator" with aria-expanded and aria-controls.
 const toggleOf=markup=>markup.match(/<button[^>]*class="sdx-icon-btn sdx-btn-ghost sdx-navigator-toggle"[^>]*>/)?.[0]??'';
 let toggle=toggleOf(render(h(shell.Topbar,{...props,navigatorOpen:true})));
 ok(/aria-label="Hide navigator"/.test(toggle)&&/aria-pressed="true"/.test(toggle)&&!/aria-expanded/.test(toggle),'wide: today\'s label with aria-pressed');
 toggle=toggleOf(render(h(shell.Topbar,{...props,navigatorOpen:false})));
 ok(/aria-label="Show navigator"/.test(toggle)&&/aria-pressed="false"/.test(toggle),'wide, closed: Show navigator');
 for(const open of [false,true]){
  toggle=toggleOf(render(h(shell.Topbar,{...props,overlay:true,navigatorOpen:open})));
  ok(/aria-label="Open navigator"/.test(toggle)&&new RegExp(`aria-expanded="${open}"`).test(toggle)&&/aria-controls="sdx-navigator"/.test(toggle)&&!/aria-pressed/.test(toggle),`900px or narrower: Open navigator, aria-expanded=${open}, aria-controls, no aria-pressed`);
 }
 ok(render(h(shell.Topbar,{...props,overlay:true}),'de').includes('aria-label="Navigator öffnen"'),'German: Navigator öffnen');
 ok(read('ui/base/narrow-layout.ts').includes("export const overlayQuery='(max-width: 900px)';")&&/export function useOverlayLayout\(\):boolean/.test(read('ui/base/narrow-layout.ts')),'the 900px hook lives next to useNarrowLayout');
}

// ---- The bottom bar: the Jobs item ----
{
 const items=[['devices','Devices','G D'],['automation','Automation','G A'],['settings','Settings','G S']].map(([id,label,shortcut])=>({id,label,icon:Icon,shortcut,onSelect:noop,...(id==='settings'?{placement:'end'}:{}),...(id==='devices'?{expanded:false}:{})}));
 let html=render(h(shell.Rail,{items,area:'devices',jobs:{count:3,open:false,onSelect:noop}}));
 check([...html.matchAll(/<span class="sdx-rail-label">([^<]+)<\/span>/g)].map(match=>match[1]),['Devices','Automation','Jobs','Settings'],'order: Devices, Automation, Jobs, Settings');
 const jobs=html.match(/<button[^>]*class="sdx-rail-item sdx-rail-mobile sdx-rail-jobs"[^>]*>[\s\S]*?<\/button>/)?.[0]??'';
 ok(/aria-expanded="false"/.test(jobs)&&/aria-haspopup="dialog"/.test(jobs)&&/aria-keyshortcuts="T"/.test(jobs),'the Jobs item: aria-expanded for the sheet, a dialog popup, the T shortcut');
 ok(/lucide-activity/.test(jobs)&&jobs.includes('<b class="sdx-rail-badge" aria-hidden="true">3</b>'),'the Activity icon and the hidden badge with the count');
 ok(jobs.includes('<span class="sr-only">3 running or waiting</span>'),'the name includes "3 running or waiting"');
 const devices=html.match(/<button[^>]*class="sdx-rail-item active"[^>]*>/)?.[0]??'';
 ok(/aria-current="page"/.test(devices)&&/aria-expanded="false"/.test(devices)&&/aria-controls="sdx-navigator"/.test(devices),'the active item of an area with a navigator carries aria-expanded and aria-controls');
 ok(!/aria-expanded/.test(html.match(/<button[^>]*class="sdx-rail-item"[^>]*>/)?.[0]??''),'an inactive item has no aria-expanded');
 html=render(h(shell.Rail,{items,area:'devices',jobs:{count:0,open:true,onSelect:noop}}));
 const idle=html.match(/<button[^>]*sdx-rail-jobs[^>]*>[\s\S]*?<\/button>/)?.[0]??'';
 ok(!idle.includes('sdx-rail-badge')&&!idle.includes('sr-only')&&/aria-expanded="true"/.test(idle),'no badge at 0; open sheet: aria-expanded="true"');
 ok(render(h(shell.Rail,{items,area:'devices',jobs:{count:2,open:false,onSelect:noop}}),'de').includes('<span class="sr-only">2 laufend oder wartend</span>'),'German badge name');
 ok(/<Tooltip key="jobs" side="top" content=\{iconButtonTip\(t\('jobs.title'\),'T',t\('kit.ctrl'\)\)\}>/.test(read('ui/shell/shell.tsx')),'the tooltip "Jobs (T)"');
 ok(/key=\{jobs\.count\} className="sdx-rail-badge"/.test(read('ui/shell/shell.tsx')),'a new count remounts the badge, so it cross-fades in');
}

// ---- PageHeader compact: one title line with icon buttons ----
{
 const Plus=()=>null;
 const props={title:'All devices',subtitle:'12 devices · 10 online',actions:h(kit.Menu,{label:'More actions',entries:[{id:'a',label:'Create group',onSelect:noop}]}),primary:h(kit.IconBtn,{variant:'primary',icon:Plus,label:'Add device',blocked:'Not available for sample devices.',onClick:noop})};
 let html=render(h(shell.PageHeader,{...props,compact:true}));
 ok(/^<header class="sdx-page-head sdx-page-head-compact">/.test(html),'the compact variant class');
 const line=html.match(/<div class="sdx-page-line">[\s\S]*?<\/div><p>/)?.[0]??'';
 ok(/<h1>All devices<\/h1><span class="sdx-page-line-actions">/.test(line),'the actions follow the title on the title line');
 ok(/aria-label="More actions"/.test(line)&&/<button[^>]*class="sdx-icon-btn sdx-btn-primary"[^>]*aria-label="Add device"/.test(line),'the menu trigger and the primary IconBtn on the line');
 const primary=line.match(/<button[^>]*aria-label="Add device"[^>]*>/)?.[0]??'';
 const described=primary.match(/aria-describedby="([^"]+)"/)?.[1];
 ok(/aria-disabled="true"/.test(primary)&&described&&html.includes(`id="${described}" class="sr-only" aria-hidden="true">Not available for sample devices.</span>`),'the blocked reason stays (demo mode)');
 ok(!html.includes('sdx-page-actions'),'no action row below the title');
 ok(html.includes('<p>12 devices · 10 online</p>'),'the counts subtitle');
 html=render(h(shell.PageHeader,props));
 ok(html.includes('<div class="sdx-page-actions">')&&!html.includes('sdx-page-head-compact'),'wide: the action row as before');
 const consoleSource=read('ui/shell/console.tsx');
 ok(consoleSource.includes('compact={narrow}')&&consoleSource.includes("<IconBtn variant=\"primary\" icon={Plus} label={t('console.addDevice')} blocked={demo?t('kit.unavailable.demo'):undefined} onClick={addDevice}/>")&&consoleSource.includes("<IconBtn icon={FolderInput} label={t('console.moveDevicesHere')}"),'the scope header passes compact and its icon buttons at 760px or narrower');
}

// ---- The navigator overlay: focus in, Esc out ----
{
 const harness=panelHarness({hooked:['ui/shell/shell.tsx'],locale:'en'});
 const shellHooked=harness.load('ui/shell/shell.tsx');
 const focused=[],listeners=new Set();
 const element=(name,extra={})=>({name,isConnected:true,focus:()=>focused.push(name),closest:()=>null,...extra});
 const toggle=element('toggle'),filter=element('tree-filter'),treeItem=element('tree-item'),menuItem=element('menu-item',{closest:selector=>selector.includes('[role="menu"]')?{}:null});
 // A fake panel: the device navigator holds the tree filter (input), header buttons and the tree; selectors that would
 // match the filter return it, so a focus rule that reaches for a text field fails here.
 const fakePanel=({tree=false,page=false,button=false}={})=>{
  const panel={name:'panel',contains:node=>node===filter||node===treeItem,focus:()=>focused.push('panel'),querySelector:selector=>{
   if(selector.startsWith('[role="treeitem"]'))return tree?treeItem:null;
   if(selector.startsWith('a[aria-current'))return page?element('page-link'):null;
   if(selector.startsWith(':is(button')&&selector.includes(':not(input'))return button?element('first-button'):null;
   if(selector.includes('input')||selector.includes('[tabindex]'))return filter;
   return null;
  }};
  return panel;
 };
 const target=node=>node.name;
 check([target(shellHooked.navigatorFocusTarget(fakePanel({tree:true,page:true,button:true}))),target(shellHooked.navigatorFocusTarget(fakePanel({page:true,button:true}))),target(shellHooked.navigatorFocusTarget(fakePanel({button:true}))),target(shellHooked.navigatorFocusTarget(fakePanel()))],['tree-item','page-link','first-button','panel'],'the overlay focus goes to the selected tree item, else the current page link, else the first button, else the panel; never the tree filter');
 const panel=fakePanel({tree:true,button:true});
 const body={},saved=globalThis.document;
 globalThis.document={body,activeElement:toggle,addEventListener:(type,listener)=>{if(type==='keydown')listeners.add(listener);},removeEventListener:(type,listener)=>listeners.delete(listener)};
 try{
  let closes=0;
  const props={title:'Devices',open:true,overlay:true,onClose:()=>closes++,children:'Tree'};
  harness.reset();
  const tree=harness.tree(shellHooked.Navigator,props);
  const aside=harness.find(tree,node=>node.type==='aside');
  check([aside.props.id,aside.props.className],['sdx-navigator','sdx-navigator open'],'the panel has the id the openers control');
  (aside.props.ref??aside.ref).current=panel;
  await harness.flush();
  check([focused,listeners.size],[['tree-item'],1],'opening moves focus to the selected tree item (not the filter field) and listens for Esc');
  check(aside.props.tabIndex,-1,'the overlay panel can take focus itself when it holds no control');
  const escape=(target,defaultPrevented=false)=>{const event={key:'Escape',target,defaultPrevented,prevented:false,preventDefault(){event.prevented=true;}};for(const listener of [...listeners])listener(event);return event;};
  escape(menuItem);
  check(closes,0,'Esc in an open menu is left to the menu');
  escape(element('help-field'),true);
  check(closes,0,'an Esc a drawer handled outside the navigator does nothing here');
  const event=escape(filter,true);
  check([closes,event.prevented,focused.at(-1)],[1,true,'toggle'],'Esc inside the navigator closes it and gives focus back to its opener (also when Help cancelled the Esc)');
  // Wide (no overlay): no focus move and no Esc listener.
  harness.reset();listeners.clear();focused.length=0;
  const wide=harness.find(harness.tree(shellHooked.Navigator,{...props,overlay:false}),node=>node.type==='aside');
  await harness.flush();
  check(wide.props.tabIndex,undefined,'above 900px the panel is no focus target');
  check([focused,listeners.size],[[],0],'above 900px the navigator takes no focus and no Esc');
 }finally{globalThis.document=saved;}
 // Closed by the console (the palette, Help or the Jobs sheet opens, or a choice inside) while focus is inside: a
 // layout effect of the closing commit hands focus to the opener before the new layer remembers it; focus outside stays.
 // Not a cleanup: React restores the focus it saw before the mutation phase, so a move made in a cleanup was undone in
 // the browser (round-3 tester, F2 with the overlay open).
 const layout=panelHarness({hooked:['ui/shell/shell.tsx'],locale:'en',layoutEffects:true});
 const shellLayout=layout.load('ui/shell/shell.tsx');
 globalThis.document={body,activeElement:toggle,addEventListener:()=>{},removeEventListener:()=>{}};
 try{
  const props={title:'Devices',open:true,overlay:true,onClose:()=>{},children:'Tree'};
  const openAt=async()=>{
   layout.reset();focused.length=0;globalThis.document.activeElement=toggle;
   const aside=layout.find(layout.tree(shellLayout.Navigator,props),node=>node.type==='aside');
   (aside.props.ref??aside.ref).current=fakePanel({tree:true});
   await layout.flush();
  };
  await openAt();
  check(focused,['tree-item'],'the overlay opens with focus on the tree item');
  globalThis.document.activeElement=treeItem;
  layout.tree(shellLayout.Navigator,{...props,open:false});
  check(focused,['tree-item'],'nothing moves in a cleanup (React would undo it)');
  await layout.flush();
  check(focused,['tree-item','toggle'],'closed from outside with focus inside: focus goes back to the opener');
  await openAt();
  const paletteField=element('palette-field');globalThis.document.activeElement=paletteField;
  layout.tree(shellLayout.Navigator,{...props,open:false});
  await layout.flush();
  check(focused,['tree-item'],'closed with focus already outside (the palette field): focus stays');
 }finally{globalThis.document=saved;}
 const shellSource=read('ui/shell/shell.tsx');
 ok(!/return ()=>{s*const back=opener.current/.test(shellSource),'the close handoff is no effect cleanup');
 // Help remembers its opener in a layout effect; layout effects run in tree order, so Help must come after the body
 // that holds the Navigator, or F1 on a tree item would remember the hidden tree item.
 const consoleSource=read('ui/shell/console.tsx');
 const helpAt=consoleSource.indexOf('<HelpHost overlays={overlays}'),navigatorAt=consoleSource.indexOf('<Navigator title=');
 ok(navigatorAt>0&&helpAt>navigatorAt,'HelpPanel (its host HelpHost) renders after the Navigator');
}

// ---- CSS: 900px frame, Jobs item, compact KPI row, tokens and motion ----
{
 const css=postcss.parse(read('ui/styles/console.css'));
 const rulesIn=(media,selector)=>{const found=[];css.walkRules(rule=>{const parent=rule.parent;const inMedia=parent.type==='atrule'?parent.params:'';if(rule.selector===selector&&inMedia===media)found.push(Object.fromEntries(rule.nodes.filter(node=>node.type==='decl').map(decl=>[decl.prop,decl.value])));});return found;};
 const one=(media,selector)=>{const found=rulesIn(media,selector);assert.ok(found.length>0,`${media||'top level'} ${selector}`);return Object.assign({},...found);};
 check(one('(max-width: 900px)','.sdx-dock').display,'none','900px or narrower: no dock bar');
 check(one('(max-width: 900px)','.sdx-rail-mobile').display,'flex','900px or narrower: the Jobs item shows');
 check(one('','.sdx-rail-mobile').display,'none','above 900px: no Jobs item in the rail');
 const scrim=one('(max-width: 900px)','.sdx-navigator-scrim');
 ok(scrim.inset==='var(--sdx-topbar) 0 calc(62px + env(safe-area-inset-bottom))','the scrim sits between the top bar and the bottom bar, so the toggle and the bottom-bar items (Jobs) stay tappable');
 check(one('(max-width: 900px)','.sdx-rail').height,'calc(62px + env(safe-area-inset-bottom))','the scrim ends exactly at the bottom bar');
 // A hidden element refuses focus: on open, visibility must switch at once (0s), not after the slide-in, or the focus
 // move into the panel is lost and focus stays on the toggle.
 const panelOpen=one('(max-width: 900px)','.sdx-navigator.open, .sdx[data-navigator="closed"] .sdx-navigator.open');
 ok(panelOpen.visibility==='visible'&&/visibility 0s/.test(panelOpen.transition),'the open overlay is visible at once, so focus can move into it');
 ok(/visibility .26s/.test(one('(max-width: 900px)','.sdx-navigator, .sdx[data-navigator="closed"] .sdx-navigator').transition),'on close it stays visible until the slide-out ends');
 const badge=one('','.sdx-rail-badge');
 ok(badge['font-variant-numeric']==='tabular-nums'&&badge.background==='var(--sd-accent)'&&/sdx-fade var\(--sd-dur\)/.test(badge.animation),'the badge: accent, tabular figures, a short fade');
 check(badge.font,'650 11px/16px var(--sd-font)','the badge uses the 11px meta size, no new size step');
 const row=one('(max-width: 760px)','.sdx-kpi-row'),grid=one('(max-width: 760px)','.sdx-kpi-row .sdx-kpi-grid'),tile=one('(max-width: 760px)','.sdx-kpi-row .sdx-kpi');
 ok(row['overflow-x']==='auto'&&row['max-width']==='100%','760px or narrower: the row scrolls sideways inside itself');
 ok(grid.display==='flex'&&grid['flex-wrap']==='nowrap','one non-wrapping line of tiles');
 ok(tile.height==='var(--sd-kpi-h-compact)'&&tile['min-height']==='var(--sd-kpi-h-compact)'&&tile['flex-direction']==='row','tiles --sd-kpi-h-compact high, label and value on one line');
 check(one('(max-width: 760px)','.sdx-kpi-row :is(.sdx-kpi-visual, .sdx-kpi-detail)').display,'none','detail and visual hidden');
 ok(!rulesIn('(max-width: 760px)','.sdx-kpi-grid').length,'the old two-column phone grid is gone');
 // The cut side of the compact row fades like an overflowing tab bar (alpha mask, set from the scroll position).
 const fade=one('(max-width: 760px)','.sdx-kpi-row:is([data-fade-start], [data-fade-end])');
 ok(fade['mask-image'].includes('var(--sd-ink) var(--sdx-fade-start)')&&fade['mask-image'].includes('calc(100% - var(--sdx-fade-end))')&&fade['-webkit-mask-image']===fade['mask-image'],'760px or narrower: a cut KPI row edge fades through a mask');
 check([one('(max-width: 760px)','.sdx-kpi-row[data-fade-start]')['--sdx-fade-start'],one('(max-width: 760px)','.sdx-kpi-row[data-fade-end]')['--sdx-fade-end']],['var(--sd-space-6)','var(--sd-space-6)'],'the fade is 32px on the cut side only');
 ok(read('ui/kit/kit.tsx').includes('const edges=useScrollEdges(ref,tiles.length);')&&read('ui/kit/kit.tsx').includes('data-fade-start={edges.start||undefined} data-fade-end={edges.end||undefined}'),'the KpiRow marks its cut edges from the scroll position');
 const ring=one('(max-width: 760px)','.sdx .sdx-kpi-row[tabindex]:focus-visible');
 check([ring['mask-image'],ring['-webkit-mask-image'],ring['outline-offset']],['none','none','-2px'],'the focused KPI row drops the fade and draws its ring inside, so the ring is whole on the cut side');
 // On a phone "Filters" and the CSV and layout actions share one toolbar row, so the first card starts higher.
 check(one('(max-width: 760px)','.sdx-fleet-toolbar > .sdx-toolbar-filters').display,'contents','760px or narrower: the fleet filter group joins the toolbar row');
 ok(/--sd-kpi-h-compact: 44px;/.test(read('app/globals.css')),'--sd-kpi-h-compact: 44px in globals.css');
 ok(/const \[ref,focusable\]=useOverflowFocusable<HTMLElement>\(tiles\.length,false\);/.test(read('ui/kit/kit.tsx'))&&read('ui/kit/kit.tsx').includes('aria-label={label} tabIndex={focusable?0:undefined}'),'the KpiRow takes a Tab stop only while it overflows and keeps its aria-label');
 check(one('(max-width: 760px)','.sdx-demo-pill-label').position,'absolute','760px or narrower: the demo pill hides its text visually');
 check(one('','.sdx-demo-pill').animation,'sdx-fade var(--sd-dur) var(--sd-ease-out)','the demo pill fades in once');
 check(one('','.sdx-demo-pill').padding,'0 var(--sd-space-1) 0 var(--sd-space-3)','the demo pill padding stays on the 4px grid');
 const reduced=read('ui/styles/motion.css').match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\}/)[0];
 ok(reduced.includes('.sdx-demo-pill')&&reduced.includes('.sdx-rail-badge'),'reduced motion stops the pill fade and the badge cross-fade');
 const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.posix.join(dir,entry.name)):[path.posix.join(dir,entry.name)]);
 check([...walk('app'),...walk('ui')].filter(file=>file.endsWith('.css')&&file!=='ui/styles/motion.css'&&/@keyframes/.test(read(file))),[],'no @keyframes outside motion.css');
 // Toasts at 900px or narrower sit above the 62px bottom bar.
 ok(read('ui/shell/console.tsx').replace(/\n\s*/g,' ').includes("offset={{bottom:overlay?'calc(70px + env(safe-area-inset-bottom))':64,right:16}} mobileOffset={{bottom:'calc(70px + env(safe-area-inset-bottom))',left:16,right:16}}"),'toasts above the bottom bar');
}

// ---- Catalogs and the demo banner ----
{
 for(const [key,english,german] of [['shell.openNavigator','Open navigator','Navigator öffnen'],['shell.demo.endLabel','End sample devices','Beispielgeräte beenden'],['jobs.badgeLabel','{count} running or waiting','{count} laufend oder wartend'],['jobs.sheet.showAll','Show all jobs','Alle Aufträge anzeigen']])check([en[key],de[key]],[english,german],key);
 check([en['console.demo.title'],de['console.demo.title']],[undefined,undefined],'the banner title key is removed');
 const consoleSource=read('ui/shell/console.tsx');
 ok(!/console\.demo\.title/.test(consoleSource)&&!/<Notice tone="info" icon=\{FlaskConical\}/.test(consoleSource),'console.tsx renders no demo Notice');
 ok(!/console\.demo\./.test(consoleSource),'the console no longer reads the banner keys (the pill in shell.tsx reads console.demo.end and console.demo.text)');
}

console.log(`PASS overlays and mobile (${checks} checks): Help as the non-modal kit Drawer with its sections and corrected topics, the palette on the kit Dialog, the top bar with the demo pill and the 900px toggle, the bottom-bar Jobs item, the compact page header, the navigator overlay's focus and Esc, the 900px and 760px CSS and the catalogs.`);
