// The health signal 2 views rendered with React SSR and the sample devices: the
// problem devices card and the Drivers area with its filters, search and crash
// highlight, the crash issue link, the reliability card, the disk health card and
// drive column, the battery block, the Certificates area, the Autostart area with
// its filter Segmented with counts, columns, details drawer and the blocked confirmation in demo mode, and the four scope tabs
// on All devices, a group and a customer. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {blockedReasons,buttons} from '../../support/blocked-buttons.mjs';
import {panelHarness} from '../../support/panel-harness.mjs';
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {demoData}=await import('../../../ui/shell/demo.ts');
const {default:DeviceDrivers,ProblemDevices,DriversEmpty}=await import('../../../ui/devices/inventory/device-drivers.tsx');
const {default:ReliabilityCard}=await import('../../../ui/devices/diagnostics/reliability-card.tsx');
const {DiskHealthCard,DriveDiskHealth,BatteryBlock}=await import('../../../ui/devices/hardware/disk-health.tsx');
const {default:DeviceCertificates}=await import('../../../ui/devices/inventory/device-certificates.tsx');
const {default:DeviceAutostart}=await import('../../../ui/devices/inventory/device-autostart.tsx');
const {default:DriversTab}=await import('../../../ui/devices/inventory/drivers-tab.tsx');
const {default:ReliabilityTab}=await import('../../../ui/devices/inventory/reliability-tab.tsx');
const {default:CertificatesTab}=await import('../../../ui/devices/inventory/certificates-tab.tsx');
const {default:AutostartTab}=await import('../../../ui/devices/inventory/autostart-tab.tsx');
const {default:StoragePanel}=await import('../../../ui/devices/management/storage-panel.tsx');
const {scopeDevices}=await import('../../../ui/devices/fleet/fleet-scope.ts');
const {issueTarget}=await import('../../../ui/base/ui-device.ts');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
const columns=html=>[...html.matchAll(/<th scope="col"[^>]*>(?:<button[^>]*>)?([^<]+)/g)].map(match=>match[1].trim());
const noop=()=>{};
const {servers}=demoData(),now=Date.now();
const byId=Object.fromEntries(servers.map(server=>[server.id,server]));
const app=byId['demo-app'],dc=byId['demo-dc'],db=byId['demo-db'],file=byId['demo-file'];
const older=server=>({...server,snapshot:{...server.snapshot,driverHealth:undefined,reliability:undefined,diskHealth:undefined,battery:undefined,certificates:undefined,autostartChecksum:undefined},autostart:undefined});
const owner={id:'owner',label:'owner',permissions:['*']};

// ---- Problem devices and the Drivers area ----
let html=render(h(ProblemDevices,{server:app}));
ok(text(html).includes('Problem devices')&&text(html).includes('Code 28: The drivers for this device are not installed.')&&text(html).includes('Code 43: Windows has stopped this device because it has reported problems.'),'problem devices with code texts');
ok(text(render(h(ProblemDevices,{server:dc}))).includes('No problem devices'),'the line when the agent reports none');
check(render(h(ProblemDevices,{server:older(dc)})),'','hidden for an older agent');
html=render(h(DeviceDrivers,{server:app,demo:true,now}));
check(columns(html),['Device','Class','Problem','Device','Driver','File','Version','Date','Provider','Signed'],'the problem devices card, then the driver table');
ok(html.includes('class="sdx-select sdx-select-sm"')&&text(html).includes('All drivers')&&text(html).includes('Older than 10 years'),'the Show select');
ok(html.includes('type="search"')&&/\d+ of \d+ drivers/.test(text(html)),'search and foot');
ok(text(html).includes('vjoy.sys'),'the unsigned vjoy.sys driver of the sample');
// The kit head and the two focusable table regions, problem devices first.
ok(/<h2 class="sr-only">Drivers<\/h2>/.test(html)&&text(html).includes('The drivers of the hardware in Device Manager, with their signature and date.')&&/Last report /.test(text(html)),'SectionHead hideTitle with description and meta');
check((html.match(/>Drivers</g)||[]).length,1,'"Drivers" only as the accessible heading');
ok(html.indexOf('role="region" aria-label="Problem devices" tabindex="0"')>0&&html.indexOf('role="region" aria-label="Problem devices"')<html.indexOf('role="region" aria-label="Drivers" tabindex="0"'),'problem devices first, both tables are focusable regions');
ok(text(html).includes('Installed drivers')&&!html.includes('sdx-loading')&&!/<table class="sdx-table">/.test(html),'the card "Installed drivers", no raw table, no old loader');
ok(!html.includes('class="sdx-pagination"'),'the driver table has no pagination');
html=render(h(DeviceDrivers,{server:app,demo:true,now,focus:{driver:'vjoy.sys',revision:1}}));
const vjoyRows=[...html.matchAll(/<tr(\s[^>]*)?>((?:(?!<\/tr>).)*)<\/tr>/g)].filter(match=>match[2].includes('vjoy.sys'));
ok(/value="vjoy.sys"/.test(html)&&vjoyRows.length>0&&vjoyRows.every(match=>/sdx-row-highlight/.test(match[1]??"")&&/data-row-key="/.test(match[1])),'the crash link sets the search and highlights every matching row');
check((html.match(/<tr[^>]*tabindex="-1"/g)||[]).length,1,'only the first match is the focus target');
ok(!html.includes('aria-current'),'no aria-current on rows');
html=render(h(DeviceDrivers,{server:app,demo:true,now,focus:{driver:'missing.sys',revision:1}}));
ok(text(html).includes('No driver on this device uses the file missing.sys.'),'no match: notice');
// Outside demo mode the list loads from GET /api/drivers/device: a skeleton first. An older agent then gets the hint (state null, no driverHealth).
ok(/role="status" aria-label="Loading the drivers"/.test(render(h(DeviceDrivers,{server:older(app),demo:false,now}))),'outside demo mode: the kit Skeleton while the list loads');
// Agent 4.11.1: a failed driver read (collectorErrors) without and with a stored list, and the empty texts by agent version.
const driversError=(server,code='timeout')=>({...server,snapshot:{...server.snapshot,collectorErrors:[{collector:'drivers',code,since:'2026-11-01T16:13:25.000Z',lastAt:'2026-11-03T16:13:25.000Z',failures:80,elapsedMs:15012}]}});
html=text(render(h(DriversEmpty,{server:driversError(older(app))})));
ok(html.includes('The driver list is not available')&&html.includes('Windows did not return the driver list in time. The agent tries again in 15 minutes.')&&/Reading the drivers has failed since .*2026/.test(html)&&!html.includes('No drivers reported yet'),'error and no stored list: not available, the timeout reason and failed since');
ok(text(render(h(DriversEmpty,{server:driversError(older(app),'broker-unavailable')}))).includes('Restart the ServerDesk Agent service on the device.'),'the broker-unavailable reason');
ok(text(render(h(DriversEmpty,{server:driversError(older(app),'access-denied')}),'de')).includes('Die Treiberliste ist nicht verfügbar'),'German title');
html=render(h(DeviceDrivers,{server:driversError(app),demo:true,now}));
ok(/sdx-notice-warning/.test(html)&&text(html).includes('The last driver read on this device failed. The list shows the state of')&&text(html).includes('Windows did not return the driver list in time.'),'error and a stored list: the warning notice with the time and the reason');
ok(html.includes('<table class="sdx-table sdx-data-table">')&&html.includes('type="search"')&&text(html).includes('vjoy.sys'),'the table, search and filters stay usable');
ok(!text(render(h(DeviceDrivers,{server:app,demo:true,now}))).includes('The last driver read on this device failed.'),'no error: no notice');
ok(!text(render(h(DeviceDrivers,{server:{...app,lastSeen:now-86400000},demo:true,now}))).includes('The device is offline'),'offline: no own offline notice');
const withVersion=(server,agentVersion)=>({...older(server),snapshot:{...older(server).snapshot,agentVersion}});
ok(text(render(h(DriversEmpty,{server:withVersion(app,'4.11.0')}))).includes('The agent has not reported a driver list yet. If this does not change, update the agent to 4.11.1 or later.'),'a 4.11.0 agent without driverHealth and without an error');
html=text(render(h(DriversEmpty,{server:withVersion(app,'4.10.1')})));
ok(html.includes('This device does not report its drivers yet. Update the agent to 4.11.0 or later.')&&!html.includes('4.11.1'),'a 4.10 agent keeps drivers.notReported');
check(text(render(h(DriversEmpty,{server:app}))),'No drivers reported yet','driverHealth without a stored list: only the title');
const crashIssue=app.issues.find(issue=>issue.ruleId==='crash-recent');
check(issueTarget(crashIssue,app),{section:'software',software:'drivers',driver:'vjoy.sys'},'the crash issue links to the driver inventory');

// ---- Reliability card ----
html=render(h(ReliabilityCard,{server:app,now}));
ok(text(html).includes('Reliability')&&text(html).includes('Stability index'),'title and index');
ok(/role="img" aria-label="Stability index of the last 30 days, currently 3.8 of 10"/.test(html),'the chart names the current value');
ok(text(html).includes('Program crashes')&&/outlook.exe: 5 crashes in 7 days/i.test(text(html)),'the program summary (most frequent spelling)');
html=render(h(ReliabilityCard,{server:dc,now}));
ok(text(html).includes('Not available')&&text(html).includes('Windows does not collect reliability data on this device. On Windows Server this is off by default.'),'not available with the reason');
ok(text(render(h(ReliabilityCard,{server:older(app),now}))).includes('This device does not report reliability data yet. Update the agent to 4.11.0 or later.'),'older agent');
ok(text(render(h(ReliabilityCard,{server:app,now}),'de')).includes('Zuverlässigkeit'),'German title');

// ---- Disk health, drive column and battery ----
html=render(h(DiskHealthCard,{server:app}));
check(columns(html),['Disk','Drives','Media','Reported state','Wear','Temperature','Errors (30 days)','Power-on hours'],'disk health columns: the state column is named Reported state');
ok(text(html).includes('86%')&&text(html).includes('—')&&!text(html).includes('Not available'),'the worn SSD and the USB disk without counters: a dash, not "Not available"');
ok(text(html).includes('— means the disk does not report this value, for example a USB drive.'),'one foot line explains the dash');
ok(!/sdx-tone-warning[^>]*>—|warning[^>]*>\s*—/.test(html),'missing values are muted, never a warning');
ok(text(render(h(DiskHealthCard,{server:db}))).includes('3'),'disk errors from counts');
// An error count above 0 is a small warning pill with the number; 0 is plain text; a missing count stays a dash.
{const markup=render(h(DiskHealthCard,{server:db}));ok(/<span class="sdx-pill sdx-pill-warning sdx-pill-sm"><i aria-hidden="true"><\/i>3<\/span>/.test(markup),'errors above 0: a warning StatusPill sm');}
ok(!/sdx-pill-warning sdx-pill-sm"><i aria-hidden="true"><\/i>0</.test(html),'0 errors: no pill');
ok(text(render(h(DiskHealthCard,{server:older(app)}))).includes('This device does not report disk health yet. Update the agent to 4.11.0 or later.'),'older agent');
ok(text(render(h(DriveDiskHealth,{server:app,drive:'C:'}))).length>0,'the drive column of a reported drive');
html=render(h(StoragePanel,{server:app,viewer:owner,demo:true,saving:false,onConfirm:noop}));
ok(text(html).includes('Disk health'),'the Storage area shows the disk health card and column');
html=render(h(BatteryBlock,{server:file}));
ok(text(html).includes('Battery')&&text(html).includes('54%')&&/charge cycle/.test(text(html)),'battery with health and cycles');
ok(text(render(h(BatteryBlock,{server:app}))).includes('No battery'),'no battery');

// ---- Certificates area ----
html=render(h(DeviceCertificates,{server:app,now}));
check(columns(html),['Subject','Issuer','Store','Valid from','Expires','Private key','Bound to','Thumbprint'],'certificate columns');
const pills=[...text(html.slice(html.indexOf('<tbody'))).matchAll(/(Expired|Expires in \d+ days?|Valid)/g)].map(match=>match[1]);
check(pills.slice(0,4),['Expired','Expired','Expires in 3 days','Expires in 12 days'],'sorted by expiry with status pills');
ok(text(html).includes('HTTPS 0.0.0.0:443')&&text(html).includes('Remote Desktop'),'bindings');
ok(/<h2 class="sr-only">Certificates<\/h2>/.test(html)&&text(html).includes('Machine certificates')&&(html.match(/>Certificates</g)||[]).length===1,'Certificates: SectionHead hideTitle, no visible duplicate title');
ok(text(render(h(DeviceCertificates,{server:{snapshot:{...app.snapshot,certificates:{collectedAt:new Date(now).toISOString(),items:[],truncated:false}}},now}))).includes('This computer has no certificates for websites, services or Remote Desktop'),'empty');

// ---- Autostart area ----
html=render(h(DeviceAutostart,{server:app,viewer:owner,demo:true,now}));
ok(/<h2 class="sr-only">Autostart<\/h2>/.test(html)&&text(html).includes('Programs that start automatically')&&/Last report /.test(text(html)),'SectionHead hideTitle with description and meta');
check((html.match(/>Autostart</g)||[]).length,1,'"Autostart" only as the accessible heading');
ok(!html.includes('sdx-kpi'),'no KPI row: the filter carries the counts');
const filterGroup=html.match(/<div class="sdx-segmented sdx-segmented-sm" role="group" aria-label="Autostart">([\s\S]*?)<\/div>/)?.[1]??'';
const segments=[...filterGroup.matchAll(/<button type="button" aria-pressed="(true|false)"[^>]*><span>([^<]+)<\/span><b(?: class="([^"]+)")?>(\d+)<\/b><\/button>/g)].map(match=>({label:match[2],count:Number(match[4]),tone:match[3]??null,pressed:match[1]}));
check(segments.map(item=>[item.label,item.pressed]),[['All','true'],['New','false'],['Suspicious','false']],'All, New and Suspicious as a small Segmented; All pressed first');
check(segments[0],{label:'All',count:6,tone:null,pressed:'true'},'All with its count and no tone');
ok(segments[1].tone===(segments[1].count>0?'sdx-count-warning':null)&&segments[2].tone===(segments[2].count>0?'sdx-count-critical':null),'New warns and Suspicious is critical, each only above 0');
ok(html.indexOf('aria-label="Autostart">')<html.indexOf('<table'),'the filter sits above the list');
check(columns(html).filter(label=>label),['Entry','Type','Program','Signature','Status'],'the select column, then exactly Entry, Type, Program, Signature and Status');
ok(/<th scope="col" class="sdx-col-check"><label class="sdx-check-hit"><input type="checkbox" aria-label="Select new entries to confirm them"/.test(html),'the DataTable selection head checkbox names what it selects');
// UI-Rework 13b: the filter sits in the list's own Toolbar inside the card; only new entries carry a checkbox; the kit BulkBar confirms.
ok(/<section class="sdx-card sdx-card-flush sdx-health-card"[^>]*>[\s\S]*?<div class="sdx-toolbar"><div class="sdx-toolbar-filters"><div class="sdx-segmented sdx-segmented-sm" role="group" aria-label="Autostart">/.test(html),'the filter Segmented is in the Toolbar inside the list card');
check((html.match(/<td class="sdx-col-check"><label/g)||[]).length,segments[1].count,'only new entries have a checkbox');
{const source=(await import('node:fs')).readFileSync('ui/devices/inventory/device-autostart.tsx','utf8');ok(/<BulkBar count=\{chosen\.length\}/.test(source)&&!/className="sdx-bulkbar"|className="sdx-toolbar"|className:'sdx-col-check'/.test(source),'the kit BulkBar with Confirm; no hand bulk bar, toolbar div or select column');}
ok(text(html).includes('Known since first report')&&/New since/.test(text(html)),'status texts');
ok(!/Confirmed [^<]* by /.test(html.slice(html.indexOf('<tbody'))),'the table status has no actor');
const confirmAll=buttons(html).find(button=>button.inner.includes('Confirm all as known'));
ok(confirmAll&&!/sdx-btn-primary/.test(confirmAll.attributes)&&confirmAll.blocked&&confirmAll.description==='Not available for sample devices.','"Confirm all as known" is secondary and blocked with the demo sentence');
ok(blockedReasons(html).every(reason=>reason!=='Not available for sample devices'),'no reason without its period');
ok(text(html).includes('Not available for sample devices. You can still read the autostart entries.'),'demo: the one panel notice');
const program=html.match(/<td class="sdx-path-cell">((?:(?!<\/td>).)*)<\/td>/)?.[1]??'';
ok(program.includes('<wbr/>')&&program.includes('class="mono sdx-path"'),'the Program cell breaks with <wbr> between path parts');
ok(!html.includes('sdx-wrap-cell')&&!html.includes('sdx-cell-wrap">C:'),'no anywhere-wrapping path cells');
ok(/role="region" aria-label="Autostart entries" tabindex="0"/.test(html),'the table is a labelled, focusable region');
html=render(h(DeviceAutostart,{server:{...app,lastSeen:now-86400000},viewer:owner,demo:true,now}));
ok(!text(html).includes('The device is offline'),'offline: no own offline notice');
html=render(h(DeviceAutostart,{server:older(app),viewer:{id:'reader',label:'reader',permissions:[]},demo:false,now}));
ok(/role="status" aria-label="Loading the autostart entries"/.test(html)&&text(html).includes('You can still read the autostart entries.'),'without the right: the panel notice; first load: the kit Skeleton');
// ---- Outside demo mode, on hook cells: a failed GET shows "Try again", which repeats it; Autostart opens the details drawer ----
{
 const {demoDriverView,demoAutostartView}=await import('../../../ui/shell/demo.ts');
 const requests=[];let fail=true;
 const answer=url=>{requests.push(url);if(fail)return Promise.reject(new Error('down'));return Promise.resolve(url.startsWith('/api/drivers')?demoDriverView('demo-app',now):demoAutostartView('demo-app',now));};
 // The real release manifest is an ES module the harness does not transpile; the drivers panel only needs its version compare.
 const {compareAgentVersions}=await import('../../../lib/agent-update-state.ts');
 const stubs={'@/ui/base/api':{api:answer,message:()=>'The request failed.',ApiError:class extends Error{},permitted:()=>true},'@/lib/agent-update-state':{compareAgentVersions}};
 for(const [file,label,props] of [['ui/devices/inventory/device-drivers.tsx','The driver inventory could not be loaded. Try again.',{server:app,demo:false,now}],['ui/devices/inventory/device-autostart.tsx','The autostart entries could not be loaded. Try again.',{server:app,viewer:owner,demo:false,now}]]){
  const harness=panelHarness({hooked:[file],locale:'en',stubs});
  const Panel=harness.load(file).default;
  requests.length=0;fail=true;harness.reset();harness.tree(Panel,props);await harness.flush();
  let tree=harness.tree(Panel,props),markup=harness.html(Panel,props);
  ok(markup.includes('sdx-notice-danger')&&text(markup).includes(label),`${file}: a failed GET shows the danger notice`);
  ok(!text(markup).includes('The device is offline'),`${file}: no own offline notice`);
  const retry=harness.button(tree,'Try again');
  ok(!!retry,`${file}: with "Try again"`);
  fail=false;retry.props.onClick();harness.tree(Panel,props);await harness.flush();
  check(requests.length,2,`${file}: "Try again" repeats the request`);
  check(requests[1],requests[0],`${file}: the same GET`);
  tree=harness.tree(Panel,props);markup=harness.html(Panel,props);
  ok(!markup.includes('sdx-notice-danger')&&/role="region"/.test(markup),`${file}: the list after the retry`);
  if(file.endsWith('device-autostart.tsx')){
   const table=harness.table(tree,'Autostart entries');
   const entry=table.props.rows.find(item=>item.command&&item.location);
   table.props.onOpen(entry);markup=harness.html(Panel,props);
   ok(markup.includes('role="dialog"')&&text(markup).includes('Location')&&text(markup).includes('Command')&&text(markup).includes('First seen'),'Autostart: onOpen opens the details drawer with Location, Command and First seen');
   ok((markup.match(/class="mono sdx-path"/g)||[]).length>=3,'Autostart: the drawer paths wrap through pathBreakParts');
   check(table.props.openLabel(entry),`Show details of ${entry.name}`,'Autostart: the open button names the entry');
  }
 }
 // Demo: the bulk bar keeps its actions and the demo sentence.
 const harness=panelHarness({hooked:['ui/devices/inventory/device-autostart.tsx'],locale:'en',stubs});
 const Panel=harness.load('ui/devices/inventory/device-autostart.tsx').default,props={server:app,viewer:owner,demo:true,now};
 harness.reset();let tree=harness.tree(Panel,props);
 const fresh=harness.table(tree,'Autostart entries').props.rows.find(item=>item.isNew);
 harness.reset({1:[fresh.id]});tree=harness.tree(Panel,props);const markup=harness.html(Panel,props);
 ok(markup.includes('sdx-bulkbar')&&text(markup).includes('1 selected')&&text(markup).includes('Confirm as known'),'the kit BulkBar ("1 selected") with "Confirm as known"');
 const bulk=buttons(markup).find(button=>button.inner.includes('Confirm as known')&&!button.inner.includes('all'));
 ok(bulk?.blocked&&bulk.description==='Not available for sample devices.','"Confirm as known" is blocked with the demo sentence');
}

// ---- The four scope tabs on all, a group and a customer ----
const scoped={all:servers,group:scopeDevices(servers,{type:'group',id:'none'}),customer:servers.slice(0,2)};
for(const [type,devices] of Object.entries(scoped)){
 const scope=type==='all'?{type:'all'}:type==='group'?{type:'group',id:'none'}:{type:'customer',id:'c1'};
 ok(render(h(DriversTab,{scope,devices,demo:true,onOpen:noop})).includes('type="search"'),`${type}: drivers tab with search`);
 ok(text(render(h(ReliabilityTab,{devices,now,onOpen:noop}))).includes('Program'),`${type}: reliability tab`);
 ok(text(render(h(CertificatesTab,{devices,now,onOpen:noop}))).includes('Only with private key'),`${type}: certificates tab`);
 ok(text(render(h(AutostartTab,{scope,devices,demo:true,now,onOpen:noop}))).includes('Entries on few devices come first.'),`${type}: autostart tab`);
}
html=render(h(ReliabilityTab,{devices:servers,now,onOpen:noop}));
ok(text(html).includes('1 device with stability below 5')&&text(html).includes('1 device without stability data'),'reliability head line');
html=render(h(CertificatesTab,{devices:servers,now,onOpen:noop}));
ok(/<input type="checkbox" role="switch" checked=""/.test(html),'the private-key switch is on by default');
html=render(h(DriversTab,{scope:{type:'all'},devices:servers,demo:true,onOpen:noop}));
check(columns(html).slice(0,6),['Driver','Version','Provider','Date','Signed','Devices'],'drivers tab columns');

console.log(`PASS health signals 2 view (${checks} checks): problem devices, Drivers area with filter, search and crash highlight, reliability card, disk health card and drive column, battery block, Certificates area, Autostart area blocked in demo, and the four scope tabs on all scopes.`);
