// The UI foundation (nodiverna-ui §8): the motion, spacing and KPI tokens in
// app/globals.css, the one motion file ui/styles/motion.css with the nine shared
// keyframes, and the kit parts IconTile, Kpi, KpiRow, Sparkline, Card
// interactive and iconTone, EntranceList and Skeleton, rendered with React SSR. Then
// the device Overview with the kit KPI tiles, sparklines and icon tiles. The
// KpiRow rule (tiles without a value, value equal to total, fewer than two
// tiles) is in tests/ui/styles/ui-density.mjs. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {postcss} from '../../support/theme-colors.mjs';
const h=React.createElement;
const kit=await import('../../../ui/kit/kit.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {default:DeviceSummary}=await import('../../../ui/devices/device/device-summary.tsx');
const {demoData}=await import('../../../ui/shell/demo.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const Icon=({size})=>h('i',{'data-size':size});

// ---- Tokens: defined once in :root of globals.css ----
const globals=read('app/globals.css'),root=postcss.parse(globals);
const rootDecls=new Map();
root.each(node=>{if(node.type==='rule'&&node.selector.trim()===':root')node.walkDecls(decl=>{if(!rootDecls.has(decl.prop))rootDecls.set(decl.prop,[]);rootDecls.get(decl.prop).push(decl.value);});});
const expectedTokens={'--sd-dur-fast':'120ms','--sd-dur':'180ms','--sd-dur-slow':'260ms','--sd-space-1':'4px','--sd-space-2':'8px','--sd-space-3':'12px','--sd-space-4':'16px','--sd-space-5':'24px','--sd-space-6':'32px'};
for(const [name,value] of Object.entries(expectedTokens))check(rootDecls.get(name),[value],`${name} is ${value}, declared once`);
const kpiFont=rootDecls.get('--sd-text-kpi');
check(kpiFont?.length,1,'--sd-text-kpi is declared once');
ok(/^650 22px(\/[\d.]+)? var\(--sd-font\)$/.test(kpiFont[0]),'--sd-text-kpi is a font shorthand: 650, 22px, var(--sd-font)');
ok(/@import "\.\.\/ui\/styles\/motion\.css";/.test(globals),'globals.css imports ui/styles/motion.css');

// ---- One motion file ----
const walk=dir=>!existsSync(dir)?[]:readdirSync(dir).flatMap(name=>{const file=path.posix.join(dir,name);return statSync(file).isDirectory()?walk(file):/\.(css|tsx?)$/.test(name)?[file]:[];});
const files=[...walk('app'),...walk('ui')];
const nine=['sdx-rise','sdx-fade','sdx-spin','sdx-shimmer','sdx-pulse','sdx-pop','sdx-progress','sdx-sheet-in','sdx-sheet-out'];
const old=['spin','sd-access-loading','sd-security-shimmer','sd-agent-check','sd-palette-fade','sd-palette-in','sd-enter','sd-network-spin','sdu-spin','sdu-skeleton','sd-diagnosis-spin','sd-loading-pulse','sd-rdp-spin','sd-session-loading-spin','sd-skeleton','sd-storage-spin','sd-suggest-in','sd-terminal-spin','sdx-menu'];
const withoutComments=text=>text.replace(/\/\*[\s\S]*?\*\//g,'');
const keyframes=[];
for(const file of files){
 const text=withoutComments(read(file));
 for(const match of text.matchAll(/@keyframes\s+([\w-]+)/g))keyframes.push([file,match[1]]);
}
check([...new Set(keyframes.map(([file])=>file))],['ui/styles/motion.css'],'@keyframes only in ui/styles/motion.css');
check(keyframes.map(([,name])=>name).sort(),[...nine].sort(),'motion.css defines exactly the nine shared keyframes');
const timing=new Set(['linear','ease','ease-in','ease-out','ease-in-out','step-start','step-end','infinite','normal','reverse','alternate','alternate-reverse','forwards','backwards','both','running','paused']);
const animations=[];
for(const file of files.filter(file=>/^(app|ui)\//.test(file)&&file.endsWith('.css')))postcss.parse(read(file)).walkDecls(/^animation(-name)?$/,decl=>animations.push([file,decl.prop,decl.value.trim()]));
for(const file of files.filter(file=>/\.tsx?$/.test(file)))for(const match of read(file).matchAll(/\banimation(?:Name)?\s*:\s*['"`]([^'"`]+)['"`]/g))animations.push([file,'animation',match[1].trim()]);
ok(animations.length>=30,`the animation declarations are found (${animations.length})`);
for(const [file,prop,value] of animations){
 if(value==='none')continue;
 const names=value.split(/[\s,]+/).filter(token=>/^[a-z][\w-]*$/i.test(token)&&!timing.has(token));
 ok(names.length>0&&names.every(name=>nine.includes(name)),`${file}: ${prop}: ${value} names one of the nine keyframes`);
 ok(!names.some(name=>old.includes(name)),`${file}: ${value} names no removed keyframes`);
 // One-shot motion between 100 and 300 ms takes a duration token.
 if(prop==='animation'&&!/\binfinite\b/.test(value)){
  const literal=[...value.matchAll(/(?:^|\s)(\d*\.?\d+)(ms|s)(?=\s|$|,)/g)].map(([,amount,unit])=>Number(amount)*(unit==='s'?1000:1));
  ok(!literal.some(ms=>ms>=100&&ms<=300),`${file}: ${value} takes its duration from a token`);
 }
}
ok(/\.spin\{animation:sdx-spin /.test(globals),'.spin uses sdx-spin');
const motion=read('ui/styles/motion.css'),motionRoot=postcss.parse(motion);
let reduced=null;
motionRoot.walkAtRules('media',rule=>{if(/prefers-reduced-motion:\s*reduce/.test(rule.params))reduced=rule;});
ok(reduced,'motion.css has its own reduced-motion block');
const reducedSelectors=[];
reduced.walkDecls('animation',decl=>{if(decl.value==='none')reducedSelectors.push(...decl.parent.selector.split(',').map(part=>part.trim()));});
for(const selector of ['.sdx-enter','.sdx-spin','.sdx-skeleton-bar','.sdx-menu','.sdx-confirm-dialog','.sdx-drawer','.sdx-dock-progress i'])ok(reducedSelectors.includes(selector),`reduced motion stops ${selector}`);
motionRoot.walkAtRules('keyframes',rule=>rule.walkDecls(decl=>ok(!/#|rgb|hsl|color/.test(decl.prop+decl.value),`${rule.params}: no color in a keyframe`)));
// No resting state waits for an animation: the entrance fills backwards only.
ok(/\.sdx-enter \{[^}]*animation: sdx-rise var\(--sd-dur\) var\(--sd-ease-out\) backwards;/.test(motion),'the entrance uses --sd-dur, --sd-ease-out and fills backwards');
ok(/translateY\(var\(--sdx-rise-from, 6px\)\)/.test(motion),'the rise distance comes from --sdx-rise-from (6px)');
ok(/--sdx-rise-from: -4px;/.test(read('ui/kit/suggest-input.css')),'the suggest list rises from -4px');
// My account and the session screens load with the kit Skeleton; their own loading looks are gone.
ok(['app/account-loading.css','app/account-loading.tsx','app/session-loading.css','app/session-loading.tsx'].every(file=>{try{statSync(file);return false;}catch{return true;}}),'the account and session loading looks are deleted');

// ---- KPI value: one shared rule ----
const redesign=postcss.parse(read('ui/styles/console.css'));
const kpiRules=[];
redesign.walkRules(rule=>{if(/\.sdx-kpi-value\b/.test(rule.selector))kpiRules.push(rule);});
const valueRule=kpiRules.find(rule=>rule.selector==='.sdx-kpi-value');
ok(valueRule,'the kit value class');
const valueDecls=valueRule.nodes.filter(node=>node.type==='decl').map(decl=>[decl.prop,decl.value]);
const fontIndex=valueDecls.findIndex(([prop,value])=>prop==='font'&&value==='var(--sd-text-kpi)');
ok(fontIndex>=0&&valueDecls[fontIndex+1]?.[0]==='font-variant-numeric'&&valueDecls[fontIndex+1][1]==='tabular-nums','font: var(--sd-text-kpi) then tabular figures');
for(const rule of kpiRules)rule.walkDecls(/^(font-size|font-weight)$/,decl=>assert.fail(`${rule.selector} redefines ${decl.prop}`));
checks++;

// ---- Entrance helpers ----
check([kit.entranceDelay(0),kit.entranceDelay(1),kit.entranceDelay(7),kit.entranceDelay(8),kit.entranceDelay(20)],[0,24,168,null,null],'entrance delays');
check([kit.claimEntrance('x'),kit.claimEntrance('x'),kit.claimEntrance('y')],[true,false,true],'an id plays once');

// ---- Sparkline ----
check(kit.sparklineValues([1,null,Number.NaN,2,Infinity,-Infinity,undefined,3]),[1,2,3],'non-finite values are dropped');
check(render(h(kit.Sparkline,{values:[4,null,Number.NaN],label:'CPU'})),'','fewer than 2 values render nothing');
let html=render(h(kit.Sparkline,{values:[4,8,6],label:'CPU over the last 60 minutes'}));
ok(html.startsWith('<div class="sdx-sparkline" role="img" aria-label="CPU over the last 60 minutes">'),'the sparkline wrapper is an image with its label');
// The Sparkline alone: the kit's buttons use the console Tooltip, which is not a chart tooltip.
const kitSource=read('ui/kit/kit.tsx'),sparkSource=kitSource.slice(kitSource.indexOf('const sparklineStroke='),kitSource.indexOf('// Entrance registry'));
ok(/<Line type="monotone" dataKey="value" stroke=\{sparklineStroke\[tone\?\?'normal'\]\}[^>]*dot=\{false\}[^>]*isAnimationActive=\{false\}/.test(sparkSource)&&!/<(XAxis|YAxis|CartesianGrid|Tooltip)\b/.test(sparkSource),'one line, no axes, grid, tooltip, dots or animation');
ok(/normal:chartSeries,warning:'var\(--sd-warn\)',critical:'var\(--sd-danger\)'/.test(sparkSource)&&kitSource.includes("import {chartSeries} from '@/ui/kit/chart';")&&read('ui/kit/chart.ts').includes("export const chartSeries='var(--sd-meter)';"),'the stroke is a token: the data color --sd-meter, warn and danger past their thresholds');

// ---- IconTile ----
for(const tone of ['accent','success','warning','danger','neutral'])for(const size of ['sm','md']){
 html=render(h(kit.IconTile,{icon:Icon,tone,size}));
 check(html,`<span class="sdx-icon-tile sdx-icon-tile-${tone}${size==='sm'?' sdx-icon-tile-sm':''}" aria-hidden="true"><i data-size="${size==='sm'?15:16}"></i></span>`,`IconTile ${tone} ${size}`);
}
ok(render(h(kit.IconTile,{icon:Icon})).includes('class="sdx-icon-tile sdx-icon-tile-accent"'),'accent and 32px by default');

// ---- Kpi ----
html=render(h(kit.Kpi,{label:'Online',value:1234,icon:Icon,tone:'success',detail:'of 1,300 devices'}));
ok(html.startsWith('<article class="sdx-kpi" aria-label="Online: 1,234">'),'static Kpi: article with the aria-label');
ok(html.includes('<span class="sdx-kpi-value">1,234</span>')&&html.includes('<span class="sdx-kpi-detail" title="of 1,300 devices">of 1,300 devices</span>'),'value formatted in the locale, detail below it');
ok(html.includes('sdx-icon-tile sdx-icon-tile-success sdx-icon-tile-sm'),'the label sits next to its icon tile');
ok(render(h(kit.Kpi,{label:'Online',value:1234}),'de').includes('<span class="sdx-kpi-value">1.234</span>'),'German number format');
html=render(h(kit.KpiRow,{label:'Live'},h(kit.Kpi,{key:'cpu',label:'CPU',value:null,unit:'%',live:true}),h(kit.Kpi,{key:'ram',label:'RAM',value:40,unit:'%',live:true})));
ok(html.includes('aria-label="CPU: Not available"')&&html.includes('<span class="sdx-kpi-value">—</span>')&&!html.includes('<span class="sdx-kpi-value">—<small'),'a live tile without a value stays in its row with a dash, no unit');
ok(render(h(kit.Kpi,{label:'CPU',value:42.4,unit:'%'})).includes('aria-label="CPU: 42 %"'),'the unit is part of the aria value');
ok(render(h(kit.Kpi,{label:'A',value:3,tone:'warning'})).startsWith('<article class="sdx-kpi sdx-kpi-warning"'),'warning colors the value');
ok(render(h(kit.Kpi,{label:'A',value:3,tone:'critical',icon:Icon})).includes('sdx-kpi sdx-kpi-critical')&&render(h(kit.Kpi,{label:'A',value:3,tone:'critical',icon:Icon})).includes('sdx-icon-tile-danger'),'critical colors the value, the tile is danger');
ok(!render(h(kit.Kpi,{label:'A',value:3,tone:'success'})).includes('sdx-kpi-success'),'success does not color the value');
ok(render(h(kit.Kpi,{label:'A',value:3,action:h('button',{type:'button'},'go')})).includes('<button type="button">go</button></div>'),'the action sits in the head');
ok(!render(h(kit.Kpi,{label:'A',value:3})).includes('sdx-lift'),'a static Kpi does not lift');
html=render(h(kit.Kpi,{label:'With problems',value:2,tone:'critical',icon:Icon,detail:'1 critical',hint:'Show problems',onSelect:()=>{}}));
ok(html.startsWith('<button type="button" class="sdx-kpi sdx-kpi-critical sdx-kpi-button sdx-lift" title="Show problems">'),'interactive Kpi: a button with the lift and the hint as title');
ok(html.endsWith('<span class="sr-only">Show problems</span></button>')&&!html.includes('<article')&&!html.includes('aria-label'),'the visible content and the sr-only hint are its name');
ok(!/<(div|h3|header)\b/.test(html),'only phrasing content inside the button');

// ---- Kpi pressed: a filter tile that is on ----
html=render(h(kit.Kpi,{label:'Running',value:4,icon:Icon,hint:'Show running',onSelect:()=>{},pressed:true}));
ok(html.startsWith('<button type="button" class="sdx-kpi sdx-kpi-button sdx-lift sdx-kpi-pressed" title="Show running" aria-pressed="true">'),'pressed: aria-pressed and the selection class');
ok(render(h(kit.Kpi,{label:'Running',value:4,onSelect:()=>{},pressed:false})).startsWith('<button type="button" class="sdx-kpi sdx-kpi-button sdx-lift" aria-pressed="false">'),'not pressed: aria-pressed false, no selection class');
ok(!render(h(kit.Kpi,{label:'With problems',value:2,onSelect:()=>{}})).includes('aria-pressed'),'without pressed there is no aria-pressed');
ok(/\.sdx-kpi-pressed, \.sdx-kpi-pressed\.sdx-lift:hover, \.sdx-kpi-pressed\.sdx-lift:focus-within \{[^}]*background: var\(--sd-accent-soft\);[^}]*inset 3px 0 0 var\(--sd-accent\);/.test(read('ui/styles/console.css')),'the selection look: accent-soft fill and a leading accent bar');

// ---- SectionHead hideTitle: the subarea name is only the accessible heading ----
html=render(h(kit.SectionHead,{title:'Services',hideTitle:true,id:'services-head',icon:Icon,iconTone:'accent',description:'Find and manage services.',meta:'12 collected',actions:h('button',{type:'button'},'Refresh'),primary:h('button',{type:'button'},'Add')}));
check(html,'<header class="sdx-section-head"><div class="sdx-section-head-text"><h2 id="services-head" class="sr-only">Services</h2><p>Find and manage services.</p><p class="sdx-section-head-meta">12 collected</p></div><div class="sdx-section-head-actions"><button type="button">Refresh</button><button type="button">Add</button></div></header>','hideTitle: an sr-only h2 with its id, no icon, the description, meta, actions and primary');
ok(render(h(kit.SectionHead,{title:'Services',icon:Icon})).includes('<h2><i data-size="15"></i>Services</h2>'),'without hideTitle the title and icon show');
ok(render(h(kit.Card,{title:'Plan',id:'plan',focusTarget:true},h('p',null,'x'))).includes('<h2 id="plan" tabindex="-1">'),'a Card heading can be a focus target');
// ---- Unavailable with the panel sentence (PanelUnavailable) ----
check(render(h(kit.PanelUnavailable,{reason:'demo',readOnly:'You can still read the network settings.'})).match(/<div>([^<]*)<\/div>/)?.[1],'Not available for sample devices. You can still read the network settings.','two full sentences');
check(render(h(kit.PanelUnavailable,{reason:null,readOnly:'x'})),'','nothing without a reason');

// ---- KpiRow ----
html=render(h(kit.KpiRow,{label:'Status of the devices in this view'},h(kit.Kpi,{key:'a',label:'A',value:1}),h(kit.Kpi,{key:'b',label:'B',value:2})));
ok(html.startsWith('<section class="sdx-kpi-row" aria-label="Status of the devices in this view"><div class="sdx-kpi-grid"><article'),'a labelled section with the grid');
html=render(h(kit.KpiRow,{label:'Row',entranceId:'row-test'},h(kit.Kpi,{key:'a',label:'A',value:1}),h(kit.Kpi,{key:'b',label:'B',value:2})));
ok(html.includes('<article class="sdx-kpi sdx-enter" style="animation-delay:0ms"')&&html.includes('<article class="sdx-kpi sdx-enter" style="animation-delay:24ms"'),'with entranceId the tiles stagger in');
const kpiCss=read('ui/styles/console.css');
ok(/\.sdx-kpi-grid \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(min\(200px, 100%\), 1fr\)\); gap: var\(--sd-space-3\); \}/.test(kpiCss),'auto-fit grid, min 200px, gap --sd-space-3');
ok(/@media \(max-width: 760px\) \{\s*\.sdx-kpi-row \{[^}]*overflow-x: auto;[^}]*\}\s*\.sdx-kpi-row \.sdx-kpi-grid \{ display: flex; flex-wrap: nowrap;/.test(kpiCss),'at 760px and below one compact line that scrolls inside the row (tests/ui/shell/overlays-mobile.mjs checks the rest)');

// ---- Card ----
const cardProps={title:'Title',icon:Icon,meta:'Meta',actions:h('b',null,'A'),id:'c1'};
check(render(h(kit.Card,cardProps,h('p',null,'Body'))),'<section class="sdx-card" aria-labelledby="c1"><header class="sdx-section-head sdx-card-head"><div class="sdx-section-head-text"><h2 id="c1"><i data-size="15"></i>Title</h2><p class="sdx-section-head-meta">Meta</p></div><div class="sdx-section-head-actions sdx-card-actions"><b>A</b></div></header><p>Body</p></section>','Card renders its head through SectionHead with the same structure and classes as before (sdx-card-head, h2, p, sdx-card-actions)');
ok(render(h(kit.Card,{...cardProps,description:'What it holds'},h('p',null,'Body'))).includes('</h2><p>What it holds</p><p class="sdx-section-head-meta">Meta</p></div>'),'the new description goes through to SectionHead, before the meta');
check(render(h(kit.Card,{actions:h('b',null,'A')},h('p',null,'Body'))),'<section class="sdx-card"><header class="sdx-section-head sdx-card-head"><div class="sdx-section-head-text"></div><div class="sdx-section-head-actions sdx-card-actions"><b>A</b></div></header><p>Body</p></section>','actions without a title keep the head');
check(render(h(kit.Card,{flush:true},h('p',null,'Body'))),'<section class="sdx-card sdx-card-flush"><p>Body</p></section>','a card without head');
html=render(h(kit.Card,{...cardProps,iconTone:'danger'},h('p',null,'Body')));
ok(html.includes('<h2 id="c1"><span class="sdx-icon-tile sdx-icon-tile-danger sdx-icon-tile-sm" aria-hidden="true"><i data-size="15"></i></span>Title</h2>'),'iconTone renders an IconTile in front of the title');
html=render(h(kit.Card,{...cardProps,interactive:true,onOpen:()=>{}},h('p',null,'Body')));
ok(html.startsWith('<section class="sdx-card sdx-card-interactive sdx-lift"')&&html.includes('<h2 id="c1"><i data-size="15"></i><button type="button" class="sdx-card-hit">Title</button></h2>'),'interactive: the title is the stretched button');
html=render(h(kit.Card,{interactive:true,onOpen:()=>{},openLabel:'Open drives'},h('p',null,'Body')));
ok(html.startsWith('<section class="sdx-card sdx-card-interactive sdx-lift"><button type="button" class="sdx-card-hit sdx-card-hit-bare"><span class="sr-only">Open drives</span></button>'),'interactive without a title: openLabel as sr-only text');
const pressed=[];
const element=kit.Card({interactive:true,onOpen:()=>pressed.push('open'),openLabel:'Open',children:'x'});
[element.props.children].flat(Infinity).find(node=>node?.props?.className?.startsWith('sdx-card-hit')).props.onClick();
check(pressed,['open'],'the hit button opens');
ok(/\.sdx-lift:hover, \.sdx-lift:focus-within \{ border-color: var\(--sdx-edge\); box-shadow: var\(--sd-shadow-md\); transform: translateY\(-1px\); \}/.test(kpiCss)&&/\.sdx-lift:active \{ box-shadow: var\(--sd-shadow-sm\); transform: none; \}/.test(kpiCss),'lift on hover and focus, back on press');
ok(/\.sdx-lift \{ transition: box-shadow var\(--sd-dur-fast\) var\(--sd-ease-out\)/.test(kpiCss),'the lift uses --sd-dur-fast and --sd-ease-out');
ok(!/\.sdx-card:hover/.test(kpiCss),'a static card has no hover rule');

// ---- EntranceList ----
const items=count=>Array.from({length:count},(_,index)=>h('li',{key:`i${index}`,className:index===0?'first':undefined},`Item ${index}`));
html=render(h(kit.EntranceList,{id:'list-a',as:'ul',className:'list'},items(10)));
const lis=[...html.matchAll(/<li([^>]*)>/g)].map(match=>match[1]);
check(lis.length,10,'ten items');
check(lis.slice(0,8).map(attributes=>attributes.match(/animation-delay:(\d+)ms/)?.[1]),['0','24','48','72','96','120','144','168'],'the first 8 items stagger by 24 ms');
ok(lis[0].includes('class="first sdx-enter"')&&lis.slice(1,8).every(attributes=>attributes.includes('class="sdx-enter"')),'the first 8 items get the entrance class, own classes stay');
ok(lis.slice(8).every(attributes=>attributes===''),'the 9th and later show at once');
ok(html.startsWith('<ul class="list">'),'renders in the given element');
html=render(h(kit.EntranceList,{id:'list-a',as:'ul'},items(3)));
ok(!html.includes('sdx-enter')&&!html.includes('animation-delay'),'a second render with the same id shows the items at once');
html=render(h(kit.EntranceList,{id:'list-b'},[]));
ok(html==='<div></div>'&&kit.claimEntrance('list-b'),'an empty list does not use up its entrance');
html=renderToStaticMarkup(h('table',null,h(kit.EntranceList,{id:'rows-a',as:'tbody'},h('tr',{key:'r'},h('td',null,'x')))));
ok(html.includes('<tbody><tr class="sdx-enter" style="animation-delay:0ms"><td>x</td></tr></tbody>'),'table rows enter as tbody children');

// ---- Device Overview with the kit parts ----
const {servers}=demoData(),now=Date.now();
const server=servers.find(item=>item.id==='demo-app');
const owner={id:'owner',label:'owner',permissions:['*']},noop=()=>{};
const summary=(samples)=>render(h(DeviceSummary,{server,viewer:owner,demo:true,now,samples,jobs:[],historyLoading:false,onNavigate:noop,onRefreshInventory:noop,refreshBlocked:'',onOpenEsuGroup:noop,onRefresh:noop}));
const recent=[{serverId:'demo-app',at:now-20*60000,cpu:21,memory:48},{serverId:'demo-app',at:now-10*60000,cpu:35,memory:52},{serverId:'demo-app',at:now-60000,cpu:28,memory:50}];
html=summary(recent);
ok(html.includes('<section class="sdx-kpi-row" aria-label="Current agent values">'),'the KPI tiles sit in a KpiRow');
const kpis=[...html.matchAll(/<article class="sdx-kpi[^"]*"[^>]*aria-label="([^"]+)"/g)].map(match=>match[1]);
ok(kpis.length>=4&&kpis[0].startsWith('CPU: ')&&kpis[1].startsWith('RAM: ')&&kpis.length<=4&&kpis.at(-1).startsWith('Fullest drive C:')&&!kpis.some(label=>label.startsWith('Uptime: ')),`at most four tiles in their order, the fullest drive last: ${kpis.join(' | ')}`);
ok(/<article class="sdx-kpi[^"]*"[^>]*aria-label="CPU: [^"]+"><div class="sdx-kpi-head"><span class="sdx-icon-tile sdx-icon-tile-(accent|warning|danger|neutral) sdx-icon-tile-sm"/.test(html),'the head icon is an IconTile');
ok(html.includes('role="img" aria-label="CPU over the last 60 minutes"')&&html.includes('role="img" aria-label="RAM over the last 60 minutes"'),'CPU and RAM show the sparkline with 2 or more values in the last hour');
ok(/aria-label="Fullest drive C:[^"]*"[\s\S]*?class="sdx-meter /.test(html)&&!html.includes('sdx-ring'),'storage shows a meter; no tile uses a ring');
ok(html.includes('class="sdx-protection"')&&/<ul class="sdx-protection"><li><(button|div)[^>]*><span class="sdx-icon-tile sdx-icon-tile-(success|warning|danger|neutral) sdx-icon-tile-sm"/.test(html),'protection rows use IconTile');
ok(!html.includes('sdx-protection-icon')&&!read('ui/styles/console.css').includes('sdx-protection-icon'),'no sdx-protection-icon is left');
ok(/class="sdx-summary-grid"><section class="sdx-card sdx-span-2 sdx-history-card( sdx-enter)?"/.test(html),'the cards sit in the entrance grid');
const heads=[...html.matchAll(/<h2(?: id="[^"]*")?>(<span class="sdx-icon-tile sdx-icon-tile-(\w+) sdx-icon-tile-sm")?/g)].map(match=>match[2]??'none');
ok(heads.length>=5&&heads.every(tone=>tone!=='none'),`the card heads use icon tiles: ${heads.join(', ')}`);
ok(/<section class="sdx-health-line sdx-health-line-critical[^"]*"[^>]*><h2[^>]*class="sr-only">Health<\/h2><div class="sdx-health-line-main"><span class="sdx-health-line-state"><span class="sdx-icon-tile sdx-icon-tile-danger"/.test(html),'the health line leads with a 32 px icon tile in the health tone');
html=summary([]);
ok(!html.includes('sdx-sparkline')&&/aria-label="CPU: [^"]+"[\s\S]*?class="sdx-meter /.test(html),'without samples CPU shows a meter of the current value');
ok(!html.includes('sdx-enter'),'the second device render does not replay the entrance');
ok(!read('ui/devices/device/device-summary.tsx').includes('function Kpi('),'the local Kpi is gone');
ok(!read('ui/devices/device/device-summary.tsx').includes('function Fact(')&&!read('ui/devices/device/device-summary.tsx').includes('<dl className="sdx-facts'),'the local Fact and the hand-written facts list are gone');
ok(/<section class="sdx-card sdx-span-full sdx-system-card"[\s\S]*?<dl class="sdx-facts sdx-facts-3 sdx-facts-stacked">/.test(html),'the System card uses the kit Facts in 3 stacked columns');

// ---- Skeleton: first-load shapes per variant ----
{
 const skeleton=props=>render(h(kit.Skeleton,{label:'Loading devices',...props}));
 const count=(html,name)=>(html.match(new RegExp(`class="sdx-skeleton-bar ${name}"`,'g'))??[]).length;
 let html=skeleton({});
 ok(html.startsWith('<div class="sdx-skeleton-set sdx-skeleton-table" role="status" aria-label="Loading devices"><div class="sdx-skeleton-shapes" aria-hidden="true">'),'table is the default: a status region with its label, the shapes hidden');
 check([count(html,'sdx-skeleton-head'),count(html,'sdx-skeleton-row')],[1,4],'table: a head bar and 4 rows');
 check(count(skeleton({rows:3}),'sdx-skeleton-row'),3,'rows sets the row count');
 html=skeleton({variant:'cards'});
 check([html.includes('sdx-skeleton-cards'),count(html,'sdx-skeleton-card')],[true,3],'cards: 3 blocks by default');
 html=skeleton({variant:'facts'});
 check([(html.match(/class="sdx-skeleton-fact"/g)??[]).length,(html.match(/<i class="sdx-skeleton-bar"><\/i>/g)??[]).length],[4,8],'facts: 4 label/value pairs');
 html=skeleton({variant:'chart'});
 check(count(html,'sdx-skeleton-chart'),1,'chart: one block');
 for(const variant of ['table','cards','facts','chart'])ok(!skeleton({variant,after:3000,action:h('button',null,'Retry')}).includes('sdx-skeleton-slow'),`${variant}: no slow line before the time passed`);
 ok(!skeleton({}).includes('sdx-skeleton-slow'),'without after the slow line never shows');
 const en=(await import('../../../lib/i18n/messages/en.ts')).default,de=(await import('../../../lib/i18n/messages/de.ts')).default;
 check([en['kit.skeleton.slow'],de['kit.skeleton.slow']],['This is taking longer than usual.','Das dauert länger als üblich.'],'the slow line in both catalogs');
 const source=read('ui/kit/kit.tsx');
 ok(/\{after!==undefined&&slow&&<p className="sdx-skeleton-slow"><span>\{t\('kit\.skeleton\.slow'\)\}<\/span>\{action\}<\/p>\}/.test(source)&&/setTimeout\(\(\)=>setSlow\(true\),after\)/.test(source),'after the time the slow line and the action join the status region');
 const css=postcss.parse(read('ui/styles/console.css'));
 const rules=[];css.walkRules(rule=>{if(rule.selectors.some(selector=>/\.sdx-skeleton/.test(selector)))rules.push(rule);});
 const animated=rules.flatMap(rule=>rule.nodes.filter(node=>node.type==='decl'&&/^animation/.test(node.prop)).map(decl=>decl.value));
 ok(animated.length>0&&animated.every(value=>/^sdx-shimmer\b/.test(value)),'.sdx-skeleton* rules animate only with the shared sdx-shimmer');
 ok(rules.some(rule=>rule.selectors.includes('.sdx-skeleton-bar')),'the shimmer sits on .sdx-skeleton-bar');
 ok(reducedSelectors.includes('.sdx-skeleton-bar'),'reduced motion stops .sdx-skeleton-bar');
 // The group Tags tab shows the kit Skeleton while it loads.
 const {default:TagsPanel}=await import('../../../ui/devices/configuration/tags.tsx');
 html=render(h(TagsPanel,{scope:{type:'group',id:'g1'},scopeName:'Berlin',demo:false,onRefresh:()=>{},onOpenOrigin:()=>{}}));
 ok(/<div class="sdx-skeleton-set sdx-skeleton-table" role="status" aria-label="[^"]+">/.test(html)&&count(html,'sdx-skeleton-row')===3&&!html.includes('sdx-loading'),'the group Tags tab loads with Skeleton variant table, 3 rows');
 ok(read('ui/devices/configuration/tags.tsx').includes("<FirstLoad label={t('tags.loading')} rows={3}")&&/<Skeleton variant="table" rows=\{rows\} label=\{label\} after=\{15000\} action=/.test(read('ui/kit/analysis-tab.tsx')),'with the tags.loading label, the slow line after 15 s and the retry (FirstLoad)');
}

// ---- Facts (kit foundations II) ----
{
 const html=render(h(kit.Facts,{items:[{label:'Device',value:'SRV-01'},{label:'Address',value:'10.0.0.4',mono:true,hint:'IPv4'}]}));
 check(html,'<dl class="sdx-facts"><div><dt>Device</dt><dd>SRV-01</dd></div><div><dt>Address</dt><dd><span class="mono">10.0.0.4</span><small>IPv4</small></dd></div></dl>','one div > dt + dd per item, mono on the value, the hint as small');
 ok(render(h(kit.Facts,{items:[{label:'A',value:'1'}],columns:2})).startsWith('<dl class="sdx-facts sdx-facts-2">'),'2 columns');
 ok(render(h(kit.Facts,{items:[{label:'A',value:'1'}],columns:3,className:'x'})).startsWith('<dl class="sdx-facts sdx-facts-3 x">'),'3 columns with the caller class');
 ok(render(h(kit.Facts,{items:[{label:'A',value:'1'}],columns:3,stacked:true})).startsWith('<dl class="sdx-facts sdx-facts-3 sdx-facts-stacked">'),'stacked: the label above the value');
}
// ---- Field ----
{
 const {Field}=await import('../../../ui/kit/field.tsx');
 const control=html=>html.match(/<(input|select)\b[^>]*>/)?.[0]??'';
 const attr=(tag,name)=>tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]??null;
 let html=render(h(Field,{label:'Name',hint:'Shown in the tree.'},h('input',{type:'text'})));
 let input=control(html);const id=attr(input,'id');
 ok(html.startsWith('<div class="sdx-field"><label class="sdx-field-label" for="')&&attr(html.match(/<label[^>]*>/)[0],'for')===id&&id,'the label is bound to the control id');
 const hintId=attr(input,'aria-describedby');
 ok(hintId&&html.includes(`<small id="${hintId}">Shown in the tree.</small>`),'aria-describedby names the hint');
 check(attr(input,'aria-invalid'),null,'no aria-invalid without an error');
 html=render(h(Field,{label:'Name',hint:'Shown in the tree.',error:'Enter a name.'},h('input',{type:'text',id:'own','aria-describedby':'extra'})));
 input=control(html);
 const ids=attr(input,'aria-describedby').split(' ');
 check([attr(input,'id'),ids.length,ids[0]],['own',3,'extra'],'the own id and the caller description are kept, hint and error follow');
 ok(html.includes(`<small id="${ids[1]}">Shown in the tree.</small>`)&&html.includes(`<p id="${ids[2]}" class="sdx-field-error">Enter a name.</p>`),'hint and error carry their own ids');
 check(attr(input,'aria-invalid'),'true','aria-invalid="true" while an error is set');
 html=render(h(Field,{label:'Turn on',hint:'Takes effect at once.',inline:true},h('input',{type:'checkbox',role:'switch'})));
 ok(/^<div class="sdx-field sdx-field-inline"><label><input type="checkbox" role="switch" id="[^"]+" aria-describedby="[^"]+"\/><span>Turn on<\/span><\/label><small id="[^"]+">Takes effect at once\.<\/small><\/div>$/.test(html),'inline wraps the switch in its label, the hint below');
}
// ---- SectionHead ----
{
 let html=render(h(kit.SectionHead,{title:'Software',description:'Installed programs.',meta:'Updated 10:42',icon:Icon,iconTone:'warning',actions:h('b',null,'A'),primary:h('i',null,'P'),id:'s1'}));
 check(html,'<header class="sdx-section-head"><div class="sdx-section-head-text"><h2 id="s1"><span class="sdx-icon-tile sdx-icon-tile-warning sdx-icon-tile-sm" aria-hidden="true"><i data-size="15"></i></span>Software</h2><p>Installed programs.</p><p class="sdx-section-head-meta">Updated 10:42</p></div><div class="sdx-section-head-actions"><b>A</b><i>P</i></div></header>','level 2: the IconTile, description, meta, then actions before primary');
 html=render(h(kit.SectionHead,{title:'Drives',level:3,icon:Icon,className:'x'}));
 check(html,'<header class="sdx-section-head x"><div class="sdx-section-head-text"><h3><i data-size="15"></i>Drives</h3></div></header>','level 3 with a plain icon and no actions box');
}
// ---- Kit foundations II CSS: tokens only, the shared keyframes, reduced motion ----
{
 const css=postcss.parse(read('ui/styles/console.css'));
 const kitRules=[];css.walkRules(rule=>{if(rule.selectors.some(selector=>/\.sdx-(section-head|data-card|confirm|pagination|table-wrap-flush|table-wrap-cards|field-inline)/.test(selector)))kitRules.push(rule);});
 ok(kitRules.length>=20,`the new kit rules are found (${kitRules.length})`);
 const decls=kitRules.flatMap(rule=>rule.nodes.filter(node=>node.type==='decl'));
 ok(decls.every(decl=>!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(decl.value)),'no hex, rgb or hsl values in the new rules');
 ok(decls.filter(decl=>/^(border-radius|box-shadow)$/.test(decl.prop)).every(decl=>/^(0|none|var\(--sd-(radius|radius-sm|radius-lg|shadow-sm|shadow-md|shadow-lg)\))$/.test(decl.value)),'radii and shadows are tokens');
 const animated=decls.filter(decl=>/^animation/.test(decl.prop)).map(decl=>decl.value);
 check(animated,['sdx-fade var(--sd-dur) var(--sd-ease-out)','sdx-rise var(--sd-dur) var(--sd-ease-out)'],'the dialog fades and rises with the shared keyframes in --sd-dur (180 ms)');
 ok(/--sdx-rise-from: 6px;/.test(read('ui/styles/console.css')),'the dialog rises 6px');
 ok(reducedSelectors.includes('.sdx-confirm-dialog')&&reducedSelectors.includes('.sdx-confirm-scrim'),'reduced motion stops the dialog and its scrim');
 ok(/@media \(max-width: 760px\) \{[^@]*\.sdx-facts > div \{ grid-template-columns: minmax\(0, 1fr\); gap: 2px; \}/.test(read('ui/styles/console.css')),'facts put the label above the value at 760px');
}

console.log(`PASS ui foundation (${checks} checks): motion, spacing and KPI tokens, the one motion file with nine keyframes and reduced motion, IconTile, Kpi static and interactive, KpiRow, Sparkline, Card interactive and iconTone, EntranceList, Skeleton with the group Tags tab, the device Overview with kit tiles, sparklines and icon tiles, and Facts, Field, SectionHead with Card through it and the kit foundations II CSS.`);
