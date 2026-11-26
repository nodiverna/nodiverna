'use client';
// The drive list of a device (ul.sdx-drives): one row per reported drive with its name, a usage
// Meter and the free space. The device Overview (Drives card) and Hardware → Disks share it.
import {ArrowUpRight,HardDrive} from 'lucide-react';
import type {Disk} from '@/lib/types';
import {formatBytes,formatPercent} from '@/lib/i18n/format';
import {Empty,Meter} from '@/ui/kit/kit';
import {useLocale,useT} from '@/ui/base/locale';

/** Inventory sizes (freeGb, totalGb, memoryGb) count units of 1024³ bytes; formatBytes takes bytes. */
export const gibBytes=(value:number)=>value*1024**3;

/**
 * The drives with their usage. With onOpen every row is a button that opens the drive (named
 * "Manage disk C:"); without it the rows are static. The selected drive has the selection style
 * and aria-current. Without drives the list shows the shared empty state.
 */
export function DriveList({disks,onOpen,selected}:{disks:readonly Disk[]|undefined;onOpen?:(name:string)=>void;selected?:string}){
 const t=useT(),[locale]=useLocale();
 if(!disks?.length)return <Empty icon={HardDrive} title={t('device.summary.noDrives')}>{t('device.summary.drivesAfter')}</Empty>;
 return <ul className="sdx-drives">{disks.map(item=>{
  const valid=item.totalGb>0&&item.freeGb>=0&&item.freeGb<=item.totalGb,free=valid?item.freeGb/item.totalGb*100:null,used=free==null?null:100-free;
  const current=selected===item.name,className=current?'sdx-drive-selected':undefined,ariaCurrent=current?'true' as const:undefined;
  const content=<><span className="sdx-drive-name"><strong>{item.name}</strong><small>{item.label||t('device.summary.localDrive')}</small></span><Meter value={used} label={t('device.summary.driveUsed',{name:item.name})} warning={85} critical={95}/><span className="sdx-drive-free"><strong>{valid?t('device.summary.sizeFree',{size:formatBytes(locale,gibBytes(item.freeGb))}):t('device.summary.notCollected')}</strong><small>{valid?t('device.summary.ofSizePercent',{size:formatBytes(locale,gibBytes(item.totalGb)),percent:formatPercent(locale,free)}):''}</small></span></>;
  return <li key={item.name}>{onOpen?<button type="button" className={className} aria-current={ariaCurrent} onClick={()=>onOpen(item.name)} aria-label={t('device.summary.manageDisk',{name:item.name})}>{content}<ArrowUpRight size={14} aria-hidden className="sdx-drive-go"/></button>:<div className={className} aria-current={ariaCurrent}>{content}</div>}</li>;
 })}</ul>;
}
