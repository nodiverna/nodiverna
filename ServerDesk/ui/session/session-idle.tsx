'use client';
// The idle countdown of the portal session. SessionGate provides it around the console
// (SessionIdleProvider): it watches genuine activity (watchPortalActivity, the remote
// desktop frame) and ticks once a second. The ticks go to a small store, not to React
// state, so only the top bar pill that reads it (useIdleSeconds) renders again, never
// the whole console.
import {createContext,useContext,useEffect,useMemo,useState,useSyncExternalStore,type ReactNode} from 'react';
import type {SessionTiming} from '@/ui/session/session-state';
import {idlePillSeconds} from '@/ui/session/session-idle-state';
import {watchPortalActivity,watchRemoteDesktopActivity} from '@/ui/session/session-activity';
import {portalNow} from '@/ui/base/http';

export type IdleStatus=SessionTiming&{idleTimeoutMs?:number};
/** The clock of the countdown: the time of the last tick and of the last genuine interaction. */
export type IdleClock={readonly time:number;readonly lastInteraction:number;subscribe:(listener:()=>void)=>()=>void;tick:()=>void;interact:()=>void;reset:()=>void};

/** A clock that notifies its subscribers on every tick and interaction. */
export function createIdleClock(now:()=>number=portalNow):IdleClock{
 const listeners=new Set<()=>void>();
 let time=now(),lastInteraction=time;
 const notify=()=>{for(const listener of listeners)listener();};
 return {
  get time(){return time;},
  get lastInteraction(){return lastInteraction;},
  subscribe(listener){listeners.add(listener);return ()=>{listeners.delete(listener);};},
  tick(){time=now();notify();},
  // Activity ends the countdown at once: the pill goes before the renewal reaches the server.
  interact(){lastInteraction=now();time=lastInteraction;notify();},
  reset(){time=now();lastInteraction=time;notify();},
 };
}

export type SessionIdleValue={status:IdleStatus;clock:IdleClock};
export const SessionIdleContext=createContext<SessionIdleValue|null>(null);

/** Provides the idle state of an authenticated session to the console (the top bar reads it). */
export function SessionIdleProvider({status,children}:{status:IdleStatus;children:ReactNode}){
 const [clock]=useState(()=>createIdleClock());
 useEffect(()=>{
  clock.reset();
  const visible=()=>document.visibilityState==='visible';
  const stop=watchPortalActivity(window,visible,()=>clock.interact());
  const stopRemote=watchRemoteDesktopActivity(window,window.location.origin,()=>Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[data-serverdesk-rdp]'),frame=>({contentWindow:frame.contentWindow,serverId:frame.dataset.serverdeskRdp??''})),visible,()=>clock.interact());
  const tick=setInterval(()=>{if(visible())clock.tick();},1000);
  const returned=()=>{if(visible())clock.tick();};
  document.addEventListener('visibilitychange',returned);
  return ()=>{stop();stopRemote();clearInterval(tick);document.removeEventListener('visibilitychange',returned);};
 },[clock,status.sessionId]);
 const value=useMemo(()=>({status,clock}),[status,clock]);
 return <SessionIdleContext.Provider value={value}>{children}</SessionIdleContext.Provider>;
}

const noSubscription=()=>()=>{};
/** The seconds until the automatic sign-out while the countdown is urgent (idlePillSeconds), else null; null outside SessionGate. */
export function useIdleSeconds():number|null{
 const value=useContext(SessionIdleContext);
 const read=()=>value?idlePillSeconds(value.status,value.clock.time,value.clock.lastInteraction):null;
 // The console renders on the client only (after the sign-in), so the server snapshot is the same reading.
 return useSyncExternalStore(value?value.clock.subscribe:noSubscription,read,read);
}
