'use client';
// The Dashboard (#dashboard, docs/dashboard.md): the default start page. Its focal point is the status line, which
// answers "Is everything running?" in one sentence, with the online count and its pulse. Below it the widgets of the
// account's layout stand on a grid of 4, 2 or 1 columns; each widget shows what its size holds. "Customize" turns on
// the edit mode on the page itself: widgets are added from the catalog, removed, moved and resized with a pointer,
// with the arrow keys or from their menu, and the page shows the draft until Save or Cancel. The Owner edits the
// default layout the same way from "More actions". Sample devices fill the widgets too, but their layout cannot change.
import {useCallback,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {Check,CircleCheck,LayoutTemplate,OctagonAlert,Plus,RotateCcw,Server as ServerIcon,SlidersHorizontal,TriangleAlert,X} from 'lucide-react';
import {toast} from 'sonner';
import {addDashboardWidget,builtInDashboardLayout,dashboardWidgetIds,moveDashboardWidget,removeDashboardWidget,resizeDashboardWidget,sameDashboardLayout,type DashboardLayout,type DashboardPreference,type DashboardWidget,type DashboardWidgetId} from '@/lib/dashboard-layout';
import type {AuditEntry,Job,Viewer} from '@/lib/types';
import {message,type Device} from '@/ui/base/api';
import {useClockAt,useClockValue} from '@/ui/base/clock-store';
import {useT} from '@/ui/base/locale';
import {reducedMotion} from '@/ui/base/motion';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {Btn,Empty,EntranceList,IconBtn,IconTile,Menu,Notice,cx,type IconTone,type IconType,type MenuEntry} from '@/ui/kit/kit';
import {useFlip} from '@/ui/kit/use-flip';
import {useRefreshCount} from '@/ui/shell/page-frame';
import {DashboardArt} from '@/ui/devices/dashboard/dashboard-art';
import {DashboardCatalogDrawer} from '@/ui/devices/dashboard/dashboard-catalog-drawer';
import {WidgetEditControls,WidgetResizeHandle,moveHandleId,resizeBlockKeys} from '@/ui/devices/dashboard/dashboard-edit';
import {dashboardStatus,layoutSaveValue,resizeStep,shownWidgetSize,widgetAvailable,type DashboardStatus,type DashboardTone,type ResizeDirection,type WidgetContext} from '@/ui/devices/dashboard/dashboard-model';
import {dashboardWidgetMeta,type WidgetBase} from '@/ui/devices/dashboard/dashboard-widget-parts';
import {ActivityWidget,AgentsWidget,AlarmTrendWidget,AlarmWeekWidget,AlarmsWidget,AutostartWidget,CertificatesWidget,CrashesWidget,CustomersWidget,DefenderWidget,DiskHealthWidget,DiskSpaceWidget,EncryptionWidget,FailedJobsWidget,HealthWidget,JobsWidget,LoadWidget,OfflineWidget,OsSupportWidget,PinnedWidget,RestartWidget,RunbooksWidget,StatusWidget,UpdatesWidget} from '@/ui/devices/dashboard/dashboard-widgets';
import {useAlarmWeek} from '@/ui/devices/dashboard/use-alarm-week';
import {useDashboardDrag} from '@/ui/devices/dashboard/use-dashboard-drag';
import {useDashboardLayout} from '@/ui/devices/dashboard/use-dashboard-layout';
import {useGridColumns} from '@/ui/devices/dashboard/use-grid-columns';
import '@/ui/devices/dashboard/dashboard-view.css';

const hourMs=3_600_000;
const statusIcons:Readonly<Record<DashboardTone,IconType>>={neutral:ServerIcon,danger:OctagonAlert,warning:TriangleAlert,success:CircleCheck};
const statusTones:Readonly<Record<DashboardTone,IconTone>>={neutral:'neutral',danger:'danger',warning:'warning',success:'success'};
const statusKey=(status:DashboardStatus)=>`${status.headline}:${status.tone}:${Object.values(status.counts).join(',')}`;
/** The ids of the header buttons the page moves the focus to when the edit mode starts and ends. */
const customizeId='dashboard-customize',addWidgetId='dashboard-add-widget';
const noAudit:readonly AuditEntry[]=[],noIds:readonly string[]=[],noCustomers:readonly {id:string;name:string}[]=[];

/** The focal point: the state of the devices in one sentence, and how many of them are online now. */
function StatusLine({status}:{status:DashboardStatus}){
 const t=useT(),{counts}=status;
 const headline=status.headline==='alarms'?t('dashboard.status.alarms',{count:counts.alarms}):status.headline==='offline'?t('dashboard.status.offline',{count:counts.offline}):t('dashboard.status.fine');
 const detail=t(status.headline==='alarms'?'dashboard.status.alarmsDetail':status.headline==='offline'?'dashboard.status.offlineDetail':'dashboard.status.fineDetail');
 return <section className="sdx-dash-status" aria-label={t('dashboard.status.label')} data-tone={status.tone}>
  <IconTile icon={statusIcons[status.tone]} tone={statusTones[status.tone]}/>
  <div className="sdx-dash-status-text"><h2>{headline}</h2><p>{detail}</p></div>
  <span className="sdx-dash-online"><i className={cx('sdx-dash-dot',counts.online>0&&'sdx-dash-pulse')} aria-hidden="true"/>{t('dashboard.status.online',{online:counts.online,count:counts.devices})}</span>
 </section>;
}

export type DashboardViewProps={
 /** The page header of the Dashboard's navigation node with the given actions and primary action (the console builds it). */
 header:(actions:ReactNode,primary?:ReactNode)=>ReactNode;
 servers:Device[];jobs:Job[];viewer:Viewer;demo:boolean;saving:boolean;
 /** 760px or narrower: the header actions are icon buttons. */
 narrow:boolean;
 /** A global Owner: may edit the default layout, add the first device and open the audit log. */
 owner:boolean;
 /** The account's pinned devices in pin order (the console's live pin state). */
 pinnedIds?:readonly string[];
 /** The customers the viewer sees (ConsoleData.customers). */
 customers?:readonly {id:string;name:string}[];
 /** The audit entries the console carries: the portal's (Owner) and those of the devices whose security events the viewer may read. */
 audit?:readonly AuditEntry[];deviceAudit?:readonly AuditEntry[];
 /** The account's layout and the default layout (ConsoleData.preferences.dashboard); undefined before the first load. */
 preference?:DashboardPreference;
 onPreference:(next:DashboardPreference)=>void;
 /** The console's refresh count: the alarm week loads again with it. */
 refreshKey:number;
 /** A new number turns on the edit mode (the palette action). */
 customizeRequest:number;
 /** Opens a console hash with a history entry. */
 onNavigate:(hash:string)=>void;
 onAddDevice:()=>void;onSelectJob:(job:Job)=>void;onCancelJob:(job:Job)=>void;
 /** The alarm week loader of the tests; the default calls GET /api/dashboard. */
 loadWeek?:Parameters<typeof useAlarmWeek>[0]['load'];
 saveLayout?:Parameters<typeof useDashboardLayout>[0]['save'];
};

export default function DashboardView({header,servers,jobs,viewer,demo,saving,narrow,owner,pinnedIds=noIds,customers=noCustomers,audit=noAudit,deviceAudit=noAudit,preference,onPreference,refreshKey,customizeRequest,onNavigate,onAddDevice,onSelectJob,onCancelJob,loadWeek,saveLayout}:DashboardViewProps){
 const t=useT();
 // The page renders again when the status changes (a device goes offline, an alarm opens), not on every tick.
 const status=dashboardStatus(servers,useClockAt(now=>statusKey(dashboardStatus(servers,now)))),hour=useClockValue(now=>Math.floor(now/hourMs));
 const stored=preference??{own:null,default:builtInDashboardLayout},[boardRef,captureBoard]=useFlip<HTMLDivElement>(),[measureRef,columns]=useGridColumns<HTMLDivElement>();
 const board=useCallback((node:HTMLDivElement|null)=>{boardRef.current=node;measureRef(node);},[boardRef,measureRef]);
 const [catalog,setCatalog]=useState(false),[discard,setDiscard]=useState(false),[announced,setAnnounced]=useState('');
 // After a step the focus goes to the control that took it (a moved widget keeps its handle), and an added widget scrolls into view.
 const refocus=useRef(''),reveal=useRef('');
 useLayoutEffect(()=>{
  if(refocus.current){document.getElementById(refocus.current)?.focus();refocus.current='';}
  if(reveal.current){document.getElementById(reveal.current)?.scrollIntoView?.({block:'nearest',behavior:reducedMotion()?'auto':'smooth'});reveal.current='';}
 });
 const layout=useDashboardLayout({
  preference:stored,onSaved:onPreference,save:saveLayout,
  beforeChange:captureBoard,
  done:mode=>{setCatalog(false);setAnnounced('');refocus.current=customizeId;toast.success(t(mode==='own'?'dashboard.layout.saved':'dashboard.default.saved'));},
  failed:failure=>toast.error(message(failure)),
 });
 const edit=layout.edit,draft=layout.layout;
 const context:WidgetContext={customers:customers.length,audit:owner||servers.some(server=>server.permissions?.includes('security.events'))};
 const shown=draft.filter(widget=>widgetAvailable(widget.id,context));
 const weekShown=status.headline!=='none'&&shown.some(widget=>widget.id==='alarm-week'||widget.id==='alarm-trend');
 const week=useAlarmWeek({demo,enabled:weekShown,now:hour*hourMs,revision:`${refreshKey}:${hour}:${status.counts.alarms}`,load:loadWeek});
 const blocked=demo?t('kit.unavailable.demo'):undefined;
 const name=(id:DashboardWidgetId)=>t(dashboardWidgetMeta[id].title);

 // ---- The edit mode: every step changes the draft, says what happened and keeps the focus ----
 const setDraft=(next:DashboardLayout,follow=false)=>{if(edit)layout.change({...edit,draft:next,follow});};
 const {moving,resizing,moveStart,resizeStart,ghost}=useDashboardDrag({enabled:!!edit,layout:draft,columns,container:boardRef,onLayout:setDraft});
 const start=(mode:'own'|'default')=>{if(demo||edit)return;setAnnounced('');refocus.current=addWidgetId;layout.start(mode);};
 const customize=()=>start('own');
 useRefreshCount(customizeRequest,customize);
 const leave=()=>{setCatalog(false);setDiscard(false);setAnnounced('');refocus.current=customizeId;layout.cancel();};
 const cancel=()=>{if(layout.dirty)setDiscard(true);else leave();};
 const move=(widget:DashboardWidget,to:number)=>{
  const target=shown[to];
  if(!target||target.id===widget.id)return;
  const next=moveDashboardWidget(draft,widget.id,draft.findIndex(item=>item.id===target.id));
  if(next===draft)return;
  refocus.current=moveHandleId(widget.id);
  setAnnounced(t('dashboard.edit.moved',{name:name(widget.id),position:to+1,total:shown.length}));
  setDraft(next);
 };
 const resize=(widget:DashboardWidget,direction:ResizeDirection)=>{
  const step=resizeStep(widget,direction,columns);
  // A step at a limit changes nothing; the reason is said, as the menu shows it.
  if('blocked' in step){setAnnounced(t(resizeBlockKeys[step.blocked]));return;}
  const size=shownWidgetSize(step,columns);
  setAnnounced(t('dashboard.edit.resized',{name:name(widget.id),width:size.w,height:size.h}));
  setDraft(resizeDashboardWidget(draft,widget.id,step.w,step.h));
 };
 // From the board the focus goes to the next widget (else the one before, else "Add widget…"); the catalog keeps it on its button.
 const remove=(id:DashboardWidgetId,fromBoard=true)=>{
  const index=shown.findIndex(widget=>widget.id===id),neighbour=shown[index+1]??shown[index-1];
  if(fromBoard)refocus.current=neighbour?moveHandleId(neighbour.id):addWidgetId;
  setAnnounced(t('dashboard.edit.removed',{name:name(id)}));
  setDraft(removeDashboardWidget(draft,id));
 };
 const add=(id:DashboardWidgetId)=>{
  reveal.current='dashboard-cell-'+id;
  setAnnounced(t('dashboard.edit.added',{name:name(id)}));
  setDraft(addDashboardWidget(draft,id));
 };
 const openCatalog=()=>{if(demo)return;if(!edit)start('own');setCatalog(true);};
 // Back to the layout the mode starts from: the default layout (own), the built-in layout (default).
 const own=edit?.mode!=='default',base=own?stored.default:builtInDashboardLayout;
 const atBase=!!edit&&(own?layoutSaveValue(edit,stored)===null:sameDashboardLayout(draft,builtInDashboardLayout));
 const reset=()=>{setAnnounced('');setDraft(base,own);};

 // ---- Header ----
 const resetEntry:MenuEntry={id:'reset',label:t(own?'dashboard.layout.reset':'dashboard.default.restore'),icon:RotateCcw,blocked:atBase?t(own?'dashboard.layout.resetBlocked':'dashboard.default.restoreBlocked'):undefined,onSelect:reset};
 const saveBlocked=layout.dirty?undefined:t('common.noChanges');
 const actions=edit?<>
  {narrow?<IconBtn id={addWidgetId} icon={Plus} label={t('dashboard.edit.add')} onClick={openCatalog}/>:<Btn id={addWidgetId} icon={Plus} onClick={openCatalog}>{t('dashboard.edit.add')}</Btn>}
  <Menu label={t('dashboard.moreActions')} entries={[resetEntry]}/>
  {narrow?<IconBtn icon={X} label={t('common.cancel')} onClick={cancel}/>:<Btn variant="ghost" onClick={cancel}>{t('common.cancel')}</Btn>}
 </>:<>
  {owner&&!demo&&<Menu label={t('dashboard.moreActions')} entries={[{id:'default-layout',label:t('dashboard.default.edit'),icon:LayoutTemplate,onSelect:()=>start('default')}]}/>}
  {narrow?<IconBtn id={customizeId} icon={SlidersHorizontal} label={t('dashboard.customize')} blocked={blocked} onClick={customize}/>
   :<Btn id={customizeId} icon={SlidersHorizontal} blocked={blocked} onClick={customize}>{t('dashboard.customize')}</Btn>}
 </>;
 const primary=edit?narrow
  ?<IconBtn icon={Check} variant={layout.dirty?'primary':'secondary'} label={t('common.save')} loading={layout.saving} blocked={saveBlocked} onClick={()=>void layout.submit()}/>
  :<Btn variant={layout.dirty?'primary':'secondary'} loading={layout.saving} blocked={saveBlocked} onClick={()=>void layout.submit()}>{t('common.save')}</Btn>:undefined;

 // ---- Widgets ----
 const widget=(id:DashboardWidgetId,base:WidgetBase):ReactNode=>{
  const jobProps={jobs,servers,viewer,demo,saving,onSelectJob,onCancelJob};
  switch(id){
   case 'alarms':return <AlarmsWidget servers={servers} {...base}/>;
   case 'alarm-week':return <AlarmWeekWidget state={week} {...base}/>;
   case 'alarm-trend':return <AlarmTrendWidget state={week} {...base}/>;
   case 'health':return <HealthWidget servers={servers} {...base}/>;
   case 'offline':return <OfflineWidget servers={servers} {...base}/>;
   case 'status':return <StatusWidget servers={servers} {...base}/>;
   case 'pinned':return <PinnedWidget servers={servers} pinnedIds={pinnedIds} {...base}/>;
   case 'customers':return <CustomersWidget servers={servers} customers={customers} {...base}/>;
   case 'load':return <LoadWidget servers={servers} {...base}/>;
   case 'disk-space':return <DiskSpaceWidget servers={servers} {...base}/>;
   case 'updates':return <UpdatesWidget servers={servers} {...base}/>;
   case 'restart':return <RestartWidget servers={servers} {...base}/>;
   case 'os-support':return <OsSupportWidget servers={servers} {...base}/>;
   case 'agents':return <AgentsWidget servers={servers} {...base}/>;
   case 'defender':return <DefenderWidget servers={servers} {...base}/>;
   case 'encryption':return <EncryptionWidget servers={servers} {...base}/>;
   case 'certificates':return <CertificatesWidget servers={servers} {...base}/>;
   case 'autostart':return <AutostartWidget servers={servers} {...base}/>;
   case 'disk-health':return <DiskHealthWidget servers={servers} {...base}/>;
   case 'crashes':return <CrashesWidget servers={servers} {...base}/>;
   case 'jobs':return <JobsWidget {...jobProps} {...base}/>;
   case 'failed-jobs':return <FailedJobsWidget {...jobProps} {...base}/>;
   case 'runbooks':return <RunbooksWidget {...jobProps} {...base}/>;
   case 'activity':return <ActivityWidget servers={servers} audit={audit} deviceAudit={deviceAudit} owner={owner} {...base}/>;
  }
 };
 return <>
  {header(actions,primary)}
  {status.headline==='none'
   ?<div className="sdx-dash-page-empty"><Empty art={<DashboardArt kind="devices"/>} title={t('dashboard.empty.devices')}
     action={owner&&!demo?<Btn size="sm" icon={Plus} onClick={onAddDevice}>{t('console.addDevice')}</Btn>:undefined}>{t(owner?'dashboard.empty.devicesOwner':'dashboard.empty.devicesOther')}</Empty></div>
   :<>
    <StatusLine status={status}/>
    {edit&&<div className="sdx-dash-edit-note"><Notice tone="info" icon={SlidersHorizontal}>{t(own?'dashboard.edit.own':'dashboard.edit.default')} {t('dashboard.edit.how')}</Notice></div>}
    <div ref={board} className="sdx-dash-board" data-columns={columns} data-editing={edit?true:undefined} data-moving={moving?true:undefined}>
     {shown.length
      ?<EntranceList id="dashboard-tiles" className="sdx-dash-grid">{shown.map((item,index)=>{
       const title=name(item.id),size=shownWidgetSize(item,columns),editProps={widget:item,name:title,index,total:shown.length,columns,onMove:(to:number)=>move(item,to),onResize:(direction:ResizeDirection)=>resize(item,direction),onRemove:()=>remove(item.id)};
       return <div key={item.id} id={'dashboard-cell-'+item.id} className="sdx-dash-cell" data-flip={item.id} data-widget={item.id} data-w={size.w} data-h={size.h}
        data-moving={moving===item.id||undefined} data-resizing={resizing===item.id||undefined} onPointerDown={edit?moveStart(item.id,'cell'):undefined}>
        {widget(item.id,{size,onNavigate,edit:edit?<WidgetEditControls {...editProps} onMoveStart={moveStart(item.id,'handle')}/>:undefined})}
        {edit&&<WidgetResizeHandle {...editProps} onResizeStart={resizeStart(item.id)}/>}
       </div>;
      })}</EntranceList>
      :<div className="sdx-dash-page-empty"><Empty art={<DashboardArt kind="hidden"/>} title={t('dashboard.empty.board')}
        action={<Btn size="sm" icon={Plus} blocked={blocked} onClick={openCatalog}>{t('dashboard.edit.add')}</Btn>}>{t('dashboard.empty.boardText')}</Empty></div>}
    </div>
    {moving&&<div ref={ghost} className="sdx-dash-ghost" aria-hidden="true"><IconTile icon={dashboardWidgetMeta[moving].icon} size="sm"/>{name(moving)}</div>}
    <p className="sr-only" role="status">{announced}</p>
   </>}
  {edit&&<DashboardCatalogDrawer open={catalog} draft={draft} available={dashboardWidgetIds.filter(id=>widgetAvailable(id,context))} onAdd={add} onRemove={id=>remove(id,false)} onClose={()=>setCatalog(false)}/>}
  <ConfirmDialog open={discard} onOpenChange={setDiscard} title={t('kit.discard.title')} body={t('dashboard.edit.discardBody')} confirmLabel={t('common.discard')} cancelLabel={t('kit.discard.keep')} tone="danger" onConfirm={leave}/>
 </>;
}
