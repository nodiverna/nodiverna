'use client';
// The kit table (nodiverna-ui §3 "Table", §4 "Table with sort, columns, filter and CSV"): DataTable
// with the one SortHead, the Toolbar above it and the Pagination in its foot. The wrap is a labelled
// scroll region that takes a Tab stop while it overflows, an empty table keeps its head and shows
// one Empty row, and with `cards` the rows turn into a card list at 760px or narrower. The table
// renders the rows it gets in their order: the caller sorts, filters and pages (helpers in
// data-table-model.ts, comparisons in lib/).
import {Fragment,memo,useEffect,useId,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type DragEvent,type MouseEvent,type ReactNode} from 'react';
import {ArrowDown,ArrowUp,ArrowUpDown,ChevronLeft,ChevronRight,Search,SlidersHorizontal,X} from 'lucide-react';
import {Popover} from 'radix-ui';
import {formatNumber} from '@/lib/i18n/format';
import {Btn,Empty,EntranceList,Facts,IconBtn,cx,type EmptyProps} from '@/ui/kit/kit';
import {Tooltip} from '@/ui/kit/tooltip';
import {useLocale,useT} from '@/ui/base/locale';
import {useNarrowLayout} from '@/ui/base/narrow-layout';
import {pageWindow,tableSortHead,type SortDirection,type TableSort} from '@/ui/kit/data-table-model';
import {useOverflowFocusable} from '@/ui/kit/overflow-focusable';
import {useClockTransition} from '@/ui/base/clock-store';

export {nextTableSort,pageWindow,scrollRegionFocusable,tableSortHead,type SortDirection,type TableSort} from '@/ui/kit/data-table-model';
export {useOverflowFocusable} from '@/ui/kit/overflow-focusable';

// ---- SortHead ----
export type SortHeadProps={label:string;active:boolean;
 /** The current direction while active. */
 direction:SortDirection;
 /** The direction a press sorts by; the button names it. */
 nextDirection:SortDirection;
 onSort:()=>void;className?:string;style?:CSSProperties};
/** The one sortable column head: th with aria-sort and a button that names the next direction. Its props describe the state, so string and object sorts both use it. */
export function SortHead({label,active,direction,nextDirection,onSort,className,style}:SortHeadProps){
 const t=useT(),Icon=active?direction==='asc'?ArrowUp:ArrowDown:ArrowUpDown;
 return <th scope="col" className={className} style={style} aria-sort={active?direction==='asc'?'ascending':'descending':'none'}><button type="button" className={cx('sdx-sort',active&&'active')} aria-label={t(nextDirection==='asc'?'fleet.sortAscending':'fleet.sortDescending',{label})} onClick={onSort}>{label}<Icon size={12} aria-hidden/></button></th>;
}
/** The SortHead props of `column` for an object sort ({column,direction}); onSort gets the next sort. */
export function sortHeadProps<C extends string>(sort:TableSort<C>|null|undefined,column:C,first:SortDirection,onSort:(next:TableSort<C>)=>void):Pick<SortHeadProps,'active'|'direction'|'nextDirection'|'onSort'>{
 const {active,direction,nextDirection,next}=tableSortHead(sort,column,first);
 return {active,direction,nextDirection,onSort:()=>onSort(next)};
}

// ---- Toolbar ----
export type ToolbarSearch={value:string;onChange:(value:string)=>void;
 /** The accessible name of the field. */
 label:string;placeholder?:string;id?:string;
 /** The key that focuses the field (shown as aria-keyshortcuts; the handler lives in console-shortcuts.ts). */
 shortcut?:string};
/** The bar above a table: search, filters, a spacer, actions. At 760px or narrower the search takes the first row. */
export function Toolbar({search,filters,actions,className}:{search?:ToolbarSearch;filters?:ReactNode;actions?:ReactNode;className?:string}){
 const has=(node:ReactNode)=>node!=null&&node!==false&&node!=='';
 return <div className={cx('sdx-toolbar',className)}>
  {search&&<label className="sdx-searchfield sdx-toolbar-search"><Search size={15} aria-hidden/><input id={search.id} type="search" aria-label={search.label} aria-keyshortcuts={search.shortcut} placeholder={search.placeholder} value={search.value} onChange={event=>search.onChange(event.target.value)}/></label>}
  {has(filters)&&<div className="sdx-toolbar-filters">{filters}</div>}
  <span className="sdx-toolbar-spacer"/>
  {has(actions)&&<div className="sdx-toolbar-actions">{actions}</div>}
 </div>;
}

// ---- FilterPopover ----
export type FilterPopoverProps={
 /** The visible text of the trigger, for example "Filters". */
 label:string;
 /** The heading of the popover; it also names the dialog. */
 title:string;
 /** How many filters are set: from 1 the trigger shows it as a badge and the reset button shows. */
 active:number;
 /** The trigger's accessible name while filters are set; it starts with the visible text ("Filters, 2 active"). */
 activeLabel:string;
 onReset:()=>void;resetLabel:string;
 /** The fields, usually Fields with a select. They filter at once; there is no Apply button. The first one takes the focus on open. */
 children:ReactNode;
};
/**
 * Whether the focus goes back to the filter trigger after the popover closed: yes when it is nowhere
 * (body, or the removed field) or on an element that only takes focus from script (tabIndex -1, for
 * example main after a tap on plain text). An outside click on another control leaves the focus there.
 */
export function returnsFocusToTrigger(active:Element|null,body:Element|null):boolean{
 if(!active||active===body||!active.isConnected)return true;
 return (active as HTMLElement).tabIndex<0;
}
/**
 * More filters behind one toolbar button (nodiverna-ui §4, Table): a small labelled dialog on radix
 * Popover. Esc and an outside click close it and focus goes back to the trigger, unless the outside
 * click put it on another control (returnsFocusToTrigger). The surface is the menu look; it fades in
 * and rises 4px (reduced motion: none).
 */
export function FilterPopover({label,title,active,activeLabel,onReset,resetLabel,children}:FilterPopoverProps){
 const titleId=useId(),content=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
 // The reset button leaves with the last filter, so the focus moves to the first field instead of the page.
 const reset=()=>{onReset();requestAnimationFrame(()=>content.current?.querySelector<HTMLElement>('select, input, textarea')?.focus());};
 // Radix skips the focus return after an outside click, and a touch tap lands the focus on main. After the
 // events of that click, the trigger takes the focus back unless another control holds it.
 const closeFocus=(event:Event)=>{event.preventDefault();requestAnimationFrame(()=>{if(returnsFocusToTrigger(document.activeElement,document.body))trigger.current?.focus();});};
 return <Popover.Root>
  <Popover.Trigger asChild><Btn ref={trigger} size="sm" icon={SlidersHorizontal} className="sdx-filter-trigger" count={active} countLabel={activeLabel}>{label}</Btn></Popover.Trigger>
  <Popover.Portal><Popover.Content ref={content} className="sdx-layer sdx-menu sdx-filter-popover" aria-labelledby={titleId} onCloseAutoFocus={closeFocus} align="start" sideOffset={6} collisionPadding={8}>
   <h2 id={titleId} className="sdx-filter-popover-title">{title}</h2>
   <div className="sdx-filter-popover-fields">{children}</div>
   {active>0&&<div className="sdx-filter-popover-foot"><Btn size="sm" variant="ghost" icon={X} onClick={reset}>{resetLabel}</Btn></div>}
  </Popover.Content></Popover.Portal>
 </Popover.Root>;
}

// ---- Pagination ----
export type PaginationProps={
 /** 1-based; clamped into the existing pages. */
 page:number;pageSize:number;total:number;onPage:(page:number)=>void};
/** Previous, the range "1–50 of 312" (announced politely) and next. Renders nothing while everything fits on one page. */
export function Pagination({page,pageSize,total,onPage}:PaginationProps){
 const t=useT(),[locale]=useLocale();
 if(total<=pageSize)return null;
 const view=pageWindow(page,pageSize,total),number=(value:number)=>formatNumber(locale,value);
 return <nav className="sdx-pagination" aria-label={t('kit.pagination.label')}>
  <IconBtn icon={ChevronLeft} className="sdx-icon-btn-framed" label={t('kit.pagination.previous')} blocked={view.page<=1?t('kit.pagination.first'):undefined} onClick={()=>onPage(view.page-1)}/>
  <span className="sdx-pagination-range" aria-live="polite">{t('kit.pagination.range',{start:number(view.start),end:number(view.end),total:number(total)})}</span>
  <IconBtn icon={ChevronRight} className="sdx-icon-btn-framed" label={t('kit.pagination.next')} blocked={view.page>=view.pages?t('kit.pagination.last'):undefined} onClick={()=>onPage(view.page+1)}/>
 </nav>;
}

// ---- DataTable ----
/** Viewport widths below which a column hides (CSS media rules, no JS). */
export type HideBreakpoint=1440|1280|1100|900;
export type DataColumn<Row>={id:string;
 /** The head text; also the label of the column's fact in card mode. */
 label:string;
 /** The cell of a row. now is the row's clock time with the table's rowClock (0 without). */
 cell:(row:Row,now:number)=>ReactNode;
 /** Sortable; the first press sorts in `first`. Needs sort and onSort on the table. */
 sort?:{first:SortDirection};
 align?:'start'|'end';mono?:boolean;
 /** Counts in words ("3 members"): tabular figures in the head and the cells, in the body font (mono switches the font). */
 tabular?:boolean;
 /**
  * Content after the cell, outside the row open button of the primary column (in table and card mode): a focusable part
  * such as a tag with a Tooltip must not sit inside that button.
  */
 aside?:(row:Row)=>ReactNode;
 /** The cell wraps (white-space normal, long words break). */
 wrap?:boolean;
 hideBelow?:HideBreakpoint;width?:number|string;
 /** The row's name: the open button with onOpen, the card title in card mode. */
 primary?:boolean;
 /**
  * layout="fixed": the least width of the primary column, which takes the rest of the table's width (its width is
  * not used). The table's min-width counts it, so the wrap scrolls sideways before the primary column gets narrower.
  */
 minWidth?:number|string;
 /** false leaves the column out of the cards. */
 card?:boolean;
 /** false leaves the column out of the table: a fact only in card mode, for a line the table columns already spell out. */
 table?:boolean;
 /** The head text is only for screen readers (sr-only), for example a row menu column. */
 hideLabel?:boolean;
 /** An extra class of the head and the cells, for example sdx-col-actions or sdx-col-check. */
 className?:string};
export type DataTableProps<Row>={columns:readonly DataColumn<Row>[];rows:readonly Row[];rowKey:(row:Row)=>string;
 /** The accessible name of the scroll region (and of the card list). */
 label:string;
 sort?:TableSort|null;onSort?:(next:TableSort)=>void;
 /** Rows open on click (not on their controls) and through the primary cell's button. */
 onOpen?:(row:Row)=>void;openLabel?:(row:Row)=>string;
 /** The cause-specific empty state; shown as the one row of an empty table. */
 empty:EmptyProps;
 /** The foot text, for example "12 of 40 products"; not shown without rows. */
 foot?:ReactNode;
 /** The pages, in the foot next to the foot text. */
 pagination?:PaginationProps;
 /** The Toolbar, rendered above the wrap. */
 toolbar?:ReactNode;
 /** Cards instead of the table at 760px or narrower (after mount; SSR shows the table). */
 cards?:boolean;
 /** The rows (or cards) rise in on their first load in this page load. */
 entranceId?:string;
 /** flush: no own border, radius or shadow, for use inside a Card flush. */
 variant?:'default'|'flush';
 /** Marks a stale view while a newer one loads. */
 busy?:boolean;
 /**
  * The rowKey of the row (and card) to highlight, or several: every match gets .sdx-row-highlight and
  * data-row-key, and the first match in row order also tabIndex -1 as the one focus target.
  */
 highlightKey?:string|readonly string[];
 /**
  * The rowKeys of rows (and cards) that leave the list, for example a deleted entry the page still shows for one
  * fade: they get .sdx-row-leaving (they fade out), inert and aria-hidden, then the page drops them.
  */
 leavingKeys?:readonly string[];
 /**
  * Selectable rows: a first column .sdx-col-check with a head checkbox that selects or clears all given rows
  * (indeterminate while some are selected, disabled without rows) and one checkbox per row; rows get aria-selected.
  * onChange gets the whole new selection: keys of rows that are not shown stay as they are.
  * In card mode each card gets the checkbox before its title, and a labelled "select all" checkbox sits above the cards.
  */
 selection?:TableSelection<Row>;
 /** Extra row attributes, for example draggable rows. */
 rowProps?:(row:Row)=>TableRowProps;
 /**
  * Rows that show values of the console clock (a connection state, a relative time): the clock-derived state of a row
  * as a string or number. A row renders again when its value changes, and its cells get the time as their second
  * argument. Keep its identity across renders.
  */
 rowClock?:(row:Row,now:number)=>unknown;
 /** The actions column (.sdx-col-actions) sticks to the right edge while the table scrolls sideways. */
 stickyActions?:boolean;
 /**
  * auto (default): the browser sizes every column from all of its cells, so a change of any row lays out the whole
  * table. fixed (.sdx-table-fixed, table-layout fixed): every column but the primary one takes its `width` from its
  * head, the primary column takes the rest (at least its `minWidth`), and a change of a row lays out only that row.
  * Give every other column a width. The table's min-width is the sum (fixedTableMinWidth); a cell clips what does
  * not fit, text with an ellipsis. For long lists whose rows change together, such as the fleet on a heartbeat.
  */
 layout?:'auto'|'fixed';
 /**
  * Rows whose object changed (same rowKey, a new row) render their new content at most this many per frame, top
  * first; the rest keep showing their last content until their turn (useRowChunks). New, removed and moved rows apply
  * at once. For a long list whose rows all change together, such as the fleet on a heartbeat: the browser then
  * renders and lays out one chunk per frame instead of every row in one long frame.
  */
 rowChunk?:number;
 className?:string};
export type TableSelection<Row>={selected:readonly string[];onChange:(keys:string[])=>void;
 /** The accessible name of a row's checkbox, for example "Select SRV-01". */
 rowLabel:(row:Row)=>string;
 /** The accessible name of the head checkbox, for example "Select all visible devices". */
 allLabel:string;
 /** false: the row renders no checkbox, and the head checkbox selects and counts only selectable shown rows. */
 selectable?:(row:Row)=>boolean;
 /**
  * Why an unselected row cannot be selected now (for example a selection limit): its checkbox stays
  * focusable with aria-disabled, changes nothing on click or Space and shows the reason in the kit Tooltip
  * (aria-describedby). A selected row is never blocked, so it can always be cleared.
  */
 blocked?:(row:Row)=>string|undefined};
/** The keys of the shown rows that can be selected (selection.selectable). */
export function selectableKeys<Row>(rows:readonly Row[],rowKey:(row:Row)=>string,selection:Pick<TableSelection<Row>,'selectable'>):string[]{
 return rows.flatMap(row=>selection.selectable?.(row)===false?[]:[rowKey(row)]);
}
/** The block reason of a row's checkbox: none while the row is selected. */
export function rowBlocked<Row>(row:Row,key:string,selection:Pick<TableSelection<Row>,'selected'|'blocked'>):string|undefined{
 return selection.selected.includes(key)?undefined:selection.blocked?.(row)||undefined;
}
export type TableRowProps={draggable?:boolean;onDragStart?:(event:DragEvent<HTMLTableRowElement>)=>void};
/** The new selection after the head checkbox: all given rows added, or all given rows removed. */
export function selectAllRows(selected:readonly string[],keys:readonly string[],checked:boolean):string[]{
 return checked?[...new Set([...selected,...keys])]:selected.filter(key=>!keys.includes(key));
}
/** The new selection after one row's checkbox. */
export function selectRow(selected:readonly string[],key:string,checked:boolean):string[]{
 return checked?[...new Set([...selected,key])]:selected.filter(value=>value!==key);
}

// ---- BulkBar ----
/**
 * The action strip of a selection (nodiverna-ui §4 Table): a labelled region with the count "N selected"
 * (aria-live polite), the actions (children) and "Clear selection". Nothing at count 0; it rises in once
 * when it appears (sdx-rise) and stays put while the selection changes.
 */
export function BulkBar({count,onClear,label,children}:{count:number;onClear:()=>void;
 /** The region's name; default kit.bulk.label ("Selection"). */
 label?:string;children?:ReactNode}){
 const t=useT();
 if(count<=0)return null;
 return <div className="sdx-bulkbar" role="region" aria-label={label??t('kit.bulk.label')}>
  <strong aria-live="polite">{t('kit.bulk.selected',{count})}</strong>
  {children}
  <IconBtn icon={X} label={t('kit.bulk.clear')} onClick={onClear}/>
 </div>;
}

const hideClass=(column:DataColumn<never>)=>column.hideBelow?'sdx-hide-below-'+column.hideBelow:undefined;
const headClass=(column:DataColumn<never>)=>cx(column.align==='end'&&'sdx-cell-end',column.tabular&&'sdx-cell-tabular',hideClass(column),column.className)||undefined;
const cellClass=(column:DataColumn<never>)=>cx(column.align==='end'&&'sdx-cell-end',column.mono&&'mono',column.tabular&&'sdx-cell-tabular',column.wrap&&'sdx-cell-wrap',hideClass(column),column.className)||undefined;
const rowControls='button, a, input, label, select, [role="menu"]';
/**
 * A click on the row itself, not on one of its controls. React bubbles a click inside a portal (the
 * items of a row Menu, a dialog it opens) through the row's onClick although the DOM node sits outside
 * the row, so only clicks on DOM descendants of the row count.
 */
const rowClick=<Row,>(row:Row,onOpen:(row:Row)=>void)=>(event:MouseEvent<HTMLElement>)=>{
 if(!event.currentTarget.contains(event.target as Node))return;
 const control=(event.target as HTMLElement).closest(rowControls);
 if(control&&event.currentTarget.contains(control))return;
 onOpen(row);
};
const primaryOf=<Row,>(columns:readonly DataColumn<Row>[])=>columns.find(column=>column.primary)??columns[0];
const cssLength=(value:number|string)=>typeof value==='number'?`${value}px`:value;
/**
 * The min-width of a fixed-layout table: the selection column (--sd-col-check), the width of every other column and
 * the minWidth of the primary column. A column with hideBelow counts only while it shows: its width is multiplied by
 * --sdx-col-shown-<breakpoint>, which the console sheet sets to 0 below that viewport width (the media rules of
 * .sdx-hide-below-*). Columns without a width count 0. Exported for tests.
 */
export function fixedTableMinWidth<Row>(columns:readonly DataColumn<Row>[],selection:boolean):string{
 const primary=primaryOf(columns);
 const parts=columns.flatMap(column=>{
  const width=column===primary?column.minWidth:column.width;
  if(width==null)return [];
  return [column.hideBelow?`${cssLength(width)} * var(--sdx-col-shown-${column.hideBelow}, 1)`:cssLength(width)];
 });
 if(selection)parts.unshift('var(--sd-col-check)');
 return parts.length?`calc(${parts.join(' + ')})`:'0px';
}

/** Whether the row key is one of the highlighted keys. */
const highlighted=(key:string,highlightKey:string|readonly string[]|undefined)=>highlightKey!==undefined&&(typeof highlightKey==='string'?key===highlightKey:highlightKey.includes(key));
const activationKeys=new Set([' ','Spacebar']);
/**
 * The checkbox of one row or card in .sdx-check-hit. Blocked (rowBlocked): focusable, aria-disabled, click and Space
 * change nothing, the reason shows in the kit Tooltip on hover, focus and tap and stays its description.
 */
function RowCheck({rowKey:key,label,selected,blocked,onCheck}:{rowKey:string;label:string;selected:boolean;blocked?:string;onCheck:(key:string,checked:boolean)=>void}){
 const reasonId=useId(),[tip,setTip]=useState(false);
 if(!blocked)return <label className="sdx-check-hit"><input type="checkbox" aria-label={label} checked={selected} onChange={event=>onCheck(key,event.target.checked)}/></label>;
 return <label className="sdx-check-hit sdx-check-blocked">
  <Tooltip content={blocked} open={tip} onOpenChange={setTip}>
   <input type="checkbox" aria-label={label} checked={false} aria-disabled="true" aria-describedby={reasonId} onChange={()=>undefined} onClick={event=>event.preventDefault()} onKeyDown={event=>{if(activationKeys.has(event.key))event.preventDefault();}} onPointerDown={event=>{if(event.pointerType==='touch')setTip(open=>!open);}}/>
  </Tooltip>
  <span id={reasonId} className="sr-only">{blocked}</span>
 </label>;
}
/** The head checkbox of a selection: checked when every selectable shown row is selected, indeterminate for some, disabled without selectable rows. */
function AllCheck<Row>({keys,selection,label}:{keys:readonly string[];selection:TableSelection<Row>;label?:string}){
 const state=selectionState(selection.selected,keys);
 return <input type="checkbox" aria-label={label} checked={state.all} ref={element=>{if(element)element.indeterminate=state.some;}} disabled={!keys.length} onChange={event=>selection.onChange(selectAllRows(selection.selected,keys,event.target.checked))}/>;
}
/** Whether a column is a row actions column (its class holds sdx-col-actions): in card mode it sits at the end of the title line, also with card:false. */
export const isActionsColumn=(column:Pick<DataColumn<never>,'className'>)=>!!column.className?.split(/\s+/).includes('sdx-col-actions');
/** How many of the shown keys are selected: all of them (and at least one), or some. */
function selectionState(selected:readonly string[],keys:readonly string[]){
 const chosen=keys.filter(key=>selected.includes(key)).length,all=keys.length>0&&chosen===keys.length;
 return {all,some:chosen>0&&!all};
}

// ---- Rows ----
// Every row (and card) is a memoized component: it renders again only when its row object, its selection state, its
// highlight or the table's columns change. Its other props are primitives or keep their identity: the table hands
// every row the same handlers object, which calls the latest onOpen, selection and rowProps of the table. With
// rowClock, a row also follows the console clock and renders again only when rowClock's value for it changes.

/** The table's row handlers: one object per table that keeps its identity and calls the latest props. */
type RowHandlers<Row>={open:(row:Row)=>void;check:(key:string,checked:boolean)=>void;dragStart:(row:Row,event:DragEvent<HTMLTableRowElement>)=>void};
function useRowHandlers<Row>(onOpen:((row:Row)=>void)|undefined,selection:TableSelection<Row>|undefined,rowProps:((row:Row)=>TableRowProps)|undefined):RowHandlers<Row>{
 const latest=useRef({onOpen,selection,rowProps});
 useLayoutEffect(()=>{latest.current={onOpen,selection,rowProps};});
 return useMemo<RowHandlers<Row>>(()=>({
  open:row=>latest.current.onOpen?.(row),
  check:(key,checked)=>{const current=latest.current.selection;if(current)current.onChange(selectRow(current.selected,key,checked));},
  dragStart:(row,event)=>latest.current.rowProps?.(row).onDragStart?.(event),
 }),[]);
}
/** The props of one row or card. */
type RowProps<Row>={row:Row;rowKey:string;handlers:RowHandlers<Row>;
 /** The row opens (onOpen); openLabel names its open button. */
 openable:boolean;openLabel?:string;
 /** undefined without a selection; false: this row has no checkbox (selection.selectable). */
 checkable?:boolean;selected:boolean;checkLabel?:string;
 /** The reason an unselected row cannot be selected now (selection.blocked). */
 blocked?:string;
 /** highlightKey: the row is marked; focusTarget: it is the first mark, the one focus target. */
 highlight:boolean;focusTarget:boolean;
 draggable:boolean;
 /** leavingKeys: the row fades out. */
 leaving:boolean;
 rowClock?:(row:Row,now:number)=>unknown;
 /** Set by EntranceList while the row rises in. */
 className?:string;style?:CSSProperties};
/** The per-row props a table computes in its render: primitives only, so equal rows compare equal. */
function rowPropsOf<Row>(row:Row,key:string,{openLabel,highlightKey,first,selection,rowProps,leavingKeys}:{openLabel?:(row:Row)=>string;highlightKey?:string|readonly string[];first?:string;selection?:TableSelection<Row>;rowProps?:(row:Row)=>TableRowProps;leavingKeys?:readonly string[]}){
 const highlight=highlighted(key,highlightKey),checkable=selection?selection.selectable?.(row)!==false:undefined;
 return {
  rowKey:key,openLabel:openLabel?.(row),highlight,focusTarget:highlight&&key===first,
  checkable,selected:!!selection?.selected.includes(key),checkLabel:checkable?selection!.rowLabel(row):undefined,blocked:checkable?rowBlocked(row,key,selection!):undefined,
  draggable:!!rowProps?.(row).draggable,
  leaving:!!leavingKeys?.includes(key),
 };
}
/**
 * The next rows of a chunked table (useRowChunks): every row of `rows`, except that of the rows `previous` showed whose
 * object changed only the first `size` (in row order) take their new object; the others keep the one they showed.
 * New rows take theirs at once. `rows` itself once nothing is left behind. Exported for tests.
 */
export function nextRowChunk<Row>(rows:readonly Row[],previous:readonly Row[],rowKey:(row:Row)=>string,size:number):readonly Row[]{
 const before=new Map(previous.map(row=>[rowKey(row),row]));
 let budget=size,behind=false;
 const shown=rows.map(row=>{
  const old=before.get(rowKey(row));
  if(old===undefined||old===row)return row;
  if(budget>0){budget--;return row;}
  behind=true;return old;
 });
 return behind?shown:rows;
}
/**
 * The rows a table renders with rowChunk (nextRowChunk): a new `rows` shows its first chunk of changed rows at once,
 * and each later chunk follows one animation frame after the last one rendered, until every row shows its new object.
 * Order, membership and the row count always follow `rows`. Without size: `rows` as they are.
 */
function useRowChunks<Row>(rows:readonly Row[],rowKey:(row:Row)=>string,size:number|undefined):readonly Row[]{
 const [state,setState]=useState({rows,shown:rows,size});
 let current=state;
 // A new rows array starts its first chunk in this render (state derived from props). A new chunk size (no size in
 // card mode) starts over with every row as given.
 if(state.size!==size||(size&&state.rows!==rows)){
  current={rows,shown:size&&state.size===size?nextRowChunk(rows,state.shown,rowKey,size):rows,size};
  setState(current);
 }
 const behind=!!size&&current.shown!==current.rows;
 useEffect(()=>{
  if(!behind||!size)return;
  const frame=requestAnimationFrame(()=>setState(previous=>({...previous,shown:nextRowChunk(previous.rows,previous.shown,rowKey,size)})));
  return ()=>cancelAnimationFrame(frame);
 },[behind,current.shown,rowKey,size]);
 return size?current.shown:rows;
}

/** The first highlighted key in row order: the one focus target. */
const firstHighlight=<Row,>(rows:readonly Row[],rowKey:(row:Row)=>string,highlightKey:string|readonly string[]|undefined)=>highlightKey===undefined?undefined:rows.map(rowKey).find(key=>highlighted(key,highlightKey));
/** data-row-key on every marked row, tabIndex -1 only on the first. */
const markAttributes=(key:string,highlight:boolean,focusTarget:boolean)=>highlight?{...(focusTarget?{tabIndex:-1}:{}),'data-row-key':key}:{};
const rowCheck=<Row,>({rowKey:key,checkLabel,selected,blocked,handlers}:RowProps<Row>)=><RowCheck rowKey={key} label={checkLabel??''} selected={selected} blocked={blocked} onCheck={handlers.check}/>;
/** The cell of the primary column: the open button when the row opens. */
const openCell=<Row,>({row,openable,openLabel,handlers}:RowProps<Row>,content:ReactNode)=>openable?<button type="button" className="sdx-row-open" aria-label={openLabel} onClick={()=>handlers.open(row)}>{content}</button>:content;
/** The cell content and the column's aside next to it, on one line that wraps. */
const withAside=<Row,>(column:DataColumn<Row>,row:Row,content:ReactNode)=>column.aside?<span className="sdx-cell-aside">{content}{column.aside(row)}</span>:content;

type TableRowViewProps<Row>=RowProps<Row>&{columns:readonly DataColumn<Row>[];primary?:DataColumn<Row>};
function tableRow<Row>(props:TableRowViewProps<Row>,now:number){
 const {row,rowKey:key,columns,primary,handlers,openable,checkable,selected,highlight,focusTarget,draggable,leaving,className,style}=props;
 return <tr className={cx(openable&&'sdx-row-clickable',highlight&&'sdx-row-highlight',leaving&&'sdx-row-leaving',className)||undefined} {...markAttributes(key,highlight,focusTarget)} {...(leaving?{inert:true,'aria-hidden':true}:{})} {...(checkable!==undefined?{'aria-selected':selected}:{})} {...(draggable?{draggable:true,onDragStart:(event:DragEvent<HTMLTableRowElement>)=>handlers.dragStart(row,event)}:{})} onClick={openable?rowClick(row,handlers.open):undefined} style={style}>
  {checkable!==undefined&&<td className="sdx-col-check">{checkable&&rowCheck(props)}</td>}
  {columns.map(column=><td key={column.id} className={cellClass(column)}>{withAside(column,row,column===primary?openCell(props,column.cell(row,now)):column.cell(row,now))}</td>)}
 </tr>;
}
const DataRow=memo(function DataRow<Row>(props:TableRowViewProps<Row>){return tableRow(props,0);}) as <Row>(props:TableRowViewProps<Row>)=>ReactNode;
const ClockedDataRow=memo(function ClockedDataRow<Row>(props:TableRowViewProps<Row>){
 const {row,rowClock}=props,now=useClockTransition(time=>rowClock!(row,time));
 return tableRow(props,now);
}) as <Row>(props:TableRowViewProps<Row>)=>ReactNode;

/** The columns of a card: the title, the actions at the end of the title line, the facts. */
type CardLayout<Row>={primary?:DataColumn<Row>;actions:readonly DataColumn<Row>[];facts:readonly DataColumn<Row>[]};
type CardViewProps<Row>=RowProps<Row>&{layout:CardLayout<Row>};
function dataCard<Row>(props:CardViewProps<Row>,now:number){
 const {row,rowKey:key,layout:{primary,actions,facts},handlers,openable,checkable,selected,highlight,focusTarget,leaving,className,style}=props;
 return <li className={cx('sdx-data-card',openable&&'sdx-data-card-open sdx-lift',selected&&'sdx-data-card-selected',highlight&&'sdx-row-highlight',leaving&&'sdx-row-leaving',className)} {...markAttributes(key,highlight,focusTarget)} {...(leaving?{inert:true,'aria-hidden':true}:{})} onClick={openable?rowClick(row,handlers.open):undefined} style={style}>
  <div className={cx('sdx-data-card-title',checkable!==undefined&&'sdx-data-card-title-check',actions.length>0&&'sdx-data-card-title-actions')}>
   {checkable!==undefined&&(checkable?rowCheck(props):<span aria-hidden="true"/>)}
   {primary&&withAside(primary,row,openCell(props,primary.cell(row,now)))}
   {actions.length>0&&<span className="sdx-data-card-actions">{actions.map(column=><Fragment key={column.id}>{column.cell(row,now)}</Fragment>)}</span>}
  </div>
  {facts.length>0&&<Facts items={facts.map(column=>({id:column.id,label:column.label,value:withAside(column,row,column.cell(row,now)),mono:column.mono}))}/>}
 </li>;
}
const DataCard=memo(function DataCard<Row>(props:CardViewProps<Row>){return dataCard(props,0);}) as <Row>(props:CardViewProps<Row>)=>ReactNode;
const ClockedDataCard=memo(function ClockedDataCard<Row>(props:CardViewProps<Row>){
 const {row,rowClock}=props,now=useClockTransition(time=>rowClock!(row,time));
 return dataCard(props,now);
}) as <Row>(props:CardViewProps<Row>)=>ReactNode;

/**
 * The card list of a DataTable: the primary column as the title, every other column without card:false as a fact.
 * With a selection, a checkbox sits before each title (the card gets the selection look) and one "select all"
 * checkbox with its label sits above the list; aria-selected is not allowed on a list item, so the checkbox
 * carries the state. Exported for tests.
 */
export function DataCards<Row>({columns,rows,rowKey,label,onOpen,openLabel,entranceId,highlightKey,leavingKeys,selection,rowClock}:Pick<DataTableProps<Row>,'columns'|'rows'|'rowKey'|'label'|'onOpen'|'openLabel'|'entranceId'|'highlightKey'|'leavingKeys'|'selection'|'rowClock'>){
 // Row actions keep working on a phone: every sdx-col-actions column sits at the end of the title line, whatever card says.
 const layout=useMemo<CardLayout<Row>>(()=>{const primary=primaryOf(columns);return {primary,actions:columns.filter(column=>column!==primary&&isActionsColumn(column)),facts:columns.filter(column=>column!==primary&&!isActionsColumn(column)&&column.card!==false)};},[columns]);
 const handlers=useRowHandlers(onOpen,selection,undefined),first=firstHighlight(rows,rowKey,highlightKey);
 const Card=rowClock?ClockedDataCard:DataCard;
 const items=rows.map(row=>{const key=rowKey(row);return <Card key={key} row={row} layout={layout} handlers={handlers} openable={!!onOpen} rowClock={rowClock} {...rowPropsOf(row,key,{openLabel,highlightKey,first,selection,leavingKeys})}/>;});
 const list=entranceId?<EntranceList id={entranceId} as="ul" className="sdx-data-cards" role="list" label={label}>{items}</EntranceList>:<ul className="sdx-data-cards" role="list" aria-label={label}>{items}</ul>;
 if(!selection)return list;
 // The visible text names the checkbox; the hit area and the text form one 32px target.
 return <>
  <label className="sdx-data-cards-all"><span className="sdx-check-hit"><AllCheck keys={selectableKeys(rows,rowKey,selection)} selection={selection}/></span><span>{selection.allLabel}</span></label>
  {list}
 </>;
}

export function DataTable<Row>({columns:allColumns,rows,rowKey,label,sort,onSort,onOpen,openLabel,empty,foot,pagination,toolbar,cards=false,entranceId,variant='default',busy,highlightKey,leavingKeys,selection,rowProps,rowClock,stickyActions=false,layout='auto',rowChunk,className}:DataTableProps<Row>){
 const cardMode=useNarrowLayout(cards),columns=useMemo(()=>allColumns.filter(column=>column.table!==false),[allColumns]);
 const fixed=layout==='fixed',selectable=!!selection;
 const minWidth=useMemo(()=>fixed?fixedTableMinWidth(columns,selectable):undefined,[fixed,columns,selectable]);
 // The min-width changes with the columns' widths too (a wider status column), so the overflow is measured again.
 const [ref,focusable]=useOverflowFocusable<HTMLDivElement>(`${cardMode}:${rows.length}:${columns.length}${minWidth?':'+minWidth:''}`);
 // A new page starts at the top of the list; focus stays on the pressed button.
 const page=pagination?.page,shownPage=useRef(page);
 useEffect(()=>{
  if(shownPage.current===page)return;
  shownPage.current=page;
  const wrap=ref.current;
  if(!wrap)return;
  wrap.scrollTop=0;
  const top=wrap.getBoundingClientRect().top;
  if(top<0||top>window.innerHeight)wrap.scrollIntoView({block:'start'});
 },[page,ref]);
 const handlers=useRowHandlers(onOpen,selection,rowProps),shownRows=useRowChunks(rows,rowKey,cardMode?undefined:rowChunk);
 const hasRows=rows.length>0,primary=primaryOf(columns),first=firstHighlight(rows,rowKey,highlightKey);
 const footText=foot!=null&&foot!==false&&foot!=='';
 const footBar=hasRows&&(footText||pagination)?<div className="sdx-table-foot">{footText&&<p>{foot}</p>}{pagination&&<Pagination {...pagination}/>}</div>:null;
 const keys=selection?selectableKeys(rows,rowKey,selection):[];
 const span=columns.length+(selection?1:0);
 const TableRow=rowClock?ClockedDataRow:DataRow;
 const rowElements=cardMode?[]:shownRows.map(row=>{const key=rowKey(row);return <TableRow key={key} row={row} columns={columns} primary={onOpen?primary:undefined} handlers={handlers} openable={!!onOpen} rowClock={rowClock} {...rowPropsOf(row,key,{openLabel,highlightKey,first,selection,rowProps,leavingKeys})}/>;});
 // fixed: the head carries every width (the browser reads only the first row), the primary column has none.
 const table=<table className={cx('sdx-table','sdx-data-table',stickyActions&&'sdx-table-sticky-actions',fixed&&'sdx-table-fixed')} style={minWidth?{minWidth}:undefined}>
  <thead><tr>{selection&&<th scope="col" className="sdx-col-check"><label className="sdx-check-hit"><AllCheck keys={keys} selection={selection} label={selection.allLabel}/></label></th>}{columns.map(column=>{
   const style=column.width!=null&&!(fixed&&column===primary)?{width:column.width}:undefined;
   if(column.sort&&onSort)return <SortHead key={column.id} label={column.label} className={headClass(column)} style={style} {...sortHeadProps(sort,column.id,column.sort.first,onSort)}/>;
   return <th key={column.id} scope="col" className={headClass(column)} style={style}>{column.hideLabel?<span className="sr-only">{column.label}</span>:column.label}</th>;
  })}</tr></thead>
  {!hasRows?<tbody><tr className="sdx-table-empty"><td colSpan={span}><Empty {...empty}/></td></tr></tbody>
   :entranceId?<EntranceList id={entranceId} as="tbody">{rowElements}</EntranceList>:<tbody>{rowElements}</tbody>}
 </table>;
 return <>
  {toolbar}
  <div ref={ref} className={cx('sdx-table-wrap',variant==='flush'&&'sdx-table-wrap-flush',cardMode&&'sdx-table-wrap-cards',className)} role="region" aria-label={label} tabIndex={focusable?0:undefined} aria-busy={busy||undefined}>
   {!cardMode?table:hasRows?<DataCards columns={allColumns} rows={rows} rowKey={rowKey} label={label} onOpen={onOpen} openLabel={openLabel} entranceId={entranceId} highlightKey={highlightKey} leavingKeys={leavingKeys} rowClock={rowClock} selection={selection}/>:<Empty {...empty}/>}
   {footBar}
  </div>
 </>;
}
