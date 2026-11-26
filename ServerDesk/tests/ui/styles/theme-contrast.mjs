// Text contrast of every stylesheet below app/, in light and dark mode.
// Each rule that sets `color` (or `fill` on SVG text) to a color is checked against
// the background of the same rule, or against --sd-panel if the rule sets none.
// A translucent color is composited over --sd-panel; the accent gradient is checked
// at both end points. Text needs 4.5:1, glyphs and dots (svg, ::before, ::after) 3:1.
// Rules of a fixed-dark surface are checked only in dark mode, rules of the
// fixed-light surface only in light mode (globals.css, "Fixed-scheme surfaces").
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import {postcss,rootTokens,resolveColor,contrast,over,toHex,colorLiterals,schemeBlocks} from '../../support/theme-colors.mjs';

const read=file=>readFileSync(file,'utf8');
const walk=dir=>readdirSync(dir).flatMap(name=>{const file=path.posix.join(dir,name);return statSync(file).isDirectory()?walk(file):file.endsWith('.css')?[file]:[];});
const globals=read('app/globals.css');
const tokens=rootTokens(globals);

// Rules inside a fixed-dark surface: the terminal heading and viewport and the
// full-page remote desktop client, with the classes that only occur inside them.
const fixedDark=/\.sd-rdp-client|\.sd-rdp-login|\.sd-rdp-desktop|\.sd-rdp-state|\.sd-terminal-heading|\.sd-terminal-connection|\.sd-terminal-controls|\.v3-terminal-viewport|\.v3-terminal(?![\w-])|\.xterm|\.v3-terminal-panel \.panel-heading|\.v3-terminal-controls/;
// Rules inside the fixed-light surface: the authenticator QR code.
const fixedLight=/\.sd-mfa-qr(?![\w-])|\.sd-mfa-qr-/;

// Pairs that fail on purpose, with the reason. Thresholds stay as they are.
const gradientEnd='White text on the Aurora accent gradient: it passes on the violet start and fails only on the cyan end (#1fb6ff, 2.3:1). The gradient is reserved for primary buttons, the search selection and the logo (CLAUDE.md), and --sd-on-accent on --sd-accent passes 4.5:1 (theme-tokens).';
const onGradientParent='Glyph or text on the accent gradient of its parent rule; this rule sets no background of its own, so the scanner compares it with --sd-panel. The pair on the gradient is the one of the parent rule.';
const kitIcon='Icon wrapper of the console kit: it holds only an svg glyph, so the 3:1 for glyphs applies, and the flat accent reaches 3.4:1 on the dark panel. The kit keeps its look.';
const previewMark='The miniature of .sdx-logo and .sd-session-brand>span in the preview of Settings › Branding: the mark on the gradient of the previewed colors. The gradient is a local custom property that the scanner cannot resolve, so it compares the glyph with --sd-panel. The mark is decorative (aria-hidden), and lib/brand-scheme.ts checks --sd-on-accent on both gradient ends of a brand scheme.';
const exceptions={
 '.sdx-stage-mark':previewMark,
 '.sd-palette-results button[aria-selected="true"]':gradientEnd,
 '.sd-palette-results button[aria-selected="true"] .sd-palette-icon':onGradientParent,
 '.sd-palette-results button[aria-selected="true"] small':onGradientParent,
 ':is(.sdx, .sdx-layer) .sdx-btn-primary':gradientEnd,
 '.sdx-logo':gradientEnd,
 '.sd-session-brand>span':gradientEnd,
 '.sdx-rail-item.active .sdx-rail-icon':kitIcon,
 '.sdx-tree-row.active .sdx-tree-icon':kitIcon,
 '.sdx-tree-row.current .sdx-tree-icon':kitIcon,
 '.sdx-tree-row.drop-target .sdx-tree-icon':kitIcon,
 '.sdx-navlist a.active .sdx-navlist-glyph':kitIcon,
 '.sdx-pick-row.selected .sdx-pick-icon':kitIcon,
 '.sdx-pick-check':kitIcon,
 '.sdx-menu-check':kitIcon,
 'html[data-ui="redesign"] select:not([multiple]) option::checkmark':kitIcon,
};

const isTokenBlock=node=>node.type==='rule'&&node.parent.type==='root'&&(node.selector.trim()===':root'||/data-scheme-(?:light|dark)/.test(node.selector));
const skipped=selector=>/:disabled|\[disabled\]|\[aria-disabled/.test(selector);
const glyph=part=>{const compounds=part.trim().split(/\s*[\s>+~]\s*(?![^[(]*[\])])/);const last=compounds[compounds.length-1];return /(?:^|[^\w-])svg(?![\w-])|::?(?:before|after)\b/.test(last);};
const flat=text=>text.replace(/\s+/g,' ').trim();

/**
 * Scans parsed stylesheets. Returns {checked, findings}; a finding is
 * `${file}: ${selector} (mode) fore on back is n:1, needs m:1`.
 * Local custom properties (for example --drift-tone) resolve from the same rule
 * first, then from the rules that declare them, one rule at a time.
 */
export function scan(sheets,known={}){
 const locals=new Map();
 for(const [,root] of sheets)root.walkDecls(/^--/,decl=>{
  if(isTokenBlock(decl.parent)||decl.parent.type!=='rule')return;
  const list=locals.get(decl.prop)??[];list.push(decl.parent);locals.set(decl.prop,list);
 });
 const ownLocals=rule=>new Map(rule.nodes.filter(node=>node.type==='decl'&&node.prop.startsWith('--')).map(decl=>[decl.prop,decl.value]));
 const usedLocals=text=>[...text.matchAll(/var\((--[\w-]+)/g)].map(match=>match[1]).filter(name=>!tokens.has(name)&&locals.has(name));
 // Every context (map of local custom properties) the rule can see.
 const contexts=(rule,texts)=>{
  const own=ownLocals(rule);
  let list=[own];
  const pending=[...new Set(texts.flatMap(usedLocals))].filter(name=>!own.has(name));
  for(const name of pending){
   const next=[];
   for(const context of list){
    if(context.has(name)){next.push(context);continue;}
    for(const source of locals.get(name))next.push(new Map([...ownLocals(source),...context]));
   }
   list=next;
  }
  return list;
 };
 const findings=[];let checked=0;
 for(const [file,root] of sheets)root.walkRules(rule=>{
  if(isTokenBlock(rule))return;
  const decls=rule.nodes.filter(node=>node.type==='decl');
  const opacity=decls.find(decl=>decl.prop==='opacity');
  if(opacity&&parseFloat(opacity.value)<1)return;
  const parts=rule.selectors.map(flat);
  const isText=decl=>decl.prop==='color'||(decl.prop==='fill'&&parts.some(part=>/(?:^|[^\w-])text(?![\w-])/.test(part)));
  const fore=decls.filter(isText).pop();
  if(!fore||parts.every(skipped))return;
  const back=decls.filter(decl=>decl.prop==='background'||decl.prop==='background-color').pop();
  const minimum=parts.every(glyph)?3:4.5;
  const dark=parts.every(part=>fixedDark.test(part)),light=parts.every(part=>fixedLight.test(part));
  const modes=dark?['dark']:light?['light']:['light','dark'];
  const selector=parts.join(', ');
  for(const mode of modes)for(const context of contexts(rule,[fore.value,back?.value??''])){
   const map=new Map([...tokens,...context]);
   let text,ground;
   try{text=resolveColor(fore.value,map,mode);}catch{text=null;}
   if(!text||text.a===0)continue;
   const panel=resolveColor('var(--sd-panel)',map,mode);
   const grounds=[];
   if(back&&/var\(--sd-accent-grad\)/.test(back.value))grounds.push(resolveColor('var(--sd-accent-from)',map,mode),resolveColor('var(--sd-accent-to)',map,mode));
   else{try{ground=back?resolveColor(back.value,map,mode):null;}catch{ground=null;}grounds.push(ground&&ground.a>0?over(ground,panel):panel);}
   for(const base of grounds){
    const ratio=contrast(over(text,base),base);
    checked++;
    if(ratio>=minimum||known[selector])continue;
    findings.push(`${file}: ${selector} (${mode}) ${toHex(over(text,base))} on ${toHex(base)} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`);
   }
  }
 });
 return {checked,findings};
}

// The scanner itself: it flags a failing pair and accepts a passing one, with glyph thresholds,
// skips, gradient end points, fixed surfaces and local custom properties.
{
 const probe=new Map([['probe.css',postcss.parse(`
.bad{color:var(--sd-muted);background:var(--sd-soft-line)}
.good{color:var(--sd-ink);background:var(--sd-panel)}
.dot::before{color:color-mix(in srgb,var(--sd-muted) 85%,var(--sd-panel))}
.word{color:color-mix(in srgb,var(--sd-muted) 85%,var(--sd-panel))}
.off:disabled{color:var(--sd-line)}
.faded{color:var(--sd-line);opacity:.5}
.on-grad{color:var(--sd-on-accent);background:var(--sd-accent-grad)}
.panel-on-grad{color:var(--sd-panel);background:var(--sd-accent-grad)}
.sd-rdp-client .x{color:var(--sd-muted);background:var(--sd-soft-line)}
.sd-mfa-qr .y{color:var(--sd-accent);background:var(--sd-panel)}
.tone{--probe-tone:var(--sd-ink)}
.tone-bad{--probe-tone:var(--sd-line)}
.uses-tone{color:var(--probe-tone)}
`)]]);
 const {findings}=scan(probe);
 const flagged=[...new Set(findings.map(line=>line.split(': ')[1].split(' (')[0]))].sort();
 assert.deepEqual(flagged,['.bad','.on-grad','.panel-on-grad','.uses-tone','.word'].sort(),`probe findings:\n${findings.join('\n')}`);
 assert.ok(findings.some(line=>line.startsWith('probe.css: .bad (light)')),'the muted on soft-line pair fails in light mode');
 assert.ok(findings.some(line=>line.includes('.panel-on-grad (dark)')),'a surface token on the gradient fails in dark mode');
 // Both gradient end points are checked: white passes on the violet start and fails on the cyan end.
 const onGradient=findings.filter(line=>line.includes(': .on-grad ('));
 assert.ok(onGradient.length===2&&onGradient.every(line=>line.includes('on #1fb6ff')),`gradient end points:\n${onGradient.join('\n')}`);
 // Both pairs fail in the other mode only.
 assert.ok(!findings.some(line=>line.includes('.sd-rdp-client')),'a fixed-dark rule is checked in dark mode only');
 assert.ok(!findings.some(line=>line.includes('.sd-mfa-qr')),'a fixed-light rule is checked in light mode only');
 const both=scan(new Map([['probe.css',postcss.parse('.x{color:var(--sd-muted);background:var(--sd-soft-line)}.y{color:var(--sd-accent);background:var(--sd-panel)}')]])).findings;
 assert.ok(both.some(line=>line.includes('.x (light)'))&&both.some(line=>line.includes('.y (dark)')),`the same pairs fail outside the fixed surfaces:\n${both.join('\n')}`);
 assert.deepEqual(scan(probe,{'.bad':'probe','.word':'probe','.on-grad':'probe','.panel-on-grad':'probe','.uses-tone':'probe'}).findings,[],'exceptions silence their selector');
}

// Every stylesheet below app/.
const files=[...walk('app'),...walk('ui')].sort();
const sheets=new Map(files.map(file=>[file,postcss.parse(read(file))]));
for(const [selector,reason] of Object.entries(exceptions))assert.ok(typeof reason==='string'&&reason.length>20,`exception ${selector} needs a reason`);
const {checked,findings}=scan(sheets,exceptions);
assert.ok(files.length>=45,`at least 45 stylesheets are scanned (${files.length})`);
assert.ok(checked>=1000,`at least 1000 text and background pairs are checked (${checked})`);
assert.deepEqual(findings,[],`text contrast in light and dark mode:\n${findings.join('\n')}`);
// Every exception still matches a rule, so the map does not rot.
const selectors=new Set();for(const [,root] of sheets)root.walkRules(rule=>selectors.add(rule.selectors.map(flat).join(', ')));
for(const selector of Object.keys(exceptions))assert.ok(selectors.has(selector),`exception ${selector} matches a rule`);

// Inactive Segmented labels (both sizes) and their counts sit on the track, 6 % ink over the panel
// or the page background, not on the panel: 4.5:1 there in light and dark mode and every scheme.
{
 const css=read('ui/styles/console.css'),root=postcss.parse(css);
 const rule=selector=>{let found=null;root.walkRules(node=>{if(node.selectors.map(flat).includes(selector))found=node;});assert.ok(found,`rule ${selector}`);return found;};
 const decl=(node,prop)=>node.nodes.filter(child=>child.type==='decl'&&child.prop===prop).pop()?.value;
 const segment=rule('.sdx-segmented button'),count=rule('.sdx-segmented button b'),small=rule('.sdx-segmented-sm button');
 const ink=decl(segment,'--sdx-segment-ink');
 assert.equal(decl(segment,'color'),'var(--sdx-segment-ink)','the inactive label uses the derived ink');
 assert.equal(decl(small,'color'),undefined,'size sm keeps that color');
 assert.match(ink,/^color-mix\(in srgb, var\(--sd-muted\) \d+%, var\(--sd-ink\)\)$/,'derived from tokens');
 assert.deepEqual(colorLiterals(segment.toString()+count.toString()),[],'no color literal');
 assert.equal(decl(rule('.sdx-segmented'),'background'),'color-mix(in srgb, var(--sd-ink) 6%, transparent)','Segmented keeps its 6 % ink track');
 const ids=mode=>[undefined,...new Set(schemeBlocks(globals).filter(block=>block.mode===mode&&block.id).map(block=>block.id))];
 const failures=[];let pairs=0;
 for(const mode of ['light','dark'])for(const id of ids(mode)){
  const map=new Map([...tokens]);
  if(id)for(const block of schemeBlocks(globals))if(block.mode===mode&&block.id===id)for(const [name,value] of block.decls)map.set(name,value);
  map.set('--sdx-segment-ink',ink);
  for(const ground of ['--sd-panel','--sd-bg']){
   const base=resolveColor(`var(${ground})`,map,mode);
   const track=over(resolveColor('color-mix(in srgb, var(--sd-ink) 6%, transparent)',map,mode),base);
   const chip=over(resolveColor('color-mix(in srgb, var(--sd-ink) 5%, transparent)',map,mode),track);
   for(const [what,text,back] of [['label',decl(segment,'color'),track],['count',decl(count,'color'),chip]]){
    const ratio=contrast(over(resolveColor(text,map,mode),back),back);pairs++;
    if(ratio<4.5)failures.push(`${what} ${mode} ${id??'default'} over ${ground}: ${ratio.toFixed(2)}:1`);
   }
  }
 }
 assert.ok(pairs>=40,`every mode, scheme and ground is checked (${pairs})`);
 assert.deepEqual(failures,[],`inactive Segmented labels on the track:\n${failures.join('\n')}`);
}

// Pill tabs: navigation look. They share no rule with Segmented (a filter reads neutral, navigation
// reads accent): no track, muted labels on the page, the active tab on the accent-soft fill with an
// inset accent ring. Labels and counts keep 4.5:1 over --sd-panel and --sd-bg in every mode and scheme.
{
 const root=postcss.parse(read('ui/styles/console.css'));
 const top=[];root.walkRules(node=>{if(node.parent.type==='root')top.push(node);});
 const pillRules=top.filter(node=>node.selectors.some(part=>part.includes('.sdx-tabbar-pill')));
 assert.ok(pillRules.length>=6,`the pill variant has its own rules (${pillRules.length})`);
 for(const node of top){
  const parts=node.selectors.map(flat);
  assert.ok(!(parts.some(part=>part.includes('.sdx-tabbar-pill'))&&parts.some(part=>part.includes('.sdx-segmented'))),`no rule draws Segmented and pill tabs together: ${parts.join(', ')}`);
 }
 const rule=selector=>{const found=top.filter(node=>node.selectors.map(flat).includes(selector));assert.equal(found.length,1,`one root rule for ${selector}`);return found[0];};
 const decl=(node,prop)=>node.nodes.filter(child=>child.type==='decl'&&child.prop===prop).pop()?.value;
 const list=rule('.sdx-tabbar-pill > .sdx-tablist');
 for(const prop of ['background','background-color','box-shadow']){const value=decl(list,prop);assert.ok(value===undefined||value==='none'||value==='transparent',`the pill tablist has no track (${prop}: ${value})`);}
 assert.equal(decl(list,'padding'),'0','the pill tablist has no track padding');
 assert.equal(decl(list,'flex-wrap'),'nowrap','the pill tablist stays on one line');
 const tab=rule('.sdx-tabbar-pill .sdx-tab'),hover=rule('.sdx-tabbar-pill .sdx-tab:hover'),active=rule('.sdx-tabbar-pill .sdx-tab.active');
 assert.ok(tab.selectors.map(flat).includes('.sdx-tabbar-pill .sdx-tabs-more')&&active.selectors.map(flat).includes('.sdx-tabbar-pill .sdx-tabs-more.active'),'the "More" trigger shares the tab look');
 assert.ok(hover.selectors.map(flat).includes('.sdx-tabbar-pill .sdx-tabs-more[data-state="open"]:not(.active)'),'an open "More" without the active tab looks hovered');
 assert.equal(decl(tab,'color'),'var(--sd-muted)','inactive pill labels are muted');
 assert.equal(decl(hover,'background'),'var(--sdx-hover)','hover uses the neutral hover fill');
 assert.equal(decl(active,'background'),'var(--sd-accent-soft)','the active pill is accent-soft');
 assert.equal(decl(active,'color'),'var(--sd-accent-strong)','the active pill has accent text');
 assert.match(decl(active,'box-shadow'),/^inset 0 0 0 1px color-mix\(in srgb, var\(--sd-accent\) \d+%, transparent\)$/,'the active pill has the inset accent ring, so the state is not color alone');
 assert.equal(decl(active,'font-weight'),undefined,'the active pill keeps the label weight, so the "More" fit stays stable');
 assert.equal(decl(rule('.sdx-tabbar-pill .sdx-tab:active'),'transform'),'scale(.96)','press feedback');
 assert.deepEqual(colorLiterals(pillRules.map(String).join('\n')),[],'no color literal in the pill rules');
 const count=rule('.sdx-tabbar-pill .sdx-tab b');
 const activeCount=rule('.sdx-tabbar-pill .sdx-tab.active b:not(.sdx-count-online, .sdx-count-warning, .sdx-count-critical)');
 assert.match(decl(count,'color'),/^color-mix\(in srgb, var\(--sd-muted\) \d+%, var\(--sd-ink\)\)$/,'the inactive count ink is derived from tokens');
 assert.equal(decl(activeCount,'background'),'var(--sd-panel)','the active count chip stays visible inside the soft fill');
 const warning=rule('.sdx-tabbar .sdx-tab b.sdx-count-warning'),critical=rule('.sdx-tabbar .sdx-tab b.sdx-count-critical'),online=rule('.sdx-tabbar .sdx-tab.active b.sdx-count-online');
 const hoverFill=decl(rule('.sdx'),'--sdx-hover');
 const ids=mode=>[undefined,...new Set(schemeBlocks(globals).filter(block=>block.mode===mode&&block.id).map(block=>block.id))];
 const failures=[];let pairs=0;
 for(const mode of ['light','dark'])for(const id of ids(mode)){
  const map=new Map([...tokens]);
  if(id)for(const block of schemeBlocks(globals))if(block.mode===mode&&block.id===id)for(const [name,value] of block.decls)map.set(name,value);
  map.set('--sdx-hover',hoverFill);
  const color=text=>resolveColor(text,map,mode);
  for(const ground of ['--sd-panel','--sd-bg']){
   const base=color(`var(${ground})`);
   const hovered=over(color(decl(hover,'background')),base),soft=over(color(decl(active,'background')),base);
   const chip=over(color(decl(count,'background')),base),hoverChip=over(color(decl(count,'background')),hovered),activeChip=over(color(decl(activeCount,'background')),soft);
   const toned=(node,fill)=>[decl(node,'color'),over(color(decl(node,'background')),fill)];
   for(const [what,text,back] of [
    ['inactive label',decl(tab,'color'),base],
    ['hover label',decl(hover,'color'),hovered],
    ['active label',decl(active,'color'),soft],
    ['inactive count',decl(count,'color'),chip],
    ['hover count',decl(count,'color'),hoverChip],
    ['active count',decl(activeCount,'color'),activeChip],
    ['inactive warning count',...toned(warning,base)],
    ['inactive critical count',...toned(critical,base)],
    ['active warning count',...toned(warning,soft)],
    ['active critical count',...toned(critical,soft)],
    ['active success count',...toned(online,soft)],
   ]){
    const ratio=contrast(over(color(text),back),back);pairs++;
    if(ratio<4.5)failures.push(`${what} ${mode} ${id??'default'} over ${ground}: ${ratio.toFixed(2)}:1`);
   }
  }
 }
 assert.ok(pairs>=60,`every mode, scheme, ground and state is checked (${pairs})`);
 assert.deepEqual(failures,[],`pill tab labels and counts:\n${failures.join('\n')}`);
}

// The chart tooltip and the data color (meters, sparklines, single-series charts). The tooltip ink and muted text reach
// 4.5:1 on the opaque tooltip surface; --sd-meter reaches 3:1 on the panel and on its track and keeps an RGB distance of
// at least 80 from --sd-warn and --sd-danger, so a value never reads as a warning. Both are defined once in :root with a
// light and a dark value, and no scheme block sets them: every mode × scheme pair is checked.
{
 // String.raw keeps \w and \s for the RegExp (a plain template literal turns them into w and s).
 const declaration=name=>new RegExp(String.raw`(?<![\w-])${name}\s*:`,'g');
 const matches=(text,name)=>[...text.matchAll(declaration(name))].length;
 assert.deepEqual(['--sd-meter: x','--sd-meter :x','--sd-meter-track: x','var(--sd-meter)','x--sd-meter: x'].map(text=>matches(text,'--sd-meter')),[1,1,0,0,0],'self-check: the declaration pattern matches "--sd-meter: x" and "--sd-meter :x", not "--sd-meter-track: x", "var(--sd-meter)" or "x--sd-meter: x"');
 const declared=name=>matches(globals,name);
 for(const name of ['--sd-chart-tooltip-bg','--sd-chart-tooltip-ink','--sd-chart-tooltip-muted','--sd-chart-tooltip-line','--sd-meter','--sd-meter-track']){
  assert.equal(declared(name),1,`${name} is declared once`);
  assert.match(tokens.get(name)??'',/^light-dark\(/,`${name} has a light and a dark value`);
 }
 const schemes=schemeBlocks(globals);
 assert.deepEqual(schemes.filter(block=>[...block.decls.keys()].some(name=>name.startsWith('--sd-meter')||name.startsWith('--sd-chart-'))).map(block=>block.selector),[],'no scheme block defines or overrides the meter or tooltip tokens');
 const css=read('ui/styles/console.css'),root=postcss.parse(css);
 const decl=(selector,prop)=>{let value;root.walkRules(node=>{if(node.parent.type==='root'&&node.selectors.includes(selector))node.walkDecls(prop,item=>{value=item.value;});});return value;};
 assert.equal(decl('.sdx-meter > span','background'),'var(--sd-meter)','.sdx-meter > span fills with --sd-meter');
 assert.equal(decl('.sdx-meter','background'),'var(--sd-meter-track)','the meter track is --sd-meter-track');
 assert.equal(decl('.sdx-meter-warning > span','background'),'var(--sd-warn)','past the warning level the meter is amber');
 assert.equal(decl('.sdx-meter-critical > span','background'),'var(--sd-danger)','past the critical level the meter is red');
 const ids=mode=>[undefined,...new Set(schemes.filter(block=>block.mode===mode&&block.id).map(block=>block.id))];
 const failures=[];let pairs=0;
 for(const mode of ['light','dark'])for(const id of ids(mode)){
  const map=new Map([...tokens]);
  if(id)for(const block of schemes)if(block.mode===mode&&block.id===id)for(const [name,value] of block.decls)map.set(name,value);
  const color=name=>resolveColor(`var(${name})`,map,mode),where=`${mode} ${id??'default'}`;
  const tooltip=color('--sd-chart-tooltip-bg');
  if(tooltip.a!==1)failures.push(`${where}: the tooltip surface is not opaque`);
  for(const name of ['--sd-chart-tooltip-ink','--sd-chart-tooltip-muted']){const ratio=contrast(over(color(name),tooltip),tooltip);pairs++;if(ratio<4.5)failures.push(`${where}: ${name} on the tooltip ${ratio.toFixed(2)}:1`);}
  const panel=color('--sd-panel'),meter=color('--sd-meter'),track=over(color('--sd-meter-track'),panel);
  for(const [what,ground] of [['the panel',panel],['its track',track]]){const ratio=contrast(meter,ground);pairs++;if(ratio<3)failures.push(`${where}: --sd-meter on ${what} ${ratio.toFixed(2)}:1`);}
  for(const name of ['--sd-warn','--sd-danger']){const other=color(name),distance=Math.hypot(meter.r-other.r,meter.g-other.g,meter.b-other.b);pairs++;if(distance<80)failures.push(`${where}: --sd-meter ${toHex(meter)} is ${distance.toFixed(0)} from ${name} ${toHex(other)}`);}
 }
 // 2 modes × (the defaults + 6 schemes per mode, the brand colors included) × 6 checks.
 assert.equal(pairs,84,`every mode, scheme and pair is checked (${pairs})`);
 assert.deepEqual(failures,[],`chart tooltip and meter tokens:\n${failures.join('\n')}`);
}

console.log('theme contrast ok');
