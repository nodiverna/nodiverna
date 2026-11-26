'use client';
import {Wrench} from 'lucide-react';
import type {MaintenanceStatus} from '@/lib/types';
import {consoleRouteHash} from '@/lib/console-route';
import {Notice,relativeTime} from '@/ui/kit/kit';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate} from '@/lib/i18n/translate';
import {useLocale,useT} from '@/ui/base/locale';
import {useClockNow} from '@/ui/base/clock-store';

// Owner notice when maintenance has not succeeded for more than 48 hours
// (lib/server/maintenance-runs.ts decides "stale" on the server). It cannot be
// dismissed: it goes away after the next successful run and reload. Its action
// opens the page Settings → Maintenance in the same tab.
export const maintenancePageHash=consoleRouteHash({view:'settings',page:'retention'});

/** Title (shown in bold) and text of the notice. Each case, with or without a failed last run, is one catalog sentence. */
export function maintenanceNoticeText(status:MaintenanceStatus,now:number,locale:Locale=defaultLocale):{title:string;text:string}{
 const failed=status.lastRun?.status==='failed';
 if(status.lastSuccessAt===null)return {title:translate(locale,'maintenance.neverTitle'),text:translate(locale,failed?'maintenance.neverTextFailed':'maintenance.neverText')};
 return {title:translate(locale,'maintenance.overdueTitle'),text:translate(locale,failed?'maintenance.overdueTextFailed':'maintenance.overdueText',{time:relativeTime(status.lastSuccessAt,now,locale)})};
}

export default function MaintenanceNotice({status,now:pinnedNow}:{status:MaintenanceStatus|undefined;
 /** Pins the time (tests); without it the notice follows the console clock and renders again when its text changes. */
 now?:number}){
 const t=useT(),[locale]=useLocale();
 const now=useClockNow(pinnedNow,time=>status?.stale?maintenanceNoticeText(status,time,locale).text:'');
 // now is 0 when a test pins no time; the relative time needs it.
 if(!status?.stale||!now)return null;
 const {title,text}=maintenanceNoticeText(status,now,locale);
 // A link styled like Btn size="sm" variant="ghost", which only renders buttons.
 return <Notice tone="warning" icon={Wrench} action={<a className="sdx-btn sdx-btn-ghost sdx-btn-sm" href={maintenancePageHash}><span>{t('maintenance.open')}</span></a>}><strong>{title}</strong> {text}</Notice>;
}
