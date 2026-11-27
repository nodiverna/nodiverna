// The fact "Windows activation" of the device Overview (System card): the state
// of snapshot.windowsLicense (agent 4.22.0) as the pill text, its tone and up to
// two meta lines. Pure, so a test renders every case in both languages. The
// evaluation end comes from lib/windows-license.ts, the same answer the alert
// rules use; the tone of an evaluation or a not-activated device follows the
// device's own issue of that rule.
import type {Server,WindowsLicenseChannel,WindowsLicenseStatus} from '@/lib/types';
import type {AlertRuleId} from '@/lib/alert-rules';
import {evaluationEnd,graceEnd} from '@/lib/windows-license';
import {formatDate} from '@/lib/i18n/format';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey,type MessageParams} from '@/lib/i18n/translate';
import type {HealthTone} from '@/ui/devices/inventory/health-signals';

export const windowsLicenseStatusKeys:Record<WindowsLicenseStatus,MessageKey>={
 licensed:'windowsLicense.status.licensed',unlicensed:'windowsLicense.status.unlicensed','initial-grace':'windowsLicense.status.initialGrace',
 'additional-grace':'windowsLicense.status.additionalGrace','non-genuine-grace':'windowsLicense.status.nonGenuineGrace',
 notification:'windowsLicense.status.notification','extended-grace':'windowsLicense.status.extendedGrace',unknown:'windowsLicense.status.unknown',
};
/** The label of a known channel; an unknown channel has none. */
export const windowsLicenseChannelKeys:Record<Exclude<WindowsLicenseChannel,'unknown'>,MessageKey>={
 retail:'windowsLicense.channel.retail',oem:'windowsLicense.channel.oem','volume-mak':'windowsLicense.channel.volumeMak','volume-kms':'windowsLicense.channel.volumeKms',evaluation:'windowsLicense.channel.evaluation',
};
export type WindowsLicenseText={text:string;tone:HealthTone;lines:string[]};
const issueTones={critical:'critical',warning:'warning',info:'neutral'} as const;

/** The pill text, tone and meta lines of the fact "Windows activation" at `now` (also for an offline device: the last reported state). */
export function windowsLicenseText(server:Pick<Server,'snapshot'|'issues'>,now:number,locale:Locale=defaultLocale):WindowsLicenseText{
 const t=(key:MessageKey,params?:MessageParams)=>translate(locale,key,params);
 const license=server.snapshot?.windowsLicense;
 if(!license)return {text:t('windowsLicense.notReported'),tone:'neutral',lines:[t('windowsLicense.notReportedHint')]};
 if(!license.available)return {text:t('windowsLicense.notAvailable'),tone:'neutral',lines:[t('windowsLicense.notAvailableHint')]};
 const date=(iso:string)=>formatDate(locale,iso),status=t(windowsLicenseStatusKeys[license.status]);
 const channel=license.channel==='unknown'?null:t(windowsLicenseChannelKeys[license.channel]);
 // The level of the device's own issue; with the rule off there is none, and the state still needs attention.
 const toneOf=(ruleId:AlertRuleId):HealthTone=>{const issue=server.issues?.find(item=>item.ruleId===ruleId);return issue?issueTones[issue.level]:'warning';};
 const end=evaluationEnd(license,server.snapshot?.osInfo,now);
 if(end){
  const lines=end.state==='running'?[t('windowsLicense.evaluationExpires',{date:date(end.date)})]
   :end.state==='ended'?[end.date?t('windowsLicense.evaluationExpiredOn',{date:date(end.date)}):t('windowsLicense.evaluationExpiredHint')]
   :[t('windowsLicense.evaluationUnknownHint')];
  if(license.status!=='licensed')lines.push(status);
  const text=end.state==='running'?t('windowsLicense.evaluationDaysLeft',{count:end.daysLeft}):end.state==='ended'?t('windowsLicense.evaluationExpired'):t('windowsLicense.evaluation');
  return {text,tone:toneOf('windows-evaluation'),lines};
 }
 if(license.status==='unknown')return {text:status,tone:'neutral',lines:channel?[channel]:[]};
 if(license.status==='licensed'){
  const lines=channel?[channel]:[];
  if(license.channel==='volume-kms'&&license.expiresAt)lines.push(t('windowsLicense.kmsValidUntil',{date:date(license.expiresAt)}));
  return {text:status,tone:'ok',lines};
 }
 const grace=graceEnd(license),lines=channel?[channel]:[];
 if(grace)lines.push(t('windowsLicense.graceEnds',{date:date(grace)}));
 return {text:status,tone:toneOf('windows-not-activated'),lines};
}
