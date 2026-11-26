// The node "Pinned" of the navigator tree (ui/devices/fleet/inventory-tree.tsx, docs/device-workspace.md "Pinned
// devices"): no node without pins or when no pinned device is in servers; the node first at level 1 with its count,
// open by default, its rows (keys pinned:<id>, level 2) sorted by name with the type glyph; the tree filter; the open
// device (the main row aria-selected, the pinned row aria-current); the arrow keys across Pinned and All devices;
// click, Enter and drag of a pinned row; the menu entries Pin device / Unpin device (first entry, none in demo mode
// and none for permission-only rows); and the one-time fade of a row pinned during the session.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {i18nRequire} from '../../support/i18n-stubs.mjs';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const transpile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const Menu=()=>null;
const dragType='application/x-serverdesk-devices';
const drags=[];

function harness(overrides={}){
 const states=[],effects=[];let cursor=0,tree,dirty=false;
 const calls=[];
 const props={servers:[],filter:'',onAll:()=>calls.push(['all']),onGroup:id=>calls.push(['group',id]),onDevice:id=>calls.push(['device',id]),onCustomer:id=>calls.push(['customer',id]),onUngrouped:id=>calls.push(['ungrouped',id]),onAction:(action,target)=>calls.push(['action',action,target.id??target.name]),canManageGroups:true,canCreateRootGroup:true,canManagePermissions:true,canProvision:true,onMoveDevices:(ids,groupId)=>calls.push(['move',ids,groupId]),canMoveToRoot:true,...overrides};
 const hooks={
  useRef(initial){const index=cursor++;states[index]??={current:initial};return states[index];},
  useState(initial){const index=cursor++;states[index]??={value:typeof initial==='function'?initial():initial};return[states[index].value,value=>{const next=typeof value==='function'?value(states[index].value):value;if(!Object.is(next,states[index].value)){states[index].value=next;dirty=true;}}];},
  useMemo(fn,deps){const index=cursor++,previous=states[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i])))states[index]={deps,value:fn()};return states[index].value;},
  // Effects run once after the render; their cleanups are not needed here (the fade timer is cleared by hand below).
  useEffect(fn,deps){const index=cursor++,previous=states[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i])))effects.push(()=>{previous?.cleanup?.();states[index]={deps,cleanup:fn()};});},
 };
 const jsx=(type,props)=>({type,props:props??{}});
 const react={...hooks,useLayoutEffect:fn=>{fn();},useId:()=>':id:',memo:type=>({$$typeof:Symbol.for('react.memo'),type,compare:null}),createElement:(type,props,...children)=>jsx(type,{...props,children})};
 const load=(file,require)=>{const mod={exports:{}};new Function('require','module','exports',transpile(file))(require,mod,mod.exports);return mod.exports;};
 const base=id=>i18nRequire(id)??(id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:id==='lucide-react'?new Proxy({},{get:(_target,key)=>String(key)}):id.endsWith('.css')?{}:undefined);
 const strict=id=>base(id)??(()=>{throw Error('Unexpected '+id);})();
 const navigation=load('ui/devices/fleet/inventory-navigation.ts',strict);
 const folders=load('ui/devices/fleet/customer-folders.ts',strict);
 const types=load('ui/devices/device/device-type-model.ts',strict);
 const modules={'@/ui/devices/device/device-type-model':types,'@/ui/devices/fleet/customer-avatar':{CustomerAvatar:'CustomerAvatar'},'@/ui/devices/fleet/inventory-navigation':navigation,'@/ui/devices/fleet/customer-folders':folders,'@/ui/kit/kit':{Menu,cx:(...names)=>names.filter(Boolean).join(' ')},'@/ui/devices/fleet/fleet':{deviceDragType:dragType,startDeviceDrag:(_event,ids,label)=>drags.push([ids,label]),draggedDeviceIds:()=>[]},'@/ui/base/ui-device':{deviceConnection:()=>null,deviceIssues:()=>[],deviceToneState:()=>''},'@/ui/base/clock-store':{useClockTransition:()=>0}};
 const InventoryTree=load('ui/devices/fleet/inventory-tree.tsx',id=>base(id)??modules[id]??(()=>{throw Error('Unexpected '+id);})()).default.type;
 const expand=node=>node?.type?.$$typeof===Symbol.for('react.memo')?expand(node.type.type(node.props)):node;
 const walk=input=>{const node=expand(input);return !node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(child=>walk(child))];};
 const nodes=(...node)=>walk(node.length?node[0]:tree);
 function render(){let limit=0;do{dirty=false;cursor=0;tree=InventoryTree(props);for(const effect of effects.splice(0))effect();if(++limit>10)throw Error('Unstable render');}while(dirty);}
 const items=()=>nodes().filter(node=>node.props.role==='treeitem');
 const item=key=>items().find(node=>node.props['data-key']===key);
 const keys=()=>items().map(node=>node.props['data-key']);
 const event=(extra={})=>({preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...extra});
 const click=key=>{item(key).props.onClick(event());render();};
 const press=(key,value)=>{item(key).props.onKeyDown(event({key:value}));render();};
 const focused=()=>items().find(node=>node.props.tabIndex===0)?.props['data-key'];
 const icon=key=>nodes(nodes(item(key)).find(node=>typeof node.props.className==='string'&&/^sdx-tree-icon(?: |$)/.test(node.props.className))).find(node=>typeof node.type==='string'&&/^[A-Z]/.test(node.type))?.type;
 const entries=key=>{const value=nodes(item(key)).find(node=>node.type===Menu)?.props.entries;return typeof value==='function'?value():value??[];};
 render();
 return {props,calls,render,items,item,keys,click,press,focused,icon,entries,nodes,event};
}

// queueMicrotask in the tree's effects (reveal paths) runs before the next check.
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const security=domainRole=>({domainJoined:true,domainRole,rdpEnabled:false,firewall:[],defender:{available:true,enabled:true,signatureAt:'',realTimeProtection:true},lastBoot:''});
const servers=[
 {id:'s10',name:'SRV-10',groupId:null,snapshot:{os:'Windows Server 2022',security:security(3)}},
 {id:'s2',name:'SRV-2',groupId:null,snapshot:{os:'Windows Server 2025',security:security(5)}},
 {id:'w1',name:'PC-Anna',groupId:null,snapshot:{os:'Windows 11 Pro',security:security(1),battery:{collectedAt:'',present:true,batteries:[]}}},
 {id:'n1',name:'NEW-01',groupId:null,snapshot:null},
];
const permissionDevices=[{id:'p1',name:'PERM-01',groupId:null,groupName:null,groups:[]}];

// ---- no node without pins, or when no pinned device is in servers ----
for(const [pinnedIds,label] of [[undefined,'not loaded'],[[],'no pins'],[['gone','p1'],'only an unknown and a permission-only device']]){
 const tree=harness({servers,permissionDevices,pinnedIds});
 ok(!tree.keys().some(key=>key==='pinned'||key.startsWith('pinned:')),`no Pinned node: ${label}`);
 check(tree.keys()[0],'all','All devices first');
}

// ---- the node: first, level 1, count, open, rows by name ----
const tree=harness({servers,permissionDevices,pinnedIds:['w1','s10','gone','s2','p1']});
check(tree.keys(),['pinned','pinned:w1','pinned:s2','pinned:s10','all','device:n1','device:w1','device:p1','device:s2','device:s10'],'Pinned first, its rows by name (numeric), then All devices');
const node=tree.item('pinned');
check([node.props['aria-level'],node.props['aria-expanded'],node.props['aria-label'],node.props['aria-selected']],[1,true,'Angeheftet (3)',false],'level 1, open by default, "Pinned (N)" with the pinned devices in servers');
check(tree.icon('pinned'),'Pin','the Pin glyph');
check(['pinned:w1','pinned:s2','pinned:s10'].map(key=>[tree.item(key).props['aria-level'],tree.icon(key)]),[[2,'Laptop'],[2,'Network'],[2,'Server']],'level 2 rows with the type glyph');
check(tree.icon('device:n1'),'MonitorSmartphone','a device row without a snapshot: the unknown glyph');
check(tree.icon('device:p1'),'ShieldCheck','a permission-only row keeps ShieldCheck');
ok(tree.nodes(tree.item('pinned:w1')).some(node=>typeof node.props.className==='string'&&node.props.className.startsWith('sdx-dot')),'the status dot of a pinned row');
ok(!tree.nodes().some(node=>node.type==='Server'&&tree.icon('device:w1')==='Server'),'no Server glyph for a laptop');
check(tree.entries('pinned'),[],'the node has no menu');
tree.click('pinned');
check([tree.keys().slice(0,2),tree.item('pinned').props['aria-expanded']],[['pinned','all'],false],'a click toggles the node like other nodes');
tree.click('pinned');
check(tree.keys()[1],'pinned:w1','and opens it again');

// ---- open, Enter, drag ----
tree.click('pinned:s2');tree.press('pinned:w1','Enter');tree.press('pinned:s10',' ');
check(tree.calls.splice(0),[['device','s2'],['device','w1'],['device','s10']],'click, Enter and Space open the device');
ok(tree.item('pinned:s2').props.draggable,'a pinned row can be dragged');
tree.item('pinned:s2').props.onDragStart(tree.event({nativeEvent:{}}));
check(drags.splice(0),[[['s2'],'SRV-2']],'like its device row');

// ---- the filter ----
tree.props.filter='srv';tree.render();
check(tree.keys().filter(key=>key.startsWith('pinned')),['pinned','pinned:s2','pinned:s10'],'only matching pinned rows');
check(tree.item('pinned').props['aria-label'],'Angeheftet (3)','the count stays the number of pinned devices');
tree.props.filter='new';tree.render();
check(tree.keys(),['all','device:n1'],'no match among the pins: no node');
tree.props.filter='';tree.render();

// ---- the open device: the main row is selected, the pinned row current ----
tree.props.selectedServerId='s2';tree.render();await flush();tree.render();
check([tree.item('device:s2').props['aria-selected'],tree.item('device:s2').props['aria-current']],[true,undefined],'the main row stays the selected tree item');
check([tree.item('pinned:s2').props['aria-selected'],tree.item('pinned:s2').props['aria-current'],tree.item('pinned:s2').props.className],[false,'true','sdx-tree-row current'],'the pinned row: aria-current with the quieter current look');
check(tree.item('pinned:w1').props['aria-current'],undefined,'other pinned rows are not current');

// ---- keyboard across Pinned and All devices ----
tree.press('device:s2','Home');check(tree.focused(),'pinned','Home: the Pinned node');
tree.press('pinned','ArrowRight');check(tree.focused(),'pinned:w1','Right on the open node: its first row');
tree.press('pinned:w1','ArrowLeft');check(tree.focused(),'pinned','Left on a pinned row: the node');
tree.press('pinned:s10','ArrowDown');check(tree.focused(),'all','Down from the last pinned row: All devices');
tree.press('all','ArrowUp');check(tree.focused(),'pinned:s10','Up from All devices: the last pinned row');
tree.press('device:p1','End');check(tree.focused(),'device:s10','End: the last row');
tree.press('pinned','ArrowLeft');check(tree.item('pinned').props['aria-expanded'],false,'Left on the open node closes it');
tree.press('pinned','ArrowRight');check(tree.item('pinned').props['aria-expanded'],true,'Right opens it');

// ---- the menu: Pin device / Unpin device first, none for permission-only rows, none in demo mode ----
check(tree.entries('pinned:w1').slice(0,1).map(entry=>[entry.id,entry.label,entry.icon]),[['unpin','Gerät lösen','PinOff']],'a pinned row: Unpin device first');
check(tree.entries('device:w1').map(entry=>entry.id),['unpin','permissions'],'its main row: the same menu');
check(tree.entries('device:n1').slice(0,1).map(entry=>[entry.id,entry.label,entry.icon]),[['pin','Gerät anheften','Pin']],'an unpinned device: Pin device first');
check(tree.entries('device:p1').map(entry=>entry.id),['permissions'],'a permission-only row: no pin entry');
tree.entries('pinned:w1')[0].onSelect();tree.entries('device:n1')[0].onSelect();
check(tree.calls.splice(0),[['action','unpin','w1'],['action','pin','n1']],'the entries run the console action');
const demo=harness({servers,permissionDevices,pinnedIds:['w1'],onAction:undefined});
ok(!demo.nodes().some(node=>node.type===Menu),'demo mode (no onAction): no menu at all');

// ---- a row pinned during the session fades in once ----
const live=harness({servers,pinnedIds:undefined});
live.props.pinnedIds=['w1'];live.render();
ok(!/is-fresh/.test(live.item('pinned:w1').props.className),'the first loaded list does not fade');
live.props.pinnedIds=['w1'];live.render();
live.props.pinnedIds=['w1','s2'];live.render();
check([live.item('pinned:s2').props.className,live.item('pinned:w1').props.className],['sdx-tree-row is-fresh','sdx-tree-row'],'a new pin fades in, the others stay');
live.props.pinnedIds=['w1','s2'];live.render();
ok(/is-fresh/.test(live.item('pinned:s2').props.className),'a refresh with the same list keeps the running fade');
await new Promise(resolve=>setTimeout(resolve,450));live.render();
ok(!/is-fresh/.test(live.item('pinned:s2').props.className),'after the fade the class goes, so a later remount does not replay it');
const css=fs.readFileSync('ui/styles/console.css','utf8'),motion=fs.readFileSync('ui/styles/motion.css','utf8');
ok(/\.sdx-tree-row\.is-fresh \{ animation: sdx-fade var\(--sd-dur\) var\(--sd-ease-out\) backwards; \}/.test(css),'the fade uses sdx-fade');
ok(motion.slice(motion.indexOf('prefers-reduced-motion')).includes('.sdx-tree-row.is-fresh,'),'and stops under reduced motion');
ok(/\.sdx-tree-row\.current \{ color: var\(--sd-accent-strong\); \}/.test(css)&&!/\.sdx-tree-row\.current \{[^}]*background/.test(css),'the current look: accent-strong label, no fill');

console.log(`PASS inventory tree pinned (${checks} checks): the Pinned node, its rows, filter, selection, keyboard, menu and fade.`);
