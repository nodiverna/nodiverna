// The Dashboard page (ui/devices/dashboard/dashboard-view.tsx with its widgets, widget parts, heatmap and illustrations;
// docs/dashboard.md), rendered: a widget at each size (the lead alone at 1 x 1, the list beside it in a wide single
// row, 4, 8, 6 and 10 rows by height and width, the "more" line, the head action from two columns); every widget
// filled (lead number, detail, breakdown bar with its name and legend, rows with their links) and empty (roomy: the
// illustration, the fact, one sentence and one action; in a single row: the number 0 with the fact); the two alarm
// week widgets loading, failed with a retry, failed over older counts, empty and filled; the status line for each
// headline; the grid (the widgets of the layout in order, each cell with its size, no wider than the columns);
// widgets a viewer cannot use; the page empty states; the header actions; sample devices; the German render; the
// illustrations; the kit Empty variant "art"; and the rules of dashboard-view.css.
import {mock} from '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const toasts=[];
mock('sonner',{toast:{success:text=>toasts.push(text),error:text=>toasts.push('error:'+text),info:text=>toasts.push('info:'+text)},Toaster:()=>null});
const h=React.createElement;
const {default:DashboardView}=await import('../../../ui/devices/dashboard/dashboard-view.tsx');
const widgets=await import('../../../ui/devices/dashboard/dashboard-widgets.tsx');
const {dashboardLinks}=widgets;
const {dashboardWidgetMeta,dashboardWidgetGroups,dashboardGroupLabels,Breakdown,DayBars}=await import('../../../ui/devices/dashboard/dashboard-widget-parts.tsx');
const {DashboardArt}=await import('../../../ui/devices/dashboard/dashboard-art.tsx');
const {alarmWeekStart,demoAlarmWeek,alarmWeekGrid}=await import('../../../ui/devices/dashboard/dashboard-model.ts');
const {weekBusiestText,weekCellText}=await import('../../../ui/devices/dashboard/dashboard-heatmap.tsx');
const {builtInDashboardLayout,dashboardWidgetIds,dashboardWidgetSizes}=await import('../../../lib/dashboard-layout.ts');
const {Empty,claimEntrance}=await import('../../../ui/kit/kit.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
const {Siren}=await import('lucide-react');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const count=(html,part)=>html.split(part).length-1;
const links=html=>[...html.matchAll(/<a class="sdx-dash-row" href="([^"]+)"/g)].map(match=>match[1]);
const number=html=>/class="sdx-dash-number[^"]*"><span class="sdx-count"><span aria-hidden="true">([^<]+)</.exec(html)?.[1];
const pills=html=>[...html.matchAll(/<span class="sdx-pill sdx-pill-(\w+) sdx-pill-sm"[^>]*>(?:<i[^>]*><\/i>)?([^<]+)</g)].map(match=>[match[1],match[2]]);
const barName=html=>/class="sdx-dash-break-bar" role="img" aria-label="([^"]+)"/.exec(html)?.[1];

const minute=60_000,hour=3_600_000,day=24*hour,now=Date.now();
let alertId=0;
const alert=(level,startedAt=now-hour,ruleId='device-offline')=>({id:'a'+(++alertId),ruleId,key:'',level,peakLevel:level,peakValue:null,threshold:null,params:{},startedAt,openedAt:startedAt,acknowledged:null,muted:null});
const snapshot=(extra={})=>({os:'Microsoft Windows Server 2022',security:{domainRole:3},...extra});
const device=(name,extra={})=>({id:name.toLowerCase(),name,createdAt:0,lastSeen:now-30_000,revoked:0,management:1,snapshot:snapshot(),...extra});
const viewer={id:'u1',label:'Anna',permissions:['view']};
const size=(w,h)=>({size:{w,h},onNavigate(){}});
const widget=(name,props,at=size(2,2),locale='en')=>render(h(widgets[name],{...props,...at}),locale);

// ---- one widget at each size: Open alarms ----
const fleet=[
 device('DB01',{alerts:[alert('critical',now-2*hour),alert('warning',now-26*hour)],snapshot:snapshot({updates:{checkedAt:'',pendingCount:12,items:[]},rebootPending:true})}),
 device('WEB02',{lastSeen:now-3*hour,alerts:[alert('info',now-5*minute)],snapshot:snapshot({updates:{checkedAt:'',pendingCount:1,items:[]},rebootPending:false})}),
 device('FS03',{lastSeen:now-50*hour}),
 device('APP04'),
];
let html=widget('AlarmsWidget',{servers:fleet});
ok(/<section class="sdx-card sdx-dash-widget" aria-labelledby="dashboard-widget-alarms">/.test(html)&&/<h2 id="dashboard-widget-alarms"[^>]*>.*Open alarms<\/h2>/.test(html),'the Open alarms card is a labelled section with its title');
ok(/sdx-icon-tile-danger/.test(html)&&/class="sdx-dash-number sdx-dash-number-danger"><span class="sdx-count"><span aria-hidden="true">3<\/span><span class="sr-only">3<\/span>/.test(html),'the lead number 3 in the danger tone, with the screen reader value');
check(pills(html),[['critical','Critical · 1'],['warning','Warning · 1'],['neutral','Info · 1']],'one pill per level that has alarms');
check(links(html),['#device/db01/monitoring','#device/db01/monitoring','#device/web02/monitoring'],'each row links to the Monitoring area of its device, critical first');
ok(/<span class="sdx-dash-level sdx-dash-level-critical"><svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg><span class="sr-only">Critical<\/span><\/span>/.test(html),'the level shows as an icon with its name for screen readers');
ok(text(html).includes('DB01')&&text(html).includes('Open for 2 h 0 min')&&text(html).includes('Open for 1 d 2 h')&&text(html).includes('Show alarms'),'device, time since the start and the head action');
ok(!html.includes('sdx-dash-art')&&!html.includes('sdx-dash-more')&&!/ inert/.test(html),'a filled widget has no illustration, no "more" line while every row fits, and its content is live');

const many=[device('BIG',{alerts:Array.from({length:12},(_,index)=>alert(index<2?'critical':'warning',now-(index+1)*hour))})];
const rowsAt=(w,h)=>{const out=widget('AlarmsWidget',{servers:many},size(w,h));return [count(out,'<a class="sdx-dash-row"'),/class="sdx-dash-more"><a href="#devices\/monitoring\/list">(\d+) more<\/a>/.exec(out)?.[1]??null,/sdx-dash-body-split/.test(out),text(out).includes('Show alarms')];};
check([rowsAt(1,1),rowsAt(2,1),rowsAt(4,1)],[[0,null,false,false],[2,null,true,true],[2,null,true,true]],'one row high: the lead alone at 1 x 1; from two columns two rows beside it and the head action; no "more" line');
check([rowsAt(1,2),rowsAt(2,2),rowsAt(1,3),rowsAt(2,3)],[[4,'8',false,false],[4,'8',false,true],[8,'4',false,false],[8,'4',false,true]],'two and three rows high: 4 and 8 rows, and a link "{count} more" to the place that shows all');
check([rowsAt(3,2),rowsAt(4,2),rowsAt(3,3),rowsAt(4,3)],[[6,'6',true,true],[6,'6',true,true],[10,'2',true,true],[10,'2',true,true]],'from three columns the list has its own column: 6 and 10 rows');
html=widget('AlarmsWidget',{servers:many},size(1,1));
ok(number(html)==='12'&&pills(html).length===2&&!html.includes('sdx-dash-main')&&!html.includes('sdx-dash-list'),'1 x 1: the number and its detail, no list');
html=widget('AlarmsWidget',{servers:many,edit:h('span',{className:'test-controls'},'controls')},size(2,2));
ok(/<div class="sdx-section-head-actions sdx-card-actions"><span class="test-controls">controls<\/span><\/div>/.test(html)&&!text(html).includes('Show alarms')&&/<div class="sdx-dash-body" inert="">/.test(html),'edit mode: the edit controls stand in place of the head action and the content is inert');

// ---- the first widgets, filled and empty ----
html=widget('OfflineWidget',{servers:fleet},size(1,2));
ok(/sdx-icon-tile-warning/.test(html)&&number(html)==='2'&&text(html).includes('of 4 devices'),'two offline of four devices');
check(links(html),['#device/fs03','#device/web02'],'the longest offline first; a row opens the device');
ok(text(html).includes('Offline for 2 d 2 h')&&text(html).includes('Offline for 3 h 0 min')&&count(html,'class="sdx-platform sdx-platform-sm"')===2&&!text(html).includes('Show devices'),'the duration and the device type mark; one column has no head action');
html=widget('UpdatesWidget',{servers:fleet},size(1,2));
ok(number(html)==='13'&&text(html).includes('on 2 devices'),'13 pending updates on two devices');
check(links(html),['#device/db01/management/updates','#device/web02/management/updates'],'a row opens Management › Updates, the most pending first');
ok(text(html).includes('12 updates')&&text(html).includes('1 update')&&!text(html).includes('1 updates')&&count(html,'Restart required')===1,'the plural and the restart pill');
const job=(id,state,extra={})=>({id,serverId:'db01',action:'restart-service',target:'Spooler',state,createdAt:now-10*minute,claimedAt:now-9*minute,result:null,actor:'Anna',...extra});
const jobs=[job('j1','succeeded'),job('j2','running'),job('j3','pending',{claimedAt:null}),job('j4','failed',{lastProgress:now-5*minute}),job('j5','succeeded'),job('j6','succeeded'),job('j7','succeeded')];
const jobProps={jobs,servers:fleet,viewer,demo:false,saving:false,onSelectJob(){},onCancelJob(){}};
html=widget('JobsWidget',jobProps);
ok(number(html)==='2'&&text(html).includes('1 running')&&text(html).includes('1 waiting')&&text(html).includes('Show all jobs'),'two active jobs: one running, one waiting; the head action');
check([count(html,'class="sdx-job-row"'),html.indexOf('sdx-job-accent')<html.indexOf('sdx-job-success')],[4,true],'four rows of the dock list, the active jobs first');
check([[1,1],[1,2],[1,3],[2,3],[4,2]].map(([w,hh])=>count(widget('JobsWidget',jobProps,size(w,hh)),'class="sdx-job-row"')),[0,3,6,7,6],'the job rows follow the size; a single column stacks the state above the text, so fewer fit');

const quiet=[device('APP04')];
const empty=(out,art)=>[/<section class="sdx-card sdx-dash-widget"/.test(out),new RegExp(`<svg class="sdx-dash-art"[^>]*data-art="${art}"`).test(out),/class="sdx-dash-body sdx-dash-body-empty"[^>]*><div class="sdx-empty sdx-empty-with-art"/.test(out),count(out,'<button'),number(out)===undefined];
html=widget('AlarmsWidget',{servers:quiet});
check([empty(html,'alarms'),text(html)],[[true,true,true,1,true],'Open alarms No open alarms The alert rules watch your devices and open an alarm when a limit is passed. Show alert rules'],'Open alarms, empty and roomy: illustration, fact, one sentence, one action');
html=widget('AlarmsWidget',{servers:quiet},size(2,1));
check([number(html),text(html),html.includes('sdx-dash-art'),count(html,'<button')],['0','Open alarms 0 0 No open alarms',false,0],'Open alarms, empty in a single row: the number 0 with the fact');
html=widget('OfflineWidget',{servers:quiet});
check([empty(html,'offline'),text(html)],[[true,true,true,1,true],'Offline devices All devices are online No device missed its heartbeat. Show devices'],'Offline devices, empty');
html=widget('UpdatesWidget',{servers:quiet});
check([empty(html,'updates'),text(html)],[[true,true,true,1,true],'Updates due No updates due No device reports pending Windows updates. Show devices'],'Updates due, empty');
html=widget('JobsWidget',{...jobProps,jobs:[]});
check([empty(html,'jobs'),text(html)],[[true,true,true,1,true],'Recent jobs No jobs yet Jobs that you start on a device show here. Show devices'],'Recent jobs, empty');
check([dashboardLinks.devices,dashboardLinks.problems,dashboardLinks.alarms,dashboardLinks.alertRules,dashboardLinks.jobs,dashboardLinks.osSupport,dashboardLinks.protection,dashboardLinks.encryption,dashboardLinks.certificates,dashboardLinks.autostart,dashboardLinks.reliability,dashboardLinks.audit,dashboardLinks.customer('k1')],
 ['#devices','#devices/monitoring','#devices/monitoring/list','#devices/monitoring/alert-rules','#devices/history','#devices/inventory/os-support','#devices/inventory/defender','#devices/inventory/encryption','#devices/inventory/certificates','#devices/inventory/autostart','#devices/inventory/reliability','#settings/audit','#devices/customer/k1'],'the console places the widgets open');

// ---- the new widgets ----
// Device health: the breakdown bar with its name and legend, the worst devices first.
html=widget('HealthWidget',{servers:fleet},size(1,2));
check([number(html),barName(html),links(html)],['1','Device health. Critical: 1, Good: 3',['#device/db01/monitoring']],'Device health: one device needs attention; the bar is one image whose name holds every part');
ok(text(html).includes('device needs attention')&&/class="sdx-dash-break-legend" aria-hidden="true"><li><i data-tone="critical"><\/i>Critical<b>1<\/b><\/li><li><i data-tone="ok"><\/i>Good<b>3<\/b><\/li>/.test(html)&&/<i data-tone="critical" title="Critical: 1" style="flex-grow:1"><\/i><i data-tone="ok" title="Good: 3" style="flex-grow:3"><\/i>/.test(html),'the legend names the parts in words; a part without a device has no segment');
ok(text(html).includes('Device offline (+1)')&&pills(html).some(([kind,label])=>kind==='critical'&&label==='Critical'),'a row names its first alarm, how many more it has, and its level');
html=widget('HealthWidget',{servers:fleet},size(1,1));
ok(number(html)==='1'&&barName(html)&&!html.includes('sdx-dash-break-legend')&&!html.includes('sdx-dash-list'),'1 x 1: the number and the bar; the legend comes with a larger size');
html=widget('HealthWidget',{servers:quiet});
ok(empty(html,'devices')[2]&&text(html).includes('Every device is healthy No device has a warning or critical alarm. Show devices'),'Device health, empty');
// Device status.
html=widget('StatusWidget',{servers:fleet},size(2,1));
check([number(html),barName(html),text(html).includes('of 4 devices online')],['2','Device status. Online: 2, Offline: 2',true],'Device status: online of all devices, and every device by its connection');
// Pinned devices.
html=widget('PinnedWidget',{servers:fleet,pinnedIds:['fs03','db01','gone']},size(1,2));
check([number(html),links(html),pills(html)],['2',['#device/fs03','#device/db01'],[['offline','Offline'],['online','Online']]],'Pinned devices: the pins in pin order with their connection');
html=widget('PinnedWidget',{servers:fleet,pinnedIds:[]});
ok(empty(html,'pinned')[1]&&text(html).includes('No pinned devices Pin a device in the device list to keep it here. Show devices'),'Pinned devices, empty');
// Customers.
const customers=[{id:'k1',name:'Kiwi'},{id:'k2',name:'Apple'}];
html=widget('CustomersWidget',{servers:[device('A',{customerId:'k1',alerts:[alert('critical')]}),device('B',{customerId:'k1',lastSeen:now-hour}),device('C',{customerId:'k2'})],customers});
check([number(html),links(html),pills(html)],['2',['#devices/customer/k1','#devices/customer/k2'],[['critical','1 alarm'],['offline','1 offline']]],'Customers: the customer with open alarms first, with its alarm and offline pills; a row opens the customer');
ok(text(html).includes('Kiwi 2 devices')&&text(html).includes('Apple 1 device'),'each customer with its device count');
// Highest load.
const loadFleet=[device('HOT',{snapshot:snapshot({cpu:97,memory:50})}),device('CALM',{snapshot:snapshot({cpu:12,memory:40})}),device('AWAY',{lastSeen:now-hour,snapshot:snapshot({cpu:99,memory:99})})];
html=widget('LoadWidget',{servers:loadFleet},size(1,2));
check([number(html),links(html),[...html.matchAll(/role="meter" aria-label="([^"]+)"[^>]*aria-valuenow="(\d+)"/g)].map(match=>[match[1],match[2]])],['1',['#device/hot','#device/calm'],[['Load of HOT','97'],['Load of CALM','40']]],'Highest load: the online devices, the highest first, each with a meter of the higher value');
ok(text(html).includes('at 90 % load or more')&&/CPU 97\s?% · RAM 50\s?%/.test(text(html))&&/sdx-meter-critical/.test(html),'the detail, both values and the critical meter');
html=widget('LoadWidget',{servers:[loadFleet[2]]});
ok(text(html).includes('No live values CPU and RAM load show here while a device is online.'),'Highest load, empty: no device is online');
// Disk space.
const disk=(name,totalGb,freeGb)=>({name,label:'',totalGb,freeGb});
html=widget('DiskSpaceWidget',{servers:[device('SQL',{snapshot:snapshot({disks:[disk('C:',100,50),disk('D:',512,42)]})}),device('WEB',{snapshot:snapshot({disks:[disk('C:',128,68)]})})]},size(1,2));
check([number(html),links(html)],['1',['#device/sql/management/storage','#device/sql/management/storage','#device/web/management/storage']],'Disk space: one drive is at least 90 % full; the fullest first; a row opens Management › Disks');
ok(text(html).includes('drive is at least 90 % full')&&/D: · 42 GiB free of 512 GiB/.test(text(html))&&/role="meter" aria-label="Used space of D: on SQL"[^>]*aria-valuenow="92"/.test(html),'the free and total size in IEC units and the meter of the used share');
ok(text(widget('DiskSpaceWidget',{servers:quiet})).includes('No drives reported'),'Disk space, empty');
// Restart required.
html=widget('RestartWidget',{servers:[...fleet,device('ZED',{snapshot:snapshot({rebootPending:true,rebootReasons:['windows-update']})})]},size(1,2));
check([number(html),links(html)],['2',['#device/db01','#device/zed']],'Restart required: the devices that wait for a restart, by name');
ok(text(html).includes('devices wait for a restart')&&text(html).includes(translate('en','device.reboot.windowsUpdate'))&&text(html).includes(translate('en','device.issue.rebootDetail')),'the reason of the restart, or the general sentence without one');
check([number(widget('RestartWidget',{servers:quiet},size(1,1))),text(widget('RestartWidget',{servers:quiet},size(1,1)))],['0','Restart required 0 0 No restart required'],'Restart required, empty at 1 x 1');
// Operating system support.
const support=(status,effectiveEnd,daysLeft)=>({status,effectiveEnd,daysLeft,entry:{id:'x',product:'Windows',version:'x',channel:'server',generalEnd:effectiveEnd,securityEnd:effectiveEnd,source:''}});
const osFleet=[device('OLD',{osSupport:support('ended','2020-01-14')}),device('SOON',{osSupport:support('ending','2027-01-12',40)}),device('OK',{osSupport:support('supported','2031-10-14')}),device('WHAT')];
html=widget('OsSupportWidget',{servers:osFleet});
check([number(html),barName(html),links(html),/sdx-icon-tile-danger/.test(html)],['2','Operating system support. Ended: 1, Ending: 1, Supported: 1, Unknown: 1',['#device/old','#device/soon'],true],'Operating system support: ended first, then ending; every device by its status');
ok(text(html).includes('devices with ended or ending support')&&text(html).includes('Show OS support')&&count(html,'<a class="sdx-dash-row"')===2,'the detail, the head action and three rows below the legend at 2 x 2');
ok(text(widget('OsSupportWidget',{servers:[osFleet[2]]},size(1,1))).includes('0 0 Every operating system is supported'),'no device with ended or ending support: the fact stands next to the number');
// Agent versions.
const agent=version=>({snapshot:snapshot({agentVersion:version})});
html=widget('AgentsWidget',{servers:[device('A',agent('4.19.0')),device('B',agent('4.9.2')),device('C',agent('4.19.0'))]});
check([number(html),barName(html),[...html.matchAll(/<strong class="mono">([^<]+)<\/strong><small>([^<]+)<\/small>/g)].map(match=>[match[1],match[2]]),links(html)],['1','Agent versions. Newest: 2, Older: 1',[['4.19.0','2 devices'],['4.9.2','1 device']],[]],'Agent versions: the versions in mono, the newest first; the rows are plain text');
ok(text(html).includes('device runs an older agent')&&/class="sdx-dash-row sdx-dash-row-static"/.test(html),'the detail; a row that opens nothing does not look clickable');
// Microsoft Defender.
const defenderState=(extra={})=>({agentCapabilities:['defender-status'],defender:{available:true,collectedAt:'',mode:'normal',antivirusEnabled:true,realTimeProtection:true,tamperProtected:true,activeCount:0,...extra}});
html=widget('DefenderWidget',{servers:[device('SAFE',{snapshot:snapshot(defenderState())}),device('THREAT',{snapshot:snapshot(defenderState({activeCount:2}))}),device('BLANK')]});
check([number(html),barName(html),links(html),/sdx-icon-tile-danger/.test(html)],['1','Microsoft Defender. Threat active: 1, Protected: 1, Other: 1',['#device/threat/management/defender'],true],'Microsoft Defender: the device with a threat; a row opens Management › Defender');
ok(text(html).includes('device needs attention')&&text(html).includes('Show Defender')&&text(html).includes('THREAT Threat active'),'the detail, the head action and the status of the row');
// Drive encryption.
const bitlocker=(conversion,protection='on')=>({bitlocker:{available:true,collectedAt:'',volumes:[{drive:'C:',volumeType:'os',conversion,percent:null,protection,method:'xts-aes-256',protectors:[],suspendedSince:null}]}});
html=widget('EncryptionWidget',{servers:[device('ENC',{snapshot:snapshot(bitlocker('encrypted'))}),device('PLAIN',{snapshot:snapshot(bitlocker('decrypted','off'))}),device('PAUSED',{snapshot:snapshot(bitlocker('encrypted','suspended'))}),device('SILENT')]});
check([number(html),barName(html),links(html)],['2','Drive encryption. Not encrypted: 1, Suspended: 1, Encrypted: 1, No data: 1',['#device/plain','#device/paused']],'Drive encryption: not encrypted first, then suspended');
ok(text(html).includes('devices without active encryption')&&text(html).includes('Show encryption'),'the detail and the head action');
// Certificates.
const cert=(thumbprint,daysLeft)=>({thumbprint,stores:['My'],subject:'CN='+thumbprint,sans:[],issuer:'CN=CA',notBefore:new Date(now-90*day).toISOString(),notAfter:new Date(now+daysLeft*day+hour).toISOString(),hasPrivateKey:true,selfSigned:false,bindings:[]});
const certFleet=[device('WEB',{snapshot:snapshot({certificates:{collectedAt:'',truncated:false,items:[cert('soon',12),cert('long',400),cert('gone',-3)]}})})];
html=widget('CertificatesWidget',{servers:certFleet});
check([number(html),pills(html),links(html)],['2',[['critical','Expired · 1'],['warning','Expiring · 1']],['#device/web/software/certificates','#device/web/software/certificates']],'Certificates: expired and expiring, expired first; a row opens Software › Certificates');
ok(/CN=gone WEB Expired/.test(text(html))&&/CN=soon WEB Expires in 1[23] days/.test(text(html))&&text(html).includes('Show certificates'),'the subject, the device and the status of each certificate');
html=widget('CertificatesWidget',{servers:quiet});
ok(empty(html,'certificates')[1]&&text(html).includes('No certificate expires soon Certificates that expire within 30 days show here. Show certificates'),'Certificates, empty');
// New autostart entries.
const entry=(id,suspicious,firstSeen)=>({id,name:id,category:'run',suspicious,firstSeen});
html=widget('AutostartWidget',{servers:[device('PC',{autostart:{reportedAt:now,count:40,newCount:3,suspiciousNewCount:1,newEntries:[entry('updater',false,now-hour),entry('odd.exe',true,now-5*hour)]}})]});
check([number(html),pills(html),links(html)],['3',[['warning','1 suspicious'],['warning','Suspicious']],['#device/pc/software/autostart','#device/pc/software/autostart']],'New autostart entries: the device total, the suspicious count, suspicious entries first');
ok(text(html).indexOf('odd.exe')<text(html).indexOf('updater')&&text(html).includes('Show autostart'),'the entry names and the head action');
ok(text(widget('AutostartWidget',{servers:quiet})).includes('No new autostart entries'),'New autostart entries, empty');
// Disk health.
const disks=(...states)=>({diskHealth:{collectedAt:'',disks:states.map(health=>({health,operationalStatus:['ok'],countersAvailable:true})),events:{windowDays:30,items:[],counts:{},truncated:false}}});
html=widget('DiskHealthWidget',{servers:[device('GOOD',{snapshot:snapshot(disks('healthy'))}),device('BAD',{snapshot:snapshot(disks('healthy','unhealthy'))}),device('OLD')]});
check([number(html),barName(html),links(html)],['1','Disk health. Error state: 1, OK: 1, No data: 1',['#device/bad/hardware/storage']],'Disk health: a device counts by its worst disk; a row opens Hardware › Storage');
ok(text(widget('DiskHealthWidget',{servers:[device('GOOD',{snapshot:snapshot(disks('healthy'))})]},size(1,1))).includes('0 0 No unhealthy disk'),'no unhealthy disk: the fact stands next to the number');
// Crashes.
const crash=daysAgo=>({id:String(daysAgo),kind:'bugcheck',at:new Date(now-daysAgo*day).toISOString(),stopCode:null,parameters:null,driver:null,source:'event',dumpFile:null,dumpStatus:'none',detail:null});
html=widget('CrashesWidget',{servers:[device('ONCE',{snapshot:snapshot({crashes:[crash(3)]})}),device('OFTEN',{snapshot:snapshot({crashes:[crash(10),crash(2),crash(45)]})})]});
check([number(html),links(html)],['3',['#device/often/diagnostics/events','#device/once/diagnostics/events']],'Crashes: the crashes of the last 30 days, the device with the most first');
ok(text(html).includes('on 2 devices in the last 30 days')&&text(html).includes('2 crashes')&&text(html).includes('1 crash')&&!text(html).includes('1 crashes')&&text(html).includes('Show reliability'),'the detail, the plural and the head action');
ok(text(widget('CrashesWidget',{servers:quiet})).includes('No crashes in the last 30 days'),'Crashes, empty');
// Failed jobs.
html=widget('FailedJobsWidget',jobProps);
check([number(html),count(html,'class="sdx-job-row"'),/sdx-dash-number-danger/.test(html),text(html).includes('in the last 24 hours')],['1',1,true,true],'Failed jobs: the failed job of the last 24 hours as a job row');
ok(text(widget('FailedJobsWidget',{...jobProps,jobs:[job('ok','succeeded')]})).includes('No failed jobs No job failed in the last 24 hours. Show all jobs'),'Failed jobs, empty');
// Runbook runs.
const runbookJob=(id,state,steps)=>job(id,state,{action:'runbook-run',target:'Patch day',metadata:{runbookRunId:'run-'+id,completedSteps:steps,totalSteps:3}});
html=widget('RunbooksWidget',{...jobProps,jobs:[runbookJob('r1','succeeded',3),job('plain','running'),runbookJob('r2','running',1),runbookJob('r3','failed',2)]},size(2,2));
check([number(html),count(html,'class="sdx-job-row"'),html.indexOf('sdx-job-accent')<html.indexOf('sdx-job-success'),text(html).includes('1 running')&&text(html).includes('0 waiting')&&text(html).includes('Show runbook runs')],['1',3,true,true],'Runbook runs: only the runbook runs among the jobs, the running one first; the head action');
ok(text(widget('RunbooksWidget',{...jobProps,jobs:[job('plain','running')]})).includes('No runbook runs yet A runbook that you start or schedule shows here. Show runbook runs'),'Runbook runs, empty: a plain job is no runbook run');
check(dashboardLinks.runbookRuns,'#automation/runbooks/runs','the head action opens Automation › Runbooks › Runs');
// Recent activity.
const audit=[{id:1,at:now-hour,actor:'anna',action:'session.signIn',target:'',serverId:null,scope:'portal'}],deviceAudit=[{id:2,at:now-2*minute,actor:'ben',action:'device.rename',target:'db01',serverId:'db01',scope:'device'}];
html=widget('ActivityWidget',{servers:fleet,audit,deviceAudit,owner:true});
check([number(html),links(html)],['2',['#device/db01/history/access','#settings/audit']],'Recent activity: the newest entry first; a device entry opens the device access, a portal entry the audit log');
ok(text(html).includes('entries in the last 24 hours')&&text(html).includes('ben · DB01')&&text(html).includes('Show audit log'),'the account and the device of an entry; the Owner opens the audit log');
html=widget('ActivityWidget',{servers:fleet,audit:[],deviceAudit,owner:false});
ok(!text(html).includes('Show audit log')&&links(html).length===1,'an account that is no Owner has no audit log action');
ok(text(widget('ActivityWidget',{servers:fleet,audit:[],deviceAudit:[],owner:false})).includes('No activity yet'),'Recent activity, empty');

// ---- the parts: the breakdown bar and the day bars ----
html=render(h(Breakdown,{parts:[{id:'a',label:'Good',count:3,tone:'ok'},{id:'b',label:'Bad',count:0,tone:'critical'}],label:'Health',legend:false}));
check(html,'<div class="sdx-dash-break"><div class="sdx-dash-break-bar" role="img" aria-label="Health. Good: 3"><i data-tone="ok" title="Good: 3" style="flex-grow:3"></i></div></div>','a breakdown without a legend: one image with its name');
check(render(h(Breakdown,{parts:[{id:'b',label:'Bad',count:0,tone:'critical'}],label:'Health',legend:true})),'','a breakdown without a counted part renders nothing');
html=render(h(DayBars,{days:[{key:1,short:'Mon',title:'Monday: 2 alarms',count:2},{key:2,short:'Tue',title:'Tuesday: 0 alarms',count:0},{key:3,short:'Wed',title:'Wednesday: 4 alarms',count:4}],label:'Alarms per day',labels:true}));
ok(/^<div class="sdx-dash-days sdx-dash-days-labelled" role="img" aria-label="Alarms per day">/.test(html)&&html.includes('<span class="sdx-dash-day" title="Monday: 2 alarms"><b>2</b><span class="sdx-dash-day-track"><i style="height:50%"></i></span><small>Mon</small></span>')&&html.includes('<i style="height:0%" data-empty="true"></i>')&&html.includes('<i style="height:100%"></i>'),'the day bars: one image; each bar has its share of the highest day, its count and its weekday');

// ---- the two widgets of the alarm week ----
const retries=[];
const weekState=(extra={})=>({week:null,error:'',loading:false,retry:()=>retries.push(1),...extra});
for(const name of ['AlarmWeekWidget','AlarmTrendWidget']){
 html=widget(name,{state:weekState({loading:true})});
 ok(/role="status" aria-label="Loading the alarms of the last 7 days"/.test(html)&&/sdx-skeleton-chart/.test(html)&&!html.includes('sdx-dash-heat')&&!html.includes('sdx-dash-days'),name+', loading: a chart skeleton with its label');
 html=widget(name,{state:weekState({error:'The data storage cannot be reached.'})});
 ok(/class="sdx-notice sdx-notice-danger"/.test(html)&&text(html).includes('The data storage cannot be reached.')&&text(html).includes('Try again')&&!html.includes('sdx-skeleton'),name+', a failed load: a danger notice with Try again');
}
const start=alarmWeekStart(now),hours=new Array(192).fill(0);
html=widget('AlarmWeekWidget',{state:weekState({week:{start,hours}})});
check([empty(html,'alarm-week'),text(html)],[[true,true,true,1,true],'Alarms in the last 7 days No alarms in the last 7 days A quiet week. New alarms show here by day and hour. Show alert rules'],'a week without an alarm');
ok(text(widget('AlarmTrendWidget',{state:weekState({week:{start,hours}})},size(1,1))).includes('Alarms per day 0 0 No alarms in the last 7 days'),'Alarms per day without an alarm, at 1 x 1');
const yesterdayNoon=new Date(now);yesterdayNoon.setDate(yesterdayNoon.getDate()-1);yesterdayNoon.setHours(12,0,0,0);
const filled=[...hours];filled[Math.floor((yesterdayNoon.getTime()-start)/hour)]=6;filled[Math.floor((yesterdayNoon.getTime()-3*hour-start)/hour)]=2;
const week={start,hours:filled},grid=alarmWeekGrid(week,now);
html=widget('AlarmWeekWidget',{state:weekState({week})});
const busiest=weekBusiestText(grid,'en');
ok(/^Most alarms: \w+day, 12:00 PM–01:00 PM \(6\)$/.test(busiest),'the busiest hour in words: '+busiest);
ok(html.includes(`<div class="sdx-dash-heat" role="img" aria-label="8 alarms in the last 7 days. ${busiest}">`),'the heatmap is one image whose name holds the total and the busiest hour');
ok(/<div class="sdx-dash-week-scroll" role="group" aria-label="Alarms by day and hour">/.test(html)&&!/sdx-dash-week-scroll"[^>]*tabindex/.test(html),'the scroll region is named and takes no Tab stop before it overflows');
check([count(html,'<div class="sdx-dash-heat-row">'),count(html,'class="sdx-dash-heat-hour"'),count(html,'<i class="sdx-dash-heat-cell"')],[7,4,7*24+5],'seven rows, four axis labels, 168 cells and the five legend cells');
ok(html.includes(`<i class="sdx-dash-heat-cell" data-step="4" title="${weekCellText(grid.busiest,'en')}"></i>`)&&/data-step="2" title="\w+day, 09:00 AM–10:00 AM: 2 alarms"/.test(html),'a cell carries its step and its day, hour and count');
ok(count(html,'data-future="true"')===grid.days[6].cells.filter(cell=>cell.future).length&&!/data-future="true" title/.test(html),'future cells are marked and have no title');
ok(html.includes(`<p>${busiest}</p>`)&&/<span class="sdx-dash-heat-legend" aria-hidden="true">Fewer<i/.test(html)&&html.includes('More</span>'),'the summary line and the legend');
ok(number(html)==='8'&&text(html).includes('in the last 7 days')&&!html.includes('sdx-dash-days'),'the lead number is the total; at two columns the heatmap stands alone');
html=widget('AlarmWeekWidget',{state:weekState({week})},size(3,2));
ok(html.includes('sdx-dash-heat')&&/class="sdx-dash-body sdx-dash-body-split"/.test(html)&&/<div class="sdx-dash-days sdx-dash-days-labelled" role="img" aria-label="Alarms per day\. [^"]*\w+day: 8 alarms[^"]*">/.test(html),'from three columns the day totals stand next to the heatmap');
html=widget('AlarmWeekWidget',{state:weekState({week,error:'The portal cannot be reached.'})});
ok(text(html).includes('The portal cannot be reached. '+translate('en','console.staleData'))&&html.includes('sdx-dash-heat')&&text(html).includes('Try again'),'a failed reload keeps the counts and says so');
html=widget('AlarmTrendWidget',{state:weekState({week})},size(1,1));
ok(number(html)==='0'&&text(html).includes('today')&&text(html).includes('8 in the last 7 days')&&/<div class="sdx-dash-days" role="img" aria-label="Alarms per day\. /.test(html)&&count(html,'class="sdx-dash-day"')===7&&!/<small>/.test(html.slice(html.indexOf('sdx-dash-days'))),'Alarms per day at 1 x 1: the alarms of today, the week total and seven plain bars');
html=widget('AlarmTrendWidget',{state:weekState({week})},size(2,2));
ok(/sdx-dash-days-labelled/.test(html)&&count(html.slice(html.indexOf('sdx-dash-days')),'<small>')===7&&/title="\w+day: 8 alarms"><b>8<\/b>/.test(html),'two rows high: each bar carries its count and its weekday');

// ---- the page ----
const page=(props={},locale='en')=>render(h(DashboardView,{
 header:(actions,primary)=>h('header',{className:'test-head'},actions,primary),servers:fleet,jobs,viewer,demo:false,saving:false,narrow:false,owner:false,
 preference:{own:null,default:builtInDashboardLayout},onPreference(){},refreshKey:0,customizeRequest:0,onNavigate(){},onAddDevice(){},onSelectJob(){},onCancelJob(){},...props}),locale);
const cells=out=>[...out.matchAll(/<div id="dashboard-cell-([\w-]+)" class="sdx-dash-cell[^"]*" data-flip="([\w-]+)" data-widget="([\w-]+)" data-w="(\d)" data-h="(\d)"/g)].map(match=>`${match[1]}:${match[4]}x${match[5]}`);
const builtIn=builtInDashboardLayout.map(item=>`${item.id}:${item.w}x${item.h}`);
html=page();
ok(/<section class="sdx-dash-status" aria-label="Status of your devices" data-tone="danger">/.test(html)&&/sdx-icon-tile-danger/.test(html)&&/<h2>3 open alarms need your attention<\/h2>/.test(html)&&text(html).includes('Check the most urgent alarms first.'),'the status line: the alarms headline in the danger tone');
ok(/<span class="sdx-dash-online"><i class="sdx-dash-dot sdx-dash-pulse" aria-hidden="true"><\/i>2 of 4 devices online<\/span>/.test(html),'the online line with the pulse');
check(cells(html),builtIn,'the widgets of the built-in layout in order, each cell with its size');
ok(html.indexOf('sdx-dash-status')<html.indexOf('sdx-dash-grid')&&/<div class="sdx-dash-board" data-columns="4"><div class="sdx-dash-grid">/.test(html)&&!/data-editing|data-moving|data-resizing/.test(html),'the status line comes before the grid of four columns; no edit mode');
ok(/<header class="test-head"><button type="button" class="sdx-btn sdx-btn-secondary" id="dashboard-customize"[^>]*>.*?<span>Customize<\/span><\/button><\/header>/.test(html)&&!html.includes('More actions'),'the header action Customize; no menu for an account that is no Owner, and no primary');
ok(!/sdx-btn-primary/.test(html)&&!/sdx-dash-grip|sdx-dash-resize|sdx-dash-size|sdx-dash-edit-note|sdx-drawer| inert/.test(html),'outside edit mode: no gradient primary, no edit control, no notice, no catalog, live content');
ok(/role="status" aria-label="Loading the alarms of the last 7 days"/.test(html),'the heatmap widget waits for its first load');
ok(/<p class="sr-only" role="status"><\/p>/.test(html),'the status region of the edit steps is there and empty');
ok(!claimEntrance('dashboard-tiles'),'the grid claimed its entrance on the first render: a later render or a layout change does not replay it');
html=page({owner:true});
ok(/aria-label="More actions"/.test(html),'the Owner has the More actions menu');
html=page({narrow:true});
ok(/<button type="button" class="sdx-icon-btn sdx-btn-ghost" aria-label="Customize"[^>]*id="dashboard-customize"/.test(html)&&!/<span>Customize<\/span>/.test(html),'760px or narrower: Customize is an icon button with the same name');

// The layout: order, sizes, the own layout over the default, and widgets that are not on the board.
const custom=[{id:'jobs',w:4,h:3},{id:'status',w:1,h:1},{id:'alarms',w:2,h:1}];
html=page({preference:{own:custom,default:builtInDashboardLayout}});
check(cells(html),['jobs:4x3','status:1x1','alarms:2x1'],'the own layout: its widgets, order and sizes');
ok(!html.includes('dashboard-widget-updates')&&!html.includes('dashboard-widget-alarm-week')&&!/Loading the alarms/.test(html),'a widget that is not on the board is not rendered (and the alarm week does not load)');
html=page({preference:{own:null,default:custom}});
check(cells(html),['jobs:4x3','status:1x1','alarms:2x1'],'without an own layout the default layout shows');
html=page({preference:undefined});
check(cells(html),builtIn,'before the first load: the built-in layout');
// Widgets a viewer cannot use stay in the layout but do not render.
const withBoth=[{id:'customers',w:2,h:2},{id:'activity',w:2,h:2},{id:'status',w:1,h:1}];
check([cells(page({preference:{own:withBoth,default:builtInDashboardLayout}})),cells(page({preference:{own:withBoth,default:builtInDashboardLayout},customers})),cells(page({preference:{own:withBoth,default:builtInDashboardLayout},owner:true})),cells(page({preference:{own:withBoth,default:builtInDashboardLayout},servers:[device('SEC',{permissions:['view','security.events']})]}))],
 [['status:1x1'],['customers:2x2','status:1x1'],['activity:2x2','status:1x1'],['activity:2x2','status:1x1']],'Customers shows with two visible customers; Recent activity for an Owner or with the security events of a device');
html=page({preference:{own:[],default:builtInDashboardLayout}});
ok(html.includes('sdx-dash-status')&&!html.includes('sdx-dash-grid')&&/data-art="hidden"/.test(html)&&text(html).includes('No widgets on your dashboard Add a widget to see your devices at a glance. Add widget…'),'an empty board: the status line stays, the empty state offers Add widget…');

// The other headlines.
html=page({servers:[device('A'),device('B',{lastSeen:now-9*minute})],jobs:[]});
ok(/data-tone="warning"/.test(html)&&/<h2>1 device is offline<\/h2>/.test(html)&&text(html).includes('1 of 2 devices online'),'an offline device: the warning headline');
html=page({servers:[device('A'),device('B')],jobs:[]});
ok(/data-tone="success"/.test(html)&&/sdx-icon-tile-success/.test(html)&&/<h2>Everything is running<\/h2>/.test(html)&&text(html).includes('No alarm is open and no device is offline.')&&text(html).includes('2 of 2 devices online'),'everything runs');
html=page({servers:[device('A',{lastSeen:now-9*minute})],jobs:[]});
ok(/<i class="sdx-dash-dot" aria-hidden="true"><\/i>0 of 1 device online/.test(html),'no device online: the dot does not pulse; the singular');

// No device: the page empty state, with Add device only for the Owner.
html=page({servers:[],jobs:[]});
ok(!html.includes('sdx-dash-status')&&!html.includes('sdx-dash-grid')&&/data-art="devices"/.test(html)&&text(html).includes('No devices yet Devices show here as soon as an Owner gives you access.')&&!text(html).includes('Add device'),'no device, not an Owner: the fact and no action');
html=page({servers:[],jobs:[],owner:true});
ok(text(html).includes('No devices yet Add your first device to see its state here. Add device'),'no device, Owner: Add device');

// Sample devices: the sample week shows without a load, and the layout cannot change.
html=page({demo:true,owner:true});
ok(html.includes('sdx-dash-heat')&&!/Loading the alarms/.test(html),'sample devices: the heatmap shows the sample week at once');
ok(/<button type="button" class="sdx-btn sdx-btn-secondary" aria-disabled="true"[^>]*>.*?<span>Customize<\/span><span[^>]*class="sr-only"[^>]*>Not available for sample devices\.<\/span>/.test(html)&&!html.includes('More actions'),'sample devices: Customize is blocked and the Owner menu is gone');
check(demoAlarmWeek(now).hours.length,192,'the sample week has the server window');

// German.
html=page({},'de');
ok(/<h2>3 offene Alarme brauchen deine Aufmerksamkeit<\/h2>/.test(html)&&text(html).includes('2 von 4 Geräten online')&&/<span>Anpassen<\/span>/.test(html),'the German status line and header action');
for(const id of builtInDashboardLayout.map(item=>item.id))ok(html.includes(translate('de',dashboardWidgetMeta[id].title)+'</h2>'),'German widget title: '+id);
ok(/Seit 2[^<]*offen/.test(text(html)),'the German time since the start');
check([Object.keys(dashboardWidgetMeta),Object.keys(dashboardWidgetSizes).sort()],[[...dashboardWidgetIds],[...dashboardWidgetIds].sort()],'every widget has its name, description, icon and group');
for(const id of dashboardWidgetIds)for(const locale of ['en','de'])ok(translate(locale,dashboardWidgetMeta[id].title)!==dashboardWidgetMeta[id].title&&translate(locale,dashboardWidgetMeta[id].hint).endsWith('.')&&!translate(locale,dashboardWidgetMeta[id].title).endsWith('.'),`${id} ${locale}: a title without a period and a one-sentence description`);
check([[...dashboardWidgetGroups],dashboardWidgetGroups.map(group=>dashboardWidgetIds.filter(id=>dashboardWidgetMeta[id].group===group).length),dashboardWidgetGroups.map(group=>translate('en',dashboardGroupLabels[group]))],
 [['monitoring','devices','updates','security','hardware','activity'],[4,6,4,4,2,4],['Monitoring','Devices','Updates and lifecycle','Security','Hardware','Activity']],'the catalog groups and how many widgets each holds');

// ---- illustrations and the Empty variant ----
for(const kind of ['alarms','offline','updates','jobs','alarm-week','devices','hidden','pinned','certificates']){
 const art=render(h(DashboardArt,{kind}));
 ok(new RegExp(`^<svg class="sdx-dash-art" viewBox="0 0 96 64" width="96" height="64" aria-hidden="true" focusable="false" data-art="${kind}">`).test(art),kind+': a decorative svg of 96 by 64');
 ok(!/\b(?:fill|stroke|style|color)=/.test(art)&&!/#[0-9a-f]{3,8}\b|rgb|hsl/i.test(art)&&!/<text|<title/.test(art),kind+': no color attribute, no color literal, no text');
 ok([...art.matchAll(/class="([\w-]+)"/g)].every(match=>match[1].startsWith('sdx-dash-art')),kind+': every shape takes its color from a class');
}
html=render(h(Empty,{art:h(DashboardArt,{kind:'jobs'}),title:'Nothing here'},'One sentence.'));
ok(/^<div class="sdx-empty sdx-empty-with-art"><span class="sdx-empty-art" aria-hidden="true"><svg class="sdx-dash-art"/.test(html)&&!html.includes('sdx-empty-icon'),'Empty art: the illustration replaces the icon bubble');
html=render(h(Empty,{icon:Siren,title:'Nothing here'}));
ok(/^<div class="sdx-empty"><span class="sdx-empty-icon">/.test(html),'Empty icon: unchanged');

// ---- the stylesheet ----
const css=readFileSync('ui/devices/dashboard/dashboard-view.css','utf8'),rules=css.replace(/\/\*[\s\S]*?\*\//g,'');
ok(!/#[0-9a-f]{3,8}\b/i.test(rules)&&!/\brgba?\(|\bhsla?\(/.test(rules),'no color literal');
ok(!/@keyframes/.test(rules),'no keyframes next to the component');
check([...rules.matchAll(/animation:\s*([^;]+);/g)].map(match=>match[1]),['sdx-pulse 2s ease-in-out infinite'],'the only animation is the online pulse, on the shared keyframes');
ok(/\.sdx-dash-pulse \{[^}]*animation: sdx-pulse 2s/.test(rules),'the pulse belongs to .sdx-dash-pulse');
const motion=readFileSync('ui/styles/motion.css','utf8'),reduced=motion.slice(motion.indexOf('@media (prefers-reduced-motion: reduce)'));
ok(/\.sdx-dash-pulse,/.test(reduced)&&/animation: none !important/.test(reduced),'reduced motion stops the pulse');
ok(/\.sdx-dash-heat-cell \{[^}]*background: var\(--sd-meter-track\)/.test(rules)&&[1,2,3].every(step=>new RegExp(`\\[data-step="${step}"\\] \\{ background: color-mix\\(in srgb, var\\(--sd-meter\\) \\d+%, var\\(--sd-panel\\)\\); \\}`).test(rules))&&/\[data-step="4"\] \{ background: var\(--sd-meter\); \}/.test(rules),'the heatmap steps use the data color on its track');
ok(/\.sdx-dash-day-track > i \{[^}]*background: var\(--sd-meter\)/.test(rules)&&/\.sdx-dash-break-bar > i \{[^}]*background: var\(--sd-meter\)/.test(rules)&&/i\[data-tone="ok"\] \{ background: var\(--sd-success\); \}/.test(rules)&&/i\[data-tone="warning"\] \{ background: var\(--sd-warn\); \}/.test(rules)&&/i\[data-tone="critical"\] \{ background: var\(--sd-danger\); \}/.test(rules),'the day bars and a plain share use the data color; a state uses its status color');
ok(!/sdx-dash-(?:heat|day|break)[^{]*\{[^}]*--sd-accent/.test(rules),'no data mark takes the scheme accent');
ok(/\.sdx-dash-grid \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); grid-auto-rows: var\(--sdx-dash-row\); gap: var\(--sd-space-4\); \}/.test(rules)&&/\.sdx-dash-board \{ --sdx-dash-row: \d+px; \}/.test(rules)&&!/grid-auto-flow/.test(rules),'the grid: four equal columns, one row height, placement in reading order (no dense packing)');
ok(/\.sdx-dash-board\[data-columns="2"\] \.sdx-dash-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/.test(rules)&&/\.sdx-dash-board\[data-columns="1"\] \.sdx-dash-grid \{ grid-template-columns: minmax\(0, 1fr\); grid-auto-rows: auto; \}/.test(rules)&&/\.sdx-dash-board\[data-columns="1"\] \.sdx-dash-cell \{ grid-row: auto; \}/.test(rules),'two columns and one column by the measured width; with one column a widget is as high as its content');
ok([2,3,4].every(span=>new RegExp(`\\.sdx-dash-cell\\[data-w="${span}"\\] \\{ grid-column: span ${span}; \\}`).test(rules))&&[2,3].every(span=>new RegExp(`\\.sdx-dash-cell\\[data-h="${span}"\\] \\{ grid-row: span ${span}; \\}`).test(rules)),'a cell spans its columns and rows');
ok(/\.sdx-dash-cell > \.sdx-dash-widget \{[^}]*overflow: hidden;/.test(rules)&&/\.sdx-card\.sdx-dash-widget > \.sdx-dash-body \{[^}]*overflow: hidden;/.test(rules),'a widget never grows out of its cell: the card and its body clip');
ok(/\.sdx-dash-week-scroll \{ overflow-x: auto;/.test(rules),'the heatmap scrolls inside its own region');
ok(/\.sdx-dash-grip \{[^}]*touch-action: none;/.test(rules)&&/\.sdx-dash-resize \{[^}]*touch-action: none;/.test(rules)&&/\.sdx-dash-ghost \{[^}]*pointer-events: none;/.test(rules),'the handles keep a touch drag from scrolling the page, and the drag image takes no pointer events');
ok(/\.sdx-dash-board\[data-editing\] \.sdx-dash-cell:is\(\[data-moving\], \[data-resizing\]\) > \.sdx-dash-widget \{[^}]*border-color: var\(--sd-accent\); box-shadow: var\(--sd-shadow-md\);/.test(rules),'the moved or resized widget lifts: accent outline and the medium shadow');
ok([...rules.matchAll(/(?<![\w-])(?:gap|padding|margin(?:-(?:bottom|top|right))?):\s*([^;]+);/g)].every(match=>/^(?:(?:0|var\(--sd-space-\d\)|calc\(-1 \* var\(--sd-space-\d\)\)|2px|auto)(?:\s+|$))+$/.test(match[1])),'spacing comes from the 4px tokens (2px only between cells and bar segments)');
const source=readdirSync('ui/devices/dashboard').filter(file=>/\.tsx?$/.test(file)).map(file=>readFileSync('ui/devices/dashboard/'+file,'utf8')).join('\n');
ok(!/\p{Extended_Pictographic}/u.test(source+css),'no emoji in the Dashboard files');
ok(/<CountUp value=\{value\} entranceId=\{'dashboard-'\+id\}\/>/.test(source)&&/<EntranceList id="dashboard-tiles" className="sdx-dash-grid">/.test(source),'every lead number counts up once per page load and the widgets rise once');
// Every class of the stylesheet has a user in the Dashboard files.
const classes=[...new Set([...rules.matchAll(/\.(sdx-dash-[\w-]+)/g)].map(match=>match[1]))];
check(classes.filter(name=>!source.includes(name)&&!/^sdx-dash-(?:number|level)-/.test(name)),[],'no class without a user');

console.log(`dashboard view: ${checks} checks passed`);
