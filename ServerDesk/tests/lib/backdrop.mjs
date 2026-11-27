// The console background math (lib/backdrop.ts, docs/branding.md): measureBackdrop (a solid image gives its filtered
// color, fine black and white stripes blur to a narrower range, a stronger blur never widens the range, a transparent
// pixel adds both extremes, an image over 320 px is averaged down, lowercase #rrggbb), the filter math against the CSS
// Filter Effects saturate and brightness matrices, and backdropScrims (integers from 0 to 100, every check of each
// mode, region, material, scheme and pixel passes at n, one fails at n − 1, a narrower measure never needs more) for
// the fallback, every bundled measure and synthetic measures, without and with 24 seeded brand schemes. The checked
// texts are ink and the secondary text of each material: the backdrop tone (light: ink 40 % over muted, the share
// declared in ui/shell/console-backdrop.css; dark: muted) on the bars, the navigator and the canvas, muted on the
// workspace's strong glass, and in light mode --sd-accent-strong on the tab band over the canvas (its share from
// ui/styles/console.css). The exact scrims of the fallback and the bundled measures, their light workspace scrim equal
// to the one the texts alone need (the tab band never binds for a built-in scheme), and no light scrim above the
// earlier rule (ink and muted on every material). The token constants equal app/globals.css and the scheme list
// equals lib/color-schemes.ts.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {contrast,over,resolveTokens} from '../support/theme-colors.mjs';

const backdrop=await import('../../lib/backdrop.ts');
const {backdropFilters,backdropGlass,backdropMaterials,backdropModes,backdropMutedInkShare,backdropRegions,backdropSchemes,backdropScrims,backdropTabBand,backdropText,blurPasses,fallbackBackdropMeasure,filterPixel,isBackdropMeasure,measureBackdrop}=backdrop;
const {brandingBackgrounds}=await import('../../lib/branding.ts');
const {colorSchemes}=await import('../../lib/color-schemes.ts');
const {deriveBrandScheme}=await import('../../lib/brand-scheme.ts');

let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const hex=/^#[0-9a-f]{6}$/;
const parse=value=>({r:parseInt(value.slice(1,3),16),g:parseInt(value.slice(3,5),16),b:parseInt(value.slice(5,7),16)});
const toHex=({r,g,b})=>'#'+[r,g,b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
const image=(width,height,pixel)=>{const data=new Uint8ClampedArray(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set(pixel(x,y),(y*width+x)*4);return data;};
const within=(inner,outer)=>['r','g','b'].every(c=>parse(outer.low)[c]<=parse(inner.low)[c]&&parse(inner.high)[c]<=parse(outer.high)[c]);

// ---- The filter math: the CSS Filter Effects matrices (feColorMatrix saturate, feComponentTransfer brightness). ----
const cssSaturate=(s,{r,g,b})=>[
 [.213+.787*s,.715-.715*s,.072-.072*s],
 [.213-.213*s,.715+.285*s,.072-.072*s],
 [.213-.213*s,.715-.715*s,.072+.928*s],
].map(row=>Math.min(255,Math.max(0,row[0]*r+row[1]*g+row[2]*b)));
for(const mode of backdropModes){
 const filter=backdropFilters[mode];
 for(const color of [{r:0,g:0,b:0},{r:255,g:255,b:255},{r:200,g:30,b:90},{r:12,g:240,b:250},{r:128,g:128,b:128}]){
  const [r,g,b]=cssSaturate(filter.saturate,color).map(v=>Math.min(255,Math.max(0,v*filter.brightness)));
  const got=filterPixel(color,filter);
  ok(Math.abs(got.r-r)<1e-9&&Math.abs(got.g-g)<1e-9&&Math.abs(got.b-b)<1e-9,`${mode}: the filter of ${toHex(color)} follows the CSS matrices`);
 }
}
check(filterPixel({r:255,g:0,b:0},{saturate:2,brightness:1}).r,255,'saturate clamps to 255');
check(filterPixel({r:255,g:0,b:0},{saturate:2,brightness:1}).g,0,'saturate clamps to 0');
ok(backdropFilters.light.blur>=40&&backdropFilters.dark.blur>=40,'a strong blur in each mode');
const css=readFileSync('ui/shell/console-backdrop.css','utf8');
for(const mode of backdropModes){
 const {blur,saturate,brightness}=backdropFilters[mode];
 const declared=new RegExp(`--sdx-backdrop-filter-${mode}: ([^;]+);`).exec(css)?.[1];
 check(declared,`blur(${blur}px) saturate(${saturate})${brightness===1?'':` brightness(${String(brightness).replace(/^0\./,'.')})`}`,`${mode}: the CSS filter equals backdropFilters`);
}

// ---- measureBackdrop ----
const solid=(width,height,[r,g,b,a=255])=>image(width,height,()=>[r,g,b,a]);
for(const color of [[100,100,100],[51,102,153],[240,200,20]]){
 const measure=measureBackdrop(solid(64,36,color),64,36);
 for(const mode of backdropModes){
  const filtered=filterPixel({r:color[0],g:color[1],b:color[2]},backdropFilters[mode]);
  const low=toHex({r:Math.floor(filtered.r+1e-9),g:Math.floor(filtered.g+1e-9),b:Math.floor(filtered.b+1e-9)}),high=toHex({r:Math.ceil(filtered.r-1e-9),g:Math.ceil(filtered.g-1e-9),b:Math.ceil(filtered.b-1e-9)});
  check(measure[mode],{low,high},`${mode}: a solid ${toHex({r:color[0],g:color[1],b:color[2]})} gives its filtered color`);
 }
}
check(measureBackdrop(solid(64,36,[100,100,100]),64,36).light,{low:'#646464',high:'#646464'},'a solid gray is low = high');
const stripes=measureBackdrop(image(320,180,x=>x%2?[255,255,255,255]:[0,0,0,255]),320,180);
for(const mode of backdropModes){
 const {low,high}=stripes[mode];
 ok(parse(low).r>40&&parse(high).r<215,`${mode}: fine black and white stripes blur to a narrower range (${low} to ${high})`);
}
let seed=7;const random=()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};
const noise=image(160,90,()=>[Math.floor(random()*256),Math.floor(random()*256),Math.floor(random()*256),255]);
let previous=null;
for(const blurShare of [0,.1,.25,.5,.75,1]){
 const measure=measureBackdrop(noise,160,90,{blurShare});
 if(previous)for(const mode of backdropModes)ok(within(measure[mode],previous[mode]),`${mode}: blur share ${blurShare} never widens the range of a weaker blur`);
 previous=measure;
}
ok(blurPasses(4.5)===40&&blurPasses(0)===0,'the binomial rounds keep the variance at or below sigma²');
const clear=measureBackdrop(solid(32,32,[100,100,100,0]),32,32);
check(clear.light,{low:'#000000',high:'#ffffff'},'a transparent image counts over black and over white');
check(clear.dark,{low:'#000000',high:toHex({r:Math.ceil(255*.9),g:Math.ceil(255*.9),b:Math.ceil(255*.9)})},'dark: over black and over white, after brightness');
const onePixel=image(32,32,(x,y)=>x===0&&y===0?[100,100,100,0]:[100,100,100,255]);
const withHole=measureBackdrop(onePixel,32,32).light;
ok(parse(withHole.low).r<100&&parse(withHole.high).r>100,'one transparent pixel adds both extremes');
const large=measureBackdrop(solid(1280,720,[51,102,153]),1280,720),small=measureBackdrop(solid(320,180,[51,102,153]),320,180);
check(large,small,'an image over 320 px is averaged down first');
for(const measure of [stripes,clear,large])for(const mode of backdropModes)ok(hex.test(measure[mode].low)&&hex.test(measure[mode].high),`${mode}: lowercase #rrggbb`);
ok(isBackdropMeasure(stripes)&&!isBackdropMeasure({light:{low:'#ffffff',high:'#000000'},dark:fallbackBackdropMeasure.dark})&&!isBackdropMeasure({light:{low:'#FFFFFF',high:'#ffffff'},dark:fallbackBackdropMeasure.dark}),'isBackdropMeasure checks the format and the order');
check(fallbackBackdropMeasure,{light:{low:'#000000',high:'#ffffff'},dark:{low:'#000000',high:'#ffffff'}},'the fallback is black to white');

// ---- The constants against app/globals.css ----
const globals=readFileSync('app/globals.css','utf8');
const close=(a,b)=>['r','g','b'].every(c=>Math.abs(a[c]-b[c])<1e-9);
for(const mode of backdropModes){
 const offered=colorSchemes.filter(scheme=>scheme.modes.includes(mode)).map(scheme=>scheme.id);
 check(Object.keys(backdropSchemes[mode]).sort(),[...offered].sort(),`${mode}: the scheme list equals lib/color-schemes.ts`);
 for(const id of offered){
  const tokens=resolveTokens(globals,mode,{light:id,dark:id});
  ok(close(backdropSchemes[mode][id].bg,tokens.get('--sd-bg'))&&close(backdropSchemes[mode][id].panel,tokens.get('--sd-panel')),`${mode} ${id}: bg and panel equal app/globals.css`);
  if(mode==='light')ok(close(backdropSchemes[mode][id].accentStrong,tokens.get('--sd-accent-strong')),`${mode} ${id}: accent-strong equals app/globals.css`);
 }
 const tokens=resolveTokens(globals,mode);
 ok(close(parse(backdropText[mode].ink),tokens.get('--sd-ink'))&&close(parse(backdropText[mode].muted),tokens.get('--sd-muted')),`${mode}: ink and muted equal app/globals.css`);
 ok(Math.abs(tokens.get('--sd-glass').a-backdropGlass[mode].glass/100)<1e-9&&Math.abs(tokens.get('--sd-glass-strong').a-backdropGlass[mode].strong/100)<1e-9,`${mode}: the glass shares equal app/globals.css`);
}

const band=/\.sdx-tabs \{[^}]*background: color-mix\(in srgb, var\(--sd-bg\) (\d+)%, transparent\)/.exec(readFileSync('ui/styles/console.css','utf8'))?.[1];
check(Number(band),backdropTabBand,'the tab band share equals ui/styles/console.css');

// ---- backdropScrims ----
const mix=(a,p,b)=>({r:a.r*p/100+b.r*(1-p/100),g:a.g*p/100+b.g*(1-p/100),b:a.b*p/100+b.b*(1-p/100),a:1});
// The surfaces of every scheme offered in a mode, from the stylesheet (brand: the derived values when a scheme is stored).
const surfacesOf=(mode,brand)=>{
 const derived=brand?deriveBrandScheme(brand):null;
 return colorSchemes.filter(scheme=>scheme.modes.includes(mode)).map(scheme=>{
  if(scheme.id==='brand'&&derived?.ok){
   const values=derived[mode].values,strong=mix({...parse(values.accent),a:1},80,{...parse('#0b1220'),a:1});
   return {id:'brand*',bg:{...parse(values.bg),a:1},panel:{...parse(mode==='dark'?values.panel:'#ffffff'),a:1},accentStrong:strong};
  }
  const tokens=resolveTokens(globals,mode,{light:scheme.id,dark:scheme.id});
  return {id:scheme.id,bg:tokens.get('--sd-bg'),panel:tokens.get('--sd-panel'),accentStrong:tokens.get('--sd-accent-strong')};
 });
};
// The backdrop tone: the ink share declared in the stylesheet, mixed in sRGB as color-mix does.
const share=Number(/--sdx-muted-backdrop: light-dark\(color-mix\(in srgb, var\(--sd-ink\) (\d+)%, var\(--sd-muted\)\), var\(--sd-muted\)\);/.exec(css)?.[1]);
check(share,backdropMutedInkShare,'the CSS ink share of the backdrop tone equals backdropMutedInkShare');
const textTokens=Object.fromEntries(backdropModes.map(mode=>{
 const tokens=resolveTokens(globals,mode),ink=tokens.get('--sd-ink'),muted=tokens.get('--sd-muted');
 return [mode,{ink,muted,backdrop:mode==='light'?mix(ink,share,muted):muted}];
}));
for(const mode of backdropModes)ok(close(backdropText[mode].backdrop,textTokens[mode].backdrop),`${mode}: the backdrop tone is ${mode==='light'?`ink ${share} % over muted`:'muted'}`);
ok(contrast(textTokens.light.backdrop,resolveTokens(globals,'light').get('--sd-bg'))>7,'light: the backdrop tone has more than 7:1 on --sd-bg');
/** The texts of one material: ink and the backdrop tone, except muted on the workspace's strong glass (the portaled menus). */
const texts=(mode,region,material)=>[textTokens[mode].ink,region==='workspace'&&material!==null?textTokens[mode].muted:textTokens[mode].backdrop];
/** The earlier rule, as a reference: ink and muted on every material. */
const earlierTexts=mode=>[textTokens[mode].ink,textTokens[mode].muted];
/**
 * Every contrast check of backdropScrims for one mode, region and n: each text ≥ 4.5 on material over scrim over the
 * low and the high pixel; in light mode the workspace adds --sd-accent-strong on the tab band over the canvas (4.5, or
 * the ratio on --sd-bg for a brand label that misses 4.5 there already). The earlier rule has no band check, and
 * band=false leaves it out for the texts alone.
 */
function failures(mode,region,n,measure,surfaces,textsOf=texts,band=textsOf===texts){
 const out=[];
 for(const surface of surfaces)for(const pixel of [measure[mode].low,measure[mode].high]){
  const scrimmed=over({...surface.bg,a:n/100},{...parse(pixel),a:1});
  for(const material of backdropMaterials[mode][region]){
   const shown=material===null?scrimmed:over({...surface.panel,a:material/100},scrimmed);
   for(const text of textsOf(mode,region,material))if(contrast(text,shown)<4.5)out.push(`${surface.id} ${material} ${pixel}`);
  }
  if(mode==='light'&&region==='workspace'&&band){
   const shown=over({...surface.bg,a:backdropTabBand/100},scrimmed);
   if(contrast(surface.accentStrong,shown)<Math.min(4.5,contrast(surface.accentStrong,surface.bg)))out.push(`${surface.id} tab band ${pixel}`);
  }
 }
 return out;
}
/** The smallest scrim of the earlier rule (100 if none passes). */
const earlierScrim=(mode,region,measure,surfaces)=>{let n=0;while(n<100&&failures(mode,region,n,measure,surfaces,earlierTexts).length)n++;return n;};
const named={fallback:fallbackBackdropMeasure,...Object.fromEntries(brandingBackgrounds.map(background=>[background.id,background.measure])),
 black:{light:{low:'#000000',high:'#000000'},dark:{low:'#000000',high:'#000000'}},
 white:{light:{low:'#ffffff',high:'#ffffff'},dark:{low:'#e6e6e6',high:'#e6e6e6'}},
 gray:{light:{low:'#7a7a7a',high:'#8a8a8a'},dark:{low:'#6e6e6e',high:'#7c7c7c'}},
 saturated:{light:{low:'#e0103a',high:'#ff2a50'},dark:{low:'#c80e34',high:'#e62548'}}};
const brands=[null];
seed=321;
const randomHex=()=>'#'+[0,0,0].map(()=>Math.floor(random()*256).toString(16).padStart(2,'0')).join('');
while(brands.length<25){const pair={primary:randomHex(),secondary:randomHex()};if(deriveBrandScheme(pair).ok)brands.push(pair);}
let scrimChecks=0;
for(const brand of brands){
 const surfaces={light:surfacesOf('light',brand),dark:surfacesOf('dark',brand)};
 const results={};
 for(const [name,measure] of Object.entries(named)){
  const scrims=backdropScrims(measure,brand);results[name]=scrims;
  for(const mode of backdropModes)for(const region of backdropRegions){
   const n=scrims[mode][region],where=`${name} ${mode} ${region} ${brand?brand.primary+'/'+brand.secondary:'no brand'}`;
   assert.ok(Number.isInteger(n)&&n>=0&&n<=100,`${where}: an integer from 0 to 100 (${n})`);
   assert.deepEqual(failures(mode,region,n,measure,surfaces[mode]),[],`${where}: every check passes at ${n}`);
   if(n>0)assert.ok(failures(mode,region,n-1,measure,surfaces[mode]).length>0,`${where}: ${n - 1} fails (minimal)`);
   if(mode==='light')assert.ok(n<=earlierScrim(mode,region,measure,surfaces[mode]),`${where}: not above the earlier rule (ink and muted everywhere)`);
   scrimChecks+=4;
  }
 }
 // A narrower measure never needs a larger scrim.
 for(const name of Object.keys(named))for(const mode of backdropModes)for(const region of backdropRegions){
  assert.ok(results[name][mode][region]<=results.fallback[mode][region],`${name} ${mode} ${region}: not above the fallback`);scrimChecks++;
 }
}
checks+=scrimChecks;
for(let round=0;round<40;round++){
 const box=()=>{const a=randomHex(),b=randomHex(),pa=parse(a),pb=parse(b);const lo={r:Math.min(pa.r,pb.r),g:Math.min(pa.g,pb.g),b:Math.min(pa.b,pb.b)},hi={r:Math.max(pa.r,pb.r),g:Math.max(pa.g,pb.g),b:Math.max(pa.b,pb.b)};return {lo,hi};};
 const shrink=({lo,hi})=>{const mid=c=>Math.round((lo[c]+hi[c])/2);const inner={lo:{},hi:{}};for(const c of ['r','g','b']){inner.lo[c]=Math.round(lo[c]+(mid(c)-lo[c])*random());inner.hi[c]=Math.round(hi[c]-(hi[c]-mid(c))*random());}return inner;};
 const wide={light:box(),dark:box()},narrow={light:shrink(wide.light),dark:shrink(wide.dark)};
 const asMeasure=m=>({light:{low:toHex(m.light.lo),high:toHex(m.light.hi)},dark:{low:toHex(m.dark.lo),high:toHex(m.dark.hi)}});
 const brand=brands[round%brands.length];
 const a=backdropScrims(asMeasure(wide),brand),b=backdropScrims(asMeasure(narrow),brand);
 for(const mode of backdropModes)for(const region of backdropRegions){assert.ok(b[mode][region]<=a[mode][region],`random box ${round} ${mode} ${region}: the narrower measure needs no more`);checks++;}
}
// The exact scrims (bars/navigator/workspace) without a brand scheme. Dark is unchanged by the backdrop tone.
// The light workspace includes the tab band check, but it does not bind for the built-in schemes: every light
// --sd-accent-strong has more than 5:1 on its own --sd-bg, so the texts alone set the workspace scrim (below).
const expected={
 fallback:{light:[32,0,82],dark:[64,5,88]},
 mist:{light:[0,0,0],dark:[59,0,86]},
 dusk:{light:[22,0,79],dark:[0,0,0]},
 tide:{light:[13,0,77],dark:[0,0,47]},
 dune:{light:[0,0,0],dark:[57,0,85]},
 slate:{light:[22,0,79],dark:[0,0,0]},
 bloom:{light:[17,0,78],dark:[0,0,26]},
};
check(Object.keys(expected).filter(name=>name!=='fallback').sort(),brandingBackgrounds.map(background=>background.id).sort(),'every bundled background has its expected scrims');
for(const [name,modes] of Object.entries(expected)){
 const scrims=backdropScrims(named[name],null);
 for(const mode of backdropModes)check(backdropRegions.map(region=>scrims[mode][region]),modes[mode],`${name} ${mode}: the scrims`);
}

// Without a brand scheme, the light workspace scrim is the one the texts alone need (no tab band check), computed
// from the stylesheet tokens: no built-in scheme's tab label raises it.
const builtIn=surfacesOf('light',null);
const textScrim=measure=>{let n=0;while(n<100&&failures('light','workspace',n,measure,builtIn,texts,false).length)n++;return n;};
for(const name of Object.keys(expected))check(backdropScrims(named[name],null).light.workspace,textScrim(named[name]),`${name} light workspace: the texts alone set the scrim`);
for(const surface of builtIn)ok(contrast(surface.accentStrong,surface.bg)>=4.5,`light ${surface.id}: --sd-accent-strong has 4.5:1 on its own --sd-bg`);

console.log(`PASS backdrop (${checks} checks): filter matrices, measurement (solid, stripes, blur order, transparency, reduction), constants = app/globals.css, scrims valid and minimal for ${Object.keys(named).length} measures × ${brands.length} brand states, narrower never needs more.`);
