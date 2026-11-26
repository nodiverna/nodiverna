// The scope tabs of FleetView, rendered with React SSR: one kit Tabs bar (underline, overflow "More") named
// "Areas" with the five link tabs Devices, Monitoring, Inventory, History and Configuration (a tab without a shown
// subtab is left out), their default hrefs for every scope type, the Devices count, no icon, one tabpanel labelled by
// the active tab; below it the pill subtab bar of the open tab (Tabs pill, overflow menu, link tabs to the subtab
// routes, its own label, class sdx-subtabs, panelId on the subtab content) with aria-current on the active subtab, and
// no pill bar when a tab has one subtab. The tab and subtab choices map back to onTab. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const {default:FleetView,fleetPanelId,fleetSubpanelId}=await import('../../../ui/devices/fleet/fleet.tsx');
const {Tabs,tabId}=await import('../../../ui/kit/tabs.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {scopeTabHref}=await import('../../../ui/shell/nav-model.ts');
const {consoleRouteHash,parseConsoleRoute}=await import('../../../lib/console-route.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const noop=()=>{};
const now=Date.UTC(2026,10,9,10,0,0);
const device=(id,name,changes={})=>({id,name,createdAt:now-86400000,lastSeen:now-30000,revoked:0,management:0,snapshot:null,permissions:['view'],...changes});
const servers=[device('a','SRV-A'),device('b','SRV-B'),device('c','SRV-C'),device('d','SRV-D')];
const viewer={id:'owner',label:'owner@example.test',permissions:['*']};
const panel=name=>h('section',{'data-panel':name});
const base={header:null,servers,scoped:servers,groupEmpty:false,viewer,demo:false,saving:false,now,jobs:[],audit:[],tab:'devices',onTab:noop,canOffboard:false,onOpen:noop,onConfirm:noop,onSelectJob:noop,onCancelJob:noop,onUpdated:noop,onDemo:noop,canMove:false,onMove:noop,customerColumn:false};
// The console passes the rules and Configuration content a scope and a viewer have (console.tsx): alert rules on All devices,
// groups and customers (each its own level), notification rules on All devices, groups and a
// customer once a second customer exists, tags on groups, Permissions with portal.roleAssignments.manage, General with
// canManageGroup. Both Ungrouped scopes get none. monitoring lists the Monitoring subtabs, config the Configuration ones.
const rules=['problems','alarms','alerts','notifications'],views=['problems','alarms'];
const scopes={
 all:{scope:{type:'all'},extra:{alerts:panel('alerts'),notifications:panel('notifications'),permissions:panel('permissions')},route:{},monitoring:rules,config:['permissions']},
 'all without the role-assignment right':{scope:{type:'all'},extra:{alerts:panel('alerts'),notifications:panel('notifications')},route:{},monitoring:rules,config:[]},
 group:{scope:{type:'group',id:'g 1'},extra:{alerts:panel('alerts'),notifications:panel('notifications'),tags:panel('tags'),permissions:panel('permissions'),settings:panel('settings')},route:{groupId:'g 1'},monitoring:rules,config:['tags','permissions','settings']},
 'group without the role-assignment and group rights':{scope:{type:'group',id:'g 1'},extra:{alerts:panel('alerts'),notifications:panel('notifications'),tags:panel('tags')},route:{groupId:'g 1'},monitoring:rules,config:['tags']},
 'customer with several customers':{scope:{type:'customer',id:'c1'},extra:{alerts:panel('alerts'),notifications:panel('notifications')},route:{customerId:'c1'},monitoring:rules,config:[]},
 'customer with one customer':{scope:{type:'customer',id:'c1'},extra:{alerts:panel('alerts')},route:{customerId:'c1'},monitoring:[...views,'alerts'],config:[]},
 unassigned:{scope:{type:'unassigned'},extra:{},route:{groupId:'unassigned'},monitoring:views,config:[]},
 'customer ungrouped':{scope:{type:'unassigned',customerId:'c1'},extra:{},route:{groupId:'unassigned',customerId:'c1'},monitoring:views,config:[]},
};
const reports=['software','extensions','drivers','certificates','autostart','os-support','encryption','protection','reliability'];
const subtabsOf=(monitoring,config)=>({monitoring,inventory:reports,history:['jobs','access'],configuration:config});
const render=(props,locale='de')=>renderToStaticMarkup(h(LocaleProvider,{locale},h(FleetView,{...base,...props})));
const attr=(tag,name)=>tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]??null;
const barTabs=bar=>[...bar.matchAll(/<a [^>]*role="tab"[^>]*>(.*?)<\/a>/g)].map(match=>({tag:match[0].match(/<a [^>]*>/)[0],label:match[1].match(/<span>([^<]+)<\/span>/)[1],count:match[1].match(/<b>([^<]+)<\/b>/)?.[1]??null,icon:/<svg/.test(match[1])}));
const tabsOf=html=>{const bar=html.match(/<nav class="sdx-tabbar sdx-tabs[^"]*"[^>]*>(.*?)<\/nav>/s);assert.ok(bar,'the scope tab bar renders');return barTabs(bar[1]);};
const pillOf=html=>{const bar=html.match(/<nav class="sdx-tabbar sdx-tabbar-pill sdx-subtabs"([^>]*)>(.*?)<\/nav>/s);return bar?{label:attr(bar[0],'aria-label'),mode:attr(bar[0],'data-mode'),tabs:barTabs(bar[2])}:null;};
const de=key=>translate('de',key),en=key=>translate('en',key);
const tabLabels={devices:'tree.devices',monitoring:'fleet.tabs.monitoring',inventory:'fleet.tabs.inventory',history:'fleet.tabs.history',configuration:'fleet.tabs.configuration'};
const subtabLabels={problems:'fleet.alarms.byDevice',alarms:'fleet.alarms.byAlarm',software:'software.title',extensions:'extensions.tab',drivers:'drivers.title',certificates:'certificates.title',autostart:'autostart.title','os-support':'osSupport.title',encryption:'encryption.title',protection:'protection.title',reliability:'reliability.title',jobs:'history.tab.jobs',access:'history.tab.access',alerts:'alertRules.title',notifications:'fleet.config.notificationRules',tags:'tags.title',permissions:'tree.permissions',settings:'fleet.tabs.settings'};
const pillLabels={monitoring:'fleet.subtabs.monitoring',inventory:'fleet.subtabs.inventory',history:'fleet.subtabs.history',configuration:'fleet.subtabs.configuration'};
// The Configuration subtabs are always written with their sub (the bare configuration link was the alert rules link).
const configSegments={tags:'tags',permissions:'permissions',settings:'general'};

// The five tabs (or fewer), their order, labels, no icon and default hrefs per scope type.
for(const [name,{scope,extra,route,monitoring,config}] of Object.entries(scopes)){
 const html=render({scope,...extra});
 const nav=html.match(/<nav class="sdx-tabbar sdx-tabs[^"]*"[^>]*>/)[0];
 check([attr(nav,'aria-label'),attr(nav,'data-mode')],['Bereiche','menu'],`${name}: a nav "Bereiche" in the menu overflow mode`);
 const tabs=tabsOf(html),subtabs=subtabsOf(monitoring,config);
 const ids=['devices','monitoring','inventory','history',...(config.length?['configuration']:[])];
 check(tabs.map(tab=>tab.label),ids.map(id=>de(tabLabels[id])),`${name}: the tabs Devices, Monitoring, Inventory, History${config.length?', Configuration':''}`);
 ok(tabs.every(tab=>!tab.icon),`${name}: no icon on a tab`);
 check(tabs.map(tab=>attr(tab.tag,'id')),ids.map(id=>tabId(fleetPanelId,id)),`${name}: tab ids from the panel id`);
 const defaults=ids.map(id=>id==='devices'?'devices':subtabs[id][0]);
 check(tabs.map(tab=>attr(tab.tag,'href')),defaults.map(tab=>consoleRouteHash({view:'devices',...route,...(tab==='devices'?{}:{tab})})),`${name}: every tab links to its default route`);
 check(tabs.map(tab=>attr(tab.tag,'href')),defaults.map(tab=>scopeTabHref(scope,tab)),`${name}: scopeTabHref gives the same links`);
 const prefix=consoleRouteHash({view:'devices',...route});
 check(tabs.map(tab=>attr(tab.tag,'href').slice(prefix.length)),['','/monitoring','/inventory','/history',...(config.length?['/configuration/'+configSegments[config[0]]]:[])],`${name}: <scope>, /monitoring, /inventory, /history, /configuration/<first>`);
 check(tabs[0].count,'4',`${name}: the Devices count`);
 check([attr(tabs[0].tag,'aria-selected'),attr(tabs[0].tag,'aria-current'),attr(tabs[0].tag,'aria-controls'),attr(tabs[0].tag,'tabindex')],['true','page',fleetPanelId,'0'],`${name}: the active tab is selected, current, controls the panel and is the one Tab stop`);
 ok(tabs.slice(1).every(tab=>attr(tab.tag,'tabindex')==='-1'&&attr(tab.tag,'aria-selected')==='false'),`${name}: the other tabs are not Tab stops`);
 const panels=[...html.matchAll(/<div id="([^"]+)" role="tabpanel" aria-labelledby="([^"]+)" class="sdx-fleet-panel">/g)];
 check(panels.map(match=>[match[1],match[2]]),[[fleetPanelId,tabId(fleetPanelId,'devices')]],`${name}: one tabpanel labelled by the active tab`);
 ok(!pillOf(html),`${name}: the Devices tab has no pill bar`);
 ok(html.indexOf('role="tabpanel"')<html.indexOf('sdx-toolbar')&&html.indexOf('role="tabpanel"')<html.indexOf('<table'),`${name}: the toolbar and the table sit in the panel`);

 // Each tab's pill bar, its items, order, labels, hrefs and the active subtab; no pill bar with one subtab.
 for(const [group,items] of Object.entries(subtabs)){
  for(const active of items){
   const page=render({scope,...extra,tab:active}),pill=pillOf(page),tabbar=tabsOf(page);
   check(tabbar.find(tab=>attr(tab.tag,'aria-selected')==='true')?.label,de(tabLabels[group]),`${name} › ${active}: the ${group} tab is active`);
   ok(page.includes(`aria-labelledby="${tabId(fleetPanelId,group)}" class="sdx-fleet-panel"`),`${name} › ${active}: the panel is labelled by its tab`);
   if(items.length<2){
    ok(!pill,`${name} › ${active}: one subtab, no pill bar`);
    ok(!page.includes(`id="${fleetSubpanelId}"`),`${name} › ${active}: no subtab panel without the bar`);
    continue;
   }
   check([pill.label,pill.mode],[de(pillLabels[group]),'menu'],`${name} › ${active}: the pill bar has its own label and the menu overflow`);
   check(pill.tabs.map(tab=>tab.label),items.map(id=>de(subtabLabels[id])),`${name} › ${active}: the subtabs in order`);
   check(pill.tabs.map(tab=>attr(tab.tag,'href')),items.map(id=>scopeTabHref(scope,id)),`${name} › ${active}: link tabs to the subtab routes`);
   check(pill.tabs.map(tab=>parseConsoleRoute(attr(tab.tag,'href')).tab),items,`${name} › ${active}: each subtab link parses back to its fleet tab`);
   check(pill.tabs.filter(tab=>attr(tab.tag,'aria-current')==='page').map(tab=>tab.label),[de(subtabLabels[active])],`${name} › ${active}: aria-current on the active subtab`);
   check(attr(pill.tabs.find(tab=>tab.label===de(subtabLabels[active])).tag,'aria-controls'),fleetSubpanelId,`${name} › ${active}: the active subtab controls the subtab panel`);
   ok(page.includes(`<div id="${fleetSubpanelId}" role="tabpanel" aria-labelledby="${tabId(fleetSubpanelId,active)}" class="sdx-fleet-subpanel">`),`${name} › ${active}: the subtab panel is labelled by the active subtab`);
  }
 }
 // The default subtab writes no segment; the first subtab of each tab is the tab's own link.
 check(Object.values(subtabs).filter(items=>items.length).map(items=>scopeTabHref(scope,items[0]).split('/').at(-1)),['monitoring','inventory','history',...(config.length?[configSegments[config[0]]]:[])],`${name}: the default subtab writes no segment (Configuration always names its subtab)`);
}

// A customer: Monitoring with its own alert rules and (with several customers) its notification rules; no Configuration.
{
 const html=render({scope:{type:'customer',id:'c1'},alerts:panel('alerts'),notifications:panel('notifications'),tab:'alerts'});
 check(pillOf(html).tabs.map(tab=>attr(tab.tag,'href')),['#devices/customer/c1/monitoring','#devices/customer/c1/monitoring/list','#devices/customer/c1/monitoring/alert-rules','#devices/customer/c1/monitoring/notification-rules'],'a customer: the four Monitoring subtab links');
 ok(html.includes('data-panel="alerts"'),'a customer: Alert rules shows the alert rules content');
 ok(!tabsOf(html).some(tab=>tab.label===de('fleet.tabs.configuration')),'a customer has no Configuration tab');
 const ungrouped=render({scope:{type:'unassigned'},tab:'alerts'});
 ok(!ungrouped.includes('data-panel="alerts"')&&!pillOf(ungrouped),'an Ungrouped route to Alert rules shows Devices');
}

// The Monitoring tab carries the open alarms with the worst tone, nothing without one.
{
 const alarmed=[device('a','SRV-A',{alerts:[{id:'x1',level:'warning'},{id:'x2',level:'critical'}]}),device('b','SRV-B',{alerts:[{id:'x3',level:'info'}]})];
 const tag=html=>html.match(new RegExp(`<a [^>]*id="${tabId(fleetPanelId,'monitoring')}"[^>]*>(.*?)</a>`,'s'))?.[1]??'';
 check(tag(render({servers:alarmed,scoped:alarmed})).match(/<b class="sdx-count-critical">([^<]+)<\/b>/)?.[1],'3','the Monitoring tab counts the open alarms in the critical tone');
 const warned=[device('a','SRV-A',{alerts:[{id:'x1',level:'warning'}]})];
 check(tag(render({servers:warned,scoped:warned})).match(/<b class="sdx-count-warning">([^<]+)<\/b>/)?.[1],'1','a warning tone with only warnings');
 ok(!/<b/.test(tag(render({}))),'no count without open alarms');
}

// No tab or subtab label is an old name, in English and German.
{
 const labels=new Set();
 for(const locale of ['en','de'])for(const tab of ['devices','problems','alarms','software','jobs','alerts','settings']){
  const html=render({...scopes.group.extra,scope:scopes.group.scope,tab},locale);
  for(const item of [...tabsOf(html),...(pillOf(html)?.tabs??[])])labels.add(item.label);
 }
 for(const old of ['Problems','Probleme','Roles','Rollen','Protection','Schutz','Notifications','Benachrichtigungen','Settings','Einstellungen'])ok(!labels.has(old),`no tab or subtab is called "${old}"`);
 check(['fleet.alarms.byDevice','fleet.alarms.byAlarm','extensions.tab','protection.title','fleet.config.notificationRules','fleet.tabs.settings'].map(en),['By device','By alarm','Extensions','Defender','Notification rules','General'],'the subtab labels of review §2.6');
}

// History: the pill subtabs carry the job count and, with the right on a scoped device, the access count.
{
 const job=(id,serverId)=>({id,serverId,action:'refresh-inventory',target:'',state:'succeeded',createdAt:now-60000,actor:'owner'});
 const audit=[{id:1,at:now-1000,scope:'device',serverId:'a',actor:'owner',action:'terminal',target:''},{id:2,at:now-2000,scope:'device',serverId:'zz',actor:'owner',action:'terminal',target:''}];
 const withRight=servers.map(server=>({...server,permissions:['view','security.events']}));
 let pill=pillOf(render({servers:withRight,scoped:withRight,jobs:[job('j1','a'),job('j2','b'),job('j3','other')],audit,tab:'jobs'}));
 check(pill.tabs.map(tab=>[tab.label,tab.count]),[['Aufträge','2'],['Gerätezugriffe','1']],'History: Jobs and Device access keep their counts');
 pill=pillOf(render({jobs:[job('j1','a')],audit,tab:'access',viewer:{id:'tech',permissions:[]}}));
 check(pill.tabs.map(tab=>[tab.label,tab.count]),[['Aufträge','1'],['Gerätezugriffe',null]],'without the right on a scoped device: no access count');
}

// The choices go to onTab: a tab opens its first shown subtab, a subtab opens itself.
{
 const chosen=[];
 const find=(node,predicate,all=[])=>{if(!node||typeof node!=='object')return all;if(Array.isArray(node)){for(const child of node)find(child,predicate,all);return all;}if(predicate(node))all.push(node);for(const value of Object.values(node.props??{}))if(typeof value==='object')find(value,predicate,all);return all;};
 const bars=props=>{let built;renderToStaticMarkup(h(LocaleProvider,{locale:'de'},h(()=>{built=FleetView.type({...base,onTab:tab=>chosen.push(tab),...props});return null;})));return find(built,node=>node.type===Tabs);};
 let [tabs]=bars({});
 check([tabs.props.variant,tabs.props.overflow,tabs.props.panelId,tabs.props.label,tabs.props.value],['underline','menu',fleetPanelId,'Bereiche','devices'],'Tabs underline with overflow "menu", the panel id and the label');
 tabs.props.onChange('monitoring');tabs.props.onChange('inventory');tabs.props.onChange('history');tabs.props.onChange('devices');
 check(chosen.splice(0),['problems','software','jobs','devices'],'a tab opens its default subtab');
 [tabs]=bars({scope:{type:'customer',id:'c1'},alerts:panel('alerts'),notifications:panel('notifications')});
 tabs.props.onChange('monitoring');tabs.props.onChange('configuration');
 check(chosen.splice(0),['problems'],'a customer Monitoring opens By device; a customer has no Configuration');
 [tabs]=bars({...scopes.group.extra,scope:scopes.group.scope});
 tabs.props.onChange('configuration');
 check(chosen.splice(0),['tags'],'a group Configuration opens Tags');
 const [outer,pill]=bars({tab:'access'});
 check([outer.props.value,pill.props.variant,pill.props.overflow,pill.props.panelId,pill.props.className,pill.props.value],['history','pill','menu',fleetSubpanelId,'sdx-subtabs','access'],'the pill bar: Tabs pill with overflow "menu", panelId and class sdx-subtabs; the active subtab follows the route');
 pill.props.onChange('jobs');
 check(chosen.splice(0),['jobs'],'a subtab opens itself');
 check(bars({tab:'settings'}).length,1,'a route to a missing Configuration subtab shows Devices without a pill bar');
}

// Source: no Segmented scope bar, the label keys in both catalogs, CSS without .sdx-fleet-tabs.
{
 const fleet=readFileSync('ui/devices/fleet/fleet.tsx','utf8'),css=readFileSync('ui/styles/console.css','utf8');
 ok(!fleet.includes('sdx-fleet-tabs')&&!fleet.includes("fleet.tabs.label"),'fleet.tsx: the Segmented scope bar is gone');
 ok(!css.includes('.sdx-fleet-tabs'),'console.css: no .sdx-fleet-tabs rule');
 check([translate('en','fleet.tabs.areas'),translate('de','fleet.tabs.areas')],['Areas','Bereiche'],'the bar label in both languages');
 check(Object.values(pillLabels).map(key=>[en(key),de(key)]),[['Monitoring views','Monitoring-Ansichten'],['Inventory reports','Inventarberichte'],['History views','Historienansichten'],['Configuration pages','Konfigurationsseiten']],'the pill bar labels in both languages');
 check([en('fleet.tabs.monitoring'),de('fleet.tabs.monitoring')],['Monitoring','Monitoring'],'the Monitoring tab label');
 ok(/\.sdx-main:has\(> \.sdx-fleet > \.sdx-fleet-panel > \.sdx-table-wrap\)/.test(css)&&/\.sdx-fleet-panel > \.sdx-table-wrap \{ display: flex; flex: 1 0 auto;/.test(css),'the table still fills the page through the panel');
}

console.log(`PASS fleet scope tabs (${checks} checks): five link tabs per scope type and viewer with their default hrefs and the Devices count, no icon, one tabpanel labelled by the active tab, the pill subtab bars with their labels, links, aria-current and subtab panel, no pill bar with one subtab, no old tab names, the History counts and the onTab mapping.`);
