'use client';
import {memo,useCallback,useEffect,useMemo,useState,type CSSProperties,type DragEvent as ReactDragEvent,type ReactNode} from 'react';
import {AlertTriangle,Info,OctagonAlert,Building2,ChevronRight,Columns3,FolderCheck,FolderInput,FolderMinus,FolderOpen,HardDrive,LayoutGrid,List,MonitorSmartphone,Pin,PinOff,Plus,RotateCw,Search,SquareTerminal,Tag,Trash2,X} from 'lucide-react';
import type {AuditEntry,DeviceGroup,Job,Viewer} from '@/lib/types';
import {deviceClockState,deviceConnection,deviceHasIssues,deviceIssues,diskSummary,liveValue,registrationNote} from '@/ui/base/ui-device';
import {connectionKind} from '@/lib/device-connection';
import {recentCrashes} from '@/ui/devices/inventory/health-signals';
import {primaryDeviceAddress} from '@/ui/devices/device/device-network';
import {compareFleetDevices,fleetSortFirst,fleetSortValue,fleetTableSort,shownFleetSort,type FleetSortKey} from '@/ui/devices/fleet/fleet-sort';
import {availableFleetColumns,customerColumnDistinguishes,defaultFleetColumns,groupColumnShows,fleetColumnNames,fleetSearchPlaceholder,fleetSearchText,parseFleetColumns,type Columns,type FleetColumnKey} from '@/ui/devices/fleet/fleet-columns';
import {FleetAgentUpdateCell,FleetAgentUpdateToolbar,FleetAgentUpdates} from '@/ui/devices/fleet/fleet-agent-updates';
import {bulkDeviceRemovalConfirmation,deviceRemovalConfirmation,type RemovalContext} from '@/ui/devices/device/device-removal';
import HistoryPanel,{scopeHistoryCounts} from '@/ui/devices/history/history';
import {BulkTagDrawer,TagChips,devicesWithoutTagRight,directTagNames} from '@/ui/devices/configuration/tags';
import {fleetTagNames,fleetTagValues,matchesFleetTagFilter} from '@/ui/devices/fleet/fleet-tags';
import {tagKey} from '@/lib/tags';
import FleetCsvExport from '@/ui/devices/fleet/fleet-export';
import type {Confirmation} from '@/ui/base/confirmation';
import type {DeviceSection} from '@/lib/console-route';
import {scopeTabGroup,scopeTabGroups,type FleetScope} from '@/ui/devices/fleet/fleet-scope';
import {scopeTabHref,scopeTabs,shownScopeTab,type NavNode} from '@/ui/shell/nav-model';
import {fleetFilterLabels,fleetFilterMatch,fleetFilters,isFleetFilter,type FleetFilter} from '@/ui/devices/fleet/fleet-filters';
import {batteryHealth,bitlockerStatus,bitlockerStatusKey,bitlockerStatusTone,deviceDiskHealth,diskHealthStatusKey,diskHealthTone,maxWear,osSupportText} from '@/ui/devices/inventory/health-signals';
import DriversTab from '@/ui/devices/inventory/drivers-tab';
import ReliabilityTab from '@/ui/devices/inventory/reliability-tab';
import CertificatesTab from '@/ui/devices/inventory/certificates-tab';
import AutostartTab from '@/ui/devices/inventory/autostart-tab';
import SoftwareTab from '@/ui/devices/inventory/software-tab';
import ExtensionsTab from '@/ui/devices/extensions/extensions-tab';
import type {PluginReleaseSummary} from '@/lib/plugin-catalog';
import OsSupportTab,{toneKind} from '@/ui/devices/inventory/os-support';
import EncryptionTab from '@/ui/devices/inventory/encryption-tab';
import ProtectionTab from '@/ui/devices/protection/protection-tab';
import AlarmsTab from '@/ui/devices/monitoring/alarms';
import ProblemsTab,{HealthPill} from '@/ui/devices/monitoring/problems';
import {PowerDrawer,powerMenuEntry,type PowerTarget} from '@/ui/devices/management/device-power';
import {permitted,type Device} from '@/ui/base/api';
import {Btn,Empty,EntranceList,IconBtn,Menu,Meter,Segmented,StatusPill,connectionPillKind,cx,exactTime,percentLabel,relativeTime,shortOs,type EmptyProps,type MenuEntry} from '@/ui/kit/kit';
import {alarmTabCount} from '@/ui/devices/monitoring/alarms-view';
import {DeviceTypeMark} from '@/ui/devices/device/device-type-mark';
import {deviceManufacturer} from '@/ui/devices/hardware/manufacturer-model';
import {ManufacturerMark} from '@/ui/devices/hardware/manufacturer-mark';

import {useLocale,useT,type Translate} from '@/ui/base/locale';
import {consoleClock,useClockTransition} from '@/ui/base/clock-store';
import {useStableCallback} from '@/ui/base/stable-callback';
import {DataTable,FilterPopover,Toolbar,BulkBar,type DataColumn} from '@/ui/kit/data-table';
import {Tabs,tabId,type TabItem} from '@/ui/kit/tabs';
import {Field,Select} from '@/ui/kit/field';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {EMPTY_VALUE,formatNumber,formatPercent} from '@/lib/i18n/format';
import {canManageInstanceSettings} from '@/ui/base/access-capabilities';
import {customerMoveBlocked,customerMoveShown,type CustomerMoveEntry} from '@/ui/devices/fleet/customer-move-model';
type Layout='table'|'cards';
export type StatusFilter='all'|'online'|'warning'|'offline';
/** The fleet tab: Devices or a subtab of Monitoring, Inventory, History or Configuration (fleetScopeTabs in ui/devices/fleet/fleet-scope.ts). */
export type FleetTab='devices'|'problems'|'alarms'|'jobs'|'access'|'software'|'extensions'|'os-support'|'encryption'|'protection'|'drivers'|'reliability'|'certificates'|'autostart'|'alerts'|'notifications'|'tags'|'permissions'|'settings';
/** The id of the scope tab panel; the active scope tab names it (aria-controls) and labels it (aria-labelledby). */
export const fleetPanelId='sdx-fleet-panel';
/** The id of the subtab panel inside it; the active pill subtab names and labels it. */
export const fleetSubpanelId='sdx-fleet-subpanel';
/** Drag payload for devices: a JSON array of device IDs. */
export const deviceDragType='application/x-serverdesk-devices';
const read=<T,>(key:string,fallback:T,validate:(value:unknown)=>T|null):T=>{try{const value=validate(JSON.parse(localStorage.getItem(key)??'null'));return value??fallback;}catch{return fallback;}};
const write=(key:string,value:unknown)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};

type Props={
 header:ReactNode;
 /** The devices the account pinned (ConsoleData.preferences.pinnedDeviceIds): the row menu offers pin or unpin. */
 pinnedIds?:readonly string[];
 /** Pins or unpins a device (ui/shell/pin-toggle.ts); without it the row menu has no pin entry. */
 onPin?:(id:string)=>void;
 servers:Device[];
 scoped:Device[];
 groupEmpty:boolean;
 /** The customer view of a customer without devices. */
 customerEmpty?:boolean;
 /** An Ungrouped scope without devices; onShowAll opens the scope above it (All devices or the customer). */
 ungroupedEmpty?:boolean;onShowAll?:()=>void;
 viewer:Viewer;demo:boolean;saving:boolean;
 /** The newest active release of each agent extension, for the scope tab Extensions. */
 pluginReleases?:PluginReleaseSummary[];
 jobs:Job[];audit:AuditEntry[];
 /** The console's last successful load (checkedAt of useConsoleData), the freshness of the History subtabs; null before it. */
 updatedAt?:number|null;
 tab:FleetTab;onTab:(tab:FleetTab)=>void;
 canOffboard:boolean;
 /** Opens a device, optionally on an area and its subarea (for example management/storage). */
 onOpen:(id:string,section?:DeviceSection,detail?:string)=>void;
 /** The scope of this view, for the software tab's query and the group's ESU date. */
 scope?:FleetScope;
 /** Opens a group on its OS support tab (the origin of an inherited ESU date). */
 onOpenEsuGroup?:(groupId:string)=>void;
 /** Opens the customer on its OS support tab; absent without the customer view. */
 onOpenEsuCustomer?:(customerId:string)=>void;
 onConfirm:(confirmation:Confirmation)=>void;
 /** Open uninstall jobs (and the clock) for the removal dialog's uninstall switch. */
 removalContext?:RemovalContext;
 onSelectJob:(job:Job)=>void;onCancelJob:(job:Job)=>void;
 onUpdated:()=>Promise<void>|void;
 /** "Add device" for the Owner: the add-device page with the scope's group or customer. */
 onProvision?:()=>void;onDemo:()=>void;
 group?:DeviceGroup;
 permissions?:ReactNode;settings?:ReactNode;
 /** Monitoring › Alert rules of this scope (All devices, a customer or a group); every viewer of the scope gets it. */
 alerts?:ReactNode;
 /** Monitoring › Notification rules of All devices, a group or a customer (with several customers). */
 notifications?:ReactNode;
 /** The Monitoring summary row of the default Monitoring subtab (By device); scopes without rules subtabs have none. */
 monitoringSummary?:ReactNode;
 /** The "Tags" area of a device group; only a group scope gets it. */
 tags?:ReactNode;
 canMove:boolean;onMove:(ids:string[])=>void;
 /** "Move to another customer…" in the row menu and the selection bar (ui/devices/fleet/customer-move-model.ts); without it neither shows. */
 customerMove?:CustomerMoveEntry;
 onRemoveFromGroup?:(ids:string[])=>Promise<boolean>;
 /** "Move devices here…" on a group the viewer may manage. */
 onAssign?:()=>void;
 /** The customer column, card line, search and CSV column (several customers, not in demo mode). */
 customerColumn:boolean;
};

/** The fields of the Filters popover. Search and status stay outside it. */
export type FleetFilters={type:string;filter:FleetFilter;tagName:string;tagValue:string|null};
export const emptyFleetFilters:FleetFilters={type:'all',filter:'all',tagName:'',tagValue:null};
/** How many filters of the popover are set: type, state, and a chosen tag (with its value) as one. activeTag is the chosen tag that exists in the scope. */
export function fleetFilterCount(filters:Pick<FleetFilters,'type'|'filter'>,activeTag:string):number{
 return (filters.type!=='all'?1:0)+(filters.filter!=='all'?1:0)+(activeTag?1:0);
}

type RowAction={blocked?:string;onSelect:()=>void};
/**
 * The row menu of a device: Open, Terminal, Files, Restart… (always, blocked with its reason where it cannot run),
 * Move to group (when moving is shown), Move to another customer (when it is shown), then a separator and Remove device
 * (with the removal right).
 */
export function fleetRowMenu({move,customerMove,restart,removal,pin,onOpen}:{move?:RowAction;customerMove?:RowAction;restart:RowAction;removal?:RowAction;pin?:RowAction&{pinned:boolean};onOpen:(section?:DeviceSection)=>void},t:Translate):MenuEntry[]{
 return [
  {id:'open',label:t('common.open'),icon:ChevronRight,onSelect:()=>onOpen()},
  ...(pin?[{id:pin.pinned?'unpin':'pin',label:t(pin.pinned?'pins.unpin':'pins.pin'),icon:pin.pinned?PinOff:Pin,blocked:pin.blocked,onSelect:pin.onSelect}]:[]),
  {id:'terminal',label:t('device.section.terminal'),icon:SquareTerminal,onSelect:()=>onOpen('terminal')},
  {id:'files',label:t('fleet.menu.files'),icon:FolderOpen,onSelect:()=>onOpen('files')},
  {id:'restart',label:t('device.menu.restart'),icon:RotateCw,blocked:restart.blocked,onSelect:restart.onSelect},
  ...(move?[{id:'move',label:t('groups.assign.submit'),icon:FolderInput,blocked:move.blocked,onSelect:move.onSelect}]:[]),
  ...(customerMove?[{id:'move-customer',label:t('devices.customerMove.menu'),icon:Building2,blocked:customerMove.blocked,onSelect:customerMove.onSelect}]:[]),
  ...(removal?[{id:'separator',separator:true as const},{id:'remove',label:t('console.removal.button'),icon:Trash2,danger:true,blocked:removal.blocked,onSelect:removal.onSelect}]:[]),
 ];
}

/** The devices of the drag in progress: a drop target that depends on them (the "Ungrouped" node of a customer) reads them on dragover, where the payload is hidden. */
let draggedIds:readonly string[]=[];
export const draggedDeviceIds=():readonly string[]=>draggedIds;
/** Start dragging devices: the selection when the row is part of it, otherwise just this device. */
export function startDeviceDrag(event:DragEvent,ids:string[],label:string,locale:Locale=defaultLocale){
 if(!event.dataTransfer)return;
 draggedIds=[...ids];
 event.dataTransfer.setData(deviceDragType,JSON.stringify(ids));
 event.dataTransfer.setData('text/plain',label);
 event.dataTransfer.effectAllowed='move';
 const chip=document.createElement('div');
 chip.className='sdx-drag-chip';chip.textContent=ids.length===1?label:translate(locale,'fleet.dragCount',{count:ids.length});
 document.body.appendChild(chip);
 event.dataTransfer.setDragImage(chip,16,16);
 setTimeout(()=>chip.remove(),0);
}

/** The menu element of a row or card per device (rowMenuCache), with the ids it holds and its eviction. */
export type RowMenuCache=((device:Pick<Device,'id'|'name'>)=>ReactNode)&{
 /** The ids that have an element, in insertion order. */
 ids():string[];
 /** Drops the element of every id that is not one of these devices; the others keep their element. */
 retain(devices:readonly Pick<Device,'id'>[]):void;
};
/**
 * One element per device from build, held by id with the name it was built for: a list that renders a row again gets
 * the same menu element; a renamed device gets a new one (its label names the device) in place of the old one.
 * FleetView calls retain with its device list after each change of it, so devices that left do not stay. Exported for tests.
 */
export function rowMenuCache(build:(device:Pick<Device,'id'|'name'>)=>ReactNode):RowMenuCache{
 const entries=new Map<string,{name:string;element:ReactNode}>();
 const menu=(device:Pick<Device,'id'|'name'>)=>{
  let entry=entries.get(device.id);
  if(entry?.name!==device.name){entry={name:device.name,element:build(device)};entries.set(device.id,entry);}
  return entry.element;
 };
 return Object.assign(menu,{
  ids:()=>[...entries.keys()],
  retain(devices:readonly Pick<Device,'id'>[]){
   if(!entries.size)return;
   const present=new Set(devices.map(device=>device.id));
   for(const id of entries.keys())if(!present.has(id))entries.delete(id);
  },
 });
}

/**
 * How many changed rows of the Devices table render per frame (DataTable rowChunk): a heartbeat refresh changes every
 * device, and the frame that renders it also renders the console, the tree and FleetView itself. With 25 rows that
 * frame and each later one stay short; 250 devices update in ten chunks, well within a second.
 */
export const fleetRowChunk=25;
const connectionMarks={online:'n',offline:'f',waiting:'w',maintenance:'m'} as const;
/**
 * What the counts, the filter and the order of the fleet view take from the clock, as one string: each device's
 * connection state (which also decides which issues show and whether CPU and RAM are live) and, with the Crashes
 * filter, whether the device had a crash in the last 30 days. Exported for tests.
 */
export function fleetClockState(scoped:readonly Device[],now:number,filter:FleetFilter):string{
 let state='';
 for(const server of scoped)state+=connectionMarks[connectionKind(server,now)]+(filter==='crashes'?(recentCrashes(server,now,30).length?'c':'-'):'');
 return state;
}

/**
 * Fleet overview: one toolbar for search and status, then a table or cards. Memoized: the console hands it props that
 * keep their identity, so a console render that changes nothing it shows (another clock-derived value, an unchanged
 * refresh) does not render it. Tests call the plain function as FleetView.type.
 */
function FleetView({header,pinnedIds,onPin,servers,scoped,groupEmpty,customerEmpty=false,ungroupedEmpty=false,onShowAll,viewer,demo,saving,pluginReleases,jobs,audit,updatedAt=null,tab:requestedTab,onTab,canOffboard,onOpen,onConfirm,removalContext,onSelectJob,onCancelJob,onUpdated,onProvision,onDemo,group,permissions,settings,alerts,notifications,tags,monitoringSummary,canMove,onMove,customerMove,onRemoveFromGroup,onAssign,customerColumn,scope={type:'all'},onOpenEsuGroup,onOpenEsuCustomer}:Props){
 const t=useT(),[locale]=useLocale();
 // The tabs whose content the console passes; a tab without it shows the Devices tab.
 const present={permissions:!!permissions,settings:!!settings,tags:!!tags,notifications:!!notifications,alerts:!!alerts};
 const tab:FleetTab=shownScopeTab(requestedTab,present);
 const [search,setSearch]=useState(''),[status,setStatus]=useState<StatusFilter>('all'),[chosenSort,setSort]=useState('name');
 // The Group column, its menu entry and the card's group line only while a device of the scope is in a group: without
 // one, every row would read "No group". The stored column choice stays; a sort by group falls back to the name.
 const groupShows=useMemo(()=>groupColumnShows(scoped),[scoped]);
 const sort=shownFleetSort(chosenSort,groupShows);
 // The tag filter starts empty for every scope: the console mounts one FleetView per scope.
 // Type, state, tag and tag value: the fields of the Filters popover, kept together so "Reset filter" sets them back at once.
 const [filters,setFilters]=useState<FleetFilters>(emptyFleetFilters),{type,filter,tagName,tagValue}=filters;
 const setType=(value:string)=>setFilters(previous=>({...previous,type:value}));
 const setFilter=(value:FleetFilter)=>setFilters(previous=>({...previous,filter:value}));
 // A new tag starts with any value.
 const setTagName=(value:string)=>setFilters(previous=>({...previous,tagName:value,tagValue:null}));
 const setTagValue=(value:string|null)=>setFilters(previous=>({...previous,tagValue:value}));
 const [bulkTag,setBulkTag]=useState<'add'|'remove'|null>(null);
 // The power drawer of a row menu (Restart…): the device and the operation, or null.
 const [power,setPower]=useState<PowerTarget|null>(null);
 const tagNames=useMemo(()=>fleetTagNames(scoped),[scoped]),activeTag=tagNames.find(name=>tagKey(name)===tagKey(tagName))??'';
 const tagValues=useMemo(()=>activeTag?fleetTagValues(scoped,activeTag):[],[scoped,activeTag]);
 const tagFilter=useMemo(()=>activeTag?{name:activeTag,value:tagValue!==null&&tagValues.includes(tagValue)?tagValue:null}:null,[activeTag,tagValue,tagValues]);
 const [columns,setColumns]=useState<Columns>(defaultFleetColumns),[layout,setLayout]=useState<Layout>('table'),[selection,setSelection]=useState<string[]>([]);
 useEffect(()=>{queueMicrotask(()=>{
  // The stored choice; an equal one keeps the current object, so the columns and the memoized rows stay as they are.
  setColumns(previous=>{const stored=read('serverdesk.redesign.columns',defaultFleetColumns,parseFleetColumns);return (Object.keys(stored) as FleetColumnKey[]).every(key=>stored[key]===previous[key])?previous:stored;});
  setLayout(read<Layout>('serverdesk.redesign.layout',window.matchMedia('(max-width: 760px)').matches?'cards':'table',value=>value==='table'||value==='cards'?value:null));
 });},[]);
 useEffect(()=>{queueMicrotask(()=>setSelection(previous=>{const valid=previous.filter(id=>servers.some(server=>server.id===id));return valid.length===previous.length?previous:valid;}));},[servers]);
 // The clock: the counts, the filter and the order change with it only through each device's connection state (and
 // the 30-day crash window of the Crashes filter). FleetView renders again on the tick that changes one of them; a
 // relative time or a meter of one device renders only its row or card (rowClock, DeviceCard).
 const now=useClockTransition(time=>fleetClockState(scoped,time,filter));
 const counts=useMemo(()=>({
  all:scoped.length,
  online:scoped.filter(server=>connectionKind(server,now)==='online').length,
  warning:scoped.filter(server=>deviceHasIssues(server,now)).length,
  offline:scoped.filter(server=>connectionKind(server,now)==='offline').length,
 }),[scoped,now]);
 // The open alarms of the scope as the "Monitoring" tab count, in the tone of the worst level: the fleet-wide alarm signal.
 const alarmCount=useMemo(()=>alarmTabCount(scoped),[scoped]);
 const visible=useMemo(()=>scoped.filter(server=>{
  const client=server.snapshot?.os.includes('Windows 11')===true,connection=connectionKind(server,now);
  const typeMatch=type==='all'||(type==='client'?client:type==='server'?!!server.snapshot&&!client:!server.snapshot);
  const statusMatch=status==='all'||(status==='warning'?deviceHasIssues(server,now):connection===status);
  return typeMatch&&statusMatch&&fleetFilterMatch(server,filter,now)&&matchesFleetTagFilter(server,tagFilter)&&fleetSearchText(server).includes(search.trim().toLowerCase());
 }).sort((a,b)=>compareFleetDevices(a,b,sort,now)),[scoped,type,status,filter,search,sort,now,tagFilter]);
 const selected=servers.filter(server=>selection.includes(server.id));
 // The Customer column, its menu entry, the card line and the search placeholder only where devices of two or more customers show.
 const customerDistinct=useMemo(()=>customerColumn&&customerColumnDistinguishes(scoped),[customerColumn,scoped]);
 const showCustomer=customerDistinct&&columns.customer;
 const toggleColumn=(key:FleetColumnKey)=>setColumns(previous=>{const next={...previous,[key]:!previous[key]};write('serverdesk.redesign.columns',next);return next;});
 const changeLayout=(next:Layout)=>{setLayout(next);write('serverdesk.redesign.layout',next);};
 // Tags need Manage device groups and permissions on each device (lib/server/devices/tag-store.ts); the server checks it again.
 const tagManager=demo||servers.some(server=>permitted(server,viewer,'groups.manage'));
 const selectable=canOffboard||canMove||tagManager,draggable=canMove&&!demo;
 const missingTagRight=devicesWithoutTagRight(selected,viewer).length;
 const tagBlocked=demo?t('kit.unavailable.demo'):missingTagRight?t('tags.bulk.noRight',{count:missingTagRight}):undefined;
 const directMembers=selected.filter(server=>group&&(server.groupId===group.id||server.groups?.some(item=>item.id===group.id&&item.direct)));
 const dragIds=(server:Device)=>selection.includes(server.id)?selection:[server.id];
 const demoBlocked=demo?t('kit.unavailable.demo'):undefined;
 // The row menu: the shared power flow (Restart…) of the device menu and the System card, blocked with its reason where it cannot run.
 // Its entries are built when a row menu opens (kit Menu with an entries function), with the latest state and clock,
 // so the menu of a row keeps its identity and the rows stay memoized.
 // The menu of a row or card is one element per device (rowMenuCache): a row that renders again (a heartbeat) keeps it,
 // so React skips the menu; its entries read the device's latest data by id when the menu opens.
 const rowMenu=useStableCallback((id:string)=>{const server=servers.find(item=>item.id===id);return !server?[]:fleetRowMenu({move:canMove||demo?{blocked:demoBlocked,onSelect:()=>onMove([server.id])}:undefined,
  customerMove:customerMove&&customerMoveShown({...customerMove,devices:[server]})?{blocked:customerMoveBlocked({devices:[server],viewer,demo,saving},t),onSelect:()=>void customerMove.onMove([server.id])}:undefined,
  pin:onPin||demo?{pinned:!!pinnedIds?.includes(server.id),blocked:demoBlocked,onSelect:()=>onPin?.(server.id)}:undefined,
  restart:powerMenuEntry('restart-computer',{server,viewer,demo,saving,now:consoleClock.now()},setPower,locale),
  removal:canOffboard?{blocked:demo?t('kit.unavailable.demo'):saving?t('fleet.menu.saving'):undefined,onSelect:()=>onConfirm(deviceRemovalConfirmation(server,locale,removalContext))}:undefined,
  onOpen:section=>onOpen(server.id,section)},t);});
 const menu=useMemo(()=>rowMenuCache(device=><Menu label={t('tree.actionsForName',{name:device.name})} entries={()=>rowMenu(device.id)}/>),[t,rowMenu]);
 // A refresh or a scope change gives a new device list: the menus of devices that left it go, after the commit (the
 // rows that stay keep their element, so they stay memoized).
 useEffect(()=>menu.retain(servers),[menu,servers]);
 // The clock-derived state of a row or card (ui/base/ui-device.ts): the row renders again only when it changes.
 const rowClock=useCallback((server:Device,time:number)=>deviceClockState(server,time,locale),[locale]);
 // The handlers of the cards: one function each for all cards, so a card renders only when its device or selection changes.
 const selectCard=useCallback((checked:boolean,server:Device)=>setSelection(previous=>checked?[...new Set([...previous,server.id])]:previous.filter(id=>id!==server.id)),[]);
 const openCard=useStableCallback((server:Device)=>onOpen(server.id));
 const dragCard=useStableCallback((event:ReactDragEvent,server:Device)=>startDeviceDrag(event.nativeEvent,dragIds(server),server.name,locale));
 // Type, state and tag (with its value) count as one filter each; search and status stay outside the popover.
 const filterCount=fleetFilterCount(filters,activeTag);
 const resetFilters=()=>setFilters(emptyFleetFilters);
 // The empty Devices table names its cause and offers one next step: Add device for the Owner, else Move devices here… on a group.
 // Both are secondary: the page header shows the same action, and its "Add device" is the one primary of the view.
 const addDevice=onProvision?<Btn icon={Plus} onClick={onProvision}>{t('console.addDevice')}</Btn>:undefined;
 const empty:EmptyProps=customerEmpty?{icon:Building2,title:t('fleet.empty.customer'),children:t('fleet.empty.customerHint'),action:addDevice}
  :ungroupedEmpty?{icon:FolderCheck,title:t('fleet.empty.ungrouped'),children:t('fleet.empty.ungroupedHint'),action:onShowAll&&<Btn icon={MonitorSmartphone} onClick={onShowAll}>{t('fleet.empty.showAll')}</Btn>}
  :groupEmpty?{icon:FolderOpen,title:t('fleet.empty.group'),children:t('fleet.empty.groupHint'),action:addDevice??(onAssign&&<Btn icon={FolderInput} onClick={onAssign}>{t('console.moveDevicesHere')}</Btn>)}
  :servers.length?{icon:Search,title:t('fleet.empty.filter'),children:t('fleet.empty.filterHint'),action:<Btn variant="ghost" icon={X} onClick={()=>{setSearch('');setStatus('all');resetFilters();}}>{t('fleet.empty.resetFilter')}</Btn>}
  :{icon:MonitorSmartphone,title:t('fleet.empty.none'),children:t('fleet.empty.noneHint'),action:<div className="sdx-row">{onProvision&&<Btn variant="primary" icon={Plus} onClick={onProvision}>{t('tree.addDevice')}</Btn>}<Btn onClick={onDemo}>{t('fleet.empty.showSamples')}</Btn></div>};
 // The five scope tabs of the navigation model in order. A tab shows the subtabs whose content the console passes (alerts,
 // notifications, tags, permissions and settings only under their scope and right) and is left out without one.
 const shownTabs=scopeTabs.map(node=>({node,subtabs:(node.children??[]).filter(child=>shownScopeTab(child.tab!,present)===child.tab)})).filter(({node,subtabs})=>!node.children||subtabs.length>0);
 const openTab=scopeTabGroup(tab);
 /** The default fleet tab of a scope tab: its first shown subtab. */
 const defaultTab=(item:{node:NavNode;subtabs:NavNode[]})=>(item.subtabs[0]?.tab??item.node.tab!) as FleetTab;
 const tabs:TabItem[]=shownTabs.map(item=>({id:item.node.scopeTab!,label:t(item.node.label),...(item.node.scopeTab==='devices'?{count:scoped.length}:item.node.scopeTab==='monitoring'&&alarmCount?alarmCount:{}),href:scopeTabHref(scope,defaultTab(item))}));
 const chooseTab=(id:string)=>{const item=shownTabs.find(entry=>entry.node.scopeTab===id);if(item)onTab(defaultTab(item));};
 // The pill subtab bar of the open tab: link tabs to the subtab routes, only with two or more shown subtabs.
 const subtabs=shownTabs.find(item=>item.node.scopeTab===openTab)?.subtabs??[];
 const historyCounts=openTab==='history'?scopeHistoryCounts({scoped,viewer,jobs,audit,demo}):null;
 const subtabItems:TabItem[]=subtabs.map(node=>({id:node.tab!,label:t(node.label),...(node.tab==='jobs'&&historyCounts?{count:historyCounts.jobs}:node.tab==='access'&&historyCounts?.access!==undefined?{count:historyCounts.access}:{}),href:scopeTabHref(scope,node.tab!)}));
 const subtabLabel=scopeTabGroups.find(item=>item.id===openTab)?.subtabs;
 /** The next step of an empty analysis tab: the Devices tab, where the agent state shows why nothing is reported. */
 const showDevices=()=>onTab('devices');
 // The Status column is wider while a shown device carries a long connection label (waiting for its first report, or
 // its registration expired; agent maintenance); the clock-derived `now` changes when a device's connection state does.
 const longStatus=useMemo(()=>visible.some(server=>longStatusKinds.has(connectionKind(server,now))),[visible,now]);
 const columnsOf=useMemo(()=>fleetTableColumns({columns,showCustomer,showGroup:groupShows,longStatus,locale,t,menu}),[columns,showCustomer,groupShows,longStatus,locale,t,menu]);

 const toolbar=<Toolbar className="sdx-fleet-toolbar"
  search={{id:'sdx-fleet-search',value:search,onChange:setSearch,label:t('groups.assign.filter'),placeholder:fleetSearchPlaceholder(customerDistinct,locale),shortcut:'/'}}
  filters={<>
   <Segmented<StatusFilter> label={t('fleet.col.status')} size="sm" value={status} onChange={setStatus} items={[{id:'all',label:t('fleet.status.all'),count:counts.all},{id:'online',label:t('device.connection.online'),count:counts.online,tone:'online'},{id:'warning',label:t('fleet.status.warning'),count:counts.warning,tone:'warning'},{id:'offline',label:t('device.connection.offline'),count:counts.offline,tone:'offline'}]}/>
   <FilterPopover label={t('fleet.filters.button')} title={t('fleet.filters.title')} active={filterCount} activeLabel={t('fleet.filters.activeLabel',{count:filterCount})} onReset={resetFilters} resetLabel={t('fleet.empty.resetFilter')}>
    <Field label={t('fleet.type.label')}><Select value={type} onChange={event=>setType(event.target.value)}><option value="all">{t('fleet.type.all')}</option><option value="server">{t('fleet.type.server')}</option><option value="client">{t('fleet.type.client')}</option><option value="unknown">{t('fleet.inventoryPending')}</option></Select></Field>
    <Field label={t('fleet.filters.condition')}><Select value={filter} onChange={event=>setFilter(isFleetFilter(event.target.value)?event.target.value:'all')}>{fleetFilters.map(value=><option key={value} value={value}>{t(fleetFilterLabels[value])}</option>)}</Select></Field>
    <Field label={t('fleet.tagFilter.label')}><Select value={activeTag} onChange={event=>setTagName(event.target.value)}><option value="">{t('fleet.tagFilter.all')}</option>{tagNames.map(name=><option key={name} value={name}>{name}</option>)}</Select></Field>
    {activeTag?<Field label={t('fleet.tagFilter.valueLabel')}><Select value={tagFilter?.value??''} onChange={event=>setTagValue(event.target.value===''?null:event.target.value)}><option value="">{t('fleet.tagFilter.anyValue')}</option>{tagValues.map(value=><option key={value} value={value}>{value}</option>)}</Select></Field>:null}
   </FilterPopover>
  </>}
  actions={<>
   <FleetCsvExport devices={visible} customer={customerColumn}/>
   <FleetAgentUpdateToolbar/>
   {layout==='table'&&<ColumnMenu columns={columns} keys={availableFleetColumns(customerDistinct,groupShows)} onToggle={toggleColumn}/>}
   <Segmented<Layout> label={t('fleet.layout.label')} size="sm" iconOnly className="sdx-layout-switch" value={layout} onChange={changeLayout} items={[{id:'table',label:t('fleet.layout.table'),icon:List},{id:'cards',label:t('fleet.layout.cards'),icon:LayoutGrid}]}/>
  </>}/>;

 return <div className="sdx-fleet">
  {header}
  <Tabs items={tabs} value={openTab} onChange={chooseTab} label={t('fleet.tabs.areas')} variant="underline" overflow="menu" panelId={fleetPanelId} className="sdx-fleet-tabbar"/>
  <div id={fleetPanelId} role="tabpanel" aria-labelledby={tabId(fleetPanelId,openTab)} className="sdx-fleet-panel">
  {tab==='devices'&&<FleetAgentUpdates servers={visible} viewer={viewer} demo={demo} jobs={jobs} onUpdated={onUpdated}>
   {layout==='table'?<DataTable<Device> columns={columnsOf} rows={visible} rowKey={server=>server.id} label={t('tree.devices')} toolbar={toolbar}
    sort={fleetTableSort(sort)} onSort={next=>setSort(fleetSortValue(next))} onOpen={server=>onOpen(server.id)} openLabel={server=>t('fleet.openDevice',{name:server.name})}
    empty={empty} foot={t('fleet.foot',{count:scoped.length,shown:visible.length})} entranceId="fleet-rows" stickyActions layout="fixed" rowChunk={fleetRowChunk}
    selection={selectable?{selected:selection,onChange:setSelection,rowLabel:server=>t('fleet.selectDevice',{name:server.name}),allLabel:t('fleet.selectAll')}:undefined}
    rowProps={draggable?server=>({draggable:true,onDragStart:event=>startDeviceDrag(event.nativeEvent,dragIds(server),server.name,locale)}):undefined} rowClock={rowClock}/>
   :<>{toolbar}{visible.length?<EntranceList id="fleet-rows" className="sdx-cards">{visible.map(server=><DeviceCard key={server.id} server={server} customer={customerDistinct} group={groupShows} selectable={selectable} selected={selection.includes(server.id)} draggable={draggable} onDragStart={dragCard} onSelect={selectCard} onOpen={openCard} menu={menu}/>)}</EntranceList>:<div className="sdx-cards"><Empty {...empty}/></div>}
    <p className="sdx-foot-note">{t('fleet.foot',{count:scoped.length,shown:visible.length})}</p></>}
   {selectable&&<BulkBar count={selected.length} onClear={()=>setSelection([])}>
    {(canMove||demo)&&<Btn size="sm" icon={FolderInput} blocked={demoBlocked} disabled={saving} onClick={()=>onMove(selected.map(server=>server.id))}>{t('groups.assign.submit')}</Btn>}
    {customerMove&&customerMoveShown({...customerMove,devices:selected})&&<Btn size="sm" icon={Building2} blocked={customerMoveBlocked({devices:selected,viewer,demo,saving,bulk:true},t)} onClick={()=>void customerMove.onMove(selected.map(server=>server.id)).then(done=>{if(done)setSelection([]);})}>{t('devices.customerMove.menu')}</Btn>}
    {tagManager&&<><Btn size="sm" icon={Tag} blocked={tagBlocked} disabled={saving} onClick={()=>setBulkTag('add')}>{t('tags.bulk.add')}</Btn>
     <Btn size="sm" icon={Tag} blocked={tagBlocked??(directTagNames(selected).length?undefined:t('tags.bulk.noDirect'))} disabled={saving} onClick={()=>setBulkTag('remove')}>{t('tags.bulk.remove')}</Btn></>}
    {onRemoveFromGroup&&group&&<Btn size="sm" icon={FolderMinus} blocked={directMembers.length?undefined:t('fleet.bulk.notDirect')} disabled={saving} onClick={()=>void onRemoveFromGroup(directMembers.map(server=>server.id)).then(done=>{if(done)setSelection([]);})}>{t('fleet.bulk.removeFromGroup')}</Btn>}
    {canOffboard&&<Btn size="sm" variant="danger" icon={Trash2} blocked={demoBlocked??(selected.length>100?t('fleet.bulk.max'):undefined)} disabled={saving} onClick={()=>{if(selected.length&&selected.length<=100)onConfirm(bulkDeviceRemovalConfirmation(selected,locale,removalContext));}}>{t('console.removal.bulkButton',{count:selected.length})}</Btn>}
   </BulkBar>}
   <BulkTagDrawer mode={bulkTag} devices={selected} viewer={viewer} onClose={()=>setBulkTag(null)} onDone={()=>{setSelection([]);void onUpdated();}}/>
  </FleetAgentUpdates>}
  {tab!=='devices'&&<>
   {subtabs.length>1&&subtabLabel&&<Tabs variant="pill" overflow="menu" label={t(subtabLabel)} panelId={fleetSubpanelId} value={tab} onChange={id=>onTab(id as FleetTab)} items={subtabItems} className="sdx-subtabs"/>}
   <div {...(subtabs.length>1?{id:fleetSubpanelId,role:'tabpanel','aria-labelledby':tabId(fleetSubpanelId,tab)}:{})} className="sdx-fleet-subpanel">
    {(tab==='jobs'||tab==='access')&&<HistoryPanel scoped={scoped} servers={servers} viewer={viewer} demo={demo} saving={saving} jobs={jobs} audit={audit} onSelectJob={onSelectJob} onCancelJob={onCancelJob} onOpenDevice={id=>onOpen(id)} tab={tab} updatedAt={updatedAt}/>}
    {tab==='software'&&<SoftwareTab scope={scope} devices={scoped} demo={demo} owner={canManageInstanceSettings(viewer)} onOpen={id=>onOpen(id,'software','programs')} onShowDevices={showDevices}/>}
    {tab==='extensions'&&<ExtensionsTab devices={scoped} viewer={viewer} demo={demo} releases={pluginReleases} jobs={jobs} onConfirm={onConfirm} onOpen={(id,section,detail)=>onOpen(id,section,detail)} onShowDevices={()=>onTab('devices')}/>}
    {tab==='os-support'&&<OsSupportTab devices={scoped} esuScope={scope.type==='group'&&group?{type:'group',id:group.id}:scope.type==='customer'?{type:'customer',id:scope.id}:undefined} demo={demo} onOpen={id=>onOpen(id)} onRefresh={onUpdated} onOpenGroup={onOpenEsuGroup} onOpenCustomer={onOpenEsuCustomer} onShowDevices={showDevices}/>}
    {tab==='problems'&&<ProblemsTab devices={scoped} customerColumn={customerColumn} onOpen={onOpen} onShowDevices={showDevices} summary={monitoringSummary}/>}
    {tab==='alarms'&&<AlarmsTab devices={scoped} viewer={viewer} demo={demo} customerColumn={customerColumn} onOpen={id=>onOpen(id)} onRefresh={onUpdated} onShowDevices={showDevices} onOpenAlertRules={alerts?()=>onTab('alerts'):undefined}/>}
    {tab==='encryption'&&<EncryptionTab devices={scoped} onOpen={id=>onOpen(id,'management','storage')} onShowDevices={showDevices}/>}
    {tab==='protection'&&<ProtectionTab devices={scoped} onOpen={id=>onOpen(id,'management','defender')} viewer={viewer} demo={demo} saving={saving} onConfirm={onConfirm}/>}
    {tab==='drivers'&&<DriversTab scope={scope} devices={scoped} demo={demo} onOpen={id=>onOpen(id,'software','drivers')} onShowDevices={showDevices}/>}
    {tab==='reliability'&&<ReliabilityTab devices={scoped} onOpen={id=>onOpen(id,'diagnostics','events')} onShowDevices={showDevices}/>}
    {tab==='certificates'&&<CertificatesTab devices={scoped} onOpen={id=>onOpen(id,'software','certificates')} onShowDevices={showDevices}/>}
    {tab==='autostart'&&<AutostartTab scope={scope} devices={scoped} demo={demo} onOpen={id=>onOpen(id,'software','autostart')} onShowDevices={showDevices}/>}
    {tab==='alerts'&&alerts}
    {tab==='notifications'&&notifications}
    {tab==='tags'&&tags}
    {tab==='permissions'&&permissions}
    {tab==='settings'&&settings}
   </div>
  </>}
  </div>
  <PowerDrawer target={power} servers={servers} viewer={viewer} demo={demo} saving={saving} onConfirm={onConfirm} onClose={()=>setPower(null)}/>
 </div>;
}

export default memo(FleetView);

/** The entries of the column menu: the heading, then one switch entry per available column; toggling keeps the menu open. */
export function columnMenuEntries(columns:Columns,keys:FleetColumnKey[],onToggle:(key:FleetColumnKey)=>void,t:Translate):MenuEntry[]{
 return [{id:'heading',heading:t('fleet.columns.visible')},...keys.map(key=>({id:key,label:t(fleetColumnNames[key]),checked:columns[key],onCheckedChange:()=>onToggle(key)}))];
}
function ColumnMenu({columns,keys,onToggle}:{columns:Columns;keys:FleetColumnKey[];onToggle:(key:FleetColumnKey)=>void}){
 const t=useT(),label=t('fleet.columns.choose');
 return <Menu label={label} entries={columnMenuEntries(columns,keys,onToggle,t)} trigger={<IconBtn icon={Columns3} className="sdx-icon-btn-framed" label={label}/>}/>;
}

type ColumnContext={columns:Columns;
 /** The Customer column: several customers, the devices belong to two or more customers, and the column switch is on. */
 showCustomer:boolean;
 /** false leaves the Group column out whatever its switch says: no device of the scope is in a group (groupColumnShows). Default true. */
 showGroup?:boolean;
 /** A shown device has a long connection label (longStatusKinds): the Status column takes --sd-col-status-long. */
 longStatus?:boolean;
 locale:Locale;t:Translate;
 /** The row Menu of a device. */
 menu:(server:Device)=>ReactNode};
/** The connection states whose label is longer than Online and Offline ("First report pending", "Agent maintenance"). */
export const longStatusKinds:ReadonlySet<ReturnType<typeof connectionKind>>=new Set(['waiting','maintenance']);
/**
 * The columns of the Devices table in their fixed order, filtered by the column switches. Sortable
 * columns carry their fleet sort key as id and start in the direction of fleetSortFirst. The cells that show the
 * clock (status, health, CPU, RAM, last seen) take the row's time from the table's rowClock (deviceClockState), so
 * the columns do not change with the clock. The table has a fixed layout: every column but Device has its width
 * token (--sd-col-*, app/globals.css), Device takes the rest, at least --sd-col-device-min. Exported for tests.
 */
export function fleetTableColumns({columns,showCustomer,showGroup=true,longStatus=false,locale,t,menu}:ColumnContext):DataColumn<Device>[]{
 const sortable=(id:FleetSortKey)=>({id,sort:{first:fleetSortFirst(id)}});
 const all:(DataColumn<Device>|false)[]=[
  {...sortable('name'),label:t('fleet.col.device'),primary:true,minWidth:'var(--sd-col-device-min)',className:'sdx-col-device',cell:server=>{const address=primaryDeviceAddress(server);return <span className="sdx-device-cell"><DeviceTypeMark server={server} size="sm"/><span><strong>{server.name}</strong><small className={address?'mono':undefined}>{address??(shortOs(server.snapshot?.os)||t('fleet.inventoryPending'))}</small></span></span>;}},
  {...sortable('connection'),label:t('fleet.col.status'),width:longStatus?'var(--sd-col-status-long)':'var(--sd-col-status)',cell:(server,now)=>{const connection=deviceConnection(server,now,locale);return <StatusPill kind={connectionPillKind(connection.kind)}>{connection.label}</StatusPill>;}},
  // Fixed: the level pill plus the issue counts answer "which device needs me".
  {...sortable('health'),label:t('fleet.col.health'),width:'var(--sd-col-health)',cell:(server,now)=><HealthCell server={server} now={now} locale={locale}/>},
  showCustomer&&{...sortable('customer'),label:t('common.customer'),width:'var(--sd-col-customer)',className:'sdx-muted-cell',cell:server=><CustomerCell server={server}/>},
  showGroup&&columns.group&&{...sortable('group'),label:t('fleet.col.group'),width:'var(--sd-col-group)',className:'sdx-muted-cell sdx-col-group',cell:server=>server.groupName??t('groups.noGroup')},
  columns.description&&{id:'description',label:t('fleet.col.description'),width:'var(--sd-col-description)',className:'sdx-muted-cell',cell:server=>server.description?<span className="sdx-fleet-description" title={server.description}>{server.description}</span>:EMPTY_VALUE},
  // At most two chips plus "+N"; the full list is in the chips' title.
  columns.tags&&{id:'tags',label:t('fleet.col.tags'),width:'var(--sd-col-tags)',cell:server=><TagChips tags={server.tags} groups={server.groups} limit={2}/>},
  columns.os&&{...sortable('os'),label:t('fleet.col.os'),width:'var(--sd-col-os)',className:'sdx-muted-cell',cell:server=>shortOs(server.snapshot?.os)||EMPTY_VALUE},
  columns.manufacturer&&{...sortable('manufacturer'),label:t('fleet.col.manufacturer'),width:'var(--sd-col-manufacturer)',cell:server=>{const {manufacturer,model}=deviceManufacturer(server);return <span title={model||undefined}><ManufacturerMark manufacturer={manufacturer} size="sm"/></span>;}},
  columns.cpu&&{...sortable('cpu'),label:t('fleet.col.cpu'),width:'var(--sd-col-meter)',cell:(server,now)=><MeterCell value={liveValue(server,server.snapshot?.cpu,now)} label={t('fleet.meterLabel',{metric:t('fleet.col.cpu'),name:server.name})}/>},
  columns.memory&&{...sortable('memory'),label:t('fleet.col.memory'),width:'var(--sd-col-meter)',cell:(server,now)=><MeterCell value={liveValue(server,server.snapshot?.memory,now)} label={t('fleet.meterLabel',{metric:t('fleet.col.memory'),name:server.name})}/>},
  columns.disk&&{...sortable('disk'),label:t('fleet.col.free'),width:'var(--sd-col-free)',cell:server=>{const disk=diskSummary(server);return disk?<span className="sdx-disk-cell"><span className="mono">{t('fleet.diskFreeGb',{size:formatNumber(locale,disk.freeGb,{maximumFractionDigits:0})})}</span><small>{t('fleet.diskFree',{name:disk.name,percent:formatPercent(locale,Math.round(disk.freeGb/disk.totalGb*100))})}</small></span>:<span className="sdx-muted-cell">{EMPTY_VALUE}</span>;}},
  columns.agent&&{...sortable('agent'),label:t('fleet.col.agent'),width:'var(--sd-col-agent)',cell:server=><FleetAgentUpdateCell server={server}/>},
  columns.osSupport&&{...sortable('osSupport'),label:t('fleet.col.osSupport'),width:'var(--sd-col-os-support)',cell:server=><OsSupportCell server={server}/>},
  columns.bitlocker&&{...sortable('bitlocker'),label:t('fleet.col.bitlocker'),width:'var(--sd-col-bitlocker)',cell:server=><BitLockerCell server={server}/>},
  columns.diskHealth&&{...sortable('diskHealth'),label:t('fleet.col.diskHealth'),width:'var(--sd-col-disk-health)',cell:server=><DiskHealthCell server={server}/>},
  columns.ssdWear&&{...sortable('ssdWear'),label:t('fleet.col.ssdWear'),width:'var(--sd-col-ssd-wear)',mono:true,cell:server=>{const wear=maxWear(server);return wear===null?EMPTY_VALUE:formatPercent(locale,wear);}},
  columns.battery&&{...sortable('battery'),label:t('fleet.col.battery'),width:'var(--sd-col-battery)',mono:true,cell:server=>{const health=batteryHealth(server);return typeof health==='number'?formatPercent(locale,health):EMPTY_VALUE;}},
  {...sortable('heartbeat'),label:t('fleet.col.lastSeen'),width:'var(--sd-col-last-seen)',cell:(server,now)=>{const note=server.lastSeen&&deviceConnection(server,now,locale).kind!=='online'?t('fleet.inventoryState'):registrationNote(server,now,locale);return <><span className="sdx-seen" title={exactTime(server.lastSeen,locale)}>{relativeTime(server.lastSeen,now,locale)}</span>{note&&<small className="sdx-seen-note">{note}</small>}</>;}},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,width:'var(--sd-col-actions)',className:'sdx-col-actions',cell:menu},
 ];
 return all.filter((column):column is DataColumn<Device>=>!!column);
}

/** The device's customer; a disabled customer is marked in text, not by color. */
function CustomerCell({server}:{server:Device}){
 const t=useT();
 const name=server.customerName?.trim();
 if(!name)return <>{EMPTY_VALUE}</>;
 return <span className="sdx-customer-cell" title={server.customerDisabled?t('fleet.customerDisabled'):undefined}><span>{name}</span>{server.customerDisabled&&<span className="sdx-tag">{t('fleet.disabled')}</span>}</span>;
}

/** The OS support status of a device as text with its tone. */
function OsSupportCell({server}:{server:Device}){
 const [locale]=useLocale(),text=osSupportText(server.osSupport,locale);
 return <span title={text.hint}><StatusPill kind={toneKind[text.tone]}>{text.text}</StatusPill></span>;
}
/** The worst disk of a device; not available and not reported as a dash. */
function DiskHealthCell({server}:{server:Device}){
 const t=useT(),status=deviceDiskHealth(server);
 return status===null||status==='not-available'?<span className="sdx-muted-cell">{EMPTY_VALUE}</span>:<StatusPill kind={toneKind[diskHealthTone[status]]}>{t(diskHealthStatusKey(status))}</StatusPill>;
}
/** The BitLocker state of the system drive. */
function BitLockerCell({server}:{server:Device}){
 const t=useT(),status=bitlockerStatus(server.snapshot?.bitlocker);
 return <StatusPill kind={toneKind[bitlockerStatusTone[status]]}>{t(bitlockerStatusKey(status))}</StatusPill>;
}

function MeterCell({value,label}:{value:number|null;label:string}){
 const [locale]=useLocale();
 return <span className="sdx-meter-cell"><span className="mono">{percentLabel(value,locale)}</span><Meter value={value} label={label} size="sm"/></span>;
}

const issueLevels=[
 {level:'critical',icon:OctagonAlert,label:'fleet.issues.critical'},
 {level:'warning',icon:AlertTriangle,label:'fleet.issues.warning'},
 {level:'info',icon:Info,label:'fleet.issues.info'},
] as const satisfies readonly {level:string;icon:unknown;label:MessageKey}[];

/** The issue counts per level; nothing without issues. */
function IssueSummary({issues}:{issues:ReturnType<typeof deviceIssues>}){
 const t=useT();
 if(!issues.length)return null;
 return <span className="sdx-issue-counts">{issueLevels.map(({level,icon:Icon,label:key})=>{
  const items=issues.filter(issue=>issue.level===level);
  if(!items.length)return null;
  const label=t(key,{count:items.length});
  return <span key={level} className={cx('sdx-issue-count',level)} role="img" aria-label={`${label}: ${items.map(issue=>issue.title).join(', ')}`} title={`${label}\n${items.map(issue=>'• '+issue.title).join('\n')}`}><Icon size={12} aria-hidden/>{items.length}</span>;
 })}</span>;
}

/**
 * The Health cell of the fleet table and the device card: the level pill and, only when there are
 * issues, their counts per level. A device without an inventory shows the "No data" pill only.
 */
function HealthCell({server,now,locale}:{server:Device;now:number;locale:Locale}){
 return <span className="sdx-health-cell"><HealthPill server={server}/>{server.snapshot&&<IssueSummary issues={deviceIssues(server,now,locale)}/>}</span>;
}

type DeviceCardProps={server:Device;customer:boolean;
 /** The group line in the footer; false while no device of the scope is in a group. Default true. */
 group?:boolean;selectable:boolean;selected:boolean;draggable:boolean;
 /** The handlers get the card's device, so one function serves every card and the memoized cards stay equal. */
 onDragStart:(event:ReactDragEvent,server:Device)=>void;onSelect:(checked:boolean,server:Device)=>void;onOpen:(server:Device)=>void;
 /** The row menu: an element, or a function of the device (one function for every card). */
 menu:ReactNode|((server:Device)=>ReactNode);className?:string;style?:CSSProperties};
/**
 * A device as a card (the fleet's card layout). Memoized: a card renders again only when its device, its selection
 * or its handlers change, or when its clock-derived state (deviceClockState) does.
 */
export const DeviceCard=memo(function DeviceCard({server,customer,group=true,selectable,selected,draggable,onDragStart,onSelect,onOpen,menu,className,style}:DeviceCardProps){
 const t=useT(),[locale]=useLocale(),now=useClockTransition(time=>deviceClockState(server,time,locale));
 const connection=deviceConnection(server,now,locale),disk=diskSummary(server),address=primaryDeviceAddress(server);
 const cpu=liveValue(server,server.snapshot?.cpu,now),memory=liveValue(server,server.snapshot?.memory,now),used=disk?100-disk.freeGb/disk.totalGb*100:null;
 return <article className={cx('sdx-device-card',selected&&'selected',className)} style={style} draggable={draggable} onDragStart={draggable?event=>onDragStart(event,server):undefined}>
  <header>
   {selectable&&<label className="sdx-check-hit"><input type="checkbox" aria-label={t('fleet.selectDevice',{name:server.name})} checked={selected} onChange={event=>onSelect(event.target.checked,server)}/></label>}
   <button type="button" className="sdx-device-cell" onClick={()=>onOpen(server)}><DeviceTypeMark server={server} size="sm"/><span><strong>{server.name}</strong><small className={address?'mono':undefined}>{address??(shortOs(server.snapshot?.os)||t('fleet.inventoryPending'))}</small></span></button>
   {typeof menu==='function'?menu(server):menu}
  </header>
  {customer&&<p className="sdx-device-card-customer"><Building2 size={12} aria-hidden/><span><span className="sr-only">{t('fleet.customerLabel')} </span>{server.customerName?.trim()||EMPTY_VALUE}</span>{server.customerDisabled&&<span className="sdx-tag">{t('fleet.disabled')}</span>}</p>}
  <div className="sdx-device-card-status"><StatusPill kind={connectionPillKind(connection.kind)}>{connection.label}</StatusPill><HealthCell server={server} now={now} locale={locale}/></div>
  <dl className="sdx-device-card-meters">
   <div><dt>{t('fleet.col.cpu')}</dt><dd><Meter value={cpu} label={t('fleet.meterLabel',{metric:t('fleet.col.cpu'),name:server.name})} size="sm"/><span className="mono">{percentLabel(cpu,locale)}</span></dd></div>
   <div><dt>{t('fleet.col.memory')}</dt><dd><Meter value={memory} label={t('fleet.meterLabel',{metric:t('fleet.col.memory'),name:server.name})} size="sm"/><span className="mono">{percentLabel(memory,locale)}</span></dd></div>
   <div><dt><HardDrive size={12} aria-hidden/>{disk?.name??'Disk'}</dt><dd><Meter value={used} label={t('fleet.usedStorage',{name:server.name})} size="sm" warning={85} critical={95}/><span className="mono">{disk?t('fleet.cardDiskFree',{size:formatNumber(locale,disk.freeGb,{maximumFractionDigits:0})}):EMPTY_VALUE}</span></dd></div>
  </dl>
  <footer><span title={exactTime(server.lastSeen,locale)}>{relativeTime(server.lastSeen,now,locale)}{registrationNote(server,now,locale)&&<small className="sdx-seen-note">{registrationNote(server,now,locale)}</small>}</span>{group&&<span>{server.groupName??t('groups.noGroup')}</span>}<button type="button" className="sdx-card-open" onClick={()=>onOpen(server)} aria-label={t('fleet.openDevice',{name:server.name})}>{t('common.open')}<ChevronRight size={14} aria-hidden/></button></footer>
 </article>;
});
