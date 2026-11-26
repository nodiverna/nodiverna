'use client';
// Disk and battery health of agent 4.11.0 (docs/device-health-signals.md): the
// card "Disk health" of the Storage area (shown whenever the device reports
// it, also without the storage-inspect capability), the "Disk health" cell of
// the reported drives and the battery on Hardware → Components.
// A value the disk does not report shows "—" (EMPTY_VALUE) in muted text, never a warning tone, and
// one foot line explains the dash.
import {BatteryMedium,BatteryWarning,HardDrive} from 'lucide-react';
import type {CSSProperties} from 'react';
import type {BatteryState,DiskMediaType,PhysicalDiskHealth,Server} from '@/lib/types';
import {diskHealthStatus,diskHealthStatusKey,diskHealthTone,diskOfDrive,formatWh} from '@/ui/devices/inventory/health-signals';
import {EMPTY_VALUE,formatNumber,formatPercent} from '@/lib/i18n/format';
import type {MessageKey} from '@/lib/i18n/translate';
import {Card,Empty,Meter,StatusPill,cx} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {ComponentCard} from '@/ui/devices/hardware/component-card';
import {useLocale,useT} from '@/ui/base/locale';
import {toneKind} from '@/ui/devices/inventory/os-support';

const mediaKeys:Record<DiskMediaType,MessageKey>={ssd:'diskHealth.media.ssd',hdd:'diskHealth.media.hdd',scm:'diskHealth.media.scm',unspecified:'diskHealth.media.unspecified'};
/** A value the disk does not report. */
const NotReported=()=><span className="sdx-muted-cell">{EMPTY_VALUE}</span>;
const errorsOf=(disk:PhysicalDiskHealth,counts:Record<string,number>)=>disk.number!==null?counts[String(disk.number)]??0:null;
/** Whether the row shows at least one not-reported value. */
const missesValues=(disk:PhysicalDiskHealth,counts:Record<string,number>)=>diskHealthStatus(disk)==='not-available'||disk.wearPercent===null||disk.temperatureC===null||errorsOf(disk,counts)===null||disk.powerOnHours===null;

export function DiskHealthCard({server}:{server:Pick<Server,'snapshot'>}){
 const t=useT(),[locale]=useLocale(),health=server.snapshot?.diskHealth;
 if(!health)return <Card title={t('diskHealth.title')} icon={HardDrive} iconTone="neutral" className="sdx-disk-health" flush><Empty icon={HardDrive} title={t('diskHealth.title')}>{t('diskHealth.notReported')}</Empty></Card>;
 const counts=health.events.counts;
 const columns:DataColumn<PhysicalDiskHealth>[]=[
  {id:'disk',label:t('diskHealth.col.disk'),primary:true,cell:disk=><span className="sdx-cell-stack"><span>{disk.model||t('diskHealth.diskNumber',{number:disk.number??disk.id})}</span>{disk.number!==null&&<small>{t('diskHealth.diskNumber',{number:disk.number})} · {disk.busType}</small>}</span>},
  {id:'drives',label:t('diskHealth.col.drives'),mono:true,cell:disk=>disk.driveLetters.length?disk.driveLetters.join(', '):EMPTY_VALUE},
  {id:'media',label:t('diskHealth.col.media'),cell:disk=>t(mediaKeys[disk.mediaType])},
  {id:'health',label:t('diskHealth.col.health'),cell:disk=>{const status=diskHealthStatus(disk);return status==='not-available'?<NotReported/>:<StatusPill kind={toneKind[diskHealthTone[status]]}>{t(diskHealthStatusKey(status))}</StatusPill>;}},
  {id:'wear',label:t('diskHealth.col.wear'),mono:true,align:'end',cell:disk=>disk.wearPercent===null?<NotReported/>:formatPercent(locale,disk.wearPercent)},
  {id:'temperature',label:t('diskHealth.col.temperature'),mono:true,align:'end',cell:disk=>disk.temperatureC===null?<NotReported/>:disk.temperatureMaxC===null?t('diskHealth.temperatureCurrent',{current:formatNumber(locale,disk.temperatureC)}):t('diskHealth.temperature',{current:formatNumber(locale,disk.temperatureC),max:formatNumber(locale,disk.temperatureMaxC)})},
  // An error count above 0 carries the warning tone (with the number); 0 stays plain text.
  {id:'errors',label:t('diskHealth.col.errors'),mono:true,align:'end',cell:disk=>{const errors=errorsOf(disk,counts);return errors===null?<NotReported/>:errors>0?<StatusPill kind="warning" size="sm">{formatNumber(locale,errors)}</StatusPill>:formatNumber(locale,errors);}},
  {id:'hours',label:t('diskHealth.col.hours'),mono:true,align:'end',cell:disk=>disk.powerOnHours===null?<NotReported/>:formatNumber(locale,disk.powerOnHours)},
 ];
 const notes=[
  ...(health.disks.some(disk=>missesValues(disk,counts))?[t('diskHealth.notReportedFoot')]:[]),
  ...((counts.unknown??0)>0?[t('diskHealth.unknownErrors',{count:counts.unknown})]:[]),
  ...(health.events.truncated?[t('diskHealth.eventsTruncated')]:[]),
 ];
 return <Card title={t('diskHealth.title')} icon={HardDrive} iconTone="accent" meta={t('diskHealth.meta')} className="sdx-disk-health" flush>
  <DataTable variant="flush" cards label={t('diskHealth.title')} columns={columns} rows={health.disks} rowKey={disk=>disk.id} empty={{icon:HardDrive,title:t('diskHealth.empty')}}
   foot={notes.length?notes.map(note=><span key={note} className="sdx-disk-health-note">{note}</span>):undefined}/>
 </Card>;
}

/** The "Disk health" cell of a reported drive, matched by drive letter. */
export function DriveDiskHealth({server,drive}:{server:Pick<Server,'snapshot'>;drive:string}){
 const t=useT(),disk=diskOfDrive(server.snapshot?.diskHealth,drive);
 if(!disk)return <NotReported/>;
 const status=diskHealthStatus(disk);
 return status==='not-available'?<NotReported/>:<StatusPill kind={toneKind[diskHealthTone[status]]}>{t(diskHealthStatusKey(status))}</StatusPill>;
}

export type BatteryView='data'|'none'|'unavailable'|'unreported';
/**
 * What Hardware → Components shows for the battery: data (the Battery card), none (the device
 * reports no battery), unavailable (Windows returned no data, or a present battery without a list)
 * or unreported (no battery block in the snapshot, agent before 4.11.0).
 */
export function batteryView(battery:BatteryState|null|undefined):BatteryView{
 if(!battery)return 'unreported';
 const unavailable=battery.reason==='not-supported'||battery.reason==='access-denied'||battery.reason==='error';
 if(!battery.present&&!unavailable)return 'none';
 return unavailable||!battery.batteries.length?'unavailable':'data';
}
const batteryStates:Record<Exclude<BatteryView,'data'>,{value:MessageKey;detail:MessageKey}>={
 none:{value:'battery.none',detail:'battery.noneDetail'},
 unavailable:{value:'battery.notAvailable',detail:'battery.notAvailableDetail'},
 unreported:{value:'hardware.notReported',detail:'battery.notReported'},
};

/**
 * The battery on Hardware → Components, always exactly one element: with data the card "Battery"
 * (health per battery, capacities and cycles), otherwise a static component card with the state.
 */
export function BatteryBlock({server,className,style}:{server:Pick<Server,'snapshot'>;className?:string;style?:CSSProperties}){
 const t=useT(),[locale]=useLocale(),battery=server.snapshot?.battery,view=batteryView(battery);
 if(view!=='data'||!battery){const state=batteryStates[view==='data'?'unreported':view];return <ComponentCard icon={BatteryMedium} kind={t('battery.title')} value={t(state.value)} detail={t(state.detail)} className={className} style={style}/>;}
 return <Card title={t('battery.title')} icon={BatteryMedium} iconTone="accent" className={cx('sdx-battery',className)} style={style}>
  <ul className="sdx-battery-list">{battery.batteries.map(item=>{
   const name=item.name??t('battery.unnamed',{number:item.id+1}),low=item.healthPercent!==null&&item.healthPercent<60;
   return <li key={item.id}>
    <strong>{low?<BatteryWarning size={15} aria-hidden/>:<BatteryMedium size={15} aria-hidden/>}{name}</strong>
    {item.healthPercent===null?<span className="sdx-muted-cell">{t('battery.notAvailable')}</span>:<>
     {/* A health below 60 % shows the warning tone (warning threshold 60, never critical). */}
     <Meter value={Math.min(100,item.healthPercent)} label={t('battery.meterLabel',{name})} warning={low?0:101} critical={101}/>
     <span>{t('battery.health',{percent:formatPercent(locale,item.healthPercent)})}</span></>}
    {item.designCapacityMWh!==null&&item.fullChargeCapacityMWh!==null&&<small>{t('battery.capacity',{full:formatWh(locale,item.fullChargeCapacityMWh),design:formatWh(locale,item.designCapacityMWh)})}</small>}
    {item.cycleCount!==null&&<small>{t('battery.cycles',{count:item.cycleCount})}</small>}
   </li>;})}</ul>
 </Card>;
}
