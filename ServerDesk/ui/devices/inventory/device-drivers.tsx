'use client';
// The device area Management → Drivers (docs/device-health-signals.md): the
// problem devices of Device Manager from the snapshot first, then the driver list
// from GET /api/drivers/device with a search field and the "Show" select
// (unsigned, older than 3, 5 or 10 years). The link of a crash issue opens the
// area with the search set to the driver file, highlights every matching row and
// scrolls to the first one. The device right view is enough. Sample devices get
// their list in the browser. A failed driver read (collectorErrors of agent
// 4.11.1) shows "not available" without a stored list, or a warning above the
// last stored list.
import {useEffect,useMemo,useRef,useState} from 'react';
import {Select} from '@/ui/kit/field';
import {AlertTriangle,CircuitBoard,Clock,RefreshCw,Search,TriangleAlert} from 'lucide-react';
import type {CollectorErrorCode,Server} from '@/lib/types';
import type {DeviceDriverView} from '@/lib/server/devices/drivers';
import {demoDriverView} from '@/ui/shell/demo';
import {deviceProblemText} from '@/ui/base/device-problem-codes';
import {driverFileMatches,driverMatches,driverSearchTokens,driverShowOptions,driverShown,type DriverShow} from '@/lib/driver-inventory';
import {formatSupportDate} from '@/ui/base/ui-device';
import {collectorError} from '@/ui/devices/inventory/health-signals';
import {agentBaseVersion,compareAgentVersions} from '@/lib/agent-update-state';
import type {MessageKey} from '@/lib/i18n/translate';
import {api,message} from '@/ui/base/api';
import {Btn,Card,Empty,Notice,SectionHead,Skeleton,exactTime} from '@/ui/kit/kit';
import {DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {useLocale,useT} from '@/ui/base/locale';
import {SignedCell} from '@/ui/devices/inventory/health-table';
import {EMPTY_VALUE} from '@/lib/i18n/format';

const reasonKeys:Record<CollectorErrorCode,MessageKey>={timeout:'drivers.unavailable.reason.timeout','access-denied':'drivers.unavailable.reason.accessDenied','not-supported':'drivers.unavailable.reason.notSupported','broker-unavailable':'drivers.unavailable.reason.brokerUnavailable',error:'drivers.unavailable.reason.error'};
/** The reason sentence of a failed driver read; an unknown code reads as a general error. */
export const driverReasonKey=(code:string):MessageKey=>reasonKeys[code as CollectorErrorCode]??reasonKeys.error;

/** The driver list without a stored list: a failed read, a 4.11.x agent that has not reported yet, or an older agent. */
export function DriversEmpty({server}:{server:Pick<Server,'snapshot'>}){
 const t=useT(),[locale]=useLocale(),failure=collectorError(server.snapshot,'drivers');
 if(failure)return <Empty icon={CircuitBoard} title={t('drivers.unavailable.title')}>{t(driverReasonKey(failure.code))} {t('drivers.unavailable.since',{time:exactTime(failure.since,locale)})}</Empty>;
 const snapshot=server.snapshot,current=(compareAgentVersions(agentBaseVersion(snapshot?.agentVersion),'4.11.0')??-1)>=0;
 return <Empty icon={CircuitBoard} title={t('drivers.empty')}>{snapshot?.driverHealth!==undefined?undefined:current?t('drivers.notReportedYet'):t('drivers.notReported')}</Empty>;
}

const showKeys:Record<DriverShow,MessageKey>={all:'drivers.show.all',unsigned:'drivers.show.unsigned',older3:'drivers.show.older3',older5:'drivers.show.older5',older10:'drivers.show.older10'};
type Problem=NonNullable<NonNullable<Server['snapshot']>['driverHealth']>['problems'][number];
type Driver=DeviceDriverView['items'][number];

/** The card "Problem devices": hidden without driver data, one line when the agent reports none. */
export function ProblemDevices({server}:{server:Pick<Server,'snapshot'>}){
 const t=useT(),[locale]=useLocale(),health=server.snapshot?.driverHealth;
 if(!health)return null;
 const columns:DataColumn<Problem>[]=[
  {id:'device',label:t('drivers.col.device'),primary:true,wrap:true,cell:problem=><span className="sdx-cell-stack"><span>{problem.name}</span>{problem.manufacturer&&<small>{problem.manufacturer}</small>}</span>},
  {id:'class',label:t('drivers.col.class'),cell:problem=><span className="sdx-muted-cell">{problem.class??EMPTY_VALUE}</span>},
  {id:'problem',label:t('drivers.col.problem'),wrap:true,cell:problem=>deviceProblemText(problem.code,locale)},
 ];
 return <Card title={t('drivers.problems.title')} icon={TriangleAlert} iconTone={health.problems.length?'warning':'success'} meta={health.problems.length?String(health.problems.length):undefined} className="sdx-problem-devices" flush>
  {!health.problems.length?<p className="sdx-card-line">{t('drivers.problems.none')}</p>
   :<DataTable variant="flush" cards label={t('drivers.problems.title')} columns={columns} rows={health.problems} rowKey={problem=>problem.key}
     empty={{icon:TriangleAlert,title:t('drivers.problems.none')}} foot={health.problemsTruncated?t('drivers.problems.truncated'):undefined}/>}
 </Card>;
}

export default function DeviceDrivers({server,demo,now,focus}:{server:Server;demo:boolean;now:number;/** A driver file from a crash issue: sets the search and highlights its rows. */focus?:{driver:string;revision:number}}){
 const t=useT(),[locale]=useLocale();
 const [query,setQuery]=useState(focus?.driver??''),[show,setShow]=useState<DriverShow>('all'),[seenFocus,setSeenFocus]=useState(focus?.revision);
 const [loaded,setLoaded]=useState<{id:string;data:DeviceDriverView}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0);
 const sequence=useRef(0),root=useRef<HTMLDivElement|null>(null),shownFocus=useRef<number|undefined>(undefined);
 // A new crash link replaces the search (state adjusted during render, no effect).
 if(focus&&focus.revision!==seenFocus){setSeenFocus(focus.revision);setQuery(focus.driver);setShow('all');}
 useEffect(()=>{
  if(demo)return;
  const current=++sequence.current;queueMicrotask(()=>setLoading(true));
  api<DeviceDriverView>(`/api/drivers/device?${new URLSearchParams({id:server.id})}`)
   .then(data=>{if(current===sequence.current){setLoaded({id:server.id,data});setError('');}},failure=>{if(current===sequence.current)setError(message(failure,locale));})
   .finally(()=>{if(current===sequence.current)setLoading(false);});
 },[demo,server.id,locale,revision]);
 // "Try again" repeats exactly the failed GET; the rows already shown stay.
 const retry=()=>setRevision(value=>value+1);
 const data=demo?demoDriverView(server.id,now):loaded?.id===server.id?loaded.data:null;
 const tokens=driverSearchTokens(query);
 const items=useMemo(()=>(data?.items??[]).filter(item=>driverMatches(item,tokens)&&driverShown(item,show,now)),[data,tokens,show,now]);
 const highlight=focus?.driver&&query===focus.driver?focus.driver:null;
 const highlighted=useMemo(()=>highlight?items.filter(item=>driverFileMatches(item,highlight)).map(item=>item.key):[],[items,highlight]);
 const missing=highlight&&data?.state&&!data.items.some(item=>driverFileMatches(item,highlight));
 const failure=collectorError(server.snapshot,'drivers');
 // Once per crash link: scroll the first highlighted row (or card) into view and focus it.
 const firstHighlighted=highlighted[0],focusRevision=focus?.revision;
 useEffect(()=>{
  if(!firstHighlighted||focusRevision===undefined||shownFocus.current===focusRevision)return;
  const target=[...root.current?.querySelectorAll<HTMLElement>('[data-row-key][tabindex="-1"]')??[]].find(node=>node.getClientRects().length>0);
  if(!target)return;
  shownFocus.current=focusRevision;
  target.scrollIntoView({block:'center',behavior:'auto'});
  target.focus({preventScroll:true});
 },[firstHighlighted,focusRevision]);
 const columns:DataColumn<Driver>[]=[
  {id:'device',label:t('drivers.col.device'),primary:true,wrap:true,cell:item=><span className="sdx-cell-stack"><span>{item.deviceName}</span>{item.deviceClass&&<small>{item.deviceClass}</small>}</span>},
  {id:'driver',label:t('drivers.col.driver'),mono:true,cell:item=>item.infName??EMPTY_VALUE},
  {id:'file',label:t('drivers.col.file'),mono:true,cell:item=>item.file??EMPTY_VALUE},
  {id:'version',label:t('drivers.col.version'),mono:true,cell:item=>item.version??EMPTY_VALUE},
  {id:'date',label:t('drivers.col.date'),mono:true,cell:item=>item.date?formatSupportDate(locale,item.date):EMPTY_VALUE},
  {id:'provider',label:t('drivers.col.provider'),cell:item=><span className="sdx-muted-cell">{item.provider??EMPTY_VALUE}</span>},
  {id:'signed',label:t('drivers.col.signed'),cell:item=><SignedCell signed={item.signed}/>},
 ];
 const retryButton=<Btn size="sm" icon={RefreshCw} loading={loading} onClick={retry}>{t('common.retry')}</Btn>;
 return <div className="sdx-health-panel" ref={root}>
  <SectionHead hideTitle title={t('drivers.title')} description={t('drivers.meta')} meta={data?.state?t('software.reportedAt',{time:exactTime(data.state.reportedAt,locale)}):undefined}/>
  {error&&<Notice tone="danger" icon={AlertTriangle} action={retryButton}>{t('drivers.loadFailed')}</Notice>}
  <ProblemDevices server={server}/>
  <Card title={t('drivers.listTitle')} icon={CircuitBoard} iconTone="accent" className="sdx-health-card" flush>
   {data?.state&&<Toolbar search={{value:query,onChange:setQuery,label:t('drivers.search'),placeholder:t('drivers.search')}}
    filters={<label className="sdx-inline-select"><span>{t('drivers.show')}</span><Select size="sm" value={show} onChange={event=>setShow(event.target.value as DriverShow)}>{driverShowOptions.map(option=><option key={option} value={option}>{t(showKeys[option])}</option>)}</Select></label>}/>}
   {failure&&data?.state&&<Notice tone="warning" icon={Clock}>{t('drivers.unavailable.stale',{time:exactTime(data.state.reportedAt,locale)})} {t(driverReasonKey(failure.code))}</Notice>}
   {data?.state?.truncated&&<Notice tone="info" icon={CircuitBoard}>{t('drivers.truncated')}</Notice>}
   {missing&&<Notice tone="info" icon={Search}>{t('drivers.fileNotFound',{file:highlight})}</Notice>}
   {!data?(error?null:<Skeleton variant="table" label={t('drivers.loading')} after={15000} action={retryButton}/>)
    :!data.state?<DriversEmpty server={server}/>
    :<DataTable variant="flush" cards label={t('drivers.title')} columns={columns} rows={items} rowKey={item=>item.key} busy={loading} highlightKey={highlighted} entranceId={'device-drivers:'+server.id}
      empty={data.items.length?{icon:Search,title:t('drivers.noMatch')}:{icon:CircuitBoard,title:t('drivers.empty')}}
      foot={t('drivers.foot',{shown:items.length,count:data.items.length})}/>}
  </Card>
 </div>;
}
