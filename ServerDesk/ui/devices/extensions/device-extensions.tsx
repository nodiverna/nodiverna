'use client';
// The device area "Extensions" (#device/<id>/extensions, docs/extensions.md): what the portal detects on one
// Windows server (a Windows role or a known server product, lib/extensions.ts) and which agent extensions it
// offers for it, runs, or does not have yet (docs/agent-plugins.md: the UI calls a plugin an extension). Up to
// three sections, each only with entries:
// 1. "Available for this device", the focal point: one card per offered extension with "Install extension".
// 2. "Installed": the extensions of the agent on this device with their state and one row Menu (Open DHCP or
//    DNS, Repair extension, the jump to Roles & features or Software, Remove extension last).
// 3. "Detected, no extension yet": the other detected roles and products, with the jump to their area.
// A started install moves its entry from the offers to "Installed" (Installing…, then waiting for the agent,
// then Installed), from the console's jobs and the next report. Install, repair and removal confirm and queue a
// job (POST /api/plugins) on the live MFA login session. The detail "dhcp" shows the DHCP server of the
// extension (device-dhcp.tsx), the detail "dns" the DNS server (device-dns.tsx).
import {useEffect,useState,type ReactNode} from 'react';
import {AppWindow,ArchiveRestore,BadgeCheck,Boxes,ChevronRight,CloudCog,Download,ExternalLink,Database,DatabaseBackup,FolderSync,FolderTree,Globe,HardDriveDownload,KeyRound,Layers,LayoutGrid,Mail,MonitorCog,Network,PackageCheck,Printer,Puzzle,RefreshCcwDot,Router,ScanSearch,ShieldCheck,Trash2,Waypoints,Wrench} from 'lucide-react';
import type {Job,Server,Viewer} from '@/lib/types';
import type {Confirmation} from '@/ui/base/confirmation';
import {detectTargets,deviceTargetOrder,detectionEntry,extensionState,type DetectedTarget,type DetectionIcon,type ExtensionState} from '@/lib/extensions';
import type {MessageKey} from '@/lib/i18n/translate';
import {agentMeetsMinimum,pluginReportTarget,PLUGIN_HOST,PLUGIN_HOST_MIN_AGENT,PLUGIN_INSTALL,PLUGIN_REMOVE,type PluginReleaseSummary} from '@/lib/plugin-catalog';
import {connectionKind} from '@/lib/device-connection';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {agentMessageText} from '@/lib/agent-messages';
import {permitted} from '@/ui/base/api';
import {Btn,Card,Empty,EntranceList,IconTile,Menu,PanelUnavailable,SectionHead,StatusPill,claimEntrance,shortOs,type MenuEntry} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {useT,type Translate} from '@/ui/base/locale';
import DeviceDhcp from '@/ui/devices/extensions/device-dhcp';
import DeviceDns from '@/ui/devices/extensions/device-dns';
import {EMPTY_VALUE} from '@/lib/i18n/format';

/** The lucide component of every catalog icon name. */
export const detectionIcons={Network,Router,Globe,FolderTree,FolderSync,Printer,AppWindow,Boxes,MonitorCog,RefreshCcwDot,BadgeCheck,KeyRound,ShieldCheck,Waypoints,HardDriveDownload,Layers,Database,Mail,LayoutGrid,DatabaseBackup,ArchiveRestore,CloudCog} satisfies Record<DetectionIcon,unknown>;
/** The icon of a detection id; Puzzle for an id the catalog does not know. */
export const targetIcon=(id:string)=>{const entry=detectionEntry(id);return entry?detectionIcons[entry.icon]:Puzzle;};
/** The label of a detection id (its catalog name), or the id itself. */
export const targetLabel=(id:string,t:Translate)=>{const entry=detectionEntry(id);return entry?t(entry.label):id;};

/** The targets with their own extension copy; every other target gets the neutral "other" set with its name. */
type ExtensionCopySet='dhcp'|'dns'|'other';
const copySet=(target:string):ExtensionCopySet=>target==='dhcp'||target==='dns'?target:'other';
/** The name of the extension of a target: "DHCP extension", "DNS extension", else "<target label> extension". */
export function extensionName(target:string,t:Translate):string{
 const set=copySet(target);
 return set==='other'?t('extensions.name.other',{target:targetLabel(target,t)}):t(`extensions.name.${set}`);
}
/** The one sentence of an offered extension: what it lets the technician do in the portal. */
export function extensionOffer(target:string,t:Translate):string{
 const set=copySet(target);
 return set==='other'?t('extensions.offer.other',{target:targetLabel(target,t)}):t(`extensions.offer.${set}`);
}

/** The name cell: icon tile (accent for roles, neutral for products), the catalog name and the sources below it. */
export function DetectedName({entry,small=false}:{entry:DetectedTarget;small?:boolean}){
 const t=useT(),definition=detectionEntry(entry.id);
 if(!definition)return null;
 return <span className="sdx-extension-name">
  <IconTile icon={detectionIcons[definition.icon]} tone={entry.kind!=='software'?'accent':'neutral'} size={small?'sm':'md'}/>
  <span><strong>{t(definition.label)}</strong>{!small&&entry.sources.length>0&&<small>{entry.sources.join(', ')}</small>}</span>
 </span>;
}
/** The version cell: roles and features are part of the OS; products show their version in tabular figures or a dash. */
export function DetectedVersion({entry,os,t}:{entry:DetectedTarget;os:string|null|undefined;t:Translate}){
 if(entry.kind!=='software')return <span className="sdx-muted-cell">{t('extensions.version.builtIn',{os:shortOs(os)})}</span>;
 return entry.version?<span className="mono">{entry.version}</span>:<span className="sdx-muted-cell">{EMPTY_VALUE}</span>;
}
/** The text of a damaged extension's AGENT_PLUGIN_* code, or the plain label. */
export const damagedText=(error:string|null,t:Translate)=>error?agentMessageText({result:t('extensions.state.damaged'),resultCode:error,resultArgs:{}},t)??t('extensions.state.damaged'):t('extensions.state.damaged');
/**
 * The extension state cell: a pill for an installed, damaged, installing or reporting extension, a waiting pill
 * for a planned one, muted text for an available one or a target without an extension. Text, never color alone.
 * The pills share one wrapper, so a row that moves installing, reporting, installed transitions the pill color;
 * only the running install pulses (extensions.css). A reporting extension shows why it waits as a visible line
 * below the pill (no tooltip, so touch and keyboard users read it too).
 */
export function ExtensionStatePill({state,t}:{state:ExtensionState;t:Translate}){
 const pill=(content:ReactNode)=><span className="sdx-extension-state" data-state={state.state}>{content}</span>;
 if(state.state==='installed')return pill(<StatusPill kind="success">{t('extensions.state.installed',{version:state.version})}</StatusPill>);
 if(state.state==='damaged')return pill(<StatusPill kind="critical" title={damagedText(state.error,t)}>{t('extensions.state.damaged')}</StatusPill>);
 if(state.state==='installing')return pill(<StatusPill kind="waiting">{t(state.repair?'extensions.state.repairing':'extensions.state.installing')}</StatusPill>);
 if(state.state==='reporting')return pill(<><StatusPill kind="success">{t('extensions.state.reporting')}</StatusPill><small className="sdx-extension-state-hint">{t('extensions.state.reportingHint')}</small></>);
 if(state.state==='available')return <span className="sdx-muted-cell">{t('extensions.state.available')}</span>;
 if(state.state==='planned')return <StatusPill kind="waiting" title={t('extensions.state.plannedHint')}>{t('extensions.state.planned')}</StatusPill>;
 return <span className="sdx-muted-cell">{t('extensions.state.none')}</span>;
}

/** Whether an extension install or removal of this device is pending or running. */
export const pluginJobOpen=(jobs:readonly Pick<Job,'serverId'|'action'|'state'>[],serverId:string)=>jobs.some(job=>job.serverId===serverId&&(job.action===PLUGIN_INSTALL||job.action===PLUGIN_REMOVE)&&(job.state==='pending'||job.state==='running'));
/**
 * The reason an extension install, repair or removal is blocked, in this order: demo, the right plugins.manage,
 * offline, an agent without plugin-host or below the release's minimum version, an open extension job. Undefined
 * when allowed.
 */
export function pluginActionBlocked(input:{server:Server;viewer:Viewer;demo:boolean;now:number;jobs:readonly Job[];minAgentVersion?:string},t:Translate):string|undefined{
 const {server,viewer,demo,now,jobs}=input,snapshot=server.snapshot,minimum=input.minAgentVersion??PLUGIN_HOST_MIN_AGENT;
 if(demo)return t('kit.unavailable.demo');
 if(!permitted(server,viewer,'plugins.manage'))return t('extensions.blocked.right');
 if(connectionKind(server,now)!=='online')return t('extensions.blocked.offline');
 if(!snapshot?.agentCapabilities?.includes(PLUGIN_HOST)||!agentMeetsMinimum(snapshot.agentVersion,minimum))return t('extensions.blocked.agent',{version:minimum});
 if(pluginJobOpen(jobs,server.id))return t('extensions.blocked.busy');
 return undefined;
}

type PluginCopyKey='installTitle'|'repairTitle'|'removeTitle'|'installHint'|'removeHint';
/** The message key of one text of an extension's confirmation copy (extensions.confirm.<dhcp|dns|other>.<key>), by its plugin name. */
export const pluginCopyKey=(name:string,key:PluginCopyKey):MessageKey=>`extensions.confirm.${copySet(name)}.${key}`;
/**
 * The display name of a plugin: the label of its target (detectionEntry of pluginReportTarget, so a snapshot stored
 * with only the older role works too), else its technical name. Never another plugin's name.
 */
export function pluginDisplayName(plugin:{name:string;target?:string|null;role?:string|null},t:Translate):string{
 const entry=detectionEntry(pluginReportTarget(plugin)||plugin.name);
 return entry?t(entry.label):plugin.name;
}
/** The extension name of a plugin for the confirmation lines: "DHCP extension", else "<target label or technical name> extension". */
function pluginExtensionName(plugin:{name:string;target?:string|null;role?:string|null},t:Translate):string{
 const set=copySet(pluginReportTarget(plugin)||plugin.name);
 return set==='other'?t('extensions.name.other',{target:pluginDisplayName(plugin,t)}):t(`extensions.name.${set}`);
}
/** The confirmations of install, repair and removal: each confirms and queues the job; MFA opens only for a lapsed session. Title and description come from the extension's own copy set. */
export function pluginInstallConfirmation(server:Pick<Server,'id'|'name'>,release:PluginReleaseSummary,repair:boolean,t:Translate):Confirmation{
 return {title:t(pluginCopyKey(release.name,repair?'repairTitle':'installTitle'),{device:server.name,extension:pluginDisplayName(release,t)}),description:t(pluginCopyKey(release.name,'installHint')),
  lines:[{label:t('extensions.confirm.deviceLabel'),value:server.name},{label:t('extensions.confirm.extensionLabel'),value:`${pluginExtensionName(release,t)} ${release.version}`}],confirmLabel:t(repair?'extensions.repair':'extensions.install'),
  payload:{action:'install',serverId:server.id,plugin:release.name,confirm:true},endpoint:'/api/plugins',success:t('extensions.toast.install')};
}
/** plugin: the plugin as the snapshot reports it (name, target or older role, and version). */
export function pluginRemoveConfirmation(server:Pick<Server,'id'|'name'>,plugin:{name:string;target?:string|null;role?:string|null;version?:string|null},t:Translate):Confirmation{
 const name=pluginExtensionName(plugin,t);
 return {title:t(pluginCopyKey(plugin.name,'removeTitle'),{device:server.name,extension:pluginDisplayName(plugin,t)}),description:t(pluginCopyKey(plugin.name,'removeHint')),
  lines:[{label:t('extensions.confirm.deviceLabel'),value:server.name},{label:t('extensions.confirm.extensionLabel'),value:plugin.version?`${name} ${plugin.version}`:name}],confirmLabel:t('extensions.remove'),tone:'danger',
  payload:{action:'remove',serverId:server.id,plugin:plugin.name,confirm:true},endpoint:'/api/plugins',success:t('extensions.toast.remove')};
}

const refreshConsole=()=>window.dispatchEvent(new Event('serverdesk:refresh'));
/** How often the Extensions area asks for a reload while a row waits for the agent's report. */
export const PLUGIN_REPORT_POLL_MS=10_000;
/**
 * The poll of the Extensions area (never in demo mode): a reload every 10 s while a row is reporting, until no row
 * is or the area unmounts. It goes through serverdesk:refresh, so it shares the console's one request and never
 * replays the entrance motion. The reload when an extension job ends is the console's (useConsoleData), so it
 * runs from every view.
 */
function usePluginRefresh(demo:boolean,reporting:boolean){
 useEffect(()=>{
  if(demo||!reporting)return;
  const timer=setInterval(refreshConsole,PLUGIN_REPORT_POLL_MS);
  return()=>clearInterval(timer);
 },[demo,reporting]);
}

/** The install-blocked reason of an extension whose install job is open (busy) or whose succeeded install the agent has not reported yet; undefined otherwise. */
export function pluginStateBlocked(state:ExtensionState,t:Translate):string|undefined{
 if(state.state==='installing')return t('extensions.blocked.busy');
 if(state.state==='reporting')return t('extensions.blocked.reporting');
 return undefined;
}

/** The three sections of the area: offered extensions, installed (or installing) extensions, and detections without one. */
export type ExtensionGroup='available'|'installed'|'detected';
/** The section of a detected target: no extension → detected; available or planned → available; every other state (a started install too) → installed. */
export function extensionGroup(entry:Pick<DetectedTarget,'extension'>,state:ExtensionState):ExtensionGroup{
 if(entry.extension===null||state.state==='none')return 'detected';
 return state.state==='available'||state.state==='planned'?'available':'installed';
}
/** The entrance ids of the two tables: a table that appears later (after an install) shows at once, without its entrance. */
const entrance={offers:'device-extension-offers',installed:'device-extensions-installed',detected:'device-extensions-detected'} as const;

export type ExtensionsArea='features'|'software'|'services';
export type ExtensionsDetail='overview'|'dhcp'|'dns';
type Props={server:Server;viewer:Viewer;demo:boolean;now:number;jobs:Job[];releases?:readonly PluginReleaseSummary[];
 /** The visible devices: the DHCP view matches failover partners among them. */
 devices?:readonly Server[];
 detail:ExtensionsDetail;onDetail:(detail:ExtensionsDetail)=>void;onOpenArea:(area:ExtensionsArea)=>void;onConfirm:(confirmation:Confirmation)=>void;
 /** The open DNS zone from the link (#device/<id>/extensions/dns/<zone>) and its change; without onZone the DNS view keeps its own state. */
 zone?:string;onZone?:(zone:string|null)=>void};

export default function DeviceExtensions({server,viewer,demo,now,jobs,releases,devices,detail,onDetail,onOpenArea,onConfirm,zone,onZone}:Props){
 const t=useT();
 const detected=deviceTargetOrder(detectTargets(server)),os=server.snapshot?.os;
 const stateOf=(entry:Pick<DetectedTarget,'extension'>)=>extensionState(entry,server,releases,jobs);
 const rows=detected.map(entry=>({entry,state:stateOf(entry)}));
 const groups={available:rows.filter(row=>extensionGroup(row.entry,row.state)==='available'),installed:rows.filter(row=>extensionGroup(row.entry,row.state)==='installed'),detected:rows.filter(row=>extensionGroup(row.entry,row.state)==='detected')};
 // A section that is empty on the first render shows its later rows at once (the install moves a card into "Installed"), so no entrance plays then.
 useState(()=>{if(!groups.installed.length)claimEntrance(entrance.installed);if(!groups.detected.length)claimEntrance(entrance.detected);return true;});
 usePluginRefresh(demo,rows.some(row=>row.state.state==='reporting'));
 const blocked=(minAgentVersion?:string)=>pluginActionBlocked({server,viewer,demo,now,jobs,minAgentVersion},t);
 const install=(release:PluginReleaseSummary|undefined,repair:boolean)=>{if(release&&!blocked(release.minAgentVersion))onConfirm(pluginInstallConfirmation(server,release,repair,t));};
 const releaseOf=(name:string|null)=>name?releases?.find(release=>release.name===name):undefined;
 const installReason=(release:PluginReleaseSummary|undefined)=>release?blocked(release.minAgentVersion):t('extensions.blocked.noRelease');
 // The blocked order: the extension's own state (installing, reporting), no release, then the general reasons.
 const offerBlocked=(state:ExtensionState,release:PluginReleaseSummary|undefined)=>pluginStateBlocked(state,t)??installReason(release);
 // The detail views: the extension's own state blocks first (installing, reporting), then the general reasons.
 const detailInstall=(plugin:'dhcp'|'dns')=>{
  const state=stateOf({extension:plugin}),release=releaseOf(plugin),reason=offerBlocked(state,release);
  return {installBlocked:reason,onInstall:()=>{if(!reason)install(release,state.state==='damaged');}};
 };
 if(detail==='dhcp'&&detected.some(entry=>entry.id==='dhcp'))return <DeviceDhcp server={server} viewer={viewer} demo={demo} now={now} jobs={jobs}
  {...detailInstall('dhcp')} onOpenServices={()=>onOpenArea('services')} devices={devices} onConfirm={onConfirm}/>;
 if(detail==='dns'&&detected.some(entry=>entry.id==='dns'))return <DeviceDns server={server} viewer={viewer} demo={demo} now={now} jobs={jobs}
  {...detailInstall('dns')} onOpenServices={()=>onOpenArea('services')} devices={devices} onConfirm={onConfirm} zone={zone} onZone={onZone}/>;

 const areaOf=(entry:DetectedTarget):'features'|'software'=>entry.kind==='software'?'software':'features';
 const areaLabel=(entry:DetectedTarget)=>t(areaOf(entry)==='software'?'extensions.openSoftware':'extensions.openFeatures');
 /** The detail view a row opens: DHCP or DNS when that extension is installed, else nothing (the row opens its area). */
 const detailOf=(entry:DetectedTarget,state:ExtensionState):'dhcp'|'dns'|null=>state.state==='installed'&&(entry.extension==='dhcp'||entry.extension==='dns')?entry.extension:null;
 const open=(entry:DetectedTarget,state:ExtensionState)=>{const target=detailOf(entry,state);if(target)onDetail(target);else onOpenArea(areaOf(entry));};
 const openLabel=(entry:DetectedTarget,state:ExtensionState)=>{const target=detailOf(entry,state);return target?t(target==='dhcp'?'extensions.openDhcp':'extensions.openDns'):`${targetLabel(entry.id,t)}: ${areaLabel(entry)}`;};
 const jump=(entry:DetectedTarget):MenuEntry=>({id:'area',label:areaLabel(entry),icon:ChevronRight,onSelect:()=>onOpenArea(areaOf(entry))});
 /**
  * The row Menu of an installed extension (nodiverna-ui §4): Open DHCP or DNS when installed, Repair extension when
  * damaged, the jump to Roles & features or Software, then Remove extension last after a separator when installed.
  */
 const installedEntries=(entry:DetectedTarget,state:ExtensionState):MenuEntry[]=>{
  const list:MenuEntry[]=[],target=detailOf(entry,state);
  if(target)list.push({id:'open',label:t(target==='dhcp'?'extensions.openDhcp':'extensions.openDns'),icon:ExternalLink,onSelect:()=>onDetail(target)});
  if(state.state==='damaged'){const release=releaseOf(entry.extension);list.push({id:'repair',label:t('extensions.repair'),icon:Wrench,blocked:offerBlocked(state,release),onSelect:()=>install(release,true)});}
  list.push(jump(entry));
  if(state.state==='installed'&&entry.extension){
   const removeBlocked=blocked(),reported=server.snapshot?.plugins?.find(plugin=>plugin.name===entry.extension),plugin=entry.extension;
   list.push({id:'separator',separator:true},{id:'remove',label:t('extensions.remove'),icon:Trash2,danger:true,blocked:removeBlocked,onSelect:()=>{if(!removeBlocked)onConfirm(pluginRemoveConfirmation(server,reported??{name:plugin,version:state.version},t));}});
  }
  return list;
 };
 type Row=(typeof rows)[number];
 const menu=(row:Row,entries:MenuEntry[])=><Menu label={t('tree.actionsForName',{name:targetLabel(row.entry.id,t)})} entries={entries}/>;
 const installedVersion=(state:ExtensionState)=>state.state==='installed'||state.state==='damaged'||state.state==='reporting'?state.version:null;
 const installedColumns:DataColumn<Row>[]=[
  {id:'extension',label:t('extensions.col.extension'),primary:true,className:'sdx-extension-name-cell',cell:row=><span className="sdx-extension-name">
   <IconTile icon={targetIcon(row.entry.id)} tone="accent"/><span><strong>{extensionName(row.entry.id,t)}</strong><small>{targetLabel(row.entry.id,t)}</small></span></span>},
  {id:'version',label:t('extensions.col.version'),cell:row=>{const version=installedVersion(row.state);return version?<span className="mono">{version}</span>:<span className="sdx-muted-cell">{EMPTY_VALUE}</span>;}},
  {id:'state',label:t('extensions.col.state'),cell:row=><ExtensionStatePill state={row.state} t={t}/>},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:row=>menu(row,installedEntries(row.entry,row.state))},
 ];
 const detectedColumns:DataColumn<Row>[]=[
  {id:'detected',label:t('extensions.col.detected'),primary:true,className:'sdx-extension-name-cell',cell:row=><DetectedName entry={row.entry}/>},
  {id:'kind',label:t('extensions.col.kind'),cell:row=>t(`extensions.kind.${row.entry.kind}`)},
  {id:'version',label:t('extensions.col.version'),cell:row=><DetectedVersion entry={row.entry} os={os} t={t}/>},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:row=>menu(row,[jump(row.entry)])},
 ];
 const offer=({entry,state}:Row)=>{
  const release=state.state==='available'?state.release:undefined;
  return <Card key={entry.id} level={3} className="sdx-extension-offer" title={extensionName(entry.id,t)} icon={targetIcon(entry.id)} iconTone="accent" description={extensionOffer(entry.id,t)}
   meta={release?t('extensions.release',{version:release.version}):<ExtensionStatePill state={state} t={t}/>}
   actions={<Btn size="sm" icon={Download} blocked={offerBlocked(state,release)} onClick={()=>install(release,false)}>{t('extensions.install')}</Btn>}>{null}</Card>;
 };
 const counts=[
  groups.available.length?t('extensions.device.availableCount',{count:groups.available.length}):'',
  groups.installed.length?t('extensions.device.installedCount',{count:groups.installed.length}):'',
  groups.detected.length?t('extensions.device.detectedCount',{count:groups.detected.length}):'',
 ].filter(Boolean).join(' · ');
 // nodiverna-ui §4 "Device section": the hidden title with the counts, one panel notice for the extension actions, then the sections.
 const notice=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,'plugins.manage'),reported:true,supported:true});
 return <section className="sdx-health-tab sdx-device-extensions" aria-labelledby="sdx-device-extensions-title">
  <SectionHead hideTitle id="sdx-device-extensions-title" title={t('extensions.device.title')} meta={counts}/>
  <PanelUnavailable reason={notice} readOnly={t('extensions.device.readOnly')}/>
  {!detected.length&&<Empty icon={ScanSearch} title={t('extensions.empty.none')}>{t('extensions.empty.noneHint')}</Empty>}
  {groups.available.length>0&&<section className="sdx-extension-section" aria-labelledby="sdx-extension-offers-title">
   <h2 id="sdx-extension-offers-title" className="sdx-extension-section-title">{t('extensions.device.availableTitle')}</h2>
   <EntranceList id={entrance.offers} className="sdx-extension-offers">{groups.available.map(offer)}</EntranceList>
  </section>}
  {groups.installed.length>0&&<Card title={t('extensions.device.installedTitle')} icon={PackageCheck} iconTone="success" flush>
   <DataTable<Row> variant="flush" cards label={t('extensions.device.installedTitle')} entranceId={entrance.installed} columns={installedColumns} rows={groups.installed} rowKey={row=>row.entry.id}
    onOpen={row=>open(row.entry,row.state)} openLabel={row=>openLabel(row.entry,row.state)} empty={{icon:ScanSearch,title:t('extensions.empty.none')}}/>
  </Card>}
  {groups.detected.length>0&&<Card title={t('extensions.device.detectedTitle')} icon={ScanSearch} iconTone="neutral" flush>
   <DataTable<Row> variant="flush" cards label={t('extensions.device.detectedTitle')} entranceId={entrance.detected} columns={detectedColumns} rows={groups.detected} rowKey={row=>row.entry.id}
    onOpen={row=>open(row.entry,row.state)} openLabel={row=>openLabel(row.entry,row.state)} empty={{icon:ScanSearch,title:t('extensions.empty.none')}}/>
  </Card>}
 </section>;
}
