// Theme tokens: one definition with light and dark values (plus the narrow console background re-point of --sd-muted), contrast
// in both modes, no fixed colors in any stylesheet below app/, and exactly two
// fixed-scheme surfaces besides the three theme rules.
// Color schemes: scheme blocks, their roles, contrast and limits; the brand blocks that fall back to Aurora.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync,existsSync} from 'node:fs';
import path from 'node:path';
import {postcss,rootTokens,resolveTokens,resolveColor,contrast,colorLiterals,toHex,schemeBlocks} from '../../support/theme-colors.mjs';

const read=file=>readFileSync(file,'utf8');
const walk=dir=>readdirSync(dir).flatMap(name=>{const file=path.posix.join(dir,name);return statSync(file).isDirectory()?walk(file):file.endsWith('.css')?[file]:[];});
const cssFiles=[...walk('app'),...walk('ui')].sort();
const globals=read('app/globals.css');
const parsed=new Map(cssFiles.map(file=>[file,postcss.parse(read(file))]));
const isRoot=rule=>rule.type==='rule'&&rule.parent.type==='root'&&rule.selector.trim()===':root';

// Every --sd-* token is declared once, in :root of globals.css; a shadcn bridge token would be found too.
const bridge=/^--(?:background|foreground|card|card-foreground|popover|popover-foreground|primary|primary-foreground|secondary|secondary-foreground|muted|muted-foreground|accent|accent-foreground|destructive|border|input|ring|chart-\d|sidebar[\w-]*)$/;
const declared=new Map();
// The one compact density block (lib/density.ts) overrides the density tokens of :root; tests/ui/styles/ui-density.mjs
// checks its values and its media query.
const densityTokens=new Set(['--sd-row-h','--sd-row-h-2','--sd-head-h','--sd-kpi-h','--sd-page-head-gap','--sd-tree-row-h','--sd-nav-row-h']);
const isCompact=(file,rule)=>file==='app/globals.css'&&rule.selector?.trim()===':root[data-density="compact"]'&&rule.parent.type==='atrule'&&rule.parent.params==='(min-width: 901px) and (pointer: fine)';
// The one backdrop exception (ui/shell/console-backdrop.css, docs/branding.md): while the console background shows,
// regions re-point --sd-muted to the backdrop tone and the opaque content back to the normal tone. Only --sd-muted,
// only in that file, only in rules whose every selector starts with .sdx[data-backdrop], only with these two values.
const backdropMutedValues=new Set(['var(--sdx-muted-backdrop)','var(--sdx-muted-content)']);
const isBackdropMuted=(file,decl)=>file==='ui/shell/console-backdrop.css'&&decl.prop==='--sd-muted'&&backdropMutedValues.has(decl.value.trim())
 &&decl.parent.type==='rule'&&decl.parent.selectors.every(selector=>selector.trim().startsWith('.sdx[data-backdrop]'));
const backdropMuted=[];
for(const [file,root] of parsed)root.walkDecls(decl=>{
 if(densityTokens.has(decl.prop)&&isCompact(file,decl.parent))return;
 if(isBackdropMuted(file,decl)){backdropMuted.push(decl.value.trim());return;}
 if(decl.prop.startsWith('--sd-')||bridge.test(decl.prop)){
  assert.ok(file==='app/globals.css'&&isRoot(decl.parent),`${decl.prop} is declared outside globals.css :root (${file} ${decl.parent.selector??''})`);
  assert.ok(!declared.has(decl.prop),`${decl.prop} is declared twice`);
  declared.set(decl.prop,decl.value);
 }
 if(decl.prop.startsWith('--'))assert.doesNotMatch(decl.value,new RegExp(`^\\s*var\\(\\s*${decl.prop}\\s*[,)]`),`${file}: ${decl.prop} refers to itself`);
});
for(const name of ['--sd-bg','--sd-panel','--sd-ink','--sd-muted','--sd-line','--sd-soft-line','--sd-selected','--sd-accent','--sd-accent-strong','--sd-accent-soft','--sd-accent-hi','--sd-accent-grad','--sd-contrast','--sd-on-accent','--sd-accent-from','--sd-accent-to','--sd-glass','--sd-glass-strong','--sd-glass-edge','--sd-shadow-sm','--sd-shadow-md','--sd-shadow-lg','--sd-meter','--sd-meter-track','--sd-chart-tooltip-bg','--sd-chart-tooltip-ink','--sd-chart-tooltip-muted','--sd-chart-tooltip-line'])assert.ok(declared.has(name),`${name} is defined`);
// The backdrop exception is used (both values) and stays narrow: another file, selector, value or token fails.
assert.deepEqual([...new Set(backdropMuted)].sort(),[...backdropMutedValues].sort(),'the backdrop re-points --sd-muted to both tones');
const fixtureDecls=css=>{const out=[];postcss.parse(css).walkDecls(decl=>out.push(decl));return out;};
const accepted=(file,css)=>fixtureDecls(css).every(decl=>isBackdropMuted(file,decl));
assert.ok(accepted('ui/shell/console-backdrop.css','.sdx[data-backdrop] .sdx-rail, .sdx[data-backdrop] .sdx-dock { --sd-muted: var(--sdx-muted-backdrop); }'),'fixture: the exception itself is accepted');
for(const [file,css,label] of [
 ['ui/styles/console.css','.sdx[data-backdrop] .sdx-rail { --sd-muted: var(--sdx-muted-backdrop); }','another file'],
 ['ui/shell/console-backdrop.css','.sdx-rail { --sd-muted: var(--sdx-muted-backdrop); }','a selector without .sdx[data-backdrop]'],
 ['ui/shell/console-backdrop.css','.sdx[data-backdrop] .sdx-rail, .sdx-layer .sdx-menu { --sd-muted: var(--sdx-muted-backdrop); }','one selector of the list without it'],
 ['ui/shell/console-backdrop.css','.sdx[data-backdrop] .sdx-rail { --sd-muted: var(--sd-ink); }','another value'],
 ['ui/shell/console-backdrop.css','.sdx[data-backdrop] .sdx-rail { --sd-muted: #334155; }','a literal value'],
 ['ui/shell/console-backdrop.css','.sdx[data-backdrop] .sdx-rail { --sd-ink: var(--sdx-muted-backdrop); }','another token'],
 ['ui/shell/console-backdrop.css','@media (max-width: 900px) { :root { --sd-muted: var(--sdx-muted-content); } }','a :root rule'],
])assert.ok(!accepted(file,css),`fixture: ${label} still fails`);
// The shadcn bridge (components/ui) is gone with its components: no bridge property is declared anywhere.
assert.deepEqual([...declared.keys()].filter(name=>bridge.test(name)),[],'no shadcn bridge token is declared');
for(const name of declared.keys())assert.doesNotMatch(name,/^--(?:chart|sidebar)/,'unused chart and sidebar tokens are gone');

// Theme selection only through color-scheme; Tailwind dark variant follows the app.
const schemes=[];
for(const [file,root] of parsed)root.walkDecls('color-scheme',decl=>schemes.push([file,decl.parent.selector,decl.value]));
// The three theme rules, the fixed-dark rule (remote desktop client, terminal
// viewport; the terminal head is the kit SectionHead since UI-Rework 13b) and the fixed-light rule (authenticator QR code).
const fixedDark='.sd-rdp-client, .v3-terminal-viewport, .v3-terminal',fixedLight='.sd-mfa-qr';
assert.deepEqual(schemes.map(([file,selector,value])=>[file,selector.replace(/\s+/g,' '),value]).sort(),[
 ['app/globals.css',':root','light'],
 ['app/globals.css',':root[data-theme="dark"]','dark'],
 ['app/globals.css',':root[data-theme="system"]','light dark'],
 ['app/globals.css',fixedDark,'dark'],
 ['app/globals.css',fixedLight,'light'],
 // Settings › Branding (ui/settings/branding.css): one frame per appearance for the logos and the color samples, and the preview window.
 ['app/globals.css','.sdx-branding-frame-light','light'],
 ['app/globals.css','.sdx-branding-frame-dark','dark'],
].sort());
// No light island is left: no color-scheme rule names a classic surface or the old island class.
const islandSelectors=['.sdx-embedded','.sd-detail-drawer','.sd-rdp-paused-page','.sd-light-island'];
for(const [file,selector] of schemes)for(const part of selector.split(',').map(entry=>entry.trim()))assert.ok(!islandSelectors.some(island=>part===island||part.startsWith(`${island} `)),`${file}: ${selector} is no island rule`);
assert.ok(!globals.includes('sd-light-island'),'globals.css no longer names the island class');
assert.doesNotMatch(globals.slice(0,globals.indexOf(':root {')),/island/i,'the header comment names the fixed-scheme rules, not islands');
// Both fixed rules carry a comment that names their scheme and says that they are permanent.
for(const selector of [fixedDark,fixedLight]){
 let rule;parsed.get('app/globals.css').walkRules(node=>{if(node.selector.replace(/\s+/g,' ')===selector)rule=node;});
 assert.ok(rule,`fixed rule ${selector}`);
 assert.equal(rule.prev()?.type,'comment',`the fixed rule ${selector} has a comment`);
 assert.match(rule.prev().text,/fixed (?:dark|light)/i,`the comment of ${selector} names the fixed scheme`);
}
assert.match(globals,/permanent and not light or dark islands/,'the comment says that the fixed surfaces are permanent by design');
// No Tailwind dark: utility is used since the shadcn components left, so globals.css has no @custom-variant dark.
let variant;
parsed.get('app/globals.css').walkAtRules('custom-variant',rule=>{variant=rule.toString();});
assert.equal(variant,undefined,'no @custom-variant in globals.css');

// Resolve every token in both modes.
const light=resolveTokens(globals,'light'),dark=resolveTokens(globals,'dark');
const raw=rootTokens(globals);
const color=(text,mode='light')=>resolveColor(text,new Map(),mode);
const same=(actual,expected,label)=>{for(const key of ['r','g','b'])assert.ok(Math.abs(actual[key]-expected[key])<=.6,`${label}: ${toHex(actual)} != ${toHex(expected)}`);assert.ok(Math.abs(actual.a-expected.a)<.005,`${label}: alpha ${actual.a} != ${expected.a}`);};
const todayLight={
 '--sd-bg':'#f4f6fa','--sd-panel':'#fff','--sd-ink':'#1d2939','--sd-muted':'#667085','--sd-line':'#e3e8ef','--sd-soft-line':'#eef1f6','--sd-selected':'#eef1f6',
 '--sd-accent':'#5b5cf6','--sd-accent-strong':'color-mix(in srgb, #5b5cf6 80%, #0b1220)','--sd-accent-soft':'color-mix(in srgb, #5b5cf6 9%, #fff)','--sd-accent-hi':'color-mix(in srgb, #5b5cf6 84%, #fff)',
 '--sd-accent-from':'#7c4dff','--sd-accent-to':'#1fb6ff','--sd-contrast':'#0b1220','--sd-on-accent':'#fff',
 // #12805c gave 4.42:1 on its -bg; #127e5b is the closest value with 4.5:1.
 '--sd-success':'#127e5b','--sd-success-bg':'#e8f6ef','--sd-warn':'#8b611d','--sd-warn-bg':'#fff7e8','--sd-danger':'#b42318','--sd-danger-bg':'#fef3f2',
 '--sd-glass':'rgba(255,255,255,.68)','--sd-glass-strong':'rgba(255,255,255,.84)','--sd-glass-edge':'rgba(255,255,255,.75)',
 // The data color and the chart tooltip: --sd-meter is a fixed blue, the tooltip the panel surface with ink and muted text.
 '--sd-meter':'#3b6cd4','--sd-chart-tooltip-bg':'#fff','--sd-chart-tooltip-ink':'#1d2939','--sd-chart-tooltip-muted':'#667085','--sd-chart-tooltip-line':'#e3e8ef',
};
for(const [name,expected] of Object.entries(todayLight))same(light.get(name),color(expected),`${name} (light)`);
const flat=text=>text.replace(/\s+/g,' ').replace(/\s*,\s*/g,',').replace(/\(\s+/g,'(').replace(/0\./g,'.').trim();
assert.equal(flat(light.get('--sd-shadow-sm')),flat('0 1px 2px rgba(16,24,40,.05)'));
assert.equal(flat(light.get('--sd-shadow-md')),flat('0 1px 2px rgba(16,24,40,.04),0 4px 12px -2px rgba(16,24,40,.07)'));
assert.equal(flat(light.get('--sd-shadow-lg')),flat('0 2px 6px rgba(16,24,40,.06),0 24px 48px -12px rgba(16,24,40,.22)'));
for(const name of ['--sd-shadow-sm','--sd-shadow-md','--sd-shadow-lg'])assert.notEqual(flat(dark.get(name)),flat(light.get(name)),`${name} has a dark value`);
assert.doesNotMatch(raw.get('--sd-accent-grad'),/#[0-9a-f]{3,8}\b/i,'gradient takes its endpoints from tokens');
assert.equal(flat(raw.get('--sd-accent-grad')),flat('linear-gradient(135deg, var(--sd-accent-from), var(--sd-accent-to))'));
for(const name of ['--sd-accent-strong','--sd-accent-soft','--sd-accent-hi'])assert.doesNotMatch(raw.get(name),/#[0-9a-f]{3,8}\b|rgba?\(/i,`${name} mixes tokens only`);
const sdx=read('ui/styles/console.css');
for(const name of ['--sdx-hover','--sdx-press','--sdx-edge'])assert.match(sdx,new RegExp(`${name}: color-mix\\(in srgb, var\\(--sd-ink\\) \\d+%, transparent\\)`),`${name} mixes the ink`);
// Every color token has its own dark value. The accent and its fixed partners stay.
// The glow follows the accent in Aurora; scheme variables are inputs, not tokens.
const sameInBoth=new Set(['--sd-on-accent','--sd-accent-from','--sd-accent-to','--sd-accent','--sd-glow']);
for(const [name,value] of light){
 if(typeof value==='string'||name.startsWith('--scheme-'))continue;
 const other=dark.get(name);
 if(sameInBoth.has(name)){same(other,value,`${name} stays in dark mode`);continue;}
 assert.ok(toHex(other)!==toHex(value),`${name} has a distinct dark value (${toHex(value)})`);
}

// Contrast of the resolved tokens in both modes.
const pairs=[
 ['--sd-ink','--sd-bg',4.5],['--sd-ink','--sd-panel',4.5],['--sd-ink','--sd-accent-soft',4.5],
 ['--sd-muted','--sd-bg',4.5],['--sd-muted','--sd-panel',4.5],
 ['--sd-accent-strong','--sd-panel',4.5],['--sd-accent-strong','--sd-accent-soft',4.5],
 ['--sd-success','--sd-success-bg',4.5],['--sd-success','--sd-panel',4.5],
 ['--sd-warn','--sd-warn-bg',4.5],['--sd-warn','--sd-panel',4.5],
 ['--sd-danger','--sd-danger-bg',4.5],['--sd-danger','--sd-panel',4.5],
 ['--sd-on-accent','--sd-accent',4.5],
 ['--sd-accent','--sd-bg',3],['--sd-accent','--sd-panel',3],
];
for(const [mode,tokens] of [['light',light],['dark',dark]])for(const [fore,back,minimum] of pairs){
 const ratio=contrast(tokens.get(fore),tokens.get(back));
 assert.ok(ratio>=minimum,`${mode}: ${fore} on ${back} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`);
}
// The QR code is the fixed-light surface; its modules (--sd-contrast) on its
// surface (--sd-panel) need a scanner-friendly 15:1 in the light scheme.
{
 const ratio=contrast(light.get('--sd-contrast'),light.get('--sd-panel'));
 assert.ok(ratio>=15,`light: --sd-contrast on --sd-panel is ${ratio.toFixed(2)}:1, needs 15:1 for the QR code`);
 const qr=read('ui/session/mfa-qr-code.css');
 assert.match(qr,/\.sd-mfa-qr-surface\{fill:var\(--sd-panel\)\}/,'the QR surface uses --sd-panel');
 assert.match(qr,/\.sd-mfa-qr-modules\{fill:var\(--sd-contrast\)\}/,'the QR modules use --sd-contrast');
}

// No stylesheet below app/ carries a color literal or a named color. Only the
// :root token block and the color scheme blocks of globals.css hold color values.
const isSchemeBlock=node=>node.type==='rule'&&node.parent.type==='root'&&/data-scheme-(?:light|dark)/.test(node.selector);
const literalChecked=new Set();
for(const file of cssFiles){
 const root=parsed.get(file).clone();
 if(file==='app/globals.css')root.each(node=>{if(isRoot(node)||isSchemeBlock(node))node.remove();});
 assert.deepEqual(colorLiterals(root.toString()),[],`${file} has no color literals. Use tokens instead.`);
 assert.ok(!read(file).includes('%23'),`${file} has no color in a data URL`);
 root.walkDecls(decl=>{if(!decl.prop.startsWith('--'))assert.doesNotMatch(decl.value.replace(/url\([^)]*\)/g,''),/(?<![\w-])(?:white|black)(?![\w-])/i,`${file} ${decl.parent.selector}: ${decl.prop} uses a named color`);});
 literalChecked.add(file);
}
// Guard against an empty walk: every stylesheet of the dark mode work is checked.
const named=['ui/account/account.css','ui/account/passkeys.css','ui/settings/customers-panel.css','ui/kit/suggest-input.css','ui/session/mfa-qr-code.css',
 'ui/styles/classic-forms.css','ui/automation/desired-state.css','ui/automation/drift.css','ui/devices/diagnostics/diagnostics-workspace.css','ui/devices/device/agent-update-notice.css','ui/devices/fleet/fleet-agent-updates.css','ui/settings/release-management.css','ui/settings/usage-data.css','ui/base/catalog-owner.css',
 'ui/devices/management/device-services.css','ui/devices/management/device-system.css','ui/devices/hardware/device-hardware.css','ui/devices/hardware/device-gpu.css','ui/devices/management/device-updates.css','ui/devices/management/storage.css','ui/devices/remote/file-browser.css','ui/devices/remote/file-transfers.css','ui/devices/remote/rdp.css','ui/devices/remote/terminal.css','ui/devices/management/device-network-panel.css','ui/devices/management/roles-features.css','ui/settings/troubleshooting.css'];
for(const name of named)assert.ok(literalChecked.has(name),`${name} exists and is checked`);
assert.ok(!existsSync(`app/portal-users.css`),'the deleted users stylesheet is not recreated');

// Text on accent or gradient surfaces uses --sd-on-accent, never a surface
// token (a surface token turns dark in dark mode: 3.4:1 on the accent).
const withoutMixes=value=>{let out=value,at;while((at=out.indexOf('color-mix('))>=0){let depth=0,end=at;for(let i=at+'color-mix'.length;i<out.length;i++){if(out[i]==='(')depth++;else if(out[i]===')'&&--depth===0){end=i+1;break;}}out=out.slice(0,at)+out.slice(end);}return out;};
const accentSurface=/var\(--(?:sd-accent|sd-accent-grad|sd-accent-from|sd-accent-to|primary|destructive)\)/;
const surfaceText=/var\(--(?:sd-panel|sd-bg|sd-glass[\w-]*|sd-soft-line|sd-selected|sd-line|background|card|popover|secondary|muted)\)/;
const onAccentFindings=[];
for(const file of cssFiles)parsed.get(file).walkRules(rule=>{
 const decls=rule.nodes.filter(node=>node.type==='decl');
 if(!decls.some(decl=>/^background(?:-color|-image)?$/.test(decl.prop)&&accentSurface.test(withoutMixes(decl.value))))return;
 for(const decl of decls)if(['color','fill','-webkit-text-fill-color'].includes(decl.prop)&&surfaceText.test(withoutMixes(decl.value)))onAccentFindings.push(`${file}: ${rule.selector.replace(/\s+/g,' ')} { ${decl.prop}: ${decl.value} }`);
});
assert.deepEqual(onAccentFindings,[],'text on accent surfaces uses var(--sd-on-accent)');
// The check itself catches the pattern.
const probe=postcss.parse('.x{color:var(--sd-panel);background:var(--sd-accent-grad)}.y{background:var(--sd-accent);color:var(--sd-on-accent)}.z{background:color-mix(in srgb,var(--sd-accent) 9%,var(--sd-panel));color:var(--sd-panel)}');
const probeHits=[];probe.walkRules(rule=>{const decls=rule.nodes;if(decls.some(d=>d.prop==='background'&&accentSurface.test(withoutMixes(d.value)))&&decls.some(d=>d.prop==='color'&&surfaceText.test(withoutMixes(d.value))))probeHits.push(rule.selector);});
assert.deepEqual(probeHits,['.x']);

// ---- Color schemes ----
const {colorSchemes,schemesFor}=await import('../../../lib/color-schemes.ts');
const blocks=schemeBlocks(globals);
const modes=['light','dark'];
// Scheme blocks only in globals.css, at top level, one per scheme and mode, each
// also matching the menu swatch; they declare only the scheme variables of their mode.
for(const [file,root] of parsed){
 if(file==='app/globals.css')continue;
 root.walkRules(rule=>assert.doesNotMatch(rule.selector,/data-scheme-(?:light|dark)/,`${file}: scheme blocks live only in globals.css`));
 root.walkDecls(decl=>assert.ok(!decl.prop.startsWith('--scheme-'),`${file}: ${decl.prop} is declared outside globals.css`));
}
const defaults=mode=>new Map([...raw].filter(([name])=>name.startsWith(`--scheme-${mode}-`)));
for(const mode of modes)assert.ok(defaults(mode).size>=9,`:root holds the Aurora defaults of the ${mode} scheme variables`);
assert.ok([...raw.keys()].filter(name=>name.startsWith('--scheme-')).every(name=>/^--scheme-(?:light|dark)-[a-z-]+$/.test(name)),'scheme variables are named --scheme-<mode>-*');
const offered=colorSchemes.flatMap(scheme=>scheme.modes.map(mode=>`${scheme.id}/${mode}`)).sort();
assert.deepEqual(blocks.map(block=>`${block.id}/${block.mode}`).sort(),offered,'exactly one block per scheme and offered mode, none without a list entry');
for(const block of blocks){
 assert.equal(block.parent,'root',`${block.selector} sits at the top level`);
 assert.deepEqual(block.parts,[`:root[data-scheme-${block.mode}="${block.id}"]`,`[data-scheme-swatch="${block.id}"]`],`${block.selector}: the page and its swatch`);
 for(const name of block.decls.keys()){
  assert.ok(!name.startsWith('--sd-')&&!bridge.test(name),`${block.selector} declares no token (${name})`);
  assert.ok(name.startsWith(`--scheme-${block.mode}-`),`${block.selector} declares only ${block.mode} scheme variables (${name})`);
 }
 assert.deepEqual([...block.decls.keys()].sort(),[...defaults(block.mode).keys()].sort(),`${block.selector} sets every ${block.mode} scheme variable`);
}
for(const mode of modes)assert.deepEqual(blocks.find(block=>block.id==='aurora'&&block.mode===mode).decls,defaults(mode),`the Aurora ${mode} block repeats the :root defaults`);
// Brand colors (lib/brand-scheme.ts): each variable reads var(--brand-<mode>-<name>, <Aurora value>), so without the
// stylesheet /api/branding/scheme the brand blocks are Aurora. Only that stylesheet declares --brand-*.
for(const mode of modes){
 const brand=blocks.find(block=>block.id==='brand'&&block.mode===mode);
 assert.ok(brand,`the brand ${mode} block exists`);
 for(const [name,value] of brand.decls){
  const part=name.slice(`--scheme-${mode}-`.length);
  assert.equal(flat(value),flat(`var(--brand-${mode}-${part}, ${defaults(mode).get(name)})`),`${name} of brand reads --brand-${mode}-${part} with the Aurora value`);
 }
 const aurora=resolveTokens(globals,mode,{light:'aurora',dark:'aurora'}),branded=resolveTokens(globals,mode,{light:'brand',dark:'brand'});
 for(const [name,value] of aurora)if(typeof value==='string')assert.equal(branded.get(name),value,`${name}: brand without a sheet is Aurora (${mode})`);else same(branded.get(name),value,`${name}: brand without a sheet is Aurora (${mode})`);
}
for(const [file,root] of parsed)root.walkDecls(decl=>assert.ok(!decl.prop.startsWith('--brand-'),`${file}: ${decl.prop} declares a brand value; only /api/branding/scheme does`));
let schemeRuleCount=0;parsed.get('app/globals.css').walkRules(rule=>{if(/data-scheme-/.test(rule.selector))schemeRuleCount++;});
assert.equal(schemeRuleCount,blocks.length);
// The scheme-able tokens read their mode's scheme variable; glass is derived from the panel.
for(const [token,part] of [['--sd-accent','accent'],['--sd-on-accent','on-accent'],['--sd-accent-from','from'],['--sd-accent-to','to'],['--sd-bg','bg'],['--sd-glow','glow']])assert.equal(flat(raw.get(token)),flat(`light-dark(var(--scheme-light-${part}), var(--scheme-dark-${part}))`),`${token} reads the scheme variables`);
assert.equal(flat(raw.get('--sd-panel')),flat('light-dark(#fff, var(--scheme-dark-panel))'));
for(const [name,lightShare,darkShare] of [['--sd-glass',68,72],['--sd-glass-strong',84,90]])assert.equal(flat(raw.get(name)),flat(`light-dark(color-mix(in srgb, var(--sd-panel) ${lightShare}%, transparent), color-mix(in srgb, var(--sd-panel) ${darkShare}%, transparent))`),`${name} follows the panel`);
for(const mode of modes){
 assert.ok(raw.get('--sd-accent-strong').includes(`var(--sd-accent) var(--scheme-${mode}-strong)`),`strong mix ratio of ${mode} is a scheme variable`);
 assert.ok(raw.get('--sd-accent-soft').includes(`var(--sd-accent) var(--scheme-${mode}-soft)`),`soft mix ratio of ${mode} is a scheme variable`);
}
// Scheme variables are read only by the token block, the menu swatch and the preview window of Settings › Branding
// (a large swatch of the brand scheme: [data-scheme-swatch="brand"] sets the variables on it).
const previewValues=new Map();
for(const file of cssFiles)if(file!=='app/globals.css')parsed.get(file).walkDecls(decl=>{
 if(!decl.value.includes('--scheme-'))return;
 const preview=file==='ui/settings/branding.css'&&decl.parent.selector==='.sdx-stage-window'&&decl.prop.startsWith('--sdx-pv-');
 if(preview)previewValues.set(decl.prop,flat(decl.value));
 assert.ok(preview||file==='ui/styles/console.css'&&decl.parent.selector.startsWith('.sdx-scheme-swatch'),`${file} ${decl.parent.selector} reads a scheme variable`);
});
// The preview window repeats the formulas of the scheme-able tokens, so it shows what the brand scheme will look like:
// the same light-dark() pairs, the panel (the light panel is the token itself, the dark one the scheme panel), the
// soft mix with the scheme shares and the gradient from the two scheme ends.
for(const [name,token] of [['--sdx-pv-bg','--sd-bg'],['--sdx-pv-accent','--sd-accent'],['--sdx-pv-on-accent','--sd-on-accent'],['--sdx-pv-glow','--sd-glow']])assert.equal(previewValues.get(name),flat(raw.get(token)),`${name} repeats ${token}`);
assert.equal(previewValues.get('--sdx-pv-panel'),flat('light-dark(var(--sd-panel), var(--scheme-dark-panel))'),'the preview panel follows the scheme panel');
assert.equal(previewValues.get('--sdx-pv-soft'),flat(raw.get('--sd-accent-soft')).replaceAll('var(--sd-accent)','var(--sdx-pv-accent)').replaceAll('var(--sd-panel)','var(--sdx-pv-panel)'),'the preview soft tone repeats --sd-accent-soft');
assert.equal(previewValues.get('--sdx-pv-grad'),flat(raw.get('--sd-accent-grad')).replace('var(--sd-accent-from)',flat(raw.get('--sd-accent-from'))).replace('var(--sd-accent-to)',flat(raw.get('--sd-accent-to'))),'the preview gradient repeats --sd-accent-grad');
assert.equal(previewValues.size,7,'the preview window declares seven scheme values');
const swatchBackground=part=>{let value;parsed.get('ui/styles/console.css').walkRules(`.sdx-scheme-swatch::${part}`,rule=>rule.walkDecls('background',decl=>{value=flat(decl.value);}));return value;};
assert.equal(swatchBackground('after'),flat('light-dark(var(--scheme-light-accent), var(--scheme-dark-accent))'),'swatch: lead color in front');
assert.equal(swatchBackground('before'),flat('light-dark(var(--scheme-light-surface), var(--scheme-dark-surface))'),'swatch: surface color behind');
assert.match(read('ui/styles/classic-panels.css'),/radial-gradient\(1100px 520px at 105% -8%, color-mix\(in srgb,var\(--sd-glow\) 9%,transparent\)/,'the console glow uses --sd-glow');
assert.match(read('ui/session/session.css'),/radial-gradient\(900px 480px at 85% -5%,color-mix\(in srgb,var\(--sd-glow\) 12%,transparent\)/,'the session glow uses --sd-glow');
const schemeSource=read('ui/shell/color-scheme.tsx');
assert.deepEqual(colorLiterals(schemeSource),[],'color-scheme.tsx holds no color value');
assert.doesNotMatch(schemeSource,/style=\{/,'and no inline style');

// With Aurora (no attribute or data-scheme-*="aurora") every token is today's value, in both modes.
const todayDark={
 '--sd-bg':'#11151c','--sd-panel':'#191e27','--sd-glass':'rgba(25,30,39,.72)','--sd-glass-strong':'rgba(25,30,39,.9)',
 '--sd-accent':'#5b5cf6','--sd-on-accent':'#fff','--sd-accent-from':'#7c4dff','--sd-accent-to':'#1fb6ff','--sd-glow':'#5b5cf6',
 '--sd-accent-strong':'color-mix(in srgb, #5b5cf6 55%, #f5f7fb)','--sd-accent-soft':'color-mix(in srgb, #5b5cf6 20%, #191e27)','--sd-accent-hi':'color-mix(in srgb, #5b5cf6 84%, #191e27)',
 '--sd-ink':'#e6e9ef','--sd-muted':'#9aa3b2','--sd-line':'#2c3340','--sd-selected':'#262c38','--sd-contrast':'#f5f7fb',
};
for(const [name,expected] of Object.entries(todayDark))same(dark.get(name),color(expected,'dark'),`${name} (dark)`);
same(light.get('--sd-glow'),color('#5b5cf6'),'--sd-glow (light)');
for(const mode of modes){
 const base=mode==='light'?light:dark,tokens=resolveTokens(globals,mode,{light:'aurora',dark:'aurora'});
 for(const [name,value] of base)if(typeof value==='string')assert.equal(tokens.get(name),value,name);else same(tokens.get(name),value,`${name} with Aurora (${mode})`);
}

// Roles, contrast and the limits of every adjustment, per offered scheme and mode.
const requested={'cyber-teal':['#0a5b61','#7fffd4'],inkberry:['#1a0b2e','#ffb7a5'],'electric-violet':['#6a00f4','#ffd6a5'],ember:['#ff6115','#fffcf4'],'prompt-blue':['#0b132b','#39ff88']};
// Aurora and the brand colors (Aurora without a brand sheet; tests/lib/brand-scheme.mjs checks derived values) have no requested pair.
assert.deepEqual(Object.keys(requested),colorSchemes.map(scheme=>scheme.id).filter(id=>id!=='aurora'&&id!=='brand'));
const neutral=['--sd-ink','--sd-muted','--sd-line','--sd-soft-line','--sd-selected','--sd-contrast','--sd-success','--sd-success-bg','--sd-warn','--sd-warn-bg','--sd-danger','--sd-danger-bg','--sd-shadow-color','--sd-glass-edge','--sd-meter','--sd-meter-track'];
const close=(a,b)=>['r','g','b'].every(key=>Math.abs(a[key]-b[key])<=.6)&&Math.abs(a.a-b.a)<.005;
// Share (0–100 %, in steps of .5) of `second` in a mix of `first` and `second` that gives `actual`, or null.
const shareOf=(actual,first,second,limit=100)=>{for(let step=0;step<=limit*2;step++)if(close(actual,color(`color-mix(in srgb, ${first} ${100-step/2}%, ${second})`)))return step/2;return null;};
let schemeChecks=0;
for(const mode of modes)for(const scheme of schemesFor(mode)){
 const tokens=resolveTokens(globals,mode,{light:'aurora',dark:'aurora',[mode]:scheme.id});
 const base=mode==='light'?light:dark;
 const label=`${scheme.id} (${mode})`;
 for(const [fore,back,minimum] of pairs){const ratio=contrast(tokens.get(fore),tokens.get(back));assert.ok(ratio>=minimum,`${label}: ${fore} on ${back} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`);}
 for(const name of neutral)same(tokens.get(name),base.get(name),`${label}: ${name} stays neutral`);
 for(const name of ['--sd-shadow-sm','--sd-shadow-md','--sd-shadow-lg'])assert.equal(tokens.get(name),base.get(name),`${label}: ${name} stays neutral`);
 if(scheme.id==='aurora'||scheme.id==='brand')continue;
 for(const back of ['--sd-accent-from','--sd-accent-to']){const ratio=contrast(tokens.get('--sd-on-accent'),tokens.get(back));assert.ok(ratio>=4.5,`${label}: --sd-on-accent on ${back} is ${ratio.toFixed(2)}:1, needs 4.5:1`);}
 const [primary,secondary]=requested[scheme.id];
 const lead=mode==='light'?primary:secondary,tint=mode==='light'?secondary:primary;
 same(tokens.get('--sd-accent-from'),tokens.get('--sd-accent'),`${label}: the gradient starts at the lead color`);
 const shift=shareOf(tokens.get('--sd-accent'),lead,mode==='light'?'#000':'#fff',15);
 assert.ok(shift!==null,`${label}: the lead color ${toHex(tokens.get('--sd-accent'))} is ${lead} mixed with at most 15 % ${mode==='light'?'black':'white'}`);
 if(toHex(tokens.get('--sd-on-accent'))!=='#ffffff')assert.ok(contrast(color('#fff'),tokens.get('--sd-accent'))<4.5,`${label}: a dark on-accent only where white does not reach 4.5:1`);
 assert.equal(toHex(tokens.get('--sd-glow')),toHex(color(secondary)),`${label}: the glow uses ${secondary}`);
 const scope=blocks.find(block=>block.id===scheme.id&&block.mode===mode).decls;
 assert.equal(toHex(color(scope.get(`--scheme-${mode}-surface`))),toHex(color(tint)),`${label}: the swatch shows ${tint}`);
 if(mode==='light'){
  same(tokens.get('--sd-panel'),light.get('--sd-panel'),`${label}: the light panel stays white`);
  assert.ok(shareOf(tokens.get('--sd-bg'),'#f4f6fa',secondary)>0,`${label}: the background is a tint of ${secondary}`);
 }else{
  assert.ok(shareOf(tokens.get('--sd-bg'),'#11151c',primary)>0,`${label}: the background is a tint of ${primary}`);
  assert.ok(shareOf(tokens.get('--sd-panel'),'#191e27',primary)>0,`${label}: the panel is a tint of ${primary}`);
 }
 schemeChecks++;
}
assert.equal(schemeChecks,8,'eight new scheme/mode pairs are checked');

console.log('theme tokens ok');
