// Density and frame visuals (UI review slice 2): the density tokens in app/globals.css and the
// kit rules that use them (table rows and head, skeleton row, KPI tile, page header gap), the
// blocked primary look in the kit, the dialog, the classic console and the session card, the
// stable scrollbar gutter of the workspace, the tab count tones without .active, Tabs without
// icons, the single-line NavList and NavGroups, and the KpiRow rule (tiles without a value or
// with a value equal to their total are left out, live tiles keep "—", fewer than two tiles
// render nothing), and the compact density (lib/density.ts): the navigator line tokens and the one compact block.
// PostCSS over every stylesheet under app/, React SSR for the kit parts. No
// browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Settings,Users} from 'lucide-react';
import {postcss} from '../../support/theme-colors.mjs';
const h=React.createElement;
const kit=await import('../../../ui/kit/kit.tsx');
const {Tabs}=await import('../../../ui/kit/tabs.tsx');
const shell=await import('../../../ui/shell/shell.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const flat=text=>text.replace(/\s+/g,' ').trim();
const walk=dir=>readdirSync(dir).flatMap(name=>{const file=path.posix.join(dir,name);return statSync(file).isDirectory()?walk(file):name.endsWith('.css')?[file]:[];});
const sheets=[...walk('app'),...walk('ui')].map(file=>[file,postcss.parse(read(file))]);
const sheet=file=>sheets.find(([name])=>name===file)[1];
/** Every rule (with its file) whose selector list contains the selector, compared without extra whitespace. */
const rulesFor=selector=>sheets.flatMap(([file,root])=>{const found=[];root.walkRules(rule=>{if(rule.selectors.map(flat).includes(flat(selector)))found.push({file,rule});});return found;});
const decls=rule=>Object.fromEntries(rule.nodes.filter(node=>node.type==='decl').map(decl=>[decl.prop,decl.value]));
/** The one top-level rule (outside media queries) for the selector. */
const only=(selector,file)=>{const found=rulesFor(selector).filter(item=>item.rule.parent.type==='root'&&(!file||item.file===file));assert.equal(found.length,1,`one rule for ${selector}`);checks++;return decls(found[0].rule);};

// ---- the density tokens, each declared once in :root ----
const rootDecls=new Map();
postcss.parse(read('app/globals.css')).each(node=>{if(node.type==='rule'&&node.selector.trim()===':root')node.walkDecls(decl=>{if(!rootDecls.has(decl.prop))rootDecls.set(decl.prop,[]);rootDecls.get(decl.prop).push(decl.value);});});
for(const [name,value] of Object.entries({'--sd-row-h':'44px','--sd-row-h-2':'48px','--sd-head-h':'36px','--sd-kpi-h':'88px','--sd-page-head-gap':'12px','--sd-text-kpi':'650 22px/1.1 var(--sd-font)','--sd-tree-row-h':'32px','--sd-nav-row-h':'36px'}))check(rootDecls.get(name),[value],`${name} is ${value}, declared once`);
for(const [file,root] of sheets)if(file!=='app/globals.css')root.walkDecls(/^--sd-(row-h|row-h-2|head-h|kpi-h|page-head-gap|text-kpi|tree-row-h|nav-row-h)$/,decl=>assert.fail(`${file} redefines ${decl.prop}`));

// ---- compact density: one block, only above 900px with a fine pointer, exactly these values ----
const compactRules=[];
for(const [file,root] of sheets)root.walkRules(rule=>{if(/data-density/.test(rule.selector))compactRules.push({file,rule});});
for(const [file,root] of sheets)root.walkAtRules(atRule=>{if(/data-density/.test(atRule.params))assert.fail(`${file}: @${atRule.name} ${atRule.params} names data-density`);});
check(compactRules.map(({file,rule})=>[file,flat(rule.selector)]),[['app/globals.css',':root[data-density="compact"]']],'one data-density rule in the whole console, in globals.css');
const compact=compactRules[0].rule;
check([compact.parent.type,compact.parent.name,compact.parent.params,compact.parent.parent.type],['atrule','media','(min-width: 901px) and (pointer: fine)','root'],'the compact block sits in @media (min-width: 901px) and (pointer: fine) at the top level');
check(decls(compact),{'--sd-row-h':'36px','--sd-row-h-2':'40px','--sd-head-h':'32px','--sd-kpi-h':'76px','--sd-page-head-gap':'8px','--sd-tree-row-h':'28px','--sd-nav-row-h':'32px'},'the compact values, nothing else');
ok(Object.entries(decls(compact)).filter(([name])=>name!=='--sd-page-head-gap').every(([,value])=>parseInt(value,10)>=28),'every compact line stays at least 28px; touch screens keep comfortable');
// The density cookie (lib/density.ts) and the layout attribute are checked in tests/lib/density.mjs and tests/ui/shell/theme-preference.mjs.

// ---- table head and rows ----
const head=only(':is(.sdx, .sdx-layer) .sdx-table th');
check(head.height,'var(--sd-head-h)','the head row uses --sd-head-h');
const cell=only(':is(.sdx, .sdx-layer) .sdx-table td');
check(cell.height,'var(--sd-row-h)','a row uses --sd-row-h');
const vertical=cell.padding.split(/\s+/)[0];
ok(/^(0|[0-4]px|var\(--sd-space-1\))$/.test(vertical),`vertical cell padding is at most 4px (${cell.padding})`);
const twoLines=only(':is(.sdx, .sdx-layer) .sdx-table tr:not(.sdx-table-empty):has(> td :is(small, .sdx-cell-stack)) > td');
check(twoLines.height,'var(--sd-row-h-2)','a row with a second line (small or .sdx-cell-stack in a cell) uses --sd-row-h-2');
check(only(':is(.sdx, .sdx-layer) .sdx-data-table tr.sdx-table-empty > td').height,'auto','the empty row keeps height auto');
const allowedCellHeights=new Set([':is(.sdx, .sdx-layer) .sdx-table th',':is(.sdx, .sdx-layer) .sdx-table td',':is(.sdx, .sdx-layer) .sdx-table tr:not(.sdx-table-empty):has(> td :is(small, .sdx-cell-stack)) > td',':is(.sdx, .sdx-layer) .sdx-data-table tr.sdx-table-empty > td']);
const cellSelector=/\.sdx(-data)?-table\b[^,]*?(?:\s|>)\s*(th|td)(?:[.:\[][^\s>+~]*)?$/;
for(const [file,root] of sheets)root.walkRules(rule=>{
 for(const selector of rule.selectors.map(flat))if(cellSelector.test(selector)&&!allowedCellHeights.has(selector))rule.walkDecls(/^(height|min-height)$/,decl=>assert.fail(`${file}: ${selector} sets ${decl.prop}`));
});
checks++;

// ---- the skeleton row ----
check(only('.sdx-skeleton-bar.sdx-skeleton-row').height,'var(--sd-row-h)','the Skeleton table row uses --sd-row-h');

// ---- the KPI tile ----
const tile=only('.sdx-kpi');
check([tile['min-height'],tile.padding],['var(--sd-kpi-h)','var(--sd-space-3)'],'a tile is at least --sd-kpi-h high with --sd-space-3 padding');
const value=sheet('ui/styles/console.css').nodes.find(node=>node.type==='rule'&&node.selector==='.sdx-kpi-value');
const valueDecls=value.nodes.filter(node=>node.type==='decl').map(decl=>[decl.prop,decl.value]);
const fontAt=valueDecls.findIndex(([prop,text])=>prop==='font'&&text==='var(--sd-text-kpi)');
ok(fontAt>=0&&valueDecls[fontAt+1]?.join(':')==='font-variant-numeric:tabular-nums','the value keeps font: var(--sd-text-kpi), then tabular figures');
sheet('ui/styles/console.css').walkRules(/\.sdx-kpi-value\b/,rule=>rule.walkDecls(/^(font-size|font-weight)$/,decl=>assert.fail(`${rule.selector} sets ${decl.prop} on the value`)));
const label=only('.sdx-kpi-label');ok(label['white-space']==='nowrap','the label stays on one line');
const detail=only('.sdx-kpi-detail');ok(detail['overflow-wrap']==='anywhere'&&!detail['text-overflow'],'details wrap, never an ellipsis');

// ---- the page header gap ----
check(only('.sdx-page-head')['margin-bottom'],'var(--sd-page-head-gap)','the page header gap is the token');
for(const [file,root] of sheets)root.walkRules(rule=>{
 if(!rule.selectors.some(selector=>/\.sdx-page-head(?![\w-])[^\s]*$|\.sdx-page-head-device$/.test(flat(selector))))return;
 if(file==='ui/styles/console.css'&&rule.selector==='.sdx-page-head')return;
 rule.walkDecls(/^margin(-bottom|-block|-block-end)?$/,decl=>assert.fail(`${file}: ${rule.selector} sets ${decl.prop}`));
});
checks++;

// ---- a primary that cannot act looks like a blocked secondary ----
const secondary=only(':is(.sdx, .sdx-layer) .sdx-btn-secondary');
check([secondary.color,secondary.background,secondary['border-color'],secondary['box-shadow']],['var(--sd-ink)','var(--sd-panel)','var(--sd-line)','var(--sd-shadow-sm)'],'the blocked secondary look it copies');
const blockedPrimaries=[
 ['ui/styles/console.css',':is(.sdx, .sdx-layer) .sdx-btn-primary:is(:disabled, [aria-disabled="true"]):not([aria-busy="true"])'],
];
for(const [file,selector] of blockedPrimaries){
 const rule=only(selector,file);
 check([rule.color,rule.background,rule['border-color'],rule['box-shadow']],['var(--sd-ink)','var(--sd-panel)','var(--sd-line)','var(--sd-shadow-sm)'],`${selector}: panel, line, ink and the small shadow`);
 ok(!Object.values(rule).some(text=>text.includes('--sd-accent-grad')),`${selector}: no gradient`);
}
ok(blockedPrimaries[0][1].includes(':not([aria-busy="true"])'),'a loading kit primary keeps the gradient with its spinner');
check(only(':is(.sdx, .sdx-layer) .sdx-btn:is(:disabled, [aria-disabled="true"])').opacity,'.5','the shared blocked opacity');
check(only(':is(.sdx, .sdx-layer) .sdx-btn-primary:hover:not(:disabled, [aria-disabled="true"])').filter,'saturate(1.08)','the gradient hover stays off for a blocked primary');
ok(rulesFor('.sd-console [data-slot="button"][data-variant="default"]:not(:disabled, [aria-disabled="true"]):hover').length===0,'the shadcn primary of the classic panels is gone with components/ui');
let html=render(h(kit.Btn,{variant:'primary',blocked:'No changes'},'Save'));
ok(/^<button type="button" class="sdx-btn sdx-btn-primary" aria-disabled="true" aria-describedby="[^"]+"/.test(html)&&!html.includes(' disabled=""'),'a blocked primary stays focusable with aria-disabled and its reason');
html=render(h(kit.Btn,{variant:'primary',loading:true},'Save'));
ok(/class="sdx-btn sdx-btn-primary" disabled="" aria-disabled="true" aria-busy="true"/.test(html),'a loading primary carries aria-busy, so it keeps the gradient');
// The session card primaries ("Sign in with Microsoft" while it redirects, "Continue" while it waits): no session or
// console rule greys a disabled primary out unless it also excludes [aria-busy="true"].
{
 /** The selector without its :not(…) groups, so ":hover:not(:disabled)" does not read as a disabled state. */
 const positive=selector=>{let out='',depth=0;for(let i=0;i<selector.length;i++){if(depth===0&&selector.startsWith(':not(',i)){depth=1;i+=4;continue;}if(depth>0){if(selector[i]==='(')depth++;else if(selector[i]===')')depth--;continue;}out+=selector[i];}return out;};
 const disabledPrimary=selector=>{const rest=positive(selector);return /\.sdx-btn-primary|\.sd-session-primary/.test(rest)&&/:disabled|\[aria-disabled="true"\]/.test(rest);};
 ok(disabledPrimary('.sd-session-card .sdx-btn.sd-session-primary:disabled')&&disabledPrimary('.sdx-btn-primary:is(:disabled, [aria-disabled="true"])')&&!disabledPrimary('.sdx-btn-primary:hover:not(:disabled, [aria-disabled="true"])')&&!disabledPrimary('.sdx-btn-secondary:disabled'),'self-check: the disabled-primary matcher ignores :not(…) groups');
 const files=['ui/session/session.css','ui/session/identity-entry.css','ui/styles/console.css','app/globals.css'];
 const greyed=[];
 for(const file of files)sheet(file).walkRules(rule=>{
  const background=rule.nodes.some(node=>node.type==='decl'&&/^background(-color)?$/.test(node.prop)&&node.value.includes('var(--sd-panel)'));
  if(!background)return;
  for(const selector of rule.selectors.map(flat))if(disabledPrimary(selector)&&!selector.includes(':not([aria-busy="true"])'))greyed.push(`${file}: ${selector}`);
 });
 check(greyed,[],'every blocked-primary panel rule in the session and console sheets excludes [aria-busy="true"]');
 html=render(h(kit.Btn,{variant:'primary',className:'sd-session-primary',loading:true},'Continue'));
 ok(/class="sdx-btn sdx-btn-primary sd-session-primary" disabled="" aria-disabled="true" aria-busy="true"/.test(html),'a loading session primary is aria-busy and keeps sdx-btn-primary, so the kit gradient stays');
 const {EntraSignInChoice}=await import('../../../ui/session/identity-entry.tsx');
 html=render(h(EntraSignInChoice,{redirecting:true,onStart(){}}));
 ok(/class="sdx-btn sdx-btn-primary sd-session-primary"[^>]*aria-busy="true"/.test(html)&&html.includes('Sign in with Microsoft'),'"Sign in with Microsoft" while it redirects is a busy session primary');
 html=render(h(EntraSignInChoice,{redirecting:false,blocked:'Wait.',onStart(){}}));
 ok(/class="sdx-btn sdx-btn-primary sd-session-primary" aria-disabled="true"/.test(html)&&!html.includes('aria-busy'),'a blocked (not loading) session primary takes the blocked-secondary rule');
 const gate=read('ui/session/session-gate.tsx');
 ok(!gate.includes('confirm.waiting')&&!gate.includes('session.entraContinue'),'the gate has no Microsoft "Continue" card any more: a lost Entra session goes to "Sign in with Microsoft" above');
}

// ---- the stable scrollbar gutter ----
check(only('.sdx-main')['scrollbar-gutter'],'stable','the workspace keeps its scrollbar gutter');

// ---- tab count tones without .active ----
check(only('.sdx-tabbar .sdx-tab b.sdx-count-warning'),{color:'var(--sd-warn)',background:'var(--sd-warn-bg)'},'a warning count keeps its tone on an inactive tab');
check(only('.sdx-tabbar .sdx-tab b.sdx-count-critical'),{color:'var(--sd-danger)',background:'var(--sd-danger-bg)'},'a critical count keeps its tone on an inactive tab');
ok(/color \.16s var\(--sd-ease-out\)/.test(only('.sdx-tabbar .sdx-tab b').transition),'the count changes its color with .16s --sd-ease-out');

// ---- Tabs without icons ----
const Icon=()=>h('svg',{'data-icon':''});
const items=[{id:'devices',label:'Devices',count:12,icon:Icon},{id:'alarms',label:'Alarms',count:3,tone:'critical',icon:Icon},{id:'settings',label:'Settings',tag:'Paused',icon:Icon}];
for(const variant of ['underline','pill'])for(const overflow of ['scroll','menu']){
 html=render(h(Tabs,{items,value:'devices',onChange:()=>{},label:'Areas',variant,overflow}));
 ok(!/<svg|<i /.test(html),`${variant}/${overflow}: no icon in any tab`);
 ok(html.includes('<span>Alarms</span><b class="sdx-count-critical">3</b>')&&html.includes('<span>Settings</span> <span class="sdx-tag">Paused</span>'),`${variant}/${overflow}: labels, counts and tags stay`);
}
const tabsSource=read('ui/kit/tabs.tsx');
const itemType=tabsSource.slice(tabsSource.indexOf('export type TabItem={'),tabsSource.indexOf('};',tabsSource.indexOf('export type TabItem={')));
ok(!/\bicon\??:/.test(itemType),'TabItem has no icon field');
ok(/entries=\{inMenu\.map\(item=>\(\{id:item\.id,label:item\.label,tag:item\.tag,onSelect/.test(tabsSource)&&!/item\.icon/.test(tabsSource),'the "More" menu entries carry no icon');
ok(!/icon:/.test(read('ui/devices/fleet/fleet-scope.ts')),'fleetScopeTabs carry no icon');
ok(!/scopeTabIcons/.test(read('ui/devices/fleet/fleet.tsx')),'no scopeTabIcons');
const device=read('ui/devices/device/device.tsx');
ok(!/deviceTabs:ReadonlyArray<\{[^}]*icon/.test(device)&&!/const areaTabs:TabItem\[\]=\[[\s\S]*?icon:[\s\S]*?\n \];/.test(device),'deviceTabs and the panel tabs of device.tsx carry no icon');

// ---- single-line NavList and NavGroups ----
const entries=[{id:'accounts',label:'Accounts',icon:Users,href:'#administration/accounts'},{id:'settings',label:'Security',icon:Settings,href:'#administration/settings'}];
html=renderToStaticMarkup(h(shell.NavList,{items:entries,value:'settings',onSelect:()=>{},label:'Users'}));
const links=[...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)];
check(links.length,2,'one link per entry');
for(const [whole,inner] of links){
 check((inner.match(/<strong class="sdx-navlist-label">/g)||[]).length,1,'one strong label per entry');
 ok(!/<small|title=|sdx-navlist-icon|sdx-navlist-text/.test(whole),'no hint, no small, no title, no icon tile');
 ok(/^<svg[^>]*width="16"[^>]*class="lucide [^"]*sdx-navlist-glyph"/.test(inner),'a 16px lucide glyph first, without a tile');
}
ok(/<a href="#administration\/settings" class="active" aria-current="page">/.test(html)&&/<a href="#administration\/accounts" class="">/.test(html),'the active entry has aria-current="page"');
ok(!('description' in entries[0])&&!/description/.test(read('ui/shell/shell.tsx').match(/export type NavEntry=\{[^}]*\}/)[0]),'NavEntry has no description field');
const navLink=only('.sdx-navlist a');
check([navLink.height,navLink.display],['var(--sd-nav-row-h)','flex'],'an entry is one line, --sd-nav-row-h (36px) high');
check(only('.sdx-tree-row').height,'var(--sd-tree-row-h)','a tree row is --sd-tree-row-h (32px) high');
check(only('.sdx-navlist a.active'),{background:'var(--sd-accent-soft)','box-shadow':'inset 3px 0 0 var(--sd-accent)'},'selection: accent-soft fill and a 3px accent bar on the leading edge');
check(only('.sdx-navlist a.active .sdx-navlist-label').color,'var(--sd-accent-strong)','the active label in --sd-accent-strong');
check([only('.sdx-navlist-glyph').color,only('.sdx-navlist a.active .sdx-navlist-glyph').color],['var(--sd-muted)','var(--sd-accent)'],'the glyph in --sd-muted, accent when active');
ok(!only('.sdx-navlist-glyph').background&&!only('.sdx-navlist-glyph')['box-shadow'],'no tile around the glyph');
check(only('.sdx-navlist a:active').transform,'scale(.98)','the press stays');
ok(only('.sdx-navlist a:hover').background==='var(--sdx-hover)','the hover stays');
html=renderToStaticMarkup(h(shell.NavGroups,{label:'Settings',value:'settings',onSelect:()=>{},groups:[{label:'Users',items:[entries[0]]},{label:'Empty',items:[]},{label:'Portal',items:[entries[1]]}]}));
check([...html.matchAll(/<h3 class="sdx-navlist-heading">([^<]+)<\/h3>/g)].map(match=>match[1]),['Users','Portal'],'headings stay; an empty group is left out');
ok(!sheets.some(([,root])=>{let found=false;root.walkRules(rule=>{if(/sdx-navlist-text|sdx-navlist[^,]*small/.test(rule.selector))found=true;});return found;}),'no hint rule, also not in the narrow layout');

// ---- the KpiRow rule ----
const row=(...tiles)=>render(h(kit.KpiRow,{label:'Row'},...tiles.map((props,index)=>h(kit.Kpi,{key:String(index),label:'T'+index,...props}))));
const labels=markup=>[...markup.matchAll(/<h3 class="sdx-kpi-label" title="([^"]+)">/g)].map(match=>match[1]);
check(labels(row({value:1},{value:null},{value:'—'},{value:4,total:4},{value:3,total:4},{value:0})),['T0','T4','T5'],'no tile without a value, with "—" or with value equal to total; 0 and a value below its total stay');
check(labels(row({value:null,live:true},{value:2})),['T0','T1'],'a live tile without a value stays');
ok(row({value:null,live:true},{value:2}).includes('<span class="sdx-kpi-value">—</span>'),'and shows "—"');
check(row({value:null},{value:null}),'','no tile left: no section');
check(row({value:1},{value:null}),'','one tile left: no section');
check(row({value:1}),'','a single tile: no section');
ok(row({value:1},{value:2}).startsWith('<section class="sdx-kpi-row" aria-label="Row">'),'two tiles: the row');
ok(row({value:null,live:true},{value:null,live:true}).startsWith('<section class="sdx-kpi-row"'),'two live tiles without values still form a row (offline device)');
check(labels(render(h(kit.KpiRow,{label:'Row'},false,null,h(kit.Kpi,{label:'A',value:1}),[h(kit.Kpi,{key:'b',label:'B',value:2}),h(kit.Kpi,{key:'c',label:'C',value:null})]))),['A','B'],'conditional children and arrays are flattened and filtered');
ok(render(h(kit.KpiRow,{label:'Row'},h('div',{className:'custom'}),h(kit.Kpi,{label:'A',value:1}))).includes('class="custom"'),'a child that is not a Kpi counts as a tile');
const sources={summary:read('ui/devices/device/device-summary.tsx'),hardware:read('ui/devices/hardware/device-hardware.tsx'),gpu:read('ui/devices/hardware/device-gpu.tsx')};
for(const key of ['"cpu"','"memory"','{gpu.id}','"storage"'])ok(sources.summary.includes(`<Kpi live key=${key}`),`the Overview tile ${key} is live`);
ok(!sources.summary.includes('<Kpi live key="uptime"'),'Uptime is a System fact, not a tile');
for(const key of ['"load"','"queue"','"used"','"latency"','"read"','"write"'])ok(sources.hardware.includes(`<Kpi live key=${key}`),`the Hardware tile ${key} is live`);
for(const key of ['"utilization"','"vram"'])ok(sources.gpu.includes(`<Kpi live key=${key}`),`the GPU tile ${key} is live`);
ok(/<Kpi key="up" label=\{t\('network\.status\.up'\)\} value=\{known\?up:null\} total=\{known\?adapters\.length:undefined\}/.test(read('ui/devices/management/device-network-panel.tsx')),'Network "Up" passes the adapters as total');
ok(/<Kpi key="ad" label=\{t\('dns\.kpi\.ad'\)\} value=\{kpis\.ad\} total=\{kpis\.zones\}/.test(read('ui/devices/extensions/device-dns.tsx')),'DNS "AD-integrated" passes the zones as total');
ok(/<Kpi label=\{t\('desired\.compliant'\)\} value=\{counts\.compliant\} total=\{counts\.assigned\}/.test(read('ui/automation/desired-state-panel.tsx')),'Desired State "Compliant" passes the assigned count as total');

console.log(`PASS ui density (${checks} checks): the density tokens and the table, skeleton, KPI tile and page header rules that use them, no other stylesheet with row heights or header margins, the blocked primary look of the kit, the scrollbar gutter, tab count tones without .active, Tabs without icons, the single-line NavList and NavGroups, and the KpiRow rule with live and total.`);
