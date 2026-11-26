// The fact "Windows activation" of the device Overview (agent 4.22.0):
// windowsLicenseText (ui/devices/device/windows-license-model.ts) for every case
// of the spec in English and German (not reported, not available, a running,
// ended and unknown evaluation, a not licensed evaluation, activated with the
// channel and the KMS line, not activated with the grace end, unknown), the
// plural "1 day", the tone from the device's issue and the warning fallback; the
// rendered value (WindowsLicenseValue) and the sample devices; issueText of both
// rules with every detail variant in English and German. No browser.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const {windowsLicenseText}=await import('../../../ui/devices/device/windows-license-model.ts');
const {WindowsLicenseValue}=await import('../../../ui/devices/device/device-summary.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {issueText,deviceIssues}=await import('../../../ui/base/ui-device.ts');
const {formatDate}=await import('../../../lib/i18n/format.ts');
const {demoData}=await import('../../../ui/shell/demo.ts');

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const day=86400000,now=Date.UTC(2026,10,26,12,0,0),iso=offset=>new Date(now+offset).toISOString();
const license=(values={})=>({available:true,collectedAt:iso(-60_000),status:'licensed',channel:'retail',expiresAt:null,evaluationEndsAt:null,...values});
const server=(windowsLicense,issues=[],editionId='ServerStandard')=>({snapshot:{os:'Microsoft Windows Server 2025 Standard',osInfo:{editionId,installationType:'Server',displayVersion:'24H2',ubr:1,productName:'Windows Server 2025 Standard',currentBuild:'26100'},...(windowsLicense?{windowsLicense}:{})},issues});
const issue=(ruleId,level)=>({key:ruleId,ruleId,level,live:false,params:{}});
const text=(device,locale='en')=>windowsLicenseText(device,now,locale);
const date=(offset,locale='en')=>formatDate(locale,iso(offset));

// ---- Not reported, not available ----
check(text(server(null)),{text:'Not reported',tone:'neutral',lines:['Update the agent to 4.22.0 or later to see the activation status.']},'no windowsLicense (en)');
check(text(server(null),'de'),{text:'Nicht gemeldet',tone:'neutral',lines:['Aktualisiere den Agent auf 4.22.0 oder neuer, um den Aktivierungsstatus zu sehen.']},'no windowsLicense (de)');
check(text(server({available:false,reason:'error',collectedAt:iso(0)})),{text:'Not available',tone:'neutral',lines:['The agent could not read the license status. It tries again within an hour.']},'not available (en)');
check(text(server({available:false,reason:'access-denied',collectedAt:iso(0)}),'de'),{text:'Nicht verfügbar',tone:'neutral',lines:['Der Agent konnte den Lizenzstatus nicht lesen. Er versucht es innerhalb einer Stunde erneut.']},'not available (de)');

// ---- Evaluation ----
const evaluation=values=>license({channel:'evaluation',...values});
check(text(server(evaluation({expiresAt:iso(47*day)}),[issue('windows-evaluation','warning')])),{text:'Evaluation: 47 days left',tone:'warning',lines:[`Expires on ${date(47*day)}.`]},'running (en)');
check(text(server(evaluation({expiresAt:iso(47*day)}),[issue('windows-evaluation','warning')]),'de'),{text:'Evaluierung: noch 47 Tage',tone:'warning',lines:[`Läuft am ${date(47*day,'de')} ab.`]},'running (de)');
check([text(server(evaluation({expiresAt:iso(day)}))).text,text(server(evaluation({expiresAt:iso(day)})),'de').text],['Evaluation: 1 day left','Evaluierung: noch 1 Tag'],'the singular');
check(text(server(evaluation({expiresAt:iso(10*day)}),[issue('windows-evaluation','critical')])).tone,'critical','the tone of a critical issue');
check(text(server(evaluation({expiresAt:iso(10*day)}),[issue('windows-evaluation','info')])).tone,'neutral','an info issue is neutral');
check(text(server(evaluation({expiresAt:iso(10*day)}),[issue('windows-not-activated','critical')])).tone,'warning','without its own issue (rule off) the tone is warning');
check(text(server(evaluation({expiresAt:iso(-3*day)}),[issue('windows-evaluation','critical')])),{text:'Evaluation expired',tone:'critical',lines:[`Expired on ${date(-3*day)}.`]},'ended with a date (en)');
check(text(server(evaluation({expiresAt:iso(-3*day)}),[issue('windows-evaluation','critical')]),'de'),{text:'Evaluierung abgelaufen',tone:'critical',lines:[`Am ${date(-3*day,'de')} abgelaufen.`]},'ended with a date (de)');
check(text(server(evaluation({status:'notification'}),[issue('windows-evaluation','critical')])),{text:'Evaluation expired',tone:'critical',lines:['Install a full license and activate Windows.','Not activated (notification mode)']},'ended without a date adds the status line (en)');
check(text(server(evaluation({status:'notification'}),[issue('windows-evaluation','critical')]),'de'),{text:'Evaluierung abgelaufen',tone:'critical',lines:['Installiere eine Volllizenz und aktiviere Windows.','Nicht aktiviert (Benachrichtigungsmodus)']},'ended without a date (de)');
check(text(server(evaluation({}),[issue('windows-evaluation','warning')])),{text:'Evaluation',tone:'warning',lines:['Windows does not report when the evaluation ends.']},'unknown end (en)');
check(text(server(evaluation({}),[issue('windows-evaluation','warning')]),'de'),{text:'Evaluierung',tone:'warning',lines:['Windows meldet nicht, wann die Evaluierung endet.']},'unknown end (de)');
check(text(server(evaluation({status:'initial-grace',expiresAt:iso(5*day),evaluationEndsAt:iso(90*day)}))),{text:'Evaluation: 90 days left',tone:'warning',lines:[`Expires on ${date(90*day)}.`,'Not activated (grace period)']},'a not licensed evaluation adds the status label');
check(text(server(license({channel:'retail',expiresAt:iso(20*day)}),[],'ServerStandardEval')).text,'Evaluation: 20 days left','the edition ID marks an evaluation');

// ---- Activated ----
check(text(server(license({channel:'retail'}))),{text:'Activated',tone:'ok',lines:['Retail license']},'retail (en)');
check(text(server(license({channel:'oem'})),'de'),{text:'Aktiviert',tone:'ok',lines:['OEM-Lizenz']},'OEM (de)');
check(text(server(license({channel:'volume-mak'}))).lines,['Volume license (MAK)'],'MAK');
check(text(server(license({channel:'volume-kms',expiresAt:iso(170*day)}))),{text:'Activated',tone:'ok',lines:['Volume license (KMS)',`KMS activation valid until ${date(170*day)}.`]},'KMS with its renewal date (en)');
check(text(server(license({channel:'volume-kms',expiresAt:iso(170*day)})),'de').lines,['Volumenlizenz (KMS)',`KMS-Aktivierung gültig bis ${date(170*day,'de')}.`],'KMS (de)');
check(text(server(license({channel:'unknown'}))),{text:'Activated',tone:'ok',lines:[]},'an unknown channel has no line');

// ---- Not activated ----
check(text(server(license({status:'initial-grace',channel:'retail',expiresAt:iso(25*day)}),[issue('windows-not-activated','warning')])),{text:'Not activated (grace period)',tone:'warning',lines:['Retail license',`Grace period ends on ${date(25*day)}.`]},'initial grace (en)');
check(text(server(license({status:'initial-grace',channel:'retail',expiresAt:iso(25*day)}),[issue('windows-not-activated','warning')]),'de'),{text:'Nicht aktiviert (Kulanzzeit)',tone:'warning',lines:['Einzelhandelslizenz',`Kulanzzeit endet am ${date(25*day,'de')}.`]},'initial grace (de)');
check(text(server(license({status:'notification',channel:'retail'}),[issue('windows-not-activated','critical')])),{text:'Not activated (notification mode)',tone:'critical',lines:['Retail license']},'notification with a critical issue');
check(text(server(license({status:'unlicensed',channel:'unknown'}))),{text:'Not activated',tone:'warning',lines:[]},'unlicensed, rule off: warning, no channel line');
const labels={'additional-grace':['Not activated (grace period after a hardware change)','Nicht aktiviert (Kulanzzeit nach Hardwareänderung)'],'non-genuine-grace':['Not genuine (grace period)','Nicht echt (Kulanzzeit)'],'extended-grace':['Not activated (extended grace period)','Nicht aktiviert (verlängerte Kulanzzeit)']};
for(const [status,[english,german]] of Object.entries(labels))check([text(server(license({status,channel:'oem'}))).text,text(server(license({status,channel:'oem'})),'de').text],[english,german],`status label ${status}`);
check(text(server(license({status:'unknown',channel:'volume-mak'}))),{text:'Unknown',tone:'neutral',lines:['Volume license (MAK)']},'unknown status (en)');
check(text(server(license({status:'unknown',channel:'volume-mak'})),'de'),{text:'Unbekannt',tone:'neutral',lines:['Volumenlizenz (MAK)']},'unknown status (de)');

// ---- The rendered value: one StatusPill in the tone, then the small lines ----
const html=renderToStaticMarkup(React.createElement(LocaleProvider,{locale:'en'},React.createElement(WindowsLicenseValue,{server:server(evaluation({expiresAt:iso(47*day)}),[issue('windows-evaluation','warning')]),now,locale:'en'})));
check(html,`<span class="sdx-os-support-value"><span class="sdx-fact-line"><span class="sdx-pill sdx-pill-warning"><i aria-hidden="true"></i>Evaluation: 47 days left</span></span><small>Expires on ${date(47*day)}.</small></span>`,'the pill and the meta line');

// ---- Sample devices ----
{
 const {servers}=demoData(),byId=Object.fromEntries(servers.map(device=>[device.id,device]));
 const at=Date.now(),textOf=id=>windowsLicenseText(byId[id],at,'en');
 check([textOf('demo-db').text,textOf('demo-db').tone],['Evaluation: 47 days left','warning'],'SRV-SQL01: a warned evaluation with 47 days left');
 check(byId['demo-db'].issues.filter(item=>item.ruleId==='windows-evaluation').map(item=>[item.level,item.params.daysLeft]),[['warning',47]],'SRV-SQL01: the evaluation warning');
 check(deviceIssues(byId['demo-file'],at,'en').filter(item=>item.key==='windows-not-activated').map(item=>[item.title,item.level]),[['Windows not activated','warning']],'SRV-FILE01: Windows not activated');
 check(textOf('demo-file').text,'Not activated (notification mode)','SRV-FILE01: notification mode');
 check([textOf('demo-app').text,textOf('demo-app').lines[0]],['Activated','Volume license (KMS)'],'SRV-APP01: KMS');
 check(textOf('demo-dc'),{text:'Activated',tone:'ok',lines:['OEM license']},'SRV-DC01: OEM');
 check(servers.flatMap(device=>device.issues.filter(item=>item.ruleId.startsWith('windows-')).map(item=>device.id+':'+item.ruleId)).sort(),['demo-db:windows-evaluation','demo-file:windows-not-activated'],'only the two sample issues');
}

// ---- issueText of both rules ----
const say=(ruleId,params,locale='en')=>issueText({ruleId,params},locale,now);
const product='Windows Server 2025 Standard Evaluation';
check(say('windows-evaluation',{product,date:iso(47*day),daysLeft:47,ended:'false'}),{title:'Windows evaluation ends in 47 days',detail:`${product} runs as an evaluation until ${date(47*day)}. Install a full license before then.`},'ending (en)');
check(say('windows-evaluation',{product,date:iso(47*day),daysLeft:47,ended:'false'},'de'),{title:'Windows-Evaluierung endet in 47 Tagen',detail:`${product} läuft bis ${date(47*day,'de')} als Evaluierungsversion. Installiere vorher eine Volllizenz.`},'ending (de)');
check([say('windows-evaluation',{product,date:iso(day),daysLeft:1,ended:'false'}).title,say('windows-evaluation',{product,date:iso(day),daysLeft:1,ended:'false'},'de').title],['Windows evaluation ends in 1 day','Windows-Evaluierung endet in 1 Tag'],'ending, singular');
check(say('windows-evaluation',{product,date:iso(-2*day),daysLeft:-2,ended:'true'}),{title:'Windows evaluation has ended',detail:`${product}: the evaluation ended on ${date(-2*day)}. Install a full license and activate Windows.`},'ended (en)');
check(say('windows-evaluation',{product,date:iso(-2*day),daysLeft:-2,ended:'true'},'de'),{title:'Windows-Evaluierung ist beendet',detail:`${product}: Die Evaluierung ist am ${date(-2*day,'de')} abgelaufen. Installiere eine Volllizenz und aktiviere Windows.`},'ended (de)');
check(say('windows-evaluation',{product,date:null,daysLeft:0,ended:'true'}),{title:'Windows evaluation has ended',detail:`${product}: the evaluation has ended or was never activated. Install a full license and activate Windows.`},'ended without a date (en)');
check(say('windows-evaluation',{product,date:null,daysLeft:0,ended:'true'},'de').detail,`${product}: Die Evaluierung ist abgelaufen oder wurde nie aktiviert. Installiere eine Volllizenz und aktiviere Windows.`,'ended without a date (de)');
check(say('windows-evaluation',{product,date:null,daysLeft:null,ended:'false'}),{title:'Windows evaluation edition',detail:`${product} runs as an evaluation. Windows does not report when it ends.`},'unknown end (en)');
check(say('windows-evaluation',{product,date:null,daysLeft:null,ended:'false'},'de'),{title:'Windows-Evaluierungsversion',detail:`${product} läuft als Evaluierungsversion. Windows meldet nicht, wann sie endet.`},'unknown end (de)');
const notActivated=(status,date=null)=>({status,channel:'retail',date,daysLeft:null});
check(say('windows-not-activated',notActivated('initial-grace',iso(25*day))),{title:'Windows not activated',detail:`The grace period ends on ${date(25*day)}. Activate Windows before then.`},'grace with a date (en)');
check(say('windows-not-activated',notActivated('extended-grace',iso(25*day)),'de'),{title:'Windows nicht aktiviert',detail:`Die Kulanzzeit endet am ${date(25*day,'de')}. Aktiviere Windows vorher.`},'grace with a date (de)');
check([say('windows-not-activated',notActivated('additional-grace')).detail,say('windows-not-activated',notActivated('additional-grace'),'de').detail],['Windows runs in a grace period. Activate Windows before it ends.','Windows läuft in einer Kulanzzeit. Aktiviere Windows, bevor sie endet.'],'grace without a date');
check([say('windows-not-activated',notActivated('notification')).detail,say('windows-not-activated',notActivated('notification'),'de').detail],['Windows runs in notification mode. Activate Windows with a valid product key.','Windows läuft im Benachrichtigungsmodus. Aktiviere Windows mit einem gültigen Produktschlüssel.'],'notification');
check([say('windows-not-activated',notActivated('non-genuine-grace',iso(day))).detail,say('windows-not-activated',notActivated('non-genuine-grace'),'de').detail],['Windows reports the license as not genuine. Activate Windows with a valid product key.','Windows meldet die Lizenz als nicht echt. Aktiviere Windows mit einem gültigen Produktschlüssel.'],'not genuine');
check([say('windows-not-activated',notActivated('unlicensed')).detail,say('windows-not-activated',notActivated('unlicensed'),'de').detail],['Windows has no valid license. Activate Windows with a valid product key.','Windows hat keine gültige Lizenz. Aktiviere Windows mit einem gültigen Produktschlüssel.'],'unlicensed');

console.log(`PASS Windows license view (${checks} checks): the fact "Windows activation" for every state in English and German with the tone from the issue, the rendered pill, the sample devices, and the issue texts of both rules.`);
