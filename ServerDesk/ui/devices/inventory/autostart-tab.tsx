'use client';
// The scope tab "Autostart" (docs/device-health-signals.md): the autostart
// entries of the visible devices in the scope, grouped on the server
// (GET /api/autostart) with rare entries first, because they are the most
// unusual. Search, a filter for new and suspicious entries, and the devices of
// a row in a drawer; a device opens its Autostart area.
import {useEffect,useMemo,useRef,useState} from 'react';
import {useClockNow} from '@/ui/base/clock-store';
import {ChevronRight,Rocket,Search,ShieldAlert,Sparkles} from 'lucide-react';
import type {Server} from '@/lib/types';
import type {AutostartFleetView} from '@/lib/server/devices/autostart';
import {demoAutostartFleet} from '@/ui/shell/demo';
import {autostartSuspicious} from '@/lib/autostart-inventory';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import {sortTableRows} from '@/ui/base/table-sort';
import type {FleetScope} from '@/ui/devices/fleet/fleet-scope';
import {api,message} from '@/ui/base/api';
import {Drawer,Notice,Segmented,type EmptyProps} from '@/ui/kit/kit';
import {useLocale,useT,type Translate} from '@/ui/base/locale';
import {SignatureCell} from '@/ui/devices/inventory/health-table';
import {DataTable,Toolbar,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {AnalysisTab,FirstLoad,LoadFailed,ResetAction,ShowDevicesAction} from '@/ui/kit/analysis-tab';
import {softwareScopeParam} from '@/ui/devices/inventory/software-tab';
import {autostartCategoryKey} from '@/ui/devices/inventory/device-autostart';

type Filter='all'|'new'|'suspicious';
export type AutostartSortColumn='entry'|'type'|'devices'|'new';
/** The default sort: rare entries first, the server order. */
export const defaultAutostartSort:TableSort<AutostartSortColumn>={column:'devices',direction:'asc'};
/** The rows of the answer in the sort: the server order in, sortTableRows out (ties keep the server order). */
export function sortedAutostartRows<R extends AutostartFleetView['rows'][number]>(rows:readonly R[],sort:TableSort<AutostartSortColumn>|null,t:Translate):R[]{
 return sortTableRows(rows,sort,{entry:row=>row.name,type:row=>t(autostartCategoryKey(row.category)),devices:row=>row.deviceCount,new:row=>row.newCount});
}

export default function AutostartTab({scope,devices,demo,now:pinnedNow,onOpen,onShowDevices}:{scope:FleetScope;devices:Server[];demo:boolean;now?:number;onOpen:(id:string)=>void;
 /** Switches the view to its Devices tab (the empty state without inventory). */
 onShowDevices:()=>void}){
 const now=useClockNow(pinnedNow);
 const t=useT(),[locale]=useLocale();
 const [query,setQuery]=useState(''),[debounced,setDebounced]=useState(''),[filter,setFilter]=useState<Filter>('all'),[sort,setSort]=useState<TableSort<AutostartSortColumn>>(defaultAutostartSort);
 const [loaded,setLoaded]=useState<{key:string;view:AutostartFleetView}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0),[openRow,setOpenRow]=useState<string|null>(null);
 const scopeParam=softwareScopeParam(scope),key=`${scopeParam}\u0000${debounced}`;
 const sequence=useRef(0);
 useEffect(()=>{const timer=setTimeout(()=>setDebounced(query.trim()),300);return()=>clearTimeout(timer);},[query]);
 useEffect(()=>{
  if(demo)return;
  const current=++sequence.current;
  queueMicrotask(()=>setLoading(true));
  api<AutostartFleetView>(`/api/autostart?${new URLSearchParams({scope:scopeParam,q:debounced})}`)
   .then(view=>{if(current===sequence.current){setLoaded({key,view});setError('');}},failure=>{if(current===sequence.current)setError(message(failure,locale));})
   .finally(()=>{if(current===sequence.current)setLoading(false);});
 },[demo,scopeParam,debounced,key,locale,revision]);
 const deviceIds=useMemo(()=>devices.map(device=>device.id),[devices]);
 const view=demo?demoAutostartFleet(deviceIds,debounced,now):loaded?.key===key?loaded.view:loaded?.view??null;
 const names=useMemo(()=>new Map(devices.map(device=>[device.id,device.name])),[devices]);
 const all=useMemo(()=>(view?.rows??[]).map(row=>({...row,id:JSON.stringify([row.category,row.name.toLowerCase(),(row.target??'').toLowerCase()]),suspicious:autostartSuspicious(row)})),[view]);
 const counts={all:all.length,new:all.filter(row=>row.newCount>0).length,suspicious:all.filter(row=>row.suspicious).length};
 const rows=sortedAutostartRows(all.filter(row=>filter==='all'||filter==='new'&&row.newCount>0||filter==='suspicious'&&row.suspicious),sort,t);
 const row=rows.find(item=>item.id===openRow);
 type Row=typeof rows[number];
 const columns:DataColumn<Row>[]=[
  {id:'entry',label:t('autostart.col.entry'),primary:true,sort:{first:'asc'},cell:item=>item.name},
  {id:'type',label:t('autostart.col.type'),sort:{first:'asc'},cell:item=>t(autostartCategoryKey(item.category))},
  {id:'target',label:t('autostart.col.target'),mono:true,wrap:true,className:'sdx-wrap-cell',cell:item=>item.target??EMPTY_VALUE},
  {id:'signature',label:t('autostart.col.signature'),cell:item=><SignatureCell signature={item.signature} signer={item.signer} publisher={item.publisher}/>},
  {id:'devices',label:t('autostart.col.devices'),mono:true,align:'end',sort:{first:'asc'},cell:item=>item.deviceCount},
  {id:'new',label:t('autostart.col.new'),mono:true,align:'end',sort:{first:'desc'},cell:item=>item.newCount||<span className="sdx-muted-cell">0</span>},
 ];
 const reset=()=>{setQuery('');setDebounced('');setFilter('all');};
 const empty:EmptyProps=debounced||filter!=='all'
  ?{icon:Search,title:t('autostart.noMatch'),children:t('fleet.analysis.noMatchText'),action:<ResetAction label={t('fleet.empty.resetFilter')} onReset={reset}/>}
  :{icon:Rocket,title:t('autostart.fleetEmpty'),children:t('fleet.analysis.noInventoryText'),action:<ShowDevicesAction onShowDevices={onShowDevices}/>};
 const retry=()=>setRevision(value=>value+1);
 const toolbar=<Toolbar search={{value:query,onChange:setQuery,label:t('autostart.search'),placeholder:t('autostart.search')}}
  filters={<Segmented<Filter> label={t('autostart.title')} size="sm" value={filter} onChange={setFilter} items={[{id:'all',label:t('autostart.filter.all'),count:counts.all},{id:'new',label:t('autostart.filter.new'),icon:Sparkles,count:counts.new},{id:'suspicious',label:t('autostart.filter.suspicious'),icon:ShieldAlert,count:counts.suspicious,tone:counts.suspicious?'warning':undefined}]}/>}/>;
 return <AnalysisTab title={t('autostart.title')} description={`${t('autostart.fleetMeta')} ${t('autostart.rareFirst')}`}>
  {error&&<LoadFailed text={t('autostart.loadFailed')} loading={loading} onRetry={retry}/>}
  {view?.truncated&&<Notice tone="info" icon={Rocket}>{t('autostart.fleetTruncated')}</Notice>}
  {!view?<>{toolbar}{!error&&<FirstLoad label={t('autostart.loading')} loading={loading} onRetry={retry}/>}</>
   :<DataTable<Row> label={t('autostart.title')} toolbar={toolbar} columns={columns} rows={rows} rowKey={item=>item.id} busy={loading}
     sort={sort} onSort={next=>setSort(next as TableSort<AutostartSortColumn>)} onOpen={item=>setOpenRow(item.id)}
     empty={empty} foot={t('autostart.fleetFoot',{shown:rows.length,count:view.total})} cards entranceId="autostart-rows" className="sdx-autostart-table"/>}
  <Drawer open={!!row} onClose={()=>setOpenRow(null)} title={row?t('autostart.devicesDrawer',{name:row.name}):''} description={row?.target??undefined}>
   {row&&<ul className="sdx-health-devices">{row.deviceIds.map(id=>{const name=names.get(id);if(!name)return null;const fresh=row.newDeviceIds.includes(id);return <li key={id}><button type="button" onClick={()=>{setOpenRow(null);onOpen(id);}} aria-label={t('osSupport.openDevice',{name})}><span><strong>{name}</strong><small>{t(fresh?'autostart.status.deviceNew':'autostart.status.deviceKnown')}</small></span><ChevronRight size={14} aria-hidden/></button></li>;})}</ul>}
  </Drawer>
 </AnalysisTab>;
}
