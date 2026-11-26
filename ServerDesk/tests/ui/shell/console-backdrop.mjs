// The console background (ui/shell/console-backdrop.tsx and .css, docs/branding.md): no layer without a portal
// console background, with the account's preference off or while the system asks for reduced transparency or forced
// colors; the layer holds one decorative <img alt="" aria-hidden> with the background URL; the scrim custom properties
// exist only with a backdrop. CSS: the layer is fixed to the whole viewport (inset 0, no clip-path, no pointer events,
// behind the frame), the image is blurred by at least 40px per mode on its own layer, the scrims sit on the top bar,
// the rail, the dock, the navigator, the bottom bar and .sdx-workspace (never on .sdx-main or another scroller), no
// backdrop rule acts under reduced transparency or forced colors, and the fade is in the reduced-motion list. The
// secondary tones are declared once on .sdx[data-backdrop]; --sd-muted points to the backdrop tone on exactly the top
// bar, the rail, the navigator, the dock and the workspace, and back to the content tone on exactly the opaque content
// containers, never on a portaled surface or the scroller. The
// console renders the layer in .sdx-body outside the workspace, the navigator and the dock and marks the frame.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {postcss} from '../../support/theme-colors.mjs';

const {ConsoleBackdrop,consoleBackdrop,consoleBackdropStyle,backdropOffQuery}=await import('../../../ui/shell/console-backdrop.tsx');
const {backdropScrims,fallbackBackdropMeasure}=await import('../../../lib/backdrop.ts');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const render=background=>renderToStaticMarkup(React.createElement(ConsoleBackdrop,{background}));

const scrim=backdropScrims(fallbackBackdropMeasure,null);
const builtin={kind:'builtin',id:'dusk',url:'/backgrounds/dusk.svg',scrim,measured:true};
const upload={kind:'upload',url:'/api/branding/portal/console?v=0123456789abcdef',width:2560,height:1440,scrim,measured:false};
check(consoleBackdrop({consoleBackground:builtin},true),builtin,'a portal background with the preference on');
check(consoleBackdrop({consoleBackground:builtin},false),null,'the preference off: none');
check(consoleBackdrop({consoleBackground:builtin},true,false),null,'reduced transparency or forced colors: none');
check(consoleBackdrop({consoleBackground:null},true),null,'no portal background: none');
check(consoleBackdrop(undefined,true),null,'no console data yet: none');
check(render(null),'','no layer without a background');
for(const background of [builtin,upload]){
 const html=render(background);
 ok(html.startsWith('<div class="sdx-backdrop" aria-hidden="true"><img '),'one hidden layer');
 const image=html.match(/<img [^>]*>/)[0];
 for(const part of ['class="sdx-backdrop-image"',`src="${background.url}"`,'alt=""','aria-hidden="true"','decoding="async"','fetchPriority="low"'])ok(image.includes(part)||image.includes(part.toLowerCase()),`the image has ${part}`);
}
// The scrim custom properties: only with a backdrop, one per region and mode.
check(consoleBackdropStyle(null),undefined,'no custom properties without a backdrop');
const style=consoleBackdropStyle(builtin);
check(Object.keys(style).sort(),['bars','navigator','workspace'].flatMap(region=>['light','dark'].map(mode=>`--sdx-scrim-${region}-${mode}`)).sort(),'six scrim properties');
ok(Object.entries(style).every(([name,value])=>{const [,region,mode]=/^--sdx-scrim-(\w+)-(\w+)$/.exec(name);return value===`${scrim[mode][region]}%`;}),'each is the percentage of its mode and region');
check(backdropOffQuery,'(prefers-reduced-transparency: reduce), (forced-colors: active)','the off query');

// The stylesheet.
const css=readFileSync('ui/shell/console-backdrop.css','utf8'),root=postcss.parse(css);
const norm=text=>text.replace(/\s+/g,' ').trim();
const rulesOf=selectorPart=>{const out=[];root.walkRules(rule=>{if(norm(rule.selector).split(', ').includes(selectorPart))out.push(rule);});return out;};
const decl=(selector,prop,media)=>{let value;for(const rule of rulesOf(selector)){const where=rule.parent.type==='atrule'?rule.parent.params:null;if(media===undefined?where===null:where?.includes(media))rule.walkDecls(prop,item=>{value=item.value;});}return value;};
check([decl('.sdx-backdrop','position'),decl('.sdx-backdrop','inset'),decl('.sdx-backdrop','pointer-events'),decl('.sdx-backdrop','z-index')],['fixed','0','none','-1'],'the layer is fixed to the whole viewport, behind the frame, without pointer events');
ok(!/clip-path/.test(css),'no clip-path: one continuous picture');
check(decl('.sdx[data-backdrop]','background'),'none','the frame paints no surface over the layer (.sd-console has --sd-bg)');
ok(decl('.sdx-backdrop-image','object-fit')==='cover'&&/will-change: transform/.test(css)&&/scale\(1\.15\)/.test(decl('.sdx-backdrop-image','transform')),'covering, scaled, on its own compositing layer');
for(const mode of ['light','dark']){
 const filter=decl('.sdx-backdrop',`--sdx-backdrop-filter-${mode}`);
 const blur=Number(/blur\((\d+)px\)/.exec(filter)?.[1]);
 ok(blur>=40,`${mode}: a strong blur (${blur}px)`);
 ok(/^blur\(\d+px\) saturate\([\d.]+\)( brightness\([\d.]+\))?$/.test(filter),`${mode}: blur, saturate and brightness only`);
}
check(decl('.sdx-backdrop-image','filter'),'var(--sdx-backdrop-filter-light)','the light filter by default');
check(decl(':root[data-theme="dark"] .sdx-backdrop-image','filter'),'var(--sdx-backdrop-filter-dark)','the dark filter in the dark theme');
check(decl(':root[data-theme="system"] .sdx-backdrop-image','filter','prefers-color-scheme: dark'),'var(--sdx-backdrop-filter-dark)','the dark filter in System with a dark preference');
ok(/sdx-fade/.test(decl('.sdx-backdrop-image','animation')),'it fades in once');
// The scrims: each surface paints its region scrim.
const surfaces=[['.sdx[data-backdrop] > .sdx-topbar',undefined,'bars'],['.sdx[data-backdrop] .sdx-dock',undefined,'bars'],['.sdx[data-backdrop] .sdx-rail','min-width: 901px','bars'],
 ['.sdx[data-backdrop] .sdx-rail','max-width: 900px','bars'],['.sdx[data-backdrop] .sdx-navigator',undefined,'navigator'],['.sdx[data-backdrop] .sdx-workspace',undefined,'workspace']];
for(const [selector,media,region] of surfaces)ok(decl(selector,'background',media)?.endsWith(`var(--sdx-backdrop-${region})`),`${selector}${media?` (${media})`:''}: the ${region} scrim`);
ok(decl('.sdx[data-backdrop] .sdx-rail','border-right','min-width: 901px')==='1px solid var(--sdx-edge)','the rail gets its hairline');
// The secondary tones: declared once on the frame; the backdrop tone on the functional layer and the canvas, the
// normal tone again on the opaque content containers.
check([decl('.sdx[data-backdrop]','--sdx-muted-backdrop'),decl('.sdx[data-backdrop]','--sdx-muted-content')],
 ['light-dark(color-mix(in srgb, var(--sd-ink) 40%, var(--sd-muted)), var(--sd-muted))','var(--sd-muted)'],'the two secondary tones on .sdx[data-backdrop], no color literal');
let toneDeclarations=0;root.walkDecls(/^--sdx-muted-/,()=>{toneDeclarations++;});
check(toneDeclarations,2,'each tone is declared once');
const repointed={'var(--sdx-muted-backdrop)':[],'var(--sdx-muted-content)':[]};
const repointRules=[];
root.walkDecls('--sd-muted',item=>{
 ok(item.value in repointed,`--sd-muted is re-pointed only to a secondary tone (${item.value})`);
 repointRules.push(item.parent);
 for(const selector of item.parent.selectors)repointed[item.value]?.push(norm(selector));
});
check(repointed['var(--sdx-muted-backdrop)'].sort(),['.sdx[data-backdrop] > .sdx-topbar','.sdx[data-backdrop] .sdx-rail','.sdx[data-backdrop] .sdx-navigator','.sdx[data-backdrop] .sdx-dock','.sdx[data-backdrop] .sdx-workspace'].sort(),'the backdrop tone on exactly the top bar, the rail, the navigator, the dock and the workspace');
check(repointed['var(--sdx-muted-content)'].sort(),['.sdx[data-backdrop] .sdx-card','.sdx[data-backdrop] .sdx-table-wrap:not(.sdx-table-wrap-flush, .sdx-table-wrap-cards)','.sdx[data-backdrop] .sdx-device-card','.sdx[data-backdrop] .sdx-kpi','.sdx[data-backdrop] .sdx-health-line','.sdx[data-backdrop] .sdx-disclosure','.sdx[data-backdrop] .sdx-data-card'].sort(),'the normal tone on exactly the opaque content containers (a transparent table wrap keeps the tone below it)');
for(const rule of repointRules){
 ok(rule.parent.type==='root','a re-point applies at every width (the rail as bottom bar, the navigator as overlay)');
 ok(rule.selectors.every(selector=>selector.trim().startsWith('.sdx[data-backdrop]')),`${norm(rule.selector)}: keyed to .sdx[data-backdrop]`);
 ok(!/sdx-layer|sdx-menu|sdx-drawer|sdx-dialog|sd-palette|sdx-select|sdx-main\b/.test(rule.selector),`${norm(rule.selector)}: no portaled surface and not the scroller`);
}
let onScroller=false;root.walkRules(rule=>{if(/sdx-main|sdx-navigator-body|sdx-dock-panel/.test(rule.selector))onScroller=true;});
ok(!onScroller,'no backdrop rule on .sdx-main or another scroller');
// No backdrop rule acts under reduced transparency and forced colors: the console renders no layer and sets no
// data-backdrop there (every surface rule needs it), and the layer hides itself.
let surfaceRulesNeedTheAttribute=true;root.walkRules(rule=>{if(rule.selector.includes('sdx-backdrop'))return;if(!/^:root\[data-theme/.test(rule.selector)&&!rule.selectors.every(part=>part.trim().startsWith('.sdx[data-backdrop]')))surfaceRulesNeedTheAttribute=false;});
ok(surfaceRulesNeedTheAttribute,'every surface rule is keyed to .sdx[data-backdrop]');
ok(decl('.sdx-backdrop','display','prefers-reduced-transparency: reduce')==='none','the layer hides under reduced transparency');
let forced=false;root.walkAtRules('media',rule=>{if(rule.params.includes('forced-colors: active')&&rule.params.includes('prefers-reduced-transparency'))rule.walkDecls('display',item=>{if(item.value==='none')forced=true;});});
ok(forced,'and under forced colors');
ok(readFileSync('ui/styles/motion.css','utf8').includes('.sdx-backdrop-image,'),'the fade is in the reduced-motion list');
ok(!/@keyframes/.test(css)&&!/infinite/.test(css),'no keyframes and no looping motion');

// Placement in the console: before the rail in .sdx-body, outside the workspace, the navigator and the dock.
const source=readFileSync('ui/shell/console.tsx','utf8');
const body=source.indexOf('<div className="sdx-body">'),layer=source.indexOf('<ConsoleBackdrop background={backdrop}/>'),rail=source.indexOf('<Rail items={railItems}');
ok(body>0&&layer>body&&rail>layer&&source.slice(body,layer).trim()==='<div className="sdx-body">','the layer is the first child of .sdx-body, before the rail');
for(const part of ['<div className="sdx-workspace">','<Navigator ','<JobDock '])ok(source.indexOf(part)>layer,`${part} comes after the layer, so it is not inside it`);
ok(source.includes("data-backdrop={backdrop?'':undefined} style={backdropStyle}"),'the frame is marked and carries the scrims while the backdrop shows');
ok(source.includes('const backdrop=consoleBackdrop(data?.branding,consoleBackgroundOn,useBackdropAllowed());'),'the console shows the portal background only while the preference is on and the system allows it');
ok(/const backdropStyle=useMemo\(\(\)=>consoleBackdropStyle\(backdrop\),\[backdropScrimKey\]\);/.test(source),'a refresh with the same scrims keeps the same style object');

console.log(`PASS console backdrop (${checks} checks): layer, image, filters, scrims, reduced transparency and forced colors, placement.`);
