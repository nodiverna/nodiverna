// The one row sort of the kit DataTable (nodiverna-ui §4, "Table with sort, columns, filter and
// CSV"): the analysis tabs pass their rows in the order of lib/ and sort them here by the value of
// the active column. The table itself never sorts.

/** A sortable cell value: strings compare with numeric collation, numbers by value; null and undefined are missing. */
export type TableSortValue=string|number|null|undefined;
/** The sort of a table: the column id and its direction (structurally the kit's TableSort). */
export type RowSort<C extends string=string>={column:C;direction:'asc'|'desc'};

const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
const missing=(value:TableSortValue):value is null|undefined=>value===null||value===undefined||typeof value==='number'&&Number.isNaN(value);
/** Compares two present values ascending: numbers by value, everything else as text with numeric collation. */
export function compareSortValues(a:Exclude<TableSortValue,null|undefined>,b:Exclude<TableSortValue,null|undefined>):number{
 if(typeof a==='number'&&typeof b==='number')return a-b;
 return collator.compare(String(a),String(b));
}

/**
 * The rows sorted by the value of the sort column. Stable: ties keep the input order. Missing values
 * (null, undefined, NaN) go last in both directions. Without a sort, or for a column without a value
 * function, the rows keep the input order. Returns a new array.
 */
export function sortTableRows<Row,C extends string>(rows:readonly Row[],sort:RowSort<C>|null|undefined,values:Partial<Record<C,(row:Row)=>TableSortValue>>):Row[]{
 const value=sort?values[sort.column]:undefined;
 if(!sort||!value)return [...rows];
 const factor=sort.direction==='asc'?1:-1;
 return rows.map((row,index)=>({row,index,key:value(row)}))
  .sort((a,b)=>{
   const aMissing=missing(a.key),bMissing=missing(b.key);
   if(aMissing||bMissing)return aMissing===bMissing?a.index-b.index:aMissing?1:-1;
   return compareSortValues(a.key as string|number,b.key as string|number)*factor||a.index-b.index;
  })
  .map(item=>item.row);
}

/** A value that keeps the input order of the rows: the first row is 0. Sorting it ascending gives the input order. */
export function inputRank<Row>(rows:readonly Row[]):(row:Row)=>number{
 const ranks=new Map<Row,number>();
 rows.forEach((row,index)=>{if(!ranks.has(row))ranks.set(row,index);});
 return row=>ranks.get(row)??rows.length;
}
