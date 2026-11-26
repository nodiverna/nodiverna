// The brand color scheme (docs/branding.md, "Color scheme"): two colors from the portal logo become the values of the
// scheme variables of the scheme "brand" (app/globals.css reads them as var(--brand-<mode>-<name>, <Aurora value>)).
// Pure and shared: the server re-derives and re-checks the two submitted colors with it and writes the stylesheet of
// GET /api/branding/scheme, and the Branding page previews the same result before Apply.
//
// The roles follow the fixed schemes of app/globals.css. Light: the primary color leads (accent, gradient start), the
// secondary color tints the background and the glow and ends the gradient; the panel stays white. Dark: the secondary
// color leads, the primary color tints the background and the panel. The strong and soft shares stay fixed
// (80 %/9 % light, 55 %/20 % dark, the :root defaults).
//
// The contrast check computes the tokens with the color-mix(in srgb) math of app/globals.css (and of
// tests/support/theme-colors.mjs) and checks every pair of tests/ui/styles/theme-tokens.mjs, plus --sd-on-accent on
// both gradient ends. To pass, the lead color is mixed with black (light) or white (dark) in 1 % steps up to 60 %, and
// the tint shares of the background (and dark panel) and of the gradient end shrink in 1 % steps down to 0.

export type BrandSchemeMode='light'|'dark';
export type BrandSchemeInput={primary:string;secondary:string};
/** The scheme variables that vary, without the --scheme-<mode>- prefix; panel only in dark mode. */
export type BrandSchemeValues={surface:string;bg:string;glow:string;accent:string;'on-accent':string;from:string;to:string;panel?:string};
/** The lowest ratio of each sample group: buttons (on-accent on the accent and on both gradient ends), links (accent-strong on the panel and on accent-soft), icons (accent on the panel). */
export type BrandSchemeContrast={button:number;link:number;icon:number};
export type BrandSchemeModeResult={
 values:BrandSchemeValues;
 contrast:BrandSchemeContrast;
 /** The share (0–60) of black (light) or white (dark) mixed into the lead color. */
 leadShift:number;
 /** The tint share (%) of the background (and the dark panel), and of the gradient end. */
 tintShare:number;
 endShare:number;
};
export type BrandSchemeResult={ok:true;light:BrandSchemeModeResult;dark:BrandSchemeModeResult}|{ok:false};

export const brandSchemeHex=/^#[0-9a-f]{6}$/;
export const isBrandSchemeHex=(value:unknown):value is string=>typeof value==='string'&&brandSchemeHex.test(value);

/** The neutral token values of app/globals.css that the check needs (tests/lib/brand-scheme.mjs compares them). */
export const brandNeutrals={
 light:{
  base:'#f4f6fa',panel:'#ffffff',ink:'#1d2939',muted:'#667085',contrast:'#0b1220',onDark:'#11151c',
  success:'#127e5b',successBg:'#e8f6ef',warn:'#8b611d',warnBg:'#fff7e8',danger:'#b42318',dangerBg:'#fef3f2',
 },
 dark:{
  base:'#11151c',panel:'#191e27',ink:'#e6e9ef',muted:'#9aa3b2',contrast:'#f5f7fb',onDark:'#11151c',
  success:'#4ccf96',successBg:'#15291f',warn:'#e7b553',warnBg:'#2e2412',danger:'#ff7a6e',dangerBg:'#33191a',
 },
} as const;
/** The fixed strong and soft shares of each mode (the :root defaults). */
export const brandShares={light:{strong:80,soft:9},dark:{strong:55,soft:20}} as const;
/** Start values and limits of the adjustment. */
export const brandLimits={leadShift:60,tint:{light:6,dark:10},end:37} as const;

type Rgb={r:number;g:number;b:number};
const parse=(hex:string):Rgb=>({r:parseInt(hex.slice(1,3),16),g:parseInt(hex.slice(3,5),16),b:parseInt(hex.slice(5,7),16)});
const byte=(value:number)=>Math.min(255,Math.max(0,Math.round(value))).toString(16).padStart(2,'0');
const hex=({r,g,b}:Rgb)=>`#${byte(r)}${byte(g)}${byte(b)}`;
/** color-mix(in srgb, a share%, b) of two opaque colors. */
const mix=(a:Rgb,b:Rgb,share:number):Rgb=>({r:a.r*share/100+b.r*(1-share/100),g:a.g*share/100+b.g*(1-share/100),b:a.b*share/100+b.b*(1-share/100)});
const channel=(value:number)=>{const c=value/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;};
const luminance=({r,g,b}:Rgb)=>.2126*channel(r)+.7152*channel(g)+.0722*channel(b);
/** WCAG 2 contrast ratio of two opaque colors. */
export function contrastRatio(a:string|Rgb,b:string|Rgb):number{
 const [x,y]=[luminance(typeof a==='string'?parse(a):a),luminance(typeof b==='string'?parse(b):b)].sort((p,q)=>q-p);
 return (x+.05)/(y+.05);
}

const black:Rgb={r:0,g:0,b:0},white:Rgb={r:255,g:255,b:255};

/** One mode: the first combination (least lead shift, then the largest tint shares) that passes every pair, or null. */
function deriveMode(mode:BrandSchemeMode,lead:Rgb,tint:Rgb,secondary:string,surface:string):BrandSchemeModeResult|null{
 const n=brandNeutrals[mode],share=brandShares[mode],toward=mode==='light'?black:white;
 const base=parse(n.base),panelBase=parse(n.panel),contrastColor=parse(n.contrast);
 const fixedPairs=(panel:Rgb):[string|Rgb,string|Rgb,number][]=>[[n.success,n.successBg,4.5],[n.success,panel,4.5],[n.warn,n.warnBg,4.5],[n.warn,panel,4.5],[n.danger,n.dangerBg,4.5],[n.danger,panel,4.5]];
 for(let shift=0;shift<=brandLimits.leadShift;shift++){
  // Rounded as the stylesheet writes it; the tokens mix the written values.
  const accentHex=hex(mix(lead,toward,100-shift)),accent=parse(accentHex);
  const onAccentHex=contrastRatio(white,accent)>=4.5?'#ffffff':n.onDark,onAccent=parse(onAccentHex);
  const strong=mix(accent,contrastColor,share.strong);
  for(let tintShare=brandLimits.tint[mode];tintShare>=0;tintShare--){
   const bgHex=hex(mix(tint,base,tintShare)),bg=parse(bgHex);
   const panelHex=mode==='light'?n.panel:hex(mix(tint,panelBase,tintShare)),panel=parse(panelHex);
   const soft=mix(accent,panel,share.soft);
   const pairs:[string|Rgb,string|Rgb,number][]=[
    [n.ink,bg,4.5],[n.ink,panel,4.5],[n.ink,soft,4.5],[n.muted,bg,4.5],[n.muted,panel,4.5],
    [strong,panel,4.5],[strong,soft,4.5],[onAccent,accent,4.5],[accent,bg,3],[accent,panel,3],
    ...fixedPairs(panel),
   ];
   if(!pairs.every(([fore,back,minimum])=>contrastRatio(fore,back)>=minimum))continue;
   for(let endShare=brandLimits.end;endShare>=0;endShare--){
    const toHex=hex(mix(accent,tint,100-endShare));
    if(contrastRatio(onAccent,parse(toHex))<4.5)continue;
    const values:BrandSchemeValues={surface,bg:bgHex,glow:secondary,accent:accentHex,'on-accent':onAccentHex,from:accentHex,to:toHex,...(mode==='dark'?{panel:panelHex}:{})};
    const contrast:BrandSchemeContrast={
     button:Math.min(contrastRatio(onAccent,accent),contrastRatio(onAccent,parse(toHex))),
     link:Math.min(contrastRatio(strong,panel),contrastRatio(strong,soft)),
     icon:contrastRatio(accent,panel),
    };
    return {values,contrast,leadShift:shift,tintShare,endShare};
   }
  }
 }
 return null;
}

/**
 * Derives the brand scheme of two lowercase #rrggbb colors. {ok:false} when a color does not match the pattern or no
 * combination within the limits passes (tests/lib/brand-scheme.mjs shows that a valid color always passes).
 */
export function deriveBrandScheme({primary,secondary}:BrandSchemeInput):BrandSchemeResult{
 if(!isBrandSchemeHex(primary)||!isBrandSchemeHex(secondary))return {ok:false};
 const p=parse(primary),s=parse(secondary);
 const light=deriveMode('light',p,s,secondary,secondary),dark=deriveMode('dark',s,p,secondary,primary);
 return light&&dark?{ok:true,light,dark}:{ok:false};
}

/** The order of the variables in the stylesheet. */
export const brandSchemeNames=['surface','bg','glow','accent','on-accent','from','to','panel'] as const;

/**
 * The brand stylesheet: only --brand-<mode>-<name> declarations with #rrggbb values on :root. Throws when a value
 * does not match the pattern, so no other text reaches the CSS.
 */
export function brandSchemeCss(result:Extract<BrandSchemeResult,{ok:true}>):string{
 const declarations:string[]=[];
 for(const mode of ['light','dark'] as const){
  const values=result[mode].values as Record<string,string|undefined>;
  for(const name of brandSchemeNames){
   const value=values[name];
   if(value===undefined&&name==='panel'&&mode==='light')continue;
   if(!isBrandSchemeHex(value))throw new TypeError(`--brand-${mode}-${name} is not #rrggbb`);
   declarations.push(`--brand-${mode}-${name}:${value}`);
  }
 }
 return `:root{${declarations.join(';')}}\n`;
}
