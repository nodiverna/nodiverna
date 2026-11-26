'use client';
// Soft reorder (nodiverna-ui §8, "motion that explains"): the items of a list move from their old place to their new
// one when their order changes, and an item that was not there before fades in. The caller marks each item with
// data-flip="<key>" and calls capture() right before it changes the order, in the same event; the commit that follows
// plays the move. A commit without a capture does nothing.
// Transform and opacity only, through the Web Animations API; nothing moves under reduced motion.
import {useCallback,useLayoutEffect,useRef,type RefObject} from 'react';
import {reducedMotion} from '@/ui/base/motion';

const itemsOf=(box:HTMLElement)=>[...box.querySelectorAll<HTMLElement>('[data-flip]')];
/** The CSS time of a token ("260ms", ".26s") in ms, or the fallback. */
export function tokenMs(value:string,fallback:number):number{
 const match=/^\s*(\d*\.?\d+)(ms|s)\s*$/.exec(value);
 return match?Number(match[1])*(match[2]==='s'?1000:1):fallback;
}
/** The move of one item from its old box to its new one, or null when it did not move. */
export function flipOffset(before:{left:number;top:number},after:{left:number;top:number}):{x:number;y:number}|null{
 const x=Math.round(before.left-after.left),y=Math.round(before.top-after.top);
 return x||y?{x,y}:null;
}

/** [ref, capture]: the ref of the container of the items, and the function to call right before their order changes. */
export function useFlip<T extends HTMLElement>():readonly [RefObject<T|null>,()=>void]{
 const ref=useRef<T|null>(null),captured=useRef<Map<string,DOMRect>|null>(null);
 const capture=useCallback(()=>{
  const box=ref.current;
  if(!box||reducedMotion()){captured.current=null;return;}
  captured.current=new Map(itemsOf(box).map(item=>[item.dataset.flip??'',item.getBoundingClientRect()]));
 },[]);
 useLayoutEffect(()=>{
  const box=ref.current,before=captured.current;
  captured.current=null;
  if(!box||!before||reducedMotion())return;
  const style=getComputedStyle(box),duration=tokenMs(style.getPropertyValue('--sd-dur-slow'),260),easing=style.getPropertyValue('--sd-ease-out').trim()||'ease-out';
  for(const item of itemsOf(box)){
   if(typeof item.animate!=='function')continue;
   const from=before.get(item.dataset.flip??'');
   if(!from){item.animate([{opacity:0},{opacity:1}],{duration,easing});continue;}
   const offset=flipOffset(from,item.getBoundingClientRect());
   if(offset)item.animate([{transform:`translate(${offset.x}px,${offset.y}px)`},{transform:'none'}],{duration,easing});
  }
 });
 return [ref,capture] as const;
}
