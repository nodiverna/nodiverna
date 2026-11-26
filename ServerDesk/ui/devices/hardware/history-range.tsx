'use client';
// The time range of a utilization history card (CPU, RAM, GPU): a small Segmented in the card head.
import {Segmented} from '@/ui/kit/kit';
import {useT} from '@/ui/base/locale';

export type HistoryRange='30'|'60'|'360'|'1440';
export function HistoryRangeSwitch({label,value,onChange}:{label:string;value:HistoryRange;onChange:(value:HistoryRange)=>void}){
 const t=useT();
 return <Segmented<HistoryRange> label={label} size="sm" value={value} onChange={onChange} items={[{id:'30',label:t('device.summary.range30')},{id:'60',label:t('device.summary.range60')},{id:'360',label:t('device.summary.range360')},{id:'1440',label:t('device.summary.range1440')}]}/>;
}
