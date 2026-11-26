// Passkey copy that holds for every account, also without an authenticator app, the lower-case
// "passkey" inside English sentences, and the token-based "Empfohlen" badge.
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {postcss,rootTokens,resolveColor,contrast,colorLiterals} from '../../support/theme-colors.mjs';
import {de as deText,translateModule} from '../../support/i18n-stubs.mjs';
const {translate}=translateModule;
const require=createRequire(import.meta.url),root=process.cwd(),cache=new Map();

// Static render with controlled panel state: useState reads overrides by index
// (0 status, 1 loading). The locale module gets the real React, so LocaleProvider
// keeps its own state and does not shift the panel's indexes.
let stateIndex=0,states=new Map();
const staticReact={...React,useState(initial){const index=stateIndex++;return [states.has(index)?states.get(index):typeof initial==='function'?initial():initial,()=>{}];}};
function load(filename){
 const absolute=path.resolve(filename);if(absolute===germanLocalePath)return germanLocale;if(cache.has(absolute))return cache.get(absolute).exports;if(absolute.endsWith('.css'))return {};
 const source=fs.readFileSync(absolute,'utf8'),mod={exports:{}};cache.set(absolute,mod);
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const realReact=absolute.endsWith(path.join('ui','base','locale.tsx'));
 function localRequire(id){if(id==='react')return realReact?React:staticReact;if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),candidate=[base,base+'.ts',base+'.tsx',base+'.js',base+'/index.ts',base+'/index.tsx'].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());if(candidate)return load(candidate);}return require(id);}
 new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
}
const PasskeysPanel=load('ui/account/passkeys-panel.tsx').default,{LocaleProvider}=load('ui/base/locale.tsx');
const {topicFor}=load('ui/shell/help-panel.tsx');

const microsoft={
 de:'Microsoft Authenticator unterstützt Passkeys nur für Microsoft-Entra-Konten, nicht für Nodiverna. Deine Wiederherstellungscodes bleiben als Reserve verfügbar.',
 en:'Microsoft Authenticator supports passkeys only for Microsoft Entra accounts, not for Nodiverna. Your recovery codes stay available as a backup.',
};
const devicesParagraph='Nutze Windows Hello, den Google Passwortmanager oder den iCloud-Schlüsselbund. Für ein Smartphone scannst du den QR-Code im Browserdialog. Beide Geräte brauchen Bluetooth und müssen in der Nähe sein.';
const oldPhrases=['Authenticator-Code durch einen Passkey','ersetzt der Passkey den Authenticator-Code','Authenticator und Wiederherstellungscodes bleiben verfügbar'];
const props={mfaEnabled:true,onConfirmIdentity:()=>{},reloadKey:0};
const statusWith=authenticatorCount=>({available:true,canManage:true,count:1,authenticatorCount,passkeys:[{id:'key',name:'Laptop',device:'local',createdAt:Date.now(),lastUsedAt:null,backedUp:false,deviceType:'singleDevice'}]});
const render=(panelProps,{status,locale}={})=>{
 stateIndex=0;states=new Map(status===undefined?[]:[[0,status],[1,false]]);
 const panel=React.createElement(PasskeysPanel,panelProps);
 return renderToStaticMarkup(locale?React.createElement(LocaleProvider,{locale},panel):panel);
};
// The "Devices and apps" help is a kit Disclosure: no classic <details class="sd-passkey-help"> any more.
const detailsOf=html=>html.match(/<details class="sdx-disclosure sdx-account-help">[\s\S]*?<\/details>/)?.[0];
const summaryOf=html=>detailsOf(html)?.match(/<strong>([^<]*)<\/strong>/)?.[1];
const paragraphsOf=html=>[...(detailsOf(html)?.match(/<div class="sdx-disclosure-body">([\s\S]*?)<\/div>/)?.[1]??'').matchAll(/<p>([^<]*)<\/p>/g)].map(match=>match[1]);
const expectedHelp=lang=>lang==='de'?{summary:'Geräte und Apps',paragraphs:[devicesParagraph,microsoft.de]}:{summary:translate('en','passkeys.help.devices'),paragraphs:[translate('en','passkeys.help.apps'),microsoft.en]};

// The same neutral text for every authenticator count.
const seen=[];
for(const count of [0,1,2,undefined]){
 const html=render(props,{status:statusWith(count)}),label=`authenticatorCount ${count}`;
 assert.deepEqual({summary:summaryOf(html),paragraphs:paragraphsOf(html)},expectedHelp('de'),`${label}: the help Disclosure keeps its summary, its first paragraph and the Microsoft note`);
 assert.ok(!html.includes('sd-passkey-help')&&!html.includes('v3-help'),`${label}: no classic help markup`);
 for(const phrase of oldPhrases)assert.ok(!html.includes(phrase),`${label}: "${phrase}" is gone`);
 assert.doesNotMatch(detailsOf(html),/Authenticator-Code|deine[nm]? Authenticator|Authenticator und/,`${label}: the details do not imply an authenticator app`);
 seen.push(detailsOf(html));
}
assert.equal(new Set(seen).size,1,'the texts do not depend on authenticatorCount');
// Without MFA "Add passkey" stays visible and says why it waits (kit blocked).
{const html=render({...props,mfaEnabled:false},{status:statusWith(0)}),add=html.match(/<button[^>]*aria-disabled="true"[^>]*>(?:(?!<\/button>)[\s\S])*Passkey hinzufügen[\s\S]*?<\/button>/)?.[0];
 assert.ok(add,'Add passkey is a blocked kit Btn');assert.ok(!/\sdisabled=""/.test(add),'no native disabled');
 assert.ok(add.includes('Richte zuerst eine Authenticator-App ein. Auch nachdem du einen Passkey hinzugefügt hast, kannst du dich mit der App und deinen Wiederherstellungscodes anmelden.'),'the reason without MFA is unchanged');}
// The last-passkey note still depends on authenticatorCount>0 and sits in the removal ConfirmDialog.
const panelSource=fs.readFileSync('ui/account/passkeys-panel.tsx','utf8');
assert.ok(panelSource.includes("{removing&&status?.count===1&&(status.authenticatorCount??1)>0&&<p className=\"sdx-account-note\">{t('passkeys.lastPasskey')}</p>}")&&deText('passkeys.lastPasskey')==='Dies ist dein letzter Passkey. Du kannst dich weiter mit deiner Authenticator-App und deinen Wiederherstellungscodes anmelden.','the last-passkey note is unchanged');

// The strings come from the catalogs; en inside a LocaleProvider, de without one.
for(const [locale,lang] of [[undefined,'de'],['de','de'],['en','en']]){
 const html=render(props,{locale}),label=locale?`LocaleProvider ${locale}`:'no LocaleProvider';
 assert.deepEqual({summary:summaryOf(html),paragraphs:paragraphsOf(html)},expectedHelp(lang),`${label}: the help block in the page language`);
}
for(const file of ['lib/i18n/messages/en.ts','lib/i18n/messages/de.ts']){
 const catalog=fs.readFileSync(file,'utf8');
 assert.ok(catalog.includes("'passkeys.help.microsoft':"),`${file} has passkeys.help.microsoft`);
 assert.ok(!catalog.includes("'passkeys.help.intro':"),`${file}: the intro of the removed classic panel is gone`);
}
assert.doesNotMatch(panelSource,new RegExp(microsoft.de),'the panel reads the texts from the catalog');

// The account help tips: passkey in lower case, the Preferences card and the account menu.
const tips={
 de:['Mit einem Passkey meldest du dich ohne Code an. Füge einen zweiten Passkey oder eine Authenticator-App als Reserve hinzu.','Jeder Wiederherstellungscode funktioniert einmal. Bewahre die Codes getrennt von deinem Passwort auf.','Darstellung, Farbschema, Sprache und Startseite legst du auf dieser Seite unter „Einstellungen der Oberfläche“ fest.','Darstellung und Sprache findest du auch im Kontomenü oben rechts.'],
 en:['With a passkey, you sign in without a code. Add a second passkey or an authenticator app as a backup.','Each recovery code works once. Keep the codes separate from your password.','You set the appearance, color scheme, language and start page under “Preferences” on this page.','Appearance and language are also in your account menu at the top right.'],
};
for(const lang of ['de','en'])assert.deepEqual(topicFor({view:'account'},lang).tips,tips[lang],`${lang}: the account tips`);

// English writes "passkey" in lower case inside a sentence: "Passkey" only at the start of a
// sentence, a title or a label. German keeps the noun "Passkey".
const en=load('lib/i18n/messages/en.ts').default,enServer=load('lib/i18n/messages/en-server.ts').default;
const families=['identity.','session.','account.','passkeys.','password.','mfa.','apiError.auth.','apiError.mfa.','apiError.passkey.','apiError.password.','help.account.'];
const capitalised=[];
for(const catalog of [en,enServer])for(const [key,message] of Object.entries(catalog)){
 if(!families.some(prefix=>key.startsWith(prefix)))continue;
 for(const value of typeof message==='string'?[message]:Object.values(message))for(const match of value.matchAll(/Passkeys?\b/g)){
  const before=value.slice(0,match.index);
  if(before.trim()===''||/[.!?:]\s+$/.test(before)||/[“"‘(]$/.test(before))continue;
  capitalised.push(`${key}: ${value}`);
 }
}
assert.deepEqual(capitalised,[],'no capitalised "Passkey" inside an English sentence');
for(const [key,expected] of Object.entries({'passkeys.add':'Add passkey','passkeys.empty':'No passkey stored yet.'}))assert.equal(en[key],expected,key);
assert.equal(translate('en','passkeys.count',{count:2}),'2 passkeys','the plural count is lower case');
assert.ok(en['passkeys.lastFactor'].endsWith('.'),'passkeys.lastFactor ends with a period');
assert.match(deText('passkeys.add'),/Passkey/,'German keeps the noun Passkey');

// Badge rules use tokens only and never break inside the word.
const rulesOf=(file,selector)=>{const found=[];postcss.parse(fs.readFileSync(file,'utf8')).walkRules(rule=>{if(rule.parent.type==='root'&&rule.selector.trim()===selector)found.push(rule);});return found;};
const declsOf=rules=>new Map(rules.flatMap(rule=>rule.nodes.filter(node=>node.type==='decl').map(decl=>[decl.prop,decl.value.trim()])));
for(const [file,selector] of [['ui/account/passkeys.css','.sd-passkey-badge']]){
 const rules=rulesOf(file,selector),decls=declsOf(rules);
 assert.ok(rules.length>0,`${file}: ${selector} exists`);
 assert.equal(decls.get('background'),'var(--sd-accent-soft)',`${selector}: background token`);
 assert.equal(decls.get('color'),'var(--sd-accent-strong)',`${selector}: text token`);
 assert.equal(decls.get('border-radius'),'var(--sd-radius-sm)',`${selector}: radius token`);
 assert.equal(decls.get('white-space'),'nowrap',`${selector}: never breaks inside the word`);
 for(const rule of rules){
  assert.deepEqual(colorLiterals(rule.toString()),[],`${selector}: no color literal`);
  assert.doesNotMatch(rule.toString(),/#fff|#0b1220|border-radius:\s*\d/,`${selector}: no fixed mix partner or radius`);
 }
}
const passkeyBadge=declsOf(rulesOf('ui/account/passkeys.css','.sd-passkey-badge'));
assert.deepEqual([passkeyBadge.get('font-size'),passkeyBadge.get('font-weight'),passkeyBadge.get('padding')],['10px','550','1px 6px'],'font size, weight and padding stay');
assert.equal(declsOf(rulesOf('ui/account/passkeys.css','.sd-passkey-signin-heading')).get('flex-wrap'),'wrap','the badge moves to a new line when the heading is too narrow');
// Readable in both modes; in dark mode a dark surface with light text.
const globals=fs.readFileSync('app/globals.css','utf8');
const raw=rootTokens(globals);
const luminance=({r,g,b})=>[r,g,b].map(value=>{const c=value/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((sum,c,index)=>sum+c*[.2126,.7152,.0722][index],0);
const lightPanel=resolveColor('var(--sd-panel)',raw,'light');
for(const mode of ['light','dark']){
 const background=resolveColor('var(--sd-accent-soft)',raw,mode),text=resolveColor('var(--sd-accent-strong)',raw,mode);
 assert.ok(contrast(text,background)>=4.5,`${mode}: badge contrast ${contrast(text,background).toFixed(2)}:1`);
 if(mode==='dark'){
  assert.ok(luminance(background)<luminance(text),'dark: the surface is darker than the text');
  assert.ok(luminance(background)<luminance(lightPanel)/4,'dark: no light chip on the dark card');
 }
}
console.log('passkey texts and badge: ok');
