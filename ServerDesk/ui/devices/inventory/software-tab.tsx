'use client';
// The scope tab "Software" (docs/device-health-signals.md): the programs of the
// visible devices in the scope, grouped by product and version on the server
// (GET /api/software), with a debounced search, the devices of a row in a
// drawer and the CSV export of the shown rows. With the vulnerability check on
// (docs/software-vulnerabilities.md) a sortable Vulnerabilities column, the
// filter All / Vulnerable (vulnerable=1) and the CVEs of a row in its drawer.
import {useEffect,useMemo,useRef,useState} from 'react';
import {useClockNow} from '@/ui/base/clock-store';
import {toast} from 'sonner';
import {ChevronRight,Download,Package,Search,ShieldAlert,ShieldCheck} from 'lucide-react';
import type {Server} from '@/lib/types';
import type {SoftwareFleetView} from '@/lib/server/devices/software';
import {demoSoftwareFleet} from '@/ui/shell/demo';
import {demoVulnerabilityDetail} from '@/ui/shell/demo-vulnerabilities';
import {softwareCsv,softwareCsvFileName} from '@/ui/devices/inventory/software-csv';
import {verdictSortValue} from '@/lib/software-vulnerabilities';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import {sortTableRows} from '@/ui/base/table-sort';
import type {FleetScope} from '@/ui/devices/fleet/fleet-scope';
import {api,downloadText,message} from '@/ui/base/api';
import {Drawer,IconBtn,Notice,Segmented,type EmptyProps} from '@/ui/kit/kit';
import {DataTable,Toolbar,pageWindow,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {AnalysisTab,FirstLoad,LoadFailed,ResetAction,ShowDevicesAction} from '@/ui/kit/analysis-tab';
import {useLocale,useT} from '@/ui/base/locale';
import {VerdictPill,VulnerabilityList,VulnerabilityStatusNotice} from '@/ui/devices/inventory/vulnerability-list';

export type SoftwareSortColumn='name'|'version'|'risk'|'publisher'|'devices';
/** The default sort: the most widespread products first. */
export const defaultSoftwareSort:TableSort<SoftwareSortColumn>={column:'devices',direction:'desc'};
type Filter='all'|'vulnerable';
/** The scope parameter of GET /api/software: all, unassigned, unassigned:<customer id> (the devices of a customer without a group), group:<id> or customer:<id>. */
export const softwareScopeParam=(scope:FleetScope)=>scope.type==='all'?scope.type:scope.type==='unassigned'?scope.customerId?`unassigned:${scope.customerId}`:scope.type:`${scope.type}:${scope.id}`;
/** The last answer of GET /api/software with the scope parameter and the key of its request. */
export type LoadedSoftware={scope:string;key:string;view:SoftwareFleetView};
/** The view the tab shows: the answer of the current key, or the stale answer of the same scope while another search or filter loads (marked aria-busy). The rows of another scope are never shown. */
export const shownSoftwareView=(loaded:LoadedSoftware|null,scope:string,key:string):SoftwareFleetView|null=>!loaded?null:loaded.key===key||loaded.scope===scope?loaded.view:null;
/** Rows per page of the tab. */
export const softwarePageSize=50;
/** The page the tab shows: the chosen page while the list key (scope, search, filter, sort) stays, else page 1; clamped into the pages of `total` rows. */
export const softwarePage=(chosen:{key:string;page:number},key:string,total:number)=>pageWindow(chosen.key===key?chosen.page:1,softwarePageSize,total).page;
/** The rows of the answer in the sort: the server order in, sortTableRows out (ties keep the server order). */
export function sortedSoftwareRows<R extends SoftwareFleetView['rows'][number]>(rows:readonly R[],sort:TableSort<SoftwareSortColumn>|null):R[]{
 return sortTableRows(rows,sort,{name:row=>row.name,version:row=>row.version,risk:row=>verdictSortValue(row.verdict),publisher:row=>row.publisher,devices:row=>row.deviceCount});
}

export default function SoftwareTab({scope,devices,demo,now:pinnedNow,onOpen,onShowDevices,owner=false,download=downloadText,initialFilter='all',initialView}:{scope:FleetScope;devices:Server[];demo:boolean;now?:number;onOpen:(id:string)=>void;
 /** Switches the view to its Devices tab (the empty state without inventory). */
 onShowDevices:()=>void;
 /** Global Owner: the off notice offers Turn on. */owner?:boolean;download?:(name:string,text:string,type:string)=>void;/** The filter shown first. */initialFilter?:Filter;
 /** An answer of GET /api/software for the first key (no search), shown until the first request ends (SSR and tests). */
 initialView?:SoftwareFleetView}){
 const now=useClockNow(pinnedNow);
 const t=useT(),[locale]=useLocale();
 const [query,setQuery]=useState(''),[debounced,setDebounced]=useState(''),[sort,setSort]=useState<TableSort<SoftwareSortColumn>>(defaultSoftwareSort),[filter,setFilter]=useState<Filter>(initialFilter);
 const [loaded,setLoaded]=useState<LoadedSoftware|null>(()=>initialView?{scope:softwareScopeParam(scope),key:`${softwareScopeParam(scope)}\u0000\u0000${initialFilter}`,view:initialView}:null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0),[openRow,setOpenRow]=useState<string|null>(null);
 const scopeParam=softwareScopeParam(scope),key=`${scopeParam}\u0000${debounced}\u0000${filter}`;
 const sequence=useRef(0);
 // A scope change is a new first load: the error and the open drawer of the old scope go.
 const [shownScope,setShownScope]=useState(scopeParam);
 if(shownScope!==scopeParam){setShownScope(scopeParam);setError('');setOpenRow(null);}
 useEffect(()=>{const timer=setTimeout(()=>setDebounced(query.trim()),300);return()=>clearTimeout(timer);},[query]);
 useEffect(()=>{
  if(demo)return;
  const current=++sequence.current;
  queueMicrotask(()=>setLoading(true));
  api<SoftwareFleetView>(`/api/software?${new URLSearchParams({scope:scopeParam,q:debounced,...(filter==='vulnerable'?{vulnerable:'1'}:{})})}`)
   .then(view=>{if(current===sequence.current){setLoaded({scope:scopeParam,key,view});setError('');}},failure=>{if(current===sequence.current)setError(message(failure,locale));})
   .finally(()=>{if(current===sequence.current)setLoading(false);});
 },[demo,scopeParam,debounced,filter,key,locale,revision]);
 const deviceIds=useMemo(()=>devices.map(device=>device.id),[devices]);
 const view=demo?demoSoftwareFleet(deviceIds,debounced,now,filter==='vulnerable'):shownSoftwareView(loaded,scopeParam,key);
 const checking=!!view?.vulnerabilities?.enabled;
 // The vulnerability check is global: while another scope loads, the filter stays without its count, so the toolbar does not jump.
 const filterShown=checking||(!view&&!!loaded?.view.vulnerabilities?.enabled);
 const names=useMemo(()=>new Map(devices.map(device=>[device.id,device.name])),[devices]);
 // The Vulnerabilities column exists only while the check is on; its sort falls back to the default.
 const activeSort=sort.column==='risk'&&!checking?defaultSoftwareSort:sort;
 const rows=useMemo(()=>sortedSoftwareRows((view?.rows??[]).map(row=>({...row,id:`${row.normalizedName}\u0000${row.normalizedVersion??''}`})),activeSort),[view,activeSort]);
 const row=rows.find(item=>item.id===openRow);
 // Paging: 50 rows per page, back to page 1 when the scope, search, filter or sort changes.
 const [chosenPage,setChosenPage]=useState({key:'',page:1}),pageKey=`${key}\u0000${activeSort.column}:${activeSort.direction}`;
 const page=softwarePage(chosenPage,pageKey,rows.length),shown=pageWindow(page,softwarePageSize,rows.length);
 const pageRows=useMemo(()=>rows.slice(shown.from,shown.to),[rows,shown.from,shown.to]);
 const exportCsv=()=>{
  if(!rows.length)return;
  try{download(softwareCsvFileName(now,locale),softwareCsv(rows.map(item=>({name:item.name,version:item.version,publisher:item.publisher,deviceCount:item.deviceCount,deviceNames:item.deviceIds.map(id=>names.get(id)).filter((name):name is string=>!!name),verdict:item.verdict})),locale,checking),'text/csv;charset=utf-8');toast.success(t('software.csv.exported',{count:rows.length}));}
  catch{toast.error(t('csv.exportFailed'));}
 };
 const devicesList=row&&<ul className="sdx-health-devices">{row.deviceIds.map(id=>{const name=names.get(id);if(!name)return null;return <li key={id}><button type="button" onClick={()=>{setOpenRow(null);onOpen(id);}} aria-label={t('osSupport.openDevice',{name})}><span><strong>{name}</strong></span><ChevronRight size={14} aria-hidden/></button></li>;})}</ul>;
 const vulnerableFilter=checking&&filter==='vulnerable';
 type Row=typeof rows[number];
 const columns:DataColumn<Row>[]=[
  {id:'name',label:t('software.col.product'),primary:true,sort:{first:'asc'},cell:item=>item.name},
  {id:'version',label:t('software.col.version'),mono:true,sort:{first:'asc'},cell:item=>item.version??EMPTY_VALUE},
  ...(checking?[{id:'risk',label:t('vulnerabilities.col'),sort:{first:'desc'},cell:(item:Row)=><VerdictPill verdict={item.verdict} name={item.name} onOpen={item.verdict?.status==='vulnerable'?()=>setOpenRow(item.id):undefined}/>} satisfies DataColumn<Row>]:[]),
  {id:'publisher',label:t('software.col.publisher'),sort:{first:'asc'},cell:item=><span className="sdx-muted-cell">{item.publisher??EMPTY_VALUE}</span>},
  {id:'devices',label:t('software.col.devices'),mono:true,align:'end',sort:{first:'desc'},cell:item=>item.deviceCount},
 ];
 const clearSearch=()=>{setQuery('');setDebounced('');};
 const empty:EmptyProps=debounced?{icon:Search,title:t('software.noMatch'),children:t('fleet.analysis.noMatchText'),action:<ResetAction label={t('fleet.analysis.clearSearch')} onReset={clearSearch}/>}
  :vulnerableFilter?{icon:ShieldCheck,title:t('vulnerabilities.fleetEmptyVulnerable'),children:t('fleet.analysis.noMatchText'),action:<ResetAction label={t('fleet.analysis.showAll')} onReset={()=>setFilter('all')}/>}
  :{icon:Package,title:t('software.fleetEmpty'),children:t('fleet.analysis.noInventoryText'),action:<ShowDevicesAction onShowDevices={onShowDevices}/>};
 const retry=()=>setRevision(value=>value+1);
 const toolbar=<Toolbar search={{value:query,onChange:setQuery,label:t('software.searchFleet'),placeholder:t('software.searchFleet')}}
  filters={filterShown&&<Segmented<Filter> label={t('vulnerabilities.filter.label')} size="sm" value={filter} onChange={setFilter} items={[{id:'all',label:t('vulnerabilities.filter.all')},{id:'vulnerable',label:t('vulnerabilities.filter.vulnerable'),icon:ShieldAlert,count:view?.vulnerabilities.vulnerableRows,tone:view?.vulnerabilities.vulnerableRows?'critical':undefined}]}/>}
  actions={<IconBtn icon={Download} label={t('csv.export')} className="sdx-icon-btn-framed" blocked={rows.length?undefined:t('csv.nothingToExport')} onClick={exportCsv}/>}/>;
 return <AnalysisTab title={t('software.title')} description={t('software.fleetMeta')}>
  {error&&<LoadFailed text={t('software.loadFailed')} loading={loading} onRetry={retry}/>}
  {view&&<VulnerabilityStatusNotice status={view.vulnerabilities} owner={owner} now={now}/>}
  {view?.truncated&&<Notice tone="info" icon={Package}>{t('software.fleetTruncated')}</Notice>}
  {!view?<>{toolbar}{!error&&<FirstLoad label={t('software.loading')} loading={loading} onRetry={retry}/>}</>
   :<DataTable label={t('software.title')} toolbar={toolbar} columns={columns} rows={pageRows} rowKey={item=>item.id} busy={loading}
     sort={activeSort} onSort={next=>setSort(next as TableSort<SoftwareSortColumn>)}
     onOpen={item=>setOpenRow(item.id)} cards entranceId="software-rows"
     empty={empty}
     foot={t('software.fleetFoot',{shown:rows.length,count:view.total})}
     pagination={{page,pageSize:softwarePageSize,total:rows.length,onPage:next=>setChosenPage({key:pageKey,page:next})}}/>}
  <Drawer open={!!row} onClose={()=>setOpenRow(null)} title={row?t(checking&&row.verdict?.status==='vulnerable'?'vulnerabilities.drawerTitle':'software.devicesDrawer',{name:row.name,version:row.version??''}):''} description={row?.publisher??undefined} wide={checking&&row?.verdict?.status==='vulnerable'}>
   {row&&(checking?<>
    <section className="sdx-vuln-drawer-section" aria-label={t('vulnerabilities.listLabel')}>
     <h3>{t('vulnerabilities.col')}</h3>
     {row.verdict?.status==='vulnerable'&&row.normalizedVersion?<VulnerabilityList target={{name:row.normalizedName,version:row.normalizedVersion,scope:scopeParam}} demo={demo?demoVulnerabilityDetail(row.normalizedName,row.normalizedVersion,row.publisher):undefined}/>:<VerdictPill verdict={row.verdict} name={row.name}/>}
    </section>
    <section className="sdx-vuln-drawer-section" aria-label={t('software.col.devices')}><h3>{t('software.col.devices')}</h3>{devicesList}</section>
   </>:devicesList)}
  </Drawer>
 </AnalysisTab>;
}
