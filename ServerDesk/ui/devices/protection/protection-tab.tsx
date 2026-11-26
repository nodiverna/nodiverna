'use client';
// The scope tab "Protection" (docs/device-health-signals.md, "Microsoft
// Defender"): the Defender state of every device in the scope. "Scan too old"
// and "Off" read the device's open issues, so they follow its effective alert
// rules; the browser applies no threshold. A row opens Management → Defender.
// With defender.control on a device in scope, rows can be selected and the
// bulk bar starts one Defender action on the eligible devices of the selection
// (POST /api/console {action:'defender-jobs'}); the server checks every device again.
import {useEffect,useMemo,useState} from 'react';
import {useClockNow} from '@/ui/base/clock-store';
import {RefreshCw,ScanLine,ScanSearch,ShieldCheck,ShieldX} from 'lucide-react';
import type {Server,Viewer} from '@/lib/types';
import {defenderJobKinds,matchesProtectionFilter,protectionCounts,protectionFilters,protectionRow,protectionStatusRank,protectionStatusKeys,protectionStatusTone,type DefenderJobKind,type DefenderTone,type ProtectionFilter,type ProtectionRow} from '@/lib/defender';
import {canControlDefender,defenderBulkPlan} from '@/ui/devices/protection/defender-model';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import type {MessageKey} from '@/lib/i18n/translate';
import {sortTableRows} from '@/ui/base/table-sort';
import type {Confirmation} from '@/ui/base/confirmation';
import {targetCustomerCount} from '@/ui/base/cross-customer';
import {defenderActionKeys,defenderBulkConfirmation,defenderBulkLock} from '@/ui/devices/protection/defender-actions';
import {Btn,Segmented,StatusPill,exactTime,relativeTime,type EmptyProps,type StatusKind} from '@/ui/kit/kit';
import {BulkBar,DataTable,Toolbar,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {AnalysisTab,ResetAction,worstTone} from '@/ui/kit/analysis-tab';
import {useLocale,useT} from '@/ui/base/locale';

const pillKind:Record<DefenderTone,StatusKind>={ok:'success',warning:'warning',critical:'critical',neutral:'neutral'};
const filterKeys:Record<ProtectionFilter,MessageKey>={all:'protection.filter.all',detections:'protection.filter.detections','scan-old':'protection.filter.scanOld',off:'protection.filter.off',passive:'protection.filter.passive','not-reported':'protection.filter.notReported'};
const filterTones:Partial<Record<ProtectionFilter,StatusKind>>={detections:'critical','scan-old':'warning',off:'critical'};
/** The filters that may carry their tone, worst first: only the first one with a count above 0 does (worstTone). */
const worstFilters:readonly ProtectionFilter[]=['detections','off','scan-old'];
const actionIcons={'defender-quick-scan':ScanSearch,'defender-full-scan':ScanLine,'defender-update-signatures':RefreshCw,'defender-clean-detections':ShieldX} satisfies Record<DefenderJobKind,unknown>;
type ProtectionSortColumn='name'|'status'|'active'|'lastScan'|'signatures';

type Props={devices:Server[];
 /** Pins the time (tests); without it the tab follows the console clock. */
 now?:number;onOpen:(id:string)=>void;
 viewer:Viewer;demo:boolean;saving:boolean;onConfirm:(confirmation:Confirmation)=>void};

/** A reported time as epoch ms; null when missing or unreadable. */
const time=(value:string|null)=>{const at=value?Date.parse(value):NaN;return Number.isFinite(at)?at:null;};
/** The rows in the sort of the table; without a sort they keep the scope order. A running scan counts as the newest scan. */
export function sortedProtectionRows(rows:readonly ProtectionRow[],sort:TableSort<ProtectionSortColumn>|null,now:number):ProtectionRow[]{
 return sortTableRows(rows,sort,{name:row=>row.name,status:row=>protectionStatusRank[row.status],active:row=>row.activeCount,lastScan:row=>row.scanRunning?now:time(row.lastScan),signatures:row=>time(row.signatureAt)});
}

export default function ProtectionTab({devices,now:pinnedNow,onOpen,viewer,demo,saving,onConfirm}:Props){
 const now=useClockNow(pinnedNow);
 const t=useT(),[locale]=useLocale();
 const [filter,setFilter]=useState<ProtectionFilter>('all'),[selection,setSelection]=useState<string[]>([]),[sort,setSort]=useState<TableSort<ProtectionSortColumn>|null>(null);
 const counts=useMemo(()=>protectionCounts(devices),[devices]);
 const rows=useMemo(()=>sortedProtectionRows(devices.filter(device=>matchesProtectionFilter(device,filter)).map(protectionRow),sort,now),[devices,filter,sort,now]);
 // The selection survives a filter change; devices that leave the scope are dropped.
 useEffect(()=>{queueMicrotask(()=>setSelection(previous=>{const valid=previous.filter(id=>devices.some(device=>device.id===id));return valid.length===previous.length?previous:valid;}));},[devices]);
 const selectable=demo||canControlDefender(devices,viewer);
 const selected=devices.filter(device=>selection.includes(device.id));
 const columns:DataColumn<ProtectionRow>[]=[
  {id:'name',label:t('protection.col.device'),primary:true,sort:{first:'asc'},cell:row=>row.name},
  {id:'status',label:t('protection.col.status'),sort:{first:'asc'},cell:row=><span className="sdx-cell-stack"><StatusPill kind={pillKind[protectionStatusTone[row.status]]}>{t(protectionStatusKeys[row.status])}</StatusPill>{row.coveredBy&&<small>{row.coveredBy}</small>}</span>},
  // A count is a mono figure; a missing one is the plain EMPTY_VALUE like in the other columns.
  {id:'active',label:t('protection.col.active'),sort:{first:'desc'},cell:row=>row.activeCount==null?EMPTY_VALUE:<span className="mono">{row.activeCount}</span>},
  {id:'newest',label:t('protection.col.newest'),className:'sdx-muted-cell',cell:row=>row.newest===undefined?EMPTY_VALUE:row.newest??t('defender.unnamedThreat')},
  {id:'lastScan',label:t('protection.col.lastScan'),sort:{first:'desc'},cell:row=>{const scan=time(row.lastScan);return <span title={scan===null?undefined:exactTime(scan,locale)}>{row.scanRunning?<span className="sdx-live"><StatusPill kind="accent">{t('protection.scan.running')}</StatusPill></span>:scan===null?(row.activeCount===null?EMPTY_VALUE:t('defender.never')):relativeTime(scan,now,locale)}</span>;}},
  {id:'signatures',label:t('protection.col.signatures'),sort:{first:'desc'},cell:row=>{const signatures=time(row.signatureAt);return <span title={signatures===null?undefined:exactTime(signatures,locale)}>{signatures===null?EMPTY_VALUE:relativeTime(signatures,now,locale)}</span>;}},
  {id:'tamper',label:t('protection.col.tamper'),cell:row=>row.tamperProtected===null?EMPTY_VALUE:t(row.tamperProtected?'defender.on':'defender.off')},
 ];
 const empty:EmptyProps=devices.length?{icon:ShieldCheck,title:t('protection.noMatch'),action:<ResetAction label={t('protection.showAll')} onReset={()=>setFilter('all')}/>}:{icon:ShieldCheck,title:t('protection.empty')};
 // The focal point: the status filter, where only the worst filter with devices carries its tone.
 const toolbar=<Toolbar filters={<Segmented<ProtectionFilter> label={t('protection.filter.label')} size="sm" value={filter} onChange={setFilter}
  items={worstTone(protectionFilters.map(id=>({id,label:t(filterKeys[id]),count:counts[id],...(filterTones[id]?{tone:filterTones[id]}:{})})),worstFilters)}/>}/>;
 return <AnalysisTab title={t('protection.title')} description={t('protection.meta')} className="sdx-protection-tab">
  <DataTable<ProtectionRow> label={t('protection.title')} toolbar={toolbar} columns={columns} rows={rows} rowKey={row=>row.id}
   sort={sort} onSort={next=>setSort(next as TableSort<ProtectionSortColumn>)}
   onOpen={row=>onOpen(row.id)} openLabel={row=>t('fleet.openDevice',{name:row.name})}
   cards entranceId="protection-rows" empty={empty} foot={t('protection.foot',{shown:rows.length,count:devices.length})}
   selection={selectable?{selected:selection,onChange:setSelection,rowLabel:row=>t('fleet.selectDevice',{name:row.name}),allLabel:t('fleet.selectAll')}:undefined}/>
  {selectable&&<DefenderBulkBar selected={selected} devices={devices} viewer={viewer} demo={demo} saving={saving} now={now} onConfirm={onConfirm} onClear={()=>setSelection([])}/>}
 </AnalysisTab>;
}

/**
 * The kit BulkBar of the selection (nothing without one): one button per Defender action, each blocked
 * when no selected device is eligible, with more than 100 selected, or by the
 * cross-customer lock over the eligible devices (defenderBulkLock). The
 * confirmation names only the eligible devices; the selection clears after success.
 */
export function DefenderBulkBar({selected,devices,viewer,demo,saving,now,onConfirm,onClear}:{selected:Server[];devices:Server[];viewer:Viewer;demo:boolean;saving:boolean;now:number;onConfirm:(confirmation:Confirmation)=>void;onClear:()=>void}){
 const t=useT(),[locale]=useLocale();
 if(!selected.length)return null;
 return <BulkBar count={selected.length} onClear={onClear}>
  {defenderJobKinds.map(kind=>{
   const plan=defenderBulkPlan(selected,viewer,kind,now),customers=targetCustomerCount(devices,plan.eligible.map(device=>device.id));
   const blocked=defenderBulkLock({plan,selected:selected.length,customers,viewer,demo,saving},locale);
   return <Btn key={kind} size="sm" icon={actionIcons[kind]} variant={kind==='defender-clean-detections'?'danger':'secondary'} blocked={blocked}
    onClick={()=>{if(!blocked)onConfirm({...defenderBulkConfirmation(plan,kind,customers,locale),onSettled:outcome=>{if(outcome.ok)onClear();}});}}>{t(defenderActionKeys[kind])}</Btn>;
  })}
 </BulkBar>;
}
