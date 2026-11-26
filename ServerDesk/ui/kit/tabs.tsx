'use client';
// Tab bar of the console kit (nodiverna-ui §3): navigation between areas or views. A nav landmark
// holds one tablist: one Tab stop, arrow keys, Home and End move the focus (roving tabindex) and
// Enter or Space activate (manual activation, because areas load data on open). Link tabs keep
// their href, so Ctrl, Cmd, Shift or a middle click still open a new tab or window.
// Overflow "scroll": the strip scrolls sideways, keeps the active tab in view, fades the cut edge
// and lists the tabs out of sight under "More". Overflow "menu": as many leading tabs as fit, the
// rest under "More". Before the first measurement (SSR, first client render) every tab renders in
// one row and there is no "More", so the markup does not depend on layout.
import {useCallback,useId,useLayoutEffect,useRef,useState,type KeyboardEvent,type MouseEvent} from 'react';
import {ChevronDown} from 'lucide-react';
import {Menu,cx,type StatusKind} from '@/ui/kit/kit';
import {useT} from '@/ui/base/locale';
import {fittingTabs,hiddenTabs,revealScrollLeft,stripOverflow,tabKeyTarget,type StripTab} from '@/ui/kit/tab-reveal';

export type TabItem={
 /** Tabs carry no icon (nodiverna-ui §8): the label names the area. */
 id:string;label:string;
 /** A count after the label; tone colors it like in Segmented. */
 count?:number|string;tone?:StatusKind;
 /** A short state after the label, for example "Paused" (span.sdx-tag); part of the accessible name and the fit measurement. */
 tag?:string;
 /** Renders a link tab; a plain left click calls onChange instead of following it. */
 href?:string;
 /** aria-keyshortcuts of the tab, for example "1". */
 shortcut?:string;
 /** Native title, for example the shortcut hint "Overview (1)". */
 title?:string;
};
export type TabsProps={
 items:readonly TabItem[];value:string;onChange:(id:string)=>void;
 /** Accessible name of the bar. */
 label:string;
 /** underline = area tabs; pill = subarea and section navigation with the accent active fill.
  *  Filters and view switches inside a panel use Segmented (neutral track) instead. */
 variant?:'underline'|'pill';
 overflow?:'scroll'|'menu';
 /** id of the tab panel; the active tab points to it with aria-controls. */
 panelId?:string;
 className?:string;
};

/** The id of a tab, so a panel can name it in aria-labelledby. base is the panelId when one is given. */
export const tabId=(base:string,id:string)=>`${base}-tab-${id}`;

type ScrollState={start:boolean;end:boolean;hidden:number[]};
const sameScroll=(a:ScrollState|null,b:ScrollState)=>!!a&&a.start===b.start&&a.end===b.end&&a.hidden.join()===b.hidden.join();
const px=(value:string)=>Number.parseFloat(value)||0;
/** overflow="menu": the side padding of the bar and its tablist, measured per layout (full row, row with "More") for one bar width. */
type BarPadding={width:number;full:number|null;more:number|null};
/** Room for the chevron and gap when the "More" trigger shows the active tab's label. */
const moreChevron=20;

export function Tabs({items,value,onChange,label,variant='underline',overflow='scroll',panelId,className}:TabsProps){
 const t=useT(),generated=useId(),base=panelId??generated;
 const navRef=useRef<HTMLElement>(null),listRef=useRef<HTMLDivElement>(null),moreRef=useRef<HTMLButtonElement>(null);
 const [scroll,setScroll]=useState<ScrollState|null>(null),[fitState,setFit]=useState<{key:string;count:number}|null>(null);
 const itemsKey=items.map(item=>`${item.id}\u0000${item.label}\u0000${item.count??''}\u0000${item.tag??''}`).join('\u0001');
 const placed=useRef(false),widths=useRef<{key:string;list:number[]}|null>(null),moreWidth=useRef(0),padding=useRef<BarPadding>({width:-1,full:null,more:null}),valueRef=useRef(value),itemsRef=useRef(items),keyRef=useRef(itemsKey);
 // A fit measured for other labels or counts no longer applies: the row renders in full and is measured again.
 const fit=fitState?.key===itemsKey?fitState.count:null;

 const visible=overflow==='menu'&&fit!==null?items.slice(0,fit):items;
 const inMenu=overflow==='menu'?fit===null?[]:items.slice(fit):(scroll?.hidden??[]).map(index=>items[index]).filter((item):item is TabItem=>!!item);
 const activeIndex=visible.findIndex(item=>item.id===value),focusIndex=activeIndex>=0?activeIndex:0;
 const activeInMenu=overflow==='menu'&&inMenu.some(item=>item.id===value);
 const activeItem=items.find(item=>item.id===value),activeLabel=activeItem?[activeItem.label,activeItem.tag].filter(Boolean).join(' '):'';

 const tabsOf=(list:HTMLElement)=>[...list.querySelectorAll<HTMLElement>('[role="tab"]')];
 // Only the strip's own scrollLeft moves (no scrollIntoView, which would also scroll the page); focus and URL stay.
 const reveal=useCallback((id:string,instant:boolean)=>{
  const list=listRef.current;
  if(!list||overflow!=='scroll')return;
  const tab=tabsOf(list).find(node=>node.id===tabId(base,id));
  if(!tab)return;
  const box=list.getBoundingClientRect(),rect=tab.getBoundingClientRect();
  const next=revealScrollLeft({scrollLeft:list.scrollLeft,clientWidth:list.clientWidth},{offsetLeft:rect.left-box.left-list.clientLeft+list.scrollLeft,offsetWidth:rect.width},px(getComputedStyle(list).paddingLeft));
  if(next===null)return;
  const reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  list.scrollTo({left:next,behavior:instant||reduce?'instant':'smooth'});
 },[base,overflow]);

 // overflow="scroll": which edges are cut and which tabs are out of sight.
 const measureScroll=useCallback(()=>{
  const list=listRef.current;
  if(!list)return;
  const box=list.getBoundingClientRect();
  const geometry:StripTab[]=tabsOf(list).map(node=>{const rect=node.getBoundingClientRect();return {offsetLeft:rect.left-box.left-list.clientLeft+list.scrollLeft,offsetWidth:rect.width};});
  const strip={scrollLeft:list.scrollLeft,clientWidth:list.clientWidth};
  const next={...stripOverflow({...strip,scrollWidth:list.scrollWidth}),hidden:hiddenTabs(geometry,strip)};
  setScroll(previous=>sameScroll(previous,next)?previous:next);
 },[]);

 // overflow="menu": the tab widths are measured while all tabs render (fit === null), then kept.
 const measureMenu=useCallback(()=>{
  const nav=navRef.current,list=listRef.current;
  if(!nav||!list)return;
  const listStyle=getComputedStyle(list),navStyle=getComputedStyle(nav),gap=px(listStyle.columnGap);
  const tabs=tabsOf(list),current=itemsRef.current;
  const key=keyRef.current;
  if(widths.current?.key!==key){
   // Widths come only from a full row; after a label change the next render shows it.
   if(tabs.length!==current.length)return;
   widths.current={key,list:tabs.map(node=>node.getBoundingClientRect().width+gap)};
  }
  const shown=moreRef.current;
  if(shown&&!shown.classList.contains('active'))moreWidth.current=shown.getBoundingClientRect().width+px(navStyle.columnGap);
  // The bar's padding can differ with and without "More" (the underline bar at ≤900px: 12px against 4px on the right).
  // The room of the row on screen decided both questions before, so at the boundary the answer flipped its own room
  // (all fit next to "More" → no "More" → no longer all fit → "More" …, a render loop). Now the full row's padding
  // decides whether all tabs fit and the padding with "More" how many fit next to it, each measured while its layout
  // shows and kept for this bar width; a layout not measured yet borrows the other one's padding.
  const sides=px(navStyle.paddingLeft)+px(navStyle.paddingRight)+px(listStyle.paddingLeft)+px(listStyle.paddingRight);
  if(padding.current.width!==nav.clientWidth)padding.current={width:nav.clientWidth,full:null,more:null};
  padding.current[shown?'more':'full']=sides;
  const room=nav.clientWidth+gap,full=room-(padding.current.full??sides),withMore=room-(padding.current.more??padding.current.full??sides);
  const all=widths.current.list,more=moreWidth.current||96,active=current.findIndex(item=>item.id===valueRef.current);
  let count=fittingTabs(all,full,more,withMore);
  if(count<all.length&&active>=count)count=fittingTabs(all,full,Math.max(more,(all[active]??0)+moreChevron),withMore);
  setFit(previous=>previous?.key===key&&previous.count===count?previous:{key,count});
 },[]);

 useLayoutEffect(()=>{valueRef.current=value;itemsRef.current=items;keyRef.current=itemsKey;});

 useLayoutEffect(()=>{
  const list=listRef.current,nav=navRef.current;
  if(!list||!nav)return;
  if(overflow==='menu'){
   if(typeof ResizeObserver==='undefined')return;
   const observer=new ResizeObserver(()=>measureMenu());
   observer.observe(nav);
   return ()=>observer.disconnect();
  }
  measureScroll();
  let frame=0;
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measureScroll);};
  list.addEventListener('scroll',schedule,{passive:true});
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(()=>{measureScroll();reveal(valueRef.current,true);});
  observer?.observe(list);
  return ()=>{cancelAnimationFrame(frame);list.removeEventListener('scroll',schedule);observer?.disconnect();};
 },[overflow,itemsKey,measureScroll,measureMenu,reveal]);

 // overflow="menu": measure after every render; the state only changes when the count does.
 useLayoutEffect(()=>{if(overflow==='menu')measureMenu();});

 // The active tab is always in view: first placement instant, later smooth (unless reduced motion).
 useLayoutEffect(()=>{
  const first=!placed.current;placed.current=true;
  reveal(value,first);
 },[value,itemsKey,reveal]);

 const activate=(item:TabItem)=>onChange(item.id);
 const click=(event:MouseEvent<HTMLElement>,item:TabItem)=>{
  if(item.href&&(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey))return;
  event.preventDefault();activate(item);
 };
 const keyDown=(event:KeyboardEvent<HTMLDivElement>)=>{
  const list=listRef.current;
  if(!list||event.altKey||event.ctrlKey||event.metaKey)return;
  const tabs=tabsOf(list),index=tabs.indexOf(event.target as HTMLElement);
  if(index<0)return;
  // Enter follows a link tab natively (click); Space does not, so it activates here.
  if(event.key===' '&&tabs[index].tagName==='A'){event.preventDefault();const item=visible[index];if(item)activate(item);return;}
  const target=tabKeyTarget(event.key,index,tabs.length);
  if(target===null)return;
  event.preventDefault();
  tabs[target].focus({preventScroll:true});
 };
 const choose=(id:string)=>{onChange(id);requestAnimationFrame(()=>reveal(id,false));};

 const tab=(item:TabItem,index:number)=>{
  const active=item.id===value;
  const props={id:tabId(base,item.id),role:'tab',className:cx('sdx-tab',active&&'active'),'aria-selected':active,'aria-controls':active&&panelId?panelId:undefined,
   tabIndex:index===focusIndex?0:-1,title:item.title,'aria-keyshortcuts':item.shortcut,onClick:(event:MouseEvent<HTMLElement>)=>click(event,item),onFocus:()=>reveal(item.id,false)};
  const content=<><span>{item.label}</span>{item.tag&&<> <span className="sdx-tag">{item.tag}</span></>}{item.count!==undefined&&<b className={item.tone?'sdx-count-'+item.tone:undefined}>{item.count}</b>}</>;
  return item.href?<a key={item.id} href={item.href} aria-current={active?'page':undefined} {...props}>{content}</a>:<button key={item.id} type="button" {...props}>{content}</button>;
 };

 return <nav ref={navRef} className={cx('sdx-tabbar',variant==='underline'?'sdx-tabs':'sdx-tabbar-pill',className)} aria-label={label} data-mode={overflow} data-fade-start={scroll?.start||undefined} data-fade-end={scroll?.end||undefined}>
  <div ref={listRef} role="tablist" aria-label={label} className="sdx-tablist" onKeyDown={keyDown}>{visible.map(tab)}</div>
  {inMenu.length>0&&<Menu label={t('kit.tabs.more')} entries={inMenu.map(item=>({id:item.id,label:item.label,tag:item.tag,onSelect:()=>choose(item.id)}))}
   trigger={<button ref={moreRef} type="button" className={cx('sdx-tabs-more',activeInMenu&&'active')} aria-label={activeInMenu?t('kit.tabs.moreActive',{label:activeLabel}):undefined}><span>{activeInMenu?activeLabel:t('kit.tabs.more')}</span><ChevronDown size={14} aria-hidden/></button>}/>}
 </nav>;
}
