'use client';
// Moving and resizing a Dashboard widget with a pointer in edit mode (docs/dashboard.md). The rules are pure and live in
// dashboard-model.ts (dragStarted, dragOver, resizeTarget); this hook only follows the pointer:
// - move: a press on the move handle (any pointer) or on the widget head (mouse or pen) becomes a drag after 4px. While
//   the pointer is over another widget, the dragged widget takes its place; near the top or bottom edge of the
//   workspace the page scrolls. Escape puts the order of the drag start back.
//   A small label with the widget's name follows the pointer (the drag image), because the widget itself jumps to
//   its new place.
// - resize: a press on the resize handle; the pointer distance in whole grid cells changes the width and the height.
// Every pointer action has a keyboard and a menu alternative in dashboard-edit.tsx.
import {useCallback,useEffect,useRef,useState,type PointerEvent as ReactPointerEvent,type RefObject} from 'react';
import {isDashboardWidgetId,resizeDashboardWidget,type DashboardLayout,type DashboardWidgetId} from '@/lib/dashboard-layout';
import {dragOver,dragStarted,resizeTarget,type DragState,type GridCell} from '@/ui/devices/dashboard/dashboard-model';

/** The distance from the top or bottom edge of the workspace in which a drag scrolls the page, and the step per frame. */
const scrollEdge=56,scrollStep=14;
type Session={kind:'move'|'resize';id:DashboardWidgetId;x:number;y:number;started:boolean;state:DragState;cell:GridCell|null;pointerX:number;pointerY:number;frame:number;stop:()=>void};
/** The offset of the drag image from the pointer, so it does not cover what the pointer is over. */
const ghostOffset=12;

/** The cell of the grid inside the container: one column by one row, and the gap. */
export function measureGridCell(container:HTMLElement,columns:number):GridCell|null{
 const grid=container.querySelector<HTMLElement>('.sdx-dash-grid');
 if(!grid||typeof getComputedStyle!=='function')return null;
 // With one column the rows are as high as their content; a step in the height is then one row of the wider grid.
 const style=getComputedStyle(grid),gap=Number.parseFloat(style.columnGap)||0,height=Number.parseFloat(style.gridAutoRows)||Number.parseFloat(style.getPropertyValue('--sdx-dash-row'))||0;
 const width=(grid.clientWidth-gap*(columns-1))/columns;
 return width>0&&height>0?{width,height,gap}:null;
}

export type DashboardDrag={
 /** The widget a pointer moves or resizes now. */
 moving:DashboardWidgetId|null;resizing:DashboardWidgetId|null;
 /** onPointerDown of the move handle and of the widget's cell (which starts a move only from the widget head). */
 moveStart:(id:DashboardWidgetId,surface:'handle'|'cell')=>(event:ReactPointerEvent<HTMLElement>)=>void;
 /** onPointerDown of the resize handle. */
 resizeStart:(id:DashboardWidgetId)=>(event:ReactPointerEvent<HTMLElement>)=>void;
 /** The ref of the drag image, the element that follows the pointer while a widget moves (rendered while `moving` is set). */
 ghost:(node:HTMLElement|null)=>void;
};

export function useDashboardDrag({enabled,layout,columns,container,onLayout}:{
 /** Edit mode is on. */
 enabled:boolean;
 /** The draft the page shows. */
 layout:DashboardLayout;columns:number;
 /** The element that holds the grid and its widgets (each marked data-widget="<id>"). */
 container:RefObject<HTMLElement|null>;
 onLayout:(next:DashboardLayout)=>void}):DashboardDrag{
 const [moving,setMoving]=useState<DashboardWidgetId|null>(null),[resizing,setResizing]=useState<DashboardWidgetId|null>(null);
 const session=useRef<Session|null>(null),latest=useRef({layout,columns,onLayout}),ghostNode=useRef<HTMLElement|null>(null);
 // The drag image moves with the pointer without a render: only its transform changes.
 const placeGhost=useCallback(()=>{
  const node=ghostNode.current,current=session.current;
  if(node&&current)node.style.transform=`translate(${Math.round(current.pointerX+ghostOffset)}px,${Math.round(current.pointerY+ghostOffset)}px)`;
 },[]);
 const ghost=useCallback((node:HTMLElement|null)=>{ghostNode.current=node;placeGhost();},[placeGhost]);
 useEffect(()=>{latest.current={layout,columns,onLayout};});
 // A drag never outlives the edit mode or the page.
 useEffect(()=>{if(!enabled)session.current?.stop();return ()=>{session.current?.stop();};},[enabled]);

 const begin=useCallback((kind:Session['kind'],id:DashboardWidgetId,event:ReactPointerEvent<HTMLElement>)=>{
  if(event.button!==0||session.current||typeof window==='undefined')return;
  const box=container.current,origin=latest.current.layout;
  const current:Session={kind,id,x:event.clientX,y:event.clientY,started:false,state:{id,origin,last:null},cell:kind==='resize'&&box?measureGridCell(box,latest.current.columns):null,pointerX:event.clientX,pointerY:event.clientY,frame:0,stop:()=>{}};
  const widgetAt=(x:number,y:number):DashboardWidgetId|null=>{
   const hit=document.elementFromPoint(x,y)?.closest<HTMLElement>('[data-widget]')?.dataset.widget;
   return isDashboardWidgetId(hit)?hit:null;
  };
  // While a move runs, the workspace scrolls when the pointer rests near its top or bottom edge.
  const scroll=()=>{
   const scroller=box?.closest<HTMLElement>('.sdx-main');
   if(scroller&&current.started){
    const rect=scroller.getBoundingClientRect();
    if(current.pointerY<rect.top+scrollEdge)scroller.scrollTop-=scrollStep;
    else if(current.pointerY>rect.bottom-scrollEdge)scroller.scrollTop+=scrollStep;
   }
   current.frame=requestAnimationFrame(scroll);
  };
  const move=(pointer:PointerEvent)=>{
   const delta={x:pointer.clientX-current.x,y:pointer.clientY-current.y},{layout:draft,columns:shown,onLayout:apply}=latest.current;
   current.pointerX=pointer.clientX;current.pointerY=pointer.clientY;
   if(kind==='resize'){
    const widget=origin.find(item=>item.id===id);
    if(!widget||!current.cell)return;
    const size=resizeTarget(widget,delta,current.cell,shown),next=resizeDashboardWidget(draft,id,size.w,size.h);
    if(next!==draft)apply(next);
    return;
   }
   if(!current.started){
    if(!dragStarted(delta))return;
    current.started=true;setMoving(id);
    if(typeof requestAnimationFrame==='function')current.frame=requestAnimationFrame(scroll);
   }
   placeGhost();
   const step=dragOver(draft,current.state,widgetAt(pointer.clientX,pointer.clientY));
   current.state=step.state;
   if(step.layout!==draft)apply(step.layout);
  };
  const stop=()=>{
   window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop);window.removeEventListener('keydown',key,true);
   if(current.frame&&typeof cancelAnimationFrame==='function')cancelAnimationFrame(current.frame);
   if(session.current===current)session.current=null;
   setMoving(null);setResizing(null);
  };
  // Escape puts the layout of the drag start back (the order of a move, the size of a resize).
  const key=(pressed:KeyboardEvent)=>{
   if(pressed.key!=='Escape')return;
   pressed.preventDefault();pressed.stopPropagation();
   if(latest.current.layout!==origin)latest.current.onLayout(origin);
   stop();
  };
  current.stop=stop;session.current=current;
  if(kind==='resize'){setResizing(id);event.preventDefault();}
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop);window.addEventListener('keydown',key,true);
 },[container,placeGhost]);

 const moveStart=useCallback((id:DashboardWidgetId,surface:'handle'|'cell')=>(event:ReactPointerEvent<HTMLElement>)=>{
  if(!enabled)return;
  if(surface==='cell'){
   // The head of the widget moves it with a mouse or a pen; a touch on the head scrolls the page, and a press on a control is that control's.
   const target=event.target instanceof Element?event.target:null;
   if(event.pointerType==='touch'||!target?.closest('.sdx-card-head')||target.closest('button,a,[role="menuitem"]'))return;
  }
  begin('move',id,event);
 },[begin,enabled]);
 const resizeStart=useCallback((id:DashboardWidgetId)=>(event:ReactPointerEvent<HTMLElement>)=>{if(enabled)begin('resize',id,event);},[begin,enabled]);
 return {moving,resizing,moveStart,resizeStart,ghost};
}
