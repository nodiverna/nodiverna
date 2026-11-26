// Color in TSX: the charts, the Sparkline and the xterm canvas take their
// colors from tokens, never from fixed values. The terminal reads its canvas
// theme from the computed style of its host, which terminal.css sets from tokens.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {postcss,rootTokens,resolveColor,contrast,toHex,colorLiterals} from '../../support/theme-colors.mjs';

const read=file=>readFileSync(file,'utf8');
const {hexColor,terminalTheme}=await import('../../../ui/devices/remote/terminal-theme.ts');

for(const file of ['ui/devices/hardware/device-hardware.tsx','ui/devices/hardware/device-gpu.tsx','ui/devices/remote/terminal-panel.tsx','ui/kit/kit.tsx'])assert.deepEqual(colorLiterals(read(file)),[],`${file} holds no color literal`);

// Every recharts chart: grid and ticks from tokens, the one shared tooltip style (ui/kit/chart.ts) and the data
// color --sd-meter for its single series, never the scheme accent.
const charts={'ui/devices/device/device-summary.tsx':"'@/ui/kit/chart'",'ui/devices/diagnostics/reliability-card.tsx':"'@/ui/kit/chart'",'ui/devices/hardware/device-hardware.tsx':"'@/ui/kit/chart'",'ui/devices/hardware/device-gpu.tsx':"'@/ui/kit/chart'"};
for(const [file,from] of Object.entries(charts)){
 const text=read(file);
 assert.ok(text.includes(`import {chartSeries,chartTooltip} from ${from};`),`${file} imports the shared tooltip style and series color`);
 const tooltips=[...text.matchAll(/<Tooltip\b[\s\S]*?\/>/g)].map(match=>match[0]);
 assert.equal(tooltips.length,1,`${file}: one recharts Tooltip`);
 assert.match(tooltips[0],/^<Tooltip \{\.\.\.chartTooltip\} /,`${file}: the Tooltip spreads chartTooltip first`);
 assert.doesNotMatch(tooltips[0],/contentStyle|labelStyle|itemStyle|wrapperStyle|cursor=|borderRadius/,`${file}: the Tooltip sets no style of its own`);
 assert.doesNotMatch(text,/var\(--sd-accent\)/,`${file}: no data mark takes the scheme accent`);
 assert.deepEqual(colorLiterals(text),[],`${file} holds no color literal`);
}
const hardware=read('ui/devices/hardware/device-hardware.tsx'),gpu=read('ui/devices/hardware/device-gpu.tsx'),summary=read('ui/devices/device/device-summary.tsx'),reliability=read('ui/devices/diagnostics/reliability-card.tsx');
for(const [file,text] of [['device-hardware.tsx',hardware],['device-gpu.tsx',gpu]]){
 assert.match(text,/<CartesianGrid stroke="var\(--sd-soft-line\)"/,`${file}: the grid uses --sd-soft-line`);
 assert.equal((text.match(/fill:'var\(--sd-muted\)'/g)??[]).length,2,`${file}: both axes use --sd-muted`);
}
assert.match(gpu,/stroke=\{chartSeries\} fill=\{chartSeries\}/,'the GPU series uses the data color');
assert.match(summary,/stopColor=\{chartSeries\} stopOpacity=\{0\.26\}\/><stop offset="100%" stopColor=\{chartSeries\}/,'the usage chart area fades in the data color');
assert.match(summary,/<Area type="monotone" dataKey=\{metric\} name=\{metric\} stroke=\{chartSeries\}/,'the usage chart line uses the data color');
assert.match(reliability,/<Line type="monotone" dataKey="index" stroke=\{chartSeries\}/,'the reliability line uses the data color');
// The CPU series is the data color; the RAM series uses --sd-muted, which differs from it in both modes.
assert.match(hardware,/color=kind==='cpu'\?chartSeries:'var\(--sd-muted\)'/);
// The shared style reads only the tooltip tokens, a radius token and the medium shadow; the cursor and the series the data color.
const chartModule=await import('../../../ui/kit/chart.ts'),chart=read('ui/kit/chart.ts');
assert.equal(chartModule.chartSeries,'var(--sd-meter)','the series color is --sd-meter');
const {contentStyle,labelStyle,itemStyle,cursor}=chartModule.chartTooltip;
const boxValues=[...Object.values(contentStyle),...Object.values(labelStyle),...Object.values(itemStyle)].filter(value=>typeof value==='string');
assert.deepEqual(boxValues.flatMap(value=>[...value.matchAll(/var\((--[\w-]+)\)/g)].map(match=>match[1])).filter(name=>!/^--sd-chart-tooltip-(?:bg|ink|muted|line)$|^--sd-radius(?:-sm|-lg)?$|^--sd-shadow-md$/.test(name)),[],'the tooltip box reads only --sd-chart-tooltip-*, --sd-radius* and --sd-shadow-md');
assert.deepEqual([contentStyle.backgroundColor,contentStyle.border,contentStyle.borderRadius,contentStyle.boxShadow,contentStyle.color,contentStyle.fontSize,labelStyle.color,itemStyle.color],
 ['var(--sd-chart-tooltip-bg)','1px solid var(--sd-chart-tooltip-line)','var(--sd-radius-sm)','var(--sd-shadow-md)','var(--sd-chart-tooltip-ink)',12,'var(--sd-chart-tooltip-muted)','var(--sd-chart-tooltip-ink)'],'background over recharts\' white box, border, radius token, shadow, 12px, label and value colors');
assert.equal(cursor.stroke,'var(--sd-meter)','the hover cursor uses the data color');
assert.deepEqual(colorLiterals(chart),[],'chart.ts holds no color literal');
// The Sparkline strokes in the data color; warning and critical keep their status colors.
const kit=read('ui/kit/kit.tsx');
assert.match(kit,/const sparklineStroke=\{normal:chartSeries,warning:'var\(--sd-warn\)',critical:'var\(--sd-danger\)'\} as const;/,'the Sparkline default stroke is chartSeries (--sd-meter)');
assert.ok(kit.includes("import {chartSeries} from '@/ui/kit/chart';"),'kit.tsx takes chartSeries from ui/kit/chart.ts');
assert.match(kit,/stroke=\{sparklineStroke\[tone\?\?'normal'\]\}/);
const tokens=rootTokens(read('app/globals.css'));
for(const mode of ['light','dark']){
 const cpu=resolveColor('var(--sd-meter)',tokens,mode),ram=resolveColor('var(--sd-muted)',tokens,mode),panel=resolveColor('var(--sd-panel)',tokens,mode);
 const distance=Math.hypot(cpu.r-ram.r,cpu.g-ram.g,cpu.b-ram.b);
 assert.ok(distance>=80,`${mode}: the RAM series ${toHex(ram)} is clearly different from the CPU series ${toHex(cpu)} (${distance.toFixed(0)})`);
 for(const [name,color] of [['CPU',cpu],['RAM',ram]])assert.ok(contrast(color,panel)>=3,`${mode}: the ${name} line reaches 3:1 on the panel`);
}

// The xterm theme comes from the computed style of the terminal host.
const terminal=read('ui/devices/remote/terminal-panel.tsx');
assert.match(terminal,/import \{terminalTheme\} from '@\/ui\/devices\/remote\/terminal-theme';/);
assert.match(terminal,/theme:terminalTheme\(getComputedStyle\(host\.current\)\)/,'the terminal builds its theme from getComputedStyle of its host');
assert.match(terminal,/<div className="v3-terminal" style=\{terminalHostStyle\} ref=\{host\}\/>/,'the host is .v3-terminal');
// terminal.css sets the four colors of the host from tokens, and the xterm background equals the viewport background.
const css=postcss.parse(read('ui/devices/remote/terminal.css'));
const decls=selector=>{const map=new Map();css.walkRules(rule=>{if(rule.parent.type==='root'&&rule.selector===selector)rule.walkDecls(decl=>map.set(decl.prop,decl.value));});return map;};
const host=decls('.sd-console .v3-terminal-panel .v3-terminal'),viewport=decls('.sd-console .v3-terminal-panel .v3-terminal-viewport');
for(const prop of ['background','color','caret-color','outline-color'])assert.match(host.get(prop)??'',/^var\(--sd-[\w-]+\)$/,`.v3-terminal ${prop} is a token`);
assert.equal(host.get('background'),viewport.get('background'),'the xterm background equals the viewport background');
// In the fixed-dark surface the text reaches 4.5:1 on the canvas and the selection keeps the text readable.
const dark=name=>resolveColor(host.get(name),tokens,'dark');
assert.ok(contrast(dark('color'),dark('background'))>=4.5,'terminal text on the canvas reaches 4.5:1');
assert.ok(contrast(dark('color'),dark('outline-color'))>=4.5,'terminal text on the selection reaches 4.5:1');
assert.ok(contrast(dark('caret-color'),dark('background'))>=3,'the cursor reaches 3:1 on the canvas');

// Computed colors become hex values that xterm accepts.
assert.equal(hexColor('rgb(17, 21, 28)'),'#11151c');
assert.equal(hexColor('rgba(91, 92, 246, 0.5)'),'#5b5cf680');
assert.equal(hexColor('rgb(17 21 28 / 50%)'),'#11151c80');
assert.equal(hexColor('color(srgb 0.2 0.4 0.6)'),'#336699');
assert.equal(hexColor('color(srgb 1 0 0 / 0.25)'),'#ff000040');
assert.equal(hexColor('transparent'),'transparent','unknown formats pass through');
assert.deepEqual(terminalTheme({backgroundColor:'rgb(17, 21, 28)',color:'rgb(230, 233, 239)',caretColor:'rgb(91, 92, 246)',outlineColor:'color(srgb 0.2 0.2 0.4)'}),{background:'#11151c',foreground:'#e6e9ef',cursor:'#5b5cf6',selectionBackground:'#333366'});

console.log('theme charts ok');
