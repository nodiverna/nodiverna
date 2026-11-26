// The console clock: one small external store with one 1 s interval for the whole console. Before, the clock was
// state of RedesignConsole, so every tick rendered the whole console with a few hundred devices. Now each view reads
// the time through a selector hook: the selector runs in the interval callback, outside React, and the view renders
// again only when its selected value changes (a relative "last seen" text, a connection state, a count). Views that
// show seconds (the elapsed time of a running job) select the time itself and render every tick.
import {startTransition,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';

export type ClockStore={
 /** The time of the last tick (ms). Stable between ticks, so it is a valid useSyncExternalStore snapshot. */
 now:()=>number;
 /** useSyncExternalStore's subscribe. The first subscriber starts the interval, the last one to leave stops it. */
 subscribe:(listener:()=>void)=>()=>void;
 /** Moves the clock to `time` and notifies the subscribers. The interval calls it every second; tests use it as fake time. */
 set:(time:number)=>void;
};

type Timers={setInterval:(callback:()=>void,ms:number)=>unknown;clearInterval:(timer:unknown)=>void};
const realTimers:Timers={setInterval:(callback,ms)=>setInterval(callback,ms),clearInterval:timer=>clearInterval(timer as ReturnType<typeof setInterval>)};

/**
 * A clock store. `time` reads the wall clock (default Date.now); `interval` is the tick (default 1 s); `timers`
 * replaces setInterval and clearInterval (tests). Without subscribers the clock forgets its time, so a later first
 * reader starts from the wall clock again instead of a stale tick.
 */
export function clockStore({time=()=>Date.now(),interval=1000,timers=realTimers}:{time?:()=>number;interval?:number;timers?:Timers}={}):ClockStore{
 let current=0,timer:unknown=null;
 const listeners=new Set<()=>void>();
 const set=(next:number)=>{
  if(next===current)return;
  current=next;
  for(const listener of [...listeners])listener();
 };
 return {
  now:()=>{if(!current)current=time();return current;},
  subscribe(listener){
   listeners.add(listener);
   if(timer===null)timer=timers.setInterval(()=>set(time()),interval);
   return ()=>{
    listeners.delete(listener);
    if(listeners.size||timer===null)return;
    timers.clearInterval(timer);timer=null;current=0;
   };
  },
  set,
 };
}

/** The clock of the console: every view of the console reads this one store. */
export const consoleClock=clockStore();

const tickKey=(now:number)=>now;

/**
 * Reads the clock through a selector and returns its value; the caller renders again only when the value changes
 * (Object.is). The value must be a primitive or a value that keeps its identity while it is equal.
 */
export function useClockValue<T>(select:(now:number)=>T,clock:ClockStore=consoleClock):T{
 const read=()=>select(clock.now());
 return useSyncExternalStore(clock.subscribe,read,read);
}

/**
 * The time to render with for a view whose clock-derived output is described by `key` (a string or number that
 * changes exactly when something the view shows changes: a connection state, a relative time text, a count). The
 * hook returns the tick at which key last changed, so the caller renders again only then. A render for another
 * reason (new props, so a new key function) takes the latest tick. Without key the caller renders on every tick.
 */
export function useClockAt(key:(now:number)=>unknown=tickKey,clock:ClockStore=consoleClock):number{
 const cache=useMemo(()=>tickCache(clock),[clock]);
 const read=()=>cache.read(key);
 return useSyncExternalStore(clock.subscribe,read,read);
}

/**
 * useClockAt for the many subscribers of a list (table rows, device cards, tree rows) and the list view itself. A
 * store update of useSyncExternalStore always renders synchronously; when a tick changes many of them at once (a
 * group of devices that reported together leaves the online window), that render would block the main thread. Here
 * the tick only checks the key (in the interval callback, outside React) and a change renders as a transition, which
 * React splits into slices between the rows. The returned time follows the same rule as useClockAt.
 */
export function useClockTransition(key:(now:number)=>unknown=tickKey,clock:ClockStore=consoleClock):number{
 const cache=useMemo(()=>tickCache(clock),[clock]);
 const [,setVersion]=useState(0);
 const at=cache.read(key);
 // The key function and the time of the last commit: a tick renders again only when the key's value moved on.
 const shown=useRef({key,at});
 useLayoutEffect(()=>{shown.current={key,at};});
 useEffect(()=>{
  const check=()=>{const {key:current,at:time}=shown.current;if(cache.read(current)!==time)startTransition(()=>setVersion(version=>version+1));};
  const unsubscribe=clock.subscribe(check);
  // A tick between the render and this subscription is not lost.
  check();
  return unsubscribe;
 },[clock,cache]);
 return at;
}

/**
 * The snapshot cache of one useClockAt caller: the tick it last returned, with the key function and the key value it
 * was computed with. The same key function with an equal value keeps the tick; a new key function (a render with new
 * props) takes the latest tick.
 */
function tickCache(clock:ClockStore){
 let last:{key:(now:number)=>unknown;value:unknown;at:number}|null=null;
 return {read(next:(now:number)=>unknown):number{
  const now=clock.now();
  if(last&&last.at===now&&last.key===next)return now;
  const value=next(now);
  if(last&&last.key===next&&Object.is(last.value,value))return last.at;
  last={key:next,value,at:now};
  return now;
 }};
}

/**
 * The time for a view that took a `now` prop: `pinned` when the caller pins it (tests, previews), else the console
 * clock through useClockAt (every tick without key).
 */
export function useClockNow(pinned?:number,key?:(now:number)=>unknown):number{
 const now=useClockAt(key);
 return pinned??now;
}
