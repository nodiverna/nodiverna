// The logo colors of the card Color scheme (ui/settings/brand-colors-model.ts) with synthetic RGBA arrays: one blue
// logo on transparent gives one candidate, blue, orange and green areas give three in frequency order, two blues 10°
// apart give one, black, white and gray give none, a 1 % accent gives none, semi-transparent pixels are ignored; the
// suggestion takes the first other candidate as the secondary color; the canvas size fits 96 × 96.
import assert from 'node:assert/strict';

const {logoColors,brandSuggestion,fitInto}=await import('../../../ui/settings/brand-colors-model.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

/** RGBA bytes of runs of pixels: [[r,g,b,a,count], …]. */
function pixels(runs){
 const out=[];
 for(const [r,g,b,a,count] of runs)for(let i=0;i<count;i++)out.push(r,g,b,a);
 return new Uint8ClampedArray(out);
}

check(logoColors(pixels([[0,0,0,0,900],[30,90,220,255,100]])),['#1e5adc'],'one blue logo on transparent: one candidate');
check(logoColors(pixels([[30,90,220,255,500],[240,120,20,255,300],[40,170,70,255,200]])),['#1e5adc','#f07814','#28aa46'],'blue, orange and green: three, most frequent first');
check(logoColors(pixels([[240,120,20,255,300],[30,90,220,255,500],[40,170,70,255,600]])),['#28aa46','#1e5adc','#f07814'],'the order follows the pixel count, not the position');
{
 // Two blues 10° apart (in different 15° buckets): only the more frequent one.
 const result=logoColors(pixels([[30,90,220,255,600],[50,60,220,255,400]]));
 check(result.length,1,'two blues 10° apart: one candidate');
 check(result[0],'#1e5adc','the more frequent blue');
}
check(logoColors(pixels([[0,0,0,255,300],[255,255,255,255,300],[128,128,128,255,300],[20,20,22,255,100]])),[],'black, white and gray only: no distinct color');
check(logoColors(pixels([[0,0,0,255,990],[220,30,30,255,10]])),[],'a 1 % accent gives no candidate');
check(logoColors(pixels([[0,0,0,255,970],[220,30,30,255,30]])),['#dc1e1e'],'a 3 % accent gives one');
check(logoColors(pixels([[30,90,220,127,1000],[0,0,0,255,100]])),[],'semi-transparent pixels are ignored');
check(logoColors(pixels([[30,90,220,128,100]])),['#1e5adc'],'alpha 128 counts');
check(logoColors(pixels([[240,250,255,255,100]])),[],'lightness above 0.92 is ignored');
check(logoColors(new Uint8ClampedArray(0)),[],'no pixels: no candidate');
check(logoColors(pixels([[30,90,220,255,40],[240,120,20,255,30],[40,170,70,255,20],[200,40,160,255,10]])).length,3,'at most three candidates');

check(brandSuggestion(['#1e5adc','#f07814'],0),{primary:'#1e5adc',secondary:'#f07814'},'the chosen leads, the first other is the secondary');
check(brandSuggestion(['#1e5adc','#f07814','#28aa46'],2),{primary:'#28aa46',secondary:'#1e5adc'},'the first other candidate');
check(brandSuggestion(['#1e5adc'],0),{primary:'#1e5adc',secondary:'#1e5adc'},'one candidate: both colors');
check(brandSuggestion([],0),null,'no candidate: no suggestion');

check(fitInto(400,100),{width:96,height:24},'a wide logo fits 96 × 96');
check(fitInto(16,32),{width:48,height:96},'a small tall logo scales up');
check(fitInto(0,0),{width:96,height:96},'an SVG without a size draws at 96 × 96');

console.log(`PASS brand colors model (${checks} checks): candidates, order, hue distance, gray and transparency, the 2 % share, the suggestion and the canvas size.`);
