// Server messages in both languages: the catalog texts of the API errors and the
// server messages, apiErrorText and the client readers, the stored status texts
// and their resolver, the cross-customer texts on the client and the built-in roles.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {germanIn} from '../support/german-text.mjs';

const read=file=>readFileSync(file,'utf8');
const {default:en}=await import('../../lib/i18n/messages/en.ts');
const {default:de}=await import('../../lib/i18n/messages/de.ts');
const {translate}=await import('../../lib/i18n/translate.ts');
const {apiErrorText}=await import('../../ui/base/api-error-text.ts');
const {apiErrorCodes}=await import('../../lib/errors/api-error-keys.ts');
const {errorCatalog}=await import('../../lib/errors/codes.ts');
const {apiErrorBody}=await import('../../lib/server/errors/failure.ts');
const {HttpError}=await import('../../lib/errors/http-error.ts');
const {serverMessage,serverMessageText,storedMessageText,messageFields,messageFieldsText,storedReason}=await import('../../lib/server-messages.ts');
const fixture=JSON.parse(read('tests/fixtures/server-messages-de.json'));
const t=locale=>(key,params)=>translate(locale,key,params);
let checks=0;

// The German texts are the strings the server sent before the catalog existed
// (the fixture), with {name} placeholders where params replace concatenated parts.
{
 const keys=Object.keys(fixture);
 assert.ok(keys.length>=650,'the fixture lists every server message key');
 for(const key of keys){assert.deepEqual(de[key],fixture[key],`${key}: the German text is unchanged`);checks++;}
 const catalogKeys=Object.keys(en).filter(key=>key.startsWith('apiError.')||key.startsWith('serverMessage.'));
 assert.deepEqual(catalogKeys.filter(key=>!Object.hasOwn(fixture,key)),[],'every server message key has its German text in the fixture');
 for(const key of catalogKeys.filter(key=>key.startsWith('apiError.')))assert.ok(Object.hasOwn(apiErrorCodes,key),`${key} has a code`);
 for(const key of catalogKeys){const text=typeof en[key]==='string'?en[key]:en[key].other;assert.deepEqual(germanIn(text).filter(word=>word!=='umlaut'),[],`${key}: the English text has no German word`);}
 // Fixed English texts.
 assert.equal(en[errorCatalog.MFA_SETUP_REQUIRED.key],'Your account has no MFA set up. Set up an authenticator under My account and try again.');
 assert.equal(en[errorCatalog.TERMINAL_SEQUENCE_CONFLICT.key],'The terminal session was used in another view. Your pending input was not accepted. Enter it again.');
 assert.equal(en[errorCatalog.INTERNAL_ERROR.key],'An internal error occurred in the portal. Try again. If the error persists, give your administrator the reference {reference}.');
 assert.equal(en[errorCatalog.CUSTOMER_MISSING.key],'The customer does not exist or is not assigned to you. Reload the page.');
 assert.deepEqual([en['serverMessage.transfer.revoked'],de['serverMessage.transfer.revoked']],['The permission was revoked, or the transfer expired.','Die Berechtigung wurde entzogen, oder die Übertragung ist abgelaufen.']);
 // The job refusals of an unsupported GPU say what the GPU card says.
 for(const reason of ['unsupportedOs','unsupportedModel'])for(const catalog of [en,de])assert.equal(catalog['apiError.gpuDriver.'+reason],catalog['hardware.gpuDriver.reason.'+reason],`apiError.gpuDriver.${reason} equals the card text`);
 assert.equal(en['apiError.gpuDriver.checkBusy'],'Many driver checks ran in the last few minutes, so the last result is shown. Try again in a few minutes.');
 checks+=11;
}

// The customer, installer, cross-customer and confirmation keys: their names, codes,
// English texts and the German texts of the fixture. The former key groups of the
// license gate are gone (their prefixes are built from parts, as tests/repo/single-edition.mjs forbids them).
{
 const keys={
  'apiError.customer.name':['INVALID_REQUEST','Enter a customer name with 1 to 80 characters.'],
  'apiError.customer.contactName':['INVALID_REQUEST','The contact person can have at most 120 characters.'],
  'apiError.customer.contactEmail':['INVALID_REQUEST','Enter a valid email address or leave the field empty.'],
  'apiError.customer.contactPhone':['INVALID_REQUEST','Enter a phone number with 3 to 40 characters from digits, spaces and + ( ) / - . or leave the field empty.'],
  'apiError.customer.controlCharacters':['INVALID_REQUEST','The details contain control characters that are not allowed. Remove them and try again.'],
  'apiError.customer.retention':['INVALID_REQUEST','Enter the audit retention as a whole number from 1 to 3650 days, or use the default.'],
  'apiError.customer.maintenanceWindow':['INVALID_REQUEST','For the maintenance window, select at least one day, a start on a quarter hour, a duration of at most 12 hours and a valid time zone.'],
  'apiError.customer.status':['INVALID_REQUEST','The customer status is not known.'],
  'apiError.installer.name':['INVALID_REQUEST','Enter a name for the installer with 1 to 80 characters.'],
  'apiError.installer.validDays':['INVALID_REQUEST','Select a validity of 1 to 365 days.'],
  'apiError.installer.maxDevices':['INVALID_REQUEST','Enter the maximum as a whole number from 1 to 10000, or leave the field empty.'],
  'apiError.crossCustomer.right':['CROSS_CUSTOMER_FORBIDDEN','The selection contains devices of several customers. You need the permission “Start actions for several customers” for this. Select devices of one customer or ask an Owner for the permission.'],
  'apiError.crossCustomer.schedule':['INVALID_REQUEST','A schedule applies only to devices of one customer. Create a separate schedule for each customer.'],
  'apiError.mfa.confirmationUsed':['MFA_STEP_UP_REQUIRED','The confirmation expired or was already used. Confirm the action again.'],
 };
 for(const [key,[code,english]] of Object.entries(keys)){
  assert.equal(apiErrorCodes[key],code,`${key}: code`);
  assert.equal(en[key],english,`${key}: English text`);
  assert.equal(de[key],fixture[key],`${key}: German text`);
  assert.equal(new HttpError(key).status,errorCatalog[code].status,`${key}: status of ${code}`);
  checks+=4;
 }
 const gone=['msp','edition'].map(name=>'apiError.'+name+'.');
 for(const catalog of [en,de,fixture,apiErrorCodes])assert.deepEqual(Object.keys(catalog).filter(key=>gone.some(prefix=>key.startsWith(prefix))),[],'no key of the former license gate');
 assert.equal(de['apiError.console.enrollCustomerRequired'],'Wähle einen Kunden für das neue Gerät. Hat das Portal mehr als einen Kunden, gehört jedes neue Gerät ausdrücklich zu einem Kunden.','the German enrollment text names the customers');
 checks+=5;
}

// apiErrorText: key; for a keyed answer the code's default key; the sent text; the fallback.
{
 const body={error:'An agent update is already active or scheduled for device SRV-01.',code:'CONFLICT',messageKey:'apiError.release.updateActive',params:{name:'SRV-01'}};
 assert.equal(apiErrorText('en',body),'An agent update is already active or scheduled for device SRV-01.');
 assert.equal(apiErrorText('de',body),'Für Gerät SRV-01 ist bereits ein Agent-Update aktiv oder geplant.');
 // A missing param falls back to the code's default key.
 assert.equal(apiErrorText('de',{...body,params:{}}),de['apiError.generic.conflict']);
 assert.equal(apiErrorText('en',{...body,params:undefined}),en['apiError.generic.conflict']);
 // An unknown key (a newer server) falls back to the code's default key, never to a raw key.
 assert.equal(apiErrorText('de',{error:'x',code:'MFA_STEP_UP_REQUIRED',messageKey:'apiError.future.key'}),'Bestätige deine Identität erneut.');
 // An unknown code gives the sent text.
 assert.equal(apiErrorText('de',{error:'Sent text.',code:'FUTURE_CODE',messageKey:'apiError.future.key'}),'Sent text.');
 // An empty body gives the fallback, then common.requestFailed.
 assert.equal(apiErrorText('de',{},'Fallback.'),'Fallback.');assert.equal(apiErrorText('en',null,'Fallback.'),'Fallback.');
 assert.match(apiErrorText('en',{}),/^Request failed/);assert.match(apiErrorText('de',undefined),/^Anfrage fehlgeschlagen/);
 // A key without the apiError. prefix is ignored, also when the catalog has it.
 assert.equal(apiErrorText('en',{error:'Sent.',code:'FUTURE',messageKey:'shell.signOut'}),'Sent.');
 assert.equal(apiErrorText('en',{error:'',code:'',messageKey:'shell.signOut'},'Fallback.'),'Fallback.');
 // Params go in as plain text; non-string values are dropped.
 assert.equal(apiErrorText('en',{code:'CONFLICT',messageKey:'apiError.release.sameVersion',params:{name:'<b>x</b>'}}),'Device <b>x</b> already has this version.');
 assert.equal(apiErrorText('en',{code:'CONFLICT',messageKey:'apiError.release.sameVersion',params:{name:{}}}),en['apiError.generic.conflict']);
 // A keyless answer (the text form of HttpError, which only test doubles use) shows its sent text, whatever the code.
 assert.equal(apiErrorText('de',{error:'Kundenname ist bereits vergeben.',code:'CONFLICT'}),'Kundenname ist bereits vergeben.');
 assert.equal(apiErrorText('en',{error:'Eingabe ungültig.',code:'INVALID_REQUEST'}),'Eingabe ungültig.');
 assert.equal(apiErrorText('de',{error:'Nur der Owner darf das.',code:'MFA_STEP_UP_REQUIRED'}),'Nur der Owner darf das.');
 // A keyless answer without a text still gets the code's default key.
 assert.equal(apiErrorText('de',{error:'',code:'CONFLICT'}),de['apiError.generic.conflict']);
 assert.equal(apiErrorText('en',{code:'INVALID_REQUEST'}),en['apiError.request.invalid']);
 // The INTERNAL_ERROR answer carries its reference as a param.
 const internal={...apiErrorBody('apiError.internalError',{reference:'0a1b2c3d'}),reference:'0a1b2c3d'};
 assert.equal(apiErrorText('de',internal),'Im Portal ist ein interner Fehler aufgetreten. Versuche es erneut. Bleibt der Fehler, nenne deinem Administrator die Referenz 0a1b2c3d.');
 // `field` names the form field and stays even when the text does not show it; other unused params go.
 assert.deepEqual(apiErrorBody('apiError.notify.discordUrlWrongType',{field:'url',secret:'x'}),{error:en['apiError.notify.discordUrlWrongType'],code:'NOTIFY_CHANNEL_INVALID',messageKey:'apiError.notify.discordUrlWrongType',params:{field:'url'}});
 assert.deepEqual(apiErrorBody('apiError.notify.httpStatus',{status:500,url:'https://x'}).params,{status:500});
 checks+=22;
}

// readApiJson builds ApiError in the page language and keeps code, key and params.
{
 const http=await import('../../ui/base/http.ts');
 const reply=()=>new Response(JSON.stringify(apiErrorBody('apiError.release.disconnectRdp',{name:'SRV-01'})),{status:409,headers:{'Content-Type':'application/json'}});
 const failure=async lang=>{globalThis.document={documentElement:{lang}};try{await http.readApiJson(reply());}catch(error){return error;}finally{delete globalThis.document;}assert.fail('expected an ApiError');};
 const german=await failure('de'),english=await failure('en');
 assert.ok(german instanceof http.ApiError&&english instanceof http.ApiError);
 assert.equal(german.message,'SRV-01 hat offene Remote-Desktop-Sitzungen. Trenne sie und starte das Update erneut.');
 assert.equal(english.message,'SRV-01 has open Remote Desktop sessions. Disconnect them, and start the update again.');
 for(const error of [german,english])assert.deepEqual([error.status,error.code,error.messageKey,error.params],[409,'CONFLICT','apiError.release.disconnectRdp',{name:'SRV-01'}]);
 // message() of the client resolves a keyed error again in the requested language.
 const {message}=await import('../../ui/base/api.tsx');
 assert.equal(message(english,'de'),german.message);assert.equal(message(german,'en'),english.message);
 // A client-side HttpError (the Desired State content check) shows in the page language too.
 const {validateDesiredContent}=await import('../../lib/desired-state-operations.ts');
 let invalid;try{validateDesiredContent('dsc3','not json');}catch(error){invalid=error;}
 assert.equal(message(invalid,'de'),'DSC 3 benötigt ein gültiges JSON-Dokument.');assert.equal(message(invalid,'en'),'DSC 3 needs a valid JSON document.');
 checks+=7;

 // The session lock event carries the text in the page language; the lock branches on the code only.
 const events=[];
 globalThis.window={location:{href:'https://portal.example.test/',origin:'https://portal.example.test'},dispatchEvent:event=>events.push(event)};
 globalThis.document={documentElement:{lang:'de'}};
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify(apiErrorBody('apiError.auth.loginRequired')),{status:401,headers:{'Content-Type':'application/json'}});
 try{await http.credentialFetch('/api/console');}finally{globalThis.fetch=originalFetch;delete globalThis.window;delete globalThis.document;}
 assert.equal(events.length,1);assert.equal(events[0].detail.code,'IDENTITY_LOGIN_REQUIRED');assert.equal(events[0].detail.message,'Melde dich mit Benutzername und Passwort an.');
 // A generic 401 or 403 code locks nothing and opens no MFA dialog.
 globalThis.window={location:{href:'https://portal.example.test/',origin:'https://portal.example.test'},dispatchEvent:event=>events.push(event)};
 globalThis.fetch=async()=>new Response(JSON.stringify(apiErrorBody('apiError.mfa.codeInvalid')),{status:401,headers:{'Content-Type':'application/json'}});
 try{await http.credentialFetch('/api/mfa');}finally{globalThis.fetch=originalFetch;delete globalThis.window;}
 assert.equal(events.length,1,'UNAUTHORIZED does not lock the session');
 checks+=2;

 // console-action shows the toast of a failed action in the console's language.
 const {runConsoleAction}=await import('../../ui/shell/console-action.ts');
 for(const [locale,expected] of [['en','The agent is in maintenance. Try again when it is finished.'],['de','Der Agent wird gerade gewartet. Versuche es nach Abschluss erneut.']]){
  const toasts=[];
  await runConsoleAction({action:'job',id:'d',kind:'refresh'},{demo:false,locale,canOffboard:()=>true,openStepUp:()=>assert.fail('no step-up'),action:async()=>{},setSaving:()=>{},post:async()=>new Response(JSON.stringify(apiErrorBody('apiError.agent.maintenanceRetry')),{status:409,headers:{'Content-Type':'application/json'}}),toast:{error:text=>toasts.push(text),success:()=>{}},onRemoved:()=>{},refresh:async()=>{}});
  assert.deepEqual(toasts,[expected],locale);checks++;
 }
}

// The client reads no server-language text from lib/errors/codes.ts. A cross-customer
// lock gives only the reason of the missing permission, in both languages.
{
 assert.doesNotMatch(read('ui/devices/remote/terminal-panel.tsx'),/errorCatalog\.\w+\.message/);
 for(const file of ['ui/base/cross-customer.ts','ui/settings/customers-panel.tsx'])assert.doesNotMatch(read(file),/\bcrossCustomerScheduleMessage\b/,`${file} uses the keys`);
 const cross=await import('../../ui/base/cross-customer.ts');
 assert.equal(cross.crossCustomerLockReason({permissions:['*']},2,'de'),null,'an Owner holds the permission');
 const english=cross.crossCustomerLockReason({permissions:['view']},2,'en'),german=cross.crossCustomerLockReason({permissions:['view']},2,'de');
 assert.deepEqual(germanIn(english),[],'no German in English');
 assert.equal(german,'Die Auswahl umfasst Geräte mehrerer Kunden. Dafür brauchst du die Berechtigung „Aktionen für mehrere Kunden starten“.','the German reason names the permission');
 checks+=3;
 assert.equal(cross.scheduleCustomerLockReason(2,'de'),'Ein Zeitplan gilt nur für Geräte eines Kunden. Erstelle für jeden Kunden einen eigenen Zeitplan.');
 assert.deepEqual(germanIn(cross.scheduleCustomerLockReason(2,'en')),[]);
 checks+=2;
}

// Display texts in successful answers: the key, the params and the defaultLocale text.
{
 const warning=serverMessage('serverMessage.runbook.crossCustomerWarning',{customers:2});
 assert.deepEqual(warning,{key:'serverMessage.runbook.crossCustomerWarning',params:{customers:2},text:'This run affects devices of 2 customers. Each customer gets its own entry in the audit log.'});
 assert.equal(serverMessageText(warning,t('de')),'Dieser Lauf betrifft Geräte von 2 Kunden. Jeder Kunde erhält einen eigenen Eintrag im Audit-Protokoll.');
 assert.equal(serverMessageText({key:'serverMessage.future',text:'Sent text.'},t('de')),'Sent text.','an unknown key shows the sent text');
 assert.equal(serverMessageText({key:'serverMessage.runbook.crossCustomerWarning',text:'Sent.'},t('de')),'Sent.','a missing param shows the sent text');
 const notice=messageFields('serverMessage.desired.configDeletedNotice');
 assert.equal(notice.message,en['serverMessage.desired.configDeletedNotice']);
 assert.equal(messageFieldsText(notice,t('en'),'fallback'),en['serverMessage.desired.configDeletedNotice']);
 assert.equal(messageFieldsText(notice,t('de'),'fallback'),'Konfiguration und alle Versionen aus der Bibliothek gelöscht. Zuweisungen und geplante Prüfungen wurden entfernt. Die lokale Gerätekonfiguration und der Ausführungsverlauf bleiben bestehen.');
 assert.equal(messageFieldsText({},t('de'),'Gespeichert.'),'Gespeichert.');
 const assigned=messageFields('serverMessage.desired.assigned',{version:3,count:1});
 assert.equal(messageFieldsText(assigned,t('de'),''),'Version v3 einem Gerät zugewiesen.');assert.equal(messageFieldsText({...assigned,messageParams:{version:3,count:4}},t('en'),''),'Version v3 was assigned to 4 devices.');
 for(const file of ['ui/automation/runbook-panel.tsx','ui/automation/desired-state-panel.tsx'])assert.match(read(file),/serverMessageText\(|messageFieldsText\(/,`${file} resolves server messages`);
 assert.match(read('ui/automation/runbook-panel.tsx'),/preview\.warnings\.map\(\(item,index\)=><p key=\{index\}>\{serverMessageText\(item,t\)\}<\/p>\)/);
 assert.match(read('ui/automation/runbook-panel.tsx'),/entry\.preconditionErrors\?\.map\(\(item,index\)=><small className="rb-danger" key=\{index\}>\{serverMessageText\(item,t\)\}<\/small>\)/);
 checks+=12;
}

// Stored status texts hold keys; the resolver turns known keys into text and leaves anything else.
{
 for(const [locale,expected] of [['en','The permission was revoked, or the transfer expired.'],['de','Die Berechtigung wurde entzogen, oder die Übertragung ist abgelaufen.']])assert.equal(storedMessageText('serverMessage.transfer.revoked',t(locale)),expected);
 assert.equal(storedMessageText('apiError.runbook.campaignNotStarted',t('de')),de['apiError.runbook.campaignNotStarted'],'an HttpError reason stored as its key');
 for(const value of ['Berechtigung entzogen oder Transfer abgelaufen','Agent message: access denied','serverMessage.future.key','apiError.release.sameVersion','',null,undefined])assert.equal(storedMessageText(value,t('de')),value,`${value} stays as it is`);
 assert.equal(storedReason(new HttpError('apiError.runbook.campaignNotStarted')),'apiError.runbook.campaignNotStarted');
 assert.equal(storedReason(new HttpError('apiError.runbook.checkParameterConflict',{name:'Path'})),en['apiError.runbook.checkParameterConflict'].replace('{name}','Path'),'with params the defaultLocale text');
 const {agentMessageText}=await import('../../lib/agent-messages.ts');
 assert.equal(agentMessageText({result:'serverMessage.job.pendingExpired'},t('de')),'Wartender Auftrag nach 5 Minuten abgelaufen');
 assert.equal(agentMessageText({result:'serverMessage.job.pendingExpired'},t('en')),'The waiting job expired after 5 minutes.');
 assert.equal(agentMessageText({result:'Done.'},t('de')),'Done.');
 // The writers store keys, never German text, and no server logic compares these columns with text.
 const writers={'lib/server/agent/agent-channel.ts':["message='serverMessage.transfer.revoked'","result='serverMessage.job.resultUnknownInterrupted'"],'lib/server/agent/heartbeat.ts':["result = 'serverMessage.job.pendingExpired'","result = 'serverMessage.job.unsupported'"],'lib/server/identity/access.ts':["message='serverMessage.access.userRightsChanged'","result='serverMessage.job.permissionChanged'"],'lib/server/identity/local-auth.ts':["message='serverMessage.account.changed'"],'lib/server/identity/rbac.ts':["message='serverMessage.access.userRightsChanged'"],'lib/server/devices/device-group-membership.ts':["message='serverMessage.access.userRightsChanged'"],'lib/server/devices/terminal-channel.ts':["error='serverMessage.terminal.expired'"],'lib/server/automation/desired-state.ts':["result='serverMessage.desired.configDeleted'"],'lib/server/automation/automation-device.ts':["result='serverMessage.automation.assignmentChanged'"],'lib/server/automation/runbooks.ts':["result = 'serverMessage.runbook.deletedStepCancelled'","result = 'serverMessage.runbook.campaignStopped'"],'lib/server/devices/rdp.ts':["'serverMessage.rdp.expired'","'serverMessage.rdp.paused'"],'lib/server/automation/automation-runbooks.ts':["'serverMessage.automation.scheduleStarted'"]};
 for(const [file,parts] of Object.entries(writers)){const source=read(file);for(const part of parts){assert.ok(source.includes(part),`${file} writes ${part}`);checks++;}}
 for(const file of Object.keys(writers))assert.doesNotMatch(read(file),/(?:result|message|error)\s*=\s*'[^'$]*[äöüÄÖÜß][^']*'/,`${file} stores no German status text`);
 checks+=6;
}

// Built-in role descriptions come from the catalog; custom roles keep their stored text.
{
 const {roleDescription,builtInRoleDescriptions}=await import('../../ui/settings/rbac-model.ts');
 const owner={id:'builtin-owner',builtIn:true,description:'Vollständiger Portal- und Gerätezugriff im zugewiesenen Geltungsbereich.'};
 assert.equal(roleDescription(owner,t('en')),'Has full access to the portal and to the devices in the assigned scope.');
 assert.equal(roleDescription(owner,t('de')),'Vollständiger Portal- und Gerätezugriff im zugewiesenen Geltungsbereich.');
 assert.equal(roleDescription({id:'custom',builtIn:false,description:'Eigene Rolle'},t('en')),'Eigene Rolle');
 assert.equal(roleDescription({id:'builtin-owner',builtIn:false,description:'Kopie'},t('en')),'Kopie','a custom role with a built-in id keeps its text');
 checks+=4;
 // Every id of builtinRoleIds (lib/server/identity/rbac.ts) has the key rbac.builtInRole.<name> in the panel map and in
 // both catalogs, so a new built-in role cannot fall back to its stored German text. The import must
 // load: a failing import fails the test instead of skipping it.
 const {builtinRoleIds,builtinRoles}=await import('../../lib/server/identity/rbac.ts');
 const roles=Object.entries(builtinRoleIds),ids=Object.values(builtinRoleIds);
 assert.ok(roles.length>=6,'builtinRoleIds is loaded from lib/server/identity/rbac.ts');
 assert.deepEqual(Object.keys(builtInRoleDescriptions).sort(),[...ids].sort(),'the panel map covers exactly the ids of builtinRoleIds');
 const seeded=new Map(builtinRoles().map(role=>[role.id,role.description]));
 assert.deepEqual([...seeded.keys()].sort(),[...ids].sort(),'builtinRoles() seeds one role per id');
 checks+=3;
 for(const [name,id] of roles){
  const key=`rbac.builtInRole.${name}`;
  assert.equal(builtInRoleDescriptions[id],key,`${id}: the panel key is ${key}`);
  assert.ok(Object.hasOwn(en,key),`${key} is in the English catalog`);
  assert.ok(Object.hasOwn(de,key),`${key} is in the German catalog`);
  assert.deepEqual(germanIn(en[key]),[],`${key}: the English text has no German word`);
  assert.equal(de[key],seeded.get(id),`${id}: the German text equals the seeded description`);
  assert.equal(roleDescription({id,builtIn:true,description:'stored'},t('en')),en[key],`${id}: the panel shows the catalog text`);
  checks+=6;
 }
}

console.log(`PASS i18n server (${checks} checks): server texts in both catalogs, apiErrorText, ApiError and the client readers, cross-customer texts on the client, server messages, stored status texts and built-in roles.`);
