'use client';
// The scope tab "Drivers" (docs/device-health-signals.md): the drivers of the
// visible devices in the scope, grouped by driver, version and provider on the
// server (GET /api/drivers), with a debounced search and the devices of a row in
// a drawer. A device opens its Drivers area.
import {useEffect,useMemo,useRef,useState} from 'react';
import {ChevronRight,CircuitBoard,Search} from 'lucide-react';
import type {Server} from '@/lib/types';
import type {DriverFleetView} from '@/lib/server/devices/drivers';
import {demoDriverFleet} from '@/ui/shell/demo';
import {formatSupportDate} from '@/ui/base/ui-device';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import {sortTableRows} from '@/ui/base/table-sort';
import type {FleetScope} from '@/ui/devices/fleet/fleet-scope';
import {api,message} from '@/ui/base/api';
import {Drawer,Notice,type EmptyProps} from '@/ui/kit/kit';
import {useLocale,useT} from '@/ui/base/locale';
import {SignedCell} from '@/ui/devices/inventory/health-table';
import {DataTable,Toolbar,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {AnalysisTab,FirstLoad,LoadFailed,ResetAction,ShowDevicesAction} from '@/ui/kit/analysis-tab';
import {softwareScopeParam} from '@/ui/devices/inventory/software-tab';

export type DriverSortColumn='name'|'version'|'provider'|'date'|'devices';
/** The default sort: the drivers on the most devices first. */
export const defaultDriverSort:TableSort<DriverSortColumn>={column:'devices',direction:'desc'};
/** The rows of the answer in the sort: the server order in, sortTableRows out. */
export function sortedDriverRows<R extends DriverFleetView['rows'][number]>(rows:readonly R[],sort:TableSort<DriverSortColumn>|null):R[]{
 return sortTableRows(rows,sort,{name:row=>row.driver,version:row=>row.version,provider:row=>row.provider,date:row=>row.date,devices:row=>row.deviceCount});
}

export default function DriversTab({scope,devices,demo,onOpen,onShowDevices}:{scope:FleetScope;devices:Server[];demo:boolean;onOpen:(id:string)=>void;
 /** Switches the view to its Devices tab (the empty state without inventory). */
 onShowDevices:()=>void}){
 const t=useT(),[locale]=useLocale();
 const [query,setQuery]=useState(''),[debounced,setDebounced]=useState(''),[sort,setSort]=useState<TableSort<DriverSortColumn>>(defaultDriverSort);
 const [loaded,setLoaded]=useState<{key:string;view:DriverFleetView}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0),[openRow,setOpenRow]=useState<string|null>(null);
 const scopeParam=softwareScopeParam(scope),key=`${scopeParam}\u0000${debounced}`;
 const sequence=useRef(0);
 useEffect(()=>{const timer=setTimeout(()=>setDebounced(query.trim()),300);return()=>clearTimeout(timer);},[query]);
 useEffect(()=>{
  if(demo)return;
  const current=++sequence.current;
  queueMicrotask(()=>setLoading(true));
  api<DriverFleetView>(`/api/drivers?${new URLSearchParams({scope:scopeParam,q:debounced})}`)
   .then(view=>{if(current===sequence.current){setLoaded({key,view});setError('');}},failure=>{if(current===sequence.current)setError(message(failure,locale));})
   .finally(()=>{if(current===sequence.current)setLoading(false);});
 },[demo,scopeParam,debounced,key,locale,revision]);
 const deviceIds=useMemo(()=>devices.map(device=>device.id),[devices]);
 const view=demo?demoDriverFleet(deviceIds,debounced):loaded?.key===key?loaded.view:loaded?.view??null;
 const names=useMemo(()=>new Map(devices.map(device=>[device.id,device.name])),[devices]);
 const rows=useMemo(()=>sortedDriverRows((view?.rows??[]).map(row=>({...row,id:JSON.stringify([row.driver,row.version,row.provider])})),sort),[view,sort]);
 const row=rows.find(item=>item.id===openRow);
 type Row=typeof rows[number];
 const columns:DataColumn<Row>[]=[
  {id:'name',label:t('drivers.col.driver'),primary:true,sort:{first:'asc'},cell:item=><span className="sdx-cell-stack"><span>{item.driver}</span>{item.deviceClass&&<small>{item.deviceClass}</small>}</span>},
  {id:'version',label:t('drivers.col.version'),mono:true,sort:{first:'asc'},cell:item=>item.version??EMPTY_VALUE},
  {id:'provider',label:t('drivers.col.provider'),sort:{first:'asc'},cell:item=><span className="sdx-muted-cell">{item.provider??EMPTY_VALUE}</span>},
  {id:'date',label:t('drivers.col.date'),mono:true,sort:{first:'desc'},cell:item=>item.date?formatSupportDate(locale,item.date):EMPTY_VALUE},
  {id:'signed',label:t('drivers.col.signed'),cell:item=><SignedCell signed={item.signed}/>},
  {id:'devices',label:t('drivers.col.devices'),mono:true,align:'end',sort:{first:'desc'},cell:item=>item.deviceCount},
 ];
 const clearSearch=()=>{setQuery('');setDebounced('');};
 const empty:EmptyProps=debounced
  ?{icon:Search,title:t('drivers.noMatch'),children:t('fleet.analysis.noMatchText'),action:<ResetAction label={t('fleet.analysis.clearSearch')} onReset={clearSearch}/>}
  :{icon:CircuitBoard,title:t('drivers.fleetEmpty'),children:t('fleet.analysis.noInventoryText'),action:<ShowDevicesAction onShowDevices={onShowDevices}/>};
 const retry=()=>setRevision(value=>value+1);
 const toolbar=<Toolbar search={{value:query,onChange:setQuery,label:t('drivers.search'),placeholder:t('drivers.search')}}/>;
 return <AnalysisTab title={t('drivers.title')} description={t('drivers.fleetMeta')}>
  {error&&<LoadFailed text={t('drivers.loadFailed')} loading={loading} onRetry={retry}/>}
  {view?.truncated&&<Notice tone="info" icon={CircuitBoard}>{t('drivers.fleetTruncated')}</Notice>}
  {!view?<>{toolbar}{!error&&<FirstLoad label={t('drivers.loading')} loading={loading} onRetry={retry}/>}</>
   :<DataTable<Row> label={t('drivers.title')} toolbar={toolbar} columns={columns} rows={rows} rowKey={item=>item.id} busy={loading}
     sort={sort} onSort={next=>setSort(next as TableSort<DriverSortColumn>)} onOpen={item=>setOpenRow(item.id)}
     empty={empty} foot={t('drivers.fleetFoot',{shown:rows.length,count:view.total})} cards entranceId="driver-rows"/>}
  <Drawer open={!!row} onClose={()=>setOpenRow(null)} title={row?t('drivers.devicesDrawer',{driver:row.driver,version:row.version??''}):''} description={row?.provider??undefined}>
   {row&&<ul className="sdx-health-devices">{row.deviceIds.map(id=>{const name=names.get(id);if(!name)return null;return <li key={id}><button type="button" onClick={()=>{setOpenRow(null);onOpen(id);}} aria-label={t('osSupport.openDevice',{name})}><span><strong>{name}</strong></span><ChevronRight size={14} aria-hidden/></button></li>;})}</ul>}
  </Drawer>
 </AnalysisTab>;
}
