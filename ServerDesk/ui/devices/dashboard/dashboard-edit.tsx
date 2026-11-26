'use client';
// The edit controls of one Dashboard widget (docs/dashboard.md): in the widget head a move handle, the menu "Actions
// for {name}" and Remove; at the bottom corner the resize handle and the size. The handles take a pointer drag
// (use-dashboard-drag.ts) and the arrow keys; the menu offers every step as an entry, so nothing needs a drag. A step
// that cannot be taken stays visible and says why. This view only reports what the user asked for; the page changes
// the draft, announces the result and keeps the focus.
import type {KeyboardEvent,PointerEvent} from 'react';
import {ArrowLeft,ArrowRight,ChevronsDownUp,ChevronsLeftRight,ChevronsRightLeft,ChevronsUpDown,GripVertical,MoveDiagonal2,X} from 'lucide-react';
import type {DashboardWidget} from '@/lib/dashboard-layout';
import type {MessageKey} from '@/lib/i18n/translate';
import {useT} from '@/ui/base/locale';
import {IconBtn,Menu,type IconType,type MenuEntry} from '@/ui/kit/kit';
import {resizeStep,shownWidgetSize,type ResizeBlock,type ResizeDirection} from '@/ui/devices/dashboard/dashboard-model';

/** The ids of the two handles of a widget: the page moves the focus to them. */
export const moveHandleId=(id:string)=>'dashboard-move-'+id,resizeHandleId=(id:string)=>'dashboard-resize-'+id;
export const resizeBlockKeys:Readonly<Record<ResizeBlock,MessageKey>>={columns:'dashboard.edit.blockedColumns',widest:'dashboard.edit.blockedWidest',narrowest:'dashboard.edit.blockedNarrowest',tallest:'dashboard.edit.blockedTallest',shortest:'dashboard.edit.blockedShortest'};
const resizeEntries:readonly {direction:ResizeDirection;label:MessageKey;icon:IconType}[]=[
 {direction:'wider',label:'dashboard.edit.wider',icon:ChevronsLeftRight},{direction:'narrower',label:'dashboard.edit.narrower',icon:ChevronsRightLeft},
 {direction:'taller',label:'dashboard.edit.taller',icon:ChevronsUpDown},{direction:'shorter',label:'dashboard.edit.shorter',icon:ChevronsDownUp},
];
/** The place an arrow key on the move handle asks for, or null for another key: Left/Up one earlier, Right/Down one later, Home first, End last. */
export function moveKeyTarget(key:string,index:number,total:number):number|null{
 const to=key==='ArrowLeft'||key==='ArrowUp'?index-1:key==='ArrowRight'||key==='ArrowDown'?index+1:key==='Home'?0:key==='End'?total-1:null;
 return to===null?null:Math.min(total-1,Math.max(0,to));
}
/** The step an arrow key on the resize handle asks for, or null for another key. */
export const resizeKeyDirection=(key:string):ResizeDirection|null=>key==='ArrowRight'?'wider':key==='ArrowLeft'?'narrower':key==='ArrowDown'?'taller':key==='ArrowUp'?'shorter':null;

export type WidgetEditProps={
 widget:DashboardWidget;name:string;
 /** The place of the widget among the shown widgets, and how many there are. */
 index:number;total:number;
 /** The columns the grid shows now. */
 columns:number;
 onMove:(toIndex:number)=>void;onResize:(direction:ResizeDirection)=>void;onRemove:()=>void;
};

/** The controls in the widget head: the move handle, the menu with every step, and Remove. */
export function WidgetEditControls({widget,name,index,total,columns,onMove,onResize,onRemove,onMoveStart}:WidgetEditProps&{onMoveStart:(event:PointerEvent<HTMLElement>)=>void}){
 const t=useT();
 const moveKey=(event:KeyboardEvent)=>{
  const to=moveKeyTarget(event.key,index,total);
  if(to===null)return;
  event.preventDefault();
  if(to!==index)onMove(to);
 };
 const entries:MenuEntry[]=[
  {id:'earlier',label:t('dashboard.edit.earlier'),icon:ArrowLeft,blocked:index<=0?t('dashboard.edit.first'):undefined,onSelect:()=>onMove(index-1)},
  {id:'later',label:t('dashboard.edit.later'),icon:ArrowRight,blocked:index>=total-1?t('dashboard.edit.last'):undefined,onSelect:()=>onMove(index+1)},
  {id:'size-separator',separator:true},{id:'size',heading:t('dashboard.edit.sizeHeading')},
  ...resizeEntries.map(({direction,label,icon}):MenuEntry=>{
   const step=resizeStep(widget,direction,columns);
   return {id:direction,label:t(label),icon,blocked:'blocked' in step?t(resizeBlockKeys[step.blocked]):undefined,onSelect:()=>onResize(direction)};
  }),
  {id:'remove-separator',separator:true},{id:'remove',label:t('dashboard.edit.removeEntry'),icon:X,danger:true,onSelect:onRemove},
 ];
 return <>
  <IconBtn id={moveHandleId(widget.id)} className="sdx-dash-grip" icon={GripVertical} label={t('dashboard.edit.move',{name})} aria-keyshortcuts="ArrowLeft ArrowRight Home End" onPointerDown={onMoveStart} onKeyDown={moveKey}/>
  <Menu label={t('dashboard.edit.actions',{name})} entries={entries}/>
  <IconBtn icon={X} label={t('dashboard.edit.remove',{name})} onClick={onRemove}/>
 </>;
}

/** The resize handle at the bottom corner and the size the widget shows. */
export function WidgetResizeHandle({widget,name,columns,onResize,onResizeStart}:Pick<WidgetEditProps,'widget'|'name'|'columns'|'onResize'>&{onResizeStart:(event:PointerEvent<HTMLElement>)=>void}){
 const t=useT(),shown=shownWidgetSize(widget,columns);
 const resizeKey=(event:KeyboardEvent)=>{
  const direction=resizeKeyDirection(event.key);
  if(!direction)return;
  event.preventDefault();
  onResize(direction);
 };
 return <>
  <span className="sdx-dash-size" aria-hidden="true">{t('dashboard.edit.size',{width:shown.w,height:shown.h})}</span>
  <IconBtn id={resizeHandleId(widget.id)} className="sdx-dash-resize" icon={MoveDiagonal2} label={t('dashboard.edit.resize',{name})} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown" onPointerDown={onResizeStart} onKeyDown={resizeKey}/>
 </>;
}
