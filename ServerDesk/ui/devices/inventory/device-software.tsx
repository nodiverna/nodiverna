'use client';
// The device area Management → Software (docs/device-health-signals.md): the
// installed programs with a search field and the change history, from
// GET /api/software/device. The device right view is enough, as for the
// hardware inventory. Sample devices get their list in the browser. With the
// vulnerability check on (docs/software-vulnerabilities.md) the list gets a
// Vulnerabilities column, a third view lists the vulnerable programs, and a
// severity pill opens the CVEs in a drawer. The views switch with a Segmented beside the search in one
// kit Toolbar (a view switch without a route of its own); the search filters every view by program name.
import {useEffect,useMemo,useRef,useState} from 'react';
import {AlertTriangle,History,Package,RefreshCw,Search,ShieldCheck} from 'lucide-react';
import type {Server} from '@/lib/types';
import type {DeviceSoftwareView} from '@/lib/server/devices/software';
import {demoSoftwareView} from '@/ui/shell/demo';
import {demoVulnerabilityDetail} from '@/ui/shell/demo-vulnerabilities';
import {softwareMatches,softwareSearchTokens} from '@/lib/software-inventory';
import {compareVerdicts,type Verdict} from '@/lib/software-vulnerabilities';
import {formatSupportDate} from '@/ui/base/ui-device';
import type {MessageKey} from '@/lib/i18n/translate';
import {api,message} from '@/ui/base/api';
import {Btn,Card,Drawer,Empty,Notice,SectionHead,Segmented,Skeleton,exactTime,type SegmentItem} from '@/ui/kit/kit';
import {DataTable,Toolbar,pageWindow,type DataColumn} from '@/ui/kit/data-table';
import {useLocale,useT} from '@/ui/base/locale';
import {VerdictPill,VulnerabilityList,VulnerabilityStatusNotice,recommendationText} from '@/ui/devices/inventory/vulnerability-list';
import {EMPTY_VALUE} from '@/lib/i18n/format';

export type DeviceSoftwareTab='installed'|'history'|'vulnerabilities';
type Item=DeviceSoftwareView['items'][number];
type Change=DeviceSoftwareView['changes'][number];
const changeKeys:Record<Change['change'],MessageKey>={installed:'software.change.installed',updated:'software.change.updated',removed:'software.change.removed'};
const itemKey=(item:Item)=>`${item.scope}:${item.architecture??''}:${item.key}`;
const urgent=(verdict:Verdict|undefined)=>verdict?.status==='vulnerable'&&(verdict.highest==='critical'||verdict.highest==='high');
/** The installed list pages at 50 rows, like the scope Software tab. */
export const DEVICE_SOFTWARE_PAGE_SIZE=50;

export default function DeviceSoftware({server,demo,now,owner=false,initialView='installed'}:{server:Server;demo:boolean;now:number;/** Global Owner: the off notice offers Turn on. */owner?:boolean;/** The view shown first. */initialView?:DeviceSoftwareTab}){
 const t=useT(),[locale]=useLocale();
 const [requestedView,setView]=useState<DeviceSoftwareTab>(initialView),[query,setQuery]=useState(''),[open,setOpen]=useState<Item|null>(null);
 const [loaded,setLoaded]=useState<{id:string;data:DeviceSoftwareView}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0);
 const [chosenPage,setChosenPage]=useState({key:'',page:1});
 const sequence=useRef(0);
 useEffect(()=>{
  if(demo)return;
  const current=++sequence.current;queueMicrotask(()=>setLoading(true));
  api<DeviceSoftwareView>(`/api/software/device?${new URLSearchParams({id:server.id})}`)
   .then(data=>{if(current===sequence.current){setLoaded({id:server.id,data});setError('');}},failure=>{if(current===sequence.current)setError(message(failure,locale));})
   .finally(()=>{if(current===sequence.current)setLoading(false);});
 },[demo,server.id,locale,revision]);
 // "Try again" repeats exactly the failed GET; the rows already shown stay.
 const retry=()=>setRevision(value=>value+1);
 const data=demo?demoSoftwareView(server.id,now):loaded?.id===server.id?loaded.data:null;
 const checking=!!data?.vulnerabilities?.enabled;
 const view:DeviceSoftwareTab=requestedView==='vulnerabilities'&&!checking?'installed':requestedView;
 const tokens=softwareSearchTokens(query);
 const items=useMemo(()=>(data?.items??[]).filter(item=>softwareMatches(item,tokens)),[data,tokens]);
 const vulnerable=useMemo(()=>(data?.items??[]).filter(item=>item.verdict?.status==='vulnerable').sort((a,b)=>compareVerdicts(a.verdict!,b.verdict!)||a.name.localeCompare(b.name)),[data]);
 // The search filters the history and the vulnerable programs by program name, like the installed list.
 const named=(name:string)=>{const lower=name.normalize('NFKC').toLowerCase();return tokens.every(token=>lower.includes(token));};
 const shownVulnerable=vulnerable.filter(item=>named(item.name)),shownChanges=(data?.changes??[]).filter(change=>named(change.name));
 // Paging: back to page 1 when the device, the view or the search changes.
 const pageKey=`${server.id}\u0000${view}\u0000${query}`;
 const shown=pageWindow(chosenPage.key===pageKey?chosenPage.page:1,DEVICE_SOFTWARE_PAGE_SIZE,items.length);
 const pageItems=items.slice(shown.from,shown.to);
 const reported=server.snapshot?.softwareChecksum!==undefined;
 const views:SegmentItem<DeviceSoftwareTab>[]=[
  {id:'installed',label:t('software.view.installed'),count:data?.items.length},
  {id:'history',label:t('software.view.history'),count:data?.changes.length},
  ...(checking?[{id:'vulnerabilities',label:t('vulnerabilities.view'),count:vulnerable.length,tone:vulnerable.some(item=>urgent(item.verdict))?'critical' as const:undefined} satisfies SegmentItem<DeviceSoftwareTab>]:[]),
 ];
 const pill=(item:Item)=><VerdictPill verdict={item.verdict} name={item.name} onOpen={item.verdict?.status==='vulnerable'&&item.normalizedVersion?()=>setOpen(item):undefined}/>;
 const installedColumns:DataColumn<Item>[]=[
  {id:'name',label:t('software.col.name'),primary:true,wrap:true,cell:item=>item.name},
  {id:'version',label:t('software.col.version'),mono:true,cell:item=>item.version??EMPTY_VALUE},
  ...(checking?[{id:'risk',label:t('vulnerabilities.col'),cell:pill} satisfies DataColumn<Item>]:[]),
  {id:'publisher',label:t('software.col.publisher'),wrap:true,cell:item=><span className="sdx-muted-cell">{item.publisher??EMPTY_VALUE}</span>},
  {id:'installedOn',label:t('software.col.installedOn'),mono:true,cell:item=>item.installDate?formatSupportDate(locale,item.installDate):EMPTY_VALUE},
  {id:'architecture',label:t('software.col.architecture'),mono:true,cell:item=>item.architecture??EMPTY_VALUE},
  {id:'scope',label:t('software.col.scope'),cell:item=><span className="sdx-muted-cell">{t(item.scope==='user'?'software.scope.user':'software.scope.machine')}</span>},
 ];
 const vulnerableColumns:DataColumn<Item>[]=[
  {id:'name',label:t('software.col.name'),primary:true,wrap:true,cell:item=>item.name},
  {id:'version',label:t('software.col.version'),mono:true,cell:item=>item.version??EMPTY_VALUE},
  {id:'highest',label:t('vulnerabilities.col.highest'),cell:pill},
  {id:'count',label:t('vulnerabilities.col.count'),mono:true,cell:item=>item.verdict!.count},
  {id:'exploited',label:t('vulnerabilities.col.exploited'),cell:item=>item.verdict!.knownExploited?<span className="sdx-tag sdx-vuln-exploited">{t('vulnerabilities.knownExploited')}</span>:<span className="sdx-muted-cell">{t('vulnerabilities.csv.no')}</span>},
  {id:'recommendation',label:t('vulnerabilities.col.recommendation'),wrap:true,cell:item=>recommendationText(item.verdict!,t)},
 ];
 const historyColumns:DataColumn<Change>[]=[
  {id:'time',label:t('software.col.time'),cell:change=><span className="sdx-nowrap">{exactTime(change.at,locale)}</span>},
  {id:'change',label:t('software.col.change'),cell:change=>t(changeKeys[change.change])},
  {id:'name',label:t('software.col.name'),primary:true,wrap:true,cell:change=>change.name},
  {id:'version',label:t('software.col.version'),mono:true,cell:change=>change.change==='updated'?t('software.versionChange',{from:change.versionFrom??EMPTY_VALUE,to:change.versionTo??EMPTY_VALUE}):(change.versionTo??change.versionFrom??EMPTY_VALUE)},
 ];
 const retryButton=<Btn size="sm" icon={RefreshCw} loading={loading} onClick={retry}>{t('common.retry')}</Btn>;
 // One Toolbar for every view: the search, then the view switch with its counts.
 const toolbar=<Toolbar search={{value:query,onChange:setQuery,label:t('software.search'),placeholder:t('software.search')}}
  filters={<Segmented<DeviceSoftwareTab> size="sm" label={t('software.title')} value={view} onChange={setView} items={views}/>}/>;
 const noMatch={icon:Search,title:t('software.noProgramMatch')};
 let content;
 if(!data)content=error?null:<Skeleton variant="table" label={t('software.loading')} after={15000} action={retryButton}/>;
 else if(!data.state)content=<Empty icon={Package} title={t('software.empty')}>{reported?undefined:t('software.notReported')}</Empty>;
 else content=<Card flush className="sdx-health-card">
  {view==='installed'?<DataTable variant="flush" cards label={t('software.view.installed')} columns={installedColumns} rows={pageItems} rowKey={itemKey} busy={loading} entranceId={'device-software:'+server.id}
   toolbar={toolbar} empty={data.items.length?noMatch:{icon:Package,title:t('software.empty')}}
   foot={t('software.foot',{shown:items.length,count:data.items.length})}
   pagination={{page:shown.page,pageSize:DEVICE_SOFTWARE_PAGE_SIZE,total:items.length,onPage:page=>setChosenPage({key:pageKey,page})}}/>
  :view==='vulnerabilities'?<DataTable variant="flush" cards label={t('vulnerabilities.view')} columns={vulnerableColumns} rows={shownVulnerable} rowKey={itemKey} busy={loading} toolbar={toolbar}
   empty={vulnerable.length?noMatch:{icon:ShieldCheck,title:t('vulnerabilities.deviceEmpty')}}/>
  :<DataTable variant="flush" cards label={t('software.view.history')} columns={historyColumns} rows={shownChanges} rowKey={change=>String(change.id)} busy={loading} toolbar={toolbar}
   empty={data.changes.length?noMatch:{icon:History,title:t('software.historyEmpty')}}/>}
 </Card>;
 return <div className="sdx-health-panel">
  <SectionHead hideTitle title={t('software.title')} description={t('software.meta')} meta={data?.state?t('software.reportedAt',{time:exactTime(data.state.reportedAt,locale)}):undefined}/>
  {error&&<Notice tone="danger" icon={AlertTriangle} action={retryButton}>{t('software.loadFailed')}</Notice>}
  {data?.state&&<VulnerabilityStatusNotice status={data.vulnerabilities} owner={owner} now={now}/>}
  {data?.state?.truncated&&<Notice tone="info" icon={Package}>{t('software.truncated')}</Notice>}
  {content}
  <Drawer open={!!open} onClose={()=>setOpen(null)} title={open?t('vulnerabilities.drawerTitle',{name:open.name,version:open.version??''}):''} description={open?.publisher??undefined} wide>
   {open?.normalizedVersion&&<VulnerabilityList target={{name:open.normalizedName,version:open.normalizedVersion,device:server.id}} demo={demo?demoVulnerabilityDetail(open.normalizedName,open.normalizedVersion,open.publisher):undefined}/>}
  </Drawer>
 </div>;
}
