// The settings page "Extensions" (#settings/extensions, ui/settings/extension-releases.tsx, docs/extensions.md "Settings
// page") and its rollout drawer (docs/agent-plugins.md "Rollout with pilot devices"): the frame header without a
// primary, one SettingsPage with loading, load error and stale data, the release table with its columns and blocked
// reasons, the empty state with "Open Agent releases", the eligible pilot devices, the drawer with the 1–20 limit, and
// the confirmation that posts deploy to /api/plugins at once, without a step-up first. Dev builds (X.Y.Z-dev.<sha7>):
// the candidates follow the rank (a release above a dev build of its base, another dev build of the same base
// replaces one), a dev agent meets a minimum by its base, and the version cell carries the neutral "Dev build" tag.
// React SSR and a small hook harness; no browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {default:ExtensionsPage,ExtensionReleasesTable,pluginRolloutCandidates,pluginRolloutLimit,rolloutConfirmation}=await import('../../../ui/settings/extension-releases.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
const nodes=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...[node.props?.children,node.props?.wide].flat(Infinity).flatMap(nodes)];
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

const nowAt=Date.UTC(2026,10,4,12);
const release={id:'11111111-1111-4111-8111-111111111111',name:'dhcp',target:'dhcp',version:'1.1.0',minAgentVersion:'4.16.0',capabilities:['dhcp-read'],changelog:{features:['x'],fixes:[]},createdAt:nowAt-86400000,active:true};
const plugin=version=>({name:'dhcp',target:'dhcp',version,capabilities:['dhcp-read'],state:'ready',networkBlocked:true});
const device=(id,name,{version='1.0.0',agentVersion='4.16.0',capabilities=['plugin-host'],permissions=['plugins.manage']}={})=>({id,name,lastSeen:nowAt-10_000,permissions,snapshot:{agentVersion,agentCapabilities:capabilities,plugins:version?[plugin(version)]:[]}});
const servers=[
 device('b','SRV-10'),device('a','SRV-2'),
 device('same','SRV-SAME',{version:'1.1.0'}),device('newer','SRV-NEWER',{version:'1.2.0'}),device('none','SRV-NONE',{version:null}),
 device('old','SRV-OLDAGENT',{agentVersion:'4.14.0'}),device('host','SRV-NOHOST',{capabilities:[]}),device('right','SRV-NORIGHT',{permissions:['view']}),
];
const owner={id:'owner',label:'owner@example.test',permissions:['*']},viewer={id:'operator',label:'operator@example.test',permissions:[]};

// ---- The eligible pilot devices ----
check(pluginRolloutCandidates(release,servers,viewer).map(server=>server.id),['a','b'],'only an older extension on a plugin host with the minimum agent and plugins.manage, sorted by name (numeric)');
check(pluginRolloutLimit,20,'at most 20 devices');
{
 const dev={...release,id:'44444444-4444-4444-8444-444444444444',version:'1.1.0-dev.abc1234',dev:true};
 const ranked=[device('older','SRV-OLDER',{version:'1.0.0'}),device('release','SRV-RELEASE',{version:'1.1.0'}),device('otherdev','SRV-OTHERDEV',{version:'1.1.0-dev.bbbbbbb'}),device('samedev','SRV-SAMEDEV',{version:'1.1.0-dev.abc1234'}),device('nextdev','SRV-NEXTDEV',{version:'1.2.0-dev.ccccccc'})];
 check(pluginRolloutCandidates(dev,ranked,viewer).map(server=>server.id),['older','otherdev'],'a dev build: a lower version and another dev build of its base, never the release of its base, the same build or a higher one');
 check(pluginRolloutCandidates(release,ranked,viewer).map(server=>server.id),['older','otherdev','samedev'],'the release replaces the dev builds of its base');
 const devAgents=[device('devagent','SRV-DEVAGENT',{agentVersion:'4.16.0-dev.abc1234'}),device('lowdev','SRV-LOWDEV',{agentVersion:'4.15.9-dev.abc1234'})];
 check(pluginRolloutCandidates(release,devAgents,viewer).map(server=>server.id),['devagent'],'a dev agent meets the minimum 4.16.0 by its base');
}

// ---- The page frame: the header without a primary, one SettingsPage, loading, error and stale data ----
const headers=[];
const frame={header:primary=>{headers.push(primary);return h('header',{className:'frame'});},refresh:0,tab:'',onTab:()=>{}};
await withHooks(()=>{
 const props={servers,viewer:owner,demo:false,now:nowAt,onConfirm:()=>{},frame};
 // The states in hook order: releases, error, loading, rollout.
 const all=()=>{hooks.cursor=0;headers.length=0;return nodes(ExtensionsPage(props));};
 const page=()=>all().find(node=>node.props?.className==='sdx-extensions-page');
 let settings=page();
 check([headers,settings.props.label,settings.props.loading,settings.props.loadError,settings.props.wide],[[undefined],'Extensions',true,undefined,null],'first load: the frame header without a primary, the SettingsPage Skeleton with the page label');
 hooks.states[1]='The request failed.';
 settings=page();
 check([settings.props.loading,settings.props.loadError,settings.props.wide],[false,'Nodiverna could not load the extension versions. Try again.',null],'a failed first load: LoadFailed with Try again, no table');
 hooks.states[0]=[release];
 settings=page();
 check([settings.props.loadError,!!settings.props.wide],['Nodiverna could not load the extension versions. Try again. The last loaded state is shown.',true],'a failed refresh keeps the loaded table with the stale sentence');
 hooks.states[1]='';
 const card=nodes(page().props.wide).find(node=>node.props?.className==='sdx-extension-releases');
 check([card.props.title,card.props.meta,card.props.iconTone,card.props.flush],['Extension releases','Nodiverna gets signed extension versions from the release source in Agent releases.','accent',true],'the wide part is the flush card Extension releases');
 ok(typeof settings.props.onRetry==='function','Try again repeats the load');
});
ok(!/demoPluginReleases|ui\/shell\/demo-dhcp/.test(readFileSync('ui/settings/extension-releases.tsx','utf8')),'demo: no sample data in the page (it shows the real releases)');
ok(!/variant="primary"[^\n]*rollOut|frameHeader\(frame,/.test(readFileSync('ui/settings/extension-releases.tsx','utf8')),'no header primary: importing stays on Agent releases');

// ---- The table: columns, blocked reasons, installed count, the empty state ----
const releaseRows=[release,{...release,id:'22222222-2222-4222-8222-222222222222',version:'1.0.0'},{...release,id:'33333333-3333-4333-8333-333333333333',name:'dns',target:'dns',version:'1.0.0',active:false}];
const tableProps=(extra={})=>({releases:releaseRows,servers,viewer,demo:false,now:nowAt,onRollOut:()=>{},...extra});
await withHooks(()=>{
 const table=props=>{hooks.cursor=0;return nodes(ExtensionReleasesTable(props)).find(node=>node.props?.columns&&node.props?.rows);};
 const cells=(props,column)=>{const found=table(props);const def=found.props.columns.find(item=>item.id===column);return found.props.rows.map(row=>def.cell(row));};
 const found=table(tableProps());
 check([found.props.label,found.props.cards,found.props.entranceId,found.props.variant],['Extension releases',true,'extension-releases','flush'],'a flush DataTable with cards');
 check(found.props.columns.map(column=>column.label),['Extension','Version','Minimum agent','Installed on','Imported','Roll out'],'the columns of the release table');
 check(found.props.columns.at(-1).hideLabel,true,'the Roll out head is for screen readers');
 check(cells(tableProps(),'rollOut').map(node=>[node.props.children,node.props.blocked]),[['Roll out',undefined],['Roll out','No device has an older version of this extension.'],['Roll out','This extension release is disabled.']],'Roll out: open for 1.1.0, blocked without older devices and for a disabled release');
 check(cells(tableProps(),'installed'),['1 device','5 devices','0 devices'],'Installed on counts the visible devices with this version');
 check(cells(tableProps({demo:true}),'rollOut')[0].props.blocked,'Not available for sample devices.','in demo mode Roll out stays blocked (its targets are samples)');
 const name=text(render(cells(tableProps(),'extension')[0]));
 check(name,'DHCP extension dhcp','the extension cell: the extension name and the technical name');
 const empty=table(tableProps({releases:[]})).props.empty;
 check([empty.title,empty.children,empty.action.props.href,text(render(empty.action))],['No extension releases imported','Extension versions show here after the next check of the release source in Agent releases.','#settings/agent-releases','Open Agent releases'],'the empty state links to Agent releases');
 const germanEmpty=render(h(ExtensionReleasesTable,tableProps({releases:[]})),'de');
 ok(text(germanEmpty).includes('Keine Releases von Erweiterungen importiert')&&text(germanEmpty).includes('Agent-Releases öffnen'),'the German empty state');
 const devRow={...release,id:'55555555-5555-4555-8555-555555555555',version:'1.2.0-dev.abc1234',dev:true};
 const versions=cells(tableProps({releases:[devRow,{...release,dev:false}]}),'version').map(node=>text(render(node)));
 check(versions,['1.2.0-dev.abc1234 Dev build','1.1.0'],'the Dev build tag after the version of a dev build');
 ok(render(cells(tableProps({releases:[devRow]}),'version')[0]).includes('class="sdx-tag"'),'the neutral tag, not the accent');
 ok(text(render(cells(tableProps({releases:[devRow]}),'version')[0],'de')).includes('Dev-Build'),'the German tag');
 const opened=[];
 cells(tableProps({onRollOut:value=>opened.push(value.id)}),'rollOut')[0].props.onClick();
 check(opened,[release.id],'Roll out opens the drawer of its release');
});

// ---- The drawer and the confirmation ----
await withHooks(()=>{
 const confirmations=[];
 const props={servers,viewer,demo:false,now:nowAt,onConfirm:confirmation=>confirmations.push(confirmation),frame};
 const all=()=>{hooks.cursor=0;return nodes(ExtensionsPage(props));};
 all();
 hooks.states[0]=releaseRows;hooks.states[3]=release.id;
 const rollout=all().find(node=>node.props?.release?.id===release.id&&node.props?.devices);
 const saved=hooks.states;hooks.states=[];
 hooks.cursor=0;const drawer=nodes(rollout.type(rollout.props)).find(node=>node.props?.candidates);
 check(drawer.props.candidates.map(server=>server.id),['a','b'],'the drawer lists the eligible devices');
 const inside=()=>{hooks.cursor=0;return nodes(drawer.type(drawer.props));};
 let tree=inside();
 check([tree[0].props.title,tree[0].props.description,tree[0].props.dirty],['Roll out DHCP extension 1.1.0','Start with a few pilot devices. You can select up to 20 devices.',false],'the drawer title and hint; not dirty without a device');
 const submit=()=>nodes(inside()[0].props.footer).find(node=>node.props?.variant==='primary');
 check([submit().props.children,submit().props.blocked],['Roll out to 0 devices','Select at least one device.'],'blocked at 0');
 const rows=()=>inside().filter(node=>typeof node.props?.onChange==='function'&&'checked' in (node.props??{}));
 check(rows().map(row=>row.props.hint),['Current version 1.0.0','Current version 1.0.0'],'each row shows the current extension version');
 rows().forEach(row=>row.props.onChange(true));
 tree=inside();
 check([tree[0].props.dirty,submit().props.children,submit().props.blocked],[true,'Roll out to 2 devices',undefined],'two selected: dirty and open');
 hooks.states[0]=Array.from({length:21},(_,index)=>'d'+index);
 check(submit().props.blocked,'Select at most 20 devices.','blocked above 20');
 hooks.states[0]=['a','b'];
 const button=submit();
 hooks.states=saved;
 button.props.onClick();
 check(confirmations.length,1,'one confirmation');
 const [confirmation]=confirmations;
 check([confirmation.title,confirmation.lines,confirmation.confirmLabel,confirmation.endpoint,confirmation.stepUpFirst,confirmation.success],['Roll out DHCP extension 1.1.0 to 2 devices?',[{label:'Devices',value:'SRV-2, SRV-10'}],'Roll out','/api/plugins',undefined,'Rollout started for 2 devices. You see the progress below in Jobs.'],'the confirmation: question, devices, verb, endpoint, no step-up first');
 check(confirmation.payload,{action:'deploy',releaseId:release.id,serverIds:['a','b'],confirm:true},'deploy with the release and the devices');
 check(confirmation.description,'The extension runs as SYSTEM on this server and reads the DHCP server. It does not connect to the network on its own.','a DHCP rollout keeps the DHCP install hint');
 check(hooks.states[3],null,'the drawer closes');
});

// ---- The rollout confirmation describes the rolled-out extension ----
{
 const t=(key,params)=>translate('en',key,params),de=(key,params)=>translate('de',key,params);
 const dnsRelease={...release,id:'44444444-4444-4444-8444-444444444444',name:'dns',target:'dns',capabilities:['dns-read']};
 const confirmation=rolloutConfirmation(dnsRelease,[{id:'d1',name:'SRV-DNS'}],t);
 check([confirmation.title,confirmation.description,confirmation.lines],['Roll out DNS extension 1.1.0 to 1 device?','The extension runs as SYSTEM on this server and reads the DNS server with its zones and records. It does not connect to the network on its own.',[{label:'Device',value:'SRV-DNS'}]],'a DNS rollout has the DNS install hint');
 ok(!/DHCP/.test([confirmation.title,confirmation.description,...confirmation.lines.map(line=>line.value)].join(' ')),'a DNS rollout never mentions DHCP');
 check(rolloutConfirmation(release,[{id:'a',name:'SRV-2'},{id:'b',name:'SRV-10'}],de).title,'DHCP-Erweiterung 1.1.0 auf 2 Geräte ausrollen?','the German question');
}
console.log(`PASS extension releases view (${checks} checks): the settings page Extensions with the frame header without a primary, loading, error and stale data; the release table with its columns, blocked reasons (Roll out stays blocked in demo mode), installed count and the empty state with Open Agent releases; the eligible pilot devices, the drawer with dirty and the 1–20 limit, and the deploy confirmation without a step-up first, with the install hint of the rolled-out extension (DNS never mentions DHCP).`);
