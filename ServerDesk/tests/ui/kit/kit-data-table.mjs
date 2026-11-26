// The kit DataTable, SortHead, Toolbar and Pagination (ui/kit/data-table.tsx) and their pure
// helpers (ui/kit/data-table-model.ts), rendered with React SSR: the labelled scroll region
// that is a Tab stop before measurement, th scope and aria-sort, the sort button that names the next
// direction, the column classes (mono, tabular, hide, wrap, end, width), the column aside outside the row open button, clickable and static rows, the one
// Empty row, the foot with the pagination, the card list, the entrance, the flush variant, the fixed
// layout (widths on the head, the primary column's minimum in the table's min-width, its CSS) next to the
// unchanged auto layout, and the shared SortHead in the fleet, drivers, reliability and Software tables.
// No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {buttons} from '../../support/blocked-buttons.mjs';
const h=React.createElement;
const {DataTable,DataCards,SortHead,Toolbar,Pagination,BulkBar,sortHeadProps}=await import('../../../ui/kit/data-table.tsx');
const {nextTableSort,tableSortHead,scrollRegionFocusable,pageWindow}=await import('../../../ui/kit/data-table-model.ts');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const read=file=>readFileSync(file,'utf8');
const noop=()=>{};
const Icon=()=>h('i',{'data-icon':'empty'});
const tags=(html,pattern)=>[...html.matchAll(pattern)].map(match=>match[0]);
const attr=(tag,name)=>tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]??null;
/**
 * The kit's own checkbox parts (RowCheck, AllCheck) and its memoized rows and cards (DataRow, DataCard and their clocked
 * forms) are expanded into their elements, inside the same render (they use hooks).
 */
const rowParts=['DataRow','ClockedDataRow','DataCard','ClockedDataCard'];
const expandChecks=node=>!node||typeof node!=='object'?node:Array.isArray(node)?node.map(expandChecks):node.type?.$$typeof===Symbol.for('react.memo')&&rowParts.includes(node.type.type.name)?expandChecks(node.type.type(node.props)):typeof node.type==='function'&&['RowCheck','AllCheck'].includes(node.type.name)?expandChecks(node.type(node.props)):node.props?{...node,props:Object.fromEntries(Object.entries(node.props).map(([key,value])=>[key,typeof value==='object'?expandChecks(value):value]))}:node;
/** Calls a hook component inside a render and returns the element tree it built. */
const tree=(Component,props,locale='en')=>{let built;renderToStaticMarkup(h(LocaleProvider,{locale},h(()=>{built=expandChecks(Component(props));return null;})));return built;};
const walk=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(walk):[node,...Object.values(node.props??{}).flatMap(value=>typeof value==='object'?walk(value):[])];

const rows=[{id:'a',name:'Alpha',version:'1.2',note:'A long note',count:3},{id:'b',name:'Beta',version:'2.0',note:'Short',count:1}];
const columns=[
 {id:'name',label:'Name',primary:true,sort:{first:'asc'},cell:row=>row.name},
 {id:'version',label:'Version',mono:true,hideBelow:1280,cell:row=>row.version},
 {id:'note',label:'Note',wrap:true,width:200,card:false,cell:row=>row.note},
 {id:'count',label:'Devices',align:'end',mono:true,sort:{first:'desc'},cell:row=>row.count},
];
const base={columns,rows,rowKey:row=>row.id,label:'Products',empty:{icon:Icon,title:'No products',children:'Register a device first.'}};

// ---- Sortable, mono, end, hide, wrap and primary columns, rows with onOpen ----
let html=render(h(DataTable,{...base,sort:{column:'count',direction:'desc'},onSort:noop,onOpen:noop,openLabel:row=>`Open ${row.name}`}));
ok(html.startsWith('<div class="sdx-table-wrap" role="region" aria-label="Products" tabindex="0"><table class="sdx-table sdx-data-table"><thead><tr>'),'a labelled region with tabindex 0 before the first measurement, then the table');
const heads=tags(html,/<th\b[^>]*>/g);
check(heads.length,4,'one th per column');
ok(heads.every(tag=>attr(tag,'scope')==='col'),'every head has scope="col"');
check(heads.map(tag=>attr(tag,'aria-sort')),['none',null,null,'descending'],'aria-sort on the sortable heads: inactive none, active descending');
const sortButtons=tags(html,/<button type="button" class="sdx-sort[^"]*"[^>]*>/g);
check(sortButtons.map(tag=>[attr(tag,'class'),attr(tag,'aria-label')]),[['sdx-sort','Name: sort ascending'],['sdx-sort active','Devices: sort ascending']],'the sort buttons name the next direction');
ok(html.includes('class="lucide lucide-arrow-up-down"')&&html.includes('class="lucide lucide-arrow-down"'),'the inactive head shows ArrowUpDown, the active descending one ArrowDown');
check([attr(heads[1],'class'),attr(heads[2],'style'),attr(heads[3],'class')],['sdx-hide-below-1280','width:200px','sdx-cell-end'],'head classes: hide, width, end');
const firstRow=html.match(/<tbody><tr\b.*?<\/tr>/)[0];
const cells=tags(firstRow,/<td\b[^>]*>/g);
check(cells.map(tag=>attr(tag,'class')),[null,'mono sdx-hide-below-1280','sdx-cell-wrap','sdx-cell-end mono'],'cell classes: mono and hide on th and td, wrap, end');
// tabular: the kit tabular class on the head and every cell of that column only; aside: next to the open button, not in it.
{
 const counted=[{id:'name',label:'Name',primary:true,cell:row=>row.name,aside:row=>row.id==='a'?h('span',{className:'sdx-tag',tabIndex:0},'Default'):null},{id:'count',label:'Members',tabular:true,cell:row=>`${row.count} members`}];
 const table=render(h(DataTable,{...base,columns:counted,onOpen:noop}));
 check([tags(table,/<th(?: [^>]*)?>/g).map(tag=>attr(tag,'class')),tags(table,/<td(?: [^>]*)?>/g).map(tag=>attr(tag,'class'))],[[null,'sdx-cell-tabular'],[null,'sdx-cell-tabular',null,'sdx-cell-tabular']],'tabular puts sdx-cell-tabular on its th and tds, nowhere else');
 ok(table.includes('<td>2 members</td>')===false&&table.includes('>3 members</td>'),'the cell text is unchanged');
 ok(table.includes('<span class="sdx-cell-aside"><button type="button" class="sdx-row-open">Alpha</button><span class="sdx-tag" tabindex="0">Default</span></span>'),'aside sits after the row open button, outside it');
 ok(table.includes('<span class="sdx-cell-aside"><button type="button" class="sdx-row-open">Beta</button></span>'),'a row without an aside keeps the wrapper only');
 ok(/:is\(\.sdx, \.sdx-layer\) \.sdx-table :is\(th, td\)\.sdx-cell-tabular \{ font-variant-numeric: tabular-nums; \}/.test(read('ui/styles/console.css')),'the tabular class sets tabular-nums');
 ok(!render(h(DataTable,{...base,onOpen:noop})).includes('sdx-cell-tabular')&&!render(h(DataTable,{...base,onOpen:noop})).includes('sdx-cell-aside'),'without the options no class');
}
ok(firstRow.startsWith('<tbody><tr class="sdx-row-clickable">'),'rows with onOpen carry the clickable-row class');
ok(firstRow.includes('<td><button type="button" class="sdx-row-open" aria-label="Open Alpha">Alpha</button></td>'),'the primary cell is the open button with openLabel');
check([...html.matchAll(/class="sdx-row-open"[^>]*>([^<]+)</g)].map(match=>match[1]),['Alpha','Beta'],'the rows in the given order, unsorted by the table');
ok(!html.includes('sdx-table-foot'),'no foot without foot or pagination');

// ---- Static rows, no sort handler ----
html=render(h(DataTable,{...base,variant:'flush',busy:true}));
ok(html.startsWith('<div class="sdx-table-wrap sdx-table-wrap-flush" role="region" aria-label="Products" tabindex="0" aria-busy="true">'),'the flush variant class and aria-busy for a stale view');
ok(!html.includes('sdx-row-open')&&!html.includes('sdx-row-clickable')&&html.includes('<tbody><tr><td>Alpha</td>'),'without onOpen: no open button and no clickable-row class');
ok(html.includes('<th scope="col">Name</th>')&&!html.includes('aria-sort'),'without onSort the heads are plain');

// ---- Empty row ----
html=render(h(DataTable,{...base,rows:[],sort:{column:'name',direction:'asc'},onSort:noop,foot:'0 of 9 products',pagination:{page:1,pageSize:2,total:5,onPage:noop}}));
const body=html.match(/<tbody>.*<\/tbody>/)[0];
check((body.match(/<tr\b/g)??[]).length,1,'exactly one row');
ok(/^<tbody><tr class="sdx-table-empty"><td colSpan="4"><div class="sdx-empty">/i.test(body)&&body.includes('<strong>No products</strong><p>Register a device first.</p>'),'one td spanning the 4 columns with the Empty state');
ok(html.includes('<thead>')&&html.includes('aria-sort="ascending"'),'the head stays');
ok(!html.includes('sdx-table-foot')&&!html.includes('sdx-pagination'),'no foot and no pagination without rows');

// ---- Foot, with and without pagination ----
html=render(h(DataTable,{...base,foot:'2 of 9 products'}));
ok(html.endsWith('</table><div class="sdx-table-foot"><p>2 of 9 products</p></div></div>'),'the foot inside the wrap, below the table');
html=render(h(DataTable,{...base,foot:'2 of 9 products',pagination:{page:1,pageSize:2,total:9,onPage:noop}}));
ok(/<div class="sdx-table-foot"><p>2 of 9 products<\/p><nav class="sdx-pagination" aria-label="Pages">.*<\/nav><\/div><\/div>$/.test(html),'the foot text at the start and the pagination at the end of the same bar');

// ---- Cards ----
html=render(h(DataCards,{...base,onOpen:noop,openLabel:row=>`Open ${row.name}`}));
ok(html.startsWith('<ul class="sdx-data-cards" role="list" aria-label="Products"><li class="sdx-data-card sdx-data-card-open sdx-lift">'),'a ul role="list" with the table label; clickable cards lift');
ok(html.includes('<div class="sdx-data-card-title"><button type="button" class="sdx-row-open" aria-label="Open Alpha">Alpha</button></div>'),'the primary column is the card title, the open button with onOpen');
const firstCard=html.match(/<li\b.*?<\/li>/)[0];
check([...firstCard.matchAll(/<dt>([^<]+)<\/dt>/g)].map(match=>match[1]),['Version','Devices'],'the other columns as facts; card:false is left out');
ok(firstCard.includes('<dl class="sdx-facts"><div><dt>Version</dt><dd><span class="mono">1.2</span></dd></div>'),'mono columns keep the mono face in the facts');
html=render(h(DataCards,base));
ok(html.includes('<li class="sdx-data-card"><div class="sdx-data-card-title">Alpha</div>')&&!html.includes('sdx-lift'),'static cards: a plain title and no lift');
html=render(h(DataCards,{...base,entranceId:'cards-a'}));
ok(html.startsWith('<ul class="sdx-data-cards" role="list" aria-label="Products"><li class="sdx-data-card sdx-enter" style="animation-delay:0ms">'),'cards enter with EntranceList and keep role and label');

// ---- Entrance once ----
html=render(h(DataTable,{...base,entranceId:'rows-a'}));
ok(html.includes('<tbody><tr class="sdx-enter" style="animation-delay:0ms">')&&html.includes('<tr class="sdx-enter" style="animation-delay:24ms">'),'the rows rise in on the first load');
html=render(h(DataTable,{...base,rows:[...rows].reverse(),entranceId:'rows-a'}));
ok(!html.includes('sdx-enter'),'a new sort or page does not replay it');

// ---- Row click with onOpen and a row Menu: clicks in a portal never open the row ----
// React bubbles a click on a Menu item (rendered in a portal outside the row) through the row's onClick.
// The handlers are pressed on the element tree with stand-in DOM nodes: `inside` lists what the row contains.
{const {Menu}=await import('../../../ui/kit/kit.tsx');
 const opened=[],chosen=[];
 const menuColumns=[...columns,{id:'actions',label:'Actions',hideLabel:true,className:'sdx-col-actions',cell:row=>h(Menu,{label:`Actions for ${row.name}`,entries:[{id:'details',label:'Show details',onSelect:()=>opened.push(row.id)},{id:'delete',label:'Delete…',danger:true,onSelect:()=>chosen.push(row.id)}]})}];
 const props={...base,columns:menuColumns,onOpen:row=>opened.push(row.id)};
 // node(control): a stand-in element whose closest(rowControls) is `control` (the button, the [role="menu"]) or null.
 const node=(control=null)=>({closest:()=>control});
 const cell=node(),trigger={},triggerNode=node(trigger),menuItem=node({}),portalText=node();
 const click=(handler,target,inside)=>handler({target,currentTarget:{contains:value=>inside.includes(value)}});
 const nodes=walk(tree(DataTable,props));
 ok(nodes.filter(item=>item.type===Menu).length===2,'every row renders its Menu in the actions column');
 const row=nodes.find(item=>item.type==='tr'&&item.props.onClick).props.onClick;
 click(row,cell,[cell]);
 check(opened,['a'],'a click on a plain cell opens the row');
 click(row,triggerNode,[triggerNode,trigger]);
 click(row,menuItem,[]);
 click(row,portalText,[]);
 check(opened,['a'],'the Menu trigger, a Menu item in its portal and other portal content (a dialog) do not open the row');
 const card=walk(tree(DataCards,props)).find(item=>item.type==='li'&&item.props.onClick).props.onClick;
 click(card,menuItem,[]);
 click(card,portalText,[]);
 check(opened,['a'],'the same for the cards');
 click(card,cell,[cell]);
 check(opened,['a','a'],'a click on the card itself opens it');
 check(chosen,[],'no Menu entry ran');}

// ---- SortHead directly ----
html=renderToStaticMarkup(h('table',null,h('thead',null,h('tr',null,h(LocaleProvider,{locale:'de'},h(SortHead,{label:'Name',active:true,direction:'asc',nextDirection:'desc',onSort:noop}))))));
ok(html.includes('<th scope="col" aria-sort="ascending"><button type="button" class="sdx-sort active" aria-label="Name: absteigend sortieren">Name<svg')&&html.includes('lucide-arrow-up"'),'state props: active ascending, the next direction named, ArrowUp');
{const pressed=[];const props=sortHeadProps({column:'name',direction:'asc'},'name','asc',next=>pressed.push(next));props.onSort();
 check([props.active,props.direction,props.nextDirection,pressed],[true,'asc','desc',[{column:'name',direction:'desc'}]],'sortHeadProps flips the active column');
 const other=sortHeadProps({column:'name',direction:'asc'},'count','desc',next=>pressed.push(next));other.onSort();
 check([other.active,other.nextDirection,pressed.at(-1)],[false,'desc',{column:'count',direction:'desc'}],'another column starts with its first direction');}

// ---- Pure helpers ----
check(nextTableSort({column:'a',direction:'asc'},'a','asc'),{column:'a',direction:'desc'},'nextTableSort: a press on the active column flips');
check(nextTableSort({column:'a',direction:'desc'},'a','asc'),{column:'a',direction:'asc'},'and flips back');
check(nextTableSort({column:'a',direction:'asc'},'b','desc'),{column:'b',direction:'desc'},'a new column starts with its first direction');
check(nextTableSort(null,'b','asc'),{column:'b',direction:'asc'},'no sort yet: the first direction');
check(tableSortHead({column:'a',direction:'desc'},'b','asc'),{active:false,direction:'asc',nextDirection:'asc',next:{column:'b',direction:'asc'}},'tableSortHead of an inactive column');
check(scrollRegionFocusable({scrollWidth:800,clientWidth:800,scrollHeight:300,clientHeight:300}),false,'scrollRegionFocusable: no overflow');
check(scrollRegionFocusable({scrollWidth:1200,clientWidth:800,scrollHeight:300,clientHeight:300}),true,'horizontal overflow');
check(scrollRegionFocusable({scrollWidth:800,clientWidth:800,scrollHeight:900,clientHeight:300}),true,'vertical overflow');
check(scrollRegionFocusable({scrollWidth:801,clientWidth:800,scrollHeight:301,clientHeight:300}),false,'1 px tolerance');
check(scrollRegionFocusable({scrollWidth:802,clientWidth:800,scrollHeight:300,clientHeight:300}),true,'2 px overflow counts');
check(pageWindow(1,50,312),{page:1,pages:7,start:1,end:50,from:0,to:50},'pageWindow: the first page');
check(pageWindow(3,50,312),{page:3,pages:7,start:101,end:150,from:100,to:150},'a middle page');
check(pageWindow(7,50,312),{page:7,pages:7,start:301,end:312,from:300,to:312},'the last page is short');
check(pageWindow(9,50,312).page,7,'clamped above');
check(pageWindow(0,50,312).page,1,'clamped below');
check(pageWindow(-3,50,312).from,0,'negative pages start at the top');
check(pageWindow(1,50,0),{page:1,pages:1,start:0,end:0,from:0,to:0},'total 0: one empty page');

// ---- Pagination ----
html=render(h(Pagination,{page:1,pageSize:50,total:312,onPage:noop}));
ok(html.startsWith('<nav class="sdx-pagination" aria-label="Pages">')&&html.includes('<span class="sdx-pagination-range" aria-live="polite">1–50 of 312</span>'),'nav with its label and the polite range');
let pageButtons=buttons(html);
check(pageButtons.map(button=>[button.label,button.blocked,button.description]),[['Previous page',true,'This is the first page.'],['Next page',false,null]],'page 1: previous is blocked with its reason');
ok(html.includes('lucide-chevron-left')&&html.includes('lucide-chevron-right'),'the chevrons');
html=render(h(Pagination,{page:7,pageSize:50,total:312,onPage:noop}),'de');
ok(html.includes('aria-label="Seiten"')&&html.includes('301–312 von 312'),'German range');
pageButtons=buttons(html);
check(pageButtons.map(button=>[button.label,button.blocked,button.description]),[['Vorherige Seite',false,null],['Nächste Seite',true,'Das ist die letzte Seite.']],'the last page: next is blocked with its reason');
ok(render(h(Pagination,{page:1,pageSize:50,total:312,onPage:noop}),'de').includes('1–50 von 312'),'"1–50 von 312" in German');
check(render(h(Pagination,{page:1,pageSize:50,total:50,onPage:noop})),'','nothing when everything fits on one page');
check(render(h(Pagination,{page:1,pageSize:50,total:0,onPage:noop})),'','nothing without rows');
{const pages=[];const nav=walk(tree(Pagination,{page:3,pageSize:50,total:312,onPage:page=>pages.push(page)}));
 const [previous,next]=nav.filter(node=>typeof node.props?.onClick==='function'&&node.props.label);
 previous.props.onClick();next.props.onClick();
 check(pages,[2,4],'previous and next ask for the neighbour pages');
 ok(render(h(Pagination,{page:12,pageSize:50,total:312,onPage:noop})).includes('301–312 of 312'),'a page beyond the end shows the last page');}

// ---- Toolbar ----
html=render(h(Toolbar,{search:{value:'zip',onChange:noop,label:'Search products',placeholder:'Product or version',id:'sw-search',shortcut:'/'},filters:h('div',{className:'f'},'filter'),actions:h('button',{type:'button'},'CSV')}));
check(html,'<div class="sdx-toolbar"><label class="sdx-searchfield sdx-toolbar-search"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search" aria-hidden="true"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg><input id="sw-search" type="search" aria-label="Search products" aria-keyshortcuts="/" placeholder="Product or version" value="zip"/></label><div class="sdx-toolbar-filters"><div class="f">filter</div></div><span class="sdx-toolbar-spacer"></span><div class="sdx-toolbar-actions"><button type="button">CSV</button></div></div>','search, filters, spacer, actions in this order');
check(render(h(Toolbar,{actions:h('b',null,'A')})),'<div class="sdx-toolbar"><span class="sdx-toolbar-spacer"></span><div class="sdx-toolbar-actions"><b>A</b></div></div>','only the parts that are given');
{const typed=[];const search=walk(tree(Toolbar,{search:{value:'',onChange:value=>typed.push(value),label:'Search'}})).find(node=>node.type==='input');search.props.onChange({target:{value:'chrome'}});check(typed,['chrome'],'onChange gets the text');}

// ---- highlightKey: one row and its card get the selection look and a focus target ----
html=render(h(DataTable,{...base,highlightKey:'b'}));
const highlightRows=tags(html,/<tr\b[^>]*>/g).slice(1);
check(highlightRows.map(tag=>[attr(tag,'class'),attr(tag,'tabindex'),attr(tag,'data-row-key')]),[[null,null,null],['sdx-row-highlight','-1','b']],'only the matching row: class, tabindex -1 and data-row-key');
html=render(h(DataTable,{...base,onOpen:noop,highlightKey:'a'}));
check(tags(html,/<tr\b[^>]*>/g).slice(1).map(tag=>attr(tag,'class')),['sdx-row-clickable sdx-row-highlight','sdx-row-clickable'],'with onOpen both classes');
html=render(h(DataCards,{...base,highlightKey:'a'}));
check(tags(html,/<li\b[^>]*>/g).map(tag=>[attr(tag,'class'),attr(tag,'tabindex'),attr(tag,'data-row-key')]),[['sdx-data-card sdx-row-highlight','-1','a'],['sdx-data-card',null,null]],'the matching card too');
check(render(h(DataTable,base)),render(h(DataTable,{...base,highlightKey:'missing'})),'an unknown key changes no row');
// An array marks every match (rows and cards); only the first match in row order is the focus target.
html=render(h(DataTable,{...base,highlightKey:['b','a']}));
check(tags(html,/<tr\b[^>]*>/g).slice(1).map(tag=>[attr(tag,'class'),attr(tag,'tabindex'),attr(tag,'data-row-key')]),[['sdx-row-highlight','-1','a'],['sdx-row-highlight',null,'b']],'an array: both rows get the class and data-row-key, only the first in row order tabindex -1');
html=render(h(DataCards,{...base,highlightKey:['a','b']}));
check(tags(html,/<li\b[^>]*>/g).map(tag=>[attr(tag,'class'),attr(tag,'tabindex'),attr(tag,'data-row-key')]),[['sdx-data-card sdx-row-highlight','-1','a'],['sdx-data-card sdx-row-highlight',null,'b']],'an array: both cards too');
check(render(h(DataTable,{...base,highlightKey:['b']})),render(h(DataTable,{...base,highlightKey:'b'})),'an array of one key equals the string');
check(render(h(DataTable,base)),render(h(DataTable,{...base,highlightKey:[]})),'an empty array changes no row');
ok(/\.sdx-row-highlight > td:first-child \{ box-shadow: inset 3px 0 0 var\(--sd-accent\); \}/.test(read('ui/styles/console.css')),'the leading accent bar');

// ---- Selection, rowProps and stickyActions (the fleet Devices table) ----
{const selection={selected:['b','x'],onChange:noop,rowLabel:row=>`Select ${row.name}`,allLabel:'Select all visible'};
 html=render(h(DataTable,{...base,onOpen:noop,selection}));
 const headCheck=html.match(/<thead><tr><th scope="col" class="sdx-col-check"><label class="sdx-check-hit"><input type="checkbox"[^>]*\/><\/label><\/th>/);
 ok(headCheck&&attr(headCheck[0],'aria-label')==='Select all visible','the first head is .sdx-col-check with a labelled head checkbox in .sdx-check-hit');
 const bodyRows=tags(html,/<tr\b[^>]*>/g).slice(1);
 check(bodyRows.map(tag=>attr(tag,'aria-selected')),['false','true'],'rows carry aria-selected');
 check([...html.matchAll(/<td class="sdx-col-check"><label class="sdx-check-hit"><input type="checkbox" aria-label="([^"]+)"( checked="")?\/><\/label><\/td>/g)].map(match=>[match[1],!!match[2]]),[['Select Alpha',false],['Select Beta',true]],'one labelled row checkbox per row, checked for selected keys');
 check(tags(html,/<th\b[^>]*>/g).length,5,'the check column comes on top of the 4 columns');
 html=render(h(DataTable,{...base,rows:[],selection}));
 ok(/<input type="checkbox" aria-label="Select all visible" disabled=""\/>/.test(html)&&html.includes('<td colSpan="5">'),'without rows the head checkbox is disabled and the empty row spans the check column too');
 // The handlers, pressed on the element tree.
 const changes=[];const pressed={...selection,selected:[],onChange:keys=>changes.push(keys)};
 const nodes=walk(tree(DataTable,{...base,selection:pressed}));
 const inputs=nodes.filter(node=>node.type==='input'&&node.props.type==='checkbox');
 inputs[0].props.onChange({target:{checked:true}});
 check(changes.at(-1),['a','b'],'select all gets every row key');
 const allChosen=walk(tree(DataTable,{...base,selection:{...pressed,selected:['a','b','x']}})).filter(node=>node.type==='input'&&node.props.type==='checkbox');
 allChosen[0].props.onChange({target:{checked:false}});
 check(changes.at(-1),['x'],'clear removes the given rows and keeps keys that are not shown');
 walk(tree(DataTable,{...base,selection:{...pressed,selected:['a','b']}})).filter(node=>node.type==='input'&&node.props.type==='checkbox')[0].props.onChange({target:{checked:false}});
 check(changes.at(-1),[],'clear with only shown rows selected gets none');
 inputs[2].props.onChange({target:{checked:true}});
 check(changes.at(-1),['b'],'a row checkbox adds its key');
 check(attr(tags(render(h(DataTable,{...base,selection:{...pressed,selected:['a']}})),/<th scope="col" class="sdx-col-check">.*?<input[^>]*>/g)[0].match(/<input[^>]*>/)[0],'checked'),null,'some selected: not checked (indeterminate is set through the ref)');}
html=render(h(DataTable,{...base,rowProps:()=>({draggable:true,onDragStart:noop})}));
check(tags(html,/<tr\b[^>]*>/g).slice(1).map(tag=>attr(tag,'draggable')),['true','true'],'rowProps sets draggable');
ok(render(h(DataTable,{...base,stickyActions:true})).includes('<table class="sdx-table sdx-data-table sdx-table-sticky-actions">'),'stickyActions adds the class');
ok(!render(h(DataTable,base)).includes('sdx-table-sticky-actions')&&!render(h(DataTable,base)).includes('sdx-col-check')&&!render(h(DataTable,base)).includes('aria-selected'),'without them nothing changes');

// ---- Selection in card mode (760px or narrower): a selectable table stays selectable on a phone ----
// SSR renders the table (useNarrowLayout is false before mount), so the card list is rendered directly.
{const selection={selected:['b','x'],onChange:noop,rowLabel:row=>`Select ${row.name}`,allLabel:'Select all visible'};
 html=render(h(DataCards,{...base,onOpen:noop,openLabel:row=>`Open ${row.name}`,selection}));
 ok(html.startsWith('<label class="sdx-data-cards-all"><span class="sdx-check-hit"><input type="checkbox"/></span><span>Select all visible</span></label><ul class="sdx-data-cards" role="list" aria-label="Products">'),'a labelled select-all checkbox above the list; its visible text names it, nothing is checked while only some rows are');
 check(tags(html,/<li\b[^>]*>/g).map(tag=>attr(tag,'class')),['sdx-data-card sdx-data-card-open sdx-lift','sdx-data-card sdx-data-card-open sdx-lift sdx-data-card-selected'],'the selected card gets the selection look');
 ok(!/<li\b[^>]*aria-selected/.test(html),'no aria-selected on a list item (not allowed there); the checkbox carries the state');
 check([...html.matchAll(/<div class="sdx-data-card-title sdx-data-card-title-check"><label class="sdx-check-hit"><input type="checkbox" aria-label="([^"]+)"( checked="")?\/><\/label><button type="button" class="sdx-row-open" aria-label="Open [^"]+">/g)].map(match=>[match[1],!!match[2]]),[['Select Alpha',false],['Select Beta',true]],'one labelled checkbox in .sdx-check-hit before each title, checked for selected keys');
 html=render(h(DataCards,{...base,selection:{...selection,selected:['a','b']}}));
 ok(html.startsWith('<label class="sdx-data-cards-all"><span class="sdx-check-hit"><input type="checkbox" checked=""/>'),'all shown cards selected: select all is checked');
 html=render(h(DataCards,{...base,entranceId:'cards-select',selection}));
 ok(/^<label class="sdx-data-cards-all">.*<\/label><ul class="sdx-data-cards" role="list" aria-label="Products"><li class="sdx-data-card sdx-enter"/.test(html),'with an entrance the cards still rise in below the select-all row');
 ok(!render(h(DataCards,base)).includes('sdx-data-cards-all')&&!render(h(DataCards,base)).includes('type="checkbox"'),'without a selection: no checkboxes');
 // The handlers, pressed on the element tree: the same selectRow and selectAllRows as the table.
 const changes=[];const pressed={...selection,selected:['x'],onChange:keys=>changes.push(keys)};
 const inputs=walk(tree(DataCards,{...base,selection:pressed})).filter(node=>node.type==='input'&&node.props.type==='checkbox');
 check(inputs.length,3,'select all and one checkbox per card');
 inputs[0].props.onChange({target:{checked:true}});
 check(changes.at(-1),['x','a','b'],'select all adds every shown card and keeps keys that are not shown');
 walk(tree(DataCards,{...base,selection:{...pressed,selected:['a','b','x']}})).filter(node=>node.type==='input'&&node.props.type==='checkbox')[0].props.onChange({target:{checked:false}});
 check(changes.at(-1),['x'],'clear removes the shown cards only');
 inputs[2].props.onChange({target:{checked:true}});
 check(changes.at(-1),['x','b'],'a card checkbox adds its key');
 // A click on the checkbox never opens the card: rowClick skips labels and inputs.
 const opened=[];const checkbox={},label={closest:()=>checkbox};
 const card=walk(tree(DataCards,{...base,selection,onOpen:row=>opened.push(row.id)})).find(item=>item.type==='li'&&item.props.onClick).props.onClick;
 card({target:label,currentTarget:{contains:value=>value===label||value===checkbox}});
 check(opened,[],'the checkbox does not open the card');
 const source=read('ui/kit/data-table.tsx');
 ok(/<DataCards columns=\{allColumns\}[^\n]*selection=\{selection\}\/>/.test(source),'DataTable passes its selection to the card list');
 const css=read('ui/styles/console.css');
 ok(/\.sdx-data-card\.sdx-data-card-selected \{[^}]*border-inline-start: 3px solid var\(--sd-accent\); padding-inline-start: 14px; background: var\(--sd-accent-soft\); \}/.test(css)&&/\.sdx-data-card \{ display: grid; gap: 4px; min-width: 0; padding: 12px 16px; border: 1px solid/.test(css),'a selected card: accent-soft fill and the leading 3px accent bar; 3 + 14 = 1 + 16, so the content does not move');}

// ---- Card mode keeps row actions and selectable/blocked rows, UI-Rework 13b ----
{const {Menu}=await import('../../../ui/kit/kit.tsx');
 const actionsColumn={id:'actions',label:'Actions',hideLabel:true,className:'sdx-col-actions',card:false,cell:row=>h(Menu,{label:`Actions for ${row.name}`,entries:[{id:'open',label:'Open',onSelect:noop}]})};
 const withActions={...base,columns:[...columns,actionsColumn]};
 html=render(h(DataCards,withActions));
 check([...html.matchAll(/<div class="sdx-data-card-title sdx-data-card-title-actions">([^<]+)<span class="sdx-data-card-actions"><button type="button" class="sdx-icon-btn sdx-btn-ghost" aria-label="([^"]+)"/g)].map(match=>[match[1],match[2]]),[['Alpha','Actions for Alpha'],['Beta','Actions for Beta']],'a sdx-col-actions column with card:false still renders its Menu at the end of the card title line');
 ok(!/<dt>Actions<\/dt>/.test(html),'the actions column is no fact');
 const cardTree=walk(tree(DataCards,withActions));
 ok(cardTree.filter(node=>node.type===Menu).length===2,'one row Menu per card, the same element as in the table');
 // selectable: rows without a checkbox, the head selects only selectable rows.
 const changes=[];const selection={selected:[],onChange:keys=>changes.push(keys),rowLabel:row=>`Select ${row.name}`,allLabel:'Select all visible',selectable:row=>row.id!=='a'};
 html=render(h(DataTable,{...base,selection}));
 check([...html.matchAll(/<td class="sdx-col-check">(.*?)<\/td>/g)].map(match=>match[1]===''?'none':attr(match[1],'aria-label')),['none','Select Beta'],'a row with selectable false renders no checkbox in the table');
 html=render(h(DataCards,{...base,selection}));
 check([...html.matchAll(/aria-label="(Select [AB][a-z]+)"/g)].map(match=>match[1]),['Select Beta'],'and none in its card');
 walk(tree(DataTable,{...base,selection})).filter(node=>node.type==='input'&&node.props.type==='checkbox')[0].props.onChange({target:{checked:true}});
 check(changes.at(-1),['b'],'the head checkbox selects only the selectable shown rows');
 ok(/<input type="checkbox" aria-label="Select all visible" checked=""/.test(render(h(DataTable,{...base,selection:{...selection,selected:['b']}}))),'and counts only them: all selectable rows chosen checks it');
 walk(tree(DataCards,{...base,selection})).filter(node=>node.type==='input'&&node.props.type==='checkbox')[0].props.onChange({target:{checked:true}});
 check(changes.at(-1),['b'],'the card list head selects the same');
 // blocked: focusable, aria-disabled, described by the reason, no change; a selected row is never blocked.
 const blocked={...selection,selectable:undefined,selected:['a'],blocked:()=>'You can select up to 1 updates at once.'};
 html=render(h(DataTable,{...base,selection:blocked}));
 const boxes=tags(html,/<td class="sdx-col-check">.*?<\/td>/g);
 ok(!boxes[0].includes('aria-disabled')&&boxes[0].includes('checked=""'),'the selected row is not blocked');
 const blockedBox=boxes[1].match(/<input[^>]*>/)[0];
 ok(boxes[1].startsWith('<td class="sdx-col-check"><label class="sdx-check-hit sdx-check-blocked">')&&attr(blockedBox,'aria-disabled')==='true'&&!/\sdisabled=/.test(blockedBox)&&!/checked=/.test(blockedBox),'the blocked row checkbox stays focusable with aria-disabled and unchecked');
 const describedBy=attr(blockedBox,'aria-describedby');
 ok(describedBy&&boxes[1].includes(`<span id="${describedBy}" class="sr-only">You can select up to 1 updates at once.</span>`),'its reason is its description');
 const blockedInput=walk(tree(DataTable,{...base,selection:{...blocked,onChange:keys=>changes.push(keys)}})).filter(node=>node.type==='input'&&node.props['aria-disabled']==='true')[0];
 const before=changes.length;let prevented=0;
 blockedInput.props.onClick({preventDefault:()=>prevented++});
 blockedInput.props.onKeyDown({key:' ',preventDefault:()=>prevented++});
 blockedInput.props.onChange({target:{checked:true}});
 check([changes.length-before,prevented],[0,2],'click and Space are cancelled and nothing changes the selection');
 html=render(h(DataCards,{...base,selection:blocked}));
 ok(/<label class="sdx-check-hit sdx-check-blocked"><input type="checkbox" aria-label="Select Beta" aria-disabled="true"/.test(html),'the card checkbox is blocked the same way');
 ok(render(h(DataTable,{...base,selection:{...selection,selectable:undefined}}))===render(h(DataTable,{...base,selection:{selected:[],onChange:noop,rowLabel:row=>`Select ${row.name}`,allLabel:'Select all visible'}})),'without selectable and blocked the markup is as before');
 // the kit toolbar search is wide enough for its placeholder; the fleet-only rule is gone.
 const css=read('ui/styles/console.css');
 ok(/\.sdx-toolbar > \.sdx-toolbar-search \{ flex: 1 1 280px; min-width: 280px; \}/.test(css)&&/\.sdx-toolbar > \.sdx-toolbar-search \{ flex-basis: 100%; min-width: 0; max-width: none; \}/.test(css),'the toolbar search: 280px basis and minimum above 760px, the full first row at 760px');
 ok(!css.includes('.sdx-fleet-toolbar > .sdx-toolbar-search'),'the fleet-only search rule is gone');}

// ---- layout="fixed": widths from the head, the primary column takes the rest (the fleet Devices table) ----
{const {fixedTableMinWidth}=await import('../../../ui/kit/data-table.tsx');
 const {postcss}=await import('../../support/theme-colors.mjs');
 const selection={selected:['b'],onChange:noop,rowLabel:row=>`Select ${row.name}`,allLabel:'Select all visible'};
 const fixedColumns=[
  {...columns[0],width:999,minWidth:'var(--sd-col-device-min)'},
  {...columns[1],width:'var(--sd-col-status)'},
  {...columns[2]},
  {...columns[3],width:72},
  {id:'actions',label:'Actions',hideLabel:true,width:'var(--sd-col-actions)',className:'sdx-col-actions',cell:()=>'menu'},
 ];
 const props={...base,columns:fixedColumns,onOpen:noop,openLabel:row=>`Open ${row.name}`,sort:{column:'count',direction:'desc'},onSort:noop};
 // auto (the default) renders every existing table as before: no fixed class, no colgroup, no min-width, the same head styles.
 // An entrance plays once per id, so each of the two renders gets its own.
 for(const [index,extra] of [{},{selection},{stickyActions:true,entranceId:'rows-auto'},{rows:[]}].entries()){
  const id=suffix=>extra.entranceId?{entranceId:`${extra.entranceId}-${index}-${suffix}`}:{};
  const plain=render(h(DataTable,{...props,...extra,...id('plain')})),auto=render(h(DataTable,{...props,...extra,...id('auto'),layout:'auto'}));
  check(auto,plain,'layout="auto" equals no layout prop');
  ok(!plain.includes('sdx-table-fixed')&&!plain.includes('<colgroup')&&!plain.includes('<col ')&&!plain.includes('min-width'),'auto: no fixed class, no colgroup, no min-width');
 }
 check(tags(render(h(DataTable,props)),/<th\b[^>]*>/g).map(tag=>attr(tag,'style')),['width:999px','width:var(--sd-col-status)','width:200px','width:72px','width:var(--sd-col-actions)'],'auto: every given width on its head, the primary one too (as before)');
 html=render(h(DataTable,{...props,layout:'fixed',selection,stickyActions:true,entranceId:'rows-fixed'}));
 const table=html.match(/<table\b[^>]*>/)[0];
 check(attr(table,'class'),'sdx-table sdx-data-table sdx-table-sticky-actions sdx-table-fixed','fixed: the kit class next to the sticky actions class');
 const minWidth='calc(var(--sd-col-check) + var(--sd-col-device-min) + var(--sd-col-status) * var(--sdx-col-shown-1280, 1) + 200px + 72px + var(--sd-col-actions))';
 check(attr(table,'style'),`min-width:${minWidth}`,'fixed: the min-width sums the check column, the primary minimum and every other width; a hideBelow column counts only while shown');
 check(fixedTableMinWidth(fixedColumns,true),minWidth,'fixedTableMinWidth gives the same sum');
 check(fixedTableMinWidth(fixedColumns.filter(column=>column.id!=='version'),false),'calc(var(--sd-col-device-min) + 200px + 72px + var(--sd-col-actions))','a toggled-off column and no selection leave the sum');
 check(fixedTableMinWidth([{id:'name',label:'Name',cell:()=>''}],false),'0px','no widths: 0px');
 const head=html.slice(html.indexOf('<thead>'),html.indexOf('</thead>'));
 ok(html.indexOf('</thead>')<html.indexOf('<tbody'),'the head (every width) comes before the first body row');
 const fixedHeads=tags(head,/<th\b[^>]*>/g);
 check(fixedHeads.map(tag=>[attr(tag,'class'),attr(tag,'style')]),[['sdx-col-check',null],[null,null],['sdx-hide-below-1280','width:var(--sd-col-status)'],[null,'width:200px'],['sdx-cell-end','width:72px'],['sdx-col-actions','width:var(--sd-col-actions)']],'fixed: the check head keeps its class (40px through --sd-col-check), the primary head has no width, every other head its width; the hideBelow head carries its hide class with its width');
 check(tags(html,/<tr\b[^>]*>/g).slice(1).map(tag=>attr(tag,'aria-selected')),['false','true'],'fixed: rows keep their selection state');
 ok(html.includes('<td><button type="button" class="sdx-row-open" aria-label="Open Alpha">Alpha</button></td>'),'fixed: the primary cell is still the open button');
 check(render(h(DataTable,{...props,layout:'fixed',rows:[],selection})).match(/<td colSpan="(\d+)">/)?.[1],'6','fixed, no rows: the empty row spans every column and the check column');
 // The memo rows are the same components with the same props in both layouts: only the table element and the heads differ.
 const rowsOf=markup=>markup.slice(markup.indexOf('<tbody'));
 check(rowsOf(render(h(DataTable,{...props,layout:'fixed',selection}))),rowsOf(render(h(DataTable,{...props,selection}))),'the body rows are identical in both layouts');
 const rowTypes=layout=>walk(tree(DataTable,{...props,layout,rowClock:()=>0})).filter(node=>node.type?.$$typeof===Symbol.for('react.memo')).map(node=>node.type.type.name);
 check(rowTypes('fixed'),rowTypes('auto'),'the same memo row components');
 // The stylesheet: the class sets table-layout fixed, the overflow fallback applies to fixed tables only.
 const css=postcss.parse(read('ui/styles/console.css'));
 const rules=[];css.walkRules(rule=>{if(rule.selector.includes('sdx-table-fixed'))rules.push(rule);});
 const declsOf=selector=>rules.filter(rule=>rule.selector===selector).flatMap(rule=>rule.nodes.filter(node=>node.type==='decl').map(decl=>`${decl.prop}: ${decl.value}`));
 check(declsOf(':is(.sdx, .sdx-layer) .sdx-table-fixed').filter(decl=>decl.startsWith('table-layout')),['table-layout: fixed'],'.sdx-table-fixed sets table-layout: fixed');
 check(declsOf(':is(.sdx, .sdx-layer) .sdx-table-fixed tr:not(.sdx-table-empty) > td'),['overflow: hidden','text-overflow: ellipsis'],'a fixed-layout cell clips what overflows its padding, text with an ellipsis');
 const unscoped=[];css.walkDecls(/^(text-overflow|table-layout)$/,decl=>{if(decl.parent.selector?.includes('sdx-table')&&!decl.parent.selector.includes('sdx-table-fixed'))unscoped.push(decl.parent.selector);});
 check(unscoped,[],'no table-wide table-layout or ellipsis rule outside the fixed class');
 check(declsOf(':is(.sdx, .sdx-layer) .sdx-table-wrap:has(> .sdx-table-fixed)'),['container-type: inline-size'],'only the wrap of a fixed table is a size container');
 check(declsOf(':is(.sdx, .sdx-layer) .sdx-table-fixed tr.sdx-table-empty > td > *'),['position: sticky','left: 0','width: 100cqi'],'the empty message of a fixed table wider than its wrap takes the visible width at the left edge');
 const containers=[];css.walkDecls('container-type',decl=>containers.push(decl.parent.selector));
 // The only other size container of the sheet is the split settings page (SettingsPage aside, tests/ui/kit/kit-parts.mjs):
 // it is no table wrap, and a fixed table inside it still measures its own wrap, the nearest container.
 check(containers,[':is(.sdx, .sdx-layer) .sdx-table-wrap:has(> .sdx-table-fixed)','.sdx-settings-page-split'],'no other table wrap becomes a container');
 check(containers.filter(selector=>selector.includes('sdx-table')),[':is(.sdx, .sdx-layer) .sdx-table-wrap:has(> .sdx-table-fixed)'],'the wrap of a fixed table is the only table container');
 const shown=[];css.walkAtRules('media',media=>media.walkDecls(/^--sdx-col-shown-/,decl=>shown.push(`${media.params} ${decl.prop}: ${decl.value}`)));
 check(shown,['(max-width: 1439.98px) --sdx-col-shown-1440: 0','(max-width: 1279.98px) --sdx-col-shown-1280: 0','(max-width: 1099.98px) --sdx-col-shown-1100: 0','(max-width: 899.98px) --sdx-col-shown-900: 0'],'below each hide breakpoint a hidden column leaves the min-width (the media queries of .sdx-hide-below-*)');
 const hideMedia=[];css.walkAtRules('media',media=>media.walkRules(rule=>{if(/sdx-hide-below-/.test(rule.selector))hideMedia.push(media.params);}));
 check(hideMedia,['(max-width: 1439.98px)','(max-width: 1279.98px)','(max-width: 1099.98px)','(max-width: 899.98px)'],'the same breakpoints hide the columns');
 const root=new Map();postcss.parse(read('app/globals.css')).each(node=>{if(node.type==='rule'&&node.selector===':root')node.walkDecls(/^--sd-col-(check|actions)$/,decl=>root.set(decl.prop,decl.value));});
 check(Object.fromEntries(root),{'--sd-col-check':'40px','--sd-col-actions':'48px'},'the check column token is 40px; the row menu column token is the 48px it renders at');
 ok(/\.sdx-col-check \{ width: var\(--sd-col-check\); padding-right: 0 !important; \}/.test(read('ui/styles/console.css'))&&/\.sdx-col-actions \{ width: 44px; text-align: right !important; \}/.test(read('ui/styles/console.css')),'the check column keeps 40px (now its token) and the actions class keeps its 44px floor in every table');}

// ---- rowChunk: changed rows take their new object a chunk at a time (nextRowChunk) ----
{const {nextRowChunk}=await import('../../../ui/kit/data-table.tsx');
 const key=row=>row.id,old=['a','b','c','d','e'].map(id=>({id,v:1})),fresh=old.map(row=>({...row,v:2}));
 check(nextRowChunk(fresh,old,key,2).map(row=>row.v),[2,2,1,1,1],'the first two changed rows (in row order) take their new object, the rest keep theirs');
 const second=nextRowChunk(fresh,nextRowChunk(fresh,old,key,2),key,2);
 check(second.map(row=>row.v),[2,2,2,2,1],'the next chunk takes the next two');
 check(nextRowChunk(fresh,second,key,2),fresh,'once nothing is left behind, the given rows themselves');
 const added=[{id:'x',v:9},...fresh.slice(0,3).reverse()];
 check(nextRowChunk(added,old,key,1).map(row=>[row.id,row.v]),[['x',9],['c',2],['b',1],['a',1]],'order and membership follow the new rows; a new row shows at once; a removed row leaves');
 check(nextRowChunk(old,old,key,1),old,'unchanged rows: the same array');
 const plain=render(h(DataTable,{...base,rowChunk:1}));
 check(plain,render(h(DataTable,base)),'the first render shows every row as given');}

// ---- One SortHead; the table never sorts ----
for(const file of ['ui/devices/fleet/fleet.tsx','ui/devices/inventory/health-table.tsx','ui/devices/inventory/drivers-tab.tsx','ui/devices/inventory/reliability-tab.tsx','ui/devices/inventory/software-tab.tsx']){
 const text=read(file);
 ok(!/function SortHead\b|const sortHead\b|aria-sort=|ArrowUpDown/.test(text),`${file}: no own sort head`);
}
// The analysis tabs build no table of their own: their heads come from the DataTable (SortHead inside), sorted through ui/base/table-sort.ts.
for(const file of ['ui/devices/inventory/drivers-tab.tsx','ui/devices/inventory/reliability-tab.tsx','ui/devices/monitoring/problems.tsx','ui/devices/monitoring/alarms.tsx','ui/devices/inventory/os-support.tsx','ui/devices/inventory/encryption-tab.tsx','ui/devices/inventory/certificates-tab.tsx','ui/devices/inventory/autostart-tab.tsx']){
 const text=read(file);
 ok(/import \{DataTable,[^\n]*from '@\/ui\/kit\/data-table';/.test(text)&&!/<table\b/.test(text),`${file}: a DataTable, no own table`);
 ok(/import \{[^\n]*sortTableRows[^\n]*\} from '@\/ui\/base\/table-sort';/.test(text)&&!/\.sort\(\(/.test(text),`${file}: sorts through sortTableRows, not in the component`);
}
ok(/import \{DataTable,FilterPopover,Toolbar,[^\n]*from '@\/ui\/kit\/data-table';/.test(read('ui/devices/fleet/fleet.tsx'))&&!/<table\b/.test(read('ui/devices/fleet/fleet.tsx')),'fleet.tsx: the Devices table is a DataTable (SortHead inside), no own table');
ok(/import \{DataTable,Toolbar,[^\n]*from '@\/ui\/kit\/data-table';/.test(read('ui/devices/inventory/software-tab.tsx')),'software-tab.tsx: its heads come from the DataTable (SortHead inside)');
ok(!/export (function|type|const) (useSort|SortState|SortHead)\b|useState/.test(read('ui/devices/inventory/health-table.tsx')),'health-table.tsx keeps only its cells');
ok(!/\.sort\(/.test(read('ui/kit/data-table.tsx'))&&!/\.filter\(row|\.slice\(/.test(read('ui/kit/data-table.tsx')),'data-table.tsx never sorts, filters or pages the rows');

// ---- BulkBar ----
{
 const bar=(count,extra={})=>render(h(BulkBar,{count,onClear:noop,...extra},h('button',{type:'button'},'Move'),h('button',{type:'button'},'Delete')));
 check(bar(0),'','nothing at count 0');
 const one=bar(1),three=bar(3,{label:'Device selection'});
 ok(/^<div class="sdx-bulkbar" role="region" aria-label="Selection">/.test(one)&&/^<div class="sdx-bulkbar" role="region" aria-label="Device selection">/.test(three),'a named region (default kit.bulk.label)');
 ok(/<strong aria-live="polite">1 selected<\/strong>/.test(one)&&/<strong aria-live="polite">3 selected<\/strong>/.test(three)&&/<strong aria-live="polite">3 ausgewählt<\/strong>/.test(render(h(BulkBar,{count:3,onClear:noop}),'de')),'the count with its plural forms in an aria-live element');
 check(buttons(three).map(button=>button.label||button.inner),['Move','Delete','Clear selection'],'the count, the actions, then Clear selection');
 let cleared=0;let built;renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(()=>{built=BulkBar({count:2,onClear:()=>cleared++});return null;})));
 [built.props.children].flat(Infinity).find(node=>node?.props?.label==='Clear selection').props.onClick();
 check(cleared,1,'Clear selection calls onClear');
 const css=read('ui/styles/console.css');
 ok(/\.sdx-bulkbar \{[^}]*animation: sdx-rise var\(--sd-dur\) var\(--sd-ease-out\);/.test(css),'it rises in once when it appears (sdx-rise, 180 ms)');
}

console.log(`PASS kit data table (${checks} checks): DataTable region, heads, column classes, clickable and static rows, empty row, foot with pagination, cards, entrance, flush; SortHead, sortHeadProps, nextTableSort, scrollRegionFocusable, pageWindow, Pagination, Toolbar, the one shared sort head and the BulkBar.`);
