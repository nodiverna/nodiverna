'use client';
// The scope tab "Encryption" (docs/device-health-signals.md): the BitLocker
// state of every device in the scope, filtered by the status of its system
// drive. A row opens the device's storage area.
import {useMemo,useState} from 'react';
import {Lock,Search} from 'lucide-react';
import type {Server} from '@/lib/types';
import {bitlockerStatusKey,encryptionStatusRank,bitlockerStatusTone,encryptionCounts,encryptionRow,type BitLockerStatus,type EncryptionRow} from '@/ui/devices/inventory/health-signals';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import type {MessageKey} from '@/lib/i18n/translate';
import {sortTableRows} from '@/ui/base/table-sort';
import {Segmented,StatusPill,type EmptyProps} from '@/ui/kit/kit';
import {DataTable,Toolbar,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {AnalysisTab,ResetAction,ShowDevicesAction,worstTone} from '@/ui/kit/analysis-tab';
import {toneKind} from '@/ui/devices/inventory/os-support';
import {useLocale,useT} from '@/ui/base/locale';

type Filter=BitLockerStatus|'all';
export type EncryptionSortColumn='device'|'systemDrive';
const protectionKeys:Record<'on'|'off'|'suspended',MessageKey>={on:'bitlocker.protectionState.on',off:'bitlocker.protectionState.off',suspended:'bitlocker.protectionState.suspended'};
const statuses:BitLockerStatus[]=['encrypted','encrypting','not-encrypted','suspended','not-available','not-reported'];
/** The rows in the sort: the device order of the scope in, sortTableRows out; no sort keeps it. */
export function sortedEncryptionRows(rows:readonly EncryptionRow[],sort:TableSort<EncryptionSortColumn>|null):EncryptionRow[]{
 return sortTableRows(rows,sort,{device:row=>row.name,systemDrive:row=>encryptionStatusRank[row.status]});
}

export default function EncryptionTab({devices,onOpen,onShowDevices}:{devices:Server[];onOpen:(id:string)=>void;
 /** Switches the view to its Devices tab (the empty state without devices). */
 onShowDevices:()=>void}){
 const t=useT(),[locale]=useLocale();
 // Without a chosen sort the rows keep the device order of the scope.
 const [filter,setFilter]=useState<Filter>('all'),[sort,setSort]=useState<TableSort<EncryptionSortColumn>|null>(null);
 const counts=useMemo(()=>encryptionCounts(devices),[devices]);
 const all=useMemo(()=>devices.map(device=>encryptionRow(device,locale)),[devices,locale]);
 const rows=sortedEncryptionRows(all.filter(row=>filter==='all'||row.status===filter),sort);
 const columns:DataColumn<EncryptionRow>[]=[
  {id:'device',label:t('bitlocker.col.device'),primary:true,sort:{first:'asc'},cell:row=>row.name},
  {id:'systemDrive',label:t('bitlocker.col.systemDrive'),sort:{first:'asc'},cell:row=><StatusPill kind={toneKind[bitlockerStatusTone[row.status]]}>{t(bitlockerStatusKey(row.status))}</StatusPill>},
  {id:'protection',label:t('bitlocker.col.protection'),cell:row=><span className="sdx-muted-cell">{row.protection&&row.protection!=='unknown'?t(protectionKeys[row.protection]):EMPTY_VALUE}</span>},
  {id:'method',label:t('bitlocker.col.method'),mono:true,cell:row=>row.method},
  {id:'protectors',label:t('bitlocker.col.protectors'),cell:row=><span className="sdx-muted-cell">{row.protectors.length?row.protectors.join(', '):EMPTY_VALUE}</span>},
  {id:'recoveryPassword',label:t('bitlocker.col.recoveryPassword'),cell:row=>row.recoveryPassword===null?EMPTY_VALUE:t(row.recoveryPassword?'common.yes':'common.no')},
  {id:'volumes',label:t('bitlocker.col.volumes'),cell:row=><span className="sdx-muted-cell">{row.volumes?t('bitlocker.volumes',{encrypted:row.encrypted,count:row.volumes}):EMPTY_VALUE}</span>},
 ];
 const empty:EmptyProps=!devices.length
  ?{icon:Lock,title:t('encryption.empty'),children:t('fleet.analysis.noDevicesText'),action:<ShowDevicesAction onShowDevices={onShowDevices}/>}
  :{icon:Search,title:t('encryption.noMatch'),children:t('fleet.analysis.noMatchText'),action:<ResetAction label={t('fleet.analysis.showAll')} onReset={()=>setFilter('all')}/>};
 const toolbar=<Toolbar filters={<Segmented<Filter> label={t('bitlocker.col.systemDrive')} size="sm" value={filter} onChange={setFilter}
  items={worstTone<Filter>([{id:'all',label:t('bitlocker.status.all'),count:counts.all},...statuses.map(status=>({id:status,label:t(bitlockerStatusKey(status)),count:counts[status],tone:toneKind[bitlockerStatusTone[status]]}))],['not-encrypted','suspended','encrypting','not-reported','not-available','encrypted'])}/>}/>;
 return <AnalysisTab title={t('encryption.title')} description={t('encryption.meta')}>
  <DataTable<EncryptionRow> label={t('encryption.title')} toolbar={toolbar} columns={columns} rows={rows} rowKey={row=>row.id}
   sort={sort} onSort={next=>setSort(next as TableSort<EncryptionSortColumn>)} onOpen={row=>onOpen(row.id)}
   empty={empty} foot={t('encryption.foot',{count:devices.length,shown:rows.length})} cards entranceId="encryption-rows"/>
 </AnalysisTab>;
}
