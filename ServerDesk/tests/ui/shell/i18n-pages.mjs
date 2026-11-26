// The translated pages: sign-in and session screens, console content, device
// pages, settings and automation. In English they show no German text; without a
// locale and in German they show the same text as before. Helpers without hooks
// take the locale as their last parameter and default to German.
import {mock} from '../../support/register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {germanIn,visible} from '../../support/german-text.mjs';

let cookieJar={};
mock('next/headers',{cookies:async()=>({get:name=>cookieJar[name]!==undefined?{name,value:cookieJar[name]}:undefined}),headers:async()=>new Headers()});

const {translate}=await import('../../../lib/i18n/translate.ts');
const {default:en}=await import('../../../lib/i18n/messages/en.ts');
const {default:de}=await import('../../../lib/i18n/messages/de.ts');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const h=React.createElement,read=file=>fs.readFileSync(file,'utf8');
const render=(locale,node)=>renderToStaticMarkup(locale?h(LocaleProvider,{locale},node):node);
const noop=()=>{};
let checks=0;
const english=(html,label)=>{assert.deepEqual(germanIn(visible(html)),[],`${label}: no German text in English`);checks++;};

// Page metadata: the description follows the locale cookie, the title stays.
{
 const {generateMetadata}=await import('../../../app/layout.tsx');
 const meta=async cookies=>{cookieJar=cookies;return generateMetadata();};
 const [inEnglish,without,french,inGerman]=[await meta({'serverdesk-locale':'en'}),await meta({}),await meta({'serverdesk-locale':'fr'}),await meta({'serverdesk-locale':'de'})];
 assert.equal(inEnglish.description,en['meta.description']);
 assert.equal(without.description,en['meta.description'],'without a cookie and a header the description is English');
 assert.equal(inGerman.description,'Windows Server 2022 / 2025 und Windows 11 überwachen, diagnostizieren und verwalten.');
 assert.equal(french.description,without.description,'an unknown cookie value gives the English text');
 assert.deepEqual([inEnglish.title,without.title],['Nodiverna | Windows Management','Nodiverna | Windows Management']);
 assert.deepEqual(inEnglish.icons,without.icons);
 cookieJar={};checks+=5;
}

// Item 1: sign-in, session screens and their helpers.
{
 const {TopbarStatus}=await import('../../../ui/shell/shell.tsx');
 const {SessionIdleContext,createIdleClock}=await import('../../../ui/session/session-idle.tsx');
 const {default:IdentityEntry}=await import('../../../ui/session/identity-entry.tsx');
 const now=Date.now(),status={authenticated:true,sessionId:'s',lastActivityAt:0,verifiedUntil:now+3600000,idleExpiresAt:now+120000,sessionExpiresAt:now+86400000,idleTimeoutMs:3600000};
 const clock=createIdleClock(()=>now);clock.interact();const idle={status,clock:{...clock,lastInteraction:now-600000,time:now,subscribe:clock.subscribe}};
 const screens=locale=>[render(locale,h(SessionIdleContext.Provider,{value:idle},h(TopbarStatus,{freshness:''}))),render(locale,h(IdentityEntry))].join('\n');
 english(screens('en'),'session screens');
 const german=screens('de');assert.deepEqual(germanIn(visible(screens(undefined))),[],'the session screens are English by default');
 assert.notEqual(screens(undefined),german,'without a provider the screens use the English default');
 assert.ok(germanIn(visible(german)).length>0,'the German screens are German');checks+=2;
 const {passwordProblem,usernameProblem}=await import('../../../ui/session/identity-password.ts');
 assert.equal(usernameProblem('A','de'),de['password.usernameRule']);assert.equal(usernameProblem('A'),en['password.usernameRule']);assert.equal(usernameProblem('A','en'),en['password.usernameRule']);
 assert.equal(usernameProblem('anna.admin'),'');
 assert.notEqual(passwordProblem('short','short'),'');assert.deepEqual(germanIn(passwordProblem('short','short','en')),[]);
 assert.equal(passwordProblem('short','short'),passwordProblem('short','short','en'));
 const {passkeyError}=await import('../../../ui/session/passkey-client.ts');
 const cancelled=Object.assign(new Error('x'),{name:'NotAllowedError'});
 assert.deepEqual(germanIn(passkeyError(cancelled,'en')),[]);assert.equal(passkeyError(cancelled),passkeyError(cancelled,'en'));assert.notEqual(passkeyError(cancelled),passkeyError(cancelled,'de'));
 checks+=8;
}

// Item 2: job labels, maintenance notice and CSV export.
{
 const {jobActionLabel,jobLabel}=await import('../../../ui/shell/console-jobs.tsx');
 const {jobProgress,jobElapsed}=await import('../../../lib/job-display.ts');
 assert.deepEqual(['agent-update','runbook-run','list-processes','restart-service'].map(action=>jobActionLabel(action,'de')),['Agent aktualisieren','Runbook','Prozesse abfragen','Dienst neu starten']);
 assert.deepEqual(['agent-update','runbook-run','list-processes','restart-service'].map(action=>jobActionLabel(action,'en')),['Update agent','Runbook','Query processes','Restart service']);
 assert.deepEqual([jobActionLabel('agent-uninstall','de'),jobActionLabel('agent-uninstall','en')],['Agent deinstallieren','Uninstall agent'],'the uninstall job has its own label');
 assert.equal(jobActionLabel('unknown-action'),'unknown-action','an unknown action keeps its id');
 assert.deepEqual(['pending','running','succeeded','failed','expired','cancelled','unknown','x'].map(state=>jobLabel(state,'de')),['Wartend','Läuft','Erfolgreich','Fehlgeschlagen','Abgelaufen','Abgebrochen','Unterbrochen','Status unbekannt']);
 assert.deepEqual(['pending','running','x'].map(state=>jobLabel(state,'en')),['Waiting','Running','Status unknown']);
 const run={id:'r',serverId:'d',action:'runbook-run',target:'Book',state:'running',createdAt:0,claimedAt:0,result:null,actor:'a',metadata:{completedSteps:1,totalSteps:3,currentStep:2,currentStepName:'Check spooler'}};
 assert.equal(jobProgress(run,'de'),'1/3 Schritte · Schritt 2: Check spooler');assert.equal(jobProgress(run,'en'),'1/3 steps · Step 2: Check spooler');
 assert.equal(jobProgress({...run,metadata:{completedSteps:3,totalSteps:3}},'de'),'3/3 Schritte');
 assert.equal(jobProgress({...run,metadata:{...run.metadata,cancelRequested:true}},'de'),'1/3 Schritte · Abbruch angefordert');
 assert.deepEqual([jobElapsed(run,42000,'de'),jobElapsed(run,125000,'de'),jobElapsed(run,3725000,'de')],['42 s','2 min 5 s','1 h 2 min']);
 assert.deepEqual([jobElapsed(run,42000,'en'),jobElapsed(run,3725000,'en')],['42 s','1 h 2 min']);
 checks+=10;

 const {maintenanceNoticeText,default:MaintenanceNotice}=await import('../../../ui/shell/maintenance-notice.tsx');
 const now=Date.UTC(2026,9,20,12),consequence='werden alte Audit-Einträge und Dateiübertragungen nicht gelöscht, und es wird kein Nutzungsbericht gesendet.',failedRun=' Der letzte Lauf ist fehlgeschlagen. Den Grund siehst du unter Einstellungen → Datenaufbewahrung.';
 const never={lastSuccessAt:null,lastRun:null,stale:true},overdue={lastSuccessAt:now-3*86400000,lastRun:null,stale:true},failed={...overdue,lastRun:{startedAt:now-3600000,finishedAt:now-3500000,status:'failed'}};
 assert.deepEqual(maintenanceNoticeText(never,now,'de'),{title:'Die tägliche Bereinigung ist noch nicht gelaufen.',text:`Die tägliche Bereinigung ist auf dieser Installation noch nie fertig geworden. Bis sie läuft, ${consequence} Öffne Einstellungen → Datenaufbewahrung, um sie jetzt zu starten.`});
 const late=maintenanceNoticeText(failed,now,'de');
 assert.equal(late.title,'Die tägliche Bereinigung ist überfällig.');assert.match(late.text,new RegExp(`^Die tägliche Bereinigung ist zuletzt .+ fertig geworden\\. Bis sie wieder läuft, ${consequence.replace(/[.]/g,'\\.')}${failedRun.replace(/[.]/g,'\\.')}$`));
 assert.equal(maintenanceNoticeText(overdue,now,'de').text.endsWith('Öffne Einstellungen → Datenaufbewahrung, um den Status zu prüfen.'),true);
 for(const status of [never,overdue,failed]){const text=maintenanceNoticeText(status,now,'en');assert.deepEqual(germanIn(text.title+' '+text.text),[],'maintenance text in English');}
 assert.equal(maintenanceNoticeText(failed,now,'en').text.endsWith('The last run failed, and Settings → Data retention shows the reason.'),true);
 const server={id:'d',name:'SRV-01',createdAt:0,lastSeen:now,revoked:0,management:1,snapshot:null};
 // The classic JobsTable is deleted; the job dock renders these labels.
 english(render('en',h(MaintenanceNotice,{status:failed,now}))+['pending','running'].map(state=>jobLabel(state,'en')).join(' '),'job labels and MaintenanceNotice');
 assert.equal(jobActionLabel('restart-service','de'),'Dienst neu starten');assert.match(render('de',h(MaintenanceNotice,{status:never,now})),/Die tägliche Bereinigung ist noch nicht gelaufen\.<\/strong>/);
 checks+=9;

 const {fleetCsv,fleetCsvFileName}=await import('../../../ui/devices/fleet/fleet-csv.ts');
 const devices=[{...server,customerName:'Kunde A',groupName:'Berlin',snapshot:{os:'Windows Server 2022',agentVersion:'4.8.0'}}];
 const header=csv=>csv.slice(1).split('\r\n')[0].replaceAll('"','');
 assert.equal(header(fleetCsv(devices,{},'de')),'Name;Gruppe;Beschreibung;Tags;Betriebssystem;Gerätetyp;Hersteller;Modell;Agent-Version;Letzter Heartbeat');
 assert.equal(header(fleetCsv(devices,{customer:true},'de')),'Name;Kunde;Gruppe;Beschreibung;Tags;Betriebssystem;Gerätetyp;Hersteller;Modell;Agent-Version;Letzter Heartbeat');
 assert.equal(header(fleetCsv(devices,{customer:true},'en')),'Name;Customer;Group;Description;Tags;Operating system;Device type;Manufacturer;Model;Agent version;Last heartbeat');
 assert.equal(header(fleetCsv(devices,{},'en')),'Name;Group;Description;Tags;Operating system;Device type;Manufacturer;Model;Agent version;Last heartbeat');
 assert.equal(fleetCsv(devices,{customer:true}),fleetCsv(devices,{customer:true},'en'),'English is the default');
 assert.equal(fleetCsv(devices,{customer:true},'en').split('\r\n').slice(1).join(),fleetCsv(devices,{customer:true},'de').split('\r\n').slice(1).join(),'the cells do not change');
 const day=new Date(2026,9,16,10).getTime();
 assert.deepEqual([fleetCsvFileName(day),fleetCsvFileName(day,'de'),fleetCsvFileName(day,'en')],['ServerDesk-Devices-2026-10-16.csv','ServerDesk-Geraete-2026-10-16.csv','ServerDesk-Devices-2026-10-16.csv']);
 checks+=7;
}

// Item 3: device helpers and sections.
{
 const {deviceConnection,registrationNote,deviceIssues}=await import('../../../ui/base/ui-device.ts');
 const now=Date.UTC(2026,9,20,12);
 const snapshot={cpu:85,memory:42,cores:4,disks:[{name:'C:',totalGb:20,freeGb:1.5}],rebootPending:false,collectionErrors:[],updates:{checkedAt:new Date(now-86400000).toISOString(),pendingCount:1,items:[]}};
 const {defaultAlertSettings,evaluateAlertRules}=await import('../../../lib/alert-rules.ts');
 // The issues come from the server's rule evaluation (lib/alert-rules.ts), here with the defaults.
 const device={id:'d',name:'SRV-01',createdAt:0,lastSeen:now-1000,revoked:0,management:1,snapshot},online={...device,issues:evaluateAlertRules(device,defaultAlertSettings(),now)},waiting={...online,lastSeen:null,snapshot:null,registration:{expiresAt:now-1}};
 assert.deepEqual([deviceConnection(online,now,'de').label,deviceConnection(online,now,'en').label],['Online','Online']);
 assert.deepEqual([deviceConnection(waiting,now,'de').label,deviceConnection(waiting,now,'en').label],['Registrierung abgelaufen','Registration expired']);
 assert.deepEqual([registrationNote({registration:{expiresAt:null}},now,'de'),registrationNote({registration:{expiresAt:null}},now,'en')],['Registrierung ohne Ablauf','Registration without expiry']);
 const issues=locale=>deviceIssues(online,now,locale).map(issue=>`${issue.title}: ${issue.detail}`);
 // One pending update reads in the singular, the only change to the German text.
 assert.deepEqual(issues('de'),['CPU erhöht: 85 %','C: wenig frei: 1,5 GB · 8 % frei','1 Update verfügbar: Suche vom 19.10.2026']);
 assert.deepEqual(issues('en'),['CPU high: 85%','C: low on space: 1.5 GB · 8% free','1 update available: Search from 10/19/2026']);
 checks+=5;

 const services=await import('../../../ui/devices/management/service-view.ts'),updates=await import('../../../ui/devices/management/update-view.ts'),network=await import('../../../ui/devices/management/network-panel.ts'),storage=await import('../../../ui/devices/management/storage-size.ts');
 assert.deepEqual([services.serviceStartupLabel('Auto','de'),services.serviceStartupLabel('Auto','en'),services.serviceStatusLabel('Running','de'),services.serviceStatusLabel('Running','en')],['Automatisch','Automatic','Läuft','Running']);
 assert.deepEqual([updates.updateSeverity('Critical','de'),updates.updateSeverity('Critical','en')],['Kritisch','Critical']);
 assert.deepEqual([network.adapterStatus('Up','de'),network.adapterStatus('Up','en')],['Verbunden','Connected']);
 const bounds={minMiB:1024,maxMiB:4096,defaultMiB:2048};
 const [small,smallEn]=[storage.parseStorageSize('0.5','GiB',bounds,'de'),storage.parseStorageSize('0.5','GiB',bounds,'en')];
 assert.equal(small.ok,false);assert.equal(smallEn.ok,false);assert.notEqual(small.error,smallEn.error);assert.deepEqual(germanIn(smallEn.error),[]);
 checks+=6;

 const {deviceSections,deviceSectionLabels}=await import('../../../lib/console-route.ts');
 for(const section of deviceSections){assert.ok(Object.hasOwn(en,section.label)&&Object.hasOwn(de,section.label),`${section.id} has a key`);assert.equal(translate('de',section.label),de[section.label]);assert.notEqual(translate('en',section.label),'');checks++;}
 assert.deepEqual(deviceSections.map(section=>translate('de',section.label)),['Überblick','Hardware','Software','Diagnose','Verwaltung','Fernzugriff','Automation','Historie','Monitoring','Konfiguration']);
 assert.deepEqual(Object.fromEntries(Object.entries(deviceSectionLabels).map(([id,key])=>[id,de[key]])),{overview:'Überblick',hardware:'Hardware',software:'Software',monitoring:'Monitoring',configuration:'Konfiguration',diagnostics:'Diagnose',management:'Verwaltung',remote:'Fernzugriff',automation:'Automation',history:'Historie',extensions:'Erweiterungen',files:'Dateien',terminal:'Terminal',rdp:'Remote Desktop',drift:'Konfigurationsdrift',desired:'Sollkonfiguration',runbooks:'Runbooks'});
 assert.deepEqual(germanIn(Object.values(deviceSectionLabels).map(key=>en[key]).join(' ')),[],'the sections in English');
 checks+=2;
}

// Item 4: settings panels in English, and the constants shared with the server.
{
 const {default:AuditLog}=await import('../../../ui/settings/audit-log.tsx');
 const {default:RolesFeatures}=await import('../../../ui/devices/management/roles-features.tsx');
 const entries=[{id:1,at:Date.UTC(2026,9,20,12),actor:'owner@example.test',action:'job.create',target:'SRV-01',serverId:null,scope:'portal',customerName:'Contoso'},{id:2,at:Date.UTC(2026,9,20,13),actor:'owner@example.test',action:'session.login',target:'',serverId:null,scope:'portal'}];
 const features=[{name:'Web-Server',displayName:'Web Server (IIS)',installed:true,type:'Role',parent:null,depth:0},{name:'Web-Ftp',displayName:'FTP Server',installed:false,type:'Role Service',parent:'Web-Server',depth:1}];
 const settings=locale=>render(locale,h(AuditLog,{entries,multipleCustomers:true}))+render(locale,h(AuditLog,{entries:[]}))+render(locale,h(RolesFeatures,{server:{id:'srv',name:'SRV-01',lastSeen:Date.now(),revoked:0,management:1,snapshot:{mode:'Management',features,agentCapabilities:['install-feature','remove-feature']}},viewer:{id:'owner',label:'owner',permissions:['*']},demo:false,saving:false,onConfirm:noop,now:Date.now()}));
 english(settings('en'),'AuditLog and RolesFeatures');
 const german=settings('de');
 assert.match(german,/aria-label="Audit-Protokoll"/);assert.match(german,/Noch keine Audit-Einträge</);assert.match(german,/>Contoso</);assert.match(german,/2 von 2 Einträgen/);assert.match(german,/Art der Aktion/);

 const {crossCustomerRightKey}=await import('../../../ui/base/cross-customer.ts'),{crossCustomerPermissionLabelKey}=await import('../../../lib/cross-customer-right.ts');
 // The client shows the right through its key, the same key as the role editor; it reads no German lib constant.
 assert.equal(crossCustomerRightKey,crossCustomerPermissionLabelKey);assert.equal(de[crossCustomerRightKey],'Aktionen für mehrere Kunden starten');assert.equal(en[crossCustomerRightKey],'Start actions for several customers');assert.doesNotMatch(read('ui/base/cross-customer.ts'),/crossCustomerPermissionLabel\b|Message\b/,'ui/base/cross-customer.ts reads keys, not lib texts');
 // The role editor and the group grant editor translate the labelKey of a right (ui/settings/access-model.ts), never a label from the API.
 for(const file of ['ui/settings/settings-roles.tsx','ui/devices/configuration/permissions-tab.tsx'])assert.doesNotMatch(read(file),/permission\.label\b|\.label\?\?id/,file+' reads no permission label');
 assert.match(read('ui/settings/access-model.ts'),/export type AccessPermission=\{id:string;labelKey:MessageKey\};/);
 checks+=10;
}

// Item 5: automation and agents.
{
 const desired=await import('../../../ui/automation/desired-state-ui.ts');
 assert.deepEqual([0,1800,3600,86400].map(seconds=>desired.desiredScheduleLabel(seconds)),[0,1800,3600,86400].map(seconds=>desired.desiredScheduleLabel(seconds,'en')),'English is the default');
 assert.deepEqual(germanIn([0,1800,3600,86400].map(seconds=>desired.desiredScheduleLabel(seconds,'en')).join(' ')),[]);
 for(const [state,key] of Object.entries(desired.desiredRunStates)){assert.ok(Object.hasOwn(en,key),`${state} has a key`);checks++;}
 assert.deepEqual(Object.fromEntries(Object.entries(desired.desiredRunStates).map(([state,key])=>[state,de[key]])),{pending:'Wartend',running:'Läuft',succeeded:'Abgeschlossen',failed:'Fehlgeschlagen',cancelled:'Abgebrochen',expired:'Ergebnis unbekannt'});
 const {DriftOverview}=await import('../../../ui/automation/drift-overview.tsx');
 const {UsageValues}=await import('../../../ui/settings/usage-data.tsx');
 const at=Date.UTC(2026,9,20,12),data={state:'drifted',baseline:{id:'b',reportId:'r0',policyVersion:1,createdAt:at-86400000,createdBy:'owner'},baselines:[],current:{id:'r1',policyVersion:1,scannedAt:at,receivedAt:at,firstScannedAt:at,scanCount:1,complete:true,state:'drifted',changes:[{key:'k',path:'C:\\App\\app.config',kind:'file',change:'modified'}],errors:[]},history:[],retentionDays:30,historyLimit:20,policy:{enabled:true,version:1}};
 const automation=locale=>render(locale,h(DriftOverview,{data,busy:false,canManage:true,historyDays:7,now:at,onHistoryDays:noop,onEdit:noop,onInspect:noop,onAccept:noop}))+render(locale,h(UsageValues,{payload:{schema:2,instanceId:'instance-1',version:'1.0.0',deviceCount:3}}));
 english(automation('en'),'DriftOverview and UsageValues');
 english(automation(undefined),'DriftOverview and UsageValues by default');assert.ok(germanIn(visible(automation('de'))).length>0,'German with the locale de');
 const guide=await import('../../../ui/devices/add-device/agent-guide.ts');
 const englishInstall=guide.agentInstallCommand(translate('en','agents.install.registrationFile'));
 assert.equal(translate('en','agents.install.registrationFile'),'ServerDesk-DEVICE.registration.json');
 assert.equal(translate('de','agents.install.registrationFile'),'ServerDesk-GERAET.registration.json');
 assert.equal(englishInstall,'.\\ServerDesk.Agent.exe --install --config .\\ServerDesk-DEVICE.registration.json');
 const commands=Object.entries(guide).filter(([,value])=>typeof value==='string').map(([,value])=>value).concat(guide.agentConnectivityCommand('https://portal.example.test'),englishInstall);
 for(const file of ['ui/devices/add-device/agent-guide.ts','ui/devices/add-device/add-device.tsx','ui/settings/troubleshooting.tsx'])assert.doesNotMatch(read(file),/GERAET/,`${file} has no German placeholder`);
 assert.match(read('ui/settings/troubleshooting.tsx'),/agentInstallCommand\(t\('agents\.install\.registrationFile'\)\)/,'troubleshooting reads the placeholder from the catalog');
 // Add device: the downloaded file name, else the placeholder from the catalog.
 assert.match(read('ui/devices/add-device/add-device.tsx'),/const fileName=registration\?\.fileName\?\?t\('agents\.install\.registrationFile'\)/,'Add device reads the placeholder from the catalog');
 const brokerDoc=read('docs/agent-broker-worker.md');assert.ok(brokerDoc.includes('.\\ServerDesk-DEVICE.registration.json'));assert.doesNotMatch(brokerDoc,/GERAET/,'the English docs use the English placeholder');
 // Rendered: step 3 of Add device and the console step "Repair or register again" use the catalog placeholder.
 const {default:AddDevicePage}=await import('../../../ui/devices/add-device/add-device.tsx');
 const addDevice={installer:false,routeCustomerId:'',routeGroupId:'',groups:[],groupCustomers:{},customers:[],multipleCustomers:false,servers:[],now:0,demo:false,owner:true,saving:false,certificate:null,onTab:noop,onEnroll:noop,onRefresh:noop,onOpenDevice:noop};
 const {default:TroubleshootingPage}=await import('../../../ui/settings/troubleshooting.tsx');
 for(const [locale,file] of [['en','ServerDesk-DEVICE.registration.json'],['de','ServerDesk-GERAET.registration.json']]){
  const install=guide.agentInstallCommand(file);
  assert.ok(render(locale,h(AddDevicePage,addDevice)).includes(`<code>${install}</code></pre>`),`${locale}: Add device step 3 shows ${install}`);
  assert.ok(render(locale,h(TroubleshootingPage,{servers:[],now:0,onOpenDevice:noop})).includes(guide.agentUninstallCommand+'\n'+install),`${locale}: the repair step shows uninstall plus install`);
  checks+=2;
 }
 checks+=7;
 assert.ok(commands.length>=10);
 for(const command of commands){assert.doesNotMatch(command,/[äöüÄÖÜß]/,'no umlaut in an agent command');assert.deepEqual(germanIn(command),[],'no German word in an agent command');checks++;}
 checks+=3;
}

// Operation labels: one key per operation id and diagnostics kind; its German text is the server label.
{
 const {operations}=await import('../../../lib/management.ts');
 const {diagnosticDefinitions}=await import('../../../lib/diagnostics.ts');
 const {operationKey,operationText}=await import('../../../ui/base/operation-labels.ts');
 const labels=[...Object.entries(operations),...Object.entries(diagnosticDefinitions)].map(([id,definition])=>[id,definition.label]);
 assert.ok(labels.length>=50,'all operations are listed');
 for(const [id,label] of labels){const key=operationKey(id);assert.ok(key,`${id} has an operation key`);assert.equal(de[key],label,`${id}: the German text equals the server label`);assert.deepEqual(germanIn(operationText(id,'en')),[],`${id}: English label`);checks++;}
 assert.equal(operationText('no-such-operation','en','Fallback'),'Fallback');
 checks++;
}

// Download file names come from the catalogs; German stays byte-equal to the old literals.
{
 assert.equal(translate('en','network.reportFileName',{name:'SRV_APP01'}),'ServerDesk-Network-SRV_APP01.json');
 assert.equal(translate('de','network.reportFileName',{name:'SRV_APP01'}),'ServerDesk-Netzwerk-SRV_APP01.json');
 assert.equal(translate('en','network.diagnosisFileName'),'ServerDesk-Network-diagnosis.json');
 assert.equal(translate('de','network.diagnosisFileName'),'ServerDesk-Netzwerkdiagnose.json');
 assert.equal(translate('en','files.fallbackFileName'),'ServerDesk-File');
 assert.equal(translate('de','files.fallbackFileName'),'ServerDesk-Datei');
 const network=read('ui/devices/management/device-network-panel.tsx'),files=read('ui/devices/remote/file-panel.tsx');
 assert.doesNotMatch(network,/ServerDesk-Netzwerk/,'the network panel has no German file name literal');
 assert.doesNotMatch(files,/ServerDesk-Datei/,'the file panel has no German file name literal');
 assert.match(network,/downloadText\(t\('network\.reportFileName',\{name:/,'the report export reads network.reportFileName');
 assert.match(network,/downloadText\(t\('network\.diagnosisFileName'\)/,'the diagnosis download reads network.diagnosisFileName');
 assert.match(files,/\.pop\(\)\|\|t\('files\.fallbackFileName'\)/,'the file download falls back to files.fallbackFileName');
 checks+=11;
}

// English layout: long words break in drawer headers.
{
 const rule=(css,selector)=>{const start=css.indexOf(selector+' {');assert.ok(start>=0,`rule ${selector} exists`);return css.slice(start,css.indexOf('}',start));};
 const redesign=read('ui/styles/console.css');
 for(const selector of ['.sdx-drawer-head h2','.sdx-drawer-head p'])assert.match(rule(redesign,selector),/overflow-wrap: anywhere;/,`${selector} breaks long words`);
 // Texts that the English shots found German or cut off; German stays as before.
 assert.equal(translate('en','device.health.showMore',{count:2}),'Show 2 more issues');
 assert.equal(translate('de','device.health.showMore',{count:2}),'2 weitere Hinweise zeigen');
 assert.equal(translate('en','rbac.mfaEnabled'),'MFA set up');
 assert.equal(translate('de','rbac.mfaEnabled'),'MFA eingerichtet');
 assert.equal(translate('en','nav.settings.customersHint'),'Create the customers whose devices you manage, with their contacts, data retention and maintenance windows.');
 assert.equal(translate('de','nav.settings.customersHint'),'Erstelle die Kunden, deren Geräte du verwaltest, mit Kontakten, Datenaufbewahrung und Wartungsfenstern.');
 assert.equal(translate('en','device.summary.fullestDrive',{name:'C:'})+' / '+translate('en','device.summary.ofSize',{size:'128 GiB'}),'Fullest drive C: / of 128 GiB');
 assert.equal(translate('de','device.summary.fullestDrive',{name:'C:'})+' / '+translate('de','device.summary.ofSize',{size:'128 GiB'}),'Knappstes Laufwerk C: / von 128 GiB');
 assert.doesNotMatch(read('ui/devices/device/device-summary.tsx'),/gemeldet/);
 for(const file of ['ui/settings/settings-accounts.tsx','ui/settings/settings-user-groups.tsx','ui/settings/settings-roles.tsx','ui/devices/configuration/permissions-tab.tsx','ui/settings/rbac-model.ts'])assert.doesNotMatch(read(file),/eingerichtet/,file);
 checks+=12;
}

// The step-up dialog opens on the MFA error code, never on message text.
for(const file of ['ui/shell/console-action.ts','ui/devices/diagnostics/diagnostics-panels.tsx','ui/automation/drift-panel.tsx']){
 const source=read(file);
 assert.doesNotMatch(source,/MFA|Bestätigung/,`${file} does not read message text`);
 assert.match(source,/opensMfaPrompt\(/,`${file} decides with opensMfaPrompt`);
 checks+=2;
}

// Navigator entries are one line (nodiverna-ui §8): no hint line, so no wrap rule for it in the overlay navigator.
// A long label ends in an ellipsis; the page hint is the page subtitle.
{
 const css=read('ui/styles/console.css');
 assert.doesNotMatch(css,/\.sdx-navlist-text|\.sdx-navlist[^{]*small/,'no hint rule left');
 const label=css.match(/^\.sdx-navlist-label \{([^}]*)\}/m)?.[1]??'';
 assert.match(label,/white-space: nowrap/);assert.match(label,/text-overflow: ellipsis/,'a long label keeps one line');
 checks+=3;
}

console.log(`PASS i18n pages (${checks} checks): metadata, session screens, console labels and CSV, device helpers, settings, automation, operation labels and step-up by error code; English without German, German unchanged.`);
