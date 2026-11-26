'use client';
// The Diagnostics area of a device (Processes, Sessions, Events, Connections) on the console kit.
// Each panel names a concrete reason when it cannot be used (Unavailable), shows the kit Skeleton on
// its first load (with a slow line after 15 s and a hard end at the 60 s job wait limit), a danger
// Notice with "Try again" for a failed read or query, and a toast for a failed action. The lists are
// DataTables; the table never sorts or pages by itself (sortProcesses in ui/devices/diagnostics/process-view.ts).
import {opensMfaPrompt} from '@/lib/errors/codes';
import type {Locale} from '@/lib/i18n/locale';
import type {MessageKey} from '@/lib/i18n/translate';
import {EMPTY_VALUE,formatBytes,formatDuration,formatNumber} from '@/lib/i18n/format';

import {useState, useEffect, useCallback, useRef, type ReactNode} from 'react';
import {AlertTriangle,Check,Clock3,Copy,Download,FileText,Info,ListTree,LogOut,Network,Package,RefreshCw,Search,Send,Shield,Square,Unplug,Users,X} from 'lucide-react';
import {toast} from 'sonner';
import {api, ApiError, message, stamp, permitted, online, v3, downloadText, type V3Props} from '@/ui/base/api';
import CrashList from '@/ui/devices/diagnostics/crash-list';
import ReliabilityCard from '@/ui/devices/diagnostics/reliability-card';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {Btn,Card,Drawer,Empty,Facts,IconBtn,Menu,Meter,Notice,Segmented,Skeleton,StatusPill,Unavailable,exactTime,percentLabel,type FactItem,type MenuEntry,type StatusKind} from '@/ui/kit/kit';
import {DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {Field,Select} from '@/ui/kit/field';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {processIdentity, processView, currentKillCandidate, measuredValue, processSortFirst, sortProcesses, type ProcessSort, type ProcessSortColumn} from '@/ui/devices/diagnostics/process-view';
import {createDiagnosisClient,diagnosisQueryState,type DiagnosisJob,type DiagnosisSubmission} from '@/ui/devices/diagnostics/diagnosis-client';
import {agentMessageText} from '@/lib/agent-messages';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import SuggestInput from '@/ui/kit/suggest-input';
import '@/ui/devices/diagnostics/diagnostics-workspace.css';

import {useLocale,useT,useStableT} from '@/ui/base/locale';
type Row = Record<string, unknown>;
/** The queries of the four lists: their failure shows as a danger Notice with "Try again"; every other kind is an action, whose failure is a toast. */
const queryKinds = new Set(['list-processes', 'list-sessions', 'list-connections', 'query-events']);
type Failure = {serverId: string; error: string; source: 'read' | 'query' | null; kind?: string; params?: Row};
/** The slow line of a first-load Skeleton appears after this time; the job wait limit (60 s) ends the wait. */
const SLOW_AFTER_MS = 15000;
const PAGE_SIZE = 25;

function useDiagnosis(serverId:string,enabled:boolean,sessionQueryAllowed=false) {
  const stableT=useStableT();
  const [locale]=useLocale();
  const [data, setData] = useState<{serverId: string; jobs: DiagnosisJob[];loaded:boolean}>({serverId, jobs: [],loaded:false});
  const [failure, setFailure] = useState<Failure>({serverId,error:'',source:null});
  const [requestState,setRequestState]=useState<{serverId:string;loading:boolean;busyKind:string|null;autoStarted:boolean;autoPreparing:boolean;submitted:DiagnosisSubmission|null}>({serverId,loading:enabled,busyKind:null,autoStarted:false,autoPreparing:false,submitted:null});
  const client=useRef<{serverId:string;value:ReturnType<typeof createDiagnosisClient>}|null>(null);
  const current=useRef({serverId,enabled,generation:0});
  const sessionAllowed=useRef(sessionQueryAllowed);sessionAllowed.current=sessionQueryAllowed;
  // The client takes the language once; a switch applies to the next client, without a reload.
  const clientLocale=useRef(locale);clientLocale.current=locale;
  // Submits started through submit() report their own failure; the client's onError reports only the automatic ones.
  const explicit=useRef(0),automaticKind=useRef<string|null>(null);
  // The last parameters per query kind, so "Try again" on a slow query repeats exactly that query.
  const lastParams=useRef(new Map<string,Row>());
  if(current.current.serverId!==serverId||current.current.enabled!==enabled)current.current={serverId,enabled,generation:current.current.generation+1};
  const inScope=useCallback(()=>current.current.serverId===serverId&&current.current.enabled,[serverId]);
  const load=useCallback(()=>enabled&&client.current?.serverId===serverId?client.current.value.load():Promise.resolve(null),[serverId,enabled]);
  const submit=useCallback((kind:string,params:Row={},confirm=false)=>{
    if(!enabled||!current.current.enabled||current.current.serverId!==serverId||client.current?.serverId!==serverId)return Promise.reject(new Error(stableT('diagnostics.viewGone')));
    if(queryKinds.has(kind))lastParams.current.set(kind,params);
    explicit.current++;
    return client.current.value.submit(kind,params,confirm).catch((error:unknown)=>{
      if(inScope()&&!(error instanceof DOMException&&error.name==='AbortError')){
        if(queryKinds.has(kind))setFailure({serverId,error:message(error),source:'query',kind,params});
        // A step-up code (opensMfaPrompt) opens the dialog at the caller instead of a toast.
        else if(!(error instanceof ApiError&&opensMfaPrompt(error.code)))toast.error(message(error));
      }
      throw error;
    }).finally(()=>{explicit.current--;});
  },[serverId,enabled,stableT,inScope]);
  const automatic=useCallback((kind:string)=>{
    if(!enabled||client.current?.serverId!==serverId)return Promise.resolve();
    automaticKind.current=kind;
    return client.current.value.automatic(kind).finally(()=>{if(automaticKind.current===kind)automaticKind.current=null;});
  },[serverId,enabled]);
  useEffect(() => {
    const generation=current.current.generation;
    setData({serverId,jobs:[],loaded:false});
    setFailure({serverId,error:'',source:null});
    setRequestState({serverId,loading:enabled,busyKind:null,autoStarted:false,autoPreparing:false,submitted:null});
    if (!enabled) return;
    let disposed=false;
    const isCurrent=()=>!disposed&&current.current.generation===generation&&current.current.serverId===serverId&&current.current.enabled;
    const update=(state:Partial<typeof requestState>)=>{if(isCurrent())setRequestState(previous=>({...previous,...state,serverId}));};
    const value=createDiagnosisClient({
      isCurrent,
      canSubmit:kind=>kind!=='list-sessions'||sessionAllowed.current,
      read:signal=>api<{jobs:DiagnosisJob[]}>('/api/diagnostics?serverId='+encodeURIComponent(serverId),undefined,signal),
      post:(kind,params,confirm,signal)=>api<{id:string}>('/api/diagnostics',{serverId,kind,params,...(confirm?{confirm:true}:{})},signal),
      onJobs:jobs=>{if(isCurrent()){setData({serverId,jobs,loaded:true});setFailure(previous=>previous.serverId===serverId&&previous.source==='query'?previous:{serverId,error:'',source:null});}},
      onError:(error,source)=>{
        if(!isCurrent())return;
        if(error instanceof ApiError&&[401,403].includes(error.status))setData({serverId,jobs:[],loaded:false});
        if(source==='read')setFailure({serverId,error:message(error),source:'read'});
        else if(!explicit.current&&automaticKind.current)setFailure({serverId,error:message(error),source:'query',kind:automaticKind.current,params:{}});
      },
      onLoading:loading=>update({loading}),onBusy:busyKind=>{update({busyKind});if(busyKind&&isCurrent())setFailure({serverId,error:'',source:null});},
      onSubmitted:submitted=>update({submitted}),onAutomatic:autoPreparing=>update({autoStarted:true,autoPreparing}),
    },clientLocale.current);
    client.current={serverId,value};void value.load();
    const refresh=()=>{if(document.visibilityState!=='hidden')void value.load();};
    const timer=setInterval(refresh,3000);document.addEventListener('visibilitychange',refresh);
    return()=>{disposed=true;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);value.dispose();if(client.current?.value===value)client.current=null;};
  },[serverId,enabled]);
  const scoped=enabled&&requestState.serverId===serverId;
  const shownFailure=enabled&&failure.serverId===serverId&&failure.source?failure:null;
  /** Try again: a failed read reloads the jobs, a failed query is sent again with its parameters (through resend when the panel keeps its own bookkeeping). */
  const retry=(resend?:(kind:string,params:Row)=>void)=>{
    const failed=shownFailure;if(!failed)return;
    setFailure({serverId,error:'',source:null});
    if(failed.source==='read')void load();
    else if(failed.kind){if(resend)resend(failed.kind,failed.params??{});else void submit(failed.kind,failed.params??{}).catch(()=>{});}
  };
  return {jobs:enabled&&data.serverId===serverId?data.jobs:[],loaded:enabled&&data.serverId===serverId&&data.loaded,failure:shownFailure,loading:scoped?requestState.loading:enabled,busy:scoped&&requestState.busyKind!==null,busyKind:scoped?requestState.busyKind:null,autoStarted:scoped&&requestState.autoStarted,autoPreparing:scoped&&requestState.autoPreparing,submitted:scoped?requestState.submitted:null,submit,automatic,load,retry,lastParams:(kind:string)=>lastParams.current.get(kind)};
}

const rows = (job: DiagnosisJob | undefined, key: string): Row[] => Array.isArray(job?.data?.data?.[key]) ? job!.data!.data[key] as Row[] : [];
const value = (row: Row, key: string) => row[key] == null || row[key] === '' ? EMPTY_VALUE : String(row[key]);
/** A measured duration in ms through the shared formatDuration; "—" without a measured value. */
const duration = (locale: Locale, input: unknown) => formatDuration(locale, input == null || input === '' ? null : Number(input));
/** A size in MiB as IEC bytes ("512 MiB"); "—" without a measured value. */
const memoryBytes = (locale: Locale, input: unknown) => {const mib = measuredValue(input); return formatBytes(locale, mib === null ? null : mib * 1024 * 1024);};
const csvField = (input: unknown) => {
  let text = String(input ?? '');
  if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
const mostRecent = (jobs: DiagnosisJob[], kind: string,key?:string) => jobs.find(job => job.kind === kind && job.state === 'succeeded' && job.data&&(!key||Array.isArray(job.data.data?.[key])));
const capability = (props: V3Props, kind: string) => props.server.snapshot?.agentCapabilities?.includes(kind) === true;
const canManage = (props: V3Props) => props.server.management === 1 && props.server.snapshot?.mode === 'Management' && permitted(props.server, props.viewer, 'manage');
/** The reason a Diagnostics panel cannot be used at all, or null. */
const diagnosticsReason = ({server, viewer, demo}: V3Props) => unavailableReason({demo, revoked: !!server.revoked, permitted: permitted(server, viewer, 'diagnose'), reported: !!server.snapshot, supported: v3(server)});
const stateLabels: Record<string, MessageKey> = {pending: 'jobs.state.pending', queued: 'jobs.state.pending', running: 'jobs.state.running', succeeded: 'updates.terminal.succeeded', failed: 'jobs.state.failed', cancelled: 'jobs.state.cancelled', interrupted: 'jobs.state.unknown'};
const kindLabels: Record<string, MessageKey> = {'list-processes': 'device.area.processes', 'kill-process': 'jobs.action.killProcess', 'list-sessions': 'device.area.sessions', 'message-session': 'diagnostics.kind.message', 'disconnect-session': 'jobs.action.disconnectSession', 'logoff-session': 'diagnostics.kind.logoff', 'list-connections': 'device.area.connections', 'network-diagnostics': 'jobs.action.networkDiagnostics', 'query-events': 'device.area.events', 'export-events': 'diagnostics.kind.exportEvents', 'support-bundle': 'jobs.action.supportBundle'};

function JobStatus({jobs, server,kinds}: {jobs: DiagnosisJob[]; server: V3Props['server'];kinds?:readonly string[]}) {
  const t=useT(),[locale]=useLocale();
  const latest = kinds?jobs.find(job=>kinds.includes(job.kind)):jobs[0];
  if(!latest)return null;
  const result = agentMessageText(latest, t);
  return <div className="sdx-dx-status">
    <span>{`${Object.hasOwn(kindLabels,latest.kind)?t(kindLabels[latest.kind]):latest.kind} · ${Object.hasOwn(stateLabels,latest.state)?t(stateLabels[latest.state]):latest.state} · ${stamp(latest.createdAt,locale)}`}</span>
    {!online(server) && <span>{t('diagnostics.offlineSaved')}</span>}
    {['failed', 'interrupted'].includes(latest.state) && result && <span role="status">{result.slice(0, 400)}</span>}
  </div>;
}

/** A failed read or query: the error, "Showing the last loaded data." while rows from an earlier load stay, and "Try again". */
function FailureNotice({error,stale,onRetry}:{error:string;stale:boolean;onRetry:()=>void}){
  const t=useT();
  return <Notice tone="danger" icon={AlertTriangle} action={<Btn size="sm" icon={RefreshCw} onClick={onRetry}>{t('common.retry')}</Btn>}><p>{error}</p>{stale&&<p>{t('console.staleData')}</p>}</Notice>;
}
/** A query that waited past the job wait limit: its slow text and "Try again"; the saved data or the empty state stays below. */
function SlowNotice({text,onRetry}:{text:string;onRetry:()=>void}){
  const t=useT();
  return <Notice tone="warning" icon={Clock3} action={<Btn size="sm" icon={RefreshCw} onClick={onRetry}>{t('common.retry')}</Btn>}>{text}</Notice>;
}
/** The first-load placeholder of a diagnostics table; the slow line offers the same retry. */
function FirstLoad({label,onRetry}:{label:string;onRetry:()=>void}){
  const t=useT();
  return <Skeleton variant="table" label={label} after={SLOW_AFTER_MS} action={<Btn variant="ghost" size="sm" onClick={onRetry}>{t('common.retry')}</Btn>}/>;
}

function processTree(items: Row[], tree: boolean): {row: Row; depth: number}[] {
  if (!tree) return items.map(row => ({row, depth: 0}));
  const map = new Map(items.map(row => [String(row.pid), row]));
  const children = new Map<string, Row[]>();
  const visited = new Set<string>();
  const result: {row: Row; depth: number}[] = [];
  for (const row of items) {
    const parent = String(row.parentPid);
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const add = (row: Row, depth: number) => {
    const id = String(row.pid);
    if (visited.has(id)) return;
    visited.add(id);
    result.push({row, depth: Math.min(depth, 20)});
    for (const child of children.get(id) ?? []) add(child, depth + 1);
  };
  for (const row of items) if (!map.has(String(row.parentPid)) || String(row.parentPid) === String(row.pid)) add(row, 0);
  for (const row of items) add(row, 0);
  return result;
}

type ProcessFocus='all'|'active'|'protected';
export function ProcessPanel(props: V3Props & {selectedUser?: string}) {
  const t=useT(),[locale]=useLocale();
  const {server} = props;
  const reason = diagnosticsReason(props), enabled = reason === null;
  const {jobs,failure,busy,submit,loaded,loading,submitted,busyKind,automatic,autoStarted,autoPreparing,retry,load,lastParams}=useDiagnosis(server.id,enabled);
  const [filter, setFilter] = useState('');
  const [tree, setTree] = useState(false);
  const [focus,setFocus]=useState<ProcessFocus>('all');
  const [sort,setSort]=useState<ProcessSort>({column:'cpu',direction:'desc'});
  const [page,setPage]=useState(1);
  const [user, setUser] = useState('');
  const [detail, setDetail] = useState<Row | null>(null);
  const [detailAt, setDetailAt] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Row | null>(null);
  const [mfa, setMfa] = useState(false);
  const opener=useRef<HTMLElement|null>(null);
  useEffect(() => {setDetail(null); setConfirmation(null); setUser(''); setFilter('');setFocus('all');setPage(1);setMfa(false);}, [server.id]);
  useEffect(() => {
    if (!props.selectedUser) return;
    setUser(props.selectedUser);setPage(1);
  }, [props.selectedUser, enabled, server.id]);
  const job = mostRecent(jobs,'list-processes','processes');
  const inventory = processView(server, job, Date.now());
  const items = inventory.rows;
  const openDetail = (row: Row) => {opener.current=typeof document==='undefined'?null:document.activeElement as HTMLElement|null;setDetail(row); setDetailAt(inventory.collectedAt);};
  const detailIdentity = detail && processIdentity(detail);
  const currentDetail = detailIdentity ? inventory.byIdentity.get(detailIdentity) : undefined;
  const users = [...new Set(items.map(row => value(row, 'user')).filter(name => name !== EMPTY_VALUE))].sort();
  const counts={all:items.length,active:items.filter(row=>(measuredValue(row.cpuPercent)??0)>0).length,protected:items.filter(row=>row.protected===true).length};
  // Every row protected: one sentence in the meta line says it, so the filter item and the per-row shield add nothing.
  const allProtected=items.length>0&&counts.protected===items.length,shownFocus:ProcessFocus=allProtected&&focus==='protected'?'all':focus;
  const filtered = items.filter(row => (!user || value(row, 'user').toLowerCase() === user.toLowerCase()) && [row.name,row.pid,row.path,row.user,row.sessionId].join(' ').toLowerCase().includes(filter.trim().toLowerCase()) && (shownFocus==='all'||shownFocus==='active'&&(measuredValue(row.cpuPercent)??0)>0||shownFocus==='protected'&&row.protected===true));
  const sorted=sortProcesses(filtered,sort);
  const pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE)),visiblePage=Math.min(page,pages),visible=processTree(sorted,tree).slice((visiblePage-1)*PAGE_SIZE,visiblePage*PAGE_SIZE);
  const query=diagnosisQueryState(jobs,'list-processes',submitted);
  const autoQueryNeeded=enabled&&online(server)&&capability(props,'list-processes')&&!server.snapshot?.processInventory&&inventory.source==='none'&&!jobs.some(job=>job.kind==='list-processes');
  useEffect(()=>{if(autoQueryNeeded&&loaded&&!failure)void automatic('list-processes');},[autoQueryNeeded,loaded,failure,automatic]);
  // No state shows a skeleton after the job wait limit: a timed-out query ends in the slow notice.
  const fetching=!query.timedOut&&((!loaded&&loading&&!failure)||busyKind==='list-processes'||query.pending||autoQueryNeeded&&!failure&&(!autoStarted||autoPreparing));
  const pendingInventory=server.snapshot?.processInventory;
  const pendingAt=pendingInventory?.collectedAt?Date.parse(pendingInventory.collectedAt):NaN;
  const waitingForInventory=inventory.source==='none'&&pendingInventory?.complete===false&&Number.isFinite(pendingAt)&&Date.now()-pendingAt<120000&&Date.now()-pendingAt>=-10000&&!inventory.collectionError&&online(server)&&!failure;
  const initialLoading=inventory.source==='none'&&(fetching||waitingForInventory);
  const killAllowed = canManage(props) && capability(props, 'kill-process') && online(server)&&enabled&&!server.revoked;
  const mayKill = (row: Row | null) => killAllowed && !fetching && !!currentKillCandidate(inventory, row);
  const confirmedProcess = currentKillCandidate(inventory, confirmation);
  const live=useRef({props,inventory,confirmation,fetching,submit});live.current={props,inventory,confirmation,fetching,submit};
  const requestDetails=()=>{const latest=live.current;if(latest.props.server.id===server.id&&!latest.props.server.revoked&&v3(latest.props.server)&&permitted(latest.props.server,latest.props.viewer,'diagnose')&&!latest.props.demo&&online(latest.props.server)&&capability(latest.props,'list-processes')&&!latest.fetching)void latest.submit('list-processes',{limit:1000,sampleMs:350}).catch(()=>{});};
  // "Try again" while a first load or a query takes too long: the read again, or the last process query again.
  const retryWait=()=>{if(!loaded){void load();return;}const latest=live.current;if(latest.props.server.id===server.id&&online(latest.props.server)&&capability(latest.props,'list-processes'))void latest.submit('list-processes',lastParams('list-processes')??{limit:1000,sampleMs:350}).catch(()=>{});};
  const chooseKill=(row:Row)=>{const latest=live.current;if(latest.props.server.id===server.id&&!latest.props.server.revoked&&v3(latest.props.server)&&permitted(latest.props.server,latest.props.viewer,'diagnose')&&canManage(latest.props)&&online(latest.props.server)&&!latest.props.demo&&capability(latest.props,'kill-process')&&!latest.fetching&&currentKillCandidate(latest.inventory,row))setConfirmation(row);};
  const kill = async () => {
    const latest=live.current,selected=latest.confirmation,current=currentKillCandidate(latest.inventory,selected);
    // A retained confirmation or step-up callback must stay bound to its chosen process.
    if(!confirmation||!selected||processIdentity(confirmation)!==processIdentity(selected))return;
    if(latest.props.server.id!==server.id||!!latest.props.server.revoked||!v3(latest.props.server)||!canManage(latest.props)||!online(latest.props.server)||latest.props.demo||!capability(latest.props,'kill-process')||!permitted(latest.props.server,latest.props.viewer,'diagnose')||latest.fetching||!current){
      setConfirmation(null);setMfa(false);toast.error(t('diagnostics.processes.stale'));return;
    }
    try {
      await latest.submit('kill-process',{pid:current.pid,startedAt:current.startedAt,confirm:true},true);
      if(live.current.props.server.id===server.id&&processIdentity(live.current.confirmation??{})===processIdentity(selected)){setConfirmation(null);setDetail(null);setMfa(false);}
    } catch(e){if(live.current.props.server.id===server.id&&processIdentity(live.current.confirmation??{})===processIdentity(selected)&&e instanceof ApiError&&opensMfaPrompt(e.code))setMfa(true);}
  };
  if (reason) return <Unavailable reason={reason}>{reason==='right'?t('diagnostics.blocked.right'):undefined}</Unavailable>;
  /** Why "End process" is not available for this row, or undefined. */
  const killBlocked=(row:Row)=>mayKill(row)?undefined:row.protected===true?t('diagnostics.processes.protected'):!online(server)?t('management.blocked.offline'):fetching?t('diagnostics.processes.refreshing'):!inventory.fresh?t('diagnostics.processes.needCurrent'):!processIdentity(row)||row.protected!==false?t('diagnostics.processes.noIdentity'):t('diagnostics.processes.needManagement');
  const changeFilter=(apply:()=>void)=>{apply();setPage(1);};
  const resetFilters=()=>{setFilter('');setFocus('all');setUser('');setPage(1);};
  const counted=inventory.source!=='none';
  const columns:DataColumn<{row:Row;depth:number}>[]=[
    {id:'name',label:t('diagnostics.process'),primary:true,sort:{first:processSortFirst.name},cell:({row,depth})=><span className="sdx-dx-process" style={depth?{paddingInlineStart:depth*12}:undefined}>
      <span className="sdx-dx-process-name">{depth?'↳ ':''}{value(row,'name')}{row.protected===true&&!allProtected&&<Shield size={12} aria-label={t('diagnostics.processes.protected')}/>}</span>
      {row.path!=null&&row.path!==''&&<small className="sdx-dx-path" title={String(row.path)}>{String(row.path)}</small>}
    </span>},
    {id:'pid',label:t('diagnostics.col.pid'),mono:true,align:'end',sort:{first:processSortFirst.pid},cell:({row})=>value(row,'pid')},
    {id:'cpu',label:t('fleet.col.cpu'),align:'end',sort:{first:processSortFirst.cpu},cell:({row})=>{const cpu=measuredValue(row.cpuPercent),text=percentLabel(cpu,locale);return <span className="sdx-dx-cpu"><span className="mono">{text}</span>{cpu!==null&&<Meter size="sm" value={cpu} label={`CPU ${text}`}/>}</span>;}},
    {id:'memory',label:t('diagnostics.processes.memory'),mono:true,align:'end',sort:{first:processSortFirst.memory},cell:({row})=>memoryBytes(locale,row.memoryMb)},
    {id:'user',label:t('diagnostics.userSession'),hideBelow:900,cell:({row})=><span className="sdx-dx-stack"><span className="sdx-dx-user">{value(row,'user')}</span><small>{t('diagnostics.session',{value:value(row,'sessionId')})}</small></span>},
    {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',width:56,cell:({row})=><Menu label={t('tree.actionsForName',{name:value(row,'name')})} entries={[
      {id:'details',label:t('diagnostics.processes.showDetails'),icon:Info,onSelect:()=>openDetail(row)},
      {id:'separator',separator:true},
      {id:'kill',label:t('jobs.action.killProcess'),icon:Square,danger:true,blocked:busy&&busyKind!=='list-processes'?t('diagnostics.busy'):killBlocked(row),onSelect:()=>chooseKill(row)},
    ]}/>},
  ];
  const meta=counted?<p className="sdx-dx-meta">
    <span>{t(inventory.truncated?'diagnostics.processes.collectedLimited':'diagnostics.processes.collected',{count:formatNumber(locale,inventory.count)})}</span>
    <StatusPill kind={inventory.fresh?'online':'neutral'}>{inventory.source==='automatic'?t('diagnostics.processes.automatic',{value:inventory.intervalSeconds?` · ${inventory.intervalSeconds} s`:''}):t('diagnostics.processes.detailQuery')}{inventory.fresh?'':<> · {t('diagnostics.savedData')}</>}</StatusPill>
    <time>{stamp(inventory.collectedAt,locale)}</time>
    {allProtected&&<span>{t('diagnostics.processes.allProtected')}</span>}
  </p>:<p className="sdx-dx-meta">{t('diagnostics.processes.inventory')}</p>;
  const refreshBlocked=!online(server)?t('management.blocked.offline'):!capability(props,'list-processes')?t('kit.unavailable.agent'):undefined;
  const toolbar=<Toolbar search={{value:filter,onChange:next=>changeFilter(()=>setFilter(next)),label:t('diagnostics.processes.filterLabel'),placeholder:t('diagnostics.processes.filterPlaceholder')}}
    filters={<>
      <Segmented<ProcessFocus> size="sm" label={t('diagnostics.processes.filter')} value={shownFocus} onChange={next=>changeFilter(()=>setFocus(next))} items={[{id:'all',label:t('diagnostics.processes.all'),count:counted?counts.all:undefined},{id:'active',label:t('diagnostics.processes.cpuActive'),count:counted?counts.active:undefined},...(allProtected?[]:[{id:'protected' as const,label:t('storage.protected'),count:counted?counts.protected:undefined}])]}/>
      <Select size="sm" aria-label={t('diagnostics.processes.user')} value={user} onChange={event=>changeFilter(()=>setUser(event.target.value))}><option value="">{t('diagnostics.processes.allUsers')}</option>{user&&!users.includes(user)&&<option>{user}</option>}{users.map(name=><option key={name}>{name}</option>)}</Select>
      <label className="sdx-dx-switch"><input type="checkbox" role="switch" checked={tree} onChange={event=>changeFilter(()=>setTree(event.target.checked))}/>{t('diagnostics.processes.tree')}</label>
    </>}
    actions={<Btn icon={RefreshCw} loading={fetching&&!initialLoading} blocked={refreshBlocked} hint={t('diagnostics.processes.detailHint')} onClick={requestDetails}>{t('diagnostics.processes.refreshDetails')}</Btn>}/>;
  const empty=items.length?{icon:Search,title:t('diagnostics.processes.noneFilter'),action:<Btn size="sm" icon={X} onClick={resetFilters}>{t('fleet.empty.resetFilter')}</Btn>}
    :counted?{icon:Search,title:t('diagnostics.processes.none')}
    :!online(server)?{icon:Search,title:t('diagnostics.offlineTitle'),children:t('diagnostics.processes.offline')}
    :{icon:Search,title:t('diagnostics.processes.noAutomaticTitle'),children:t('diagnostics.processes.noAutomatic')};
  const killReason=confirmation&&!confirmedProcess?t('diagnostics.processes.changed'):confirmation&&!killAllowed?killBlocked(confirmation):undefined;
  return <div className="sdx-dx">
    {failure&&<FailureNotice error={failure.error} stale={items.length>0} onRetry={()=>retry()}/>}
    {query.timedOut&&<SlowNotice text={t('diagnostics.processes.slow')} onRetry={retryWait}/>}
    {inventory.collectionError&&<Notice tone="warning" icon={AlertTriangle}>{t('diagnostics.processes.inventoryError',{collectionError:inventory.collectionError})}</Notice>}
    {initialLoading?<FirstLoad label={t('diagnostics.processes.loading')} onRetry={retryWait}/>:<>
      {meta}
      <DataTable<{row:Row;depth:number}> label={t('diagnostics.processes.label')} entranceId={'diagnostics-processes:'+server.id} cards columns={columns} rows={visible} rowKey={({row})=>value(row,'pid')+value(row,'startedAt')}
        sort={sort} onSort={next=>{setSort({column:next.column as ProcessSortColumn,direction:next.direction});setPage(1);}} busy={fetching}
        onOpen={({row})=>openDetail(row)} openLabel={({row})=>t('diagnostics.processes.detailsFor',{value:value(row,'name'),value2:value(row,'pid')})}
        toolbar={toolbar} empty={empty}
        foot={<>{t('diagnostics.processes.foot',{shown:formatNumber(locale,filtered.length),total:formatNumber(locale,items.length)})}{inventory.truncated?<> · {t('diagnostics.collectedOf',{shown:formatNumber(locale,items.length),count:formatNumber(locale,inventory.count)})}</>:null}</>}
        pagination={{page:visiblePage,pageSize:PAGE_SIZE,total:filtered.length,onPage:setPage}}/>
    </>}
    <JobStatus jobs={jobs} server={server} kinds={['list-processes','kill-process']}/>
    <Drawer open={!!detail&&!confirmation&&!mfa} onClose={() => setDetail(null)} returnFocus={opener} title={detail ? value(detail, 'name') : t('diagnostics.process')} description={detail ? `PID ${value(detail, 'pid')} · ${server.name}` : undefined}
      footer={detail&&<Btn variant="danger" icon={Square} disabled={busy&&busyKind!=='list-processes'} blocked={killBlocked(detail)} onClick={() => chooseKill(detail)}>{t('jobs.action.killProcess')}</Btn>}>
      {detail && <Facts items={[
        {id:'path',label: t('diagnostics.path'), value: value(currentDetail ?? detail, 'path'), mono:true}, {id:'user',label: t('management.users.user'), value: value(currentDetail ?? detail, 'user')}, {id:'sid',label: t('diagnostics.col.sid'), value: value(currentDetail ?? detail, 'sid'), mono:true},
        {id:'session',label: t('diagnostics.sessionLabel'), value: value(currentDetail ?? detail, 'sessionId')}, {id:'parent',label: t('diagnostics.col.parentPid'), value: value(currentDetail ?? detail, 'parentPid'), mono:true}, {id:'start',label: t('diagnostics.startTime'), value: stamp(String(detail.startedAt ?? ''),locale)},
        {id:'cpu',label: t('fleet.col.cpu'), value: percentLabel(measuredValue(currentDetail?.cpuPercent),locale), mono:true}, {id:'memory',label: t('diagnostics.processes.memory'), value: memoryBytes(locale,currentDetail?.memoryMb), mono:true}, {id:'query',label: t('diagnostics.query'), value: stamp(currentDetail ? inventory.collectedAt : detailAt,locale)}, {id:'protected',label: t('storage.protected'), value: currentDetail?.protected === true ? t('management.yes') : currentDetail?.protected === false ? t('management.no') : EMPTY_VALUE},
      ]}/>}
      {detail && !currentDetail && <p className="sdx-dx-note">{detailIdentity ? t('diagnostics.processes.notInList') : t('diagnostics.processes.noStartTime')}</p>}
      {!inventory.fresh && <p className="sdx-dx-note">{t('diagnostics.processes.savedList')}</p>}
      <p className="sdx-dx-note">{t('diagnostics.processes.cpuHint')}</p>
    </Drawer>
    <ConfirmDialog open={!!confirmation&&!mfa} onOpenChange={next=>{if(!next)setConfirmation(null);}} title={t('diagnostics.processes.endTitle')}
      lines={confirmation?[{label:t('diagnostics.process'),value:value(confirmation,'name')},{label:t('diagnostics.col.pid'),value:value(confirmation,'pid')},{label:t('fleet.col.device'),value:server.name}]:undefined}
      body={confirmation?t('diagnostics.processes.endDescription',{value:value(confirmation,'name'),value2:value(confirmation,'pid'),name:server.name}):undefined}
      confirmLabel={t('jobs.action.killProcess')} tone="danger" busy={busyKind==='kill-process'} blocked={killReason} onConfirm={() => void kill()}/>
    {mfa && <MfaStepUp open onClose={() => setMfa(false)} onVerified={() => void kill()}/>}
  </div>;
}

type SessionAction='message-session'|'disconnect-session'|'logoff-session';
const sessionActionLabels:Record<SessionAction,MessageKey>={'message-session':'diagnostics.sessions.send','disconnect-session':'diagnostics.sessions.disconnect','logoff-session':'diagnostics.sessions.logoff'};
const sessionActionTitles:Record<SessionAction,MessageKey>={'message-session':'diagnostics.sessions.send','disconnect-session':'diagnostics.sessions.disconnectTitle','logoff-session':'diagnostics.sessions.logoffTitle'};
export function SessionPanel(props: V3Props & {onSelectUser?: (user: string) => void}) {
  const t=useT(),[locale]=useLocale();
  const {server, onSelectUser} = props;
  const reason = diagnosticsReason(props), enabled = reason === null;
  const mayQuery=enabled&&online(server)&&capability(props,'list-sessions');
  const {jobs,failure,busy,submit,automatic,loaded,loading,autoStarted,autoPreparing,submitted,busyKind,retry,load} = useDiagnosis(server.id,enabled,mayQuery);
  const [selection, setSelection] = useState<{row: Row; kind: SessionAction} | null>(null);
  const [text, setText] = useState('');
  const [mfa, setMfa] = useState(false);
  useEffect(() => {setSelection(null); setText(''); setMfa(false);}, [server.id]);
  useEffect(()=>{if(mayQuery)void automatic('list-sessions');},[mayQuery,automatic]);
  const job = mostRecent(jobs,'list-sessions','sessions');
  const items = rows(job, 'sessions');
  const query=diagnosisQueryState(jobs,'list-sessions',submitted);
  const fetching=!query.timedOut&&(mayQuery&&(!autoStarted||autoPreparing)||!loaded&&loading&&!failure||busyKind==='list-sessions'||query.pending);
  const relevantJobs=jobs.filter(job=>['list-sessions','message-session','disconnect-session','logoff-session'].includes(job.kind));
  const execute = async () => {
    if (!selection) return;
    // The server stays authoritative; an empty message never leaves the client.
    if (selection.kind === 'message-session' && !text.trim()) return;
    try {
      await submit(selection.kind, {sessionId: selection.row.sessionId, username: selection.row.username, confirm: true, ...(selection.kind === 'message-session' ? {message: text} : {})}, true);
      setSelection(null);
      setText('');
    } catch (e) {if (e instanceof ApiError&&opensMfaPrompt(e.code)) setMfa(true);}
  };
  const refresh=()=>void submit('list-sessions').catch(()=>{});
  const retryWait=()=>{if(!loaded)void load();else if(mayQuery)refresh();};
  if (reason) return <Unavailable reason={reason}>{reason==='right'?t('diagnostics.blocked.right'):undefined}</Unavailable>;
  /** Why a session action cannot run for this row, or undefined. */
  const actionBlocked=(row:Row,kind:SessionAction)=>!canManage(props)?t('diagnostics.processes.needManagement'):!capability(props,kind)?t('kit.unavailable.agent'):!online(server)?t('management.blocked.offline'):Number(row.sessionId)<1||!row.username?t('diagnostics.sessions.noUser'):fetching?t('diagnostics.sessions.refreshing'):busy?t('diagnostics.busy'):undefined;
  // "Show {count} processes" first (it opens Diagnostics → Processes filtered to the user), then the session actions.
  const entries=(row:Row):MenuEntry[]=>[
    ...(onSelectUser?[{id:'processes',label:Array.isArray(row.processIds)?t('diagnostics.sessions.showProcesses',{count:formatNumber(locale,row.processIds.length)}):t('device.area.processes'),icon:ListTree,blocked:row.username?undefined:t('diagnostics.sessions.noUser'),onSelect:()=>onSelectUser(String(row.username))} satisfies MenuEntry]:[]),
    ...([['message-session',Send],['disconnect-session',Unplug],['logoff-session',LogOut]] as const).map(([kind,icon]):MenuEntry=>({id:kind,label:t(sessionActionLabels[kind]),icon,danger:kind==='logoff-session',blocked:actionBlocked(row,kind),onSelect:()=>{setText('');setSelection({row,kind});}})),
  ];
  const columns:DataColumn<Row>[]=[
    {id:'user',label:t('management.users.user'),primary:true,cell:row=><strong>{value(row,'username')}</strong>},
    {id:'session',label:t('diagnostics.sessionLabel'),mono:true,cell:row=><span className="sdx-dx-stack"><span>{value(row,'station')}</span><small>{t('diagnostics.sessionId',{id:value(row,'sessionId')})}</small></span>},
    {id:'state',label:t('management.status'),cell:row=>value(row,'state')},
    {id:'client',label:t('diagnostics.col.client'),hideBelow:1100,cell:row=>value(row,'client')},
    {id:'logon',label:t('diagnostics.sessions.logon'),hideBelow:900,cell:row=>row.logonAt?exactTime(String(row.logonAt),locale):EMPTY_VALUE},
    {id:'idle',label:t('diagnostics.sessions.idle'),cell:row=>row.idleSeconds == null ? EMPTY_VALUE : t('diagnostics.sessions.idleMinutes',{round:Math.round(Number(row.idleSeconds) / 60)})},
    {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',width:56,cell:row=><Menu label={t('tree.actionsForName',{name:value(row,'username')})} entries={entries(row)}/>},
  ];
  const queryBlocked=!online(server)?t('management.blocked.offline'):!capability(props,'list-sessions')?t('kit.unavailable.agent'):undefined;
  const empty=job?{icon:Users,title:t('diagnostics.sessions.none')}:!online(server)?{icon:Users,title:t('diagnostics.offlineTitle'),children:t('diagnostics.sessions.offline')}:!capability(props,'list-sessions')?{icon:Users,title:t('kit.unavailable.agentTitle'),children:t('kit.unavailable.agent')}:{icon:Users,title:t('diagnostics.sessions.noResult')};
  const kind=selection?.kind;
  return <div className="sdx-dx">
    {failure&&<FailureNotice error={failure.error} stale={items.length>0} onRetry={()=>retry()}/>}
    {query.timedOut&&<SlowNotice text={t('diagnostics.sessions.slow')} onRetry={retryWait}/>}
    {fetching&&!job?<FirstLoad label={t('diagnostics.sessions.loading')} onRetry={retryWait}/>:<>
      {job&&<p className="sdx-dx-meta">{t('diagnostics.sessions.count',{count:items.length,time:stamp(job.data?.at,locale)})}</p>}
      <DataTable<Row> label={t('diagnostics.sessions.label')} entranceId={'diagnostics-sessions:'+server.id} cards columns={columns} rows={items} rowKey={row=>value(row,'sessionId')} busy={fetching} empty={empty}
        toolbar={<Toolbar actions={<Btn icon={RefreshCw} loading={fetching||busyKind==='list-sessions'} blocked={queryBlocked} onClick={refresh}>{t('network.refresh')}</Btn>}/>}/>
    </>}
    <JobStatus jobs={relevantJobs} server={server}/>
    <ConfirmDialog open={!!selection&&!mfa} onOpenChange={next => {if (!next) setSelection(null);}} title={kind?t(sessionActionTitles[kind]):''}
      body={selection ? t(selection.kind === 'logoff-session' ? 'diagnostics.sessions.logoffDescription' : 'diagnostics.sessions.description', {user: value(selection.row, 'username'), session: value(selection.row, 'sessionId'), name: server.name}) : undefined}
      confirmLabel={kind?t(sessionActionLabels[kind]):''} tone={kind==='logoff-session'?'danger':'default'} busy={busy}
      blocked={kind==='message-session'&&!text.trim()?t('diagnostics.sessions.messageEmpty'):undefined} onConfirm={() => void execute()}>
      {kind==='message-session'&&<Field label={t('diagnostics.sessions.messageLabel')}><textarea value={text} onChange={event => setText(event.target.value)} maxLength={1000} rows={3}/></Field>}
    </ConfirmDialog>
    <MfaStepUp open={mfa} onClose={() => setMfa(false)} onVerified={() => void execute()}/>
  </div>;
}

function endpoint(row: Row, addressKey: string, portKey: string) {
  if (row[addressKey] == null || row[addressKey] === '') return EMPTY_VALUE;
  const address = String(row[addressKey]);
  const host = address.includes(':') ? `[${address}]` : address;
  return row[portKey] == null ? host : `${host}:${String(row[portKey])}`;
}

export function ConnectionsPanel(props: V3Props) {
  const t=useT(),[locale]=useLocale();
  const {server} = props;
  const reason = diagnosticsReason(props), enabled = reason === null;
  const {jobs,failure,busy,submit,loaded,loading,submitted,busyKind,retry,load,lastParams} = useDiagnosis(server.id, enabled);
  const [filter, setFilter] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('443');
  const [detail, setDetail] = useState<Row | null>(null);
  const [detailAt, setDetailAt] = useState<string | undefined>();
  const [detailJobId, setDetailJobId] = useState('');
  const [networkDetail, setNetworkDetail] = useState(false);
  useEffect(() => {setDetail(null); setNetworkDetail(false);}, [server.id]);
  const connectionJob = mostRecent(jobs,'list-connections','connections');
  const connections = rows(connectionJob, 'connections');
  const openDetail = (row: Row) => {setDetail(row); setDetailAt(connectionJob?.data?.at); setDetailJobId(connectionJob?.id ?? '');};
  const filtered = connections.filter(row => Object.values(row).join(' ').toLowerCase().includes(filter.toLowerCase()));
  const query=diagnosisQueryState(jobs,'list-connections',submitted);
  const fetching=!query.timedOut&&(!loaded&&loading&&!failure||busyKind==='list-connections'||query.pending);
  const diagnostic = mostRecent(jobs, 'network-diagnostics');
  const network = diagnostic?.data?.data;
  const tcp = network?.tcp && typeof network.tcp === 'object' ? network.tcp as Row : null;
  const dns = Array.isArray(network?.dns) ? network.dns : [];
  const runQuery=()=>void submit('list-connections', lastParams('list-connections')??{limit: 500}).catch(() => {});
  const retryWait=()=>{if(!loaded)void load();else runQuery();};
  if (reason) return <Unavailable reason={reason}>{reason==='right'?t('diagnostics.blocked.right'):undefined}</Unavailable>;
  const portValid=Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535;
  const queryBlocked=!online(server)?t('management.blocked.offline'):!capability(props,'list-connections')?t('kit.unavailable.agent'):undefined;
  const testBlocked=!portValid?t('diagnostics.network.portInvalid'):!online(server)?t('management.blocked.offline'):!capability(props,'network-diagnostics')?t('kit.unavailable.agent'):undefined;
  const columns:DataColumn<Row&{index:number}>[]=[
    {id:'protocol',label:t('management.param.protocol'),cell:row=>value(row,'protocol')},
    {id:'state',label:t('monitoring.state'),cell:row=>value(row,'state')},
    {id:'local',label:t('diagnostics.local'),mono:true,cell:row=>endpoint(row,'localAddress','localPort')},
    {id:'remote',label:t('audit.target'),mono:true,cell:row=>endpoint(row,'remoteAddress','remotePort')},
    {id:'process',label:t('diagnostics.process'),primary:true,cell:row=><span className="sdx-dx-stack"><span>{value(row,'name')}</span><small>{t('diagnostics.pid',{value:value(row,'pid')})}</small></span>},
    {id:'user',label:t('management.users.user'),hideBelow:1100,cell:row=>value(row,'user')},
  ];
  const tableRows=filtered.map((row,index)=>({...row,index}));
  const empty=connections.length?{icon:Search,title:t('diagnostics.connections.noneFilter'),action:<Btn size="sm" icon={X} onClick={()=>setFilter('')}>{t('fleet.empty.resetFilter')}</Btn>}
    :connectionJob?{icon:Network,title:t('diagnostics.connections.none')}
    :!online(server)?{icon:Network,title:t('diagnostics.offlineTitle'),children:t('diagnostics.connections.offline')}
    // Before the first query: say what a query does and offer it here; nothing queries on open.
    :{icon:Network,title:t('diagnostics.connections.notQueried'),children:t('diagnostics.connections.promptHint'),action:<Btn size="sm" icon={RefreshCw} loading={fetching} blocked={queryBlocked} disabled={busy&&!fetching} onClick={runQuery}>{t('diagnostics.connections.query')}</Btn>};
  const truncated=connectionJob?.data?.data.truncated === true;
  const tcpResult=tcp?(tcp.connected === true ? t('network.reachable') : tcp.connected === false ? t('jobs.state.failed') : EMPTY_VALUE):'';
  return <div className="sdx-dx">
    {failure&&<FailureNotice error={failure.error} stale={connections.length>0} onRetry={()=>retry()}/>}
    {query.timedOut&&<SlowNotice text={t('diagnostics.connections.slow')} onRetry={retryWait}/>}
    <Card title={t('diagnostics.connections.title')} icon={Network} iconTone="accent" flush className="sdx-dx-card">
      {fetching&&!connectionJob?<div className="sdx-dx-card-body"><FirstLoad label={t('diagnostics.connections.loading')} onRetry={retryWait}/></div>:
      <DataTable<Row&{index:number}> variant="flush" label={t('diagnostics.connections.title')} entranceId={'diagnostics-connections:'+server.id} cards columns={columns} rows={tableRows} busy={fetching}
        rowKey={row=>`${value(row,'protocol')}-${endpoint(row,'localAddress','localPort')}-${row.index}`}
        onOpen={openDetail} openLabel={row=>`${t('runbooks.connection')}: ${value(row,'name')} · ${endpoint(row,'localAddress','localPort')}`}
        toolbar={<Toolbar search={{value:filter,onChange:setFilter,label:t('diagnostics.connections.filter'),placeholder:t('diagnostics.connections.filterPlaceholder')}} actions={<Btn icon={RefreshCw} loading={fetching} blocked={queryBlocked} disabled={busy&&!fetching} onClick={runQuery}>{t('diagnostics.connections.query')}</Btn>}/>}
        empty={empty}
        foot={connectionJob?<>{t('diagnostics.connections.foot',{shown:formatNumber(locale,filtered.length),total:formatNumber(locale,connections.length),time:stamp(connectionJob.data?.at,locale)})}{truncated?<> · {t('diagnostics.collectedOf',{shown:formatNumber(locale,connections.length),count:String(connectionJob.data?.data.count ?? EMPTY_VALUE)})}</>:null}</>:undefined}/>}
      <JobStatus jobs={jobs} server={server} kinds={['list-connections']}/>
    </Card>
    <Card title={t('diagnostics.network.test')} icon={Search} iconTone="neutral" meta={diagnostic?stamp(diagnostic.data?.at,locale):undefined} className="sdx-dx-card">
      <form className="sdx-dx-network-form" onSubmit={event=>{event.preventDefault();if(!testBlocked)void submit('network-diagnostics', {...(host.trim() ? {host: host.trim()} : {}), port: Number(port)}).catch(() => {});}}>
        <Field label={t('diagnostics.network.target')}><input value={host} onChange={event => setHost(event.target.value)} placeholder={t('diagnostics.network.targetPlaceholder')}/></Field>
        <Field label={t('network.tcpPort')} error={portValid?undefined:t('diagnostics.network.portInvalid')}><input type="number" min={1} max={65535} value={port} onChange={event => setPort(event.target.value)}/></Field>
        <Btn type="submit" icon={Search} loading={busyKind==='network-diagnostics'} blocked={testBlocked} disabled={busy&&busyKind!=='network-diagnostics'}>{t('diagnostics.network.run')}</Btn>
      </form>
      {diagnostic && <div className="sdx-dx-network-result" role="status">
        <span>{tcp ? `TCP ${value(tcp, 'host')}:${value(tcp, 'port')} · ${tcpResult} · ${duration(locale,tcp.durationMs)}` : t('diagnostics.network.queried')}</span>
        {dns.length > 0 && <span className="mono">{t('diagnostics.network.dns',{join:dns.map(String).join(', ')})}</span>}
        <Btn variant="ghost" size="sm" onClick={() => setNetworkDetail(true)}>{t('diagnostics.network.openResult')}</Btn>
      </div>}
      <JobStatus jobs={jobs} server={server} kinds={['network-diagnostics']}/>
    </Card>
    <Drawer open={!!detail && jobs.some(item => item.id === detailJobId && item.data)} onClose={() => setDetail(null)} title={t('runbooks.connection')} description={detail ? `${value(detail, 'protocol')} · ${server.name}` : undefined}>
      {detail && <Facts items={[
        {id:'local',label: t('diagnostics.local'), value: endpoint(detail, 'localAddress', 'localPort'), mono:true}, {id:'remote',label: t('audit.target'), value: endpoint(detail, 'remoteAddress', 'remotePort'), mono:true}, {id:'state',label: t('monitoring.state'), value: value(detail, 'state')}, {id:'process',label: t('diagnostics.process'), value: value(detail, 'name')}, {id:'pid',label: t('diagnostics.col.pid'), value: value(detail, 'pid'), mono:true}, {id:'user',label: t('management.users.user'), value: value(detail, 'user')}, {id:'session',label: t('diagnostics.sessionLabel'), value: value(detail, 'sessionId')}, {id:'query',label: t('diagnostics.query'), value: stamp(detailAt,locale)},
      ]}/>}
      <p className="sdx-dx-note">{t('diagnostics.connections.userHint')}</p>
    </Drawer>
    <Drawer open={networkDetail} onClose={() => setNetworkDetail(false)} title={t('jobs.action.networkDiagnostics')} description={diagnostic ? `${server.name} · ${stamp(diagnostic.data?.at,locale)}` : undefined}>
      {network && <>{tcp && <Facts items={[{id:'target',label: t('diagnostics.network.tcpTarget'), value: `${value(tcp, 'host')}:${value(tcp, 'port')}`, mono:true}, {id:'result',label: t('runbooks.connection'), value: tcpResult}, {id:'duration',label: t('customers.duration'), value: duration(locale,tcp.durationMs)}, ...(tcp.error ? [{id:'error',label: t('hardware.error'), value: String(tcp.error)}] : [])]}/>}
        {network.dnsError != null && <Notice tone="danger" icon={AlertTriangle}>{String(network.dnsError)}</Notice>}
        {dns.length > 0 && <><h3 className="sdx-dx-drawer-heading">{t('network.dnsResolution')}</h3><pre className="sdx-dx-output mono">{dns.map(String).join('\n')}</pre></>}
        {[[t('diagnostics.network.addresses'), 'addresses'], ['DNS-Server', 'dnsServers'], [t('network.routes'), 'routes'], ['Listener', 'listeners']].map(([label, key]) => <details key={key} className="sdx-dx-details"><summary>{label}{Array.isArray(network[key]) ? ` · ${network[key].length}` : ''}</summary><pre className="sdx-dx-output mono">{JSON.stringify(network[key] ?? [], null, 2)}</pre></details>)}
        <details className="sdx-dx-details"><summary>{t('network.winhttpProxy')}</summary><pre className="sdx-dx-output mono">{String(network.proxy ?? EMPTY_VALUE)}</pre></details>
      </>}
    </Drawer>
  </div>;
}

function eventDate(input: string): string | undefined {
  const parsed=Date.parse(input);return input&&Number.isFinite(parsed)?new Date(parsed).toISOString():undefined;
}
function localDate(at:number){const date=new Date(at);return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;}
function eventSecurity(job:DiagnosisJob){const outer=job.data as {scope?:{security?:boolean}}|null,inner=job.data?.data.scope as {security?:boolean}|undefined;return outer?.scope?.security===true||inner?.security===true||String(job.data?.data.channel??'').trim().toLowerCase()==='security';}
/** The pill of an event level: critical and error are critical, warning is warning, the rest neutral; always with the level text. */
const levelKind=(row:Row):StatusKind=>[1,2].includes(Number(row.levelNumber))?'critical':Number(row.levelNumber)===3?'warning':'neutral';

type EventFocus='all'|'errors'|'warnings';
export function EventPanel(props: V3Props&{now:number}) {
  const t=useT(),[locale]=useLocale();
  const {server,viewer,now}=props;
  const reason=diagnosticsReason(props),enabled=reason===null;
  const {jobs,failure,busy,submit,loaded,loading,submitted,busyKind,retry,load,lastParams}=useDiagnosis(server.id,enabled);
  const [queries,setQueries]=useState<Record<string,Row>>({});
  const [channel,setChannel]=useState('System');
  const [provider,setProvider]=useState('');
  const [ids,setIds]=useState('');
  const [text,setText]=useState('');
  const [from,setFrom]=useState('');
  const [to,setTo]=useState('');
  const [level,setLevel]=useState('all');
  const [xml,setXml]=useState(false);
  const [detail,setDetail]=useState<Row|null>(null);
  const [detailChannel,setDetailChannel]=useState('');
  const [detailJobId,setDetailJobId]=useState('');
  const [copied,setCopied]=useState(false);
  const [resultFocus,setResultFocus]=useState<EventFocus>('all');
  const copiedTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>{setDetail(null);setQueries({});setCopied(false);setResultFocus('all');},[server.id]);
  useEffect(()=>()=>{if(copiedTimer.current)clearTimeout(copiedTimer.current);},[]);
  const securityAllowed=permitted(server,viewer,'security.events');
  const visibleJobs=securityAllowed?jobs:jobs.filter(job=>!eventSecurity(job));
  const eventJob=mostRecent(visibleJobs,'query-events','events');
  const events=rows(eventJob,'events');
  const matching=events.filter(row=>resultFocus==='all'||resultFocus==='errors'&&[1,2].includes(Number(row.levelNumber))||resultFocus==='warnings'&&Number(row.levelNumber)===3);
  const counts={errors:events.filter(row=>[1,2].includes(Number(row.levelNumber))).length,warnings:events.filter(row=>Number(row.levelNumber)===3).length};
  const openDetail=(row:Row)=>{setDetail(row);setDetailChannel(value(eventJob?.data?.data??{},'channel'));setDetailJobId(eventJob?.id??'');setCopied(false);};
  const parameters:Row={channel:channel.trim(),provider:provider.trim()||undefined,eventIds:ids.split(',').map(item=>item.trim()).filter(Boolean).map(Number),text,from:eventDate(from),to:eventDate(to),levels:level==='all'?[]:level==='errors'?[1,2]:[Number(level)],limit:50,includeXml:xml};
  const invalidIds=!!ids.trim()&&ids.split(',').some(id=>!/^\s*\d+\s*$/.test(id)||!Number.isSafeInteger(Number(id))||Number(id)>65535);
  const invalidDates=!!from&&!Number.isFinite(Date.parse(from))||!!to&&!Number.isFinite(Date.parse(to))||!!from&&!!to&&Date.parse(from)>Date.parse(to);
  const protectedChannel=channel.trim().toLowerCase()==='security'&&!securityAllowed;
  const submittedJob=submitted?jobs.find(job=>job.id===submitted.id):undefined;
  const accessibleSubmission=protectedChannel||submittedJob&&eventSecurity(submittedJob)&&!securityAllowed?null:submitted;
  const queryState=diagnosisQueryState(visibleJobs,'query-events',accessibleSubmission);
  const fetching=!queryState.timedOut&&((!loaded&&loading&&!failure)||busyKind==='query-events'||queryState.pending);
  const sameFilter=!!eventJob&&!!queries[eventJob.id]&&JSON.stringify(queries[eventJob.id])===JSON.stringify(parameters);
  const live=useRef({props,parameters,invalid:invalidIds||invalidDates||protectedChannel||!channel.trim(),fetching,busy,eventJob,queries,visibleJobs,detailJobId,detail,submit});
  live.current={props,parameters,invalid:invalidIds||invalidDates||protectedChannel||!channel.trim(),fetching,busy,eventJob,queries,visibleJobs,detailJobId,detail,submit};
  const canRequest=(kind:string)=>{const current=live.current,p=current.props;return p.server.id===server.id&&!p.server.revoked&&v3(p.server)&&permitted(p.server,p.viewer,'diagnose')&&!p.demo&&online(p.server)&&capability(p,kind)&&!current.invalid&&!current.fetching&&!current.busy;};
  /** Sends one event query and remembers its filter (without the cursor), so "Older events" only continues the same filter. */
  const send=async(params:Row)=>{
    try{const id=await live.current.submit('query-events',params);if(id&&live.current.props.server.id===server.id){const base={...params};delete base.cursor;setQueries(previous=>({...previous,[id]:base}));setResultFocus('all');}}catch{}
  };
  const query=async(next=false)=>{
    const current=live.current;if(!canRequest('query-events'))return;
    const params={...current.parameters};
    if(next){const job=current.eventJob;if(!job||job.data?.data.hasMore!==true||!job.data?.data.cursor||JSON.stringify(current.queries[job.id])!==JSON.stringify(current.parameters))return;params.cursor=job.data.data.cursor;}
    await send(params);
  };
  // "Try again" repeats the failed query with exactly its parameters; a failed read reloads the jobs.
  const retryFailed=()=>retry((kind,params)=>{if(kind==='query-events')void send(params);else void live.current.submit(kind,params).catch(()=>{});});
  const retryWait=()=>{if(!loaded){void load();return;}const params=lastParams('query-events');const p=live.current.props;if(params&&p.server.id===server.id&&online(p.server)&&capability(p,'query-events'))void send(params);};
  const exportEvents=async()=>{const current=live.current;if(!canRequest('export-events')||current.parameters.text)return;try{await current.submit('export-events',{filter:{...current.parameters},format:'evtx'});toast.success(t('console.jobCreated'));}catch{}};
  const supportBundle=async()=>{const current=live.current;if(!canRequest('support-bundle'))return;try{await current.submit('support-bundle',{channels:[current.parameters.channel],includeEvents:true});toast.success(t('console.jobCreated'));}catch{}};
  /** A template fills the fields as before and then runs its query once, with the same parameters the fields now describe. */
  const applyPreset=(preset:'recent'|'errors'|'restarts')=>{
    const current=live.current,p=current.props;
    if(p.server.id!==server.id||p.server.revoked||!v3(p.server)||!permitted(p.server,p.viewer,'diagnose')||p.demo||!online(p.server)||!capability(p,'query-events')||current.fetching||current.busy)return;
    const presetIds=preset==='restarts'?'41, 1074, 6005, 6006, 6008':'',presetLevel=preset==='errors'?'errors':'all',presetFrom=localDate(Date.now()-(preset==='restarts'?7:1)*86400000);
    setChannel('System');setProvider('');setText('');setTo('');setXml(false);setLevel(presetLevel);setIds(presetIds);setFrom(presetFrom);
    void send({channel:'System',provider:undefined,eventIds:presetIds.split(',').map(item=>item.trim()).filter(Boolean).map(Number),text:'',from:eventDate(presetFrom),to:undefined,levels:presetLevel==='errors'?[1,2]:[],limit:50,includeXml:false});
  };
  const clearFilters=()=>{setProvider('');setIds('');setText('');setFrom('');setTo('');setLevel('all');setXml(false);};
  const currentDetail=visibleJobs.find(job=>job.id===detailJobId&&job.data)?.data?.data;
  const readableDetail=detail&&Array.isArray(currentDetail?.events)&&currentDetail.events.some(row=>!!row&&typeof row==='object'&&(row as Row).recordId===detail.recordId)?detail:null;
  const liveDetail=()=>{const current=live.current,p=current.props;if(p.server.id!==server.id||!!p.server.revoked||!permitted(p.server,p.viewer,'diagnose')||p.demo||!current.detail)return null;const job=current.visibleJobs.find(item=>item.id===current.detailJobId);if(!job||eventSecurity(job)&&!permitted(p.server,p.viewer,'security.events'))return null;return rows(job,'events').find(row=>row.recordId===current.detail?.recordId)??null;};
  const copyDetails=async()=>{
    const current=liveDetail();if(!current)return;
    try{await navigator.clipboard.writeText(current.xml?String(current.xml):String(current.message??''));if(liveDetail()===current){if(copiedTimer.current)clearTimeout(copiedTimer.current);setCopied(true);copiedTimer.current=setTimeout(()=>{copiedTimer.current=null;setCopied(false);},1200);}}
    catch{toast.error(t('diagnostics.events.noClipboard'));}
  };
  const resultExport=(format:'json'|'csv')=>{const current=live.current;if(current.props.server.id!==server.id||!!current.props.server.revoked||!permitted(current.props.server,current.props.viewer,'diagnose')||current.props.demo)return;const job=current.eventJob,list=rows(job,'events');if(!job||!list.length||eventSecurity(job)&&!permitted(current.props.server,current.props.viewer,'security.events'))return;const name=`ServerDesk-${current.props.server.name}-${String(job.data?.data.channel??t('device.area.events'))}.${format}`;if(format==='json')downloadText(name,JSON.stringify(list,null,2));else downloadText(name,['at;level;id;provider;message',...list.map(row=>['at','level','id','provider','message'].map(key=>csvField(row[key])).join(';'))].join('\r\n'),'text/csv');toast.success(t('diagnostics.export.done'));};
  const exports=visibleJobs.filter(job=>['export-events','support-bundle'].includes(job.kind)&&job.state==='succeeded'&&job.data?.data.file);
  // The crash list and the reliability card come from the snapshot: every viewer of the device sees them, also without diagnose.
  if(reason)return <><CrashList server={server}/><ReliabilityCard server={server} now={now}/><Unavailable reason={reason}>{reason==='right'?t('diagnostics.blocked.right'):undefined}</Unavailable></>;
  const invalidFilter=invalidIds?t('diagnostics.events.idsInvalid'):invalidDates?t('diagnostics.events.rangeInvalid'):!channel.trim()?t('diagnostics.events.channelMissing'):undefined;
  const deviceBlocked=(kind:string)=>!online(server)?t('management.blocked.offline'):!capability(props,kind)?t('kit.unavailable.agent'):protectedChannel?t('diagnostics.events.securityRight'):invalidFilter;
  // An agent job waits for a running query or action, like the query itself; the entry says why.
  const jobBlocked=(kind:string)=>deviceBlocked(kind)??(fetching||busy?t('diagnostics.busy'):undefined);
  const queryBlocked=deviceBlocked('query-events');
  // A template sets its own fields (the System log), so only the device, the agent and a running request block it.
  const templateBlocked=!online(server)?t('management.blocked.offline'):!capability(props,'query-events')?t('kit.unavailable.agent'):fetching||busy?t('diagnostics.busy'):undefined;
  const noResults=events.length?undefined:t('diagnostics.export.noResults');
  const exportEntries:MenuEntry[]=[
    {id:'csv',label:t('diagnostics.export.csv'),icon:FileText,blocked:noResults,onSelect:()=>resultExport('csv')},
    {id:'json',label:t('diagnostics.export.json'),icon:FileText,blocked:noResults,onSelect:()=>resultExport('json')},
    {id:'device',separator:true},
    {id:'evtx',label:t('diagnostics.export.evtx'),icon:Download,blocked:text?t('diagnostics.export.evtxNoText'):jobBlocked('export-events'),onSelect:()=>void exportEvents()},
    {id:'bundle',label:t('diagnostics.export.bundle'),icon:Package,blocked:jobBlocked('support-bundle'),onSelect:()=>void supportBundle()},
  ];
  // Without a result and without an export capability every entry is blocked: the button says why and opens nothing.
  const exportBlocked=!events.length&&!capability(props,'export-events')&&!capability(props,'support-bundle')?t('diagnostics.export.noResults'):undefined;
  const exportButton=exportBlocked?<IconBtn icon={Download} label={t('diagnostics.events.export')} blocked={exportBlocked}/>
    :<Menu label={t('diagnostics.events.export')} entries={exportEntries} trigger={<IconBtn icon={Download} label={t('diagnostics.events.export')}/>}/>;
  const columns:DataColumn<Row&{index:number}>[]=[
    {id:'time',label:t('audit.time'),mono:true,cell:row=>row.at?exactTime(String(row.at),locale):EMPTY_VALUE},
    {id:'level',label:t('diagnostics.events.level'),cell:row=><StatusPill kind={levelKind(row)}>{value(row,'level')}</StatusPill>},
    {id:'source',label:t('diagnostics.events.source'),primary:true,cell:row=>value(row,'provider')},
    {id:'id',label:t('diagnostics.col.id'),mono:true,align:'end',cell:row=>value(row,'id')},
    {id:'message',label:t('diagnostics.kind.message'),wrap:true,hideBelow:900,cell:row=><span className="sdx-dx-message">{value(row,'message')}</span>},
  ];
  const hasMore=eventJob?.data?.data.hasMore===true;
  const olderBlocked=!hasMore?t('diagnostics.events.end'):!sameFilter?t('diagnostics.events.filterChanged'):queryBlocked;
  const resultEmpty=events.length?{icon:Search,title:t('diagnostics.events.noneFilter'),action:<Btn size="sm" icon={X} onClick={()=>setResultFocus('all')}>{t('fleet.empty.resetFilter')}</Btn>}:{icon:FileText,title:t('diagnostics.events.none')};
  return <div className="sdx-dx">
    <CrashList server={server}/>
    <ReliabilityCard server={server} now={now}/>
    {failure&&<FailureNotice error={failure.error} stale={events.length>0} onRetry={retryFailed}/>}
    {queryState.timedOut&&<SlowNotice text={t('diagnostics.events.slow')} onRetry={retryWait}/>}
    <Card title={t('diagnostics.events.title')} icon={FileText} iconTone="accent" description={t('diagnostics.events.subtitle')} actions={exportButton} flush className="sdx-dx-card sdx-dx-events">
      <form className="sdx-dx-event-query" onSubmit={event=>{event.preventDefault();void query();}}>
        <div className="sdx-dx-presets" role="group" aria-label={t('diagnostics.events.templates')}>
          <Btn variant="ghost" size="sm" blocked={templateBlocked} onClick={()=>applyPreset('recent')}>{t('drift.last24h')}</Btn>
          <Btn variant="ghost" size="sm" blocked={templateBlocked} onClick={()=>applyPreset('errors')}>{t('diagnostics.events.errors24')}</Btn>
          <Btn variant="ghost" size="sm" blocked={templateBlocked} onClick={()=>applyPreset('restarts')}>{t('diagnostics.events.boots7')}</Btn>
        </div>
        <div className="sdx-dx-event-fields">
          <Field label={t('diagnostics.events.channel')}><SuggestInput aria-label={t('diagnostics.events.channelLabel')} value={channel} onValueChange={setChannel} maxLength={200} options={['System','Application','Windows PowerShell','Microsoft-Windows-TaskScheduler/Operational',...(securityAllowed?['Security']:[])]}/></Field>
          <Field label={t('diagnostics.events.level')}><Select aria-label={t('diagnostics.events.levelLabel')} value={level} onChange={event=>setLevel(event.target.value)}><option value="all">{t('diagnostics.events.allLevels')}</option><option value="errors">{t('diagnostics.events.criticalErrors')}</option><option value="3">{t('hardware.warning')}</option><option value="4">{t('diagnostics.events.information')}</option><option value="5">{t('diagnostics.events.verbose')}</option></Select></Field>
          <Field label={t('diagnostics.events.messageContains')}><input aria-label={t('diagnostics.events.textFilter')} value={text} onChange={event=>setText(event.target.value)} maxLength={200} placeholder={t('diagnostics.events.searchText')}/></Field>
          <Btn type="submit" variant="primary" icon={Search} loading={fetching} blocked={queryBlocked} disabled={busy&&busyKind!=='query-events'}>{t('diagnostics.connections.query')}</Btn>
        </div>
        <details className="sdx-dx-details sdx-dx-advanced"><summary>{t('diagnostics.events.advanced')}{(provider||ids||from||to||xml)&&<span>{[provider?t('diagnostics.events.source'):null,ids?'IDs':null,from||to?t('device.summary.range'):null,xml?'XML':null].filter(Boolean).join(' · ')}</span>}</summary>
          <div className="sdx-dx-event-fields">
            <Field label={t('diagnostics.events.from')}><input aria-label={t('diagnostics.events.fromLabel')} type="datetime-local" value={from} onChange={event=>setFrom(event.target.value)}/></Field>
            <Field label={t('diagnostics.events.to')}><input aria-label={t('diagnostics.events.toLabel')} type="datetime-local" value={to} onChange={event=>setTo(event.target.value)}/></Field>
            <Field label={t('diagnostics.events.source')}><input aria-label={t('diagnostics.events.sourceLabel')} value={provider} onChange={event=>setProvider(event.target.value)} placeholder={t('diagnostics.events.sourcePlaceholder')} maxLength={200}/></Field>
            <Field label={t('diagnostics.events.ids')}><input aria-label={t('diagnostics.events.ids')} value={ids} onChange={event=>setIds(event.target.value)} placeholder="41, 6008"/></Field>
            <label className="sdx-dx-switch"><input aria-label={t('diagnostics.events.includeXml')} type="checkbox" role="switch" checked={xml} onChange={event=>setXml(event.target.checked)}/>{t('diagnostics.events.includeXml')}</label>
            <Btn variant="ghost" size="sm" icon={X} onClick={clearFilters}>{t('fleet.empty.resetFilter')}</Btn>
          </div>
        </details>
        {invalidIds&&<p role="alert" className="sdx-field-error">{t('diagnostics.events.idsInvalid')}</p>}{invalidDates&&<p role="alert" className="sdx-field-error">{t('diagnostics.events.rangeInvalid')}</p>}{protectedChannel&&<p role="alert" className="sdx-field-error">{t('diagnostics.events.securityRight')}</p>}
      </form>
      {fetching&&!eventJob?<div className="sdx-dx-card-body"><FirstLoad label={t('diagnostics.events.loading')} onRetry={retryWait}/></div>
      :eventJob?<>
        <div className="sdx-dx-result-head">
          <p className="sdx-dx-meta"><strong>{value(eventJob.data?.data??{},'channel')}</strong><span>{stamp(eventJob.data?.at,locale)}{!online(server)?<> · {t('diagnostics.events.saved')}</>:''}{!sameFilter?<> · {t('diagnostics.events.lastQuery')}</>:''}</span></p>
          <Segmented<EventFocus> size="sm" label={t('diagnostics.events.filterResults')} value={resultFocus} onChange={setResultFocus} items={[{id:'all',label:t('diagnostics.events.theseResults'),count:events.length},{id:'errors',label:t('diagnostics.events.criticalErrors'),count:counts.errors,tone:counts.errors?'critical':undefined},{id:'warnings',label:t('diagnostics.events.warnings'),count:counts.warnings,tone:counts.warnings?'warning':undefined}]}/>
        </div>
        <DataTable<Row&{index:number}> variant="flush" label={value(eventJob.data?.data??{},'channel')} entranceId={'diagnostics-events:'+server.id} cards columns={columns} rows={matching.map((row,index)=>({...row,index}))} busy={fetching}
          rowKey={row=>`${value(row,'recordId')}-${row.index}`} onOpen={openDetail} openLabel={row=>t('diagnostics.events.openEvent',{value:value(row,'id')})} empty={resultEmpty}
          foot={<><span>{typeof eventJob.data?.data.scanned==='number'?t('diagnostics.events.hitsScanned',{hits:events.length,scanned:eventJob.data.data.scanned}):t('diagnostics.events.hits',{hits:events.length})} · {hasMore?t('diagnostics.events.more'):t('diagnostics.events.end')}</span> <Btn size="sm" loading={fetching} blocked={olderBlocked} disabled={busy&&busyKind!=='query-events'} onClick={()=>void query(true)}>{t('diagnostics.events.older')}</Btn></>}/>
      </>
      :<div className="sdx-dx-card-body">{!online(server)?<Empty icon={FileText} title={t('storage.blocked.offline')}>{t('diagnostics.events.noSaved')}</Empty>:<Empty icon={FileText} title={t('diagnostics.events.chooseLog')}>{t('diagnostics.events.start')}</Empty>}</div>}
      {exports.length>0&&<div className="sdx-dx-exports">{exports.slice(0,3).map(job=>{const file=job.data!.data.file as Row;return <details key={job.id} className="sdx-dx-details"><summary>{value(file,'name')} · {formatBytes(locale,measuredValue(file.size))}</summary><p className="mono">{value(file,'path')}</p><p className="sdx-dx-note">{t('diagnostics.export.download',{stamp:stamp(String(file.expiresAt),locale)})}</p></details>;})}</div>}
      <JobStatus jobs={visibleJobs} server={server} kinds={['query-events','export-events','support-bundle']}/>
    </Card>
    <Drawer open={!!readableDetail} onClose={()=>setDetail(null)} title={readableDetail?t('diagnostics.events.event',{value:value(readableDetail,'id')}):t('drift.event')} description={readableDetail?`${value(readableDetail,'provider')} · ${server.name}`:undefined}
      footer={readableDetail&&<>
        <Btn size="sm" icon={copied?Check:Copy} onClick={()=>void copyDetails()}>{readableDetail.xml?t('diagnostics.events.copyXml'):t('diagnostics.copyMessage')}</Btn>
        <Btn size="sm" icon={Download} onClick={()=>{const current=liveDetail();if(current)downloadText(`ServerDesk-${live.current.props.server.name}-event-${value(current,'recordId')}.json`,JSON.stringify(current,null,2));}}>{t('diagnostics.json')}</Btn>
      </>}>
      {readableDetail&&<EventDetail row={readableDetail} channel={detailChannel} locale={locale}/>}
    </Drawer>
  </div>;
}

function EventDetail({row,channel,locale}:{row:Row;channel:string;locale:Locale}){
  const t=useT();
  const facts:FactItem[]=[{id:'time',label:t('audit.time'),value:stamp(String(row.at??''),locale)},{id:'level',label:t('diagnostics.events.level'),value:<StatusPill kind={levelKind(row)}>{value(row,'level')}</StatusPill>},{id:'channel',label:t('diagnostics.events.channel'),value:channel},{id:'record',label:t('diagnostics.col.recordId'),value:value(row,'recordId'),mono:true}];
  const body:ReactNode=row.xml?<><h3 className="sdx-dx-drawer-heading">{t('diagnostics.xml')}</h3>{row.xmlTruncated===true&&<p className="sdx-dx-note">{t('diagnostics.events.xmlLimited')}</p>}<pre className="sdx-dx-output mono">{String(row.xml)}</pre></>:<p className="sdx-dx-note">{t('diagnostics.events.xmlHint')}</p>;
  return <>
    <Facts items={facts}/>
    <h3 className="sdx-dx-drawer-heading">{t('diagnostics.kind.message')}</h3>
    <p className="sdx-dx-event-message">{value(row,'message')}</p>
    {body}
  </>;
}

