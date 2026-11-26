'use client';
// Settings → Extensions (#settings/extensions, Owners only, docs/extensions.md "Settings page"): the imported
// extension releases (GET /api/plugins, docs/agent-plugins.md) and their rollout to pilot devices. "Roll out" opens a
// drawer with the devices that run an older version of the extension; the rollout confirms and queues one
// plugin-install job per device (POST /api/plugins deploy, at most 20 devices) on the live MFA login session; the MFA
// dialog opens only when it lapsed. Importing happens through the release source on Agent releases; nothing here
// imports, so the page has no header primary. The page shows the real releases also with sample devices; only Roll
// out stays blocked then, because its targets would be sample devices. The scope tab Extensions reuses the drawer,
// the candidates, the blocked reason and the confirmation (ui/devices/extensions/extensions-tab.tsx).
import {useCallback,useEffect,useRef,useState} from 'react';
import {Package,Puzzle,Server as ServerIcon,Upload} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import {agentMeetsMinimum,comparePluginVersions,snapshotPlugin,PLUGIN_HOST,type PluginReleaseSummary} from '@/lib/plugin-catalog';
import {isDevVersion} from '@/lib/agent-update-state';
import {DevBuildTag} from '@/ui/settings/release-source';
import '@/ui/settings/release-management.css';
import type {PluginReleaseEntry} from '@/lib/server/extensions/plugin-releases';
import {consoleRouteHash} from '@/lib/console-route';
import {api,message,permitted,type Device} from '@/ui/base/api';
import type {Confirmation} from '@/ui/base/confirmation';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';
import {Btn,Card,Drawer,DrawerCancel,IconTile,PickCheckRow,PickList,SettingsPage,exactTime,relativeTime} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {extensionName,pluginCopyKey,targetIcon} from '@/ui/devices/extensions/device-extensions';
import {useLocale,useT,type Translate} from '@/ui/base/locale';
import {useClockNow} from '@/ui/base/clock-store';

/** The most devices one rollout request takes. */
export const pluginRolloutLimit=20;

/**
 * Whether a release replaces an installed extension version by rank (runtime/release-version.mjs): a lower rank, or
 * another dev build of the same base (two dev builds have the same rank; the server takes either).
 */
export function pluginReplaces(installed:string,release:string){
 const rank=comparePluginVersions(installed,release);
 return rank!==null&&(rank<0||(rank===0&&installed!==release&&isDevVersion(release)));
}
/** The devices a release can roll out to: the extension at a lower version, a plugin host, the minimum agent version (a dev agent by its base) and the right plugins.manage. */
export function pluginRolloutCandidates(release:Pick<PluginReleaseSummary,'name'|'version'|'minAgentVersion'>,servers:readonly Device[],viewer:Viewer){
 return servers.filter(server=>{
  const plugin=snapshotPlugin(server.snapshot,release.name),snapshot=server.snapshot;
  return !!plugin&&pluginReplaces(plugin.version,release.version)&&!!snapshot?.agentCapabilities?.includes(PLUGIN_HOST)
   &&agentMeetsMinimum(snapshot.agentVersion,release.minAgentVersion)&&permitted(server,viewer,'plugins.manage');
 }).sort((a,b)=>a.name.localeCompare(b.name,'en',{numeric:true}));
}

/** Why Roll out cannot start: sample devices (its targets would be samples), a disabled release, or no device with an older version. */
export function rolloutBlockedReason(release:Pick<PluginReleaseEntry,'name'|'version'|'minAgentVersion'|'active'>,servers:readonly Device[],viewer:Viewer,demo:boolean,t:Translate):string|undefined{
 if(demo)return t('kit.unavailable.demo');
 if(!release.active)return t('extensions.releases.disabled');
 return pluginRolloutCandidates(release,servers,viewer).length?undefined:t('extensions.releases.noOlder');
}

/** The confirmation of a rollout: one plugin-install job per chosen device (POST /api/plugins deploy). */
export function rolloutConfirmation(release:PluginReleaseSummary,devices:readonly Pick<Device,'id'|'name'>[],t:Translate):Confirmation{
 const ids=devices.map(device=>device.id);
 return {title:t('extensions.rollout.confirmTitle',{extension:extensionName(release.target,t),version:release.version,count:ids.length}),description:t(pluginCopyKey(release.name,'installHint')),
  lines:[{label:t(devices.length===1?'extensions.confirm.deviceLabel':'extensions.confirm.devicesLabel'),value:devices.map(device=>device.name).join(', ')}],confirmLabel:t('extensions.releases.rollOut'),
  payload:{action:'deploy',releaseId:release.id,serverIds:ids,confirm:true},endpoint:'/api/plugins',success:t('extensions.rollout.toast',{count:ids.length})};
}

/** The pick list of pilot devices: checkbox rows with the current extension version, at most 20. A close with devices chosen asks first. */
export function RolloutDrawer({release,name,candidates,onClose,onSubmit,initialSelection=[]}:{release:PluginReleaseSummary;name:string;candidates:Device[];onClose:()=>void;onSubmit:(ids:string[])=>void;/** Tests: the devices chosen at the start. */initialSelection?:string[]}){
 const t=useT();
 const [selection,setSelection]=useState<string[]>(initialSelection);
 const blocked=!selection.length?t('extensions.rollout.pickOne'):selection.length>pluginRolloutLimit?t('extensions.rollout.tooMany',{count:pluginRolloutLimit}):undefined;
 return <Drawer open onClose={onClose} dirty={selection.length>0} icon={Upload} title={t('extensions.rollout.title',{extension:name,version:release.version})} description={t('extensions.rollout.hint')}
  footer={<><DrawerCancel/><Btn variant="primary" icon={Upload} blocked={blocked} onClick={()=>onSubmit(selection)}>{t('extensions.rollout.submit',{count:selection.length})}</Btn></>}>
  <PickList mode="checkbox" label={t('extensions.rollout.devices')}>{candidates.map(server=><PickCheckRow key={server.id} checked={selection.includes(server.id)} icon={<ServerIcon size={15} aria-hidden/>} label={server.name}
   hint={t('extensions.rollout.current',{version:snapshotPlugin(server.snapshot,release.name)?.version??''})} onChange={checked=>setSelection(previous=>checked?[...previous,server.id]:previous.filter(id=>id!==server.id))}/>)}</PickList>
 </Drawer>;
}

/**
 * The rollout of one release to devices: the drawer with the candidates among `devices`, then the shared confirmation.
 * The settings page passes every device, the scope tab its scoped devices.
 */
export function ExtensionRollout({release,devices,viewer,onClose,onConfirm}:{release:PluginReleaseSummary;devices:readonly Device[];viewer:Viewer;onClose:()=>void;onConfirm:(confirmation:Confirmation)=>void}){
 const t=useT(),candidates=pluginRolloutCandidates(release,devices,viewer);
 return <RolloutDrawer key={release.id} release={release} name={extensionName(release.target,t)} candidates={candidates} onClose={onClose}
  onSubmit={ids=>{const chosen=candidates.filter(server=>ids.includes(server.id));onClose();onConfirm(rolloutConfirmation(release,chosen,t));}}/>;
}

/** The release table: Extension, Version (with the "Dev build" tag of a dev build), Minimum agent, Installed on, Imported and the Roll out button per row. */
export function ExtensionReleasesTable({releases,servers,viewer,demo,now,onRollOut}:{releases:readonly PluginReleaseEntry[];servers:readonly Device[];viewer:Viewer;demo:boolean;now:number;onRollOut:(release:PluginReleaseEntry)=>void}){
 const t=useT(),[locale]=useLocale();
 const columns:DataColumn<PluginReleaseEntry>[]=[
  {id:'extension',label:t('extensions.releases.col.extension'),primary:true,cell:release=><span className="sdx-extension-name"><IconTile icon={targetIcon(release.target)} tone="accent"/><span><strong>{extensionName(release.target,t)}</strong><small className="mono">{release.name}</small></span></span>},
  {id:'version',label:t('extensions.releases.col.version'),cell:release=><span className="sdx-release-version"><span className="mono">{release.version}</span>{release.dev&&<DevBuildTag/>}</span>},
  {id:'minAgent',label:t('extensions.releases.col.minAgent'),mono:true,cell:release=>release.minAgentVersion},
  {id:'installed',label:t('extensions.releases.col.installed'),cell:release=>t('extensions.releases.installedCount',{count:servers.filter(server=>snapshotPlugin(server.snapshot,release.name)?.version===release.version).length})},
  {id:'imported',label:t('extensions.releases.col.imported'),cell:release=><span title={exactTime(release.createdAt,locale)}>{relativeTime(release.createdAt,now,locale)}</span>},
  {id:'rollOut',label:t('extensions.releases.rollOut'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:release=><Btn size="sm" icon={Upload} blocked={rolloutBlockedReason(release,servers,viewer,demo,t)} onClick={()=>onRollOut(release)}>{t('extensions.releases.rollOut')}</Btn>},
 ];
 return <DataTable<PluginReleaseEntry> columns={columns} rows={releases} rowKey={release=>release.id} label={t('extensions.releases.title')} variant="flush" cards entranceId="extension-releases"
  empty={{icon:Puzzle,title:t('extensions.releases.empty'),children:t('extensions.releases.emptyHint'),
   action:<a className="sdx-btn sdx-btn-secondary" href={consoleRouteHash({view:'settings',page:'agent-releases'})}><Package size={15} aria-hidden/><span>{t('extensions.releases.openAgentReleases')}</span></a>}}/>;
}

/**
 * The settings page: the frame header without a primary, then one SettingsPage whose full-width part holds the
 * release card. First load: the Skeleton; a failed load: LoadFailed with Try again; a failed refresh keeps the
 * loaded rows below the error. It loads again on every console refresh.
 */
export default function ExtensionsPage({servers,viewer,demo,now:pinnedNow,onConfirm,frame}:{servers:Device[];viewer:Viewer;demo:boolean;
 /** Pins the time (tests); without it the page follows the console clock every second. */
 now?:number;onConfirm:(confirmation:Confirmation)=>void;frame?:PageFrame}){
 const now=useClockNow(pinnedNow);
 const t=useT(),[locale]=useLocale();
 const [releases,setReleases]=useState<PluginReleaseEntry[]|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[rollout,setRollout]=useState<string|null>(null);
 const sequence=useRef(0);
 const load=useCallback(()=>{
  const current=++sequence.current;
  setLoading(true);
  api<{releases:PluginReleaseEntry[]}>('/api/plugins').then(result=>{if(current===sequence.current){setReleases(result.releases);setError('');}},failure=>{if(current===sequence.current)setError(message(failure,locale));}).finally(()=>{if(current===sequence.current)setLoading(false);});
 },[locale]);
 useEffect(()=>{queueMicrotask(load);},[load,viewer.id]);
 useFrameRefresh(frame,load);
 const selected=releases?.find(release=>release.id===rollout)??null;
 const wide=releases&&<Card title={t('extensions.releases.title')} icon={Puzzle} iconTone="accent" meta={t('extensions.releases.meta')} className="sdx-extension-releases" flush>
  <ExtensionReleasesTable releases={releases} servers={servers} viewer={viewer} demo={demo} now={now} onRollOut={release=>setRollout(release.id)}/>
 </Card>;
 return <>
  {frameHeader(frame)}
  <SettingsPage className="sdx-extensions-page" label={t('nav.settings.extensions')} loading={!releases&&!error}
   loadError={error?`${t('extensions.releases.loadFailed')}${releases?' '+t('notifications.staleData'):''}`:undefined} onRetry={load} retrying={loading} wide={wide}/>
  {selected&&<ExtensionRollout release={selected} devices={servers} viewer={viewer} onClose={()=>setRollout(null)} onConfirm={onConfirm}/>}
 </>;
}
