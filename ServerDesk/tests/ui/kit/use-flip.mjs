// useFlip (ui/kit/use-flip.ts, nodiverna-ui §8 "motion that explains"): after capture(), the next commit moves each
// item from its old place to its new one (transform only, the slow duration and the ease-out curve of the tokens)
// and fades in an item that was not there; an item that did not move is left alone; a commit without a capture
// does nothing; nothing moves under reduced motion or in a browser without the Web Animations API. Also the pure
// helpers tokenMs and flipOffset.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {panelHarness} from '../../support/panel-harness.mjs';
const {tokenMs,flipOffset}=await import('../../../ui/kit/use-flip.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};

check([tokenMs('260ms',1),tokenMs(' .26s ',1),tokenMs('1.5s',1),tokenMs('',260),tokenMs('fast',260),tokenMs('260',7)],[260,260,1500,260,260,7],'tokenMs reads ms and s, else the fallback');
check([flipOffset({left:10,top:20},{left:10,top:20}),flipOffset({left:10,top:20},{left:110,top:20}),flipOffset({left:0,top:300.4},{left:0,top:0}),flipOffset({left:0.2,top:0},{left:0,top:0})],[null,{x:-100,y:0},{x:0,y:300},null],'flipOffset: from the old box to the new one, null when it did not move');

const motion={reduced:false};
const harness=panelHarness({hooked:['ui/kit/use-flip.ts'],locale:'en',layoutEffects:true,stubs:{'@/ui/base/motion':{reducedMotion:()=>motion.reduced}}});
const {useFlip}=harness.load('ui/kit/use-flip.ts');
const realStyle=globalThis.getComputedStyle;
const tokens={'--sd-dur-slow':'260ms','--sd-ease-out':' cubic-bezier(.22, 1, .36, 1)'};
globalThis.getComputedStyle=()=>({getPropertyValue:name=>tokens[name]??''});

// A fake list: each item has a key, a box and records its animations.
const animations=[];
const item=(key,left,top,animate=true)=>({dataset:{flip:key},box:{left,top},getBoundingClientRect(){return this.box;},...(animate?{animate(frames,options){animations.push([key,frames,options]);}}:{})});
const list=items=>({items,querySelectorAll(selector){assert.equal(selector,'[data-flip]');return this.items;}});
/** Renders the hook on a container; returns [ref, capture] and commits with flush(). */
const mount=box=>{harness.reset();const [ref,capture]=harness.tree(useFlip,undefined);ref.current=box;return {ref,capture,commit:async()=>{const [again]=harness.tree(useFlip,undefined);assert.equal(again,ref,'the ref keeps its identity');await harness.flush();}};};

const a=item('a',0,0),b=item('b',400,0),c=item('c',800,0);
let box=list([a,b,c]),flip=mount(box);
await flip.commit();
check(animations,[],'a commit without a capture does nothing');

// b moves before a; c stays; d is new.
flip.capture();
const d=item('d',0,300);
a.box={left:400,top:0};b.box={left:0,top:0};box.items=[b,a,c,d];
await flip.commit();
const options={duration:260,easing:'cubic-bezier(.22, 1, .36, 1)'};
check(animations,[
 ['b',[{transform:'translate(400px,0px)'},{transform:'none'}],options],
 ['a',[{transform:'translate(-400px,0px)'},{transform:'none'}],options],
 ['d',[{opacity:0},{opacity:1}],options],
],'moved items slide from their old place, a new item fades in, an item that stayed is left alone; duration and curve come from the tokens');
animations.length=0;
await flip.commit();
check(animations,[],'the capture is used once');

// The tokens are missing: the fallbacks.
delete tokens['--sd-dur-slow'];delete tokens['--sd-ease-out'];
flip.capture();a.box={left:0,top:300};await flip.commit();
check(animations,[['a',[{transform:'translate(400px,-300px)'},{transform:'none'}],{duration:260,easing:'ease-out'}]],'without the tokens: 260 ms and ease-out');
animations.length=0;

// Reduced motion: neither the capture nor the commit moves anything.
motion.reduced=true;
flip.capture();a.box={left:0,top:0};await flip.commit();
check(animations,[],'reduced motion: the items change place at once');
motion.reduced=false;
flip.capture();motion.reduced=true;a.box={left:50,top:50};await flip.commit();
check(animations,[],'reduced motion switched on between capture and commit: nothing moves');
motion.reduced=false;
await flip.commit();
check(animations,[],'and the dropped capture does not play later');

// No Web Animations API on an item, and no container.
const plain=item('p',0,0,false);
box=list([plain,item('q',100,0)]);flip=mount(box);
flip.capture();plain.box={left:100,top:0};box.items[1].box={left:0,top:0};await flip.commit();
check(animations.map(([key])=>key),['q'],'an item without animate() is skipped');
animations.length=0;
flip=mount(null);flip.capture();await flip.commit();
check(animations,[],'without a container nothing happens');

if(realStyle)globalThis.getComputedStyle=realStyle;else delete globalThis.getComputedStyle;

// ---- the source ----
const source=readFileSync('ui/kit/use-flip.ts','utf8');
ok(!/@keyframes|transition/.test(source)&&/reducedMotion\(\)/.test(source),'no keyframes of its own; it asks for reduced motion');
ok(!/width|height|margin|padding/.test(source.replace(/\/\/.*$/gm,'')),'transform and opacity only: no layout property is animated');

console.log(`use-flip: ${checks} checks passed`);
