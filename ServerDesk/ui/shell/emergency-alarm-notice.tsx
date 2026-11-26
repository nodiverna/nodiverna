'use client';
import {useState} from 'react';
import {CheckCheck,ScrollText,Siren} from 'lucide-react';
import {toast} from 'sonner';
import type {ConsoleData} from '@/lib/types';
import {apiErrorText} from '@/ui/base/api-error-text';
import {consoleRouteHash} from '@/lib/console-route';
import {api,message} from '@/ui/base/api';
import {Btn,Notice,exactTime,relativeTime} from '@/ui/kit/kit';
import {useLocale,useT} from '@/ui/base/locale';
import {useClockNow} from '@/ui/base/clock-store';

// Owner notice of an emergency sign-in (docs/entra-id.md, "Emergency access"):
// the console data carries emergencyAlarms only for global Owners
// (lib/server/identity/security-alarms.ts). While an alarm is open it is the focal point of the
// console: the danger notice names the newest sign-in, counts the others, links
// the audit log and offers "Acknowledge". The account that signed in cannot
// acknowledge its own alarm (the button is blocked with the server's reason).
// Acknowledging hides the notice at once and brings it back on an error.
export type EmergencyAlarms=NonNullable<ConsoleData['emergencyAlarms']>;
export const securityAlarmsEndpoint='/api/security-alarms';
export const auditLogHash=consoleRouteHash({view:'settings',page:'audit'});

export default function EmergencyAlarmNotice({alarms,now:pinnedNow,onAcknowledged}:{alarms:EmergencyAlarms|undefined;
 /** Pins the time (tests; 0 shows the exact time); without it the notice follows the console clock and renders again when its relative time changes. */
 now?:number;
 /** Runs after a successful acknowledge, for example a console refresh. */
 onAcknowledged?:()=>void}){
 const t=useT(),[locale]=useLocale(),[hidden,setHidden]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const latest=alarms?.latest;
 const now=useClockNow(pinnedNow,time=>latest?relativeTime(latest.at,time,locale):'');
 if(!alarms||alarms.open<1||!latest||hidden===latest.id)return null;
 const own=latest.own?apiErrorText(locale,{messageKey:'apiError.alarm.ownEmergency'}):undefined;
 const acknowledge=async()=>{
  if(own||busy)return;
  setBusy(true);setHidden(latest.id);
  try{
   await api(securityAlarmsEndpoint,{action:'acknowledge',id:latest.id});
   toast.success(t('alarm.emergency.acknowledged'));
   onAcknowledged?.();
  }catch(failure){setHidden(null);toast.error(message(failure,locale));}
  finally{setBusy(false);}
 };
 const address=latest.address&&latest.address!=='unknown'?latest.address:t('alarm.emergency.unknownAddress');
 const more=alarms.open-1;
 return <Notice tone="danger" icon={Siren} action={<div className="sdx-alarm-notice-actions">
  {/* A link styled like Btn size="sm" variant="ghost", which only renders buttons. */}
  <a className="sdx-btn sdx-btn-ghost sdx-btn-sm" href={auditLogHash}><ScrollText size={13} aria-hidden/><span>{t('alarm.emergency.audit')}</span></a>
  <Btn size="sm" icon={CheckCheck} loading={busy} blocked={own} onClick={()=>void acknowledge()}>{t('alarm.emergency.acknowledge')}</Btn>
 </div>}>
  <strong>{t('alarm.emergency.title')}</strong> <span title={exactTime(latest.at,locale)}>{t('alarm.emergency.text',{name:latest.displayName,time:now?relativeTime(latest.at,now,locale):exactTime(latest.at,locale),address})}</span>
  {more>0&&<> <span className="sdx-alarm-notice-more">{t('alarm.emergency.more',{count:more})}</span></>}
 </Notice>;
}
