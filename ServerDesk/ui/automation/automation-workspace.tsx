'use client';
// The three Automation pages (Runbooks, Desired State, Configuration drift) on the console kit. The page renders the
// header of its console frame with the one page primary (ui/shell/page-frame.ts), the routed tab bar (#automation/<page>/<tab>:
// frame.tab and frame.onTab, the items from the page's tab nodes in ui/shell/nav-model.ts), the load of GET /api/automation
// (scope key, sequence and abort guards, 15 s refresh and the console refresh, both never blank loaded data) and every
// /api/automation mutation through useStepUp: "Create template" and "Assign template" in Drawers, "Remove
// assignment" and "Start runbook" in the kit ConfirmDialog, toasts on success. RunbookPanel and DesiredStatePanel
// stay mounted on their page (their lists feed the tab counts) and render the view of the page tab.
import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {Plus} from 'lucide-react';
import {toast} from 'sonner';
import type {Viewer} from '@/lib/types';
import {api,ApiError,message,permitted,type Device} from '@/ui/base/api';
import {isOwner} from '@/ui/base/access-capabilities';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {useStepUp} from '@/ui/session/step-up-retry';
import RunbookPanel,{type RunbookCounts,type RunbookTab} from '@/ui/automation/runbook-panel';
import DesiredStatePanel,{type DesiredCounts,type DesiredView} from '@/ui/automation/desired-state-panel';
import {catalogCreateLockReason,showCatalogOwner} from '@/ui/base/catalog-owner';
import {assignmentScope,assignmentSchedules,automationKinds,automationRightReasons,automationRights,emptyAutomation,type AutomationAssignment,type AutomationData} from '@/ui/automation/automation-data';
import {AutomationAssignments} from '@/ui/automation/automation-assignments';
import {AssignTemplateDrawer,CreateTemplateDrawer} from '@/ui/automation/automation-template-drawers';
import {AutomationDeviceStatus,ReferenceDevices,originCell} from '@/ui/automation/automation-device-status';
import {automationPageTab,consoleRouteHash,type AutomationPage,type AutomationPageTab} from '@/lib/console-route';
import {pageTabNodes,routeNode} from '@/ui/shell/nav-model';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';
import {Btn,LoadFailed,RetryAction,Skeleton,Unavailable} from '@/ui/kit/kit';
import {Tabs,tabId,type TabItem} from '@/ui/kit/tabs';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import '@/ui/base/catalog-owner.css';
import {useLocale,useT} from '@/ui/base/locale';
export {automationGroupPath,effectiveDeviceAssignments} from '@/ui/automation/automation-data';

const runbookViews:Partial<Record<AutomationPageTab,RunbookTab>>={library:'runbooks',runs:'runs',schedules:'schedules'};
type Confirm={action:'remove'|'run';assignment:AutomationAssignment};
type Mutation={body:Record<string,unknown>;managementToken?:string};

export default function AutomationWorkspace({page,frame,servers,viewer,demo,onOpenDevice,runFocus}:{page:AutomationPage;
 /** The console frame (ui/shell/page-frame.ts): the page header, the refresh count and the page tab of the route. */
 frame?:PageFrame;servers:Device[];viewer:Viewer;demo:boolean;onOpenDevice:(id:string,section:'drift'|'desired'|'runbooks')=>void;
 /** A runbook run opened from the job panel: the Runs tab with that run's output drawer. */
 runFocus?:{serverId:string;runId:string;revision:number}|null}){
 const t=useT(),[locale]=useLocale(),panelId=useId(),kind=automationKinds[page];
 const tab=automationPageTab(page,frame?.tab),onTab=(next:AutomationPageTab)=>frame?.onTab(next);
 const scopeKey=JSON.stringify([kind,viewer.id,isOwner(viewer),viewer.permissions,servers.map(s=>[s.id,s.permissions])]),current=useRef(scopeKey);
 const [data,setData]=useState<AutomationData|null>(null),[dataScope,setDataScope]=useState(''),[loadError,setLoadError]=useState(''),[retrying,setRetrying]=useState(false);
 const [runbookCounts,setRunbookCounts]=useState<RunbookCounts|null>(null),[desiredCounts,setDesiredCounts]=useState<DesiredCounts|null>(null);
 const [createRequest,setCreateRequest]=useState(0),[editing,setEditing]=useState(false),[highlight,setHighlight]=useState('');
 const [createOpen,setCreateOpen]=useState(false),[assignOpen,setAssignOpen]=useState(false),[assignFrom,setAssignFrom]=useState(''),[drawerCount,setDrawerCount]=useState(0),[confirm,setConfirm]=useState<Confirm|null>(null);
 const reads=useRef({sequence:0,controller:null as AbortController|null});
 const [resetScope,setResetScope]=useState(scopeKey);
 // Reset before rendering children so a changed account or scope cannot expose the previous drawer or confirmation for a frame.
 if(resetScope!==scopeKey){setResetScope(scopeKey);setCreateOpen(false);setAssignOpen(false);setConfirm(null);setLoadError('');setHighlight('');}
 useLayoutEffect(()=>{current.current=scopeKey;},[scopeKey]);
 const load=useCallback(async()=>{if(demo)return;const generation=++reads.current.sequence,controller=new AbortController();reads.current.controller?.abort();reads.current.controller=controller;try{const next=await api<AutomationData>('/api/automation',undefined,controller.signal);if(controller.signal.aborted||generation!==reads.current.sequence||current.current!==scopeKey)return;setData(next);setDataScope(scopeKey);setLoadError('');}catch(e){if(controller.signal.aborted||generation!==reads.current.sequence||current.current!==scopeKey)return;setLoadError(message(e));if(e instanceof ApiError&&[401,403].includes(e.status)){setData(null);setDataScope('');}}},[demo,scopeKey]);
 // load commits state only after the API promise resolves; this effect starts its polling subscription.
 // eslint-disable-next-line react-hooks/set-state-in-effect -- The effect only starts the polling; load sets state only after the API response.
 useEffect(()=>{void load();const timer=demo?undefined:setInterval(()=>void load(),15000),requests=reads.current;return()=>{clearInterval(timer);requests.sequence++;requests.controller?.abort();};},[load,demo,scopeKey]);
 // A console refresh (top bar, R, palette) loads GET /api/automation again; the loaded data stays shown meanwhile.
 useFrameRefresh(frame,load);
 // Every mutation of /api/automation: a step-up code opens MfaStepUp and the same request goes out once more after it.
 const change=useStepUp<Mutation,unknown>({locale,needsStepUp:()=>false,send:({body,managementToken})=>api('/api/automation',managementToken?{...body,managementToken}:body)});
 const mutate=async(body:Record<string,unknown>,success:string)=>{const key=scopeKey;const result=await change.run({body});if(result===null||current.current!==key)return false;toast.success(success);await load();return true;};
 const visible=demo?emptyAutomation:dataScope===scopeKey?data:null;
 const templates=visible?.templates.filter(entry=>entry.kind===kind)??[],assignments=visible?.assignments.filter(a=>a.kind===kind)??[],groups=visible?.groups??[];
 const devices=servers.filter(s=>permitted(s,viewer,automationRights[kind])),canManage=isOwner(viewer)||devices.length>0;
 const ownership=visible?.catalog,showOwner=showCatalogOwner(ownership),createLock=catalogCreateLockReason(ownership,locale);
 const rightReason=demo?t('kit.unavailable.demo'):!canManage?t(automationRightReasons[kind]):undefined;
 const createBlocked=rightReason??(createLock||undefined),manageBlocked=rightReason??(change.busy?t('automation.busy'):undefined);
 const onRunbookCounts=useCallback((next:RunbookCounts)=>setRunbookCounts(previous=>previous&&previous.runbooks===next.runbooks&&previous.runs===next.runs&&previous.schedules===next.schedules?previous:next),[]);
 const onDesiredCounts=useCallback((next:DesiredCounts)=>setDesiredCounts(previous=>previous&&previous.configs===next.configs&&previous.runs===next.runs?previous:next),[]);
 const onEditorChange=useCallback((open:boolean)=>setEditing(open),[]);

 const openCreate=()=>{setDrawerCount(count=>count+1);setCreateOpen(true);};
 const openAssign=(templateId='')=>{setDrawerCount(count=>count+1);setAssignFrom(templateId);setAssignOpen(true);};
 const showAssignment=(id:string)=>{setHighlight(id);onTab('assignments');};
 const recurring=page==='runbooks'&&visible?assignmentSchedules(visible,servers,{group:t('fleet.col.group'),device:t('fleet.col.device')}):[];
 // The page primary: the same on every tab, blocked with its reason, left out while an editor holds the one primary.
 const primaryLabel=page==='runbooks'?t('runbooks.create'):page==='desired'?t('desired.createConfig'):t('automation.createTemplate');
 const primary=editing?null:<Btn variant="primary" icon={Plus} blocked={createBlocked} onClick={()=>{if(page==='drift')openCreate();else{onTab(page==='runbooks'?'library':'configurations');setCreateRequest(count=>count+1);}}}>{primaryLabel}</Btn>;
 const count=(value:number|undefined)=>value===undefined?{}:{count:value};
 const counts:Partial<Record<AutomationPageTab,number|undefined>>={
  library:runbookCounts?.runbooks,runs:runbookCounts?.runs,schedules:runbookCounts&&visible?runbookCounts.schedules+recurring.length:undefined,
  assignments:visible&&!demo?assignments.length:undefined,configurations:desiredCounts?.configs,history:desiredCounts?.runs,
 };
 // The tab bar from the page's tab nodes (ui/shell/nav-model.ts): their ids, labels and links.
 const route={view:'automation',page} as const,pageNode=routeNode(route);
 const items:TabItem[]=pageTabNodes(route).map(node=>{const id=node.tab as AutomationPageTab;return {id,label:t(node.label),...(demo?{}:count(counts[id])),href:consoleRouteHash(node.route)};});
 const retry=()=>{setRetrying(true);void load().finally(()=>setRetrying(false));};
 const retryAction=<RetryAction loading={retrying} onRetry={retry}/>;
 // Tabs that read GET /api/automation wait for it; the panels show their own loading.
 const needsData=tab==='assignments'||tab==='status'||tab==='schedules';
 const firstLoad=needsData&&!visible?loadError?null:<Skeleton variant={tab==='assignments'?'cards':'table'} label={t('automation.loading')} after={15000} action={retryAction}/>:null;
 const kindTab=visible&&tab==='assignments'?<AutomationAssignments kind={kind} templates={templates} assignments={assignments} groups={groups} servers={servers} showOwner={showOwner} createBlocked={createBlocked} manageBlocked={manageBlocked} showCreate={page!=='drift'} highlight={highlight||undefined}
   onCreate={openCreate} onAssign={openAssign} onStart={assignment=>setConfirm({action:'run',assignment})} onRemove={assignment=>setConfirm({action:'remove',assignment})}/>
  :visible&&tab==='status'&&page!=='desired'?<AutomationDeviceStatus kind={kind} servers={servers} data={visible} onOpenDevice={id=>onOpenDevice(id,kind==='runbook'?'runbooks':kind)}/>
  :tab==='reference'?<ReferenceDevices devices={devices} onOpenDevice={id=>onOpenDevice(id,'drift')}/>:null;
 const runbookView=runbookViews[tab]??null;
 const panels=page==='runbooks'?runFocus
   ?<RunbookPanel key={runFocus.runId+':'+runFocus.revision} servers={servers} viewer={viewer} demo={demo} serverId={runFocus.serverId} initialRunId={runFocus.runId} view={tab==='runs'?'runs':null}/>
   :<RunbookPanel servers={servers} viewer={viewer} demo={demo} view={runbookView&&(runbookView!=='schedules'||visible)?runbookView:null} assignmentSchedules={recurring} onShowAssignment={showAssignment} onShowLibrary={()=>onTab('library')} onCounts={onRunbookCounts} createRequest={createRequest} onEditorChange={onEditorChange}/>
  :page==='desired'?<DesiredStatePanel servers={servers} viewer={viewer} demo={demo} view={tab as DesiredView} onView={view=>onTab(view)} onCounts={onDesiredCounts} createRequest={createRequest} onEditorChange={onEditorChange} origin={server=>originCell(server,visible,kind,t)}/>:null;
 const scope=confirm?assignmentScope(confirm.assignment,groups,servers):null,scopeName=scope?.name??(confirm?.assignment.scopeType==='group'?t('fleet.col.group'):t('fleet.col.device'));
 const lines=confirm?[{label:t('automation.line.template'),value:confirm.assignment.templateName},{label:t('automation.line.scope'),value:scope?.path??scopeName}]:undefined;
 return <>
  {frameHeader(frame,primary)}
  <div className="sdx-embedded">
   <Tabs variant="underline" overflow="menu" label={t('automation.tabsLabel',{page:pageNode?t(pageNode.label):''})} panelId={panelId} value={tab} onChange={id=>{setHighlight('');onTab(id as AutomationPageTab);}} items={items}/>
   <div id={panelId} role="tabpanel" aria-labelledby={tabId(panelId,tab)} className="sdx-panel-stack">
    {demo?<Unavailable reason="demo"/>:<>
     {loadError&&(needsData||tab==='reference')&&<LoadFailed text={visible?loadError+' '+t('console.staleData'):loadError} loading={retrying} onRetry={retry}/>}
     {firstLoad}
     {kindTab}
     {panels}
    </>}
   </div>
  </div>
  {!demo&&<>
   <CreateTemplateDrawer key={'create:'+drawerCount} open={createOpen} kind={kind} devices={devices} ownership={ownership} busy={change.sending} onClose={()=>setCreateOpen(false)}
    onSubmit={body=>void mutate(body,t('automation.templateCreated')).then(done=>{if(done)setCreateOpen(false);})}/>
   <AssignTemplateDrawer key={'assign:'+drawerCount} open={assignOpen} kind={kind} templates={templates} initialTemplateId={assignFrom} groups={groups} devices={devices} servers={servers} showOwner={showOwner} busy={change.sending} onClose={()=>setAssignOpen(false)}
    onSubmit={body=>void mutate(body,t('automation.assignmentSaved')).then(done=>{if(done)setAssignOpen(false);})}/>
   <ConfirmDialog open={confirm?.action==='remove'} onOpenChange={open=>{if(!open&&!change.busy)setConfirm(null);}} tone="danger" title={t('automation.removeTitle')} lines={lines}
    body={confirm?t('automation.removeDescription',{templateName:confirm.assignment.templateName,value:scopeName}):''} confirmLabel={t('automation.removeAssignment')} busy={change.sending}
    onConfirm={()=>{if(confirm)void mutate({action:'remove-assignment',assignmentId:confirm.assignment.id,confirm:true},t('automation.assignmentRemoved')).then(done=>{if(done)setConfirm(null);});}}/>
   <ConfirmDialog open={confirm?.action==='run'} onOpenChange={open=>{if(!open&&!change.busy)setConfirm(null);}} title={t('automation.runTitle')} lines={lines}
    body={confirm?t('automation.runDescription',{templateName:confirm.assignment.templateName,value:scopeName}):''} confirmLabel={t('runbooks.start')} busy={change.sending}
    onConfirm={()=>{if(confirm)void mutate({action:'run',assignmentId:confirm.assignment.id,confirm:true,requestId:crypto.randomUUID()},t('automation.campaignStarted')).then(done=>{if(done)setConfirm(null);});}}/>
   <MfaStepUp {...change.dialog}/>
  </>}
 </>;
}
