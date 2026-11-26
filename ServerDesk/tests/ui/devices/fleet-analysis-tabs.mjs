// The shared pattern of the scope analysis tabs (Alarms by device and by alarm, Software, OS support, Encryption,
// Drivers, Reliability, Certificates, Autostart, Notification rules, Tags, Extensions with its DHCP and DNS cards and
// Defender; the Configuration and History subtabs Alert rules, Permissions and both History views in the same frame) rendered with React SSR in German with the sample devices: one SectionHead with the tab
// name only for screen readers, no own head, every list a labelled DataTable with the sort heads of
// its columns and its foot, no gradient primary inside a tab or in the group Settings, the empty
// states with their one action (pressed through tests/support/panel-harness.mjs), the group Settings
// cards, and the source and CSS rules (one placeholder, no old loader, content-sized pills, the
// problem chips, tokens and the 4px grid). No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {postcss} from '../../support/theme-colors.mjs';
import {buttons} from '../../support/blocked-buttons.mjs';
import {panelHarness} from '../../support/panel-harness.mjs';
// A console file by its base name, which is unique under ui/ (tests/repo/repo-layout.mjs).
const uiFiles=readdirSync('ui',{recursive:true}).map(file=>'ui/'+String(file).replaceAll('\\','/'));
const uiFile=name=>{const found=uiFiles.filter(file=>file.endsWith('/'+name));assert.equal(found.length,1,name+' is one file under ui/');return found[0];};
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
const {demoData}=await import('../../../ui/shell/demo.ts');
const {problemRows}=await import('../../../ui/base/health-score.ts');
const problems=await import('../../../ui/devices/monitoring/problems.tsx');
const {default:AlarmsTab}=await import('../../../ui/devices/monitoring/alarms.tsx');
const {default:SoftwareTab}=await import('../../../ui/devices/inventory/software-tab.tsx');
const {default:OsSupportTab}=await import('../../../ui/devices/inventory/os-support.tsx');
const {default:EncryptionTab}=await import('../../../ui/devices/inventory/encryption-tab.tsx');
const {default:DriversTab}=await import('../../../ui/devices/inventory/drivers-tab.tsx');
const {default:ReliabilityTab}=await import('../../../ui/devices/inventory/reliability-tab.tsx');
const {default:CertificatesTab}=await import('../../../ui/devices/inventory/certificates-tab.tsx');
const {default:AutostartTab}=await import('../../../ui/devices/inventory/autostart-tab.tsx');
const {default:NotificationRulesPanel,emptyRulesView}=await import('../../../ui/devices/monitoring/notification-rules.tsx');
const {default:TagsPanel}=await import('../../../ui/devices/configuration/tags.tsx');
const {default:ExtensionsTab}=await import('../../../ui/devices/extensions/extensions-tab.tsx');
const {default:ProtectionTab}=await import('../../../ui/devices/protection/protection-tab.tsx');
const {GroupSettings,submitAttempt}=await import('../../../ui/devices/fleet/groups.tsx');
const {default:AlertRulesPanel}=await import('../../../ui/devices/monitoring/alert-rules.tsx');
const {ScopedPermissionEditor}=await import('../../../ui/devices/configuration/permissions-tab.tsx');
const {default:HistoryPanel}=await import('../../../ui/devices/history/history.tsx');
const {reportEmpty}=await import('../../../ui/kit/analysis-tab.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const noop=()=>{};
const de=(key,params)=>translate('de',key,params);
const read=file=>readFileSync(file,'utf8');
const render=(element,locale='de')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const decode=text=>text.replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const text=markup=>decode(markup.replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
const {servers}=demoData(),now=Date.now();
const owner={id:'owner',label:'owner',permissions:['*']};
const all={type:'all'};

// ---- One head, DataTables with their sort heads and foot, no primary ----
const tabs=[
 {title:'fleet.alarms.byDevice',description:de('problems.meta'),element:h(problems.default,{devices:servers,now,customerColumn:false,onOpen:noop,onShowDevices:noop}),
  sorts:[['problems.column.health','descending'],['problems.column.device','none'],['problems.column.openFor','none']],foot:/\d+ von \d+ Geräten? mit offenen Alarmen/},
 {title:'fleet.alarms.byAlarm',description:de('alarms.meta'),element:h(AlarmsTab,{devices:servers,viewer:owner,demo:true,now,customerColumn:false,onOpen:noop,onRefresh:noop,onShowDevices:noop}),
  sorts:[['alarms.column.level','descending'],['alarms.column.device','none'],['alarms.column.alarm','none'],['alarms.column.since','none']],foot:/\d+ von \d+ Alarm(en)?/},
 {title:'software.title',description:de('software.fleetMeta'),element:h(SoftwareTab,{scope:all,devices:servers,demo:true,now,onOpen:noop,onShowDevices:noop}),
  sorts:[['software.col.product','none'],['software.col.version','none'],['vulnerabilities.col','none'],['software.col.publisher','none'],['software.col.devices','descending']],optional:['vulnerabilities.col'],foot:/\d+ von \d+ Produkt(en)?/},
 {title:'osSupport.title',description:de('osSupport.meta'),element:h(OsSupportTab,{devices:servers,demo:true,onOpen:noop,onRefresh:noop,onShowDevices:noop}),
  sorts:[['osSupport.col.product','none'],['osSupport.col.securityEnd','none'],['osSupport.col.status','ascending'],['osSupport.col.devices','none']],foot:/\d+ von \d+ Version(en)?/},
 {title:'encryption.title',description:de('encryption.meta'),element:h(EncryptionTab,{devices:servers,onOpen:noop,onShowDevices:noop}),
  sorts:[['bitlocker.col.device','none'],['bitlocker.col.systemDrive','none']],foot:/\d+ von \d+ Geräten?/},
 {title:'drivers.title',description:de('drivers.fleetMeta'),element:h(DriversTab,{scope:all,devices:servers,demo:true,onOpen:noop,onShowDevices:noop}),
  sorts:[['drivers.col.driver','none'],['drivers.col.version','none'],['drivers.col.provider','none'],['drivers.col.date','none'],['drivers.col.devices','descending']],foot:/\d+ von \d+ Treiber/},
 {title:'reliability.title',description:de('reliability.fleetMeta'),element:h(ReliabilityTab,{devices:servers,now,onOpen:noop,onShowDevices:noop}),
  sorts:[['reliability.col.program','none'],['reliability.col.crashes','descending'],['reliability.col.hangs','none'],['reliability.col.devices','none'],['reliability.col.last','none']],foot:/\d+ von \d+ Programm(en)?/},
 {title:'certificates.title',description:de('certificates.fleetMeta'),element:h(CertificatesTab,{devices:servers,now,onOpen:noop,onShowDevices:noop}),
  sorts:[['certificates.col.device','none'],['certificates.col.subject','none'],['certificates.col.expires','ascending'],['certificates.col.daysLeft','none']],foot:/\d+ von \d+ Zertifikat(en)?/},
 {title:'autostart.title',description:`${de('autostart.fleetMeta')} ${de('autostart.rareFirst')}`,element:h(AutostartTab,{scope:all,devices:servers,demo:true,now,onOpen:noop,onShowDevices:noop}),
  sorts:[['autostart.col.entry','none'],['autostart.col.type','none'],['autostart.col.devices','ascending'],['autostart.col.new','none']],foot:/\d+ von \d+ Einträgen?/},
 {title:'fleet.config.notificationRules',description:de('notificationRules.meta'),element:h(NotificationRulesPanel,{scope:{type:'all',id:'*'},scopeName:'Alle Geräte',demo:true,canManageChannels:true,onOpenOrigin:noop,onOpenSettings:noop,onHideDemo:noop}),cards:true},
 {title:'tags.title',description:de('tags.meta'),element:h(TagsPanel,{scope:{type:'group',id:'g1'},scopeName:'Berlin',demo:true,onRefresh:noop,onOpenOrigin:noop}),cards:true},
 // Extensions: the summary cards, its own DataTable, then the DHCP and DNS cards with a flush DataTable each.
 {title:'extensions.tab',description:de('extensions.fleet.meta'),element:h(ExtensionsTab,{devices:servers,viewer:owner,demo:true,now,releases:[],onConfirm:noop,onOpen:noop,onShowDevices:noop}),
  labels:[de('extensions.tab'),de('dhcp.fleet.title'),de('dns.fleet.title')],sorts:[['extensions.col.device','none'],['extensions.col.detected','none']],foot:/\d+ von \d+ Einträgen?/},
 {title:'protection.title',description:de('protection.meta'),element:h(ProtectionTab,{devices:servers,now,onOpen:noop,viewer:owner,demo:true,saving:false,onConfirm:noop,edition:null}),
  sorts:[['protection.col.device','none'],['protection.col.status','none'],['protection.col.active','none'],['protection.col.lastScan','none'],['protection.col.signatures','none']],foot:/\d+ von \d+ Geräten?/},
];
for(const tab of tabs){
 const name=de(tab.title),html=render(tab.element);
 const head=html.match(/^<section class="sdx-health-tab[^"]*" aria-labelledby="([^"]+)"><header class="sdx-section-head"><div class="sdx-section-head-text"><h2 id="([^"]+)" class="sr-only">([^<]+)<\/h2><p>([^<]*)<\/p>/);
 ok(head&&head[1]===head[2],`${name}: the section is aria-labelledby its h2`);
 check([decode(head[3]),decode(head[4])],[name,tab.description],`${name}: the sr-only h2 names the tab, the visible description is its meta text`);
 check((html.match(/<header class="sdx-section-head">/g)??[]).length,1,`${name}: one SectionHead`);
 const headMarkup=html.slice(0,html.indexOf('</header>'));
 ok(!/sdx-icon-tile/.test(headMarkup)&&!/sdx-health-head|sdx-alarms-head|sdx-notification-rules-head/.test(html),`${name}: no icon tile in the head and no old head`);
 ok(!html.includes('sdx-btn-primary'),`${name}: no gradient primary inside the tab`);
 ok(!html.includes('sdx-loading'),`${name}: no old loader`);
 ok(!new RegExp(`<h[23][^>]*>(?:<[^>]+>)*${name}(?:<[^>]+>)*</h[23]>`).test(html.replace(/<h2 id="[^"]+" class="sr-only">[^<]+<\/h2>/,'')),`${name}: no visible heading or card title repeats the tab name`);
 if(tab.headOnly)continue;
 const tables=(html.match(/<table/g)??[]).length,wrapped=[...html.matchAll(/<div class="sdx-table-wrap[^"]*" role="region" aria-label="([^"]+)"[^>]*><table class="sdx-table sdx-data-table/g)].map(match=>decode(match[1]));
 ok(tables>0&&tables===wrapped.length,`${name}: every table is a DataTable in its labelled region`);
 if(tab.cards)continue;
 check(wrapped,tab.labels??[name],tab.labels?`${name}: the DataTable named like the tab, then the card tables`:`${name}: one DataTable named like the tab`);
 const sorts=[...html.matchAll(/<th scope="col"[^>]*aria-sort="(\w+)"><button[^>]*>([^<]+)</g)].map(match=>[decode(match[2]),match[1]]);
 const expected=tab.sorts.filter(([key])=>!tab.optional?.includes(key)||sorts.some(([label])=>label===de(key))).map(([key,state])=>[de(key),state]);
 check(sorts,expected,`${name}: the sortable columns and the default sort`);
 ok(tab.foot.test(text(html.match(/<div class="sdx-table-foot"><p>(.*?)<\/p>/)?.[1]??'')),`${name}: the foot "X von Y …"`);
}

// ---- Reliability: the two stability pills in the head meta; OS support: the catalog date in meta ----
{
 const html=render(h(ReliabilityTab,{devices:servers,now,onOpen:noop,onShowDevices:noop}));
 ok(/<p class="sdx-section-head-meta"><span class="sdx-health-counts"><span class="sdx-pill sdx-pill-\w+"><i aria-hidden="true"><\/i>[^<]+<\/span><span class="sdx-pill sdx-pill-neutral">/.test(html),'Reliability: the stability pills sit in the head meta');
 ok(/<p class="sdx-section-head-meta">Katalogstand /.test(render(h(OsSupportTab,{devices:servers,demo:true,onOpen:noop,onRefresh:noop,onShowDevices:noop}))),'OS support: the catalog date in the head meta');
}

// ---- Empty states: one action each, pressed ----
const harness=panelHarness({hooked:['ui/devices/monitoring/alarms.tsx','ui/devices/inventory/software-tab.tsx','ui/devices/inventory/os-support.tsx','ui/devices/inventory/encryption-tab.tsx','ui/devices/inventory/drivers-tab.tsx','ui/devices/inventory/reliability-tab.tsx','ui/devices/inventory/certificates-tab.tsx','ui/devices/inventory/autostart-tab.tsx'],stubs:{'@/ui/base/api':{api:()=>new Promise(noop),downloadText:noop,message:String,permitted:()=>true,ApiError:Error}}});
const tabFile=file=>harness.load(uiFile(file)).default;
/** The empty state of the tab's DataTable after a fresh render: title, sentence, action element and its text. */
const emptyOf=(Tab,props)=>{const table=harness.table(harness.tree(Tab,props));return {table,empty:table.props.empty,label:actionText(table.props.empty.action)};};
const actionText=action=>!action?null:typeof action.props.children==='string'?action.props.children:action.props.label??(action.props.onShowDevices?de('fleet.analysis.showDevices'):null);
const segmented=tree=>harness.find(tree,item=>Array.isArray(item.props?.items)&&typeof item.props.onChange==='function');
{
 const calls=[],show=()=>calls.push('devices'),rules=()=>calls.push('rules');
 // Problems: no problems → Show devices; the level → Show all (hook-free view).
 const view=props=>problems.ProblemsView({rows:[],level:'all',onLevel:level=>calls.push('level:'+level),sort:problems.defaultProblemSort,onSort:noop,expanded:new Set(),onToggle:noop,now,locale:'de',customer:false,onOpen:noop,onShowDevices:show,...props});
 let empty=view({}).props.empty;
 check([empty.title,empty.children],[de('problems.empty.title'),de('problems.empty.text')],'Problems: no problems');
 empty.action.props.onShowDevices();
 empty=view({rows:problemRows(servers),level:'warning'}).props.empty;
 const demoProblems=problemRows(servers);
 check(view({rows:demoProblems,level:'critical'}).props.empty.title,de('problems.filtered.title'),'Problems: with rows, the empty row is the filter state');
 view({rows:demoProblems,level:'critical'}).props.empty.action.props.onReset();
 check(calls.splice(0),['devices','level:all'],'Problems: "Geräte anzeigen" and "Alle anzeigen" call their callbacks');

 // Alarms: no alarms → Show devices, or Open alert rules where the scope has them; the filters → Reset filters.
 const Alarms=tabFile('alarms.tsx'),alarmProps={devices:[],viewer:owner,demo:true,now,customerColumn:false,onOpen:noop,onRefresh:noop,onShowDevices:show};
 harness.reset();let state=emptyOf(Alarms,alarmProps);
 check([state.empty.title,state.label],[de('alarms.empty.title'),de('fleet.analysis.showDevices')],'Alarms without the Alert rules tab: "Geräte anzeigen"');
 state.empty.action.props.onShowDevices();
 harness.reset();state=emptyOf(Alarms,{...alarmProps,onOpenAlertRules:rules});
 check(state.label,de('fleet.analysis.openAlertRules'),'Alarms with the Alert rules tab: "Alarmregeln öffnen"');
 state.empty.action.props.onClick();
 const withAlarms={...alarmProps,devices:servers};
 harness.reset();let tree=harness.tree(Alarms,withAlarms);
 segmented(tree).props.onChange('info');tree=harness.tree(Alarms,withAlarms);
 state={empty:harness.table(tree).props.empty};
 check([state.empty.title,state.empty.action.props.label],[de('alarms.filtered.title'),de('alarms.resetFilters')],'Alarms: a filter that hides every alarm offers "Filter zurücksetzen"');
 state.empty.action.props.onReset();
 ok(harness.table(harness.tree(Alarms,withAlarms)).props.rows.length>0,'the reset shows the alarms again');
 check(calls.splice(0),['devices','rules'],'Alarms: the actions call onShowDevices and onOpenAlertRules');

 // Software, Drivers, Autostart without inventory, OS support and Encryption without devices, Reliability without crashes: Show devices.
 const none=[
  ['Software','software-tab.tsx',{scope:all,devices:[],demo:true,now,onOpen:noop,onShowDevices:show},'software.fleetEmpty','fleet.analysis.noInventoryText'],
  ['Drivers','drivers-tab.tsx',{scope:all,devices:[],demo:true,onOpen:noop,onShowDevices:show},'drivers.fleetEmpty','fleet.analysis.noInventoryText'],
  ['Autostart','autostart-tab.tsx',{scope:all,devices:[],demo:true,now,onOpen:noop,onShowDevices:show},'autostart.fleetEmpty','fleet.analysis.noInventoryText'],
  ['OS support','os-support.tsx',{devices:[],demo:true,onOpen:noop,onRefresh:noop,onShowDevices:show},'osSupport.empty','fleet.analysis.noDevicesText'],
  ['Encryption','encryption-tab.tsx',{devices:[],onOpen:noop,onShowDevices:show},'encryption.empty','fleet.analysis.noDevicesText'],
  ['Reliability','reliability-tab.tsx',{devices:[],now,onOpen:noop,onShowDevices:show},'reliability.fleetEmpty','reliability.fleetEmptyText'],
  ['Certificates','certificates-tab.tsx',{devices:[],now,onOpen:noop,onShowDevices:show},'certificates.fleetNone','fleet.analysis.noInventoryText'],
 ];
 for(const [name,file,props,title,sentence] of none){
  harness.reset();const result=emptyOf(tabFile(file),props);
  check([result.empty.title,result.empty.children,result.label],[de(title),de(sentence),de('fleet.analysis.showDevices')],`${name}: the fact, the next step, "Geräte anzeigen"`);
  result.empty.action.props.onShowDevices();
 }
 check(calls.splice(0),none.map(()=>'devices'),'each "Geräte anzeigen" switches to the Devices tab');

 // OS support and Encryption: a status filter without rows → Show all.
 for(const [name,file,props,title] of [['OS support','os-support.tsx',{devices:servers.filter(server=>server.osSupport?.status==='supported'),demo:true,onOpen:noop,onRefresh:noop,onShowDevices:show},'osSupport.noMatch'],['Encryption','encryption-tab.tsx',{devices:servers.slice(0,1),onOpen:noop,onShowDevices:show},'encryption.noMatch']]){
  const Tab=tabFile(file);harness.reset();tree=harness.tree(Tab,props);
  const filter=segmented(tree),zero=filter.props.items.find(item=>item.id!=='all'&&item.count===0);
  filter.props.onChange(zero.id);tree=harness.tree(Tab,props);
  const empty=harness.table(tree).props.empty;
  check([empty.title,empty.children,empty.action.props.label],[de(title),de('fleet.analysis.noMatchText'),de('fleet.analysis.showAll')],`${name}: the status filter offers "Alle anzeigen"`);
  empty.action.props.onReset();
  check(segmented(harness.tree(Tab,props)).props.value,'all',`${name}: "Alle anzeigen" sets the filter to All`);
 }

 // Certificates: the filter or the key switch → Show all certificates (filter All, key switch off).
 const Certificates=tabFile('certificates-tab.tsx');
 const cert={thumbprint:'AB12',stores:['My'],subject:'CN=intranet',sans:[],issuer:'CN=CA',notBefore:new Date(now-86400000).toISOString(),notAfter:new Date(now+400*86400000).toISOString(),hasPrivateKey:false,selfSigned:false,bindings:[]};
 const certProps={devices:[{...servers[0],snapshot:{...servers[0].snapshot,certificates:{items:[cert],truncated:false}}}],now,onOpen:noop,onShowDevices:show};
 harness.reset();tree=harness.tree(Certificates,certProps);
 // The untouched default view (expiring, only with a private key) is empty: the good fact, its sentence and "Show all certificates".
 const certEmpty=harness.table(tree).props.empty;
 check([certEmpty.title,certEmpty.children,certEmpty.action.props.children],[de('certificates.defaultEmpty'),de('certificates.defaultEmptyText'),de('certificates.showAll')],'Certificates: the empty default view says "Kein Zertifikat läuft in den nächsten 30 Tagen ab" with "Alle Zertifikate anzeigen"');
 check([translate('en','certificates.defaultEmpty'),translate('en','certificates.defaultEmptyText'),translate('en','certificates.showAll')],['No certificate expires in the next 30 days','The list shows only certificates with a private key. Show all certificates to see the others.','Show all certificates'],'the English copy');
 certEmpty.action.props.onClick();tree=harness.tree(Certificates,certProps);
 check([segmented(tree).props.value,harness.find(tree,item=>item.props?.role==='switch').props.checked,harness.table(tree).props.rows.length],['all',false,1],'"Show all certificates" sets the filter to All and turns the key switch off');
 // A filter of the viewer without a match: today's "no match" with the same reset.
 segmented(tree).props.onChange('expired');tree=harness.tree(Certificates,certProps);
 let userEmpty=harness.table(tree).props.empty;
 check([userEmpty.title,userEmpty.children,userEmpty.action.props.label],[de('certificates.fleetEmpty'),de('fleet.analysis.noMatchText'),de('certificates.showAll')],'Certificates: the viewer\'s filter without a match: "Kein Zertifikat passt zu diesem Filter"');
 harness.reset();tree=harness.tree(Certificates,certProps);
 harness.find(tree,item=>item.props?.role==='switch').props.onChange({target:{checked:false}});tree=harness.tree(Certificates,certProps);
 segmented(tree).props.onChange('expired');tree=harness.tree(Certificates,certProps);
 userEmpty=harness.table(tree).props.empty;
 check(userEmpty.title,de('certificates.fleetEmpty'),'the switch changed by the viewer: the no-match state');
 userEmpty.action.props.onReset();tree=harness.tree(Certificates,certProps);
 check([segmented(tree).props.value,harness.table(tree).props.rows.length],['all',1],'its reset shows the certificate');
 // The shared choice of the three causes (analysis-tab.tsx), in order.
 const causes={noData:{title:'none'},emptyDefault:{title:'default'},noMatch:{title:'match'}};
 check([reportEmpty({...causes,hasData:false,defaultView:true}).title,reportEmpty({...causes,hasData:true,defaultView:true}).title,reportEmpty({...causes,hasData:true,defaultView:false}).title,reportEmpty({noData:causes.noData,noMatch:causes.noMatch,hasData:true,defaultView:true}).title],['none','default','match','match'],'reportEmpty: no data, then the empty default view, then the viewer\'s filter');

 // Autostart: search or filter → Reset filter, which clears both.
 const Autostart=tabFile('autostart-tab.tsx'),autoProps={scope:all,devices:servers.filter(server=>server.id==='demo-dc'),demo:true,now,onOpen:noop,onShowDevices:show};
 harness.reset();tree=harness.tree(Autostart,autoProps);
 harness.table(tree).props.toolbar.props.search.onChange('zz');
 const autoFilter=segmented(tree),emptyFilter=autoFilter.props.items.find(item=>item.id==='suspicious'&&item.count===0);
 autoFilter.props.onChange(emptyFilter.id);tree=harness.tree(Autostart,autoProps);
 let table=harness.table(tree);
 if(!table.props.rows.length){
  check([table.props.empty.title,table.props.empty.action.props.label],[de('autostart.noMatch'),de('fleet.empty.resetFilter')],'Autostart: a filter without rows offers "Filter zurücksetzen"');
  table.props.empty.action.props.onReset();tree=harness.tree(Autostart,autoProps);
  check([segmented(tree).props.value,harness.table(tree).props.toolbar.props.search.value],['all',''],'the reset clears the filter and the search');
 }else assert.fail('the Autostart filter should hide every row');
 ok(/const reset=\(\)=>\{setQuery\(''\);setDebounced\(''\);setFilter\('all'\);\};/.test(read('ui/devices/inventory/autostart-tab.tsx')),'Autostart: the reset clears the search and the filter');

 // Software and Drivers: a search without match → Clear search.
 for(const [name,file,props,title] of [['Software','software-tab.tsx',{scope:all,devices:servers,demo:true,now,onOpen:noop,onShowDevices:show},'software.noMatch'],['Drivers','drivers-tab.tsx',{scope:all,devices:servers,demo:true,onOpen:noop,onShowDevices:show},'drivers.noMatch']]){
  const Tab=tabFile(file);harness.reset();tree=harness.tree(Tab,props);
  harness.table(tree).props.toolbar.props.search.onChange('zzz-nothing');
  harness.tree(Tab,props);await harness.flush();await new Promise(resolve=>setTimeout(resolve,350));
  table=harness.table(harness.tree(Tab,props));
  check([table.props.empty.title,table.props.empty.children,table.props.empty.action.props.label,table.props.rows.length],[de(title),de('fleet.analysis.noMatchText'),de('fleet.analysis.clearSearch'),0],`${name}: a search without match offers "Suche löschen"`);
  table.props.empty.action.props.onReset();
  table=harness.table(harness.tree(Tab,props));
  check([table.props.toolbar.props.search.value,table.props.rows.length>0],['',true],`${name}: "Suche löschen" empties the field and shows the rows again at once`);
 }
}

// ---- Loading tabs: the kit Skeleton with the slow line and the retry, the load error with "Erneut versuchen" ----
for(const file of ['software-tab','drivers-tab','autostart-tab','notification-rules','tags']){
 const source=read(uiFile(file+'.tsx'));
 ok(!source.includes('sdx-loading')&&/<FirstLoad label=\{t\('[\w.]+'\)\}/.test(source)&&/<LoadFailed text=/.test(source)&&!source.includes("t('common.reload')"),`${file}: FirstLoad and LoadFailed, no .sdx-loading, no "Reload"`);
}
{
 // LoadFailed and RetryAction live in the kit (SettingsPage uses them too); analysis-tab.tsx re-exports them.
 const source=read('ui/kit/analysis-tab.tsx'),kit=read('ui/kit/kit.tsx');
 ok(/<Skeleton variant="table" rows=\{rows\} label=\{label\} after=\{15000\} action=\{<RetryAction/.test(source)&&/export \{LoadFailed,RetryAction\} from '@\/ui\/kit\/kit';/.test(source)&&/\{t\('common\.retry'\)\}/.test(kit)&&/<Notice tone="danger" icon=\{AlertTriangle\} action=\{<RetryAction/.test(kit),'the first load shows the slow line after 15 s with "Erneut versuchen"; a failed load is a danger Notice with the same retry');
 check(de('common.retry'),'Erneut versuchen','the retry label');
}

// ---- Notifications in demo: the demo state, not "Noch keine Kanäle" ----
{
 const html=render(h(NotificationRulesPanel,{scope:{type:'all',id:'*'},scopeName:'Alle Geräte',demo:true,canManageChannels:true,onOpenOrigin:noop,onOpenSettings:noop,onHideDemo:noop}));
 ok(html.includes(de('notificationRules.demo.title'))&&html.includes(de('notificationRules.demo.text'))&&html.includes(`<span>${de('palette.action.hideDemo')}</span>`)&&!html.includes('Noch keine Kanäle'),'demo: "Keine Benachrichtigungsregeln für Beispielgeräte" with "Beispielgeräte ausblenden"');
 ok(emptyRulesView({type:'all',id:'*'},'').channels.length===0,'the demo view has no channel data');
}

// ---- Tags: Direct and Inherited cards, "Wird vererbt", "Geändert", the empty state ----
{
 const origin={type:'group',id:'g0',name:'Berlin',visible:true};
 const view={scope:{type:'group',id:'g1',name:'Mitte'},canEdit:false,reason:null,
  direct:[{id:'t1',name:'Env',value:'Prod',inherit:true,updatedAt:1,overrides:{value:'Test',origin}},{id:'t2',name:'Owner',value:'',inherit:false,updatedAt:1,overrides:null}],
  inherited:[{name:'Site',value:'HQ',origin}]};
 const html=render(h(TagsPanel,{scope:{type:'group',id:'g1'},scopeName:'Mitte',demo:true,demoView:view,onRefresh:noop,onOpenOrigin:noop}));
 const cards=[...html.matchAll(/<section class="sdx-card sdx-card-flush">(.*?)<\/section>/gs)].map(match=>match[1]);
 check(cards.map(card=>[text(card.match(/<h2[^>]*>(.*?)<\/h2>/s)[1]),card.match(/role="region" aria-label="([^"]+)"/)[1],/sdx-icon-tile/.test(card.match(/<h2[^>]*>(.*?)<\/h2>/s)[1])]),[['Direkt','Direkte Tags',true],['Geerbt','Geerbte Tags',true]],'the Direct card first, then the Inherited card, each with its DataTable and icon tile');
 check([...cards[0].matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map(match=>text(match[1])),['Name','Wert','Aktionen'],'Direct: no Inheritance and no Origin column');
 check([...cards[1].matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map(match=>text(match[1])),['Name','Wert','Ursprung','Aktionen'],'Inherited: the Origin column');
 const directRows=[...cards[0].matchAll(/<tbody>(.*?)<\/tbody>/gs)][0][1].split('</tr>').filter(Boolean);
 ok(directRows[0].includes('<strong>Env</strong> <span class="sdx-tag">Wird vererbt</span>')&&!directRows[1].includes('Wird vererbt'),'"Wird vererbt" only on the direct tag that passes down');
 ok(directRows[0].includes('<span class="sdx-tag sdx-tag-changed">Geändert</span>')&&text(directRows[0]).includes('Geerbt: Test von Gerätegruppe: Berlin'),'an override: "Geändert" and the inherited value');
 ok(!/Vererbung/.test(html)&&(html.match(/>Direkt</g)??[]).length===1,'no "Vererbung" column; "Direkt" only as the card title');
 const add=buttons(html).filter(button=>button.inner.includes('<span>Tag hinzufügen</span>'));
 ok(add.length===1&&add[0].blocked&&/sdx-btn-secondary/.test(add[0].attributes)&&add[0].description===de('kit.unavailable.demo'),'"Tag hinzufügen" in the head: secondary, blocked with its reason');
 const empty=render(h(TagsPanel,{scope:{type:'group',id:'g1'},scopeName:'Mitte',demo:true,onRefresh:noop,onOpenOrigin:noop}));
 const emptyAdd=buttons(empty).filter(button=>button.inner.includes('<span>Tag hinzufügen</span>'));
 ok(empty.includes(de('tags.empty'))&&empty.includes(de('tags.emptyHint'))&&emptyAdd.length===2&&emptyAdd.every(button=>button.blocked&&button.description===de('kit.unavailable.demo'))&&(empty.match(/<section class="sdx-card sdx-card-flush">/g)??[]).length===1,'no tags: one Direct card with "Keine Tags" and "Tag hinzufügen", blocked with the head\'s reason; no Inherited card');
 const onlyInherited=render(h(TagsPanel,{scope:{type:'group',id:'g1'},scopeName:'Mitte',demo:true,demoView:{...view,direct:[]},onRefresh:noop,onOpenOrigin:noop}));
 ok(onlyInherited.includes(de('tags.emptyDirect'))&&onlyInherited.includes(de('tags.emptyDirectText')),'no direct tags: "Keine direkten Tags" above the inherited ones');
 const device=render(h(TagsPanel,{scope:{type:'device',id:'d1'},scopeName:'SRV',demo:true,demoView:{...view,scope:{type:'device',id:'d1',name:'SRV'}},onRefresh:noop,onOpenOrigin:noop}));
 ok(!device.includes('Wird vererbt')&&(device.match(/<section class="sdx-card sdx-card-flush">/g)??[]).length===2,'a device view: the same two cards without "Wird vererbt"');
}

// ---- Tags: the inherited row menu lists "Open origin" first; removing a direct tag has no confirmation and toasts "Tag removed." ----
{
 const origin={type:'group',id:'g0',name:'Berlin',visible:true};
 const view={scope:{type:'group',id:'g1',name:'Mitte'},canEdit:true,reason:null,
  direct:[{id:'t2',name:'Owner',value:'',inherit:false,updatedAt:7,overrides:null}],
  inherited:[{name:'Site',value:'HQ',origin}]};
 const calls=[];
 const tagHarness=panelHarness({hooked:['ui/devices/configuration/tags.tsx'],stubs:{'@/ui/base/api':{api:async(url,body)=>{calls.push(body?{url,...body}:{url});return body?{}:view;},message:String,permitted:()=>true,ApiError:class extends Error{}}}});
 const tagsModule=tagHarness.load('ui/devices/configuration/tags.tsx');
 const tableTree=tagHarness.tree(tagsModule.TagsTable,{view,onAdd:noop,onEdit:noop,onRemove:noop,onReset:noop,onOpenOrigin:noop});
 const inheritedTable=tagHarness.table(tableTree,de('tags.table.inherited'));
 const inheritedMenu=inheritedTable.props.columns.find(column=>column.id==='actions').cell(view.inherited[0]).props.entries;
 check(inheritedMenu.map(entry=>[entry.id,!!entry.blocked]),[['origin',false],['edit',true]],'inherited tag menu: "Ursprung öffnen" first, then the blocked edit entry');
 const panelProps={scope:{type:'group',id:'g1'},scopeName:'Mitte',demo:false,onRefresh:async()=>{},onOpenOrigin:noop};
 tagHarness.reset();tagHarness.tree(tagsModule.default,panelProps);await tagHarness.flush();
 const tree=tagHarness.tree(tagsModule.default,panelProps);
 const table=tagHarness.find(tree,item=>item.type===tagsModule.TagsTable);
 const removeEntry=tagHarness.tree(tagsModule.TagsTable,table.props);
 const directMenu=tagHarness.table(removeEntry,de('tags.table.direct')).props.columns.find(column=>column.id==='actions').cell(view.direct[0]).props.entries;
 calls.length=0;
 directMenu.find(entry=>entry.id==='remove').onSelect();await tagHarness.settle();
 check(calls[0],{url:calls[0]?.url,scopeType:'group',scopeId:'g1',action:'remove-tag',tagId:'t2',expected:7},'"Entfernen" sends remove-tag at once, without a confirmation step');
 ok(tagHarness.toasts.includes(de('tags.removed'))&&translate('en','tags.removed')==='Tag removed.','the toast "Tag entfernt." / "Tag removed."');
}

// ---- Group Settings: kit Cards, Field labels, a secondary Save ----
{
 const group={id:'g1',name:'Berlin',description:'Web',parentId:null,depth:1,deviceCount:3,path:'Berlin',permissions:['groups.manage']};
 const groups=[group,{id:'g2',name:'Mitte',description:'',parentId:'g1',depth:2,deviceCount:1,path:'Berlin / Mitte',permissions:[]}];
 const props={group,groups,viewer:owner,busy:false,demo:false,onUpdate:async()=>{},onCreateChild:noop,onDelete:noop};
 let html=render(h(GroupSettings,props));
 const cards=[...html.matchAll(/<section class="sdx-card"[^>]*><header class="sdx-section-head sdx-card-head">(.*?)<\/header>/gs)].map(match=>match[1]);
 check(cards.map(card=>[text(card.match(/<h2[^>]*>(.*?)<\/h2>/s)[1]),/sdx-icon-tile/.test(card),text(card.match(/<p>(.*?)<\/p>/s)[1])]),[['Allgemein',true,de('groups.generalHint')],['Untergruppen',true,'1 Untergruppe']],'the General and Subgroups cards with icon tiles and their descriptions');
 ok(/<div class="sdx-section-head-actions sdx-card-actions"><button[^>]*class="sdx-btn sdx-btn-secondary sdx-btn-sm"[^>]*>.*?Untergruppe erstellen/.test(html),'"Untergruppe erstellen" is a small Btn in the Subgroups head');
 ok(!/<header class="sdx-card-head">/.test(html)&&!read('ui/devices/fleet/groups.tsx').includes('<section className="sdx-card">'),'no hand-written card or card head');
 ok(/<label class="sdx-field-label" for="([^"]+)">Name<\/label><input[^>]*id="\1"/.test(html)&&/<label class="sdx-field-label" for="([^"]+)">Beschreibung<\/label><textarea[^>]*id="\1"/.test(html),'name and description are Fields with bound labels');
 const save=buttons(html).find(button=>/type="submit"/.test(button.attributes));
 ok(save&&/sdx-btn-secondary/.test(save.attributes)&&save.blocked&&save.description===de('common.noChanges')&&!html.includes('sdx-btn-primary'),'Save is secondary and blocked with "Keine Änderungen."; no primary');
 ok(!buttons(html).some(button=>button.inner.includes(`<span>${de('common.discard')}</span>`)),'Discard only when dirty');
 ok(html.indexOf('sdx-danger-zone')>html.lastIndexOf('sdx-card'),'the danger zone stays last');
 check(buttons(render(h(GroupSettings,{...props,demo:true}))).find(button=>/type="submit"/.test(button.attributes)).description,de('kit.unavailable.demo'),'demo: Save blocked with the demo reason');
 // With hooks: a dirty form shows Discard, an empty name after a submit attempt marks the field.
 const groupHarness=panelHarness({hooked:['ui/devices/fleet/groups.tsx'],stubs:{'@/ui/session/mfa-step-up':{MfaStepUp:()=>null}}});
 const Settings=groupHarness.load('ui/devices/fleet/groups.tsx').GroupSettings;
 groupHarness.reset();
 let tree=groupHarness.tree(Settings,props);
 groupHarness.find(tree,item=>item.type==='input'&&item.props.maxLength===80).props.onChange({target:{value:'  '}});
 tree=groupHarness.tree(Settings,props);
 html=groupHarness.html(Settings,props);
 const dirtySave=buttons(html).find(button=>/type="submit"/.test(button.attributes));
 ok(buttons(html).some(button=>button.inner.includes(`<span>${de('common.discard')}</span>`))&&dirtySave.description===de('groups.enterName')&&!/aria-invalid/.test(html),'dirty: Discard shows, Save is blocked with "Gib einen Namen ein", no field error before a submit');
 const form=groupHarness.find(tree,item=>item.type==='form');
 form.props.onClickCapture({type:'click',target:{closest:selector=>selector==='button[type="submit"]'?{}:null}});
 html=groupHarness.html(Settings,props);
 ok(/<input[^>]*aria-invalid="true"/.test(html)&&html.includes(`<p id="`)&&html.includes(`class="sdx-field-error">${de('groups.enterName')}</p>`),'after the submit attempt the name Field shows the error with aria-invalid');
 // FormActions (quiet) and DangerZone instead of the hand-built row and section.
 const groupsSource=read('ui/devices/fleet/groups.tsx');
 ok(groupsSource.includes('<FormActions quiet dirty={dirty}')&&groupsSource.includes('<DangerZone title={t(\'tree.deleteGroup\')} description={t(\'groups.deleteHint\')} label={t(\'tree.deleteGroup\')} icon={Trash2}')&&!groupsSource.includes('className="sdx-form-actions"')&&!groupsSource.includes('className="sdx-danger-zone"'),'GroupSettings renders through FormActions (quiet) and DangerZone; no hand-built row or section');
 ok(/class="sdx-btn sdx-btn-secondary sdx-form-save"/.test(html)&&!/sdx-btn-primary/.test(html),'dirty: Save stays secondary (quiet), because the scope header has the primary');
 ok(buttons(html).some(button=>/sdx-btn-ghost/.test(button.attributes)&&button.inner.includes(`<span>${de('common.discard')}</span>`)),'Discard is a ghost button');
 const zone=render(h(GroupSettings,{...props,demo:true}));
 const zoneId=zone.match(/<section class="sdx-danger-zone" aria-labelledby="([^"]+)">/)?.[1];
 ok(zoneId&&zone.includes(`<strong id="${zoneId}">${de('tree.deleteGroup')}</strong><p>${de('groups.deleteHint')}</p>`),'the danger zone is a section named by its title, with the same sentence');
 check(buttons(zone).filter(button=>/sdx-btn-danger/.test(button.attributes)).map(button=>button.description),[de('kit.unavailable.demo')],'its danger button keeps the blocked reasons (demo)');
 check(buttons(render(h(GroupSettings,props))).filter(button=>/sdx-btn-danger/.test(button.attributes)).map(button=>button.description),[de('groups.deleteChildrenFirst')],'and the subgroup reason');
 const busyZone=buttons(render(h(GroupSettings,{...props,groups:[group],busy:true}))).find(button=>/sdx-btn-danger/.test(button.attributes));
 ok(busyZone.blocked&&!busyZone.disabled&&busyZone.description===de('kit.busy'),'while a change runs: Delete is blocked with kit.busy, never natively disabled');
 ok(groupsSource.includes('<GroupCreateForm key={formKey}'),'the create form key and the dirty reset share formKey');
 check([submitAttempt({type:'click',target:{closest:()=>({})}}),submitAttempt({type:'keydown',key:'Enter',target:{closest:()=>({})}}),submitAttempt({type:'keydown',key:'a',target:{closest:()=>({})}}),submitAttempt({type:'click',target:{closest:()=>null}})],[true,true,false,false],'a click or Enter/Space on the submit button is an attempt');
}

// ---- The scope Configuration and History subtabs in the shared analysis frame, without a gradient primary ----
{
 const frame=(name,html,label)=>{
  ok(new RegExp(`^<section class="sdx-health-tab[^"]*" aria-labelledby="([^"]+)"[^>]*><header class="sdx-section-head"><div class="sdx-section-head-text"><h2 id="\\1" class="sr-only">${label}</h2>`).test(html),`${name}: an AnalysisTab section labelled by its sr-only h2 "${label}"`);
  ok(!html.includes('sdx-btn-primary'),`${name}: no gradient primary inside the subtab`);
 };
 frame('Alert rules',render(h(AlertRulesPanel,{scope:{type:'global',id:'*'},scopeName:'Alle Geräte',demo:true,onRefresh:noop,onOpenOrigin:noop})),de('alertRules.title'));
 frame('Permissions',render(h(ScopedPermissionEditor,{viewer:owner,demo:true,onRefresh:noop,scope:{type:'global'},scopeName:'Alle Geräte'})),de('tree.permissions'));
 const history=tab=>render(h(HistoryPanel,{scoped:servers,servers,viewer:owner,demo:true,saving:false,now,jobs:[],audit:[],onSelectJob:noop,onCancelJob:noop,tab}));
 frame('History › Jobs',history('jobs'),de('history.tab.jobs'));
 frame('History › Device access',history('access'),de('history.tab.access'));
 const settingsGroup={id:'g1',name:'Berlin',description:'Web',parentId:null,depth:1,deviceCount:3,path:'Berlin',permissions:['groups.manage']};
 const general=render(h(GroupSettings,{group:settingsGroup,groups:[settingsGroup],viewer:owner,busy:false,demo:false,onUpdate:async()=>{},onCreateChild:noop,onDelete:noop}));
 frame('General',general,de('fleet.tabs.settings'));
 ok(general.includes(`<p>${de('fleet.config.generalMeta')}</p>`)&&general.includes('sdx-danger-zone')&&/<section class="sdx-health-tab sdx-settings"/.test(general),'General: the description, the cards and the danger zone inside the frame');
 ok(!/aria-pressed/.test(history('jobs')),'the scope History has no Segmented: the views are pill subtabs');
 // The head of both History subtabs: one description line and the console's freshness as plain meta, not in demo mode.
 const {formatClock}=await import('../../../lib/i18n/format.ts');
 const updatedAt=now-5*60_000,meta=`<p class="sdx-section-head-meta">${de('shell.freshness.updated',{time:formatClock('de',updatedAt)})}</p>`;
 const live=(tab,extra={})=>render(h(HistoryPanel,{scoped:servers,servers,viewer:owner,demo:false,saving:false,now,jobs:[],audit:[],onSelectJob:noop,onCancelJob:noop,tab,updatedAt,...extra}));
 for(const [tab,key,name] of [['jobs','history.jobs.description','History › Jobs'],['access','history.access.description','History › Device access']]){
  const html=live(tab);
  ok(html.includes(`<p>${de(key)}</p>`),`${name}: the description`);
  ok(html.includes(meta),`${name}: the freshness as meta`);
  ok(!/<p class="sdx-section-head-meta"[^>]*aria-live/.test(html)&&!/role="status"[^>]*>[^<]*Aktualisiert/.test(html),`${name}: the meta is no second live region`);
  ok(!history(tab).includes('sdx-section-head-meta')&&history(tab).includes(`<p>${de(key)}</p>`),`${name}: demo keeps the description, without the meta`);
  ok(!live(tab,{updatedAt:null}).includes('sdx-section-head-meta'),`${name}: no meta before the first load`);
 }
 const single=render(h(HistoryPanel,{scoped:[servers[0]],servers,viewer:owner,demo:false,saving:false,now,jobs:[],audit:[],onSelectJob:noop,onCancelJob:noop,tab:'jobs',single:true,updatedAt}));
 ok(!single.includes('sdx-section-head')&&!single.includes(de('history.jobs.description')),'the device History renders no head');
 ok(/<HistoryPanel [^\n]*updatedAt=\{updatedAt\}/.test(read('ui/devices/fleet/fleet.tsx'))&&/<FleetView[\s\S]*?updatedAt=\{checkedAt\}/.test(read('ui/shell/console.tsx')),'FleetView passes the console checkedAt to HistoryPanel as updatedAt');
}

// ---- Source checks: one placeholder, no old head classes ----
for(const file of ['alarms','alert-rules','os-support','encryption-tab','drivers-tab','certificates-tab','autostart-tab','problems','software-tab','notification-rules','tags','health-table','reliability-tab']){
 const source=read(uiFile(file+'.tsx'));
 ok(!/'—'|'–'|>–<|>—</.test(source),`${file}.tsx: no dash literal`);
 if(/EMPTY_VALUE/.test(source))ok(/import \{[^}]*EMPTY_VALUE[^}]*\} from '@\/lib\/i18n\/format';/.test(source),`${file}.tsx: EMPTY_VALUE from lib/i18n/format.ts`);
}
for(const file of ['alarms','alert-rules','os-support','encryption-tab','drivers-tab','certificates-tab','autostart-tab','problems','software-tab'])ok(/EMPTY_VALUE/.test(read(uiFile(file+'.tsx'))),`${file}.tsx imports and uses EMPTY_VALUE`);
// ---- One subtab pattern on every scope subtab: AnalysisTab, the kit Toolbar, the table, row menus ----
const subtabFiles=['problems','alarms','software-tab','extensions-tab','drivers-tab','certificates-tab','autostart-tab','os-support','encryption-tab','protection-tab','reliability-tab','alert-rules','notification-rules','tags','permissions-tab'];
for(const file of subtabFiles){
 const source=read(uiFile(file+'.tsx'));
 ok(source.includes('<AnalysisTab'),`${file}.tsx: renders AnalysisTab`);
 ok(!/<table\b/.test(source)&&!source.includes('className="sdx-toolbar"')&&!source.includes('label className="sdx-searchfield"'),`${file}.tsx: no own table, toolbar or search field`);
 ok((source.match(/<Toolbar\b/g)??[]).length<=1,`${file}.tsx: at most one kit Toolbar`);
 // Every primary sits in a drawer footer: its line opens footer={ before it.
 const primaries=[...source.matchAll(/variant="primary"/g)].map(match=>source.slice(source.lastIndexOf('\n',match.index)+1,match.index));
 ok(primaries.every(line=>line.includes('footer={')),`${file}.tsx: a primary only in a drawer footer`);
 ok(!/cell:[^}\n]*<(?:IconBtn|Btn)\b/.test(source),`${file}.tsx: no IconBtn or Btn per row as a row action`);
 for(const [column] of source.matchAll(/\{id:'actions'[^\n]*/g))ok(column.includes('hideLabel:true')&&column.includes("className:'sdx-col-actions'")&&column.includes('<Menu'),`${file}.tsx: the actions column is a row Menu in a hidden-label sdx-col-actions column`);
}
// History as a scope subtab: AnalysisTab on a scope, one kit Toolbar per table, no own table, toolbar or search field, row
// actions only as a row Menu, no Card around a table; the tables are the JobTable and the shared ActivityTable.
for(const file of ['history','job-table','activity-table']){
 const source=read(uiFile(file+'.tsx'));
 ok(!/<table\b/.test(source)&&!source.includes('className="sdx-toolbar"')&&!source.includes('sdx-searchfield'),`${file}.tsx: no own table, toolbar or search field`);
 ok((source.match(/<Toolbar\b/g)??[]).length<=1,`${file}.tsx: at most one kit Toolbar`);
 ok(!/cell:[^}\n]*<(?:IconBtn|Btn)\b/.test(source),`${file}.tsx: no IconBtn or Btn per row as a row action`);
 ok(!/<Card\b[^>]*flush/.test(source),`${file}.tsx: no Card flush around a table`);
 for(const [column] of source.matchAll(/\{id:'actions'[^\n]*/g))ok(column.includes('hideLabel:true')&&column.includes("className:'sdx-col-actions'")&&column.includes('<Menu'),`${file}.tsx: the actions column is a row Menu in a hidden-label sdx-col-actions column`);
}
ok(read('ui/devices/history/history.tsx').includes('<AnalysisTab'),'history.tsx: a scope renders AnalysisTab');
ok(read('ui/devices/history/job-table.tsx').includes("{id:'actions'"),'job-table.tsx: the row Menu column exists');
ok(!read('ui/devices/inventory/reliability-tab.tsx').includes('<Toolbar'),'Reliability has no search, filter or export: no toolbar');
ok(!read('ui/devices/monitoring/alert-rules.tsx').includes('<Toolbar'),'Alert rules has no search, filter or export: no toolbar');

// ---- Alert rules: the shared load states and the table as the direct child of the tab ----
{
 const urls=[];
 const rulesHarness=panelHarness({hooked:['ui/devices/monitoring/alert-rules.tsx'],stubs:{'@/ui/base/api':{api:url=>{urls.push(url);return Promise.reject(new Error('down'));},ApiError:class extends Error{},message:error=>error.message}}});
 const Panel=rulesHarness.load('ui/devices/monitoring/alert-rules.tsx').default,props={scope:{type:'global',id:'*'},scopeName:'Alle Geräte',demo:false,onRefresh:noop,onOpenOrigin:noop};
 rulesHarness.reset();
 const first=rulesHarness.html(Panel,props);
 ok(first.includes(`<div class="sdx-skeleton-set sdx-skeleton-table" role="status" aria-label="${de('alertRules.loading')}">`),'Alert rules: the first load is FirstLoad (the table Skeleton with alertRules.loading)');
 rulesHarness.tree(Panel,props);await rulesHarness.flush();await new Promise(resolve=>setTimeout(resolve,0));await rulesHarness.settle();
 const failed=rulesHarness.html(Panel,props);
 ok(/<div class="sdx-notice sdx-notice-danger"[^>]*>/.test(failed)&&text(failed).includes(de('alertRules.loadFailed'))&&failed.includes('Erneut versuchen')&&!failed.includes('sdx-skeleton'),'Alert rules: a failed load is LoadFailed with "Erneut versuchen"');
 const demoRules=render(h(AlertRulesPanel,{scope:{type:'global',id:'*'},scopeName:'Alle Geräte',demo:true,onRefresh:noop,onOpenOrigin:noop}));
 ok(!demoRules.includes('sdx-card')&&/<\/header><div class="sdx-table-wrap/.test(demoRules),'Alert rules: the table is the direct child of the tab, not inside .sdx-card');
}

for(const file of ['problems','alarms','os-support','encryption-tab','drivers-tab','reliability-tab','certificates-tab','autostart-tab','software-tab','notification-rules','tags','alert-rules','history','extensions-tab','protection-tab']){
 const source=read(uiFile(file+'.tsx'));
 ok(!/<table\b/.test(source)&&!/sdx-health-head|sdx-alarms-head|sdx-notification-rules-head/.test(source)&&!/variant="primary"[^>]*>\{t\('(tags\.add|notificationRules\.add)'\)\}/.test(source),`${file}.tsx: no own table, no old head, no primary add`);
}

// ---- CSS: content-sized pills, the problem chips, the removed heads, tokens and the 4px grid ----
{
 const health=postcss.parse(read('ui/devices/inventory/health-signals.css'));
 const rules=[];health.walkRules(rule=>rules.push(rule));
 ok(rules.some(rule=>rule.selectors.includes('.sdx-cell-stack')&&rule.nodes.some(node=>node.prop==='justify-items'&&node.value==='start')),'.sdx-cell-stack does not stretch its pill');
 ok(!/\.sdx-health-head\b/.test(read('ui/devices/inventory/health-signals.css')),'.sdx-health-head is gone: DHCP, DNS and Extensions use SectionHead (UI-Rework 13b)');
 ok(!read('ui/styles/console.css').includes('.sdx-certificate-table .sdx-cell-stack > .sdx-pill'),'the page-local pill rule is replaced by the shared one');
 const alarmsCss=read('ui/devices/monitoring/alarms.css');
 ok(!/sdx-alarms-head/.test(alarmsCss)&&!/sdx-notification-rules-head/.test(read('ui/settings/notifications-panel.css')),'the old head rules are gone');
 const chip=postcss.parse(alarmsCss);let reason='';chip.walkRules(rule=>{if(rule.selector.startsWith('.sdx-problem-reason'))reason+=rule.toString();});
 ok(!/text-overflow|ellipsis|max-width:\s*240px/.test(reason),'.sdx-problem-reason: no ellipsis, no 240px cut');
 ok(!/sdx-tags-table|sdx-table-note/.test(read('ui/styles/console.css')),'the tag section-row rules are gone');
 // The new CSS of this change: tokens only, spacing on the 4px grid.
 const added=[alarmsCss.slice(alarmsCss.indexOf('/* Health and the Alarms tab')),'.sdx-cell-stack { justify-items: start; }','.sdx-tags { gap: 16px; }','.sdx-notification-rules { gap: 16px; }'].join('\n');
 ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(added),'no new hex or rgba');
 const lengths=[...added.matchAll(/(?:gap|padding|margin|min-height|min-width)[^:]*:\s*([^;]+);/g)].flatMap(match=>[...match[1].matchAll(/(\d+(?:\.\d+)?)px/g)].map(value=>Number(value[1])));
 ok(lengths.length>0&&lengths.every(value=>value%4===0),'new spacing on the 4px grid');
}

console.log(`PASS fleet analysis tabs (${checks} checks): one SectionHead per tab with the sr-only name, DataTables with their sort heads and foot, no primary inside a tab or in Settings, the empty states with their one action, the loading and error states, Notifications in demo, the Tags cards, the group Settings cards and fields, one placeholder and the CSS rules.`);
