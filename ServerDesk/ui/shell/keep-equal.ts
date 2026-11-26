// Structural sharing for JSON answers: a new answer keeps every part of the previous one whose content is equal, by
// identity. The console merges each refresh and each jobs poll into its data this way, so memoized views (table rows,
// device cards, tree rows) see the same object for a device, job, group or customer that did not change and do not
// render again. Pure, no React.
//
// The objects the merge builds never get the keys __proto__, constructor and prototype of an answer (skippedKey): they
// are built by assignment, and assigning an own __proto__ key of a JSON answer would change the built object's
// prototype. A part the merge takes from the answer as a whole is the object JSON.parse made: such a key stays its own
// data there and changed no prototype (as in ui/shell/console-payload.ts). Walking every changed device for these keys
// would cost a heartbeat merge the full compare that the early stop of the equality saves.
import type {ConsoleData} from '@/lib/types';

export type Plain=Record<string,unknown>;
/** A plain object (no array, no class instance): the objects JSON.parse makes. */
export const isPlain=(value:unknown):value is Plain=>{
 if(value===null||typeof value!=='object'||Array.isArray(value))return false;
 const prototype=Object.getPrototypeOf(value);
 return prototype===Object.prototype||prototype===null;
};
export type Keyed={id:string|number};
/** Every item is a plain object with a string or number id: such lists are matched by id, so an insert or a new order keeps the items. */
export const keyed=(items:readonly unknown[]):items is Keyed[]=>items.every(item=>isPlain(item)&&(typeof item.id==='string'||typeof item.id==='number'));

/**
 * The keys the merge never copies: __proto__ (an assignment would change the prototype of the built object) and the
 * other two classic prototype-pollution keys. The server never sends them; for the identity rule they count as absent.
 */
const skippedKey=(key:string)=>key==='__proto__'||key==='constructor'||key==='prototype';
/** The number of own keys of an object that the merge copies. */
function keptKeyCount(value:object):number{
 let count=0;
 for(const key of Object.keys(value))if(!skippedKey(key))count++;
 return count;
}

/** Deep equality of JSON values; it stops at the first difference (a heartbeat changes lastSeen near the top of a device). */
export const jsonEqual=(a:unknown,b:unknown):boolean=>valueEqual(a,b,false);
/** jsonEqual, or with skip the equality of the merge: the skipped keys of objects count as absent. */
function valueEqual(a:unknown,b:unknown,skip:boolean):boolean{
 if(Object.is(a,b))return true;
 if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
 if(Array.isArray(a)){
  if(!Array.isArray(b)||a.length!==b.length)return false;
  for(let index=0;index<a.length;index++)if(!valueEqual(a[index],b[index],skip))return false;
  return true;
 }
 if(Array.isArray(b))return false;
 const keys=Object.keys(a);
 if(!skip&&keys.length!==Object.keys(b).length)return false;
 let count=0;
 for(const key of keys){
  if(skip&&skippedKey(key))continue;
  count++;
  if(!Object.hasOwn(b,key)||!valueEqual((a as Plain)[key],(b as Plain)[key],skip))return false;
 }
 return !skip||count===keptKeyCount(b);
}

/** An item of a list with ids: the previous object when equal, else the new one (a changed device is new as a whole). */
const keepItem=(before:unknown,item:unknown)=>before!==undefined&&valueEqual(before,item,true)?before:item;

function keepEqualArray(previous:readonly unknown[],next:readonly unknown[]):readonly unknown[]{
 const byId=previous.length&&next.length&&keyed(previous)&&keyed(next)?new Map(previous.map(item=>[item.id,item])):null;
 let same=previous.length===next.length;
 const result=next.map((item,index)=>{
  const kept=byId?keepItem(byId.get((item as Keyed).id),item):index<previous.length?keepEqual(previous[index],item):item;
  if(kept!==previous[index])same=false;
  return kept;
 });
 return same?previous:result;
}

function keepEqualObject(previous:Plain,next:Plain):Plain{
 let same=true,count=0;
 const result:Plain={};
 for(const key of Object.keys(next)){
  if(skippedKey(key))continue;
  count++;
  const has=Object.hasOwn(previous,key),before=has?previous[key]:undefined;
  const kept=before===undefined?next[key]:keepEqual(before,next[key]);
  result[key]=kept;
  if(kept!==before||!has)same=false;
 }
 return same&&count===keptKeyCount(previous)?previous:result;
}

/**
 * `next` with every part that equals the matching part of `previous` replaced by that part: an equal object or array
 * is the previous one; a changed object is new but keeps its equal children. Arrays of objects with an id (devices,
 * jobs, groups, customers) are matched by id: the order and the membership follow `next`, an equal item is the
 * previous object, a changed item is the new one. Other arrays are matched by position. An array whose items are all
 * kept and in the same order is the previous array. Values that are not plain objects or arrays are taken from `next`.
 * The keys __proto__, constructor and prototype of `next` are never copied into a built object and count as absent
 * for the identity rule (skippedKey): a part that differs from the previous one only by them is the previous part.
 */
export function keepEqual<T>(previous:unknown,next:T):T{
 if(Object.is(previous,next))return previous as T;
 if(Array.isArray(previous)&&Array.isArray(next))return keepEqualArray(previous,next) as T;
 if(isPlain(previous)&&isPlain(next))return keepEqualObject(previous,next) as T;
 return next;
}

/** A console answer merged into the shown one: unchanged parts keep their identity (see keepEqual). */
export const mergeConsoleData=(previous:ConsoleData|null,next:ConsoleData):ConsoleData=>previous?keepEqual(previous,next):next;

/** The answer of the jobs-only poll merged into the shown data: only jobs and viewer can change; everything else keeps its identity. */
export const mergeConsoleJobs=(previous:ConsoleData,jobs:ConsoleData['jobs'],viewer:ConsoleData['viewer']):ConsoleData=>keepEqual(previous,{...previous,jobs,viewer});

/**
 * mergeConsoleData for the console's refresh: the same result, but the device list (the bulk of an answer: a few
 * hundred devices with their inventory) is compared in slices of about sliceMs, with a pause (a new task) between
 * them, so a large unchanged answer never blocks the main thread for a long frame.
 */
export async function mergeConsoleDataInSlices(previous:ConsoleData|null,next:ConsoleData,{sliceMs=4,clock=()=>performance.now(),pause=()=>new Promise<void>(resolve=>setTimeout(resolve,0))}:{sliceMs?:number;clock?:()=>number;pause?:()=>Promise<void>}={}):Promise<ConsoleData>{
 if(!previous)return next;
 const before=previous.servers,after=next.servers;
 if(!Array.isArray(before)||!Array.isArray(after)||!keyed(before)||!keyed(after))return mergeConsoleData(previous,next);
 const byId=new Map(before.map(server=>[server.id,server]));
 const servers=new Array<(typeof after)[number]>(after.length);
 let same=before.length===after.length,start=clock();
 for(let index=0;index<after.length;index++){
  if(clock()-start>sliceMs){await pause();start=clock();}
  const kept=keepItem(byId.get(after[index].id),after[index]) as (typeof after)[number];
  servers[index]=kept;
  if(kept!==before[index])same=false;
 }
 // The rest of the answer is small: merged at once, with the previous list in place of the merged one.
 const shown=same?before:servers,rest=keepEqual(previous,{...next,servers:before});
 return shown===before?rest:{...rest,servers:shown};
}
