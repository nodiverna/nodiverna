// Pure helpers of the kit DataTable (ui/kit/data-table.tsx): the next sort of a column
// head, the props of a SortHead from a sort state, whether a scroll region needs a Tab stop, and
// the window of one page. The table itself never sorts, filters or pages; the caller does, with
// these helpers and its own row comparison in lib/.

export type SortDirection='asc'|'desc';
/** The controlled sort of a DataTable: the column id and its direction. */
export type TableSort<C extends string=string>={column:C;direction:SortDirection};

/** A press on the active column flips its direction; a press on another column starts with that column's first direction. */
export function nextTableSort<C extends string>(current:TableSort<C>|null|undefined,column:C,first:SortDirection):TableSort<C>{
 if(current?.column===column)return {column,direction:current.direction==='asc'?'desc':'asc'};
 return {column,direction:first};
}

/** The state a SortHead shows for one column. */
export type SortHeadState={active:boolean;direction:SortDirection;nextDirection:SortDirection};
/** The SortHead state of `column` under `current`, for object sorts ({column,direction}). */
export function tableSortHead<C extends string>(current:TableSort<C>|null|undefined,column:C,first:SortDirection):SortHeadState&{next:TableSort<C>}{
 const next=nextTableSort(current,column,first);
 return {active:current?.column===column,direction:current?.column===column?current.direction:first,nextDirection:next.direction,next};
}

/** Whether a scroll region needs a Tab stop: its content overflows by more than 1 px in either direction. */
export function scrollRegionFocusable({scrollWidth,clientWidth,scrollHeight,clientHeight}:{scrollWidth:number;clientWidth:number;scrollHeight:number;clientHeight:number}):boolean{
 return scrollWidth-clientWidth>1||scrollHeight-clientHeight>1;
}

/**
 * One page of `total` rows. page is clamped into 1…pages (pages is at least 1); from and to are the
 * slice bounds (rows.slice(from,to)); start and end are the 1-based numbers shown ("1–50 of 312"),
 * both 0 without rows.
 */
export function pageWindow(page:number,pageSize:number,total:number):{page:number;pages:number;start:number;end:number;from:number;to:number}{
 const size=Math.max(1,Math.floor(pageSize)||1),count=Math.max(0,Math.floor(total)||0);
 const pages=Math.max(1,Math.ceil(count/size));
 const current=Math.min(pages,Math.max(1,Math.floor(page)||1));
 const from=Math.min(count,(current-1)*size),to=Math.min(count,from+size);
 return {page:current,pages,start:to>from?from+1:0,end:to,from,to};
}
