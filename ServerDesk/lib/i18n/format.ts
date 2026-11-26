// Dates, times and numbers in the console language. Every formatted
// value in translated UI goes through these helpers, never through a new
// toLocaleString('de-DE'). English uses en-US; switching to en-GB is one line.
import {defaultLocale,type Locale} from './locale';
import {translate} from './translate';

const tags:Record<Locale,string>={de:'de-DE',en:'en-US'};
const tagOf=(locale:Locale)=>tags[locale]??tags[defaultLocale];

/** Hours and minutes, e.g. "14:05" or "02:05 PM". */
export function formatClock(locale:Locale,ms:number):string{
 return new Date(ms).toLocaleTimeString(tagOf(locale),{hour:'2-digit',minute:'2-digit'});
}

/** Date and time; a missing value says so (kit.noValue). options pass through to Intl. */
export function formatDateTime(locale:Locale,value:number|string|null|undefined,options?:Intl.DateTimeFormatOptions):string{
 return value?new Date(value).toLocaleString(tagOf(locale),options):translate(locale,'kit.noValue');
}

/** A number in the console language, e.g. "1,5" or "1.5". options pass through to Intl. */
export function formatNumber(locale:Locale,value:number,options?:Intl.NumberFormatOptions):string{
 return value.toLocaleString(tagOf(locale),options);
}

/** The date part of a timestamp, e.g. "23.10.2026" or "10/23/2026". The caller handles a missing value. */
export function formatDate(locale:Locale,value:number|string|Date,options?:Intl.DateTimeFormatOptions):string{
 return new Date(value).toLocaleDateString(tagOf(locale),options);
}

/** The time part of a timestamp, e.g. "14:05:00". The caller handles a missing value. */
export function formatTime(locale:Locale,value:number|string|Date,options?:Intl.DateTimeFormatOptions):string{
 return new Date(value).toLocaleTimeString(tagOf(locale),options);
}

/** Relative time for timestamps such as heartbeats: just now, minutes, hours, yesterday, days. */
export function formatRelative(locale:Locale,value:number|null|undefined,now:number):string{
 if(!value)return translate(locale,'kit.never');
 const seconds=Math.max(0,Math.round((now-value)/1000));
 if(seconds<45)return translate(locale,'kit.justNow');
 if(seconds<3600)return translate(locale,'kit.minutesAgo',{count:Math.max(1,Math.round(seconds/60))});
 if(seconds<86400)return translate(locale,'kit.hoursAgo',{count:Math.round(seconds/3600)});
 const days=Math.round(seconds/86400);
 return days===1?translate(locale,'kit.yesterday'):translate(locale,'kit.daysAgo',{count:days});
}

/** A time in the future relative to now ("in 3 hours"); a time in the past reads like formatRelative. */
export function formatUntil(locale:Locale,value:number|null|undefined,now:number):string{
 if(!value||value<=now)return formatRelative(locale,value,now);
 const seconds=Math.round((value-now)/1000);
 if(seconds<45)return translate(locale,'kit.inMoments');
 if(seconds<3600)return translate(locale,'kit.inMinutes',{count:Math.max(1,Math.round(seconds/60))});
 if(seconds<86400)return translate(locale,'kit.inHours',{count:Math.round(seconds/3600)});
 return translate(locale,'kit.inDays',{count:Math.round(seconds/86400)});
}

/** The placeholder for a value that is missing or invalid. */
export const EMPTY_VALUE='—';

/** Rounded percentage; German puts a space before the sign, English does not. */
export function formatPercent(locale:Locale,value:number|null):string{
 if(value==null)return EMPTY_VALUE;
 return locale==='en'?`${Math.round(value)}%`:`${Math.round(value)} %`;
}

/** A contrast ratio with one decimal, rounded down so it never claims more than it has: "4.8:1" (German "4,8:1"). */
export function formatRatio(locale:Locale,ratio:number):string{
 return `${formatNumber(locale,Math.floor(ratio*10)/10,{minimumFractionDigits:1,maximumFractionDigits:1})}:1`;
}

const byteUnits=['B','KiB','MiB','GiB','TiB'] as const;
export type ByteUnit=typeof byteUnits[number];
/**
 * A byte count in IEC units (factor 1024), e.g. "1.5 KiB" or "68 GiB": the largest unit with a
 * value of at least 1 (TiB at most), one fraction digit below 10, none from 10 up and never for B.
 * Number and unit are joined by a no-break space, so the value never wraps. unit forces a unit.
 * Missing, invalid and negative values give EMPTY_VALUE.
 */
export function formatBytes(locale:Locale,bytes:number|null|undefined,{unit}:{unit?:ByteUnit}={}):string{
 if(bytes==null||!Number.isFinite(bytes)||bytes<0)return EMPTY_VALUE;
 let index=unit?byteUnits.indexOf(unit):0;
 if(!unit)while(index<byteUnits.length-1&&bytes>=1024**(index+1))index++;
 const value=bytes/1024**index;
 // Rounded first, so 9.96 KiB shows as "10 KiB" and not as "10.0 KiB".
 const digits=index===0||Math.round(value*10)/10>=10?0:1;
 return `${formatNumber(locale,value,{maximumFractionDigits:digits})} ${byteUnits[index]}`;
}

const nbsp=' ';
const usable=(value:number|null|undefined):value is number=>value!=null&&Number.isFinite(value);
/**
 * A duration in milliseconds with the largest fitting unit: "850 ms", "1.5 s" (one fraction digit
 * below 10 s), "12 s", "4 min", "2 h 5 min" ("2 Std 5 Min" in German). The unit words are catalog
 * keys (kit.unit.*), and a no-break space keeps number and unit on one line. Missing, invalid
 * and negative values give EMPTY_VALUE.
 */
export function formatDuration(locale:Locale,ms:number|null|undefined):string{
 if(!usable(ms)||ms<0)return EMPTY_VALUE;
 const unit=(value:string,key:'kit.unit.ms'|'kit.unit.s'|'kit.unit.min'|'kit.unit.h')=>`${value}${nbsp}${translate(locale,key)}`;
 if(Math.round(ms)<1000)return unit(formatNumber(locale,Math.round(ms)),'kit.unit.ms');
 const seconds=ms/1000;
 // Rounded first, so 9.96 s shows as "10 s" and not as "10.0 s".
 if(Math.round(seconds)<60)return unit(formatNumber(locale,seconds,{maximumFractionDigits:Math.round(seconds*10)/10>=10?0:1}),'kit.unit.s');
 const minutes=Math.round(seconds/60);
 if(minutes<60)return unit(formatNumber(locale,minutes),'kit.unit.min');
 const hours=Math.floor(minutes/60),rest=minutes%60;
 if(!rest)return unit(formatNumber(locale,hours),'kit.unit.h');
 return translate(locale,'kit.unit.hoursMinutes',{hours:formatNumber(locale,hours),minutes:formatNumber(locale,rest)}).replace(/ /g,nbsp);
}

/** A temperature in degrees Celsius, rounded, e.g. "41 °C" with a no-break space. A missing or invalid value gives EMPTY_VALUE. */
export function formatTemperature(locale:Locale,celsius:number|null|undefined):string{
 return usable(celsius)?`${formatNumber(locale,Math.round(celsius))}${nbsp}${translate(locale,'kit.unit.celsius')}`:EMPTY_VALUE;
}

/** A transfer rate: formatBytes per second, e.g. "1.2 MiB/s". Invalid values give EMPTY_VALUE. */
export function formatRate(locale:Locale,bytesPerSecond:number|null|undefined):string{
 const bytes=formatBytes(locale,bytesPerSecond);
 return bytes===EMPTY_VALUE?bytes:`${bytes}/s`;
}
