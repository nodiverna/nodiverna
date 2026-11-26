'use client';
import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {useClockNow} from '@/ui/base/clock-store';
import {Building2,ChevronLeft,ChevronRight,Eye,FolderInput,MoreHorizontal,PackageX,PencilLine,Pin,PinOff,Power,RefreshCw,RotateCw,ShieldCheck,Sparkles,Tag,Text,Trash2} from 'lucide-react';
import type {AuditEntry,Job,Sample,Server,Viewer} from '@/lib/types';
import {detectTargets} from '@/lib/extensions';
import {deviceConnection} from '@/ui/base/ui-device';
import {primaryDeviceAddress} from '@/ui/devices/device/device-network';
import {REMOTE_DESKTOP_AVAILABLE} from '@/lib/rdp-feature';
import type {MessageKey} from '@/lib/i18n/translate';
import {deviceDetailOf,deviceDetailRoute,deviceMainSection,type DeviceDetailRoute,type DeviceMainSection,type DeviceSection,type HistoryDetail,type MonitoringDetail} from '@/lib/console-route';
import {deviceAreaHref,deviceKeyAreas,deviceSubareaHref,fixedDeviceAreas,visibleDeviceAreas,visibleDeviceSubareas,type NavContext,type NavNode} from '@/ui/shell/nav-model';
import {deviceOverviewGpus,type DeviceOverviewTarget} from '@/ui/devices/device/device-overview';
import DeviceHardware,{type HardwareSection} from '@/ui/devices/hardware/device-hardware';
import DeviceServices from '@/ui/devices/management/device-services';
import DeviceNetworkPanel from '@/ui/devices/management/device-network-panel';
import DeviceUpdates from '@/ui/devices/management/device-updates';
import DeviceSystem,{focusSystemSchedule} from '@/ui/devices/management/device-system';
import DeviceTasks from '@/ui/devices/management/device-tasks';
import DeviceAccounts from '@/ui/devices/management/device-accounts';
import RolesFeatures from '@/ui/devices/management/roles-features';
import {ConnectionsPanel,EventPanel,ProcessPanel,SessionPanel} from '@/ui/devices/diagnostics/diagnostics-panels';
import FilePanel from '@/ui/devices/remote/file-panel';
import TerminalPanel from '@/ui/devices/remote/terminal-panel';
import RdpPanel from '@/ui/devices/remote/rdp-panel';
import RunbookPanel from '@/ui/automation/runbook-panel';
import DriftPanel from '@/ui/automation/drift-panel';
import StoragePanel from '@/ui/devices/management/storage-panel';
import DesiredStatePanel from '@/ui/automation/desired-state-panel';
import HistoryPanel,{scopeHistoryCounts} from '@/ui/devices/history/history';
import {AlarmHistory} from '@/ui/devices/monitoring/alarms';
import MonitoringSummaryRow from '@/ui/devices/monitoring/monitoring-summary';
import {alarmTabCount} from '@/ui/devices/monitoring/alarms-view';
import {Tabs,tabId,type TabItem} from '@/ui/kit/tabs';
import {deviceRemovalConfirmation,type RemovalContext} from '@/ui/devices/device/device-removal';
import {deviceUninstallNotice} from '@/ui/devices/device/offboarding';
import type {Confirmation} from '@/ui/base/confirmation';
import {permitted,type Device} from '@/ui/base/api';
import {Btn,Drawer,IconBtn,Menu,Notice,StatusPill,connectionPillKind,shortOs,type MenuEntry} from '@/ui/kit/kit';
import {PageHeader,type Crumb} from '@/ui/shell/shell';
import {DeviceStateNotice} from '@/ui/devices/device/device-parts';
import {DeviceTypeMark} from '@/ui/devices/device/device-type-mark';
import {useNarrowLayout} from '@/ui/base/narrow-layout';
import DeviceSummary from '@/ui/devices/device/device-summary';
import DeviceSoftware from '@/ui/devices/inventory/device-software';
import DeviceDrivers from '@/ui/devices/inventory/device-drivers';
import DeviceCertificates from '@/ui/devices/inventory/device-certificates';
import DeviceAutostart from '@/ui/devices/inventory/device-autostart';
import DeviceDefender from '@/ui/devices/protection/device-defender';
import DeviceDescription,{deviceDescriptionBlocked} from '@/ui/devices/device/device-description';
import {deviceNameBlocked} from '@/ui/devices/device/device-name';
import {canManageInstanceSettings} from '@/ui/base/access-capabilities';
import {customerMoveBlocked,customerMoveShown,type CustomerMoveEntry} from '@/ui/devices/fleet/customer-move-model';
import DeviceTags,{deviceTagsBlocked} from '@/ui/devices/configuration/device-tags';
import DeviceExtensions from '@/ui/devices/extensions/device-extensions';
import {PowerDrawer,powerMenuEntry,type PowerTarget} from '@/ui/devices/management/device-power';
import type {PluginReleaseSummary} from '@/lib/plugin-catalog';
import DeviceAssistant,{AssistantActions,sourceAreaRoute,useAssistantConversation,type AssistantAction} from '@/ui/devices/assistant/device-assistant';
import {earlierConversations,type EarlierConversation} from '@/ui/devices/assistant/assistant-conversations';
import type {AssistantSourceArea} from '@/lib/assistant-config';

import {useLocale,useT,type Translate} from '@/ui/base/locale';
import {agentModeLabel} from '@/ui/base/agent-mode';
type DeviceTab={id:DeviceMainSection;label:MessageKey};
const deviceTab=(node:NavNode):DeviceTab=>({id:node.deviceSection as DeviceMainSection,label:node.label});
/** The device tabs every device has, from the navigation model (ui/shell/nav-model.ts); label is a message key. */
export const deviceTabs:ReadonlyArray<DeviceTab>=fixedDeviceAreas.map(deviceTab);
/**
 * The tabs of this device: deviceTabs, plus Extensions before Monitoring when a role or server product is detected
 * (lib/extensions.ts), and Configuration only for a viewer with portal.roleAssignments.manage.
 * Without a detection the tab is absent, not disabled. The tab strip, the number shortcuts (deviceKeyAreas: 1–9,
 * Monitoring and Configuration have no key) and the palette all read the model.
 */
export function visibleDeviceTabs(server:Pick<Server,'snapshot'|'serverSoftware'>,viewer?:Pick<Viewer,'permissions'|'canManageDeviceGroups'>):DeviceTab[]{
 return visibleDeviceAreas(server,viewer).map(deviceTab);
}
/** The section a device shows: an Extensions link on a device without a detection shows the Overview. */
export function shownDeviceSection(server:Pick<Server,'snapshot'|'serverSoftware'>,section:DeviceSection):DeviceSection{
 return section==='extensions'&&!detectTargets(server).length?'overview':section;
}
type SubItem={id:string;label:MessageKey;tag?:MessageKey;count?:number};
// The subarea bars of the navigation model, filtered by the viewer and the device. While Remote Desktop is paused, its
// tab keeps the plain label and carries the state as a tag ("Paused").
const subItems=(area:DeviceMainSection,context:NavContext):SubItem[]=>visibleDeviceSubareas(area,context).map(node=>({id:node.sub!,label:node.label,...(node.sub==='rdp'&&!REMOTE_DESKTOP_AVAILABLE?{tag:'rdp.paused.status' as MessageKey}:{})}));

/** The id of the device area panel; the area tabs point to it. */
const devicePanelId='sdx-device-panel';
/** The id of the subarea panel; the subarea bar of the open area (only one renders) points to it. */
export const deviceSubpanelId='sdx-device-subpanel';

type MenuAction={blocked?:string;onSelect:()=>void};
/**
 * The entries of the header's "More actions" menu, in this order: on narrow layouts (760px or narrower) Previous and
 * Next device and "Move to group…"; "Move to another customer…" (when it is shown); "Rename device"; "Add description…" (or "Edit description…" with a description);
 * "Add tags…"; a separator; "Restart…" and "Shut down…"; a separator; "Remove device". An absent action has no entry
 * (rename and the metadata entries on a removed device, removal without the right). A separator only stands between
 * two groups with entries. An empty list renders no menu trigger (kit Menu).
 */
export function deviceHeaderMenu({narrow,pin,step,move,moveCustomer,rename,description,tags,power,removal}:{narrow:boolean;pin?:MenuAction&{pinned:boolean};step?:(direction:1|-1)=>void;move?:()=>void;moveCustomer?:MenuAction;rename?:MenuAction;description?:MenuAction&{filled:boolean};tags?:MenuAction;power?:{restart:MenuAction;shutdown:MenuAction};removal?:MenuAction},t:Translate):MenuEntry[]{
 const edit:MenuEntry[]=[],powerGroup:MenuEntry[]=[],danger:MenuEntry[]=[];
 // Narrow: pin or unpin is the first entry (wide: the header IconBtn).
 if(narrow&&pin)edit.push({id:pin.pinned?'unpin':'pin',label:t(pin.pinned?'pins.unpin':'pins.pin'),icon:pin.pinned?PinOff:Pin,blocked:pin.blocked,onSelect:pin.onSelect});
 if(narrow&&step)edit.push({id:'previous',label:t('device.previous'),icon:ChevronLeft,shortcut:'K',onSelect:()=>step(-1)},{id:'next',label:t('device.next'),icon:ChevronRight,shortcut:'J',onSelect:()=>step(1)});
 if(narrow&&move)edit.push({id:'move',label:t('device.header.move'),icon:FolderInput,onSelect:move});
 if(moveCustomer)edit.push({id:'move-customer',label:t('devices.customerMove.menu'),icon:Building2,blocked:moveCustomer.blocked,onSelect:moveCustomer.onSelect});
 if(rename)edit.push({id:'rename',label:t('device.name.rename'),icon:PencilLine,blocked:rename.blocked,onSelect:rename.onSelect});
 if(description)edit.push({id:'description',label:t(description.filled?'device.menu.editDescription':'device.menu.addDescription'),icon:Text,blocked:description.blocked,onSelect:description.onSelect});
 if(tags)edit.push({id:'tags',label:t('device.menu.addTags'),icon:Tag,blocked:tags.blocked,onSelect:tags.onSelect});
 if(power)powerGroup.push({id:'restart',label:t('device.menu.restart'),icon:RotateCw,blocked:power.restart.blocked,onSelect:power.restart.onSelect},{id:'shutdown',label:t('device.menu.shutdown'),icon:Power,blocked:power.shutdown.blocked,onSelect:power.shutdown.onSelect});
 if(removal)danger.push({id:'remove',label:t('console.removal.button'),icon:Trash2,danger:true,blocked:removal.blocked,onSelect:removal.onSelect});
 return [edit,powerGroup,danger].filter(group=>group.length).flatMap((group,index)=>index?[{id:'separator-'+index,separator:true as const},...group]:group);
}

/** The facts of the header meta line: OS, build and address, without the group path (the breadcrumb shows it). */
export function deviceSubtitle(facts:readonly (string|null|undefined)[]):string{
 return facts.filter((fact):fact is string=>!!fact).join(' · ');
}
type Props={
 server:Device;servers:Device[];viewer:Viewer;demo:boolean;saving:boolean;
 /** Pins the time (tests); without it the device view follows the console clock every second. */
 now?:number;
 /** The newest active release of each agent extension (ConsoleData.pluginReleases); the Extensions area offers install and repair with it. */
 pluginReleases?:PluginReleaseSummary[];
 section:DeviceSection;onSection:(section:DeviceSection)=>void;
 /** Subarea and GPU position from the link. Without it the view keeps its own state. */
 detail?:DeviceDetailRoute;onDetail?:(detail:DeviceDetailRoute)=>void;
 samples:Sample[];historyLoading:boolean;jobs:Job[];audit:AuditEntry[];
 crumbs:Crumb[];
 onConfirm:(confirmation:Confirmation)=>void;onSelectJob:(job:Job)=>void;onCancelJob:(job:Job)=>void;
 onStep?:(direction:1|-1)=>void;
 /** The non-modal "Ask assistant" drawer is open (it has no route; the console closes it when another device opens). */
 assistantOpen?:boolean;onAssistantOpen?:(open:boolean)=>void;
 /** The Configuration area (Permissions), only with portal.roleAssignments.manage; without it the area is absent. */
 permissions?:ReactNode;
 /** Monitoring › Alert rules; every viewer of the device gets it. */
 alerts?:ReactNode;
 /** Monitoring › Notification rules: the rules that reach the device, read-only. */
 notifications?:ReactNode;
 /** Reloads the console data after a change on this page (the description, the tags, an ESU date). */
 onRefresh?:()=>Promise<void>|void;
 onMove?:()=>void;
 /** "Move to another customer…" in "More actions" (ui/devices/fleet/customer-move-model.ts); without it the entry is absent. */
 customerMove?:CustomerMoveEntry;
 /** Opens the rename drawer of this device (ui/devices/device/device-name.tsx). */
 onRename?:()=>void;
 /** The device is pinned by the account (ConsoleData.preferences.pinnedDeviceIds). */
 pinned?:boolean;
 /** Pins or unpins the device (ui/shell/pin-toggle.ts); without it the header has no pin control. */
 onPin?:()=>void;
 canOffboard:boolean;
 /** Clock and open uninstall jobs for the removal dialog's uninstall switch. */
 removalContext?:RemovalContext;
 /** Opens the offboarding drawer for this device (Owners). */
 onShowOffboarding?:()=>void;
 /** Opens a group on its OS support tab (the origin of an inherited ESU date). */
 onOpenEsuGroup?:(groupId:string)=>void;
 /** Opens the device's customer on its OS support tab; absent without the customer view. */
 onOpenEsuCustomer?:(customerId:string)=>void;
 /** Opens a group on its Tags tab (the origin of an inherited tag). */
 onOpenTagOrigin?:(groupId:string)=>void;
 /** The not-set-up state of the assistant: Settings › AI assistant (Owners) or the account page. */
 onOpenAssistantSettings?:()=>void;onOpenAccount?:()=>void;
 /** The console action that the assistant runs its commands through (console-action.ts). */
 onAction?:AssistantAction;
 /** Opens another device with its assistant drawer open: an earlier conversation of that device was opened. */
 onOpenDeviceAssistant?:(serverId:string)=>void;
};

/**
 * Whether the assistant can open for this viewer and device: a device that is not revoked, with the view right. The
 * header shows "Ask assistant" only then, and an assistant link (#device/<id>/assistant) opens the drawer only then.
 */
export function assistantAvailable(server:Pick<Device,'revoked'|'permissions'>,viewer:Viewer):boolean{
 return server.revoked===0&&permitted(server as Device,viewer,'view');
}

/**
 * The device name in the header. A rename while the device is open (the drawer, or a heartbeat that follows
 * the computer name) cross-fades the new name in (nodiverna-ui §8); opening the device shows it at once.
 */
function DeviceTitle({name}:{name:string}){
 const [first]=useState(name);
 return <span key={name} className={name===first?undefined:'sdx-title-swap'}>{name}</span>;
}

/** One device: header with status and actions, area tabs, then the selected area. */
export default function DeviceView({server,servers,viewer,demo,saving,now:pinnedNow,pluginReleases,section,onSection:changeSection,detail:controlledDetail,onDetail,samples,historyLoading,jobs,audit,crumbs,onConfirm,onSelectJob,onCancelJob,onStep,assistantOpen=false,onAssistantOpen,permissions,alerts,notifications,onRefresh,onMove,customerMove,onRename,pinned=false,onPin,canOffboard,removalContext,onShowOffboarding,onOpenEsuGroup,onOpenEsuCustomer,onOpenTagOrigin,onOpenAssistantSettings,onOpenAccount,onAction,onOpenDeviceAssistant}:Props){
 const now=useClockNow(pinnedNow);
 const t=useT(),[locale]=useLocale(),narrow=useNarrowLayout();
 // The assistant: every viewer with view on a device that is not revoked. Its conversation lives here, so it survives area switches.
 // Sample devices keep nothing: their conversation lives in React state only.
 const canAsk=assistantAvailable(server,viewer),conversation=useAssistantConversation(server.id,demo?undefined:{userId:viewer.userId??viewer.id,serverName:server.name});
 // "Earlier conversations": the kept conversations of every device the viewer can open the assistant of now.
 const earlier=earlierConversations(conversation.stored,{shownId:conversation.id,serverId:server.id,servers:onOpenDeviceAssistant?servers:servers.filter(device=>device.id===server.id),
  available:device=>assistantAvailable(device,viewer)});
 const openEarlier=(row:EarlierConversation)=>{
  if(row.serverId===server.id)conversation.open(row.id);
  else if(onOpenDeviceAssistant&&conversation.openElsewhere(row.id))onOpenDeviceAssistant(row.serverId);
 };
 const [localDetail,setLocalDetail]=useState<{serverId:string;section:DeviceSection;detail:DeviceDetailRoute}>(),[processUser,setProcessUser]=useState(''),[focusDrive,setFocusDrive]=useState<string>(),[driverFocus,setDriverFocus]=useState<{serverId:string;driver:string;revision:number}>();
 const [hardwareFocus,setHardwareFocus]=useState<{serverId:string;section:HardwareSection;gpuId?:string;drive?:string;revision:number}>();
 // The header metadata editors (More actions › description or tags) and the power drawer (More actions › Restart… or Shut down…).
 const [metaEdit,setMetaEdit]=useState<{serverId:string;kind:'description'|'tags'}|null>(null),[power,setPower]=useState<PowerTarget|null>(null);
 const menuButton=useRef<HTMLButtonElement>(null),askButton=useRef<HTMLButtonElement>(null),scheduleFocus=useRef(false);
 // Configuration (Permissions) shows only when the console passes its element (portal.roleAssignments.manage); a
 // Configuration link without it shows Monitoring › Alert rules, the area the bare Configuration link used to open.
 const requested=deviceMainSection(shownDeviceSection(server,section)),configurationMissing=requested==='configuration'&&!permissions;
 const main:DeviceMainSection=configurationMissing?'monitoring':requested,keyAreas=deviceKeyAreas(server);
 const tabs=visibleDeviceTabs(server,viewer).filter(tab=>tab.id!=='configuration'||!!permissions);
 const detail=controlledDetail??(localDetail?.serverId===server.id&&localDetail.section===main?localDetail.detail:{});
 // The subarea bars this viewer and device have: DHCP and DNS with the role.
 const navContext:NavContext={viewer,server};
 const items=(area:DeviceMainSection)=>subItems(area,navContext);
 const extensionsItems=items('extensions');
 // The History views keep their counts in the bar: jobs and device accesses (with the right).
 const historyCounts:Partial<Record<string,number>>=scopeHistoryCounts({scoped:[server],viewer,jobs,audit,demo});
 const historyItems=items('history').map(item=>({...item,count:historyCounts[item.id]}));
 const pick=(list:readonly SubItem[],value:string,fallback:string)=>list.some(item=>item.id===value)?value:fallback;
 const extensionsDetail=pick(extensionsItems,deviceDetailOf('extensions',detail.deviceDetail),'overview') as 'overview'|'dhcp'|'dns';
 const monitoring:MonitoringDetail=configurationMissing?'alert-rules':deviceDetailOf('monitoring',detail.deviceDetail);
 // The open alarms of the device as the Monitoring tab count, in the tone of the worst level; nothing at 0.
 const alarmCount=alarmTabCount([server]);
 const diagnosis=deviceDetailOf('diagnostics',detail.deviceDetail),management=deviceDetailOf('management',detail.deviceDetail),software=deviceDetailOf('software',detail.deviceDetail),hardwareDetail=deviceDetailOf('hardware',detail.deviceDetail),historyView=deviceDetailOf('history',detail.deviceDetail);
 // Every subarea change reports the canonical detail once.
 const changeDetail=(next:DeviceSection,value?:string,gpu?:number,zone?:string)=>{const area=deviceMainSection(next),route=deviceDetailRoute(area,value,gpu,zone);setLocalDetail({serverId:server.id,section:area,detail:route});onDetail?.(route);};
 const onSection=(next:DeviceSection,value?:string,gpu?:number)=>{changeSection(next);changeDetail(next,value,gpu);};
 const snapshot=server.snapshot,connection=deviceConnection(server,now,locale),online=connection.kind==='online';
 const mode=snapshot?.mode??(server.management===1?'Management':server.management===0?'ReadOnly':null),address=primaryDeviceAddress(server);
 const gpus=deviceOverviewGpus(snapshot,false,now);
 const context=useRef({server,viewer,gpus});useLayoutEffect(()=>{context.current={server,viewer,gpus};},[server,viewer,gpus]);
 const navigateOverview=(target:DeviceOverviewTarget)=>{
  const current=context.current;
  if(current.server.id!==server.id||current.server.revoked!==0||!permitted(current.server,current.viewer,'view'))return;
  if(target.section==='hardware'){
   const position=current.gpus.findIndex(gpu=>gpu.id===target.gpuId)+1;
   if(target.hardware==='gpu'&&!position)return;
   setHardwareFocus(previous=>({serverId:server.id,section:target.hardware,gpuId:target.gpuId,drive:target.drive,revision:(previous?.revision??0)+1}));onSection('hardware',target.hardware,target.hardware==='gpu'?position:undefined);
  }else if(target.section==='diagnostics'){onSection('diagnostics',target.diagnosis);setProcessUser('');}
  else if(target.section==='extensions')onSection('extensions',target.extensions);
  else if(target.section==='software'){onSection('software',target.software);const driver=target.software==='drivers'?target.driver:undefined;if(driver)setDriverFocus(previous=>({serverId:server.id,driver,revision:(previous?.revision??0)+1}));}
  else{onSection('management',target.management);setFocusDrive(target.management==='storage'?target.drive:undefined);}
 };
 const refreshBlocked=demo?t('kit.unavailable.demo'):saving?t('fleet.menu.saving'):!online?t('device.offline'):!permitted(server,viewer,'diagnose')?t('device.noDiagnoseRight'):!snapshot?.agentCapabilities?.includes('refresh')?t('device.refreshUnsupported'):'';
 const refreshInventory=()=>{if(refreshBlocked)return;onConfirm({title:t('device.refresh.title'),description:t('device.refresh.description',{name:server.name}),confirmLabel:t('management.action.refresh'),payload:{action:'job',id:server.id,kind:'refresh',params:{},confirm:true}});};
 const groups=[...new Map(servers.filter(device=>device.groupId).map(device=>[device.groupId!,device.groupName??device.groupId!])).entries()].map(([id,name])=>({id,name}));
 const remote=section==='remote'?'files':section,automation=section==='automation'?'runbooks':section;
 // An uninstall waits for the agent or failed: the Owner sees it on every area, from the console's job list.
 const uninstall=canOffboard?deviceUninstallNotice(server,jobs,now,t):null;
 // The area bar: the device areas of the model in tab order; the first nine but Monitoring and Configuration carry the
 // keys 1–9. Monitoring carries the open alarms with the worst tone.
 const areaTabs:TabItem[]=tabs.map(tab=>{
  const key=keyAreas.findIndex(node=>node.deviceSection===tab.id)+1,label=t(tab.label);
  return {id:tab.id,label,href:deviceAreaHref(server.id,tab.id),...(key?{shortcut:String(key),title:t('device.tabShortcut',{label,key})}:{}),...(tab.id==='monitoring'&&alarmCount?alarmCount:{})};
 });
 // A source chip of the assistant opens its device area behind the drawer, through the same path as the tabs.
 const openSourceArea=(area:AssistantSourceArea)=>{
  const [next,value]=sourceAreaRoute(area);
  onSection(next,value);
  if(next==='diagnostics')setProcessUser('');
  if(next==='management')setFocusDrive(undefined);
 };
 // "Open scheduling" of the power task: Management → System, then the focus on the Scheduled maintenance card once it renders.
 const openScheduling=()=>{scheduleFocus.current=true;changeDetail('management','system');};
 useEffect(()=>{if(scheduleFocus.current&&main==='management'&&management==='system'&&focusSystemSchedule())scheduleFocus.current=false;},[main,management]);
 // The subarea bars: kit Tabs (pill, overflow "More"), one link tab per subarea (deviceSubareaHref), all pointing to one tabpanel.
 const subHref=(area:DeviceMainSection,sub:string)=>deviceSubareaHref(server.id,area,sub);
 const subTabs=(list:readonly SubItem[],href:(id:string)=>string):TabItem[]=>list.map(item=>({id:item.id,label:t(item.label),...(item.tag?{tag:t(item.tag)}:{}),...(item.count!==undefined?{count:item.count}:{}),href:href(item.id)}));
 const subpanel=(active:string)=>({id:deviceSubpanelId,role:'tabpanel','aria-labelledby':tabId(deviceSubpanelId,active)});
 const subBar=(area:DeviceMainSection,label:MessageKey,value:string,onChange:(value:string)=>void,list=items(area))=>
  <Tabs variant="pill" overflow="menu" label={t(label)} panelId={deviceSubpanelId} value={value} onChange={onChange} items={subTabs(list,id=>subHref(area,id))} className="sdx-subtabs"/>;
 // A subarea panel: the tabpanel of the bar, or a plain block where the bar is not shown (one subarea).
 const subContent=(barShown:boolean,active:string,content:ReactNode)=><div className="sdx-embedded" {...(barShown?subpanel(active):{})}>{content}</div>;

 // The header: no primary action. Wide: stepper, refresh, Ask assistant, Move to group…, then "More actions". Narrow
 // (760px or less): name, status, mode icon, refresh, Ask assistant and "More actions" in one line; the stepper and
 // Move move into the menu.
 const removal=canOffboard?{blocked:demo?t('kit.unavailable.demo'):saving?t('fleet.menu.saving'):undefined,onSelect:()=>onConfirm(deviceRemovalConfirmation(server,locale,removalContext))}:undefined;
 // Rename, the description and the tags: absent for a removed device, blocked with the reason on sample devices and without groups.manage.
 const live=server.revoked===0;
 const rename=onRename&&live?{blocked:deviceNameBlocked(server,viewer,demo,t),onSelect:onRename}:undefined;
 const description=live?{filled:!!server.description,blocked:deviceDescriptionBlocked(server,viewer,demo,t),onSelect:()=>setMetaEdit({serverId:server.id,kind:'description'})}:undefined;
 const tagsEntry=live?{blocked:deviceTagsBlocked(server,viewer,demo,t),onSelect:()=>setMetaEdit({serverId:server.id,kind:'tags'})}:undefined;
 const powerInput={server,viewer,demo,saving,now};
 const powerEntries={restart:powerMenuEntry('restart-computer',powerInput,setPower,locale),shutdown:powerMenuEntry('shutdown-computer',powerInput,setPower,locale)};
 const editing=metaEdit?.serverId===server.id&&live?metaEdit.kind:null;
 // Esc, Cancel or a save closes the editor; the focus goes back to "More actions", which opened it.
 const closeMeta=()=>{setMetaEdit(null);setTimeout(()=>menuButton.current?.focus(),0);};
 // Pin device: above 760px an IconBtn before the refresh (pressed while pinned), at 760px or narrower the first menu entry.
 const pin=onPin?{pinned,blocked:demo?t('kit.unavailable.demo'):undefined,onSelect:onPin}:undefined;
 const pinControl=pin&&!narrow?<IconBtn icon={Pin} label={t('pins.pin')} pressed={pinned} blocked={pin.blocked} onClick={onPin}/>:null;
 // Move to another customer: only with another visible customer and never for a removed device; blocked with its reason.
 const moveCustomer=customerMove&&customerMoveShown({...customerMove,devices:[server]})?{blocked:customerMoveBlocked({devices:[server],viewer,demo,saving},t),onSelect:()=>void customerMove.onMove([server.id])}:undefined;
 const menu=<Menu label={t('console.moreActions')} trigger={<IconBtn ref={menuButton} icon={MoreHorizontal} label={t('console.moreActions')}/>} entries={deviceHeaderMenu({narrow,pin,step:onStep,move:onMove,moveCustomer,rename,description,tags:tagsEntry,power:powerEntries,removal},t)}/>;
 const refresh=<IconBtn icon={RefreshCw} label={t('management.action.refresh')} blocked={refreshBlocked||undefined} onClick={refreshInventory}/>;
 // Ask assistant: opens the non-modal drawer; when it is open already, the question field takes the focus.
 const ask=()=>{if(assistantOpen)document.getElementById('sdx-assistant-question')?.focus();else onAssistantOpen?.(true);};
 // It is the one tinted control of the header, its focal action. Narrow: the same Btn with sdx-device-ask, 32px high; at 520px or narrower the label is clipped to its accessible name.
 const askControl=canAsk&&onAssistantOpen?<Btn ref={askButton} variant="tinted" icon={Sparkles} className={narrow?'sdx-device-ask':undefined} aria-expanded={assistantOpen} onClick={ask}>{t('device.assistant.ask')}</Btn>:null;
 const modeName=mode==='ReadOnly'?t('device.mode.readOnly'):t('device.mode.management');
 const modeTag=mode&&<span className={narrow?'sdx-tag sdx-tag-icon':'sdx-tag'} title={modeName}>{mode==='Management'?<ShieldCheck size={12} aria-hidden/>:<Eye size={12} aria-hidden/>}{narrow?<span className="sr-only">{t('device.mode.label',{mode:agentModeLabel(mode,t)})}</span>:agentModeLabel(mode,t)}</span>;
 const facts=deviceSubtitle([shortOs(snapshot?.os)||t('fleet.inventoryPending'),snapshot?.build?`Build ${snapshot.build}`:null,address]);
 const metadata=<>
  <DeviceDescription server={server} viewer={viewer} demo={demo} onRefresh={onRefresh} editing={editing==='description'} onClose={closeMeta}/>
  <DeviceTags key={server.id} server={server} viewer={viewer} demo={demo} onRefresh={onRefresh} onOpenOrigin={onOpenTagOrigin} formOpen={editing==='tags'} onFormClose={closeMeta}/>
 </>;
 const assistantShown=assistantOpen&&canAsk;

 return <div className="sdx-device">
  <PageHeader crumbs={crumbs} className="sdx-page-head-device"
   icon={<DeviceTypeMark server={server} size="lg"/>}
   title={<DeviceTitle name={server.name}/>}
   // Wide: one meta line with the facts, then the description and the tags. Narrow: the compact header keeps its layout, the facts last.
   description={narrow?<div className="sdx-device-meta">{metadata}</div>:<div className="sdx-device-meta sdx-device-meta-line"><span className="sdx-device-facts">{facts}</span>{metadata}</div>}
   badges={<><StatusPill kind={connectionPillKind(connection.kind)}>{connection.label}</StatusPill>{modeTag}{narrow&&<span className="sdx-page-line-actions">{refresh}{askControl}{menu}</span>}</>}
   subtitle={narrow?facts:undefined}
   actions={narrow?undefined:<>{onStep&&<span className="sdx-stepper"><IconBtn icon={ChevronLeft} label={t('device.previous')} shortcut="K" onClick={()=>onStep(-1)}/><IconBtn icon={ChevronRight} label={t('device.next')} shortcut="J" onClick={()=>onStep(1)}/></span>}
    {pinControl}
    {refresh}
    {askControl}
    {onMove&&<Btn icon={FolderInput} onClick={onMove}>{t('device.header.move')}</Btn>}
    {menu}</>}/>

  <Tabs items={areaTabs} value={main} onChange={id=>onSection(id as DeviceMainSection)} label={t('device.areas')} panelId={devicePanelId}/>

  <div className="sdx-device-body" key={server.id} id={devicePanelId} role="tabpanel" aria-labelledby={tabId(devicePanelId,main)}>
   {/* One state notice for every area that shows device data; the rules and Configuration show configuration. */}
   {main!=='configuration'&&!(main==='monitoring'&&monitoring!=='alarms')&&<DeviceStateNotice server={server} now={now}/>}
   {uninstall&&<Notice tone={uninstall.tone} icon={PackageX} action={onShowOffboarding&&<Btn size="sm" onClick={onShowOffboarding}>{t('console.offboarding.show')}</Btn>}>{uninstall.text}{uninstall.reason&&<> {uninstall.reason}</>}</Notice>}
   {main==='overview'&&<DeviceSummary server={server} viewer={viewer} demo={demo} now={now} samples={samples} jobs={jobs} historyLoading={historyLoading} onNavigate={navigateOverview} onRefreshInventory={refreshInventory} refreshBlocked={refreshBlocked} onOpenEsuGroup={onOpenEsuGroup} onOpenEsuCustomer={onOpenEsuCustomer} onRefresh={onRefresh}/>}
   {main==='hardware'&&<div className="sdx-embedded"><DeviceHardware key={server.id} server={server} viewer={viewer} demo={demo} now={now} samples={samples} jobs={jobs} historyLoading={historyLoading} focus={hardwareFocus?.serverId===server.id?hardwareFocus:undefined} onNavigate={navigateOverview} detail={hardwareDetail} gpu={detail.gpu} onDetailChange={(next,gpu)=>changeDetail('hardware',next,gpu)} onConfirm={onConfirm} panelId={deviceSubpanelId} subareaHref={(next,gpu)=>deviceSubareaHref(server.id,'hardware',next,{gpu})}/></div>}
   {main==='software'&&<>
    {subBar('software','device.softwareArea',software,value=>changeDetail('software',value))}
    {subContent(true,software,
     software==='programs'?<DeviceSoftware server={server} demo={demo} now={now} owner={canManageInstanceSettings(viewer)}/>
     :software==='drivers'?<DeviceDrivers server={server} demo={demo} now={now} focus={driverFocus?.serverId===server.id?driverFocus:undefined}/>
     :software==='certificates'?<DeviceCertificates server={server} now={now}/>
     :<DeviceAutostart server={server} viewer={viewer} demo={demo} now={now} onRefresh={onRefresh}/>)}
   </>}
   {main==='diagnostics'&&<>
    {subBar('diagnostics','device.diagnosticsArea',diagnosis,value=>{changeDetail('diagnostics',value);setProcessUser('');})}
    {subContent(true,diagnosis,<>
     {diagnosis==='processes'&&<ProcessPanel server={server} viewer={viewer} demo={demo} selectedUser={processUser}/>}
     {diagnosis==='sessions'&&<SessionPanel server={server} viewer={viewer} demo={demo} onSelectUser={user=>{setProcessUser(user);changeDetail('diagnostics','processes');}}/>}
     {diagnosis==='events'&&<EventPanel server={server} viewer={viewer} demo={demo} now={now}/>}
     {diagnosis==='connections'&&<ConnectionsPanel server={server} viewer={viewer} demo={demo}/>}
    </>)}
   </>}
   {main==='management'&&<>
    {subBar('management','device.managementArea',management,value=>{changeDetail('management',value);if(value!=='storage')setFocusDrive(undefined);})}
    {subContent(true,management,
     management==='services'?<DeviceServices server={server} viewer={viewer} demo={demo} saving={saving} onConfirm={onConfirm} now={now}/>
     :management==='storage'?<StoragePanel server={server} viewer={viewer} demo={demo} saving={saving} onConfirm={onConfirm} focusDrive={focusDrive}/>
     :management==='network'?<DeviceNetworkPanel server={server} viewer={viewer} demo={demo} saving={saving} onConfirm={onConfirm} now={now} onOpenConnections={()=>onSection('diagnostics','connections')}/>
     :management==='updates'?<DeviceUpdates server={server} viewer={viewer} demo={demo} saving={saving} onConfirm={onConfirm} now={now} jobs={jobs}/>
     :management==='tasks'?<DeviceTasks server={server} viewer={viewer} demo={demo} saving={saving} onConfirm={onConfirm} now={now} onOpenScheduling={openScheduling}/>
     :management==='defender'?<DeviceDefender server={server} viewer={viewer} demo={demo} now={now} saving={saving} jobs={jobs} onConfirm={onConfirm}/>
     :management==='system'?<DeviceSystem server={server} viewer={viewer} demo={demo} saving={saving} onConfirm={onConfirm} now={now} jobs={jobs}/>
     :management==='accounts'?<DeviceAccounts key={server.id} server={server} viewer={viewer} demo={demo} saving={saving} onConfirm={onConfirm} now={now}/>
     :management==='features'?<RolesFeatures key={server.id} server={server} viewer={viewer} demo={demo} saving={saving} onConfirm={onConfirm} now={now}/>
     :null)}
   </>}
   {main==='remote'&&<>
    {subBar('remote','device.remoteArea',remote,value=>onSection(value as DeviceSection))}
    {subContent(true,remote,<>
     {remote==='files'&&<FilePanel server={server} viewer={viewer} demo={demo}/>}
     {remote==='terminal'&&<TerminalPanel server={server} viewer={viewer} demo={demo}/>}
     {remote==='rdp'&&<RdpPanel server={server} viewer={viewer} demo={demo} onConfirm={onConfirm} saving={saving} onOpenTerminal={()=>onSection('terminal')}/>}
    </>)}
   </>}
   {main==='automation'&&<>
    {subBar('automation','device.automationArea',automation,value=>onSection(value as DeviceSection))}
    {subContent(true,automation,<>
     {automation==='runbooks'&&<RunbookPanel servers={servers} viewer={viewer} demo={demo} serverId={server.id}/>}
     {automation==='desired'&&<DesiredStatePanel servers={servers} viewer={viewer} demo={demo} serverId={server.id}/>}
     {automation==='drift'&&<DriftPanel server={server} viewer={viewer} demo={demo} groups={groups}/>}
    </>)}
   </>}
   {main==='history'&&<>
    {subBar('history','device.historyArea',historyView,value=>changeDetail('history',value),historyItems)}
    {subContent(true,historyView,<HistoryPanel scoped={[server]} servers={servers} viewer={viewer} demo={demo} saving={saving} now={now} jobs={jobs} audit={audit} onSelectJob={onSelectJob} onCancelJob={onCancelJob} single viewSwitch={false}
     tab={historyView} onTab={(value:HistoryDetail)=>changeDetail('history',value)}/>)}
   </>}
   {main==='extensions'&&<>
    {extensionsItems.length>1&&subBar('extensions','device.extensionsArea',extensionsDetail,value=>changeDetail('extensions',value),extensionsItems)}
    {subContent(extensionsItems.length>1,extensionsDetail,<DeviceExtensions server={server} viewer={viewer} demo={demo} now={now} jobs={jobs} releases={pluginReleases} devices={servers} detail={extensionsDetail} zone={detail.zone} onDetail={next=>changeDetail('extensions',next)} onZone={zone=>changeDetail('extensions','dns',undefined,zone??undefined)} onOpenArea={area=>area==='software'?onSection('software'):onSection('management',area)} onConfirm={onConfirm}/>)}
   </>}
   {main==='monitoring'&&<>
    {subBar('monitoring','device.monitoringArea',monitoring,value=>changeDetail('monitoring',value))}
    {monitoring==='alarms'?subContent(true,monitoring,<AlarmHistory device={server} viewer={viewer} demo={demo} now={now} onRefresh={onRefresh??(()=>{})}
     // The focal point: what is watched and who is told, above what fired.
     summary={<MonitoringSummaryRow key={server.id} alertScope={{type:'device',id:server.id}} notificationScope={{type:'device',id:server.id}} demo={demo}
      onOpenAlertRules={()=>changeDetail('monitoring','alert-rules')} onOpenNotificationRules={()=>changeDetail('monitoring','notification-rules')}/>}/>)
     :<div {...subpanel(monitoring)}>{monitoring==='alert-rules'?alerts:notifications}</div>}
   </>}
   {main==='configuration'&&<div>{permissions}</div>}
  </div>
  <Drawer open={assistantShown} onClose={()=>onAssistantOpen?.(false)} modal={false} wide flush icon={Sparkles} returnFocus={askButton} title={t('assistant.title',{name:server.name})}
   actions={<AssistantActions conversation={conversation} earlier={earlier} demo={demo} onOpenEarlier={openEarlier}/>}>
   <DeviceAssistant server={server} viewer={viewer} demo={demo} conversation={conversation} earlier={earlier} onOpenEarlier={openEarlier} onOpenArea={openSourceArea} onOpenSettings={onOpenAssistantSettings} onOpenAccount={onOpenAccount} online={online} onConfirm={onConfirm} onAction={onAction} inDrawer/>
  </Drawer>
  <PowerDrawer target={power} servers={servers.some(device=>device.id===server.id)?servers:[server]} viewer={viewer} demo={demo} saving={saving} now={now} onConfirm={onConfirm} onClose={()=>setPower(null)} returnFocus={menuButton}/>
 </div>;
}
