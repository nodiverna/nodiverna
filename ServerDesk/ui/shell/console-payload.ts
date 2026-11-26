// The console answer as a patch: the console's worker (ui/shell/console-payload.worker.ts) parses each refresh answer
// and diffs it against its copy of the shown data; the main thread gets only the patch and applies it to the shown
// data (ui/shell/use-console-data.ts), so it never parses or compares the full answer itself. Pure, no React and no
// Worker API: the worker's message handler is consolePayloadHandler, a plain function.
//
// The identity rules are those of ui/shell/keep-equal.ts: applyConsolePatch(a,diffConsoleData(a,b)) equals b, every
// part of a whose content did not change is kept by identity, a changed object or array is new but keeps its unchanged
// children, and lists whose items all have an id are matched by id (order and membership follow b).
import type {ConsoleData,Job,Viewer} from '@/lib/types';
import {isPlain,keyed,type Keyed,type Plain} from '@/ui/shell/keep-equal';

/**
 * One change of a JSON value:
 * - `{v}` the new value as a whole (a new key, a new item, a primitive or a type change);
 * - `{o,k?}` an object: the changed keys with their change, and `k`, the keys of the new object in order, when keys
 *   were added or removed (without `k` the object has the keys of the base);
 * - `{a,s}` an array by position: its new length and the changed positions;
 * - `{i}` a list with ids in a new order or membership: per item of the new list the index of the equal base item,
 *   `[index,change]` for a changed one, or `{v}` for a new one.
 * Object keys travel as pairs, never as keys of a patch object, so a `__proto__` key of the answer stays data.
 */
export type ValueChange=
 |{v:unknown}
 |{o:[string,ValueChange][];k?:string[]}
 |{a:number;s:[number,ValueChange][]}
 |{i:ListEntry[]};
type ListEntry=number|[number,ValueChange]|{v:unknown};
/** The patch of a console answer; null: the answer equals the base. */
export type ConsolePatch=ValueChange|null;

/** The change from previous to next, or undefined when both are equal (jsonEqual). */
export function diffValue(previous:unknown,next:unknown):ValueChange|undefined{
 if(Object.is(previous,next))return undefined;
 if(Array.isArray(previous)&&Array.isArray(next))return diffArray(previous,next);
 if(isPlain(previous)&&isPlain(next))return diffObject(previous,next);
 return {v:next};
}

function diffObject(previous:Plain,next:Plain):ValueChange|undefined{
 const keys=Object.keys(next),changes:[string,ValueChange][]=[];
 let sameKeys=keys.length===Object.keys(previous).length;
 for(const key of keys){
  if(!Object.hasOwn(previous,key)){sameKeys=false;changes.push([key,{v:next[key]}]);continue;}
  const change=diffValue(previous[key],next[key]);
  if(change)changes.push([key,change]);
 }
 // The same keys in another order are the same object (as for jsonEqual): the base keeps its order.
 if(sameKeys)return changes.length?{o:changes}:undefined;
 return {o:changes,k:keys};
}

function diffArray(previous:readonly unknown[],next:readonly unknown[]):ValueChange|undefined{
 // Lists with ids whose ids are not in the same places: matched by id, as keepEqual does.
 if(previous.length&&next.length&&keyed(previous)&&keyed(next)&&!(previous.length===next.length&&next.every((item,index)=>item.id===previous[index].id)))return diffList(previous,next);
 const changes:[number,ValueChange][]=[];
 for(let index=0;index<next.length;index++){
  const change=index<previous.length?diffValue(previous[index],next[index]):{v:next[index]};
  if(change)changes.push([index,change]);
 }
 return changes.length||previous.length!==next.length?{a:next.length,s:changes}:undefined;
}

function diffList(previous:readonly Keyed[],next:readonly Keyed[]):ValueChange{
 const byId=new Map(previous.map((item,index)=>[item.id,index]));
 return {i:next.map((item):ListEntry=>{
  const index=byId.get(item.id);
  if(index===undefined)return {v:item};
  const change=diffValue(previous[index],item);
  return change?[index,change]:index;
 })};
}

/** The patch that turns previous into next: null when they are equal. */
export const diffConsoleData=(previous:unknown,next:unknown):ConsolePatch=>diffValue(previous,next)??null;

/** Sets an own data property, also for the key __proto__ (an assignment would change the prototype). */
function define(target:Plain,key:string,value:unknown){
 if(key==='__proto__')Object.defineProperty(target,key,{value,writable:true,enumerable:true,configurable:true});
 else target[key]=value;
}
const own=(base:Plain,key:string)=>Object.hasOwn(base,key)?base[key]:undefined;
const mismatch=()=>new TypeError('The console patch does not fit its base');

/** base with change applied: unchanged parts of base are kept by identity. */
export function applyValue(base:unknown,change:ValueChange):unknown{
 if('v' in change)return change.v;
 if('o' in change){
  if(!isPlain(base))throw mismatch();
  const changed=new Map(change.o),result:Plain={};
  for(const key of change.k??Object.keys(base)){
   const entry=changed.get(key);
   define(result,key,entry?applyValue(own(base,key),entry):own(base,key));
  }
  return result;
 }
 if(!Array.isArray(base))throw mismatch();
 if('a' in change){
  const result=new Array<unknown>(change.a);
  for(let index=0;index<change.a;index++)result[index]=base[index];
  for(const [index,entry] of change.s)result[index]=applyValue(base[index],entry);
  return result;
 }
 return change.i.map(entry=>typeof entry==='number'?base[entry]:Array.isArray(entry)?applyValue(base[entry[0]],entry[1]):entry.v);
}

/** The shown data with a patch of the worker applied; with no patch (an equal answer) the shown data itself. */
export const applyConsolePatch=(shown:ConsoleData,patch:ConsolePatch):ConsoleData=>patch?applyValue(shown,patch) as ConsoleData:shown;

/**
 * The messages to the worker. Every content state of the console's data that the worker knows has a version (`id`,
 * given by the client, rising). `parse` reads an answer body and diffs it against the version `base` (null: no base,
 * the full answer comes back); `seed` reads an answer body as version `id` without a reply (the first load, which the
 * main thread parses itself); `jobs` makes version `id` from `base` with the jobs poll's jobs and viewer, as
 * mergeConsoleJobs does on the main thread; `full` asks for the full data of a version. The body is a Blob (the
 * console's: response.blob() keeps the bytes off the main thread) or an ArrayBuffer.
 */
export type PayloadRequest=
 |{type:'parse';id:number;base:number|null;body:Blob|ArrayBuffer}
 |{type:'seed';id:number;body:Blob|ArrayBuffer}
 |{type:'jobs';id:number;base:number;jobs:Job[];viewer:Viewer}
 |{type:'full';id:number};
/**
 * The answers: `patch` turns version `base` into version `id` (patch null: equal); `full` is version `id` in full
 * (no base, or the worker does not hold `base`); `invalid`: the answer is no JSON; `missing`: the worker does not hold
 * the version asked for.
 */
export type PayloadReply=
 |{type:'patch';id:number;base:number;patch:ConsolePatch}
 |{type:'full';id:number;data:ConsoleData}
 |{type:'invalid';id:number}
 |{type:'missing';id:number};

/**
 * The worker's message handler. It handles the messages one after another in the order they came (reading a Blob
 * body waits), so a jobs step or a later answer never overtakes an earlier one. It holds at most two versions: the base
 * of the last message and the version that message made (the next message's base); any other version is dropped. A
 * message about a version it does not hold gets a full answer, so a patch never meets the wrong base.
 */
export function consolePayloadHandler(){
 const versions=new Map<number,unknown>(),decoder=new TextDecoder();
 const keepOnly=(...ids:(number|null)[])=>{for(const id of [...versions.keys()])if(!ids.includes(id))versions.delete(id);};
 /** The answer as JSON; undefined when it is no JSON. */
 const read=async(body:Blob|ArrayBuffer):Promise<{value:unknown}|undefined>=>{
  try{return {value:JSON.parse(decoder.decode(body instanceof ArrayBuffer?body:await body.arrayBuffer()))};}catch{return undefined;}
 };
 const step=async(message:PayloadRequest):Promise<PayloadReply|null>=>{
  if(message.type==='full'){
   const data=versions.get(message.id);
   return data===undefined?{type:'missing',id:message.id}:{type:'full',id:message.id,data:data as ConsoleData};
  }
  if(message.type==='jobs'){
   const previous=versions.get(message.base);
   keepOnly(message.base);
   if(isPlain(previous))versions.set(message.id,{...previous,jobs:message.jobs,viewer:message.viewer});
   return null;
  }
  const next=await read(message.body);
  if(message.type==='seed'){
   if(next){keepOnly();versions.set(message.id,next.value);}
   return null;
  }
  if(!next)return {type:'invalid',id:message.id};
  const previous=message.base===null?undefined:versions.get(message.base);
  keepOnly(message.base);
  if(previous===undefined){versions.set(message.id,next.value);return {type:'full',id:message.id,data:next.value as ConsoleData};}
  const patch=diffConsoleData(previous,next.value);
  // An equal answer: the version keeps the base's object.
  versions.set(message.id,patch?next.value:previous);
  return {type:'patch',id:message.id,base:message.base as number,patch};
 };
 let queue:Promise<unknown>=Promise.resolve();
 return (message:PayloadRequest):Promise<PayloadReply|null>=>{
  const result=queue.then(()=>step(message));
  queue=result.catch(()=>undefined);
  return result;
 };
}
