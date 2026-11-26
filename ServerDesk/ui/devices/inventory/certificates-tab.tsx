'use client';
// The scope tab "Certificates" (docs/device-health-signals.md): every machine
// certificate of the scoped devices, soonest expiry first, from the snapshots.
// Filter by expiring (30 days), expired or all, by default only certificates
// with a private key. A row opens the device's Certificates area.
import {useMemo,useState} from 'react';
import {useClockNow} from '@/ui/base/clock-store';
import {BadgeCheck,CalendarCheck,CalendarClock,CalendarX2,Search} from 'lucide-react';
import type {Server} from '@/lib/types';
import {certificateBindingText,certificateFilterCounts,certificateRowShown,certificateStatusText,certificateStatusTone,fleetCertificateRows,type CertificateFilter,type FleetCertificateRow} from '@/ui/devices/inventory/health-signals';
import {EMPTY_VALUE,formatDate} from '@/lib/i18n/format';
import {sortTableRows} from '@/ui/base/table-sort';
import {Btn,Segmented,StatusPill,type EmptyProps} from '@/ui/kit/kit';
import {DataTable,Toolbar,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {AnalysisTab,ResetAction,ShowDevicesAction,reportEmpty,worstTone} from '@/ui/kit/analysis-tab';
import {useLocale,useT} from '@/ui/base/locale';
import {toneKind} from '@/ui/devices/inventory/os-support';

export type CertificateSortColumn='device'|'subject'|'expires'|'daysLeft';
/** The default sort: the soonest expiry first, the order of fleetCertificateRows. */
export const defaultCertificateSort:TableSort<CertificateSortColumn>={column:'expires',direction:'asc'};
/** The rows in the sort: fleetCertificateRows order in, sortTableRows out. */
export function sortedCertificateRows(rows:readonly FleetCertificateRow[],sort:TableSort<CertificateSortColumn>|null):FleetCertificateRow[]{
 return sortTableRows(rows,sort,{device:row=>row.deviceName,subject:row=>row.cert.subject,expires:row=>Date.parse(row.cert.notAfter),daysLeft:row=>row.daysLeft});
}
const certificateKey=(row:FleetCertificateRow)=>row.deviceId+row.cert.thumbprint;

export default function CertificatesTab({devices,now:pinnedNow,onOpen,onShowDevices}:{devices:Server[];now?:number;onOpen:(id:string)=>void;
 /** Switches the view to its Devices tab (the empty state without certificates). */
 onShowDevices:()=>void}){
 const now=useClockNow(pinnedNow);
 const t=useT(),[locale]=useLocale();
 const [filter,setFilter]=useState<CertificateFilter>('expiring'),[onlyWithKey,setOnlyWithKey]=useState(true),[sort,setSort]=useState<TableSort<CertificateSortColumn>>(defaultCertificateSort);
 const all=useMemo(()=>fleetCertificateRows(devices,now),[devices,now]);
 const counts=certificateFilterCounts(all,onlyWithKey);
 const rows=sortedCertificateRows(all.filter(row=>certificateRowShown(row,filter,onlyWithKey)),sort);
 const showAll=()=>{setFilter('all');setOnlyWithKey(false);};
 const columns:DataColumn<FleetCertificateRow>[]=[
  {id:'device',label:t('certificates.col.device'),primary:true,sort:{first:'asc'},cell:row=>row.deviceName},
  {id:'subject',label:t('certificates.col.subject'),wrap:true,sort:{first:'asc'},cell:row=>row.cert.subject},
  {id:'expires',label:t('certificates.col.expires'),sort:{first:'asc'},cell:row=><span className="sdx-cell-stack"><span className="sdx-nowrap">{formatDate(locale,row.cert.notAfter)}</span><StatusPill kind={toneKind[certificateStatusTone[row.status]]}>{certificateStatusText(row.cert,now,locale)}</StatusPill></span>},
  {id:'daysLeft',label:t('certificates.col.daysLeft'),mono:true,align:'end',sort:{first:'asc'},cell:row=>row.daysLeft},
  {id:'store',label:t('certificates.col.store'),cell:row=><span className="sdx-muted-cell">{row.cert.stores.join(', ')}</span>},
  {id:'boundTo',label:t('certificates.col.boundTo'),wrap:true,cell:row=>row.cert.bindings.length?row.cert.bindings.map(binding=>certificateBindingText(binding,locale)).join(', '):<span className="sdx-muted-cell">{EMPTY_VALUE}</span>},
 ];
 // No certificate at all: no filter or switch can show one, so the next step is the Devices tab. The untouched default view
 // (expiring, only with a private key) without rows is good news and widens to all certificates; a filter of the viewer
 // without a match offers the same reset.
 const empty:EmptyProps=reportEmpty({hasData:all.length>0,defaultView:filter==='expiring'&&onlyWithKey,
  noData:{icon:BadgeCheck,title:t('certificates.fleetNone'),children:t('fleet.analysis.noInventoryText'),action:<ShowDevicesAction onShowDevices={onShowDevices}/>},
  emptyDefault:{icon:CalendarCheck,title:t('certificates.defaultEmpty'),children:t('certificates.defaultEmptyText'),action:<Btn icon={BadgeCheck} onClick={showAll}>{t('certificates.showAll')}</Btn>},
  noMatch:{icon:Search,title:t('certificates.fleetEmpty'),children:t('fleet.analysis.noMatchText'),action:<ResetAction label={t('certificates.showAll')} onReset={showAll}/>}});
 const toolbar=<Toolbar filters={<>
  <Segmented<CertificateFilter> label={t('certificates.title')} size="sm" value={filter} onChange={setFilter} items={worstTone<CertificateFilter>([{id:'expiring',label:t('certificates.filter.expiring'),icon:CalendarClock,count:counts.expiring,tone:'warning'},{id:'expired',label:t('certificates.filter.expired'),icon:CalendarX2,count:counts.expired,tone:'critical'},{id:'all',label:t('certificates.filter.all'),count:counts.all}],['expired','expiring'])}/>
  <label className="sdx-switch-label"><input type="checkbox" role="switch" checked={onlyWithKey} onChange={event=>setOnlyWithKey(event.target.checked)}/>{t('certificates.onlyWithKey')}</label>
 </>}/>;
 return <AnalysisTab title={t('certificates.title')} description={t('certificates.fleetMeta')}>
  <DataTable<FleetCertificateRow> label={t('certificates.title')} toolbar={toolbar} columns={columns} rows={rows} rowKey={certificateKey}
   sort={sort} onSort={next=>setSort(next as TableSort<CertificateSortColumn>)} onOpen={row=>onOpen(row.deviceId)} openLabel={row=>t('certificates.openDevice',{name:row.deviceName})}
   empty={empty} foot={t('certificates.foot',{count:all.length,shown:rows.length})} cards entranceId="certificate-rows" className="sdx-certificate-table"/>
 </AnalysisTab>;
}
