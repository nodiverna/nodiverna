// Pure geometry and keyboard logic of the kit Tabs (ui/kit/tabs.tsx): revealing the active
// tab in a sideways scrolling strip, the overflow state behind the edge fades and "More", the
// number of tabs that fit next to "More", and roving focus. Without React or DOM, so a plain Node
// test can call it.

export type TabStrip={scrollLeft:number;clientWidth:number};
/** offsetLeft is measured in the strip's scroll content, from its padding edge. */
export type StripTab={offsetLeft:number;offsetWidth:number};

/**
 * The scrollLeft that brings the tab fully inside the strip's visible area, keeping
 * the strip's side padding free, or null when the tab is already fully visible.
 * A tab wider than the visible area aligns its left edge.
 */
export function revealScrollLeft(strip:TabStrip,tab:StripTab,padding:number):number|null{
 const start=strip.scrollLeft+padding,end=strip.scrollLeft+strip.clientWidth-padding;
 const tabEnd=tab.offsetLeft+tab.offsetWidth;
 let next:number;
 if(tab.offsetLeft<start||tab.offsetWidth>end-start)next=tab.offsetLeft-padding;
 else if(tabEnd>end)next=tabEnd+padding-strip.clientWidth;
 else return null;
 next=Math.max(0,next);
 // Sub-pixel layout differences are no reason to move the strip.
 return Math.abs(next-strip.scrollLeft)<1?null:next;
}

/** Where the strip's content is cut: at the start, at the end, or both. 1px of slack absorbs sub-pixel layout. */
export function stripOverflow({scrollLeft,clientWidth,scrollWidth}:{scrollLeft:number;clientWidth:number;scrollWidth:number}):{start:boolean;end:boolean}{
 return {start:scrollLeft>1,end:scrollLeft+clientWidth<scrollWidth-1};
}

/** Indexes of the tabs that are not fully inside the strip's visible area (1px of slack), in order. */
export function hiddenTabs(tabs:readonly StripTab[],strip:TabStrip):number[]{
 const start=strip.scrollLeft-1,end=strip.scrollLeft+strip.clientWidth+1;
 return tabs.flatMap((tab,index)=>tab.offsetLeft<start||tab.offsetLeft+tab.offsetWidth>end?[index]:[]);
}

/**
 * How many leading tabs fit into `available` px: all of them if their widths add up to it,
 * otherwise as many as fit next to the "More" trigger (moreWidth). Widths include the gap.
 * withMore is the room while "More" shows, where the bar's padding differs from the full row
 * (the underline bar at ≤900px): each answer is checked against the room of the layout it
 * produces, so the answer cannot flip the room it was measured in. Without "More" no tab fits
 * that did not fit in the full row, so the answer never drops "More" again.
 */
export function fittingTabs(widths:readonly number[],available:number,moreWidth:number,withMore=available):number{
 const total=widths.reduce((sum,width)=>sum+width,0);
 if(total<=available+1)return widths.length;
 let used=moreWidth,count=0;
 for(const width of widths){
  if(used+width>withMore+1)break;
  used+=width;count++;
 }
 return Math.max(0,Math.min(count,widths.length-1));
}

/** The tab that a key moves focus to: arrows wrap, Home and End jump. Other keys: null. */
export function tabKeyTarget(key:string,index:number,count:number):number|null{
 if(count<=0)return null;
 if(key==='ArrowRight')return (index+1)%count;
 if(key==='ArrowLeft')return (index-1+count)%count;
 if(key==='Home')return 0;
 if(key==='End')return count-1;
 return null;
}
