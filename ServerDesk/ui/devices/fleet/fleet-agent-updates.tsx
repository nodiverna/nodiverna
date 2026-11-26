'use client';

import {createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {AlertTriangle, ArrowUpCircle, CheckCircle2, Loader2, RefreshCw} from 'lucide-react';
import {agentChangesBetween, compareAgentVersions, isDevVersion, type DeviceRelease, type DeviceUpdateCampaign, type DeviceUpdateState, type UpdateReceipt} from '@/lib/agent-update-state';
import {inspectDeviceUpdates} from '@/ui/devices/device/agent-update-model';
import type {MessageKey} from '@/lib/i18n/translate';
import {fleetDeviceUpdate, fleetUpdateLimit, groupFleetUpdates, type FleetUpdateGroup, type FleetUpdateTarget} from '@/ui/devices/fleet/fleet-agent-update-state';
import type {Job, Viewer} from '@/lib/types';
import {api, ApiError, message, stamp, type Device} from '@/ui/base/api';
import {isOwner} from '@/ui/base/access-capabilities';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {crossCustomerHint,crossCustomerLockReason,targetCustomerCount} from '@/ui/base/cross-customer';
import '@/ui/devices/fleet/fleet-agent-updates.css';

import {useLocale,useT,useStableT} from '@/ui/base/locale';
import {useClockNow} from '@/ui/base/clock-store';
import {connectionKind} from '@/lib/device-connection';
import {Btn,Drawer,Empty,IconBtn,Notice,Skeleton} from '@/ui/kit/kit';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {EMPTY_VALUE} from '@/lib/i18n/format';
// history: the bundled changelogs of every agent version (GET /api/releases); anything but a list counts as none.
// devBuilds: Import dev builds is on, so the targets may be offered a dev build (with its "Dev build" tag).
type ReleaseData={releases:DeviceRelease[];campaigns:DeviceUpdateCampaign[];history?:unknown;devBuilds?:boolean};
type Intent={scope:string;targets:FleetUpdateTarget[]};
type Row=ReturnType<typeof fleetDeviceUpdate>;
type FleetContext={rows:Row[];loading:boolean;busy:boolean;open:(id?:string)=>void};
type FleetProps={servers:Device[];viewer:Viewer;demo:boolean;jobs:Job[];
 /** Pins the time (tests); without it the rows follow the console clock (agentUpdateClockState). */
 now?:number;onUpdated?:()=>Promise<void>|void;children:ReactNode};
const Context=createContext<FleetContext|null>(null);
const labels:Record<DeviceUpdateState['phase'],MessageKey>={scheduled:'agentUpdates.fleet.scheduled',queued:'agentUpdates.fleet.queued',installing:'agentUpdates.fleet.installing',waiting:'agentUpdates.fleet.waiting',verified:'agentUpdates.fleet.verified',failed:'agentUpdates.fleet.failed'};

/**
 * The changes of one release group. One list per group, so it starts at the
 * oldest installed agent of the group's targets and says so when they differ.
 */
function Changelog({group,releases,history}:{group:FleetUpdateGroup;releases:DeviceRelease[];history:unknown}){
 const t=useT(),release=group.release;
 const installed=[...new Set(group.targets.map(target=>target.installed))].sort((a,b)=>compareAgentVersions(a,b)??0),oldest=installed[0];
 const changes=agentChangesBetween(oldest,release,releases,history);
 if(changes.length>1){
  const [before,after]=t('agentUpdates.notice.versionHeading').split('{version}');
  return <div className="sdfau-changelog"><strong>{t('agentUpdates.notice.changesRange',{installed:oldest,version:release.version})}</strong>{installed.length>1&&<p className="sdfau-changelog-oldest">{t('agentUpdates.fleet.changesOldest',{installed:oldest})}</p>}<ol className="sdfau-changelog-versions">{changes.map(change=><li key={change.version}><h3>{before}<span className="mono">{change.version}</span>{after}</h3>{!change.published||!change.features.length&&!change.fixes.length?<p>{t('agentUpdates.notice.noVersionChangelog',{version:change.version})}</p>:<>{change.features.length>0&&<><small>{t('agentUpdates.notice.features')}</small><ul>{change.features.map((entry,index)=><li key={index}>{entry}</li>)}</ul></>}{change.fixes.length>0&&<><small>{t('agentUpdates.notice.fixes')}</small><ul>{change.fixes.map((entry,index)=><li key={index}>{entry}</li>)}</ul></>}</>}</li>)}</ol></div>;
 }
 const features=release.changelog?.features??[],fixes=release.changelog?.fixes??[];
 return <div className="sdfau-changelog"><strong>{t('agentUpdates.notice.changes',{version:release.version})}</strong>{features.length>0&&<><small>{t('agentUpdates.notice.features')}</small><ul>{features.map((entry,index)=><li key={index}>{entry}</li>)}</ul></>}{fixes.length>0&&<><small>{t('agentUpdates.notice.fixes')}</small><ul>{fixes.map((entry,index)=><li key={index}>{entry}</li>)}</ul></>}{!features.length&&!fixes.length&&<p>{t('agentUpdates.notice.noChangelog')}</p>}</div>;
}

/** Share one release catalog across the visible fleet and both update entry points. */
export function FleetAgentUpdates(props:FleetProps){
 const {servers,viewer,demo}=props;
 const scope=JSON.stringify([viewer.id,isOwner(viewer),demo,servers.map(server=>[server.id,server.permissions??[],server.management,server.snapshot?.mode,server.snapshot?.agentCapabilities??[]]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
 return <FleetAgentUpdatesScope {...props} scope={scope}/>;
}

/**
 * What the update rows take from the clock (fleetDeviceUpdate): whether each device is online, and for each agent
 * update job or campaign whether its start lies ahead and whether it is younger than a day. The rows are computed
 * again only when this string changes.
 */
export function agentUpdateClockState(servers:readonly Device[],jobs:readonly Job[],campaigns:readonly DeviceUpdateCampaign[],now:number):string{
 let state='';
 for(const server of servers)state+=connectionKind(server,now)==='online'?'1':'0';
 for(const item of [...jobs.filter(job=>job.action==='agent-update'),...campaigns])state+=(item.notBefore&&item.notBefore>now?'s':'-')+(now-(item.createdAt??0)<86400000?'r':'-');
 return state;
}

// The fleet DOM stays mounted while transient controls are scoped to the current targets.
function FleetAgentUpdatesScope({servers,viewer,demo,jobs,now:pinnedNow,onUpdated,children,scope}:FleetProps&{scope:string}){
 const t=useT(),stableT=useStableT(),[locale]=useLocale();
 const scopeRef=useRef(scope);
 const [stateScope,setStateScope]=useState(scope),[data,setData]=useState<{scope:string;value:ReleaseData}|null>(null),[error,setError]=useState(''),[loadError,setLoadError]=useState(''),[busy,setBusy]=useState(false),[open,setOpen]=useState(false),[selected,setSelected]=useState<string[]>([]),[intent,setIntent]=useState<Intent|null>(null),[confirming,setConfirming]=useState(false),[mfa,setMfa]=useState(false),[receipts,setReceipts]=useState<Record<string,UpdateReceipt>>({});
 const alive=useRef(true),busyRef=useRef(false),generation=useRef(0),loadController=useRef<AbortController|null>(null),deployController=useRef<AbortController|null>(null);
 const scoped=stateScope===scope;
 const canInspect=servers.some(server=>inspectDeviceUpdates(server,viewer,demo));
 const visible=data?.scope===scope?data.value:null;
 const now=useClockNow(pinnedNow,time=>agentUpdateClockState(servers,jobs,visible?.campaigns??[],time));
 const rows=servers.map(server=>fleetDeviceUpdate(server,viewer,demo,visible?.releases??[],jobs,visible?.campaigns??[],scoped?receipts[server.id]??null:null,now,locale,visible?.devBuilds===true));
 const active=rows.some(row=>row.active);
 const latest=useRef({servers,viewer,demo,jobs,now,data,receipts,onUpdated});
 useLayoutEffect(()=>{scopeRef.current=scope;latest.current={servers,viewer,demo,jobs,now,data,receipts,onUpdated};},[scope,servers,viewer,demo,jobs,now,data,receipts,onUpdated]);
 const load=useCallback(async()=>{
  if(!canInspect)return;
  loadController.current?.abort();const controller=new AbortController();loadController.current=controller;
  const captured=scope,request=++generation.current,timer=setTimeout(()=>controller.abort(),15000);
  try{const value=await api<ReleaseData>('/api/releases',undefined,controller.signal);if(alive.current&&scopeRef.current===captured&&request===generation.current){setData({scope:captured,value});setLoadError('');}}
  catch(failure){if(alive.current&&scopeRef.current===captured&&request===generation.current){setLoadError(controller.signal.aborted?stableT('agentUpdates.notice.timeout'):message(failure));if(failure instanceof ApiError&&[401,403].includes(failure.status))setData(null);}}
  finally{clearTimeout(timer);}
 },[canInspect,scope,stableT]);
 useEffect(()=>{let disposed=false;const captured=scope;queueMicrotask(()=>{
  if(disposed||!alive.current||scopeRef.current!==captured)return;
  setStateScope(captured);setData(null);setError('');setLoadError('');setSelected([]);setReceipts({});setIntent(null);setConfirming(false);setMfa(false);setOpen(false);busyRef.current=false;setBusy(false);void load();
 });return()=>{disposed=true;loadController.current?.abort();deployController.current?.abort();};},[scope,load]);
 useEffect(()=>{if(!canInspect)return;const timer=setInterval(()=>void load(),active?3000:60000);return()=>clearInterval(timer);},[canInspect,active,load]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;loadController.current?.abort();deployController.current?.abort();};},[]);

 // A rollout relies on the live MFA login session (lib/step-up.ts: routine): one
 // confirmation sends every release group in order, without a managementToken.
 // When the session lapses during the loop, the MFA dialog opens once with the
 // remaining targets; after it verifies, only those go out, and later groups
 // send without another dialog while the session holds.
 const deploy=async(approved:Intent)=>{
  if(busyRef.current||!alive.current||scopeRef.current!==approved.scope)return;
  if(!approved.targets.length||approved.targets.length>fleetUpdateLimit||new Set(approved.targets.map(target=>target.serverId)).size!==approved.targets.length){setError(t('agentUpdates.fleet.chooseCount'));return;}
  const valid=(targets:FleetUpdateTarget[])=>{
   const current=latest.current,loaded=current.data?.scope===approved.scope?current.data.value:null;
   for(const target of targets){
    const server=current.servers.find(item=>item.id===target.serverId);
    if(!server)return t('agentUpdates.fleet.selectionChanged');
    const row=fleetDeviceUpdate(server,current.viewer,current.demo,loaded?.releases??[target.release],current.jobs,loaded?.campaigns??[],current.receipts[server.id]??null,current.now,locale,loaded?.devBuilds===true);
    if(!row.eligible||row.update?.id!==target.release.id||row.update.version!==target.release.version||server.snapshot?.agentVersion!==target.installed)return `${server.name}: ${row.reason||t('agentUpdates.fleet.gone')}`;
   }
   return '';
  };
  const reason=valid(approved.targets);if(reason){setError(reason);setIntent(null);setMfa(false);void load();return;}
  busyRef.current=true;setBusy(true);setError('');const controller=new AbortController();deployController.current=controller;
  let remaining=[...approved.targets];
  try{
   for(const group of groupFleetUpdates(approved.targets)){
    if(!alive.current||scopeRef.current!==approved.scope||controller.signal.aborted)return;
    const changed=valid(group.targets);if(changed)throw new Error(changed);
    const result=await api<{jobs:string[];scheduledAt:number}>('/api/releases',{action:'deploy',releaseId:group.release.id,serverIds:group.targets.map(target=>target.serverId),confirm:true},controller.signal);
    if(!alive.current||scopeRef.current!==approved.scope||controller.signal.aborted)return;
    if(!Array.isArray(result.jobs)||result.jobs.length!==group.targets.length||result.jobs.some(id=>typeof id!=='string'||!id))throw new Error(t('agentUpdates.fleet.unconfirmed'));
    const createdAt=Date.now();setReceipts(previous=>({...previous,...Object.fromEntries(group.targets.map((target,index)=>[target.serverId,{jobId:result.jobs[index],version:group.release.version,createdAt}]))}));
    const completed=new Set(group.targets.map(target=>target.serverId));remaining=remaining.filter(target=>!completed.has(target.serverId));setSelected(previous=>previous.filter(id=>!completed.has(id)));setIntent(remaining.length?{scope:approved.scope,targets:remaining}:null);
   }
   setIntent(null);setMfa(false);void load();void Promise.resolve(latest.current.onUpdated?.()).catch(()=>{});
  }catch(failure){if(alive.current&&scopeRef.current===approved.scope&&!controller.signal.aborted){
   setError(message(failure));
   if(failure instanceof ApiError&&['MFA_LOGIN_REQUIRED','MFA_STEP_UP_REQUIRED','SESSION_EXPIRED'].includes(failure.code??'')){setIntent({scope:approved.scope,targets:remaining});setMfa(true);}
   else{setIntent(null);setMfa(false);void load();void Promise.resolve(latest.current.onUpdated?.()).catch(()=>{});}
  }}finally{if(alive.current&&scopeRef.current===approved.scope){busyRef.current=false;setBusy(false);}}
 };

 const selectedRows=rows.filter(row=>scoped&&selected.includes(row.server.id)&&row.eligible),targets=selectedRows.map(row=>({serverId:row.server.id,serverName:row.server.name,installed:row.server.snapshot!.agentVersion,release:row.update!}));
 // A selection over two or more customers needs the cross-customer right; the server gate decides.
 const crossLock=crossCustomerLockReason(viewer,targetCustomerCount(servers,targets.map(target=>target.serverId)),locale),intentHint=crossCustomerHint(targetCustomerCount(servers,intent?.targets.map(target=>target.serverId)??[]),locale);
 const prepare=()=>{if(busyRef.current||!targets.length||crossLock)return;setError('');setIntent({scope,targets});setConfirming(true);};
 const available=rows.filter(row=>row.inspect&&(row.update||row.migration||row.state));
 const openUpdates=(id?:string)=>{if(busyRef.current)return;setSelected(id?[id]:[]);setOpen(true);};
 const toggle=(id:string)=>setSelected(previous=>previous.includes(id)?previous.filter(value=>value!==id):previous.length<fleetUpdateLimit?[...previous,id]:previous);
 return <Context.Provider value={{rows,loading:canInspect&&!visible&&(!scoped||!loadError),busy:scoped&&busy,open:openUpdates}}>{children}
 {/* The focal point is the selected count with the one primary in the footer; the list stays above it. */}
 <Drawer open={scoped&&open&&canInspect} onClose={()=>{if(!busy)setOpen(false);}} title={t('agentUpdates.fleet.title')} description={t('agentUpdates.fleet.description')} footer={<div className="sdfau-drawer-actions"><span aria-live="polite">{t('agentUpdates.fleet.count',{length:selectedRows.length,fleetUpdateLimit})}</span><Btn variant="primary" icon={ArrowUpCircle} loading={busy} disabled={!visible} blocked={crossLock||(!targets.length?t('agentUpdates.fleet.chooseCount'):undefined)} onClick={prepare}>{t('agentUpdates.fleet.check')}</Btn></div>}>
  {/* Without a listed device the empty state says it once; the choose row has nothing to choose from. */}
  {!(visible&&!available.length)&&<div className="sdfau-toolbar"><span>{t('agentUpdates.fleet.inFilter')}</span><Btn variant="ghost" size="sm" disabled={busy||!visible} blocked={visible&&!rows.some(row=>row.eligible)?t('agentUpdates.fleet.noneEligible'):undefined} onClick={()=>setSelected(rows.filter(row=>row.eligible).slice(0,fleetUpdateLimit).map(row=>row.server.id))}>{t('agentUpdates.fleet.upTo')}</Btn><IconBtn icon={RefreshCw} label={t('agentUpdates.notice.recheck')} disabled={busy} onClick={()=>void load()}/></div>}
  {scoped&&(error||loadError)&&<Notice tone="danger" icon={AlertTriangle}>{error||loadError}</Notice>}
  {!visible&&(!scoped||!loadError)&&<Skeleton variant="table" rows={3} label={t('agentUpdates.fleet.checking')}/>}
  {visible&&!available.length&&<Empty icon={CheckCircle2} title={t('agentUpdates.fleet.emptyTitle')}>{t('agentUpdates.fleet.none')}</Empty>}
  <div className="sdfau-targets">{available.map(row=><label key={row.server.id} className={'sdfau-target'+(row.active?' is-active':'')}><input type="checkbox" aria-label={t('agentUpdates.fleet.select',{name:row.server.name})} checked={selected.includes(row.server.id)&&row.eligible} disabled={busy||!row.eligible||!selected.includes(row.server.id)&&selectedRows.length>=fleetUpdateLimit} onChange={()=>toggle(row.server.id)}/><span><strong>{row.server.name}</strong><small>{t('agentUpdates.fleet.agent',{value:row.server.snapshot?.agentVersion??EMPTY_VALUE})}{row.update&&<> → {row.update.version}{isDevVersion(row.update.version)&&<> <span className="sdx-tag">{t('releases.devBuild')}</span></>}</>}</small>{row.state?<small className={'sdfau-state '+row.state.phase}>{t(labels[row.state.phase])} · {row.state.version}{row.state.phase==='scheduled'&&row.state.notBefore?' · '+stamp(row.state.notBefore):''}</small>:row.reason&&row.update?<small className="sdfau-block">{row.reason}</small>:null}{row.state?.phase==='failed'&&row.state.message&&<small className="sdfau-block">{row.state.message.slice(0,240)}</small>}{!row.update&&row.migration&&<small>{(()=>{const [before,after]=t('agentUpdates.fleet.nativeInstall',{version:row.migration.version}).split('{command}');return <>{before}<code>ServerDesk.Agent.exe --install</code>{after}</>;})()}</small>}</span></label>)}</div>
  {groupFleetUpdates(targets).map(group=><Changelog key={group.release.id} group={group} releases={visible?.releases??[]} history={visible?.history}/>)}
 </Drawer>
 <ConfirmDialog open={scoped&&confirming&&intent?.scope===scope} onOpenChange={next=>{setConfirming(next);if(!next&&!busy&&!mfa)setIntent(null);}} title={t('agentUpdates.fleet.approve')} body={t('agentUpdates.fleet.restartNote')} lines={scoped?intent?.targets.map(target=>({label:target.serverName,value:target.installed+' → '+target.release.version,mono:true})):undefined} confirmLabel={t('agentUpdates.fleet.updateNow')} tone="default" busy={busy} blocked={!scoped||!intent?.targets.length?t('agentUpdates.fleet.chooseCount'):undefined} onConfirm={()=>{const approved=intent;setConfirming(false);if(approved)void deploy(approved);}}>{scoped&&intentHint&&<p className="sdfau-cross-customer">{intentHint}</p>}</ConfirmDialog>
 <MfaStepUp open={scoped&&mfa} onClose={()=>{setMfa(false);setIntent(null);}} onVerified={()=>{const approved=intent;if(approved)void deploy(approved);}}/>
 </Context.Provider>;
}

export function FleetAgentUpdateToolbar(){
 const t=useT();
 const context=useContext(Context);if(!context||!context.rows.some(row=>row.inspect))return null;
 const count=context.rows.filter(row=>!!row.update&&!row.active).length;
 // The kit button of the fleet toolbar: loading while the check runs or a rollout is busy. The count badge is the
 // signal; without an available update the button is quiet (ghost).
 return <Btn size="sm" variant={count>0?'secondary':'ghost'} icon={ArrowUpCircle} loading={context.loading||context.busy} count={count} countLabel={t('agentUpdates.fleet.buttonCount',{count})} onClick={()=>context.open()}>{t('agentUpdates.fleet.title')}</Btn>;
}

/**
 * The agent version of a fleet row, and below it the device's update action: the state of a running update, the
 * kit Btn "Update {version}" (ghost, sm; blocked with kit.busy while a rollout runs, the reason in its Tooltip),
 * the local-switch hint or "checking". The version is the focal point; the action stays quiet.
 */
export function FleetAgentUpdateCell({server}:{server:Device}){
 const t=useT();
 const context=useContext(Context),row=context?.rows.find(item=>item.server.id===server.id);
 return <div className="sdfau-cell"><span className="mono">{server.snapshot?.agentVersion??EMPTY_VALUE}</span>{row?.state?<button type="button" className={'sdfau-cell-state '+row.state.phase} onClick={()=>context?.open(server.id)} title={row.state.message??t(labels[row.state.phase])}>{row.state.phase==='verified'?<CheckCircle2 size={12}/>:row.active?<Loader2 size={12} className="spin"/>:<ArrowUpCircle size={12}/>}<span>{t(labels[row.state.phase])}</span></button>:row?.update?<Btn variant="ghost" size="sm" icon={ArrowUpCircle} blocked={context?.busy?t('kit.busy'):undefined} hint={row.reason||t('agentUpdates.notice.available',{version:row.update.version})} aria-label={t('agentUpdates.fleet.updateNamed',{name:server.name,version:row.update.version})} onClick={()=>context?.open(server.id)}>{t('agentUpdates.fleet.update',{version:row.update.version})}</Btn>:row?.migration?<button type="button" className="sdfau-cell-migration" onClick={()=>context?.open(server.id)} title={t('agentUpdates.fleet.nativeHint')}>{t('agentUpdates.fleet.localSwitch')}</button>:row?.inspect&&context?.loading?<small className="sdfau-cell-loading">{t('agentUpdates.fleet.checkingShort')}</small>:null}</div>;
}
