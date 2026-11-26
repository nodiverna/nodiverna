// The one row sort of the analysis tabs (ui/base/table-sort.ts): ascending and descending text with
// numeric collation, numbers, missing values last in both directions, stable ties, no sort and an
// unknown column keep the input order, and inputRank keeps the order of lib/. Pure, no browser.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
const {sortTableRows,inputRank,compareSortValues}=await import('../../../ui/base/table-sort.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

const rows=[
 {id:'a',name:'SRV-10',count:3,date:'2026-03-01'},
 {id:'b',name:'srv-2',count:null,date:null},
 {id:'c',name:'SRV-1',count:3,date:'2025-12-24'},
 {id:'d',name:'Alpha',count:12,date:undefined},
 {id:'e',name:'SRV-2',count:0,date:'2026-01-15'},
];
const values={name:row=>row.name,count:row=>row.count,date:row=>row.date};
const ids=list=>list.map(row=>row.id);

// ---- Text with numeric collation ----
check(ids(sortTableRows(rows,{column:'name',direction:'asc'},values)),['d','c','b','e','a'],'asc: Alpha, SRV-1, srv-2 and SRV-2 (equal without case, input order), SRV-10');
check(ids(sortTableRows(rows,{column:'name',direction:'desc'},values)),['a','b','e','c','d'],'desc: SRV-10 first; the tie srv-2/SRV-2 keeps the input order');
check(compareSortValues('SRV-2','SRV-10')<0,true,'"SRV-2" < "SRV-10"');
check(compareSortValues('1.10.0','1.9.2')>0,true,'versions compare by number');

// ---- Numbers, missing values last in both directions, stable ties ----
check(ids(sortTableRows(rows,{column:'count',direction:'asc'},values)),['e','a','c','d','b'],'asc: 0, 3, 3 (input order), 12, then null');
check(ids(sortTableRows(rows,{column:'count',direction:'desc'},values)),['d','a','c','e','b'],'desc: 12, 3, 3 (input order), 0, then null');
check(ids(sortTableRows(rows,{column:'date',direction:'asc'},values)),['c','e','a','b','d'],'dates as ISO text; null and undefined last in input order');
check(ids(sortTableRows(rows,{column:'date',direction:'desc'},values)),['a','e','c','b','d'],'desc: missing values stay last');
check(ids(sortTableRows([{id:'x',v:Number.NaN},{id:'y',v:1}],{column:'v',direction:'asc'},{v:row=>row.v})),['y','x'],'NaN counts as missing');

// ---- No sort, unknown column, no change to the input ----
check(ids(sortTableRows(rows,null,values)),['a','b','c','d','e'],'sort null returns the input order');
check(ids(sortTableRows(rows,undefined,values)),['a','b','c','d','e'],'sort undefined returns the input order');
check(ids(sortTableRows(rows,{column:'other',direction:'asc'},values)),['a','b','c','d','e'],'a column without a value keeps the input order');
const copy=sortTableRows(rows,null,values);
check(copy!==rows&&ids(rows).join('')==='abcde',true,'a new array; the input stays as it is');

// ---- inputRank: the order of lib/ as a sort value ----
const rank=inputRank(rows);
check(rows.map(rank),[0,1,2,3,4],'the rank is the index');
check(ids(sortTableRows(rows,{column:'rank',direction:'desc'},{rank:row=>-rank(row)})),['a','b','c','d','e'],'desc on the negative rank gives the input order');
check(ids(sortTableRows(rows,{column:'rank',direction:'asc'},{rank:row=>-rank(row)})),['e','d','c','b','a'],'asc reverses it');
check(rank({id:'unknown'}),5,'an unknown row ranks last');

console.log(`table-sort: ${checks} checks passed`);
