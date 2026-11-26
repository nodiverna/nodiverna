'use client';
import {memo,useEffect,useLayoutEffect,useMemo,useRef,useState,type DragEvent,type KeyboardEvent,type MouseEvent} from 'react';
import {ChevronRight,Folder,FolderInput,FolderOpen,FolderPlus,Inbox,Layers,MoreHorizontal,Package,Pencil,Pin,PinOff,Plus,Server,ShieldCheck,Trash2,Users} from 'lucide-react';
import type {DeviceGroup} from '@/lib/types';
import type {BrandingLogoPair} from '@/lib/branding';
import {deviceType,deviceTypeIcons} from '@/ui/devices/device/device-type-model';
import {CustomerAvatar} from '@/ui/devices/fleet/customer-avatar';
import {deviceConnection,deviceIssues,deviceToneState} from '@/ui/base/ui-device';
import {customerFolderActions,customerFolders,ungroupedNodes,type CustomerFolderAction} from '@/ui/devices/fleet/customer-folders';
import {navigationDeviceGroups,navigationDevices,type InventoryAction,type InventoryTarget,type NavigationDevice} from '@/ui/devices/fleet/inventory-navigation';
import type {Device} from '@/ui/base/api';
import {Menu,cx,type MenuEntry} from '@/ui/kit/kit';
import {deviceDragType,draggedDeviceIds,startDeviceDrag} from '@/ui/devices/fleet/fleet';

import {useLocale,useT} from '@/ui/base/locale';
import type {Locale} from '@/lib/i18n/locale';
import {useClockTransition} from '@/ui/base/clock-store';
type Props={
 servers:Device[];
 permissionDevices?:Pick<NavigationDevice,'id'|'name'|'groupId'|'groupName'|'groups'|'customerId'>[];
 deviceGroups?:DeviceGroup[];
 /** Visible customers. From two on, root groups and ungrouped devices sit in one folder per customer. */
 customers?:{id:string;name:string}[];
 selectedServerId?:string;
 selectedGroupId?:string;
 /** The customer of the open customer view; its folder row is selected. */
 selectedCustomerId?:string;
 /** An Ungrouped scope is open (#devices/ungrouped, or with selectedCustomerId #devices/customer/<id>/ungrouped); its node is selected. */
 selectedUngrouped?:boolean;
 filter:string;
 onAll:()=>void;
 onGroup:(id:string)=>void;
 onDevice:(id:string)=>void;
 /** Opens the customer view (click, Enter or Space on a customer folder). */
 onCustomer?:(id:string)=>void;
 /** Opens an Ungrouped scope: of All devices without a customer, else of that customer. */
 onUngrouped?:(customerId?:string)=>void;
 onAction?:(action:InventoryAction,target:InventoryTarget)=>void;
 canManageGroups:boolean;
 canCreateRootGroup:boolean;
 canManagePermissions:boolean;
 canProvision:boolean;
 /** Owner-only customer dialogs in the folder menu (canManageCustomers). */
 canManageCustomers?:boolean;
 /** Drop target for dragged devices. groupId null means "Ungrouped" (the devices leave all groups). */
 onMoveDevices?:(ids:string[],groupId:string|null)=>void;
 canMoveToRoot?:boolean;
 /** The devices the account pinned (ConsoleData.preferences.pinnedDeviceIds; undefined before the first load and in
  * demo mode). Those in servers show under the root node "Pinned"; a device row menu offers pin or unpin. */
 pinnedIds?:readonly string[];
 /** The customer logos by customer id (ConsoleData.branding.customers): the avatar of a customer folder. */
 customerLogos?:Record<string,BrandingLogoPair>;
};
type Row={key:string;level:number;parent:string|null;expandable:boolean;target:InventoryTarget;label:string;count?:number;device?:NavigationDevice;group?:boolean;customer?:boolean;
 /** The root node "Pinned" (pinnedKey), or a device row inside it. */
 pinnedNode?:boolean;pinnedRow?:boolean;
 /** The node "Ungrouped": '' under All devices, else the customer id of its folder. */
 ungrouped?:string;select:()=>void};
const rootKey='all';
/** The root node "Pinned" above All devices; its rows are 'pinned:<device id>'. */
const pinnedKey='pinned';
/** A pinned row added during the session keeps its fade class this long, then a remount does not replay it. */
const pinFadeMs=400;
const noPins:readonly string[]=[];
/** The key of the node "Ungrouped" under All devices (flat tree) or in a customer folder. */
const ungroupedKey=(customerId?:string)=>customerId?'ungrouped:'+customerId:'ungrouped';
/** The node "Ungrouped" starts expanded with up to this many devices, collapsed with more. */
export const ungroupedOpenLimit=10;
const matches=(text:string,filter:string,locale:Locale)=>text.toLocaleLowerCase(locale).includes(filter);
const customerActionIcons:Record<CustomerFolderAction,typeof FolderPlus>={'create-group':FolderPlus,'manage-customer':Pencil,'customer-access':Users,'customer-installers':Package};
const byName=(locale:Locale)=>(a:{name:string},b:{name:string})=>a.name.localeCompare(b.name,locale,{numeric:true});

/**
 * Device and group tree of the navigator, keyboard operable like a file tree. Memoized: the console hands it props that
 * keep their identity, so a console render that changes nothing it shows does not render it.
 */
export default memo(function InventoryTree({servers,permissionDevices,deviceGroups,customers,selectedServerId,selectedGroupId,selectedCustomerId,selectedUngrouped=false,filter,onAll,onGroup,onDevice,onCustomer,onUngrouped,onAction,canManageGroups,canCreateRootGroup,canManagePermissions,canProvision,canManageCustomers=false,onMoveDevices,canMoveToRoot=false,pinnedIds,customerLogos}:Props){
 const t=useT(),[locale]=useLocale();
 const devices=useMemo(()=>navigationDevices(servers,permissionDevices,canManagePermissions),[servers,permissionDevices,canManagePermissions]);
 const groups=useMemo(()=>navigationDeviceGroups(devices,deviceGroups,locale),[devices,deviceGroups,locale]);
 const byId=useMemo(()=>new Map(groups.map(group=>[group.id,group])),[groups]);
 const full=useMemo(()=>new Map(servers.map(server=>[server.id,server])),[servers]);
 const deviceById=useMemo(()=>new Map(devices.map(device=>[device.id,device])),[devices]);
 const [expanded,setExpanded]=useState<Record<string,boolean>>({[rootKey]:true});
 const [focused,setFocused]=useState(rootKey),[menuKey,setMenuKey]=useState<string|null>(null),[dropKey,setDropKey]=useState<string|null>(null);
 const expandTimer=useRef<{key:string;timer:ReturnType<typeof setTimeout>}|null>(null);
 const list=useRef<HTMLUListElement>(null);
 const query=filter.trim().toLocaleLowerCase(locale);
 const primaryGroup=(device:NavigationDevice)=>{
  const direct=groups.filter(group=>group.directServers.some(item=>item.id===device.id));
  return direct.some(group=>group.id===device.groupId)?device.groupId??undefined:direct.sort((a,b)=>b.depth-a.depth||a.name.localeCompare(b.name,'de'))[0]?.id;
 };
 const selectedDevice=devices.find(device=>device.id===selectedServerId);
 const roots=groups.filter(group=>!group.parentId||!byId.has(group.parentId)),loose=devices.filter(device=>!primaryGroup(device)).sort((a,b)=>a.name.localeCompare(b.name,'de',{numeric:true}));
 // From two visible customers on, root groups and ungrouped devices sit in customer folders; null keeps the flat tree.
 const folders=customerFolders(customers,roots,loose,devices);
 // The node "Ungrouped" sits under a parent with at least one root group and one loose device: All devices in a flat tree,
 // or a customer folder. Its default open state depends on its size; a toggle overrides it.
 const ungrouped=new Map(ungroupedNodes(folders,roots.length,loose.map(device=>device.id)).map(node=>[ungroupedKey(node.customerId),node]));
 const isOpen=(key:string)=>expanded[key]??(key===pinnedKey||(ungrouped.has(key)?ungrouped.get(key)!.deviceIds.length<=ungroupedOpenLimit:false));
 const pins=pinnedIds??noPins,pinnedSet=useMemo(()=>new Set(pins),[pins]);
 // Rows pinned during the session fade in once: an id that joins the list after the first loaded list. The first load
 // and a refresh with the same pins add nothing. Derived during render (the previous list is state), so the row mounts
 // with its fade; the set empties after the fade, so collapsing and opening "Pinned" later does not replay it.
 const [pinMemo,setPinMemo]=useState<{ids:readonly string[]|undefined;fresh:ReadonlySet<string>}>(()=>({ids:pinnedIds,fresh:new Set()}));
 if(pinMemo.ids!==pinnedIds){
  const previous=pinMemo.ids,added=previous&&pinnedIds?pinnedIds.filter(id=>!previous.includes(id)):[];
  setPinMemo({ids:pinnedIds,fresh:added.length?new Set([...pinMemo.fresh,...added]):pinMemo.fresh});
 }
 const fresh=pinMemo.fresh;
 useEffect(()=>{
  if(!fresh.size)return;
  const timer=setTimeout(()=>setPinMemo(previous=>previous.fresh===fresh?{...previous,fresh:new Set()}:previous),pinFadeMs);
  return ()=>clearTimeout(timer);
 },[fresh]);
 const ungroupedSelected=selectedUngrouped||selectedGroupId==='unassigned';
 const rootOf=(groupId:string|undefined)=>{const seen=new Set<string>();let current=groupId?byId.get(groupId):undefined;while(current?.parentId&&byId.has(current.parentId)&&!seen.has(current.id)){seen.add(current.id);current=byId.get(current.parentId);}return current?.id;};
 const selectedRoot=selectedDevice?rootOf(primaryGroup(selectedDevice)):selectedGroupId&&selectedGroupId!=='all'?rootOf(selectedGroupId):undefined;
 const selectedFolder=folders?.folders.find(folder=>selectedRoot?folder.groupIds.includes(selectedRoot):!!selectedDevice&&folder.deviceIds.includes(selectedDevice.id));
 // A loose device inside an "Ungrouped" node, or the selected node itself, opens the node's parent (and the node).
 const selectedLoose=selectedDevice&&!primaryGroup(selectedDevice)?[...ungrouped].find(([,node])=>node.deviceIds.includes(selectedDevice.id))?.[0]:undefined;
 const revealFolder=[...(selectedFolder?['customer:'+selectedFolder.id]:[]),...(ungroupedSelected&&selectedCustomerId?['customer:'+selectedCustomerId]:[]),...(selectedLoose?[selectedLoose]:[])].join('|');
 // Reveal the path to the selected node whenever the selection changes.
 const revealPath=useMemo(()=>{
  const path:string[]=[];let current=selectedDevice?primaryGroup(selectedDevice):selectedGroupId&&selectedGroupId!=='all'?byId.get(selectedGroupId)?.parentId??undefined:undefined;
  const seen=new Set<string>();while(current&&!seen.has(current)){seen.add(current);path.push(current);current=byId.get(current)?.parentId??undefined;}
  return path.join('|');
 // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedDevice and primaryGroup derive from selectedServerId, devices and byId, which are all in the list.
 },[selectedServerId,selectedGroupId,byId,devices]);
 useEffect(()=>{if(!revealPath&&!revealFolder)return;queueMicrotask(()=>setExpanded(previous=>{const keys=[...(revealFolder?revealFolder.split('|'):[]),...(revealPath?revealPath.split('|').map(id=>'group:'+id):[])];return keys.every(key=>previous[key])?previous:{...previous,[rootKey]:true,...Object.fromEntries(keys.map(key=>[key,true]))};}));},[revealPath,revealFolder]);
 // A selected customer folder sits under "All devices", which opens so the row is visible and focusable.
 useEffect(()=>{if(!selectedCustomerId&&!ungroupedSelected)return;queueMicrotask(()=>setExpanded(previous=>previous[rootKey]?previous:{...previous,[rootKey]:true}));},[selectedCustomerId,ungroupedSelected]);

 const actions=(target:InventoryTarget,customer=false,ungroupedNode=false,pinnedNode=false):MenuEntry[]=>{
  const run=(action:InventoryAction)=>()=>onAction?.(action,target);
  if(pinnedNode)return [];
  const addDevice:MenuEntry[]=canProvision?[{id:'provision',label:t('tree.addDevice'),icon:Plus,onSelect:run('provision')}]:[];
  // "Ungrouped" has only "Add device" (of its customer, or of All devices).
  if(ungroupedNode)return onAction?addDevice:[];
  if(customer)return onAction&&target.type==='customer'?[...customerFolderActions({canCreateRootGroup,canManageCustomers}).map(({action,label})=>({id:action,label:t(label),icon:customerActionIcons[action],onSelect:run(action)})),...addDevice]:[];
  const group=target.type==='group'&&target.id?byId.get(target.id):undefined;
  if(target.type==='group'&&!group||target.type==='device'&&!devices.some(device=>device.id===target.id))return [];
  const manage=target.type==='global'?canCreateRootGroup:canManageGroups&&!!group&&(group.permissions===undefined||group.permissions.includes('groups.manage')||group.permissions.includes('*'));
  const create=canCreateRootGroup&&(target.type==='global'||manage&&!!group&&group.depth<4);
  const remove=manage&&canCreateRootGroup&&!!group&&!groups.some(child=>child.parentId===group.id);
  const entries:MenuEntry[]=[];
  // Pin or unpin: the first entry of a device row (and of its pinned row), never for a permission-only row.
  if(target.type==='device'&&target.id&&!deviceById.get(target.id)?.permissionOnly){const pinned=pinnedSet.has(target.id);entries.push({id:pinned?'unpin':'pin',label:t(pinned?'pins.unpin':'pins.pin'),icon:pinned?PinOff:Pin,onSelect:run(pinned?'unpin':'pin')});}
  if(create)entries.push({id:'create-group',label:target.type==='group'?t('tree.createSubgroup'):t('tree.createGroup'),icon:FolderPlus,onSelect:run('create-group')});
  if(manage&&target.type==='group')entries.push({id:'manage-group',label:t('console.moveDevicesHere'),icon:FolderInput,onSelect:run('manage-group')},{id:'rename-group',label:t('tree.rename'),icon:Pencil,onSelect:run('rename-group')});
  if(canManagePermissions)entries.push({id:'permissions',label:t('tree.permissions'),icon:ShieldCheck,onSelect:run('permissions')});
  if(canProvision&&target.type!=='device')entries.push({id:'provision',label:t('tree.addDevice'),icon:Plus,onSelect:run('provision')});
  if(remove)entries.push({id:'separator',separator:true},{id:'delete-group',label:t('tree.deleteGroup'),icon:Trash2,danger:true,onSelect:run('delete-group')});
  return onAction?entries:[];
 };

 // Flatten the visible tree once per render; keyboard navigation walks this list.
 const rows:Row[]=[];
 const groupVisible=(id:string,seen=new Set<string>()):boolean=>{
  const group=byId.get(id);if(!group||seen.has(id))return false;seen.add(id);
  if(!query||matches(group.name,query,locale))return true;
  return group.servers.some(device=>matches(device.name,query,locale))||groups.some(child=>child.parentId===id&&groupVisible(child.id,seen));
 };
 const deviceRow=(device:NavigationDevice,level:number,parent:string,key:string)=>{
  if(query&&!matches(device.name,query,locale))return;
  const target:InventoryTarget={type:'device',id:device.id,name:device.name};
  rows.push({key,level,parent,expandable:false,target,label:device.name,device,select:()=>{if(device.permissionOnly){if(canManagePermissions)onAction?.('permissions',target);}else onDevice(device.id);}});
 };
 const groupRow=(groupId:string,level:number,parent:string,seen:Set<string>)=>{
  const group=byId.get(groupId);if(!group||seen.has(groupId)||!groupVisible(groupId))return;
  const visited=new Set([...seen,groupId]),key='group:'+groupId,children=groups.filter(child=>child.parentId===groupId);
  const expandable=children.length>0||group.directServers.length>0,open=!!query||isOpen(key);
  rows.push({key,level,parent,expandable,target:{type:'group',id:group.id,name:group.name},label:group.name,count:group.servers.length,group:true,select:()=>onGroup(group.id)});
  if(open){for(const child of children)groupRow(child.id,level+1,key,visited);for(const device of group.directServers)deviceRow(device,level+1,key,primaryGroup(device)===groupId?'device:'+device.id:`device:${groupId}:${device.id}`);}
 };
 // The loose devices of a parent: inside its "Ungrouped" node when it has one, else directly below the parent.
 const looseRows=(looseDevices:NavigationDevice[],level:number,parent:string,customer?:{id:string;name:string})=>{
  const key=ungroupedKey(customer?.id);
  if(!ungrouped.has(key)){for(const device of looseDevices)deviceRow(device,level,parent,'device:'+device.id);return;}
  const label=t('console.ungrouped');
  if(query&&!matches(label,query,locale)&&!looseDevices.some(device=>matches(device.name,query,locale)))return;
  rows.push({key,level,parent,expandable:true,target:customer?{type:'customer',id:customer.id,name:customer.name}:{type:'global',name:t('tree.allDevices')},label,count:looseDevices.length,ungrouped:customer?.id??'',select:()=>onUngrouped?.(customer?.id)});
  if(query||isOpen(key))for(const device of looseDevices)deviceRow(device,level+1,key,'device:'+device.id);
 };
 // A customer folder opens the customer view; the caret and the arrow keys open and close it. An empty folder has nothing to open.
 const customerRow=(folder:NonNullable<typeof folders>['folders'][number])=>{
  const key='customer:'+folder.id,looseDevices=folder.deviceIds.map(id=>deviceById.get(id)!);
  if(query&&!matches(folder.name,query,locale)&&!folder.groupIds.some(id=>groupVisible(id))&&!looseDevices.some(device=>matches(device.name,query,locale)))return;
  const expandable=folder.groupIds.length+folder.deviceIds.length>0;
  rows.push({key,level:2,parent:rootKey,expandable,target:{type:'customer',id:folder.id,name:folder.name},label:folder.name,count:folder.count,customer:true,select:()=>{if(onCustomer)onCustomer(folder.id);else if(!query&&expandable)toggle(key);}});
  if(expandable&&(query||isOpen(key))){for(const id of folder.groupIds)groupRow(id,3,key,new Set());looseRows(looseDevices,3,key,folder);}
 };
 // The root node "Pinned": the pinned devices that are in servers, by name; with a filter only the matching ones, and
 // without a match no node. Its rows open, drag and have the menu of their device row.
 const pinnedDevices=pins.map(id=>deviceById.get(id)).filter((device):device is NavigationDevice=>!!device&&!device.permissionOnly&&full.has(device.id)).sort(byName(locale));
 const pinnedShown=query?pinnedDevices.filter(device=>matches(device.name,query,locale)):pinnedDevices;
 if(pinnedShown.length){
  rows.push({key:pinnedKey,level:1,parent:null,expandable:true,target:{type:'global',name:t('pins.title')},label:t('pins.title'),count:pinnedDevices.length,pinnedNode:true,select:()=>{if(!query)toggle(pinnedKey);}});
  if(query||isOpen(pinnedKey))for(const device of pinnedShown)rows.push({key:'pinned:'+device.id,level:2,parent:pinnedKey,expandable:false,target:{type:'device',id:device.id,name:device.name},label:device.name,device,pinnedRow:true,select:()=>onDevice(device.id)});
 }
 rows.push({key:rootKey,level:1,parent:null,expandable:roots.length+loose.length>0||!!folders?.folders.length,target:{type:'global',name:t('tree.allDevices')},label:t('tree.allDevices'),count:devices.length,group:true,select:onAll});
 if(query||isOpen(rootKey)){
  if(folders){for(const folder of folders.folders)customerRow(folder);for(const id of folders.rest.groupIds)groupRow(id,2,rootKey,new Set());for(const id of folders.rest.deviceIds)deviceRow(deviceById.get(id)!,2,rootKey,'device:'+id);}
  else{for(const group of roots)groupRow(group.id,2,rootKey,new Set());looseRows(loose,2,rootKey);}
 }

 const selectedKey=ungroupedSelected?ungroupedKey(selectedCustomerId):selectedCustomerId?'customer:'+selectedCustomerId:selectedDevice?'device:'+selectedDevice.id:selectedGroupId&&selectedGroupId!=='all'&&selectedGroupId!=='unassigned'?'group:'+selectedGroupId:selectedGroupId==='all'?rootKey:null;
 const tabKey=rows.some(row=>row.key===focused)?focused:rows.some(row=>row.key===selectedKey)?selectedKey!:rootKey;
 const focusRow=(key:string)=>{setFocused(key);queueMicrotask(()=>list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus());};
 const toggle=(key:string)=>setExpanded(previous=>({...previous,[key]:!(previous[key]??isOpen(key))}));
 const onKey=(event:KeyboardEvent<HTMLElement>,row:Row,index:number)=>{
  if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){if(rowActions(row).length){event.preventDefault();setMenuKey(row.key);}return;}
  const open=!!query||isOpen(row.key);
  const handled:Record<string,()=>void>={
   ArrowDown:()=>focusRow(rows[Math.min(rows.length-1,index+1)].key),
   ArrowUp:()=>focusRow(rows[Math.max(0,index-1)].key),
   Home:()=>focusRow(rows[0].key),
   End:()=>focusRow(rows[rows.length-1].key),
   ArrowRight:()=>{if(row.expandable&&!open)toggle(row.key);else if(row.expandable&&rows[index+1]?.parent===row.key)focusRow(rows[index+1].key);},
   ArrowLeft:()=>{if(row.expandable&&open&&!query)toggle(row.key);else if(row.parent)focusRow(row.parent);},
   Enter:()=>row.select(),
   ' ':()=>row.select(),
  };
  const action=handled[event.key];if(!action)return;
  event.preventDefault();action();
 };
 // Devices can be dropped on groups (move), and on "All devices" and "Ungrouped" (remove from all groups). The node
 // "Ungrouped" of a customer accepts only devices of that customer.
 const ofCustomer=(ids:readonly string[],customerId:string)=>ids.every(id=>(deviceById.get(id)?.customerId??full.get(id)?.customerId)===customerId);
 const dropTarget=(row:Row,ids:readonly string[]=draggedDeviceIds())=>!onMoveDevices?undefined
  :row.key===rootKey?(canMoveToRoot?null:undefined)
  :row.ungrouped!==undefined?(canMoveToRoot&&(!row.ungrouped||ofCustomer(ids,row.ungrouped))?null:undefined)
  :row.group&&row.target.type==='group'&&row.target.id&&canDropInto(row.target.id)?row.target.id:undefined;
 const canDropInto=(groupId:string)=>{const group=byId.get(groupId);return !!group&&canManageGroups&&(group.permissions===undefined||group.permissions.includes('groups.manage')||group.permissions.includes('*')||canCreateRootGroup);};
 const dragOver=(event:DragEvent<HTMLElement>,row:Row)=>{
  if(!event.dataTransfer.types.includes(deviceDragType))return;
  // A customer folder is no drop target, but it opens while hovered so its groups stay reachable.
  if(row.customer){if(onMoveDevices)openLater(row);return;}
  if(dropTarget(row)===undefined)return;
  event.preventDefault();event.dataTransfer.dropEffect='move';
  if(dropKey!==row.key)setDropKey(row.key);
  openLater(row);
 };
 const openLater=(row:Row)=>{if(row.expandable&&!isOpen(row.key)&&expandTimer.current?.key!==row.key){if(expandTimer.current)clearTimeout(expandTimer.current.timer);const key=row.key;expandTimer.current={key,timer:setTimeout(()=>setExpanded(previous=>({...previous,[key]:true})),700)};}};
 const dragLeave=(event:DragEvent<HTMLElement>,row:Row)=>{if(event.currentTarget.contains(event.relatedTarget as Node))return;setDropKey(current=>current===row.key?null:current);if(expandTimer.current?.key===row.key){clearTimeout(expandTimer.current.timer);expandTimer.current=null;}};
 const drop=(event:DragEvent<HTMLElement>,row:Row)=>{
  setDropKey(null);if(expandTimer.current){clearTimeout(expandTimer.current.timer);expandTimer.current=null;}
  if(dropTarget(row)===undefined||!onMoveDevices)return;
  event.preventDefault();
  try{const ids=JSON.parse(event.dataTransfer.getData(deviceDragType));if(Array.isArray(ids)&&ids.length&&ids.every(id=>typeof id==='string')){const target=dropTarget(row,ids);if(target!==undefined)onMoveDevices(ids,target);}}catch{}
 };
 const rowActions=(row:Row)=>actions(row.target,row.customer,row.ungrouped!==undefined,row.pinnedNode);
 const onContext=(event:MouseEvent<HTMLElement>,row:Row)=>{if(!rowActions(row).length)return;event.preventDefault();setFocused(row.key);setMenuKey(row.key);};

 // The rows are memoized (TreeRow): they get primitives, their device and one handlers object that keeps its identity
 // and calls the handlers of the latest render with the row's key. So expanding a node, moving the focus, a drag over a
 // node or opening a menu renders only the rows whose state changed.
 const byKey=new Map(rows.map((row,index)=>[row.key,{row,index}]));
 const live:TreeHandlers={
  focus:key=>setFocused(key),
  click:key=>{const found=byKey.get(key);if(!found)return;setFocused(key);found.row.select();},
  keyDown:(event,key)=>{const found=byKey.get(key);if(found)onKey(event,found.row,found.index);},
  contextMenu:(event,key)=>{const found=byKey.get(key);if(found)onContext(event,found.row);},
  dragStart:(event,key)=>{const device=byKey.get(key)?.row.device;if(device&&!device.permissionOnly&&onMoveDevices)startDeviceDrag(event.nativeEvent,[device.id],device.name);},
  dragOver:(event,key)=>{const found=byKey.get(key);if(found)dragOver(event,found.row);},
  dragLeave:(event,key)=>{const found=byKey.get(key);if(found)dragLeave(event,found.row);},
  drop:(event,key)=>{const found=byKey.get(key);if(found)drop(event,found.row);},
  caret:key=>{if(!query)toggle(key);},
  menuOpen:(key,open)=>setMenuKey(open?key:null),
  entries:key=>{const found=byKey.get(key);return found?rowActions(found.row):[];},
 };
 const latest=useRef(live);
 useLayoutEffect(()=>{latest.current=live;});
 const handlers=useMemo<TreeHandlers>(()=>({
  focus:key=>latest.current.focus(key),click:key=>latest.current.click(key),keyDown:(event,key)=>latest.current.keyDown(event,key),
  contextMenu:(event,key)=>latest.current.contextMenu(event,key),dragStart:(event,key)=>latest.current.dragStart(event,key),
  dragOver:(event,key)=>latest.current.dragOver(event,key),dragLeave:(event,key)=>latest.current.dragLeave(event,key),drop:(event,key)=>latest.current.drop(event,key),
  caret:key=>latest.current.caret(key),menuOpen:(key,open)=>latest.current.menuOpen(key,open),entries:key=>latest.current.entries(key),
 }),[]);

 return <ul ref={list} className="sdx-tree" role="tree" aria-label={t('tree.label')}>
  {rows.map(row=>{
   const kind:TreeRowKind=row.key===rootKey?'root':row.pinnedNode?'pinned':row.customer?'customer':row.ungrouped!==undefined?'ungrouped':row.group?'group':row.device?.permissionOnly?'permission':'device';
   return <TreeRow key={row.key} rowKey={row.key} level={row.level} label={row.label} count={row.count} kind={kind} server={row.device&&full.get(row.device.id)}
    expandable={row.expandable} open={!!query||isOpen(row.key)} selected={selectedKey===row.key} tabbable={tabKey===row.key} menuOpen={menuKey===row.key} dropTarget={dropKey===row.key}
    current={!!row.pinnedRow&&row.device?.id===selectedServerId} fresh={!!row.pinnedRow&&!!row.device&&fresh.has(row.device.id)} logo={row.customer&&row.target.id?customerLogos?.[row.target.id]:undefined}
    draggable={!!onMoveDevices&&kind==='device'} hasMenu={rowActions(row).length>0} handlers={handlers}/>;
  })}
  {query&&rows.length===1&&<li className="sdx-tree-empty" role="none">{t('tree.noMatch',{trim:filter.trim()})}</li>}
 </ul>;
});

type TreeRowKind='root'|'pinned'|'customer'|'ungrouped'|'group'|'device'|'permission';
/** The handlers of the tree's rows: one object per tree, each call names its row by key. */
type TreeHandlers={
 focus:(key:string)=>void;click:(key:string)=>void;keyDown:(event:KeyboardEvent<HTMLElement>,key:string)=>void;contextMenu:(event:MouseEvent<HTMLElement>,key:string)=>void;
 dragStart:(event:DragEvent<HTMLElement>,key:string)=>void;dragOver:(event:DragEvent<HTMLElement>,key:string)=>void;dragLeave:(event:DragEvent<HTMLElement>,key:string)=>void;drop:(event:DragEvent<HTMLElement>,key:string)=>void;
 caret:(key:string)=>void;menuOpen:(key:string,open:boolean)=>void;entries:(key:string)=>MenuEntry[];
};
type TreeRowProps={rowKey:string;level:number;label:string;count?:number;kind:TreeRowKind;
 /** The full device of a device row, for its connection dot. */
 server?:Device;
 expandable:boolean;open:boolean;selected:boolean;
 /** A pinned row of the open device: aria-current with a quieter look; the main row stays the selected item. */
 current?:boolean;
 /** A row pinned during the session: it fades in once. */
 fresh?:boolean;
 /** The logo of a customer folder (its avatar shows the initials without one). */
 logo?:BrandingLogoPair;
 /** The row is the tree's one Tab stop (roving tabindex). */
 tabbable:boolean;menuOpen:boolean;dropTarget:boolean;draggable:boolean;hasMenu:boolean;handlers:TreeHandlers};
/** The glyph of each kind; a device row shows the glyph of its device type, a customer folder its avatar. */
const kindIcons:Record<Exclude<TreeRowKind,'customer'>,typeof Server>={root:Layers,pinned:Pin,ungrouped:Inbox,group:Folder,device:Server,permission:ShieldCheck};
/**
 * One row of the tree. Memoized; a device row follows the console clock through its tone (deviceToneState): it renders
 * again when the device goes online or offline or its registration expires, not on every tick.
 */
const TreeRow=memo(function TreeRow({rowKey:key,level,label,count,kind,server,expandable,open,selected,current=false,fresh=false,logo,tabbable,menuOpen,dropTarget,draggable,hasMenu,handlers}:TreeRowProps){
 const t=useT(),[locale]=useLocale(),now=useClockTransition(time=>server?deviceToneState(server,time):'');
 const connection=server?deviceConnection(server,now,locale):null,issues=server?deviceIssues(server,now,locale):[];
 const tone=kind==='permission'||!connection?'neutral':connection.kind==='online'?issues.some(issue=>issue.level==='critical')?'critical':issues.some(issue=>issue.level==='warning')?'warning':'online':connection.kind;
 const Icon=kind==='customer'?null:kind==='group'&&open?FolderOpen:kind==='device'&&server?deviceTypeIcons[deviceType(server)]:kindIcons[kind];
 return <li role="treeitem" data-key={key} aria-level={level} aria-selected={selected} aria-current={current?'true':undefined} aria-expanded={expandable?open:undefined} aria-label={count!==undefined?`${label} (${count})`:kind==='permission'?t('tree.permissionOnly',{label}):label}
  tabIndex={tabbable?0:-1} className={cx('sdx-tree-row',selected&&'active',current&&'current',fresh&&'is-fresh',menuOpen&&'menu-open',dropTarget&&'drop-target')} style={{paddingLeft:6+(level-1)*14}}
  draggable={draggable} onDragStart={draggable?event=>handlers.dragStart(event,key):undefined}
  onDragOver={event=>handlers.dragOver(event,key)} onDragLeave={event=>handlers.dragLeave(event,key)} onDrop={event=>handlers.drop(event,key)}
  onFocus={()=>handlers.focus(key)} onKeyDown={event=>handlers.keyDown(event,key)} onClick={()=>handlers.click(key)} onContextMenu={event=>handlers.contextMenu(event,key)}>
  {expandable?<span className={cx('sdx-tree-caret',open&&'open')} aria-hidden="true" onClick={event=>{event.stopPropagation();handlers.caret(key);}}><ChevronRight size={13}/></span>:<span className="sdx-tree-caret"/>}
  <span className={cx('sdx-tree-icon',!Icon&&'sdx-tree-icon-avatar')}>{Icon?<Icon size={15} aria-hidden/>:<CustomerAvatar name={label} logo={logo}/>}{kind==='device'&&<i className={'sdx-dot sdx-dot-'+tone} title={connection?.label}/>}</span>
  <span className="sdx-tree-label" title={label}>{label}</span>
  {count!==undefined&&<small className="sdx-tree-count">{count}</small>}
  {hasMenu&&<span className="sdx-tree-menu" onClick={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()}><Menu label={t('tree.actionsFor',{label})} entries={()=>handlers.entries(key)} align="start" open={menuOpen} onOpenChange={next=>handlers.menuOpen(key,next)} trigger={<button type="button" tabIndex={-1} className="sdx-icon-btn sdx-btn-ghost sdx-tree-more" aria-label={t('tree.actionsFor',{label})} title={t('tree.actionsShortcut')}><MoreHorizontal size={15} aria-hidden/></button>}/></span>}
 </li>;
});
