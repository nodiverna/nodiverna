// The device Overview with its health line: state and score, the most urgent issue
// with the link to the area that fixes it, the other issues behind one disclosure
// button, the KPI tiles with one layout (sparkline for a live trend, meter for a
// limit, nothing on stale values), the History head, the grid order, IEC units and
// the flat Protection rows. Rendered with React SSR and the sample devices.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {postcss} from '../../support/theme-colors.mjs';

const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {default:DeviceSummary,HealthLineView,healthLineIssues,fixLinkLabel}=await import('../../../ui/devices/device/device-summary.tsx');
const {demoData}=await import('../../../ui/shell/demo.ts');
const {deviceIssues,issueTarget}=await import('../../../ui/base/ui-device.ts');
const {deviceHealth}=await import('../../../ui/base/health-score.ts');

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
const nbsp=' ';

const {servers}=demoData(),now=Date.now();
const byId=Object.fromEntries(servers.map(server=>[server.id,server]));
const app=byId['demo-app'],dc=byId['demo-dc'],file=byId['demo-file'];
const owner={id:'owner',label:'owner',permissions:['*']},noop=()=>{};
const summary=(server,{locale='en',samples=[],viewer=owner,onNavigate=noop}={})=>render(h(DeviceSummary,{server,viewer,demo:true,now,samples,jobs:[],historyLoading:false,onNavigate,onRefreshInventory:noop,refreshBlocked:'',onOpenEsuGroup:noop,onRefresh:noop}),locale);
const line=(server,props={},locale='en')=>render(h(HealthLineView,{server,now,locale,expanded:false,onToggle:noop,listId:'health-issues',onNavigate:noop,...props}),locale);
const healthOf=html=>html.match(/<section class="sdx-health-line[\s\S]*?<\/section>/)?.[0]??'';

// ---- The health line leads the Overview ----
let html=summary(app);
const health=healthOf(html);
ok(health.includes('sdx-enter'),'the first render lets the health line rise in');
ok(health&&html.indexOf('class="sdx-health-line')<html.indexOf('class="sdx-kpi-row"'),'the health section comes before the KPI row');
ok(/<section class="sdx-health-line[^"]*"[^>]*aria-labelledby="([^"]+)"><h2 id="\1" class="sr-only">Health<\/h2>/.test(health),'a section named by its sr-only h2 "Health"');
ok(/<span class="sdx-health-line-state"><span class="sdx-icon-tile sdx-icon-tile-danger" aria-hidden="true"><svg[^>]*lucide-heart-pulse/.test(health),'the 32 px HeartPulse tile in the danger tone first');
const appScore=deviceHealth(app).score;
ok(health.includes(`<span class="sdx-pill sdx-pill-critical" title="Health ${appScore} of 100.`)&&text(health).includes(`Critical · ${appScore}/100`),`the pill "Critical · ${appScore}/100" with the score tooltip`);
// Sample SRV-DC01 carries the DHCP scope warning alarm, so a quiet device drops its alarms too.
const quiet={...dc,issues:[],alerts:[]};
ok(text(line(quiet)).includes('Good · 100/100'),'a device without alarms: "Good · 100/100"');
const never={...dc,lastSeen:null,snapshot:null,alerts:[],issues:[]};
html=line(never);
ok(/<span class="sdx-pill sdx-pill-neutral"[^>]*><i aria-hidden="true"><\/i>No data<\/span>/.test(html)&&!html.includes('/100'),'never reported: "No data" without a score');
ok(/sdx-icon-tile-neutral/.test(html),'never reported: the tile is neutral');

// ---- The lead issue ----
const appIssues=deviceIssues(app,now,'en');
ok(health.includes(`<p class="sdx-health-line-issue"><strong>${appIssues[0].title}</strong><span>${appIssues[0].detail}</span></p>`),'the lead is the first issue: title in strong, detail muted');
const offlineOnly={...file,issues:file.issues.filter(issue=>issue.ruleId==='device-offline')};
ok(deviceIssues(offlineOnly,now,'en').length===1,'fixture: the offline device has only Device offline');
html=line(offlineOnly);
ok(text(html).includes('Issues are checked again when the device next reports.')&&!text(html).includes('Device offline'),'offline with only Device offline: the next-report sentence, no offline issue');
html=line(file);
const firstKept=file.issues.find(issue=>issue.ruleId!=='device-offline').key;
check(html.match(/<strong>([^<]+)<\/strong>/)?.[1],deviceIssues(file,now,'en').find(issue=>issue.key===firstKept).title,'offline with more issues: the lead skips Device offline');
ok(text(line({...dc,snapshot:null,issues:[]})).includes('Issues appear after the first inventory.'),'no snapshot: issuesAfterInventory');
ok(text(line(quiet)).includes('No issues found on this device.'),'online without issues: noIssues');

// ---- Collapsed and expanded ----
const others=healthLineIssues(app,now,'en').slice(1);
html=line(app);
const toggle=html.match(/<button[^>]*class="sdx-btn sdx-btn-ghost sdx-btn-sm sdx-health-toggle"[^>]*>[\s\S]*?<\/button>/)?.[0]??'';
ok(text(toggle)===`Show ${others.length} more issues`,`collapsed: "Show ${others.length} more issues"`);
ok(toggle.includes('aria-expanded="false"')&&toggle.includes('aria-controls="health-issues"')&&!html.includes('id="health-issues"'),'aria-expanded false, aria-controls names a list that is not rendered');
ok(toggle.includes('lucide-chevron-down'),'the toggle has a chevron');
ok(others.filter(issue=>issue.title!==appIssues[0].title).every(issue=>!text(html).includes(issue.title)),'collapsed: no other issue title');
html=line(app,{expanded:true});
const expandedToggle=html.match(/<button[^>]*sdx-health-toggle"[^>]*>[\s\S]*?<\/button>/)?.[0]??'';
ok(text(expandedToggle)==='Show fewer issues'&&expandedToggle.includes('aria-expanded="true"'),'expanded: "Show fewer issues", aria-expanded true');
const list=html.match(/<ul id="health-issues" class="sdx-health-issues" aria-label="All issues">[\s\S]*?<\/ul>/)?.[0]??'';
ok(list,'expanded: the list "All issues" with the controlled id');
check([...list.matchAll(/<span class="sdx-health-issue-text"><strong>([^<]+)<\/strong>/g)].map(match=>match[1]),others.map(issue=>issue.title.replace(/&/g,'&amp;')),'every other issue in server order');
html=line({...dc,issues:dc.issues.slice(0,1)});
ok(!html.includes('sdx-health-toggle')&&!html.includes('aria-expanded'),'one issue: no button');
html=line(quiet);
ok(!html.includes('sdx-health-toggle'),'no issue: no button');

// ---- Fix links ----
const target=(ruleId,params={},snapshot={})=>issueTarget({ruleId,params},{snapshot});
check(target('stability-low'),{section:'diagnostics',diagnosis:'events'},'stability-low opens Events');
check(target('cert-expiring'),{section:'software',software:'certificates'},'cert-expiring opens Software › Certificates');
check(target('crash-recent',{driver:'vjoy.sys'},{driverHealth:app.snapshot.driverHealth}),{section:'software',software:'drivers',driver:'vjoy.sys'},'a crash with a driver opens Software › Drivers with it');
check(target('crash-recent',{driver:'vjoy.sys'}),{section:'diagnostics',diagnosis:'events'},'a crash without driver health opens Events');
check(target('battery-capacity'),{section:'hardware',hardware:'overview'},'battery opens the hardware overview');
check(['disk-health-failed','ssd-wear','disk-errors','disk-free'].map(rule=>target(rule)),Array(4).fill({section:'management',management:'storage'}),'the disk rules open Storage');
check(target('cpu'),{section:'diagnostics',diagnosis:'processes'},'cpu opens Processes');
check(target('pagefile'),{section:'hardware',hardware:'memory'},'pagefile opens hardware memory');
check(['firewall-off','os-support-end','inventory-incomplete','device-offline','unknown-rule'].map(rule=>target(rule)),Array(5).fill(null),'rules of the Overview get no link');
html=line(app,{expanded:true});
const fixes=[...html.matchAll(/<button[^>]*class="sdx-btn sdx-btn-ghost sdx-btn-sm sdx-health-fix"[^>]*>[\s\S]*?<\/button>/g)].map(match=>match[0]);
ok(fixes[0].includes('lucide-arrow-up-right')&&text(fixes[0])==='Show in driver inventory','the lead crash links to the driver inventory');
ok(fixes.map(text).includes('Open Events')&&fixes.map(text).includes('Open Certificates')&&fixes.map(text).includes('Open Defender'),'the other links name the subarea: "Open Events", "Open Certificates", "Open Defender"');
html=line(app,{expanded:true},'de');
ok(text(html).includes('Ereignisse öffnen')&&text(html).includes('Im Treiber-Inventar zeigen'),'German link labels');
ok(!line(app,{expanded:true,onNavigate:undefined}).includes('sdx-health-fix'),'without onNavigate: no links');
const reader={id:'reader',label:'reader',permissions:[]};
ok(!summary({...app,permissions:[]},{viewer:reader}).includes('sdx-health-fix'),'without the view right: no links');
ok(summary({...app,permissions:['view']},{viewer:reader}).includes('sdx-health-fix'),'with the view right: the lead link');
const opened=[];
const navigated=HealthLineView({server:app,now,locale:'en',expanded:false,onToggle:noop,listId:'x',onNavigate:value=>opened.push(value)});
const findFix=node=>!node||typeof node!=='object'?null:node.props?.className==='sdx-health-fix'?node:[].concat(node.props?.children??[]).map(findFix).find(Boolean)??null;
findFix(navigated)?.props.onClick();
check(opened,[{section:'software',software:'drivers',driver:'vjoy.sys'}],'selecting the lead link navigates to its target');
// The DHCP issues open the DHCP server of the Extensions area, only on a device with the DHCP role.
const dhcpRules=[['dhcp-scope-full',{scope:'10.20.0.0',inUse:93,total:100,percent:93}],['dhcp-service-stopped',{}]];
const dhcpTargets=device=>dhcpRules.map(([ruleId,params])=>issueTarget({ruleId,params},device));
const toDhcp={section:'extensions',extensions:'dhcp'};
ok(dc.snapshot.features.some(feature=>feature.name==='DHCP'&&feature.installed===true),'fixture: SRV-DC01 has the installed DHCP feature');
check(dhcpTargets(dc),[toDhcp,toDhcp],'with the DHCP role: both DHCP rules open the DHCP server');
check(dhcpTargets({snapshot:dc.snapshot}),[toDhcp,toDhcp],'the snapshot alone carries the role');
const withoutDhcp={snapshot:{...dc.snapshot,features:dc.snapshot.features.map(feature=>feature.name==='DHCP'?{...feature,installed:false}:feature)}};
check(dhcpTargets(withoutDhcp),[null,null],'DHCP feature not installed: no link');
check(dhcpTargets({snapshot:{}}),[null,null],'no detected role: no link');
check(dhcpTargets({snapshot:{...dc.snapshot,os:'Windows 11 Pro'}}),[null,null],'not a Windows Server: no link');
check(['firewall-off','os-support-end','inventory-incomplete','device-offline','unknown-rule'].map(ruleId=>issueTarget({ruleId,params:{}},dc)),Array(5).fill(null),'on a server with roles the Overview rules still get no link');
check([fixLinkLabel('en',toDhcp),fixLinkLabel('de',toDhcp)],['Open DHCP server','DHCP-Server öffnen'],'the DHCP link label');
check([fixLinkLabel('en',{section:'extensions',extensions:'overview'}),fixLinkLabel('de',{section:'extensions',extensions:'overview'})],['Open Extensions','Erweiterungen öffnen'],'the Extensions overview link label');
check(issueTarget({ruleId:'dns-service-stopped',params:{}},{snapshot:{...dc.snapshot,features:[...dc.snapshot.features,{name:'DNS',displayName:'DNS-Server',installed:true,featureType:'Role'}]}}),{section:'extensions',extensions:'dns'},'the DNS rule opens the DNS server of Extensions');
// The row of an issue, wherever it sits: the lead block or its li in the expanded list.
const issueRow=(markup,title)=>[markup.match(/<div class="sdx-health-line-main">[\s\S]*?<\/div>/)?.[0]??'',...[...markup.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match=>match[1])].find(row=>row.includes(`<strong>${title}</strong>`))??'';
const fixOf=row=>text(row.match(/<button[^>]*class="sdx-btn sdx-btn-ghost sdx-btn-sm sdx-health-fix"[^>]*>[\s\S]*?<\/button>/)?.[0]??'');
const dhcpTitle=locale=>deviceIssues(dc,now,locale).find(issue=>issue.key==='dhcp-scope-10.20.0.0')?.title;
ok(dhcpTitle('en')==='DHCP scope 10.20.0.0 is 93% full','fixture: SRV-DC01 has the DHCP scope issue');
check(fixOf(issueRow(line(dc,{expanded:true}),dhcpTitle('en'))),'Open DHCP server','SRV-DC01: the DHCP issue row links "Open DHCP server"');
check(fixOf(issueRow(line(dc,{expanded:true},'de'),dhcpTitle('de'))),'DHCP-Server öffnen','German: "DHCP-Server öffnen"');
const dhcpOpened=[];
const allFixes=node=>!node||typeof node!=='object'?[]:[...(node.props?.className==='sdx-health-fix'?[node]:[]),...[].concat(node.props?.children??[]).flatMap(allFixes)];
const dhcpFix=allFixes(HealthLineView({server:dc,now,locale:'en',expanded:true,onToggle:noop,listId:'x',onNavigate:value=>dhcpOpened.push(value)})).find(node=>node.props.children==='Open DHCP server');
ok(dhcpFix,'the DHCP fix button in the element tree');
dhcpFix.props.onClick();
check(dhcpOpened,[toDhcp],'selecting it navigates to the DHCP server of the Roles tab');
ok(summary(dc).includes('sdx-health-fix'),'fixture: SRV-DC01 shows the DHCP link to an owner');
ok(!summary({...dc,permissions:[]},{viewer:reader}).includes('sdx-health-fix'),'DHCP issue without the view right: no link');
ok(!summary({...dc,revoked:1}).includes('sdx-health-fix'),'DHCP issue on a revoked device: no link');
ok(!line(dc,{expanded:true,onNavigate:undefined}).includes('sdx-health-fix'),'DHCP issue without onNavigate: no link');
const navigateSource=read('ui/devices/device/device.tsx').match(/const navigateOverview=[\s\S]*?\n \};/)?.[0]??'';
ok(/else if\(target\.section==='extensions'\)onSection\('extensions',target\.extensions\);/.test(navigateSource),'navigateOverview opens the Extensions subarea of the target with onSection');

// ---- Quiet rows ----
html=line(app,{expanded:true});
ok(!html.includes('sdx-issue-critical')&&!/sdx-health-issues[^>]*style=/.test(html),'expanded rows have no tinted class');
const rows=[...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match=>match[1]);
ok(rows.every(row=>/^<svg[^>]*class="lucide lucide-(octagon-alert|triangle-alert|info) sdx-health-level-(critical|warning|info)"[^>]*>[\s\S]*?<\/svg><span class="sr-only">(Critical|Warning|Info)<\/span>/.test(row)),'each row: the level icon, then the level as sr-only text');
const icons=level=>others.filter(issue=>issue.level===level).length;
ok(icons('critical')&&icons('warning')&&icons('info'),'fixture: the other issues hold all three levels');
ok(rows.some(row=>row.includes('lucide-octagon-alert')&&row.includes('>Critical<'))&&rows.some(row=>row.includes('lucide-triangle-alert')&&row.includes('>Warning<'))&&rows.some(row=>row.includes('lucide-info')&&row.includes('>Info<')),'a distinct icon per level');
ok(text(render(h(HealthLineView,{server:app,now,locale:'de',expanded:true,onToggle:noop,listId:'x',onNavigate:noop}),'de')).includes('Kritisch'),'the level in German');

// ---- The Issues card is gone ----
const redesign=read('ui/styles/console.css'),css=postcss.parse(redesign);
html=summary(app);
const grid=html.slice(html.indexOf('class="sdx-summary-grid"'));
const cardTitles=[...grid.matchAll(/<h2(?: id="[^"]*")?><span class="sdx-icon-tile[^"]*" aria-hidden="true">[\s\S]*?<\/span>([^<]+)<\/h2>/g)].map(match=>match[1]);
check(cardTitles,['Utilization','Protection &amp; maintenance','Drives','Throughput','System'],'the card order: Utilization, Protection, Drives, Throughput, System; no Issues card');
ok(!/\.sdx-issues\b/.test(redesign)&&!redesign.includes('.sdx-issue-critical'),'console.css has no issues card CSS');
html=summary({...app,snapshot:{...app.snapshot,pendingFileOperationsCount:2}});
const restart=html.match(/<li><button[^>]*aria-label="Restart:[^"]*"[^>]*>[\s\S]*?<\/button><\/li>/)?.[0]??'';
ok(text(restart).includes('2 file operations are waiting for the next restart.'),'pending file operations are the detail of the Restart row');

// ---- Grid ----
const rulesOf=selector=>{const found=[];css.walkRules(rule=>{if(rule.selectors.includes(selector))found.push(rule);});return found;};
const declsOf=selector=>rulesOf(selector).flatMap(rule=>rule.nodes.filter(node=>node.type==='decl').map(node=>`${node.prop}: ${node.value}`));
ok(declsOf('.sdx-summary-grid').length&&!declsOf('.sdx-summary-grid').includes('align-items: start'),'.sdx-summary-grid keeps the default stretch');
ok(declsOf('.sdx-span-full').includes('grid-column: 1 / -1')&&/<section class="sdx-card sdx-span-full sdx-system-card"/.test(summary(app)),'System takes the full width');

// ---- Motion ----
ok(!/@keyframes/.test(redesign),'no own keyframes next to the health line');
const reduced=[];css.walkAtRules('media',rule=>{if(/prefers-reduced-motion: no-preference/.test(rule.params))rule.walkRules(inner=>reduced.push(inner.selector+' '+inner.toString()));});
ok(reduced.some(rule=>rule.startsWith('.sdx-health-issues')&&/animation: sdx-rise var\(--sd-dur\)/.test(rule)),'the list rises in once with the shared sdx-rise, only without reduced motion');
ok(declsOf('.sdx-health-toggle[aria-expanded="true"] svg').includes('transform: rotate(180deg)')&&declsOf('.sdx-health-toggle svg').includes('transition: transform var(--sd-dur) var(--sd-ease-out)'),'the chevron turns 180° over --sd-dur');
ok(!rulesOf('.sdx-health-line:hover').length&&!/\.sdx-health-line[^{]*:hover/.test(redesign),'the health line has no hover reaction');

// ---- KPI tiles ----
const recent=id=>[{serverId:id,at:now-20*60000,cpu:21,memory:48},{serverId:id,at:now-10*60000,cpu:35,memory:52},{serverId:id,at:now-60000,cpu:28,memory:50}];
const tiles=markup=>Object.fromEntries([...markup.matchAll(/<article class="sdx-kpi[^"]*"[^>]*aria-label="([^"]+?): [^"]*">([\s\S]*?)<\/article>/g)].map(match=>[match[1],match[2]]));
let kpis=tiles(summary(app,{samples:recent('demo-app')}));
ok(kpis.CPU.includes('class="sdx-sparkline"')&&kpis.RAM.includes('class="sdx-sparkline"'),'online with 2 or more values: CPU and RAM show a sparkline');
ok(kpis['Fullest drive C:'].includes('class="sdx-meter '),'storage shows a meter of the used share');
ok(/role="meter" aria-label="Fullest drive C:" aria-valuemin="0" aria-valuemax="100" aria-valuenow="47"/.test(kpis['Fullest drive C:']),'the storage meter: 47 % used');
ok(!('Uptime' in kpis)&&Object.keys(kpis).length<=4,'no uptime tile, at most four tiles');
ok(Object.values(kpis).every(tile=>!tile.includes('sdx-ring')),'no tile uses a ring');
kpis=tiles(summary(app));
ok(kpis.CPU.includes('class="sdx-meter ')&&!kpis.CPU.includes('sdx-sparkline'),'online without samples: CPU shows a meter of the current value');
kpis=tiles(summary(file,{samples:recent('demo-file')}));
ok(['CPU','RAM'].every(name=>!kpis[name].includes('sdx-sparkline')&&!kpis[name].includes('sdx-meter')&&kpis[name].includes('<span class="sdx-kpi-value">—</span>')),'offline with samples: CPU and RAM show "—" and no visual');
const neverTiles=tiles(summary({...app,lastSeen:null}));
ok(!neverTiles.CPU.includes('sdx-meter')&&!neverTiles.CPU.includes('sdx-sparkline'),'never reported: no visual');
// At most four tiles: CPU, RAM, one GPU tile for the first GPU, the fullest drive; Uptime is a System fact.
{
 const {translate}=await import('../../../lib/i18n/translate.ts');
 const secondGpu={...app.snapshot.gpus[0],id:'luid_second',name:'NVIDIA RTX A4000',utilization:44};
 const twoGpus={...app,snapshot:{...app.snapshot,gpus:[...app.snapshot.gpus,secondGpu]}};
 check(Object.keys(tiles(summary(twoGpus))),['CPU','RAM','GPU','Fullest drive C:'],'two GPUs: one GPU tile, four tiles in this order');
 ok(tiles(summary(twoGpus)).GPU.includes(app.snapshot.gpus[0].name),'the GPU tile names the first GPU');
 check(Object.keys(tiles(summary({...app,snapshot:{...app.snapshot,gpus:[],gpuDetails:[]}}))),['CPU','RAM','Fullest drive C:'],'no GPU: three tiles');
 const fact=(markup,label)=>markup.match(new RegExp(`<div><dt>${label}</dt><dd>([\\s\\S]*?)</dd></div>`))?.[1];
 const lastBoot=app.snapshot.security.lastBoot;
 const online=fact(summary({...app,snapshot:{...app.snapshot,uptimeSeconds:93784}}),'Uptime');
 ok(/^\d/.test(online??''),'online: the uptime text');
 ok(lastBoot?online.includes(`<small>Since `):online.includes(`<small>${translate('en','device.summary.bootUnknown')}</small>`),'the hint: since the last boot, or boot unknown');
 const offline=fact(summary({...file,snapshot:{...file.snapshot,uptimeSeconds:93784}}),'Uptime');
 ok(offline?.startsWith('—'),'offline: "—"');
 check([translate('en','device.summary.uptime'),translate('de','device.summary.uptime'),translate('en','device.summary.utilization'),translate('de','device.summary.utilization')],['Uptime','Betriebszeit','Utilization','Auslastung'],'the Uptime fact and the Utilization card title in both catalogs');
}
const detailRule=declsOf('.sdx-kpi-detail');
ok(detailRule.length&&!detailRule.some(decl=>/nowrap|ellipsis/.test(decl)),'.sdx-kpi-detail wraps at every width');
ok(rulesOf('.sdx-kpi-body:has(.sdx-meter)').length>0&&declsOf('.sdx-kpi-body:has(.sdx-meter)').includes('flex-direction: column'),'a meter sits below the text like a sparkline');
ok(declsOf('.sdx-kpi-body').includes('flex: 1')&&declsOf('.sdx-kpi-body:has(.sdx-meter) > .sdx-kpi-visual').includes('margin-top: auto'),'the visual band sits at the bottom of a tile');

// ---- Storage tile ----
const storageTile=markup=>markup.match(/<article class="sdx-kpi[^"]*"[^>]*aria-label="(?:Fullest drive|Knappstes Laufwerk|Storage|Speicher)[^"]*">[\s\S]*?<\/article>/)?.[0]??'';
const drive={...app,snapshot:{...app.snapshot,disks:[{name:'C:',label:'System',totalGb:128,freeGb:68}]}};
let tile=storageTile(summary(drive));
ok(tile.includes('>Fullest drive C:</h3>')&&tile.includes(`<span class="sdx-kpi-value">68${nbsp}GiB<small class="sdx-kpi-unit">free</small></span>`)&&tile.includes(`>of 128${nbsp}GiB</span>`),'"Fullest drive C:", "68 GiB" free, "of 128 GiB"');
tile=storageTile(summary(drive,{locale:'de'}));
ok(tile.includes('>Knappstes Laufwerk C:</h3>')&&tile.includes(`>von 128${nbsp}GiB</span>`),'German storage tile');
tile=storageTile(summary({...app,snapshot:{...app.snapshot,disks:[]}}));
ok(tile.includes('>Storage</h3>')&&tile.includes('<span class="sdx-kpi-value">—</span>')&&text(tile).includes('Drive inventory pending'),'without drives: Storage, "—", drives pending');

// ---- History head ----
html=summary(app,{samples:recent('demo-app')});
const history=html.match(/<section class="sdx-card sdx-span-2 sdx-history-card[^"]*"[^>]*>[\s\S]*?<\/section>/)?.[0]??'';
const head=history.match(/<header[\s\S]*?<\/header>/)?.[0]??'',body=history.slice(history.indexOf('</header>'));
ok((head.match(/role="group"/g)??[]).length===2&&head.includes('aria-label="Measurement"')&&head.includes('aria-label="Time range"'),'both segmented controls sit in the head actions');
ok(!body.includes('role="group"'),'the body holds only the chart');
ok(!read('ui/devices/device/device-summary.tsx').includes('sdx-metric-switch')&&!redesign.includes('sdx-metric-switch'),'no sdx-metric-switch is left');

// ---- Units ----
const perf={...app,snapshot:{...app.snapshot,performance:{...app.snapshot.performance,diskReadBytesSec:1024*614,diskWriteBytesSec:1.4*1024**2,networkBytesSec:2048}}};
const throughput=markup=>[...(markup.match(/<dl class="sdx-throughput">[\s\S]*?<\/dl>/)?.[0]??'').matchAll(/<dd class="mono">([^<]*)<\/dd>/g)].map(match=>match[1]);
check(throughput(summary(perf)),[`614${nbsp}KiB/s`,`1.4${nbsp}MiB/s`,`11${nbsp}ms`,`2${nbsp}KiB/s`],'read, write and network through formatRate');
check(throughput(summary(perf,{locale:'de'}))[1],`1,4${nbsp}MiB/s`,'German rate');
check(throughput(summary(file)),['—','—','—','—'],'offline: "—"');
const source=read('ui/devices/device/device-summary.tsx');
ok(!source.includes('GiB`')&&!source.includes('GiB')&&!source.includes('KB/s')&&!source.includes('MB/s')&&!/const (gib|rate)=/.test(source),'no literal unit and no local gib() or rate()');
html=summary(app);
const memory=html.match(/aria-label="RAM: [^"]*">[\s\S]*?<\/article>/)?.[0]??'';
ok(new RegExp(`\\d+${nbsp}GiB of 32${nbsp}GiB used`).test(memory),'the RAM detail through formatBytes');
html=summary({...app,lastSeen:null});
ok((html.match(/aria-label="RAM: [^"]*">[\s\S]*?<\/article>/)?.[0]??'').includes(`32${nbsp}GiB usable`),'without a live value: "32 GiB usable"');
html=summary(app);
ok(html.includes(`>68${nbsp}GiB free</strong>`)&&html.includes(`>of 128${nbsp}GiB · 53%</small>`),'drive rows: "68 GiB free", "of 128 GiB · 53%"');

// ---- Protection rows ----
html=summary(app);
ok(/<ul class="sdx-protection"><li><button/.test(html),'the rows sit in ul.sdx-protection');
const row=declsOf('.sdx-protection li > :is(button, div)');
ok(row.length&&!row.some(decl=>/^border(-\w+)?: (?!0\b|none)/.test(decl))&&!row.some(decl=>decl.startsWith('border-radius')),'no border and no radius per row');
ok(declsOf('.sdx-protection li + li').includes('border-top: 1px solid var(--sd-soft-line)'),'rows are divided by --sd-soft-line');
ok(declsOf('.sdx-protection li > button:hover').join()==='background: var(--sdx-hover)'&&declsOf('.sdx-protection li > button:active').join()==='transform: scale(.96)','hover: --sdx-hover only; press: scale(.96)');
ok(!rulesOf('.sdx-protection li > div:hover').length,'static rows do not react');
const protectionCss=redesign.slice(redesign.indexOf('/* Protection: flat rows'),redesign.indexOf('/* History: the measurement'));
ok(protectionCss&&!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(protectionCss),'no new hex or rgba values');

// ---- Entrance ----
const {claimEntrance}=await import('../../../ui/kit/kit.tsx');
ok(!claimEntrance('device-health'),'the health line claimed its entrance on the first render');
html=summary(app);
ok(!healthOf(html).includes('sdx-enter'),'a later render does not replay the entrance');

console.log(`PASS device overview health (${checks} checks): the health line with state, score, lead issue, fix links and the disclosure list, the removed Issues card, the grid order, the motion rules, the KPI tiles and their visuals, the storage tile, the History head, IEC units and the flat Protection rows.`);
