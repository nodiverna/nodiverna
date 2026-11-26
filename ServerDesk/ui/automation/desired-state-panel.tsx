'use client';
// Desired State on the console kit: the device's Automation → Desired State tab (serverId) and the
// Desired State page of Automation (view given). One panel loads GET /api/desired-state, keeps the scope key
// and the generation counters of every request (data, source, editor, file, run), and shows the
// devices, the configuration library and the run history. On the device they are kit Tabs; on the page the
// page's tab bar picks the view and the panel renders no tab bar, head or gradient button of its own (the
// page header holds the primary; the editor's "Save version" is the one primary while it is open). Check,
// Apply, Remove assignment and Delete configuration ask in the kit ConfirmDialog; the request bodies are the
// classic ones.
import {useCallback,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {AlertTriangle,ArrowLeft,CalendarClock,Check,CheckCircle2,Download,FileCode2,GitBranch,History,Plus,RefreshCw,Server,ShieldCheck,Trash2,TriangleAlert,Upload} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import {desiredParameters,desiredTemplates,validateDesiredContent} from '@/lib/desired-state-operations';
import {desiredAssignmentRuns,desiredDrafts,desiredExecutionReason,desiredFileEngine,desiredFormats,desiredScheduleLabel,desiredTargetReason,desiredVersionLabel,type DesiredAssignment,type DesiredConfiguration,type DesiredData,type DesiredDrafts,type DesiredEngine,type DesiredRun,type DesiredVersion} from '@/ui/automation/desired-state-ui';
import {DesiredDeviceState,DesiredFeedback,DesiredRunDetails,DesiredStatus,DesiredVersionSource} from '@/ui/automation/desired-state-components';
import {api,ApiError,downloadText,message,online,permitted,stamp,type Device} from '@/ui/base/api';
import {isOwner} from '@/ui/base/access-capabilities';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {Btn,Card,Empty,IconBtn,Kpi,KpiRow,Notice,SectionHead,Segmented,Skeleton,Unavailable} from '@/ui/kit/kit';
import {Field,Select} from '@/ui/kit/field';
import {DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {Tabs,tabId} from '@/ui/kit/tabs';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {EMPTY_VALUE,formatNumber} from '@/lib/i18n/format';
import '@/ui/automation/desired-state.css';

import {useLocale,useT} from '@/ui/base/locale';
import {agentModeLabel} from '@/ui/base/agent-mode';
import {messageFieldsText,serverMessageText} from '@/lib/server-messages';
type Editor={scopeKey:string;configId:string;name:string;description:string;engine:DesiredEngine;drafts:DesiredDrafts;input:'editor'|'github';github:{owner:string;repository:string;ref:string;path:string}};
type Mutation={message?:string;messageKey?:string;messageParams?:Record<string,string|number>;configId?:string;versionId?:string;version?:number;runId?:string;jobId?:string;summary?:{assigned:number;unchanged:number}};
type Confirmation={scopeKey:string;assignment:DesiredAssignment;operation:'test'|'apply'|'remove'};
type DeleteConfirmation={scopeKey:string;config:DesiredConfiguration};
type Schedule={assignmentId:string;versionId:string;expectedIntervalSeconds:number;intervalSeconds:number;consent:boolean};
type Notice={scope:string;text:string;warning?:boolean;runId?:string};
const scheduleOptions=[0,900,3600,21600,86400];
const emptyGithub=()=>({owner:'',repository:'',ref:'main',path:''});
type PanelTab='devices'|'configs'|'history';
/** The views of the Desired State page; assignments is a page tab the panel does not render. */
export type DesiredView='configurations'|'assignments'|'status'|'history';
const panelTabs:Record<DesiredView,PanelTab|null>={configurations:'configs',status:'devices',history:'history',assignments:null};
const pageViews:Record<PanelTab,DesiredView>={configs:'configurations',devices:'status',history:'history'};
/** The sizes of the loaded lists, for the tab counts of the Desired State page. */
export type DesiredCounts={configs:number;runs:number};

export default function DesiredStatePanel({servers,server,serverId,viewer,demo=false,onRefresh,view,onView,onCounts,createRequest=0,onEditorChange,origin}:{servers?:Device[];server?:Device;serverId?:string;viewer:Viewer;demo?:boolean;onRefresh?:()=>void|Promise<void>;
 /** The Desired State page: the view its tab bar shows. Without it the panel shows its own tabs. */
 view?:DesiredView;onView?:(view:DesiredView)=>void;
 /** Gets the list sizes after every load. */
 onCounts?:(counts:DesiredCounts)=>void;
 /** A new number opens the editor for a new configuration (the page primary "Create configuration"). */
 createRequest?:number;
 /** Whether the editor is open; the page leaves out its primary while it is. */
 onEditorChange?:(open:boolean)=>void;
 /** The Origin cell of a device on the page's Device status view: its effective template and where it comes from. */
 origin?:(device:Device)=>ReactNode}){
 const t=useT(),[locale]=useLocale(),panelId=useId(),controlled=view!==undefined;
 const devices=servers??(server?[server]:[]),scope=serverId??server?.id;
 // Device scope: the one concrete reason the tab cannot be used (Desired State itself explains agent and OS limits on its actions). Library scope: only the sample data.
 const scopeDevice=scope?devices.find(d=>d.id===scope):undefined;
 const reason=scope?unavailableReason({demo,revoked:!!scopeDevice?.revoked,permitted:!!scopeDevice&&permitted(scopeDevice,viewer,'desired.read'),reported:!!scopeDevice?.snapshot,supported:true}):demo?'demo':null;
 const scopeKey=JSON.stringify([scope??'all',viewer.id,isOwner(viewer),devices.map(d=>[d.id,d.permissions??[]])]);
 const scopeRef=useRef(scopeKey);scopeRef.current=scopeKey;
 const generation=useRef(0),sourceGeneration=useRef(0),editorGeneration=useRef(0),fileGeneration=useRef(0),runGeneration=useRef(0),file=useRef<HTMLInputElement>(null);
 const [data,setData]=useState<DesiredData|null>(null),[dataScope,setDataScope]=useState(''),[loadError,setLoadError]=useState(''),[actionError,setActionError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState<Notice|null>(null);
 const [ownTab,setOwnTab]=useState<PanelTab>('devices'),[selectedDevice,setSelectedDevice]=useState(scope??''),[selectedConfig,setSelectedConfig]=useState(''),[selectedVersion,setSelectedVersion]=useState(''),[runId,setRunId]=useState('');
 const [search,setSearch]=useState(''),[deviceSearch,setDeviceSearch]=useState(''),[rawEditor,setEditor]=useState<Editor|null>(null),[targets,setTargets]=useState<string[]>(scope?[scope]:[]),[interval,setIntervalSeconds]=useState(0),[automaticConsent,setAutomaticConsent]=useState(false);
 const [source,setSource]=useState<DesiredVersion|null>(null),[sourceBusy,setSourceBusy]=useState(false),[sourceError,setSourceError]=useState(''),[rawConfirm,setConfirm]=useState<Confirmation|null>(null),[systemConsent,setSystemConsent]=useState(false),[maintenanceConsent,setMaintenanceConsent]=useState(false),[schedule,setSchedule]=useState<Schedule|null>(null);
 const [runDetail,setRunDetail]=useState<DesiredRun|null>(null),[runBusy,setRunBusy]=useState(false),[runError,setRunError]=useState(''),[runAttempt,setRunAttempt]=useState(0),[refreshing,setRefreshing]=useState(false);
 const [pendingSelection,setPendingSelection]=useState<{configId:string;versionId:string;name:string;version?:number}|null>(null);
 const [rawDeleteConfirmation,setDeleteConfirmation]=useState<DeleteConfirmation|null>(null);
 const handledCreate=useRef(createRequest);
 // On the page the page's tab bar holds the view: a change of view inside the panel moves the page tab.
 const tab:PanelTab|null=controlled?panelTabs[view]:ownTab;
 const setTab=(next:PanelTab)=>{if(controlled)onView?.(pageViews[next]);else setOwnTab(next);};
 const editor=rawEditor?.scopeKey===scopeKey?rawEditor:null,confirm=rawConfirm?.scopeKey===scopeKey?rawConfirm:null;
 const visible=dataScope===scopeKey?data:null,configs=visible?.configs??[],assignments=visible?.assignments.filter(a=>a.enabled)??[],runs=visible?.runs??[];
 const deleteConfirmation=rawDeleteConfirmation?.scopeKey===scopeKey?rawDeleteConfirmation:null,deleteConfig=deleteConfirmation?configs.find(c=>c.id===deleteConfirmation.config.id):undefined;
 const readable=devices.filter(d=>(!scope||d.id===scope)&&permitted(d,viewer,'desired.read')),manage=isOwner(viewer)||devices.some(d=>permitted(d,viewer,'desired.manage'));
 const book=configs.find(c=>c.id===selectedConfig),version=book?.versions.find(v=>v.id===selectedVersion)??(pendingSelection?.versionId===selectedVersion?undefined:book?.versions[0]);
 const chosenDevice=readable.find(d=>d.id===(scope??selectedDevice))??readable[0],assignment=assignments.find(a=>a.serverId===chosenDevice?.id);
 const versionLabel=(id:string)=>{const known=runs.find(r=>r.versionId===id)?.configuration;return known?.deleted?t('desired.deletedVersion',{name:known.name,version:known.version}):configs.some(c=>c.versions.some(v=>v.id===id))?desiredVersionLabel(configs,id,locale):known?`${known.name} · v${known.version}`:desiredVersionLabel(configs,id,locale);},deviceName=(id:string)=>devices.find(d=>d.id===id)?.name??id;
 const assignmentRuns=(a:DesiredAssignment)=>desiredAssignmentRuns(a,runs,locale);
 const selectedRun=runs.find(r=>r.id===runId)??assignments.flatMap(a=>[a.latestRun,a.latestComplianceRun]).find(r=>r?.id===runId)??null;
 const detailedRun=runDetail?.id===selectedRun?.id&&runDetail?.versionId===selectedRun?.versionId&&runDetail?.state===selectedRun?.state&&runDetail?.resultAt===selectedRun?.resultAt?runDetail:null;
 const hasActiveRun=runs.some(r=>r.state==='pending'||r.state==='running')||assignments.some(a=>{const r=assignmentRuns(a).latest;return r?.state==='pending'||r?.state==='running';});
 const endpoint=(query?:string)=>'/api/desired-state'+(query||scope?'?'+[query,scope?'serverId='+encodeURIComponent(scope):''].filter(Boolean).join('&'):'');

 useEffect(()=>{
  generation.current++;sourceGeneration.current++;editorGeneration.current++;fileGeneration.current++;runGeneration.current++;
  setData(null);setDataScope('');setSource(null);setSourceError('');setRunDetail(null);setRunError('');setEditor(null);setConfirm(null);setDeleteConfirmation(null);setSchedule(null);setActionError('');setNotice(null);setSelectedDevice(scope??'');setSelectedConfig('');setSelectedVersion('');setRunId('');setTargets(scope?[scope]:[]);setAutomaticConsent(false);setPendingSelection(null);
 },[scopeKey,scope]);
 const load=useCallback(async()=>{
  if(reason)return false;const request=++generation.current;
  try{const next=await api<DesiredData>('/api/desired-state'+(scope?'?serverId='+encodeURIComponent(scope):''));if(request!==generation.current||scopeRef.current!==scopeKey)return false;setData(next);setDataScope(scopeKey);setLoadError('');return true;}
  catch(e){if(request!==generation.current||scopeRef.current!==scopeKey)return false;setLoadError(message(e));if(e instanceof ApiError&&[401,403].includes(e.status)){setData(null);setDataScope('');setSource(null);setRunDetail(null);setEditor(null);setConfirm(null);setDeleteConfirmation(null);}return false;}
 },[reason,scope,scopeKey]);
 useEffect(()=>{void load();},[load]);
 useEffect(()=>{if(reason)return;const timer=setInterval(()=>void load(),hasActiveRun?3000:15000);return()=>clearInterval(timer);},[load,reason,hasActiveRun]);
 useEffect(()=>{
  if(!visible)return;
  if(pendingSelection){if(configs.some(c=>c.id===pendingSelection.configId&&c.versions.some(v=>v.id===pendingSelection.versionId)))setPendingSelection(null);else if(selectedConfig===pendingSelection.configId)return;}
  if(!configs.some(c=>c.id===selectedConfig)){const assigned=assignments.find(a=>a.serverId===scope),next=configs.find(c=>c.versions.some(v=>v.id===assigned?.versionId))??configs[0];setSelectedConfig(next?.id??'');setSelectedVersion(assigned&&next?.versions.some(v=>v.id===assigned.versionId)?assigned.versionId:next?.versions[0]?.id??'');}
 // eslint-disable-next-line react-hooks/exhaustive-deps -- configs and assignments change on every load; the preselection follows only visibility, selection and device.
 },[visible,selectedConfig,scope,pendingSelection]);
 useEffect(()=>{
  const request=++sourceGeneration.current;setSourceError('');setSource(null);
  if(!version||tab!=='configs'||editor||reason){setSourceBusy(false);return;}
  const key=scopeKey,id=version.id;setSourceBusy(true);
  void api<DesiredData>(endpoint('versionId='+encodeURIComponent(id))).then(next=>{if(request!==sourceGeneration.current||scopeRef.current!==key)return;if(!next.selectedVersion||next.selectedVersion.id!==id)throw new Error(t('desired.sourceUnavailable'));setSource(next.selectedVersion);}).catch(e=>{if(request===sourceGeneration.current&&scopeRef.current===key)setSourceError(message(e));}).finally(()=>{if(request===sourceGeneration.current&&scopeRef.current===key)setSourceBusy(false);});
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sourceGeneration is a generation counter, not DOM refs; the cleanup increments it so that late responses are dropped.
  return()=>{sourceGeneration.current++;};
 // eslint-disable-next-line react-hooks/exhaustive-deps -- The source reloads only for another version, another tab or an opened editor, not for every new version object.
 },[version?.id,tab,!!editor,reason,scopeKey]);
 useEffect(()=>{
  const request=++runGeneration.current;setRunError('');
  if(!selectedRun||tab!=='history'||reason){setRunBusy(false);setRunDetail(null);return;}
  const key=scopeKey,id=selectedRun.id,versionId=selectedRun.versionId;setRunBusy(true);
  void api<DesiredData>(endpoint('runId='+encodeURIComponent(id))).then(next=>{if(request!==runGeneration.current||scopeRef.current!==key)return;if(!next.selectedRun||next.selectedRun.id!==id||next.selectedRun.versionId!==versionId)throw new Error(t('desired.runResultUnavailable'));setRunDetail(next.selectedRun);}).catch(e=>{if(request===runGeneration.current&&scopeRef.current===key)setRunError(message(e));}).finally(()=>{if(request===runGeneration.current&&scopeRef.current===key)setRunBusy(false);});
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runGeneration is a generation counter, not DOM refs; the cleanup increments it so that late responses are dropped.
  return()=>{runGeneration.current++;};
 // eslint-disable-next-line react-hooks/exhaustive-deps -- The result reloads only when the run, the status or the result time changes (or on "Try again"), not for every new run object.
 },[selectedRun?.id,selectedRun?.versionId,selectedRun?.state,selectedRun?.resultAt,tab,reason,scopeKey,runAttempt]);

 const mutate=async(payload:Record<string,unknown>,successText:string):Promise<Mutation|null>=>{
  if(busy||reason)return null;const key=scopeKey;setBusy(true);setActionError('');setNotice(null);
  let result:Mutation;
  try{result=await api<Mutation>('/api/desired-state',payload);}catch(e){if(scopeRef.current===key)setActionError(message(e));setBusy(false);return null;}
  if(scopeRef.current!==key){setBusy(false);return null;}
  setNotice({scope:key,text:messageFieldsText(result,t,successText),...(result.runId?{runId:result.runId}:{})});
  await load();
  try{await onRefresh?.();}catch{/* A committed mutation remains successful when refreshing the parent fails. */}
  if(typeof window!=='undefined')window.dispatchEvent(new Event('serverdesk:refresh'));
  setBusy(false);return scopeRef.current===key?result:null;
 };
 const choose=(config:DesiredConfiguration,id?:string)=>{editorGeneration.current++;fileGeneration.current++;setPendingSelection(null);setSelectedConfig(config.id);setSelectedVersion(id??config.versions[0]?.id??'');setTargets(scope?[scope]:[]);setIntervalSeconds(0);setAutomaticConsent(false);setEditor(null);setTab('configs');};
 const inspectAssignment=(a:DesiredAssignment)=>{const config=configs.find(c=>c.versions.some(v=>v.id===a.versionId));if(config)choose(config,a.versionId);else setActionError(t('desired.versionGone'));};
 const openEditor=async(config?:DesiredConfiguration,base?:DesiredVersion)=>{
  if(busy||reason)return;const key=scopeKey,request=++editorGeneration.current;fileGeneration.current++;setActionError('');setBusy(true);
  try{
   let full=base;if(base){full=source?.id===base.id?source:(await api<DesiredData>(endpoint('versionId='+encodeURIComponent(base.id)))).selectedVersion;if(!full||full.id!==base.id)throw new Error(t('desired.versionUnavailable'));}
   if(request!==editorGeneration.current||scopeRef.current!==key)return;
   setEditor({scopeKey:key,configId:config?.id??'',name:config?.name??'',description:config?.description??'',engine:full?.engine??'dsc3',drafts:desiredDrafts(full),input:'editor',github:full?.source.kind==='github'?{owner:full.source.owner??'',repository:full.source.repository??'',ref:full.source.ref??'main',path:full.source.path??''}:emptyGithub()});setTab('configs');
  }catch(e){if(request===editorGeneration.current&&scopeRef.current===key)setActionError(message(e));}finally{setBusy(false);}
 };
 const changeDraft=(patch:Partial<DesiredDrafts[DesiredEngine]>)=>{if(patch.content!==undefined)fileGeneration.current++;setEditor(current=>current?{...current,drafts:{...current.drafts,[current.engine]:{...current.drafts[current.engine],...patch}}}:null);};
 const importFile=async(upload:File)=>{
  const key=scopeKey,request=editorGeneration.current,pick=++fileGeneration.current;
  try{const engine=desiredFileEngine(upload.name);if(!engine)throw new Error(t('desired.chooseFile'));if(upload.size>65536)throw new Error(t('desired.fileTooLarge'));const content=new TextDecoder('utf-8',{fatal:true}).decode(await upload.arrayBuffer());if(scopeRef.current!==key||editorGeneration.current!==request||fileGeneration.current!==pick)return;setEditor(current=>current?{...current,engine,input:'editor',name:current.name||upload.name.replace(/\.(json|ps1|mof)$/i,''),drafts:{...current.drafts,[engine]:{...current.drafts[engine],content}}}:null);setActionError('');}catch(e){if(scopeRef.current===key&&editorGeneration.current===request&&fileGeneration.current===pick)setActionError(message(e));}
 };
 const save=async()=>{
  if(!editor)return;const snapshot=editor,draft=snapshot.drafts[snapshot.engine];
  try{
   let parameters:Record<string,string|number|boolean>={};
   if(snapshot.engine!=='mof'){let parsed:unknown;try{parsed=JSON.parse(draft.parameters);}catch{throw new Error(t('desired.paramsInvalid'));}const result=desiredParameters.safeParse(parsed);if(!result.success)throw new Error(t('desired.paramsNamed'));parameters=result.data;}
   if(snapshot.input==='editor')validateDesiredContent(snapshot.engine,draft.content,snapshot.engine==='powershell-dsc'?draft.configurationName:undefined);
   const result=await mutate({action:snapshot.input==='github'?'import-github':'create-version',...(snapshot.configId?{configId:snapshot.configId}:{}),...(scope?{serverId:scope}:{}),name:snapshot.name,description:snapshot.description,engine:snapshot.engine,...(snapshot.input==='github'?{github:snapshot.github}:{content:draft.content}),...(snapshot.engine==='powershell-dsc'?{configurationName:draft.configurationName}:{}),parameters},t('desired.versionSaved'));
   if(result?.configId&&result.versionId){fileGeneration.current++;setPendingSelection({configId:result.configId,versionId:result.versionId,name:snapshot.name,version:result.version});setSelectedConfig(result.configId);setSelectedVersion(result.versionId);setEditor(null);setTargets(scope?[scope]:[]);setTab('configs');setNotice(current=>current?{...current,text:t('desired.versionSavedNamed',{name:snapshot.name,value:result.version??''})}:current);}
  }catch(e){setActionError(message(e));}
 };
 const download=()=>{if(!version||!source||source.id!==version.id)return;downloadText((book?.name??'configuration').replace(/[^A-Za-z0-9_.-]/g,'_')+'-v'+version.version+desiredFormats[version.engine].extension,source.content??'',version.engine==='dsc3'?'application/json':'text/plain');};
 const removeConfiguration=async()=>{
  if(!deleteConfig?.canDelete)return;const removed=deleteConfig,result=await mutate({action:'delete-config',configId:removed.id,confirmDelete:true},t('desired.configDeleted'));
  if(!result)return;sourceGeneration.current++;editorGeneration.current++;fileGeneration.current++;
  const ids=new Set(removed.versions.map(v=>v.id));setData(current=>current?{...current,configs:current.configs.filter(c=>c.id!==removed.id),assignments:current.assignments.map(a=>ids.has(a.versionId)?{...a,enabled:false,intervalSeconds:0}:a),runs:current.runs.map(r=>ids.has(r.versionId)&&r.configuration?{...r,configuration:{...r.configuration,deleted:true}}:r)}:null);
  setDeleteConfirmation(null);setSelectedConfig('');setSelectedVersion('');setSource(null);setPendingSelection(null);setTargets([]);setAutomaticConsent(false);setSchedule(null);setTab('configs');
 };
 const openConfirmation=(a:DesiredAssignment,operation:Confirmation['operation'])=>{setActionError('');setConfirm({scopeKey,assignment:a,operation});setSystemConsent(false);setMaintenanceConsent(false);};
 const execute=async()=>{
  if(!confirm)return;const {assignment:a,operation}=confirm,result=await mutate(operation==='remove'?{action:'unassign',assignmentId:a.id}:{action:operation,assignmentId:a.id,confirmSystem:systemConsent,confirmMaintenance:maintenanceConsent},operation==='remove'?t('desired.assignmentRemoved'):t('desired.jobQueued'));
  if(result){setConfirm(null);setSelectedDevice(a.serverId);if(result.runId)setRunId(result.runId);setTab('devices');}
 };
 const beginSchedule=(a:DesiredAssignment)=>{setActionError('');setSchedule({assignmentId:a.id,versionId:a.versionId,expectedIntervalSeconds:a.intervalSeconds,intervalSeconds:a.intervalSeconds,consent:false});};
 const saveSchedule=async()=>{if(!schedule)return;const result=await mutate({action:'update-schedule',assignmentId:schedule.assignmentId,versionId:schedule.versionId,expectedIntervalSeconds:schedule.expectedIntervalSeconds,intervalSeconds:schedule.intervalSeconds,confirmSystem:schedule.consent},t('desired.scheduleSaved'));if(result)setSchedule(null);};
 const targetRows=version?devices.filter(d=>!scope||d.id===scope).map(device=>{
  const assigned=assignments.find(a=>a.serverId===device.id),readiness=desiredExecutionReason(device,permitted(device,viewer,'desired.apply'),'test',locale);
  const reason=desiredTargetReason({assignment:assigned,versionId:version.id,intervalSeconds:interval,canManage:permitted(device,viewer,'desired.manage'),executionReason:readiness},locale);
  return {device,assigned,readiness,reason};
 }):[];
 const validTargets=targetRows.filter(row=>!row.reason&&targets.includes(row.device.id)).map(row=>row.device.id);
 const assign=async()=>{
  if(!version||!validTargets.length)return;const result=await mutate({action:'assign',versionId:version.id,targets:validTargets,intervalSeconds:interval,confirmSystem:automaticConsent},t('desired.assigned',{versionLabel:versionLabel(version.id)}));
  if(result){setTargets([]);if(validTargets.length===1)setSelectedDevice(validTargets[0]);setAutomaticConsent(false);setTab('devices');}
 };
 const assignmentState=assignment?assignmentRuns(assignment):null,assignmentLatest=assignmentState?.latest??null,assignmentCompliance=assignmentState?.compliance??null,activeRun=assignmentLatest?.state==='pending'||assignmentLatest?.state==='running';
 const testReason=desiredExecutionReason(chosenDevice,!!chosenDevice&&permitted(chosenDevice,viewer,'desired.apply'),'test',locale),applyReason=desiredExecutionReason(chosenDevice,!!chosenDevice&&permitted(chosenDevice,viewer,'desired.apply'),'apply',locale);
 const matchingConfigs=configs.filter(c=>(c.name+' '+c.description).toLowerCase().includes(search.toLowerCase())),matchingDevices=readable.filter(d=>d.name.toLowerCase().includes(deviceSearch.toLowerCase()));
 const counts={assigned:assignments.length,compliant:assignments.filter(a=>assignmentRuns(a).compliant===true).length,different:assignments.filter(a=>assignmentRuns(a).compliant===false).length};
 const currentNotice=notice?.scope===scopeKey?notice:null;
 // The page's tab counts and its primary follow the loaded lists and the editor.
 useEffect(()=>{if(visible)onCounts?.({configs:visible.configs.length,runs:visible.runs.length});},[visible,onCounts]);
 useEffect(()=>{onEditorChange?.(!!editor);},[!!editor,onEditorChange]);// eslint-disable-line react-hooks/exhaustive-deps -- Only opening and closing count, not every keystroke in the editor.
 // The page primary "Create configuration" asks for the editor with a new number; a request seen at mount opens nothing.
 useEffect(()=>{if(!createRequest||createRequest===handledCreate.current)return;handledCreate.current=createRequest;void openEditor();},[createRequest]);// eslint-disable-line react-hooks/exhaustive-deps -- Only a new request opens the editor; openEditor reads the latest state.

 const busyReason=busy?t('automation.busy'):undefined;
 const refresh=async()=>{setRefreshing(true);try{await load();}finally{setRefreshing(false);}};
 const createButton=(variant:'primary'|'secondary')=><Btn variant={variant} icon={Plus} blocked={busyReason} onClick={()=>void openEditor()}>{t('desired.createConfig')}</Btn>;
 // The device tab has its own head with the primary; on the Desired State page the page header holds both.
 const head=controlled?null:<SectionHead title={t('device.section.desired')} hideTitle description={scope?t('desired.subtitleDevice'):t('desired.subtitle')}
  actions={!reason&&<IconBtn icon={RefreshCw} label={t('network.refresh')} loading={refreshing} blocked={busyReason} onClick={()=>void refresh()}/>}
  primary={!reason&&!editor&&manage&&createButton('primary')}/>;
 if(controlled&&!tab)return null;
 if(reason)return <div className="sdx-panel-stack">{head}<Unavailable reason={reason}>{reason==='demo'&&scope?t('desired.unavailable.demo'):undefined}</Unavailable></div>;
 const retry=<Btn size="sm" loading={refreshing} onClick={()=>void refresh()}>{t('common.retry')}</Btn>;
 const closeEditor=()=>{editorGeneration.current++;fileGeneration.current++;setEditor(null);};
 const switchTab=(next:PanelTab)=>{if(busy)return;editorGeneration.current++;fileGeneration.current++;setTab(next);setSchedule(null);};
 const tabs=[{id:'devices',label:scope?t('fleet.col.device'):t('tree.devices'),...(visible?{count:assignments.length}:{})},{id:'configs',label:t('desired.configs'),...(visible?{count:configs.length}:{})},{id:'history',label:t('device.summary.history'),...(visible?{count:runs.length}:{})}];
 const deviceMode=(device:Device)=>agentModeLabel(device.management===1&&device.snapshot?.mode==='Management'?'Management':'ReadOnly',t);

 // ---- Devices ----
 const deviceColumns:DataColumn<Device>[]=[
  {id:'device',label:t('fleet.col.device'),primary:true,cell:device=><span className="sdx-cell-stack"><strong>{device.name}</strong><small>{online(device)?t('network.status.up'):'Offline'} · {deviceMode(device)}</small></span>},
  {id:'assignment',label:t('desired.assignment'),wrap:true,cell:device=>{const a=assignments.find(item=>item.serverId===device.id);return a?versionLabel(a.versionId):t('desired.noConfig');}},
  {id:'status',label:t('management.status'),cell:device=>{const a=assignments.find(item=>item.serverId===device.id),status=a?assignmentRuns(a).status:null;return status?<DesiredStatus label={status.label} tone={status.tone}/>:<DesiredStatus label={t('desired.notAssigned')} tone="neutral"/>;}},
  {id:'schedule',label:t('desired.schedule'),cell:device=>{const a=assignments.find(item=>item.serverId===device.id);return a?desiredScheduleLabel(a.intervalSeconds,locale):EMPTY_VALUE;}},
  ...(origin?[{id:'origin',label:t('rbac.origin'),wrap:true,cell:origin} satisfies DataColumn<Device>]:[]),
 ];
 const manageDevice=!!chosenDevice&&permitted(chosenDevice,viewer,'desired.manage');
 const scheduleReason=schedule?schedule.intervalSeconds===schedule.expectedIntervalSeconds?t('desired.blocked.noChange'):schedule.intervalSeconds>0&&testReason?testReason:schedule.intervalSeconds>0&&!schedule.consent?t('desired.blocked.consent'):busyReason:undefined;
 const deviceState=chosenDevice&&assignment?<DesiredDeviceState assignment={assignment} configs={configs} runs={runs} deviceName={chosenDevice.name} connected={online(chosenDevice)}>
  <div className="ds-actions">
   <Btn icon={ShieldCheck} blocked={testReason||(activeRun?t('desired.checkAfterJob'):busyReason)||undefined} onClick={()=>openConfirmation(assignment,'test')}>{t('network.check')}</Btn>
   <Btn variant={controlled?'secondary':'primary'} icon={CheckCircle2} blocked={applyReason||(activeRun?t('desired.applyAfterJob'):busyReason)||undefined} onClick={()=>openConfirmation(assignment,'apply')}>{t('desired.apply')}</Btn>
   <Btn variant="ghost" blocked={busyReason} onClick={()=>inspectAssignment(assignment)}>{t('desired.viewConfig')}</Btn>
   {assignmentLatest&&<Btn variant="ghost" onClick={()=>{setRunId(assignmentLatest.id);setTab('history');}}>{t('runbooks.lastRun')}</Btn>}
   {assignmentCompliance&&assignmentCompliance.id!==assignmentLatest?.id&&<Btn variant="ghost" onClick={()=>{setRunId(assignmentCompliance.id);setTab('history');}}>{t('desired.lastCheck')}</Btn>}
   {manageDevice&&<><span className="ds-actions-spacer"/>
    <Btn icon={CalendarClock} blocked={busyReason} onClick={()=>beginSchedule(assignment)}>{t('desired.changeSchedule')}</Btn>
    <Btn variant="danger" icon={Trash2} blocked={assignmentLatest?.state==='running'?t('desired.removeBlocked'):busyReason} onClick={()=>openConfirmation(assignment,'remove')}>{t('automation.removeAssignment')}</Btn>
   </>}
  </div>
  {(testReason||applyReason)&&<p className="ds-help">{[...new Set([testReason,applyReason].filter(Boolean))].join(' ')}</p>}
  {schedule?.assignmentId===assignment.id&&<section className="ds-subsection" aria-labelledby={panelId+'-schedule'}>
   <h4 id={panelId+'-schedule'}>{t('desired.changeSchedule')}</h4>
   <Field label={t('automation.checkInterval')} hint={schedule.intervalSeconds>0?t('desired.scheduleHint'):undefined}><Select value={schedule.intervalSeconds} disabled={busy} onChange={e=>setSchedule({...schedule,intervalSeconds:Number(e.target.value),consent:false})}>{[...new Set([...scheduleOptions,schedule.expectedIntervalSeconds])].sort((a,b)=>a-b).map(seconds=><option key={seconds} value={seconds}>{desiredScheduleLabel(seconds,locale)}</option>)}</Select></Field>
   {schedule.intervalSeconds>0&&<>{testReason&&<Notice tone="warning" icon={TriangleAlert}>{testReason}</Notice>}<Field inline label={t('desired.approveChecks')}><input type="checkbox" role="switch" checked={schedule.consent} disabled={busy} onChange={e=>setSchedule({...schedule,consent:e.target.checked})}/></Field></>}
   <div className="ds-actions"><Btn variant={controlled?'secondary':'primary'} loading={busy} blocked={scheduleReason} onClick={()=>void saveSchedule()}>{t('desired.saveSchedule')}</Btn><Btn variant="ghost" disabled={busy} onClick={()=>setSchedule(null)}>{t('common.cancel')}</Btn></div>
  </section>}
 </DesiredDeviceState>:chosenDevice?<Card><Empty icon={ShieldCheck} title={t('desired.noConfigFor',{name:chosenDevice.name})} action={<Btn onClick={()=>switchTab('configs')}>{t('desired.chooseConfig')}</Btn>}>{t('desired.chooseVersionHint')}</Empty></Card>:null;
 const devicesView=visible&&<>
  {!scope&&<KpiRow label={t('desired.fleetSummary')} entranceId="desired-kpis">
   <Kpi label={t('desired.assignedLabel')} value={counts.assigned} total={readable.length} icon={FileCode2}/>
   <Kpi label={t('desired.compliant')} value={counts.compliant} total={counts.assigned} icon={CheckCircle2} tone="success"/>
   <Kpi label={t('desired.drifted')} value={counts.assigned?counts.different:null} icon={TriangleAlert} tone={counts.different>0?'warning':'neutral'}/>
   <Kpi label={t('desired.noCheck')} value={counts.assigned?counts.assigned-counts.compliant-counts.different:null} icon={History} tone="neutral"/>
  </KpiRow>}
  {!scope&&<Card title={controlled?undefined:t('tree.devices')} icon={Server} iconTone="neutral" flush>
   <DataTable<Device> label={t('tree.devices')} variant="flush" cards columns={deviceColumns} rows={matchingDevices} rowKey={device=>device.id} highlightKey={chosenDevice?.id} onOpen={device=>{setSelectedDevice(device.id);setSchedule(null);}}
    toolbar={<Toolbar search={{value:deviceSearch,onChange:setDeviceSearch,label:t('groups.assign.filter'),placeholder:t('groups.assign.filter')}}/>} empty={{icon:Server,title:t('desired.noDevices')}}/>
  </Card>}
  {deviceState}
 </>;

 // ---- Configurations ----
 const assignReason=!validTargets.length?t('desired.blocked.noTargets'):interval>0&&!automaticConsent?t('desired.blocked.consent'):busyReason;
 const library=<aside className="ds-library" aria-label={t('desired.library')}>
  <label className="sdx-searchfield"><input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder={t('desired.filterConfigs')} aria-label={t('desired.filterConfigs')}/></label>
  <div className="ds-library-list">{matchingConfigs.map(config=><button type="button" className="ds-library-item" key={config.id} aria-current={config.id===selectedConfig?'true':undefined} onClick={()=>{if(!busy)choose(config);}}><FileCode2 size={16} aria-hidden/><span><strong>{config.name}</strong><small>{config.versions[0]?desiredFormats[config.versions[0].engine].short+' · v'+config.versions[0].version:t('desired.noVersion')} · {t('desired.versionCount',{count:config.versionCount??config.versions.length})}</small></span></button>)}</div>
  {!matchingConfigs.length&&configs.length>0&&<p className="ds-help">{t('customers.noMatch')}</p>}
 </aside>;
 const detail=book&&version?<Card title={book.name} icon={FileCode2} iconTone="accent" description={book.description||undefined}
  actions={manage&&<><Btn size="sm" icon={Plus} blocked={busyReason} onClick={()=>void openEditor(book,version)}>{t('runbooks.newVersionShort')}</Btn><Btn size="sm" variant="danger" icon={Trash2} blocked={!book.canDelete?book.deleteReason?serverMessageText(book.deleteReason,t):t('desired.blocked.manage'):busyReason} onClick={()=>{setActionError('');setDeleteConfirmation({scopeKey,config:book});}}>{t('desired.deleteConfig')}</Btn></>}>
  <div className="ds-device-state">
   <Field label={t('desired.fixedVersion')} hint={t('desired.immutable')}><Select value={version.id} disabled={busy} onChange={e=>{setSelectedVersion(e.target.value);setTargets(scope?[scope]:[]);setAutomaticConsent(false);}}>{book.versions.map(v=><option value={v.id} key={v.id}>v{v.version} · {desiredFormats[v.engine].short} · {stamp(v.createdAt,locale)}</option>)}</Select></Field>
   <DesiredVersionSource version={version} name={book.name} source={source} loading={sourceBusy||source?.id!==version.id&&!sourceError} error={sourceError}><IconBtn icon={Download} label={t('files.download')} blocked={busyReason??(sourceBusy||source?.id!==version.id?t('desired.blocked.sourceLoading'):undefined)} onClick={download}/></DesiredVersionSource>
   {manage&&<section className="ds-subsection" aria-labelledby={panelId+'-assign'}>
    <div className="ds-subsection-head"><div><h4 id={panelId+'-assign'}>{t('desired.assignVersionTitle')}</h4><p className="ds-help">{t('desired.onePerDevice',{versionLabel:versionLabel(version.id)})}</p></div><span className="ds-help">{t('groups.assign.selected',{length:validTargets.length})}</span></div>
    <Field label={t('automation.checkInterval')}><Select value={interval} disabled={busy} onChange={e=>{setIntervalSeconds(Number(e.target.value));setAutomaticConsent(false);}}>{scheduleOptions.map(seconds=><option key={seconds} value={seconds}>{desiredScheduleLabel(seconds,locale)}</option>)}</Select></Field>
    {targetRows.length?<div className="sdx-pick-list ds-targets">{targetRows.map(({device,assigned,readiness,reason:targetReason})=><div className="ds-target" key={device.id}>
     <label className="sdx-pick-row"><input type="checkbox" checked={!targetReason&&targets.includes(device.id)} disabled={busy||!!targetReason} aria-describedby={targetReason?panelId+'-target-'+device.id:undefined} onChange={e=>setTargets(e.target.checked?[...new Set([...targets,device.id])]:targets.filter(id=>id!==device.id))}/><span className="sdx-pick-text"><strong>{device.name}</strong><small>{assigned?t('desired.assignedTo',{versionLabel:versionLabel(assigned.versionId)}):t('desired.noAssignment')} · {deviceMode(device)}</small>
      {targetReason?<small id={panelId+'-target-'+device.id} className="ds-reason">{targetReason}</small>:assigned?<small><Check size={12} aria-hidden/> {t('desired.alreadyAssigned')}</small>:readiness?<small>{t('desired.assignPossible',{readiness})}</small>:null}</span></label>
     {assigned&&<Btn variant="ghost" size="sm" onClick={()=>{setSelectedDevice(device.id);switchTab('devices');}}>{t('desired.viewAssignment')}</Btn>}
    </div>)}</div>:<p className="ds-help">{t('desired.noDevicesAvailable')}</p>}
    {interval>0&&<Field inline label={t('desired.approveFixed')}><input type="checkbox" role="switch" checked={automaticConsent} disabled={busy} onChange={e=>setAutomaticConsent(e.target.checked)}/></Field>}
    <div className="ds-subsection-foot"><p className="ds-help">{t('desired.assignNoJob')}</p><Btn variant={controlled?'secondary':'primary'} loading={busy} blocked={assignReason} onClick={()=>void assign()}>{validTargets.length>1?t('desired.assignVersionMany',{version:version.version,count:validTargets.length}):t('desired.assignVersion',{version:version.version})}</Btn></div>
   </section>}
  </div>
 </Card>
  :pendingSelection?<Card><Empty icon={Check} title={t('desired.pendingSaved',{name:pendingSelection.name,version:pendingSelection.version??''})} action={<Btn icon={RefreshCw} loading={refreshing} blocked={busyReason} onClick={()=>void refresh()}>{t('desired.refreshLibrary')}</Btn>}>{t('desired.libraryStale')}</Empty></Card>
  :<Card><Empty icon={FileCode2} title={t('desired.library')} action={manage?createButton('secondary'):undefined}>{t('desired.libraryHint')}</Empty></Card>;
 const configsView=visible&&<div className="ds-library-layout">{configs.length>0&&library}<div className="ds-library-detail">{detail}</div></div>;

 // ---- Editor ----
 const draft=editor?editor.drafts[editor.engine]:null;
 const saveReason=editor&&!editor.name.trim()?t('desired.blocked.nameRequired'):editor?.input==='editor'&&!draft?.content.trim()?t('desired.blocked.contentRequired'):busyReason;
 const editorView=editor&&draft&&<Card title={editor.configId?t('desired.newFixed'):t('desired.createConfig')} icon={FileCode2} iconTone="accent" meta={`${t(desiredFormats[editor.engine].label)} · ${desiredFormats[editor.engine].extension}`} actions={<Btn variant="ghost" size="sm" icon={ArrowLeft} blocked={busy?t('kit.busy'):undefined} onClick={closeEditor}>{t('desired.backToLibrary')}</Btn>}>
  <div className="sdx-form-grid ds-editor">
   <div className="ds-two">
    <Field label={t('common.name')}><input value={editor.name} readOnly={!!editor.configId} disabled={busy} maxLength={120} onChange={e=>setEditor({...editor,name:e.target.value})} placeholder={t('desired.namePlaceholder')}/></Field>
    <Field label={t('common.description')}><input value={editor.description} readOnly={!!editor.configId} disabled={busy} maxLength={2000} onChange={e=>setEditor({...editor,description:e.target.value})} placeholder={t('desired.descriptionPlaceholder')}/></Field>
   </div>
   <fieldset className="ds-fieldset"><legend>{t('desired.formatLabel')}</legend><div className="ds-formats">{(Object.keys(desiredFormats) as DesiredEngine[]).map(engine=><button type="button" aria-pressed={editor.engine===engine} key={engine} onClick={()=>{if(busy)return;fileGeneration.current++;setEditor({...editor,engine});setActionError('');}}><FileCode2 size={16} aria-hidden/><span><strong>{t(desiredFormats[engine].label)}</strong><small>{desiredFormats[engine].extension}</small></span>{editor.engine===engine&&<Check size={14} aria-hidden/>}</button>)}</div><p className="ds-help">{t('desired.formatHint')}</p></fieldset>
   <Segmented<'editor'|'github'> label={t('desired.sourceKind')} value={editor.input} onChange={input=>{if(busy)return;fileGeneration.current++;setEditor({...editor,input});}} items={[{id:'editor',label:t('desired.editorFile'),icon:FileCode2},{id:'github',label:t('desired.githubImport'),icon:GitBranch}]}/>
   {editor.input==='github'?<section className="ds-subsection">
    <div className="ds-two">
     <Field label={t('desired.owner')}><input value={editor.github.owner} disabled={busy} onChange={e=>setEditor({...editor,github:{...editor.github,owner:e.target.value}})} placeholder="organisation"/></Field>
     <Field label={t('desired.repository')}><input value={editor.github.repository} disabled={busy} onChange={e=>setEditor({...editor,github:{...editor.github,repository:e.target.value}})} placeholder="server-configurations"/></Field>
     <Field label={t('desired.branch')}><input value={editor.github.ref} disabled={busy} onChange={e=>setEditor({...editor,github:{...editor.github,ref:e.target.value}})}/></Field>
     <Field label={t('desired.filePath')}><input value={editor.github.path} disabled={busy} onChange={e=>{const path=e.target.value,format=desiredFileEngine(path);setEditor({...editor,engine:format??editor.engine,github:{...editor.github,path}});}} placeholder={'windows/baseline'+desiredFormats[editor.engine].extension}/></Field>
    </div>
    <p className="ds-help">{t('desired.importHint')}</p>
    <details className="ds-disclosure"><summary><span>{t('desired.githubAccess')}</span><span>{visible?.github.privateAvailable?t('desired.privateConnected'):t('desired.publicRepos')}</span></summary><p className="ds-help">{visible?.github.privateAvailable?t('desired.privateAdmins'):t('desired.reposHint')}</p></details>
   </section>:<section className="ds-subsection">
    <div className="ds-subsection-head"><h4>{t('desired.sourceLabel',{language:desiredFormats[editor.engine].language})}</h4><div className="ds-actions"><input type="file" accept=".json,.ps1,.mof" hidden ref={file} onChange={e=>{const upload=e.target.files?.[0];if(upload)void importFile(upload);e.target.value='';}}/><Btn size="sm" icon={Upload} blocked={busyReason} onClick={()=>file.current?.click()}>{t('desired.loadFile')}</Btn>{editor.engine!=='mof'&&<Btn variant="ghost" size="sm" blocked={busyReason} onClick={()=>changeDraft({content:desiredTemplates[editor.engine]})}>{t('desired.insertExample')}</Btn>}</div></div>
    <Field label={t('desired.configLabel',{language:desiredFormats[editor.engine].language})} hint={`${t('desired.encoding',{extension:desiredFormats[editor.engine].extension})} · ${t('desired.editorBytes',{size:formatNumber(locale,new TextEncoder().encode(draft.content).length),limit:formatNumber(locale,65536)})}`}><textarea className="ds-code" value={draft.content} disabled={busy} onChange={e=>changeDraft({content:e.target.value})} placeholder={editor.engine==='mof'?t('desired.mofHint'):''} spellCheck={false}/></Field>
   </section>}
   {editor.engine==='powershell-dsc'&&<Field label={t('desired.configurationName')} hint={t('desired.configNameHint')}><input value={draft.configurationName} disabled={busy} onChange={e=>changeDraft({configurationName:e.target.value})} placeholder="ServerDeskConfig"/></Field>}
   {editor.engine!=='mof'&&<details className="ds-disclosure"><summary><span>{t('desired.params')}</span><span>{t('rdp.client.optional')}</span></summary><Field label={t('desired.paramsLabel')} hint={t('desired.paramsHint')}><textarea className="ds-code ds-parameters" value={draft.parameters} disabled={busy} onChange={e=>changeDraft({parameters:e.target.value})} spellCheck={false}/></Field></details>}
   <p className="ds-help">{t(desiredFormats[editor.engine].hint)}</p>
   <div className="ds-subsection-foot"><p className="ds-help">{t('desired.secretsHint')}</p><div className="ds-actions"><Btn variant="ghost" disabled={busy} onClick={closeEditor}>{t('common.cancel')}</Btn><Btn variant="primary" loading={busy} blocked={saveReason} onClick={()=>void save()}>{editor.input==='github'?t('desired.importCommit'):t('runbooks.saveVersion')}</Btn></div></div>
  </div>
 </Card>;

 // ---- History ----
 const runColumns:DataColumn<DesiredRun>[]=[
  {id:'device',label:t('desired.deviceVersion'),primary:true,wrap:true,cell:run=><span className="sdx-cell-stack"><strong>{deviceName(run.serverId)}</strong><small>{versionLabel(run.versionId)}</small></span>},
  {id:'action',label:t('management.firewall.action'),cell:run=>run.operation==='apply'?t('desired.apply'):t('network.check')},
  {id:'status',label:t('management.status'),cell:run=><DesiredStatus run={run}/>},
  {id:'started',label:t('desired.startedColumn'),cell:run=>stamp(run.createdAt,locale)},
 ];
 const historyView=visible&&<>
  <Card title={t('runbooks.runs')} icon={History} iconTone="neutral" description={t('desired.runsHint')} meta={t('audit.entries',{count:runs.length})} flush>
   <DataTable<DesiredRun> label={t('runbooks.runs')} variant="flush" cards columns={runColumns} rows={runs} rowKey={run=>run.id} highlightKey={runId||undefined} onOpen={run=>setRunId(run.id)} empty={{icon:History,title:t('desired.noRuns'),children:t('desired.noRunsHint')}}/>
  </Card>
  {selectedRun&&<>
   {runError&&<Notice tone="danger" icon={AlertTriangle} action={<Btn size="sm" onClick={()=>setRunAttempt(value=>value+1)}>{t('common.retry')}</Btn>}>{runError}</Notice>}
   <DesiredRunDetails loading={!detailedRun&&!runError} run={detailedRun??selectedRun} deviceName={deviceName(selectedRun.serverId)} versionLabel={versionLabel(selectedRun.versionId)}><Btn variant="ghost" size="sm" onClick={()=>setRunId('')}>{t('desired.closeDetails')}</Btn></DesiredRunDetails>
   {runBusy&&detailedRun&&<p className="ds-help" role="status">{t('desired.resourcesRefreshing')}</p>}
  </>}
 </>;

 // ---- Confirmations ----
 const confirmBlocked=confirm&&confirm.operation!=='remove'&&(!systemConsent||confirm.operation==='apply'&&!maintenanceConsent)?t('desired.blocked.consent'):undefined;
 const dialogOpen=!!confirm||!!deleteConfirmation;
 const content=!visible?(loadError?null:<Skeleton variant={tab==='configs'?'cards':'table'} label={t('desired.loading')} after={15000} action={retry}/>)
  :tab==='devices'?devicesView:tab==='configs'?configsView:historyView;
 return <div className="sdx-panel-stack ds-panel">
  {head}
  {currentNotice&&<DesiredFeedback text={currentNotice.text} warning={currentNotice.warning} onDismiss={()=>setNotice(null)}>{currentNotice.runId&&<Btn variant="ghost" size="sm" onClick={()=>{setRunId(currentNotice.runId!);setTab('history');setEditor(null);}}>{t('desired.viewJob')}</Btn>}</DesiredFeedback>}
  {actionError&&!dialogOpen&&<Notice tone="danger" icon={AlertTriangle}>{actionError}</Notice>}
  {loadError&&<Notice tone="danger" icon={AlertTriangle} action={retry}>{loadError}{visible?' '+t('console.staleData'):''}</Notice>}
  {controlled?editor&&tab==='configs'?editorView:content:editor?editorView:<>
   <Tabs variant="underline" label={t('desired.views')} panelId={panelId} value={ownTab} onChange={value=>switchTab(value as PanelTab)} items={tabs}/>
   <div id={panelId} role="tabpanel" aria-labelledby={tabId(panelId,ownTab)} className="sdx-panel-stack">{content}</div>
  </>}
  <ConfirmDialog open={!!confirm} onOpenChange={open=>{if(!open&&!busy)setConfirm(null);}} tone={confirm?.operation==='remove'?'danger':'default'}
   title={confirm?.operation==='remove'?t('automation.removeTitle'):confirm?.operation==='apply'?t('desired.applyTitle'):t('desired.checkTitle')}
   lines={confirm?[{label:t('fleet.col.device'),value:deviceName(confirm.assignment.serverId)},{label:t('desired.line.configuration'),value:versionLabel(confirm.assignment.versionId)}]:undefined}
   body={confirm?.operation==='remove'?t('desired.removeDescription'):t('desired.systemNote')}
   confirmLabel={confirm?.operation==='remove'?t('automation.removeAssignment'):confirm?.operation==='apply'?t('desired.apply'):t('network.check')} busy={busy} blocked={confirmBlocked} onConfirm={()=>void execute()}>
   {confirm&&confirm.operation!=='remove'&&<div className="ds-consent">
    <Field inline label={t('desired.approveRun')}><input type="checkbox" role="switch" checked={systemConsent} disabled={busy} onChange={e=>setSystemConsent(e.target.checked)}/></Field>
    {confirm.operation==='apply'&&<Field inline label={t('desired.approveChanges')}><input type="checkbox" role="switch" checked={maintenanceConsent} disabled={busy} onChange={e=>setMaintenanceConsent(e.target.checked)}/></Field>}
   </div>}
   {confirm&&actionError&&<Notice tone="danger" icon={AlertTriangle}>{actionError}</Notice>}
  </ConfirmDialog>
  <ConfirmDialog open={!!deleteConfirmation} onOpenChange={open=>{if(!open&&!busy)setDeleteConfirmation(null);}} tone="danger" title={t('desired.deleteTitle')}
   lines={deleteConfirmation?[{label:t('desired.line.configuration'),value:deleteConfirmation.config.name}]:undefined}
   body={t('desired.deleteDescription',{value:deleteConfig?.versionCount??deleteConfirmation?.config.versionCount??deleteConfirmation?.config.versions.length??0,value2:deleteConfig?.assignmentCount??deleteConfirmation?.config.assignmentCount??0})+'\n\n'+t('desired.deleteKeeps')}
   confirmLabel={t('desired.deleteConfig')} busy={busy} blocked={deleteConfig&&!deleteConfig.canDelete?deleteConfig.deleteReason?serverMessageText(deleteConfig.deleteReason,t):t('desired.blocked.manage'):!deleteConfig?t('desired.versionGone'):undefined} onConfirm={()=>void removeConfiguration()}>
   {deleteConfirmation&&actionError&&<Notice tone="danger" icon={AlertTriangle}>{actionError}</Notice>}
  </ConfirmDialog>
 </div>;
}
