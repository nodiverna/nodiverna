import {sortTableRows,type RowSort} from '@/ui/base/table-sort';
export type FileEditTarget={kind:'mkdir'|'rename';path:string;name?:string};

// Keep the operation target independent of table selection and refreshed data.
// Opening another row or finishing an upload must never retarget an editor.
export function fileEditParameters(target:FileEditTarget,name:string):Record<string,string>{
 return target.kind==='mkdir'?{path:target.path.replace(/[\\/]+$/,'')+'\\'+name}:{path:target.path,name};
}

/** A row of a folder listing, as the agent reports it (list-files). */
export type FileListEntry={name:string;kind:'directory'|'file';size?:number;modifiedAt?:string};
/** The sortable columns of the folder listing. */
export type FileSortColumn='name'|'size'|'modified';
/**
 * The rows of a folder listing in the order of the table sort: folders always first, then the files; inside
 * each group by the sort column (sortTableRows, missing values last). Without a sort the name ascends.
 */
export function sortFileEntries<Row extends FileListEntry>(rows:readonly Row[],sort:RowSort<FileSortColumn>|null):Row[]{
 const sorted=sortTableRows(rows,sort??{column:'name',direction:'asc'},{name:row=>row.name,size:row=>row.kind==='directory'?null:row.size??null,modified:row=>row.modifiedAt?Date.parse(row.modifiedAt):null});
 return [...sorted.filter(row=>row.kind==='directory'),...sorted.filter(row=>row.kind!=='directory')];
}
