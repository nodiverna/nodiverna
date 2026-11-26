// The autostart list of agent 4.11.0 (docs/v3-health-signals.md): the report
// format of POST /api/agent/autostart, the entry ID and the checksum the agent
// computes the same way (NativeAutostartInventory.cs), and when an entry counts
// as suspicious. Pure, without server imports: the ingest (lib/server/devices/autostart.ts),
// the demo data, the views and the tests use it.
import {z} from 'zod';
import type {AutostartCategory} from './types';
import {sha256Hex} from './driver-inventory';

export const maxAutostartItems=2000;
export const autostartCategories:readonly AutostartCategory[]=['run','run-once','startup-folder','winlogon','service','task'];
export type AutostartSignature='valid'|'invalid'|'unsigned'|'unknown';
export type AutostartItem={id:string;category:AutostartCategory;scope:'machine'|'user';location:string;name:string;command:string;target:string|null;signature:AutostartSignature;signer:string|null;publisher:string|null;microsoft:boolean;userPath:boolean};
export type AutostartReport={checksum:string;count:number;truncated:boolean;items:AutostartItem[]};

// A user folder must arrive scrubbed (X:\Users\… or X:\Documents and Settings\…,
// with \ or /), and no SID of a user may appear.
const userFolder=/[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/](?!…(?:[\\/]|$|["'\s]))[^\\/"'\s]/i;
const userSid=/S-1-5-21-\d+/i;
const scrubbed=(value:string)=>!userFolder.test(value)&&!userSid.test(value);
const path=(max:number,min=0)=>z.string().min(min).max(max).refine(scrubbed,'unscrubbed user path');
const autostartItem=z.object({
 id:z.string().regex(/^[0-9a-f]{64}$/),category:z.enum(['run','run-once','startup-folder','winlogon','service','task']),scope:z.enum(['machine','user']),
 location:path(1024,1),name:path(256,1),command:path(1024),target:path(1024).nullable(),
 signature:z.enum(['valid','invalid','unsigned','unknown']),signer:z.string().max(256).nullable(),publisher:z.string().max(256).nullable(),microsoft:z.boolean(),userPath:z.boolean()
}).strict();
/** The body of POST /api/agent/autostart without serverId: strict, at most 2000 items, count and truncated consistent, unique IDs. */
export const autostartReport=z.object({
 checksum:z.string().regex(/^[0-9a-f]{64}$/),count:z.number().int().min(0).max(1_000_000),truncated:z.boolean(),items:z.array(autostartItem).max(maxAutostartItems)
}).strict().superRefine((report,context)=>{
 if(report.count<report.items.length)context.addIssue({code:'custom',path:['count'],message:'count is smaller than the list.'});
 if(report.truncated!==(report.count>report.items.length))context.addIssue({code:'custom',path:['truncated'],message:'truncated does not match count.'});
 const seen=new Set<string>();
 report.items.forEach((item,index)=>{if(seen.has(item.id))context.addIssue({code:'custom',path:['items',index,'id'],message:'duplicate entry.'});seen.add(item.id);});
});

/** The entry ID: SHA-256 (lower-case hex) of JSON.stringify([category,scope,location,name,command]) with the masked command. */
export const autostartId=(item:Pick<AutostartItem,'category'|'scope'|'location'|'name'|'command'>)=>sha256Hex(JSON.stringify([item.category,item.scope,item.location,item.name,item.command]));
const ordinal=(a:string,b:string)=>a<b?-1:a>b?1:0;
/**
 * The canonical JSON the checksum covers: an array of
 * [id,category,scope,location,name,command,target,signature,signer,publisher,microsoft,userPath]
 * arrays, sorted ordinally by id.
 */
export function canonicalAutostartJson(items:readonly AutostartItem[]):string{
 return JSON.stringify([...items].sort((a,b)=>ordinal(a.id,b.id)).map(item=>[item.id,item.category,item.scope,item.location,item.name,item.command,item.target,item.signature,item.signer,item.publisher,item.microsoft,item.userPath]));
}
export const autostartChecksum=(items:readonly AutostartItem[])=>sha256Hex(canonicalAutostartJson(items));
/** Suspicious: not signed, an invalid signature, or a target in a user profile or temp folder. */
export const autostartSuspicious=(item:Pick<AutostartItem,'signature'|'userPath'>)=>item.signature==='unsigned'||item.signature==='invalid'||item.userPath;
/** The tokens of a search, as for software and drivers. */
export function autostartSearchTokens(query:string|null|undefined):string[]{
 return (query??'').normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean).slice(0,10).map(token=>token.slice(0,100));
}
/** True when every token is a substring of the name, target, command or signer. */
export function autostartMatches(item:Pick<AutostartItem,'name'|'target'|'command'|'signer'|'publisher'>,tokens:readonly string[]):boolean{
 const fields=[item.name,item.target??'',item.command,item.signer??'',item.publisher??''].map(value=>value.normalize('NFKC').toLowerCase());
 return tokens.every(token=>fields.some(field=>field.includes(token)));
}
