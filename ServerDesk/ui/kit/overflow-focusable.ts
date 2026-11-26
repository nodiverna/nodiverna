'use client';
// A scroll region takes a Tab stop only while its content overflows (axe scrollable-region-focusable): the DataTable
// wrap, a long ConfirmDialog line and the compact KPI row at 760px or narrower. Its own module, so the kit (KpiRow)
// and the table use it without an import cycle. useScrollEdges reports the cut edges of a sideways scroller (the
// compact KPI row fades them like an overflowing tab bar).
import {useEffect,useRef,useState,type RefObject} from 'react';
import {scrollRegionFocusable} from '@/ui/kit/data-table-model';
import {stripOverflow} from '@/ui/kit/tab-reveal';

/**
 * Whether the element needs a Tab stop because its content overflows (scrollRegionFocusable).
 * `initial` before the first measurement: true by default (SSR and no-JS stay keyboard reachable), false for a region
 * that overflows only in a narrow layout (the KPI row). Measured by a ResizeObserver on the element and its children,
 * again whenever `revision` changes.
 */
export function useOverflowFocusable<T extends HTMLElement>(revision:unknown,initial=true){
 const ref=useRef<T>(null),[focusable,setFocusable]=useState(initial);
 useEffect(()=>{
  const element=ref.current;
  if(!element)return;
  const measure=()=>setFocusable(scrollRegionFocusable(element));
  if(typeof ResizeObserver==='undefined'){queueMicrotask(measure);return;}
  // The observer reports every observed box once at the start, so this also measures on mount.
  const observer=new ResizeObserver(measure);
  observer.observe(element);
  for(const child of Array.from(element.children))observer.observe(child);
  return ()=>observer.disconnect();
 },[revision]);
 return [ref,focusable] as const;
}

export type ScrollEdges={start:boolean;end:boolean};
/**
 * Which edges of a sideways scroller cut content (stripOverflow, the rule behind the tab bar fades): start once it is
 * scrolled, end while more follows. Measured on mount, on scroll (once per frame) and when the element or its children
 * resize; again whenever `revision` changes. Both false before the first measurement and without overflow.
 */
export function useScrollEdges<T extends HTMLElement>(ref:RefObject<T|null>,revision:unknown):ScrollEdges{
 const [edges,setEdges]=useState<ScrollEdges>({start:false,end:false});
 useEffect(()=>{
  const element=ref.current;
  if(!element)return;
  let frame=0;
  const measure=()=>{const next=stripOverflow(element);setEdges(previous=>previous.start===next.start&&previous.end===next.end?previous:next);};
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);};
  element.addEventListener('scroll',schedule,{passive:true});
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(schedule);
  observer?.observe(element);
  for(const child of Array.from(element.children))observer?.observe(child);
  measure();
  return ()=>{cancelAnimationFrame(frame);element.removeEventListener('scroll',schedule);observer?.disconnect();};
 },[ref,revision]);
 return edges;
}
