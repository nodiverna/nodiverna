// The bundled backgrounds (public/backgrounds/<id>.svg, docs/branding.md): exactly the six files of
// brandingBackgrounds in lib/branding.ts, each at most 16 KiB, with viewBox 0 0 1920 1080 and xMidYMid slice, made
// only of gradients and simple shapes (no text, image, style, filter, script or href), and unchanged in meaning by
// cleanSvg (it keeps every element). Each entry has a valid measure (lib/backdrop.ts) whose values lie inside the
// per-channel envelope of the file's stop and fill colors after the filter of each mode.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync,statSync} from 'node:fs';

const {brandingBackgrounds,bundledBackgroundUrl}=await import('../../lib/branding.ts');
const {cleanSvg}=await import('../../lib/server/branding-image.ts');
const {backdropFilters,filterPixel,isBackdropRange}=await import('../../lib/backdrop.ts');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};

const ids=brandingBackgrounds.map(background=>background.id);
assert.deepEqual(ids,['mist','dusk','tide','dune','slate','bloom'],'the six bundled ids');checks++;
assert.deepEqual(readdirSync('public/backgrounds').sort(),ids.map(id=>`${id}.svg`).sort(),'one file per bundled background, no other file');checks++;
const elements=text=>[...text.matchAll(/<([A-Za-z][\w:-]*)[\s/>]/g)].map(match=>match[1]);
const allowed=new Set(['svg','defs','linearGradient','radialGradient','stop','rect','circle','ellipse','path','polygon','g']);
for(const {id,label} of brandingBackgrounds){
 const file=`public/backgrounds/${id}.svg`,text=readFileSync(file,'utf8');
 ok(label===`branding.background.${id}`,`${id}: its label key`);
 ok(bundledBackgroundUrl(id)===`/backgrounds/${id}.svg`,`${id}: its URL`);
 ok(statSync(file).size<=16*1024,`${id}: at most 16 KiB`);
 ok(/<svg [^>]*viewBox="0 0 1920 1080"/.test(text)&&/<svg [^>]*preserveAspectRatio="xMidYMid slice"/.test(text),`${id}: viewBox and aspect rule`);
 for(const name of ['text','image','style','filter','script','foreignObject','use'])ok(!new RegExp(`<${name}[\\s/>]`,'i').test(text),`${id}: no <${name}>`);
 ok(!/href|url\((?!#)|data:|@import|on\w+=/i.test(text),`${id}: no href, external reference or handler`);
 ok(elements(text).every(name=>allowed.has(name)),`${id}: only gradients and simple shapes (${[...new Set(elements(text))].join(', ')})`);
 ok(/<(?:linear|radial)Gradient/.test(text),`${id}: abstract gradients`);
 const cleaned=cleanSvg(text);
 assert.deepEqual(elements(cleaned.svg),elements(text),`${id}: cleanSvg keeps every element in order`);checks++;
 ok(cleaned.width===1920&&cleaned.height===1080,`${id}: 1920 × 1080`);
}
// The measures: valid, low ≤ high per channel, and inside the envelope of the filtered stop and fill colors (every
// rendered pixel mixes these colors, the blur mixes pixels, and the filter is linear before its clamp).
const rgb=hex=>({r:parseInt(hex.slice(1,3),16),g:parseInt(hex.slice(3,5),16),b:parseInt(hex.slice(5,7),16)});
for(const {id,measure} of brandingBackgrounds){
 const colors=[...readFileSync(`public/backgrounds/${id}.svg`,'utf8').matchAll(/(?:stop-color|fill)="(#[0-9a-f]{6})"/g)].map(match=>rgb(match[1]));
 ok(colors.length>0,`${id}: stop colors`);
 for(const mode of ['light','dark']){
  ok(isBackdropRange(measure[mode]),`${id} ${mode}: lowercase #rrggbb with low ≤ high`);
  const filtered=colors.map(color=>filterPixel(color,backdropFilters[mode]));
  const low=rgb(measure[mode].low),high=rgb(measure[mode].high);
  for(const channel of ['r','g','b']){
   const values=filtered.map(color=>color[channel]);
   ok(low[channel]>=Math.floor(Math.min(...values))&&high[channel]<=Math.ceil(Math.max(...values)),`${id} ${mode} ${channel}: ${low[channel]}–${high[channel]} inside ${Math.min(...values).toFixed(1)}–${Math.max(...values).toFixed(1)}`);
  }
 }
}
// Four mid-to-dark and two light backgrounds: the first stop of the base gradient tells.
const lightness=hex=>{const [r,g,b]=[1,3,5].map(at=>parseInt(hex.slice(at,at+2),16)/255);return (Math.max(r,g,b)+Math.min(r,g,b))/2;};
const base=id=>lightness(/<stop offset="0" stop-color="(#[0-9a-f]{6})"/.exec(readFileSync(`public/backgrounds/${id}.svg`,'utf8'))[1]);
assert.deepEqual(ids.filter(id=>base(id)>.6).sort(),['dune','mist'],'two light backgrounds');checks++;
assert.deepEqual(ids.filter(id=>base(id)<.4).sort(),['bloom','dusk','slate','tide'],'four mid-to-dark backgrounds');checks++;

console.log(`PASS bundled backgrounds (${checks} checks): six files, size, viewBox and aspect rule, gradients and shapes only, unchanged by cleanSvg, measures inside the color envelope.`);
