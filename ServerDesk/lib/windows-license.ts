// The Windows activation state of agent 4.22.0 (snapshot.windowsLicense,
// docs/device-health-signals.md): whether a device runs an evaluation edition,
// when the evaluation ends and whether Windows is not activated. Pure and
// shared: the alert rules (lib/alert-rules.ts) and the device Overview
// (ui/devices/device/windows-license-model.ts) read the same answer.
import type {OsInfo,WindowsLicense,WindowsLicenseAvailable,WindowsLicenseStatus} from './types';

const dayMs=86400000;
/**
 * Whole days left until an ISO time, rounded up; 0 or less once it has passed.
 * certificateDaysLeft (lib/alert-rules.ts) uses this rounding too.
 */
export function daysLeftUntil(time:string,now:number):number{
 const left=(Date.parse(time)-now)/dayMs;
 return left>0?Math.ceil(left):Math.floor(left);
}
const validTime=(value:string|null|undefined):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value));
/** The license when the agent could read it, else null. */
export const reportedLicense=(license:WindowsLicense|null|undefined):WindowsLicenseAvailable|null=>license?.available?license:null;
/** An evaluation edition: the agent reports the evaluation channel, or the edition ID ends with "Eval" (ServerStandardEval). */
export function isEvaluation(license:WindowsLicense|null|undefined,osInfo:Pick<OsInfo,'editionId'>|null|undefined):boolean{
 return reportedLicense(license)?.channel==='evaluation'||/eval$/i.test(osInfo?.editionId?.trim()??'');
}
/** The four grace states: Windows runs, but activation is due. */
const graceStatuses:readonly WindowsLicenseStatus[]=['initial-grace','additional-grace','non-genuine-grace','extended-grace'];
export const isGraceStatus=(status:WindowsLicenseStatus)=>graceStatuses.includes(status);
/** Activated is licensed; unknown says nothing, so it is not "not activated" either. */
export function notActivated(license:WindowsLicense|null|undefined):boolean{
 const reported=reportedLicense(license);
 return !!reported&&reported.status!=='licensed'&&reported.status!=='unknown';
}
/** The end of the grace period: expiresAt while the status is a grace state, else null. */
export function graceEnd(license:WindowsLicense|null|undefined):string|null{
 const reported=reportedLicense(license);
 return reported&&isGraceStatus(reported.status)&&validTime(reported.expiresAt)?reported.expiresAt:null;
}
export type EvaluationEnd={state:'running';date:string;daysLeft:number}|{state:'ended';date:string|null;daysLeft:number}|{state:'unknown'};
/**
 * When the evaluation ends, or null (no evaluation, or the license is not available).
 * The end is the earlier of expiresAt (only while licensed: before activation the minutes
 * are the activation grace period) and evaluationEndsAt. Without a date, an evaluation in
 * notification or unlicensed has ended (it expired or was never activated); any other
 * status says nothing about the end.
 */
export function evaluationEnd(license:WindowsLicense|null|undefined,osInfo:Pick<OsInfo,'editionId'>|null|undefined,now:number):EvaluationEnd|null{
 const reported=reportedLicense(license);
 if(!reported||!isEvaluation(reported,osInfo))return null;
 const dates=[reported.status==='licensed'?reported.expiresAt:null,reported.evaluationEndsAt].filter(validTime);
 if(dates.length){
  const date=dates.reduce((a,b)=>Date.parse(b)<Date.parse(a)?b:a),daysLeft=daysLeftUntil(date,now);
  return daysLeft>0?{state:'running',date,daysLeft}:{state:'ended',date,daysLeft};
 }
 return reported.status==='notification'||reported.status==='unlicensed'?{state:'ended',date:null,daysLeft:0}:{state:'unknown'};
}
