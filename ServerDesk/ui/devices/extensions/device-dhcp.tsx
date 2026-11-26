'use client';
// The DHCP server of one device (docs/dhcp-server.md): the latest read of the
// DHCP plugin (GET /api/dhcp?serverId=). The KPI row leads (IPv4 scopes,
// addresses in use with a meter, leases, the fullest scope), then the server
// facts and six sections in pill tabs. A scope opens its drawer. "Read again"
// queues the plugin job dhcp-read (POST /api/plugins) and reloads the data when
// the job ends. With plugin 1.1.0 every section has its change actions: a
// secondary Btn per section and a row Menu, each blocked with the first reason
// of dhcpManageBlocked. A change opens its drawer (dhcp-forms.tsx), then the
// confirmation, then POST /api/dhcp; while change jobs of the device are open
// the head counts them, and the data reload once the last one ends. Demo mode
// shows the sample server of ui/shell/demo-dhcp.ts with every change blocked.
// Changes run with the technician's AD account (docs/plugin-ad-sign-in.md): the
// head shows the account chip before "Read again", a change on a device (or
// partner) without a sign-in opens the AD sign-in first, then the confirmation,
// which names the account.
import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {toast} from 'sonner';
import {Ban,ChevronLeft,CopyCheck,Gauge,Layers,ListTree,Lock,Network,Pencil,Plus,Power,PowerOff,RefreshCw,Router,Search,ServerCog,SlidersHorizontal,Trash2,TriangleAlert,Users,X} from 'lucide-react';
import type {Job,Server,Viewer} from '@/lib/types';
import type {Confirmation} from '@/ui/base/confirmation';
import {dhcpFieldErrors,dhcpManageBlocked,dhcpPartnerDevice,isDhcpChangeOperation,PLUGIN_SECRETS,type DhcpChangeOperation,type DhcpFieldError,type DhcpPartnerCandidate} from '@/lib/dhcp-changes';
import {dhcpChange,dhcpChangePartner,dhcpConfirmation,dhcpFormOperation,dhcpReplicateConfirmation,dhcpReplicatePartner,DhcpFormDrawer,type DhcpChange,type DhcpConfirmContext,type DhcpForm,type DhcpPartnerOption} from '@/ui/devices/extensions/dhcp-forms';
import {adSessionsNow,ensureAdSessions,PluginAccountChip} from '@/ui/devices/extensions/plugin-ad';
import {adSessionForDevice,deviceDirectory} from '@/lib/plugin-ad';
import {demoDhcpPlugin} from '@/ui/shell/demo-dhcp';
import {DHCP_NO_SUPERSCOPE,dhcpDuration,dhcpKpis,dhcpPolicies,dhcpReservations,filterDhcpLeases,filterDhcpScopes,type DhcpFailover,type DhcpIpv4Scope,type DhcpIpv6Scope,type DhcpLease,type DhcpOption,type DhcpPolicy,type DhcpSnapshot} from '@/lib/dhcp';
import type {DeviceDhcpView} from '@/lib/server/extensions/plugin-data';
import {snapshotPlugin} from '@/lib/plugin-catalog';
import {connectionKind} from '@/lib/device-connection';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {demoDhcpSnapshot} from '@/ui/shell/demo-dhcp';
import {agentMessageText,agentMessageTextOr} from '@/lib/agent-messages';
import {EMPTY_VALUE,formatUntil} from '@/lib/i18n/format';
import {api,message,permitted} from '@/ui/base/api';
import {Btn,Card,Drawer,Empty,Facts,IconBtn,Kpi,KpiRow,Menu,Meter,Notice,PanelUnavailable,SectionHead,Segmented,Skeleton,StatusPill,exactTime,relativeTime,type EmptyProps,type MenuEntry} from '@/ui/kit/kit';
import {BulkBar,DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {Select} from '@/ui/kit/field';
import {Tabs} from '@/ui/kit/tabs';
import {useLocale,useT,type Translate} from '@/ui/base/locale';

export type DhcpSection='scopes'|'leases'|'reservations'|'options'|'policies'|'failover';
const sections:readonly DhcpSection[]=['scopes','leases','reservations','options','policies','failover'];
const leaseStates=['active','expired','declined','reserved','other'] as const;
const failoverStates=['normal','communicationInterrupted','partnerDown','potentialConflict','conflictDone','resolutionInterrupted','recover','recoverWait','recoverDone','paused','startup','init','shutdown','noState'] as const;
type Props={server:Server;viewer:Viewer;demo:boolean;now:number;jobs:Job[];onBack?:()=>void;
 /** The install flow of the Plugins area; blocked carries its reason. */
 onInstall:()=>void;installBlocked?:string;
 /** Opens Management → Services (a stopped DHCP Server service). */
 onOpenServices:()=>void;
 /** The visible devices: the failover partner candidates of the client. */
 devices?:readonly Server[];
 /** The console confirmation; every change goes through it to POST /api/dhcp. */
 onConfirm?:(confirmation:Confirmation)=>void};

/** The change actions of the view (DhcpBody); absent, the view shows no change controls. */
export type DhcpManage={
 /** The reason why the operation cannot run now, or undefined. */
 blocked:(operation:DhcpChangeOperation)=>string|undefined;
 /** The reason why a partner-dependent action cannot run: the partner is no device here. */
 partnerBlocked:(partner:string)=>string|undefined;
 open:(form:DhcpForm)=>void;
 change:(change:DhcpChange)=>void;
 replicate:(relationship:string,scopeId?:string)=>void;
};

// A request of the command palette ("New DHCP scope"): the view opens the scope form once it shows this device.
let pendingForm:{serverId:string;form:DhcpForm}|null=null;
const pendingEvent='serverdesk:dhcp-form';
/** Opens a DHCP form in the view of this device, now or when the view mounts. */
export function requestDhcpForm(serverId:string,form:DhcpForm={kind:'scope',family:'ipv4'}){pendingForm={serverId,form};if(typeof window!=='undefined')window.dispatchEvent(new Event(pendingEvent));}
/** The DHCP change jobs of a device that wait or run. */
export const openDhcpChangeJobs=(jobs:readonly Job[],serverId:string)=>jobs.filter(job=>job.serverId===serverId&&job.action==='plugin-job'&&isDhcpChangeOperation(job.target)&&(job.state==='pending'||job.state==='running'));
/** The partner candidates of the client: the other visible devices that report the DHCP plugin. */
export function dhcpClientPartners(devices:readonly Server[],serverId:string):DhcpPartnerCandidate[]{
 return devices.filter(device=>device.id!==serverId&&snapshotPlugin(device.snapshot,'dhcp')).map(device=>{
  const host=device.snapshot?.hostname,domain=device.snapshot?.domain;
  return {id:device.id,name:device.name,serverName:host?(domain?`${host}.${domain}`:host):null,addresses:(device.snapshot?.networks??[]).flatMap(item=>item.addresses??[])};
 });
}

/** A lease duration as words: "8 days", "12 hours", or "Unlimited" for null. */
export function dhcpDurationLabel(seconds:number|null,t:Translate){
 const value=dhcpDuration(seconds);
 if(!value)return t('dhcp.unlimited');
 return t(value.unit==='days'?'dhcp.duration.days':value.unit==='hours'?'dhcp.duration.hours':value.unit==='minutes'?'dhcp.duration.minutes':'dhcp.duration.seconds',{count:value.value});
}
/** The conditions of a policy as one line, for example "MAC address equals 00-15-5D*, 00-1D-D8* OR …". */
export function dhcpConditionSummary(policy:DhcpPolicy,t:Translate){
 const joiner=` ${t(policy.condition==='and'?'dhcp.condition.and':'dhcp.condition.or')} `;
 return policy.criteria.map(criterion=>t('dhcp.criterion',{type:t(`dhcp.criterion.${criterion.type}`),operator:t(criterion.operator==='equals'?'dhcp.operator.equals':'dhcp.operator.notEquals'),values:criterion.values.join(', ')})).join(joiner)||EMPTY_VALUE;
}
/** The mode of a failover relationship: "Load balance 50 %" or "Hot standby, active, reserve 5 %". */
export function dhcpFailoverMode(relation:DhcpFailover,t:Translate){
 return relation.mode==='loadBalance'?t('dhcp.mode.loadBalance',{percent:relation.loadBalancePercent??0}):t('dhcp.mode.hotStandby',{role:t(relation.serverRole==='standby'?'dhcp.role.standby':'dhcp.role.active'),percent:relation.reservePercent??0});
}
const failoverState=(state:string,t:Translate)=>(failoverStates as readonly string[]).includes(state)?t(`dhcp.failover.state.${state as typeof failoverStates[number]}`):state;
const leaseState=(state:DhcpLease['state'],t:Translate)=>t(`dhcp.lease.state.${state}`);
/** The account chip gate of DHCP: the right Manage DHCP and its own missing-right text. */
const dhcpAccountGate={permission:'dhcp.manage',rightKey:'dhcp.blocked.manageRight'} as const;
const optionLabel=(option:DhcpOption)=>`${option.code} ${option.name}`.trim();

/** The row Menu column of a DHCP list (nodiverna-ui §4): hidden head, sdx-col-actions, also in card mode; none without change actions. */
function actionsColumn<Row>(t:Translate,name:(row:Row)=>string,list:((row:Row)=>MenuEntry[])|undefined):DataColumn<Row>[]{
 return list?[{id:'actions',label:t('dhcp.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:row=><Menu label={t('dhcp.actionsFor',{name:name(row)})} entries={list(row)}/>}]:[];
}
type Locale=Parameters<typeof relativeTime>[2];
/** The columns of a lease list (the Leases section and the scope drawers). */
function leaseColumns(t:Translate,locale:Locale,now:number,menu?:(lease:DhcpLease)=>MenuEntry[]):DataColumn<DhcpLease>[]{
 return [
  {id:'address',label:t('dhcp.col.address'),primary:true,mono:true,cell:item=>item.address},
  {id:'name',label:t('dhcp.col.name'),cell:item=>item.name??EMPTY_VALUE},
  {id:'client',label:t('dhcp.col.clientId'),mono:true,cell:item=>item.clientId},
  {id:'scope',label:t('dhcp.col.scope'),mono:true,cell:item=>item.scope},
  {id:'state',label:t('dhcp.col.state'),cell:item=>leaseState(item.state,t)},
  {id:'expires',label:t('dhcp.col.expires'),cell:item=>item.expiresAt?<span title={exactTime(item.expiresAt,locale)}>{formatUntil(locale??'en',Date.parse(item.expiresAt),now)}</span>:t('dhcp.never')},
  ...actionsColumn(t,item=>item.address,menu),
 ];
}
/** The columns of an option list (server options and scope options). */
function optionColumns(t:Translate,menu?:(option:DhcpOption)=>MenuEntry[]):DataColumn<DhcpOption>[]{
 return [
  {id:'option',label:t('dhcp.col.option'),primary:true,cell:optionLabel},
  {id:'value',label:t('dhcp.col.value'),mono:true,wrap:true,cell:item=>item.values.join(', ')||EMPTY_VALUE},
  {id:'vendor',label:t('dhcp.col.vendorClass'),cell:item=>item.vendorClass??EMPTY_VALUE},
  {id:'user',label:t('dhcp.col.userClass'),cell:item=>item.userClass??EMPTY_VALUE},
  ...actionsColumn(t,optionLabel,menu),
 ];
}
const optionKey=(item:DhcpOption)=>`${item.code}-${item.vendorClass??''}-${item.userClass??''}`;
/** The columns of a policy list (the Policies section and the IPv4 scope drawer). */
function policyColumns(t:Translate,menu?:(policy:DhcpPolicy)=>MenuEntry[]):DataColumn<DhcpPolicy>[]{
 return [
  {id:'name',label:t('dhcp.col.name'),primary:true,cell:item=><strong>{item.name}</strong>},
  {id:'level',label:t('dhcp.col.level'),cell:item=>item.scopeId?t('dhcp.level.scope',{id:item.scopeId}):t('dhcp.level.server')},
  {id:'order',label:t('dhcp.col.order'),mono:true,cell:item=>item.order},
  {id:'state',label:t('dhcp.col.state'),cell:item=><StatusPill kind={item.enabled?'success':'neutral'}>{t(item.enabled?'dhcp.state.enabled':'dhcp.state.disabled')}</StatusPill>},
  {id:'conditions',label:t('dhcp.col.conditions'),wrap:true,cell:item=>dhcpConditionSummary(item,t)},
  {id:'ranges',label:t('dhcp.col.ranges'),mono:true,cell:item=>item.ranges.map(range=>`${range.start} – ${range.end}`).join(', ')||EMPTY_VALUE},
  ...actionsColumn(t,item=>item.name,menu),
 ];
}
const policyKey=(item:DhcpPolicy)=>(item.scopeId??'server')+item.name;
/**
 * The cause-specific empty state of a DHCP list (nodiverna-ui §5): a title that states the fact (no final period),
 * one sentence with the next step, and at most one action (none without change actions or where nobody can act).
 */
const emptyOf=(icon:typeof Plus,title:string,hint:string,action?:ReactNode):EmptyProps=>({icon,title,children:hint,action:action??undefined});

export default function DeviceDhcp({server,viewer,demo,now,jobs,onBack,onInstall,installBlocked,onOpenServices,devices=[],onConfirm}:Props){
 const t=useT(),[locale]=useLocale();
 const canRead=demo||permitted(server,viewer,'dhcp.read'),plugin=snapshotPlugin(server.snapshot,'dhcp'),online=demo||connectionKind(server,now)==='online';
 const [loaded,setLoaded]=useState<{serverId:string;view:DeviceDhcpView}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0);
 const [readJob,setReadJob]=useState<{id:string;since:number}|null>(null),[queueing,setQueueing]=useState(false);
 const [section,setSection]=useState<DhcpSection>('scopes'),[family,setFamily]=useState<'ipv4'|'ipv6'>('ipv4'),[superscope,setSuperscope]=useState('');
 const [leaseQuery,setLeaseQuery]=useState(''),[leaseScope,setLeaseScope]=useState(''),[leaseFilter,setLeaseFilter]=useState(''),[openScope,setOpenScope]=useState<string|null>(null);
 const [form,setForm]=useState<DhcpForm|null>(null),[serverErrors,setServerErrors]=useState<DhcpFieldError[]>([]);
 const sequence=useRef(0);
 useEffect(()=>{
  if(demo||!canRead)return;
  const current=++sequence.current;
  queueMicrotask(()=>setLoading(true));
  api<DeviceDhcpView>(`/api/dhcp?${new URLSearchParams({serverId:server.id})}`)
   .then(view=>{if(current===sequence.current){setLoaded({serverId:server.id,view});setError('');}},failure=>{if(current===sequence.current)setError(message(failure,locale));})
   .finally(()=>{if(current===sequence.current)setLoading(false);});
 },[demo,canRead,server.id,revision,locale]);
 // The read job: once it ends the data reload; a failure says why. A job the console never lists gives up after 5 minutes.
 const job=readJob?jobs.find(item=>item.id===readJob.id):undefined;
 useEffect(()=>{
  if(!readJob)return;
  const ended=job&&!['pending','running'].includes(job.state),stale=!job&&now-readJob.since>5*60_000;
  if(!ended&&!stale)return;
  queueMicrotask(()=>{
   setReadJob(null);setRevision(value=>value+1);
   if(job&&job.state!=='succeeded')toast.error(agentMessageTextOr(job,t,'dhcp.error.read'));
  });
 },[readJob,job,now,t]);
 // Change jobs: the head counts them; when the last one ends the data reload in place (no entrance replays).
 const running=openDhcpChangeJobs(jobs,server.id).length,lastRunning=useRef(running);
 useEffect(()=>{const before=lastRunning.current;lastRunning.current=running;if(before>0&&running===0)queueMicrotask(()=>setRevision(value=>value+1));},[running]);
 // The palette item "New DHCP scope" opens the scope form here.
 useEffect(()=>{
  const take=()=>{if(pendingForm?.serverId!==server.id)return;const next=pendingForm.form;pendingForm=null;queueMicrotask(()=>{setOpenScope(null);setForm(next);});};
  take();window.addEventListener(pendingEvent,take);return ()=>window.removeEventListener(pendingEvent,take);
 },[server.id]);
 const view:DeviceDhcpView|null=demo?{snapshot:demoDhcpSnapshot(now),collectedAt:now-6*60_000,receivedAt:now-6*60_000,plugin:{version:demoDhcpPlugin.version,state:'ready'}}:loaded?.serverId===server.id?loaded.view:null;
 const snapshot=view?.snapshot??null;
 const readBlocked=demo?t('kit.unavailable.demo'):!online?t('extensions.blocked.offline'):!canRead?t('dhcp.blocked.right'):plugin?.state!=='ready'?t('dhcp.blocked.noPlugin'):undefined;
 const readNow=async()=>{
  if(readBlocked||queueing||readJob)return;
  setQueueing(true);
  try{const {id}=await api<{id:string}>('/api/plugins',{action:'job',serverId:server.id,plugin:'dhcp',operation:'dhcp-read'});setReadJob({id,since:Date.now()});window.dispatchEvent(new Event('serverdesk:refresh'));}
  catch(failure){toast.error(message(failure,locale));}
  finally{setQueueing(false);}
 };
 const kpis=useMemo(()=>snapshot?dhcpKpis(snapshot):null,[snapshot]);
 // Inside the Extensions subtabs there is no back control (the Overview subtab is the way back); a host may still pass one,
 // and it sits at the leading edge of the head (SectionHead leading), before the account chip and "Read again".
 const back=onBack&&<IconBtn icon={ChevronLeft} label={t('dhcp.back')} onClick={onBack}/>;
 const base=view&&view.collectedAt?t('dhcp.meta',{server:snapshot?.server.name??server.name,time:relativeTime(view.collectedAt,now,locale),version:view.plugin?.version??plugin?.version??EMPTY_VALUE}):'';
 const meta=[base,running?t('dhcp.running',{count:running}):''].filter(Boolean).join(' · ');
 // nodiverna-ui §4 "Device section": the hidden title, the freshness meta (announced politely), the account chip and "Read again";
 // then one panel notice while the change actions are blocked.
 const manageNotice=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,'dhcp.manage'),reported:true,supported:true});
 const head=<>
  <SectionHead hideTitle id="sdx-dhcp-title" title={t('dhcp.title')} leading={back} meta={meta?<span aria-live="polite">{meta}</span>:undefined}
   actions={canRead&&plugin?<><PluginAccountChip server={server} viewer={viewer} demo={demo} now={now} plugin="dhcp" gate={dhcpAccountGate} devices={devices}/>
    <Btn variant="secondary" icon={RefreshCw} loading={queueing||!!readJob} blocked={readBlocked} onClick={()=>void readNow()}>{t('dhcp.readAgain')}</Btn></>:undefined}/>
  {canRead&&plugin&&<PanelUnavailable reason={manageNotice} readOnly={t('dhcp.readOnly')}/>}
 </>;
 // ---- Changes ----
 const partners=dhcpClientPartners(devices,server.id);
 const blockedKey=(operation:DhcpChangeOperation)=>dhcpManageBlocked(server,viewer,demo,now,view,operation);
 const confirmContext=snapshot?{device:{id:server.id,name:server.name},snapshot,collectedAt:view?.collectedAt??null,partners,time:(at:number)=>relativeTime(at,now,locale),t}:null;
 const settled:Confirmation['onSettled']=outcome=>{if(outcome.ok){setForm(null);setServerErrors([]);}else setServerErrors(dhcpFieldErrors(outcome.errors));};
 // The AD accounts of the confirmation, read when it opens (after the sign-in): the device's, and the partner's in another directory.
 const withAccounts=(context:DhcpConfirmContext,partnerId:string|null):DhcpConfirmContext=>{
  const sessions=adSessionsNow(),time=now,own=adSessionForDevice(sessions,server.snapshot,time),partnerDevice=partnerId?devices.find(item=>item.id===partnerId):undefined;
  const ownSid=deviceDirectory(server.snapshot)?.sid.toUpperCase(),partnerSid=deviceDirectory(partnerDevice?.snapshot)?.sid.toUpperCase();
  const partner=partnerDevice&&partnerSid&&partnerSid!==ownSid?adSessionForDevice(sessions,partnerDevice.snapshot,time):null;
  return {...context,adAccounts:{device:own?.account??null,partner:partner?.account??null}};
 };
 // "Delay sign-in until needed": the devices of the change without a sign-in get the dialog first; Cancel keeps the form and sends nothing.
 const signInThen=(partnerId:string|null,open:()=>void)=>{
  const targets=[server,...(partnerId?devices.filter(item=>item.id===partnerId):[])];
  void ensureAdSessions(targets,'dhcp').then(ok=>{if(ok)open();});
 };
 const manage:DhcpManage={
  blocked:operation=>{const key=blockedKey(operation);return key?t(key,{device:server.name}):undefined;},
  partnerBlocked:partner=>dhcpPartnerDevice(partner,partners)?undefined:t('dhcp.blocked.partner',{partner}),
  open:next=>{setOpenScope(null);setServerErrors([]);setForm(next);},
  change:change=>{
   if(!confirmContext||!onConfirm||blockedKey(change.operation))return;
   const partnerId=dhcpChangePartner(change.operation,change.parameters,confirmContext.snapshot,partners).device?.id??null;
   signInThen(partnerId,()=>onConfirm(dhcpConfirmation(change,withAccounts(confirmContext,partnerId),settled)));
  },
  replicate:(relationship,scopeId)=>{
   if(!confirmContext||!onConfirm||blockedKey('dhcp-scope-apply'))return;
   const partnerId=dhcpReplicatePartner(relationship,confirmContext.snapshot,partners)?.id??null;
   signInThen(partnerId,()=>onConfirm(dhcpReplicateConfirmation(relationship,scopeId??null,withAccounts(confirmContext,partnerId),settled)));
  },
 };
 const secretAgent=(device:Server)=>device.snapshot?.agentCapabilities?.includes(PLUGIN_SECRETS)?undefined:t('dhcp.blocked.secretAgent',{device:device.name});
 const partnerOptions:DhcpPartnerOption[]=partners.map(candidate=>{
  const device=devices.find(item=>item.id===candidate.id)!,key=dhcpManageBlocked(device,viewer,false,now,undefined,'dhcp-failover-create');
  return {...candidate,blocked:key?t(key,{device:device.name}):undefined,secretBlocked:secretAgent(device)};
 });
 const formOperation:DhcpChangeOperation|null=form?dhcpFormOperation(form):null;
 const cancelForm=()=>{const from=form&&'from' in form?form.from:undefined;setForm(null);setServerErrors([]);if(from)setOpenScope(from);};
 const drawer=form&&snapshot&&formOperation?<DhcpFormDrawer key={JSON.stringify(form)} form={form} snapshot={snapshot} partners={partnerOptions} secretBlocked={secretAgent(server)} blocked={manage.blocked(formOperation)} busy={false}
  serverErrors={serverErrors} onCancel={cancelForm} onSubmit={change=>manage.change(change)} t={t}/>:null;
 const frame=(children:ReactNode)=><section className="sdx-health-tab sdx-dhcp" aria-labelledby="sdx-dhcp-title">{head}{children}</section>;
 if(!canRead)return frame(<Empty icon={Lock} title={t('dhcp.empty.rightTitle')}>{t('dhcp.blocked.right')}</Empty>);
 if(!plugin)return frame(<Empty icon={Router} title={t('dhcp.empty.pluginTitle')} action={<Btn blocked={installBlocked} onClick={onInstall}>{t('extensions.install')}</Btn>}>{t('dhcp.empty.pluginHint')}</Empty>);
 const damaged=plugin.state==='damaged'?<Notice tone="warning" icon={TriangleAlert} action={<Btn size="sm" blocked={installBlocked} onClick={onInstall}>{t('extensions.repair')}</Btn>}>{plugin.error?agentMessageText({result:t('extensions.state.damaged'),resultCode:plugin.error,resultArgs:{}},t):t('extensions.state.damaged')}</Notice>:null;
 if(!view&&!error)return frame(<>{damaged}<Skeleton variant="cards" rows={4} label={t('common.loading')}/><Skeleton variant="table" label={t('common.loading')}/></>);
 const failed=error?<Notice tone="danger" icon={TriangleAlert} action={<Btn size="sm" icon={RefreshCw} loading={loading} onClick={()=>setRevision(value=>value+1)}>{t('common.retry')}</Btn>}>{t('dhcp.error.load')}{snapshot&&<> {t('dhcp.error.stale')}</>}</Notice>:null;
 if(!snapshot)return frame(<>{damaged}{failed}{!error&&<Empty icon={Router} title={t('dhcp.empty.dataTitle')} action={<Btn icon={RefreshCw} loading={queueing||!!readJob} blocked={readBlocked} onClick={()=>void readNow()}>{t('dhcp.readNow')}</Btn>}>{t('dhcp.empty.dataHint')}</Empty>}</>);
 return frame(<>{damaged}{failed}<DhcpBody snapshot={snapshot} kpis={kpis!} now={now} t={t} locale={locale} section={section} onSection={setSection}
  family={family} onFamily={setFamily} superscope={superscope} onSuperscope={setSuperscope} leaseQuery={leaseQuery} onLeaseQuery={setLeaseQuery} leaseScope={leaseScope} onLeaseScope={setLeaseScope} leaseFilter={leaseFilter} onLeaseFilter={setLeaseFilter}
  openScope={openScope} onOpenScope={setOpenScope} onOpenServices={onOpenServices} manage={manage}/>{drawer}</>);
}

type BodyProps={snapshot:DhcpSnapshot;kpis:ReturnType<typeof dhcpKpis>;now:number;t:Translate;locale:Locale;section:DhcpSection;onSection:(section:DhcpSection)=>void;
 family:'ipv4'|'ipv6';onFamily:(family:'ipv4'|'ipv6')=>void;superscope:string;onSuperscope:(value:string)=>void;leaseQuery:string;onLeaseQuery:(value:string)=>void;leaseScope:string;onLeaseScope:(value:string)=>void;leaseFilter:string;onLeaseFilter:(value:string)=>void;
 openScope:string|null;onOpenScope:(id:string|null)=>void;onOpenServices:()=>void;manage?:DhcpManage};

/** The loaded server: stopped notice, KPI row, server facts, the six sections and the scope drawer. */
export function DhcpBody(props:BodyProps){
 const {snapshot,kpis,now,t,locale,section,onSection,family,onFamily,superscope,onSuperscope,leaseQuery,onLeaseQuery,leaseScope,onLeaseScope,leaseFilter,onLeaseFilter,openScope,onOpenScope,onOpenServices,manage}=props;
 const [selected,setSelected]=useState<string[]>([]);
 const reservations=dhcpReservations(snapshot),policies=dhcpPolicies(snapshot),leases=snapshot.leases.items;
 const counts:Record<DhcpSection,number>={scopes:snapshot.ipv4.scopes.length+snapshot.ipv6.scopes.length,leases:snapshot.leases.total,reservations:reservations.length,options:snapshot.ipv4.serverOptions.length+snapshot.ipv6.serverOptions.length,policies:policies.length,failover:snapshot.ipv4.failover.length};
 const authorization=snapshot.server.authorization;
 // A scope drawer opens for an IPv4 scope id or an IPv6 prefix; the two forms never collide.
 const scope=snapshot.ipv4.scopes.find(item=>item.id===openScope)??null,scope6=scope?null:snapshot.ipv6.scopes.find(item=>item.prefix===openScope)??null;
 const lifetime=(seconds:number|null)=>seconds===null?EMPTY_VALUE:dhcpDurationLabel(seconds,t);
 const shownLeases=filterDhcpLeases(leases,{query:leaseQuery,scope:leaseScope,state:leaseFilter});
 const scopeIds=[...snapshot.ipv4.scopes.map(item=>item.id),...snapshot.ipv6.scopes.map(item=>item.prefix)];
 const usage=(item:DhcpIpv4Scope)=><span className="sdx-dhcp-usage"><Meter size="sm" value={item.usage.percent} label={t('dhcp.col.usage')+': '+item.usage.percent+' %'}/><span className="mono">{t('dhcp.usageValue',{inUse:item.usage.inUse,total:item.usage.total})}</span></span>;
 const entries=manage?dhcpEntries(manage,snapshot,t):null;
 const action=(operation:DhcpChangeOperation,label:string,icon:typeof Plus,onClick:()=>void)=>manage?<Btn size="sm" icon={icon} blocked={manage.blocked(operation)} onClick={onClick}>{label}</Btn>:null;
 // Lease selection: one key per lease; a delete takes the leases of one scope, at most 100.
 const leaseKey=(item:DhcpLease)=>`${item.family}|${item.address}`;
 const chosen=leases.filter(item=>selected.includes(leaseKey(item)));
 const chosenScopes=[...new Set(chosen.map(item=>item.scope))];
 const deleteChosen=()=>{if(!manage||chosenScopes.length!==1||chosen.length>100)return;const first=chosen[0];manage.change(dhcpChange('dhcp-lease-delete',{family:first.family,...(first.family==='ipv4'?{scopeId:first.scope}:{prefix:first.scope}),addresses:chosen.map(item=>item.address)},chosen.length===1?'dhcp.op.leaseDeleteOne':'dhcp.op.leaseDelete'));};
 const bulkBlocked=manage?.blocked('dhcp-lease-delete')??(chosenScopes.length>1?t('dhcp.leases.oneScope'):chosen.length>100?t('dhcp.leases.tooMany',{count:100}):undefined);
 const scopeState=(state:'active'|'inactive'|string)=><StatusPill kind={state==='active'?'success':'neutral'}>{t(state==='active'?'dhcp.state.active':'dhcp.state.inactive')}</StatusPill>;
 const panel=(()=>{
  if(section==='scopes'){
   const scopes=filterDhcpScopes(snapshot.ipv4.scopes,superscope);
   // "New scope" for the shown family: the same operation and reason in the toolbar and in the empty state.
   const newScope=()=>action('dhcp-scope-create',t('dhcp.op.newScope'),Plus,()=>manage!.open({kind:'scope',family}));
   const scopesEmpty=family==='ipv4'&&superscope?emptyOf(Network,t('dhcp.empty.scopesFilter'),t('dhcp.empty.scopesFilterHint'),<Btn size="sm" icon={X} onClick={()=>onSuperscope('')}>{t('fleet.empty.resetFilter')}</Btn>)
    :emptyOf(Network,t('dhcp.empty.scopes'),t('dhcp.empty.scopesHint'),newScope());
   // One Toolbar: the family and the superscope filter (with its Menu), then "New scope".
   const toolbar=<Toolbar filters={<>
     <Segmented<'ipv4'|'ipv6'> label={t('dhcp.tab.scopes')} size="sm" value={family} onChange={onFamily} items={[{id:'ipv4',label:t('dhcp.family.v4',{count:snapshot.ipv4.scopes.length})},{id:'ipv6',label:t('dhcp.family.v6',{count:snapshot.ipv6.scopes.length})}]}/>
     {family==='ipv4'&&<Select size="sm" aria-label={t('dhcp.superscope.label')} value={superscope} onChange={event=>onSuperscope(event.target.value)}>
      <option value="">{t('dhcp.superscope.all')}</option>
      {snapshot.ipv4.superscopes.map(item=><option key={item.name} value={item.name}>{item.name}</option>)}
      <option value={DHCP_NO_SUPERSCOPE}>{t('dhcp.superscope.none')}</option>
     </Select>}
     {family==='ipv4'&&entries&&<Menu label={t('dhcp.op.superscopeActions')} entries={entries.superscope(superscope&&superscope!==DHCP_NO_SUPERSCOPE?superscope:null)}/>}
    </>} actions={newScope()}/>;
   if(family==='ipv4'){
    const columns:DataColumn<DhcpIpv4Scope>[]=[
     {id:'scope',label:t('dhcp.col.scope'),primary:true,cell:item=><span className="sdx-dhcp-scope"><strong>{item.name||item.id}</strong><small className="mono">{item.id}</small></span>},
     {id:'range',label:t('dhcp.col.range'),mono:true,cell:item=>`${item.startRange} – ${item.endRange}`},
     {id:'state',label:t('dhcp.col.state'),cell:item=>scopeState(item.state)},
     {id:'superscope',label:t('dhcp.col.superscope'),cell:item=>item.superscope??EMPTY_VALUE},
     {id:'usage',label:t('dhcp.col.usage'),cell:usage},
     {id:'duration',label:t('dhcp.col.leaseDuration'),cell:item=>dhcpDurationLabel(item.leaseDurationSeconds,t)},
     {id:'failover',label:t('dhcp.col.failover'),cell:item=>item.failover??EMPTY_VALUE},
     ...actionsColumn(t,item=>item.name||item.id,entries?.scope),
    ];
    return <DataTable label={t('dhcp.tab.scopes')} cards entranceId="dhcp-scopes-v4" toolbar={toolbar} columns={columns} rows={scopes} rowKey={item=>item.id}
     onOpen={item=>onOpenScope(item.id)} openLabel={item=>t('dhcp.kpi.openScope',{name:item.name||item.id})} empty={scopesEmpty}/>;
   }
   const columns:DataColumn<DhcpIpv6Scope>[]=[
    {id:'prefix',label:t('dhcp.col.prefix'),primary:true,cell:item=><strong className="mono">{item.prefix}</strong>},
    {id:'name',label:t('dhcp.col.name'),cell:item=>item.name||EMPTY_VALUE},
    {id:'state',label:t('dhcp.col.state'),cell:item=>scopeState(item.state)},
    {id:'inUse',label:t('dhcp.col.inUse'),mono:true,cell:item=>item.usage.inUse},
    {id:'preference',label:t('dhcp.col.preference'),mono:true,cell:item=>item.preference},
    {id:'valid',label:t('dhcp.col.validLifetime'),cell:item=>lifetime(item.validLifetimeSeconds)},
    ...actionsColumn(t,item=>item.name||item.prefix,entries?.scope6),
   ];
   return <DataTable label={t('dhcp.tab.scopes')} cards entranceId="dhcp-scopes-v6" toolbar={toolbar} columns={columns} rows={snapshot.ipv6.scopes} rowKey={item=>item.prefix}
    onOpen={item=>onOpenScope(item.prefix)} openLabel={item=>t('dhcp.kpi.openScope',{name:item.name||item.prefix})} empty={scopesEmpty}/>;
  }
  if(section==='leases'){
   // No lease at all leads to the scopes; no match offers the reset of what narrows the list (the filters first, else the search).
   const filtered=!!leaseScope||!!leaseFilter,searched=!!leaseQuery.trim();
   const resetLeases=()=>{onLeaseQuery('');onLeaseScope('');onLeaseFilter('');};
   const leasesEmpty=filtered?emptyOf(Search,t('dhcp.empty.leasesMatch'),t('dhcp.empty.leasesMatchHint'),<Btn size="sm" icon={X} onClick={resetLeases}>{t('fleet.empty.resetFilter')}</Btn>)
    :searched?emptyOf(Search,t('dhcp.empty.leasesMatch'),t('dhcp.empty.leasesMatchHint'),<Btn size="sm" icon={X} onClick={()=>onLeaseQuery('')}>{t('history.search.clear')}</Btn>)
    :emptyOf(Users,t('dhcp.empty.leases'),t('dhcp.empty.leasesHint'),<Btn size="sm" icon={Network} onClick={()=>onSection('scopes')}>{t('dhcp.empty.showScopes')}</Btn>);
   return <>
   {(snapshot.leases.truncated||snapshot.truncated.leases)&&<Notice tone="info" icon={ListTree}>{t('dhcp.leases.truncated',{count:leases.length,total:snapshot.leases.total})}</Notice>}
   <DataTable label={t('dhcp.tab.leases')} cards entranceId="dhcp-leases" columns={leaseColumns(t,locale,now,entries?.lease)} rows={shownLeases} rowKey={leaseKey}
    toolbar={<Toolbar search={{value:leaseQuery,onChange:onLeaseQuery,label:t('dhcp.search.label'),placeholder:t('dhcp.search.placeholder')}} filters={<>
     <Select size="sm" aria-label={t('dhcp.col.scope')} value={leaseScope} onChange={event=>onLeaseScope(event.target.value)}>
      <option value="">{t('dhcp.filter.allScopes')}</option>{scopeIds.map(id=><option key={id} value={id}>{id}</option>)}
     </Select>
     <Select size="sm" aria-label={t('dhcp.col.state')} value={leaseFilter} onChange={event=>onLeaseFilter(event.target.value)}>
      <option value="">{t('dhcp.filter.allStates')}</option>{leaseStates.map(state=><option key={state} value={state}>{leaseState(state,t)}</option>)}
     </Select>
    </>}/>}
    selection={manage?{selected,onChange:setSelected,rowLabel:item=>t('dhcp.selectLease',{address:item.address}),allLabel:t('dhcp.selectAll')}:undefined}
    foot={t('dhcp.leases.count',{shown:shownLeases.length,total:leases.length})} empty={leasesEmpty}/>
   {manage&&<BulkBar count={chosen.length} onClear={()=>setSelected([])} label={t('dhcp.selection')}>
    <Btn size="sm" variant="danger" icon={Trash2} blocked={bulkBlocked} onClick={deleteChosen}>{t('dhcp.op.leaseDelete')}</Btn>
   </BulkBar>}
  </>;
  }
  if(section==='reservations'){
   type Row=(typeof reservations)[number];
   const columns:DataColumn<Row>[]=[
    {id:'address',label:t('dhcp.col.address'),primary:true,mono:true,cell:item=>item.address},
    {id:'name',label:t('dhcp.col.name'),cell:item=>item.name||EMPTY_VALUE},
    {id:'client',label:t('dhcp.col.clientId'),mono:true,cell:item=>item.clientId},
    {id:'scope',label:t('dhcp.col.scope'),mono:true,cell:item=>item.scope},
    {id:'type',label:t('dhcp.col.type'),cell:item=>item.type?t(`dhcp.type.${item.type as 'dhcp'|'bootp'|'both'}`):EMPTY_VALUE},
    {id:'description',label:t('dhcp.col.description'),wrap:true,cell:item=>item.description||EMPTY_VALUE},
    ...actionsColumn<Row>(t,item=>item.address,entries?item=>entries.reservation(item.family,item.scope,item.address):undefined),
   ];
   const addReservation=()=>action('dhcp-reservation-add',t('dhcp.op.reservationAdd'),Plus,()=>manage!.open({kind:'reservation',family:snapshot.ipv4.scopes.length||!snapshot.ipv6.scopes.length?'ipv4':'ipv6'}));
   return <>
    {snapshot.truncated.reservations&&<Notice tone="info" icon={ListTree}>{t('dhcp.reservations.truncated')}</Notice>}
    <DataTable label={t('dhcp.tab.reservations')} cards entranceId="dhcp-reservations" columns={columns} rows={reservations} rowKey={item=>item.scope+item.address}
     toolbar={manage?<Toolbar actions={addReservation()}/>:undefined}
     empty={emptyOf(ListTree,t('dhcp.empty.reservations'),t('dhcp.empty.reservationsHint'),addReservation())}/>
   </>;
  }
  if(section==='options'){
   const setOption=(optionFamily:'ipv4'|'ipv6')=>action('dhcp-option-set',t('dhcp.op.optionSet'),SlidersHorizontal,()=>manage!.open({kind:'option',family:optionFamily,level:'server'}));
   const optionsEmpty=(optionFamily:'ipv4'|'ipv6')=>emptyOf(SlidersHorizontal,t('dhcp.empty.options'),t('dhcp.empty.optionsHint'),setOption(optionFamily));
   return <>
    <div className="sdx-dhcp-subhead-row"><h3 className="sdx-dhcp-subhead">{t('dhcp.options.v4')}</h3>{setOption('ipv4')}</div>
    <DataTable label={t('dhcp.options.v4')} cards entranceId="dhcp-options-v4" columns={optionColumns(t,entries?option=>entries.option({kind:'option',family:'ipv4',level:'server'},option):undefined)} rows={snapshot.ipv4.serverOptions} rowKey={optionKey} empty={optionsEmpty('ipv4')}/>
    <div className="sdx-dhcp-subhead-row"><h3 className="sdx-dhcp-subhead">{t('dhcp.options.v6')}</h3>{setOption('ipv6')}</div>
    <DataTable label={t('dhcp.options.v6')} cards entranceId="dhcp-options-v6" columns={optionColumns(t,entries?option=>entries.option({kind:'option',family:'ipv6',level:'server'},option):undefined)} rows={snapshot.ipv6.serverOptions} rowKey={optionKey} empty={optionsEmpty('ipv6')}/>
   </>;
  }
  if(section==='policies'){
   const newPolicy=()=>action('dhcp-policy-create',t('dhcp.op.policyNew'),Plus,()=>manage!.open({kind:'policy',scope:null}));
   return <DataTable label={t('dhcp.tab.policies')} cards entranceId="dhcp-policies" columns={policyColumns(t,entries?.policy)} rows={policies} rowKey={policyKey}
    toolbar={manage?<Toolbar actions={newPolicy()}/>:undefined} empty={emptyOf(Layers,t('dhcp.empty.policies'),t('dhcp.empty.policiesHint'),newPolicy())}/>;
  }
  const failoverColumns:DataColumn<DhcpFailover>[]=[
   {id:'name',label:t('dhcp.col.relationship'),primary:true,cell:item=><strong>{item.name}</strong>},
   {id:'partner',label:t('dhcp.col.partner'),cell:item=>item.partner},
   {id:'mode',label:t('dhcp.col.mode'),cell:item=>dhcpFailoverMode(item,t)},
   {id:'state',label:t('dhcp.col.state'),cell:item=>failoverState(item.state,t)},
   {id:'mclt',label:t('dhcp.col.mclt'),cell:item=>dhcpDurationLabel(item.mcltSeconds,t)},
   {id:'scopes',label:t('dhcp.col.scopes'),cell:item=><span title={item.scopeIds.join(', ')}>{t('dhcp.scopeCount',{count:item.scopeIds.length})}</span>},
   ...actionsColumn(t,item=>item.name,entries?.failover),
  ];
  // "New failover relationship": the toolbar and the empty state share the operation reason, then the truncated-reservations reason.
  const newFailover=()=>manage?<Btn size="sm" icon={Plus} blocked={manage.blocked('dhcp-failover-create')??(snapshot.truncated.reservations?t('dhcp.blocked.reservationsTruncated'):undefined)} onClick={()=>manage.open({kind:'failover'})}>{t('dhcp.op.failoverNew')}</Btn>:null;
  return <DataTable label={t('dhcp.tab.failover')} cards entranceId="dhcp-failover" columns={failoverColumns} rows={snapshot.ipv4.failover} rowKey={item=>item.name}
   toolbar={manage?<Toolbar actions={newFailover()}/>:undefined}
   empty={emptyOf(CopyCheck,t('dhcp.empty.failover'),t('dhcp.empty.failoverHint'),newFailover())}/>;
 })();
 const drawerFooter=(edit:()=>void,operation:DhcpChangeOperation)=><>{manage&&<Btn icon={Pencil} blocked={manage.blocked(operation)} onClick={edit}>{t('dhcp.op.scopeEdit')}</Btn>}<Btn onClick={()=>onOpenScope(null)}>{t('common.close')}</Btn></>;
 const replicateMenu=scope?.failover&&entries?<Menu label={t('dhcp.actionsFor',{name:scope.name||scope.id})} entries={entries.replicateScope(scope)}/>:null;
 return <>
  {snapshot.service==='stopped'&&<Notice tone="warning" icon={TriangleAlert} action={<Btn size="sm" onClick={onOpenServices}>{t('dhcp.stoppedAction')}</Btn>}>{t('dhcp.stopped')}</Notice>}
  <KpiRow label={t('dhcp.kpi.label')} entranceId="dhcp-kpis">
   <Kpi key="scopes" label={t('dhcp.kpi.scopes')} value={kpis.scopes} icon={Network} detail={t('dhcp.kpi.scopesDetail',{count:kpis.active})}/>
   <Kpi key="in-use" label={t('dhcp.kpi.inUse')} value={kpis.percent} digits={1} unit="%" icon={Gauge} tone={kpis.percent>=90?'critical':kpis.percent>=80?'warning':'accent'} visual={<Meter value={kpis.percent} label={t('dhcp.kpi.inUse')}/>} detail={t('dhcp.kpi.inUseDetail',{inUse:kpis.inUse,total:kpis.total})}/>
   <Kpi key="leases" label={t('dhcp.kpi.leases')} value={kpis.leases} icon={Users} detail={kpis.leasesTruncated?t('dhcp.kpi.leasesTruncated'):undefined}/>
   {kpis.fullest?<Kpi key="fullest" label={t('dhcp.kpi.fullest')} value={kpis.fullest.percent} digits={1} unit="%" icon={Layers} tone={kpis.fullest.percent>=90?'critical':kpis.fullest.percent>=80?'warning':'accent'} detail={kpis.fullest.name} hint={t('dhcp.kpi.openScope',{name:kpis.fullest.name})} onSelect={()=>onOpenScope(kpis.fullest!.id)}/>
    :<Kpi key="fullest" label={t('dhcp.kpi.fullest')} value={null} icon={Layers}/>}
  </KpiRow>
  <Card title={t('dhcp.server.title')} icon={ServerCog}>
   <Facts columns={2} items={[
    {id:'service',label:t('dhcp.server.service'),value:<StatusPill kind={snapshot.service==='running'?'success':'warning'}>{t(snapshot.service==='running'?'dhcp.server.running':'dhcp.server.stopped')}</StatusPill>},
    {id:'authorization',label:t('dhcp.server.authorization'),value:authorization==='authorized'?<StatusPill kind="success">{t('dhcp.auth.authorized')}</StatusPill>:authorization==='unauthorized'?<StatusPill kind="warning">{t('dhcp.auth.unauthorized')}</StatusPill>:<StatusPill kind="neutral">{t(authorization==='notInDomain'?'dhcp.auth.notInDomain':'dhcp.auth.unknown')}</StatusPill>},
    {id:'domain',label:t('dhcp.server.domain'),value:snapshot.server.domain??EMPTY_VALUE},
    {id:'failover',label:t('dhcp.server.failover'),value:snapshot.ipv4.failover.length,mono:true},
   ]}/>
  </Card>
  <Tabs label={t('dhcp.tabs.label')} variant="pill" value={section} onChange={id=>onSection(id as DhcpSection)} panelId="sdx-dhcp-panel" items={sections.map(id=>({id,label:t(`dhcp.tab.${id}`),count:counts[id]}))}/>
  <div id="sdx-dhcp-panel" role="tabpanel" aria-labelledby={`sdx-dhcp-panel-tab-${section}`} className="sdx-dhcp-panel">{panel}</div>
  <Drawer open={!!scope} onClose={()=>onOpenScope(null)} title={scope?.name||scope?.id||''} description={scope?<span className="sdx-dhcp-drawer-head"><span className="mono">{scope.id}</span>{replicateMenu}</span>:undefined} wide
   footer={scope?drawerFooter(()=>manage?.open({kind:'scope',family:'ipv4',id:scope.id,from:scope.id}),'dhcp-scope-edit'):<Btn onClick={()=>onOpenScope(null)}>{t('common.close')}</Btn>}>
   {scope&&<ScopeDetails scope={scope} snapshot={snapshot} now={now} t={t} locale={locale} usage={usage(scope)} manage={manage} onShowAll={()=>{onLeaseScope(scope.id);onLeaseQuery('');onLeaseFilter('');onSection('leases');onOpenScope(null);}}/>}
  </Drawer>
  <Drawer open={!!scope6} onClose={()=>onOpenScope(null)} title={scope6?.name||scope6?.prefix||''} description={scope6?<span className="mono">{scope6.prefix}</span>:undefined} wide
   footer={scope6?drawerFooter(()=>manage?.open({kind:'scope',family:'ipv6',id:scope6.prefix,from:scope6.prefix}),'dhcp-scope-edit'):<Btn onClick={()=>onOpenScope(null)}>{t('common.close')}</Btn>}>
   {scope6&&<Scope6Details scope={scope6} snapshot={snapshot} now={now} t={t} locale={locale} lifetime={lifetime} manage={manage} onShowAll={()=>{onLeaseScope(scope6.prefix);onLeaseQuery('');onLeaseFilter('');onSection('leases');onOpenScope(null);}}/>}
  </Drawer>
 </>;
}

/**
 * The row and section menus of the change actions. Every entry keeps its
 * reason when it is blocked; partner-dependent entries name a partner that is
 * no device here.
 */
export function dhcpEntries(manage:DhcpManage,snapshot:DhcpSnapshot,t:Translate){
 const entry=(id:string,label:string,operation:DhcpChangeOperation,onSelect:()=>void,extra:{icon?:typeof Plus;danger?:boolean;blocked?:string}={}):MenuEntry=>({id,label,icon:extra.icon,danger:extra.danger,blocked:manage.blocked(operation)??extra.blocked,onSelect});
 const change=(operation:DhcpChangeOperation,parameters:Record<string,unknown>,label?:Parameters<typeof dhcpChange>[2])=>()=>manage.change(dhcpChange(operation,parameters,label));
 const inFailover=(item:DhcpIpv4Scope)=>item.failover?t('dhcp.error.inFailover',{scope:item.id,relationship:item.failover}):undefined;
 const policyFields=(item:DhcpPolicy)=>({scopeId:item.scopeId,name:item.name,description:item.description,enabled:item.enabled,order:item.order,condition:item.condition,criteria:item.criteria,ranges:item.ranges,leaseDurationSeconds:item.leaseDurationSeconds});
 const relationOf=(item:DhcpIpv4Scope)=>snapshot.ipv4.failover.find(relation=>relation.name===item.failover);
 // Copying scopes to a partner needs every reservation of the read.
 const truncated=snapshot.truncated.reservations?t('dhcp.blocked.reservationsTruncated'):undefined;
 return {
  scope:(item:DhcpIpv4Scope):MenuEntry[]=>[
   entry('edit',t('dhcp.op.scopeEdit'),'dhcp-scope-edit',()=>manage.open({kind:'scope',family:'ipv4',id:item.id}),{icon:Pencil}),
   item.state==='active'?entry('deactivate',t('dhcp.op.scopeDeactivate'),'dhcp-scope-deactivate',change('dhcp-scope-deactivate',{family:'ipv4',scopeId:item.id}),{icon:PowerOff})
    :entry('activate',t('dhcp.op.scopeActivate'),'dhcp-scope-activate',change('dhcp-scope-activate',{family:'ipv4',scopeId:item.id}),{icon:Power}),
   {id:'separator',separator:true},
   entry('delete',t('dhcp.op.scopeDelete'),'dhcp-scope-delete',change('dhcp-scope-delete',{family:'ipv4',scopeId:item.id}),{icon:Trash2,danger:true,blocked:inFailover(item)}),
  ],
  scope6:(item:DhcpIpv6Scope):MenuEntry[]=>[
   entry('edit',t('dhcp.op.scopeEdit'),'dhcp-scope-edit',()=>manage.open({kind:'scope',family:'ipv6',id:item.prefix}),{icon:Pencil}),
   item.state==='active'?entry('deactivate',t('dhcp.op.scopeDeactivate'),'dhcp-scope-deactivate',change('dhcp-scope-deactivate',{family:'ipv6',prefix:item.prefix}),{icon:PowerOff})
    :entry('activate',t('dhcp.op.scopeActivate'),'dhcp-scope-activate',change('dhcp-scope-activate',{family:'ipv6',prefix:item.prefix}),{icon:Power}),
   {id:'separator',separator:true},
   entry('delete',t('dhcp.op.scopeDelete'),'dhcp-scope-delete',change('dhcp-scope-delete',{family:'ipv6',prefix:item.prefix}),{icon:Trash2,danger:true}),
  ],
  superscope:(name:string|null):MenuEntry[]=>[
   entry('new',t('dhcp.op.superscopeCreate'),'dhcp-superscope-create',()=>manage.open({kind:'superscope'}),{icon:Plus}),
   ...(name?[
    entry('edit',t('dhcp.op.superscopeEdit'),'dhcp-superscope-edit',()=>manage.open({kind:'superscope',name}),{icon:Pencil}),
    entry('activate',t('dhcp.op.superscopeActivate'),'dhcp-superscope-activate',change('dhcp-superscope-activate',{name}),{icon:Power}),
    entry('deactivate',t('dhcp.op.superscopeDeactivate'),'dhcp-superscope-deactivate',change('dhcp-superscope-deactivate',{name}),{icon:PowerOff}),
    {id:'separator',separator:true} as MenuEntry,
    entry('delete',t('dhcp.op.superscopeDelete'),'dhcp-superscope-delete',change('dhcp-superscope-delete',{name}),{icon:Trash2,danger:true}),
   ]:[]),
  ],
  exclusion:(family:'ipv4'|'ipv6',scope:string,range:{start:string;end:string}):MenuEntry[]=>[
   entry('remove',t('dhcp.op.exclusionRemove'),'dhcp-exclusion-remove',change('dhcp-exclusion-remove',{family,...(family==='ipv4'?{scopeId:scope}:{prefix:scope}),start:range.start,end:range.end}),{icon:Trash2,danger:true}),
  ],
  reservation:(family:'ipv4'|'ipv6',scope:string,address:string,from?:string):MenuEntry[]=>[
   entry('edit',t('dhcp.op.reservationEdit'),'dhcp-reservation-edit',()=>manage.open({kind:'reservation',family,scope,address,from}),{icon:Pencil}),
   entry('remove',t('dhcp.op.reservationRemove'),'dhcp-reservation-remove',change('dhcp-reservation-remove',{family,...(family==='ipv4'?{scopeId:scope}:{prefix:scope}),address}),{icon:Trash2,danger:true}),
  ],
  lease:(item:DhcpLease):MenuEntry[]=>[
   entry('reserve',t('dhcp.op.reservationAdd'),'dhcp-reservation-add',()=>manage.open({kind:'reservation',family:item.family,scope:item.scope,lease:item}),{icon:Plus}),
   entry('delete',t('dhcp.op.leaseDeleteOne'),'dhcp-lease-delete',change('dhcp-lease-delete',{family:item.family,...(item.family==='ipv4'?{scopeId:item.scope}:{prefix:item.scope}),addresses:[item.address]},'dhcp.op.leaseDeleteOne'),{icon:Trash2,danger:true}),
  ],
  option:(target:Extract<DhcpForm,{kind:'option'}>,item:DhcpOption):MenuEntry[]=>[
   entry('edit',t('dhcp.op.optionEdit'),'dhcp-option-set',()=>manage.open({...target,code:item.code,vendorClass:item.vendorClass,userClass:item.userClass}),{icon:Pencil}),
   entry('remove',t('dhcp.op.optionRemove'),'dhcp-option-remove',change('dhcp-option-remove',{family:target.family,level:target.level,...(target.family==='ipv4'&&target.level!=='server'?{scopeId:target.scope??null}:{}),...(target.family==='ipv6'&&target.level==='scope'?{prefix:target.scope}:{}),
    ...(target.level==='policy'?{policy:target.policy}:{}),code:item.code,vendorClass:item.vendorClass,userClass:item.userClass}),{icon:Trash2,danger:true}),
  ],
  policy:(item:DhcpPolicy,from?:string):MenuEntry[]=>[
   entry('edit',t('dhcp.op.policyEdit'),'dhcp-policy-edit',()=>manage.open({kind:'policy',scope:item.scopeId,name:item.name,from}),{icon:Pencil}),
   entry('toggle',t(item.enabled?'dhcp.op.policyDisable':'dhcp.op.policyEnable'),'dhcp-policy-edit',change('dhcp-policy-edit',{...policyFields(item),enabled:!item.enabled},item.enabled?'dhcp.op.policyDisable':'dhcp.op.policyEnable'),{icon:item.enabled?PowerOff:Power}),
   entry('option',t('dhcp.op.optionSet'),'dhcp-option-set',()=>manage.open({kind:'option',family:'ipv4',level:'policy',scope:item.scopeId,policy:item.name,from}),{icon:SlidersHorizontal}),
   {id:'separator',separator:true},
   entry('delete',t('dhcp.op.policyDelete'),'dhcp-policy-delete',change('dhcp-policy-delete',{scopeId:item.scopeId,name:item.name}),{icon:Trash2,danger:true}),
  ],
  failover:(item:DhcpFailover):MenuEntry[]=>[
   entry('edit',t('dhcp.op.failoverEdit'),'dhcp-failover-edit',()=>manage.open({kind:'failover',name:item.name}),{icon:Pencil,blocked:manage.partnerBlocked(item.partner)}),
   entry('replicate',t('dhcp.op.failoverReplicate'),'dhcp-scope-apply',()=>manage.replicate(item.name),{icon:CopyCheck,blocked:manage.partnerBlocked(item.partner)??truncated}),
   {id:'separator',separator:true},
   entry('remove',t('dhcp.op.failoverRemove'),'dhcp-failover-remove',change('dhcp-failover-remove',{name:item.name,deletePartnerScopes:true}),{icon:Trash2,danger:true}),
  ],
  replicateScope:(item:DhcpIpv4Scope):MenuEntry[]=>{const relation=relationOf(item);return relation?[
   entry('replicate',t('dhcp.op.scopeReplicate'),'dhcp-scope-apply',()=>manage.replicate(relation.name,item.id),{icon:CopyCheck,blocked:manage.partnerBlocked(relation.partner)??truncated}),
  ]:[];},
 };
}

/**
 * The empty lease list of a scope drawer. No console action creates a lease, so an active scope has no action
 * (nodiverna-ui §5 exception); an inactive scope offers "Activate scope" with its reason.
 */
function scopeLeasesEmpty(state:string,target:{family:'ipv4';scopeId:string}|{family:'ipv6';prefix:string},manage:DhcpManage|undefined,t:Translate):EmptyProps{
 if(state==='active')return emptyOf(Users,t('dhcp.empty.scopeLeases'),t('dhcp.empty.scopeLeasesHint'));
 return emptyOf(Users,t('dhcp.empty.scopeLeases'),t('dhcp.empty.scopeLeasesInactive'),manage&&<Btn size="sm" icon={Power} blocked={manage.blocked('dhcp-scope-activate')} onClick={()=>manage.change(dhcpChange('dhcp-scope-activate',target))}>{t('dhcp.op.scopeActivate')}</Btn>);
}

/** A section head of a scope drawer with its add action. */
function Subhead({title,children}:{title:string;children?:ReactNode}){return children?<div className="sdx-dhcp-subhead-row"><h3 className="sdx-dhcp-subhead">{title}</h3>{children}</div>:<h3 className="sdx-dhcp-subhead">{title}</h3>;}

type Exclusion=DhcpIpv4Scope['exclusions'][number]|DhcpIpv6Scope['exclusions'][number];
/** The columns of an exclusion list in a scope drawer. */
function exclusionColumns(t:Translate,menu?:(item:Exclusion)=>MenuEntry[]):DataColumn<Exclusion>[]{
 return [{id:'range',label:t('dhcp.col.range'),primary:true,mono:true,cell:item=>`${item.start} – ${item.end}`},...actionsColumn(t,item=>`${item.start} – ${item.end}`,menu)];
}
/** The scope drawer: facts, exclusions, reservations, options, policies and the first 100 leases; with manage, an add Btn per section and a row Menu. */
export function ScopeDetails({scope,snapshot,now,t,locale,usage,onShowAll,manage}:{scope:DhcpIpv4Scope;snapshot:DhcpSnapshot;now:number;t:Translate;locale:Locale;usage:ReactNode;onShowAll:()=>void;manage?:DhcpManage}){
 const leases=snapshot.leases.items.filter(item=>item.scope===scope.id),entries=manage?dhcpEntries(manage,snapshot,t):null;
 const add=(operation:DhcpChangeOperation,label:string,form:DhcpForm)=>manage?<Btn size="sm" icon={Plus} blocked={manage.blocked(operation)} onClick={()=>manage.open(form)}>{label}</Btn>:undefined;
 // Each add action shows in its subhead and in the empty state of its list.
 const addExclusion=()=>add('dhcp-exclusion-add',t('dhcp.op.exclusionAdd'),{kind:'exclusion',family:'ipv4',scope:scope.id,from:scope.id});
 const addReservation=()=>add('dhcp-reservation-add',t('dhcp.op.reservationAdd'),{kind:'reservation',family:'ipv4',scope:scope.id,from:scope.id});
 const setOption=()=>add('dhcp-option-set',t('dhcp.op.optionSet'),{kind:'option',family:'ipv4',level:'scope',scope:scope.id,from:scope.id});
 const newPolicy=()=>add('dhcp-policy-create',t('dhcp.op.policyNew'),{kind:'policy',scope:scope.id,from:scope.id});
 type Reservation=DhcpIpv4Scope['reservations'][number];
 const reservationColumns:DataColumn<Reservation>[]=[
  {id:'address',label:t('dhcp.col.address'),primary:true,mono:true,cell:item=>item.address},
  {id:'name',label:t('dhcp.col.name'),cell:item=>item.name||EMPTY_VALUE},
  {id:'client',label:t('dhcp.col.clientId'),mono:true,cell:item=>item.clientId},
  ...actionsColumn<Reservation>(t,item=>item.address,entries?item=>entries.reservation('ipv4',scope.id,item.address,scope.id):undefined),
 ];
 return <div className="sdx-dhcp-drawer">
  <Facts items={[
   {id:'range',label:t('dhcp.col.range'),value:`${scope.startRange} – ${scope.endRange}`,mono:true},
   {id:'mask',label:t('dhcp.col.mask'),value:scope.subnetMask,mono:true},
   {id:'state',label:t('dhcp.col.state'),value:<StatusPill kind={scope.state==='active'?'success':'neutral'}>{t(scope.state==='active'?'dhcp.state.active':'dhcp.state.inactive')}</StatusPill>},
   {id:'duration',label:t('dhcp.col.leaseDuration'),value:dhcpDurationLabel(scope.leaseDurationSeconds,t)},
   {id:'superscope',label:t('dhcp.col.superscope'),value:scope.superscope??EMPTY_VALUE},
   {id:'failover',label:t('dhcp.col.failover'),value:scope.failover??EMPTY_VALUE},
   {id:'usage',label:t('dhcp.col.usage'),value:usage},
  ]}/>
  <Subhead title={t('dhcp.drawer.exclusions')}>{addExclusion()}</Subhead>
  <DataTable label={t('dhcp.drawer.exclusions')} cards entranceId="dhcp-drawer-exclusions" columns={exclusionColumns(t,entries?item=>entries.exclusion('ipv4',scope.id,{start:String(item.start),end:String(item.end)}):undefined)} rows={scope.exclusions} rowKey={item=>String(item.start)} empty={emptyOf(Ban,t('dhcp.empty.exclusions'),t('dhcp.empty.exclusionsHint'),addExclusion())}/>
  <Subhead title={t('dhcp.drawer.reservations')}>{addReservation()}</Subhead>
  <DataTable label={t('dhcp.drawer.reservations')} cards entranceId="dhcp-drawer-reservations" columns={reservationColumns} rows={scope.reservations} rowKey={item=>item.address} empty={emptyOf(ListTree,t('dhcp.empty.scopeReservations'),t('dhcp.empty.reservationsHint'),addReservation())}/>
  <Subhead title={t('dhcp.drawer.options')}>{setOption()}</Subhead>
  <DataTable label={t('dhcp.drawer.options')} cards entranceId="dhcp-drawer-options" columns={optionColumns(t,entries?option=>entries.option({kind:'option',family:'ipv4',level:'scope',scope:scope.id,from:scope.id},option):undefined)} rows={scope.options} rowKey={optionKey} empty={emptyOf(SlidersHorizontal,t('dhcp.empty.scopeOptions'),t('dhcp.empty.optionsHint'),setOption())}/>
  <Subhead title={t('dhcp.drawer.policies')}>{newPolicy()}</Subhead>
  <DataTable label={t('dhcp.drawer.policies')} cards entranceId="dhcp-drawer-policies" columns={policyColumns(t,entries?policy=>entries.policy(policy,scope.id):undefined)} rows={scope.policies} rowKey={policyKey} empty={emptyOf(Layers,t('dhcp.empty.scopePolicies'),t('dhcp.empty.policiesHint'),newPolicy())}/>
  <div className="sdx-dhcp-subhead-row"><h3 className="sdx-dhcp-subhead">{t('dhcp.drawer.leases')}</h3>{leases.length>0&&<Btn size="sm" variant="ghost" onClick={onShowAll}>{t('dhcp.drawer.showAll')}</Btn>}</div>
  <DataTable label={t('dhcp.drawer.leases')} cards entranceId="dhcp-drawer-leases" columns={leaseColumns(t,locale,now)} rows={leases.slice(0,100)} rowKey={item=>item.family+item.address} empty={scopeLeasesEmpty(scope.state,{family:'ipv4',scopeId:scope.id},manage,t)}/>
 </div>;
}

/** The drawer of an IPv6 scope: facts, exclusions, reservations with DUID and IAID, options and the first 100 leases; with manage, the same actions as IPv4 without policies. */
export function Scope6Details({scope,snapshot,now,t,locale,lifetime,onShowAll,manage}:{scope:DhcpIpv6Scope;snapshot:DhcpSnapshot;now:number;t:Translate;locale:Locale;lifetime:(seconds:number|null)=>string;onShowAll:()=>void;manage?:DhcpManage}){
 const leases=snapshot.leases.items.filter(item=>item.scope===scope.prefix),entries=manage?dhcpEntries(manage,snapshot,t):null;
 const add=(operation:DhcpChangeOperation,label:string,form:DhcpForm)=>manage?<Btn size="sm" icon={Plus} blocked={manage.blocked(operation)} onClick={()=>manage.open(form)}>{label}</Btn>:undefined;
 // Each add action shows in its subhead and in the empty state of its list.
 const addExclusion=()=>add('dhcp-exclusion-add',t('dhcp.op.exclusionAdd'),{kind:'exclusion',family:'ipv6',scope:scope.prefix,from:scope.prefix});
 const addReservation=()=>add('dhcp-reservation-add',t('dhcp.op.reservationAdd'),{kind:'reservation',family:'ipv6',scope:scope.prefix,from:scope.prefix});
 const setOption=()=>add('dhcp-option-set',t('dhcp.op.optionSet'),{kind:'option',family:'ipv6',level:'scope',scope:scope.prefix,from:scope.prefix});
 type Reservation=DhcpIpv6Scope['reservations'][number];
 const reservationColumns:DataColumn<Reservation>[]=[
  {id:'address',label:t('dhcp.col.address'),primary:true,mono:true,cell:item=>item.address},
  {id:'name',label:t('dhcp.col.name'),cell:item=>item.name||EMPTY_VALUE},
  {id:'duid',label:t('dhcp.col.duid'),mono:true,cell:item=>item.duid},
  {id:'iaid',label:t('dhcp.col.iaid'),mono:true,cell:item=>item.iaid},
  ...actionsColumn<Reservation>(t,item=>item.address,entries?item=>entries.reservation('ipv6',scope.prefix,item.address,scope.prefix):undefined),
 ];
 return <div className="sdx-dhcp-drawer">
  <Facts items={[
   {id:'prefix',label:t('dhcp.col.prefix'),value:scope.prefix,mono:true},
   {id:'state',label:t('dhcp.col.state'),value:<StatusPill kind={scope.state==='active'?'success':'neutral'}>{t(scope.state==='active'?'dhcp.state.active':'dhcp.state.inactive')}</StatusPill>},
   {id:'preference',label:t('dhcp.col.preference'),value:scope.preference,mono:true},
   {id:'preferred',label:t('dhcp.col.preferredLifetime'),value:lifetime(scope.preferredLifetimeSeconds)},
   {id:'valid',label:t('dhcp.col.validLifetime'),value:lifetime(scope.validLifetimeSeconds)},
   {id:'inUse',label:t('dhcp.col.inUse'),value:scope.usage.inUse,mono:true},
   ...(scope.description?[{id:'description',label:t('dhcp.col.description'),value:scope.description}]:[]),
  ]}/>
  <Subhead title={t('dhcp.drawer.exclusions')}>{addExclusion()}</Subhead>
  <DataTable label={t('dhcp.drawer.exclusions')} cards entranceId="dhcp-drawer6-exclusions" columns={exclusionColumns(t,entries?item=>entries.exclusion('ipv6',scope.prefix,{start:String(item.start),end:String(item.end)}):undefined)} rows={scope.exclusions} rowKey={item=>String(item.start)} empty={emptyOf(Ban,t('dhcp.empty.exclusions'),t('dhcp.empty.exclusionsHint'),addExclusion())}/>
  <Subhead title={t('dhcp.drawer.reservations')}>{addReservation()}</Subhead>
  <DataTable label={t('dhcp.drawer.reservations')} cards entranceId="dhcp-drawer6-reservations" columns={reservationColumns} rows={scope.reservations} rowKey={item=>item.address} empty={emptyOf(ListTree,t('dhcp.empty.scopeReservations'),t('dhcp.empty.reservationsHint'),addReservation())}/>
  <Subhead title={t('dhcp.drawer.options')}>{setOption()}</Subhead>
  <DataTable label={t('dhcp.drawer.options')} cards entranceId="dhcp-drawer6-options" columns={optionColumns(t,entries?option=>entries.option({kind:'option',family:'ipv6',level:'scope',scope:scope.prefix,from:scope.prefix},option):undefined)} rows={scope.options} rowKey={optionKey} empty={emptyOf(SlidersHorizontal,t('dhcp.empty.scopeOptions'),t('dhcp.empty.optionsHint'),setOption())}/>
  <div className="sdx-dhcp-subhead-row"><h3 className="sdx-dhcp-subhead">{t('dhcp.drawer.leases')}</h3>{leases.length>0&&<Btn size="sm" variant="ghost" onClick={onShowAll}>{t('dhcp.drawer.showAll')}</Btn>}</div>
  <DataTable label={t('dhcp.drawer.leases')} cards entranceId="dhcp-drawer6-leases" columns={leaseColumns(t,locale,now)} rows={leases.slice(0,100)} rowKey={item=>item.family+item.address} empty={scopeLeasesEmpty(scope.state,{family:'ipv6',prefix:scope.prefix},manage,t)}/>
 </div>;
}
