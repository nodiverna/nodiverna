// The static guards of the palette and Help frame budget (the measurement itself is e2e/overlay-performance.spec.ts).
// 1. Palette rows: PaletteContent runs on harness hook cells with 300 items; it mounts 24 rows at once and the rest in
//    steps after the entrance. A row is the memoized PaletteRow, so React
//    renders it again only when one of its props changes (React.memo's shallow compare under the same key); the test
//    counts those rows per step: ↓ renders 2, a pointer move onto the selected row and a parent render with equal props
//    render none, typing renders only rows whose selection changed. scrollIntoView runs after ↓, never after a pointer
//    selection, and a mousemove at the same position (the list scrolled under the pointer) selects nothing.
// 1b. Palette close and reopen (CommandPalette and PaletteHost on the memo renderer, the kit Dialog as a recording stub):
//    closing (Esc and the scrim through setPalette(false), a chosen entry) renders no row, no PaletteContent, reads no
//    item and runs no filter, the same components for 30 and 300 items; the Dialog hides at once and is torn down after
//    the next paint (afterNextPaint); an opening before that teardown gets a new content (items read again, empty query,
//    first row selected, 24 new rows) and focus in its field. Also the store's opening count, afterNextPaint, and the
//    glass timing of the search surface (glassAfterEntrance) on stubbed elements.
// 2. Console: opening and closing the palette and Help (top-bar search, Ctrl K, F1, ?, the help button, the palette's Help
//    action, Help's close) changes no console state, so RedesignConsole and its body (FleetView) do not render again; the
//    1 s tick keeps the hosts' props.
// 3. CSS: the overlay keyframes move only opacity and transform; no rule of the drawers, dialogs, the palette or Help
//    transitions or animates a layout property, box-shadow or a filter; the dialog blur invariant; reduced motion; the
//    closing Dialog is hidden without an animation; the palette glass blurs only after its entrance.
// No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {postcss} from '../../support/theme-colors.mjs';
import {panelHarness} from '../../support/panel-harness.mjs';
import {consoleHarness} from '../../support/console-harness.mjs';
const hosts=await import('../../../ui/shell/overlay-hosts.tsx');
const paletteModule=await import('../../../ui/shell/command-palette.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>fs.readFileSync(file,'utf8');
const memoType=Symbol.for('react.memo');

// ---- 1. Palette rows ----
{
 const harness=panelHarness({hooked:['ui/shell/command-palette.tsx'],locale:'en'});
 const palette=harness.load('ui/shell/command-palette.tsx');
 const {PaletteContent,PaletteRow}=palette;
 ok(PaletteRow.$$typeof===memoType&&PaletteRow.compare===null,'a row is React.memo with the shallow compare');
 ok(paletteModule.default.$$typeof===memoType,'CommandPalette is memoized');
 const Icon=()=>null,runs=[];
 const items=Array.from({length:300},(_,index)=>({id:'d'+index,group:index<250?'Devices':index<262?'Groups':'Pages',label:`SRV-${String(index).padStart(3,'0')}`,hint:'10.0.0.'+(index%250),Icon,run:()=>runs.push(index)}));
 let closes=0;
 const props={getItems:()=>items,onClose:()=>closes++};
 harness.reset();
 let tree=harness.tree(PaletteContent,props);
 // The rows of a render by item id: the row props and the key of the wrapper that holds the row.
 const rowsOf=node=>{const rows=new Map();for(const wrapper of harness.walk(node).filter(element=>element.type==='div'&&element.props.role==='presentation'&&element.key)){const row=harness.walk(wrapper.props.children).find(element=>element.type===PaletteRow);if(row)rows.set(wrapper.key,row.props);}return rows;};
 // The rows React renders again: new under their key, or with a prop that changed (React.memo's shallow compare).
 const rendered=(before,after)=>[...after].filter(([id,next])=>{const previous=before.get(id);return !previous||Object.keys({...previous,...next}).some(key=>!Object.is(previous[key],next[key]));}).map(([id])=>id);
 let rows=rowsOf(tree);
 check([rows.size,[...rows.keys()].slice(0,2)],[24,['d0','d1']],'opening mounts the first 24 rows, keyed by item id');
 // The rest follows in steps of 48 rows after the entrance (200 ms), each step a short task of its own.
 const sizes=[];
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 for(let round=0;round<12&&rows.size<300;round++){await harness.flush();await wait(rows.size===24?220:5);rows=rowsOf(tree=harness.tree(PaletteContent,props));sizes.push(rows.size);}
 check(sizes,[72,120,168,216,264,300],'the rows follow in steps of 48 until all 300 are mounted');
 ok([...rows].every(([id,row])=>row.item.id===id),'each row sits under the key of its item');
 const step=()=>{const next=rowsOf(tree=harness.tree(PaletteContent,props));const changed=rendered(rows,next);rows=next;return changed;};
 const find=predicate=>harness.find(tree,predicate);
 const listbox=()=>find(node=>node.props.role==='listbox'),root=()=>find(node=>node.props.className==='sd-palette'),field=()=>find(node=>node.type==='input');
 let scrolls=0;
 const list={scrollTop:120,querySelector:selector=>selector==='[aria-selected="true"]'?{scrollIntoView:options=>{scrolls++;check(options,{block:'nearest'},'scrollIntoView keeps the nearest edge');}}:null};
 const attach=()=>{const element=listbox();(element.props.ref??element.ref).current=list;};
 attach();
 await harness.flush();
 check(scrolls,0,'opening scrolls nothing');
 const key=name=>root().props.onKeyDown({key:name,preventDefault(){}});
 const hover=(id,x,y)=>listbox().props.onMouseMove({clientX:x,clientY:y,target:{closest:selector=>selector==='[role="option"]'?{id:'sd-palette-'+id}:null}});

 key('ArrowDown');
 check(step().sort(),['d0','d1'],'↓ renders exactly the row that loses and the row that gains the selection');
 check(rows.get('d1').selected,true,'the second row is selected');
 attach();await harness.flush();
 check(scrolls,1,'after ↓ the selected row scrolls into view');

 check(step(),[],'a render of the palette with equal props renders no row');
 hover('d1',40,200);
 check(step(),[],'the pointer on the selected row renders no row');
 hover('d5',40,240);
 check(step().sort(),['d1','d5'],'the pointer on another row renders the two rows whose selection changed');
 attach();await harness.flush();
 check(scrolls,1,'a pointer selection never scrolls the list');
 // The wheel scrolls the list under a resting pointer: Chrome may send a mousemove at the same position over another row.
 hover('d9',40,240);
 check([step(),rows.get('d5').selected],[[],true],'a mousemove at the same position (scroll only) selects nothing');
 key('ArrowUp');
 check(step().sort(),['d4','d5'],'↑ renders two rows');
 attach();await harness.flush();
 check(scrolls,2,'after ↑ the selected row scrolls into view');

 // Typing filters through filterPaletteItems and starts at the first result; only rows whose selection changed render.
 field().props.onChange({target:{value:'SRV-00'}});
 const typed=step();
 check([rows.size,[...rows.keys()][0]],[10,'d0'],'the query keeps the matching rows');
 check(typed.sort(),['d0','d4'],'a keystroke renders only the rows whose selection changed (the first result, and d4 that held it)');
 check(list.scrollTop,0,'a new query shows the list from its top');
 attach();await harness.flush();
 check(scrolls,2,'typing does not call scrollIntoView');
 field().props.onChange({target:{value:'SRV-005'}});
 check([step(),[...rows.keys()]],[['d5'],['d5']],'a narrower query: the new first row is selected and rendered, nothing else');
 field().props.onChange({target:{value:'SRV-00'}});
 check(step().sort(),['d0','d1','d2','d3','d4','d6','d7','d8','d9','d5'].sort(),'a wider query mounts the rows that come back and moves the selection');
 key('Enter');
 check([closes,runs],[1,[0]],'Enter closes the palette and runs the selected item');
 ok(rows.get('d3').onPick===rows.get('d4').onPick,'every row shares one onPick');
 // ↓ can run ahead of the steps: the selected row is always mounted, so aria-activedescendant names a real option.
 harness.reset();
 tree=harness.tree(PaletteContent,props);
 for(let press=0;press<30;press++){key('ArrowDown');tree=harness.tree(PaletteContent,props);}
 rows=rowsOf(tree);
 check([rows.size,rows.get('d30')?.selected,field().props['aria-activedescendant']],[31,true,'sd-palette-d30'],'↓ past the mounted rows mounts the rows up to the selected one');
 harness.reset();
 rows.get('d3').onPick(rows.get('d3').item);
 check([closes,runs],[2,[0,3]],'a click on a row closes the palette and runs its item');
}

// ---- 1b. Palette close and reopen: constant close, teardown after the paint, a fresh content per opening ----
{
 // The frames of the browser: afterNextPaint (ui/base/after-paint.ts) waits for a requestAnimationFrame and a task after
 // it. The test holds the frames and runs them itself ("the paint").
 const frames=[];
 globalThis.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};
 globalThis.cancelAnimationFrame=id=>{frames[id-1]=null;};
 const paint=async()=>{for(const callback of frames.splice(0))callback?.(performance.now());await new Promise(resolve=>setTimeout(resolve,5));};
 // The kit Dialog stands in as a plain element that records its props: open (radix) and closing (hidden for the user).
 const dialogs=[];
 const Dialog=props=>{dialogs.push({open:props.open,closing:props.closing??false});return props.open?React.createElement('div',{role:'dialog'},props.children):null;};
 const harness=panelHarness({hooked:[],locale:'en',stubs:{'@/ui/kit/confirm-dialog':{Dialog}}});
 const {PaletteHost}=harness.load('ui/shell/overlay-hosts.tsx');
 const {overlayStore}=await import('../../../ui/shell/overlay-store.ts');
 const {memoRenderer}=await import('../../support/memo-renderer.mjs');
 const Icon=()=>null;
 // Items whose label reads are counted: filterPaletteItems reads every label for a query, so no read means no filter run.
 const itemsOf=(count,reads)=>Array.from({length:count},(_,index)=>{const label=`SRV-${String(index).padStart(3,'0')}`;return {id:'d'+index,group:'Devices',get label(){reads.n++;return label;},hint:'10.0.0.'+(index%250),Icon,run(){}};});
 const settle=async renderer=>{for(let round=0;round<20;round++){await new Promise(resolve=>setTimeout(resolve,round?5:230));await renderer.flush();}};
 const shown=renderer=>renderer.elements().filter(element=>element.type?.type?.name==='PaletteRow'||element.type?.name==='PaletteRow').length;
 const content=renderer=>renderer.elements().find(element=>element.type?.name==='PaletteContent');
 const field=renderer=>renderer.elements().find(element=>element.type==='input');
 const closeCommits={};
 for(const count of [30,300]){
  const reads={n:0},items=itemsOf(count,reads);let gets=0;
  const getItems=()=>{gets++;return items;};
  const overlays=overlayStore(),renderer=memoRenderer();
  renderer.render(React.createElement(PaletteHost,{overlays,getItems}));await renderer.flush();
  check([gets,shown(renderer),dialogs.at(-1)],[0,0,{open:false,closing:true}],`${count} items: closed, nothing read or mounted`);
  renderer.resetRenders();overlays.openPalette();await renderer.flush();
  check([gets,renderer.renders('PaletteRow')],[1,24],`${count} items: an opening reads the items once and its first commit renders 24 rows`);
  await settle(renderer);
  check(shown(renderer),count,`${count} items: every row is mounted after the steps`);
  // A query, so a filter run on close would read the labels again.
  field(renderer).props.onChange({target:{value:'srv'}});await renderer.flush();await settle(renderer);
  check(shown(renderer),count,`${count} items: the query "srv" keeps every row`);
  // Esc, the scrim and a chosen entry all close through onOpenChange(false), the store's setPalette.
  reads.n=0;gets=0;renderer.resetRenders();
  overlays.setPalette(false);await renderer.flush();
  const rendered=['PaletteHost','CommandPalette','Dialog','PaletteContent','PaletteRow'].map(name=>[name,renderer.renders(name)]);
  closeCommits[count]=rendered;
  check([renderer.renders('PaletteRow'),renderer.renders('PaletteContent'),gets,reads.n],[0,0,0,0],`${count} items: closing renders no row and no PaletteContent, reads no item and runs no filter`);
  check([dialogs.at(-1),shown(renderer)],[{open:true,closing:true},count],`${count} items: the dialog is hidden at once and keeps its rows until the next paint`);
  await paint();await renderer.flush();
  check([dialogs.at(-1),shown(renderer)],[{open:false,closing:true},0],`${count} items: after the paint the dialog and its rows are torn down in a task of their own`);
  renderer.unmount();
 }
 check(closeCommits[30],closeCommits[300],'the close commit renders the same components for 30 and for 300 items');
 check(closeCommits[300],[['PaletteHost',1],['CommandPalette',1],['Dialog',1],['PaletteContent',0],['PaletteRow',0]],'the close commit renders only the host, the palette and the Dialog');
 // A chosen entry closes the same way: onClose is the store's setPalette(false), then the item runs.
 {
  const reads={n:0},runs=[];const items=itemsOf(30,reads).map((item,index)=>Object.assign(item,{run:()=>runs.push(index)}));
  const overlays=overlayStore(),renderer=memoRenderer();
  renderer.render(React.createElement(PaletteHost,{overlays,getItems:()=>items}));overlays.openPalette();await renderer.flush();
  renderer.resetRenders();
  renderer.elements().find(element=>element.type?.type?.name==='PaletteRow'&&element.props.item.id==='d3').props.onPick(items[3]);await renderer.flush();
  check([runs,overlays.get().palette,renderer.renders('PaletteRow'),renderer.renders('PaletteContent'),dialogs.at(-1)],[[3],false,0,0,{open:true,closing:true}],'a chosen entry closes without a row render and runs its item; the teardown waits for the paint');
  await paint();await renderer.flush();
  check(dialogs.at(-1),{open:false,closing:true},'then the dialog is torn down');
  renderer.unmount();
 }
 // Open, close and open again before the teardown ran (Esc then Ctrl K within one frame).
 {
  const reads={n:0};let gets=0;const items=itemsOf(60,reads);
  const overlays=overlayStore(),renderer=memoRenderer();
  renderer.render(React.createElement(PaletteHost,{overlays,getItems:()=>{gets++;return items;}}));overlays.openPalette();await renderer.flush();await settle(renderer);
  field(renderer).props.onChange({target:{value:'srv-01'}});await renderer.flush();
  const first=content(renderer);
  check([first.key,field(renderer).props.value,shown(renderer)],['1','srv-01',10],'the first opening: its own content, a query, 10 rows');
  // The new opening's field: the palette focuses it itself, since radix focuses only when the dialog mounts.
  const focused=[];const fieldStub={focus:options=>focused.push(options)};
  overlays.setPalette(false);await renderer.flush();
  first.props.fieldRef.current=fieldStub;
  renderer.resetRenders();overlays.openPalette();await renderer.flush();
  const second=content(renderer),rows=renderer.elements().filter(element=>element.type?.type?.name==='PaletteRow');
  check([second.key,gets,field(renderer).props.value,rows.length,rows[0]?.props.selected,rows.some(row=>row.props.selected&&row!==rows[0])],['2',2,'',24,true,false],'a reopening before the teardown gets a new content: the items read again, an empty query, the first row selected, 24 new rows');
  check(dialogs.at(-1),{open:true,closing:false},'the dialog stays mounted and is shown again');
  check(focused,[{preventScroll:true}],'focus moves into the new field without scrolling');
  await paint();await renderer.flush();
  check([dialogs.at(-1),shown(renderer)],[{open:true,closing:false},24],'the cancelled teardown does not close the reopened palette');
  overlays.setPalette(false);await renderer.flush();await paint();await renderer.flush();
  check(dialogs.at(-1),{open:false,closing:true},'its own close tears it down after the paint');
  overlays.openPalette();await renderer.flush();
  check([content(renderer).key,gets,focused.length],['3',3,1],'a later opening after the teardown is a fresh mount: radix focuses its field, the palette does not');
  renderer.unmount();
 }
 // The store counts the openings: only a change from closed to open is a new opening.
 {
  const overlays=overlayStore();
  overlays.openPalette();overlays.openPalette();overlays.setPalette(true);
  const once=overlays.get().paletteOpening;
  overlays.setPalette(false);overlays.toggleHelp(true);overlays.setHelp(false);overlays.openPalette();
  check([once,overlays.get().paletteOpening,overlays.get().palette,overlays.get().help],[1,2,true,false],'paletteOpening grows by one per opening, not per call');
 }
 // afterNextPaint: the work runs in a task after the next frame, never in the caller's task; cancel stops it.
 {
  const {afterNextPaint}=await import('../../../ui/base/after-paint.ts');
  const ran=[];
  afterNextPaint(()=>ran.push('a'));const cancel=afterNextPaint(()=>ran.push('b'));cancel();
  check(ran,[],'nothing runs in the calling task');
  await paint();
  check(ran,['a'],'the work runs after the frame; a cancelled one never runs');
  delete globalThis.requestAnimationFrame;delete globalThis.cancelAnimationFrame;
  afterNextPaint(()=>ran.push('c'),20);
  await new Promise(resolve=>setTimeout(resolve,40));
  check(ran,['a','c'],'without frames (a hidden tab) a timer runs it');
 }
 // The search surface's glass blurs from the end of its entrance on (glassAfterEntrance in the kit Dialog).
 {
  const {glassAfterEntrance}=await import('../../../ui/kit/confirm-dialog.tsx');
  const surface=()=>{const listeners={},attributes=new Set();return {attributes,listeners,hasAttribute:name=>attributes.has(name),setAttribute:name=>attributes.add(name),addEventListener:(type,listener)=>{listeners[type]=listener;},removeEventListener:type=>{delete listeners[type];}};};
  globalThis.matchMedia=()=>({matches:false});
  const animated=surface(),stop=glassAfterEntrance(animated);
  animated.listeners.animationend({target:{}});
  check(animated.attributes.has('data-sdx-entered'),false,'the end of a child animation does not count');
  animated.listeners.animationend({target:animated});
  check(animated.attributes.has('data-sdx-entered'),true,'the end of the surface entrance turns the blur on');
  stop();
  const cancelled=surface();glassAfterEntrance(cancelled);cancelled.listeners.animationcancel({target:cancelled});
  check(cancelled.attributes.has('data-sdx-entered'),true,'a cancelled entrance turns it on too');
  globalThis.matchMedia=()=>({matches:true});
  const reduced=surface();glassAfterEntrance(reduced);
  check([reduced.attributes.has('data-sdx-entered'),Object.keys(reduced.listeners)],[true,[]],'reduced motion (no entrance): the blur is on at once');
  delete globalThis.matchMedia;
  const source=read('ui/kit/confirm-dialog.tsx');
  ok(/const fallback=setTimeout\(mark,1000\)/.test(source),'without an animation event the blur turns on after one second at the latest');
  ok(source.includes('ref={search?glass:undefined}')&&source.includes('{search?<div className="sdx-layer sdx-confirm-scrim" style={scrimPointer} {...closingMark}/>:<DialogPrimitive.Overlay className="sdx-layer sdx-confirm-scrim" {...closingMark}/>}'),'only the search variant uses the glass timing and the plain scrim; every other Dialog keeps the radix overlay with its scroll lock');
 }
}

// ---- 2. Console: the open state lives outside RedesignConsole ----
{
 const owner={id:'u1',label:'ada@example.test',username:'ada',permissions:['*'],identitySource:'local'};
 const now=Date.now();
 const servers=Array.from({length:4},(_,index)=>({id:'s'+index,name:'SRV-0'+index,createdAt:now,lastSeen:now,revoked:0,management:0,snapshot:null}));
 const base={servers,jobs:[],audit:[],deviceGroups:[],customers:[]};
 const open=async media=>{const ui=consoleHarness({viewer:owner,hash:'#devices',base,media});await ui.settle();return ui;};
 for(const media of [[],['(max-width: 900px)']]){
  const width=media.length?'at 900px or narrower':'wide';
  const ui=await open(media);
  const palette=()=>ui.find('CommandPalette'),help=()=>ui.find('HelpPanel'),fleet=ui.fleet();
  ok(ui.find('PaletteHost')&&ui.find('HelpHost'),`${width}: the console renders the two overlay hosts`);
  const steps=[
   ['the top-bar search',()=>ui.find('Topbar').props.onSearch(),()=>palette().props.open,()=>palette().props.onOpenChange(false)],
   ['Ctrl K',()=>ui.shortcuts().palette(),()=>palette().props.open,()=>palette().props.onOpenChange(false)],
   ['F1',()=>ui.shortcuts().help(),()=>help().props.open,()=>ui.shortcuts().help()],
   ['? and the close of Help (Esc from inside, its close button)',()=>ui.shortcuts().help(),()=>help().props.open,()=>help().props.onOpenChange(false)],
   ['the top-bar help button',()=>ui.find('Topbar').props.onHelp(),()=>help().props.open,()=>help().props.onOpenChange(false)],
   ['the Help action of the palette',()=>palette().props.getItems().find(item=>item.id==='action-help').run(),()=>help().props.open,()=>help().props.onOpenChange(false)],
  ];
  for(const [name,show,shown,hide] of steps){
   await ui.settle();
   const renders=ui.renders;
   show();
   check([shown(),ui.dirty],[true,false],`${width}, ${name}: the overlay opens without a console state change`);
   await ui.settle();
   ok(ui.renders===renders&&ui.fleet()===fleet,`${width}, ${name}: RedesignConsole and FleetView do not render again on open`);
   hide();
   await ui.settle();
   check([shown(),ui.renders,ui.fleet()===fleet],[false,renders,true],`${width}, ${name}: closing renders nothing in the console either and keeps FleetView`);
  }
  // The palette and Help close each other through the store (slice 14).
  ui.shortcuts().help();ui.find('Topbar').props.onSearch();
  check([help().props.open,palette().props.open,ui.dirty],[false,true,false],`${width}: the palette closes Help`);
  palette().props.getItems().find(item=>item.id==='action-help').run();
  check([help().props.open,palette().props.open],[true,false],`${width}: the palette's Help action closes the palette`);
  // The 1 s clock (clock-store.ts) does not render the console on a tick that changes none of its clock-derived values;
  // the hosts keep their props in any case.
  const paletteHost=ui.find('PaletteHost').props,helpHost=ui.find('HelpHost').props,renders=ui.renders;
  await ui.tick();
  ok(ui.renders===renders,`${width}: a clock tick that changes no console-level value does not render the console`);
  const nextPalette=ui.find('PaletteHost').props,nextHelp=ui.find('HelpHost').props;
  ok(nextPalette.getItems===paletteHost.getItems&&nextPalette.overlays===paletteHost.overlays,`${width}: the tick keeps getItems and the store by identity, so the memoized PaletteHost does not render`);
  ok(hosts.sameHelpHostProps(helpHost,nextHelp)&&nextHelp.overlays===helpHost.overlays,`${width}: the tick keeps the Help route equal, so the memoized HelpHost does not render`);
  ok(nextPalette.getItems().some(item=>item.id==='device-s1'),`${width}: the stable getItems still reads the console's current items`);
  ui.shortcuts().help();
 }
 ok(hosts.PaletteHost.$$typeof===memoType&&hosts.PaletteHost.compare===null,'PaletteHost is memoized with the shallow compare');
 ok(hosts.HelpHost.$$typeof===memoType&&hosts.HelpHost.compare===hosts.sameHelpHostProps,'HelpHost is memoized and compares the route by value');
 const store={};
 check([hosts.sameHelpHostProps({overlays:store,route:{view:'devices',groupId:'all'}},{overlays:store,route:{view:'devices',groupId:'all'}}),hosts.sameHelpHostProps({overlays:store,route:{view:'devices',groupId:'all'}},{overlays:store,route:{view:'devices',groupId:'g1'}})],[true,false],'a new route of the shown page renders Help again (Help follows the route), an equal one does not');
 // At 900px or narrower the navigator overlay paints above the kit layers, and with a scrim layer open the frame keeps its
 // own pointer-events (see part 3). So a tree action that opens a modal drawer closes the overlay first.
 {
  const groups=[{id:'g1',name:'Berlin',description:'',parentId:null,depth:0,deviceCount:0,permissions:['view','groups.manage']},{id:'g2',name:'Hamburg',description:'',parentId:null,depth:0,deviceCount:0,permissions:['view','groups.manage']}];
  const drawers=[
   ['create-group',{type:'group',id:'g1',name:'Berlin'},ui=>ui.find('GroupCreateDrawer').props.open],
   ['create-group',{type:'global',name:'All devices'},ui=>ui.find('GroupCreateDrawer').props.open],
   ['delete-group',{type:'group',id:'g2',name:'Hamburg'},ui=>!!ui.find('GroupDeleteDrawer').props.group],
   ['manage-group',{type:'group',id:'g1',name:'Berlin'},ui=>!!ui.find('AssignDevicesDrawer').props.group],
  ];
  for(const [action,target,shown] of drawers){
   const ui=consoleHarness({viewer:owner,hash:'#devices',base:{...base,deviceGroups:groups},media:['(max-width: 900px)']});await ui.settle();
   ui.find('Topbar').props.onToggleNavigator();ui.render();await ui.settle();
   check(ui.find('Navigator').props.open,true,`${action} (${target.type}): the overlay is open`);
   ui.inventory().props.onAction(action,target);ui.render();await ui.settle();
   check([shown(ui),ui.find('Navigator').props.open,ui.find('Topbar').props.navigatorOpen],[true,false,false],`${action} (${target.type}) from the tree opens its modal drawer and closes the navigator overlay`);
  }
 }
 // A route change still reaches an open Help through the console.
 const ui=await open([]);
 ui.shortcuts().help();
 await ui.navigateTo('#settings/audit');
 check([ui.find('HelpPanel').props.open,ui.find('HelpPanel').props.route],[true,{view:'settings',page:'audit'}],'Help stays open and follows the route');
 const {topicFor}=await import('../../../ui/shell/help-panel.tsx');
 ok(topicFor({view:'devices'},'en')===topicFor({view:'devices',groupId:'g1'},'en')&&topicFor({view:'devices'},'en')!==topicFor({view:'devices'},'de'),'topicFor translates a topic once per topic and language');
}

// ---- 3. CSS: overlay motion only on transform and opacity ----
{
 const files=['ui/styles/motion.css','ui/styles/console.css','ui/shell/command-palette.css','ui/shell/help-panel.css'];
 const sheets=Object.fromEntries(files.map(file=>[file,postcss.parse(read(file))]));
 // The keyframes of the overlays.
 const overlayKeyframes=['sdx-rise','sdx-fade','sdx-pop','sdx-sheet-in','sdx-sheet-out'],moving=new Set(['opacity','transform','translate','scale']);
 const keyframes={};
 sheets['ui/styles/motion.css'].walkAtRules('keyframes',rule=>{const props=new Set();rule.walkDecls(decl=>props.add(decl.prop));keyframes[rule.params]=[...props];});
 for(const name of overlayKeyframes){ok(keyframes[name]?.length&&keyframes[name].every(prop=>moving.has(prop)),`@keyframes ${name} moves only opacity and transform (${keyframes[name]})`);}
 // The rules of the drawers, dialogs, the palette and Help.
 const scope=/\.sdx-drawer|\.sdx-confirm-|\.sdx-dialog-search|\.sd-palette|\.sd-help|\[data-slot="dialog-(?:content|overlay)"\]|\[data-slot="sheet-overlay"\]|\.sd-detail-drawer/;
 const forbidden=/^(?:all|width|height|inset|top|right|bottom|left|margin(?:-\w+)*|padding(?:-\w+)*|box-shadow|filter|backdrop-filter|-webkit-backdrop-filter|max-height|min-height|max-width|min-width)$/;
 const scoped=[];
 for(const [file,sheet] of Object.entries(sheets))sheet.walkRules(rule=>{if(rule.parent?.type==='atrule'&&/keyframes/.test(rule.parent.name))return;if(scope.test(rule.selector))scoped.push({file,rule});});
 ok(scoped.length>20,'the overlay rules are found');
 const offending=[];
 for(const {file,rule} of scoped)rule.walkDecls(decl=>{
  if(/^transition(?:-property)?$/.test(decl.prop)){
   for(const part of postcss.list.comma(decl.value)){const property=decl.prop==='transition'?postcss.list.space(part)[0]:part.trim();if(forbidden.test(property)||/^\d/.test(property))offending.push(`${file} ${rule.selector}: ${decl.prop}: ${decl.value}`);}
  }
  if(/^animation(?:-name)?$/.test(decl.prop)&&decl.value!=='none'){
   const names=postcss.list.comma(decl.value).map(part=>postcss.list.space(part).find(word=>/^sdx-/.test(word)));
   if(names.some(name=>!overlayKeyframes.includes(name)))offending.push(`${file} ${rule.selector}: ${decl.prop}: ${decl.value}`);
  }
 });
 check(offending,[],'no overlay rule transitions a layout property, box-shadow or a filter, and their animations use only the overlay keyframes');
 // The dialog surface keeps its glass at rest, but the element that fades and rises in carries no backdrop filter
 // while it animates (see the blur invariant below).
 const declsOf=(file,selector)=>{const found={};sheets[file].walkRules(rule=>{if(rule.selector===selector&&rule.parent.type==='root')rule.walkDecls(decl=>{found[decl.prop]=decl.value;});});return found;};
 const dialog=declsOf('ui/styles/console.css','.sdx-confirm-dialog');
 ok(dialog.background==='var(--sd-glass-strong)'&&dialog.border==='1px solid var(--sd-glass-edge)'&&dialog['border-radius']==='var(--sd-radius-lg)'&&dialog['box-shadow']==='var(--sd-shadow-lg)','the dialog keeps its glass surface, edge, radius and shadow');
 // The blur invariant: the dialog's backdrop blur is the 24px of the other glass chrome (the top bar), not larger. While
 // the surface fades and rises in over the fading scrim, the blur is computed again on every frame, and its cost grows
 // with the radius. The palette keeps its glass at rest; command-palette.css does not restyle the surface.
 const blur=value=>Number(/blur\((\d+)px\)/.exec(value??'')?.[1]??NaN);
 const topbar=declsOf('ui/styles/console.css','.sdx-topbar');
 check([blur(dialog['backdrop-filter']),blur(dialog['-webkit-backdrop-filter'])],[24,24],'the dialog blur is 24px, also with the -webkit- prefix');
 ok(blur(dialog['backdrop-filter'])<=blur(topbar['backdrop-filter']),'no dialog blur larger than the top bar glass');
 // The palette (search variant): the surface whose list scrolls has no backdrop filter; its glass is a layer behind the
 // content with the same tint and blur, so a scrolling list does not recompute the blur on every frame.
 const search=declsOf('ui/styles/console.css','.sdx-confirm-dialog.sdx-dialog-search'),glass=declsOf('ui/styles/console.css','.sdx-confirm-dialog.sdx-dialog-search::before');
 check([search['backdrop-filter'],search['-webkit-backdrop-filter'],search.background,search.overflow,search.border,search.padding],['none','none','transparent','hidden','0','1px'],'the palette surface itself carries no backdrop filter or border (a 1px padding in its place) and clips its glass layer');
 check([glass.position,glass.inset,glass['z-index'],glass.background,glass.border,glass['border-radius'],blur(glass['backdrop-filter']),blur(glass['-webkit-backdrop-filter']),glass.animation,glass.transition],['absolute','0','-1','var(--sd-glass-strong)','1px solid var(--sd-glass-edge)','var(--sd-radius-lg)',24,24,undefined,undefined],'the glass layer behind the palette content: the same tint, edge over the tint and 24px blur, never animated');
 ok(/content-visibility: auto/.test(read('ui/shell/command-palette.css')),'rows out of view are skipped for style, layout and paint');
 ok(/sdx-rise var\(--sd-dur\)/.test(dialog.animation),'the dialog entrance stays the short sdx-rise at --sd-dur (180 ms)');
 ok(!/backdrop-filter|sdx-confirm-dialog|sdx-dialog-search/.test(read('ui/shell/command-palette.css')),'command-palette.css does not restyle the dialog surface');
 // Opening and closing a layer must not restyle the whole document (measured with 250 devices):
 // no :has() on the root (every inserted or removed layer node rechecked it) ...
 const rootHas=[];
 for(const [file,sheet] of Object.entries(sheets))sheet.walkRules(rule=>{for(const selector of postcss.list.comma(rule.selector))if(/^(?:html|:root|body)(?![\w-])[^\s>+~]*:has\(/.test(selector.trim()))rootHas.push(`${file} ${selector}`);});
 check(rootHas,[],'no :has() on html, :root or body');
 // ... the scroll lock of radix finds the body values it sets (overflow, position, the scrollbar variable) ...
 const body=declsOf('ui/styles/console.css','html[data-ui="redesign"] body');
 check([body.position,body['--removed-body-scroll-bar-size']],['relative','0px'],'the console body already has the values of the radix scroll lock');
 // ... and the inherited body pointer-events lock of a modal layer with a scrim stops at the console frame.
 check(declsOf('ui/styles/console.css','.sdx[data-sdx-scrim]')['pointer-events'],'auto','with a scrim layer open the frame keeps pointer-events: auto');
 // ... except the chrome that paints above the scrim (z-index over 51): the skip link, and at 900px or narrower the
 // navigator overlay and its scrim stay inert behind a modal layer, as under radix's body lock.
 const zIndex=selector=>{let found;sheets['ui/styles/console.css'].walkRules(rule=>{if(postcss.list.comma(rule.selector).includes(selector))rule.walkDecls('z-index',decl=>{found=Number(decl.value);});});return found;};
 ok(zIndex('.sdx-skip')>51,'the skip link paints above the kit layers');
 check(declsOf('ui/styles/console.css','.sdx-skip[data-sdx-scrim]')['pointer-events'],'none','the skip link stays inert behind a scrim layer');
 const narrow={};sheets['ui/styles/console.css'].walkAtRules('media',rule=>{if(rule.params!=='(max-width: 900px)')return;rule.walkRules(inner=>{if(inner.selector===':is(.sdx-navigator, .sdx-navigator-scrim)[data-sdx-scrim]')inner.walkDecls(decl=>{narrow[decl.prop]=decl.value;});});});
 check(narrow['pointer-events'],'none','at 900px or narrower the navigator overlay and its scrim stay inert behind a scrim layer');
 // The mark styles only the element that carries it: a rule keyed on an ancestor's mark (html[data-sdx-scrim] .sdx) made
 // every opening and closing check each console element against it.
 const scrimSelectors=[];for(const sheet of Object.values(sheets))sheet.walkRules(rule=>{for(const selector of postcss.list.comma(rule.selector))if(selector.includes('data-sdx-scrim'))scrimSelectors.push(selector.trim());});
 check(scrimSelectors.map(selector=>/^[^\s>+~]+\[data-sdx-scrim\]$/.test(selector.replace(/\([^)]*\)/g,'()'))),[true,true,true],'every scrim-mark rule styles the marked element itself, never its descendants');
 // ScrimLayerMark puts the mark on the frame, its skip link and the navigator overlay with its scrim, found by structure.
 {
  const {scrimMarkTargets}=await import('../../../ui/kit/confirm-dialog.tsx');
  const node=(name,children=[])=>({name,classList:{contains:value=>name.split(' ').includes(value)},children});
  const frame=node('sd-console sdx',[node('sdx-toaster'),node('sdx-skip'),node('sdx-topbar',[node('sdx-skip')]),node('sdx-body',[node('sdx-rail'),node('sdx-navigator-scrim open'),node('sdx-navigator open'),node('sdx-workspace',[node('sdx-navigator')])])]);
  const queries=[];
  const targets=scrimMarkTargets({querySelector:selector=>{queries.push(selector);return frame;}});
  check([targets.map(target=>target.name),queries],[['sd-console sdx','sdx-skip','sdx-navigator-scrim open','sdx-navigator open'],['.sdx']],'the frame, its skip link and the navigator overlay with its scrim; one query for the frame, nothing below the workspace');
  check(scrimMarkTargets({querySelector:()=>null}),[],'outside the console nothing is marked');
 }
 // The palette rows that open a group are taller (heading + row), so their placeholder size matches before they are shown.
 const paletteCss=postcss.parse(read('ui/shell/command-palette.css'));
 const sizes={};paletteCss.walkRules(rule=>{rule.walkDecls('contain-intrinsic-size',decl=>{sizes[rule.selector]=decl.value;});});
 check(sizes,{'.sd-palette-results > div':'auto 38px','.sd-palette-results > div:has(> .sd-palette-group)':'auto 67px'},'off-screen rows reserve 38px, rows with a group heading 67px');
 const dialogs=read('ui/kit/confirm-dialog.tsx'),kitSource=read('ui/kit/kit.tsx');
 check([(dialogs.match(/<ScrimLayerMark\/>/g)??[]).length,/\{modal&&<ScrimLayerMark\/>\}/.test(kitSource)],[2,true],'Dialog, ConfirmDialog and the modal Drawer mark their scrim; the non-modal Drawer (Help) does not');
 // Reduced motion: every animated selector of the overlay rules is in the reduced-motion list of motion.css.
 const reduced=new Set();
 sheets['ui/styles/motion.css'].walkAtRules('media',rule=>{if(!/prefers-reduced-motion/.test(rule.params))return;rule.walkRules(inner=>{for(const selector of postcss.list.comma(inner.selector))reduced.add(selector.trim());});});
 const baseOf=selector=>selector.replace(/^html\[data-ui="redesign"\]\s+/,'').replace(/\[data-state="(?:open|closed)"\]$/,'');
 const missing=[];
 for(const {file,rule} of scoped){
  let animated=false;rule.walkDecls(/^animation/,decl=>{if(decl.value!=='none')animated=true;});
  if(!animated||rule.parent?.type==='atrule'&&/prefers-reduced-motion/.test(rule.parent.params))continue;
  for(const selector of postcss.list.comma(rule.selector))if(!reduced.has(baseOf(selector.trim())))missing.push(`${file} ${selector}`);
 }
 check(missing,[],'every animated overlay selector stops under prefers-reduced-motion');
 // The closing Dialog (the palette waiting for its teardown) is hidden at once: visibility only, no animation or
 // transition, and the surface has no closed-state animation, so the palette disappears at once as before.
 const closing=declsOf('ui/styles/console.css','.sdx-confirm-scrim[data-sdx-closing], .sdx-confirm-dialog[data-sdx-closing]');
 check(closing,{visibility:'hidden'},'a closing Dialog only turns invisible');
 const closedAnimations=[];sheets['ui/styles/console.css'].walkRules(rule=>{if(/sdx-confirm-(?:dialog|scrim)[^,]*\[data-state="closed"\]/.test(rule.selector))rule.walkDecls(/^(?:animation|transition)/,decl=>closedAnimations.push(`${rule.selector}: ${decl.value}`));});
 check(closedAnimations,[],'the palette surface and its scrim have no closed-state animation');
 // Until its entrance ends the palette glass has no backdrop blur (the fading surface is a backdrop root, so the blur
 // showed nothing then); at rest the rule above keeps the 24px blur.
 check(declsOf('ui/styles/console.css','.sdx-confirm-dialog.sdx-dialog-search:not([data-sdx-entered])::before'),{'-webkit-backdrop-filter':'none','backdrop-filter':'none'},'the palette glass blurs only after its entrance');
}

console.log(`PASS overlay performance (${checks} checks): memoized palette rows (↓ renders 2, the pointer and equal props none, a keystroke only the changed selection), scrollIntoView only after ↑/↓, a constant palette close with the teardown after the paint and a fresh content per opening, the palette and Help open state outside the console, stable host props across the clock tick, and overlay motion on transform and opacity only.`);
