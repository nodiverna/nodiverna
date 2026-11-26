// Management → Software (Programs) on the kit (ui/devices/inventory/device-software.tsx), UI-Rework 13b: the view
// switch Installed / Change history / Vulnerabilities is one small Segmented with counts in the filters of
// the one kit Toolbar, beside the search; Vulnerabilities only while the check is on, with the critical tone
// when an urgent verdict exists; the search filters every view by program name; the list sits in one Card
// flush without a title. Rendered on hook cells (tests/support/panel-harness.mjs): cell 0 the view, cell 1
// the search, cell 3 the loaded view.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {panelHarness} from '../../support/panel-harness.mjs';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const now=Date.UTC(2026,10,13,12),day=86400000,iso=offset=>new Date(now-offset).toISOString();
const item=(name,extra={})=>({key:name,name,version:'1.0',publisher:'Contoso',installDate:null,architecture:'x64',scope:'machine',normalizedName:name.toLowerCase(),normalizedVersion:'1.0',...extra});
const view=(extra={})=>({state:{reportedAt:now-day,truncated:false},items:[item('Alpha Tool'),item('Beta Agent',{verdict:{status:'vulnerable',highest:'critical',count:2,knownExploited:true}}),item('Gamma Viewer',{verdict:{status:'vulnerable',highest:'medium',count:1,knownExploited:false}})],
 changes:[{id:1,at:iso(day),change:'installed',name:'Alpha Tool',versionFrom:null,versionTo:'1.0'},{id:2,at:iso(2*day),change:'updated',name:'Beta Agent',versionFrom:'0.9',versionTo:'1.0'}],
 vulnerabilities:{enabled:true,lastSuccessAt:now-3600000},...extra});
const harness=panelHarness({hooked:['ui/devices/inventory/device-software.tsx'],locale:'en',stubs:{'@/ui/base/api':{api:()=>new Promise(()=>{}),message:()=>''}}});
const Panel=harness.load('ui/devices/inventory/device-software.tsx').default,props={server:{id:'srv',name:'SRV',snapshot:{softwareChecksum:'x'}},demo:false,now};
/** The panel with the loaded view in cell 3, the view in cell 0 and the search in cell 1. */
const render=(data,{tab='installed',query=''}={})=>{harness.reset({0:tab,1:query,3:{id:'srv',data}});return {markup:harness.html(Panel,props),tree:harness.tree(Panel,props)};};
const segmentOf=markup=>markup.match(/<div class="sdx-toolbar-filters"><div class="sdx-segmented sdx-segmented-sm" role="group" aria-label="Software">([\s\S]*?)<\/div><\/div>/)?.[1]??'';
const items=markup=>[...segmentOf(markup).matchAll(/<button type="button" aria-pressed="(true|false)"[^>]*><span>([^<]+)<\/span><b(?: class="([^"]+)")?>(\d+)<\/b>/g)].map(match=>[match[2],Number(match[4]),match[3]??null,match[1]]);

// ---- The view switch ----
let {markup}=render(view());
check(items(markup),[['Installed',3,null,'true'],['Change history',2,null,'false'],['Vulnerabilities',2,'sdx-count-critical','false']],'three items with counts while the check is on; Vulnerabilities critical with an urgent verdict');
ok(/<div class="sdx-toolbar"><label class="sdx-searchfield sdx-toolbar-search">[\s\S]*?aria-label="Search programs"[\s\S]*?<div class="sdx-toolbar-filters"><div class="sdx-segmented sdx-segmented-sm"/.test(markup),'the search and the Segmented sit in one kit Toolbar');
ok(!/role="tablist"|role="tabpanel"/.test(markup),'no underline Tabs, no tabpanel');
check((markup.match(/<section class="sdx-card sdx-card-flush sdx-health-card"><div class="sdx-toolbar">/g)??[]).length,1,'one Card flush without a title holds the list');
ok(!/<section class="sdx-card[^"]*"[^>]*><header/.test(markup),'the card has no head');
({markup}=render(view({vulnerabilities:{enabled:false,lastSuccessAt:null}})));
check(items(markup).map(item=>item[0]),['Installed','Change history'],'two items without the vulnerability check');
({markup}=render(view({items:[item('Alpha Tool'),item('Gamma Viewer',{verdict:{status:'vulnerable',highest:'medium',count:1,knownExploited:false}})]})));
check(items(markup)[2],['Vulnerabilities',1,null,'false'],'no critical tone without an urgent verdict');
// Changing the view through the Segmented.
const {tree}=render(view());harness.walk(tree).find(node=>node.props?.label==='Software'&&Array.isArray(node.props.items)).props.onChange('history');
check(harness.h.states.get(0),'history','the Segmented switches the view');

// ---- The search filters every view by program name ----
({markup}=render(view(),{tab:'history',query:'beta'}));
ok(/role="region" aria-label="Change history"/.test(markup)&&markup.includes('Beta Agent')&&!markup.includes('Alpha Tool'),'the history is filtered by name');
({markup}=render(view(),{tab:'vulnerabilities',query:'gamma'}));
ok(markup.includes('Gamma Viewer')&&!markup.includes('Beta Agent'),'the vulnerable programs are filtered by name');
({markup}=render(view(),{tab:'vulnerabilities',query:'nothing'}));
ok(markup.includes('No program matches the search'),'a search without a match: the no-match empty state');
({markup}=render(view(),{query:'alpha'}));
ok(markup.includes('Alpha Tool')&&!markup.includes('Gamma Viewer')&&/1 of 3 programs/.test(markup),'the installed list keeps its search and foot');

// ---- Source ----
const source=fs.readFileSync('ui/devices/inventory/device-software.tsx','utf8');
ok(!/<Tabs\b|tabId|role="tabpanel"/.test(source)&&(source.match(/<Card\b/g)??[]).length===1&&!/<Card title=/.test(source),'device-software.tsx: no Tabs, one Card without a title');

console.log(`PASS device software view (${checks} checks): the Segmented view switch with counts and the critical tone in one Toolbar beside the search, the search over every view, one Card without a title.`);
