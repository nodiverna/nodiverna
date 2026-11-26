// The scope tab Extensions (<scope>/inventory/extensions, ui/devices/extensions/extensions-tab.tsx, docs/extensions.md) rendered
// with React SSR and a small hook harness: the summary cards per catalog extension (release, coverage meter, Offered,
// Update available, Damaged, Roll out with its blocked reasons and the drawer limited to the scope), the table with
// one row per (device, detected target), the Extension column (with the visible hint of the waiting state and the
// Offered row after a succeeded removal), the row Menu and the open targets, the state and
// detection filters with counts, both empty states and the reset, and the DHCP and DNS cards of their extensions.
// Also the conditional device area Extensions (key 9) and its fallback. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {default:ExtensionsTab,DhcpUsageCard,DnsZonesCard,stateFilterOf}=await import('../../../ui/devices/extensions/extensions-tab.tsx');
const {DataTable}=await import('../../../ui/kit/data-table.tsx');
const {ExtensionRollout}=await import('../../../ui/settings/extension-releases.tsx');
const {visibleDeviceTabs,shownDeviceSection}=await import('../../../ui/devices/device/device.tsx');
const {demoData}=await import('../../../ui/shell/demo.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
const nodes=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];
const noop=()=>{};
const hooks={cursor:0,states:[]};
const internals=React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
async function withHooks(run){
 const saved=internals.H;
 hooks.cursor=0;hooks.states=[];
 internals.H={
  useState(initial){const index=hooks.cursor++;if(!(index in hooks.states))hooks.states[index]=typeof initial==='function'?initial():initial;return [hooks.states[index],value=>{hooks.states[index]=typeof value==='function'?value(hooks.states[index]):value;}];},
  useMemo:fn=>fn(),useCallback:fn=>fn,useContext:context=>context._currentValue,useEffect(){},useLayoutEffect(){},useRef:current=>({current}),useSyncExternalStore:(_subscribe,getSnapshot)=>getSnapshot(),
 };
 try{await run();}finally{internals.H=saved;}
}

const now=Date.UTC(2026,10,14,12);
const feature=(name,displayName=name)=>({name,displayName,installed:true,featureType:'Role'});
const ready=(name,version)=>({name,target:name,version,capabilities:[],state:'ready',networkBlocked:true});
const device=(id,name,{features=[],plugins=[],software=[],os='Microsoft Windows Server 2022 Standard',agentVersion='4.21.2',permissions=['plugins.manage','dhcp.read','dns.read']}={})=>
 ({id,name,lastSeen:now-10_000,revoked:0,permissions,snapshot:{os,agentVersion,agentCapabilities:['plugin-host'],features,plugins},serverSoftware:software});
const dc1=device('dc1','SRV-DC1',{features:[feature('AD-Domain-Services'),feature('DHCP'),feature('DNS')],plugins:[ready('dhcp','1.0.0')]});
const dc2=device('dc2','SRV-DC2',{features:[feature('DHCP')],plugins:[ready('dhcp','1.1.0')]});
const dns1=device('dns1','SRV-DNS1',{features:[feature('DNS')]});
const sql=device('sql','SRV-SQL',{software:[{id:'sql-server',version:'16.0.4135.4',names:['Microsoft SQL Server 2022']}]});
const pc=device('pc','PC-01',{os:'Microsoft Windows 11 Pro',features:[feature('DHCP')]});
const scope=[dc1,dc2,dns1,sql,pc];
const release=(name,version,minAgentVersion='4.16.0')=>({id:'r-'+name,name,target:name,version,minAgentVersion,capabilities:[],changelog:{features:[],fixes:[]},createdAt:now-86400000});
const releases=[release('dhcp','1.1.0'),release('dns','1.0.1','4.21.2')];
const viewer={id:'tech',label:'tech@example.test',permissions:[]};
const baseProps=(extra={})=>({devices:scope,viewer,demo:false,now,releases,jobs:[],onConfirm:noop,onOpen:noop,onShowDevices:noop,...extra});

// ---- The frame: AnalysisTab, then the summary cards, the table, the data cards ----
let html=render(h(ExtensionsTab,baseProps()));
ok(/^<section class="sdx-health-tab" aria-labelledby="([^"]+)"><header class="sdx-section-head"><div class="sdx-section-head-text"><h2 id="\1" class="sr-only">Extensions<\/h2><p>Extensions let you see and change server roles such as DHCP and DNS in Nodiverna\. To install one, open a device and go to its Extensions area\. This list shows the roles and software found on your devices and the extensions they run\. An Owner rolls out new extension versions in Settings\.<\/p>/.test(html),'AnalysisTab: the sr-only name and the description');
const at=marker=>html.indexOf(marker);
ok(at('sdx-extension-summary')<at('sdx-toolbar')&&at('sdx-toolbar')<at('aria-label="Extensions"')&&at('aria-label="Extensions"')<at('sdx-dhcp-fleet'),'the order: summary cards, toolbar and table, then the data cards');
ok(!html.includes('sdx-btn-primary')&&!html.includes('sdx-kpi'),'no gradient primary and no KPI row inside the tab');

// ---- the summary cards ----
const summaries=markup=>[...markup.matchAll(/<section class="sdx-card sdx-extension-summary-card[^"]*"[^>]*>[\s\S]*?<\/section>/g)].map(match=>text(match[0]));
check(summaries(html),[
 'DHCP extension Release 1.1.0 Roll out Installed on 2 of 2 devices Offered 0 Update available 1',
 'DNS extension Release 1.0.1 Roll out No device has an older version of this extension. Installed on 0 of 2 devices Offered 2 Update available 0',
],'one card per detected catalog extension in catalog order: release, coverage, Offered and Update available; Damaged only above 0; the Windows 11 PC does not count');
ok(/role="meter" aria-label="Installed on 2 of 2 devices"[^>]*aria-valuenow="100"/.test(html)&&/role="meter" aria-label="Installed on 0 of 2 devices"[^>]*aria-valuenow="0"/.test(html),'the coverage Meter with its label');
ok(html.includes('sdx-meter-normal')&&!html.includes('sdx-meter-warning')&&!html.includes('sdx-meter-critical'),'full coverage stays in the accent tone');
ok((html.match(/sdx-icon-tile-accent/g)??[]).length>=2,'each summary card has the accent IconTile of its target');
html=render(h(ExtensionsTab,baseProps({devices:[dc1,{...dns1,snapshot:{...dns1.snapshot,plugins:[{...ready('dns','1.0.0'),state:'damaged',error:null}]}}]})));
check(summaries(html)[1],'DNS extension Release 1.0.1 Roll out Installed on 0 of 2 devices Offered 1 Update available 1 Damaged 1','Damaged shows above 0 (a damaged older install is also a rollout candidate)');
html=render(h(ExtensionsTab,baseProps({releases:[releases[0]]})));
ok(summaries(html)[1].startsWith('DNS extension No release imported'),'without a release: No release imported');
check(text(render(h(ExtensionsTab,baseProps()),'de')).includes('Installiert auf 2 von 2 Geräten'),true,'the German coverage');
await withHooks(()=>{
 const confirmed=[];
 const props=baseProps({onConfirm:value=>confirmed.push(value)});
 const all=()=>{hooks.cursor=0;return nodes(ExtensionsTab(props));};
 const cards=()=>all().filter(node=>node.props?.className==='sdx-extension-summary-card');
 const rollOut=index=>cards()[index].props.actions;
 check(cards().map(card=>[card.props.title,card.props.iconTone]),[['DHCP extension','accent'],['DNS extension','accent']],'the card titles and tiles');
 check([rollOut(0).props.children,rollOut(0).props.size,rollOut(0).props.variant,rollOut(0).props.blocked,rollOut(1).props.blocked],['Roll out','sm',undefined,undefined,'No device has an older version of this extension.'],'Roll out: a secondary Btn sm; DNS has no older install');
 props.demo=true;check(rollOut(0).props.blocked,'Not available for sample devices.','demo blocks Roll out');props.demo=false;
 props.releases=[releases[0]];check(rollOut(1).props.blocked,'No release of this extension is imported yet. An Owner imports it in Settings → Agent releases.','no release blocks Roll out');props.releases=releases;
 rollOut(0).props.onClick();
 const drawer=all().find(node=>node.type===ExtensionRollout);
 check([drawer.props.release.id,drawer.props.devices.map(item=>item.id)],['r-dhcp',['dc1','dc2','dns1','sql','pc']],'Roll out opens the shared rollout with the scoped devices');
 const saved=hooks.states;hooks.states=[];hooks.cursor=0;
 const inner=nodes(drawer.type(drawer.props)).find(node=>node.props?.candidates);
 check(inner.props.candidates.map(item=>item.id),['dc1'],'the candidates are the scoped devices with an older version');
 hooks.states=saved;
 inner.props.onSubmit(['dc1']);
 check([confirmed[0].title,confirmed[0].payload],['Roll out DHCP extension 1.1.0 to 1 device?',{action:'deploy',releaseId:'r-dhcp',serverIds:['dc1'],confirm:true}],'the same confirmation and payload as the settings page');
 check(hooks.states[3],null,'the drawer closes');
 props.devices=[dc2,dns1];
 check(rollOut(0).props.blocked,'No device has an older version of this extension.','the scope limits the candidates: no older DHCP in this scope');
});

// ---- the table, its filters and empty states ----
await withHooks(()=>{
 const opened=[],confirmed=[];let shownDevices=0;
 const props=baseProps({onOpen:(...args)=>opened.push(args),onConfirm:value=>confirmed.push(value.title),onShowDevices:()=>shownDevices++});
 const table=()=>{hooks.cursor=0;return nodes(ExtensionsTab(props)).find(node=>node.type===DataTable&&node.props.label==='Extensions');};
 const rows=()=>table().props.rows,keys=()=>rows().map(row=>`${row.deviceId}:${row.entry.id}`);
 const filters=()=>nodes(table().props.toolbar.props.filters);
 const segmented=()=>filters().find(node=>node.props?.items&&node.props?.label==='Extension state');
 const select=()=>filters().find(node=>node.props?.['aria-label']==='Detected');
 const column=id=>table().props.columns.find(item=>item.id===id);
 const menu=key=>{const row=rows().find(item=>`${item.deviceId}:${item.entry.id}`===key);return column('actions').cell(row).props;};
 check([table().props.cards,table().props.entranceId,table().props.foot],[true,'extensions-rows','6 of 6 entries'],'cards, the entrance id and the foot');
 check(keys(),['dc1:ad-ds','dc1:dhcp','dc2:dhcp','dc1:dns','dns1:dns','sql:sql-server'],'one row per (scoped device, detected target) in catalog order, then device name');
 check(table().props.columns.map(item=>[item.label,!!item.sort]),[['Device',true],['Detected',true],['Version',false],['Extension',false],['Actions',false]],'the columns; Device and Detected sort');
 check(rows().map(row=>text(render(column('extension').cell(row)))),['No extension yet','Installed · 1.0.0','Installed · 1.1.0','Extension available','Extension available','No extension yet'],'the Extension column');
 check(text(render(column('extension').cell({...rows()[3],state:{state:'planned'}}))),'Extension available later','planned: the waiting pill');
 check(stateFilterOf({extension:'dns'},{state:'reporting',version:'1'}),'installed','reporting counts as Installed');
 // The row Menu and the open targets.
 check(menu('dc1:dhcp').entries.map(entry=>entry.label),['Open SRV-DC1','Open DHCP'],'installed DHCP: Open the device, Open DHCP');
 check(menu('dc1:dns').entries.map(entry=>[entry.label,entry.blocked]),[['Open SRV-DC1',undefined],['Install extension',undefined]],'offered DNS: Install extension, free on an online host with the right');
 check(menu('sql:sql-server').entries.map(entry=>entry.label),['Open SRV-SQL'],'no extension: only Open the device');
 check(menu('dc1:dns').label,'Actions for SRV-DC1 · DNS Server','the menu names the device and the detection');
 menu('dc1:dns').entries[1].onSelect();menu('dc1:dhcp').entries[1].onSelect();menu('sql:sql-server').entries[0].onSelect();
 check([confirmed,opened.splice(0)],[['Install the DNS extension on SRV-DC1?'],[['dc1','extensions','dhcp'],['sql','extensions']]],'Install confirms; Open DHCP and Open device open their targets');
 table().props.onOpen(rows()[1]);table().props.onOpen(rows()[0]);
 check(opened.splice(0),[['dc1','extensions','dhcp'],['dc1','extensions',undefined]],'a row opens the DHCP subarea when installed, else the Extensions area');
 check(table().props.openLabel(rows()[0]),'Open SRV-DC1','the open control names the device');
 props.jobs=[{id:'j',serverId:'dc1',action:'plugin-remove',target:'dhcp',state:'running',createdAt:now}];
 check(menu('dc1:dns').entries[1].blocked,'An extension job for this device is already running. Wait until it finishes.','blocked like the device area, with that device\'s jobs');
 props.demo=true;check(menu('dc1:dns').entries[1].blocked,'Not available for sample devices.','demo first');props.demo=false;
 props.jobs=[{id:'j2',serverId:'dns1',action:'plugin-install',target:'dns 1.0.1',state:'running',createdAt:now}];
 check([text(render(column('extension').cell(rows().find(row=>row.deviceId==='dns1')))),menu('dns1:dns').entries.map(entry=>entry.label)],['Installing…',['Open SRV-DNS1']],'an open install: Installing… and no second install');
 // The succeeded install waits for the agent: the row shows the reason as visible text below the pill.
 const installed={id:'j3',serverId:'dns1',action:'plugin-install',target:'dns 1.0.1',state:'succeeded',createdAt:now-5*60_000,claimedAt:now-5*60_000,lastProgress:now-4*60_000};
 props.jobs=[installed];
 const waiting=render(column('extension').cell(rows().find(row=>row.deviceId==='dns1')));
 check(text(waiting),'Installed · waiting for the agent The extension is installed. It shows as ready when the agent reports it, usually within a minute.','reporting: the pill and its visible hint');
 ok(waiting.includes('data-state="reporting"')&&waiting.includes('sdx-extension-state-hint')&&!waiting.includes('title='),'the hint is a small line in the pill wrapper, no title');
 // A newer succeeded removal ends the waiting: the row is offered again.
 props.jobs=[installed,{id:'j4',serverId:'dns1',action:'plugin-remove',target:'dns',state:'succeeded',createdAt:now-2*60_000,claimedAt:now-2*60_000,lastProgress:now-60_000}];
 const removedRow=rows().find(row=>row.deviceId==='dns1');
 check([stateFilterOf(removedRow.entry,removedRow.state),text(render(column('extension').cell(removedRow)))],['offered','Extension available'],'after a succeeded removal the device is in the Offered group');
 props.jobs=[];
 // The state Segmented and the detection Select with counts.
 check(segmented().props.items.map(item=>[item.id,item.label,item.count]),[['all','All',6],['installed','Installed',2],['offered','Offered',2],['none','No extension',2]],'the state Segmented with counts');
 check([segmented().props.size,select().props.size,select().props.wide],['sm','sm',true],'Segmented sm and Select sm wide');
 check(nodes(select()).filter(node=>node.type==='option').map(node=>[node.props.value,node.props.children]),[['','Everything detected'],['ad-ds','Active Directory Domain Services (1)'],['dhcp','DHCP Server (2)'],['dns','DNS Server (2)'],['sql-server','Microsoft SQL Server (1)']],'the detection Select with device counts, Everything detected first');
 segmented().props.onChange('installed');
 check(keys(),['dc1:dhcp','dc2:dhcp'],'Installed filters');
 segmented().props.onChange('offered');select().props.onChange({target:{value:'dns'}});
 check([keys(),segmented().props.items.map(item=>item.count),table().props.foot],[['dc1:dns','dns1:dns'],[2,0,2,0],'2 of 6 entries'],'filters combine; the state counts follow the detection');
 table().props.toolbar.props.search.onChange('dns1');
 check(keys(),['dns1:dns'],'the search by device name combines too');
 check([table().props.toolbar.props.search.label,table().props.toolbar.props.search.placeholder],['Search devices','Search by device name'],'the search label and placeholder');
 select().props.onChange({target:{value:'dhcp'}});
 const empty=table().props.empty;
 check([rows().length,empty.title,empty.children,empty.action.props.label],[0,'No entries match the filter','Choose another state or role, or change the search.','Reset filters'],'no match: the filter empty state with Reset filter');
 empty.action.props.onReset();
 check([rows().length,segmented().props.value,select().props.value,table().props.toolbar.props.search.value],[6,'all','',''],'Reset clears search, state and detection');
 // Sort: Device descending; Detected by its name.
 table().props.onSort({column:'detected',direction:'asc'});
 check(rows().map(row=>row.entry.id),['ad-ds','dhcp','dhcp','dns','dns','sql-server'],'Detected sorts by the detection name');
 hooks.states[4]=null;
 props.devices=[pc];
 const none=table().props.empty;
 check([none.title,none.children,none.action.props.children],['Nothing detected','Roles and software appear here when a Windows server sends its roles and features or its software list.','Show devices'],'nothing detected: the empty state with Show devices');
 none.action.props.onClick();check(shownDevices,1,'Show devices opens the Devices tab');
 check(table().props.toolbar.props.filters,false,'no filters without entries');
});
check(text(render(h(ExtensionsTab,baseProps({devices:[]})),'de')).includes('Nichts erkannt'),true,'German empty state');

// ---- the DHCP and DNS cards of their extensions ----
{
 const {servers:samples}=demoData();
 const sampleProps=(extra={})=>({devices:samples,viewer,demo:true,now,releases:demoData().pluginReleases,onConfirm:noop,onOpen:noop,onShowDevices:noop,...extra});
 html=render(h(ExtensionsTab,sampleProps()));
 const dhcpCard=html.slice(html.indexOf('sdx-dhcp-fleet')),dnsCard=html.slice(html.indexOf('sdx-dns-fleet'));
 ok(html.indexOf('sdx-dhcp-fleet')<html.indexOf('sdx-dns-fleet'),'the cards in catalog order: DHCP, then DNS');
 ok(text(dhcpCard).includes('DHCP scope usage The DHCP extension updates these values every 15 minutes.')&&/sdx-dhcp-fleet sdx-extensions-fleet-card/.test(html),'the DHCP card with the new meta');
 ok(text(dnsCard).includes('DNS zones This list shows the zones of every DNS server that runs the DNS extension.'),'the DNS card with the new meta');
 ok(/<section class="sdx-card sdx-card-flush sdx-dhcp-fleet sdx-extensions-fleet-card"><header class="sdx-section-head sdx-card-head"><div class="sdx-section-head-text"><h2><span class="sdx-icon-tile sdx-icon-tile-accent/.test(html),'the DHCP card has the accent IconTile of its summary card');
 ok(!render(h(ExtensionsTab,sampleProps({demo:false}))).includes('sdx-dhcp-fleet'),'without dhcp.read on a scoped device the card is hidden');
 const readable=samples.map(server=>server.id==='demo-dc'?{...server,permissions:['dhcp.read']}:server);
 const withRight=render(h(ExtensionsTab,sampleProps({devices:readable,demo:false})));
 ok(withRight.includes('sdx-dhcp-fleet')&&!withRight.includes('sdx-dns-fleet'),'dhcp.read on one device: the DHCP card loads, the DNS card needs dns.read');
 ok(!render(h(ExtensionsTab,sampleProps({devices:samples.filter(server=>server.id!=='demo-dc')}))).includes('sdx-dhcp-fleet'),'without the DHCP target in the scope the card is hidden');
 await withHooks(()=>{
  const props=sampleProps();
  const all=()=>{hooks.cursor=0;return nodes(ExtensionsTab(props));};
  const select=()=>nodes(all().find(node=>node.type===DataTable).props.toolbar.props.filters).find(node=>node.props?.['aria-label']==='Detected');
  check([all().some(node=>node.type===DhcpUsageCard),all().some(node=>node.type===DnsZonesCard)],[true,true],'both cards with an empty detection filter');
  select().props.onChange({target:{value:'ad-ds'}});
  check([all().some(node=>node.type===DhcpUsageCard),all().some(node=>node.type===DnsZonesCard)],[false,false],'another detection hides both');
  select().props.onChange({target:{value:'dns'}});
  check([all().some(node=>node.type===DhcpUsageCard),all().some(node=>node.type===DnsZonesCard)],[false,true],'the DNS filter keeps the DNS card');
  select().props.onChange({target:{value:''}});
  all().find(node=>node.type===DhcpUsageCard).props.onShowDhcp();
  check(select().props.value,'dhcp','Show DHCP servers sets the detection filter');
  select().props.onChange({target:{value:''}});
  all().find(node=>node.type===DnsZonesCard).props.onShowDns();
  check(select().props.value,'dns','Show DNS servers sets the detection filter');
 });
 const words=text(render(h(DhcpUsageCard,{devices:samples.filter(server=>server.id!=='demo-dc'),demo:true,now,query:'',onOpen:noop,onShowDhcp:noop})));
 ok(words.includes('Install the DHCP extension on a DHCP server to see the usage of its scopes.')&&words.includes('Show DHCP servers'),'the DHCP card empty state');
}

// ---- The device area Extensions: key 9, before Monitoring, only with a detection ----
{
 const tabs=visibleDeviceTabs(dc1,{permissions:['*']});
 check(tabs.map(tab=>tab.id),['overview','hardware','software','diagnostics','management','remote','automation','history','extensions','monitoring','configuration'],'Extensions comes before Monitoring and Configuration');
 check([tabs.findIndex(tab=>tab.id==='extensions')+1,tabs.find(tab=>tab.id==='extensions').label],[9,'device.section.extensions'],'Extensions has key 9 and its label key');
 check([translate('en','device.section.extensions'),translate('de','device.section.extensions'),translate('en','extensions.tab'),translate('de','extensions.tab')],['Extensions','Erweiterungen','Extensions','Erweiterungen'],'the area and the subtab: Extensions / Erweiterungen');
 check(visibleDeviceTabs(pc).map(tab=>tab.id).includes('extensions'),false,'no Extensions area on Windows 11');
 check([shownDeviceSection(dc1,'extensions'),shownDeviceSection({snapshot:null},'extensions'),shownDeviceSection({snapshot:null},'files')],['extensions','overview','files'],'an Extensions link without a detection shows the Overview');
 const {filterPaletteItems}=await import('../../../ui/shell/command-palette.tsx');
 const {navNode}=await import('../../../ui/shell/nav-model.ts');
 const item={id:'section-extensions',group:'SRV-DC1',label:'Extensions',hint:'Area',keywords:navNode('device.extensions').keywords,Icon:noop,run:noop};
 check(['extensions','erweiterungen','plugins','roles','rollen','dhcp'].map(term=>filterPaletteItems([item],term).length),[1,1,1,1,1,1],'the palette area entry matches its new and old names');
}

// ---- Source ----
{
 const source=readFileSync('ui/devices/extensions/extensions-tab.tsx','utf8');
 ok(!/<table\b|<select\b|sdx-searchfield|className="sdx-toolbar"/.test(source),'extensions-tab.tsx: no <table, <select, own search field or toolbar');
 ok((source.match(/<Toolbar\b/g)??[]).length===1,'one kit Toolbar');
}

console.log(`PASS extensions view (${checks} checks): the scope tab Extensions with the summary cards (release, coverage, Offered, Update available, Damaged, Roll out blocked and limited to the scope with the shared confirmation), the table with its Extension column, row Menus and open targets, the state and detection filters with counts, both empty states and the reset, the DHCP and DNS cards of their extensions, and the device area Extensions with key 9.`);
