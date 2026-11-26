// CSV of the software tab (ui/devices/inventory/software-tab.tsx): the shown rows in
// their shown order, in the format of ui/devices/fleet/fleet-csv.ts (UTF-8 BOM, ";" and
// CRLF) and through its cell(), so a cell that a spreadsheet would read as a
// formula is neutralized.
import {cell,quote} from '@/ui/devices/fleet/fleet-csv';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate} from '@/lib/i18n/translate';
import type {Verdict} from '@/lib/software-vulnerabilities';

export type SoftwareCsvRow={name:string;version:string|null;publisher:string|null;deviceCount:number;deviceNames:string[];verdict?:Verdict};

/** The vulnerability cells of a row: highest severity, count, known exploited and fixed version; empty for a program that is not checked. */
function vulnerabilityCells(verdict:Verdict|undefined,locale:Locale):string[]{
 if(!verdict||verdict.status==='unchecked')return ['','','',''];
 const yes=translate(locale,verdict.knownExploited?'vulnerabilities.csv.yes':'vulnerabilities.csv.no');
 return [verdict.highest?translate(locale,`vulnerabilities.severity.${verdict.highest}`):'',String(verdict.count),yes,verdict.fixedIn??''];
}
/**
 * Product, Version, Publisher, Devices (count), then with the vulnerability
 * check on Highest severity, Vulnerabilities (count), Known exploited and Fixed
 * in, then Device names (", "-joined); headers in locale.
 */
export function softwareCsv(rows:readonly SoftwareCsvRow[],locale:Locale=defaultLocale,vulnerabilities=false):string{
 const extra=vulnerabilities?['vulnerabilities.csv.highest','vulnerabilities.csv.count','vulnerabilities.csv.exploited','vulnerabilities.csv.fixedIn'] as const:[];
 const header=['software.col.product','software.col.version','software.col.publisher','software.col.devices',...extra,'software.csv.deviceNames'] as const;
 const lines=rows.map(row=>[row.name,row.version??'',row.publisher??'',String(row.deviceCount),...(vulnerabilities?vulnerabilityCells(row.verdict,locale):[]),row.deviceNames.join(', ')].map(cell));
 return '﻿'+[header.map(key=>quote(translate(locale,key))),...lines].map(line=>line.join(';')).join('\r\n');
}
/** ServerDesk-Software-2026-10-28.csv with the local date of now. */
export function softwareCsvFileName(now:number,locale:Locale=defaultLocale):string{
 const date=new Date(now),pad=(value:number)=>String(value).padStart(2,'0');
 return translate(locale,'software.csv.fileName',{date:`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`});
}
