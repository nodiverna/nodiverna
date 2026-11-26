import type {Server} from '@/lib/types';
import {compareTagNames,type EffectiveTag} from '@/lib/tags';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {deviceType,deviceTypeLabels} from '@/ui/devices/device/device-type-model';
import {deviceManufacturer as made} from '@/ui/devices/hardware/manufacturer-model';

// Same format as updateCsv in ui/devices/management/update-view.ts: UTF-8 BOM, ";" and CRLF, so
// German Excel opens the file directly.
const header:MessageKey[]=['csv.name','csv.group','csv.description','csv.tags','csv.os','csv.deviceType','csv.manufacturer','csv.model','csv.agentVersion','csv.lastHeartbeat'];
export const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
// Neutralize cells a spreadsheet would read as a formula (CSV injection, OWASP).
export const cell=(value:string)=>quote(/^\s*[=+\-@\t\r]/.test(value)?"'"+value:value);
// Matches shortOs in ui/kit/kit.tsx, which this pure module must not import.
const shortOs=(os?:string|null)=>os?.replace('Microsoft ','')??'';

/**
 * The tags cell: the effective tags as `Name=Value` (or `Name` without a value),
 * sorted by name without regard to case and joined with "; ".
 */
export function fleetCsvTags(tags:readonly EffectiveTag[]|undefined):string{
 return [...(tags??[])].sort(compareTagNames).map(tag=>tag.value?`${tag.name}=${tag.value}`:tag.name).join('; ');
}

/**
 * CSV of the given devices in their given order: only name, group,
 * description, effective tags, OS, device type, manufacturer (display name),
 * model, agent version and last heartbeat. Line
 * breaks of the description stay inside the quoted cell. With customer, the customer column (the plain name)
 * comes before the group; without it the output is unchanged. Headers are in locale.
 */
export function fleetCsv(devices:Server[],{customer=false}:{customer?:boolean}={},locale:Locale=defaultLocale):string{
 const rows=devices.map(device=>{const {manufacturer,model}=made(device);return [
  device.name,
  ...(customer?[device.customerName??'']:[]),
  device.groupName??'',
  device.description??'',
  fleetCsvTags(device.tags),
  shortOs(device.snapshot?.os),
  translate(locale,deviceTypeLabels[deviceType(device)]),
  manufacturer?.name??'',
  model,
  (device.snapshot?.agentVersion??'').trim(),
  device.lastSeen==null?'':new Date(device.lastSeen).toISOString(),
 ].map(cell);});
 const columns:MessageKey[]=customer?[header[0],'csv.customer',...header.slice(1)]:header;
 return '﻿'+[columns.map(key=>quote(translate(locale,key))),...rows].map(row=>row.join(';')).join('\r\n');
}

/** File name with the local date of now, e.g. ServerDesk-Geraete-2026-10-16.csv or ServerDesk-Devices-2026-10-16.csv. */
export function fleetCsvFileName(now:number,locale:Locale=defaultLocale):string{
 const date=new Date(now),pad=(value:number)=>String(value).padStart(2,'0');
 return translate(locale,'csv.fileName',{date:`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`});
}
