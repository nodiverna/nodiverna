import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {i18nRequire} from '../../support/i18n-stubs.mjs';

// Customer folders in the navigator's device tree: flat with fewer than
// two customers, otherwise one collapsible folder per visible customer under "Alle Geräte",
// also an empty one. A folder opens the customer view (onCustomer) and has the customer
// actions and "Add device" in its menu. The node "Ungrouped" holds the loose devices of a
// parent that also has a group: its place, count, selection, route, size rule, keyboard,
// menu and drop rule. A folder shows the customer avatar (CustomerAvatar: the logo when the console passes one, else
// the initials) instead of a building glyph; labels, counts and keys stay.
let checks=0;
const transpile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const Menu=()=>null;
const dragType='application/x-serverdesk-devices';
// The ids of the drag in progress, as fleet.tsx keeps them for dragover.
let dragging=[];

function harness(overrides={}){
 const states=[],effects=[];let cursor=0,tree,dirty=false;
 const calls=[];
 const props={servers:[],filter:'',now:0,onAll:()=>calls.push(['all']),onGroup:id=>calls.push(['group',id]),onDevice:id=>calls.push(['device',id]),onCustomer:id=>calls.push(['customer',id]),onUngrouped:id=>calls.push(['ungrouped',id]),onAction:(action,target)=>calls.push(['action',action,target.name]),canManageGroups:true,canCreateRootGroup:true,canManagePermissions:true,canProvision:true,onMoveDevices:(ids,groupId)=>calls.push(['move',ids,groupId]),canMoveToRoot:true,...overrides};
 const hooks={
  useRef(initial){const index=cursor++;states[index]??={current:initial};return states[index];},
  useState(initial){const index=cursor++;states[index]??={value:typeof initial==='function'?initial():initial};return[states[index].value,value=>{const next=typeof value==='function'?value(states[index].value):value;if(!Object.is(next,states[index].value)){states[index].value=next;dirty=true;}}];},
  useMemo(fn,deps){const index=cursor++,previous=states[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i])))states[index]={deps,value:fn()};return states[index].value;},
  useEffect(fn,deps){const index=cursor++,previous=states[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i])))effects.push(()=>{previous?.cleanup?.();states[index]={deps,cleanup:fn()};});},
 };
 const jsx=(type,props)=>({type,props:props??{}});
 // The tree's rows are memoized (TreeRow): memo marks the type, and the walk below calls a row to read its element.
 // useLayoutEffect runs at once (the tree keeps its latest row handlers in it).
 const react={...hooks,useLayoutEffect:fn=>{fn();},useId:()=>':id:',memo:type=>({$$typeof:Symbol.for('react.memo'),type,compare:null}),createElement:(type,props,...children)=>jsx(type,{...props,children})};
 const load=(file,require)=>{const mod={exports:{}};new Function('require','module','exports',transpile(file))(require,mod,mod.exports);return mod.exports;};
 const base=id=>i18nRequire(id)??(id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:id==='lucide-react'?new Proxy({},{get:(_target,key)=>String(key)}):id.endsWith('.css')?{}:undefined);
 const navigation=load('ui/devices/fleet/inventory-navigation.ts',id=>base(id)??(()=>{throw Error('Unexpected '+id);})());
 const folders=load('ui/devices/fleet/customer-folders.ts',id=>{throw Error('Unexpected '+id);});
 const types=load('ui/devices/device/device-type-model.ts',id=>base(id)??(()=>{throw Error('Unexpected '+id);})());
 const modules={'@/ui/devices/device/device-type-model':types,'@/ui/devices/fleet/customer-avatar':{CustomerAvatar:'CustomerAvatar'},'@/ui/devices/fleet/inventory-navigation':navigation,'@/ui/devices/fleet/customer-folders':folders,'@/ui/kit/kit':{Menu,cx:(...names)=>names.filter(Boolean).join(' ')},'@/ui/devices/fleet/fleet':{deviceDragType:dragType,startDeviceDrag(){},draggedDeviceIds:()=>dragging},'@/ui/base/ui-device':{deviceConnection:()=>null,deviceIssues:()=>[],deviceToneState:()=>''},'@/ui/base/clock-store':{useClockTransition:()=>0}};
 // The default export is memoized; the harness calls the component function itself.
 const InventoryTree=load('ui/devices/fleet/inventory-tree.tsx',id=>base(id)??modules[id]??(()=>{throw Error('Unexpected '+id);})()).default.type;
 const expand=node=>node?.type?.$$typeof===Symbol.for('react.memo')?expand(node.type.type(node.props)):node;
 const walk=input=>{const node=expand(input);return !node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(child=>walk(child))];};
 const nodes=(...node)=>walk(node.length?node[0]:tree);
 function render(){let limit=0;do{dirty=false;cursor=0;tree=InventoryTree(props);for(const effect of effects.splice(0))effect();if(++limit>10)throw Error('Unstable render');}while(dirty);}
 const items=()=>nodes().filter(node=>node.props.role==='treeitem');
 const item=key=>items().find(node=>node.props['data-key']===key);
 const keys=()=>items().map(node=>node.props['data-key']);
 const levels=()=>Object.fromEntries(items().map(node=>[node.props['data-key'],node.props['aria-level']]));
 const event=(extra={})=>({preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...extra});
 const click=key=>{item(key).props.onClick(event());render();};
 const press=(key,value,extra={})=>{const index=items().findIndex(node=>node.props['data-key']===key),e=event({key:value,...extra});item(key).props.onKeyDown(e,index);render();return e;};
 const caret=key=>{const target=nodes(item(key)).find(node=>typeof node.props.className==='string'&&node.props.className.startsWith('sdx-tree-caret'));target.props.onClick(event());render();};
 const iconSlot=key=>nodes(item(key)).find(node=>typeof node.props.className==='string'&&/^sdx-tree-icon(?: |$)/.test(node.props.className));
 const icon=key=>nodes(iconSlot(key)).find(node=>typeof node.type==='string'&&/^[A-Z]/.test(node.type))?.type;
 const avatar=key=>nodes(iconSlot(key)).find(node=>node.type==='CustomerAvatar')?.props;
 const hasMenu=key=>nodes(item(key)).some(node=>node.type===Menu);
 const count=key=>nodes(item(key)).find(node=>node.props.className==='sdx-tree-count')?.props.children;
 const dragEvent=(data)=>{dragging=data;return event({dataTransfer:{types:[dragType],getData:()=>JSON.stringify(data),dropEffect:''},currentTarget:{contains:()=>false},relatedTarget:null});};
 async function flush(){await new Promise(resolve=>setImmediate(resolve));if(dirty)render();}
 render();
 return {props,calls,render,items,item,keys,levels,click,press,caret,icon,avatar,hasMenu,count,dragEvent,flush,nodes,get tree(){return tree;}};
}

const servers=[
 {id:'a1',name:'APP-01',customerId:'cA',groupId:'gA',groupName:'Alpha Prod',groups:[{id:'gA',name:'Alpha Prod',parentId:null,depth:0,direct:true}]},
 {id:'a2',name:'APP-02',customerId:'cA',groupId:'gA2',groupName:'Alpha Web',groups:[{id:'gA',name:'Alpha Prod',parentId:null,depth:0,direct:false},{id:'gA2',name:'Alpha Web',parentId:'gA',depth:1,direct:true}]},
 {id:'a3',name:'LOOSE-A',customerId:'cA',groupId:null},
 {id:'b1',name:'BETA-01',customerId:'cB',groupId:null},
 {id:'x1',name:'OLD-01',customerId:'cGone',groupId:null},
];
const deviceGroups=[
 {id:'gA',name:'Alpha Prod',description:'',parentId:null,depth:0,deviceCount:2,permissions:['*'],customerId:'cA'},
 {id:'gA2',name:'Alpha Web',description:'',parentId:'gA',depth:1,deviceCount:1,permissions:['*'],customerId:'cA'},
 {id:'gB',name:'Beta Leer',description:'',parentId:null,depth:0,deviceCount:0,permissions:['*'],customerId:'cB'},
 {id:'gX',name:'Ohne Kunde',description:'',parentId:null,depth:0,deviceCount:0,permissions:['*']},
];
const permissionDevices=[{id:'p1',name:'PERM-B',groupId:null,groupName:null,groups:[],customerId:'cB'}];
const customers=[{id:'cB',name:'Kunde B'},{id:'cA',name:'Kunde A'},{id:'cEmpty',name:'Kunde Leer'}];

// Without customers, with one customer, the tree is row by row the same.
const flat=harness({servers,deviceGroups,permissionDevices});
const flatRows=()=>flat.items().map(node=>[node.props['data-key'],node.props['aria-level'],node.props['aria-label']]);
const before=flatRows();
assert.deepEqual(flat.keys(),['all','group:gA','group:gB','group:gX','ungrouped','device:b1','device:a3','device:x1','device:p1'],'a flat tree with groups: the loose devices sit in "Ungrouped" after the groups');checks++;
for(const list of [[],[{id:'cA',name:'Kunde A'}]]){const single=harness({servers,deviceGroups,permissionDevices,customers:list});assert.deepEqual(single.items().map(node=>[node.props['data-key'],node.props['aria-level'],node.props['aria-label']]),before,'flat tree for '+list.length+' customers');checks++;}

// From two customers on, one folder per customer at level 2, the rest after it.
const ui=harness({servers,deviceGroups,permissionDevices,customers});
assert.deepEqual(ui.keys(),['all','customer:cA','customer:cB','customer:cEmpty','group:gX','device:x1'],'folders by name (the empty customer too), then rest groups, then rest devices; All devices gets no Ungrouped node');
assert.equal(ui.item('customer:cA').props['aria-level'],2);assert.equal(ui.icon('customer:cA'),'CustomerAvatar','the folder shows the customer avatar');
assert.deepEqual(ui.avatar('customer:cA'),{name:'Kunde A',logo:undefined},'without a logo the avatar shows the initials');
assert.ok(!ui.nodes().some(node=>node.type==='Building2'),'no Building2 glyph left in the tree');
const logo={light:{url:'/api/branding/asset/a',contentType:'image/png',width:64,height:64,size:10,updatedAt:1},dark:null};
const logos=harness({servers,deviceGroups,permissionDevices,customers,customerLogos:{cA:logo}});
assert.deepEqual([logos.avatar('customer:cA'),logos.avatar('customer:cB')],[{name:'Kunde A',logo},{name:'Kunde B',logo:undefined}],'the logo of its customer, by id');
assert.deepEqual([logos.keys(),logos.item('customer:cA').props['aria-label']],[ui.keys(),'Kunde A (3)'],'keys and labels unchanged with a logo');
assert.equal(ui.count('customer:cA'),3,'grouped and ungrouped devices of Kunde A');assert.equal(ui.count('customer:cB'),2,'device and permission target of Kunde B');
assert.equal(ui.item('customer:cA').props['aria-label'],'Kunde A (3)');
assert.equal(nodes(ui.item('customer:cA')).find(node=>node.props.className==='sdx-tree-label').props.title,'Kunde A');
assert.equal(ui.item('customer:cA').props.style.paddingLeft,20,'indent 6+(level-1)*14');
checks+=13;
function nodes(node){return !node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(child=>nodes(child))];}

// Folders start collapsed. A click, Enter and Space open the customer view and do not toggle.
assert.equal(ui.item('customer:cA').props['aria-expanded'],false);assert.equal(ui.item('customer:cA').props['aria-selected'],false);checks+=2;
ui.click('customer:cA');
assert.deepEqual(ui.calls,[['customer','cA']],'a click opens the customer view');assert.equal(ui.item('customer:cA').props['aria-expanded'],false,'and does not open the folder');
let e=ui.press('customer:cB','Enter');assert.equal(e.prevented,true);
ui.press('customer:cB',' ');
assert.deepEqual(ui.calls,[['customer','cA'],['customer','cB'],['customer','cB']],'Enter and Space open the customer view');
assert.equal(ui.item('customer:cB').props['aria-expanded'],false,'Enter and Space do not toggle');
checks+=5;
// The caret toggles without selecting.
ui.caret('customer:cA');
assert.equal(ui.item('customer:cA').props['aria-expanded'],true);
assert.deepEqual(ui.keys(),['all','customer:cA','group:gA','ungrouped:cA','device:a3','customer:cB','customer:cEmpty','group:gX','device:x1']);
assert.equal(ui.levels()['group:gA'],3);assert.equal(ui.levels()['ungrouped:cA'],3);assert.equal(ui.levels()['device:a3'],4);assert.equal(ui.item('device:a3').props.style.paddingLeft,48);
checks+=5;
ui.caret('group:gA');assert.equal(ui.levels()['group:gA2'],4,'subgroups one level deeper');checks++;
ui.caret('customer:cA');assert.equal(ui.item('customer:cA').props['aria-expanded'],false);assert.equal(ui.item('group:gA'),undefined);checks+=2;
ui.caret('customer:cB');assert.equal(ui.item('customer:cB').props['aria-expanded'],true);
assert.deepEqual(ui.keys(),['all','customer:cA','customer:cB','group:gB','ungrouped:cB','device:b1','device:p1','customer:cEmpty','group:gX','device:x1']);
ui.caret('customer:cB');assert.equal(ui.item('customer:cB').props['aria-expanded'],false);
checks+=3;
// The arrow keys open, close and move focus as for groups.
ui.press('customer:cA','ArrowRight');assert.equal(ui.item('customer:cA').props['aria-expanded'],true,'arrow right opens');
ui.press('customer:cA','ArrowRight');assert.equal(ui.item('group:gA').props.tabIndex,0,'arrow right on an open folder moves to its first child');
ui.press('device:a3','ArrowLeft');assert.equal(ui.item('ungrouped:cA').props.tabIndex,0,'arrow left on a loose device moves to its Ungrouped node');
ui.press('ungrouped:cA','ArrowLeft');assert.equal(ui.item('ungrouped:cA').props['aria-expanded'],false,'arrow left closes the node');
ui.press('ungrouped:cA','ArrowLeft');assert.equal(ui.item('customer:cA').props.tabIndex,0,'arrow left on a child moves to the folder');checks+=2;
ui.press('customer:cA','ArrowLeft');assert.equal(ui.item('customer:cA').props['aria-expanded'],false,'arrow left closes');
ui.press('customer:cA','ArrowDown');assert.equal(ui.item('customer:cB').props.tabIndex,0,'arrow down is unchanged');
ui.press('customer:cB','Home');assert.equal(ui.item('all').props.tabIndex,0,'Home is unchanged');
ui.press('customer:cA','ArrowRight');
checks+=6;
assert.equal(ui.calls.length,3,'the caret and the arrow keys select nothing');
assert.equal(ui.items().some(node=>node.props['data-key'].startsWith('customer:')&&node.props['aria-selected']),false,'without selectedCustomerId no folder is selected');checks+=2;

// The folder menu follows the rights; without onAction there is none.
// The row menus build their entries when they open (an entries function).
const entries=(tree,key)=>{const value=nodes(tree.item(key)).find(node=>node.type===Menu)?.props.entries;return typeof value==='function'?value():value??[];};
assert.deepEqual(entries(ui,'customer:cA').map(entry=>[entry.id,entry.label,entry.icon]),[['create-group','Gruppe für diesen Kunden erstellen','FolderPlus'],['provision','Gerät hinzufügen','Plus']],'canCreateRootGroup, and Add device for the Owner');
const owner=harness({servers,deviceGroups,permissionDevices,customers,canManageCustomers:true});
assert.deepEqual(entries(owner,'customer:cA').map(entry=>[entry.id,entry.label,entry.icon]),[['create-group','Gruppe für diesen Kunden erstellen','FolderPlus'],['manage-customer','Kunde verwalten…','Pencil'],['customer-access','Technikerzugriff…','Users'],['customer-installers','Installer','Package'],['provision','Gerät hinzufügen','Plus']],'both rights, in order, then Add device');
const manager=harness({servers,deviceGroups,permissionDevices,customers,canCreateRootGroup:false,canManageCustomers:true,canProvision:false});
assert.deepEqual(entries(manager,'customer:cA').map(entry=>entry.id),['manage-customer','customer-access','customer-installers'],'canManageCustomers only');
const noRights=harness({servers,deviceGroups,permissionDevices,customers,canCreateRootGroup:false,canManageCustomers:false,canProvision:false});
assert.equal(noRights.hasMenu('customer:cA'),false,'no entry, no "…" button');
e=noRights.press('customer:cA','F10',{shiftKey:true});assert.equal(e.prevented,undefined,'Shift+F10 does nothing');
e=noRights.press('customer:cA','ContextMenu');assert.equal(e.prevented,undefined,'the ContextMenu key does nothing');
e={preventDefault(){this.prevented=true;}};noRights.item('customer:cA').props.onContextMenu(e);assert.equal(e.prevented,undefined,'right click does nothing');
const demo=harness({servers,deviceGroups,permissionDevices,customers,canManageCustomers:true,onAction:undefined});
assert.equal(demo.hasMenu('customer:cA'),false,'no menu without onAction (demo mode)');
checks+=8;
e=owner.press('customer:cA','F10',{shiftKey:true});assert.equal(e.prevented,true,'Shift+F10 opens the menu');
assert.equal(nodes(owner.item('customer:cA')).find(node=>node.type===Menu).props.open,true);
e={preventDefault(){this.prevented=true;}};owner.item('customer:cB').props.onContextMenu(e);owner.render();assert.equal(e.prevented,true,'right click opens the menu');
assert.equal(nodes(owner.item('customer:cB')).find(node=>node.type===Menu).props.open,true);
checks+=4;
const targets=[];
const acting=harness({servers,deviceGroups,permissionDevices,customers,canManageCustomers:true,onAction:(action,target)=>targets.push([action,target])});
entries(acting,'customer:cA').find(entry=>entry.id==='manage-customer').onSelect();
entries(acting,'customer:cB').find(entry=>entry.id==='create-group').onSelect();
entries(acting,'customer:cEmpty').find(entry=>entry.id==='provision').onSelect();
assert.deepEqual(targets,[['manage-customer',{type:'customer',id:'cA',name:'Kunde A'}],['create-group',{type:'customer',id:'cB',name:'Kunde B'}],['provision',{type:'customer',id:'cEmpty',name:'Kunde Leer'}]],'Add device of a folder names its customer');checks++;
assert.equal(ui.hasMenu('all'),true,'control: the root keeps its menu');assert.equal(ui.hasMenu('group:gA'),true);checks+=2;

// Still no drop target.
e=ui.dragEvent(['b1']);ui.item('customer:cA').props.onDragOver(e);assert.equal(e.prevented,undefined,'dragover is not accepted');
const callCount=ui.calls.length;
e=ui.dragEvent(['b1']);ui.item('customer:cA').props.onDrop(e);ui.render();assert.equal(ui.calls.length,callCount,'drop on a folder moves nothing');
e=ui.dragEvent(['b1']);ui.item('group:gA').props.onDragOver(e);assert.equal(e.prevented,true,'control: a group still accepts');
ui.item('group:gA').props.onDrop(ui.dragEvent(['b1']));assert.deepEqual(ui.calls.at(-1),['move',['b1'],'gA']);
ui.item('all').props.onDrop(ui.dragEvent(['a1']));assert.deepEqual(ui.calls.at(-1),['move',['a1'],null]);
checks+=5;
// A closed folder still opens while a device hovers over it, so its groups stay reachable.
assert.equal(ui.item('customer:cB').props['aria-expanded'],false);
e=ui.dragEvent(['a1']);ui.item('customer:cB').props.onDragOver(e);assert.equal(e.prevented,undefined);
await new Promise(resolve=>setTimeout(resolve,750));ui.render();assert.equal(ui.item('customer:cB').props['aria-expanded'],true);
checks+=3;

// Selecting a device or group opens its customer folder and group path.
const pick=harness({servers,deviceGroups,permissionDevices,customers});
pick.props.selectedServerId='a2';pick.render();await pick.flush();
assert.equal(pick.item('customer:cA').props['aria-expanded'],true);assert.equal(pick.item('group:gA').props['aria-expanded'],true);assert.equal(pick.item('device:a2').props['aria-selected'],true);assert.equal(pick.levels()['device:a2'],5);
assert.equal(pick.item('customer:cB').props['aria-expanded'],false,'other folders stay closed');
checks+=5;
pick.props.selectedServerId=undefined;pick.props.selectedGroupId='gB';pick.render();await pick.flush();
assert.equal(pick.item('customer:cB').props['aria-expanded'],true,'a selected root group opens its folder');assert.equal(pick.item('group:gB').props['aria-selected'],true);checks+=2;
const loose=harness({servers,deviceGroups,permissionDevices,customers,selectedServerId:'b1'});await loose.flush();
assert.equal(loose.item('customer:cB').props['aria-expanded'],true,'an ungrouped device opens its folder');assert.equal(loose.item('ungrouped:cB').props['aria-expanded'],true,'and its Ungrouped node');assert.equal(loose.item('device:b1').props['aria-selected'],true);assert.equal(loose.levels()['device:b1'],4);checks+=4;
const rest=harness({servers,deviceGroups,permissionDevices,customers,selectedServerId:'x1'});await rest.flush();
assert.equal(rest.item('customer:cA').props['aria-expanded'],false);assert.equal(rest.item('device:x1').props['aria-level'],2);checks+=2;

// A selected customer: its folder row is selected and active, "Alle Geräte" is not.
const chosen=harness({servers,deviceGroups,permissionDevices,customers,selectedCustomerId:'cA'});await chosen.flush();
assert.equal(chosen.item('customer:cA').props['aria-selected'],true);assert.match(chosen.item('customer:cA').props.className,/\bactive\b/);
assert.equal(chosen.item('all').props['aria-selected'],false);assert.equal(chosen.item('customer:cB').props['aria-selected'],false);
checks+=4;
// Collapsing "Alle Geräte", then selecting a customer, opens "Alle Geräte" again.
const collapsed=harness({servers,deviceGroups,permissionDevices,customers});
collapsed.caret('all');assert.deepEqual(collapsed.keys(),['all']);
collapsed.props.selectedCustomerId='cB';collapsed.render();await collapsed.flush();
assert.equal(collapsed.item('all').props['aria-expanded'],true);assert.equal(collapsed.item('customer:cB').props['aria-selected'],true);checks+=3;

// Filter keeps folders with a matching name or matching content, opened.
const find=harness({servers,deviceGroups,permissionDevices,customers,filter:'beta-01'});
assert.deepEqual(find.keys(),['all','customer:cB','ungrouped:cB','device:b1']);assert.equal(find.item('customer:cB').props['aria-expanded'],true);checks+=2;
find.props.filter='kunde a';find.render();assert.deepEqual(find.keys(),['all','customer:cA'],'a folder name match shows the folder');checks++;
find.click('customer:cA');assert.deepEqual(find.calls.at(-1),['customer','cA'],'a click opens the customer view while the filter is active');checks++;
find.props.filter='web';find.render();assert.deepEqual(find.keys(),['all','customer:cA','group:gA','group:gA2']);checks++;
find.props.filter='nichts';find.render();assert.deepEqual(find.keys(),['all']);assert.ok(find.nodes().some(node=>node.props.className==='sdx-tree-empty'),'empty notice stays');checks+=2;
find.props.filter='kunde';find.render();assert.equal(find.nodes().some(node=>node.props.className==='sdx-tree-empty'),false);checks++;

// ---- The node "Ungrouped" ----
{
 // An empty customer folder: count 0, not expandable, opens the customer scope.
 const tree=harness({servers,deviceGroups,permissionDevices,customers});
 const empty=tree.item('customer:cEmpty');
 assert.deepEqual([empty.props['aria-expanded'],tree.count('customer:cEmpty'),empty.props['aria-label'],empty.props['aria-level']],[undefined,0,'Kunde Leer (0)',2],'an empty folder: count 0, not expandable');
 assert.equal(nodes(empty).find(node=>typeof node.props.className==='string'&&node.props.className.startsWith('sdx-tree-caret')).props.className,'sdx-tree-caret','no caret');
 tree.click('customer:cEmpty');tree.press('customer:cEmpty','ArrowRight');
 assert.deepEqual([tree.calls.at(-1),tree.keys().includes('customer:cEmpty'),tree.item('customer:cEmpty').props['aria-expanded']],[['customer','cEmpty'],true,undefined],'it opens the customer scope and does not expand');checks+=3;
 // The node in a folder: after its groups, with the count of its loose devices, an Inbox icon, level 3.
 tree.caret('customer:cB');
 assert.deepEqual(tree.keys().slice(3,7),['group:gB','ungrouped:cB','device:b1','device:p1'],'the node comes after the groups of the folder');
 const node=tree.item('ungrouped:cB');
 assert.deepEqual([node.props.role,node.props['aria-level'],node.props['aria-expanded'],node.props['aria-selected'],node.props['aria-label'],tree.count('ungrouped:cB'),tree.icon('ungrouped:cB')],['treeitem',3,true,false,'Ohne Gruppe (2)',2,'Inbox'],'a treeitem with level, expanded state and count');checks+=2;
 // Selecting it opens the customer Ungrouped route; the caret and the arrow keys behave like a group.
 tree.click('ungrouped:cB');assert.deepEqual(tree.calls.at(-1),['ungrouped','cB'],'a click opens #devices/customer/<id>/ungrouped');
 tree.press('ungrouped:cB','Enter');assert.deepEqual(tree.calls.at(-1),['ungrouped','cB'],'Enter too');
 tree.press('ungrouped:cB','ArrowLeft');assert.equal(tree.item('ungrouped:cB').props['aria-expanded'],false,'arrow left closes');assert.equal(tree.item('device:b1'),undefined);
 tree.press('ungrouped:cB','ArrowRight');assert.equal(tree.item('ungrouped:cB').props['aria-expanded'],true,'arrow right opens');
 tree.press('ungrouped:cB','ArrowRight');assert.equal(tree.item('device:b1').props.tabIndex,0,'and moves to the first device');
 tree.caret('ungrouped:cB');assert.equal(tree.item('ungrouped:cB').props['aria-expanded'],false,'the caret toggles');checks+=6;
 // Its menu has only Add device, for its customer; without the Owner right it has none.
 assert.deepEqual(entries(tree,'ungrouped:cB').map(entry=>[entry.id,entry.label]),[['provision','Gerät hinzufügen']],'only Add device');
 entries(tree,'ungrouped:cB')[0].onSelect();assert.deepEqual(tree.calls.at(-1),['action','provision','Kunde B'],'of the customer');
 assert.equal(harness({servers,deviceGroups,permissionDevices,customers,canProvision:false}).hasMenu('ungrouped:cA'),false,'no menu without Add device');checks+=3;
 // Selected on its route: the customer Ungrouped scope selects the node, opens the folder, and not the folder row.
 const chosen=harness({servers,deviceGroups,permissionDevices,customers,selectedCustomerId:'cB',selectedUngrouped:true});await chosen.flush();
 assert.deepEqual([chosen.item('ungrouped:cB').props['aria-selected'],/\bactive\b/.test(chosen.item('ungrouped:cB').props.className),chosen.item('customer:cB').props['aria-expanded'],chosen.item('customer:cB').props['aria-selected']],[true,true,true,false],'the node is selected with the accent bar, its folder is open');checks++;
 // With folders All devices has no node; #devices/ungrouped selects nothing.
 const allUngrouped=harness({servers,deviceGroups,permissionDevices,customers,selectedGroupId:'unassigned'});await allUngrouped.flush();
 assert.equal(allUngrouped.items().some(item=>item.props['aria-selected']),false,'#devices/ungrouped with folders has no node');checks++;
 // Flat tree: the node under All devices, selected on #devices/ungrouped, opening it.
 const flatTree=harness({servers,deviceGroups,permissionDevices,selectedGroupId:'unassigned'});await flatTree.flush();
 assert.deepEqual([flatTree.item('ungrouped').props['aria-level'],flatTree.item('ungrouped').props['aria-selected'],flatTree.count('ungrouped'),flatTree.item('all').props['aria-selected']],[2,true,4,false],'flat: level 2, selected, count 4');
 flatTree.click('ungrouped');assert.deepEqual(flatTree.calls.at(-1),['ungrouped',undefined],'it opens #devices/ungrouped');
 entries(flatTree,'ungrouped')[0].onSelect();assert.deepEqual(flatTree.calls.at(-1),['action','provision','Alle Geräte'],'Add device of All devices');checks+=3;
 // No group: the loose devices stay direct children, no node.
 const noGroups=harness({servers:servers.map(server=>({...server,groupId:null,groupName:null,groups:[]})),deviceGroups:[],permissionDevices});
 assert.deepEqual(noGroups.keys(),['all','device:a1','device:a2','device:b1','device:a3','device:x1','device:p1'],'a parent without a group keeps its loose devices');checks++;
 // A folder without loose devices has no node.
 const groupedOnly=harness({servers:servers.filter(server=>server.id!=='a3'),deviceGroups,permissionDevices,customers});groupedOnly.caret('customer:cA');
 assert.equal(groupedOnly.keys().some(key=>key.startsWith('ungrouped')),false,'no loose device: no node');checks++;
 // Up to 10 devices the node starts open, with more it starts closed and opens for a selected device inside it.
 const many=count=>Array.from({length:count},(_,index)=>({id:'m'+index,name:'M-'+String(index).padStart(2,'0'),groupId:null,groups:[]}));
 const ten=harness({servers:[servers[0],...many(10)],deviceGroups:deviceGroups.slice(0,1)}),eleven=harness({servers:[servers[0],...many(11)],deviceGroups:deviceGroups.slice(0,1)});
 assert.deepEqual([ten.item('ungrouped').props['aria-expanded'],ten.count('ungrouped'),eleven.item('ungrouped').props['aria-expanded'],eleven.count('ungrouped'),eleven.item('device:m0')],[true,10,false,11,undefined],'10 devices: open; 11: closed');
 eleven.props.selectedServerId='m7';eleven.render();await eleven.flush();
 assert.deepEqual([eleven.item('ungrouped').props['aria-expanded'],eleven.item('device:m7').props['aria-selected'],eleven.levels()['device:m7']],[true,true,3],'a selected device opens the node');checks+=2;
 // Drop: the node leaves all groups like All devices, with the same right; inside a folder only devices of its customer.
 const drop=harness({servers,deviceGroups,permissionDevices,customers});drop.caret('customer:cB');
 let e=drop.dragEvent(['b1','p1']);drop.item('ungrouped:cB').props.onDragOver(e);assert.equal(e.prevented,true,'devices of the customer: a drop target');
 drop.item('ungrouped:cB').props.onDrop(drop.dragEvent(['b1']));assert.deepEqual(drop.calls.at(-1),['move',['b1'],null],'the devices leave all groups');
 e=drop.dragEvent(['b1','a1']);drop.item('ungrouped:cB').props.onDragOver(e);assert.equal(e.prevented,undefined,'a device of another customer: no drop target');
 const before=drop.calls.length;drop.item('ungrouped:cB').props.onDrop(drop.dragEvent(['a1']));assert.equal(drop.calls.length,before,'and its drop moves nothing');
 const noRoot=harness({servers,deviceGroups,permissionDevices,customers,canMoveToRoot:false});noRoot.caret('customer:cB');
 e=noRoot.dragEvent(['b1']);noRoot.item('ungrouped:cB').props.onDragOver(e);assert.equal(e.prevented,undefined,'without canMoveToRoot: no drop target');
 const flatDrop=harness({servers,deviceGroups,permissionDevices});
 e=flatDrop.dragEvent(['a1','b1']);flatDrop.item('ungrouped').props.onDragOver(e);assert.equal(e.prevented,true,'flat: every device');
 flatDrop.item('ungrouped').props.onDrop(flatDrop.dragEvent(['a1']));assert.deepEqual(flatDrop.calls.at(-1),['move',['a1'],null]);checks+=7;
}

// No new class names or colors.
const source=fs.readFileSync('ui/devices/fleet/inventory-tree.tsx','utf8');
assert.doesNotMatch(source,/#[0-9a-f]{3,8}\b(?![-\w])/i,'no hex colors');assert.doesNotMatch(source,/sdx-tree-customer/,'existing tree classes only');checks+=2;

console.log(`inventory tree customers: ${checks} checks passed`);
