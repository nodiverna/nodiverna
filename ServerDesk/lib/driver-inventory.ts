// The driver inventory of agent 4.11.0 (docs/v3-health-signals.md): the report
// format of POST /api/agent/drivers, the checksum the agent computes the same
// way (NativeDriverInventory.cs), the search and the age filters of the device
// area Drivers. Pure, without server imports: the ingest (lib/server/devices/drivers.ts), the
// demo data, the views and the tests use it.
import {z} from 'zod';

export const maxDriverItems=2000;
export type DriverItem={key:string;deviceName:string;deviceClass:string|null;infName:string|null;file:string|null;service:string|null;provider:string|null;version:string|null;date:string|null;signed:boolean|null;signer:string|null};
export type DriverReport={checksum:string;count:number;truncated:boolean;items:DriverItem[]};

const text=z.string().max(256);
/** key: the first 16 hex characters of the SHA-256 of the device ID; the device ID itself is never sent. */
export const driverKey=z.string().regex(/^[0-9a-f]{16}$/);
const driverItem=z.object({
 key:driverKey,deviceName:z.string().min(1).max(256),deviceClass:text.nullable(),infName:text.nullable(),
 // A plain file name such as vjoy.sys, never a path.
 file:z.string().min(1).max(256).regex(/^[^\\/:]+$/).nullable(),service:text.nullable(),provider:text.nullable(),version:text.nullable(),
 date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),signed:z.boolean().nullable(),signer:text.nullable()
}).strict();
/** The body of POST /api/agent/drivers without serverId: strict, at most 2000 items, count and truncated consistent, unique keys. */
export const driverReport=z.object({
 checksum:z.string().regex(/^[0-9a-f]{64}$/),count:z.number().int().min(0).max(1_000_000),truncated:z.boolean(),items:z.array(driverItem).max(maxDriverItems)
}).strict().superRefine((report,context)=>{
 if(report.count<report.items.length)context.addIssue({code:'custom',path:['count'],message:'count is smaller than the list.'});
 if(report.truncated!==(report.count>report.items.length))context.addIssue({code:'custom',path:['truncated'],message:'truncated does not match count.'});
 const seen=new Set<string>();
 report.items.forEach((item,index)=>{if(seen.has(item.key))context.addIssue({code:'custom',path:['items',index,'key'],message:'duplicate entry.'});seen.add(item.key);});
});

const ordinal=(a:string,b:string)=>a<b?-1:a>b?1:0;
/**
 * The canonical JSON the checksum covers: an array of
 * [key,deviceName,deviceClass,infName,file,service,provider,version,date,signed,signer]
 * arrays, sorted ordinally by key. The agent writes the same bytes.
 */
export function canonicalDriverJson(items:readonly DriverItem[]):string{
 return JSON.stringify([...items].sort((a,b)=>ordinal(a.key,b.key)).map(item=>[item.key,item.deviceName,item.deviceClass,item.infName,item.file,item.service,item.provider,item.version,item.date,item.signed,item.signer]));
}
export async function sha256Hex(text:string):Promise<string>{
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
 return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** SHA-256 (lower-case hex) over the UTF-8 bytes of the canonical JSON. */
export const driverChecksum=(items:readonly DriverItem[])=>sha256Hex(canonicalDriverJson(items));

/** The name of a driver in the fleet tab and in issues: the INF name, else the device name. */
export const driverName=(item:Pick<DriverItem,'infName'|'deviceName'>)=>item.infName??item.deviceName;
/** The tokens of a search: split on spaces, at most 10 tokens of at most 100 characters, lower case. */
export function driverSearchTokens(query:string|null|undefined):string[]{
 return (query??'').normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean).slice(0,10).map(token=>token.slice(0,100));
}
/** True when every token is a substring of the device name, INF name, file, provider or version. */
export function driverMatches(item:Pick<DriverItem,'deviceName'|'infName'|'file'|'provider'|'version'>,tokens:readonly string[]):boolean{
 const fields=[item.deviceName,item.infName??'',item.file??'',item.provider??'',item.version??''].map(value=>value.normalize('NFKC').toLowerCase());
 return tokens.every(token=>fields.some(field=>field.includes(token)));
}
export const driverShowOptions=['all','unsigned','older3','older5','older10'] as const;
export type DriverShow=typeof driverShowOptions[number];
const ageYears:Record<Exclude<DriverShow,'all'|'unsigned'>,number>={older3:3,older5:5,older10:10};
/** True when a driver dated YYYY-MM-DD is older than `years` years at `now`; a driver without a date is never older. */
export function driverOlderThan(date:string|null,years:number,now:number):boolean{
 if(!date)return false;
 const at=Date.parse(date+'T00:00:00Z');
 if(!Number.isFinite(at))return false;
 const limit=new Date(now);limit.setUTCFullYear(limit.getUTCFullYear()-years);
 return at<limit.getTime();
}
/** The "Show" select of the device area Drivers. Unsigned means signed === false (unknown is not unsigned). */
export function driverShown(item:Pick<DriverItem,'signed'|'date'>,show:DriverShow,now:number):boolean{
 if(show==='all')return true;
 if(show==='unsigned')return item.signed===false;
 return driverOlderThan(item.date,ageYears[show],now);
}
/** True when the driver's binary file is `file`, case-insensitive (the crash link). */
export const driverFileMatches=(item:Pick<DriverItem,'file'>,file:string)=>!!item.file&&item.file.toLowerCase()===file.toLowerCase();
