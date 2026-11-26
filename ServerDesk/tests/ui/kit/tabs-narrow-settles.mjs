// The scope tab bar of the device list (kit Tabs, overflow "menu", in FleetView) settles at phone width. The
// underline bar has 12px right padding without "More" and 4px with it (ui/styles/console.css, ≤900px), so a fit
// measured in the room of the row on screen flipped that room: all tabs fit next to "More" → no "More" → they no
// longer fit → "More" … React stopped it with "Maximum update depth exceeded" (#devices at 390px with the empty fleet
// in German; with the sample devices at 419–426px). Here the real FleetView renders with the memo renderer
// (tests/support/memo-renderer.mjs) and fake host nodes for the bar, its tablist and "More": their geometry follows
// what renders inside them (Chrome's label widths at 13px, the badge per digit, the bar padding by whether "More" is a
// child), and a fake ResizeObserver reports content-box changes. For the sample devices of demoData() and the empty
// fleet, at 390px and every width from 320 to 440px, layout effects and observer callbacks run until nothing is
// pending: at most 10 commits of Tabs, and the stable row is the one that fits; with History open (in "Mehr"), "Mehr"
// shows its label. The pure rule of fittingTabs is in
// tests/ui/kit/kit-tabs.mjs. No browser.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import React from 'react';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const h=React.createElement;
const noop=()=>{};

// Phone width: the 760px (fleet cards) and 900px (console shell) queries match.
const media=['(max-width: 760px)','(max-width: 900px)'];
const stored=new Map();
globalThis.localStorage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,String(value)),removeItem:key=>stored.delete(key)};
globalThis.setInterval=()=>0;globalThis.clearInterval=()=>{};
const frames=[];
globalThis.requestAnimationFrame=callback=>frames.push(callback);
globalThis.cancelAnimationFrame=()=>{};
globalThis.window={matchMedia:query=>({matches:media.includes(query),addEventListener(){},removeEventListener(){}}),addEventListener(){},removeEventListener(){},innerWidth:390,innerHeight:844,
 localStorage:globalThis.localStorage,setTimeout:(...args)=>setTimeout(...args),clearTimeout:timer=>clearTimeout(timer),requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame};

const {memoRenderer}=await import('../../support/memo-renderer.mjs');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {default:FleetView,fleetPanelId}=await import('../../../ui/devices/fleet/fleet.tsx');
const {demoData}=await import('../../../ui/shell/demo.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
// After the imports (sonner adds its style tag when a document exists at import time): radix layers subscribe to document events.
globalThis.document={addEventListener(){},removeEventListener(){},documentElement:{dataset:{},style:{},lang:'de'},body:{style:{}},activeElement:null,querySelector:()=>null,getElementById:()=>null};

// ---- Fake geometry ----
// Label widths in Chrome at 550 13px (the German scope tabs and "Mehr"); other text 6px per character.
const labelWidths={'Geräte':37.91,Monitoring:59.72,Inventar:45.44,Historie:43.88,Konfiguration:75.03,Mehr:28.83};
const textWidth=text=>labelWidths[text]??6*text.length;
const classes=props=>String(props.className??'').split(/\s+/).filter(Boolean);
const textOf=node=>node===null||node===undefined||typeof node==='boolean'?'':typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(textOf).join(''):textOf(node.props?.children);
/** The parts of a tab or of "More": label spans, a tag and a count badge. */
const parts=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(parts):typeof node.type==='string'?[node,...parts(node.props.children)]:parts(node.props?.children);
// .sdx-tabs .sdx-tab: padding 0 8px, gap 7px; the count chip: padding 0 6px, min-width 18px, 6.6px per digit at 11px.
const tabWidth=props=>{
 const children=parts(props.children);
 const label=children.find(node=>node.type==='span'&&!classes(node.props).includes('sdx-tag')),count=children.find(node=>node.type==='b'),tag=children.find(node=>classes(node.props).includes('sdx-tag'));
 const items=[textWidth(textOf(label?.props.children)),...(tag?[16+textWidth(textOf(tag.props.children))]:[]),...(count?[Math.max(18,12+6.6*textOf(count.props.children).length)]:[])];
 return 16+items.reduce((sum,width)=>sum+width,0)+7*(items.length-1);
};
// "More": label and a 14px chevron with the 7px gap.
const moreWidth=props=>16+textWidth(textOf(parts(props.children).find(node=>node.type==='span')?.props.children))+7+14;
const box=width=>({width,height:44,left:0,right:width,top:0,bottom:44,x:0,y:0});
let navWidth=390;
/** The fake nodes: the bar (nav.sdx-tabs), its tablist and the "More" trigger; every other ref stays null. */
function host(view){
 const own=classes(view.props);
 const style=()=>{
  if(own.includes('sdx-tabs')){
   // ≤900px: .sdx-tabs { padding-right: 4px } and .sdx-tabs:not(:has(> .sdx-tabs-more)) { padding-right: 12px }.
   const more=view.descendants().some(node=>classes(node.props).includes('sdx-tabs-more'));
   return {paddingLeft:'0px',paddingRight:more?'4px':'12px',columnGap:'0px'};
  }
  if(own.includes('sdx-tablist'))return {paddingLeft:'12px',paddingRight:'4px',columnGap:'0px'};
  return {paddingLeft:'8px',paddingRight:'8px',columnGap:'7px'};
 };
 if(view.type==='nav'&&own.includes('sdx-tabs'))return {style,get clientWidth(){return navWidth;},getBoundingClientRect:()=>box(navWidth)};
 if(own.includes('sdx-tablist'))return {style,get clientWidth(){return navWidth-12;},scrollLeft:0,scrollTo(){},
  querySelectorAll:selector=>{assert.equal(selector,'[role="tab"]');return view.descendants().filter(node=>node.props.role==='tab').map(node=>({id:node.props.id,tagName:node.type.toUpperCase(),focus(){},getBoundingClientRect:()=>box(tabWidth(node.props))}));},
  getBoundingClientRect:()=>box(navWidth-12)};
 if(own.includes('sdx-tabs-more'))return {style,classList:{contains:name=>classes(view.props).includes(name)},getBoundingClientRect:()=>box(moreWidth(view.props)),focus(){}};
 return null;
}
globalThis.getComputedStyle=node=>node.style();
// ResizeObserver: reports a content-box width that changed since its last report (the first one on observe).
const observers=new Set();
globalThis.ResizeObserver=class{
 constructor(callback){this.callback=callback;this.targets=new Map();}
 observe(target){this.targets.set(target,null);observers.add(this);}
 unobserve(target){this.targets.delete(target);}
 disconnect(){this.targets.clear();observers.delete(this);}
};
const contentWidth=node=>{const style=node.style();return node.clientWidth-Number.parseFloat(style.paddingLeft)-Number.parseFloat(style.paddingRight);};
function deliverResizes(){
 let delivered=false;
 for(const observer of [...observers])for(const [target,last] of observer.targets){
  const width=contentWidth(target);
  if(width===last)continue;
  observer.targets.set(target,width);delivered=true;observer.callback([{target,contentRect:{width}}],observer);
 }
 return delivered;
}

// ---- The device list as the console renders it on All devices (owner, sample devices on) ----
const {servers:samples}=demoData();
const viewer={id:'owner',label:'owner',permissions:['*']};
const panel=name=>h('section',{'data-panel':name});
const fleetProps=(servers,tab)=>({header:null,servers,scoped:servers,groupEmpty:false,viewer,demo:servers.length>0,saving:false,jobs:[],audit:[],tab,onTab:noop,canOffboard:false,onOpen:noop,onConfirm:noop,
 onSelectJob:noop,onCancelJob:noop,onUpdated:noop,onDemo:noop,canMove:false,onMove:noop,customerColumn:false,alerts:panel('alerts'),notifications:panel('notifications'),permissions:panel('permissions')});

/** Renders the device list at a bar width and runs effects, microtasks and observer callbacks until nothing is pending. */
async function settle(servers,width,tab='devices'){
 navWidth=width;frames.length=0;observers.clear();
 const renderer=memoRenderer({host});
 let error=null;
 try{
  renderer.render(h(LocaleProvider,{locale:'de'},h(FleetView,fleetProps(servers,tab))));
  for(let pass=0;;pass++){
   await renderer.flush();
   if(!deliverResizes())break;
   if(pass>=20)throw Error('the resize observer keeps reporting');
  }
 }catch(caught){error=caught;}
 // The scope bar's rendered tabs and its "Mehr" (the pill subtab bar of an open History tab has no fake node, so it
 // never measures and never shows "Mehr" here). commits counts the renders of every Tabs on the page.
 const hosts=renderer.elements().filter(element=>typeof element.type==='string');
 const tabs=hosts.filter(element=>element.props.role==='tab'&&String(element.props.id).startsWith(fleetPanelId+'-tab-')).map(element=>textOf(element.props.children));
 const moreButton=hosts.find(element=>classes(element.props).includes('sdx-tabs-more'));
 const more=!!moreButton,moreLabel=moreButton?textOf(parts(moreButton.props.children).find(node=>node.type==='span')?.props.children):null,moreName=moreButton?.props['aria-label']??null;
 const commits=renderer.renders('Tabs');
 renderer.unmount();
 return {commits,error,tabs,more,moreLabel,moreName};
}
const de=key=>translate('de',key);
const settles=(result,label)=>ok(result.commits<=10&&!result.error,`${label}: settles within 10 commits of Tabs (React's limit is 50); got ${result.commits}${result.error?' and '+result.error.message:''}`);

// ---- At 390px ----
{
 const result=await settle(samples,390);
 settles(result,'sample devices at 390px');
 const count=String(samples.length),alarms=result.tabs[1]?.slice(de('fleet.tabs.monitoring').length)??'';
 check(result.tabs,[`${de('tree.devices')}${count}`,`${de('fleet.tabs.monitoring')}${alarms}`,de('fleet.tabs.inventory')],'sample devices at 390px: Geräte, Monitoring (with the alarm count) and Inventar fit next to "Mehr"');
 ok(/^\d+$/.test(alarms)&&result.more,'sample devices at 390px: Monitoring shows the alarm count of the samples, and "Mehr" holds Historie and Konfiguration');
}
{
 // The empty fleet in German at 390px, before the sample devices are on, looped: Geräte 0, five tabs 367.6px, room 362px without and 370px with "More".
 const result=await settle([],390);
 settles(result,'empty fleet at 390px');
 check(result.tabs,[`${de('tree.devices')}0`,de('fleet.tabs.monitoring'),de('fleet.tabs.inventory'),de('fleet.tabs.history')],'empty fleet at 390px: four tabs fit next to "Mehr", Konfiguration goes into it');
 ok(result.more,'empty fleet at 390px: "Mehr" shows');
}
{
 // The open tab is in "Mehr" (History, route #devices/history): "Mehr" shows its label and still settles.
 const result=await settle(samples,390,'jobs');
 settles(result,'sample devices at 390px with History open');
 check(result.tabs.length,3,'History open at 390px: three tabs fit next to the wider "Mehr"');
 check([result.moreLabel,result.moreName],[de('fleet.tabs.history'),translate('de','kit.tabs.moreActive',{label:de('fleet.tabs.history')})],'History open at 390px: "Mehr" shows "Historie" and names it');
}

// ---- Every phone width from 320 to 440px ----
for(const [name,servers] of [['sample devices',samples],['empty fleet',[]]]){
 const loops=[],shown=new Map();
 for(let width=320;width<=440;width++){
  const result=await settle(servers,width);
  if(result.commits>10||result.error)loops.push(`${width}px (${result.commits} commits${result.error?', '+result.error.message:''})`);
  shown.set(width,result.tabs.length+(result.more?'+':''));
 }
 check(loops,[],`${name}: every bar width from 320 to 440px settles within 10 commits`);
 // The row grows with the width: never fewer tabs on a wider bar, and "Mehr" only while not all five fit.
 const counts=[...shown.values()].map(value=>Number.parseInt(value,10));
 ok(counts.every((count,index)=>index===0||count>=counts[index-1]),`${name}: a wider bar never shows fewer tabs (${[...new Set(shown.values())].join(', ')})`);
 ok([...shown.values()].every(value=>value==='5'||value.endsWith('+')),`${name}: "Mehr" shows whenever a tab is left out`);
}

console.log(`PASS tabs narrow settles (${checks} checks): the device list's scope tabs at 390px and 320–440px, with the sample devices and empty, settle within 10 commits and show the row that fits, "Mehr" with the open tab's label.`);
