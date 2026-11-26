// CountUp (ui/kit/count-up.tsx, nodiverna-ui §8): the markup always holds the final value, visible and for screen
// readers, in the console language; countFrames counts with whole numbers from the start to the target over 240 ms
// and stops when cancelled; the component counts from 0 on the first show of its entrance id and from the previous
// value on a change, writes only the text node, counts once per page load for an entrance id, and shows the value
// at once under reduced motion or without requestAnimationFrame (ui/base/motion.ts).
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {panelHarness} from '../../support/panel-harness.mjs';
const h=React.createElement;
const {CountUp,countFrames,countDuration}=await import('../../../ui/kit/count-up.tsx');
const {reducedMotion}=await import('../../../ui/base/motion.ts');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};

// ---- the markup ----
const render=(props,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},h(CountUp,props)));
check(render({value:1234}),'<span class="sdx-count"><span aria-hidden="true">1,234</span><span class="sr-only">1,234</span></span>','the final value, visible and for screen readers');
check(render({value:1234},'de'),'<span class="sdx-count"><span aria-hidden="true">1.234</span><span class="sr-only">1.234</span></span>','German number format');
check(render({value:0,className:'big'}),'<span class="sdx-count big"><span aria-hidden="true">0</span><span class="sr-only">0</span></span>','zero and an extra class');
check(render({value:2.25,digits:1}),'<span class="sdx-count"><span aria-hidden="true">2.3</span><span class="sr-only">2.3</span></span>','digits');
check(countDuration,240,'a count takes 240 ms');

// ---- countFrames ----
// A frame clock the test steps: run(time) calls the pending callback with that time.
function frameClock(){
 let next=1;const pending=new Map(),cancelled=[];
 return {frames:{request:callback=>{const id=next++;pending.set(id,callback);return id;},cancel:id=>{cancelled.push(id);pending.delete(id);}},cancelled,
  get waiting(){return pending.size;},
  run(time){const entries=[...pending];pending.clear();for(const [,callback] of entries)callback(time);}};
}
let clock=frameClock(),values=[],done=0;
countFrames({from:0,to:120,frames:clock.frames,frame:value=>values.push(value),done:()=>done++});
check([values,clock.waiting],[[0],1],'the first frame shows the start value at once');
for(const time of [1000,1060,1120,1180,1200])clock.run(time);
ok(values.length===6&&values.every((value,index)=>Number.isInteger(value)&&(index===0||value>=values[index-1]))&&values.at(-1)<120&&values[2]>60,'whole numbers that rise, fast first (ease-out): '+values.join(' '));
check(done,0,'not done before the duration');
clock.run(1240);
check([values.at(-1),done,clock.waiting],[120,1,0],'the last frame is the target itself, then done, and no frame is left');
clock=frameClock();values=[];
countFrames({from:9,to:4,frames:clock.frames,frame:value=>values.push(value)});
clock.run(0);clock.run(120);clock.run(999);
check([values[0],values.at(-1),values.every((value,index)=>index===0||value<=values[index-1])],[9,4,true],'a smaller value counts down');
clock=frameClock();values=[];done=0;
const cancel=countFrames({from:0,to:50,frames:clock.frames,frame:value=>values.push(value),done:()=>done++});
clock.run(0);clock.run(100);
const before=values.length;cancel();clock.run(200);clock.run(999);
check([values.length,done,clock.cancelled.length],[before,0,1],'a cancelled count calls nothing more');
clock=frameClock();values=[];
countFrames({from:0,to:7,duration:0,frames:clock.frames,frame:value=>values.push(value)});clock.run(5);
check(values,[0,7],'a duration of 0 ends on the first frame');

// ---- the component ----
const motion={reduced:false};
const harness=panelHarness({hooked:['ui/kit/count-up.tsx'],locale:'en',layoutEffects:true,stubs:{'@/ui/base/motion':{reducedMotion:()=>motion.reduced}}});
const Hooked=harness.load('ui/kit/count-up.tsx').CountUp;
const realRequest=globalThis.requestAnimationFrame,realCancel=globalThis.cancelAnimationFrame;
let frames=frameClock();
const install=()=>{frames=frameClock();globalThis.requestAnimationFrame=frames.frames.request;globalThis.cancelAnimationFrame=frames.frames.cancel;};
/** Renders the component, gives it a text node and runs its layout effect. */
async function show(props,text){harness.tree(Hooked,props);const ref=harness.h.refs.get(0);ref.current??={firstChild:{nodeValue:''}};ref.current.firstChild.nodeValue=text;await harness.flush();return ref.current.firstChild;}
const finish=()=>{for(const time of [0,100,200,240])frames.run(time);};

install();harness.reset();
let node=await show({value:1500,entranceId:'tile-a'},'1,500');
check([node.nodeValue,frames.waiting],['0',1],'the first show starts at 0 before the paint');
frames.run(0);frames.run(120);
ok(/^\d,\d{3}$|^\d{1,3}$/.test(node.nodeValue)&&node.nodeValue!=='1,500','in between: a formatted whole number, '+node.nodeValue);
frames.run(240);
check([node.nodeValue,frames.waiting],['1,500',0],'the count ends on the value');
node=await show({value:1500,entranceId:'tile-a'},'1,500');
check(frames.waiting,0,'the same value again counts nothing');
node=await show({value:1520,entranceId:'tile-a'},'1,520');
check(node.nodeValue,'1,500','a new value counts from the previous one');
finish();
check(node.nodeValue,'1,520','and ends on the new value');
// A count that is cut short by the next value: the old frames stop and the new count starts where the old one began.
node=await show({value:2000,entranceId:'tile-a'},'2,000');frames.run(0);frames.run(60);
node=await show({value:3000,entranceId:'tile-a'},'3,000');
check([node.nodeValue,frames.cancelled.length>0],['1,520',true],'a cut count is cancelled; the next starts from the last settled value');
finish();
check(node.nodeValue,'3,000','it ends on the latest value');

// Once per page load for an entrance id: a later mount shows the value at once; another id counts.
install();harness.reset();
node=await show({value:1500,entranceId:'tile-a'},'1,500');
check([node.nodeValue,frames.waiting],['1,500',0],'a later mount with the same entrance id does not count again');
harness.reset();
node=await show({value:42,entranceId:'tile-b'},'42');
check(node.nodeValue,'0','another entrance id counts from 0');
finish();
harness.reset();
node=await show({value:42},'42');
check(node.nodeValue,'0','without an entrance id every mount counts');
finish();

// Reduced motion and a browser without frames: the value shows at once.
install();harness.reset();motion.reduced=true;
node=await show({value:77,entranceId:'tile-c'},'77');
check([node.nodeValue,frames.waiting],['77',0],'reduced motion: no count');
motion.reduced=false;harness.reset();
node=await show({value:77,entranceId:'tile-c'},'77');
check([node.nodeValue,frames.waiting],['77',0],'the entrance of that id is used up, also without motion');
harness.reset();delete globalThis.requestAnimationFrame;delete globalThis.cancelAnimationFrame;
node=await show({value:5,entranceId:'tile-d'},'5');
check(node.nodeValue,'5','without requestAnimationFrame: no count');
if(realRequest)globalThis.requestAnimationFrame=realRequest;if(realCancel)globalThis.cancelAnimationFrame=realCancel;

// ---- reducedMotion ----
const realWindow=globalThis.window;
delete globalThis.window;
check(reducedMotion(),true,'without a window (the server, a test) nothing moves');
globalThis.window={};check(reducedMotion(),true,'without matchMedia nothing moves');
const queries=[];
globalThis.window={matchMedia:query=>{queries.push(query);return {matches:false};}};check([reducedMotion(),queries],[false,['(prefers-reduced-motion: reduce)']],'motion is allowed when the user did not ask to reduce it');
globalThis.window={matchMedia:()=>({matches:true})};check(reducedMotion(),true,'prefers-reduced-motion: reduce');
if(realWindow===undefined)delete globalThis.window;else globalThis.window=realWindow;

// ---- the source ----
const source=readFileSync('ui/kit/count-up.tsx','utf8');
ok(!/useState|setState/.test(source),'no React state: a frame causes no render');
ok(/reducedMotion\(\)/.test(source)&&/requestAnimationFrame/.test(source),'it asks for reduced motion and uses animation frames');

console.log(`count-up: ${checks} checks passed`);
