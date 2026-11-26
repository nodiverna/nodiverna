// Settings › Usage data (ui/settings/usage-data-page.tsx) on the kit: the nav node usage-data (label, hint, group
// System after Audit log, Owner only, palette id, ChartColumn glyph), the help topic in German, the old link
// #settings/license, the page header once in every state, the SettingsPage states (facts Skeleton, LoadFailed with
// Try again), the console refresh, and the usage data card (ui/settings/usage-data.tsx) with its kit Switch, no Edition
// row, the blocked switch without a usage data server and "Don't send". While usage data is off (view.enabled false)
// the page shows the info Notice and the card inert, aria-hidden and blurred (.sdx-usage-disabled) with a blocked Off
// switch, no hint, no kept box and no "Don't send". The copy names no license server. The page runs on the hook cells of
// tests/support/panel-harness.mjs with the real kit. No server or browser is touched.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {panelHarness} from '../../support/panel-harness.mjs';
import {navPage,de,i18nStubs,i18nRequire} from '../../support/i18n-stubs.mjs';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const day=86_400_000,now=Date.UTC(2031,5,1,12);
const jsx=(type,props,key)=>({type,props:props??{},key});
const source=filename=>ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
const usageView=(extra={})=>({enabled:true,consent:null,decidedAt:null,revision:0,server:'none',lastAttemptAt:null,lastSuccessAt:null,lastError:null,payload:{schema:2,instanceId:'0123456789abcdef0123456789abcdef',version:'0.1.0',deviceCount:3},...extra});
let calls=[],usageGet,usagePost;
const shared={ApiError,message:failure=>failure.message,api:async(url,body)=>{calls.push({url,body});return body?usagePost(body):usageGet();}};
const harness=panelHarness({hooked:['ui/settings/usage-data-page.tsx','ui/settings/usage-data.tsx','ui/shell/page-frame.ts'],stubs:{'@/ui/base/api':shared}});
const UsageDataPage=harness.load('ui/settings/usage-data-page.tsx').default,usage=harness.load('ui/settings/usage-data.tsx');
const kit=harness.load('ui/kit/kit.tsx'),field=harness.load('ui/kit/field.tsx');
const {usageStatusText,usageErrorText,shouldAskUsageConsent}=usage;

// 1. The navigation node, the palette entry, the help topic and the old link.
await import('../../support/register.mjs');
const navModel=await import('../../../ui/shell/nav-model.ts');
const route=await import('../../../lib/console-route.ts');
check(navPage(navModel,'usage-data'),{id:'usage-data',label:'Nutzungsdaten',description:'Lege fest, ob Nodiverna einmal am Tag einige technische Werte sendet, um das Produkt zu verbessern.',icon:'ChartColumn',group:'System'},'the node: label, hint, glyph and group System');
const settingsIds=navModel.navigatorPages('settings',{viewer:{permissions:['*']}}).map(node=>node.section??node.agentTab);
check(settingsIds.slice(-2),['audit','usage-data'],'Usage data comes after Audit log');
check([true,false,false].map((expected,index)=>navModel.navigatorPages('settings',{viewer:[{permissions:['*']},{permissions:['portal.users.manage','portal.roles.manage','portal.userGroups.manage','portal.roleAssignments.manage','portal.notifications.manage']},{permissions:[]}][index]}).some(node=>node.id==='settings.usage-data')),[true,false,false],'only global Owners see the page');
const node=navModel.navNode('settings.usage-data');
check([node.palette.id,node.palette.keywordsKey,node.help,href(node)],['page-settings-usage-data','usageData.paletteKeywords','usageData','#settings/usage-data'],'the palette entry, the help topic and the route');
function href(item){return route.consoleRouteHash(item.route);}
check([route.parseConsoleRoute('#settings/license'),route.consoleRouteHash(route.parseConsoleRoute('#settings/license')),route.parseConsoleRoute('#administration/license')],[{view:'settings',page:'usage-data'},'#settings/usage-data',{view:'settings',page:'usage-data'}],'the old License links open Usage data');
ok(fs.readFileSync('ui/shell/nav-icons.ts','utf8').includes('ChartColumn'),'the glyph ChartColumn is registered');
const loadModule=(filename,stubs)=>{const mod={exports:{}};new Function('require','module','exports',source(path.resolve(filename)))(id=>i18nRequire(id)??(Object.hasOwn(stubs,id)?stubs[id]:id.endsWith('.css')?{}:id==='lucide-react'?new Proxy({}, {get:(_target,key)=>String(key)}):id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:(()=>{throw Error('Unexpected import '+id);})()),mod,mod.exports);return mod.exports;};
const help=loadModule('ui/shell/help-panel.tsx',{...i18nStubs,'@/ui/kit/kit':{Drawer:'Drawer',Kbd:'Kbd'},'@/ui/base/docs-base':loadModule('ui/base/docs-base.ts',{}),'@/ui/shell/console-shortcuts':{shortcutList:[]},'@/ui/shell/nav-model':navModel,'@/ui/base/health-score':loadModule('ui/base/health-score.ts',{})});
check(help.topicFor({view:'settings',page:'usage-data'}),{title:'Nutzungsdaten',tips:['Das Portal sendet Nutzungsdaten nur, wenn ein Owner zustimmt, und höchstens einmal am Tag.','Die Werte enthalten keine Namen, Adressen oder Gerätedaten. Diese Seite zeigt jeden Wert, bevor er gesendet wird.'],docs:[{label:'Daten zur Produktverbesserung',file:'docs/usage-data.md'}]},'the help topic in German');
check(de('usage.consentNo'),'Nodiverna sendet nie Namen, Adressen, Inhalte oder andere Daten deiner Geräte. Du kannst deine Wahl jederzeit unter Einstellungen → Nutzungsdaten ändern.','the consent names the page');
assert.doesNotMatch(fs.readFileSync('ui/shell/console-shortcuts.ts','utf8'),/usage|Nutzungsdaten/i,'no new shortcut');checks++;

// 2. The page on the kit.
let tree=null,frame=null;
const header=primary=>({type:'PageHeader',props:{primary}});
const render=()=>{tree=harness.tree(UsageDataPage,{frame});return tree;};
const settle=async()=>{for(let round=0;round<4;round++){await harness.flush();render();}};
async function startPage({usageData=()=>usageView()}={}){
 harness.reset();calls=[];usageGet=async()=>usageData();usagePost=async body=>usageView({consent:body.enabled,revision:1});
 frame={header,refresh:0,tab:'',onTab(){}};render();await settle();
}
const all=predicate=>harness.walk(tree).filter(predicate);
const headers=()=>all(item=>item.type==='PageHeader');
const page=()=>harness.find(tree,item=>item.type===kit.SettingsPage);
const cards=()=>all(item=>item.type===usage.UsageDataCard);
{
 await startPage({usageData:()=>new Promise(()=>{})});
 check([headers().length,headers()[0].props.primary,page().props.loading,page().props.label,cards().length],[1,undefined,true,de('nav.settings.usageData'),0],'loading: the header once, the facts Skeleton');
 let fail=true;
 await startPage({usageData:()=>{if(fail)throw new ApiError('Die Nutzungsdaten konnten nicht geladen werden.',503);return usageView();}});
 check([headers().length,page().props.loadError,page().props.loading,cards().length],[1,'Die Nutzungsdaten konnten nicht geladen werden.',false,0],'error: the header once and LoadFailed');
 fail=false;page().props.onRetry();await settle();
 check([page().props.loadError,cards().length,calls.length],[undefined,1,2],'Try again repeats the GET and shows the card');
 await startPage();
 check([headers().length,headers()[0].props.primary,cards().length,cards()[0].props.view.payload.deviceCount],[1,undefined,1,3],'loaded: the header without a primary and the usage data card');
 ok(!all(item=>item.type==='h2').length,'no in-page heading');
 const before=calls.length;frame={...frame,refresh:1};render();await harness.flush();render();
 check([calls.slice(before).map(call=>call.url),page().props.loading,cards().length],[['/api/usage-data'],false,1],'refresh: one GET, the card stays');
}

// 3. The usage data card.
let cardTree=null,cardView=null,reloads=0;
const renderCard=()=>{cardTree=harness.tree(usage.UsageDataCard,{view:cardView,onChange:next=>{cardView=next;},reload:async()=>{reloads++;}});return cardTree;};
const cardFind=predicate=>harness.find(cardTree,predicate);
const usageSwitch=()=>cardFind(item=>item.type===field.Switch);
// UsageValues is a component of usage-data.tsx without hooks of its own: its element is expanded to the kit Facts.
const facts=()=>{const values=cardFind(item=>item.type===usage.UsageValues),facts=values.type(values.props);return facts.props.items.map(item=>[item.label,item.value,!!item.mono]);};
async function startCard(view){harness.reset();calls=[];reloads=0;cardView=view;renderCard();}
{
 await startCard(usageView({consent:true,server:'configured',revision:4,lastAttemptAt:now-day,lastSuccessAt:now-day}));
 const card=cardTree.props;
 check([card.title,card.description,card.icon.displayName,card.iconTone],[de('usage.title'),de('usage.sectionHint'),'ChartColumn','accent'],'the card head');
 check([usageSwitch().props.label,usageSwitch().props.checked,usageSwitch().props.hint,usageSwitch().props.blocked],[de('usage.switch'),true,usageStatusText(cardView,'de'),null],'the kit Switch with the status line as its hint');
 check(facts(),[[de('usage.instanceId'),'0123456789abcdef0123456789abcdef',true],[de('usage.version'),'0.1.0',false],[de('usage.devices'),3,false]],'What is sent: three values, no Edition row');
 ok(harness.text(cardFind(item=>item.type==='h3'))===de('usage.whatIsSent'),'the Facts are named What is sent');
 usagePost=async body=>usageView({consent:body.enabled,server:'configured',revision:5});
 await usageSwitch().props.onChange(false);renderCard();
 check([calls.at(-1),harness.toasts.splice(0),cardView.consent],[{url:'/api/usage-data',body:{action:'set',enabled:false,revision:4}},[de('usage.saved.off')],false],'off saves at once without MFA');
 await usageSwitch().props.onChange(true);check(harness.toasts.splice(0),[de('usage.saved.on')]);
 // A failure rejects, so the Switch rolls back with toast.error; a 409 loads the view again first.
 usagePost=async()=>{throw new ApiError('Nur Owner.',403);};
 await assert.rejects(usageSwitch().props.onChange(false),/Nur Owner\./);check(reloads,0,'a refusal does not reload');
 usagePost=async()=>{throw new ApiError('Geändert.',409);};
 await assert.rejects(usageSwitch().props.onChange(false),/Geändert\./);check(reloads,1,'a 409 loads the view again');
 // Without a usable usage data server the switch is blocked, shows Off and leaves out the status line.
 for(const [server,reason] of [['none','usage.status.noServer'],['invalid','usage.status.invalidServer']]){
  await startCard(usageView({consent:false,server}));
  check([usageSwitch().props.blocked,usageSwitch().props.checked,usageSwitch().props.hint,cardFind(item=>item.props?.className==='sdx-usage-kept')],[de(reason),false,undefined,undefined],`${server}: blocked with its reason, Off, no status hint`);
 }
 await startCard(usageView({consent:true,server:'none',revision:2}));
 const kept=cardFind(item=>item.props?.className==='sdx-usage-kept');
 check([usageSwitch().props.checked,harness.text(harness.walk(kept).find(item=>item.type==='p'))],[false,de('usage.keptChoice')],'a stored "send" is kept and said');
 const dontSend=harness.walk(kept).find(item=>item.type===kit.Btn);
 check([dontSend.props.size,dontSend.props.variant,harness.text(dontSend)],['sm',undefined,de('usage.consent.dontSend')],'a secondary small "Don\'t send"');
 usagePost=async body=>usageView({consent:body.enabled,server:'none',revision:3});
 dontSend.props.onClick();await harness.settle();renderCard();
 check([calls.at(-1).body,harness.toasts.splice(0),cardFind(item=>item.props?.className==='sdx-usage-kept')],[{action:'set',enabled:false,revision:2},[de('usage.saved.off')],undefined],'Don\'t send withdraws the decision');
}

// 4. The status line, case by case, and the error texts.
const date=ms=>new Date(ms).toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'});
const status=extra=>usageStatusText(usageView({consent:true,server:'configured',...extra}));
check(usageStatusText(usageView({consent:null,server:'configured',lastSuccessAt:now})),'Du hast noch nicht entschieden. Bis dahin sendet Nodiverna nichts.');
check(usageStatusText(usageView({consent:false,server:'none',lastError:'network',lastAttemptAt:now})),'Nodiverna sendet keine Nutzungsdaten.','off wins over every server state');
check(status({server:'none',lastError:'network',lastAttemptAt:now}),'Auf dieser Installation ist kein Server für Nutzungsdaten eingerichtet, deshalb sendet Nodiverna nichts.');
check(status({server:'invalid'}),'Die Adresse des Servers für Nutzungsdaten (LICENSE_SERVER_URL) ist ungültig, deshalb sendet Nodiverna nichts.');
check(status({lastError:'http-503',lastAttemptAt:now,lastSuccessAt:now-2*day}),`Der letzte Versuch am ${date(now)} ist fehlgeschlagen: Der Server für Nutzungsdaten antwortete mit HTTP 503. Nodiverna versucht es 20 Stunden später erneut.`);
check(status({lastError:'network',lastAttemptAt:now-day,lastSuccessAt:now-day}),`Zuletzt gesendet am ${date(now-day)}.`,'an error older than the last success is not shown');
check(status({}),'Bisher wurde nichts gesendet. Nodiverna sendet die Werte einmal am Tag.');
check([usageErrorText('timeout'),usageErrorText('network'),usageErrorText('http-404'),usageErrorText('internal')],['Der Server für Nutzungsdaten hat nicht rechtzeitig geantwortet','Der Server für Nutzungsdaten war nicht erreichbar','Der Server für Nutzungsdaten antwortete mit HTTP 404','Unbekannter Fehler']);
check([usageErrorText('timeout','en'),usageStatusText(usageView({consent:true,server:'none'}),'en')],['The usage data server did not answer in time','This installation has no usage data server, so Nodiverna sends nothing.'],'the English texts');
check([shouldAskUsageConsent({id:'o',label:'o',permissions:['*']},usageView()),shouldAskUsageConsent({id:'o',label:'o',permissions:['*']},usageView({enabled:false}))],[true,false],'asked only while on');

// 5. Usage data off: the notice, then the card inert, aria-hidden and blurred.
{
 const offCard=(view)=>{cardView=view;renderCard();return cardTree;};
 for(const consent of [null,false,true]){
  await startPage({usageData:()=>usageView({enabled:false,consent,server:'configured',lastSuccessAt:now})});
  const body=harness.walk(page()).filter(item=>item.type===kit.Notice||item.props?.className==='sdx-usage-disabled');
  check(body.map(item=>item.type===kit.Notice?'notice':'wrapper'),['notice','wrapper'],`off, consent ${consent}: the notice comes before the wrapper`);
  const [notice,wrapper]=body;
  check([notice.props.tone,notice.props.icon.displayName??notice.props.icon,harness.text(notice)],['info','Info',de('usage.disabled.notice')],'the info Notice with the German text');
  check([wrapper.type,wrapper.props.inert,wrapper.props['aria-hidden']],['div',true,'true'],'the wrapper is inert and aria-hidden');
  const held=harness.walk(wrapper).filter(item=>item.type===usage.UsageDataCard);
  check([held.length,cards().length,held[0].props.view.enabled,held[0].props.view.consent],[1,1,false,consent],'the wrapper holds the one card');
  await startCard(usageView({enabled:false,consent,server:'configured',revision:3,lastSuccessAt:now}));offCard(cardView);
  check([usageSwitch().props.checked,usageSwitch().props.blocked,usageSwitch().props.hint],[false,de('usage.disabled.notice'),undefined],`off, consent ${consent}: the switch is Off, blocked with the notice, no hint`);
  check([cardFind(item=>item.props?.className==='sdx-usage-kept'),harness.walk(cardTree).filter(item=>item.type===kit.Btn).length],[undefined,0],'no kept box and no Don\'t send button');
  check(facts().map(item=>item[1]),['0123456789abcdef0123456789abcdef','0.1.0',3],'the payload values stay visible behind the blur');
 }
 for(const server of ['none','invalid']){
  await startCard(usageView({enabled:false,consent:true,server}));
  check([usageSwitch().props.blocked,cardFind(item=>item.props?.className==='sdx-usage-kept')],[de('usage.disabled.notice'),undefined],`off with server ${server}: the notice is the reason, no kept box`);
 }
 // On: no notice and no wrapper.
 await startPage({usageData:()=>usageView({consent:true,server:'none'})});
 check([all(item=>item.type===kit.Notice).length,all(item=>item.props?.className==='sdx-usage-disabled').length,cards().length],[0,0,1],'on: no notice, no wrapper, the card');
 const css=fs.readFileSync('ui/settings/usage-data.css','utf8'),rule=/\.sdx-usage-disabled\s*\{([^}]*)\}/.exec(css)?.[1]??'';
 ok(/filter:\s*blur\(\d+(?:\.\d+)?px\)/.test(rule)&&/opacity:\s*\.\d+/.test(rule)&&/pointer-events:\s*none/.test(rule)&&/user-select:\s*none/.test(rule),'.sdx-usage-disabled blurs, dims and blocks the pointer and selection');
 ok(!/transition|animation/.test(rule)&&!css.includes('@keyframes'),'the blur is static');
}

// 6. Copy: no license server in the usage texts.
{
 const catalog=file=>[...fs.readFileSync(file,'utf8').matchAll(/^ {2}'(usage\.[^']+)': '((?:[^'\\]|\\.)*)',$/gm)].map(match=>[match[1],match[2]]);
 const en=catalog('lib/i18n/messages/en.ts'),deCatalog=catalog('lib/i18n/messages/de.ts');
 ok(en.length>20&&deCatalog.length===en.length,'both catalogs have the usage keys');
 // The environment variable keeps its name; it is not the word "license".
 check(en.filter(([,value])=>/license/i.test(value.replaceAll('LICENSE_SERVER_URL',''))).map(([key])=>key),[],'no usage.* value in en.ts says license');
 check(deCatalog.filter(([,value])=>/Lizenz/i.test(value)).map(([key])=>key),[],'no usage.* value in de.ts says Lizenz');
 check([de('usage.disabled.notice'),de('usage.keptChoice'),de('usage.noServer'),de('usage.sectionHint')],['Das Senden von Nutzungsdaten ist auf dieser Installation nicht verfügbar.','Deine Wahl „Nutzungsdaten senden“ ist gespeichert. Nodiverna beginnt zu senden, sobald auf dieser Installation ein Server für Nutzungsdaten eingerichtet ist.','Auf dieser Installation ist noch kein Server für Nutzungsdaten eingerichtet, deshalb sendet Nodiverna nichts.','Die Werte helfen, Nodiverna zu verbessern, und enthalten keine personenbezogenen Daten. Schalte „Nutzungsdaten senden“ ein, um sie zu senden, und sieh dir unten jeden Wert an. Du kannst das jederzeit wieder ausschalten.'],'the German texts');
 for(const file of ['ui/settings/usage-data.tsx','app/api/usage-data/route.ts','runtime/usage-report.mjs'])ok(!/license server/i.test(fs.readFileSync(file,'utf8')),`${file}: comments say usage data server`);
}

// 7. Kit only, tokens only.
for(const file of ['ui/settings/usage-data-page.tsx','ui/settings/usage-data.tsx']){
 const text=fs.readFileSync(file,'utf8');
 ok(!/@\/components\/ui\/|ErrorNote|skeleton-bar|<select\b|role="switch"|opensMfaPrompt|'Version'|'MSP'|'Community'|RefreshCw|[Ee]dition/.test(text),`${file}: kit only, no edition`);
}
ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(fs.readFileSync('ui/settings/usage-data.css','utf8')),'usage-data.css: tokens only');

console.log(`PASS usage data page (${checks} checks): the nav node, palette, help and old link, the page states, the card without an Edition row, the switch and the status texts, the disabled page (notice, inert blurred card) and the copy without a license server.`);
