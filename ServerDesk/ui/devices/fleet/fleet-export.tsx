'use client';
import {Download} from 'lucide-react';
import {toast} from 'sonner';
import type {Server} from '@/lib/types';
import {fleetCsv,fleetCsvFileName} from '@/ui/devices/fleet/fleet-csv';
import {downloadText} from '@/ui/base/api';
import {IconBtn} from '@/ui/kit/kit';
import {useLocale,useT} from '@/ui/base/locale';
import {consoleClock} from '@/ui/base/clock-store';

type Props={devices:Server[];
 /** Pins the time of the file name (tests); without it the export reads the console clock when it runs. */
 now?:number;/** Adds the customer column. */customer?:boolean;download?:(name:string,text:string,type:string)=>void};

/** Exports exactly the devices the fleet list shows (filters and sort order) as a CSV file. */
export default function FleetCsvExport({devices,now,customer=false,download=downloadText}:Props){
 const t=useT(),[locale]=useLocale(),empty=devices.length===0;
 const exportCsv=()=>{
  if(empty)return;
  try{
   download(fleetCsvFileName(now??consoleClock.now(),locale),fleetCsv(devices,{customer},locale),'text/csv;charset=utf-8');
   toast.success(t('csv.exported',{count:devices.length}));
  }catch{
   toast.error(t('csv.exportFailed'));
  }
 };
 return <IconBtn icon={Download} label={t('csv.export')} className="sdx-icon-btn-framed" blocked={empty?t('csv.nothingToExport'):undefined} onClick={exportCsv}/>;
}
