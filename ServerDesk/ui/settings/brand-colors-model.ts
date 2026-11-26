// The colors of the portal logo for the brand color scheme (Settings › Branding, card Color scheme; docs/branding.md).
// Pure: the page draws the logo on a canvas in the browser (the server decodes no pixels) and hands the RGBA bytes
// here. Up to three distinct candidates, most frequent first; lib/brand-scheme.ts derives and checks the scheme.
import type {BrandSchemeColors} from '@/lib/branding';

/** Pixels below this alpha (of 255) count as transparent and are not counted. */
const minAlpha=128;
/** Gray, near-black and near-white pixels carry no brand color (HSL saturation and lightness). */
const minSaturation=.25,minLightness=.12,maxLightness=.92;
/** 24 hue buckets of 15°; a candidate needs 2 % of the counted opaque pixels and 30° of hue distance from those before it. */
const bucketCount=24,minShare=.02,minHueDistance=30,maxCandidates=3;

type Hsl={h:number;s:number;l:number};
function hsl(r:number,g:number,b:number):Hsl{
 const red=r/255,green=g/255,blue=b/255,max=Math.max(red,green,blue),min=Math.min(red,green,blue),l=(max+min)/2,d=max-min;
 if(d===0)return {h:0,s:0,l};
 const s=d/(1-Math.abs(2*l-1));
 const h=max===red?((green-blue)/d+6)%6:max===green?(blue-red)/d+2:(red-green)/d+4;
 return {h:h*60,s,l};
}
const hex=(value:number)=>Math.round(value).toString(16).padStart(2,'0');
const hueDistance=(a:number,b:number)=>{const d=Math.abs(a-b)%360;return Math.min(d,360-d);};

/**
 * Up to three lowercase #rrggbb candidates from RGBA pixel data, most frequent first. Pixels with alpha below 128,
 * saturation below 0.25 or lightness outside 0.12–0.92 are ignored; the rest fall into 24 hue buckets, each averaged
 * in RGB. An empty list means the logo has no distinct color.
 */
export function logoColors(rgba:Uint8ClampedArray|Uint8Array):string[]{
 const buckets=Array.from({length:bucketCount},()=>({count:0,r:0,g:0,b:0}));
 let opaque=0;
 for(let at=0;at+3<rgba.length;at+=4){
  if(rgba[at+3]<minAlpha)continue;
  opaque++;
  const r=rgba[at],g=rgba[at+1],b=rgba[at+2],{h,s,l}=hsl(r,g,b);
  if(s<minSaturation||l<minLightness||l>maxLightness)continue;
  const bucket=buckets[Math.floor(h/(360/bucketCount))%bucketCount];
  bucket.count++;bucket.r+=r;bucket.g+=g;bucket.b+=b;
 }
 const candidates:{hex:string;hue:number}[]=[];
 for(const bucket of [...buckets].sort((a,b)=>b.count-a.count)){
  if(candidates.length>=maxCandidates||!opaque||bucket.count/opaque<minShare)break;
  const r=bucket.r/bucket.count,g=bucket.g/bucket.count,b=bucket.b/bucket.count,hue=hsl(r,g,b).h;
  if(candidates.some(candidate=>hueDistance(candidate.hue,hue)<minHueDistance))continue;
  candidates.push({hex:`#${hex(r)}${hex(g)}${hex(b)}`,hue});
 }
 return candidates.map(candidate=>candidate.hex);
}

/** The scheme suggestion for a chosen candidate: it leads, the first other candidate is the secondary color (or itself). */
export function brandSuggestion(candidates:readonly string[],chosen:number):BrandSchemeColors|null{
 const primary=candidates[chosen];
 if(!primary)return null;
 return {primary,secondary:candidates.find((_,index)=>index!==chosen)??primary};
}

/** The side lengths that fit an image into a 96 × 96 canvas, keeping its ratio (at least 1 px each). */
export function fitInto(width:number,height:number,box=96):{width:number;height:number}{
 if(!(width>0)||!(height>0))return {width:box,height:box};
 const scale=Math.min(box/width,box/height);
 return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};
}
