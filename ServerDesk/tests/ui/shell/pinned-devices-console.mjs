// Pinned devices in the running console (ui/shell/console.tsx with tests/support/console-harness.mjs, ui/shell/pin-toggle.ts):
// the console hands the loaded pins and the customer logos to the tree, the fleet and the device view; a toggle shows
// at once (optimistic), sends PUT /api/account/pinned-devices, takes the answer and toasts; a refusal restores the set
// from before with toast.error; a second toggle of the same device waits for the first; the tree actions pin and unpin;
// the palette lists the pins first in the group Pinned (not again under Devices) and offers Pin device / Unpin device
// on the device view; sample devices have no pins. The fleet row menu entry and its demo block come from fleetRowMenu.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {consoleHarness} from '../../support/console-harness.mjs';
const {filterPaletteItems}=await import('../../../ui/shell/command-palette.tsx');
const {fleetRowMenu}=await import('../../../ui/devices/fleet/fleet.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
const {pinToggle}=await import('../../../ui/shell/pin-toggle.ts');

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const now=Date.now();
const device=(id,name,snapshot=null)=>({id,name,createdAt:now-3600000,lastSeen:now-30000,revoked:0,management:1,snapshot,permissions:['view'],groupId:null,groupName:null,groups:[]});
const servers=[device('a1','ALPHA-01'),device('b1','BETA-01',{os:'Microsoft Windows Server 2022',security:{domainJoined:true,domainRole:5,rdpEnabled:false,firewall:[],defender:{available:true,enabled:true,signatureAt:'',realTimeProtection:true},lastBoot:''}}),device('c1','CHARLIE-01')];
const logo={light:{url:'/api/branding/asset/c',contentType:'image/png',width:64,height:64,size:1,updatedAt:1},dark:null};
const branding={portal:{light:null,dark:null,icon:null},customers:{cX:logo},consoleBackground:null,scheme:null};
const owner={id:'owner',label:'owner@example.test',permissions:['*']};
const base={servers,jobs:[],deviceGroups:[],permissionDevices:[],customers:[],audit:[],deviceAudit:[],maintenance:null,branding,preferences:{consoleBackground:true,pinnedDeviceIds:['c1','b1']}};
const harness=async(hash='#devices',data)=>{const ui=consoleHarness({viewer:owner,hash,base,data});await ui.settle();return ui;};
const pinPosts=ui=>ui.posts.filter(post=>post.url==='/api/account/pinned-devices').map(post=>post.body);
// The PUT leaves in a microtask after the toggle (behind the queue of its device).
const microtasks=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const answer=ids=>Response.json({pinnedDeviceIds:ids});
const de=key=>translate('de',key);
// The harness names lucide icons by string; the device type glyphs come from the real lucide-react.
const iconName=Icon=>typeof Icon==='string'?Icon:Icon?.displayName??Icon?.render?.displayName;

// ---- the console hands the pins and the customer logos on ----
{
 const ui=await harness();
 check([ui.inventory().props.pinnedIds,ui.inventory().props.customerLogos,ui.fleet().props.pinnedIds,typeof ui.fleet().props.onPin],[['c1','b1'],{cX:logo},['c1','b1'],'function'],'tree and fleet get the loaded pins, the tree the customer logos');

 // The palette: the pins first, by name, in the group Pinned, not again under Devices; the type glyph as icon.
 const items=ui.find('CommandPalette').props.getItems();
 check(items.slice(0,2).map(item=>[item.id,item.group,item.label,iconName(item.Icon)]),[['device-b1',de('pins.title'),'BETA-01','Network'],['device-c1',de('pins.title'),'CHARLIE-01','MonitorSmartphone']],'pinned devices first, by name, in the group Pinned');
 check(items.filter(item=>item.id.startsWith('device-')&&item.group===de('palette.group.devices')).map(item=>item.id),['device-a1'],'not again under Devices');
 const searched=filterPaletteItems(items,'charlie','de');
 check(searched.slice(0,1).map(item=>[item.id,item.group]),[['device-c1',de('pins.title')]],'with a query a pin keeps the group Pinned');
 ok(!items.some(item=>item.id==='device-pin'),'no pin action outside the device view');

 // Optimistic pin: the set changes at once, then the PUT; the answer replaces it and a toast confirms.
 const pending=deferred();ui.state.reply=()=>pending.promise;
 ui.fleet().props.onPin('a1');ui.render();
 check([ui.inventory().props.pinnedIds,ui.fleet().props.pinnedIds],[['c1','b1','a1'],['c1','b1','a1']],'the new pin shows at once');
 await microtasks();
 check(pinPosts(ui),[{deviceId:'a1',pinned:true}],'one PUT with exactly {deviceId, pinned}');
 pending.resolve(answer(['b1','c1','a1']));await ui.settle();
 check(ui.inventory().props.pinnedIds,['b1','c1','a1'],'the server answer replaces the set');
 check(ui.toasts.splice(0),[de('pins.pinned')],'"Device pinned." after success');

 // A second toggle of the same device waits for the first request.
 const first=deferred(),second=deferred(),replies=[first.promise,second.promise];ui.state.reply=()=>replies.shift();
 ui.fleet().props.onPin('a1');ui.render();
 ui.fleet().props.onPin('a1');ui.render();
 check(ui.inventory().props.pinnedIds,['b1','c1','a1'],'unpin then pin again: shown at once');
 await microtasks();
 check(pinPosts(ui).slice(1),[{deviceId:'a1',pinned:false}],'the second request waits');
 first.resolve(answer(['b1','c1']));await ui.settle();
 check(pinPosts(ui).slice(1),[{deviceId:'a1',pinned:false},{deviceId:'a1',pinned:true}],'then it runs');
 second.resolve(answer(['b1','c1','a1']));await ui.settle();
 check([ui.inventory().props.pinnedIds,ui.toasts.splice(0)],[['b1','c1','a1'],[de('pins.unpinned'),de('pins.pinned')]],'both settle in order with their toasts');

 // A refusal restores the set from before the toggle and shows the error.
 ui.state.reply=()=>Response.json({error:'limit',code:'INVALID_REQUEST',messageKey:'apiError.account.pinLimit',params:{max:20}},{status:400});
 ui.inventory().props.onAction('unpin',{type:'device',id:'c1',name:'CHARLIE-01'});ui.render();
 check(ui.inventory().props.pinnedIds,['b1','a1'],'the unpin shows at once');
 await ui.settle();
 check(ui.inventory().props.pinnedIds,['b1','c1','a1'],'rolled back after the refusal');
 check(ui.errors().length,1,'toast.error with the message');ui.toasts.splice(0);

 // The tree actions: pin only an unpinned device, unpin only a pinned one.
 const before=pinPosts(ui).length;ui.state.reply=()=>answer(['b1','c1','a1']);
 ui.inventory().props.onAction('pin',{type:'device',id:'b1',name:'BETA-01'});ui.render();await ui.settle();
 check(pinPosts(ui).length,before,'pin of a pinned device: nothing');
 ui.inventory().props.onAction('pin',{type:'device',id:'gone',name:'GONE'});ui.render();await ui.settle();
 check(pinPosts(ui).length,before,'a device that is not in the console: nothing');

 // The next console data shows the stored list again.
 ui.setData({preferences:{consoleBackground:true,pinnedDeviceIds:['a1']}});await ui.settle();
 check(ui.inventory().props.pinnedIds,['a1'],'a data load replaces the kept set');
}

// ---- the device view: the header state and the palette action ----
{
 const ui=await harness('#device/b1');
 check([ui.device().props.pinned,typeof ui.device().props.onPin],[true,'function'],'the device view knows its pin state');
 const action=ui.find('CommandPalette').props.getItems().find(item=>item.id==='device-pin');
 check([action.group,action.label,action.keywords,action.Icon],['BETA-01',de('pins.unpin'),de('pins.keywords'),'PinOff'],'Unpin device for a pinned device, with the pin keywords');
 ui.state.reply=()=>answer(['c1']);
 action.run();ui.render();await ui.settle();
 check([pinPosts(ui),ui.device().props.pinned],[[{deviceId:'b1',pinned:false}],false],'the palette action unpins');
 check(ui.find('CommandPalette').props.getItems().find(item=>item.id==='device-pin').label,de('pins.pin'),'then it offers Pin device');
 ui.state.reply=()=>answer(['c1','b1']);
 ui.device().props.onPin();ui.render();await ui.settle();
 check([pinPosts(ui).at(-1),ui.device().props.pinned],[{deviceId:'b1',pinned:true},true],'the header toggle pins');
}

// ---- sample devices have no pins ----
{
 const ui=await harness();
 ui.find('CommandPalette').props.getItems().find(item=>item.id==='action-demo').run();ui.render();await ui.settle();
 check([ui.inventory().props.pinnedIds,ui.inventory().props.customerLogos,ui.fleet().props.pinnedIds],[undefined,undefined,undefined],'demo mode: no pins and no customer logos');
 ui.fleet().props.onPin('a1');ui.render();await ui.settle();
 check(pinPosts(ui),[],'demo mode sends nothing');
}

// ---- the fleet row menu: Pin device after Open, blocked for sample devices ----
{
 const t=(key,params)=>translate('en',key,params),noop=()=>{};
 const menu=pin=>fleetRowMenu({restart:{onSelect:noop},pin,onOpen:noop},t);
 check(menu({pinned:false,onSelect:noop}).slice(0,2).map(entry=>[entry.id,entry.label,iconName(entry.icon)]),[['open','Open','ChevronRight'],['pin','Pin device','Pin']],'Pin device right after Open');
 check(menu({pinned:true,onSelect:noop})[1].label,'Unpin device','a pinned device: Unpin device');
 check(menu({pinned:false,blocked:t('kit.unavailable.demo'),onSelect:noop})[1].blocked,'Not available for sample devices.','sample devices: blocked with the demo reason');
 check(menu(undefined).map(entry=>entry.id).includes('pin'),false,'without the pin action no entry');
}

// ---- pinToggle on its own: a failure restores the set from before ----
{
 let shown=['x'];const done=[],failed=[];
 const pins=pinToggle({read:()=>shown,write:ids=>{shown=[...ids];},save:async(id,pinned)=>{if(id==='bad')throw new Error('refused');return pinned?[...shown]:shown.filter(item=>item!==id);},done:pinned=>done.push(pinned),failed:failure=>failed.push(failure.message)});
 const run=pins.toggle('y');check(shown,['x','y'],'optimistic');await run;check([shown,done],[['x','y'],[true]],'kept after success');
 const bad=pins.toggle('bad');check(shown,['x','y','bad'],'optimistic before the refusal');await bad;check([shown,failed],[['x','y'],['refused']],'restored with the error');
}

console.log(`PASS pinned devices in the console (${checks} checks): the props, the optimistic toggle with rollback and toasts, the queue, the tree actions, the palette and demo mode.`);
