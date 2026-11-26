'use client';
// The scope tab "Reliability" (docs/device-health-signals.md): the programs that
// crashed or stopped responding on the scoped devices in the last 30 days, from
// the snapshots (fleetReliability in lib/reliability.ts), with the number of
// devices with a low or no stability index. A device opens its Events area.
import {useMemo,useState} from 'react';
import {useClockNow} from '@/ui/base/clock-store';
import {Activity,ChevronRight} from 'lucide-react';
import type {Server} from '@/lib/types';
import {fleetReliability,type FleetReliability} from '@/lib/reliability';
import {sortTableRows} from '@/ui/base/table-sort';
import {Drawer,StatusPill,exactTime} from '@/ui/kit/kit';
import {useLocale,useT} from '@/ui/base/locale';
import {DataTable,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {AnalysisTab,ShowDevicesAction} from '@/ui/kit/analysis-tab';

type ReliabilityRow=FleetReliability['rows'][number];
export type ReliabilitySortColumn='program'|'crashes'|'hangs'|'devices'|'last';
/** The default sort: the most crashes first, the order of fleetReliability. */
export const defaultReliabilitySort:TableSort<ReliabilitySortColumn>={column:'crashes',direction:'desc'};
/** The rows in the sort: fleetReliability order in, sortTableRows out. */
export function sortedReliabilityRows(rows:readonly ReliabilityRow[],sort:TableSort<ReliabilitySortColumn>|null):ReliabilityRow[]{
 return sortTableRows(rows,sort,{program:row=>row.program,crashes:row=>row.crashes,hangs:row=>row.hangs,devices:row=>row.devices,last:row=>Date.parse(row.last)});
}

export default function ReliabilityTab({devices,now:pinnedNow,onOpen,onShowDevices}:{devices:Server[];now?:number;onOpen:(id:string)=>void;
 /** Switches the view to its Devices tab (the empty state without crashes). */
 onShowDevices:()=>void}){
 const now=useClockNow(pinnedNow);
 const t=useT(),[locale]=useLocale();
 const [sort,setSort]=useState<TableSort<ReliabilitySortColumn>>(defaultReliabilitySort),[openRow,setOpenRow]=useState<string|null>(null);
 const fleet=useMemo(()=>fleetReliability(devices,now),[devices,now]);
 const rows=useMemo(()=>sortedReliabilityRows(fleet.rows,sort),[fleet,sort]);
 const names=useMemo(()=>new Map(devices.map(device=>[device.id,device.name])),[devices]);
 const row=rows.find(item=>item.key===openRow);
 const columns:DataColumn<ReliabilityRow>[]=[
  {id:'program',label:t('reliability.col.program'),primary:true,mono:true,sort:{first:'asc'},cell:item=>item.program},
  {id:'crashes',label:t('reliability.col.crashes'),mono:true,align:'end',sort:{first:'desc'},cell:item=>item.crashes},
  {id:'hangs',label:t('reliability.col.hangs'),mono:true,align:'end',sort:{first:'desc'},cell:item=>item.hangs},
  {id:'devices',label:t('reliability.col.devices'),mono:true,align:'end',sort:{first:'desc'},cell:item=>item.devices},
  {id:'last',label:t('reliability.col.last'),sort:{first:'desc'},cell:item=><span className="sdx-nowrap">{exactTime(item.last,locale)}</span>},
 ];
 const stability=<span className="sdx-health-counts"><StatusPill kind={fleet.lowStability?'warning':'neutral'}>{t('reliability.lowStability',{count:fleet.lowStability})}</StatusPill><StatusPill kind="neutral">{t('reliability.noStability',{count:fleet.noStability})}</StatusPill></span>;
 return <AnalysisTab title={t('reliability.title')} description={t('reliability.fleetMeta')} meta={stability}>
  <DataTable<ReliabilityRow> label={t('reliability.title')} columns={columns} rows={rows} rowKey={item=>item.key}
   sort={sort} onSort={next=>setSort(next as TableSort<ReliabilitySortColumn>)} onOpen={item=>setOpenRow(item.key)}
   empty={{icon:Activity,title:t('reliability.fleetEmpty'),children:t('reliability.fleetEmptyText'),action:<ShowDevicesAction onShowDevices={onShowDevices}/>}}
   foot={t('reliability.foot',{count:fleet.rows.length,shown:rows.length})} cards entranceId="reliability-rows"/>
  <Drawer open={!!row} onClose={()=>setOpenRow(null)} title={row?t('reliability.devicesDrawer',{program:row.program}):''}>
   {row&&<ul className="sdx-health-devices">{row.perDevice.map(device=>{const name=names.get(device.id);if(!name)return null;return <li key={device.id}><button type="button" onClick={()=>{setOpenRow(null);onOpen(device.id);}} aria-label={t('osSupport.openDevice',{name})}><span><strong>{name}</strong><small>{t('reliability.crashes',{count:device.crashes})}{device.hangs>0&&<> · {t('reliability.hangs',{count:device.hangs})}</>}</small></span><ChevronRight size={14} aria-hidden/></button></li>;})}</ul>}
  </Drawer>
 </AnalysisTab>;
}
