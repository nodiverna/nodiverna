import {translate} from '@/lib/i18n/translate';
import {formatNumber} from '@/lib/i18n/format';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
export const STORAGE_MIB=1048576;
const MIB_PER_GIB=1024;
export const STORAGE_SIZE_UNITS=['GiB','MiB'] as const;
export type StorageSizeUnit=typeof STORAGE_SIZE_UNITS[number];
export type StorageSizeBounds={minMiB:number;maxMiB:number;defaultMiB:number;currentBytes?:number};
type SizeOptions={minBytes:number;maxBytes:number;currentBytes?:number;growOnly?:boolean};
const safeBytes=(bytes:number)=>Number.isSafeInteger(bytes)&&bytes>=0;

/** Align the inclusive Windows byte range inwards to whole MiB, never outwards. */
export function storageSizeBounds({minBytes,maxBytes,currentBytes,growOnly=false}:SizeOptions):StorageSizeBounds|null{
 if(!safeBytes(minBytes)||!safeBytes(maxBytes)||(currentBytes!==undefined&&!safeBytes(currentBytes)))return null;
 if(growOnly&&(currentBytes===undefined||currentBytes===Number.MAX_SAFE_INTEGER))return null;
 const minMiB=Math.ceil(Math.max(16*STORAGE_MIB,minBytes,growOnly?currentBytes!+1:0)/STORAGE_MIB);
 const maxMiB=Math.floor(maxBytes/STORAGE_MIB);
 if(minMiB>maxMiB)return null;
 const wholeGiB=Math.floor(maxMiB/MIB_PER_GIB)*MIB_PER_GIB;
 // Prefer a readable whole-GiB growth target; retain a precise MiB target
 // when the available extent is too small to reach the next whole GiB.
 const defaultMiB=wholeGiB>=minMiB&&(currentBytes===undefined||wholeGiB*STORAGE_MIB>currentBytes)?wholeGiB:maxMiB;
 return {minMiB,maxMiB,defaultMiB,...(currentBytes!==undefined?{currentBytes}:{})};
}
export function storageSizeInput(miB:number,unit:StorageSizeUnit):string{return String(unit==='GiB'?miB/MIB_PER_GIB:miB);}
export function storageSizeDefaultUnit(miB:number):StorageSizeUnit{return miB%MIB_PER_GIB===0?'GiB':'MiB';}
export function storageSizeMiB(value:string,unit:StorageSizeUnit):number|null{
 if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim()))return null;
 const miB=Number(value)*(unit==='GiB'?MIB_PER_GIB:1);
 return Number.isSafeInteger(miB)&&miB>=0&&Number.isSafeInteger(miB*STORAGE_MIB)?miB:null;
}
export function parseStorageSize(value:string,unit:StorageSizeUnit,bounds:StorageSizeBounds|null,locale:Locale=defaultLocale):{ok:true;bytes:number}|{ok:false;error:string}{
 if(!bounds)return {ok:false,error:translate(locale,'storage.size.noRange')};
 const miB=storageSizeMiB(value,unit);
 if(miB===null)return {ok:false,error:translate(locale,'storage.size.invalid')};
 if(miB<bounds.minMiB||miB>bounds.maxMiB)return {ok:false,error:translate(locale,'storage.size.range',{min:formatNumber(locale,bounds.minMiB),max:formatNumber(locale,bounds.maxMiB)})};
 const bytes=miB*STORAGE_MIB;
 if(bytes===bounds.currentBytes)return {ok:false,error:translate(locale,'storage.size.unchanged')};
 return {ok:true,bytes};
}
