// The brand color scheme (lib/brand-scheme.ts, docs/branding.md): for about 40 seeds, the extremes and every color
// pair of the fixed schemes, deriveBrandScheme passes, and the values, put into the brand blocks of app/globals.css and
// resolved with the same color-mix(in srgb) math, meet every contrast pair of tests/ui/styles/theme-tokens.mjs and
// on-accent on both gradient ends in both modes, within the 60 % adjustment limit. The roles of the fixed schemes
// hold, the neutral constants equal globals.css, and brandSchemeCss writes only --brand-* declarations with #rrggbb.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {rootTokens,resolveTokens,resolveColor,contrast,toHex} from '../support/theme-colors.mjs';

const {deriveBrandScheme,brandSchemeCss,brandNeutrals,brandShares,brandLimits,isBrandSchemeHex}=await import('../../lib/brand-scheme.ts');
const globals=readFileSync('app/globals.css','utf8');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const color=(text,mode='light')=>resolveColor(text,new Map(),mode);
const close=(a,b)=>['r','g','b'].every(key=>Math.abs(a[key]-b[key])<=.6);

// The pairs of tests/ui/styles/theme-tokens.mjs (kept in step: the test reads them from there).
const tokensTest=readFileSync('tests/ui/styles/theme-tokens.mjs','utf8');
const pairs=Function(`return ${/const pairs=(\[[\s\S]*?\n\]);/.exec(tokensTest)[1]}`)();
ok(pairs.length>=16,'the contrast pairs come from theme-tokens.mjs');

// ---- Neutral constants equal app/globals.css ----
{
 const light=resolveTokens(globals,'light'),dark=resolveTokens(globals,'dark'),raw=rootTokens(globals);
 for(const [mode,tokens] of [['light',light],['dark',dark]]){
  const n=brandNeutrals[mode];
  for(const [name,token] of [['ink','--sd-ink'],['muted','--sd-muted'],['contrast','--sd-contrast'],['success','--sd-success'],['successBg','--sd-success-bg'],['warn','--sd-warn'],['warnBg','--sd-warn-bg'],['danger','--sd-danger'],['dangerBg','--sd-danger-bg']])
   ok(close(color(n[name]),tokens.get(token)),`${mode} ${name} equals ${token} (${toHex(tokens.get(token))})`);
  ok(close(color(n.base),color(raw.get(`--scheme-${mode}-bg`))),`${mode} base equals the Aurora bg`);
  ok(close(color(n.panel),tokens.get('--sd-panel')),`${mode} panel equals the Aurora panel`);
  ok(raw.get(`--scheme-${mode}-strong`)===`${brandShares[mode].strong}%`&&raw.get(`--scheme-${mode}-soft`)===`${brandShares[mode].soft}%`,`${mode} strong and soft shares equal globals.css`);
 }
 ok(brandNeutrals.light.onDark==='#11151c','the dark on-accent is #11151c');
}

// ---- Seeds ----
const fixed=[['#0a5b61','#7fffd4'],['#1a0b2e','#ffb7a5'],['#6a00f4','#ffd6a5'],['#ff6115','#fffcf4'],['#0b132b','#39ff88'],['#5b5cf6','#1fb6ff']];
const singles=['#ffff00','#00ff00','#00ffff','#0000ff','#ff0000','#ff00ff','#808080','#000000','#ffffff','#fffcf4','#0b132b','#5b5cf6','#7c4dff','#1fb6ff','#e85d04','#2a9d8f','#264653','#e9c46a','#f4a261','#8338ec','#3a86ff','#fb5607','#ff006e','#06d6a0'];
const seeds=[...fixed,...fixed.map(([a,b])=>[b,a]),...singles.map(value=>[value,value]),...singles.slice(0,10).map((value,index)=>[value,singles[(index+5)%singles.length]])];
ok(seeds.length>=40,`${seeds.length} seeds`);

/** The tokens of globals.css with the brand stylesheet of a result, for one mode. */
function brandTokens(result,mode){
 const css=globals+'\n'+brandSchemeCss(result).replace(':root{',':root {\n').replace(/;/g,';\n');
 return resolveTokens(css,mode,{light:'brand',dark:'brand'});
}
const shareOf=(actual,first,second,limit)=>{for(let step=0;step<=limit;step++)if(close(actual,color(`color-mix(in srgb, ${first} ${100-step}%, ${second})`)))return step;return null;};
for(const [primary,secondary] of seeds){
 const result=deriveBrandScheme({primary,secondary});
 ok(result.ok,`${primary}/${secondary} derives a scheme`);
 for(const mode of ['light','dark']){
  const tokens=brandTokens(result,mode),label=`${primary}/${secondary} ${mode}`,part=result[mode];
  for(const [fore,back,minimum] of pairs){const ratio=contrast(tokens.get(fore),tokens.get(back));ok(ratio>=minimum,`${label}: ${fore} on ${back} is ${ratio.toFixed(2)}:1`);}
  for(const back of ['--sd-accent-from','--sd-accent-to'])ok(contrast(tokens.get('--sd-on-accent'),tokens.get(back))>=4.5,`${label}: on-accent on ${back}`);
  ok(part.leadShift>=0&&part.leadShift<=brandLimits.leadShift,`${label}: the lead shift ${part.leadShift} % stays within 60 %`);
  // Roles: the lead color (primary light, secondary dark) mixed with black or white, the gradient from it.
  const lead=mode==='light'?primary:secondary,tint=mode==='light'?secondary:primary;
  ok(shareOf(tokens.get('--sd-accent'),lead,mode==='light'?'#000':'#fff',60)!==null,`${label}: the accent is the lead color mixed with ${mode==='light'?'black':'white'}`);
  ok(close(tokens.get('--sd-accent-from'),tokens.get('--sd-accent')),`${label}: the gradient starts at the accent`);
  ok(toHex(tokens.get('--sd-glow'))===toHex(color(secondary)),`${label}: the glow is the secondary color`);
  ok(part.values.surface===tint,`${label}: the swatch surface is the tint color`);
  ok(shareOf(tokens.get('--sd-accent-to'),toHex(tokens.get('--sd-accent')),tint,100)!==null,`${label}: the gradient ends in a mix of the accent and the tint`);
  const onAccent=toHex(tokens.get('--sd-on-accent'));
  ok(onAccent==='#ffffff'?contrast(color('#fff'),tokens.get('--sd-accent'))>=4.5:onAccent==='#11151c'&&contrast(color('#fff'),tokens.get('--sd-accent'))<4.5,`${label}: on-accent is white when that reaches 4.5:1, else #11151c`);
  if(mode==='light'){
   ok(toHex(tokens.get('--sd-panel'))==='#ffffff','light: the panel stays white');
   ok(part.tintShare<=brandLimits.tint.light&&shareOf(tokens.get('--sd-bg'),'#f4f6fa',tint,brandLimits.tint.light)!==null,`${label}: the background is a tint of the secondary color`);
  }else{
   ok(part.tintShare<=brandLimits.tint.dark&&shareOf(tokens.get('--sd-bg'),'#11151c',tint,brandLimits.tint.dark)!==null,`${label}: the background is a tint of the primary color`);
   ok(shareOf(tokens.get('--sd-panel'),'#191e27',tint,brandLimits.tint.dark)!==null,`${label}: the panel is a tint of the primary color`);
  }
  ok(part.endShare<=brandLimits.end,`${label}: the gradient end share stays within 37 %`);
  for(const key of ['button','link','icon'])ok(Number.isFinite(part.contrast[key])&&part.contrast[key]>=(key==='icon'?3:4.5),`${label}: the ${key} ratio is reported`);
 }
}
// A color that needs no change keeps it: Aurora's accent in light mode.
{
 const result=deriveBrandScheme({primary:'#5b5cf6',secondary:'#1fb6ff'});
 ok(result.light.leadShift===0&&result.light.values.accent==='#5b5cf6','the Aurora accent needs no adjustment in light mode');
 ok(result.dark.values.accent!=='#1fb6ff'||result.dark.leadShift===0,'the dark lead is the secondary color');
}
// Bright yellow cannot be an accent on white without an adjustment.
ok(deriveBrandScheme({primary:'#ffff00',secondary:'#ffff00'}).light.leadShift>0,'yellow is darkened in light mode');
ok(deriveBrandScheme({primary:'#000000',secondary:'#000000'}).dark.leadShift>0,'black is lightened in dark mode');
// Invalid input never derives.
for(const value of ['red','#fff','#GGGGGG','#000000;}x{','#FF0000',null,42])ok(!deriveBrandScheme({primary:value,secondary:'#000000'}).ok&&!deriveBrandScheme({primary:'#000000',secondary:value}).ok,`${String(value)} is refused`);
ok(isBrandSchemeHex('#00ff00')&&!isBrandSchemeHex('#00FF00'),'lowercase #rrggbb only');

// ---- brandSchemeCss ----
{
 const result=deriveBrandScheme({primary:'#e85d04',secondary:'#264653'}),css=brandSchemeCss(result);
 ok(/^:root\{[^{}]*\}\n$/.test(css),'one :root rule');
 const declarations=css.slice(':root{'.length,-2).split(';');
 ok(declarations.length===15,'seven light and eight dark variables');
 for(const declaration of declarations)ok(/^--brand-(?:light|dark)-[a-z-]+:#[0-9a-f]{6}$/.test(declaration),`${declaration} is a --brand-* declaration with #rrggbb`);
 ok(declarations.includes('--brand-dark-panel:'+result.dark.values.panel)&&!css.includes('--brand-light-panel'),'only dark has a panel');
 for(const bad of ['red','#fff','#GGGGGG','#000000;}x{']){assert.throws(()=>brandSchemeCss({...result,light:{...result.light,values:{...result.light.values,accent:bad}}}),TypeError,`${bad} is refused`);checks++;}
 assert.throws(()=>brandSchemeCss({...result,dark:{...result.dark,values:{...result.dark.values,panel:undefined}}}),TypeError,'a missing dark panel is refused');checks++;
}

console.log(`PASS brand scheme (${checks} checks): ${seeds.length} seeds pass every pair in both modes within the limits, roles, neutral constants, stylesheet text.`);
