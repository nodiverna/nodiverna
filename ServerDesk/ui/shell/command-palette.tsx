'use client';
import {memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type ComponentType,type KeyboardEvent,type MouseEvent,type RefObject} from 'react';
import {Search,CornerDownLeft} from 'lucide-react';
import {Dialog} from '@/ui/kit/confirm-dialog';
import {Kbd} from '@/ui/kit/kit';
import {useLocale,useT} from '@/ui/base/locale';
import {afterNextPaint} from '@/ui/base/after-paint';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import '@/ui/shell/command-palette.css';

export type PaletteItem={id:string;group:string;label:string;hint?:string;keywords?:string;Icon:ComponentType<{size?:number}>;run:()=>void};

const normalize=(value:string,locale:Locale)=>value.toLocaleLowerCase(locale).normalize('NFD').replace(/[\u0300-\u036f]/g,'');

// Every search term must appear in the label, hint or keywords. Label matches rank first.
export function filterPaletteItems(items:PaletteItem[],query:string,locale:Locale=defaultLocale):PaletteItem[]{
 const terms=normalize(query,locale).split(/\s+/).filter(Boolean);
 if(!terms.length)return items;
 return items.map(item=>{const label=normalize(item.label,locale),text=`${label} ${normalize(item.hint??'',locale)} ${normalize(item.keywords??'',locale)}`;if(!terms.every(term=>text.includes(term)))return null;const score=label.startsWith(terms[0])?0:label.includes(terms[0])?1:2;return {item,score};}).filter((entry):entry is {item:PaletteItem;score:number}=>!!entry).sort((a,b)=>a.score-b.score).map(entry=>entry.item);
}

/**
 * The command palette (Ctrl/⌘ K, the top-bar search): the kit Dialog in its search variant, named "Search and jump"
 * by its hidden title. Focus starts in the search field and goes back to the element that had it before.
 * Memoized: the console's host (PaletteHost) passes stable props, so a console render (its clock, a data refresh)
 * re-renders nothing here.
 *
 * opening counts the openings (overlay-store.ts); each one gets its own PaletteContent (its key), so it starts with an
 * empty query and reads the items again. Closing (Esc, the scrim, a chosen entry) does constant work in its event: the
 * content element keeps its identity, so no row renders, and the Dialog only hides (closing). The dialog with its rows is
 * removed after the next paint (afterNextPaint), so the palette is gone in that paint and the work that grows with the
 * rows runs in a task of its own. An opening before that teardown keeps the dialog mounted: its new content replaces the
 * old rows, and focus moves into the new field (radix focuses the field only when the dialog mounts).
 */
function CommandPalette({open:requested,opening=0,onOpenChange,getItems}:{open:boolean;opening?:number;onOpenChange:(open:boolean)=>void;getItems:()=>PaletteItem[]}){
 const t=useT();
 const close=useCallback(()=>onOpenChange(false),[onOpenChange]);
 // The opening whose dialog is torn down. While the palette is closed and this lags behind opening, the dialog waits
 // hidden for its teardown: closing for the user, still open for radix.
 const [tornDown,setTornDown]=useState(()=>requested?opening-1:opening);
 const closing=!requested,open=requested||tornDown!==opening;
 useEffect(()=>{
  if(!closing||!open)return;
  return afterNextPaint(()=>setTornDown(opening));
 },[closing,open,opening]);
 const field=useRef<HTMLInputElement>(null);
 // An opening whose dialog was still mounted (the previous opening was not torn down yet): focus into the new field.
 useLayoutEffect(()=>{
  if(requested&&tornDown!==opening-1)field.current?.focus({preventScroll:true});
 },[requested,opening,tornDown]);
 const content=useMemo(()=><PaletteContent key={opening} getItems={getItems} onClose={close} fieldRef={field}/>,[opening,getItems,close]);
 return <Dialog open={open} onOpenChange={onOpenChange} title={t('palette.title')} hideTitle variant="search" closing={closing}>
  {content}
 </Dialog>;
}
export default memo(CommandPalette);

const optionId=(item:PaletteItem)=>'sd-palette-'+item.id;

// Rows mounted at once when the palette opens (more than the 560px list shows), and the rows each later step adds.
// The rest follows in steps of short tasks once the entrance (sdx-rise, --sd-dur 180 ms) has run, so opening never
// builds hundreds of rows in one frame: 280 rows took 230 ms on a slow phone.
const firstRows=24,stepRows=48,entranceMs=200;

/**
 * One result row. Memoized with props that change only for its own item and selection: moving the selection
 * re-renders the row that loses it and the row that gains it, and a keystroke re-renders only rows whose item or
 * selection changed. onPick keeps its identity while the palette is open.
 */
export const PaletteRow=memo(function PaletteRow({item,selected,onPick}:{item:PaletteItem;selected:boolean;onPick:(item:PaletteItem)=>void}){
 return <button type="button" id={optionId(item)} role="option" aria-selected={selected} onClick={()=>onPick(item)}><span className="sd-palette-icon"><item.Icon size={15}/></span><span className="sd-palette-label">{item.label}</span>{item.hint&&<small>{item.hint}</small>}{selected&&<CornerDownLeft size={13} className="sd-palette-enter"/>}</button>;
});

/**
 * The field, the result list and the foot hints. Mounted only while open, so every opening starts with an empty
 * query; the items are read once per opening. ↑/↓ move the selection and scroll it into view; the pointer selects
 * a row only when it really moves onto another one (not when the list scrolls under a resting pointer), and a
 * pointer selection never scrolls the list.
 */
export function PaletteContent({getItems,onClose,fieldRef}:{getItems:()=>PaletteItem[];onClose:()=>void;
 /** The search field, for the palette that moves focus into a new opening's field itself. */
 fieldRef?:RefObject<HTMLInputElement|null>}){
 const [query,setQuery]=useState(''),[index,setIndex]=useState(0),[items]=useState(getItems),[locale]=useLocale();
 const list=useRef<HTMLDivElement>(null);
 // The position ↑/↓ asked for: the effect scrolls it into view once it is selected. -1: nothing to scroll.
 const scrollTarget=useRef(-1);
 // The last pointer position over the list: a mousemove at the same place (the list scrolled under it) selects nothing.
 const pointer=useRef<{x:number;y:number}|null>(null);
 const results=useMemo(()=>filterPaletteItems(items,query,locale),[items,query,locale]);
 // How many rows are mounted; it only grows. The selected row is always mounted (↓ can run ahead of the steps).
 const [mounted,setMounted]=useState(firstRows);
 useEffect(()=>{
  if(mounted>=results.length)return;
  const step=setTimeout(()=>setMounted(count=>count+stepRows),mounted===firstRows?entranceMs:0);
  return ()=>clearTimeout(step);
 },[mounted,results.length]);
 const shown=Math.max(mounted,index+1);
 useEffect(()=>{
  if(scrollTarget.current!==index)return;
  scrollTarget.current=-1;
  list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});
 },[index]);
 const t=useT();
 const pick=useCallback((item:PaletteItem)=>{onClose();item.run();},[onClose]);
 const move=(next:number)=>{scrollTarget.current=next;setIndex(next);};
 const onKey=(event:KeyboardEvent)=>{
  if(event.key==='ArrowDown'){event.preventDefault();move(results.length?(index+1)%results.length:0);}
  else if(event.key==='ArrowUp'){event.preventDefault();move(results.length?(index-1+results.length)%results.length:0);}
  else if(event.key==='Enter'){event.preventDefault();const item=results[index];if(item)pick(item);}
 };
 const onPointer=(event:MouseEvent<HTMLDivElement>)=>{
  const last=pointer.current;
  pointer.current={x:event.clientX,y:event.clientY};
  if(last&&last.x===event.clientX&&last.y===event.clientY)return;
  const option=(event.target as Element|null)?.closest?.('[role="option"]');
  if(!option)return;
  const position=results.findIndex(item=>optionId(item)===option.id);
  if(position<0||position===index)return;
  scrollTarget.current=-1;
  setIndex(position);
 };
 return <div className="sd-palette" onKeyDown={onKey}>
  <div className="sd-palette-search"><Search size={18} aria-hidden/><input value={query} ref={fieldRef} onChange={event=>{setQuery(event.target.value);setIndex(0);scrollTarget.current=-1;if(list.current)list.current.scrollTop=0;}} placeholder={t('palette.placeholder')} aria-label={t('palette.inputLabel')} role="combobox" aria-expanded="true" aria-controls="sd-palette-results" aria-activedescendant={results[index]?optionId(results[index]):undefined} spellCheck={false} autoComplete="off"/><Kbd>Esc</Kbd></div>
  <div className="sd-palette-results" id="sd-palette-results" role="listbox" aria-label={t('palette.title')} ref={list} onMouseMove={onPointer}>
   {results.length?results.slice(0,shown).map((item,position)=><div key={item.id} role="presentation">{item.group!==results[position-1]?.group&&<div className="sd-palette-group" role="presentation">{item.group}</div>}<PaletteRow item={item} selected={position===index} onPick={pick}/></div>):<p className="sd-palette-empty">{t('palette.noResults',{query})}</p>}
  </div>
  <footer className="sd-palette-foot"><span><Kbd>↑</Kbd><Kbd>↓</Kbd> {t('palette.foot.select')}</span><span><Kbd>Enter</Kbd> {t('palette.foot.open')}</span><span><Kbd>F1</Kbd> {t('palette.foot.help')}</span></footer>
 </div>;
}
