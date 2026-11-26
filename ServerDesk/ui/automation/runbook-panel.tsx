'use client';
// Runbooks on the console kit: the device's Automation → Runbooks tab (serverId given) and the Runbooks page of
// Automation (view given: the page's tab bar picks the library, runs or schedules view and the panel renders no tab
// bar of its own). The panel reads GET /api/runbooks every 5 s (scope key, sequence and abort guards), shows the
// catalog, runs and schedules as DataTables, prepares a run in a wide Drawer, confirms runs, schedules, stops and
// deletes in the kit ConfirmDialog and shows a run's output in the kit Drawer. A new runbook opens "Prepare" with
// its returned version. Request bodies and the step-up retry (retryAction + MfaStepUp) are those of the classic panel.
import {opensMfaPrompt} from '@/lib/errors/codes';
import {useState,useEffect,useCallback,useId,useRef} from 'react';
import {toast} from 'sonner';
import {AlertTriangle,BookOpen,CalendarClock,FileText,History,Play,Plus,RefreshCw,ShieldCheck,Square,Trash2} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import {api,message,stamp,permitted,v3,ApiError,type Device} from '@/ui/base/api';
import {isOwner} from '@/ui/base/access-capabilities';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import RunbookEditor,{type RunbookStep as Step} from '@/ui/automation/runbook-editor';
import {catalogCreateLockReason,catalogOwnerChoices,catalogOwnerLabel,catalogOwnerRequest,catalogOwnerText,defaultCatalogOwner,fitsCatalogOwner,showCatalogOwner,type CatalogOwnership} from '@/ui/base/catalog-owner';
import {crossCustomerHint,crossCustomerLockReason,scheduleCustomerLockReason,targetCustomerCount} from '@/ui/base/cross-customer';
import {agentMessageText} from '@/lib/agent-messages';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {Btn,Card,Drawer,IconBtn,Menu,Notice,SectionHead,Skeleton,StatusPill,Unavailable,type MenuEntry,type StatusKind} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {Tabs,tabId} from '@/ui/kit/tabs';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {Field,Select} from '@/ui/kit/field';
import {RunbookSchedules} from '@/ui/automation/runbook-schedules';
import type {AssignmentSchedule} from '@/ui/automation/automation-data';
import '@/ui/base/catalog-owner.css';
import '@/ui/automation/runbooks.css';
import {useLocale,useT,useStableT} from '@/ui/base/locale';
import {agentModeLabel} from '@/ui/base/agent-mode';
import {messageFieldsText,serverMessageText,type ServerMessage} from '@/lib/server-messages';
import {EMPTY_VALUE} from '@/lib/i18n/format';
type Parameter={name:string;type:'string'|'number'|'boolean';required:boolean;secret:boolean;default?:string|number|boolean};
type Definition={steps:Step[];parameters:Parameter[];description?:string};
type Version={id:string;version:number;createdAt:number;definition:Definition;sourceRedacted?:boolean};
type Runbook={id:string;name:string;description:string;canManage:boolean;canDelete:boolean;deleteReason?:ServerMessage;versions:Version[];customerId?:string|null;customerName?:string|null};
type Run={id:string;versionId:string;runbookName?:string;runbookArchived?:number;state:string;createdAt:number;devices:{serverId:string;state:string;stepIndex:number;jobId:string;result:string|null;resultCode?:string|null;resultArgs?:Record<string,string>|null;outputRedacted?:boolean;steps?:{stepIndex:number;jobId:string;state:string;result:string|null;resultCode?:string|null;resultArgs?:Record<string,string>|null;createdAt:number;completedAt:number|null;outputRedacted?:boolean;output?:{output:string;stderr:string;exitCode:number;truncated:boolean;scope?:{security?:boolean}}}[]}[]};
type Schedule={id:string;versionId:string;runbookName?:string;runbookArchived?:number;targets:string[];nextDue:number;recurrence:Record<string,unknown>;enabled:boolean;catchupSeconds:number};
type Data={runbooks:Runbook[];runs:Run[];schedules:Schedule[];catalog?:CatalogOwnership};
type Preview={targets:{serverId:string;name:string;online:boolean;mode:string;steps:unknown[];preconditionErrors:ServerMessage[]}[];warnings:ServerMessage[];version:number};
export type RunbookTab='runbooks'|'runs'|'schedules';
/** The sizes of the loaded lists, for the tab counts of the Runbooks page. */
export type RunbookCounts={runbooks:number;runs:number;schedules:number};
const finished=['succeeded','failed','cancelled','expired'];
/** The pill of a run state: success, failure, still going, or neutral. */
export const runPillKind=(state:string):StatusKind=>state==='succeeded'?'success':state==='failed'?'critical':state==='running'||state==='queued'?'warning':'neutral';
export default function RunbookPanel({servers,viewer,demo,serverId,initialTab='runbooks',initialRunId,view,assignmentSchedules=[],onShowAssignment,onShowLibrary,onCounts,createRequest=0,onEditorChange}:{servers:Device[];viewer:Viewer;demo:boolean;serverId?:string;initialTab?:RunbookTab;initialRunId?:string;
 /** The Runbooks page: the view its tab bar shows (null: another tab of the page, the panel renders nothing but keeps loading). Without it the panel shows its own tabs. */
 view?:RunbookTab|null;
 /** The runbook assignments that run on a recurrence, listed next to the schedules (library view only). */
 assignmentSchedules?:readonly AssignmentSchedule[];onShowAssignment?:(assignmentId:string)=>void;onShowLibrary?:()=>void;
 /** Gets the list sizes after every load. */
 onCounts?:(counts:RunbookCounts)=>void;
 /** A new number opens the editor for a new runbook (the page primary "Create runbook"). */
 createRequest?:number;
 /** Whether the editor is open; the page leaves out its primary while it is. */
 onEditorChange?:(open:boolean)=>void}){
 const t=useT(),stableT=useStableT(),[locale]=useLocale(),panelId=useId();
 const scopeKey=JSON.stringify([serverId??'all',viewer.id,isOwner(viewer),servers.map(s=>[s.id,s.permissions??[]])]);
 const controlled=view!==undefined;
 const [dataScope,setDataScope]=useState('');
 const [ownTab,setTab]=useState<RunbookTab>(initialRunId?'runs':initialTab),[selectedRun,setSelectedRun]=useState<string|null>(initialRunId??null);
 const [data,setData]=useState<Data|null>(null),[runDetails,setRunDetails]=useState<Record<string,Run>>({}),[error,setError]=useState(''),[detailError,setDetailError]=useState(''),[editorError,setEditorError]=useState(''),[busy,setBusy]=useState(false),[refreshing,setRefreshing]=useState(false);
 const [bookId,setBookId]=useState(''),[preparing,setPreparing]=useState(false),[versionId,setVersionId]=useState(''),[targets,setTargets]=useState<string[]>(serverId?[serverId]:[]),[parameters,setParameters]=useState<Record<string,string>>({}),[preview,setPreview]=useState<Preview|null>(null),[mfa,setMfa]=useState(false),[confirmation,setConfirmation]=useState<'run'|'schedule'|null>(null),[deleteBook,setDeleteBook]=useState<Runbook|null>(null),[stopRun,setStopRun]=useState<Run|null>(null);
 const [editor,setEditor]=useState(false),[editId,setEditId]=useState(''),[name,setName]=useState(''),[description,setDescription]=useState(''),[steps,setSteps]=useState<Step[]>([{id:'health',name:t('runbooks.defaultStep'),kind:'diagnosis',operation:'refresh',operationParameters:{},timeoutSeconds:60}]),[parameterSpec,setParameterSpec]=useState('[]'),[owner,setOwner]=useState('');
 const [concurrency,setConcurrency]=useState(1),[failureStop,setFailureStop]=useState(true),[scheduled,setScheduled]=useState(false),[scheduleKind,setScheduleKind]=useState('daily'),[dailyTime,setDailyTime]=useState('02:00'),[minutes,setMinutes]=useState(60),[catchup,setCatchup]=useState(3600);
 const retryAction=useRef<(()=>Promise<void>)|null>(null),handledCreate=useRef(createRequest);
 const currentScope=useRef(scopeKey);currentScope.current=scopeKey;
 const reads=useRef({sequence:0,detailSequence:0,controller:null as AbortController|null,detailController:null as AbortController|null});
 // Device scope: the one concrete reason the tab cannot be used. Library scope: only the sample data.
 const device=serverId?servers.find(s=>s.id===serverId):undefined;
 const reason=serverId?unavailableReason({demo,revoked:!!device?.revoked,permitted:!!device&&['runbooks.read','runbooks.execute','runbooks.manage'].some(right=>permitted(device,viewer,right)),reported:!!device?.snapshot,supported:!!device&&v3(device)}):demo?'demo':null;
 const load=useCallback(async()=>{
  if(reason||currentScope.current!==scopeKey)return;const sequence=++reads.current.sequence,controller=new AbortController();reads.current.controller?.abort();reads.current.controller=controller;
  try{const next=await api<Data>('/api/runbooks'+(serverId?'?serverId='+encodeURIComponent(serverId):''),undefined,controller.signal);if(controller.signal.aborted||reads.current.sequence!==sequence||currentScope.current!==scopeKey)return;setData(next);setDataScope(scopeKey);setError('');}
  catch(e){if(controller.signal.aborted||reads.current.sequence!==sequence||currentScope.current!==scopeKey)return;setError(message(e));if(e instanceof ApiError&&[401,403].includes(e.status)){setData(null);setRunDetails({});setSelectedRun(null);}}
 },[reason,serverId,scopeKey]);
 useEffect(()=>{setError('');setRunDetails({});setSelectedRun(initialRunId??null);setBookId('');setPreparing(false);setVersionId('');setParameters({});setPreview(null);setConfirmation(null);setDeleteBook(null);setStopRun(null);setEditor(false);setMfa(false);retryAction.current=null;void load();const timer=reason?undefined:setInterval(()=>void load(),5000);const requests=reads.current;return()=>{clearInterval(timer);requests.sequence++;requests.detailSequence++;requests.controller?.abort();requests.detailController?.abort();};},[load,reason,scopeKey,initialRunId,retryAction]);
 const visibleData=dataScope===scopeKey?data:null;
 // The page's tab counts and its primary follow the loaded lists and the editor.
 useEffect(()=>{if(visibleData)onCounts?.({runbooks:visibleData.runbooks.length,runs:visibleData.runs.length,schedules:visibleData.schedules.length});},[visibleData,onCounts]);
 useEffect(()=>{onEditorChange?.(editor);},[editor,onEditorChange]);
 const book=visibleData?.runbooks.find(b=>b.id===bookId),version=book?.versions.find(v=>v.id===versionId),available=servers.filter(s=>v3(s)&&(permitted(s,viewer,'runbooks.execute')||permitted(s,viewer,'runbooks.manage'))&&fitsCatalogOwner(book?.customerId,s.customerId));
 const catalog=visibleData?.catalog,showOwner=showCatalogOwner(catalog),createLock=catalogCreateLockReason(catalog,locale);
 // Targets of two or more customers need the cross-customer right; a schedule serves one customer.
 const customerCount=targetCustomerCount(servers,targets),crossLock=crossCustomerLockReason(viewer,customerCount,locale),startLock=scheduled?scheduleCustomerLockReason(customerCount,locale):crossLock;
 const requestParameters=()=>{const values:Record<string,unknown>={},secrets:Record<string,string>={};for(const p of version?.definition.parameters??[]){const raw=parameters[p.name]??String(p.default??'');if(p.secret){if(raw)secrets[p.name]=raw;continue;}if(!raw&&!p.required)continue;values[p.name]=p.type==='number'?Number(raw):p.type==='boolean'?raw==='true':raw;}return{parameters:values,secrets};};
 const payload=()=>({versionId,targets,...requestParameters(),concurrency,failureStop});
 const dryrun=async()=>{setBusy(true);try{setPreview(await api<Preview>('/api/runbooks',{action:'dryrun',...payload()}));}catch(e){toast.error(message(e));}finally{setBusy(false);}};
 const execute=async()=>{if(!confirmation)return;setBusy(true);const action=confirmation;try{const recurrence=scheduleKind==='daily'?{kind:'daily',timeZone:'Europe/Berlin',hour:Number(dailyTime.split(':')[0]),minute:Number(dailyTime.split(':')[1]),weekdays:[0,1,2,3,4,5,6]}:{kind:'interval',minutes};await api('/api/runbooks',{action,...payload(),confirm:true,...(action==='schedule'?{recurrence,catchupSeconds:catchup}:{})});retryAction.current=null;setConfirmation(null);setPreview(null);setParameters({});setPreparing(false);toast.success(action==='schedule'?t('runbooks.toast.scheduled'):t('runbooks.toast.started'));await load();}catch(e){if(e instanceof ApiError&&opensMfaPrompt(e.code)){retryAction.current=execute;setMfa(true);}else toast.error(message(e));}finally{setBusy(false);}};
 // A new runbook: the editor closes, its row is highlighted and "Prepare" opens with the returned version, also before the list has it.
 // A new version of a runbook: the editor closes and the row is highlighted.
 const save=async()=>{setBusy(true);setEditorError('');try{const spec=JSON.parse(parameterSpec) as Parameter[];if(!Array.isArray(spec))throw new Error(t('runbooks.params.notList2'));const created=await api<{id?:string;versionId?:string}>('/api/runbooks',{action:'create-version',...(editId?{runbookId:editId}:catalogOwnerRequest(catalog,owner)),name,description,definition:{steps,parameters:spec}});retryAction.current=null;setEditor(false);
  if(!editId&&created?.id){setBookId(created.id);setVersionId(created.versionId??'');setTargets(serverId?[serverId]:[]);setParameters({});setPreview(null);setScheduled(false);setPreparing(true);onShowLibrary?.();toast.success(t('runbooks.toast.created'));}
  else{setBookId(editId);setPreparing(false);toast.success(t('runbooks.toast.versionSaved'));}
  await load();}catch(e){const text=message(e);setEditorError(text);if(e instanceof ApiError&&opensMfaPrompt(e.code)){retryAction.current=save;setMfa(true);}}finally{setBusy(false);}};
 // "Stop run": the request goes out only on confirm; a failure keeps the dialog open.
 const stop=async()=>{if(!stopRun)return;setBusy(true);try{await api('/api/runbooks',{action:'cancel',runId:stopRun.id});setStopRun(null);toast.success(t('runbooks.toast.stopped'));await load();}catch(e){toast.error(message(e));}finally{setBusy(false);}};
 const turnOff=async(id:string)=>{setBusy(true);try{await api('/api/runbooks',{action:'cancel-schedule',scheduleId:id});toast.success(t('runbooks.toast.scheduleOff'));await load();}catch(e){toast.error(message(e));}finally{setBusy(false);}};
 const loadDetails=useCallback(async(id:string)=>{
  const sequence=++reads.current.detailSequence,controller=new AbortController();reads.current.detailController?.abort();reads.current.detailController=controller;
  try{const p=await api<Data>('/api/runbooks?runId='+encodeURIComponent(id)+(serverId?'&serverId='+encodeURIComponent(serverId):''),undefined,controller.signal);if(controller.signal.aborted||reads.current.detailSequence!==sequence||currentScope.current!==scopeKey)return;const detailed=p.runs.find(r=>r.id===id);if(!detailed)throw new Error(stableT('runbooks.runUnavailable'));setRunDetails(current=>({...current,[scopeKey+'|'+id]:detailed}));setDetailError('');}
  catch(e){if(controller.signal.aborted||reads.current.detailSequence!==sequence||currentScope.current!==scopeKey)return;setDetailError(message(e));if(e instanceof ApiError&&[401,403].includes(e.status)){setData(null);setDataScope('');setRunDetails({});setSelectedRun(null);}}
 },[serverId,scopeKey,stableT]);
 const selectBook=(id:string)=>{setBookId(id);const next=visibleData?.runbooks.find(b=>b.id===id),v=next?.versions[0];setTargets(current=>current.filter(target=>fitsCatalogOwner(next?.customerId,servers.find(s=>s.id===target)?.customerId)));setVersionId(v?.id??'');setParameters({});setPreview(null);setPreparing(true);setTab('runbooks');};
 const edit=(b?:Runbook)=>{setEditorError('');setSelectedRun(null);setPreparing(false);const v=b?.versions[0];setEditId(b?.id??'');setOwner(b?'':defaultCatalogOwner(catalog));setName(b?.name??'');setDescription(b?.description??'');setSteps(v?.definition.steps??[{id:'health',name:t('runbooks.defaultStep'),kind:'diagnosis',operation:'refresh',operationParameters:{},timeoutSeconds:60}]);setParameterSpec(JSON.stringify(v?.definition.parameters??[],null,2));setEditor(true);};
 // The page primary "Create runbook" asks for the editor with a new number; a request seen at mount opens nothing.
 useEffect(()=>{if(!createRequest||createRequest===handledCreate.current)return;handledCreate.current=createRequest;edit();},[createRequest]);// eslint-disable-line react-hooks/exhaustive-deps -- Only a new request opens the editor; edit reads the latest catalog.
 const applyTemplate=(kind:string)=>{if(editId)setOwner(defaultCatalogOwner(catalog));setEditId('');const diagnosis=(id:string,title:string,operation:string):Step=>({id,name:title,kind:'diagnosis',operation,operationParameters:{},timeoutSeconds:120});if(kind==='health'){setName(t('runbooks.tpl.health'));setDescription(t('runbooks.tpl.healthHint'));setSteps([diagnosis('inventory',t('management.action.refresh'),'refresh'),diagnosis('updates',t('runbooks.tpl.checkUpdates'),'scan-updates')]);setParameterSpec('[]');}else if(kind==='updates'){setName(t('runbooks.diagnosis.scanUpdates'));setDescription(t('runbooks.tpl.updatesHint'));setSteps([diagnosis('updates',t('runbooks.tpl.checkUpdates'),'scan-updates')]);setParameterSpec('[]');}else if(kind==='dns'){setName(t('runbooks.tpl.dns'));setDescription(t('runbooks.tpl.dnsHint'));setSteps([{id:'dns',name:t('runbooks.tpl.dnsStep'),kind:'powershell',timeoutSeconds:120,script:"param([Parameter(Mandatory=$true)][string]$DnsName)\nResolve-DnsName -Name $DnsName -ErrorAction Stop | Format-Table\nTest-NetConnection -ComputerName $DnsName -Port 53 | Format-List"}]);setParameterSpec(JSON.stringify([{name:'DnsName',type:'string',required:true,secret:false}],null,2));}else if(kind==='services'){setName(t('runbooks.tpl.services'));setDescription(t('runbooks.tpl.servicesHint'));setSteps([{id:'services',name:t('runbooks.tpl.serviceStatus'),kind:'powershell',timeoutSeconds:60,script:"param([string]$ServiceNames='W32Time,Dnscache')\nGet-Service -Name ($ServiceNames.Split(',') | ForEach-Object { $_.Trim() }) -ErrorAction Stop | Select-Object Name, DisplayName, Status, StartType | Format-Table -AutoSize"}]);setParameterSpec(JSON.stringify([{name:'ServiceNames',type:'string',required:true,secret:false,default:'W32Time,Dnscache'}],null,2));}else if(kind==='maintenance'){setName(t('runbooks.tpl.maintenance'));setDescription(t('runbooks.tpl.maintenanceHint'));setSteps([{id:'before',name:t('runbooks.tpl.checkBefore'),kind:'powershell',timeoutSeconds:60,script:"param([Parameter(Mandatory=$true)][string]$ServiceName)\nGet-Service -Name $ServiceName -ErrorAction Stop | Format-List Name, Status, StartType"},{id:'restart',name:t('management.action.restartService'),kind:'powershell',timeoutSeconds:180,script:"param([Parameter(Mandatory=$true)][string]$ServiceName)\nRestart-Service -Name $ServiceName -ErrorAction Stop\nWrite-Output 'Service restarted.'"},{id:'after',name:t('runbooks.tpl.checkAfter'),kind:'powershell',timeoutSeconds:60,script:"param([Parameter(Mandatory=$true)][string]$ServiceName)\n$service = Get-Service -Name $ServiceName -ErrorAction Stop\n$service | Format-List Name, Status, StartType\nif ($service.Status -ne 'Running') { throw 'The service is not running after the maintenance.' }"}]);setParameterSpec(JSON.stringify([{name:'ServiceName',type:'string',required:true,secret:false}],null,2));}};
 useEffect(()=>{if(!selectedRun||reason)return;setDetailError('');void loadDetails(selectedRun);const timer=setInterval(()=>void loadDetails(selectedRun),5000);const requests=reads.current;return()=>{clearInterval(timer);requests.detailSequence++;requests.detailController?.abort();};},[selectedRun,reason,loadDetails]);
 useEffect(()=>{if(initialRunId){setTab('runs');setSelectedRun(initialRunId);}},[initialRunId,serverId]);
 const scopedRun=visibleData?.runs.find(r=>r.id===selectedRun);const detailRun=selectedRun?runDetails[scopeKey+'|'+selectedRun]:undefined;const baseRun=scopedRun??(visibleData?detailRun:undefined);
 const currentRun=baseRun?{...baseRun,devices:baseRun.devices.map(entry=>({...entry,steps:entry.steps?.map(step=>{const detail=detailRun?.devices.find(d=>d.serverId===entry.serverId)?.steps?.find(d=>d.jobId===step.jobId);return {...step,...(!step.outputRedacted&&detail?.output?{output:detail.output}:{})};})}))}:null;
 const runName=(id:string)=>visibleData?.runbooks.find(b=>b.versions.some(v=>v.id===id))?.name??visibleData?.runs.find(r=>r.versionId===id)?.runbookName??visibleData?.schedules.find(s=>s.versionId===id)?.runbookName??'Runbook';
 const remove=async()=>{if(!deleteBook)return;const removing=deleteBook;setBusy(true);try{const result=await api<{message?:string;messageKey?:string}>('/api/runbooks',{action:'delete',runbookId:removing.id,confirm:true});retryAction.current=null;setDeleteBook(null);if(bookId===removing.id){setBookId('');setPreparing(false);setVersionId('');setPreview(null);setParameters({});}if(editId===removing.id){setEditor(false);setEditId('');}const notice=messageFieldsText(result,t,'');if(notice)toast.success(notice);await load();}catch(e){if(e instanceof ApiError&&['MFA_LOGIN_REQUIRED','SESSION_EXPIRED'].includes(e.code??'')){retryAction.current=remove;setMfa(true);}else toast.error(message(e));}finally{setBusy(false);}};
 const mayCreate=isOwner(viewer)||servers.some(s=>permitted(s,viewer,'runbooks.manage'));
 const stateLabel=(state:string)=>(({queued:t('jobs.state.pending'),running:t('jobs.state.running'),scheduled:t('jobs.state.scheduled'),succeeded:t('jobs.state.succeeded'),failed:t('jobs.state.failed'),cancelled:t('jobs.state.cancelled'),expired:t('jobs.state.expired'),interrupted:t('jobs.state.unknown'),unknown:t('services.unknown')} as Record<string,string>)[state]??state);
 const openRun=(id:string)=>{setDetailError('');setSelectedRun(id);};
 const refresh=async()=>{setRefreshing(true);try{await load();}finally{setRefreshing(false);}};
 const busyReason=busy||mfa?t('automation.busy'):undefined;
 const createBlocked=!mayCreate?t('runbooks.blocked.manage'):createLock||busyReason;
 const createButton=(variant:'primary'|'secondary')=><Btn variant={variant} icon={Plus} blocked={createBlocked||undefined} onClick={()=>edit()}>{t('runbooks.create')}</Btn>;
 // The device tab has its own head with the primary; on the Runbooks page the page header holds the title and the primary.
 const head=controlled?null:<SectionHead title={t('device.section.runbooks')} hideTitle description={serverId?t('runbooks.description.device'):t('runbooks.description.library')}
  actions={!reason&&!editor&&<IconBtn icon={RefreshCw} label={t('network.refresh')} loading={refreshing} blocked={busyReason} onClick={()=>void refresh()}/>} primary={!reason&&!editor&&createButton('primary')}/>;
 if(view===null)return null;
 if(reason)return <div className="sdx-panel-stack">{head}<Unavailable reason={reason}>{reason==='right'?t('runbooks.unavailable.right'):undefined}</Unavailable></div>;
 // On the page the editor belongs to the library tab; another tab shows its own view and the editor waits.
 if(editor&&(!controlled||view==='runbooks'))return <div className="sdx-panel-stack">{head}
  <RunbookEditor existing={!!editId} name={name} description={description} steps={steps} parameterSpec={parameterSpec} busy={busy} error={editorError} onNameChange={setName} onDescriptionChange={setDescription} onStepsChange={setSteps} onParameterSpecChange={setParameterSpec} onTemplate={applyTemplate} onCancel={()=>setEditor(false)} onSave={()=>void save()} ownerChoices={showOwner&&!editId?catalogOwnerChoices(catalog,locale):null} owner={owner} onOwnerChange={setOwner} ownerText={showOwner&&editId?catalogOwnerText(visibleData?.runbooks.find(b=>b.id===editId)??{},locale):undefined}/>
  <MfaStepUp open={mfa} onClose={()=>setMfa(false)} onVerified={()=>void retryAction.current?.()}/>
 </div>;
 const tab=view??ownTab;
 const retry=<Btn size="sm" onClick={()=>void refresh()} loading={refreshing}>{t('common.retry')}</Btn>;
 // ---- The catalog ----
 const bookMenu=(b:Runbook):MenuEntry[]=>{const latest=b.versions[0];return [
  {id:'prepare',label:t('runbooks.menu.prepare'),icon:Play,blocked:!latest?t('runbooks.blocked.noVersion'):busyReason,onSelect:()=>selectBook(b.id)},
  {id:'version',label:t('runbooks.menu.newVersion'),icon:Plus,blocked:latest?.sourceRedacted===true?t('runbooks.blocked.redacted'):!b.canManage?t('runbooks.blocked.manage'):busyReason,onSelect:()=>edit(b)},
  ...(b.canManage?[{id:'separator',separator:true} as const,{id:'delete',label:t('runbooks.menu.delete'),icon:Trash2,danger:true,blocked:!b.canDelete?b.deleteReason?serverMessageText(b.deleteReason,t):t('runbooks.blocked.manage'):busyReason,onSelect:()=>setDeleteBook(b)}]:[]),
 ];};
 const bookColumns:DataColumn<Runbook>[]=[
  {id:'name',label:t('common.name'),primary:true,wrap:true,cell:b=><span className="sdx-cell-stack"><strong>{b.name}</strong>{b.description&&<small>{b.description}</small>}{showOwner&&<span className="sd-catalog-owner" data-owner={b.customerId?'customer':'library'}>{catalogOwnerLabel(b,locale)}</span>}</span>},
  {id:'version',label:t('automation.version'),mono:true,cell:b=>b.versions[0]?'v'+b.versions[0].version:EMPTY_VALUE},
  {id:'steps',label:t('jobs.table.steps'),cell:b=>{const latest=b.versions[0];return <span className="sdx-cell-stack"><span className="mono">{latest?.definition.steps.length??0}</span><small>{latest?.definition.steps.some(step=>step.kind==='powershell')?t('runbooks.step.powershell'):t('runbooks.diagnosisReadOnly')}</small></span>;}},
  {id:'created',label:t('runbooks.created'),cell:b=>stamp(b.versions[0]?.createdAt,locale)},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:b=><Menu label={t('runbooks.rowActions',{name:b.name})} entries={bookMenu(b)}/>},
 ];
 // ---- Prepare a run (a wide Drawer) ----
 const powershell=version?.definition.steps.some(step=>step.kind==='powershell')??false;
 const preconditionFailed=!!preview&&preview.targets.some(entry=>entry.preconditionErrors?.length||powershell&&entry.mode!=='Management');
 const previewReason=!versionId?t('runbooks.blocked.noVersion'):!book?t('runbooks.loading'):!targets.length?t('runbooks.blocked.noTargets'):crossLock??busyReason;
 const startReason=!versionId?t('runbooks.blocked.noVersion'):!book?t('runbooks.loading'):!targets.length?t('runbooks.blocked.noTargets'):startLock??(!preview?t('runbooks.blocked.preview'):preconditionFailed?t('runbooks.blocked.precondition'):busyReason);
 const startLabel=scheduled?t('runbooks.saveSchedule'):t('runbooks.start');
 type PreviewRow=Preview['targets'][number];
 const previewColumns:DataColumn<PreviewRow>[]=[
  {id:'device',label:t('fleet.col.device'),primary:true,cell:entry=>entry.name},
  {id:'mode',label:t('customers.mode'),cell:entry=>agentModeLabel(entry.mode,t)},
  {id:'connection',label:t('runbooks.connection'),cell:entry=><StatusPill kind={entry.online?'online':'offline'}>{entry.online?'Online':'Offline'}</StatusPill>},
  {id:'check',label:t('runbooks.check'),wrap:true,cell:entry=><span className="sdx-cell-stack"><span>{t('runbooks.stepsCount',{value:entry.steps?.length??0})}</span>{powershell&&entry.mode!=='Management'&&<small className="rb-danger">{t('runbooks.managementRequired')}</small>}{entry.preconditionErrors?.map((item,index)=><small className="rb-danger" key={index}>{serverMessageText(item,t)}</small>)}</span>},
 ];
 const change=(fn:()=>void)=>{fn();setPreview(null);};
 const closePrepare=()=>{setPreparing(false);setPreview(null);};
 const prepareForm=book&&<div className="sdx-form-grid rb-compose">
  <Field label={t('automation.version')} hint={version?.sourceRedacted?t('runbooks.sourceHidden'):undefined}><Select value={versionId} onChange={e=>change(()=>{setVersionId(e.target.value);setParameters({});})}>{book.versions.map(v=><option key={v.id} value={v.id}>v{v.version} · {stamp(v.createdAt,locale)}</option>)}</Select></Field>
  <fieldset className="rb-fieldset"><legend>{t('runbooks.targets')}</legend>
   {available.length?<div className="sdx-pick-list rb-targets">{available.map(s=><label key={s.id} className="sdx-pick-row"><input type="checkbox" checked={targets.includes(s.id)} onChange={e=>change(()=>setTargets(e.target.checked?[...targets,s.id]:targets.filter(id=>id!==s.id)))}/><span className="sdx-pick-text"><strong>{s.name}</strong></span><span className="sdx-tag">{agentModeLabel(s.management?'Management':'ReadOnly',t)}</span></label>)}</div>:<p className="rb-help">{t('runbooks.noTargets')}</p>}
  </fieldset>
  <details className="v3-disclosure"><summary>{t('runbooks.viewSteps',{value:version?.definition.steps.length??0})}</summary>{version?.definition.steps.map(s=><div className="v3-plan-step" key={s.id}><strong>{s.name}</strong> · {s.kind==='powershell'?t('runbooks.powershellSystem'):s.operation} · {s.timeoutSeconds}s{s.kind==='powershell'&&s.script&&<pre className="v3-output">{s.script}</pre>}</div>)}</details>
  {version?.definition.parameters.map(p=><Field key={p.name} label={`${p.name}${p.secret?t('runbooks.secretSuffix'):''}${p.required?' *':''}`}>{p.type==='boolean'
   ?<Select value={parameters[p.name]??String(p.default??false)} onChange={e=>change(()=>setParameters({...parameters,[p.name]:e.target.value}))}><option value="false">{t('management.no')}</option><option value="true">{t('management.yes')}</option></Select>
   :<input type={p.secret?'password':p.type==='number'?'number':'text'} autoComplete={p.secret?'new-password':'off'} value={p.secret?parameters[p.name]??'':parameters[p.name]??String(p.default??'')} onChange={e=>change(()=>setParameters({...parameters,[p.name]:e.target.value}))}/>}</Field>)}
  <div className="rb-two">
   <Field label={t('runbooks.parallel')}><input type="number" min={1} max={10} value={concurrency} onChange={e=>change(()=>setConcurrency(Number(e.target.value)))}/></Field>
   <Field inline label={t('runbooks.stopOnError')}><input type="checkbox" role="switch" checked={failureStop} onChange={e=>change(()=>setFailureStop(e.target.checked))}/></Field>
  </div>
  <Field inline label={t('runbooks.saveAsSchedule')}><input type="checkbox" role="switch" checked={scheduled} onChange={e=>setScheduled(e.target.checked)}/></Field>
  {scheduled&&<>
   <div className="rb-two">
    <Field label={t('runbooks.repeat')}><Select value={scheduleKind} onChange={e=>setScheduleKind(e.target.value)}><option value="daily">{t('runbooks.dailyBerlin')}</option><option value="interval">{t('runbooks.interval')}</option></Select></Field>
    {scheduleKind==='daily'?<Field label={t('runbooks.timeOfDay')}><input type="time" value={dailyTime} onChange={e=>setDailyTime(e.target.value)}/></Field>:<Field label={t('runbooks.intervalMinutes')}><input type="number" min={5} max={10080} value={minutes} onChange={e=>setMinutes(Number(e.target.value))}/></Field>}
   </div>
   <Field label={t('runbooks.catchUp')} hint={t('runbooks.catchUpHint')}><Select value={catchup} onChange={e=>setCatchup(Number(e.target.value))}><option value={0}>{t('runbooks.noCatchUp')}</option><option value={3600}>{t('runbooks.catchUp1')}</option><option value={21600}>{t('runbooks.catchUp6')}</option><option value={86400}>{t('runbooks.catchUp24')}</option></Select></Field>
  </>}
  {preview&&<section className="rb-preview" aria-label={t('runbooks.previewVersion',{version:preview.version})}>
   <h3>{t('runbooks.previewVersion',{version:preview.version})}</h3>
   <DataTable<PreviewRow> label={t('runbooks.previewVersion',{version:preview.version})} cards columns={previewColumns} rows={preview.targets} rowKey={entry=>entry.serverId} empty={{icon:ShieldCheck,title:t('runbooks.noTargetsTitle'),children:t('runbooks.blocked.noTargets')}}/>
   {preview.warnings?.length>0&&<Notice tone="warning" icon={AlertTriangle}>{preview.warnings.map((item,index)=><p key={index}>{serverMessageText(item,t)}</p>)}</Notice>}
  </section>}
 </div>;
 const prepare=<Drawer open={preparing&&!!bookId} onClose={closePrepare} wide icon={Play} title={t('runbooks.prepareNamed',{name:book?.name??name})} description={book?.description||undefined}
  footer={<>
   <Btn icon={ShieldCheck} loading={busy&&!confirmation} blocked={previewReason??undefined} onClick={()=>void dryrun()}>{t('runbooks.preview')}</Btn>
   <Btn variant="primary" icon={scheduled?CalendarClock:Play} blocked={startReason??undefined} onClick={()=>setConfirmation(scheduled?'schedule':'run')}>{startLabel}</Btn>
  </>}>
  {/* A new runbook that the list does not have yet waits here until the next load brings it. */}
  {preparing&&bookId?prepareForm||<Skeleton variant="facts" label={t('runbooks.loading')}/>:null}
 </Drawer>;
 // ---- Runs and schedules ----
 const runMenu=(r:Run):MenuEntry[]=>[
  {id:'output',label:t('runbooks.menu.output'),icon:FileText,onSelect:()=>openRun(r.id)},
  ...(!finished.includes(r.state)?[{id:'stop',label:t('runbooks.menu.stop'),icon:Square,blocked:busyReason,onSelect:()=>setStopRun(r)}]:[]),
 ];
 const runColumns:DataColumn<Run>[]=[
  {id:'runbook',label:t('runbooks.line.runbook'),primary:true,cell:r=><span className="sdx-cell-stack"><strong>{runName(r.versionId)}</strong><small className="mono">{r.id.slice(0,8)}</small></span>},
  {id:'started',label:t('audit.time'),cell:r=>stamp(r.createdAt,locale)},
  {id:'status',label:t('management.status'),cell:r=><StatusPill kind={runPillKind(r.state)}>{stateLabel(r.state)}</StatusPill>},
  {id:'devices',label:t('runbooks.devicesStep'),wrap:true,cell:r=><span className="sdx-cell-stack">{r.devices.map(d=><small key={d.serverId}>{servers.find(s=>s.id===d.serverId)?.name??d.serverId} · {stateLabel(d.state)} · {d.stepIndex+1}</small>)}</span>},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:r=><Menu label={t('runbooks.rowActions',{name:runName(r.versionId)})} entries={runMenu(r)}/>},
 ];
 const scheduleColumns:DataColumn<Schedule>[]=[
  {id:'runbook',label:t('runbooks.bookSchedule'),primary:true,wrap:true,cell:s=><span className="sdx-cell-stack"><strong>{runName(s.versionId)}</strong><small>{s.recurrence.kind==='daily'?t('runbooks.dailyAt',{padStart:String(s.recurrence.hour).padStart(2,'0'),padStart2:String(s.recurrence.minute).padStart(2,'0'),timeZone:String(s.recurrence.timeZone)}):t('desired.schedule.minutes',{minutes:String(s.recurrence.minutes)})}</small></span>},
  {id:'next',label:t('runbooks.nextRun'),cell:s=>stamp(s.nextDue,locale)},
  {id:'targets',label:t('runbooks.targets'),wrap:true,cell:s=>s.targets.map(id=>servers.find(d=>d.id===id)?.name??id).join(', ')},
  {id:'status',label:t('management.status'),cell:s=>s.enabled?<StatusPill kind="success">{t('management.active')}</StatusPill>:<StatusPill kind="neutral">{t('runbooks.state.off')}</StatusPill>},
  // One row Menu, as on every device list (it also stays in card mode).
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:s=><Menu label={t('runbooks.rowActions',{name:runName(s.versionId)})} entries={[{id:'turn-off',label:t('runbooks.menu.turnOff'),icon:Square,blocked:!s.enabled?t('runbooks.blocked.scheduleOff'):busyReason,onSelect:()=>void turnOff(s.id)}]}/>},
 ];
 const tabs=[{id:'runbooks',label:t('device.section.runbooks'),...(visibleData?{count:visibleData.runbooks.length}:{})},{id:'runs',label:t('runbooks.runs'),...(visibleData?{count:visibleData.runs.length}:{})},{id:'schedules',label:t('runbooks.schedules'),...(visibleData?{count:visibleData.schedules.length}:{})}];
 const content=!visibleData?(error?null:<Skeleton variant="table" label={t('runbooks.loading')} after={15000} action={retry}/>)
  :tab==='runbooks'?<Card title={t('runbooks.catalogTitle')} icon={BookOpen} iconTone="accent" flush>
   <DataTable<Runbook> label={t('device.section.runbooks')} variant="flush" cards entranceId="runbook-catalog" columns={bookColumns} rows={visibleData.runbooks} rowKey={b=>b.id} highlightKey={bookId||undefined}
    onOpen={b=>{if(b.versions[0]&&!busy)selectBook(b.id);}} empty={{icon:BookOpen,title:t('runbooks.none'),children:t('runbooks.noneHint'),action:createButton('secondary')}}/>
  </Card>
  :tab==='runs'?<Card title={controlled?undefined:t('runbooks.runs')} icon={History} iconTone="neutral" flush>
   <DataTable<Run> label={t('runbooks.runs')} variant="flush" cards entranceId="runbook-runs" columns={runColumns} rows={visibleData.runs} rowKey={r=>r.id} highlightKey={selectedRun??undefined} onOpen={r=>openRun(r.id)} empty={{icon:History,title:t('runbooks.noRuns'),children:t('runbooks.noRunsHint')}}/>
  </Card>
  :controlled&&!serverId?<RunbookSchedules schedules={visibleData.schedules} assignments={assignmentSchedules} servers={servers} runName={runName} busyReason={busyReason} onTurnOff={id=>void turnOff(id)} onShowAssignment={id=>onShowAssignment?.(id)} onShowLibrary={()=>onShowLibrary?.()}/>
  :<Card title={t('runbooks.schedules')} icon={CalendarClock} iconTone="neutral" flush>
   <DataTable<Schedule> label={t('runbooks.schedules')} variant="flush" cards columns={scheduleColumns} rows={visibleData.schedules} rowKey={s=>s.id} empty={{icon:CalendarClock,title:t('runbooks.noSchedulesTitle'),children:t('runbooks.noSchedulesHint')}}/>
  </Card>;
 const targetNames=targets.map(id=>servers.find(s=>s.id===id)?.name??id).join(', '),hint=crossCustomerHint(customerCount,locale);
 const stoppable=!!currentRun&&!finished.includes(currentRun.state);
 return <div className="sdx-panel-stack">
  {head}
  {error&&<Notice tone="danger" icon={AlertTriangle} action={retry}>{error}{visibleData?' '+t('console.staleData'):''}</Notice>}
  {controlled?content:<>
   <Tabs variant="underline" label={t('runbooks.views')} panelId={panelId} value={tab} onChange={value=>setTab(value as RunbookTab)} items={tabs}/>
   <div id={panelId} role="tabpanel" aria-labelledby={tabId(panelId,tab)} className="sdx-panel-stack">{content}</div>
  </>}
  {prepare}
  <Drawer open={!!selectedRun} onClose={()=>setSelectedRun(null)} wide title={currentRun?runName(currentRun.versionId):t('runbooks.outputTitle')} description={currentRun?`${stateLabel(currentRun.state)} · ${stamp(currentRun.createdAt,locale)}`:undefined}
   footer={stoppable&&currentRun?<Btn icon={Square} blocked={busyReason} onClick={()=>setStopRun(currentRun)}>{t('runbooks.menu.stop')}</Btn>:undefined}>
   {detailError&&<Notice tone="danger" icon={AlertTriangle} action={<Btn size="sm" onClick={()=>{if(selectedRun)void loadDetails(selectedRun);}}>{t('common.retry')}</Btn>}>{detailError}</Notice>}
   {selectedRun&&!detailRun&&!detailError?<Skeleton variant="facts" label={t('runbooks.outputLoading')}/>:currentRun?.devices.map(d=><section key={d.serverId} className="v3-drawer-section"><h3>{servers.find(s=>s.id===d.serverId)?.name??d.serverId}</h3><p className="v3-help">{t('runbooks.stateStep',{stateLabel:stateLabel(d.state),value:d.stepIndex+1})}</p>{d.result&&<pre className="v3-output">{agentMessageText(d,t)}</pre>}{d.outputRedacted&&<p className="v3-help">{t('runbooks.outputHidden')}</p>}{d.steps?.map(step=><div className="v3-policy" key={step.jobId}><strong>{t('runbooks.stepState',{value:step.stepIndex+1,stateLabel:stateLabel(step.state)})}</strong><small className="table-sub">{stamp(step.createdAt,locale)}{step.completedAt?' → '+stamp(step.completedAt,locale):''}</small>{step.result&&<p className="v3-help">{agentMessageText(step,t)}</p>}{step.outputRedacted&&<p className="v3-help">{t('runbooks.outputHidden')}</p>}{step.output&&<><pre className="v3-output">{step.output.output}{step.output.stderr?'\nSTDERR\n'+step.output.stderr:''}</pre><p className="v3-help">{t('runbooks.exitCode',{exitCode:step.output.exitCode})}{step.output.truncated?t('runbooks.truncatedSuffix'):''}{step.output.scope?.security?t('runbooks.securitySuffix'):''}</p></>}</div>)}{!d.steps?.length&&!d.result&&<p className="v3-help">{t('runbooks.noOutput')}</p>}</section>)}
  </Drawer>
  <ConfirmDialog open={!!stopRun} onOpenChange={open=>{if(!open&&!busy)setStopRun(null);}} tone="danger" title={t('runbooks.stopTitle')}
   lines={stopRun?[{label:t('runbooks.line.runbook'),value:runName(stopRun.versionId)},{label:t('runbooks.line.started'),value:stamp(stopRun.createdAt,locale)},{label:t('runbooks.line.devices'),value:stopRun.devices.map(d=>servers.find(s=>s.id===d.serverId)?.name??d.serverId).join(', ')}]:undefined}
   body={t('runbooks.stopBody')} confirmLabel={t('runbooks.stopConfirm')} busy={busy} onConfirm={()=>void stop()}/>
  <ConfirmDialog open={!!deleteBook} onOpenChange={open=>{if(!open&&!busy){setDeleteBook(null);retryAction.current=null;}}} tone="danger" title={t('runbooks.deleteTitle')} lines={deleteBook?[{label:t('runbooks.line.runbook'),value:deleteBook.name}]:undefined}
   body={t('runbooks.deleteDescription',{name:deleteBook?.name??''})} confirmLabel={t('runbooks.delete')} busy={busy} onConfirm={()=>void remove()}/>
  <ConfirmDialog open={!!confirmation} onOpenChange={open=>{if(!open)setConfirmation(null);}} title={confirmation==='schedule'?t('runbooks.scheduleConfirmTitle'):t('runbooks.runConfirmTitle')}
   lines={[{label:t('runbooks.line.runbook'),value:book?.name??''},{label:t('runbooks.line.version'),value:version?'v'+version.version:''},{label:t('runbooks.line.devices'),value:targetNames}]}
   body={t('runbooks.runConfirmBody')+(confirmation==='run'&&hint?'\n\n'+hint:'')} confirmLabel={confirmation==='schedule'?t('runbooks.saveSchedule'):t('runbooks.start')} busy={busy} onConfirm={()=>void execute()}/>
  <MfaStepUp open={mfa} onClose={()=>setMfa(false)} onVerified={()=>void retryAction.current?.()}/>
 </div>;
}
