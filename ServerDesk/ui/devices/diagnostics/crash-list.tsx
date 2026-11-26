'use client';
// The list "Crashes" in the device area Events (docs/device-health-signals.md):
// the crashes of the last 30 days from the snapshot. Every viewer who sees the
// device sees it (right view, like the snapshot events); the live event query
// below needs diagnose.
import {Bug,ExternalLink} from 'lucide-react';
import type {Server} from '@/lib/types';
import {bugCheckDocUrl,formatStopCode} from '@/ui/base/bugcheck-codes';
import {crashKindKey,crashSourceKey} from '@/ui/devices/inventory/health-signals';
import {Card,Empty,exactTime} from '@/ui/kit/kit';
import {useLocale,useT} from '@/ui/base/locale';
import {EMPTY_VALUE} from '@/lib/i18n/format';

export default function CrashList({server}:{server:Pick<Server,'snapshot'>}){
 const t=useT(),[locale]=useLocale();
 const snapshot=server.snapshot,crashes=snapshot?.crashes??[],inventory=snapshot?.crashInventory;
 return <Card title={t('crashes.title')} icon={Bug} meta={t('crashes.meta')} className="sdx-crashes" flush>
  {!inventory?<Empty icon={Bug} title={t('crashes.title')}>{t('crashes.notReported')}</Empty>
   :!crashes.length?<Empty icon={Bug} title={t('crashes.empty')}/>
   :<div className="sdx-table-wrap"><table className="sdx-table sdx-crash-table">
    <thead><tr><th scope="col">{t('crashes.col.time')}</th><th scope="col">{t('crashes.col.type')}</th><th scope="col">{t('crashes.col.stopCode')}</th><th scope="col">{t('crashes.col.driver')}</th><th scope="col">{t('crashes.col.source')}</th></tr></thead>
    <tbody>{crashes.map(crash=><tr key={crash.id}>
     <td><span className="sdx-nowrap">{exactTime(crash.at,locale)}</span></td>
     <td>{t(crashKindKey(crash.kind))}{crash.detail&&<small className="sdx-cell-note">{crash.detail}</small>}</td>
     <td>{crash.kind==='bugcheck'&&crash.stopCode!=null?<span className="sdx-stop-code"><span className="mono">{formatStopCode(crash.stopCode)}</span><a href={bugCheckDocUrl(crash.stopCode)} target="_blank" rel="noopener noreferrer" aria-label={t('crashes.docsLabel',{code:formatStopCode(crash.stopCode)})}><ExternalLink size={12} aria-hidden/>{t('crashes.docs')}</a></span>:<span className="sdx-muted-cell">{EMPTY_VALUE}</span>}</td>
     <td>{crash.driver?<span className="sdx-cell-stack"><span className="mono">{crash.driver.name}</span>{(crash.driver.version||crash.driver.manufacturer)&&<small>{[crash.driver.version,crash.driver.manufacturer].filter(Boolean).join(' · ')}</small>}</span>:<span className="sdx-muted-cell">{crash.kind==='bugcheck'?t('crashes.driverUnknown'):EMPTY_VALUE}</span>}</td>
     <td>{t(crashSourceKey(crash.source))}{crash.dumpStatus==='unreadable'?<small className="sdx-cell-note">{t('crashes.dumpUnreadable')}</small>:crash.dumpStatus==='too-large'?<small className="sdx-cell-note">{t('crashes.dumpTooLarge')}</small>:null}</td>
    </tr>)}</tbody>
   </table>{inventory.truncated&&<p className="sdx-table-foot">{t('crashes.truncated')}</p>}</div>}
 </Card>;
}
