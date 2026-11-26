// The software inventory of agent 4.10.0 (docs/v3-health-signals.md): the
// report format of POST /api/agent/software, the checksum the agent computes
// the same way (NativeSoftwareInventory.cs), the normalized name and version
// (the hook for a later vulnerability match) and the diff of two reports.
// Pure, without server imports: the ingest (lib/server/devices/software.ts), the demo data and
// the tests use it.
import {z} from 'zod';

export const maxSoftwareItems=2000;
export type SoftwareScope='machine'|'user';
export type SoftwareArchitecture='x64'|'x86'|'arm64';
export type SoftwareItem={key:string;name:string;version:string|null;publisher:string|null;installDate:string|null;architecture:SoftwareArchitecture|null;scope:SoftwareScope};
export type SoftwareReport={checksum:string;count:number;truncated:boolean;items:SoftwareItem[]};

const text=z.string().max(256);
const softwareItem=z.object({
 key:z.string().min(1).max(256),name:z.string().min(1).max(256),version:text.nullable(),publisher:text.nullable(),
 installDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),architecture:z.enum(['x64','x86','arm64']).nullable(),scope:z.enum(['machine','user'])
}).strict();
/** The body of POST /api/agent/software without serverId: strict, at most 2000 items, count and truncated consistent, no duplicate identity. */
export const softwareReport=z.object({
 checksum:z.string().regex(/^[0-9a-f]{64}$/),count:z.number().int().min(0).max(1_000_000),truncated:z.boolean(),items:z.array(softwareItem).max(maxSoftwareItems)
}).strict().superRefine((report,context)=>{
 if(report.count<report.items.length)context.addIssue({code:'custom',path:['count'],message:'count is smaller than the list.'});
 if(report.truncated!==(report.count>report.items.length))context.addIssue({code:'custom',path:['truncated'],message:'truncated does not match count.'});
 const seen=new Set<string>();
 report.items.forEach((item,index)=>{
  // Machine entries come from the 64-bit or 32-bit view; user entries carry no architecture.
  if((item.scope==='user')!==(item.architecture===null))context.addIssue({code:'custom',path:['items',index,'architecture'],message:'architecture does not match the scope.'});
  const identity=softwareIdentity(item);
  if(seen.has(identity))context.addIssue({code:'custom',path:['items',index,'key'],message:'duplicate entry.'});
  seen.add(identity);
 });
});

/** The identity of an entry within one device: scope, architecture and the uninstall subkey. */
export const softwareIdentity=(item:Pick<SoftwareItem,'scope'|'architecture'|'key'>)=>`${item.scope}\u0000${item.architecture??''}\u0000${item.key}`;
const ordinal=(a:string,b:string)=>a<b?-1:a>b?1:0;
/** Ordinal order by scope, architecture (none first) and key, as the agent sorts before it cuts the list. */
export function compareSoftwareItems(a:SoftwareItem,b:SoftwareItem):number{
 return ordinal(a.scope,b.scope)||ordinal(a.architecture??'',b.architecture??'')||ordinal(a.key,b.key);
}
/**
 * The canonical JSON the checksum covers: an array of
 * [scope,architecture,key,name,version,publisher,installDate] arrays, sorted
 * ordinally by the first three values. JSON.stringify escapes only quotes,
 * backslashes and control characters; the agent writes the same bytes.
 */
export function canonicalSoftwareJson(items:readonly SoftwareItem[]):string{
 return JSON.stringify([...items].sort(compareSoftwareItems).map(item=>[item.scope,item.architecture,item.key,item.name,item.version,item.publisher,item.installDate]));
}
/** SHA-256 (lower-case hex) over the UTF-8 bytes of the canonical JSON. */
export async function softwareChecksum(items:readonly SoftwareItem[]):Promise<string>{
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalSoftwareJson(items)));
 return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}

const architectureMarker=/\s*(?:\((?:x64|x86|64-bit|32-bit)\)|\bx64|\bx86)$/;
const escapeRegExp=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/**
 * The product name for grouping: NFKC, lower case, trimmed, inner spaces
 * collapsed, then trailing architecture markers and a trailing copy of the
 * reported version removed. "7-Zip 23.01 (x64)" with 23.01 gives "7-zip".
 */
export function normalizeSoftwareName(name:string,version:string|null):string{
 const base=name.normalize('NFKC').toLowerCase().trim().replace(/\s+/g,' ');
 const ownVersion=version?.normalize('NFKC').toLowerCase().trim()??'';
 let current=base,previous='';
 while(current!==previous){
  previous=current;
  current=current.replace(architectureMarker,'').trim();
  if(ownVersion)current=current.replace(new RegExp(`\\s+\\(?v?${escapeRegExp(ownVersion)}\\)?$`),'').trim();
 }
 return current||base;
}
/** The leading run of digits and dots, without a leading "v"; null when the version does not start with a digit. */
export function normalizeSoftwareVersion(version:string|null):string|null{
 const match=/^v?(\d+(?:\.\d+)*)/i.exec(version?.normalize('NFKC').trim()??'');
 return match?match[1]:null;
}

export type StoredSoftware=SoftwareItem&{normalizedName:string;firstSeen:number};
export type SoftwareChange={change:'installed'|'updated'|'removed';name:string;normalizedName:string;versionFrom:string|null;versionTo:string|null;publisher:string|null;architecture:SoftwareArchitecture|null;scope:SoftwareScope};
/**
 * The changes from the stored list to a new report: a new identity is
 * installed, a missing one removed, the same identity with another version
 * updated. A removed and an installed entry with the same normalized name,
 * scope and architecture are one update (for example a new MSI product code).
 * A truncated report records no removals. Also returns the first_seen of
 * every new entry (kept for the same identity and for a paired update).
 */
export function diffSoftware(previous:readonly StoredSoftware[],next:readonly SoftwareItem[],truncated:boolean,now:number):{changes:SoftwareChange[];firstSeen:Map<string,number>}{
 const before=new Map(previous.map(item=>[softwareIdentity(item),item])),after=new Map(next.map(item=>[softwareIdentity(item),item]));
 const changes:SoftwareChange[]=[],firstSeen=new Map<string,number>();
 const installed:SoftwareItem[]=[],removed:StoredSoftware[]=[];
 for(const [identity,item] of after){
  const old=before.get(identity);
  if(!old){installed.push(item);continue;}
  firstSeen.set(identity,old.firstSeen);
  if(old.version!==item.version)changes.push({change:'updated',name:item.name,normalizedName:normalizeSoftwareName(item.name,item.version),versionFrom:old.version,versionTo:item.version,publisher:item.publisher,architecture:item.architecture,scope:item.scope});
 }
 if(!truncated)for(const [identity,item] of before)if(!after.has(identity))removed.push(item);
 const pairKey=(item:{normalizedName:string;scope:string;architecture:string|null})=>`${item.normalizedName}\u0000${item.scope}\u0000${item.architecture??''}`;
 const removedByName=new Map<string,StoredSoftware[]>();
 for(const item of removed){const key=pairKey(item);removedByName.set(key,[...(removedByName.get(key)??[]),item]);}
 for(const item of installed){
  const normalizedName=normalizeSoftwareName(item.name,item.version),candidates=removedByName.get(pairKey({normalizedName,scope:item.scope,architecture:item.architecture}));
  const old=candidates?.shift();
  if(old){
   firstSeen.set(softwareIdentity(item),old.firstSeen);
   changes.push({change:'updated',name:item.name,normalizedName,versionFrom:old.version,versionTo:item.version,publisher:item.publisher,architecture:item.architecture,scope:item.scope});
  }else{
   firstSeen.set(softwareIdentity(item),now);
   changes.push({change:'installed',name:item.name,normalizedName,versionFrom:null,versionTo:item.version,publisher:item.publisher,architecture:item.architecture,scope:item.scope});
  }
 }
 for(const list of removedByName.values())for(const item of list)changes.push({change:'removed',name:item.name,normalizedName:item.normalizedName,versionFrom:item.version,versionTo:null,publisher:item.publisher,architecture:item.architecture,scope:item.scope});
 return {changes,firstSeen};
}

/** The tokens of a fleet search: split on spaces, at most 10 tokens of at most 100 characters, lower case. */
export function softwareSearchTokens(query:string|null|undefined):string[]{
 return (query??'').normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean).slice(0,10).map(token=>token.slice(0,100));
}
/** True when every token is a case-insensitive substring of the name, publisher or version. */
export function softwareMatches(item:{name:string;publisher:string|null;version:string|null},tokens:readonly string[]):boolean{
 const fields=[item.name,item.publisher??'',item.version??''].map(value=>value.normalize('NFKC').toLowerCase());
 return tokens.every(token=>fields.some(field=>field.includes(token)));
}
