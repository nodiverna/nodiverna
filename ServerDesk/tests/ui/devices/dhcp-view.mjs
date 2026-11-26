// The DHCP server view of the device Extensions area (ui/devices/extensions/device-dhcp.tsx,
// docs/dhcp-server.md), rendered with React SSR and a small hook harness, in
// English and German: the KPI row of the sample server, the server facts, the
// six sections, the IPv4 table with meters, the IPv6 view switch, the
// superscope filter, the lease search and its truncation notice, the scope
// drawer, every load state and the blocked reasons of "Read again", and the
// changes of plugin 1.1.0: section actions, row menus, the forms with their
// field errors, the confirmations, the running count and the manage gate; the
// back control at the leading edge of the head and the cause-specific empty
// states with their next-step sentence and action.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {default:DeviceDhcp,DhcpBody,ScopeDetails,Scope6Details,dhcpConditionSummary,dhcpDurationLabel,dhcpFailoverMode}=await import('../../../ui/devices/extensions/device-dhcp.tsx');
const {demoDhcpSnapshot}=await import('../../../ui/shell/demo-dhcp.ts');
const {dhcpKpis,DHCP_NO_SUPERSCOPE}=await import('../../../lib/dhcp.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
const noop=()=>{};
// The lists are kit DataTables (UI-Rework 13b): the walk follows the toolbar and every cell of every row, and the
// element props of the kit parts (Toolbar filters and actions, SectionHead actions) as well as children.
const tableParts=node=>Array.isArray(node.props?.columns)&&Array.isArray(node.props?.rows)?node.props.rows.flatMap(row=>node.props.columns.map(column=>column.cell(row))):[];
const nodes=node=>!node||typeof node!=='object'?[]:[node,...[node.props?.children,node.props?.toolbar,node.props?.filters,node.props?.actions,...tableParts(node)].flat(Infinity).flatMap(nodes)];
/** The DataTable with this entrance id in a walked tree. */
const tableOf=(all,id)=>all.find(node=>node.props?.entranceId===id&&Array.isArray(node.props.rows));
const hooks={cursor:0,states:[]};
const internals=React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
async function withHooks(run){
 const saved=internals.H;
 hooks.cursor=0;hooks.states=[];
 internals.H={
  useState(initial){const index=hooks.cursor++;if(!(index in hooks.states))hooks.states[index]=typeof initial==='function'?initial():initial;return [hooks.states[index],value=>{hooks.states[index]=typeof value==='function'?value(hooks.states[index]):value;}];},
  useMemo:fn=>fn(),useCallback:fn=>fn,useContext:context=>context._currentValue,useEffect(){},useLayoutEffect(){},useRef:current=>({current}),
 };
 try{await run();}finally{internals.H=saved;}
}
const t=(key,params)=>translate('en',key,params),de=(key,params)=>translate('de',key,params);
const now=Date.UTC(2026,10,4,12);
const plugin={name:'dhcp',target:'dhcp',version:'1.0.0',capabilities:['dhcp-read'],state:'ready',networkBlocked:true};
const feature={name:'DHCP',displayName:'DHCP-Server',installed:true,featureType:'Role'};
const server={id:'demo-dc',name:'SRV-DC01',lastSeen:now-10_000,permissions:['dhcp.read','plugins.manage'],snapshot:{os:'Microsoft Windows Server 2022 Datacenter',agentVersion:'4.16.0',agentCapabilities:['plugin-host'],features:[feature],plugins:[plugin]}};
const viewer={id:'viewer',label:'viewer@example.test',permissions:[]};
const base={server,viewer,demo:false,now,jobs:[],onBack:noop,onInstall:noop,onOpenServices:noop};
const snapshot=demoDhcpSnapshot(now);

// ---- The sample server in demo mode ----
let html=render(h(DeviceDhcp,{...base,demo:true})),shown=text(html);
ok(html.includes('<h2 id="sdx-dhcp-title" class="sr-only">DHCP server</h2>')&&html.includes('aria-label="Back to Extensions"'),'SectionHead hideTitle with the back button a host passes');
{
 // The back control sits at the leading edge (SectionHead leading): before the head text, outside the actions, so it is the first focusable control of the head.
 const head=render(h(DeviceDhcp,{...base,demo:true}),'de'),backAt=head.indexOf('aria-label="Zurück zu Erweiterungen"');
 ok(/<header class="sdx-section-head"><div class="sdx-section-head-lead"><button[^>]*aria-label="Zurück zu Erweiterungen"/.test(head)&&backAt<head.indexOf('sdx-section-head-text')&&backAt<head.indexOf('sdx-section-head-actions'),'the back control is the leading child of the head, before its text and actions');
 ok(/<div class="sdx-section-head-actions">.*Erneut lesen/.test(head)&&!/<div class="sdx-section-head-actions">[^]*Zurück zu Erweiterungen/.test(head.slice(0,head.indexOf('</header>'))),'the actions hold the account chip and Read again, not the back control');
}
ok(!render(h(DeviceDhcp,{...base,demo:true,onBack:undefined})).includes('aria-label="Back to Extensions"'),'inside the Extensions subtabs there is no back control');
ok(/SRV-DC01\.corp\.example · read 6 min ago · extension 1\.1\.0/.test(shown)&&html.includes('aria-live="polite"'),'the meta line');
ok(html.includes('aria-label="DHCP summary"'),'the KPI row');
const kpis=dhcpKpis(snapshot);
check([kpis.scopes,kpis.active,kpis.inUse,kpis.total,kpis.percent,kpis.leases,kpis.fullest?.name,kpis.fullest?.percent],[3,2,217,300,72.3,20,'Wi-Fi Guests',93],'the KPIs of the sample server: in use over the active IPv4 scopes');
ok(/IPv4 scopes 3 2 active/.test(shown),'IPv4 scopes with the active count');
ok(/Addresses in use 72\.3 % 217 of 300/.test(shown)&&(html.match(/role="meter"/g)??[]).length>=4,'addresses in use with a meter');
ok(/Leases 20/.test(shown),'the lease total');
ok(/Fullest scope 93 % Wi-Fi Guests/.test(shown)&&html.includes('title="Open the scope Wi-Fi Guests"'),'the fullest scope opens its drawer');
ok(shown.includes('Service Running')&&shown.includes('AD authorization Authorized in Active Directory')&&shown.includes('Domain corp.example')&&/Failover relationships 1/.test(shown),'the server facts');
ok(!shown.includes('Data read at')&&!text(render(h(DeviceDhcp,{...base,demo:true}),'de')).includes('Daten gelesen am'),'the facts repeat no read time: the head meta has it');
const tabs=[...html.matchAll(/role="tab"[^>]*>(?:<[^>]+>)*([^<]+)<\/span>(?:<span[^>]*>([^<]*)<\/span>)?/g)].map(match=>match[1]);
ok(['Scopes','Leases','Reservations','Options','Policies','Failover'].every(label=>tabs.includes(label)||shown.includes(label)),'six section tabs');
ok(html.includes('aria-label="DHCP sections"')&&html.includes('sdx-tabbar-pill'),'pill tabs with their label');
ok(/Scopes 4/.test(shown)&&/Leases 20/.test(shown)&&/Reservations 4/.test(shown)&&/Failover 1/.test(shown),'counts in the tab labels');
ok(html.includes('aria-label="Superscope"')&&shown.includes('All superscopes')&&shown.includes('No superscope')&&html.includes('<option value="Campus">Campus</option>'),'the superscope select');
ok(shown.includes('IPv4 (3)')&&shown.includes('IPv6 (1)'),'the IPv4 and IPv6 view switch');
ok(html.includes('<small class="mono">10.10.0.0</small>')&&html.includes('<td class="mono">10.10.0.10 – 10.10.0.209</td>'),'scope id and range in tabular figures');
ok(shown.includes('124 of 200')&&shown.includes('8 days')&&shown.includes('Unlimited')&&shown.includes('DC01-DC02'),'usage, lease duration and failover per scope');
ok(shown.includes('Active')&&shown.includes('Inactive'),'state pills');
check([...html.matchAll(/class="sdx-row-open" aria-label="Open the scope [^"]+"><span class="sdx-dhcp-scope"><strong>([^<]+)<\/strong>/g)].map(match=>match[1]),['Office','Wi-Fi Guests','Lab'],'one row per IPv4 scope; its name opens the drawer');
html=render(h(DeviceDhcp,{...base,demo:true}),'de');shown=text(html);
ok(shown.includes('DHCP-Server')&&shown.includes('IPv4-Bereiche')&&shown.includes('Adressen belegt')&&shown.includes('Vollster Bereich')&&shown.includes('In Active Directory autorisiert')&&shown.includes('Bereiche')&&shown.includes('Unbegrenzt')&&shown.includes('8 Tage'),'German view');


// ---- The Extensions area: back label and the install reason while the plugin is installing or waiting for the agent ----
ok(render(h(DeviceDhcp,{...base,demo:true}),'de').includes('aria-label="Zurück zu Erweiterungen"'),'German back button: Zurück zu Erweiterungen');
{
 const {default:DeviceExtensions}=await import('../../../ui/devices/extensions/device-extensions.tsx');
 const release={id:'r-dhcp',name:'dhcp',target:'dhcp',version:'1.1.0',minAgentVersion:'4.16.0',capabilities:['dhcp-read'],changelog:{features:[],fixes:[]},createdAt:now-86400000};
 const bare={...server,snapshot:{...server.snapshot,plugins:[]}};
 const job={id:'j-dhcp',serverId:server.id,action:'plugin-install',target:'dhcp 1.1.0',state:'succeeded',createdAt:now-60_000,claimedAt:now-50_000,lastProgress:now-20_000,result:null,actor:'owner'};
 const area=(jobs,locale='en')=>render(h(DeviceExtensions,{server:bare,viewer,demo:false,now,jobs,releases:[release],detail:'dhcp',onDetail:noop,onOpenArea:noop,onConfirm:noop}),locale);
 let markup=area([job]);
 ok(text(markup).includes('Install extension')&&markup.includes('The extension was just installed. You can change it as soon as the agent reports it.'),'reporting: Install plugin stays visible, blocked with plugins.blocked.reporting');
 ok(area([job],'de').includes('Die Erweiterung wurde gerade installiert. Du kannst sie ändern, sobald der Agent sie meldet.'),'German reporting reason');
 markup=area([{...job,state:'running',lastProgress:null}]);
 ok(text(markup).includes('Install extension')&&markup.includes('An extension job for this device is already running. Wait until it finishes.'),'installing: blocked with plugins.blocked.busy');
 markup=area([]);
 ok(text(markup).includes('Install extension')&&!markup.includes('The extension was just installed.')&&!markup.includes('already running'),'without a job: Install plugin is free');
}
// ---- Sections through DhcpBody ----
const body=(extra={},locale='en')=>render(h(DhcpBody,{snapshot,kpis,now,t:locale==='en'?t:de,locale,section:'scopes',onSection:noop,family:'ipv4',onFamily:noop,superscope:'',onSuperscope:noop,leaseQuery:'',onLeaseQuery:noop,leaseScope:'',onLeaseScope:noop,leaseFilter:'',onLeaseFilter:noop,openScope:null,onOpenScope:noop,onOpenServices:noop,...extra}),locale);
shown=text(body({family:'ipv6'}));
ok(shown.includes('Prefix')&&shown.includes('2001:db8:10::')&&shown.includes('Office IPv6')&&shown.includes('Valid lifetime')&&shown.includes('12 days'),'the IPv6 segment with its columns');
html=body({superscope:'Campus'});
check([...html.matchAll(/sdx-dhcp-scope"><strong>([^<]+)<\/strong>/g)].map(match=>match[1]),['Office','Wi-Fi Guests'],'the superscope filter');
html=body({superscope:DHCP_NO_SUPERSCOPE});
check([...html.matchAll(/sdx-dhcp-scope"><strong>([^<]+)<\/strong>/g)].map(match=>match[1]),['Lab'],'scopes without a superscope');
shown=text(body({section:'leases'}));
ok(shown.includes('20 of 20 leases')&&shown.includes('Never')&&shown.includes('in 5 h')&&shown.includes('Declined')&&html.includes('aria-live')!==undefined,'the lease table, its count line and expiries');
shown=text(body({section:'leases',leaseQuery:'guest'}));
ok(shown.includes('3 of 20 leases'),'the search over address, name and client ID');
shown=text(body({section:'leases',leaseScope:'10.20.0.0',leaseFilter:'expired'}));
ok(shown.includes('1 of 20 leases'),'the scope and state filters');
shown=text(body({snapshot:{...snapshot,leases:{...snapshot.leases,total:42000,truncated:true}},section:'leases'}));
ok(shown.includes('This list shows 20 of 42000 leases. To find the others, use the DHCP console on the server.'),'the truncation notice');
shown=text(body({section:'reservations'}));
ok(shown.includes('printer-2og.corp.example')&&shown.includes('00-1b-a9-4c-22-10')&&shown.includes('DHCP and BOOTP')&&shown.includes('Access point, lobby'),'the reservations');
shown=text(body({section:'options'}));
ok(shown.includes('IPv4 server options')&&shown.includes('3 Router')&&shown.includes('10.10.1.4, 10.10.1.5')&&shown.includes('51 Lease')&&shown.includes('IPv6 server options')&&shown.includes('23 DNS Recursive Name Server IPv6 Address List'),'server options of both families');
shown=text(body({section:'policies'}));
ok(shown.includes('Printers')&&shown.includes('Server')&&shown.includes('IP phones')&&shown.includes('Scope 10.10.0.0')&&shown.includes('Vendor class equals HP Printer')&&shown.includes('MAC address equals 00-15-5D*, 00-1D-D8*')&&shown.includes('10.10.0.180 – 10.10.0.199'),'server and scope policies with their conditions');
html=body({section:'failover'});shown=text(html);
ok(shown.includes('DC01-DC02')&&shown.includes('SRV-DC02.corp.example')&&shown.includes('Load balance 50 %')&&shown.includes('Normal')&&shown.includes('1 h')&&shown.includes('2 scopes')&&html.includes('title="10.10.0.0, 10.20.0.0"'),'the failover relationship');
shown=text(body({snapshot:{...snapshot,ipv4:{...snapshot.ipv4,failover:[]}},section:'failover'}));
ok(shown.includes('No failover relationships on this server Create a failover relationship so a partner server takes over when this one fails.'),'an empty section says so inside its wrap: the title without a period, then the next step');
check(dhcpFailoverMode({mode:'hotStandby',serverRole:'standby',reservePercent:5,loadBalancePercent:null},t),'Hot standby, standby, reserve 5 %','the hot standby mode');
check([dhcpDurationLabel(null,t),dhcpDurationLabel(691200,t),dhcpDurationLabel(86400,de),dhcpDurationLabel(5400,t)],['Unlimited','8 days','1 Tag','90 minutes'],'lease durations');
check(dhcpConditionSummary({condition:'or',criteria:[{type:'mac',operator:'equals',values:['00-15-5D*']},{type:'userClass',operator:'notEquals',values:['Guests']}]},t),'MAC address equals 00-15-5D* OR User class does not equal Guests','the condition summary');
shown=text(body({snapshot:{...snapshot,service:'stopped'}}));
ok(shown.includes('The DHCP Server service is stopped, so clients get no addresses from this server. Start the service in Management → Services.')&&shown.includes('Open Services'),'the stopped notice with Open Services');
shown=text(body({section:'policies'},'de'));
ok(shown.includes('Richtlinien')&&shown.includes('Bereich 10.10.0.0')&&shown.includes('MAC-Adresse ist gleich 00-15-5D*, 00-1D-D8*'),'German policies');

// ---- The scope drawer ----
const office=snapshot.ipv4.scopes[0];
let shownAll=0;
html=render(h(ScopeDetails,{scope:office,snapshot,now,t,locale:'en',usage:h('span',null,'usage'),onShowAll:()=>shownAll++}));shown=text(html);
ok(['Exclusions','Reservations','Scope options','Policies','Leases'].every(heading=>html.includes(`<h3 class="sdx-dhcp-subhead">${heading}</h3>`)),'the drawer sections');
ok(shown.includes('255.255.255.0')&&shown.includes('10.10.0.10 – 10.10.0.19')&&shown.includes('Campus')&&shown.includes('Show all in Leases')&&shown.includes('pc-anna.corp.example'),'facts, exclusions and the leases of the scope');
ok(!html.includes('<input')&&!html.includes('<select'),'the drawer has no edit controls');
await withHooks(()=>{
 const scopes=[],sections=[],filters=[];
 const props={snapshot,kpis,now,t,locale:'en',section:'scopes',onSection:value=>sections.push(value),family:'ipv4',onFamily:noop,superscope:'',onSuperscope:noop,leaseQuery:'x',onLeaseQuery:value=>filters.push(['query',value]),leaseScope:'',onLeaseScope:value=>filters.push(['scope',value]),leaseFilter:'',onLeaseFilter:value=>filters.push(['state',value]),openScope:null,onOpenScope:value=>scopes.push(value),onOpenServices:noop};
 let all=nodes(DhcpBody(props));
 const v4=tableOf(all,'dhcp-scopes-v4');v4.props.onOpen(v4.props.rows.find(row=>row.id==='10.20.0.0'));
 all.find(node=>node.props?.label==='Fullest scope').props.onSelect();
 check(scopes,['10.20.0.0','10.20.0.0'],'a row and the fullest-scope KPI open the scope drawer');
 props.openScope='10.10.0.0';all=nodes(DhcpBody(props));
 const drawer=all.find(node=>node.props?.open===true&&node.props?.footer);
 check([drawer.props.title,nodes(drawer.props.footer).find(node=>node.props?.children==='Close')!==undefined],['Office',true],'the drawer title and its Close button');
 const details=nodes(drawer.props.children).find(node=>node.props?.onShowAll);
 details.props.onShowAll();
 check([filters,sections,scopes.at(-1)],[[['scope','10.10.0.0'],['query',''],['state','']],['leases'],null],'Show all in Leases switches the tab with the scope filter and closes the drawer');
 // IPv6: a row opens the drawer of its prefix, with lifetimes, DUID and IAID.
 const v6=snapshot.ipv6.scopes[0];
 props.family='ipv6';props.openScope=null;all=nodes(DhcpBody(props));
 const v6Table=tableOf(all,'dhcp-scopes-v6');v6Table.props.onOpen(v6Table.props.rows.find(row=>row.prefix===v6.prefix));
 check(scopes.at(-1),v6.prefix,'an IPv6 row opens the scope drawer');
 props.openScope=v6.prefix;all=nodes(DhcpBody(props));
 const drawer6=all.find(node=>node.props?.open===true&&node.props?.footer);
 check(drawer6.props.title,v6.name||v6.prefix,'the IPv6 drawer title');
 const inner=nodes(drawer6.props.children).find(node=>node.props?.onShowAll);
 const html6=render(h(inner.type,inner.props));
 ok(['Exclusions','Reservations','Scope options','Leases'].every(heading=>html6.includes(`<h3 class="sdx-dhcp-subhead">${heading}</h3>`))&&!html6.includes('<h3 class="sdx-dhcp-subhead">Policies</h3>'),'the IPv6 drawer sections without policies');
 ok(text(html6).includes('Preferred lifetime')&&text(html6).includes('Valid lifetime')&&html6.includes('DUID')&&html6.includes('IAID')&&!html6.includes('<input'),'the IPv6 facts and reservation columns, read-only');
 inner.props.onShowAll();
 check([filters.at(-3),scopes.at(-1)],[['scope',v6.prefix],null],'Show all in Leases filters by the prefix');
});

// ---- The load states ----
const stateCase=(states,extra={})=>{
 hooks.cursor=0;hooks.states=[...states];
 return nodes(DeviceDhcp({...base,...extra}));
};
await withHooks(()=>{
 let all=stateCase([],{server:{...server,permissions:[]}});
 const locked=all.find(node=>node.props?.title==='You cannot view this DHCP server');
 ok(locked&&locked.props.children==='You need the permission View DHCP on this device.','no dhcp.read: the Lock empty state');
 all=stateCase([],{server:{...server,snapshot:{...server.snapshot,plugins:[]}}});
 const missing=all.find(node=>node.props?.title==='The DHCP extension is not installed');
 ok(missing&&missing.props.children==='Install the extension to see the scopes, leases and settings of this DHCP server.'&&missing.props.action.props.children==='Install extension','plugin not installed: Install plugin');
 all=stateCase([]);
 check(all.filter(node=>node.props?.variant==='cards'||node.props?.variant==='table').map(node=>node.props.variant),['cards','table'],'loading: card and table skeletons');
 all=stateCase([{serverId:'demo-dc',view:{snapshot:null,collectedAt:null,receivedAt:null,plugin:{version:'1.0.0',state:'ready'}}}]);
 const noData=all.find(node=>node.props?.title==='No DHCP data yet');
 ok(noData&&noData.props.children==='The DHCP data appears within 15 minutes. To get it now, select Read now.'&&noData.props.action.props.children==='Read now','no data yet: Read now');
 all=stateCase([null,'The request failed.']);
 const failed=all.find(node=>node.props?.tone==='danger');
 ok(failed&&[failed.props.children].flat(Infinity).includes('The DHCP data could not be loaded. Try again.')&&failed.props.action.props.children==='Try again','load error: the danger notice with Try again');
 failed.props.action.props.onClick();check(hooks.states[3],1,'Try again loads again');
 all=stateCase([{serverId:'demo-dc',view:{snapshot,collectedAt:now-60_000,receivedAt:now,plugin:{version:'1.0.0',state:'ready'}}},'The request failed.']);
 const stale=all.find(node=>node.props?.tone==='danger');
 ok(JSON.stringify([stale.props.children].flat(Infinity).map(item=>item?.props?.children??item)).includes('Showing the last loaded data.')&&all.some(node=>node.type===DhcpBody),'a failed refresh keeps the data with its line');
 // Read again: the blocked reasons and the queued job.
 const readButton=list=>list.find(node=>node.props?.children==='Read again');
 check(readButton(stateCase([],{demo:true})).props.blocked,'Not available for sample devices.','Read again: demo');
 check(readButton(stateCase([],{server:{...server,lastSeen:now-10*60_000}})).props.blocked,'The device is offline. Wait until it is online again.','Read again: offline');
 check(readButton(stateCase([],{server:{...server,snapshot:{...server.snapshot,plugins:[{...plugin,state:'damaged',error:'AGENT_PLUGIN_HASH_MISMATCH'}]}}})).props.blocked,'The DHCP extension is not installed. Install it in the Extensions area of this device.','Read again: a damaged plugin');
 check(readButton(stateCase([])).props.blocked,undefined,'Read again is free with the right, online and a ready plugin');
 ok(readButton(stateCase([null,'',false,0,{id:'job',since:now}])).props.loading,'Read again shows loading while its job is open');
 const damaged=stateCase([{serverId:'demo-dc',view:{snapshot,collectedAt:now,receivedAt:now,plugin:{version:'1.0.0',state:'damaged'}}}],{server:{...server,snapshot:{...server.snapshot,plugins:[{...plugin,state:'damaged',error:'AGENT_PLUGIN_HASH_MISMATCH'}]}}});
 ok(damaged.some(node=>node.props?.tone==='warning'&&node.props?.action?.props.children==='Repair extension'),'a damaged plugin shows Repair plugin');
});
html=render(h(DeviceDhcp,{...base,server:{...server,permissions:[]}}),'de');
ok(text(html).includes('Du kannst diesen DHCP-Server nicht ansehen')&&text(html).includes('Dir fehlt auf diesem Gerät die Berechtigung „DHCP ansehen“.'),'German locked state');

// ---- Changes (plugin 1.1.0): section actions, row menus, forms, confirmations ----
const forms=await import('../../../ui/devices/extensions/dhcp-forms.tsx');
// The change tables and form parts are small components without hooks: the walk expands them.
const expand=new Set(['LeaseTable','OptionTable','PolicyTable','DurationField','ScopePick','Subhead']);
const deep=node=>{if(!node||typeof node!=='object')return [];const own=typeof node.type==='function'&&expand.has(node.type.name)?deep(node.type(node.props)):[];return [node,...own,...[node.props?.children,node.props?.toolbar,node.props?.filters,node.props?.actions,...tableParts(node)].flat(Infinity).flatMap(deep)];};
const {Field}=await import('../../../ui/kit/field.tsx');
const {DHCP_CHANGE_OPERATIONS}=await import('../../../lib/plugin-catalog.ts');
const {openDhcpChangeJobs,dhcpClientPartners}=await import('../../../ui/devices/extensions/device-dhcp.tsx');
const fake=(blocked={})=>{const log={open:[],change:[],replicate:[]};return {log,manage:{blocked:operation=>blocked[operation],partnerBlocked:partner=>partner==='SRV-DC02.corp.example'?undefined:t('dhcp.blocked.partner',{partner}),open:form=>log.open.push(form),change:change=>log.change.push(change),replicate:(name,scope)=>log.replicate.push([name,scope??null])}};};
const labels=entries=>entries.map(entry=>'separator' in entry?'—':entry.label);
const bodyProps=(manage,extra={})=>({snapshot,kpis,now,t,locale:'en',section:'scopes',onSection:noop,family:'ipv4',onFamily:noop,superscope:'',onSuperscope:noop,leaseQuery:'',onLeaseQuery:noop,leaseScope:'',onLeaseScope:noop,leaseFilter:'',onLeaseFilter:noop,openScope:null,onOpenScope:noop,onOpenServices:noop,manage,...extra});
const menus=all=>all.filter(node=>Array.isArray(node.props?.entries));
await withHooks(()=>{
 const {log,manage}=fake();
 // Scopes: New scope first in the toolbar, the superscope actions, a row menu per scope.
 let all=deep(DhcpBody(bodyProps(manage)));
 const newScope=all.find(node=>node.props?.children==='New scope');
 ok(newScope&&newScope.props.icon&&newScope.props.blocked===undefined,'Scopes: the New scope button');
 newScope.props.onClick();check(log.open.at(-1),{kind:'scope',family:'ipv4'},'New scope opens the IPv4 scope form');
 const superscopeMenu=menus(all).find(node=>node.props.label==='Superscope actions');
 check(labels(superscopeMenu.props.entries),['Create superscope'],'Superscope actions without a selected superscope');
 const rows=menus(all).filter(node=>node.props.label.startsWith('Actions for '));
 check(rows.map(node=>node.props.label),['Actions for Office','Actions for Wi-Fi Guests','Actions for Lab'],'one row menu per IPv4 scope');
 check(labels(rows[0].props.entries),['Edit scope','Deactivate scope','—','Delete scope'],'the row menu of an active scope');
 check(labels(rows[2].props.entries),['Edit scope','Activate scope','—','Delete scope'],'the row menu of an inactive scope');
 check(rows[0].props.entries.at(-1).blocked,'Scope 10.10.0.0 is part of failover relationship DC01-DC02. Remove the scope from the relationship on the Failover tab, and try again.','a failover scope cannot be deleted: the entry says why');
 ok(rows[0].props.entries.at(-1).danger&&rows[2].props.entries.at(-1).blocked===undefined,'Delete scope is a danger entry, free for a scope without failover');
 rows[0].props.entries[0].onSelect();rows[0].props.entries[1].onSelect();rows[2].props.entries.at(-1).onSelect();
 check([log.open.at(-1),log.change.slice(-2).map(change=>[change.operation,change.parameters,change.label])],[{kind:'scope',family:'ipv4',id:'10.10.0.0'},[['dhcp-scope-deactivate',{family:'ipv4',scopeId:'10.10.0.0'},'dhcp.op.scopeDeactivate'],['dhcp-scope-delete',{family:'ipv4',scopeId:'10.30.0.0'},'dhcp.op.scopeDelete']]],'Edit opens the form, Deactivate and Delete go to the confirmation');
 all=deep(DhcpBody(bodyProps(manage,{superscope:'Campus'})));
 check(labels(menus(all).find(node=>node.props.label==='Superscope actions').props.entries),['Create superscope','Edit superscope','Activate superscope','Deactivate superscope','—','Delete superscope'],'Superscope actions for a selected superscope');
 all=deep(DhcpBody(bodyProps(manage,{family:'ipv6'})));
 check(labels(menus(all).find(node=>node.props.label==='Actions for Office IPv6').props.entries),['Edit scope','Deactivate scope','—','Delete scope'],'IPv6 rows have the same menu');
 // Leases: selection and the bulk bar, the row menu.
 hooks.cursor=0;hooks.states=[['ipv4|10.20.0.15','ipv4|10.20.0.16']];
 all=deep(DhcpBody(bodyProps(manage,{section:'leases'})));
 const bulk=all.find(node=>node.type?.name==='BulkBar');
 ok(bulk&&bulk.props.count===2&&bulk.props.label==='Selected leases','the kit BulkBar counts the selection ("2 selected")');
 ok(render(h(bulk.type,bulk.props)).includes('<strong aria-live="polite">2 selected</strong>'),'it renders "2 selected"');
 const deleteLeases=deep(bulk).find(node=>node.props?.children==='Delete leases');
 check([deleteLeases.props.variant,deleteLeases.props.blocked],['danger',undefined],'Delete leases is a danger button');
 deleteLeases.props.onClick();
 check([log.change.at(-1).operation,log.change.at(-1).parameters,log.change.at(-1).label],['dhcp-lease-delete',{family:'ipv4',scopeId:'10.20.0.0',addresses:['10.20.0.15','10.20.0.16']},'dhcp.op.leaseDelete'],'the selected leases of one scope');
 hooks.cursor=0;hooks.states=[['ipv4|10.20.0.15','ipv4|10.10.0.101']];
 all=deep(DhcpBody(bodyProps(manage,{section:'leases'})));
 check(all.find(node=>node.props?.children==='Delete leases').props.blocked,'Select the leases of one scope.','leases of two scopes are blocked with the reason');
 const leaseMenu=menus(all).find(node=>node.props.label==='Actions for 10.20.0.15');
 check(labels(leaseMenu.props.entries),['Add reservation','Delete lease'],'the lease row menu');
 leaseMenu.props.entries[0].onSelect();
 check([log.open.at(-1).kind,log.open.at(-1).scope,log.open.at(-1).lease.address],['reservation','10.20.0.0','10.20.0.15'],'Add reservation from a lease');
 const leaseTable=tableOf(all,'dhcp-leases');
 check([leaseTable.props.selection.rowLabel(leaseTable.props.rows.find(row=>row.address==='10.20.0.15')),leaseTable.props.selection.allLabel,leaseTable.props.rowKey(leaseTable.props.rows[0]).includes('|')],['Select lease 10.20.0.15','Select all shown leases',true],'DataTable selection: a labelled checkbox per lease, keyed family|address');
 // Reservations, options, policies and failover.
 hooks.cursor=0;hooks.states=[];
 all=deep(DhcpBody(bodyProps(manage,{section:'reservations'})));
 ok(all.some(node=>node.props?.children==='Add reservation'&&node.props.onClick),'Reservations: Add reservation');
 check(labels(menus(all).find(node=>node.props.label==='Actions for 10.10.0.20').props.entries),['Edit reservation','Remove reservation'],'the reservation row menu');
 all=deep(DhcpBody(bodyProps(manage,{section:'options'})));
 check(all.filter(node=>node.props?.children==='Set option').length,2,'Options: Set option for IPv4 and IPv6');
 check(labels(menus(all).find(node=>node.props.label==='Actions for 6 DNS Servers').props.entries),['Edit option','Remove option'],'the option row menu');
 all=deep(DhcpBody(bodyProps(manage,{section:'policies'})));
 ok(all.some(node=>node.props?.children==='New policy'),'Policies: New policy');
 const policyMenu=menus(all).find(node=>node.props.label==='Actions for Printers');
 check(labels(policyMenu.props.entries),['Edit policy','Turn off policy','Set option','—','Delete policy'],'the policy row menu');
 policyMenu.props.entries[1].onSelect();
 check([log.change.at(-1).operation,log.change.at(-1).parameters.enabled,log.change.at(-1).label],['dhcp-policy-edit',false,'dhcp.op.policyDisable'],'Disable policy is an edit with enabled false');
 all=deep(DhcpBody(bodyProps(manage,{section:'failover'})));
 ok(all.some(node=>node.props?.children==='New failover relationship'),'Failover: New failover relationship');
 const failoverMenu=menus(all).find(node=>node.props.label==='Actions for DC01-DC02');
 check(labels(failoverMenu.props.entries),['Edit relationship','Replicate relationship','—','Remove relationship'],'the failover row menu');
 failoverMenu.props.entries[1].onSelect();check(log.replicate.at(-1),['DC01-DC02',null],'Replicate relationship');
 const unmatched=fake();unmatched.manage.partnerBlocked=partner=>t('dhcp.blocked.partner',{partner});
 all=deep(DhcpBody(bodyProps(unmatched.manage,{section:'failover'})));
 check(menus(all).find(node=>node.props.label==='Actions for DC01-DC02').props.entries.slice(0,2).map(entry=>entry.blocked),Array(2).fill('SRV-DC02.corp.example is not a device in Nodiverna, or it does not run the DHCP extension. Set up this failover relationship in the DHCP console on the server.'),'partner-dependent entries name the missing partner');
 // A blocked manage keeps every control visible with its reason.
 const blocked=fake(Object.fromEntries(DHCP_CHANGE_OPERATIONS.map(operation=>[operation,'Not available for sample devices.'])));
 all=deep(DhcpBody(bodyProps(blocked.manage)));
 check([all.find(node=>node.props?.children==='New scope').props.blocked,menus(all).find(node=>node.props.label==='Actions for Lab').props.entries[0].blocked],['Not available for sample devices.','Not available for sample devices.'],'blocked controls stay visible with the reason');
 // The scope drawer: Edit scope in the footer, add buttons per section, Replicate scope in the head.
 all=deep(DhcpBody(bodyProps(manage,{openScope:'10.10.0.0'})));
 const drawer=all.find(node=>node.props?.open===true&&node.props?.footer);
 check(deep(drawer.props.footer).filter(node=>typeof node.props?.children==='string').map(node=>node.props.children),['Edit scope','Close'],'the drawer footer: Edit scope and Close');
 check(labels(menus(deep(drawer.props.description))[0].props.entries),['Replicate scope'],'a failover scope has Replicate scope in the drawer head');
 const details=deep(drawer.props.children).find(node=>node.props?.onShowAll);
 const inner=deep(details.type(details.props));
 check(['Add exclusion','Add reservation','Set option','New policy'].map(label=>inner.some(node=>node.props?.children===label)),[true,true,true,true],'the drawer sections have their add buttons');
 inner.find(node=>node.props?.children==='Add exclusion').props.onClick();
 check(log.open.at(-1),{kind:'exclusion',family:'ipv4',scope:'10.10.0.0',from:'10.10.0.0'},'a drawer form remembers the scope to return to');
});

// ---- The forms ----
const formRun=(Component,props,preset={})=>{hooks.cursor=0;hooks.states=[];for(const [index,value] of Object.entries(preset))hooks.states[index]=value;const shell=Component(props);return {shell,drawer:shell.type(shell.props)};};
const fieldsOf=drawer=>deep(drawer).filter(node=>node.type===Field).map(node=>[typeof node.props.label==='string'?node.props.label:'?',node.props.error??null]);
const formProps=(form,extra={})=>({form,snapshot,busy:false,serverErrors:[],onCancel:noop,onSubmit:noop,t,partners:[],...extra});
const submitOf=drawer=>deep(drawer).find(node=>node.type==='form').props.onSubmit;
const submitButton=drawer=>deep(drawer.props.footer).find(node=>node.props?.type==='submit');
await withHooks(()=>{
 let {drawer}=formRun(forms.ScopeForm,formProps({kind:'scope',family:'ipv4'}));
 check(fieldsOf(drawer).map(([label])=>label),['Name','Description','Start address','End address','Subnet mask','Lease duration','Unit','Unlimited','Type','Activate the scope now'],'the IPv4 scope form fields');
 check([drawer.props.title,submitButton(drawer).props.children,deep(drawer.props.footer).find(node=>node.props?.children==='Cancel')!==undefined],['Create scope','Create scope',true],'the drawer title and footer: Cancel and Create scope');
 // The first submit shows the field errors; a later render keeps them.
 const submitted=[];
 ({drawer}=formRun(forms.ScopeForm,formProps({kind:'scope',family:'ipv4'},{onSubmit:change=>submitted.push(change)}),{0:'Lab 2',2:'10.40.0.300',3:'10.40.0.20'}));
 submitOf(drawer)({preventDefault:noop});
 check(submitted,[],'an invalid form submits nothing');
 ({drawer}=formRun(forms.ScopeForm,formProps({kind:'scope',family:'ipv4'}),{0:'Lab 2',2:'10.40.0.300',3:'10.40.0.20',11:true}));
 check(fieldsOf(drawer).find(([label])=>label==='Start address')[1],'Enter an IPv4 address, for example 10.0.0.10.','the error under its field after the first submit');
 ({drawer}=formRun(forms.ScopeForm,formProps({kind:'scope',family:'ipv4'},{onSubmit:change=>submitted.push(change)}),{0:'Lab 2',2:'10.40.0.10',3:'10.40.0.200',4:'255.255.255.0'}));
 submitOf(drawer)({preventDefault:noop});
 check([submitted[0].operation,submitted[0].label,submitted[0].parameters],['dhcp-scope-create','dhcp.op.scopeCreate',{family:'ipv4',name:'Lab 2',description:'',startRange:'10.40.0.10',endRange:'10.40.0.200',leaseDurationSeconds:691200,type:'dhcp',subnetMask:'255.255.255.0',activate:true}],'a valid scope submits the change');
 check(forms.classMask('172.16.0.10'),'255.255.0.0','the subnet mask comes from the address class');
 ({drawer}=formRun(forms.ScopeForm,formProps({kind:'scope',family:'ipv4',id:'10.10.0.0'})));
 check([drawer.props.title,submitButton(drawer).props.children,submitButton(drawer).props.blocked],['Edit scope','Save scope','No changes.'],'an unchanged edit: Save scope is blocked with No changes');
 ({drawer}=formRun(forms.ScopeForm,formProps({kind:'scope',family:'ipv6'})));
 check(fieldsOf(drawer).map(([label])=>label),['Prefix','Name','Description','Preference','Activate the scope now'],'the IPv6 scope form fields');
 ({drawer}=formRun(forms.SuperscopeForm,formProps({kind:'superscope'})));
 ok(deep(drawer).some(node=>node.type==='legend'&&node.props.children==='Scopes in this superscope')&&deep(drawer).filter(node=>node.props?.className==='sdx-check').length===3,'the superscope form: name and a pick list of the IPv4 scopes');
 ({drawer}=formRun(forms.ExclusionForm,formProps({kind:'exclusion',family:'ipv4',scope:'10.10.0.0'})));
 check(deep(drawer).filter(node=>node.type===Field).map(node=>[node.props.label,node.props.hint??null]),[['Start address','The scope range is 10.10.0.10 – 10.10.0.209.'],['End address',null]],'the exclusion form with the scope range in the hint');
 const lease=snapshot.leases.items.find(item=>item.address==='10.20.0.15');
 ({drawer}=formRun(forms.ReservationForm,formProps({kind:'reservation',family:'ipv4',scope:'10.20.0.0',lease})));
 const inputs=deep(drawer).filter(node=>node.type==='input').map(node=>node.props.value);
 check([fieldsOf(drawer).map(([label])=>label),inputs.slice(0,3)],[['Address','MAC address or client ID','Name','Description','Type'],['10.20.0.15','a4-83-e7-12-34-56','guest-phone-01']],'a reservation from a lease is filled in');
 ({drawer}=formRun(forms.ReservationForm,formProps({kind:'reservation',family:'ipv4'})));
 check(fieldsOf(drawer)[0][0],'Scope','Add reservation outside a scope asks for the scope');
 ({drawer}=formRun(forms.ReservationForm,formProps({kind:'reservation',family:'ipv6',scope:'2001:db8:10::'})));
 check(fieldsOf(drawer).map(([label])=>label),['Address','DUID','IAID'],'the IPv6 reservation: DUID and IAID, no name');
 ({drawer}=formRun(forms.ReservationForm,formProps({kind:'reservation',family:'ipv4',scope:'10.10.0.0',address:'10.10.0.20'},{serverErrors:[{field:'address',code:'reservationAddress',params:{address:'10.10.0.20'}}]})));
 check(fieldsOf(drawer)[0][1],'Address 10.10.0.20 already has a reservation. Choose another address.','a server changeInvalid error shows under its field');
 ({drawer}=formRun(forms.OptionForm,formProps({kind:'option',family:'ipv4',level:'server'})));
 check(deep(drawer).filter(node=>node.type===Field).map(node=>[node.props.label,node.props.hint??null]),[['Option',null],['Vendor class',null],['User class',null],['Values','Enter IPv4 addresses, one value per line.']],'the option form: the definitions and the value type in the hint');
 check(deep(drawer).filter(node=>node.type==='option').slice(0,2).map(node=>node.props.children),['3 Router','6 DNS Servers'],'the option select lists "{code} {name}"');
 ({drawer}=formRun(forms.PolicyForm,formProps({kind:'policy',scope:'10.10.0.0'})));
 ok(['Name','Description','On','Processing order','Lease duration','Use the scope lease duration'].every(label=>fieldsOf(drawer).some(([name])=>name===label))&&deep(drawer).some(node=>node.type==='legend'&&node.props.children==='Address ranges')&&deep(drawer).some(node=>node.props?.children==='Add condition'),'the scope policy form with conditions and ranges');
 ({drawer}=formRun(forms.PolicyForm,formProps({kind:'policy',scope:null})));
 ok(!deep(drawer).some(node=>node.type==='legend'&&node.props.children==='Address ranges'),'a server policy has no ranges');
 const partners=[{id:'p1',name:'SRV-DC02',serverName:'SRV-DC02.corp.example',addresses:[]},{id:'p2',name:'SRV-OLD',serverName:null,addresses:[],blocked:'Update the DHCP extension to 1.1.0 or later to change the DHCP server.'}];
 ({drawer}=formRun(forms.FailoverForm,formProps({kind:'failover'},{partners}),{11:true}));
 check(deep(drawer).filter(node=>node.type==='option').map(node=>[node.props.children,!!node.props.disabled]),[['SRV-DC02',false],['SRV-OLD: Update the DHCP extension to 1.1.0 or later to change the DHCP server.',true]],'the partner select: disabled options say why');
 const secret=deep(drawer).find(node=>node.type==='input'&&node.props.type==='password');
 check([secret.props.autoComplete,secret.props.value],['new-password',''],'the shared secret: password field, never pre-filled');
 ({drawer}=formRun(forms.FailoverForm,formProps({kind:'failover'},{partners,secretBlocked:'Update the agent on SRV-DC01 to 4.17.0 or later to set a shared secret.'}),{11:true}));
 check(deep(drawer).find(node=>node.type===Field&&node.props.label==='Shared secret').props.hint,'Update the agent on SRV-DC01 to 4.17.0 or later to set a shared secret.','the secret field is blocked with the 4.17.0 reason');
 ({drawer}=formRun(forms.FailoverForm,formProps({kind:'failover',name:'DC01-DC02'},{partners})));
 check([drawer.props.title,submitButton(drawer).props.children,submitButton(drawer).props.blocked],['Edit relationship','Save relationship','No changes.'],'the failover edit');
 ok(deep(drawer).some(node=>node.type==='legend'&&node.props.children==='Remove scopes'),'the failover edit adds and removes scopes');
});

// ---- Confirmations ----
const partnersOf=[{id:'dc02',name:'SRV-DC02',serverName:'SRV-DC02.corp.example',addresses:[]}];
const context=(partners=partnersOf,tr=t)=>({device:{id:'dc01',name:'SRV-DC01'},snapshot,collectedAt:now-6*60_000,partners,time:()=>'6 min ago',t:tr});
const settled=noop;
let confirmation=forms.dhcpConfirmation(forms.dhcpChange('dhcp-reservation-add',{family:'ipv4',scopeId:'10.10.0.0',address:'10.10.0.60',clientId:'00-15-5D-01-02-03',name:'pc',description:'',type:'dhcp'}),context(),settled);
check([confirmation.title,confirmation.lines,confirmation.description,confirmation.confirmLabel,confirmation.tone,confirmation.endpoint,confirmation.success],['Change the DHCP server on SRV-DC01?',[{label:'Device',value:'SRV-DC01'},{label:'Change',value:'Add reservation'},{label:'Object',value:'10.10.0.60'},{label:'Failover partner',value:'SRV-DC02'}],'Scope 10.10.0.0 is part of failover relationship DC01-DC02. Nodiverna makes the same change on SRV-DC02.','Add reservation','default','/api/dhcp','Change queued: Add reservation. You see the progress below in Jobs.'],'a mirrored change: lines, sentence, verb and toast');
check(confirmation.payload,{action:'change',serverId:'dc01',operation:'dhcp-reservation-add',parameters:{family:'ipv4',scopeId:'10.10.0.0',address:'10.10.0.60',clientId:'00-15-5D-01-02-03',name:'pc',description:'',type:'dhcp'},confirm:true},'the payload for POST /api/dhcp');
confirmation=forms.dhcpConfirmation(forms.dhcpChange('dhcp-scope-deactivate',{family:'ipv4',scopeId:'10.10.0.0'}),context([]),settled);
check(confirmation.description,'The scope stops giving out addresses. Scope 10.10.0.0 is part of failover relationship DC01-DC02. SRV-DC02.corp.example is not a device in Nodiverna and keeps the old setting. Replicate the relationship in the DHCP console on the server.','an unmanaged partner: the change stays local and the confirmation says so');
const tones=['dhcp-scope-delete','dhcp-superscope-delete','dhcp-policy-delete','dhcp-failover-remove','dhcp-lease-delete','dhcp-exclusion-remove','dhcp-reservation-remove'];
check(tones.map(operation=>forms.dhcpConfirmation(forms.dhcpChange(operation,{family:'ipv4',scopeId:'10.30.0.0',name:'x',addresses:['10.30.0.11'],start:'10.30.0.10',end:'10.30.0.12',address:'10.30.0.20'}),context(),settled).tone),tones.map(()=>'danger'),'deletes and removals use the danger tone');
check(forms.dhcpConfirmation(forms.dhcpChange('dhcp-scope-delete',{family:'ipv4',scopeId:'10.30.0.0'}),context(),settled).description,'The scope, its reservations and its leases are deleted. Clients keep their address until their lease ends.','the scope delete sentence');
check(forms.dhcpConfirmation(forms.dhcpChange('dhcp-lease-delete',{family:'ipv4',scopeId:'10.30.0.0',addresses:['10.30.0.11']},'dhcp.op.leaseDeleteOne'),context(),settled).description,'1 lease is deleted. The client asks for an address again at its next renewal.','one lease');
check(forms.dhcpConfirmation(forms.dhcpChange('dhcp-superscope-delete',{name:'Campus'}),context(),settled).description,'The superscope is deleted. Its scopes stay.','the superscope delete sentence');
check(forms.dhcpConfirmation(forms.dhcpChange('dhcp-failover-create',{name:'DC01-DC03',partner:'SRV-DC02',scopeIds:['10.30.0.0']}),context(),settled).description,'The relationship is created on SRV-DC01.corp.example and SRV-DC02. SRV-DC02 gets 1 scope with its settings.','failover create on both servers');
check(forms.dhcpConfirmation(forms.dhcpChange('dhcp-failover-edit',{name:'DC01-DC02',removeScopeIds:['10.20.0.0']}),context(),settled).description,'The change is made on SRV-DC01.corp.example and SRV-DC02. The removed scopes stay on SRV-DC01.corp.example and are deleted on SRV-DC02.','failover edit with a removed scope');
check(forms.dhcpConfirmation(forms.dhcpChange('dhcp-failover-remove',{name:'DC01-DC02',deletePartnerScopes:true}),context([]),settled).description,'SRV-DC02.corp.example is not a device in Nodiverna, so the relationship and its scopes stay on SRV-DC02.corp.example. To remove them, use the DHCP console on SRV-DC02.corp.example.','a local-only removal warns');
confirmation=forms.dhcpReplicateConfirmation('DC01-DC02',null,context(),settled);
check([confirmation.description,confirmation.confirmLabel,confirmation.payload],['Nodiverna copies the settings of 2 scopes from SRV-DC01.corp.example to SRV-DC02, as read 6 min ago. Settings on SRV-DC02 that differ are overwritten.','Replicate relationship',{action:'replicate',serverId:'dc01',relationship:'DC01-DC02',confirm:true}],'replicate with the age of the read');
const german=forms.dhcpConfirmation(forms.dhcpChange('dhcp-scope-delete',{family:'ipv4',scopeId:'10.30.0.0'}),context(partnersOf,de),settled);
check([german.title,german.confirmLabel,german.success],['DHCP-Server auf SRV-DC01 ändern?','Bereich löschen','Änderung eingeplant: Bereich löschen. Den Fortschritt siehst du unten bei den Aufträgen.'],'the German confirmation');
check(forms.dhcpFieldErrorText({field:'values',code:'optionValue',params:{line:2,type:'ipAddress'}},de),'Zeile 2 ist kein gültiger Wert vom Typ IPv4-Adresse. Korrigiere diese Zeile.','a German field error with the type name');

// ---- The view: running changes, the manage gate, the demo ----
const change=(id,state='running',target='dhcp-scope-create')=>({id,serverId:'demo-dc',action:'plugin-job',target,state,createdAt:now,claimedAt:now,result:null,actor:'x'});
check(openDhcpChangeJobs([change('a'),change('b','pending'),change('c','succeeded'),change('d','running','dhcp-read')],'demo-dc').map(job=>job.id),['a','b'],'the open change jobs of the device');
const manageServer={...server,management:1,permissions:['dhcp.read','dhcp.manage'],snapshot:{...server.snapshot,mode:'Management',agentCapabilities:['plugin-host','plugin-secrets','plugin-ad-identity'],plugins:[{...plugin,version:'1.1.0',capabilities:['dhcp-read',...DHCP_CHANGE_OPERATIONS]}]}};
const loadedView={serverId:'demo-dc',view:{snapshot,collectedAt:now-60_000,receivedAt:now,plugin:{version:'1.1.0',state:'ready'}}};
await withHooks(()=>{
 const caseOf=(extra,states=[loadedView])=>{hooks.cursor=0;hooks.states=[...states];return deep(DeviceDhcp({...base,server:manageServer,...extra}));};
 let all=caseOf({jobs:[change('a'),change('b','pending')]});
 const headMeta=all.find(node=>node.props?.hideTitle&&node.props?.meta)?.props.meta;ok(headMeta&&headMeta.props['aria-live']==='polite'&&/· 2 changes running$/.test(headMeta.props.children),'the SectionHead meta counts the running changes, announced politely');
 check(all.find(node=>node.props?.children==='Read again').props.variant,'secondary','Read again is a secondary button');
 const bodyNode=all.find(node=>node.type===DhcpBody);
 check(bodyNode.props.manage.blocked('dhcp-scope-create'),undefined,'free with the right, plugin 1.1.0 and Management mode');
 all=caseOf({server:{...manageServer,permissions:['dhcp.read']}});
 check(all.find(node=>node.type===DhcpBody).props.manage.blocked('dhcp-scope-create'),'You need the permission Manage DHCP on this device.','without dhcp.manage');
 all=caseOf({server:{...manageServer,management:0}});
 check(all.find(node=>node.type===DhcpBody).props.manage.blocked('dhcp-scope-create'),'Switch the device to Management mode to change the DHCP server.','in ReadOnly');
 all=caseOf({server:{...manageServer,snapshot:{...manageServer.snapshot,plugins:[plugin]}}});
 check(all.find(node=>node.type===DhcpBody).props.manage.blocked('dhcp-scope-create'),'Update the DHCP extension to 1.1.0 or later to change the DHCP server.','with plugin 1.0.0');
 all=caseOf({server:{...manageServer,snapshot:{...manageServer.snapshot,agentCapabilities:['plugin-host','plugin-secrets']}}});
 check(all.find(node=>node.type===DhcpBody).props.manage.blocked('dhcp-scope-create'),'To change this server through an extension, update the agent on SRV-DC01 to 4.19.0 or later.','an agent before 4.19.0 names the device');
 all=caseOf({demo:true},[]);
 check(all.find(node=>node.type===DhcpBody).props.manage.blocked('dhcp-reservation-add'),'Not available for sample devices.','demo: every change is blocked');
 // A form drawer replaces the scope drawer; the failover form gets the partner devices.
 all=caseOf({devices:[manageServer,{...manageServer,id:'dc02',name:'SRV-DC02'}]},[loadedView,'',false,0,null,false,'scopes','ipv4','','','','','10.10.0.0',{kind:'failover'}]);
 const formDrawer=all.find(node=>node.type===forms.DhcpFormDrawer);
 check([formDrawer.props.form,formDrawer.props.partners.map(item=>item.name)],[{kind:'failover'},['SRV-DC02']],'the open form with the partner candidates');
 check(dhcpClientPartners([manageServer,{...manageServer,id:'dc02',name:'SRV-DC02',snapshot:{...manageServer.snapshot,hostname:'srv-dc02',domain:'corp.example'}}],'demo-dc')[0].serverName,'srv-dc02.corp.example','the client knows the partner by host name and domain');
});
await withHooks(()=>{
 // A read with cut reservations cannot be copied to a partner: create, replicate and Replicate scope say why.
 const cut={...snapshot,truncated:{...snapshot.truncated,reservations:true}},reason='Nodiverna received only part of the reservations of this server. Set up or replicate this relationship in the DHCP console on the server.';
 let all=deep(DhcpBody({...bodyProps(fake().manage,{section:'failover'}),snapshot:cut}));
 check([all.find(node=>node.props?.children==='New failover relationship').props.blocked,menus(all).find(node=>node.props.label==='Actions for DC01-DC02').props.entries[1].blocked],[reason,reason],'a truncated read blocks New failover relationship and Replicate relationship');
 all=deep(DhcpBody({...bodyProps(fake().manage,{openScope:'10.10.0.0'}),snapshot:cut}));
 check(menus(deep(all.find(node=>node.props?.open===true&&node.props?.footer).props.description))[0].props.entries[0].blocked,reason,'and Replicate scope');
 const {drawer}=formRun(forms.FailoverForm,formProps({kind:'failover'},{snapshot:cut,partners:[{id:'p1',name:'SRV-DC02',serverName:null,addresses:[]}]}));
 check(submitButton(drawer).props.blocked,reason,'the failover create form is blocked with the same reason');
});
html=render(h(DhcpBody,{...bodyProps(fake().manage),t:de,locale:'de'}),'de');
ok(text(html).includes('Neuer Bereich'),'German section action');

// ---- The kit frame (UI-Rework 13b) ----
{
 html=render(h(DeviceDhcp,{...base,demo:true}));
 ok(/<div class="sdx-notice sdx-notice-info" role="status">.*?<div>[^<]+ You can still see the scopes, leases and settings of this DHCP server\.<\/div>/.test(html),'one PanelUnavailable for the change actions, with dhcp.readOnly');
 ok(render(h(DeviceDhcp,{...base,demo:true}),'de').includes('Bereiche, Leases und Einstellungen dieses DHCP-Servers siehst du weiterhin.'),'German read-only sentence');
 const ids={scopes:'dhcp-scopes-v4',leases:'dhcp-leases',reservations:'dhcp-reservations',options:'dhcp-options-v4',policies:'dhcp-policies',failover:'dhcp-failover'};
 for(const [section,id] of Object.entries(ids)){
  const markup=render(h(DhcpBody,bodyProps(fake().manage,{section})));
  ok(/<div class="sdx-table-wrap" role="region" aria-label="[^"]+"/.test(markup)&&markup.includes('<table class="sdx-table sdx-data-table">'),`${section}: a kit DataTable (${id})`);
 }
 ok(/aria-label="IPv6 server options"/.test(render(h(DhcpBody,bodyProps(fake().manage,{section:'options'})))),'the IPv6 server options are their own DataTable');
 const scopes=render(h(DhcpBody,bodyProps(fake().manage)));
 ok(/<div class="sdx-toolbar"><div class="sdx-toolbar-filters"><div class="sdx-segmented sdx-segmented-sm" role="group" aria-label="Scopes">/.test(scopes)&&/<div class="sdx-toolbar-filters">.*<select class="sdx-select sdx-select-sm" aria-label="Superscope"/.test(scopes)&&/<div class="sdx-toolbar-actions">.*New scope/.test(scopes),'Scopes: one kit Toolbar with the family Segmented, the superscope Select sm and New scope');
 const leasesHtml=render(h(DhcpBody,bodyProps(fake().manage,{section:'leases'})));
 ok(/<label class="sdx-searchfield sdx-toolbar-search">/.test(leasesHtml),'Leases: the kit toolbar search');
 check((leasesHtml.match(/class="sdx-select sdx-select-sm"/g)??[]).length,2,'Leases: two Select sm filters (scope and state)');
 ok(/<div class="sdx-table-foot"><p>20 of 20 leases<\/p>/.test(leasesHtml),'the lease count is the table foot');
 ok(leasesHtml.includes('<th scope="col" class="sdx-col-check">'),'lease selection through DataTable selection');
 const empty=render(h(DhcpBody,{...bodyProps(fake().manage,{section:'failover'}),snapshot:{...snapshot,ipv4:{...snapshot.ipv4,failover:[]}}}));
 ok(/<tr class="sdx-table-empty"><td colSpan="\d+"><div class="sdx-empty">.*<strong>No failover relationships on this server<\/strong><p>Create a failover relationship so a partner server takes over when this one fails\.<\/p>/.test(empty),'an empty list shows the kit Empty: the fact as its title, the next step as its sentence');
 const source=fs.readFileSync('ui/devices/extensions/device-dhcp.tsx','utf8');
 check(['<table','<select','sdx-searchfield','className="sdx-bulkbar"','sdx-roles-count','sdx-health-head','function Fact','variant="primary"','function Table','LeaseTable','OptionTable','PolicyTable'].filter(literal=>source.includes(literal)),[],'device-dhcp.tsx: no hand table, select, search field, bulk bar, count, head, Fact or primary');
 ok(!/\.sdx-roles-count|\.sdx-dhcp-empty|sdx-dhcp-head/.test(fs.readFileSync('ui/devices/extensions/extensions.css','utf8')+fs.readFileSync('ui/devices/extensions/dhcp.css','utf8')),'their CSS is gone');
}

// ---- Empty states (nodiverna-ui §5): a title without a period, the next-step sentence and at most one action ----
await withHooks(()=>{
 const bare={...snapshot,ipv4:{...snapshot.ipv4,scopes:[],superscopes:[],serverOptions:[],policies:[],failover:[]},ipv6:{...snapshot.ipv6,scopes:[],serverOptions:[]},leases:{...snapshot.leases,items:[],total:0,truncated:false}};
 const germanProps=(manage,extra={})=>bodyProps(manage,{snapshot:bare,t:de,locale:'de',...extra});
 const emptyIn=(element,label)=>deep(element).find(node=>node.props?.label===label&&Array.isArray(node.props.columns)).props.empty;
 const shape=empty=>[empty.title,empty.children,empty.action?.props.children??null];
 const {log,manage}=fake();
 // Scopes: New scope for the shown family; with a superscope filter, Reset filters.
 let empty=emptyIn(DhcpBody(germanProps(manage)),de('dhcp.tab.scopes'));
 check(shape(empty),['Keine Bereiche auf diesem Server','Erstelle einen Bereich, damit der Server Adressen vergeben kann.','Neuer Bereich'],'Scopes IPv4: title, sentence and New scope');
 empty.action.props.onClick();check(log.open.at(-1),{kind:'scope',family:'ipv4'},'New scope opens the IPv4 scope form');
 empty=emptyIn(DhcpBody(germanProps(manage,{family:'ipv6'})),de('dhcp.tab.scopes'));
 empty.action.props.onClick();check([empty.action.props.children,log.open.at(-1)],['Neuer Bereich',{kind:'scope',family:'ipv6'}],'Scopes IPv6: New scope opens the IPv6 scope form');
 const superscopes=[];
 empty=emptyIn(DhcpBody(germanProps(manage,{superscope:'Campus',onSuperscope:value=>superscopes.push(value)})),de('dhcp.tab.scopes'));
 check(shape(empty),['Kein Bereich passt zum Filter','Setze den Filter zurück, um alle Bereiche zu sehen.','Filter zurücksetzen'],'Scopes with a superscope filter: Reset filters');
 empty.action.props.onClick();check(superscopes,[''],'Reset filters shows all superscopes');
 // Leases: Show scopes without a search or filter; Clear search with a search only; Reset filters with a filter.
 const sections=[],filters=[];
 const leaseProps=extra=>germanProps(manage,{section:'leases',onSection:value=>sections.push(value),onLeaseQuery:value=>filters.push(['query',value]),onLeaseScope:value=>filters.push(['scope',value]),onLeaseFilter:value=>filters.push(['state',value]),...extra});
 hooks.cursor=0;hooks.states=[];
 empty=emptyIn(DhcpBody(leaseProps({})),de('dhcp.tab.leases'));
 check(shape(empty),['Keine Leases auf diesem Server','Clients erhalten Leases nur aus aktiven Bereichen. Prüfe, ob mindestens ein Bereich aktiv ist.','Bereiche anzeigen'],'Leases without a search: Show scopes');
 empty.action.props.onClick();check(sections,['scopes'],'Show scopes switches the section to Scopes');
 hooks.cursor=0;hooks.states=[];
 empty=emptyIn(DhcpBody(leaseProps({snapshot,leaseQuery:'nomatch'})),de('dhcp.tab.leases'));
 check(shape(empty),['Keine Leases passen','Ändere die Suche oder die Filter.','Suche löschen'],'Leases with a search only: Clear search');
 empty.action.props.onClick();check(filters,[['query','']],'Clear search clears only the search');
 filters.length=0;hooks.cursor=0;hooks.states=[];
 empty=emptyIn(DhcpBody(leaseProps({snapshot,leaseQuery:'nomatch',leaseFilter:'declined',leaseScope:'10.30.0.0'})),de('dhcp.tab.leases'));
 check(shape(empty),['Keine Leases passen','Ändere die Suche oder die Filter.','Filter zurücksetzen'],'Leases with a state filter: Reset filters');
 empty.action.props.onClick();check(filters,[['query',''],['scope',''],['state','']],'Reset filters clears the search, the scope and the state');
 hooks.cursor=0;hooks.states=[];
 // Reservations, options, policies and failover: the creating action of the toolbar.
 empty=emptyIn(DhcpBody(germanProps(manage,{section:'reservations'})),de('dhcp.tab.reservations'));
 check(shape(empty),['Keine Reservierungen auf diesem Server','Reserviere eine Adresse, damit ein Client immer dieselbe erhält.','Reservierung hinzufügen'],'Reservations: Add reservation');
 empty.action.props.onClick();check(log.open.at(-1),{kind:'reservation',family:'ipv4'},'Add reservation opens the reservation form');
 const options=DhcpBody(germanProps(manage,{section:'options'}));
 for(const family of ['ipv4','ipv6']){
  empty=emptyIn(options,de(family==='ipv4'?'dhcp.options.v4':'dhcp.options.v6'));
  check(shape(empty),['Keine Optionen auf diesem Server','Lege eine Option fest, um Clients Einstellungen wie den Router oder die DNS-Server zu geben.','Option festlegen'],`Options ${family}: Set option`);
  empty.action.props.onClick();check(log.open.at(-1),{kind:'option',family,level:'server'},`Set option opens the ${family} server option form`);
 }
 empty=emptyIn(DhcpBody(germanProps(manage,{section:'policies'})),de('dhcp.tab.policies'));
 check(shape(empty),['Keine Richtlinien auf diesem Server','Erstelle eine Richtlinie, um einer Gruppe von Clients eigene Adressen oder Optionen zu geben.','Neue Richtlinie'],'Policies: New policy');
 empty.action.props.onClick();check(log.open.at(-1),{kind:'policy',scope:null},'New policy opens the server policy form');
 empty=emptyIn(DhcpBody(germanProps(manage,{section:'failover'})),de('dhcp.tab.failover'));
 check(shape(empty),['Keine Failover-Beziehungen auf diesem Server','Erstelle eine Failover-Beziehung, damit ein Partnerserver übernimmt, wenn dieser ausfällt.','Neue Failover-Beziehung'],'Failover: New failover relationship');
 empty.action.props.onClick();check(log.open.at(-1),{kind:'failover'},'New failover relationship opens the failover form');
 empty=emptyIn(DhcpBody(germanProps(manage,{section:'failover',snapshot:{...bare,truncated:{...bare.truncated,reservations:true}}})),de('dhcp.tab.failover'));
 check(empty.action.props.blocked,de('dhcp.blocked.reservationsTruncated'),'the failover action has the reason of the toolbar button');
 // Demo: the actions stay with the demo reason; without manage, title and sentence only.
 const demoManage=fake(Object.fromEntries(DHCP_CHANGE_OPERATIONS.map(operation=>[operation,de('kit.unavailable.demo')]))).manage;
 check(['scopes','reservations','policies','failover'].map(section=>emptyIn(DhcpBody(germanProps(demoManage,{section})),de(`dhcp.tab.${section}`)).action.props.blocked),Array(4).fill(de('kit.unavailable.demo')),'demo: the actions are blocked with the demo reason');
 check(['scopes','reservations','policies','failover'].map(section=>{const value=emptyIn(DhcpBody(germanProps(undefined,{section})),de(`dhcp.tab.${section}`));return [typeof value.children,value.action];}),Array(4).fill(['string',undefined]),'without manage: title and sentence, no action');
 // The scope drawers: "in this scope" titles with the subhead actions; leases with no action (active) or Activate scope (inactive).
 const office=snapshot.ipv4.scopes[0],empty4={...office,exclusions:[],reservations:[],options:[],policies:[]};
 const drawerProps=(scope,extra={})=>({scope,snapshot:bare,now,t:de,locale:'de',usage:null,onShowAll:noop,manage,...extra});
 let drawer=ScopeDetails(drawerProps(empty4));
 const drawerEmpty=label=>shape(emptyIn(drawer,de(label)));
 check([drawerEmpty('dhcp.drawer.exclusions'),drawerEmpty('dhcp.drawer.reservations'),drawerEmpty('dhcp.drawer.options'),drawerEmpty('dhcp.drawer.policies'),drawerEmpty('dhcp.drawer.leases')],[
  ['Keine Ausschlüsse in diesem Bereich','Füge einen Ausschluss hinzu, damit der Server bestimmte Adressen aus diesem Bereich nicht vergibt.','Ausschluss hinzufügen'],
  ['Keine Reservierungen in diesem Bereich','Reserviere eine Adresse, damit ein Client immer dieselbe erhält.','Reservierung hinzufügen'],
  ['Keine Optionen in diesem Bereich','Lege eine Option fest, um Clients Einstellungen wie den Router oder die DNS-Server zu geben.','Option festlegen'],
  ['Keine Richtlinien in diesem Bereich','Erstelle eine Richtlinie, um einer Gruppe von Clients eigene Adressen oder Optionen zu geben.','Neue Richtlinie'],
  ['Keine Leases in diesem Bereich','Ein Lease erscheint hier, sobald ein Client eine Adresse aus diesem Bereich erhält.',null],
 ],'the IPv4 drawer: scope titles, sentences, the add actions, and no lease action in an active scope');
 const opened=['dhcp.drawer.exclusions','dhcp.drawer.reservations','dhcp.drawer.options','dhcp.drawer.policies'].map(label=>{emptyIn(drawer,de(label)).action.props.onClick();return log.open.at(-1);});
 check(opened,[{kind:'exclusion',family:'ipv4',scope:office.id,from:office.id},{kind:'reservation',family:'ipv4',scope:office.id,from:office.id},{kind:'option',family:'ipv4',level:'scope',scope:office.id,from:office.id},{kind:'policy',scope:office.id,from:office.id}],'each drawer action opens the form of its subhead');
 drawer=ScopeDetails(drawerProps({...empty4,state:'inactive'}));
 empty=emptyIn(drawer,de('dhcp.drawer.leases'));
 check(shape(empty),['Keine Leases in diesem Bereich','Der Bereich ist inaktiv. Aktiviere ihn, damit Clients Adressen erhalten.','Bereich aktivieren'],'an inactive scope offers Activate scope');
 empty.action.props.onClick();check([log.change.at(-1).operation,log.change.at(-1).parameters],['dhcp-scope-activate',{family:'ipv4',scopeId:office.id}],'Activate scope goes to the confirmation');
 check(emptyIn(ScopeDetails(drawerProps({...empty4,state:'inactive'},{manage:demoManage})),de('dhcp.drawer.leases')).action.props.blocked,de('kit.unavailable.demo'),'Activate scope keeps its reason');
 check(emptyIn(ScopeDetails(drawerProps({...empty4,state:'inactive'},{manage:undefined})),de('dhcp.drawer.leases')).action,undefined,'without manage: no Activate scope');
 const v6={...snapshot.ipv6.scopes[0],exclusions:[],reservations:[],options:[]};
 drawer=Scope6Details({scope:v6,snapshot:bare,now,t:de,locale:'de',lifetime:()=>'—',onShowAll:noop,manage});
 check([drawerEmpty('dhcp.drawer.exclusions')[0],drawerEmpty('dhcp.drawer.reservations')[0],drawerEmpty('dhcp.drawer.options'),drawerEmpty('dhcp.drawer.leases')[2]],['Keine Ausschlüsse in diesem Bereich','Keine Reservierungen in diesem Bereich',['Keine Optionen in diesem Bereich','Lege eine Option fest, um Clients Einstellungen wie den Router oder die DNS-Server zu geben.','Option festlegen'],null],'the IPv6 drawer has the same scope empty states');
 emptyIn(drawer,de('dhcp.drawer.options')).action.props.onClick();check(log.open.at(-1),{kind:'option',family:'ipv6',level:'scope',scope:v6.prefix,from:v6.prefix},'Set option in the IPv6 drawer');
 drawer=Scope6Details({scope:{...v6,state:'inactive'},snapshot:bare,now,t:de,locale:'de',lifetime:()=>'—',onShowAll:noop,manage});
 emptyIn(drawer,de('dhcp.drawer.leases')).action.props.onClick();check(log.change.at(-1).parameters,{family:'ipv6',prefix:v6.prefix},'Activate scope for an IPv6 prefix');
});

console.log(`PASS DHCP view (${checks} checks): KPIs, server facts, six sections, IPv4 meters and IPv6 switch, superscope and lease filters, truncation, the scope drawer, every load state and the Read again reasons, and the changes of plugin 1.1.0 (section actions, row menus, forms, field errors, confirmations, the running count and the manage gate) in English and German.`);
