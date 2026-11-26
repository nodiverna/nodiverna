'use client';
// How many columns the Dashboard grid shows (dashboardGridColumns in dashboard-model.ts: 4, 2 or 1 by the width of the
// grid, not of the window, so the navigator and a drawer beside the page count). The page reads it to size each
// widget and to choose what the widget shows. Before the first measure, and where nothing can be measured (the
// server, a test), the grid has its full 4 columns.
import {useLayoutEffect,useState} from 'react';
import {dashboardColumns} from '@/lib/dashboard-layout';
import {dashboardGridColumns} from '@/ui/devices/dashboard/dashboard-model';

/** [ref, columns]: the callback ref of the element whose width counts, and the columns for that width. */
export function useGridColumns<T extends HTMLElement>():readonly [(node:T|null)=>void,number]{
 const [node,setNode]=useState<T|null>(null),[columns,setColumns]=useState(dashboardColumns);
 useLayoutEffect(()=>{
  if(!node)return;
  const measure=()=>setColumns(dashboardGridColumns(node.clientWidth));
  if(typeof ResizeObserver!=='function'){queueMicrotask(measure);return;}
  // The observer reports the observed box once at the start, so this also measures on mount, before the first paint.
  const observer=new ResizeObserver(measure);
  observer.observe(node);
  return ()=>observer.disconnect();
 },[node]);
 return [setNode,columns] as const;
}
