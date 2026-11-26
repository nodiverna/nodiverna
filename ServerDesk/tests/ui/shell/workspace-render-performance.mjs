// The console workspace re-renders only what changed: the clock is a store, a refresh keeps unchanged data by
// identity and renders as a transition, and the fleet rows, device cards and tree rows are memoized.
// 1. The clock store: one interval for any number of subscribers, selector subscribers are told only about a change of
//    their value, the interval stops with the last subscriber (fake timers and time).
// 2. The merge of console answers (ui/shell/keep-equal.ts): equal devices, jobs, groups and customers keep their identity;
//    the keys __proto__, constructor and prototype of an answer (top level and nested, through keepEqual and the three
//    console merges) are never copied into a built object, change no prototype and count as absent for the identity rule.
// 3. The console (tests/support/console-harness.mjs): a tick without a console-level change renders nothing; the jobs
//    poll flag, the header counts, the dock job, the badge and the removal context follow the clock; source guards.
// 4. Rows: FleetView (table and cards) and InventoryTree with 250 devices in 12 groups, rendered by the memo renderer
//    (tests/support/memo-renderer.mjs, real React components and React.memo); its counter counts every render of each
//    component: ticks, an unchanged and a one-device refresh, a selection, expanding a tree node, the arrow keys, and
//    a heartbeat that changes every device (the table renders its rows in chunks, one per animation frame), and a
//    refresh without one device; the row-menu cache (rowMenuCache) alone: one element per id, retain, rename.
// 5. The refresh and the jobs poll update their state inside startTransition (the hook with a stubbed React); with the
//    payload worker (the real client on tests/support/fake-payload-worker.mjs) a refresh reads a Blob, never json(), an
//    equal answer sets no data, refreshes, jobs polls, 401, error and invalid answers keep the worker's base right, and
//    a failing or missing worker falls back to readApiJson and the sliced merge for good.
// 6. EntranceList plays once and not after a re-render with new rows; it keeps the rows memoized.
// 7. Source checks: the off-screen size estimate of a device card is built from its --sdx-card-* properties (resolved
//    against app/globals.css), with the customer-line variant; the menu doc comments in ui/kit/kit.tsx and the first
//    line of tests/support/memo-renderer.mjs.
// No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {postcss} from '../../support/theme-colors.mjs';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>fs.readFileSync(file,'utf8');
const h=React.createElement;

// No timer of the components runs on its own here: the clock moves only through consoleClock.set. Effects that read
// the window or the storage get small stand-ins.
const intervals=[];
globalThis.setInterval=(callback,ms)=>{intervals.push({callback,ms});return intervals.length;};
globalThis.clearInterval=()=>{};
const stored=new Map();
globalThis.localStorage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,String(value)),removeItem:key=>stored.delete(key)};
globalThis.window={matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),addEventListener(){},removeEventListener(){},innerHeight:900,localStorage:globalThis.localStorage,setTimeout:(...args)=>setTimeout(...args),clearTimeout:timer=>clearTimeout(timer),requestAnimationFrame:callback=>setTimeout(callback,16),cancelAnimationFrame:timer=>clearTimeout(timer)};
// The chunked rows of the Devices table wait for the next animation frame. A frame comes only when the test runs it
// (runFrames), so a slow render can never let a timer bring the next chunk early.
const frames=new Map();let frameIds=0;
globalThis.requestAnimationFrame=callback=>{frames.set(++frameIds,callback);return frameIds;};
globalThis.cancelAnimationFrame=id=>{frames.delete(id);};
const runFrames=()=>{const due=[...frames.values()];frames.clear();for(const callback of due)callback(performance.now());};

const {clockStore,consoleClock}=await import('../../../ui/base/clock-store.ts');
const {keepEqual,mergeConsoleData,mergeConsoleJobs,mergeConsoleDataInSlices,jsonEqual}=await import('../../../ui/shell/keep-equal.ts');
const {memoRenderer}=await import('../../support/memo-renderer.mjs');
const {consoleHarness}=await import('../../support/console-harness.mjs');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {default:FleetView,fleetRowChunk,rowMenuCache}=await import('../../../ui/devices/fleet/fleet.tsx');
const InventoryTree=(await import('../../../ui/devices/fleet/inventory-tree.tsx')).default;
const {DataTable}=await import('../../../ui/kit/data-table.tsx');
const memoType=Symbol.for('react.memo');
// After the imports (sonner adds its style tag when a document exists at import time): the effects of radix layers
// subscribe to document events.
globalThis.document={addEventListener(){},removeEventListener(){},documentElement:{dataset:{},style:{},lang:'en'},body:{style:{}},activeElement:null,querySelector:()=>null,getElementById:()=>null};

// ---- 1. Clock store ----
{
 let time=1000,started=0,stopped=0;const timers=[];
 const clock=clockStore({time:()=>time,timers:{setInterval:(callback,ms)=>{started++;timers.push({callback,ms});return timers.length;},clearInterval:()=>{stopped++;}}});
 check(clock.now(),1000,'the first read takes the wall clock');
 const calls={a:0,b:0};
 const off=[clock.subscribe(()=>calls.a++),clock.subscribe(()=>calls.b++),clock.subscribe(()=>{})];
 check([started,timers.length,timers[0].ms],[1,1,1000],'one 1 s interval for any number of subscribers');
 timers[0].callback();
 check([clock.now(),calls],[1000,{a:0,b:0}],'a tick at the same time notifies nobody');
 time=2000;timers[0].callback();
 check([clock.now(),calls],[2000,{a:1,b:1}],'a tick at a new time notifies every subscriber');
 // A selector subscriber (useSyncExternalStore's rule): told about a tick, it renders only when its value changes.
 let renders=0,shown=Math.floor(clock.now()/5000);
 const select=now=>Math.floor(now/5000);
 const unsubscribe=clock.subscribe(()=>{const next=select(clock.now());if(!Object.is(next,shown)){shown=next;renders++;}});
 for(const at of [3000,4000,4999,5000,6000,9999,10000]){time=at;timers[0].callback();}
 check(renders,2,'the selector subscriber renders only on the ticks its value changes (5 s and 10 s)');
 unsubscribe();
 for(const close of off)close();
 check([stopped,clock.now()===2000],[1,false],'the interval stops when the last subscriber leaves, and the clock forgets its time');
 clock.set(42);
 check(clock.now(),42,'set moves the clock (fake time)');
 ok(typeof consoleClock.subscribe==='function'&&typeof consoleClock.set==='function','the console has one shared clock');
}

// ---- 2. Merge ----
{
 const device=(id,changes={})=>({id,name:id.toUpperCase(),lastSeen:1000,snapshot:{cpu:10,memory:20,disks:[{name:'C:',totalGb:100,freeGb:50}]},groups:[{id:'g1',name:'G1',direct:true}],...changes});
 const previous={viewer:{id:'u1',permissions:['*']},servers:[device('a'),device('b'),device('c')],jobs:[{id:'j1',state:'running',serverId:'a'}],deviceGroups:[{id:'g1',name:'G1'}],customers:[{id:'k1',name:'K1'}],audit:[],deviceAudit:[{id:1,at:5}],permissionDevices:[],pluginReleases:[],maintenance:{stale:false},emergencyAlarms:{open:0}};
 const clone=value=>JSON.parse(JSON.stringify(value));
 const same=mergeConsoleData(previous,clone(previous));
 check(same,previous,'an equal answer is equal');
 ok(same===previous,'an equal answer keeps the whole previous object');
 const next=clone(previous);next.servers[1].snapshot.cpu=99;
 const merged=mergeConsoleData(previous,next);
 ok(merged!==previous&&merged.servers!==previous.servers,'a changed device gives a new answer and a new list');
 ok(merged.servers[0]===previous.servers[0]&&merged.servers[2]===previous.servers[2],'the unchanged devices keep their objects');
 ok(merged.servers[1]!==previous.servers[1]&&merged.servers[1].snapshot.cpu===99,'the changed device is the new object');
 ok(['viewer','jobs','deviceGroups','customers','audit','deviceAudit','permissionDevices','pluginReleases','maintenance','emergencyAlarms'].every(key=>merged[key]===previous[key]),'every unchanged top-level part keeps its identity');
 const reordered=clone(previous);reordered.servers=[reordered.servers[2],device('d'),reordered.servers[0]];
 const order=mergeConsoleData(previous,reordered);
 check(order.servers.map(server=>server.id),['c','d','a'],'the order and the membership follow the new answer (b removed, d added)');
 ok(order.servers[0]===previous.servers[2]&&order.servers[2]===previous.servers[0],'matched by id, moved devices keep their objects');
 const jobs=[{id:'j1',state:'running',serverId:'a'},{id:'j2',state:'pending',serverId:'b'}];
 const polled=mergeConsoleJobs(previous,clone(jobs),clone(previous.viewer));
 ok(polled.servers===previous.servers&&polled.deviceGroups===previous.deviceGroups&&polled.viewer===previous.viewer,'the jobs-only poll keeps servers, groups and the equal viewer');
 ok(polled.jobs!==previous.jobs&&polled.jobs[0]===previous.jobs[0],'a new job gives a new list that keeps the unchanged job');
 ok(mergeConsoleJobs(previous,clone(previous.jobs),clone(previous.viewer))===previous,'an unchanged poll keeps everything');
 const list=[1,2,3];
 ok(keepEqual(list,[1,2,3])===list&&keepEqual({a:list},{a:[1,2,3]}).a===list,'an all-equal array keeps its identity, also inside an object');
 check(keepEqual([1,2],[2,1]),[2,1],'a list without ids is matched by position');
 ok(jsonEqual({a:[1,{b:null}]},{a:[1,{b:null}]})&&!jsonEqual({a:1},{a:1,b:2})&&!jsonEqual([1],{0:1}),'jsonEqual compares JSON values deeply');
 // Prototype keys: JSON.parse makes "__proto__" an own key. The merge never copies __proto__, constructor or prototype
 // into an object it builds (an assignment of "__proto__" would change the built object's prototype), and they count
 // as absent for the identity rule.
 const skipped=['__proto__','constructor','prototype'];
 const ordinary=(value,label)=>ok(Object.getPrototypeOf(value)===Object.prototype&&!skipped.some(key=>Object.hasOwn(value,key))&&!('polluted' in value)&&value.constructor===Object,`${label}: an ordinary object without the skipped keys`);
 const unpolluted=label=>ok(({}).polluted===undefined&&!Object.hasOwn(Object.prototype,'polluted')&&Object.prototype.constructor===Object&&Object.getPrototypeOf({})===Object.prototype,`${label}: Object.prototype is unchanged`);
 const parsed=JSON.parse('{"a":2,"__proto__":{"polluted":true}}');
 ok(Object.hasOwn(parsed,'__proto__'),'JSON.parse makes "__proto__" an own key');
 const top=keepEqual({a:1},parsed);
 check(top,{a:2},'keepEqual with a "__proto__" key gives {a:2}');
 ordinary(top,'keepEqual: the top-level result');unpolluted('keepEqual');
 const constructed=keepEqual({a:1},JSON.parse('{"a":2,"constructor":{"x":1},"prototype":{"y":1}}'));
 ok(constructed.constructor===Object&&!Object.hasOwn(constructed,'constructor')&&!Object.hasOwn(constructed,'prototype')&&constructed.a===2,'a "constructor" or "prototype" key is not copied: result.constructor===Object');
 const kept={a:1,inner:{b:[1,2]}};
 ok(keepEqual(kept,JSON.parse('{"a":1,"inner":{"b":[1,2],"__proto__":{"polluted":true}},"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":1}'))===kept,'an answer that differs only by skipped keys (also nested) keeps the previous object');
 ok(keepEqual(kept,JSON.parse('{"a":1,"inner":{"b":[1,2]},"constructor":1,"c":2}'))!==kept,'… a real new key still gives a new object');
 // Nested, through the three console merges: an equal device that only gains skipped keys keeps its object; a changed
 // viewer and a changed nested object (maintenance) are built without them.
 const hostile=text=>JSON.parse(text
  .replace('"viewer":{"id":"u1"','"viewer":{"__proto__":{"polluted":true},"constructor":{"x":1},"id":"u2"')
  .replace('"snapshot":{"cpu":10','"snapshot":{"__proto__":{"polluted":true},"prototype":{"y":1},"cpu":10')
  .replace('"maintenance":{"stale":false}','"maintenance":{"__proto__":{"polluted":true},"stale":true}'));
 const hostileAnswer=hostile(JSON.stringify(previous));
 ok(Object.hasOwn(hostileAnswer.viewer,'__proto__')&&Object.hasOwn(hostileAnswer.servers[0].snapshot,'__proto__')&&Object.hasOwn(hostileAnswer.maintenance,'__proto__'),'the hostile answer carries own "__proto__" keys in viewer, servers[0].snapshot and maintenance');
 for(const [label,result] of [['mergeConsoleData',mergeConsoleData(previous,hostileAnswer)],['mergeConsoleDataInSlices',await mergeConsoleDataInSlices(previous,hostile(JSON.stringify(previous)))]]){
  ordinary(result,`${label}: the answer`);ordinary(result.viewer,`${label}: viewer`);ordinary(result.maintenance,`${label}: maintenance`);
  ok(result.viewer.id==='u2'&&result.viewer.permissions===previous.viewer.permissions&&result.maintenance.stale===true,`${label}: the changed parts show the answer and keep their equal children`);
  ok(result.servers===previous.servers&&result.servers[0].snapshot===previous.servers[0].snapshot,`${label}: servers[0] differs only by skipped keys and keeps its object (no skipped key in servers[0].snapshot)`);
  ordinary(result.servers[0].snapshot,`${label}: servers[0].snapshot`);
  unpolluted(label);
 }
 const hostileViewer=JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"id":"u1","permissions":["*"]}');
 ok(mergeConsoleJobs(previous,clone(previous.jobs),hostileViewer)===previous,'mergeConsoleJobs: a viewer that only gains skipped keys keeps everything');
 const jobsMerged=mergeConsoleJobs(previous,JSON.parse('[{"id":"j1","state":"running","serverId":"a","__proto__":{"polluted":true}},{"id":"j2","state":"pending","serverId":"b"}]'),JSON.parse('{"__proto__":{"polluted":true},"id":"u1","permissions":["*"],"label":"new"}'));
 ordinary(jobsMerged,'mergeConsoleJobs: the answer');ordinary(jobsMerged.viewer,'mergeConsoleJobs: viewer');
 ok(jobsMerged.viewer.label==='new'&&jobsMerged.viewer.permissions===previous.viewer.permissions&&jobsMerged.jobs[0]===previous.jobs[0],'mergeConsoleJobs: the changed viewer is built, the job that only gains a skipped key keeps its object');
 unpolluted('mergeConsoleJobs');
 // A part taken from the answer as a whole (a changed device) is the object JSON.parse made: its "__proto__" key stays
 // own data there, as in ui/shell/console-payload.ts, and changes no prototype.
 const changedDevice=mergeConsoleData(previous,JSON.parse(JSON.stringify(previous).replace('"snapshot":{"cpu":10','"snapshot":{"__proto__":{"polluted":true},"cpu":11')));
 ok(changedDevice.servers[0]!==previous.servers[0]&&Object.getPrototypeOf(changedDevice.servers[0].snapshot)===Object.prototype&&!('polluted' in changedDevice.servers[0].snapshot)&&changedDevice.servers[0].snapshot.cpu===11,'a changed device is the new object; its "__proto__" key changed no prototype');
 unpolluted('a changed device');
 // The cost for 250 devices with full snapshots of the sample devices: a heartbeat answer (every device changed) is
 // cheap because the compare stops at the first difference; an unchanged answer is compared in slices of about 4 ms.
 const {demoData}=await import('../../../ui/shell/demo.ts');
 const samples=demoData().servers;
 const big=Array.from({length:250},(_,index)=>({...samples[index%samples.length],id:'d'+index}));
 const answer={...previous,servers:big};
 const base=mergeConsoleData(null,clone(answer));
 const heartbeat=clone(answer);for(const server of heartbeat.servers){server.lastSeen=(server.lastSeen??0)+30000;if(server.snapshot)server.snapshot.cpu=(server.snapshot.cpu??0)+1;}
 let worst=0;
 for(let run=0;run<5;run++){const copy=clone(heartbeat),start=performance.now();const result=mergeConsoleData(base,copy);worst=Math.max(worst,performance.now()-start);ok(result.servers.every((server,index)=>server!==base.servers[index]),'every device of a heartbeat answer is new');}
 ok(worst<25,`merging a heartbeat answer of 250 sample devices takes ${worst.toFixed(1)} ms (< 25 ms unthrottled)`);
 // The slicing: with a clock that advances 1 ms per device, a 4 ms budget pauses after every 5 devices.
 let virtual=0,steps=0;
 const counted=await mergeConsoleDataInSlices(base,clone(answer),{clock:()=>virtual++,pause:async()=>{steps++;}});
 ok(counted===base&&steps>=45,`the device list is compared in slices: ${steps} pauses for 250 devices`);
 // In real time: the median slice stays near the 4 ms budget (a garbage collection may stretch a single one).
 const slices=[];
 const unchanged=clone(answer);
 const sliced=await (async()=>{let start=performance.now();const result=await mergeConsoleDataInSlices(base,unchanged,{pause:async()=>{slices.push(performance.now()-start);await new Promise(resolve=>setImmediate(resolve));start=performance.now();}});slices.push(performance.now()-start);return result;})();
 ok(sliced===base,'the sliced merge of an unchanged answer keeps the whole previous object');
 const median=[...slices].sort((a,b)=>a-b)[Math.floor(slices.length/2)];
 ok(slices.length>1&&median<10,`an unchanged answer of 250 sample devices is compared in ${slices.length} slices, median ${median.toFixed(1)} ms (< 10 ms)`);
 const slicedHeartbeat=await mergeConsoleDataInSlices(base,clone(heartbeat));
 check(slicedHeartbeat,mergeConsoleData(base,clone(heartbeat)),'the sliced merge gives the same answer as mergeConsoleData');
 ok(slicedHeartbeat.deviceGroups===base.deviceGroups&&slicedHeartbeat.viewer===base.viewer,'… and keeps the unchanged parts');
}

// ---- 3. Console ----
{
 const owner={id:'u1',label:'ada@example.test',username:'ada',permissions:['*'],identitySource:'local'};
 const now=Date.now();
 const server=(id,lastSeen)=>({id,name:id.toUpperCase(),createdAt:now-3600000,lastSeen,revoked:0,management:0,snapshot:null,issues:[]});
 // s2 leaves the 2-minute online window 1.5 s after the start.
 const servers=[server('s1',now-1000),server('s2',now-118500),server('s3',now-1000)];
 const later=now+5000;
 const jobs=[{id:'j-due',serverId:'s1',action:'refresh-inventory',state:'pending',createdAt:now-1000,notBefore:later},{id:'j-uninstall',serverId:'s3',action:'agent-uninstall',state:'pending',createdAt:now-1000,notBefore:later+60000}];
 const ui=consoleHarness({viewer:owner,hash:'#devices',base:{servers,jobs,audit:[],deviceGroups:[],customers:[]}});
 await ui.settle();
 const header=()=>ui.fleet().props.header.props.subtitle,badge=()=>ui.find('Rail').props.jobs.count,dock=()=>ui.find('JobDock').props.current?.id;
 const first=[header(),badge(),dock()];
 check(first,[first[0],0,undefined],'start: the scheduled job is no badge count and no dock job');
 ok(/3/.test(first[0]),'the header subtitle counts 3 devices');
 const fleet=ui.fleet(),renders=ui.renders;
 await ui.tick();
 check([ui.renders,ui.fleet()===fleet],[renders,true],'a tick that changes no console-level value does not render the console');
 await ui.tick();
 ok(ui.renders===renders+1,'the tick on which s2 leaves the online window renders the console once');
 ok(header()!==first[0]&&ui.fleet().props.header!==fleet.props.header,'the header counts change (one device less online)');
 ok(ui.fleet().props.removalContext===fleet.props.removalContext,'the removal context keeps its identity while its pending set does not change');
 check([...ui.fleet().props.removalContext.pending],['s3'],'the pending uninstall keeps s3\'s switch off');
 ok(Math.abs(ui.fleet().props.removalContext.now-ui.clock.now())<1,'the removal context reads the clock when a dialog is built');
 const before=ui.renders;
 await ui.advance(3000);
 check([badge(),dock()],[1,'j-due'],'when notBefore passes, the job counts as waiting (badge) and becomes the dock job');
 ok(ui.renders===before+1,'that tick renders the console once');
 // The jobs poll flag lives in useConsoleData (mocked here); its selector is checked in part 5 and in the source.
 // The 12 s "recently finished" display: the dock shows the finished job until its time ends.
 ui.setData({jobs:[{...jobs[0],state:'running',claimedAt:ui.now}]});await ui.settle();
 ui.setData({jobs:[{...jobs[0],state:'succeeded',claimedAt:ui.now}]});await ui.settle();
 check(dock(),'j-due','a job that just finished stays in the dock');
 await ui.advance(11000);
 check(dock(),'j-due','… for 12 s');
 await ui.advance(2000);
 check(dock(),undefined,'and leaves it on the tick after its 12 s');
 const source=read('ui/shell/console.tsx');
 ok(!/\[clock,setClock\]|setClock|\bclock\b[^\n]*=useState/.test(source)&&!/now=\{clock/.test(source)&&!/setInterval/.test(source),'console.tsx has no clock state, no interval and no now={clock}');
 ok(/useClockValue\(now=>data\?\.jobs\.some\(job=>\['pending','running'\]\.includes\(job\.state\)&&\(job\.notBefore\?\?0\)<=now\)\?\?false\)/.test(read('ui/shell/use-console-data.ts')),'the jobs poll starts through a clock selector on the due jobs');
 ok(!/now=\{now\}/.test(read('ui/devices/fleet/fleet.tsx').match(/function FleetView[\s\S]*?\nexport default memo\(FleetView\)/)[0]),'FleetView passes no per-second now to its tabs, export, power drawer or update cells');
}

// ---- 4. Rows ----
const T0=Date.UTC(2026,10,14,10,0,0);
const groups=Array.from({length:12},(_,index)=>({id:'g'+(index+1),name:'Site '+String(index+1).padStart(2,'0'),description:'',parentId:null,depth:0,deviceCount:0,permissions:['groups.manage']}));
// Every device reports 5 s before T0, except: SRV-002 leaves the online window between T0+1 s and T0+2 s, and the
// "last seen" text of SRV-003 turns from "Just now" into "1 min ago" between T0+2 s and T0+3 s.
const lastSeenOf=index=>index===1?T0-118500:index===2?T0-42000:T0-5000;
const fleetDevices=Array.from({length:250},(_,index)=>{
 const group=groups[index%12],number=String(index+1).padStart(3,'0');
 return {id:'d'+number,name:'SRV-'+number,createdAt:T0-86400000,lastSeen:lastSeenOf(index),revoked:0,management:0,permissions:['view','groups.manage'],issues:[],
  snapshot:{os:'Microsoft Windows Server 2022',cpu:10+index%50,memory:30,disks:[{name:'C:',totalGb:100,freeGb:60}],networks:[]},
  groupId:group.id,groupName:group.name,groups:[{id:group.id,name:group.name,parentId:null,depth:0,direct:true}]};
});
const viewer={id:'tech',label:'tech@example.test',username:'tech',permissions:['view'],identitySource:'local'};
const noop=()=>{};
// The props the console hands the views keep their identity (console.tsx); so do these.
const noJobs=[],noAudit=[];
const fleetProps=servers=>({header:null,servers,scoped:servers,groupEmpty:false,viewer,demo:false,saving:false,jobs:noJobs,audit:noAudit,tab:'devices',onTab:noop,canOffboard:true,onOpen:noop,onConfirm:noop,onSelectJob:noop,onCancelJob:noop,onUpdated:noop,onDemo:noop,canMove:true,onMove:noop,customerColumn:false});
const treeProps=servers=>({servers,deviceGroups:groups,filter:'',onAll:noop,onGroup:noop,onDevice:noop,onAction:noop,canManageGroups:true,canCreateRootGroup:true,canManagePermissions:false,canProvision:false,onMoveDevices:noop,canMoveToRoot:true});
const elementsOf=renderer=>renderer.elements();
/** One workspace: the fleet view and the navigator tree, as the console shows them side by side. */
// The tree shows SRV-002 selected, so its group (Site 02, with SRV-002 and SRV-014) is open.
const workspace=(servers,fleet=fleetProps(servers),tree={...treeProps(servers),selectedServerId:'d002'})=>h(LocaleProvider,{locale:'en'},h('div',null,h(FleetView,fleet),h(InventoryTree,tree)));
const clone=value=>JSON.parse(JSON.stringify(value));
const counts=renderer=>({FleetView:renderer.renders('FleetView'),rows:renderer.renders('ClockedDataRow'),cards:renderer.renders('DeviceCard'),InventoryTree:renderer.renders('InventoryTree'),treeRows:renderer.renders('TreeRow')});
const zero={FleetView:0,rows:0,cards:0,InventoryTree:0,treeRows:0};
const text=(renderer,predicate)=>elementsOf(renderer).filter(predicate);
const statusCounts=renderer=>Object.fromEntries((elementsOf(renderer).find(element=>element.props.label==='Status'&&Array.isArray(element.props.items))?.props.items??[]).map(item=>[item.id,item.count]));

// The row-menu cache of FleetView, without React: one element per device id; retain drops the devices that left.
{
 let builds=0;
 const cache=rowMenuCache(device=>{builds++;return {label:'Actions for '+device.name};});
 const a=cache({id:'a',name:'A'}),b=cache({id:'b',name:'B'}),c=cache({id:'c',name:'C'});
 check([builds,cache.ids()],[3,['a','b','c']],'menu cache: one element per device id');
 ok(cache({id:'a',name:'A'})===a&&cache({id:'b',name:'B'})===b&&builds===3,'menu cache: a row that renders again gets the same element without a build');
 cache.retain([{id:'c'},{id:'a'}]);
 check(cache.ids(),['a','c'],'menu cache: retain drops the id that left the list');
 ok(cache({id:'a',name:'A'})===a&&cache({id:'c',name:'C'})===c&&builds===3,'menu cache: the devices that stay keep the same element object, and build is not called again');
 cache.retain([{id:'a'},{id:'c'}]);
 ok(cache.ids().length===2&&cache({id:'a',name:'A'})===a&&builds===3,'menu cache: retain with the same list again changes nothing');
 const renamed=cache({id:'a',name:'A2'});
 ok(renamed!==a&&renamed.label==='Actions for A2'&&builds===4,'menu cache: a renamed device gets a new element with the new name');
 check(cache.ids(),['a','c'],'menu cache: … in place of the old one (one entry per id)');
 ok(cache({id:'a',name:'A2'})===renamed&&builds===4,'menu cache: the new element is kept from then on');
 ok(cache({id:'b',name:'B'})!==b&&builds===5&&cache.ids().length===3,'menu cache: a device that comes back after it was dropped is built again');
 cache.retain([]);
 check(cache.ids(),[],'menu cache: an empty list drops every element');
}

for(const layout of ['table','cards']){
 stored.set('serverdesk.redesign.layout',JSON.stringify(layout));
 consoleClock.set(T0);
 const renderer=memoRenderer();
 let servers=mergeConsoleData(null,{servers:clone(fleetDevices)}).servers;
 renderer.render(workspace(servers));await renderer.flush();
 // The first-load entrance of the rows (once per page load) ends after about 0.75 s; the counts below start after it.
 await new Promise(resolve=>setTimeout(resolve,800));await renderer.flush();
 const rowName=layout==='table'?'rows':'cards';
 // Each device renders once; the first table of the page load also lifts its first 8 rows, which render once more when
 // the entrance ends. The card layout comes later in the page load, so its cards do not rise again.
 check(renderer.renders(layout==='table'?'ClockedDataRow':'DeviceCard'),layout==='table'?258:250,`${layout}: every device renders once on mount (and the entrance rows once when it ends)`);
 check(statusCounts(renderer),{all:250,online:250,warning:0,offline:0},`${layout}: the status counts at the start`);
 // A tick without a change of any clock-derived value.
 renderer.resetRenders();consoleClock.set(T0+1000);await renderer.flush();
 check(counts(renderer),zero,`${layout}: a tick without a change renders no FleetView, row, card, tree or tree row`);
 // SRV-002 leaves the online window: its row or card, its tree row and the aggregates (status counts) render.
 renderer.resetRenders();consoleClock.set(T0+2000);await renderer.flush();
 check(counts(renderer),{...zero,FleetView:1,[rowName]:1,treeRows:1},`${layout}: one device going offline renders FleetView (its counts), exactly 1 ${layout==='table'?'row':'card'} and 1 tree row`);
 check(statusCounts(renderer),{all:250,online:249,warning:0,offline:1},`${layout}: the status Segmented counts it offline at once`);
 // The open group (Site 02) shows a dot for each of its devices.
 const tones=text(renderer,element=>element.type==='i'&&typeof element.props.className==='string'&&element.props.className.startsWith('sdx-dot')).map(element=>element.props.className.replace('sdx-dot sdx-dot-',''));
 check([tones.length>1,tones.filter(tone=>tone==='offline').length,tones.filter(tone=>tone==='online').length],[true,1,tones.length-1],`${layout}: the open group of SRV-002 shows its dot offline, the other dots online`);
 // SRV-003's "last seen" text changes: only its row or card renders; no aggregate changes.
 renderer.resetRenders();consoleClock.set(T0+3000);await renderer.flush();
 check(counts(renderer),{...zero,[rowName]:1},`${layout}: a new relative time of one device renders only its ${layout==='table'?'row':'card'}`);
 const seen=text(renderer,element=>element.type==='span'&&element.props.title!==undefined&&[element.props.children].flat().includes('1 min ago'));
 ok(seen.length>=1,`${layout}: SRV-003 shows "1 min ago"`);
 // An unchanged refresh: the merge keeps every object, so nothing renders.
 renderer.resetRenders();
 servers=mergeConsoleData({servers},{servers:clone(servers)}).servers;
 renderer.render(workspace(servers));await renderer.flush();
 check(counts(renderer),zero,`${layout}: an unchanged refresh renders no FleetView, row, card, tree or tree row`);
 // A refresh in which one device changed: FleetView and the tree render, of the rows only that device's.
 renderer.resetRenders();
 const changed=clone(servers);changed[13].snapshot.cpu=97;
 servers=mergeConsoleData({servers},{servers:changed}).servers;
 renderer.render(workspace(servers));await renderer.flush();
 check(counts(renderer),{FleetView:1,[rowName]:1,InventoryTree:1,treeRows:1,...(layout==='table'?{cards:0}:{rows:0})},`${layout}: a refresh with one changed device renders 1 ${layout==='table'?'row':'card'} and 1 tree row`);
 // Selecting one device: its row or card renders, no other.
 renderer.resetRenders();
 const box=elementsOf(renderer).find(element=>element.type==='input'&&element.props['aria-label']==='Select SRV-005');
 box.props.onChange({target:{checked:true}});await renderer.flush();
 check([renderer.renders(layout==='table'?'ClockedDataRow':'DeviceCard'),renderer.renders('TreeRow')],[1,0],`${layout}: selecting one checkbox renders 1 ${layout==='table'?'row':'card'}`);
 ok(elementsOf(renderer).some(element=>element.props.className==='sdx-bulkbar'),`${layout}: the bulk bar shows the selection`);
 // The row menu builds its entries only when it opens: the rows get one menu function that keeps its identity.
 // The device rows of the tree have a menu too (Pin device); it opens at the start edge (align="start").
 const menus=elementsOf(renderer).filter(element=>typeof element.type==='function'&&element.type.name==='Menu'&&typeof element.props.entries==='function'&&/SRV-/.test(element.props.label)&&element.props.align!=='start');
 check(menus.length,250,`${layout}: every ${layout==='table'?'row':'card'} has a menu whose entries are built on open`);
 check(menus[0].props.entries().map(entry=>entry.id),['open','terminal','files','restart','move','separator','remove'],`${layout}: the entries on open: Open, Terminal, Files, Restart…, Move, Remove`);
 if(layout==='table'){
  // A heartbeat: every device reports again with a new CPU value. The Devices table (rowChunk) renders the changed rows
  // in chunks of fleetRowChunk per animation frame, top first, until every row shows its new value.
  renderer.resetRenders();
  const beat=clone(servers).map((server,index)=>({...server,lastSeen:T0+2500,snapshot:{...server.snapshot,cpu:(index*7)%97}}));
  servers=mergeConsoleData({servers},{servers:beat}).servers;
  renderer.render(workspace(servers));await renderer.flush();
  const cpuOf=name=>elementsOf(renderer).find(element=>element.props?.label===`CPU ${name}`&&'value' in element.props)?.props.value;
  const steps=[renderer.renders('ClockedDataRow')];
  const nameAt=index=>'SRV-'+String(index+1).padStart(3,'0'),last=fleetRowChunk-1;
  check([cpuOf('SRV-001'),cpuOf(nameAt(last)),cpuOf(nameAt(last+1)),cpuOf('SRV-250')],[0,(last*7)%97,10+(last+1)%50,10+249%50],`table: the first frame shows the new values of the first ${fleetRowChunk} rows; the others keep theirs`);
  check(renderer.renders('FleetView'),1,'table: FleetView renders once for the heartbeat');
  for(let frame=0;frame<20&&steps.at(-1)>0;frame++){renderer.resetRenders();runFrames();await renderer.flush();steps.push(renderer.renders('ClockedDataRow'));}
  check(steps,[...Array(Math.ceil(250/fleetRowChunk)).fill(fleetRowChunk),0],`table: 250 changed rows render in chunks of ${fleetRowChunk}, one per animation frame, and then nothing more`);
  check([cpuOf('SRV-001'),cpuOf(nameAt(last+1)),cpuOf('SRV-250')],[0,((last+1)*7)%97,(249*7)%97],'table: after the last chunk every row shows its new value');
  ok(elementsOf(renderer).filter(element=>typeof element.type==='function'&&element.type.name==='Menu'&&/SRV-/.test(element.props.label)&&element.props.align!=='start').length===250,'table: every row keeps its menu');
 }
 // A refresh without one device (SRV-100): FleetView and the tree render, no row or card of the 249 devices that stay
 // (their order does not change); the row-menu cache drops the menu of the removed device and keeps the others.
 const menuElements=()=>new Map(elementsOf(renderer).filter(element=>typeof element.type==='function'&&element.type.name==='Menu'&&/SRV-/.test(element.props.label)&&element.props.align!=='start').map(element=>[element.props.label,element]));
 const cacheOf=()=>layout==='table'?elementsOf(renderer).find(element=>Array.isArray(element.props?.columns)&&element.props.columns.some(column=>column.id==='actions'))?.props.columns.find(column=>column.id==='actions').cell
  :elementsOf(renderer).find(element=>element.props?.server&&typeof element.props.menu==='function')?.props.menu;
 const menusBefore=menuElements(),cache=cacheOf();
 ok(typeof cache?.ids==='function'&&cache.ids().length===250&&cache.ids().includes('d100'),`${layout}: the row-menu cache holds the 250 devices`);
 renderer.resetRenders();
 servers=mergeConsoleData({servers},{servers:clone(servers).filter(server=>server.id!=='d100')}).servers;
 renderer.render(workspace(servers));await renderer.flush();runFrames();await renderer.flush();
 check(counts(renderer),{FleetView:1,rows:0,cards:0,InventoryTree:1,treeRows:2},`${layout}: a refresh without one device renders FleetView, the tree and its 2 count rows (All devices, Site 04), no ${layout==='table'?'row':'card'} of the 249 that stay`);
 ok(cacheOf()===cache&&cache.ids().length===249&&!cache.ids().includes('d100'),`${layout}: the cache dropped the removed device's menu (249 entries)`);
 const menusAfter=menuElements();
 ok(menusAfter.size===249&&!menusAfter.has('Actions for SRV-100')&&[...menusAfter].every(([label,element])=>menusBefore.get(label)===element),`${layout}: every remaining ${layout==='table'?'row':'card'} shows the same menu element as before`);
 renderer.unmount();
}

// The tree: expanding a node renders the node and its new children; an arrow key renders the two rows whose focus changed.
{
 stored.set('serverdesk.redesign.layout',JSON.stringify('table'));
 consoleClock.set(T0);
 const renderer=memoRenderer();
 // SRV-001 reported 60 s before T0, so it leaves the online window at T0+60 s, long before the others of its group.
 const servers=mergeConsoleData(null,{servers:clone(fleetDevices).map(device=>device.id==='d001'?{...device,lastSeen:T0-60000}:device)}).servers;
 renderer.render(h(LocaleProvider,{locale:'en'},h(InventoryTree,treeProps(servers))));await renderer.flush();
 const items=()=>elementsOf(renderer).filter(element=>element.props.role==='treeitem');
 check(items().length,13,'the tree starts with All devices and its 12 groups');
 renderer.resetRenders();
 const caret=elementsOf(renderer).find(element=>element.type==='span'&&element.props.className==='sdx-tree-caret'&&element===elementsOf(renderer).find(item=>item.props.role==='treeitem'&&item.props['data-key']==='group:g1')?.props.children?.[0]);
 const groupRow=items().find(element=>element.props['data-key']==='group:g1');
 const groupCaret=[groupRow.props.children].flat().find(child=>child?.props?.className==='sdx-tree-caret');
 (caret??groupCaret).props.onClick({stopPropagation(){}});await renderer.flush();
 const children=fleetDevices.filter(device=>device.groupId==='g1').length;
 check([renderer.renders('InventoryTree'),renderer.renders('TreeRow')],[1,1+children],`expanding a group renders the group row and its ${children} new device rows`);
 renderer.resetRenders();
 items().find(element=>element.props['data-key']==='group:g1').props.onKeyDown({key:'ArrowDown',preventDefault(){}});await renderer.flush();
 check(renderer.renders('TreeRow'),2,'↓ renders the row that loses and the row that gains the Tab stop');
 renderer.resetRenders();
 items().find(element=>element.props['data-key']==='group:g2').props.onDragOver({dataTransfer:{types:['application/x-serverdesk-devices'],dropEffect:''},preventDefault(){}});await renderer.flush();
 check(renderer.renders('TreeRow'),1,'a drag over a group renders only that row (its drop mark)');
 renderer.resetRenders();
 items().find(element=>element.props['data-key']==='group:g3').props.onContextMenu({preventDefault(){}});await renderer.flush();
 check(renderer.renders('TreeRow'),2,'opening a row menu renders that row (menu open, Tab stop) and the row that loses the Tab stop');
 // SRV-001 (in the open group) leaves the online window at T0+60 s: its tree dot turns offline.
 const dotOf=key=>{const row=items().find(element=>element.props['data-key']===key);return [row.props.children].flat(Infinity).flatMap(child=>child?.props?.children!==undefined?[child,...[child.props.children].flat()]:[child]).find(child=>typeof child?.props?.className==='string'&&child.props.className.startsWith('sdx-dot'))?.props.className;};
 check(dotOf('device:d001'),'sdx-dot sdx-dot-online','SRV-001 shows online');
 renderer.resetRenders();consoleClock.set(T0+59000);await renderer.flush();
 check([renderer.renders('TreeRow'),dotOf('device:d001')],[0,'sdx-dot sdx-dot-online'],'within its window: no tree row renders');
 consoleClock.set(T0+60500);await renderer.flush();
 check([renderer.renders('TreeRow'),dotOf('device:d001')],[1,'sdx-dot sdx-dot-offline'],'the tick it leaves the window renders its tree row with the offline tone');
 ok(InventoryTree.$$typeof===memoType&&FleetView.$$typeof===memoType,'FleetView and InventoryTree are memoized');
 renderer.unmount();
}

// ---- 5. Transition, payload worker and fallback ----
const {consolePayloadClient}=await import('../../../ui/shell/console-payload-client.ts');
const {fakePayloadWorker}=await import('../../support/fake-payload-worker.mjs');
const hookSource=ts.transpileModule(read('ui/shell/use-console-data.ts'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
/**
 * useConsoleData as a plain function on stubbed hooks. worker: 'fake' (the real client on tests/support/fake-payload-worker.mjs),
 * 'broken' (a worker whose script fails), 'stale' (its patches name another base), 'misfit' (its patches do not fit) or
 * 'none' (no Worker). An answer is a body (200), {status,body} (a string body
 * is sent as it is) or a promise of one; `reads` counts the readApiJson calls and json(), arrayBuffer() and blob() of
 * the fetched console answers (the jobs poll is not counted).
 */
async function hookHarness({worker='fake'}={}){
 let transition=false,cursor=0,result;const updates=[],effects=[],cleanups=[],cells=[],timers=[],answers=[],ports=[],reads={readApiJson:0,json:0,arrayBuffer:0,blob:0},fetched=[];
 const react={
  startTransition(callback){transition=true;try{callback();}finally{transition=false;}},
  useState(initial){const index=cursor++;cells[index]??={value:typeof initial==='function'?initial():initial,index};const cell=cells[index];return [cell.value,value=>{cell.value=typeof value==='function'?value(cell.value):value;updates.push({cell:index,transition});}];},
  useRef(initial){const index=cursor++;return cells[index]??={current:initial};},
  useCallback(callback,deps){const index=cursor++;const cell=cells[index];if(cell&&deps.every((value,i)=>Object.is(value,cell.deps[i])))return cell.value;cells[index]={value:callback,deps};return callback;},
  useEffect(callback,deps){const index=cursor++;const cell=cells[index];if(cell&&deps&&deps.every((value,i)=>Object.is(value,cell.deps[i])))return;cells[index]={deps};effects.push(callback);},
 };
 const stableT=key=>key;
 const respond=(entry,url)=>{
  const {status=200,body}=entry&&typeof entry==='object'&&'status' in entry?entry:{body:entry};
  const response=typeof body==='string'?new Response(body,{status,headers:{'Content-Type':'application/json'}}):Response.json(body,{status});
  if(url.includes('jobsOnly')){response.jobsPoll=true;return response;}
  const json=response.json.bind(response),arrayBuffer=response.arrayBuffer.bind(response),blob=response.blob.bind(response);
  response.json=()=>{reads.json++;return json();};
  response.arrayBuffer=()=>{reads.arrayBuffer++;return arrayBuffer();};
  response.blob=()=>{reads.blob++;return blob();};
  return response;
 };
 const modules={
  'react':react,'sonner':{toast:{error(){}}},
  '@/ui/base/api':{credentialFetch:async url=>{fetched.push(url);return respond(await answers.shift(),url);},readApiJson:response=>{if(!response.jobsPoll)reads.readApiJson++;return response.json();},invalidApiReply:status=>Object.assign(new Error('common.invalidApiReply'),{status})},
  // useStableT keeps its identity, as the real one does.
  '@/ui/base/locale':{useStableT:()=>stableT},
  '@/ui/base/clock-store':{useClockValue:select=>select(T0)},
  '@/ui/shell/keep-equal':await import('../../../ui/shell/keep-equal.ts'),
  '@/ui/shell/console-payload':await import('../../../ui/shell/console-payload.ts'),
  // The worker client: the real one on a fake worker port (no Worker in Node).
  '@/ui/shell/console-payload-client':{startConsolePayloadWorker:()=>{
   if(worker==='none'){ports.push(null);return null;}
   const port=fakePayloadWorker({broken:worker==='broken'});ports.push(port);
   const client=consolePayloadClient(port);
   if(worker!=='stale'&&worker!=='misfit')return client;
   // 'stale': every patch names a base the console does not hold (as if the shown data had moved on meanwhile);
   // 'misfit': every patch has a shape that does not fit the shown data.
   const alter=reply=>worker==='stale'?{...reply,base:reply.base+1000}:{...reply,patch:{a:1,s:[]}};
   return {get failed(){return client.failed;},seed:client.seed,full:client.full,jobs:client.jobs,terminate:client.terminate,parse:async(bytes,base)=>{const reply=await client.parse(bytes,base);return reply.type==='patch'&&reply.patch?alter(reply):reply;}};
  }},
  '@/ui/base/api-error-text':{apiErrorText:()=>'error'},
  '@/lib/i18n/locale':{documentLocale:()=>'en'},
  // The reload after a plugin job reads the open plugin jobs (no plugin job in these answers, so it never fires).
  '@/lib/extensions':await import('../../../lib/extensions.ts'),
 };
 const mod={exports:{}};
 const scope={window:{addEventListener(){},removeEventListener(){}},setInterval:callback=>{timers.push(callback);return timers.length;},clearInterval(){},setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
 new Function('require','module','exports',...Object.keys(scope),hookSource)(id=>{if(!(id in modules))throw Error('Unexpected import '+id);return modules[id];},mod,mod.exports,...Object.values(scope));
 // The hook runs as a plain function on the stubbed hooks above.
 const render=()=>{cursor=0;result=mod.exports.useConsoleData(false);};
 const runEffects=()=>{for(const effect of effects.splice(0)){const cleanup=effect();if(typeof cleanup==='function')cleanups.push(cleanup);}};
 const tick=()=>new Promise(resolve=>setTimeout(resolve,2));
 /** Lets the fetch, the worker and the merge run, rendering and running effects after each step, until task settled. */
 const run=async task=>{let done=false;void task.then(()=>{done=true;});for(let step=0;step<200&&!done;step++){await tick();render();runEffects();}assert.ok(done,'the refresh settles');await tick();render();runEffects();};
 const messages=type=>ports.flatMap(port=>port?port.sent.map(entry=>entry.message):[]).filter(message=>message.type===type);
 return {render,runEffects,tick,run,updates,answers,timers,ports,reads,fetched,messages,cells,get result(){return result;},unmount:()=>{for(const cleanup of cleanups.splice(0))cleanup();},
  /** Mounts the hook and lets its first refresh settle. */
  async mount(){render();runEffects();for(let step=0;step<200&&!(result.data||result.error);step++){await tick();render();runEffects();}},
  /** The poll of the jobs (its interval is the last one the hook started). */
  poll:()=>timers.at(-1)()};
}
// The cells of useConsoleData: data, error, loading, checkedAt, shown (in this order).
const dataCell=0,checkedCell=3;
{
 const harness=await hookHarness(),{updates,answers}=harness;
 const answer={viewer:{id:'u1'},servers:[{id:'a',name:'A'}],jobs:[{id:'j1',state:'running',serverId:'a'}],deviceGroups:[],customers:[]};
 answers.push(answer);
 harness.render();harness.runEffects();
 ok(harness.ports.length===0,'the payload worker starts lazily: not before the first answer is there');
 // The first refresh: its data, error, checkedAt and loading update inside one transition; the refresh resolves after
 // the console rendered it (the effect of its commit). The fetch, the worker and the merge take a few tasks.
 for(let step=0;step<100&&!updates.some(update=>update.cell===dataCell);step++)await harness.tick();
 const transitionUpdates=updates.filter(update=>update.transition);
 ok(updates.some(update=>update.cell===dataCell&&update.transition),'the refresh sets the data inside startTransition');
 ok(!updates.some(update=>update.cell===dataCell&&!update.transition),'… and never outside it');
 ok(transitionUpdates.length>=4,'error, freshness and loading change in the same transition');
 harness.render();harness.runEffects();
 ok(harness.result.data.servers[0].id==='a'&&typeof harness.result.checkedAt==='number','the hook shows the data and its freshness');
 check([harness.reads,harness.ports.length,harness.messages('seed').length,harness.messages('parse').length],[{readApiJson:0,json:0,arrayBuffer:1,blob:0},1,1,0],'the first load reads the bytes, parses them here as before and seeds one worker with them');
 ok(harness.ports[0].sent.find(entry=>entry.message.type==='seed').transfer.length===1,'… transferred, not copied');
 // The jobs poll (a job runs): its merge also updates inside startTransition and keeps the servers.
 const shown=harness.result.data;
 answers.push({jobs:[{id:'j1',state:'succeeded',serverId:'a'}],viewer:{id:'u1'}});
 const poll=harness.timers.at(-1);
 // The refresh resolved after its commit (the effect above); the poll waits for a refresh in flight.
 await new Promise(resolve=>setImmediate(resolve));
 updates.length=0;
 await poll();
 await new Promise(resolve=>setImmediate(resolve));
 ok(updates.length>0&&updates.every(update=>update.transition),'the jobs poll sets its state inside startTransition');
 harness.render();
 ok(harness.result.data.servers===shown.servers&&harness.result.data.jobs[0].state==='succeeded','the poll keeps the servers by identity and shows the new job state');
 // The worker takes the same step, so the next refresh's patch fits; an equal answer then sets no data.
 const step=harness.messages('jobs');
 ok(step.length===1&&step[0].base===1,'the jobs poll sends its jobs and viewer to the worker, on the version of the shown data');
 answers.push({...answer,jobs:[{id:'j1',state:'succeeded',serverId:'a'}]});
 updates.length=0;const polled=harness.result.data;
 await harness.run(harness.result.refresh(true));
 ok(harness.result.data===polled&&!updates.some(update=>update.cell===dataCell),'refresh, jobs poll, refresh with an equal answer: the data keeps its object and is not set');
 ok(updates.some(update=>update.cell===checkedCell&&update.transition)&&updates.every(update=>update.cell!==dataCell),'… only the freshness (inside a transition), error, loading and the commit counter update');
 check(harness.messages('parse').at(-1).base,step[0].id,'… and the worker diffed against the version after the poll');
 harness.unmount();
 ok(harness.ports[0].terminated,'the worker ends when the console unmounts');
}
// Refreshes through the worker: changed and unchanged answers, sequences, 401, non-ok and invalid answers.
{
 const harness=await hookHarness(),{updates,answers}=harness;
 const device=(id,lastSeen)=>({id,name:id.toUpperCase(),lastSeen,snapshot:{cpu:5,memory:10,networks:[{name:'eth0',addresses:['10.0.0.1']}],disks:[{name:'C:',freeGb:20}]}});
 const base={viewer:{id:'u1'},servers:['a','b','c'].map(id=>device(id,1)),jobs:[{id:'j1',state:'running',serverId:'a'}],deviceGroups:[{id:'g1',name:'G'}],customers:[{id:'c1',name:'C'}],audit:[]};
 answers.push(clone(base));
 await harness.mount();
 ok(jsonEqual(harness.result.data,base),'the first load through the worker shows the answer');
 // A heartbeat: every device changed; the data is set inside a transition, the devices are new, their lists are kept.
 const before=harness.result.data,heartbeat={...clone(base),servers:clone(base.servers).map(server=>({...server,lastSeen:2,snapshot:{...server.snapshot,cpu:7}}))};
 answers.push(heartbeat);updates.length=0;
 await harness.run(harness.result.refresh(true));
 const after=harness.result.data;
 ok(jsonEqual(after,heartbeat),'a changed answer: the shown data equals it');
 ok(updates.some(update=>update.cell===dataCell&&update.transition)&&!updates.some(update=>update.cell===dataCell&&!update.transition),'… set inside startTransition');
 ok(after.servers.every((server,index)=>server!==before.servers[index]&&server.snapshot.networks===before.servers[index].snapshot.networks),'… every device is new and keeps its unchanged lists');
 ok(after.jobs===before.jobs&&after.deviceGroups===before.deviceGroups&&after.customers===before.customers,'… jobs, groups and customers keep their identity');
 check(harness.reads,{readApiJson:0,json:0,arrayBuffer:1,blob:1},'… read as a Blob: no json(), arrayBuffer() or readApiJson on the main thread (only the first load read bytes)');
 // await refresh(true) resolves only after the data is committed (the effect of the render).
 const next={...clone(heartbeat),servers:clone(heartbeat.servers).map((server,index)=>index===1?{...server,lastSeen:3}:server)};
 answers.push(next);
 let resolved=false;void harness.result.refresh(true).then(()=>{resolved=true;});
 for(let step=0;step<100&&!updates.some(update=>update.cell===dataCell&&harness.cells[dataCell].value.servers[1].lastSeen===3);step++)await harness.tick();
 await harness.tick();
 ok(!resolved,'await refresh(true) waits while the new data is not committed');
 harness.render();harness.runEffects();await harness.tick();
 ok(resolved&&harness.result.data.servers[1].lastSeen===3,'… and resolves after its commit');
 ok(harness.result.data.servers[0]===after.servers[0]&&harness.result.data.servers[2]===after.servers[2],'one changed device: the others keep their object');
 // A jobs poll dropped because a refresh started while it ran: the worker gets no jobs step, the refresh's patch fits.
 let releasePoll;answers.push(new Promise(resolve=>{releasePoll=resolve;}));
 const polling=harness.poll();
 const fresh={...clone(next),servers:clone(next.servers).map((server,index)=>index===2?{...server,lastSeen:4}:server)};
 answers.push(fresh);
 const refreshing=harness.result.refresh(true);
 await harness.tick();
 releasePoll({jobs:[{id:'j1',state:'failed',serverId:'a'}],viewer:{id:'u1'}});
 await polling;
 await harness.run(refreshing);
 ok(harness.fetched.filter(url=>url.includes('jobsOnly')).length===1&&harness.messages('jobs').length===0&&jsonEqual(harness.result.data,fresh),'a jobs poll dropped by a newer refresh changes nothing, and the refresh shows its answer');
 // 401: the shown data is reset; the next refresh is a full load (no base).
 const parsesBefore=harness.messages('parse').length;
 answers.push({status:401,body:{error:'locked'}});
 await harness.run(harness.result.refresh(true));
 ok(harness.result.data===null&&harness.result.error==='error'&&harness.messages('parse').length===parsesBefore,'a 401 answer is read on the main thread (readApiJson) and resets the data');
 check([harness.reads.readApiJson,harness.reads.json],[1,1],'… which reads it with json()');
 answers.push(clone(base));
 await harness.run(harness.result.refresh(true));
 ok(harness.messages('seed').length===2&&harness.messages('parse').length===parsesBefore&&jsonEqual(harness.result.data,base)&&harness.result.error==='','the refresh after a 401 is a full load again (parsed here, seeding the worker anew)');
 // Another error status: read on the main thread, the data stays.
 const kept=harness.result.data;
 answers.push({status:500,body:{error:'boom'}});
 await harness.run(harness.result.refresh(true));
 ok(harness.result.data===kept&&harness.result.error==='error'&&harness.reads.readApiJson===2,'a 500 answer is read with readApiJson and keeps the data');
 // Invalid JSON in an ok answer: the worker reports it and the console shows common.invalidApiReply.
 answers.push({status:200,body:'{"servers":['});
 await harness.run(harness.result.refresh(true));
 ok(harness.result.data===kept&&harness.result.error==='common.invalidApiReply'&&harness.reads.readApiJson===2,'invalid JSON gives the invalid-reply error through the worker');
 // A refresh after the failed one: the base is still right, an equal answer sets no data and clears the error.
 answers.push(clone(base));updates.length=0;
 await harness.run(harness.result.refresh(true));
 ok(harness.result.data===kept&&harness.result.error===''&&!updates.some(update=>update.cell===dataCell)&&harness.messages('parse').at(-1).base!==null,'a refresh after a failed one diffs against the shown data');
 check(harness.ports.length,1,'one worker for the console');
 harness.unmount();
}
// Fallback: a worker that fails, a worker that fails later, no Worker.
{
 const answer={viewer:{id:'u1'},servers:[{id:'a',name:'A',lastSeen:1},{id:'b',name:'B',lastSeen:1}],jobs:[],deviceGroups:[],customers:[]};
 const moved={...clone(answer),servers:[{id:'a',name:'A',lastSeen:2},{id:'b',name:'B',lastSeen:1}]};
 const broken=await hookHarness({worker:'broken'});
 broken.answers.push(clone(answer));
 await broken.mount();
 ok(jsonEqual(broken.result.data,answer)&&broken.result.error==='','a worker that fails: the refresh shows its answer, read on the main thread, with no error');
 // The data is there before the worker's error event for the seed: mount stops at the data, so wait for the worker
 // itself rather than for a number of tasks, which made this check depend on the speed of the machine.
 await broken.ports[0].idle();broken.render();
 check([broken.reads,broken.ports[0].terminated],[{readApiJson:0,json:0,arrayBuffer:1,blob:0},true],'… (the first load is parsed here anyway), and the worker is ended');
 const shownBroken=broken.result.data;
 broken.answers.push(clone(moved));
 await broken.run(broken.result.refresh(true));
 ok(jsonEqual(broken.result.data,moved)&&broken.result.data.servers[1]===shownBroken.servers[1],'… the next refresh too, merged by identity (mergeConsoleDataInSlices)');
 check([broken.ports.length,broken.messages('parse').length,broken.reads],[1,0,{readApiJson:1,json:1,arrayBuffer:1,blob:0}],'… without a new worker or message: readApiJson on the main thread for good');

 const later=await hookHarness();
 later.answers.push(clone(answer));
 await later.mount();
 const shownLater=later.result.data;
 later.ports[0].broken=true;
 later.answers.push(clone(moved));
 await later.run(later.result.refresh(true));
 ok(later.ports[0].terminated&&jsonEqual(later.result.data,moved)&&later.result.data.servers[1]===shownLater.servers[1]&&later.result.error==='','a worker that fails during a refresh: that refresh still shows its answer');
 later.answers.push(clone(answer));
 await later.run(later.result.refresh(true));
 ok(jsonEqual(later.result.data,answer)&&later.messages('parse').length===1&&later.reads.readApiJson===2&&later.reads.blob===1,'… and every later one is read on the main thread');

 // A patch for another base is never applied: the worker's full answer is merged instead, by identity.
 const stale=await hookHarness({worker:'stale'});
 stale.answers.push(clone(answer));
 await stale.mount();
 const shownStale=stale.result.data;
 stale.answers.push(clone(moved));
 await stale.run(stale.result.refresh(true));
 ok(jsonEqual(stale.result.data,moved)&&stale.result.data.servers[1]===shownStale.servers[1]&&stale.messages('full').length===1,'a patch for another base: the console asks for the full answer and merges it');
 check([stale.reads.readApiJson,stale.ports.length],[0,1],'… in the worker, not on the main thread');
 const misfit=await hookHarness({worker:'misfit'});
 misfit.answers.push(clone(answer));
 await misfit.mount();
 const shownMisfit=misfit.result.data;
 misfit.answers.push(clone(moved));
 await misfit.run(misfit.result.refresh(true));
 ok(jsonEqual(misfit.result.data,moved)&&misfit.result.data.servers[1]===shownMisfit.servers[1]&&misfit.result.error===''&&misfit.messages('full').length===1,'a patch that does not fit the shown data is not applied: the full answer is merged instead');

 // Invalid JSON in the first load: the same error text; the next answer is a first load again.
 const invalid=await hookHarness();
 invalid.answers.push({status:200,body:'<html>'});
 await invalid.mount();
 ok(invalid.result.data===null&&invalid.result.error==='common.invalidApiReply','invalid JSON in the first load gives the invalid-reply error');
 invalid.answers.push(clone(answer));
 await invalid.run(invalid.result.refresh(true));
 ok(jsonEqual(invalid.result.data,answer)&&invalid.result.error===''&&invalid.messages('seed').length===2&&invalid.messages('parse').length===0,'… and the next refresh is a first load again');

 const none=await hookHarness({worker:'none'});
 none.answers.push(clone(answer));
 await none.mount();
 none.answers.push(clone(moved));
 await none.run(none.result.refresh(true));
 ok(jsonEqual(none.result.data,moved)&&none.ports.length===1&&none.reads.readApiJson===2&&none.reads.json===2&&none.reads.blob===0,'without Worker every refresh is read with readApiJson, and no worker start is tried again');
}

// ---- 6. EntranceList ----
{
 consoleClock.set(T0);
 const rows=Array.from({length:12},(_,index)=>({id:'r'+index,name:'Row '+index}));
 const columns=[{id:'name',label:'Name',primary:true,cell:row=>row.name}];
 const table=list=>h(LocaleProvider,{locale:'en'},h(DataTable,{columns,rows:list,rowKey:row=>row.id,label:'Rows',empty:{icon:()=>null,title:'None'},entranceId:'memo-entrance-rows'}));
 const renderer=memoRenderer();
 renderer.render(table(rows));await renderer.flush();
 const entering=()=>renderer.elements().filter(element=>element.type==='tr'&&String(element.props.className).includes('sdx-enter')).length;
 check(entering(),8,'the first load lifts the first 8 rows');
 await new Promise(resolve=>setTimeout(resolve,800));await renderer.flush();
 check(entering(),0,'after the entrance the classes are gone');
 renderer.resetRenders();
 renderer.render(table(rows));await renderer.flush();
 check(renderer.renders('DataRow'),0,'a render with the same rows renders no row (EntranceList keeps the memo)');
 renderer.render(table([...rows].reverse()));await renderer.flush();
 check([entering(),renderer.renders('DataRow')],[0,0],'a new order neither replays the entrance nor renders a row');
 const second=memoRenderer();
 second.render(table(rows.slice(0,3)));await second.flush();
 check(second.elements().filter(element=>element.type==='tr'&&String(element.props.className).includes('sdx-enter')).length,0,'a later mount with the same id does not play it again (once per page load)');
 renderer.unmount();second.unmount();
}

// ---- 7. Source checks: the size estimate of an off-screen device card, comments ----
{
 const sheet=postcss.parse(read('ui/styles/console.css'));
 const declsOf=selector=>{const decls={};sheet.walkRules(rule=>{if(rule.selector===selector&&rule.parent.type==='root')rule.walkDecls(decl=>{decls[decl.prop]=decl.value;});});return decls;};
 const card=declsOf('.sdx-device-card'),customer=declsOf('.sdx-device-card:has(> .sdx-device-card-customer)'),meters=declsOf('.sdx-device-card-meters');
 const root={};postcss.parse(read('app/globals.css')).walkRules(rule=>{if(rule.selector===':root')rule.walkDecls(/^--sd-space-/,decl=>{root[decl.prop]=decl.value;});});
 ok(['pad','gap','header','status','meter-row','footer','customer'].every(name=>card['--sdx-card-'+name]),'the card declares --sdx-card-* properties for padding, gap, header, status, a meter row, footer and the customer line');
 check([card['--sdx-card-gap'],card.padding,card.gap,meters.gap],['var(--sd-space-3)','var(--sdx-card-pad)','var(--sdx-card-gap)','var(--sdx-card-meter-gap)'],'the gap is --sd-space-3; the card\'s padding and gap (and the meter gap) read the card properties');
 const estimate=card['contain-intrinsic-size'];
 ok(/^auto calc\(/.test(estimate)&&!/232px/.test(estimate),`the estimate is auto calc(…), no fixed 232px: ${estimate}`);
 ok((estimate.match(/\d*\.?\d+px/g)??[]).every(literal=>literal==='1px')&&(estimate.match(/var\(([^)]+)\)/g)??[]).every(reference=>/^var\(--sdx-card-[a-z-]+\)$/.test(reference))&&/^[\sa-z0-9()+*\-.,]*$/.test(estimate.replace(/var\(--sdx-card-[a-z-]+\)/g,'')),'the estimate uses only --sdx-card-* properties, counts and the 1px borders');
 // Resolves the var() references against the card (and, for the customer card, its rule) and globals.css, then the calc().
 const resolve=(value,scope)=>{let text=value,guard=0;while(/var\(/.test(text)&&guard++<20)text=text.replace(/var\((--[a-z0-9-]+)\)/g,(_,name)=>{const found=scope[name]??root[name];assert.ok(found!==undefined,`${name} is defined`);return `(${found})`;});return text;};
 const px=(value,scope=card)=>{const text=resolve(value,scope).replace(/^auto\s+/,'').replace(/calc\(/g,'(').replace(/(\d*\.?\d+)px/g,'$1');assert.ok(/^[\d\s.+\-*/()]+$/.test(text),`resolvable: ${text}`);return Function(`return ${text}`)();};
 const plain=px(estimate),withCustomer=px(estimate,{...card,...customer});
 check([px(card.padding),px(card.gap),px(meters.gap)],[14,12,8],'the rendered spacing stays: padding 14px, gap 12px, meter gap 8px');
 ok(plain>=200&&plain<=280,`the estimate of a card without the customer line is ${plain}px (200–280px; rendered 234.25px at 1440x900)`);
 ok(customer['--sdx-card-customer-space']==='calc(var(--sdx-card-customer) + var(--sdx-card-gap))'&&withCustomer-plain===px('var(--sdx-card-customer)')+px('var(--sdx-card-gap)'),`a card with the customer line is estimated larger by the line and one gap: ${withCustomer}px`);
 // The doc comment of each menu function sits directly above it, once.
 const kitLines=read('ui/kit/kit.tsx').split('\n');
 const docAbove=name=>{const index=kitLines.findIndex(line=>line.startsWith(`function ${name}(`));return {doc:kitLines[index-1],before:kitLines[index-2]};};
 const lazy=docAbove('LazyMenuEntries'),entries=docAbove('menuEntries');
 ok(entries.doc==='/** The elements of the entries of a menu or submenu (a plain function, so the items sit in the menu\'s own tree). */'&&!/\*\/\s*$/.test(entries.before),'kit.tsx: the menuEntries comment sits directly above function menuEntries, as its only doc comment');
 ok(/^\/\*\* The entries of a menu whose entries are a function: .*\*\/$/.test(lazy.doc)&&!/\*\/\s*$/.test(lazy.before),'kit.tsx: the LazyMenuEntries comment sits directly above function LazyMenuEntries, as its only doc comment');
 const memoSource=read('tests/support/memo-renderer.mjs');
 ok(memoSource.split('\n')[0].includes('components of ui/')&&!memoSource.includes('components of app/'),'memo-renderer.mjs says it runs the components of ui/');
}

console.log(`PASS workspace render performance (${checks} checks): one clock store with selector subscribers, the identity-keeping merge of refreshes and jobs polls, a console that renders only when a console-level clock value changes, prototype keys kept out of merged objects, memoized fleet rows, device cards and tree rows (ticks, refreshes, selection, expand, focus, drag, menu, a removed device with its menu dropped), a card size estimate from the card's own spacing, refresh and poll updates as transitions, refreshes through the payload worker with its fallback, and an entrance that plays once.`);
