'use client';
// Settings → Agent releases (Owners only, docs/self-hosting.md "Agent releases"): the release source card in the
// settings column, then the agent releases as a full-width table. The extension releases have their own page
// (Settings → Extensions, ui/settings/extension-releases.tsx); the release source imports both. "Check now" is the page
// primary in the page header (PageFrame.header). One GET /api/releases loads the catalog with the source; the
// page asks again every 5 s while a check is queued or running, else every minute, and on every console refresh.
// A release row opens its details; its menu disables or deletes it after a confirmation, sent through useStepUp
// (no action of this page needs a step-up proof up front; the MFA dialog opens only when the server asks for one). Sample devices change nothing here: the page shows
// and changes the real catalog. The switch "Import dev builds" of the release source card goes through its own useStepUp:
// it moves at once and rolls back when the request fails or the MFA dialog is cancelled. A dev build (X.Y.Z-dev.<sha7>)
// shows the neutral "Dev build" tag and never the accent "Latest".
import {useCallback,useEffect,useRef,useState} from 'react';
import {useClockNow} from '@/ui/base/clock-store';
import {toast} from 'sonner';
import {Ban,Info,Package,PackageOpen,RefreshCw,ShieldCheck,Trash2} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import type {ReleaseSourceView} from '@/lib/server/agent/release-source';
import {sortTableRows} from '@/ui/base/table-sort';
import {formatBytes} from '@/lib/i18n/format';
import {api,message} from '@/ui/base/api';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {useStepUp} from '@/ui/session/step-up-retry';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';
import {DevBuildTag,ReleaseSource,releaseSourceWorking} from '@/ui/settings/release-source';
import {Btn,Card,CopyValue,Drawer,Facts,Menu,SettingsPage,StatusPill,exactTime,relativeTime,type MenuEntry} from '@/ui/kit/kit';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {DataTable,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {useLocale,useT,type Translate} from '@/ui/base/locale';
import '@/ui/settings/release-management.css';

export type Release={id:string;version:string;sha256:string;size:number;createdAt:number;active:boolean;latest:boolean;dev?:boolean;changelog:{features:string[];fixes:string[]}|null};
type Retirement={release:Release;action:'disable'|'delete'};
type RetirePayload={action:'disable'|'delete';releaseId:string;confirm:true};
type DevBuildsPayload={action:'devBuilds';enabled:boolean};
type ReleaseColumn='version'|'registered';
// While a check of the release source is queued or running the page asks every 5 s, else every minute.
export const releasePollMs={busy:5000,idle:60000} as const;

/** The status of a release: available for updates, or disabled. */
export function ReleaseStatus({release}:{release:Pick<Release,'active'>}){
 const t=useT();
 return release.active?<StatusPill kind="success">{t('releases.available')}</StatusPill>:<StatusPill kind="neutral">{t('releases.disabled')}</StatusPill>;
}
/** Why Disable or Delete of a release cannot run: the latest release stays, and one request at a time. */
export function retireBlockedReason(release:Pick<Release,'latest'>,busy:boolean,t:Translate):string|undefined{
 return release.latest?t('releases.latestBlocked'):busy?t('kit.busy'):undefined;
}
/** The row menu of a release: Show details, Disable… (only while active), then Delete… after a separator. */
export function releaseMenu(release:Release,{busy,t,onDetails,onRetire}:{busy:boolean;t:Translate;onDetails:()=>void;onRetire:(action:'disable'|'delete')=>void}):MenuEntry[]{
 const blocked=retireBlockedReason(release,busy,t);
 return [
  {id:'details',label:t('releases.menu.details'),icon:Info,onSelect:onDetails},
  ...(release.active?[{id:'disable',label:t('releases.menu.disable'),icon:Ban,blocked,onSelect:()=>onRetire('disable')}]:[]),
  {id:'separator',separator:true},
  {id:'delete',label:t('releases.menu.delete'),icon:Trash2,danger:true,blocked,onSelect:()=>onRetire('delete')},
 ];
}

/** The tag after the version of a release: the accent "Latest", or the neutral "Dev build" (a dev build is never latest). */
export function ReleaseTag({release}:{release:Pick<Release,'latest'|'dev'>}){
 const t=useT();
 if(release.latest)return <span className="sdx-tag sdx-tag-changed">{t('releases.latest')}</span>;
 return release.dev?<DevBuildTag/>:null;
}

/** The agent release table: Version with the Latest or Dev build tag, Status, Size, Registered and the row menu. The rows come in the server order (newest first) until a column sorts. */
export function ReleasesTable({releases,now,busy,onOpen,onRetire}:{releases:readonly Release[];now:number;busy:boolean;onOpen:(release:Release)=>void;onRetire:(retirement:Retirement)=>void}){
 const t=useT(),[locale]=useLocale(),[sort,setSort]=useState<TableSort<ReleaseColumn>|null>(null);
 const rows=sortTableRows(releases,sort,{version:release=>release.version,registered:release=>release.createdAt});
 const columns:DataColumn<Release>[]=[
  {id:'version',label:t('releases.col.version'),primary:true,sort:{first:'desc'},cell:release=><span className="sdx-release-version"><span className="mono">{release.version}</span><ReleaseTag release={release}/></span>},
  {id:'status',label:t('releases.col.status'),cell:release=><ReleaseStatus release={release}/>},
  {id:'size',label:t('releases.col.size'),mono:true,align:'end',cell:release=>formatBytes(locale,release.size)},
  {id:'registered',label:t('releases.registered'),sort:{first:'desc'},cell:release=><time className="sdx-muted-cell" dateTime={new Date(release.createdAt).toISOString()} title={exactTime(release.createdAt,locale)}>{relativeTime(release.createdAt,now,locale)}</time>},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:release=><Menu label={t('releases.actionsFor',{version:release.version})}
   entries={releaseMenu(release,{busy,t,onDetails:()=>onOpen(release),onRetire:action=>onRetire({release,action})})}/>},
 ];
 return <DataTable<Release> columns={columns} rows={rows} rowKey={release=>release.id} label={t('releases.title')} variant="flush" cards entranceId="agent-releases"
  sort={sort} onSort={next=>setSort(next as TableSort<ReleaseColumn>)} onOpen={onOpen} openLabel={release=>t('agentUpdates.agentVersion',{version:release.version})}
  empty={{icon:PackageOpen,title:t('releases.emptyTitle'),children:t('releases.emptyOwner')}}/>;
}

/** The details of one release: its facts, the changelog and the SHA-256 with its copy button. */
export function ReleaseDetails({release,now}:{release:Release;now:number}){
 const t=useT(),[locale]=useLocale(),log=release.changelog;
 const section=(title:string,entries:string[],empty:string)=><section className="sdx-release-changelog"><h3>{title}</h3>{entries.length?<ul>{entries.map((entry,index)=><li key={index}>{entry}</li>)}</ul>:<p>{empty}</p>}</section>;
 return <div className="sdx-release-details">
  <Facts items={[
   {id:'status',label:t('releases.col.status'),value:<ReleaseStatus release={release}/>},
   {id:'signature',label:t('releases.signature'),value:<span className="sdx-release-signed"><ShieldCheck size={14} aria-hidden/>{t('releases.signed')}</span>},
   {id:'size',label:t('releases.col.size'),value:formatBytes(locale,release.size),mono:true},
   {id:'platform',label:t('releases.col.platform'),value:t('releases.platform')},
   {id:'registered',label:t('releases.registered'),value:relativeTime(release.createdAt,now,locale),hint:exactTime(release.createdAt,locale)},
  ]}/>
  {log?<>{section(t('agentUpdates.notice.features'),log.features,t('releases.noFeatures'))}{section(t('releases.bugfixes'),log.fixes,t('releases.noBugfixes'))}</>:<p className="sdx-release-nolog">{t('releases.noChangelog')}</p>}
  <section className="sdx-release-changelog"><h3>{t('releases.sha256')}</h3><CopyValue value={release.sha256} label={t('releases.copySha')} className="sdx-release-sha"/></section>
 </div>;
}

export default function AgentReleasesPage({viewer,now:pinnedNow,frame}:{viewer:Viewer;now?:number;frame?:PageFrame}){
 const now=useClockNow(pinnedNow);
 const t=useT(),[locale]=useLocale();
 const [data,setData]=useState<{releases:Release[];source:ReleaseSourceView|null;loadedAt:number}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const [detailId,setDetailId]=useState<string|null>(null),[asking,setAsking]=useState<Retirement|null>(null),[checking,setChecking]=useState(false);
 const alive=useRef(true),generation=useRef(0),controller=useRef<AbortController|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
 const load=useCallback(async()=>{
  controller.current?.abort();const request=new AbortController();controller.current=request;const revision=++generation.current;
  setLoading(true);
  try{const value=await api<{releases:Release[];source?:ReleaseSourceView}>('/api/releases',undefined,request.signal);if(!request.signal.aborted&&alive.current&&revision===generation.current){setData({releases:value.releases,source:value.source??null,loadedAt:Date.now()});setError('');}}
  catch(failure){if(!request.signal.aborted&&alive.current&&revision===generation.current)setError(message(failure,locale));}
  finally{if(alive.current&&revision===generation.current)setLoading(false);}
 },[locale]);
 useEffect(()=>{queueMicrotask(()=>void load());},[load,viewer.id]);
 useFrameRefresh(frame,load);
 const working=releaseSourceWorking(data?.source);
 useEffect(()=>{
  const timer=setInterval(()=>void load(),working?releasePollMs.busy:releasePollMs.idle);
  return()=>clearInterval(timer);
 },[load,working]);
 const retire=useStepUp<RetirePayload,unknown>({locale,needsStepUp:()=>false,send:payload=>api('/api/releases',payload)});
 const confirmRetire=async(selected:Retirement)=>{
  setAsking(null);
  const done=await retire.run({action:selected.action,releaseId:selected.release.id,confirm:true});
  if(!alive.current)return;
  if(done===null){void load();return;}
  toast.success(t(selected.action==='disable'?'releases.disabled.toast':'releases.deleted.toast',{version:selected.release.version}));
  if(selected.action==='delete'&&detailId===selected.release.id)setDetailId(null);
  void load();
 };
 const checkNow=async()=>{
  if(checking||working)return;
  setChecking(true);
  try{
   const next=await api<{source:ReleaseSourceView}>('/api/releases',{action:'check'});
   if(!alive.current)return;
   setData(current=>current&&{...current,source:next.source,loadedAt:Date.now()});
   toast.success(t('releaseSource.checkQueued'));
  }catch(failure){if(alive.current)toast.error(message(failure,locale));}
  finally{if(alive.current)setChecking(false);}
 };
 // Import dev builds: a failure shows toast.error through useStepUp and rolls the switch back (false).
 const devBuilds=useStepUp<DevBuildsPayload,{source:ReleaseSourceView}>({locale,needsStepUp:()=>false,send:payload=>api<{source:ReleaseSourceView}>('/api/releases',payload)});
 const changeDevBuilds=async(enabled:boolean)=>{
  const result=await devBuilds.run({action:'devBuilds',enabled});
  if(!result||!alive.current)return false;
  setData(current=>current&&{...current,source:result.source,loadedAt:Date.now()});
  toast.success(t(enabled?'releaseSource.devBuilds.onToast':'releaseSource.devBuilds.offToast'));
  return true;
 };
 const releases=data?.releases??[],detail=releases.find(release=>release.id===detailId),source=data?.source??null;
 const primary=<Btn variant="primary" icon={RefreshCw} loading={checking} blocked={working?t('releaseSource.blocked.running'):undefined} onClick={()=>void checkNow()}>{t('releaseSource.checkNow')}</Btn>;
 const wide=data&&<div className="sdx-release-tables">
  <Card title={t('releases.title')} icon={Package} iconTone="accent" className="sdx-agent-releases" flush>
   <ReleasesTable releases={releases} now={data.loadedAt||now} busy={retire.busy} onOpen={release=>setDetailId(release.id)} onRetire={setAsking}/>
  </Card>
 </div>;
 const retirement=asking?.action==='disable'?{title:'releases.disable.title',body:'releases.disable.body',confirm:'releases.disable.confirm'} as const:{title:'releases.delete.title',body:'releases.delete.body',confirm:'releases.delete.confirm'} as const;
 return <>
  {frameHeader(frame,primary)}
  <SettingsPage className="sdx-agent-releases-page" label={t('nav.settings.agentReleases')} loading={!data&&!error} loadError={error?`${t('releases.loadFailed')}${data?' '+t('notifications.staleData'):''}`:undefined} onRetry={()=>void load()} retrying={loading} wide={wide}>
   {source&&<ReleaseSource source={source} now={data?.loadedAt||now} onDevBuilds={changeDevBuilds} devBuildsBusy={devBuilds.busy}/>}
  </SettingsPage>
  <Drawer open={!!detail} onClose={()=>setDetailId(null)} icon={Package} title={detail?t('agentUpdates.agentVersion',{version:detail.version}):''} description={detail?.latest?t('releases.latest'):detail?.dev?<DevBuildTag/>:undefined}>
   {detail&&<ReleaseDetails release={detail} now={data?.loadedAt||now}/>}
  </Drawer>
  <ConfirmDialog open={!!asking} onOpenChange={open=>{if(!open)setAsking(null);}} tone={asking?.action==='delete'?'danger':'default'}
   title={t(retirement.title,{version:asking?.release.version??''})} body={t(retirement.body)} confirmLabel={t(retirement.confirm)} onConfirm={()=>{if(asking)void confirmRetire(asking);}}/>
  <MfaStepUp {...retire.dialog}/>
  <MfaStepUp {...devBuilds.dialog}/>
 </>;
}
