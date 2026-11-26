// Text contrast over the portal backgrounds (docs/branding.md). Console: for every mode, offered scheme and region,
// --sd-ink and the secondary text of each material keep 4.5:1 on each material of the region (from
// ui/shell/console-backdrop.css, and the menus' strong glass from ui/styles/console.css) over the region's scrim from
// the CSS (with the percentage that backdropScrims computes) over the low and the high pixel of the fallback and of
// every bundled measure. The secondary text is the backdrop tone (--sdx-muted-backdrop, resolved from the stylesheet)
// on the surfaces that re-point --sd-muted to it, and --sd-muted on the menus. The active underline tab label
// (--sd-accent-strong) and the inactive labels keep 4.5:1 on the sticky tab band over the workspace scrim, also over
// solid black, white, mid-gray and a saturated color. The CSS fallback percentages equal
// backdropScrims(fallbackBackdropMeasure, null). Sign-in: the session card with a sign-in background is the opaque
// panel, on which its texts reach 4.5:1 for any image. All colors come from the stylesheets.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {postcss,rootTokens,schemeBlocks,resolveColor,contrast,over,toHex} from '../../support/theme-colors.mjs';

const {backdropScrims,fallbackBackdropMeasure}=await import('../../../lib/backdrop.ts');
const {brandingBackgrounds}=await import('../../../lib/branding.ts');

const read=file=>readFileSync(file,'utf8');
const globals=read('app/globals.css'),backdrop=postcss.parse(read('ui/shell/console-backdrop.css')),session=postcss.parse(read('ui/session/session.css')),consoleCss=postcss.parse(read('ui/styles/console.css'));
const norm=text=>text.replace(/\s+/g,' ').trim();
const declOf=(root,selector,prop)=>{let value;root.walkRules(rule=>{if(norm(rule.selector)===selector)rule.walkDecls(prop,decl=>{value=decl.value;});});return value;};

// The scrim of each region, declared once on .sdx[data-backdrop] (and the Branding preview).
const regions=['bars','navigator','workspace'];
const scrimRule=norm('.sdx[data-backdrop], .sdx-backdrop-scrims');
const scrims=Object.fromEntries(regions.map(region=>[region,declOf(backdrop,scrimRule,`--sdx-backdrop-${region}`)]));
for(const region of regions)assert.match(scrims[region]??'',new RegExp(`^light-dark\\(color-mix\\(in srgb, var\\(--sd-bg\\) var\\(--sdx-scrim-${region}-light, \\d+%\\), transparent\\), color-mix\\(in srgb, var\\(--sd-bg\\) var\\(--sdx-scrim-${region}-dark, \\d+%\\), transparent\\)\\)$`),`${region}: the scrim mixes --sd-bg with the scrim property, no color literal`);
// The CSS fallbacks are the fallback scrims.
const fallback=backdropScrims(fallbackBackdropMeasure,null);
for(const region of regions)for(const mode of ['light','dark']){
 const percent=Number(new RegExp(`--sdx-scrim-${region}-${mode}, (\\d+)%`).exec(scrims[region])[1]);
 assert.equal(percent,fallback[mode][region],`${region} ${mode}: the CSS fallback equals backdropScrims(fallbackBackdropMeasure, null)`);
}

// The secondary tones, declared on the frame while the backdrop shows.
const mutedBackdrop=declOf(backdrop,'.sdx[data-backdrop]','--sdx-muted-backdrop'),mutedContent=declOf(backdrop,'.sdx[data-backdrop]','--sdx-muted-content');
assert.match(mutedBackdrop??'',/^light-dark\(color-mix\(in srgb, var\(--sd-ink\) \d+%, var\(--sd-muted\)\), var\(--sd-muted\)\)$/,'the backdrop tone mixes ink into muted in light mode and is muted in dark mode');
assert.equal(mutedContent,'var(--sd-muted)','the content tone is --sd-muted');
// The surface classes whose secondary text is re-pointed to the backdrop tone.
const lastClass=selector=>/\.sdx-[\w-]+$/.exec(norm(selector))?.[0];
const toBackdrop=new Set();
backdrop.walkDecls('--sd-muted',decl=>{if(decl.value==='var(--sdx-muted-backdrop)')for(const selector of decl.parent.selectors)toBackdrop.add(lastClass(selector));});

// The materials of each region: every background of console-backdrop.css that names a region scrim, plus the menus,
// each with its secondary text: the backdrop tone where the surface re-points --sd-muted, else --sd-muted.
const materials={bars:new Map(),navigator:new Map(),workspace:new Map()};
backdrop.walkDecls('background',decl=>{
 const region=/var\(--sdx-backdrop-(bars|navigator|workspace)\)/.exec(decl.value)?.[1];
 if(!region||decl.parent.selector.includes('sdx-bg-preview'))return;
 const gradient=/^linear-gradient\((var\(--sd-glass(?:-strong)?\)), \1\), var\(--sdx-backdrop-\w+\)$/.exec(decl.value);
 assert.ok(gradient||decl.value===`var(--sdx-backdrop-${region})`,`${decl.parent.selector}: a token material over the region scrim (${decl.value})`);
 const material=gradient?gradient[1]:null;
 for(const selector of decl.parent.selectors){
  const text=toBackdrop.has(lastClass(selector))?'backdrop':'muted';
  assert.ok(!materials[region].has(material)||materials[region].get(material)===text,`${selector}: one secondary text per material`);
  materials[region].set(material,text);
 }
});
const menu=declOf(consoleCss,'.sdx-menu','background');
assert.equal(menu,'var(--sd-glass-strong)','menus keep the strong glass');
materials.workspace.set(menu,'muted');
const listed=region=>[...materials[region]].map(([material,text])=>`${material??'canvas'}: ${text}`).sort();
assert.deepEqual(listed('bars'),['var(--sd-glass): backdrop','var(--sd-glass-strong): backdrop'],'bars: the glass (top bar, rail, dock) and the strong glass (bottom bar), with the backdrop tone');
assert.deepEqual(listed('navigator'),['var(--sd-glass-strong): backdrop'],'navigator: the strong glass, with the backdrop tone');
assert.deepEqual(listed('workspace'),['canvas: backdrop','var(--sd-glass-strong): muted'],'workspace: the backdrop tone on the canvas, --sd-muted on the strong glass of menus');

// The sticky underline tab band over the workspace canvas.
const band=declOf(consoleCss,'.sdx-tabs','background');
assert.match(band??'',/^color-mix\(in srgb, var\(--sd-bg\) \d+%, transparent\)$/,'the tab band is a token tint over the canvas');
assert.equal(declOf(consoleCss,'.sdx-tabs :is(.sdx-tab, .sdx-tabs-more).active','color'),'var(--sd-accent-strong)','the active tab label is --sd-accent-strong');
assert.equal(declOf(consoleCss,'.sdx-tabs :is(.sdx-tab, .sdx-tabs-more)','color'),'var(--sd-muted)','inactive tab labels are --sd-muted (the backdrop tone in the workspace)');

const sessionCard=declOf(session,'.sd-session-screen-image .sd-session-card','background');
assert.equal(sessionCard,'var(--sd-panel)','with a sign-in background the session card is the opaque panel');
const sessionScrim=declOf(session,'.sd-session-screen-image::before','background');
assert.ok(sessionScrim&&/var\(--sd-bg\)/.test(sessionScrim),'the sign-in background has a token scrim');

const measures=[['fallback',fallbackBackdropMeasure],...brandingBackgrounds.map(background=>[background.id,background.measure])];
// Synthetic measures for the tab band: solid black, solid white, mid-gray and a saturated color.
const synthetic=[
 ['black',{light:{low:'#000000',high:'#000000'},dark:{low:'#000000',high:'#000000'}}],
 ['white',{light:{low:'#ffffff',high:'#ffffff'},dark:{low:'#e6e6e6',high:'#e6e6e6'}}],
 ['gray',{light:{low:'#7a7a7a',high:'#8a8a8a'},dark:{low:'#6e6e6e',high:'#7c7c7c'}}],
 ['saturated',{light:{low:'#e0103a',high:'#ff2a50'},dark:{low:'#c80e34',high:'#e62548'}}],
];
const raw=rootTokens(globals),blocks=schemeBlocks(globals);
const parse=hex=>({r:parseInt(hex.slice(1,3),16),g:parseInt(hex.slice(3,5),16),b:parseInt(hex.slice(5,7),16),a:1});
const failures=[];let checks=0;
for(const mode of ['light','dark']){
 const ids=[undefined,...new Set(blocks.filter(block=>block.mode===mode).map(block=>block.id))];
 for(const id of ids){
  const base=new Map(raw);
  if(id)for(const block of blocks)if(block.mode===mode&&block.id===id)for(const [name,value] of block.decls)base.set(name,value);
  const where=`${mode} ${id??'default'}`,color=(text,tokens=base)=>resolveColor(text,tokens,mode);
  const ink=color('var(--sd-ink)'),muted=color('var(--sd-muted)'),panel=color('var(--sd-panel)'),accent=color('var(--sd-accent-strong)');
  const secondary={backdrop:color(mutedBackdrop),muted};
  if(mode==='dark')assert.equal(toHex(secondary.backdrop),toHex(muted),`${where}: the dark backdrop tone is --sd-muted`);
  for(const [name,measure] of [...measures,...synthetic]){
   const percent=backdropScrims(measure,null);
   const tokens=new Map(base);
   for(const region of regions)tokens.set(`--sdx-scrim-${region}-${mode}`,`${percent[mode][region]}%`);
   // The tab band: its tint over the workspace canvas, with the active (accent) and the inactive (backdrop tone) labels.
   for(const [pixelName,pixel] of [['low',measure[mode].low],['high',measure[mode].high]]){
    const shown=over(color(band,tokens),over(color(scrims.workspace,tokens),parse(pixel)));
    for(const [textName,text] of [['--sd-accent-strong',accent],['--sdx-muted-backdrop',secondary.backdrop]]){
     const ratio=contrast(text,shown);checks++;
     if(ratio<4.5)failures.push(`${where} ${name} tab band: ${textName} over the ${pixelName} pixel is ${ratio.toFixed(2)}:1 (${toHex(shown)})`);
    }
   }
   if(synthetic.some(([id])=>id===name))continue;
   for(const region of regions){
    const scrim=color(scrims[region],tokens);
    for(const [material,secondaryName] of materials[region])for(const [pixelName,pixel] of [['low',measure[mode].low],['high',measure[mode].high]]){
     const below=over(scrim,parse(pixel)),surface=material?over(color(material),below):below;
     for(const [textName,text] of [['--sd-ink',ink],[secondaryName==='backdrop'?'--sdx-muted-backdrop':'--sd-muted',secondary[secondaryName]]]){
      const ratio=contrast(text,surface);checks++;
      if(ratio<4.5)failures.push(`${where} ${name} ${region} ${material??'canvas'}: ${textName} over the ${pixelName} pixel is ${ratio.toFixed(2)}:1 (${toHex(surface)})`);
     }
    }
   }
  }
  assert.equal(panel.a,1,`${where}: the panel is opaque`);
  for(const [name,text] of [['--sd-ink',ink],['--sd-muted',muted]]){
   const ratio=contrast(text,panel);checks++;
   if(ratio<4.5)failures.push(`${where}: ${name} on the session card is ${ratio.toFixed(2)}:1`);
  }
 }
}
assert.deepEqual(failures,[],failures.join('\n'));
// 2 modes × (the defaults + 6 schemes) × (7 measures × 5 region materials × 2 pixels × 2 texts + 11 measures × 2
// pixels × 2 tab band texts + 2 card texts).
assert.equal(checks,2*7*(7*5*2*2+11*2*2+2),`every mode, scheme, measure, region, material, pixel and text is checked (${checks})`);
console.log(`theme backdrop ok (${checks} checks)`);
