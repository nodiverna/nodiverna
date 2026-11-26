'use client';
// Automation → Configuration drift of one device on the console kit. The panel loads the drift
// state (GET /api/drift, compact) every 10 s, shows it through DriftOverview, edits the policy in
// the disclosure below it and opens the details of a scan in the kit Drawer. Every write goes
// through mutate(): one at a time (mutation ref), aborted on a scope change, with a 15 s timeout
// and the step-up that resends the same body once. Accept as baseline and Copy to group ask
// first in a kit ConfirmDialog.
import {opensMfaPrompt} from '@/lib/errors/codes';
import {useState,useEffect,useCallback,useRef,type ReactNode} from 'react';
import {AlertTriangle,ChevronDown,FolderSearch,LoaderCircle,Plus,RefreshCw,Save,ShieldCheck,SlidersHorizontal,X} from 'lucide-react';
import {api,message,stamp,permitted,v3,ApiError,type V3Props} from '@/ui/base/api';
import {isOwner} from '@/ui/base/access-capabilities';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {FilePicker} from '@/ui/devices/remote/file-browser';
import {DriftOverview,DriftStatePill,driftAcceptReason,driftLabels,driftChangeLabels,driftKindLabels,driftText,type DriftChange,type DriftReport,type DriftOverviewData} from '@/ui/automation/drift-overview';
import {Btn,Drawer,IconBtn,Notice,SectionHead,Skeleton,Unavailable} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {Field,Select} from '@/ui/kit/field';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import '@/ui/automation/drift.css';
import {useLocale,useT,useStableT} from '@/ui/base/locale';
import {storedMessageText} from '@/lib/server-messages';
type Policy={enabled:boolean;version?:number;paths:{path:string;recursive:boolean;includeText:boolean;extensions:string[]}[];excludes:string[];registry:{path:string;names:string[];includeValues?:boolean}[];config:string[];includeConfigValues:boolean;intervalSeconds:number;maxFiles:number;maxFileBytes:number;maxTextBytes:number;maxDurationSeconds:number;retentionDays:number};
type Data=DriftOverviewData&{policy:Policy;reports:DriftReport[]};
type PendingMutation={scope:string;body:Record<string,unknown>};
type Inspection={reportId:string;index:number;historical:boolean};
const initial:Policy={enabled:false,paths:[],excludes:['*.log','*.tmp','*.cache'],registry:[],config:[],includeConfigValues:false,intervalSeconds:300,maxFiles:1000,maxFileBytes:10485760,maxTextBytes:8192,maxDurationSeconds:30,retentionDays:30};
export default function DriftPanel({server,viewer,demo,groups=[]}:V3Props&{groups?:{id:string;name:string}[]}){
 const t=useT(),stableT=useStableT(),[locale]=useLocale();
 const scopeKey=JSON.stringify([server.id,viewer.id,isOwner(viewer),server.permissions??[]]);
 const scopeRef=useRef(scopeKey);scopeRef.current=scopeKey;
 const [dataScope,setDataScope]=useState(''),[editing,setEditing]=useState(false),[data,setData]=useState<Data|null>(null),[policy,setPolicy]=useState<Policy>(initial);
 const [paths,setPaths]=useState<string[]>([]),[manualPath,setManualPath]=useState(''),[picker,setPicker]=useState(false),[excludes,setExcludes]=useState(initial.excludes.join('\n')),[registry,setRegistry]=useState('');
 const [registryValues,setRegistryValues]=useState(false),[targetGroup,setTargetGroup]=useState(''),[recursive,setRecursive]=useState(true),[includeText,setIncludeText]=useState(false),[extensions,setExtensions]=useState('.json,.config,.ini,.txt');
 const [error,setError]=useState(''),[actionError,setActionError]=useState(''),[pathError,setPathError]=useState(''),[detailError,setDetailError]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[mfa,setMfa]=useState(false),[pending,setPending]=useState<PendingMutation|null>(null),[historyDays,setHistoryDays]=useState(7);
 const [selectedReport,setSelectedReport]=useState<DriftReport|null>(null),[reportScope,setReportScope]=useState(''),[detailLoading,setDetailLoading]=useState(false),[detailOpen,setDetailOpen]=useState(false),[detailCurrent,setDetailCurrent]=useState(false),[changeIndex,setChangeIndex]=useState(0);
 const [acceptTarget,setAcceptTarget]=useState<DriftReport|null>(null),[copyConfirm,setCopyConfirm]=useState(false);
 const detailGeneration=useRef(0),lastInspection=useRef<Inspection|null>(null),policyBox=useRef<HTMLDetailsElement>(null);
 const mounted=useRef(false),loadSequence=useRef(0),loadAbort=useRef<AbortController|null>(null),mutation=useRef<{scope:string;controller:AbortController}|null>(null);
 // The one concrete reason the panel cannot be used (sample device first); without one it loads.
 const reason=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,'drift.read')||permitted(server,viewer,'drift.manage'),reported:!!server.snapshot,supported:v3(server)});
 const enabled=!reason,canManage=permitted(server,viewer,'drift.manage'),canContents=permitted(server,viewer,'drift.contents'),canBrowse=permitted(server,viewer,'files.read')&&!!server.snapshot?.agentCapabilities?.includes('list-files');
 const load=useCallback(async(sync=false,afterMutation=false)=>{
  if(!enabled||!mounted.current||mutation.current&&!afterMutation)return;
  const requestedScope=scopeKey,sequence=++loadSequence.current,controller=new AbortController();loadAbort.current?.abort();loadAbort.current=controller;setLoading(true);
  const timeout=setTimeout(()=>controller.abort(new Error(stableT('drift.panel.loadTimeout'))),15000);
  try{
   const loaded=await api<Data>('/api/drift?serverId='+encodeURIComponent(server.id)+'&compact=1',undefined,controller.signal);
   if(!mounted.current||scopeRef.current!==requestedScope||loadSequence.current!==sequence)return;
   setData(loaded);setDataScope(requestedScope);setError('');
   setHistoryDays(days=>Math.min(days,loaded.retentionDays??30));
   if(sync){const selected=Object.fromEntries(Object.entries(initial).map(([key,fallback])=>[key,(loaded.policy as unknown as Record<string,unknown>)[key]??fallback])) as Policy;
    setPolicy(selected);setPaths(selected.paths.map(source=>source.path));setExcludes(selected.excludes.join('\n'));setRegistry(selected.registry.map(source=>source.path).join('\n'));setRegistryValues(selected.registry.some(source=>source.includeValues));setRecursive(selected.paths[0]?.recursive??true);setIncludeText(selected.paths[0]?.includeText??false);setExtensions(selected.paths[0]?.extensions.join(',')||'.json,.config,.ini,.txt');
   }
  }catch(cause){if(!mounted.current||scopeRef.current!==requestedScope||loadSequence.current!==sequence)return;setError(message(cause));if(cause instanceof ApiError&&[401,403].includes(cause.status)){setData(null);setSelectedReport(null);setDetailOpen(false);setPending(null);setMfa(false);}}
  finally{clearTimeout(timeout);if(loadAbort.current===controller)loadAbort.current=null;if(mounted.current&&loadSequence.current===sequence)setLoading(false);}
 },[enabled,server.id,scopeKey,stableT]);
 useEffect(()=>{
  mounted.current=true;setSelectedReport(null);setDetailOpen(false);setEditing(false);setPicker(false);setTargetGroup('');setPending(null);setMfa(false);setBusy(false);setError('');setActionError('');setPathError('');setAcceptTarget(null);setCopyConfirm(false);detailGeneration.current++;
  void load(true);const timer=enabled?setInterval(()=>void load(),10000):undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loadSequence and detailGeneration are generation counters, not DOM refs; the cleanup increments them so that late responses are dropped.
  return()=>{mounted.current=false;clearInterval(timer);loadSequence.current++;loadAbort.current?.abort();mutation.current?.controller.abort();mutation.current=null;detailGeneration.current++;};
 },[load,enabled,scopeKey]);
 const visibleData=dataScope===scopeKey?data:null,report=reportScope===scopeKey?selectedReport:null,change=report?.changes[changeIndex];
 const mutate=async(body:Record<string,unknown>,requestedScope=scopeKey)=>{
  if(!enabled||!canManage||!visibleData||!mounted.current||scopeRef.current!==requestedScope||mutation.current)return;
  const active={scope:requestedScope,controller:new AbortController()};mutation.current=active;loadSequence.current++;loadAbort.current?.abort();setBusy(true);setActionError('');setMfa(false);setPending({scope:requestedScope,body});
  const timeout=setTimeout(()=>active.controller.abort(new Error(t('drift.panel.changeTimeout'))),15000);
  try{
   const result=await api<{enabled?:boolean}>('/api/drift',body,active.controller.signal);
   if(!mounted.current||scopeRef.current!==requestedScope||mutation.current!==active)return;
   if(body.action==='set-enabled'&&typeof result.enabled==='boolean')setData(current=>current?{...current,policy:{...current.policy,enabled:result.enabled!},state:result.enabled?'loading':'disabled'}:current);
   setPending(null);await load(false,true);
  }catch(cause){
   if(!mounted.current||scopeRef.current!==requestedScope||mutation.current!==active)return;
   const text=message(cause);setActionError(text);
   if(cause instanceof ApiError&&opensMfaPrompt(cause.code))setMfa(true);
   else{setPending(null);if(cause instanceof ApiError&&[401,403].includes(cause.status)){setData(null);setSelectedReport(null);setDetailOpen(false);}else{await load(false,true);if(mounted.current&&scopeRef.current===requestedScope&&mutation.current===active)setActionError(text);}}
  }finally{clearTimeout(timeout);if(mutation.current===active){mutation.current=null;if(mounted.current&&scopeRef.current===requestedScope)setBusy(false);}}
 };
 const toggle=()=>{
  if(!visibleData?.policy.version||mfa||busy)return;
  void mutate({action:'set-enabled',serverId:server.id,enabled:!visibleData.policy.enabled,version:visibleData.policy.version});
 };
 const finalPolicy=()=>({...policy,enabled:visibleData?.policy.enabled??false,paths:paths.map(path=>({path,recursive,includeText,extensions:extensions.split(',').map(value=>value.trim()).filter(Boolean)})),excludes:excludes.split('\n').map(value=>value.trim()).filter(Boolean),registry:registry.split('\n').map(value=>value.trim()).filter(Boolean).map(path=>({path,names:[],includeValues:registryValues}))});
 // With a target group the primary is "Copy to group" and asks first; without one it saves for this device.
 const save=()=>{
  if(!visibleData||busy||mfa||!canManage)return;
  if(targetGroup)setCopyConfirm(true);else void mutate({action:'set-policy',serverId:server.id,policy:finalPolicy()});
 };
 const copyToGroup=()=>{setCopyConfirm(false);if(!visibleData||busy||mfa||!canManage||!targetGroup)return;void mutate({action:'apply-group',groupId:targetGroup,policy:finalPolicy(),confirm:true});};
 const inspect=async(reportId:string,index=0,historical=false)=>{
  const requestGeneration=++detailGeneration.current,requestedScope=scopeKey;lastInspection.current={reportId,index,historical};
  setChangeIndex(index);setDetailOpen(true);setDetailCurrent(!historical);setDetailError('');
  const local=!historical&&visibleData?.current?.id===reportId?visibleData.current:visibleData?.reports.find(item=>item.id===reportId);
  if(local){setSelectedReport(local);setReportScope(requestedScope);setDetailLoading(false);return;}
  setSelectedReport(null);setDetailLoading(true);
  try{const result=await api<{report:DriftReport}>('/api/drift?serverId='+encodeURIComponent(server.id)+'&reportId='+encodeURIComponent(reportId));if(scopeRef.current===requestedScope&&detailGeneration.current===requestGeneration){setSelectedReport(result.report);setReportScope(requestedScope);}}
  catch(cause){if(scopeRef.current===requestedScope&&detailGeneration.current===requestGeneration)setDetailError(message(cause));}
  finally{if(detailGeneration.current===requestGeneration)setDetailLoading(false);}
 };
 const accept=(item:DriftReport)=>{if(visibleData&&!driftAcceptReason(item,visibleData,canManage,busy||mfa,Date.now(),t))setAcceptTarget(item);};
 const acceptConfirmed=()=>{const item=acceptTarget;setAcceptTarget(null);if(item)void mutate({action:'accept-baseline',serverId:server.id,reportId:item.id,confirm:true});};
 const addPath=(value:string)=>{const normalized=value.trim();if(!normalized)return;if(/^[A-Za-z]:\\$/.test(normalized)){setPathError(t('drift.panel.wholeDrive'));return;}if(paths.some(path=>path.toLowerCase()===normalized.toLowerCase())){setManualPath('');setPicker(false);setPathError('');return;}if(paths.length>=20){setPathError(t('drift.panel.maxSources'));return;}setPaths(current=>current.length>=20?current:[...current,normalized]);setManualPath('');setPicker(false);setPathError('');};
 const openPolicy=()=>{setEditing(true);if(typeof window!=='undefined')window.requestAnimationFrame(()=>policyBox.current?.querySelector('summary')?.focus());};
 const head=(meta?:ReactNode,actions?:ReactNode)=><SectionHead title={t('device.section.drift')} hideTitle description={t('drift.description')} meta={meta} actions={actions}/>;
 if(reason)return <div className="sdx-panel-stack">{head()}<Unavailable reason={reason}/></div>;
 const retry=<Btn size="sm" loading={loading} onClick={()=>void load(!visibleData)}>{t('common.retry')}</Btn>;
 if(!visibleData)return <div className="sdx-panel-stack">{head()}
  {error?<Notice tone="danger" icon={AlertTriangle} action={retry}>{error}</Notice>:<Skeleton variant="cards" rows={2} label={t('drift.panel.loading')} after={15000} action={retry}/>}
 </div>;
 const busyReason=busy||mfa?t('automation.busy'):undefined,manageReason=!canManage?t('drift.blocked.manage'):undefined;
 const switchBusy=busy&&pending?.body.action==='set-enabled',switchReason=manageReason??(!visibleData.policy.version?t('drift.blocked.saveFirst'):busyReason);
 const groupName=groups.find(group=>group.id===targetGroup)?.name??'';
 const contentsReason=!canContents?t('drift.blocked.contents'):undefined;
 const reportAcceptReason=report?driftAcceptReason(report,visibleData,canManage,busy||mfa,Date.now(),t):null;
 const detailRetry=<Btn size="sm" onClick={()=>{const last=lastInspection.current;if(last)void inspect(last.reportId,last.index,last.historical);}}>{t('common.retry')}</Btn>;
 type DetailRow={change:DriftChange;index:number};
 const detailColumns:DataColumn<DetailRow>[]=[
  {id:'path',label:t('drift.pathSource'),primary:true,wrap:true,cell:({change:item})=><span className="sdx-cell-stack"><span className="mono drift-path">{item.path||item.key}</span><small>{driftText(driftKindLabels,item.kind,t)}</small></span>},
  {id:'change',label:t('drift.changeColumn'),cell:({change:item})=>driftText(driftChangeLabels,item.change,t)},
 ];
 const configSources=[{id:'services',label:t('drift.panel.services')},{id:'roles',label:t('drift.panel.roles')},{id:'network',label:t('drift.panel.network')},{id:'firewall',label:t('device.protection.firewall')},{id:'localGroups',label:t('management.groups.title')},{id:'tasks',label:t('management.tasks.title')},{id:'autostart',label:t('drift.panel.autostart')}];
 const browseReason=manageReason??(!canBrowse?t('drift.panel.browserNeeds'):!picker&&paths.length>=20?t('drift.panel.maxSources'):undefined);
 const addReason=manageReason??(!manualPath.trim()?t('drift.blocked.pathEmpty'):paths.length>=20?t('drift.panel.maxSources'):undefined);
 return <div className="sdx-panel-stack">
  {head(<DriftStatePill state={visibleData.state}/>,<>
   <IconBtn icon={RefreshCw} label={t('network.refresh')} loading={loading} blocked={busyReason} onClick={()=>void load()}/>
   <Btn icon={SlidersHorizontal} onClick={openPolicy}>{canManage?t('drift.setupPolicy'):t('drift.viewPolicy')}</Btn>
  </>)}
  {error&&<Notice tone="danger" icon={AlertTriangle} action={retry}>{error} {t('console.staleData')}</Notice>}
  {actionError&&<Notice tone="danger" icon={AlertTriangle}>{actionError}</Notice>}
  <DriftOverview data={visibleData} busy={busy||mfa} canManage={canManage} historyDays={historyDays} onHistoryDays={setHistoryDays} now={Date.now()} onEdit={openPolicy} onInspect={(id,index,historical)=>void inspect(id,index,historical)} onAccept={accept}>
   <details ref={policyBox} className="drift-policy-disclosure sdx-card" open={editing} onToggle={event=>{setEditing(event.currentTarget.open);if(!event.currentTarget.open)setPicker(false);}}>
    <summary><span className="drift-policy-title"><SlidersHorizontal size={16} aria-hidden="true"/>{t('drift.panel.policy')}</span><span className="drift-policy-end"><span>{visibleData.policy.enabled?t('drift.panel.monitoringOn'):t('drift.panel.monitoringOff')}</span><ChevronDown size={16} aria-hidden="true"/></span></summary>
    <div className="sdx-form-grid drift-editor">
     <Field label={t('drift.panel.onDevice')} hint={switchReason??(visibleData.policy.version?t('drift.panel.savedSources'):t('drift.panel.saveFirst'))}>
      <button type="button" role="switch" className="drift-switch" aria-label={t('drift.panel.switchLabel')} aria-checked={visibleData.policy.enabled} aria-busy={switchBusy||undefined} aria-disabled={!!switchReason||undefined} onClick={()=>{if(!switchReason)toggle();}}>{switchBusy?<LoaderCircle size={12} className="sdx-spin" aria-hidden="true"/>:<span aria-hidden="true"/>}<span className="drift-switch-state" aria-hidden="true">{switchBusy?t('common.saving'):visibleData.policy.enabled?t('drift.panel.on'):t('drift.panel.off')}</span></button>
     </Field>
     {groups.length>0&&<Field label={t('drift.panel.scope')} hint={manageReason}><Select value={targetGroup} disabled={!canManage} onChange={event=>setTargetGroup(event.target.value)}><option value="">{t('drift.panel.thisDevice',{name:server.name})}</option>{groups.map(group=><option key={group.id} value={group.id}>{t('drift.panel.groupDevices',{name:group.name})}</option>)}</Select></Field>}
     <fieldset className="drift-fieldset"><legend>{t('drift.panel.files')}</legend>
      <div className="drift-source-toolbar"><Btn size="sm" icon={FolderSearch} blocked={browseReason} onClick={()=>setPicker(!picker)}>{picker?t('drift.panel.closeBrowser'):t('drift.panel.chooseFile')}</Btn></div>
      {picker&&canBrowse&&canManage&&<div className="drift-picker"><FilePicker server={server} viewer={viewer} demo={demo} mode="any" onSelect={addPath} onClose={()=>setPicker(false)}/></div>}
      {paths.length?<ul className="drift-path-list">{paths.map(path=><li className="drift-path-row" key={path.toLowerCase()}><span className="mono">{path}</span><IconBtn icon={X} label={t('drift.panel.removePath',{path})} blocked={manageReason} onClick={()=>setPaths(current=>current.filter(item=>item!==path))}/></li>)}</ul>:<p className="drift-help">{t('drift.panel.noFiles')}</p>}
      <div className="drift-manual-path">
       <Field label={t('drift.panel.addPath')} error={pathError} hint={!canBrowse?t('drift.panel.manualHint'):undefined}><input value={manualPath} readOnly={!canManage} onChange={event=>{setManualPath(event.target.value);setPathError('');}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();if(!addReason)addPath(manualPath);}}} placeholder="C:\App\Config"/></Field>
       <Btn size="sm" icon={Plus} blocked={addReason} onClick={()=>addPath(manualPath)}>{t('rbac.group.add')}</Btn>
      </div>
      <Field label={t('drift.panel.excludes')}><textarea value={excludes} readOnly={!canManage} onChange={event=>setExcludes(event.target.value)}/></Field>
      <Field inline label={t('drift.panel.subfolders')} hint={manageReason}><input type="checkbox" role="switch" checked={recursive} disabled={!canManage} onChange={event=>setRecursive(event.target.checked)}/></Field>
      <Field inline label={t('drift.panel.textContents')} hint={manageReason??contentsReason}><input type="checkbox" role="switch" checked={includeText} disabled={!canManage||!canContents} onChange={event=>setIncludeText(event.target.checked)}/></Field>
      {includeText&&<><Notice tone="warning" icon={AlertTriangle}>{t('drift.panel.textWarning')}</Notice><Field label={t('drift.panel.textExtensions')}><input value={extensions} readOnly={!canManage} onChange={event=>setExtensions(event.target.value)} placeholder=".json,.ini"/></Field></>}
     </fieldset>
     <fieldset className="drift-fieldset"><legend>{t('drift.kind.registry')}</legend>
      <Field label={t('drift.panel.registryPaths')}><textarea value={registry} readOnly={!canManage} onChange={event=>setRegistry(event.target.value)} placeholder="HKLM:\SOFTWARE\MyApplication"/></Field>
      <Field inline label={t('drift.panel.registryValues')} hint={manageReason??contentsReason}><input type="checkbox" role="switch" checked={registryValues} disabled={!canManage||!canContents} onChange={event=>setRegistryValues(event.target.checked)}/></Field>
     </fieldset>
     <fieldset className="drift-fieldset"><legend>{t('drift.panel.moreConfig')}</legend>
      <div className="sdx-pick-list drift-config-list">{configSources.map(source=><label key={source.id} className="sdx-pick-row"><input type="checkbox" disabled={!canManage} checked={policy.config.includes(source.id)} onChange={event=>setPolicy({...policy,config:event.target.checked?[...policy.config,source.id]:policy.config.filter(id=>id!==source.id)})}/><span className="sdx-pick-text"><strong>{source.label}</strong></span></label>)}</div>
      <Field inline label={t('drift.panel.configValues')} hint={manageReason??contentsReason}><input type="checkbox" role="switch" checked={policy.includeConfigValues} disabled={!canManage||!canContents} onChange={event=>setPolicy({...policy,includeConfigValues:event.target.checked})}/></Field>
     </fieldset>
     {(registryValues||policy.includeConfigValues)&&<Notice tone="warning" icon={AlertTriangle}>{t('drift.panel.secretsWarning')}</Notice>}
     <details className="drift-limits"><summary>{t('drift.panel.limits')}</summary><div className="drift-limit-grid">
      <Field label={t('drift.panel.interval')}><input type="number" min={60} max={86400} readOnly={!canManage} value={policy.intervalSeconds} onChange={event=>setPolicy({...policy,intervalSeconds:Number(event.target.value)})}/></Field>
      <Field label={t('drift.panel.maxFiles')}><input type="number" min={1} max={5000} readOnly={!canManage} value={policy.maxFiles} onChange={event=>setPolicy({...policy,maxFiles:Number(event.target.value)})}/></Field>
      <Field label={t('drift.panel.maxSize')}><input type="number" min={1} max={1024} readOnly={!canManage} value={policy.maxFileBytes/1048576} onChange={event=>setPolicy({...policy,maxFileBytes:Number(event.target.value)*1048576})}/></Field>
      <Field label={t('drift.panel.retention')}><input type="number" min={1} max={90} readOnly={!canManage} value={policy.retentionDays} onChange={event=>setPolicy({...policy,retentionDays:Number(event.target.value)})}/></Field>
     </div></details>
     <div className="sdx-form-actions"><Btn variant="primary" icon={Save} loading={busy&&!!pending&&pending.body.action!=='set-enabled'&&pending.body.action!=='accept-baseline'} blocked={manageReason??busyReason} onClick={save}>{targetGroup?t('drift.panel.copyToGroup'):t('drift.panel.save')}</Btn></div>
    </div>
   </details>
  </DriftOverview>
  <Drawer open={detailOpen} onClose={()=>{setDetailOpen(false);detailGeneration.current++;}} wide title={t('drift.panel.details')} description={report?`${stamp(report.scannedAt,locale)} · ${driftText(driftLabels,report.state,t)} · ${report.complete?t('drift.panel.complete'):t('drift.panel.incomplete')}`:undefined}
   footer={report&&<Btn variant="primary" icon={ShieldCheck} blocked={reportAcceptReason??undefined} onClick={()=>accept(report)}>{t('drift.panel.accept')}</Btn>}>
   {detailError&&<Notice tone="danger" icon={AlertTriangle} action={detailRetry}>{detailError}</Notice>}
   {detailLoading&&!report&&<Skeleton variant="facts" label={t('drift.panel.detailsLoading')}/>}
   {report&&report.errors.length>0&&<Notice tone="danger" icon={AlertTriangle}>{report.errors.map((item,index)=><p key={index}>{storedMessageText(item,t)}</p>)}</Notice>}
   {report&&<>
    <p className="drift-detail-meta">{detailCurrent?t('drift.panel.compareCurrent'):t('drift.panel.compareHistoric')} ·{t('drift.panel.policyVersion',{policyVersion:report.policyVersion})}{report.scanCount>1?t('drift.panel.identical',{scanCount:report.scanCount,stamp:stamp(report.firstScannedAt,locale)}):''}</p>
    <DataTable<DetailRow> label={t('drift.changesTitle')} columns={detailColumns} rows={report.changes.map((item,index)=>({change:item,index}))} rowKey={row=>row.change.key+'-'+row.index} highlightKey={change?change.key+'-'+changeIndex:undefined}
     onOpen={row=>setChangeIndex(row.index)} empty={{icon:ShieldCheck,title:t('drift.panel.noChanges')}}/>
   </>}
   {change&&<section className="v3-drawer-section"><h3 className="mono drift-detail-title">{change.path||change.key}</h3>{!canContents&&<p className="v3-help">{t('drift.panel.contentsHidden')}</p>}{change.textDiff?<>{typeof change.textDiff==='string'?<pre className="v3-output">{change.textDiff}</pre>:<><pre className="v3-output v3-text-diff"><code>{change.textDiff.lines.map((line,index)=><span key={index} className={'v3-diff-line v3-diff-'+line.type}>{line.type==='added'?'+':line.type==='removed'?'-':' '}{' '+line.text+'\n'}</span>)}</code></pre>{change.textDiff.truncated&&<p className="v3-help">{t('drift.panel.diffShortened')}</p>}</>}</>:<div className="v3-diff-grid"><div><h4>{t('drift.panel.before')}</h4><pre className="v3-output">{JSON.stringify(change.before??null,null,2)}</pre></div><div><h4>{t('drift.panel.after')}</h4><pre className="v3-output">{JSON.stringify(change.after??null,null,2)}</pre></div></div>}</section>}
  </Drawer>
  <ConfirmDialog open={!!acceptTarget} onOpenChange={open=>{if(!open)setAcceptTarget(null);}} title={t('drift.panel.acceptTitle',{name:server.name})} lines={acceptTarget?[{label:t('fleet.col.device'),value:server.name},{label:t('drift.line.scan'),value:stamp(acceptTarget.scannedAt,locale)}]:undefined}
   body={t('drift.panel.acceptBody')} confirmLabel={t('drift.panel.accept')} busy={busy} onConfirm={acceptConfirmed}/>
  <ConfirmDialog open={copyConfirm} onOpenChange={setCopyConfirm} title={t('drift.panel.copyTitle',{name:groupName})} lines={[{label:t('fleet.col.group'),value:groupName}]}
   body={t('drift.panel.copyBody')} confirmLabel={t('drift.panel.copyToGroup')} busy={busy} onConfirm={copyToGroup}/>
  <MfaStepUp open={mfa&&pending?.scope===scopeKey} onClose={()=>{setMfa(false);setPending(null);}} onVerified={()=>{if(pending?.scope===scopeKey)void mutate(pending.body,pending.scope);}}/>
 </div>;
}
