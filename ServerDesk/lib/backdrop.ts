// The console background (docs/branding.md, "Console background"): the image filter of each mode, the measurement of
// the blurred image, and the scrims that keep text readable over it. Pure and shared: the Branding page measures an
// upload in the browser with measureBackdrop, scripts/measure-backgrounds.mjs measures the bundled backgrounds with it,
// and the server computes the scrims of the console view with backdropScrims. The server never decodes pixels.
//
// The console paints the image behind the whole frame (ui/shell/console-backdrop.css). Each region puts a scrim of
// --sd-bg over it (color-mix(in srgb, var(--sd-bg) n%, transparent)) and its material over the scrim: the bars (top
// bar, rail, job dock, bottom bar) the glass or the strong glass, the navigator the strong glass, the workspace
// nothing (text on the canvas) or the strong glass (menus, the palette, the navigator overlay). While the image shows,
// secondary text right on a backdrop surface (bars, navigator, canvas) uses the backdrop tone (--sdx-muted-backdrop:
// in light mode --sd-ink 40 % over --sd-muted, in dark mode --sd-muted); the portaled menus keep --sd-muted.
// backdropScrims finds, for each mode and region, the smallest n at which --sd-ink and the secondary text of each
// material keep 4.5:1 over every pixel of the measured range, in every scheme offered in that mode. The compositing is sRGB alpha "over", as color-mix(in srgb)
// and tests/support/theme-colors.mjs compute it; the token values are constants here, and tests/lib/backdrop.mjs
// compares them with app/globals.css.
import type {BrandSchemeColors} from './branding';
import {brandNeutrals,brandShares,contrastRatio,deriveBrandScheme,isBrandSchemeHex} from './brand-scheme';
import {colorSchemes,type SchemeId,type SchemeMode} from './color-schemes';

export type BackdropMode=SchemeMode;
export const backdropModes:readonly BackdropMode[]=['light','dark'];

/**
 * The image filter of each mode (ui/shell/console-backdrop.css declares the same values): blur(<blur>px)
 * saturate(<saturate>) brightness(<brightness>), applied in this order. The image is scaled by `scale` so the blur
 * keeps no soft edge at the viewport border.
 */
export const backdropFilters={
 light:{blur:48,saturate:1.4,brightness:1},
 dark:{blur:48,saturate:1.2,brightness:.9},
} as const satisfies Record<BackdropMode,{blur:number;saturate:number;brightness:number}>;
export const backdropScale=1.15;

/** The lowest and the highest channel values (lowercase #rrggbb) of the blurred, filtered image of one mode. */
export type BackdropRange={low:string;high:string};
export type BackdropMeasure={light:BackdropRange;dark:BackdropRange};
/** No measurement: any pixel from black to white. */
export const fallbackBackdropMeasure:BackdropMeasure={light:{low:'#000000',high:'#ffffff'},dark:{low:'#000000',high:'#ffffff'}};

export type BackdropRegion='bars'|'navigator'|'workspace';
export const backdropRegions:readonly BackdropRegion[]=['bars','navigator','workspace'];
/** The scrim of each mode and region: an integer percentage of --sd-bg. */
export type BackdropScrims=Record<BackdropMode,Record<BackdropRegion,number>>;

type Rgb={r:number;g:number;b:number};
const backdropHex=/^#[0-9a-f]{6}$/;
const parse=(hex:string):Rgb=>({r:parseInt(hex.slice(1,3),16),g:parseInt(hex.slice(3,5),16),b:parseInt(hex.slice(5,7),16)});
const byte=(value:number)=>Math.min(255,Math.max(0,value)).toString(16).padStart(2,'0');
const channels=['r','g','b'] as const;

/** A valid range: two lowercase #rrggbb values, and no channel of `low` above the same channel of `high`. */
export function isBackdropRange(value:unknown):value is BackdropRange{
 if(!value||typeof value!=='object')return false;
 const {low,high}=value as Record<string,unknown>;
 if(typeof low!=='string'||typeof high!=='string'||!backdropHex.test(low)||!backdropHex.test(high))return false;
 const a=parse(low),b=parse(high);
 return channels.every(channel=>a[channel]<=b[channel]);
}
export const isBackdropMeasure=(value:unknown):value is BackdropMeasure=>!!value&&typeof value==='object'&&isBackdropRange((value as Record<string,unknown>).light)&&isBackdropRange((value as Record<string,unknown>).dark);

// ---- Measurement ----

/** The viewport the blur is measured for: the console at 2560 × 1440 covers the image (object-fit: cover). */
export const backdropReference={width:2560,height:1440} as const;
/** The longest side the measurement works on; a larger image is first averaged down to it. */
export const backdropMeasureSide=320;
/**
 * The share of the reference blur that the measurement applies. It stays below 1, so the measurement never blurs more
 * than the console does: a browser may approximate the Gaussian, and a larger viewport blurs the image less.
 */
export const backdropMeasureBlurShare=.75;

/** The CSS Filter Effects saturate matrix (sRGB), then brightness; each step clamped to 0–255 as the filter chain does. */
export function filterPixel(pixel:Rgb,{saturate,brightness}:{saturate:number;brightness:number}):Rgb{
 const s=saturate,{r,g,b}=pixel,clamp=(value:number)=>Math.min(255,Math.max(0,value));
 const sr=clamp((.213+.787*s)*r+(.715-.715*s)*g+(.072-.072*s)*b);
 const sg=clamp((.213-.213*s)*r+(.715+.285*s)*g+(.072-.072*s)*b);
 const sb=clamp((.213-.213*s)*r+(.715-.715*s)*g+(.072+.928*s)*b);
 return {r:clamp(sr*brightness),g:clamp(sg*brightness),b:clamp(sb*brightness)};
}

/** Averages the image down so its longest side is at most backdropMeasureSide (whole blocks of f × f pixels). */
function reduce(rgb:Float64Array,width:number,height:number):{rgb:Float64Array;width:number;height:number}{
 const factor=Math.ceil(Math.max(width,height)/backdropMeasureSide);
 if(factor<=1)return {rgb,width,height};
 const w=Math.ceil(width/factor),h=Math.ceil(height/factor),out=new Float64Array(w*h*3);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  let r=0,g=0,b=0,n=0;
  for(let yy=y*factor;yy<Math.min(height,(y+1)*factor);yy++)for(let xx=x*factor;xx<Math.min(width,(x+1)*factor);xx++){
   const at=(yy*width+xx)*3;r+=rgb[at];g+=rgb[at+1];b+=rgb[at+2];n++;
  }
  const to=(y*w+x)*3;out[to]=r/n;out[to+1]=g/n;out[to+2]=b/n;
 }
 return {rgb:out,width:w,height:h};
}

/**
 * Blurs with `passes` rounds of the binomial kernel [1 2 1] / 4 in both directions (each round adds a variance of
 * 1/2 per direction; many rounds approach a Gaussian). Every round is a convex average of neighbours with the edge
 * pixels repeated, so a further round can only narrow the range of values: a stronger blur never widens it.
 */
function blur(source:Float64Array,width:number,height:number,passes:number):Float64Array{
 let a=Float64Array.from(source),b=new Float64Array(a.length);
 for(let pass=0;pass<passes;pass++){
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const left=(y*width+Math.max(0,x-1))*3,mid=(y*width+x)*3,right=(y*width+Math.min(width-1,x+1))*3;
   for(let c=0;c<3;c++)b[mid+c]=(a[left+c]+2*a[mid+c]+a[right+c])/4;
  }
  [a,b]=[b,a];
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const up=(Math.max(0,y-1)*width+x)*3,mid=(y*width+x)*3,down=(Math.min(height-1,y+1)*width+x)*3;
   for(let c=0;c<3;c++)b[mid+c]=(a[up+c]+2*a[mid+c]+a[down+c])/4;
  }
  [a,b]=[b,a];
 }
 return a;
}

/** The number of binomial rounds for a Gaussian of `sigma` px: the largest count whose variance (rounds / 2) stays at or below sigma². */
export const blurPasses=(sigma:number)=>Math.max(0,Math.floor(2*sigma*sigma));

/**
 * Measures an image (RGBA bytes, row by row) for both modes: the whole image (also the parts object-fit: cover crops)
 * is blurred, then filtered with the mode's saturate and brightness; `low` is the lowest and `high` the highest value of
 * each channel over all pixels (rounded outwards), so the pair bounds every blurred pixel the console can show.
 * The blur is the console blur at the reference viewport, in pixels of the (reduced) image, times `blurShare` (at most
 * 1). A transparent pixel counts as composited over black and over white, so both extremes enter the range.
 */
export function measureBackdrop(rgba:ArrayLike<number>,width:number,height:number,{blurShare=backdropMeasureBlurShare}:{blurShare?:number}={}):BackdropMeasure{
 if(!(width>0&&height>0)||rgba.length<width*height*4)throw new RangeError('measureBackdrop needs width × height RGBA pixels');
 const share=Math.min(1,Math.max(0,blurShare));
 let translucent=false;
 for(let index=3;index<width*height*4;index+=4)if(rgba[index]<255){translucent=true;break;}
 const grounds=translucent?[0,255]:[0];
 const ranges:Record<BackdropMode,{low:Rgb;high:Rgb}>={light:{low:{r:255,g:255,b:255},high:{r:0,g:0,b:0}},dark:{low:{r:255,g:255,b:255},high:{r:0,g:0,b:0}}};
 for(const ground of grounds){
  const rgb=new Float64Array(width*height*3);
  for(let pixel=0;pixel<width*height;pixel++){
   const alpha=rgba[pixel*4+3]/255;
   for(let c=0;c<3;c++)rgb[pixel*3+c]=rgba[pixel*4+c]*alpha+ground*(1-alpha);
  }
  const reduced=reduce(rgb,width,height);
  // CSS px per image px when the image covers the reference viewport; the console blur in image px is blur / cover.
  const cover=Math.max(backdropReference.width/reduced.width,backdropReference.height/reduced.height);
  const blurred=new Map<number,Float64Array>();
  for(const mode of backdropModes){
   const filter=backdropFilters[mode],passes=blurPasses(filter.blur/cover*share);
   const pixels=blurred.get(passes)??blur(reduced.rgb,reduced.width,reduced.height,passes);
   blurred.set(passes,pixels);
   const range=ranges[mode];
   for(let at=0;at<pixels.length;at+=3){
    const value=filterPixel({r:pixels[at],g:pixels[at+1],b:pixels[at+2]},filter);
    for(const channel of channels){
     range.low[channel]=Math.min(range.low[channel],value[channel]);
     range.high[channel]=Math.max(range.high[channel],value[channel]);
    }
   }
  }
 }
 // Outwards to whole values, with a small tolerance for floating-point noise of the averages.
 const outward=(value:Rgb,round:(n:number)=>number)=>`#${channels.map(channel=>byte(round(value[channel]))).join('')}`;
 const view=(mode:BackdropMode):BackdropRange=>({low:outward(ranges[mode].low,n=>Math.floor(n+1e-9)),high:outward(ranges[mode].high,n=>Math.ceil(n-1e-9))});
 return {light:view('light'),dark:view('dark')};
}

// ---- Scrims ----

/** The panel share of --sd-glass and --sd-glass-strong (app/globals.css). */
export const backdropGlass={light:{glass:68,strong:84},dark:{glass:72,strong:90}} as const;
/** The minimum contrast of ink and secondary text. */
export const backdropMinimumContrast=4.5;

/** color-mix(in srgb, tint share%, base) of two opaque colors, as app/globals.css writes a scheme color. */
const mixRgb=(a:Rgb,share:number,b:Rgb):Rgb=>{const p=share/100,q=1-p;return {r:a.r*p+b.r*q,g:a.g*p+b.g*q,b:a.b*p+b.b*q};};
const mixed=(tint:string,share:number,base:string):Rgb=>mixRgb(parse(tint),share,parse(base));
/**
 * The share of --sd-ink in the light backdrop tone (--sdx-muted-backdrop in ui/shell/console-backdrop.css:
 * color-mix(in srgb, var(--sd-ink) 40%, var(--sd-muted))). About 7.1:1 on the light --sd-bg against 4.6:1 for
 * --sd-muted, so the light scrims can show far more of the image.
 */
export const backdropMutedInkShare=40;
/**
 * The texts that must keep 4.5:1 (brandNeutrals holds the app/globals.css values): ink, muted, and the backdrop tone,
 * the secondary text right on a backdrop surface (light: ink over muted at backdropMutedInkShare; dark: muted).
 */
export const backdropText={
 light:{ink:brandNeutrals.light.ink,muted:brandNeutrals.light.muted,backdrop:mixed(brandNeutrals.light.ink,backdropMutedInkShare,brandNeutrals.light.muted)},
 dark:{ink:brandNeutrals.dark.ink,muted:brandNeutrals.dark.muted,backdrop:parse(brandNeutrals.dark.muted)},
} as const satisfies Record<BackdropMode,{ink:string;muted:string;backdrop:Rgb}>;
/**
 * The --sd-bg share of the sticky underline tab band (.sdx-tabs in ui/styles/console.css: color-mix(in srgb,
 * var(--sd-bg) 82%, transparent)). It lies over the workspace canvas; its active label is --sd-accent-strong.
 */
export const backdropTabBand=82;
/** --sd-bg and --sd-panel of a scheme; in light mode also --sd-accent-strong (the active tab label on the tab band). */
type SchemeSurface={bg:Rgb;panel:Rgb;accentStrong?:Rgb};
const lightPanel=parse(brandNeutrals.light.panel),lightContrast=parse(brandNeutrals.light.contrast);
/** --sd-accent-strong in light mode: the accent at the strong share over --sd-contrast. */
const lightStrong=(accent:Rgb,share:number=brandShares.light.strong)=>mixRgb(accent,share,lightContrast);
const light=(bg:Rgb,accent:Rgb,share?:number):SchemeSurface=>({bg,panel:lightPanel,accentStrong:lightStrong(accent,share)});
const aurora={light:light(parse('#f4f6fa'),parse('#5b5cf6')),dark:{bg:parse('#11151c'),panel:parse('#191e27')}};
const darkTint=(tint:string,share:number):SchemeSurface=>({bg:mixed(tint,share,'#11151c'),panel:mixed(tint,share,'#191e27')});
/**
 * --sd-bg and --sd-panel of every scheme offered in each mode, and the light --sd-accent-strong (app/globals.css).
 * "brand" is Aurora until a brand scheme is stored; backdropScrims then uses the derived values.
 */
export const backdropSchemes:Record<BackdropMode,Partial<Record<SchemeId,SchemeSurface>>>={
 light:{
  brand:aurora.light,
  aurora:aurora.light,
  'cyber-teal':light(mixed('#7fffd4',8,'#f4f6fa'),parse('#0a5b61')),
  inkberry:light(mixed('#ffb7a5',4,'#f4f6fa'),parse('#1a0b2e')),
  'electric-violet':light(mixed('#ffd6a5',6,'#f4f6fa'),parse('#6a00f4')),
  ember:light(mixed('#fffcf4',50,'#f4f6fa'),mixed('#ff6115',97,'#000000'),75),
 },
 dark:{
  brand:aurora.dark,
  aurora:aurora.dark,
  'cyber-teal':darkTint('#0a5b61',15),
  inkberry:darkTint('#1a0b2e',50),
  'electric-violet':darkTint('#6a00f4',10),
  'prompt-blue':darkTint('#0b132b',60),
 },
};

/** The surfaces of each scheme offered in a mode, with the derived brand scheme when one is stored (and passes). */
function schemeSurfaces(mode:BackdropMode,brandScheme:BrandSchemeColors|null):SchemeSurface[]{
 const derived=brandScheme&&isBrandSchemeHex(brandScheme.primary)&&isBrandSchemeHex(brandScheme.secondary)?deriveBrandScheme(brandScheme):null;
 return colorSchemes.filter(scheme=>(scheme.modes as readonly BackdropMode[]).includes(mode)).map(scheme=>{
  if(scheme.id==='brand'&&derived?.ok){
   const values=derived[mode].values;
   if(mode==='light')return light(parse(values.bg),parse(values.accent));
   return {bg:parse(values.bg),panel:values.panel?parse(values.panel):parse(brandNeutrals.dark.panel)};
  }
  const surface=backdropSchemes[mode][scheme.id];
  if(!surface)throw new Error(`No backdrop surface for ${scheme.id} in ${mode} mode`);
  return surface;
 });
}

/** a over b (a with alpha `alpha`, b opaque). */
const over=(a:Rgb,alpha:number,b:Rgb):Rgb=>({r:a.r*alpha+b.r*(1-alpha),g:a.g*alpha+b.g*(1-alpha),b:a.b*alpha+b.b*(1-alpha)});
const channelLight=(value:number)=>{const c=value/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;};
const luminance=({r,g,b}:Rgb)=>.2126*channelLight(r)+.7152*channelLight(g)+.0722*channelLight(b);

/** The materials of each region: the panel share of the glass on the scrim, or null for text right on the scrim. */
export const backdropMaterials:Record<BackdropMode,Record<BackdropRegion,readonly (number|null)[]>>={
 light:{bars:[backdropGlass.light.glass,backdropGlass.light.strong],navigator:[backdropGlass.light.strong],workspace:[null,backdropGlass.light.strong]},
 dark:{bars:[backdropGlass.dark.glass,backdropGlass.dark.strong],navigator:[backdropGlass.dark.strong],workspace:[null,backdropGlass.dark.strong]},
};

/**
 * The secondary text checked on a material of a region: the backdrop tone on the bars, the navigator and the canvas
 * (null), and --sd-muted on the workspace's strong glass (menus, the palette, the select picker: portaled outside the
 * console frame, so they keep --sd-muted).
 */
export const backdropSecondaryText=(region:BackdropRegion,material:number|null):'backdrop'|'muted'=>region==='workspace'&&material!==null?'muted':'backdrop';

/** The surface a text sits on: the material over the scrim (--sd-bg at n %) over one pixel. */
export function backdropSurface(surface:SchemeSurface,material:number|null,scrim:number,pixel:Rgb):Rgb{
 const scrimmed=over(surface.bg,scrim/100,pixel);
 return material===null?scrimmed:over(surface.panel,material/100,scrimmed);
}

/** Whether a text keeps `minimum` over both ends, and both ends lie on the same side of it. */
function holds(text:Rgb,dark:Rgb,bright:Rgb,minimum:number=backdropMinimumContrast):boolean{
 if(contrastRatio(text,dark)<minimum||contrastRatio(text,bright)<minimum)return false;
 const level=luminance(text);
 return luminance(dark)<level===luminance(bright)<level;
}

/**
 * Whether ink and the secondary text of each material (backdropSecondaryText) keep the minimum contrast over the low
 * and the high pixel. A surface's luminance grows with every pixel channel, so every pixel of the range gives a
 * surface between the two; both ends must also lie on the same side of the text, so every surface between them passes
 * too. In light mode the workspace also carries the tab band (--sd-bg at backdropTabBand % over the canvas) with its
 * active label --sd-accent-strong; that label needs 4.5:1, or, for a brand scheme whose label misses 4.5:1 on its own
 * --sd-bg already, the ratio it has there.
 */
function passes(mode:BackdropMode,region:BackdropRegion,surfaces:SchemeSurface[],scrim:number,low:Rgb,high:Rgb):boolean{
 const ink=parse(backdropText[mode].ink),secondary={backdrop:backdropText[mode].backdrop,muted:parse(backdropText[mode].muted)};
 for(const surface of surfaces){
  for(const material of backdropMaterials[mode][region]){
   const dark=backdropSurface(surface,material,scrim,low),bright=backdropSurface(surface,material,scrim,high);
   if(!holds(ink,dark,bright)||!holds(secondary[backdropSecondaryText(region,material)],dark,bright))return false;
  }
  if(mode==='light'&&region==='workspace'&&surface.accentStrong){
   const band=(pixel:Rgb)=>over(surface.bg,backdropTabBand/100,backdropSurface(surface,null,scrim,pixel));
   const minimum=Math.min(backdropMinimumContrast,contrastRatio(surface.accentStrong,surface.bg));
   if(!holds(surface.accentStrong,band(low),band(high),minimum))return false;
  }
 }
 return true;
}

/**
 * The scrims of a measurement: for each mode and region the smallest whole n from 0 to 100 at which ink and the
 * secondary text of each material (backdropSecondaryText) keep 4.5:1 on every material of the region over --sd-bg at n % over the low and the high pixel, in every scheme
 * offered in the mode (brand from `brandScheme` when one is stored, else Aurora). 100 if none passes.
 */
export function backdropScrims(measure:BackdropMeasure,brandScheme:BrandSchemeColors|null):BackdropScrims{
 const result={} as BackdropScrims;
 for(const mode of backdropModes){
  const surfaces=schemeSurfaces(mode,brandScheme),low=parse(measure[mode].low),high=parse(measure[mode].high);
  const regions={} as Record<BackdropRegion,number>;
  for(const region of backdropRegions){
   let scrim=0;
   while(scrim<100&&!passes(mode,region,surfaces,scrim,low,high))scrim++;
   regions[region]=scrim;
  }
  result[mode]=regions;
 }
 return result;
}

/** The custom properties the console and the Branding preview set (ui/shell/console-backdrop.css reads them). */
export function backdropScrimProperties(scrims:BackdropScrims):Record<string,string>{
 const out:Record<string,string>={};
 for(const region of backdropRegions)for(const mode of backdropModes)out[`--sdx-scrim-${region}-${mode}`]=`${scrims[mode][region]}%`;
 return out;
}
