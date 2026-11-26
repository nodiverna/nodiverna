'use client';
// The narrow breakpoints of the console for layout decisions that change markup, not only CSS. The CSS uses the
// same widths: @media (max-width: 760px) for DataTable cards, the compact device and scope headers and the compact
// KPI row; @media (max-width: 900px) for the frame (rail as bottom bar, navigator overlay, Jobs sheet instead of
// the dock bar).
import {useEffect,useState} from 'react';

export const narrowQuery='(max-width: 760px)';
export const overlayQuery='(max-width: 900px)';

/** Whether a media query matches: false on the server and on the first client render (SSR shows the wide layout), then the query. */
function useMediaQuery(media:string,enabled:boolean):boolean{
 const [matches,setMatches]=useState(false);
 useEffect(()=>{
  if(!enabled||typeof window==='undefined'||typeof window.matchMedia!=='function')return;
  const query=window.matchMedia(media),update=()=>setMatches(query.matches);
  queueMicrotask(update);
  query.addEventListener?.('change',update);
  return ()=>query.removeEventListener?.('change',update);
 },[media,enabled]);
 return enabled&&matches;
}

/** 760px or narrower: false on the server and on the first client render (SSR shows the wide layout), then the media query. */
export function useNarrowLayout(enabled=true):boolean{
 return useMediaQuery(narrowQuery,enabled);
}

/**
 * 900px or narrower, the frame of phones and narrow windows: the navigator is an overlay, the rail is the bottom bar and
 * Jobs open as a sheet from it. False on the server and on the first client render, then the media query.
 */
export function useOverlayLayout():boolean{
 return useMediaQuery(overlayQuery,true);
}
