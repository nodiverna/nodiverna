import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate} from '@/lib/i18n/translate';
import type {SessionTiming} from '@/ui/session/session-state';

export const idleNoticeDelayMs=60000;
export function idleCountdown(status:SessionTiming|null,time:number,lastInteractionAt:number){
 if(!status?.authenticated||status.idleExpiresAt===null||status.sessionExpiresAt===null)return null;
 const remaining=Math.min(status.idleExpiresAt,status.sessionExpiresAt)-time;
 if(remaining<=0||time-Math.max(lastInteractionAt,status.lastActivityAt??0)<idleNoticeDelayMs)return null;
 return Math.ceil(remaining/1000);
}
/** The login screen's note: the configured idle timeout, or nothing when the server sent none. */
export function idleLogoutText(idleTimeoutMs:unknown,locale:Locale=defaultLocale){
 if(typeof idleTimeoutMs!=='number'||!Number.isFinite(idleTimeoutMs)||idleTimeoutMs<60000)return null;
 const minutes=Math.round(idleTimeoutMs/60000);
 return translate(locale,'session.idleLogout',{count:minutes});
}
// The countdown turns urgent for the last fifth of the idle timeout, at most
// for the last five minutes. A 5-minute timeout is not red for its whole life.
export function idleUrgent(seconds:number,idleTimeoutMs?:number|null){
 const threshold=typeof idleTimeoutMs==='number'&&Number.isFinite(idleTimeoutMs)&&idleTimeoutMs>0?Math.min(300,Math.round(idleTimeoutMs/5000)):300;
 return seconds<=threshold;
}
export function countdownLabel(seconds:number){
 return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
}
/**
 * The seconds the top bar pill shows: the countdown (idleCountdown) only inside its urgent window
 * (idleUrgent for the session's idle timeout); null before it, without an authenticated session and
 * after any activity.
 */
export function idlePillSeconds(status:(SessionTiming&{idleTimeoutMs?:number|null})|null,time:number,lastInteractionAt:number):number|null{
 const seconds=idleCountdown(status,time,lastInteractionAt);
 return seconds!==null&&idleUrgent(seconds,status?.idleTimeoutMs)?seconds:null;
}
