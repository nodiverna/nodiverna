import {featureWriteGuard} from '../identity/feature-authorization';
import {z} from 'zod';
import {now,guid,HttpError,log} from '../context';
import {issueFields} from '../errors/issues';
import {customerAccessGuard,requireDevice,principal,devicePermissionGuard} from '../identity/access';
import type {Viewer} from '../../types';
import {takeChannelSlot,deviceActive} from '../agent/agent-admission';
import {commitAll,db,sql} from '../db';
const windowsPath=z.string().trim().min(4).max(1024).refine(p=>/^[A-Za-z]:\\/.test(p)&&!p.includes('\0')&&!p.split('\\').includes('..')&&!/[?:*]/.test(p.slice(2))&&!/^[A-Za-z]:\\ProgramData\\ServerDesk(?:\\|$)/i.test(p),'Absoluter lokaler Windows-Pfad ohne ADS, Wildcards, .. oder Agent-Konfiguration erforderlich.');
const MAX_EXCLUDE_STARS=16,MAX_EXCLUDE_PART=120,MAX_EXCLUDE_WILD_PART=32;
// Bounds the work per exclude: few `*`, short parts between two of them, and
// every part with `?` (head, tail, whole pattern or middle) within one 32-bit
// Shift-And word, because such parts are compared character by character.
function boundedExclude(pattern:string){const parts=pattern.split('*');return parts.length-1<=MAX_EXCLUDE_STARS&&parts.every((p,i)=>p.includes('?')?p.length<=MAX_EXCLUDE_WILD_PART:i===0||i===parts.length-1||p.length<=MAX_EXCLUDE_PART);}
export const driftPolicySchema=z.object({enabled:z.boolean().default(false),paths:z.array(z.object({path:windowsPath,recursive:z.boolean().default(true),includeText:z.boolean().default(false),extensions:z.array(z.string().regex(/^\.[A-Za-z0-9_-]{1,20}$/)).max(30).default([])}).strict()).max(20).default([]),excludes:z.array(z.string().min(1).max(250).refine(boundedExclude,`Ausschluss mit höchstens ${MAX_EXCLUDE_STARS} * und höchstens ${MAX_EXCLUDE_PART} Zeichen zwischen zwei * angeben; ein Abschnitt mit ? hat höchstens ${MAX_EXCLUDE_WILD_PART} Zeichen.`)).max(100).default(['*.log','*.tmp','*.cache']),registry:z.array(z.object({path:z.string().max(512).regex(/^(HKLM|HKCU|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER):?\\[^\0]+$/i),names:z.array(z.string().max(120)).max(100).default([]),includeValues:z.boolean().default(false)}).strict()).max(20).default([]),config:z.array(z.enum(['services','roles','network','firewall','localGroups','tasks','autostart'])).max(7).default([]),includeConfigValues:z.boolean().default(false),intervalSeconds:z.number().int().min(60).max(86400).default(300),maxFiles:z.number().int().min(1).max(5000).default(1000),maxFileBytes:z.number().int().min(1).max(1073741824).default(10485760),maxTextBytes:z.number().int().min(0).max(16384).default(8192),maxDurationSeconds:z.number().int().min(5).max(300).default(30),retentionDays:z.number().int().min(1).max(90).default(30)}).strict().superRefine((p,c)=>{if(p.enabled&&!p.paths.length&&!p.registry.length&&!p.config.length)c.addIssue({code:'custom',message:'Mindestens eine Datenquelle auswählen.'});for(let i=0;i<p.paths.length;i++)if(p.paths[i].includeText&&!p.paths[i].extensions.length)c.addIssue({code:'custom',path:['paths',i,'extensions'],message:'Für Textinhalte ausdrücklich Dateiendungen auswählen.'});});
export type DriftPolicy=z.infer<typeof driftPolicySchema>;
const entrySchema=z.object({key:z.string().min(1).max(1024),kind:z.enum(['file','directory','registry','config']),path:z.string().min(1).max(1024),hash:z.string().regex(/^[a-f0-9]{64}$/i),size:z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).optional(),modifiedAt:z.union([z.number().finite(),z.string().max(80)]).optional(),text:z.string().max(16384).nullable().optional().transform(v=>v??undefined)}).strict();
export type DriftEntry=z.infer<typeof entrySchema>;
export const driftReportSchema=z.object({policyId:z.guid(),version:z.number().int().min(1),scanId:z.guid(),at:z.number().int().positive(),complete:z.boolean(),entries:z.array(entrySchema).max(5000),errors:z.array(z.string().max(1000)).max(100).default([]),overflow:z.boolean().default(false)}).strict();
type Change={key:string;path:string;kind:DriftEntry['kind'];change:'added'|'removed'|'modified'|'renamed';before?:DriftEntry;after?:DriftEntry;textDiff?:{lines:{type:'same'|'added'|'removed';text:string}[];truncated:boolean};oldPath?:string};
const parse=<T>(s:string)=>JSON.parse(s) as T;
// Compare inventories independently of collection order and JSON property order.
// Consecutive scans of the same state form one event; a recovery or baseline
// change starts another event, even when its file inventory is unchanged.
function canonical(value:unknown):string{if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value);}
function orderedEntries(entries:DriftEntry[]){return [...entries].sort((a,b)=>a.key.localeCompare(b.key));}
const norm=(s:string)=>s.replace(/\//g,'\\').replace(/\\+$/,'').toLowerCase();
// Case folding of a non-unicode RegExp with flag i (ECMAScript Canonicalize):
// upper case per code unit, unless that yields several units or maps a
// non-ASCII unit to ASCII. Keeps the results of the former case-insensitive regex.
function fold(s:string){
 if(/^[\x20-\x7e]*$/.test(s))return s.toUpperCase();
 let out='';for(let i=0;i<s.length;i++){const ch=s[i],upper=ch.toUpperCase();out+=upper.length!==1||ch.charCodeAt(0)>=128&&upper.charCodeAt(0)<128?ch:upper;}return out;
}
// `.` of the former RegExp never matched line terminators; neither do `*`/`?`.
const lineTerminator=(c:number)=>c===10||c===13||c===0x2028||c===0x2029;
// `*` and `?` are the only wildcards; every other character is literal. A glob
// is split at its `*` into a head, the middle parts and a tail. A part with `?`
// carries Shift-And bit masks (one bit per character, `?` matches every unit
// except a line terminator), so finding it costs one pass over the path.
type Part={text:string;wild:boolean;words:number;table:Uint32Array;other:Map<number,Uint32Array>;any:Uint32Array;none:Uint32Array;literals:Int32Array};
type Glob={whole:Part|null;head:Part;middle:Part[];tail:Part;memoStamp:Int32Array;memoFrom:Int32Array;memoAt:Int32Array};
const NO_MASK=new Uint32Array(0);
function part(text:string):Part{
 if(!text.includes('?'))return {text,wild:false,words:0,table:NO_MASK,other:new Map(),any:NO_MASK,none:NO_MASK,literals:new Int32Array(0)};
 const words=Math.ceil(text.length/32),any=new Uint32Array(words),none=new Uint32Array(words),other=new Map<number,Uint32Array>();
 for(let k=0;k<text.length;k++)if(text.charCodeAt(k)===63)any[k>>>5]|=1<<(k&31);
 for(let k=0;k<text.length;k++){const c=text.charCodeAt(k);if(c===63)continue;let mask=other.get(c);if(!mask){mask=lineTerminator(c)?new Uint32Array(words):Uint32Array.from(any);other.set(c,mask);}mask[k>>>5]|=1<<(k&31);}
 // ASCII masks in one flat table (128 × words) keep the scan loop allocation-free.
 const table=new Uint32Array(128*words);for(let c=0;c<128;c++)table.set(other.get(c)??(lineTerminator(c)?none:any),c*words);
 const literals=Int32Array.from([...text].map((_,k)=>k).filter(k=>text.charCodeAt(k)!==63));
 return {text,wild:true,words,table,other,any,none,literals};
}
function compileGlob(pattern:string):Glob{
 const parts=fold(pattern).split('*'),whole=parts.length===1,middle=whole?[]:parts.slice(1,-1).filter(Boolean).map(part);
 return {whole:whole?part(parts[0]):null,head:part(whole?'':parts[0]),middle,tail:part(whole?'':parts.at(-1)!),memoStamp:new Int32Array(middle.length),memoFrom:new Int32Array(middle.length),memoAt:new Int32Array(middle.length)};
}
// Index of the next line terminator at or after each position (a `*` may not
// span one); null for the usual path without any.
function lineBreaks(text:string){
 for(let i=0;i<text.length;i++)if(lineTerminator(text.charCodeAt(i))){const breaks=new Int32Array(text.length+1);let next=text.length;breaks[text.length]=next;for(let j=text.length-1;j>=0;j--){if(lineTerminator(text.charCodeAt(j)))next=j;breaks[j]=next;}return breaks;}
 return null;
}
// Is the part at `at`? A `?` only has to avoid a line terminator, which the
// path's break index answers per terminator, so a wild part compares just its
// literal positions (the meter still charges it per character).
function partAt(s:string,at:number,p:Part,breaks:Int32Array|null){
 if(!p.wild)return s.startsWith(p.text,at);
 const end=at+p.text.length;
 if(breaks)for(let j=breaks[at];j<end;j=breaks[j+1])if(p.text.charCodeAt(j-at)===63)return false;
 for(const k of p.literals)if(p.text.charCodeAt(k)!==s.charCodeAt(at+k))return false;return true;
}
// Leftmost start >= from of a part with `?`, or -1: Shift-And over the path,
// O(path length × ⌈part length / 32⌉).
function nextWild(s:string,p:Part,from:number){
 const length=p.text.length,words=p.words,top=words-1,bit=(length-1)&31,table=p.table,n=s.length;
 const masks=(c:number)=>p.other.get(c)??(lineTerminator(c)?p.none:p.any);
 if(!top){let state=0;for(let i=from;i<n;i++){const c=s.charCodeAt(i);state=(state<<1|1)&(c<128?table[c]:masks(c)[0]);if(state>>>bit&1)return i-length+1;}return -1;}
 const state=new Uint32Array(words);
 for(let i=from;i<n;i++){
  const c=s.charCodeAt(i),other=c<128?null:masks(c),base=c*words;
  for(let w=top;w>=0;w--)state[w]=(state[w]<<1|(w?state[w-1]>>>31:1))&(other?other[w]:table[base+w]);
  if(state[top]>>>bit&1)return i-length+1;
 }
 return -1;
}
// Work done by one compiled matcher: loop steps, compared and scanned
// characters. ingestDrift caps the sum per report (DRIFT_MATCH_BUDGET).
// Invariant: every metered operation costs O(1) per unit charged. A JS loop
// over characters is charged per character (and per Shift-And word); only a
// native compare (startsWith/indexOf on a literal) may be charged per 16
// characters. A new loop that is not charged this way breaks the bound.
type Meter={work:number};
const partCost=(p:Part)=>1+(p.wild?p.text.length:p.text.length>>>4);
// Leftmost start >= from of middle part k. The answer for `from` also holds for
// every later `from` up to that start, so queries of one entry, asked with
// ascending offsets, scan each region of the path at most once per part.
function nextPart(g:Glob,k:number,s:string,from:number,stamp:number,meter:Meter){
 meter.work++;
 if(g.memoStamp[k]===stamp&&g.memoFrom[k]<=from&&(g.memoAt[k]<0||from<=g.memoAt[k]))return g.memoAt[k];
 const p=g.middle[k],at=p.wild?nextWild(s,p,from):s.indexOf(p.text,from);
 meter.work+=(at<0?s.length-from:at+p.text.length-from)*(p.wild?p.words:1);
 g.memoStamp[k]=stamp;g.memoFrom[k]=from;g.memoAt[k]=at;return at;
}
// Does the glob match the suffix of `s` at any of the ascending offsets? Head
// at the suffix start, tail at the end, each middle part at its leftmost
// position after the previous one; the leftmost choice never loses a match, so
// there is no backtracking, and the shared memo keeps nested candidates cheap.
function globMatches(g:Glob,s:string,breaks:Int32Array|null,offsets:number[],stamp:number,meter:Meter){
 const n=s.length,gap=(at:number)=>breaks?breaks[at]:n;meter.work++;
 if(g.whole){const whole=g.whole;meter.work+=offsets.length;return offsets.some(o=>n-o===whole.text.length&&(meter.work+=partCost(whole),partAt(s,o,whole,breaks)));}
 const end=n-g.tail.text.length;meter.work+=partCost(g.tail);if(end<0||!partAt(s,end,g.tail,breaks))return false;
 // With an empty head the glob starts with `*`: a match at an offset is also a
 // match at any smaller offset with no line terminator in between, so after a
 // failed offset the later ones up to the next line terminator fail as well.
 const leadingStar=!g.head.text.length;let failed=-1;
 for(const o of offsets){
  meter.work++;
  if(leadingStar&&failed>=0&&gap(failed)>=o)continue;
  meter.work+=partCost(g.head);if(end<o+g.head.text.length||!partAt(s,o,g.head,breaks))continue;
  let cursor=o+g.head.text.length,found=true;
  for(let k=0;k<g.middle.length;k++){const length=g.middle[k].text.length,at=nextPart(g,k,s,cursor,stamp,meter);if(at<0||at>end-length||at>gap(cursor)){found=false;break;}cursor=at+length;}
  if(found&&gap(cursor)>=end)return true;
  failed=o;
 }
 return false;
}
const PROGRAM_DATA='c:\\programdata\\serverdesk';
export type DriftMatcher={allowed(e:DriftEntry):boolean;mayKeepText(e:DriftEntry):boolean;work():number};
// Normalize policy paths, registry rules and excludes once per ingest; the
// per-entry checks then use only string comparisons and the linear glob test.
export function compileDriftPolicy(policy:DriftPolicy):DriftMatcher{
 const categories=policy.config.map(c=>c.toLowerCase());
 const registry=policy.registry.map(r=>{const path=norm(r.path);return {path,prefix:path+'\\',exact:!r.names.length||r.names.includes(''),anyChild:!r.names.length,names:new Set(r.names.map(name=>path+'\\'+name.toLowerCase())),includeValues:r.includeValues};});
 const paths=policy.paths.map(p=>{const path=norm(p.path);return {path,prefix:path+'\\',recursive:p.recursive,includeText:p.includeText,extensions:p.extensions.map(ext=>ext.toLowerCase()),offset:p.path.replace(/\\+$/,'').length+1};});
 // Excludes that fold to the same pattern match the same paths; test each once.
 const excludes=[...new Set(policy.excludes.map(fold))].map(compileGlob),meter:Meter={work:0};let stamp=0;
 function allowed(e:DriftEntry){
  if(e.kind==='config'){const key=e.key.toLowerCase(),path=e.path.toLowerCase().replace(/\\/g,'/');return categories.some(category=>key===`config:${category}`&&path===category||key.startsWith(`config:${category}:`)&&path.startsWith(category+'/'));}
  if(e.kind==='registry'){const path=norm(e.path);return registry.some(r=>path===r.path&&r.exact||path.startsWith(r.prefix)&&(r.anyChild||r.names.has(path)));}
  const path=norm(e.path);if(!paths.some(p=>path===p.path||path.startsWith(p.prefix)&&(p.recursive||!path.slice(p.prefix.length).includes('\\'))))return false;
  if(!excludes.length)return true;
  // An exclude matches the full path, the path relative to any containing
  // policy path, or the last segment of either. All of them are suffixes of the
  // full path (a relative path's last segment is itself or the full path's), so
  // they are tested as ascending offsets into the path, folded once.
  const n=e.path.length,offsets=new Set<number>([0,e.path.lastIndexOf('\\')+1]);for(const p of paths)if(path.startsWith(p.prefix))offsets.add(Math.min(p.offset,n));
  const s=fold(e.path),breaks=lineBreaks(s),ordered=[...offsets].sort((a,b)=>a-b),entryStamp=++stamp;
  meter.work+=ordered.length+2*n;return !excludes.some(g=>globMatches(g,s,breaks,ordered,entryStamp,meter));
 }
 function mayKeepText(e:DriftEntry){
  if(e.kind==='config')return policy.includeConfigValues&&allowed(e);
  if(e.kind==='registry'){const path=norm(e.path);return registry.some(r=>r.includeValues&&(path===r.path||path.startsWith(r.prefix)));}
  if(e.kind!=='file')return false;const path=norm(e.path);if(path===PROGRAM_DATA||path.startsWith(PROGRAM_DATA+'\\'))return false;
  return paths.some(p=>p.includeText&&(path===p.path||path.startsWith(p.prefix))&&(!p.extensions.length||p.extensions.some(ext=>path.endsWith(ext))));
 }
 return {allowed,mayKeepText,work:()=>meter.work};
}
function compactEntry(e:DriftEntry){const metadata={...e};delete metadata.text;return metadata;}
// Limit quadratic work to small changed regions; large edits fall back to a
// bounded replacement block and explicitly mark the displayed diff as truncated.
export function textChanges(before:string,after:string){
 const a=before.replace(/\r\n/g,'\n').split('\n'),b=after.replace(/\r\n/g,'\n').split('\n'),max=250;let prefix=0;while(prefix<Math.min(a.length,b.length)&&a[prefix]===b[prefix])prefix++;let suffix=0;while(suffix<Math.min(a.length-prefix,b.length-prefix)&&a[a.length-suffix-1]===b[b.length-suffix-1])suffix++;
 const lines:{type:'same'|'added'|'removed';text:string}[]=[];for(let i=Math.max(0,prefix-3);i<prefix;i++)lines.push({type:'same',text:a[i]});const aa=a.slice(prefix,a.length-suffix),bb=b.slice(prefix,b.length-suffix),bounded=(aa.length+1)*(bb.length+1)<=90000;
 if(bounded){const columns=bb.length+1,table=new Uint16Array((aa.length+1)*columns);for(let i=aa.length-1;i>=0;i--)for(let j=bb.length-1;j>=0;j--)table[i*columns+j]=aa[i]===bb[j]?1+table[(i+1)*columns+j+1]:Math.max(table[(i+1)*columns+j],table[i*columns+j+1]);let i=0,j=0;while(i<aa.length||j<bb.length){if(i<aa.length&&j<bb.length&&aa[i]===bb[j]){lines.push({type:'same',text:aa[i]});i++;j++;}else if(i<aa.length&&(j===bb.length||table[(i+1)*columns+j]>=table[i*columns+j+1]))lines.push({type:'removed',text:aa[i++]});else lines.push({type:'added',text:bb[j++]});}}
 else{for(const line of aa)lines.push({type:'removed',text:line});for(const line of bb)lines.push({type:'added',text:line});}
 for(const line of b.slice(b.length-suffix,b.length-suffix+3))lines.push({type:'same',text:line});return {lines:lines.slice(0,max),truncated:!bounded||lines.length>max};
}
export function diffEntries(baseline:DriftEntry[],current:DriftEntry[]){
 const before=new Map(baseline.map(e=>[e.key,e])),after=new Map(current.map(e=>[e.key,e])),changes:Change[]=[],removed:DriftEntry[]=[],added:DriftEntry[]=[];
 for(const e of baseline){const n=after.get(e.key);if(!n){removed.push(e);continue;}if(e.hash!==n.hash||e.size!==n.size||e.modifiedAt!==n.modifiedAt){changes.push({key:e.key,path:n.path,kind:n.kind,change:'modified',before:compactEntry(e),after:compactEntry(n),...(e.text!==undefined&&n.text!==undefined&&e.text!==n.text?{textDiff:textChanges(e.text,n.text)}:{})});}}
 for(const e of current)if(!before.has(e.key))added.push(e);
 // A rename is inferred only for an unambiguous one-to-one identical file hash.
 // This is not an assertion about who made the change.
 // Hash maps keep this linear: only the single removed file of a hash looks at
 // the added files of that hash, so each bucket is scanned at most once.
 const removedFiles=new Map<string,number>(),addedFiles=new Map<string,DriftEntry[]>();
 for(const e of removed)if(e.kind==='file')removedFiles.set(e.hash,(removedFiles.get(e.hash)??0)+1);
 for(const e of added)if(e.kind==='file'){const bucket=addedFiles.get(e.hash);if(bucket)bucket.push(e);else addedFiles.set(e.hash,[e]);}
 const used=new Set<string>();for(const old of removed){let match:DriftEntry|undefined,count=0;if(old.kind==='file'&&removedFiles.get(old.hash)===1)for(const e of addedFiles.get(old.hash)??[])if(!used.has(e.key)){match=e;count++;}if(match&&count===1){const n=match;used.add(n.key);changes.push({key:n.key,path:n.path,oldPath:old.path,kind:n.kind,change:'renamed',before:compactEntry(old),after:compactEntry(n)});}else changes.push({key:old.key,path:old.path,kind:old.kind,change:'removed',before:compactEntry(old)});}
 for(const e of added)if(!used.has(e.key))changes.push({key:e.key,path:e.path,kind:e.kind,change:'added',after:compactEntry(e)});return changes;
}
export async function getDriftPolicy(serverId:string){
 const row=await db().one<{id:string;version:number;enabled:number;policy:string}>(sql`SELECT id,version,enabled,policy FROM drift_policies WHERE server_id = ${serverId}`);if(!row)return {enabled:false};return {policyId:row.id,version:row.version,...parse<DriftPolicy>(row.policy),enabled:!!row.enabled};
}
async function policyFor(v:Viewer,serverId:string,raw:unknown){await requireDevice(v,serverId,'drift.manage');const parsed=driftPolicySchema.safeParse(raw);if(!parsed.success)throw new HttpError('apiError.drift.invalidPolicy',{fields:issueFields(parsed.error.issues,4)});if(parsed.data.includeConfigValues||parsed.data.paths.some(p=>p.includeText)||parsed.data.registry.some(r=>r.includeValues))await requireDevice(v,serverId,'drift.contents');return parsed.data;}
function driftWriteGuard(v:Viewer,serverId:string,policy?:DriftPolicy){
 const permissions:('drift.manage'|'drift.contents')[]=['drift.manage'];
 if(policy&&(policy.includeConfigValues||policy.paths.some(p=>p.includeText)||policy.registry.some(r=>r.includeValues)))permissions.push('drift.contents');
 const guards=permissions.map(permission=>devicePermissionGuard(sql`drift_actor.server_id`,sql`drift_actor.principal`,permission));
 return featureWriteGuard(v,sql`EXISTS (SELECT 1 FROM (SELECT ${serverId}::text AS server_id, ${principal(v)}::text AS principal) drift_actor WHERE ${sql.join(guards.map(guard=>sql`(${guard})`),sql` AND `)})`);
}
export async function setDriftPolicy(v:Viewer,serverId:string,raw:unknown){
 const policy=await policyFor(v,serverId,raw);
 const old=await db().one<{id:string;version:number;created_at:number}>(sql`SELECT id,version,created_at FROM drift_policies WHERE server_id = ${serverId}`),id=old?.id??crypto.randomUUID(),version=(old?.version??0)+1,at=now();
 const authorization=driftWriteGuard(v,serverId,policy);
 // Policy changes can schedule continuing SYSTEM collection. Recheck the
 // current actor's scope in the committing statement, including content rights.
 const saved=await db().one<{id:string;version:number}>(sql`INSERT INTO drift_policies (server_id,id,version,enabled,policy,created_at,updated_at,updated_by) SELECT ${serverId},${id},${version},${policy.enabled?1:0},${JSON.stringify(policy)},${old?.created_at??at},${at},${principal(v)} WHERE ${authorization} ON CONFLICT(server_id) DO UPDATE SET version = drift_policies.version + 1,enabled = excluded.enabled,policy = excluded.policy,updated_at = excluded.updated_at,updated_by = excluded.updated_by WHERE EXISTS (SELECT 1 FROM servers WHERE id=${serverId} AND revoked=0) RETURNING id,version`);
 if(!saved)throw new HttpError('apiError.drift.deviceOrRightChanged');
 await log(v.label,'Drift-Richtlinie geändert',`Version ${saved.version}`,serverId);return {policyId:saved.id,version:saved.version,...policy};
}
export async function setDriftEnabled(v:Viewer,serverId:string,enabled:unknown,expectedVersion:unknown){
 if(typeof enabled!=='boolean'||typeof expectedVersion!=='number'||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw new HttpError('apiError.drift.activationInput');
 await requireDevice(v,serverId,'drift.manage');const d=db(),row=await d.one<{id:string;version:number;enabled:number;policy:string}>(sql`SELECT id,version,enabled,policy FROM drift_policies WHERE server_id = ${serverId}`);
 if(!row)throw new HttpError('apiError.drift.saveSourcesFirst');
 if(row.version!==expectedVersion)throw new HttpError('apiError.drift.policyChanged');
 let stored:DriftPolicy;try{stored=parse<DriftPolicy>(row.policy);}catch{throw new HttpError('apiError.drift.policyNeedsFix');}
 if(!stored||typeof stored!=='object'||Array.isArray(stored))throw new HttpError('apiError.drift.policyNeedsFix');
 const includesContents=stored.includeConfigValues||Array.isArray(stored.paths)&&stored.paths.some(p=>p.includeText)||Array.isArray(stored.registry)&&stored.registry.some(r=>r.includeValues);
 if(enabled){
  if(!driftPolicySchema.safeParse({...stored,enabled:true}).success)throw new HttpError('apiError.drift.saveValidSourcesFirst');
  if(includesContents)await requireDevice(v,serverId,'drift.contents');
 }
 const authorization=driftWriteGuard(v,serverId,enabled&&includesContents?stored:undefined);
 // Pausing must not create a new policy version or invalidate its baselines.
 // Fence the exact saved policy and live rights so this small change cannot
 // overwrite a concurrent policy edit or cross device/permission revocation.
 const saved=await d.one<{id:string;version:number;enabled:number}>(sql`UPDATE drift_policies SET enabled=${enabled?1:0},policy=jsonb_set(policy::jsonb,'{enabled}',${enabled?'true':'false'}::jsonb)::text,updated_at=CASE WHEN enabled<>${enabled?1:0} THEN ${now()} ELSE updated_at END,updated_by=CASE WHEN enabled<>${enabled?1:0} THEN ${principal(v)} ELSE updated_by END WHERE server_id=${serverId} AND id=${row.id} AND version=${row.version} AND enabled=${row.enabled} AND policy=${row.policy} AND EXISTS (SELECT 1 FROM servers WHERE id=${serverId} AND revoked=0) AND (${authorization}) RETURNING id,version,enabled`);
 if(!saved)throw new HttpError('apiError.drift.devicePolicyRightChanged');
 if(!!row.enabled!==enabled)await log(v.label,enabled?'Drift-Monitoring aktiviert':'Drift-Monitoring pausiert',`Version ${saved.version}`,serverId);
 return {policyId:saved.id,version:saved.version,enabled:!!saved.enabled};
}
export async function applyGroupDriftPolicy(v:Viewer,groupId:string,raw:unknown,confirm:unknown){
 if(!guid(groupId)||confirm!==true)throw new HttpError('apiError.drift.groupAndConfirm');const d=db(),visible=customerAccessGuard(sql`device_groups.customer_id`,sql`${principal(v)}`),group=await d.one<{id:string;name:string}>(sql`SELECT id,name FROM device_groups WHERE id = ${groupId} AND ${visible}`);if(!group)throw new HttpError('apiError.group.deviceGroupNotFound');
 // A group includes its descendants. Multiple direct branch memberships still
 // represent one target, including when enforcing the group action limit.
 const members=await d.query<{server_id:string}>(sql`SELECT DISTINCT m.server_id FROM device_group_ancestors a JOIN device_group_members m ON m.group_id = a.group_id JOIN servers s ON s.id = m.server_id WHERE a.ancestor_id = ${groupId} AND s.revoked = 0 ORDER BY m.server_id LIMIT 101`).then(results=>({results}));if(!members.results.length)throw new HttpError('apiError.drift.groupNoApprovedDevices');if(members.results.length>100)throw new HttpError('apiError.drift.groupTooLarge');
 let policy:DriftPolicy|undefined;for(const member of members.results)policy=await policyFor(v,member.server_id,raw);const at=now(),oldRows=await d.query<{server_id:string;id:string;version:number;created_at:number}>(sql`SELECT server_id,id,version,created_at FROM drift_policies WHERE server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(members.results.map(m=>m.server_id))}::jsonb))`).then(results=>({results})),oldMap=new Map(oldRows.results.map(r=>[r.server_id,r]));
 // Recheck the effective group at commit, not the former direct membership:
 // a device or its containing subtree may have moved while rights were read.
 const results=await commitAll(members.results.map(m=>{const old=oldMap.get(m.server_id),authorization=driftWriteGuard(v,m.server_id,policy!);return sql`INSERT INTO drift_policies (server_id,id,version,enabled,policy,created_at,updated_at,updated_by) SELECT ${m.server_id},${old?.id??crypto.randomUUID()},${(old?.version??0)+1},${policy!.enabled?1:0},${JSON.stringify(policy)},${old?.created_at??at},${at},${principal(v)} WHERE ${authorization} AND EXISTS (SELECT 1 FROM device_group_members membership JOIN device_group_ancestors ancestry ON ancestry.group_id = membership.group_id WHERE membership.server_id=${m.server_id} AND ancestry.ancestor_id=${groupId}) ON CONFLICT(server_id) DO UPDATE SET version = drift_policies.version + 1,enabled = excluded.enabled,policy = excluded.policy,updated_at = excluded.updated_at,updated_by = excluded.updated_by WHERE EXISTS (SELECT 1 FROM servers WHERE id=${m.server_id} AND revoked=0)`;}));
 const deviceIds=members.results.filter((_,index)=>results[index].rowCount).map(m=>m.server_id);if(!deviceIds.length)throw new HttpError('apiError.drift.groupChanged');await log(v.label,'Drift-Richtlinie auf aktuelle Gruppenmitglieder angewandt',group.name,deviceIds);return {ok:true,deviceIds,count:deviceIds.length};
}
const DRIFT_INTERVAL_MS=30000;
// Matcher work units per report (see Meter: each unit is O(1), measured at
// about 2–7 ns): about 100 × a 5 000-entry report against 100 excludes, and
// enough for every exclude to scan every path once at the size limit.
export const DRIFT_MATCH_BUDGET=100_000_000;
const scanIdSchema=z.guid();
export async function ingestDrift(serverId:string,raw:unknown){
 // A retried, already stored scan is answered before any validation, policy or
 // throttle work, so a repeated upload stays cheap and never meets the 429.
 const scanId=raw&&typeof raw==='object'?(raw as {scanId?:unknown}).scanId:undefined;if(!scanIdSchema.safeParse(scanId).success)throw new HttpError('apiError.drift.invalidReport');
 const replay=await db().one<{id:string;state:string}>(sql`SELECT id,state FROM drift_reports WHERE server_id = ${serverId} AND (scan_id = ${scanId as string} OR last_scan_id = ${scanId as string}) LIMIT 1`);if(replay)return {ok:true,...replay};
 // At most one new report per device and window; the slot is taken atomically
 // (also across replicas) before the expensive parse and path checks, and stays
 // taken when the report is rejected later on.
 const time=now(),slot=await takeChannelSlot('drift:'+serverId,serverId,time,time-DRIFT_INTERVAL_MS,true);
 if(!slot){if(!await deviceActive(serverId))throw new HttpError('apiError.drift.notApproved');throw new HttpError('apiError.drift.intervalTooShort');}
 const parsed=driftReportSchema.safeParse(raw);if(!parsed.success)throw new HttpError('apiError.drift.invalidReport');const p=parsed.data,row=await db().one<{id:string;version:number;enabled:number;policy:string}>(sql`SELECT id,version,enabled,policy FROM drift_policies WHERE server_id = ${serverId}`);
 if(!row||!row.enabled)throw new HttpError('apiError.drift.monitoringOff');if(p.policyId!==row.id||p.version!==row.version)throw new HttpError('apiError.drift.policyReload');
 // A policy saved before the exclude limits existed is rejected clearly, not as a 500.
 const stored=driftPolicySchema.safeParse(parse(row.policy));if(!stored.success)throw new HttpError('apiError.drift.policyNeedsFix');const policy=stored.data;if(p.entries.length>policy.maxFiles)throw new HttpError('apiError.drift.fileLimit');
 // Every stored entry is at least {"key":K,"kind":"file","path":P,"hash":"<64>"}
 // plus a comma: 105 bytes besides the JSON strings K and P, whose UTF-8 bytes
 // are never fewer than their UTF-16 units. A report above this lower bound fails
 // the storage limit below anyway; rejecting it here keeps the input of the path
 // checks bounded.
 let storedLowerBound=1;for(const entry of p.entries)storedLowerBound+=JSON.stringify(entry.key).length+JSON.stringify(entry.path).length+105;if(storedLowerBound>800000)throw new HttpError('apiError.drift.storageLimit');
 const matcher=compileDriftPolicy(policy),keys=new Set<string>();let textBytes=0;const entries:DriftEntry[]=[];
 for(const entry of p.entries){if(keys.has(entry.key))throw new HttpError('apiError.drift.duplicateKey');keys.add(entry.key);if(!matcher.allowed(entry))throw new HttpError('apiError.drift.outsidePolicy');const e={...entry,hash:entry.hash.toLowerCase()};
  if(e.text!==undefined){const bytes=new TextEncoder().encode(e.text).byteLength;if(!matcher.mayKeepText(e)||bytes>policy.maxTextBytes)delete e.text;else textBytes+=bytes;}entries.push(e);
  // One entry adds a bounded amount of work, so checking after each entry caps
  // the whole report near the budget, whatever the policy and paths look like.
  if(matcher.work()>DRIFT_MATCH_BUDGET)throw new HttpError('apiError.drift.policyTooComplex');
 }
 if(textBytes>262144||new TextEncoder().encode(JSON.stringify(entries)).byteLength>800000)throw new HttpError('apiError.drift.storageLimit');
 // Race guard: a concurrent upload of the same scan may have been stored since
 // the early replay check; the unique (server_id,scan_id) index backs this up.
 const d=db(),existing=await d.one<{id:string;state:string}>(sql`SELECT id,state FROM drift_reports WHERE server_id = ${serverId} AND (scan_id = ${p.scanId} OR last_scan_id = ${p.scanId}) LIMIT 1`);if(existing)return {ok:true,...existing};
 entries.sort((a,b)=>a.key.localeCompare(b.key));
 const latest=await d.one<{id:string;policy_version:number;baseline_id:string|null;received_at:number;scanned_at:number;state:string;complete:number;entries:string;changes:string;errors:string;last_scan_id:string|null}>(sql`SELECT id,policy_version,baseline_id,received_at,scanned_at,state,complete,entries,changes,errors,last_scan_id FROM drift_reports WHERE server_id = ${serverId} ORDER BY received_at DESC,scanned_at DESC,id DESC LIMIT 1`);
 const baseline=await d.one<{id:string;entries:string}>(sql`SELECT id,entries FROM drift_baselines WHERE server_id = ${serverId} AND policy_version = ${row.version} ORDER BY created_at DESC,id DESC LIMIT 1`),complete=p.complete&&!p.overflow&&!p.errors.length,changes=baseline?diffEntries(parse<DriftEntry[]>(baseline.entries),entries):[],state=!complete?'error':!baseline?'baseline_missing':changes.length?'drifted':'in_sync',id=crypto.randomUUID(),receivedNow=now(),at=Math.max(receivedNow,(latest?.received_at??0)+1),scannedAt=Math.min(p.at,receivedNow+60000);
 // Incomplete scans never infer deleted files. Preserve useful additions/changes,
 // while marking coverage as incomplete and requiring a complete baseline.
 let safeChanges=complete?changes:changes.filter(c=>c.change!=='removed'&&c.change!=='renamed');const outputErrors=[...p.errors,...(p.overflow?['serverMessage.drift.watcherOverflow']:[])];if(new TextEncoder().encode(JSON.stringify(safeChanges)).byteLength>800000){safeChanges=safeChanges.map(c=>{const compact={...c};delete compact.textDiff;return compact;});outputErrors.push('serverMessage.drift.diffsTruncated');}if(new TextEncoder().encode(JSON.stringify(safeChanges)).byteLength>800000){safeChanges=safeChanges.slice(0,200);outputErrors.push('serverMessage.drift.changesLimited');}
 const same=latest&&latest.policy_version===row.version&&latest.baseline_id===(baseline?.id??null)&&latest.state===state&&!!latest.complete===complete&&canonical(orderedEntries(parse<DriftEntry[]>(latest.entries)))===canonical(entries)&&canonical(parse<Change[]>(latest.changes))===canonical(safeChanges)&&canonical(parse<string[]>(latest.errors).sort())===canonical([...outputErrors].sort());
 // An old retry must not make monitoring look freshly scanned, nor replace the
 // current comparison with an inventory collected before the latest scan.
 if(latest&&latest.policy_version===row.version&&scannedAt<latest.scanned_at)return {ok:true,id:latest.id,state:latest.state,ignored:true};
 const guard=sql`EXISTS (SELECT 1 FROM servers s JOIN drift_policies p ON p.server_id=s.id WHERE s.id=${serverId} AND s.revoked=0 AND p.id=${row.id} AND p.version=${row.version} AND p.enabled=1)`;
 const write=same?sql`UPDATE drift_reports SET received_at = GREATEST(received_at,${at}),scanned_at = GREATEST(scanned_at,${scannedAt}),first_scanned_at = COALESCE(first_scanned_at,scanned_at),scan_count = scan_count + 1,last_scan_id = ${p.scanId} WHERE id = ${latest.id} AND (last_scan_id IS NULL OR last_scan_id <> ${p.scanId}) AND ${guard}`:sql`INSERT INTO drift_reports (id,server_id,policy_version,baseline_id,scan_id,last_scan_id,received_at,scanned_at,first_scanned_at,scan_count,complete,state,entries,changes,errors) SELECT ${id},${serverId},${row.version},${baseline?.id??null},${p.scanId},${p.scanId},${at},${scannedAt},${scannedAt},1,${complete?1:0},${state},${JSON.stringify(entries)},${JSON.stringify(safeChanges)},${JSON.stringify(outputErrors)} WHERE ${guard} ON CONFLICT DO NOTHING`;
 await commitAll([write,sql`DELETE FROM drift_reports WHERE server_id = ${serverId} AND received_at < ${receivedNow-policy.retentionDays*86400000} AND id NOT IN (SELECT report_id FROM drift_baselines WHERE server_id = ${serverId})`,sql`DELETE FROM drift_reports WHERE server_id = ${serverId} AND id NOT IN (SELECT id FROM drift_reports WHERE server_id = ${serverId} ORDER BY received_at DESC,scanned_at DESC,id DESC LIMIT 200) AND id NOT IN (SELECT report_id FROM drift_baselines WHERE server_id = ${serverId})`]);
 if(!await d.one(sql`SELECT 1 AS current WHERE ${guard}`))throw new HttpError('apiError.drift.notApproved');
 const result=same?{id:latest.id,state}:await d.one<{id:string;state:string}>(sql`SELECT id,state FROM drift_reports WHERE server_id = ${serverId} AND scan_id = ${p.scanId} LIMIT 1`);return {ok:true,...result};
}
export async function acceptDriftBaseline(v:Viewer,serverId:string,reportId:string,confirm:unknown){
 await requireDevice(v,serverId,'drift.manage');if(!guid(reportId)||confirm!==true)throw new HttpError('apiError.drift.reportAndConfirm');const d=db(),report=await d.one<{id:string;complete:number;policy_version:number;current_version:number;entries:string;received_at:number;scanned_at:number}>(sql`SELECT r.*,p.version AS current_version FROM drift_reports r JOIN drift_policies p ON p.server_id = r.server_id WHERE r.id = ${reportId} AND r.server_id = ${serverId}`);
 if(!report)throw new HttpError('apiError.drift.reportNotFound');if(!report.complete||report.policy_version!==report.current_version)throw new HttpError('apiError.drift.baselineCompleteOnly');
 if(now()-Math.min(report.received_at,report.scanned_at)>86400000)throw new HttpError('apiError.drift.baselineCurrentScan');const id=crypto.randomUUID(),at=now();
 // Baselines copy the immutable inventory. Accepting a new reference must not
 // erase the historical difference that caused the operator to inspect it.
 const authorization=driftWriteGuard(v,serverId);
 const accepted=await commitAll([sql`INSERT INTO drift_baselines (id,server_id,policy_version,report_id,entries,created_at,created_by) SELECT ${id},${serverId},${report.policy_version},${report.id},${report.entries},${at},${principal(v)} WHERE EXISTS (SELECT 1 FROM servers s JOIN drift_reports r ON r.server_id=s.id JOIN drift_policies p ON p.server_id=s.id WHERE s.id=${serverId} AND s.revoked=0 AND r.id=${report.id} AND r.complete=1 AND r.policy_version=p.version) AND ${authorization}`,sql`DELETE FROM drift_baselines WHERE server_id = ${serverId} AND id NOT IN (SELECT id FROM drift_baselines WHERE server_id = ${serverId} ORDER BY created_at DESC,id DESC LIMIT 50) AND EXISTS (SELECT 1 FROM drift_baselines WHERE id=${id})`]);
 if(!accepted[0].rowCount)throw new HttpError('apiError.drift.baselineChanged');
 await log(v.label,'Drift-Baseline ausdrücklich freigegeben',id,serverId);return {id};
}
export async function listDrift(v:Viewer,serverId:string,reportId?:string,compact=false){
 const server=await requireDevice(v,serverId,'drift.read'),policy=await getDriftPolicy(serverId),d=db();
 const perms=await import('../identity/access');const contentAllowed=(await perms.permissionsFor(v,serverId)).includes('drift.contents');
 function redact(changes:Change[]){return changes.map(c=>({...c,before:c.before?{...c.before,...(!contentAllowed?{text:undefined}:{})}:undefined,after:c.after?{...c.after,...(!contentAllowed?{text:undefined}:{})}:undefined,...(!contentAllowed?{textDiff:undefined}:{})}));}
 const columns=sql`id,policy_version AS "policyVersion",baseline_id AS "baselineId",scanned_at AS "scannedAt",received_at AS "receivedAt",COALESCE(first_scanned_at,scanned_at) AS "firstScannedAt",scan_count AS "scanCount",complete,state,changes,errors`;
 const convert=(r:Record<string,unknown>):Record<string,unknown>&{complete:boolean;changes:Change[];errors:string[]}=>({...r,complete:!!r.complete,changes:redact(parse<Change[]>(String(r.changes))),errors:parse<string[]>(String(r.errors))});
 if(reportId){if(!guid(reportId))throw new HttpError('apiError.drift.invalidReportId');const report=await d.one<Record<string,unknown>>(sql`SELECT ${columns} FROM drift_reports WHERE server_id = ${serverId} AND id = ${reportId}`);if(!report)throw new HttpError('apiError.drift.reportGone');return {report:convert(report)};}
 const retentionDays='retentionDays'in policy?Number(policy.retentionDays):30,cutoff=now()-retentionDays*86400000;
 const reports=compact?{results:[]}:await d.query<Record<string,unknown>>(sql`SELECT ${columns} FROM drift_reports WHERE server_id = ${serverId} ORDER BY received_at DESC,scanned_at DESC,id DESC LIMIT 30`).then(results=>({results})),baselines=await d.query<Record<string,unknown>>(sql`SELECT id,report_id AS "reportId",policy_version AS "policyVersion",created_at AS "createdAt",created_by AS "createdBy" FROM drift_baselines WHERE server_id = ${serverId} ORDER BY created_at DESC,id DESC LIMIT 50`).then(results=>({results}));
 const currentRow='version'in policy?await d.one<Record<string,unknown>>(sql`SELECT ${columns},entries FROM drift_reports WHERE server_id = ${serverId} AND policy_version = ${policy.version} ORDER BY received_at DESC,scanned_at DESC,id DESC LIMIT 1`):null,baseline=baselines.results.find(b=>'version'in policy&&b.policyVersion===policy.version)??null;
 let current=currentRow?convert(currentRow):null;if(current&&currentRow){delete current.entries;if(baseline&&current.complete){const reference=await d.one<{entries:string}>(sql`SELECT entries FROM drift_baselines WHERE id = ${baseline.id as string}`);if(reference){let changes=redact(diffEntries(parse<DriftEntry[]>(reference.entries),parse<DriftEntry[]>(String(currentRow.entries))));const changeCount=changes.length;if(new TextEncoder().encode(JSON.stringify(changes)).byteLength>800000)changes=changes.map(entry=>{const compact={...entry};delete compact.textDiff;return compact;});if(new TextEncoder().encode(JSON.stringify(changes)).byteLength>800000){changes=changes.slice(0,200);current.errors=[...current.errors,'serverMessage.drift.changesLimited'];}current={...current,state:changeCount?'drifted':'in_sync',changes,changeCount};}}}
 const interval='intervalSeconds'in policy?Number(policy.intervalSeconds):300,stale=!!current&&(now()-Math.min(Number(current.receivedAt),Number(current.scannedAt))>Math.max(interval*3,120)*1000||!server.last_seen||now()-server.last_seen>120000),state=!policy.enabled?'disabled':!current?'baseline_missing':stale?'stale':current.state;
 // SQL compares adjacent rows as well, so deployments with thousands of old
 // scans immediately show state/difference transitions, not scan spam. Only
 // compact summaries leave the database; full diffs are fetched on demand by report ID.
 const history=await d.query<Record<string,unknown>>(sql`WITH ordered AS (
 SELECT ${columns},LAG(policy_version) OVER w AS "previousVersion",LAG(baseline_id) OVER w AS "previousBaseline",LAG(state) OVER w AS "previousState",LAG(changes) OVER w AS "previousChanges",LAG(errors) OVER w AS "previousErrors" FROM drift_reports WHERE server_id = ${serverId} WINDOW w AS (ORDER BY received_at,scanned_at,id)
 ),marked AS (
 SELECT *,CASE WHEN "previousState" IS NULL OR "policyVersion" <> "previousVersion" OR "baselineId" IS DISTINCT FROM "previousBaseline" OR state <> "previousState" OR changes <> "previousChanges" OR errors <> "previousErrors" THEN 1 ELSE 0 END AS "startsEvent" FROM ordered
 ),numbered AS (
 SELECT *,SUM("startsEvent") OVER (ORDER BY "receivedAt","scannedAt",id) AS "eventBlock" FROM marked
 ),ranked AS (
 SELECT *,ROW_NUMBER() OVER (PARTITION BY "eventBlock" ORDER BY "receivedAt" DESC,"scannedAt" DESC,id DESC) AS rank FROM numbered
 ),totals AS (
 SELECT "eventBlock",MIN("firstScannedAt") AS "eventFirstScan",MAX("scannedAt") AS "eventLastScan",MAX("receivedAt") AS "eventLastReceipt",SUM("scanCount")::bigint AS "eventScanCount",MAX(CASE WHEN "startsEvent" = 1 THEN "previousState" END) AS "eventPreviousState" FROM numbered GROUP BY "eventBlock"
 ) SELECT r.id,r."policyVersion",t."eventLastScan" AS "scannedAt",t."eventLastReceipt" AS "receivedAt",t."eventFirstScan" AS "firstScannedAt",t."eventScanCount" AS "scanCount",r.complete,r.state,jsonb_array_length(r.changes::jsonb) AS "changeCount",jsonb_array_length(r.errors::jsonb) AS "errorCount",CASE WHEN r.state = 'error' THEN 'error' WHEN r.state = 'drifted' THEN 'change' WHEN r.state = 'in_sync' AND t."eventPreviousState" IN ('drifted','error') THEN 'recovered' WHEN t."eventPreviousState" = 'error' AND r.complete = 1 THEN 'recovered' ELSE 'scan' END AS kind FROM ranked r JOIN totals t ON t."eventBlock" = r."eventBlock" WHERE r.rank = 1 AND t."eventLastReceipt" >= ${cutoff} ORDER BY t."eventLastReceipt" DESC,t."eventLastScan" DESC,r.id DESC LIMIT 200`).then(results=>({results}));
 return {policy,state,baseline,baselines:baselines.results,current,reports:reports.results.map(convert),history:history.results.filter(r=>r.kind!=='scan'),retentionDays,historyLimit:200};
}
