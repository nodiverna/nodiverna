// The DNS server view of the device Extensions area (ui/devices/extensions/device-dns.tsx,
// ui/devices/extensions/dns-forms.tsx, docs/dns-server.md), rendered with React SSR and
// a small hook harness, in English and German: the head with the account chip,
// Read again, the head menu and the running count; every load state; the KPI
// row; the four sections with their actions, row menus and the blocked reasons
// in order; the zone page with its record filters, bulk delete, SOA and
// secondary blocks, truncated notice and not-read state; every form with its
// fields, errors and submit name; the confirmation and its toast; the demo;
// the fleet card "DNS zones"; and "Open DNS" in the Extensions area.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const view=await import('../../../ui/devices/extensions/device-dns.tsx');
const forms=await import('../../../ui/devices/extensions/dns-forms.tsx');
const {default:DeviceDns,DnsBody,DnsZonePage,openDnsChangeJobs}=view;
const {demoDnsSnapshot,demoDnsRecords,demoDnsPlugin}=await import('../../../ui/shell/demo-dns.ts');
const {dnsKpis}=await import('../../../lib/dns.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
const {Field}=await import('../../../ui/kit/field.tsx');
const {DNS_CHANGE_OPERATIONS}=await import('../../../lib/plugin-catalog.ts');
const {dnsRecordKey}=await import('../../../lib/dns-changes.ts');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
const noop=()=>{};
const nodes=node=>!node||typeof node!=='object'?[]:[node,...[node.props?.children,node.props?.rows,node.props?.toolbar,node.props?.actions,node.props?.filters,node.props?.action].flat(Infinity).flatMap(nodes)];
const hooks={cursor:0,states:[]};
const internals=React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
async function withHooks(run){
 const saved=internals.H;
 hooks.cursor=0;hooks.states=[];
 internals.H={
  useState(initial){const index=hooks.cursor++;if(!(index in hooks.states))hooks.states[index]=typeof initial==='function'?initial():initial;return [hooks.states[index],value=>{hooks.states[index]=typeof value==='function'?value(hooks.states[index]):value;}];},
  useMemo:fn=>fn(),useCallback:fn=>fn,useContext:context=>context._currentValue,useEffect(){},useLayoutEffect(){},useRef:current=>({current}),useId:()=>'id',
 };
 try{await run();}finally{internals.H=saved;}
}
const t=(key,params)=>translate('en',key,params),de=(key,params)=>translate('de',key,params);
const now=Date.UTC(2026,10,9,12);
const snapshot=demoDnsSnapshot(now),corp=demoDnsRecords(now,'corp.example');
const feature={name:'DNS',displayName:'DNS-Server',installed:true,featureType:'Role'};
const plugin={...demoDnsPlugin};
const server={id:'srv-dns',name:'SRV-DC01',lastSeen:now-10_000,management:1,permissions:['dns.read','dns.manage','plugins.manage'],snapshot:{os:'Microsoft Windows Server 2022 Datacenter',mode:'Management',agentVersion:'4.20.0',agentCapabilities:['plugin-host','plugin-ad-identity'],features:[feature],plugins:[plugin]}};
const viewer={id:'viewer',label:'viewer@example.test',permissions:[]};
const base={server,viewer,demo:false,now,jobs:[],onBack:noop,onInstall:noop,onOpenServices:noop,onConfirm:noop};
const loaded=(data=snapshot)=>({serverId:server.id,view:{snapshot:data,collectedAt:now-4*60_000,receivedAt:now,plugin:{version:'1.0.0',state:'ready'}}});
const labels=entries=>entries.map(entry=>'separator' in entry?'—':entry.label);
const find=(all,predicate)=>all.find(predicate);

// ---- The sample server in demo mode ----
let html=render(h(DeviceDns,{...base,demo:true})),shown=text(html);
ok(html.includes('<h2 id="sdx-dns-title" class="sr-only">DNS server</h2>')&&html.includes('aria-label="Back to Extensions"'),'the head: SectionHead hideTitle and the back button a host passes');
ok(!render(h(DeviceDns,{...base,demo:true,onBack:undefined})).includes('aria-label="Back to Extensions"'),'inside the Extensions subtabs there is no back control');
ok(shown.includes('SRV-DC01.corp.example · Read 4 min ago')&&html.includes('aria-live="polite"'),'the meta line "{server} · Read {time}"');
ok(html.includes('aria-label="DNS server at a glance"'),'the KPI row');
ok(/Zones 5 4 forward · 1 reverse/.test(shown)&&/Stored in AD 4 of 5 zones/.test(shown)&&/Records 30 in primary zones/.test(shown)&&/Forwarders 2 Root hints as fallback/.test(shown)&&/Scavenging On Every 7 days/.test(shown),'the five KPIs with their details');
ok(['Name','Version','Domain controller','Listens on'].every(label=>shown.includes(label))&&shown.includes('10.10.1.4, fe80::4')&&shown.includes('10.0.20348'),'the server facts');
ok(html.includes('aria-label="DNS server sections"')&&['Zones','Conditional forwarders','Forwarders','Aging and scavenging'].every(label=>shown.includes(label)),'four pill tabs');
ok(shown.includes('Created by Windows')&&shown.includes('AD · Domain')&&shown.includes('AD · Forest')&&shown.includes('File')&&shown.includes('Secure only'),'the zone rows: tag, storage and dynamic updates');
check([...html.matchAll(/<strong class="mono">([^<]+)<\/strong>/g)].map(match=>match[1]),['corp.example','_msdcs.corp.example','20.10.in-addr.arpa','partner.example','trustanchors'],'one row per zone, no conditional forwarder');
ok(html.includes('aria-label="Search zones"')&&/All 5/.test(shown)&&/Forward 4/.test(shown)&&/Reverse 1/.test(shown),'the toolbar: search and the lookup filter with counts');
ok(shown.includes('5 of 5 zones'),'the foot');
html=render(h(DeviceDns,{...base,demo:true}),'de');shown=text(html);
ok(shown.includes('DNS-Server')&&shown.includes('Zonen')&&shown.includes('In AD gespeichert')&&shown.includes('Von Windows erstellt')&&shown.includes('AD · Domäne')&&shown.includes('Bedingte Weiterleitungen')&&shown.includes('Alle 7 Tage'),'German view');

// ---- The Extensions area: back label and the install reason while the plugin is installing or waiting for the agent ----
ok(render(h(DeviceDns,{...base,demo:true}),'de').includes('aria-label="Zurück zu Erweiterungen"'),'German back button: Zurück zu Erweiterungen');
{
 // The back control sits at the leading edge (SectionHead leading): before the head text and outside the actions.
 const head=render(h(DeviceDns,{...base,demo:true}),'de'),end=head.indexOf('</header>'),backAt=head.indexOf('aria-label="Zurück zu Erweiterungen"');
 ok(/<header class="sdx-section-head"><div class="sdx-section-head-lead"><button[^>]*aria-label="Zurück zu Erweiterungen"/.test(head)&&backAt<head.indexOf('sdx-section-head-text')&&backAt<head.indexOf('sdx-section-head-actions'),'the back control is the leading child of the head, before its text and actions');
 ok(!head.slice(head.indexOf('sdx-section-head-actions'),end).includes('Zurück zu Erweiterungen'),'the back control is not inside .sdx-section-head-actions');
}
{
 const {default:DeviceExtensions}=await import('../../../ui/devices/extensions/device-extensions.tsx');
 const release={id:'r-dns',name:'dns',target:'dns',version:'1.0.0',minAgentVersion:'4.16.0',capabilities:['dns-read'],changelog:{features:[],fixes:[]},createdAt:now-86400000};
 const bare={...server,snapshot:{...server.snapshot,plugins:[]}};
 const job={id:'j-dns',serverId:server.id,action:'plugin-install',target:'dns 1.0.0',state:'succeeded',createdAt:now-60_000,claimedAt:now-50_000,lastProgress:now-20_000,result:null,actor:'owner'};
 const area=(jobs,locale='en')=>render(h(DeviceExtensions,{server:bare,viewer,demo:false,now,jobs,releases:[release],detail:'dns',onDetail:noop,onOpenArea:noop,onConfirm:noop}),locale);
 let markup=area([job]);
 ok(text(markup).includes('Install extension')&&markup.includes('The extension was just installed. You can change it as soon as the agent reports it.'),'reporting: Install plugin stays visible, blocked with plugins.blocked.reporting');
 ok(area([job],'de').includes('Die Erweiterung wurde gerade installiert. Du kannst sie ändern, sobald der Agent sie meldet.'),'German reporting reason');
 markup=area([{...job,state:'running',lastProgress:null}]);
 ok(text(markup).includes('Install extension')&&markup.includes('An extension job for this device is already running. Wait until it finishes.'),'installing: blocked with plugins.blocked.busy');
 markup=area([]);
 ok(text(markup).includes('Install extension')&&!markup.includes('The extension was just installed.')&&!markup.includes('already running'),'without a job: Install plugin is free');
}

// ---- Head, states, running count, the manage gate ----
const stateCase=(states,extra={})=>{hooks.cursor=0;hooks.states=[...states];return nodes(DeviceDns({...base,...extra}));};
await withHooks(()=>{
 let all=stateCase([],{demo:true});
 const read=list=>find(list,node=>node.props?.children==='Read again');
 check(read(all).props.blocked,'Not available for sample devices.','Read again: demo');
 const headMenu=find(all,node=>node.props?.label==='More DNS actions'&&Array.isArray(node.props.entries));
 check(labels(headMenu.props.entries),['Clear cache','Scavenge stale records now'],'the head menu');
 check(headMenu.props.entries.map(entry=>entry.blocked),['Not available for sample devices.','Not available for sample devices.'],'demo blocks every change');
 ok(find(all,node=>node.props?.plugin==='dns'&&node.props?.gate?.permission==='dns.manage'&&node.props.gate.rightKey==='dns.blocked.manageRight'),'the account chip of the DNS plugin');
 check(read(stateCase([],{server:{...server,lastSeen:now-10*60_000}})).props.blocked,'The device is offline. Wait until it is online again.','Read again: offline');
 all=stateCase([],{server:{...server,permissions:[]}});
 ok(find(all,node=>node.props?.title==='No access to the DNS server'&&node.props.children==='You need the permission View DNS on this device.'),'no dns.read: the Lock empty state');
 all=stateCase([],{server:{...server,snapshot:{...server.snapshot,plugins:[]}}});
 const missing=find(all,node=>node.props?.title==='The DNS extension is not installed');
 ok(missing&&missing.props.children==='Install the DNS extension to see and change the DNS server of this device.'&&missing.props.action.props.children==='Install extension','plugin not installed: Install plugin');
 check(find(stateCase([],{server:{...server,snapshot:{...server.snapshot,plugins:[]}},installBlocked:'Update the agent.'}),node=>node.props?.title==='The DNS extension is not installed').props.action.props.blocked,'Update the agent.','the install keeps the reason of the Roles flow');
 check(stateCase([]).filter(node=>node.props?.variant==='cards'||node.props?.variant==='table').map(node=>node.props.variant),['cards','table'],'loading: skeletons');
 all=stateCase([{serverId:server.id,view:{snapshot:null,collectedAt:null,receivedAt:null,plugin:{version:'1.0.0',state:'ready'}}}]);
 const noData=find(all,node=>node.props?.title==='No DNS data yet');
 ok(noData&&noData.props.children==='The DNS data appears within 15 minutes. To get it now, select Read DNS server.'&&noData.props.action.props.children==='Read DNS server','no data yet: Read DNS server');
 all=stateCase([null,'The request failed.']);
 const failed=find(all,node=>node.props?.tone==='danger');
 ok(failed&&[failed.props.children].flat(Infinity).includes('The DNS data could not be loaded. Try again.')&&failed.props.action.props.children==='Try again','load error: danger notice with Try again');
 failed.props.action.props.onClick();check(hooks.states[3],1,'Try again loads again');
 // The zone page of the link (#device/<id>/extensions/dns/<zone>): it opens once the zone list holds the zone, and opening and leaving a zone report it.
 {
  const zones=[];const routed=(zone,states=[loaded()])=>stateCase(states,{zone,onZone:next=>zones.push(next)});
  check(find(routed('corp.example'),node=>node.type===DnsZonePage)?.props.zone.name,'corp.example','the zone of the link opens its page');
  ok(!find(routed('corp.example',[]),node=>node.type===DnsZonePage),'before the zone list loads, no zone page');
  const missingZone=routed('gone.example');
  ok(!find(missingZone,node=>node.type===DnsZonePage)&&find(missingZone,node=>node.type===DnsBody),'a zone that is not in the list shows the zone list');
  find(routed(undefined),node=>node.type===DnsBody).props.onOpenZone('partner.example');
  find(routed('corp.example'),node=>node.type===DnsZonePage).props.onBack();
  check(zones,['partner.example',null],'opening a zone and going back report the zone, then null');
 }
 all=stateCase([loaded(),'The request failed.']);
 ok(JSON.stringify([find(all,node=>node.props?.tone==='danger').props.children].flat(Infinity).map(item=>item?.props?.children??item)).includes('Showing the last loaded data.')&&all.some(node=>node.type===DnsBody),'a failed reload keeps the data');
 // The running count of open DNS change jobs.
 const jobs=['dns-record-add','dns-cache-clear'].map((target,index)=>({id:'j'+index,serverId:server.id,action:'plugin-job',target,state:index?'running':'pending'}));
 check(openDnsChangeJobs([...jobs,{id:'r',serverId:server.id,action:'plugin-job',target:'dns-read',state:'running'}],server.id).length,2,'only the change jobs count');
 all=stateCase([loaded()],{jobs});
 const headMeta=find(all,node=>node.props?.hideTitle&&node.props?.meta)?.props.meta;
 ok(headMeta&&String(headMeta.props.children).includes('2 changes running')&&headMeta.props['aria-live']==='polite','"· 2 changes running" in the polite SectionHead meta');
 // The manage gate in order, on every change control.
 const newZone=list=>find(list,node=>node.props?.children==='New zone');
 const body=list=>{const element=find(list,node=>node.type===DnsBody);return nodes(DnsBody(element.props));};
 const gate=(over,data=snapshot)=>newZone(body(stateCase([loaded(data)],{server:{...server,...over,snapshot:{...server.snapshot,...(over.snapshot??{})}}}))).props.blocked;
 check(gate({permissions:['dns.read']}),'You need the permission Manage DNS on this device.','2. no dns.manage');
 check(gate({lastSeen:now-3600_000}),'The device is offline. Wait until it is online again.','3. offline');
 check(gate({snapshot:{plugins:[{...plugin,capabilities:['dns-read']}]}}),'Update the DNS extension on this device to change the DNS server.','4. the plugin lacks the operation');
 check(gate({snapshot:{agentCapabilities:['plugin-host']}}),t('pluginAd.blocked.agent',{device:'SRV-DC01'}),'5. the agent without the AD identity');
 check(gate({management:0}),'Switch the device to Management mode to change the DNS server.','6. ReadOnly');
 check(gate({},{...snapshot,service:'stopped'}),'The DNS Server service is stopped. Start the service in Management → Services.','7. a stopped service');
 check(gate({}),undefined,'every gate open');
 all=body(stateCase([loaded({...snapshot,service:'stopped'})]));
 const stopped=find(all,node=>node.props?.tone==='warning');
 ok(stopped&&stopped.props.children==='The DNS Server service is stopped, so clients that use this server cannot resolve names. Start the service in Management → Services.'&&stopped.props.action.props.children==='Open Services','a stopped service: the warning with Open Services');
 all=stateCase([loaded({...snapshot,scavenging:{...snapshot.scavenging,enabled:false}})]);
 check(find(all,node=>node.props?.label==='More DNS actions'&&Array.isArray(node.props.entries)).props.entries[1].blocked,'Scavenging is turned off on this server. Turn it on in Aging and scavenging.','Scavenge now needs scavenging on');
});

// ---- The sections, their actions and row menus ----
const fake=(blocked={})=>{const log={open:[],change:[]};return {log,manage:{blocked:operation=>blocked[operation],open:form=>log.open.push(form),change:change=>log.change.push(change)}};};
const bodyProps=(manage,extra={})=>({snapshot,kpis:dnsKpis(snapshot),t,locale:'en',section:'zones',onSection:noop,zoneFilter:{query:'',lookup:''},onZoneFilter:noop,onOpenZone:noop,onOpenServices:noop,manage,...extra});
await withHooks(()=>{
 const {log,manage}=fake({'dns-zone-delete':'Reason delete'});
 const zones=view.dnsZoneEntries(snapshot.zones[0],manage,t,noop);
 check(labels(zones),['Open zone','Edit zone settings','—','Delete zone'],'a primary zone: open, settings, then delete');
 check([zones.at(-1).danger,zones.at(-1).blocked],[true,'Reason delete'],'delete is danger and keeps its reason');
 check(labels(view.dnsZoneEntries(snapshot.zones[3],manage,t,noop)),['Open zone','Edit zone settings','Transfer from primary','—','Delete zone'],'a secondary zone can transfer from its primary');
 zones[1].onSelect();zones.at(-1).onSelect();
 check([log.open,log.change.map(change=>[change.operation,change.parameters,change.label])],[[{kind:'zoneSettings',zone:'corp.example'}],[['dns-zone-delete',{zone:'corp.example'},'dns.op.zoneDelete']]],'the entries open the form or start the change');
 check(labels(view.dnsConditionalEntries(snapshot.zones[5],manage,t)),['Edit conditional forwarder','—','Delete conditional forwarder'],'the conditional forwarder menu');
 // Section panels.
 let all=nodes(DnsBody(bodyProps(manage)));
 const table=find(all,node=>node.props?.label==='Zones'&&node.props?.columns);
 check(table.props.columns.map(column=>column.label),['Zone','Type','Storage','Dynamic updates','Records','Aging','Actions'],'the zone columns');
 check(table.props.empty.title,'No zones','empty: No zones');
 const filtered=nodes(DnsBody(bodyProps(manage,{zoneFilter:{query:'x',lookup:''}}))).find(node=>node.props?.label==='Zones'&&node.props?.columns);
 check([filtered.props.empty.title,filtered.props.empty.action.props.children],['No matching zones','Reset filters'],'no match: Reset filter');
 all=nodes(DnsBody(bodyProps(manage,{section:'conditional'})));
 const conditional=find(all,node=>node.props?.label==='Conditional forwarders'&&node.props?.columns);
 check([conditional.props.columns.map(column=>column.label),conditional.props.rows.map(zone=>zone.name),conditional.props.empty.title],[['DNS domain','Primary servers','Storage','Timeout','Actions'],['branch.example'],'No conditional forwarders'],'the conditional forwarders');
 html=render(h(DnsBody,bodyProps(manage,{section:'forwarders'})));shown=text(html);
 ok(html.includes('<li class="mono">9.9.9.9</li><li class="mono">1.1.1.1</li>')&&shown.includes('Edit forwarders')&&shown.includes('3 seconds'),'forwarders: the ordered list, timeout and Edit forwarders');
 html=render(h(DnsBody,bodyProps(manage,{section:'scavenging'})));shown=text(html);
 ok(['Scavenge stale records automatically','Interval','Last scavenging','Age records in new zones','Edit scavenging','Scavenge now','7 days'].every(label=>shown.includes(label)),'aging and scavenging: facts and actions');
});

// ---- The zone page ----
await withHooks(()=>{
 const {log,manage}=fake();
 const page=(zone,records,preset=[],extra={})=>{hooks.cursor=0;hooks.states=[...preset];return nodes(DnsZonePage({zone,view:{records,collectedAt:now,receivedAt:now},error:'',t,locale:'en',now,manage,pending:[],reading:false,onRead:noop,onBack:noop,onRetry:noop,...extra}));};
 const primary=snapshot.zones[0];
 let all=page(primary,corp);
 ok(find(all,node=>node.type==='h3'&&node.props.children==='corp.example')&&find(all,node=>node.props?.kind==='accent'&&node.props.children==='Primary'),'the zone name and its type pill');
 ok(find(all,node=>node.props?.label==='All zones'),'the back button "All zones"');
 const card=find(all,node=>node.props?.title==='Zone settings');
 check(card.props.children.props.items.map(item=>item.label),['Type','Storage','Zone file','Dynamic updates','Zone transfers','Notify secondary servers','Primary servers','Aging'],'the zone settings facts');
 const records=find(all,node=>node.props?.label==='Records of corp.example');
 check(records.props.columns.map(column=>column.label),['Name','Type','Data','TTL','Timestamp','Actions'],'the record columns; the selection is the DataTable selection');
 check([records.props.columns.at(-1).card,records.props.columns.at(-1).className,records.props.selection.allLabel],[undefined,'sdx-col-actions','Select all shown records'],'the record Menu column also renders in card mode; the head checkbox names the shown records');
 check([records.props.rows.length,records.props.pagination.pageSize],[14,100],'every record, 100 per page');
 const toolbar=nodes(records.props.toolbar);
 const typeFilter=find(toolbar,node=>node.props?.['aria-label']==='Type'&&node.props?.size==='sm');
 check(typeFilter.props.children.map(option=>option.props.children),['All','A','AAAA','CNAME','MX','PTR','TXT','SRV','NS','SOA','Other'],'the type filter is a Select size sm');
 ok(find(toolbar,node=>node.props?.children==='Read records again')&&find(toolbar,node=>node.props?.children==='Add record'),'Read records again and Add record');
 const actions=row=>records.props.columns.at(-1).cell(row).props.entries;
 check(labels(actions(corp.records[2])),['Edit record','—','Delete record'],'a record menu: edit, then delete');
 check(actions(corp.records[0]).filter(entry=>entry.label).map(entry=>entry.blocked),['You cannot change the SOA record here because the DNS server manages it.','You cannot change the SOA record here because the DNS server manages it.'],'SOA: both entries blocked');
 check(actions(corp.records.find(record=>record.type==='CAA')).filter(entry=>entry.label).map(entry=>entry.blocked),['You cannot change this record type here. Use DNS Manager on the server.','You cannot change this record type here. Use DNS Manager on the server.'],'another type: blocked');
 check([records.props.selection.selectable(corp.records[0]),records.props.selection.selectable(corp.records[2]),records.props.selection.selectable(corp.records.find(record=>record.type==='CAA'))],[false,true,false],'SOA and other types are not selectable (no checkbox)');
 check(records.props.selection.rowLabel(corp.records[2]),'Select @ A','a record checkbox names the record');
 actions(corp.records[2]).at(-1).onSelect();
 check([log.change.at(-1).operation,log.change.at(-1).parameters.records],['dns-record-delete',[{name:'@',type:'A',data:{address:'10.10.1.4'}}]],'delete names the record by name, type and data');
 // Selection and the bulk bar.
 const chosen=[corp.records[2],corp.records[3]].map(record=>dnsRecordKey({name:record.name,type:record.type,data:record.data}));
 all=page(primary,corp,['', '', 1, chosen]);
 const bar=find(all,node=>node.type?.name==='BulkBar');
 ok(bar&&bar.props.count===2&&render(h(bar.type,bar.props)).includes('2 selected'),'the kit BulkBar "{count} selected"');
 find(nodes(bar),node=>node.props?.children==='Delete records').props.onClick();
 check([log.change.at(-1).operation,log.change.at(-1).label,log.change.at(-1).parameters.records.length],['dns-record-delete','dns.op.recordsDelete',2],'Delete records sends the selection');
 // A filter by type.
 all=page(primary,corp,['', 'MX']);
 check(find(all,node=>node.props?.label==='Records of corp.example').props.rows.map(record=>record.type),['MX'],'the type filter narrows the records');
 // Secondary zone, truncated, not read.
 all=page(snapshot.zones[3],{...corp,zone:'partner.example'});
 ok(find(all,node=>node.props?.tone==='info'&&node.props.children==='This zone copies its records from its primary servers. Change the records there.'),'a secondary zone: the notice');
 const secondary=find(all,node=>node.props?.label?.startsWith?.('Records of'));
 check(secondary.props.selection,undefined,'no selection in a secondary zone');
 check(find(nodes(secondary.props.toolbar),node=>node.props?.children==='Add record').props.blocked,'This zone copies its records from its primary servers. Change the records there.','Add record blocked in a secondary zone');
 all=page(primary,{...corp,truncated:true,total:25000});
 ok(find(all,node=>node.props?.tone==='info'&&node.props.children==='This list shows 14 of 25000 records because the zone is too large. To see all records, use DNS Manager on the server.'),'the truncated notice');
 all=page(primary,null);
 const notRead=find(all,node=>node.props?.title==='Records not read yet');
 ok(notRead&&notRead.props.children==='Read the records of corp.example to see and change them.'&&notRead.props.action.props.children==='Read records','not read: Read records');
});

// ---- The forms ----
const formRun=(Component,props,preset={})=>{hooks.cursor=0;hooks.states=[];for(const [index,value] of Object.entries(preset))hooks.states[index]=value;const shell=Component(props);return {shell,drawer:shell.type(shell.props)};};
const deep=node=>{if(!node||typeof node!=='object')return [];const own=typeof node.type==='function'&&['AdStorage','DynamicField','AddressList'].includes(node.type.name)?deep(node.type(node.props)):[];return [node,...own,...[node.props?.children].flat(Infinity).flatMap(deep)];};
const fieldsOf=drawer=>deep(drawer).filter(node=>node.type===Field).map(node=>[typeof node.props.label==='string'?node.props.label:'?',node.props.error??null,typeof node.props.hint==='string'?node.props.hint:node.props.hint?.props?.children??null]);
const formProps=(extra={})=>({snapshot,records:corp,busy:false,serverErrors:[],onCancel:noop,onSubmit:noop,t,...extra});
const submitOf=drawer=>deep(drawer).find(node=>node.type==='form').props.onSubmit;
const submitButton=drawer=>nodes(drawer.props.footer).find(node=>node.props?.type==='submit');
await withHooks(()=>{
 let {drawer}=formRun(forms.ZoneForm,formProps());
 check(fieldsOf(drawer).map(([label])=>label),['Zone type','Lookup','Zone name','Store the zone in Active Directory','Replication scope','Dynamic updates'],'new zone: the fields on a domain controller');
 check([drawer.props.title,submitButton(drawer).props.children,nodes(drawer.props.footer).some(node=>node.props?.children==='Cancel')],['New zone','Create zone',true],'title, Cancel and Create zone');
 ok(deep(drawer).find(node=>node.type==='input'&&node.props.autoFocus),'the first text field has the focus');
 ({drawer}=formRun(forms.ZoneForm,formProps(),{1:'reverse',3:'10.20.30'}));
 check(fieldsOf(drawer).find(([label])=>label==='Network ID')[2],'Zone name: 30.20.10.in-addr.arpa','the hint shows the reverse zone name live');
 ({drawer}=formRun(forms.ZoneForm,formProps({snapshot:{...snapshot,server:{...snapshot.server,isDomainController:false}}})));
 check(fieldsOf(drawer).map(([label,,hint])=>[label,hint]).filter(([label])=>label==='Store the zone in Active Directory'||label==='Zone file'),[['Store the zone in Active Directory','Only a domain controller can store zones in Active Directory.'],['Zone file',null]],'no domain controller: the AD switch blocked with its reason, the zone file shown');
 ({drawer}=formRun(forms.ZoneForm,formProps(),{0:'secondary'}));
 check(fieldsOf(drawer).map(([label,,hint])=>[label,hint]).filter(([label])=>['Store the zone in Active Directory','Zone file','Primary servers'].includes(label)),[['Store the zone in Active Directory','A secondary zone cannot be stored in Active Directory.'],['Zone file',null],['Primary servers','Enter IP addresses, one per line.']],'a secondary zone: AD blocked, file and primary servers');
 const submitted=[];
 ({drawer}=formRun(forms.ZoneForm,formProps({onSubmit:change=>submitted.push(change)}),{2:'corp.example'}));
 submitOf(drawer)({preventDefault:noop});
 check(submitted,[],'an existing zone submits nothing');
 ({drawer}=formRun(forms.ZoneForm,formProps(),{2:'corp.example',9:true}));
 check(fieldsOf(drawer).find(([label])=>label==='Zone name')[1],'Zone corp.example already exists on this server.','the field error after the first submit');
 ({drawer}=formRun(forms.ZoneForm,formProps({serverErrors:[{field:'name',code:'name'}]})));
 check(fieldsOf(drawer).find(([label])=>label==='Zone name')[1],t('dns.error.name'),'a server changeInvalid error under the same field');
 ({drawer}=formRun(forms.ZoneForm,formProps({onSubmit:change=>submitted.push(change)}),{2:'lab.corp.example'}));
 submitOf(drawer)({preventDefault:noop});
 check([submitted[0].operation,submitted[0].label,submitted[0].parameters],['dns-zone-create','dns.op.zoneCreate',{kind:'primary',lookup:'forward',name:'lab.corp.example',storage:'ad',replicationScope:'domain',fileName:null,masters:[],dynamicUpdate:'secure'}],'a valid zone submits the change');
 // Zone settings.
 ({drawer}=formRun(forms.ZoneSettingsForm,formProps({zone:snapshot.zones[0]})));
 check(fieldsOf(drawer).map(([label])=>label),['Dynamic updates','Zone transfers','Notify secondary servers','Notify','Scavenge stale records','No-refresh interval (hours)','Refresh interval (hours)','Store the zone in Active Directory','Replication scope'],'zone settings of a primary AD zone');
 check([drawer.props.title,submitButton(drawer).props.children,submitButton(drawer).props.blocked],['Edit zone settings','Save zone settings','No changes.'],'an unchanged edit: blocked with No changes');
 ({drawer}=formRun(forms.ZoneSettingsForm,formProps({zone:snapshot.zones[3]})));
 check(fieldsOf(drawer).map(([label])=>label),['Primary servers','Zone transfers','Notify secondary servers'],'zone settings of a secondary file zone');
 // Records.
 ({drawer}=formRun(forms.RecordForm,formProps({zone:snapshot.zones[0]})));
 check(fieldsOf(drawer).map(([label,,hint])=>[label,hint]).slice(0,3),[['Type',null],['Name','Leave the name empty to add a record for corp.example itself.'],['IPv4 address',null]],'add record: type, name with its hint, the A field');
 check(fieldsOf(drawer).map(([label])=>label).slice(3),['TTL','Unit','Use the zone default','Delete this record when it becomes stale'],'TTL, unit, zone default and aging');
 check(submitButton(drawer).props.children,'Add record','submit Add record');
 const typeFields={AAAA:['IPv6 address'],CNAME:['Target host'],MX:['Mail server','Preference'],PTR:['Host name'],TXT:['Text'],SRV:['Priority','Weight','Port','Target host'],NS:['Name server']};
 for(const [type,expected] of Object.entries(typeFields)){({drawer}=formRun(forms.RecordForm,formProps({zone:snapshot.zones[0]}),{0:type}));check(fieldsOf(drawer).map(([label])=>label).slice(2,2+expected.length),expected,`the fields of ${type}`);}
 const mx=corp.records.find(record=>record.type==='MX');
 ({drawer}=formRun(forms.RecordForm,formProps({zone:snapshot.zones[0],record:mx})));
 check([drawer.props.title,submitButton(drawer).props.children,submitButton(drawer).props.blocked,fieldsOf(drawer)[0][2]],['Edit record','Save record','No changes.','You cannot change the type of an existing record. To use another type, delete this record and add a new one.'],'edit record: the type stays, unchanged is blocked');
 ({drawer}=formRun(forms.RecordForm,formProps({zone:snapshot.zones[0]}),{1:'srv-app01',2:{...forms.dnsRecordDataOf?{address:'10.10.1.12',target:'',host:'',nameServer:'',exchange:'',preference:'10',text:'',priority:'0',weight:'100',port:''}:{}},5:true}));
 check(fieldsOf(drawer).find(([label])=>label==='Name')[1],'This record already exists. Edit the existing record instead.','a duplicate record');
 // Conditional forwarder, forwarders, scavenging.
 ({drawer}=formRun(forms.ConditionalForm,formProps()));
 check([fieldsOf(drawer).map(([label])=>label),submitButton(drawer).props.children],[['DNS domain','Primary servers','Store in Active Directory','Replication scope','Timeout (seconds)'],'Create conditional forwarder'],'new conditional forwarder');
 ({drawer}=formRun(forms.ConditionalForm,formProps({current:snapshot.zones[5]})));
 check([drawer.props.title,submitButton(drawer).props.children,submitButton(drawer).props.blocked],['Edit conditional forwarder','Save conditional forwarder','No changes.'],'edit conditional forwarder');
 ({drawer}=formRun(forms.ForwardersForm,formProps()));
 check([fieldsOf(drawer).map(([label])=>label),submitButton(drawer).props.children,submitButton(drawer).props.blocked],[['Servers','Timeout (seconds)','Use root hints when no forwarder answers'],'Save forwarders','No changes.'],'forwarders');
 ({drawer}=formRun(forms.ScavengingForm,formProps()));
 check([fieldsOf(drawer).map(([label])=>label),submitButton(drawer).props.children],[['Scavenge stale records automatically','Interval (days)','Age records in new zones','No-refresh interval (hours)','Refresh interval (hours)','Also apply to existing zones stored in Active Directory'],'Save scavenging'],'scavenging');
});

// ---- The confirmation ----
{
 const settled=noop;
 const context={device:{id:'srv-dns',name:'SRV-DC01'},snapshot,t,adAccount:'CORP\\anna'};
 let confirmation=forms.dnsConfirmation(forms.dnsChange('dns-record-add',{zone:'corp.example',name:'www',type:'A',ttlSeconds:null,ageRecord:false,data:{address:'10.10.1.80'}}),context,settled);
 check([confirmation.title,confirmation.confirmLabel,confirmation.tone,confirmation.endpoint,confirmation.plugin],['Change the DNS server on SRV-DC01?','Add record','default','/api/dns','dns'],'title, verb, tone and endpoint');
 check(confirmation.lines,[{label:'Device',value:'SRV-DC01'},{label:'Change',value:'Add record'},{label:'Object',value:'corp.example / www A',mono:true},{label:'AD account',value:'CORP\\anna',mono:true}],'the lines: device, change, object, AD account');
 check(confirmation.description,'corp.example is stored in Active Directory. The change replicates to all DNS servers in the domain.','the replication sentence');
 check([confirmation.success,confirmation.payload],['Change queued: Add record. You see the progress below in Jobs.',{action:'change',serverId:'srv-dns',operation:'dns-record-add',parameters:{zone:'corp.example',name:'www',type:'A',ttlSeconds:null,ageRecord:false,data:{address:'10.10.1.80'}},confirm:true}],'the toast and the payload');
 check(['dns-zone-delete','dns-record-delete','dns-conditional-delete'].map(operation=>forms.dnsConfirmation(forms.dnsChange(operation,{zone:'corp.example',name:'branch.example',records:[{}]}),context,settled).tone),['danger','danger','danger'],'the three deletes use the danger tone');
 check(DNS_CHANGE_OPERATIONS.filter(operation=>!forms.dnsDangerOperations.has(operation)).every(operation=>forms.dnsConfirmation(forms.dnsChange(operation,{zone:'corp.example',name:'branch.example'}),context,settled).tone==='default'),true,'every other change uses the default tone');
 confirmation=forms.dnsConfirmation(forms.dnsChange('dns-forwarders-set',{servers:[],timeoutSeconds:3,useRootHints:true}),context,settled);
 check(confirmation.description,'The change applies only to SRV-DC01.','forwarders: only this device');
 confirmation=forms.dnsConfirmation(forms.dnsChange('dns-zone-delete',{zone:'corp.example'}),{...context,t:de},settled);
 check([confirmation.title,confirmation.confirmLabel,confirmation.description],['DNS-Server auf SRV-DC01 ändern?','Zone löschen','corp.example ist in Active Directory gespeichert. Die Änderung wird auf alle DNS-Server der Domäne repliziert. Die Zone und alle ihre Einträge werden gelöscht. Clients können Namen darin über diesen Server nicht mehr auflösen.'],'German: question, verb, replication and delete sentence');
 check(Object.values(forms.dnsOperationLabels).every(key=>t(key)!==key&&de(key)!==key),true,'every operation label is in both catalogs');
}

// ---- The fleet card and the Extensions area ----
{
 const {default:ExtensionsTab,DnsZonesCard}=await import('../../../ui/devices/extensions/extensions-tab.tsx');
 const {demoData}=await import('../../../ui/shell/demo.ts');
 const samples=demoData().servers,reader={id:'r',label:'r@example.test',permissions:[]};
 html=render(h(ExtensionsTab,{devices:samples,viewer:reader,demo:true,now,onOpen:noop,onShowDevices:noop}));shown=text(html);
 ok(html.includes('sdx-dns-fleet')&&shown.includes('DNS zones')&&shown.includes('This list shows the zones of every DNS server that runs the DNS extension.'),'the fleet card in demo mode');
 ok(/<div class="sdx-table-foot"><p>5 zones on 1 server<\/p>/.test(html),'the count line is the table foot');
 ok(html.includes('class="sdx-table-wrap sdx-table-wrap-flush" role="region" aria-label="DNS zones"')&&html.includes('sdx-card-flush'),'the zones are one flush DataTable labelled by the card title');
 check([...html.matchAll(/aria-label="Open DNS on ([^"]+)"/g)].length,5,'one row per zone, without the zones Windows created');
 ok(['Server','Zone','Type','Storage','Dynamic updates','Records','Read'].every(label=>shown.includes(label))&&shown.includes('Conditional forwarder'),'the columns and the kind');
 html=render(h(DnsZonesCard,{devices:samples,demo:true,now,query:'msdcs',onOpen:noop,onShowDns:noop}));
 check([...html.matchAll(/<td class="mono">([^<]+)<\/td>/g)].map(match=>match[1]).filter(value=>value.includes('.')),['_msdcs.corp.example'],'the device search filters by zone name');
 html=render(h(DnsZonesCard,{devices:samples,demo:true,now,query:'srv-dc01',onOpen:noop,onShowDns:noop}));
 check([...html.matchAll(/aria-label="Open DNS on ([^"]+)"/g)].length,5,'and by device name');
 html=render(h(DnsZonesCard,{devices:samples,demo:true,now,query:'nothing',onOpen:noop,onShowDns:noop}));
 ok(text(html).includes('No DNS data yet')&&text(html).includes('Show DNS servers'),'empty: No DNS data yet with Show DNS servers');
 html=render(h(DnsZonesCard,{devices:samples,demo:false,now,query:'',onOpen:noop,onShowDns:noop}));
 ok(html.includes('sdx-skeleton')||html.includes('aria-label="Loading"'),'loading: the skeleton');
 ok(!render(h(ExtensionsTab,{devices:samples,viewer:reader,demo:false,now,onOpen:noop,onShowDevices:noop})).includes('sdx-dns-fleet'),'without dns.read anywhere the card is not rendered');
 ok(!render(h(ExtensionsTab,{devices:samples,viewer:reader,demo:true,now,onOpen:noop,onShowDevices:noop,})).includes('sdx-dns-fleet')===false,'with the demo the card shows');
 // The Extensions area: Open DNS and the detail.
 const {default:DeviceExtensions}=await import('../../../ui/devices/extensions/device-extensions.tsx');
 const dc=samples.find(device=>device.name==='SRV-DC01');
 const roles=detail=>render(h(DeviceExtensions,{server:dc,viewer:reader,demo:true,now,jobs:[],releases:demoData().pluginReleases,detail,onDetail:noop,onOpenArea:noop,onConfirm:noop}));
 html=roles('overview');shown=text(html);
 ok(html.includes('aria-label="Open DNS"')&&html.includes('aria-label="Open DHCP"'),'the Extensions area opens DNS next to DHCP (the row click of an installed extension)');
 html=roles('dns');
 ok(html.includes('<h2 id="sdx-dns-title" class="sr-only">DNS server</h2>'),'the detail dns shows the DNS view');
 const {parseConsoleRoute,extensionsDetailLabels}=await import('../../../lib/console-route.ts');
 check([parseConsoleRoute('#device/d1/extensions/dns').deviceDetail,t(extensionsDetailLabels.dns)],['dns','DNS server'],'the deep link and its label');
}

// ---- The read toast never shows raw agent text --------------------------------------------
{
 const {readFile}=await import('node:fs/promises');
 for(const [file,key] of [['ui/devices/extensions/device-dns.tsx','dns.error.read'],['ui/devices/extensions/device-dhcp.tsx','dhcp.error.read']]){
  const source=await readFile(file,'utf8');
  ok(source.includes(`toast.error(agentMessageTextOr(job,t,'${key}'))`),`${file}: the read toast uses agentMessageTextOr with ${key}`);
  ok(!/agentMessageText\(job,t\)\?\?/.test(source),`${file}: no raw stored text through agentMessageText(job,t)??`);
 }
 check([translate('en','dns.error.read'),translate('de','dns.error.read')],['The DNS server could not be read. Try again.','Der DNS-Server konnte nicht gelesen werden. Versuche es erneut.'],'dns.error.read says what failed and what to do');
}
// ---- The kit frame (UI-Rework 13b) ----
{
 const {readFileSync}=await import('node:fs');
 const demoHtml=render(h(DeviceDns,{...base,demo:true}));
 ok(/<div class="sdx-notice sdx-notice-info" role="status">.*?<div>[^<]+ You can still see the zones and records of this DNS server\.<\/div>/.test(demoHtml),'one PanelUnavailable for the change actions, with dns.readOnly');
 ok(!render(h(DeviceDns,{...base,viewer:{id:'o',label:'o',permissions:['*']}})).includes('You can still see the zones and records of this DNS server.'),'with dns.manage: no panel notice');
 const source=readFileSync('ui/devices/extensions/device-dns.tsx','utf8');
 check(['<select','className="sdx-bulkbar"','sdx-health-head','card:false','variant="primary"'].filter(literal=>source.includes(literal)),[],'device-dns.tsx: no hand select, bulk bar, head, card:false or primary');
 ok(!/sdx-dns-head/.test(readFileSync('ui/devices/extensions/dns.css','utf8')),'the hand head CSS is gone');
}
console.log(`PASS DNS view (${checks} checks): head, account chip, Read again, head menu and running count; every load state; the KPI row; the four sections with actions, row menus and the manage gate in order; the zone page with filters, bulk delete, SOA, other-type and secondary blocks, truncated and not-read states; every form with fields, errors and submit names and the reverse-name hint; the confirmation with lines, tone, verb, replication sentence and toast; the demo; the fleet DNS zones card; and Open DNS in the Roles area, in English and German.`);
