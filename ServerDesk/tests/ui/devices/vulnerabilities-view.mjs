// The vulnerability check in the UI rendered with React SSR: the settings page
// (off, the first run queued, running, failed with its reason, a saved key,
// blocked actions with their reasons, the real settings in demo mode, the kit
// SettingsPage, Switch, Field, FormActions, Facts and DataTable), the device area Software with the
// Vulnerabilities column, view and pill buttons, the fleet tab Software with
// the sortable column and the filter, the CVE detail with recommendation, NVD
// links and the 500 cap, the notices (off for Owners with Turn on, off for
// others, first run, stale data) and the sample data. The CVE.org source: its
// switch, fact, column, notices and the source of each CVE in the detail.
// No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describedBy} from '../../support/blocked-buttons.mjs';
import {readFileSync} from 'node:fs';
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {demoData}=await import('../../../ui/shell/demo.ts');
const {default:VulnerabilitiesPanel}=await import('../../../ui/settings/vulnerabilities-panel.tsx');
const source=readFileSync('ui/settings/vulnerabilities-panel.tsx','utf8');
const {default:DeviceSoftware}=await import('../../../ui/devices/inventory/device-software.tsx');
const {default:SoftwareTab}=await import('../../../ui/devices/inventory/software-tab.tsx');
const {VerdictPill,VulnerabilityList,VulnerabilityStatusNotice}=await import('../../../ui/devices/inventory/vulnerability-list.tsx');
const {demoVulnerabilityDetail}=await import('../../../ui/shell/demo-vulnerabilities.ts');
const {vulnerabilityCatalog}=await import('../../../lib/software-vulnerabilities.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
const noop=()=>{};
const now=Date.now(),hour=3_600_000;
const owner={id:'owner',label:'owner',permissions:['*']};
const {servers}=demoData();
const byId=Object.fromEntries(servers.map(server=>[server.id,server]));
const button=(html,label)=>html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`))?.[0]??'';

// ---- Settings page ----
const base={enabled:false,apiKeySet:false,revision:0,catalogCheckedAt:vulnerabilityCatalog.checkedAt,sync:{state:'off',lastSuccessAt:null,lastFinishedAt:null,lastError:null,nextDueAt:null},
 secondSource:{enabled:false,state:'off',lastSuccessAt:null,lastFinishedAt:null,lastError:null},
 products:vulnerabilityCatalog.products.map(product=>({id:product.id,label:product.label,cveCount:0,syncedAt:null,secondSourceCount:0}))};
const page=(view,extra={})=>render(h(VulnerabilitiesPanel,{viewer:owner,initialView:view,now,...extra}));
const switches=markup=>[...markup.matchAll(/<input[^>]*role="switch"[^>]*>/g)].map(match=>match[0]);
const heads=markup=>[...markup.matchAll(/<th scope="col"[^>]*>(?:<button[^>]*>)?([^<]+)</g)].map(match=>match[1]);
let html=page(base);
ok(html.startsWith('<div class="sdx-settings-page sdx-vulnerabilities"><div class="sdx-settings">'),'one kit SettingsPage, the cards in the 760px column');
ok(switches(html).length===2&&switches(html).every(input=>!/checked/.test(input)&&!/aria-disabled/.test(input)),'both kit Switches are off and free');
ok((html.match(/class="sdx-switch-field"/g)??[]).length===2,'the switches are the kit Switch');
ok(text(html).includes('Check installed software against the NVD')&&text(html).includes('NVD API key (optional)'),'switch and key field');
ok(/<label class="sdx-field-label" for="[^"]+">NVD API key \(optional\)<\/label><input type="password" autoComplete="off"[^>]*placeholder="Paste the key"/i.test(html),'the key is a kit Field: a bound label and a password input without autocomplete');
ok(html.includes('href="https://nvd.nist.gov/developers/request-an-api-key" target="_blank" rel="noopener noreferrer"'),'the key request link in the hint');
ok(text(html).includes('Nodiverna sends only product names from the catalog, never device names, versions or customer data.'),'what is sent');
ok(describedBy(button(html,'Save'),button(html,'Save'))==='No changes.'&&!/ disabled/.test(button(html,'Save')),'FormActions Save is blocked until something changed, never native disabled');
ok(!button(html,'Discard'),'Discard only when dirty');
ok(describedBy(button(html,'Check now'),button(html,'Check now'))==='Turn on the check first.'&&/sdx-btn-secondary/.test(button(html,'Check now')),'Check now is a secondary Btn, blocked while off');
ok(/<div class="sdx-vuln-state" aria-live="polite"><span class="sdx-pill sdx-pill-[a-z]+ sdx-pill-lg"[^>]*>.*?Off<\/span><\/div>/.test(html)&&text(html).includes('Last successful check Never'),'the state pill leads the card, then the Facts');
ok(/<dl class="sdx-facts sdx-facts-2">/.test(html)&&!/function Fact\(/.test(source),'kit Facts, no local Fact');
ok(text(html).includes('This product uses data from the NVD API but is not endorsed or certified by the NVD.'),'the NVD notice below the table');
check(heads(html),['Product','CVEs','Last update'],'the product table columns');
ok(/aria-sort="none"><button type="button" class="sdx-sort" aria-label="Product: sort ascending">/.test(html)&&/aria-label="CVEs: sort descending"/.test(html),'Product and CVEs sort');
ok(/class="sdx-table-wrap sdx-table-wrap-flush" role="region" aria-label="Products in the catalog"/.test(html),'the products are a DataTable inside the status card');
check((html.match(/<tbody>.*<\/tbody>/)[0].match(/<tr[ >]/g)??[]).length,vulnerabilityCatalog.products.length,'one row per catalog product');
ok(!text(html).includes('An API key is saved.'),'no saved key');
html=page({...base,enabled:true,sync:{...base.sync,state:'queued',nextDueAt:now}});
ok(text(html).includes('Queued')&&text(html).includes('Next check Within a minute'),'the first run is queued');
ok(describedBy(button(html,'Check now'),button(html,'Check now'))==='A check is already running.','Check now is blocked while queued');
html=page({...base,enabled:true,sync:{...base.sync,state:'running'}});
ok(text(html).includes('Running')&&describedBy(button(html,'Check now'),button(html,'Check now'))==='A check is already running.','running');
html=page({...base,enabled:true,sync:{state:'failed',lastSuccessAt:now-2*hour,lastFinishedAt:now,lastError:'serverMessage.vulnerabilities.rateLimited',nextDueAt:now+hour}});
ok(text(html).includes('Failed')&&text(html).includes('The NVD limited the requests. The check tries again in one hour. With an API key the limit is higher.'),'failed with its reason');
ok(html.indexOf('sdx-notice-danger')<html.indexOf('sdx-facts'),'the failure notice follows the pill, before the facts');
ok(!/aria-disabled/.test(button(html,'Check now')),'Check now is open after a failure');
html=page({...base,enabled:true,sync:{state:'failed',lastSuccessAt:now-2*hour,lastFinishedAt:now,lastError:'serverMessage.vulnerabilities.storageFailed',nextDueAt:now+hour}});
ok(/class="[^"]*sdx-notice-danger/.test(html)&&text(html).includes('The portal could not save the CVE data. The check tries again in one hour. If it fails again, check the database connection.'),'a database error: the danger notice with its reason');
html=page({...base,enabled:true,apiKeySet:true,sync:{...base.sync,state:'idle',lastSuccessAt:now,nextDueAt:now+24*hour}});
ok(text(html).includes('An API key is saved.')&&/sdx-btn-ghost/.test(button(html,'Remove key'))&&!/aria-disabled/.test(button(html,'Remove key')),'a saved key with the ghost Btn Remove key');
ok(text(html).includes('Waiting for the next check'),'idle');
ok(!html.includes('abcdef'),'no key value is shown');
// A failed load without data shows LoadFailed in place of the cards; with data the cards stay and the note says they are the last loaded state.
html=page(null,{initialLoadFailed:true});
ok(/^<div class="sdx-settings-page sdx-vulnerabilities"><div class="sdx-settings"><div class="sdx-notice sdx-notice-danger" role="alert">/.test(html)&&html.includes('<div>Nodiverna could not load the vulnerability check.</div>')&&/<span>Try again<\/span><\/button>/.test(html),'a failed first load: LoadFailed with Try again only on the button, no stale note');
html=page(base,{initialLoadFailed:true});
ok(text(html).includes('Nodiverna could not load the vulnerability check. The last loaded state is shown.')&&html.indexOf('sdx-notice-danger')<html.indexOf('sdx-facts'),'a failed reload with data: the stale-data note, the cards below it');
// sample devices change nothing here; the page shows the real settings and blocks nothing for the demo.
ok(!/demoVulnerabilitySettings|common\.demoBlocked|\bdemo\b/.test(source),'no demo data and no demo block in the page');
html=page(base,{demo:true});
ok(switches(html).every(input=>!/checked/.test(input))&&!text(html).includes('Not available for sample devices'),'with sample devices the real (off) settings show, nothing is blocked for the demo');
ok(/pollMs=10_000/.test(source)&&/if\(!busy\)return;\n  const timer=setInterval\(\(\)=>\{void load\(\);\},pollMs\);/.test(source),'polling every 10 s while a check is queued or running');
html=page(null);
ok(html.includes('role="status"')&&html.includes('aria-label="Vulnerability check"'),'the kit Skeleton with the page label while loading');
ok(!/sdx-loading|sdx-skeleton"|common\.reload|ErrorNote/.test(source),'no classic loading or reload');
ok(text(render(h(VulnerabilitiesPanel,{viewer:owner,initialView:base,now}),'de')).includes('Installierte Software mit der NVD abgleichen'),'German texts');

// ---- Device area Software with the sample check ----
html=render(h(DeviceSoftware,{server:byId['demo-db'],demo:true,now,owner:true}));
check([...html.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(match=>match[1]),['Name','Version','Vulnerabilities','Publisher','Installed on','Architecture','Scope'],'the Vulnerabilities column');
ok(html.includes('aria-label="Critical: 3 vulnerabilities in Google Chrome. Show the details."')&&text(html).includes('Critical · 3'),'Chrome 109: a critical pill button, with the CVE.org-only CVE');
ok(text(html).includes('High · 2')&&text(html).includes('Medium · 1'),'7-Zip high, Edge medium');
ok(text(html).includes('None known')&&text(html).includes('Not checked'),'clean and not checked programs');
ok(/<span>Vulnerabilities<\/span><b class="sdx-count-critical">3<\/b>/.test(html),'the third view with its count and the critical tone');
ok(!html.includes('sdx-notice-info'),'no notice while the data is current');
html=render(h(DeviceSoftware,{server:byId['demo-db'],demo:true,now,initialView:'vulnerabilities'}));
check([...html.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(match=>match[1]),['Name','Version','Highest severity','CVEs','Known exploited','Recommendation'],'the Vulnerabilities view columns');
const order=[...html.matchAll(/<tr><td[^>]*>([^<]+)<\/td>/g)].map(match=>match[1]);
check(order,['Google Chrome','7-Zip 23.01 (x64)','Microsoft Edge'],'sorted by severity, known exploited and count');
ok(text(html).includes('Update to 157.0.8103.38 or later.')&&text(html).includes('Update to 24.09 or later.')&&text(html).includes('Update to 131.0.2903.48 or later.'),'recommendations');
ok((html.match(/sdx-vuln-exploited/g)??[]).length===2&&text(html).includes('Known exploited'),'known exploited tags');
html=render(h(DeviceSoftware,{server:byId['demo-file'],demo:true,now,initialView:'vulnerabilities'}));
ok(text(html).includes('Critical · 2')&&!text(html).includes('High · 1'),'Chrome 120 on another device: critical through the CVE.org-only CVE, with a known exploited one');
ok(text(render(h(DeviceSoftware,{server:byId['demo-file'],demo:true,now}))).includes('Not checked'),'Veeam Agent is outside the catalog');
ok(text(render(h(DeviceSoftware,{server:byId['demo-db'],demo:true,now}),'de')).includes('Kritisch · 3'),'German pill');

// ---- Fleet tab Software ----
html=render(h(SoftwareTab,{scope:{type:'all'},devices:servers,demo:true,now,onOpen:noop}));
ok(/aria-sort="none"><button type="button" class="sdx-sort" aria-label="Vulnerabilities: sort descending">Vulnerabilities/.test(html),'a sortable Vulnerabilities column');
ok(/<span>Vulnerable<\/span><b class="sdx-count-critical">\d+<\/b>/.test(html)&&text(html).includes('All'),'the filter All / Vulnerable with its count');
html=render(h(SoftwareTab,{scope:{type:'all'},devices:servers,demo:true,now,onOpen:noop,initialFilter:'vulnerable'}));
const fleetRows=[...html.matchAll(/<tr[^>]*><td><button[^>]*>([^<]+)<\/button>/g)].map(match=>match[1]);
ok(fleetRows.length>0&&fleetRows.every(name=>['Google Chrome','7-Zip 23.01 (x64)','Microsoft Edge'].includes(name)),'the filter keeps only vulnerable rows');
html=render(h(SoftwareTab,{scope:{type:'group',id:'none'},devices:[],demo:true,now,onOpen:noop,initialFilter:'vulnerable'}));
ok(text(html).includes('No product in this scope has a known vulnerability'),'empty with the filter');

// ---- CVE detail ----
const chrome=demoVulnerabilityDetail('google chrome','109.0.5414.120','Google LLC');
html=render(h(VulnerabilityList,{target:{name:'google chrome',version:'109.0.5414.120',device:'demo-db'},demo:chrome}));
ok(text(html).startsWith('Update to 157.0.8103.38 or later.'),'the recommendation first');
ok(html.includes('href="https://nvd.nist.gov/vuln/detail/CVE-2023-2136" target="_blank" rel="noopener noreferrer"')&&html.includes('aria-label="Open CVE-2023-2136 in the NVD"'),'the NVD link');
check([...html.matchAll(/vuln\/detail\/(CVE-[\d-]+)/g)].map(match=>match[1]),['CVE-2023-2136','CVE-2024-0519'],'most severe first');
ok(text(html).includes('Critical 9.6')&&text(html).includes('High 8.8'),'severity with score');
ok(text(html).includes('Known exploited')&&/Published \d{2}\/\d{2}\/\d{4}/.test(text(html))&&text(html).includes('Fixed in 112.0.5615.137'),'tag, date and fixed version');
ok(html.includes('class="sdx-vuln-summary"'),'the clamped summary');
html=render(h(VulnerabilityList,{target:{name:'microsoft edge',version:'1',scope:'all'},demo:{...demoVulnerabilityDetail('microsoft edge','130.0.2849.56','Microsoft Corporation'),verdict:{status:'vulnerable',count:600,highest:'high',knownExploited:false,fixedIn:null,noFixCount:3},total:612}}));
ok(text(html).includes("No fixed version is known yet. Update to the latest version, or follow the vendor's advice.")&&text(html).includes('Showing the 500 most severe of 612 vulnerabilities.'),'no fixed version and the cap notice');
html=render(h(VulnerabilityList,{target:{name:'x',version:'1',device:'d'}}));
ok(html.includes('role="status"')&&html.includes('aria-label="Loading vulnerabilities"'),'a skeleton while loading');
html=render(h(VerdictPill,{verdict:{status:'vulnerable',count:1,highest:'low',knownExploited:false,fixedIn:'2',noFixCount:0},name:'Tool'}));
ok(!html.includes('<button')&&html.includes('sdx-pill-neutral')&&text(html)==='Low · 1','a pill without onOpen; low is neutral');
ok(render(h(VerdictPill,{verdict:{status:'vulnerable',count:1,highest:'medium',knownExploited:false,fixedIn:'2',noFixCount:0},name:'Tool'})).includes('sdx-pill-warning'),'medium is a warning');

// ---- Notices ----
html=render(h(VulnerabilityStatusNotice,{status:{enabled:false,lastSuccessAt:null},owner:true,now}));
ok(text(html).includes('The vulnerability check finds known security flaws (CVEs) in the programs installed on your devices. The check is off. Turn it on in Settings to see the results here.')&&button(html,'Turn on'),'off for an Owner, with Turn on');
html=render(h(VulnerabilityStatusNotice,{status:{enabled:false,lastSuccessAt:null},owner:false,now}));
ok(text(html)==='The vulnerability check finds known security flaws (CVEs) in the programs installed on your devices. The check is off, and an Owner can turn it on in Settings.'&&!html.includes('<button'),'off for others, without an action');
ok(text(render(h(VulnerabilityStatusNotice,{status:{enabled:true,lastSuccessAt:null},owner:true,now}))).includes('The first vulnerability check is running.'),'the first run');
html=render(h(VulnerabilityStatusNotice,{status:{enabled:true,lastSuccessAt:now-73*hour},owner:true,now}));
ok(html.includes('sdx-notice-warning')&&/The vulnerability data is from .+\. See why in Settings › Vulnerability check\./.test(text(html)),'stale data after 72 hours');
check(render(h(VulnerabilityStatusNotice,{status:{enabled:true,lastSuccessAt:now-71*hour},owner:true,now})),'','nothing while current');
ok(text(render(h(VulnerabilityStatusNotice,{status:{enabled:false,lastSuccessAt:null},owner:false,now}),'de')).includes('ein Owner kann sie in den Einstellungen einschalten.'),'German off notice');

// ---- The CVE.org source ----
const on={...base,enabled:true,sync:{state:'idle',lastSuccessAt:now-hour,lastFinishedAt:now-hour,lastError:null,nextDueAt:now+23*hour},
 products:base.products.map(product=>({...product,cveCount:product.id==='google-chrome'?1234:0,syncedAt:now-hour,secondSourceCount:product.id==='google-chrome'?17:product.id==='mozilla-firefox'?1500:0}))};
const secondOn={enabled:true,state:'idle',lastSuccessAt:null,lastFinishedAt:null,lastError:null};
// The second switch of the card: its input and the hint it names.
const secondSwitch=markup=>switches(markup)[1]??'';
html=page(on);
ok(secondSwitch(html)&&!secondSwitch(html).includes('checked')&&!secondSwitch(html).includes('aria-disabled'),'off: the second switch is unchecked and free');
const hintId=secondSwitch(html).match(/aria-describedby="([^"]+)"/)?.[1];
ok(text(html).includes('Also check against the CVE.org list')&&hintId&&new RegExp(`<small id="${hintId}">New CVEs show before the NVD has analyzed them`).test(html),'the switch with its hint (aria-describedby)');
ok(!text(html).includes('Last CVE.org check')&&!text(html).includes('Only on CVE.org')&&!text(html).includes('CVE Program'),'off: no CVE.org fact, column or notice');
check(heads(html),['Product','CVEs','Last update'],'off: the columns stay');
html=page({...on,secondSource:secondOn});
ok(/checked=""/.test(secondSwitch(html)),'on: the second switch is checked');
ok(text(html).includes('Last CVE.org check Never'),'on: the fact, never checked yet');
html=page({...on,secondSource:{...secondOn,lastSuccessAt:now-hour,lastFinishedAt:now-hour}});
ok(/Last CVE\.org check \d/.test(text(html)),'on: the fact with its time');
check(heads(html),['Product','CVEs','Only on CVE.org','Last update'],'on: the column Only on CVE.org');
ok(/<td>Google Chrome<\/td><td class="sdx-cell-end mono">1,234<\/td><td class="sdx-cell-end mono">17<\/td>/.test(html)&&html.includes('<td class="sdx-cell-end mono">1,500</td>'),'on: the counts, formatted');
ok(text(html).includes('This product uses data from the NVD API but is not endorsed or certified by the NVD. CVE data from the CVE Program (cve.org), retrieved through CIRCL Vulnerability-Lookup.'),'on: the CVE notice under the NVD notice');
ok(!html.includes('sdx-notice-danger'),'on and idle: no failure notice');
const failedSecond={...on,secondSource:{...secondOn,state:'failed',lastError:'serverMessage.vulnerabilities.cvelist.unreachable',lastFinishedAt:now}};
html=page(failedSecond);
ok(/class="[^"]*sdx-notice-danger/.test(html)&&text(html).includes('The portal cannot reach vulnerability.circl.lu. Allow outbound HTTPS to this host and try again.')&&text(html).includes('Waiting for the next check'),'a CVE.org failure: its own danger notice, the NVD state stays');
ok(text(render(h(VulnerabilitiesPanel,{viewer:owner,initialView:failedSecond,now}),'de')).includes('Das Portal erreicht vulnerability.circl.lu nicht. Erlaube ausgehendes HTTPS zu diesem Host und versuche es erneut.'),'the failure in German');
ok(text(render(h(VulnerabilitiesPanel,{viewer:owner,initialView:{...on,secondSource:{...secondOn,lastSuccessAt:now}},now}),'de')).includes('Letzte CVE.org-Prüfung')&&text(render(h(VulnerabilitiesPanel,{viewer:owner,initialView:on,now}),'de')).includes('Zusätzlich mit der CVE.org-Liste abgleichen'),'German switch and fact');
html=page({...on,sync:{state:'failed',lastSuccessAt:now-2*hour,lastFinishedAt:now,lastError:'serverMessage.vulnerabilities.unavailable',nextDueAt:now+hour},secondSource:{...secondOn,state:'failed',lastError:'serverMessage.vulnerabilities.cvelist.rateLimited'}});
check((html.match(/sdx-notice-danger/g)??[]).length,2,'both sources failed: two separate notices');
ok(text(html).includes('vulnerability.circl.lu limited the requests for the CVE.org data.'),'with the CVE.org text');
// The detail: the source of each CVE and its link.
html=render(h(VulnerabilityList,{target:{name:'google chrome',version:'109.0.5414.120',device:'demo-db'},demo:chrome}));
ok(html.includes('href="https://www.cve.org/CVERecord?id=CVE-2026-121131" target="_blank" rel="noopener noreferrer"')&&html.includes('aria-label="Open CVE-2026-121131 on CVE.org"'),'a CVE.org CVE links to CVE.org');
ok(html.includes('aria-label="Open CVE-2023-2136 in the NVD"'),'an NVD CVE links to the NVD');
check([...html.matchAll(/<li>.*?<\/li>/g)].map(item=>[item[0].match(/>(CVE-[\d-]+)</)?.[1],text(item[0]).match(/Source: (NVD|CVE\.org)/)?.[1]]),[['CVE-2023-2136','NVD'],['CVE-2026-121131','CVE.org'],['CVE-2024-0519','NVD']],'the sample Chrome detail shows both sources, most severe first');
ok(/<p class="sdx-vuln-meta"><span>Source: CVE\.org<\/span><span>Published \d{2}\/\d{2}\/2026<\/span><span>Fixed in 157\.0\.8103\.38<\/span><\/p>/.test(html),'the source is meta: first in the meta line, then date and fixed version');
ok(text(render(h(VulnerabilityList,{target:{name:'google chrome',version:'109.0.5414.120',device:'demo-db'},demo:chrome}),'de')).includes('Quelle: CVE.org')&&render(h(VulnerabilityList,{target:{name:'google chrome',version:'109.0.5414.120',device:'demo-db'},demo:chrome}),'de').includes('aria-label="CVE-2026-121131 bei CVE.org öffnen"'),'German source and link');
check(chrome.cves.map(item=>[item.id,item.source,item.fixedIn]),[['CVE-2023-2136','nvd','112.0.5615.137'],['CVE-2026-121131','cvelist','157.0.8103.38'],['CVE-2024-0519','nvd','120.0.6099.224']],'the sample detail data');
const sampleRecord=demoVulnerabilityDetail('google chrome','120.0.6099.130','Google LLC').cves.find(item=>item.id==='CVE-2026-121131');
check([sampleRecord.severity,sampleRecord.score,sampleRecord.vector,sampleRecord.published,sampleRecord.summary.startsWith('Use after free in Mobile in Google Chrome prior to 157.0.8103.38')],['critical',9.6,'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:H',Date.UTC(2026,10,3),true],'the sample CVE follows its real record');
// Every new key in both catalogs.
const en=(await import('../../../lib/i18n/messages/en.ts')).default??(await import('../../../lib/i18n/messages/en.ts')).en;
const de=(await import('../../../lib/i18n/messages/de.ts')).default??(await import('../../../lib/i18n/messages/de.ts')).de;
const enServer=(await import('../../../lib/i18n/messages/en-server.ts')).default??(await import('../../../lib/i18n/messages/en-server.ts')).enServer;
const deServer=(await import('../../../lib/i18n/messages/de-server.ts')).default??(await import('../../../lib/i18n/messages/de-server.ts')).deServer;
const uiKeys=['vulnerabilities.settings.secondSource','vulnerabilities.settings.secondSourceHint','vulnerabilities.status.secondSourceSuccess','vulnerabilities.products.col.secondSource','vulnerabilities.cveNotice','vulnerabilities.source.nvd','vulnerabilities.source.cvelist','vulnerabilities.openCveOrg'];
const serverKeys=['rateLimited','unavailable','requestRejected','unreachable','timeout','tooLarge','invalidResponse','storageFailed'].map(reason=>'serverMessage.vulnerabilities.cvelist.'+reason);
ok(uiKeys.every(key=>typeof en[key]==='string'&&typeof de[key]==='string'&&en[key]!==de[key]),'every new UI key in en and de');
ok(serverKeys.every(key=>typeof enServer[key]==='string'&&typeof deServer[key]==='string'&&enServer[key]!==deServer[key]),'every CVE.org server message in en and de');
ok(en['vulnerabilities.paletteKeywords'].includes('cve.org circl')&&de['vulnerabilities.paletteKeywords'].includes('cve.org circl')&&de['vulnerabilities.paletteKeywords'].includes('schwachstellenprüfung'),'the palette finds the page with cve.org and circl');

console.log(`PASS vulnerabilities view (${checks} checks): settings page states, blocked actions and demo, the device column, view and pills, the fleet column and filter, the CVE detail with the cap, the notices, and the CVE.org source (switch, fact, column, notices, the source per CVE).`);
