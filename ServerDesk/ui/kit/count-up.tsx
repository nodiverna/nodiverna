'use client';
// A number that counts to its value (nodiverna-ui §8, "values that change count over at most 240 ms"): from 0 the
// first time its entrance id shows in this page load, from the previous value on a change. The markup always holds
// the final value, so the server render, a test and a screen reader read it; the frames write the visible text
// node directly and cause no React render. Nothing counts under reduced motion or without requestAnimationFrame.
import {useLayoutEffect,useRef} from 'react';
import {formatNumber} from '@/lib/i18n/format';
import {reducedMotion} from '@/ui/base/motion';
import {useLocale} from '@/ui/base/locale';
import {cx} from '@/ui/kit/kit';

/** The length of a count in ms. */
export const countDuration=240;
const easeOut=(progress:number)=>1-(1-progress)**3;
export type CountFrames={request:(callback:(time:number)=>void)=>number;cancel:(id:number)=>void};
const browserFrames=():CountFrames|null=>typeof requestAnimationFrame==='function'&&typeof cancelAnimationFrame==='function'
 ?{request:callback=>requestAnimationFrame(callback),cancel:id=>cancelAnimationFrame(id)}:null;

/**
 * Calls frame with whole numbers from `from` towards `to` over `duration` (ease-out), the last call with `to`
 * itself, then done. Returns the cancel function; a cancelled count calls nothing more.
 */
export function countFrames({from,to,duration=countDuration,frame,done,frames}:{from:number;to:number;duration?:number;frame:(value:number)=>void;done?:()=>void;frames:CountFrames}):()=>void{
 let id=0,started:number|null=null,stopped=false;
 const step=(time:number)=>{
  if(stopped)return;
  started??=time;
  const progress=duration>0?Math.min(1,(time-started)/duration):1;
  if(progress>=1){frame(to);done?.();return;}
  frame(Math.round(from+(to-from)*easeOut(progress)));
  id=frames.request(step);
 };
 frame(from);
 id=frames.request(step);
 return ()=>{stopped=true;frames.cancel(id);};
}

// The entrance ids whose first count has finished in this page load: a later mount shows its value at once.
const counted=new Set<string>();

/**
 * value in the console language. entranceId: the first count from 0 plays once per page load for this id (a route
 * change back to the page does not replay it); without one, every mount counts from 0.
 */
export function CountUp({value,digits=0,entranceId,className}:{value:number;digits?:number;entranceId?:string;className?:string}){
 const [locale]=useLocale(),node=useRef<HTMLSpanElement>(null),previous=useRef<number|null>(null);
 const text=formatNumber(locale,value,{maximumFractionDigits:digits});
 useLayoutEffect(()=>{
  const before=previous.current,from=before??(entranceId&&counted.has(entranceId)?value:0);
  previous.current=value;
  const target=node.current?.firstChild,frames=browserFrames(),settle=()=>{if(entranceId)counted.add(entranceId);};
  if(!target||!frames||from===value||reducedMotion()){settle();return;}
  const shown=(current:number)=>formatNumber(locale,current,{maximumFractionDigits:digits});
  let finished=false;
  const cancel=countFrames({from,to:value,frames,frame:current=>{target.nodeValue=shown(current);},done:()=>{finished=true;settle();}});
  // A count that was cut short (a new value, an unmount, the second effect run of a development render) leaves the
  // final text and starts again from where it began.
  return ()=>{cancel();if(!finished){target.nodeValue=shown(value);previous.current=before;}};
 },[value,locale,digits,entranceId]);
 return <span className={cx('sdx-count',className)}><span ref={node} aria-hidden="true">{text}</span><span className="sr-only">{text}</span></span>;
}
