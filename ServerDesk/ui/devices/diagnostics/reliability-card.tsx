'use client';
// The card "Reliability" in the device area Events (docs/device-health-signals.md):
// the stability index of the last 30 days as a small line chart (or "Not
// available" with the reason), then the program crashes of 7 days summarized
// per program, each expandable to its single events. Every viewer who sees the
// device sees it, like the crash list.
import {Fragment,useState} from 'react';
import {Activity,ChevronDown,ChevronRight} from 'lucide-react';
import {Line,LineChart,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import {chartSeries,chartTooltip} from '@/ui/kit/chart';
import type {ReliabilityEventKind,Server,StabilityUnavailableReason} from '@/lib/types';
import {programSummary} from '@/lib/reliability';
import {EMPTY_VALUE,formatNumber} from '@/lib/i18n/format';
import {formatSupportDate} from '@/ui/base/ui-device';
import type {MessageKey} from '@/lib/i18n/translate';
import {Card,Empty,exactTime} from '@/ui/kit/kit';
import {useLocale,useT} from '@/ui/base/locale';

const reasonKeys:Record<StabilityUnavailableReason,MessageKey>={'collection-disabled':'reliability.reason.collectionDisabled','not-supported':'reliability.reason.notSupported','access-denied':'reliability.reason.accessDenied',error:'reliability.reason.error'};
const kindKeys:Record<ReliabilityEventKind,MessageKey>={crash:'reliability.kind.crash',hang:'reliability.kind.hang','install-failure':'reliability.kind.installFailure'};
/** The window of the program summary: the same 7 days as the rule app-crash-repeated. */
export const reliabilitySummaryDays=7;

export default function ReliabilityCard({server,now}:{server:Pick<Server,'snapshot'>;now:number}){
 const t=useT(),[locale]=useLocale(),reliability=server.snapshot?.reliability;
 const [open,setOpen]=useState<string|null>(null);
 if(!reliability)return <Card title={t('reliability.title')} icon={Activity} className="sdx-reliability" flush><Empty icon={Activity} title={t('reliability.title')}>{t('reliability.notReported')}</Empty></Card>;
 const stability=reliability.stability,programs=programSummary(reliability.events,now,reliabilitySummaryDays);
 const value=stability.available?formatNumber(locale,stability.current,{minimumFractionDigits:1,maximumFractionDigits:1}):'';
 return <Card title={t('reliability.title')} icon={Activity} meta={t('reliability.meta')} className="sdx-reliability" flush>
  <div className="sdx-stability">
   <div className="sdx-stability-value"><small>{t('reliability.stability')}</small>{stability.available?<strong>{t('reliability.current',{value})}</strong>:<><strong className="sdx-muted-cell">{t('reliability.notAvailable')}</strong><p>{t(reasonKeys[stability.reason])}</p></>}</div>
   {stability.available&&stability.days.length>0&&<div className="sdx-stability-chart" role="img" aria-label={t('reliability.stabilityChart',{value})}>
    <ResponsiveContainer width="100%" height={96} minWidth={1}><LineChart data={stability.days} margin={{top:6,right:8,bottom:0,left:-28}}>
     <XAxis dataKey="day" tickFormatter={day=>formatSupportDate(locale,String(day))} minTickGap={40} tick={{fontSize:10,fill:'var(--sd-muted)'}} axisLine={false} tickLine={false}/>
     <YAxis domain={[1,10]} ticks={[1,5,10]} tick={{fontSize:10,fill:'var(--sd-muted)'}} axisLine={false} tickLine={false}/>
     <Tooltip {...chartTooltip} labelFormatter={day=>formatSupportDate(locale,String(day))} formatter={index=>[formatNumber(locale,Number(index),{minimumFractionDigits:1,maximumFractionDigits:1}),t('reliability.stability')]}/>
     <Line type="monotone" dataKey="index" stroke={chartSeries} strokeWidth={2} dot={false} isAnimationActive={false}/>
    </LineChart></ResponsiveContainer>
   </div>}
  </div>
  <h3 className="sdx-card-subhead">{t('reliability.programCrashes')}</h3>
  {!programs.length?<p className="sdx-card-line">{t('reliability.empty')}</p>
   :<div className="sdx-table-wrap"><table className="sdx-table sdx-program-table">
    <tbody>{programs.map(program=>{const expanded=open===program.key;return <Fragment key={program.key}>
     <tr>
      <td><button type="button" className="sdx-row-open sdx-expand" aria-expanded={expanded} aria-label={t('reliability.showEvents',{program:program.program})} onClick={()=>setOpen(expanded?null:program.key)}>{expanded?<ChevronDown size={14} aria-hidden/>:<ChevronRight size={14} aria-hidden/>}<span>{t('reliability.summary',{program:program.program,count:program.crashes,days:reliabilitySummaryDays})}</span></button>
       {(program.hangs>0||program.installFailures>0)&&<small className="sdx-cell-note">{[program.hangs>0?t('reliability.hangs',{count:program.hangs}):null,program.installFailures>0?t('reliability.installFailures',{count:program.installFailures}):null].filter(Boolean).join(' · ')}</small>}</td>
      <td className="sdx-nowrap sdx-muted-cell">{exactTime(program.last,locale)}</td>
     </tr>
     {expanded&&<tr className="sdx-program-events"><td colSpan={2}><table className="sdx-table">
      <thead><tr><th scope="col">{t('reliability.col.time')}</th><th scope="col">{t('reliability.col.kind')}</th><th scope="col">{t('reliability.col.version')}</th><th scope="col">{t('reliability.col.module')}</th></tr></thead>
      <tbody>{program.events.map((event,index)=><tr key={event.at+index}><td className="sdx-nowrap">{exactTime(event.at,locale)}</td><td>{t(kindKeys[event.kind])}</td><td className="mono">{event.version??EMPTY_VALUE}</td><td className="mono">{event.module?`${event.module}${event.moduleVersion?' '+event.moduleVersion:''}`:EMPTY_VALUE}</td></tr>)}</tbody>
     </table></td></tr>}
    </Fragment>;})}</tbody>
   </table>{reliability.truncated&&<p className="sdx-table-foot">{t('reliability.truncated')}</p>}</div>}
 </Card>;
}
