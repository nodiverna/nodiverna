// The device area Extensions › Overview (#device/<id>/extensions, ui/devices/extensions/device-extensions.tsx, docs/extensions.md):
// SectionHead hideTitle with the non-zero counts, one PanelUnavailable without plugins.manage, then up to three sections
// in this order: "Available for this device" (one offer card per extension with Install extension), "Installed" (a flush
// DataTable in a Card with the state pill and one row Menu) and "Detected, no extension yet" (a flush DataTable with the
// kind). The grouping per extension state, the offer copy and the blocked order, the menus and row targets, the
// confirmations in English and German, the move of a row after an install job, the visible hint of the waiting
// state, the row after a succeeded removal, and (as source checks, since SSR runs no effects) the console-level
// reload after a plugin job in ui/shell/use-console-data.ts and the poll left in usePluginRefresh. React SSR plus a
// small hook dispatcher, so the component runs as a plain function and its props can be pressed.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const panel=await import('../../../ui/devices/extensions/device-extensions.tsx');
const {default:DeviceExtensions,extensionGroup,pluginActionBlocked,pluginInstallConfirmation,pluginRemoveConfirmation,pluginDisplayName}=panel;
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
const nodes=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];
const internals=React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const t=(key,params)=>translate('en',key,params),de=(key,params)=>translate('de',key,params);
/** The overview as data: the head meta, the offer cards, the two tables with their rows, menus and row targets. */
function view(props){
 const saved=internals.H;
 internals.H={useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useMemo:fn=>fn(),useCallback:fn=>fn,useContext:context=>context._currentValue,useEffect(){},useLayoutEffect(){},useRef:current=>({current})};
 try{
  const all=nodes(DeviceExtensions(props));
  const head=all.find(node=>node.props?.hideTitle);
  const offers=all.filter(node=>node.props?.className==='sdx-extension-offer').map(card=>({key:card.key,title:card.props.title,description:card.props.description,meta:card.props.meta,level:card.props.level,iconTone:card.props.iconTone,button:card.props.actions}));
  const tables=all.filter(node=>Array.isArray(node.props?.columns)).map(table=>({label:table.props.label,entranceId:table.props.entranceId,variant:table.props.variant,columns:table.props.columns,
   rows:table.props.rows.map(row=>{const menu=table.props.columns.find(column=>column.id==='actions').cell(row);return {id:row.entry.id,state:row.state.state,row,menu:menu.props.label,entries:menu.props.entries,labels:menu.props.entries.map(entry=>entry.separator?'—':entry.label),open:()=>table.props.onOpen(row),openLabel:table.props.openLabel(row)};})}));
  const cards=all.filter(node=>node.props?.flush&&node.props?.title).map(card=>({title:card.props.title,iconTone:card.props.iconTone,meta:card.props.meta}));
  return {head,offers,tables,cards,installed:tables.find(table=>table.label==='Installed'),detected:tables.find(table=>table.label==='Detected, no extension yet'),all};
 }finally{internals.H=saved;}
}

const now=Date.UTC(2026,10,13,12),feature=name=>({name,displayName:name+' (display)',installed:true,featureType:'Role'});
const release=(name,extra={})=>({id:'r-'+name,name,target:name,version:'1.1.0',minAgentVersion:'4.16.0',capabilities:[],changelog:{features:[],fixes:[]},createdAt:now-86400000,...extra});
const ready=(name,version='1.0.0')=>({name,target:name,version,capabilities:[],state:'ready',networkBlocked:true});
const owner={id:'owner',label:'owner',permissions:['*']};
// DHCP installed, DNS offered (a release), AD DS and SQL Server without an extension.
const server={id:'srv',name:'SRV-01',lastSeen:now-10_000,revoked:0,permissions:['view','plugins.manage'],
 snapshot:{os:'Microsoft Windows Server 2022 Standard',agentVersion:'4.16.0',agentCapabilities:['plugin-host'],features:[feature('DHCP'),feature('DNS'),feature('AD-Domain-Services')],plugins:[ready('dhcp')]},
 serverSoftware:[{id:'sql-server',version:'15.0.4375.4',names:['Microsoft SQL Server 2019']}]};
const calls=[];
const props=(extra={})=>({server,viewer:owner,demo:false,now,jobs:[],releases:[release('dhcp'),release('dns')],detail:'overview',onDetail:value=>calls.push('detail:'+value),onOpenArea:value=>calls.push('area:'+value),onConfirm:value=>calls.push('confirm:'+value.title),...extra});
const withPlugins=plugins=>({...server,snapshot:{...server.snapshot,plugins}});

// ---- the three groups per extension state ----
check([['installed',{state:'installed',version:'1'}],['damaged',{state:'damaged',error:null,version:'1'}],['installing',{state:'installing',repair:false}],['reporting',{state:'reporting',version:'1'}],['available',{state:'available',release:release('dns')}],['planned',{state:'planned'}]].map(([,state])=>extensionGroup({extension:'dns'},state)),
 ['installed','installed','installed','installed','available','available'],'installed, damaged, installing and reporting are Installed; available and planned are offered');
check(extensionGroup({extension:null},{state:'none'}),'detected','a target without an extension is "Detected, no extension yet"');
let v=view(props());
check([v.head.props.title,v.head.props.hideTitle,v.head.props.meta],['Extensions',true,'1 available · 1 installed · 2 without extension'],'SectionHead hideTitle: the title for the outline, the non-zero counts as meta');
check([v.offers.map(offer=>offer.key),v.installed.rows.map(row=>row.id),v.detected.rows.map(row=>row.id)],[['dns'],['dhcp'],['ad-ds','sql-server']],'DNS offered, DHCP installed, AD DS and SQL Server detected, each in deviceTargetOrder');
check(v.cards.map(card=>[card.title,card.iconTone,card.meta]),[['Installed','success',undefined],['Detected, no extension yet','neutral',undefined]],'the two table cards with their tiles and no meta');
let html=render(h(DeviceExtensions,props()));
const order=['Available for this device','Installed','Detected, no extension yet'].map(title=>text(html).indexOf(title));
ok(order.every(index=>index>=0)&&order[0]<order[1]&&order[1]<order[2],'the sections in their order');
ok(!html.includes('sdx-notice'),'with plugins.manage: no panel notice');
html=render(h(DeviceExtensions,props({viewer:{id:'r',label:'r',permissions:[]},server:{...server,permissions:['view']}})));
ok(html.includes('sdx-notice-info')&&text(html).includes('You can still see which roles Nodiverna found and which extensions are installed.'),'without plugins.manage: one PanelUnavailable with the read-only sentence');
// A section shows only with entries: everything installed leaves no offers; no software and no AD DS leave no detected table.
v=view(props({server:{...withPlugins([ready('dhcp'),ready('dns')]),snapshot:{...withPlugins([ready('dhcp'),ready('dns')]).snapshot,features:[feature('DHCP'),feature('DNS')]},serverSoftware:[]}}));
check([v.offers.length,v.installed.rows.map(row=>row.id),v.detected,v.head.props.meta],[0,['dhcp','dns'],undefined,'2 installed'],'only the Installed section with two rows; zero counts are left out');
// Planned (no release) stays an offer with the waiting pill.
v=view(props({releases:[release('dhcp')]}));
check(v.offers.map(offer=>offer.key),['dns'],'a planned extension is offered');

// ---- the offer card ----
v=view(props());
const [offer]=v.offers;
check([offer.title,offer.description,offer.meta,offer.level,offer.iconTone],['DNS extension','See and change the zones and records of this DNS server in Nodiverna.','Release 1.1.0',3,'accent'],'the offer card: name, offer sentence, the release as meta, an h3 under the group heading, the accent tile');
check([offer.button.props.children,offer.button.props.size,offer.button.props.variant,offer.button.props.blocked],['Install extension','sm',undefined,undefined],'one secondary Btn size sm "Install extension"');
offer.button.props.onClick();
check(calls.splice(0),['confirm:Install the DNS extension on SRV-01?'],'Install extension opens the install confirmation');
const planned=view(props({releases:[release('dhcp')]})).offers[0];
const plannedPill=render(planned.meta);
ok(text(plannedPill)==='Extension available later'&&plannedPill.includes('title="An extension that lets you manage this in Nodiverna is planned."')&&plannedPill.includes('sdx-pill-waiting'),'planned: the waiting pill with its hint as meta');
check(planned.button.props.blocked,'No release of this extension is imported yet. An Owner imports it in Settings → Agent releases.','planned: blocked without a release');
check(view(props({releases:[release('dhcp')],demo:true})).offers[0].button.props.blocked,'No release of this extension is imported yet. An Owner imports it in Settings → Agent releases.','no release comes before demo');
const offerBlocked=extra=>view(props(extra)).offers[0]?.button.props.blocked;
check(offerBlocked({demo:true}),'Not available for sample devices.','then demo');
check(offerBlocked({server:{...server,permissions:['view']},viewer:{id:'r',label:'r',permissions:[]}}),'You need the permission Manage extensions on this device.','then the right');
check(offerBlocked({server:{...server,lastSeen:now-10*60_000}}),'The device is offline. Wait until it is online again.','then offline');
check(offerBlocked({server:{...server,snapshot:{...server.snapshot,agentVersion:'4.15.0'}}}),'Update the agent to 4.16.0 or later to install this extension.','then the agent');
check(offerBlocked({jobs:[{id:'j1',serverId:'srv',action:'plugin-remove',state:'running',target:'dhcp',createdAt:now}]}),'An extension job for this device is already running. Wait until it finishes.','then an open extension job');
view(props({demo:true})).offers[0].button.props.onClick();
check(calls.splice(0),[],'a blocked install confirms nothing');
check(text(render(h(DeviceExtensions,props()),'de')).includes('DNS-Erweiterung')&&text(render(h(DeviceExtensions,props()),'de')).includes('Sieh und ändere die Zonen und Einträge dieses DNS-Servers in Nodiverna.'),true,'the German offer card');

// ---- the Installed table ----
v=view(props());
check([v.installed.variant,v.installed.entranceId,v.installed.columns.map(column=>column.label)],['flush','device-extensions-installed',['Extension','Version','State','Actions']],'a flush DataTable: Extension, Version, State and the hidden actions head');
const dhcp=v.installed.rows[0];
const extensionCell=text(render(v.installed.columns[0].cell(dhcp.row))),versionCell=render(v.installed.columns[1].cell(dhcp.row)),stateCell=render(v.installed.columns[2].cell(dhcp.row));
check([extensionCell,versionCell,text(stateCell)],['DHCP extension DHCP Server','<span class="mono">1.0.0</span>','Installed · 1.0.0'],'the extension name bold with the detection label small, the mono version, the state pill');
ok(stateCell.includes('data-state="installed"')&&stateCell.includes('sdx-pill-success'),'the installed pill in the shared transition wrapper');
check([dhcp.menu,dhcp.labels],['Actions for DHCP Server',['Open DHCP','Open in Roles & features','—','Remove extension']],'installed: Open DHCP, the jump, separator, Remove extension last');
ok(dhcp.entries.find(entry=>entry.id==='remove').danger,'Remove extension is danger');
dhcp.entries.find(entry=>entry.id==='remove').onSelect();dhcp.open();dhcp.entries.find(entry=>entry.id==='area').onSelect();
check(calls.splice(0),['confirm:Remove the DHCP extension from SRV-01?','detail:dhcp','area:features'],'remove confirms; the row opens DHCP; the jump opens Roles & features');
check(dhcp.openLabel,'Open DHCP','the row open label names DHCP');
// Damaged: Repair extension, then the jump, no removal; its row opens Roles & features.
const damaged=view(props({server:withPlugins([ready('dhcp'),{...ready('dns'),state:'damaged',error:'AGENT_PLUGIN_HASH_MISMATCH'}])})).installed.rows.find(row=>row.id==='dns');
check([damaged.state,damaged.labels],['damaged',['Repair extension','Open in Roles & features']],'damaged: Repair extension, then the jump');
const damagedPill=render(view(props({server:withPlugins([ready('dhcp'),{...ready('dns'),state:'damaged',error:'AGENT_PLUGIN_HASH_MISMATCH'}])})).installed.columns[2].cell(damaged.row));
ok(text(damagedPill)==='Extension damaged'&&damagedPill.includes('title="The extension file changed on the device. The agent did not start it. Repair the extension."'),'the damaged pill names the agent message');
damaged.entries[0].onSelect();damaged.open();
check(calls.splice(0),['confirm:Repair the DNS extension on SRV-01?','area:features'],'Repair asks the repair confirmation; the row opens Roles & features');
check(view(props({server:withPlugins([ready('dhcp'),{...ready('dns'),state:'damaged',error:null}]),releases:[release('dhcp')]})).installed.rows.find(row=>row.id==='dns').entries[0].blocked,'No release of this extension is imported yet. An Owner imports it in Settings → Agent releases.','Repair without a release says why');
check(view(props({server:{...server,lastSeen:now-10*60_000}})).installed.rows[0].entries.find(entry=>entry.id==='remove').blocked,'The device is offline. Wait until it is online again.','Remove extension stays visible with its reason');

// ---- the Detected table ----
v=view(props());
check([v.detected.variant,v.detected.entranceId,v.detected.columns.map(column=>column.label)],['flush','device-extensions-detected',['Detected','Kind','Version','Actions']],'a flush DataTable: Detected, Kind, Version and the actions head');
check(v.detected.rows.map(row=>text(render(v.detected.columns[1].cell(row.row)))),['Windows role','Software'],'the kind labels');
check(v.detected.rows.map(row=>text(render(v.detected.columns[2].cell(row.row)))),['Part of Windows Server 2022 Standard','15.0.4375.4'],'the version cell: the OS for a role, the product version');
ok(text(render(v.detected.columns[0].cell(v.detected.rows[0].row))).includes('AD-Domain-Services (display)'),'the name cell with its sources');
check(v.detected.rows.map(row=>row.labels),[['Open in Roles & features'],['Open in Software']],'the row Menu: the jump to its area');
v.detected.rows[0].open();v.detected.rows[1].open();v.detected.rows[1].entries[0].onSelect();
check(calls.splice(0),['area:features','area:software','area:software'],'a row opens Roles & features or Software');
check(v.detected.rows.map(row=>row.openLabel),['Active Directory Domain Services: Open in Roles & features','Microsoft SQL Server: Open in Software'],'the open buttons name their target');
ok(text(render(h(DeviceExtensions,props()),'de')).includes('Windows-Rolle'),'the German kind label');

// ---- The confirmations, in English and German ----
{
 const host={id:'s1',name:'SRV-DC'},dhcpRelease=release('dhcp'),dnsRelease=release('dns'),caRelease=release('ca',{version:'0.1.0'});
 const install=pluginInstallConfirmation(host,dhcpRelease,false,t),repair=pluginInstallConfirmation(host,dhcpRelease,true,t),remove=pluginRemoveConfirmation(host,{name:'dhcp',target:'dhcp',version:'1.0.0'},t);
 check([install.title,install.lines,install.description,install.confirmLabel,install.tone,install.success],['Install the DHCP extension on SRV-DC?',[{label:'Device',value:'SRV-DC'},{label:'Extension',value:'DHCP extension 1.1.0'}],'The extension runs as SYSTEM on this server and reads the DHCP server. It does not connect to the network on its own.','Install extension',undefined,'Extension install started. You see the progress below in Jobs.'],'the install confirmation');
 check([install.payload,install.endpoint,install.stepUpFirst],[{action:'install',serverId:'s1',plugin:'dhcp',confirm:true},'/api/plugins',undefined],'install posts to /api/plugins on the MFA session, unchanged');
 check([repair.title,repair.confirmLabel],['Repair the DHCP extension on SRV-DC?','Repair extension'],'the repair title and verb');
 check([remove.title,remove.lines,remove.description,remove.confirmLabel,remove.tone,remove.payload,remove.success],['Remove the DHCP extension from SRV-DC?',[{label:'Device',value:'SRV-DC'},{label:'Extension',value:'DHCP extension 1.0.0'}],'Nodiverna deletes the DHCP data it stored for this server. The DHCP server itself does not change.','Remove extension','danger',{action:'remove',serverId:'s1',plugin:'dhcp',confirm:true},'Extension removal started. You see the progress below in Jobs.'],'the removal confirmation with the danger tone');
 const germanInstall=pluginInstallConfirmation(host,dnsRelease,false,de),germanRemove=pluginRemoveConfirmation(host,{name:'dns',target:'dns',version:'1.0.0'},de);
 check([germanInstall.title,germanInstall.description,germanInstall.lines,germanInstall.confirmLabel],['DNS-Erweiterung auf SRV-DC installieren?','Die Erweiterung läuft als SYSTEM auf diesem Server und liest den DNS-Server mit seinen Zonen und Einträgen. Sie baut selbst keine Netzwerkverbindung auf.',[{label:'Gerät',value:'SRV-DC'},{label:'Erweiterung',value:'DNS-Erweiterung 1.1.0'}],'Erweiterung installieren'],'the German DNS install');
 check([germanRemove.title,germanRemove.confirmLabel],['DNS-Erweiterung von SRV-DC entfernen?','Erweiterung entfernen'],'the German DNS removal');
 const other=pluginInstallConfirmation(host,caRelease,false,t),otherRemove=pluginRemoveConfirmation(host,{name:'ca',version:'0.1.0'},t);
 check([other.title,other.description,other.lines.at(-1)],['Install the extension ca on SRV-DC?','The extension runs as SYSTEM on this server and reads only what it manages. It does not connect to the network on its own.',{label:'Extension',value:'ca extension 0.1.0'}],'an unknown extension: the neutral copy with its technical name');
 check([otherRemove.title,otherRemove.description],['Remove the extension ca from SRV-DC?','Nodiverna deletes the data it stored from this extension. The server itself does not change.'],'its removal');
 check(pluginInstallConfirmation(host,{...caRelease,target:'iis'},false,de).title,'Erweiterung Webserver (IIS) auf SRV-DC installieren?','a known target takes its label');
 check([pluginDisplayName({name:'dhcp',target:'dhcp'},t),pluginDisplayName({name:'dhcp',role:'dhcp'},t),pluginDisplayName({name:'x'},t)],['DHCP Server','DHCP Server','x'],'the display name: target, the older role, else the technical name');
 for(const confirmation of [install,repair,remove,germanInstall,germanRemove,other,otherRemove])ok(!/plugin/i.test([confirmation.title,confirmation.description,confirmation.confirmLabel,confirmation.success,...confirmation.lines.map(line=>`${line.label} ${line.value}`)].join(' ').replace(/plugin:'/g,'')),`no "plugin" in "${confirmation.title}"`);
}

// ---- the moved row after an install job, without a full reload ----
{
 const base=withPlugins([ready('dhcp')]);
 const job=(extra={})=>({id:'j-dns',serverId:'srv',action:'plugin-install',target:'dns 1.1.0',state:'running',createdAt:now-60_000,claimedAt:now-55_000,lastProgress:null,result:null,actor:'owner',...extra});
 const stateOf=(jobs,device=base)=>{const current=view(props({server:device,jobs}));return {offers:current.offers.map(offer=>offer.key),row:current.installed.rows.find(row=>row.id==='dns'),current};};
 let step=stateOf([]);
 check([step.offers,step.row],[['dns'],undefined],'before: DNS is an offer');
 step=stateOf([job()]);
 check([step.offers,step.row.state,text(render(step.current.installed.columns[2].cell(step.row.row))),text(render(step.current.installed.columns[1].cell(step.row.row)))],[[],'installing','Installing…','—'],'the job runs: the card leaves the offers, the row is Installing… with no version');
 ok(render(step.current.installed.columns[2].cell(step.row.row)).includes('data-state="installing"'),'the installing pill pulses in the shared wrapper');
 check(step.current.head.props.meta,'2 installed · 2 without extension','the counts follow');
 step=stateOf([job({state:'succeeded',lastProgress:now-20_000})]);
 check([step.row.state,text(render(step.current.installed.columns[1].cell(step.row.row)))],['reporting','1.1.0'],'the job succeeded: reporting with the job version');
 // The waiting state explains itself in a visible line below the pill, not in a title.
 const waiting=render(step.current.installed.columns[2].cell(step.row.row));
 check(text(waiting),'Installed · waiting for the agent The extension is installed. It shows as ready when the agent reports it, usually within a minute.','Installed · waiting for the agent, with the hint as visible text below the pill');
 ok(waiting.includes('data-state="reporting"')&&/<small class="sdx-extension-state-hint">/.test(waiting)&&!waiting.includes('title='),'one small hint line in the shared wrapper; the pill has no title');
 check(text(render(h(panel.ExtensionStatePill,{state:step.row.row.state,t:de}))),'Installiert · wartet auf den Agenten Die Erweiterung ist installiert. Sie erscheint als bereit, sobald der Agent sie meldet, meist innerhalb einer Minute.','German waiting text with its visible hint');
 step=stateOf([job({state:'succeeded',lastProgress:now-20_000})],withPlugins([ready('dhcp'),ready('dns','1.1.0')]));
 check([step.row.state,text(render(step.current.installed.columns[2].cell(step.row.row))),step.row.labels[0]],['installed','Installed · 1.1.0','Open DNS'],'the agent reports it: Installed · 1.1.0 and Open DNS');
 // A succeeded removal after the install, with the snapshot the job result wrote: DNS is offered again.
 const removal={id:'j-remove',serverId:'srv',action:'plugin-remove',target:'dns',state:'succeeded',createdAt:now-30_000,claimedAt:now-28_000,lastProgress:now-20_000,result:null,actor:'owner'};
 step=stateOf([job({state:'succeeded',createdAt:now-10*60_000,claimedAt:now-10*60_000,lastProgress:now-9*60_000}),removal]);
 check([step.offers,step.row,step.current.installed.rows.map(row=>row.id)],[['dns'],undefined,['dhcp']],'after a succeeded removal the DNS entry is in the available group, not installed');
 // The table that appears after the install shows its rows at once: the entrance of an empty section is claimed on the first render.
 const {claimEntrance}=await import('../../../ui/kit/kit.tsx');
 view(props({server:{...withPlugins([]),serverSoftware:[]},releases:[release('dhcp'),release('dns')]}));
 check(claimEntrance('device-extensions-installed'),false,'an Installed table that appears later plays no entrance');
}

// ---- The detail views keep their reasons ----
{
 const saved=internals.H;
 internals.H={useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useMemo:fn=>fn(),useCallback:fn=>fn,useContext:context=>context._currentValue,useEffect(){},useLayoutEffect(){},useRef:current=>({current})};
 try{
  const dns=DeviceExtensions(props({detail:'dns',jobs:[{id:'j',serverId:'srv',action:'plugin-install',target:'dns 1.1.0',state:'succeeded',createdAt:now-60_000,claimedAt:now-55_000,lastProgress:now-20_000}]}));
  check([dns.type.name,dns.props.installBlocked],['DeviceDns','The extension was just installed. You can change it as soon as the agent reports it.'],'the DNS view: install blocked while reporting');
  check(DeviceExtensions(props({detail:'dhcp'})).type.name,'DeviceDhcp','the dhcp detail renders the DHCP view');
  check(DeviceExtensions(props({detail:'dns',server:{...server,snapshot:{...server.snapshot,features:[feature('DHCP')]}}})).type,'section','without the DNS role the dns detail shows the overview');
 }finally{internals.H=saved;}
 check(pluginActionBlocked({server,viewer:owner,demo:false,now,jobs:[]},t),undefined,'everything holds: not blocked');
}

// ---- Source ----
const source=readFileSync('ui/devices/extensions/device-extensions.tsx','utf8');
ok(!/<table\b/.test(source)&&!/sdx-health-head/.test(source)&&!/cell:[^\n]*<(?:Btn|IconBtn)\b/.test(source),'device-extensions.tsx: no <table, no sdx-health-head, no Btn or IconBtn per row');
// The reload after a plugin job is the console's, from every view.
const consoleData=readFileSync('ui/shell/use-console-data.ts','utf8');
ok(/import \{openPluginJobIds,pluginJobSettled\} from '@\/lib\/extensions';/.test(consoleData),'use-console-data imports the job helpers from @/lib/extensions');
ok(/if\(!demo&&before&&pluginJobSettled\(before,ids\)\)void refresh\(true\);/.test(consoleData)&&/openPluginJobIds\(jobs\)/.test(consoleData),'one refresh(true) when a plugin job of any device settles, never in demo and never on the first load');
const pollHook=/function usePluginRefresh\([^)]*\)\{[\s\S]*?\n\}/.exec(source)?.[0]??'';
ok(pollHook&&!pollHook.includes('pluginJobSettled')&&/setInterval\(refreshConsole,PLUGIN_REPORT_POLL_MS\)/.test(pollHook)&&/clearInterval\(timer\)/.test(pollHook),'usePluginRefresh keeps only the 10 s poll while a row is reporting');
check(panel.PLUGIN_REPORT_POLL_MS,10_000,'the poll interval is unchanged');
ok(!/openPluginJobIds|pluginJobSettled/.test(source),'device-extensions.tsx sends no job-end reload of its own');
ok(/@media \(max-width: 760px\)[\s\S]*\.sdx-extension-offers, \.sdx-extension-summary \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(readFileSync('ui/devices/extensions/extensions.css','utf8')),'the offer grid has one column at 760px or narrower');

console.log(`PASS device extensions panel (${checks} checks): the three sections and their order per extension state, the offer cards with their copy and blocked order, the Installed table with the state pill, menus and row targets, the Detected table with kinds, the confirmations in English and German, the moved row after an install job, the visible waiting hint, the row after a removal, and the console-level reload.`);
