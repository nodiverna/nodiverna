// The Software tab never shows the rows of another scope: the pure
// helper shownSoftwareView picks the shown view, and a tab without a loaded
// view renders the shape-matching skeleton and no table rows. With a loaded
// view the tab is the kit SectionHead, Toolbar and DataTable with 50 rows per
// page; the CSV export still takes every filtered row. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {buttons} from '../../support/blocked-buttons.mjs';
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {demoData}=await import('../../../ui/shell/demo.ts');
const {default:SoftwareTab,shownSoftwareView,softwareScopeParam,softwarePage,softwarePageSize,sortedSoftwareRows}=await import('../../../ui/devices/inventory/software-tab.tsx');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.equal(actual,expected,label);checks++;};
const key=(scope,query='',filter='all')=>`${scope}\u0000${query}\u0000${filter}`;
const view={rows:[{name:'7-Zip',version:'24.08',deviceCount:2}],total:1,truncated:false,vulnerabilities:{enabled:true,vulnerableRows:1}};

// ---- shownSoftwareView ----
const loaded={scope:'all',key:key('all'),view};
check(shownSoftwareView(loaded,'all',key('all')),view,'the same key gives the loaded view');
check(shownSoftwareView(loaded,'all',key('all','zip')),view,'the same scope with another search gives the stale view');
check(shownSoftwareView(loaded,'all',key('all','','vulnerable')),view,'the same scope with another filter gives the stale view');
check(shownSoftwareView(loaded,'group:g1',key('group:g1')),null,'another scope gives null');
check(shownSoftwareView({scope:'group:g1',key:key('group:g1','zip'),view},'customer:c1',key('customer:c1','zip')),null,'another scope with the same search gives null');
check(shownSoftwareView(null,'all',key('all')),null,'nothing loaded gives null');
check(softwareScopeParam({type:'group',id:'g1'}),'group:g1','the scope parameter of a group');

// ---- SSR without loaded data ----
const {servers}=demoData();
const html=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(SoftwareTab,{scope:{type:'group',id:'g1'},devices:servers,demo:false,now:Date.now(),onOpen:()=>{}})));
ok(/<div class="sdx-skeleton-set sdx-skeleton-table" role="status" aria-label="Loading the installed programs">/.test(html)&&!html.includes('sdx-loading'),'the kit Skeleton shows with role status and the loading label');
ok(!/<tbody>/.test(html)&&!/<tr/.test(html),'no table rows without a loaded view');
{const csv=buttons(html).find(button=>button.label==='Export as CSV');ok(csv?.blocked&&csv.description==='No devices to export.','the CSV button is blocked with csv.nothingToExport');}
ok(!html.includes('sdx-notice'),'no notice of an old scope');

// ---- Loaded view: SectionHead, Toolbar, DataTable with paging (stub of 120 products) ----
{
 const stub={rows:Array.from({length:120},(_,index)=>({name:`Product ${String(index).padStart(3,'0')}`,version:'1.0',publisher:'Vendor',normalizedName:`product ${index}`,normalizedVersion:'1.0',deviceCount:index%7+1,deviceIds:[]})),total:120,truncated:false,vulnerabilities:{enabled:false,lastSuccessAt:null,vulnerableRows:0}};
 const props={scope:{type:'group',id:'g1'},devices:[],demo:false,now:Date.now(),onOpen:()=>{},initialView:stub};
 const html=renderToStaticMarkup(h(LocaleProvider,{locale:'de'},h(SoftwareTab,props)));
 ok(/<header class="sdx-section-head"><div class="sdx-section-head-text"><h2 id="[^"]+" class="sr-only">Software<\/h2><p>Programme, die auf den Geräten in dieser Ansicht installiert sind/.test(html)&&!html.includes('sdx-health-head'),'the head is the kit SectionHead with hideTitle: the name only for screen readers, the description visible');
 ok(/<div class="sdx-toolbar"><label class="sdx-searchfield sdx-toolbar-search">.*?<input type="search" aria-label="Produkt oder Version suchen[^"]*" placeholder="Produkt oder Version suchen[^"]*" value=""\/><\/label><span class="sdx-toolbar-spacer"><\/span><div class="sdx-toolbar-actions"><button[^>]*aria-label="Als CSV exportieren"/.test(html),'the Toolbar: search, spacer, the CSV IconBtn as action (no filter while the check is off)');
 ok(/<div class="sdx-table-wrap" role="region" aria-label="Software" tabindex="0">/.test(html),'the DataTable region');
 ok(/^<section class="sdx-health-tab" aria-labelledby="([^"]+)"><header class="sdx-section-head"><div class="sdx-section-head-text"><h2 id="\1"/.test(html)&&(html.match(/aria-label="Software"/g)??[]).length===1,'one region named "Software"; the section is labelled by its sr-only h2');
 {const css=readFileSync('ui/styles/console.css','utf8');
  ok(css.includes(':is(.sdx, .sdx-layer) .sdx-section-head :is(h2, h3) { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 650; }'),'the SectionHead title is 14px/650 and wins over the generic .sd-console h2');
  ok(css.includes(':is(.sdx, .sdx-layer) .sdx-toolbar-search input { border: 1px solid var(--sd-line); color: var(--sd-ink); background: var(--sd-panel); box-shadow: var(--sd-shadow-sm); }'),'the toolbar search field has the framed edge and fill');}
 ok(/<th scope="col" aria-sort="none"><button type="button" class="sdx-sort" aria-label="Produkt: aufsteigend sortieren">/.test(html),'the product head sorts ascending first');
 ok(/<th scope="col" aria-sort="none"><button type="button" class="sdx-sort" aria-label="Version: aufsteigend sortieren">/.test(html)&&/<th scope="col" aria-sort="none"><button type="button" class="sdx-sort" aria-label="Hersteller: aufsteigend sortieren">/.test(html),'Version and Publisher sort ascending first');
 ok(/<th scope="col" class="sdx-cell-end" aria-sort="descending"><button type="button" class="sdx-sort active" aria-label="Geräte: aufsteigend sortieren">Geräte/.test(html),'the default sort: devices descending, right-aligned');
 const rendered=[...html.matchAll(/<tr class="sdx-row-clickable[^"]*"[^>]*><td><button type="button" class="sdx-row-open">([^<]+)<\/button><\/td><td class="mono">1\.0<\/td><td><span class="sdx-muted-cell">Vendor<\/span><\/td><td class="sdx-cell-end mono">(\d)<\/td><\/tr>/g)];
 check(rendered.length,softwarePageSize,'50 rows on the first page');
 ok(rendered[0][2]==='7'&&rendered.every((match,index)=>!index||Number(rendered[index-1][2])>=Number(match[2])),'most widespread first (the row comparison is unchanged)');
 ok(html.includes('<nav class="sdx-pagination" aria-label="Seiten">')&&html.includes('<span class="sdx-pagination-range" aria-live="polite">1–50 von 120</span>'),'the pagination with the range');
 ok(/<div class="sdx-table-foot"><p>120 von 120 Produkten<\/p><nav class="sdx-pagination"/.test(html),'the foot software.fleetFoot next to the pagination');
 // The CSV export takes every filtered row in its sorted order, not only the page.
 const downloads=[];let tree;
 renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(()=>{tree=SoftwareTab({...props,download:(name,text)=>downloads.push({name,text})});return null;})));
 const walk=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(walk):[node,...Object.values(node.props??{}).flatMap(value=>typeof value==='object'?walk(value):[])];
 const csv=walk(tree).find(node=>node.props?.label==='Export as CSV'&&typeof node.props.onClick==='function');
 ok(csv,'the CSV button is reachable');
 csv.props.onClick();
 const lines=downloads[0]?.text.trim().split(/\r?\n/)??[];
 check(downloads.length,1,'one download');check(lines.length-1,120,'the export holds all 120 rows');
 ok(lines[1].includes('Product ')&&lines.slice(1,18).every(line=>/;"?7"?;/.test(line))&&!/;"?7"?;/.test(lines[18]),'in the sorted order (most devices first)');
 // The page: the chosen page while the key stays, page 1 for a new search, filter, sort or scope, clamped when rows shrink.
 check(softwarePage({key:'all|zip',page:2},'all|zip',120),2,'the same key keeps page 2');
 check(softwarePage({key:'all|zip',page:2},'all|chrome',120),1,'a new search key goes back to page 1');
 check(softwarePage({key:'all|zip',page:3},'all|zip',60),2,'clamped to the last page when the rows shrink');
 check(softwarePage({key:'all|zip',page:3},'all|zip',0),1,'no rows: page 1');
 check(softwarePage({key:'all|zip|devices:desc',page:2},'all|zip|version:asc',120),1,'a new sort goes back to page 1 (the sort is part of the page key)');
 // The sort (ui/base/table-sort.ts): the server order in; Version with numeric collation, missing values last.
 const sample=[{name:'B',version:'1.10.0',publisher:null,deviceCount:2,verdict:null},{name:'a',version:'1.9.2',publisher:'Z',deviceCount:2,verdict:{status:'vulnerable',count:1,highest:'high',knownExploited:false,fixedIn:null,noFixCount:0}},{name:'C',version:null,publisher:'A',deviceCount:5,verdict:{status:'vulnerable',count:3,highest:'critical',knownExploited:true,fixedIn:null,noFixCount:0}}];
 const order=sort=>sortedSoftwareRows(sample,sort).map(row=>row.name).join('');
 check(order({column:'version',direction:'asc'}),'aBC','Version ascending: 1.9.2 before 1.10.0, no version last');
 check(order({column:'version',direction:'desc'}),'BaC','Version descending: no version still last');
 check(order({column:'publisher',direction:'asc'}),'CaB','Publisher ascending, no publisher last');
 check(order({column:'name',direction:'asc'}),'aBC','Product ascending, without case');
 check(order({column:'devices',direction:'desc'}),'CBa','Devices descending (default); the tie keeps the server order');
 check(order({column:'risk',direction:'desc'}),'CaB','Vulnerabilities descending: the most urgent verdict first');
}

// ---- Empty states: no inventory and the vulnerable filter, each with its one action ----
{
 const none={rows:[],total:0,truncated:false,vulnerabilities:{enabled:true,lastSuccessAt:null,vulnerableRows:0}};
 const props={scope:{type:'group',id:'g1'},devices:[],demo:false,now:Date.now(),onOpen:()=>{},onShowDevices:()=>{},initialView:none};
 let html=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(SoftwareTab,props)));
 ok(html.includes('No software reported for these devices yet')&&html.includes('Show the devices to check that their agents are running and sending inventory.')&&html.includes('>Show devices<'),'no inventory: the fact, the next step and "Show devices"');
 ok(/<tr class="sdx-table-empty">/.test(html)&&/<thead>/.test(html),'the table keeps its head and shows the Empty as its one row');
 html=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(SoftwareTab,{...props,initialFilter:'vulnerable'})));
 ok(html.includes('No product in this scope has a known vulnerability')&&html.includes('Change the search or the filter to see more entries.')&&html.includes('>Show all<'),'the vulnerable filter: "Show all"');
}

console.log(`PASS software tab scope (${checks} checks): the view of another scope is never shown; without data the kit Skeleton shows; a loaded view is the hideTitle SectionHead, Toolbar and a paged DataTable with the Version and Publisher sort, the CSV export takes every row, and the empty states carry their action.`);
