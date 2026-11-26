// Settings › Sessions (ui/settings/session-settings-panel.tsx) on the kit: the header once in every state, one SettingsPage
// with exactly one Card "Session rules", one form with the kit Select and the Switch as form fields, hints that follow
// the draft, one FormActions (dirty, Discard, loading), one set request with both values through one step-up, the
// toast, a failure that keeps the draft, no demo block; then the tab, the capability rule, the navigation entries and
// the help topic. The page runs on the hook cells of tests/support/panel-harness.mjs with the real kit and the real
// useStepUp. No server or browser is touched.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {panelHarness} from '../../support/panel-harness.mjs';
import {navPage,de,i18nStubs,i18nRequire,translateModule} from '../../support/i18n-stubs.mjs';
const {translate}=translateModule;

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const jsx=(type,props,key)=>({type,props:props??{},key});
const source=filename=>ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const loadModule=(filename,stubs={})=>{const mod={exports:{}};new Function('require','module','exports',source(path.resolve(filename)))(id=>i18nRequire(id)??(Object.hasOwn(stubs,id)?stubs[id]:id.endsWith('.css')?{}:id==='lucide-react'?new Proxy({}, {get:(_target,key)=>String(key)}):id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:(()=>{throw Error('Unexpected import '+id);})()),mod,mod.exports);return mod.exports;};
class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
const view=(minutes=15,idleRequiresMfa=true)=>({idleTimeoutMinutes:minutes,options:[5,15,30,45],defaultMinutes:15,idleRequiresMfa,mfaGrantHours:8});
// The switch hints name the hours of the MFA grant from mfaGrantHours.
const hint=key=>de(key,{count:8});
let calls=[],get=async()=>view(),post=async body=>view(body.idleTimeoutMinutes,body.idleRequiresMfa);
const shared={ApiError,message:failure=>failure.message,api:async(url,body)=>{calls.push({url,body});assert.equal(url,'/api/session-settings');return body?post(body):get();}};
function MfaStepUp(){return null;}
const harness=panelHarness({hooked:['ui/settings/session-settings-panel.tsx','ui/session/step-up-retry.ts','ui/shell/page-frame.ts'],stubs:{'@/ui/base/api':shared,'@/ui/session/mfa-step-up':{MfaStepUp}}});
const sessionModule=harness.load('ui/settings/session-settings-panel.tsx'),Panel=sessionModule.default;
const kit=harness.load('ui/kit/kit.tsx'),field=harness.load('ui/kit/field.tsx');

let tree=null,frame=null;
const viewer={id:'owner',label:'owner@example.test',permissions:['*']};
const header=primary=>({type:'PageHeader',props:{primary}});
const render=()=>{tree=harness.tree(Panel,{viewer,frame});return tree;};
const settle=async()=>{for(let round=0;round<4;round++){await harness.flush();render();}};
async function startPage({getter=async()=>view(),poster=async body=>view(body.idleTimeoutMinutes,body.idleRequiresMfa)}={}){harness.reset();calls=[];get=getter;post=poster;frame={header,refresh:0,tab:'',onTab(){}};render();await settle();}
const find=predicate=>harness.find(tree,predicate);
const all=predicate=>harness.walk(tree).filter(predicate);
const headers=()=>all(node=>node.type==='PageHeader');
const page=()=>find(node=>node.type===kit.SettingsPage);
const select=()=>find(node=>node.type===field.Select);
const mfaSwitch=()=>find(node=>node.type===field.Switch);
const actions=()=>find(node=>node.type===field.FormActions);
const submit=async()=>{find(node=>node.type==='form').props.onSubmit({preventDefault(){}});render();await settle();};
const stepUp=()=>find(node=>node.type===MfaStepUp);
const posts=()=>calls.filter(call=>call.body).map(call=>call.body);
const toasts=()=>harness.toasts.splice(0);

// The header once without a primary, the SettingsPage states, one card.
{
 await startPage({getter:()=>new Promise(()=>{})});
 check([headers().length,headers()[0].props.primary,page().props.loading,page().props.label],[1,undefined,true,de('nav.settings.sessions')],'loading: the header once and the Skeleton');
 let fail=true;
 await startPage({getter:async()=>{if(fail)throw new ApiError('down',503);return view();}});
 check([headers().length,page().props.loadError],[1,de('sessionSettings.loadError')],'error: the header once and LoadFailed');
 fail=false;page().props.onRetry();await settle();
 check(page().props.loadError,undefined,'Try again loads the settings');
 const cards=all(node=>node.type===kit.Card);
 check(cards.map(card=>[card.props.title,card.props.description,card.props.icon.displayName,card.props.iconTone]),[[de('sessionSettings.card'),de('sessionSettings.cardText'),'ShieldCheck','accent']],'exactly one card "Session rules"');
 check([all(node=>node.type==='form').length,all(node=>node.type===field.FormActions).length,find(node=>node.type==='form').props.className],[1,1,'sdx-form-grid'],'one form with one FormActions');
 ok(!all(node=>node.type==='h2'||node.type==='h3').length&&!all(node=>node.props?.['aria-label']==='Einstellungen neu laden').length,'no card heading "Settings", no refresh button');
}

// The Select and the Switch as form fields, the hints follow the draft, one request through one step-up.
{
 await startPage();
 const signOut=find(node=>node.type===field.Field);
 check([signOut.props.label,signOut.props.hint,select().props.value,harness.walk(select()).filter(node=>node.type==='option').map(node=>harness.text(node))],[de('sessionSettings.signOutAfter'),de('sessionSettings.signOutHint'),15,['5 Minuten','15 Minuten (Standard)','30 Minuten','45 Minuten']],'Sign out after: a kit Select in a Field with its hint');
 check([select().props.fit,select().props.wide],[true,undefined],'Sign out after: content width (Select fit), not the card width');
 check([mfaSwitch().props.label,mfaSwitch().props.checked,mfaSwitch().props.hint],[de('settings.idleMfa.switch'),true,hint('settings.idleMfa.hintOn')],'the MFA switch with the hint for on');
 check([hint('settings.idleMfa.hintOn').includes('8 Stunden'),hint('settings.idleMfa.hintOff').includes('8 Stunden lang'),translate('en','settings.idleMfa.hintOn',{count:8}).includes('within 8 hours'),translate('en','settings.idleMfa.hintOff',{count:8}).includes('for 8 hours'),de('settings.idleMfa.hintOff',{count:1}).includes('1 Stunde lang')],[true,true,true,true,true],'both hints in both languages name the 8 hours, with a singular form');
 check([actions().props.dirty,actions().props.loading],[false,false],'clean: Save is blocked "No changes" (FormActions)');
 mfaSwitch().props.onChange(false);render();
 check([mfaSwitch().props.checked,mfaSwitch().props.hint,actions().props.dirty,posts()],[false,hint('settings.idleMfa.hintOff'),true,[]],'the switch changes the draft only; its hint follows');
 actions().props.onDiscard();render();
 check([mfaSwitch().props.checked,select().props.value,actions().props.dirty],[true,15,false],'Discard resets both');
 select().props.onChange({target:{value:'30'}});mfaSwitch().props.onChange(false);render();
 await submit();
 check([stepUp().props.open,posts()],[true,[]],'Save asks for MFA first');
 stepUp().props.onClose();await settle();
 check([posts(),select().props.value,mfaSwitch().props.checked],[[],30,false],'cancel sends nothing and keeps the draft');
 let release;post=body=>new Promise(resolve=>{release=()=>resolve(view(body.idleTimeoutMinutes,body.idleRequiresMfa));});
 await submit();stepUp().props.onVerified({managementToken:'proof'});await settle();
 check([posts(),actions().props.loading,actions().props.busy],[[{action:'set',idleTimeoutMinutes:30,idleRequiresMfa:false,managementToken:'proof'}],true,true],'one set request with both values and one proof; Save shows loading');
 release();await settle();
 check([toasts(),actions().props.dirty,select().props.value],[[de('sessionSettings.savedAll')],false,30],'the toast, and the answer is the new start');
 // A failure keeps the draft.
 post=async()=>{throw new ApiError('Die Einstellung wurde inzwischen geändert.',409);};
 select().props.onChange({target:{value:'5'}});render();await submit();stepUp().props.onVerified({managementToken:'proof-2'});await settle();
 check([toasts(),select().props.value,actions().props.dirty],[['error:Die Einstellung wurde inzwischen geändert.'],5,true],'a failure: a toast, the draft stays');
 // An MFA prompt from the server resends once with the new proof.
 let attempt=0;post=async body=>{if(++attempt===1)throw new ApiError('Bestätige erneut.',403,'MFA_STEP_UP_REQUIRED');return view(body.idleTimeoutMinutes,body.idleRequiresMfa);};
 await submit();stepUp().props.onVerified({managementToken:'a'});await settle();
 check(stepUp().props.open,true,'MFA_STEP_UP_REQUIRED opens the dialog again');
 stepUp().props.onVerified({managementToken:'b'});await settle();
 check([posts().slice(-2).map(body=>body.managementToken),toasts()],[['a','b'],[de('sessionSettings.savedAll')]],'resent once with the new proof');
 // A console refresh keeps a changed draft and loads again.
 select().props.onChange({target:{value:'45'}});render();
 get=async()=>view(5,false);frame={...frame,refresh:1};render();await settle();
 check([calls.filter(call=>!call.body).length,select().props.value,page().props.loading],[2,45,false],'refresh: one GET, the draft stays, no Skeleton');
}

// Demo mode blocks nothing; the panel has no demo prop and the demo hint is gone.
{
 const text=fs.readFileSync('ui/settings/session-settings-panel.tsx','utf8');
 ok(!/demo[:,}=?]|sessionSettingsDemoHint|demoHint/.test(text),'no demo flag and no demo hint');
 ok(!/@\/components\/ui\/|ErrorNote|skeleton-bar|<select\b|role="switch"|opensMfaPrompt|pending\.current|RefreshCw/.test(text),'kit only, no own MFA logic, no refresh button');
 ok(!fs.existsSync('app/session-settings-panel.css'),'the classic stylesheet is deleted');
 check([de('sessionSettings.card'),de('sessionSettings.savedAll')],['Sitzungsregeln','Sitzungseinstellungen gespeichert.']);
}

// The page, the capability rule (the instance settings rule) and the console.
await import('../../support/register.mjs');
const navModel=await import('../../../ui/shell/nav-model.ts');
const settingsIds=navModel.navigatorPages('settings',{viewer:{permissions:['*']}}).map(node=>node.section);
const route=loadModule('lib/console-route.ts');
assert.equal(de(navModel.navNode('settings.sessions').label),'Sitzungen','the page is called Sitzungen');
assert.deepEqual(route.parseConsoleRoute('#settings/sessions'),{view:'settings',page:'sessions'},'#settings/sessions opens it');assert.deepEqual(route.parseConsoleRoute('#administration/settings'),{view:'settings',page:'sessions'},'and the old link');
assert.equal(route.consoleRouteHash({view:'settings',page:'sessions'}),'#settings/sessions');checks+=3;
const capabilities=loadModule('ui/base/access-capabilities.ts');
assert.equal(capabilities.canOpenAccessSection({permissions:['*']},'sessions'),true,'a global Owner sees it');
assert.equal(capabilities.canOpenAccessSection({permissions:['portal.users.manage','portal.userGroups.manage','portal.roles.manage','portal.roleAssignments.manage']},'sessions'),false,'a User Access Administrator does not');
for(const viewer of [{},{permissions:['portal.users.manage']},{permissions:['*']},{permissions:[]}])assert.equal(capabilities.canOpenAccessSection(viewer,'sessions'),capabilities.canManageInstanceSettings(viewer),'the instance settings rule for '+JSON.stringify(viewer));
assert.match(fs.readFileSync('ui/base/access-capabilities.ts','utf8'),/section==='usage-data'\|\|section==='branding'\|\|section==='sessions'\|\|section==='retention'\?canManageInstanceSettings\(viewer\)/,'it delegates to canManageInstanceSettings');checks+=7;
assert.equal(settingsIds.indexOf('sessions'),settingsIds.indexOf('entra')+1,'Sessions ends the group Accounts & access, after Microsoft Entra ID');assert.equal(navPage(navModel,'usage-data').label,'Nutzungsdaten');
assert.deepEqual(navPage(navModel,'sessions'),{id:'sessions',label:'Sitzungen',description:'Lege fest, wann Nodiverna inaktive Konten abmeldet und wann es erneut nach MFA fragt.',icon:'ShieldCheck',group:'Konten & Zugriff'},'texts are message keys, read in German');
assert.equal(navModel.navNode('settings.sessions').palette.keywordsKey,'sessionSettings.paletteKeywords');assert.deepEqual([navModel.navNode('settings.sessions').palette.hint,navModel.navNode('settings.sessions').palette.icon],[['palette.hint.settings'],undefined],'the palette uses the page icon');assert.equal(de('palette.hint.settings'),'Einstellungen');
assert.match(fs.readFileSync('ui/settings/access-workspace.tsx','utf8'),/case 'sessions':return <SessionSettingsPanel viewer=\{viewer\} frame=\{frame\}\/>;/,'the workspace renders the panel with the page frame');
for(const [file,source] of [['ui/base/access-capabilities.ts',fs.readFileSync('ui/base/access-capabilities.ts','utf8')],['ui/settings/session-settings-panel.tsx',fs.readFileSync('ui/settings/session-settings-panel.tsx','utf8')]])assert.doesNotMatch(source,/role==='admin'.*settings|settings.*role==='admin'/,file+': no new role comparison');
{const shortcuts=fs.readFileSync('ui/shell/console-shortcuts.ts','utf8');assert.doesNotMatch(shortcuts,/settings|Sicherheit/i,'no new shortcut');assert.deepEqual(navModel.navNodes.filter(node=>node.shortcut?.label==='shortcuts.administration').map(node=>[node.id,node.shortcut.keys]),[['settings','G S']],'only G S names the settings');assert.equal(de('shortcuts.administration'),'Einstellungen');}checks+=7;

// The help topic.
const help=loadModule('ui/shell/help-panel.tsx',{...i18nStubs,'@/ui/kit/kit':{Drawer:'Drawer',Kbd:'Kbd'},'@/ui/base/docs-base':loadModule('ui/base/docs-base.ts',{}),'@/ui/shell/console-shortcuts':{shortcutList:[]},'@/ui/shell/nav-model':navModel,'@/ui/base/health-score':loadModule('ui/base/health-score.ts',{})});
assert.deepEqual(help.topicFor({view:'settings',page:'sessions'}),{title:'Sitzungen',tips:['Nur deine eigenen Eingaben zählen als Aktivität. Daten, die sich im Hintergrund aktualisieren, halten keine Sitzung offen.','Eine kürzere Zeit gilt auch für Konten, die gerade angemeldet sind.','Wird ein Konto abgemeldet, enden auch seine offenen Terminal- und Remote-Desktop-Sitzungen.'],docs:[{label:'Portal-Sitzungen',file:'docs/portal-sessions.md'}]});
assert.equal(help.topicFor({view:'settings',page:'usage-data'}).title,'Nutzungsdaten','the usage data topic');checks+=2;

console.log(`PASS session settings panel (${checks} assertions): one card with one Save, the set request through one step-up, the toast, the kept draft, no demo block, tab, capability, palette, help.`);
