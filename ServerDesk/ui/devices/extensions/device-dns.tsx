'use client';
// The DNS server of one device (docs/dns-server.md): the latest server read of
// the DNS plugin (GET /api/dns?serverId=). The KPI row leads (zones, stored in
// AD, records, forwarders, scavenging), then the server facts and four
// sections in pill tabs: Zones, Conditional forwarders, Forwarders, Aging and
// scavenging. A zone opens its page inside the view with its settings and its
// records (GET /api/dns?serverId=&zone=); "Read records" queues dns-zone-read.
// "Read again" queues dns-read (POST /api/plugins) and reloads when the job
// ends. Every change control is blocked with the first reason of
// dnsManageBlocked; a change opens its drawer (dns-forms.tsx), then the AD
// sign-in when the device has none, then the confirmation, then POST /api/dns.
// While change jobs of the device are open the head counts them, and the data
// reload in place once the last one ends. Demo mode shows ui/shell/demo-dns.ts with
// every change blocked.
import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {toast} from 'sonner';
import {ChevronLeft,Eraser,Forward,Globe,ListTree,Lock,MoreHorizontal,Network,Pencil,Plus,Recycle,RefreshCw,Search,ServerCog,Trash2,TriangleAlert} from 'lucide-react';
import type {Job,Server,Viewer} from '@/lib/types';
import type {Confirmation} from '@/ui/base/confirmation';
import {dnsFieldErrors,dnsManageBlocked,dnsRecordKey,isDnsChangeOperation,type DnsChangeOperation,type DnsFieldError} from '@/lib/dns-changes';
import {dnsChange,dnsConfirmation,dnsFormOperation,DnsFormDrawer,type DnsChange,type DnsForm} from '@/ui/devices/extensions/dns-forms';
import {adSessionsNow,ensureAdSessions,PluginAccountChip} from '@/ui/devices/extensions/plugin-ad';
import {adSessionForDevice} from '@/lib/plugin-ad';
import {demoDnsPlugin,demoDnsReadAt,demoDnsRecords,demoDnsSnapshot} from '@/ui/shell/demo-dns';
import {dnsConditionalForwarders,dnsKpis,dnsRecordTypeFilters,dnsStorageKey,dnsTtl,dnsZones,filterDnsRecords,filterDnsZones,isDnsRecordType,
 type DnsRecord,type DnsRecordTypeFilter,type DnsSnapshot,type DnsZone,type DnsZoneFilter,type DnsZoneRecords} from '@/lib/dns';
import type {DeviceDnsView,DeviceDnsZoneView} from '@/lib/server/extensions/dns-data';
import {snapshotPlugin} from '@/lib/plugin-catalog';
import {connectionKind} from '@/lib/device-connection';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {agentMessageText,agentMessageTextOr} from '@/lib/agent-messages';
import {api,message,permitted} from '@/ui/base/api';
import {Btn,Card,Empty,Facts,IconBtn,Kpi,KpiRow,Menu,Notice,PanelUnavailable,SectionHead,Segmented,Skeleton,StatusPill,exactTime,relativeTime,type MenuEntry} from '@/ui/kit/kit';
import {BulkBar,DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {Select} from '@/ui/kit/field';
import {Tabs} from '@/ui/kit/tabs';
import {useLocale,useT,type Translate} from '@/ui/base/locale';
import '@/ui/devices/extensions/dns.css';
import {EMPTY_VALUE} from '@/lib/i18n/format';

export type DnsSection='zones'|'conditional'|'forwarders'|'scavenging';
const sections:readonly DnsSection[]=['zones','conditional','forwarders','scavenging'];
const RECORD_PAGE=100;
type Props={server:Server;viewer:Viewer;demo:boolean;now:number;jobs:Job[];onBack?:()=>void;
 /** The install flow of the Plugins area; blocked carries its reason. */
 onInstall:()=>void;installBlocked?:string;
 /** Opens Management → Services (a stopped DNS Server service). */
 onOpenServices:()=>void;
 /** The visible devices: the account chip shows when the viewer manages DNS on one of them. */
 devices?:readonly Server[];
 /** The console confirmation; every change goes through it to POST /api/dns. */
 onConfirm?:(confirmation:Confirmation)=>void;
 /**
  * The open zone page from the link (#device/<id>/extensions/dns/<zone>) and its change (open and back). Without
  * onZone the view keeps the open zone itself. A zone that is not in the zone list shows the list; the link stays.
  */
 zone?:string;onZone?:(zone:string|null)=>void};

// A request of the command palette ("New DNS zone"): the view opens the form once it shows this device.
let pendingForm:{serverId:string;form:DnsForm}|null=null;
const pendingEvent='serverdesk:dns-form';
/** Opens a DNS form in the view of this device, now or when the view mounts. */
export function requestDnsForm(serverId:string,form:DnsForm={kind:'zone'}){pendingForm={serverId,form};if(typeof window!=='undefined')window.dispatchEvent(new Event(pendingEvent));}
/** The DNS change jobs of a device that wait or run. */
export const openDnsChangeJobs=(jobs:readonly Job[],serverId:string)=>jobs.filter(job=>job.serverId===serverId&&job.action==='plugin-job'&&isDnsChangeOperation(job.target)&&(job.state==='pending'||job.state==='running'));
/** The account chip gate of DNS: the right Manage DNS and its own missing-right text. */
const dnsAccountGate={permission:'dns.manage',rightKey:'dns.blocked.manageRight'} as const;

/** An interval in hours as words: "7 days" or "36 hours". */
export const dnsHoursLabel=(hours:number,t:Translate)=>hours>=24&&hours%24===0?t('dns.duration.days',{count:hours/24}):t('dns.duration.hours',{count:hours});
/** A TTL as words: "1 hour", "20 minutes". */
export function dnsTtlLabel(seconds:number,t:Translate){const value=dnsTtl(seconds);return t(`dns.duration.${value.unit}`,{count:value.value});}
/** The storage of a zone: "AD · Forest", "AD · Domain", "AD · All domain controllers", "AD · {partition}" or "File". */
export const dnsStorageLabel=(zone:Pick<DnsZone,'storage'|'replicationScope'|'partition'>,t:Translate)=>t(`dns.storage.${dnsStorageKey(zone)}`,{partition:zone.partition??''});
export const dnsKindLabel=(kind:DnsZone['kind'],t:Translate)=>t(`dns.kind.${kind}`);
export const dnsDynamicLabel=(value:DnsZone['dynamicUpdate'],t:Translate)=>t(`dns.dynamic.${value}`);

/** The change actions of the view; absent, the view shows no change controls. */
export type DnsManage={
 /** The reason why the operation cannot run now, or undefined. */
 blocked:(operation:DnsChangeOperation)=>string|undefined;
 open:(form:DnsForm)=>void;
 change:(change:DnsChange)=>void;
};

export default function DeviceDns({server,viewer,demo,now,jobs,onBack,onInstall,installBlocked,onOpenServices,devices=[],onConfirm,zone:routeZone,onZone}:Props){
 const t=useT(),[locale]=useLocale();
 const canRead=demo||permitted(server,viewer,'dns.read'),plugin=demo?demoDnsPlugin:snapshotPlugin(server.snapshot,'dns'),online=demo||connectionKind(server,now)==='online';
 const [loaded,setLoaded]=useState<{serverId:string;view:DeviceDnsView}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0);
 const [readJob,setReadJob]=useState<{id:string;since:number;zone?:string}|null>(null),[queueing,setQueueing]=useState(false);
 const [section,setSection]=useState<DnsSection>('zones'),[zoneFilter,setZoneFilter]=useState<DnsZoneFilter>({query:'',lookup:''}),[ownZone,setOwnZone]=useState<string|null>(null);
 const openZone=onZone?routeZone??null:ownZone,setOpenZone=onZone??setOwnZone;
 const [zoneData,setZoneData]=useState<{key:string;view:DeviceDnsZoneView}|null>(null),[zoneError,setZoneError]=useState('');
 const [form,setForm]=useState<DnsForm|null>(null),[serverErrors,setServerErrors]=useState<DnsFieldError[]>([]),[pending,setPending]=useState<string[]>([]);
 const sequence=useRef(0),zoneSequence=useRef(0);
 useEffect(()=>{
  if(demo||!canRead)return;
  const current=++sequence.current;
  queueMicrotask(()=>setLoading(true));
  api<DeviceDnsView>(`/api/dns?${new URLSearchParams({serverId:server.id})}`)
   .then(view=>{if(current===sequence.current){setLoaded({serverId:server.id,view});setError('');}},failure=>{if(current===sequence.current)setError(message(failure,locale));})
   .finally(()=>{if(current===sequence.current)setLoading(false);});
 },[demo,canRead,server.id,revision,locale]);
 // The records of the open zone, once the zone list holds it; they reload with the server data.
 const zoneListed=!!openZone&&loaded?.serverId===server.id&&!!loaded.view.snapshot?.zones.some(item=>item.name===openZone);
 useEffect(()=>{
  if(demo||!canRead||!openZone||!zoneListed)return;
  const current=++zoneSequence.current;
  api<DeviceDnsZoneView>(`/api/dns?${new URLSearchParams({serverId:server.id,zone:openZone})}`)
   .then(view=>{if(current===zoneSequence.current){setZoneData({key:server.id+'|'+openZone,view});setZoneError('');}},failure=>{if(current===zoneSequence.current)setZoneError(message(failure,locale));});
 },[demo,canRead,server.id,openZone,zoneListed,revision,locale]);
 // The read job (server or zone): once it ends the data reload; a failure says why in catalog text, never raw agent text. A job the console never lists gives up after 5 minutes.
 const job=readJob?jobs.find(item=>item.id===readJob.id):undefined;
 useEffect(()=>{
  if(!readJob)return;
  const ended=job&&!['pending','running'].includes(job.state),stale=!job&&now-readJob.since>5*60_000;
  if(!ended&&!stale)return;
  queueMicrotask(()=>{
   setReadJob(null);setRevision(value=>value+1);
   if(job&&job.state!=='succeeded')toast.error(agentMessageTextOr(job,t,'dns.error.read'));
  });
 },[readJob,job,now,t]);
 // Change jobs: the head counts them; when the last one ends the data reload in place (no entrance replays).
 const running=openDnsChangeJobs(jobs,server.id).length,lastRunning=useRef(running);
 useEffect(()=>{const before=lastRunning.current;lastRunning.current=running;if(before>0&&running===0)queueMicrotask(()=>{setPending([]);setRevision(value=>value+1);});},[running]);
 // The palette item "New DNS zone" opens the zone form here.
 useEffect(()=>{
  const take=()=>{if(pendingForm?.serverId!==server.id)return;const next=pendingForm.form;pendingForm=null;queueMicrotask(()=>{setServerErrors([]);setForm(next);});};
  take();window.addEventListener(pendingEvent,take);return ()=>window.removeEventListener(pendingEvent,take);
 },[server.id]);
 const view:DeviceDnsView|null=demo?{snapshot:demoDnsSnapshot(now),collectedAt:demoDnsReadAt(now),receivedAt:demoDnsReadAt(now),plugin:{version:demoDnsPlugin.version,state:'ready'}}:loaded?.serverId===server.id?loaded.view:null;
 const snapshot=view?.snapshot??null;
 const zoneView:DeviceDnsZoneView|null=!openZone?null:demo?{records:demoDnsRecords(now,openZone),collectedAt:demoDnsReadAt(now),receivedAt:demoDnsReadAt(now)}:zoneData?.key===server.id+'|'+openZone?zoneData.view:null;
 const readBlocked=demo?t('kit.unavailable.demo'):!online?t('extensions.blocked.offline'):!canRead?t('dns.blocked.readRight'):plugin?.state!=='ready'?t('dns.blocked.noPlugin'):undefined;
 const read=async(operation:'dns-read'|'dns-zone-read',zone?:string)=>{
  if(readBlocked||queueing||readJob)return;
  setQueueing(true);
  try{const {id}=await api<{id:string}>('/api/plugins',{action:'job',serverId:server.id,plugin:'dns',operation,...(zone?{parameters:{zone}}:{})});setReadJob({id,since:Date.now(),zone});window.dispatchEvent(new Event('serverdesk:refresh'));}
  catch(failure){toast.error(message(failure,locale));}
  finally{setQueueing(false);}
 };
 const kpis=useMemo(()=>snapshot?dnsKpis(snapshot):null,[snapshot]);
 const base=view&&view.collectedAt?t('dns.meta',{server:snapshot?.server.name||server.name,time:relativeTime(view.collectedAt,now,locale)}):'';
 // ---- Changes ----
 const blockedKey=(operation:DnsChangeOperation)=>dnsManageBlocked(server,viewer,demo,now,view,operation);
 const settled:Confirmation['onSettled']=outcome=>{if(outcome.ok){setForm(null);setServerErrors([]);}else setServerErrors(dnsFieldErrors(outcome.errors));};
 const manage:DnsManage={
  blocked:operation=>{const key=blockedKey(operation);return key?t(key,{device:server.name}):undefined;},
  open:next=>{setServerErrors([]);setForm(next);},
  change:change=>{
   if(!snapshot||!onConfirm||blockedKey(change.operation))return;
   // "Delay sign-in until needed": without a sign-in the dialog opens first; Cancel keeps the form and sends nothing.
   void ensureAdSessions([server],'dns').then(ok=>{
    if(!ok)return;
    const account=adSessionForDevice(adSessionsNow(),server.snapshot,Date.now())?.account??null;
    const keys=change.operation==='dns-record-delete'?(change.parameters.records as {name:string;type:string;data:Record<string,unknown>}[]).map(dnsRecordKey):[];
    onConfirm(dnsConfirmation(change,{device:{id:server.id,name:server.name},snapshot,t,adAccount:account},outcome=>{settled(outcome);if(outcome.ok&&keys.length)setPending(previous=>[...previous,...keys]);}));
   });
  },
 };
 const meta=[base,running?t('dns.running',{count:running}):''].filter(Boolean).join(' · ');
 const scavengeBlocked=manage.blocked('dns-scavenge-now')??(snapshot&&!snapshot.scavenging.enabled?t('dns.blocked.scavengingOff'):undefined);
 const headMenu:MenuEntry[]=[
  {id:'cache',label:t('dns.op.cacheClear'),icon:Eraser,blocked:manage.blocked('dns-cache-clear'),onSelect:()=>manage.change(dnsChange('dns-cache-clear',{}))},
  {id:'scavenge',label:t('dns.op.scavengeNowMenu'),icon:Recycle,blocked:scavengeBlocked,onSelect:()=>manage.change(dnsChange('dns-scavenge-now',{}))},
 ];
 // nodiverna-ui §4 "Device section": the back control a host may pass at the leading edge (SectionHead leading), the hidden
 // title with the freshness meta (announced politely), the account chip, "Read again" and the more-actions Menu; then one
 // panel notice while the changes are blocked.
 const manageNotice=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,'dns.manage'),reported:true,supported:true});
 const head=<>
  <SectionHead hideTitle id="sdx-dns-title" title={t('dns.title')} leading={onBack&&<IconBtn icon={ChevronLeft} label={t('dns.back')} onClick={onBack}/>} meta={meta?<span aria-live="polite">{meta}</span>:undefined}
   actions={canRead&&plugin?<><PluginAccountChip server={server} viewer={viewer} demo={demo} now={now} plugin="dns" gate={dnsAccountGate} devices={devices}/>
    <Btn variant="secondary" icon={RefreshCw} loading={queueing&&!readJob?.zone||!!readJob&&!readJob.zone} blocked={readBlocked} onClick={()=>void read('dns-read')}>{t('dns.readAgain')}</Btn>
    {snapshot&&<Menu label={t('dns.moreActions')} entries={headMenu} trigger={<IconBtn icon={MoreHorizontal} label={t('dns.moreActions')}/>}/>}</>:undefined}/>
  {canRead&&plugin&&<PanelUnavailable reason={manageNotice} readOnly={t('dns.readOnly')}/>}
 </>;
 const formOperation=form?dnsFormOperation(form):null;
 const drawer=form&&snapshot&&formOperation?<DnsFormDrawer key={JSON.stringify(form)} form={form} snapshot={snapshot} records={zoneView?.records??null} blocked={manage.blocked(formOperation)} busy={false}
  serverErrors={serverErrors} onCancel={()=>{setForm(null);setServerErrors([]);}} onSubmit={change=>manage.change(change)} t={t}/>:null;
 const frame=(children:ReactNode)=><section className="sdx-health-tab sdx-dns" aria-labelledby="sdx-dns-title">{head}{children}</section>;
 if(!canRead)return frame(<Empty icon={Lock} title={t('dns.empty.rightTitle')}>{t('dns.blocked.readRight')}</Empty>);
 if(!plugin)return frame(<Empty icon={Globe} title={t('dns.empty.noPlugin')} action={<Btn blocked={installBlocked} onClick={onInstall}>{t('extensions.install')}</Btn>}>{t('dns.empty.noPluginHint')}</Empty>);
 const damaged=plugin.state==='damaged'?<Notice tone="warning" icon={TriangleAlert} action={<Btn size="sm" blocked={installBlocked} onClick={onInstall}>{t('extensions.repair')}</Btn>}>{'error' in plugin&&typeof plugin.error==='string'?agentMessageText({result:t('extensions.state.damaged'),resultCode:plugin.error,resultArgs:{}},t):t('extensions.state.damaged')}</Notice>:null;
 if(!view&&!error)return frame(<>{damaged}<Skeleton variant="cards" rows={5} label={t('common.loading')}/><Skeleton variant="table" label={t('common.loading')}/></>);
 const failed=error?<Notice tone="danger" icon={TriangleAlert} action={<Btn size="sm" icon={RefreshCw} loading={loading} onClick={()=>setRevision(value=>value+1)}>{t('common.retry')}</Btn>}>{t('dns.error.load')}{snapshot&&<> {t('dns.error.stale')}</>}</Notice>:null;
 if(!snapshot)return frame(<>{damaged}{failed}{!error&&<Empty icon={Globe} title={t('dns.empty.noData')} action={<Btn icon={RefreshCw} loading={queueing||!!readJob} blocked={readBlocked} onClick={()=>void read('dns-read')}>{t('dns.empty.readNow')}</Btn>}>{t('dns.empty.noDataHint')}</Empty>}</>);
 const zone=openZone?snapshot.zones.find(item=>item.name===openZone)??null:null;
 const body=zone?<DnsZonePage zone={zone} view={zoneView} error={zoneError} t={t} locale={locale} now={now} manage={manage} pending={pending}
  readBlocked={readBlocked} reading={!!readJob&&readJob.zone===zone.name||queueing} onRead={()=>void read('dns-zone-read',zone.name)} onBack={()=>setOpenZone(null)} onRetry={()=>setRevision(value=>value+1)}/>
  :<DnsBody snapshot={snapshot} kpis={kpis!} t={t} locale={locale} section={section} onSection={setSection} zoneFilter={zoneFilter} onZoneFilter={setZoneFilter}
   onOpenZone={setOpenZone} onOpenServices={onOpenServices} manage={manage} scavengeBlocked={scavengeBlocked}/>;
 return frame(<>{damaged}{failed}{body}{drawer}</>);
}

type BodyProps={snapshot:DnsSnapshot;kpis:ReturnType<typeof dnsKpis>;t:Translate;locale:Parameters<typeof relativeTime>[2];section:DnsSection;onSection:(section:DnsSection)=>void;
 zoneFilter:DnsZoneFilter;onZoneFilter:(filter:DnsZoneFilter)=>void;onOpenZone:(zone:string)=>void;onOpenServices:()=>void;manage:DnsManage;scavengeBlocked?:string};

/** The row menu of a zone: open, settings, transfer (secondary and stub), and last the delete. */
export function dnsZoneEntries(zone:DnsZone,manage:DnsManage,t:Translate,onOpen:()=>void):MenuEntry[]{
 const transfer=zone.kind==='secondary'||zone.kind==='stub';
 return [
  {id:'open',label:t('dns.op.zoneOpen'),icon:ListTree,onSelect:onOpen},
  {id:'settings',label:t('dns.op.zoneSettings'),icon:Pencil,blocked:manage.blocked('dns-zone-edit'),onSelect:()=>manage.open({kind:'zoneSettings',zone:zone.name})},
  ...(transfer?[{id:'transfer',label:t('dns.op.zoneTransfer'),icon:RefreshCw,blocked:manage.blocked('dns-zone-transfer'),onSelect:()=>manage.change(dnsChange('dns-zone-transfer',{zone:zone.name}))} as MenuEntry]:[]),
  {id:'separator',separator:true} as MenuEntry,
  {id:'delete',label:t('dns.op.zoneDelete'),icon:Trash2,danger:true,blocked:manage.blocked('dns-zone-delete'),onSelect:()=>manage.change(dnsChange('dns-zone-delete',{zone:zone.name}))},
 ];
}
/** The row menu of a conditional forwarder: edit, then the delete. */
export function dnsConditionalEntries(zone:DnsZone,manage:DnsManage,t:Translate):MenuEntry[]{
 return [
  {id:'edit',label:t('dns.op.conditionalEdit'),icon:Pencil,blocked:manage.blocked('dns-conditional-edit'),onSelect:()=>manage.open({kind:'conditional',name:zone.name})},
  {id:'separator',separator:true} as MenuEntry,
  {id:'delete',label:t('dns.op.conditionalDelete'),icon:Trash2,danger:true,blocked:manage.blocked('dns-conditional-delete'),onSelect:()=>manage.change(dnsChange('dns-conditional-delete',{name:zone.name}))},
 ];
}

/** The loaded server: stopped notice, KPI row, server facts and the four sections. */
export function DnsBody({snapshot,kpis,t,locale,section,onSection,zoneFilter,onZoneFilter,onOpenZone,onOpenServices,manage,scavengeBlocked}:BodyProps){
 const zones=dnsZones(snapshot),conditional=dnsConditionalForwarders(snapshot);
 const counts:Record<DnsSection,number|undefined>={zones:zones.length,conditional:conditional.length,forwarders:snapshot.forwarders.servers.length,scavenging:undefined};
 const shown=filterDnsZones(zones,zoneFilter);
 const zoneColumns:DataColumn<DnsZone>[]=[
  {id:'zone',label:t('dns.col.zone'),primary:true,cell:zone=><span className="sdx-dns-zone"><strong className="mono">{zone.name}</strong>{zone.autoCreated&&<span className="sdx-tag">{t('dns.autoCreated')}</span>}</span>},
  {id:'type',label:t('dns.col.type'),cell:zone=>dnsKindLabel(zone.kind,t)},
  {id:'storage',label:t('dns.col.storage'),cell:zone=>dnsStorageLabel(zone,t),hideBelow:1100},
  {id:'dynamic',label:t('dns.col.dynamic'),cell:zone=>dnsDynamicLabel(zone.dynamicUpdate,t),hideBelow:1280},
  {id:'records',label:t('dns.col.records'),mono:true,align:'end',cell:zone=>zone.recordCount??EMPTY_VALUE},
  {id:'aging',label:t('dns.col.aging'),cell:zone=>zone.aging?t(zone.aging.enabled?'dns.kpi.on':'dns.kpi.off'):EMPTY_VALUE,hideBelow:1280},
  {id:'actions',label:t('dns.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:zone=><Menu label={t('dns.actionsFor',{name:zone.name})} entries={dnsZoneEntries(zone,manage,t,()=>onOpenZone(zone.name))}/>},
 ];
 const conditionalColumns:DataColumn<DnsZone>[]=[
  {id:'domain',label:t('dns.col.domain'),primary:true,mono:true,cell:zone=>zone.name},
  {id:'masters',label:t('dns.col.masters'),mono:true,wrap:true,cell:zone=>zone.masters.join(', ')||EMPTY_VALUE},
  {id:'storage',label:t('dns.col.storage'),cell:zone=>dnsStorageLabel(zone,t)},
  {id:'timeout',label:t('dns.col.timeout'),mono:true,cell:zone=>zone.forwarderTimeoutSeconds===null?EMPTY_VALUE:t('dns.duration.seconds',{count:zone.forwarderTimeoutSeconds})},
  {id:'actions',label:t('dns.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:zone=><Menu label={t('dns.actionsFor',{name:zone.name})} entries={dnsConditionalEntries(zone,manage,t)}/>},
 ];
 const newZone=<Btn size="sm" icon={Plus} blocked={manage.blocked('dns-zone-create')} onClick={()=>manage.open({kind:'zone'})}>{t('dns.op.newZone')}</Btn>;
 const newConditional=<Btn size="sm" icon={Plus} blocked={manage.blocked('dns-conditional-create')} onClick={()=>manage.open({kind:'conditional'})}>{t('dns.op.conditionalNew')}</Btn>;
 const reset=()=>onZoneFilter({query:'',lookup:''});
 const filtered=!!zoneFilter.query.trim()||!!zoneFilter.lookup;
 const lastRun=snapshot.scavenging.lastRunAt?exactTime(snapshot.scavenging.lastRunAt,locale):t('dns.facts.never');
 const panel=(()=>{
  if(section==='zones')return <DataTable label={t('dns.section.zones')} rows={shown} rowKey={zone=>zone.name} columns={zoneColumns} entranceId="dns-zones" cards
   onOpen={zone=>onOpenZone(zone.name)} openLabel={zone=>t('dns.openZone',{zone:zone.name})}
   toolbar={<Toolbar search={{value:zoneFilter.query,onChange:query=>onZoneFilter({...zoneFilter,query}),label:t('dns.search.zones'),placeholder:t('dns.search.zones')}}
    filters={<Segmented<''|'forward'|'reverse'> label={t('dns.filter.label')} size="sm" value={zoneFilter.lookup} onChange={lookup=>onZoneFilter({...zoneFilter,lookup})}
     items={[{id:'',label:t('dns.filter.all'),count:zones.length},{id:'forward',label:t('dns.filter.forward'),count:zones.filter(zone=>zone.lookup==='forward').length},{id:'reverse',label:t('dns.filter.reverse'),count:zones.filter(zone=>zone.lookup==='reverse').length}]}/>}
    actions={newZone}/>}
   foot={t('dns.zones.count',{shown:shown.length,total:zones.length})}
   empty={filtered?{icon:Search,title:t('dns.zones.emptyFilter'),action:<Btn size="sm" variant="ghost" onClick={reset}>{t('dns.zones.resetFilter')}</Btn>}
    :{icon:Globe,title:t('dns.zones.empty'),children:t('dns.zones.emptyHint'),action:newZone}}/>;
  if(section==='conditional')return <DataTable label={t('dns.section.conditional')} rows={conditional} rowKey={zone=>zone.name} columns={conditionalColumns} entranceId="dns-conditional" cards
   toolbar={<Toolbar actions={newConditional}/>} empty={{icon:Forward,title:t('dns.conditional.empty'),children:t('dns.conditional.emptyHint'),action:newConditional}}/>;
  if(section==='forwarders')return <Card title={t('dns.section.forwarders')} icon={Forward} actions={<Btn size="sm" icon={Pencil} blocked={manage.blocked('dns-forwarders-set')} onClick={()=>manage.open({kind:'forwarders'})}>{t('dns.op.forwardersEdit')}</Btn>}>
   {snapshot.forwarders.servers.length?<ol className="sdx-dns-forwarders">{snapshot.forwarders.servers.map(address=><li key={address} className="mono">{address}</li>)}</ol>:<p className="sdx-dns-muted">{t('dns.forwarders.none')}</p>}
   <Facts columns={2} items={[{label:t('dns.col.timeout'),value:t('dns.duration.seconds',{count:snapshot.forwarders.timeoutSeconds})},{label:t('dns.facts.rootHints'),value:t(snapshot.forwarders.useRootHints?'dns.server.yes':'dns.server.no')}]}/>
  </Card>;
  return <Card title={t('dns.section.scavenging')} icon={Recycle} actions={<>
   <Btn size="sm" icon={Recycle} blocked={scavengeBlocked} onClick={()=>manage.change(dnsChange('dns-scavenge-now',{}))}>{t('dns.op.scavengeNow')}</Btn>
   <Btn size="sm" icon={Pencil} blocked={manage.blocked('dns-scavenging-set')} onClick={()=>manage.open({kind:'scavenging'})}>{t('dns.op.scavengingEdit')}</Btn>
  </>}>
   <Facts columns={2} items={[
    {label:t('dns.field.autoScavenge'),value:<StatusPill kind={snapshot.scavenging.enabled?'success':'neutral'}>{t(snapshot.scavenging.enabled?'dns.kpi.on':'dns.kpi.off')}</StatusPill>},
    {label:t('dns.facts.interval'),value:dnsHoursLabel(snapshot.scavenging.intervalHours,t)},
    {label:t('dns.facts.lastRun'),value:lastRun},
    {label:t('dns.field.defaultAging'),value:t(snapshot.scavenging.defaultAging.enabled?'dns.kpi.on':'dns.kpi.off')},
    {label:t('dns.field.noRefresh'),value:dnsHoursLabel(snapshot.scavenging.defaultAging.noRefreshHours,t)},
    {label:t('dns.field.refresh'),value:dnsHoursLabel(snapshot.scavenging.defaultAging.refreshHours,t)},
   ]}/>
  </Card>;
 })();
 return <>
  {snapshot.service==='stopped'&&<Notice tone="warning" icon={TriangleAlert} action={<Btn size="sm" onClick={onOpenServices}>{t('dns.openServices')}</Btn>}>{t('dns.stopped')}</Notice>}
  <KpiRow label={t('dns.kpi.label')} entranceId="dns-kpis" className="sdx-dns-kpis">
   <Kpi key="zones" label={t('dns.kpi.zones')} value={kpis.zones} icon={Globe} detail={t('dns.kpi.zonesDetail',{forward:kpis.forward,reverse:kpis.reverse})}/>
   <Kpi key="ad" label={t('dns.kpi.ad')} value={kpis.ad} total={kpis.zones} icon={Network} detail={t('dns.kpi.adDetail',{zones:kpis.zones})}/>
   <Kpi key="records" label={t('dns.kpi.records')} value={kpis.records} icon={ListTree} detail={t('dns.kpi.recordsDetail')}/>
   <Kpi key="forwarders" label={t('dns.kpi.forwarders')} value={kpis.forwarders} icon={Forward} detail={t(kpis.useRootHints?'dns.kpi.rootHints':'dns.kpi.noRootHints')}/>
   <Kpi key="scavenging" label={t('dns.kpi.scavenging')} value={t(kpis.scavenging?'dns.kpi.on':'dns.kpi.off')} icon={Recycle} tone={kpis.scavenging?'accent':'neutral'} detail={kpis.scavenging?t('dns.kpi.every',{interval:dnsHoursLabel(kpis.intervalHours,t)}):undefined}/>
  </KpiRow>
  <Card title={t('dns.server.card')} icon={ServerCog}>
   <Facts columns={2} items={[
    {label:t('dns.server.name'),value:snapshot.server.name,mono:true},
    {label:t('dns.server.version'),value:snapshot.server.version??EMPTY_VALUE,mono:true},
    {label:t('dns.server.dc'),value:t(snapshot.server.isDomainController?'dns.server.yes':'dns.server.no')},
    {label:t('dns.server.listen'),value:snapshot.server.listenAddresses.join(', ')||EMPTY_VALUE,mono:true},
   ]}/>
  </Card>
  <Tabs label={t('dns.tabs.label')} variant="pill" value={section} onChange={id=>onSection(id as DnsSection)} panelId="sdx-dns-panel" items={sections.map(id=>({id,label:t(`dns.section.${id}`),count:counts[id]}))}/>
  <div id="sdx-dns-panel" role="tabpanel" aria-labelledby={`sdx-dns-panel-tab-${section}`} className="sdx-dns-panel" key={section}>{panel}</div>
 </>;
}

type ZonePageProps={zone:DnsZone;view:DeviceDnsZoneView|null;error:string;t:Translate;locale:Parameters<typeof relativeTime>[2];now:number;manage:DnsManage;pending:readonly string[];
 readBlocked?:string;reading:boolean;onRead:()=>void;onBack:()=>void;onRetry:()=>void};
/** Why a record cannot change: SOA, a type the portal does not change, or a zone that copies its records. */
export function dnsRecordBlocked(zone:Pick<DnsZone,'kind'>,record:Pick<DnsRecord,'type'>,t:Translate):string|undefined{
 if(zone.kind!=='primary')return t('dns.blocked.secondary');
 if(record.type==='SOA')return t('dns.blocked.soa');
 if(!isDnsRecordType(record.type))return t('dns.blocked.otherType');
 return undefined;
}
/** The data of a record as a confirmation and audit name: name, type and data. */
const identity=(record:DnsRecord)=>({name:record.name,type:record.type,data:record.data as Record<string,unknown>});

/** One zone: its settings in a quiet card, then the records table, the focal point of the page. */
export function DnsZonePage({zone,view,error,t,locale,now,manage,pending,readBlocked,reading,onRead,onBack,onRetry}:ZonePageProps){
 const [query,setQuery]=useState(''),[type,setType]=useState<DnsRecordTypeFilter>(''),[page,setPage]=useState(1),[selected,setSelected]=useState<string[]>([]);
 const records:DnsZoneRecords|null=view?.records??null,all=useMemo(()=>records?.records??[],[records]);
 const shown=useMemo(()=>filterDnsRecords(all,{query,type}),[all,query,type]);
 const pageRows=shown.slice((page-1)*RECORD_PAGE,page*RECORD_PAGE);
 const secondary=zone.kind!=='primary',secondaryReason=secondary?t('dns.blocked.secondary'):undefined;
 const blocked=(operation:DnsChangeOperation)=>secondaryReason??manage.blocked(operation);
 const chosen=all.filter(record=>selected.includes(dnsRecordKey(identity(record))));
 const transfers=zone.transfers.mode==='list'?`${t('dns.field.transfersList')}: ${zone.transfers.servers.join(', ')}`:t(({none:'dns.field.transfersOff',any:'dns.field.transfersAny',nameServers:'dns.field.transfersNs'} as const)[zone.transfers.mode]);
 const notify=zone.notify.mode==='off'?t('dns.field.transfersOff'):zone.notify.mode==='list'?`${t('dns.field.notifyList')}: ${zone.notify.servers.join(', ')}`:t('dns.field.notifyNs');
 const filter=(update:()=>void)=>{update();setPage(1);};
 const recordColumns:DataColumn<DnsRecord>[]=[
  {id:'name',label:t('dns.col.name'),primary:true,mono:true,cell:record=>record.name},
  {id:'type',label:t('dns.col.type'),cell:record=><span className="sdx-tag">{record.type}</span>},
  {id:'data',label:t('dns.col.data'),mono:true,wrap:true,cell:record=>record.text||EMPTY_VALUE},
  {id:'ttl',label:t('dns.col.ttl'),cell:record=>dnsTtlLabel(record.ttlSeconds,t),hideBelow:1100},
  {id:'timestamp',label:t('dns.col.timestamp'),cell:record=>record.timestamp?exactTime(record.timestamp,locale):t('dns.static'),hideBelow:1280},
  {id:'actions',label:t('dns.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:record=>{
   const reason=dnsRecordBlocked(zone,record,t);
   return <Menu label={t('dns.actionsFor',{name:`${record.name} ${record.type}`})} entries={[
    {id:'edit',label:t('dns.op.recordEdit'),icon:Pencil,blocked:reason??manage.blocked('dns-record-edit'),onSelect:()=>manage.open({kind:'record',zone:zone.name,record})},
    {id:'separator',separator:true} as MenuEntry,
    {id:'delete',label:t('dns.op.recordDelete'),icon:Trash2,danger:true,blocked:reason??manage.blocked('dns-record-delete'),onSelect:()=>manage.change(dnsChange('dns-record-delete',{zone:zone.name,records:[identity(record)]}))},
   ]}/>;
  }},
 ];
 const addRecord=<Btn size="sm" icon={Plus} blocked={blocked('dns-record-add')??(records?undefined:t('dns.error.recordsNotRead'))} onClick={()=>manage.open({kind:'record',zone:zone.name})}>{t('dns.op.recordAdd')}</Btn>;
 const readAgain=<Btn size="sm" variant="ghost" icon={RefreshCw} loading={reading} blocked={readBlocked} onClick={onRead}>{t('dns.op.readRecordsAgain')}</Btn>;
 const bulkBlocked=manage.blocked('dns-record-delete')??(chosen.length>100?t('dns.records.tooMany',{count:100}):undefined);
 const filtered=!!query.trim()||!!type;
 const recordsBody=(()=>{
  if(error&&!records)return <Notice tone="danger" icon={TriangleAlert} action={<Btn size="sm" icon={RefreshCw} onClick={onRetry}>{t('common.retry')}</Btn>}>{t('dns.error.load')}</Notice>;
  if(!view)return <Skeleton variant="table" label={t('common.loading')}/>;
  if(!records)return <Empty icon={ListTree} title={t('dns.records.notRead')} action={<Btn icon={RefreshCw} loading={reading} blocked={readBlocked} onClick={onRead}>{t('dns.op.readRecords')}</Btn>}>{t('dns.records.notReadHint',{zone:zone.name})}</Empty>;
  return <>
   {records.truncated&&<Notice tone="info" icon={ListTree}>{t('dns.records.truncated',{shown:all.length,total:records.total})}</Notice>}
   <DataTable label={t('dns.records.label',{zone:zone.name})} rows={pageRows} rowKey={record=>dnsRecordKey(identity(record))} columns={recordColumns} entranceId="dns-records" cards
    highlightKey={pending.filter(key=>all.some(record=>dnsRecordKey(identity(record))===key))} className={pending.length?'sdx-dns-records-pending':undefined}
    // Selection only on a primary zone, and only records the portal may change (no SOA, no other type).
    selection={secondary?undefined:{selected,onChange:setSelected,selectable:record=>!dnsRecordBlocked(zone,record,t),rowLabel:record=>t('dns.selectRecord',{name:record.name,type:record.type}),allLabel:t('dns.selectAll')}}
    toolbar={<Toolbar search={{value:query,onChange:value=>filter(()=>setQuery(value)),label:t('dns.search.records'),placeholder:t('dns.search.records')}}
     filters={<Select size="sm" aria-label={t('dns.col.type')} value={type} onChange={event=>filter(()=>setType(event.target.value as DnsRecordTypeFilter))}>
      {dnsRecordTypeFilters.map(item=><option key={item||'all'} value={item}>{item===''?t('dns.filter.all'):item==='other'?t('dns.filter.other'):item}</option>)}
     </Select>}
     actions={<>{readAgain}{addRecord}</>}/>}
    foot={t('dns.records.count',{shown:shown.length,total:all.length})} pagination={{page,pageSize:RECORD_PAGE,total:shown.length,onPage:setPage}}
    empty={filtered?{icon:Search,title:t('dns.records.emptyFilter'),action:<Btn size="sm" variant="ghost" onClick={()=>filter(()=>{setQuery('');setType('');})}>{t('dns.zones.resetFilter')}</Btn>}:{icon:ListTree,title:t('dns.records.empty')}}/>
   <BulkBar count={chosen.length} onClear={()=>setSelected([])} label={t('dns.selection')}>
    <Btn size="sm" variant="danger" icon={Trash2} blocked={bulkBlocked} onClick={()=>{manage.change(dnsChange('dns-record-delete',{zone:zone.name,records:chosen.map(identity)},'dns.op.recordsDelete'));setSelected([]);}}>{t('dns.op.recordsDelete')}</Btn>
   </BulkBar>
  </>;
 })();
 return <div className="sdx-dns-zone-page">
  <div className="sdx-dns-zone-head">
   <IconBtn icon={ChevronLeft} label={t('dns.op.allZones')} onClick={onBack}/>
   <h3 className="mono">{zone.name}</h3>
   <StatusPill kind={zone.kind==='primary'?'accent':'neutral'}>{dnsKindLabel(zone.kind,t)}</StatusPill>
   {view?.collectedAt&&records&&<small aria-live="polite">{t('dns.records.readAt',{time:relativeTime(view.collectedAt,now,locale)})}</small>}
  </div>
  <Card title={t('dns.zone.settings')} icon={Globe} actions={<Btn size="sm" icon={Pencil} blocked={manage.blocked('dns-zone-edit')} onClick={()=>manage.open({kind:'zoneSettings',zone:zone.name})}>{t('dns.op.zoneSettings')}</Btn>}>
   <Facts columns={2} items={[
    {label:t('dns.col.type'),value:`${dnsKindLabel(zone.kind,t)} · ${t(zone.lookup==='forward'?'dns.field.forwardLookup':'dns.field.reverseLookup')}`},
    {label:t('dns.col.storage'),value:dnsStorageLabel(zone,t)},
    {label:t('dns.field.file'),value:zone.fileName??EMPTY_VALUE,mono:!!zone.fileName},
    {label:t('dns.col.dynamic'),value:dnsDynamicLabel(zone.dynamicUpdate,t)},
    {label:t('dns.field.transfers'),value:transfers},
    {label:t('dns.field.notify'),value:notify},
    {label:t('dns.field.masters'),value:zone.masters.join(', ')||EMPTY_VALUE,mono:zone.masters.length>0},
    {label:t('dns.col.aging'),value:zone.aging?.enabled?t('dns.facts.agingOn',{noRefresh:zone.aging.noRefreshHours,refresh:zone.aging.refreshHours}):t('dns.kpi.off')},
   ]}/>
  </Card>
  {secondary&&<Notice tone="info" icon={Lock}>{t('dns.blocked.secondary')}</Notice>}
  {recordsBody}
 </div>;
}
